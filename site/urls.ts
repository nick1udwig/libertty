export function normalizeSiteUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) throw new Error('LIBERTTY_SITE_URL must be an HTTP or HTTPS URL without credentials, a query or a fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}
