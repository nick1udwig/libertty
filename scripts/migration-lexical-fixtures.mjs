import { writeFile } from 'node:fs/promises';
import { tokens } from '../src/engine/repair.ts';
import { simpleWords } from '../src/engine/validation.ts';

const fixtures = [];
for (const code of [9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
  const space = String.fromCodePoint(code);
  for (const input of ['echo' + space + '🌍', space + "'quoted" + space + "value'", "echo 'unterminated" + space + '界']) {
    for (const [operation, call] of [['tokens', tokens], ['simpleWords', simpleWords]]) fixtures.push({ operation, args: [input], result: call(input) ?? null });
  }
}
await writeFile(new URL('../test/fixtures/rust-migration/lexical.json', import.meta.url), JSON.stringify({ version: 1, reference: '455386bc9443e778f381e1eeaf37cec5a35c2f75', fixtures }) + '\n');
console.log('Captured ' + fixtures.length + ' independent Unicode whitespace and quoting fixtures.');
