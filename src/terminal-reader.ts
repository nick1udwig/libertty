import type { Terminal } from 'ghostty-web';
import { readingText } from './reading-text.ts';
import './terminal-reader.css';

export function terminalText(term: Terminal) {
  const buffer = term.buffer.active, lines: string[] = [];
  for (let row = Math.max(0, buffer.length - 5000); row < buffer.length; row++) {
    const line = buffer.getLine(row), text = line?.translateToString(true) || '';
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

/** A stable, selectable reading surface while the live terminal catches up behind it. */
export class TerminalReader {
  readonly element = document.createElement('section');
  readonly content = readingText('');
  readonly viewport = document.createElement('div');
  private search = document.createElement('input');
  private status = document.createElement('span');
  private text = '';
  private limit = 500;
  interacted = false;
  private older = document.createElement('button');
  constructor(parent: HTMLElement, close: () => void, copy: (text: string) => Promise<void>, clear?: () => void) {
    this.element.className = 'terminal-reader'; this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Cached terminal history');
    for (const event of ['pointerdown', 'wheel', 'keydown']) this.element.addEventListener(event, () => { this.interacted = true; }, { passive: true });
    const toolbar = document.createElement('div'); toolbar.className = 'terminal-reader-toolbar';
    this.search.type = 'search'; this.search.placeholder = 'Search cached history'; this.search.setAttribute('aria-label', 'Search cached history');
    const live = document.createElement('button'); live.textContent = 'Jump to live'; live.onclick = close;
    const copyButton = document.createElement('button'); copyButton.textContent = 'Copy';
    copyButton.onclick = () => { void copy(getSelection()?.toString() || this.content.textContent || '').then(() => { this.status.textContent = 'Copied'; }, () => { this.status.textContent = 'Select text to copy'; }); };
    this.older.textContent = 'Show older'; this.older.onclick = () => {
      const height = this.viewport.scrollHeight, top = this.viewport.scrollTop;
      this.limit += 500; this.render(); this.viewport.scrollTop = top + this.viewport.scrollHeight - height;
    };
    this.search.oninput = () => { this.limit = 500; this.render(); this.viewport.scrollTop = 0; };
    this.status.role = 'status';
    toolbar.append(this.search, copyButton, live);
    if (clear) { const button = document.createElement('button'); button.textContent = 'Clear'; button.setAttribute('aria-label', 'Clear saved history'); button.onclick = clear; toolbar.append(button); }
    this.viewport.className = 'terminal-reader-content'; this.viewport.tabIndex = 0; this.viewport.append(this.older, this.content);
    this.element.append(toolbar, this.status, this.viewport); parent.append(this.element);
  }
  get open() { return !this.element.hidden; }
  get position() { return { position: this.viewport.scrollTop, lines: this.limit }; }
  show(text: string, position?: number, lines = 500) {
    this.text = text; this.search.value = ''; this.limit = lines; this.interacted = false;
    this.element.hidden = false; this.render();
    this.viewport.scrollTop = position ?? this.viewport.scrollHeight;
  }
  hide() { this.element.hidden = true; }
  private render() {
    const query = this.search.value.toLocaleLowerCase();
    const all = this.text.split('\n'), lines = query ? all.filter(line => line.toLocaleLowerCase().includes(query)) : all;
    this.content.textContent = lines.slice(-this.limit).join('\n') || (query ? 'No matches in cached history.' : 'No output has been cached yet.');
    this.older.hidden = lines.length <= this.limit;
    this.status.textContent = query ? `${lines.length} matching lines` : 'Cached output · live updates continue separately';
  }
}
