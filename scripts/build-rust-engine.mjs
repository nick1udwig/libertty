import { spawn } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = ['build', '--locked', '--release', '--package', 'termai-engine', '--lib', '--target', 'wasm32-unknown-unknown'];
const child = spawn('cargo', args, { cwd: root, stdio: 'inherit' });
await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('Rust WebAssembly build failed: ' + code)));
});
await mkdir(path.join(root, 'src/engine'), { recursive: true });
await copyFile(path.join(root, 'target/wasm32-unknown-unknown/release/termai_engine.wasm'), path.join(root, 'src/engine/termai-engine.wasm'));
