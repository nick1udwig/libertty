import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalHistory } from '../src/terminal-history.ts';

test('history edits reconstruct rolling ANSI and Unicode without losing unchanged suffixes', () => {
  const history = new TerminalHistory(() => assert.fail('A contiguous edit needs no baseline'));
  assert.equal(history.receive({ type: 'screen', version: 1, text: 'old\n界😀\x1b[32m stable' }), 'old\n界😀\x1b[32m stable');
  assert.equal(history.receive({ type: 'screen-delta', base: 1, version: 2, drop: 4, from: 3, tail: 0, text: '\x1b[32m stable\nnew' }), '界😀\x1b[32m stable\nnew');
  assert.equal(history.receive({ type: 'screen-delta', base: 2, version: 3, drop: 0, from: 8, tail: 4, text: 'changed' }), '界😀\x1b[32mchanged\nnew');
});
test('gaps and invalid offsets request one baseline before accepting more edits', () => {
  let requests = 0;
  const history = new TerminalHistory(() => requests++);
  const delta = { type: 'screen-delta' as const, base: 1, version: 2, drop: 0, from: 0, tail: 0, text: 'next' };
  assert.equal(history.receive(delta), undefined);
  assert.equal(history.receive(delta), undefined);
  assert.equal(requests, 1);
  history.receive({ type: 'screen', version: 1, text: 'baseline' });
  assert.equal(history.receive({ ...delta, from: 99 }), undefined);
  assert.equal(requests, 2);
  history.receive({ type: 'screen', version: 3, text: 'latest' });
  assert.equal(history.receive({ ...delta, base: 3, version: 4, from: 6, text: ' appended' }), 'latest appended');
  history.reset();
  assert.equal(history.receive(delta), undefined);
  assert.equal(requests, 3);
  assert.equal(history.receive({ type: 'screen', text: 'legacy' }), 'legacy');
});
