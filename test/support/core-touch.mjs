import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { focusShell, until, waitForShell } from './browser.mjs';
import { shellQuote } from '../../src/shell-words.ts';

export async function exerciseCoreTouch(page, frame, root) {
  const file = root + '/touch-state.json', app = root + '/touch.mjs';
  await writeFile(app, `
    import { writeFileSync } from 'node:fs';
    let pending = '', text = 'alpha beta gamma', cursor = 0, mouse = [], normal = false;
    const draw = () => {
      const cols = process.stdout.columns, rows = process.stdout.rows;
      writeFileSync(${JSON.stringify(file)}, JSON.stringify({ text, cursor, mouse, cols, rows, normal }));
      process.stdout.write('\\x1b[2J\\x1b[HCore touch test\\r\\nTap to place the cursor\\r\\n' + text + '\\x1b[3;' + (cursor + 1) + 'H');
    };
    const click = (button, column, row, action) => {
      mouse.push({ button, column, row, action });
      if (button === 0 && row === 2 && action === 'press') cursor = Math.min(column, text.length);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');
    process.stdin.on('data', data => {
      pending += data;
      while (pending) {
        const sgr = pending.match(/^\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/);
        if (sgr) {
          click(Number(sgr[1]), Number(sgr[2]) - 1, Number(sgr[3]) - 1, sgr[4] === 'M' ? 'press' : 'release');
          pending = pending.slice(sgr[0].length);
        } else if (pending.startsWith('\\x1b[M') && pending.length >= 6) {
          const button = pending.charCodeAt(3) - 32;
          click(button === 3 ? 0 : button, pending.charCodeAt(4) - 33, pending.charCodeAt(5) - 33, button === 3 ? 'release' : 'press');
          pending = pending.slice(6);
        } else if (pending[0] === '\\x1b') break;
        else {
          const char = pending[0]; pending = pending.slice(1);
          if (char === '\\x03') process.exit();
          else if (char === '\\x0e') process.stdout.write('\\x1b[?1000l');
          else if (char === '\\x0f') process.stdout.write('\\x1b[?1000h');
          else if (char === '\\x12') process.stdout.write('\\x1b[?1006l');
          else if (char === '\\x10') {
            normal = true;
            process.stdout.write('\\x1b[?1049l' + 'Local history\\r\\n'.repeat(80) + '\\x1b[?1000h\\x1b[?1006h');
          } else if (char >= ' ') { text = text.slice(0, cursor) + char + text.slice(cursor); cursor++; }
        }
      }
      draw();
    });
    process.on('SIGWINCH', () => setImmediate(draw));
    draw();
  `);
  const state = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
  };
  const ready = () => frame.waitForFunction(() => {
    const term = window.__testTerminal;
    return window.__testShellState?.inputTarget === 'program' && term?.wasmTerm.getMode(1000) &&
      document.querySelector('#terminal-viewport').getAttribute('aria-busy') !== 'true' &&
      document.querySelector('#connection-label').textContent === 'Connected';
  });
  const point = async (column = 6, row = 2) => {
    const box = await (await frame.frameElement()).boundingBox();
    const position = await frame.evaluate(({ column, row }) => {
      const term = window.__testTerminal, bounds = term.screen.getBoundingClientRect();
      return { x: bounds.left + (column + 0.5) * bounds.width / term.cols, y: bounds.top + (row + 0.5) * bounds.height / term.rows };
    }, { column, row });
    return { x: box.x + position.x, y: box.y + position.y };
  };
  const tap = async (column = 6) => { const { x, y } = await point(column); await page.touchscreen.tap(x, y); };
  const expectClick = async (count, column) => {
    await until(async () => (await state()).mouse?.length === count, 'Core receives one press and release');
    assert.deepEqual((await state()).mouse.slice(-2), [
      { button: 0, column, row: 2, action: 'press' },
      { button: 0, column, row: 2, action: 'release' },
    ]);
  };
  await focusShell(frame);
  await page.keyboard.type([process.execPath, app].map(shellQuote).join(' '));
  await page.keyboard.press('Enter');
  await ready();
  await tap();
  await expectClick(2, 6);
  await page.keyboard.type('X');
  await until(async () => (await state()).text === 'alpha Xbeta gamma', 'typing follows the tapped cursor');
  await frame.evaluate(async () => {
    window.__touchCopies = [];
    navigator.clipboard.writeText = async text => { window.__touchCopies.push(text); };
    const term = window.__testTerminal, target = term.element.querySelector('canvas'), bounds = term.screen.getBoundingClientRect();
    const touch = new Touch({ identifier: 7, target, clientX: bounds.left + 2.5 * bounds.width / term.cols, clientY: bounds.top + 2.5 * bounds.height / term.rows });
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
    await new Promise(resolve => setTimeout(resolve, 400));
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));
  });
  await frame.waitForFunction(() => window.__touchCopies.includes('alpha'));
  assert.equal((await state()).mouse.length, 2, 'Hold-to-copy sends no application clicks');

  await page.keyboard.press('Control+n');
  await frame.waitForFunction(() => !window.__testTerminal.wasmTerm.getMode(1000));
  await tap(3);
  await page.keyboard.type('Y');
  await until(async () => (await state()).text === 'alpha XYbeta gamma', 'disabled mouse mode keeps the cursor');
  assert.equal((await state()).mouse.length, 2);
  await page.keyboard.press('Control+o');
  await ready();

  await frame.evaluate(() => {
    window.__oldSocket = window.__testShellSocket;
    window.__oldSocket.close();
    const term = window.__testTerminal, target = term.element.querySelector('canvas'), bounds = term.screen.getBoundingClientRect();
    const touch = new Touch({ identifier: 8, target, clientX: bounds.left + 2.5 * bounds.width / term.cols, clientY: bounds.top + 2.5 * bounds.height / term.rows });
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));
  });
  await frame.waitForFunction(() => window.__testShellSocket !== window.__oldSocket);
  await ready();
  await tap(4);
  await expectClick(4, 4);
  await page.setViewportSize({ width: 430, height: 700 });
  await until(async () => (await state()).cols === await frame.evaluate(() => window.__testTerminal.cols), 'Core touch grid resizes');
  await ready();
  await tap(9);
  await expectClick(6, 9);

  await page.keyboard.press('Control+r');
  await frame.waitForFunction(() => !window.__testTerminal.wasmTerm.getMode(1006));
  await tap(3);
  await expectClick(8, 3);

  await page.keyboard.press('Control+p');
  await frame.waitForFunction(() => window.__testTerminal.buffer.active.length > window.__testTerminal.rows);
  await frame.evaluate(() => window.__testTerminal.scrollLines(-4));
  await tap(5);
  await page.keyboard.type('Z');
  await until(async () => (await state()).text.includes('Z'), 'input barrier after a history tap');
  assert.equal((await state()).mouse.length, 8, 'A tap on local history sends no application click');
  await page.keyboard.press('Control+c');
  await waitForShell(frame);
  console.log('Core touch: native taps, edit ordering, mouse modes, hold-to-copy, reconnect without replay, resize and local history passed.');
}
