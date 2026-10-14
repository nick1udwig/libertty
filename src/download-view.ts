import { button } from './dom.ts';
import './download-view.css';
export interface DownloadTicket { ticket: string; name: string; size: number }
export function showDownloads() { try { return localStorage.getItem('termai.showDownloads') !== 'false'; } catch { return true; } }
// Only inert formats are opened in the app's origin. HTML, SVG and executable
// documents stay plain text or downloads; downloaded scripts must never run here.
function previewType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain', md: 'text/plain', py: 'text/plain', js: 'text/plain', html: 'text/plain', svg: 'text/plain', json: 'text/plain', csv: 'text/plain', log: 'text/plain' } as Record<string, string>)[ext] || 'application/octet-stream';
}
let panel: ReturnType<typeof createPanel> | undefined;
function createPanel() {
  const modal = document.createElement('dialog'); modal.className = 'download-dialog'; modal.setAttribute('aria-label', 'Downloads');
  const heading = document.createElement('h2'); heading.textContent = 'Downloading…';
  const header = document.createElement('header'), rows = document.createElement('div'); rows.className = 'download-items';
  const abort = new AbortController(), urls: string[] = [];
  let pending = 0, failed = false;
  const dismiss = () => { modal.close(); dispose(); };
  const close = button('Cancel', dismiss);
  const x = button('×', dismiss); x.setAttribute('aria-label', 'Close downloads');
  header.append(heading, x);
  const label = document.createElement('label'), never = document.createElement('input'); never.type = 'checkbox'; never.checked = !showDownloads(); label.append(never, document.createTextNode('Don’t show this again')); label.className = 'download-preference';
  never.onchange = () => { try { localStorage.setItem('termai.showDownloads', JSON.stringify(!never.checked)); } catch { never.checked = false; } };
  const actions = document.createElement('div'); actions.className = 'download-actions'; actions.append(close);
  modal.append(header, rows, label, actions); document.body.append(modal);
  const show = () => { if (!modal.open) modal.showModal(); };
  if (showDownloads()) show();
  const dispose = () => { if (abort.signal.aborted) return; abort.abort(); modal.remove(); if (panel?.modal === modal) panel = undefined; setTimeout(() => urls.forEach(url => URL.revokeObjectURL(url)), 60000); };
  modal.onclose = dispose;
  modal.oncancel = event => { event.preventDefault(); dismiss(); };
  return { modal, abort, urls, rows, show, start() { pending++; heading.textContent = 'Downloading…'; close.textContent = 'Cancel'; }, end(error = false) { failed ||= error; if (--pending === 0) { heading.textContent = failed ? 'Download failed' : 'Download complete'; close.textContent = 'Close'; if (!modal.open && !failed) dispose(); } } };
}
/** XHR's Blob response lets the browser spool bytes without a JS chunk array. */
export async function downloadFile(base: string, prepare: () => Promise<DownloadTicket>, fallbackName = 'File') {
  const view = panel ||= createPanel(); view.start();
  const row = document.createElement('section'), name = document.createElement('p'), progress = document.createElement('progress'), status = document.createElement('p');
  name.textContent = fallbackName; progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', 'Download progress'); status.role = 'status'; status.textContent = '0% · Preparing download…';
  row.append(name, progress, status); view.rows.append(row);
  try {
    const ticket = await prepare(); view.abort.signal.throwIfAborted(); name.textContent = ticket.name;
    const url = new URL('api/files/download', base); url.searchParams.set('ticket', ticket.ticket);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.responseType = 'blob'; xhr.timeout = 30 * 60 * 1000;
      const stop = () => xhr.abort(); view.abort.signal.addEventListener('abort', stop, { once: true });
      xhr.onloadend = () => view.abort.signal.removeEventListener('abort', stop);
      xhr.onprogress = event => { const total = event.lengthComputable ? event.total : ticket.size; const percent = total ? Math.min(99, Math.floor(event.loaded / total * 100)) : 0; progress.value = percent; status.textContent = `${percent}% · ${(event.loaded / 1024 / 1024).toFixed(1)} MB received`; };
      xhr.onload = () => xhr.status === 200 ? resolve(xhr.response) : reject(new Error('Download failed. Try downloading the file again.'));
      xhr.onerror = () => reject(new Error('Download interrupted. Check your connection and try again.'));
      xhr.ontimeout = () => reject(new Error('Download timed out. Try again.'));
      xhr.onabort = () => reject(new DOMException('Download cancelled.', 'AbortError'));
      xhr.send();
    });
    view.abort.signal.throwIfAborted();
    const saved = URL.createObjectURL(blob); view.urls.push(saved);
    const link = document.createElement('a'); link.href = saved; link.download = ticket.name; document.body.append(link); link.click(); link.remove();
    progress.value = 100; status.textContent = '100% · Download complete';
    const open = button('Open', () => { const preview = URL.createObjectURL(blob.slice(0, blob.size, previewType(ticket.name))); view.urls.push(preview); window.open(preview, '_blank', 'noopener,noreferrer'); }); open.className = 'download-open'; row.append(open);
    view.end();
  } catch (error) {
    view.end(true);
    if (view.abort.signal.aborted) throw error;
    if (!view.abort.signal.aborted) { status.textContent = error instanceof Error ? error.message : 'Download failed.'; row.classList.add('download-error'); view.show(); }
  }
}
