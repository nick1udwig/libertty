import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftTargetMatches, retainedDrafts } from '../src/terminal-draft.ts';
import type { InputContext } from '../src/unsent-input.ts';

const context: InputContext = { session: 'backend:session', connection: 1, prompt: 2, revision: 3, target: 'shell', stream: 'one' };
test('draft delivery requires the same stream, prompt, revision and observed Herdr shell', () => {
  assert.ok(draftTargetMatches(context, { ...context, connection: 2 }));
  for (const change of [{ stream: 'two' }, { prompt: 3 }, { revision: 4 }, { target: 'program' as const }, { session: 'other' }]) assert.equal(draftTargetMatches(context, { ...context, ...change }), false);
  assert.equal(draftTargetMatches(context, undefined), false);
  const herdr = { ...context, stream: undefined, identity: '1:2', picture: 'prompt' };
  assert.equal(draftTargetMatches(herdr, { ...herdr, picture: 'external edit' }), false);
  assert.ok(draftTargetMatches(herdr, { ...herdr, picture: undefined }, false), 'Status updates need no expensive screen extraction');
});
test('saved drafts retain Unicode and uncertain state within bounded retention', () => {
  const now = Date.now(), draft = { key: 'one', text: '界😀\nsecond line', context, updated: now, status: 'uncertain' };
  assert.deepEqual(retainedDrafts([draft], now), [draft]);
  assert.equal(retainedDrafts([{ ...draft, text: 'x'.repeat(16001) }, { ...draft, updated: now - 8 * 86400000 }, { ...draft, context: { prompt: 'invalid' } }], now).length, 0);
  assert.equal(retainedDrafts(Array.from({ length: 20 }, (_, i) => ({ ...draft, key: String(i), updated: now - i })), now).length, 16);
});
