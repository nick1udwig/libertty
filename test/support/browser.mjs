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
export async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
export function startBackend(options = {}) {
  return spawn(root + 'target/debug/termai', [], { cwd: root, ...options });
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
