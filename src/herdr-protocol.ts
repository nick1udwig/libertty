export type {
  HerdrWorktrees,
  HerdrAgent,
  HerdrMessage,
  HerdrSnapshot,
  HerdrSpace,
  HerdrStatus,
} from './generated/protocol.ts';
export function herdrSession(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === 'default') return '';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))
    throw new Error(
      'Use a Herdr session name containing letters, numbers, hyphens or underscores.',
    );
  return value;
}
export function herdrName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 100 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error('Enter a name of 1–100 characters.');
  return value.trim();
}
/** Identifies one Herdr server behind a libertty backend. */
export interface HerdrAddress {
  core?: boolean;
  session?: string | null;
  source?: string | null;
}
export function herdrURL(
  name: string,
  base: string | URL,
  { core, session, source }: HerdrAddress,
) {
  const url = new URL(name, base);
  if (core) url.searchParams.set('herdrCore', '1');
  if (session) url.searchParams.set('herdrSession', session);
  if (source) url.searchParams.set('herdrSource', source);
  return url;
}
