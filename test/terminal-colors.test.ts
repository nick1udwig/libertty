import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptDarkAppColors, flipLightness } from '../src/terminal-colors.ts';
import { terminalThemes } from '../src/theme.ts';

const paper = terminalThemes.paper;
const luminance = ([r, g, b]: number[]) => [r, g, b].map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => m - n); return (y + 0.05) / (x + 0.05); };
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test('Paper turns dark app panels light and light app text dark', () => {
  const panel = flipLightness(0x1e, 0x1e, 0x1e, paper), text = flipLightness(0xff, 0xff, 0xff, paper);
  assert.ok(luminance(panel) > 0.6, 'A dark input box becomes a light shade');
  assert.ok(luminance(panel) < luminance(rgb(paper.background!)), 'The shade stays distinct from the page');
  assert.ok(contrast(text, panel) > 7, 'Text on a flipped panel stays readable');
  assert.deepEqual(text, rgb(paper.foreground!), 'White text becomes the Paper text color');
  const [r, g, b] = flipLightness(0xd7, 0x77, 0x57, paper);
  assert.ok(r > g && g > b && contrast([r, g, b], rgb(paper.background!)) > 4.5, 'An accent keeps its hue and becomes readable on Paper');
});

test('Paper leaves its own palette alone and caches flipped colors', () => {
  const calls: number[][] = [];
  const renderer = { rgbToCSS(r: number, g: number, b: number) { calls.push([r, g, b]); return `rgb(${r}, ${g}, ${b})`; } };
  adaptDarkAppColors(renderer, paper);
  assert.equal(renderer.rgbToCSS(0xa3, 0x16, 0x1c), 'rgb(163, 22, 28)', 'ANSI red is already tuned for Paper');
  assert.equal(renderer.rgbToCSS(0xfb, 0xfa, 0xf6), 'rgb(251, 250, 246)');
  assert.equal(renderer.rgbToCSS(0xff, 0xff, 0xff), 'rgb(20, 20, 20)', 'App white text flips although the cursor accent is white');
  const flipped = renderer.rgbToCSS(0x1e, 0x1e, 0x1e);
  assert.notEqual(flipped, 'rgb(30, 30, 30)');
  const before = calls.length;
  assert.equal(renderer.rgbToCSS(0x1e, 0x1e, 0x1e), flipped); assert.equal(calls.length, before, 'Repeated colors come from the cache');
  adaptDarkAppColors(undefined, paper);
});
