import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const ledgerPath = resolve(root, 'src/self-implement/run-ledger.ts');
const forbidden = new Set(['../self-dev/launch-preflight.js', '../harness/harness-seams.js']);

function forbiddenImports(source: string): string[] {
  const preprocessed = ts.preProcessFile(source, true, true);
  const imported = preprocessed.importedFiles.map((file) => file.fileName);
  const typeImports = [...source.matchAll(/\btypeof\s+import\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)].map((match) => match[2]!);
  return [...imported, ...typeImports].filter((specifier) => forbidden.has(specifier));
}

function sourceReach(file: string): number {
  const child = spawnSync(resolve(root, 'node_modules/.bin/tsc'), [
    '--listFilesOnly', '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--target', 'es2022', '--types', 'node,bun', file,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (child.status !== 0) throw new Error(`tsc --listFilesOnly ${file}: ${(child.stderr || child.stdout).split(/\r?\n/, 1)[0]}`);
  const count = child.stdout.split(/\r?\n/).filter((path) => {
    if (!path) return false;
    const local = relative(root, path).split(sep).join('/');
    return local.startsWith('src/') && !local.startsWith('src/../');
  }).length;
  console.log(`CORE-SCC-SPLIT-2 ${file}: repository src files = ${count}`);
  return count;
}

test('run-ledger has no value/type imports of preflight or harness seams', () => {
  expect(forbiddenImports(readFileSync(ledgerPath, 'utf8'))).toEqual([]);
});

test('forbidden import injected into a source copy is detected', () => {
  const source = readFileSync(ledgerPath, 'utf8');
  expect(forbiddenImports(`${source}\nimport { extractHarnessReviewAcceptance } from '../harness/harness-seams.js';\n`)).toEqual(['../harness/harness-seams.js']);
});

test('leaf modules stay below the repository source reach ceilings', () => {
  expect(sourceReach('src/self-dev/launch-preflight-text.ts')).toBeLessThanOrEqual(30);
  expect(sourceReach('src/self-implement/goal-digest.ts')).toBeLessThanOrEqual(5);
});
