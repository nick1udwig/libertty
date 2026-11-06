import type { TerminalTab } from './connections.ts';
import { BUILTIN_VERSION, type PluginStateCodec } from './plugins.ts';
import { validCapture, validPath } from './persistence.ts';
import { herdrSession } from './herdr-protocol.ts';

export interface BuiltinTabState {
  directory?: string;
  readPath?: string;
  readCapture?: string;
  readExitCode?: number;
  readHerdrTerminal?: string;
  herdrCore?: boolean;
  herdrSession?: string;
  herdrSource?: string;
}
export function builtinState(tab: TerminalTab): BuiltinTabState {
  return (tab.pluginState ??= {}) as BuiltinTabState;
}
const validators = {
  directory: validPath,
  readPath: validPath,
  readCapture: validCapture,
  readExitCode: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255,
  readHerdrTerminal: (value: unknown) => typeof value === 'string',
  herdrCore: (value: unknown) => typeof value === 'boolean',
  herdrSession: (value: unknown) => {
    herdrSession(value);
    return value !== undefined;
  },
  herdrSource: (value: unknown) => typeof value === 'string',
} satisfies Record<keyof BuiltinTabState, (value: unknown) => boolean>;
function codec(
  ownsSession: boolean,
  fields: readonly (keyof BuiltinTabState)[],
): PluginStateCodec<BuiltinTabState> {
  return {
    ownsSession,
    decode(value, legacy) {
      const source =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : legacy;
      return Object.fromEntries(
        fields
          .filter((key) => validators[key](source[key]))
          .map((key) => [key, key === 'herdrSession' ? herdrSession(source[key]) : source[key]]),
      );
    },
  };
}
const herdrFields = ['herdrSession', 'herdrSource', 'herdrCore'] as const;
export const builtinStateCodecs = [
  { id: 'terminal', version: BUILTIN_VERSION, state: codec(true, []) },
  { id: 'files', version: BUILTIN_VERSION, state: codec(true, ['directory']) },
  { id: 'herdr', version: BUILTIN_VERSION, state: codec(false, herdrFields) },
  { id: 'herdr-core', version: BUILTIN_VERSION, state: codec(false, herdrFields) },
  {
    id: 'reading',
    version: BUILTIN_VERSION,
    state: codec(false, [
      ...herdrFields,
      'readPath',
      'readCapture',
      'readExitCode',
      'readHerdrTerminal',
    ]),
  },
];
