import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { builtinIds, PluginRegistry, migratePluginTab, migrateReadingTab, type TabPlugin } from '../src/plugins.ts';
import { parsePluginPackage, pluginRequest, pluginState } from '../src/plugin-package.ts';

const host = { id: 'local', name: 'This machine', kind: 'http' as const, backendId: 'primary' };
const tab = { id: 'tab', name: 'Test', session: 'default', backendId: 'primary' };
function plugin(id: string, version = '1'): TabPlugin {
  return { id, version, name: id, connectLabel: 'Connect ' + id, icon: '', panelPrefix: 'plugin-', available: host => host.kind === 'http',
    connect: async () => {}, mount: async () => { throw new Error('Not used'); }, close: async () => true };
}
test('legacy tabs migrate and the registry preserves pinned versions and unavailable tabs', () => {
  assert.equal(migratePluginTab(tab).pluginId, 'terminal');
  assert.equal(migratePluginTab({ ...tab, mode: 'files' }).pluginId, 'files');
  assert.equal(migratePluginTab({ ...tab, mode: 'herdr' }).pluginId, 'herdr');
  const registry = new PluginRegistry(), old = plugin('example.logs'), next = plugin('example.logs', '2');
  registry.register(old); registry.register(next);
  assert.deepEqual(registry.actions(host), [next]);
  assert.equal(registry.forTab({ ...tab, pluginId: old.id, pluginVersion: '1' }), old);
  assert.equal(registry.forTab({ ...tab, pluginId: old.id, pluginVersion: 'missing' }), undefined);
  assert.deepEqual(registry.actions({ ...host, kind: 'ssh' }), []);
  assert.throws(() => registry.register(next), /already installed/);
  registry.enable(old.id, false); assert.equal(registry.get(old.id), undefined); assert.deepEqual(registry.actions(host), []);
  registry.enable(old.id, true); assert.equal(registry.get(old.id), next);
  registry.remove(old.id); assert.equal(registry.get(old.id, '1'), undefined); assert.equal(registry.get(old.id, '2'), undefined);
});
test('legacy reading tabs pin the reading plugin and borrow their source session', () => {
  const registry = new PluginRegistry(), reader = plugin('reading'); registry.register(reader);
  const file = migrateReadingTab({ ...tab, path: 'README.md', sourceTabId: 'terminal-tab', lastUsed: 123 });
  assert.equal(registry.forTab(file), reader);
  assert.equal(file.readPath, 'README.md'); assert.equal(file.parentTabId, 'terminal-tab');
  assert.equal(file.ownsSession, false); assert.equal(file.session, tab.session); assert.equal(file.lastUsed, 123);
  const capture = migrateReadingTab({ ...tab, path: 'git diff', sourceTabId: 'terminal-tab', capture: 'a'.repeat(32), exitCode: 2 });
  assert.equal(capture.readCapture, 'a'.repeat(32)); assert.equal(capture.readExitCode, 2);
  assert.equal(capture.readPath, 'git diff'); assert.equal(capture.pluginVersion, '1'); assert.equal(capture.ownsSession, false);
});
test('the independently packaged sample uses the supported manifest and view', async () => {
  const pkg = parsePluginPackage(JSON.parse(await readFile(new URL('../examples/plugins/example.log-viewer.termai-plugin.json', import.meta.url), 'utf8')));
  assert.equal(pkg.manifest.id, 'example.log-viewer');
  assert.equal(pkg.view, await readFile(new URL('../examples/plugins/log-viewer/view.html', import.meta.url), 'utf8'));
  for (const id of builtinIds) assert.throws(() => parsePluginPackage({ ...pkg, manifest: { ...pkg.manifest, id } }));
  for (const manifest of [{ ...pkg.manifest, id: '../path' }, { ...pkg.manifest, apiVersion: 2 }, { ...pkg.manifest, permissions: ['shell.exec'] }, { ...pkg.manifest, name: '<bad>\n' }]) assert.throws(() => parsePluginPackage({ ...pkg, manifest }));
  assert.throws(() => parsePluginPackage({ ...pkg, view: 'x'.repeat(256 * 1024) }), /256 KB/);
});
test('the bridge cannot widen file permission, call shell APIs or persist excessive state', async () => {
  let reads = 0, saved: unknown;
  const scope = { read: async () => { reads++; return { path: '/selected.log', text: 'line', truncated: false }; }, save: (state: unknown) => saved = state };
  assert.deepEqual(await pluginRequest('file.read', undefined, scope), { path: '/selected.log', text: 'line', truncated: false });
  for (const params of [{ path: '/etc/passwd' }, { session: 'other' }, '/etc/passwd', []]) await assert.rejects(pluginRequest('file.read', params, scope), /selected/);
  for (const method of ['shell.exec', 'api', 'keychain.read', '__proto__']) await assert.rejects(pluginRequest(method, {}, scope), /not permitted/);
  assert.equal(reads, 1);
  await pluginRequest('state.save', { filter: 'warning' }, scope); assert.deepEqual(saved, { filter: 'warning' });
  await assert.rejects(pluginRequest('state.save', 'x'.repeat(16 * 1024), scope), /16 KB/);
  assert.throws(() => pluginState(undefined), /JSON/);
  assert.throws(() => pluginState('🙂'.repeat(5000)), /16 KB/, 'State limits count encoded bytes');
});
