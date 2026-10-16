import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HerdrLayout } from '../src/herdr-layout.ts';

const covered = new Set<string>();
const viewport = { classList: { toggle: (name: string, on: boolean) => on ? covered.add(name) : covered.delete(name), remove: (name: string) => covered.delete(name) } } as unknown as HTMLElement;
const frame = () => new Promise(resolve => setTimeout(resolve, 5));
globalThis.requestAnimationFrame = (callback => setTimeout(callback, 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (handle => clearTimeout(handle)) as typeof cancelAnimationFrame;

test('a mobile layout stays covered until its barrier passes and a full frame at the new size paints', async () => {
  const layout = new HerdrLayout(viewport); layout.barrier = true;
  layout.set({ pending: true });
  assert.ok(covered.has('awaiting-herdr-layout')); assert.equal(layout.barrierReady, false);
  assert.equal(layout.accept(false, true), false, 'A frame at another size never matches');
  assert.equal(layout.accept(true, false), false, 'A delta cannot start a layout');
  assert.equal(layout.accept(true, true), true); assert.equal(layout.ready, false, 'The redraw barrier has not passed');
  layout.set({ pending: true, barrierReady: true }); layout.accept(true, true);
  let revealed = 0;
  layout.reveal(() => true, () => revealed++);
  assert.equal(layout.ready, false, 'A scheduled reveal is not repeated');
  await frame(); await frame();
  assert.deepEqual([revealed, layout.pending, layout.rendered, covered.size], [1, false, true, 0]);
});
test('preserved pictures stay visible, stale reveals are dropped and desktop layouts need no handshake', async () => {
  const layout = new HerdrLayout(viewport); layout.barrier = true;
  layout.set({ pending: true, preserve: true });
  assert.equal(covered.size, 0, 'A preserved picture is not covered'); assert.equal(layout.holding, true);
  layout.set({ pending: true, barrierReady: true }); layout.accept(true, true);
  let revealed = 0;
  layout.reveal(() => false, () => revealed++);
  await frame(); await frame();
  assert.deepEqual([revealed, layout.pending], [0, true], 'A reveal whose conditions changed leaves the layout pending');
  layout.desktop();
  assert.deepEqual([layout.pending, layout.preserve, layout.rendered, covered.size], [false, false, false, 0]);
});
