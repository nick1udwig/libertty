import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal } from '../src/terminal-adapter.ts';

function scheduledTerminal() {
  const terminal = new Terminal({});
  const calls = { requests: 0, paints: 0, schedules: 0, mirrorWrites: 0, parsed: [] as (string | Uint8Array)[] };
  let pending = false;
  terminal.setRenderScheduler(() => calls.requests++);
  const pipeline = {
    scheduleRender() {
      calls.schedules++;
      if (!pending) {
        pending = true;
        Reflect.get(terminal, 'scheduleFrame').call(terminal, () => { pending = false; calls.paints++; });
      }
      return Promise.resolve();
    },
  };
  Reflect.set(terminal, 'backend', { pipeline });
  Reflect.set(terminal, 'wasmTerm', { write: () => calls.mirrorWrites++ });
  Reflect.set(terminal, 'view', { write(data: string | Uint8Array) { calls.parsed.push(data); void pipeline.scheduleRender(); } });
  return { terminal, calls };
}

test('an explicit idle repaint does not schedule another animation frame', () => {
  const { terminal, calls } = scheduledTerminal();
  terminal.renderNow();
  assert.equal(calls.paints, 1);
  assert.equal(calls.requests, 0);
  assert.equal(Reflect.get(terminal, 'pendingFrame'), undefined);
  terminal.renderNow();
  assert.equal(calls.paints, 2);
  assert.equal(calls.requests, 0);
});

test('pending output batches one paint and reaches the browser parser exactly once', () => {
  const { terminal, calls } = scheduledTerminal();
  const bytes = new Uint8Array([0xe7, 0x95, 0x8c]);
  let callbacks = 0;
  terminal.write('first');
  terminal.write(bytes, () => callbacks++);
  terminal.write('last');
  assert.deepEqual(calls.parsed, ['first', bytes, 'last']);
  assert.equal(calls.parsed[1], bytes);
  assert.equal(calls.mirrorWrites, 0);
  assert.equal(callbacks, 1);
  assert.equal(calls.requests, 1);
  assert.equal(calls.paints, 0);
  terminal.renderNow();
  assert.equal(calls.paints, 1);
  assert.equal(calls.requests, 1);
  assert.equal(calls.schedules, 3);
  assert.equal(Reflect.get(terminal, 'pendingFrame'), undefined);
});

test('headless writes remain synchronous before a browser view exists', () => {
  const terminal = new Terminal({});
  const writes: string[] = [];
  Reflect.set(terminal, 'wasmTerm', { write: (text: string) => writes.push(text) });
  terminal.write('headless', () => assert.deepEqual(writes, ['headless']));
  assert.deepEqual(writes, ['headless']);
});

test('full viewport frames transform the rows that the renderer consumes', () => {
  const terminal = new Terminal({});
  terminal.setRenderScheduler(() => {});
  terminal.setColorTransform((r, g, b) => [255 - r, 255 - g, 255 - b]);
  const row = { y: 0, cells: [{ foreground: { r: 1, g: 2, b: 3 }, background: null }] };
  const frame = { cursor: { visible: true, blinking: true }, viewportRows: [row], changedRows: [row] };
  const transformed = Reflect.get(terminal, 'transformFrame').call(terminal, frame);
  assert.deepEqual(transformed.viewportRows[0].cells[0].foreground, { r: 254, g: 253, b: 252 });
  assert.equal(transformed.cursor.blinking, false);
  assert.deepEqual(row.cells[0].foreground, { r: 1, g: 2, b: 3 });
});


test('scrolling preserves fractional positions and clears them after native scrolling', () => {
  const terminal = new Terminal({});
  let offset = 0;
  Reflect.set(terminal, 'wasmTerm', {
    getScrollbackLength: () => 100,
    getViewportY: () => offset,
    setViewportY: (value: number) => { offset = value; },
  });
  terminal.scrollLines(-5);
  assert.equal(terminal.getViewportY(), 5);
  terminal.scrollToLine(50.5);
  assert.equal(offset, 50);
  assert.equal(terminal.getViewportY(), 50.5);
  offset = 0;
  assert.equal(terminal.getViewportY(), 0);
  terminal.scrollToLine(200);
  assert.equal(terminal.getViewportY(), 100);
  terminal.scrollToBottom();
  assert.equal(terminal.getViewportY(), 0);
});


test('a retained baseline paints its own core even when browser focus needs a full repaint', () => {
  const terminal = new Terminal({});
  const frame = { cols: 80, rows: 24 };
  let painted: unknown;
  Reflect.set(terminal, 'fullFrame', true);
  Reflect.set(terminal, 'paintFrame', (value: unknown) => { painted = value; });
  terminal.renderCore({ core: { viewport: () => frame } } as Parameters<Terminal['renderCore']>[0]);
  assert.equal(painted, frame);
  assert.equal(Reflect.get(terminal, 'fullFrame'), true);
});
