import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { GespenstTerminal } from '@gespenst/core';
import type { CoreRuntime, CoreTerminal } from '@gespenst/core/headless';
import { gespenstVersion, localBackend, rendererPixelRatio, runtimeTerminals, terminalABI } from '../src/gespenst-compat.ts';
import { Ghostty } from '../src/terminal-core.ts';

test('compatibility assumptions match the pinned runtime and live terminal handles', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@gespenst/core'], gespenstVersion);
  const ghostty = await Ghostty.load({
    wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
    callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
  });
  const terminal = ghostty.createTerminal(80, 24);
  try {
    assert.equal(runtimeTerminals(ghostty.core).get(terminal.core.id), terminal.core);
    assert.equal(terminalABI(terminal.core).bindings, ghostty.core.bindings);
    assert.equal(terminal.getPalette().length, 256);
    const snapshot = terminal.core.snapshot();
    terminal.restore(snapshot);
    assert.ok(terminalABI(terminal.core).handle > 0);
  } finally { terminal.free(); ghostty.dispose(); }
});
test('unsupported dependency shapes fail at the compatibility boundary', () => {
  assert.throws(() => localBackend({} as GespenstTerminal), /Unsupported Gespenst .*local backend/);
  assert.throws(() => terminalABI({} as CoreTerminal), /terminal ABI/);
  assert.throws(() => runtimeTerminals({} as CoreRuntime), /runtime terminals/);
  assert.equal(rendererPixelRatio(), 1);
});
