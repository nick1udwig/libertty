import { button, node } from './dom.ts';
import { saved } from './persistence.ts';
import './file-browser.css';
import { uploadIcon, downloadIcon, moreIcon, searchIcon, chevronIcon, folderIcon, fileOptionIcons, closeIcon } from './icons.ts';
import { fileBreadcrumbs, sortedFiles, type FileOptions, type FileSort } from './file-options.ts';
import type { FileListing, FileEntry } from './generated/protocol.ts';

export interface FileClient {
  action(input: Record<string, unknown>): Promise<{ text?: string; version?: string }>;
  mkdir(path: string, name: string): Promise<void>;
  list(path: string): Promise<FileListing>;
  download(path: string): Promise<void>;
  upload(path: string, file: File, signal: AbortSignal): Promise<void>;
}
const folder = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M3 5h10l3 3h13a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>';
const documentIcon = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M7 2h12l7 7v20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M19 2v8h7" fill="none" style="stroke:var(--bg)" stroke-width="2"/></svg>';
export function fileSize(size: number) { if (size < 1024) return size + ' bytes'; const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024))); return (size / 1024 ** unit).toFixed(1) + ' ' + ['bytes', 'KB', 'MB', 'GB'][unit]; }
function permissions(entry: FileEntry) { return (entry.symlink ? 'l' : entry.directory ? 'd' : '-') + Array.from({ length: 9 }, (_, n) => entry.mode & (1 << (8 - n)) ? 'rwx'[n % 3] : '-').join(''); }
export function fileBrowser(client: FileClient, initial = '.', changed: (path: string) => void = () => {}) {
  const element = node('section', 'file-browser'); element.setAttribute('aria-label', 'Files');
  const toolbar = node('div', 'file-toolbar');
  const crumbs = node('nav', 'file-breadcrumbs'); crumbs.setAttribute('aria-label', 'Directory');
  const search = node('input'); search.type = 'search'; search.placeholder = 'Search this folder'; search.setAttribute('aria-label', 'Search this folder'); search.className = 'file-search'; search.hidden = true;
  const picker = node('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  const status = node('p', 'file-status'); status.role = 'status'; status.setAttribute('aria-live', 'polite');
  const list = node('div', 'file-list'); list.setAttribute('aria-label', 'Directory contents');
  let current = initial, listing: FileListing | undefined, generation = 0, disposed = false, uploading = false;
  const abort = new AbortController();
  const selected = new Set<string>();
  let hold: ReturnType<typeof setTimeout> | undefined;
  const stopHold = () => { clearTimeout(hold); hold = undefined; };
  const selection = node('div', 'file-selection'); selection.hidden = true;
  const count = node('strong');
  const clear = button('', () => { selected.clear(); render(); }); clear.innerHTML = closeIcon; clear.setAttribute('aria-label', 'Clear selection'); selection.append(clear, count);
  const loading = node('span', 'file-loading-spinner'); loading.setAttribute('role', 'status'); loading.setAttribute('aria-label', 'Loading files');
  const upload = button('', () => picker.click()); upload.className = 'file-upload'; upload.innerHTML = uploadIcon + '<span>Upload</span>'; upload.setAttribute('aria-label', 'Upload');
  const more = button('', () => selected.size ? openSelection() : openOptions()); more.innerHTML = moreIcon; more.setAttribute('aria-label', 'File options'); more.setAttribute('aria-haspopup', 'menu');
  const find = button('', () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; render(); } }); find.innerHTML = searchIcon; find.setAttribute('aria-label', 'Search files');
  toolbar.append(selection, crumbs, loading, upload, more, find); element.append(toolbar, search, status, list, picker);
  const error = (reason: unknown) => { if (!disposed) { status.textContent = reason instanceof Error ? reason.message : 'File transfer failed.'; status.classList.add('error'); } };
  let options: FileOptions = { sort: 'name', descending: false, hidden: false };
  const stored = saved<Partial<FileOptions>>('fileOptions', {}); if (stored.sort && ['name', 'date', 'size', 'kind'].includes(stored.sort)) options = { sort: stored.sort, descending: stored.descending === true, hidden: stored.hidden === true };
  const saveOptions = () => { try { localStorage.setItem('libertty.fileOptions', JSON.stringify(options)); } catch {} render(); };
  let menu: HTMLElement | undefined, anchor: HTMLButtonElement | undefined;
  function closeMenu(focus = false) { menu?.remove(); menu = undefined; anchor?.setAttribute('aria-expanded', 'false'); if (focus) anchor?.focus(); anchor = undefined; }
  interface MenuItem { label: string; icon: string; action: () => void; checked?: boolean; detail?: string; separator?: boolean }
  function openMenu(control: HTMLButtonElement, items: MenuItem[]) {
    if (anchor === control) { closeMenu(true); return; } closeMenu(); anchor = control; control.setAttribute('aria-expanded', 'true');
    menu = node('div', 'file-menu'); menu.role = 'menu'; menu.setAttribute('aria-label', control.getAttribute('aria-label') || 'Directories');
    for (const item of items) {
      if (item.separator) menu.append(node('hr'));
      const row = button('', () => { closeMenu(); item.action(); }); row.role = item.checked === undefined ? 'menuitem' : item.label === 'Hidden files' ? 'menuitemcheckbox' : 'menuitemradio';
      row.setAttribute('aria-label', item.label); if (item.checked !== undefined) row.setAttribute('aria-checked', String(item.checked));
      const glyph = node('span'); glyph.innerHTML = item.icon; glyph.className = 'file-menu-icon';
      const label = node('span'); label.textContent = item.label;
      const detail = node('span', 'file-menu-detail'); detail.textContent = item.detail || (item.checked ? '✓' : '');
      row.append(glyph, label, detail); menu.append(row);
    }
    element.append(menu); const bounds = element.getBoundingClientRect(), rect = control.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left - bounds.left, bounds.width - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.min(rect.bottom - bounds.top + 8, bounds.height - 100) + 'px'; menu.style.maxHeight = Math.max(100, bounds.height - parseFloat(menu.style.top) - 12) + 'px';
    menu.onkeydown = event => { const rows = [...menu!.querySelectorAll('button')], i = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (event.key === 'Tab') closeMenu();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (i + (event.key === 'ArrowUp' ? rows.length - 1 : 1)) % rows.length]?.focus(); }
    }; menu.querySelector('button')?.focus();
  }
  const outside = (event: PointerEvent) => { if (menu && !menu.contains(event.target as Node) && !anchor?.contains(event.target as Node)) closeMenu(); };
  document.addEventListener('pointerdown', outside); window.addEventListener('resize', closeMenuOnResize);
  function closeMenuOnResize() { closeMenu(); }
  function openOptions() {
    openMenu(more, [
      { label: 'New folder', icon: fileOptionIcons.folder, action: newFolder },
      ...(['name', 'date', 'size', 'kind'] as FileSort[]).map((sort, i) => ({ label: 'Sort by ' + sort, icon: fileOptionIcons[sort], separator: i === 0, checked: options.sort === sort, detail: options.sort === sort ? options.descending ? '↓' : '↑' : '', action() { options.descending = options.sort === sort ? !options.descending : sort === 'date' || sort === 'size'; options.sort = sort; saveOptions(); } })),
      { label: 'Copy path', icon: fileOptionIcons.copy, separator: true, action: () => { if (!navigator.clipboard) { status.textContent = current; return; } void navigator.clipboard.writeText(current).then(() => { status.textContent = 'Path copied.'; }, error); } },
      { label: 'Hidden files', icon: fileOptionIcons.hidden, checked: options.hidden, action: () => { options.hidden = !options.hidden; saveOptions(); } },
      { label: 'Refresh folder', icon: fileOptionIcons.refresh, action: () => void load(current) },
      { label: 'Show guide', icon: fileOptionIcons.help, action: () => { status.textContent = 'Tap folders to browse and files to download. Hold an item to select it, then tap more items to select them. Shift+Space also selects. Upload sends device files to this folder. Tap a selected sort option to reverse it. Downloads use your browser’s download location settings.'; } },
    ]);
  }
  function selectedPaths() { return [...selected].map(name => (current === '/' ? '' : current) + '/' + name); }
  async function runAction(input: Record<string, unknown>) { status.textContent = 'Working…'; try { await client.action(input); selected.clear(); await load(current); } catch (e) { error(e); } }
  function promptAction(title: string, field: string, value: string, submit: (value: string) => Promise<void>, multiline = false) {
    const modal = node('dialog', 'file-action-dialog'); modal.setAttribute('aria-label', title);
    const heading = node('h2'); heading.textContent = title;
    const form = node('form'), input = document.createElement(multiline ? 'textarea' : 'input'), message = node('p');
    input.value = value; input.setAttribute('aria-label', field); input.required = !multiline;
    if (multiline) { (input as HTMLTextAreaElement).rows = 14; input.spellcheck = false; }
    const cancel = button('Cancel', () => modal.close()), save = button(multiline ? 'Save' : 'Confirm', () => {}); save.type = 'submit'; save.className = 'primary';
    const actions = node('div', 'actions'); actions.append(cancel, save); form.append(heading, input, message, actions); modal.append(form); element.append(modal); modal.showModal(); input.focus();
    form.onsubmit = async event => { event.preventDefault(); save.disabled = true; try { await submit(input.value); modal.close(); selected.clear(); await load(current); } catch (e) { message.textContent = e instanceof Error ? e.message : 'Operation failed.'; save.disabled = false; } }; modal.onclose = () => modal.remove();
  }
  function openSelection() {
    const paths = selectedPaths(), entries = listing!.entries.filter(item => selected.has(item.name)), single = entries.length === 1;
    const items: MenuItem[] = [
      { label: 'Copy', icon: fileOptionIcons.copy, action: () => promptAction('Copy selected items', 'Destination folder', current, async destination => { await client.action({ action: 'copy', paths, destination }); }) },
    ];
    if (entries.every(item => !item.directory)) items.push({ label: 'Download', icon: downloadIcon, action: () => { selected.clear(); render(); void (async () => { for (const path of paths) await client.download(path); })().catch(error); } });
    if (single && !entries[0].directory && !entries[0].symlink) items.push({ label: 'Edit', icon: fileOptionIcons.edit, action: () => { status.textContent = 'Opening file…'; void client.action({ action: 'read', path: paths[0] }).then(result => { status.textContent = ''; promptAction('Edit ' + entries[0].name, 'File content', result.text || '', async text => { await client.action({ action: 'write', path: paths[0], version: result.version, text }); }, true); }, error); } });
    if (single) items.push({ label: 'Rename', icon: fileOptionIcons.edit, action: () => promptAction('Rename', 'File name', entries[0].name, async name => { await client.action({ action: 'rename', path: paths[0], name }); }) });
    items.push({ label: 'Copy path', icon: fileOptionIcons.copy, action: () => { if (!navigator.clipboard) { status.textContent = paths.join('\n'); return; } void navigator.clipboard.writeText(paths.join('\n')).then(() => { status.textContent = 'Paths copied.'; }, error); } });
    items.push({ label: 'Delete', icon: fileOptionIcons.delete, separator: true, action: () => {
      const modal = node('dialog', 'file-action-dialog'); modal.setAttribute('aria-label', 'Delete selected items');
      const title = node('h2'); title.textContent = `Delete ${paths.length} selected item${paths.length === 1 ? '' : 's'}?`;
      const detail = node('p', '', 'Folders include all their contents. This cannot be undone.');
      const cancel = button('Cancel', () => modal.close()), remove = button('Delete', () => { modal.close(); void runAction({ action: 'delete', paths }); }); remove.className = 'danger'; modal.append(title, detail, cancel, remove); element.append(modal); modal.showModal(); cancel.focus(); modal.onclose = () => modal.remove();
    } });
    openMenu(more, items);
  }
  function newFolder() {
    const destination = current, modal = node('dialog', 'file-new-folder');
    const form = node('form'), title = node('h2'), name = node('input'), message = node('p');
    title.textContent = 'New folder'; name.required = true; name.placeholder = 'Folder name'; name.setAttribute('aria-label', 'Folder name');
    const cancel = button('Cancel', () => modal.close()), create = button('Create', () => {}); create.type = 'submit'; create.className = 'primary';
    form.append(title, name, message, cancel, create); modal.append(form); element.append(modal); modal.showModal(); name.focus();
    form.onsubmit = async event => { event.preventDefault(); create.disabled = true; try { await client.mkdir(destination, name.value); modal.close(); await load(current); } catch (e) { message.textContent = e instanceof Error ? e.message : 'Could not create folder.'; create.disabled = false; } };
    modal.onclose = () => modal.remove();
  }
  function render(keepRows = false) {
    if (!keepRows) { stopHold(); list.replaceChildren(); } selection.hidden = !selected.size; crumbs.hidden = upload.hidden = find.hidden = !!selected.size; count.textContent = `${selected.size} selected`; more.setAttribute('aria-label', selected.size ? 'Selection options' : 'File options'); if (!listing) return;
    if (keepRows) { for (const b of list.querySelectorAll<HTMLButtonElement>('[data-name]')) { const info = listing.entries.find(item => item.name === b.dataset.name)!; const active = selected.has(info.name); b.setAttribute('aria-pressed', String(active)); b.querySelector('.file-icon')!.innerHTML = active ? '<span class="file-selected-mark">✓</span>' : info.directory ? folder : documentIcon; } return; }
    const row = (name: string, directory: boolean, action: () => void, info?: FileEntry) => {
      const toggle = () => { if (selected.has(name)) selected.delete(name); else selected.add(name); render(true); };
      let skipClick = false;
      const b = button('', () => { if (skipClick) { skipClick = false; return; } if (info && selected.size) toggle(); else action(); });
      if (info) {
        b.dataset.name = name;
        b.setAttribute('aria-pressed', String(selected.has(name)));
        let startX = 0, startY = 0;
        b.onpointerdown = event => { if (event.button !== 0) return; skipClick = false; stopHold(); startX = event.clientX; startY = event.clientY; hold = setTimeout(() => { skipClick = true; toggle(); }, 450); };
        b.onpointermove = event => { if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) stopHold(); };
        b.onpointerup = b.onpointercancel = b.onpointerleave = stopHold;
        b.oncontextmenu = event => { event.preventDefault(); stopHold(); skipClick = true; if (!selected.has(name)) { selected.add(name); render(true); } };
        b.onkeydown = event => { if (event.key === ' ' && event.shiftKey) { event.preventDefault(); toggle(); } };
      } b.className = 'file-row'; b.setAttribute('aria-label', (directory ? 'Open folder ' : 'Download ') + name);
      const icon = node('span', 'file-icon'); icon.innerHTML = info && selected.has(name) ? '<span class="file-selected-mark">✓</span>' : directory ? folder : documentIcon;
      const text = node('span', 'file-details');
      const title = node('span', 'file-name'); title.textContent = name;
      const meta = node('span', 'file-meta');
      if (info) { const mode = node('span'), date = node('span'); mode.textContent = permissions(info); date.textContent = new Date(info.modified).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); meta.append(mode, date); }
      text.append(title);
      if (info && !directory) { const size = node('span', 'file-size'); size.textContent = fileSize(info.size); title.append(size); }
      text.append(meta); b.append(icon, text); list.append(b);
    };
    if (current !== '/') row('..', true, () => void load(listing!.parent));
    const shown = sortedFiles(listing.entries, options, search.value);
    for (const item of shown) {
      const path = (current === '/' ? '' : current) + '/' + item.name;
      row(item.name, item.directory, () => item.directory ? void load(path) : void client.download(path).catch(error), item);
    }
    if (!shown.length) { const empty = node('p', 'file-empty'); empty.textContent = search.value ? 'No matching files.' : 'This folder is empty.'; list.append(empty); }
  }
  async function load(path: string) {
    closeMenu(); stopHold();
    const request = ++generation; if (!listing) upload.disabled = true;
    loading.classList.add('is-loading'); list.setAttribute('aria-busy', 'true');
    try {
      const result = await client.list(path); if (disposed || request !== generation) return;
      listing = result; current = result.path; selected.clear(); changed(current); search.value = ''; crumbs.replaceChildren();
      const trail = fileBreadcrumbs(current);
      if (trail.ancestors.length) {
        const older = button('…', () => openMenu(older, trail.ancestors.map(ancestor => ({ label: ancestor.name, icon: folderIcon, action: () => void load(ancestor.path) }))));
        older.setAttribute('aria-label', 'Earlier directories'); older.setAttribute('aria-haspopup', 'menu'); crumbs.append(older);
      }
      for (const part of trail.visible) {
        if (crumbs.children.length) { const divider = node('span'); divider.innerHTML = chevronIcon; crumbs.append(divider); }
        const crumb = button(part.name, () => void load(part.path)); crumb.title = part.path; if (part.path === current) crumb.setAttribute('aria-current', 'location'); crumbs.append(crumb);
      }
      status.classList.remove('error'); status.textContent = result.truncated ? 'Showing the first 10,000 entries. Open a subfolder to browse further.' : ''; render();
    } catch (e) { if (request === generation) error(e); }
    finally { if (request === generation) { list.setAttribute('aria-busy', 'false'); loading.classList.remove('is-loading'); upload.disabled = uploading || !listing; } }
  }
  picker.onchange = async () => {
    if (upload.disabled) { picker.value = ''; return; } const files = [...picker.files || []], destination = current; picker.value = ''; if (!files.length) return;
    uploading = true; upload.disabled = true;
    try { for (const file of files) { status.classList.remove('error'); status.textContent = 'Uploading ' + file.name + '…'; await client.upload(destination, file, abort.signal); } await load(current); status.textContent = `${files.length} file${files.length === 1 ? '' : 's'} uploaded.`; }
    catch (e) { error(e); }
    finally { uploading = false; upload.disabled = false; }
  };
  search.oninput = () => render();
  void load(initial);
  return { element, dispose() { disposed = true; stopHold(); abort.abort(); closeMenu(); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', closeMenuOnResize); element.remove(); } };
}
