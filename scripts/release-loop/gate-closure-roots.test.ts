import { expect, test } from 'bun:test';
import { buildClosureGraph } from './gate-closure.js';

test('rooted closure scans imported modules but keeps the full tracked index for resolution', () => {
  const sources: Record<string, string> = {
    'src/root.ts': "import './leaf.ts';\n",
    'src/leaf.ts': "import './tip.ts';\n",
    'src/tip.ts': 'export const tip = true;\n',
    'src/unrelated.ts': "import './root.ts';\n",
  };
  const files = Object.keys(sources);
  const reads: string[] = [];
  const graph = buildClosureGraph({
    files,
    roots: ['src/root.ts'],
    preload: [],
    read: (path) => { reads.push(path); return sources[path]; },
  });

  expect(graph.tracked.has('src/unrelated.ts')).toBe(true);
  expect([...graph.staticImports.keys()].sort()).toEqual(['src/leaf.ts', 'src/root.ts', 'src/tip.ts']);
  expect(graph.staticImports.get('src/root.ts')).toEqual(['src/leaf.ts']);
  expect(graph.staticImports.get('src/leaf.ts')).toEqual(['src/tip.ts']);
  expect(reads.sort()).toEqual(['src/leaf.ts', 'src/root.ts', 'src/tip.ts']);
});

test('static-only closure follows intermediate imports and reports unreadable or unresolved modules', () => {
  const sources: Record<string, string> = {
    'src/root.ts': "import './middle.js';\n",
    'src/middle.ts': "export { root } from './root.js';\n",
    'src/unrelated.ts': 'export const unrelated = true;\n',
  };
  const scan = (read: (path: string) => string | undefined) => buildClosureGraph({
    files: Object.keys(sources), roots: ['src/root.ts'], preload: [], read,
  }, { staticImportsOnly: true });
  const cycle = scan((path) => sources[path]);
  expect(cycle.staticImports.get('src/root.ts')).toEqual(['src/middle.ts']);
  expect(cycle.staticImports.get('src/middle.ts')).toEqual(['src/root.ts']);
  expect([...cycle.staticImports.keys()].sort()).toEqual(['src/middle.ts', 'src/root.ts']);
  expect(cycle.opaque.size).toBe(0);

  const unreadable = scan((path) => path === 'src/middle.ts' ? undefined : sources[path]);
  expect(unreadable.opaque.get('src/middle.ts')).toBe('unreadable');
  const unresolved = scan((path) => path === 'src/middle.ts' ? "import './missing.js';" : sources[path]);
  expect(unresolved.opaque.get('src/middle.ts')).toBe('unresolved import ./missing.js');
});
