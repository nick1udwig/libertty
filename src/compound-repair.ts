import type { Snapshot } from './facts.ts';

/** Benchmark adapters use the same coarse boundary as the browser coordinator. */
export function compoundRepairRecommended(_text: string, snapshot: Snapshot): boolean {
  return snapshot.compoundRepair === true;
}
