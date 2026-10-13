import { readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript-reference';

const root = new URL('../',import.meta.url);
async function files(directory, suffix) {
  const result=[];
  for (const entry of await readdir(new URL(directory,root),{withFileTypes:true})) {
    const file=directory+entry.name;
    if (entry.isDirectory()) result.push(...await files(file+'/',suffix));
    else if (suffix.test(file)) result.push(file);
  }
  return result.sort();
}
const modules=(await files('crates/',/\/src\/.*\.rs$/)).map(source=>({source}));
const tests=[];
for (const source of await files('crates/',/\/(?:src|tests)\/.*\.rs$/)) {
  const text=await readFile(new URL(source,root),'utf8');
  const assertions=[...text.matchAll(/#\[(?:tokio::)?test\][\s\S]*?\bfn\s+(\w+)\s*\(/g)].map(match=>match[1]);
  if (assertions.length) tests.push({source,owner:'rust',assertions});
}
for (const source of await files('test/',/\.(?:test\.ts|mjs)$/)) {
  const text=await readFile(new URL(source,root),'utf8'),tree=ts.createSourceFile(source,text,ts.ScriptTarget.Latest,true),assertions=[];
  function walk(node) {
    if (ts.isCallExpression(node)&&node.expression.getText(tree)==='test'&&ts.isStringLiteral(node.arguments[0])) assertions.push(node.arguments[0].text);
    ts.forEachChild(node,walk);
  } walk(tree);
  tests.push({source,owner:source.endsWith('.test.ts')?'frontend':'integration',assertions});
}
const output=new URL('contracts/regression-inventory.json',root);
const content=JSON.stringify({version:5,modules,tests},null,2)+'\n';
if (process.argv.includes('--check')) { if (await readFile(output,'utf8')!==content) throw new Error('Regression inventory is stale.'); }
else await writeFile(output,content);
console.log(`Inventoried ${modules.length} Rust modules and ${tests.length} active harnesses.`);
