import type { CellColor, RenderCell, RenderColor } from '@gespenst/core/headless';
import type { Terminal } from './terminal-adapter.ts';

/** The screen rows of the last content line and the cursor, so a repaint keeps the same layout. */
export interface TerminalPicture { last: number; x: number; y: number; cursor: boolean }
const attributes = [['bold', 1], ['faint', 2], ['italic', 3], ['blink', 5], ['inverse', 7], ['invisible', 8], ['strikethrough', 9], ['overline', 53]] as const;
const printable = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const blank = (cell: RenderCell) => (!cell.text || cell.text === ' ' || cell.text === '\0') && (!cell.backgroundSource || cell.backgroundSource.mode === 'default')
  && !cell.background && !cell.style.underline && !cell.style.strikethrough && !cell.style.overline && !cell.style.inverse && !cell.hyperlinkUri;

function color(code: number, source: CellColor | undefined, palette: readonly RenderColor[], resolved?: RenderColor | null) {
  if (source?.mode === 'default') return '';
  const value = source?.mode === 'palette' ? palette[source.value] : source?.mode === 'rgb' ? source.value : resolved;
  return value ? `;${code};2;${value.r};${value.g};${value.b}` : '';
}
function style(cell: RenderCell, palette: readonly RenderColor[]) {
  let codes = '0';
  for (const [attribute, code] of attributes) if (cell.style[attribute]) codes += ';' + code;
  if (cell.style.underline) codes += ';4:' + cell.style.underline;
  return codes + color(38, cell.foregroundSource, palette, cell.foreground) + color(48, cell.backgroundSource, palette, cell.background) + color(58, cell.underlineSource, palette);
}
function row(cells: readonly RenderCell[], columns: number, palette: readonly RenderColor[]) {
  let end = Math.min(columns, cells.length), text = '', current = '0', hyperlink = '', previous: RenderCell | undefined;
  while (end > 0 && blank(cells[end - 1])) end--;
  for (const cell of cells.slice(0, end)) {
    if (cell.width !== 'narrow' && cell.width !== 'wide') continue;
    const next = previous?.style === cell.style && previous.foregroundSource === cell.foregroundSource
      && previous.backgroundSource === cell.backgroundSource && previous.underlineSource === cell.underlineSource ? current : style(cell, palette);
    previous = cell;
    const uri = cell.hyperlinkUri?.replace(/[\x00-\x1f\x7f-\x9f]/g, '') ?? '';
    if (uri !== hyperlink) { text += `\x1b]8;;${uri}\x1b\\`; hyperlink = uri; }
    if (next !== current) { text += `\x1b[${next}m`; current = next; }
    text += printable(cell.text) || ' ';
  }
  if (hyperlink) text += '\x1b]8;;\x1b\\';
  return current === '0' ? text : text + '\x1b[0m';
}

type Snapshot = { text: string; picture: TerminalPicture };
const snapshots = new WeakMap<object, { revision: number; limit: number; columns: number; rows: number; foreground: number; value: Snapshot }>();
export function invalidateSnapshot(term: Terminal) { if (term.wasmTerm) snapshots.delete(term.wasmTerm); }

/** Styled rows that repaint through the same renderer; each row starts from default attributes. */
export function terminalSnapshot(term: Terminal, limit = 5000) {
  const terminal = term.wasmTerm!, columns = terminal.cols, rows = terminal.rows;
  const colors = terminal.getColors().foreground, foreground = colors.r << 16 | colors.g << 8 | colors.b;
  const revision = terminal.getRevision(), cached = snapshots.get(terminal);
  if (cached && cached.revision === revision && cached.limit === limit && cached.columns === columns && cached.rows === rows && cached.foreground === foreground) return cached.value;
  const palette = terminal.getPalette();
  const history = term.buffer.active.type === 'normal' ? terminal.getScrollbackLength() : 0, lines: string[] = [];
  for (let offset = Math.max(0, history + rows - limit); offset < history; offset++) {
    const cells = terminal.getScrollbackLine(offset);
    lines.push(cells ? row(cells, columns, palette) : '');
  }
  const cursor = terminal.getCursor();
  let last = -1;
  for (let y = 0; y < rows; y++) {
    const text = row(terminal.getLine(y) ?? [], columns, palette);
    if (text) last = y;
    lines.push(text);
  }
  while (lines.at(-1) === '') lines.pop();
  const picture: TerminalPicture = { last, x: cursor.x, y: cursor.y, cursor: !!cursor.visible };
  const value = { text: lines.join('\n'), picture };
  snapshots.set(terminal, { revision, limit, columns, rows, foreground, value });
  return value;
}

export function plainText(text: string) { return text.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;:]*m/g, ''); }

/** Repaint retained rows in a reset terminal with the original screen layout and reading position.
 * Earlier records scroll above the screen, so the last line returns to its original row. */
export function paintSnapshot(term: Terminal, text: string, picture: TerminalPicture, position: number) {
  const rows = term.rows, target = Math.min(rows - 1, picture.last), lead = Math.max(0, target - text.split('\n').length + 1);
  term.write('\x1bc\x1b[3J\x1b[2J\x1b[H\x1b[?25l' + '\r\n'.repeat(lead) + text.replaceAll('\n', '\r\n'));
  const shift = term.wasmTerm!.getCursor().y - target;
  const y = Math.max(0, Math.min(rows - 1, target + picture.y - picture.last)), x = Math.max(0, Math.min(term.cols - 1, picture.x));
  term.write((shift > 0 ? `\x1b[${rows};1H` + '\n'.repeat(shift) : '') + `\x1b[${y + 1};${x + 1}H` + (picture.cursor ? '\x1b[?25h' : ''));
  term.scrollToLine(position);
}
