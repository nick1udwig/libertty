import { launchBrowser, delay } from './support/browser.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
import { filesFixture } from './support/files-fixture.mjs';

const system = await filesFixture();
const { fixture, origin, base, second, sshPort, bytes, key, owner, other, request } = system;
let browser;
try {
  const local = await (await request(base, 'api/sessions', owner, { name: 'Local files', files: true })).json();
  assert.equal((await request(base, 'api/files/list?session=' + local.id, other)).status, 404);
  assert.equal((await request(base, 'api/files/list?session=' + local.id)).status, 401);
  assert.equal((await request(base, 'api/ticket?session=' + local.id, owner, {})).status, 404, 'Files sessions have no shell');
  assert.equal((await fetch(base + 'api/files/upload?session=' + local.id, { method: 'POST', headers: { Origin: 'http://untrusted.invalid', Authorization: 'Bearer ' + owner }, body: 'x' })).status, 403);
  const ssh = { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, privateKey: key.private, passphrase: 'test-passphrase-123' };
  const trust = await (await request(base, 'api/sessions', owner, { name: 'Remote', files: true, ssh })).json(); assert.ok(trust.fingerprint, JSON.stringify(trust)); ssh.trust = trust.fingerprint;
  const remote = await (await request(base, 'api/sessions', owner, { name: 'Remote', files: true, ssh })).json(); assert.ok(remote.id, JSON.stringify(remote));
  for (const [id, dir] of [[local.id, 'local'], [remote.id, 'remote']]) {
    const folder = fixture + '/' + dir;
    const created = await request(base, 'api/files/mkdir?session=' + id, owner, { path: folder, name: 'New folder' }); assert.equal(created.status, 200);
    assert.equal((await request(base, 'api/files/mkdir?session=' + id, owner, { path: folder, name: '../escape' })).status, 400);
    const action = data => request(base, 'api/files/action?session=' + id, owner, data);
    await writeFile(folder + '/edit.txt', 'original');
    const opened = await (await action({ action: 'read', path: folder + '/edit.txt' })).json();
    assert.equal(opened.text, 'original');
    assert.equal((await action({ action: 'write', path: folder + '/edit.txt', version: opened.version, text: 'edited' })).status, 200);
    assert.equal(await readFile(folder + '/edit.txt', 'utf8'), 'edited');
    assert.equal((await action({ action: 'write', path: folder + '/edit.txt', version: opened.version, text: 'stale' })).status, 409);
    assert.equal((await action({ action: 'read', path: folder + '/docs/über file.bin' })).status, 400);
    await mkdir(folder + '/copies');
    assert.equal((await action({ action: 'copy', paths: [folder + '/docs', folder + '/linked', folder + '/edit.txt'], destination: folder + '/copies' })).status, 200);
    assert.deepEqual(await readFile(folder + '/copies/docs/über file.bin'), bytes);
    assert.equal((await action({ action: 'copy', paths: [folder + '/edit.txt'], destination: folder + '/copies' })).status, 409);
    assert.equal((await action({ action: 'copy', paths: [folder + '/copies'], destination: folder + '/copies/docs' })).status, 400);
    assert.equal((await action({ action: 'rename', path: folder + '/copies/edit.txt', name: 'renamed.txt' })).status, 200);
    assert.equal((await action({ action: 'rename', path: folder + '/copies/renamed.txt', name: 'docs' })).status, 409);
    assert.equal((await action({ action: 'delete', paths: [folder + '/copies'] })).status, 200);
    assert.deepEqual(await readFile(folder + '/docs/über file.bin'), bytes, 'deleting a copied link does not follow it');
    assert.equal((await action({ action: 'delete', paths: ['/'] })).status, 400);
    const listing = await (await request(base, 'api/files/list?session=' + id + '&path=' + encodeURIComponent(folder), owner)).json();
    assert.equal(listing.entries.find(e => e.name === 'linked').directory, true); assert.ok(listing.entries.find(e => e.name === '.hidden'));
    const send = (name, body = bytes) => fetch(base + 'api/files/upload?' + new URLSearchParams({ session: id, path: folder, name }), { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + owner, 'Content-Type': 'application/octet-stream' }, body });
    assert.equal((await send('uploaded.bin')).status, 200); assert.deepEqual(await readFile(folder + '/uploaded.bin'), bytes);
    assert.equal((await send('../escape')).status, 400); assert.equal((await send('uploaded.bin', 'overwrite')).ok, false); assert.deepEqual(await readFile(folder + '/uploaded.bin'), bytes);
    const ticket = await (await request(base, 'api/files/download?session=' + id, owner, { path: folder + '/uploaded.bin' })).json();
    const download = await fetch(base + 'api/files/download?ticket=' + ticket.ticket); assert.match(download.headers.get('content-disposition'), /attachment/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(base + 'api/files/download?ticket=' + ticket.ticket)).status, 404);
    assert.equal((await request(base, 'api/files/download?session=' + id, owner, { path: folder })).status, 400);
  }
  browser = await launchBrowser({ });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  const page = await context.newPage(); page.on('response', async r => { if (r.url().includes('/api/files') && !r.ok()) console.log('File error', r.status(), await r.text().catch(() => '')); }); const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('dialog', d => d.accept());
  await page.goto(base); await page.locator('#backend-token').fill('files-feature-test-123456789'); await page.locator('#backend-login-form button[type=submit]').click();
  await page.locator('#terminal-back').click(); await page.getByRole('button', { name: /^Terminals for This machine/ }).click();
  await page.getByRole('menuitem', { name: 'Connect SFTP / Files', exact: true }).click();
  const view = page.locator('.file-browser:visible');
  await view.getByRole('button', { name: 'Open folder docs', exact: true }).waitFor();
  assert.equal(await view.locator('.file-breadcrumbs button:not([aria-haspopup])').count(), 2);
  await view.getByRole('button', { name: 'Earlier directories' }).click();
  assert.ok(await view.getByRole('menuitem', { name: '/', exact: true }).count());
  await page.keyboard.press('Escape'); assert.equal(await view.getByRole('menu').count(), 0);
  assert.equal(await view.getByRole('button', { name: 'Download .hidden', exact: true }).count(), 0);
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitemcheckbox', { name: 'Hidden files' }).click();
  await view.getByRole('button', { name: 'Download .hidden', exact: true }).waitFor();
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitem', { name: 'New folder' }).click();
  await view.getByRole('textbox', { name: 'Folder name' }).fill('From device'); await view.getByRole('button', { name: 'Create', exact: true }).click();
  await view.getByRole('button', { name: 'Open folder From device', exact: true }).waitFor();
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitemradio', { name: 'Sort by name', exact: true }).click();
  assert.equal(await view.locator('.file-row').nth(1).getAttribute('aria-label'), 'Open folder New folder');
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitemradio', { name: 'Sort by name', exact: true }).click();
  await view.getByRole('button', { name: 'File options' }).click(); await page.screenshot({ path: '/tmp/termai-files-options.png' }); await page.keyboard.press('Escape');
  // A slow directory response must leave the current folder and layout intact.
  let releaseListing, listingRequested;
  const held = new Promise(resolve => listingRequested = resolve), resume = new Promise(resolve => releaseListing = resolve);
  let delayDocs = true;
  await page.route('**/api/files/list?**', async route => {
    if (delayDocs && new URL(route.request().url()).searchParams.get('path') === fixture + '/local/docs') {
      delayDocs = false; listingRequested(); await resume;
    }
    await route.continue();
  });
  const beforeNavigation = await view.evaluate(el => ({
    crumbs: el.querySelector('.file-breadcrumbs').innerHTML,
    rows: el.querySelector('.file-list').innerHTML,
    status: el.querySelector('.file-status').textContent,
    listTop: el.querySelector('.file-list').getBoundingClientRect().top,
  }));
  await view.getByRole('button', { name: 'Open folder docs', exact: true }).click(); await held;
  assert.equal(await view.locator('.file-loading-spinner').evaluate(el => getComputedStyle(el).visibility), 'visible');
  assert.deepEqual(await view.evaluate(el => ({
    crumbs: el.querySelector('.file-breadcrumbs').innerHTML,
    rows: el.querySelector('.file-list').innerHTML,
    status: el.querySelector('.file-status').textContent,
    listTop: el.querySelector('.file-list').getBoundingClientRect().top,
  })), beforeNavigation);
  await page.screenshot({ path: '/tmp/termai-files-loading-spinner.png' });
  releaseListing(); await view.getByRole('button', { name: 'Download über file.bin', exact: true }).waitFor();
  assert.equal(await view.locator('.file-loading-spinner').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  await page.unroute('**/api/files/list?**');
  const downloadEvent = page.waitForEvent('download'); await view.getByRole('button', { name: 'Download über file.bin', exact: true }).click();
  const downloaded = await downloadEvent; assert.equal(downloaded.suggestedFilename(), 'über file.bin'); assert.deepEqual(await readFile(await downloaded.path()), bytes);
  const progress = page.locator('.download-dialog');
  await progress.getByRole('heading', { name: 'Download complete', exact: true }).waitFor();
  assert.equal(await progress.locator('progress').getAttribute('value'), '100');
  assert.ok(await progress.getByRole('button', { name: 'Open', exact: true }).isVisible());
  await page.screenshot({ path: '/tmp/termai-download-complete.png' });
  await progress.getByRole('checkbox', { name: 'Don’t show this again' }).check();
  await progress.getByRole('button', { name: 'Close', exact: true }).click();
  const silent = page.waitForEvent('download'); await view.getByRole('button', { name: 'Download über file.bin', exact: true }).click(); await silent;
  assert.equal(await page.locator('.download-dialog[open]').count(), 0);
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#show-downloads').isChecked(), false);
  await page.locator('#show-downloads').check(); await page.locator('#nav-terminals').click();
  // Throttle an actual transfer to verify intermediate byte progress and cancel.
  await writeFile(fixture + '/local/docs/progress.txt', Buffer.alloc(256 * 1024, 65));
  await view.getByRole('button', { name: 'File options' }).click(); await view.getByRole('menuitem', { name: 'Refresh folder' }).click();
  const network = await context.newCDPSession(page);
  await network.send('Network.enable'); await network.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 64 * 1024, uploadThroughput: -1 });
  const moving = page.waitForEvent('download'); await view.getByRole('button', { name: 'Download progress.txt', exact: true }).click();
  await page.waitForFunction(() => { const p = document.querySelector('.download-dialog progress'); return p && p.value > 0 && p.value < 100; });
  await page.screenshot({ path: '/tmp/termai-download-progress.png' }); await moving;
  await progress.getByRole('heading', { name: 'Download complete', exact: true }).waitFor();
  const popupEvent = page.waitForEvent('popup'); await progress.getByRole('button', { name: 'Open', exact: true }).click(); const preview = await popupEvent; await preview.waitForLoadState(); assert.ok((await preview.locator('body').textContent()).startsWith('AAAA')); await preview.close();
  await progress.getByRole('button', { name: 'Close', exact: true }).click();
  await view.getByRole('button', { name: 'Download progress.txt', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.download-dialog progress')?.value > 0);
  await progress.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(100); assert.equal(await page.locator('.download-dialog[open]').count(), 0);
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await network.detach();
  await view.locator('input[type=file]').setInputFiles({ name: 'device.txt', mimeType: 'text/plain', buffer: Buffer.from('from device') });
  await view.getByRole('button', { name: 'Download device.txt', exact: true }).waitFor(); assert.equal(await readFile(fixture + '/local/docs/device.txt', 'utf8'), 'from device');
  await view.locator('input[type=file]').setInputFiles({ name: 'device.txt', mimeType: 'text/plain', buffer: Buffer.from('oops') }); await view.locator('.file-status.error').waitFor();
  const device = view.getByRole('button', { name: 'Download device.txt', exact: true });
  const box = await device.boundingBox(); assert.ok(box.height <= 62, 'compact rows');
  await page.mouse.move(box.x + 60, box.y + box.height / 2); await page.mouse.down(); await delay(550); await page.mouse.up();
  await view.getByText('1 selected', { exact: true }).waitFor();
  await view.getByRole('button', { name: 'Download progress.txt', exact: true }).click();
  await view.getByText('2 selected', { exact: true }).waitFor();
  await view.getByRole('button', { name: 'Selection options' }).click();
  assert.equal(await view.getByRole('menuitem', { name: 'Rename', exact: true }).count(), 0);
  await page.screenshot({ path: '/tmp/termai-files-selection.png' });
  const selectedDownloads = []; const recordDownload = download => selectedDownloads.push(download); page.on('download', recordDownload);
  await view.getByRole('menuitem', { name: 'Download', exact: true }).click();
  for (let n = 0; selectedDownloads.length < 2 && n < 100; n++) await delay(50);
  assert.equal(selectedDownloads.length, 2); page.off('download', recordDownload);
  assert.deepEqual(selectedDownloads.map(download => download.suggestedFilename()).sort(), ['device.txt', 'progress.txt']);
  await progress.getByRole('heading', { name: 'Download complete', exact: true }).waitFor();
  assert.equal(await progress.getByRole('button', { name: 'Open', exact: true }).count(), 2);
  await progress.getByRole('button', { name: 'Close', exact: true }).click();
  await device.click({ button: 'right' }); await view.getByRole('button', { name: 'Download progress.txt', exact: true }).click();
  await view.getByRole('button', { name: 'Selection options' }).click();
  await view.getByRole('menuitem', { name: 'Copy', exact: true }).click(); await mkdir(fixture + '/local/copies');
  await view.getByRole('textbox', { name: 'Destination folder' }).fill(fixture + '/local/copies'); await view.getByRole('button', { name: 'Confirm', exact: true }).click();
  await view.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(await readFile(fixture + '/local/copies/device.txt', 'utf8'), 'from device');
  await device.click({ button: 'right' }); await view.getByRole('button', { name: 'Selection options' }).click(); await view.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await view.getByRole('textbox', { name: 'File content' }).fill('edited from device'); await view.getByRole('button', { name: 'Save', exact: true }).click();
  await view.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(await readFile(fixture + '/local/docs/device.txt', 'utf8'), 'edited from device');
  await device.click({ button: 'right' }); await view.getByRole('button', { name: 'Selection options' }).click(); await view.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await view.getByRole('textbox', { name: 'File name' }).fill('renamed-device.txt'); await view.getByRole('button', { name: 'Confirm', exact: true }).click();
  const renamed = view.getByRole('button', { name: 'Download renamed-device.txt', exact: true }); await renamed.waitFor();
  await renamed.click({ button: 'right' }); await view.getByRole('button', { name: 'Selection options' }).click(); await view.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await view.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await readFile(fixture + '/local/docs/renamed-device.txt', 'utf8'), 'edited from device');
  await view.getByRole('button', { name: 'Selection options' }).click(); await view.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await view.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await renamed.waitFor({ state: 'hidden' });
  await writeFile(fixture + '/local/docs/device.txt', 'from device');
  await page.reload(); await view.getByRole('button', { name: 'Download device.txt', exact: true }).waitFor();
  await view.getByRole('button', { name: 'Search files', exact: true }).click(); await view.getByRole('searchbox').fill('device'); assert.equal(await view.locator('.file-row').count(), 2);
  await page.screenshot({ path: '/tmp/termai-files-mobile.png' });
  // The same component uses bearer authentication against an independent backend.
  const secondOwner = (await (await request(second, 'api/connect', undefined, { token: 'files-feature-test-123456789', noSession: true })).json()).accessToken;
  const secondSession = await (await request(second, 'api/sessions', secondOwner, { files: true })).json();
  await page.evaluate(({ owner, remote, fixture, second, secondOwner, secondSession }) => {
    localStorage.setItem('termai.backends', JSON.stringify([{ id: 'second', name: 'Other backend', url: second }]));
    localStorage.setItem('termai.tabs', JSON.stringify([{ id: 'remote-files', name: 'SSH files', mode: 'files', backendId: 'primary', session: remote.id, directory: fixture + '/remote' }, { id: 'direct-files', name: 'Direct files', mode: 'files', backendId: 'second', session: secondSession.id }]));
    localStorage.setItem('termai.activeTab', JSON.stringify('remote-files'));
    localStorage.setItem('termai.access:' + second, secondOwner);
  }, { owner, remote, fixture, second, secondOwner, secondSession });
  // Switch primary pairing to the owner of the SSH fixture.
  await context.addCookies([{ name: 'termai', value: owner, url: base }]);
  await page.evaluate(() => { localStorage.removeItem('termai.access:' + new URL('.', document.baseURI).href); });
  await page.reload(); await view.getByRole('button', { name: 'Download uploaded.bin', exact: true }).waitFor();
  await view.locator('input[type=file]').setInputFiles({ name: 'remote-device.txt', mimeType: 'text/plain', buffer: Buffer.from('remote device') });
  await view.getByRole('button', { name: 'Download remote-device.txt', exact: true }).waitFor(); assert.equal(await readFile(fixture + '/remote/remote-device.txt', 'utf8'), 'remote device');
  await page.getByRole('tab').filter({ hasText: 'Direct files' }).click();
  await view.getByRole('button', { name: 'Open folder docs', exact: true }).click();
  await view.getByRole('button', { name: 'Download über file.bin', exact: true }).waitFor();
  await view.locator('input[type=file]').setInputFiles({ name: 'cross-origin.txt', mimeType: 'text/plain', buffer: Buffer.from('cross origin') });
  await page.waitForFunction(() => { const e = document.querySelector('.file-browser:not([hidden]) .file-status'); return e?.textContent.includes('uploaded') || e?.classList.contains('error'); });
  assert.equal(await view.locator('.file-status').textContent(), '1 file uploaded.');
  await view.getByRole('button', { name: 'Download cross-origin.txt', exact: true }).waitFor();
  const crossDownload = page.waitForEvent('download'); await view.getByRole('button', { name: 'Download cross-origin.txt', exact: true }).click();
  assert.equal(await readFile(await (await crossDownload).path(), 'utf8'), 'cross origin');
  assert.deepEqual(errors, []);
  console.log('PASS files: local and real SFTP browsing, binary uploads/downloads, Unicode names, symlink folders, duplicate protection, owner/origin isolation, one-use links, no shell in Files tabs, mobile menu and restored directory');
} catch (e) { console.error(system.logs); throw e; }
finally { await browser?.close(); await system.close(); }
