import type { HerdrStatus } from './herdr-protocol.ts';

export type HerdrLane = 'blocked' | 'done' | 'working' | 'idle';
export const herdrLaneNames: Record<HerdrLane, string> = { blocked: 'Needs you', done: 'Done', working: 'Working', idle: 'Idle' };
const lanes = Object.keys(herdrLaneNames) as HerdrLane[];

export function herdrLane(status: HerdrStatus): HerdrLane {
  return lanes.find(lane => lane === status) || 'idle';
}

/** Lanes run from most to least urgent, keep manual order inside each lane and omit empty lanes. */
export function statusLanes<T>(items: T[], lane: (item: T) => HerdrLane) {
  return lanes.map(name => ({ lane: name, items: items.filter(item => lane(item) === name) })).filter(group => group.items.length);
}
