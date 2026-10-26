import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { installLossyLink } from './support/lossy-link.mjs';
import { decodeWire } from '../src/wire.ts';

/** Browser harnesses inspect the same logical messages on either transport. */
export async function installWireObserver(context) {
  const delay = Number(process.env.TEST_SHELL_DELAY_MS || 0);
  if (delay > 0) await context.routeWebSocket(url => url.pathname.endsWith('/ws'), socket => {
    const server = socket.connectToServer();
    let pending = Promise.resolve(), closed = false;
    socket.onClose((code, reason) => { closed = true; void server.close({ code, reason }); });
    server.onClose((code, reason) => { closed = true; void socket.close({ code, reason }); });
    server.onMessage(data => {
      pending = pending.then(async () => {
        if (closed) return;
        const message = await decodeWire(data);
        if (message.type === 'state' && message.state.ready || message.type === 'input-line') await new Promise(resolve => setTimeout(resolve, delay));
        if (!closed) socket.send(data);
      }).catch(error => { console.error(error); closed = true; void socket.close({ code: 1011, reason: 'Shell delay failed' }); });
    });
  });
  if (process.env.TEST_LINK === 'lossy') await installLossyLink(context);
  const source = stripTypeScriptTypes(await readFile(new URL('../src/wire.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
  if (process.env.TEST_WIRE === 'gzip') await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { effectiveType: '3g', downlink: 1 } }));
  await context.addInitScript({ content: '(() => {' + source + String.raw`
    const pending = new WeakMap(), histories = new WeakMap(), outputTails = new Map(), connections = new WeakMap();
    let connection = 0, observed = Promise.resolve();
    const shellKey = socket => {
      const url = new URL(socket.url);
      return JSON.stringify([url.origin, url.pathname, url.searchParams.get('session') || 'default', url.searchParams.get('herdrTerminal')]);
    };
    const observe = (value, owner) => {
      if ((connections.get(owner) || 0) < (connections.get(window.__testShellSocket) || 0)) return;
      if (value.type === 'state') {
        const sameShell = window.__testShellSocket && shellKey(window.__testShellSocket) === shellKey(owner);
        if (!sameShell || window.__testShellState?.prompt !== value.state.prompt || !value.state.ready) window.__testReadlineReady = false;
        window.__testShellState = value.state;
        window.__testShellSocket = owner;
      }
      if (value.type === 'output' && owner === window.__testShellSocket) {
        const key = shellKey(owner), text = (outputTails.get(key) || '') + value.data;
        for (const match of text.matchAll(/\x1b\[\?2004([hl])/g)) window.__testReadlineReady = match[1] === 'h';
        outputTails.set(key, text.slice(-7));
      }
    };
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        connections.set(this, ++connection);
        this.addEventListener('message', event => {
          observed = observed.catch(() => {}).then(() => decodeWire(event.data)).then(value => observe(value, this));
        });
      }
    };
    window.__wireMessage = (data, owner) => {
      const previous = owner ? pending.get(owner) || Promise.resolve() : Promise.resolve();
      const next = previous.then(async () => {
        let value = await decodeWire(data);
        if (owner && value.type === 'screen') histories.set(owner, value);
        else if (owner && value.type === 'screen-delta') {
          const previous = histories.get(owner);
          if (previous?.version === value.base) {
            value = { ...value, type: 'screen', text: previous.text.slice(value.drop, value.drop + value.from) + value.text + (value.tail ? previous.text.slice(-value.tail) : ''), delta: true };
            histories.set(owner, value);
          }
        }
        if (value.type === 'herdr-frame' && typeof value.bytes !== 'string') {
          let text = ''; for (let i=0;i<value.bytes.length;i+=8192) text += String.fromCharCode(...value.bytes.subarray(i,i+8192));
          value.bytes=btoa(text);
        }
        return value;
      });
      if (owner) pending.set(owner,next.catch(() => {}));
      return next;
    };
    window.__wireSent = data => {
      if (typeof data === 'string') return JSON.parse(data);
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (!bytes || bytes[0]!==84 || bytes[1]!==77 || bytes[2]!==1) return { type:'audio' };
      const body=bytes.subarray(4), view=new DataView(body.buffer,body.byteOffset,body.byteLength);
      if (bytes[3]===3) return { type:'input',data:new TextDecoder().decode(body) };
      if (bytes[3]===8) return { type:'input',seq:view.getFloat64(0,true),data:new TextDecoder().decode(body.subarray(8)) };
      if (bytes[3]===4) return { type:'ack',seq:view.getFloat64(0,true) };
      if (bytes[3]===5) return { type:'resize',cols:view.getUint16(0,true),rows:view.getUint16(2,true),...(body[4]<2?{mobile:body[4]===1}:{}) };
      return { type:'audio' };
    };
  })();` });
}
