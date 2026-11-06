import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeSession, herdrSessionAdapter } from '../src/terminal-session.ts';

const context = { session: 'session', connection: 1, prompt: 2, revision: 3, target: 'shell' as const };
const state = { hasState: true, ready: true, layoutPending: false, parked: false, after: 9, target: 10, stream: 'stream', identity: 'pane' };
const base = new URL('https://example.test/mounted/');
test('native input waits for replay and retains stream identity without reading a picture', () => {
  const session = nativeSession(base, 'shell');
  assert.equal(session.synchronized(state), false);
  assert.equal(session.synchronized({ ...state, after: 10 }), true);
  assert.equal(session.synchronized({ ...state, after: 10, hasState: false }), false);
  assert.deepEqual(session.inputContext(context, state, () => { throw new Error('Unexpected picture'); }), { ...context, stream: 'stream' });
  assert.equal(session.inputContext(context, { ...state, stream: undefined }, () => ''), undefined);
  assert.equal(session.socketEndpoint().href, 'https://example.test/mounted/ws?session=shell');
  assert.deepEqual(session.resize(80, 24, true), { type: 'resize', cols: 80, rows: 24 });
});
for (const core of [false, true]) test(`Herdr ${core ? 'Core' : 'RPC'} input requires a live pane and settled layout`, () => {
  const session = herdrSessionAdapter(base, 'terminal', { core, session: 'agents', source: 'source' });
  assert.equal(session.synchronized(state), true);
  for (const change of [{ hasState: false }, { ready: false }, { parked: true }, { layoutPending: true }, { identity: undefined }]) {
    assert.equal(session.synchronized({ ...state, ...change }), false);
  }
  assert.deepEqual(session.inputContext(context, state, () => 'picture'), { ...context, identity: 'pane', picture: 'picture' });
  assert.deepEqual(session.inputContext({ ...context, target: 'program' }, state, () => { throw new Error('Unexpected picture'); }), { ...context, target: 'program', identity: 'pane' });
  assert.equal(session.mobile(true), !core);
  assert.equal(session.mobile(false), false);
  assert.equal(session.socketEndpoint().pathname, '/mounted/herdr/ws');
  assert.equal(session.socketEndpoint().searchParams.get('terminalId'), 'terminal');
  assert.equal(session.socketEndpoint().searchParams.get('herdrCore'), core ? '1' : null);
  assert.deepEqual(session.resize(80, 24, false), { type: 'resize', cols: 80, rows: 24, mobile: false });
});
