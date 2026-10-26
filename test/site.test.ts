import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../site/pages.ts';

const root = new URL('../', import.meta.url).pathname;

test('guide metadata keeps a public deployment path without a supplied trailing slash', () => {
  const html = renderPage(root, 'https://example.com/project', 'usage');
  assert.ok(html.includes('<link rel="canonical" href="https://example.com/project/usage/">'));
  assert.ok(html.includes('<meta property="og:url" content="https://example.com/project/usage/">'));
  assert.ok(html.includes('<meta property="og:image" content="https://example.com/project/social.png">'));
  assert.ok(html.includes('<title>Use libertty from your phone</title>'));
});

test('guide metadata escapes URL characters without changing their destination', () => {
  const html = renderPage(root, 'https://example.com/&copy;', 'herdr');
  assert.ok(html.includes('href="https://example.com/&amp;copy;/herdr/"'));
  assert.ok(html.includes('content="https://example.com/&amp;copy;/social.png"'));
});
