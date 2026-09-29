import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pwaReachableSrcFiles } from './pwa-import-graph.js';

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

