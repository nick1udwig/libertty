import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLayout, dropSpace } from '../src/herdr-spaces.ts';

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
