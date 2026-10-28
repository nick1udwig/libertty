import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalScrollFallback } from '../src/terminal-scroll-fallback.ts';

test('responsive remote scrolling stays live and slow scrolling continues locally', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const local: number[] = [], scroll = new TerminalScrollFallback(lines => local.push(lines));
  assert.equal(scroll.move(-3, true), false);
  t.mock.timers.tick(100); scroll.updated(); t.mock.timers.tick(200);
  assert.deepEqual(local, []);
  scroll.move(-2, true); t.mock.timers.tick(100); scroll.move(-4, true);
  t.mock.timers.tick(100); assert.deepEqual(local, [-6]);
  scroll.updated(); t.mock.timers.tick(1000); assert.deepEqual(local, [-6]);
  assert.equal(scroll.move(-5, false), true); assert.deepEqual(local, [-6, -5]);
});
