type Device = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>;
type Media = Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>;

export const bluetoothMicrophoneKey = 'libertty.bluetoothMicrophone';
const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true };
const bluetooth = /bluetooth|hands-?free|airpods|buds|bluez/i;
// Chrome on Android names inputs by route, and Chrome on macOS appends the transport or USB IDs.
const routes: [RegExp, number][] = [
  [/^(usb audio|wired headset)$|\busb\b|\bwired\b|\([0-9a-f]{4}:[0-9a-f]{4}\)/i, 0],
  [/^speakerphone$|built-?in|internal|microphone array|realtek/i, 1],
  [/^headset earpiece$/i, 2],
];
const aliases = new Set(['', 'default', 'communications']);

export function bluetoothMicrophoneAllowed() {
  try { return localStorage.getItem(bluetoothMicrophoneKey) === 'true'; } catch { return false; }
}

/** Ranks known non-Bluetooth inputs; unrecognized inputs may be Bluetooth and have no rank. */
export function microphoneRank(label: string) {
  if (bluetooth.test(label)) return;
  return routes.find(([route]) => route.test(label))?.[1];
}

/** Picks the system input when it is safe, then external wired inputs, then built-in inputs. */
export function preferredMicrophone(devices: Device[]) {
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const system = inputs.find(device => device.deviceId === 'default')?.label.replace(/^default - /i, '');
  const rank = (device: Device) => (device.label === system ? -1 : microphoneRank(device.label)!);
  return inputs.filter(device => !aliases.has(device.deviceId) && microphoneRank(device.label) !== undefined).sort((a, b) => rank(a) - rank(b))[0]?.deviceId;
}

/** Opens a non-Bluetooth input unless Bluetooth is allowed, so headphones stay out of call mode. */
export async function openMicrophone(media: Media, allowBluetooth: boolean) {
  if (allowBluetooth) return media.getUserMedia({ audio });
  let unlocked: MediaStream | undefined;
  const release = () => { unlocked?.getTracks().forEach(track => track.stop()); unlocked = undefined; };
  try {
    let devices = await media.enumerateDevices();
    // Browsers name inputs only after permission, so the first grant opens the default input to read them.
    if (!devices.some(device => device.kind === 'audioinput' && device.label)) {
      unlocked = await media.getUserMedia({ audio });
      devices = await media.enumerateDevices();
    }
    const deviceId = preferredMicrophone(devices);
    if (!deviceId) throw new Error('No phone, wired or USB microphone was found. Allow Bluetooth microphones in settings to dictate with another microphone.');
    if (unlocked?.getAudioTracks()[0]?.getSettings().deviceId === deviceId) { const stream = unlocked; unlocked = undefined; return stream; }
    release();
    return await media.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
  } finally { release(); }
}
