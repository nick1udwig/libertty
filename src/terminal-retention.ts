/** Keep browser-owned work when a cached terminal view would be removed. */
export function terminalCanEvict(frame: HTMLIFrameElement): boolean {
  const state = { allowed: false };
  frame.contentDocument?.dispatchEvent(new CustomEvent('terminal-can-evict', { detail: state }));
  return state.allowed;
}
