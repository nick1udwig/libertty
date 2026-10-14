export function saved<T>(key: string, fallback: T): T { try { const value = JSON.parse(localStorage.getItem('termai.' + key) || 'null'); return value === null || (Array.isArray(fallback) ? !Array.isArray(value) : typeof value !== typeof fallback) ? fallback : value; } catch { return fallback; } }
export function validSession(value: unknown): value is string {
  return value === 'default' || (typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value));
}
export function validCapture(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}
export function validPath(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
