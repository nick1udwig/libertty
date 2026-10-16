export interface InputContext {
  session: string;
  connection: number;
  prompt: number;
  revision: number;
  target: 'shell' | 'program';
  stream?: string;
  identity?: string;
  picture?: string;
}
export function sameInputContext(before: InputContext, after: InputContext): boolean {
  if (before.session !== after.session || before.target !== after.target) return false;
  if (before.stream || after.stream) return !!before.stream && before.stream === after.stream && before.prompt === after.prompt && before.revision === after.revision;
  if (before.connection === after.connection) return before.prompt === after.prompt && before.revision === after.revision && before.identity === after.identity;
  return !!before.identity && before.identity === after.identity && (before.target === 'program' || before.picture !== undefined && before.picture === after.picture);
}
/** Hold only input that has never been handed to a WebSocket. */
export class UnsentInput {
  context?: InputContext;
  private data: string[] = [];
  private bytes = 0;
  get length() { return this.data.length; }
  add(data: string, context?: InputContext) {
    if (!context || this.bytes + data.length > 65536) return false;
    this.context ||= context;
    this.data.push(data); this.bytes += data.length;
    return true;
  }
  /** Put keys a dropped connection never delivered ahead of later ones, under the context they were typed in. */
  prepend(data: string[], context?: InputContext) {
    if (!context) return false;
    this.context = context;
    this.data.unshift(...data); this.bytes += data.reduce((bytes, item) => bytes + item.length, 0);
    return true;
  }
  take(context: InputContext): string[] | undefined {
    const data = this.context && sameInputContext(this.context, context) ? this.data : undefined;
    this.clear(); return data;
  }
  clear() { this.context = undefined; this.data = []; this.bytes = 0; }
}
/** Keep numbered keys handed to a WebSocket until a reconnect learns which of them the backend delivered. */
export class SentInput {
  private entries: { seq: number; data: string; context?: InputContext }[] = [];
  private bytes = 0;
  /** The newest key dropped to bound memory, which a reconnect can no longer resend. */
  private evicted = 0;
  add(seq: number, data: string, context?: InputContext) {
    this.entries.push({ seq, data, context }); this.bytes += data.length;
    while (this.bytes > 65536 && this.entries.length > 1) {
      const entry = this.entries.shift()!;
      this.bytes -= entry.data.length; this.evicted = entry.seq;
    }
  }
  /** Return the keys after the backend's last delivered one; a backend that does not know this browser vouches for none. */
  settle(delivered?: number): { data: string[]; context?: InputContext; complete: boolean } | undefined {
    const pending = delivered === undefined ? [] : this.entries.filter(entry => entry.seq > delivered);
    const complete = delivered === undefined || delivered >= this.evicted;
    this.clear();
    if (pending.length) return { data: pending.map(entry => entry.data), context: pending[0].context, complete };
  }
  clear() { this.entries = []; this.bytes = 0; this.evicted = 0; }
}
