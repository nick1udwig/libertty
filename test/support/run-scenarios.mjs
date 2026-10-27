import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { browserGroups } from '../../scripts/browser-groups.mjs';

export function runScenarios(suite) {
  if (!browserGroups[suite]) throw new Error('Unknown browser suite: ' + suite);
  for (const file of browserGroups[suite]) {
    const env = { ...process.env };
    if (env.TEST_DIAGNOSTICS_DIR) env.TEST_DIAGNOSTICS_DIR = path.join(env.TEST_DIAGNOSTICS_DIR, file.replace(/\.mjs$/, ''));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../' + file, import.meta.url))], { stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
}
