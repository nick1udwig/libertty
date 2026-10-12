export interface BackendProfile { id: string; name: string; url: string }
export interface HostProfile { id: string; name: string; kind: 'http' | 'ssh' | 'herdr'; herdrSession?: string; herdrSource?: string; herdrSourceHostId?: string; backendId: string; hostname?: string; port?: number; username?: string; keyFingerprint?: string; browserKeyId?: string; backendKeyId?: string; route?: 'auto' | 'fixed' }
export interface TerminalTab { pluginId?: string; pluginVersion?: string; pluginState?: unknown; readPath?: string; readCapture?: string; readExitCode?: number; ownsSession?: boolean; mode?: 'files' | 'herdr'; herdrSession?: string; herdrSource?: string; directory?: string; id: string; name: string; backendId: string; session: string; hostId?: string; lastUsed?: number; ended?: boolean; parentTabId?: string }
export interface LegacyReadingTab extends Pick<TerminalTab, 'id' | 'name' | 'backendId' | 'session' | 'lastUsed'> { path: string; capture?: string; exitCode?: number; sourceTabId: string }
export interface KeyReference { type: 'file' | 'agent'; path: string }
export interface KeyInfo { reference?: KeyReference; id: string; name: string; publicKey: string; fingerprint: string; createdAt: string }
export interface KnownHost { host: string; port: number; fingerprint: string }
export interface SSHConnection { host: string; port: number; username: string; keyId?: string; privateKey?: string; passphrase?: string; password?: string; trust?: string }
export function backendURL(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) backend URL without credentials or a query.');
  return url.href.replace(/\/?$/, '/');
}
export function sshAddress(input: Partial<SSHConnection>): Pick<SSHConnection, 'host' | 'port' | 'username'> {
  const host = input.host?.trim() || '', username = input.username?.trim() || '', port = input.port ?? 22;
  if (!host || host.length > 253 || /[\s\x00-\x1f/\\]/.test(host) || !/^[a-zA-Z0-9:._%-]+$/.test(host)) throw new Error('Enter a hostname or IP address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535.');
  if (!username || username.length > 128 || /[\x00-\x20\x7f]/.test(username)) throw new Error('Enter an SSH username.');
  return { host, port, username };
}
