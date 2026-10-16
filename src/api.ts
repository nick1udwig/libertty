import { constrainedLink } from './wire.ts';

export interface RequestOptions extends RequestInit {
  token?: string | (() => string | undefined);
  recoverAuth?(rejectedToken?: string): Promise<void>;
  timeout?: number;
}
export function requestTimeout(url: URL, data?: unknown): number {
  if (url.pathname.endsWith('/api/herdr/action') && ['list-worktrees', 'new-worktree', 'open-worktree', 'delete-worktree'].includes((data as { action?: string })?.action || '')) return 135000;
  if (/\/api\/(sessions|ssh\/captured|herdr\/connect|herdr\/captured)$/.test(url.pathname)) return 25000;
  return 12000;
}
const attempts = 3, retriedStatus = [502, 503, 504];
function pause(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
/** Same-origin changes with a JSON body carry a key, so the backend replays an earlier attempt's reply instead of repeating it. */
function idempotencyKey(url: URL | string, init: RequestInit) {
  const method = (init.method || 'GET').toUpperCase();
  const sameOrigin = typeof location === 'undefined' || new URL(url, location.href).origin === location.origin;
  // Older cross-origin backends would reject the unfamiliar header during CORS preflight.
  return sameOrigin && ['POST', 'DELETE'].includes(method) && (init.body == null || typeof init.body === 'string') ? crypto.randomUUID() : undefined;
}
/** Retry only what cannot repeat an action: reads, and changes the backend recognizes by their idempotency key. */
export async function request(url: URL | string, options: RequestOptions = {}): Promise<Response> {
  const { token, recoverAuth, timeout = 12000, ...init } = options;
  const currentToken = () => typeof token === 'function' ? token() : token;
  const method = (init.method || 'GET').toUpperCase();
  const send = async (credential?: string, key = new Headers(init.headers).get('Idempotency-Key') || idempotencyKey(url, init)) => {
    const retried = ['GET', 'HEAD'].includes(method) || !!key;
    for (let attempt = 1, timedOut = false; ; attempt++) {
      const headers = new Headers(init.headers);
      if (constrainedLink()) headers.set('X-libertty-Link', 'constrained');
      if (credential) headers.set('Authorization', 'Bearer ' + credential);
      if (key) headers.set('Idempotency-Key', key);
      const signal = timeout ? AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeout)]) : init.signal;
      try {
        const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', headers, signal });
        if (!retried || attempt === attempts || !retriedStatus.includes(response.status)) return response;
        await response.body?.cancel();
      } catch (error) {
        init.signal?.throwIfAborted();
        // A request that timed out may still be running on a slow link, so it is retried only once.
        const expired = error instanceof DOMException && error.name === 'TimeoutError';
        if (!retried || attempt === attempts || expired && timedOut) throw error;
        timedOut ||= expired;
      }
      await pause(500 * 2 ** (attempt - 1), init.signal);
    }
  };
  const rejected = currentToken();
  let response = await send(rejected);
  if (response.status === 401 && recoverAuth) {
    await response.body?.cancel();
    await recoverAuth(rejected);
    init.signal?.throwIfAborted();
    // The rejected attempt never ran, so the retry with a fresh credential is a new request.
    response = await send(currentToken());
  }
  return response;
}
export async function responseJSON<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), result, { status: response.status });
  return result;
}
export async function requestJSON<T>(url: URL | string, data?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (data !== undefined) headers.set('Content-Type', 'application/json');
  return responseJSON<T>(await request(url, {
    timeout: requestTimeout(new URL(url), data), ...options, headers,
    method: options.method || (data === undefined ? 'GET' : 'POST'),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }));
}
