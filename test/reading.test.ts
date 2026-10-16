import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultReadingPhrases, readingPath, readingPhrases, readingRequest, readingPipeline } from '../src/reading-request.ts';
import { shellQuote, simpleWords } from '../src/shell-words.ts';
import { nativeSuggest } from './support/engine.ts';
import { mkdtemp, mkdir, writeFile, rm, stat, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('reading phrases match whole phrases and keep paths with spaces', () => {
  assert.deepEqual(defaultReadingPhrases, ['look at']);
  assert.equal(readingPath('Look at "notes with spaces.md"', defaultReadingPhrases), 'notes with spaces.md');
  assert.equal(readingPath('look at /tmp/picture.png.', defaultReadingPhrases, true), '/tmp/picture.png');
  assert.equal(readingPath('look at notes.', defaultReadingPhrases), 'notes.');
  assert.equal(readingPath("look at 'note with spaces.md'", defaultReadingPhrases), 'note with spaces.md');
  assert.equal(readingPath('look at', defaultReadingPhrases), undefined);
  assert.equal(readingPath('look atlass', defaultReadingPhrases), undefined);
  assert.equal(readingPath('inspect notes.txt', readingPhrases(['Inspect', 'look at'])), 'notes.txt');
  assert.deepEqual(readingPhrases(['LOOK   AT', 'look at']), ['look at']);
  assert.deepEqual(readingPhrases(['']), defaultReadingPhrases);
});

test('reader pipelines preserve Bash input and ignore quoted pipe text', () => {
  assert.deepEqual(readingPipeline('git diff | look at', ['look at']), { command: 'git diff', phrase: 'look at' });
  assert.deepEqual(readingPipeline('git diff pipe inspect', ['inspect'], true), { command: 'git diff', phrase: 'inspect' });
  assert.equal(readingPipeline("printf '%s' 'git diff | look at'", ['look at']), undefined);
  assert.equal(readingPipeline('git diff || look at', ['look at']), undefined);
  assert.equal(readingPipeline('git diff | look at other', ['look at']), undefined);
  assert.equal(readingPipeline('echo "$(git diff | look at)"', ['look at']), undefined);
  assert.deepEqual(readingPipeline("git diff | head -20 | look at", ['look at']), { command: 'git diff | head -20', phrase: 'look at' });
  assert.equal(readingRequest("look at printf '%s' 'a b'", ['look at'])?.operand, "printf '%s' 'a b'");
});

// The backend repairs a reading operand as a `cat` command and keeps only single-file results.
const readingSuggestionInput = (request: { path: string; operand?: string }) => 'cat ' + (request.operand || request.path);
function readingSuggestionChoice(command: string, phrase: string) {
  const words = simpleWords(command);
  if (words?.length !== 2 || words[0].value !== 'cat') return undefined;
  return phrase + ' ' + shellQuote(words[1].value);
}

test('reading alternatives use the command engine’s verified file and directory repairs', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'libertty-read-alternates-'));
  try {
    await mkdir(path.join(cwd, 'docs'));
    await writeFile(path.join(cwd, 'README.md'), '# Read me');
    await writeFile(path.join(cwd, 'docs', 'Guide.md'), '# Guide');
    const catalog = { cwd, commands: ['cat', 'ls'], paths: ['README.md', 'docs/', 'docs/Guide.md'], history: [] };
    for (const aliases of [false, true]) {
      if (aliases) {
        // Matching inodes reproduce case-insensitive lookups on Linux too.
        for (const [actual, alias] of [['README.md', 'readme.md'], ['docs/Guide.md', 'docs/guide.md']]) {
          if (!await stat(path.join(cwd, alias)).catch(() => undefined)) await link(path.join(cwd, actual), path.join(cwd, alias));
        }
      }
      for (const [spoken, expected] of [
        ['look at readme dot md', 'look at README.md'],
        ['look at docs slash guide dot md', 'look at docs/Guide.md'],
        ['inspect readme dot md', 'inspect README.md'],
      ]) {
        const request = readingRequest(spoken, ['look at', 'inspect'], true)!;
        const candidates = await nativeSuggest(readingSuggestionInput(request), catalog, { HOME: cwd, PATH: process.env.PATH! });
        const choices = candidates.filter(candidate => !candidate.literal)
          .map(candidate => readingSuggestionChoice(candidate.command, request.phrase)).filter(Boolean);
        assert.ok(choices.length, JSON.stringify(candidates));
        const selected = readingPath(choices[0]!, [request.phrase]);
        assert.ok(selected, JSON.stringify(candidates));
        const target = readingPath(expected, [request.phrase])!;
        const [selectedFile, targetFile] = await Promise.all([stat(path.resolve(cwd, selected)), stat(path.resolve(cwd, target))]);
        assert.equal(selectedFile.dev, targetFile.dev, JSON.stringify(candidates));
        assert.equal(selectedFile.ino, targetFile.ino, JSON.stringify(candidates));
        const lowerCaseFile = await stat(path.resolve(cwd, target.toLowerCase())).catch(() => undefined);
        if (lowerCaseFile?.dev !== targetFile.dev || lowerCaseFile?.ino !== targetFile.ino) assert.equal(choices[0], expected, JSON.stringify(candidates));
      }
    }
    assert.equal(readingSuggestionChoice("cat 'note with spaces.md'", 'look at'), "look at 'note with spaces.md'");
    assert.equal(readingSuggestionChoice('ls README.md', 'look at'), undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
