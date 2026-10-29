import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Terminal } from '../src/terminal-adapter.ts';
import { Ghostty } from '../src/terminal-core.ts';
import { terminalSnapshot, invalidateSnapshot } from '../src/terminal-snapshot.ts';

test('snapshots reuse unchanged rows and refresh content, geometry and colors', () => {
  let reads = 0;
  const cell = { codepoint: 65, width: 1, flags: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0, grapheme_len: 0 };
  const foreground = { r: 255, g: 255, b: 255 };
  const native = { getRevision: () => 0, cols: 2, rows: 1, getColors: () => ({ foreground }), getScrollbackLength: () => 0, getCursor: () => ({ x: 0, y: 0, visible: true }), getViewport: () => { reads++; return [cell, cell]; } };
  const term = { wasmTerm: native, buffer: { active: { type: 'normal' } } } as unknown as Terminal;
  const first = terminalSnapshot(term);
  assert.equal(first.text, '\x1b[0;1mAA\x1b[0m');
  assert.equal(terminalSnapshot(term), first);
  assert.equal(reads, 1);
  cell.codepoint = 66; invalidateSnapshot(term);
  assert.match(terminalSnapshot(term).text, /BB/);
  native.cols = 1;
  assert.match(terminalSnapshot(term).text, /mB\x1b/);
  foreground.r = 0;
  assert.match(terminalSnapshot(term).text, /38;2;255;255;255/);
  assert.equal(reads, 4);
});


test('snapshots follow Gespenst revisions before rendering, including direct core writes and cursor changes', async () => {
  const ghostty = await Ghostty.load({
    wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
    callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
  });
  const term = new Terminal({ cols: 20, rows: 4 });
  term.wasmTerm = ghostty.createTerminal(20, 4);
  try {
    term.wasmTerm.core.write('before');
    const first = terminalSnapshot(term);
    assert.equal(terminalSnapshot(term), first);
    term.wasmTerm.core.write(' after');
    const changed = terminalSnapshot(term);
    assert.notEqual(changed, first);
    assert.equal(changed.text, 'before after');
    term.wasmTerm.core.write('\x1b[2;3H\x1b[?25l');
    assert.deepEqual(terminalSnapshot(term).picture, { last: 0, x: 2, y: 1, cursor: false });
    term.wasmTerm.write('next');
    assert.match(terminalSnapshot(term).text, /next/);
    assert.equal(term.wasmTerm.core.render().dirty, 'full');
  } finally { term.wasmTerm.free(); ghostty.dispose(); }
});
