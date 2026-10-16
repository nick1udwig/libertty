import type { HerdrAgent, HerdrSnapshot, HerdrSpace, HerdrStatus } from './herdr-protocol.ts';

const text = (value: unknown, limit = 1024): value is string => typeof value === 'string' && value.length <= limit;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const encoder = new TextEncoder();
function agent(value: unknown): HerdrAgent | undefined {
  if (!record(value) || !['terminalId', 'paneId', 'workspace', 'name', 'kind', 'cwd'].every(key => text(value[key]))
    || !value.terminalId || !value.paneId || !['idle', 'working', 'blocked', 'done', 'unknown'].includes(String(value.status)) || !sequence(value.sequence)) return;
  const result: HerdrAgent = { terminalId: value.terminalId as string, paneId: value.paneId as string, workspace: value.workspace as string,
    name: value.name as string, kind: value.kind as string, cwd: value.cwd as string, status: value.status as HerdrStatus, sequence: value.sequence };
  if (text(value.workspaceId)) result.workspaceId = value.workspaceId;
  if (text(value.tabId)) result.tabId = value.tabId;
  if (sequence(value.completion)) result.completion = value.completion;
  return result;
}
function space(value: unknown): HerdrSpace | undefined {
  if (!record(value) || !text(value.id) || !value.id || !text(value.name) || !Array.isArray(value.terminalIds)
    || value.terminalIds.length > 256 || !value.terminalIds.every(id => text(id))) return;
  const result: HerdrSpace = { id: value.id, name: value.name, terminalIds: [...value.terminalIds] };
  if (text(value.selectedTerminalId)) result.selectedTerminalId = value.selectedTerminalId;
  if (text(value.cwd)) result.cwd = value.cwd;
  if (text(value.checkoutPath)) result.checkoutPath = value.checkoutPath;
  if (typeof value.linkedWorktree === 'boolean') result.linkedWorktree = value.linkedWorktree;
  if (text(value.repoKey) && value.repoKey) result.repoKey = value.repoKey;
  if (text(value.repoName) && value.repoName) result.repoName = value.repoName;
  return result;
}
/** Retain bounded navigation metadata without history, credentials or opaque fields. */
export function herdrCache(value: unknown): HerdrSnapshot | undefined {
  if (!record(value) || !text(value.version, 128) || !sequence(value.protocol) || !Array.isArray(value.agents)
    || value.agents.length > 256 || value.terminals !== undefined && (!Array.isArray(value.terminals) || value.terminals.length > 256)
    || value.spaces !== undefined && (!Array.isArray(value.spaces) || value.spaces.length > 256)) return;
  const agents = value.agents.map(agent), terminals = (value.terminals as unknown[] | undefined)?.map(agent), spaces = (value.spaces as unknown[] | undefined)?.map(space);
  if (agents.some(value => !value) || terminals?.some(value => !value) || spaces?.some(value => !value)) return;
  const snapshot: HerdrSnapshot = { version: value.version, protocol: value.protocol, agents: agents as HerdrAgent[],
    ...(terminals ? { terminals: terminals as HerdrAgent[] } : {}), ...(spaces ? { spaces: spaces as HerdrSpace[] } : {}) };
  return encoder.encode(JSON.stringify(snapshot)).byteLength <= 256 * 1024 ? snapshot : undefined;
}
