import type { Terminal } from './terminal-adapter.ts';
import type { InputLine } from './input-line.ts';
import type { ShellState } from './protocol.ts';
interface Callbacks {
  line: InputLine;
  state(): ShellState;
  flushing(): boolean;
  clear(): void;
  raw(data: string): void;
  dictate(text: string, replacement: boolean, applied?: boolean): unknown;
}
export class SuggestionInput {
  composing = false;
  private compositionText = '';
  private compositionSent = '';
  private compositionTyped = false;
  private compositionBulk = false;
  private compositionLine?: { text: string; cursor: number; known: boolean };
  private lastDelete?: { data: string; at: number };
  private lastCommit = { text: '', at: 0 };
  private term: Terminal;
  private callbacks: Callbacks;
  constructor(term: Terminal, callbacks: Callbacks) {
    this.term = term;
    this.callbacks = callbacks;
    const container = document.getElementById('terminal')!;
    const stop = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const eligible = () =>
      !this.callbacks.flushing() && this.callbacks.state().ready && !this.callbacks.state().exited;
    const pasteLiteral = (text: string) => {
      this.callbacks.clear();
      this.term.paste(text);
      this.armInput();
    };
    // Single-line clipboard text can come from an external dictation tool.
    container.addEventListener(
      'paste',
      (event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!eligible() || !text || /[\x00-\x1f\x7f]/.test(text)) return;
        stop(event);
        void this.callbacks.dictate(text, false);
      },
      true,
    );
    // Browsers also expose dictation as replacement text or committed composition.
    container.addEventListener(
      'beforeinput',
      (event) => {
        const e = event as InputEvent;
        if (/^deleteContent(?:Backward|Forward)$/.test(e.inputType)) {
          stop(e);
          this.composing = false;
          this.compositionText = '';
          this.compositionSent = '';
          const data = e.inputType === 'deleteContentBackward' ? '\x7f' : '\x1b[3~';
          const duplicate =
            this.lastDelete?.data === data && performance.now() - this.lastDelete.at < 120;
          this.lastDelete = undefined;
          if (!duplicate) this.callbacks.raw(data);
          this.armInput();
          return;
        }
        if (this.composing) {
          if (
            e.data &&
            ['insertFromDictation', 'insertReplacementText'].includes(e.inputType) &&
            !/[\x00-\x1f\x7f]/.test(e.data)
          ) {
            stop(e);
            this.composing = false;
            if (this.compositionTyped) {
              this.updateComposition(e.data);
              if (this.compositionLine?.known) {
                this.callbacks.line.reset(this.compositionLine.text);
                this.callbacks.line.cursor = this.compositionLine.cursor;
              }
            }
            this.lastCommit = { text: e.data, at: performance.now() };
            if (eligible()) void this.callbacks.dictate(e.data, false, this.compositionTyped);
            else if (!this.compositionTyped) pasteLiteral(e.data);
            this.armInput();
            return;
          }
          if (e.inputType === 'insertCompositionText' && e.data !== null)
            this.updateComposition(e.data);
          stop(e);
          return;
        }
        if (
          e.data &&
          this.lastCommit.text === e.data &&
          performance.now() - this.lastCommit.at < 120
        ) {
          this.lastCommit.text = '';
          stop(e);
          return;
        }
        if (!e.data || /[\x00-\x1f\x7f]/.test(e.data)) return;
        if (
          ['insertFromDictation', 'insertReplacementText'].includes(e.inputType) ||
          (e.inputType === 'insertText' && e.data.length > 1)
        ) {
          stop(e);
          if (eligible())
            void this.callbacks.dictate(e.data, e.inputType === 'insertReplacementText');
          else pasteLiteral(e.data);
        }
      },
      true,
    );
    container.addEventListener(
      'compositionstart',
      (e) => {
        this.composing = true;
        this.compositionText = '';
        this.compositionSent = '';
        this.compositionTyped = false;
        this.compositionBulk = false;
        this.compositionLine = {
          text: this.callbacks.line.text,
          cursor: this.callbacks.line.cursor,
          known: this.callbacks.line.known,
        };
        stop(e);
      },
      true,
    );
    container.addEventListener(
      'compositionupdate',
      (event) => {
        if (this.composing) {
          this.updateComposition((event as CompositionEvent).data);
          stop(event);
        }
      },
      true,
    );
    container.addEventListener(
      'compositionend',
      (event) => {
        if (!this.composing) return;
        const e = event as CompositionEvent;
        stop(e);
        this.composing = false;
        this.armInput();
        if (this.compositionTyped) {
          this.updateComposition(e.data);
          this.lastCommit = { text: e.data, at: performance.now() };
          if (this.compositionBulk && eligible() && e.data && !/[\x00-\x1f\x7f]/.test(e.data)) {
            if (this.compositionLine?.known) {
              this.callbacks.line.reset(this.compositionLine.text);
              this.callbacks.line.cursor = this.compositionLine.cursor;
            }
            void this.callbacks.dictate(e.data, false, true);
          }
          return;
        }
        if (!e.data) return;
        this.lastCommit = { text: e.data, at: performance.now() };
        if (eligible() && !/[\x00-\x1f\x7f]/.test(e.data))
          void this.callbacks.dictate(e.data, false);
        else pasteLiteral(e.data);
      },
      true,
    );
    container.addEventListener(
      'keydown',
      (e) => {
        this.lastDelete = undefined;
        if (
          !e.isComposing &&
          e.keyCode !== 229 &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey &&
          ['Backspace', 'Delete'].includes(e.key)
        ) {
          stop(e);
          this.composing = false;
          this.compositionText = '';
          this.compositionSent = '';
          const data = e.key === 'Backspace' ? '\x7f' : '\x1b[3~';
          this.callbacks.raw(data);
          this.lastDelete = { data, at: performance.now() };
          this.armInput();
          return;
        }
        if (this.composing && (e.isComposing || e.keyCode === 229)) e.stopImmediatePropagation();
        else this.lastCommit.text = '';
      },
      true,
    );
    container.addEventListener('input', () => this.armInput());
    this.term.textarea?.addEventListener('focus', () => this.armInput());
    this.armInput();
  }
  armInput() {
    if (this.composing || !this.term.textarea) return;
    // Android may suppress Backspace at the beginning of an empty textarea.
    // Bash owns the real text; this invisible buffer only gives the IME room to delete.
    this.term.textarea.value = '\u200b';
    this.term.textarea.setSelectionRange(1, 1);
  }
  private updateComposition(text: string) {
    // Mobile keyboards often compose a word one letter at a time. Stream those
    // edits immediately; only a bulk commit is a possible dictation transcript.
    if (!this.compositionText && Array.from(text).length <= 1) this.compositionTyped = true;
    if (Array.from(text).length - Array.from(this.compositionText).length > 1)
      this.compositionBulk = true;
    if (this.compositionTyped) {
      const before = Array.from(this.compositionSent),
        after = Array.from(text);
      let shared = 0;
      while (shared < before.length && before[shared] === after[shared]) shared++;
      for (let i = shared; i < before.length; i++) this.callbacks.raw('\x7f');
      const inserted = after.slice(shared).join('');
      if (inserted) this.callbacks.raw(inserted);
      this.compositionSent = text;
    }
    this.compositionText = text;
  }
}
