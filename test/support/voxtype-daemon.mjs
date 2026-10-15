import assert from 'node:assert/strict';
import { parseOpusFrame } from '../../src/voxtype-audio.ts';

/** In-memory protocol fixture with retained decoder checkpoints and final replay. */
export function resumableVoxtype(daemon, { token, transcript = () => 'Get in it.', available = () => true, finalDelay = () => 600, onAudio = () => {}, onRecording = () => {}, checkPacket = async () => {} } = {}) {
  const sessions = new Map();
  const stats = { resumptions: 0, currentId: '', audioBytes: 0, finishes: 0 };
  daemon.on('connection', (socket, request) => {
    if (token) assert.equal(request.headers.authorization, 'Bearer ' + token);
    assert.equal(request.headers.origin, undefined);
    if (request.url === '/v1/capabilities') {
      if (!available()) { socket.close(); return; }
      socket.send(JSON.stringify({ type: 'capabilities', protocol: 2, dictation: true, sample_rate: 16000, channels: 1, format: 'opus', framing: 'sequence_opus_v1', audio_encodings: ['opus_v1'], results: ['partial', 'final'], resume: true })); return;
    }
    assert.equal(request.headers['x-voxtype-protocol'], '2');
    assert.equal(request.headers['x-voxtype-audio'], 'opus_v1');
    const id = String(request.headers['x-voxtype-session']); assert.match(id, /^[a-f0-9]{32}$/);
    if (sessions.has(id)) stats.resumptions++;
    const session = sessions.get(id) || { sequence: 0, final: false, finished: false, packets: [] };
    sessions.set(id, session); session.socket = socket; stats.currentId = id; onRecording(socket);
    socket.send(JSON.stringify({ type: 'ready', protocol: 2, sample_rate: 16000, channels: 1, format: 'opus', audio_encoding: 'opus_v1', framing: 'sequence_opus_v1', max_seconds: 300, max_encoded_bytes: 2097152, resume: true, accepted_frames: session.sequence, finished: session.finished }));
    if (session.result !== undefined) socket.send(JSON.stringify({ type: 'final', text: session.result }));
    socket.on('message', async (bytes, binary) => {
      if (session.socket !== socket) return;
      if (binary) {
        const frame = parseOpusFrame(bytes);
        if (frame.sequence < session.sequence) return;
        assert.equal(frame.sequence, session.sequence++);
        assert.equal(session.finished, false);
        session.final = frame.final; session.packets.push(...frame.packets);
        stats.audioBytes += bytes.length; onAudio(bytes.length); return;
      }
      const { type } = JSON.parse(bytes.toString());
      if (type === 'ack' || type === 'cancel') { sessions.delete(id); return; }
      if (type !== 'finish' || session.finished) return;
      assert.equal(session.final, true); session.finished = true; stats.finishes++;
      for (const packet of session.packets) await checkPacket(packet);
      if (session.socket.readyState === 1) session.socket.send(JSON.stringify({ type: 'partial', text: 'never forward this preview' }));
      setTimeout(() => {
        session.result = transcript();
        if (session.socket.readyState === 1) session.socket.send(JSON.stringify({ type: 'final', text: session.result }));
      }, finalDelay());
    });
  });
  return stats;
}
