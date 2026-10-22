import type { FileEntry } from './generated/protocol.ts';
export type FileSort = 'name' | 'date' | 'size' | 'kind';
export interface FileOptions { sort: FileSort; descending: boolean; hidden: boolean }
export function sortedFiles(entries: FileEntry[], options: FileOptions, query = '') {
  const kind = (file: FileEntry) => file.directory ? '' : file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  return entries.filter(e => (options.hidden || !e.name.startsWith('.')) && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => {
    const folders = Number(b.directory) - Number(a.directory); if (folders) return folders;
    const order = options.sort === 'date' ? a.modified - b.modified : options.sort === 'size' ? a.size - b.size : options.sort === 'kind' ? kind(a).localeCompare(kind(b)) : a.name.localeCompare(b.name, undefined, { numeric: true });
    return (options.descending ? -order : order) || a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}
export function fileBreadcrumbs(path: string) {
  let prefix = '';
  const all = [{ name: '/', path: '/' }, ...path.split('/').filter(Boolean).map(name => ({ name, path: prefix += '/' + name }))];
  return { visible: all.slice(-2), ancestors: all.slice(0, -2).reverse() };
}
