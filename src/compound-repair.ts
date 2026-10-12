import type { Snapshot } from './facts.ts';

/** These inputs commonly require dependent filesystem or discovery callbacks. */
export function compoundRepairRecommended(text: string, snapshot: Snapshot): boolean {
  if (!snapshot.compoundRepair) return false;
  if (/^\s*python[23]?\b/i.test(text)) return true;
  return text.trim().split(/\s+/).length >= 4 && !/^\s*(?:git|ls|echo|printf)\b/i.test(text);
}
