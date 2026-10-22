import type { FileClient } from './file-browser.ts';
import type { TransferRequest } from './generated/protocol.ts';

/** A visible picker remains available when mobile browsers require a fresh tap. */
export function transferView(request: TransferRequest, client: FileClient, acknowledge: () => Promise<void>, download: () => Promise<void>) {
  if (request.action === 'download') { void download().finally(() => acknowledge().catch(() => {})).catch(() => {}); return { close() {} }; }
  const modal = document.createElement('dialog'); modal.className = 'transfer-dialog';
  const heading = document.createElement('h2'); heading.textContent = request.action === 'upload' ? 'Upload files' : 'Download file';
  const destination = document.createElement('p'); destination.textContent = request.action === 'upload' ? 'To ' + request.path : request.name;
  const status = document.createElement('p'); status.role = 'status';
  const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = request.action === 'upload' ? 'Choose files' : 'Download'; choose.className = 'primary';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cancel'; close.className = 'secondary';
  const actions = document.createElement('div'); actions.className = 'actions'; actions.append(close, choose);
  modal.append(heading, destination, status, picker, actions); document.body.append(modal); modal.showModal();
  const abort = new AbortController();
  const report = (e: unknown) => { status.textContent = e instanceof Error ? e.message : 'Transfer failed.'; choose.disabled = false; };
  close.onclick = () => modal.close();
  modal.onclose = () => { abort.abort(); modal.remove(); void acknowledge().catch(() => {}); };
  const save = async () => { choose.disabled = true; status.textContent = 'Starting download…'; try { await download(); modal.close(); } catch (e) { report(e); } };
  choose.onclick = () => request.action === 'upload' ? picker.click() : void save();
  picker.onchange = async () => {
    const files = [...picker.files || []]; picker.value = ''; if (!files.length) return;
    choose.disabled = true;
    try { for (const file of files) { status.textContent = 'Uploading ' + file.name + '…'; await client.upload(request.path, file, abort.signal); } status.textContent = `${files.length} file${files.length === 1 ? '' : 's'} uploaded.`; close.textContent = 'Done'; choose.disabled = false; }
    catch (e) { report(e); }
  };
  if (navigator.userActivation?.isActive) { try { picker.showPicker(); } catch { /* Choose files supplies the required user gesture. */ } }
  return { close: () => modal.close() };
}
