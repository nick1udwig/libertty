import { launchBrowser } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
import { filesFixture } from './support/files-fixture.mjs';

const system = await filesFixture({ sourceFile: true, locale: true });
const { fixture, origin, base, sshPort, bytes, key, owner, other, request } = system;
let browser;
try {
  const local = await (await request(base, 'api/sessions', owner, { name: 'Local terminal' })).json();
  assert.equal((await request(base, 'api/files/list?session=' + local.id, other)).status, 404);
  assert.equal((await request(base, 'api/files/list?session=' + local.id)).status, 401);
  for (const bearer of [undefined, other]) {
    const response = await fetch(base + 'api/images/upload?session=' + local.id + '&name=photo.png', { method: 'POST', headers: { Origin: origin, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, body: bytes });
    assert.equal(response.status, bearer ? 404 : 401);
  }

  assert.equal((await fetch(base + 'api/files/upload?session=' + local.id, { method: 'POST', headers: { Origin: 'http://untrusted.invalid', Authorization: 'Bearer ' + owner }, body: 'x' })).status, 403);
  const ssh = { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, privateKey: key.private, passphrase: 'test-passphrase-123' };
  const trust = await (await request(base, 'api/sessions', owner, { name: 'Remote', ssh })).json(); assert.ok(trust.fingerprint, JSON.stringify(trust)); ssh.trust = trust.fingerprint;
  const remote = await (await request(base, 'api/sessions', owner, { name: 'Remote', ssh })).json(); assert.ok(remote.id, JSON.stringify(remote));
  browser = await launchBrowser({ });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await installWireObserver(context);
  await context.addInitScript(({ base, owner }) => {
    localStorage.setItem('termai.access:' + base, owner);
    const Original = WebSocket; window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async event => { const m = await window.__wireMessage(event.data, this); if (m.type === 'state') window.__state = m.state; if (m.type === 'transfer') window.__transfer = m.request; if (m.type === 'output') window.__output = (window.__output || '') + m.data; }); } };
  }, { base, owner });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
  async function type(command) { await page.waitForFunction(() => window.__state?.ready); await page.locator('#terminal textarea').focus(); await page.keyboard.type(command); await page.keyboard.press('Enter'); }
  for (const [session, dir] of [[local.id, 'local'], [remote.id, 'remote']]) {
    console.log('Testing utilities', dir);
    await page.goto(base + 'terminal.html?session=' + session); await page.waitForFunction(() => window.__state?.ready && document.querySelector('#connection-label')?.textContent === 'Connected');
    const imageResponse = page.waitForResponse(response => response.url().includes('/api/images/upload'));
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Attach images', exact: true }).click();
    const picker = await chooser; assert.equal(await picker.element().getAttribute('accept'), 'image/png,image/jpeg,image/webp,image/gif');
    await picker.setFiles({ name: 'screen shot.png', mimeType: 'image/png', buffer: bytes });
    const uploaded = await imageResponse; assert.equal(uploaded.status(), 200);
    const imagePath = (await uploaded.json()).path;
    assert.deepEqual(await readFile(imagePath), bytes, 'Image reaches the selected local or SSH host');
    await page.waitForFunction(path => window.__output?.includes(path), imagePath);
    await page.getByRole('button', { name: 'Attach images', exact: true }).waitFor({ state: 'visible' });
    await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+u');
    await rm(imagePath);
    await page.locator('#terminal canvas').click();
    await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: 'Ls pipe through Grepp hello_world', bubbles: true, cancelable: true })));
    await page.locator('.alternative-choice .choice-command').filter({ hasText: /^ls \| grep hello_world$/ }).waitFor();
    const beforePipe = await page.evaluate(() => window.__state.prompt);
    await page.locator('.alternative-choice .choice-command').filter({ hasText: /^ls \| grep hello_world$/ }).click();
    await page.waitForFunction(prompt => window.__state.ready && window.__state.prompt > prompt, beforePipe);
    await page.locator('#terminal canvas').click();
    await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: 'upload', bubbles: true, cancelable: true })));
    await page.locator('.alternative-choice .choice-icon svg').waitFor();
    const path = await page.locator('.alternative-choice .choice-icon svg path').first().getAttribute('d');
    assert.equal(path, 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5');
    await page.locator('.alternative-choice').filter({ hasText: /^upload/ }).click();
    await page.locator('.transfer-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => window.__state.ready);
    await page.locator('#terminal textarea').focus();
    await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'download hello world dot py', bubbles: true, cancelable: true })));
    await page.locator('.alternative-choice .choice-command').filter({ hasText: /^download hello_world.py$/ }).waitFor();
    const chosen = page.waitForEvent('download'); await page.locator('.alternative-choice').filter({ hasText: /^download hello_world.py/ }).click();
    assert.equal(await readFile(await (await chosen).path(), 'utf8'), 'source file');
    await page.locator('.download-dialog h2').filter({ hasText: 'Download complete' }).waitFor();
    assert.equal(await page.locator('.download-dialog progress').getAttribute('value'), '100');
    await page.locator('.download-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => window.__state.ready);
    await type('upload; cd docs');
    const modal = page.locator('.transfer-dialog'); await modal.waitFor();
    assert.ok((await modal.locator('p').first().textContent()).endsWith('/' + dir));
    await modal.locator('input[type=file]').setInputFiles({ name: 'shell-upload.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await modal.getByRole('button', { name: 'Done', exact: true }).waitFor(); assert.deepEqual(await readFile(fixture + '/' + dir + '/shell-upload.bin'), bytes);
    await modal.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => window.__state?.ready && window.__state.cwd.endsWith('/docs'));
    let pending = page.waitForEvent('download'); await type("download 'über file.bin'"); let file = await pending;
    assert.equal(file.suggestedFilename(), 'über file.bin'); assert.deepEqual(await readFile(await file.path()), bytes);
    await page.locator('.download-dialog h2').filter({ hasText: 'Download complete' }).waitFor();
    await page.locator('.download-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    pending = page.waitForEvent('download'); await type("printf '\\000\\377ABC' | download 'pipe result.bin'"); file = await pending;
    assert.equal(file.suggestedFilename(), 'pipe result.bin'); assert.deepEqual(await readFile(await file.path()), Buffer.from([0, 255, 65, 66, 67]));
    await page.locator('.download-dialog h2').filter({ hasText: 'Download complete' }).waitFor();
    // The browser queues dialog close events, which may arrive after the next transfer.
    await page.locator('.download-dialog').evaluate(modal => {
      const dispose = modal.onclose;
      modal.onclose = () => {};
      window.__finishDownloadClose = () => dispose.call(modal, new Event('close'));
    });
    await page.locator('.download-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    pending = page.waitForEvent('download'); await type('printf "" | download'); file = await pending;
    assert.equal(file.suggestedFilename(), 'command-output.txt'); assert.equal((await readFile(await file.path())).length, 0);
    await page.evaluate(() => { window.__finishDownloadClose(); delete window.__finishDownloadClose; });
    await page.locator('.download-dialog h2').filter({ hasText: 'Download complete' }).waitFor();
    await page.locator('.download-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => window.__state.ready);
    const beforeHistory = await page.evaluate(() => window.__state.prompt);
    const historyFile = `${fixture}/${dir}/history-inspection`;
    await type(` builtin history -w '${historyFile}'`);
    await page.waitForFunction(prompt => window.__state.ready && window.__state.prompt > prompt, beforeHistory);
    const history = (await readFile(historyFile, 'utf8')).split('\n').filter(line => line && !/^#\d+$/.test(line));
    assert.deepEqual(history, ['ls | grep hello_world'], 'Transfer utilities and their setup must stay out of local and SSH history');
  }
  assert.deepEqual(errors, []);
  console.log('PASS transfer utilities: local and real SSH upload picker, invocation cwd despite cd, Unicode file downloads, binary pipe downloads, named/default output, empty output');
} catch (e) { console.error(system.logs); if (browser) console.error(await browser.contexts()[0].pages()[0].evaluate(() => ({ state: window.__state, transfer: window.__transfer, output: window.__output, modal: document.querySelector('.transfer-dialog')?.outerHTML, downloads: document.querySelector('.download-dialog')?.outerHTML }))); throw e; }
finally { await browser?.close(); await system.close(); }
