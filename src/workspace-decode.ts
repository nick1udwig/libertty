import {
  backendURL,
  sshAddress,
  type BackendProfile,
  type HostProfile,
  type TerminalTab,
} from './connections.ts';
import { validCapture, validPath, validSession } from './persistence.ts';
import { herdrSession } from './herdr-protocol.ts';
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: Record<string, unknown>) {
  return typeof value.id === 'string' && !!value.id && typeof value.name === 'string';
}
export function decodeBackend(value: unknown): BackendProfile | undefined {
  if (!record(value) || !identity(value) || value.id === 'primary' || typeof value.url !== 'string')
    return;
  try {
    return { id: value.id as string, name: value.name as string, url: backendURL(value.url) };
  } catch {
    return;
  }
}
export function decodeHost(value: unknown, backends: Set<string>): HostProfile | undefined {
  if (
    !record(value) ||
    !identity(value) ||
    typeof value.backendId !== 'string' ||
    !backends.has(value.backendId)
  )
    return;
  if (!['http', 'ssh', 'herdr'].includes(String(value.kind))) return;
  const host: HostProfile = {
    id: value.id as string,
    name: value.name as string,
    backendId: value.backendId,
    kind: value.kind as HostProfile['kind'],
  };
  for (const key of [
    'keyFingerprint',
    'browserKeyId',
    'backendKeyId',
    'herdrSource',
    'herdrSourceHostId',
  ] as const)
    if (typeof value[key] === 'string') host[key] = value[key];
  if (value.route === 'auto' || value.route === 'fixed') host.route = value.route;
  try {
    if (host.kind === 'ssh') {
      if (
        typeof value.hostname !== 'string' ||
        typeof value.username !== 'string' ||
        (value.port !== undefined && typeof value.port !== 'number')
      )
        return;
      const address = sshAddress({
        host: value.hostname,
        username: value.username,
        port: value.port as number | undefined,
      });
      Object.assign(host, {
        hostname: address.host,
        username: address.username,
        port: address.port,
      });
    }
    if (value.herdrSession !== undefined) host.herdrSession = herdrSession(value.herdrSession);
  } catch {
    return;
  }
  return host;
}
export function decodeTab(value: unknown, backends: Set<string>): TerminalTab | undefined {
  if (
    !record(value) ||
    !identity(value) ||
    typeof value.backendId !== 'string' ||
    !backends.has(value.backendId) ||
    !validSession(value.session) ||
    typeof value.pluginId !== 'string' ||
    !value.pluginId ||
    typeof value.pluginVersion !== 'string' ||
    !value.pluginVersion
  )
    return;
  const tab: TerminalTab = {
    id: value.id as string,
    name: value.name as string,
    backendId: value.backendId,
    session: value.session,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
  };
  for (const key of ['hostId', 'parentTabId', 'herdrSource', 'readHerdrTerminal'] as const)
    if (typeof value[key] === 'string') tab[key] = value[key];
  for (const key of ['directory', 'readPath'] as const)
    if (validPath(value[key])) tab[key] = value[key];
  if (validCapture(value.readCapture)) tab.readCapture = value.readCapture;
  if (
    typeof value.readExitCode === 'number' &&
    Number.isInteger(value.readExitCode) &&
    value.readExitCode >= 0 &&
    value.readExitCode <= 255
  )
    tab.readExitCode = value.readExitCode;
  if (typeof value.lastUsed === 'number' && Number.isFinite(value.lastUsed))
    tab.lastUsed = value.lastUsed;
  for (const key of ['ended', 'herdrCore'] as const)
    if (typeof value[key] === 'boolean') tab[key] = value[key];
  tab.ownsSession =
    typeof value.ownsSession === 'boolean'
      ? value.ownsSession
      : !['herdr', 'herdr-core', 'reading'].includes(tab.pluginId);
  tab.pluginState = value.pluginState;
  try {
    if (value.herdrSession !== undefined) tab.herdrSession = herdrSession(value.herdrSession);
  } catch {
    return;
  }
  return tab;
}
export function uniqueRecords<T extends { id: string }>(
  values: unknown[],
  decode: (value: unknown) => T | undefined,
): T[] {
  const records = new Map<string, T>();
  for (const value of values) {
    const record = decode(value);
    if (record && !records.has(record.id)) records.set(record.id, record);
  }
  return [...records.values()];
}
