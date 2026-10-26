import type { Terminal } from 'ghostty-web';

interface Cell { chars: string; width: number }
interface Line { cells: Cell[]; wrapped: boolean; key: string }

/** Retain only rows whose movement is confirmed by unique, nonblank overlap. */
export class TerminalSelectionHistory {
  top = 0;
  first = 0;
  last: number;
  private visible: Line[];
  private lines = new Map<number, Line>();
  private aligned = false;
  private term: Terminal;
  constructor(term: Terminal) {
    this.term = term;
    this.last = term.rows - 1;
    this.visible = this.read();
    this.visible.forEach((line, row) => this.lines.set(row, line));
  }
  getLine(row: number) { return this.lines.get(row); }
  private read(): Line[] {
    const top = Math.max(0, this.term.buffer.active.length - this.term.rows - Math.floor(this.term.getViewportY()));
    return Array.from({ length: this.term.rows }, (_, row) => {
      const line = this.term.buffer.active.getLine(top + row);
      const cells = Array.from({ length: this.term.cols }, (_, col) => {
        const cell = line?.getCell(col);
        return { chars: cell?.getChars() || ' ', width: cell?.getWidth() ?? 1 };
      });
      return { cells, wrapped: line?.isWrapped ?? false, key: JSON.stringify(cells) };
    });
  }
  update(direction: number, anchor: number): 'unchanged' | 'moved' | 'ambiguous' | 'fixed' | 'limit' {
    const next = this.read(), previous = this.visible;
    if (next.every((line, row) => line.key === previous[row]?.key)) return 'unchanged';
    let first = this.aligned ? this.first : 0, last = this.aligned ? this.last : next.length - 1;
    if (this.aligned) {
      if (next.some((line, row) => (row < first || row > last) && line.key !== previous[row]?.key)) return 'ambiguous';
    } else {
      while (first <= last && next[first].key === previous[first]?.key) first++;
      while (last >= first && next[last].key === previous[last]?.key) last--;
    }
    const unique = (lines: Line[], key: string) => lines.filter(line => line.key === key).length === 1;
    const candidates: { shift: number; count: number }[] = [];
    for (let distance = 1; distance < last - first; distance++) {
      const shift = Math.sign(direction) * distance;
      let count = 0, valid = true;
      for (let row = first; row <= last; row++) {
        const old = row + shift;
        if (old < first || old > last) continue;
        if (next[row].key !== previous[old].key) { valid = false; break; }
        if (next[row].cells.some(cell => cell.width && cell.chars.trim()) && unique(previous, next[row].key) && unique(next, next[row].key)) count++;
      }
      if (valid && count >= 2) candidates.push({ shift, count });
    }
    if (candidates.length !== 1) return 'ambiguous';
    if (!this.aligned && anchor >= this.top && anchor < this.top + this.term.rows && (anchor < this.top + first || anchor > this.top + last)) return 'fixed';
    const top = this.top + candidates[0].shift;
    for (let row = first; row <= last; row++) {
      const retained = this.lines.get(top + row);
      const content = this.aligned || top + row >= this.top + first && top + row <= this.top + last;
      if (content && retained && retained.key !== next[row].key) return 'ambiguous';
    }
    const added = next.filter((_, row) => row >= first && row <= last && !this.lines.has(top + row)).length;
    if (this.lines.size + added > Math.min(10000, Math.floor(1000000 / this.term.cols))) return 'limit';
    if (!this.aligned) {
      for (const row of this.lines.keys()) if (row < this.top + first || row > this.top + last) this.lines.delete(row);
      this.aligned = true;
    }
    this.top = top;
    this.first = first; this.last = last;
    this.visible = next;
    for (let row = first; row <= last; row++) this.lines.set(this.top + row, next[row]);
    return 'moved';
  }
}
