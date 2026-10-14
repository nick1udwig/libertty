import type { TerminalTab } from './connections.ts';
import { BUILTIN_VERSION, tabPluginId } from './plugins.ts';
export function readingTab(source: TerminalTab, detail: Pick<TerminalTab, 'name' | 'readPath' | 'readCapture' | 'readExitCode'>): TerminalTab {
  return { id: crypto.randomUUID(), pluginId: 'reading', pluginVersion: BUILTIN_VERSION, ownsSession: false,
    backendId: source.backendId, session: source.session,
    parentTabId: tabPluginId(source) === 'reading' ? source.parentTabId : source.id,
    lastUsed: Date.now(), ...detail };
}
