export interface Disposable {
  dispose(): void;
}
export interface RenderColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}
export type CellColor =
  | { mode: 'default' }
  | { mode: 'palette'; value: number }
  | { mode: 'rgb'; value: RenderColor };
export interface CellStyle {
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number;
}
export interface RenderCell {
  x: number;
  text: string;
  width: 'narrow' | 'wide' | 'spacer-head' | 'spacer-tail';
  hyperlink: boolean;
  hyperlinkUri: string | null;
  semanticContent: 'output' | 'input' | 'prompt';
  foreground: RenderColor | null;
  background: RenderColor | null;
  foregroundSource: CellColor;
  backgroundSource: CellColor;
  underlineSource: CellColor;
  underlineColor?: RenderColor | null;
  style: CellStyle;
}
export interface RenderRow {
  y: number;
  text: string;
  cells: RenderCell[];
  wrapped: boolean;
  wrapContinuation: boolean;
  selection: { start: number; end: number } | null;
}
export interface TerminalBufferRow extends RenderRow {
  index: number;
}
export interface RenderColors {
  foreground: RenderColor;
  background: RenderColor;
  cursor: RenderColor | null;
  cursorAccent: RenderColor;
  selectionForeground: RenderColor | null;
  selectionBackground: RenderColor;
  selectionInactiveBackground: RenderColor;
}
export interface RenderCursor {
  x: number | null;
  y: number | null;
  visible: boolean;
  blinking: boolean;
  style: 'bar' | 'block' | 'underline' | 'block-hollow';
  passwordInput: boolean;
}
export interface RenderFrame {
  cols: number;
  rows: number;
  dirty: 'clean' | 'partial' | 'full';
  changedRows: RenderRow[];
  cursor: RenderCursor;
  colors: RenderColors;
}
export interface ViewportSnapshot {
  cols: number;
  rows: number;
  viewportRows: RenderRow[];
  cursor: RenderCursor;
  colors: RenderColors;
}
export type Frame = RenderFrame | ViewportSnapshot;
export interface BufferState {
  revision: number;
  cols: number;
  rows: number;
  totalRows: number;
  scrollbackRows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  screen: 'normal' | 'alternate';
}
export interface Geometry {
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}
export type InputSource = 'keyboard' | 'text' | 'paste' | 'mouse' | 'focus' | 'reply';
export interface InputEvent {
  source: InputSource;
  data: Uint8Array;
}
export interface SemanticEvent {
  kind: number;
  promptKind: number;
  command?: string;
  exitCode?: number;
  error?: string;
}
export const ansiNames = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;
export type TerminalTheme = Partial<
  Record<
    | (typeof ansiNames)[number]
    | 'foreground'
    | 'background'
    | 'cursor'
    | 'cursorAccent'
    | 'selectionForeground'
    | 'selectionBackground'
    | 'selectionInactiveBackground',
    string | RenderColor
  >
> & {
  palette?: (string | RenderColor)[];
  extendedAnsi?: (string | RenderColor)[];
  appearance?: 'dark' | 'light';
};
export interface CoreTerminalOptions {
  cols?: number;
  rows?: number;
  scrollbackLines?: number;
  theme?: TerminalTheme;
  defaultCursorBlink?: boolean;
}
export interface CoreRuntimeOptions {
  wasm?: BufferSource;
}
export interface PointerInput {
  x: number;
  y: number;
  action: 'press' | 'release' | 'motion';
  button?: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  pressed?: boolean;
  time?: number;
}
export interface KeyInput {
  capsLock?: boolean;
  numLock?: boolean;
  code: string;
  key?: string;
  action?: 'press' | 'repeat' | 'release';
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}
