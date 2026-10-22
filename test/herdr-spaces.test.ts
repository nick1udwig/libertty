import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLayout, dropSpace, spaceTerminal, worktreePath, spaceRepos, repoSpace, repoTap, triageSpace } from '../src/herdr-spaces.ts';

test('worktrees group under their repository root while other spaces stand alone', () => {
  const space = (id: string, extra = {}) => ({ id, name: id, terminalIds: [id + ':pane'], cwd: '', ...extra });
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
  assert.equal(repoTap(repos[0], 'recent', 'fix')?.space.id, 'fix', 'Tapping a repository reopens its last used checkout by default');
  assert.equal(repoTap(repos[0], 'root', 'fix')?.space.id, 'main');
  assert.equal(repoTap(repos[0], 'tree', 'fix'), undefined, 'The tree setting leaves the choice to the tree');
  assert.equal(repoTap(repos[1], 'tree')?.space.id, 'notes', 'A lone space opens directly in every mode');
});

test('triage opens the checkout that has waited longest in the most urgent state', () => {
  const spaces = ['main', 'review', 'fix', 'docs'].map(id => ({ id, name: id, terminalIds: [id + ':pane'], cwd: '' }));
  const repo = { id: 'repo:/repo/.git', name: 'repo', git: true, root: spaces[0], spaces };
  type Pane = { status: 'blocked' | 'done' | 'working' | 'idle'; sequence: number; completion?: number };
  const pick = (states: Record<string, Pane[]>) => triageSpace(spaces, space => (states[space.id] || []).map(pane => ({ ...pane, terminalId: space.id + ':pane' })))?.space.id;
  assert.equal(pick({ main: [{ status: 'done', sequence: 1, completion: 1 }], fix: [{ status: 'blocked', sequence: 9 }] }), 'fix', 'Needing input beats an unseen finish');
  assert.equal(pick({ review: [{ status: 'done', sequence: 8, completion: 8 }], fix: [{ status: 'done', sequence: 5, completion: 5 }] }), 'fix', 'The oldest unseen finish wins');
  assert.equal(pick({ review: [{ status: 'working', sequence: 7 }], docs: [{ status: 'working', sequence: 3 }], main: [{ status: 'idle', sequence: 1, completion: 1 }] }), 'docs');
  assert.equal(pick({ review: [{ status: 'idle', sequence: 6, completion: 6 }], fix: [{ status: 'idle', sequence: 2, completion: 2 }], docs: [{ status: 'idle', sequence: 1 }] }), 'fix', 'Seen finishes come last and panes that never ran are skipped');
  assert.equal(pick({}), undefined);
  assert.equal(repoTap(repo, 'triage', 'review', () => [])?.space.id, 'review', 'Triage falls back to the last used checkout');
  assert.deepEqual(repoTap(repo, 'triage', 'review', space => space.id === 'docs' ? [{ terminalId: 'docs:agent', status: 'blocked', sequence: 4 }] : []), { space: spaces[3], terminalId: 'docs:agent' }, 'Triage opens the urgent pane itself');
});

test('held-space actions use its remembered pane, then desktop selection, then first pane', () => {
  const space = { id: 'held', name: 'Held', terminalIds: ['original', 'split'], cwd: '', selectedTerminalId: 'original' };
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
