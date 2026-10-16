import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchResumable } from '../src/resumable-download.ts';

const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
/** A body that delivers its chunks and then ends, fails or goes silent until its request is aborted. */
function body(chunks: Uint8Array[], end: 'close' | 'fail' | 'stall', signal?: AbortSignal | null) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) { signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else if (end === 'close') controller.close();
      else if (end === 'fail') controller.error(new TypeError('network error'));
      else return new Promise<void>(() => {});
    },
  });
}
const options = (signal = new AbortController().signal) => ({ size: bytes.length, signal, progress() {}, stall: 50, delay: 1 });
test('interrupted and stalled downloads resume from the received bytes', async t => {
  for (const end of ['fail', 'stall'] as const) {
    const ranges: (string | null)[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const range = new Headers(init.headers).get('Range'); ranges.push(range);
      return range ? new Response(body([bytes.subarray(3)], 'close'), { status: 206 }) : new Response(body([bytes.subarray(0, 3)], end, init.signal), { status: 200 });
    });
    const blob = await fetchResumable(new URL('https://backend/api/files/download?ticket=t'), options());
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes, end);
    assert.deepEqual(ranges, [null, 'bytes=3-']);
  }
});
test('a backend without ranges restarts the download, and a changed file or cancellation stops it', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(calls++ ? body([bytes], 'close') : body([bytes.subarray(0, 3)], 'fail'), { status: 200 }));
  assert.deepEqual(new Uint8Array(await (await fetchResumable(new URL('https://backend/d'), options())).arrayBuffer()), bytes);
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return calls === 1 ? new Response(body([bytes.subarray(0, 3)], 'fail'), { status: 200 }) : new Response('{}', { status: 409 }); });
  await assert.rejects(fetchResumable(new URL('https://backend/d'), options()), /file changed/);
  assert.equal(calls, 2);
  const controller = new AbortController(); calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); throw new TypeError('aborted'); });
  await assert.rejects(fetchResumable(new URL('https://backend/d'), options(controller.signal)), { name: 'AbortError' });
  assert.equal(calls, 1);
});
