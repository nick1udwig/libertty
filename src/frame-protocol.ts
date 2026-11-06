import type { ShellState } from './protocol.ts';
import { remoteNotice, type RemoteNotice } from './notice-model.ts';
import { readingOpen, type ReadingOpen } from './reading-request.ts';
import { validateShortcuts, type Shortcut } from './shortcuts.ts';

export type WorkspaceMessage =
  | {
      type:
        | 'shortcut-host'
        | 'terminal-return'
        | 'herdr-resize-cover'
        | 'recovery-failed'
        | 'settings-changed'
        | 'focus-terminal';
    }
  | { type: 'authorize'; accessToken?: string }
  | { type: 'terminal-shortcut'; index: number; kind: Shortcut['kind']; value: string }
  | { type: 'terminal-images'; files: File[] }
  | { type: 'herdr-present'; presentation: string }
  | { type: 'notice-action'; id: string }
  | { type: 'herdr-park'; parked: boolean; preserve?: boolean }
  | { type: 'tab-visibility'; visible: boolean; active?: boolean }
  | { type: 'settings-action'; action: 'new-shell' | 'copy-selection' };
export interface TerminalEvents {
  'terminal-loaded': {};
  'terminal-ready': {};
  'terminal-ended': {};
  'herdr-resize-ready': {};
  'terminal-authorized': { accessToken?: string };
  'terminal-locked': { accessToken?: string };
  'terminal-notice': RemoteNotice;
  'terminal-status': { status?: RemoteNotice };
  'terminal-shortcuts': {
    shortcuts: Shortcut[];
    ctrl: boolean;
    available: boolean;
    imageAvailable: boolean;
    returnAvailable: boolean;
  };
  'terminal-rendered': { presentation: string; cols: number; rows: number };
  'terminal-sizing': TerminalEvents['terminal-rendered'];
  'terminal-state': { state: ShellState };
  'ssh-command': { id: string; command: string };
  'herdr-command': TerminalEvents['ssh-command'];
  'reading-open': ReadingOpen;
}
export type TerminalMessage = {
  [K in keyof TerminalEvents]: { type: K; session: string } & TerminalEvents[K];
}[keyof TerminalEvents];
export function sendToTerminal(target: Window | null | undefined, message: WorkspaceMessage) {
  target?.postMessage(message, location.origin);
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';
const token = (value: unknown) =>
  value === undefined || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
export function workspaceMessage(value: unknown): WorkspaceMessage | undefined {
  if (!record(value)) return;
  const valid = (() => {
    switch (value.type) {
      case 'shortcut-host':
      case 'terminal-return':
      case 'herdr-resize-cover':
      case 'recovery-failed':
      case 'settings-changed':
      case 'focus-terminal':
        return true;
      case 'authorize':
        return token(value.accessToken);
      case 'terminal-shortcut':
        return (
          Number.isSafeInteger(value.index) &&
          Number(value.index) >= 0 &&
          (value.kind === 'keys' || value.kind === 'command') &&
          typeof value.value === 'string'
        );
      case 'terminal-images':
        return Array.isArray(value.files) && value.files.every((file) => file instanceof File);
      case 'herdr-present':
        return typeof value.presentation === 'string';
      case 'notice-action':
        return typeof value.id === 'string' && value.id.length <= 40;
      case 'herdr-park':
        return typeof value.parked === 'boolean' && optionalBoolean(value.preserve);
      case 'tab-visibility':
        return typeof value.visible === 'boolean' && optionalBoolean(value.active);
      case 'settings-action':
        return value.action === 'new-shell' || value.action === 'copy-selection';
      default:
        return false;
    }
  })();
  return valid ? (value as WorkspaceMessage) : undefined;
}
export function terminalMessage(value: unknown): TerminalMessage | undefined {
  if (!record(value) || typeof value.session !== 'string') return;
  switch (value.type) {
    case 'terminal-loaded':
    case 'terminal-ready':
    case 'terminal-ended':
    case 'herdr-resize-ready':
      break;
    case 'terminal-authorized':
    case 'terminal-locked':
      if (!token(value.accessToken)) return;
      break;
    case 'terminal-rendered':
    case 'terminal-sizing':
      if (
        typeof value.presentation !== 'string' ||
        !Number.isInteger(value.cols) ||
        !Number.isInteger(value.rows) ||
        Number(value.cols) < 1 ||
        Number(value.rows) < 1
      )
        return;
      break;
    case 'terminal-notice': {
      const notice = remoteNotice(value, 'error');
      return notice ? { type: value.type, session: value.session, ...notice } : undefined;
    }
    case 'terminal-status':
      return {
        type: value.type,
        session: value.session,
        status: remoteNotice(value.status, 'progress'),
      };
    case 'terminal-shortcuts':
      if (
        ![value.ctrl, value.available, value.imageAvailable, value.returnAvailable].every(
          (item) => typeof item === 'boolean',
        )
      )
        return;
      try {
        return { ...value, shortcuts: validateShortcuts(value.shortcuts) } as TerminalMessage;
      } catch {
        return;
      }
    case 'reading-open':
      if (!readingOpen(value)) return;
      break;
    case 'ssh-command':
    case 'herdr-command':
      if (typeof value.id !== 'string' || typeof value.command !== 'string') return;
      break;
    case 'terminal-state': {
      const state = value.state;
      if (
        !record(state) ||
        typeof state.cwd !== 'string' ||
        typeof state.ready !== 'boolean' ||
        typeof state.exited !== 'boolean' ||
        ![state.prompt, state.promptRevision, state.inputRevision].every(Number.isSafeInteger) ||
        (state.inputContext !== undefined && typeof state.inputContext !== 'string') ||
        (state.exitCode !== undefined && !Number.isInteger(state.exitCode)) ||
        (state.inputTarget !== undefined &&
          state.inputTarget !== 'shell' &&
          state.inputTarget !== 'program') ||
        !optionalBoolean(state.terminalScroll)
      )
        return;
      break;
    }
    default:
      return;
  }
  return value as TerminalMessage;
}
