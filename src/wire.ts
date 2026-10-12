/** A negotiated envelope keeps binary terminal traffic out of JSON/base64. */
export const BINARY_PROTOCOL = 'termai.binary.v1';
export const GZIP_PROTOCOL = 'termai.gzip.v1';
export const GZIP_FAST_PROTOCOL = 'termai.gzip-fast.v1';
const maximum = 64 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export interface Link { effectiveType?: string; downlink?: number; rtt?: number }
export function constrainedLink(link: Link | undefined = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: Link }).connection): boolean {
  return !!link && (['slow-2g', '2g', '3g'].includes(link.effectiveType || '') || (typeof link.downlink === 'number' && link.downlink <= 2));
}
export function wireProtocols(offered: string[] | undefined): string[] {
  if (!offered?.includes(BINARY_PROTOCOL)) return [];
  if (typeof DecompressionStream !== 'function') return [BINARY_PROTOCOL];
  if (constrainedLink() && offered.includes(GZIP_PROTOCOL)) return [GZIP_PROTOCOL, BINARY_PROTOCOL];
  return offered.includes(GZIP_FAST_PROTOCOL) ? [GZIP_FAST_PROTOCOL, BINARY_PROTOCOL] : [BINARY_PROTOCOL];
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes).buffer;
  const reader = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > maximum) throw new Error('Wire message exceeds its limit.'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
export async function decodeWire(data: string | ArrayBuffer | Blob): Promise<any> {
  if (typeof data === 'string') return JSON.parse(data);
  const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
  if (bytes.length < 4 || bytes[0] !== 84 || bytes[1] !== 77 || bytes[2] !== 1 || bytes.length > maximum) throw new Error('Invalid wire header.');
  const kind = bytes[3] & 127;
  const payload = bytes[3] & 128 ? await inflate(bytes.subarray(4)) : bytes.subarray(4);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (kind === 0) return JSON.parse(decoder.decode(payload));
  if (kind === 1 && payload.length >= 8) { const seq = view.getFloat64(0, true); if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid output sequence.'); return { type: 'output', seq, data: decoder.decode(payload.subarray(8)) }; }
  if (kind === 2 && payload.length >= 5 && payload[4] <= 1) return { type: 'herdr-frame', width: view.getUint16(0, true), height: view.getUint16(2, true), full: payload[4] === 1, bytes: payload.subarray(5) };
  throw new Error('Unsupported outgoing wire message.');
}
export function encodeWire(message: { type: string; [key: string]: unknown }, protocol: string): string | ArrayBuffer {
  if (![BINARY_PROTOCOL, GZIP_PROTOCOL, GZIP_FAST_PROTOCOL].includes(protocol)) return JSON.stringify(message);
  let kind = 0, payload: Uint8Array;
  if (message.type === 'input' && typeof message.data === 'string') { kind = 3; payload = encoder.encode(message.data); }
  else if (message.type === 'ack' && Number.isSafeInteger(message.seq) && (message.seq as number) >= 0) { kind = 4; payload = new Uint8Array(8); new DataView(payload.buffer).setFloat64(0, message.seq as number, true); }
  else if (message.type === 'resize' && [message.cols, message.rows].every(value => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535) && (message.mobile === undefined || typeof message.mobile === 'boolean')) { kind = 5; payload = new Uint8Array(5); const view = new DataView(payload.buffer); view.setUint16(0, message.cols as number, true); view.setUint16(2, message.rows as number, true); payload[4] = message.mobile === undefined ? 2 : Number(message.mobile); }
  else return JSON.stringify(message);
  const result = new Uint8Array(4 + payload.length); result.set([84, 77, 1, kind]); result.set(payload, 4); return result.buffer;
}
export function encodeAudio(data: ArrayBuffer, protocol: string): Uint8Array<ArrayBuffer> | ArrayBuffer;
export function encodeAudio<B extends ArrayBufferLike>(data: Uint8Array<B>, protocol: string): Uint8Array<B> | Uint8Array<ArrayBuffer>;
export function encodeAudio(data: Uint8Array | ArrayBuffer, protocol: string): Uint8Array | ArrayBuffer {
  if (![BINARY_PROTOCOL, GZIP_PROTOCOL, GZIP_FAST_PROTOCOL].includes(protocol)) return data;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = new Uint8Array(bytes.length + 4); result.set([84, 77, 1, 6]); result.set(bytes, 4); return result;
}
