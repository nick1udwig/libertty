import { decodeBackend, decodeHost, decodeTab, uniqueRecords } from './workspace-decode.ts';
import type { HttpEndpoint, HttpInput, HttpOutput } from './http-contract.ts';
import { type BackendProfile, type HostProfile, type TerminalTab } from './connections.ts';
import type { Fail, Notify } from './notice-model.ts';
import { saved } from './persistence.ts';

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
  endpoint<K extends HttpEndpoint>(
    backend: BackendProfile,
    name: K,
    data: HttpInput<K>,
    session?: string,
    recoverAuth?: boolean,
    signal?: AbortSignal,
  ): Promise<HttpOutput<K>>;
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
  fail: Fail;
}
export function loadWorkspace(primary: BackendProfile): WorkspaceState {
  const backends = [primary, ...uniqueRecords(saved<unknown[]>('backends', []), decodeBackend)];
  const ids = new Set(backends.map((backend) => backend.id));
  const hosts = uniqueRecords(
    saved<unknown[]>('hosts', [
      { id: 'local', name: 'This machine', kind: 'http', backendId: 'primary' },
    ]),
    (value) => decodeHost(value, ids),
  );
  const tabs = uniqueRecords(saved<unknown[]>('tabs', []), (value) => decodeTab(value, ids));
  const selected = saved<string>('activeTab', '');
  const active = tabs.some((tab) => tab.id === selected) ? selected : tabs[0]?.id || '';
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
