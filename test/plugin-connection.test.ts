import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrConnection, selectedFileConnection, terminalConnection, type ConnectionContext } from '../src/plugin-connection.ts';
import { externalPlugin } from '../src/external-plugin.ts';
import { parsePluginPackage } from '../src/plugin-package.ts';

function context(): ConnectionContext {
  return {
    host: { id: 'host', name: 'Machine', kind: 'http', backendId: 'backend' },
    backend: { id: 'backend', name: 'Backend', url: 'http://localhost' },
    session: 'transport', input: {},
    api: async () => { throw new Error('Unexpected API request'); },
    endpoint: async () => { throw new Error('Unexpected endpoint'); },
    addTerminal: async () => { throw new Error('Unexpected terminal'); },
  };
}

test('terminal connections select their transport and delegate tab creation', async () => {
  for (const files of [false, true]) {
    const ctx = context();
    let args: unknown[] = [];
    ctx.addTerminal = async (...input) => { args = input; };
    const connection = terminalConnection(files);
    assert.equal(connection.session, files ? 'files' : 'terminal');
    assert.equal(await connection.prepare(ctx), undefined);
    assert.deepEqual(args, [ctx.backend, 'transport', 'Machine', 'host', undefined, files]);
  }
});

test('Herdr connection hooks retain session identity and select the requested backend', async () => {
  for (const core of [false, true]) {
    const ctx = context();
    ctx.input.herdrSession = 'work';
    ctx.endpoint = async (_backend, name, input) => {
      assert.equal(name, 'api/herdr/connect');
      assert.deepEqual(input, { source: 'transport', session: 'work', core });
      return { herdrSession: 'work', herdrSource: 'resolved' } as never;
    };
    const connection = herdrConnection(core);
    const details = await connection.prepare(ctx);
    assert.equal((details?.pluginState as { herdrSource: string })?.herdrSource, 'resolved');
    assert.equal(details?.name, `${core ? 'Herdr Core' : 'Herdr'} · Machine · work`);
    const tab = { id: 'tab', name: 'Test', session: 'transport', backendId: 'backend', pluginId: 'arbitrary', pluginVersion: '1', pluginState: { herdrSession: 'work' } };
    assert.equal(connection.matches!(tab, ctx.input), true);
    assert.equal(connection.matches!(tab, { herdrSession: 'other' }), false);
  }
});

test('packaged plugins always receive the host file connection and resolved file scope', async () => {
  const pkg = parsePluginPackage({ manifest: { id: 'example.viewer', name: 'Viewer', version: '1', apiVersion: 1, connectLabel: 'Open', permissions: ['file.read'], connection: { session: 'terminal' } }, view: '<p>Viewer</p>' });
  const plugin = externalPlugin(pkg, { connect: async () => {}, close: async () => {}, read: async () => { throw new Error('Unused'); }, store() {} });
  assert.equal(plugin.connection, selectedFileConnection);
  const ctx = context();
  await assert.rejects(plugin.connection!.prepare(ctx), /file path/);
  ctx.input.readPath = '../log & notes';
  ctx.api = async (_backend, name) => {
    const query = new URL(name, 'http://localhost').searchParams;
    assert.equal(query.get('path'), '../log & notes');
    assert.equal(query.get('session'), 'transport');
    return { path: '/resolved/log & notes' } as never;
  };
  assert.deepEqual(await plugin.connection!.prepare(ctx), { readPath: '/resolved/log & notes' });
});
