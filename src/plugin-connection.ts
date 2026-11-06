import { builtinState } from './builtin-state.ts';
import type { BackendProfile, HostProfile, TerminalTab } from './connections.ts';
import type { WorkspaceServices } from './workspace-storage.ts';

export interface ConnectionInput {
  readPath?: string;
  herdrSession?: string;
}
export type ConnectionDetails = Partial<Pick<TerminalTab, 'name' | 'readPath' | 'pluginState'>>;
export interface ConnectionContext extends Pick<WorkspaceServices, 'api' | 'endpoint'> {
  host: HostProfile;
  backend: BackendProfile;
  session: string;
  input: ConnectionInput;
  addTerminal(
    backend: BackendProfile,
    session: string,
    name: string,
    hostId?: string,
    parentTabId?: string,
    files?: boolean,
  ): Promise<void>;
}
export interface PluginConnection {
  session: 'terminal' | 'files';
  fields?: 'file' | 'herdr';
  prepare(context: ConnectionContext): Promise<ConnectionDetails | void>;
  matches?(tab: TerminalTab, input: ConnectionInput): boolean;
}

export function terminalConnection(files = false): PluginConnection {
  return {
    session: files ? 'files' : 'terminal',
    async prepare({ host, backend, session, addTerminal }) {
      await addTerminal(backend, session, host.name, host.id, undefined, files);
    },
  };
}
export function herdrConnection(core = false): PluginConnection {
  return {
    session: 'files',
    fields: 'herdr',
    matches: (tab, input) => (builtinState(tab).herdrSession || '') === (input.herdrSession || ''),
    async prepare({ host, backend, session, input, endpoint }) {
      const target = await endpoint(backend, 'api/herdr/connect', {
        source: session,
        session: input.herdrSession || '',
        core,
      });
      return {
        pluginState: { herdrSession: target.herdrSession, herdrSource: target.herdrSource },
        name:
          (core ? 'Herdr Core' : 'Herdr') +
          ' · ' +
          host.name +
          (target.herdrSession ? ' · ' + target.herdrSession : ''),
      };
    },
  };
}
export const selectedFileConnection: PluginConnection = {
  session: 'files',
  fields: 'file',
  async prepare({ backend, session, input, api }) {
    if (!input.readPath) throw new Error('Enter a file path.');
    const read = await api<{ path: string }>(
      backend,
      'api/plugins/read?' + new URLSearchParams({ path: input.readPath, session }),
    );
    return { readPath: read.path };
  },
};
