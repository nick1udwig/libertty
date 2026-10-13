import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendURL, sshAddress } from '../src/connections.ts';

test('connection addresses reject embedded credentials, unsupported schemes and invalid SSH destinations', () => {
  assert.equal(backendURL('https://host/t'), 'https://host/t/');
  for (const url of ['javascript:alert(1)', 'https://user:password@host/', 'https://host/?token=secret']) assert.throws(() => backendURL(url));
  assert.deepEqual(sshAddress({ host: '::1', username: 'nick' }), { host: '::1', username: 'nick', port: 22 });
  assert.throws(() => sshAddress({ host: 'host; touch /tmp/no', username: 'nick' }));
  assert.throws(() => sshAddress({ host: 'host', username: 'nick', port: 0 }));
});
