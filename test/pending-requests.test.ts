import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests } from '../src/pending-requests.ts';

test('completion removes cancellation listeners and late replies cannot settle new work', async () => {
  const pending = new PendingRequests<number>();
  const controller = new AbortController();
  let cancelled = 0;
  const result = pending.start('one', () => -1, { signal: controller.signal, cancel: () => cancelled++ });
  pending.complete('one', 42);
  controller.abort();
  assert.equal(await result, 42);
  assert.equal(cancelled, 0);
  assert.equal(pending.size, 0);
  pending.complete('one', 0);
});
test('abort, deadlines and disconnect settle work and release all entries', async () => {
  const pending = new PendingRequests<number>();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await pending.start('aborted', () => -1, { signal: controller.signal }), -1);
  assert.equal(await pending.start('timeout', () => -2, { timeout: 1 }), -2);
  const first = pending.start('first', () => 1);
  const second = pending.start('second', () => 2);
  assert.throws(() => pending.start('first', () => 3));
  pending.clear();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(pending.size, 0);
});
