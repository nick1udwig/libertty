import type { FileEntry } from './generated/protocol.ts';
export type FileSort = 'name' | 'date' | 'size' | 'kind';
export interface FileOptions { sort: FileSort; descending: boolean; hidden: boolean }
const names = new Intl.Collator(undefined, { numeric: true }), kinds = new Intl.Collator();
export function sortedFiles(entries: FileEntry[], options: FileOptions, query = '') {
  query = query.toLocaleLowerCase();
  const kind = (file: FileEntry) => file.directory ? '' : file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  return entries.filter(e => (options.hidden || !e.name.startsWith('.')) && e.name.toLocaleLowerCase().includes(query)).sort((a, b) => {
    const folders = Number(b.directory) - Number(a.directory); if (folders) return folders;
    const order = options.sort === 'date' ? a.modified - b.modified : options.sort === 'size' ? a.size - b.size : options.sort === 'kind' ? kinds.compare(kind(a), kind(b)) : names.compare(a.name, b.name);
    return (options.descending ? -order : order) || names.compare(a.name, b.name);
  });
}
export function fileBreadcrumbs(path: string) {
  let prefix = '';
  const all = [{ name: '/', path: '/' }, ...path.split('/').filter(Boolean).map(name => ({ name, path: prefix += '/' + name }))];
  return { visible: all.slice(-2), ancestors: all.slice(0, -2).reverse() };
}
