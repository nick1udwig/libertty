import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFileSnapshot, packFileSnapshot, selectedFileReader } from '../src/plugin-file.ts';

test('selected-file deltas retain full API snapshots and reject different capabilities or bases', () => {
  const before = { path: '/selected', text: 'hello 界😀\n'.repeat(100), truncated: false, version: 'a' };
  const after = { ...before, text: before.text + 'new 😀\n', version: 'b' };
  assert.deepEqual(mergeFileSnapshot(before, packFileSnapshot(before, after)), after);
  assert.deepEqual(mergeFileSnapshot(after, packFileSnapshot(after, after)), { ...after, unchanged: true });
  assert.throws(() => mergeFileSnapshot(undefined, { unchanged: true, version: 'a' }));
  assert.throws(() => mergeFileSnapshot(before, { path: '/other', append: 'bad', baseVersion: 'a', version: 'b' }));
  assert.throws(() => mergeFileSnapshot(before, { path: before.path, append: 'bad', baseVersion: 'wrong', version: 'b' }));
  assert.deepEqual(packFileSnapshot(undefined, { ...after, unchanged: true }), after);
  const rotated = { ...after, text: 'rotated', version: 'c' };
  assert.deepEqual(packFileSnapshot(after, rotated), rotated);
  assert.deepEqual(packFileSnapshot({ ...before, truncated: true }, after), after);
});

test('conditional reads coalesce and scope snapshots to URL and authentication', async () => {
  const original = globalThis.fetch; let calls = 0; const headers: Headers[] = [];
  globalThis.fetch = (async (_url, options) => {
    calls++; headers.push(new Headers(options?.headers)); await new Promise(resolve => setTimeout(resolve, 5));
    if (calls === 2) return new Response(null, { status: 304 });
    if (calls === 3) return Response.json({ error: 'Revoked' }, { status: 401 });
    return Response.json({ path: '/selected', text: 'hello', truncated: false, version: 'a' });
  }) as typeof fetch;
  try {
    const read = selectedFileReader(), url = new URL('http://backend/api/plugins/read?path=selected&session=one');
    const first = read(url, 'owner1'); assert.equal(read(url, 'owner1'), first); await first;
    assert.equal((await read(url, 'owner1')).unchanged, true); assert.equal(headers[1].get('If-None-Match'), '"a"');
    await assert.rejects(read(url, 'owner2'), /Revoked/); assert.equal(headers[2].get('If-None-Match'), null);
    await read(url, 'owner2'); assert.equal(headers[3].get('If-None-Match'), null);
    await read(new URL('http://other/api/plugins/read?path=selected&session=one'), 'owner2'); assert.equal(headers[4].get('If-None-Match'), null);
  } finally { globalThis.fetch = original; }
});
