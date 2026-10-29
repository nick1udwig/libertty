import { node } from './dom.ts';
import { icon } from './icons.ts';
import { saved } from './persistence.ts';
import type { ReadingOpen } from './reading-request.ts';
import { HerdrFrames } from './herdr-frames.ts';
import { wireProtocols } from './wire.ts';
import { ReconnectingSocket, stalledLabel } from './reconnecting-socket.ts';
import { herdrName, type HerdrAgent, type HerdrMessage, type HerdrSnapshot, type HerdrStatus, type HerdrSpace } from './herdr-protocol.ts';
import { HerdrDialogs, type Created, type StripItem } from './herdr-dialogs.ts';
import { HerdrState, type HerdrNotification } from './herdr-state.ts';
import { herdrCache } from './herdr-cache.ts';
import { tabGestures } from './tab-gestures.ts';
import { dropSpace, repoSpace, repoTap, spaceLayout, spaceRepos, spaceTerminal, type RepoTap, type SpaceDrop, type SpaceRepo } from './herdr-spaces.ts';
import { herdrLane, herdrLaneNames, statusLanes, type HerdrLane } from './herdr-lanes.ts';
import type { Fail, NoticeInput, NoticeKind, Notify } from './notice-model.ts';
import './herdr.css';

const herdrIcon = (body: string, size = 15) => icon(body, size, 2);
const icons = {
  folder: herdrIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', 16),
  open: herdrIcon('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
  branch: herdrIcon('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  close: herdrIcon('<path d="M18 6 6 18M6 6l12 12"/>', 14),
  check: herdrIcon('<path d="M20 6 9 17l-5-5"/>', 16),
  plus: herdrIcon('<path d="M12 5v14M5 12h14"/>'),
};

interface Host {
  url: string; session: string; source?: string; key: string;
  token(): string | undefined; authenticate(): Promise<void>;
  api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T>;
  changed(attention: number): void; notification(event: HerdrNotification): void;
  notice: Notify;
  fail: Fail;
  /** Show a connection state for this view (`herdr`), or the connection (`terminal`) or loading (`loading`) state of its selected pane. */
  state?(key: 'herdr' | 'terminal' | 'loading', state?: NoticeInput): void;
  reading(terminalId: string, request: ReadingOpen): void;
  reconnect?(): Promise<void>;
  ready?(): void;
  toggleTerminalTabs?(): void;
  notificationDevice?(): string | undefined;
}
interface Preferences { order: string[]; spaceOrder?: string[]; spaceGroups?: string[][]; collapsedGroups?: string[]; collapsedLanes?: HerdrLane[]; spaceTerminals?: Record<string, string>; repoSpaces?: Record<string, string>; selected?: string; state?: ReturnType<HerdrState['checkpoint']> }
export class HerdrView {
  readonly element = node('section', 'herdr-view');
  private strip = node('div', 'herdr-agent-strip');
  private tabsToggle = node('button', 'herdr-tabs-toggle');
  private screen = node('div', 'herdr-screen');
  private frames: HerdrFrames;
  private statusText = '';
  private empty = node('div', 'herdr-empty');
  private menu = node('div', 'herdr-tab-menu');
  private dropIndicator = node('div', 'herdr-drop-indicator');
  private dropLabel = node('span', 'herdr-drop-label');
  private treeBridge = node('div', 'herdr-tree-bridge');
  private tracker = new HerdrState();
  private preferences: Preferences;
  private transport!: ReconnectingSocket;
  private get ws() { return this.transport?.socket; }
  private recovering?: Promise<void>;
  private recoveryRetry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private visible = false;
  private connected = false;
  private liveSnapshot = false;
  private cached = false;
  private quietSnapshot = true;
  private selected = '';
  private requestedTerminal = '';
  private presenceAt = 0;
  private presenceDevice = '';
  private terminals: HerdrAgent[] = [];
  private spaces: HerdrSpace[] = [];
  private repos: SpaceRepo[] = [];
  private tree?: { repo: string; signature: string };
  private renaming = false;
  private handoffHeld = false;
  private navigationResize = 0;
  private held = false;
  private dragOrderChanged = false;
  /** The latest snapshot waiting to be cached, written when the page is idle or hidden instead of on every update. */
  private uncached?: unknown;
  private cacheTimer?: ReturnType<typeof setTimeout>;
  /** What the strip last rendered, so an update that changes nothing it shows keeps its buttons. */
  private stripKey = '';
  private statuses = new Map<string, HerdrStatus>();
  private savedPreferences = '';
  private preferenceTimer?: ReturnType<typeof setTimeout>;
  private dropTarget?: { id: string; drop: SpaceDrop };
  private pinnedLane?: { id: string; lane: HerdrLane };
  private movingSpace = false;
  private creatingSpace = false;
  private closing = new Set<string>();
  private dialogs: HerdrDialogs;
  private unsubscribers: (() => void)[] = [];
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    this.dialogs = new HerdrDialogs({
      api: (path, data) => host.api(path, data), refresh: created => this.refreshSnapshot(created),
      closeMenu: () => this.closeMenu(), closeTab: item => this.closeTab(item), closing: this.closing,
      terminalName: id => this.terminals.find(agent => agent.terminalId === id)?.name,
    });
    try { this.preferences = JSON.parse(localStorage.getItem(host.key) || 'null') || { order: [] }; }
    catch { this.preferences = { order: [] }; }
    if (!Array.isArray(this.preferences.order)) this.preferences = { order: [] };
    this.preferences.order = this.preferences.order.filter(id => typeof id === 'string');
    this.preferences.spaceOrder = (this.preferences.spaceOrder || []).filter(id => typeof id === 'string');
    this.preferences.spaceTerminals ||= {};
    this.preferences.repoSpaces ||= {};
    this.preferences.spaceGroups = Array.isArray(this.preferences.spaceGroups) ? this.preferences.spaceGroups : [];
    this.preferences.collapsedGroups = Array.isArray(this.preferences.collapsedGroups) ? this.preferences.collapsedGroups : [];
    // Idle lanes start folded so the strip opens on agents that need attention.
    this.preferences.collapsedLanes = Array.isArray(this.preferences.collapsedLanes) ? this.preferences.collapsedLanes.filter(lane => lane in herdrLaneNames) : ['idle'];
    delete (this.preferences as any).hidden; delete (this.preferences as any).hiddenSpaces;
    this.tracker = new HerdrState(this.preferences.state);
    this.selected = this.preferences.selected || '';
    let stored: unknown;
    try { stored = JSON.parse(localStorage.getItem(host.key + '.snapshot') || 'null'); } catch { /* Start without the cache. */ }
    const cached = herdrCache(stored);
    if (cached) {
      this.cached = true; this.terminals = cached.terminals; this.spaces = cached.spaces; this.repos = spaceRepos(this.spaces);
      this.tracker.agents = cached.agents; this.ensureSelection();
    }
    this.element.setAttribute('aria-label', 'Herdr connection');
    this.element.role = 'tabpanel'; this.screen.id = 'herdr-terminal-' + crypto.randomUUID(); this.screen.role = 'tabpanel'; this.screen.setAttribute('aria-label', 'Agent terminal');
    this.strip.role = 'tablist'; this.strip.setAttribute('aria-label', 'Herdr agents');
    this.tabsToggle.type = 'button'; this.tabsToggle.setAttribute('aria-controls', 'terminal-tabs-drawer');
    this.tabsToggle.innerHTML = icon('<path d="m6 15 6-6 6 6"/>', 18, 2);
    this.tabsToggle.onclick = () => this.host.toggleTerminalTabs?.(); this.setTerminalTabsExpanded(false);
    this.menu.role = 'menu'; this.menu.hidden = true; this.treeBridge.hidden = true; this.treeBridge.setAttribute('aria-hidden', 'true');
    this.dropIndicator.hidden = true; this.dropIndicator.setAttribute('aria-hidden', 'true');
    this.dropIndicator.append(this.dropLabel); document.body.append(this.dropIndicator, this.treeBridge);
    const viewed = () => { if (this.visible && this.frames.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } };
    this.frames = new HerdrFrames(this.screen, {
      url: host.url, session: host.session, source: host.source,
      token: () => host.token(), authenticate: () => host.authenticate(), notice: (...args) => host.notice(...args), fail: error => host.fail(error), state: state => host.state?.('terminal', state), loading: label => host.state?.('loading', label ? { message: label, kind: 'progress' } : undefined), reading: (terminalId, request) => host.reading(terminalId, request),
      visible: () => this.visible, held: () => this.handoffHeld, agentName: terminalId => this.terminals.find(agent => agent.terminalId === terminalId)?.name,
      painted: () => { viewed(); this.host.ready?.(); },
      ended: () => void this.refreshSnapshot().catch(error => { if (error.status !== 404) this.connectionError(error); }),
    });
    this.screen.append(this.empty, this.frames.loading);
    const backdrop = node('div', 'herdr-menu-backdrop'); backdrop.setAttribute('aria-hidden', 'true');
    let dismissMenu = false;
    backdrop.onpointerdown = event => { event.stopPropagation(); dismissMenu = true; };
    backdrop.onpointercancel = () => { dismissMenu = false; };
    // The release that opens a hold menu can click the newly visible backdrop.
    backdrop.onclick = event => {
      if (!dismissMenu) return;
      dismissMenu = false;
      // While a tree is open, tapping another chip moves the tree to that chip instead of only dismissing it.
      const chip = this.tree && document.elementsFromPoint(event.clientX, event.clientY).find(element => element.matches('.herdr-agent-tab') && this.strip.contains(element)) as HTMLElement | undefined;
      const repo = chip && chip.dataset.terminal !== this.tree!.repo && this.entries().find(item => item.terminalId === chip.dataset.terminal)?.repo;
      if (chip && repo) this.openTree(chip, repo); else this.closeMenu();
    };
    this.element.append(this.screen, this.menu, backdrop);
    const messages = (event: MessageEvent) => this.frames.message(event);
    document.addEventListener('visibilitychange', viewed); window.addEventListener('focus', viewed); window.addEventListener('message', messages);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', viewed), () => window.removeEventListener('focus', viewed), () => window.removeEventListener('message', messages));
    const presence = () => this.updatePresence();
    document.addEventListener('visibilitychange', presence); window.addEventListener('focus', presence); window.addEventListener('blur', presence);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', presence), () => window.removeEventListener('focus', presence), () => window.removeEventListener('blur', presence));
    const outside = (event: PointerEvent) => { if (!this.menu.contains(event.target as Node) && !(event.target as HTMLElement).closest('.herdr-agent-tab')) this.closeMenu(); };
    document.addEventListener('pointerdown', outside); this.unsubscribers.push(() => document.removeEventListener('pointerdown', outside));
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !this.menu.hidden) { event.preventDefault(); this.closeMenu(); this.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
    };
    document.addEventListener('keydown', escape); this.unsubscribers.push(() => document.removeEventListener('keydown', escape));
    this.menu.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...this.menu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    };
    // Swiping the space tree down dismisses it, like the sheet its grab bar suggests.
    let sheet: { id: number; y: number; dragging: boolean } | undefined, swiped = false;
    this.menu.addEventListener('pointerdown', event => {
      swiped = false;
      if (this.tree && !this.renaming && !(event.target as HTMLElement).closest('input')) sheet = { id: event.pointerId, y: event.clientY, dragging: false };
    });
    this.menu.addEventListener('pointermove', event => {
      if (!sheet || event.pointerId !== sheet.id) return;
      const distance = event.clientY - sheet.y;
      if (!sheet.dragging && (distance < 10 || this.menu.scrollTop > 0)) return;
      sheet.dragging = true; this.treeBridge.hidden = true; this.menu.style.transform = 'translateY(' + Math.max(0, distance) + 'px)';
    });
    const release = (event: PointerEvent) => {
      if (!sheet || event.pointerId !== sheet.id) return;
      const dismissed = sheet.dragging && event.type === 'pointerup' && event.clientY - sheet.y > 56;
      swiped = sheet.dragging; sheet = undefined;
      if (dismissed) this.closeMenu();
      else if (swiped) { this.menu.style.transform = ''; this.refreshTree(); }
    };
    this.menu.addEventListener('pointerup', release); this.menu.addEventListener('pointercancel', release);
    // A swipe that returns to its start must not also press the control it began on.
    this.menu.addEventListener('click', event => { if (swiped) { event.preventDefault(); event.stopPropagation(); swiped = false; } }, true);
    const reposition = () => { if (this.tree) this.refreshTree(); };
    window.addEventListener('resize', reposition); visualViewport?.addEventListener('resize', reposition);
    this.unsubscribers.push(() => window.removeEventListener('resize', reposition), () => visualViewport?.removeEventListener('resize', reposition));
    this.transport = new ReconnectingSocket({
      available: () => !this.disposed && !this.recovering && (!document.hidden || !this.transport.backgroundExpired),
      protocols: wireProtocols,
      prepare: async signal => {
        const { ticket } = await this.host.api<{ ticket: string }>('api/herdr/ticket', {}, signal);
        signal.throwIfAborted();
        const url = this.endpoint('herdr/ws');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
        return url;
      },
      stalled: lastContact => this.status(stalledLabel(lastContact)),
      probe: () => { if (Date.now() - this.presenceAt >= 20000) this.updatePresence(); },
      open: () => { this.quietSnapshot = true; this.updatePresence(); },
      message: event => {
        try { this.receive(typeof event.data === 'string' ? JSON.parse(event.data) : event.data); }
        catch { this.ws?.close(4002, 'Invalid transport message'); }
      },
      close: () => {
        if (this.disposed) return false;
        this.connected = false; this.status('Herdr disconnected. Reconnecting…'); this.render();
        this.frames.setLoading(false); this.host.ready?.(); return true;
      },
      error: error => { this.connectionError(error); return true; },
    });
    // Hiding or leaving the page writes the snapshot cache.
    const leave = () => { this.writePreferences(); this.writeCache(); };
    window.addEventListener('pagehide', leave);
    this.unsubscribers.push(this.transport.follow({ grace: 20000, hidden: leave }), () => window.removeEventListener('pagehide', leave));
    this.element.addEventListener('pointerdown', () => this.transport.activity(), { passive: true });
    this.render(); void this.connect();
    if (this.cached) queueMicrotask(() => { if (!this.disposed) this.host.ready?.(); });
  }
  setVisible(visible: boolean) {
    const changed = this.visible !== visible;
    this.visible = visible; this.element.hidden = !visible;
    if (!changed) { this.mountTerminal(); return; }
    this.frames.rendered = false;
    if (!visible) { this.clearDrop(); this.closeMenu(); this.frames.hide(); }
    const before = this.frames.frame; this.mountTerminal();
    if (visible && before === this.frames.frame) this.frames.represent();
    this.frames.broadcast({ type:'tab-visibility', visible });
    if (visible) this.transport.foreground();
  }
  get ready() { return this.cached || this.frames.rendered || !!this.statusText || this.connected && !this.selected; }
  get navigationElement() { return this.strip; }
  setTerminalTabsExpanded(expanded: boolean) {
    this.tabsToggle.setAttribute('aria-expanded', String(expanded));
    this.tabsToggle.setAttribute('aria-label', expanded ? 'Hide terminal tabs' : 'Show terminal tabs');
  }
  holdTerminalSize() {
    const generation = ++this.navigationResize, frame = this.frames.displayed;
    if (frame && !frame.style.flexBasis) frame.style.flexBasis = frame.getBoundingClientRect().height + 'px';
    this.screen.classList.add('herdr-navigation-resizing');
    return () => {
      if (generation !== this.navigationResize) return;
      const resize = () => {
        if (generation !== this.navigationResize) return;
        if (frame) frame.style.flexBasis = '';
        this.screen.classList.remove('herdr-navigation-resizing');
      };
      if (frame) void this.frames.prepareResize(frame).then(resize); else resize();
    };
  }
  setHeld(held: boolean) {
    if (this.handoffHeld === held) return;
    this.handoffHeld = held;
    if (held && this.frames.displayed) this.frames.park(this.frames.displayed,true);
    else if (this.visible) this.mountTerminal(true);
  }
  private post(message: object) { this.frames.post(message); }
  get terminalFrame() { return this.frames.frame; }
  /** Cached metadata mounts an unauthorized preview; the live snapshot verifies the pane before it connects. */
  private mountTerminal(force = false) { if (!this.disposed) this.frames.mount(this.terminals, this.selected, force, this.liveSnapshot); }
  private endpoint(name: string) { const url = new URL(name, this.host.url); if (this.host.session) url.searchParams.set('herdrSession', this.host.session); if (this.host.source) url.searchParams.set('herdrSource', this.host.source); return url; }
  private connect() { return this.transport.connect(); }
  private status(message = '', kind: NoticeKind = 'progress') {
    if (message === this.statusText) return;
    this.statusText = message;
    this.host.state?.('herdr', message ? { message, kind } : undefined);
  }
  private connectionError(error: unknown) {
    if (this.disposed) return;
    const failure = error as { status?: number; message?: string; name?: string };
    if (failure.name === 'TimeoutError') this.status('Herdr connection timed out. Retrying…');
    else this.status(failure.message || 'Herdr connection failed.', 'error');
    this.frames.setLoading(false); this.host.ready?.();
    if (failure.status !== 404 || !this.host.source || !this.host.reconnect || !this.visible || this.recovering) return;
    this.status('Reconnecting to Herdr…');
    let cancelled = false;
    this.recovering = this.host.reconnect().catch((reason: { message?: string; cancelled?: boolean }) => {
      if (!this.disposed) this.status(reason.message || 'Herdr connection failed.', 'error');
      cancelled = reason.cancelled === true;
    }).finally(() => {
      this.recovering = undefined;
      if (!this.disposed && !cancelled) this.recoveryRetry = setTimeout(() => void this.connect(), 3000);
    });
  }
  private receive(message: HerdrMessage) {
    if (message.type === 'error') { this.status(message.message, 'error'); this.frames.setLoading(false); this.host.ready?.(); return; }
    if (message.type !== 'snapshot') return;
    this.transport.ready(); this.connected = this.ws?.readyState === WebSocket.OPEN;
    this.liveSnapshot = true; this.cached = false; this.cacheLater(message.snapshot);
    const previousSpace = this.terminals.find(terminal => terminal.terminalId === this.selected)?.workspaceId;
    this.status();
    this.terminals = message.snapshot.terminals; this.spaces = message.snapshot.spaces; this.repos = spaceRepos(this.spaces);
    const notifications = this.tracker.update(message.snapshot);
    this.acknowledge(this.quietSnapshot ? this.currentNotifications() : notifications);
    if (!this.quietSnapshot) for (const event of notifications) this.host.notification(event);
    this.quietSnapshot = false;
    const live = this.tracker.agents.map(agent => agent.terminalId);
    this.preferences.order = [...this.preferences.order.filter(id => live.includes(id)), ...live.filter(id => !this.preferences.order.includes(id))];
    // The strip orders repositories by their first space, and stacks saved before grouping follow each space into its repository.
    const repos = this.repos.map(repo => repo.id), grouped = new Map(this.repos.flatMap(repo => repo.spaces.map(space => ['space:' + space.id, repo.id] as const)));
    const layout = spaceLayout(repos, this.preferences.spaceGroups!.map(group => [...new Set(group.map(id => grouped.get(id) || id))]), repos);
    this.preferences.spaceOrder = layout.order; this.preferences.spaceGroups = layout.groups;
    this.preferences.collapsedGroups = this.preferences.collapsedGroups!.map(id => grouped.get(id) || id).filter(id => layout.groups.some(group => group[0] === id));
    for (const [repo, space] of Object.entries(this.preferences.repoSpaces!)) if (!grouped.has('space:' + space)) delete this.preferences.repoSpaces![repo];
    this.ensureSelection(previousSpace);
    if (this.requestedTerminal && this.terminals.some(agent => agent.terminalId === this.requestedTerminal)) { this.selected = this.requestedTerminal; this.requestedTerminal = ''; }
    this.save(); this.render(); this.mountTerminal();
    if (!this.selected) this.host.ready?.();
    requestAnimationFrame(() => { if (this.visible && this.frames.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } });
  }
  private get spaceMode() { return saved<string>('herdrStrip', '') !== 'agents'; }
  // Status lanes are the default order; only an explicit Manual choice keeps the saved order.
  private get laneMode() { return saved<string>('herdrStripOrder', '') !== 'manual'; }
  private get tapMode(): RepoTap { const mode = saved<string>('herdrSpaceTap', ''); return mode === 'root' || mode === 'tree' || mode === 'triage' ? mode : 'recent'; }
  private get order() { return this.spaceMode ? this.preferences.spaceOrder! : this.preferences.order; }
  private set order(value: string[]) { if (this.spaceMode) this.preferences.spaceOrder = value; else this.preferences.order = value; }
  private get stripSelection() {
    const terminal = this.terminals.find(t => t.terminalId === this.selected);
    return this.spaceMode && terminal ? this.repoOf(terminal.workspaceId)?.id || 'space:' + terminal.workspaceId : this.selected;
  }
  private repoOf(spaceId?: string) { return this.repos.find(repo => repo.spaces.some(space => space.id === spaceId)); }
  private spaceItem(space: HerdrSpace): StripItem {
    return { terminalId: 'space:' + space.id, paneId: '', workspace: space.name, name: space.name, kind: 'Space', status: 'idle', sequence: 0, cwd: '', space };
  }
  private entries(): StripItem[] {
    if (!this.spaceMode) return this.tracker.agents;
    return this.repos.map(repo => {
      const space = repoSpace(repo, this.preferences.repoSpaces![repo.id]);
      return { ...this.spaceItem(space), terminalId: repo.id, workspace: repo.name, name: repo.spaces.length > 1 ? repo.name : space.name, repo };
    });
  }
  private statusFor(item: StripItem) {
    const cached = this.statuses.get(item.terminalId);
    if (cached) return cached;
    if (!item.space) return this.tracker.status(item);
    const statuses = (item.repo?.spaces || [item.space]).flatMap(space => space.terminalIds.map(id => this.statuses.get(id)));
    const status = (['blocked', 'done', 'working'] as const).find(status => statuses.includes(status)) || 'idle';
    this.statuses.set(item.terminalId, status);
    return status;
  }

  private laneFor(item: StripItem) {
    const lane = herdrLane(this.statusFor(item));
    if (item.terminalId !== this.stripSelection) return lane;
    // The open tab keeps its lane until another tab is selected, so viewing or answering it never moves it away.
    if (this.pinnedLane?.id !== item.terminalId) this.pinnedLane = { id: item.terminalId, lane };
    return this.pinnedLane.lane;
  }
  private terminalFor(item?: StripItem) {
    if (!item) return '';
    if (!item.space) return item.terminalId;
    return spaceTerminal(item.space, this.preferences.spaceTerminals![item.space.id]);
  }
  private ensureSelection(previousSpace?: string) {
    if (this.terminals.some(t => t.terminalId === this.selected) && this.ordered().some(item => item.terminalId === this.stripSelection)) return;
    // Closing the open pane keeps its space open when another of its panes survives.
    const space = this.spaceMode ? this.spaces.find(space => space.id === previousSpace && space.terminalIds.length) : undefined;
    this.selected = space ? this.terminalFor(this.spaceItem(space)) : this.terminalFor(this.ordered()[0]);
  }
  private select(id: string) {
    const item = this.entries().find(item => item.terminalId === id);
    const panes = (space: HerdrSpace) => this.tracker.agents.filter(agent => space.terminalIds.includes(agent.terminalId))
      .map(agent => ({ terminalId: agent.terminalId, status: this.tracker.status(agent), sequence: agent.sequence, completion: this.tracker.completion(agent.terminalId) }));
    // Tapping the selected chip opens its tree, as does tapping another repository when the tree setting is chosen.
    const tap = item?.repo ? this.stripSelection === id ? undefined : repoTap(item.repo, this.tapMode, this.preferences.repoSpaces![item.repo.id], panes) : item?.space && { space: item.space };
    if (item?.repo && !tap) {
      const anchor = this.strip.querySelector<HTMLElement>('[data-terminal="' + CSS.escape(id) + '"]');
      if (anchor) this.openTree(anchor, item.repo); return;
    }
    this.selectTerminal(tap ? tap.terminalId || this.terminalFor(this.spaceItem(tap.space)) : id);
  }
  private selectTerminal(id: string) {
    this.closeMenu();
    const terminal = this.terminals.find(t => t.terminalId === id);
    if (terminal?.workspaceId) this.preferences.spaceTerminals![terminal.workspaceId] = id;
    if (id === this.selected) { this.post({ type: 'focus-terminal' }); return; }
    this.selected = id; this.save(); this.render(); this.mountTerminal();
  }
  private ordered() {
    const entries = new Map(this.entries().map(item => [item.terminalId, item]));
    return this.order.map(id => entries.get(id)).filter((item): item is StripItem => !!item);
  }
  private save() {
    this.preferences.selected = this.selected;
    // Each repository chip reopens the checkout last used in it.
    const workspace = this.terminals.find(terminal => terminal.terminalId === this.selected)?.workspaceId, repo = this.repoOf(workspace);
    if (repo) this.preferences.repoSpaces![repo.id] = workspace!;
    this.preferences.state = this.tracker.checkpoint();
    this.preferenceTimer ??= setTimeout(() => this.writePreferences(), 250);
  }
  private writePreferences() {
    clearTimeout(this.preferenceTimer); this.preferenceTimer = undefined;
    const serialized = JSON.stringify(this.preferences);
    if (serialized === this.savedPreferences) return;
    try { localStorage.setItem(this.host.key, serialized); this.savedPreferences = serialized; } catch { /* This view still works without persistence. */ }
  }
  private cacheLater(snapshot: unknown) {
    this.uncached = snapshot;
    this.cacheTimer ??= setTimeout(() => typeof requestIdleCallback === 'function' ? requestIdleCallback(() => this.writeCache(), { timeout: 5000 }) : this.writeCache(), 5000);
  }
  private writeCache() {
    clearTimeout(this.cacheTimer); this.cacheTimer = undefined;
    const snapshot = this.uncached === undefined ? undefined : herdrCache(this.uncached);
    this.uncached = undefined;
    if (snapshot) try { localStorage.setItem(this.host.key + '.snapshot', JSON.stringify(snapshot)); } catch { /* The next load waits for a live snapshot. */ }
  }
  private render() {
    this.statuses = new Map(this.tracker.agents.map(agent => [agent.terminalId, this.tracker.status(agent)]));
    this.strip.setAttribute('aria-busy', String(!this.liveSnapshot));
    this.host.changed(this.tracker.attention);
    this.strip.setAttribute('aria-label', this.spaceMode ? 'Herdr spaces' : 'Herdr agents');
    this.empty.hidden = !!this.selected;
    this.empty.textContent = this.spaceMode ? 'Create a space with + in the strip below.' : 'No agents are running. Use + to create a space.';
    if (this.held) {
      const entries = new Map(this.entries().map(item => [item.terminalId, item]));
      for (const tab of this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')) {
        const agent = entries.get(tab.dataset.terminal!);
        if (agent) tab.dataset.status = this.statusFor(agent);
      }
      return;
    }
    const lanes = this.laneMode ? statusLanes(this.ordered(), item => this.laneFor(item)) : undefined;
    if (!lanes) this.pinnedLane = undefined;
    const agents = lanes ? lanes.flatMap(lane => lane.items) : this.ordered();
    const key = JSON.stringify([this.liveSnapshot, this.spaceMode, this.creatingSpace, this.stripSelection, this.preferences.collapsedLanes, this.preferences.collapsedGroups,
      this.preferences.spaceGroups, lanes?.map(lane => [lane.lane, lane.items.map(item => item.terminalId)]), agents.map(agent => [agent.terminalId, agent.name, agent.kind, agent.workspace, agent.space?.name, agent.repo?.spaces.length, this.statusFor(agent)])]);
    if (key === this.stripKey) { if (this.tree) this.refreshTree(); return; }
    this.stripKey = key;
    const scroll = this.strip.scrollLeft; this.strip.replaceChildren(this.tabsToggle);
    const stacks = new Map<string, HTMLElement>(), laneGroups = new Map<HerdrLane, HTMLElement>();
    for (const agent of agents) {
      const tab = node('button', 'herdr-agent-tab'); tab.type = 'button'; tab.role = 'tab'; tab.dataset.terminal = agent.terminalId; tab.dataset.status = this.statusFor(agent);
      tab.setAttribute('aria-selected', String(agent.terminalId === this.stripSelection)); tab.tabIndex = agent.terminalId === this.stripSelection ? 0 : -1;
      tab.setAttribute('aria-controls', this.screen.id); tab.setAttribute('aria-haspopup', 'menu');
      const checkouts = agent.repo && agent.repo.spaces.length > 1 ? agent.repo.spaces.length : 0, place = checkouts ? agent.space!.name : agent.workspace;
      tab.setAttribute('aria-label', agent.name + ' · ' + this.statusFor(agent) + ' · ' + place);
      tab.title = agent.name + ' · ' + agent.kind + ' · ' + this.statusFor(agent) + ' · ' + place;
      tab.append(node('span', 'herdr-status-dot'));
      if (checkouts && agent.terminalId === this.stripSelection) {
        // The open repository names its current checkout beneath the repository and its checkout count.
        const label = node('span', 'herdr-space-label');
        label.append(node('span', 'herdr-repo-name', agent.name + ' · ' + checkouts), node('span', 'herdr-agent-name', agent.space!.name)); tab.append(label);
      } else tab.append(node('span', 'herdr-agent-name', agent.name), ...checkouts ? [node('span', 'herdr-repo-count', String(checkouts))] : []);
      const lane = lanes?.find(lane => lane.items.includes(agent));
      const group = !lane && agent.space && this.preferences.spaceGroups!.find(group => group.includes(agent.terminalId));
      let parent: HTMLElement = this.strip;
      if (lane) {
        const collapsed = this.preferences.collapsedLanes!.includes(lane.lane);
        let box = laneGroups.get(lane.lane);
        if (!box) {
          const name = herdrLaneNames[lane.lane], count = lane.items.length;
          box = node('div', 'herdr-status-lane'); box.role = 'group'; box.dataset.lane = lane.lane;
          box.setAttribute('aria-label', name + ', ' + count + ' ' + (this.spaceMode ? 'space' : 'agent') + (count === 1 ? '' : 's'));
          const toggle = node('button', 'herdr-lane-toggle'); toggle.type = 'button'; toggle.dataset.status = lane.lane;
          toggle.append(node('span', 'herdr-status-dot'), String(count));
          toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + name.toLowerCase()); toggle.setAttribute('aria-expanded', String(!collapsed));
          toggle.onclick = () => { this.preferences.collapsedLanes = collapsed ? this.preferences.collapsedLanes!.filter(id => id !== lane.lane) : [...this.preferences.collapsedLanes!, lane.lane]; this.save(); this.render(); };
          box.append(toggle); laneGroups.set(lane.lane, box); this.strip.append(box);
        }
        parent = box;
        // Lane headers carry the status, so a tab shows its own dot only while pinned in a lane it has left.
        tab.classList.toggle('herdr-lane-moved', herdrLane(this.statusFor(agent)) !== lane.lane);
        if (collapsed) tab.hidden = agent.terminalId !== this.stripSelection;
      } else if (group) {
        let stack = stacks.get(group[0]);
        if (!stack) {
          stack = node('div', 'herdr-space-stack'); stack.role = 'group'; stack.setAttribute('aria-label', 'Stack of ' + group.length + ' spaces');
          const toggle = node('button', 'herdr-stack-toggle', String(group.length)); toggle.type = 'button';
          const collapsed = this.preferences.collapsedGroups!.includes(group[0]);
          toggle.setAttribute('aria-label', collapsed ? 'Expand space stack' : 'Collapse space stack'); toggle.setAttribute('aria-expanded', String(!collapsed));
          toggle.onclick = () => { this.preferences.collapsedGroups = collapsed ? this.preferences.collapsedGroups!.filter(id => id !== group[0]) : [...this.preferences.collapsedGroups!, group[0]]; this.save(); this.render(); };
          stack.append(toggle); stacks.set(group[0], stack); this.strip.append(stack);
        }
        parent = stack;
        if (this.preferences.collapsedGroups!.includes(group[0])) tab.hidden = agent.terminalId !== (group.includes(this.stripSelection) ? this.stripSelection : group[0]);
      }
      tab.addEventListener('pointerdown', event => { if (event.button === 0) this.held = true; });
      tabGestures(tab, {
        select: () => this.select(agent.terminalId), hold: () => { const current = this.entries().find(item => item.terminalId === agent.terminalId); if (current) { if (current.repo) this.openTree(tab, current.repo); else this.openMenu(tab, current); } }, scroll: this.strip,
        dragging: () => { this.closeMenu(); this.clearDrop(); },
        // Status lanes own the order, so holding a tab only opens its actions.
        drag: lanes ? undefined : x => {
          if (x < this.strip.getBoundingClientRect().left + 24) this.strip.scrollLeft -= 10;
          if (x > this.strip.getBoundingClientRect().right - 24) this.strip.scrollLeft += 10;
          if (agent.space) { this.previewDrop(tab, x); return; }
          const siblings = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')], index = siblings.indexOf(tab);
          const target = siblings.find((item, i) => { const rect = item.getBoundingClientRect(); return i !== index && x >= rect.left && x <= rect.right && (i < index ? x < rect.left + rect.width / 2 : x > rect.left + rect.width / 2); });
          if (target) {
            const targetIndex = siblings.indexOf(target); this.strip.insertBefore(tab, targetIndex > index ? target.nextSibling : target);
            const visible = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')].map(item => item.dataset.terminal!);
            this.order = [...visible, ...this.order.filter(id => !visible.includes(id))]; this.dragOrderChanged = true;
          }
          this.showDrop(tab, 'slot');
        },
        drop: x => { if (agent.space) { this.previewDrop(tab, x); const target = this.dropTarget; if (target) void this.moveSpace(agent.terminalId, target.id, target.drop); } },
        finish: () => { this.held = false; this.clearDrop(); if (this.dragOrderChanged) { this.save(); this.dragOrderChanged = false; } setTimeout(() => { if (!this.disposed) this.render(); }, 0); },
      });
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); const index = agents.indexOf(agent), next = agents[(index + (event.key === 'ArrowRight' ? 1 : agents.length - 1)) % agents.length];
        if (event.altKey) {
          if (lanes) return;
          if (agent.space) { void this.moveSpace(agent.terminalId, next.terminalId, event.key === 'ArrowRight' ? 'after' : 'before'); return; }
          const a = this.order.indexOf(agent.terminalId), b = this.order.indexOf(next.terminalId);
          const order = [...this.order]; [order[a], order[b]] = [order[b], order[a]]; this.order = order; this.save(); this.render();
          this.strip.querySelector<HTMLButtonElement>('[data-terminal="' + CSS.escape(agent.terminalId) + '"]')?.focus();
        } else { this.select(next.terminalId); this.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
      };
      parent.append(tab);
    }
    const add = node('button', 'herdr-agent-add', '+'); add.type = 'button'; add.setAttribute('aria-label', 'Create space'); add.disabled = !this.liveSnapshot || this.creatingSpace; add.onclick = () => void this.createSpace(); this.strip.append(add); this.strip.scrollLeft = scroll;
    if (this.tree) this.refreshTree();
  }
  private clearDrop() {
    this.dropIndicator.hidden = true;
    this.dropTarget = undefined;
    for (const tab of this.strip.querySelectorAll<HTMLElement>('[data-drop]')) delete tab.dataset.drop;
  }
  private showDrop(target: HTMLElement, drop: SpaceDrop | 'slot') {
    const rect = target.getBoundingClientRect(), strip = this.strip.getBoundingClientRect();
    const left = Math.max(rect.left, strip.left + 4), right = Math.min(rect.right, strip.right - 4);
    if (right <= left) { this.dropIndicator.hidden = true; return; }
    const edge = drop === 'before' || drop === 'after';
    const markerLeft = edge ? (drop === 'before' ? left : right) - 4 : left - 3;
    const top = Math.max(40, rect.top - 56);
    this.dropIndicator.dataset.drop = drop;
    Object.assign(this.dropIndicator.style, { left: markerLeft + 'px', top: top + 'px', width: (edge ? 8 : right - left + 6) + 'px', height: rect.bottom + 3 - top + 'px' });
    this.dropLabel.textContent = drop === 'group' ? 'Group here' : 'Drop here';
    const center = edge ? markerLeft + 4 : (left + right) / 2;
    this.dropLabel.style.left = Math.max(60, Math.min(innerWidth - 60, center)) - markerLeft + 'px';
    this.dropIndicator.hidden = false;
  }
  private previewDrop(source: HTMLElement, x: number) {
    this.clearDrop();
    if (this.movingSpace) return;
    const target = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')].find(tab => { const rect = tab.getBoundingClientRect(); return tab !== source && !tab.hidden && x >= rect.left && x <= rect.right; });
    if (!target) return;
    const rect = target.getBoundingClientRect(), position = (x - rect.left) / rect.width;
    const drop: SpaceDrop = position < .25 ? 'before' : position > .75 ? 'after' : 'group';
    this.dropTarget = { id: target.dataset.terminal!, drop }; target.dataset.drop = drop;
    this.showDrop(target, drop);
  }
  private async moveSpace(source: string, target: string, drop: SpaceDrop) {
    if (this.movingSpace) return;
    const layout = dropSpace(spaceLayout(this.preferences.spaceOrder!, this.preferences.spaceGroups!), source, target, drop);
    if (!layout.order.includes(source) || !layout.order.includes(target) || source === target) return;
    // Herdr orders single spaces, so each checkout of a repository moves in front of the next repository's first space.
    const next = layout.order[layout.order.indexOf(source) + 1], members = this.repos.find(repo => repo.id === source)?.spaces || [];
    const before = next && this.spaces.find(space => this.repoOf(space.id)?.id === next)?.id, moving = this.spaces.filter(space => members.includes(space));
    this.movingSpace = true;
    try {
      for (const space of moving) await this.host.api('api/herdr/action', { action: 'move-space', workspaceId: space.id, ...(before ? { beforeWorkspaceId: before } : {}) });
      if (this.disposed) return;
      this.preferences.spaceGroups = layout.groups;
      if (drop === 'group') this.preferences.collapsedGroups = this.preferences.collapsedGroups!.filter(id => !layout.groups.find(group => group.includes(source))?.includes(id));
      await this.refreshSnapshot();
    } catch (error: any) { if (!this.disposed) this.host.fail(error); }
    finally { this.movingSpace = false; }
  }
  private async createSpace() {
    if (this.creatingSpace) return;
    this.creatingSpace = true; this.closeMenu(); this.render();
    const terminal = this.terminals.find(terminal => terminal.terminalId === this.selected);
    const space = this.spaces.find(space => space.id === terminal?.workspaceId) || this.spaces[0];
    try {
      const result = await this.host.api<{ workspaceId: string; terminalId?: string }>('api/herdr/action', { action: 'create-space', ...(space ? { workspaceId: space.id } : {}), ...(terminal ? { terminalId: terminal.terminalId } : {}) });
      if (this.disposed) return;
      const snapshot = await this.host.api<HerdrSnapshot>('api/herdr/snapshot');
      try { localStorage.setItem('libertty.herdrStrip', JSON.stringify('spaces')); } catch { /* Default to spaces when preferences are unavailable. */ }
      this.selected = result.terminalId || snapshot.spaces?.find(space => space.id === result.workspaceId)?.selectedTerminalId || '';
      this.receive({ type: 'snapshot', snapshot });
      this.strip.querySelector<HTMLElement>('[data-terminal="' + CSS.escape(this.repoOf(result.workspaceId)?.id || 'space:' + result.workspaceId) + '"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (error: any) { if (!this.disposed) this.host.fail(error); }
    finally { this.creatingSpace = false; if (!this.disposed) this.render(); }
  }
  private popup(anchor: HTMLElement) {
    this.menu.hidden = false;
    const parent = this.element.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
    this.menu.role = 'menu'; this.menu.style.width = '';
    this.menu.style.left = Math.max(8, Math.min(rect.left - parent.left, parent.width - this.menu.offsetWidth - 8)) + 'px';
    this.menu.style.top = Math.max(8, rect.top - parent.top - this.menu.offsetHeight - 5) + 'px';
  }
  private openMenu(anchor: HTMLElement, agent: StripItem) {
    if (!this.liveSnapshot) return;
    this.menu.replaceChildren();
    this.menu.setAttribute('aria-label', agent.name + ' tab actions');
    const rename = node('button', '', 'Rename'); rename.role = 'menuitem'; rename.onclick = () => this.dialogs.rename(agent);
    const close = node('button', '', 'Close tab'); close.role = 'menuitem'; close.disabled = !this.liveSnapshot || this.closing.has(agent.terminalId); close.onclick = () => void this.closeTab(agent);
    this.menu.append(rename, close); this.popup(anchor); rename.focus({ preventScroll: true });
  }
  private closeMenu() {
    this.menu.hidden = true; this.tree = undefined; this.renaming = false;
    this.menu.classList.remove('herdr-tree'); this.menu.style.transform = this.menu.style.touchAction = this.menu.style.width = '';
    this.treeBridge.hidden = true; this.screen.classList.remove('herdr-screen-dim');
    for (const anchor of this.strip.querySelectorAll('.herdr-tree-anchor')) anchor.classList.remove('herdr-tree-anchor');
  }
  /** A repository's spaces, panes and worktree actions open as a tree attached to its chip. */
  private openTree(anchor: HTMLElement, repo: SpaceRepo) {
    if (this.dialogs.active) return;
    this.closeMenu(); anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.tree = { repo: repo.id, signature: '' };
    this.menu.role = 'dialog'; this.menu.setAttribute('aria-label', repo.name + ' spaces'); this.menu.classList.add('herdr-tree');
    this.menu.hidden = false; this.screen.classList.add('herdr-screen-dim');
    this.refreshTree(true);
    this.menu.querySelector<HTMLElement>('[aria-current=true]')?.focus({ preventScroll: true });
  }
  private refreshTree(rebuild = false) {
    const repo = this.repos.find(repo => repo.id === this.tree?.repo);
    const anchor = repo && this.strip.querySelector<HTMLElement>('.herdr-agent-tab[data-terminal="' + CSS.escape(repo.id) + '"]');
    if (!this.tree || !repo || !anchor || anchor.hidden) { this.closeMenu(); return; }
    if (!this.renaming) {
      const panes = this.terminals.filter(terminal => repo.spaces.some(space => space.id === terminal.workspaceId)).map(terminal => [terminal.terminalId, terminal.name]);
      const signature = JSON.stringify([repo.spaces.map(space => [space.id, space.name, space.terminalIds]), panes, this.selected, [...this.closing]]);
      if (rebuild || signature !== this.tree.signature) { this.tree.signature = signature; this.buildTree(repo); }
      else for (const pane of this.menu.querySelectorAll<HTMLElement>('.herdr-pane')) {
        const terminal = this.terminals.find(terminal => terminal.terminalId === pane.dataset.terminal);
        if (terminal) pane.dataset.status = this.tracker.status(terminal);
      }
    }
    for (const other of this.strip.querySelectorAll('.herdr-tree-anchor')) if (other !== anchor) other.classList.remove('herdr-tree-anchor');
    anchor.classList.add('herdr-tree-anchor');
    // Phones get a full-width tree; wider screens keep it beside its chip.
    const parent = this.element.getBoundingClientRect(), rect = anchor.getBoundingClientRect(), width = parent.width > 560 ? 420 : parent.width - 16;
    const preferredLeft = Math.max(8, Math.min(rect.left - parent.left, parent.width - width - 8));
    const bridgeLeft = Math.max(parent.left, rect.left), bridgeRight = Math.min(parent.right, rect.right);
    const left = Math.min(preferredLeft, bridgeLeft - parent.left), right = Math.max(preferredLeft + width, bridgeRight - parent.left);
    this.menu.style.width = right - left + 'px';
    this.menu.style.left = left + 'px';
    this.menu.style.top = Math.max(8, rect.top - parent.top - this.menu.offsetHeight - 6) + 'px';
    // Without overflow the whole tree can be swiped away; otherwise only its grab bar can.
    this.menu.style.touchAction = this.menu.scrollHeight > this.menu.clientHeight ? '' : 'none';
    // The bridge joins the tree to its chip so it reads as that chip's own panel.
    const menu = this.menu.getBoundingClientRect();
    this.menu.style.setProperty('--herdr-tree-left-gap', Math.max(0, bridgeLeft - menu.left) + 'px');
    this.menu.style.setProperty('--herdr-tree-right-gap', Math.max(0, menu.right - bridgeRight) + 'px');
    Object.assign(this.treeBridge.style, { left: bridgeLeft + 'px', width: bridgeRight - bridgeLeft + 'px', top: menu.bottom - 1 + 'px', height: Math.max(0, rect.top - menu.bottom + 3) + 'px' });
    this.treeBridge.hidden = false;
  }
  private buildTree(repo: SpaceRepo) {
    const grabber = node('div', 'herdr-tree-grabber'); grabber.setAttribute('aria-hidden', 'true');
    this.menu.replaceChildren(grabber);
    const root = repo.root, children = repo.spaces.filter(space => space !== root);
    if (root) this.menu.append(this.treeNode(root, repo));
    else {
      // Worktrees whose root checkout is not open still group under their repository.
      const head = node('div', 'herdr-tree-head'), title = node('span', 'herdr-tree-title');
      title.innerHTML = icons.folder; title.append(node('span', 'herdr-tree-name', repo.name)); head.append(title); this.menu.append(head);
    }
    if (children.length) {
      const kids = node('div', 'herdr-tree-kids'); kids.role = 'group'; kids.setAttribute('aria-label', 'Worktrees');
      for (const space of children) kids.append(this.treeNode(space, repo));
      this.menu.append(kids);
    }
    // Herdr records a repository only once a worktree exists, so any root checkout may still start one.
    const actions = node('div', 'herdr-tree-actions');
    for (const [label, action, svg] of [['New worktree', 'new-worktree', icons.plus], ['Open worktree…', 'open-worktree', icons.open]] as const) {
      const button = node('button'); button.type = 'button'; button.innerHTML = svg; button.append(label);
      button.disabled = !this.liveSnapshot || !root; if (!root) button.title = 'Open the repository’s main checkout as a space to add worktrees.';
      button.onclick = () => { if (root) { const item = this.spaceItem(root); void this.dialogs.spaceAction(item, action, this.terminalFor(item)); } };
      actions.append(button);
    }
    this.menu.append(actions);
  }
  private treeNode(space: HerdrSpace, repo: SpaceRepo) {
    const item = this.spaceItem(space), current = this.terminals.find(t => t.terminalId === this.selected)?.workspaceId === space.id, root = space === repo.root;
    const box = node('div', 'herdr-tree-node'), head = node('div', 'herdr-tree-head'), title = node('button', 'herdr-tree-title');
    box.dataset.space = space.id; box.classList.toggle('herdr-tree-root', root); head.classList.toggle('herdr-tree-current', current);
    title.type = 'button'; title.innerHTML = root ? icons.folder : icons.branch; title.append(node('span', 'herdr-tree-name', space.name));
    if (root && repo.git && repo.name !== space.name) title.append(node('span', 'herdr-tree-repo', repo.name));
    title.setAttribute('aria-label', 'Open ' + space.name + (current ? ', the current space' : '') + '. Hold to rename.');
    tabGestures(title, { select: () => { const terminal = this.terminalFor(item); if (terminal) this.selectTerminal(terminal); }, hold: () => this.renameInline(head, item) });
    const close = node('button', 'herdr-tree-close'); close.type = 'button'; close.innerHTML = icons.close;
    close.setAttribute('aria-label', 'Close ' + space.name); close.disabled = !this.liveSnapshot || this.closing.has(item.terminalId); close.onclick = () => this.dialogs.closeSpace(item);
    head.append(title, close);
    const panes = node('div', 'herdr-tree-panes'); panes.role = 'group'; panes.setAttribute('aria-label', space.name + ' panes');
    for (const id of space.terminalIds) {
      const terminal = this.terminals.find(terminal => terminal.terminalId === id);
      if (!terminal) continue;
      const pill = node('div', 'herdr-pane'), focus = node('button', 'herdr-pane-focus'), status = this.tracker.status(terminal);
      pill.dataset.terminal = id; pill.dataset.status = status;
      focus.type = 'button'; focus.append(node('span', 'herdr-status-dot'), node('span', 'herdr-pane-name', terminal.name));
      focus.setAttribute('aria-label', terminal.name + ' · ' + status + '. Hold to rename.');
      if (id === this.selected) focus.setAttribute('aria-current', 'true');
      tabGestures(focus, { select: () => this.selectTerminal(id), hold: () => this.renameInline(pill, terminal) });
      const remove = node('button', 'herdr-pane-close'); remove.type = 'button'; remove.innerHTML = icons.close;
      remove.setAttribute('aria-label', 'Close ' + terminal.name); remove.disabled = !this.liveSnapshot || this.closing.has(id); remove.onclick = () => void this.closeTab(terminal);
      pill.append(focus, remove); panes.append(pill);
    }
    const split = node('button', 'herdr-pane-add', '+ split'); split.type = 'button'; split.disabled = !this.liveSnapshot; split.setAttribute('aria-label', 'Split a pane in ' + space.name); split.onclick = () => void this.dialogs.spaceAction(item, 'split', this.terminalFor(item));
    panes.append(split); box.append(head, panes);
    return box;
  }
  /** Holding a space or pane name edits it in place; the shared label also changes on the desktop. */
  private renameInline(target: HTMLElement, item: StripItem) {
    if (!this.liveSnapshot || this.renaming || !this.tree) return;
    this.renaming = true;
    const form = node('form', 'herdr-tree-rename ' + (item.space ? 'herdr-tree-head' : 'herdr-pane')), input = node('input'), save = node('button', 'herdr-tree-save');
    input.value = item.name; input.maxLength = 100; input.required = true; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', item.space ? 'Space name' : 'Pane name');
    save.type = 'submit'; save.innerHTML = icons.check; save.setAttribute('aria-label', 'Save name');
    const finish = () => { this.renaming = false; if (this.tree) this.refreshTree(true); };
    input.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); } };
    form.onsubmit = async event => {
      event.preventDefault(); if (save.disabled) return;
      save.disabled = input.disabled = true;
      try {
        await this.host.api('api/herdr/action', { action: item.space ? 'rename-space' : 'rename', terminalId: item.terminalId, workspaceId: item.space?.id, name: herdrName(input.value) });
        this.renaming = false; await this.refreshSnapshot(); finish();
      } catch (error: any) {
        if (this.disposed || !form.isConnected) return;
        this.renaming = true; save.disabled = input.disabled = false; this.host.fail(error); input.focus();
      }
    };
    form.append(input, save); target.replaceWith(form); input.focus(); input.select();
  }
  private async closeTab(item: StripItem) {
    if (this.closing.has(item.terminalId)) return;
    this.closing.add(item.terminalId); if (!this.tree) this.closeMenu();
    try {
      await this.host.api('api/herdr/action', item.space
        ? { action: 'close-space', workspaceId: item.space.id }
        : { action: 'close', terminalId: item.terminalId });
      await this.refreshSnapshot();
    } catch (error: any) { if (!this.disposed) this.host.fail(error); }
    finally { this.closing.delete(item.terminalId); }
  }
  private async refreshSnapshot(created?: Created) {
    const snapshot = await this.host.api<HerdrSnapshot>('api/herdr/snapshot');
    if (this.disposed) return;
    if (created) this.selected = created.terminalId || snapshot.spaces.find(space => space.id === created.workspaceId)?.selectedTerminalId || this.selected;
    this.receive({ type: 'snapshot', snapshot });
  }

  applySettings() { this.ensureSelection(); this.save(); this.render(); this.mountTerminal(); this.post({ type: 'settings-changed' }); }
  private currentNotifications(): HerdrNotification[] {
    const receipts: HerdrNotification[] = [], states = this.tracker.checkpoint();
    for (const agent of this.tracker.agents) {
      if (agent.status === 'blocked') receipts.push({ terminalId: agent.terminalId, kind: 'request', sequence: agent.sequence });
      else if ((agent.status === 'idle' || agent.status === 'done') && states[agent.terminalId]?.completion !== undefined) receipts.push({ terminalId: agent.terminalId, kind: 'done', sequence: states[agent.terminalId].completion! });
    }
    return receipts;
  }
  private acknowledge(events: HerdrNotification[]) {
    const device = this.host.notificationDevice?.();
    if (device && this.ws?.readyState === WebSocket.OPEN && !document.hidden && document.hasFocus()) for (const event of events) this.ws.send(JSON.stringify({ type: 'notification-ack', device, event }));
  }
  updatePresence() {
    const device = this.host.notificationDevice?.();
    if (device && this.ws?.readyState === WebSocket.OPEN) {
      this.presenceAt = Date.now();
      this.ws.send(JSON.stringify({ type: 'notification-presence', device, focused: !document.hidden && document.hasFocus() }));
      if (device !== this.presenceDevice) { this.presenceDevice = device; this.acknowledge(this.currentNotifications()); }
    }
  }
  openTerminal(id: string) { if (this.terminals.some(agent => agent.terminalId === id)) this.selectTerminal(id); else this.requestedTerminal = id; }
  copySelection() { this.post({ type: 'settings-action', action: 'copy-selection' }); }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.writePreferences(); this.writeCache(); this.dialogs.active?.close();
    this.dropIndicator.remove(); this.treeBridge.remove();
    clearTimeout(this.recoveryRetry); this.transport.suspend(); this.frames.dispose(); this.strip.remove(); this.element.remove();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }
}
