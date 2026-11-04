import { builtinIds } from './plugins.ts';

export const MAX_PLUGIN_BYTES = 256 * 1024;
export const MAX_PLUGIN_STATE_BYTES = 16 * 1024;
export interface PluginPackage {
  manifest: {
    id: string;
    name: string;
    version: string;
    apiVersion: 1;
    connectLabel: string;
    permissions: ['file.read'];
    icon?: string;
  };
  view: string;
}
export interface InstalledPlugin {
  package: PluginPackage;
  enabled: boolean;
}

export function parsePluginPackage(input: unknown): PluginPackage {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected a plugin package.');
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_PLUGIN_BYTES)
    throw new Error('Plugin packages are limited to 256 KB.');
  const { manifest: m, view } = input as PluginPackage;
  if (
    !m ||
    typeof m !== 'object' ||
    typeof m.id !== 'string' ||
    !/^[a-z][a-z0-9.-]{2,63}$/.test(m.id) ||
    (builtinIds as readonly string[]).includes(m.id)
  )
    throw new Error('Use a unique plugin ID (3–64 lowercase letters, digits, dots or hyphens).');
  if (m.apiVersion !== 1) throw new Error('This plugin requires an unsupported API version.');
  for (const [name, value, limit] of [
    ['name', m.name, 80],
    ['version', m.version, 40],
    ['connection label', m.connectLabel, 80],
  ] as const) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > limit ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error('Invalid plugin ' + name + '.');
  }
  if (!/^[a-zA-Z0-9._+-]+$/.test(m.version)) throw new Error('Invalid plugin version.');
  if (
    !Array.isArray(m.permissions) ||
    m.permissions.length !== 1 ||
    m.permissions[0] !== 'file.read'
  )
    throw new Error('This experiment supports only the file.read permission.');
  if (typeof view !== 'string' || !view.trim()) throw new Error('The plugin needs an HTML view.');
  if (
    m.icon !== undefined &&
    (typeof m.icon !== 'string' || m.icon.length > 4 || /[\x00-\x1f\x7f]/.test(m.icon))
  )
    throw new Error('Invalid plugin icon.');
  return {
    manifest: {
      id: m.id,
      name: m.name,
      version: m.version,
      apiVersion: 1,
      connectLabel: m.connectLabel,
      permissions: ['file.read'],
      ...(m.icon ? { icon: m.icon } : {}),
    },
    view,
  };
}

export function pluginState(input: unknown): unknown {
  const encoded = JSON.stringify(input);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > MAX_PLUGIN_STATE_BYTES
  )
    throw new Error('Plugin state must be JSON and at most 16 KB.');
  return JSON.parse(encoded);
}

/** Deliberately no operation accepts a backend, session ID, token or alternate path. */
export async function pluginRequest(
  method: unknown,
  params: unknown,
  host: {
    read(): Promise<{ text: string; path: string; truncated: boolean }>;
    save(state: unknown): void;
  },
): Promise<unknown> {
  if (method === 'file.read') {
    if (
      params !== undefined &&
      params !== null &&
      (typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length)
    )
      throw new Error('Only the file selected when connecting can be read.');
    return host.read();
  }
  if (method === 'state.save') {
    host.save(pluginState(params));
    return { ok: true };
  }
  throw new Error('This plugin operation is not permitted.');
}
