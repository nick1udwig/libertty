import type { TransferRequest } from './transfer-protocol.ts';
export type EngineMode = 'server';
export type DictationTarget = 'shell' | 'program';
export type RepairIntent = { kind: 'shell' } | { kind: 'reading-file'; phrase: string; operand: string } | { kind: 'reading-pipeline'; phrase: string; command: string };
export interface RepairResult { candidates: import('./engine/types.ts').Candidate[]; original: string; selected: string; accepted: boolean; revision: number; prompt: number; error?: string }
export type { Flag, Catalog, Candidate } from './engine/types.ts';
export interface ShellState {
  cwd: string; inputRevision: number; promptRevision: number; ready: boolean; prompt: number; exited: boolean; exitCode?: number;
  /** Set by Bash's private prompt/busy markers; absent while starting or submitting. */
  inputTarget?: DictationTarget;
  inputContext?: string;
  /** Native app scrolling is available through a scoped Herdr controller. */
  terminalScroll?: boolean;
}
export function dictationTarget(state: ShellState): DictationTarget | undefined {
  if (state.exited) return;
  if (state.ready) return 'shell';
  if (state.inputTarget === 'program') return 'program';
}
export type ServerMessage =
  | { type: 'pong' }
  | ({ type: 'repair-result'; id: string; source?: 'dictation' } & RepairResult)
  | { type: 'input-line'; id: string; prompt: number; revision: number; text?: string; cursor?: number }
  | { type: 'transfer'; request: TransferRequest }
  | { type: 'pasted'; text: string; replace: boolean; prompt: number; revision: number; source?: 'dictation'; repairing?: boolean }
  | { type: 'dictation'; id: string; state: 'ready' | 'done' | 'error'; message?: string; resume?: { acceptedFrames: number; finished: boolean } }
  | { type: 'reading-file'; path: string }
  | { type: 'reading-capture'; id: string; name: string; exitCode: number }
  | { type: 'reading-error'; message: string }
  | { type: 'ssh-command'; id: string; command: string }
  | { type: 'herdr-command'; id: string; command: string }
  | { type: 'ssh-released'; id: string }
  | { type: 'output'; seq: number; data: string }
  | { type: 'screen'; text: string; version?: number }
  | { type: 'screen-delta'; base: number; version: number; drop: number; from: number; tail: number; text: string }
  | { type: 'herdr-layout'; cols: number; rows: number; ready: boolean }
  | { type: 'herdr-frame'; seq: number; width: number; height: number; full: boolean; bytes: string }
  | { type: 'state'; state: ShellState }
  | { type: 'hello'; engine: EngineMode; reset: boolean; truncated: boolean; firstSeq: number; lastSeq: number; streamId: string }
  | { type: 'edit-result'; id: string; accepted: boolean; revision: number }
  /** The last numbered key the backend delivered for this browser terminal, absent when it does not know it. */
  | { type: 'input-ack'; seq?: number }
  | { type: 'result'; id: string; accepted: boolean; message?: string };
export type ClientMessage =
  | { type: 'ping'; checkpoint?: boolean }
  | { type: 'repair'; id: string; text: string; prompt: number; revision: number; intent?: RepairIntent }
  | { type: 'repair-cancel'; id: string }
  | { type: 'input-line'; id: string; prompt: number; revision: number }
  | { type: 'dictation'; id: string; action: 'start' | 'finish' | 'cancel'; prompt?: number; revision?: number; target?: DictationTarget; readingPhrases?: string[] }
  | { type: 'input'; data: string; seq?: number }
  | { type: 'paste'; text: string }
  | { type: 'dictation-paste'; text: string; applied: boolean; replace: boolean; prompt: number; revision: number; readingPhrases?: string[] }
  | { type: 'replace'; text: string; id: string; prompt: number; revision: number }
  | { type: 'command'; command: string; id: string; prompt: number }
  | { type: 'resize'; cols: number; rows: number; mobile?: boolean }
  | { type: 'terminal-scroll'; lines: number; column: number; row: number }
  | { type: 'terminal-click'; column: number; row: number; cols: number; rows: number }
  | { type: 'herdr-frame-request' }
  | { type: 'herdr-active'; active: boolean }
  | { type: 'ack'; seq: number };
