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
  take(context: InputContext): string[] | undefined {
    const data = this.context && sameInputContext(this.context, context) ? this.data : undefined;
    this.clear(); return data;
  }
  clear() { this.context = undefined; this.data = []; this.bytes = 0; }
}
