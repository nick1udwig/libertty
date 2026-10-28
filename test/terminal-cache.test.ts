import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedTerminal, retainedTerminals, terminalCacheKey, type CachedTerminal } from '../src/terminal-cache.ts';

const now = Date.now();
const entry = (key = 'one', updated = now): CachedTerminal => ({ key, updated, version: 2, stream: 'stream', records: [{ id: 1, at: now, kind: 'history', text: '\x1b[0;1;38;2;255;0;0msaved\x1b[0m 界😀' }], picture: { last: 3, x: 2, y: 3, cursor: true }, position: 12 });
test('history cache rejects expired, malformed and oversized records', () => {
  assert.ok(cachedTerminal(entry(), now));
  assert.equal(cachedTerminal(entry('old', now - 8 * 86400000), now), undefined);
  for (const value of [{ ...entry(), position: -1 }, { ...entry(), position: 1.5 }, { ...entry(), records: [{ id: 1, text: 42 }] }, { ...entry(), records: [{ id: 1, at: now, kind: 'history', text: 'x'.repeat(524289) }] },
    { ...entry(), version: 1 }, { ...entry(), picture: undefined }, { ...entry(), picture: { last: 0.5, x: 0, y: 0, cursor: true } }, { ...entry(), picture: { last: 0, x: 0, y: 0, cursor: 'yes' } }]) assert.equal(cachedTerminal(value, now), undefined);
});
test('history retention bounds total bytes and entries by recency', () => {
  const retained = retainedTerminals(Array.from({ length: 30 }, (_, i) => entry(String(i), now - i)), now);
  assert.equal(retained.length, 16); assert.equal(retained[0].key, '0');
  const large = retainedTerminals(Array.from({ length: 16 }, (_, i) => ({ ...entry(String(i), now - i), records: [{ id: 1, at: now, kind: 'history' as const, text: '界'.repeat(500000) }] })), now);
  assert.ok(large.length < 16);
  assert.ok(new TextEncoder().encode(JSON.stringify(large)).byteLength < 8 * 1024 * 1024);
});
test('history identity separates backends, sessions, sources and recycled panes without credentials', () => {
  const key = terminalCacheKey('https://user:secret@example.com/t/?token=secret', 'session', 'terminal', 'source', 'pane');
  assert.ok(!key.includes('secret'));
  for (const args of [['https://other.test/t/', 'session', 'terminal', 'source', 'pane'], ['https://example.com/t/', 'other', 'terminal', 'source', 'pane'], ['https://example.com/t/', 'session', 'terminal', 'other', 'pane'], ['https://example.com/t/', 'session', 'terminal', 'source', 'recycled']]) assert.notEqual(terminalCacheKey(...args as [string, string, string, string, string]), key);
});
