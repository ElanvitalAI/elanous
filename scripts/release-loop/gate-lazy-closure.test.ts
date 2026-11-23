import { expect, test } from 'bun:test';
import { closureTreeFromSnapshot } from './gate-closure.js';
import { gateFileReceiptIdentityFromClosure } from './gate-file-receipts.js';
import type { CutSnapshot } from './gate-cut-snapshot.js';

test('only config is decoded up front; tracked source is decoded on demand', () => {
  const files = ['bunfig.toml', 'tsconfig.json', 'src/one.test.ts', 'src/unused.ts', 'data/large.json'];
  const data = new Map([
    ['bunfig.toml', '[test]\npreload = ["./src/setup.ts"]\n'],
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@app/*":["src/*"]}}}'],
    ['src/one.test.ts', 'export const one = 1;'],
    ['src/unused.ts', 'export const unused = 2;'],
    ['data/large.json', '{"payload":"large"}'],
  ]);
  const reads: string[] = [];
  const snapshot: CutSnapshot = { commit: 'a'.repeat(40), entries: new Map(), files,
    read: path => { reads.push(path); return data.get(path); }, existsBlob: path => data.has(path) };
  const tree = closureTreeFromSnapshot(snapshot);
  expect(reads).toEqual(['bunfig.toml', 'tsconfig.json']);
  expect(tree.preload).toEqual(['src/setup.ts']);
  expect(tree.aliases).toEqual([{ scope: '', prefix: '@app/', target: 'src' }]);
  expect(tree.read('data/large.json')).toBeUndefined();
  expect(tree.read('untracked.ts')).toBeUndefined();
  expect(reads).toEqual(['bunfig.toml', 'tsconfig.json']);
  expect(tree.read('src/one.test.ts')).toBe('export const one = 1;');
  expect(reads).toEqual(['bunfig.toml', 'tsconfig.json', 'src/one.test.ts']);
});

test('lazy and eager trees produce the same receipt identity for a tracked import', () => {
  const files = ['src/one.test.ts', 'src/helper.ts'];
  const data = new Map([['src/one.test.ts', "import { n } from './helper'; export const result = n;"],
    ['src/helper.ts', 'export const n = 7;']]);
  const snapshot: CutSnapshot = { commit: 'a'.repeat(40), entries: new Map(), files,
    read: path => data.get(path), existsBlob: path => data.has(path) };
  const eager = { files, read: (path: string) => data.get(path), preload: [] };
  const lazy = closureTreeFromSnapshot(snapshot);
  const digest = `sha256:${'b'.repeat(64)}`;
  expect(gateFileReceiptIdentityFromClosure(lazy, files[0]!, digest))
    .toEqual(gateFileReceiptIdentityFromClosure(eager, files[0]!, digest));
});
