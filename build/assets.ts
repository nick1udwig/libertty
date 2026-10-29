import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export function compressedAssets(): Plugin {
  return {
    name: 'libertty-compressed-assets',
    generateBundle: { order: 'post', handler(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (!/\.(?:js|css|wasm|svg)$/.test(output.fileName)) continue;
        const source = output.type === 'chunk' ? output.code : output.source;
        const bytes = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source);
        if (bytes.length < 1024) continue;
        for (const [suffix, compress] of [['gz', gzipSync], ['br', brotliCompressSync]] as const) {
          const compressed = compress(bytes);
          if (compressed.length < bytes.length) this.emitFile({ type: 'asset', fileName: `${output.fileName}.${suffix}`, source: compressed });
        }
      }
    } },
  };
}
export function appShell(): Plugin {
  let publicDir = '', root = '';
  return {
    name: 'libertty-app-shell',
    configResolved(config) { publicDir = config.publicDir; root = config.root; },
    generateBundle: { order: 'post', handler(_, bundle) {
      const files = Object.keys(bundle).filter(name => !/\.(?:gz|br|map)$/.test(name)).sort();
      const hash = createHash('sha256');
      for (const name of files) {
        const output = bundle[name];
        hash.update(name).update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const name of ['sw.js', 'push-sw.js', 'icon.svg', 'manifest.webmanifest']) hash.update(readFileSync(path.join(publicDir, name)));
      hash.update(readFileSync(path.join(root, 'index.html')));
      const assets = ['', 'terminal.html', 'icon.svg', 'manifest.webmanifest', ...files.filter(name => name.startsWith('assets/'))];
      const source = readFileSync(path.join(publicDir, 'sw.js'), 'utf8')
        .replace('__LIBERTTY_BUILD__', hash.digest('hex').slice(0, 20))
        .replace(/\/\*__LIBERTTY_ASSETS__\*\/\s*\[[^\]]*\]/, JSON.stringify(assets));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    } },
  };
}

/** Start terminal downloads with the workspace document, before its iframe mounts. */
export function terminalPreloads(): Plugin {
  return {
    name: 'libertty-terminal-preloads',
    transformIndexHtml: { order: 'post', handler(_html, context) {
      if (!context.bundle || context.path !== '/index.html') return;
      return Object.values(context.bundle).flatMap(output => {
        const href = './' + output.fileName;
        if (output.type === 'chunk' && output.name === 'terminal') return [{ tag: 'link', attrs: { rel: 'modulepreload', href, crossorigin: '' } }];
        const as = output.fileName.endsWith('.wasm') ? 'fetch' : output.fileName.endsWith('.woff2') ? 'font' : /^assets\/terminal-.*\.css$/.test(output.fileName) ? 'style' : undefined;
        return as ? [{ tag: 'link', attrs: { rel: 'preload', href, as, crossorigin: '' } }] : [];
      });
    } },
  };
}
