import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pin = JSON.parse(readFileSync(path.join(root, 'build/exact.json'), 'utf8'));
const source = path.join(root, 'target/exact-source');
const target = path.join(root, 'target/exact');
const output = path.join(root, 'target/exact-ui');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
mkdirSync(target, { recursive: true });
if (!existsSync(path.join(source, '.git'))) {
  run('git', ['init', source]);
  run('git', ['-C', source, 'fetch', '--depth=1', pin.repository, pin.commit]);
  run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
}
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== pin.commit) throw new Error(`Exact checkout is ${revision}; expected ${pin.commit}.`);
run('git', ['-C', source, 'diff', '--exit-code', 'HEAD', '--']);
const bun = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
if (bun !== pin.bun) throw new Error(`The Exact build requires Bun ${pin.bun}; found ${bun}.`);
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0', RUSTUP_TOOLCHAIN: pin.rust, EXACT_FEEDBACK: '0', BUN_TMPDIR: path.join(root, 'target'), BUN_INSTALL_CACHE_DIR: path.join(root, 'target/exact-bun-cache') };
run('cargo', ['build', '--locked', '-p', 'exact-web-js'], { cwd: source, env });
run('bun', ['install', '--frozen-lockfile'], { cwd: source, env });
run('bun', [path.join(source, 'host/web-js/build.mjs'), path.join(root, 'ui'), '--out', output, '--render', 'none', '--production'], { env: { ...env, EXACT_WEB_COMPILER: path.join(target, 'debug/exact-web-js') } });
const generated = path.join(output, '.gen');
const app = path.join(generated, 'app.js');
let code = readFileSync(app, 'utf8');
if (!code.includes('from"./rt.js"')) throw new Error('Review the Exact browser host adapter for this compiler.');
const html = new Map([...code.matchAll(/ds\((e\d+),[^;]*?"html","(form|label|p|span|strong)"/g)].map(match => [match[1], match[2]]));
for (const [element, tag] of html) {
  const declaration = new RegExp(`const ${element}=h\\(([^,]+),"[^"]+"`);
  if (!declaration.test(code)) throw new Error(`Cannot apply the browser tag for ${element}.`);
  code = code.replace(declaration, `const ${element}=h($1,"${tag}"`);
}
writeFileSync(app, code.replace('from"./rt.js"', 'from"./browser-host.js"'));
cpSync(path.join(root, 'ui/browser-host.js'), path.join(generated, 'browser-host.js'));
cpSync(path.join(root, 'ui/bridge.js'), path.join(generated, 'bridge.js'));
const css = path.join(generated, 'app.css');
writeFileSync(css, `@layer exact {${readFileSync(css, 'utf8')}}\n`);
