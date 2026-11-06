import { repairChoices, type PreparedChoice } from './repair-choices.ts';
import { SuggestionView } from './suggestion-view.ts';
import { SuggestionInput } from './suggestion-input.ts';
import type { Terminal } from './terminal-adapter.ts';
import type { ShellState, RepairIntent, RepairResult } from './protocol.ts';
import { InputLine } from './input-line.ts';
import { saved } from './persistence.ts';
import { TerminalPresentation } from './terminal-presentation.ts';
import { cursorSteps } from './touch-cursor.ts';
import {
  defaultReadingPhrases,
  readingPhrases,
  readingPipeline,
  readingRequest,
} from './reading-request.ts';
interface Host {
  state(): ShellState;
  replace(text: string): Promise<boolean>;
  readLine?(): Promise<{ text: string; cursor: number } | undefined>;
  repair(text: string, intent: RepairIntent, signal: AbortSignal): Promise<RepairResult>;
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
  private choices: PreparedChoice[] = [];
  private phrases = [...defaultReadingPhrases];
  private selected = '';
  private prefix = '';
  private suffix = '';
  private speech = '';
  private phase: 'idle' | 'transcribing' | 'repairing' | 'ready' = 'idle';
  private get loading() {
    return this.phase === 'repairing';
  }
  private get transcribing() {
    return this.phase === 'transcribing';
  }
  private pendingPresentation?: TerminalPresentation;
  private pendingCursor?: { x: number; row: number };
  private literalReplacement?: Promise<boolean>;
  private application?: Promise<RepairResult>;
  private flushing?: string[];
  private suspendedRevision: number | undefined;
  private retryOnResume = false;
  private open = false;
  private autoOpen = true;
  private tapToSend = true;
  private capture: SuggestionInput;
  private positionFrame = 0;
  private view: SuggestionView;
  private status = document.getElementById('suggestion-status')!;
  private term: Terminal;
  private host: Host;
  constructor(term: Terminal, host: Host) {
    this.term = term;
    this.host = host;
    this.view = new SuggestionView(
      term,
      () => ({
        literal: this.literal,
        loading: this.loading,
        transcribing: this.transcribing,
        open: this.open,
        choices: this.choices,
        selected: this.selected,
        pendingPresentation: this.pendingPresentation,
        pendingCursor: this.pendingCursor,
      }),
      {
        state: () => host.state(),
        refresh: () => this.refresh(),
        choose: (text) => this.choose(text),
      },
    );
    this.pendingPresentation = new TerminalPresentation(
      document.getElementById('terminal-viewport')!,
      () => {
        this.pendingCursor = undefined;
        this.render();
      },
      false,
    );
    this.phrases = readingPhrases(saved<unknown>('readingPhrases', null));
    const setting = document.getElementById('auto-alternatives') as HTMLInputElement;
    try {
      this.autoOpen =
        localStorage.getItem('libertty.autoAlternatives') !== 'false' &&
        localStorage.getItem('libertty.justRun') !== 'true';
    } catch {}
    setting.checked = this.autoOpen;
    setting.onchange = () => {
      this.autoOpen = setting.checked;
      try {
        localStorage.setItem('libertty.autoAlternatives', String(this.autoOpen));
        localStorage.removeItem('libertty.justRun');
      } catch {}
      this.open = this.autoOpen;
      this.render();
    };
    const tapSetting = document.getElementById('tap-alternate-send') as HTMLInputElement;
    try {
      this.tapToSend = localStorage.getItem('libertty.tapAlternateSend') !== 'false';
    } catch {}
    tapSetting.checked = this.tapToSend;
    tapSetting.onchange = () => {
      this.tapToSend = tapSetting.checked;
      try {
        localStorage.setItem('libertty.tapAlternateSend', String(this.tapToSend));
      } catch {}
    };
    document.addEventListener('pointerdown', (event) => {
      if (
        !this.view.menu.contains(event.target as Node) &&
        !this.view.toggle.contains(event.target as Node)
      )
        this.collapse();
    });
    this.view.toggle.addEventListener('pointerdown', (e) => e.preventDefault());
    this.view.toggle.onclick = () => {
      this.open = !this.open;
      this.render();
    };
    term.onCursorMove(() => this.refresh());
    term.onScroll(() => this.refresh());
    const container = document.getElementById('terminal')!;
    const resize = new ResizeObserver(() => this.refresh());
    resize.observe(container);
    resize.observe(this.view.menu);
    window.visualViewport?.addEventListener('resize', () => this.refresh());
    this.capture = new SuggestionInput(term, {
      line: this.line,
      state: () => host.state(),
      flushing: () => !!this.flushing,
      clear: () => this.clear(),
      raw: (data) => host.raw(data),
      dictate: (text, replacement, applied) => this.nativeDictation(text, replacement, applied),
    });
  }
  private armInput() {
    this.capture.armInput();
  }
  private collapse() {
    if (this.open) {
      this.open = false;
      this.render();
    }
  }
  setReadingPhrases(value: unknown) {
    this.phrases = readingPhrases(value);
  }
  onState(state: ShellState) {
    if (this.suspendedRevision !== undefined) {
      const intact =
        state.ready &&
        !state.exited &&
        state.prompt === this.prompt &&
        state.inputRevision === this.suspendedRevision;
      const retry = this.retryOnResume,
        open = this.open;
      this.suspendedRevision = undefined;
      this.retryOnResume = false;
      if (intact) {
        if (retry) {
          void this.dictate(this.speech, true);
          this.open = open;
          this.render();
        } else this.refresh();
        return;
      }
    }
    if (state.prompt !== this.prompt) {
      this.clear();
      this.prompt = state.prompt;
      this.line.reset();
      this.line.known = state.ready && state.inputRevision === state.promptRevision;
    } else if (!state.ready || state.exited) {
      if (state.exited || state.inputTarget !== 'program' || !this.transcribing) this.clear();
      this.line.known = false;
    }
  }
  disconnect() {
    this.clear();
    this.line.known = false;
    this.prompt = -1;
  }
  prepareExternalPaste() {
    this.clear();
  }
  dictationPending(pending: boolean) {
    if (pending) {
      this.clear(true);
      this.phase = 'transcribing';
      this.holdInput();
      this.status.textContent = 'Transcribing';
    } else {
      if (this.transcribing) this.phase = this.literal ? 'ready' : 'idle';
      if (!this.loading) this.pendingPresentation?.reveal();
    }
    this.render();
  }
  private holdInput() {
    if (!this.pendingPresentation) return;
    const buffer = this.term.buffer.active;
    this.pendingPresentation.freeze();
    if (this.pendingPresentation.pending)
      this.pendingCursor ||= {
        x: buffer.cursorX,
        row: buffer.baseY + buffer.cursorY - buffer.viewportY,
      };
  }
  private async nativeDictation(text: string, replacement: boolean, alreadyApplied = false) {
    if (this.host.dictate) {
      const replace = replacement && !!this.literal;
      this.dictationPending(true);
      this.host.dictate(text, alreadyApplied, replace);
      return;
    }
    if (this.line.known) return this.dictate(text, replacement, alreadyApplied);
    if (!this.host.readLine) {
      if (!alreadyApplied) this.term.paste(text);
      return;
    }
    this.clear();
    const request = this.generation;
    this.flushing = [];
    let line: { text: string; cursor: number } | undefined;
    try {
      line = await this.host.readLine();
    } catch {
      /* Preserve input when the snapshot is unavailable. */
    }
    const queued = this.flushing?.join('') || '';
    this.flushing = undefined;
    if (request !== this.generation || !this.host.state().ready || this.host.state().exited) return;
    if (!line) {
      if (!alreadyApplied) this.term.paste(text);
      if (queued) this.host.raw(queued);
      return;
    }
    this.line.reset(line.text);
    this.line.cursor = line.cursor;
    if (queued) {
      if (!alreadyApplied) this.term.paste(text);
      this.host.raw(queued);
      return;
    }
    if (alreadyApplied) {
      // The authoritative snapshot includes the backend's inserted transcript.
      this.line.reset();
      return this.dictate(line.text, false, true);
    }
    return this.dictate(text, replacement);
  }
  externalPaste(text: string, replace: boolean, dictated = false, isolated = false) {
    this.clear();
    if (!this.host.state().ready || this.host.state().exited) {
      this.line.known = false;
      return;
    }
    if (isolated && dictated) this.line.reset();
    if (dictated && !replace && !this.line.known) return this.nativeDictation(text, false, true);
    if (
      dictated &&
      !replace &&
      this.line.known &&
      this.host.state().ready &&
      !this.host.state().exited
    ) {
      // The backend has already inserted this text. Reuse dictation's repair and
      // choice flow, without sending the literal transcript back for insertion.
      return this.dictate(text, false, true);
    }
    if (replace) this.line.reset(text);
    else if (this.line.known) this.line.insert(text);
  }
  backendLoading(text: string, isolated = false) {
    this.clear(true);
    if (!this.host.state().ready || this.host.state().exited) {
      this.disconnect();
      return;
    }
    if (this.line.known) this.line.insert(text);
    if (isolated) this.line.reset(text);
    this.literal = this.line.known ? this.line.text : text;
    this.speech = text;
    this.selected = this.literal;
    this.phase = 'repairing';
    this.open = this.autoOpen;
    this.status.textContent = 'Finding alternatives';
    this.render();
  }
  backendResult(result: RepairResult) {
    if (!result.accepted) {
      if (result.error && this.literal && (this.line.known || result.original)) {
        if (result.original) this.literal = result.original;
        if (this.line.text !== this.literal) this.line.known = false;
        this.selected = this.literal;
        this.choices = repairChoices(
          { ...result, original: this.literal, candidates: [], choices: [] },
          this.phrases,
        );
        this.phase = 'ready';
        this.open = this.autoOpen;
        this.status.textContent = 'Alternatives unavailable. Original text kept.';
        this.pendingPresentation?.reveal();
        this.render();
      } else this.clear();
      return;
    }
    this.literal = result.original;
    this.selected = result.selected;
    this.line.reset(result.selected);
    this.choices = repairChoices(result, this.phrases);
    this.phase = this.literal ? 'ready' : 'idle';
    this.open = this.autoOpen;
    this.status.textContent = 'Alternatives ready';
    this.pendingPresentation?.reveal();
    this.render();
  }
  suspend() {
    if (!this.literal) {
      this.disconnect();
      return;
    }
    if (this.suspendedRevision !== undefined) return;
    this.suspendedRevision = this.host.state().inputRevision;
    this.retryOnResume = this.loading;
    ++this.generation;
    this.controller?.abort();
    this.controller = undefined;
    this.phase = this.literal ? 'ready' : 'idle';
    this.render();
  }
  refresh() {
    if ((!this.literal && !this.transcribing) || this.positionFrame) return;
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = 0;
      this.position();
    });
  }
  get predictionReady() {
    return (
      this.line.known &&
      this.line.cursor === this.line.text.length &&
      !this.loading &&
      !this.transcribing &&
      !this.capture.composing &&
      !this.flushing
    );
  }
  raw(data: string): boolean {
    queueMicrotask(() => this.armInput());
    if (data === '\x1b[I' || data === '\x1b[O') return true;
    if (this.transcribing) this.clear();
    if (this.flushing) {
      this.flushing.push(data);
      return false;
    }
    if (this.loading) {
      const literal = this.literal,
        pending = this.literalReplacement,
        application = this.application;
      this.flushing = [data];
      this.clear();
      const restored = application
        ? application.catch(() => undefined).then(() => this.host.replace(literal))
        : pending || this.host.replace(literal);
      void restored
        .then((accepted) => {
          const input = this.flushing?.join('') || '';
          this.flushing = undefined;
          if (accepted) {
            this.line.reset(literal);
            this.host.raw(input);
          } else this.disconnect();
        })
        .catch(() => {
          this.flushing = undefined;
          this.disconnect();
        });
      return false;
    }
    if (data === '\r' && this.line.known && this.host.state().ready) {
      const pipeline = readingPipeline(this.line.text, this.phrases || defaultReadingPhrases);
      if (pipeline) {
        this.host.execute(pipeline.command + ' | look at');
        return false;
      }
      const request = readingRequest(this.line.text, this.phrases || defaultReadingPhrases);
      if (request) {
        this.openRead(request.operand);
        return false;
      }
    }
    // Escape dismisses this UI, without leaving Readline waiting for a Meta key.
    if (data === '\x1b' && this.literal) {
      this.collapse();
      return false;
    }
    // Moving the cursor or dismissing the menu does not discard the alternatives.
    if (/^(\x1b\[[CDHF]|[\x01\x02\x05\x06])$/.test(data)) {
      this.line.feed(data);
      this.collapse();
      return true;
    }
    this.clear();
    this.line.feed(data);
    return true;
  }
  private clear(keepPresentation = false) {
    this.application = undefined;
    this.literalReplacement = undefined;
    const visible =
      !!this.literal || this.loading || this.transcribing || this.open || !!this.choices.length;
    ++this.generation;
    this.controller?.abort();
    this.literal = '';
    this.speech = '';
    this.choices = [];
    this.suspendedRevision = undefined;
    this.retryOnResume = false;
    this.phase = this.literal ? 'ready' : 'idle';
    this.open = false;
    if (!keepPresentation) this.pendingPresentation?.reveal();
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    this.positionFrame = 0;
    if (visible) this.render();
  }
  moveCursor(x: number, y: number) {
    const buffer = this.term.buffer.active,
      screen = this.term.screen;
    if (
      !screen ||
      !this.line.known ||
      !this.host.state().ready ||
      this.loading ||
      this.capture.composing ||
      buffer.type !== 'normal' ||
      this.term.getViewportY() > 0
    )
      return;
    const bounds = screen.getBoundingClientRect();
    const col = Math.floor((x - bounds.left) / (bounds.width / this.term.cols));
    const row = Math.floor((y - bounds.top) / (bounds.height / this.term.rows));
    if (col < 0 || col >= this.term.cols || row < 0 || row >= this.term.rows) return;
    const steps = cursorSteps(
      this.line.text,
      this.line.cursor,
      buffer.cursorY * this.term.cols + buffer.cursorX,
      row * this.term.cols + col,
      this.term.cols,
      (at) =>
        buffer
          .getLine(buffer.baseY + Math.floor(at / this.term.cols))
          ?.getCell(at % this.term.cols),
    );
    if (steps === undefined) return;
    for (let i = 0; i < Math.abs(steps); i++) this.host.raw(steps < 0 ? '\x1b[D' : '\x1b[C');
    this.term.focus();
  }
  private async dictate(text: string, replacement: boolean, alreadyApplied = false) {
    if (!this.literal) {
      this.prefix = this.line.text.slice(0, this.line.cursor);
      this.suffix = this.line.text.slice(this.line.cursor);
      this.speech = text;
    } else this.speech = replacement ? text : this.speech + text;
    this.literal = this.prefix + this.speech + this.suffix;
    if (this.literal.length > 2000) {
      if (alreadyApplied) this.line.insert(text);
      this.clear();
      if (!alreadyApplied) this.host.raw(text);
      return;
    }
    this.controller?.abort();
    this.controller = new AbortController();
    this.literalReplacement = alreadyApplied ? Promise.resolve(true) : undefined;
    const request = ++this.generation,
      prompt = this.host.state().prompt;
    const reading = readingRequest(this.literal, this.phrases || defaultReadingPhrases, true);
    const pipeline = readingPipeline(this.literal, this.phrases || defaultReadingPhrases, true);
    this.phase = 'repairing';
    this.open = this.autoOpen;
    this.choices = [];
    this.selected = this.literal;
    this.holdInput();
    this.line.reset(this.literal);
    this.status.textContent = 'Finding alternatives';
    this.render();
    try {
      const intent: RepairIntent = pipeline
        ? { kind: 'reading-pipeline', ...pipeline }
        : reading
          ? { kind: 'reading-file', phrase: reading.phrase, operand: reading.operand }
          : { kind: 'shell' };
      this.application = this.host.repair(this.literal, intent, this.controller.signal);
      const result = await this.application;
      if (
        request !== this.generation ||
        prompt !== this.host.state().prompt ||
        !this.host.state().ready
      )
        return;
      this.application = undefined;
      if (!result.accepted) {
        if (result.error) throw new Error(result.error);
        this.disconnect();
        return;
      }
      this.backendResult(result);
    } catch (error: any) {
      if (request !== this.generation || error.name === 'AbortError') return;
      if (!(await (this.literalReplacement || this.host.replace(this.literal)))) {
        if (request === this.generation) this.disconnect();
        return;
      }
      if (request !== this.generation) return;
      this.phase = this.literal ? 'ready' : 'idle';
      this.open = true;
      this.pendingPresentation?.reveal();
      this.choices = repairChoices(
        { original: this.literal, candidates: [], choices: [] },
        this.phrases,
      );
      this.status.textContent = 'Alternatives unavailable. Original text kept.';
      this.render();
    }
  }
  private async choose(id: string) {
    const choice = this.choices.find((choice) => choice.id === id);
    if (!choice) return;
    const { text, action } = choice;
    if (action.kind === 'reading-file') {
      this.openRead(action.operand);
      return;
    }
    if (action.kind === 'reading-pipeline') {
      this.host.execute(action.command + ' | look at');
      return;
    }
    if (this.tapToSend) {
      this.host.execute(text);
      return;
    }
    const request = ++this.generation;
    this.controller?.abort();
    this.phase = this.literal ? 'ready' : 'idle';
    this.collapse();
    this.line.reset(text);
    if ((await this.host.replace(text)) && request === this.generation) {
      this.selected = text;
      this.line.reset(text);
      this.open = false;
      this.render();
    }
  }
  private openRead(operand: string) {
    this.host.execute('look at ' + operand);
  }
  private render() {
    this.armInput();
    this.view.render();
  }
  private position() {
    this.view.position();
  }
}
