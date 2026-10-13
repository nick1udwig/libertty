import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyStatistics, latencyRegressed } from './architecture-stats.ts';

test('latency statistics preserve medians and conservative median confidence bounds', () => {
  assert.deepEqual(latencyStatistics(Array.from({ length: 31 }, (_, i) => i)), { median: 15, p95: 29, lower95: 9, upper95: 21 });
  const large = latencyStatistics(Array.from({ length: 4096 }, (_, i) => i));
  assert.equal(large.median, 2047.5);
  assert.ok(large.lower95 !== undefined && large.upper95 !== undefined);
  assert.ok(large.lower95 < large.median && large.upper95 > large.median);
  assert.equal(large.lower95 + large.upper95, 4095);
});

test('latency gates reject confirmed regressions and retain allowances', () => {
  const stable = (value: number) => latencyStatistics(Array(31).fill(value));
  assert.equal(latencyRegressed(stable(1.3), stable(1), 0.15), true);
  assert.equal(latencyRegressed(stable(1.19), stable(1), 0.15), false);
  assert.equal(latencyRegressed(stable(0.25), stable(0.1), 0.15), false);
  assert.equal(latencyRegressed(stable(0.26), stable(0.1), 0.15), true);
  const few = latencyStatistics([150, 151, 152]);
  assert.equal(few.lower95, undefined);
  assert.equal(latencyRegressed(latencyStatistics([190, 191, 192]), few, 0.15), true);
});

test('latency gates distinguish a borderline median from a confirmed regression', () => {
  const before = latencyStatistics([...Array(20).fill(0.91), ...Array(11).fill(0.96)]);
  const after = latencyStatistics([...Array(20).fill(1.10), ...Array(11).fill(1.14)]);
  assert.ok(after.median > before.median * 1.2);
  assert.equal(latencyRegressed(after, before, 0.15), false);
  assert.equal(latencyRegressed(latencyStatistics(Array(31).fill(1.4)), before, 0.15), true);
});

test('latency statistics reject invalid or missing measurements', () => {
  for (const samples of [[], [NaN], [Infinity], [-1]]) assert.throws(() => latencyStatistics(samples));
});
