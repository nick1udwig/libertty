import { launchBrowser, freePort, delay, until } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const fixturePort3123 = await freePort();
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-browser-'));
await mkdir(path.join(fixture, 'subfolder'));
await mkdir(path.join(fixture, 'ops'));
await writeFile(path.join(fixture, 'SKILL.md'), '# Skill');
await mkdir(path.join(fixture, 'bin'));
await mkdir(path.join(fixture, 'git', 'pebble-agent'), { recursive: true });
await mkdir(path.join(fixture, 'git', 'branchpoint', 'branchpoint'), { recursive: true });
await writeFile(path.join(fixture, 'bin', 'contexttool'), `#!/bin/sh
if [ "$1" = '--help' ]; then
  printf 'probe\\n' >> help-probes.txt
  printf '  --say VALUE  Message\\n'
else
  printf '%s %s\\n' "$1" "$2" >> auto-runs.txt
fi
`, { mode: 0o700 });
await writeFile(path.join(fixture, 'hello_world.py'), `import argparse\nfrom pathlib import Path\np=argparse.ArgumentParser()\np.add_argument('--myarg')\na=p.parse_args()\nwith Path('executions.txt').open('a') as f: f.write(a.myarg+'\\n')\nprint('HELLO_VALUE='+a.myarg)\n`);
await writeFile(path.join(fixture, 'history'), "echo remembered-command\ngit c . m 'add init commit'\n");
await writeFile(path.join(fixture, '.gitconfig'), '[alias]\n c = commit\n');
await writeFile(path.join(fixture, 'eternal-history'), '#1234567890\ngit init\n');
const port = Number(process.env.TEST_PORT || fixturePort3123);
const origin = `http://127.0.0.1:${port}`;
const mount = process.env.TEST_BASE_PATH || '';
const base = origin + mount;
const pairingToken = 'test-local-pairing-token-123456789';
const server = spawn(process.env.TEST_EXECUTABLE || path.join(root, 'target/debug/termai'), [], { cwd: root, env: { ...process.env, HOME: fixture, NODE_ENV: 'production', TERMAI_BASE_PATH: mount, HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: pairingToken, TERMAI_ALLOWED_HOSTS: '127.0.0.1,localhost', PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH, TERMAI_NO_RC: '1', TERMAI_CWD: fixture, TERMAI_HISTORY_FILE: path.join(fixture, 'history'), TERMAI_ETERNAL_HISTORY_FILE: path.join(fixture, 'eternal-history') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
let browser;
async function focusTerminal(page) { await page.locator('#terminal textarea').evaluate(el => el.focus()); }
async function shellPrompt(page) { return page.evaluate(() => window.__shellState.prompt); }
async function ready(page, previous = -1) { await page.waitForFunction(previous => window.__shellState?.ready && window.__shellState.prompt > previous, previous); }
async function dictate(page, text, inputType = 'insertText') {
  await focusTerminal(page);
  await page.locator('#terminal textarea').evaluate((el, { inputType, text }) => el.dispatchEvent(new InputEvent('beforeinput', { inputType, data: text, bubbles: true, cancelable: true })), { inputType, text });
}
async function shellHistory(page) {
  const file = path.join(fixture, 'history-inspection');
  await command(page, ` builtin history -w '${file}'`);
  return (await readFile(file, 'utf8')).split('\n').filter(line => line && !/^#\d+$/.test(line));
}
async function command(page, text) {
  const before = await shellPrompt(page); await focusTerminal(page);
  await page.keyboard.type(text); await page.keyboard.press('Enter'); await ready(page, before);
}
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { if (server.exitCode !== null) throw new Error(logs); return false; } });
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await installWireObserver(page.context());
  await page.addInitScript(() => {
    const paint = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { if (window.__paint) window.__paint.push(text); return paint.call(this, text, ...args); };
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', async event => { const message = await window.__wireMessage(event.data, this); if (message.type === 'repair-result') window.__lastRepairResult = message; if (message.type === 'hello') window.__engineMode = message.engine; if (message.type === 'state') window.__shellState = message.state; if (message.type === 'output') window.__terminalOutput = (window.__terminalOutput || '') + message.data; }); }
      send(data) { const message = window.__wireSent(data); (window.__sent ||= []).push(message); if (message.type === 'resize') window.__terminalSize = message; if (['repair', 'repair-cancel'].includes(message.type) && window.__repairDelay) setTimeout(() => { if (this.readyState === 1) super.send(data); }, window.__repairDelay); else super.send(data); }
    };
  });
  const workers = []; page.on('worker', worker => workers.push(worker));
  const requests = []; context.on('request', request => requests.push(request.url()));
  await page.goto(base + "/terminal.html");
  await page.locator('#login-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__shellState), undefined);
  await page.locator('#token').fill('wrong'); await page.locator('#login-form button').click();
  await page.waitForFunction(() => document.querySelector('#login-error').textContent.includes('did not match'));
  await page.locator('#token').fill(pairingToken); await page.locator('#login-form button').click(); await ready(page);
  assert.equal(await page.locator('#token').inputValue(), '');
  assert.equal(await page.evaluate(() => window.__engineMode), 'server');
  // Prompt caching must still notice shell definitions and newly installed executables.
  await command(page, 'alias freshalias=pwd; freshfunction() { :; }');
  const suggestAtPrompt = text => page.evaluate(async text => (await (await fetch(new URL('api/suggest', document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json()).candidates, text);
  assert.ok((await suggestAtPrompt('Fresh alias')).some(candidate => candidate.command === 'freshalias' && !candidate.literal));
  await command(page, 'unalias freshalias; unset -f freshfunction');
  assert.ok(!(await suggestAtPrompt('Fresh alias')).some(candidate => candidate.command === 'freshalias' && !candidate.literal));
  await writeFile(path.join(fixture, 'bin', 'freshbinary'), '#!/bin/sh\nprintf fresh\\n\n', { mode: 0o700 });
  await writeFile(path.join(fixture, 'new-context-file.txt'), 'new');
  await command(page, ':');
  assert.ok((await suggestAtPrompt('Fresh binary')).some(candidate => candidate.command === 'freshbinary' && !candidate.literal));
  assert.ok((await suggestAtPrompt('cat new context file dot txt')).some(candidate => candidate.command === 'cat new-context-file.txt'));
  assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family === 'JetBrains Mono' && font.status === 'loaded')));
  const originalSize = await page.evaluate(() => window.__terminalSize);
  await page.locator('#menu-button').click();
  const fontSize = page.getByLabel('Terminal font size (pt)');
  assert.equal(await fontSize.inputValue(), '10');
  await fontSize.fill('20');
  await page.waitForFunction(original => window.__terminalSize.cols < original.cols && window.__terminalSize.rows < original.rows, originalSize);
  for (const invalid of ['', '5', '25', '10.25']) {
    await fontSize.fill(invalid);
    assert.equal(await page.evaluate(() => localStorage.getItem('termai.fontSizePt')), '20');
  }
  await fontSize.blur();
  assert.equal(await fontSize.inputValue(), '20');
  await page.reload(); await ready(page);
  await page.locator('#menu-button').click();
  assert.equal(await fontSize.inputValue(), '20');
  await fontSize.fill('10');
  await page.waitForFunction(original => window.__terminalSize.cols === original.cols && window.__terminalSize.rows === original.rows, originalSize);
  await page.evaluate(() => localStorage.setItem('termai.fontSizePt', '999'));
  await page.reload(); await ready(page);
  await page.locator('#menu-button').click();
  assert.equal(await fontSize.inputValue(), '10');
  await page.getByRole('button', { name: 'Close session options' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir(path.join(root, '.test-artifacts'), { recursive: true });
  // A completion helper is a shell function, not a spoken git subcommand.
  await command(page, '_git_init() { printf bad > helper-was-run; }');
  assert.ok((await suggestAtPrompt('Get in it.')).some(candidate => candidate.command === 'git init'), 'Eternal history participates in suggestions');
  requests.length = 0;
  // Keep full mobile captures free of setup commands and interrupt markers.
  await command(page, 'stty -echoctl; clear');
  await dictate(page, 'Get in it.');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'git init');
  assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), ['git init', 'Get in it.']);
  assert.equal(existsSync(path.join(fixture, '.git')), false, 'Validation must not execute git init');
  assert.equal(existsSync(path.join(fixture, 'helper-was-run')), false);
  await page.screenshot({ path: path.join(root, '.test-artifacts/git-init-repair.png') });
  await page.screenshot({ path: path.join(root, '.test-artifacts/example-git-init.png') });
  const gitPrompt = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, gitPrompt);
  // A bad historical match must not change an explicit -m into punctuation.
  await dictate(page, 'Git c -m "add init commit"');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === "git c -m 'add init commit'");
  assert.ok((await page.locator('.alternative-choice .choice-command').allTextContents()).every(text => !text.includes('. m')));
  assert.equal(existsSync(path.join(fixture, '.git')), false);
  await page.screenshot({ path: path.join(root, '.test-artifacts/git-alias-message.png') });
  const aliasPrompt = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, aliasPrompt);
  // First-device regression: glued uppercase dictation must discover real ls options.
  await dictate(page, 'LSL');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'ls -l');
  assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), ['ls -l', 'ls -L', 'LSL']);
  await page.screenshot({ path: path.join(root, '.test-artifacts/dictation-ls-l.png') });
  await page.screenshot({ path: path.join(root, '.test-artifacts/example-ls.png') });
  const firstPrompt = await shellPrompt(page);
  await page.keyboard.press('Enter'); await ready(page, firstPrompt);
  assert.equal((await shellHistory(page)).at(-1), 'ls -l');
  await page.locator('#menu-button').click();
  assert.equal(await page.locator('#tap-alternate-send').isChecked(), true);
  await page.locator('#tap-alternate-send').uncheck();
  await page.getByRole('button', { name: 'Close session options' }).click();
  await page.evaluate(() => window.__repairDelay = 900);
  await dictate(page, 'Python three hello world dot py myarg food');
  await page.waitForSelector('#alternatives-toggle.loading');
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.literal-choice').count(), 0, 'Pending lookup should show only the entry spinner');
  assert.equal(await page.locator('#alternatives-toggle.loading .spinner').isVisible(), true);
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('.dictation-presentation').isVisible(), true);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.literal-choice').count(), 0, 'A slow request must not reveal the transcript partway through');
  assert.equal(await page.locator('#alternatives-toggle.loading').count(), 1);
  await page.screenshot({ path: path.join(root, '.test-artifacts/inline-loading.png') });
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'python3 hello_world.py --myarg food').catch(async error => { throw new Error(JSON.stringify(await page.evaluate(() => ({ result: window.__lastRepairResult, state: window.__shellState, sent: window.__sent.slice(-8), choices: [...document.querySelectorAll('.choice-command')].map(el => el.textContent) }))), { cause: error }); });
  assert.equal(existsSync(path.join(fixture, 'executions.txt')), false, 'Discovery and selection must not execute the line');
  assert.equal(await page.locator('.literal-choice .choice-command').textContent(), 'Python three hello world dot py myarg food');
  await page.screenshot({ path: path.join(root, '.test-artifacts/inline-ready.png') });
  await page.screenshot({ path: path.join(root, '.test-artifacts/example-python.png') });
  let before = await shellPrompt(page);
  await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'executions.txt'), 'utf8'), 'food\n');
  await page.evaluate(() => window.__repairDelay = 0);
  await page.locator('#menu-button').click();
  await page.locator('#tap-alternate-send').check();
  await page.getByRole('button', { name: 'Close session options' }).click();
  // Tapping sends by default, including literal rows. Repeated taps cannot run twice.
  assert.equal(await page.locator('#edit-shortcuts').count(), 0);
  await dictate(page, 'contexttool say tapped');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say tapped');
  let tappedPrompt = await shellPrompt(page);
  await page.locator('.alternative-choice.selected').evaluate(button => { button.click(); button.click(); });
  await ready(page, tappedPrompt);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), '--say tapped\n');
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  await dictate(page, 'contexttool say raw');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say raw');
  tappedPrompt = await shellPrompt(page); await page.locator('.literal-choice').click(); await ready(page, tappedPrompt);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), '--say tapped\nsay raw\n');
  await rm(path.join(fixture, 'auto-runs.txt'));
  await page.locator('#menu-button').click();
  await page.locator('#tap-alternate-send').uncheck();
  await page.getByRole('button', { name: 'Close session options' }).click();
  // Literal and alternative selection edit the real shell line, without submitting.
  await dictate(page, 'contexttool say literal');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say literal');
  await page.locator('.literal-choice').click();
  assert.equal(existsSync(path.join(fixture, 'auto-runs.txt')), false);
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
  await page.locator('#alternatives-toggle').click();
  assert.equal(await page.locator('#alternatives-menu').isVisible(), true);
  await page.locator('#terminal canvas').click({ position: { x: 10, y: 300 } });
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
  await page.locator('#alternatives-toggle').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), 'say literal\n');
  // Collapsed by default still repairs the line and can be expanded at the cursor.
  await page.locator('#menu-button').click(); await page.locator('#auto-alternatives').uncheck();
  await page.getByRole('button', { name: 'Close session options' }).click();
  await dictate(page, 'contexttool say hello');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'contexttool --say hello');
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
  await page.locator('#alternatives-toggle').click();
  assert.equal(await page.locator('#alternatives-menu').isVisible(), true);
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'auto-runs.txt'), 'utf8'), 'say literal\n--say hello\n');
  assert.equal(await readFile(path.join(fixture, 'help-probes.txt'), 'utf8'), 'probe\n', 'Background help is cached');
  // A late response cannot replace text the user has edited or submitted.
  await page.evaluate(() => window.__repairDelay = 500);
  await dictate(page, 'echo original');
  await page.waitForSelector('#alternatives-toggle.loading');
  await page.keyboard.type(' edited');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  await delay(650);
  assert.equal((await shellHistory(page)).at(-1), 'echo original edited');
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  await page.evaluate(() => window.__repairDelay = 0);
  // Composition commits are inserted once even if the browser follows with beforeinput.
  await focusTerminal(page);
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })));
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: 'echo composition', bubbles: true })));
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { data: 'echo composition', inputType: 'insertText', bubbles: true, cancelable: true })));
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo composition');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal((await shellHistory(page)).at(-1), 'echo composition');
  // Android-style word composition streams each edit, and is not mistaken for dictation.
  // Bulk dictation may revise its partial transcript within a composition.
  for (const parts of [['echo partial', 'echo revised'], ['e', 'echo', 'echo gradual']]) {
    await focusTerminal(page);
    await page.locator('#terminal textarea').evaluate((el, parts) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const data of parts) {
        el.dispatchEvent(new CompositionEvent('compositionupdate', { data, bubbles: true }));
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true, cancelable: true }));
      }
      el.dispatchEvent(new CompositionEvent('compositionend', { data: parts.at(-1), bubbles: true }));
    }, parts);
    await page.waitForFunction(text => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === text, parts.at(-1));
    assert.equal(await page.locator('#alternatives-toggle').isVisible(), true);
    before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
    assert.equal((await shellHistory(page)).at(-1), parts.at(-1));
  }
  // A history or completion operation requires the real Readline buffer before repair.
  await command(page, 'echo recovered');
  await page.keyboard.press('ArrowUp'); await dictate(page, ' voice');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo recovered voice');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  await page.keyboard.type('echo tab'); await page.keyboard.press('Tab'); await dictate(page, ' voice');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo tab voice');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  // Ctrl-D with text under the cursor deletes it and leaves dictation available.
  await page.keyboard.type('Xecho'); await page.keyboard.press('Home'); await page.keyboard.press('Control+d');
  await page.keyboard.press('End'); await dictate(page, ' eof');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo eof');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  await dictate(page, 'echo typed');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo typed');
  await page.locator('#terminal').evaluate(el => el.focus());
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el === document.activeElement), true);
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ' ', bubbles: true, cancelable: true })));
  await page.locator('#terminal textarea').evaluate(el => {
    window.__terminalOutput = '';
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'w', bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: 'w', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  // Capture the shell output before composition commits: the first letter is already sent.
  await page.waitForFunction(() => window.__terminalOutput.includes('w'));
  await page.locator('#terminal textarea').evaluate(el => {
    for (const data of ['wo', 'wox', 'wor', 'word']) {
      el.dispatchEvent(new CompositionEvent('compositionupdate', { data, bubbles: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true, cancelable: true }));
    }
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'word', bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'word', bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 's', bubbles: true, cancelable: true }));
  });
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal((await shellHistory(page)).at(-1), 'echo typed words');
  // The IME must have a preceding character to issue Backspace after PTY-only dictation.
  await dictate(page, 'echo dictatedXYZ');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'echo dictatedXYZ');
  for (let i = 0; i < 3; i++) {
    assert.equal(await page.locator('#terminal textarea').evaluate(el => {
      if (!el.value || !el.selectionStart) return false;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', data: null, bubbles: true, cancelable: true }));
      return true;
    }), true);
  }
  assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
  await page.locator('#terminal textarea').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
  });
  await page.keyboard.type('d');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal((await shellHistory(page)).at(-1), 'echo dictated');
  // Backspace cancels an in-flight repair instead of allowing the deleted text back in.
  await page.evaluate(() => window.__repairDelay = 400);
  await dictate(page, 'echo pendingX');
  await page.waitForSelector('#alternatives-toggle.loading');
  await page.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })));
  await delay(500);
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal((await shellHistory(page)).at(-1), 'echo pending');
  await page.evaluate(() => window.__repairDelay = 0);
  // Exact flag case can remain the top hit while offering its lowercase alternative.
  await dictate(page, 'ls -L');
  await page.waitForFunction(() => !document.querySelector('#alternatives-toggle').classList.contains('loading'));
  assert.equal(await page.locator('.alternative-choice.selected .choice-command').textContent(), 'ls -L');
  assert.ok((await page.locator('.alternative-choice .choice-command').allTextContents()).includes('ls -l'));
  before = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, before);
  // Spoken separators and a misheard home-directory component resolve to a real directory.
  for (const [input, expected] of [
    ['Alice', 'ls'],
    ['L S', 'ls'],
    ['c D ops semicolon ls', 'cd ops; ls'],
    ['C D tilda slash git slash pebble agent', 'cd ~/git/pebble-agent'],
    ['see dee tilda slash git slash branch point slash branch po', 'cd ~/git/branchpoint/branchpoint'],
    ['vi skill dot md', 'vi SKILL.md'],
    ['ell ess', 'ls'],
    ['pee double you dee', 'pwd'],
    ['Cd tilda slach get slach pebble agent', 'cd ~/git/pebble-agent'],
    ['CD toldo slash git slash branch point slash branch po', 'cd ~/git/branchpoint/branchpoint'],
    ['echo dollar sign HOME', 'echo $HOME'],
  ]) {
    await dictate(page, input);
    await page.waitForFunction(expected => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === expected, expected)
      .catch(async error => { throw new Error(`${input}: expected ${expected}; choices: ${JSON.stringify(await page.locator('.alternative-choice .choice-command').allTextContents())}; result: ${JSON.stringify(await page.evaluate(() => window.__lastRepairResult))}; selected: ${JSON.stringify(await page.locator('.alternative-choice.selected').allTextContents())}`, { cause: error }); });
    assert.ok((await page.locator('.alternative-choice .choice-command').allTextContents()).includes(input));
    if (input === 'c D ops semicolon ls') {
      await page.locator('#alternatives-toggle').click();
      const choices = await page.locator('.alternative-choice .choice-command').allTextContents();
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Reconnecting');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Connected');
      assert.equal(await page.locator('#alternatives-menu').isVisible(), true);
      assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), choices);
    }
    before = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, before);
  }
  await dictate(page, 'Cd ~ fas get fas pebble agent');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'cd ~/git/pebble-agent');
  // A known input buffer uses one guarded terminal repair transaction.
  before = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, before);
  await page.evaluate(() => window.__sent = []);
  await dictate(page, 'Cd ~ fas get fas pebble agent');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'cd ~/git/pebble-agent');
  const directoryRequests = await page.evaluate(() => window.__sent.filter(message => ['repair', 'replace'].includes(message.type)));
  assert.equal(directoryRequests.length, 1, JSON.stringify(directoryRequests));
  assert.equal(directoryRequests[0].type, 'repair', 'Repair and guarded application require one request');
  assert.equal(workers.length, 0, 'Production repair stays on the backend in both coordinators');
  assert.ok(!requests.some(url => /\/api\/(facts|suggest)$/.test(url)), 'Dictation must not relay host facts or request separate repair HTTP calls');
  assert.equal(await page.evaluate(() => window.__shellContext), undefined, 'Repair must not push catalogs');
  before = await shellPrompt(page); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal(await page.locator('#cwd').textContent(), path.join(fixture, 'git', 'pebble-agent'));
  await command(page, `cd ${fixture}`);
  // Persisted preference, no replayed commands after reload.
  await page.reload(); await ready(page);
  await page.locator('#menu-button').click(); assert.equal(await page.locator('#auto-alternatives').isChecked(), false);
  assert.equal(await page.locator('#tap-alternate-send').isChecked(), false);
  await page.locator('#auto-alternatives').check(); await page.getByRole('button', { name: 'Close session options' }).click();
  assert.equal(await readFile(path.join(fixture, 'executions.txt'), 'utf8'), 'food\n');
  // Saved command and key shortcuts remain available in the always-terminal view.
  await page.locator('#menu-button').click(); await page.locator('#customize-shortcuts').click(); await page.locator('#add-shortcut').click();
  await page.locator('.shortcut-row').last().locator('.shortcut-label').fill('Saved command');
  await page.locator('.shortcut-row').last().locator('.binding').fill('printf shortcut >> shortcuts.txt');
  await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
  before = await shellPrompt(page); await page.getByRole('button', { name: 'Saved command', exact: true }).click(); await ready(page, before);
  assert.equal(await readFile(path.join(fixture, 'shortcuts.txt'), 'utf8'), 'shortcut');
  await focusTerminal(page); await page.keyboard.type('sleep 5'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.__shellState.ready);
  assert.equal(await page.getByRole('button', { name: 'Saved command', exact: true }).isDisabled(), true);
  before = await shellPrompt(page); await page.getByRole('button', { name: 'Ctrl C', exact: true }).click(); await ready(page, before);
  await command(page, 'cd subfolder');
  assert.ok((await page.locator('#cwd').textContent()).endsWith('/subfolder'));
  before = await shellPrompt(page); await page.getByRole('button', { name: 'Ctrl R', exact: true }).click();
  await page.keyboard.type('remembered'); await page.keyboard.press('Enter'); await ready(page, before);
  assert.equal((await shellHistory(page)).at(-1), 'echo remembered-command');
  await dictate(page, 'ls dash all');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'ls --all');
  await page.screenshot({ path: path.join(root, '.test-artifacts/mobile.png') });
  assert.equal(await page.locator('#terminal').evaluate(el => el.getBoundingClientRect().top), 0);
  assert.equal(await page.locator('#composer-panel, #compose-mode, #raw-mode').count(), 0);
  assert.ok(await page.locator('.input-dock').evaluate(el => el.clientHeight) <= 54);
  await page.setViewportSize({ width: 390, height: 460 });
  await page.screenshot({ path: path.join(root, '.test-artifacts/keyboard-viewport.png') });
  await page.waitForFunction(() => { const r = document.querySelector('#alternatives-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= document.querySelector('.input-dock').getBoundingClientRect().top; });
  await page.screenshot({ path: path.join(root, '.test-artifacts/keyboard-viewport.png') });
  await page.keyboard.press('Control+c'); await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await ready(page);
  await context.setOffline(true); await page.reload(); await page.waitForSelector('#terminal');
  await page.waitForSelector('#terminal canvas');
  await page.waitForFunction(() => [...document.fonts].some(font => font.family === 'JetBrains Mono' && font.status === 'loaded'));
  await context.setOffline(false); await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Connected', {}, { timeout: 15000 });
  await page.locator('#menu-button').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#new-shell').click();
  await page.waitForFunction(() => window.__shellState?.ready && window.__shellState.prompt === 1);
  await page.evaluate(() => window.__paint = []);
  await command(page, 'printf RESET-OK');
  await page.waitForFunction(() => window.__paint.join('').includes('RESET-OK'));
  assert.equal(await page.evaluate(() => window.__paint.some(text => /[^\x20-\x7e]/.test(text))), false, 'Reset must not paint corrupted glyphs');
  assert.deepEqual(errors, []);
  // Live shell completion definitions supply both Git refs and generic names.
  const gitCompletion = [
    process.env.TERMAI_GIT_COMPLETIONS_FILE,
    '/usr/share/bash-completion/completions/git',
    '/opt/homebrew/opt/git/etc/bash_completion.d/git-completion.bash',
    '/usr/local/opt/git/etc/bash_completion.d/git-completion.bash',
  ].find(file => file && existsSync(file));
  assert.ok(gitCompletion, 'Install Git Bash completion for the live completion checks.');
  await command(page, `cd ${fixture}; source '${gitCompletion.replace(/'/g, "'\\''")}'; git init -q; git symbolic-ref HEAD refs/heads/feat/elixir-worker; git -c user.name=Test -c user.email=test@example.test commit --allow-empty -qm initial; git remote add origin https://example.invalid/repo.git`);
  for (const [input, expected] of [
    ['git push dash u origin feet/elixir dash worker', 'git push -u origin feat/elixir-worker'],
    ['git checkout F E A T', 'git checkout feat/elixir-worker'],
  ]) {
    await dictate(page, input);
    await page.waitForFunction(expected => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === expected, expected)
      .catch(async error => { throw new Error(`${input}: expected ${expected}; choices: ${JSON.stringify(await page.locator('.alternative-choice .choice-command').allTextContents())}; result: ${JSON.stringify(await page.evaluate(() => window.__lastRepairResult))}; selected: ${JSON.stringify(await page.locator('.alternative-choice.selected').allTextContents())}`, { cause: error }); });
    assert.ok((await page.locator('.alternative-choice .choice-command').allTextContents()).includes(input));
    assert.equal((await readFile(path.join(fixture, '.git', 'HEAD'), 'utf8')).trim(), 'ref: refs/heads/feat/elixir-worker');
    before = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, before);
  }
  await command(page, "orchard() { printf ran > completion-executed; }; _orchard_complete() { COMPREPLY=(release/east-zone release/west-zone); }; complete -F _orchard_complete orchard");
  await dictate(page, 'orchard deploy release slash east dash zone');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'orchard deploy release/east-zone');
  assert.equal(existsSync(path.join(fixture, 'completion-executed')), false);
  before = await shellPrompt(page); await page.keyboard.press('Control+c'); await ready(page, before);
  assert.deepEqual(errors, []);
  console.log('PASS browser: inline loading/top-hit/literal, actual Readline editing, collapsed menu, stale-response cancellation, IME deduplication, shortcuts, Ctrl-R, mobile/keyboard layout, reconnect/offline');

  assert.equal((await fetch(base + '/api/suggest', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  const login = await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token: pairingToken }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws?after=0', { headers: { Origin: origin, Cookie: cookie } });
  const messages = []; let lastState; let allOutput = '';
  socket.on('message', raw => { const m = JSON.parse(raw.toString()); messages.push(m); if (m.type === 'state') lastState = m.state; if (m.type === 'output') { allOutput += m.data; socket.send(JSON.stringify({ type: 'ack', seq: m.seq })); } });
  await until(() => lastState?.ready);
  const editPrompt = lastState.prompt, revision = lastState.inputRevision;
  socket.send(JSON.stringify({ type: 'replace', text: 'echo draft', id: 'draft', prompt: editPrompt, revision }));
  await until(() => messages.some(m => m.type === 'edit-result' && m.id === 'draft'));
  assert.equal(messages.find(m => m.type === 'edit-result' && m.id === 'draft').accepted, true);
  socket.send(JSON.stringify({ type: 'replace', text: 'echo stale', id: 'stale-edit', prompt: editPrompt, revision }));
  await until(() => messages.some(m => m.type === 'edit-result' && m.id === 'stale-edit'));
  assert.equal(messages.find(m => m.type === 'edit-result' && m.id === 'stale-edit').accepted, false);
  assert.ok(lastState.ready, 'Replacing a line must not submit it');
  const prompt = lastState.prompt;
  const message = { type: 'command', id: 'deduplicate', command: 'printf x >> dedup.txt', prompt };
  socket.send(JSON.stringify(message)); socket.send(JSON.stringify(message));
  await until(() => lastState.ready && lastState.prompt > prompt);
  assert.equal(await readFile(path.join(fixture, 'dedup.txt'), 'utf8'), 'x');
  socket.send(JSON.stringify({ ...message, id: 'stale' }));
  await until(() => messages.some(m => m.type === 'result' && m.id === 'stale'));
  assert.equal(messages.find(m => m.type === 'result' && m.id === 'stale').accepted, false);
  const floodPrompt = lastState.prompt;
  socket.send(JSON.stringify({ type: 'command', id: 'flood', command: "python3 -c 'print(\"output line\\n\" * 30000); print(\"FLOOD_DONE\")'", prompt: floodPrompt }));
  await until(() => allOutput.includes('FLOOD_DONE') && lastState.ready && lastState.prompt > floodPrompt, 20000);
  assert.ok(allOutput.length > 300000);
  socket.close();
  console.log('PASS transport: origin/auth checks, command deduplication, stale-prompt rejection, 300KB+ output with acknowledgements');
} catch (error) {
  console.error('Server log:', logs); throw error;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(4000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(fixture, { recursive: true, force: true });
}
