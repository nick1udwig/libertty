import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLayout, dropSpace, spaceTerminal, worktreePath } from '../src/herdr-spaces.ts';

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
