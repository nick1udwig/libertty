import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

export async function verifyHistoryStorage(browser) {
  const page = await browser.newPage();
  try {
    const source = stripTypeScriptTypes(await readFile(new URL('../../src/terminal-cache.ts', import.meta.url), 'utf8'));
    await page.route('http://history.test/**', route => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('.js') ? source : '<!doctype html>' }));
    await page.goto('http://history.test/');
    const result = await page.evaluate(async () => {
      const now = Date.now();
      const entry = (key, updated = now) => ({ key, updated, version: 2, stream: 'stream', records: [{ id: 1, at: now, kind: 'history', text: key }], picture: { last: 0, x: 0, y: 0, cursor: false }, position: 0 });
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('libertty-terminal-history', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('terminals', { keyPath: 'key' });
        open.onerror = reject;
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('terminals', 'readwrite');
          tx.objectStore('terminals').put(entry('migrated'));
          tx.objectStore('terminals').put(entry('expired', now - 8 * 86400000));
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
      const { TerminalCache } = await import('/cache.js');
      const first = new TerminalCache(), second = new TerminalCache();
      const migrated = (await first.read('migrated'))?.records[0].text;
      const original = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        if (this.name === 'terminals') throw new Error('A save read the payload store.');
        return original.apply(this, args);
      };
      const saved = await Promise.all([first.save(entry('same', now + 10)), second.save(entry('same', now))]);
      const newest = (await first.read('same'))?.updated === now + 10;
      for (let i = 0; i < 17; i++) saved.push(await first.save(entry(String(i), now + 100 + i)));
      const evicted = await first.read('migrated') === undefined && await first.read('0') === undefined;
      await first.clear('16');
      const cleared = await first.read('16') === undefined;
      await first.clear();
      const empty = await second.read('15') === undefined;
      return { migrated, saved: saved.every(Boolean), newest, evicted, cleared, empty };
    });
    assert.deepEqual(result, { migrated: 'migrated', saved: true, newest: true, evicted: true, cleared: true, empty: true });
  } finally { await page.close(); }
}
