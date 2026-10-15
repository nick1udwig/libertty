import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrLane, statusLanes } from '../src/herdr-lanes.ts';

test('status lanes run from most to least urgent and keep manual order inside each lane', () => {
  const items = [['shell', 'idle'], ['feature', 'working'], ['reading', 'blocked'], ['docs', 'unknown'], ['swipe', 'done'], ['bench', 'working'], ['notify', 'blocked']] as const;
  const lanes = statusLanes([...items], ([, status]) => herdrLane(status));
  assert.deepEqual(lanes.map(lane => [lane.lane, lane.items.map(([name]) => name)]), [
    ['blocked', ['reading', 'notify']], ['done', ['swipe']], ['working', ['feature', 'bench']], ['idle', ['shell', 'docs']],
  ]);
});

test('empty status lanes are omitted', () => {
  assert.deepEqual(statusLanes(['a', 'b'], () => 'working').map(lane => lane.lane), ['working']);
  assert.deepEqual(statusLanes([], () => 'idle'), []);
});
