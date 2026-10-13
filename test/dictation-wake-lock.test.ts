import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationWakeLock } from '../src/dictation-wake-lock.ts';

class ScreenLock extends EventTarget {
  released = false;
  async release() { this.released = true; this.dispatchEvent(new Event('release')); }
}
class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('wake lock survives capture and reacquires after visibility restoration', async () => {
  const document = new Visibility(), locks: ScreenLock[] = [], notices: string[] = [];
  const control = new DictationWakeLock({ document, navigator: { wakeLock: { async request(type) { assert.equal(type, 'screen'); const lock = new ScreenLock(); locks.push(lock); return lock; } } } }, message => notices.push(message));
  control.start(); await tick(); assert.equal(locks.length, 1);
  document.change(true); await locks[0].release(); await tick();
  assert.equal(notices.length, 0, 'Normal hidden-document release is expected');
  document.change(false); await tick(); assert.equal(locks.length, 2);
  control.stop(); await tick(); assert.equal(locks[1].released, true);
  document.change(false); await tick(); assert.equal(locks.length, 2, 'Finished recording never reacquires');
  control.dispose();
});

test('pending acquisition is released after cancellation, teardown, or hiding', async () => {
  for (const end of ['stop', 'dispose', 'hidden'] as const) {
    const document = new Visibility(), lock = new ScreenLock(); let resolve!: (lock: ScreenLock) => void;
    const control = new DictationWakeLock({ document, navigator: { wakeLock: { request: () => new Promise(done => { resolve = done; }) } } }, () => {});
    control.start(); if (end === 'hidden') document.change(true); else control[end]();
    resolve(lock); await tick(); assert.equal(lock.released, true, end); control.dispose();
  }
});

test('a new recording waits for and releases a stale acquisition before acquiring its own', async () => {
  const document = new Visibility(), stale = new ScreenLock(), current = new ScreenLock();
  let requests = 0, resolve!: (lock: ScreenLock) => void;
  const control = new DictationWakeLock({ document, navigator: { wakeLock: { request: () => ++requests === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(current) } } }, () => {});
  control.start(); control.stop(); control.start(); resolve(stale); await tick();
  assert.equal(stale.released, true); assert.equal(requests, 2); assert.equal(current.released, false);
  control.dispose(); await tick(); assert.equal(current.released, true);
});

test('denial, missing support and automatic visible release warn without retry loops', async () => {
  const document = new Visibility(), notices: string[] = []; let requests = 0;
  const denied = new DictationWakeLock({ document, navigator: { wakeLock: { async request() { requests++; throw new Error('denied'); } } } }, message => notices.push(message));
  denied.start(); await tick(); assert.equal(notices.length, 1); assert.equal(requests, 1);
  document.change(true); document.change(false); await tick(); assert.equal(requests, 2); assert.equal(notices.length, 1);
  denied.dispose();
  const missing = new DictationWakeLock({ document, navigator: {} }, message => notices.push(message)); missing.start(); assert.equal(notices.length, 2); missing.dispose();
  const lock = new ScreenLock(); requests = 0;
  const released = new DictationWakeLock({ document, navigator: { wakeLock: { async request() { requests++; return lock; } } } }, message => notices.push(message));
  released.start(); await tick(); await lock.release(); await tick(); assert.equal(notices.length, 3); assert.equal(requests, 1); released.dispose();
});
