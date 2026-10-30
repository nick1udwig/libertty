import type { Terminal } from './terminal-adapter.ts';
import { OutputScheduler } from './output-scheduler.ts';
import { isPreservingScrollback } from './terminal-viewport.ts';

/** Paint changed terminal content once, then let the browser sleep. */
export class TerminalRendering {
  private scheduler: OutputScheduler;
  private blink?: ReturnType<typeof setTimeout>;
  private visible = true;
  private disposed = false;
  private events = new AbortController();
  private term: Terminal;
  private cursorVisible = true;
  constructor(term: Terminal) {
    this.term = term;
    this.scheduler = new OutputScheduler(() => this.paint(), () => !this.disposed && this.visible && !document.hidden);
    term.setRenderScheduler(() => this.refresh());
  }
  attach() {
    const term = this.term;
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
    this.cursorVisible = true; this.term.setCursorVisible(true);
    this.scheduler.activity(); this.refresh();
  }
  refresh() {
    clearTimeout(this.blink);
    if (this.disposed || !this.visible || document.hidden) { this.scheduler.cancel(); return; }
    this.scheduler.request();
  }
  private paint() {
    if (this.disposed || !this.visible || document.hidden) return;
    const term = this.term;
    const cursor = term.wasmTerm!.getCursor();
    const blinking = this.scheduler.interactive && term.options.cursorBlink && cursor.visible && term.getViewportY() === 0 && document.hasFocus() && term.element!.contains(document.activeElement);
    if (!blinking) this.cursorVisible = true;
    term.setCursorVisible(this.cursorVisible);
    term.renderNow();
    if (blinking) {
      this.blink = setTimeout(() => { this.cursorVisible = !this.cursorVisible; this.refresh(); }, 530);
    }
  }
  dispose() {
    this.disposed = true; this.events.abort(); clearTimeout(this.blink); this.scheduler.cancel();
  }
}
