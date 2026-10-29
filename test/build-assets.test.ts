import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import config from '../vite.config.ts';
import { compressedAssets } from '../build/assets.ts';

test('compressed production chunks contain finalized dynamic-import preload code', async () => {
  const directory = await mkdtemp('/tmp/libertty-bundle-');
  try {
    await writeFile(directory + '/index.html', '<script type="module" src="./main.js"></script>');
    await writeFile(directory + '/main.js', 'document.onclick = () => import("./lazy.js").then(m => m.run());\n' + 'console.log("bundle padding");\n'.repeat(100));
    await writeFile(directory + '/lazy.js', 'import "./lazy.css"; export function run() { document.body.textContent = "loaded"; }');
    await writeFile(directory + '/lazy.css', 'body { background: green; }');
    const result = await build({ root: directory, configFile: false, logLevel: 'silent', plugins: [compressedAssets()], build: { write: false, minify: false } });
    assert.ok(!Array.isArray(result) && 'output' in result);
    const outputs = result.output, chunks = outputs.filter(output => output.type === 'chunk');
    let checked = 0;
    for (const chunk of chunks) {
      for (const [suffix, decode] of [['br', brotliDecompressSync], ['gz', gunzipSync]] as const) {
        const compressed = outputs.find(output => output.fileName === chunk.fileName + '.' + suffix);
        if (!compressed || compressed.type !== 'asset') continue;
        assert.equal(decode(Buffer.from(compressed.source)).toString(), chunk.code, 'encoded variant must match the finalized JavaScript');
        assert.ok(!chunk.code.includes('__VITE_PRELOAD__')); ++checked;
      }
    }
    assert.ok(checked >= 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Gespenst ships Ghostty and callback WASM assets with workspace preloads and offline caching', async () => {
  const directory = await mkdtemp('/tmp/libertty-wasm-bundle-');
  try {
    await writeFile(directory + '/index.html', '<script type="module" src="./main.js"></script>');
    await writeFile(directory + '/main.js', 'document.title = "Workspace";');
    await writeFile(directory + '/terminal.html', '<script type="module" src="./terminal.js"></script>');
    await writeFile(directory + '/terminal.js', `import { createCoreRuntime } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@gespenst/core/headless')))}; globalThis.createCoreRuntime = createCoreRuntime;`);
    const result = await build({
      ...config, root: directory, publicDir: fileURLToPath(new URL('../public', import.meta.url)), configFile: false, logLevel: 'silent',
      build: { ...config.build, write: false, rolldownOptions: { input: { app: directory + '/index.html', terminal: directory + '/terminal.html' } } },
    });
    assert.ok(!Array.isArray(result) && 'output' in result);
    const outputs = result.output;
    const html = outputs.find(output => output.fileName === 'index.html');
    const worker = outputs.find(output => output.fileName === 'sw.js');
    assert.ok(html?.type === 'asset' && worker?.type === 'asset');
    for (const name of ['ghostty-vt', 'ghostty-callbacks']) {
      const emitted = outputs.filter(output => output.fileName.startsWith(`assets/${name}-`) && output.fileName.endsWith('.wasm'));
      assert.equal(emitted.length, 1, `${name} is emitted once instead of inlined`);
      const wasm = emitted[0];
      assert.ok(wasm.type === 'asset');
      assert.deepEqual(Buffer.from(wasm.source), await readFile(new URL(`../node_modules/@gespenst/core/dist/${name}.wasm`, import.meta.url)));
      assert.ok(String(html.source).includes(`href="./${wasm.fileName}"`), `${name} starts loading with the workspace`);
      assert.ok(String(worker.source).includes(JSON.stringify(wasm.fileName)), `${name} is available offline`);
      if (name === 'ghostty-vt') {
        assert.deepEqual(WebAssembly.Module.imports(await WebAssembly.compile(Buffer.from(wasm.source))), [], 'The official Ghostty module has no imports');
        for (const [suffix, decode] of [['br', brotliDecompressSync], ['gz', gunzipSync]] as const) {
          const compressed: (typeof outputs)[number] | undefined = outputs.find(output => output.fileName === wasm.fileName + '.' + suffix);
          assert.ok(compressed?.type === 'asset');
          assert.deepEqual(decode(Buffer.from(compressed.source)), Buffer.from(wasm.source));
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
