/** Move saved settings and pairing credentials without overwriting newer values. */
export function migrateBrandStorage(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key?.startsWith('termai.')) continue;
    const next = 'libertty.' + key.slice('termai.'.length);
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}

if (typeof window !== 'undefined') {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try { migrateBrandStorage(window[name]); } catch { /* Retry remaining keys when storage becomes available. */ }
  }
}
