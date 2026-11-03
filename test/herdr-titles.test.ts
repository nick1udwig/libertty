import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneTitles } from '../src/herdr-titles.ts';
import type { HerdrAgent, HerdrSpace } from '../src/herdr-protocol.ts';

const space: HerdrSpace = { id: 's', name: 'feat/backend', cwd: '/worktrees/project/feat-backend', checkoutPath: '/worktrees/project/feat-backend', terminalIds: [] };
function titles(panes: Partial<HerdrAgent>[], checkout = space): string[] {
  const terminals = panes.map((pane, i) => ({ terminalId: String(i), paneId: String(i), workspace: checkout.name, name: 'bash', kind: 'Terminal', cwd: checkout.cwd, status: 'idle', sequence: 0, ...pane }) as HerdrAgent);
  return [...paneTitles({ ...checkout, terminalIds: terminals.map(t => t.terminalId) }, terminals).values()];
}

test('both backends use short program names and checkout-relative folders', () => {
  assert.deepEqual(titles([
    { name: 'nick@host:~/.herdr/worktrees/project/feat-backend', kind: 'Codex' },
    { name: 'codex', kind: 'codex' },
    { name: 'claude-code', kind: 'claude-code', cwd: space.cwd + '/crates/server' },
    { name: 'nick@host:~/project/src', cwd: space.cwd + '/src' },
    { name: 'bash', kind: 'bash', cwd: '/tmp/other-repo/scripts' },
  ]), ['1 · Codex', '2 · Codex', 'Claude · crates/server', 'Shell · src', 'Shell · …/other-repo/scripts']);
});

test('meaningful live titles and explicit names survive compaction', () => {
  assert.deepEqual(titles([
    { name: 'Review nested backend shutdown', kind: 'codex' },
    { name: 'Fix API/foo routing' },
    { name: 'Review tools/codex', kind: 'Codex' },
    { name: 'bash', label: 'bash' },
    { name: 'nick@host:~/keep-this', label: 'nick@host:~/keep-this' },
    { name: 'feat/backend', kind: 'Codex' },
    { name: 'htop', kind: 'htop' },
  ]), ['Review nested backend shutdown', 'Fix API/foo routing', 'Review tools/codex', 'bash', 'nick@host:~/keep-this', 'Codex', 'htop']);
});

test('identical panes remain distinguishable and cwd changes update labels', () => {
  assert.deepEqual(titles([{}, {}, {}]), ['1 · Shell', '2 · Shell', '3 · Shell']);
  assert.deepEqual(titles([{}, { cwd: space.cwd + '/docs' }]), ['Shell', 'Shell · docs']);
  assert.deepEqual(titles([{ cwd: space.cwd + '-other/src' }]), ['Shell · …/feat-backend-other/src']);
  assert.deepEqual(titles([{ name: 'nick@host:~/project/src', cwd: '' }], { ...space, cwd: '', checkoutPath: undefined }), ['Shell · …/project/src']);
  assert.deepEqual(titles([{ name: '', cwd: '' }]), ['Shell']);
});
