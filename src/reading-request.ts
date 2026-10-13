import { shellQuote } from './shell-words.ts';
import { simpleWords } from './shell-words.ts';
import { expandSymbols } from './speech-symbols.ts';

export const defaultReadingPhrases = ['look at'];

export function readingPhrases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) return [...defaultReadingPhrases];
  const phrases = value.map(item => typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : '');
  if (phrases.some(item => !item || item.length > 50 || /[\x00-\x1f\x7f]/.test(item))) return [...defaultReadingPhrases];
  return [...new Set(phrases.map(item => item.toLowerCase()))];
}

export function readingRequest(text: string, phrases: string[], spoken = false): { phrase: string; path: string; operand: string } | undefined {
  const trimmed = text.trim();
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    if (!trimmed.toLowerCase().startsWith(phrase.toLowerCase())) continue;
    const rest = trimmed.slice(phrase.length);
    if (!/^\s+/.test(rest)) continue;
    let file = rest.trim();
    if (spoken) file = file.replace(/[.!?]$/, '');
    const operand = file;
    const words = simpleWords(file);
    if (words?.length === 1) file = words[0].value;
    if (file && !/[\x00-\x1f\x7f]/.test(file)) return { phrase: trimmed.slice(0, phrase.length), path: file, operand };
  }
}

export function readingPath(text: string, phrases: string[], spoken = false): string | undefined {
  return readingRequest(text, phrases, spoken)?.path;
}

/** Recognize only a final, unquoted pipe into the reader. Bash still owns the
 * command before it, including quoting, redirects and earlier pipeline stages. */
export function readingPipeline(text: string, phrases: string[], spoken = false): { command: string; phrase: string } | undefined {
  const source = spoken ? expandSymbols(text).replace(/[.!?]$/, '') : text;
  let quote = '', depth = 0, pipe = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (["'", '"', '`'].includes(char)) { quote = char; continue; }
    if ('({'.includes(char)) depth++;
    else if (')}'.includes(char)) depth--;
    else if (char === '|' && depth === 0 && source[i - 1] !== '|' && !['|', '&'].includes(source[i + 1])) pipe = i;
  }
  if (quote || depth || pipe < 1) return undefined;
  const suffix = source.slice(pipe + 1).trim();
  const phrase = phrases.find(phrase => phrase.toLowerCase() === suffix.toLowerCase());
  const command = source.slice(0, pipe).trim();
  if (phrase && command) return { command, phrase: suffix };
}

/** Translate the reading operand into a known file-taking command for the shared
 * history, path repair, discovery and validation pipeline. No shell command runs. */
export function readingSuggestionInput(request: { path: string; operand?: string }): string { return 'cat ' + (request.operand || request.path); }

export function readingSuggestionChoice(command: string, phrase: string): string | undefined {
  const words = simpleWords(command);
  if (words?.length !== 2 || words[0].value !== 'cat') return undefined;
  return phrase + ' ' + shellQuote(words[1].value);
}
