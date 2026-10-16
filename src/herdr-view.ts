import { node } from './dom.ts';
import { readingOpen, type ReadingOpen } from './reading-request.ts';
import { wireProtocols } from './wire.ts';
import { ReconnectingSocket } from './reconnecting-socket.ts';
import { herdrName, type HerdrAgent, type HerdrMessage, type HerdrSpace, type HerdrWorktrees } from './herdr-protocol.ts';
import { HerdrState, type HerdrNotification } from './herdr-state.ts';
import { herdrCache } from './herdr-cache.ts';
import { tabGestures } from './tab-gestures.ts';
import { dropSpace, repoSpace, repoTap, spaceLayout, spaceRepos, spaceTerminal, worktreePath, type RepoTap, type SpaceDrop, type SpaceRepo } from './herdr-spaces.ts';
import { herdrLane, herdrLaneNames, statusLanes, type HerdrLane } from './herdr-lanes.ts';
import './herdr.css';

const icon = (body: string, size = 15) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icons = {
  folder: icon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', 16),
  open: icon('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
  branch: icon('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>', 14),
  check: icon('<path d="M20 6 9 17l-5-5"/>', 16),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
};

interface Host {
  url: string; session: string; source?: string; key: string;
  token(): string | undefined; authenticate(): Promise<void>;
  api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T>;
  changed(attention: number): void; notification(event: HerdrNotification): void;
  notice(message: string): void;
  reading(terminalId: string, request: ReadingOpen): void;
  reconnect?(): Promise<void>;
  ready?(): void;
  toggleTerminalTabs?(): void;
  notificationDevice?(): string | undefined;
}
interface CachedTerminal { frame:HTMLIFrameElement; session:string; pane:string; retain:boolean; rendered:boolean; presentation?:string; geometry?:string; locked?:boolean; width?:number; height?:number }
type StripItem = HerdrAgent & { space?: HerdrSpace; repo?: SpaceRepo };
interface Preferences { order: string[]; spaceOrder?: string[]; spaceGroups?: string[][]; collapsedGroups?: string[]; collapsedLanes?: HerdrLane[]; spaceTerminals?: Record<string, string>; repoSpaces?: Record<string, string>; selected?: string; state?: ReturnType<HerdrState['checkpoint']>; snapshot?: unknown }
export class HerdrView {
  readonly element = node('section', 'herdr-view');
  private strip = node('div', 'herdr-agent-strip');
  private tabsToggle = node('button', 'herdr-tabs-toggle');
  private screen = node('div', 'herdr-screen');
  private frame?: HTMLIFrameElement;
  private displayed?: HTMLIFrameElement;
  private terminalFrames = new Map<string, CachedTerminal>();
  private status = node('div', 'herdr-connection');
  private empty = node('div', 'herdr-empty');
  private loading = node('div', 'herdr-loading');
  private loadingLabel = node('span');
  private menu = node('div', 'herdr-tab-menu');
  private dropIndicator = node('div', 'herdr-drop-indicator');
  private dropLabel = node('span', 'herdr-drop-label');
  private treeBridge = node('div', 'herdr-tree-bridge');
  private tracker = new HerdrState();
  private preferences: Preferences;
  private transport!: ReconnectingSocket;
  private get ws() { return this.transport?.socket; }
  private offeredWire?: string[];
  private supportsHeartbeat = false;
  private backgroundExpired = false;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
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
  private presenceTimer?: ReturnType<typeof setInterval>;
  private presenceDevice = '';
  private terminals: HerdrAgent[] = [];
  private spaces: HerdrSpace[] = [];
  private repos: SpaceRepo[] = [];
  private tree?: { repo: string; signature: string };
  private renaming = false;
  private rendered = false;
  private handoffHeld = false;
  private navigationResize = 0;
  private held = false;
  private dragOrderChanged = false;
  private dropTarget?: { id: string; drop: SpaceDrop };
  private pinnedLane?: { id: string; lane: HerdrLane };
  private movingSpace = false;
  private creatingSpace = false;
  private closing = new Set<string>();
  private actionDialog?: HTMLDialogElement;
  private unsubscribers: (() => void)[] = [];
  private host: Host;
  constructor(host: Host) {
    this.host = host;
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
    const cached = herdrCache(this.preferences.snapshot);
    if (cached) {
      this.cached = true; this.terminals = cached.terminals || cached.agents; this.spaces = cached.spaces || []; this.repos = spaceRepos(this.spaces);
      this.tracker.agents = cached.agents; this.ensureSelection();
    }
    this.element.setAttribute('aria-label', 'Herdr connection');
    this.element.role = 'tabpanel'; this.screen.id = 'herdr-terminal-' + crypto.randomUUID(); this.screen.role = 'tabpanel'; this.screen.setAttribute('aria-label', 'Agent terminal');
    this.strip.role = 'tablist'; this.strip.setAttribute('aria-label', 'Herdr agents');
    this.tabsToggle.type = 'button'; this.tabsToggle.setAttribute('aria-controls', 'terminal-tabs-drawer');
    this.tabsToggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
    this.tabsToggle.onclick = () => this.host.toggleTerminalTabs?.(); this.setTerminalTabsExpanded(false);
    this.menu.role = 'menu'; this.menu.hidden = true; this.treeBridge.hidden = true; this.treeBridge.setAttribute('aria-hidden', 'true');
    this.dropIndicator.hidden = true; this.dropIndicator.setAttribute('aria-hidden', 'true');
    this.dropIndicator.append(this.dropLabel); document.body.append(this.dropIndicator, this.treeBridge);
    this.status.setAttribute('role', 'status');
    this.loading.role = 'status'; this.loading.hidden = true;
    const spinner = node('span', 'terminal-loading-spinner'); spinner.setAttribute('aria-hidden', 'true');
    this.loading.append(spinner, this.loadingLabel);
    this.screen.append(this.status, this.empty, this.loading);
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
    const viewed = () => { if (this.visible && this.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } };
    const messages = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const entry = [...this.terminalFrames.values()].find(entry => event.source === entry.frame.contentWindow && event.data?.session === entry.session);
      if (!entry) return;
      const active = entry.frame === this.frame;
      if (event.data.type === 'terminal-loaded') {
        entry.frame.contentWindow?.postMessage({ type: 'shortcut-host' }, location.origin);
        entry.frame.contentWindow?.postMessage({ type:'herdr-present', presentation:entry.presentation },location.origin);
        entry.frame.contentWindow?.postMessage({ type:'authorize', accessToken:this.host.token() },location.origin);
        entry.frame.contentWindow?.postMessage({ type:'tab-visibility', visible:this.visible },location.origin);
      }
      if (event.data.type === 'terminal-ready') entry.retain = event.data.retainGeometry === true;
      const geometry = event.data.cols + 'x' + event.data.rows;
      if (event.data.type === 'terminal-sizing' && active && event.data.presentation === entry.presentation) entry.geometry = geometry;
      if (event.data.type === 'terminal-rendered' && active && this.visible && !this.handoffHeld && event.data.presentation === entry.presentation && geometry === entry.geometry) {
        entry.rendered = true;
        if (this.displayed && this.displayed !== entry.frame) this.park(this.displayed);
        this.displayed = entry.frame; entry.frame.className = 'herdr-terminal'; entry.frame.style.visibility = ''; entry.frame.inert = false;
        const bounds = entry.frame.getBoundingClientRect(); entry.width = bounds.width; entry.height = bounds.height;
        this.rendered = true; this.setLoading(false); viewed(); this.host.ready?.();
      }
      if (active && event.data.type === 'terminal-notice') this.host.notice(event.data.message);
      if (event.data.type === 'reading-open' && readingOpen(event.data)) this.host.reading(entry.frame.dataset.terminal!, event.data);
      if (event.data.type === 'terminal-ended') void this.refreshSnapshot().catch(error => { if (error.status !== 404) this.connectionError(error); });
      if (event.data.type === 'terminal-locked') entry.locked = true;
      if (active && event.data.type === 'terminal-locked') void this.host.authenticate().then(() => entry.frame.contentWindow?.postMessage({ type:'authorize', accessToken:this.host.token() },location.origin)).catch(error => this.host.notice(error.message));
    };
    document.addEventListener('visibilitychange', viewed); window.addEventListener('focus', viewed); window.addEventListener('message', messages);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', viewed), () => window.removeEventListener('focus', viewed), () => window.removeEventListener('message', messages));
    const presence = () => this.updatePresence();
    document.addEventListener('visibilitychange', presence); window.addEventListener('focus', presence); window.addEventListener('blur', presence);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', presence), () => window.removeEventListener('focus', presence), () => window.removeEventListener('blur', presence));
    const resume = (event: Event) => {
      if (this.disposed) return;
      clearTimeout(this.backgroundTimer);
      if (!navigator.onLine) { this.transport.suspend(); return; }
      if (document.hidden) {
        this.backgroundTimer = setTimeout(() => { this.backgroundExpired = true; this.transport.suspend(); }, 20000);
        return;
      }
      this.backgroundExpired = false;
      void this.transport.resume(event.type === 'online' || !this.transport.healthy);
    };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('pageshow', resume);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', resume), () => window.removeEventListener('online', resume), () => window.removeEventListener('pageshow', resume));
    this.presenceTimer = setInterval(presence, 15000);
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
      available: () => !this.disposed && !this.recovering && (!document.hidden || !this.backgroundExpired) && navigator.onLine,
      protocols: () => wireProtocols(this.offeredWire),
      heartbeat: () => this.supportsHeartbeat,
      prepare: async signal => {
        const { ticket, wire, heartbeat } = await this.host.api<{ ticket: string; wire?: string[]; heartbeat?: boolean }>('api/herdr/ticket', {}, signal);
        signal.throwIfAborted(); this.offeredWire = wire; this.supportsHeartbeat = heartbeat === true;
        const url = this.endpoint('herdr/ws');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
        return url;
      },
      stalled: seconds => { this.status.textContent = `Connection stalled · last contact ${seconds}s ago`; },
      open: () => { this.quietSnapshot = true; this.updatePresence(); },
      message: event => {
        try { this.receive(typeof event.data === 'string' ? JSON.parse(event.data) : event.data); }
        catch { this.ws?.close(4002, 'Invalid transport message'); }
      },
      close: () => {
        if (this.disposed) return false;
        this.connected = false; this.status.textContent = 'Herdr disconnected. Reconnecting…'; this.render();
        this.setLoading(false); this.host.ready?.(); return true;
      },
      error: error => { this.connectionError(error); return true; },
    });
    this.element.addEventListener('pointerdown', () => this.transport.activity(), { passive: true });
    this.render(); void this.connect();
    if (this.cached) queueMicrotask(() => { if (!this.disposed) this.host.ready?.(); });
  }
  setVisible(visible: boolean) {
    const changed = this.visible !== visible;
    this.visible = visible; this.element.hidden = !visible;
    if (!changed) { this.mountTerminal(); return; }
    this.rendered = false;
    if (!visible) {
      this.clearDrop();
      if (this.displayed && ![...this.terminalFrames.values()].some(entry => entry.frame === this.displayed)) { this.displayed.remove(); this.displayed = undefined; }
      this.closeMenu(); this.setLoading(false);
      for (const entry of [...this.terminalFrames.values()]) {
        if (entry.frame !== this.frame) this.park(entry.frame, entry.frame === this.displayed);
        else { entry.frame.inert = true; }
      }
    }
    const before = this.frame; this.mountTerminal();
    if (visible && before === this.frame && this.frame) {
      const entry = this.terminalFrames.get(this.frame.dataset.terminal!);
      if (entry) { if (entry.frame === this.displayed) entry.frame.style.visibility = ''; this.prepare(entry); }
    }
    for (const entry of this.terminalFrames.values()) entry.frame.contentWindow?.postMessage({ type:'tab-visibility', visible },location.origin);
    if (visible && !this.connected) void this.connect();
  }
  get ready() { return this.cached || this.rendered || !!this.status.textContent || this.connected && !this.selected; }
  get navigationElement() { return this.strip; }
  setTerminalTabsExpanded(expanded: boolean) {
    this.tabsToggle.setAttribute('aria-expanded', String(expanded));
    this.tabsToggle.setAttribute('aria-label', expanded ? 'Hide terminal tabs' : 'Show terminal tabs');
  }
  holdTerminalSize() {
    const generation = ++this.navigationResize, frame = this.displayed;
    if (frame && !frame.style.flexBasis) frame.style.flexBasis = frame.getBoundingClientRect().height + 'px';
    this.screen.classList.add('herdr-navigation-resizing');
    return () => {
      if (generation !== this.navigationResize) return;
      if (frame) frame.style.flexBasis = '';
      this.screen.classList.remove('herdr-navigation-resizing');
    };
  }
  setHeld(held: boolean) {
    if (this.handoffHeld === held) return;
    this.handoffHeld = held;
    if (held && this.displayed) this.park(this.displayed,true);
    else if (this.visible) this.mountTerminal(true);
  }
  private setLoading(loading: boolean) {
    this.loading.hidden = !loading; this.loading.classList.toggle('has-previous', !!this.displayed);
    this.screen.setAttribute('aria-busy', String(loading));
  }
  private prepare(entry: CachedTerminal) {
    entry.presentation = crypto.randomUUID(); entry.frame.className = 'herdr-terminal herdr-terminal-pending'; entry.frame.inert = true;
    if (entry.frame !== this.displayed) entry.frame.style.visibility = 'hidden';
    this.rendered = false; this.loadingLabel.textContent = 'Loading ' + (this.terminals.find(agent => agent.terminalId === entry.frame.dataset.terminal)?.name || 'terminal') + '…';
    this.setLoading(true);
    entry.frame.contentWindow?.postMessage({type:'herdr-present',presentation:entry.presentation},location.origin);
  }
  private park(frame: HTMLIFrameElement, keepVisible = false) {
    const id = frame.dataset.terminal!, entry = this.terminalFrames.get(id);
    if (!entry || entry.frame !== frame) { frame.remove(); return; }
    frame.inert = true;
    if (keepVisible || matchMedia('(pointer: coarse) and (max-width: 1024px)').matches && entry.retain) {
      frame.className = keepVisible ? 'herdr-terminal-previous' : 'herdr-terminal-cached'; frame.style.visibility = keepVisible ? '' : 'hidden';
      frame.contentWindow?.postMessage({type:'herdr-park',parked:true},location.origin);
    } else { frame.remove(); this.terminalFrames.delete(id); }
  }
  private post(message: object) { this.frame?.contentWindow?.postMessage(message, location.origin); }
  get terminalFrame() { return this.frame; }
  private mountTerminal(force = false) {
    if (!this.liveSnapshot) return;
    if (this.displayed && !this.terminals.some(agent => agent.terminalId === this.displayed!.dataset.terminal && agent.paneId === this.displayed!.dataset.pane)) { this.displayed.remove(); this.displayed = undefined; }
    for (const [id, entry] of this.terminalFrames) {
      if (!this.terminals.some(agent => agent.terminalId === id && agent.paneId === entry.pane)) { entry.frame.remove(); this.terminalFrames.delete(id); if (this.frame === entry.frame) this.frame = undefined; if (this.displayed === entry.frame) this.displayed = undefined; }
    }
    if (!this.selected) { this.displayed?.remove(); for (const entry of this.terminalFrames.values()) entry.frame.remove(); this.terminalFrames.clear(); this.frame = this.displayed = undefined; this.rendered = false; this.setLoading(false); return; }
    const agent = this.terminals.find(agent => agent.terminalId === this.selected);
    if (!agent || !force && this.frame?.dataset.terminal === this.selected && this.frame.dataset.pane === agent.paneId || !this.visible || this.disposed) return;
    if (this.frame) this.park(this.frame, this.frame === this.displayed);
    this.rendered = false;
    let cached = this.terminalFrames.get(this.selected);
    if (cached && cached.frame === this.displayed) {
      const bounds = cached.frame.getBoundingClientRect();
      if (cached.width !== bounds.width || cached.height !== bounds.height) {
        // Keep the displayed grid frozen while a separate iframe fits the new size.
        this.terminalFrames.delete(this.selected); cached = undefined;
      }
    }
    if (cached) {
      this.terminalFrames.delete(this.selected); this.terminalFrames.set(this.selected,cached);
      this.frame = cached.frame;
      const bounds = cached.frame.getBoundingClientRect(), preserve = cached.rendered && cached.width === bounds.width && cached.height === bounds.height;
      this.prepare(cached);
      if (cached.locked) { cached.locked = false; void this.host.authenticate().then(() => cached.frame.contentWindow?.postMessage({type:'authorize',accessToken:this.host.token()},location.origin)).catch(error => this.host.notice(error.message)); }
      cached.frame.contentWindow?.postMessage({type:'herdr-park',parked:false,preserve},location.origin);
      cached.frame.contentWindow?.postMessage({type:'tab-visibility',visible:this.visible},location.origin);
    } else {
      const session = crypto.randomUUID();
      const frame = node('iframe','herdr-terminal'); frame.title = 'Herdr agent terminal'; frame.dataset.terminal = this.selected; frame.dataset.pane = agent.paneId; frame.style.visibility = 'hidden';
      frame.allow = 'microphone; screen-wake-lock; clipboard-read; clipboard-write';
      const url = new URL('terminal.html',document.baseURI);
      url.search = new URLSearchParams({embedded:'1',backend:this.host.url,session,herdrTerminal:this.selected,herdrSession:this.host.session,...(this.host.source?{herdrSource:this.host.source}:{})}).toString();
      frame.src = url.href; this.frame = frame;
      const entry = {frame,session,pane:agent.paneId,retain:false,rendered:false}; this.terminalFrames.set(this.selected,entry); this.screen.append(frame); this.prepare(entry);
    }
    while (this.terminalFrames.size > 4) { const candidate = [...this.terminalFrames].find(([,entry]) => entry.frame !== this.frame && entry.frame !== this.displayed); if (!candidate) break; const [id, entry] = candidate; entry.frame.remove(); this.terminalFrames.delete(id); }
  }
  private endpoint(name: string) { const url = new URL(name, this.host.url); if (this.host.session) url.searchParams.set('herdrSession', this.host.session); if (this.host.source) url.searchParams.set('herdrSource', this.host.source); return url; }
  private connect() { return this.transport.connect(); }
  private connectionError(error: unknown) {
    if (this.disposed) return;
    const failure = error as { status?: number; message?: string; name?: string };
    this.status.textContent = failure.name === 'TimeoutError' ? 'Herdr connection timed out. Retrying…' : failure.message || 'Herdr connection failed.'; this.setLoading(false); this.host.ready?.();
    if (failure.status !== 404 || !this.host.source || !this.host.reconnect || !this.visible || this.recovering) return;
    this.status.textContent = 'Reconnecting to Herdr…';
    let cancelled = false;
    this.recovering = this.host.reconnect().catch((reason: { message?: string; cancelled?: boolean }) => {
      if (!this.disposed) this.status.textContent = reason.message || 'Herdr connection failed.';
      cancelled = reason.cancelled === true;
    }).finally(() => {
      this.recovering = undefined;
      if (!this.disposed && !cancelled) this.recoveryRetry = setTimeout(() => void this.connect(), 3000);
    });
  }
  private receive(message: HerdrMessage) {
    if (message.type === 'error') { this.status.textContent = message.message; this.setLoading(false); this.host.ready?.(); return; }
    if (message.type !== 'snapshot') return;
    this.transport.ready(); this.connected = this.ws?.readyState === WebSocket.OPEN;
    this.liveSnapshot = true; this.cached = false; this.preferences.snapshot = herdrCache(message.snapshot);
    const previousSpace = this.terminals.find(terminal => terminal.terminalId === this.selected)?.workspaceId;
    this.status.textContent = '';
    this.terminals = message.snapshot.terminals || message.snapshot.agents; this.spaces = message.snapshot.spaces || []; this.repos = spaceRepos(this.spaces);
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
    requestAnimationFrame(() => { if (this.visible && this.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } });
  }
  private get spaceMode() { try { return JSON.parse(localStorage.getItem('libertty.herdrStrip') || 'null') !== 'agents'; } catch { return true; } }
  // Status lanes are the default order; only an explicit Manual choice keeps the saved order.
  private get laneMode() { try { return JSON.parse(localStorage.getItem('libertty.herdrStripOrder') || 'null') !== 'manual'; } catch { return true; } }
  private get tapMode(): RepoTap { try { const mode = JSON.parse(localStorage.getItem('libertty.herdrSpaceTap') || 'null'); return mode === 'root' || mode === 'tree' || mode === 'triage' ? mode : 'recent'; } catch { return 'recent'; } }
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
    if (!item.space) return this.tracker.status(item);
    const terminals = (item.repo?.spaces || [item.space]).flatMap(space => space.terminalIds);
    const statuses = this.tracker.agents.filter(agent => terminals.includes(agent.terminalId)).map(agent => this.tracker.status(agent));
    return (['blocked', 'done', 'working'] as const).find(status => statuses.includes(status)) || 'idle';
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
    const entries = this.entries();
    return this.order.map(id => entries.find(item => item.terminalId === id)).filter((item): item is StripItem => !!item);
  }
  private save() {
    this.preferences.selected = this.selected;
    // Each repository chip reopens the checkout last used in it.
    const workspace = this.terminals.find(terminal => terminal.terminalId === this.selected)?.workspaceId, repo = this.repoOf(workspace);
    if (repo) this.preferences.repoSpaces![repo.id] = workspace!;
    this.preferences.state = this.tracker.checkpoint();
    try { localStorage.setItem(this.host.key, JSON.stringify(this.preferences)); } catch { /* This view still works without persistence. */ }
  }
  private render() {
    this.strip.inert = !this.liveSnapshot;
    this.strip.setAttribute('aria-busy', String(!this.liveSnapshot));
    this.host.changed(this.tracker.attention);
    this.strip.setAttribute('aria-label', this.spaceMode ? 'Herdr spaces' : 'Herdr agents');
    this.empty.hidden = !!this.selected;
    this.empty.textContent = this.spaceMode ? 'Create a space with + in the strip below.' : 'No agents are running. Use + to create a space.';
    if (this.held) {
      for (const tab of this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')) {
        const agent = this.entries().find(agent => agent.terminalId === tab.dataset.terminal);
        if (agent) tab.dataset.status = this.statusFor(agent);
      }
      return;
    }
    const scroll = this.strip.scrollLeft; this.strip.replaceChildren(this.tabsToggle);
    const lanes = this.laneMode ? statusLanes(this.ordered(), item => this.laneFor(item)) : undefined;
    if (!lanes) this.pinnedLane = undefined;
    const agents = lanes ? lanes.flatMap(lane => lane.items) : this.ordered();
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
        select: () => this.select(agent.terminalId), hold: () => agent.repo ? this.openTree(tab, agent.repo) : this.openMenu(tab, agent), scroll: this.strip,
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
    const add = node('button', 'herdr-agent-add', '+'); add.type = 'button'; add.setAttribute('aria-label', 'Create space'); add.disabled = this.creatingSpace; add.onclick = () => void this.createSpace(); this.strip.append(add); this.strip.scrollLeft = scroll;
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
      this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
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
      const snapshot = await this.host.api<import('./herdr-protocol.ts').HerdrSnapshot>('api/herdr/snapshot');
      try { localStorage.setItem('libertty.herdrStrip', JSON.stringify('spaces')); } catch { /* Default to spaces when preferences are unavailable. */ }
      this.selected = result.terminalId || snapshot.spaces?.find(space => space.id === result.workspaceId)?.selectedTerminalId || '';
      this.receive({ type: 'snapshot', snapshot });
      this.strip.querySelector<HTMLElement>('[data-terminal="' + CSS.escape(this.repoOf(result.workspaceId)?.id || 'space:' + result.workspaceId) + '"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
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
    this.menu.replaceChildren();
    this.menu.setAttribute('aria-label', agent.name + ' tab actions');
    const rename = node('button', '', 'Rename'); rename.role = 'menuitem'; rename.onclick = () => void this.rename(agent);
    const close = node('button', '', 'Close tab'); close.role = 'menuitem'; close.disabled = this.closing.has(agent.terminalId); close.onclick = () => void this.closeTab(agent);
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
    if (this.actionDialog) return;
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
    this.menu.style.width = width + 'px';
    this.menu.style.left = Math.max(8, Math.min(rect.left - parent.left, parent.width - width - 8)) + 'px';
    this.menu.style.top = Math.max(8, rect.top - parent.top - this.menu.offsetHeight - 6) + 'px';
    // Without overflow the whole tree can be swiped away; otherwise only its grab bar can.
    this.menu.style.touchAction = this.menu.scrollHeight > this.menu.clientHeight ? '' : 'none';
    // The bridge joins the tree to its chip so it reads as that chip's own panel.
    const menu = this.menu.getBoundingClientRect();
    Object.assign(this.treeBridge.style, { left: rect.left + 'px', width: rect.width + 'px', top: menu.bottom - 1 + 'px', height: Math.max(0, rect.top - menu.bottom + 3) + 'px' });
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
      button.disabled = !root; if (!root) button.title = 'Open the repository’s main checkout as a space to add worktrees.';
      button.onclick = () => { if (root) void this.spaceAction(this.spaceItem(root), action); };
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
    close.setAttribute('aria-label', 'Close ' + space.name); close.disabled = this.closing.has(item.terminalId); close.onclick = () => this.confirmCloseSpace(item);
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
      remove.setAttribute('aria-label', 'Close ' + terminal.name); remove.disabled = this.closing.has(id); remove.onclick = () => void this.closeTab(terminal);
      pill.append(focus, remove); panes.append(pill);
    }
    const split = node('button', 'herdr-pane-add', '+ split'); split.type = 'button'; split.setAttribute('aria-label', 'Split a pane in ' + space.name); split.onclick = () => void this.spaceAction(item, 'split');
    panes.append(split); box.append(head, panes);
    return box;
  }
  /** Holding a space or pane name edits it in place; the shared label also changes on the desktop. */
  private renameInline(target: HTMLElement, item: StripItem) {
    if (this.renaming || !this.tree) return;
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
        this.renaming = true; save.disabled = input.disabled = false; this.host.notice(error.message); input.focus();
      }
    };
    form.append(input, save); target.replaceWith(form); input.focus(); input.select();
  }
  private confirmCloseSpace(item: StripItem) {
    const space = item.space;
    if (!space || this.actionDialog || this.closing.has(item.terminalId)) return;
    this.closeMenu();
    const modal = this.actionDialog = node('dialog', 'herdr-space-action herdr-close-space'), form = node('form');
    const title = node('h2', '', 'Close ' + space.name + '?'); title.id = 'close-space-' + crypto.randomUUID(); modal.setAttribute('aria-labelledby', title.id);
    const count = space.terminalIds.length;
    const explanation = node('p', '', 'This ends ' + (count === 1 ? 'its terminal' : 'its ' + count + ' terminals') + ' on the Herdr server.');
    const checkout = node('p', 'hint', 'The checkout stays on disk. Delete it to remove the folder too; the branch is kept.');
    const linked = !!space.linkedWorktree && !!space.checkoutPath; checkout.hidden = !linked;
    const actions = node('div', 'actions'), cancel = node('button', 'secondary', 'Cancel'), close = node('button', 'danger', 'Close space'), remove = node('button', 'danger', 'Delete checkout…');
    cancel.type = 'button'; close.type = 'submit'; remove.type = 'button'; remove.hidden = !linked;
    cancel.onclick = () => modal.close();
    modal.onclose = () => { if (this.actionDialog === modal) this.actionDialog = undefined; modal.remove(); };
    // Dialogs report closing asynchronously, so release this one before the deletion dialog opens.
    remove.onclick = () => { this.actionDialog = undefined; modal.close(); this.deleteWorktree(item); };
    form.onsubmit = event => { event.preventDefault(); modal.close(); void this.closeTab(item); };
    actions.append(cancel, close, remove); form.append(title, explanation, checkout, actions); modal.append(form); document.body.append(modal); modal.showModal(); cancel.focus();
  }
  private deleteWorktree(item: StripItem) {
    const space = item.space;
    if (!space?.linkedWorktree || !space.checkoutPath || this.actionDialog || this.closing.has(item.terminalId)) return;
    this.closeMenu();
    const modal = this.actionDialog = node('dialog', 'herdr-space-action herdr-delete-worktree'), form = node('form');
    const title = node('h2', '', 'Delete worktree checkout?'); title.id = 'delete-worktree-title'; modal.setAttribute('aria-labelledby', title.id);
    const explanation = node('p', '', 'This removes the checkout folder:');
    const path = node('p', 'herdr-checkout-path', space.checkoutPath);
    const hint = node('p', '', 'The branch is not deleted. The Herdr workspace will close.');
    const forceHint = node('p', '', 'Force delete permanently discards modified and untracked files in this checkout.'); forceHint.hidden = true;
    const progress = node('p'), error = node('p', 'form-error'), actions = node('div', 'actions'); progress.role = 'status'; error.role = 'alert';
    const cancel = node('button', 'secondary', 'Cancel'), remove = node('button', 'danger', 'Delete worktree checkout'); cancel.type = 'button'; remove.type = 'submit';
    const forceRemove = node('button', 'danger', 'Force delete'); forceRemove.type = 'submit'; forceRemove.hidden = true;
    let busy = false;
    cancel.onclick = () => modal.close(); modal.oncancel = event => { if (busy) event.preventDefault(); };
    modal.onclose = () => { if (this.actionDialog === modal) this.actionDialog = undefined; modal.remove(); };
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      const force = event.submitter === forceRemove;
      if (force && forceRemove.hidden) return;
      busy = true; this.closing.add(item.terminalId); remove.disabled = forceRemove.disabled = cancel.disabled = true; error.textContent = ''; progress.textContent = 'Deleting worktree checkout…';
      try {
        await this.host.api('api/herdr/action', { action: 'delete-worktree', workspaceId: space.id, path: space.checkoutPath, force });
        if (!this.disposed) this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
        modal.close();
      } catch (reason: any) {
        if (modal.open) { error.textContent = reason.message; forceRemove.hidden = forceHint.hidden = !/--force\b/.test(reason.message); }
      }
      finally { busy = false; this.closing.delete(item.terminalId); remove.disabled = forceRemove.disabled = cancel.disabled = false; progress.textContent = ''; }
    };
    actions.append(cancel, remove, forceRemove); form.append(title, explanation, path, hint, forceHint, progress, error, actions); modal.append(form); document.body.append(modal); modal.showModal(); cancel.focus();
  }
  private async spaceAction(item: StripItem, action: 'new-worktree' | 'open-worktree' | 'split') {
    if (!item.space || this.actionDialog) return;
    const space = item.space, terminalId = this.terminalFor(item);
    this.closeMenu();
    const modal = this.actionDialog = node('dialog', 'herdr-space-action'), form = node('form');
    const title = node('h2', '', action === 'split' ? 'Split terminal' : action === 'new-worktree' ? 'New worktree' : 'Open worktree');
    const context = node('p', '', space.name), fields = node('div'), progress = node('p'), error = node('p', 'form-error'), actions = node('div', 'actions');
    progress.role = 'status'; error.role = 'alert';
    const cancel = node('button', 'secondary', 'Cancel'), submit = node('button', 'primary', action === 'split' ? 'Split' : action === 'new-worktree' ? 'Create' : 'Open');
    cancel.type = 'button'; submit.type = 'submit'; submit.disabled = true;
    let busy = false;
    cancel.onclick = () => modal.close(); modal.oncancel = event => { if (busy) event.preventDefault(); };
    modal.onclose = () => { if (this.actionDialog === modal) this.actionDialog = undefined; modal.remove(); };
    actions.append(cancel, submit); form.append(title, context, fields, progress, error, actions); modal.append(form); document.body.append(modal); modal.showModal();
    const field = (label: string, input: HTMLElement) => { const wrapper = node('label', '', label); wrapper.append(input); fields.append(wrapper); };
    const input = node('input'), picker = node('select');
    let updateBranches: (() => void) | undefined;
    try {
      if (action === 'split') {
        progress.textContent = 'Checking split support…';
        const options = await this.host.api<{ actions?: string[] }>('api/herdr/options');
        if (!modal.open || this.disposed) return;
        progress.textContent = '';
        if (!options.actions?.includes('split')) throw new Error('This Libertty backend is older than the interface. ' +
          'Restart it with the current build to enable Split.');
        field('Split direction', picker); picker.setAttribute('aria-label', 'Split direction');
        for (const [value, label] of [['right', 'Right (side by side)'], ['down', 'Down (above and below)']]) { const option = node('option', '', label); option.value = value; picker.append(option); }
        context.textContent = space.name + ' · ' + (this.terminals.find(t => t.terminalId === terminalId)?.name || 'No running terminal');
        submit.disabled = !terminalId;
      } else {
        progress.textContent = 'Loading worktrees…';
        const listing = await this.host.api<HerdrWorktrees>('api/herdr/action', { action: 'list-worktrees', workspaceId: space.id });
        if (!modal.open || this.disposed) return;
        progress.textContent = ''; context.textContent = space.name + ' · ' + listing.source.repo_root;
        if (action === 'new-worktree') {
          input.required = true; input.maxLength = 100; input.placeholder = 'New or existing branch'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', 'Branch'); field('Branch', input);
          const suggestions = node('div', 'herdr-branch-suggestions'); suggestions.id = 'herdr-branches-' + crypto.randomUUID(); suggestions.role = 'listbox'; suggestions.setAttribute('aria-label', 'Existing branches');
          input.role = 'combobox'; input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', suggestions.id);
          fields.append(suggestions);
          const preview = node('p', 'hint'); fields.append(preview);
          const branches = [...new Set(listing.branches || [])], checkedOut = new Set(listing.worktrees.flatMap(entry => entry.branch ? [entry.branch] : []));
          let expanded = true, activeBranch = '';
          const choose = (branch: string) => { if (busy) return; input.value = branch; input.focus(); expanded = false; activeBranch = ''; update(); };
          const update = () => {
            const value = input.value.trim(), query = value.toLowerCase();
            const matches = branches.filter(branch => branch.toLowerCase().includes(query)).sort((a, b) => Number(b.toLowerCase().startsWith(query)) - Number(a.toLowerCase().startsWith(query)) || a.localeCompare(b)).slice(0, 20);
            suggestions.replaceChildren(); input.removeAttribute('aria-activedescendant');
            for (const branch of matches) {
              const option = node('button', 'herdr-branch-option', branch); option.type = 'button'; option.role = 'option'; option.tabIndex = -1; option.id = suggestions.id + '-' + suggestions.childElementCount;
              option.disabled = busy || checkedOut.has(branch); option.setAttribute('aria-selected', String(branch === activeBranch));
              if (checkedOut.has(branch)) option.append(node('span', 'herdr-branch-status', 'Already checked out'));
              if (branch === activeBranch) input.setAttribute('aria-activedescendant', option.id);
              option.onpointerdown = event => event.preventDefault(); option.onclick = () => choose(branch); suggestions.append(option);
            }
            suggestions.hidden = !expanded || !matches.length; input.setAttribute('aria-expanded', String(!suggestions.hidden));
            submit.disabled = busy || !value || checkedOut.has(value);
            preview.textContent = checkedOut.has(value) ? 'This branch is already checked out. Use Open worktree to open its checkout.' : !value ? 'Choose an existing branch or enter a new branch name.' : listing.directory ? 'Checkout: ' + worktreePath(listing.directory, listing.source.repo_name, value) : branches.includes(value) ? 'Herdr will create the checkout using this existing branch.' : 'Herdr will create the checkout in its configured worktree directory from HEAD.';
          };
          input.oninput = () => { expanded = true; activeBranch = ''; update(); };
          input.onfocus = () => { expanded = true; update(); };
          input.onkeydown = event => {
            if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); expanded = false; update(); return; }
            if (event.key === 'Enter' && expanded && activeBranch) { event.preventDefault(); choose(activeBranch); return; }
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault(); expanded = true; update();
            const available = matchesAvailable();
            if (!available.length) return;
            const current = available.findIndex(option => option.textContent === activeBranch);
            activeBranch = available[(current + (event.key === 'ArrowDown' ? 1 : current < 0 ? 0 : -1) + available.length) % available.length].textContent!;
            update(); document.getElementById(input.getAttribute('aria-activedescendant')!)?.scrollIntoView({ block: 'nearest' });
          };
          const matchesAvailable = () => [...suggestions.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          updateBranches = update;
          update(); input.focus();
        } else {
          picker.required = true; picker.setAttribute('aria-label', 'Worktree'); field('Worktree', picker);
          for (const entry of listing.worktrees.filter(entry => !entry.is_bare && !entry.is_prunable)) {
            const option = node('option', '', (entry.branch || entry.label) + ' · ' + entry.path + (entry.open_workspace_id ? ' (already open)' : '')); option.value = entry.path; picker.append(option);
          }
          submit.disabled = !picker.options.length;
          if (submit.disabled) error.textContent = 'No Git worktrees found for this repo.';
        }
      }
    } catch (reason: any) { if (modal.open) { progress.textContent = ''; error.textContent = reason.message; } }
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || submit.disabled) return;
      busy = true; submit.disabled = cancel.disabled = true; input.disabled = picker.disabled = true; error.textContent = ''; progress.textContent = action === 'split' ? 'Splitting…' : action === 'new-worktree' ? 'Creating worktree…' : 'Opening worktree…';
      updateBranches?.();
      try {
        const result = await this.host.api<{ workspaceId: string; terminalId?: string }>('api/herdr/action', { action, workspaceId: space.id, ...(action === 'split' ? { terminalId, direction: picker.value } : action === 'new-worktree' ? { branch: herdrName(input.value) } : { path: picker.value }) });
        const snapshot = await this.host.api<import('./herdr-protocol.ts').HerdrSnapshot>('api/herdr/snapshot');
        if (this.disposed) return;
        if (action !== 'split') this.selected = result.terminalId || snapshot.spaces?.find(space => space.id === result.workspaceId)?.selectedTerminalId || this.selected;
        this.receive({ type: 'snapshot', snapshot }); modal.close();
      } catch (reason: any) { if (modal.open) error.textContent = reason.message; }
      finally { busy = false; submit.disabled = cancel.disabled = input.disabled = picker.disabled = false; progress.textContent = ''; updateBranches?.(); }
    };
  }
  private async closeTab(item: StripItem) {
    if (this.closing.has(item.terminalId)) return;
    this.closing.add(item.terminalId); if (!this.tree) this.closeMenu();
    try {
      await this.host.api('api/herdr/action', item.space
        ? { action: 'close-space', workspaceId: item.space.id }
        : { action: 'close', terminalId: item.terminalId });
      await this.refreshSnapshot();
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
    finally { this.closing.delete(item.terminalId); }
  }
  private async refreshSnapshot() {
    const snapshot = await this.host.api<import('./herdr-protocol.ts').HerdrSnapshot>('api/herdr/snapshot');
    if (!this.disposed) this.receive({ type: 'snapshot', snapshot });
  }

  private async rename(agent: StripItem) {
    this.closeMenu();
    const modal = node('dialog', 'herdr-rename'), form = node('form'), title = node('h2', '', agent.space ? 'Rename space' : 'Rename agent tab'), input = node('input'), error = node('p', 'form-error'), actions = node('div', 'actions');
    input.value = agent.name; input.maxLength = 100; input.required = true; input.setAttribute('aria-label', agent.space ? 'Space name' : 'Agent tab name');
    const hint = node('p', 'hint', 'This changes the name in the desktop Herdr session too.');
    const cancel = node('button', 'secondary', 'Cancel'), save = node('button', 'primary', 'Save'); cancel.type = 'button'; save.type = 'submit'; cancel.onclick = () => modal.close();
    actions.append(cancel, save); form.append(title, input, hint, error, actions); modal.append(form); document.body.append(modal);
    modal.onclose = () => modal.remove();
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try { await this.host.api('api/herdr/action', { action: agent.space ? 'rename-space' : 'rename', terminalId: agent.terminalId, workspaceId: agent.space?.id, name: herdrName(input.value) }); this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') }); modal.close(); }
      catch (reason: any) { error.textContent = reason.message; } finally { save.disabled = false; }
    };
    modal.showModal(); input.focus(); input.select();
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
      this.ws.send(JSON.stringify({ type: 'notification-presence', device, focused: !document.hidden && document.hasFocus() }));
      if (device !== this.presenceDevice) { this.presenceDevice = device; this.acknowledge(this.currentNotifications()); }
    }
  }
  openTerminal(id: string) { if (this.terminals.some(agent => agent.terminalId === id)) this.selectTerminal(id); else this.requestedTerminal = id; }
  copySelection() { this.post({ type: 'settings-action', action: 'copy-selection' }); }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.actionDialog?.close();
    this.dropIndicator.remove(); this.treeBridge.remove();
    clearTimeout(this.backgroundTimer); clearTimeout(this.recoveryRetry); this.transport.suspend(); clearInterval(this.presenceTimer); this.displayed?.remove(); for (const entry of this.terminalFrames.values()) entry.frame.remove(); this.terminalFrames.clear(); this.strip.remove(); this.element.remove();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }
}
