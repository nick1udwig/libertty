import { resolveTerminalTheme } from './terminal-theme.ts';
import type {
  BufferState,
  CoreRuntimeOptions,
  CoreTerminalOptions,
  Disposable,
  Geometry,
  InputEvent,
  InputSource,
  KeyInput,
  PointerInput,
  RenderCell,
  RenderFrame,
  RenderRow,
  SemanticEvent,
  TerminalBufferRow,
  TerminalTheme,
  ViewportSnapshot,
} from './terminal-types.ts';
export * from './terminal-types.ts';
export { resolveTerminalTheme } from './terminal-theme.ts';
export const GHOSTTY_BUILD = {
  ghosttyCommit: '521cf2c5d30bd48028ca61546c64e7913764073d',
  sha256: '2df71ddca19a1750a706b736b7b7ad9c3f878a5637a5a9c213599d64d31790b5',
};
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  terminal_init(): void;
  terminal_alloc(length: number): number;
  terminal_free(pointer: number, length: number): void;
  terminal_request(pointer: number, length: number): number;
  terminal_write(id: number, pointer: number, length: number): number;
  terminal_snapshot(id: number): number;
  terminal_restore(id: number, pointer: number, length: number): number;
  terminal_output_length(): number;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export class Events<T extends object> {
  private listeners: { [K in keyof T]?: Set<(value: T[K]) => void> } = {};
  on<K extends keyof T>(name: K, callback: (value: T[K]) => void): Disposable {
    const set = (this.listeners[name] ??= new Set());
    set.add(callback);
    return {
      dispose: () => {
        set.delete(callback);
      },
    };
  }
  emit<K extends keyof T>(name: K, value: T[K]) {
    for (const callback of this.listeners[name] ?? []) callback(value);
  }
  clear() {
    this.listeners = {};
  }
}
type PackedRow = Omit<TerminalBufferRow, 'cells'> & {
  cells: [string, number, number, string | null, number][];
  styles: Pick<
    RenderCell,
    | 'style'
    | 'foreground'
    | 'background'
    | 'foregroundSource'
    | 'backgroundSource'
    | 'underlineSource'
    | 'underlineColor'
  >[];
};
function decodeRow(row: PackedRow): TerminalBufferRow {
  const { cells, styles, ...metadata } = row;
  return {
    ...metadata,
    cells: cells.map(([text, width, style, uri, semantic], x) => ({
      ...styles[style],
      x,
      text,
      width: (['narrow', 'wide', 'spacer-tail', 'spacer-head'] as const)[width],
      hyperlink: uri !== null,
      hyperlinkUri: uri,
      semanticContent: (['output', 'input', 'prompt'] as const)[semantic],
    })),
  };
}
export class CoreRuntime {
  readonly terminals = new Map<number, CoreTerminal>();
  readonly exports: Exports;
  constructor(exports: Exports) {
    this.exports = exports;
    exports.terminal_init();
  }
  transfer<T>(bytes: Uint8Array, operation: (pointer: number, length: number) => number): T {
    const e = this.exports,
      pointer = e.terminal_alloc(bytes.length);
    try {
      new Uint8Array(e.memory.buffer, pointer, bytes.length).set(bytes);
      const output = operation(pointer, bytes.length);
      const result = JSON.parse(
        decoder.decode(new Uint8Array(e.memory.buffer, output, e.terminal_output_length())),
      );
      if (result.error) throw new Error(result.error);
      return result.value as T;
    } finally {
      e.terminal_free(pointer, bytes.length);
    }
  }
  request<T>(value: object): T {
    return this.transfer(encoder.encode(JSON.stringify(value)), (p, n) =>
      this.exports.terminal_request(p, n),
    );
  }
  createTerminal(options: CoreTerminalOptions = {}) {
    const terminal = new CoreTerminal(this, options);
    this.terminals.set(terminal.id, terminal);
    return terminal;
  }
  dispose() {
    for (const terminal of this.terminals.values()) terminal.dispose();
  }
}
let browserModule: Promise<WebAssembly.Module> | undefined;
async function terminalModule(wasm?: BufferSource) {
  if (wasm) return WebAssembly.compile(wasm);
  return (browserModule ??= fetch(new URL('./generated/terminal.wasm', import.meta.url))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Terminal download failed: ${response.status}`);
      try {
        return await WebAssembly.compileStreaming(response.clone());
      } catch {
        // Local servers can omit the WASM MIME type required for streaming compilation.
      }
      return WebAssembly.compile(await response.arrayBuffer());
    })
    .catch((error) => {
      browserModule = undefined;
      throw error;
    }));
}
export async function createCoreRuntime(options: CoreRuntimeOptions = {}) {
  let exports: Exports;
  const instance = await WebAssembly.instantiate(await terminalModule(options.wasm), {
    env: {
      crypto_getrandom: (pointer: number, length: number) => {
        const bytes = new Uint8Array(exports.memory.buffer, pointer, length);
        for (let start = 0; start < length; start += 65536)
          crypto.getRandomValues(bytes.subarray(start, start + 65536));
        return 1;
      },
    },
  });
  exports = instance.exports as Exports;
  return new CoreRuntime(exports);
}
interface TerminalEvents {
  input: InputEvent;
  render: RenderFrame;
  semantic: SemanticEvent;
  reset: undefined;
  resize: Geometry;
  selectionChange: string;
  scroll: BufferState;
}
export class CoreTerminal extends Events<TerminalEvents> {
  readonly id: number;
  geometry: Geometry;
  theme: Readonly<TerminalTheme>;
  themeAlpha = new Map<string, number>();
  private state: BufferState;
  private resolved = resolveTerminalTheme();
  private disposed = false;
  private selecting = false;
  readonly runtime: CoreRuntime;
  constructor(runtime: CoreRuntime, options: CoreTerminalOptions) {
    super();
    this.runtime = runtime;
    this.geometry = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    };
    this.theme = options.theme ?? {};
    resolveTerminalTheme(this.theme);
    this.id = runtime.request({
      op: 'create',
      ...this.geometry,
      scrollback: options.scrollbackLines ?? 5000,
    });
    this.state = this.call('state');
    this.setTheme(this.theme);
  }
  call<T>(op: string, values: object = {}): T {
    if (this.disposed) throw new Error('Terminal disposed');
    return this.runtime.request<T>({ op, id: this.id, ...values });
  }
  bufferState() {
    return this.state;
  }
  write(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const result = this.runtime.transfer<{
      state: BufferState;
      events: (
        | { type: 'input'; source: InputSource; data: number[] }
        | ({ type: 'semantic' } & SemanticEvent)
        | { type: 'reset' }
      )[];
    }>(bytes, (p, n) => this.runtime.exports.terminal_write(this.id, p, n));
    this.state = result.state;
    for (const event of result.events) {
      if (event.type === 'input')
        this.emit('input', { source: event.source, data: Uint8Array.from(event.data) });
      else if (event.type === 'semantic') this.emit('semantic', event);
      else this.emit('reset', undefined);
    }
  }
  resize(
    cols: number,
    rows: number,
    cellWidthPx = this.geometry.cellWidthPx,
    cellHeightPx = this.geometry.cellHeightPx,
  ) {
    this.state = this.call('resize', {
      cols,
      rows,
      cellWidth: cellWidthPx,
      cellHeight: cellHeightPx,
    });
    this.geometry = { cols, rows, cellWidthPx, cellHeightPx };
    this.emit('resize', this.geometry);
  }
  scrollLines(delta: number) {
    this.state = this.call('scroll', { delta });
    this.emit('scroll', this.state);
  }
  isMode(mode: number, ansi = false) {
    return this.call<boolean>('mode', { mode: mode | (ansi ? 0x8000 : 0) });
  }
  readBuffer({ start = 0, end = this.state.totalRows } = {}) {
    return {
      state: this.state,
      rows: this.call<PackedRow[]>('rows', { start, end }).map(decodeRow),
    };
  }
  retainedRowChanges() {
    return this.call<{ state: BufferState; reset: boolean; trimmed: number; dirtyFrom: number }>(
      'changes',
    );
  }
  getPalette() {
    return this.call<import('./terminal-types.ts').RenderColor[]>('palette');
  }
  setTheme(theme: TerminalTheme) {
    this.theme = Object.freeze({ ...theme });
    const colors = (this.resolved = resolveTerminalTheme(this.theme));
    this.themeAlpha.clear();
    for (const color of [colors.foreground, colors.background, ...colors.palette])
      if (color.a !== undefined && color.a < 1)
        this.themeAlpha.set(`${color.r}:${color.g}:${color.b}`, color.a);
    const preserved = Array.from({ length: 256 }, (_, i) => i).filter(
      (i) =>
        this.theme.palette?.[i] !== undefined ||
        (i >= 16 && this.theme.extendedAnsi?.[i - 16] !== undefined),
    );
    const background = colors.background;
    const harmonious =
      this.theme.appearance === 'light' ||
      (this.theme.appearance === undefined &&
        background.r * 0.299 + background.g * 0.587 + background.b * 0.114 > 127.5);
    colors.palette = this.call<import('./terminal-types.ts').RenderColor[]>('theme', {
      ...colors,
      preserved,
      harmonious,
    }).map((color, i) => ({ ...color, a: colors.palette[i].a ?? 1 }));
  }
  private frame(full: boolean): RenderFrame {
    const packed = this.call<
      Omit<RenderFrame, 'cols' | 'rows' | 'changedRows'> & { changedRows: PackedRow[] }
    >('render', { full });
    const frame = { ...packed, changedRows: packed.changedRows.map(decodeRow) as RenderRow[] };
    const colors = this.resolved;
    for (const name of ['foreground', 'background', 'cursor'] as const) {
      const value = frame.colors[name];
      if (value) frame.colors[name] = { ...value, a: colors[name]?.a ?? 1 };
    }
    for (const row of frame.changedRows)
      for (const cell of row.cells)
        for (const name of ['foreground', 'background'] as const) {
          const value = cell[name];
          if (value) {
            const a = this.themeAlpha.get(`${value.r}:${value.g}:${value.b}`);
            if (a !== undefined) cell[name] = { ...value, a };
          }
        }
    return {
      ...frame,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
      colors: { ...colors, ...frame.colors },
    };
  }
  render() {
    const frame = this.frame(false);
    this.emit('render', frame);
    return frame;
  }
  viewport(): ViewportSnapshot {
    const { changedRows, ...frame } = this.frame(true);
    return { ...frame, viewportRows: changedRows };
  }
  snapshot() {
    const e = this.runtime.exports,
      pointer = e.terminal_snapshot(this.id);
    if (!pointer) throw new Error('Cannot snapshot terminal');
    return new Uint8Array(e.memory.buffer, pointer, e.terminal_output_length()).slice();
  }
  restore(bytes: Uint8Array) {
    this.state = this.runtime.transfer(bytes, (p, n) =>
      this.runtime.exports.terminal_restore(this.id, p, n),
    );
    this.geometry = this.call<Geometry>('geometry');
    this.setTheme(this.theme);
    this.emit('reset', undefined);
  }
  input(data: string | Uint8Array, source: InputSource) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (bytes.length) this.emit('input', { source, data: bytes });
  }
  sendKey(input: KeyInput) {
    const text = input.key && [...input.key].length === 1 ? input.key : '';
    const mods =
      (input.shift ? 1 : 0) |
      (input.ctrl ? 2 : 0) |
      (input.alt ? 4 : 0) |
      (input.meta ? 8 : 0) |
      (input.capsLock ? 16 : 0) |
      (input.numLock ? 32 : 0);
    const bytes = this.call<number[]>('key', {
      code: input.code,
      text,
      mods,
      consumed: 0,
      unshifted: input.code.startsWith('Key')
        ? input.code.slice(3).toLowerCase().codePointAt(0)
        : text.toLowerCase().codePointAt(0),
      action: input.action === 'release' ? 0 : input.action === 'repeat' ? 2 : 1,
    });
    this.input(Uint8Array.from(bytes), 'keyboard');
    return bytes.length > 0;
  }
  text(text: string) {
    this.sendText(text);
  }
  sendText(text: string) {
    this.input(text, 'text');
  }
  paste(text: string) {
    this.input(Uint8Array.from(this.call<number[]>('paste', { text })), 'paste');
  }
  setFocused(focused: boolean) {
    if (this.isMode(1004)) this.input(focused ? '\x1b[I' : '\x1b[O', 'focus');
  }
  sendPointer(input: PointerInput) {
    const mouse = [9, 1000, 1002, 1003].some((mode) => this.isMode(mode));
    if (mouse && !input.shift) {
      const g = this.geometry;
      this.input(
        Uint8Array.from(
          this.call<number[]>('pointer', {
            ...input,
            action: { press: 0, release: 1, motion: 2 }[input.action],
            button: input.button
              ? { left: 1, middle: 3, right: 2, 'wheel-up': 4, 'wheel-down': 5 }[input.button]
              : null,
            mods:
              (input.shift ? 1 : 0) |
              (input.ctrl ? 2 : 0) |
              (input.alt ? 4 : 0) |
              (input.meta ? 8 : 0),
            width: g.cols * g.cellWidthPx,
            height: g.rows * g.cellHeightPx,
            cellWidth: g.cellWidthPx,
            cellHeight: g.cellHeightPx,
          }),
        ),
        'mouse',
      );
      return;
    }
    if (input.button && input.button !== 'left') return;
    if (input.action === 'press') this.selecting = true;
    if (!this.selecting) return;
    this.call('select', {
      action: input.action,
      x: input.x,
      y: input.y,
      cellWidth: this.geometry.cellWidthPx,
      height: this.geometry.rows * this.geometry.cellHeightPx,
      repeatDistance: 5 * (globalThis.devicePixelRatio || 1),
      rectangle: input.alt,
      col: Math.max(0, Math.floor(input.x / this.geometry.cellWidthPx)),
      row: Math.max(0, Math.floor(input.y / this.geometry.cellHeightPx)),
      time: input.time ?? performance.now(),
    });
    if (input.action === 'release') this.selecting = false;
    this.emit('selectionChange', this.getSelection());
  }
  sendWheel(input: PointerInput, lines: number) {
    if (!input.shift && [9, 1000, 1002, 1003].some((mode) => this.isMode(mode)))
      this.sendPointer({
        ...input,
        action: 'press',
        button: lines < 0 ? 'wheel-up' : 'wheel-down',
      });
    else this.scrollLines(lines);
  }
  getSelection() {
    return this.call<string>('selection');
  }
  clearSelection() {
    this.call('select', { action: 'clear' });
    this.emit('selectionChange', '');
  }
  memoryUsage() {
    return this.call<import('./terminal-memory.ts').TerminalMemory>('memory');
  }
  dispose() {
    if (this.disposed) return;
    this.call('dispose');
    this.disposed = true;
    this.runtime.terminals.delete(this.id);
    this.clear();
  }
}
