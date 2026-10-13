import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, tokens, simpleWords } from '../src/shell-words.ts';
import { expandSymbols } from '../src/speech-symbols.ts';
import { transferAction, downloadPipeline } from '../src/transfer-command.ts';

test('shell quoting and parsing preserve literal arguments and reject expansion', () => {
  assert.equal(shellQuote("~/it's a file"), "~/'it'\\''s a file'");
  assert.deepEqual(tokens('echo "hello 🌍"'), [{ value: 'echo', quoted: false }, { value: 'hello 🌍', quoted: true }]);
  assert.deepEqual(simpleWords("cat ~/notes\\ file '🌍'"), [
    { value: 'cat', home: false }, { value: '~/notes file', home: true }, { value: '🌍', home: false },
  ]);
  for (const command of ['echo $HOME', 'echo *.txt', 'echo `pwd`', "echo 'unfinished", 'echo hi | cat']) {
    assert.equal(simpleWords(command), undefined, command);
  }
});

test('transfer helpers recognize actions without interpreting quoted commands or pipes', () => {
  assert.equal(expandSymbols('cat tilde slash notes dot txt'), 'cat ~/notes.txt');
  assert.equal(transferAction('upload "notes file"'), 'upload');
  assert.equal(transferAction("'upload' notes"), undefined);
  assert.deepEqual(downloadPipeline("printf '%s' 'a|b' | download 'notes file'"), {
    command: "printf '%s' 'a|b'", tail: "download 'notes file'",
  });
  for (const command of ["echo 'a | download'", 'echo hi || download', 'cat file | download --file', 'cat file | download a b']) {
    assert.equal(downloadPipeline(command), undefined, command);
  }
});
