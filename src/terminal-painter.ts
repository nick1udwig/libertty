import type {
  Frame,
  RenderCell,
  RenderColor,
  RenderRow,
  ViewportSnapshot,
} from './terminal-types.ts';
export interface ScreenMetrics {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  devicePixelRatio: number;
  fontSize: number;
  fontFamily: string;
}
const css = (c: RenderColor) => `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})`;
const colors = (cell: RenderCell, frame: ViewportSnapshot) =>
  cell.style.inverse
    ? {
        fg: cell.background ?? frame.colors.background,
        bg: cell.foreground ?? frame.colors.foreground,
      }
    : {
        fg: cell.foreground ?? frame.colors.foreground,
        bg: cell.background ?? frame.colors.background,
      };
const selected = (row: RenderRow, x: number) =>
  !!row.selection && x >= row.selection.start && x < row.selection.end;
const powerline = (text: string) => /^[\ue0b0-\ue0b3]$/.test(text);
function paintPowerline(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  line: number,
) {
  const left = text === '\ue0b2' || text === '\ue0b3',
    outline = text === '\ue0b1' || text === '\ue0b3';
  context.beginPath();
  context.moveTo(x + (left ? width : 0), y);
  context.lineTo(x + (left ? 0 : width), y + height / 2);
  context.lineTo(x + (left ? width : 0), y + height);
  if (outline) {
    context.lineWidth = line;
    context.strokeStyle = context.fillStyle;
    context.stroke();
  } else {
    context.closePath();
    context.fill();
  }
}

export class BackgroundPainter {
  private context: CanvasRenderingContext2D;
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('Canvas 2D is required');
    this.context = context;
  }
  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
  }
  render(
    frame: ViewportSnapshot,
    metrics: ScreenMetrics,
    _blinkVisible: boolean,
    focused: boolean,
  ) {
    const c = this.context,
      { width, height, cellWidth: w, cellHeight: h } = metrics;
    c.clearRect(0, 0, width, height);
    c.fillStyle = css(frame.colors.background);
    c.fillRect(0, 0, width, height);
    for (const row of frame.viewportRows)
      for (const cell of row.cells) {
        const selection = selected(row, cell.x);
        if (!cell.background && !cell.style.inverse && !selection) continue;
        c.fillStyle = css(
          selection
            ? focused
              ? frame.colors.selectionBackground
              : frame.colors.selectionInactiveBackground
            : colors(cell, frame).bg,
        );
        c.fillRect(cell.x * w, row.y * h, w, h);
      }
    const cursor = frame.cursor;
    if (!cursor.visible || cursor.x === null || cursor.y === null) return;
    const x = cursor.x * w,
      y = cursor.y * h,
      line = Math.max(1, metrics.devicePixelRatio);
    c.fillStyle = css(frame.colors.cursor ?? frame.colors.foreground);
    if (cursor.style === 'bar') c.fillRect(x, y, line, h);
    else if (cursor.style === 'underline') c.fillRect(x, y + h - 2 * line, w, 2 * line);
    else if (cursor.style === 'block-hollow') {
      c.fillRect(x, y, w, line);
      c.fillRect(x, y + h - line, w, line);
      c.fillRect(x, y, line, h);
      c.fillRect(x + w - line, y, line, h);
    } else c.fillRect(x, y, w, h);
  }
}
/** Paints native damage while the adapter owns scheduling and the scroll ring. */
export class TerminalPainter {
  readonly background: BackgroundPainter;
  focused = false;
  private context: CanvasRenderingContext2D;
  private rows = new Map<number, RenderRow>();
  private lastCursor: number | null = null;
  private sized = false;
  readonly text: HTMLCanvasElement;
  metrics: ScreenMetrics;
  constructor(background: HTMLCanvasElement, text: HTMLCanvasElement, metrics: ScreenMetrics) {
    this.text = text;
    this.metrics = metrics;
    this.background = new BackgroundPainter(background);
    const c = text.getContext('2d');
    if (!c) throw new Error('Canvas 2D is required');
    this.context = c;
  }
  resize(metrics: ScreenMetrics) {
    this.metrics = metrics;
    this.sized = false;
    this.rows.clear();
    this.lastCursor = null;
  }
  setFocused(focused: boolean) {
    this.focused = focused;
  }
  render(frame: Frame) {
    const full = 'viewportRows' in frame || frame.dirty === 'full';
    const changed = 'viewportRows' in frame ? frame.viewportRows : frame.changedRows;
    if (full) this.rows.clear();
    for (const row of changed) this.rows.set(row.y, row);
    const damage = new Set(changed.map((row) => row.y));
    if (this.lastCursor !== null) damage.add(this.lastCursor);
    if (frame.cursor.y !== null) damage.add(frame.cursor.y);
    this.lastCursor = frame.cursor.y;
    this.paint({ ...frame, viewportRows: [...this.rows.values()] }, damage);
  }
  paint(frame: ViewportSnapshot, damage: ReadonlySet<number>) {
    const m = this.metrics,
      c = this.context,
      w = m.cellWidth,
      h = m.cellHeight;
    if (!this.sized) {
      this.sized = true;
      this.background.resize(m.width, m.height);
      this.text.width = m.width;
      this.text.height = m.height;
    }
    this.background.render(frame, m, true, this.focused);
    c.textBaseline = 'alphabetic';
    const appearance = (cell: RenderCell, row: RenderRow) => {
      const fg = colors(cell, frame).fg;
      const cursor =
        frame.cursor.visible &&
        frame.cursor.style === 'block' &&
        frame.cursor.x === cell.x &&
        frame.cursor.y === row.y;
      return css(
        cursor
          ? frame.colors.cursorAccent
          : selected(row, cell.x)
            ? (frame.colors.selectionForeground ?? fg)
            : fg,
      );
    };
    for (const row of frame.viewportRows) {
      if (!damage.has(row.y)) continue;
      c.clearRect(0, row.y * h, m.width, h);
      for (let index = 0; index < row.cells.length; ) {
        const cell = row.cells[index++];
        if (cell.width.startsWith('spacer') || cell.style.invisible) continue;
        const color = appearance(cell, row),
          s = cell.style;
        let text = cell.text || ' ',
          span = cell.width === 'wide' ? 2 : 1;
        if (cell.width === 'narrow' && !powerline(cell.text)) {
          while (index < row.cells.length) {
            const next = row.cells[index];
            if (
              next.width !== 'narrow' ||
              powerline(next.text) ||
              next.x !== cell.x + span ||
              next.style !== s ||
              next.foregroundSource !== cell.foregroundSource ||
              next.backgroundSource !== cell.backgroundSource ||
              next.underlineSource !== cell.underlineSource ||
              appearance(next, row) !== color
            )
              break;
            text += next.text || ' ';
            span++;
            index++;
          }
        }
        c.fillStyle = color;
        c.globalAlpha = s.faint ? 0.66 : 1;
        c.font = `${s.italic ? 'italic ' : ''}${s.bold ? 700 : 400} ${m.fontSize}px ${m.fontFamily}`;
        const x = cell.x * w,
          y = row.y * h,
          baseline = y + (h + m.fontSize * 0.72) / 2,
          width = span * w;
        if (powerline(text))
          paintPowerline(c, text, x, y, width, h, Math.max(1, m.devicePixelRatio));
        else if (text.trim()) {
          const measured = c.measureText(text).width;
          if (measured > 0) {
            c.save();
            c.translate(x, baseline);
            c.scale(width / measured, 1);
            c.fillText(text, 0, 0);
            c.restore();
          }
        }
        if (s.underline) {
          c.fillStyle = cell.underlineColor ? css(cell.underlineColor) : appearance(cell, row);
          const line = Math.max(1, m.devicePixelRatio);
          const top = y + h - line * 2;
          c.fillRect(x, top, width, line);
          if (s.underline === 2) c.fillRect(x, top - line * 2, width, line);
        }
        c.fillStyle = color;
        if (s.strikethrough) c.fillRect(x, y + h * 0.5, width, Math.max(1, m.devicePixelRatio));
        if (s.overline) c.fillRect(x, y, width, Math.max(1, m.devicePixelRatio));
      }
    }
    c.globalAlpha = 1;
  }
  dispose() {
    this.rows.clear();
    this.text.width = 1;
    this.text.height = 1;
    this.background.resize(1, 1);
  }
}
