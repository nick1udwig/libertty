import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

export function exactUI(): Plugin {
  let root = '';
  return {
    name: 'libertty-exact-ui',
    configResolved(config) { root = config.root; },
    async handleHotUpdate(context) {
      if (!context.file.startsWith(path.join(root, 'ui') + path.sep)) return;
      await promisify(execFile)(process.execPath, ['scripts/build-exact.mjs'], { cwd: root });
      context.server.moduleGraph.invalidateAll();
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
