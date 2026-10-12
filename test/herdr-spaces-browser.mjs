import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pty from 'node-pty';
import { chromium } from 'playwright-core';
import { herdrRequest, herdrSnapshot } from './support/herdr.ts';

const root = new URL('../', import.meta.url).pathname, dir = await realpath(await mkdtemp('/tmp/termai-herdr-spaces-'));
const target = { session: '', socketPath: dir + '/herdr.sock' }, base = 'http://127.0.0.1:3174';
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir + '/config', XDG_DATA_HOME: dir + '/data', XDG_STATE_HOME: dir + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', HERDR_ENV: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check, label) => { for (let end = Date.now() + 15000; Date.now() < end;) { if (await check()) return; await delay(30); } throw new Error('Timed out: ' + label); };
let herdr, desktop, backend, browser;
try {
  await mkdir(dir + '/alpha', { recursive: true }); await mkdir(dir + '/beta project');
  herdr = spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server'], { cwd: dir, env, stdio: 'ignore' });
  await wait(async () => { try { await herdrSnapshot(target); return true; } catch { return false; } }, 'isolated Herdr');
  desktop = pty.spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', [], { cwd: dir, env, cols: 150, rows: 45, name: 'xterm-256color' }); desktop.onData(() => {});
  const alpha = (await herdrRequest(target, 'workspace.create', { cwd: dir + '/alpha', label: 'Alpha', focus: false })).workspace.workspace_id;
  const beta = (await herdrRequest(target, 'workspace.create', { cwd: dir + '/beta project', label: 'Beta', focus: false })).workspace.workspace_id;
  backend = spawn(root + 'target/debug/termai', [], { cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3174', TERMAI_BASE_PATH: '/', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: base, TERMAI_DATA_DIR: dir + '/termai', TERMAI_TOKEN: '', TERMAI_NO_RC: '1', TERMAI_CWD: dir }, stdio: 'ignore' });
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'isolated backend');
  const token = (await readFile(dir + '/termai/pairing-token', 'utf8')).trim();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    if (!localStorage.getItem('termai.tabs')) {
      const id = crypto.randomUUID();
      localStorage.setItem('termai.hosts', JSON.stringify([{ id: 'herdr-native', name: 'Herdr', kind: 'herdr', backendId: 'primary' }]));
      localStorage.setItem('termai.tabs', JSON.stringify([{ id, session: 'default', name: 'Herdr', mode: 'herdr', backendId: 'primary', hostId: 'herdr-native' }]));
      localStorage.setItem('termai.activeTab', JSON.stringify(id));
    }
    document.addEventListener('pointerdown', event => { window.__touchSource = event.target.closest('.herdr-agent-tab')?.dataset.terminal || event.target.id; }, true);
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  page.setDefaultTimeout(15000);
  const tab = id => page.locator('.herdr-agent-strip:visible .herdr-agent-tab[data-terminal="space:' + id + '"]');
  await tab(alpha).waitFor(); await tab(beta).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const order = async () => (await herdrSnapshot(target)).spaces.map(space => space.id);
  const stripOrder = () => page.locator('.herdr-agent-strip:visible .herdr-agent-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.terminal.slice(6)));
  const bounds = async id => {
    let rect;
    await wait(async () => {
      rect = await tab(id).evaluate(tab => {
        const strip = tab.closest('.herdr-agent-strip');
        if (!strip || !tab.isConnected) return null;
        const area = strip.getBoundingClientRect(), initial = tab.getBoundingClientRect();
        if (initial.left < area.left) strip.scrollLeft += initial.left - area.left;
        if (initial.right > area.right) strip.scrollLeft += initial.right - area.right;
        const rect = tab.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      return rect !== null;
    }, 'space bounds after subscription refresh');
    return rect;
  };
  const cdp = await context.newCDPSession(page), touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
  const drag = async (source, target, position, cancel = false) => {
    const { from, to } = await page.evaluate(([source, target]) => {
      const bounds = id => { const rect = document.querySelector('.herdr-agent-tab[data-terminal="space:' + CSS.escape(id) + '"]').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
      return { from: bounds(source), to: bounds(target) };
    }, [source, target]);
    await touch('touchStart', from.x + from.width / 2, from.y + from.height / 2);
    assert.equal(await page.evaluate(() => window.__touchSource), 'space:' + source, 'The native touch starts on the intended space');
    await delay(500); await touch('touchMove', to.x + to.width * position, to.y + to.height / 2);
    await touch(cancel ? 'touchCancel' : 'touchEnd');
  };
  await tab(beta).click(); await page.getByRole('button', { name: 'Create space', exact: true }).click();
  await wait(async () => (await order()).length === 3, 'one-tap space creation');
  assert.equal(await page.locator('.herdr-tab-menu:visible, dialog:visible').count(), 0, 'Plus has no menu or form');
  const created = (await order()).find(id => id !== alpha && id !== beta);
  await tab(created).waitFor(); await wait(async () => await tab(created).getAttribute('aria-selected') === 'true', 'new space selected after creation returns');
  const snapshot = await herdrSnapshot(target), newSpace = snapshot.spaces.find(space => space.id === created);
  assert.equal(newSpace.cwd, dir + '/beta project', 'The selected space supplies the directory');
  assert.equal(await page.locator('.herdr-terminal').getAttribute('data-terminal'), newSpace.selectedTerminalId);
  await drag(alpha, created, .9);
  await wait(async () => JSON.stringify(await order()) === JSON.stringify([beta, created, alpha]), 'edge drop reorders the native spaces');
  await wait(async () => JSON.stringify(await stripOrder()) === JSON.stringify([beta, created, alpha]), 'strip receives the native order');
  assert.equal(await page.locator('.herdr-space-stack').count(), 0);
  await drag(alpha, beta, .5);
  await page.locator('.herdr-space-stack').waitFor();
  assert.deepEqual(await page.locator('.herdr-space-stack .herdr-agent-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.terminal)), ['space:' + beta, 'space:' + alpha]);
  await page.screenshot({ path: '/tmp/termai-herdr-spaces.png' });
  await page.getByRole('button', { name: 'Collapse space stack', exact: true }).click(); assert.equal(await tab(alpha).isVisible(), false);
  await page.reload(); await tab(beta).waitFor(); assert.equal(await tab(alpha).isVisible(), false, 'Stack and collapsed state survive reload');
  await page.getByRole('button', { name: 'Expand space stack', exact: true }).click(); await tab(alpha).waitFor();
  const before = await order(); await drag(alpha, created, .1, true); await delay(120);
  assert.deepEqual(await order(), before, 'Cancelling a drag cannot reorder or unstack'); assert.equal(await page.locator('.herdr-space-stack').count(), 1);
  await drag(alpha, created, .1); await wait(async () => (await page.locator('.herdr-space-stack').count()) === 0, 'edge drop extracts a space from its stack');
  await tab(beta).click();
  await wait(async () => await tab(beta).getAttribute('aria-selected') === 'true', 'selected Beta space');
  const rect = await bounds(beta); await touch('touchStart', rect.x + rect.width / 2, rect.y + rect.height / 2);
  assert.equal(await page.evaluate(() => window.__touchSource), 'space:' + beta); await delay(500); await touch('touchEnd');
  await page.locator('.herdr-tab-menu:visible').waitFor();
  assert.deepEqual(await page.locator('.herdr-tab-menu:visible [role=menuitem]').allTextContents(), ['Rename', 'Close']);
  await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Space name', { exact: true }).fill('Review'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await wait(async () => (await herdrSnapshot(target)).spaces.find(space => space.id === beta)?.name === 'Review', 'shared space rename');
  await tab(beta).click();
  await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Create agent', exact: true }).waitFor();
  await tab(created).click(); await wait(async () => await tab(created).getAttribute('aria-selected') === 'true', 'selected created space');
  const close = await bounds(created); await touch('touchStart', close.x + close.width / 2, close.y + close.height / 2); await delay(500); await touch('touchEnd');
  await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Close', exact: true }).click();
  await wait(async () => !(await order()).includes(created), 'close removes the native space');
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'spaces'); await page.locator('#herdr-strip').selectOption('agents'); await page.reload(); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'agents', 'Explicit agent mode survives reload');
  assert.deepEqual(errors, []);
  console.log('PASS: real Herdr defaults to spaces, creates in the selected directory without a popup, shares native order/rename/close, and supports touch edge drops, persistent collapsible stacks, extraction and cancelled drags.');
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: '/tmp/termai-herdr-spaces-failure.png' }).catch(() => {}); throw error;
} finally {
  await browser?.close(); if (backend) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  desktop?.kill(); await herdrRequest(target, 'server.stop').catch(() => {}); herdr?.kill(); await rm(dir, { recursive: true, force: true });
}
