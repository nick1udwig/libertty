import type { DirectorySnapshot } from './directory-data.ts';
import { markImmutableDirectoryEntries } from './directory-data.ts';

/** Bounded browser snapshots. A repair must verify every snapshot it uses. */
export class DirectoryCache {
  private values = new Map<string, DirectorySnapshot>();
  get(path: string) { return this.values.get(path); }
  remember(path: string, snapshot: DirectorySnapshot) {
    markImmutableDirectoryEntries(snapshot.entries);
    this.values.delete(path);
    if (snapshot.version) this.values.set(path, snapshot);
    while (this.values.size > 32 || [...this.values.values()].reduce((sum, value) => sum + value.entries.length, 0) > 30000) this.values.delete(this.values.keys().next().value!);
  }
  entries() { return this.values.entries(); }
}
export class DirectoryChanged extends Error {
  constructor() { super('Directory changed during repair.'); }
}
export const parentDirectory = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
