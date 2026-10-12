import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import http from 'node:http';
import assert from 'node:assert/strict';

const corpus = JSON.parse(await readFile(new URL('./fixtures/rust-migration/engine.json', import.meta.url), 'utf8'));
corpus.fixtures.push(...JSON.parse(await readFile(new URL('./fixtures/rust-migration/lexical.json', import.meta.url), 'utf8')).fixtures);
const hostCorpus = JSON.parse(await readFile(new URL('./fixtures/rust-migration/host.json', import.meta.url), 'utf8'));
const nativeCorpus = JSON.parse(await readFile(new URL('./fixtures/rust-migration/native-host.json', import.meta.url), 'utf8'));
const prewarmCorpus = JSON.parse(await readFile(new URL('./fixtures/rust-migration/prewarm.json', import.meta.url), 'utf8'));
hostCorpus.fixtures.push(...nativeCorpus.fixtures);
const wasm = await readFile(new URL('../src/engine/termai-engine.wasm', import.meta.url));
const bridge = stripTypeScriptTypes(await readFile(new URL('../src/engine/wasm.ts', import.meta.url), 'utf8'));
const directoryData = stripTypeScriptTypes(await readFile(new URL('../src/directory-data.ts', import.meta.url), 'utf8'));
const server = http.createServer((req, res) => {
  if (req.url === '/terminal/engine.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(bridge); }
  else if (req.url === '/directory-data.ts') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(directoryData); }
  else if (req.url === '/terminal/termai-engine.wasm') { res.writeHead(200, { 'Content-Type': 'application/wasm' }); res.end(wasm); }
  else if (req.url === '/terminal/corpus.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corpus)); }
  else if (req.url === '/terminal/host-corpus.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(hostCorpus)); }
  else if (req.url === '/terminal/prewarm-corpus.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(prewarmCorpus)); }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Rust engine parity</title>'); }
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
    const initializationStart = performance.now();
    const engine = await WasmEngine.load(new URL('termai-engine.wasm', location.href));
    const initializationMs = performance.now() - initializationStart;
    const resource = performance.getEntriesByType('resource').find(entry => entry.name.endsWith('/termai-engine.wasm'));
    const initialization = { initializationMs, downloadMs: resource?.duration, transferredBytes: resource?.transferSize, artifactBytes: resource?.decodedBodySize, browser: navigator.userAgent };
    const corpus = await (await fetch('./corpus.json')).json();
    const failures = [];
    // Sort object keys without disturbing array order or numeric values.
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    for (let index = 0; index < corpus.fixtures.length; index++) {
      const row = corpus.fixtures[index];
      const actual = engine.call(row.operation, row.args);
      if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(row.result))) failures.push({ index, row, actual });
      if (failures.length >= 10) break;
    }
    let unknown = '', cancelled = '';
    try { engine.call('unknown', []); } catch (error) { unknown = error.message; }
    try { engine.call('tokens', ['ignored'], AbortSignal.abort()); } catch (error) { cancelled = error.name; }
    // A failed call or cancelled request must leave the instance reusable.
    const unicode = engine.call('simpleWords', ["echo 'hello 🌍'"]);
    const key = value => JSON.stringify(canonical(value));
    const hostCorpus = await (await fetch('./host-corpus.json')).json();
    const hostFailures = [], preparedFailures = [];
    for (let index = 0; index < hostCorpus.fixtures.length; index++) {
      const row = hostCorpus.fixtures[index], observed = new Set();
      for (const prepared of row.operation === 'suggest' ? [false, true, 'directories'] : [false]) {
      observed.clear();
      engine.reset();
      if (row.metadata) await engine.invoke('seedMetadata', [row.args[1], row.args[2], row.metadata], async () => []);
      let actual;
      try {
        const provide = async callback => ({ results: callback.operations.map(operation => {
          operation = { ...operation }; delete operation.timeoutMs;
          const fact = row.facts.find(fact => key(fact.operation) === key(operation));
          if (!fact) throw new Error('Unexpected host operation: ' + key(operation));
          observed.add(key(operation));
          if (prepared === 'directories') {
            const entries = operation.kind === 'entries' ? fact.reply.value : fact.reply.value?.listing?.entries;
            if (entries) markImmutableDirectoryEntries(entries);
          }
          return fact.reply;
        }) });
        actual = { value: await (prepared ? engine.suggest(row.args[0], row.args[1], row.args[2], provide) : engine.invoke(row.operation, row.args, provide)) };
      } catch (error) { actual = { error: error.message }; }
      if (key(actual) !== key(row.expected) || row.facts.some(fact => !observed.has(key(fact.operation)))) (prepared ? preparedFailures : hostFailures).push({ index, expected: row.expected, actual });
      }
    }
    engine.reset();
    const prewarm = await (await fetch('./prewarm-corpus.json')).json();
    const prewarmFailures = [];
    const previousClock = Object.getOwnPropertyDescriptor(performance, 'now');
    let clock = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
    try {
      for (let index = 0; index < prewarm.steps.length; index++) {
        const step = prewarm.steps[index]; clock = step.now;
        const actual = await engine.invoke(step.operation, step.args, async () => { throw new Error('Prewarm selection must not request host facts.'); });
        if (key(actual) !== key(step.expected)) prewarmFailures.push({ index, actual, expected: step.expected });
      }
    } finally {
      if (previousClock) Object.defineProperty(performance, 'now', previousClock); else delete performance.now;
    }
    const validation = hostCorpus.fixtures[0];
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
    let imported = 0, referenced = 0;
    const directoryExchange = engine.exchange;
    engine.exchange = function(request, method) {
      if (method === 'termai_directories') for (const pin of request.directories) pin.entries ? imported++ : referenced++;
      return directoryExchange.call(this, request, method);
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
    const isolationArgs = structuredClone(validation.args); isolationArgs[1].command = 'cat one';
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
    const recovered = raw.termai_alloc(1); raw.termai_free(recovered);
    return { initialization, count: corpus.fixtures.length, failures, unknown, cancelled, unicode, hostCount: hostCorpus.fixtures.length, hostFailures, preparedFailures, preparedSnapshots, directorySnapshots, isolated,
      cancelledPending, reused, hostError, incomplete, allocated, invalidReply, recovered: !!recovered, prewarmFailures, prewarmCount: prewarm.steps.length };
  });
  assert.deepEqual(report.failures, []);
  assert.equal(report.unknown, 'Unknown engine operation.'); assert.equal(report.cancelled, 'AbortError');
  assert.deepEqual(report.unicode, [{ value: 'echo', home: false }, { value: 'hello 🌍', home: false }]);
  assert.deepEqual(report.hostFailures, []); assert.deepEqual(report.isolated, [true, false]);
  assert.deepEqual(report.preparedFailures, []);
  assert.deepEqual(report.preparedSnapshots, { reused: true, sharedPreparation: true, ordinary: true, pending: true, reset: true, changed: true });
  assert.deepEqual(report.directorySnapshots, { warmShared: true, changed: true, eviction: true, mutable: true, reset: true });
  assert.deepEqual(report.prewarmFailures, []);
  console.log('PASS Rust browser prewarm parity: ' + report.prewarmCount + ' reference cache steps.');
  assert.equal(report.cancelledPending, 'AbortError'); assert.equal(report.reused, true);
  assert.equal(report.hostError, 'Host denied.'); assert.equal(report.incomplete, 'Invalid or incomplete host reply.');
  assert.equal(report.allocated, 8); assert.equal(report.invalidReply.ok, false); assert.equal(report.recovered, true);
  assert.deepEqual(errors, []);
  assert.ok(report.initialization.initializationMs > 0);
  assert.equal(report.initialization.artifactBytes, wasm.length);
  await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.test-artifacts/rust-browser-initialization.json', import.meta.url), JSON.stringify(report.initialization, null, 2) + '\n');
  console.log('Rust browser initialization: ' + JSON.stringify(report.initialization));
  console.log(`PASS Rust browser WebAssembly: ${report.count} pure and ${report.hostCount} asynchronous reference fixtures, mounted assets, host errors, cancellation, concurrent isolation, allocation limits, and instance reuse.`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
