import { launchBrowser, freePort, startBackend, delay, until, waitForBackend, pair } from './support/browser.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { herdrFixture } from './herdr-fixture.ts';
import { installBackgroundGrace } from './support/background-grace.mjs';

const fixturePort3192 = await freePort();

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname, base = 'http://127.0.0.1:' + fixturePort3192 + '/';
const token = 'herdr-reopen-fixture-token';
const backend = startBackend({ cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3192), TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_DATA_DIR: fixture.directory + '/termai', TERMAI_TOKEN: token, TERMAI_NO_RC: '1', TERMAI_CWD: fixture.directory, HOME: fixture.directory, PATH: fixture.directory + ':' + process.env.PATH, HERDR_SOCKET_PATH: fixture.socketPath } });
const exited = once(backend, 'exit'); let browser;
try {
  await waitForBackend(base, backend);
  const owner = await pair(base, token);
  browser = await launchBrowser({ });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await installBackgroundGrace(context);
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await context.addInitScript(({ base, owner }) => {
    if (parent !== window) return;
    localStorage.setItem('termai.access:' + base, owner);
    if (localStorage.getItem('reopen.fixture')) return;
    localStorage.setItem('reopen.fixture', '1');
    localStorage.setItem('termai.herdrStrip', JSON.stringify('agents'));
    localStorage.setItem('termai.hosts', JSON.stringify([{ id: 'local', name: 'This machine', kind: 'http', backendId: 'primary' }, { id: 'herdr', name: 'Herdr', kind: 'herdr', backendId: 'primary', herdrSourceHostId: 'local', herdrSource: '11111111-1111-4111-8111-111111111111' }]));
    localStorage.setItem('termai.tabs', JSON.stringify([{ id: 'saved-herdr', session: '11111111-1111-4111-8111-111111111111', name: 'Herdr', backendId: 'primary', hostId: 'herdr', mode: 'herdr', pluginId: 'herdr', ownsSession: true, herdrSource: '11111111-1111-4111-8111-111111111111' }]));
    localStorage.setItem('termai.activeTab', JSON.stringify('saved-herdr'));
  }, { base, owner });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  let tickets = 0; page.on('request', request => { if (request.url().includes('/api/herdr/ticket')) tickets++; });
  await page.goto(base);
  await page.locator('#herdr-strip-saved-herdr .herdr-agent-tab').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => { const tab = JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.id === 'saved-herdr'); return tab && !tab.ended && tab.herdrSource === tab.session && tab.session !== '11111111-1111-4111-8111-111111111111'; });
  assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).count(), 0);
  assert.equal(await page.locator('#tabs .herdr-tab').count(), 1, 'Restoration reuses the saved tab');
  // Reopening retries an expired source even if the first network request fails.
  await page.evaluate(() => { const tabs = JSON.parse(localStorage.getItem('termai.tabs')); Object.assign(tabs.find(tab => tab.id === 'saved-herdr'), { session: '22222222-2222-4222-8222-222222222222', herdrSource: '22222222-2222-4222-8222-222222222222', ended: true }); localStorage.setItem('termai.tabs', JSON.stringify(tabs)); });
  let failOnce = true;
  await page.route('**/api/herdr/ticket?**', async route => { if (failOnce) { failOnce = false; await route.abort('connectionfailed'); } else await route.continue(); });
  await page.reload();
  await page.waitForFunction(() => { const tab = JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.id === 'saved-herdr'); return tab && !tab.ended && tab.herdrSource === tab.session && tab.session !== '22222222-2222-4222-8222-222222222222'; });
  await page.locator('#herdr-strip-saved-herdr .herdr-agent-tab').first().waitFor({ state: 'visible' });
  await delay(500);
  let cachedTicket, releaseCache;
  const cacheGate = new Promise(resolve => releaseCache = resolve);
  const holdCache = async route => {
    if (!new URL(route.request().url()).searchParams.has('terminalId') && !cachedTicket) { cachedTicket = route; await cacheGate; }
    await route.continue();
  };
  await page.route('**/api/herdr/ticket?**', holdCache);
  await page.reload();
  await page.locator('#herdr-strip-saved-herdr .herdr-agent-tab').first().waitFor({ state: 'visible' });
  assert.ok(cachedTicket, 'Navigation metadata is displayed while the live ticket is pending');
  assert.equal(await page.locator('.herdr-screen iframe').count(), 0, 'Cached metadata cannot attach stale terminal identities');
  assert.equal(await page.locator('#herdr-strip-saved-herdr').evaluate(element => element.inert), true);
  releaseCache(); await page.unroute('**/api/herdr/ticket?**', holdCache);
  await page.waitForFunction(() => !document.querySelector('#herdr-strip-saved-herdr').inert);
  await delay(500);
  const before = tickets;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await delay(200); assert.equal(tickets, before, 'Short app switching keeps the metadata connection');
  await page.locator('#herdr-strip-saved-herdr .herdr-agent-tab').first().waitFor({ state: 'visible' });
  // A ticket fetch left behind by a suspended PWA must not block foreground recovery.
  let stalled, metadataAttempts = 0;
  await page.route('**/api/herdr/ticket?**', async route => {
    if (new URL(route.request().url()).searchParams.has('terminalId')) { await route.continue(); return; }
    metadataAttempts++;
    if (metadataAttempts === 1) { stalled = route; return; }
    await route.continue();
  });
  const foreground = () => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    window.__expireBackground();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
  });
  await delay(200); await foreground(); await until(() => !!stalled, 'held metadata ticket');
  try {
    await foreground();
    await until(() => metadataAttempts >= 2, 'fresh foreground attempt', 2500);
  } finally { await stalled.abort('failed').catch(() => {}); }
  await page.locator('.herdr-connection').filter({ hasText: 'timed out' }).waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('PASS Herdr reopen: expired sources restore automatically in the same tab, transient failures retry, and foregrounding cancels stalled attempts');
} catch (error) {
  for (const page of browser?.contexts().flatMap(context => context.pages()) || []) console.error(await page.evaluate(() => ({ text: document.body.innerText, tabs: localStorage.getItem('termai.tabs'), hosts: localStorage.getItem('termai.hosts') })));
  throw error;
} finally {
  await browser?.close(); backend.kill('SIGTERM'); await exited; await fixture.close();
}
