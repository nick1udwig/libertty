import { node } from './dom.ts';
import { readingOpen, type ReadingOpen } from './reading-request.ts';
import type { HerdrAgent } from './herdr-protocol.ts';
import { terminalCanEvict } from './terminal-retention.ts';

interface CachedTerminal { frame:HTMLIFrameElement; session:string; pane:string; rendered:boolean; verified:boolean; loaded?:boolean; presentation?:string; geometry?:string; locked?:boolean; width?:number; height?:number }
export interface FramesHost {
  url: string; session: string; source?: string;
  token(): string | undefined; authenticate(): Promise<void>;
  notice(message: string): void;
  reading(terminalId: string, request: ReadingOpen): void;
  visible(): boolean;
  /** A workspace handoff keeps the previous picture until it is released. */
  held(): boolean;
  agentName(terminalId: string): string | undefined;
  /** The selected terminal certified its first paint. */
  painted(): void;
  ended(): void;
}
/** Keep the selected terminal and one previous pane on phones or during a handoff. */
export class HerdrFrames {
  frame?: HTMLIFrameElement;
  displayed?: HTMLIFrameElement;
  /** The selected terminal has painted since it was chosen. */
  rendered = false;
  readonly loading = node('div', 'herdr-loading');
  private loadingLabel = node('span');
  private entries = new Map<string, CachedTerminal>();
  private resizing = new Map<HTMLIFrameElement, () => void>();
  private disposed = false;
  private screen: HTMLElement;
  private host: FramesHost;
  constructor(screen: HTMLElement, host: FramesHost) {
    this.screen = screen; this.host = host;
    this.loading.role = 'status'; this.loading.hidden = true;
    const spinner = node('span', 'terminal-loading-spinner'); spinner.setAttribute('aria-hidden', 'true');
    this.loading.append(spinner, this.loadingLabel);
  }
  /** Handle a message from one of these iframes, ignoring every other window. */
  message(event: MessageEvent) {
    if (event.origin !== location.origin) return;
    const entry = [...this.entries.values()].find(entry => event.source === entry.frame.contentWindow && event.data?.session === entry.session);
    if (!entry) return;
    const active = entry.frame === this.frame;
    if (event.data.type === 'terminal-loaded') {
      entry.loaded = true;
      entry.frame.contentWindow?.postMessage({ type: 'shortcut-host' }, location.origin);
      entry.frame.contentWindow?.postMessage({ type:'herdr-present', presentation:entry.presentation },location.origin);
      if (entry.verified) entry.frame.contentWindow?.postMessage({ type:'authorize', accessToken:this.host.token() },location.origin);
      entry.frame.contentWindow?.postMessage({ type:'tab-visibility', visible:this.host.visible() && active },location.origin);
    }
    const geometry = event.data.cols + 'x' + event.data.rows;
    if (event.data.type === 'terminal-sizing' && active && event.data.presentation === entry.presentation) entry.geometry = geometry;
    if (event.data.type === 'terminal-rendered' && active && this.host.visible() && !this.host.held() && event.data.presentation === entry.presentation && geometry === entry.geometry) {
      entry.rendered = true;
      if (this.displayed && this.displayed !== entry.frame) this.park(this.displayed);
      this.displayed = entry.frame; entry.frame.className = 'herdr-terminal'; entry.frame.style.visibility = ''; entry.frame.inert = false;
      const bounds = entry.frame.getBoundingClientRect(); entry.width = bounds.width; entry.height = bounds.height;
      this.rendered = true; this.setLoading(false); this.host.painted();
    }
    if (event.data.type === 'herdr-resize-ready') this.resizing.get(entry.frame)?.();
    if (active && event.data.type === 'terminal-notice') this.host.notice(event.data.message);
    if (event.data.type === 'reading-open' && readingOpen(event.data)) this.host.reading(entry.frame.dataset.terminal!, event.data);
    if (event.data.type === 'terminal-ended') this.host.ended();
    if (event.data.type === 'terminal-locked') entry.locked = true;
    if (active && event.data.type === 'terminal-locked') void this.host.authenticate().then(() => entry.frame.contentWindow?.postMessage({ type:'authorize', accessToken:this.host.token() },location.origin)).catch(error => this.host.notice(error.message));
  }
  setLoading(loading: boolean) {
    this.loading.hidden = !loading; this.loading.classList.toggle('has-previous', !!this.displayed);
    this.screen.setAttribute('aria-busy', String(loading));
  }
  private prepare(entry: CachedTerminal) {
    entry.presentation = crypto.randomUUID(); entry.frame.className = 'herdr-terminal herdr-terminal-pending'; entry.frame.inert = true;
    if (entry.frame !== this.displayed) entry.frame.style.visibility = 'hidden';
    this.rendered = false; this.loadingLabel.textContent = 'Loading ' + (this.host.agentName(entry.frame.dataset.terminal!) || 'terminal') + '…';
    this.setLoading(true);
    entry.frame.contentWindow?.postMessage({type:'herdr-present',presentation:entry.presentation},location.origin);
  }
  /** Keep a frame for a quick return on phones, keep it visible during a handoff, or remove it. */
  park(frame: HTMLIFrameElement, keepVisible = false) {
    const id = frame.dataset.terminal!, entry = this.entries.get(id);
    if (!entry || entry.frame !== frame) { frame.remove(); return; }
    frame.inert = true;
    if (keepVisible || matchMedia('(pointer: coarse) and (max-width: 1024px)').matches && entry.rendered || !terminalCanEvict(frame)) {
      frame.className = keepVisible ? 'herdr-terminal-previous' : 'herdr-terminal-cached'; frame.style.visibility = keepVisible ? '' : 'hidden';
      frame.contentWindow?.postMessage({type:'herdr-park',parked:true},location.origin);
    } else { frame.remove(); this.entries.delete(id); }
  }
  /** Let a frame cover its picture before its size changes, so neither its stale canvas nor its local reflow paints. */
  prepareResize(frame: HTMLIFrameElement) {
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); if (this.resizing.get(frame) === done) this.resizing.delete(frame); resolve(); };
      const timer = setTimeout(done, 150);
      this.resizing.get(frame)?.(); this.resizing.set(frame, done);
      frame.contentWindow?.postMessage({ type: 'herdr-resize-cover' }, location.origin);
    });
  }
  post(message: object) { this.frame?.contentWindow?.postMessage(message, location.origin); }
  broadcast(message: object) { for (const entry of this.entries.values()) entry.frame.contentWindow?.postMessage(message, location.origin); }
  /** Show the selected terminal, reusing its cached frame when its size still fits.
   * Unverified identities only preview retained output; live metadata authorizes the same frame. */
  mount(terminals: HerdrAgent[], selected: string, force = false, verified = true) {
    if (this.displayed && !terminals.some(agent => agent.terminalId === this.displayed!.dataset.terminal && agent.paneId === this.displayed!.dataset.pane)) { this.displayed.remove(); this.displayed = undefined; }
    for (const [id, entry] of this.entries) {
      if (!terminals.some(agent => agent.terminalId === id && agent.paneId === entry.pane)) { entry.frame.remove(); this.entries.delete(id); if (this.frame === entry.frame) this.frame = undefined; if (this.displayed === entry.frame) this.displayed = undefined; }
    }
    if (verified) for (const entry of this.entries.values()) {
      if (entry.verified) continue;
      entry.verified = true;
      if (entry.loaded) entry.frame.contentWindow?.postMessage({ type:'authorize', accessToken:this.host.token() },location.origin);
    }
    if (!selected) { this.displayed?.remove(); for (const entry of this.entries.values()) entry.frame.remove(); this.entries.clear(); this.frame = this.displayed = undefined; this.rendered = false; this.setLoading(false); return; }
    const agent = terminals.find(agent => agent.terminalId === selected);
    if (!agent || !force && this.frame?.dataset.terminal === selected && this.frame.dataset.pane === agent.paneId || !this.host.visible() || this.disposed) return;
    if (this.frame) this.park(this.frame, this.frame === this.displayed);
    this.rendered = false;
    let cached = this.entries.get(selected);
    if (cached && cached.frame === this.displayed) {
      const bounds = cached.frame.getBoundingClientRect();
      if (cached.width !== bounds.width || cached.height !== bounds.height) {
        // Keep the displayed grid frozen while a separate iframe fits the new size.
        this.entries.delete(selected); cached = undefined;
      }
    }
    if (cached) {
      this.entries.delete(selected); this.entries.set(selected,cached);
      this.frame = cached.frame;
      const bounds = cached.frame.getBoundingClientRect(), preserve = cached.rendered && cached.width === bounds.width && cached.height === bounds.height;
      this.prepare(cached);
      if (cached.locked) { cached.locked = false; void this.host.authenticate().then(() => cached.frame.contentWindow?.postMessage({type:'authorize',accessToken:this.host.token()},location.origin)).catch(error => this.host.notice(error.message)); }
      cached.frame.contentWindow?.postMessage({type:'herdr-park',parked:false,preserve},location.origin);
      cached.frame.contentWindow?.postMessage({type:'tab-visibility',visible:this.host.visible()},location.origin);
    } else {
      const session = crypto.randomUUID();
      const frame = node('iframe','herdr-terminal'); frame.title = 'Herdr agent terminal'; frame.dataset.terminal = selected; frame.dataset.pane = agent.paneId; frame.style.visibility = 'hidden';
      frame.allow = 'microphone; screen-wake-lock; clipboard-read; clipboard-write';
      const url = new URL('terminal.html',document.baseURI);
      url.search = new URLSearchParams({embedded:'1',backend:this.host.url,session,herdrTerminal:selected,herdrPane:agent.paneId,herdrSession:this.host.session,...(this.host.source?{herdrSource:this.host.source}:{}),...(verified?{}:{herdrPreview:'1'})}).toString();
      frame.src = url.href; this.frame = frame;
      const entry = {frame,session,pane:agent.paneId,rendered:false,verified}; this.entries.set(selected,entry); this.screen.append(frame); this.prepare(entry);
    }
    while (this.entries.size > 2) { const candidate = [...this.entries].find(([,entry]) => entry.frame !== this.frame && entry.frame !== this.displayed && terminalCanEvict(entry.frame)); if (!candidate) break; const [id, entry] = candidate; entry.frame.remove(); this.entries.delete(id); }
  }
  /** Park every frame except the selected one when the view hides. */
  hide() {
    if (this.displayed && ![...this.entries.values()].some(entry => entry.frame === this.displayed)) { this.displayed.remove(); this.displayed = undefined; }
    this.setLoading(false);
    for (const entry of [...this.entries.values()]) {
      if (entry.frame !== this.frame) this.park(entry.frame, entry.frame === this.displayed);
      else { entry.frame.inert = true; }
    }
  }
  /** Ask the selected frame for a fresh certified paint after the view is shown again. */
  represent() {
    const entry = this.frame && this.entries.get(this.frame.dataset.terminal!);
    if (entry) { if (entry.frame === this.displayed) entry.frame.style.visibility = ''; this.prepare(entry); }
  }
  dispose() {
    this.disposed = true;
    this.displayed?.remove(); for (const entry of this.entries.values()) entry.frame.remove(); this.entries.clear();
  }
}
