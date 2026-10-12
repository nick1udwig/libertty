import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictationTarget } from '../src/protocol.ts';

test('only a Bash prompt or a marked foreground program accepts dictation', () => {
  const state = { cwd: '/tmp', prompt: 1, inputRevision: 0, promptRevision: 0, ready: false, exited: false };
  assert.equal(dictationTarget(state), undefined);
  assert.equal(dictationTarget({ ...state, ready: true }), 'shell');
  assert.equal(dictationTarget({ ...state, inputTarget: 'program' }), 'program');
  assert.equal(dictationTarget({ ...state, inputTarget: 'program', exited: true }), undefined);
});
