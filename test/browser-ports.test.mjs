import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { browserPortRange, freePort } from '../scripts/browser-ports.mjs';

test('browser workers have distinct ranges below the Linux ephemeral range', () => {
  assert.equal(browserPortRange(0), '10000-10127');
  assert.equal(browserPortRange(1), '10128-10255');
  for (const worker of [-1, 0.5, 177, NaN]) assert.throws(() => browserPortRange(worker));
});

test('port allocation skips occupied and previously issued ports', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const occupied = server.address().port;
  try {
    await assert.rejects(freePort(occupied + '-' + occupied), /No free fixture ports/);
    const range = Math.max(1024, occupied - 100) + '-' + occupied;
    const first = await freePort(range), second = await freePort(range);
    assert.notEqual(first, occupied);
    assert.notEqual(second, occupied);
    assert.notEqual(first, second);
  } finally { await new Promise(resolve => server.close(resolve)); }
  for (const range of ['invalid', '0-100', '2000-1000', '65535-65536']) await assert.rejects(freePort(range), /Invalid TEST_PORT_RANGE/);
});

test('parallel harness processes cannot allocate the same fixture port', async () => {
  const run = promisify(execFile), module = new URL('../scripts/browser-ports.mjs', import.meta.url).href;
  const source = `import { freePort } from ${JSON.stringify(module)}; const ports = []; for (let i = 0; i < 8; i++) ports.push(await freePort()); console.log(JSON.stringify(ports));`;
  const results = await Promise.all([0, 1].map(worker => run(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TEST_PORT_RANGE: browserPortRange(worker) } })));
  const ports = results.flatMap(result => JSON.parse(result.stdout));
  assert.equal(new Set(ports).size, 16);
  assert.ok(ports.every(port => port >= 10000 && port < 32768));
});
