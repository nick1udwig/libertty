import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('app-shell caches are complete, bounded, offline-capable and retired per installation', async () => {
  const template = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const storage = new Map<string, Map<string, Response>>();
  let offline = false, requests = 0;
  let held: Promise<void> | undefined;
  const fetch = async (request: string | { url: string }) => {
    requests++;
    if (held) await held;
    if (offline) throw new Error('Offline');
    return new Response(typeof request === 'string' ? request : request.url);
  };
  const caches = {
    async open(name: string) {
      if (!storage.has(name)) storage.set(name, new Map());
      const cache = storage.get(name)!;
      return {
        async put(url: string, response: Response) { cache.set(url, response.clone()); },
        async match(url: string) { return cache.get(url)?.clone(); },
        async addAll(urls: string[]) { for (const url of urls) cache.set(url, await fetch(url)); },
      };
    },
    async keys() { return [...storage.keys()]; },
    async delete(name: string) { return storage.delete(name); },
    async match(url: string) { for (const cache of storage.values()) if (cache.has(url)) return cache.get(url)!.clone(); },
  };
  function worker(version: string) {
    const handlers: Record<string, (event: any) => void> = {};
    const pending: Promise<unknown>[] = [];
    const files = ['', 'terminal.html', 'icon.svg', 'manifest.webmanifest', `assets/${version}.js`, `assets/${version}.wasm`];
    runInNewContext(template.replace('__LIBERTTY_BUILD__', version).replace(/\/\*__LIBERTTY_ASSETS__\*\/\s*\[[^\]]*\]/, JSON.stringify(files)), {
      URL, Response, caches, fetch,
      self: { registration: { scope: 'https://example.com/t/' }, clients: { claim: async () => {} }, addEventListener: (name: string, handler: typeof handlers[string]) => handlers[name] = handler },
    });
    return {
      async dispatch(name: string, url = '', mode = 'cors', settle = true) {
        const waits: Promise<unknown>[] = [];
        let response: Promise<Response> | undefined;
        handlers[name]({ request: { url, mode, method: 'GET' }, waitUntil: (work: Promise<unknown>) => { waits.push(work); pending.push(work); }, respondWith: (work: Promise<Response>) => response = work });
        const result = await response;
        if (settle) await Promise.all(waits); return result;
      },
      async settle() { await Promise.all(pending.splice(0)); },
    };
  }
  await caches.open('libertty-shell:/other/:keep');
  const first = worker('one');
  await first.dispatch('install'); await first.dispatch('activate');
  assert.equal(storage.get('libertty-shell:/t/:one')!.size, 6);
  const before = requests;
  assert.equal((await first.dispatch('fetch', 'https://example.com/t/assets/one.wasm'))?.status, 200);
  assert.equal(requests, before);
  await first.dispatch('fetch', 'https://example.com/t/?one', 'navigate');
  await first.dispatch('fetch', 'https://example.com/t/?two', 'navigate');
  await first.dispatch('fetch', 'https://example.com/t/assets/unlisted.js');
  assert.equal(storage.get('libertty-shell:/t/:one')!.size, 6);
  assert.equal(await first.dispatch('fetch', 'https://example.com/t/api/ping'), undefined);
  await first.dispatch('fetch', 'https://example.com/t/terminal.html?session=example', 'navigate');
  offline = true;
  assert.equal(await (await first.dispatch('fetch', 'https://example.com/t/', 'navigate'))?.text(), 'https://example.com/t/?two');
  assert.equal(await (await first.dispatch('fetch', 'https://example.com/t/terminal.html', 'navigate'))?.text(), 'https://example.com/t/terminal.html?session=example');
  assert.equal((await first.dispatch('fetch', 'https://example.com/t/assets/one.js'))?.status, 200);
  offline = false;
  let release!: () => void;
  held = new Promise<void>(resolve => release = resolve);
  const cached = await Promise.race([
    first.dispatch('fetch', 'https://example.com/t/terminal.html?slow', 'navigate', false),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cached navigation waited for the network')), 1000)),
  ]);
  assert.equal(await cached?.text(), 'https://example.com/t/terminal.html?session=example');
  held = undefined; release(); await first.settle();
  offline = true;
  assert.equal(await (await first.dispatch('fetch', 'https://example.com/t/terminal.html', 'navigate'))?.text(), 'https://example.com/t/terminal.html?slow');
  offline = false;
  const second = worker('two'); await second.dispatch('install');
  offline = true;
  assert.equal((await first.dispatch('fetch', 'https://example.com/t/assets/two.js'))?.status, 200);
  await second.dispatch('activate');
  assert.deepEqual(await caches.keys(), ['libertty-shell:/other/:keep', 'libertty-shell:/t/:two']);
});
