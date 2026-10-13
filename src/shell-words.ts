export function shellQuote(value: string): string {
  if (value.startsWith('~/')) return '~/' + shellQuote(value.slice(2));
  return /^[a-zA-Z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export function tokens(input: string): { value: string; quoted: boolean }[] {
  return (input.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) || []).map(value => ({
    quoted: /^["']/.test(value), value: /^["']/.test(value) ? value.slice(1, -1) : value,
  }));
}

interface Word { value: string; home: boolean }
/** Parse simple arguments without expanding variables, substitutions or globs. */
export function simpleWords(line: string): Word[] | undefined {
  const result: Word[] = [];
  let value = '', quote = '', active = false, home = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") { if (char === "'") quote = ''; else value += char; continue; }
    if (char === '\\') { if (++i >= line.length) return undefined; value += line[i]; active = true; continue; }
    if (quote === '"') { if (char === '"') quote = ''; else if (char === '$' || char === '`') return undefined; else value += char; continue; }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (/[|&;<>()`$*?\[\]{}\n\r]/.test(char)) return undefined;
    if (/\s/.test(char)) { if (active) result.push({ value, home }); value = ''; active = false; home = false; continue; }
    if (!active && char === '#') return undefined;
    if (!active && char === '~') home = true;
    value += char; active = true;
  }
  if (quote) return undefined;
  if (active) result.push({ value, home });
  return result;
}
