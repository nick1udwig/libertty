import { builtinState, builtinStateCodecs } from './builtin-state.ts';
import type { HttpEndpoint, HttpInput, HttpOutput } from './http-contract.ts';
import { sendToTerminal } from './frame-protocol.ts';
import type { BackendProfile, HostProfile, TerminalTab } from './connections.ts';
import { folderIcon, terminalIcon, herdrIcon } from './icons.ts';
import { fileBrowser } from './file-browser.ts';
import { fileClient } from './file-client.ts';
import { herdrSession } from './herdr-protocol.ts';
import type { Fail, NoticeInput, Notify } from './notice-model.ts';
import type { HerdrView } from './herdr-view.ts';
import { BUILTIN_VERSION, type TabPlugin } from './plugins.ts';
import { readingPlugin, type ReadingServices } from './reading-plugin.ts';
import { terminalCanEvict } from './terminal-retention.ts';
import { herdrConnection, terminalConnection } from './plugin-connection.ts';

export interface BuiltinServices extends ReadingServices {
  active(tab: TerminalTab): boolean;
  host(id?: string): HostProfile | undefined;
  api<T>(
    backend: BackendProfile,
    name: string,
    data?: unknown,
    session?: string,
    recoverAuth?: boolean,
    signal?: AbortSignal,
  ): Promise<T>;
  connect(host: HostProfile, pluginId: string): Promise<void>;
  closeSession(tab: TerminalTab): Promise<void>;
  openReadingCapture(tab: TerminalTab, capture: string, name: string, exitCode?: number): void;
  reconnectHerdr(tab: TerminalTab): Promise<void>;
  resumeHerdr(tab: TerminalTab): Promise<void>;
  store(): void;
  notice: Notify;
  fail: Fail;
  tabState(tab: TerminalTab, key: string, state?: NoticeInput): void;
  terminalURL(backend: BackendProfile, session: string): string;
  toggleTerminalTabs(tab: TerminalTab): void;
  ready(tab: TerminalTab): void;
  attention(tab: TerminalTab, count: number): void;
  notification(
    connection: string,
    event: Parameters<ConstructorParameters<typeof HerdrView>[0]['notification']>[0],
  ): void;
  notificationDevice(backendId: string): string | undefined;
  watch(tab: TerminalTab): Promise<void>;
  unwatch(tab: TerminalTab): Promise<void>;
}

export function builtinPlugins(s: BuiltinServices): TabPlugin[] {
  const common = {
    version: BUILTIN_VERSION,
    available: (host: HostProfile) => host.kind !== 'herdr',
  };
  const plugins: TabPlugin[] = [
    {
      ...common,
      id: 'terminal',
      connection: terminalConnection(),
      capabilities: { terminal: true },
      name: 'Terminal',
      connectLabel: 'Connect new terminal',
      icon: '▤',
      iconHTML: terminalIcon,
      panelPrefix: 'frame-',
      connect: (host) => s.connect(host, 'terminal'),
      async mount(tab, signal) {
        signal?.throwIfAborted();
        const frame = document.createElement('iframe');
        frame.title = tab.name + ' terminal';
        frame.id = 'frame-' + tab.id;
        frame.allow = 'microphone; screen-wake-lock; clipboard-read; clipboard-write';
        frame.src = s.terminalURL(s.backend(tab), tab.session);
        return {
          element: frame,
          terminal: { frame, frames: [frame], retain: true },
          setVisible(visible) {
            frame.hidden = !visible;
            sendToTerminal(frame.contentWindow, { type: 'tab-visibility', visible });
          },
          focus() {
            sendToTerminal(frame.contentWindow, { type: 'focus-terminal' });
          },
          applySettings() {
            sendToTerminal(frame.contentWindow, { type: 'settings-changed' });
          },
          copySelection() {
            sendToTerminal(frame.contentWindow, {
              type: 'settings-action',
              action: 'copy-selection',
            });
          },
          canEvict: () => terminalCanEvict(frame),
          dispose() {
            frame.remove();
          },
        };
      },
      async close(tab) {
        if (!confirm('Close ' + tab.name + '? Running programs in this terminal will stop.'))
          return false;
        await s.closeSession(tab);
        return true;
      },
    },
    {
      ...common,
      id: 'files',
      connection: terminalConnection(true),
      name: 'SFTP / Files',
      connectLabel: 'Connect SFTP / Files',
      icon: '',
      iconHTML: folderIcon,
      panelPrefix: 'files-',
      className: 'files-tab',
      connect: (host) => s.connect(host, 'files'),
      async mount(tab, signal) {
        const backend = s.backend(tab);
        await s.authenticate(backend);
        signal?.throwIfAborted();
        if (!s.active(tab)) throw new Error('This tab has closed.');
        const view = fileBrowser(
          fileClient(
            backend.url,
            tab.session,
            () => s.token(backend),
            () => s.authenticate(backend, true),
          ),
          builtinState(tab).directory || '.',
          (directory) => {
            builtinState(tab).directory = directory;
            s.store();
          },
        );
        view.element.id = 'files-' + tab.id;
        return {
          ...view,
          setVisible(visible) {
            view.element.hidden = !visible;
          },
        };
      },
      async close(tab) {
        await s.closeSession(tab);
        return true;
      },
    },
    ...['herdr', 'herdr-core'].map(
      (id): TabPlugin => ({
        version: BUILTIN_VERSION,
        id,
        connection: herdrConnection(id === 'herdr-core'),
        resume: s.resumeHerdr,
        name: id === 'herdr-core' ? 'Herdr Core' : 'Herdr',
        connectLabel: id === 'herdr-core' ? 'Connect Herdr Core' : 'Connect Herdr',
        icon: 'H',
        iconHTML: herdrIcon,
        panelPrefix: 'herdr-',
        className: 'herdr-tab',
        capabilities: {
          terminal: true,
          waitForReady: true,
          attentionLabel: 'agents need attention',
        },
        available: (host) => id === 'herdr' || host.kind !== 'herdr',
        connect: (host) => s.connect(host, id),
        async mount(tab, signal) {
          const backend = s.backend(tab);
          const { HerdrView } = await import('./herdr-view.ts');
          signal?.throwIfAborted();
          if (!s.active(tab)) throw new Error('This tab has closed.');
          const session = herdrSession(builtinState(tab).herdrSession),
            source = builtinState(tab).herdrSource,
            sourceHost = s.host(tab.hostId)?.herdrSourceHostId;
          const core = id === 'herdr-core';
          const connection =
            (core ? 'core:' : '') +
            backend.url +
            '#' +
            (source ? sourceHost || tab.hostId || source : '') +
            '#' +
            session;
          const view = new HerdrView({
            core,
            url: backend.url,
            session,
            source,
            token: () => s.token(backend),
            authenticate: () => s.authenticate(backend, true),
            reconnect: () => s.reconnectHerdr(tab),
            key: 'libertty.herdr.' + connection,
            reading: (terminalId, request) => {
              const source = {
                ...tab,
                pluginState: {
                  ...builtinState(tab),
                  herdrCore: core,
                  readHerdrTerminal: terminalId,
                },
              };
              if ('path' in request) s.openReading(source, request.path);
              else s.openReadingCapture(source, request.capture, request.name, request.exitCode);
            },
            notificationDevice: () => s.notificationDevice(tab.backendId),
            toggleTerminalTabs: () => s.toggleTerminalTabs(tab),
            api: async <K extends HttpEndpoint, I extends HttpInput<K>>(
              name: K,
              data: I,
              signal?: AbortSignal,
            ) => {
              try {
                return await s.api<HttpOutput<K, I>>(
                  backend,
                  name +
                    (name.includes('?') ? '&' : '?') +
                    new URLSearchParams({
                      ...(core ? { herdrCore: '1' } : {}),
                      herdrSession: session,
                      ...(source ? { herdrSource: source } : {}),
                    }),
                  data,
                  undefined,
                  true,
                  signal,
                );
              } catch (error: any) {
                if (
                  !signal?.aborted &&
                  error.status === 404 &&
                  source &&
                  builtinState(tab).herdrSource === source &&
                  !tab.ended
                ) {
                  tab.ended = true;
                  s.store();
                }
                throw error;
              }
            },
            changed: (count) => s.attention(tab, count),
            ready: () => s.ready(tab),
            notification: (event) => s.notification(connection, event),
            notice: s.notice,
            fail: s.fail,
            state: (key, state) => s.tabState(tab, key, state),
          });
          view.element.id = 'herdr-' + tab.id;
          view.navigationElement.id = 'herdr-strip-' + tab.id;
          void s
            .watch(tab)
            .then(() => {
              if (!signal?.aborted) view.updatePresence();
            })
            .catch(s.fail);
          return {
            element: view.element,
            get ready() {
              return view.ready;
            },
            terminal: {
              get frame() {
                return view.terminalFrame;
              },
              get frames() {
                return view.element.querySelectorAll('iframe');
              },
            },
            navigation: {
              element: view.navigationElement,
              get gesturesBlocked() {
                return view.treeOpen;
              },
              setExpanded: (expanded) => view.setTerminalTabsExpanded(expanded),
              holdSize: () => view.holdTerminalSize(),
            },
            updatePresence: () => view.updatePresence(),
            openTerminal: (id) => view.openTerminal(id),
            setVisible: (visible) => view.setVisible(visible),
            setHeld: (held) => view.setHeld(held),
            applySettings: () => view.applySettings(),
            copySelection: () => view.copySelection(),
            dispose() {
              view.dispose();
            },
          };
        },
        async close(tab) {
          await s.unwatch(tab);
          if (tab.ownsSession) await s.closeSession(tab);
          return true;
        },
      }),
    ),
    readingPlugin(s),
  ];
  for (const plugin of plugins)
    plugin.state = builtinStateCodecs.find((entry) => entry.id === plugin.id)!.state;
  return plugins;
}
