import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { WasmEngine } from '../src/engine/wasm.ts';
import { DirectoryChanged } from '../src/directory-cache.ts';

const root = new URL('../', import.meta.url).pathname;
export async function rustArchitectureAdapter(catalog, environment, client, bridge = WasmEngine) {
  const process = spawn(root + 'target/release/examples/engine_host', [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = []; let errors = '';
  process.stderr.on('data', bytes => errors += bytes);
  const lines = createInterface({ input: process.stdout });
  lines.on('line', line => {
    const next = pending.shift();
    if (!next) return;
    clearTimeout(next.timer);
    try { const reply = JSON.parse(line); if (reply.ok) next.resolve(reply.value); else next.reject(new Error(reply.error)); }
    catch (error) { next.reject(error); }
  });
  const fail = error => { for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(error); } };
  process.on('error', fail);
  process.stdin.on('error', fail);
  process.on('exit', code => { if (pending.length) fail(new Error('Rust benchmark peer exited (' + code + '): ' + errors)); });
  const call = (operation, args, signal) => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.kill(); fail(new Error('Rust benchmark peer timed out: ' + operation)); }, 15000);
      pending.push({ resolve, reject, timer });
      process.stdin.write(JSON.stringify({ operation, args }) + '\n');
    });
  };
  const start = performance.now();
  let wasm;
  try {
    await call('benchInitialize', [catalog, environment]);
    wasm = client ? await bridge.fromBytes(new Uint8Array(await readFile(root + 'src/engine/termai-engine.wasm')).buffer) : undefined;
  } catch (error) { process.kill(); lines.close(); throw error; }
  const initializationMs = performance.now() - start;
  return {
    initializationMs,
    directoryInput: text => wasm.call('directoryInput', [text]),
    async reset() { wasm?.reset(); await call('benchReset', []); },
    context: (known, paths) => call('benchContext', [known ?? null, paths]),
    read: (key, operations, signal) => call('benchFacts', [key, operations], signal),
    directory: directory => call('benchDirectory', [directory]),
    native: (text, signal) => call('benchSuggest', [text], signal),
    repair: (text, snapshot, signal) => call('benchRepair', [snapshot.key, snapshot.catalogKey, text], signal),
    async suggest(text, snapshot, host, signal) {
      let changed;
      const provide = async (callback, abort) => ({ results: await Promise.all(callback.operations.map(async operation => {
        try {
          abort.throwIfAborted();
          let value;
          switch (operation.kind) {
            case 'stat': value = await host.stat(operation.path); break;
            case 'lookup': value = await host.lookup(operation.path); break;
            case 'entries': value = await host.entries(operation.path, operation.limit); break;
            case 'syntax': value = await host.syntax(operation.command); break;
            case 'completion': value = await host.complete(operation.words, AbortSignal.any([abort, AbortSignal.timeout(Math.max(0, Math.ceil(operation.timeoutMs)))])); break;
            case 'help': value = await host.help(operation.command, operation.route); break;
            case 'describe': value = await host.describe(operation.command); break;
            default: throw new Error('Unknown Rust host operation.');
          }
          abort.throwIfAborted(); return { value: value ?? null };
        } catch (error) {
          if (error instanceof DirectoryChanged) changed = error;
          abort.throwIfAborted(); return { error: error instanceof Error ? error.message : String(error) };
        }
      })) });
      const value = await wasm.suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, provide, signal, snapshot.catalogKey);
      if (changed) throw changed;
      return value;
    },
    async dispose() {
      wasm?.reset();
      if (process.exitCode === null) {
        const exited = once(process, 'exit'); process.stdin.end();
        const timer = setTimeout(() => process.kill(), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      lines.close();
    },
  };
}
