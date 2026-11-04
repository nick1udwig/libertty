/** Voxtype protocol 2: sequence + raw Opus packets, no file container. */
export const MAX_OPUS_BYTES = 2 * 1024 * 1024;
export const MAX_OPUS_FRAMES = 15002;
export const MAX_AUDIO_SAMPLES = 16000 * 300;
export function opusFrame(
  sequence: number,
  packets: Uint8Array[],
  preSkip: number,
  totalSamples?: number,
): ArrayBuffer {
  const first = sequence === 0,
    final = totalSamples !== undefined;
  const bytes = new Uint8Array(17 + packets.reduce((n, p) => n + 2 + p.length, 0));
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(sequence));
  bytes[8] = 1;
  bytes[9] = Number(first) | (Number(final) << 1);
  view.setUint16(10, first ? preSkip : 0);
  view.setUint32(12, totalSamples ?? 0);
  bytes[16] = packets.length;
  let offset = 17;
  for (const packet of packets) {
    view.setUint16(offset, packet.length);
    bytes.set(packet, offset + 2);
    offset += 2 + packet.length;
  }
  parseOpusFrame(bytes);
  return bytes.buffer;
}
export function parseOpusFrame(bytes: Uint8Array) {
  if (bytes.length < 17 || bytes.length > 6402) throw new Error('Invalid Opus frame size.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sequence = view.getBigUint64(0),
    flags = bytes[9],
    preSkip = view.getUint16(10),
    totalSamples = view.getUint32(12),
    count = bytes[16];
  const first = !!(flags & 1),
    final = !!(flags & 2);
  if (
    sequence >= BigInt(MAX_OPUS_FRAMES) ||
    bytes[8] !== 1 ||
    flags > 3 ||
    first !== (sequence === 0n) ||
    preSkip > 3840 ||
    preSkip % 3 ||
    (!first && preSkip) ||
    (!final && totalSamples) ||
    totalSamples > MAX_AUDIO_SAMPLES ||
    count > 5 ||
    (!count && !final)
  )
    throw new Error('Invalid Opus frame header.');
  const packets: Uint8Array[] = [];
  let offset = 17;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > bytes.length) throw new Error('Truncated Opus packet.');
    const length = view.getUint16(offset);
    offset += 2;
    if (length < 1 || length > 1275 || offset + length > bytes.length)
      throw new Error('Invalid Opus packet size.');
    packets.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('Trailing Opus frame bytes.');
  return { sequence: Number(sequence), first, final, preSkip, totalSamples, packets };
}
