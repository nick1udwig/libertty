import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentumDecay, recordScrollSample, releaseVelocity, type ScrollSample } from '../src/scroll-momentum.ts';

test('release speed fits recent finger motion instead of trusting the last event', () => {
  const samples: ScrollSample[] = [];
  for (let at = 0; at <= 160; at += 16) recordScrollSample(samples, at * 2, at);
  recordScrollSample(samples, 326, 168);
  const velocity = releaseVelocity(samples, 190);
  assert.ok(velocity > 1.8 && velocity < 2.1, `A slowing final event keeps most of a 2 px/ms swipe: ${velocity}`);
  assert.ok(samples.every(sample => 168 - sample.at <= 100), 'Old samples are discarded');
});

test('a pause or a single sample releases without momentum', () => {
  const samples: ScrollSample[] = [];
  for (let at = 0; at <= 48; at += 16) recordScrollSample(samples, at * 2, at);
  assert.ok(releaseVelocity(samples, 80) > 1.9, 'A brief gap before lifting keeps the fling');
  assert.equal(releaseVelocity(samples, 90), 0, 'A finger that rested before lifting does not fling');
  assert.equal(releaseVelocity([{ y: 10, at: 0 }], 0), 0);
  assert.equal(releaseVelocity([{ y: 10, at: 0 }, { y: 20, at: 0.1 }], 0.1), 1.25, 'Coalesced events count as eight milliseconds apart');
  assert.equal(releaseVelocity([{ y: 0, at: 0 }, { y: 400, at: 10 }], 10), 8, 'A coalesced jump cannot fling through all history');
});

test('momentum glides about as far as iOS normal deceleration', () => {
  let velocity = 2, distance = 0;
  for (let frame = 0; frame < 600 && velocity > .03; frame++) { distance += velocity * 16; velocity *= Math.exp(-16 / momentumDecay); }
  assert.ok(distance > 900 && distance < 1100, `A 2 px/ms fling travels about one thousand pixels: ${distance}`);
});
