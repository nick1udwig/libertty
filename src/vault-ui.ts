import { $, input, select, dialog } from './dom.ts';
import type { BackendProfile, KeyInfo } from './connections.ts';
import type { BrowserKeyInfo } from './browser-key.ts';
import type { BrowserVault } from './browser-vault.ts';
import type { Fail, Notify } from './notice-model.ts';
interface VaultServices {
  browserVault: BrowserVault; primary: BackendProfile;
  backends(): BackendProfile[]; backendFor(id: string): BackendProfile;
  authenticate(backend: BackendProfile): Promise<void>;
  api<T>(backend: BackendProfile, name: string, data?: unknown): Promise<T>;
  notice: Notify; fail: Fail; renderCards(): Promise<void>; clearRoutes(): void;
}
export function vaultUI(services: VaultServices) {
  const { browserVault, primary, backendFor, authenticate, api, notice, fail, renderCards } = services;
  let keyDetail: { backend?: BackendProfile; key: KeyInfo | BrowserKeyInfo } | undefined;
function keyDetails(backend: BackendProfile | undefined, key: KeyInfo | BrowserKeyInfo) {
  keyDetail = { backend, key }; input('key-rename').value = key.name; $('key-fingerprint').textContent = key.fingerprint; $<HTMLTextAreaElement>('public-key').value = key.publicKey;
  const backups = 'backups' in key ? key.backups : [];
  $('key-storage').textContent = backend ? key.reference ? backend.name + ' · ' + key.reference.type + ': ' + key.reference.path : 'Stored on ' + backend.name : 'Source of truth: this browser.' + (backups.length ? ' Last backed up to: ' + backups.map(b => b.backendName + ' (' + new Date(b.savedAt).toLocaleDateString() + ')').join(', ') + '.' : ' No device backups yet.');
  for (const id of ['export-key-backup', 'export-private-key', 'backup-key']) $(id).hidden = !!backend;
  $('restore-backend-key').hidden = !backend || !!key.reference;
  $('delete-key').textContent = key.reference ? 'Remove reference' : 'Delete key';
  if (!dialog('key-details').open) dialog('key-details').showModal();
}
function downloadKey(contents: string, name: string, extension: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' })), link = document.createElement('a');
  link.href = url; link.download = (name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'ssh-key') + extension; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('copy-key').onclick = () => void navigator.clipboard.writeText($<HTMLTextAreaElement>('public-key').value).then(() => notice('Public key copied.', 'done')).catch(() => notice('Select the public key to copy it.', 'warning'));
$('rename-key').onclick = () => {
  if (!keyDetail) return; const { backend, key } = keyDetail;
  void (backend ? api(backend, 'api/keychain', { action: 'rename', id: key.id, name: input('key-rename').value }) : browserVault.rename(key.id, input('key-rename').value)).then(() => { dialog('key-details').close(); void renderCards(); }).catch(fail);
};
$('delete-key').onclick = () => {
  if (!keyDetail) return; const { backend, key } = keyDetail;
  if (confirm(key.reference ? 'Remove this key reference? Its original file or agent identity will stay unchanged.' : 'Delete this private key from ' + (backend?.name || 'this browser') + '? Copies on other devices and existing SSH sessions will stay.')) void (backend ? api(backend, 'api/keychain', { action: 'delete', id: key.id }) : browserVault.remove(key.id)).then(() => { services.clearRoutes(); dialog('key-details').close(); void renderCards(); }).catch(fail);
};
$('export-key-backup').onclick = () => { if (keyDetail && !keyDetail.backend) { const key = keyDetail.key; void browserVault.export(key.id).then(text => downloadKey(text, key.name, '.libertty-key.json')).catch(fail); } };
let transferMode: 'backup' | 'private' | 'restore' = 'backup';
function openTransfer(mode: typeof transferMode) {
  if (!keyDetail) return; transferMode = mode;
  $('key-transfer-title').textContent = { backup: 'Back up to devices', private: 'Export SSH private key', restore: 'Restore to this browser' }[mode];
  $('key-transfer-hint').textContent = { backup: 'Choose the backends that should keep an encrypted backup. This browser stays the source of truth. Unselected backups are left as they are.', private: 'This exports the original SSH key file. Generated keys are unencrypted in this format. Use “Export encrypted backup” for a password-protected copy.', restore: 'Unlock the backend copy and save it encrypted in this browser. The backend copy will remain as a backup.' }[mode];
  $('backup-devices').replaceChildren();
  if (mode === 'backup') for (const backend of services.backends()) {
    const label = document.createElement('label'); label.className = 'toggle'; const check = document.createElement('input'); check.type = 'checkbox'; check.value = backend.id;
    const exists = 'backups' in keyDetail.key && keyDetail.key.backups.some(b => b.backendURL === backend.url);
    label.append(check, document.createTextNode(backend.name + ' · ' + backend.url + (exists ? ' (refresh backup)' : ''))); $('backup-devices').append(label);
  }
  $('key-transfer-submit').textContent = mode === 'backup' ? 'Back up selected devices' : mode === 'private' ? 'Download private key' : 'Restore key';
  $('key-transfer-error').textContent = ''; input('key-transfer-passphrase').value = ''; dialog('key-transfer').showModal();
}
$('backup-key').onclick = () => openTransfer('backup'); $('export-private-key').onclick = () => openTransfer('private'); $('restore-backend-key').onclick = () => openTransfer('restore');
$<HTMLFormElement>('key-transfer-form').onsubmit = async event => {
  event.preventDefault(); if (!keyDetail) return; const { backend, key } = keyDetail, mode = transferMode, passphrase = input('key-transfer-passphrase').value;
  const control = $<HTMLButtonElement>('key-transfer-submit'); control.disabled = true; $('key-transfer-error').textContent = '';
  try {
    if (mode === 'restore' && backend) {
      await authenticate(backend);
      const result = await api<KeyInfo & { privateKey: string }>(backend, 'api/keychain', { action: 'export', id: key.id, passphrase });
      const local = (await browserVault.list()).find(k => k.fingerprint === key.fingerprint) || await browserVault.create(key.name, passphrase, result);
      await browserVault.rememberBackup(local.id, { backendURL: backend.url, backendName: backend.name, keyId: key.id, savedAt: new Date().toISOString() });
      select('backend-filter').value = 'browser'; keyDetails(undefined, (await browserVault.list()).find(k => k.id === local.id)!);
    } else if (!backend) {
      const destinations = [...$('backup-devices').querySelectorAll<HTMLInputElement>('input:checked')].map(el => backendFor(el.value));
      if (mode === 'backup' && !destinations.length) throw new Error('Select a device to back up to.');
      const privateKey = await browserVault.unlock(key.id, passphrase);
      if (mode === 'private') downloadKey(privateKey, key.name, '.key');
      else {
        const failures: string[] = [];
        for (const device of destinations) {
          try {
            await authenticate(device);
            const local = (await browserVault.list()).find(k => k.id === key.id)!;
            const copy = await api<KeyInfo>(device, 'api/keychain', { action: 'backup', name: local.name, privateKey, passphrase, replaceId: local.backups.find(b => b.backendURL === device.url)?.keyId });
            await browserVault.rememberBackup(key.id, { backendURL: device.url, backendName: device.name, keyId: copy.id, savedAt: new Date().toISOString() });
          } catch (error: any) { failures.push(device.name + ': ' + error.message); }
        }
        keyDetails(undefined, (await browserVault.list()).find(k => k.id === key.id)!);
        if (failures.length) throw new Error('Successful backups were saved. Could not back up to: ' + failures.join('; '));
        notice('Backed up to ' + destinations.map(b => b.name).join(', ') + '.', 'done');
      }
    }
    dialog('key-transfer').close(); void renderCards();
  } catch (error: any) { $('key-transfer-error').textContent = error.message; }
  finally { input('key-transfer-passphrase').value = ''; control.disabled = false; }
};
select('key-method').onchange = () => { $('key-import-label').hidden = select('key-method').value !== 'import'; $<HTMLTextAreaElement>('key-import').required = select('key-method').value === 'import'; };
input('key-import-file').onchange = async () => {
  const file = input('key-import-file').files?.[0]; if (!file) return;
  $<HTMLTextAreaElement>('key-import').value = ''; $('key-error').textContent = '';
  if (file.size > 100000) { $('key-error').textContent = 'This key file is too large.'; input('key-import-file').value = ''; return; }
  try { const text = await file.text(); if (dialog('key-dialog').open && input('key-import-file').files?.[0] === file) $<HTMLTextAreaElement>('key-import').value = text; }
  catch { $('key-error').textContent = 'Could not read this key file.'; }
};
$<HTMLFormElement>('key-form').onsubmit = async event => {
  event.preventDefault(); const control = $('key-form').querySelector<HTMLButtonElement>('[type=submit]')!; control.disabled = true; $('key-error').textContent = '';
  try {
    const passphrase = input('key-passphrase').value, name = input('key-name').value;
    if (passphrase !== input('key-confirm').value) throw new Error('Passphrases do not match.');
    let key: BrowserKeyInfo;
    if (select('key-method').value === 'import') {
      const raw = $<HTMLTextAreaElement>('key-import').value.trim();
      if (raw.startsWith('{')) key = await browserVault.restore(raw, passphrase, name);
      else { await authenticate(primary); const info = await api<{ publicKey: string; fingerprint: string }>(primary, 'api/keychain', { action: 'inspect', privateKey: raw, passphrase }); key = await browserVault.create(name, passphrase, { privateKey: raw, ...info }); }
    } else key = await browserVault.create(name, passphrase);
    dialog('key-dialog').close(); select('backend-filter').value = 'browser'; void renderCards(); keyDetails(undefined, key);
  } catch (error: any) { $('key-error').textContent = error.message; }
  finally { input('key-passphrase').value = input('key-confirm').value = ''; $<HTMLTextAreaElement>('key-import').value = ''; input('key-import-file').value = ''; control.disabled = false; }
};
  return keyDetails;
}
