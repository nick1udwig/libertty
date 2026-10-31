import { createTerminal, type GespenstTerminal } from '@gespenst/core';
import type { CoreRuntime, CoreTerminal, RenderColor, RenderFrame, RenderRow, TerminalTheme, ViewportSnapshot } from '@gespenst/core/headless';
import { GhosttyTerminal, Ghostty } from './terminal-core.ts';
import { createTerminalBuffer } from './terminal-buffer.ts';
import { terminalLinkAt } from './terminal-links.ts';

export type ITheme = { [K in Exclude<keyof TerminalTheme, 'appearance' | 'palette' | 'extendedAnsi'>]?: string };
interface TerminalOptions {
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  cursorBlink?: boolean;
  smoothScrollDuration?: number;
  theme?: ITheme;
}
type Frame = RenderFrame | ViewportSnapshot;
type ColorTransform = (r: number, g: number, b: number) => [number, number, number];
type ScreenMetrics = { width: number; height: number; cellHeight: number; devicePixelRatio: number };
/** Version-scoped access to Gespenst 0.2.0's local core and render scheduling. */
interface LocalBackend {
  terminal: CoreTerminal;
  pointer(input: Parameters<GespenstTerminal['sendPointer']>[0]): void;
  retained: { runtime: CoreRuntime; changed(): void };
  pipeline: { host: { schedule(callback: () => void): void }; scheduleRender(): Promise<void> };
  painter: {
    blinkTimer: ReturnType<typeof setInterval>;
    focused: boolean;
    render(frame: Frame): void | Promise<void>;
    setFocused(focused: boolean): void;
    paint(frame: ViewportSnapshot, damage: ReadonlySet<number>): void;
    resize(metrics: ScreenMetrics): void;
    metrics: ScreenMetrics;
    background: {
      resize(width: number, height: number): void;
      render(frame: ViewportSnapshot, metrics: ScreenMetrics, blinkVisible: boolean, focused: boolean): void;
    };
  };
}

/** Libertty's synchronous terminal contract over one Gespenst parser and renderer. */
export class Terminal {
  readonly options: TerminalOptions;
  readonly buffer = createTerminalBuffer(() => this.wasmTerm);
  element?: HTMLElement;
  /** Clipped terminal grid; its canvases move inside it during partial-row scrolling. */
  screen?: HTMLElement;
  textarea?: HTMLTextAreaElement;
  wasmTerm?: GhosttyTerminal;
  ghostty?: Ghostty;
  private view?: GespenstTerminal;
  private fontUpdate?: Promise<unknown>;
  private backend?: LocalBackend;
  private paintFrame?: (frame: Frame) => void | Promise<void>;
  private pendingFrame?: () => void;
  private schedulingNow = false;
  private scheduler?: () => void;
  private cursorVisible = true;
  private fullFrame = false;
  private viewportFraction = 0;
  private viewportBase = 0;
  private screenLayer?: HTMLElement;
  private screenText?: HTMLElement;
  private screenShift?: number;
  private ringStart = 0;
  private paintedBase?: number;
  private paintedAbove?: number;
  private paintedGeneration?: number;
  private paintedCursor?: number;
  private paintedTop?: number;
  private selectionChanged = false;
  private slotLines: number[] = [];
  private slotStamps: number[] = [];
  private stamp = 0;
  private colorTransform?: ColorTransform;
  private focusHandler?: () => void;
  private automaticFocusHandler?: () => void;
  private copyHandler?: (text: string) => void;
  private listeners = new Map<string, Set<(value: any) => void>>();
  private lastCursor = '';
  private lastScroll = 0;
  readonly renderer = { getMetrics: () => {
    const geometry = this.view?.geometry;
    const layout = (this.view as unknown as { layout?: { metrics: { devicePixelRatio: number } } })?.layout;
    const ratio = layout?.metrics.devicePixelRatio ?? 1;
    return { width: (geometry?.cellWidthPx ?? 8) / ratio, height: (geometry?.cellHeightPx ?? 16) / ratio };
  } };
  constructor(options: TerminalOptions) {
    this.options = new Proxy({ ...options }, { set: (target, key, value) => {
      Reflect.set(target, key, value);
      if (key === 'fontSize' || key === 'fontFamily') this.fontUpdate = this.view?.setFont({ sizePx: target.fontSize, family: target.fontFamily });
      if (key === 'theme') void this.view?.setTheme(value);
      return true;
    } });
  }
  get cols() { return this.wasmTerm?.cols ?? this.options.cols ?? 80; }
  get rows() { return this.wasmTerm?.rows ?? this.options.rows ?? 24; }
  async open(element: HTMLElement) {
    this.element = element;
    const view = this.view = await createTerminal({
      container: element, worker: false, renderer: 'canvas2d',
      cols: this.options.cols, rows: this.options.rows, fontFamily: this.options.fontFamily,
      fontSizePx: this.options.fontSize, scrollbackLines: this.options.scrollback,
      defaultCursorBlink: false, theme: this.options.theme,
    });
    const backend = this.backend = (view as unknown as { backend: LocalBackend }).backend;
    if (!backend.terminal || !backend.pipeline?.host || !backend.painter) throw new Error('Unsupported Gespenst local backend');
    this.ghostty = new Ghostty(backend.retained.runtime, { theme: this.options.theme });
    this.wasmTerm = new GhosttyTerminal(backend.terminal, () => {
      backend.retained.changed(); void backend.pipeline.scheduleRender();
    });
    (view as unknown as { resizeObserver: ResizeObserver }).resizeObserver.disconnect();
    this.textarea = view.element.querySelector('textarea')!;
    this.textarea.addEventListener('beforeinput', event => {
      if (event.isComposing) return;
      const text = event.inputType === 'insertText' ? event.data
        : ['insertLineBreak', 'insertParagraph'].includes(event.inputType) ? '\r' : undefined;
      if (!text) return;
      event.preventDefault(); event.stopImmediatePropagation(); view.sendText(text);
    });
    this.textarea.addEventListener('input', () => {
      if (this.textarea!.value.startsWith('\u200b')) this.textarea!.value = this.textarea!.value.slice(1);
    }, { capture: true });
    clearInterval(backend.painter.blinkTimer);
    backend.pipeline.host.schedule = callback => this.scheduleFrame(callback);
    const paint = backend.painter.render.bind(backend.painter);
    this.paintFrame = frame => paint(this.transformFrame(frame));
    backend.painter.render = frame => {
      if (this.fullFrame) { this.fullFrame = false; this.clearRing(); frame = backend.terminal.viewport(); }
      return this.paintFrame!(frame);
    };
    const screen = this.screen = document.createElement('div'), layer = this.screenLayer = document.createElement('div');
    screen.className = 'terminal-screen';
    Object.assign(screen.style, { position: 'absolute', left: '0', top: '0', overflow: 'hidden' });
    // The compositor moves this layer between rows, so partial-row scrolling repaints no pixels.
    Object.assign(layer.style, { position: 'absolute', inset: '0', willChange: 'transform' });
    layer.append(...view.element.querySelectorAll('canvas'));
    screen.append(layer);
    view.element.prepend(screen);
    this.screenText = layer.querySelector<HTMLElement>('.gespenst__text') ?? undefined;
    // The text canvas holds two windows, with each line in the slot at its line number modulo the window height.
    // Any window is therefore contiguous, and crossing rows draws only lines that the slots do not hold.
    const background = backend.painter.background, resizeBackground = background.resize.bind(background), renderBackground = background.render.bind(background);
    background.resize = (width, height) => resizeBackground(width, height / 2);
    background.render = (frame, metrics, blinkVisible, focused) => renderBackground(this.windowFrame(frame), { ...metrics, height: metrics.height / 2 }, blinkVisible, focused);
    const resizePainter = backend.painter.resize.bind(backend.painter);
    backend.painter.resize = metrics => {
      // Window row 0 holds the line above the viewport, hidden until a partial row reveals it.
      const window = metrics.height + metrics.cellHeight;
      resizePainter({ ...metrics, height: 2 * window });
      const ratio = metrics.devicePixelRatio, width = `${metrics.width / ratio}px`;
      Object.assign(screen.style, { width, height: `${metrics.height / ratio}px` });
      for (const canvas of layer.querySelectorAll('canvas')) Object.assign(canvas.style, { width, height: `${(canvas === this.screenText ? 2 * window : window) / ratio}px` });
      this.paintedBase = this.paintedAbove = this.screenShift = undefined;
      this.clearRing();
      this.screenText?.style.removeProperty('transform');
      this.fullFrame = true;
      this.moveScreen();
    };
    backend.painter.resize(backend.painter.metrics);
    const paintViewport = backend.painter.paint.bind(backend.painter);
    backend.painter.paint = (frame, damage) => {
      const above = this.showsAbove(), base = this.wasmTerm!.getViewportY(), generation = this.wasmTerm!.contentGeneration();
      const size = frame.rows + 1, top = this.buffer.active.viewportY - 1, start = (top % size + size) % size;
      const screen = this.screenFrame(frame), slot = (line: number) => (line % size + size) % size;
      const rows = this.ringRows(frame.rows, damage, top, generation, above, screen.cursor.y);
      const cursor = screen.cursor.y === null ? null : start + screen.cursor.y;
      this.ringStart = start;
      paintViewport({ ...screen, cursor: { ...screen.cursor, y: cursor },
        viewportRows: screen.viewportRows.flatMap(row => [{ ...row, y: slot(top + row.y) }, { ...row, y: slot(top + row.y) + size }]) }, rows);
      this.paintedBase = base;
      this.paintedAbove = above ? base : undefined;
      this.paintedGeneration = generation;
      this.paintedCursor = screen.cursor.visible && screen.cursor.y !== null ? top + screen.cursor.y : undefined;
      this.paintedTop = top;
      this.selectionChanged = false;
      const metrics = backend.painter.metrics;
      this.screenText?.style.setProperty('transform', `translate3d(0, ${-start * metrics.cellHeight / metrics.devicePixelRatio}px, 0)`);
      this.moveScreen();
    };
    const sendPointer = backend.pointer.bind(backend);
    backend.pointer = input => {
      const fraction = this.getViewportY() % 1;
      if (!fraction) { sendPointer(input); return; }
      const height = view.geometry.cellHeightPx, base = this.wasmTerm!.getViewportY();
      const previous = input.y < fraction * height;
      // Ghostty resolves selection points inside its integer viewport.
      if (previous) this.wasmTerm!.setViewportY(base + 1);
      try { sendPointer({ ...input, y: input.y + (previous ? 1 - fraction : -fraction) * height }); }
      finally { if (previous) this.wasmTerm!.setViewportY(base); }
    };
    backend.painter.setFocused = focused => { backend.painter.focused = focused; this.fullFrame = true; this.requestRender(); };
    view.focus = () => this.requestAutomaticFocus();
    view.on('input', event => this.emit('data', new TextDecoder().decode(event.data)));
    view.on('resize', () => this.emit('resize', { cols: this.cols, rows: this.rows }));
    view.on('selectionChange', () => { this.selectionChanged = true; this.emit('selection'); });
    view.on('scroll', () => this.notifyScroll());
    view.on('viewportChange', () => {
      const cursor = this.wasmTerm!.getCursor(), key = `${cursor.x},${cursor.y}`;
      if (key !== this.lastCursor) { this.lastCursor = key; this.emit('cursor'); }
      this.emit('render');
    });
    view.element.addEventListener('pointerup', event => this.handlePointerUp(event));
    this.requestRender();
  }
  private handlePointerUp(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    const text = this.getSelection();
    if (text) { this.copyHandler?.(text); return; }
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;
    const bounds = this.view!.element.getBoundingClientRect(), metrics = this.renderer.getMetrics();
    const col = Math.floor((event.clientX - bounds.left) / metrics.width);
    const y = (event.clientY - bounds.top) / metrics.height;
    if (col < 0 || col >= this.cols || y < 0 || y >= this.rows) return;
    const row = Math.floor(this.buffer.active.viewportY - this.getViewportY() % 1 + y);
    const link = terminalLinkAt(this, col, row);
    if (link) window.open(link, '_blank', 'noopener,noreferrer');
  }
  private transformFrame(frame: Frame): Frame {
    const cursor = { ...frame.cursor, blinking: false, visible: frame.cursor.visible && this.cursorVisible };
    if (!this.colorTransform) return { ...frame, cursor };
    const color = (value: RenderColor): RenderColor => {
      const [r, g, b] = this.colorTransform!(value.r, value.g, value.b);
      return { ...value, r, g, b };
    };
    const row = (value: RenderRow): RenderRow => ({ ...value, cells: value.cells.map(cell => ({ ...cell,
      foreground: cell.foreground && color(cell.foreground), background: cell.background && color(cell.background),
    })) });
    return 'viewportRows' in frame ? { ...frame, cursor, viewportRows: frame.viewportRows.map(row) }
      : { ...frame, cursor, changedRows: frame.changedRows.map(row) };
  }
  /** Moves viewport rows down one canvas row and adds the preceding line while history shows. */
  private screenFrame(frame: ViewportSnapshot): ViewportSnapshot {
    const rows = frame.viewportRows.map(row => ({ ...row, y: row.y + 1 }));
    const cursor = { ...frame.cursor, y: frame.cursor.y === null ? null : frame.cursor.y + 1 };
    if (!this.showsAbove()) return { ...frame, cursor, viewportRows: rows };
    const above = this.wasmTerm!.getBufferRow(this.buffer.active.viewportY - 1);
    const row = above ? (this.transformFrame({ ...frame, viewportRows: [{ ...above, y: 0 }] }) as ViewportSnapshot).viewportRows[0]
      : { y: 0, text: '', cells: [], wrapped: false, wrapContinuation: false, selection: null };
    return { ...frame, cursor, viewportRows: [row, ...rows] };
  }
  /**
   * Returns the ring rows to draw and records the line and content stamp each one holds.
   * Rows drawn while only the viewport moves also fill their second copy, so passing the ring's end draws nothing extra.
   */
  private ringRows(rows: number, damage: ReadonlySet<number>, top: number, generation: number, above: boolean, cursor: number | null) {
    const size = rows + 1, start = (top % size + size) % size, previous = this.stamp, draw = new Set<number>();
    const moved = top !== this.paintedTop;
    // A full repaint in place can change colors that hidden copies still show.
    const changed = generation !== this.paintedGeneration || this.selectionChanged || !moved && damage.size >= rows;
    if (changed) this.stamp++;
    const cursors = [this.paintedCursor, cursor === null ? undefined : top + cursor];
    for (let row = above ? 0 : 1; row < size; row++) {
      const index = start + row, line = top + row;
      const held = this.slotLines[index] === line && this.slotStamps[index] === previous && !(moved && changed)
        && !(!moved && (damage.has(row - 1) || row === 0 && changed)) && !cursors.includes(line);
      if (!held) {
        draw.add(index);
        if (moved && !changed) {
          const copy = index < size ? index + size : index - size;
          draw.add(copy);
          this.slotLines[copy] = line; this.slotStamps[copy] = this.stamp;
        }
      }
      this.slotLines[index] = line; this.slotStamps[index] = this.stamp;
    }
    return draw;
  }
  private clearRing() { this.slotLines = []; this.slotStamps = []; this.paintedTop = undefined; this.ringStart = 0; }
  /** Background rows in the visible window, numbered from the window top. */
  private windowFrame(frame: ViewportSnapshot): ViewportSnapshot {
    const start = this.ringStart, size = frame.rows + 1;
    const rows = frame.viewportRows.filter(row => row.y >= start && row.y < start + size).map(row => ({ ...row, y: row.y - start }));
    return { ...frame, cursor: { ...frame.cursor, y: frame.cursor.y === null ? null : frame.cursor.y - start }, viewportRows: rows };
  }
  /** Live output skips the hidden preceding line, while history keeps it ready for the next partial row. */
  private showsAbove() { return this.getViewportY() > 0; }
  private moveScreen() {
    const metrics = this.backend?.painter.metrics;
    if (!metrics || !this.screenLayer) return;
    const shift = Math.round(this.getViewportY() % 1 * metrics.cellHeight) - metrics.cellHeight;
    if (shift === this.screenShift) return;
    this.screenShift = shift;
    this.screenLayer.style.transform = `translate3d(0, ${shift / metrics.devicePixelRatio}px, 0)`;
  }
  private scheduleFrame(callback: () => void) { this.pendingFrame = callback; if (!this.schedulingNow) this.requestRender(); }
  private requestRender() { if (this.scheduler) this.scheduler(); else requestAnimationFrame(() => this.renderNow()); }
  setRenderScheduler(callback: () => void) { this.scheduler = callback; }
  setCursorVisible(visible: boolean) { this.cursorVisible = visible; }
  setColorTransform(transform: ColorTransform) { this.colorTransform = transform; this.fullFrame = true; this.requestRender(); }
  setFocusHandler(callback: () => void) { this.focusHandler = callback; }
  setAutomaticFocusHandler(callback: () => void) { this.automaticFocusHandler = callback; }
  requestAutomaticFocus() {
    if (this.automaticFocusHandler) this.automaticFocusHandler();
    else this.textarea?.focus({ preventScroll: true });
  }
  setCopyHandler(callback: (text: string) => void) { this.copyHandler = callback; }
  renderNow() {
    if (!this.backend) return;
    if (!this.pendingFrame) {
      this.schedulingNow = true;
      try { void this.backend.pipeline.scheduleRender(); } finally { this.schedulingNow = false; }
    }
    const callback = this.pendingFrame; this.pendingFrame = undefined; callback?.();
  }
  renderCore(core: GhosttyTerminal) {
    void this.paintFrame?.(core.core.viewport());
    // Another core's picture cannot serve this terminal's next partial row.
    this.paintedBase = this.paintedAbove = undefined;
    this.clearRing();
  }
  write(data: string | Uint8Array, callback?: () => void) { this.view ? this.view.write(data) : this.wasmTerm?.write(data); callback?.(); }
  resize(cols: number, rows: number) { if (this.view) this.view.resize(cols, rows); else this.wasmTerm?.resize(cols, rows); }
  focus() { if (this.focusHandler) this.focusHandler(); else this.view?.focus(); }
  blur() { this.view?.blur(); }
  paste(text: string) { this.view?.paste(text); }
  getSelection() { return this.wasmTerm?.core.getSelection() ?? ''; }
  hasSelection() { return !!this.getSelection(); }
  clearSelection() { this.view?.clearSelection(); }
  getViewportY() {
    const offset = this.wasmTerm?.getViewportY() ?? 0;
    if (offset !== this.viewportBase || this.viewportFraction > 0 && offset + this.viewportFraction > (this.wasmTerm?.getScrollbackLength() ?? 0)) this.viewportFraction = 0;
    return offset + this.viewportFraction;
  }
  scrollLines(lines: number) { this.scrollToLine(this.getViewportY() - lines); }
  scrollToBottom() { this.scrollToLine(0); }
  scrollToTop() { this.scrollToLine(this.wasmTerm?.getScrollbackLength() ?? 0); }
  scrollToLine(offset: number) {
    const target = Math.max(0, Math.min(this.wasmTerm?.getScrollbackLength() ?? 0, offset));
    if (target === this.getViewportY()) return;
    this.viewportFraction = target - Math.floor(target);
    this.wasmTerm?.setViewportY(Math.floor(target));
    this.viewportBase = this.wasmTerm?.getViewportY() ?? 0;
    this.notifyScroll();
    if (!this.backend) return;
    const painted = this.viewportBase === this.paintedBase && (!this.viewportFraction || this.paintedAbove === this.viewportBase);
    if (painted) this.moveScreen(); else this.requestRender();
  }
  private notifyScroll() {
    const offset = this.getViewportY();
    if (offset === this.lastScroll) return;
    this.lastScroll = offset;
    this.emit('scroll', offset);
  }
  async setFontSize(size: number) {
    this.options.fontSize = size;
    await this.fontUpdate;
  }
  loadAddon(addon: FitAddon) { addon.activate(this); }
  private emit(name: string, value?: unknown) { for (const callback of this.listeners.get(name) ?? []) callback(value); }
  private on(name: string, callback: (value: any) => void) {
    let listeners = this.listeners.get(name);
    if (!listeners) this.listeners.set(name, listeners = new Set());
    listeners.add(callback);
    return { dispose: () => { listeners.delete(callback); } };
  }
  onData(callback: (data: string) => void) { return this.on('data', callback); }
  onResize(callback: (size: { cols: number; rows: number }) => void) { return this.on('resize', callback); }
  onCursorMove(callback: () => void) { return this.on('cursor', callback); }
  onSelectionChange(callback: () => void) { return this.on('selection', callback); }
  onScroll(callback: (offset: number) => void) { return this.on('scroll', callback); }
  onRender(callback: () => void) { return this.on('render', callback); }
  dispose() { this.view?.dispose(); this.wasmTerm?.free(); this.listeners.clear(); }
}

export class FitAddon {
  private term?: Terminal;
  activate(term: Terminal) { this.term = term; }
  proposeDimensions() {
    const term = this.term, element = term?.element;
    if (!term || !element) return;
    const metrics = term.renderer.getMetrics(), style = getComputedStyle(element);
    const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 15;
    const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return { cols: Math.max(2, Math.floor(width / metrics.width)), rows: Math.max(1, Math.floor(height / metrics.height)) };
  }
  fit() { const size = this.proposeDimensions(); if (size) this.term!.resize(size.cols, size.rows); }
  dispose() { this.term = undefined; }
}
