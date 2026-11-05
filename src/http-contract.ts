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
} from './generated/protocol.ts';
import type { SSHConnection } from './connections.ts';
export interface HttpContracts {
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
  : HttpContracts[K]['output'];
export interface HttpAPI {
  <K extends HttpEndpoint, I extends HttpInput<K>>(
    path: K,
    data: I,
    signal?: AbortSignal,
  ): Promise<HttpOutput<K, I>>;
}
export const endpointTimeouts = {
  'api/herdr/action': 12000,
  'api/herdr/snapshot': 12000,
  'api/connect': 12000,
  'api/sessions': 25000,
  'api/sessions/close': 12000,
  'api/ticket': 12000,
  'api/herdr/connect': 25000,
  'api/herdr/ticket': 12000,
} satisfies Record<HttpEndpoint, number>;
