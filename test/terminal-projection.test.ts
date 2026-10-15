import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalProjection } from '../src/terminal-projection.ts';

test('mobile native resizing keeps stale polled history out of the visible application', () => {
  const writes: unknown[] = [], historyPaints: string[] = [];
  const term = { cols: 80, rows: 24, buffer: { active: { type: 'alternate' } }, write: (text: unknown) => writes.push(text) };
  const native = { cols: 80, rows: 24, write() {}, getCursor: () => ({ visible: false }), resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; } };
  const projection = Object.assign(Object.create(TerminalProjection.prototype), {
    term, native, mobile: true, live: true, initialized: true, complete: true, columns: 80, rows: 24,
    previous: 'old application', history: { getScrollbackLength: () => 0 },
    rebuild() {}, paint() { historyPaints.push(this.previous); }, cursor() {},
  });
  term.rows = 27; projection.resize(true);
  projection.update('stale poll during the first resize');
  term.rows = 26; projection.resize(true);
  projection.update('stale poll during a reversed toggle');
  projection.frame({ width: 80, height: 27, full: true, bytes: new Uint8Array([65]) });
  assert.deepEqual(writes, [], 'An obsolete native size cannot repaint the terminal');
  assert.deepEqual(historyPaints, [], 'Neither resize nor delayed history may restore the old layout');
  projection.frame({ width: 80, height: 26, full: true, bytes: new Uint8Array([66]) });
  assert.deepEqual(writes.at(-1), new Uint8Array([66]), 'The matching native baseline restores live rendering');
  projection.update('a delayed history read after the native redraw');
  assert.deepEqual(historyPaints, [], 'Polled history cannot replace the resized live application');
});

test('live native screens defer history parsing until the projection is needed', () => {
  let rebuilds = 0;
  const paints: string[] = [];
  const projection = Object.assign(Object.create(TerminalProjection.prototype), {
    term: { cols: 40, rows: 5 }, native: { cols: 40, rows: 5 }, mobile: true, live: true,
    initialized: true, complete: true, columns: 40, rows: 5,
    history: { getScrollbackLength: () => 0 }, previous: 'before', historyDirty: false,
    rebuild() { rebuilds++; this.historyDirty = false; }, paint() { paints.push(this.previous); },
  });
  projection.update('live 界😀');
  projection.update('new live 界😀');
  assert.equal(rebuilds, 0, 'Native animation needs no history parser');
  projection.resize(false);
  assert.equal(rebuilds, 1);
  assert.deepEqual(paints, ['new live 界😀']);
  projection.mobile = true; projection.live = true;
  projection.update('line\n'.repeat(20));
  assert.equal(rebuilds, 2, 'Growing scrollback must be detected even while native frames are live');
});
