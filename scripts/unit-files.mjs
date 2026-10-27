import { quickTests } from './quick-tests.mjs';

const installers = new Set(['install.test.mjs', 'setup-integrations.test.mjs']);
const quick = new Set(quickTests);
export function unitTestFiles(files, quickDone = false) {
  return files.filter(file => /\.test\.(?:ts|mjs)$/.test(file) && !installers.has(file) && (!quickDone || !quick.has(file))).sort();
}
