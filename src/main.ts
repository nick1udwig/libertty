import './workspace.css';
import { backendAccess, rememberBackendAccess, forgetBackendAccess } from './backend-access.ts';
import { BrowserVault } from './browser-vault.ts';
import type { BrowserKeyInfo } from './browser-key.ts';
import { defaults, validateShortcuts } from './shortcuts.ts';
import { shortcutEditor } from './shortcut-editor.ts';
import { readingPhrases, defaultReadingPhrases } from './reading-request.ts';
import { readingMessage } from './reading-view.ts';
import { herdrName, herdrSession } from './herdr-protocol.ts';
import { HerdrSounds } from './herdr-sounds.ts';
import { HerdrNotifications } from './herdr-notifications.ts';
import { tabGestures } from './tab-gestures.ts';
import { BUILTIN_VERSION, PluginRegistry, migratePluginTab, migrateReadingTab, tabPluginId, type PluginView } from './plugins.ts';
import { builtinPlugins } from './builtin-plugins.ts';
import { externalPlugin } from './external-plugin.ts';
import { parsePluginPackage, MAX_PLUGIN_BYTES, type PluginPackage, type InstalledPlugin } from './plugin-package.ts';
import type { HerdrView } from './herdr-view.ts';
import { backendURL, sshAddress, type BackendProfile, type HostProfile, type TerminalTab, type LegacyReadingTab, type KeyInfo, type KnownHost, type SSHConnection } from './connections.ts';
const browserVault = new BrowserVault();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const dialog = (id: string) => $<HTMLDialogElement>(id);
const primary: BackendProfile = { id: 'primary', name: 'Primary backend', url: new URL('.', document.baseURI).href };
function saved<T>(key: string, fallback: T): T { try { const value = JSON.parse(localStorage.getItem('termai.' + key) || 'null'); return value === null || (Array.isArray(fallback) ? !Array.isArray(value) : typeof value !== typeof fallback) ? fallback : value; } catch { return fallback; } }
let backends: BackendProfile[] = saved<BackendProfile[]>('backends', []).filter(b => { try { return b && typeof b.id === 'string' && b.id !== 'primary' && typeof b.name === 'string' && backendURL(b.url) === b.url; } catch { return false; } });
backends.unshift(primary);
let hosts: HostProfile[] = saved<HostProfile[]>('hosts', [{ id: 'local', name: 'This machine', kind: 'http', backendId: 'primary' }]).filter(h => h && typeof h.id === 'string' && typeof h.name === 'string' && ['http', 'ssh', 'herdr'].includes(h.kind) && backends.some(b => b.id === h.backendId));
let tabs: TerminalTab[] = saved<TerminalTab[]>('tabs', []).filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && backends.some(b => b.id === t.backendId) && (t.session === 'default' || /^[a-f0-9-]{36}$/.test(t.session))).map(migratePluginTab);
for (const tab of saved<LegacyReadingTab[]>('readingTabs', []).filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.path === 'string' && typeof t.sourceTabId === 'string' && backends.some(b => b.id === t.backendId) && (t.session === 'default' || /^[a-f0-9-]{36}$/.test(t.session)))) {
  if (!tabs.some(existing => existing.id === tab.id)) tabs.push(migrateReadingTab(tab));
}
let active = saved<string>('activeTab', '') || tabs[0]?.id || '';
let page: 'terminal' | 'hosts' | 'vault' | 'keychain' | 'backends' | 'known' | 'settings' = 'terminal';
let alphabetical = false, editingHost: string | undefined, keyDetail: { backend?: BackendProfile; key: KeyInfo | BrowserKeyInfo } | undefined;
const frames = new Map<string, HTMLIFrameElement>(), tokens = new Map<string, string>(), vaults = new Map<string, { keys: KeyInfo[]; knownHosts: KnownHost[] }>();
const plugins = new PluginRegistry(), pluginViews = new Map<string, PluginView>();
const mounting = new Map<string, Promise<void>>(), mountGeneration = new Map<string, number>();
let installedPlugins: InstalledPlugin[] = [];
try {
  for (const entry of saved<InstalledPlugin[]>('plugins', []).slice(0, 16)) {
    try { installedPlugins.push({ package: parsePluginPackage(entry.package), enabled: entry.enabled === true }); } catch { /* Keep unavailable tabs until the package is installed again. */ }
  }
} catch { /* A corrupt plugin inventory cannot prevent terminal startup. */ }
const herdrViews = new Map<string, HerdrView>(), herdrAttention = new Map<string, number>();
const herdrSounds = new HerdrSounds();
const herdrNotifications = new HerdrNotifications(<T>(id: string, name: string, data?: unknown) => api<T>(backendFor(id), name, data), () => {
  for (const [id, view] of herdrViews) {
    view.updatePresence();
    const tab = tabs.find(tab => tab.id === id);
    if (tab) void herdrNotifications.watch(tab.backendId, tab.id, herdrSession(tab.herdrSession), tab.herdrSource).catch(error => notice(error.message));
  }
});
for (const plugin of builtinPlugins({
  active: tab => tabs.includes(tab),
  backend: tab => backendFor(tab.backendId), host: id => hosts.find(host => host.id === id), authenticate, token: tokenFor, api,
  connect: (host, id) => configureConnection(host, id), closeSession: closeTabSession, store, notice, terminalURL, openReading,
  frame(tab, frame) { if (frame) frames.set(tab.id, frame); else frames.delete(tab.id); },
  herdr(tab, view) { if (view) herdrViews.set(tab.id, view); else { herdrViews.delete(tab.id); herdrAttention.delete(tab.id); } },
  attention(tab, count) { herdrAttention.set(tab.id, count); const badge = $('tabs').querySelector<HTMLElement>('[aria-controls="herdr-' + tab.id + '"] .herdr-attention'); if (badge) { badge.textContent = String(count); badge.hidden = !count; badge.setAttribute('aria-label', count + ' agents need attention'); } },
  notification: (connection, event) => herdrSounds.play(connection, event), notificationDevice: id => herdrNotifications.device(id),
  watch: tab => herdrNotifications.watch(tab.backendId, tab.id, herdrSession(tab.herdrSession), tab.herdrSource), unwatch: tab => herdrNotifications.unwatch(tab.backendId, tab.id),
})) plugins.register(plugin);
function registerExternal(pkg: PluginPackage) {
  plugins.register(externalPlugin(pkg, { connect: (host, pkg) => configureConnection(host, pkg.manifest.id, pkg), close: closeTabSession, store,
    async read(tab) {
      if (!tab.readPath) throw new Error('This connection has no file permission. Reconnect and select a file.');
      return api(backendFor(tab.backendId), 'api/plugins/read?' + new URLSearchParams({ path: tab.readPath, session: tab.session }));
    },
  }));
}
for (const entry of installedPlugins) {
  try { registerExternal(entry.package); plugins.enable(entry.package.manifest.id, entry.enabled); } catch { /* Ignore duplicate or corrupt saved entries. */ }
}
const authenticating = new Map<string, Promise<void>>();
const lockedTerminals = new Set<string>();
const handledEnds = new Map<string, string>();
let terminalLoading: { id: string; waitForPrompt: boolean } | undefined;
let notification: ReturnType<typeof setTimeout>;
function notice(message: string) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(notification); notification = setTimeout(() => $('notice').hidden = true, 6000); }
function store() { try { for (const [key, value] of Object.entries({ backends: backends.filter(b => b.id !== 'primary'), hosts, tabs, activeTab: active })) localStorage.setItem('termai.' + key, JSON.stringify(value)); localStorage.removeItem('termai.readingTabs'); } catch { notice('Browser storage is unavailable. Connections will last for this page only.'); } }
function tokenFor(backend: BackendProfile) { return tokens.get(backend.id) || backendAccess(backend.url); }
function authorizeTerminals(backend: BackendProfile, accessToken: string) {
  tokens.set(backend.id, accessToken);
  rememberBackendAccess(backend.url, accessToken);
  for (const id of lockedTerminals) {
    if (tabs.find(tab => tab.id === id)?.backendId !== backend.id) continue;
    lockedTerminals.delete(id);
    frames.get(id)?.contentWindow?.postMessage({ type: 'authorize', accessToken }, location.origin);
  }
}
async function api<T>(backend: BackendProfile, name: string, data?: unknown, session?: string, recoverAuth = true): Promise<T> {
  const url = new URL(name, backend.url); if (session) url.searchParams.set('session', session);
  const token = tokenFor(backend);
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(['api/sessions', 'api/ssh/captured'].includes(name) ? 25000 : 12000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  // Revoked credentials can expire while the workspace stays open.
  // Retry only an explicit authentication rejection: the server has not performed
  // the requested action. Never replay a timeout or an uncertain connection failure.
  if (response.status === 401 && name !== 'api/connect' && recoverAuth) {
    if (tokenFor(backend) === token) await authenticate(backend, true);
    else await authenticating.get(backend.id); // Another request may already be refreshing it.
    return api<T>(backend, name, data, session, false);
  }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), result, { status: response.status });
  return result;
}
let loginQueue: Promise<unknown> = Promise.resolve();
function authenticate(backend: BackendProfile, force = false): Promise<void> {
  if (!force && tokens.has(backend.id)) return Promise.resolve();
  if (authenticating.has(backend.id)) return authenticating.get(backend.id)!;
  const work = (async () => {
    if (force) { tokens.delete(backend.id); forgetBackendAccess(backend.url); }
    const save = (accessToken: string) => authorizeTerminals(backend, accessToken);
    try { const result = await api<{ accessToken: string }>(backend, 'api/connect', { noSession: true }); save(result.accessToken); return; }
    catch (error: any) { if (error.status !== 401) throw new Error(`Cannot reach ${backend.name}. Check its URL, network access, and allowed frontend origin.`); }
    const prompt = loginQueue.then(() => new Promise<void>((resolve, reject) => {
      $('backend-login-name').textContent = backend.name + ' · ' + backend.url; $('backend-login-error').textContent = ''; input('backend-token').value = '';
      const modal = dialog('backend-login');
      const close = () => { modal.removeEventListener('close', close); reject(new Error('Backend login cancelled.')); };
      modal.addEventListener('close', close);
      $<HTMLFormElement>('backend-login-form').onsubmit = async event => {
        event.preventDefault();
        try { const result = await api<{ accessToken: string }>(backend, 'api/connect', { noSession: true, token: input('backend-token').value }); save(result.accessToken); input('backend-token').value = ''; modal.removeEventListener('close', close); modal.close(); resolve(); }
        catch (error: any) { $('backend-login-error').textContent = error.message; }
      };
      modal.showModal();
    }));
    loginQueue = prompt.catch(() => {}); await prompt;
  })().finally(() => authenticating.delete(backend.id));
  authenticating.set(backend.id, work); return work;
}
const backendFor = (id: string) => backends.find(b => b.id === id)!;
function populate(id: string, selected = 'primary', extra = false, browser = false) {
  const element = select(id); element.replaceChildren();
  if (browser) element.add(new Option('This browser', 'browser'));
  for (const backend of backends) element.add(new Option(backend.name, backend.id));
  if (extra) element.add(new Option('New direct backend…', 'new'));
  element.value = selected; if (!element.value) element.value = browser ? 'browser' : 'primary';
}
function show(view: typeof page) {
  closeHostMenu();
  closeTabMenu();
  const previous = page; page = view; const terminal = view === 'terminal';
  $('terminal-header').hidden = !terminal; $('terminal-stack').hidden = !terminal; $('library').hidden = terminal;
  for (const [id, view] of pluginViews) view.setVisible(terminal && id === active && !document.hidden);
  if (terminal) { renderTabs(); return; }
  $('settings-pane').hidden = view !== 'settings'; $('library-content').hidden = view === 'settings';
  for (const [id, selected] of [['nav-vault', view !== 'settings'], ['nav-settings', view === 'settings']] as const) { if (selected) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); }
  $('page-title').textContent = { settings: 'Settings', hosts: 'Hosts', vault: 'Vault', keychain: 'Keychain', backends: 'Backends', known: 'Known hosts' }[view];
  $('page-back').querySelector('span')!.textContent = ['vault', 'settings'].includes(view) ? 'Terminal' : 'Vault';
  $('sort-hosts').hidden = !['hosts', 'keychain'].includes(view);
  $('search-label').hidden = ['vault', 'settings'].includes(view); input('search').placeholder = 'Search ' + $('page-title').textContent!.toLowerCase(); input('search').value = '';
  $('backend-filter-label').hidden = !['keychain', 'known'].includes(view); populate('backend-filter', view === 'keychain' && previous !== 'keychain' ? 'browser' : select('backend-filter').value || 'primary', false, view === 'keychain');
  $('library-add').hidden = ['vault', 'known', 'settings'].includes(view); $('library-add').setAttribute('aria-label', view === 'keychain' ? 'Add SSH key' : view === 'backends' ? 'Add backend' : 'Add host');
  if (view === 'settings') { renderSettings(); return; }
  void renderCards();
}
function button(text: string, action: () => void, className = '') { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = className; b.onclick = action; return b; }
function card(name: string, detail: string, icon: string, action: () => void, edit?: () => void, badge?: string) {
  const row = document.createElement('div'); row.className = 'card';
  const main = button('', action, 'card-main'), glyph = document.createElement('span'); glyph.className = 'card-icon'; glyph.textContent = icon; glyph.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span'); text.className = 'card-text';
  const title = document.createElement('span'); title.className = 'card-name'; title.textContent = name;
  if (badge) { const tag = document.createElement('span'); tag.className = 'badge'; tag.textContent = badge; title.append(document.createTextNode(' '), tag); }
  const subtitle = document.createElement('span'); subtitle.className = 'card-detail'; subtitle.textContent = detail;
  text.append(title, subtitle); main.append(glyph, text); row.append(main);
  if (edit) { const b = button('•••', edit, 'card-edit'); b.setAttribute('aria-label', 'Edit ' + name); row.append(b); }
  $('cards').append(row); return row;
}
function hostTabs(host: HostProfile) { return tabs.filter(tab => tab.hostId === host.id && !tab.ended); }
function tabLabel(tab: TerminalTab) {
  if (tabPluginId(tab) === 'files') return tab.name;
  const peers = tabs.filter(other => tabPluginId(other) === tabPluginId(tab) && other.hostId === tab.hostId && other.name === tab.name);
  const index = peers.indexOf(tab); return index > 0 ? `${tab.name} (${index + 1})` : tab.name;
}
const hostMenu = document.createElement('div'); hostMenu.id = 'host-terminal-menu'; hostMenu.className = 'host-terminal-menu'; hostMenu.role = 'menu'; hostMenu.hidden = true; document.body.append(hostMenu);
let menuAnchor: HTMLButtonElement | undefined;
function closeHostMenu(focus = false) {
  hostMenu.hidden = true; menuAnchor?.setAttribute('aria-expanded', 'false');
  if (focus) menuAnchor?.focus(); menuAnchor = undefined;
}
function openHostMenu(host: HostProfile, anchor: HTMLButtonElement) {
  if (menuAnchor === anchor) { closeHostMenu(true); return; }
  closeHostMenu(); menuAnchor = anchor; anchor.setAttribute('aria-expanded', 'true'); hostMenu.replaceChildren();
  hostMenu.setAttribute('aria-label', host.name + ' terminals');
  const item = (label: string, action: () => void) => {
    const control = button(label, () => { closeHostMenu(); action(); }); control.role = 'menuitem'; control.setAttribute('aria-label', label); hostMenu.append(control); return control;
  };
  for (const plugin of plugins.actions(host)) item(plugin.connectLabel, () => void plugin.connect(host).catch(error => notice(error.message)));
  const open = hostTabs(host);
  if (open.length) {
    hostMenu.append(document.createElement('hr'));
    for (const tab of open) {
      const control = item(tabLabel(tab), () => activate(tab.id));
      if (tab.id === active) { control.classList.add('current'); control.setAttribute('aria-current', 'true'); }
    }
  }
  hostMenu.append(document.createElement('hr')); item('Edit host', () => editHost(host));
  hostMenu.hidden = false;
  const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
  hostMenu.style.maxHeight = `${height - 24}px`;
  const size = hostMenu.getBoundingClientRect();
  hostMenu.style.left = `${Math.max(left + 12, Math.min(rect.right - size.width, left + width - size.width - 12))}px`;
  hostMenu.style.top = `${Math.max(top + 12, Math.min(rect.bottom + 4, top + height - size.height - 12))}px`;
  hostMenu.querySelector('button')?.focus();
}
hostMenu.onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeHostMenu(true); return; }
  if (event.key === 'Tab') { closeHostMenu(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const items = [...hostMenu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
};
document.addEventListener('pointerdown', event => { if (!hostMenu.contains(event.target as Node) && !menuAnchor?.contains(event.target as Node)) closeHostMenu(); });
$('library-content').addEventListener('scroll', () => closeHostMenu(), { passive: true });
window.addEventListener('resize', () => closeHostMenu());
const tabMenu = document.createElement('div'); tabMenu.className = 'host-terminal-menu'; tabMenu.role = 'menu'; tabMenu.hidden = true; document.body.append(tabMenu);
let tabMenuAnchor: HTMLElement | undefined;
function closeTabMenu() { tabMenu.hidden = true; tabMenuAnchor = undefined; }
function openTabMenu(tab: TerminalTab, anchor: HTMLElement) {
  tabMenuAnchor = anchor; tabMenu.replaceChildren();
  const rename = button('Rename', () => { closeTabMenu(); renameTab(tab); }); rename.role = 'menuitem';
  const close = button('Close tab', () => { closeTabMenu(); void closeTab(tab).catch(error => notice(error.message)); }); close.role = 'menuitem';
  tabMenu.append(rename, close); tabMenu.hidden = false;
  tabMenu.setAttribute('aria-label', tab.name + ' tab actions');
  const rect = anchor.getBoundingClientRect();
  tabMenu.style.left = Math.max(8, Math.min(rect.left, innerWidth - tabMenu.offsetWidth - 8)) + 'px'; tabMenu.style.top = rect.bottom + 5 + 'px';
  rename.focus({ preventScroll: true });
}
function renameTab(tab: TerminalTab) {
  const modal = document.createElement('dialog'), form = document.createElement('form'), title = document.createElement('h2'), field = document.createElement('input'), error = document.createElement('p'), actions = document.createElement('div');
  title.textContent = 'Rename tab'; field.value = tab.name; field.maxLength = 100; field.required = true; field.setAttribute('aria-label', 'Tab name'); error.className = 'form-error'; actions.className = 'actions';
  const cancel = button('Cancel', () => modal.close(), 'secondary'), save = button('Save', () => {}, 'primary'); save.type = 'submit'; actions.append(cancel, save);
  form.append(title, field, error, actions); modal.append(form); document.body.append(modal); modal.onclose = () => modal.remove();
  form.onsubmit = event => { event.preventDefault(); try { tab.name = herdrName(field.value); store(); renderTabs(); modal.close(); } catch (reason: any) { error.textContent = reason.message; } };
  modal.showModal(); field.focus(); field.select();
}
document.addEventListener('pointerdown', event => { if (!tabMenu.contains(event.target as Node) && !tabMenuAnchor?.contains(event.target as Node)) closeTabMenu(); });
window.addEventListener('resize', closeTabMenu);
tabMenu.onkeydown = event => {
  if (event.key === 'Escape') { tabMenuAnchor?.focus(); closeTabMenu(); }
  if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const items = [...tabMenu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + 1) % items.length]?.focus(); }
};
let rendering = 0;
async function renderCards() {
  closeHostMenu();
  const generation = ++rendering; $('cards').replaceChildren(); $('list-empty').hidden = true;
  const query = input('search').value.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(query);
  const items = <T extends { name: string }>(values: T[]) => alphabetical ? [...values].sort((a, b) => a.name.localeCompare(b.name)) : values;
  $('list-heading').textContent = { terminal: '', settings: '', hosts: 'Saved hosts', vault: 'Your workspace', keychain: 'SSH keys', backends: 'Direct backends', known: 'Verified fingerprints' }[page];
  if (page === 'vault') {
    for (const [name, detail, icon, view] of [['Hosts', `${hosts.length} saved`, '▤', 'hosts'], ['Keychain', 'Encrypted SSH keys', '⚿', 'keychain'], ['Backends', `${backends.length} available`, '⌘', 'backends'], ['Known hosts', 'SSH host fingerprints', '◎', 'known']] as const) card(name, detail, icon, () => show(view)).classList.add('vault-card');
  } else if (page === 'hosts') {
    for (const host of items(hosts).filter(h => matches(h.name + ' ' + (h.hostname || backendFor(h.backendId).url)))) {
      const row = card(host.name, host.kind === 'ssh' ? `${host.username}@${host.hostname} · ${host.route === 'fixed' ? backendFor(host.backendId).name : 'Automatic route'}` : backendFor(host.backendId).url, '▤', () => void openHost(host).catch(error => notice(error.message)), undefined, host.kind.toUpperCase());
      const count = hostTabs(host).length, menu = button('', () => openHostMenu(host, menu), 'host-terminals');
      menu.setAttribute('aria-label', `Terminals for ${host.name} (${count} open)`); menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', hostMenu.id);
      const number = document.createElement('span'); number.className = 'host-terminal-count'; number.textContent = String(count);
      const arrow = document.createElement('span'); arrow.textContent = '▾'; arrow.setAttribute('aria-hidden', 'true'); menu.append(number, arrow); row.append(menu);
    }
  } else if (page === 'backends') {
    for (const backend of backends.filter(b => matches(b.name + ' ' + b.url))) card(backend.name, backend.url, '⌘', () => void authenticate(backend).then(() => notice('Connected to ' + backend.name)).catch(error => notice(error.message)), backend.id === 'primary' ? undefined : () => {
      if (tabs.some(t => t.backendId === backend.id)) { notice('Close this backend’s tabs before removing it.'); return; }
      if (confirm('Remove this backend and its saved hosts? Its SSH keys will stay on the server.')) void herdrNotifications.forgetBackend(backend.id).then(() => { backends = backends.filter(b => b.id !== backend.id); hosts = hosts.filter(h => h.backendId !== backend.id); routes.clear(); tokens.delete(backend.id); forgetBackendAccess(backend.url); store(); void renderCards(); }).catch(error => notice(error.message));
    }, 'HTTP');
  } else if (page === 'keychain' || page === 'known') {
    const backend = backendFor(select('backend-filter').value);
    try {
      if (page === 'keychain' && select('backend-filter').value === 'browser') {
        const keys = await browserVault.list(); if (generation !== rendering) return;
        for (const key of items(keys).filter(k => matches(k.name))) card(key.name, key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() + ' · This browser', '⚿', () => keyDetails(undefined, key));
      } else {
        await authenticate(backend); const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain'); vaults.set(backend.id, vault);
        if (generation !== rendering) return;
        if (page === 'keychain') for (const key of items(vault.keys).filter(k => matches(k.name))) card(key.name, key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() + ' · ' + (key.reference ? key.reference.type === 'file' ? 'Backend file' : 'Backend agent' : backend.name), '⚿', () => keyDetails(backend, key));
        else for (const item of vault.knownHosts.filter(k => matches(k.host))) card(item.host + ':' + item.port, item.fingerprint, '◎', () => notice(item.fingerprint), () => {
          if (confirm('Forget this SSH host fingerprint? Verify its identity again before your next connection.')) void api(backend, 'api/keychain', { action: 'forget', host: item.host, port: item.port }).then(() => renderCards()).catch(error => notice(error.message));
        });
      }
    } catch (error: any) { if (generation === rendering) notice(error.message); }
  }
  if (!$('cards').children.length) { $('list-empty').textContent = query ? 'No matches.' : page === 'keychain' ? 'Add an SSH key to connect securely. New keys are stored encrypted in this browser.' : page === 'known' ? 'Verified SSH hosts will appear here after you connect.' : 'Add a host to open your next terminal.'; $('list-empty').hidden = false; }
}
function updateTerminalLoading() { $('terminal-loading').hidden = page !== 'terminal' || terminalLoading?.id !== active; }
function showTerminalLoading(id: string, waitForPrompt = false) { terminalLoading = { id, waitForPrompt }; updateTerminalLoading(); }
function hideTerminalLoading(id: string) { if (terminalLoading?.id === id) { terminalLoading = undefined; updateTerminalLoading(); } }
function renderTabs() {
  $('tabs').replaceChildren();
  const all = tabs;
  for (const tab of all) {
    const plugin = plugins.forTab(tab);
    const el = document.createElement('div'); el.className = 'tab'; if (plugin?.className) el.classList.add(plugin.className); el.role = 'tab'; el.tabIndex = tab.id === active ? 0 : -1; el.setAttribute('aria-selected', String(tab.id === active)); el.setAttribute('aria-controls', pluginViews.get(tab.id)?.element.id || (plugin?.panelPrefix || 'plugin-') + tab.id); el.title = (tab.readPath || tabLabel(tab)) + ' · ' + backendFor(tab.backendId).name;
    const icon = document.createElement('span'); icon.className = 'tab-icon';
    if (plugin?.iconHTML) icon.innerHTML = plugin.iconHTML;
    else icon.textContent = plugin?.icon || '◇';
    const name = document.createElement('span'); name.className = 'tab-name'; name.textContent = tabLabel(tab);
    const close = button('×', () => void closeTab(tab).catch(error => notice(error.message)), 'tab-close'); close.setAttribute('aria-label', 'Close ' + tab.name); close.addEventListener('click', event => event.stopPropagation());
    if (tabPluginId(tab) === 'herdr') {
      el.classList.add('herdr-tab'); icon.textContent = 'H';
      const badge = document.createElement('span'); badge.className = 'herdr-attention'; badge.textContent = String(herdrAttention.get(tab.id) || 0); badge.hidden = !herdrAttention.get(tab.id); badge.setAttribute('aria-label', badge.textContent + ' agents need attention');
      el.append(icon, name, badge, close);
    } else el.append(icon, name, close);
    tabGestures(el, { select: () => activate(tab.id), hold: () => openTabMenu(tab, el), scroll: $('tabs') });
    el.onkeydown = event => {
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); activate(tab.id); }
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const index = all.indexOf(tab), next = all[(index + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; activate(next.id); ($('tabs').querySelector('[aria-selected=true]') as HTMLElement)?.focus(); }
    }; $('tabs').append(el);
  }
  for (const [id, view] of pluginViews) view.setVisible(id === active && page === 'terminal' && !document.hidden);
  $('empty-terminal').hidden = !!all.length;
  updateTerminalLoading();
  requestAnimationFrame(() => $('tabs').querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}
function activate(id: string) { const tab = tabs.find(tab => tab.id === id); if (!tab) return; tab.lastUsed = Date.now(); active = id; store(); show('terminal'); pluginViews.get(id)?.focus?.(); }

function openReading(source: TerminalTab, path: string) {
  const tab: TerminalTab = { id: crypto.randomUUID(), pluginId: 'reading', pluginVersion: BUILTIN_VERSION, ownsSession: false,
    name: path.split('/').at(-1) || path, readPath: path, backendId: source.backendId, session: source.session,
    parentTabId: tabPluginId(source) === 'reading' ? source.parentTabId : source.id, lastUsed: Date.now() };
  tabs.push(tab); active = tab.id; store(); show('terminal'); void mount(tab);
}
function openReadingCapture(source: TerminalTab, capture: string, name: string, exitCode?: number) {
  if (tabs.some(tab => tabPluginId(tab) === 'reading' && tab.backendId === source.backendId && tab.session === source.session && tab.readCapture === capture)) return;
  const tab: TerminalTab = { id: crypto.randomUUID(), pluginId: 'reading', pluginVersion: BUILTIN_VERSION, ownsSession: false,
    name, readPath: name, readCapture: capture, readExitCode: exitCode, backendId: source.backendId, session: source.session, parentTabId: source.id, lastUsed: Date.now() };
  tabs.push(tab); active = tab.id; store(); show('terminal'); void mount(tab);
}
function unmount(tab: TerminalTab) {
  mountGeneration.set(tab.id, (mountGeneration.get(tab.id) || 0) + 1);
  mounting.delete(tab.id); pluginViews.get(tab.id)?.dispose(); pluginViews.delete(tab.id);
}
async function mount(tab: TerminalTab): Promise<void> {
  if (pluginViews.has(tab.id) || !tabs.includes(tab)) return;
  if (mounting.has(tab.id)) return mounting.get(tab.id);
  const generation = mountGeneration.get(tab.id) || 0, plugin = plugins.forTab(tab);
  const work = (async () => {
    let view: PluginView;
    try {
      if (!plugin) throw new Error('This plugin version is missing or disabled. Install or enable ' + tabPluginId(tab) + ' (' + tab.pluginVersion + ') in Settings.');
      view = await plugin.mount(tab);
    } catch (error: any) {
      const element = readingMessage(tab.name, error.message || 'Could not open this tab.'); element.id = 'plugin-' + tab.id;
      const retry = button('Retry connection', () => { unmount(tab); void mount(tab); }, 'secondary'); element.append(retry);
      view = { element, setVisible(visible) { element.hidden = !visible; }, dispose() { element.remove(); } };
    }
    if (!tabs.includes(tab) || (mountGeneration.get(tab.id) || 0) !== generation) { view.dispose(); return; }
    pluginViews.set(tab.id, view); $('terminal-stack').append(view.element); renderTabs();
  })();
  mounting.set(tab.id, work);
  try { await work; } finally { if (mounting.get(tab.id) === work) mounting.delete(tab.id); }
}
function terminalURL(backend: BackendProfile, session: string) {
  const url = new URL('terminal.html', document.baseURI);
  url.search = new URLSearchParams({ embedded: '1', backend: backend.url, session }).toString();
  return url.href;
}
async function addTerminal(backend: BackendProfile, session: string, name: string, hostId?: string, parentTabId?: string, files = false) {
  const names = new Set(tabs.filter(tab => tab.hostId === hostId && (tabPluginId(tab) === 'files') === files).map(tabLabel));
  const base = name; for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
  const tab: TerminalTab = { pluginId: files ? 'files' : 'terminal', pluginVersion: '1', ownsSession: true, mode: files ? 'files' : undefined, id: crypto.randomUUID(), backendId: backend.id, session, name, hostId, parentTabId, lastUsed: Date.now() }; tabs.push(tab); active = tab.id;
  if (!files && hosts.find(host => host.id === hostId)?.kind === 'ssh') showTerminalLoading(tab.id, true);
  store(); show('terminal'); await mount(tab);
}
async function closeTab(tab: TerminalTab) {
  const plugin = plugins.forTab(tab);
  if (plugin) { if (!await plugin.close(tab)) return; }
  else if (tab.ownsSession ?? !['herdr', 'reading'].includes(tabPluginId(tab))) await closeTabSession(tab);
  const wasActive = active === tab.id;
  unmount(tab); lockedTerminals.delete(tab.id); handledEnds.delete(tab.id); const index = tabs.indexOf(tab); tabs = tabs.filter(t => t.id !== tab.id);
  hideTerminalLoading(tab.id);
  if (active === tab.id) active = tabs.find(t => t.id === tab.parentTabId)?.id || tabs[Math.min(index, tabs.length - 1)]?.id || '';
  store(); renderTabs(); if (!tabs.length) { $('empty-terminal').querySelector('p')!.textContent = 'Open a saved host to start a terminal.'; }
  if (wasActive) pluginViews.get(active)?.focus?.();
}
async function closeTabSession(tab: TerminalTab) {
  const backend = backendFor(tab.backendId); await authenticate(backend); await api(backend, 'api/sessions/close', {}, tab.session);
}
async function recoverTerminal(tab: TerminalTab, backend: BackendProfile) {
  try {
    await authenticate(backend);
    await api(backend, 'api/sessions/close', {}, tab.session);
    if (!tabs.includes(tab)) return;
    const result = await api<{ id: string }>(backend, 'api/sessions', { name: tab.name });
    if (!tabs.includes(tab)) { await api(backend, 'api/sessions/close', {}, result.id); return; }
    tab.session = result.id; tab.ended = false; store();
    const frame = frames.get(tab.id);
    if (frame) frame.src = terminalURL(backend, result.id);
    else await mount(tab);
    if (page === 'hosts') void renderCards();
  } catch (error: any) {
    frames.get(tab.id)?.contentWindow?.postMessage({ type: 'recovery-failed' }, location.origin);
    notice(`Could not start ${tab.name}: ${error.message}`);
  }
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  const entry = [...frames].find(([, frame]) => frame.contentWindow === event.source); if (!entry) return;
  const tab = tabs.find(tab => tab.id === entry[0]); if (!tab) return;
  if (event.data?.session !== tab.session) return;
  const backend = backendFor(tab.backendId), frame = entry[1];
  if (event.data?.type === 'terminal-authorized' && typeof event.data.accessToken === 'string' && /^[a-f0-9]{64}$/.test(event.data.accessToken)) authorizeTerminals(backend, event.data.accessToken);
  if (event.data?.type === 'terminal-loaded') { frame.contentWindow!.postMessage({ type: 'authorize', accessToken: tokenFor(backend) }, location.origin); frame.contentWindow!.postMessage({ type: 'tab-visibility', visible: tab.id === active && page === 'terminal' }, location.origin); }
  if (event.data?.type === 'terminal-locked') {
    hideTerminalLoading(tab.id);
    lockedTerminals.add(tab.id);
    const current = tokenFor(backend);
    // A delayed rejection may refer to credentials replaced by another frame.
    if (current && current !== event.data.accessToken) authorizeTerminals(backend, current);
    else void authenticate(backend, true).catch(error => notice(error.message));
  }
  if (event.data?.type === 'ssh-command' && typeof event.data.id === 'string' && typeof event.data.command === 'string') { showTerminalLoading(tab.id); void capturedSSH(backend, tab, event.data.id, event.data.command); }
  if (event.data?.type === 'herdr-command' && typeof event.data.id === 'string') { showTerminalLoading(tab.id); void capturedHerdr(backend, tab, event.data.id); }
  if (event.data?.type === 'terminal-notice' && typeof event.data.message === 'string') notice(event.data.message);
  if (event.data?.type === 'reading-open' && typeof event.data.path === 'string' && event.data.path.length <= 4096) openReading(tab, event.data.path);
  if (event.data?.type === 'reading-open' && typeof event.data.capture === 'string' && /^[a-f0-9]{32}$/.test(event.data.capture) && typeof event.data.name === 'string' && event.data.name.length <= 180 && Number.isInteger(event.data.exitCode) && event.data.exitCode >= 0 && event.data.exitCode <= 255) openReadingCapture(tab, event.data.capture, event.data.name, event.data.exitCode);
  if (event.data?.type === 'terminal-state' && event.data.state?.ready === true && terminalLoading?.id === tab.id && terminalLoading.waitForPrompt) hideTerminalLoading(tab.id);
  if (event.data?.type === 'terminal-ended' || (event.data?.type === 'terminal-state' && typeof event.data.state?.exited === 'boolean')) {
    const ended = event.data.type === 'terminal-ended' || event.data.state.exited;
    if (ended) hideTerminalLoading(tab.id);
    const host = hosts.find(host => host.id === tab.hostId);
    if (ended && host?.kind === 'http' && handledEnds.get(tab.id) !== tab.session) {
      handledEnds.set(tab.id, tab.session);
      void recoverTerminal(tab, backend);
    } else if (ended && host?.kind !== 'http' && !tab.ended && active === tab.id && tabs.some(parent => parent.id === tab.parentTabId)) activate(tab.parentTabId!);
    if (!!tab.ended !== ended) { tab.ended = ended; store(); if (page === 'hosts') void renderCards(); }
    if (event.data.type === 'terminal-ended' && host?.kind !== 'http') notice(tab.name + ' has ended. Open its saved host to reconnect.');
  }
});
const captureRequests = new Set<string>();
let captureQueue: Promise<unknown> = Promise.resolve();
async function capturedHerdr(backend: BackendProfile, parent: TerminalTab, id: string) {
  const requestKey = backend.id + ':herdr:' + id; if (captureRequests.has(requestKey)) return; captureRequests.add(requestKey);
  try {
    const result = await api<{ herdrSession: string; herdrSource: string; name: string; remote: boolean }>(backend, 'api/herdr/captured', { id }, parent.session);
    const source = result.herdrSource || undefined;
    let host = hosts.find(host => host.kind === 'herdr' && host.backendId === backend.id && (host.herdrSession || '') === result.herdrSession && (host.herdrSource === source || result.remote && parent.hostId && host.herdrSourceHostId === parent.hostId));
    if (!host) {
      const sourceHost = hosts.find(host => host.id === parent.hostId);
      host = { id: crypto.randomUUID(), name: result.name + (result.remote ? ' · ' + (sourceHost?.name || parent.name) : ''), kind: 'herdr', backendId: backend.id, herdrSession: result.herdrSession, herdrSource: source, herdrSourceHostId: parent.hostId };
      hosts.push(host);
    }
    if (host.herdrSource !== source) {
      host.herdrSource = source;
      for (const tab of tabs.filter(tab => tabPluginId(tab) === 'herdr' && tab.hostId === host.id)) {
        tab.herdrSource = source; unmount(tab); await mount(tab);
      }
    }
    store(); await openHost(host); await api(backend, 'api/herdr/captured', { id, action: 'ack' }, parent.session);
  } catch (error: any) {
    notice(error.message);
    await api(backend, 'api/herdr/captured', { id, action: 'cancel' }, parent.session).catch(() => {});
  } finally { hideTerminalLoading(parent.id); captureRequests.delete(requestKey); }
}
function capturedSSH(backend: BackendProfile, parent: TerminalTab, id: string, command: string) {
  const key = backend.id + ':' + id; if (captureRequests.has(key)) return; captureRequests.add(key);
  const work = captureQueue.then(async () => {
    const request = (data: object) => api<{ native?: boolean; message?: string; id: string; name: string; host: string; port: number; username: string; key?: KeyInfo }>(backend, 'api/ssh/captured', { id, ...data }, parent.session);
    let trust: string | undefined;
    const attempt = async (passphrase?: string) => {
      showTerminalLoading(parent.id);
      let result;
      try { result = await request({ passphrase, trust }); }
      catch (error: any) {
        if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
        if (!confirm(`Verify the SSH host fingerprint through ${backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`)) { await request({ action: 'cancel' }); hideTerminalLoading(parent.id); return true; }
        trust = error.fingerprint; result = await request({ passphrase, trust });
      }
      if (result.native) { await request({ action: 'ack' }); hideTerminalLoading(parent.id); if (result.message) notice(result.message); return true; }
      const existing = tabs.find(tab => tabPluginId(tab) === 'terminal' && tab.backendId === backend.id && tab.session === result.id);
      if (existing) { hideTerminalLoading(parent.id); activate(existing.id); await request({ action: 'ack' }); return true; }
      let host = hosts.find(h => h.kind === 'ssh' && h.backendId === backend.id && h.hostname === result.host && h.port === result.port && h.username === result.username);
      if (!host) { host = { id: crypto.randomUUID(), name: result.name, kind: 'ssh', backendId: backend.id, hostname: result.host, port: result.port, username: result.username, route: 'fixed' }; hosts.push(host); }
      if (result.key) { host.keyFingerprint = result.key.fingerprint; host.backendKeyId = result.key.reference ? result.key.id : undefined; host.browserKeyId = undefined; }
      store(); await addTerminal(backend, result.id, host.name, host.id, parent.id); await request({ action: 'ack' }); return true;
    };
    try { await attempt(); return; } catch (error: any) {
      hideTerminalLoading(parent.id);
      $('captured-ssh-error').textContent = error.message;
      $('captured-ssh-secret-label').hidden = !error.needsSecret;
      input('captured-ssh-secret').required = !!error.needsSecret;
    }
    await new Promise<void>(resolve => {
      const modal = dialog('captured-ssh-dialog'); $('captured-ssh-command').textContent = command; input('captured-ssh-secret').value = '';
      const controls = [...modal.querySelectorAll<HTMLButtonElement>('button')];
      const finish = () => { hideTerminalLoading(parent.id); input('captured-ssh-secret').value = ''; modal.close(); resolve(); };
      const act = async (action: () => Promise<unknown>) => {
        controls.forEach(button => button.disabled = true);
        try { await action(); finish(); } catch (error: any) { hideTerminalLoading(parent.id); $('captured-ssh-error').textContent = error.message; $('captured-ssh-secret-label').hidden = !error.needsSecret; input('captured-ssh-secret').required = !!error.needsSecret; }
        finally { input('captured-ssh-secret').value = ''; controls.forEach(button => button.disabled = false); }
      };
      $<HTMLFormElement>('captured-ssh-form').onsubmit = event => { event.preventDefault(); void act(() => attempt(input('captured-ssh-secret').value || undefined)); };
      $('captured-ssh-cancel').onclick = () => void act(() => request({ action: 'cancel' }));
      $('captured-ssh-native').onclick = () => void act(() => request({ action: 'native' }));
      modal.oncancel = event => { event.preventDefault(); if (!controls[0].disabled) $('captured-ssh-cancel').click(); };
      modal.showModal();
    });
  }).catch(error => { captureRequests.delete(key); hideTerminalLoading(parent.id); notice(error.message); });
  captureQueue = work; return work;
}
function editHost(host?: HostProfile) {
  editingHost = host?.id; $('host-dialog-title').textContent = host ? 'Edit host' : 'New host'; input('host-name').value = host?.name || ''; select('host-kind').value = host?.kind || 'http';
  populate('host-backend', host?.backendId || 'primary', true); input('host-url').value = backendFor(host?.backendId || 'primary').url;
  input('host-address').value = host?.hostname || ''; input('host-user').value = host?.username || ''; input('host-port').value = String(host?.port || 22); select('host-route').value = host?.route || 'auto';
  input('host-herdr-session').value = host?.herdrSession || '';
  $('delete-host').hidden = !host; $('host-error').textContent = ''; hostFields(); dialog('host-dialog').showModal();
}
function hostFields() {
  const ssh = select('host-kind').value === 'ssh', herdr = select('host-kind').value === 'herdr'; $('direct-fields').hidden = ssh; $('ssh-fields').hidden = !ssh; $('herdr-fields').hidden = !herdr;
  input('host-url').required = !ssh; input('host-address').required = input('host-user').required = ssh;
  const newOption = select('host-backend').querySelector<HTMLOptionElement>('option[value=new]')!; newOption.disabled = ssh;
  if (ssh && select('host-backend').value === 'new') select('host-backend').value = 'primary';
}
select('host-kind').onchange = hostFields;
select('host-backend').onchange = () => { input('host-url').value = select('host-backend').value === 'new' ? '' : backendFor(select('host-backend').value).url; };
$<HTMLFormElement>('host-form').onsubmit = event => {
  event.preventDefault();
  try {
    const name = input('host-name').value.trim(); if (!name) throw new Error('Name this host.');
    const kind = select('host-kind').value as HostProfile['kind']; let backendId = select('host-backend').value;
    if (kind === 'http' || kind === 'herdr') { const url = backendURL(input('host-url').value); let backend = backends.find(b => b.url === url); if (!backend) { backend = { id: crypto.randomUUID(), name, url }; backends.push(backend); } backendId = backend.id; }
    const host: HostProfile = { id: editingHost || crypto.randomUUID(), name, kind, backendId };
    if (kind === 'ssh') { const address = sshAddress({ host: input('host-address').value, username: input('host-user').value, port: Number(input('host-port').value) }); Object.assign(host, { hostname: address.host, username: address.username, port: address.port, route: select('host-route').value }); }
    if (kind === 'herdr') host.herdrSession = herdrSession(input('host-herdr-session').value);
    const index = hosts.findIndex(h => h.id === editingHost); if (index >= 0) { host.keyFingerprint = hosts[index].keyFingerprint; host.browserKeyId = hosts[index].browserKeyId; host.backendKeyId = hosts[index].backendKeyId; hosts[index] = host; } else hosts.push(host);
    routes.clear(); store(); dialog('host-dialog').close(); show('hosts');
  } catch (error: any) { $('host-error').textContent = error.message; }
};
$('delete-host').onclick = () => { if (confirm('Delete this saved host? Open terminals will keep running.')) { hosts = hosts.filter(h => h.id !== editingHost); routes.clear(); store(); dialog('host-dialog').close(); void renderCards(); } };
$<HTMLFormElement>('backend-form').onsubmit = event => {
  event.preventDefault(); try { const url = backendURL(input('backend-url').value); if (backends.some(b => b.url === url)) throw new Error('This backend is already saved.'); backends.push({ id: crypto.randomUUID(), name: input('backend-name').value.trim(), url }); store(); dialog('backend-dialog').close(); void renderCards(); } catch (error: any) { $('backend-error').textContent = error.message; }
};
let sshHost: HostProfile | undefined;
const keyValue = (key: KeyInfo) => key.reference ? 'backend:' + key.id : key.fingerprint;
const selectedBackendKey = () => vaults.get(sshHost?.backendId || '')?.keys.find(key => keyValue(key) === select('ssh-key').value);
let selectedRoute: { backend: BackendProfile; keyId?: string } | undefined, routeGeneration = 0;
const openingHosts = new Map<string, Promise<void>>();
interface ConnectionRequest { pluginId: string; pluginVersion?: string; readPath?: string; herdrSession?: string }
let sshRequest: ConnectionRequest = { pluginId: 'terminal' };
let pendingConnection: { host: HostProfile; request: ConnectionRequest } | undefined;
function configureConnection(host: HostProfile, pluginId: string, pkg?: PluginPackage): Promise<void> {
  if ((pluginId !== 'herdr' && !pkg) || host.kind === 'herdr') return openHost(host, true, { pluginId });
  pendingConnection = { host, request: { pluginId, pluginVersion: pkg?.manifest.version } };
  $('plugin-connect-title').textContent = pkg ? pkg.manifest.connectLabel : 'Connect Herdr';
  $('plugin-connect-host').textContent = host.name;
  $('plugin-read-fields').hidden = !pkg; input('plugin-read-path').required = !!pkg; input('plugin-read-path').value = '';
  $('plugin-herdr-fields').hidden = pluginId !== 'herdr'; input('plugin-herdr-session').value = host.herdrSession || '';
  $('plugin-connect-error').textContent = ''; dialog('plugin-connect-dialog').showModal(); return Promise.resolve();
}
$<HTMLFormElement>('plugin-connect-form').onsubmit = event => {
  event.preventDefault(); if (!pendingConnection) return;
  const { host, request } = pendingConnection;
  try {
    if (request.pluginId === 'herdr') request.herdrSession = herdrSession(input('plugin-herdr-session').value);
    else {
      const path = input('plugin-read-path').value.trim();
      if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Enter a file path.');
      request.readPath = path;
    }
    dialog('plugin-connect-dialog').close(); pendingConnection = undefined;
    void openHost(host, true, request).catch(error => notice(error.message));
  } catch (error: any) { $('plugin-connect-error').textContent = error.message; }
};
async function openHost(host: HostProfile, createNew = false, request: ConnectionRequest = { pluginId: host.kind === 'herdr' ? 'herdr' : 'terminal' }) {
  if (!createNew) {
    const open = hostTabs(host).filter(tab => tabPluginId(tab) === request.pluginId), existing = open.find(tab => tab.id === active) || open.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
    if (existing) { activate(existing.id); return; }
  }
  if (openingHosts.has(host.id)) return openingHosts.get(host.id);
  const work = connectHost(host, request).finally(() => openingHosts.delete(host.id)); openingHosts.set(host.id, work); return work;
}
async function finishConnection(host: HostProfile, backend: BackendProfile, session: string, request: ConnectionRequest) {
  if (request.pluginId === 'terminal' || request.pluginId === 'files') { await addTerminal(backend, session, host.name, host.id, undefined, request.pluginId === 'files'); return; }
  try {
    const target = request.pluginId === 'herdr' ? await api<{ herdrSession: string; herdrSource: string }>(backend, 'api/herdr/connect', { source: session, session: request.herdrSession || '' }) : undefined;
    const read = request.readPath ? await api<{ path: string }>(backend, 'api/plugins/read?' + new URLSearchParams({ path: request.readPath, session })) : undefined;
    const plugin = plugins.get(request.pluginId, request.pluginVersion);
    if (!plugin) throw new Error('This plugin is no longer available.');
    const tab: TerminalTab = { id: crypto.randomUUID(), pluginId: plugin.id, pluginVersion: plugin.version, pluginState: null, readPath: read?.path, ownsSession: true,
      session, backendId: backend.id, hostId: host.id, name: plugin.name + ' · ' + host.name + (target?.herdrSession ? ' · ' + target.herdrSession : ''), lastUsed: Date.now(),
      ...(target ? { mode: 'herdr', herdrSession: target.herdrSession, herdrSource: target.herdrSource } : {}) };
    tabs.push(tab); active = tab.id; store(); show('terminal'); await mount(tab);
  } catch (error) { await api(backend, 'api/sessions/close', {}, session).catch(() => {}); throw error; }
}
async function connectHost(host: HostProfile, request: ConnectionRequest) {
  const backend = backendFor(host.backendId); await authenticate(backend);
  // Older captured Herdr profiles retain their original transport descriptor.
  if (host.kind === 'herdr') {
    const existing = tabs.find(tab => tabPluginId(tab) === 'herdr' && tab.backendId === host.backendId && (tab.herdrSession || '') === (host.herdrSession || '') && tab.herdrSource === host.herdrSource);
    if (existing) { activate(existing.id); return; }
    const tab: TerminalTab = { id: crypto.randomUUID(), session: crypto.randomUUID(), name: host.name, backendId: backend.id, hostId: host.id, pluginId: 'herdr', pluginVersion: '1', mode: 'herdr', herdrSession: host.herdrSession, herdrSource: host.herdrSource, lastUsed: Date.now() };
    tabs.push(tab); active = tab.id; store(); show('terminal'); await mount(tab); return;
  }
  if (request.pluginId === 'herdr') {
    const existing = tabs.find(tab => tabPluginId(tab) === 'herdr' && tab.hostId === host.id && (tab.herdrSession || '') === (request.herdrSession || ''));
    if (existing) { activate(existing.id); return; }
  }
  if (host.kind === 'http') { const result = await api<{ id: string }>(backend, 'api/sessions', { name: host.name, files: request.pluginId !== 'terminal' }); await finishConnection(host, backend, result.id, request); return; }
  const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(backend, 'api/keychain'); vaults.set(backend.id, vault); sshHost = host; sshRequest = request;
  $('ssh-title').textContent = host.name; $('ssh-destination').textContent = `${host.username}@${host.hostname}:${host.port} · ${backend.name}`;
  select('ssh-key').replaceChildren(); const browserKeys = await browserVault.list();
  for (const key of browserKeys) select('ssh-key').add(new Option(key.name + ' · This browser', 'browser:' + key.id));
  for (const key of vault.keys) select('ssh-key').add(new Option(key.name + ' · ' + (key.reference ? key.reference.type === 'file' ? 'Backend file' : 'Backend agent' : backend.name), keyValue(key))); select('ssh-key').add(new Option('Account password', 'password'));
  const preferred = browserKeys.find(k => k.id === host.browserKeyId) || browserKeys.find(k => k.fingerprint === host.keyFingerprint);
  if (host.backendKeyId && vault.keys.some(key => key.id === host.backendKeyId)) select('ssh-key').value = keyValue(vault.keys.find(key => key.id === host.backendKeyId)!);
  else if (preferred) select('ssh-key').value = 'browser:' + preferred.id;
  else if (host.keyFingerprint && vault.keys.some(k => k.fingerprint === host.keyFingerprint)) select('ssh-key').value = keyValue(vault.keys.find(key => key.fingerprint === host.keyFingerprint)!);
  input('ssh-secret').value = ''; input('ssh-show-secret').checked = false; input('ssh-secret').type = 'password'; $('ssh-error').textContent = ''; $('ssh-progress').textContent = ''; sshSecretLabel();
  if (selectedBackendKey()?.reference) {
    await prepareRoute(); if (selectedRoute) { await connectSSH(); return; }
  }
  dialog('ssh-dialog').showModal(); void prepareRoute();
}
function sshSecretLabel() { input('ssh-secret').required = !selectedBackendKey()?.reference; $('ssh-secret-label').textContent = select('ssh-key').value === 'password' ? 'Account password' : 'Key passphrase'; }
select('ssh-key').onchange = () => { sshSecretLabel(); input('ssh-secret').value = ''; void prepareRoute(); };
input('ssh-show-secret').onchange = () => input('ssh-secret').type = input('ssh-show-secret').checked ? 'text' : 'password';
const routes = new Map<string, { at: number; backend: BackendProfile; keyId?: string }>();
async function chooseRoute(host: HostProfile, keyFingerprint: string): Promise<{ backend: BackendProfile; keyId?: string }> {
  const selected = backendFor(host.backendId), localKey = vaults.get(selected.id)?.keys.find(k => keyValue(k) === keyFingerprint);
  const portable = keyFingerprint === 'password' || keyFingerprint.startsWith('browser:');
  if (!portable && !localKey) throw new Error('Choose a key on this backend.');
  if (host.route === 'fixed' || localKey?.reference) return { backend: selected, keyId: localKey?.id };
  const key = JSON.stringify([host.id, keyFingerprint]), cached = routes.get(key); if (cached && Date.now() - cached.at < 60000) return cached;
  const candidates = backends.filter(b => b.id === selected.id || !!tokenFor(b));
  const measurements = await Promise.all(candidates.map(async backend => {
    try {
      const matching = portable ? undefined : (await api<{ keys: KeyInfo[] }>(backend, 'api/keychain')).keys.find(k => keyValue(k) === keyFingerprint); if (!portable && !matching) return;
      const samples: number[] = [];
      for (let i = 0; i < 2; i++) { const start = performance.now(); await api(backend, 'api/ssh/probe', { host: host.hostname, port: host.port, username: host.username }); samples.push(performance.now() - start); }
      return { backend, keyId: matching?.id, latency: (samples[0] + samples[1]) / 2 };
    } catch { return undefined; }
  }));
  const best = measurements.filter((m): m is NonNullable<typeof m> => !!m).sort((a, b) => a.latency - b.latency)[0];
  if (!best) throw new Error('No connected backend can reach this SSH host with the selected credentials.');
  routes.set(key, { ...best, at: Date.now() }); return best;
}
async function prepareRoute() {
  if (!sshHost) return;
  const generation = ++routeGeneration;
  selectedRoute = undefined; input('ssh-secret').disabled = true; $<HTMLButtonElement>('ssh-connect').disabled = true;
  $('ssh-error').textContent = ''; $('ssh-progress').textContent = 'Measuring available routes…';
  try {
    const route = await chooseRoute(sshHost, select('ssh-key').value);
    if (generation !== routeGeneration) return;
    selectedRoute = route; $('ssh-progress').textContent = 'Connect through ' + route.backend.name;
    $('ssh-secret-label').textContent = select('ssh-key').value === 'password' ? 'Account password' : select('ssh-key').value.startsWith('browser:') ? 'Key passphrase' : 'Key passphrase on ' + route.backend.name;
    input('ssh-secret').disabled = false; $<HTMLButtonElement>('ssh-connect').disabled = false; sshSecretLabel();
  } catch (error: any) { if (generation === routeGeneration) { $('ssh-error').textContent = error.message; $('ssh-progress').textContent = ''; } }
}
$<HTMLFormElement>('ssh-form').onsubmit = event => { event.preventDefault(); void connectSSH(); };
async function connectSSH() {
  if (!sshHost || !selectedRoute) return; const host = sshHost, request = sshRequest, control = $<HTMLButtonElement>('ssh-connect'); control.disabled = true; $('ssh-error').textContent = ''; $('ssh-progress').textContent = 'Choosing a route…';
  let ssh: SSHConnection | undefined;
  try {
    const selected = select('ssh-key').value, route = selectedRoute;
    $('ssh-progress').textContent = 'Connecting through ' + route.backend.name + '…';
    ssh = { host: host.hostname!, port: host.port!, username: host.username!, ...(selected.startsWith('browser:') ? { privateKey: await browserVault.unlock(selected.slice(8), input('ssh-secret').value), passphrase: input('ssh-secret').value } : route.keyId ? { keyId: route.keyId, passphrase: input('ssh-secret').value } : { password: input('ssh-secret').value }) };
    const create = () => api<{ id: string }>(route.backend, 'api/sessions', { name: host.name, ssh, files: request.pluginId !== 'terminal' });
    let result;
    try { result = await create(); } catch (error: any) {
      if (error.status !== 409 || !error.fingerprint || error.changed) throw error;
      if (!confirm(`Verify the fingerprint for ${ssh.host}:${ssh.port} through ${route.backend.name}:\n\n${error.fingerprint}\n\nTrust this host and connect?`)) throw new Error('Host verification cancelled.');
      ssh.trust = error.fingerprint; result = await create();
    }
    host.browserKeyId = selected.startsWith('browser:') ? selected.slice(8) : undefined;
    host.backendKeyId = selected.startsWith('backend:') ? selected.slice(8) : undefined;
    host.keyFingerprint = host.backendKeyId ? selectedBackendKey()?.fingerprint : host.browserKeyId ? (await browserVault.list()).find(k => k.id === host.browserKeyId)?.fingerprint : selected === 'password' ? undefined : selected; store(); dialog('ssh-dialog').close();
    await finishConnection(host, route.backend, result.id, request);
  } catch (error: any) { if (!dialog('ssh-dialog').open) dialog('ssh-dialog').showModal(); if (error.needsSecret) input('ssh-secret').required = true; $('ssh-error').textContent = error.message + (error.changed ? '\nVerify the new fingerprint before removing its Known hosts entry: ' + error.fingerprint : ''); }
  finally { if (ssh) { delete ssh.privateKey; delete ssh.passphrase; delete ssh.password; } input('ssh-secret').value = ''; control.disabled = false; $('ssh-progress').textContent = ''; }
};
function keyDetails(backend: BackendProfile | undefined, key: KeyInfo | BrowserKeyInfo) {
  keyDetail = { backend, key }; input('key-rename').value = key.name; $('key-fingerprint').textContent = key.fingerprint; $<HTMLTextAreaElement>('public-key').value = key.publicKey;
  const backups = 'backups' in key ? key.backups : [];
  $('key-storage').textContent = backend ? key.reference ? backend.name + ' · ' + key.reference.type + ': ' + key.reference.path : 'Stored on ' + backend.name : 'Source of truth: this browser.' + (backups.length ? ' Last backed up to: ' + backups.map(b => b.backendName + ' (' + new Date(b.savedAt).toLocaleDateString() + ')').join(', ') + '.' : ' No device backups yet.');
  for (const id of ['export-key-backup', 'export-private-key', 'backup-key']) $(id).hidden = !!backend;
  $('restore-backend-key').hidden = !backend || !!key.reference;
  $('delete-key').textContent = key.reference ? 'Remove reference' : 'Delete key';
  if (!dialog('key-details').open) dialog('key-details').showModal();
}
function downloadKey(contents: string, name: string, extension: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' })), link = document.createElement('a');
  link.href = url; link.download = (name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'ssh-key') + extension; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('copy-key').onclick = () => void navigator.clipboard.writeText($<HTMLTextAreaElement>('public-key').value).then(() => notice('Public key copied.')).catch(() => notice('Select the public key to copy it.'));
$('rename-key').onclick = () => {
  if (!keyDetail) return; const { backend, key } = keyDetail;
  void (backend ? api(backend, 'api/keychain', { action: 'rename', id: key.id, name: input('key-rename').value }) : browserVault.rename(key.id, input('key-rename').value)).then(() => { dialog('key-details').close(); void renderCards(); }).catch(error => notice(error.message));
};
$('delete-key').onclick = () => {
  if (!keyDetail) return; const { backend, key } = keyDetail;
  if (confirm(key.reference ? 'Remove this key reference? Its original file or agent identity will stay unchanged.' : 'Delete this private key from ' + (backend?.name || 'this browser') + '? Copies on other devices and existing SSH sessions will stay.')) void (backend ? api(backend, 'api/keychain', { action: 'delete', id: key.id }) : browserVault.remove(key.id)).then(() => { routes.clear(); dialog('key-details').close(); void renderCards(); }).catch(error => notice(error.message));
};
$('export-key-backup').onclick = () => { if (keyDetail && !keyDetail.backend) { const key = keyDetail.key; void browserVault.export(key.id).then(text => downloadKey(text, key.name, '.termai-key.json')).catch(error => notice(error.message)); } };
let transferMode: 'backup' | 'private' | 'restore' = 'backup';
function openTransfer(mode: typeof transferMode) {
  if (!keyDetail) return; transferMode = mode;
  $('key-transfer-title').textContent = { backup: 'Back up to devices', private: 'Export SSH private key', restore: 'Restore to this browser' }[mode];
  $('key-transfer-hint').textContent = { backup: 'Choose the backends that should keep an encrypted backup. This browser stays the source of truth. Unselected backups are left as they are.', private: 'This exports the original SSH key file. Generated keys are unencrypted in this format. Use “Export encrypted backup” for a password-protected copy.', restore: 'Unlock the backend copy and save it encrypted in this browser. The backend copy will remain as a backup.' }[mode];
  $('backup-devices').replaceChildren();
  if (mode === 'backup') for (const backend of backends) {
    const label = document.createElement('label'); label.className = 'toggle'; const check = document.createElement('input'); check.type = 'checkbox'; check.value = backend.id;
    const exists = 'backups' in keyDetail.key && keyDetail.key.backups.some(b => b.backendURL === backend.url);
    label.append(check, document.createTextNode(backend.name + ' · ' + backend.url + (exists ? ' (refresh backup)' : ''))); $('backup-devices').append(label);
  }
  $('key-transfer-submit').textContent = mode === 'backup' ? 'Back up selected devices' : mode === 'private' ? 'Download private key' : 'Restore key';
  $('key-transfer-error').textContent = ''; input('key-transfer-passphrase').value = ''; dialog('key-transfer').showModal();
}
$('backup-key').onclick = () => openTransfer('backup'); $('export-private-key').onclick = () => openTransfer('private'); $('restore-backend-key').onclick = () => openTransfer('restore');
$<HTMLFormElement>('key-transfer-form').onsubmit = async event => {
  event.preventDefault(); if (!keyDetail) return; const { backend, key } = keyDetail, mode = transferMode, passphrase = input('key-transfer-passphrase').value;
  const control = $<HTMLButtonElement>('key-transfer-submit'); control.disabled = true; $('key-transfer-error').textContent = '';
  try {
    if (mode === 'restore' && backend) {
      await authenticate(backend);
      const result = await api<KeyInfo & { privateKey: string }>(backend, 'api/keychain', { action: 'export', id: key.id, passphrase });
      const local = (await browserVault.list()).find(k => k.fingerprint === key.fingerprint) || await browserVault.create(key.name, passphrase, result);
      await browserVault.rememberBackup(local.id, { backendURL: backend.url, backendName: backend.name, keyId: key.id, savedAt: new Date().toISOString() });
      select('backend-filter').value = 'browser'; keyDetails(undefined, (await browserVault.list()).find(k => k.id === local.id)!);
    } else if (!backend) {
      const destinations = [...$('backup-devices').querySelectorAll<HTMLInputElement>('input:checked')].map(el => backendFor(el.value));
      if (mode === 'backup' && !destinations.length) throw new Error('Select a device to back up to.');
      const privateKey = await browserVault.unlock(key.id, passphrase);
      if (mode === 'private') downloadKey(privateKey, key.name, '.key');
      else {
        const failures: string[] = [];
        for (const device of destinations) {
          try {
            await authenticate(device);
            const local = (await browserVault.list()).find(k => k.id === key.id)!;
            const copy = await api<KeyInfo>(device, 'api/keychain', { action: 'backup', name: local.name, privateKey, passphrase, replaceId: local.backups.find(b => b.backendURL === device.url)?.keyId });
            await browserVault.rememberBackup(key.id, { backendURL: device.url, backendName: device.name, keyId: copy.id, savedAt: new Date().toISOString() });
          } catch (error: any) { failures.push(device.name + ': ' + error.message); }
        }
        keyDetails(undefined, (await browserVault.list()).find(k => k.id === key.id)!);
        if (failures.length) throw new Error('Successful backups were saved. Could not back up to: ' + failures.join('; '));
        notice('Backed up to ' + destinations.map(b => b.name).join(', ') + '.');
      }
    }
    dialog('key-transfer').close(); void renderCards();
  } catch (error: any) { $('key-transfer-error').textContent = error.message; }
  finally { input('key-transfer-passphrase').value = ''; control.disabled = false; }
};
select('key-method').onchange = () => { $('key-import-label').hidden = select('key-method').value !== 'import'; $<HTMLTextAreaElement>('key-import').required = select('key-method').value === 'import'; };
input('key-import-file').onchange = async () => {
  const file = input('key-import-file').files?.[0]; if (!file) return;
  $<HTMLTextAreaElement>('key-import').value = ''; $('key-error').textContent = '';
  if (file.size > 100000) { $('key-error').textContent = 'This key file is too large.'; input('key-import-file').value = ''; return; }
  try { const text = await file.text(); if (dialog('key-dialog').open && input('key-import-file').files?.[0] === file) $<HTMLTextAreaElement>('key-import').value = text; }
  catch { $('key-error').textContent = 'Could not read this key file.'; }
};
$<HTMLFormElement>('key-form').onsubmit = async event => {
  event.preventDefault(); const control = $('key-form').querySelector<HTMLButtonElement>('[type=submit]')!; control.disabled = true; $('key-error').textContent = '';
  try {
    const passphrase = input('key-passphrase').value, name = input('key-name').value;
    if (passphrase !== input('key-confirm').value) throw new Error('Passphrases do not match.');
    let key: BrowserKeyInfo;
    if (select('key-method').value === 'import') {
      const raw = $<HTMLTextAreaElement>('key-import').value.trim();
      if (raw.startsWith('{')) key = await browserVault.restore(raw, passphrase, name);
      else { await authenticate(primary); const info = await api<{ publicKey: string; fingerprint: string }>(primary, 'api/keychain', { action: 'inspect', privateKey: raw, passphrase }); key = await browserVault.create(name, passphrase, { privateKey: raw, ...info }); }
    } else key = await browserVault.create(name, passphrase);
    dialog('key-dialog').close(); select('backend-filter').value = 'browser'; void renderCards(); keyDetails(undefined, key);
  } catch (error: any) { $('key-error').textContent = error.message; }
  finally { input('key-passphrase').value = input('key-confirm').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; input('key-import-file').value = ''; control.disabled = false; }
};
for (const element of document.querySelectorAll<HTMLElement>('[data-close]')) element.onclick = () => dialog(element.dataset.close!).close();
for (const id of ['ssh-dialog', 'key-dialog', 'backend-login', 'key-transfer']) dialog(id).addEventListener('close', () => { for (const secret of dialog(id).querySelectorAll<HTMLInputElement>('input[type=password]')) secret.value = ''; input('ssh-secret').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; input('key-import-file').value = ''; });
$('terminal-back').onclick = $('add-tab').onclick = $('empty-open').onclick = () => show('hosts');
$('page-back').onclick = () => show(['vault', 'settings'].includes(page) ? 'terminal' : 'vault');
$('nav-vault').onclick = () => show('vault'); $('nav-terminals').onclick = () => show('terminal');
$('nav-settings').onclick = () => show('settings');
function preferencesChanged(key: string, value: unknown) {
  try { localStorage.setItem('termai.' + key, JSON.stringify(value)); }
  catch { notice('Browser storage is unavailable. Settings could not be saved.'); return; }
  for (const view of pluginViews.values()) view.applySettings?.();
}
function currentShortcuts() { try { return validateShortcuts(saved('shortcuts', defaults)); } catch { return structuredClone(defaults); } }
function renderSettings() {
  herdrNotifications.render($('herdr-notifications'), backends, notice);
  renderPluginSettings();
  select('herdr-layout').value = saved<string>('herdrLayout', 'reflow') === 'full-width' ? 'full-width' : 'reflow';
  select('herdr-strip').value = saved<string>('herdrStrip', 'spaces') === 'agents' ? 'agents' : 'spaces';
  input('show-downloads').checked = saved('showDownloads', true);
  input('font-size').value = String(saved('fontSizePt', 10)); if (!input('font-size').checkValidity()) input('font-size').value = '10';
  input('auto-alternatives').checked = saved('autoAlternatives', true) && !saved('justRun', false); input('tap-alternate-send').checked = saved('tapAlternateSend', true);
  $<HTMLTextAreaElement>('reading-phrases').value = readingPhrases(saved('readingPhrases', defaultReadingPhrases)).join('\n');
  const tab = tabs.find(tab => tab.id === active); $('settings-terminal').hidden = !tab || !pluginViews.get(tab.id)?.copySelection; $('settings-restart').hidden = !tab || tabPluginId(tab) !== 'terminal';
  $('settings-terminal-name').textContent = tab ? tabLabel(tab) + ' · ' + backendFor(tab.backendId).name : '';
}
function savePlugins(entries: InstalledPlugin[]) {
  localStorage.setItem('termai.plugins', JSON.stringify(entries)); installedPlugins = entries;
}
function refreshPluginTabs(id: string) {
  for (const tab of tabs.filter(tab => tabPluginId(tab) === id)) { unmount(tab); void mount(tab); }
  renderTabs(); renderPluginSettings();
}
function renderPluginSettings() {
  const list = $('plugin-list'); list.replaceChildren();
  const defaults = document.createElement('p'); defaults.textContent = 'Included: Terminal · SFTP / Files · Herdr · Reading Mode'; list.append(defaults);
  const current = new Map(installedPlugins.map(entry => [entry.package.manifest.id, entry]));
  for (const [id, entry] of current) {
    const row = document.createElement('div'); row.className = 'plugin-entry';
    const name = document.createElement('strong'); name.textContent = entry.package.manifest.name + ' · ' + entry.package.manifest.version;
    const detail = document.createElement('p'); detail.textContent = id + ' · Reads the file you select when connecting.';
    const label = document.createElement('label'); label.className = 'toggle'; const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = entry.enabled; enabled.setAttribute('aria-label', 'Enable ' + entry.package.manifest.name);
    enabled.onchange = () => {
      try { savePlugins(installedPlugins.map(item => item.package.manifest.id === id ? { ...item, enabled: enabled.checked } : item)); plugins.enable(id, enabled.checked); refreshPluginTabs(id); }
      catch (error: any) { enabled.checked = !enabled.checked; notice(error.message); }
    };
    label.append(enabled, document.createTextNode('Enabled'));
    const remove = button('Remove plugin', () => {
      try { savePlugins(installedPlugins.filter(item => item.package.manifest.id !== id)); plugins.remove(id); refreshPluginTabs(id); }
      catch (error: any) { notice(error.message); }
    }, 'secondary');
    row.append(name, detail, label, remove); list.append(row);
  }
}
input('plugin-file').onchange = () => {
  const file = input('plugin-file').files?.[0]; if (!file) return;
  void (async () => {
    $('plugin-install-error').textContent = '';
    try {
      if (file.size > MAX_PLUGIN_BYTES) throw new Error('Plugin packages are limited to 256 KB.');
      const pkg = parsePluginPackage(JSON.parse(await file.text()));
      if (installedPlugins.some(entry => entry.package.manifest.id === pkg.manifest.id && entry.package.manifest.version === pkg.manifest.version)) throw new Error('This plugin version is already installed. Use a new version to update it.');
      if (installedPlugins.length >= 16) throw new Error('At most 16 plugin versions can be installed.');
      savePlugins([...installedPlugins.map(entry => entry.package.manifest.id === pkg.manifest.id ? { ...entry, enabled: true } : entry), { package: pkg, enabled: true }]);
      registerExternal(pkg); plugins.enable(pkg.manifest.id, true); refreshPluginTabs(pkg.manifest.id);
      notice(pkg.manifest.name + ' loaded. Open a host’s menu to connect.');
    } catch (error: any) { $('plugin-install-error').textContent = error.message || 'Could not load this package.'; }
    finally { input('plugin-file').value = ''; }
  })();
};
select('herdr-strip').onchange = () => preferencesChanged('herdrStrip', select('herdr-strip').value);
select('herdr-layout').onchange = () => preferencesChanged('herdrLayout', select('herdr-layout').value);
input('show-downloads').onchange = () => preferencesChanged('showDownloads', input('show-downloads').checked);
input('font-size').oninput = () => { if (input('font-size').checkValidity()) preferencesChanged('fontSizePt', input('font-size').valueAsNumber); };
input('font-size').onchange = () => { if (!input('font-size').checkValidity()) input('font-size').value = String(saved('fontSizePt', 10)); };
input('auto-alternatives').onchange = () => { try { localStorage.removeItem('termai.justRun'); } catch {} preferencesChanged('autoAlternatives', input('auto-alternatives').checked); };
input('tap-alternate-send').onchange = () => preferencesChanged('tapAlternateSend', input('tap-alternate-send').checked);
$('save-reading-phrases').onclick = () => {
  const lines = $<HTMLTextAreaElement>('reading-phrases').value.split('\n').map(line => line.trim()).filter(Boolean);
  const phrases = readingPhrases(lines);
  if (phrases.length !== lines.length || !phrases.length) { $('reading-phrases-error').textContent = 'Enter 1–12 distinct phrases, one per line (up to 50 characters each).'; return; }
  $('reading-phrases-error').textContent = ''; preferencesChanged('readingPhrases', phrases); notice('Reading phrases saved.');
};
const prepareEditor = shortcutEditor(currentShortcuts, value => preferencesChanged('shortcuts', value), () => $('shortcut-settings').hidden = true);
$('customize-shortcuts').onclick = () => { prepareEditor(); $('shortcut-settings').hidden = false; $('shortcut-settings').scrollIntoView({ block: 'nearest' }); };
$('cancel-shortcuts').onclick = () => $('shortcut-settings').hidden = true;
for (const [id, action] of [['settings-copy', 'copy-selection'], ['settings-restart', 'new-shell']]) $(id).onclick = () => { if (action === 'copy-selection') pluginViews.get(active)?.copySelection?.(); else frames.get(active)?.contentWindow?.postMessage({ type: 'settings-action', action }, location.origin); };

$('library-add').onclick = () => {
  if (page === 'hosts') editHost();
  else if (page === 'backends') { $<HTMLFormElement>('backend-form').reset(); $('backend-error').textContent = ''; dialog('backend-dialog').showModal(); }
  else { $<HTMLFormElement>('key-form').reset(); $('key-import-label').hidden = true; $<HTMLTextAreaElement>('key-import').required = false; $('key-error').textContent = ''; dialog('key-dialog').showModal(); }
};
input('search').oninput = () => void renderCards(); select('backend-filter').onchange = () => void renderCards();
$('sort-hosts').onclick = () => { alphabetical = !alphabetical; $('sort-hosts').setAttribute('aria-pressed', String(alphabetical)); void renderCards(); };
function viewport() { document.documentElement.style.setProperty('--height', `${window.visualViewport?.height || innerHeight}px`); }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
document.addEventListener('visibilitychange', () => { for (const [id, view] of pluginViews) view.setVisible(id === active && page === 'terminal' && !document.hidden); });
show('terminal');
async function boot() {
  try {
    if (!tabs.length) await addTerminal(primary, 'default', 'This machine', 'local');
    else { if (!tabs.some(tab => tab.id === active)) active = tabs[0].id; store(); renderTabs(); await Promise.all(tabs.map(tab => mount(tab).catch(error => notice(error.message)))); }
    await consumePendingReading();
    await consumePendingHerdr();
    const route = new URLSearchParams(location.search);
    if (route.has('notificationTab')) { await openHerdrNotification(route.get('notificationTab'), route.get('notificationTerminal')); route.delete('notificationTab'); route.delete('notificationTerminal'); history.replaceState(null, '', location.pathname + (route.size ? '?' + route : '') + location.hash); }
  } catch (error: any) { $('empty-terminal').querySelector('p')!.textContent = error.message; }
}
void boot();
async function openHerdrNotification(tabId: unknown, terminalId: unknown) {
  const tab = tabs.find(tab => tab.id === tabId && tabPluginId(tab) === 'herdr');
  if (!tab) { notice('This Herdr connection has closed. Open its host to view the agent.'); return; }
  active = tab.id; store(); show('terminal'); await mount(tab); renderTabs();
  if (typeof terminalId === 'string') herdrViews.get(tab.id)?.openTerminal(terminalId);
}
navigator.serviceWorker?.addEventListener('message', event => { if (event.data?.type === 'herdr-notification') void openHerdrNotification(event.data.tabId, event.data.terminalId).catch(error => notice(error.message)); });
async function consumePendingHerdr() {
  try {
    const key = 'termai.pendingHerdr:' + new URL('.', document.baseURI).pathname;
    const raw = sessionStorage.getItem(key); if (!raw) return; sessionStorage.removeItem(key);
    const request = JSON.parse(raw);
    if (typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id) || typeof request.session !== 'string' || !(request.session === 'default' || /^[a-f0-9-]{36}$/.test(request.session))) return;
    const url = backendURL(request.backendUrl);
    let backend = backends.find(backend => backend.url === url);
    if (!backend) { backend = { id: crypto.randomUUID(), name: new URL(url).host, url }; backends.push(backend); }
    let source = tabs.find(tab => tabPluginId(tab) === 'terminal' && tab.backendId === backend.id && tab.session === request.session);
    if (!source) {
      source = { id: crypto.randomUUID(), name: backend.name, backendId: backend.id, session: request.session, lastUsed: Date.now() };
      tabs.push(source); store(); await mount(source);
    }
    await capturedHerdr(backend, source, request.id);
  } catch (error: any) { notice(error.message || 'Herdr could not open.'); }
}
async function consumePendingReading() {
  try {
    const key = 'termai.pendingReading:' + new URL('.', document.baseURI).pathname;
    const raw = sessionStorage.getItem(key); if (!raw) return;
    sessionStorage.removeItem(key);
    const request = JSON.parse(raw);
    const captured = typeof request.capture === 'string' && /^[a-f0-9]{32}$/.test(request.capture) && typeof request.name === 'string' && request.name.length <= 180 && Number.isInteger(request.exitCode) && request.exitCode >= 0 && request.exitCode <= 255;
    if ((!captured && (typeof request.path !== 'string' || !request.path || request.path.length > 4096 || /[\x00-\x1f\x7f]/.test(request.path))) ||
      typeof request.backendUrl !== 'string' || typeof request.session !== 'string' || !(request.session === 'default' || /^[a-f0-9-]{36}$/.test(request.session))) return;
    const url = backendURL(request.backendUrl);
    let backend = backends.find(item => item.url === url);
    if (!backend) { backend = { id: crypto.randomUUID(), name: new URL(url).host, url }; backends.push(backend); }
    let source = tabs.find(tab => tabPluginId(tab) === 'terminal' && tab.backendId === backend.id && tab.session === request.session);
    if (!source) {
      source = { id: crypto.randomUUID(), name: backend.name, backendId: backend.id, session: request.session, lastUsed: Date.now() };
      tabs.push(source); store(); await mount(source);
    }
    if (captured) openReadingCapture(source, request.capture, request.name, request.exitCode); else openReading(source, request.path);
  } catch (error: any) { notice(error?.message || 'Reading Mode could not open this file.'); }
}
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: new URL('.', document.baseURI).pathname }).catch(() => {});
