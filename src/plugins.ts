import type { HostProfile, LegacyReadingTab, TerminalTab } from './connections.ts';

export const BUILTIN_VERSION = '1';
export const builtinIds = ['terminal', 'files', 'herdr', 'reading'] as const;
export function tabPluginId(tab: TerminalTab): string { return tab.pluginId || tab.mode || 'terminal'; }
export function migratePluginTab(tab: TerminalTab): TerminalTab {
  return { ...tab, pluginId: tabPluginId(tab), pluginVersion: tab.pluginVersion || BUILTIN_VERSION };
}
export function migrateReadingTab(tab: LegacyReadingTab): TerminalTab {
  const { path, capture, exitCode, sourceTabId, ...base } = tab;
  return { ...base, pluginId: 'reading', pluginVersion: BUILTIN_VERSION, ownsSession: false,
    readPath: path, readCapture: capture, readExitCode: exitCode, parentTabId: sourceTabId };
}

export interface PluginView {
  element: HTMLElement;
  setVisible(visible: boolean): void;
  dispose(): void;
  focus?(): void;
  applySettings?(): void;
  copySelection?(): void;
}
export interface TabPlugin {
  id: string;
  version: string;
  name: string;
  connectLabel: string;
  icon: string;
  iconHTML?: string;
  panelPrefix: string;
  className?: string;
  available(host: HostProfile): boolean;
  connect(host: HostProfile): Promise<void>;
  mount(tab: TerminalTab): Promise<PluginView>;
  close(tab: TerminalTab): Promise<boolean>;
}

/** Versions stay registered so an update never silently replaces an open tab. */
export class PluginRegistry {
  private versions = new Map<string, TabPlugin>();
  private current = new Map<string, TabPlugin>();
  private disabled = new Set<string>();
  register(plugin: TabPlugin) {
    const key = this.key(plugin.id, plugin.version);
    if (this.versions.has(key)) throw new Error('This plugin version is already installed.');
    this.versions.set(key, plugin); this.current.set(plugin.id, plugin);
  }
  private key(id: string, version: string) { return JSON.stringify([id, version]); }
  get(id: string, version?: string): TabPlugin | undefined {
    if (this.disabled.has(id)) return;
    return version ? this.versions.get(this.key(id, version)) : this.current.get(id);
  }
  forTab(tab: TerminalTab) { return this.get(tabPluginId(tab), tab.pluginVersion || BUILTIN_VERSION); }
  actions(host: HostProfile) { return [...this.current.values()].filter(plugin => !this.disabled.has(plugin.id) && plugin.available(host)); }
  enable(id: string, enabled: boolean) { if (enabled) this.disabled.delete(id); else this.disabled.add(id); }
  remove(id: string) {
    for (const [key, plugin] of this.versions) if (plugin.id === id) this.versions.delete(key);
    this.current.delete(id); this.disabled.delete(id);
  }
}
