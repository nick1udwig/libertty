// Actual terminal repair transactions with delay injected on both legs of the browser/backend boundary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const root = new URL('../', import.meta.url).pathname;
const fixture = await mkdtemp(join(tmpdir(), 'termai-repair-network-'));
const port = Number(process.env.TEST_PORT || 3167), base = `http://127.0.0.1:${port}`;
const token = 'network-fixture-pairing-token-123456789';
await mkdir(join(fixture, 'docs'));
await writeFile(join(fixture, 'docs', 'my-notes.txt'), 'notes');
await writeFile(join(fixture, 'tool.py'), "import argparse\np=argparse.ArgumentParser()\np.add_argument('--output')\np.add_argument('--force', action='store_true')\n");
await writeFile(join(fixture, 'history'), 'git init\n');
const server = spawn(join(root, 'target/debug/termai'), [], { cwd: root, env: {
  ...process.env, HOME: fixture, HOST: '127.0.0.1', PORT: String(port), TERMAI_TOKEN: token,
  TERMAI_NO_RC: '1', TERMAI_CWD: fixture, TERMAI_DATA_DIR: join(fixture, 'data'),
  TERMAI_HISTORY_FILE: join(fixture, 'history'), TERMAI_ETERNAL_HISTORY_FILE: join(fixture, 'missing-history'),
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', socket;
server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    if (server.exitCode !== null) throw new Error(logs);
    await delay(25);
  }
  const auth = await fetch(base + '/api/connect', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(auth.status, 200, await auth.clone().text());
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  let state, inputRevision = 0;
  const pending = new Map();
  const sent = [];
  socket = new WebSocket(base.replace('http:', 'ws:') + '/ws?after=0', { headers: { Origin: base, Cookie: cookie } });
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'output') socket.send(JSON.stringify({ type: 'ack', seq: message.seq }));
    if (message.type === 'state') { state = message.state; inputRevision = Math.max(inputRevision, state.inputRevision); }
    if (message.type === 'repair-result') {
      const request = pending.get(message.id);
      if (!request) return;
      inputRevision = message.revision;
      setTimeout(() => { pending.delete(message.id); request.resolve(message); }, request.rtt / 2);
    }
  });
  await once(socket, 'open');
  for (let i = 0; i < 200 && !state?.ready; i++) await delay(25);
  assert.ok(state?.ready, 'Shell prompt available');
  const rows = [];
  for (const rtt of (process.env.REPAIR_RTT || '0,80,200').split(',').map(Number)) {
    for (const [name, text, expected] of [
      ['history', 'Get in it.', 'git init'],
      ['script', 'Python three tool dot py output VALUE force', 'python3 tool.py --output VALUE --force'],
      ['path', 'cat docs slash my notes dot txt', 'cat docs/my-notes.txt'],
      ['compound', 'Get status pipe Get diff', 'git status | git diff'],
      ['expression', 'echo dollar sign HOME', 'echo $HOME'],
    ]) {
      for (const trial of ['first', 'warm']) {
        const id = randomUUID(), start = performance.now(), before = sent.length;
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Repair timed out')); }, 12000);
          pending.set(id, { rtt, resolve: result => { clearTimeout(timer); resolve(result); } });
        });
        await delay(rtt / 2);
        const message = { type: 'repair', id, text, prompt: state.prompt, revision: inputRevision };
        sent.push(message); socket.send(JSON.stringify(message));
        const repaired = await result;
        assert.equal(repaired.accepted, true, JSON.stringify(repaired));
        assert.equal(repaired.selected, expected, JSON.stringify(repaired));
        assert.equal(repaired.original, text);
        assert.equal(sent.length - before, 1, 'One browser request includes repair, application, and acknowledgement');
        rows.push({ case: name, trial, rttMs: rtt, elapsedMs: +((performance.now() - start).toFixed(1)), requests: sent.length - before });
      }
    }
  }
  await mkdir(join(root, '.test-artifacts'), { recursive: true });
  await writeFile(join(root, '.test-artifacts', 'repair-network.json'), JSON.stringify(rows, null, 2) + '\n');
  console.table(rows);
  console.log('Every terminal repair used one request and retained the original transcript without submitting the line.');
} finally {
  socket?.terminate(); server.kill(); await rm(fixture, { recursive: true, force: true });
}
