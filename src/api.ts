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
/** Retry only a rejected credential; a timeout may already have performed a mutation. */
export async function request(url: URL | string, options: RequestOptions = {}): Promise<Response> {
  const { token, recoverAuth, timeout = 12000, ...init } = options;
  const currentToken = () => typeof token === 'function' ? token() : token;
  const signal = timeout ? AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeout)]) : init.signal;
  const send = (credential?: string) => {
    const headers = new Headers(init.headers);
    if (constrainedLink()) headers.set('X-Termai-Link', 'constrained');
    if (credential) headers.set('Authorization', 'Bearer ' + credential);
    return fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', headers, signal });
  };
  const rejected = currentToken();
  let response = await send(rejected);
  if (response.status === 401 && recoverAuth) {
    await response.body?.cancel();
    await recoverAuth(rejected);
    signal?.throwIfAborted();
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
