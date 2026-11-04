import { shortcutEditor } from './shortcut-editor.ts';
import { defaults, keySequence, validateShortcuts, type Shortcut } from './shortcuts.ts';

export interface ShortcutBarHost {
  container: HTMLElement;
  /** Runs a command shortcut at the prompt. */
  execute(command: string): void;
  /** Sends a key sequence to the terminal. */
  input(data: string): void;
  focus(): void;
  attachImages(): void;
  /** Saves edited shortcuts. */
  save(shortcuts: Shortcut[]): void;
  /** Refreshes availability after the buttons or the Ctrl modifier change. */
  changed(): void;
  /** Publishes the bar to a hosting workspace after the Ctrl modifier changes. */
  published(): void;
}

function stored(): Shortcut[] {
  try {
    const value = localStorage.getItem('libertty.shortcuts');
    if (value) return validateShortcuts(JSON.parse(value));
  } catch {
    /* Use defaults when storage is unavailable or stale. */
  }
  return structuredClone(defaults);
}

/** The configurable shortcut buttons below a terminal, including the sticky Ctrl modifier. */
export class ShortcutBar {
  shortcuts = stored();
  ctrl = false;
  /** Prepares the shortcut editor dialog with the current shortcuts. */
  readonly edit: () => void;
  private host: ShortcutBarHost;

  constructor(host: ShortcutBarHost) {
    this.host = host;
    this.edit = shortcutEditor(
      () => this.shortcuts,
      (value) => {
        this.shortcuts = value;
        host.save(value);
        this.setCtrl(false);
        this.render();
      },
      () => document.querySelector<HTMLDialogElement>('#shortcuts-dialog')!.close(),
    );
  }

  setCtrl(value: boolean) {
    this.ctrl = value;
    for (const button of document.querySelectorAll('[data-modifier]'))
      button.setAttribute('aria-pressed', String(value));
    this.host.published();
  }

  /** Applies a pending Ctrl modifier to typed input. */
  modify(data: string) {
    if (!this.ctrl) return data;
    this.setCtrl(false);
    return /^[a-zA-Z]$/.test(data)
      ? String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64)
      : data;
  }

  /** Adopts shortcuts changed in another document. */
  replace(next: Shortcut[]) {
    if (JSON.stringify(next) === JSON.stringify(this.shortcuts)) return;
    this.shortcuts = next;
    this.setCtrl(false);
    this.render();
  }

  /** Presses a shortcut that a hosting workspace shows, when it still matches this bar. */
  press(index: unknown, kind: unknown, value: unknown) {
    const shortcut = Number.isInteger(index) ? this.shortcuts[index as number] : undefined;
    if (shortcut && shortcut.kind === kind && shortcut.value === value)
      this.host.container.querySelectorAll<HTMLButtonElement>('button')[index as number]?.click();
  }

  render() {
    const { container } = this.host;
    container.replaceChildren();
    for (const shortcut of this.shortcuts) {
      const button = document.createElement('button');
      button.textContent = shortcut.label;
      button.title = shortcut.value;
      button.classList.toggle('command-shortcut', shortcut.kind === 'command');
      if (shortcut.kind === 'keys' && shortcut.value === 'Ctrl') {
        button.dataset.modifier = '';
        button.setAttribute('aria-pressed', String(this.ctrl));
      }
      button.addEventListener('pointerdown', (e) => e.preventDefault());
      button.onclick = () => {
        if (shortcut.kind === 'command') return this.host.execute(shortcut.value);
        if (shortcut.value === 'Ctrl') this.setCtrl(!this.ctrl);
        else this.host.input(keySequence(shortcut.value));
        this.host.focus();
      };
      container.append(button);
    }
    const image = document.createElement('button');
    image.type = 'button';
    image.className = 'image-upload';
    image.textContent = 'Image';
    image.setAttribute('aria-label', 'Attach images');
    image.onclick = () => this.host.attachImages();
    container.append(image);
    this.host.changed();
  }
}
