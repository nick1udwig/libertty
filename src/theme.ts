import type { ITheme } from 'ghostty-web';
import { saved } from './persistence.ts';

export const themeChoices = ['forest', 'paper', 'ink', '1776', 'flag', 'auto'] as const;
export type ThemeChoice = (typeof themeChoices)[number];
export type ThemeName = Exclude<ThemeChoice, 'auto'>;

// Terminal programs print with this palette, so Paper and Ink keep every ANSI color legible by luminance alone.
export const terminalThemes: Record<ThemeName, ITheme> = {
  forest: { background: '#0b0f0d', foreground: '#dfe7e1', cursor: '#a8f0a0', selectionBackground: '#2e4732', green: '#a8f0a0', cyan: '#8fd3e0', blue: '#93b4d8', yellow: '#e8c27a', red: '#f09a9a' },
  paper: {
    background: '#fbfaf6', foreground: '#141414', cursor: '#1e5f2d', cursorAccent: '#ffffff', selectionBackground: '#c9d9c6', selectionForeground: '#141414',
    black: '#141414', red: '#a3161c', green: '#1e6b2e', yellow: '#7a5200', blue: '#1f4f9a', magenta: '#7b2d8e', cyan: '#0e6470', white: '#5f5f5f',
    brightBlack: '#555555', brightRed: '#b8262c', brightGreen: '#2a7a38', brightYellow: '#8a5d00', brightBlue: '#2b5fb0', brightMagenta: '#8e3fa3', brightCyan: '#147483', brightWhite: '#707070',
  },
  ink: {
    background: '#000000', foreground: '#f2f2f2', cursor: '#8ee69a', cursorAccent: '#000000', selectionBackground: '#2f4a33', selectionForeground: '#ffffff',
    black: '#666666', red: '#ff8a8a', green: '#8ee69a', yellow: '#ffd27a', blue: '#7fb0ff', magenta: '#e0a0ff', cyan: '#7fe0ec', white: '#d0d0d0',
    brightBlack: '#8c8c8c', brightRed: '#ffb0b0', brightGreen: '#b0f0b8', brightYellow: '#ffe4a8', brightBlue: '#a8cbff', brightMagenta: '#ecc0ff', brightCyan: '#a8eef5', brightWhite: '#ffffff',
  },
  // 1776 keeps green for diffs and test results, so only the cursor and selection carry the flag colors.
  1776: {
    background: '#0b1430', foreground: '#e9edf7', cursor: '#ff4f64', cursorAccent: '#0b1430', selectionBackground: '#2a3f7a', selectionForeground: '#ffffff',
    black: '#63719d', red: '#ff5c6f', green: '#7fd99a', yellow: '#f3c45a', blue: '#7aa7ff', magenta: '#d59cff', cyan: '#6fd6e8', white: '#d5dbea',
    brightBlack: '#8592bb', brightRed: '#ff8a98', brightGreen: '#a6e8b9', brightYellow: '#f8d88e', brightBlue: '#a3c3ff', brightMagenta: '#e4bfff', brightCyan: '#9be6f1', brightWhite: '#ffffff',
  },
  // Flag writes in Old Glory Blue on a near-white canvas, which stays off pure white so an agent's white text still flips like Paper's.
  flag: {
    background: '#fcfdff', foreground: '#0a2550', cursor: '#b31942', cursorAccent: '#ffffff', selectionBackground: '#d6e2f6', selectionForeground: '#0a2550',
    black: '#0a2550', red: '#b31942', green: '#1e6b2e', yellow: '#7a5200', blue: '#0a3161', magenta: '#7b2d8e', cyan: '#0e6470', white: '#5f6578',
    brightBlack: '#475b82', brightRed: '#c42852', brightGreen: '#2a7a38', brightYellow: '#8a5d00', brightBlue: '#1f4f9a', brightMagenta: '#8e3fa3', brightCyan: '#147483', brightWhite: '#6e7488',
  },
};

export function readTheme(): ThemeChoice {
  const value = saved<string>('theme', 'forest');
  return (themeChoices as readonly string[]).includes(value) ? (value as ThemeChoice) : 'forest';
}

const light = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : undefined;

export function resolvedTheme(choice = readTheme()): ThemeName {
  return choice === 'auto' ? (light?.matches ? 'paper' : 'ink') : choice;
}

// Sets the document theme and returns the palette name now in effect.
export function applyTheme(choice = readTheme()): ThemeName {
  const name = resolvedTheme(choice), root = document.documentElement;
  if (name === 'forest') delete root.dataset.theme;
  else root.dataset.theme = name;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', terminalThemes[name].background!);
  return name;
}

// Auto follows the system appearance, so a system switch reapplies the theme.
export function watchSystemTheme(changed: () => void) {
  light?.addEventListener('change', () => { if (readTheme() === 'auto') changed(); });
}
