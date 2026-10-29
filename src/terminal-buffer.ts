import type { RenderCell, TerminalBufferRow } from '@gespenst/core/headless';
import type { GhosttyTerminal } from './terminal-core.ts';

const cellWidth = (cell: RenderCell) => cell.width === 'wide' ? 2 : cell.width === 'narrow' ? 1 : 0;

export class TerminalBufferCell {
  private cell: RenderCell;
  constructor(cell: RenderCell) { this.cell = cell; }
  getChars() { return this.cell.text; }
  getWidth() { return cellWidth(this.cell); }
  getCodepoint() { return this.cell.text.codePointAt(0) ?? 0; }
  getHyperlinkId() { return this.cell.hyperlink ? 1 : 0; }
}

export class TerminalBufferLine {
  private row: TerminalBufferRow;
  constructor(row: TerminalBufferRow) { this.row = row; }
  get length() { return this.row.cells.length; }
  get isWrapped() { return this.row.wrapContinuation; }
  getCell(column: number) {
    const cell = this.row.cells[column];
    return cell ? new TerminalBufferCell(cell) : undefined;
  }
  translateToString(trimRight = false, startColumn = 0, endColumn = this.length) {
    const text = this.row.cells.slice(Math.max(0, startColumn), Math.min(this.length, endColumn))
      .map(cell => cellWidth(cell) ? cell.text || ' ' : '').join('');
    return trimRight ? text.trimEnd() : text;
  }
}

export function createTerminalBuffer(terminal: () => GhosttyTerminal | undefined) {
  const state = () => terminal()?.core.bufferState();
  return {
    active: {
      get length() { return state()?.totalRows ?? 0; },
      get type() { return state()?.screen ?? 'normal'; },
      get cursorX() { return state()?.cursorX ?? 0; },
      get cursorY() { return state()?.cursorY ?? 0; },
      get baseY() { return state()?.scrollbackRows ?? 0; },
      get viewportY() { return state()?.viewportY ?? 0; },
      getLine(index: number) {
        const row = terminal()?.getBufferRow(index);
        return row ? new TerminalBufferLine(row) : undefined;
      },
    },
  };
}
