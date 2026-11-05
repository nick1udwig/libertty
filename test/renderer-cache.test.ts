import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RendererCache } from '../src/renderer-cache.ts';

test('native and Herdr renderers share recency and eviction protections', () => {
  const cache = new RendererCache<string>(4), disposed: string[] = [];
  const pinned = new Set(['native-active', 'herdr-recording']);
  const retain = (key: string) => cache.retain(key, {
    canEvict: () => !pinned.has(key), dispose: () => disposed.push(key),
  });
  for (const key of ['native-active', 'herdr-old', 'native-old', 'herdr-recording']) retain(key);
  cache.touch('herdr-old');
  retain('herdr-new');
  assert.deepEqual(disposed, ['native-old']);
  retain('native-new');
  assert.deepEqual(disposed, ['native-old', 'herdr-old']);
  cache.release('herdr-new');
  retain('native-reopened');
  assert.equal(disposed.length, 2);
  pinned.delete('herdr-recording');
  retain('herdr-reopened');
  assert.deepEqual(disposed, ['native-old', 'herdr-old', 'herdr-recording']);
});

test('pending input can exceed the budget until it is acknowledged', () => {
  const cache = new RendererCache<number>(1), disposed: number[] = [];
  let pending = true;
  cache.retain(1, { canEvict: () => !pending, dispose: () => disposed.push(1) });
  cache.retain(2, { canEvict: () => false, dispose: () => disposed.push(2) });
  assert.deepEqual(disposed, []);
  pending = false;
  cache.trim();
  assert.deepEqual(disposed, [1]);
  cache.trim();
  assert.deepEqual(disposed, [1]);
});
