import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { build } from 'vite';
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
