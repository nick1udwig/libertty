import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Ghostty } from '../src/terminal-core.ts';
import { GHOSTTY_BUILD } from '@gespenst/core/headless';

const wasm = await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url));
const callbacksWasm = await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url));
const samples = [];
for (const count of [1, 5, 20]) {
  const runtime = await Ghostty.load({ wasm, callbacksWasm });
  const terminals = Array.from({ length: count }, () => runtime.createTerminal(80, 24, { scrollbackLimit: 5000 }));
  const sample = phase => {
    globalThis.gc?.();
    samples.push({ count, phase, ...runtime.memoryUsage(), processJsHeapBytes: process.memoryUsage().heapUsed });
  };
  sample('empty');
  for (const terminal of terminals) terminal.write('\x1b[32mbuild output\x1b[0m e\u0301界😀\r\n'.repeat(5000));
  sample('filled');
  for (const terminal of terminals) terminal.free();
  sample('freed');
  runtime.dispose();
}
const report = { ghostty: GHOSTTY_BUILD.ghosttyCommit, description: 'Headless Node measurement with one shared WASM runtime per scenario; retained bytes are part of WASM capacity, not additive; JS heap covers the process and excludes browser rendering.', samples };
await mkdir('.test-artifacts', { recursive: true });
await writeFile('.test-artifacts/terminal-memory.json', JSON.stringify(report, null, 2) + '\n');
console.table(samples.map(({ count, phase, retainedBytes, wasmCapacityBytes, processJsHeapBytes }) => ({ count, phase, retainedBytes, wasmCapacityBytes, processJsHeapBytes })));
