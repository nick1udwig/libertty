import type { BackendProfile, HostProfile, TerminalTab } from './connections.ts';
import { folderIcon } from './icons.ts';
import { fileBrowser } from './file-browser.ts';
import { fileClient } from './file-client.ts';
import { herdrSession } from './herdr-protocol.ts';
import type { HerdrView } from './herdr-view.ts';
import { BUILTIN_VERSION, type TabPlugin } from './plugins.ts';
import { readingPlugin, type ReadingServices } from './reading-plugin.ts';

export interface BuiltinServices extends ReadingServices {
  active(tab: TerminalTab): boolean;
  host(id?: string): HostProfile | undefined;
  api<T>(backend: BackendProfile, name: string, data?: unknown, session?: string): Promise<T>;
  connect(host: HostProfile, pluginId: string): Promise<void>;
  closeSession(tab: TerminalTab): Promise<void>;
  store(): void;
  notice(message: string): void;
  terminalURL(backend: BackendProfile, session: string): string;
  frame(tab: TerminalTab, frame?: HTMLIFrameElement): void;
  herdr(tab: TerminalTab, view?: HerdrView): void;
  attention(tab: TerminalTab, count: number): void;
  notification(connection: string, event: Parameters<ConstructorParameters<typeof HerdrView>[0]['notification']>[0]): void;
  notificationDevice(backendId: string): string | undefined;
  watch(tab: TerminalTab): Promise<void>;
  unwatch(tab: TerminalTab): Promise<void>;
}

export function builtinPlugins(s: BuiltinServices): TabPlugin[] {
  const common = { version: BUILTIN_VERSION, available: (host: HostProfile) => host.kind !== 'herdr' };
  return [
    { ...common, id: 'terminal', name: 'Terminal', connectLabel: 'Connect new terminal', icon: '▤', panelPrefix: 'frame-',
      connect: host => s.connect(host, 'terminal'),
      async mount(tab) {
        const frame = document.createElement('iframe'); frame.title = tab.name + ' terminal'; frame.id = 'frame-' + tab.id;
        frame.allow = 'clipboard-read; clipboard-write'; frame.src = s.terminalURL(s.backend(tab), tab.session); s.frame(tab, frame);
        return { element: frame, setVisible(visible) { frame.hidden = !visible; frame.contentWindow?.postMessage({ type: 'tab-visibility', visible }, location.origin); },
          focus() { frame.contentWindow?.postMessage({ type: 'focus-terminal' }, location.origin); },
          applySettings() { frame.contentWindow?.postMessage({ type: 'settings-changed' }, location.origin); },
          copySelection() { frame.contentWindow?.postMessage({ type: 'settings-action', action: 'copy-selection' }, location.origin); },
          dispose() { frame.remove(); s.frame(tab); } };
      },
      async close(tab) { if (!confirm('Close ' + tab.name + '? Running programs in this terminal will stop.')) return false; await s.closeSession(tab); return true; },
    },
    { ...common, id: 'files', name: 'SFTP / Files', connectLabel: 'Connect SFTP / Files', icon: '', iconHTML: folderIcon, panelPrefix: 'files-', className: 'files-tab',
      connect: host => s.connect(host, 'files'),
      async mount(tab) {
        const backend = s.backend(tab); await s.authenticate(backend);
        if (!s.active(tab)) throw new Error('This tab has closed.');
        const view = fileBrowser(fileClient(backend.url, tab.session, () => s.token(backend), () => s.authenticate(backend, true)), tab.directory || '.', directory => { tab.directory = directory; s.store(); });
        view.element.id = 'files-' + tab.id;
        return { ...view, setVisible(visible) { view.element.hidden = !visible; } };
      },
      async close(tab) { await s.closeSession(tab); return true; },
    },
    { version: BUILTIN_VERSION, id: 'herdr', name: 'Herdr', connectLabel: 'Connect Herdr', icon: 'H', panelPrefix: 'herdr-', className: 'herdr-tab', available: () => true,
      connect: host => s.connect(host, 'herdr'),
      async mount(tab) {
        const backend = s.backend(tab); await s.authenticate(backend);
        const { HerdrView } = await import('./herdr-view.ts');
        if (!s.active(tab)) throw new Error('This tab has closed.');
        const session = herdrSession(tab.herdrSession), sourceHost = s.host(tab.hostId)?.herdrSourceHostId;
        const connection = backend.url + '#' + (tab.herdrSource ? sourceHost || tab.hostId || tab.herdrSource : '') + '#' + session;
        const view = new HerdrView({ url: backend.url, session, source: tab.herdrSource, token: () => s.token(backend), authenticate: () => s.authenticate(backend, true), key: 'termai.herdr.' + connection,
          notificationDevice: () => s.notificationDevice(tab.backendId),
          api: <T>(name: string, data?: unknown) => s.api<T>(backend, name + '?' + new URLSearchParams({ herdrSession: session, ...(tab.herdrSource ? { herdrSource: tab.herdrSource } : {}) }), data),
          changed: count => s.attention(tab, count), notification: event => s.notification(connection, event), notice: s.notice });
        view.element.id = 'herdr-' + tab.id; s.herdr(tab, view);
        void s.watch(tab).then(() => view.updatePresence()).catch(error => s.notice(error.message));
        return { element: view.element, setVisible: visible => view.setVisible(visible), applySettings: () => view.applySettings(), copySelection: () => view.copySelection(),
          dispose() { view.dispose(); s.herdr(tab); } };
      },
      async close(tab) { await s.unwatch(tab); if (tab.ownsSession) await s.closeSession(tab); return true; },
    },
    readingPlugin(s),
  ];
}
