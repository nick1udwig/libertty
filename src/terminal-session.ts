import { herdrURL, type HerdrAddress } from './herdr-protocol.ts';
import type { InputContext } from './unsent-input.ts';

interface InputState {
  hasState: boolean;
  ready: boolean;
  layoutPending: boolean;
  parked: boolean;
  identity?: string;
  stream?: string;
  after: number;
  target?: number;
}
export interface TerminalSession {
  readonly projected: boolean;
  endpoint(name: string): URL;
  socketEndpoint(): URL;
  mobile(viewport: boolean): boolean;
  resize(
    cols: number,
    rows: number,
    mobile: boolean,
  ): { type: 'resize'; cols: number; rows: number; mobile?: boolean };
  synchronized(state: InputState): boolean;
  inputContext(
    context: InputContext,
    state: InputState,
    picture: () => string,
  ): InputContext | undefined;
}
export function nativeSession(base: URL, session: string): TerminalSession {
  const endpoint = (name: string) => {
    const url = new URL(name.replace(/^\//, ''), base);
    if (session !== 'default') url.searchParams.set('session', session);
    return url;
  };
  return {
    projected: false,
    endpoint,
    socketEndpoint: () => endpoint('ws'),
    mobile: () => false,
    resize: (cols, rows) => ({ type: 'resize', cols, rows }),
    synchronized: (state) => state.hasState && state.after >= (state.target ?? state.after),
    inputContext: (context, state) =>
      state.hasState && state.stream ? { ...context, stream: state.stream } : undefined,
  };
}
export function herdrSessionAdapter(
  base: URL,
  terminal: string,
  address: HerdrAddress,
): TerminalSession {
  const endpoint = (name: string) => {
    const url = herdrURL(name, base, address);
    url.searchParams.set('terminalId', terminal);
    return url;
  };
  return {
    projected: !address.core,
    endpoint,
    socketEndpoint: () => endpoint('herdr/ws'),
    mobile: (viewport) => !address.core && viewport,
    resize: (cols, rows, mobile) => ({ type: 'resize', cols, rows, mobile }),
    synchronized: (state) =>
      state.hasState &&
      state.ready &&
      !state.layoutPending &&
      !state.parked &&
      state.identity !== undefined,
    inputContext(context, state, picture) {
      if (!state.identity) return;
      return {
        ...context,
        identity: state.identity,
        ...(context.target === 'shell' ? { picture: picture() } : {}),
      };
    },
  };
}
