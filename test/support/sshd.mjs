import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function sshdPath() {
  const executable = process.env.TERMAI_TEST_SSHD || ['/usr/bin/sshd', '/usr/sbin/sshd'].find(existsSync);
  if (!executable || !existsSync(executable)) throw new Error('Install OpenSSH server or set TERMAI_TEST_SSHD to its executable.');
  return executable;
}

export function sshFixturePath(prefix) {
  return [prefix, process.env.TERMAI_BASH && dirname(process.env.TERMAI_BASH), '/usr/bin', '/bin'].filter(Boolean).join(':');
}
