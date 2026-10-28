import {
  hostIcon,
  keyIcon,
  backendIcon,
  shieldIcon,
  ellipsisIcon,
  chevronDownIcon,
  chevronIcon,
} from './icons.ts';
import { forgetBackendAccess } from './backend-access.ts';
import { BrowserVault } from './browser-vault.ts';
import {
  backendURL,
  sshAddress,
  type BackendProfile,
  type HostProfile,
  type KeyInfo,
  type KnownHost,
  type TerminalTab,
} from './connections.ts';
import { $, button, dialog, input, select } from './dom.ts';
import { HerdrNotifications } from './herdr-notifications.ts';
import { herdrSession } from './herdr-protocol.ts';
import { vaultUI } from './vault-ui.ts';
import type { WorkspacePage, WorkspaceServices, WorkspaceState } from './workspace-storage.ts';
interface Options
  extends Pick<WorkspaceServices, 'api' | 'authenticate' | 'backendFor' | 'store' | 'notice'> {
  workspace: WorkspaceState;
  closeHostMenu: (focus?: boolean) => void;
  show: (view: WorkspacePage) => void;
  openHost: (host: HostProfile) => Promise<void>;
  hostTabs: (host: HostProfile) => TerminalTab[];
  openHostMenu: (host: HostProfile, anchor: HTMLButtonElement) => void;
  hostMenu: HTMLDivElement;
  herdrNotifications: HerdrNotifications;
  routes: Map<
    string,
    { at: number; backend: BackendProfile; keyId?: string; compression?: boolean }
  >;
  tokens: Map<string, string>;
  browserVault: BrowserVault;
  vaults: Map<string, { keys: KeyInfo[]; knownHosts: KnownHost[] }>;
  primary: BackendProfile;
  navigation: { readonly page: WorkspacePage };
}
export function createWorkspaceLibrary(options: Options) {
  const {
    workspace,
    closeHostMenu,
    show,
    backendFor,
    openHost,
    notice,
    hostTabs,
    openHostMenu,
    hostMenu,
    authenticate,
    herdrNotifications,
    routes,
    tokens,
    store,
    browserVault,
    api,
    vaults,
    primary,
    navigation,
  } = options;
  let alphabetical = false,
    editingHost: string | undefined;
  function populate(id: string, selected = 'primary', extra = false, browser = false) {
    const element = select(id);
    element.replaceChildren();
    if (browser) element.add(new Option('This browser', 'browser'));
    for (const backend of workspace.backends) element.add(new Option(backend.name, backend.id));
    if (extra) element.add(new Option('New direct backend…', 'new'));
    element.value = selected;
    if (!element.value) element.value = browser ? 'browser' : 'primary';
  }
  function card(
    name: string,
    detail: string,
    iconHTML: string,
    action: () => void,
    edit?: () => void,
    badge?: string,
  ) {
    const row = document.createElement('div');
    row.className = 'card';
    const main = button('', action, 'card-main'),
      glyph = document.createElement('span');
    glyph.className = 'card-icon';
    glyph.innerHTML = iconHTML;
    glyph.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'card-text';
    const title = document.createElement('span');
    title.className = 'card-name';
    title.textContent = name;
    if (badge) {
      const tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = badge;
      title.append(document.createTextNode(' '), tag);
    }
    const subtitle = document.createElement('span');
    subtitle.className = 'card-detail';
    subtitle.textContent = detail;
    text.append(title, subtitle);
    main.append(glyph, text);
    row.append(main);
    if (edit) {
      const b = button('', edit, 'card-edit');
      b.innerHTML = ellipsisIcon;
      b.setAttribute('aria-label', 'Edit ' + name);
      row.append(b);
    }
    $('cards').append(row);
    return row;
  }
  let rendering = 0;
  async function renderCards() {
    closeHostMenu();
    const generation = ++rendering;
    $('cards').replaceChildren();
    $('list-empty').hidden = true;
    const query = input('search').value.trim().toLowerCase();
    const matches = (value: string) => value.toLowerCase().includes(query);
    const items = <T extends { name: string }>(values: T[]) =>
      alphabetical ? [...values].sort((a, b) => a.name.localeCompare(b.name)) : values;
    $('list-heading').textContent = {
      terminal: '',
      settings: '',
      hosts: 'Saved hosts',
      vault: 'Your workspace',
      keychain: 'SSH keys',
      backends: 'Direct backends',
      known: 'Verified fingerprints',
    }[navigation.page];
    if (navigation.page === 'vault') {
      for (const [name, detail, icon, view] of [
        ['Hosts', `${workspace.hosts.length} saved`, hostIcon, 'hosts'],
        ['Keychain', 'Encrypted SSH keys', keyIcon, 'keychain'],
        ['Backends', `${workspace.backends.length} available`, backendIcon, 'backends'],
        ['Known hosts', 'SSH host fingerprints', shieldIcon, 'known'],
      ] as const) {
        const row = card(name, detail, icon, () => show(view));
        row.classList.add('vault-card');
        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.innerHTML = chevronIcon;
        row.querySelector('.card-main')!.append(chevron);
      }
    } else if (navigation.page === 'hosts') {
      for (const host of items(workspace.hosts).filter((h) =>
        matches(h.name + ' ' + (h.hostname || backendFor(h.backendId).url)),
      )) {
        const row = card(
          host.name,
          host.kind === 'ssh'
            ? `${host.username}@${host.hostname} · ${host.route === 'fixed' ? backendFor(host.backendId).name : 'Automatic route'}`
            : backendFor(host.backendId).url,
          hostIcon,
          () => void openHost(host).catch((error) => notice(error.message)),
          undefined,
          host.kind.toUpperCase(),
        );
        const count = hostTabs(host).length,
          menu = button('', () => openHostMenu(host, menu), 'host-terminals');
        menu.setAttribute('aria-label', `Terminals for ${host.name} (${count} open)`);
        menu.setAttribute('aria-haspopup', 'menu');
        menu.setAttribute('aria-expanded', 'false');
        menu.setAttribute('aria-controls', hostMenu.id);
        const number = document.createElement('span');
        number.className = 'host-terminal-count';
        number.textContent = String(count);
        const arrow = document.createElement('span');
        arrow.className = 'host-terminal-arrow';
        arrow.innerHTML = chevronDownIcon;
        arrow.setAttribute('aria-hidden', 'true');
        menu.append(number, arrow);
        row.append(menu);
      }
    } else if (navigation.page === 'backends') {
      for (const backend of workspace.backends.filter((b) => matches(b.name + ' ' + b.url)))
        card(
          backend.name,
          backend.url,
          backendIcon,
          () =>
            void authenticate(backend)
              .then(() => notice('Connected to ' + backend.name, 'done'))
              .catch((error) => notice(error.message)),
          backend.id === 'primary'
            ? undefined
            : () => {
                if (workspace.tabs.some((t) => t.backendId === backend.id)) {
                  notice('Close this backend’s tabs before removing it.', 'warning');
                  return;
                }
                if (
                  confirm(
                    'Remove this backend and its saved hosts? Its SSH keys will stay on the server.',
                  )
                )
                  void herdrNotifications
                    .forgetBackend(backend.id)
                    .then(() => {
                      workspace.backends = workspace.backends.filter((b) => b.id !== backend.id);
                      workspace.hosts = workspace.hosts.filter((h) => h.backendId !== backend.id);
                      routes.clear();
                      tokens.delete(backend.id);
                      forgetBackendAccess(backend.url);
                      store();
                      void renderCards();
                    })
                    .catch((error) => notice(error.message));
              },
          'HTTP',
        );
    } else if (navigation.page === 'keychain' || navigation.page === 'known') {
      const backend = backendFor(select('backend-filter').value);
      try {
        if (navigation.page === 'keychain' && select('backend-filter').value === 'browser') {
          const keys = await browserVault.list();
          if (generation !== rendering) return;
          for (const key of items(keys).filter((k) => matches(k.name)))
            card(
              key.name,
              key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() + ' · This browser',
              keyIcon,
              () => keyDetails(undefined, key),
            );
        } else {
          await authenticate(backend);
          const vault = await api<{ keys: KeyInfo[]; knownHosts: KnownHost[] }>(
            backend,
            'api/keychain',
          );
          vaults.set(backend.id, vault);
          if (generation !== rendering) return;
          if (navigation.page === 'keychain')
            for (const key of items(vault.keys).filter((k) => matches(k.name)))
              card(
                key.name,
                key.publicKey.split(' ')[0].replace('ssh-', '').toUpperCase() +
                  ' · ' +
                  (key.reference
                    ? key.reference.type === 'file'
                      ? 'Backend file'
                      : 'Backend agent'
                    : backend.name),
                keyIcon,
                () => keyDetails(backend, key),
              );
          else
            for (const item of vault.knownHosts.filter((k) => matches(k.host)))
              card(
                item.host + ':' + item.port,
                item.fingerprint,
                shieldIcon,
                () => notice(item.fingerprint, 'info'),
                () => {
                  if (
                    confirm(
                      'Forget this SSH host fingerprint? Verify its identity again before your next connection.',
                    )
                  )
                    void api(backend, 'api/keychain', {
                      action: 'forget',
                      host: item.host,
                      port: item.port,
                    })
                      .then(() => renderCards())
                      .catch((error) => notice(error.message));
                },
              );
        }
      } catch (error: any) {
        if (generation === rendering) notice(error.message);
      }
    }
    if (!$('cards').children.length) {
      $('list-empty').textContent = query
        ? 'No matches.'
        : navigation.page === 'keychain'
          ? 'Add an SSH key to connect securely. New keys are stored encrypted in this browser.'
          : navigation.page === 'known'
            ? 'Verified SSH hosts will appear here after you connect.'
            : 'Add a host to open your next terminal.';
      $('list-empty').hidden = false;
    }
  }
  function editHost(host?: HostProfile) {
    editingHost = host?.id;
    $('host-dialog-title').textContent = host ? 'Edit host' : 'New host';
    input('host-name').value = host?.name || '';
    select('host-kind').value = host?.kind || 'http';
    populate('host-backend', host?.backendId || 'primary', true);
    input('host-url').value = backendFor(host?.backendId || 'primary').url;
    input('host-address').value = host?.hostname || '';
    input('host-user').value = host?.username || '';
    input('host-port').value = String(host?.port || 22);
    select('host-route').value = host?.route || 'auto';
    input('host-herdr-session').value = host?.herdrSession || '';
    $('delete-host').hidden = !host;
    $('host-error').textContent = '';
    hostFields();
    dialog('host-dialog').showModal();
  }
  function hostFields() {
    const ssh = select('host-kind').value === 'ssh',
      herdr = select('host-kind').value === 'herdr';
    $('direct-fields').hidden = ssh;
    $('ssh-fields').hidden = !ssh;
    $('herdr-fields').hidden = !herdr;
    input('host-url').required = !ssh;
    input('host-address').required = input('host-user').required = ssh;
    const newOption = select('host-backend').querySelector<HTMLOptionElement>('option[value=new]')!;
    newOption.disabled = ssh;
    if (ssh && select('host-backend').value === 'new') select('host-backend').value = 'primary';
  }
  select('host-kind').onchange = hostFields;
  select('host-backend').onchange = () => {
    input('host-url').value =
      select('host-backend').value === 'new' ? '' : backendFor(select('host-backend').value).url;
  };
  $<HTMLFormElement>('host-form').onsubmit = (event) => {
    event.preventDefault();
    try {
      const name = input('host-name').value.trim();
      if (!name) throw new Error('Name this host.');
      const kind = select('host-kind').value as HostProfile['kind'];
      let backendId = select('host-backend').value;
      if (kind === 'http' || kind === 'herdr') {
        const url = backendURL(input('host-url').value);
        let backend = workspace.backends.find((b) => b.url === url);
        if (!backend) {
          backend = { id: crypto.randomUUID(), name, url };
          workspace.backends.push(backend);
        }
        backendId = backend.id;
      }
      const host: HostProfile = { id: editingHost || crypto.randomUUID(), name, kind, backendId };
      if (kind === 'ssh') {
        const address = sshAddress({
          host: input('host-address').value,
          username: input('host-user').value,
          port: Number(input('host-port').value),
        });
        Object.assign(host, {
          hostname: address.host,
          username: address.username,
          port: address.port,
          route: select('host-route').value,
        });
      }
      if (kind === 'herdr') host.herdrSession = herdrSession(input('host-herdr-session').value);
      const index = workspace.hosts.findIndex((h) => h.id === editingHost);
      if (index >= 0) {
        host.keyFingerprint = workspace.hosts[index].keyFingerprint;
        host.browserKeyId = workspace.hosts[index].browserKeyId;
        host.backendKeyId = workspace.hosts[index].backendKeyId;
        workspace.hosts[index] = host;
      } else workspace.hosts.push(host);
      routes.clear();
      store();
      dialog('host-dialog').close();
      show('hosts');
    } catch (error: any) {
      $('host-error').textContent = error.message;
    }
  };
  $('delete-host').onclick = () => {
    if (confirm('Delete this saved host? Open terminals will keep running.')) {
      workspace.hosts = workspace.hosts.filter((h) => h.id !== editingHost);
      routes.clear();
      store();
      dialog('host-dialog').close();
      void renderCards();
    }
  };
  $<HTMLFormElement>('backend-form').onsubmit = (event) => {
    event.preventDefault();
    try {
      const url = backendURL(input('backend-url').value);
      if (workspace.backends.some((b) => b.url === url))
        throw new Error('This backend is already saved.');
      workspace.backends.push({
        id: crypto.randomUUID(),
        name: input('backend-name').value.trim(),
        url,
      });
      store();
      dialog('backend-dialog').close();
      void renderCards();
    } catch (error: any) {
      $('backend-error').textContent = error.message;
    }
  };
  const keyDetails = vaultUI({
    browserVault,
    primary,
    backends: () => workspace.backends,
    backendFor,
    authenticate,
    api,
    notice,
    renderCards,
    clearRoutes: () => routes.clear(),
  });
  $('library-add').onclick = () => {
    if (navigation.page === 'hosts') editHost();
    else if (navigation.page === 'backends') {
      $<HTMLFormElement>('backend-form').reset();
      $('backend-error').textContent = '';
      dialog('backend-dialog').showModal();
    } else {
      $<HTMLFormElement>('key-form').reset();
      $('key-import-label').hidden = true;
      $<HTMLTextAreaElement>('key-import').required = false;
      $('key-error').textContent = '';
      dialog('key-dialog').showModal();
    }
  };
  input('search').oninput = () => void renderCards();
  select('backend-filter').onchange = () => void renderCards();
  $('sort-hosts').onclick = () => {
    alphabetical = !alphabetical;
    $('sort-hosts').setAttribute('aria-pressed', String(alphabetical));
    void renderCards();
  };
  return { populate, renderCards, editHost };
}
