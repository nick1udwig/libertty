import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ghostty, type Terminal } from 'ghostty-web';
import { TerminalProjection } from '../src/terminal-projection.ts';

const wasm = await WebAssembly.instantiate(await readFile(new URL('../node_modules/ghostty-web/ghostty-vt.wasm', import.meta.url)), { env: { log() {} } });
const ghostty = new Ghostty(wasm.instance);

test('incremental history matches full ANSI reconstruction through appends, edits, rolling history and reflow', () => {
  const display = ghostty.createTerminal(20, 6, { scrollbackLimit: 5000 });
  const native = ghostty.createTerminal(20, 6); native.write('\x1b[?25l');
  const reference = ghostty.createTerminal(20, 6, { scrollbackLimit: 5000 });
  let written = 0;
  const term = {
    cols: 20, rows: 6, wasmTerm: display, getViewportY: () => 0,
    buffer: { active: { type: 'normal' } },
    write(text: string) { written += text.length; display.write(text); },
  };
  const projection = new TerminalProjection(term as unknown as Terminal, ghostty);
  Object.assign(projection, { native });
  const check = (text: string) => {
    projection.update(text);
    reference.write('\x1bc\x1b[3J\x1b[2J\x1b[H\x1b[?25l' + text + '\x1b[?25l');
    display.update(); reference.update();
    assert.deepEqual(display.getViewport(), reference.getViewport());
    assert.equal(display.getScrollbackLength(), reference.getScrollbackLength());
    for (let row = 0; row < display.getScrollbackLength(); row++) assert.deepEqual(display.getScrollbackLine(row), reference.getScrollbackLine(row));
  };
  try {
    let text = Array.from({ length: 1000 }, (_, i) => '\x1b[32mline ' + i + ' 界😀\x1b[0m').join('\r\n');
    check(text);
    for (const suffix of [' more', '\r\nnext', '\r\ne\u0301', '\r\n' + 'wrapped '.repeat(9), '\r\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07']) {
      written = 0; text += suffix; check(text);
      assert.ok(written < suffix.length + 30, 'Appending output must not reparse the existing history');
    }
    check(text.replace('line 2 ', 'edited '));
    check(text.split('\r\n').slice(20).join('\r\n'));
    check('short');
    check('before\x1b[2Jafter');
    check('before\x1b[2Jafter appended');
    term.cols = 12; display.resize(12, 6); reference.resize(12, 6); projection.resize();
    check('resized 界😀\r\n' + 'wrap '.repeat(8));
  } finally { projection.dispose(); display.free(); reference.free(); }
});
