import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationDelivery, type DeliveryClock } from '../src/dictation-delivery.ts';

function fixture() {
  const pending = new Map<() => void, number>();
  const errors: string[] = [];
  const clock: DeliveryClock = { after(delay, callback) {
    pending.set(callback, delay);
    return () => { pending.delete(callback); };
  } };
  const delivery = new DictationDelivery(message => { errors.push(message); delivery.retain(); }, clock);
  return { delivery, pending, errors, fire(delay: number) {
    for (const [callback, duration] of [...pending]) if (duration === delay) { pending.delete(callback); callback(); }
  } };
}

test('retention rejects late readiness and completion and invalidates queued callbacks', () => {
  const { delivery, pending, errors } = fixture();
  delivery.connect(true);
  const staleReady = [...pending.keys()][0];
  assert.equal(delivery.ready(), true);
  let uploads = 0;
  delivery.uploadLater(() => uploads++);
  const staleUpload = [...pending.keys()][0];
  delivery.completing();
  delivery.retain();
  assert.equal(delivery.ready(), false);
  assert.equal(delivery.acceptsResult(), false);
  staleReady(); staleUpload();
  assert.equal(uploads, 0);
  assert.deepEqual(errors, []);
  assert.equal(pending.size, 0);
});

test('each retry owns a fresh completion deadline', () => {
  const { delivery, pending, errors, fire } = fixture();
  for (let attempt = 0; attempt < 3; attempt++) {
    delivery.connect(true);
    delivery.completing();
    assert.equal(delivery.ready(), true);
    delivery.uploaded();
    assert.equal(delivery.acceptsResult(), true);
    assert.deepEqual([...pending.values()], [480000]);
    fire(480000);
    assert.equal(delivery.state, 'retained');
  }
  assert.equal(errors.length, 3);
});

test('reconnect preserves the completion deadline and waits for a new checkpoint', () => {
  const { delivery, pending, fire, errors } = fixture();
  delivery.connect(true); delivery.ready(); delivery.completing();
  const deadline = [...pending.keys()][0];
  delivery.disconnect();
  assert.equal(delivery.ready(), false);
  delivery.connect(true);
  assert.equal(pending.has(deadline), true);
  assert.equal(delivery.ready(true), true);
  assert.equal(delivery.acceptsResult(), true);
  delivery.cancel();
  fire(480000); deadline();
  assert.deepEqual(errors, []);
  assert.equal(pending.size, 0);
});

test('failed startup and finish sends remain retryable and cancellation clears all timers', () => {
  const { delivery, pending, fire } = fixture();
  delivery.connect(false);
  assert.equal(delivery.state, 'offline');
  assert.equal(pending.size, 0);
  delivery.connect(true); delivery.ready();
  let attempts = 0;
  const upload = () => { if (++attempts < 2) delivery.uploadLater(upload); else delivery.uploaded(); };
  upload(); fire(10);
  assert.equal(attempts, 2);
  assert.equal(delivery.ready(), false);
  assert.equal(delivery.state, 'awaiting-result');
  delivery.cancel();
  assert.equal(delivery.state, 'idle');
});
