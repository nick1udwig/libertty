import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function documentationFiles(files) {
  return files.length > 0 && files.every(file => /\.md$/i.test(file) || /^docs\/.*\.(?:txt|rst|adoc|png|jpe?g|gif|svg|webp|pdf)$/i.test(file));
}

export function documentationOnly(base, { cwd = path.resolve(import.meta.dirname, '..') } = {}) {
  if (!/^[a-f\d]{40,64}$/i.test(base || '') || /^0+$/.test(base)) return false;
  const files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return documentationFiles(files.split('\0').filter(Boolean));
}
