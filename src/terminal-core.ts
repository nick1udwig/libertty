import { terminalMemoryUsage } from './terminal-memory.ts';
import {
  createCoreRuntime,
  resolveTerminalTheme,
  type CoreRuntime,
  type CoreRuntimeOptions,
  type CoreTerminal,
  type CoreTerminalOptions,
  type Disposable,
  type RenderCell,
  type RenderColors,
  type TerminalBufferRow,
  type TerminalTheme,
} from '@gespenst/core/headless';

export class Ghostty {
  readonly core: CoreRuntime;
  private defaults: CoreTerminalOptions;
  constructor(core: CoreRuntime, defaults: CoreTerminalOptions = {}) { this.core = core; this.defaults = defaults; }
  static async load(options?: CoreRuntimeOptions) { return new Ghostty(await createCoreRuntime(options)); }
  createTerminal(cols: number, rows: number, options: CoreTerminalOptions & { scrollbackLimit?: number } = {}) {
    return new GhosttyTerminal(this.core.createTerminal({ ...this.defaults, ...options, cols, rows, scrollbackLines: options.scrollbackLimit ?? options.scrollbackLines ?? this.defaults.scrollbackLines }), undefined, true);
  }
  memoryUsage() { return terminalMemoryUsage(this.core); }
  dispose() { this.core.dispose(); }
}

/** Synchronous retained-buffer access shared by the browser and projection terminals. */
export class GhosttyTerminal {
  readonly core: CoreTerminal;
  onWrite?: () => void;
  private revision = -1;
  private bufferRows = new Map<number, TerminalBufferRow>();
  private colors?: RenderColors;
  private theme?: Readonly<TerminalTheme>;
  private replies: Uint8Array[] = [];
  private input?: Disposable;
  private render: Disposable;
  private disposed = false;

  constructor(core: CoreTerminal, onWrite?: () => void, collectResponses = false) {
    this.core = core;
    this.onWrite = onWrite;
    if (collectResponses) this.input = core.on('input', event => { if (event.source === 'reply') this.replies.push(event.data.slice()); });
    this.render = core.on('render', frame => {
      this.colors = frame.colors;
      this.theme = core.theme;
    });
  }
  get cols() { return this.core.geometry.cols; }
  get rows() { return this.core.geometry.rows; }
  write(data: string | Uint8Array) { this.core.write(data); this.onWrite?.(); }
  restore(snapshot: Uint8Array) { this.core.restore(snapshot); this.onWrite?.(); }
  resize(cols: number, rows: number) { this.core.resize(cols, rows); this.onWrite?.(); }
  update() {
    const state = this.core.bufferState();
    if (state.revision !== this.revision) {
      this.revision = state.revision;
      this.bufferRows.clear();
    }
    return state;
  }
  getRevision() { return this.core.bufferState().revision; }
  getScrollbackLength() { return this.core.bufferState().scrollbackRows; }
  getViewportY() {
    const state = this.core.bufferState();
    return state.scrollbackRows - state.viewportY;
  }
  setViewportY(offset: number) {
    const current = this.getViewportY(), target = Math.max(0, Math.min(this.getScrollbackLength(), offset));
    this.core.scrollLines(current - target);
  }
  isAlternateScreen() { return this.core.bufferState().screen === 'alternate'; }
  isMode(mode: number, ansi = false) { return this.core.isMode(mode, ansi); }
  getMode(mode: number, ansi = false) { return this.isMode(mode, ansi); }
  getCursor() {
    const state = this.core.bufferState();
    return { x: state.cursorX, y: state.cursorY, visible: this.core.isMode(25) };
  }
  getColors() {
    if (!this.colors || this.theme !== this.core.theme) {
      this.theme = this.core.theme;
      this.colors = resolveTerminalTheme(this.theme);
    }
    return this.colors;
  }
  getBufferRow(index: number): TerminalBufferRow | undefined {
    const state = this.update();
    if (!Number.isInteger(index) || index < 0 || index >= state.totalRows) return;
    if (!this.bufferRows.has(index)) {
      if (this.bufferRows.size + 64 > 128) { this.bufferRows.clear(); }
      const start = Math.floor(index / 64) * 64;
      for (const row of this.core.readBuffer({ start, end: Math.min(start + 64, state.totalRows) }).rows) this.bufferRows.set(row.index, row);
    }
    return this.bufferRows.get(index);
  }
  getLine(row: number) {
    return Number.isInteger(row) && row >= 0 && row < this.rows ? this.getBufferRow(this.getScrollbackLength() + row)?.cells : undefined;
  }
  getScrollbackLine(row: number) {
    return Number.isInteger(row) && row >= 0 && row < this.getScrollbackLength() ? this.getBufferRow(row)?.cells : undefined;
  }
  /** Projection and snapshots always read the active screen, independent of viewport scrolling. */
  getViewport() {
    const history = this.getScrollbackLength(), cells: RenderCell[] = [];
    for (let row = 0; row < this.rows; row++) cells.push(...this.getBufferRow(history + row)!.cells);
    return cells;
  }
  getGraphemeString(row: number, col: number) { return this.getBufferRow(this.getScrollbackLength() + row)?.cells[col]?.text ?? ''; }
  getScrollbackGraphemeString(row: number, col: number) { return this.getBufferRow(row)?.cells[col]?.text ?? ''; }
  getHyperlinkUri(row: number, col: number) { return this.getBufferRow(this.getScrollbackLength() + row)?.cells[col]?.hyperlinkUri ?? null; }
  getScrollbackHyperlinkUri(row: number, col: number) { return this.getBufferRow(row)?.cells[col]?.hyperlinkUri ?? null; }
  readResponse() { return this.replies.shift(); }
  free() {
    if (this.disposed) return;
    this.disposed = true;
    this.input?.dispose();
    this.render.dispose();
    this.replies = [];
    this.bufferRows.clear();
    this.core.dispose();
  }
}
