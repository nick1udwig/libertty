import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentInput, UnsentInput, sameInputContext, type InputContext } from '../src/unsent-input.ts';
const context: InputContext = { session: 'host:terminal', connection: 1, prompt: 2, revision: 4, target: 'shell', stream: 'stream-1' };
test('unsent keys survive repeated disconnects and leave the queue exactly once', () => {
  const queue = new UnsentInput();
  assert.equal(queue.add('echo ', context), true);
  assert.equal(queue.add('saved\r', { ...context, connection: 2 }), true);
  assert.deepEqual(queue.take({ ...context, connection: 3 }), ['echo ', 'saved\r']);
  assert.equal(queue.length, 0);
  assert.equal(queue.take(context), undefined);
});
test('queued input rejects another stream, prompt, revision, backend or input target', () => {
  for (const patch of [{ stream: 'new' }, { prompt: 3 }, { revision: 5 }, { session: 'other' }, { target: 'program' as const }]) {
    const queue = new UnsentInput(); queue.add('never resend\r', context);
    assert.equal(queue.take({ ...context, ...patch }), undefined);
  }
  const queue = new UnsentInput();
  assert.equal(queue.add('x'), false);
  assert.equal(queue.add('x'.repeat(65536), context), true);
  assert.equal(queue.add('overflow', context), false);
});
test('Herdr reconnects require the same process and shell picture while retaining per-connection edit guards', () => {
  const before: InputContext = { ...context, stream: undefined, identity: 'shell:process', picture: 'prompt and current line' };
  const resumed = { ...before, connection: 2, prompt: 1, revision: 0 };
  assert.equal(sameInputContext(before, resumed), true);
  assert.equal(sameInputContext(before, { ...resumed, picture: 'another prompt' }), false);
  assert.equal(sameInputContext(before, { ...resumed, identity: 'another process' }), false);
  assert.equal(sameInputContext(before, { ...before, revision: 5 }), false);
  assert.equal(sameInputContext({ ...before, target: 'program' }, { ...resumed, target: 'program', picture: 'animated output' }), true);
});
test('numbered keys resend only what the backend did not deliver, ahead of later unsent keys', () => {
  const sent = new SentInput();
  for (const [seq, data] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) sent.add(seq, data, { ...context, revision: 4 + seq });
  assert.deepEqual(sent.settle(1), { data: ['b', 'c'], context: { ...context, revision: 6 }, complete: true });
  assert.equal(sent.settle(1), undefined, 'Settling consumes the retained keys');
  const queue = new UnsentInput(); queue.add('d', { ...context, revision: 9 });
  assert.equal(queue.prepend(['b', 'c'], { ...context, revision: 6 }), true);
  assert.deepEqual(queue.take({ ...context, revision: 6 }), ['b', 'c', 'd']);
  assert.equal(queue.prepend(['lost']), false, 'Keys without a context are never resent');
  for (const delivered of [4, undefined]) { sent.add(4, 'e', context); assert.equal(sent.settle(delivered), undefined); }
  // Keys dropped to bound memory cannot be resent, so a backend missing them reports an incomplete delivery.
  sent.add(5, 'x'.repeat(65536), context); sent.add(6, 'f', context);
  assert.equal(sent.settle(4)?.complete, false);
  sent.add(7, 'x'.repeat(65536), context); sent.add(8, 'g', context);
  assert.deepEqual(sent.settle(7)?.data, ['g']);
});
