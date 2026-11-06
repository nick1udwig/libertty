import { builtinState } from './builtin-state.ts';
import { request } from './api.ts';
import { icon } from './icons.ts';
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
  return {
    id: 'reading',
    version: BUILTIN_VERSION,
    name: 'Reading Mode',
    connectLabel: 'Look at',
    icon: '',
    iconHTML: icon(
      '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
      17,
    ),
    panelPrefix: 'reading-',
    available: () => false,
    async connect() {
      throw new Error('Use a reading phrase in a terminal to open a file or command output.');
    },
    async mount(tab) {
      return mountReading(tab, s);
    },
    async close(tab) {
      const state = builtinState(tab);
      if (state.readCapture) {
        const backend = s.backend(tab),
          url = readingURL(tab, backend, true);
        url.searchParams.set('id', state.readCapture);
        url.searchParams.set('session', tab.session);
        void request(url, {
          method: 'DELETE',
          token: () => s.token(backend),
          recoverAuth: () => s.authenticate(backend, true),
        }).catch(() => {});
      }
      return true;
    },
  };
}

function readingURL(tab: TerminalTab, backend: BackendProfile, capture = false) {
  const state = builtinState(tab);
  const url = new URL(
    (state.readHerdrTerminal ? 'api/herdr/reading/' : 'api/reading/') +
      (capture ? 'capture' : 'file'),
    backend.url,
  );
  if (state.readHerdrTerminal) {
    if (state.herdrCore) url.searchParams.set('herdrCore', '1');
    url.searchParams.set('herdrSession', state.herdrSession || '');
    if (state.herdrSource) url.searchParams.set('herdrSource', state.herdrSource);
  }
  return url;
}

function mountReading(tab: TerminalTab, s: ReadingServices): PluginView {
  const state = builtinState(tab);
  const path = state.readPath;
  if (path === undefined) throw new Error('This reading tab has no file or command output.');
  const backend = s.backend(tab),
    controller = new AbortController();
  const element = document.createElement('div');
  element.id = 'reading-' + tab.id;
  let disposed = false,
    visible = false,
    current: ReadingView;
  const message = (file: string, detail: string, hint?: string): ReadingView => {
    const element = readingMessage(file, detail, hint);
    return {
      element,
      dispose() {
        element.remove();
      },
    };
  };
  const display = (view: ReadingView) => {
    if (disposed) {
      view.dispose();
      return;
    }
    current?.dispose();
    current = view;
    view.element.hidden = !visible;
    element.replaceChildren(view.element);
  };
  const readFile = async (path: string, capture?: string) => {
    const url = readingURL(tab, backend, !!capture);
    url.searchParams.set(capture ? 'id' : 'path', capture || path);
    url.searchParams.set('session', tab.session);
    const response = await request(url, {
      signal: controller.signal,
      token: () => s.token(backend),
      recoverAuth: () => s.authenticate(backend, true),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Could not open file.');
    }
    return response.blob();
  };
  display(message(path, 'Opening file…'));
  void (async () => {
    try {
      const blob = await readFile(path, state.readCapture);
      if (disposed) return;
      if (state.readCapture && !blob.size) {
        const failed = typeof state.readExitCode === 'number' && state.readExitCode !== 0;
        const detail = failed
          ? `Exited with status ${state.readExitCode} without writing to standard output. Check the terminal for errors.`
          : typeof state.readExitCode === 'number'
            ? 'Finished successfully without writing to standard output.'
            : 'No standard output was captured.';
        const hint =
          !failed && tab.name.trim() === 'git diff'
            ? 'git diff is silent when there are no unstaged changes. Try git status or git diff --cached.'
            : undefined;
        display(message(tab.name, detail, hint));
      } else
        display(
          readingView(
            state.readCapture ? 'Command output' : path,
            blob,
            state.readCapture
              ? undefined
              : { load: readFile, open: (path) => s.openReading(tab, path) },
          ),
        );
    } catch (error: any) {
      if (!disposed) display(message(path, error.message || 'Could not open file.'));
    }
  })();
  return {
    element,
    setVisible(value) {
      visible = value;
      element.hidden = !value;
      current.element.hidden = !value;
    },
    dispose() {
      disposed = true;
      controller.abort();
      current.dispose();
      element.remove();
    },
  };
}
