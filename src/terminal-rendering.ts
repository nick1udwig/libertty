import type { Terminal } from 'ghostty-web';
import { OutputScheduler } from './output-scheduler.ts';
import { isPreservingScrollback } from './terminal-viewport.ts';

/** Rendering hooks for the pinned Ghostty adapter. */
type NativeTerminal = {
  startRenderLoop(): void;
  lastCursorY: number;
  cursorMoveEmitter: { fire(): void };
};
type NativeRenderer = Pick<NonNullable<Terminal['renderer']>, 'render' | 'setHoveredHyperlinkId' | 'setHoveredLinkRange'> & {
  stopCursorBlink(): void;
  cursorVisible: boolean;
  cursorBlink: boolean;
};

/** Paint changed terminal content once, then let the browser sleep. */
export class TerminalRendering {
  private scheduler: OutputScheduler;
  private blink?: ReturnType<typeof setTimeout>;
  private visible = true;
  private disposed = false;
  private events = new AbortController();
  private term: Terminal;
  constructor(term: Terminal) {
    this.term = term;
    this.scheduler = new OutputScheduler(() => this.paint(), () => !this.disposed && this.visible && !document.hidden);
    (term as unknown as NativeTerminal).startRenderLoop = () => this.refresh();
  }
  attach() {
    const term = this.term, renderer = term.renderer as unknown as NativeRenderer;
    renderer.stopCursorBlink();
    renderer.cursorBlink = true;
    const paint = renderer.render.bind(renderer);
    renderer.render = (...args) => { if (!this.disposed && this.visible && !document.hidden) paint(...args); };
    const write = term.wasmTerm!.write.bind(term.wasmTerm);
    term.wasmTerm!.write = data => { write(data); this.refresh(); };
    for (const name of ['setHoveredHyperlinkId', 'setHoveredLinkRange'] as const) {
      const original = renderer[name].bind(renderer) as (...args: unknown[]) => void;
      (renderer[name] as (...args: unknown[]) => void) = (...args) => { original(...args); this.refresh(); };
    }
    term.onSelectionChange(() => this.activity());
    term.onScroll(() => { if (isPreservingScrollback(term)) this.refresh(); else this.activity(); });
    const focus = () => this.activity();
    for (const name of ['focusin', 'focusout']) term.element!.addEventListener(name, focus, { signal: this.events.signal });
    for (const name of ['focus', 'blur']) window.addEventListener(name, focus, { signal: this.events.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.refresh(); else this.activity(); }, { signal: this.events.signal });
    window.addEventListener('pagehide', event => { if (!event.persisted) this.dispose(); }, { signal: this.events.signal });
    this.refresh();
  }
  setVisible(visible: boolean) { this.visible = visible; this.refresh(); }
  activity() {
    const renderer = this.term.renderer as unknown as NativeRenderer | undefined;
    if (renderer) renderer.cursorVisible = true;
    this.scheduler.activity(); this.refresh();
  }
  refresh() {
    clearTimeout(this.blink);
    if (this.disposed || !this.visible || document.hidden) { this.scheduler.cancel(); return; }
    this.scheduler.request();
  }
  private paint() {
    if (this.disposed || !this.visible || document.hidden) return;
    const term = this.term, native = term as unknown as NativeTerminal, renderer = term.renderer as unknown as NativeRenderer;
    const cursor = term.wasmTerm!.getCursor();
    const blinking = this.scheduler.interactive && term.options.cursorBlink && cursor.visible && term.getViewportY() === 0 && document.hasFocus() && term.element!.contains(document.activeElement);
    if (!blinking) renderer.cursorVisible = true;
    renderer.render(term.wasmTerm!, false, term.getViewportY(), term, 0);
    if (cursor.y !== native.lastCursorY) { native.lastCursorY = cursor.y; native.cursorMoveEmitter.fire(); }
    if (blinking) {
      this.blink = setTimeout(() => { renderer.cursorVisible = !renderer.cursorVisible; this.refresh(); }, 530);
    }
  }
  dispose() {
    this.disposed = true; this.events.abort(); clearTimeout(this.blink); this.scheduler.cancel();
  }
}
