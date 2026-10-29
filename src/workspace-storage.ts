import {
  backendURL,
  type BackendProfile,
  type HostProfile,
  type TerminalTab,
} from './connections.ts';
import type { Notify } from './notice-model.ts';
import { saved, validSession } from './persistence.ts';

export interface WorkspaceState {
  backends: BackendProfile[];
  hosts: HostProfile[];
  tabs: TerminalTab[];
  active: string;
}
export type WorkspacePage =
  | 'terminal'
  | 'hosts'
  | 'vault'
  | 'keychain'
  | 'backends'
  | 'known'
  | 'settings';
export interface WorkspaceServices {
  api: <T>(
    backend: BackendProfile,
    name: string,
    data?: unknown,
    session?: string,
    recoverAuth?: boolean,
    signal?: AbortSignal,
  ) => Promise<T>;
  authenticate: (backend: BackendProfile, force?: boolean) => Promise<void>;
  backendFor: (id: string) => BackendProfile;
  tokenFor: (backend: BackendProfile) => string | undefined;
  store: () => void;
  notice: Notify;
}
export function loadWorkspace(primary: BackendProfile): WorkspaceState {
  let backends: BackendProfile[] = saved<BackendProfile[]>('backends', []).filter((b) => {
    try {
      return (
        b &&
        typeof b.id === 'string' &&
        b.id !== 'primary' &&
        typeof b.name === 'string' &&
        backendURL(b.url) === b.url
      );
    } catch {
      return false;
    }
  });
  backends.unshift(primary);
  let hosts: HostProfile[] = saved<HostProfile[]>('hosts', [
    { id: 'local', name: 'This machine', kind: 'http', backendId: 'primary' },
  ]).filter(
    (h) =>
      h &&
      typeof h.id === 'string' &&
      typeof h.name === 'string' &&
      ['http', 'ssh', 'herdr'].includes(h.kind) &&
      backends.some((b) => b.id === h.backendId),
  );
  let tabs: TerminalTab[] = saved<TerminalTab[]>('tabs', []).filter(
    (t) =>
      t &&
      typeof t.id === 'string' &&
      typeof t.name === 'string' &&
      typeof t.pluginId === 'string' &&
      !!t.pluginId &&
      typeof t.pluginVersion === 'string' &&
      !!t.pluginVersion &&
      backends.some((b) => b.id === t.backendId) &&
      validSession(t.session),
  );
  let active = saved<string>('activeTab', '') || tabs[0]?.id || '';
  return { backends, hosts, tabs, active };
}
export function saveWorkspace(workspace: WorkspaceState, notice: WorkspaceServices['notice']) {
  try {
    for (const [key, value] of Object.entries({
      backends: workspace.backends.filter((b) => b.id !== 'primary'),
      hosts: workspace.hosts,
      tabs: workspace.tabs,
      activeTab: workspace.active,
    }))
      localStorage.setItem('libertty.' + key, JSON.stringify(value));
  } catch {
    notice('Browser storage is unavailable. Connections will last for this page only.', 'warning');
  }
}
