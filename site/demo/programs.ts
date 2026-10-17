import type { Program } from './commands.ts';
import type { Shell } from './shell.ts';
import { display, write } from './vfs.ts';

const tokens = (line: string) => line.match(/\x1b\[[0-9;]*m|[\s\S]/gu) || [];
/** Split a line into rows of at most `width` visible characters, keeping its colors. */
export function wrap(line: string, width: number) {
  const rows: string[] = []; let row = '', used = 0;
  for (const token of tokens(line.replace(/\t/g, '    '))) {
    if (token.startsWith('\x1b')) { row += token; continue; }
    if (used === width) { rows.push(row); row = ''; used = 0; }
    row += token; used++;
  }
  rows.push(row);
  return rows;
}
const keys = /\x1b\[[0-9;]*[@-~]|\x1bO[@-~]|\x1b|[\s\S]/g;

/** Page through text like less, with q to quit. */
export function pager(shell: Shell, value: string, label: string): Program {
  const lines = value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let rows: string[] = [], top = 0;
  const layout = () => { rows = lines.flatMap(line => wrap(line, shell.cols)); top = Math.min(top, Math.max(0, rows.length - (shell.rows - 1))); };
  const draw = () => {
    const height = shell.rows - 1, end = top + height >= rows.length;
    let out = '\x1b[H\x1b[2J';
    for (let i = 0; i < height; i++) out += (rows[top + i] ?? '\x1b[1;34m~\x1b[0m') + '\x1b[0m' + (i < height - 1 ? '\r\n' : '');
    out += `\r\n\x1b[7m${end ? '(END)' : label ? label : ':'}\x1b[0m\x1b[K`;
    shell.write(out);
  };
  const move = (delta: number) => { top = Math.max(0, Math.min(Math.max(0, rows.length - (shell.rows - 1)), top + delta)); draw(); };
  return {
    start() { layout(); shell.write('\x1b[?1049h'); draw(); },
    resize() { layout(); draw(); },
    paste() {},
    input(data) {
      for (const key of data.match(keys) || []) {
        const page = shell.rows - 1;
        if (key === 'q' || key === 'Q' || key === '\x03') { shell.write('\x1b[?1049l'); shell.finished(); return; }
        if (['j', '\r', '\x1b[B', 'e', '\x0e'].includes(key)) move(1);
        else if (['k', '\x1b[A', 'y', '\x10'].includes(key)) move(-1);
        else if ([' ', 'f', '\x1b[6~', '\x06'].includes(key)) move(page);
        else if (['b', '\x1b[5~', '\x02'].includes(key)) move(-page);
        else if (key === 'd' || key === '\x04') move(Math.floor(page / 2));
        else if (key === 'u' || key === '\x15') move(-Math.floor(page / 2));
        else if (key === 'g' || key === '<') move(-rows.length);
        else if (key === 'G' || key === '>') move(rows.length);
      }
    },
  };
}

/** A small modal editor in the spirit of vi: hjkl, i/a/o, x, dd, gg/G and :w, :q, :wq, :q!. */
export function editor(shell: Shell, path: string | undefined, value: string, existing: boolean): Program {
  const lines = value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let row = 0, column = 0, top = 0, mode: 'normal' | 'insert' | 'command' = 'normal', command = '', pending = '', dirty = false;
  const name = path ? display(path).replace(display(shell.cwd) + '/', '') : '[No Name]';
  let message = path ? `"${name}"${existing ? ` ${lines.length}L, ${new TextEncoder().encode(value).length}B` : ' [New]'}` : '';
  const height = () => shell.rows - 1;
  const span = (line: string) => Math.max(1, Math.ceil(line.length / shell.cols));
  const clamp = () => {
    row = Math.max(0, Math.min(lines.length - 1, row));
    column = Math.max(0, Math.min(lines[row].length - (mode === 'insert' ? 0 : 1), column));
    if (row < top) top = row;
    for (;;) {
      let used = 0;
      for (let i = top; i <= row; i++) used += i === row ? Math.floor(column / shell.cols) + 1 : span(lines[i]);
      if (used <= height() || top === row) break;
      top++;
    }
  };
  const draw = () => {
    clamp();
    let out = '\x1b[?25l\x1b[H\x1b[2J', used = 0, cursor = 0;
    for (let i = top; used < height(); i++) {
      if (i >= lines.length) { out += '\x1b[1;34m~\x1b[0m' + (used < height() - 1 ? '\r\n' : ''); used++; continue; }
      if (i === row) cursor = used + Math.floor(column / shell.cols);
      for (const part of wrap(lines[i], shell.cols)) {
        if (used >= height()) break;
        out += part + (used < height() - 1 ? '\r\n' : ''); used++;
      }
    }
    const status = mode === 'command' ? ':' + command : mode === 'insert' ? '\x1b[1m-- INSERT --\x1b[0m' : message;
    const position = `${row + 1},${column + 1}`;
    out += `\r\n${status}\x1b[K` + (mode === 'command' ? '' : `\x1b[${shell.rows};${Math.max(1, shell.cols - position.length - 5)}H${position}`);
    out += mode === 'command' ? '\x1b[?25h' : `\x1b[${cursor + 1};${column % shell.cols + 1}H\x1b[?25h`;
    shell.write(out);
  };
  const quit = () => { shell.write('\x1b[?1049l'); shell.finished(); };
  const save = () => {
    if (!path) { message = 'E32: No file name'; return false; }
    try { write(path, lines.join('\n') + '\n'); dirty = false; message = `"${name}" ${lines.length}L written`; return true; }
    catch (error) { message = `"${name}" E212: ${(error as Error).message}`; return false; }
  };
  const run = () => {
    const text = command.trim(); mode = 'normal'; command = '';
    if (/^\d+$/.test(text)) { row = Number(text) - 1; column = 0; return; }
    if (text === 'q') { if (dirty) message = 'E37: No write since last change (add ! to override)'; else return quit(); }
    else if (text === 'q!' ) return quit();
    else if (text === 'w') save();
    else if (text === 'wq' || text === 'x') { if (save()) return quit(); }
    else if (text) message = `E492: Not an editor command: ${text}`;
  };
  const edit = (change: () => void) => { change(); dirty = true; };
  const normal = (key: string) => {
    const sequence = pending + key; pending = '';
    if (sequence === 'g') { pending = 'g'; return; }
    if (sequence === 'd') { pending = 'd'; return; }
    if (sequence === 'gg') { row = 0; column = 0; return; }
    if (sequence === 'dd') { edit(() => { lines.splice(row, 1); if (!lines.length) lines.push(''); }); return; }
    switch (key) {
      case 'h': case '\x1b[D': column--; break;
      case 'l': case '\x1b[C': column++; break;
      case 'j': case '\x1b[B': case '\r': row++; break;
      case 'k': case '\x1b[A': row--; break;
      case '0': case '\x1b[H': column = 0; break;
      case '$': case '\x1b[F': column = lines[row].length; break;
      case 'G': row = lines.length - 1; break;
      case 'w': { const match = /\s\S/.exec(lines[row].slice(column)); if (match) column += match.index + 1; else { row++; column = 0; } break; }
      case 'b': { const before = lines[row].slice(0, column).replace(/\S+\s*$/, ''); column = before.length; break; }
      case '\x06': row += height(); top = row; break;
      case '\x02': row -= height(); top = Math.max(0, row); break;
      case '\x04': row += Math.floor(height() / 2); break;
      case '\x15': row -= Math.floor(height() / 2); break;
      case 'x': edit(() => { lines[row] = lines[row].slice(0, column) + lines[row].slice(column + 1); }); break;
      case 'i': mode = 'insert'; break;
      case 'I': mode = 'insert'; column = lines[row].search(/\S|$/); break;
      case 'a': mode = 'insert'; column++; break;
      case 'A': mode = 'insert'; column = lines[row].length; break;
      case 'o': edit(() => { lines.splice(row + 1, 0, ''); }); row++; column = 0; mode = 'insert'; break;
      case 'O': edit(() => { lines.splice(row, 0, ''); }); column = 0; mode = 'insert'; break;
      case ':': mode = 'command'; command = ''; message = ''; break;
      case '\x1b': message = ''; break;
    }
  };
  const insert = (key: string) => {
    if (key === '\x1b') { mode = 'normal'; column--; return; }
    if (key === '\r') { edit(() => { lines.splice(row + 1, 0, lines[row].slice(column)); lines[row] = lines[row].slice(0, column); }); row++; column = 0; return; }
    if (key === '\x7f' || key === '\b') {
      if (column) edit(() => { lines[row] = lines[row].slice(0, column - 1) + lines[row].slice(column); column--; });
      else if (row) edit(() => { column = lines[row - 1].length; lines[row - 1] += lines[row]; lines.splice(row, 1); row--; });
      return;
    }
    if (key.startsWith('\x1b')) { normal(key); return; }
    if (key >= ' ') edit(() => { lines[row] = lines[row].slice(0, column) + key + lines[row].slice(column); column += key.length; });
  };
  return {
    start() { shell.write('\x1b[?1049h'); draw(); },
    resize() { draw(); },
    paste(text) { if (mode !== 'insert') mode = 'insert'; for (const char of text.replace(/\r?\n/g, '\r')) insert(char); draw(); },
    input(data) {
      for (const key of data.match(keys) || []) {
        if (mode === 'command') {
          if (key === '\r') run();
          else if (key === '\x1b' || key === '\x03') { mode = 'normal'; command = ''; }
          else if (key === '\x7f' || key === '\b') { if (command) command = command.slice(0, -1); else mode = 'normal'; }
          else if (key >= ' ' && !key.startsWith('\x1b')) command += key;
          if (!shell.busy(this)) return;
        } else if (mode === 'insert') insert(key);
        else normal(key);
      }
      draw();
    },
  };
}
