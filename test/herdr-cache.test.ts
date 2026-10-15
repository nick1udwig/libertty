import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrCache } from '../src/herdr-cache.ts';

const agent = { terminalId: 'term_0', paneId: 'pane_0', workspace: 'Project', name: 'Agent', kind: 'Codex', cwd: '/project', status: 'working', sequence: 3, workspaceId: 'space_0' };
const snapshot = { version: '0.9.3', protocol: 1, agents: [agent], terminals: [agent], spaces: [{ id: 'space_0', name: 'Project', terminalIds: ['term_0'], selectedTerminalId: 'term_0', repoKey: '/project/.git', repoName: 'project' }] };
test('Herdr navigation cache preserves typed metadata and excludes opaque content', () => {
  assert.deepEqual(herdrCache(snapshot), snapshot);
  assert.deepEqual(herdrCache({ ...snapshot, token: 'secret', history: 'private', agents: [{ ...agent, token: 'secret' }], spaces: [{ ...snapshot.spaces[0], history: 'private' }] }), snapshot);
  const cached = herdrCache(snapshot)!;
  snapshot.spaces[0].terminalIds.push('other');
  assert.deepEqual(cached.spaces![0].terminalIds, ['term_0']); snapshot.spaces[0].terminalIds.pop();
});
test('Herdr navigation cache rejects malformed or oversized persisted metadata', () => {
  for (const value of [null, {}, { ...snapshot, agents: 'invalid' }, { ...snapshot, spaces: [null] }, { ...snapshot, agents: [{ ...agent, sequence: -1 }] },
    { ...snapshot, agents: Array(257).fill(agent) }, { ...snapshot, terminals: [{ ...agent, paneId: '' }] },
    { ...snapshot, agents: Array.from({ length: 256 }, (_, index) => ({ ...agent, terminalId: String(index), name: 'x'.repeat(1024) })) }]) assert.equal(herdrCache(value), undefined);
});
