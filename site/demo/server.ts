import { Herdr } from './herdr.ts';
import { captures, Shell, type Peer } from './shell.ts';
import { bytes, list, mkdir, normalize, remove, rename, repo, stat, text, write } from './vfs.ts';

/** The demo's backend: the HTTP routes and WebSocket endpoints the app uses, answered in the page. */
export interface Reply { status: number; type?: string; body: string | Uint8Array }
export interface Connection { message(data: string): void; close(): void }
export interface DemoServer { request(method: string, url: string, body: string | Uint8Array | undefined): Promise<Reply>; connect(url: string, peer: Peer): Connection }

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const json = (value: unknown, status = 200): Reply => ({ status, type: 'application/json', body: JSON.stringify(value) });
const failure = (error: string, status = 400) => json({ error }, status);
const types: Record<string, string> = { md: 'text/markdown', png: 'image/png', svg: 'image/svg+xml', json: 'application/json', mp3: 'audio/mpeg', woff2: 'font/woff2', html: 'text/html' };
const typeOf = (path: string) => types[path.split('.').pop()!.toLowerCase()] || 'text/plain; charset=utf-8';

export function createServer(): DemoServer {
  const shells = new Map<string, Shell>(), herdr = new Herdr();
  const downloads = new Map<string, string>(), uploads = new Map<string, Uint8Array[]>();
  const shell = (session: string | null) => { const id = session || 'default'; let found = shells.get(id); if (!found) shells.set(id, found = new Shell()); return found; };
  const resolve = (path: string | null, session: string | null) => normalize(path || '.', shells.get(session || 'default')?.cwd || repo);
  const entry = (path: string) => { const node = stat(path)!; return { name: path.slice(path.lastIndexOf('/') + 1), directory: node.directory, symlink: false, size: node.size, modified: node.modified, mode: node.mode | (node.directory ? 0o40000 : 0o100000) }; };

  async function route(method: string, url: URL, body: any): Promise<Reply> {
    const name = url.pathname.slice(url.pathname.indexOf('/api/') + 1), query = url.searchParams, session = query.get('session');
    switch (`${method} ${name}`) {
      case 'POST api/connect': return json({ accessToken: hex(32), ...(body?.session ? { state: shell(body.session).current } : {}) });
      case 'GET api/ping': return json({ ok: true });
      case 'POST api/sessions': { const id = crypto.randomUUID(); return json({ id, name: body?.name || 'monticello', state: shell(id).current }); }
      case 'GET api/sessions': return json({ sessions: [...shells.keys()].map(id => ({ id, name: 'monticello' })) });
      case 'POST api/sessions/close': shells.delete(session || 'default'); return json({ ok: true });
      case 'POST api/new': shells.set(session || 'default', new Shell()); return json({ ok: true });
      case 'POST api/ticket': case 'POST api/herdr/ticket': return json({ ticket: hex(32) });
      case 'GET api/keychain': return json({ keys: [], knownHosts: [] });
      case 'GET api/dictation': return json({ installed: true, available: true });
      case 'GET api/files/list': {
        const path = resolve(query.get('path'), session), node = stat(path);
        if (!node?.directory) return failure('That folder does not exist.', 404);
        return json({ path, parent: path.slice(0, path.lastIndexOf('/')) || '/', entries: list(path).map(child => entry(path + '/' + child)), truncated: false });
      }
      case 'POST api/files/mkdir': { const path = normalize(body.name, resolve(body.path, session)); mkdir(path); return json({ path }); }
      case 'POST api/files/action': {
        const paths: string[] = (body.paths || [body.path]).map((path: string) => resolve(path, session));
        if (body.action === 'read') { const value = await text(paths[0]); return json({ text: value, version: String(stat(paths[0])!.modified) }); }
        if (body.action === 'write') { write(paths[0], body.text); return json({ ok: true }); }
        if (body.action === 'rename') { rename(paths[0], normalize(body.name, paths[0].slice(0, paths[0].lastIndexOf('/')))); return json({ ok: true }); }
        if (body.action === 'delete') { for (const path of paths) remove(path); return json({ ok: true }); }
        if (body.action === 'copy' || body.action === 'move') {
          const destination = resolve(body.destination, session);
          for (const path of paths) {
            const target = destination + path.slice(path.lastIndexOf('/'));
            if (body.action === 'move') rename(path, target); else if (!stat(path)!.directory) write(target, await bytes(path)); else return failure('Copying folders is not available in the demo.');
          }
          return json({ ok: true });
        }
        return failure('That action is not available in the demo.');
      }
      case 'POST api/files/upload': case 'POST api/images/upload': case 'POST api/herdr/images/upload': {
        const data = body instanceof Uint8Array ? body : new Uint8Array();
        if (name !== 'api/files/upload') { const path = '/tmp/' + hex(4) + '-' + (query.get('name') || 'image.png'); write(path, data); return json({ path }); }
        const key = query.get('upload')!, parts = uploads.get(key) || []; parts.push(data); uploads.set(key, parts);
        const received = parts.reduce((sum, part) => sum + part.length, 0);
        if (received < Number(query.get('size'))) return json({ received });
        const whole = new Uint8Array(received); let offset = 0; for (const part of parts) { whole.set(part, offset); offset += part.length; }
        uploads.delete(key); write(normalize(query.get('name')!, resolve(query.get('path'), session)), whole);
        return json({ received, name: query.get('name') });
      }
      case 'POST api/files/download': { const path = resolve(body.path, session), ticket = hex(32); downloads.set(ticket, path); return json({ ticket, name: path.split('/').pop(), size: stat(path)?.size ?? 0 }); }
      case 'GET api/files/download': { const path = downloads.get(query.get('ticket') || ''); if (!path) return failure('This download link has expired.', 404); return { status: 200, type: 'application/octet-stream', body: await bytes(path) }; }
      case 'GET api/reading/file': {
        const path = resolve(query.get('path'), session), node = stat(path);
        if (!node || node.directory) return failure('That file does not exist.', 404);
        return { status: 200, type: typeOf(path), body: await bytes(path) };
      }
      case 'GET api/reading/capture': { const capture = captures.get(query.get('id') || ''); return capture ? { status: 200, type: 'text/plain; charset=utf-8', body: capture.data } : failure('That output has expired.', 404); }
      case 'DELETE api/reading/capture': captures.delete(query.get('id') || ''); return json({ ok: true });
      case 'GET api/herdr/snapshot': return json(herdr.snapshot());
      case 'GET api/herdr/options': return json({ actions: [] });
      case 'POST api/herdr/action':
        if (['rename', 'rename-space'].includes(body.action)) { herdr.rename(body.terminalId, body.action === 'rename-space' ? body.workspaceId : undefined, body.name); return json({ ok: true }); }
        if (body.action === 'move-space') return json({ ok: true });
        return failure('That Herdr action is not available in the demo.');
    }
    return failure('That feature is not available in the demo.', 404);
  }

  return {
    async request(method, address, body) {
      const url = new URL(address);
      let parsed: unknown = body;
      if (typeof body === 'string' && body) try { parsed = JSON.parse(body); } catch { return failure('Invalid request body.'); }
      try { return await route(method, url, parsed); } catch (error) { return failure((error as Error).message || 'Request failed.'); }
    },
    connect(address, peer) {
      const url = new URL(address), query = url.searchParams;
      let target: { message(message: any): void; close(): void };
      if (url.pathname.endsWith('/herdr/ws')) target = query.get('terminalId') ? herdr.pane(peer, query.get('terminalId')!) : herdr.view(peer);
      else {
        const current = shell(query.get('session'));
        current.attach(peer, Number(query.get('after')) || 0, query.get('stream'));
        target = { message: message => current.message(message), close: () => current.detach(peer) };
      }
      return {
        message(data) { try { target.message(JSON.parse(data)); } catch (error) { console.error(error); } },
        close() { target.close(); },
      };
    },
  };
}
