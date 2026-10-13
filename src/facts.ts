import type { Catalog, Flag } from './protocol.ts';
import type { Help } from './engine/help.ts';
import type { DirectoryEntry, FileInfo, DirectoryLookup, DirectorySnapshot } from './directory-data.ts';

export type Fact =
  | { kind: 'scoped'; cwd: string; operation: Fact }
  | { kind: 'stat'; path: string }
  | { kind: 'lookup'; path: string }
  | { kind: 'directory'; path: string; version?: string }
  | { kind: 'entries'; path: string; limit: number }
  | { kind: 'syntax'; command: string }
  | { kind: 'completion'; words: string[] }
  | { kind: 'help'; command: string; route: string[] }
  | { kind: 'describe'; command: string }
  | { kind: 'version'; command: string };
export type FactValue = string | DirectoryUpdate | DirectoryLookup | FileInfo | DirectoryEntry[] | string[] | boolean | Help | Flag[] | null;
export interface Snapshot { prompt: number; pathsIncluded: boolean; key: string; catalogKey: string; catalog: Catalog; home: string; discoveryKey: string; compoundRepair?: boolean }
export interface ContextReply extends Omit<Snapshot, 'catalog'> { catalog?: Catalog; patch?: Partial<Catalog>; base?: string }

export interface DirectoryUpdate extends Omit<DirectorySnapshot, 'entries'> { entries?: DirectorySnapshot['entries'] }
