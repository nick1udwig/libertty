import { builtinState, builtinStateCodecs } from '../src/builtin-state.ts';
import { PluginRegistry } from '../src/plugins.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHost, decodeTab, uniqueRecords } from '../src/workspace-decode.ts';
import { decodePreferences } from '../src/herdr-preferences.ts';
const plugins = new PluginRegistry(builtinStateCodecs);
const backends = new Set(['primary']);
const base = { id: 'one', name: 'Saved', backendId: 'primary' };
test('saved SSH profiles require valid addresses and normalize the default port', () => {
  for (const patch of [{}, { hostname: 5, username: 'nick' }, { hostname: 'host', username: 'nick', port: 'wrong' }, { hostname: 'host', username: 'nick', port: 0 }]) assert.equal(decodeHost({ ...base, kind: 'ssh', ...patch }, backends), undefined);
  assert.equal(decodeHost({ ...base, kind: 'ssh', hostname: 'host', username: 'nick' }, backends)?.port, 22);
  assert.equal(decodeHost({ ...base, kind: 'http', backendId: 'missing' }, backends), undefined);
});
test('saved tabs sanitize optional fields and retain unknown plugin state and legacy ownership', () => {
  const tab = { ...base, session: 'default', pluginId: 'files', pluginVersion: '1', directory: {}, lastUsed: 'wrong', readCapture: '../bad' };
  const decoded = decodeTab(tab, backends, plugins)!;
  assert.equal(builtinState(decoded).directory, undefined);
  assert.equal(decoded.lastUsed, undefined);
  assert.equal(builtinState(decoded).readCapture, undefined);
  assert.equal(decoded.ownsSession, true);
  assert.equal(decodeTab({ ...tab, pluginId: 'reading' }, backends, plugins)?.ownsSession, false);
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

test('builtin state migrates legacy fields, round-trips, and preserves unavailable versions', () => {
  const legacy = { ...base, session: 'default', pluginId: 'reading', pluginVersion: '1', readPath: '/work/a.txt', readCapture: 'a'.repeat(32), herdrSession: 'work', herdrSource: 'source', readHerdrTerminal: 'pane', herdrCore: true };
  const migrated = decodeTab(legacy, backends, plugins)!;
  assert.equal(builtinState(migrated).readPath, legacy.readPath);
  assert.equal(builtinState(migrated).herdrSession, 'work');
  assert.equal(builtinState(migrated).readHerdrTerminal, 'pane');
  assert.equal(migrated.ownsSession, false);
  assert.equal('herdrSession' in migrated, false);
  assert.deepEqual(decodeTab(JSON.parse(JSON.stringify(migrated)), backends, plugins), migrated);
  const future = { ...legacy, pluginVersion: 'next', pluginState: { future: ['data'] }, ownsSession: false };
  assert.deepEqual(decodeTab(future, backends, plugins)?.pluginState, future.pluginState);
  const scoped = decodeTab({ ...base, session: 'default', pluginId: 'external', pluginVersion: '1', readPath: '/allowed', pluginState: { readPath: '/forbidden' } }, backends, plugins)!;
  assert.equal(scoped.readPath, '/allowed');
});
test('plugin decoders are scoped by plugin and version', () => {
  const registry = new PluginRegistry([{ id: 'custom', version: '1', state: { ownsSession: false, decode: value => ({ migrated: value }) } }]);
  const tab = { ...base, session: 'default', pluginId: 'custom', pluginVersion: '1', pluginState: 'old' };
  assert.deepEqual(decodeTab(tab, backends, registry)?.pluginState, { migrated: 'old' });
  assert.equal(decodeTab(tab, backends, registry)?.ownsSession, false);
  assert.equal(decodeTab({ ...tab, pluginVersion: '2' }, backends, registry)?.pluginState, 'old');
});
