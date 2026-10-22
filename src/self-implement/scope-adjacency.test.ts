import { expect, test } from 'bun:test';
import { classifyOutOfScope, classifyScopeExpansion, decideScopeExpansion, isProtectedScopePath, renderScopeExpansionSection, SCOPE_EXPANSION_CAP } from './scope-adjacency.js';

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

// SCOPE-AS-DIRECTION (0.2.35) — target paths are a starting point; outside edits are accepted and named for the reviewer.
test('SCOPE-AS-DIRECTION: outside files are classified neighbour · caller-or-registration · paired-test · other', () => {
  const files: Record<string, string> = {
    'src/a/x.ts': 'export function computeWidget() { return 1; }\n',
    'src/b/uses-import.ts': "import { y } from '../a/x.js';\n",
    'src/c/uses-name.ts': 'const v = computeWidget();\n',
    'src/z/unrelated.ts': 'export const nothing = 0;\n',
  };
  expect(classifyScopeExpansion([
    'src/a/helper.ts', 'src/index.ts', 'src/d/feature-cli.ts', 'src/b/uses-import.ts', 'src/c/uses-name.ts',
    'test/a/x.test.ts', 'src/z/unrelated.ts',
  ], ['src/a/x.ts'], path => files[path])).toEqual([
    { path: 'src/a/helper.ts', kind: 'neighbour' },
    { path: 'src/index.ts', kind: 'caller-or-registration' },
    { path: 'src/d/feature-cli.ts', kind: 'caller-or-registration' },
    { path: 'src/b/uses-import.ts', kind: 'caller-or-registration' },
    { path: 'src/c/uses-name.ts', kind: 'caller-or-registration' },
    { path: 'test/a/x.test.ts', kind: 'paired-test' },
    { path: 'src/z/unrelated.ts', kind: 'other' },
  ]);
  // A test paired with another accepted outside file (not a declared one) is paired-test too.
  expect(classifyScopeExpansion(['lib/w.ts', 'lib/w.test.ts'], ['src/a/x.ts'])).toEqual([
    { path: 'lib/w.ts', kind: 'other' }, { path: 'lib/w.test.ts', kind: 'paired-test' },
  ]);
});

test('SCOPE-AS-DIRECTION: protected paths', () => {
  for (const p of ['.rules/00-core/x.md', 'config/credentials.ts', 'src/secret-store.ts', 'auth.json', '.env', 'apps/.env.local', '.elanous/config.json', 'home/.elanous-test/config.json'])
    expect([p, isProtectedScopePath(p)]).toEqual([p, true]);
  for (const p of ['src/a.ts', 'package.json', 'src/config.json', 'docs/environment.md', 'src/authoring.ts'])
    expect([p, isProtectedScopePath(p)]).toEqual([p, false]);
});

test('SCOPE-AS-DIRECTION: an unrelated-file edit is accepted with scopeExpansion; deletion · protected · over-cap stop', () => {
  const ok = decideScopeExpansion({ outsideFiles: ['lib/outside.ts'], declaredPaths: ['src/inside.ts'], deleted: [], nameCapReached: false });
  expect(ok).toEqual({ accept: true, expansion: { files: [{ path: 'lib/outside.ts', kind: 'other' }], count: 1 } });
  const del = decideScopeExpansion({ outsideFiles: ['README.md'], declaredPaths: ['src/inside.ts'], deleted: ['README.md'], nameCapReached: false });
  expect(del).toMatchObject({ accept: false, reasons: ['deletion'], deleted: ['README.md'] });
  const prot = decideScopeExpansion({ outsideFiles: ['.rules/x.md', 'lib/o.ts'], declaredPaths: ['src/inside.ts'], deleted: [], nameCapReached: false });
  expect(prot).toMatchObject({ accept: false, reasons: ['protected-path'], protectedPaths: ['.rules/x.md'] });
  const many = Array.from({ length: SCOPE_EXPANSION_CAP + 1 }, (_, i) => `lib/o${i}.ts`);
  expect(decideScopeExpansion({ outsideFiles: many, declaredPaths: ['src/inside.ts'], deleted: [], nameCapReached: false }))
    .toMatchObject({ accept: false, reasons: ['over-cap'] });
  expect(decideScopeExpansion({ outsideFiles: many.slice(0, SCOPE_EXPANSION_CAP), declaredPaths: ['src/inside.ts'], deleted: [], nameCapReached: false }))
    .toMatchObject({ accept: true });
  expect(decideScopeExpansion({ outsideFiles: ['lib/o.ts'], declaredPaths: ['src/inside.ts'], deleted: [], nameCapReached: true }))
    .toMatchObject({ accept: false, reasons: ['name-cap'] });
});

test('SCOPE-AS-DIRECTION: the PR section lists each accepted file with its kind, and is empty without expansion', () => {
  expect(renderScopeExpansionSection(undefined)).toBe('');
  expect(renderScopeExpansionSection({ files: [], count: 0 })).toBe('');
  const section = renderScopeExpansionSection({ files: [{ path: 'src/index.ts', kind: 'caller-or-registration' }], count: 1 });
  expect(section).toContain('## 범위 확장 (1)');
  expect(section).toContain('- `src/index.ts` — caller-or-registration');
});
