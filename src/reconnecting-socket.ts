import { decodeWire } from './wire.ts';
const minimumReply = 2000, maximumReply = 8000, activeDownlink = 1000;
const activeHeartbeat = 2000, idleHeartbeat = 25000, activityWindow = 10000;
/** A clock time stays the same through a stall, so the label does not change every second. */
export const stalledLabel = (lastContact: number) => 'Connection stalled · last contact ' + new Date(lastContact).toLocaleTimeString();
interface ReconnectingSocketOptions {
  prepare(signal: AbortSignal, token?: string): Promise<URL>;
  available(): boolean;
  protocols?(): string[];
  open(): void;
  message(event: MessageEvent): void;
  close(event?: CloseEvent): boolean;
  error(error: unknown, token?: string): boolean;
  /** Called on each heartbeat check while replies are missing, with the time of the last contact. */
  stalled?(lastContact: number): void;
  probe?(): void;
  checkpoint?(): boolean;
}
/** How a connection follows the page into and out of the background. */
export interface BackgroundOptions {
  /** How long a hidden page keeps its connection. */
  grace: number;
  hidden?(): void;
  /** The grace expired; returning false keeps the connection, for example while dictating. */
  expired?(): boolean | void;
  shown?(): void;
}

/** Own one connection attempt, including authorization and the initial state. */
export class ReconnectingSocket {
  socket?: WebSocket;
  private attempt?: AbortController;
  private attemptStarted = 0;
  private deadline?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  private offlineUntil = 0;
  private decodeLag = 0;
  private stopped = false;
  private retained?: WebSocket;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private heartbeatAt = 0;
  private lastContact = 0;
  private established?: WebSocket;
  private pingAt?: number;
  private lastMessage = 0;
  private lastActivity = -Infinity;
  private rtt?: { smoothed: number; variance: number };
  private stalled = false;
  private background?: ReturnType<typeof setTimeout>;
  private expired = false;
  private options: ReconnectingSocketOptions;

  constructor(options: ReconnectingSocketOptions) { this.options = options; }

  /** Explicit authorization may resume a locked or replaced terminal. */
  connect(token?: string, replace = false): Promise<void> {
    this.stopped = false;
    return this.begin(token, replace);
  }

  /** Visibility/network events must not bypass a terminal's final status. */
  resume(replace = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.begin(undefined, replace);
  }

  suspend() {
    clearTimeout(this.retry);
    this.release();
    this.retained?.close(); this.retained = undefined;
    clearTimeout(this.heartbeat);
    this.stalled = false;
  }

  /** User activity bypasses retry backoff without competing with a handshake. */
  activity() {
    this.lastActivity = Date.now();
    if (!this.attempt && (this.stalled || this.socket?.readyState !== WebSocket.OPEN)) void this.resume(this.stalled);
    else this.armHeartbeat();
  }

  /** Acknowledged input proves that the return path worked without an extra probe. */
  confirmed() { if (this.pingAt === undefined) { this.lastContact = Date.now(); this.armHeartbeat(); } }

  /** Defer optional work when measured latency or browser queues grow. */
  get backgroundDelay() {
    return Math.min(10000, Math.max(1500, (this.rtt?.smoothed || 0) * 4, this.decodeLag * 4, (this.socket?.bufferedAmount || 0) > 16384 ? 5000 : 0));
  }
  get healthy() { return !this.stalled && this.established === this.socket && this.socket?.readyState === WebSocket.OPEN; }
  /** Browser timers may have stopped while the app was hidden, even with an open socket. */
  foreground() {
    if (this.stopped) return;
    this.offlineUntil = 0; this.delay = 1000; this.lastActivity = Date.now();
    if (this.healthy) this.checkHeartbeat();
    else if (!this.attempt || Date.now() - this.attemptStarted >= 1000) void this.resume(true);
  }
  /** The page has stayed hidden past its background grace. */
  get backgroundExpired() { return this.expired; }

  /** Suspend after the background grace and resume when the page is shown, restored or back online; the result stops following. */
  follow(background: BackgroundOptions) {
    const visibility = () => {
      clearTimeout(this.background);
      if (document.hidden) {
        this.expired = false; background.hidden?.();
        this.background = setTimeout(() => { this.expired = true; if (background.expired?.() !== false) this.suspend(); }, background.grace);
      } else { this.expired = false; this.foreground(); background.shown?.(); }
    };
    // Every load fires pageshow, but only a page restored from the back-forward cache needs a fresh connection.
    const restored = (event: PageTransitionEvent) => { if (event.persisted) visibility(); };
    const online = () => { this.offlineUntil = 0; this.delay = 1000; this.lastActivity = Date.now(); void this.resume(true); };
    const offline = () => { this.suspend(); this.offlineUntil = Date.now() + 10000; this.schedule(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pageshow', restored);
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    return () => {
      clearTimeout(this.background);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', restored);
      window.removeEventListener('online', online); window.removeEventListener('offline', offline);
    };
  }

  ready() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.established === this.socket) return;
    this.established = this.socket;
    clearTimeout(this.deadline);
    this.attempt = undefined;
    this.delay = 1000;
    this.lastContact = Date.now(); this.pingAt = undefined; this.stalled = false;
    this.armHeartbeat();
  }

  private heartbeatInterval() {
    return Date.now() - Math.max(this.lastActivity, this.lastMessage) < activityWindow ? activeHeartbeat : idleHeartbeat;
  }

  private armHeartbeat() {
    if (this.stopped || this.established !== this.socket || this.socket?.readyState !== WebSocket.OPEN) {
      clearTimeout(this.heartbeat); this.heartbeat = undefined; return;
    }
    const wait = this.pingAt === undefined ? this.lastContact + this.heartbeatInterval() - Date.now()
      : Math.min(1000, this.pingAt + this.replyDeadline() - Date.now());
    const at = Date.now() + Math.max(1, wait);
    if (this.heartbeat && (at === this.heartbeatAt || this.pingAt !== undefined && at >= this.heartbeatAt)) return;
    clearTimeout(this.heartbeat); this.heartbeatAt = at;
    this.heartbeat = setTimeout(() => { this.heartbeat = undefined; this.checkHeartbeat(); }, Math.max(1, wait));
  }

  /** Allow a reply the link's measured round trip, and the full maximum while output still arrives ahead of it. */
  private replyDeadline() {
    if (Date.now() - this.lastMessage < activeDownlink) return maximumReply;
    const measured = this.rtt ? this.rtt.smoothed + 4 * this.rtt.variance : 0;
    return Math.min(maximumReply, Math.max(minimumReply, measured));
  }

  private replied() {
    const sample = Date.now() - this.pingAt!;
    // Smooth round trips like TCP retransmission timers so one spike does not set the deadline.
    if (!this.rtt) this.rtt = { smoothed: sample, variance: sample / 2 };
    else {
      this.rtt.variance = 0.75 * this.rtt.variance + 0.25 * Math.abs(this.rtt.smoothed - sample);
      this.rtt.smoothed = 0.875 * this.rtt.smoothed + 0.125 * sample;
    }
    this.lastContact = Date.now(); this.pingAt = undefined;
    this.armHeartbeat();
  }

  private checkHeartbeat() {
    if (this.stopped) return;
    if (this.pingAt !== undefined && Date.now() - this.pingAt >= this.replyDeadline()) {
      if (!this.stalled) {
        this.stalled = true;
        void this.begin(undefined, true);
      }
      this.options.stalled?.(this.lastContact);
    } else if (this.socket?.readyState === WebSocket.OPEN && this.pingAt === undefined && Date.now() - this.lastContact >= this.heartbeatInterval()) {
      this.pingAt = Date.now();
      this.socket.send(JSON.stringify({ type: 'ping', ...(this.options.checkpoint?.() ? { checkpoint: true } : {}) }));
      this.options.probe?.();
    }
    this.armHeartbeat();
  }

  private release(event?: CloseEvent, retain = false) {
    const socket = this.socket;
    this.socket = undefined;
    this.established = undefined;
    const attempt = this.attempt;
    this.attempt = undefined;
    clearTimeout(this.deadline);
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    attempt?.abort();
    // Detach before closing: a delayed close must not affect its replacement.
    if (retain && socket?.readyState === WebSocket.OPEN) {
      this.retained?.close(); this.retained = socket;
    } else socket?.close();
    if (socket && !this.options.close(event)) this.stopped = true;
  }

  private schedule() {
    clearTimeout(this.retry);
    if (this.stopped) {
      this.retained?.close(); this.retained = undefined;
      clearTimeout(this.heartbeat);
      return;
    }
    if (!this.options.available()) return;
    this.retry = setTimeout(() => void this.begin(), Math.max(this.delay, this.offlineUntil - Date.now()));
    this.delay = Math.min(10000, this.delay * 1.5);
  }

  private async begin(token?: string, replace = false) {
    if (!this.options.available()) return;
    if (Date.now() < this.offlineUntil) { this.schedule(); return; }
    if (!replace && (this.attempt || this.socket?.readyState === WebSocket.OPEN)) return;
    clearTimeout(this.retry);
    this.release(undefined, replace);
    if (this.stopped) return;
    const attempt = new AbortController();
    this.attempt = attempt;
    const started = this.attemptStarted = Date.now();
    const progress = (idle = Math.min(15000, Math.max(8000, this.delay * 8, (this.rtt?.smoothed || 0) * 4))) => {
      if (this.attempt !== attempt) return;
      clearTimeout(this.deadline);
      this.deadline = setTimeout(() => {
        if (this.attempt !== attempt) return;
        this.release();
        if (!this.options.error(new Error('Terminal connection timed out.'), token)) this.stopped = true;
        this.schedule();
      }, Math.max(1, Math.min(idle, 45000 - (Date.now() - started))));
    };
    // Authorization has its own budget, followed by an idle deadline for each transport phase.
    progress(15000);
    try {
      const url = await this.options.prepare(attempt.signal, token);
      if (this.attempt !== attempt) return;
      if (!this.options.available()) { this.release(); return; }
      progress();
      const socket = new WebSocket(url, this.options.protocols?.() || []);
      socket.binaryType = 'arraybuffer';
      let decoded = Promise.resolve();
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.retained?.close(); this.retained = undefined;
        progress(); this.options.open();
      };
      socket.onmessage = event => {
        const receivedAt = Date.now();
        if (this.socket !== socket) return;
        const deliver = (value: unknown) => {
          if (this.socket !== socket) return;
          this.decodeLag = this.decodeLag * 0.75 + (Date.now() - receivedAt) * 0.25;
          if (value === '{"type":"pong"}' || typeof value === 'object' && value !== null && 'type' in value && value.type === 'pong') {
            if (this.pingAt !== undefined) this.replied();
            return;
          }
          progress(); this.lastMessage = Date.now();
          this.options.message(new MessageEvent('message', { data: value }));
          this.armHeartbeat();
        };
        if (!socket.protocol?.startsWith('libertty.')) { deliver(event.data); return; }
        decoded = decoded.then(async () => {
          const value = await decodeWire(event.data);
          deliver(value);
        }).catch(error => { if (this.socket === socket) { this.options.error(error, token); socket.close(4002, 'Invalid transport message'); } });
      };
      socket.onclose = event => {
        if (this.socket !== socket) return;
        this.release(event);
        this.schedule();
      };
    } catch (error) {
      if (this.attempt !== attempt) return;
      this.release();
      if (!this.options.error(error, token)) this.stopped = true;
      this.schedule();
    }
  }
}
