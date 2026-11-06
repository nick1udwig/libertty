import {
  createCoreRuntime,
  CoreTerminal,
  Events,
  type CoreTerminalOptions,
  type Geometry,
  type InputEvent,
  type PointerInput,
  type TerminalTheme,
} from './terminal-runtime.ts';
import { TerminalPainter, type ScreenMetrics } from './terminal-painter.ts';
export type { Frame } from './terminal-types.ts';
export interface SurfaceOptions extends CoreTerminalOptions {
  container: HTMLElement;
  fontFamily?: string;
  fontSizePx?: number;
}
interface SurfaceEvents {
  input: InputEvent;
  resize: Geometry;
  selectionChange: string;
  scroll: undefined;
  viewportChange: undefined;
  copy: string;
}
export class TerminalSurface extends Events<SurfaceEvents> {
  readonly element: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  readonly backend;
  readonly layout: { metrics: ScreenMetrics };
  private abort = new AbortController();
  private disposed = false;
  private composing = false;
  private compositionCommit = '';
  private wheelRemainder = 0;
  private pending = false;
  private font: { family: string; sizePx: number };
  private accessibility: HTMLDivElement;
  readonly terminal: CoreTerminal;
  private constructor(terminal: CoreTerminal, options: SurfaceOptions) {
    super();
    this.terminal = terminal;
    this.font = { family: options.fontFamily ?? 'monospace', sizePx: options.fontSizePx ?? 14 };
    this.element = document.createElement('div');
    this.element.className = 'terminal-surface';
    const background = document.createElement('canvas'),
      text = document.createElement('canvas');
    background.className = 'terminal-background';
    text.className = 'terminal-text';
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'terminal-input';
    this.textarea.setAttribute('aria-label', 'Terminal input');
    this.textarea.autocapitalize = 'off';
    this.textarea.autocomplete = 'off';
    this.textarea.spellcheck = false;
    this.textarea.setAttribute('autocorrect', 'off');
    this.textarea.setAttribute('data-gramm', 'false');
    this.accessibility = document.createElement('div');
    this.accessibility.className = 'terminal-accessibility';
    this.accessibility.setAttribute('role', 'log');
    this.accessibility.setAttribute('aria-live', 'off');
    this.element.append(background, text, this.textarea, this.accessibility);
    options.container.append(this.element);
    this.layout = { metrics: this.measure() };
    const painter = new TerminalPainter(background, text, this.layout.metrics);
    this.backend = {
      terminal,
      painter,
      pointer: (input: PointerInput) => {
        terminal.sendPointer(input);
        this.schedule();
      },
      pipeline: {
        host: {
          schedule: (callback: () => void) => {
            requestAnimationFrame(callback);
          },
        },
        scheduleRender: () => {
          this.schedule();
        },
      },
    };
    terminal.on('input', (event) => this.emit('input', event));
    terminal.on('resize', (geometry) => this.emit('resize', geometry));
    terminal.on('selectionChange', (text) => this.emit('selectionChange', text));
    this.bindInput();
    terminal.resize(
      terminal.geometry.cols,
      terminal.geometry.rows,
      this.layout.metrics.cellWidth,
      this.layout.metrics.cellHeight,
    );
  }
  static async create(options: SurfaceOptions) {
    const runtime = await createCoreRuntime();
    try {
      return new TerminalSurface(runtime.createTerminal(options), options);
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }
  get geometry() {
    return this.terminal.geometry;
  }
  private measure(): ScreenMetrics {
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1),
      probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `400 ${this.font.sizePx}px ${this.font.family}`;
    const cellWidth = Math.max(1, Math.round(probe.measureText('M').width * ratio)),
      cellHeight = Math.max(1, Math.round(this.font.sizePx * 1.25 * ratio));
    return {
      cellWidth,
      cellHeight,
      width: this.geometry.cols * cellWidth,
      height: this.geometry.rows * cellHeight,
      devicePixelRatio: ratio,
      fontSize: this.font.sizePx * ratio,
      fontFamily: this.font.family,
    };
  }
  private schedule() {
    if (this.pending || this.disposed) return;
    this.pending = true;
    this.backend.pipeline.host.schedule(() => {
      this.pending = false;
      if (this.disposed) return;
      this.backend.painter.render(this.terminal.render());
      const state = this.terminal.bufferState(),
        m = this.layout.metrics;
      this.textarea.style.left = `${(state.cursorX * m.cellWidth) / m.devicePixelRatio}px`;
      this.textarea.style.top = `${(Math.max(0, Math.min(state.rows - 1, state.scrollbackRows + state.cursorY - state.viewportY)) * m.cellHeight) / m.devicePixelRatio}px`;
      this.emit('scroll', undefined);
      this.emit('viewportChange', undefined);
    });
  }
  write(data: string | Uint8Array) {
    this.terminal.write(data);
    this.schedule();
  }
  resize(cols: number, rows: number) {
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    const metrics = this.measure();
    metrics.width = cols * metrics.cellWidth;
    metrics.height = rows * metrics.cellHeight;
    this.layout.metrics = metrics;
    this.terminal.resize(cols, rows, metrics.cellWidth, metrics.cellHeight);
    this.backend.painter.resize(metrics);
    this.schedule();
  }
  async setFont(font: { sizePx?: number; family?: string }) {
    this.font = {
      sizePx: font.sizePx ?? this.font.sizePx,
      family: font.family ?? this.font.family,
    };
    await document.fonts.load(`${this.font.sizePx}px ${this.font.family}`);
    if (!this.disposed) this.resize(this.geometry.cols, this.geometry.rows);
  }
  setTheme(theme: TerminalTheme) {
    this.terminal.setTheme(theme);
    this.schedule();
  }
  focus() {
    this.textarea.focus({ preventScroll: true });
  }
  blur() {
    this.textarea.blur();
  }
  paste(text: string) {
    this.terminal.paste(text);
  }
  sendText(text: string) {
    this.terminal.sendText(text);
  }
  sendPointer(input: PointerInput) {
    this.backend.pointer(input);
  }
  clearSelection() {
    this.terminal.clearSelection();
    this.schedule();
  }
  private bindInput() {
    const signal = this.abort.signal,
      input = this.textarea;
    input.addEventListener(
      'keydown',
      (event) => {
        if (event.isComposing || this.composing || event.key === 'Process') return;
        if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && event.code === 'KeyC') {
          event.preventDefault();
          const text = this.terminal.getSelection();
          if (text) this.emit('copy', text);
          return;
        }
        if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && event.code === 'KeyV') return;
        const printable = [...event.key].length === 1;
        const base = /^Key[A-Z]$/.test(event.code)
          ? event.code.slice(3).toLowerCase()
          : /^Digit[0-9]$/.test(event.code)
            ? event.code.slice(5)
            : undefined;
        const composed =
          printable &&
          !event.metaKey &&
          (event.altKey || event.getModifierState('AltGraph')) &&
          event.key.toLowerCase() !== base;
        if (
          this.terminal.sendKey({
            code: event.code || (printable ? 'Unidentified' : event.key),
            key: event.key,
            action: event.repeat ? 'repeat' : 'press',
            shift: event.shiftKey,
            ctrl: event.ctrlKey && !composed,
            alt: event.altKey && !composed,
            meta: event.metaKey,
            capsLock: event.getModifierState('CapsLock'),
            numLock: event.getModifierState('NumLock'),
          })
        ) {
          event.preventDefault();
          input.value = '';
        }
      },
      { signal },
    );
    input.addEventListener(
      'keyup',
      (event) => {
        if (!event.isComposing && !this.composing)
          this.terminal.sendKey({
            code: event.code,
            key: event.key,
            action: 'release',
            capsLock: event.getModifierState('CapsLock'),
            numLock: event.getModifierState('NumLock'),
            shift: event.shiftKey,
            ctrl: event.ctrlKey,
            alt: event.altKey,
            meta: event.metaKey,
          });
      },
      { signal },
    );
    input.addEventListener(
      'compositionstart',
      () => {
        this.composing = true;
        this.compositionCommit = '';
      },
      { signal },
    );
    input.addEventListener(
      'compositionend',
      (event) => {
        this.composing = false;
        this.compositionCommit = event.data;
        if (event.data) this.sendText(event.data);
        input.value = '';
      },
      { signal },
    );
    input.addEventListener(
      'input',
      (event) => {
        if (this.composing || (event as globalThis.InputEvent).isComposing) return;
        const text = input.value.replace(/^\u200b/, '');
        if (text && text !== this.compositionCommit)
          this.sendText(text.replace(/\r\n|\r|\n/g, '\r'));
        this.compositionCommit = '';
        input.value = '';
      },
      { signal },
    );
    input.addEventListener(
      'paste',
      (event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (text !== undefined) {
          event.preventDefault();
          this.paste(text);
        }
      },
      { signal },
    );
    input.addEventListener(
      'copy',
      (event) => {
        const text = this.terminal.getSelection();
        if (text) {
          event.preventDefault();
          event.clipboardData?.setData('text/plain', text);
        }
      },
      { signal },
    );
    for (const [name, focused] of [
      ['focus', true],
      ['blur', false],
    ] as const)
      input.addEventListener(
        name,
        () => {
          this.backend.painter.setFocused(focused);
          this.terminal.setFocused(focused);
        },
        { signal },
      );
    this.element.addEventListener(
      'wheel',
      (event) => {
        if (!event.deltaY) return;
        event.preventDefault();
        const metrics = this.layout.metrics,
          lineHeight = metrics.cellHeight / metrics.devicePixelRatio;
        this.wheelRemainder +=
          event.deltaMode === 1
            ? event.deltaY
            : event.deltaMode === 2
              ? event.deltaY * this.geometry.rows
              : event.deltaY / lineHeight;
        const lines = Math.trunc(this.wheelRemainder);
        if (!lines) return;
        this.wheelRemainder -= lines;
        const bounds = this.element.getBoundingClientRect();
        this.terminal.sendWheel(
          {
            action: 'press',
            x: (event.clientX - bounds.left) * metrics.devicePixelRatio,
            y: (event.clientY - bounds.top) * metrics.devicePixelRatio,
            shift: event.shiftKey,
            ctrl: event.ctrlKey,
            alt: event.altKey,
            meta: event.metaKey,
          },
          lines,
        );
        this.schedule();
      },
      { signal, passive: false },
    );
    const pointer = (event: PointerEvent, action: PointerInput['action']) => {
      const bounds = this.element.getBoundingClientRect(),
        ratio = this.layout.metrics.devicePixelRatio;
      this.backend.pointer({
        action,
        x: (event.clientX - bounds.left) * ratio,
        y: (event.clientY - bounds.top) * ratio,
        button:
          action === 'motion'
            ? event.buttons & 1
              ? 'left'
              : event.buttons & 2
                ? 'right'
                : event.buttons & 4
                  ? 'middle'
                  : undefined
            : event.button === 1
              ? 'middle'
              : event.button === 2
                ? 'right'
                : 'left',
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
        pressed: !!event.buttons,
        time: event.timeStamp,
      });
    };
    this.element.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'mouse') return;
        event.preventDefault();
        this.focus();
        this.element.setPointerCapture(event.pointerId);
        pointer(event, 'press');
      },
      { signal },
    );
    this.element.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType === 'mouse') pointer(event, 'motion');
      },
      { signal },
    );
    this.element.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerType !== 'mouse') return;
        pointer(event, 'release');
        if (this.element.hasPointerCapture(event.pointerId))
          this.element.releasePointerCapture(event.pointerId);
      },
      { signal },
    );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.backend.painter.dispose();
    this.terminal.dispose();
    this.element.remove();
    this.clear();
  }
}
export const createTerminal = TerminalSurface.create;
export type LocalBackend = TerminalSurface['backend'];
export function rendererPixelRatio(view?: TerminalSurface) {
  return view?.layout?.metrics.devicePixelRatio ?? 1;
}
export function terminalHasTransparency(core: CoreTerminal) {
  return !!core.themeAlpha?.size;
}
