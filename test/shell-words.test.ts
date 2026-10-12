import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shellQuote, tokens, simpleWords } from '../src/shell-words.ts';
import { expandSymbols } from '../src/speech-symbols.ts';
import { transferAction, downloadPipeline } from '../src/transfer-command.ts';

test('frontend shell helpers preserve complete archived reference outputs', async () => {
  const corpora=await Promise.all(['engine','host'].map(async name => JSON.parse(await readFile(new URL('./fixtures/rust-migration/'+name+'.json',import.meta.url),'utf8'))));
  const operations: Record<string,(...args:any[])=>unknown>={shellQuote,tokens,simpleWords,expandSymbols,transferAction,downloadPipeline};
  const observed=new Set<string>();
  for (const row of corpora.flatMap(corpus=>corpus.fixtures)) {
    const operation=operations[row.operation]; if (!operation) continue;
    assert.deepEqual(JSON.parse(JSON.stringify(operation(...row.args)??null)),(row.expected ? row.expected.value : row.result)??null,row.operation+': '+JSON.stringify(row.args));
    observed.add(row.operation);
  }
  assert.deepEqual([...observed].sort(),Object.keys(operations).sort());
});
