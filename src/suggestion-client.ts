import type { EngineMode, ServerMessage } from './protocol.ts';
import type { Candidate } from './protocol.ts';

/** Keep matching and parsing off the terminal's rendering/input thread. */
export class SuggestionClient {
  private base: string;
  private session: string;
  private authorization: () => string | undefined;
  constructor(base = document.baseURI, session = 'default', authorization: () => string | undefined = () => undefined) { this.base = base; this.session = session; this.authorization = authorization; }
  private endpoint(name: string) { const url = new URL(name, this.base); if (this.session !== 'default') url.searchParams.set('session', this.session); return url.href; }
  private mode: EngineMode = 'server';
  setMode(mode: EngineMode) {
    if (mode !== this.mode) {
      this.disconnect(); this.mode = mode;
      if (mode === 'server') { this.worker?.terminate(); this.worker = undefined; }
    }
  }
  private worker?: Worker;
  private next = 0;
  private prompt = -1;
  onState(prompt: number) { this.prompt = prompt; }
  updateContext(message: Extract<ServerMessage, { type: 'context' }>) {
    // Coarse repairs obtain authoritative context on the backend.
    void message;
  }
  disconnect() {
    for (const request of this.pending.values()) request.reject(new Error('Connection changed.'));
    this.worker?.postMessage({ reset: true });
  }
  private pending = new Map<number, { resolve(value: { candidates: Candidate[] }): void; reject(error: unknown): void }>();
  private openWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./suggestion-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id);
        if (data.error) request?.reject(new Error(data.error)); else request?.resolve({ candidates: data.candidates });
      };
      this.worker.onerror = event => {
        for (const request of this.pending.values()) request.reject(new Error(event.message || 'Repair worker unavailable.'));
        this.worker?.terminate(); this.worker = undefined;
      };
    }
  }
  private async nativeSuggest(text: string, signal: AbortSignal): Promise<{ candidates: Candidate[] }> {
    const response = await fetch(this.endpoint('api/suggest'), { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(this.authorization() ? { Authorization: 'Bearer ' + this.authorization() } : {}) }, body: JSON.stringify({ text }), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Suggestions unavailable.');
    return result;
  }
  suggest(text: string, signal: AbortSignal): Promise<{ candidates: Candidate[] }> {
    signal.throwIfAborted();
    if (this.mode === 'server') return this.nativeSuggest(text, signal);
    this.openWorker();
    const worker = this.worker!, id = ++this.next;
    return new Promise<{ candidates: Candidate[] }>((resolve, reject) => {
      const cancel = () => { worker.postMessage({ id, cancel: true }); this.pending.get(id)?.reject(signal.reason); };
      const finish = () => { signal.removeEventListener('abort', cancel); this.pending.delete(id); };
      this.pending.set(id, {
        resolve: result => { finish(); resolve(result); },
        reject: error => { finish(); reject(error); },
      });
      signal.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ id, text, prompt: this.prompt, endpoint: this.endpoint('api/facts'), authorization: this.authorization() });
    });
  }
}
