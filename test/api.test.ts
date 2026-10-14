import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, requestJSON, requestTimeout } from '../src/api.ts';

test('requests share headers, recover one rejected credential and preserve caller cancellation', async t => {
  const sent: RequestInit[] = [];
  let token = 'old', recoveries = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent.push(init);
    return sent.length === 1 ? Response.json({ error: 'Expired' }, { status: 401 }) : Response.json({ ok: true });
  });
  const result = await requestJSON(new URL('https://backend/api/suggest'), { text: 'hello' }, {
    token: () => token, headers: { 'If-None-Match': 'version' },
    recoverAuth: async rejected => { assert.equal(rejected, 'old'); recoveries++; token = 'fresh'; },
  });
  assert.deepEqual(result, { ok: true }); assert.equal(recoveries, 1); assert.equal(sent.length, 2);
  assert.equal(new Headers(sent[0].headers).get('Authorization'), 'Bearer old');
  assert.equal(new Headers(sent[1].headers).get('Authorization'), 'Bearer fresh');
  assert.equal(new Headers(sent[1].headers).get('If-None-Match'), 'version');
  assert.equal(sent[1].credentials, 'same-origin'); assert.equal(sent[1].cache, 'no-store');
});

test('timeouts and uncertain failures never replay mutations', async t => {
  let calls = 0, recoveries = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Connection lost'); });
  await assert.rejects(requestJSON(new URL('https://backend/api/files/action'), { action: 'delete' }, { recoverAuth: async () => { recoveries++; } }), /Connection lost/);
  assert.equal(calls, 1); assert.equal(recoveries, 0);
  const controller = new AbortController(); controller.abort(new Error('Cancelled'));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { init.signal!.throwIfAborted(); return Response.json({}); });
  await assert.rejects(request('https://backend', { signal: controller.signal }), /Cancelled/);
  assert.equal(requestTimeout(new URL('https://backend/api/herdr/action'), { action: 'new-worktree' }), 135000);
  assert.equal(requestTimeout(new URL('https://backend/api/herdr/connect')), 25000);
});
