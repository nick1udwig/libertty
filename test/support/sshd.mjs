import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';

export function sshdPath() {
  const executable =
    process.env.TERMAI_TEST_SSHD || ['/usr/bin/sshd', '/usr/sbin/sshd'].find(existsSync);
  if (!executable || !existsSync(executable))
    throw new Error('Install OpenSSH server or set TERMAI_TEST_SSHD to its executable.');
  return executable;
}

export function sshFixturePath(prefix) {
  return [prefix, process.env.TERMAI_BASH && dirname(process.env.TERMAI_BASH), '/usr/bin', '/bin']
    .filter(Boolean)
    .join(':');
}

export async function sshdConfig(
  directory,
  port,
  { hostKey = 'host', pid = 'pid', env = {} } = {},
) {
  const environment = { HOME: directory + '/remote', PATH: sshFixturePath(), ...env };
  const config =
    [
      'Port ' + port,
      'ListenAddress 127.0.0.1',
      'HostKey ' + directory + '/' + hostKey,
      'PidFile ' + directory + '/' + pid,
      'AuthorizedKeysFile ' + directory + '/authorized',
      'StrictModes no',
      'UsePAM no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AllowUsers ' + os.userInfo().username,
      'SetEnv ' +
        Object.entries(environment)
          .map(([key, value]) => key + '=' + value)
          .join(' '),
      'Subsystem sftp internal-sftp',
    ].join('\n') + '\n';
  const file = directory + '/sshd_config';
  await writeFile(file, config);
  return file;
}
