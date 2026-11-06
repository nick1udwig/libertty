import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalConnection, TerminalVisibility } from '../src/terminal-lifecycle.ts';

test('reconnect requires new state and replay synchronization', () => {
  const connection = new TerminalConnection();
  assert.equal(connection.synchronize(), false);
  connection.opened();
  connection.hello();
  assert.equal(connection.receivedState(), true);
  assert.equal(connection.synchronize(), true);
  assert.equal(connection.receivedState(), false);
  assert.equal(connection.synchronize(), false);
  connection.closed();
  assert.equal(connection.hasState, false);
  assert.equal(connection.streamStarted, false);
  connection.opened();
  assert.equal(connection.epoch, 2);
  assert.equal(connection.synchronize(), false);
  assert.equal(connection.receivedState(), true);
});

test('hidden tabs expire once and a return cancels the pending expiry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: string[] = [];
  const visibility = new TerminalVisibility(false, true, false, {
    foreground: () => events.push('foreground'),
    suspend: () => events.push('suspend'),
    expire: () => events.push('expire'),
  });
  visibility.setVisible(false);
  visibility.updateTransport(false);
  assert.equal(visibility.available(false), false);
  t.mock.timers.tick(2000);
  assert.deepEqual(events, []);
  visibility.setVisible(true);
  visibility.updateTransport(true);
  visibility.setVisible(false);
  visibility.updateTransport(false);
  assert.equal(visibility.available(false), true);
  t.mock.timers.tick(1999);
  visibility.setVisible(true);
  visibility.updateTransport(true);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ['foreground', 'foreground']);
  visibility.setVisible(false);
  visibility.updateTransport(false);
  t.mock.timers.tick(2000);
  assert.equal(visibility.available(false), false);
  assert.equal(visibility.available(true), true);
  assert.equal(events.at(-1), 'expire');
});

test('preview authorization and parked reconnects preserve pane isolation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let suspends = 0;
  const visibility = new TerminalVisibility(true, true, true, {
    foreground() {}, suspend() { suspends++; }, expire() { assert.fail(); },
  });
  assert.equal(visibility.available(true), false);
  visibility.authorize();
  assert.equal(visibility.available(false), true);
  visibility.park(true);
  visibility.closed();
  assert.equal(visibility.available(true), false);
  visibility.park(false);
  t.mock.timers.tick(2000);
  assert.equal(suspends, 0);
  assert.equal(visibility.available(false), true);
  visibility.park(true);
  t.mock.timers.tick(2000);
  assert.equal(suspends, 1);
  assert.equal(visibility.available(false), false);
  visibility.park(false);
  visibility.park(true);
  visibility.dispose();
  t.mock.timers.tick(2000);
  assert.equal(suspends, 1);
});
