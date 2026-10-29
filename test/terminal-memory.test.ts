import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ghostty } from '../src/terminal-core.ts';

test('memory diagnostics count every runtime terminal once without consuming render state', async () => {
  const ghostty = await Ghostty.load({
    wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
    callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
  });
  const first = ghostty.createTerminal(80, 24, { scrollbackLimit: 5000 });
  const second = ghostty.core.createTerminal({ cols: 80, rows: 24 });
  try {
    const empty = ghostty.memoryUsage();
    assert.equal(empty.terminals.length, 2);
    first.write('long history row\r\n'.repeat(4000));
    second.write('\x1b[?1049hfull screen');
    const used = ghostty.memoryUsage();
    assert.ok(used.retainedBytes > empty.retainedBytes);
    assert.ok(used.wasmCapacityBytes >= used.retainedBytes);
    assert.equal(used.retainedBytes, used.terminals.reduce((sum, item) => sum + item.primaryBytes + item.alternateBytes + item.imageBytes, 0));
    assert.equal(used.terminals.find(item => item.id === second.id)!.compressionSupported, false);
    assert.ok(used.terminals.find(item => item.id === second.id)!.alternateBytes > 0);
    assert.equal(second.render().dirty, 'full');
    second.dispose();
    const freed = ghostty.memoryUsage();
    assert.equal(freed.terminals.length, 1);
    assert.ok(freed.retainedBytes < used.retainedBytes);
    assert.ok(freed.wasmCapacityBytes >= used.wasmCapacityBytes);
  } finally { first.free(); ghostty.dispose(); }
});
