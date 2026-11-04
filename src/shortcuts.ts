export interface Shortcut {
  label: string;
  kind: 'keys' | 'command';
  value: string;
}
export const defaults: Shortcut[] = [
  { label: 'Ctrl R', kind: 'keys', value: 'Ctrl+R' },
  { label: 'Tab', kind: 'keys', value: 'Tab' },
  { label: 'Esc', kind: 'keys', value: 'Escape' },
  { label: 'Ctrl', kind: 'keys', value: 'Ctrl' },
  { label: '↑', kind: 'keys', value: 'Up' },
  { label: '↓', kind: 'keys', value: 'Down' },
  { label: '←', kind: 'keys', value: 'Left' },
  { label: '→', kind: 'keys', value: 'Right' },
  { label: 'Ctrl C', kind: 'keys', value: 'Ctrl+C' },
];
const named: Record<string, string> = {
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  enter: '\r',
  return: '\r',
  space: ' ',
  backspace: '\x7f',
  delete: '\x1b[3~',
  insert: '\x1b[2~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};
export function keySequence(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((key) => {
      if (named[key.toLowerCase()]) return named[key.toLowerCase()];
      if (/^shift\+tab$/i.test(key)) return '\x1b[Z';
      const parts = key.toLowerCase().split('+');
      const base = parts.pop()!;
      if (parts.length && parts.every((part) => ['ctrl', 'alt', 'shift'].includes(part))) {
        const modifier =
          1 +
          Number(parts.includes('shift')) +
          2 * Number(parts.includes('alt')) +
          4 * Number(parts.includes('ctrl'));
        const arrow: Record<string, string> = {
          up: 'A',
          down: 'B',
          right: 'C',
          left: 'D',
          home: 'H',
          end: 'F',
        };
        if (arrow[base]) return `\x1b[1;${modifier}${arrow[base]}`;
        if (parts.includes('ctrl') && (base === 'space' || base === '@'))
          return (parts.includes('alt') ? '\x1b' : '') + '\0';
        if (parts.includes('ctrl') && /^[a-z\[\]\\^_]$/.test(base))
          return (
            (parts.includes('alt') ? '\x1b' : '') +
            String.fromCharCode(base.toUpperCase().charCodeAt(0) & 31)
          );
      }
      if (/^alt\+.$/i.test(key)) return '\x1b' + key.at(-1);
      if (key.length === 1) return key;
      throw new Error(`Unknown key “${key}”. Try Ctrl+R, Tab, Escape or Up.`);
    })
    .join('');
}
export function validateShortcuts(value: unknown): Shortcut[] {
  if (!Array.isArray(value) || value.length > 24) throw new Error('Use up to 24 shortcuts.');
  return value.map((item) => {
    if (
      !item ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 24 ||
      !['keys', 'command'].includes(item.kind) ||
      typeof item.value !== 'string' ||
      !item.value.trim() ||
      item.value.length > 4000
    )
      throw new Error('Each shortcut needs a label and a key sequence or command.');
    if (item.kind === 'keys' && item.value.trim() !== 'Ctrl') keySequence(item.value);
    if (item.kind === 'command' && /[\x00-\x1f\x7f]/.test(item.value))
      throw new Error('Save a command on one line. Use ; or && to combine commands.');
    return { label: item.label.trim(), kind: item.kind, value: item.value.trim() };
  });
}
