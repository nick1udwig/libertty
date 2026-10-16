import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadResumable } from '../src/resumable-upload.ts';

const file = new Blob([new Uint8Array(8)]), signal = new AbortController().signal, options = { delay: 1 };
test('an interrupted upload asks what arrived and sends only the rest', async () => {
  const attempts: [number, number][] = [];
  await uploadResumable(async (offset, body) => {
    attempts.push([offset, body.size]);
    if (attempts.length === 1) throw new TypeError('Failed to fetch');
    return attempts.length === 2 ? { received: 3 } : { name: 'photo.jpg' };
  }, file, signal, options);
  assert.deepEqual(attempts, [[0, 8], [0, 0], [3, 5]]);
});
test('rejections, stalled attempts and cancellation end the upload', async () => {
  let calls = 0;
  await assert.rejects(uploadResumable(async () => { calls++; throw Object.assign(new Error('A file with that name already exists.'), { status: 409 }); }, file, signal, options), /already exists/);
  assert.equal(calls, 1, 'A backend rejection is final');
  calls = 0;
  await assert.rejects(uploadResumable(async offset => { calls++; return { received: offset }; }, file, signal, options), /stopped before any bytes/);
  assert.equal(calls, 11, 'Attempts that make no progress are bounded');
  const controller = new AbortController(); calls = 0;
  await assert.rejects(uploadResumable(async () => { calls++; controller.abort(); throw new TypeError('aborted'); }, file, controller.signal, options), { name: 'AbortError' });
  assert.equal(calls, 1);
});
