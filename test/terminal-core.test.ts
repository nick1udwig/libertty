import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ghostty, GhosttyTerminal } from '../src/terminal-core.ts';
import { createTerminalBuffer } from '../src/terminal-buffer.ts';

const ghostty = await Ghostty.load({
  wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
  callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
});
after(() => ghostty.dispose());

test('headless cells preserve Unicode widths, combining marks, attributes and default backgrounds', () => {
  const terminal = ghostty.createTerminal(12, 3, { theme: { foreground: '#abcdef', background: '#123456' } });
  try {
    terminal.write('e\u0301界😀\x1b[1;2;3;4;5;7;8;9;38;2;1;2;3;48;2;4;5;6mA\x1b[0m');
    const cells = terminal.getViewport();
    assert.equal(terminal.getGraphemeString(0, 0), 'e\u0301');
    assert.equal(cells[0].text, 'e\u0301');
    assert.deepEqual(cells.slice(0, 6).map(cell => cell.width), ['narrow', 'wide', 'spacer-tail', 'wide', 'spacer-tail', 'narrow']);
    assert.equal(cells[3].text, '😀');
    assert.ok(['bold', 'faint', 'italic', 'blink', 'inverse', 'invisible', 'strikethrough', 'underline'].every(key => Reflect.get(cells[5].style, key)));
    assert.deepEqual(cells[5].foregroundSource, { mode: 'rgb', value: { r: 1, g: 2, b: 3 } });
    assert.deepEqual(cells[5].backgroundSource, { mode: 'rgb', value: { r: 4, g: 5, b: 6 } });
    assert.deepEqual(cells[6].backgroundSource, { mode: 'default' });
    assert.deepEqual(terminal.getCursor(), { x: 6, y: 0, visible: true });
    terminal.write('\x1b[?25l');
    assert.equal(terminal.getCursor().visible, false);
  } finally { terminal.free(); }
});

test('history, hyperlinks and wrapped rows remain addressable while the viewport is scrolled', () => {
  const terminal = ghostty.createTerminal(8, 3, { scrollbackLimit: 50 });
  try {
    terminal.write('\x1b]8;;https://example.com\x07abcdefghijk\x1b]8;;\x07\r\nsecond\r\nthird\r\nfourth');
    assert.equal(terminal.getScrollbackLength(), 2);
    assert.equal(terminal.getBufferRow(1)?.wrapContinuation, true);
    assert.equal(terminal.getBufferRow(2)?.wrapContinuation, false);
    assert.equal(terminal.getScrollbackHyperlinkUri(0, 0), 'https://example.com');
    assert.equal(terminal.getScrollbackHyperlinkUri(1, 2), 'https://example.com');
    assert.equal(terminal.getScrollbackLine(0)?.[0].hyperlink, true);
    assert.equal(terminal.getHyperlinkUri(0, 0), null);
    const cells = terminal.getViewport(), cursor = terminal.getCursor();
    terminal.setViewportY(2);
    assert.equal(terminal.getViewportY(), 2);
    assert.equal(terminal.core.viewport().viewportRows[0].text.trimEnd(), 'abcdefgh');
    assert.deepEqual(terminal.getViewport(), cells);
    assert.deepEqual(terminal.getCursor(), cursor);
    terminal.setViewportY(0);
    assert.equal(terminal.getViewportY(), 0);
    assert.equal(terminal.getLine(-1), undefined);
    assert.equal(terminal.getScrollbackLine(2), undefined);
  } finally { terminal.free(); }
});

test('adopted terminals detect direct writes, screen switches and resize without reparsing', () => {
  const core = ghostty.core.createTerminal({ cols: 10, rows: 3 });
  let writes = 0;
  const terminal = new GhosttyTerminal(core, () => writes++);
  try {
    terminal.write('normal\r\nrow2\r\nrow3\r\nrow4');
    assert.equal(writes, 1);
    assert.equal(terminal.getScrollbackLength(), 1);
    assert.equal(terminal.getLine(0)?.[0].text, 'r');
    core.write('\x1b[?1049h\x1b[Halternate');
    assert.equal(terminal.isAlternateScreen(), true);
    assert.equal(terminal.getScrollbackLength(), 0);
    assert.equal(terminal.getLine(0)?.[0].text, 'a');
    core.write('\x1b[?1049l');
    assert.equal(terminal.isAlternateScreen(), false);
    assert.equal(terminal.getScrollbackLength(), 1);
    core.write('\x1b[6n');
    assert.equal(terminal.readResponse(), undefined);
    terminal.resize(5, 4);
    assert.equal(writes, 2);
    assert.equal(terminal.cols, 5);
    assert.equal(terminal.rows, 4);
    assert.equal(terminal.getViewport().length, 20);
  } finally { terminal.free(); terminal.free(); }
  assert.throws(() => core.write('disposed'), /disposed/i);
});

test('mode queries and response queues stay synchronous and exclude keyboard input', () => {
  const terminal = ghostty.createTerminal(20, 6);
  try {
    terminal.write('\x1b[?2004h\x1b[?1h\x1b[3;4H\x1b[6n');
    assert.equal(terminal.isMode(2004), true);
    assert.equal(terminal.isMode(1), true);
    assert.equal(new TextDecoder().decode(terminal.readResponse()), '\x1b[3;4R');
    assert.equal(terminal.readResponse(), undefined);
    terminal.core.text('typed');
    assert.equal(terminal.readResponse(), undefined);
    terminal.write('\x1bc');
    assert.equal(terminal.isMode(2004), false);
  } finally { terminal.free(); }
});

test('snapshot reads leave the pending browser frame dirty', () => {
  const terminal = ghostty.createTerminal(10, 3);
  try {
    terminal.core.render();
    terminal.write('pending');
    terminal.update();
    terminal.getColors();
    terminal.getViewport();
    terminal.getCursor();
    assert.notEqual(terminal.core.render().dirty, 'clean');
  } finally { terminal.free(); }
});

test('buffer access uses terminal columns and preserves blank cells, wide glyphs and wrap flags', () => {
  const terminal = ghostty.createTerminal(6, 3);
  const buffer = createTerminalBuffer(() => terminal).active;
  try {
    terminal.write('e\u0301界😀ab\r\nlast\r\nend');
    assert.equal(buffer.length, 4);
    assert.equal(buffer.baseY, 1);
    assert.equal(buffer.cursorX, 3);
    assert.equal(buffer.cursorY, 2);
    const line = buffer.getLine(0)!;
    assert.equal(line.length, 6);
    assert.equal(line.translateToString(), 'e\u0301界😀a');
    assert.equal(line.translateToString(false, 1, 3), '界');
    assert.equal(line.getCell(2)?.getWidth(), 0);
    assert.equal(line.getCell(3)?.getCodepoint(), 0x1f600);
    assert.equal(buffer.getLine(1)?.isWrapped, true);
    assert.equal(buffer.getLine(2)?.isWrapped, false);
    assert.equal(buffer.getLine(2)?.translateToString(), 'last  ');
    assert.equal(buffer.getLine(2)?.translateToString(true), 'last');
    terminal.setViewportY(1);
    assert.equal(buffer.viewportY, 0);
  } finally { terminal.free(); }
});

test('projection terminals inherit the browser theme and permit per-terminal overrides', () => {
  const runtime = new Ghostty(ghostty.core, { theme: { foreground: '#112233', background: '#fafafa' }, scrollbackLines: 50 });
  const inherited = runtime.createTerminal(5, 2), overridden = runtime.createTerminal(5, 2, { theme: { foreground: '#abcdef' } });
  try {
    assert.deepEqual([inherited.getColors().foreground.r, inherited.getColors().foreground.g, inherited.getColors().foreground.b], [17, 34, 51]);
    assert.deepEqual([overridden.getColors().foreground.r, overridden.getColors().foreground.g, overridden.getColors().foreground.b], [171, 205, 239]);
  } finally { inherited.free(); overridden.free(); }
});

test('walking long scrollback keeps retained row copies bounded', () => {
  const terminal = ghostty.createTerminal(10, 3, { scrollbackLimit: 1000 });
  try {
    terminal.write(Array.from({ length: 500 }, (_, row) => 'row ' + row).join('\r\n'));
    for (let row = 0; row < terminal.getScrollbackLength(); row++) assert.equal(terminal.getBufferRow(row)?.text, 'row ' + row);
    assert.ok(Reflect.get(terminal, 'bufferRows').size <= 128);
    assert.equal(terminal.getBufferRow(0)?.text, 'row 0');
    assert.equal(terminal.getBufferRow(499)?.text, 'row 499');
  } finally { terminal.free(); }
});
