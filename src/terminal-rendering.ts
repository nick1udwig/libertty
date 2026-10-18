import type { Terminal } from 'ghostty-web';

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
  private frame = 0;
  private blink?: ReturnType<typeof setTimeout>;
  private visible = true;
  private disposed = false;
  private events = new AbortController();
  private term: Terminal;
  constructor(term: Terminal) {
    this.term = term;
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
    term.onSelectionChange(() => this.refresh());
    term.onScroll(() => this.refresh());
    const focus = () => { renderer.cursorVisible = true; this.refresh(); };
    for (const name of ['focusin', 'focusout']) term.element!.addEventListener(name, focus, { signal: this.events.signal });
    for (const name of ['focus', 'blur']) window.addEventListener(name, focus, { signal: this.events.signal });
    document.addEventListener('visibilitychange', () => this.refresh(), { signal: this.events.signal });
    window.addEventListener('pagehide', event => { if (!event.persisted) this.dispose(); }, { signal: this.events.signal });
    this.refresh();
  }
  setVisible(visible: boolean) { this.visible = visible; this.refresh(); }
  refresh() {
    clearTimeout(this.blink);
    if (this.disposed || !this.visible || document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; return; }
    if (!this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }
  private paint() {
    this.frame = 0;
    if (this.disposed || !this.visible || document.hidden) return;
    const term = this.term, native = term as unknown as NativeTerminal, renderer = term.renderer as unknown as NativeRenderer;
    renderer.render(term.wasmTerm!, false, term.getViewportY(), term, 0);
    const cursor = term.wasmTerm!.getCursor();
    if (cursor.y !== native.lastCursorY) { native.lastCursorY = cursor.y; native.cursorMoveEmitter.fire(); }
    if (term.options.cursorBlink && cursor.visible && term.getViewportY() === 0 && document.hasFocus() && term.element!.contains(document.activeElement)) {
      this.blink = setTimeout(() => { renderer.cursorVisible = !renderer.cursorVisible; this.refresh(); }, 530);
    } else renderer.cursorVisible = true;
  }
  dispose() {
    this.disposed = true; this.events.abort(); clearTimeout(this.blink); cancelAnimationFrame(this.frame); this.frame = 0;
  }
}
