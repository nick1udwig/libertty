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
function normalizeColor({ r, g, b, a = 1 }: RenderColor): RenderColor {
  if ([r, g, b].some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255))
    throw new TypeError('Terminal RGB channels must be finite numbers from 0 to 255');
  if (!Number.isFinite(a) || a < 0 || a > 1)
    throw new TypeError('Terminal alpha must be a finite number from 0 to 1');
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
}
export function parseColor(value: string | RenderColor): RenderColor {
  if (typeof value !== 'string') return normalizeColor(value);
  value = value.trim();
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
  const functional = /^(rgba?)\((.*)\)$/i.exec(value);
  if (functional) {
    const body = functional[2],
      comma = body.includes(',');
    const parts = body.split(comma ? ',' : '/').map((part) => part.trim());
    const channels = comma ? parts.slice(0, 3) : parts[0].split(/\s+/);
    const opacity = parts[comma ? 3 : 1];
    if (
      channels.length !== 3 ||
      parts.length > (comma ? 4 : 2) ||
      (functional[1].toLowerCase() === 'rgba' && opacity === undefined)
    )
      throw new TypeError(`Invalid terminal color: ${value}`);
    const component = (channel: string, maximum: number) => {
      if (!channel || channel === '%') throw new TypeError(`Invalid terminal color: ${value}`);
      return channel.endsWith('%')
        ? (Number(channel.slice(0, -1)) * maximum) / 100
        : Number(channel);
    };
    return normalizeColor({
      r: component(channels[0], 255),
      g: component(channels[1], 255),
      b: component(channels[2], 255),
      a: opacity === undefined ? 1 : component(opacity, 1),
    });
  }
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
