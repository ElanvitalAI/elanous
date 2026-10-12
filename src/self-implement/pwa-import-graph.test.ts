import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pwaReachableSrcFiles, reverseImportAffectedRoots } from './pwa-import-graph.js';

const reverseFixture = (files: Record<string, string>) => ({
  listFiles: () => Object.keys(files),
  readFile: (path: string) => files[path.slice('/fixture/'.length)] ?? (() => { throw new Error(`missing ${path}`); })(),
});

test('reverseImportAffectedRoots: changed files plus their direct importers only (one step)', () => {
  const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
    'src/a.ts': 'export const a = 1;',
    'src/b.ts': "import { a } from './a.js';\nexport const b = a;",
    'scripts/c.ts': "export { a } from '../src/a.js';",
    'src/r.ts': "const a = require('./a.js');",
    'src/d.ts': "import { b } from './b.js';\nexport const d = b;",
    'src/e.ts': "const lazy = () => import('./sub/index.js');",
    'src/sub/index.ts': "export { a } from '../a.js';",
    'src/z.ts': 'export const z = 1;',
  }));
  expect(result.failure).toBeUndefined();
  expect([...(result.roots ?? [])].sort()).toEqual(['scripts/c.ts', 'src/a.ts', 'src/b.ts', 'src/e.ts', 'src/r.ts', 'src/sub/index.ts']);
});

for (const [name, importer, roots] of [
  ['comment-bearing dynamic import', "import(/* comment */ './a.js')", ['src/a.ts', 'src/importer.ts']],
  ['literal template import', 'import(`./a.js`)', ['src/a.ts', 'src/importer.ts']],
  ['template-string dynamic import', 'import(`./${name}.js`)', ['src/a.ts']],
  ['variable require', 'require(pathVar)', ['src/a.ts']],
] as const) {
  test(`reverseImportAffectedRoots: ${name} follows TypeScript literal edges`, () => {
    const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
      'src/a.ts': 'export const a = 1;',
      'src/importer.ts': `${importer}\nexport {};`,
    }));
    expect(result.failure).toBeUndefined();
    expect([...(result.roots ?? [])].sort()).toEqual([...roots]);
  });
}

test('reverseImportAffectedRoots: outside gate sources and asset literals do not force full mode', () => {
  const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
    'src/a.ts': 'export const a = 1;',
    'src/other.ts': "import '../../apps/pwa/src/entry.js';\nimport './theme.css';",
  }));
  expect(result.failure).toBeUndefined();
  expect([...(result.roots ?? [])]).toEqual(['src/a.ts']);
});

test('reverseImportAffectedRoots: implicit TypeScript declarations are mandatory roots', () => {
  const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
    'src/a.ts': 'export const a = 1;',
    'src/globals.ts': 'export {}; declare global { var shared: number; }',
    'src/script.ts': 'var scriptGlobal = 1;',
    'src/augment.ts': "export {}; declare module './a.js' { interface Added { ok: true } }",
    'src/types.d.ts': 'declare const declaredValue: number;',
  }));
  expect(result.failure).toBeUndefined();
  expect([...(result.roots ?? [])].sort()).toEqual(['src/a.ts', 'src/augment.ts', 'src/globals.ts', 'src/script.ts', 'src/types.d.ts']);
});

for (const [name, importer, reason] of [
  ['AST parse error', "import { x from './a.js';", 'AST 파싱 실패'],
  ['unresolved relative literal', "import './missing.js';", '리터럴 import ./missing.js 해석 실패'],
] as const) {
  test(`reverseImportAffectedRoots: ${name} falls back`, () => {
    const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
      'src/a.ts': 'export const a = 1;',
      'src/importer.ts': importer,
    }));
    expect(result.roots).toBeUndefined();
    expect(result.failure).toContain(reason);
  });
}

test('reverseImportAffectedRoots: static re-export barrels reach importers through a cycle', () => {
  const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
    'src/a.ts': 'export interface Model { a: string }',
    'src/barrel.ts': "export * from './a.js';\nexport * from './barrel2.js';",
    'src/barrel2.ts': "export { Model } from './barrel.js';",
    'src/consumer.ts': "import type { Model } from './barrel2.js';\nconst m: Model = { a: '' };",
    'src/far.ts': "import './consumer.js';",
  }));
  expect(result.failure).toBeUndefined();
  expect([...(result.roots ?? [])].sort()).toEqual(['src/a.ts', 'src/barrel.ts', 'src/barrel2.ts', 'src/consumer.ts']);
});

test('reverseImportAffectedRoots: imported local re-export reaches barrel consumers', () => {
  const result = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), reverseFixture({
    'src/a.ts': 'export const x = 1;',
    'src/barrel.ts': "import { x as local } from './a.js';\nexport { local as x };",
    'src/consumer.ts': "import { x } from './barrel.js';\nconsole.log(x);",
    'src/far.ts': "import './consumer.js';",
  }));
  expect(result.failure).toBeUndefined();
  expect([...(result.roots ?? [])].sort()).toEqual(['src/a.ts', 'src/barrel.ts', 'src/consumer.ts']);
});

test('reverseImportAffectedRoots: an unreadable changed file or listed source is a failure, not a smaller set', () => {
  const files = { 'src/a.ts': 'export const a = 1;', 'src/b.ts': "import './a.js';" };
  const missingChanged = reverseImportAffectedRoots('/fixture', new Set(['src/gone.ts']), reverseFixture(files));
  expect(missingChanged.roots).toBeUndefined();
  expect(missingChanged.failure).toContain('src/gone.ts');
  const unreadableListed = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), {
    listFiles: () => Object.keys(files),
    readFile: (path) => { if (path.endsWith('src/b.ts')) throw new Error('EACCES'); return 'export {}'; },
  });
  expect(unreadableListed.failure).toContain('src/b.ts');
  const unlistable = reverseImportAffectedRoots('/fixture', new Set(['src/a.ts']), { listFiles: () => { throw new Error('boom'); }, readFile: () => '' });
  expect(unlistable.failure).toContain('boom');
});

test('PWA relative imports traverse src transitively without including unrelated files', () => {
  const cwd = '/fixture';
  const files: Record<string, string> = {
    'apps/pwa/src/a.tsx': "import type { X } from '../../../src/llm/x.js';\n",
    'src/llm/x.ts': "export { Y } from './y.js';\n",
    'src/llm/y.ts': "export { X } from './x.js';\n",
    'src/other/z.ts': 'export const z = true;',
  };
  const graph = pwaReachableSrcFiles(cwd, {
    listFiles: () => Object.keys(files),
    readFile: (path) => files[path.slice(cwd.length + 1)] ?? (() => { throw new Error(`missing ${path}`); })(),
  });
  expect(graph).toEqual(new Set(['src/llm/x.ts', 'src/llm/y.ts']));
  expect(graph.has('src/other/z.ts')).toBe(false);
});

test('actual JS source is reachable and its relative imports continue into TS', () => {
  const cwd = '/fixture';
  const files: Record<string, string> = {
    'apps/pwa/src/entry.tsx': "import '../../../src/bridge.js';",
    'src/bridge.js': "export { x } from './x.js';",
    'src/x.ts': 'export const x = 1;',
    'src/unrelated.js': 'export const unrelated = true;',
  };
  const graph = pwaReachableSrcFiles(cwd, {
    listFiles: () => Object.keys(files),
    readFile: (path) => files[path.slice(cwd.length + 1)]!,
  });
  expect(graph).toEqual(new Set(['src/bridge.js', 'src/x.ts']));
});

test('deleted imported src files remain reachable so a removal triggers validation', () => {
  const cwd = '/fixture';
  const files: Record<string, string> = {
    'apps/pwa/src/entry.tsx': "import '../../../src/llm/removed.js';",
    'src/other/z.ts': 'export const z = true;',
  };
  const graph = pwaReachableSrcFiles(cwd, {
    listFiles: () => Object.keys(files),
    readFile: (path) => files[path.slice(cwd.length + 1)]!,
  });
  expect(graph.has('src/llm/removed.ts')).toBe(true);
  expect(graph.has('src/other/z.ts')).toBe(false);
});

test('real PWA sources resolve root imports from this checkout', () => {
  const cwd = resolve(import.meta.dir, '../..');
  const files = pwaReachableSrcFiles(cwd);
  expect(files.has('src/tool-runtime/mcp-wire-name.ts')).toBe(true);
  // Measured 2026-09-28 with `tsc -p apps/pwa/tsconfig.json --explainFiles`: a PWA test file imports src/nexus/api/meta-api,
  // which pulls in most of src — driver.ts included. The old «false» here encoded the blind spot that let #21567 break the build.
  expect(files.has('src/agent-mission/driver.ts')).toBe(true);
  expect(files.has('src/budget/unified-usage.ts')).toBe(true);
});

test('dynamic imports and index resolution stay within repository src', () => {
  const cwd = '/fixture';
  const files: Record<string, string> = {
    'apps/pwa/src/entry.ts': "const m = import('../../../src/feature.js');\nimport '../../../outside.js';",
    'src/feature/index.ts': "import '../leaf.js';",
    'src/leaf.tsx': 'export const leaf = true;',
  };
  expect(pwaReachableSrcFiles(cwd, {
    listFiles: () => Object.keys(files),
    readFile: (path) => files[path.slice(cwd.length + 1)] ?? '',
  })).toEqual(new Set(['src/feature/index.ts', 'src/leaf.tsx']));
});

test('when a real .js and a same-named .ts coexist, the .js wins and its imports stay reachable', () => {
  const cwd = '/fixture';
  const files: Record<string, string> = {
    'apps/pwa/src/entry.tsx': "import '../../../src/dual.js';",
    'src/dual.js': "export { only } from './only-from-js.js';",
    'src/dual.ts': 'export const other = 1;',
    'src/only-from-js.ts': 'export const only = 1;',
  };
  const graph = pwaReachableSrcFiles(cwd, {
    listFiles: () => Object.keys(files),
    readFile: (path) => files[path.slice(cwd.length + 1)] ?? (() => { throw new Error(`missing ${path}`); })(),
  });
  expect(graph.has('src/dual.js')).toBe(true);
  expect(graph.has('src/only-from-js.ts')).toBe(true);
});

test('PWA test files are entries too — the PWA tsconfig includes them and the Next build type-checks them', () => {
  const cwd = '/fixture';
  const files: Record<string, string> = {
    'apps/pwa/src/lib/chain.test.ts': "import { x } from '../../../../src/nexus/api/meta-api';",
    'src/nexus/api/meta-api.ts': "export { y } from '../../budget/unified-usage.js';",
    'src/budget/unified-usage.ts': 'export const y = 1;',
  };
  const graph = pwaReachableSrcFiles(cwd, {
    listFiles: () => Object.keys(files),
    readFile: (path) => files[path.slice(cwd.length + 1)] ?? (() => { throw new Error(`missing ${path}`); })(),
  });
  expect(graph.has('src/budget/unified-usage.ts')).toBe(true);
});

