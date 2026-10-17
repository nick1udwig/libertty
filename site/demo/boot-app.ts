import { applyTheme } from '../../src/theme.ts';
import { createServer } from './server.ts';
import { install } from './shim.ts';
import { repo } from './vfs.ts';

/** Each visit starts fresh: four tabs on one host, in the theme the visitor's system asks for. */
const dark = matchMedia('(prefers-color-scheme: dark)');
const reader = new URLSearchParams(location.search).get('layout') === 'phone';
const save = (key: string, value: unknown) => localStorage.setItem('libertty.' + key, JSON.stringify(value));
try {
  for (const key of Object.keys(localStorage)) if (key.startsWith('libertty.') || key.startsWith('termai.')) localStorage.removeItem(key);
  const shell = crypto.randomUUID(), common = { backendId: 'primary', hostId: 'local', lastUsed: Date.now(), pluginVersion: '1' };
  const tabs: object[] = [
    { ...common, id: crypto.randomUUID(), name: 'monticello', session: shell, pluginId: 'terminal', ownsSession: true },
    { ...common, id: crypto.randomUUID(), name: 'Herdr · monticello', session: crypto.randomUUID(), pluginId: 'herdr', mode: 'herdr', herdrSession: '' },
    { ...common, id: crypto.randomUUID(), name: 'Files · monticello', session: crypto.randomUUID(), pluginId: 'files', mode: 'files', ownsSession: true, directory: repo },
  ];
  // Phones open on a welcome page, since the landing page around the phone is not there to introduce the project.
  const read = (file: string) => ({ ...common, id: crypto.randomUUID(), name: file.split('/').pop()!, session: shell, pluginId: 'reading', ownsSession: false, readPath: repo + '/' + file });
  if (reader) tabs.unshift(read('site/welcome.md')); else tabs.push(read('README.md'));
  save('hosts', [{ id: 'local', name: 'monticello', kind: 'http', backendId: 'primary' }]);
  save('tabs', tabs); save('activeTab', (tabs[0] as { id: string }).id);
  save('theme', dark.matches ? '1776' : 'flag');
  // Herdr opens the libertty repository on the 1776 theme worktree, where an agent is waiting for approval.
  save('herdr.' + new URL('.', document.baseURI).href + '##', { order: [], repoSpaces: { 'repo:libertty': 'w-1776' } });
} catch { /* Without storage the app opens its default terminal. */ }
dark.addEventListener('change', () => { try { save('theme', dark.matches ? '1776' : 'flag'); applyTheme(); } catch { /* Keep the current theme. */ } });

// The site has no service worker, since there is no backend to cache for offline use.
if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('Background notifications are off in the demo.'));
const server = createServer();
(window as unknown as { liberttyDemo: typeof server }).liberttyDemo = server;
install(window, server);
