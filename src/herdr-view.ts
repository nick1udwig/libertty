import { wireProtocols, decodeWire } from './wire.ts';
import { herdrName, type HerdrAgent, type HerdrMessage, type HerdrSpace, type HerdrWorktrees } from './herdr-protocol.ts';
import { HerdrState, type HerdrNotification } from './herdr-state.ts';
import { tabGestures } from './tab-gestures.ts';
import { dropSpace, spaceLayout, spaceTerminal, worktreePath, type SpaceDrop } from './herdr-spaces.ts';
import './herdr.css';

interface Host {
  url: string; session: string; source?: string; key: string;
  token(): string | undefined; authenticate(): Promise<void>;
  api<T>(path: string, data?: unknown): Promise<T>;
  changed(attention: number): void; notification(event: HerdrNotification): void;
  notice(message: string): void;
  reconnect?(): Promise<void>;
  ready?(): void;
  notificationDevice?(): string | undefined;
}
interface CachedTerminal { frame:HTMLIFrameElement; session:string; pane:string; retain:boolean; rendered:boolean; presentation?:string; geometry?:string; locked?:boolean; width?:number; height?:number }
type StripItem = HerdrAgent & { space?: HerdrSpace };
interface Preferences { order: string[]; spaceOrder?: string[]; spaceGroups?: string[][]; collapsedGroups?: string[]; spaceTerminals?: Record<string, string>; selected?: string; state?: ReturnType<HerdrState['checkpoint']> }
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
export class HerdrView {
  readonly element = node('section', 'herdr-view');
  private strip = node('div', 'herdr-agent-strip');
  private screen = node('div', 'herdr-screen');
  private frame?: HTMLIFrameElement;
  private displayed?: HTMLIFrameElement;
  private terminalFrames = new Map<string, CachedTerminal>();
  private status = node('div', 'herdr-connection');
  private empty = node('div', 'herdr-empty');
  private loading = node('div', 'herdr-loading');
  private loadingLabel = node('span');
  private menu = node('div', 'herdr-tab-menu');
  private tracker = new HerdrState();
  private preferences: Preferences;
  private ws?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private disposed = false;
  private visible = false;
  private connected = false;
  private quietSnapshot = true;
  private selected = '';
  private requestedTerminal = '';
  private presenceTimer?: ReturnType<typeof setInterval>;
  private presenceDevice = '';
  private terminals: HerdrAgent[] = [];
  private spaces: HerdrSpace[] = [];
  private rendered = false;
  private handoffHeld = false;
  private held = false;
  private dragOrderChanged = false;
  private dropTarget?: { id: string; drop: SpaceDrop };
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
    this.preferences.spaceGroups = Array.isArray(this.preferences.spaceGroups) ? this.preferences.spaceGroups : [];
    this.preferences.collapsedGroups = Array.isArray(this.preferences.collapsedGroups) ? this.preferences.collapsedGroups : [];
    delete (this.preferences as any).hidden; delete (this.preferences as any).hiddenSpaces;
    this.tracker = new HerdrState(this.preferences.state);
    this.selected = this.preferences.selected || '';
    this.element.setAttribute('aria-label', 'Herdr connection');
    this.element.role = 'tabpanel'; this.screen.id = 'herdr-terminal-' + crypto.randomUUID(); this.screen.role = 'tabpanel'; this.screen.setAttribute('aria-label', 'Agent terminal');
    this.strip.role = 'tablist'; this.strip.setAttribute('aria-label', 'Herdr agents');
    this.menu.role = 'menu'; this.menu.hidden = true;
    this.status.setAttribute('role', 'status');
    this.loading.role = 'status'; this.loading.hidden = true;
    const spinner = node('span', 'terminal-loading-spinner'); spinner.setAttribute('aria-hidden', 'true');
    this.loading.append(spinner, this.loadingLabel);
    this.screen.append(this.status, this.empty, this.loading);
    this.element.append(this.screen, this.strip, this.menu);
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
      if (event.data.type === 'terminal-locked') entry.locked = true;
      if (active && event.data.type === 'terminal-locked') void this.host.authenticate().then(() => entry.frame.contentWindow?.postMessage({ type:'authorize', accessToken:this.host.token() },location.origin)).catch(error => this.host.notice(error.message));
    };
    document.addEventListener('visibilitychange', viewed); window.addEventListener('focus', viewed); window.addEventListener('message', messages);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', viewed), () => window.removeEventListener('focus', viewed), () => window.removeEventListener('message', messages));
    const presence = () => this.updatePresence();
    document.addEventListener('visibilitychange', presence); window.addEventListener('focus', presence); window.addEventListener('blur', presence);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', presence), () => window.removeEventListener('focus', presence), () => window.removeEventListener('blur', presence));
    const resume = () => {
      if (this.disposed || document.hidden || !navigator.onLine) return;
      clearTimeout(this.reconnect);
      const ws = this.ws; this.ws = undefined; this.connected = false; ws?.close();
      void this.connect();
    };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('pageshow', resume);
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', resume), () => window.removeEventListener('online', resume), () => window.removeEventListener('pageshow', resume));
    this.presenceTimer = setInterval(presence, 15000);
    const outside = (event: PointerEvent) => { if (!this.menu.contains(event.target as Node) && !(event.target as HTMLElement).closest('.herdr-agent-tab')) this.menu.hidden = true; };
    document.addEventListener('pointerdown', outside); this.unsubscribers.push(() => document.removeEventListener('pointerdown', outside));
    this.menu.onkeydown = event => {
      if (event.key === 'Escape') { this.menu.hidden = true; this.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...this.menu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    };
    this.render(); void this.connect();
  }
  setVisible(visible: boolean) {
    const changed = this.visible !== visible;
    this.visible = visible; this.element.hidden = !visible;
    if (!changed) { this.mountTerminal(); return; }
    this.rendered = false;
    if (!visible) {
      if (this.displayed && ![...this.terminalFrames.values()].some(entry => entry.frame === this.displayed)) { this.displayed.remove(); this.displayed = undefined; }
      this.menu.hidden = true; this.setLoading(false);
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
  get ready() { return this.rendered || !!this.status.textContent || this.connected && !this.selected; }
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
  private async connect() {
    if (this.disposed || this.connecting || this.ws?.readyState === WebSocket.OPEN || document.hidden || !navigator.onLine) return;
    clearTimeout(this.reconnect); this.connecting = true;
    try {
      const { ticket, wire } = await this.host.api<{ ticket: string; wire?: string[] }>('api/herdr/ticket', {});
      if (this.disposed || document.hidden || !navigator.onLine) return;
      const url = this.endpoint('herdr/ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
      const ws = new WebSocket(url, wireProtocols(wire)); ws.binaryType = 'arraybuffer'; this.ws = ws; let decoded = Promise.resolve();
      ws.onopen = () => { if (this.ws !== ws) return; this.connected = true; this.quietSnapshot = true; this.status.textContent = ''; this.updatePresence(); this.render(); };
      ws.onmessage = event => { decoded = decoded.then(async () => { const value = await decodeWire(event.data); if (this.ws === ws) this.receive(value); }).catch(() => { if (this.ws === ws) ws.close(4002, 'Invalid transport message'); }); };
      ws.onclose = () => {
        if (this.ws !== ws || this.disposed) return;
        this.connected = false; this.status.textContent = 'Herdr disconnected. Reconnecting…'; this.render();
        this.setLoading(false); this.host.ready?.();
        this.reconnect = setTimeout(() => void this.connect(), 2000);
      };
    } catch (error: any) { if (!this.disposed) {
      this.status.textContent = error.message; this.setLoading(false); this.host.ready?.();
      if (error.status === 404 && this.host.source && this.host.reconnect) {
        if (!this.visible) return;
        this.status.textContent = 'Reconnecting to Herdr…';
        try { await this.host.reconnect(); }
        catch (reason: any) { if (!this.disposed) { this.status.textContent = reason.message; if (!reason.cancelled) this.reconnect = setTimeout(() => void this.connect(), 3000); } }
      } else this.reconnect = setTimeout(() => void this.connect(), 3000);
    } }
    finally { this.connecting = false; }
  }
  private receive(message: HerdrMessage) {
    if (message.type === 'error') { this.status.textContent = message.message; this.setLoading(false); this.host.ready?.(); return; }
    if (message.type !== 'snapshot') return;
    this.status.textContent = '';
    this.terminals = message.snapshot.terminals || message.snapshot.agents; this.spaces = message.snapshot.spaces || [];
    const notifications = this.tracker.update(message.snapshot);
    this.acknowledge(this.quietSnapshot ? this.currentNotifications() : notifications);
    if (!this.quietSnapshot) for (const event of notifications) this.host.notification(event);
    this.quietSnapshot = false;
    const live = this.tracker.agents.map(agent => agent.terminalId);
    this.preferences.order = [...this.preferences.order.filter(id => live.includes(id)), ...live.filter(id => !this.preferences.order.includes(id))];
    const spaces = this.spaces.map(space => 'space:' + space.id);
    const layout = spaceLayout(spaces, this.preferences.spaceGroups!, spaces);
    this.preferences.spaceOrder = layout.order; this.preferences.spaceGroups = layout.groups;
    this.preferences.collapsedGroups = this.preferences.collapsedGroups!.filter(id => layout.groups.some(group => group[0] === id));
    this.ensureSelection();
    if (this.requestedTerminal && this.terminals.some(agent => agent.terminalId === this.requestedTerminal)) { this.selected = this.requestedTerminal; this.requestedTerminal = ''; }
    this.save(); this.render(); this.mountTerminal();
    if (!this.selected) this.host.ready?.();
    requestAnimationFrame(() => { if (this.visible && this.rendered && !document.hidden && document.hasFocus() && this.tracker.viewed(this.selected)) { this.save(); this.render(); } });
  }
  private get spaceMode() { try { return JSON.parse(localStorage.getItem('termai.herdrStrip') || 'null') !== 'agents'; } catch { return true; } }
  private get order() { return this.spaceMode ? this.preferences.spaceOrder! : this.preferences.order; }
  private set order(value: string[]) { if (this.spaceMode) this.preferences.spaceOrder = value; else this.preferences.order = value; }
  private get stripSelection() {
    const terminal = this.terminals.find(t => t.terminalId === this.selected);
    return this.spaceMode && terminal ? 'space:' + terminal.workspaceId : this.selected;
  }
  private entries(): StripItem[] {
    if (!this.spaceMode) return this.tracker.agents;
    return this.spaces.map(space => ({ terminalId: 'space:' + space.id, paneId: '', workspace: space.name, name: space.name, kind: 'Space', status: 'idle', sequence: 0, cwd: '', space }));
  }
  private statusFor(item: StripItem) {
    if (!item.space) return this.tracker.status(item);
    const statuses = this.tracker.agents.filter(agent => item.space!.terminalIds.includes(agent.terminalId)).map(agent => this.tracker.status(agent));
    return (['blocked', 'done', 'working'] as const).find(status => statuses.includes(status)) || 'idle';
  }
  private terminalFor(item?: StripItem) {
    if (!item) return '';
    if (!item.space) return item.terminalId;
    return spaceTerminal(item.space, this.preferences.spaceTerminals![item.space.id]);
  }
  private ensureSelection() {
    if (!this.terminals.some(t => t.terminalId === this.selected) || !this.ordered().some(item => item.terminalId === this.stripSelection)) this.selected = this.terminalFor(this.ordered()[0]);
  }
  private select(id: string) {
    const item = this.entries().find(item => item.terminalId === id);
    if (item?.space && this.stripSelection === id) {
      const anchor = this.strip.querySelector<HTMLElement>('[data-terminal="' + CSS.escape(id) + '"]');
      if (anchor) this.openAgents(anchor, item.space.id); return;
    }
    this.selectTerminal(item ? this.terminalFor(item) : id);
  }
  private selectTerminal(id: string) {
    this.menu.hidden = true;
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
    this.preferences.state = this.tracker.checkpoint();
    try { localStorage.setItem(this.host.key, JSON.stringify(this.preferences)); } catch { /* This view still works without persistence. */ }
  }
  private render() {
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
    const scroll = this.strip.scrollLeft; this.strip.replaceChildren();
    const agents = this.ordered();
    const stacks = new Map<string, HTMLElement>();
    for (const agent of agents) {
      const tab = node('button', 'herdr-agent-tab'); tab.type = 'button'; tab.role = 'tab'; tab.dataset.terminal = agent.terminalId; tab.dataset.status = this.statusFor(agent);
      tab.setAttribute('aria-selected', String(agent.terminalId === this.stripSelection)); tab.tabIndex = agent.terminalId === this.stripSelection ? 0 : -1;
      tab.setAttribute('aria-controls', this.screen.id); tab.setAttribute('aria-haspopup', 'menu');
      tab.setAttribute('aria-label', agent.name + ' · ' + this.statusFor(agent) + ' · ' + agent.workspace);
      tab.title = agent.name + ' · ' + agent.kind + ' · ' + this.statusFor(agent) + ' · ' + agent.workspace;
      tab.append(node('span', 'herdr-status-dot'), node('span', 'herdr-agent-name', agent.name + (agent.space && agent.space.terminalIds.length > 1 ? ' ▾' : '')));
      const group = agent.space && this.preferences.spaceGroups!.find(group => group.includes(agent.terminalId));
      let parent: HTMLElement = this.strip;
      if (group) {
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
        select: () => this.select(agent.terminalId), hold: () => this.openMenu(tab, agent), scroll: this.strip,
        dragging: () => { this.menu.hidden = true; this.clearDrop(); },
        drag: x => {
          if (x < this.strip.getBoundingClientRect().left + 24) this.strip.scrollLeft -= 10;
          if (x > this.strip.getBoundingClientRect().right - 24) this.strip.scrollLeft += 10;
          if (agent.space) { this.previewDrop(tab, x); return; }
          const siblings = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')], index = siblings.indexOf(tab);
          const target = siblings.find((item, i) => { const rect = item.getBoundingClientRect(); return i !== index && x >= rect.left && x <= rect.right && (i < index ? x < rect.left + rect.width / 2 : x > rect.left + rect.width / 2); });
          if (!target) return;
          const targetIndex = siblings.indexOf(target); this.strip.insertBefore(tab, targetIndex > index ? target.nextSibling : target);
          const visible = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')].map(item => item.dataset.terminal!);
          this.order = [...visible, ...this.order.filter(id => !visible.includes(id))]; this.dragOrderChanged = true;
        },
        drop: x => { if (agent.space) { this.previewDrop(tab, x); const target = this.dropTarget; if (target) void this.moveSpace(agent.terminalId, target.id, target.drop); } },
        finish: () => { this.held = false; this.clearDrop(); if (this.dragOrderChanged) { this.save(); this.dragOrderChanged = false; } setTimeout(() => { if (!this.disposed) this.render(); }, 0); },
      });
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); const index = agents.indexOf(agent), next = agents[(index + (event.key === 'ArrowRight' ? 1 : agents.length - 1)) % agents.length];
        if (event.altKey) {
          if (agent.space) { void this.moveSpace(agent.terminalId, next.terminalId, event.key === 'ArrowRight' ? 'after' : 'before'); return; }
          const a = this.order.indexOf(agent.terminalId), b = this.order.indexOf(next.terminalId);
          const order = [...this.order]; [order[a], order[b]] = [order[b], order[a]]; this.order = order; this.save(); this.render();
          this.strip.querySelector<HTMLButtonElement>('[data-terminal="' + CSS.escape(agent.terminalId) + '"]')?.focus();
        } else { this.select(next.terminalId); this.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
      };
      parent.append(tab);
    }
    const add = node('button', 'herdr-agent-add', '+'); add.type = 'button'; add.setAttribute('aria-label', 'Create space'); add.disabled = this.creatingSpace; add.onclick = () => void this.createSpace(); this.strip.append(add); this.strip.scrollLeft = scroll;
  }
  private clearDrop() {
    this.dropTarget = undefined;
    for (const tab of this.strip.querySelectorAll<HTMLElement>('[data-drop]')) delete tab.dataset.drop;
  }
  private previewDrop(source: HTMLElement, x: number) {
    this.clearDrop();
    if (this.movingSpace) return;
    const target = [...this.strip.querySelectorAll<HTMLElement>('.herdr-agent-tab')].find(tab => { const rect = tab.getBoundingClientRect(); return tab !== source && !tab.hidden && x >= rect.left && x <= rect.right; });
    if (!target) return;
    const rect = target.getBoundingClientRect(), position = (x - rect.left) / rect.width;
    const drop: SpaceDrop = position < .25 ? 'before' : position > .75 ? 'after' : 'group';
    this.dropTarget = { id: target.dataset.terminal!, drop }; target.dataset.drop = drop;
  }
  private async moveSpace(source: string, target: string, drop: SpaceDrop) {
    if (this.movingSpace) return;
    const layout = dropSpace(spaceLayout(this.preferences.spaceOrder!, this.preferences.spaceGroups!), source, target, drop);
    if (!layout.order.includes(source) || !layout.order.includes(target) || source === target) return;
    const before = layout.order[layout.order.indexOf(source) + 1]; this.movingSpace = true;
    try {
      await this.host.api('api/herdr/action', { action: 'move-space', workspaceId: source.slice(6), ...(before ? { beforeWorkspaceId: before.slice(6) } : {}) });
      if (this.disposed) return;
      this.preferences.spaceGroups = layout.groups;
      if (drop === 'group') this.preferences.collapsedGroups = this.preferences.collapsedGroups!.filter(id => !layout.groups.find(group => group.includes(source))?.includes(id));
      this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
    finally { this.movingSpace = false; }
  }
  private async createSpace() {
    if (this.creatingSpace) return;
    this.creatingSpace = true; this.menu.hidden = true; this.render();
    const terminal = this.terminals.find(terminal => terminal.terminalId === this.selected);
    const space = this.spaces.find(space => space.id === terminal?.workspaceId) || this.spaces[0];
    try {
      const result = await this.host.api<{ workspaceId: string; terminalId?: string }>('api/herdr/action', { action: 'create-space', ...(space ? { workspaceId: space.id } : {}), ...(terminal ? { terminalId: terminal.terminalId } : {}) });
      if (this.disposed) return;
      const snapshot = await this.host.api<import('./herdr-protocol.ts').HerdrSnapshot>('api/herdr/snapshot');
      try { localStorage.setItem('termai.herdrStrip', JSON.stringify('spaces')); } catch { /* Default to spaces when preferences are unavailable. */ }
      this.selected = result.terminalId || snapshot.spaces?.find(space => space.id === result.workspaceId)?.selectedTerminalId || '';
      this.receive({ type: 'snapshot', snapshot });
      this.strip.querySelector<HTMLElement>('[data-terminal="' + CSS.escape('space:' + result.workspaceId) + '"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
    finally { this.creatingSpace = false; if (!this.disposed) this.render(); }
  }
  private popup(anchor: HTMLElement) {
    this.menu.hidden = false;
    const parent = this.element.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
    this.menu.style.left = Math.max(8, Math.min(rect.left - parent.left, parent.width - this.menu.offsetWidth - 8)) + 'px';
    this.menu.style.top = Math.max(8, rect.top - parent.top - this.menu.offsetHeight - 5) + 'px';
  }
  private openMenu(anchor: HTMLElement, agent: StripItem) {
    this.menu.replaceChildren();
    this.menu.setAttribute('aria-label', agent.name + ' tab actions');
    const rename = node('button', '', 'Rename'); rename.role = 'menuitem'; rename.onclick = () => void this.rename(agent);
    const close = node('button', '', agent.space ? 'Close' : 'Close tab'); close.role = 'menuitem'; close.disabled = this.closing.has(agent.terminalId); close.onclick = () => void this.closeTab(agent);
    this.menu.append(rename, close); this.popup(anchor); rename.focus({ preventScroll: true });
    if (agent.space) {
      for (const [label, action] of [['New worktree', 'new-worktree'], ['Open worktree', 'open-worktree'], ['Split', 'split']] as const) {
        const button = node('button', '', label); button.role = 'menuitem'; button.onclick = () => void this.spaceAction(agent, action); this.menu.insertBefore(button, close);
      }
      this.popup(anchor);
    }
  }
  private async spaceAction(item: StripItem, action: 'new-worktree' | 'open-worktree' | 'split') {
    if (!item.space || this.actionDialog) return;
    const space = item.space, terminalId = this.terminalFor(item);
    this.menu.hidden = true;
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
    try {
      if (action === 'split') {
        progress.textContent = 'Checking split support…';
        const options = await this.host.api<{ actions?: string[] }>('api/herdr/options');
        if (!modal.open || this.disposed) return;
        progress.textContent = '';
        if (!options.actions?.includes('split')) throw new Error('This Termai backend is older than the interface. Restart it with the current build to enable Split.');
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
          input.required = true; input.maxLength = 100; input.value = 'worktree-' + crypto.randomUUID().slice(0, 8); input.setAttribute('aria-label', 'Branch'); field('Branch', input);
          const preview = node('p', 'hint'); fields.append(preview);
          const update = () => { preview.textContent = listing.directory ? 'Checkout: ' + worktreePath(listing.directory, listing.source.repo_name, input.value.trim()) : 'Herdr will create the checkout in its configured worktree directory from HEAD.'; }; input.oninput = update; update(); input.focus(); input.select(); submit.disabled = false;
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
      try {
        const result = await this.host.api<{ workspaceId: string; terminalId?: string }>('api/herdr/action', { action, workspaceId: space.id, ...(action === 'split' ? { terminalId, direction: picker.value } : action === 'new-worktree' ? { branch: herdrName(input.value) } : { path: picker.value }) });
        const snapshot = await this.host.api<import('./herdr-protocol.ts').HerdrSnapshot>('api/herdr/snapshot');
        if (this.disposed) return;
        if (action !== 'split') this.selected = result.terminalId || snapshot.spaces?.find(space => space.id === result.workspaceId)?.selectedTerminalId || this.selected;
        this.receive({ type: 'snapshot', snapshot }); modal.close();
      } catch (reason: any) { if (modal.open) error.textContent = reason.message; }
      finally { busy = false; submit.disabled = cancel.disabled = input.disabled = picker.disabled = false; progress.textContent = ''; }
    };
  }
  private async closeTab(item: StripItem) {
    if (this.closing.has(item.terminalId)) return;
    this.closing.add(item.terminalId); this.menu.hidden = true;
    try {
      await this.host.api('api/herdr/action', item.space
        ? { action: 'close-space', workspaceId: item.space.id }
        : { action: 'close', terminalId: item.terminalId });
      if (!this.disposed) this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
    } catch (error: any) { if (!this.disposed) this.host.notice(error.message); }
    finally { this.closing.delete(item.terminalId); }
  }
  private openAgents(anchor: HTMLElement, spaceId?: string) {
    this.menu.replaceChildren();
    const create = node('button', '', 'Create agent'); create.role = 'menuitem'; create.onclick = () => void this.createAgent(spaceId);
    this.menu.append(create, node('p', 'herdr-menu-hint', this.spaceMode ? 'Open existing terminal' : 'Open existing agent'));
    const terminals = (this.spaceMode ? this.terminals : this.tracker.agents).filter(agent => !spaceId || agent.workspaceId === spaceId);
    if (!terminals.length) this.menu.append(node('p', 'herdr-menu-hint', 'No terminals are running here.'));
    for (const agent of terminals) {
      const item = node('button', '', agent.name + ' · ' + agent.workspace); item.role = 'menuitem';
      item.onclick = () => {
        this.selectTerminal(agent.terminalId); this.save(); this.render();
      };
      this.menu.append(item);
    }
    this.popup(anchor);
  }
  private async createAgent(spaceId?: string) {
    this.menu.hidden = true;
    const modal = node('dialog'), form = node('form'), title = node('h2', '', 'Create agent');
    const name = node('input'), kind = node('select'), space = node('select'), cwd = node('input'), error = node('p', 'form-error'), actions = node('div', 'actions');
    name.required = true; name.maxLength = 100; name.value = 'New agent'; name.setAttribute('aria-label', 'Agent name');
    kind.setAttribute('aria-label', 'Agent type'); space.setAttribute('aria-label', 'Space'); cwd.setAttribute('aria-label', 'Working directory'); cwd.placeholder = 'Use the space’s directory';
    for (const value of this.spaces) { const option = node('option', '', value.name); option.value = value.id; space.append(option); }
    space.value = spaceId || this.terminals.find(t => t.terminalId === this.selected)?.workspaceId || this.spaces[0]?.id || '';
    const setDirectory = () => { cwd.value = this.terminals.find(t => t.workspaceId === space.value)?.cwd || ''; }; setDirectory(); space.onchange = setDirectory;
    const cancel = node('button', 'secondary', 'Cancel'), create = node('button', 'primary', 'Create agent'); cancel.type = 'button'; create.type = 'submit'; create.disabled = true; cancel.onclick = () => modal.close();
    const field = (text: string, control: HTMLElement) => { const label = node('label', '', text); label.append(control); return label; };
    actions.append(cancel, create); form.append(title, field('Name', name), field('Agent type', kind), field('Space', space), field('Working directory', cwd), error, actions); modal.append(form); document.body.append(modal); modal.onclose = () => modal.remove();
    modal.showModal(); name.focus(); name.select();
    try {
      const options = await this.host.api<{ kinds: string[] }>('api/herdr/options');
      for (const value of options.kinds) { const option = node('option', '', value); option.value = value; kind.append(option); }
      const current = this.terminals.find(t => t.terminalId === this.selected)?.kind;
      kind.value = options.kinds.includes(current || '') ? current! : options.kinds.includes('codex') ? 'codex' : options.kinds[0] || '';
      create.disabled = !kind.value || !space.value;
      if (!kind.value) error.textContent = 'This Herdr server has no supported agent types.';
    } catch (reason: any) { error.textContent = reason.message; }
    form.onsubmit = async event => {
      event.preventDefault(); if (create.disabled) return; create.disabled = true; cancel.disabled = true;
      try {
        const result = await this.host.api<{ terminalId: string; error?: string }>('api/herdr/action', { action: 'create', name: herdrName(name.value), kind: kind.value, workspaceId: space.value, ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) });
        this.receive({ type: 'snapshot', snapshot: await this.host.api('api/herdr/snapshot') });
        this.selectTerminal(result.terminalId); modal.close();
        if (result.error) this.host.notice('Created a terminal, but the agent could not start: ' + result.error);
      } catch (reason: any) { error.textContent = reason.message; }
      finally { create.disabled = false; cancel.disabled = false; }
    };
  }
  private async rename(agent: StripItem) {
    this.menu.hidden = true;
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
    clearTimeout(this.reconnect); clearInterval(this.presenceTimer); this.ws?.close(); this.displayed?.remove(); for (const entry of this.terminalFrames.values()) entry.frame.remove(); this.terminalFrames.clear(); this.element.remove();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }
}
