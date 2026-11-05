import type {
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
export type HttpOutput<K extends HttpEndpoint> = HttpContracts[K]['output'];
export const endpointTimeouts = {
  'api/connect': 12000,
  'api/sessions': 25000,
  'api/sessions/close': 12000,
  'api/ticket': 12000,
  'api/herdr/connect': 25000,
  'api/herdr/ticket': 12000,
} satisfies Record<HttpEndpoint, number>;
