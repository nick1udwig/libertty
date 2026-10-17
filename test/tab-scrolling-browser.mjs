import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { launchBrowser, delay } from './support/browser.mjs';

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 400, height: 700 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const css = await Promise.all(['tokens.css', 'workspace.css', 'herdr.css'].map(file => readFile(new URL('../src/' + file, import.meta.url), 'utf8')));
  const script = stripTypeScriptTypes(await readFile(new URL('../src/tab-gestures.ts', import.meta.url), 'utf8')).replaceAll('export function', 'function');
  await page.setContent(`<style>${css.join('\n')}#workspace-navigation{width:400px}.herdr-agent-tab,.tab{min-width:180px;height:44px;flex-shrink:0}#tabs{height:50px}</style><div id="workspace-navigation" class="herdr-navigation"><div id="tabs"></div><div class="herdr-agent-strip"></div></div>`);
  await page.addScriptTag({ content: script + `
    window.result = { selected: 0, held: 0, dragged: 0, dropped: 0, vertical: 0, cancelled: 0 };
    for (const strip of document.querySelectorAll('#tabs,.herdr-agent-strip')) {
      for (let i = 0; i < 8; i++) {
        const tab = document.createElement('button'); tab.className = strip.id ? 'tab' : 'herdr-agent-tab'; tab.textContent = 'Terminal ' + i; strip.append(tab);
        tabGestures(tab, { scroll: strip, select: () => result.selected++, hold: () => result.held++, drag: () => result.dragged++, drop: () => result.dropped++ });
        tab.addEventListener('pointercancel', () => result.cancelled++);
      }
    }
    tabStripSwipes(document.querySelector('#workspace-navigation'), () => 'herdr', { move: () => {}, end: up => { if (up !== undefined) result.vertical++; } });
  ` });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
  for (const selector of ['#tabs', '.herdr-agent-strip']) {
    const strip = page.locator(selector), bounds = await strip.boundingBox(), y = bounds.y + bounds.height / 2;
    await touch('touchStart', 340, y); await delay(30);
    await touch('touchMove', 280, y); await delay(500);
    await touch('touchMove', 80, y); await touch('touchEnd'); await delay(250);
    assert.ok(await strip.evaluate(element => element.scrollLeft) > 150, selector + ' scrolls natively after a pause');
    const forward = await strip.evaluate(element => element.scrollLeft);
    await touch('touchStart', 60, y); await delay(30);
    await touch('touchMove', 160, y); await delay(30);
    await touch('touchMove', 340, y); await touch('touchEnd'); await delay(250);
    assert.ok(await strip.evaluate(element => element.scrollLeft) < forward - 100, selector + ' scrolls back');
    const result = await page.evaluate(() => window.result);
    assert.equal(result.selected, 0); assert.equal(result.held, 0); assert.equal(result.dragged, 0);
    assert.ok(result.cancelled >= 2, 'The browser takes ownership of horizontal gestures');
    await strip.evaluate(element => { element.scrollLeft = 0; });
    await touch('touchStart', 90, y); await delay(500);
    await touch('touchMove', 150, y); await delay(30);
    await touch('touchMove', 220, y); await touch('touchEnd');
    const held = await page.evaluate(() => window.result);
    assert.ok(held.dragged > 0); assert.equal(held.dropped, 1, 'Holding retains custom reordering');
    await touch('touchStart', 90, y); await touch('touchMove', 90, y - 15); await touch('touchMove', 90, y - 60); await touch('touchEnd');
    assert.equal(await page.evaluate(() => result.vertical), 1, 'Vertical drawer gestures remain available');
    await page.evaluate(() => { for (const key in result) result[key] = 0; });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const strip = page.locator('#tabs'), bounds = await strip.boundingBox(), y = bounds.y + bounds.height / 2;
  await strip.evaluate(element => { element.scrollLeft = 0; });
  await page.mouse.move(300, y); await page.mouse.down(); await page.mouse.move(280, y, { steps: 2 });
  await page.mouse.move(270, y + 50, { steps: 2 });
  assert.equal(await strip.evaluate(element => element.scrollLeft), 30, 'A mouse drag keeps scrolling as it drifts below the strip');
  await page.mouse.move(210, y + 60, { steps: 2 }); await page.mouse.up();
  assert.equal(await strip.evaluate(element => element.scrollLeft), 90, 'A mouse drag returns without jumping');
  console.log('PASS: Native horizontal scrolling, paused swipes, reverse swipes, held reordering, vertical drawer gestures and drifting mouse drags on the tab strips.');
} finally { await browser.close(); }
