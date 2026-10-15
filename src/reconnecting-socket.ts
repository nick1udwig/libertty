import { decodeWire } from './wire.ts';
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
  private pingAt?: number;
  private stalled = false;
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

  ready() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    clearTimeout(this.deadline);
    this.attempt = undefined;
    this.delay = 1000;
    this.lastContact = Date.now(); this.pingAt = undefined; this.stalled = false;
    clearTimeout(this.heartbeat);
    if (this.options.heartbeat?.() !== false) this.heartbeat = setTimeout(() => this.checkHeartbeat(), 2000);
  }

  private checkHeartbeat() {
    if (this.stopped) return;
    if (this.pingAt !== undefined && Date.now() - this.lastContact >= 4000) {
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
        this.lastContact = Date.now(); this.pingAt = undefined;
        const deliver = (value: unknown) => {
          if (this.socket !== socket) return;
          if (value === '{"type":"pong"}' || typeof value === 'object' && value !== null && 'type' in value && value.type === 'pong') return;
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
