import { createHash } from 'node:crypto';

/** Independent OpenSSH fingerprint oracle for synthetic browser/SSH fixtures. */
export const fingerprint = (key: Buffer) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
