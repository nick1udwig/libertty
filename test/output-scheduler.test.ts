import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputScheduler, type OutputClock } from '../src/output-scheduler.ts';

function fixture(immediate = false) {
  let now = 0, next = 0, visible = true;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, delay: number) => { const id = ++next; jobs.set(id, { at: now + delay, callback }); return id; };
  const clock: OutputClock = { now: () => now, frame: callback => schedule(callback, 16), cancelFrame: id => { jobs.delete(id); }, timer: schedule, cancelTimer: id => { jobs.delete(id); } };
  const flushes: number[] = [], scheduler = new OutputScheduler(() => flushes.push(now), () => visible, immediate, clock);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; jobs.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  return { scheduler, flushes, advance, jobs, hide: () => { visible = false; scheduler.cancel(); }, show: () => { visible = true; scheduler.activity(); } };
}

test('passive streaming coalesces updates and leaves no recurring work after output stops', () => {
  const f = fixture(); f.advance(6000);
  for (let i = 0; i < 125; i++) { f.scheduler.request(); f.advance(8); }
  assert.ok(f.flushes.length >= 15 && f.flushes.length <= 20, 'Passive output stays between 15 and 20 paints per second');
  f.advance(100); const count = f.flushes.length;
  f.advance(60000);
  assert.equal(f.flushes.length, count);
  assert.equal(f.jobs.size, 0);
});

test('interaction advances queued output to the next frame and hidden views cancel it', () => {
  const f = fixture(); f.advance(6000); f.scheduler.request(); f.advance(16);
  f.scheduler.request(); f.advance(5); f.scheduler.activity(); f.advance(16);
  assert.equal(f.flushes.length, 2, 'Input bypasses the passive delay');
  f.scheduler.request(); f.hide(); f.advance(1000);
  assert.equal(f.flushes.length, 2);
  f.scheduler.request(); assert.equal(f.jobs.size, 0);
  f.show(); f.scheduler.request(); f.advance(16);
  assert.equal(f.flushes.length, 3);
});

test('interactive frame parsing stays synchronous and activity flushes pending passive frames', () => {
  const f = fixture(true); f.scheduler.request();
  assert.equal(f.flushes.length, 1);
  f.advance(6000); f.scheduler.request(); f.advance(16);
  f.scheduler.request(); f.scheduler.activity();
  assert.equal(f.flushes.length, 3, 'Pending terminal frames are parsed before interactive input continues');
  f.advance(100); assert.equal(f.flushes.length, 3);
});
