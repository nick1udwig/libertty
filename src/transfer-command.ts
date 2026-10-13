import { tokens } from './shell-words.ts';
import { simpleWords } from './shell-words.ts';
import { expandSymbols } from './speech-symbols.ts';

/** Identify managed actions without treating quoted shell content as a command. */
export function transferAction(text: string): 'upload' | 'download' | undefined {
  const words = simpleWords(text.trim());
  const command = words?.[0];
  if (command && !tokens(text.trim())[0]?.quoted && (command.value === 'upload' || command.value === 'download')) return command.value;
}
export function downloadPipeline(input: string) {
  const text = expandSymbols(input).trim(); let quote = '', depth = 0, pipe = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (["'", '"', '`'].includes(char)) { quote = char; continue; }
    if ('({'.includes(char)) depth++;
    else if (')}'.includes(char)) depth--;
    else if (char === '|' && depth === 0 && text[i - 1] !== '|' && !['|', '&'].includes(text[i + 1])) pipe = i;
  }
  if (quote || depth || pipe < 1) return;
  const tail = text.slice(pipe + 1).trim(), words = simpleWords(tail);
  if (!words?.length || tokens(tail)[0]?.quoted || words[0].value.toLowerCase() !== 'download') return;
  const rest = words.slice(1);
  if (rest[0]?.value === '--file' || rest.length > 1 || rest.some((word, index) => !tokens(tail)[index + 1]?.quoted && word.value.startsWith('-'))) return;
  return { command: text.slice(0, pipe).trim(), tail: 'download' + tail.slice(words[0].value.length) };
}
