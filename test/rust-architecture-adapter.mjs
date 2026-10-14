import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = new URL('../', import.meta.url).pathname;
export async function rustArchitectureAdapter(catalog, environment) {
  const profile = globalThis.process.env.BENCH_PROFILE === 'debug' ? 'debug' : 'release';
  const process = spawn(root + 'target/' + profile + '/examples/engine_host', [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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

  try {
    await call('benchInitialize', [catalog, environment]);
  } catch (error) { process.kill(); lines.close(); throw error; }
  const initializationMs = performance.now() - start;
  return {
    initializationMs,
    async reset() { await call('benchReset', []); },
    native: (text, signal) => call('benchSuggest', [text], signal),
    async dispose() {
      if (process.exitCode === null) {
        const exited = once(process, 'exit'); process.stdin.end();
        const timer = setTimeout(() => process.kill(), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      lines.close();
    },
  };
}
