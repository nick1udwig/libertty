import type { DirectoryHost } from './directory-types.ts';
export type { DirectoryEntry, FileInfo } from './directory-types.ts';
/** All host dependencies of the repair engine. No terminal writes or general exec. */
export interface EngineHost extends DirectoryHost {
  syntax(command: string, signal: AbortSignal): Promise<boolean>;
  /** Programmable completion facts, queried without editing the terminal. */
  complete?(words: string[], signal: AbortSignal): Promise<string[]>;
}
