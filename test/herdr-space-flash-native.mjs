import { launchBrowser, delay, until as wait } from './support/browser.mjs';
import assert from 'node:assert/strict';
import { showTerminalTabs } from './support/workspace-navigation.mjs';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import pty from 'node-pty';
import { herdrRequest, herdrSnapshot } from './support/herdr.ts';
import { shellQuote } from '../src/shell-words.ts';
import { installWireObserver } from './wire-observer.mjs';

const root = new URL('../', import.meta.url).pathname, dir = await mkdtemp('/tmp/libertty-herdr-flash-');
const target = { session:'', socketPath:dir+'/herdr.sock' };
const env = { ...process.env, HOME:dir, XDG_CONFIG_HOME:dir+'/config', XDG_DATA_HOME:dir+'/data', XDG_STATE_HOME:dir+'/state', HERDR_SOCKET_PATH:target.socketPath, HERDR_SESSION:'', HERDR_ENV:'', SHELL:'/bin/bash', TERM:'xterm-256color' };
let herdr, desktop, backend, browser;
const errors=[];
try {
  const listener = net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening'); const port=listener.address().port; await new Promise(resolve=>listener.close(resolve));
  const base='http://127.0.0.1:'+port;
  await mkdir(dir+'/config',{recursive:true});
  await writeFile(dir+'/responsive.mjs', `
    import {writeFileSync} from 'node:fs';
    const name=process.argv[2];
    const draw=()=>{ const cols=process.stdout.columns,rows=process.stdout.rows; writeFileSync('geometry-'+name+'.json',JSON.stringify({cols,rows})); process.stdout.write('\\x1b[2J\\x1b[H\\x1b[48;2;'+(cols<100?'0;180;0':'250;0;0')+'mFLASH_'+name+':'+(cols<100?'MOBILE':'DESKTOP')+'\\x1b[0m\\r\\n╭'+'─'.repeat(cols-2)+'╮\\r\\n│ '+cols+' columns × '+rows+' rows\\x1b[?25l'); };
    process.stdin.setRawMode(true);process.stdin.resume();draw();process.on('SIGWINCH',()=>setTimeout(draw,${Number(process.env.TEST_REDRAW_DELAY||0)}));setInterval(()=>{},10000);
  `);
  herdr=spawn(process.env.HERDR_BINARY||'/usr/bin/herdr',['server'],{cwd:dir,env,stdio:'ignore'});
  await wait(async()=>{try{await herdrSnapshot(target);return true;}catch{return false;}},'Herdr server');
  desktop=pty.spawn(process.env.HERDR_BINARY||'/usr/bin/herdr',[],{cwd:dir,env,cols:150,rows:45,name:'xterm-256color'});desktop.onData(()=>{});
  const spaces=[];
  for(const name of ['ALPHA','BETA','GAMMA','DELTA','EPSILON','ZETA'].slice(0,Number(process.env.TEST_SPACES||2))) {
    const workspace=(await herdrRequest(target,'workspace.create',{cwd:dir,label:name,focus:false})).workspace.workspace_id;
    const terminal=(await herdrSnapshot(target)).terminals.find(t=>t.workspaceId===workspace);
    await delay(200);await herdrRequest(target,'pane.send_text',{pane_id:terminal.paneId,text:[process.execPath,dir+'/responsive.mjs',name].map(shellQuote).join(' ')+'\r'});
    await wait(async()=> (await herdrRequest(target,'pane.read',{pane_id:terminal.paneId,source:'recent_unwrapped',lines:1000,format:'ansi',strip_ansi:false})).read.text.includes('FLASH_'+name+':DESKTOP'),'desktop TUI '+name);
    spaces.push({name,workspace,terminal});
  }
  backend=spawn(root+'target/debug/libertty',[],{cwd:root,env:{...env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),LIBERTTY_ALLOWED_HOSTS:'127.0.0.1',LIBERTTY_ALLOWED_ORIGINS:base,LIBERTTY_DATA_DIR:dir+'/libertty',LIBERTTY_TOKEN:'',LIBERTTY_NO_RC:'1',LIBERTTY_CWD:dir},stdio:'ignore'});
  await wait(async()=>{try{return(await fetch(base)).ok;}catch{return false;}},'backend');
  if(process.env.TEST_REDRAW_TRACE) console.log('Native revision probe:', await herdrRequest(target,'pane.copy_motion',{pane_id:spaces[0].terminal.paneId,motion:'line_end',cursor:{row:0,col:0}}).catch(error=>error.message));
  const token=(await readFile(dir+'/libertty/pairing-token','utf8')).trim();
  browser=await launchBrowser({args:['--use-gl=angle','--use-angle=gl']});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await installWireObserver(context);
  await context.route('**/assets/terminal-*.js',async route=>{const response=await route.fetch(),source=await response.text();const body=source.replace(/new ([\w$]+)\(\{ghostty:/,'window.__terminal=new $1({ghostty:');assert.notEqual(body,source);await route.fulfill({response,body});});
  await context.addInitScript(()=>{
    // Folded status lanes would hide the idle spaces this test switches between.
    if(window===parent&&!localStorage.getItem('libertty.tabs')) {localStorage.setItem('libertty.herdrStripOrder',JSON.stringify('manual'));const id=crypto.randomUUID();localStorage.setItem('libertty.hosts',JSON.stringify([{id:'herdr-native',name:'Herdr',kind:'herdr',backendId:'primary'}]));localStorage.setItem('libertty.tabs',JSON.stringify([{id,session:'default',name:'Herdr',pluginId:'herdr',pluginVersion:'1',backendId:'primary',hostId:'herdr-native'}]));localStorage.setItem('libertty.activeTab',JSON.stringify(id));}
    if(window===parent) {
      window.__flashPaints=[];const previous=new WeakMap();
      const inspect=()=>{
        for(const frame of document.querySelectorAll('.herdr-screen iframe')) {
          if(!frame.checkVisibility({checkVisibilityCSS:true})) continue;
          const child=frame.contentWindow,t=child.__terminal,viewport=child.document.querySelector('#terminal-viewport');
          if(!t||!viewport||child.getComputedStyle(viewport).visibility==='hidden') continue;
          const b=t.buffer.active,top=b.viewportY,title=b.getLine(top)?.translateToString(true),border=b.getLine(top+1)?.translateToString(true);
          if(!title?.startsWith('FLASH_')) continue;
          const key=title+'\0'+border+'\0'+t.cols+'\0'+t.rows;
          if(previous.get(frame)!==key||child.__captureAllPaints) {
            previous.set(frame,key);window.__flashPaints.push({type:'test-layout-paint',title,border,cols:t.cols,rows:t.rows,time:performance.timeOrigin+performance.now(),terminal:frame.dataset.terminal});
          }
        }
        requestAnimationFrame(inspect);
      };requestAnimationFrame(inspect);return;
    }
    window.__frames=[];const Original=WebSocket;window.WebSocket=class extends Original {constructor(...args){super(...args);this.addEventListener('message',async event=>{const m=await window.__wireMessage(event.data,this);if(m.type==='herdr-layout') (window.__layoutSignals ||= []).push(m); if(m.type==='herdr-frame')window.__frames.push({width:m.width,height:m.height,full:m.full});});}};
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const cpu=Number(process.env.TEST_CPU||1); if(cpu>1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate',{rate:cpu});
  const pixelDirectory = root+'.test-artifacts/herdr-pixel-flash-'+Date.now(); await mkdir(pixelDirectory,{recursive:true});
  const compositor = await context.newCDPSession(page), images=[], writes=[];
  compositor.on('Page.screencastFrame', event => {
    const path = pixelDirectory+'/'+images.length+'.png'; images.push({path,time:event.metadata.timestamp*1000});
    writes.push(writeFile(path,Buffer.from(event.data,'base64')));
    void compositor.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
  });
  await compositor.send('Page.startScreencast',{format:'png',everyNthFrame:1});
  await page.goto(base);
  await page.locator('#backend-token').fill(token);await page.locator('#backend-login-form button[type=submit]').click();
  await page.locator('.herdr-agent-tab[data-terminal="space:'+spaces[1].workspace+'"]').click();
  await wait(async()=> (await page.evaluate(()=>window.__flashPaints)).some(p=>p.terminal===spaces[1].terminal.terminalId&&p.title.includes(':MOBILE')),'initial mobile Beta paint');
  const initialPaints = await page.evaluate(() => window.__flashPaints);
  assert.ok(initialPaints.every(p => !p.title.includes(':DESKTOP')), 'Cold opening must wait for application redraw');
  const visited=new Set(initialPaints.map(p=>p.terminal));
  const timings=[];
  for(let i=0;i<Number(process.env.TEST_SWITCHES||10);i++) {
    const space=spaces[i%spaces.length],before=await page.evaluate(()=>{window.__flashPaints=[];return Date.now();});
    const warm=visited.has(space.terminal.terminalId)&&await page.locator('.herdr-terminal-cached[data-terminal="'+space.terminal.terminalId+'"]').count()>0;
    for (const frame of page.frames()) if(frame.url().includes('herdrTerminal=')) await frame.evaluate(() => { window.__captureAllPaints = true; });
    await page.locator('.herdr-agent-tab[data-terminal="space:'+space.workspace+'"]').click();
    await wait(async()=> (await page.evaluate(()=>window.__flashPaints)).some(p=>p.terminal===space.terminal.terminalId&&p.title.includes(':MOBILE')&&p.border==='╭'+'─'.repeat(p.cols-2)+'╮'),'mobile first paint '+space.name);
    await delay(80);const paints=(await page.evaluate(()=>window.__flashPaints)).filter(p=>p.terminal===space.terminal.terminalId);
    const frames=await page.locator('.herdr-terminal,.herdr-terminal-cached').count();
    assert.ok(frames<=4,'Mobile cache must stay bounded at four terminals');
    timings.push({name:space.name,warm,ms:paints[0].time-before,frames,paints});visited.add(space.terminal.terminalId);
    assert.ok(paints.every(p=>p.title==='FLASH_'+space.name+':MOBILE'&&p.border==='╭'+'─'.repeat(p.cols-2)+'╮'),'No visible desktop layout while switching: '+JSON.stringify(paints));
  }
  const geometry=async space=>{try{return JSON.parse(await readFile(dir+'/geometry-'+space.name+'.json','utf8'));}catch{return{};}};
  const retained=await page.locator('.herdr-terminal,.herdr-terminal-cached').evaluateAll(frames=>frames.map(frame=>frame.dataset.terminal));
  for(const space of spaces) if(!retained.includes(space.terminal.terminalId)) await wait(async()=>(await geometry(space)).cols>=100,'Evicted controller releases '+space.name);
  const returns=[];
  for(let i=0;i<Number(process.env.TEST_RETURNS||3);i++) {
    const active=await page.locator('.herdr-terminal').getAttribute('data-terminal'),space=spaces.find(space=>space.terminal.terminalId===active);
    await showTerminalTabs(page);await page.locator('#terminal-back').click();await page.locator('#nav-settings').click();
    await wait(async()=>(await Promise.all(spaces.map(geometry))).every(size=>size.cols>=100),'Leaving Herdr releases every mobile controller');
    const before=await page.evaluate(()=>{window.__flashPaints=[];return Date.now();});
    for(const frame of page.frames()) if(frame.url().includes('herdrTerminal=')) await frame.evaluate(()=>{window.__captureAllPaints=true;});
    await page.locator('#nav-terminals').click();
    await wait(async()=>(await page.evaluate(()=>window.__flashPaints)).some(p=>p.terminal===active&&p.title.includes(':MOBILE')),'Returning to Herdr mobile paint');
    await delay(80);const paints=(await page.evaluate(()=>window.__flashPaints)).filter(p=>p.terminal===active);
    assert.ok(paints.length&&paints.every(p=>p.title==='FLASH_'+space.name+':MOBILE'&&p.border==='╭'+'─'.repeat(p.cols-2)+'╮'),'No visible desktop layout when returning to Herdr: '+JSON.stringify(paints));
    returns.push({name:space.name,ms:paints[0].time-before,paints});
  }
  await compositor.send('Page.stopScreencast'); await Promise.all(writes);
  await page.setViewportSize({width:1100,height:900});
  await wait(async()=>(await Promise.all(spaces.map(geometry))).every(size=>size.cols>=100),'Desktop layout releases parked mobile controllers');
  const captured=[]; for(const frame of images) captured.push({...frame,png:await readFile(frame.path,'base64')});
  const pixels=await page.evaluate(async images=>{
    const result=[];
    for(const {png,...frame} of images) {
      const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));
      const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let desktopPixels=0;
      for(let i=0;i<data.length;i+=4) if(data[i]>240&&data[i+1]<10&&data[i+2]<10) desktopPixels++;
      result.push({...frame,desktopPixels});
    }
    return result;
  },captured);
  assert.ok(pixels.length>0,'Capture composited browser frames');
  assert.deepEqual(pixels.filter(frame=>frame.desktopPixels>10),[],'No composited frame may show the desktop layout');
  assert.deepEqual(errors,[]);await mkdir(root+'.test-artifacts',{recursive:true});await writeFile(root+'.test-artifacts/herdr-space-flash.json',JSON.stringify({viewport:{width:390,height:844},desktop:{cols:150,rows:45},cpu,wire:process.env.TEST_WIRE||'binary',redrawDelay:Number(process.env.TEST_REDRAW_DELAY||0),initialPaints,pixels,timings,returns},null,2));
  const sorted=timings.map(t=>t.ms).sort((a,b)=>a-b);console.log('PASS: '+timings.length+' real Herdr mobile space switches have no visible desktop layout; first visible mobile paint median '+sorted[Math.floor(sorted.length/2)].toFixed(1)+' ms, p95 '+sorted[Math.floor((sorted.length-1)*.95)].toFixed(1)+' ms.');
  console.log('PASS: '+returns.length+' returns to the top-level Herdr tab release and reacquire mobile geometry without desktop pixels ('+pixels.length+' composited frames).');
}catch(error) {
  console.error('Browser errors:',errors);
  for(const page of browser?.contexts()[0]?.pages()||[]) { console.error('Paints:',await page.evaluate(()=>({paints:window.__flashPaints,selected:document.querySelector('.herdr-agent-tab[aria-selected=true]')?.dataset.terminal,frames:[...document.querySelectorAll('.herdr-screen iframe')].map(frame=>({terminal:frame.dataset.terminal,class:frame.className,visibility:frame.style.visibility}))}))); for(const frame of page.frames()) console.error('Frame:',frame.url(),await frame.evaluate(()=>{const t=window.__terminal,b=t?.buffer.active;return{pending:document.querySelector('#terminal-viewport')?.className,parentClass:frameElement?.className,parentVisibility:frameElement&&getComputedStyle(frameElement).visibility,visible:frameElement?.checkVisibility({checkVisibilityCSS:true}),cols:t?.cols,rows:t?.rows,top:b?.viewportY,lines:b&&Array.from({length:8},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)),frames:window.__frames,signals:window.__layoutSignals,body:document.querySelector('#toast')?.textContent};}).catch(()=>({}))); }
  throw error;
}finally {
  await browser?.close();if(backend){const exited=once(backend,'exit');backend.kill();await exited;}
  const stopped=herdr&&herdr.exitCode===null&&herdr.signalCode===null?once(herdr,'exit'):null;
  desktop?.kill();await herdrRequest(target,'server.stop').catch(()=>{});herdr?.kill();await stopped;
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
