import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { trackBrowser } from './browser-diagnostics.mjs';
export { freePort } from '../../scripts/browser-ports.mjs';

const root = new URL('../../', import.meta.url).pathname;
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label = 'condition', timeout = 15000) {
  if (typeof label === 'number') { timeout = label; label = 'condition'; }
  for (const end = Date.now() + timeout; Date.now() < end;) {
    if (await check()) return;
    await delay(30);
  }
  throw new Error('Timed out waiting for ' + label);
}
export function startBackend(options = {}) {
  return spawn(root + 'target/debug/libertty', [], { cwd: root, ...options });
}
export async function launchBrowser(options = {}) {
  return trackBrowser(await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, ...options }));
}
export async function waitForBackend(base, process) {
  await until(async () => {
    if (process?.exitCode != null) throw new Error('Backend exited before becoming ready: ' + process.exitCode);
    try { return (await fetch(new URL('healthz', base.endsWith('/') ? base : base + '/'), { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 'backend');
}
export async function pair(base, token) {
  const response = await fetch(new URL('api/connect', base.endsWith('/') ? base : base + '/'), {
    method: 'POST', headers: { Origin: new URL(base).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, noSession: true }),
  });
  const result = await response.json();
  if (!response.ok || !result.accessToken) throw new Error(result.error || 'Pairing failed');
  return result.accessToken;
}

export async function waitForShell(frame, { afterPrompt, session, visible = true } = {}) {
  await frame.waitForFunction(({ afterPrompt, session, visible }) => {
    const state = window.__testShellState;
    const socket = window.__testShellSocket;
    const viewport = document.querySelector('#terminal-viewport');
    const expectedPrompt = afterPrompt ?? window.__testAfterPrompt;
    if (!state?.ready || state.exited || socket?.readyState !== WebSocket.OPEN) return false;
    if (expectedPrompt !== undefined && state.prompt <= expectedPrompt) return false;
    if (session !== undefined && new URL(location.href).searchParams.get('session') !== session) return false;
    if (visible && (document.hidden || frameElement?.inert || frameElement && !frameElement.checkVisibility())) return false;
    if (document.querySelector('#connection-label')?.textContent !== 'Connected') return false;
    if (viewport?.classList.contains('awaiting-herdr-layout') || viewport?.getAttribute('aria-busy') === 'true') return false;
    return new URL(socket.url).pathname.endsWith('/herdr/ws') || window.__testReadlineReady === true;
  }, { afterPrompt, session, visible }, { polling: 100 });
  return frame.evaluate(() => ({ ...window.__testShellState }));
}

export async function expectShellPrompt(frame) {
  const state = await waitForShell(frame);
  await frame.evaluate(prompt => { window.__testAfterPrompt = prompt; }, state.prompt);
  return state.prompt;
}

export async function focusShell(frame) {
  await waitForShell(frame);
  const input = frame.locator('#terminal textarea');
  if (!await input.evaluate(element => document.activeElement === element && !element.readOnly)) {
    const canvas = frame.locator('#terminal .gespenst__background');
    const position = await canvas.evaluate(element => { const bounds = element.getBoundingClientRect(); return { x: bounds.width - 4, y: bounds.height - 4 }; });
    if (await frame.evaluate(() => navigator.maxTouchPoints > 0)) await canvas.tap({ position });
    else await canvas.click({ position });
  }
  await frame.waitForFunction(() => {
    const input = document.querySelector('#terminal textarea');
    return document.activeElement === input && !input.readOnly;
  });
  return input;
}

export async function submitShellCommand(frame, text) {
  await focusShell(frame);
  const page = typeof frame.page === 'function' ? frame.page() : frame;
  await page.keyboard.type(text);
  await expectShellPrompt(frame);
  await page.keyboard.press('Enter');
}

export async function shellCommand(frame, text) {
  await submitShellCommand(frame, text);
  return waitForShell(frame);
}

export async function dictateShell(frame, text, { replacement = false } = {}) {
  const input = await focusShell(frame);
  await input.evaluate((element, { text, replacement }) => element.dispatchEvent(new InputEvent('beforeinput', {
    inputType: replacement ? 'insertReplacementText' : 'insertText', data: text, bubbles: true, cancelable: true,
  })), { text, replacement });
}
