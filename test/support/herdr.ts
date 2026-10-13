import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { HerdrSnapshot } from '../../src/herdr-protocol.ts';
import { rustExample } from './rust-example.ts';

interface Target { session: string; socketPath: string }

/** Raw RPC driver for disposable external Herdr servers, without a Termai backend. */
export function herdrRequest(target: Target, method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(target.socketPath), id = randomUUID();
    let pending = '', settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Herdr fixture request timed out: ' + method)), 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('Herdr fixture disconnected: ' + method)));
    socket.on('data', bytes => {
      pending += bytes;
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) { finish(new Error('Herdr fixture response exceeded its limit')); return; }
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const reply = JSON.parse(line);
          if (reply.id !== id) continue;
          if (reply.error) finish(new Error(reply.error.message)); else finish(undefined, reply.result);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  });
}

export async function herdrSnapshot(target: Target): Promise<HerdrSnapshot> {
  const raw = await herdrRequest(target, 'session.snapshot');
  const binary = rustExample('herdr_snapshot');
  return JSON.parse(execFileSync(binary, { input: JSON.stringify(raw), encoding: 'utf8' }));
}
