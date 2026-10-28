import { launchBrowser, freePort, until, waitForShell, focusShell, submitShellCommand } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { resumableVoxtype } from './support/voxtype-daemon.mjs';
import { getPacketInfo } from 'libopus-wasm';
const scenario = new URL(import.meta.url).searchParams.get('scenario');
assert.ok(['availability', 'capture', 'program'].includes(scenario), 'Unknown dictation scenario');
const fixturePort3176 = await freePort();
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'libertty-dictation-browser-'));
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
if (scenario !== 'availability') await writeFile(path.join(fixture, 'token'), 'secret'.repeat(8), { mode: 0o600 });
const daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(daemon, 'listening');
let audioBytes = 0, capabilities = true, recordingSocket;
async function waitForAudioAfter(previous) {
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    if (audioBytes > previous) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Audio transport did not deliver another frame within five seconds');
}
const voice = resumableVoxtype(daemon, {
  token: 'secret'.repeat(8), available: () => capabilities,
  onAudio: bytes => audioBytes += bytes, onRecording: socket => recordingSocket = socket,
  checkPacket: async packet => { const info = await getPacketInfo(packet, { sampleRate: 16000 }); assert.equal(info.channels, 1); assert.equal(info.durationMs, 20); },
});
const port = Number(process.env.TEST_PORT || fixturePort3176), base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root,'target/debug/libertty'), [], { cwd: root, env: { ...process.env, HOME: fixture, XDG_DATA_HOME: path.join(fixture, 'data'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), LIBERTTY_TOKEN: 'feature-test-pairing-token-123456789', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: fixture, LIBERTTY_HISTORY_FILE: path.join(fixture, 'history'), LIBERTTY_VOXTYPE_SOURCE: path.join(fixture, 'source'), LIBERTTY_VOXTYPE_TOKEN_FILE: path.join(fixture, 'token'), LIBERTTY_VOXTYPE_URL: `ws://127.0.0.1:${daemon.address().port}/v1/dictate` }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
let browser;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base).then(r => r.ok, () => false)) break; if (server.exitCode !== null) throw new Error(logs); await new Promise(r => setTimeout(r, 100)); }
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 600, height: 850 }, colorScheme: 'light', hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  if (scenario === 'capture') await page.clock.install();
  await page.route(/\/assets\/terminal-[A-Za-z0-9_-]{8}\.js$/, async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__testTerminal=new $1({ghostty:');
    assert.notEqual(body, original); await route.fulfill({ response, body });
  });
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await installWireObserver(page.context());
  await page.context().addInitScript(() => {
    window.__wakeLocks = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request(type) {
      if (window.__denyWakeLock) throw new DOMException('Denied', 'NotAllowedError');
      const lock = new EventTarget(); lock.released = false;
      lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
      window.__wakeLocks.push(lock); return lock;
    } } });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (window.__denyMicrophone) throw new DOMException('Microphone denied', 'NotAllowedError');
      if (window.__holdPermission) { window.__permissionWaiting = true; await new Promise(resolve => window.__releasePermission = resolve); window.__permissionWaiting = false; }
      window.__captureConstraints = constraints; const stream = await capture(constraints); window.__captureStream = stream;
      if (window.__suspendDuringPermission) { window.__suspendDuringPermission = false; await window.__captureContext.suspend(); }
      return stream;
    };
    const Audio = window.AudioContext;
    window.AudioContext = class extends Audio {
      constructor(...args) { super(...args); window.__captureContext = this; }
      createMediaStreamSource(stream) {
        const source = super.createMediaStreamSource(stream), connect = source.connect.bind(source);
        source.connect = (...args) => {
          if (window.__stallCapture) { if (window.__stallCapture === 'once') window.__stallCapture = false; return args[0]; }
          return connect(...args);
        };
        return source;
      }
    };
    const Worklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Worklet { constructor(...args) { super(...args); window.__captureProcessor = this; } };
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
  await waitForShell(page);
  const mic = page.locator('#libertty-dictation');
  const terminalInput = page.locator('#terminal textarea');
  const keyboardOpen = () => terminalInput.evaluate(element => element === document.activeElement && !element.readOnly);
  if (scenario === 'availability') {
    await page.locator('#dictation-install').waitFor({ state: 'visible' });
    await page.locator('#dictation-install input').check();
    let installStatusReads = 0;
    const installStatus = request => { if (new URL(request.url()).pathname.endsWith('/api/dictation')) installStatusReads++; };
    page.on('request', installStatus);
    await page.locator('[data-install]').click();
    await page.locator('#dictation-install').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__out.includes('/scripts/install'));
    assert.equal(await access(path.join(fixture, 'installed')).then(() => true, () => false), false, 'Install must not execute');
    let prompt = await page.evaluate(() => window.__state.prompt);
    await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+e'); await page.keyboard.press('Control+u'); await page.keyboard.press('Enter');
    await waitForShell(page, { afterPrompt: prompt });
    await until(() => installStatusReads > 0, 'Availability refresh after the install prompt');
    page.off('request', installStatus);
    await page.reload(); await waitForShell(page);
    await page.waitForTimeout(300); assert.equal(await page.locator('#dictation-install').isVisible(), false);
    prompt = await page.evaluate(() => window.__state.prompt);
    await page.locator('#terminal textarea').focus(); await page.keyboard.press('Enter');
    await waitForShell(page, { afterPrompt: prompt });
    // Touch an editable cell, then type there.
    // The running command proves real Readline movement.
    await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo Z12345');
    await page.waitForFunction(() => {
      const term = window.__testTerminal, buffer = term?.buffer.active;
      return buffer?.getLine(Math.max(0, buffer.length - term.rows) + buffer.cursorY)?.translateToString(true).endsWith('345');
    });
    const point = await page.evaluate(() => {
      const term = window.__testTerminal, buffer = term.buffer.active;
      const position = buffer.cursorY * term.cols + buffer.cursorX - 3;
      const rect = document.querySelector('#terminal canvas').getBoundingClientRect();
      return { position, x: rect.left + (position % term.cols + .25) * rect.width / term.cols, y: rect.top + (Math.floor(position / term.cols) + .5) * rect.height / term.rows };
    });
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForFunction(position => { const term = window.__testTerminal, buffer = term.buffer.active; return buffer.cursorY * term.cols + buffer.cursorX === position; }, point.position);
    await page.keyboard.type('Q'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__out.includes('Z12Q345\r\n'));
    await writeFile(path.join(fixture, 'token'), 'secret'.repeat(8), { mode: 0o600 });
    // A token or binary does not prove API support.
    capabilities = false;
    await page.evaluate(base => localStorage.removeItem('libertty.voxtype:' + base + '/'), base);
    await page.reload();
    await page.locator('#dictation-install').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#dictation-install h2').textContent(), 'Enable Voxtype dictation');
    assert.match(await page.locator('#dictation-install [data-explanation]').textContent(), /unavailable|updat/);
    assert.equal(await page.locator('#libertty-dictation').isVisible(), false);
    await page.locator('[data-install]').click();
    await page.locator('#dictation-install').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__out.includes('/scripts/install'));
    assert.equal(await access(path.join(fixture, 'installed')).then(() => true, () => false), false, 'Update must not execute');
    prompt = await page.evaluate(() => window.__state.prompt);
    await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+e'); await page.keyboard.press('Control+u'); await page.keyboard.press('Enter');
    await waitForShell(page, { afterPrompt: prompt });
    await page.reload(); await page.locator('#dictation-install').waitFor({ state: 'visible' });
    await page.locator('#dictation-install input').check(); await page.locator('[data-later]').click();
    await page.reload(); await waitForShell(page);
    await page.waitForTimeout(300); assert.equal(await page.locator('#dictation-install').isVisible(), false);
    capabilities = true;
    await submitShellCommand(page, 'node ' + path.join(fixture, 'program.mjs'));
    await page.waitForFunction(() => window.__state?.inputTarget === 'program');
    for (const outage of ['request', 'daemon']) {
      let statusReads = 0;
      capabilities = outage !== 'daemon';
      await page.route('**/api/dictation', async route => {
        statusReads++;
        if (outage === 'request' && statusReads <= 3) await route.fulfill({ status: 503, json: { error: 'Temporary outage' } });
        else await route.continue();
      });
      const initialStatus = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/dictation') && (outage !== 'request' || statusReads === 3));
      await page.reload(); await page.waitForFunction(() => window.__state?.inputTarget === 'program');
      const status = await initialStatus;
      if (outage === 'request') assert.equal(status.status(), 503);
      else assert.equal((await status.json()).available, false);
      await status.finished();
      assert.equal(await page.locator('#libertty-dictation').isVisible(), false);
      capabilities = true;
      await page.locator('#libertty-dictation').waitFor({ state: 'visible' });
      assert.ok(statusReads >= (outage === 'request' ? 4 : 2), 'Dictation recovers from a temporary ' + outage + ' outage without a reload or shell prompt');
      console.log('PASS dictation availability recovery after a temporary ' + outage + ' outage');
      await page.unroute('**/api/dictation');
    }
    await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+c');
    await waitForShell(page);
    await page.reload(); await page.locator('#libertty-dictation').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(base => localStorage.getItem('libertty.voxtype:' + base + '/'), base), 'dismissed');
    // A healthy daemon suppresses the offer even without a stored preference.
    await page.evaluate(base => localStorage.removeItem('libertty.voxtype:' + base + '/'), base);
    await page.reload(); await page.locator('#libertty-dictation').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#dictation-install').isVisible(), false);
  }
  if (scenario === 'capture') {
    await mic.waitFor({ state: 'visible' });
    const micPosition = await mic.boundingBox();
    let idleStatusReads = 0;
    const statusRead = request => { if (new URL(request.url()).pathname.endsWith('/api/dictation')) idleStatusReads++; };
    page.on('request', statusRead); await page.clock.runFor(16000); page.off('request', statusRead);
    assert.equal(idleStatusReads, 0, 'An idle terminal does not poll dictation availability');
    assert.equal(await mic.evaluate(el => getComputedStyle(el).borderRadius), '14px');
    assert.equal(await mic.locator('.dictation-microphone-icon').isVisible(), true);
    assert.equal(await mic.textContent(), '');
    const heldMic = await mic.boundingBox();
    await page.evaluate(() => { window.__suspendDuringPermission = true; });
    await page.mouse.move(heldMic.x + heldMic.width / 2, heldMic.y + heldMic.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await waitForAudioAfter(0);
    const resumedId = voice.currentId, resumedBefore = voice.resumptions;
    const bytesBeforeDrop = audioBytes;
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
    await page.waitForTimeout(1400);
    assert.equal(await page.evaluate(() => window.__captureStream.getAudioTracks()[0].readyState), 'live', 'A dropped terminal connection keeps recording');
    assert.equal(await mic.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
    for (let i = 0; voice.resumptions === resumedBefore && i < 100; i++) await page.waitForTimeout(30);
    assert.ok(voice.resumptions > resumedBefore, 'The daemon resumes its retained logical recording');
    assert.equal(voice.currentId, resumedId);
    await waitForAudioAfter(bytesBeforeDrop);
    assert.equal(await page.evaluate(() => window.__captureContext.state), 'running', 'Startup resumes audio after a permission/device interruption');
    assert.equal(await page.evaluate(() => window.__wakeLocks.at(-1)?.released), false, 'Recording holds a screen wake lock');
    assert.deepEqual(await mic.boundingBox(), micPosition, 'Expanding controls must keep the button under the finger');
    assert.equal(await mic.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(220, 232, 218)');
    assert.equal(await mic.evaluate(el => getComputedStyle(el).color), 'rgb(30, 95, 45)');
    assert.equal(await mic.locator('.dictation-check').isVisible(), true);
    assert.equal(await page.locator('.dictation-activity line').count(), 11);
    assert.equal((await page.locator('.dictation-cancel').boundingBox()).width, 48);
    assert.equal((await page.locator('.dictation-activity').boundingBox()).width, 92);
    await page.waitForTimeout(350);
    await page.screenshot({ path: '/tmp/libertty-voxtype-web-recording.png' });
    const bytesBeforeLock = audioBytes;
    const cancelsBeforeLock = await page.evaluate(() => window.__sent.filter(m => m.type === 'dictation' && m.action === 'cancel').length);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      void window.__wakeLocks.at(-1).release();
      document.querySelector('#libertty-dictation').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
    });
    await page.mouse.up();
    await waitForAudioAfter(bytesBeforeLock);
    assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'Lock must preserve held dictation after pointer cancellation');
    assert.equal(await page.locator('#connection-label').textContent(), 'Connected', 'Lock must keep the audio socket open');
    assert.ok(audioBytes > bytesBeforeLock, 'Audio must continue streaming while hidden');
    assert.equal(await page.evaluate(() => window.__sent.filter(m => m.type === 'dictation' && m.action === 'cancel').length), cancelsBeforeLock);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.__wakeLocks.length === 2 && !window.__wakeLocks.at(-1).released);
    await page.locator('#libertty-dictation').click();
    await page.getByText('Transcribing…', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('#alternatives-toggle.loading .spinner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#alternatives-menu').isVisible(), false, 'Transcription waits at the entry without opening a partial menu');
    assert.equal(await page.locator('.dictation-presentation').isVisible(), true, 'The entry holds its previous paint while the transcript and alternatives load');
    await page.evaluate(() => {
      window.__dictationPaints = [];
      const sample = () => {
        const toggle = document.querySelector('#alternatives-toggle'), menu = document.querySelector('#alternatives-menu');
        const busy = toggle.classList.contains('loading'), bounds = toggle.getBoundingClientRect();
        window.__dictationPaints.push({ busy, menu: !menu.hidden, x: bounds.x, y: bounds.y });
        if (busy) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    assert.equal(await page.evaluate(() => window.__wakeLocks.every(lock => lock.released)), true, 'Finish releases wake locks before transcription');
    assert.equal(await mic.locator('.dictation-dots').isVisible(), true);
    assert.equal(await page.getByLabel('Cancel dictation', { exact: true }).isVisible(), true);
    await page.screenshot({ path: '/tmp/libertty-voxtype-web-transcribing.png' });
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'done'));
    assert.ok(audioBytes > 0);
    assert.deepEqual(await page.evaluate(() => window.__captureConstraints.audio), { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true });
    assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'partial' || m.type === 'final')), false);
    assert.equal(await page.evaluate(() => window.__out.includes('never forward')), false);
    assert.equal(await page.evaluate(() => window.__state.ready), true, 'Dictation must not submit the command');
    await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'git init');
    assert.deepEqual(await page.locator('.alternative-choice .choice-command').allTextContents(), ['git init', 'Get in it.']);
    await page.locator('.dictation-presentation').waitFor({ state: 'hidden' });
    const pendingPaints = (await page.evaluate(() => window.__dictationPaints)).filter(paint => paint.busy);
    assert.ok(pendingPaints.length > 1, 'Observe multiple loading paints');
    assert.ok(pendingPaints.every(paint => !paint.menu), 'The menu only appears with the completed alternatives');
    assert.equal(new Set(pendingPaints.map(paint => paint.x + ',' + paint.y)).size, 1, 'The spinner stays at the insertion point as the backend edits the line');
    assert.equal(await access(path.join(fixture, '.git')).then(() => true, () => false), false, 'Repair must not execute a command');
    assert.equal(await page.evaluate(() => window.__sent.some(m => m.type === 'replace' && m.text === 'Get in it.' || m.type === 'input' && m.data.includes('Get in it.'))), false, 'Transcript must not be sent back for duplicate insertion');
    assert.equal(await page.evaluate(() => window.__sent.some(message => ['repair', 'replace'].includes(message.type))), false, 'Backend dictation must repair and apply without a browser relay');
    assert.ok(await page.evaluate(() => window.__messages.some(message => message.type === 'repair-result' && message.source === 'dictation' && message.accepted)));
    await page.screenshot({ path: '/tmp/libertty-voxtype-web-alternatives.png' });
    assert.equal(await keyboardOpen(), false, 'Microphone alternatives leave the keyboard closed');
    await page.locator('.alternative-choice').filter({ hasText: 'git init' }).tap();
    await page.waitForFunction(() => window.__out.includes('Initialized empty Git repository'));
    assert.equal(await keyboardOpen(), false, 'Sending an alternate must leave the keyboard closed');
    assert.equal(await access(path.join(fixture, '.git')).then(() => true, () => false), true);
    const beforePermission = voice.currentId;
    await page.evaluate(() => { window.__holdPermission = true; window.__messages = []; });
    await mic.press('Enter'); await page.waitForFunction(() => window.__permissionWaiting);
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
    await waitForShell(page);
    assert.equal(voice.currentId, beforePermission, 'Reconnect waits for microphone startup before admitting a recording');
    await page.evaluate(() => { window.__holdPermission = false; window.__releasePermission(); });
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await page.getByLabel('Cancel dictation', { exact: true }).click();
    // Dragging a provisional press cancels it; the controls expand on the other side near the left edge.
    const dragFrom = await mic.boundingBox();
    await page.mouse.move(dragFrom.x + 24, dragFrom.y + 24); await page.mouse.down();
    await page.mouse.move(36, dragFrom.y + 24, { steps: 5 }); await page.mouse.up();
    assert.equal(await mic.getAttribute('aria-pressed'), 'false');
    assert.equal((await mic.boundingBox()).x, 12);
    // Keyboard activation makes lifecycle starts independent of pointer hold duration.
    await mic.press('Enter');
    assert.equal(await page.locator('.dictation-panel').evaluate(el => el.classList.contains('panel-right')), true);
    await page.getByLabel('Cancel dictation', { exact: true }).click();
    // Cancellation must not insert anything; editing during a recording rejects its late final.
    await waitForShell(page);
    await page.evaluate(() => { window.__messages = []; });
    await mic.press('Enter');
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await page.getByLabel('Cancel dictation', { exact: true }).click();
    assert.equal(await page.locator('#libertty-dictation').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.__wakeLocks.every(lock => lock.released)), true, 'Cancellation releases wake locks');
    for (const stall of ['once', 'always']) {
      const previous = audioBytes;
      await page.evaluate(stall => { window.__stallCapture = stall; window.__messages = []; }, stall);
      await mic.press('Enter');
      await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
      if (stall === 'once') {
        await waitForAudioAfter(previous);
        await page.getByLabel('Microphone activity', { exact: true }).waitFor();
        assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'A stalled capture is recovered without another tap');
        await page.getByLabel('Cancel dictation', { exact: true }).click();
      } else {
        await page.waitForFunction(() => document.querySelector('#libertty-dictation').getAttribute('aria-pressed') === 'false');
        assert.match(await page.locator('#notice-bubble').textContent(), /Microphone audio did not start or resume/);
        assert.equal(audioBytes, previous, 'A permanently stalled microphone never pretends to send audio');
      }
      await page.evaluate(() => { window.__stallCapture = false; });
      assert.equal(await page.evaluate(() => window.__captureStream.getTracks().every(track => track.readyState === 'ended')), true, 'Stalled/recovered capture releases its microphone');
    }
    await page.evaluate(() => { window.__messages = []; });
    await mic.press('Enter');
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await page.waitForFunction(() => window.__captureProcessor?.context === window.__captureContext);
    await page.evaluate(() => window.__captureProcessor.dispatchEvent(new Event('processorerror')));
    await page.waitForFunction(() => document.querySelector('#libertty-dictation').getAttribute('aria-pressed') === 'false');
    assert.match(await page.locator('#notice-bubble').textContent(), /audio processing stopped/);
    for (const interruption of ['suspend', 'ended', 'pagehide', 'denied', 'permission', 'disconnect']) {
      await page.evaluate(kind => { window.__messages = []; window.__denyWakeLock = kind === 'denied'; window.__denyMicrophone = kind === 'permission'; }, interruption);
      await mic.press('Enter');
      if (interruption === 'permission') {
        await page.waitForFunction(() => document.querySelector('#libertty-dictation').getAttribute('aria-pressed') === 'false');
      } else {
        await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
        if (interruption === 'suspend') {
          const previous = audioBytes;
          await page.evaluate(() => window.__captureContext.suspend());
          await waitForAudioAfter(previous);
          assert.equal(await page.evaluate(() => window.__captureContext.state), 'running', 'A suspended capture resumes automatically');
          await page.getByLabel('Microphone activity', { exact: true }).waitFor();
          await page.getByLabel('Cancel dictation', { exact: true }).click();
        } else if (interruption === 'ended') {
          await page.evaluate(() => window.__captureStream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
          await page.waitForFunction(() => document.querySelector('#libertty-dictation').getAttribute('aria-pressed') === 'false');
        } else if (interruption === 'pagehide') {
          await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
          await page.waitForFunction(() => document.querySelector('#libertty-dictation').getAttribute('aria-pressed') === 'false');
        } else if (interruption === 'disconnect') {
          recordingSocket.close();
          await page.getByText('Tap to retry', { exact: true }).waitFor();
          assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'A daemon transport error retains encoded speech');
          await page.getByLabel('Cancel dictation', { exact: true }).click();
        } else await page.getByLabel('Cancel dictation', { exact: true }).click();
      }
      await page.waitForFunction(() => window.__wakeLocks.every(lock => lock.released));
      await page.evaluate(() => { window.__denyWakeLock = window.__denyMicrophone = false; });
    }
    await page.evaluate(() => { window.__messages = []; });
    await mic.press('Enter');
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await focusShell(page); await page.keyboard.type('echo preserved');
    await page.locator('#libertty-dictation').click();
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'error' && m.message.includes('terminal changed')));
    assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'pasted')), false);
    await page.getByText('Tap to retry', { exact: true }).waitFor(); await page.getByLabel('Cancel dictation', { exact: true }).click();
  }
  if (scenario === 'program') {
    await mic.waitFor({ state: 'visible' });
    await submitShellCommand(page, 'git init -q');
    await waitForShell(page);
    const repairRequests = [];
    page.on('request', request => { if (/\/api\/(suggest|facts)(?:\?|$)/.test(request.url())) repairRequests.push(request.url()); });
    async function startProgram(command, ready) {
      await focusShell(page);
      await page.keyboard.press('Control+u');
      await page.evaluate(() => { window.__messages = []; window.__out = ''; window.__sent = []; window.__paint = []; });
      await submitShellCommand(page, command);
      await page.waitForFunction(() => window.__state?.inputTarget === 'program' && !window.__state.ready);
      await page.waitForFunction(ready);
    }
    async function record() {
      await page.evaluate(() => { window.__messages = []; });
      await mic.press('Enter');
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
    async function quitProgram(interrupts = 1) {
      const before = await page.evaluate(() => window.__testShellState.prompt);
      await page.evaluate(() => window.__testTerminal.focus());
      for (let i = 0; i < interrupts; i++) await page.keyboard.press('Control+c');
      const state = await waitForShell(page, { afterPrompt: before });
      assert.equal(state.inputTarget, 'shell');
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
        await mic.press('Enter'); await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
        await mic.click(); await quitProgram();
        await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'error' && m.message.includes('terminal changed')));
        assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'pasted')), false);
        await page.getByText('Tap to retry', { exact: true }).waitFor(); await page.getByLabel('Cancel dictation', { exact: true }).click();
      } else await quitProgram();
    }
    for (const dropout of ['upload', 'final']) {
      await rm(path.join(fixture, 'program-input'), { force: true });
      await startProgram('node program.mjs plain', () => window.__out.includes('PROGRAM_READY'));
      await mic.press('Enter');
      await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
      await page.waitForTimeout(250);
      const id = voice.currentId, previousFinishes = voice.finishes;
      if (dropout === 'upload') await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
      await mic.click();
      if (dropout === 'final') {
        await until(() => voice.finishes > previousFinishes, 'daemon finish acceptance');
        await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
      }
      await page.waitForTimeout(1100);
      const bytes = voice.audioBytes;
      assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'Finishing offline retains the recording');
      await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
      await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'done'));
      await until(async () => (await readFile(path.join(fixture, 'program-input'), 'utf8').catch(() => '')) === 'Get in it.', 'one resumed transcript');
      assert.equal(voice.currentId, id);
      assert.equal(await page.evaluate(() => window.__messages.filter(m => m.type === 'pasted').length), 1);
      if (dropout === 'final') assert.equal(voice.audioBytes, bytes, 'A cached final needs no audio replay');
      await quitProgram();
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
        await quitProgram(2);
      }
    }
    // The next Bash prompt restores command alternatives.
    await page.evaluate(() => { window.__sent = []; });
    await nativeDictation('Get in it.');
    await page.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'git init');
    assert.equal(repairRequests.length, 0, 'Native dictation uses one repair transaction on the terminal connection');
    assert.ok(await page.evaluate(() => window.__sent.some(message => message.type === 'repair')));
    await page.locator('#menu-button').click(); await page.locator('#tap-alternate-send').uncheck();
    await page.getByRole('button', { name: 'Close session options' }).click();
    for (const focused of [false, true]) {
      for (const [selector, text] of [['.literal-choice', 'Get in it.'], ['.alternative-choice:not(.literal-choice)', 'git init']]) {
        await page.locator('#alternatives-toggle').tap();
        if (focused) await page.evaluate(() => window.__testTerminal.focus()); else await terminalInput.evaluate(element => element.blur());
        assert.equal(await keyboardOpen(), focused, 'Set the keyboard state before choosing an alternate');
        const before = await page.evaluate(() => window.__messages.length);
        await page.locator(selector).tap();
        await page.waitForFunction(before => window.__messages.slice(before).some(message => message.type === 'edit-result' && message.accepted), before);
        assert.equal(await page.evaluate(() => window.__sent.filter(message => message.type === 'replace').at(-1).text), text);
        assert.equal(await keyboardOpen(), focused, 'Inserting an alternate preserves the current keyboard state');
      }
    }
    const outer = await page.context().newPage(); outer.setDefaultTimeout(15000); await outer.goto(base);
    if (await outer.locator('#backend-login').isVisible()) { await outer.locator('#backend-token').fill('feature-test-pairing-token-123456789'); await outer.locator('#backend-login-form button[type=submit]').click(); }
    await outer.locator('#terminal-stack > iframe').waitFor();
    const embedded = await (await outer.locator('#terminal-stack > iframe').elementHandle()).contentFrame();
    const embeddedMic = embedded.locator('#libertty-dictation'); await embeddedMic.waitFor({ state: 'visible' });
    const bytesBeforeEmbedded = audioBytes;
    await embeddedMic.press('Enter'); await embedded.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await waitForAudioAfter(bytesBeforeEmbedded);
    assert.equal(await outer.evaluate(() => window.__wakeLocks.at(-1)?.released), false, 'Ordinary embedded terminal requests from outer document');
    const bytesBeforeBackground = audioBytes;
    await outer.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); void window.__wakeLocks.at(-1).release(); });
    await embedded.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await waitForAudioAfter(bytesBeforeBackground); assert.equal(await embeddedMic.getAttribute('aria-pressed'), 'true'); assert.ok(audioBytes > bytesBeforeBackground);
    await outer.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await embedded.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await outer.waitForFunction(() => window.__wakeLocks.length === 2 && !window.__wakeLocks.at(-1).released);
    await outer.locator('#terminal-back').click();
    await embedded.waitForFunction(() => document.querySelector('#libertty-dictation').getAttribute('aria-pressed') === 'false');
    await outer.waitForFunction(() => window.__wakeLocks.every(lock => lock.released));
    await outer.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS dictation ' + scenario + ' scenario' + (process.env.TEST_CODEX ? ' with Codex CLI' : ''));
} catch (error) { console.error(logs); if (browser) console.error(await browser.contexts()[0]?.pages()[0]?.evaluate(() => ({ messages: window.__messages, out: window.__out, paint: window.__paint?.slice(-40) }))); throw error; }
finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  for (const socket of daemon.clients) socket.terminate();
  await new Promise(resolve => daemon.close(resolve));
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
