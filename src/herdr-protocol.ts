export type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export interface HerdrAgent {
  terminalId: string; paneId: string; workspace: string; name: string; kind: string;
  workspaceId?: string; tabId?: string;
  status: HerdrStatus; sequence: number; completion?: number; cwd: string;
}
export interface HerdrSpace { id: string; name: string; terminalIds: string[]; selectedTerminalId?: string; cwd?: string; linkedWorktree?: boolean; checkoutPath?: string; repoKey?: string; repoName?: string }
export interface HerdrSnapshot { version: string; protocol: number; agents: HerdrAgent[]; terminals?: HerdrAgent[]; spaces?: HerdrSpace[]; worktreeDirectory?: string }
export interface HerdrWorktrees {
  source: { repo_name: string; repo_root: string };
  worktrees: { path: string; branch?: string; label: string; is_bare: boolean; is_prunable: boolean; open_workspace_id?: string }[];
  directory?: string;
  branches?: string[];
}
export type HerdrMessage =
  | { type: 'snapshot'; snapshot: HerdrSnapshot }
  | { type: 'error'; message: string; terminalId?: string };

export function herdrSession(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === 'default') return '';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Use a Herdr session name containing letters, numbers, hyphens or underscores.');
  return value;
}
export function herdrName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a name of 1–100 characters.');
  return value.trim();
}
