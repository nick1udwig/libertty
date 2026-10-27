import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserShard } from '../scripts/browser-shards.mjs';

const cases = [145, 117, 97, 87, 70, 40, 30, 20].map((seconds, index) => ['case-' + index, {}, seconds]);
test('shards cover every case exactly once and put the longest work first', () => {
  const shards = [1, 2, 3, 4].map(index => browserShard(cases, index + '/4'));
  assert.deepEqual(shards.flat().map(entry => entry[0]).sort(), cases.map(entry => entry[0]).sort());
  assert.deepEqual(shards.map(shard => shard[0][2]), [145, 117, 97, 87]);
  const totals = shards.map(shard => shard.reduce((sum, entry) => sum + entry[2], 0));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 30);
  assert.deepEqual(browserShard(cases, '2/4'), shards[1]);
  assert.equal(browserShard(cases), cases);
  assert.deepEqual(cases.map(entry => entry[2]), [145, 117, 97, 87, 70, 40, 30, 20]);
});
test('invalid shard selectors fail instead of silently omitting coverage', () => {
  for (const value of ['0/4', '5/4', '1/0', '1/9', '1', '1/2/3', '-1/4', '1.5/4', '1/Infinity', '1/9007199254740993']) {
    assert.throws(() => browserShard(cases, value), /BROWSER_SHARD/);
  }
});
