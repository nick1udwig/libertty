import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ghostty } from '../src/terminal-core.ts';
import { EchoPrediction } from '../src/predicted-echo.ts';
import type { ShellState } from '../src/protocol.ts';

const ghostty = await Ghostty.load({
  wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
  callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
});
after(() => ghostty.dispose());

test('native shell callbacks handle split sequences, command metadata, exit status and reset', () => {
  const terminal = ghostty.createTerminal(80, 24);
  const semanticState = () => terminal.semantics.state;
  try {
    assert.equal(semanticState(), undefined);
    assert.equal(terminal.semantics.allowsPrediction, true);
    terminal.write('\x1b]133;');
    assert.equal(terminal.semantics.state, undefined);
    terminal.write('A\x07$ \x1b]133;B\x07');
    assert.deepEqual(terminal.semantics.state, { phase: 'input' });
    terminal.write('\x1b]133;C;cmdline_url=ls%20-la\x07output');
    assert.deepEqual(terminal.semantics.state, { phase: 'output', command: 'ls -la' });
    assert.equal(terminal.semantics.allowsPrediction, false);
    terminal.write('\x1b]133;P;k=r\x07');
    assert.equal(semanticState()?.phase, 'output', 'A right prompt does not mark the running command as ready');
    terminal.write('\x1b]133;D;-1;err=boom\x07');
    assert.deepEqual(terminal.semantics.state, { phase: 'complete', command: 'ls -la', exitCode: -1, error: 'boom' });
    terminal.write('\x1b]133;A\x07');
    assert.deepEqual(terminal.semantics.state, { phase: 'prompt' });
    assert.deepEqual(terminal.semantics.lastCommand, { command: 'ls -la', exitCode: -1, error: 'boom' });
    assert.equal(terminal.semantics.allowsPrediction, true);
    terminal.write('\x1b]133;C\x07\x1b]133;D\x07');
    assert.equal(semanticState()?.exitCode, undefined);
    terminal.write('\x1b]133;C;cmdline_url=next\x07\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07');
    assert.equal(semanticState()?.phase, 'input');
    assert.deepEqual(terminal.semantics.lastCommand, { command: 'next', exitCode: 0, error: undefined });
    terminal.write('\x1bc');
    assert.equal(terminal.semantics.state, undefined);
    assert.equal(terminal.semantics.lastCommand, undefined);
  } finally { terminal.free(); }
});

test('callbacks stay isolated, survive restore and reuse one function-table pair per runtime', () => {
  const first = ghostty.createTerminal(80, 24), table = ghostty.core.bindings.exports.__indirect_function_table;
  const count = table.length;
  try {
    first.write('\x1b]133;C;cmdline_url=first\x07');
    for (let index = 0; index < 20; index++) {
      const second = ghostty.createTerminal(20, 4);
      second.write('\x1b]133;B\x07');
      assert.equal(first.semantics.state?.command, 'first');
      second.free();
    }
    assert.equal(table.length, count);
    first.restore(first.core.snapshot());
    assert.equal((() => first.semantics.state)(), undefined);
    first.core.write('\x1b]133;B\x07');
    assert.equal(first.semantics.state?.phase, 'input');
    first.core.dispose();
    first.free();
  } finally { first.free(); }
});

test('a native output event suppresses predicted echo even before server readiness changes', () => {
  const terminal = ghostty.createTerminal(80, 24);
  const state = { ready: true, exited: false, inputTarget: 'shell', prompt: 1, inputRevision: 0, promptRevision: 0 } as ShellState;
  let painted: unknown;
  const echo = new EchoPrediction(() => ({ cols: 80, x: 0, row: 0, cells: Array(80).fill(' '), visible: terminal.semantics.allowsPrediction }), value => painted = value);
  try {
    terminal.write('\x1b]133;A\x07\x1b]133;B\x07');
    echo.input('a', state, true);
    assert.ok(painted);
    terminal.write('\x1b]133;C\x07');
    echo.reconcile();
    assert.equal(painted, undefined);
    echo.input('b', state, true);
    assert.equal(painted, undefined);
    terminal.write('\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07');
    state.prompt++;
    echo.input('c', state, true);
    assert.ok(painted);
    state.ready = false;
    echo.state(state);
    assert.equal(painted, undefined);
  } finally { terminal.free(); }
});
