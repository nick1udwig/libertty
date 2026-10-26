import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { chromium } from 'playwright-core';

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
const issuedPorts = new Set();
export async function freePort() {
  // Releasing ephemeral listeners can immediately recycle a port within one fixture.
  // Keep each allocation distinct until this test process exits.
  for (;;) {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    if (issuedPorts.has(port)) continue;
    issuedPorts.add(port);
    return port;
  }
}
export function startBackend(options = {}) {
  return spawn(root + 'target/debug/libertty', [], { cwd: root, ...options });
}
export function launchBrowser(options = {}) {
  return chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, ...options });
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

export async function waitForShell(frame, { afterPrompt, session, line, visible = true } = {}) {
  await frame.waitForFunction(async ({ afterPrompt, session, line, visible }) => {
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
    if (line === undefined) return true;
    window.__testLineRequests ??= new Map();
    const id = crypto.randomUUID();
    const snapshot = await new Promise(resolve => {
      const timer = setTimeout(() => { window.__testLineRequests.delete(id); resolve(undefined); }, 1000);
      window.__testLineRequests.set(id, value => { clearTimeout(timer); window.__testLineRequests.delete(id); resolve(value); });
      socket.send(JSON.stringify({ type: 'input-line', id, prompt: state.prompt, revision: state.inputRevision }));
    });
    return snapshot?.prompt === state.prompt && snapshot.text === line && snapshot.cursor === line.length && window.__testShellSocket === socket && window.__testShellState?.prompt === state.prompt && window.__testShellState.ready;
  }, { afterPrompt, session, line, visible }, { polling: 100 });
  return frame.evaluate(() => ({ ...window.__testShellState }));
}

export async function expectShellPrompt(frame) {
  const state = await waitForShell(frame);
  await frame.evaluate(prompt => { window.__testAfterPrompt = prompt; }, state.prompt);
  return state.prompt;
}

export async function submitShellCommand(frame, text) {
  await waitForShell(frame, { line: '' });
  await frame.locator('#terminal textarea').focus();
  const page = typeof frame.page === 'function' ? frame.page() : frame;
  await page.keyboard.type(text);
  await expectShellPrompt(frame);
  await page.keyboard.press('Enter');
}

export async function shellCommand(frame, text) {
  await submitShellCommand(frame, text);
  return waitForShell(frame, { line: '' });
}

export async function dictateShell(frame, text, { replacement = false } = {}) {
  await waitForShell(frame, { line: '' });
  const input = frame.locator('#terminal textarea');
  await input.focus();
  await input.evaluate((element, { text, replacement }) => element.dispatchEvent(new InputEvent('beforeinput', {
    inputType: replacement ? 'insertReplacementText' : 'insertText', data: text, bubbles: true, cancelable: true,
  })), { text, replacement });
}
