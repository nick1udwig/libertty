import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';
import { LinkSchedule, LOSSY_PROFILE } from './support/lossy-link.mjs';

const peer = spawn(new URL('../target/release/examples/wire', import.meta.url).pathname, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = [], lines = createInterface({ input: peer.stdout });
lines.on('line', line => replies.shift()?.(JSON.parse(line)));
const encode = (value, mode) => new Promise(resolve => { replies.push(resolve); peer.stdin.write(JSON.stringify({ value, mode }) + '\n'); });
const variants = process.env.WIRE_VARIANTS?.split(',') || ['json', 'pmd-json', 'json-gzip', 'binary', 'gzip', 'gzip-fast'];
const profiles = [{ name: 'fast', rtt: 2, mbps: 100, cpu: 1 }, { name: 'mobile', rtt: 150, mbps: 1, cpu: 6 }, LOSSY_PROFILE].filter(p => !process.env.WIRE_PROFILES || process.env.WIRE_PROFILES.split(',').includes(p.name));
const samples = Number(process.env.WIRE_SAMPLES || 15);
const payloads = {
  typing: { type: 'output', seq: 1, data: 'hello 世界\r\n' },
  logs: { type: 'output', seq: 1, data: ('INFO completed task こんにちは\r\n').repeat(2000) },
  ansi: { type: 'herdr-frame', seq: 1, width: 80, height: 40, full: true, bytes: Buffer.from(('\x1b[2;1H\x1b[32mStatus: running こんにちは\x1b[0m').repeat(600)).toString('base64') },
  random: { type: 'herdr-frame', seq: 1, width: 80, height: 40, full: true, bytes: randomBytes(64 * 1024).toString('base64') },
  metadata: { type: 'snapshot', snapshot: { agents: Array.from({ length: 100 }, (_, i) => ({ terminalId: 'term_' + i, name: 'Agent ' + i, workspace: 'Workspace', status: 'working', cwd: '/fixture/project' })) } },
  plugin: { type: 'file', path: '/fixture/application.log', text: 'Application event: completed\n'.repeat(8000) },
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const wire = stripTypeScriptTypes(await readFile(new URL('../src/wire.ts', import.meta.url), 'utf8'));
const stats = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/wire.js') { res.setHeader('content-type', 'application/javascript'); res.end(wire); }
  else if (req.url?.startsWith('/stats/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(stats.get(req.url.slice(7)))); }
  else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><pre id="render"></pre>'); }
});
const plain = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const pmd = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 2048, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 1 } } });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost'), profile = profiles.find(p => p.name === url.searchParams.get('profile'));
  if (!profile) { socket.destroy(); return; }
  const selected = url.pathname === '/pmd-json' ? pmd : plain;
  selected.handleUpgrade(req, socket, head, ws => {
    const original = ws._socket.write.bind(ws._socket), link = new LinkSchedule(profile);
    ws._socket.write = (chunk, encoding, callback) => {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      const arrival = link.write(Buffer.byteLength(chunk), performance.now());
      setTimeout(() => original(chunk, encoding, callback), Math.max(0, arrival - performance.now()));
      return true;
    };
    let lastRead = ws._socket.bytesRead;
    ws.on('message', async (data, binary) => {
      const logical = binary ? { type: 'input', data: new TextDecoder().decode(data.subarray(4)) } : JSON.parse(String(data));
      const request = JSON.parse(logical.data), value = payloads[request.case], upstream = ws._socket.bytesRead - lastRead;
      link.request(request.case);
      lastRead = ws._socket.bytesRead;
      await new Promise(resolve => setTimeout(resolve, profile.rtt / 2));
      const before = ws._socket.bytesWritten, begin = performance.now();
      const reply = await encode(value, request.variant === 'pmd-json' ? 'json' : request.variant);
      const encodeAndIpcMs = performance.now() - begin;
      const bytes = Buffer.from(reply.bytes, 'base64');
      const losses = link.losses, stalls = link.stalls;
      ws.send(reply.binary ? bytes : bytes.toString(), { binary: reply.binary, compress: true }, error => {
        if (error) return;
        stats.set(request.id, { upstream, downstream: ws._socket.bytesWritten - before, logical: Buffer.byteLength(JSON.stringify(value)), encoded: reply.length, nativeEncodeMs: reply.encodeMs, encodeAndIpcMs, losses: link.losses - losses, stalls: link.stalls - stalls });
      });
    });
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const rows = [];
  for (const profile of profiles) {
    const page = await browser.newPage(); await page.goto(origin);
    const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
    for (const variant of variants) {
      const result = await page.evaluate(async ({ profile, variant, cases, samples }) => {
        const { decodeWire, encodeWire } = await import('/wire.js');
        const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/' + variant + '?profile=' + profile.name); socket.binaryType = 'arraybuffer';
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        const measured = []; let next;
        socket.onmessage = async event => {
          const begin = performance.now(), value = await decodeWire(event.data), decoded = performance.now() - begin;
          const item = next; next = undefined;
          document.querySelector('#render').textContent = value.type === 'output' ? value.data : value.type === 'herdr-frame' ? String(value.width) + ':' + String(value.height) : JSON.stringify(value);
          await new Promise(requestAnimationFrame);
          const ms = performance.now() - item.start;
          let normalized = value;
          if (value.type === 'herdr-frame' && typeof value.bytes !== 'string') { let raw = ''; for (let i=0;i<value.bytes.length;i+=8192) raw += String.fromCharCode(...value.bytes.subarray(i,i+8192)); normalized = { ...value, bytes: btoa(raw) }; }
          const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(normalized))));
          const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
          item.resolve({ ms, hash, decodeMs: decoded, type: value.type, size: value.type === 'herdr-frame' ? typeof value.bytes === 'string' ? atob(value.bytes).length : value.bytes.length : undefined });
        };
        for (const name of cases) {
          for (let i = 0; i <= samples; i++) {
            const id = profile.name + '/' + variant + '/' + name + '/' + i;
            const result = await new Promise(resolve => { next = { resolve, start: performance.now() }; socket.send(encodeWire({ type: 'input', data: JSON.stringify({ id, case: name, variant }) }, ['binary', 'gzip', 'gzip-fast'].includes(variant) ? 'libertty.binary.v1' : '')); });
            let metrics; for (let attempt = 0; attempt < 20; attempt++) { metrics = await (await fetch('/stats/' + id)).json(); if (metrics) break; await new Promise(resolve => setTimeout(resolve, 5)); }
            measured.push({ case: name, cold: i === 0, ...result, ...metrics });
          }
        }
        socket.close(); return measured;
      }, { profile, variant, cases: Object.keys(payloads), samples });
      for (const name of Object.keys(payloads)) {
        const all = result.filter(r => r.case === name), warm = all.filter(r => !r.cold);
        const quantile = (key, p) => warm.map(r => r[key]).sort((a, b) => a - b)[Math.min(warm.length - 1, Math.floor(warm.length * p))];
        const expectedHash = createHash('sha256').update(JSON.stringify(canonical(payloads[name]))).digest('hex');
        for (const sample of all) assert.equal(sample.hash, expectedHash);
        assert.equal(warm[0].type, payloads[name].type);
        if (payloads[name].bytes) assert.equal(warm[0].size, Buffer.from(payloads[name].bytes, 'base64').length);
        const row = { profile: profile.name, variant, case: name, coldMs: all[0].ms, medianMs: quantile('ms', .5), p95Ms: quantile('ms', .95), encodeMs: quantile('nativeEncodeMs', .5), decodeMs: quantile('decodeMs', .5), upstreamBytes: quantile('upstream', .5), downstreamBytes: quantile('downstream', .5), losses: all.reduce((sum, sample) => sum + sample.losses, 0), stalls: all.reduce((sum, sample) => sum + sample.stalls, 0), samples: warm };
        rows.push(row); console.log(JSON.stringify({ ...row, samples: undefined }));
      }
    }
    await page.close();
  }
  await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.test-artifacts/' + (process.env.WIRE_OUTPUT || 'transport-experiments.json'), import.meta.url), JSON.stringify({ samples, profiles, node: process.version, browser: browser.version(), measurement: 'Actual unencrypted WebSocket TCP bytes after handshake; native encoding plus IPC, paced transfer, browser decode and DOM render; CPU throttle affects browser script, not all native browser work.', process: process.memoryUsage(), rows }, null, 2));
} finally {
  await browser?.close(); plain.close(); pmd.close(); server.close(); peer.stdin.end(); await once(peer, 'exit'); lines.close();
}
