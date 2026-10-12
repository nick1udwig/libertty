// Capture pure boundaries while executing the existing assertions unchanged.
import { registerHooks } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript-reference';

const operations = new Set([
  'repair', 'similarity', 'matches', 'tokens', 'shellQuote', 'commandNames',
  'discoveryTarget', 'discoveryTargets', 'expandSymbols', 'symbolAlternatives',
  'simpleWords', 'historyCandidates', 'directoryInput', 'pipelineParts',
  'flagsFromHelp', 'commandsFromHelp', 'commandsFromManual', 'requiredFromHelp',
  'hasCommandSlot', 'optionArity',
]);
const fixtures = new Map();
globalThis.__termaiMigrationRecord = (operation, args, result) => {
  // Undefined positions are represented by null in the JSON calling convention.
  const row = JSON.parse(JSON.stringify({ operation, args, result: result ?? null }));
  if (operation === 'directoryInput' && row.result?.absolute) {
    row.result.parts = ('/' + row.result.parts.join('/')).replaceAll(/\/tmp\/termai-[A-Za-z0-9_-]+/g, '/fixture').split('/').filter(Boolean);
  }
  const wire = JSON.stringify(row).replaceAll(/\/tmp\/termai-[A-Za-z0-9_-]+/g, '/fixture');
  if (wire.length <= 65536) fixtures.set(wire, JSON.parse(wire));
};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes('/src/engine/') || !url.endsWith('.ts')) return loaded;
    const source = String(loaded.source);
    const tree = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [], wrappers = [];
    for (const node of tree.statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !operations.has(node.name.text) ||
          !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const name = node.name.text;
      edits.push([node.name.getStart(tree), node.name.end, '__reference_' + name]);
      const exportModifier = node.modifiers.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      edits.push([exportModifier.getStart(tree), exportModifier.end, '']);
      wrappers.push(`export function ${name}(...args: any[]): any { const result = (__reference_${name} as any)(...args); globalThis.__termaiMigrationRecord('${name}', args, result); return result; }`);
    }
    let transformed = source;
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
    return { ...loaded, source: transformed + '\n' + wrappers.join('\n') };
  },
});
process.on('exit', () => {
  if (!process.env.TERMAI_ORACLE_DIR) return;
  mkdirSync(process.env.TERMAI_ORACLE_DIR, { recursive: true });
  writeFileSync(path.join(process.env.TERMAI_ORACLE_DIR, process.pid + '.json'), JSON.stringify([...fixtures.values()]));
});
