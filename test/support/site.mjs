import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort, until } from './browser.mjs';

export async function previewSite(outDir = process.env.SITE_PREVIEW_DIR || 'dist-site') {
  const root = new URL('../../', import.meta.url).pathname;
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--config', 'site/vite.config.ts', '--outDir', outDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  server.stdout.on('data', chunk => logs.push(String(chunk)));
  server.stderr.on('data', chunk => logs.push(String(chunk)));
  const close = async () => {
    if (server.exitCode !== null) return;
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  };
  try {
    await until(async () => {
      if (server.exitCode !== null) throw new Error(logs.join(''));
      try { return (await fetch(origin)).ok; } catch { return false; }
    }, 'site preview');
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
