import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Terminal } from '../src/terminal-adapter.ts';
import { Ghostty } from '../src/terminal-core.ts';
import { terminalSnapshot, plainText } from '../src/terminal-snapshot.ts';

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

test('styled snapshots preserve native cell attributes, colors, links and graphemes', async () => {
  const ghostty = await Ghostty.load({
    wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
    callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
  });
  const term = new Terminal({ cols: 30, rows: 3 });
  term.wasmTerm = ghostty.createTerminal(30, 3);
  const restored = ghostty.createTerminal(30, 3);
  try {
    term.write('e\u0301界😀\x1b[4:3;58:2::12:34:56;53;48;2;0;0;0mU \x1b[0m'
      + '\x1b]8;;https://example.com/path\x1b\\\x1b[38;5;2mLINK\x1b]8;;\x1b\\\x1b[0m'
      + '\r\n\x1b[4:2mD\x1b[4:4mT\x1b[4:5mH\x1b[0m\x1b[48;2;0;0;0m  \x1b[0m');
    const snapshot = terminalSnapshot(term);
    restored.write(snapshot.text.replaceAll('\n', '\r\n'));
    const cells = (terminal: typeof restored, row: number) => terminal.getLine(row)!.map(cell => ({
      text: cell.text, width: cell.width, style: cell.style, foreground: cell.foreground && { ...cell.foreground, a: 1 },
      background: cell.background && { ...cell.background, a: 1 }, underline: cell.underlineSource, link: cell.hyperlinkUri,
    }));
    assert.deepEqual(cells(restored, 0), cells(term.wasmTerm, 0));
    assert.deepEqual(cells(restored, 1), cells(term.wasmTerm, 1));
    assert.equal(plainText(snapshot.text), 'e\u0301界😀U LINK\nDTH  ');
    assert.equal(term.wasmTerm.core.render().dirty, 'full');
    assert.equal(terminalSnapshot(term), snapshot);
    term.resize(25, 3);
    assert.notEqual(terminalSnapshot(term), snapshot);
  } finally { restored.free(); term.wasmTerm.free(); ghostty.dispose(); }
});

test('text snapshots retain OSC 4 foreground and background colors across grid sizes', async () => {
  const ghostty = await Ghostty.load({
    wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
    callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
  });
  const term = new Terminal({ cols: 20, rows: 2 });
  term.wasmTerm = ghostty.createTerminal(20, 2);
  const restored = ghostty.createTerminal(25, 4);
  try {
    term.write('\x1b]4;1;#123456\x07\x1b]4;2;#654321\x07\x1b[31;42;4;58;5;1mhistory\r\nsecond\r\nvisible');
    const snapshot = terminalSnapshot(term);
    assert.match(snapshot.text, /38;2;18;52;86/);
    assert.match(snapshot.text, /48;2;101;67;33/);
    restored.write(snapshot.text.replaceAll('\n', '\r\n'));
    for (let row = 0; row < 3; row++) {
      const cell = restored.getLine(row)![0];
      assert.deepEqual(cell.foreground, { r: 18, g: 52, b: 86 });
      assert.deepEqual(cell.background, { r: 101, g: 67, b: 33 });
      assert.deepEqual(cell.underlineSource, { mode: 'rgb', value: { r: 18, g: 52, b: 86 } });
    }
    term.write('\x1b]4;1;#abcdef\x07');
    const recolored = terminalSnapshot(term);
    assert.notEqual(recolored, snapshot);
    assert.match(recolored.text, /38;2;171;205;239/);
  } finally { restored.free(); term.wasmTerm.free(); ghostty.dispose(); }
});
