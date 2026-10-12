export type { FileInfo, DirectoryEntry, DirectorySnapshot, DirectoryLookup, DirectoryHost } from './engine/directory-types.ts';
import type { DirectoryEntry } from './engine/directory-types.ts';

/** Only adapter-owned immutable arrays may be retained by the Wasm bridge. */
export const immutableDirectoryEntries = new WeakSet<DirectoryEntry[]>();
export function markImmutableDirectoryEntries(entries: DirectoryEntry[]) {
  if (!immutableDirectoryEntries.has(entries) && Array.isArray(entries) && entries.every(entry => entry && typeof entry.name === 'string' && typeof entry.directory === 'boolean' && typeof entry.symlink === 'boolean')) {
    immutableDirectoryEntries.add(entries);
  }
}
