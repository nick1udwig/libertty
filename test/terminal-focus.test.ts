import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalFocus } from '../src/terminal-focus.ts';

test('adapter focus hooks preserve deliberate focus and block focus after touch gestures', () => {
  const previous = new Map(['window', 'parent', 'document', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = { activeElement: null as EventTarget | null };
  const owner = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844 });
  let focusCalls = 0;
  class Input extends EventTarget {
    readOnly = false;
    inputMode = '';
    focus(options?: FocusOptions) {
      assert.equal(options?.preventScroll, true);
      focusCalls++; document.activeElement = this; this.dispatchEvent(new Event('focus'));
    }
    blur() {
      if (document.activeElement !== this) return;
      document.activeElement = null; this.dispatchEvent(new Event('blur'));
    }
  }
  const input = new Input(), nativeFocus = input.focus;
  let explicit!: () => void, automatic!: () => void;
  const element = Object.assign(new EventTarget(), { removeAttribute() {}, tabIndex: 0 });
  for (const [name, value] of Object.entries({ window: owner, parent: owner, document, navigator: { maxTouchPoints: 1 } }))
    Object.defineProperty(globalThis, name, { value, configurable: true });
  try {
    const focus = new TerminalFocus({
      textarea: input, element, blur: () => input.blur(),
      setFocusHandler: (handler: () => void) => { explicit = handler; },
      setAutomaticFocusHandler: (handler: () => void) => { automatic = handler; },
    } as never);
    assert.equal(input.focus, nativeFocus, 'Focus policy leaves the DOM focus method intact');
    assert.equal(input.readOnly, true);
    automatic();
    assert.equal(document.activeElement, input);
    assert.equal(input.readOnly, false);
    focus.suppress(); input.blur();
    const before = focusCalls;
    automatic();
    assert.equal(focusCalls, before, 'Automatic focus cannot reopen the keyboard after a gesture');
    input.focus({ preventScroll: true });
    assert.equal(document.activeElement, null, 'The focus event guard rejects browser default focus');
    explicit();
    assert.equal(document.activeElement, input);
    assert.equal(input.inputMode, 'text');
    focus.suppress(); input.blur(); focus.allowMouse(); automatic();
    assert.equal(document.activeElement, input, 'A mouse press restores automatic focus');
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
