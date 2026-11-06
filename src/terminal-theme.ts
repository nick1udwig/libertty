import {
  ansiNames,
  type RenderColor,
  type RenderColors,
  type TerminalTheme,
} from './terminal-types.ts';
const defaults = [
  '#1d1f21',
  '#cc6666',
  '#b5bd68',
  '#f0c674',
  '#81a2be',
  '#b294bb',
  '#8abeb7',
  '#c5c8c6',
  '#666666',
  '#d57878',
  '#c3ca7c',
  '#f9d78e',
  '#95b6d2',
  '#c6a8cf',
  '#9ed2cb',
  '#ffffff',
];
export function parseColor(value: string | RenderColor): RenderColor {
  if (typeof value !== 'string') return { ...value };
  const hex = /^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length < 5 ? [...hex].map((c) => c + c).join('') : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\((.*)\)$/
    .exec(value)?.[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  if (rgb?.length && rgb.length >= 3 && rgb.every(Number.isFinite))
    return { r: rgb[0], g: rgb[1], b: rgb[2], a: rgb[3] ?? 1 };
  throw new TypeError(`Invalid terminal color: ${value}`);
}
export function resolveTerminalTheme(
  theme: TerminalTheme = {},
): RenderColors & { palette: RenderColor[] } {
  const foreground = parseColor(theme.foreground ?? defaults[7]),
    background = parseColor(theme.background ?? defaults[0]);
  const palette = ansiNames.map((name, i) =>
    parseColor(theme[name] ?? theme.palette?.[i] ?? defaults[i]),
  );
  const levels = [0, 95, 135, 175, 215, 255];
  for (const r of levels) for (const g of levels) for (const b of levels) palette.push({ r, g, b });
  for (let i = 0; i < 24; i++) {
    const v = 8 + 10 * i;
    palette.push({ r: v, g: v, b: v });
  }
  for (let i = 16; i < 256; i++) {
    const explicit = theme.extendedAnsi?.[i - 16] ?? theme.palette?.[i];
    if (explicit) palette[i] = parseColor(explicit);
  }
  return {
    foreground,
    background,
    palette,
    cursor: parseColor(theme.cursor ?? foreground),
    cursorAccent: parseColor(theme.cursorAccent ?? background),
    selectionForeground: theme.selectionForeground ? parseColor(theme.selectionForeground) : null,
    selectionBackground: parseColor(theme.selectionBackground ?? 'rgba(197,200,198,0.3)'),
    selectionInactiveBackground: parseColor(
      theme.selectionInactiveBackground ?? 'rgba(197,200,198,0.15)',
    ),
  };
}
