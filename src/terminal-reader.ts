import './terminal-reader.css';

/** Retained text occupies the terminal surface without extra controls. */
export class TerminalReader {
  readonly element = document.createElement('section');
  readonly content = document.createElement('pre');
  readonly viewport = document.createElement('div');
  constructor(parent: HTMLElement, live: () => void) {
    this.content.className = 'reading-text';
    this.element.className = 'terminal-reader'; this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Terminal output');
    this.viewport.className = 'terminal-reader-content'; this.viewport.tabIndex = 0;
    this.viewport.append(this.content); this.element.append(this.viewport); parent.append(this.element);
    this.viewport.addEventListener('scroll', () => { if (!this.interacted) live(); }, { passive: true });
  }
  get open() { return !this.element.hidden; }
  get interacted() { return this.open && (this.viewport.scrollHeight - this.viewport.scrollTop - this.viewport.clientHeight > 2 || !!getSelection()?.toString()); }
  get position() { return { position: this.viewport.scrollTop, lines: 5000 }; }
  show(text: string, position?: number, _lines = 5000) {
    this.content.textContent = text; this.element.hidden = false;
    this.viewport.scrollTop = position ?? this.viewport.scrollHeight;
  }
  scroll(lines: number) { this.viewport.scrollTop += lines * parseFloat(getComputedStyle(this.content).lineHeight); }
  hide() { this.element.hidden = true; }
}
