import { builtinState, type BuiltinTabState } from './builtin-state.ts';
import type { TerminalTab } from './connections.ts';
import { BUILTIN_VERSION, tabPluginId } from './plugins.ts';
export type ReadingDetail = Pick<TerminalTab, 'name'> &
  Pick<BuiltinTabState, 'readPath' | 'readCapture' | 'readExitCode'>;
export function readingTab(source: TerminalTab, detail: ReadingDetail): TerminalTab {
  return {
    id: crypto.randomUUID(),
    pluginId: 'reading',
    pluginVersion: BUILTIN_VERSION,
    ownsSession: false,
    backendId: source.backendId,
    session: source.session,
    pluginState: {
      ...(builtinState(source).readHerdrTerminal
        ? {
            readHerdrTerminal: builtinState(source).readHerdrTerminal,
            ...(builtinState(source).herdrCore || source.pluginId === 'herdr-core'
              ? { herdrCore: true }
              : {}),
            herdrSession: builtinState(source).herdrSession,
            herdrSource: builtinState(source).herdrSource,
          }
        : {}),
      readPath: detail.readPath,
      readCapture: detail.readCapture,
      readExitCode: detail.readExitCode,
    },
    parentTabId: tabPluginId(source) === 'reading' ? source.parentTabId : source.id,
    lastUsed: Date.now(),
    name: detail.name,
  };
}
