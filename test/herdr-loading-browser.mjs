import { showTerminalTabs } from './support/workspace-navigation.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { herdrFixture } from './herdr-fixture.ts';
import { installWireObserver } from './wire-observer.mjs';

const root = new URL('../', import.meta.url).pathname, fixture = await herdrFixture();
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = 'http://127.0.0.1:' + port, first = 'loading-first', second = 'loading-second';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label) { for (const end = Date.now() + 15000; Date.now() < end;) { if (await check()) return; await delay(20); } throw new Error('Timed out: ' + label); }
fixture.setScreen(0, 'SCREEN_ALPHA\nAlready ready\n'); fixture.setScreen(1, 'SCREEN_BETA\nNewly loaded\n');
const backend = spawn(root + 'target/debug/termai', [], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV:'production', HOST:'127.0.0.1', PORT:String(port), TERMAI_ALLOWED_HOSTS:'127.0.0.1', TERMAI_ALLOWED_ORIGINS:base, TERMAI_DATA_DIR:fixture.directory+'/termai', TERMAI_TOKEN:'', TERMAI_NO_RC:'1', TERMAI_CWD:fixture.directory, HOME:fixture.directory, PATH:fixture.directory+':'+process.env.PATH, HERDR_SOCKET_PATH:fixture.socketPath },
});
const exited = once(backend, 'exit'); let browser, logs = '';
backend.stdout.on('data', bytes => logs += bytes); backend.stderr.on('data', bytes => logs += bytes);
try {
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'backend');
  const token = (await readFile(fixture.directory+'/termai/pairing-token', 'utf8')).trim();
  browser = await chromium.launch({executablePath:process.env.CHROMIUM||'/usr/bin/chromium',headless:true,args:['--use-gl=angle','--use-angle=gl']});
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await installWireObserver(context);
  await context.addInitScript(({first,second}) => {
    if (window === parent) {
      localStorage.setItem('termai.herdrStrip', JSON.stringify('agents'));
      localStorage.setItem('termai.hosts', JSON.stringify([{id:'herdr',name:'Herdr',kind:'herdr',backendId:'primary'}]));
      localStorage.setItem('termai.tabs', JSON.stringify([first,second].map((id,i)=>({id,session:'default',name:'Herdr '+(i+1),mode:'herdr',backendId:'primary',hostId:'herdr'}))));
      localStorage.setItem('termai.activeTab', JSON.stringify(first));
      localStorage.setItem('termai.shortcuts', JSON.stringify([{label:'Stop',kind:'keys',value:'Escape'},{label:'Ctrl',kind:'keys',value:'Ctrl'},{label:'Status',kind:'command',value:'pwd'}]));
      window.__holdRendered = []; window.__holdAllRendered = true; window.__visibleScreens = [];
      window.__holdShortcuts = []; window.__holdAllShortcuts = true; window.__bottomLayouts = [];
      window.__bottomLayout = () => {
        const strips = [...document.querySelectorAll('.herdr-agent-strip')];
        const strip = strips.find(element => element.checkVisibility({checkVisibilityCSS:true})) || strips.find(element => element.getClientRects().length);
        return [...document.querySelectorAll('#terminal-header, #workspace-shortcuts'), ...(strip ? [strip] : [])].map(element => {
          const {y,height} = element.getBoundingClientRect(); return {bar:element === strip ? 'herdr-agent-strip' : element.id || element.className,y,height};
        });
      };
      const inspect = () => {
        const screens = [...document.querySelectorAll('.herdr-screen iframe')].filter(frame => frame.checkVisibility({checkVisibilityCSS:true}) && getComputedStyle(frame.contentDocument.querySelector('#terminal-viewport')).visibility !== 'hidden').map(frame => {
          const t = frame.contentWindow.__terminal, b = t?.buffer.active; return b?.getLine(b.viewportY)?.translateToString(true);
        }).filter(Boolean);
        window.__visibleScreens.push(screens);
        if (window.__captureBottomLayout) window.__bottomLayouts.push(window.__bottomLayout());
        requestAnimationFrame(inspect);
      }; requestAnimationFrame(inspect);
      return;
    }
    window.__blockedRendered = []; window.__blockedShortcuts = [];
    window.__postToParent = (message, origin) => {
      const terminal = new URLSearchParams(location.search).get('herdrTerminal');
      if (message.type === 'terminal-rendered' && (parent.__holdAllRendered || parent.__holdRendered?.includes(terminal))) window.__blockedRendered.push(message);
      else if (message.type === 'terminal-shortcuts' && (parent.__holdAllShortcuts || parent.__holdShortcuts?.includes(terminal))) window.__blockedShortcuts.push(message);
      else parent.postMessage(message, origin);
    };
  }, {first,second});
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__terminal=new $1({ghostty:').replaceAll('parent.postMessage(', 'window.__postToParent(');
    assert.notEqual(body, original); assert.ok(body.includes('window.__postToParent')); await route.fulfill({response,body});
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir(root+'.test-artifacts',{recursive:true});
  await page.goto(base); await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  const pane = (id, terminal) => page.locator('#herdr-'+id+' iframe[data-terminal="'+terminal+'"]');
  const frame = async locator => (await locator.elementHandle()).contentFrame();
  const assertVisible = async (locator, visible) => { if (!visible && !await locator.count()) return; assert.equal(await locator.evaluate(element => element.checkVisibility({checkVisibilityCSS:true})), visible); };
  const release = async child => child.evaluate(() => { for(const message of window.__blockedRendered.splice(0)) parent.postMessage(message, location.origin); });
  const releaseShortcuts = async child => child.evaluate(() => { for(const message of window.__blockedShortcuts.splice(0)) parent.postMessage(message, location.origin); });
  const hotkeys = page.locator('#workspace-shortcut-buttons button');
  const captureBottomLayout = () => page.evaluate(async () => {
    window.__bottomLayouts=[]; window.__captureBottomLayout=true;
    // Start sampling before a fast handoff can finish within the current frame.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return window.__bottomLayout();
  });
  const assertBottomLayout = async expected => {
    const layouts = await page.evaluate(() => { window.__captureBottomLayout=false; return window.__bottomLayouts; });
    assert.ok(layouts.length > 0, 'Inspect bottom bars on animation frames during loading');
    for (const layout of layouts) assert.deepEqual(layout, expected, 'Loading must never hide the hotkeys or move the other bottom bars');
    assert.deepEqual(await page.evaluate(() => window.__bottomLayout()), expected);
  };
  const initial = await frame(pane(first,'term_0'));
  await wait(async () => await initial.evaluate(() => window.__blockedRendered.length > 0 && window.__blockedShortcuts.length > 0), 'cold pane ready behind the loading screen');
  await assertVisible(pane(first,'term_0'),false); assert.equal(await page.locator('#terminal-loading').isVisible(),true);
  assert.equal(await page.locator('#terminal-loading').evaluate(element => element.classList.contains('has-previous')),false);
  assert.equal(await page.locator('#workspace-shortcuts').isVisible(),true,'The bar is present before the first terminal publishes shortcuts');
  assert.deepEqual(await hotkeys.allTextContents(),['Stop','Ctrl','Status','Image'],'Saved shortcuts are shown during loading');
  assert.equal(await hotkeys.evaluateAll(buttons => buttons.every(button => button.disabled)),true);
  const coldLayout = await captureBottomLayout();
  await page.evaluate(() => { window.__holdAllShortcuts=false; }); await releaseShortcuts(initial);
  await delay(100); assert.equal(await hotkeys.evaluateAll(buttons => buttons.every(button => button.disabled)),true,'A painted acknowledgement is required before enabling input');
  await page.screenshot({path:root+'.test-artifacts/herdr-loading-initial.png'});
  await page.evaluate(() => { window.__holdAllRendered=false; }); await release(initial);
  await wait(async () => await pane(first,'term_0').count() && await pane(first,'term_0').evaluate(element => element.checkVisibility({checkVisibilityCSS:true})), 'initial ready Alpha');
  await wait(async () => !(await hotkeys.first().isDisabled()),'initial shortcuts enabled');
  await assertBottomLayout(coldLayout);
  assert.equal(await page.locator('#terminal-loading').isVisible(), false);
  const paneLayout = await captureBottomLayout();
  await page.evaluate(() => { window.__holdRendered=['term_1']; window.__holdShortcuts=['term_1']; window.__visibleScreens=[]; });
  await page.locator('#herdr-strip-'+first+' .herdr-agent-tab[data-terminal="term_1"]').click();
  const beta = await frame(pane(first,'term_1'));
  await wait(async () => await beta.evaluate(() => window.__blockedRendered.length > 0 && window.__blockedShortcuts.length > 0), 'new pane painted behind the old view');
  await assertVisible(pane(first,'term_0'),true); await assertVisible(pane(first,'term_1'),false);
  assert.equal(await pane(first,'term_0').evaluate(element => element.inert),true);
  assert.equal(await page.locator('#herdr-'+first+' .herdr-loading').isVisible(),true);
  assert.equal(await hotkeys.evaluateAll(buttons => buttons.every(button => button.disabled)),true,'Pending shortcuts cannot send input to the previous pane');
  assert.deepEqual(await hotkeys.allTextContents(),['Stop','Ctrl','Status','Image']);
  const pendingActions = fixture.actions.length;
  await hotkeys.evaluateAll(buttons => buttons.forEach(button => button.click()));
  await delay(100); assert.equal(fixture.actions.slice(pendingActions).some(action => action.method === 'pane.send_text'),false);
  await beta.evaluate(() => parent.postMessage({type:'terminal-rendered',session:new URLSearchParams(location.search).get('session'),presentation:'superseded'},location.origin));
  await delay(100); await assertVisible(pane(first,'term_1'),false);
  await assertBottomLayout(paneLayout);
  const oldCols=await beta.evaluate(() => window.__terminal.cols);
  await page.setViewportSize({width:360,height:800});
  await wait(async () => await beta.evaluate(oldCols => window.__terminal.cols < oldCols && window.__blockedRendered.some(message => message.cols === window.__terminal.cols),oldCols),'new geometry painted while the switch is pending');
  await beta.evaluate(oldCols => parent.postMessage(window.__blockedRendered.find(message => message.cols === oldCols),location.origin),oldCols);
  await delay(100); await assertVisible(pane(first,'term_1'),false);
  await page.screenshot({path:root+'.test-artifacts/herdr-loading-previous.png'});
  assert.ok((await page.evaluate(() => window.__visibleScreens)).every(screens => screens.includes('SCREEN_ALPHA') && !screens.includes('SCREEN_BETA')), 'Every loading frame keeps Alpha until Beta is ready');
  const resizedLayout = await captureBottomLayout();
  await page.evaluate(() => { window.__holdRendered=[]; }); await release(beta);
  await wait(async () => await pane(first,'term_1').evaluate(element => element.checkVisibility({checkVisibilityCSS:true})), 'atomic handoff to Beta');
  await assertVisible(pane(first,'term_0'),false); assert.equal(await page.locator('#herdr-'+first+' .herdr-loading').isVisible(),false);
  assert.equal(await hotkeys.first().isDisabled(),true,'The bar stays visible when paint precedes shortcut state');
  await page.evaluate(() => { window.__holdShortcuts=[]; }); await releaseShortcuts(beta);
  await wait(async () => !(await hotkeys.first().isDisabled()),'incoming shortcuts enabled');
  await assertBottomLayout(resizedLayout);
  const hotkeyActions = fixture.actions.length;
  await hotkeys.filter({hasText:'Stop'}).click();
  await wait(() => fixture.actions.slice(hotkeyActions).some(action => action.method === 'pane.send_text' && action.params.pane_id === 'w1:p1' && action.params.text === '\x1b'),'hotkey reaches only the newly selected pane');
  assert.equal(fixture.actions.slice(hotkeyActions).some(action => action.method === 'pane.send_text' && action.params.pane_id === 'w1:p0'),false);
  const size=await beta.evaluate(() => ({width:window.__terminal.cols,height:window.__terminal.rows}));
  fixture.setScreen(1,'\x1b[48;2;20;200;240mSCREEN_BETA\x1b[0m\nNewly loaded\n',undefined,size);
  await wait(async () => {
    const png=(await beta.locator('#terminal canvas').screenshot()).toString('base64');
    return page.evaluate(async png => {
      const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:'image/png'}));
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let cyan=0;
      for(let i=0;i<pixels.length;i+=4) if(pixels[i]<35&&pixels[i+1]>185&&pixels[i+2]>230) cyan++;
      return cyan>50;
    },png);
  },'live canvas continues painting after the hidden-to-visible handoff');

  // Cancel a pending switch and reject its delayed acknowledgement.
  await page.evaluate(() => { window.__holdRendered=['term_0']; });
  await page.locator('#herdr-strip-'+first+' .herdr-agent-tab[data-terminal="term_0"]').click();
  const alpha = await frame(pane(first,'term_0'));
  await wait(async () => await alpha.evaluate(() => window.__blockedRendered.length > 0), 'pending Alpha switch');
  await page.locator('#herdr-strip-'+first+' .herdr-agent-tab[data-terminal="term_1"]').click();
  await page.evaluate(() => { window.__holdRendered=[]; }); if (!alpha.isDetached()) await release(alpha);
  await wait(async () => await page.locator('#herdr-'+first+' .herdr-loading').isHidden(), 'return to already displayed Beta');
  await assertVisible(pane(first,'term_1'),true); await assertVisible(pane(first,'term_0'),false);

  // Leaving the app tab keeps its last displayed pane for the return handoff.
  await page.evaluate(() => { window.__holdRendered=['term_1']; });
  await showTerminalTabs(page); await page.locator('#terminal-back').click();
  await page.locator('#nav-terminals').click();
  await assertVisible(pane(first,'term_1'),true);
  assert.equal(await page.locator('#herdr-'+first+' .herdr-loading').isVisible(),true);
  assert.equal(await pane(first,'term_1').evaluate(element => element.inert),true);
  await page.evaluate(() => { window.__holdRendered=[]; }); await release(beta);
  await wait(async () => await page.locator('#herdr-'+first+' .herdr-loading').isHidden(), 'return to the retained app tab');

  // A top-level Herdr tab prepares offscreen while the prior tab remains visible.
  const tabLayout = await captureBottomLayout();
  await page.evaluate(() => { window.__holdAllRendered=true; window.__holdAllShortcuts=true; window.__visibleScreens=[]; });
  await page.locator('#tabs .tab').filter({hasText:'Herdr 2'}).click();
  const secondPane = page.locator('#herdr-'+second+' .herdr-terminal'), incoming = await frame(secondPane);
  await wait(async () => await incoming.evaluate(() => window.__blockedRendered.length > 0 && window.__blockedShortcuts.length > 0), 'top-level tab ready behind the previous tab');
  await assertVisible(page.locator('#herdr-'+first),true); await assertVisible(page.locator('#herdr-'+second),false);
  assert.equal(await page.locator('#terminal-loading').isVisible(),true);
  assert.equal(await page.locator('#terminal-loading-label').textContent(),'Loading Herdr…');
  assert.equal(await page.locator('#herdr-'+first).evaluate(element => element.inert),true);
  assert.equal(await hotkeys.evaluateAll(buttons => buttons.every(button => button.disabled)),true);
  await assertBottomLayout(tabLayout);
  const incomingCols=await incoming.evaluate(() => window.__terminal.cols);
  await page.evaluate(() => { window.__visibleScreens=[]; }); await page.setViewportSize({width:390,height:844});
  await wait(async () => await incoming.evaluate(cols => window.__terminal.cols > cols && window.__blockedRendered.some(message => message.cols === window.__terminal.cols),incomingCols),'resized top-level tab ready behind the held view');
  assert.ok((await page.evaluate(() => window.__visibleScreens)).every(screens => screens.includes('SCREEN_BETA') && !screens.includes('SCREEN_ALPHA')), 'Resizing a pending top-level switch keeps the prior pane visible');
  await page.screenshot({path:root+'.test-artifacts/herdr-loading-top-level.png'});
  await page.locator('#tabs .tab').filter({hasText:'Herdr 1'}).click(); await page.evaluate(() => { window.__holdAllRendered=false; }); await release(incoming);
  await page.evaluate(() => { window.__holdAllShortcuts=false; }); await releaseShortcuts(incoming);
  await delay(100); await assertVisible(page.locator('#herdr-'+first),true); await assertVisible(page.locator('#herdr-'+second),false);
  assert.equal(await page.locator('#terminal-loading').isVisible(),false);
  await page.locator('#tabs .tab').filter({hasText:'Herdr 2'}).click();
  await wait(async () => await page.locator('#herdr-'+second).evaluate(element => element.checkVisibility({checkVisibilityCSS:true})), 'top-level completed handoff');
  await assertVisible(page.locator('#herdr-'+first),false); assert.equal(await page.locator('#terminal-loading').isVisible(),false);

  // Opening the software keyboard resizes the loaded pane without taking input away.
  const input = incoming.locator('#terminal textarea');
  await input.evaluate(element => { window.__inputBlurs=0; element.addEventListener('blur',()=>window.__inputBlurs++); });
  const canvas = await incoming.locator('#terminal canvas').boundingBox();
  await page.touchscreen.tap(canvas.x+canvas.width*.5,canvas.y+canvas.height*.3);
  assert.equal(await input.evaluate(element => element === document.activeElement && !element.readOnly),true,'A tap enables Herdr input');
  const rows = await incoming.evaluate(() => window.__terminal.rows);
  await page.setViewportSize({width:390,height:460});
  await wait(async () => await incoming.evaluate(rows => window.__terminal.rows < rows,rows),'keyboard opening resizes the pane');
  await wait(async () => await incoming.locator('#terminal-viewport').evaluate(element => !element.classList.contains('awaiting-herdr-layout')),'keyboard-sized redraw completes');
  assert.equal(await incoming.evaluate(() => window.__inputBlurs),0,'Keyboard opening must never blur the Herdr input');
  assert.equal(await input.evaluate(element => element === document.activeElement && !element.readOnly),true,'Herdr remains editable after keyboard resize');
  const inputStart = fixture.actions.length;
  await page.keyboard.type('Still editable');
  await wait(() => fixture.actions.slice(inputStart).filter(action => action.method==='pane.send_text').map(action => action.params.text).join('')==='Still editable','typed input reaches Herdr after keyboard resize');
  await page.setViewportSize({width:390,height:844});
  await wait(async () => await input.evaluate(element => element !== document.activeElement && element.readOnly),'keyboard dismissal disarms input');
  const restoredCanvas = await incoming.locator('#terminal canvas').boundingBox();
  await page.touchscreen.tap(restoredCanvas.x+restoredCanvas.width*.5,restoredCanvas.y+restoredCanvas.height*.3);
  assert.equal(await input.evaluate(element => element === document.activeElement && !element.readOnly),true,'A fresh tap reopens Herdr input after dismissal');
  assert.deepEqual(errors,[]);
  console.log('PASS: Herdr handoffs keep configured hotkeys and bottom bars stationary through delayed shortcut/paint messages, route input only to ready panes, reject stale/resized/cancelled switches, and preserve input through keyboard opening.');
} catch(error) { console.error(logs); throw error; }
finally { await browser?.close(); backend.kill(); await exited; await fixture.close(); }
