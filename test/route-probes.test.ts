import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRoutes } from '../src/route-probes.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('route probes bound concurrency and preserve candidate order despite failures', async () => {
  const gates = Array.from({ length: 6 }, () => deferred<number>());
  let active = 0, maximum = 0;
  const started: number[] = [];
  const work = probeRoutes([0, 1, 2, 3, 4, 5], async index => {
    started.push(index); maximum = Math.max(maximum, ++active);
    try {
      const result = await gates[index].promise;
      if (index === 1) throw new Error('unreachable');
      return result;
    } finally { active--; }
  }, new AbortController().signal);
  assert.deepEqual(started, [0, 1, 2]);
  gates[2].resolve(2); gates[1].resolve(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  for (let i = 0; i < gates.length; i++) gates[i].resolve(i);
  assert.deepEqual(await work, [0, 2, 3, 4, 5]);
  assert.equal(maximum, 3);
});

test('cancellation aborts in-flight probes and never starts queued routes', async () => {
  const controller = new AbortController(), pending = deferred<number>();
  const signals: AbortSignal[] = [];
  const work = probeRoutes([0, 1, 2, 3], async (_, signal) => {
    signals.push(signal);
    return pending.promise;
  }, controller.signal);
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(signals.length, 3);
  assert(signals.every(signal => signal.aborted));
  pending.resolve(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 3);
});

test('the deadline returns completed measurements without waiting for an unresponsive route', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<number>();
  let signal!: AbortSignal;
  const work = probeRoutes([0, 1], async (candidate, stop) => {
    signal = stop;
    return candidate === 0 ? 42 : pending.promise;
  }, new AbortController().signal);
  await Promise.resolve();
  t.mock.timers.tick(8000);
  const results = await work;
  assert.deepEqual(results, [42]);
  assert.equal(signal.aborted, true);
  pending.resolve(43);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(results, [42]);
});
