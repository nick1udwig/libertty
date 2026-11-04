import { defaults, validateShortcuts, type Shortcut } from './shortcuts.ts';
export function shortcutEditor(
  current: () => Shortcut[],
  save: (value: Shortcut[]) => void,
  close: () => void,
) {
  const $ = (id: string) => document.getElementById(id)!;
  let draftShortcuts: Shortcut[] = [];
  function renderEditor() {
    $('shortcut-editor').replaceChildren();
    draftShortcuts.forEach((shortcut, index) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const field = (title: string, name: 'label' | 'value') => {
        const label = document.createElement('label');
        label.textContent = title;
        if (name === 'value') label.className = 'binding-label';
        const input = document.createElement('input');
        input.value = shortcut[name];
        input.className = name === 'value' ? 'binding' : 'shortcut-label';
        input.maxLength = name === 'label' ? 24 : 4000;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.oninput = () => (shortcut[name] = input.value);
        label.append(input);
        return label;
      };
      row.append(field('Label', 'label'));
      const kindLabel = document.createElement('label');
      kindLabel.textContent = 'Action';
      const kind = document.createElement('select');
      for (const [value, text] of [
        ['keys', 'Keys'],
        ['command', 'Command'],
      ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        kind.append(option);
      }
      kind.value = shortcut.kind;
      kind.onchange = () => {
        shortcut.kind = kind.value as Shortcut['kind'];
        renderEditor();
      };
      kindLabel.append(kind);
      row.append(
        kindLabel,
        field(shortcut.kind === 'command' ? 'Command to run' : 'Keys to send', 'value'),
      );
      const actions = document.createElement('div');
      actions.className = 'shortcut-actions';
      for (const [label, delta] of [
        ['Move up', -1],
        ['Move down', 1],
        ['Remove', 0],
      ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button';
        button.textContent = label;
        button.disabled =
          delta !== 0 && (index + delta < 0 || index + delta >= draftShortcuts.length);
        button.onclick = () => {
          if (!delta) draftShortcuts.splice(index, 1);
          else
            [draftShortcuts[index], draftShortcuts[index + delta]] = [
              draftShortcuts[index + delta],
              draftShortcuts[index],
            ];
          renderEditor();
        };
        actions.append(button);
      }
      row.append(actions);
      $('shortcut-editor').append(row);
    });
  }
  $('add-shortcut').onclick = () => {
    if (draftShortcuts.length >= 24) return;
    draftShortcuts.push({ label: '', kind: 'command', value: '' });
    renderEditor();
    $('shortcut-editor').lastElementChild?.scrollIntoView({ block: 'nearest' });
  };
  $('reset-shortcuts').onclick = () => {
    draftShortcuts = structuredClone(defaults);
    renderEditor();
  };
  $('shortcuts-form').onsubmit = (e) => {
    e.preventDefault();
    try {
      save(validateShortcuts(draftShortcuts));
      close();
    } catch (error: any) {
      $('shortcut-error').textContent = error.message;
    }
  };
  return () => {
    draftShortcuts = structuredClone(current());
    renderEditor();
    $('shortcut-error').textContent = '';
  };
}
