import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

const forbidden = new Set(['./orchestrate.js', './run-supervisor.js', './supervisor-verdict-edges.js']);

function forbiddenImports(text: string): string[] {
  const imports = ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName);
  const typeQueries = [...text.matchAll(/\btypeof\s+import\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)].map((match) => match[2]!);
  return [...imports, ...typeQueries].filter((specifier) => forbidden.has(specifier));
}

test('run-store has no value, type, dynamic, or typeof imports of harness modules', () => {
  const text = readFileSync('src/self-dev/run-store.ts', 'utf8');
  const found = forbiddenImports(text);
  console.log(`run-store forbidden imports: ${found.length}`);
  expect(found).toEqual([]);
});

test('the rule catches a restored supervisor-verdict-edges type import', () => {
  const text = readFileSync('src/self-dev/run-store.ts', 'utf8');
  const found = forbiddenImports(`${text}\nimport type { SupervisorNext } from './supervisor-verdict-edges.js';\n`);
  console.log(`injected forbidden imports: ${found.length}`);
  expect(found).toEqual(['./supervisor-verdict-edges.js']);
});

test('the run-types leaf compiles with at most five repository src files', () => {
  const root = process.cwd();
  const config = resolve(root, `tsconfig.core-scc-split-1-${randomUUID()}.json`);
  writeFileSync(config, JSON.stringify({ extends: './tsconfig.json', files: ['./src/self-dev/run-types.ts'], include: [] }));
  try {
    const output = execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '--project', config, '--listFilesOnly'], { cwd: root, encoding: 'utf8' });
    const srcFiles = output.split(/\r?\n/).filter((file) => file.startsWith(resolve(root, 'src') + '/') && file.endsWith('.ts'));
    console.log(`run-types repository src files: ${srcFiles.length}`);
    expect(srcFiles).toContain(resolve(root, 'src/self-dev/run-types.ts'));
    expect(srcFiles.length).toBeLessThanOrEqual(5);
  } finally {
    unlinkSync(config);
  }
});
