import type { HerdrSpace } from './herdr-protocol.ts';

export interface SpaceLayout { order: string[]; groups: string[][] }
export type SpaceDrop = 'before' | 'after' | 'group';
export interface SpaceRepo { id: string; name: string; git: boolean; root?: HerdrSpace; spaces: HerdrSpace[] }

/** Worktree checkouts join their repository's root space; Herdr reports a repository only once it has a worktree, so other spaces stand alone. */
export function spaceRepos(spaces: HerdrSpace[]): SpaceRepo[] {
  const repos = new Map<string, SpaceRepo>();
  for (const space of spaces) {
    const id = space.repoKey ? 'repo:' + space.repoKey : 'space:' + space.id;
    const repo = repos.get(id) || { id, name: space.repoKey && space.repoName || space.name, git: !!space.repoKey, spaces: [] };
    repo.spaces.push(space); repos.set(id, repo);
  }
  for (const repo of repos.values()) {
    // New and open worktree actions must start from a checkout that is not itself a linked worktree.
    repo.root = repo.git ? repo.spaces.find(space => !space.linkedWorktree) : repo.spaces[0];
    if (repo.root) repo.spaces = [repo.root, ...repo.spaces.filter(space => space !== repo.root)];
  }
  return [...repos.values()];
}

/** A repository opens the space last used there, then its root checkout. */
export function repoSpace(repo: SpaceRepo, remembered?: string): HerdrSpace {
  return repo.spaces.find(space => space.id === remembered) || repo.spaces[0];
}

export function spaceTerminal(space: HerdrSpace, remembered?: string): string {
  return (remembered && space.terminalIds.includes(remembered) ? remembered : space.selectedTerminalId) || space.terminalIds[0] || '';
}

/** Match Herdr's desktop checkout preview; the server chooses the actual path. */
export function worktreePath(directory: string, repo: string, branch: string): string {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  return directory.replace(/\/$/, '') + '/' + repo + '/' + slug;
}

/** Stacks keep their Herdr spaces separate; only their strip presentation groups. */
export function spaceLayout(order: string[], groups: string[][], live = order): SpaceLayout {
  const ids = [...new Set([...order.filter(id => live.includes(id)), ...live])];
  const used = new Set<string>();
  const stacks: string[][] = [];
  for (const group of groups.filter(Array.isArray)) {
    const members = ids.filter(id => group.includes(id) && !used.has(id));
    if (members.length < 2) continue;
    members.forEach(id => used.add(id)); stacks.push(members);
  }
  const result: string[] = [], emitted = new Set<string>();
  for (const id of ids) {
    if (emitted.has(id)) continue;
    const members = stacks.find(group => group.includes(id)) || [id];
    result.push(...members); members.forEach(member => emitted.add(member));
  }
  return { order: result, groups: stacks };
}

export function dropSpace(layout: SpaceLayout, source: string, target: string, drop: SpaceDrop): SpaceLayout {
  if (source === target || !layout.order.includes(source) || !layout.order.includes(target)) return layout;
  const order = layout.order.filter(id => id !== source);
  const groups = layout.groups.map(group => group.filter(id => id !== source)).filter(group => group.length > 1);
  const group = groups.find(group => group.includes(target)), members = group || [target];
  const anchor = drop === 'before' ? members[0] : members.at(-1)!;
  order.splice(order.indexOf(anchor) + (drop === 'before' ? 0 : 1), 0, source);
  if (drop === 'group') {
    if (group) group.push(source); else groups.push([target, source]);
  }
  return spaceLayout(order, groups);
}
