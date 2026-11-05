import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHost, decodeTab, uniqueRecords } from '../src/workspace-decode.ts';
import { decodePreferences } from '../src/herdr-preferences.ts';
const backends = new Set(['primary']);
const base = { id: 'one', name: 'Saved', backendId: 'primary' };
test('saved SSH profiles require valid addresses and normalize the default port', () => {
  for (const patch of [{}, { hostname: 5, username: 'nick' }, { hostname: 'host', username: 'nick', port: 'wrong' }, { hostname: 'host', username: 'nick', port: 0 }]) assert.equal(decodeHost({ ...base, kind: 'ssh', ...patch }, backends), undefined);
  assert.equal(decodeHost({ ...base, kind: 'ssh', hostname: 'host', username: 'nick' }, backends)?.port, 22);
  assert.equal(decodeHost({ ...base, kind: 'http', backendId: 'missing' }, backends), undefined);
});
test('saved tabs sanitize optional fields and retain unknown plugin state and legacy ownership', () => {
  const tab = { ...base, session: 'default', pluginId: 'files', pluginVersion: '1', directory: {}, lastUsed: 'wrong', readCapture: '../bad' };
  const decoded = decodeTab(tab, backends)!;
  assert.equal(decoded.directory, undefined);
  assert.equal(decoded.lastUsed, undefined);
  assert.equal(decoded.readCapture, undefined);
  assert.equal(decoded.ownsSession, true);
  assert.equal(decodeTab({ ...tab, pluginId: 'reading' }, backends)?.ownsSession, false);
  const state = { filter: 'errors' };
  assert.deepEqual(decodeTab({ ...tab, pluginId: 'example.viewer', pluginState: state }, backends)?.pluginState, state);
  assert.equal(uniqueRecords([tab, tab], value => decodeTab(value, backends)).length, 1);
});
test('malformed Herdr preferences recover without losing valid neighboring fields', () => {
  const preferences = decodePreferences({ order: ['one', 5, 'one'], spaceOrder: {}, spaceGroups: [null, ['one', 7]], collapsedLanes: ['toString', 'idle'], repoSpaces: { one: 5, two: 'space' }, state: { invalid: null } });
  assert.deepEqual(preferences.order, ['one']);
  assert.deepEqual(preferences.spaceOrder, []);
  assert.deepEqual(preferences.spaceGroups, [['one']]);
  assert.deepEqual(preferences.collapsedLanes, ['idle']);
  assert.deepEqual(preferences.repoSpaces, { two: 'space' });
  assert.deepEqual(preferences.state, {});
  for (const value of [null, 5, 'bad', []]) assert.deepEqual(decodePreferences(value).order, []);
});
