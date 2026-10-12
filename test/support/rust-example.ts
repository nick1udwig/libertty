import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Direct harness invocations can build their native driver on a fresh checkout. */
export function rustExample(name: 'engine_host' | 'herdr_snapshot'): string {
  const root = new URL('../../',import.meta.url).pathname;
  const binary = root+'target/debug/examples/'+name;
  if (!existsSync(binary)) execFileSync('cargo',['build','--locked','-p','termai-server','--example',name],{cwd:root,stdio:'inherit'});
  return binary;
}
