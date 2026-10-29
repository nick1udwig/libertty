import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeTerminalSnapshot } from '../src/terminal-cache.ts';
import { Ghostty } from '../src/terminal-core.ts';
import { Terminal } from '../src/terminal-adapter.ts';
import { captureNativeSnapshot, restoreNativeSnapshot } from '../src/terminal-native-snapshot.ts';

const options = {
  wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
  callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
};
test('native snapshots restore modes, both screens, graphemes and scroll position without consuming paint', async () => {
  const ghostty = await Ghostty.load(options);
  const term = new Terminal({ cols: 20, rows: 4 });
  term.wasmTerm = ghostty.createTerminal(20, 4);
  try {
    term.write('history\r\n'.repeat(8) + '\x1b[?1049h\x1b[?2004h\x1b[4:3m界😀e\u0301\x1b[2;3H');
    const before = term.wasmTerm.getViewport(), cursor = term.wasmTerm.getCursor();
    const snapshot = captureNativeSnapshot(term)!;
    assert.ok(snapshot);
    term.write('\x1bcnew output');
    assert.equal(restoreNativeSnapshot(term, snapshot, 0), true);
    assert.equal(term.wasmTerm.isAlternateScreen(), true);
    assert.equal(term.wasmTerm.isMode(2004), true);
    assert.deepEqual(term.wasmTerm.getViewport(), before);
    assert.deepEqual(term.wasmTerm.getCursor(), cursor);
    assert.equal(term.wasmTerm.core.render().dirty, 'full');
    term.write('\x1b[?1049l');
    assert.ok(term.wasmTerm.getScrollbackLength() > 0);
    assert.equal(term.wasmTerm.getBufferRow(0)?.text, 'history');
    const normal = captureNativeSnapshot(term)!;
    term.write('\x1bc');
    assert.equal(restoreNativeSnapshot(term, normal, 2), true);
    assert.equal(term.getViewportY(), 2);
  } finally { term.wasmTerm.free(); ghostty.dispose(); }
});

test('incompatible, oversized or corrupt snapshots leave a text fallback possible', async () => {
  const ghostty = await Ghostty.load(options);
  const term = new Terminal({ cols: 20, rows: 4 });
  term.wasmTerm = ghostty.createTerminal(20, 4);
  try {
    term.write('live');
    const snapshot = captureNativeSnapshot(term)!;
    for (const invalid of [{ ...snapshot, build: 'a'.repeat(64) }, { ...snapshot, cols: 21 }, { ...snapshot, bytes: new Uint8Array([1, 2, 3]) }, { ...snapshot, bytes: new Uint8Array(2 * 1024 * 1024 + 1) }]) {
      assert.equal(restoreNativeSnapshot(term, invalid, 0), false);
      assert.equal(term.wasmTerm.getLine(0)?.[0].text, 'l');
    }
    assert.equal(nativeTerminalSnapshot({ ...snapshot, bytes: [1, 2] }), undefined);
    term.write('\x1bcfallback');
    assert.equal(term.wasmTerm.getLine(0)?.[0].text, 'f');
  } finally { term.wasmTerm.free(); ghostty.dispose(); }
});
