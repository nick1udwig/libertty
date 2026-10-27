import { once } from 'node:events';
import net from 'node:net';

export function browserPortRange(worker) {
  const first = 10000 + worker * 128, last = first + 127;
  if (!Number.isSafeInteger(worker) || worker < 0 || last >= 32768) throw new Error('Too many browser workers for isolated fixture ports.');
  return first + '-' + last;
}

const issuedPorts = new Set();
export async function freePort(range = process.env.TEST_PORT_RANGE) {
  const bounds = range?.match(/^(\d+)-(\d+)$/)?.slice(1).map(Number);
  if (range && (!bounds || bounds[0] < 1024 || bounds[1] > 65535 || bounds[0] > bounds[1])) throw new Error('Invalid TEST_PORT_RANGE.');
  for (let candidate = bounds?.[0] ?? 0; !bounds || candidate <= bounds[1]; candidate += bounds ? 1 : 0) {
    if (issuedPorts.has(candidate)) continue;
    const listener = net.createServer();
    listener.listen(candidate, '127.0.0.1');
    try { await once(listener, 'listening'); }
    catch (error) { if (bounds && error.code === 'EADDRINUSE') continue; throw error; }
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    if (issuedPorts.has(port)) continue;
    issuedPorts.add(port);
    return port;
  }
  throw new Error('No free fixture ports in TEST_PORT_RANGE.');
}
