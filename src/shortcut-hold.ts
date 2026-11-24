import type { Shortcut } from './shortcuts.ts';

export function bindShortcutHold(button: HTMLButtonElement, shortcut: Shortcut) {
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  if (
    shortcut.kind !== 'keys' ||
    !/^(?:(?:Ctrl|Alt|Shift)\+)*(?:Up|Down|Left|Right)$/i.test(shortcut.value)
  )
    return;

  let suppressClick = false;
  button.addEventListener(
    'click',
    (event) => {
      if (suppressClick && event.detail > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  button.addEventListener('pointerdown', (press) => {
    if (!press.isPrimary || press.button !== 0) return;
    suppressClick = false;
    const hold = new AbortController();
    const options = { signal: hold.signal };
    const stop = () => {
      clearTimeout(timer);
      hold.abort();
    };
    const repeat = () => {
      if (!button.checkVisibility() || button.disabled || document.hidden) return stop();
      suppressClick = true;
      button.click();
      if (!hold.signal.aborted) timer = window.setTimeout(repeat, 65);
    };
    let timer = window.setTimeout(repeat, 400);
    const release = (event: PointerEvent) => {
      if (event.pointerId === press.pointerId) stop();
    };
    for (const type of [
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'pointerleave',
    ] as const)
      button.addEventListener(type, release, options);
    button.addEventListener(
      'pointermove',
      (event) => {
        if (
          event.pointerId === press.pointerId &&
          Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > 10
        ) {
          suppressClick = true;
          stop();
        }
      },
      options,
    );
    window.addEventListener(
      'blur',
      () => {
        if (!document.hasFocus()) stop();
      },
      options,
    );
    window.addEventListener('pagehide', stop, options);
    document.addEventListener('visibilitychange', stop, options);
  });
}
