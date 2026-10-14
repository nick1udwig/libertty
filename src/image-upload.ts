import { request, responseJSON } from './api.ts';
export const imageAccept = 'image/png,image/jpeg,image/webp,image/gif';
export const maxImageSize = 20 * 1024 * 1024;

export function imagePicker(selected: (files: File[]) => void) {
  const picker = document.createElement('input'); picker.type = 'file'; picker.accept = imageAccept; picker.multiple = true; picker.hidden = true;
  picker.setAttribute('aria-label', 'Choose images');
  picker.onchange = () => { const files = [...picker.files || []]; picker.value = ''; if (files.length) selected(files); };
  return picker;
}

export async function uploadImage(url: URL, token: string | undefined, file: File, signal: AbortSignal): Promise<string> {
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name)) throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  if (!file.size || file.size > maxImageSize) throw new Error('Choose an image between 1 byte and 20 MB.');
  url = new URL(url); url.searchParams.set('name', file.name);
  const result = await responseJSON<{ path: string }>(await request(url, { method: 'POST', signal, token, timeout: 0,
    headers: { 'Content-Type': 'application/octet-stream' }, body: file }));
  return result.path;
}
