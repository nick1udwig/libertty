import { constrainedLink } from './wire.ts';

export interface FileSnapshot { text: string; path: string; truncated: boolean; version?: string; unchanged?: boolean }
/** Pure so the same validation also runs inside the opaque plugin frame. */
export function mergeFileSnapshot(previous: FileSnapshot | undefined, value: any): FileSnapshot {
  if (value?.unchanged === true && typeof value.text !== 'string') {
    if (!previous || value.version !== previous.version) throw new Error('The selected file version changed.');
    return { ...previous, unchanged: true };
  }
  if (typeof value?.append === 'string') {
    if (!previous || previous.truncated || value.baseVersion !== previous.version || value.path !== previous.path || typeof value.version !== 'string') throw new Error('The selected file version changed.');
    return { path: previous.path, text: previous.text + value.append, truncated: false, version: value.version };
  }
  if (typeof value?.text !== 'string' || typeof value.path !== 'string' || typeof value.truncated !== 'boolean') throw new Error('Invalid selected file response.');
  return value;
}
export function packFileSnapshot(previous: FileSnapshot | undefined, value: FileSnapshot): unknown {
  if (previous?.version && value.version === previous.version && value.path === previous.path) return { unchanged: true, version: value.version };
  if (previous?.version && value.version && previous.path === value.path && !previous.truncated && !value.truncated && value.text.startsWith(previous.text)) {
    const append = value.text.slice(previous.text.length);
    if (append.length * 2 < value.text.length) return { path: value.path, version: value.version, baseVersion: previous.version, append };
  }
  const { unchanged: _unchanged, ...full } = value; return full;
}
/** One bounded snapshot and one in-flight request per selected file capability. */
export function selectedFileReader() {
  let previous: FileSnapshot | undefined, scope = '', pending: Promise<FileSnapshot> | undefined;
  return (url: URL, token?: string): Promise<FileSnapshot> => {
    const nextScope = url.href + '\0' + (token || '');
    if (scope !== nextScope) { scope = nextScope; previous = undefined; pending = undefined; }
    if (pending) return pending;
    const before = previous;
    const request = (async () => {
      url = new URL(url); url.searchParams.set('delta', '1');
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(12000), headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(before?.version ? { 'If-None-Match': '"' + before.version + '"' } : {}), ...(constrainedLink() ? { 'X-Termai-Link': 'constrained' } : {}) } });
      if (response.status === 304) {
        if (!before) throw new Error('Invalid unchanged selected file response.');
        return { ...before, unchanged: true };
      }
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || 'Request failed'), value, { status: response.status });
      const snapshot = mergeFileSnapshot(before, value);
      if (scope === nextScope) previous = snapshot;
      return snapshot;
    })();
    pending = request;
    void request.finally(() => { if (pending === request) pending = undefined; }).catch(() => {});
    return request;
  };
}
