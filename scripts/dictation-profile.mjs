import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const profile = JSON.parse(await readFile(new URL('contracts/dictation-audio.json', root), 'utf8'));
for (const value of Object.values(profile)) assert.ok(Number.isSafeInteger(value) && value > 0);
const rust = Object.entries(profile).map(([key, value]) => `pub const ${key.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase()}: u32 = ${value};`).join('\n') + '\n';
const ts = 'export const AUDIO_PROFILE = ' + JSON.stringify(profile, null, 2).replace(/"(\w+)":/g, '$1:').replace(/\n}/, ',\n}') + ' as const;\n';
async function embedded(name) {
  const source = await readFile(new URL(name, root), 'utf8');
  const region = /\/\/ Begin generated dictation profile\.[\s\S]*?\/\/ End generated dictation profile\./;
  assert.ok(region.test(source), name);
  return source.replace(region, '// Begin generated dictation profile.\nconst AUDIO_PROFILE = ' + JSON.stringify(profile) + ';\n// End generated dictation profile.');
}
for (const [name, content] of [['src/generated/dictation-profile.ts', ts], ['crates/server/src/dictation_profile.rs', rust], ['scripts/setup-integrations.mjs', await embedded('scripts/setup-integrations.mjs')], ['public/dictation-worklet.js', await embedded('public/dictation-worklet.js')]]) {
  const file = new URL(name, root);
  if (process.argv.includes('--check')) assert.equal(await readFile(file, 'utf8'), content, name);
  else await writeFile(file, content);
}
