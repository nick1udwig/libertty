import { type TerminalTab } from './connections.ts';
import { $, button, input, select } from './dom.ts';
import { HerdrNotifications } from './herdr-notifications.ts';
import { saved } from './persistence.ts';
import {
  MAX_PLUGIN_BYTES,
  parsePluginPackage,
  type InstalledPlugin,
  type PluginPackage,
} from './plugin-package.ts';
import { PluginRegistry, tabPluginId, type PluginView } from './plugins.ts';
import { defaultReadingPhrases, readingPhrases } from './reading-request.ts';
import { shortcutEditor } from './shortcut-editor.ts';
import { applyTheme, readTheme, watchSystemTheme } from './theme.ts';
import { defaults, validateShortcuts } from './shortcuts.ts';
import type { WorkspaceServices, WorkspaceState } from './workspace-storage.ts';
export function currentShortcuts() {
  try {
    return validateShortcuts(saved('shortcuts', defaults));
  } catch {
    return structuredClone(defaults);
  }
}
interface Options extends Pick<WorkspaceServices, 'backendFor' | 'notice' | 'fail'> {
  workspace: WorkspaceState;
  registerExternal: (pkg: PluginPackage) => void;
  plugins: PluginRegistry;
  pluginViews: Map<string, PluginView>;
  herdrNotifications: HerdrNotifications;
  tabLabel: (tab: TerminalTab) => string;
  unmount: (tab: TerminalTab) => void;
  mount: (tab: TerminalTab) => Promise<void>;
  renderTabs: () => void;
  frames: Map<string, HTMLIFrameElement>;
}
export function createWorkspaceSettings(options: Options) {
  const {
    workspace,
    registerExternal,
    plugins,
    notice,
    fail,
    pluginViews,
    herdrNotifications,
    tabLabel,
    backendFor,
    unmount,
    mount,
    renderTabs,
    frames,
  } = options;
  let installedPlugins: InstalledPlugin[] = [];
  try {
    for (const entry of saved<InstalledPlugin[]>('plugins', []).slice(0, 16)) {
      try {
        installedPlugins.push({
          package: parsePluginPackage(entry.package),
          enabled: entry.enabled === true,
        });
      } catch {
        /* Keep unavailable tabs until the package is installed again. */
      }
    }
  } catch {
    /* A corrupt plugin inventory cannot prevent terminal startup. */
  }
  for (const entry of installedPlugins) {
    try {
      registerExternal(entry.package);
      plugins.enable(entry.package.manifest.id, entry.enabled);
    } catch {
      /* Ignore duplicate or corrupt saved entries. */
    }
  }
  function preferencesChanged(key: string, value: unknown) {
    try {
      localStorage.setItem('libertty.' + key, JSON.stringify(value));
    } catch {
      notice('Browser storage is unavailable. Settings could not be saved.', 'warning');
      return;
    }
    for (const view of pluginViews.values()) view.applySettings?.();
  }

  function renderSettings() {
    herdrNotifications.render($('herdr-notifications'), workspace.backends, notice);
    renderPluginSettings();
    select('theme').value = readTheme();
    select('herdr-layout').value =
      saved<string>('herdrLayout', 'reflow') === 'full-width' ? 'full-width' : 'reflow';
    select('herdr-strip').value =
      saved<string>('herdrStrip', 'spaces') === 'agents' ? 'agents' : 'spaces';
    select('herdr-strip-order').value =
      saved<string>('herdrStripOrder', 'lanes') === 'manual' ? 'manual' : 'lanes';
    const spaceTap = saved<string>('herdrSpaceTap', 'recent');
    select('herdr-space-tap').value = ['triage', 'root', 'tree'].includes(spaceTap)
      ? spaceTap
      : 'recent';
    input('show-downloads').checked = saved('showDownloads', true);
    input('font-size').value = String(saved('fontSizePt', 10));
    if (!input('font-size').checkValidity()) input('font-size').value = '10';
    input('auto-alternatives').checked =
      saved('autoAlternatives', true) && !saved('justRun', false);
    input('tap-alternate-send').checked = saved('tapAlternateSend', true);
    $<HTMLTextAreaElement>('reading-phrases').value = readingPhrases(
      saved('readingPhrases', defaultReadingPhrases),
    ).join('\n');
    const tab = workspace.tabs.find((tab) => tab.id === workspace.active);
    $('settings-terminal').hidden = !tab || !pluginViews.get(tab.id)?.copySelection;
    $('settings-restart').hidden = !tab || tabPluginId(tab) !== 'terminal';
    $('settings-terminal-name').textContent = tab
      ? tabLabel(tab) + ' · ' + backendFor(tab.backendId).name
      : '';
  }
  function savePlugins(entries: InstalledPlugin[]) {
    localStorage.setItem('libertty.plugins', JSON.stringify(entries));
    installedPlugins = entries;
  }
  function refreshPluginTabs(id: string) {
    for (const tab of workspace.tabs.filter((tab) => tabPluginId(tab) === id)) {
      unmount(tab);
      void mount(tab);
    }
    renderTabs();
    renderPluginSettings();
  }
  function renderPluginSettings() {
    const list = $('plugin-list');
    list.replaceChildren();
    const defaults = document.createElement('p');
    defaults.textContent = 'Included: Terminal · SFTP / Files · Herdr · Reading Mode';
    list.append(defaults);
    const current = new Map(installedPlugins.map((entry) => [entry.package.manifest.id, entry]));
    for (const [id, entry] of current) {
      const row = document.createElement('div');
      row.className = 'plugin-entry';
      const name = document.createElement('strong');
      name.textContent = entry.package.manifest.name + ' · ' + entry.package.manifest.version;
      const detail = document.createElement('p');
      detail.textContent = id + ' · Reads the file you select when connecting.';
      const label = document.createElement('label');
      label.className = 'toggle';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = entry.enabled;
      enabled.setAttribute('aria-label', 'Enable ' + entry.package.manifest.name);
      enabled.onchange = () => {
        try {
          savePlugins(
            installedPlugins.map((item) =>
              item.package.manifest.id === id ? { ...item, enabled: enabled.checked } : item,
            ),
          );
          plugins.enable(id, enabled.checked);
          refreshPluginTabs(id);
        } catch (error: any) {
          enabled.checked = !enabled.checked;
          fail(error);
        }
      };
      label.append(enabled, document.createTextNode('Enabled'));
      const remove = button(
        'Remove plugin',
        () => {
          try {
            savePlugins(installedPlugins.filter((item) => item.package.manifest.id !== id));
            plugins.remove(id);
            refreshPluginTabs(id);
          } catch (error: any) {
            fail(error);
          }
        },
        'secondary',
      );
      row.append(name, detail, label, remove);
      list.append(row);
    }
  }
  input('plugin-file').onchange = () => {
    const file = input('plugin-file').files?.[0];
    if (!file) return;
    void (async () => {
      $('plugin-install-error').textContent = '';
      try {
        if (file.size > MAX_PLUGIN_BYTES) throw new Error('Plugin packages are limited to 256 KB.');
        const pkg = parsePluginPackage(JSON.parse(await file.text()));
        if (
          installedPlugins.some(
            (entry) =>
              entry.package.manifest.id === pkg.manifest.id &&
              entry.package.manifest.version === pkg.manifest.version,
          )
        )
          throw new Error(
            'This plugin version is already installed. Use a new version to update it.',
          );
        if (installedPlugins.length >= 16)
          throw new Error('At most 16 plugin versions can be installed.');
        savePlugins([
          ...installedPlugins.map((entry) =>
            entry.package.manifest.id === pkg.manifest.id ? { ...entry, enabled: true } : entry,
          ),
          { package: pkg, enabled: true },
        ]);
        registerExternal(pkg);
        plugins.enable(pkg.manifest.id, true);
        refreshPluginTabs(pkg.manifest.id);
        notice(pkg.manifest.name + ' loaded. Open a host’s menu to connect.', 'done');
      } catch (error: any) {
        $('plugin-install-error').textContent = error.message || 'Could not load this package.';
      } finally {
        input('plugin-file').value = '';
      }
    })();
  };
  select('theme').onchange = () => {
    preferencesChanged('theme', select('theme').value);
    applyTheme();
  };
  applyTheme();
  watchSystemTheme(() => applyTheme());
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === 'libertty.theme') applyTheme();
  });
  select('herdr-strip').onchange = () =>
    preferencesChanged('herdrStrip', select('herdr-strip').value);
  select('herdr-strip-order').onchange = () =>
    preferencesChanged('herdrStripOrder', select('herdr-strip-order').value);
  select('herdr-space-tap').onchange = () =>
    preferencesChanged('herdrSpaceTap', select('herdr-space-tap').value);
  select('herdr-layout').onchange = () =>
    preferencesChanged('herdrLayout', select('herdr-layout').value);
  input('show-downloads').onchange = () =>
    preferencesChanged('showDownloads', input('show-downloads').checked);
  input('font-size').oninput = () => {
    if (input('font-size').checkValidity())
      preferencesChanged('fontSizePt', input('font-size').valueAsNumber);
  };
  input('font-size').onchange = () => {
    if (!input('font-size').checkValidity())
      input('font-size').value = String(saved('fontSizePt', 10));
  };
  input('auto-alternatives').onchange = () => {
    try {
      localStorage.removeItem('libertty.justRun');
    } catch {}
    preferencesChanged('autoAlternatives', input('auto-alternatives').checked);
  };
  input('tap-alternate-send').onchange = () =>
    preferencesChanged('tapAlternateSend', input('tap-alternate-send').checked);
  $('save-reading-phrases').onclick = () => {
    const lines = $<HTMLTextAreaElement>('reading-phrases')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const phrases = readingPhrases(lines);
    if (phrases.length !== lines.length || !phrases.length) {
      $('reading-phrases-error').textContent =
        'Enter 1–12 distinct phrases, one per line (up to 50 characters each).';
      return;
    }
    $('reading-phrases-error').textContent = '';
    preferencesChanged('readingPhrases', phrases);
    notice('Reading phrases saved.', 'done');
  };
  const prepareEditor = shortcutEditor(
    currentShortcuts,
    (value) => preferencesChanged('shortcuts', value),
    () => ($('shortcut-settings').hidden = true),
  );
  $('customize-shortcuts').onclick = () => {
    prepareEditor();
    $('shortcut-settings').hidden = false;
    $('shortcut-settings').scrollIntoView({ block: 'nearest' });
  };
  $('cancel-shortcuts').onclick = () => ($('shortcut-settings').hidden = true);
  for (const [id, action] of [
    ['settings-copy', 'copy-selection'],
    ['settings-restart', 'new-shell'],
  ])
    $(id).onclick = () => {
      if (action === 'copy-selection') pluginViews.get(workspace.active)?.copySelection?.();
      else
        frames
          .get(workspace.active)
          ?.contentWindow?.postMessage({ type: 'settings-action', action }, location.origin);
    };
  return { renderSettings };
}
