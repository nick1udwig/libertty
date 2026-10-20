/** Chrome's fake inputs have no route names, so name them as Chrome on Android does beside a Bluetooth headset. */
export function installMicrophoneRoutes(context) {
  return context.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    const enumerate = media.enumerateDevices.bind(media);
    media.enumerateDevices = async () => {
      const devices = await enumerate();
      if (!devices.some(device => device.kind === 'audioinput' && device.label)) return devices;
      const routed = devices.map(device => device.kind !== 'audioinput' || device.deviceId === 'default' ? device : { kind: device.kind, deviceId: device.deviceId, groupId: device.groupId, label: 'Speakerphone' });
      return [{ kind: 'audioinput', deviceId: 'bluetooth-headset', groupId: '', label: 'Bluetooth headset' }, ...routed];
    };
  });
}
