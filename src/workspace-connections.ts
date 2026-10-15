import { BrowserVault } from './browser-vault.ts';
import {
  type BackendProfile,
  type HostProfile,
  type KeyInfo,
  type KnownHost,
  type SSHConnection,
  type TerminalTab,
} from './connections.ts';
import { $, dialog, input, select } from './dom.ts';
import { herdrSession } from './herdr-protocol.ts';
import { validPath } from './persistence.ts';
import { type PluginPackage } from './plugin-package.ts';
import { PluginRegistry, tabPluginId } from './plugins.ts';
import type { WorkspacePage, WorkspaceServices, WorkspaceState } from './workspace-storage.ts';
interface Options
  extends Pick<
    WorkspaceServices,
    'api' | 'authenticate' | 'backendFor' | 'tokenFor' | 'store' | 'notice'
  > {
  workspace: WorkspaceState;
  unmount: (tab: TerminalTab) => void;
  mount: (tab: TerminalTab) => Promise<void>;
  hideTerminalLoading: (id: string) => void;
  showTerminalLoading: (id: string, waitForPrompt?: boolean) => void;
  activate: (id: string) => void;
  addTerminal: (
    backend: BackendProfile,
    session: string,
    name: string,
    hostId?: string,
    parentTabId?: string,
    files?: boolean,
  ) => Promise<void>;
  vaults: Map<string, { keys: KeyInfo[]; knownHosts: KnownHost[] }>;
  hostTabs: (host: HostProfile) => TerminalTab[];
  plugins: PluginRegistry;
  show: (view: WorkspacePage) => void;
  browserVault: BrowserVault;
}
export function createWorkspaceConnections(options: Options) {
  const {
    workspace,
    api,
    unmount,
    mount,
    store,
    notice,
    hideTerminalLoading,
    showTerminalLoading,
    activate,
    addTerminal,
    vaults,
    hostTabs,
    plugins,
    show,
    backendFor,
    authenticate,
    browserVault,
    tokenFor,
  } = options;
  const herdrReconnects = new Map<
    string,
    { promise: Promise<void>; resolve(): void; reject(error: unknown): void }
  >();
  const captureRequests = new Set<string>();
  let captureQueue: Promise<unknown> = Promise.resolve();
  async function capturedHerdr(backend: BackendProfile, parent: TerminalTab, id: string) {
    const requestKey = backend.id + ':herdr:' + id;
    if (captureRequests.has(requestKey)) return;
    captureRequests.add(requestKey);
    try {
      const result = await api<{
        herdrSession: string;
        herdrSource: string;
        name: string;
        remote: boolean;
      }>(backend, 'api/herdr/captured', { id }, parent.session);
      const source = result.herdrSource || undefined;
      let host = workspace.hosts.find(
        (host) =>
          host.kind === 'herdr' &&
          host.backendId === backend.id &&
          (host.herdrSession || '') === result.herdrSession &&
          (host.herdrSource === source ||
            (result.remote && parent.hostId && host.herdrSourceHostId === parent.hostId)),
      );
      if (!host) {
        const sourceHost = workspace.hosts.find((host) => host.id === parent.hostId);
        host = {
          id: crypto.randomUUID(),
          name: result.name + (result.remote ? ' · ' + (sourceHost?.name || parent.name) : ''),
          kind: 'herdr',
          backendId: backend.id,
          herdrSession: result.herdrSession,
          herdrSource: source,
          herdrSourceHostId: parent.hostId,
        };
        workspace.hosts.push(host);
      }
      if (host.herdrSource !== source) {
        host.herdrSource = source;
        for (const tab of workspace.tabs.filter(
          (tab) => tabPluginId(tab) === 'herdr' && tab.hostId === host.id,
        )) {
          tab.herdrSource = source;
          unmount(tab);
          await mount(tab);
        }
      }
      store();
      await openHost(host);
      await api(backend, 'api/herdr/captured', { id, action: 'ack' }, parent.session);
    } catch (error: any) {
      notice(error.message);
      await api(backend, 'api/herdr/captured', { id, action: 'cancel' }, parent.session).catch(
        () => {},
      );
    } finally {
      hideTerminalLoading(parent.id);
      captureRequests.delete(requestKey);
    }
  }
  function capturedSSH(backend: BackendProfile, parent: TerminalTab, id: string, command: string) {
    const key = backend.id + ':' + id;
    if (captureRequests.has(key)) return;
    captureRequests.add(key);
    const work = captureQueue
      .then(async () => {
        const request = (data: object) =>
          api<{
            native?: boolean;
            message?: string;
            id: string;
            name: string;
            host: string;
            port: number;
            username: string;
            key?: KeyInfo;
          }>(backend, 'api/ssh/captured', { id, ...data }, parent.session);
        let trust: string | undefined;
        const attempt = async (passphrase?: string) => {
          showTerminalLoading(parent.id);
          let result;
          try {
            result = await request({ passphrase, trust });
          } catch (error: any) {
            if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
            if (
              !confirm(
                `Verify the SSH host fingerprint through ${backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`,
              )
            ) {
              await request({ action: 'cancel' });
              hideTerminalLoading(parent.id);
              return true;
            }
            trust = error.fingerprint;
            result = await request({ passphrase, trust });
          }
          if (result.native) {
            await request({ action: 'ack' });
            hideTerminalLoading(parent.id);
            if (result.message) notice(result.message);
            return true;
          }
          const existing = workspace.tabs.find(
            (tab) =>
              tabPluginId(tab) === 'terminal' &&
              tab.backendId === backend.id &&
              tab.session === result.id,
          );
          if (existing) {
            hideTerminalLoading(parent.id);
            activate(existing.id);
            await request({ action: 'ack' });
            return true;
          }
          let host = workspace.hosts.find(
            (h) =>
              h.kind === 'ssh' &&
              h.backendId === backend.id &&
              h.hostname === result.host &&
              h.port === result.port &&
              h.username === result.username,
          );
          if (!host) {
            host = {
              id: crypto.randomUUID(),
              name: result.name,
              kind: 'ssh',
              backendId: backend.id,
              hostname: result.host,
              port: result.port,
              username: result.username,
              route: 'fixed',
            };
            workspace.hosts.push(host);
          }
          if (result.key) {
            host.keyFingerprint = result.key.fingerprint;
            host.backendKeyId = result.key.reference ? result.key.id : undefined;
            host.browserKeyId = undefined;
          }
          store();
          await addTerminal(backend, result.id, host.name, host.id, parent.id);
          await request({ action: 'ack' });
          return true;
        };
        try {
          await attempt();
          return;
        } catch (error: any) {
          hideTerminalLoading(parent.id);
          $('captured-ssh-error').textContent = error.message;
          $('captured-ssh-secret-label').hidden = !error.needsSecret;
          input('captured-ssh-secret').required = !!error.needsSecret;
        }
        await new Promise<void>((resolve) => {
          const modal = dialog('captured-ssh-dialog');
          $('captured-ssh-command').textContent = command;
          input('captured-ssh-secret').value = '';
          const controls = [...modal.querySelectorAll<HTMLButtonElement>('button')];
          const finish = () => {
            hideTerminalLoading(parent.id);
            input('captured-ssh-secret').value = '';
            modal.close();
            resolve();
          };
          const act = async (action: () => Promise<unknown>) => {
            controls.forEach((button) => (button.disabled = true));
            try {
              await action();
              finish();
            } catch (error: any) {
              hideTerminalLoading(parent.id);
              $('captured-ssh-error').textContent = error.message;
              $('captured-ssh-secret-label').hidden = !error.needsSecret;
              input('captured-ssh-secret').required = !!error.needsSecret;
            } finally {
              input('captured-ssh-secret').value = '';
              controls.forEach((button) => (button.disabled = false));
            }
          };
          $<HTMLFormElement>('captured-ssh-form').onsubmit = (event) => {
            event.preventDefault();
            void act(() => attempt(input('captured-ssh-secret').value || undefined));
          };
          $('captured-ssh-cancel').onclick = () => void act(() => request({ action: 'cancel' }));
          $('captured-ssh-native').onclick = () => void act(() => request({ action: 'native' }));
          modal.oncancel = (event) => {
            event.preventDefault();
            if (!controls[0].disabled) $('captured-ssh-cancel').click();
          };
          modal.showModal();
        });
      })
      .catch((error) => {
        captureRequests.delete(key);
        hideTerminalLoading(parent.id);
        notice(error.message);
      });
    captureQueue = work;
    return work;
  }
  let sshHost: HostProfile | undefined;
  const keyValue = (key: KeyInfo) => (key.reference ? 'backend:' + key.id : key.fingerprint);
  const selectedBackendKey = () =>
    vaults
      .get(sshHost?.backendId || '')
      ?.keys.find((key) => keyValue(key) === select('ssh-key').value);
  let selectedRoute: { backend: BackendProfile; keyId?: string; compression?: boolean } | undefined,
    routeGeneration = 0;
  const openingHosts = new Map<string, Promise<void>>();
  interface ConnectionRequest {
    pluginId: string;
    pluginVersion?: string;
    readPath?: string;
    herdrSession?: string;
    herdrTab?: TerminalTab;
    herdrHost?: HostProfile;
  }
  let sshRequest: ConnectionRequest = { pluginId: 'terminal' };
  let pendingConnection: { host: HostProfile; request: ConnectionRequest } | undefined;
  function configureConnection(
    host: HostProfile,
    pluginId: string,
    pkg?: PluginPackage,
  ): Promise<void> {
    if ((pluginId !== 'herdr' && !pkg) || host.kind === 'herdr')
      return openHost(host, true, { pluginId });
    pendingConnection = { host, request: { pluginId, pluginVersion: pkg?.manifest.version } };
    $('plugin-connect-title').textContent = pkg ? pkg.manifest.connectLabel : 'Connect Herdr';
    $('plugin-connect-host').textContent = host.name;
    $('plugin-read-fields').hidden = !pkg;
    input('plugin-read-path').required = !!pkg;
    input('plugin-read-path').value = '';
    $('plugin-herdr-fields').hidden = pluginId !== 'herdr';
    input('plugin-herdr-session').value = host.herdrSession || '';
    $('plugin-connect-error').textContent = '';
    dialog('plugin-connect-dialog').showModal();
    return Promise.resolve();
  }
  $<HTMLFormElement>('plugin-connect-form').onsubmit = (event) => {
    event.preventDefault();
    if (!pendingConnection) return;
    const { host, request } = pendingConnection;
    try {
      if (request.pluginId === 'herdr')
        request.herdrSession = herdrSession(input('plugin-herdr-session').value);
      else {
        const path = input('plugin-read-path').value.trim();
        if (!validPath(path)) throw new Error('Enter a file path.');
        request.readPath = path;
      }
      dialog('plugin-connect-dialog').close();
      pendingConnection = undefined;
      void openHost(host, true, request).catch((error) => notice(error.message));
    } catch (error: any) {
      $('plugin-connect-error').textContent = error.message;
    }
  };
  async function openHost(
    host: HostProfile,
    createNew = false,
    request: ConnectionRequest = { pluginId: host.kind === 'herdr' ? 'herdr' : 'terminal' },
  ) {
    if (!createNew) {
      const open = hostTabs(host).filter((tab) => tabPluginId(tab) === request.pluginId),
        existing =
          open.find((tab) => tab.id === workspace.active) ||
          open.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
      if (existing) {
        if (request.pluginId === 'herdr') await resumeHerdr(existing);
        else activate(existing.id);
        return;
      }
    }
    if (openingHosts.has(host.id)) return openingHosts.get(host.id);
    const work = connectHost(host, request).finally(() => openingHosts.delete(host.id));
    openingHosts.set(host.id, work);
    return work;
  }
  async function finishConnection(
    host: HostProfile,
    backend: BackendProfile,
    session: string,
    request: ConnectionRequest,
  ) {
    if (request.pluginId === 'terminal' || request.pluginId === 'files') {
      await addTerminal(
        backend,
        session,
        host.name,
        host.id,
        undefined,
        request.pluginId === 'files',
      );
      return;
    }
    try {
      const target =
        request.pluginId === 'herdr'
          ? await api<{ herdrSession: string; herdrSource: string }>(backend, 'api/herdr/connect', {
              source: session,
              session: request.herdrSession || '',
            })
          : undefined;
      const read = request.readPath
        ? await api<{ path: string }>(
            backend,
            'api/plugins/read?' + new URLSearchParams({ path: request.readPath, session }),
          )
        : undefined;
      const plugin = plugins.get(request.pluginId, request.pluginVersion);
      if (!plugin) throw new Error('This plugin is no longer available.');
      const tab: TerminalTab = {
        id: request.herdrTab?.id || crypto.randomUUID(),
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        pluginState: null,
        readPath: read?.path,
        ownsSession: true,
        session,
        backendId: backend.id,
        hostId: host.id,
        name:
          plugin.name +
          ' · ' +
          host.name +
          (target?.herdrSession ? ' · ' + target.herdrSession : ''),
        lastUsed: Date.now(),
        ...(target
          ? { mode: 'herdr', herdrSession: target.herdrSession, herdrSource: target.herdrSource }
          : {}),
      };
      if (request.herdrTab && !workspace.tabs.includes(request.herdrTab)) {
        await api(backend, 'api/sessions/close', {}, session);
        return;
      }
      if (target && request.herdrHost) {
        const saved = request.herdrHost;
        saved.backendId = backend.id;
        saved.herdrSource = target.herdrSource;
        tab.hostId = saved.id;
        tab.name = saved.name;
      }
      let connected = tab;
      if (request.herdrTab) {
        connected = request.herdrTab;
        tab.name = connected.name;
        unmount(connected);
        Object.assign(connected, tab, { ended: false });
      } else workspace.tabs.push(tab);
      workspace.active = connected.id;
      store();
      show('terminal');
      await mount(connected);
      if (request.herdrTab) herdrReconnects.get(connected.id)?.resolve();
    } catch (error) {
      await api(backend, 'api/sessions/close', {}, session).catch(() => {});
      throw error;
    }
  }
  async function resumeHerdr(tab: TerminalTab) {
    const backend = backendFor(tab.backendId);
    await authenticate(backend);
    if (!tab.ended) {
      try {
        await api(
          backend,
          'api/herdr/snapshot?' +
            new URLSearchParams({
              herdrSession: tab.herdrSession || '',
              ...(tab.herdrSource ? { herdrSource: tab.herdrSource } : {}),
            }),
        );
      } catch (error: any) {
        if (error.status !== 404 || !tab.herdrSource) throw error;
        tab.ended = true;
        store();
      }
    }
    if (tab.ended) await reconnectHerdr(tab);
    else activate(tab.id);
  }
  function reconnectHerdr(tab: TerminalTab): Promise<void> {
    const existing = herdrReconnects.get(tab.id);
    if (existing) return existing.promise;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    }).finally(() => herdrReconnects.delete(tab.id));
    herdrReconnects.set(tab.id, { promise, resolve, reject });
    void restoreHerdr(tab).then(() => {
      if (!tab.ended) resolve();
    }, reject);
    return promise;
  }
  async function restoreHerdr(tab: TerminalTab) {
    if (!workspace.tabs.includes(tab)) return;
    const host = workspace.hosts.find((host) => host.id === tab.hostId);
    if (!host)
      throw new Error('This connection has no saved host. Open Herdr from its host again.');
    if (host.kind === 'herdr' && !tab.herdrSource) {
      unmount(tab);
      tab.ended = false;
      store();
      activate(tab.id);
      await mount(tab);
      return;
    }
    const source =
      host.kind === 'herdr'
        ? workspace.hosts.find((source) => source.id === host.herdrSourceHostId)
        : host;
    if (!source || source.kind === 'herdr')
      throw new Error(
        'The source host for this Herdr connection is missing. Add the host again and connect Herdr from its menu.',
      );
    if (tab.ownsSession)
      await api(backendFor(tab.backendId), 'api/sessions/close', {}, tab.session);
    await connectHost(source, {
      pluginId: 'herdr',
      herdrSession: tab.herdrSession,
      herdrTab: tab,
      ...(host.kind === 'herdr' ? { herdrHost: host } : {}),
    });
  }
  async function connectHost(host: HostProfile, request: ConnectionRequest) {
    const backend = backendFor(host.backendId);
    await authenticate(backend);
    // Older captured Herdr profiles retain their original transport descriptor.
    if (host.kind === 'herdr') {
      const existing = workspace.tabs.find(
        (tab) =>
          tabPluginId(tab) === 'herdr' &&
          tab.backendId === host.backendId &&
          (tab.herdrSession || '') === (host.herdrSession || '') &&
          tab.herdrSource === host.herdrSource,
      );
      if (existing) {
        await resumeHerdr(existing);
        return;
      }
      const tab: TerminalTab = {
        id: crypto.randomUUID(),
        session: crypto.randomUUID(),
        name: host.name,
        backendId: backend.id,
        hostId: host.id,
        pluginId: 'herdr',
        pluginVersion: '1',
        mode: 'herdr',
        herdrSession: host.herdrSession,
        herdrSource: host.herdrSource,
        lastUsed: Date.now(),
      };
      workspace.tabs.push(tab);
      workspace.active = tab.id;
      store();
      show('terminal');
      await mount(tab);
      return;
    }
    if (request.pluginId === 'herdr' && !request.herdrTab) {
      const existing = workspace.tabs.find(
        (tab) =>
          tabPluginId(tab) === 'herdr' &&
          tab.hostId === host.id &&
          (tab.herdrSession || '') === (request.herdrSession || ''),
      );
      if (existing) {
        await resumeHerdr(existing);
        return;
      }
    }
    if (host.kind === 'http') {
      const result = await api<{ id: string }>(backend, 'api/sessions', {
        name: host.name,
        files: request.pluginId !== 'terminal',
      });
      await finishConnection(host, backend, result.id, request);
      return;
    }
    const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain');
    vaults.set(backend.id, vault);
    sshHost = host;
    sshRequest = request;
    $('ssh-title').textContent = host.name;
    $('ssh-destination').textContent =
      `${host.username}@${host.hostname}:${host.port} · ${backend.name}`;
    select('ssh-key').replaceChildren();
    const browserKeys = await browserVault.list();
    for (const key of browserKeys)
      select('ssh-key').add(new Option(key.name + ' · This browser', 'browser:' + key.id));
    for (const key of vault.keys)
      select('ssh-key').add(
        new Option(
          key.name +
            ' · ' +
            (key.reference
              ? key.reference.type === 'file'
                ? 'Backend file'
                : 'Backend agent'
              : backend.name),
          keyValue(key),
        ),
      );
    select('ssh-key').add(new Option('Account password', 'password'));
    const preferred =
      browserKeys.find((k) => k.id === host.browserKeyId) ||
      browserKeys.find((k) => k.fingerprint === host.keyFingerprint);
    if (host.backendKeyId && vault.keys.some((key) => key.id === host.backendKeyId))
      select('ssh-key').value = keyValue(vault.keys.find((key) => key.id === host.backendKeyId)!);
    else if (preferred) select('ssh-key').value = 'browser:' + preferred.id;
    else if (host.keyFingerprint && vault.keys.some((k) => k.fingerprint === host.keyFingerprint))
      select('ssh-key').value = keyValue(
        vault.keys.find((key) => key.fingerprint === host.keyFingerprint)!,
      );
    input('ssh-secret').value = '';
    input('ssh-show-secret').checked = false;
    input('ssh-secret').type = 'password';
    $('ssh-error').textContent = '';
    $('ssh-progress').textContent = '';
    sshSecretLabel();
    if (selectedBackendKey()?.reference) {
      await prepareRoute();
      if (selectedRoute) {
        await connectSSH();
        return;
      }
    }
    dialog('ssh-dialog').showModal();
    void prepareRoute();
  }
  function sshSecretLabel() {
    input('ssh-secret').required = !selectedBackendKey()?.reference;
    $('ssh-secret-label').textContent =
      select('ssh-key').value === 'password' ? 'Account password' : 'Key passphrase';
  }
  select('ssh-key').onchange = () => {
    sshSecretLabel();
    input('ssh-secret').value = '';
    void prepareRoute();
  };
  input('ssh-show-secret').onchange = () =>
    (input('ssh-secret').type = input('ssh-show-secret').checked ? 'text' : 'password');
  const routes = new Map<
    string,
    { at: number; backend: BackendProfile; keyId?: string; compression?: boolean }
  >();
  async function chooseRoute(
    host: HostProfile,
    keyFingerprint: string,
  ): Promise<{ backend: BackendProfile; keyId?: string; compression?: boolean }> {
    const selected = backendFor(host.backendId),
      localKey = vaults.get(selected.id)?.keys.find((k) => keyValue(k) === keyFingerprint);
    const portable = keyFingerprint === 'password' || keyFingerprint.startsWith('browser:');
    if (!portable && !localKey) throw new Error('Choose a key on this backend.');
    if (host.route === 'fixed' || localKey?.reference)
      return { backend: selected, keyId: localKey?.id };
    const key = JSON.stringify([host.id, keyFingerprint]),
      cached = routes.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached;
    const candidates = workspace.backends.filter((b) => b.id === selected.id || !!tokenFor(b));
    const measurements = await Promise.all(
      candidates.map(async (backend) => {
        try {
          const matching = portable
            ? undefined
            : (await api<{ keys: KeyInfo[] }>(backend, 'api/keychain')).keys.find(
                (k) => keyValue(k) === keyFingerprint,
              );
          if (!portable && !matching) return;
          const samples: number[] = [],
            remote: number[] = [];
          for (let i = 0; i < 2; i++) {
            const start = performance.now();
            const measured = await api<{ milliseconds: number }>(backend, 'api/ssh/probe', {
              host: host.hostname,
              port: host.port,
              username: host.username,
            });
            samples.push(performance.now() - start);
            remote.push(measured.milliseconds);
          }
          return {
            backend,
            keyId: matching?.id,
            latency: (samples[0] + samples[1]) / 2,
            compression: (remote[0] + remote[1]) / 2 >= 40,
          };
        } catch {
          return undefined;
        }
      }),
    );
    const best = measurements
      .filter((m): m is NonNullable<typeof m> => !!m)
      .sort((a, b) => a.latency - b.latency)[0];
    if (!best)
      throw new Error(
        'No connected backend can reach this SSH host with the selected credentials.',
      );
    routes.set(key, { ...best, at: Date.now() });
    return best;
  }
  async function prepareRoute() {
    if (!sshHost) return;
    const generation = ++routeGeneration;
    selectedRoute = undefined;
    input('ssh-secret').disabled = true;
    $<HTMLButtonElement>('ssh-connect').disabled = true;
    $('ssh-error').textContent = '';
    $('ssh-progress').textContent = 'Measuring available routes…';
    try {
      const route = await chooseRoute(sshHost, select('ssh-key').value);
      if (generation !== routeGeneration) return;
      selectedRoute = route;
      $('ssh-progress').textContent = 'Connect through ' + route.backend.name;
      $('ssh-secret-label').textContent =
        select('ssh-key').value === 'password'
          ? 'Account password'
          : select('ssh-key').value.startsWith('browser:')
            ? 'Key passphrase'
            : 'Key passphrase on ' + route.backend.name;
      input('ssh-secret').disabled = false;
      $<HTMLButtonElement>('ssh-connect').disabled = false;
      sshSecretLabel();
    } catch (error: any) {
      if (generation === routeGeneration) {
        $('ssh-error').textContent = error.message;
        $('ssh-progress').textContent = '';
      }
    }
  }
  $<HTMLFormElement>('ssh-form').onsubmit = (event) => {
    event.preventDefault();
    void connectSSH();
  };
  async function connectSSH() {
    if (!sshHost || !selectedRoute) return;
    const host = sshHost,
      request = sshRequest,
      control = $<HTMLButtonElement>('ssh-connect');
    control.disabled = true;
    $('ssh-error').textContent = '';
    $('ssh-progress').textContent = 'Choosing a route…';
    let ssh: SSHConnection | undefined;
    try {
      const selected = select('ssh-key').value,
        route = selectedRoute;
      $('ssh-progress').textContent = 'Connecting through ' + route.backend.name + '…';
      ssh = {
        host: host.hostname!,
        port: host.port!,
        username: host.username!,
        ...(route.compression ? { compression: 'on' } : {}),
        ...(selected.startsWith('browser:')
          ? {
              privateKey: await browserVault.unlock(selected.slice(8), input('ssh-secret').value),
              passphrase: input('ssh-secret').value,
            }
          : route.keyId
            ? { keyId: route.keyId, passphrase: input('ssh-secret').value }
            : { password: input('ssh-secret').value }),
      };
      const create = () =>
        api<{ id: string }>(route.backend, 'api/sessions', {
          name: host.name,
          ssh,
          files: request.pluginId !== 'terminal',
        });
      let result;
      try {
        result = await create();
      } catch (error: any) {
        if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
        if (
          !confirm(
            `Verify the fingerprint for ${ssh.host}:${ssh.port} through ${route.backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`,
          )
        )
          throw new Error('Host verification cancelled.');
        ssh.trust = error.fingerprint;
        result = await create();
      }
      host.browserKeyId = selected.startsWith('browser:') ? selected.slice(8) : undefined;
      host.backendKeyId = selected.startsWith('backend:') ? selected.slice(8) : undefined;
      host.keyFingerprint = host.backendKeyId
        ? selectedBackendKey()?.fingerprint
        : host.browserKeyId
          ? (await browserVault.list()).find((k) => k.id === host.browserKeyId)?.fingerprint
          : selected === 'password'
            ? undefined
            : selected;
      store();
      dialog('ssh-dialog').close();
      await finishConnection(host, route.backend, result.id, request);
    } catch (error: any) {
      if (!dialog('ssh-dialog').open) dialog('ssh-dialog').showModal();
      if (error.needsSecret) input('ssh-secret').required = true;
      $('ssh-error').textContent =
        error.message +
        (error.changed
          ? '\nVerify the new fingerprint before removing its Known hosts entry: ' +
            error.fingerprint
          : '');
    } finally {
      if (ssh) {
        delete ssh.privateKey;
        delete ssh.passphrase;
        delete ssh.password;
      }
      input('ssh-secret').value = '';
      control.disabled = false;
      $('ssh-progress').textContent = '';
    }
  }
  dialog('ssh-dialog').addEventListener('close', () => {
    if (sshRequest.herdrTab && !$<HTMLButtonElement>('ssh-connect').disabled)
      herdrReconnects
        .get(sshRequest.herdrTab.id)
        ?.reject(Object.assign(new Error('Connection cancelled.'), { cancelled: true }));
  });
  function cancelReconnect(id: string) {
    herdrReconnects
      .get(id)
      ?.reject(Object.assign(new Error('Connection closed.'), { cancelled: true }));
  }

  return {
    capturedSSH,
    capturedHerdr,
    openHost,
    routes,
    configureConnection,
    reconnectHerdr,
    cancelReconnect,
  };
}
