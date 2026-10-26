import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSiteUrl } from '../site/urls.ts';

test('public site addresses preserve deployment paths and add one trailing slash', () => {
  for (const [input, expected] of [
    ['https://LIBERTTY.SH', 'https://libertty.sh/'],
    [' https://example.com/project ', 'https://example.com/project/'],
    ['https://example.com/project///', 'https://example.com/project/'],
    ['http://localhost:5180', 'http://localhost:5180/'],
  ]) assert.equal(normalizeSiteUrl(input), expected);
});

test('invalid public addresses cannot enter canonical links or sitemaps', () => {
  for (const input of ['', '/project/', 'libertty.sh', 'file:///tmp/site', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/?preview=1', 'https://example.com/#demo', 'https://example.com/?', 'https://example.com/#']) assert.throws(() => normalizeSiteUrl(input));
});
