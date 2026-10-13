/** Symbol names are interpretations of speech, never edits to the original input. */
import vocabulary from '../contracts/engine-vocabulary.json' with { type: 'json' };
const symbolNames: Record<string, string> = Object.assign(Object.create(null), vocabulary.symbolNames);
const names = Object.keys(symbolNames).map(name => ({ name, words: name.split(' ') }));
// Retain the established explicit vocabulary in the low-level command parser.
// General English names also participate as separate suggestion alternatives.
const directNames = new Set('tilde slash buc mic fas bas pam pat soq doq tic tis wut zap hax hep ket lac rac lit rit lob rob led ban lus stet slus shed dart dusk lark lush'.split(' '));
const maxWords = Math.max(...names.map(name => name.words.length));
const tokenize = (input: string) => input.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) || [];
interface Unit { word: string; name?: string; at: number }
interface Match { name: string; count: number }

function matches(words: string[], at: number, general = true): Match[] {
  const found: Match[] = [];
  for (let count = Math.min(maxWords, words.length - at); count > 0; count--) {
    const span = words.slice(at, at + count);
    if (span.some(word => !/^[a-z]+$/i.test(word))) continue;
    const phrase = span.join(' ').toLowerCase();
    // "look at" is a Reading Mode action. Its full phrase takes precedence over
    // interpreting its last word as a spoken @ symbol.
    if (phrase === 'at' && words[at - 1]?.toLowerCase() === 'look') continue;
    // Preserve the executable name; a standalone symbol name can still be expanded.
    if (at === 0 && count < words.length) continue;
    if (symbolNames[phrase] && (general || directNames.has(phrase))) return [{ name: phrase, count }];
  }
  return found;
}
function render(units: Unit[]): string {
  let output = '', joinNext = false, quote = '';
  for (const { word, name, at } of units) {
    const symbol = name && symbolNames[name];
    if (!symbol) { output += (output && !joinNext ? ' ' : '') + word; joinNext = false; continue; }
    let left = false, right = false;
    if (["'", '"', '`'].includes(symbol)) {
      left = name!.startsWith('close ') || (!name!.startsWith('open ') && quote === symbol);
      right = !left; quote = left ? '' : symbol;
    } else if (['/', '\\', '.', '_', ':', ',', '@', '=', '==', '^', '->', '<-', '-<', '+>', '+<', '+', '++', '*', '**', '%'].includes(symbol) || name === 'hyphen') left = right = true;
    else if (['~', '~/', '$', '!', '#', '-', '--', '[', '(', '{'].includes(symbol)) right = true;
    else if (['?', ']', ')', '}'].includes(symbol)) left = true;
    if (at === 1 && !units[0]?.name) left = false;
    output += (output && !joinNext && !left ? ' ' : '') + symbol;
    joinNext = right;
  }
  return output;
}
export function expandSymbols(input: string, general = true): string {
  const words = tokenize(input), units: Unit[] = [];
  for (let at = 0; at < words.length;) {
    const match = matches(words, at, general)[0];
    units.push({ word: words[at], name: match?.name, at }); at += match?.count || 1;
  }
  return units.some(unit => unit.name) ? render(units) : input;
}
