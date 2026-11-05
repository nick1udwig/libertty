import { terminalMessage, sendToTerminal } from './frame-protocol.ts';
import { terminalRenderers } from './renderer-cache.ts';
import { closeIcon } from './icons.ts';
import { type BackendProfile, type HostProfile, type TerminalTab } from './connections.ts';
import { $, button, input, select } from './dom.ts';
import { herdrName } from './herdr-protocol.ts';
import { imagePicker } from './image-upload.ts';
import { menuEvents } from './menu.ts';
import {
  failure,
  frameNotice,
  type NoticeAction,
  type NoticeInput,
  type NoticeKind,
} from './notice-model.ts';
import { NoticeCenter } from './notices.ts';
import { PluginRegistry, tabPluginId, type PluginView, type PluginNavigation } from './plugins.ts';
import { readingMessage } from './reading-view.ts';
import { type Shortcut } from './shortcuts.ts';
import { tabGestures, tabStripSwipes } from './tab-gestures.ts';
import { readingTab } from './tabs.ts';
import { currentShortcuts } from './workspace-settings.ts';
import type { WorkspaceServices, WorkspaceState } from './workspace-storage.ts';
interface Options
  extends Pick<
    WorkspaceServices,
    'endpoint' | 'api' | 'authenticate' | 'backendFor' | 'tokenFor' | 'store'
  > {
  workspace: WorkspaceState;
  populate: (id: string, selected?: string, extra?: boolean, browser?: boolean) => void;
  renderSettings: () => void;
  renderCards: () => Promise<void>;
  plugins: PluginRegistry;
  editHost: (host?: HostProfile) => void;
  pluginViews: Map<string, PluginView>;
  frames: Map<string, HTMLIFrameElement>;
  authorizeTerminals: (backend: BackendProfile, accessToken: string) => void;
  capturedSSH: (
    backend: BackendProfile,
    parent: TerminalTab,
    id: string,
    command: string,
  ) => Promise<void> | undefined;
  capturedHerdr: (backend: BackendProfile, parent: TerminalTab, id: string) => Promise<void>;
  cancelReconnect: (id: string) => void;
}
export function createWorkspaceNavigation(options: Options) {
  const {
    workspace,
    populate,
    renderSettings,
    renderCards,
    plugins,
    editHost,
    store,
    pluginViews,
    frames,
    backendFor,
    authenticate,
    endpoint,
    authorizeTerminals,
    tokenFor,
    capturedSSH,
    capturedHerdr,
    cancelReconnect,
  } = options;
  const attentionCounts = new Map<string, number>();
  const navigationFor = (id: string) => pluginViews.get(id)?.navigation;
  let navigationTab = '',
    terminalTabsExpanded = false;
  let drawerDrag:
    | { view: PluginNavigation; height: number; expanded: boolean; release: () => void }
    | undefined;
  let page: 'terminal' | 'hosts' | 'vault' | 'keychain' | 'backends' | 'known' | 'settings' =
    'terminal';
  const mounting = new Map<string, Promise<void>>(),
    mountGeneration = new Map<string, number>();
  const terminalShortcuts = new WeakMap<
    Window,
    {
      shortcuts: Shortcut[];
      ctrl: boolean;
      available: boolean;
      imageAvailable: boolean;
      returnAvailable: boolean;
    }
  >();
  let shortcutPresentation = '';
  let shortcutWindow: Window | null | undefined;
  const lockedTerminals = new Set<string>();
  const handledEnds = new Map<string, string>();
  let terminalLoading: { id: string; waitForPrompt: boolean } | undefined;
  let presentedTab = '',
    pluginLoading = false;
  const notices = new NoticeCenter();
  const tabStates = new Map<string, Map<string, NoticeInput>>();
  let presentedStates = new Set<string>();
  function notice(message: string, kind: NoticeKind = 'error', actions: NoticeAction[] = []) {
    notices.notify({ message, kind, actions });
  }
  const fail = failure(notice);
  /** Keep each tab's connection state, and show only the selected terminal's. */
  function tabState(tab: TerminalTab, key: string, state?: NoticeInput) {
    const states = tabStates.get(tab.id) ?? new Map<string, NoticeInput>();
    if (state) states.set(key, { ...state, source: tab.name });
    else states.delete(key);
    if (states.size) tabStates.set(tab.id, states);
    else tabStates.delete(tab.id);
    presentStates();
  }
  function presentStates() {
    const states = page === 'terminal' ? tabStates.get(workspace.active) : undefined;
    for (const key of presentedStates) if (!states?.has(key)) notices.set(key);
    for (const [key, state] of states ?? []) notices.set(key, state);
    presentedStates = new Set(states?.keys());
  }
  function show(view: typeof page) {
    closeHostMenu();
    closeTabMenu();
    const previous = page;
    page = view;
    const terminal = view === 'terminal';
    $('workspace-navigation').hidden = !terminal;
    $('terminal-stack').hidden = !terminal;
    $('library').hidden = terminal;
    updateViewVisibility();
    if (terminal) {
      renderTabs();
      return;
    }
    $('settings-pane').hidden = view !== 'settings';
    $('library-content').hidden = view === 'settings';
    for (const [id, selected] of [
      ['nav-vault', view !== 'settings'],
      ['nav-settings', view === 'settings'],
    ] as const) {
      if (selected) $(id).setAttribute('aria-current', 'page');
      else $(id).removeAttribute('aria-current');
    }
    $('page-title').textContent = {
      settings: 'Settings',
      hosts: 'Hosts',
      vault: 'Vault',
      keychain: 'Keychain',
      backends: 'Backends',
      known: 'Known hosts',
    }[view];
    $('page-back').querySelector('span')!.textContent = ['vault', 'settings'].includes(view)
      ? 'Terminal'
      : 'Vault';
    $('sort-hosts').hidden = !['hosts', 'keychain'].includes(view);
    $('search-label').hidden = ['vault', 'settings'].includes(view);
    input('search').placeholder = 'Search ' + $('page-title').textContent!.toLowerCase();
    input('search').value = '';
    $('backend-filter-label').hidden = !['keychain', 'known'].includes(view);
    populate(
      'backend-filter',
      view === 'keychain' && previous !== 'keychain'
        ? 'browser'
        : select('backend-filter').value || 'primary',
      false,
      view === 'keychain',
    );
    $('library-add').hidden = ['vault', 'known', 'settings'].includes(view);
    $('library-add').setAttribute(
      'aria-label',
      view === 'keychain' ? 'Add SSH key' : view === 'backends' ? 'Add backend' : 'Add host',
    );
    if (view === 'settings') {
      renderSettings();
      return;
    }
    void renderCards();
  }
  function hostTabs(host: HostProfile) {
    return workspace.tabs.filter((tab) => tab.hostId === host.id && !tab.ended);
  }
  function tabLabel(tab: TerminalTab) {
    if (tabPluginId(tab) === 'files') return tab.name;
    const peers = workspace.tabs.filter(
      (other) =>
        tabPluginId(other) === tabPluginId(tab) &&
        other.hostId === tab.hostId &&
        other.name === tab.name,
    );
    const index = peers.indexOf(tab);
    return index > 0 ? `${tab.name} (${index + 1})` : tab.name;
  }
  const hostMenu = document.createElement('div');
  hostMenu.id = 'host-terminal-menu';
  hostMenu.className = 'host-terminal-menu';
  hostMenu.role = 'menu';
  hostMenu.hidden = true;
  document.body.append(hostMenu);
  let menuAnchor: HTMLButtonElement | undefined;
  function closeHostMenu(focus = false) {
    hostMenu.hidden = true;
    menuAnchor?.setAttribute('aria-expanded', 'false');
    if (focus) menuAnchor?.focus();
    menuAnchor = undefined;
  }
  function openHostMenu(host: HostProfile, anchor: HTMLButtonElement) {
    if (menuAnchor === anchor) {
      closeHostMenu(true);
      return;
    }
    closeHostMenu();
    menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    hostMenu.replaceChildren();
    hostMenu.setAttribute('aria-label', host.name + ' terminals');
    const item = (label: string, action: () => void) => {
      const control = button(label, () => {
        closeHostMenu();
        action();
      });
      control.role = 'menuitem';
      control.setAttribute('aria-label', label);
      hostMenu.append(control);
      return control;
    };
    for (const plugin of plugins.actions(host))
      item(plugin.connectLabel, () => void plugin.connect(host).catch(fail));
    const open = hostTabs(host);
    if (open.length) {
      hostMenu.append(document.createElement('hr'));
      for (const tab of open) {
        const control = item(tabLabel(tab), () => activate(tab.id));
        if (tab.id === workspace.active) {
          control.classList.add('current');
          control.setAttribute('aria-current', 'true');
        }
      }
    }
    hostMenu.append(document.createElement('hr'));
    item('Edit host', () => editHost(host));
    hostMenu.hidden = false;
    const rect = anchor.getBoundingClientRect(),
      viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0,
      top = viewport?.offsetTop || 0,
      width = viewport?.width || innerWidth,
      height = viewport?.height || innerHeight;
    hostMenu.style.maxHeight = `${height - 24}px`;
    const size = hostMenu.getBoundingClientRect();
    hostMenu.style.left = `${Math.max(left + 12, Math.min(rect.right - size.width, left + width - size.width - 12))}px`;
    hostMenu.style.top = `${Math.max(top + 12, Math.min(rect.bottom + 4, top + height - size.height - 12))}px`;
    hostMenu.querySelector('button')?.focus();
  }
  menuEvents(hostMenu, () => menuAnchor, closeHostMenu);
  $('library-content').addEventListener('scroll', () => closeHostMenu(), { passive: true });
  const tabMenu = document.createElement('div');
  tabMenu.className = 'host-terminal-menu';
  tabMenu.role = 'menu';
  tabMenu.hidden = true;
  document.body.append(tabMenu);
  let tabMenuAnchor: HTMLElement | undefined;
  function closeTabMenu(focus = false) {
    tabMenu.hidden = true;
    if (focus) tabMenuAnchor?.focus();
    tabMenuAnchor = undefined;
  }
  function openTabMenu(tab: TerminalTab, anchor: HTMLElement) {
    tabMenuAnchor = anchor;
    tabMenu.replaceChildren();
    const rename = button('Rename', () => {
      closeTabMenu();
      renameTab(tab);
    });
    rename.role = 'menuitem';
    const close = button('Close tab', () => {
      closeTabMenu();
      void closeTab(tab).catch(fail);
    });
    close.role = 'menuitem';
    tabMenu.append(rename, close);
    tabMenu.hidden = false;
    tabMenu.setAttribute('aria-label', tab.name + ' tab actions');
    const rect = anchor.getBoundingClientRect();
    tabMenu.style.left =
      Math.max(8, Math.min(rect.left, innerWidth - tabMenu.offsetWidth - 8)) + 'px';
    tabMenu.style.top = Math.max(8, rect.top - tabMenu.offsetHeight - 5) + 'px';
    rename.focus({ preventScroll: true });
  }
  function renameTab(tab: TerminalTab) {
    const modal = document.createElement('dialog'),
      form = document.createElement('form'),
      title = document.createElement('h2'),
      field = document.createElement('input'),
      error = document.createElement('p'),
      actions = document.createElement('div');
    title.textContent = 'Rename tab';
    field.value = tab.name;
    field.maxLength = 100;
    field.required = true;
    field.setAttribute('aria-label', 'Tab name');
    error.className = 'form-error';
    actions.className = 'actions';
    const cancel = button('Cancel', () => modal.close(), 'secondary'),
      save = button('Save', () => {}, 'primary');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(title, field, error, actions);
    modal.append(form);
    document.body.append(modal);
    modal.onclose = () => modal.remove();
    form.onsubmit = (event) => {
      event.preventDefault();
      try {
        tab.name = herdrName(field.value);
        store();
        renderTabs();
        modal.close();
      } catch (reason: any) {
        error.textContent = reason.message;
      }
    };
    modal.showModal();
    field.focus();
    field.select();
  }
  menuEvents(tabMenu, () => tabMenuAnchor, closeTabMenu);
  function updateTerminalLoading() {
    const loading =
      page === 'terminal' && (pluginLoading || terminalLoading?.id === workspace.active);
    // A previous tab stays visible while the next view prepares, so the orb shows the progress instead of a cover.
    const behind = pluginLoading && !!presentedTab;
    $('terminal-loading').hidden = !loading || behind;
    const tab = workspace.tabs.find((tab) => tab.id === workspace.active);
    const message = 'Loading ' + ((tab && plugins.forTab(tab)?.name) || 'tab') + '…';
    $('terminal-loading-label').textContent = pluginLoading ? message : 'Opening SSH terminal…';
    notices.set('tab-loading', loading && behind ? { message, kind: 'progress' } : undefined);
  }
  function updateViewVisibility() {
    const visible = page === 'terminal' && !document.hidden,
      target = pluginViews.get(workspace.active),
      tab = workspace.tabs.find((tab) => tab.id === workspace.active);
    if (page === 'terminal' && tab && !target) void mount(tab).catch(fail);
    target?.setHeld?.(false);
    target?.setVisible(
      tab && plugins.forTab(tab)?.capabilities?.terminal ? page === 'terminal' : visible,
    );
    if (!pluginViews.has(presentedTab)) presentedTab = '';
    const waiting =
      visible &&
      tab &&
      plugins.forTab(tab)?.capabilities?.waitForReady &&
      (!target || target.ready === false);
    const preparing = !!waiting && presentedTab !== workspace.active;
    pluginLoading = preparing;
    if (visible && !preparing) presentedTab = target ? workspace.active : '';
    for (const [id, view] of pluginViews) {
      if (id !== workspace.active) view.setVisible(visible && id === presentedTab);
      view.setHeld?.(visible && id === presentedTab && id !== workspace.active);
      view.element.style.visibility = id === workspace.active && preparing ? 'hidden' : '';
      view.element.inert = visible && (id !== workspace.active || preparing);
    }
    $('terminal-stack').setAttribute('aria-busy', String(preparing));
    updateWorkspaceNavigation();
    updateTerminalLoading();
    renderWorkspaceShortcuts();
    presentStates();
    const activeFrame = target?.terminal?.frame;
    if (activeFrame) terminalRenderers.touch(activeFrame);
    terminalRenderers.trim();
  }
  function updateWorkspaceNavigation() {
    if (drawerDrag && (page !== 'terminal' || drawerDrag.view !== navigationFor(workspace.active)))
      cancelDrawerSwipe();
    if (navigationTab !== workspace.active) {
      if (!navigationFor(navigationTab)) terminalTabsExpanded = false;
      navigationTab = workspace.active;
    }
    const navigation = navigationFor(workspace.active),
      expanded = !navigation || terminalTabsExpanded;
    $('workspace-navigation').classList.toggle('plugin-navigation', !!navigation);
    const drawer = $('terminal-tabs-drawer');
    drawer.classList.toggle('collapsed', !expanded);
    drawer.inert = !expanded;
    drawer.setAttribute('aria-hidden', String(!expanded));
    for (const [id, view] of pluginViews) {
      if (!view.navigation) continue;
      view.navigation.element.hidden = id !== workspace.active;
      view.navigation.setExpanded(terminalTabsExpanded);
    }
  }
  function shortcutFrame() {
    return pluginViews.get(workspace.active)?.terminal?.frame;
  }
  let imageTarget: Window | null | undefined;
  const images = imagePicker((files) => {
    if (imageTarget && shortcutFrame()?.contentWindow === imageTarget)
      sendToTerminal(imageTarget, { type: 'terminal-images', files });
    else notice('Select the original terminal and attach the image again.', 'warning');
  });
  document.body.append(images);
  $('workspace-enter').addEventListener('pointerdown', (event) => event.preventDefault());
  function renderWorkspaceShortcuts() {
    const frame = shortcutFrame(),
      source = frame?.contentWindow,
      state = source && terminalShortcuts.get(source);
    const tab = workspace.tabs.find((tab) => tab.id === workspace.active),
      view = pluginViews.get(workspace.active);
    $('workspace-shortcuts').hidden =
      page !== 'terminal' || !(state || (tab && plugins.forTab(tab)?.capabilities?.terminal));
    const ready = !!state && !frame?.inert && view?.ready !== false;
    // Reserve the configured controls before the incoming terminal publishes its state.
    const shortcuts = state?.shortcuts || currentShortcuts();
    const presentation = JSON.stringify({
      shortcuts,
      ctrl: ready && state?.ctrl,
      available: state?.available,
      imageAvailable: state?.imageAvailable,
      returnAvailable: state?.returnAvailable,
      ready,
    });
    if (source === shortcutWindow && presentation === shortcutPresentation) return;
    shortcutWindow = source;
    shortcutPresentation = presentation || '';
    const enter = $<HTMLButtonElement>('workspace-enter');
    enter.disabled = !ready || !state?.returnAvailable;
    enter.onclick = () => {
      if (!ready || !state?.returnAvailable || shortcutFrame()?.contentWindow !== source) return;
      sendToTerminal(source!, { type: 'terminal-return' });
    };
    const buttons = $('workspace-shortcut-buttons'),
      scroll = buttons.scrollLeft;
    buttons.replaceChildren();
    shortcuts.forEach((shortcut, index) => {
      const control = button(
        shortcut.label,
        () => {
          if (!ready || shortcutFrame()?.contentWindow !== source) return;
          sendToTerminal(source!, {
            type: 'terminal-shortcut',
            index,
            kind: shortcut.kind,
            value: shortcut.value,
          });
        },
        shortcut.kind === 'command' ? 'command-shortcut' : '',
      );
      control.title = shortcut.value;
      control.disabled = !ready || (shortcut.kind === 'command' && !state?.available);
      if (shortcut.kind === 'keys' && shortcut.value === 'Ctrl') {
        control.dataset.modifier = '';
        control.setAttribute('aria-pressed', String(ready && state?.ctrl));
      }
      control.addEventListener('pointerdown', (event) => event.preventDefault());
      buttons.append(control);
    });
    const image = button(
      'Image',
      () => {
        if (!ready || shortcutFrame()?.contentWindow !== source) return;
        imageTarget = source;
        images.click();
      },
      'image-upload',
    );
    image.setAttribute('aria-label', 'Attach images');
    image.disabled = !ready || !state?.imageAvailable;
    buttons.append(image);
    buttons.scrollLeft = scroll;
  }
  function showTerminalLoading(id: string, waitForPrompt = false) {
    terminalLoading = { id, waitForPrompt };
    updateTerminalLoading();
  }
  function hideTerminalLoading(id: string) {
    if (terminalLoading?.id === id) {
      terminalLoading = undefined;
      updateTerminalLoading();
    }
  }
  function renderTabs() {
    $('tabs').replaceChildren();
    const all = workspace.tabs;
    for (const tab of all) {
      const plugin = plugins.forTab(tab);
      const el = document.createElement('div');
      el.className = 'tab';
      if (plugin?.className) el.classList.add(plugin.className);
      el.role = 'tab';
      el.tabIndex = tab.id === workspace.active ? 0 : -1;
      el.setAttribute('aria-selected', String(tab.id === workspace.active));
      el.setAttribute(
        'aria-controls',
        pluginViews.get(tab.id)?.element.id || (plugin?.panelPrefix || 'plugin-') + tab.id,
      );
      el.title = (tab.readPath || tabLabel(tab)) + ' · ' + backendFor(tab.backendId).name;
      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      if (plugin?.iconHTML) icon.innerHTML = plugin.iconHTML;
      else icon.textContent = plugin?.icon || '◇';
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tabLabel(tab);
      const close = button('', () => void closeTab(tab).catch(fail), 'tab-close');
      close.innerHTML = closeIcon;
      close.setAttribute('aria-label', 'Close ' + tab.name);
      close.addEventListener('click', (event) => event.stopPropagation());
      if (plugin?.capabilities?.attentionLabel) {
        const badge = document.createElement('span');
        badge.className = 'tab-attention';
        badge.dataset.tab = tab.id;
        badge.textContent = String(attentionCounts.get(tab.id) || 0);
        badge.hidden = !attentionCounts.get(tab.id);
        badge.setAttribute(
          'aria-label',
          badge.textContent + ' ' + plugin.capabilities.attentionLabel,
        );
        el.append(icon, name, badge, close);
      } else el.append(icon, name, close);
      tabGestures(el, {
        select: () => activate(tab.id),
        hold: () => openTabMenu(tab, el),
        scroll: $('tabs'),
      });
      el.onkeydown = (event) => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          activate(tab.id);
        }
        if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          const index = all.indexOf(tab),
            next = all[(index + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
          activate(next.id);
          ($('tabs').querySelector('[aria-selected=true]') as HTMLElement)?.focus();
        }
      };
      $('tabs').append(el);
    }
    updateViewVisibility();
    $('empty-terminal').hidden = !!all.length;
    updateTerminalLoading();
    requestAnimationFrame(() =>
      $('tabs')
        .querySelector('[aria-selected=true]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    );
  }
  function activate(id: string) {
    const tab = workspace.tabs.find((tab) => tab.id === id);
    if (!tab) return;
    tab.lastUsed = Date.now();
    terminalTabsExpanded = !$('terminal-tabs-drawer').inert;
    workspace.active = navigationTab = id;
    store();
    show('terminal');
    pluginViews.get(id)?.focus?.();
  }
  function addReading(
    source: TerminalTab,
    detail: Pick<TerminalTab, 'name' | 'readPath' | 'readCapture' | 'readExitCode'>,
  ) {
    const tab = readingTab(source, detail);
    workspace.tabs.push(tab);
    workspace.active = tab.id;
    store();
    show('terminal');
    void mount(tab);
  }
  function openReading(source: TerminalTab, path: string) {
    addReading(source, { name: path.split('/').at(-1) || path, readPath: path });
  }
  function openReadingCapture(
    source: TerminalTab,
    capture: string,
    name: string,
    exitCode?: number,
  ) {
    if (
      workspace.tabs.some(
        (tab) =>
          tabPluginId(tab) === 'reading' &&
          tab.backendId === source.backendId &&
          tab.session === source.session &&
          tab.readCapture === capture,
      )
    )
      return;
    addReading(source, { name, readPath: name, readCapture: capture, readExitCode: exitCode });
  }
  function unmount(tab: TerminalTab) {
    const view = pluginViews.get(tab.id);
    const frame = view?.terminal?.retain && view.terminal.frame;
    if (frame) terminalRenderers.release(frame);
    view?.navigation?.element.remove();
    attentionCounts.delete(tab.id);
    mountGeneration.set(tab.id, (mountGeneration.get(tab.id) || 0) + 1);
    mounting.delete(tab.id);
    pluginViews.get(tab.id)?.dispose();
    pluginViews.delete(tab.id);
    tabStates.delete(tab.id);
    presentStates();
  }
  async function mount(tab: TerminalTab): Promise<void> {
    if (pluginViews.has(tab.id) || !workspace.tabs.includes(tab)) return;
    if (mounting.has(tab.id)) return mounting.get(tab.id);
    const generation = mountGeneration.get(tab.id) || 0,
      plugin = plugins.forTab(tab);
    const work = (async () => {
      let view: PluginView;
      try {
        if (!plugin)
          throw new Error(
            'This plugin version is missing or disabled. Install or enable ' +
              tabPluginId(tab) +
              ' (' +
              tab.pluginVersion +
              ') in Settings.',
          );
        view = await plugin.mount(tab);
      } catch (error: any) {
        const element = readingMessage(tab.name, error.message || 'Could not open this tab.');
        element.id = 'plugin-' + tab.id;
        const retry = button(
          'Retry connection',
          () => {
            unmount(tab);
            void mount(tab);
          },
          'secondary',
        );
        element.append(retry);
        view = {
          element,
          setVisible(visible) {
            element.hidden = !visible;
          },
          dispose() {
            element.remove();
          },
        };
      }
      if (!workspace.tabs.includes(tab) || (mountGeneration.get(tab.id) || 0) !== generation) {
        view.dispose();
        return;
      }
      pluginViews.set(tab.id, view);
      $('terminal-stack').append(view.element);
      if (view.navigation) $('workspace-navigation').append(view.navigation.element);
      renderTabs();
      const frame = view.terminal?.retain && view.terminal.frame;
      if (frame)
        terminalRenderers.retain(frame, {
          canEvict: () =>
            tab.id !== workspace.active && tab.id !== presentedTab && view.canEvict?.() !== false,
          dispose: () => unmount(tab),
        });
    })();
    mounting.set(tab.id, work);
    try {
      await work;
    } finally {
      if (mounting.get(tab.id) === work) mounting.delete(tab.id);
    }
  }
  function terminalURL(backend: BackendProfile, session: string) {
    const url = new URL('terminal.html', document.baseURI);
    url.search = new URLSearchParams({ embedded: '1', backend: backend.url, session }).toString();
    return url.href;
  }
  async function addTerminal(
    backend: BackendProfile,
    session: string,
    name: string,
    hostId?: string,
    parentTabId?: string,
    files = false,
  ) {
    const names = new Set(
      workspace.tabs
        .filter((tab) => tab.hostId === hostId && (tabPluginId(tab) === 'files') === files)
        .map(tabLabel),
    );
    const base = name;
    for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
    const tab: TerminalTab = {
      pluginId: files ? 'files' : 'terminal',
      pluginVersion: '1',
      ownsSession: true,
      id: crypto.randomUUID(),
      backendId: backend.id,
      session,
      name,
      hostId,
      parentTabId,
      lastUsed: Date.now(),
    };
    workspace.tabs.push(tab);
    workspace.active = tab.id;
    if (!files && workspace.hosts.find((host) => host.id === hostId)?.kind === 'ssh')
      showTerminalLoading(tab.id, true);
    store();
    show('terminal');
    await mount(tab);
  }
  async function closeTab(tab: TerminalTab) {
    const plugin = plugins.forTab(tab);
    if (plugin) {
      if (!(await plugin.close(tab))) return;
    } else if (tab.ownsSession) await closeTabSession(tab);
    const wasActive = workspace.active === tab.id;
    cancelReconnect(tab.id);
    unmount(tab);
    lockedTerminals.delete(tab.id);
    handledEnds.delete(tab.id);
    const index = workspace.tabs.indexOf(tab);
    workspace.tabs = workspace.tabs.filter((t) => t.id !== tab.id);
    hideTerminalLoading(tab.id);
    if (workspace.active === tab.id)
      workspace.active =
        workspace.tabs.find((t) => t.id === tab.parentTabId)?.id ||
        workspace.tabs[Math.min(index, workspace.tabs.length - 1)]?.id ||
        '';
    if (wasActive) {
      terminalTabsExpanded = !$('terminal-tabs-drawer').inert;
      navigationTab = workspace.active;
    }
    store();
    renderTabs();
    if (!workspace.tabs.length) {
      $('empty-terminal').querySelector('p')!.textContent =
        'Open a saved host to start a terminal.';
    }
    if (wasActive) pluginViews.get(workspace.active)?.focus?.();
  }
  async function closeTabSession(tab: TerminalTab) {
    const backend = backendFor(tab.backendId);
    await authenticate(backend);
    await endpoint(backend, 'api/sessions/close', {}, tab.session);
  }
  async function recoverTerminal(tab: TerminalTab, backend: BackendProfile) {
    try {
      await authenticate(backend);
      await endpoint(backend, 'api/sessions/close', {}, tab.session);
      if (!workspace.tabs.includes(tab)) return;
      const result = await endpoint(backend, 'api/sessions', { name: tab.name });
      if (!workspace.tabs.includes(tab)) {
        await endpoint(backend, 'api/sessions/close', {}, result.id);
        return;
      }
      tab.session = result.id;
      tab.ended = false;
      store();
      const frame = frames.get(tab.id);
      if (frame) frame.src = terminalURL(backend, result.id);
      else await mount(tab);
      if (page === 'hosts') void renderCards();
    } catch (error: any) {
      sendToTerminal(frames.get(tab.id)?.contentWindow, { type: 'recovery-failed' });
      notice(`Could not start ${tab.name}: ${error.message}`, 'error', [
        { label: 'Retry', run: () => void recoverTerminal(tab, backend) },
      ]);
    }
  }
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = terminalMessage(event.data);
    if (!data) return;
    if (data.type === 'terminal-shortcuts') {
      const source = event.source as Window;
      const known = [...pluginViews.values()].some((view) =>
        [...(view.terminal?.frames || [])].some((frame) => frame.contentWindow === source),
      );
      if (known) {
        try {
          terminalShortcuts.set(source, {
            shortcuts: data.shortcuts,
            ctrl: data.ctrl === true,
            available: data.available === true,
            imageAvailable: data.imageAvailable === true,
            returnAvailable: data.returnAvailable === true,
          });
          renderWorkspaceShortcuts();
        } catch {
          /* Ignore malformed state from a stale terminal. */
        }
      }
      return;
    }
    const entry = [...frames].find(([, frame]) => frame.contentWindow === event.source);
    if (!entry) return;
    const tab = workspace.tabs.find((tab) => tab.id === entry[0]);
    if (!tab) return;
    if (data.session !== tab.session) return;
    const backend = backendFor(tab.backendId),
      frame = entry[1];
    if (data.type === 'terminal-authorized' && typeof data.accessToken === 'string')
      authorizeTerminals(backend, data.accessToken);
    if (data.type === 'terminal-loaded') {
      tabState(tab, 'terminal');
      sendToTerminal(frame.contentWindow!, { type: 'shortcut-host' });
      // Visibility arrives first so a hidden tab does not connect until it is shown.
      sendToTerminal(frame.contentWindow!, {
        type: 'tab-visibility',
        visible: tab.id === workspace.active && page === 'terminal',
        active: tab.id === workspace.active,
      });
      sendToTerminal(frame.contentWindow!, { type: 'authorize', accessToken: tokenFor(backend) });
    }
    if (data.type === 'terminal-locked') {
      hideTerminalLoading(tab.id);
      lockedTerminals.add(tab.id);
      const current = tokenFor(backend);
      // A delayed rejection may refer to credentials replaced by another frame.
      if (current && current !== data.accessToken) authorizeTerminals(backend, current);
      else void authenticate(backend, true).catch(fail);
    }
    if (data.type === 'ssh-command') {
      showTerminalLoading(tab.id);
      void capturedSSH(backend, tab, data.id, data.command);
    }
    if (data.type === 'herdr-command') {
      showTerminalLoading(tab.id);
      void capturedHerdr(backend, tab, data.id);
    }
    const remote = frameNotice(data, frame.contentWindow);
    if (remote?.status) tabState(tab, 'terminal', remote.input);
    else if (remote?.input) notices.notify({ ...remote.input, source: tab.name });
    if (data.type === 'reading-open' && 'path' in data) openReading(tab, data.path);
    if (data.type === 'reading-open' && 'capture' in data)
      openReadingCapture(tab, data.capture, data.name, data.exitCode);
    if (
      data.type === 'terminal-state' &&
      data.state?.ready === true &&
      terminalLoading?.id === tab.id &&
      terminalLoading.waitForPrompt
    )
      hideTerminalLoading(tab.id);
    if (
      data.type === 'terminal-ended' ||
      (data.type === 'terminal-state' && typeof data.state?.exited === 'boolean')
    ) {
      const ended = data.type === 'terminal-ended' || data.state.exited;
      if (ended) hideTerminalLoading(tab.id);
      const host = workspace.hosts.find((host) => host.id === tab.hostId);
      if (ended && host?.kind === 'http' && handledEnds.get(tab.id) !== tab.session) {
        handledEnds.set(tab.id, tab.session);
        void recoverTerminal(tab, backend);
      } else if (
        ended &&
        host?.kind !== 'http' &&
        !tab.ended &&
        workspace.active === tab.id &&
        workspace.tabs.some((parent) => parent.id === tab.parentTabId)
      )
        activate(tab.parentTabId!);
      if (!!tab.ended !== ended) {
        tab.ended = ended;
        store();
        if (page === 'hosts') void renderCards();
      }
      if (data.type === 'terminal-ended' && host?.kind !== 'http')
        notice(tab.name + ' has ended. Open its saved host to reconnect.', 'warning', [
          { label: 'Open hosts', run: () => show('hosts') },
        ]);
    }
  });
  $('terminal-back').onclick = $('empty-open').onclick = () => show('hosts');
  $('page-back').onclick = () => show(['vault', 'settings'].includes(page) ? 'terminal' : 'vault');
  $('nav-vault').onclick = () => show('vault');
  $('nav-terminals').onclick = () => show('terminal');
  $('nav-settings').onclick = () => show('settings');
  function viewport() {
    document.documentElement.style.setProperty(
      '--height',
      `${window.visualViewport?.height || innerHeight}px`,
    );
  }
  window.visualViewport?.addEventListener('resize', viewport);
  window.addEventListener('resize', viewport);
  viewport();
  document.addEventListener('visibilitychange', updateViewVisibility);
  function toggleTerminalTabs(tab: TerminalTab) {
    if (tab.id !== workspace.active) return;
    cancelDrawerSwipe();
    const release = navigationFor(tab.id)?.holdSize();
    terminalTabsExpanded = !terminalTabsExpanded;
    updateWorkspaceNavigation();
    // Animate the surrounding bars with one terminal geometry change at the end.
    void Promise.allSettled(
      $('terminal-tabs-drawer')
        .getAnimations()
        .map((animation) => animation.finished),
    ).then(() => release?.());
  }
  function moveTerminalTabs(dy: number) {
    const view = navigationFor(workspace.active);
    if (!view || page !== 'terminal') return;
    const drawer = $('terminal-tabs-drawer');
    if (!drawerDrag) {
      drawerDrag = {
        view,
        height: drawer.getBoundingClientRect().height,
        expanded: terminalTabsExpanded,
        release: view.holdSize(),
      };
      drawer.classList.add('dragging');
    }
    drawer.style.height =
      Math.max(0, Math.min($('terminal-header').offsetHeight, drawerDrag.height - dy)) + 'px';
  }
  function endTerminalTabs(expanded?: boolean) {
    const drag = drawerDrag;
    if (!drag) return;
    drawerDrag = undefined;
    const drawer = $('terminal-tabs-drawer');
    // Commit the last dragged height before transitioning to the settled state.
    drawer.getBoundingClientRect();
    drawer.classList.remove('dragging');
    drawer.style.removeProperty('height');
    if (page === 'terminal' && drag.view === navigationFor(workspace.active))
      terminalTabsExpanded = expanded ?? drag.expanded;
    updateWorkspaceNavigation();
    void Promise.allSettled(drawer.getAnimations().map((animation) => animation.finished)).then(
      drag.release,
    );
  }
  const cancelDrawerSwipe = tabStripSwipes(
    $('workspace-navigation'),
    () => {
      const view = page === 'terminal' && navigationFor(workspace.active);
      // A plugin can hold vertical gestures while its own menu is open.
      return view && !view.gesturesBlocked && view;
    },
    { move: moveTerminalTabs, end: endTerminalTabs },
  );
  function attention(tab: TerminalTab, count: number) {
    attentionCounts.set(tab.id, count);
    const badge = [...$('tabs').querySelectorAll<HTMLElement>('.tab-attention')].find(
      (badge) => badge.dataset.tab === tab.id,
    );
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = !count;
      badge.setAttribute(
        'aria-label',
        count + ' ' + plugins.forTab(tab)?.capabilities?.attentionLabel,
      );
    }
    if (tab.id === workspace.active) queueMicrotask(renderWorkspaceShortcuts);
  }

  return {
    unmount,
    mount,
    notice,
    fail,
    tabState,
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
    updateWorkspaceNavigation,
    updateViewVisibility,
    renderWorkspaceShortcuts,
    lockedTerminals,
    openReadingCapture,
    toggleTerminalTabs,
    attention,
    get page() {
      return page;
    },
  };
}
