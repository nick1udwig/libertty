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

export interface GhosttyCell {
  codepoint: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  flags: number;
  width: number;
  grapheme_len: number;
  hyperlink_id: number;
}

export class Ghostty {
  readonly core: CoreRuntime;
  private defaults: CoreTerminalOptions;
  constructor(core: CoreRuntime, defaults: CoreTerminalOptions = {}) { this.core = core; this.defaults = defaults; }
  static async load(options?: CoreRuntimeOptions) { return new Ghostty(await createCoreRuntime(options)); }
  createTerminal(cols: number, rows: number, options: CoreTerminalOptions & { scrollbackLimit?: number } = {}) {
    return new GhosttyTerminal(this.core.createTerminal({ ...this.defaults, ...options, cols, rows, scrollbackLines: options.scrollbackLimit ?? options.scrollbackLines ?? this.defaults.scrollbackLines }), undefined, true);
  }
  dispose() { this.core.dispose(); }
}

/** Synchronous retained-buffer access shared by the browser and projection terminals. */
export class GhosttyTerminal {
  readonly core: CoreTerminal;
  onWrite?: () => void;
  private revision = -1;
  private bufferRows = new Map<number, TerminalBufferRow>();
  private cells = new Map<number, GhosttyCell[]>();
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
      this.cells.clear();
    });
  }
  get cols() { return this.core.geometry.cols; }
  get rows() { return this.core.geometry.rows; }
  write(data: string | Uint8Array) { this.core.write(data); this.onWrite?.(); }
  resize(cols: number, rows: number) { this.core.resize(cols, rows); this.onWrite?.(); }
  update() {
    const state = this.core.bufferState();
    if (state.revision !== this.revision) {
      this.revision = state.revision;
      this.bufferRows.clear();
      this.cells.clear();
    }
    return state;
  }
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
      this.cells.clear();
    }
    return this.colors;
  }
  getBufferRow(index: number): TerminalBufferRow | undefined {
    const state = this.update();
    if (!Number.isInteger(index) || index < 0 || index >= state.totalRows) return;
    if (!this.bufferRows.has(index)) {
      if (this.bufferRows.size + 64 > 128) { this.bufferRows.clear(); this.cells.clear(); }
      const start = Math.floor(index / 64) * 64;
      for (const row of this.core.readBuffer({ start, end: Math.min(start + 64, state.totalRows) }).rows) this.bufferRows.set(row.index, row);
    }
    return this.bufferRows.get(index);
  }
  private bufferLine(index: number) {
    const row = this.getBufferRow(index);
    if (!row) return undefined;
    let cells = this.cells.get(index);
    if (!cells) {
      const foreground = this.getColors().foreground;
      cells = row.cells.map(cell => this.cell(cell, foreground));
      this.cells.set(index, cells);
    }
    return cells;
  }
  private cell(cell: RenderCell, foreground: RenderColors['foreground']): GhosttyCell {
    const fg = cell.foreground ?? foreground, bg = cell.background;
    const style = cell.style, length = Array.from(cell.text).length;
    return {
      codepoint: cell.text.codePointAt(0) ?? 0,
      fg_r: fg.r, fg_g: fg.g, fg_b: fg.b,
      bg_r: bg?.r ?? 0, bg_g: bg?.g ?? 0, bg_b: bg?.b ?? 0,
      flags: +style.bold | +style.italic << 1 | +(style.underline !== 0) << 2 | +style.strikethrough << 3
        | +style.inverse << 4 | +style.invisible << 5 | +style.blink << 6 | +style.faint << 7,
      width: cell.width === 'wide' ? 2 : cell.width === 'narrow' ? 1 : 0,
      grapheme_len: length > 1 ? length : 0,
      hyperlink_id: cell.hyperlink ? 1 : 0,
    };
  }
  getLine(row: number) {
    return Number.isInteger(row) && row >= 0 && row < this.rows ? this.bufferLine(this.getScrollbackLength() + row) : undefined;
  }
  getScrollbackLine(row: number) {
    return Number.isInteger(row) && row >= 0 && row < this.getScrollbackLength() ? this.bufferLine(row) : undefined;
  }
  /** Projection and snapshots always read the active screen, independent of viewport scrolling. */
  getViewport() {
    const history = this.getScrollbackLength(), cells: GhosttyCell[] = [];
    for (let row = 0; row < this.rows; row++) cells.push(...this.bufferLine(history + row)!);
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
    this.cells.clear();
    this.core.dispose();
  }
}
