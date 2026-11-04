import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SynchronizedOutput, synchronizedLimit } from '../src/synchronized-output.ts';

test('paints wait for an open synchronized update until it ends or its limit passes', () => {
  let now = 0;
  const output = new SynchronizedOutput(() => now);
  assert.equal(output.hold(false), false, 'Output without an update paints at once');
  assert.equal(output.hold(true), true);
  now = synchronizedLimit - 1;
  assert.equal(output.hold(true), true, 'A long update still holds before its limit');
  now = synchronizedLimit;
  assert.equal(output.hold(true), false, 'An update that never ends paints at its limit');
  now += 10;
  assert.equal(output.hold(true), false, 'The expired update keeps painting');
  assert.equal(output.hold(false), false);
  now += 10;
  assert.equal(output.hold(true), true, 'A later update holds for its own limit');
});
