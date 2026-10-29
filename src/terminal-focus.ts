import type { Terminal } from './terminal-adapter.ts';

/** Only intentional input actions may reopen the software keyboard after a gesture. */
export class TerminalFocus {
  private automatic = true;
  private input: HTMLTextAreaElement;
  private nativeFocus: HTMLTextAreaElement['focus'];
  private keyboardHeight = 0;
  private availableHeight = 0;
  private viewportWidth = 0;

  constructor(term: Terminal) {
    this.input = term.textarea!;
    this.nativeFocus = this.input.focus.bind(this.input);
    const automaticFocus = () => {
      if (!this.automatic) return;
      this.enable(); this.nativeFocus({ preventScroll: true });
    };
    term.setAutomaticFocusHandler(automaticFocus);
    term.setFocusHandler(() => this.focus());
    term.element!.removeAttribute('contenteditable');
    term.element!.tabIndex = -1;
    // Keep native mouse focus in the textarea when a gesture permits it.
    term.element!.addEventListener('focus', () => { if (!this.input.readOnly) automaticFocus(); });
    this.input.addEventListener('blur', event => { if (event.relatedTarget !== term.element) this.lock(); });
    this.input.addEventListener('focus', event => {
      // A readonly input cannot summon the IME; also relinquish accidental native focus.
      if (!this.automatic && this.input.readOnly) { this.input.blur(); event.stopImmediatePropagation(); }
      else if (this.automatic) this.enable();
    }, { capture: true });
    term.blur();
    this.lock();

    // The workspace's visual viewport owns the keyboard resize, not its iframe.
    let owner: Window = window;
    try { if (parent !== window && parent.location.origin === location.origin) owner = parent; } catch { /* Standalone or cross-origin embedding. */ }
    const size = () => ({ height: owner.visualViewport?.height || owner.innerHeight, width: owner.visualViewport?.width || owner.innerWidth });
    const initial = size(); this.availableHeight = this.keyboardHeight = initial.height; this.viewportWidth = initial.width;
    const resized = () => {
      const { height, width } = size();
      if (width !== this.viewportWidth) this.availableHeight = this.keyboardHeight = height;
      else if (document.activeElement !== this.input) { this.availableHeight = Math.max(this.availableHeight, height); this.keyboardHeight = height; }
      else if (navigator.maxTouchPoints > 0 && height - this.keyboardHeight > 80 && height >= this.availableHeight - 80) {
        // Android Back often leaves the textarea focused after hiding the IME.
        // Disarm it before a subsequent native release can reopen the keyboard.
        this.automatic = false; this.lock(); this.input.blur(); this.keyboardHeight = height;
      } else this.keyboardHeight = Math.min(this.keyboardHeight, height);
      this.viewportWidth = width;
    };
    owner.visualViewport?.addEventListener('resize', resized);
    owner.addEventListener('resize', resized);
    // Parent listeners must not retain closed terminal iframes.
    window.addEventListener('pagehide', event => {
      if (event.persisted) return;
      owner.visualViewport?.removeEventListener('resize', resized);
      owner.removeEventListener('resize', resized);
    });
  }

  private lock() { this.input.readOnly = true; this.input.inputMode = 'none'; }
  private enable() { this.input.readOnly = false; this.input.inputMode = 'text'; }
  suppress() { this.automatic = false; if (document.activeElement !== this.input) this.lock(); }
  allowMouse() { this.automatic = true; this.enable(); }
  focus() {
    if (this.input.readOnly && document.activeElement === this.input) this.input.blur();
    this.automatic = true; this.enable(); this.nativeFocus({ preventScroll: true });
  }
}
