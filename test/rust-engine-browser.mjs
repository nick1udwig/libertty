import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import http from 'node:http';
import assert from 'node:assert/strict';

const wasm = await readFile(new URL('../src/engine/termai-engine.wasm', import.meta.url));
const bridge = stripTypeScriptTypes(await readFile(new URL('../src/engine/wasm.ts', import.meta.url), 'utf8'));
const directoryData = stripTypeScriptTypes(await readFile(new URL('../src/directory-data.ts', import.meta.url), 'utf8'));
const server = http.createServer((req, res) => {
  if (req.url === '/terminal/engine.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(bridge); }
  else if (req.url === '/directory-data.ts') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(directoryData); }
  else if (req.url === '/terminal/termai-engine.wasm') { res.writeHead(200, { 'Content-Type': 'application/wasm' }); res.end(wasm); }
  else if (req.url === '/terminal/engine-fallback.wasm') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(wasm); }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Rust engine browser checks</title>'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/terminal/`);
  const report = await page.evaluate(async () => {
    const { WasmEngine } = await import('./engine.js');
    const { markImmutableDirectoryEntries } = await import('../directory-data.ts');
    const originalStreaming = WebAssembly.instantiateStreaming;
    let streamingCalls = 0;
    WebAssembly.instantiateStreaming = (...args) => { streamingCalls++; return originalStreaming(...args); };
    const initializationStart = performance.now();
    const engine = await WasmEngine.load(new URL('termai-engine.wasm', location.href));
    const initializationMs = performance.now() - initializationStart;
    const resource = performance.getEntriesByType('resource').find(entry => entry.name.endsWith('/termai-engine.wasm'));
    const initialization = { initializationMs, downloadMs: resource?.duration, transferredBytes: resource?.transferSize, artifactBytes: resource?.decodedBodySize, browser: navigator.userAgent };
    const fallback = await WasmEngine.load(new URL('engine-fallback.wasm', location.href));
    const loading = { streamingCalls, fallback: fallback.call('tokens', ['echo fallback'])[1].value };
    WebAssembly.instantiateStreaming = originalStreaming;
    // Sort object keys without disturbing array order or numeric values.
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    let unknown = '', cancelled = '';
    try { engine.call('unknown', []); } catch (error) { unknown = error.message; }
    try { engine.call('tokens', ['ignored'], AbortSignal.abort()); } catch (error) { cancelled = error.name; }
    // A failed call or cancelled request must leave the instance reusable.
    const unicode = engine.call('simpleWords', ["echo 'hello 🌍'"]);
    const key = value => JSON.stringify(canonical(value));
    const prewarmCatalog = { cwd: '/fixture', commands: ['git'], paths: [], history: [] };
    const previousClock = Object.getOwnPropertyDescriptor(performance, 'now');
    let clock = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
    const prewarm = {};
    const noHost = async () => { throw new Error('Prewarm selection must not request host facts.'); };
    try {
      prewarm.initial = await engine.invoke('prewarmTargets', [prewarmCatalog, {}], noHost);
      await engine.invoke('markWarmed', ['git', prewarmCatalog, {}], noHost);
      clock = 599999;
      prewarm.warm = await engine.invoke('prewarmTargets', [prewarmCatalog, {}], noHost);
      clock = 600000;
      prewarm.expired = await engine.invoke('prewarmTargets', [prewarmCatalog, {}], noHost);
      clock = 1;
      engine.reset();
      prewarm.reset = await engine.invoke('prewarmTargets', [prewarmCatalog, {}], noHost);
    } finally {
      if (previousClock) Object.defineProperty(performance, 'now', previousClock); else delete performance.now;
    }
    const provider = exists => async callback => callback.operations.map(operation => operation.kind === 'syntax' ? true : exists ? { file: true, directory: false, executable: false } : null);
    engine.reset();
    const savedCatalog = { cwd: '/fixture', commands: ['git'], paths: [], history: ['git init'] };
    let preparations = 0;
    const exchange = engine.exchange;
    engine.exchange = function(request, method) { if (method === 'termai_context') preparations++; return exchange.call(this, request, method); };
    const saved = await engine.suggest('Get in it.', savedCatalog, {}, provider(false), undefined, 'catalog-v1');
    const repeated = await engine.suggest('Get in it.', structuredClone(savedCatalog), {}, provider(false), undefined, 'catalog-v1');
    const sharedPreparation = preparations === 1;
    const ordinary = await engine.invoke('suggest', ['Get in it.', savedCatalog, {}], provider(false));
    let releaseSnapshot;
    const older = engine.suggest('Get in it.', savedCatalog, {}, callback => new Promise(resolve => {
      releaseSnapshot = () => resolve(callback.operations.map(operation => operation.kind === 'syntax' ? true : null));
    }));
    const newer = await engine.suggest('LSL', { cwd: '/fixture', commands: ['ls'], paths: [], history: [] }, {}, provider(false));
    releaseSnapshot();
    const prior = await older;
    engine.reset();
    const resetPrepared = await engine.suggest('Get in it.', savedCatalog, {}, provider(false));
    const preparedSnapshots = { reused: key(saved) === key(repeated), sharedPreparation, ordinary: key(saved) === key(ordinary), pending: key(saved) === key(prior), reset: key(saved) === key(resetPrepared), changed: key(saved) !== key(newer) };
    engine.reset();
    const directoryCatalog = { cwd: '/fixture', commands: ['cd'], paths: [], history: [] };
    const directoryInput = 'cd work space';
    const directoryProvider = listing => async callback => callback.operations.map(operation => {
      if (operation.kind === 'lookup') return { listing };
      if (operation.kind === 'syntax') return true;
      if (operation.kind === 'stat') return { file: false, directory: true, executable: false };
      if (operation.kind === 'entries' || operation.kind === 'completion') return [];
      return null;
    });
    let imported = 0, referenced = 0, separateImports = 0;
    const directoryExchange = engine.exchange;
    engine.exchange = function(request, method) {
      if (method === 'termai_directories') separateImports++;
      if (method === 'termai_resume') for (const pin of request.directories || []) pin.entries ? imported++ : referenced++;
      return directoryExchange.call(this, request, method);
    };
    const directoryBufferExchange = engine.bufferExchange;
    engine.bufferExchange = function(text, invoke) {
      if (text.startsWith('{')) {
        const request = JSON.parse(text);
        for (const pin of request.directories || []) pin.entries ? imported++ : referenced++;
      }
      return directoryBufferExchange.call(this, text, invoke);
    };
    const directorySnapshot = (name, version = name) => {
      const entries = [{ name, directory: true, symlink: false }];
      markImmutableDirectoryEntries(entries);
      return { version, complete: true, entries };
    };
    const directorySuggest = listing => engine.suggest(directoryInput, directoryCatalog, {}, directoryProvider(listing));
    const firstDirectory = directorySnapshot('Workspace', 'v1');
    const firstResult = await directorySuggest(firstDirectory);
    const firstImports = imported;
    const secondResult = await directorySuggest({ ...firstDirectory, version: 'v2' });
    const warmShared = imported === firstImports && referenced > 0 && key(firstResult) === key(secondResult);
    const changedDirectory = directorySnapshot('Work Space', 'v3');
    const changedResult = await directorySuggest(changedDirectory);
    const changedOrdinary = await engine.invoke('suggest', [directoryInput, directoryCatalog, {}], directoryProvider(changedDirectory));
    const directoryChanged = key(changedResult) === key(changedOrdinary) && key(changedResult) !== key(firstResult);
    // Providers can await while other requests replace or evict snapshots.
    let releaseDirectory;
    let heldDirectory = false;
    const pendingDirectory = engine.suggest(directoryInput, directoryCatalog, {}, callback => heldDirectory ? directoryProvider(firstDirectory)(callback) : new Promise(resolve => {
      heldDirectory = true;
      releaseDirectory = async () => resolve(await directoryProvider(firstDirectory)(callback));
    }));
    for (let i = 0; i < 34; i++) await directorySuggest(directorySnapshot('Workspace', 'eviction-' + i));
    const beforeEvicted = imported;
    await releaseDirectory();
    const pendingResult = await pendingDirectory;
    const eviction = imported > beforeEvicted && key(pendingResult) === key(firstResult);
    const mutableDirectory = { version: 'mutable', complete: true, entries: [{ name: 'Workspace', directory: true, symlink: false }] };
    const beforeMutable = imported;
    await directorySuggest(mutableDirectory);
    mutableDirectory.entries[0].name = 'Work Space';
    const mutableResult = await directorySuggest(mutableDirectory);
    const mutable = imported === beforeMutable && key(mutableResult) === key(changedResult);
    engine.reset();
    const beforeReset = imported;
    const afterReset = await directorySuggest(firstDirectory);
    const directorySnapshots = { warmShared, changed: directoryChanged, eviction, mutable, reset: imported > beforeReset && key(afterReset) === key(firstResult) };
    const isolationArgs = ['cat one', { command: 'cat one', score: 100, changes: [] }, { cwd: '/fixture', commands: ['cat'], paths: [], history: [] }, {}, { flags: {}, subcommands: {}, requiredPositionals: {} }];
    const isolated = await Promise.all([engine.invoke('candidateValid', isolationArgs, provider(true)), engine.invoke('candidateValid', isolationArgs, provider(false))]);
    const controller = new AbortController();
    let release;
    const abandoned = engine.invoke('candidateValid', isolationArgs, async callback => new Promise(resolve => { release = () => resolve(callback.operations.map(() => true)); }), controller.signal);
    const abandonedResult = abandoned.then(() => 'unexpected success', error => error.name);
    controller.abort();
    const cancelledPending = await abandonedResult;
    const reused = await engine.invoke('candidateValid', isolationArgs, provider(true));
    release(); await Promise.resolve();
    let hostError = '', incomplete = '';
    try { await engine.invoke('candidateValid', isolationArgs, async () => { throw new Error('Host denied.'); }); } catch (error) { hostError = error.message; }
    try { await engine.invoke('candidateValid', isolationArgs, async () => []); } catch (error) { incomplete = error.message; }
    // Exercise the raw boundary so a bad pointer or allocation flood cannot corrupt the instance.
    const raw = (await WebAssembly.instantiate(await (await fetch('./termai-engine.wasm')).arrayBuffer(), {})).instance.exports;
    const pointers = Array.from({ length: 16 }, () => raw.termai_alloc(16 * 1024 * 1024));
    const allocated = pointers.filter(Boolean).length;
    pointers.forEach(pointer => raw.termai_free(pointer));
    const invalid = raw.termai_dispatch(0);
    const invalidReply = JSON.parse(new TextDecoder().decode(new Uint8Array(raw.memory.buffer, invalid, raw.termai_len(invalid))));
    raw.termai_free(invalid);
    const inputBuffer = raw.termai_alloc(4);
    const readStep = pointer => { const step = JSON.parse(new TextDecoder().decode(new Uint8Array(raw.memory.buffer, pointer, raw.termai_len(pointer)))); raw.termai_free(pointer); return step; };
    const bufferBounds = readStep(raw.termai_resume_buffer(inputBuffer, 5));
    new Uint8Array(raw.memory.buffer, inputBuffer, 4).set([0xff, 0, 0, 0]);
    const bufferUtf8 = readStep(raw.termai_suggest_buffer(inputBuffer, 1, 1, 1, 0));
    new TextEncoder().encodeInto('echo', new Uint8Array(raw.memory.buffer, inputBuffer, 4));
    const bufferReused = readStep(raw.termai_suggest_buffer(inputBuffer, 4, 2, 1, 0));
    raw.termai_free(inputBuffer);
    const recovered = raw.termai_alloc(1); raw.termai_free(recovered);
    return { initialization, loading, separateImports, unknown, cancelled, unicode, prewarm, preparedSnapshots, directorySnapshots, isolated,
      cancelledPending, reused, hostError, incomplete, allocated, invalidReply, bufferBounds, bufferUtf8, bufferReused, recovered: !!recovered };
  });
  assert.equal(report.unknown, 'Unknown engine operation.'); assert.equal(report.cancelled, 'AbortError');
  assert.deepEqual(report.unicode, [{ value: 'echo', home: false }, { value: 'hello 🌍', home: false }]);
  assert.deepEqual(report.isolated, [true, false]);
  assert.deepEqual(report.preparedSnapshots, { reused: true, sharedPreparation: true, ordinary: true, pending: true, reset: true, changed: true });
  assert.deepEqual(report.directorySnapshots, { warmShared: true, changed: true, eviction: true, mutable: true, reset: true });
  assert.deepEqual(report.loading, { streamingCalls: 1, fallback: 'fallback' });
  assert.equal(report.separateImports, 0);
  assert.equal(report.bufferBounds.state, 'error'); assert.match(report.bufferBounds.error, /Invalid engine buffer/);
  assert.equal(report.bufferUtf8.state, 'error'); assert.match(report.bufferUtf8.error, /utf-8/);
  assert.equal(report.bufferReused.request, 2); assert.match(report.bufferReused.error, /context/i);
  const targets = ['git', 'git init', 'git add', 'git commit', 'git status'];
  assert.deepEqual(report.prewarm, { initial: targets, warm: targets.slice(1), expired: targets, reset: targets });
  assert.equal(report.cancelledPending, 'AbortError'); assert.equal(report.reused, true);
  assert.equal(report.hostError, 'Host denied.'); assert.equal(report.incomplete, 'Invalid or incomplete host reply.');
  assert.equal(report.allocated, 8); assert.equal(report.invalidReply.ok, false); assert.equal(report.recovered, true);
  assert.deepEqual(errors, []);
  assert.ok(report.initialization.initializationMs > 0);
  assert.equal(report.initialization.artifactBytes, wasm.length);
  await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.test-artifacts/rust-browser-initialization.json', import.meta.url), JSON.stringify(report.initialization, null, 2) + '\n');
  console.log('Rust browser initialization: ' + JSON.stringify(report.initialization));
  console.log('PASS Rust browser WebAssembly: mounted assets, prewarm expiry, prepared catalogs, shared directories, host errors, cancellation, concurrent isolation, allocation limits, and instance reuse.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
