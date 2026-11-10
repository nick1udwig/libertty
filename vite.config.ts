import { defineConfig } from 'vite';
import { compressedAssets, appShell, terminalPreloads } from './build/assets.ts';
import { exactUI } from './build/exact.ts';
export default defineConfig({
  base: './', build: { target: 'es2022', assetsInlineLimit: file => file.endsWith('.wasm') ? false : undefined, rolldownOptions: { input: { app: 'index.html', terminal: 'terminal.html' } } },
  plugins: [exactUI(), terminalPreloads(), compressedAssets(), appShell()],
});
