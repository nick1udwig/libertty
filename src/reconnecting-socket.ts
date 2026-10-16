import { decodeWire } from './wire.ts';
const minimumReply = 2000, maximumReply = 8000, activeDownlink = 1000;
interface ReconnectingSocketOptions {
  prepare(signal: AbortSignal, token?: string): Promise<URL>;
  available(): boolean;
  protocols?(): string[];
  heartbeat?(): boolean;
  open(): void;
  message(event: MessageEvent): void;
  close(event?: CloseEvent): boolean;
  error(error: unknown, token?: string): boolean;
  stalled?(seconds: number): void;
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
  private deadline?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  private stopped = false;
  private retained?: WebSocket;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private lastContact = 0;
  private established?: WebSocket;
  private pingAt?: number;
  private lastMessage = 0;
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
    if (!this.attempt && (this.stalled || this.socket?.readyState !== WebSocket.OPEN)) void this.resume(this.stalled);
  }

  get healthy() { return !this.stalled && this.socket?.readyState === WebSocket.OPEN; }
  /** The page has stayed hidden past its background grace. */
  get backgroundExpired() { return this.expired; }

  /** Suspend after the background grace and resume when the page is shown, restored or back online; the result stops following. */
  follow(background: BackgroundOptions) {
    const visibility = () => {
      clearTimeout(this.background);
      if (document.hidden) {
        this.expired = false; background.hidden?.();
        this.background = setTimeout(() => { this.expired = true; if (background.expired?.() !== false) this.suspend(); }, background.grace);
      } else { this.expired = false; void this.resume(!this.healthy); background.shown?.(); }
    };
    // Every load fires pageshow, but only a page restored from the back-forward cache needs a fresh connection.
    const restored = (event: PageTransitionEvent) => { if (event.persisted) visibility(); };
    const online = () => void this.resume(true), offline = () => this.suspend();
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
    clearTimeout(this.heartbeat);
    if (this.options.heartbeat?.() !== false) this.heartbeat = setTimeout(() => this.checkHeartbeat(), 2000);
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
  }

  private checkHeartbeat() {
    if (this.stopped) return;
    if (this.pingAt !== undefined && Date.now() - this.pingAt >= this.replyDeadline()) {
      if (!this.stalled) {
        this.stalled = true;
        void this.begin(undefined, true);
      }
      this.options.stalled?.(Math.floor((Date.now() - this.lastContact) / 1000));
    } else if (this.socket?.readyState === WebSocket.OPEN && this.pingAt === undefined && Date.now() - this.lastContact >= 2000) {
      this.pingAt = Date.now();
      this.socket.send(JSON.stringify({ type: 'ping' }));
    }
    this.heartbeat = setTimeout(() => this.checkHeartbeat(), 1000);
  }

  private release(event?: CloseEvent, retain = false) {
    const socket = this.socket;
    this.socket = undefined;
    this.established = undefined;
    const attempt = this.attempt;
    this.attempt = undefined;
    clearTimeout(this.deadline);
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
    this.retry = setTimeout(() => void this.begin(), this.delay);
    this.delay = Math.min(10000, this.delay * 1.5);
  }

  private async begin(token?: string, replace = false) {
    if (!this.options.available()) return;
    if (!replace && (this.attempt || this.socket?.readyState === WebSocket.OPEN)) return;
    clearTimeout(this.retry);
    this.release(undefined, replace);
    if (this.stopped) return;
    const attempt = new AbortController();
    this.attempt = attempt;
    // Covers stalled fetches, WebSocket handshakes, and missing initial state.
    this.deadline = setTimeout(() => {
      if (this.attempt !== attempt) return;
      this.release();
      if (!this.options.error(new Error('Terminal connection timed out.'), token)) this.stopped = true;
      this.schedule();
    }, 15000);
    try {
      const url = await this.options.prepare(attempt.signal, token);
      if (this.attempt !== attempt) return;
      if (!this.options.available()) { this.release(); return; }
      const socket = new WebSocket(url, this.options.protocols?.() || []);
      socket.binaryType = 'arraybuffer';
      let decoded = Promise.resolve();
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.retained?.close(); this.retained = undefined;
        this.options.open();
      };
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        const deliver = (value: unknown) => {
          if (this.socket !== socket) return;
          if (value === '{"type":"pong"}' || typeof value === 'object' && value !== null && 'type' in value && value.type === 'pong') {
            if (this.pingAt !== undefined) this.replied();
            return;
          }
          this.lastMessage = Date.now();
          this.options.message(new MessageEvent('message', { data: value }));
        };
        if (!socket.protocol?.startsWith('termai.')) { deliver(event.data); return; }
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
