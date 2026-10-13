import type { Ghostty, GhosttyTerminal, Terminal } from 'ghostty-web';
import { preserveScrollback } from './terminal-viewport.ts';

const tokens = (text: string) => text.match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|.)|[^\x1b]/gu) || [];
const absoluteRow = (terminal: GhosttyTerminal) => terminal.getScrollbackLength() + terminal.getCursor().y;
const rowText = (terminal: GhosttyTerminal, row: number) => {
  const history = terminal.getScrollbackLength();
  const cells = row < history ? terminal.getScrollbackLine(row) : terminal.getLine(row - history);
  return (cells || []).map((cell, col) => cell.width === 0 ? '' : row < history
    ? terminal.getScrollbackGraphemeString(row, col) || ' ' : terminal.getGraphemeString(row - history, col) || ' ').join('').replaceAll('\0', ' ').trimEnd();
};
const viewportText = (terminal: GhosttyTerminal) => {
  const cells = terminal.getViewport(), rows: string[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    let text = '';
    for (let col = 0; col < terminal.cols; col++) {
      const cell = cells[row * terminal.cols + col];
      if (!cell.width) continue;
      text += cell.grapheme_len > 1 ? terminal.getGraphemeString(row, col)?.replaceAll('\0', ' ') || ' '
        : cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' ';
    }
    rows.push(text.trimEnd());
  }
  return rows;
};

/** Matching mobile TUI grids consume Herdr's live ANSI frames. Shell history
 * and differently sized observers keep the reflowed history projection. */
export class TerminalProjection {
  private previous = '';
  private initialized = false;
  private term: Terminal;
  private ghostty: Ghostty;
  private native?: GhosttyTerminal;
  private history?: GhosttyTerminal;
  private probe?: GhosttyTerminal;
  private local?: GhosttyTerminal;
  private starts: number[] = [];
  private lines: string[] = [];
  private cursorControl = '\x1b[?25l';
  private mobile = false;
  private live = false;
  private complete = false;
  private awaitingFrame = false;
  private columns: number;
  private rows: number;
  constructor(term: Terminal, ghostty: Ghostty) {
    this.term = term; this.ghostty = ghostty; this.columns = term.cols; this.rows = term.rows;
    term.write('\x1b[?25l');
  }
  get nativeColumns() { return this.native?.cols; }
  update(text: string, reflow = false) {
    // Exported rows end with a delimiter; it is not an additional terminal row.
    const normalized = text.replace(/\r?\n/g, '\r\n').replace(/\r\n$/, '');
    if (!reflow && this.initialized && normalized === this.previous) return;
    this.previous = normalized; this.initialized = true;
    this.rebuild();
    // History reads can arrive after a newer frame. Cache them for fallback,
    // but never replace the live TUI with an older polled snapshot.
    if (this.live && this.canRenderLive()) return;
    this.paint();
  }
  frame(frame: { width: number; height: number; full: boolean; bytes: string | Uint8Array }) {
    const wasLive = this.live;
    if (!frame.width || !frame.height) {
      this.native?.free(); this.native = undefined; this.complete = this.live = this.awaitingFrame = false;
      this.cursorControl = ''; this.hide(); return false;
    }
    if (!this.native || this.native.cols !== frame.width || this.native.rows !== frame.height) {
      this.complete = this.live = this.awaitingFrame = false;
      if (this.native) this.native.resize(frame.width, frame.height); else this.native = this.ghostty.createTerminal(frame.width, frame.height);
      this.rebuild();
    }
    const bytes = typeof frame.bytes === 'string' ? Uint8Array.from(atob(frame.bytes), c => c.charCodeAt(0)) : frame.bytes;
    if (frame.full) { this.native.write('\x1bc\x1b[2J\x1b[H'); this.awaitingFrame = false; }
    this.native.write(bytes);
    this.complete ||= frame.full;
    if (this.canRenderLive() && (this.live || frame.full)) {
      preserveScrollback(this.term, () => {
        // Reset only when entering the stream. Subsequent full frames and
        // deltas retain the shared terminal's selection and hyperlink state.
        if (!this.live) this.term.write('\x1bc\x1b[3J\x1b[2J\x1b[H');
        else if (frame.full) this.term.write('\x1b[0m\x1b[2J\x1b[H');
        this.term.write(bytes);
      });
      this.live = true; this.cursorControl = '';
      return true;
    }
    if (wasLive) this.paint();
    this.cursor(this.nativePosition());
    return false;
  }
  /** Paint the certified native baseline before exposing a previously hidden canvas. */
  paintBaseline() {
    if (this.native && this.live && this.canRenderLive()) this.term.renderer?.render(this.native, true, 0, this.term);
  }
  private canRenderLive() {
    return this.mobile && this.complete && this.native?.cols === this.term.cols && this.native.rows === this.term.rows
      && (!this.initialized || this.history?.getScrollbackLength() === 0);
  }
  /** One complete baseline is needed when joining a stream or leaving history. */
  requestFrame() {
    if (this.live || this.awaitingFrame || !this.mobile || this.native?.cols !== this.term.cols || this.native.rows !== this.term.rows
      || this.initialized && this.history?.getScrollbackLength() !== 0) return false;
    this.awaitingFrame = true; return true;
  }
  private rebuild() {
    const columns = this.nativeColumns;
    if (!columns || !this.initialized) return;
    const rows = this.native?.rows || 24;
    this.history ||= this.ghostty.createTerminal(columns, rows, { scrollbackLimit: 10000 });
    this.history.resize(columns, rows);
    this.history.write('\x1bc\x1b[3J\x1b[2J\x1b[H');
    this.lines = this.previous.split('\r\n'); this.starts = [];
    for (let i = 0; i < this.lines.length; i++) {
      this.starts.push(absoluteRow(this.history)); if (this.lines[i]) this.history.write(this.lines[i]);
      if (i < this.lines.length - 1) this.history.write('\r\n');
    }
  }
  private paint() {
    this.live = false;
    if (!this.initialized) { this.hide(); return; }
    const point = this.nativePosition();
    preserveScrollback(this.term, () => this.term.write('\x1bc\x1b[3J\x1b[2J\x1b[H\x1b[?25l' + this.previous + '\x1b[?25l'));
    this.cursorControl = '\x1b[?25l';
    this.cursor(point);
  }
  private writeCursor(control: string) {
    if (control === this.cursorControl) return;
    this.cursorControl = control;
    preserveScrollback(this.term, () => this.term.write(control));
  }
  private hide() { this.writeCursor('\x1b[?25l'); }
  private nativePosition() {
    const native = this.native, history = this.history;
    if (!native || !history || !native.getCursor().visible) return;
    const cursor = native.getCursor();
    // Fetch each viewport once. A large observer must not copy the entire WASM
    // grid again for every row while aligning the caret.
    const nativeRows = viewportText(native), historyRows = viewportText(history), saved = history.getScrollbackLength();
    const historyText = (row: number) => row < saved ? rowText(history, row) : historyRows[row - saved];
    // Align the last content row, then verify the overlapping native viewport.
    // During a repaint the two read-only streams may briefly differ: hide until
    // they agree instead of displaying a guessed cursor at the end of history.
    let nativeTail = native.rows - 1, historyTail = history.getScrollbackLength() + history.rows - 1;
    while (nativeTail >= 0 && !nativeRows[nativeTail]) nativeTail--;
    while (historyTail >= 0 && !historyText(historyTail)) historyTail--;
    if (nativeTail < 0 || historyTail < 0) return;
    const origin = historyTail - nativeTail;
    for (let row = 0; row < native.rows; row++) {
      const mapped = origin + row;
      if (mapped < 0 || mapped >= history.getScrollbackLength() + history.rows) continue;
      if (nativeRows[row] !== historyText(mapped)) return;
    }
    const target = origin + cursor.y;
    if (target >= 0) return { row: target, x: cursor.x };
  }
  private cursor(point: { row: number; x: number } | undefined) {
    const native = this.native, history = this.history;
    if (!point || !native || !history) { this.hide(); return; }
    const target = point.row, cursor = { x: point.x };
    let index = this.starts.findLastIndex(start => start <= target);
    if (index < 0) { this.hide(); return; }
    const probe = this.probe ||= this.ghostty.createTerminal(history.cols, 2, { scrollbackLimit: 10000 });
    probe.resize(history.cols, 2); probe.write('\x1bc\x1b[3J\x1b[2J\x1b[H');
    let prefix = '', reached = false;
    {
      const parts = tokens(this.lines[index]);
      for (const part of parts) {
        const before = { x: probe.getCursor().x, row: absoluteRow(probe) };
        if (!reached && before.row === target - this.starts[index] && before.x === cursor.x) reached = true;
        if (reached) break;
        probe.write(part);
        // A pending soft wrap places the next glyph at column zero. Keep that
        // glyph out of the measured prefix at the native wrap boundary.
        if (absoluteRow(probe) > before.row && absoluteRow(probe) === target - this.starts[index] && cursor.x === 0) {
          reached = true;
        } else prefix += part;
      }
      if (!reached) {
        const rows = Math.max(0, target - this.starts[index] - absoluteRow(probe));
        if (rows) { prefix += '\r\n'.repeat(rows); probe.write('\r\n'.repeat(rows)); }
        prefix += ' '.repeat(Math.max(0, cursor.x - probe.getCursor().x));
      }
    }
    const before = this.lines.slice(0, index).join('\r\n') + (index ? '\r\n' : '') + prefix;
    const local = this.local ||= this.ghostty.createTerminal(this.term.cols, this.term.rows, { scrollbackLimit: 5000 });
    local.resize(this.term.cols, this.term.rows);
    {
      local.write('\x1bc\x1b[3J\x1b[2J\x1b[H');
      if (before) local.write(before);
      const position = { x: local.getCursor().x, row: absoluteRow(local) };
      // Resolve Ghostty's pending-wrap cursor without altering the projected
      // text. This also handles a wide or combining glyph immediately after it.
      local.write(' ');
      if (absoluteRow(local) > position.row) { position.row = absoluteRow(local); position.x = 0; }
      local.write('\x1bc\x1b[3J\x1b[2J\x1b[H');
      if (this.previous) local.write(this.previous);
      const y = position.row - local.getScrollbackLength();
      this.writeCursor(y >= 0 && y < this.term.rows
        ? '\x1b[' + (y + 1) + ';' + (position.x + 1) + 'H\x1b[?25h' : '\x1b[?25l');
    }
  }
  resize(mobile = this.mobile) {
    if (this.mobile === mobile && this.columns === this.term.cols && this.rows === this.term.rows) return;
    this.mobile = mobile; this.columns = this.term.cols; this.rows = this.term.rows; this.live = this.awaitingFrame = false;
    if (this.initialized) this.update(this.previous, true);
  }
  dispose() { this.native?.free(); this.history?.free(); this.probe?.free(); this.local?.free(); }
}
