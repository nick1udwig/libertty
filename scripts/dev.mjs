#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createServer } from 'vite';
import { verifyBuildManifest } from './ci-build.mjs';

const root = path.resolve(import.meta.dirname, '..');
let child, vite, stopping = false;
async function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit'); child.kill(signal); await exit;
  }
  await vite?.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(signal));
async function build(command, args) {
  child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  if (stopping) process.exit(0);
  if (code !== 0) throw new Error(`${command} failed: ${signal || code}`);
}
try {
  if (process.env.TERMAI_DEV_BUILD_MANIFEST) {
    await verifyBuildManifest(root, 'browser', path.resolve(process.env.TERMAI_DEV_BUILD_MANIFEST));
  } else {
    await build(process.execPath, ['scripts/build-rust-engine.mjs']);
    await build('cargo', ['build', '--locked', '-p', 'termai-server', '--bin', 'termai']);
  }
  const segments = (process.env.TERMAI_BASE_PATH || '').split('/').filter(Boolean);
  if (segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) throw Error('Invalid TERMAI_BASE_PATH.');
  const base = '/' + (segments.length ? segments.join('/') + '/' : '');
  vite = await createServer({ root, base, server: { host: '127.0.0.1', port: 0, strictPort: false,
    hmr: { clientPort: Number(process.env.PORT || 3000) } }, appType: 'spa', plugins: [
      { name: 'termai-runtime-base', transformIndexHtml: html => html.replace('<base href="/" data-termai-base>', `<base href="${base}" data-termai-base>`) },
    ] });
  await vite.listen();
  const address = vite.httpServer.address();
  child = spawn(path.join(root, 'target/debug/termai'), [], { cwd: root, stdio: 'inherit', env: {
    ...process.env, NODE_ENV: 'development', TERMAI_DEV_FRONTEND: `http://127.0.0.1:${address.port}`,
  } });
  const [code, signal] = await once(child, 'exit');
  await stop();
  process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
} catch (error) {
  console.error(error); await stop(); process.exitCode = 1;
}
