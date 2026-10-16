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

test('cancellation and request deadlines are preserved', async t => {
  const controller = new AbortController(); controller.abort(new Error('Cancelled'));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { init.signal!.throwIfAborted(); return Response.json({}); });
  await assert.rejects(request('https://backend', { signal: controller.signal }), /Cancelled/);
  assert.equal(requestTimeout(new URL('https://backend/api/herdr/action'), { action: 'new-worktree' }), 135000);
  assert.equal(requestTimeout(new URL('https://backend/api/herdr/connect')), 25000);
});

test('reads and keyed changes retry lost connections, while uploads and exhausted attempts fail once', async t => {
  const sent: { method?: string; key: string | null }[] = [];
  let failures = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent.push({ method: init.method, key: new Headers(init.headers).get('Idempotency-Key') });
    if (failures-- > 0) throw new TypeError('Failed to fetch');
    return Response.json({ ok: true });
  });
  failures = 1;
  assert.deepEqual(await requestJSON(new URL('https://backend/api/files/list')), { ok: true });
  assert.equal(sent.length, 2, 'A read retries after a lost connection');
  sent.length = 0; failures = 1;
  assert.deepEqual(await requestJSON(new URL('https://backend/api/files/action'), { action: 'delete' }), { ok: true });
  assert.equal(sent.length, 2); assert.ok(sent[0].key); assert.equal(sent[1].key, sent[0].key, 'A retried change repeats its key so the backend replays the first reply');
  sent.length = 0; failures = 1;
  await assert.rejects(request('https://backend/api/files/upload', { method: 'POST', body: new Blob(['bytes']) }), /Failed to fetch/);
  assert.deepEqual(sent, [{ method: 'POST', key: null }], 'A streamed upload is never repeated automatically');
  sent.length = 0; failures = 3;
  await assert.rejects(requestJSON(new URL('https://backend/api/files/list')), /Failed to fetch/);
  assert.equal(sent.length, 3, 'Attempts are bounded');
  let statuses = [503, 200];
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: statuses.shift() }));
  assert.equal((await request('https://backend/api/files/list')).status, 200, 'A proxy failure is retried');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => { calls++; return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))); });
  await assert.rejects(requestJSON(new URL('https://backend/api/files/action'), { action: 'delete' }, { timeout: 20 }), { name: 'TimeoutError' });
  assert.equal(calls, 2, 'A timed-out change may still be running, so it is retried only once');
});
