import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { externalWasm, terminalPreloads } from '../build/assets.ts';

// The site runs the real workspace and terminal documents against an in-page backend, with the landing page around them.
const root = path.resolve(import.meta.dirname, '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Snapshot the tracked repository so the demo shell, files and reader browse the real project. */
function repository(): Plugin {
  const id = 'virtual:libertty-repo', resolved = '\0' + id;
  const files = git('ls-files', '-s', '-z').split('\0').filter(Boolean).map(line => {
    const [meta, name] = line.split('\t'), mode = parseInt(meta.split(' ')[0], 8);
    return { name, mode, size: readFileSync(path.join(root, name)).length };
  });
  const log = git('log', '-n', '60', '--format=%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e').split('\x1e').map(entry => entry.trim()).filter(Boolean)
    .map(entry => { const [hash, author, date, subject, body] = entry.split('\x1f'); return { hash, author, date, subject, body: body.trim() }; });
  const modified = Date.parse(log[0]?.date || '') || Date.now();
  return {
    name: 'libertty-site-repository',
    resolveId: source => source === id ? resolved : undefined,
    load(source) {
      if (source !== resolved) return;
      return `export const files = ${JSON.stringify(files)};\nexport const log = ${JSON.stringify(log)};\nexport const modified = ${modified};\nexport const branch = 'master';`;
    },
    configureServer(server) {
      server.middlewares.use('/repo/', (request, response, next) => {
        const name = decodeURIComponent((request.url || '').split('?')[0].replace(/^\//, ''));
        if (!files.some(file => file.name === name)) return next();
        response.end(readFileSync(path.join(root, name)));
      });
    },
    // Copied after bundling, so the snapshot never mixes with the app's own preloaded assets.
    closeBundle() {
      for (const file of files) { const target = path.join(root, 'dist-site/repo', file.name); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(root, file.name), target); }
    },
  };
}

/** Build the engine's WebAssembly adapter, which the demo uses for repairs and dictation alternatives. */
function engine(): Plugin {
  const id = 'virtual:libertty-engine', resolved = '\0' + id;
  const wasm = path.join(root, 'target/wasm32-unknown-unknown/release/libertty_engine_wasm.wasm');
  return {
    name: 'libertty-site-engine',
    buildStart() { execFileSync('cargo', ['build', '--locked', '--release', '-p', 'libertty-engine-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' }); },
    resolveId: source => source === id ? resolved : undefined,
    load(source) {
      if (source !== resolved) return;
      if (this.meta.watchMode) return `export default ${JSON.stringify('/@fs' + wasm)};`;
      const reference = this.emitFile({ type: 'asset', name: 'libertty-engine.wasm', source: readFileSync(wasm) });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}

/** Boot the app documents through the demo entries, which install the in-page backend before the real modules run. */
function demoEntries(base: string): Plugin {
  return {
    name: 'libertty-site-entries',
    // During development the landing page is served at / and the workspace at /app.html, as in the build.
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const [route, query = ''] = (request.url || '').split('?');
        if (route === '/' || route === '/index.html') request.url = '/site/index.html' + (query && '?' + query);
        else if (route === '/app.html') request.url = '/index.html' + (query && '?' + query);
        next();
      });
    },
    transformIndexHtml: { order: 'pre', handler(html, context) {
      const page = path.relative(root, context.filename);
      const entry = page === 'index.html' ? 'app' : page === 'terminal.html' ? 'terminal' : undefined;
      if (!entry) return;
      return html.replace('<base href="/" data-libertty-base>', `<base href="${base}" data-libertty-base>`)
        .replace(/src="\/src\/(main|terminal)\.ts"/, `src="/site/demo/${entry}.ts"`);
    } },
    closeBundle() {
      const out = path.join(root, 'dist-site');
      // The landing page is the site's front door, and the workspace document becomes app.html beside it.
      renameSync(path.join(out, 'index.html'), path.join(out, 'app.html'));
      writeFileSync(path.join(out, 'index.html'), readFileSync(path.join(out, 'site/index.html'), 'utf8').replaceAll('="../', '="./'));
      // Service workers would cache a backend that does not exist here.
      for (const name of ['site', 'sw.js', 'push-sw.js']) rmSync(path.join(out, name), { recursive: true, force: true });
    },
  };
}

export default defineConfig(({ command }) => ({
  root, base: './',
  build: { outDir: 'dist-site', emptyOutDir: true, target: 'es2022', rolldownOptions: { input: { site: 'site/index.html', app: 'index.html', terminal: 'terminal.html' } } },
  optimizeDeps: { exclude: ['ghostty-web'] },
  server: { port: 5180, fs: { allow: [root] } },
  plugins: [demoEntries(command === 'serve' ? '/' : process.env.LIBERTTY_SITE_BASE || '/'), repository(), engine(), externalWasm(), terminalPreloads()],
}));
