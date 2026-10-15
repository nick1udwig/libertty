import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLayout, dropSpace, spaceTerminal, worktreePath, spaceRepos, repoSpace } from '../src/herdr-spaces.ts';

test('worktrees group under their repository root while other spaces stand alone', () => {
  const space = (id: string, extra = {}) => ({ id, name: id, terminalIds: [id + ':pane'], ...extra });
  const repo = { repoKey: '/repo/.git', repoName: 'repo' };
  const repos = spaceRepos([space('review', { ...repo, linkedWorktree: true }), space('notes'), space('main', { ...repo, linkedWorktree: false }), space('fix', { ...repo, linkedWorktree: true })]);
  assert.deepEqual(repos.map(group => [group.id, group.name, group.git, group.root?.id, group.spaces.map(space => space.id)]), [
    ['repo:/repo/.git', 'repo', true, 'main', ['main', 'review', 'fix']],
    ['space:notes', 'notes', false, 'notes', ['notes']],
  ], 'The root checkout leads its worktrees, and groups keep the position of their first space');
  const orphaned = spaceRepos([space('review', { ...repo, linkedWorktree: true })])[0];
  assert.equal(orphaned.root, undefined, 'Worktrees still group when their root checkout is not open');
  assert.equal(repoSpace(repos[0], 'fix').id, 'fix');
  assert.equal(repoSpace(repos[0], 'closed').id, 'main', 'A closed remembered space falls back to the root');
  assert.equal(repoSpace(orphaned).id, 'review');
});

test('held-space actions use its remembered pane, then desktop selection, then first pane', () => {
  const space = { id: 'held', name: 'Held', terminalIds: ['original', 'split'], selectedTerminalId: 'original' };
  assert.equal(spaceTerminal(space, 'split'), 'split');
  assert.equal(spaceTerminal(space, 'other-space-pane'), 'original');
  assert.equal(spaceTerminal({ ...space, selectedTerminalId: undefined }), 'original');
  assert.equal(spaceTerminal({ ...space, terminalIds: [], selectedTerminalId: undefined }), '');
});

test('checkout preview follows Herdr desktop branch slug rules', () => {
  assert.equal(worktreePath('/worktrees/', 'repo', 'issue/137 Worktree_Spaces'), '/worktrees/repo/issue-137-worktree-spaces');
  assert.equal(worktreePath('/worktrees', 'repo', '///'), '/worktrees/repo/worktree');
});

test('space stacks support edge reordering, joining, extraction and closed members without losing spaces', () => {
  let layout = spaceLayout(['a', 'b', 'c', 'd'], []);
  layout = dropSpace(layout, 'a', 'c', 'group');
  assert.deepEqual(layout, { order: ['b', 'c', 'a', 'd'], groups: [['c', 'a']] });
  layout = dropSpace(layout, 'd', 'a', 'group');
  assert.deepEqual(layout.groups, [['c', 'a', 'd']]);
  layout = dropSpace(layout, 'a', 'b', 'before');
  assert.deepEqual(layout, { order: ['a', 'b', 'c', 'd'], groups: [['c', 'd']] });
  layout = dropSpace(layout, 'c', 'b', 'after');
  assert.deepEqual(layout, { order: ['a', 'b', 'c', 'd'], groups: [] });
  assert.equal(dropSpace(layout, 'a', 'a', 'group'), layout);
  assert.deepEqual(spaceLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']], ['a', 'c', 'd']), { order: ['a', 'c', 'd'], groups: [] });
  assert.deepEqual(spaceLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c', 'd']]).groups, [['a', 'b'], ['c', 'd']], 'A space belongs to only one stack');
});
