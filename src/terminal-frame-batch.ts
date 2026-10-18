import type { ServerMessage } from './protocol.ts';
export type HerdrFrameMessage = Omit<Extract<ServerMessage, { type: 'herdr-frame' }>, 'bytes'> & { bytes: string | Uint8Array };
const bytes = (value: string | Uint8Array) => typeof value === 'string' ? Uint8Array.from(atob(value), char => char.charCodeAt(0)) : value;
const size = (value: string | Uint8Array) => typeof value === 'string' ? Math.ceil(value.length * 3 / 4) : value.byteLength;

/** Preserve ordered ANSI deltas and let a complete baseline replace older queued state. */
export function mergeHerdrFrames(frames: HerdrFrameMessage[]): HerdrFrameMessage[] {
  const result: HerdrFrameMessage[] = [];
  for (const frame of frames) {
    const previous = result.at(-1);
    if (!previous || previous.width !== frame.width || previous.height !== frame.height) { result.push(frame); continue; }
    if (frame.full) { result[result.length - 1] = frame; continue; }
    if (size(previous.bytes) + size(frame.bytes) > 512 * 1024) { result.push(frame); continue; }
    const before = bytes(previous.bytes), after = bytes(frame.bytes), joined = new Uint8Array(before.length + after.length);
    joined.set(before); joined.set(after, before.length);
    result[result.length - 1] = { ...frame, full: previous.full, bytes: joined };
  }
  return result;
}
