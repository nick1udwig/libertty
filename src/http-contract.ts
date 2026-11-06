import type {
  HerdrAction,
  HerdrCreated,
  HerdrWorktrees,
  HerdrSnapshot,
  Connect,
  Connected,
  Sessions,
  CreatedSession,
  HerdrConnect,
  ConnectedHerdr,
  HerdrTicket,
  SocketTicket,
  Success,
  FileAction,
  FileText,
  FileListing,
  Folder,
  KeychainAction,
  SshAddress,
} from './generated/protocol.ts';
import type { SSHConnection, KeyInfo, KnownHost } from './connections.ts';
export type FileActionOutput<A extends FileAction> = A extends { action: 'read' }
  ? FileText
  : Success;
export type Keychain = { keys: KeyInfo[]; knownHosts: KnownHost[] };
export type KeychainOutput<A> = A extends { action: 'create' | 'backup' }
  ? KeyInfo
  : A extends { action: 'export' }
    ? KeyInfo & { privateKey: string }
    : A extends { action: 'inspect' }
      ? Pick<KeyInfo, 'publicKey' | 'fingerprint'>
      : Keychain;
export interface HttpContracts {
  'api/keychain': {
    input: KeychainAction | undefined;
    output: KeychainOutput<KeychainAction | undefined>;
  };
  'api/ssh/probe': { input: SshAddress; output: { milliseconds: number } };
  'api/files/action': { input: FileAction; output: FileText | Success };
  'api/files/mkdir': { input: Folder; output: Success };
  'api/files/list': { input: undefined; output: FileListing };
  'api/herdr/action': { input: HerdrAction; output: HerdrCreated | HerdrWorktrees | Success };
  'api/herdr/snapshot': { input: undefined; output: HerdrSnapshot };
  'api/connect': { input: Connect; output: Connected };
  'api/sessions': {
    input: Omit<Sessions, 'ssh'> & { ssh?: SSHConnection };
    output: CreatedSession;
  };
  'api/sessions/close': { input: Record<string, never>; output: Success };
  'api/ticket': { input: Record<string, never>; output: SocketTicket };
  'api/herdr/connect': { input: HerdrConnect; output: ConnectedHerdr };
  'api/herdr/ticket': { input: HerdrTicket; output: SocketTicket };
}
export type HttpEndpoint = keyof HttpContracts;
export type HttpInput<K extends HttpEndpoint> = HttpContracts[K]['input'];
export type HerdrActionOutput<A extends HerdrAction> = A extends { action: 'list-worktrees' }
  ? HerdrWorktrees
  : A extends { action: 'new-worktree' | 'open-worktree' | 'split' | 'create-space' | 'create' }
    ? HerdrCreated
    : Success;
export type HttpOutput<
  K extends HttpEndpoint,
  I extends HttpInput<K> = HttpInput<K>,
> = K extends 'api/herdr/action'
  ? HerdrActionOutput<Extract<I, HerdrAction>>
  : K extends 'api/files/action'
    ? FileActionOutput<Extract<I, FileAction>>
    : K extends 'api/keychain'
      ? KeychainOutput<I>
      : HttpContracts[K]['output'];
export interface HttpAPI {
  <K extends HttpEndpoint, I extends HttpInput<K>>(
    path: K,
    data: I,
    signal?: AbortSignal,
  ): Promise<HttpOutput<K, I>>;
}
export type HttpQuery<K extends HttpEndpoint> = { session?: string } & (K extends 'api/files/list'
  ? { path?: string }
  : Record<never, never>);
export const endpointTimeouts = {
  'api/keychain': 12000,
  'api/ssh/probe': 12000,
  'api/files/action': 12000,
  'api/files/mkdir': 12000,
  'api/files/list': 12000,
  'api/herdr/action': 12000,
  'api/herdr/snapshot': 12000,
  'api/connect': 12000,
  'api/sessions': 25000,
  'api/sessions/close': 12000,
  'api/ticket': 12000,
  'api/herdr/connect': 25000,
  'api/herdr/ticket': 12000,
} satisfies Record<HttpEndpoint, number>;
