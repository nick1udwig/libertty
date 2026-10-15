import type { Terminal } from 'ghostty-web';
import type { TerminalFocus } from './terminal-focus.ts';
import { TerminalScrollbar } from './terminal-scrollbar.ts';
import { terminalLinkAt } from './terminal-links.ts';
import { isPreservingScrollback } from './terminal-viewport.ts';
import { terminalContact } from './terminal-contact.ts';

interface Point { row: number; col: number }
interface Host {
  tap(x: number, y: number): void; copy(text: string): Promise<void>; focus: TerminalFocus;
  pan?: { enabled(): boolean; move(pixels: number): void };
  scroll?: { enabled(): boolean; move(lines: number, x: number, y: number): void };
}

/** Keep a tap, a scroll and a text selection separate from keyboard focus. */
export class TerminalGestures {
  private canvas: HTMLCanvasElement;
  private highlights = document.createElement('div');
  private notice = document.createElement('div');
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private copyGeneration = 0;
  private handles = [document.createElement('button'), document.createElement('button')];
  private start?: Point;
  private end?: Point;
  private press?: { x: number; y: number; lastX: number; lastY: number; started: number; at: number; velocity: number; mode: 'pending' | 'scroll' | 'select' | 'pan' };
  private hold?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private dragHandle?: number;
  private lastTouch = -Infinity;
  private scrollFraction = 0;
  private scrollLinePixels?: number;
  private term: Terminal;
  constructor(term: Terminal, host: Host) {
    this.term = term;
    const element = term.element!;
    this.canvas = element.querySelector('canvas')!;
    const geometry = new ResizeObserver(() => { this.scrollLinePixels = undefined; });
    geometry.observe(this.canvas);
    window.addEventListener('pagehide', event => { if (!event.persisted) geometry.disconnect(); });
    const surface = (target: EventTarget | null) => target === element || target === this.canvas || target === term.textarea;
    const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
    this.highlights.className = 'terminal-selection';
    this.notice.className = 'selection-notice'; this.notice.hidden = true;
    this.notice.setAttribute('role', 'status'); this.notice.setAttribute('aria-live', 'polite');
    element.append(this.highlights, this.notice);
    // The pinned Ghostty adapter already copies native mouse selections and
    // double-clicks. Use one clipboard hook for their confirmation as well.
    const native = term as unknown as { selectionManager: { copyToClipboard(text: string): void } };
    native.selectionManager.copyToClipboard = text => void this.copy(host, text);
    this.handles.forEach((handle, index) => {
      handle.className = 'selection-handle'; handle.hidden = true;
      handle.setAttribute('aria-label', index ? 'Selection end' : 'Selection start');
      element.append(handle);
      terminalContact(handle, {
        down: () => { host.focus.suppress(); this.dismissNotice(); this.cancelMomentum(); this.dragHandle = index; return true; },
        move: ({ x, y }) => {
          if (this.dragHandle !== index) return;
          const bounds = this.canvas.getBoundingClientRect();
          const point = this.point(x + (index ? -.5 : .5) * bounds.width / term.cols, y - 12 - bounds.height / term.rows / 2);
          if (index) this.end = point; else this.start = point;
          this.render();
        },
        up: () => {
          if (this.dragHandle !== index) return;
          this.dragHandle = undefined; void this.copy(host);
        },
        cancel: () => { this.dragHandle = undefined; },
      });
    });
    const move = (x: number, y: number, at: number) => {
      const press = this.press;
      if (!press) return;
      const dx = x - press.x, dy = y - press.y;
      if (press.mode === 'pending') {
        if (Math.hypot(dx, dy) < 6) return;
        clearTimeout(this.hold); this.clear();
        press.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? host.pan?.enabled() ? 'pan' : 'select' : 'scroll';
        if (press.mode === 'select') this.start = this.point(press.x, press.y);
      }
      if (press.mode === 'pan') host.pan?.move(press.lastX - x);
      else if (press.mode === 'select') { this.end = this.point(x, y); this.render(); }
      else {
        const delta = y - press.lastY;
        press.velocity = delta / Math.max(8, at - press.at);
        this.scroll(host, -delta / this.linePixels(), x, y);
        press.at = at;
      }
      press.lastX = x; press.lastY = y;
    };
    terminalContact(element, {
      accepts: surface,
      down: ({ x, y, at, pointerType }) => {
        if (pointerType === 'mouse') {
          if (performance.now() - this.lastTouch >= 800) host.focus.allowMouse();
          return false;
        }
        host.focus.suppress(); this.dismissNotice(); this.lastTouch = performance.now();
        this.cancelMomentum(); this.scrollFraction = 0; this.scrollLinePixels = undefined; clearTimeout(this.hold);
        this.press = { x, y, lastX: x, lastY: y, started: at, at, velocity: 0, mode: 'pending' };
        this.hold = setTimeout(() => {
          if (!this.press || this.press.mode !== 'pending') return;
          this.press.mode = 'select'; this.selectWord(this.point(x, y));
        }, 350);
        return true;
      },
      move: ({ x, y, at }) => { this.lastTouch = performance.now(); move(x, y, at); },
      up: ({ x, y, at }) => {
        if (!this.press) return;
        this.lastTouch = performance.now(); clearTimeout(this.hold);
        // A coalesced gesture can move without delivering a final move event.
        // Check release distance and duration before granting keyboard focus.
        if (this.press.mode === 'pending' && at - this.press.started >= 350) {
          this.press.mode = 'select'; this.selectWord(this.point(this.press.x, this.press.y));
        }
        if (x !== this.press.lastX || y !== this.press.lastY) move(x, y, at);
        const press = this.press; this.press = undefined;
        if (press.mode === 'pending') {
          this.clear();
          const bounds = this.canvas.getBoundingClientRect();
          const inside = press.x >= bounds.left && press.x < bounds.right && press.y >= bounds.top && press.y < bounds.bottom;
          const point = this.point(press.x, press.y);
          const link = inside ? terminalLinkAt(term, point.col, point.row) : undefined;
          if (link) window.open(link, '_blank', 'noopener,noreferrer');
          else { host.tap(press.x, press.y); host.focus.focus(); }
        }
        else if (press.mode === 'select') void this.copy(host);
        else if (press.mode === 'scroll' && at - press.at < 100) this.momentum(host, press.velocity, x, y);
      },
      cancel: () => { this.lastTouch = performance.now(); clearTimeout(this.hold); this.press = undefined; this.cancelMomentum(); },
    });
    element.addEventListener('pointerdown', e => {
      if (surface(e.target) && e.pointerType === 'mouse' && performance.now() - this.lastTouch < 800) stop(e);
    }, { capture: true });
    element.addEventListener('contextmenu', e => {
      // Ghostty's native menu focuses and repositions its textarea even when the
      // event was prevented. Stop it before it reaches the canvas on long press.
      if (surface(e.target) && (this.press || this.start || performance.now() - this.lastTouch < 800)) stop(e);
    }, { capture: true });
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click']) element.addEventListener(type, event => {
      if (!surface(event.target)) return;
      const capabilities = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities;
      // Android may dispatch compatibility mouse events after the touch ends.
      // They must not reach Ghostty's independent mouse focus/selection handlers.
      if (this.press || (capabilities?.firesTouchEvents ?? performance.now() - this.lastTouch < 800)) { stop(event); return; }
      if (type === 'mousedown') { this.cancelMomentum(); this.clear(false); }
    }, { capture: true });
    term.onSelectionChange(() => this.render());
    term.onScroll(() => { if (this.start && !isPreservingScrollback(term)) this.clear(); else this.render(); });
    term.onData(() => { this.cancelMomentum(); this.clear(); });
    term.onResize(() => { this.scrollLinePixels = undefined; this.clear(); });
    new TerminalScrollbar(term, () => {
      host.focus.suppress(); this.cancelMomentum(); clearTimeout(this.hold);
      this.press = undefined; this.lastTouch = performance.now(); this.clear();
    });
  }
  get text() {
    const range = this.range();
    if (!range) return this.term.getSelection();
    const chunks: string[] = [];
    for (let row = range.start.row; row <= range.end.row; row++) {
      const line = this.term.buffer.active.getLine(row);
      if (!line) continue;
      let text = '';
      const first = row === range.start.row ? range.start.col : 0;
      const last = row === range.end.row ? range.end.col : this.term.cols - 1;
      for (let col = first; col <= last; col++) {
        const cell = line.getCell(col);
        if (cell?.getWidth()) text += cell.getChars() || ' ';
      }
      const wrapped = row < range.end.row && this.term.buffer.active.getLine(row + 1)?.isWrapped;
      chunks.push(wrapped && last === this.term.cols - 1 ? text : text.trimEnd());
      if (row < range.end.row && !wrapped) chunks.push('\n');
    }
    return chunks.join('');
  }
  private point(x: number, y: number): Point {
    const bounds = this.canvas.getBoundingClientRect();
    let col = Math.max(0, Math.min(this.term.cols - 1, Math.floor((x - bounds.left) / (bounds.width / this.term.cols))));
    const row = Math.max(0, Math.min(this.term.rows - 1, Math.floor((y - bounds.top) / (bounds.height / this.term.rows))));
    const line = this.term.buffer.active.getLine(this.topRow() + row);
    if (col > 0 && line?.getCell(col)?.getWidth() === 0 && line.getCell(col - 1)?.getWidth() === 2) col--;
    return { col, row: this.topRow() + row };
  }
  private topRow() { return Math.max(0, this.term.buffer.active.length - this.term.rows - Math.floor(this.term.getViewportY())); }
  private linePixels() { return this.scrollLinePixels ??= Math.max(6, this.canvas.getBoundingClientRect().height / this.term.rows * .65); }
  private range() {
    if (!this.start || !this.end) return;
    const before = this.start.row < this.end.row || this.start.row === this.end.row && this.start.col <= this.end.col;
    return before ? { start: this.start, end: this.end } : { start: this.end, end: this.start };
  }
  private selectWord(point: Point) {
    this.term.clearSelection();
    const line = this.term.buffer.active.getLine(point.row);
    let first = point.col, last = point.col;
    const word = (col: number) => !!line?.getCell(col)?.getChars().trim() || col > 0 && line?.getCell(col)?.getWidth() === 0 && line.getCell(col - 1)?.getWidth() === 2;
    if (word(point.col)) {
      while (first > 0 && word(first - 1)) first--;
      while (last < this.term.cols - 1 && word(last + 1)) last++;
    }
    this.start = { row: point.row, col: first }; this.end = { row: point.row, col: last }; this.render();
  }
  clear(native = true) {
    this.start = this.end = undefined;
    this.dismissNotice();
    this.highlights.replaceChildren(); this.handles.forEach(handle => handle.hidden = true);
    if (native) this.term.clearSelection();
  }
  private dismissNotice() {
    this.copyGeneration++; clearTimeout(this.noticeTimer); this.notice.hidden = true;
  }
  private async copy(host: Host, text = this.text) {
    if (!text) return;
    const generation = ++this.copyGeneration;
    let message: string;
    try {
      await host.copy(text);
      const count = Array.from(text).length;
      message = `Copied ${count.toLocaleString()} ${count === 1 ? 'character' : 'characters'} to clipboard`;
    } catch { message = 'Clipboard is unavailable. Text remains selected.'; }
    if (generation !== this.copyGeneration) return;
    this.notice.textContent = message; this.notice.hidden = false; this.render();
    clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => { this.notice.hidden = true; }, 2200);
  }
  private render() {
    const range = this.range();
    if (!range && this.notice.hidden) return;
    this.highlights.replaceChildren();
    const bounds = this.canvas.getBoundingClientRect(), container = this.term.element!.getBoundingClientRect();
    const viewport = this.term.element!.parentElement?.id === 'terminal-viewport' ? this.term.element!.parentElement.getBoundingClientRect() : container;
    const width = bounds.width / this.term.cols, height = bounds.height / this.term.rows, top = this.topRow();
    this.handles.forEach(handle => handle.hidden = !range);
    if (range) {
      for (let row = Math.max(top, range.start.row); row <= Math.min(top + this.term.rows - 1, range.end.row); row++) {
        const first = row === range.start.row ? range.start.col : 0, last = row === range.end.row ? range.end.col : this.term.cols - 1;
        const highlight = document.createElement('span');
        Object.assign(highlight.style, { left: `${bounds.left - container.left + first * width}px`, top: `${bounds.top - container.top + (row - top) * height}px`, width: `${(last - first + 1) * width}px`, height: `${height}px` });
        this.highlights.append(highlight);
      }
      [this.start!, this.end!].forEach((point, i) => {
        const handle = this.handles[i];
        handle.style.left = `${Math.max(viewport.left - container.left, Math.min(viewport.right - container.left - 32, bounds.left - container.left + (point.col + (i ? 1 : 0)) * width - 16))}px`;
        handle.style.top = `${Math.min(container.height - 32, bounds.top - container.top + (point.row - top + 1) * height - 4)}px`;
      });
    }
    if (!this.notice.hidden) {
      this.notice.style.left = `${viewport.left - container.left + 8}px`; this.notice.style.right = 'auto'; this.notice.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
      const row = range ? range.start.row - top : 0;
      this.notice.style.top = `${Math.max(4, Math.min(container.height - 40, bounds.top - container.top + row * height - 36))}px`;
    }
  }
  private cancelMomentum() { cancelAnimationFrame(this.frame); this.frame = 0; }
  private scroll(host: Host, lines: number, x: number, y: number) {
    if (host.scroll?.enabled()) {
      this.scrollFraction += lines;
      const steps = Math.trunc(this.scrollFraction);
      if (steps) { this.scrollFraction -= steps; host.scroll.move(steps, x, y); }
      return true;
    }
    this.scrollFraction = 0;
    const before = this.term.getViewportY();
    this.term.scrollLines(lines);
    return before !== this.term.getViewportY();
  }
  private momentum(host: Host, velocity: number, x: number, y: number) {
    if (Math.abs(velocity) < .08) return;
    let last = performance.now();
    const step = (at: number) => {
      const dt = Math.min(32, at - last); last = at;
      const moved = this.scroll(host, -velocity * dt / this.linePixels(), x, y); velocity *= Math.exp(-dt / 220);
      if (Math.abs(velocity) > .03 && moved) this.frame = requestAnimationFrame(step);
      else this.frame = 0;
    };
    this.frame = requestAnimationFrame(step);
  }
}
