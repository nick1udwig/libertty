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
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState !== 1) throw new win.DOMException('The socket is not open.', 'InvalidStateError');
      const message = typeof data === 'string' ? data : data instanceof Blob ? undefined : envelope(data);
      if (message) queueMicrotask(() => { if (this.readyState === 1) this.connection?.message(message); });
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

const decoder = new TextDecoder();
/** Read the binary envelopes from src/wire.ts back into the JSON messages the demo backend handles. */
function envelope(data: ArrayBufferLike | ArrayBufferView): string | undefined {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  if (bytes.length < 4 || bytes[0] !== 84 || bytes[1] !== 77 || bytes[2] !== 1) return;
  const payload = bytes.subarray(4), view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  switch (bytes[3]) {
    case 3: return JSON.stringify({ type: 'input', data: decoder.decode(payload) });
    case 4: return JSON.stringify({ type: 'ack', seq: view.getFloat64(0, true) });
    case 5: return JSON.stringify({ type: 'resize', cols: view.getUint16(0, true), rows: view.getUint16(2, true), ...(payload[4] < 2 ? { mobile: payload[4] === 1 } : {}) });
    case 8: return JSON.stringify({ type: 'input', seq: view.getFloat64(0, true), data: decoder.decode(payload.subarray(8)) });
    // Dictation audio is transcribed from the microphone stream instead, by Whisper in the workspace.
    default: return;
  }
}
