import { expect, test } from 'bun:test';
import { classifyOutOfScope } from './scope-adjacency.js';

test('SCOPE-HELD-DELIVER: sibling test of a declared file is adjacent', () => {
  expect(classifyOutOfScope(['src/a/x.spec.ts', 'src/a/x.test.tsx'], ['src/a/x.ts'])).toEqual({ adjacent: ['src/a/x.spec.ts', 'src/a/x.test.tsx'], other: [] });
});

test('SCOPE-HELD-DELIVER: same-folder sibling is adjacent', () => {
  expect(classifyOutOfScope(['src/bench/wish-benchmark-ledger.ts', 'src/bench/plugin.json'], ['src/bench/report.ts', 'src/bench/report.test.ts']))
    .toEqual({ adjacent: ['src/bench/wish-benchmark-ledger.ts', 'src/bench/plugin.json'], other: [] });
});

test('SCOPE-HELD-DELIVER: file in another folder is other', () => {
  expect(classifyOutOfScope(['src/b/y.ts', 'src/a/deep/z.ts', 'test/a/x.test.ts'], ['src/a/x.ts']))
    .toEqual({ adjacent: [], other: ['src/b/y.ts', 'src/a/deep/z.ts', 'test/a/x.test.ts'] });
});

test('SCOPE-HELD-DELIVER: a declared folder or repo-root file confers no adjacency; paths are normalized', () => {
  expect(classifyOutOfScope(['src/a/x.ts', 'bun.lock', 'README.md'], ['src/a/', 'package.json'])).toEqual({ adjacent: [], other: ['src/a/x.ts', 'bun.lock', 'README.md'] });
  expect(classifyOutOfScope(['./src/a/y.ts'], ['src\\a\\x.ts'])).toEqual({ adjacent: ['./src/a/y.ts'], other: [] });
  expect(classifyOutOfScope([], ['src/a/x.ts'])).toEqual({ adjacent: [], other: [] });
});
