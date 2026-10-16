import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateBrandStorage } from '../src/brand-storage.ts';

function storage(entries: [string, string][]) {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } satisfies Storage;
}

test('rebrand preserves saved profiles, pairing credentials and pending sessions', () => {
  const saved = storage([
    ['termai.hosts', '[{"id":"saved-host"}]'],
    ['termai.access:https://backend/t/', 'paired-credential'],
    ['termai.pendingReading:/t/', '{"session":"default"}'],
    ['termai.theme', '"paper"'],
    ['libertty.theme', '"ink"'],
    ['another-app.setting', 'keep'],
  ]);
  migrateBrandStorage(saved);
  assert.equal(saved.getItem('libertty.hosts'), '[{"id":"saved-host"}]');
  assert.equal(saved.getItem('libertty.access:https://backend/t/'), 'paired-credential');
  assert.equal(saved.getItem('libertty.pendingReading:/t/'), '{"session":"default"}');
  assert.equal(saved.getItem('libertty.theme'), '"ink"');
  assert.equal(saved.getItem('termai.theme'), null);
  assert.equal(saved.getItem('another-app.setting'), 'keep');
  migrateBrandStorage(saved);
  assert.equal(saved.length, 5);
});

test('storage failures leave legacy data intact for a later retry', () => {
  const saved = storage([['termai.hosts', 'saved-hosts']]);
  const write = saved.setItem;
  saved.setItem = () => { throw new Error('Storage full'); };
  assert.throws(() => migrateBrandStorage(saved), /Storage full/);
  assert.equal(saved.getItem('termai.hosts'), 'saved-hosts');
  saved.setItem = write;
  migrateBrandStorage(saved);
  assert.equal(saved.getItem('libertty.hosts'), 'saved-hosts');
});
