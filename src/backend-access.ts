const keyFor = (url: string) => 'libertty.access:' + url;

/** Persist the issued credential per backend, never the server's pairing code. */
export function rememberBackendAccess(url: string, token: string) {
  try {
    localStorage.setItem(keyFor(url), token);
    try { sessionStorage.removeItem(keyFor(url)); } catch {}
  } catch { try { sessionStorage.setItem(keyFor(url), token); } catch {} }
}
export function backendAccess(url: string): string | undefined {
  try { const token = localStorage.getItem(keyFor(url)); if (token) return token; } catch {}
  try {
    const token = sessionStorage.getItem(keyFor(url));
    if (token) { rememberBackendAccess(url, token); return token; }
  } catch {}
  return undefined;
}
export function forgetBackendAccess(url: string) {
  try { localStorage.removeItem(keyFor(url)); } catch {}
  try { sessionStorage.removeItem(keyFor(url)); } catch {}
}
