import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortableDelay } from '../src/abortable-delay.ts';

test('completed retry delays release listeners and later cancellation has no effect', async () => {
  const controller = new AbortController();
  for (let attempt = 0; attempt < 20; attempt++) await abortableDelay(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
});
test('cancellation before and during a delay rejects and releases listeners', async () => {
  const controller = new AbortController(), reason = new Error('Cancelled');
  const waiting = abortableDelay(60000, controller.signal);
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(abortableDelay(60000, controller.signal), error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
