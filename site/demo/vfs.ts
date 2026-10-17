import { files, modified } from 'virtual:libertty-repo';

/** An in-memory home directory whose ~/libertty is the repository snapshot; edits last for the visit. */
export const home = '/home/you', repo = home + '/libertty';
export interface Node { directory: boolean; mode: number; size: number; modified: number; data?: Uint8Array; url?: string; edited?: boolean }
const nodes = new Map<string, Node>();
const children = new Map<string, Set<string>>();
const encoder = new TextEncoder(), decoder = new TextDecoder();

function parentOf(path: string) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function link(path: string) {
  for (let child = path, parent = parentOf(path); child !== '/'; child = parent, parent = parentOf(parent)) {
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)!.add(child.slice(child.lastIndexOf('/') + 1));
    if (!nodes.has(parent)) nodes.set(parent, { directory: true, mode: 0o755, size: 4096, modified });
  }
}
for (const directory of ['/', '/home', home, repo, '/tmp']) { nodes.set(directory, { directory: true, mode: 0o755, size: 4096, modified }); link(directory); }
for (const file of files) {
  const path = repo + '/' + file.name;
  nodes.set(path, { directory: false, mode: file.mode & 0o777, size: file.size, modified, url: new URL('repo/' + file.name.split('/').map(encodeURIComponent).join('/'), document.baseURI).href });
  link(path);
}

export function normalize(path: string, cwd = repo): string {
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1);
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : cwd + '/' + path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
}
export function display(path: string) { return path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path; }
export function stat(path: string): Node | undefined { return nodes.get(path); }
export function list(path: string): string[] { return [...(children.get(path) || [])].sort((a, b) => a.localeCompare(b)); }

const original = window.fetch.bind(window);
export async function bytes(path: string): Promise<Uint8Array> {
  const node = nodes.get(path);
  if (!node) throw new Error('No such file or directory');
  if (node.directory) throw new Error('Is a directory');
  if (!node.data) {
    const response = await original(node.url!);
    if (!response.ok) throw new Error('Could not read file');
    node.data = new Uint8Array(await response.arrayBuffer());
  }
  return node.data;
}
export async function text(path: string) { return decoder.decode(await bytes(path)); }

export function write(path: string, content: string | Uint8Array) {
  const parent = nodes.get(parentOf(path));
  if (!parent?.directory) throw new Error('No such file or directory');
  if (nodes.get(path)?.directory) throw new Error('Is a directory');
  const data = typeof content === 'string' ? encoder.encode(content) : content;
  const previous = nodes.get(path);
  nodes.set(path, { directory: false, mode: previous?.mode ?? 0o644, size: data.length, modified: Date.now(), data, url: previous?.url, edited: !!previous?.url });
  link(path);
}
/** Files changed during the visit, relative to the repository, for git status. */
export function changes() {
  const modified: string[] = [], created: string[] = [];
  for (const [path, node] of nodes) {
    if (node.directory || !path.startsWith(repo + '/')) continue;
    if (node.edited) modified.push(path.slice(repo.length + 1));
    else if (!node.url) created.push(path.slice(repo.length + 1));
  }
  return { modified: modified.sort(), created: created.sort() };
}
export function mkdir(path: string) {
  if (nodes.has(path)) throw new Error('File exists');
  if (!nodes.get(parentOf(path))?.directory) throw new Error('No such file or directory');
  nodes.set(path, { directory: true, mode: 0o755, size: 4096, modified: Date.now() });
  link(path);
}
export function remove(path: string) {
  if (!nodes.has(path) || path === '/' || path === home) throw new Error('No such file or directory');
  for (const name of list(path)) remove(path + '/' + name);
  nodes.delete(path); children.delete(path);
  children.get(parentOf(path))?.delete(path.slice(path.lastIndexOf('/') + 1));
}
export function rename(from: string, to: string) {
  const node = nodes.get(from);
  if (!node) throw new Error('No such file or directory');
  if (nodes.has(to)) throw new Error('File exists');
  for (const name of list(from)) rename(from + '/' + name, to + '/' + name);
  nodes.set(to, node); link(to);
  nodes.delete(from); children.delete(from);
  children.get(parentOf(from))?.delete(from.slice(from.lastIndexOf('/') + 1));
}
