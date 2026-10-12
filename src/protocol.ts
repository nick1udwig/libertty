import type { TransferRequest } from './transfer-protocol.ts';
import type { ContextReply } from './facts.ts';
import type { DirectorySnapshot } from './directory-data.ts';
export type EngineMode = 'server' | 'client';
export type DictationTarget = 'shell' | 'program';
export type { Flag, Catalog, Candidate } from './engine/types.ts';
export interface ShellState {
  cwd: string; inputRevision: number; promptRevision: number; ready: boolean; prompt: number; exited: boolean; exitCode?: number;
  /** Set by Bash's private prompt/busy markers; absent while starting or submitting. */
  inputTarget?: DictationTarget;
  /** Native app scrolling is available through a scoped Herdr controller. */
  terminalScroll?: boolean;
}
export function dictationTarget(state: ShellState): DictationTarget | undefined {
  if (state.exited) return;
  if (state.ready) return 'shell';
  if (state.inputTarget === 'program') return 'program';
}
export type ServerMessage =
  | { type: 'input-line'; id: string; prompt: number; revision: number; text?: string; cursor?: number }
  | { type: 'transfer'; request: TransferRequest }
  | { type: 'pasted'; text: string; replace: boolean; prompt: number; revision: number; source?: 'dictation' }
  | { type: 'dictation'; id: string; state: 'ready' | 'done' | 'error'; message?: string }
  | { type: 'reading-file'; path: string }
  | { type: 'reading-capture'; id: string; name: string; exitCode: number }
  | { type: 'reading-error'; message: string }
  | { type: 'ssh-command'; id: string; command: string }
  | { type: 'herdr-command'; id: string; command: string }
  | { type: 'ssh-released'; id: string }
  | { type: 'output'; seq: number; data: string }
  | { type: 'screen'; text: string }
  | { type: 'herdr-layout'; cols: number; rows: number; ready: boolean }
  | { type: 'herdr-frame'; width: number; height: number; full: boolean; bytes: string }
  | { type: 'state'; state: ShellState }
  | { type: 'context'; context: ContextReply; directories: { path: string; snapshot: DirectorySnapshot }[] }
  | { type: 'hello'; engine: EngineMode; reset: boolean; truncated: boolean; firstSeq: number; streamId: string }
  | { type: 'edit-result'; id: string; accepted: boolean; revision: number }
  | { type: 'result'; id: string; accepted: boolean; message?: string };
export type ClientMessage =
  | { type: 'input-line'; id: string; prompt: number; revision: number }
  | { type: 'dictation'; id: string; action: 'start' | 'finish' | 'cancel'; prompt?: number; revision?: number; target?: DictationTarget }
  | { type: 'input'; data: string }
  | { type: 'replace'; text: string; id: string; prompt: number; revision: number }
  | { type: 'command'; command: string; id: string; prompt: number }
  | { type: 'resize'; cols: number; rows: number; mobile?: boolean }
  | { type: 'terminal-scroll'; lines: number; column: number; row: number }
  | { type: 'herdr-frame-request' }
  | { type: 'herdr-active'; active: boolean }
  | { type: 'ack'; seq: number };
