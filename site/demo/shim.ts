import type { DemoServer } from './server.ts';

/** Route this document's backend fetches and WebSockets to the demo server, which may live in a parent frame. */
export function install(win: Window & typeof globalThis, server: DemoServer) {
  const original = win.fetch.bind(win);
  const backend = (url: URL) => url.origin === win.location.origin && url.pathname.includes('/api/');
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new win.Request(input, init), url = new URL(request.url);
    if (!backend(url)) return original(input, init);
    request.signal.throwIfAborted();
    const json = request.headers.get('Content-Type')?.includes('json');
    const body = ['GET', 'HEAD', 'DELETE'].includes(request.method) ? undefined : json ? await request.text() : new Uint8Array(await request.arrayBuffer());
    const reply = await server.request(request.method, url.href, body);
    request.signal.throwIfAborted();
    return new win.Response(reply.body as BodyInit, { status: reply.status, headers: reply.type ? { 'Content-Type': reply.type } : {} });
  };

  class DemoSocket extends win.EventTarget {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
    readonly url: string; readonly protocol = ''; readonly extensions = ''; readonly bufferedAmount = 0;
    binaryType: BinaryType = 'blob'; readyState = 0;
    onopen: ((event: Event) => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null; onerror: ((event: Event) => void) | null = null;
    private connection?: ReturnType<DemoServer['connect']>;
    constructor(url: string | URL) {
      super(); this.url = String(url);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.dispatch(new win.Event('open'));
        this.connection = server.connect(this.url, {
          send: message => { const data = JSON.stringify(message); queueMicrotask(() => { if (this.readyState === 1) this.dispatch(new win.MessageEvent('message', { data })); }); },
          close: (code = 1000, reason = '') => queueMicrotask(() => this.finish(code, reason)),
        });
      }, 0);
    }
    // Binary frames carry dictation audio, which the browser's own speech recognition replaces here.
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState !== 1) throw new win.DOMException('The socket is not open.', 'InvalidStateError');
      if (typeof data === 'string') queueMicrotask(() => { if (this.readyState === 1) this.connection?.message(data); });
    }
    close(code = 1000, reason = '') { if (this.readyState < 2) { this.readyState = 2; queueMicrotask(() => this.finish(code, reason)); } }
    private finish(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3; this.connection?.close();
      this.dispatch(new win.CloseEvent('close', { code, reason, wasClean: true }));
    }
    private dispatch(event: Event) {
      this.dispatchEvent(event);
      (this as unknown as Record<string, ((event: Event) => void) | null>)['on' + event.type]?.call(this, event);
    }
  }
  win.WebSocket = DemoSocket as unknown as typeof WebSocket;
}
