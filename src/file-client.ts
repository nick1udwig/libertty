import { request as sendRequest, responseJSON } from './api.ts';
import type { FileClient } from './file-browser.ts';
import { downloadFile, type DownloadTicket } from './download-view.ts';
export function saveDownload(base: string, prepare: () => Promise<DownloadTicket>, name?: string) { return downloadFile(base, prepare, name); }
export function fileClient(base: string, session: string, token: () => string | undefined, authenticate: () => Promise<void>): FileClient {
  async function request<T = any>(route: string, query: Record<string, string>, init: RequestInit = {}) {
    const url = new URL(route, base); url.search = new URLSearchParams({ session, ...query }).toString();
    return responseJSON<T>(await sendRequest(url, { ...init, token, recoverAuth: authenticate, ...(route.endsWith('/upload') ? { timeout: 0 } : {}) }));
  }
  return {
    action: input => request('api/files/action', {}, { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }),
    async mkdir(path, name) { await request('api/files/mkdir', {}, { method: 'POST', body: JSON.stringify({ path, name }), headers: { 'Content-Type': 'application/json' } }); },
    list: path => request('api/files/list', { path }),
    async upload(path, file, signal) {
      if (file.size > 1024 ** 3) throw new Error('Uploads are limited to 1 GB per file.');
      await request('api/files/upload', { path, name: file.name }, { method: 'POST', body: file, signal, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    async download(path) {
      await saveDownload(base, () => request('api/files/download', {}, { method: 'POST', body: JSON.stringify({ path }), headers: { 'Content-Type': 'application/json' } }), path.split('/').pop());
    },
  };
}
