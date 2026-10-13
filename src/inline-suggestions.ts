import { uploadIcon, downloadIcon } from './icons.ts';
import { transferAction, downloadPipeline } from './transfer-command.ts';
import type { Terminal } from 'ghostty-web';
import type { Candidate, ShellState } from './protocol.ts';
import { InputLine } from './input-line.ts';
import { cursorSteps } from './touch-cursor.ts';
import { defaultReadingPhrases, readingPath, readingPhrases, readingPipeline, readingRequest, readingSuggestionChoice, readingSuggestionInput } from './reading-request.ts';
interface Host {
  latencyKey?: string;
  state(): ShellState;
  replace(text: string): Promise<boolean>;
  readLine?(): Promise<{ text: string; cursor: number } | undefined>;
  suggest(text: string, signal: AbortSignal): Promise<{ candidates: Candidate[] }>;
  raw(data: string): void;
  execute(text: string): void;
  dictate?(text: string, applied: boolean, replace: boolean): void;
}
export class InlineSuggestions {
  private line = new InputLine();
  private generation = 0;
  private prompt = -1;
  private controller?: AbortController;
  private literal = '';
  private choices: string[] = [];
  private reading?: string;
  private phrases = [...defaultReadingPhrases];
  private selected = '';
  private prefix = '';
  private suffix = '';
  private speech = '';
  private loading = false;
  private showOriginal = false;
  private latency = 0;
  private literalReplacement?: Promise<boolean>;
  private flushing?: string[];
  private suspendedRevision: number | undefined;
  private retryOnResume = false;
  private open = false;
  private autoOpen = true;
  private tapToSend = true;
  private composing = false;
  private compositionText = '';
  private compositionSent = '';
  private compositionTyped = false;
  private compositionBulk = false;
  private compositionLine?: { text: string; cursor: number; known: boolean };
  private lastDelete?: { data: string; at: number };
  private lastCommit = { text: '', at: 0 };
  private positionFrame = 0;
  private canvas?: HTMLCanvasElement;
  private pane?: HTMLElement;
  private toggle = document.getElementById('alternatives-toggle')!;
  private menu = document.getElementById('alternatives-menu')!;
  private items = document.getElementById('alternative-items')!;
  private status = document.getElementById('suggestion-status')!;
  private term: Terminal;
  private host: Host;
  constructor(term: Terminal, host: Host) {
    this.term = term; this.host = host;
    this.setLatencyProfile(host.latencyKey);
    try { this.phrases = readingPhrases(JSON.parse(localStorage.getItem('termai.readingPhrases') || 'null')); } catch {}
    const setting = document.getElementById('auto-alternatives') as HTMLInputElement;
    try { this.autoOpen = localStorage.getItem('termai.autoAlternatives') !== 'false' && localStorage.getItem('termai.justRun') !== 'true'; } catch {}
    setting.checked = this.autoOpen;
    setting.onchange = () => {
      this.autoOpen = setting.checked;
      try { localStorage.setItem('termai.autoAlternatives', String(this.autoOpen)); localStorage.removeItem('termai.justRun'); } catch {}
      this.open = this.autoOpen; this.render();
    };
    const tapSetting = document.getElementById('tap-alternate-send') as HTMLInputElement;
    try { this.tapToSend = localStorage.getItem('termai.tapAlternateSend') !== 'false'; } catch {}
    tapSetting.checked = this.tapToSend;
    tapSetting.onchange = () => {
      this.tapToSend = tapSetting.checked;
      try { localStorage.setItem('termai.tapAlternateSend', String(this.tapToSend)); } catch {}
    };
    document.addEventListener('pointerdown', event => {
      if (!this.menu.contains(event.target as Node) && !this.toggle.contains(event.target as Node)) this.collapse();
    });
    this.toggle.addEventListener('pointerdown', e => e.preventDefault());
    this.toggle.onclick = () => { this.open = !this.open; this.render(); };
    term.onCursorMove(() => this.refresh()); term.onScroll(() => this.refresh());
    const container = document.getElementById('terminal')!;
    const resize = new ResizeObserver(() => this.refresh());
    resize.observe(container); resize.observe(this.menu);
    window.visualViewport?.addEventListener('resize', () => this.refresh());
    const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
    const eligible = () => !this.flushing && host.state().ready && !host.state().exited;
    const pasteLiteral = (text: string) => { this.clear(); this.term.paste(text); this.armInput(); };
    // Browsers expose dictation as replacement text, multi-character insertText, or
    // committed composition. Clipboard paste is deliberately left to the terminal.
    container.addEventListener('beforeinput', event => {
      const e = event as InputEvent;
      if (/^deleteContent(?:Backward|Forward)$/.test(e.inputType)) {
        stop(e); this.composing = false; this.compositionText = ''; this.compositionSent = '';
        const data = e.inputType === 'deleteContentBackward' ? '\x7f' : '\x1b[3~';
        const duplicate = this.lastDelete?.data === data && performance.now() - this.lastDelete.at < 120;
        this.lastDelete = undefined;
        if (!duplicate) host.raw(data);
        this.armInput(); return;
      }
      if (this.composing) {
        if (e.data && ['insertFromDictation', 'insertReplacementText'].includes(e.inputType) && !/[\x00-\x1f\x7f]/.test(e.data)) {
          stop(e); this.composing = false;
          if (this.compositionTyped) {
            this.updateComposition(e.data);
            if (this.compositionLine?.known) { this.line.reset(this.compositionLine.text); this.line.cursor = this.compositionLine.cursor; }
          }
          this.lastCommit = { text: e.data, at: performance.now() };
          if (eligible()) void this.nativeDictation(e.data, false, this.compositionTyped);
          else if (!this.compositionTyped) pasteLiteral(e.data);
          this.armInput(); return;
        }
        if (e.inputType === 'insertCompositionText' && e.data !== null) this.updateComposition(e.data);
        stop(e); return;
      }
      if (e.data && this.lastCommit.text === e.data && performance.now() - this.lastCommit.at < 120) {
        this.lastCommit.text = ''; stop(e); return;
      }
      if (!e.data || /[\x00-\x1f\x7f]/.test(e.data)) return;
      if (['insertFromDictation', 'insertReplacementText'].includes(e.inputType) || (e.inputType === 'insertText' && e.data.length > 1)) {
        stop(e);
        if (eligible()) void this.nativeDictation(e.data, e.inputType === 'insertReplacementText');
        else pasteLiteral(e.data);
      }
    }, true);
    container.addEventListener('compositionstart', e => {
      this.composing = true; this.compositionText = ''; this.compositionSent = ''; this.compositionTyped = false; this.compositionBulk = false;
      this.compositionLine = { text: this.line.text, cursor: this.line.cursor, known: this.line.known }; stop(e);
    }, true);
    container.addEventListener('compositionupdate', event => {
      if (this.composing) { this.updateComposition((event as CompositionEvent).data); stop(event); }
    }, true);
    container.addEventListener('compositionend', event => {
      if (!this.composing) return;
      const e = event as CompositionEvent; stop(e); this.composing = false;
      this.armInput();
      if (this.compositionTyped) {
        this.updateComposition(e.data); this.lastCommit = { text: e.data, at: performance.now() };
        if (this.compositionBulk && eligible() && e.data && !/[\x00-\x1f\x7f]/.test(e.data)) {
          if (this.compositionLine?.known) { this.line.reset(this.compositionLine.text); this.line.cursor = this.compositionLine.cursor; }
          void this.nativeDictation(e.data, false, true);
        }
        return;
      }
      if (!e.data) return;
      this.lastCommit = { text: e.data, at: performance.now() };
      if (eligible() && !/[\x00-\x1f\x7f]/.test(e.data)) void this.nativeDictation(e.data, false);
      else pasteLiteral(e.data);
    }, true);
    container.addEventListener('keydown', e => {
      this.lastDelete = undefined;
      if (!e.isComposing && e.keyCode !== 229 && !e.ctrlKey && !e.altKey && !e.metaKey && ['Backspace', 'Delete'].includes(e.key)) {
        stop(e); this.composing = false; this.compositionText = ''; this.compositionSent = '';
        const data = e.key === 'Backspace' ? '\x7f' : '\x1b[3~';
        host.raw(data); this.lastDelete = { data, at: performance.now() }; this.armInput(); return;
      }
      if (this.composing && (e.isComposing || e.keyCode === 229)) e.stopImmediatePropagation();
      else this.lastCommit.text = '';
    }, true);
    container.addEventListener('input', () => this.armInput());
    term.textarea?.addEventListener('focus', () => this.armInput());
    this.armInput();
  }
  private armInput() {
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
    if (Array.from(text).length - Array.from(this.compositionText).length > 1) this.compositionBulk = true;
    if (this.compositionTyped) {
      const before = Array.from(this.compositionSent), after = Array.from(text);
      let shared = 0;
      while (shared < before.length && before[shared] === after[shared]) shared++;
      for (let i = shared; i < before.length; i++) this.host.raw('\x7f');
      const inserted = after.slice(shared).join('');
      if (inserted) this.host.raw(inserted);
      this.compositionSent = text;
    }
    this.compositionText = text;
  }
  private collapse() { if (this.open) { this.open = false; this.render(); } }
  setLatencyProfile(key?: string) {
    this.host.latencyKey = key; this.latency = 0;
    try { this.latency = Math.max(0, Math.min(30000, Number(localStorage.getItem('termai.suggestionLatency:' + key)) || 0)); } catch {}
  }
  setReadingPhrases(value: unknown) { this.phrases = readingPhrases(value); }
  onState(state: ShellState) {
    if (this.suspendedRevision !== undefined) {
      const intact = state.ready && !state.exited && state.prompt === this.prompt && state.inputRevision === this.suspendedRevision;
      const retry = this.retryOnResume, open = this.open;
      this.suspendedRevision = undefined; this.retryOnResume = false;
      if (intact) {
        if (retry) { void this.dictate(this.speech, true); this.open = open; this.render(); }
        else this.refresh();
        return;
      }
    }
    if (state.prompt !== this.prompt) {
      this.clear(); this.prompt = state.prompt; this.line.reset();
      this.line.known = state.ready && state.inputRevision === state.promptRevision;
    } else if (!state.ready || state.exited) { this.clear(); this.line.known = false; }
  }
  disconnect() { this.clear(); this.line.known = false; this.prompt = -1; }
  prepareExternalPaste() { this.clear(); }
  private async nativeDictation(text: string, replacement: boolean, alreadyApplied = false) {
    if (this.host.dictate) { const replace = replacement && !!this.literal; this.clear(); this.host.dictate(text, alreadyApplied, replace); return; }
    if (this.line.known) return this.dictate(text, replacement, alreadyApplied);
    if (!this.host.readLine) { if (!alreadyApplied) this.term.paste(text); return; }
    this.clear(); const request = this.generation;
    this.flushing = [];
    let line: { text: string; cursor: number } | undefined;
    try { line = await this.host.readLine(); } catch { /* Preserve input when the snapshot is unavailable. */ }
    const queued = this.flushing?.join('') || ''; this.flushing = undefined;
    if (request !== this.generation || !this.host.state().ready || this.host.state().exited) return;
    if (!line) {
      if (!alreadyApplied) this.term.paste(text);
      if (queued) this.host.raw(queued);
      return;
    }
    this.line.reset(line.text); this.line.cursor = line.cursor;
    if (queued) { if (!alreadyApplied) this.term.paste(text); this.host.raw(queued); return; }
    if (alreadyApplied) {
      // The authoritative snapshot includes the backend's inserted transcript.
      this.line.reset(); return this.dictate(line.text, false, true);
    }
    return this.dictate(text, replacement);
  }
  externalPaste(text: string, replace: boolean, dictated = false, isolated = false) {
    this.clear();
    if (!this.host.state().ready || this.host.state().exited) { this.line.known = false; return; }
    if (isolated && dictated) this.line.reset();
    if (dictated && !replace && !this.line.known) return this.nativeDictation(text, false, true);
    if (dictated && !replace && this.line.known && this.host.state().ready && !this.host.state().exited) {
      // The backend has already inserted this text. Reuse dictation's repair and
      // choice flow, without sending the literal transcript back for insertion.
      return this.dictate(text, false, true);
    }
    if (replace) this.line.reset(text);
    else if (this.line.known) this.line.insert(text);
  }
  suspend() {
    if (!this.literal) { this.disconnect(); return; }
    if (this.suspendedRevision !== undefined) return;
    this.suspendedRevision = this.host.state().inputRevision;
    this.retryOnResume = this.loading;
    ++this.generation; this.controller?.abort(); this.controller = undefined;
    this.loading = false;
    this.render();
  }
  refresh() {
    if (!this.literal || this.positionFrame) return;
    this.positionFrame = requestAnimationFrame(() => { this.positionFrame = 0; this.position(); });
  }
  raw(data: string): boolean {
    queueMicrotask(() => this.armInput());
    if (data === '\x1b[I' || data === '\x1b[O') return true;
    if (this.flushing) { this.flushing.push(data); return false; }
    if (this.loading) {
      const literal = this.literal, pending = this.literalReplacement;
      this.flushing = [data]; this.clear();
      void (pending || this.host.replace(literal)).then(accepted => {
        const input = this.flushing?.join('') || ''; this.flushing = undefined;
        if (accepted) { this.line.reset(literal); this.host.raw(input); }
        else this.disconnect();
      }).catch(() => { this.flushing = undefined; this.disconnect(); });
      return false;
    }
    if (data === '\r' && this.line.known && this.host.state().ready) {
      const pipeline = readingPipeline(this.line.text, this.phrases || defaultReadingPhrases);
      if (pipeline) { this.host.execute(pipeline.command + ' | look at'); return false; }
      const request = readingRequest(this.line.text, this.phrases || defaultReadingPhrases);
      if (request) { this.openRead(request.operand); return false; }
    }
    // Escape dismisses this UI, without leaving Readline waiting for a Meta key.
    if (data === '\x1b' && this.literal) { this.collapse(); return false; }
    // Moving the cursor or dismissing the menu does not discard the alternatives.
    if (/^(\x1b\[[CDHF]|[\x01\x02\x05\x06])$/.test(data)) {
      this.line.feed(data); this.collapse(); return true;
    }
    this.clear(); this.line.feed(data); return true;
  }
  private clear() {
    this.literalReplacement = undefined; this.showOriginal = false;
    const visible = !!this.literal || this.loading || this.open || !!this.choices.length;
    ++this.generation; this.controller?.abort(); this.literal = ''; this.speech = ''; this.choices = []; this.reading = undefined;
    this.suspendedRevision = undefined; this.retryOnResume = false;
    this.loading = false; this.open = false;
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = 0;
    if (visible) this.render();
  }
  moveCursor(x: number, y: number) {
    const buffer = this.term.buffer.active, canvas = this.term.element?.querySelector('canvas');
    if (!canvas || !this.line.known || !this.host.state().ready || this.loading || this.composing || buffer.type !== 'normal' || this.term.getViewportY() > 0) return;
    const bounds = canvas.getBoundingClientRect();
    const col = Math.floor((x - bounds.left) / (bounds.width / this.term.cols));
    const row = Math.floor((y - bounds.top) / (bounds.height / this.term.rows));
    if (col < 0 || col >= this.term.cols || row < 0 || row >= this.term.rows) return;
    const steps = cursorSteps(this.line.text, this.line.cursor, buffer.cursorY * this.term.cols + buffer.cursorX,
      row * this.term.cols + col, this.term.cols, at => buffer.getLine(buffer.baseY + Math.floor(at / this.term.cols))?.getCell(at % this.term.cols));
    if (steps === undefined) return;
    for (let i = 0; i < Math.abs(steps); i++) this.host.raw(steps < 0 ? '\x1b[D' : '\x1b[C');
    this.term.focus();
  }
  private async dictate(text: string, replacement: boolean, alreadyApplied = false) {
    if (!this.literal) {
      this.prefix = this.line.text.slice(0, this.line.cursor); this.suffix = this.line.text.slice(this.line.cursor); this.speech = text;
    } else this.speech = replacement ? text : this.speech + text;
    this.literal = this.prefix + this.speech + this.suffix;
    if (this.literal.length > 2000) {
      if (alreadyApplied) this.line.insert(text);
      this.clear(); if (!alreadyApplied) this.host.raw(text); return;
    }
    this.controller?.abort(); this.controller = new AbortController();
    this.literalReplacement = alreadyApplied ? Promise.resolve(true) : undefined; this.showOriginal = false;
    const request = ++this.generation, prompt = this.host.state().prompt;
    const started = performance.now();
    const reading = readingRequest(this.literal, this.phrases || defaultReadingPhrases, true);
    const pipeline = readingPipeline(this.literal, this.phrases || defaultReadingPhrases, true);
    this.reading = pipeline?.command || reading?.path;
    this.loading = true; this.open = this.autoOpen; this.choices = []; this.selected = this.literal;
    // Choose once from previous completed requests. Never reveal the transcript
    // midway through a request: it could finish immediately after that reveal.
    this.showOriginal = this.latency >= 500;
    this.line.reset(this.literal); this.status.textContent = 'Finding alternatives'; this.render();
    if (this.showOriginal && !alreadyApplied) this.literalReplacement = this.host.replace(this.literal).catch(() => false);
    try {
      const suggestion = this.host.suggest(pipeline ? pipeline.command : reading ? readingSuggestionInput(reading) : this.literal, this.controller.signal).then(result => ({ result }), error => ({ error }));
      const outcome = await suggestion;
      if ('error' in outcome) throw outcome.error;
      const result = outcome.result;
      if (request !== this.generation || prompt !== this.host.state().prompt || !this.host.state().ready) return;
      let parsed = result.candidates.filter(candidate => !candidate.literal)
        .map(candidate => pipeline ? candidate.command + ' | ' + pipeline.phrase : reading ? readingSuggestionChoice(candidate.command, reading.phrase) : candidate.command)
        .filter((choice): choice is string => !!choice);
      if (reading && !pipeline && !parsed.length) {
        const commands = await this.host.suggest(reading.operand, this.controller.signal);
        if (request !== this.generation || prompt !== this.host.state().prompt || !this.host.state().ready) return;
        parsed = commands.candidates.filter(candidate => !candidate.literal).map(candidate => reading.phrase + ' ' + candidate.command);
      }
      this.choices = [...new Set(parsed.filter(choice => choice !== this.literal))].slice(0, 3);
      const top = reading || pipeline ? this.choices[0] || this.literal : parsed[0] || this.literal;
      const replacement = this.literalReplacement;
      if (replacement && !await replacement) { if (request === this.generation) this.disconnect(); return; }
      if (request !== this.generation) return;
      this.line.reset(top);
      if ((!replacement || top !== this.literal) && !await this.host.replace(top)) { if (request === this.generation) this.disconnect(); return; }
      if (request !== this.generation) return;
      const elapsed = performance.now() - started;
      this.latency = this.latency ? this.latency * .6 + elapsed * .4 : elapsed;
      try { if (this.host.latencyKey) localStorage.setItem('termai.suggestionLatency:' + this.host.latencyKey, String(this.latency)); } catch {}
      this.selected = top; this.line.reset(top); this.loading = false;
      this.status.textContent = 'Alternatives ready'; this.render();
    } catch (error: any) {
      if (request !== this.generation || error.name === 'AbortError') return;
      if (!await (this.literalReplacement || this.host.replace(this.literal))) { if (request === this.generation) this.disconnect(); return; }
      if (request !== this.generation) return;
      this.loading = false; this.open = true;
      this.status.textContent = 'Alternatives unavailable. Original text kept.'; this.render();
    }
  }
  private async choose(text: string) {
    if (this.reading) {
      const pipeline = readingPipeline(text, this.phrases, true);
      if (pipeline) { this.host.execute(pipeline.command + ' | look at'); return; }
      const request = readingRequest(text, this.phrases);
      if (request) this.openRead(request.operand);
      return;
    }
    if (this.tapToSend) { this.host.execute(text); this.term.focus(); return; }
    const request = ++this.generation; this.controller?.abort(); this.loading = false;
    this.collapse();
    this.line.reset(text);
    if (await this.host.replace(text) && request === this.generation) {
      this.selected = text; this.line.reset(text); this.open = false; this.render();
    }
    this.term.focus();
  }
  private openRead(operand: string) { this.host.execute('look at ' + operand); }
  private render() {
    this.armInput();
    const visible = !!this.literal && this.host.state().ready;
    this.toggle.hidden = !visible; this.menu.hidden = !visible || !this.open;
    this.toggle.classList.toggle('loading', this.loading);
    this.toggle.setAttribute('aria-expanded', String(this.open));
    this.toggle.setAttribute('aria-label', this.open ? 'Hide alternatives' : 'Show alternatives');
    this.menu.setAttribute('aria-busy', String(this.loading));
    this.items.replaceChildren();
    if (this.loading) {
      const row = document.createElement('div'); row.className = 'alternative-loading'; row.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Finding alternatives…</span>'; this.items.append(row);
    } else {
      this.choices.forEach((text, index) => this.addChoice(text, index, false));
    }
    if (this.literal && (!this.loading || this.showOriginal)) this.addChoice(this.literal, this.loading ? 0 : this.choices.length, true);
    this.refresh();
  }
  private addChoice(text: string, index: number, literal: boolean) {
    const button = document.createElement('button'); button.className = 'alternative-choice'; button.type = 'button';
    const pipeline = this.reading ? readingPipeline(text, this.phrases, true) : undefined;
    const reading = pipeline ? pipeline.command + ' output' : this.reading ? readingPath(text, this.phrases) : undefined;
    button.classList.toggle('reading-choice', !!reading);
    button.classList.toggle('literal-choice', literal); button.classList.toggle('selected', text === this.selected && (!literal || !this.choices.includes(text)));
    button.setAttribute('aria-pressed', String(button.classList.contains('selected'))); button.title = text;
    const icon = document.createElement('span'); icon.className = 'choice-icon'; icon.setAttribute('aria-hidden', 'true');
    const transfer = transferAction(text) || (downloadPipeline(text) ? 'download' : undefined);
    if (transfer) icon.innerHTML = transfer === 'upload' ? uploadIcon : downloadIcon;
    else if (reading) icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
    else if (literal) icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3v3l5-3h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"/></svg>';
    else icon.textContent = '›_';
    const label = document.createElement('span'); label.className = 'choice-command'; label.textContent = reading ? 'Read ' + reading : text;
    const number = document.createElement('span'); number.className = 'choice-number'; number.textContent = String(index + 1); number.setAttribute('aria-hidden', 'true');
    button.append(icon, label, number); button.addEventListener('pointerdown', e => e.preventDefault());
    button.onclick = () => void this.choose(text); this.items.append(button);
  }
  private position() {
    if (!this.literal) return;
    if (!this.canvas?.isConnected) {
      this.canvas = document.querySelector<HTMLCanvasElement>('#terminal canvas') || undefined;
      this.pane = this.canvas?.closest<HTMLElement>('.terminal-pane') || undefined;
    }
    if (!this.canvas || !this.pane) return;
    const bounds = this.canvas.getBoundingClientRect(), pane = this.pane.getBoundingClientRect();
    const buffer = this.term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (row < 0 || row >= this.term.rows || this.term.getViewportY() > 0) { this.toggle.hidden = true; this.menu.hidden = true; return; }
    // Read geometry before writes. The menu observer schedules a follow-up if its
    // width or height changes, without forcing another layout in this frame.
    const menuHeight = this.menu.offsetHeight;
    const cellWidth = bounds.width / this.term.cols, cellHeight = bounds.height / this.term.rows;
    const x = bounds.left - pane.left + (buffer.cursorX + 1) * cellWidth;
    const y = bounds.top - pane.top + row * cellHeight;
    const left = Math.max(4, Math.min(pane.width - 36, x));
    const menuWidth = Math.min(330, pane.width - 16);
    const menuLeft = Math.max(8, Math.min(pane.width - menuWidth - 8, left - 12));
    const below = pane.height - y - cellHeight - 12;
    const above = y - 12;
    const upward = below < 210 && above > below;
    const available = Math.max(44, upward ? above : below);
    this.toggle.hidden = !this.host.state().ready; this.menu.hidden = !this.host.state().ready || !this.open;
    this.toggle.style.left = `${left}px`; this.toggle.style.top = `${Math.max(0, y - 8)}px`;
    this.menu.style.width = `${menuWidth}px`; this.menu.style.left = `${menuLeft}px`;
    this.menu.style.maxHeight = `${available}px`;
    this.items.style.maxHeight = `${Math.max(30, available - 14)}px`;
    this.menu.style.top = `${upward ? Math.max(4, y - Math.min(menuHeight, available) - 10) : y + cellHeight + 10}px`;
    this.menu.classList.toggle('above', upward);
    this.menu.style.setProperty('--pointer-x', `${Math.min(menuWidth - 18, Math.max(18, left - menuLeft + 12))}px`);
  }
}
