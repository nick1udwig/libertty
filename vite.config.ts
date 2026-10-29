import { defineConfig } from 'vite';
import { compressedAssets, appShell, terminalPreloads } from './build/assets.ts';
export default defineConfig({
  base: './', build: { target: 'es2022', assetsInlineLimit: file => file.endsWith('.wasm') ? false : undefined, rolldownOptions: { input: { app: 'index.html', terminal: 'terminal.html' } } },
  optimizeDeps: { exclude: ['@gespenst/core'] },
  plugins: [terminalPreloads(), compressedAssets(), appShell()],
});
