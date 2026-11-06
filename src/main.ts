import { builtinState, builtinStateCodecs } from './builtin-state.ts';
import type { Connected } from './generated/protocol.ts';
import { sendToTerminal } from './frame-protocol.ts';
import { isHerdrPlugin } from './plugins.ts';
import { requestJSON } from './api.ts';
import { backendAccess, forgetBackendAccess, rememberBackendAccess } from './backend-access.ts';
import { BrowserVault } from './browser-vault.ts';
import { builtinPlugins } from './builtin-plugins.ts';
import {
  backendURL,
  type BackendProfile,
  type KeyInfo,
  type KnownHost,
  type TerminalTab,
} from './connections.ts';
import { $, dialog, input } from './dom.ts';
import { externalPlugin } from './external-plugin.ts';
import { HerdrNotifications } from './herdr-notifications.ts';
import { herdrSession } from './herdr-protocol.ts';
import { HerdrSounds } from './herdr-sounds.ts';
import { MountedTabs } from './mounted-tabs.ts';
import { validCapture, validPath, validSession } from './persistence.ts';
import { selectedFileReader } from './plugin-file.ts';
import { type PluginPackage } from './plugin-package.ts';
import { BUILTIN_VERSION, PluginRegistry, tabPluginId } from './plugins.ts';
import { createWorkspaceConnections } from './workspace-connections.ts';
import { createWorkspaceLibrary } from './workspace-library.ts';
import { createWorkspaceNavigation } from './workspace-navigation.ts';
import { createWorkspaceSettings } from './workspace-settings.ts';
import { loadWorkspace, saveWorkspace, type WorkspaceServices } from './workspace-storage.ts';
import './workspace.css';
const browserVault = new BrowserVault();
const primary: BackendProfile = {
  id: 'primary',
  name: 'Primary backend',
  url: new URL('.', document.baseURI).href,
};
const tokens = new Map<string, string>(),
  vaults = new Map<string, { keys: KeyInfo[]; knownHosts: KnownHost[] }>();
const plugins = new PluginRegistry(builtinStateCodecs);
const mounts = new MountedTabs();
const pluginViews = mounts.views;
const herdrSounds = new HerdrSounds();
const authenticating = new Map<string, Promise<void>>();
const workspace = loadWorkspace(primary, plugins);
const backendFor = (id: string) => workspace.backends.find((b) => b.id === id)!;
function store() {
  saveWorkspace(workspace, notice);
}
const services: WorkspaceServices = {
  api,
  endpoint: api,
  authenticate,
  backendFor,
  tokenFor,
  store,
  notice: (...args) => navigation.notice(...args),
  fail: (error) => navigation.fail(error),
};
const navigation = createWorkspaceNavigation({
  ...services,
  workspace,
  populate: (...args) => library.populate(...args),
  renderSettings: (...args) => settings.renderSettings(...args),
  renderCards: (...args) => library.renderCards(...args),
  plugins,
  editHost: (...args) => library.editHost(...args),
  mounts,
  cancelReconnect: (id) => connections.cancelReconnect(id),
  authorizeTerminals,
  capturedSSH: (...args) => connections.capturedSSH(...args),
  capturedHerdr: (...args) => connections.capturedHerdr(...args),
});
const {
  unmount,
  mount,
  notice,
  fail,
  hideTerminalLoading,
  showTerminalLoading,
  activate,
  addTerminal,
  hostTabs,
  show,
  tabLabel,
  renderTabs,
  closeHostMenu,
  openHostMenu,
  hostMenu,
  closeTabSession,
  terminalURL,
  openReading,
  updateViewVisibility,
  lockedTerminals,
  openReadingCapture,
} = navigation;
const connections = createWorkspaceConnections({
  ...services,
  workspace,
  unmount,
  mount,
  hideTerminalLoading,
  showTerminalLoading,
  activate,
  addTerminal,
  vaults,
  hostTabs,
  plugins,
  show,
  browserVault,
});
const { capturedHerdr, openHost, routes, configureConnection, reconnectHerdr } = connections;

const herdrNotifications = new HerdrNotifications(
  <T>(id: string, name: string, data?: unknown) => api<T>(backendFor(id), name, data),
  () => {
    for (const [id, view] of pluginViews) {
      if (!view.updatePresence) continue;
      view.updatePresence();
      const tab = workspace.tabs.find((tab) => tab.id === id);
      if (tab)
        void herdrNotifications
          .watch(
            tab.backendId,
            tab.id,
            herdrSession(builtinState(tab).herdrSession),
            builtinState(tab).herdrSource,
            tab.pluginId === 'herdr-core',
          )
          .catch(fail);
    }
  },
);
const library = createWorkspaceLibrary({
  ...services,
  workspace,
  closeHostMenu,
  show,
  openHost,
  hostTabs,
  openHostMenu,
  hostMenu,
  herdrNotifications,
  routes,
  tokens,
  browserVault,
  vaults,
  primary,
  navigation,
});

for (const plugin of builtinPlugins({
  active: (tab) => workspace.tabs.includes(tab),
  backend: (tab) => backendFor(tab.backendId),
  host: (id) => workspace.hosts.find((host) => host.id === id),
  authenticate,
  token: tokenFor,
  api,
  connect: (host, id) => configureConnection(host, id),
  closeSession: closeTabSession,
  reconnectHerdr,
  resumeHerdr: connections.resumeHerdr,
  store,
  notice,
  fail,
  tabState: navigation.tabState,
  terminalURL,
  openReading,
  openReadingCapture,
  toggleTerminalTabs: navigation.toggleTerminalTabs,
  ready(tab) {
    if (tab.id === workspace.active) updateViewVisibility();
  },
  attention: navigation.attention,
  notification: (connection, event) => herdrSounds.play(connection, event),
  notificationDevice: (id) => herdrNotifications.device(id),
  watch: (tab) =>
    herdrNotifications.watch(
      tab.backendId,
      tab.id,
      herdrSession(builtinState(tab).herdrSession),
      builtinState(tab).herdrSource,
      tab.pluginId === 'herdr-core',
    ),
  unwatch: (tab) => herdrNotifications.unwatch(tab.backendId, tab.id),
}))
  plugins.register(plugin);
const settings = createWorkspaceSettings({
  ...services,
  workspace,
  registerExternal,
  plugins,
  pluginViews,
  herdrNotifications,
  tabLabel,
  unmount,
  mount,
  renderTabs,
  frame: (id) => mounts.frame(id),
});
const selectedFileReaders = new WeakMap<TerminalTab, ReturnType<typeof selectedFileReader>>();
function registerExternal(pkg: PluginPackage) {
  plugins.register(
    externalPlugin(pkg, {
      connect: (host, pkg) => configureConnection(host, pkg.manifest.id, pkg),
      close: closeTabSession,
      store,
      async read(tab) {
        if (!tab.readPath)
          throw new Error('This connection has no file permission. Reconnect and select a file.');
        const backend = backendFor(tab.backendId),
          url = new URL(
            'api/plugins/read?' + new URLSearchParams({ path: tab.readPath, session: tab.session }),
            backend.url,
          );
        let reader = selectedFileReaders.get(tab);
        if (!reader) {
          reader = selectedFileReader();
          selectedFileReaders.set(tab, reader);
        }
        const token = tokenFor(backend);
        try {
          return await reader(url, token);
        } catch (error: any) {
          if (error.status !== 401) throw error;
          if (tokenFor(backend) === token) await authenticate(backend, true);
          else await authenticating.get(backend.id);
          return reader(url, tokenFor(backend));
        }
      },
    }),
  );
}

function tokenFor(backend: BackendProfile) {
  return tokens.get(backend.id) || backendAccess(backend.url);
}
function authorizeTerminals(backend: BackendProfile, accessToken: string) {
  tokens.set(backend.id, accessToken);
  rememberBackendAccess(backend.url, accessToken);
  for (const id of lockedTerminals) {
    if (workspace.tabs.find((tab) => tab.id === id)?.backendId !== backend.id) continue;
    lockedTerminals.delete(id);
    sendToTerminal(mounts.frame(id)?.contentWindow, { type: 'authorize', accessToken });
  }
}
async function api<T>(
  backend: BackendProfile,
  name: string,
  data?: unknown,
  session?: string,
  recoverAuth = true,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(name, backend.url);
  if (session) url.searchParams.set('session', session);
  return requestJSON<T>(url, data, {
    token: () => tokenFor(backend),
    signal,
    ...(name !== 'api/connect' && recoverAuth
      ? {
          recoverAuth: async (rejected?: string) => {
            if (tokenFor(backend) === rejected) await authenticate(backend, true);
            else await authenticating.get(backend.id);
          },
        }
      : {}),
  });
}
let loginQueue: Promise<unknown> = Promise.resolve();
function authenticate(backend: BackendProfile, force = false): Promise<void> {
  if (!force && tokens.has(backend.id)) return Promise.resolve();
  if (authenticating.has(backend.id)) return authenticating.get(backend.id)!;
  const work = (async () => {
    if (force) {
      tokens.delete(backend.id);
      forgetBackendAccess(backend.url);
    }
    const save = (accessToken: string) => authorizeTerminals(backend, accessToken);
    try {
      const result = await api<Connected>(backend, 'api/connect', {
        noSession: true,
      });
      save(result.accessToken);
      return;
    } catch (error: any) {
      if (error.status !== 401)
        throw new Error(
          `Cannot reach ${backend.name}. Check its URL, network access, and allowed frontend origin.`,
        );
    }
    const prompt = loginQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          $('backend-login-name').textContent = backend.name + ' · ' + backend.url;
          $('backend-login-error').textContent = '';
          input('backend-token').value = '';
          const modal = dialog('backend-login');
          const close = () => {
            modal.removeEventListener('close', close);
            reject(Object.assign(new Error('Backend login cancelled.'), { cancelled: true }));
          };
          modal.addEventListener('close', close);
          $<HTMLFormElement>('backend-login-form').onsubmit = async (event) => {
            event.preventDefault();
            try {
              const result = await api<Connected>(backend, 'api/connect', {
                noSession: true,
                token: input('backend-token').value,
              });
              save(result.accessToken);
              input('backend-token').value = '';
              modal.removeEventListener('close', close);
              modal.close();
              resolve();
            } catch (error: any) {
              $('backend-login-error').textContent = error.message;
            }
          };
          modal.showModal();
        }),
    );
    loginQueue = prompt.catch(() => {});
    await prompt;
  })().finally(() => authenticating.delete(backend.id));
  authenticating.set(backend.id, work);
  return work;
}

for (const element of document.querySelectorAll<HTMLElement>('[data-close]'))
  element.onclick = () => dialog(element.dataset.close!).close();
for (const id of ['ssh-dialog', 'key-dialog', 'backend-login', 'key-transfer'])
  dialog(id).addEventListener('close', () => {
    for (const secret of dialog(id).querySelectorAll<HTMLInputElement>('input[type=password]'))
      secret.value = '';
    input('ssh-secret').value = '';
    $<HTMLTextAreaElement>('key-import').value = '';
    input('key-import-file').value = '';
  });
show('terminal');
async function boot() {
  try {
    if (!workspace.tabs.length) await addTerminal(primary, 'default', 'This machine', 'local');
    else {
      if (!workspace.tabs.some((tab) => tab.id === workspace.active))
        workspace.active = workspace.tabs[0].id;
      store();
      renderTabs();
      // Hidden Herdr views retain notification metadata without mounting terminal panes.
      const active = workspace.tabs.find((tab) => tab.id === workspace.active)!;
      await mount(active).catch(fail);
      void idle().then(() =>
        Promise.all(
          workspace.tabs
            .filter((tab) => tab !== active && isHerdrPlugin(tabPluginId(tab)))
            .map((tab) => mount(tab).catch(fail)),
        ),
      );
    }
    await consumePendingReading();
    await consumePendingHerdr();
    const route = new URLSearchParams(location.search);
    if (route.has('notificationTab')) {
      await openHerdrNotification(route.get('notificationTab'), route.get('notificationTerminal'));
      route.delete('notificationTab');
      route.delete('notificationTerminal');
      history.replaceState(
        null,
        '',
        location.pathname + (route.size ? '?' + route : '') + location.hash,
      );
    }
  } catch (error: any) {
    $('empty-terminal').querySelector('p')!.textContent = error.message;
  }
}
function idle() {
  return new Promise<void>((resolve) =>
    'requestIdleCallback' in window
      ? requestIdleCallback(() => resolve(), { timeout: 2000 })
      : setTimeout(resolve, 500),
  );
}
void boot();
async function openHerdrNotification(tabId: unknown, terminalId: unknown) {
  const tab = workspace.tabs.find((tab) => tab.id === tabId && isHerdrPlugin(tabPluginId(tab)));
  if (!tab) {
    notice('This Herdr connection has closed. Open its host to view the agent.', 'warning');
    return;
  }
  workspace.active = tab.id;
  store();
  show('terminal');
  await mount(tab);
  renderTabs();
  if (typeof terminalId === 'string') pluginViews.get(tab.id)?.openTerminal?.(terminalId);
}
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'herdr-notification')
    void openHerdrNotification(event.data.tabId, event.data.terminalId).catch(fail);
});
async function pendingSource(backendUrl: string, session: string) {
  const url = backendURL(backendUrl);
  let backend = workspace.backends.find((item) => item.url === url);
  if (!backend) {
    backend = { id: crypto.randomUUID(), name: new URL(url).host, url };
    workspace.backends.push(backend);
  }
  let source = workspace.tabs.find(
    (tab) =>
      tabPluginId(tab) === 'terminal' && tab.backendId === backend.id && tab.session === session,
  );
  if (!source) {
    source = {
      pluginId: 'terminal',
      pluginVersion: BUILTIN_VERSION,
      id: crypto.randomUUID(),
      name: backend.name,
      backendId: backend.id,
      session,
      lastUsed: Date.now(),
    };
    workspace.tabs.push(source);
    store();
    await mount(source);
  }
  return { backend, source };
}
async function consumePendingHerdr() {
  try {
    const key = 'libertty.pendingHerdr:' + new URL('.', document.baseURI).pathname;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    sessionStorage.removeItem(key);
    const request = JSON.parse(raw);
    if (
      !validCapture(request.id) ||
      typeof request.session !== 'string' ||
      !validSession(request.session)
    )
      return;
    const { backend, source } = await pendingSource(request.backendUrl, request.session);
    await capturedHerdr(backend, source, request.id);
  } catch (error: any) {
    notice(error.message || 'Herdr could not open.');
  }
}
async function consumePendingReading() {
  try {
    const key = 'libertty.pendingReading:' + new URL('.', document.baseURI).pathname;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    sessionStorage.removeItem(key);
    const request = JSON.parse(raw);
    const captured =
      validCapture(request.capture) &&
      typeof request.name === 'string' &&
      request.name.length <= 180 &&
      Number.isInteger(request.exitCode) &&
      request.exitCode >= 0 &&
      request.exitCode <= 255;
    if (
      (!captured && !validPath(request.path)) ||
      typeof request.backendUrl !== 'string' ||
      typeof request.session !== 'string' ||
      !validSession(request.session)
    )
      return;
    const { source } = await pendingSource(request.backendUrl, request.session);
    const readingSource =
      typeof request.herdrTerminal === 'string' &&
      request.herdrTerminal.length <= 512 &&
      (!request.herdrSource || validSession(request.herdrSource))
        ? {
            ...source,
            pluginState: {
              ...builtinState(source),
              readHerdrTerminal: request.herdrTerminal,
              herdrCore: request.herdrCore === true,
              herdrSession: herdrSession(request.herdrSession),
              herdrSource: request.herdrSource || undefined,
            },
          }
        : source;
    if (captured)
      openReadingCapture(readingSource, request.capture, request.name, request.exitCode);
    else openReading(readingSource, request.path);
  } catch (error: any) {
    notice(error?.message || 'Reading Mode could not open this file.');
  }
}
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  navigator.serviceWorker
    .register(new URL('sw.js', document.baseURI), {
      scope: new URL('.', document.baseURI).pathname,
    })
    .catch(() => {});
