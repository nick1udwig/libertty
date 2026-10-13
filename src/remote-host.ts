import type { ContextReply, Fact, FactValue, Snapshot, DirectoryUpdate } from './facts.ts';
import type { DirectoryEntry, EngineHost, FileInfo } from './engine/host.ts';
import type { Help } from './engine/help.ts';
import type { DirectoryLookup, DirectorySnapshot } from './directory-data.ts';
import { markImmutableDirectoryEntries } from './directory-data.ts';
import type { Flag } from './protocol.ts';
import { DirectoryCache, DirectoryChanged, parentDirectory } from './directory-cache.ts';

export type FactTransport = <T>(body: unknown, signal: AbortSignal) => Promise<T>;
/** Request-scoped memoization: live paths are never reused across repairs. */
export class RemoteHost implements EngineHost {
  private transport: FactTransport;
  private signal: AbortSignal;
  private snapshot: Snapshot;
  private syntaxCache: Map<string, boolean>;
  private directories: DirectoryCache;
  private used = new Map<string, DirectorySnapshot>();
  private verified = new Map<string, string>();
  private pending: { fact: Fact; resolve(value: FactValue): void; reject(error: unknown): void }[] = [];
  private requests = new Map<string, Promise<FactValue>>();
  constructor(transport: FactTransport, snapshot: Snapshot, signal: AbortSignal, syntaxCache = new Map<string, boolean>(), directories = new DirectoryCache()) {
    this.transport = transport; this.snapshot = snapshot; this.signal = signal; this.syntaxCache = syntaxCache; this.directories = directories;
  }
  private request(fact: Fact): Promise<FactValue> {
    this.signal.throwIfAborted();
    const key = JSON.stringify(fact), cached = this.requests.get(key);
    if (cached) return cached;
    const promise = new Promise<FactValue>((resolve, reject) => {
      this.pending.push({ fact, resolve, reject });
      if (this.pending.length === 1) queueMicrotask(() => void this.flush().catch(() => {}));
    });
    this.requests.set(key, promise); return promise;
  }
  private async flush() {
    const batch = this.pending.splice(0);
    const checks = [...this.used].filter(([path, snapshot]) => this.verified.get(path) !== snapshot.version);
    if (!batch.length && !checks.length) return;
    try {
      this.signal.throwIfAborted();
      const operations: Fact[] = [...batch.map(item => item.fact), ...checks.map(([path, snapshot]) => ({ kind: 'directory' as const, path, version: snapshot.version }))];
      const values = await this.transport<FactValue[]>({ key: this.snapshot.key, operations }, this.signal);
      if (values.length !== operations.length) throw new Error('Incomplete host facts.');
      this.signal.throwIfAborted();
      let changed = false;
      checks.forEach(([path, previous], i) => {
        const update = values[batch.length + i] as DirectoryUpdate;
        if (update.version !== previous.version) {
          changed = true;
          this.directories.remember(path, { ...update, entries: update.entries || [] });
        } else this.verified.set(path, previous.version);
      });
      if (changed) throw new DirectoryChanged();
      batch.forEach((item, i) => item.resolve(values[i]));
    } catch (error) {
      batch.forEach(item => item.reject(error));
      if (!batch.length) throw error;
    }
  }
  async scoped(cwd: string, operation: Fact): Promise<FactValue> {
    return this.request({ kind: 'scoped', cwd, operation });
  }
  /** Also runs when matching stayed entirely local or produced only literal input. */
  async verify() { await this.flush(); this.signal.throwIfAborted(); }
  private use(path: string, snapshot: DirectorySnapshot) { this.used.set(path, snapshot); }
  async stat(path: string): Promise<FileInfo | undefined> {
    this.signal.throwIfAborted();
    // A complete parent listing can prove that even a deep exact path is absent.
    // Its version is checked before this speculative negative is accepted.
    for (const [dir, snapshot] of this.directories.entries()) {
      const prefix = dir === '/' ? '/' : dir + '/';
      if (!snapshot.complete || !path.startsWith(prefix)) continue;
      const component = path.slice(prefix.length).split('/')[0];
      if (component && !snapshot.entries.some(entry => entry.name === component)) { this.use(dir, snapshot); return undefined; }
    }
    return await this.request({ kind: 'stat', path }) as FileInfo | null || undefined;
  }
  async lookup(path: string): Promise<DirectoryLookup> {
    this.signal.throwIfAborted();
    const parent = parentDirectory(path), previous = this.directories.get(parent);
    const exact = previous?.entries.find(entry => entry.name === path.slice(path.lastIndexOf('/') + 1));
    if (previous && ((exact && !exact.symlink) || (!exact && previous.complete))) {
      this.use(parent, previous);
      return exact ? { info: { file: !exact.directory, directory: exact.directory, executable: false } } : { listing: previous };
    }
    const found = await this.request({ kind: 'lookup', path }) as DirectoryLookup;
    this.requests.set(JSON.stringify({ kind: 'stat', path }), Promise.resolve(found.info || null));
    if (found.listing) this.directories.remember(parent, found.listing);
    return found;
  }
  async entries(path: string, limit: number): Promise<DirectoryEntry[]> {
    const snapshot = this.directories.get(path);
    if (snapshot?.complete && snapshot.entries.length <= limit) { this.use(path, snapshot); return snapshot.entries; }
    const entries = await this.request({ kind: 'entries', path, limit }) as DirectoryEntry[];
    markImmutableDirectoryEntries(entries);
    return entries;
  }
  async syntax(command: string): Promise<boolean> {
    this.signal.throwIfAborted();
    const key = JSON.stringify([this.snapshot.catalog.cwd, command]);
    if (this.syntaxCache.has(key)) return this.syntaxCache.get(key)!;
    const valid = await this.request({ kind: 'syntax', command }) as boolean;
    if (this.syntaxCache.size >= 1000) this.syntaxCache.delete(this.syntaxCache.keys().next().value!);
    this.syntaxCache.set(key, valid); return valid;
  }
  async complete(words: string[], signal = this.signal): Promise<string[]> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      this.request({ kind: 'completion', words }).then(value => resolve(value as string[]), reject)
        .finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  async help(command: string, route: string[]): Promise<Help> {
    return await this.request({ kind: 'help', command, route }) as Help;
  }
  async version(command: string): Promise<string> { return await this.request({ kind: 'version', command }) as string; }
  async describe(command: string): Promise<Flag[] | undefined> {
    return await this.request({ kind: 'describe', command }) as Flag[] | null || undefined;
  }
}

export class ContextCache {
  private snapshot?: Snapshot;
  private receivedAt = 0;
  private catalogs = new Map<string, Snapshot['catalog']>();
  accept(reply: ContextReply, previous = this.snapshot): Snapshot | undefined {
    const base = reply.base && (this.catalogs.get(reply.base) || (previous?.catalogKey === reply.base ? previous.catalog : undefined));
    const catalog = reply.catalog || (base ? { ...base, ...reply.patch } : this.catalogs.get(reply.catalogKey) || (previous?.catalogKey === reply.catalogKey ? previous.catalog : undefined));
    if (!catalog) return undefined;
    if (previous && catalog !== previous.catalog) for (const field of ['commands', 'functions', 'paths', 'history'] as const) {
      const old = previous.catalog[field], next = catalog[field];
      if (old && next && old.length === next.length && old.every((value, i) => value === next[i])) catalog[field] = old;
    }
    this.catalogs.set(reply.catalogKey, catalog);
    if (this.catalogs.size > 8) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.snapshot = { ...reply, catalog }; this.receivedAt = Date.now();
    return this.snapshot;
  }
  async get(transport: FactTransport, signal: AbortSignal, includePaths = true, prompt?: number): Promise<Snapshot> {
    signal.throwIfAborted();
    const previous = this.snapshot;
    // The attached session refreshes lightweight context every two seconds.
    if (previous && prompt === previous.prompt && (!includePaths || previous.pathsIncluded) && Date.now() - this.receivedAt < 2500) return previous;
    const reply = await transport<ContextReply>({ kind: 'context', known: previous?.catalogKey, paths: includePaths }, signal);
    signal.throwIfAborted();
    const snapshot = this.accept(reply, previous);
    if (!snapshot) throw new Error('Missing shell context.');
    return snapshot;
  }
}
