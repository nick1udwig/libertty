import type { TranscriptRecord } from './terminal-transcript.ts';

export interface CachedTerminal {
  key: string; version: 1; updated: number; stream: string; records: TranscriptRecord[]; screen: string; position: number; lines: number;
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
  if (v.version !== 1 || typeof v.key !== 'string' || v.key.length > 4096 || typeof v.stream !== 'string' || v.stream.length > 1024
    || !Number.isFinite(v.updated) || now - v.updated > lifetime || v.updated > now + 60000
    || !Number.isFinite(v.position) || v.position < 0 || !Number.isSafeInteger(v.lines) || v.lines < 500 || v.lines > 100000
    || typeof v.screen !== 'string' || v.screen.length > 512 * 1024 || !Array.isArray(v.records) || v.records.length > 64) return;
  let length = 0, previous = 0;
  for (const record of v.records) {
    if (!record || !Number.isSafeInteger(record.id) || record.id <= previous || !Number.isFinite(record.at)
      || !['history', 'excerpt', 'gap'].includes(record.kind) || typeof record.text !== 'string') return;
    previous = record.id; length += record.text.length;
  }
  return length <= 512 * 1024 ? v : undefined;
}
export function retainedTerminals(values: unknown[], now = Date.now()) {
  const entries = values.map(value => cachedTerminal(value, now)).filter((value): value is CachedTerminal => !!value).sort((a, b) => b.updated - a.updated);
  let bytes = 0;
  return entries.filter((entry, index) => { bytes += encoder.encode(JSON.stringify(entry)).byteLength; return index < 16 && bytes <= maximumBytes; });
}

/** Best-effort output storage that never blocks a live terminal on quota or eviction. */
export class TerminalCache {
  private database?: Promise<IDBDatabase>;
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('libertty-terminal-history', 1);
      let expired = false;
      const fail = () => { expired = true; clearTimeout(timer); this.database = undefined; reject(new Error('Terminal history storage is unavailable.')); };
      const timer = setTimeout(fail, 1500);
      request.onupgradeneeded = () => request.result.createObjectStore('terminals', { keyPath: 'key' });
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
    if (!cachedTerminal(entry)) return false;
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('terminals', 'readwrite'), store = tx.objectStore('terminals'), request = store.getAll();
        request.onsuccess = () => {
          const previous = cachedTerminal(request.result.find((old: CachedTerminal) => old.key === entry.key));
          if (previous && previous.updated > entry.updated) return;
          const retained = retainedTerminals([...request.result.filter((old: CachedTerminal) => old.key !== entry.key), entry]);
          const keys = new Set(retained.map(record => record.key));
          for (const old of request.result) if (!keys.has(old.key)) store.delete(old.key);
          if (keys.has(entry.key)) store.put(entry);
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
        const tx = db.transaction('terminals', 'readwrite'), store = tx.objectStore('terminals');
        if (key === undefined) store.clear(); else store.delete(key);
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = reject;
      });
      return true;
    } catch { return false; }
  }
}
