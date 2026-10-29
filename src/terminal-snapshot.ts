import type { GhosttyCell } from './terminal-core.ts';
import type { Terminal } from './terminal-adapter.ts';

/** The screen rows of the last content line and the cursor, so a repaint keeps the same layout. */
export interface TerminalPicture { last: number; x: number; y: number; cursor: boolean }
const attributes = [[1, 1], [2, 3], [4, 4], [8, 9], [16, 7], [32, 8], [64, 5], [128, 2]] as const;
const decorated = 4 | 8 | 16;
const printable = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const character = (codepoint: number) => codepoint < 32 || codepoint >= 0x7f && codepoint < 0xa0 ? ' '
  : codepoint > 0x10ffff || codepoint >= 0xd800 && codepoint <= 0xdfff ? '�' : String.fromCodePoint(codepoint);
const blank = (cell: GhosttyCell) => (!cell.codepoint || cell.codepoint === 32) && !(cell.bg_r | cell.bg_g | cell.bg_b) && !(cell.flags & decorated);

function style(cell: GhosttyCell, foreground: number) {
  let codes = '0';
  for (const [flag, code] of attributes) if (cell.flags & flag) codes += ';' + code;
  if ((cell.fg_r << 16 | cell.fg_g << 8 | cell.fg_b) !== foreground) codes += `;38;2;${cell.fg_r};${cell.fg_g};${cell.fg_b}`;
  // The renderer leaves a black background unpainted, so it is the default background.
  if (cell.bg_r | cell.bg_g | cell.bg_b) codes += `;48;2;${cell.bg_r};${cell.bg_g};${cell.bg_b}`;
  return codes;
}
function row(cells: ArrayLike<GhosttyCell>, offset: number, columns: number, grapheme: (col: number) => string, foreground: number) {
  let end = columns, text = '', current = '0', previous: GhosttyCell | undefined;
  while (end > 0 && blank(cells[offset + end - 1])) end--;
  for (let col = 0; col < end; col++) {
    const cell = cells[offset + col];
    if (!cell.width) continue;
    const next = previous && cell.flags === previous.flags && cell.fg_r === previous.fg_r && cell.fg_g === previous.fg_g && cell.fg_b === previous.fg_b
      && cell.bg_r === previous.bg_r && cell.bg_g === previous.bg_g && cell.bg_b === previous.bg_b ? current : style(cell, foreground);
    previous = cell;
    if (next !== current) { text += `\x1b[${next}m`; current = next; }
    text += cell.grapheme_len ? printable(grapheme(col)) || ' ' : character(cell.codepoint);
  }
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
  const history = term.buffer.active.type === 'normal' ? terminal.getScrollbackLength() : 0, lines: string[] = [];
  for (let offset = Math.max(0, history + rows - limit); offset < history; offset++) {
    const cells = terminal.getScrollbackLine(offset);
    lines.push(cells ? row(cells, 0, Math.min(columns, cells.length), col => terminal.getScrollbackGraphemeString(offset, col), foreground) : '');
  }
  const cursor = terminal.getCursor(), screen = terminal.getViewport();
  let last = -1;
  for (let y = 0; y < rows; y++) {
    const text = row(screen, y * columns, columns, col => terminal.getGraphemeString(y, col), foreground);
    if (text) last = y;
    lines.push(text);
  }
  while (lines.at(-1) === '') lines.pop();
  const picture: TerminalPicture = { last, x: cursor.x, y: cursor.y, cursor: !!cursor.visible };
  const value = { text: lines.join('\n'), picture };
  snapshots.set(terminal, { revision, limit, columns, rows, foreground, value });
  return value;
}

export function plainText(text: string) { return text.replace(/\x1b\[[0-9;]*m/g, ''); }

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
