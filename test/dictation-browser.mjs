import { installWireObserver } from './wire-observer.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { parseOpusFrame } from '../src/voxtype-audio.ts';
import { getPacketInfo } from 'libopus-wasm';
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-dictation-browser-'));
await mkdir(path.join(fixture, 'source/scripts'), { recursive: true });
await writeFile(path.join(fixture, 'history'), 'git init\n');
await writeFile(path.join(fixture, 'source/scripts/install'), 'touch ' + path.join(fixture, 'installed'));
await writeFile(path.join(fixture, 'program.mjs'), `
import { appendFileSync } from 'node:fs';
process.stdin.setRawMode(true);
if (process.argv[2] === 'bracketed') process.stdout.write('\\x1b[?2004h');
process.stdout.write('PROGRAM_READY');
process.stdin.on('data', bytes => {
  if (bytes.includes(3)) { process.stdout.write('\\x1b[?2004l'); process.stdin.setRawMode(false); process.exit(); }
  appendFileSync('program-input', bytes);
});
`);
if (process.env.TEST_CODEX) {
  await mkdir(path.join(fixture, '.codex'));
  await writeFile(path.join(fixture, '.codex/config.toml'), `model_provider = "fixture"
model = "fixture"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(fixture)}]
trust_level = "trusted"
`);
}
const daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(daemon, 'listening');
let audioBytes = 0, capabilities = true;
daemon.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, 'Bearer ' + 'secret'.repeat(8));
  assert.equal(request.headers.origin, undefined);
  if (request.url === '/v1/capabilities') { if (!capabilities) { socket.close(); return; } socket.send(JSON.stringify({ type: 'capabilities', protocol: 2, dictation: true, sample_rate: 16000, channels: 1, format: 'opus', framing: 'sequence_opus_v1', audio_encodings: ['opus_v1'], results: ['partial', 'final'] })); return; }
  assert.equal(request.headers['x-voxtype-protocol'], '2');
  assert.equal(request.headers['x-voxtype-audio'], 'opus_v1');
  assert.match(String(request.headers['x-voxtype-session']), /^[a-f0-9]{32}$/);
  socket.send(JSON.stringify({ type: 'ready', protocol: 2, sample_rate: 16000, channels: 1, format: 'opus', audio_encoding: 'opus_v1', framing: 'sequence_opus_v1', max_seconds: 300, max_encoded_bytes: 2097152, resume: true, accepted_frames: 0, finished: false }));
  let sequence = 0, final = false; const packets = [];
  socket.on('message', async (bytes, binary) => {
    if (binary) { const frame = parseOpusFrame(bytes); assert.equal(frame.sequence, sequence++); final = frame.final; packets.push(...frame.packets); audioBytes += bytes.length; }
    else if (JSON.parse(bytes.toString()).type === 'finish') {
      assert.equal(final, true);
      for (const packet of packets) { const info = await getPacketInfo(packet, { sampleRate: 16000 }); assert.equal(info.channels, 1); assert.equal(info.durationMs, 20); }
      socket.send(JSON.stringify({ type: 'partial', text: 'never forward this preview' }));
      setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'final', text: 'Get in it.' })); }, 600);
    }
  });
});
const port = Number(process.env.TEST_PORT || 3176), base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root,'target/debug/termai'), [], { cwd: root, env: { ...process.env, HOME: fixture, XDG_DATA_HOME: path.join(fixture, 'data'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: 'feature-test-pairing-token-123456789', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_NO_RC: '1', TERMAI_CWD: fixture, TERMAI_HISTORY_FILE: path.join(fixture, 'history'), TERMAI_VOXTYPE_SOURCE: path.join(fixture, 'source'), TERMAI_VOXTYPE_TOKEN_FILE: path.join(fixture, 'token'), TERMAI_VOXTYPE_URL: `ws://127.0.0.1:${daemon.address().port}/v1/dictate` }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
let browser;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base).then(r => r.ok, () => false)) break; if (server.exitCode !== null) throw new Error(logs); await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 600, height: 850 }, hasTouch: true });
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await installWireObserver(page.context());
  await page.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => { window.__captureConstraints = constraints; return capture(constraints); };
    window.__messages = []; window.__sent = []; window.__out = ''; window.__paint = [];
    const paint = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) { window.__paint.push({ text, x, y }); return paint.call(this, text, x, y, ...args); };
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', async event => { const m = await window.__wireMessage(event.data, this); window.__messages.push(m); if (m.type === 'output') window.__out += m.data; if (m.type === 'state') window.__state = m.state; }); }
      send(data) { if (window.__wireSent(data).type !== 'audio') { const m = window.__wireSent(data); window.__sent.push(m); if (m.type === 'resize') window.__size = m; } super.send(data); }
    };
  });
  page.setDefaultTimeout(20000);
  await page.goto(base + '/terminal.html');
  await page.locator('#token').fill('feature-test-pairing-token-123456789'); await page.locator('#login-form button').click();
  await page.waitForFunction(() => window.__state?.ready);
  await page.locator('#dictation-install').waitFor({ state: 'visible' });
  await page.locator('#dictation-install input').check();
  await page.locator('[data-install]').click();
  await page.waitForFunction(() => window.__out.includes('/scripts/install'));
  assert.equal(await access(path.join(fixture, 'installed')).then(() => true, () => false), false, 'Install must not execute');
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+u');
  await page.reload(); await page.waitForFunction(() => window.__state?.ready);
  await page.waitForTimeout(300); assert.equal(await page.locator('#dictation-install').isVisible(), false);
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__state?.ready && window.__state.prompt > 1);
  // Touch an editable cell, then type there. The running command proves real Readline movement.
  await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo Z12345');
  await page.waitForTimeout(250);
  const point = await page.evaluate(() => {
    const mark = window.__paint.filter(p => p.text === '3').at(-1); if (!mark) throw new Error('Missing terminal glyph');
    const canvas = document.querySelector('#terminal canvas'), rect = canvas.getBoundingClientRect();
    return { x: rect.left + mark.x / (canvas.width / rect.width) + 1, y: rect.top + mark.y / (canvas.height / rect.height) - 3 };
  });
  await page.touchscreen.tap(point.x, point.y); await page.keyboard.type('Q'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__out.includes('Z12Q345\r\n'));
  await writeFile(path.join(fixture, 'token'), 'secret'.repeat(8), { mode: 0o600 });
  // A token/binary and the legacy saved 'installed' flag do not prove API support.
  capabilities = false;
  await page.evaluate(base => localStorage.setItem('termai.voxtype:' + base + '/', 'installed'), base);
  await page.reload();
  await page.locator('#dictation-install').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#dictation-install h2').textContent(), 'Enable Voxtype dictation');
  assert.match(await page.locator('#dictation-install [data-explanation]').textContent(), /unavailable|updat/);
  assert.equal(await page.locator('#termai-dictation').isVisible(), false);
  await page.locator('[data-install]').click();
  await page.waitForFunction(() => window.__out.includes('/scripts/install'));
  assert.equal(await access(path.join(fixture, 'installed')).then(() => true, () => false), false, 'Update must not execute');
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+u'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__state?.ready);
  await page.reload(); await page.locator('#dictation-install').waitFor({ state: 'visible' });
  await page.locator('#dictation-install input').check(); await page.locator('[data-later]').click();
  await page.reload(); await page.waitForFunction(() => window.__state?.ready);
  await page.waitForTimeout(300); assert.equal(await page.locator('#dictation-install').isVisible(), false);
  capabilities = true;
  await page.reload(); await page.locator('#termai-dictation').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(base => localStorage.getItem('termai.voxtype:' + base + '/'), base), 'dismissed');
  // A healthy daemon suppresses the offer even without a stored preference.
  await page.evaluate(base => localStorage.removeItem('termai.voxtype:' + base + '/'), base);
  await page.reload(); await page.locator('#termai-dictation').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#dictation-install').isVisible(), false);
  const mic = page.locator('#termai-dictation'), micPosition = await mic.boundingBox();
  assert.equal(await mic.evaluate(el => getComputedStyle(el).borderRadius), '14px');
  assert.equal(await mic.locator('.dictation-microphone-icon').isVisible(), true);
  assert.equal(await mic.textContent(), '');
  const heldMic = await mic.boundingBox();
  await page.mouse.move(heldMic.x + heldMic.width / 2, heldMic.y + heldMic.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
  assert.deepEqual(await mic.boundingBox(), micPosition, 'Expanding controls must keep the button under the finger');
  assert.equal(await mic.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(112, 67, 154)');
  assert.equal(await mic.locator('.dictation-check').isVisible(), true);
  assert.equal(await page.locator('.dictation-activity line').count(), 11);
  assert.equal((await page.locator('.dictation-cancel').boundingBox()).width, 48);
  assert.equal((await page.locator('.dictation-activity').boundingBox()).width, 92);
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/tmp/termai-voxtype-web-recording.png' });
  const bytesBeforeLock = audioBytes;
  const cancelsBeforeLock = await page.evaluate(() => window.__sent.filter(m => m.type === 'dictation' && m.action === 'cancel').length);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    document.querySelector('#termai-dictation').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
  });
  await page.mouse.up();
  await page.waitForTimeout(500);
  assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'Lock must preserve held dictation after pointer cancellation');
  assert.equal(await page.locator('#connection-label').textContent(), 'Connected', 'Lock must keep the audio socket open');
  assert.ok(audioBytes > bytesBeforeLock, 'Audio must continue streaming while hidden');
  assert.equal(await page.evaluate(() => window.__sent.filter(m => m.type === 'dictation' && m.action === 'cancel').length), cancelsBeforeLock);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('#termai-dictation').click();
  await page.getByText('Transcribing…', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await mic.locator('.dictation-dots').isVisible(), true);
  assert.equal(await page.getByLabel('Cancel dictation', { exact: true }).isVisible(), true);
  await page.screenshot({ path: '/tmp/termai-voxtype-web-transcribing.png' });
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'done'));
  assert.ok(audioBytes > 0);
  assert.deepEqual(await page.evaluate(() => window.__captureConstraints.audio), { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true });
  assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'partial' || m.type === 'final')), false);
  assert.equal(await page.evaluate(() => window.__out.includes('never forward')), false);
  assert.equal(await page.evaluate(() => window.__state.ready), true, 'Dictation must not submit the command');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'git init');
  assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), ['git init', 'Get in it.']);
  assert.equal(await access(path.join(fixture, '.git')).then(() => true, () => false), false, 'Repair must not execute a command');
  assert.equal(await page.evaluate(() => window.__sent.some(m => m.type === 'replace' && m.text === 'Get in it.' || m.type === 'input' && m.data.includes('Get in it.'))), false, 'Transcript must not be sent back for duplicate insertion');
  await page.screenshot({ path: '/tmp/termai-voxtype-web-alternatives.png' });
  await page.locator('.alternative-choice').filter({ hasText: 'git init' }).click();
  await page.waitForFunction(() => window.__out.includes('Initialized empty Git repository'));
  assert.equal(await access(path.join(fixture, '.git')).then(() => true, () => false), true);
  // Dragging a provisional press cancels it; the controls expand on the other side near the left edge.
  const dragFrom = await mic.boundingBox();
  await page.mouse.move(dragFrom.x + 24, dragFrom.y + 24); await page.mouse.down();
  await page.mouse.move(36, dragFrom.y + 24, { steps: 5 }); await page.mouse.up();
  assert.equal(await mic.getAttribute('aria-pressed'), 'false');
  assert.equal((await mic.boundingBox()).x, 12);
  await mic.click();
  assert.equal(await page.locator('.dictation-panel').evaluate(el => el.classList.contains('panel-right')), true);
  await page.getByLabel('Cancel dictation', { exact: true }).click();
  // Cancellation must not insert anything; editing during a recording rejects its late final.
  await page.waitForFunction(() => window.__state.ready);
  await page.evaluate(() => { window.__messages = []; });
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
  await page.getByLabel('Cancel dictation', { exact: true }).click();
  assert.equal(await page.locator('#termai-dictation').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { window.__messages = []; });
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
  await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo preserved');
  await page.locator('#termai-dictation').click();
  await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'error' && m.message.includes('terminal changed')));
  assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'pasted')), false);
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+u');
  const repairRequests = [];
  page.on('request', request => { if (/\/api\/(suggest|facts)(?:\?|$)/.test(request.url())) repairRequests.push(request.url()); });
  async function startProgram(command, ready) {
    await page.evaluate(() => { window.__messages = []; window.__out = ''; window.__sent = []; window.__paint = []; });
    await page.locator('#terminal textarea').focus(); await page.keyboard.type(command); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__state?.inputTarget === 'program' && !window.__state.ready);
    await page.waitForFunction(ready);
  }
  async function record() {
    await page.evaluate(() => { window.__messages = []; });
    await mic.click();
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await mic.click();
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'done'));
    assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
    assert.equal(await page.locator('#alternatives-menu').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__sent.some(m => m.type === 'replace' || m.type === 'command')), false);
    assert.equal(repairRequests.length, 0, 'Program dictation must not request shell repairs');
  }
  async function nativeDictation(text, inputType = 'insertFromDictation') {
    await page.locator('#terminal textarea').evaluate((el, { text, inputType }) => {
      const event = new InputEvent('beforeinput', { data: text, inputType, bubbles: true, cancelable: true });
      // Chromium does not expose the mobile-only insertFromDictation input type.
      if (event.inputType !== inputType) Object.defineProperty(event, 'inputType', { value: inputType });
      el.dispatchEvent(event);
    }, { text, inputType });
  }
  async function quitProgram() {
    const before = await page.evaluate(() => window.__state.prompt);
    await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+c');
    await page.waitForFunction(before => window.__state?.ready && window.__state.prompt > before, before);
    assert.equal(await page.evaluate(() => window.__state.inputTarget), 'shell');
  }
  for (const mode of ['plain', 'bracketed']) {
    await rm(path.join(fixture, 'program-input'), { force: true });
    await startProgram(`node program.mjs ${mode}`, () => window.__out.includes('PROGRAM_READY'));
    await record();
    const wrap = text => mode === 'bracketed' ? '\x1b[200~' + text + '\x1b[201~' : text;
    assert.equal(await readFile(path.join(fixture, 'program-input'), 'utf8'), wrap('Get in it.'));
    await nativeDictation('Native words.', mode === 'plain' ? 'insertText' : 'insertFromDictation');
    await page.waitForFunction(() => window.__sent.some(m => m.type === 'input' && m.data.includes('Native words.')));
    assert.equal(await readFile(path.join(fixture, 'program-input'), 'utf8'), wrap('Get in it.') + wrap('Native words.'));
    assert.equal(repairRequests.length, 0);
    if (mode === 'plain') {
      // Leaving the program while transcription is pending must not paste into Bash.
      await page.evaluate(() => { window.__messages = []; });
      await mic.click(); await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
      await mic.click(); await quitProgram();
      await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'error' && m.message.includes('terminal changed')));
      assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'pasted')), false);
    } else await quitProgram();
  }
  if (process.env.TEST_CODEX) {
    for (const flags of ['', '--no-alt-screen']) {
      await startProgram('codex ' + flags, () => window.__out.includes('OpenAI Codex') && window.__out.includes('fixture'));
      await record();
      await page.waitForFunction(() => window.__paint.map(p => p.text).join('').includes('Get in it.'));
      await nativeDictation('Native words.', 'insertReplacementText');
      await page.waitForFunction(() => window.__paint.map(p => p.text).join('').includes('Native words.'));
      await page.locator('#terminal textarea').evaluate(el => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new CompositionEvent('compositionend', { data: 'Composition words.', bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => window.__paint.map(p => p.text).join('').includes('Composition words.'));
      assert.equal(await page.locator('#alternatives-toggle').isVisible(), false);
      assert.equal(repairRequests.length, 0);
      assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'error')), false);
      await quitProgram();
    }
  }
  // The next Bash prompt restores command alternatives.
  await page.evaluate(() => { window.__sent = []; });
  await nativeDictation('Get in it.');
  await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'git init');
  assert.ok(repairRequests.length > 0);
  assert.deepEqual(errors, []);
  console.log('PASS: daemon discovery, microphone Opus, shell alternatives, literal program dictation, paste modes, stale transcripts' + (process.env.TEST_CODEX ? ', Codex CLI with and without alternate screen' : ''));
} catch (error) { console.error(logs); if (browser) console.error(await browser.contexts()[0]?.pages()[0]?.evaluate(() => ({ messages: window.__messages, out: window.__out, paint: window.__paint?.slice(-40) }))); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); for (const socket of daemon.clients) socket.terminate(); await new Promise(resolve => daemon.close(resolve)); await rm(fixture, { recursive: true, force: true }); }
