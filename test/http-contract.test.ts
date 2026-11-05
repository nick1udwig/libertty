import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestEndpoint, responseJSON } from '../src/api.ts';
import type { CreatedSession } from '../src/generated/protocol.ts';

test('typed endpoints encode their input and infer the server response', async () => {
  const previous = globalThis.fetch;
  const response = { id: 'session', name: 'Shell', state: { cwd: '/', inputRevision: 0, promptRevision: 0, ready: true, prompt: 1, exited: false } };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://example.test/t/api/sessions');
    assert.deepEqual(JSON.parse(String(options?.body)), { name: 'Shell' });
    return Response.json(response);
  };
  try {
    const result: CreatedSession = await requestEndpoint('https://example.test/t/', 'api/sessions', { name: 'Shell' });
    assert.deepEqual(result, response);
  } finally { globalThis.fetch = previous; }
});
test('non-JSON failures retain HTTP status and successful malformed responses fail clearly', async () => {
  await assert.rejects(responseJSON(new Response('<html>Unavailable</html>', { status: 503 })), { status: 503, message: 'Request failed (503).' });
  await assert.rejects(responseJSON(new Response('bad')), { status: 200, message: 'Invalid JSON response.' });
});
function checkedCalls() {
  // @ts-expect-error Session names are strings.
  void requestEndpoint('https://example.test/', 'api/sessions', { name: 5 });
  // @ts-expect-error Unknown endpoints are rejected.
  void requestEndpoint('https://example.test/', 'api/sessionz', {});
}
void checkedCalls;
