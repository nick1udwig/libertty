import { createTerminal, type GespenstTerminal } from '@gespenst/core';
import type { CoreRuntime, CoreTerminal, RenderColor, RenderFrame, RenderRow, TerminalTheme, ViewportSnapshot } from '@gespenst/core/headless';
import { GhosttyTerminal, Ghostty } from './terminal-core.ts';
import { createTerminalBuffer } from './terminal-buffer.ts';

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
/** Version-scoped access to Gespenst 0.2.0's local core and render scheduling. */
interface LocalBackend {
  terminal: CoreTerminal;
  retained: { runtime: CoreRuntime; changed(): void };
  pipeline: { host: { schedule(callback: () => void): void }; scheduleRender(): Promise<void> };
  painter: {
    blinkTimer: ReturnType<typeof setInterval>;
    focused: boolean;
    render(frame: Frame): void | Promise<void>;
    setFocused(focused: boolean): void;
  };
}

/** Libertty's synchronous terminal contract over one Gespenst parser and renderer. */
export class Terminal {
  readonly options: TerminalOptions;
  readonly buffer = createTerminalBuffer(() => this.wasmTerm);
  element?: HTMLElement;
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
  private colorTransform?: ColorTransform;
  private focusHandler?: () => void;
  private automaticFocusHandler?: () => void;
  private copyHandler?: (text: string) => void;
  private listeners = new Map<string, Set<(value: any) => void>>();
  private lastCursor = '';
  readonly renderer = { getMetrics: () => {
    const geometry = this.view?.geometry, ratio = globalThis.devicePixelRatio || 1;
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
      if (this.fullFrame) { this.fullFrame = false; frame = backend.terminal.viewport(); }
      return this.paintFrame!(frame);
    };
    backend.painter.setFocused = focused => { backend.painter.focused = focused; this.fullFrame = true; this.requestRender(); };
    view.focus = () => this.requestAutomaticFocus();
    view.on('input', event => this.emit('data', new TextDecoder().decode(event.data)));
    view.on('resize', () => this.emit('resize', { cols: this.cols, rows: this.rows }));
    view.on('selectionChange', () => this.emit('selection'));
    view.on('scroll', () => this.emit('scroll', this.getViewportY()));
    view.on('viewportChange', () => {
      const cursor = this.wasmTerm!.getCursor(), key = `${cursor.x},${cursor.y}`;
      if (key !== this.lastCursor) { this.lastCursor = key; this.emit('cursor'); }
      this.emit('render');
    });
    view.element.addEventListener('pointerup', event => {
      if (event.pointerType === 'mouse') {
        const text = this.getSelection();
        if (text) this.copyHandler?.(text);
      }
    });
    this.requestRender();
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
  renderCore(core: GhosttyTerminal) { void this.paintFrame?.(core.core.viewport()); }
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
    if (offset !== this.viewportBase) this.viewportFraction = 0;
    return offset + this.viewportFraction;
  }
  scrollLines(lines: number) { this.scrollToLine(this.getViewportY() - lines); }
  scrollToBottom() { this.scrollToLine(0); }
  scrollToTop() { this.scrollToLine(this.wasmTerm?.getScrollbackLength() ?? 0); }
  scrollToLine(offset: number) {
    const target = Math.max(0, Math.min(this.wasmTerm?.getScrollbackLength() ?? 0, offset));
    this.viewportFraction = target - Math.floor(target);
    this.wasmTerm?.setViewportY(Math.floor(target));
    this.viewportBase = this.wasmTerm?.getViewportY() ?? 0;
    this.emit('scroll', this.getViewportY());
    if (this.backend) void this.backend.pipeline.scheduleRender();
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
