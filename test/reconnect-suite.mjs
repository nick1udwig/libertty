import { launchBrowser, freePort, startBackend, delay, until, focusShell } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { herdrFixture } from './herdr-fixture.ts';
import { installBackgroundGrace } from './support/background-grace.mjs';

const scenario = new URL(import.meta.url).searchParams.get('scenario');
assert.ok(['native', 'herdr'].includes(scenario), 'Unknown reconnect scenario');
const fixturePort3178 = await freePort();

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname;
const origin = 'http://127.0.0.1:' + (process.env.TEST_PORT || String(fixturePort3178)), base = origin + '/reconnect-test/';
const token = 'reconnect-test-pairing-token';
const server = startBackend({ cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: new URL(origin).port,
  LIBERTTY_BASE_PATH: '/reconnect-test', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_TOKEN: token,
  LIBERTTY_DATA_DIR: fixture.directory + '/libertty', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: fixture.directory,
  HOME: fixture.directory, PATH: fixture.directory + ':' + process.env.PATH, HERDR_SOCKET_PATH: fixture.socketPath,
} });
const exited = once(server, 'exit');
let logs = '', browser;
server.stdout.on('data', data => logs += data); server.stderr.on('data', data => logs += data);
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await installWireObserver(context);
  await installBackgroundGrace(context);
  await context.addInitScript(() => {
    window.__sockets = []; window.__states = 0; window.__sent = []; window.__lateCloses = []; window.__output = '';
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) {
        if (window.__holdNextSocket) window.__preUpgradeOldState = window.__blackhole?.readyState;
        super(...args); window.__sockets.push(this);
        if (window.__holdNextSocket) { window.__holdNextSocket = false; window.__heldSocket = this; this.__held = []; }
        this.addEventListener('message', async event => {
          const message = await window.__wireMessage(event.data, this);
          if (message.type === 'state') window.__states++;
          if (message.type === 'output') window.__output += message.data;
        });
      }
      set onmessage(handler) {
        this.addEventListener('message', event => { if (this !== window.__blackhole) { if (this.__held) this.__held.push(() => handler(event)); else handler(event); } });
      }
      set onopen(handler) { this.addEventListener('open', event => { if (this.__held) this.__held.unshift(() => handler(event)); else handler(event); }); }
      set onclose(handler) {
        this.addEventListener('close', event => {
          if (window.__holdCloses) window.__lateCloses.push(() => handler(event)); else handler(event);
        });
      }
      send(data) {
        if (window.__wireSent(data).type !== 'audio') window.__sent.push(window.__wireSent(data));
        // A muted socket models an uplink that accepts messages and never delivers them.
        if (this !== window.__muted) return super.send(data);
      }
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(base + 'terminal.html');
  await page.locator('#token').fill(token); await page.locator('#login-form button').click();
  const focusInput = async () => {
    if (!new URL(page.url()).searchParams.has('herdrTerminal')) return focusShell(page);
    await page.locator('#terminal canvas').tap({ position: { x: 10, y: 10 } });
    await page.waitForFunction(() => {
      const input = document.querySelector('#terminal textarea');
      return document.activeElement === input && !input.readOnly;
    });
  };
  const connected = async (states, timeout = 12000) => {
    await page.waitForFunction(states => window.__states > states && document.querySelector('#connection-label').textContent === 'Connected', states, { timeout });
    assert.equal(await page.locator('#notice-orb').getAttribute('data-states'), '', 'A connected terminal shows no connection state');
  };
  await connected(0);
  const connectRequests = []; let connectionPhase = 'typing';
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/api/connect')) connectRequests.push({ url: request.url(), phase: connectionPhase }); });
  const stateCount = () => page.evaluate(() => window.__states);
  const foreground = async () => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const background = async () => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const online = async () => page.evaluate(() => window.dispatchEvent(new Event('online')));

  async function silentStall() {
    const states = await stateCount();
    const held = await stallNext(page.url().includes('herdrTerminal') ? '/api/herdr/ticket' : '/ws');
    await page.evaluate(() => { window.__blackhole = window.__sockets.at(-1); });
    await page.waitForFunction(() => document.querySelector('#connection-label').textContent.startsWith('Connection stalled'), undefined, { polling: 50, timeout: 8000 });
    await held.entered;
    assert.equal(await page.evaluate(() => location.search.includes('herdrTerminal') ? window.__blackhole.readyState : window.__preUpgradeOldState), 1, 'Keep the old connection until the replacement handshake starts');
    await held.done();
    await connected(states);
    await page.waitForFunction(() => window.__blackhole.readyState === 3);
    assert.equal(await page.evaluate(() => window.__blackhole.readyState), 3, 'the replacement releases its predecessor');
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
  }
  async function foregroundHandoff() {
    const states = await stateCount();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await background(); await foreground();
    await connected(states, 4000);
    await page.waitForFunction(() => document.querySelector('#terminal-viewport').getAttribute('aria-busy') === 'false');
  }
  async function stalledTyping(link, text) {
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    await focusInput();
    const states = await stateCount();
    await page.evaluate(link => { window.__dead = window[link === 'uplink' ? '__muted' : '__blackhole'] = window.__sockets.at(-1); }, link);
    await page.keyboard.type(text);
    // The heartbeat notices the dead link and replaces its socket.
    await page.waitForFunction(() => window.__dead.readyState === WebSocket.CLOSED, undefined, { polling: 50, timeout: 15000 });
    await connected(states);
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
  }
  async function queuedTyping(text, changeContext) {
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    await focusInput();
    await page.evaluate(() => {
      window.__sent = [];
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    await page.keyboard.type(text);
    const inputs = () => page.evaluate(() => window.__sent.filter(message => message.type === 'input' && !['\x1b[I', '\x1b[O'].includes(message.data)).map(message => message.data).join(''));
    assert.equal(await inputs(), '', 'Disconnected keys have never been sent');
    await changeContext?.();
    const states = await stateCount();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await connected(states); await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    if (changeContext) {
      await page.waitForFunction(() => document.querySelector('#notice-bubble').textContent.includes('changed prompt'));
      assert.equal(await inputs(), '', 'Changed prompts or processes cannot receive queued keys');
    } else {
      await page.waitForFunction(text => window.__sent.filter(message => message.type === 'input').map(message => message.data).join('').includes(text), text);
      assert.equal(await inputs(), text, 'Queued keys are sent exactly once after replay paints');
    }
  }
  async function stallNext(path) {
    if (path === '/ws') {
      await page.evaluate(() => { window.__heldSocket = undefined; window.__holdNextSocket = true; });
      return {
        entered: page.waitForFunction(() => window.__heldSocket?.readyState === 1),
        aborted: async () => page.evaluate(() => window.__heldSocket.readyState === 3),
        done: async () => page.evaluate(() => { const socket = window.__heldSocket, callbacks = socket.__held; socket.__held = undefined; if (socket.readyState === 1) for (const callback of callbacks) callback(); }),
      };
    }
    let seen, release, held = false, aborted = false;
    const entered = new Promise(resolve => seen = resolve), unblock = new Promise(resolve => release = resolve);
    const matcher = url => url.pathname.endsWith(path);
    const handler = async route => {
      if (held) { await route.continue(); return; }
      held = true; seen(); await unblock;
      try { await route.continue(); } catch { /* The client already canceled this request. */ }
    };
    const failed = request => { if (new URL(request.url()).pathname.endsWith(path)) aborted = true; };
    page.on('requestfailed', failed); await page.route(matcher, handler);
    return { entered, aborted: () => aborted, done: async () => { release(); await page.unroute(matcher, handler); page.off('requestfailed', failed); } };
  }

  let states, stalled;
  if (scenario === 'native') {
    await silentStall();
    await foregroundHandoff();
  
    // Keys handed to a dead link reach the terminal once: a dead uplink resends them, and a dead downlink does not.
    for (const link of ['uplink', 'downlink']) {
      await stalledTyping(link, `echo $((40+2))-${link}-once`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(link => window.__output.includes(`42-${link}-once`), link);
      await page.waitForFunction(() => document.querySelector('#shell-status').textContent === 'At prompt');
      const output = await page.evaluate(() => window.__output);
      assert.equal(output.split(`42-${link}-once`).length, 2, `Keys typed into a dead ${link} run once: ${JSON.stringify(output.slice(-200))}`);
      assert.match(output, new RegExp(`42-${link}-once\r\n`));
    }
  
    await queuedTyping('queued-native-once');
    await page.keyboard.press('Control+c'); await delay(100);
    await queuedTyping('never-send-to-new-shell', () => page.evaluate(async () => {
      const reply = await fetch(new URL('api/new', document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!reply.ok) throw new Error('Could not replace the test shell');
    }));
    assert.equal(connectRequests.length, 0, 'Healthy same-origin reconnects skip HTTP authorization');
  
    connectionPhase = 'retained replay';
    // Recover before a closing socket delivers its close event to the app.
    states = await stateCount();
    await background();
    assert.equal(await page.evaluate(() => window.__sockets.at(-1).readyState), 1, 'Short backgrounding retains the connection');
    await foreground();
    assert.equal(await stateCount(), states, 'Returning during grace needs no replay');
    await page.evaluate(() => {
      window.__holdCloses = true;
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      window.__expireBackground();
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await connected(states);
    await page.evaluate(() => { window.__holdCloses = false; for (const close of window.__lateCloses.splice(0)) close(); });
    assert.equal(await page.locator('#connection-label').textContent(), 'Connected');
  
    // An online event must replace an existing OPEN socket, without replaying input.
    states = await stateCount();
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    await focusInput(); await page.keyboard.type('echo reconnect-once');
    // Once the shell echoes the keys, the replacement learns they arrived and resends none of them.
    await page.waitForFunction(() => window.__output.includes('echo reconnect-once'));
    const inputs = await page.evaluate(() => window.__sent.filter(message => message.type === 'input').length);
    await online(); await connected(states);
    assert.equal(await page.evaluate(() => window.__sent.filter(message => message.type === 'input').length), inputs);
    await page.keyboard.press('Control+c');
    // Flush input queued by this reconnect before observing the next replay.
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
  
    // Input after acknowledgement waits for the retained screen's final paint.
    await focusInput();
    await page.evaluate(() => {
      window.__paintRAF = window.requestAnimationFrame;
      window.__pendingPaintFrames = [];
      window.requestAnimationFrame = callback => { window.__pendingPaintFrames.push(callback); return 0; };
      window.__sent = [];
    });
    states = await stateCount(); await online();
    await page.waitForFunction(states => window.__states > states && document.querySelector('#connection-label').textContent === 'Connected', states, { polling: 50 });
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => window.__sent.filter(message => message.type === 'input').length),0,'Keep fast input queued until replay paints');
    await page.evaluate(() => {
      window.requestAnimationFrame = window.__paintRAF;
      for (const callback of window.__pendingPaintFrames.splice(0)) requestAnimationFrame(callback);
    });
    await page.waitForFunction(() => window.__sent.some(message => message.type === 'input' && message.data === '\x03'));
    await page.locator('.terminal-presentation').waitFor({state:'hidden'});
  
    connectionPhase = 'flow-controlled replay';
    // Output still queued behind painting is not replayed again, and the replacement keeps acknowledging.
    await focusInput();
    await page.evaluate(() => {
      window.__paintRAF = window.requestAnimationFrame;
      window.__pendingPaintFrames = [];
      window.requestAnimationFrame = callback => { window.__pendingPaintFrames.push(callback); return 0; };
      window.__queuedOutput = 0;
      window.__sockets.at(-1).addEventListener('message', async event => {
        const message = await window.__wireMessage(event.data);
        if (message.type === 'output') window.__queuedOutput = Math.max(window.__queuedOutput, message.seq);
      });
    });
    await page.keyboard.type('seq 1 60000; echo $((6*7))-queued-done'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#shell-status').textContent === 'Running');
    // Unpainted output is never acknowledged, so delivery stops once the window is full.
    let queuedOutput = -1;
    for (;;) {
      await delay(500);
      const current = await page.evaluate(() => window.__queuedOutput);
      if (current > 0 && current === queuedOutput) break;
      queuedOutput = current;
    }
    const replacement = await stallNext('/ws');
    await page.evaluate(() => {
      // Observe the replacement from its first message.
      window.__replayed = [];
      const Previous = window.WebSocket;
      window.WebSocket = class extends Previous {
        constructor(...args) {
          super(...args); window.WebSocket = Previous;
          this.addEventListener('message', async event => {
            const message = await window.__wireMessage(event.data);
            if (message.type === 'output') window.__replayed.push(message.seq);
          });
        }
      };
    });
    await online(); await replacement.entered;
    await page.evaluate(() => {
      // Paint the earlier socket's queue before the replacement has delivered anything.
      window.requestAnimationFrame = window.__paintRAF;
      for (const callback of window.__pendingPaintFrames.splice(0)) requestAnimationFrame(callback);
    });
    await delay(300);
    await replacement.done();
    await page.waitForFunction(() => document.querySelector('#shell-status').textContent === 'At prompt', undefined, { timeout: 15000 });
    const replayed = await page.evaluate(() => window.__replayed);
    // Each replay message carries the final sequence of its batch, so any earlier value means resent output.
    assert.ok(replayed.length && Math.min(...replayed) > queuedOutput, `Replay resumes after queued output ${queuedOutput}: ${replayed.slice(0, 3)}`);
    await page.locator('.terminal-presentation').waitFor({state:'hidden'});
  
    connectionPhase = 'snapshot replay';
    await focusInput();
    const archivePrompt = await page.evaluate(() => window.__testShellState.prompt);
    await page.keyboard.type("printf 'archive-before-outage\\n'"); await page.keyboard.press('Enter');
    await page.waitForFunction(prompt => window.__testShellState.ready && window.__testShellState.prompt > prompt, archivePrompt);
    // Far more output than a quick replay arrives as one snapshot of the backend's terminal.
    await focusInput();
    const snapshotPrompt = await page.evaluate(() => window.__testShellState.prompt);
    await page.keyboard.type('sleep 1; seq 1 60000; echo $((6*7))-snapshot-done'); await page.keyboard.press('Enter');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    const cookie = (await context.cookies(base)).map(item => item.name + '=' + item.value).join('; ');
    await until(async () => {
      const response = await fetch(base + 'api/connect', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'default' }) });
      const { state } = await response.json();
      return state?.ready && state.prompt > snapshotPrompt;
    }, 'missed output completes before snapshot replay');
    states = await stateCount();
    await page.evaluate(() => {
      // Observe the replacement from its first message.
      window.__snapshotMessages = [];
      const Previous = window.WebSocket;
      window.WebSocket = class extends Previous {
        constructor(...args) {
          super(...args); window.WebSocket = Previous;
          this.addEventListener('message', async event => {
            const message = await window.__wireMessage(event.data);
            if (['hello', 'output'].includes(message.type)) window.__snapshotMessages.push(message);
          });
        }
      };
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await connected(states);
    await page.waitForFunction(() => document.querySelector('#shell-status').textContent === 'At prompt');
    await page.locator('.terminal-presentation').waitFor({state:'hidden'});
    const [hello, ...snapshotOutputs] = await page.evaluate(() => window.__snapshotMessages);
    assert.equal(hello.type, 'hello'); assert.equal(hello.reset, true); assert.equal(hello.truncated, false);
    assert.equal(snapshotOutputs.length, 1, 'One snapshot replaces the raw replay');
    assert.match(snapshotOutputs[0].data, /42-snapshot-done/);
    assert.ok(snapshotOutputs[0].data.length < 200000, 'The snapshot is far smaller than the missed output');
    assert.ok(!snapshotOutputs[0].data.includes('57000'), 'Foreground recovery keeps its small history window');
    await until(() => page.evaluate(() => new Promise(resolve => {
      const request = indexedDB.open('libertty-terminal-history');
      request.onsuccess = () => { const db = request.result, read = db.transaction('terminals').objectStore('terminals').getAll(); read.onsuccess = () => { db.close(); resolve(read.result.some(record => record.records.some(item => item.text.includes('57000')))); }; };
    })), 'background history backfill');
    connectionPhase = 'background cancellation';
    // A request stranded by backgrounding cannot block the next foreground attempt.
    stalled = await stallNext('/ws'); states = await stateCount();
    await online(); await stalled.entered;
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    const retainedPixels = await page.locator('#terminal canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 40 || pixels[i + 1] > 40 || pixels[i + 2] > 40) painted++;
      return painted;
    });
    assert.ok(retainedPixels > 100, 'Retain readable text while authorization is pending');
    const track = page.locator('.terminal-scrollbar');
    await track.press('Home');
    assert.equal(await track.getAttribute('aria-valuenow'), '0', 'Cached history scrolls without a connection');
    await track.press('End');
    assert.equal(await track.getAttribute('aria-valuenow'), await track.getAttribute('aria-valuemax'));
    await background(); await page.evaluate(() => window.__expireBackground()); await foreground(); await connected(states);
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__sockets.filter(socket => socket.readyState === WebSocket.OPEN).length === 1);
    assert.equal(await stalled.aborted(), true, 'Background expiry aborts an incomplete connection'); await stalled.done();
  
    connectionPhase = 'deadline retry';
    // Even without a visibility/network event, the deadline drives another attempt.
    stalled = await stallNext('/ws'); states = await stateCount();
    await online(); await stalled.entered; await connected(states, 22000);
    assert.equal(await stalled.aborted(), true, 'The connection deadline aborts a missing initial state'); await stalled.done();
    assert.ok(connectRequests.length <= 2, 'Only failed direct reconnects repeat authorization: ' + JSON.stringify(connectRequests));
    const beforeCookieExpiry = connectRequests.length;
    await context.clearCookies(); states = await stateCount(); await online(); await connected(states);
    assert.equal(connectRequests.length, beforeCookieExpiry + 1, 'An expired session cookie recovers through remembered authorization');
    connectRequests.length = 0;
  }
  if (scenario === 'herdr') {
    // Herdr also bounds/cancels the ticket request after authorization succeeds.
    await page.goto(base + 'terminal.html?herdrTerminal=term_0'); await connected(0);
    await queuedTyping('queued-herdr-once');
    const herdrTyped = () => fixture.actions.filter(action => action.method === 'pane.send_text').map(action => action.params.text).join('');
    for (const link of ['uplink', 'downlink']) {
      const text = `herdr-${link}-once`;
      await stalledTyping(link, text);
      await until(() => herdrTyped().includes(text), `Herdr keys typed into a dead ${link}`);
      await delay(300);
      assert.equal(herdrTyped().split(text).length, 2, `Herdr keys typed into a dead ${link} arrive once: ${JSON.stringify(herdrTyped().slice(-120))}`);
    }
    await queuedTyping('never-send-to-new-process', async () => { fixture.setProcessGroup(3); });
    await silentStall();
    await foregroundHandoff();
    stalled = await stallNext('/api/herdr/ticket'); states = await stateCount();
    await online(); await stalled.entered;
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('#terminal canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0), 'Keep the Herdr screen during ticket acquisition');
    await background(); await page.evaluate(() => window.__expireBackground()); await foreground(); await connected(states);
    await page.locator('.terminal-presentation').waitFor({ state: 'hidden' });
    assert.equal(stalled.aborted(), true, 'backgrounding aborts Herdr ticket acquisition'); await stalled.done();
    stalled = await stallNext('/api/herdr/ticket'); states = await stateCount();
    await online(); await stalled.entered; await connected(states, 22000);
    assert.equal(stalled.aborted(), true, 'the connection deadline aborts Herdr ticket acquisition'); await stalled.done();
    assert.equal(connectRequests.length, 0, 'A remembered Herdr token needs only fresh scoped tickets');
  }
  assert.deepEqual(errors, []);
  console.log('PASS reconnect ' + scenario + ' scenario');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await exited; await fixture.close();
}
