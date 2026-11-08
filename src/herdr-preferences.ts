import { HerdrState } from './herdr-state.ts';
import { herdrLaneNames, type HerdrLane } from './herdr-lanes.ts';
export interface Preferences {
  order: string[];
  spaceOrder?: string[];
  spaceGroups?: string[][];
  separateSpaces?: string[];
  collapsedGroups?: string[];
  collapsedLanes?: HerdrLane[];
  spaceTerminals?: Record<string, string>;
  repoSpaces?: Record<string, string>;
  selected?: string;
  state?: ReturnType<HerdrState['checkpoint']>;
}
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
function stringMap(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};
}
export function decodePreferences(value: unknown): Preferences {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    order: strings(input.order),
    spaceOrder: strings(input.spaceOrder),
    separateSpaces: strings(input.separateSpaces),
    spaceGroups: Array.isArray(input.spaceGroups)
      ? input.spaceGroups.map(strings).filter((group) => group.length)
      : [],
    collapsedGroups: strings(input.collapsedGroups),
    collapsedLanes: Array.isArray(input.collapsedLanes)
      ? strings(input.collapsedLanes).filter((lane): lane is HerdrLane =>
          Object.hasOwn(herdrLaneNames, lane),
        )
      : ['idle'],
    spaceTerminals: stringMap(input.spaceTerminals),
    repoSpaces: stringMap(input.repoSpaces),
    selected: typeof input.selected === 'string' ? input.selected : undefined,
    state: new HerdrState(input.state).checkpoint(),
  };
}
