import type { DictationTarget, ShellState } from './generated/protocol.ts';
export type { Candidate, Catalog, ClientMessage, DictationTarget, RepairIntent, RepairResult, ServerMessage, ShellState } from './generated/protocol.ts';
export function dictationTarget(state: ShellState): DictationTarget | undefined {
  if (state.exited) return;
  if (state.ready) return 'shell';
  if (state.inputTarget === 'program') return 'program';
}
