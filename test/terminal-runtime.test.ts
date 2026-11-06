import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCoreRuntime } from '../src/terminal-runtime.ts';
const runtime = await createCoreRuntime({
  wasm: await readFile(new URL('../src/generated/terminal.wasm', import.meta.url)),
});
after(() => runtime.dispose());
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
test('browser loading tolerates a missing WASM MIME type and shares compilation without sharing state', async () => {
  const original = globalThis.fetch;
  const bytes = await readFile(new URL('../src/generated/terminal.wasm', import.meta.url));
  let downloads = 0;
  globalThis.fetch = async () => {
    downloads++;
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
  };
  const instances: Awaited<ReturnType<typeof createCoreRuntime>>[] = [];
  try {
    instances.push(await createCoreRuntime(), await createCoreRuntime());
    const first = instances[0].createTerminal(),
      second = instances[1].createTerminal();
    first.write('isolated');
    assert.equal(downloads, 1);
    assert.equal(first.readBuffer().rows[0].text, 'isolated');
    assert.equal(second.readBuffer().rows[0].text, '');
    assert.notEqual(instances[0].exports.memory, instances[1].exports.memory);
  } finally {
    globalThis.fetch = original;
    for (const instance of instances) instance.dispose();
  }
});
test('line-limited scrollback retains Unicode history beyond the default native byte limit', () => {
  const terminal = runtime.createTerminal({ cols: 80, rows: 24, scrollbackLines: 5000 });
  const disabled = runtime.createTerminal({ cols: 80, rows: 24, scrollbackLines: 0 });
  try {
    const output = '\x1b[32mbuild output\x1b[0m e\u0301界😀\r\n'.repeat(5000);
    terminal.write(output);
    assert.equal(terminal.bufferState().totalRows, 5001);
    assert.equal(
      terminal.readBuffer({ start: 0, end: 1 }).rows[0].text,
      'build output e\u0301界😀',
    );
    disabled.write(output);
    assert.equal(disabled.bufferState().scrollbackRows, 0);
  } finally {
    terminal.dispose();
    disabled.dispose();
  }
});
test('native encoders follow terminal keyboard, mouse, focus and paste modes', () => {
  const t = runtime.createTerminal({ cols: 20, rows: 4 }),
    sent: { source: string; data: string }[] = [];
  t.on('input', (event) => sent.push({ source: event.source, data: decode(event.data) }));
  try {
    t.sendKey({ code: 'KeyC', key: 'c', ctrl: true });
    t.sendKey({ code: 'ArrowUp', key: 'ArrowUp' });
    t.write('\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[?2004h');
    t.sendKey({ code: 'ArrowUp', key: 'ArrowUp' });
    t.sendPointer({ action: 'press', x: 8, y: 16, button: 'left' });
    t.sendPointer({ action: 'release', x: 8, y: 16, button: 'left' });
    t.sendWheel({ action: 'press', x: 8, y: 16 }, -1);
    t.sendWheel({ action: 'press', x: 8, y: 16 }, 1);
    t.setFocused(true);
    t.setFocused(false);
    t.paste('a\nb');
    assert.deepEqual(sent, [
      { source: 'keyboard', data: '\x03' },
      { source: 'keyboard', data: '\x1b[A' },
      { source: 'keyboard', data: '\x1bOA' },
      { source: 'mouse', data: '\x1b[<0;2;2M' },
      { source: 'mouse', data: '\x1b[<0;2;2m' },
      { source: 'mouse', data: '\x1b[<64;2;2M' },
      { source: 'mouse', data: '\x1b[<65;2;2M' },
      { source: 'focus', data: '\x1b[I' },
      { source: 'focus', data: '\x1b[O' },
      { source: 'paste', data: '\x1b[200~a\nb\x1b[201~' },
    ]);
  } finally {
    t.dispose();
  }
});
test('native selection survives release, starts fresh on another press and marks rendered cells', () => {
  const t = runtime.createTerminal({ cols: 20, rows: 4 });
  try {
    t.write('hello world');
    t.sendPointer({ action: 'press', x: 0, y: 0, button: 'left', time: 100 });
    t.sendPointer({ action: 'motion', x: 40, y: 0, button: 'left', time: 110 });
    t.sendPointer({ action: 'release', x: 40, y: 0, button: 'left', time: 120 });
    assert.equal(t.getSelection(), 'hello');
    assert.deepEqual(t.viewport().viewportRows[0].selection, { start: 0, end: 5 });
    t.sendPointer({ action: 'press', x: 80, y: 16, button: 'left', time: 1000 });
    assert.equal(t.getSelection(), '');
    t.sendPointer({ action: 'release', x: 80, y: 16, button: 'left', time: 1010 });
    t.clearSelection();
    assert.equal(t.getSelection(), '');
  } finally {
    t.dispose();
  }
});
test('binary snapshots retain unfinished UTF-8 and escape sequences and reject corrupt data atomically', () => {
  for (const parts of [
    [new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80])],
    ['\x1b[38;2;1;', '2;3mA'],
  ] as const) {
    const t = runtime.createTerminal({ cols: 20, rows: 4 }),
      restored = runtime.createTerminal({ cols: 20, rows: 4 });
    try {
      t.write(parts[0]);
      restored.restore(t.snapshot());
      t.write(parts[1]);
      restored.write(parts[1]);
      assert.deepEqual(restored.readBuffer(), t.readBuffer());
      const before = restored.readBuffer();
      assert.throws(() => restored.restore(new Uint8Array([1, 2, 3])));
      assert.deepEqual(restored.readBuffer(), before);
    } finally {
      t.dispose();
      restored.dispose();
    }
  }
});
test('copied callback effects permit synchronous reply handling and terminal disposal', () => {
  const t = runtime.createTerminal({ cols: 20, rows: 4 });
  let reply = '';
  t.on('input', (event) => {
    reply = decode(event.data);
    t.write('handled');
  });
  t.write('\x1b[6n');
  assert.equal(reply, '\x1b[1;1R');
  assert.equal(t.readBuffer().rows[0].text, 'handled');
  t.dispose();
  t.dispose();
  assert.equal(runtime.terminals.has(t.id), false);
  assert.throws(() => t.render(), /disposed/);
});
test('reverse video swaps effective render colors and restores them when disabled', () => {
  const terminal = runtime.createTerminal({ theme: { foreground: '#123456', background: '#abcdef' } });
  const rgb = ({ r, g, b }: { r: number; g: number; b: number }) => [r, g, b];
  try {
    const initial = terminal.viewport().colors;
    terminal.write('hello\x1b[?5h');
    const reversed = terminal.render().colors;
    assert.deepEqual(rgb(reversed.foreground), rgb(initial.background));
    assert.deepEqual(rgb(reversed.background), rgb(initial.foreground));
    terminal.write('\x1b[?5l');
    const restored = terminal.render().colors;
    assert.deepEqual(rgb(restored.foreground), rgb(initial.foreground));
    assert.deepEqual(rgb(restored.background), rgb(initial.background));
  } finally {
    terminal.dispose();
  }
});
