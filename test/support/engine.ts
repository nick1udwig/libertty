import { execFileSync } from 'node:child_process';
import type { Candidate, Catalog } from '../../src/protocol.ts';
import { rustExample } from './rust-example.ts';

/** Drive the production native engine instead of a duplicate JavaScript backend. */
export function nativeSuggest(input: string, catalog: Catalog, environment: Record<string,string>): Candidate[] {
  const binary = rustExample('engine_host');
  const wire = execFileSync(binary,{input:JSON.stringify({operation:'suggest',args:[input,catalog,environment]})+'\n',encoding:'utf8'});
  const reply = JSON.parse(wire);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
