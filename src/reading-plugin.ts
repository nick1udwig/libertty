import type { BackendProfile, TerminalTab } from './connections.ts';
import { BUILTIN_VERSION, type PluginView, type TabPlugin } from './plugins.ts';
import { readingMessage, readingView, type ReadingView } from './reading-view.ts';

export interface ReadingServices {
  backend(tab: TerminalTab): BackendProfile;
  token(backend: BackendProfile): string | undefined;
  authenticate(backend: BackendProfile, force?: boolean): Promise<void>;
  openReading(tab: TerminalTab, path: string): void;
}

export function readingPlugin(s: ReadingServices): TabPlugin {
  return { id: 'reading', version: BUILTIN_VERSION, name: 'Reading Mode', connectLabel: 'Look at', icon: '',
    iconHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    panelPrefix: 'reading-', available: () => false,
    async connect() { throw new Error('Use a reading phrase in a terminal to open a file or command output.'); },
    async mount(tab) { return mountReading(tab, s); },
    async close(tab) {
      if (tab.readCapture) {
        const backend = s.backend(tab), url = new URL('api/reading/capture', backend.url);
        url.searchParams.set('id', tab.readCapture); url.searchParams.set('session', tab.session);
        void fetch(url, { method: 'DELETE', credentials: 'same-origin', signal: AbortSignal.timeout(12000),
          headers: authorization(s.token(backend)) }).catch(() => {});
      }
      return true;
    },
  };
}

function authorization(token?: string): HeadersInit { return token ? { Authorization: 'Bearer ' + token } : {}; }

function mountReading(tab: TerminalTab, s: ReadingServices): PluginView {
  const path = tab.readPath;
  if (path === undefined) throw new Error('This reading tab has no file or command output.');
  const backend = s.backend(tab), controller = new AbortController();
  const element = document.createElement('div'); element.id = 'reading-' + tab.id;
  let disposed = false, visible = false, current: ReadingView;
  const message = (file: string, detail: string, hint?: string): ReadingView => {
    const element = readingMessage(file, detail, hint);
    return { element, dispose() { element.remove(); } };
  };
  const display = (view: ReadingView) => {
    if (disposed) { view.dispose(); return; }
    current?.dispose(); current = view; view.element.hidden = !visible; element.replaceChildren(view.element);
  };
  const readFile = async (path: string, capture?: string) => {
    const url = new URL(capture ? 'api/reading/capture' : 'api/reading/file', backend.url);
    url.searchParams.set(capture ? 'id' : 'path', capture || path); url.searchParams.set('session', tab.session);
    const fetchFile = () => fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal, headers: authorization(s.token(backend)) });
    let response = await fetchFile();
    if (response.status === 401) { await s.authenticate(backend, true); response = await fetchFile(); }
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Could not open file.'); }
    return response.blob();
  };
  display(message(path, 'Opening file…'));
  void (async () => {
    try {
      const blob = await readFile(path, tab.readCapture);
      if (disposed) return;
      if (tab.readCapture && !blob.size) {
        const failed = typeof tab.readExitCode === 'number' && tab.readExitCode !== 0;
        const detail = failed ? `Exited with status ${tab.readExitCode} without writing to standard output. Check the terminal for errors.`
          : typeof tab.readExitCode === 'number' ? 'Finished successfully without writing to standard output.' : 'No standard output was captured.';
        const hint = !failed && tab.name.trim() === 'git diff' ? 'git diff is silent when there are no unstaged changes. Try git status or git diff --cached.' : undefined;
        display(message(tab.name, detail, hint));
      } else display(readingView(tab.readCapture ? 'Command output' : path, blob, tab.readCapture ? undefined : { load: readFile, open: path => s.openReading(tab, path) }));
    } catch (error: any) { if (!disposed) display(message(path, error.message || 'Could not open file.')); }
  })();
  return { element, setVisible(value) { visible = value; element.hidden = !value; current.element.hidden = !value; },
    dispose() { disposed = true; controller.abort(); current.dispose(); element.remove(); } };
}
