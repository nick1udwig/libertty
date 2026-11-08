import { icon as svgIcon, uploadIcon, downloadIcon } from './icons.ts';
import { transferAction, downloadPipeline } from './transfer-command.ts';
import { simpleWords } from './shell-words.ts';
import type { PreparedChoice } from './repair-choices.ts';
import type { Terminal } from './terminal-adapter.ts';
import type { ShellState } from './protocol.ts';
interface Model {
  literal: string;
  loading: boolean;
  transcribing: boolean;
  open: boolean;
  choices: PreparedChoice[];
  selected: string;
  pendingPresentation?: { pending: boolean };
  pendingCursor?: { x: number; row: number };
}
export class SuggestionView {
  private screen?: HTMLElement;
  private pane?: HTMLElement;
  readonly toggle = document.getElementById('alternatives-toggle')! as HTMLButtonElement;
  readonly menu = document.getElementById('alternatives-menu')!;
  private items = document.getElementById('alternative-items')!;
  private term: Terminal;
  private model: () => Model;
  private callbacks: { state(): ShellState; refresh(): void; choose(text: string): unknown };
  constructor(term: Terminal, model: () => Model, callbacks: SuggestionView['callbacks']) {
    this.term = term;
    this.model = model;
    this.callbacks = callbacks;
  }
  render() {
    const model = this.model();
    const busy = model.loading || model.transcribing || !!model.pendingPresentation?.pending;
    const state = this.callbacks.state(),
      available = state.ready || (busy && state.inputTarget === 'program');
    const visible = (!!model.literal || model.transcribing) && available && !state.exited;
    this.toggle.hidden = !visible;
    this.menu.hidden = !visible || !model.open || busy;
    this.toggle.classList.toggle('loading', busy);
    this.toggle.disabled = busy;
    this.toggle.setAttribute('aria-expanded', String(model.open && !busy));
    this.toggle.setAttribute(
      'aria-label',
      busy
        ? model.transcribing
          ? 'Transcribing'
          : 'Finding alternatives'
        : model.open
          ? 'Hide alternatives'
          : 'Show alternatives',
    );
    this.menu.setAttribute('aria-busy', String(busy));
    this.items.replaceChildren();
    if (!busy) {
      model.choices.forEach((choice, index) => this.addChoice(choice, index));
    }
    this.callbacks.refresh();
  }
  private addChoice(choice: PreparedChoice, index: number) {
    const { text, action, literal } = choice;
    const model = this.model();
    const button = document.createElement('button');
    button.className = 'alternative-choice';
    button.type = 'button';
    const words = action.kind === 'reading-file' ? simpleWords(action.operand) : undefined;
    const reading =
      action.kind === 'reading-file'
        ? words?.length === 1
          ? words[0].value
          : action.operand
        : action.kind === 'reading-pipeline'
          ? action.command + ' output'
          : undefined;
    button.classList.toggle('reading-choice', !!reading);
    button.classList.toggle('literal-choice', literal);
    button.classList.toggle('selected', text === model.selected);
    button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
    button.title = text;
    const icon = document.createElement('span');
    icon.className = 'choice-icon';
    icon.setAttribute('aria-hidden', 'true');
    const transfer = transferAction(text) || (downloadPipeline(text) ? 'download' : undefined);
    if (transfer) icon.innerHTML = transfer === 'upload' ? uploadIcon : downloadIcon;
    else if (reading)
      icon.innerHTML = svgIcon(
        '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
        16,
      );
    else if (literal)
      icon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3v3l5-3h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"/></svg>';
    else icon.textContent = '›_';
    const label = document.createElement('span');
    label.className = 'choice-command';
    label.textContent = reading ? 'Read ' + reading : text;
    const number = document.createElement('span');
    number.className = 'choice-number';
    number.textContent = String(index + 1);
    number.setAttribute('aria-hidden', 'true');
    button.append(icon, label, number);
    button.addEventListener('pointerdown', (e) => e.preventDefault());
    button.onclick = () => void this.callbacks.choose(choice.id);
    this.items.append(button);
  }
  position() {
    const model = this.model();
    if (!model.literal && !model.transcribing) return;
    if (!this.screen?.isConnected) {
      this.screen = this.term.screen;
      this.pane = this.screen?.closest<HTMLElement>('.terminal-pane') || undefined;
    }
    if (!this.screen || !this.pane) return;
    const bounds = this.screen.getBoundingClientRect(),
      pane = this.pane.getBoundingClientRect();
    const buffer = this.term.buffer.active;
    const row = model.pendingCursor?.row ?? buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (row < 0 || row >= this.term.rows || this.term.getViewportY() > 0) {
      this.toggle.hidden = true;
      this.menu.hidden = true;
      return;
    }
    // Read geometry before writes. The menu observer schedules a follow-up if its
    // width or height changes, without forcing another layout in this frame.
    const menuHeight = this.menu.offsetHeight;
    const cellWidth = bounds.width / this.term.cols,
      cellHeight = bounds.height / this.term.rows;
    const x =
      bounds.left -
      pane.left +
      (model.pendingCursor ? model.pendingCursor.x : buffer.cursorX + 1) * cellWidth;
    const y = bounds.top - pane.top + row * cellHeight;
    const left = Math.max(4, Math.min(pane.width - 36, x));
    const menuWidth = Math.min(330, pane.width - 16);
    const menuLeft = Math.max(8, Math.min(pane.width - menuWidth - 8, left - 12));
    const below = pane.height - y - cellHeight - 12;
    const above = y - 12;
    const upward = below < 210 && above > below;
    const available = Math.max(44, upward ? above : below);
    const busy = model.loading || model.transcribing || !!model.pendingPresentation?.pending;
    const state = this.callbacks.state(),
      inputAvailable = !state.exited && (state.ready || (busy && state.inputTarget === 'program'));
    this.toggle.hidden = !inputAvailable;
    this.menu.hidden = !state.ready || !model.open || busy;
    this.toggle.style.left = `${left}px`;
    this.toggle.style.top = `${Math.max(0, y - 8)}px`;
    this.menu.style.width = `${menuWidth}px`;
    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.maxHeight = `${available}px`;
    this.items.style.maxHeight = `${Math.max(30, available - 14)}px`;
    this.menu.style.top = `${upward ? Math.max(4, y - Math.min(menuHeight, available) - 10) : y + cellHeight + 10}px`;
    this.menu.classList.toggle('above', upward);
    this.menu.style.setProperty(
      '--pointer-x',
      `${Math.min(menuWidth - 18, Math.max(18, left - menuLeft + 12))}px`,
    );
  }
}
