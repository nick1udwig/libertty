import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { NoticeModel, remoteActions, remoteNotice } from '../src/notice-model.ts';

function model() {
  let now = 0, changes = 0;
  const notices = new NoticeModel(() => changes++, () => now);
  return { notices, changes: () => changes, advance(ms: number) { now += ms; mock.timers.tick(ms); } };
}

test('errors wait for the person while done notices leave on their own and join the history', t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const { notices, advance } = model();
  const error = notices.notify({ message: 'Could not start rui' });
  assert.equal(error.kind, 'error'); assert.equal(notices.presented, error);
  const done = notices.notify({ message: 'Selection copied.', kind: 'done' });
  assert.equal(notices.presented, done); assert.equal(notices.unread, 2);
  advance(3000);
  assert.deepEqual(notices.events, [error]); assert.deepEqual(notices.history, [done]);
  assert.equal(notices.presented, undefined, 'An expired notice leaves the bubble');
  advance(60000);
  assert.deepEqual(notices.events, [error], 'Errors never expire');
  notices.dismiss(error);
  assert.deepEqual(notices.history, [error, done]); assert.equal(notices.active, false);
});

test('holding a notice pauses its lifetime and release leaves time to finish reading', t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const { notices, advance } = model();
  const info = notices.notify({ message: 'Install command pasted.', kind: 'info' });
  advance(5900); notices.hold(info); advance(60000);
  assert.deepEqual(notices.events, [info], 'A held notice stays');
  notices.resume(info); advance(1499);
  assert.deepEqual(notices.events, [info], 'Release grants at least 1.5 s');
  advance(1);
  assert.deepEqual(notices.history, [info]);
});

test('a repeated notice replaces its earlier copy instead of stacking', () => {
  const { notices } = model();
  const first = notices.notify({ message: 'Input could not be queued.' });
  const second = notices.notify({ message: 'Input could not be queued.' });
  assert.deepEqual(notices.events, [second]); assert.notEqual(first.id, second.id);
});

test('states last while true, only fold when dismissed and never enter the history', () => {
  const { notices, changes } = model();
  notices.set('terminal', { message: 'Reconnecting' });
  assert.equal(notices.progress, true); assert.equal(notices.unread, 0, 'Progress resolves itself');
  assert.equal(notices.presented, undefined, 'Progress does not unfurl');
  const before = changes();
  notices.set('terminal', { message: 'Reconnecting' });
  assert.equal(changes(), before, 'An unchanged state does not redraw');
  notices.set('terminal', { message: 'This terminal has ended.', kind: 'error' }, true);
  const ended = notices.presented!;
  assert.equal(ended.key, 'terminal'); assert.equal(notices.strongest, ended);
  notices.dismiss(ended);
  assert.equal(notices.presented, undefined); assert.equal(notices.states.get('terminal'), ended);
  notices.set('terminal', { message: 'This terminal has ended.', kind: 'error' }, true);
  assert.equal(notices.presented, undefined, 'An unchanged state stays folded');
  notices.set('terminal');
  assert.equal(notices.active, false); assert.deepEqual(notices.history, []);
});

test('clear dismisses every notice and keeps states', () => {
  const { notices } = model();
  notices.set('herdr', { message: 'Herdr disconnected. Reconnecting…' });
  notices.dismiss(notices.notify({ message: 'Old' }));
  notices.notify({ message: 'New', kind: 'warning' });
  notices.clear();
  assert.deepEqual(notices.events, []); assert.deepEqual(notices.history, []); assert.equal(notices.states.size, 1);
});

test('the strongest mark prefers severity, then recency', () => {
  const { notices } = model();
  notices.notify({ message: 'Copied', kind: 'done' });
  const warning = notices.notify({ message: 'Paused', kind: 'warning' });
  assert.equal(notices.strongest, warning);
  const error = notices.notify({ message: 'Failed' });
  notices.notify({ message: 'Later info', kind: 'info' });
  assert.equal(notices.strongest, error);
});

test('frame notices are validated and their actions reply with ids', () => {
  assert.equal(remoteNotice({ message: '' }, 'error'), undefined);
  assert.equal(remoteNotice({ message: 7 }, 'error'), undefined);
  const remote = remoteNotice({ message: 'Reconnected', kind: 'bogus', actions: [{ id: 'redraw', label: 'Redraw' }, { id: 1, label: 'Bad' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, 'info')!;
  assert.equal(remote.kind, 'info'); assert.deepEqual(remote.actions, [{ id: 'redraw', label: 'Redraw' }, { id: 'a', label: 'A' }]);
  const replies: string[] = [];
  for (const action of remoteActions(remote, id => replies.push(id))) action.run();
  assert.deepEqual(replies, ['redraw', 'a']);
});
