import type { ITheme } from 'ghostty-web';

type ColorRenderer = { rgbToCSS(r: number, g: number, b: number): string };

const linear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const encoded = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

function oklab(r: number, g: number, b: number) {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function srgb(L: number, a: number, b: number) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const hex = (value: string) => parseInt(value.slice(1), 16);

const lightness = (r: number, g: number, b: number) => {
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * 24389 / 27;
};
const luminance = (L: number) => L > 8 ? ((L + 16) / 116) ** 3 : L * 27 / 24389;

// Flips CIE lightness between the theme's text and background while keeping OKLab hue, reducing chroma until the color fits sRGB.
// CIE lightness spreads the near-black shades of dark interfaces evenly, so a raised dark panel becomes a gently shaded light one.
export function flipLightness(r: number, g: number, b: number, theme: ITheme): [number, number, number] {
  const ink = lightness(...channels(hex(theme.foreground!))), paper = lightness(...channels(hex(theme.background!)));
  const L = Math.cbrt(luminance(ink + (paper - ink) * (1 - lightness(r, g, b) / 100)));
  let [, A, B] = oklab(r, g, b);
  for (let step = 0; ; step++) {
    const rgb = srgb(L, A, B);
    if (step === 12 || rgb.every(c => c >= -0.001 && c <= 1.001)) return rgb.map(c => encoded(Math.min(1, Math.max(0, c)))) as [number, number, number];
    A *= 0.85; B *= 0.85;
  }
}

function channels(color: number): [number, number, number] { return [color >> 16 & 255, color >> 8 & 255, color & 255]; }

const cellColors = ['foreground', 'background', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

// Agents in Herdr panes, and programs whose background query goes unanswered, paint for a dark terminal.
// Paper keeps its own palette and flips the lightness of every other color, so dark input boxes, diffs and code blocks render light.
export function adaptDarkAppColors(renderer: ColorRenderer | undefined, theme: ITheme) {
  if (typeof renderer?.rgbToCSS !== 'function') return;
  // Only colors a cell can carry count as the theme's own, so an app's white text still flips even though Paper's cursor accent is white.
  const own = new Set(cellColors.map(name => theme[name]).filter((value): value is string => !!value).map(hex));
  const plain = renderer.rgbToCSS.bind(renderer), flipped = new Map<number, string>();
  renderer.rgbToCSS = (r, g, b) => {
    const key = r << 16 | g << 8 | b;
    if (own.has(key)) return plain(r, g, b);
    let css = flipped.get(key);
    if (css === undefined) { css = plain(...flipLightness(r, g, b, theme)); flipped.set(key, css); }
    return css;
  };
}
