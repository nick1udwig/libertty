import type { Terminal } from './terminal-adapter.ts';
import type { ShellState } from './protocol.ts';

interface Screen { cols: number; x: number; row: number; cells: string[]; visible: boolean }
interface Prediction { x: number; row: number; text: string }

/** Predict simple append-at-end input without changing the terminal buffer. */
export class EchoPrediction {
  private pending?: Prediction & { prefix: string; cols: number };
  private prompt = -1;
  private blocked = false;
  private read: () => Screen;
  private paint: (prediction?: Prediction) => void;
  constructor(read: () => Screen, paint: (prediction?: Prediction) => void) { this.read = read; this.paint = paint; }
  reset() { this.prompt = -1; this.blocked = false; this.pending = undefined; this.paint(); }
  cancel() { this.blocked = true; this.pending = undefined; this.paint(); }
  state(state: ShellState) {
    if (state.prompt !== this.prompt) {
      this.reset(); this.prompt = state.prompt; this.blocked = state.inputRevision !== state.promptRevision;
    }
    if (!state.ready || state.exited || state.inputTarget !== 'shell') this.cancel();
  }
  input(data: string, state: ShellState, known: boolean) {
    this.state(state);
    if (data === '\x1b[I' || data === '\x1b[O') return;
    if (this.blocked) return;
    if (!known || !/^[\x20-\x7e]+$/.test(data)) { this.cancel(); return; }
    this.reconcile();
    if (this.blocked) return;
    const screen = this.read();
    if (!screen.visible) { this.cancel(); return; }
    this.pending ||= { x: screen.x, row: screen.row, cols: screen.cols, text: '', prefix: screen.cells.slice(0, screen.x).join('\0') };
    if (this.pending.x + this.pending.text.length + data.length >= screen.cols) { this.cancel(); return; }
    this.pending.text += data;
    this.paint(this.pending);
  }
  reconcile() {
    if (!this.pending) return;
    const screen = this.read(), pending = this.pending;
    const confirmed = screen.x - pending.x;
    if (!screen.visible || screen.cols !== pending.cols || screen.row !== pending.row || confirmed < 0 || confirmed > pending.text.length
      || screen.cells.slice(0, pending.x).join('\0') !== pending.prefix
      || screen.cells.slice(pending.x, screen.x).join('') !== pending.text.slice(0, confirmed)) {
      this.cancel(); return;
    }
    if (confirmed) {
      pending.x = screen.x; pending.text = pending.text.slice(confirmed);
      pending.prefix = screen.cells.slice(0, screen.x).join('\0');
    }
    if (!pending.text) this.pending = undefined;
    this.paint(this.pending);
  }
}

export class TerminalEcho {
  private layer = document.createElement('span');
  private model: EchoPrediction;
  private frame = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(term: Terminal, host: HTMLElement) {
    this.layer.className = 'predicted-echo'; this.layer.hidden = true; this.layer.setAttribute('aria-hidden', 'true'); host.append(this.layer);
    const screen = (): Screen => {
      const buffer = term.buffer.active, row = Math.max(0, buffer.length - term.rows) + buffer.cursorY;
      const line = buffer.getLine(row);
      return { cols: term.cols, x: buffer.cursorX, row, cells: Array.from({ length: term.cols }, (_, x) => line?.getCell(x)?.getChars() || ' '),
        visible: buffer.type === 'normal' && term.getViewportY() === 0 };
    };
    this.model = new EchoPrediction(screen, prediction => {
      clearTimeout(this.expiry);
      this.layer.hidden = !prediction;
      if (!prediction) return;
      const canvas = host.querySelector('canvas');
      if (!canvas) { this.layer.hidden = true; return; }
      const bounds = canvas.getBoundingClientRect(), parent = host.getBoundingClientRect();
      const width = bounds.width / term.cols, height = bounds.height / term.rows;
      const row = prediction.row - Math.max(0, term.buffer.active.length - term.rows);
      this.layer.replaceChildren(...Array.from(prediction.text, text => { const cell = document.createElement('span'); cell.textContent = text; return cell; }));
      Object.assign(this.layer.style, { left: bounds.left - parent.left + prediction.x * width + 'px', top: bounds.top - parent.top + row * height + 'px',
        fontFamily: term.options.fontFamily, fontSize: term.options.fontSize + 'px', lineHeight: height + 'px', letterSpacing: '0px', gridAutoColumns: width + 'px' });
      this.expiry = setTimeout(() => this.cancel(), 4000);
    });
    term.onResize(() => this.reset());
    term.onScroll(() => { if (term.getViewportY() > 0) this.cancel(); });
  }
  state(state: ShellState) { this.model.state(state); }
  input(data: string, state: ShellState, known: boolean) { this.model.input(data, state, known); }
  reset() { cancelAnimationFrame(this.frame); this.frame = 0; this.model.reset(); }
  cancel() { cancelAnimationFrame(this.frame); this.frame = 0; this.model.cancel(); }
  output() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.model.reconcile(); });
  }
}
