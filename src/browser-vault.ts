import { decryptBrowserKey, encryptBrowserKey, generateBrowserKey, parseKeyBackup, publicInfo, type EncryptedBrowserKey, type KeyBackup } from './browser-key.ts';
/** Canonical browser keys, stored only as encrypted records in IndexedDB. */
export class BrowserVault {
  private database?: Promise<IDBDatabase>;
  private open() {
    return this.database ||= new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      // Keep the durable database name so existing encrypted keys remain available.
      const request = indexedDB.open('termai-keychain', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'id' });
      request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => { request.result.close(); this.database = undefined; }; resolve(request.result); };
      request.onerror = () => { this.database = undefined; reject(new Error('Browser key storage is unavailable.')); };
      request.onblocked = () => { blocked = true; this.database = undefined; reject(new Error('Close other libertty windows and try again.')); };
    });
  }
  private async request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode), request = operation(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error('Could not save or read this browser key.'));
    });
  }
  async list() { return ((await this.request('readonly', store => store.getAll())) as EncryptedBrowserKey[]).map(publicInfo); }
  private async read(id: string) { const record = await this.request('readonly', store => store.get(id)) as EncryptedBrowserKey | undefined; if (!record) throw new Error('Key not found in this browser.'); return record; }
  private async save(record: EncryptedBrowserKey) {
    await this.request('readwrite', store => store.put(record));
    if (typeof navigator !== 'undefined') void navigator.storage?.persist?.().catch(() => false);
    return publicInfo(record);
  }
  async create(name: string, passphrase: string, imported?: { privateKey: string; publicKey: string; fingerprint: string }) { return this.save(await encryptBrowserKey(name, passphrase, imported || await generateBrowserKey())); }
  async restore(text: string, passphrase: string, name?: string) {
    const record = parseKeyBackup(text); await decryptBrowserKey(record, passphrase);
    if (name?.trim()) record.name = name.trim(); return this.save(record);
  }
  async unlock(id: string, passphrase: string) { return decryptBrowserKey(await this.read(id), passphrase); }
  async export(id: string) { return JSON.stringify(await this.read(id), null, 2) + '\n'; }
  async remove(id: string) { await this.request('readwrite', store => store.delete(id)); }
  private async update(id: string, edit: (record: EncryptedBrowserKey) => void) {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys'), request = store.get(id);
      request.onsuccess = () => { if (!request.result) { tx.abort(); return; } edit(request.result); store.put(request.result); };
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('Could not update this browser key.'));
    });
  }
  async rename(id: string, name: string) { if (!name.trim() || name.length > 100) throw new Error('Enter a key name.'); await this.update(id, record => record.name = name.trim()); }
  async rememberBackup(id: string, backup: KeyBackup) { await this.update(id, record => { record.backups = [...record.backups.filter(item => item.backendURL !== backup.backendURL), backup]; }); }
}
