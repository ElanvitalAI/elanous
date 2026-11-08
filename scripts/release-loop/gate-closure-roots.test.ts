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
