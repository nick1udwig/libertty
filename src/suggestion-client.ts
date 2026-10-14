import { requestJSON } from './api.ts';
import type { Candidate } from './protocol.ts';

/** Obtain suggestions from the native engine beside the host facts. */
export class SuggestionClient {
  private connection = new AbortController();
  private base: string;
  private session: string;
  private authorization: () => string | undefined;
  constructor(base = document.baseURI, session = 'default', authorization: () => string | undefined = () => undefined) { this.base = base; this.session = session; this.authorization = authorization; }
  disconnect() {
    this.connection.abort(new Error('Connection changed.'));
    this.connection = new AbortController();
  }
  suggest(text: string, signal: AbortSignal): Promise<{ candidates: Candidate[] }> {
    const url = new URL('api/suggest', this.base);
    if (this.session !== 'default') url.searchParams.set('session', this.session);
    return requestJSON(url, { text }, { token: this.authorization, signal: AbortSignal.any([signal, this.connection.signal]) });
  }
}
