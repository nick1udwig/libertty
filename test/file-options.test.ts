import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileBreadcrumbs, sortedFiles } from '../src/file-options.ts';
const entries = [
  { name: 'b.txt', directory: false, symlink: false, mode: 0o644, modified: 3, size: 1 },
  { name: 'a.py', directory: false, symlink: false, mode: 0o644, modified: 1, size: 3 },
  { name: '.secret', directory: false, symlink: false, mode: 0o644, modified: 2, size: 2 },
  { name: 'docs', directory: true, symlink: false, mode: 0o755, modified: 0, size: 0 },
];
test('breadcrumbs show two locations with nearest older ancestors first', () => {
  assert.deepEqual(fileBreadcrumbs('/home/nick/Work/git/libertty'), { visible: [{ name: 'git', path: '/home/nick/Work/git' }, { name: 'libertty', path: '/home/nick/Work/git/libertty' }], ancestors: [{ name: 'Work', path: '/home/nick/Work' }, { name: 'nick', path: '/home/nick' }, { name: 'home', path: '/home' }, { name: '/', path: '/' }] });
  assert.deepEqual(fileBreadcrumbs('/').visible, [{ name: '/', path: '/' }]); assert.equal(fileBreadcrumbs('/home').ancestors.length, 0);
});
test('sort direction, kind, filtering and hidden-file preferences keep folders first', () => {
  const names = (sort: 'name' | 'date' | 'size' | 'kind', descending = false, hidden = false) => sortedFiles(entries, { sort, descending, hidden }).map(e => e.name);
  assert.deepEqual(names('name'), ['docs', 'a.py', 'b.txt']);
  assert.deepEqual(names('name', true), ['docs', 'b.txt', 'a.py']);
  assert.deepEqual(names('date', true), ['docs', 'b.txt', 'a.py']);
  assert.deepEqual(names('size', true), ['docs', 'a.py', 'b.txt']);
  assert.deepEqual(names('kind'), ['docs', 'a.py', 'b.txt']);
  assert.ok(names('name', false, true).includes('.secret'));
  assert.deepEqual(sortedFiles(entries, { sort: 'name', descending: false, hidden: false }, '.py').map(e => e.name), ['a.py']);
  assert.equal(entries[0].name, 'b.txt');
});
test('numeric names and case-insensitive searches preserve the sorted order', () => {
  const files = ['file10.TXT', 'file2.txt', 'file1.txt'].map(name => ({ ...entries[0], name }));
  const options = { sort: 'name' as const, descending: false, hidden: false };
  assert.deepEqual(sortedFiles(files, options, 'TXT').map(file => file.name), ['file1.txt', 'file2.txt', 'file10.TXT']);
});
