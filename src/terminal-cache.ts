import type { TerminalPicture } from './terminal-snapshot.ts';
import type { TranscriptRecord } from './terminal-transcript.ts';

export interface NativeTerminalSnapshot { build: string; cols: number; rows: number; bytes: Uint8Array }

/** Validate storage without loading the terminal engine; restoration checks the build checksum. */
export function nativeTerminalSnapshot(value: unknown): NativeTerminalSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const snapshot = value as NativeTerminalSnapshot;
  if (typeof snapshot.build !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.build) || !Number.isInteger(snapshot.cols) || snapshot.cols < 2 || snapshot.cols > 1000
    || !Number.isInteger(snapshot.rows) || snapshot.rows < 1 || snapshot.rows > 1000
    || !(snapshot.bytes instanceof Uint8Array) || !snapshot.bytes.byteLength || snapshot.bytes.byteLength > 2 * 1024 * 1024) return;
  return snapshot;
}

export interface CachedTerminal {
  key: string; version: 2; updated: number; stream: string; records: TranscriptRecord[]; picture: TerminalPicture; position: number; native?: NativeTerminalSnapshot;
}
const lifetime = 7 * 24 * 60 * 60 * 1000, maximumBytes = 8 * 1024 * 1024;
const encoder = new TextEncoder();
export function terminalCacheKey(backend: string, session: string, terminal = '', source = '', pane = '') {
  const url = new URL(backend);
  return JSON.stringify([url.origin, url.pathname, terminal ? 'herdr' : 'shell', session, source, terminal, pane]);
}
export function cachedTerminal(value: unknown, now = Date.now()): CachedTerminal | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as CachedTerminal;
  const picture = v.picture;
  if (v.version !== 2 || typeof v.key !== 'string' || v.key.length > 4096 || typeof v.stream !== 'string' || v.stream.length > 1024
    || !Number.isFinite(v.updated) || now - v.updated > lifetime || v.updated > now + 60000
    || !Number.isSafeInteger(v.position) || v.position < 0 || !picture || typeof picture !== 'object' || typeof picture.cursor !== 'boolean'
    || [picture.last, picture.x, picture.y].some(value => !Number.isSafeInteger(value) || Math.abs(value) > 1000)
    || !Array.isArray(v.records) || v.records.length > 64) return;
  let length = 0, previous = 0;
  for (const record of v.records) {
    if (!record || !Number.isSafeInteger(record.id) || record.id <= previous || !Number.isFinite(record.at)
      || !['history', 'excerpt', 'gap'].includes(record.kind) || typeof record.text !== 'string') return;
    previous = record.id; length += record.text.length;
  }
  return length <= 512 * 1024 ? { ...v, native: nativeTerminalSnapshot(v.native) } : undefined;
}
interface CacheMetadata { key: string; updated: number; bytes: number }
function metadata(entry: CachedTerminal): CacheMetadata {
  const { native, ...text } = entry;
  return { key: entry.key, updated: entry.updated, bytes: encoder.encode(JSON.stringify(text)).byteLength + (native ? native.bytes.byteLength + native.build.length + 64 : 0) };
}
function retainedMetadata(entries: CacheMetadata[], now = Date.now()) {
  let bytes = 0;
  return entries.filter(entry => now - entry.updated <= lifetime && entry.updated <= now + 60000)
    .sort((a, b) => b.updated - a.updated)
    .filter((entry, index) => { bytes += entry.bytes; return index < 16 && bytes <= maximumBytes; });
}
export function retainedTerminals(values: unknown[], now = Date.now()) {
  const entries = values.map(value => cachedTerminal(value, now)).filter((value): value is CachedTerminal => !!value);
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  return retainedMetadata(entries.map(metadata), now).map(entry => byKey.get(entry.key)!);
}

/** Best-effort output storage that never blocks a live terminal on quota or eviction. */
export class TerminalCache {
  private database?: Promise<IDBDatabase>;
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('libertty-terminal-history', 2);
      let expired = false;
      const fail = () => { expired = true; clearTimeout(timer); this.database = undefined; reject(new Error('Terminal history storage is unavailable.')); };
      const timer = setTimeout(fail, 1500);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains('terminals') ? request.transaction!.objectStore('terminals') : db.createObjectStore('terminals', { keyPath: 'key' });
        const index = db.createObjectStore('metadata', { keyPath: 'key' });
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          const entry = cachedTerminal(current.value);
          if (entry) index.put(metadata(entry)); else current.delete();
          current.continue();
        };
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) { request.result.close(); return; }
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
      request.onerror = request.onblocked = fail;
    });
  }
  async read(key: string): Promise<CachedTerminal | undefined> {
    try {
      const db = await this.open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('terminals', 'readonly'), request = tx.objectStore('terminals').get(key);
        tx.oncomplete = () => resolve(cachedTerminal(request.result)); tx.onabort = tx.onerror = reject;
      });
    } catch { return; }
  }
  async save(entry: CachedTerminal): Promise<boolean> {
    const validated = cachedTerminal(entry);
    if (!validated) return false;
    entry = validated;
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['terminals', 'metadata'], 'readwrite'), store = tx.objectStore('terminals'), index = tx.objectStore('metadata'), request = index.getAll();
        request.onsuccess = () => {
          const previous = request.result.find((old: CacheMetadata) => old.key === entry.key);
          if (previous && previous.updated > entry.updated) return;
          const current = metadata(entry);
          const retained = retainedMetadata([...request.result.filter((old: CacheMetadata) => old.key !== entry.key), current]);
          const keys = new Set(retained.map(record => record.key));
          for (const old of request.result) if (!keys.has(old.key)) { store.delete(old.key); index.delete(old.key); }
          if (keys.has(entry.key)) { store.put(entry); index.put(current); }
        };
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = reject;
      });
      return true;
    } catch { return false; }
  }
  async clear(key?: string): Promise<boolean> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['terminals', 'metadata'], 'readwrite');
        for (const name of ['terminals', 'metadata']) { const store = tx.objectStore(name); if (key === undefined) store.clear(); else store.delete(key); }
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = reject;
      });
      return true;
    } catch { return false; }
  }
}
