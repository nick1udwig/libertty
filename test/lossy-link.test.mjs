import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkSchedule, LOSSY_PROFILE } from './support/lossy-link.mjs';

test('lossy pacing retains ordered bytes, counts retransmissions, and applies one outage per request', () => {
  const link = new LinkSchedule({ ...LOSSY_PROFILE, lossEvery: 2, stallEvery: 2 });
  link.request('typing');
  const first = link.write(10, 0), second = link.write(1460, 0);
  assert.ok(second > first + 200); assert.equal(link.losses, 1);
  link.request('typing');
  const stalled = link.write(10, second);
  assert.ok(stalled >= second + 700); assert.equal(link.stalls, 1);
  assert.ok(link.write(10, second) >= stalled); assert.equal(link.stalls, 1);
  link.request('logs'); assert.equal(link.requests, 1); assert.equal(link.packets, 0);
});
test('ordinary pacing retains the existing bandwidth and round-trip schedule', () => {
  const link = new LinkSchedule({ rtt: 150, mbps: 1 }); link.request('logs');
  assert.equal(link.write(1000, 100), 183);
  assert.equal(link.write(1000, 100), 191);
  assert.equal(link.losses, 0); assert.equal(link.stalls, 0);
});
