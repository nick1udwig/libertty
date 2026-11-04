/** Voxtype Mobile's OverlayPosition.place, in CSS pixels instead of Android dp. */
export function dictationLayout(x: number, y: number, width: number, height: number) {
  const left = 12,
    top = 12,
    right = width - 12,
    bottom = height - 12;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const bx = Math.round(clamp(x, left, Math.max(left, right - 48)));
  const by = Math.round(clamp(y, top, Math.max(top, bottom - 48)));
  let px: number,
    py = by,
    panelOnLeft = true;
  if (bx - left >= 152) px = bx - 152;
  else if (right - bx - 48 >= 152) {
    px = bx + 54;
    panelOnLeft = false;
  } else {
    px = clamp(bx - 49, left, Math.max(left, right - 146));
    py = clamp(by - top >= 54 ? by - 54 : by + 54, top, Math.max(top, bottom - 48));
  }
  return { bx, by, px, py, panelOnLeft };
}

/** Same decibel range and RMS measurement as Android AudioLevel.pcm16. */
export function dictationLevel(bytes: ArrayBuffer) {
  const pcm = new DataView(bytes),
    count = Math.floor(pcm.byteLength / 2);
  if (!count) return 0;
  let power = 0;
  for (let i = 0; i < count; i++) power += (pcm.getInt16(i * 2, true) / 32768) ** 2;
  return Math.max(0, Math.min(1, (10 * Math.log10(Math.max(1e-12, power / count)) + 60) / 48));
}
