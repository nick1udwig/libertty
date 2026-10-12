interface ReconnectingSocketOptions {
  prepare(signal: AbortSignal, token?: string): Promise<URL>;
  available(): boolean;
  open(): void;
  message(event: MessageEvent): void;
  close(event?: CloseEvent): boolean;
  error(error: unknown, token?: string): boolean;
}

/** Own one connection attempt, including authorization and the initial state. */
export class ReconnectingSocket {
  socket?: WebSocket;
  private attempt?: AbortController;
  private deadline?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  private stopped = false;
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
  }

  ready() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    clearTimeout(this.deadline);
    this.attempt = undefined;
    this.delay = 1000;
  }

  private release(event?: CloseEvent) {
    const socket = this.socket;
    this.socket = undefined;
    const attempt = this.attempt;
    this.attempt = undefined;
    clearTimeout(this.deadline);
    attempt?.abort();
    // Detach before closing: a delayed close must not affect its replacement.
    socket?.close();
    if (socket && !this.options.close(event)) this.stopped = true;
  }

  private schedule() {
    clearTimeout(this.retry);
    if (this.stopped || !this.options.available()) return;
    this.retry = setTimeout(() => void this.begin(), this.delay);
    this.delay = Math.min(10000, this.delay * 1.5);
  }

  private async begin(token?: string, replace = false) {
    if (!this.options.available()) return;
    if (!replace && (this.attempt || this.socket?.readyState === WebSocket.OPEN)) return;
    clearTimeout(this.retry);
    this.release();
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
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => { if (this.socket === socket) this.options.open(); };
      socket.onmessage = event => { if (this.socket === socket) this.options.message(event); };
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
