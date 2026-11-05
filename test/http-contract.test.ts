import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestEndpoint, requestTimeout, responseJSON } from '../src/api.ts';
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
test('action errors expose capabilities without parsing their message', async () => {
  await assert.rejects(responseJSON(Response.json({ error: 'Localized refusal.', code: 'force_required' }, { status: 400 })), { status: 400, code: 'force_required', message: 'Localized refusal.' });
  assert.equal(requestTimeout(new URL('https://example.test/api/herdr/action'), { action: 'list-worktrees' }), 135000);
  assert.equal(requestTimeout(new URL('https://example.test/api/herdr/action'), { action: 'rename' }), 12000);
});
function checkedCalls() {
  // @ts-expect-error Snapshot reads must not carry a POST body.
  void requestEndpoint('https://example.test/', 'api/herdr/snapshot', {});
  // @ts-expect-error A split must name a terminal and direction.
  void requestEndpoint('https://example.test/', 'api/herdr/action', { action: 'split', workspaceId: 'space' });
  // @ts-expect-error Worktree creation requires a branch.
  void requestEndpoint('https://example.test/', 'api/herdr/action', { action: 'new-worktree', workspaceId: 'space' });
  void requestEndpoint('https://example.test/', 'api/herdr/action', { action: 'list-worktrees', workspaceId: 'space' }).then(list => list.worktrees);
  // @ts-expect-error A mutation does not return a worktree listing.
  void requestEndpoint('https://example.test/', 'api/herdr/action', { action: 'close', terminalId: 'terminal' }).then(result => result.worktrees);

  // @ts-expect-error Session names are strings.
  void requestEndpoint('https://example.test/', 'api/sessions', { name: 5 });
  // @ts-expect-error Unknown endpoints are rejected.
  void requestEndpoint('https://example.test/', 'api/sessionz', {});
}
void checkedCalls;
