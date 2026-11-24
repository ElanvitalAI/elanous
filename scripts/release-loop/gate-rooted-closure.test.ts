import { expect, test } from 'bun:test';
import { buildClosureGraph, createRootedClosureGraph, type ClosureGraph, type ClosureTree } from './gate-closure.js';
import { gateFileReceiptIdentityFromClosure } from './gate-file-receipts.js';

const source = new Map([
  ['src/a.test.ts', "import { a } from './shared'; export const result = a;"],
  ['src/b.test.ts', "import { a } from './shared'; import { b } from './other'; export const result = a + b;"],
  ['src/opaque.test.ts', "const fs = require('node:fs'); export const read = fs.readFileSync;"],
  ['src/shared.ts', "import { n } from './deep'; export const a = n;"],
  ['src/deep.ts', 'export const n = 1;'],
  ['src/other.ts', 'export const b = 2;'],
  ['src/unrelated.ts', 'export const unrelated = 3;'],
]);
const files = [...source.keys()];
function reachable(graph: ClosureGraph, root: string): string[] {
  const seen = new Set<string>(), pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path); pending.push(...(graph.forward.get(path) ?? []));
  }
  return [...seen].sort();
}

test('rooted incremental graphs preserve full-graph edges and opaque results without scanning unrelated files', () => {
  const full: ClosureTree = { files, preload: [], read: path => source.get(path) };
  const oracle = buildClosureGraph(full);
  const reads: string[] = [];
  const rooted: ClosureTree = { files, preload: [], read: path => { reads.push(path); return source.get(path); } };
  const extend = createRootedClosureGraph(rooted);
  for (const root of ['src/a.test.ts', 'src/b.test.ts', 'src/opaque.test.ts']) {
    const graph = extend(root);
    expect(reachable(graph, root)).toEqual(reachable(oracle, root));
    for (const file of reachable(oracle, root)) {
      expect(graph.forward.get(file)).toEqual(oracle.forward.get(file));
      expect(graph.opaque.get(file)).toEqual(oracle.opaque.get(file));
    }
  }
  expect(reads).not.toContain('src/unrelated.ts');
  expect(reads.filter(file => file === 'src/shared.ts')).toHaveLength(1);
  const count = reads.length;
  extend('src/a.test.ts');
  expect(reads).toHaveLength(count);
});

test('a failed extension does not cache partial graph or change a prior receipt', () => {
  let fail = true;
  const tree: ClosureTree = { files, preload: [], read: path => {
    if (path === 'src/other.ts' && fail) throw new Error('fixture read failed');
    return source.get(path);
  } };
  const image = `sha256:${'a'.repeat(64)}`;
  const first = gateFileReceiptIdentityFromClosure(tree, 'src/a.test.ts', image);
  expect(first).not.toBeNull();
  expect(() => gateFileReceiptIdentityFromClosure(tree, 'src/b.test.ts', image)).toThrow('fixture read failed');
  expect(gateFileReceiptIdentityFromClosure(tree, 'src/a.test.ts', image)).toEqual(first);
  fail = false;
  expect(gateFileReceiptIdentityFromClosure(tree, 'src/b.test.ts', image)).not.toBeNull();
});

test('receipt identities reuse hashes for shared immutable inputs and isolate different trees', () => {
  const reads: string[] = [];
  const tree: ClosureTree = { files, preload: [], read: path => { reads.push(path); return source.get(path); } };
  const image = `sha256:${'a'.repeat(64)}`;
  const first = gateFileReceiptIdentityFromClosure(tree, 'src/a.test.ts', image)!;
  const count = reads.filter(path => path === 'src/shared.ts').length;
  const second = gateFileReceiptIdentityFromClosure(tree, 'src/b.test.ts', image)!;
  expect(reads.filter(path => path === 'src/shared.ts')).toHaveLength(count);
  expect(second.contentHashes['src/shared.ts']).toBe(first.contentHashes['src/shared.ts']);
  const changed = new Map(source);
  changed.set('src/shared.ts', 'export const a = 123;');
  const other: ClosureTree = { files, preload: [], read: path => changed.get(path) };
  expect(gateFileReceiptIdentityFromClosure(other, 'src/a.test.ts', image)!.contentHashes['src/shared.ts'])
    .not.toBe(first.contentHashes['src/shared.ts']);
});
