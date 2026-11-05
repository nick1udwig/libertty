import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Terminal } from '../src/terminal-adapter.ts';
import { Ghostty } from '../src/terminal-core.ts';
import { TerminalReplay } from '../src/terminal-replay.ts';
import { createRetainedOutput } from '../src/retained-output.ts';

test('retained output owns replay transitions, cancellation and late cache restoration', async (t) => {
  const ghostty = await Ghostty.load({
    wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
    callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const term = new Terminal({ cols: 20, rows: 4 });
  term.wasmTerm = ghostty.createTerminal(20, 4);
  const globals = ['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { hidden: false }) });
  try {
    const replay = new TerminalReplay();
    let historySignal: AbortSignal | undefined;
    const host = {
      term, replay,
      lifecycle: { synchronized: true, streamStarted: false },
      transport: { backgroundDelay: 10 }, visibility: { visible: true, parked: false },
      gestures: { clear() {}, text: '' }, state: { ready: true },
      presentation: { pending: false, wait() {}, freeze() {} }, herdrLayout: { uncover() {} },
      presentedAt: 0, herdrPresentation: '', cacheKey: 'test', lastOutputAt: 0, herdrTerminal: false, herdrCore: false,
      updateRun() {}, connection() {}, ready() {}, rendered() {},
      history(signal: AbortSignal) { historySignal = signal; return new Promise(() => {}); },
    } as unknown as Parameters<typeof createRetainedOutput>[0];
    const saved = {
      key: 'test', version: 2 as const, updated: Date.now(), stream: 'one',
      records: [{ id: 1, at: Date.now(), kind: 'history' as const, text: 'saved shell' }],
      picture: { last: 0, x: 0, y: 0, cursor: true }, position: 0,
    };
    const retained = createRetainedOutput(host, { async read() { return saved; }, async save() { return true; }, async clear() { return true; } });
    await retained.restore();
    assert.equal(retained.cachePainted, true);
    assert.equal(retained.changeStream('one'), false);
    retained.beginReplay(false);
    retained.appendNotice('notice');
    assert.equal(retained.handoff, '\x1bc\x1b[3Jnotice');
    replay.receive({ type: 'output', seq: 1, data: 'partial' });
    retained.disconnect();
    assert.equal(retained.handoff, undefined);
    assert.equal(replay.cursor, 0);
    assert.equal(retained.cachePainted, true);
    retained.beginReplay(false);
    retained.completeReplay();
    assert.equal(retained.cachePainted, false);
    retained.scheduleBackfill();
    t.mock.timers.tick(10);
    assert.ok(historySignal);
    retained.disconnect();
    assert.equal(historySignal.aborted, true);
    assert.equal(retained.changeStream('two'), true);
    await retained.restore();
    assert.equal(retained.cachePainted, false, 'cache from an old stream must not paint');
    retained.clear();
    retained.scheduleBackfill();
    historySignal = undefined;
    t.mock.timers.tick(100);
    assert.equal(historySignal, undefined);
  } finally {
    term.wasmTerm.free(); ghostty.dispose();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
