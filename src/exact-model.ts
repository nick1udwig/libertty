import { publish } from '../target/exact-ui/.gen/bridge.js';

export interface WorkspaceCard {
  id: string;
  name: string;
  detail: string;
  icon: string;
  badge: string;
  editable: boolean;
}

export interface WorkspaceTab {
  id: string;
  name: string;
  title: string;
  icon: string;
  glyph: string;
  className: string;
  selected: boolean;
  controls: string;
  attention: number;
  attentionLabel: string;
}

let cards: WorkspaceCard[] = [];
export function clearWorkspaceCards() {
  cards = [];
  publish('workspaceCards', cards);
}

export function addWorkspaceCard(card: Omit<WorkspaceCard, 'id'>) {
  const id = String(cards.length);
  cards = [...cards, { ...card, id }];
  publish('workspaceCards', cards);
  return document.getElementById(`workspace-card-${id}`)!;
}

export function renderWorkspaceTabs(tabs: WorkspaceTab[]) {
  publish('workspaceTabs', tabs);
}

let hostMenu: { id: string; label: string; separator: boolean }[] = [];
export function clearWorkspaceHostMenu() {
  hostMenu = [];
  publish('workspaceHostMenu', hostMenu);
}
export function addWorkspaceHostAction(label: string, separator = false) {
  const id = String(hostMenu.length);
  hostMenu = [...hostMenu, { id, label, separator }];
  publish('workspaceHostMenu', hostMenu);
  return document.getElementById(`workspace-host-action-${id}`) as HTMLButtonElement;
}
export function renderWorkspaceShortcuts(
  shortcuts: {
    id: string;
    label: string;
    title: string;
    className: string;
    disabled: boolean;
    modifier: boolean;
    pressed: boolean;
  }[],
) {
  publish('workspaceShortcuts', shortcuts);
}
export function renderWorkspacePlugins(
  plugins: { id: string; name: string; version: string; enabled: boolean }[],
) {
  publish('workspacePluginSettings', plugins);
}
export function renderWorkspaceBackups(backends: { id: string; label: string }[]) {
  publish('workspaceBackupDevices', []);
  publish('workspaceBackupDevices', backends);
}

export function renderWorkspaceShortcutEditor(
  shortcuts: { label: string; kind: string; value: string }[],
) {
  publish(
    'workspaceShortcutEditor',
    shortcuts.map((shortcut, index) => ({
      ...shortcut,
      id: String(index),
      first: index === 0,
      last: index === shortcuts.length - 1,
    })),
  );
  return shortcuts.map((_, index) => document.getElementById(`workspace-shortcut-row-${index}`)!);
}
