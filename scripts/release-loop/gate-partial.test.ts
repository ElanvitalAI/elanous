import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedFilesBetween, mergePartialFailures, partialPlanPath, planPartialRegate, readPartialPlan, writePartialPlan, testFileOfId } from './gate-partial';
import { bunfigPreload, gitClosureTree, testsReachingChanged, type ClosureTree } from './gate-closure';

const P = 'a'.repeat(40);
const N = 'b'.repeat(40);
const base = { version: '0.2.18', priorCommit: P, forCommit: N, priorFailures: ['src/x.test.ts > slow one', 'src/y.test.ts > old fail'], priorErrors: [] };

test('GATE-PARTIAL: test-only changes plan the changed tests plus the prior failure files', () => {
  const planned = planPartialRegate({ ...base, changedFiles: ['scripts/audit.test.ts', 'docs/x.md', 'release/next.md'] });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  expect(planned.plan.files).toEqual(['scripts/audit.test.ts', 'src/x.test.ts', 'src/y.test.ts']);
  expect(planned.plan).toMatchObject({ priorCommit: P, forCommit: N });
});

test('GATE-PARTIAL: any non-test source change, the same commit, or an unsafe id falls back to a full gate', () => {
  expect(planPartialRegate({ ...base, changedFiles: ['src/x.test.ts', 'src/release-loop/gate.ts'] })).toMatchObject({ ok: false, reason: expect.stringContaining('non-test change') });
  expect(planPartialRegate({ ...base, forCommit: P, changedFiles: ['src/x.test.ts'] })).toMatchObject({ ok: false, reason: expect.stringContaining('no new commit') });
  expect(planPartialRegate({ ...base, priorFailures: ['../../etc > x'], changedFiles: ['src/x.test.ts'] })).toMatchObject({ ok: false });
  expect(planPartialRegate({ ...base, changedFiles: ['package.json'] })).toMatchObject({ ok: false });
});

test('GATE-PARTIAL: a plan is read only for its commit; a malformed plan is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-'));
  try {
    const planned = planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'] });
    if (!planned.ok) throw new Error('plan');
    writePartialPlan(root, planned.plan);
    expect(readPartialPlan([root], '0.2.18', N)?.files).toEqual(['src/x.test.ts', 'src/y.test.ts']);
    expect(readPartialPlan([root], '0.2.18', 'c'.repeat(40))).toBeNull();
    writeFileSync(partialPlanPath(root, '0.2.18'), JSON.stringify({ version: '0.2.18', priorCommit: P, forCommit: N, files: ['../x'], priorFailures: [], priorErrors: [] }));
    expect(() => readPartialPlan([root], '0.2.18', N)).toThrow('invalid gate partial plan');
    mkdirSync(join(root, 'empty'), { recursive: true });
    expect(readPartialPlan([join(root, 'empty')], '0.2.18', N)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-PARTIAL: a plan that would carry a prior failure it does not re-run is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-inv-'));
  try {
    mkdirSync(join(root, 'release', '0.2.18'), { recursive: true });
    writeFileSync(partialPlanPath(root, '0.2.18'), JSON.stringify({ version: '0.2.18', priorCommit: P, forCommit: N,
      files: ['src/x.test.ts'], priorFailures: ['src/x.test.ts > a', 'src/y.test.ts > b'], priorErrors: [] }));
    expect(() => readPartialPlan([root], '0.2.18', N)).toThrow('prior failure not re-run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-PARTIAL: merge takes the new run for re-run files (prior failures of re-run files are replaced)', () => {
  const planned = planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'] });
  if (!planned.ok) throw new Error('plan');
  expect(mergePartialFailures(planned.plan, { failures: ['src/y.test.ts > old fail'], errors: [] })).toEqual({ failures: ['src/y.test.ts > old fail'], errors: [] });
});

test('GATE-PARTIAL: an empty plan is malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-empty-'));
  try {
    mkdirSync(join(root, 'release', '0.2.18'), { recursive: true });
    writeFileSync(partialPlanPath(root, '0.2.18'), JSON.stringify({ version: '0.2.18', priorCommit: P, forCommit: N, files: [], priorFailures: [], priorErrors: [] }));
    expect(() => readPartialPlan([root], '0.2.18', N)).toThrow('invalid gate partial plan');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-PARTIAL: only Markdown is inert; every gate test suffix is a test file', () => {
  expect(planPartialRegate({ ...base, changedFiles: ['docs/fixtures/data.json'] })).toMatchObject({ ok: false, reason: expect.stringContaining('non-test change') });
  expect(planPartialRegate({ ...base, changedFiles: ['docs/run.sh'] })).toMatchObject({ ok: false });
  const planned = planPartialRegate({ ...base, changedFiles: ['scripts/x.test.mts', 'apps/pwa/y.test.jsx', 'README.md'] });
  expect(planned.ok).toBe(true);
  if (planned.ok) expect(planned.plan.files).toEqual(['apps/pwa/y.test.jsx', 'scripts/x.test.mts', 'src/x.test.ts', 'src/y.test.ts']);
});

test('GATE-PARTIAL: a real git rename of a source into a test name shows the vanished source, so the plan falls back', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-partial-git-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n'.repeat(20));
    git('add', '.'); git('commit', '-qm', 'one');
    const from = git('rev-parse', 'HEAD');
    git('mv', 'src/a.ts', 'src/a.test.ts');
    git('commit', '-qm', 'two');
    const to = git('rev-parse', 'HEAD');
    const changed = changedFilesBetween(repo, from, to);
    expect(changed.sort()).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(planPartialRegate({ ...base, priorCommit: from, forCommit: to, changedFiles: changed })).toMatchObject({ ok: false, reason: expect.stringContaining('src/a.ts') });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('GATE-PARTIAL: a root-level test file is a test file', () => {
  const planned = planPartialRegate({ ...base, changedFiles: ['foo.test.ts'] });
  expect(planned.ok && planned.plan.files.includes('foo.test.ts')).toBe(true);
});

test('GATE-PARTIAL: a plan with a malformed commit is an error, not silently skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-sha-'));
  try {
    mkdirSync(join(root, 'release', '0.2.18'), { recursive: true });
    for (const bad of [{ forCommit: 'garbage' }, { priorCommit: 'x' }, { priorCommit: N }]) {
      writeFileSync(partialPlanPath(root, '0.2.18'), JSON.stringify({ version: '0.2.18', priorCommit: P, forCommit: N, files: ['src/x.test.ts'], priorFailures: [], priorErrors: [], ...bad }));
      expect(() => readPartialPlan([root], '0.2.18', N)).toThrow('invalid gate partial plan');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-PARTIAL: Markdown that is test input (fixtures · test/ · snapshots) is not inert', () => {
  for (const file of ['test/fixtures/input.md', 'src/x/__fixtures__/a.md', 'apps/pwa/__snapshots__/s.md', 'test/notes.md']) {
    expect(planPartialRegate({ ...base, changedFiles: ['src/x.test.ts', file] })).toMatchObject({ ok: false, reason: expect.stringContaining(file) });
  }
  expect(planPartialRegate({ ...base, changedFiles: ['src/x.test.ts', 'docs/manual/MANUAL-x.md', 'README.md'] }).ok).toBe(true);
});

test('one failure-id rule for the gate and the partial plan (TC #24662 review)', () => {
  expect(testFileOfId('src/a.test.ts > case')).toBe('src/a.test.ts');
  expect(testFileOfId('apps/pwa/x.test.tsx > case')).toBe('apps/pwa/x.test.tsx');
  // The gate's parsers never emit these, so neither may the plan carry them.
  for (const id of ['a.test.ts > case', 'src/a.test.ts', 'src/../a.test.ts > case', 'src/a.test.mts > case']) {
    expect(() => testFileOfId(id)).toThrow('unsafe test path');
  }
  const plan = planPartialRegate({ version: '0.0.1', priorCommit: 'a'.repeat(40), forCommit: 'b'.repeat(40),
    changedFiles: ['src/x.test.ts'], priorFailures: ['root.test.ts > case'], priorErrors: [] });
  expect(plan).toEqual({ ok: false, reason: 'unsafe test path: root.test.ts' });
});

// GATE-REUSE-BY-DIFF (0.2.25): a code change re-runs the tests that can reach it through the tip's import closure.
const treeOf = (files: Record<string, string>, preload: string[] = []): ClosureTree =>
  ({ files: Object.keys(files), read: (path) => files[path], preload });
const TESTS = (tree: ClosureTree) => tree.files.filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));

test('GATE-REUSE-BY-DIFF closure: a test reaching a changed file through helpers is selected; an unrelated test is reused', () => {
  const tree = treeOf({
    'src/c.ts': 'export const c = 1;',
    'src/h.ts': "import { c } from './c.js'; export const h = c;",
    'src/a.test.ts': "import { h } from './h'; test('a', () => h);",
    'src/b.ts': 'export const b = 2;',
    'src/b.test.ts': "import { b } from './b.ts'; test('b', () => b);",
    'docs/x.md': '# not code',
  });
  const verdict = testsReachingChanged(tree, ['src/c.ts'], TESTS(tree));
  expect(verdict).toMatchObject({ ok: true, tests: ['src/a.test.ts'], reached: 1, opaque: 0 });
  // A changed test seeds its importers too (a test importing a shared test file).
  const shared = treeOf({ 'src/base.test.ts': 'export const x = 1;', 'src/uses.test.ts': "import { x } from './base.test';", 'src/other.test.ts': '' });
  expect(testsReachingChanged(shared, ['src/base.test.ts'], TESTS(shared))).toMatchObject({ ok: true, tests: ['src/base.test.ts', 'src/uses.test.ts'] });
});

test('GATE-REUSE-BY-DIFF closure: literal repo paths are dependencies; a path in a comment is not', () => {
  const tree = treeOf({
    'src/c.ts': 'export const c = 1;',
    'test/reads.test.ts': "import { readFileSync } from 'node:fs'; readFileSync('src/c.ts', 'utf8');",
    'test/mocks.test.ts': "mock.module('../src/c', () => ({}));",
    'test/comment.test.ts': "// reads src/c.ts once\n/* and '../src/c' */ test('x', () => 1);",
  });
  expect(testsReachingChanged(tree, ['src/c.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['test/mocks.test.ts', 'test/reads.test.ts'] });
});

test('GATE-REUSE-BY-DIFF closure: what we cannot name makes a test opaque (re-run), never reused', () => {
  const tree = treeOf({
    'src/c.ts': 'export const c = 1;',
    'src/loader.ts': 'export const load = (name: string) => import(name);',
    'src/bound.ts': "const M: string = './c.js'; export const load = () => import(M);",
    'src/joined.ts': 'export const load = () => import(["..", "src", "c.js"].join("/"));',
    'src/opt.ts': "const P = 'tesseract.js'; export const load = () => import(P);",
    'src/env.ts': "const O = process.env.X_MODULE ?? './c.js';\nexport const load = () => import(O);",
    'src/uses-loader.test.ts': "import { load } from './loader';",
    'src/uses-bound.test.ts': "import { load } from './bound';",
    'src/uses-joined.test.ts': "import { load } from './joined';",
    'src/uses-opt.test.ts': "import { load } from './opt';",
    'src/uses-env.test.ts': "import { load } from './env';",
    'test/scan.test.ts': "import { readdirSync } from 'node:fs'; readdirSync('src');",
    'test/dir.test.ts': "const dir = 'src/sub'; test('x', () => dir);",
    'src/sub/k.ts': '',
    'test/missing.test.ts': "import { gone } from '../src/gone';",
    'test/fixture-path.test.ts': "const p = 'src/nowhere/x.ts'; test('x', () => p);",
    'test/pieces.test.ts': "import { join } from 'node:path'; readFileSync(join(import.meta.dir, '..', 'src', 'oauth', 'store.ts'));",
  });
  const verdict = testsReachingChanged(tree, ['src/c.ts'], TESTS(tree));
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  // bound / joined / env-default loads resolve to src/c.ts (reached); a package name is not a repo dependency.
  expect(verdict.tests).toEqual(['src/uses-bound.test.ts', 'src/uses-env.test.ts', 'src/uses-joined.test.ts', 'src/uses-loader.test.ts',
    'test/dir.test.ts', 'test/fixture-path.test.ts', 'test/missing.test.ts', 'test/pieces.test.ts', 'test/scan.test.ts']);
  expect(verdict.reached).toBe(3);
  expect(verdict.opaqueFiles.join('\n')).toContain('src/loader.ts: non-literal import/require');
  // A path joined from pieces leaves only a bare file name — still a code path we cannot find (#26516 review).
  expect(verdict.opaqueFiles.join('\n')).toContain('test/pieces.test.ts: unresolved path store.ts');
});

test('GATE-REUSE-BY-DIFF closure: the CLI entry named by production code is a dependency only where it can be spawned', () => {
  const tree = treeOf({
    'bin/elanous.mjs': "#!/usr/bin/env bun\nimport { run } from '../src/index.ts'; run();",
    'src/index.ts': "export { c } from './c'; export const run = () => 1;",
    'src/c.ts': 'export const c = 1;',
    'src/hint.ts': "export const hint = ['bun', 'bin/elanous.mjs', 'harness', 'say'].join(' ');",
    'src/runner.ts': "import { spawnSync } from 'node:child_process'; export const go = () => spawnSync('bun', ['bin/elanous.mjs']);",
    'src/hint.test.ts': "import { hint } from './hint';",
    'src/runner.test.ts': "import { go } from './runner';",
  });
  const options = { cliEntries: ['bin/elanous.mjs', 'src/index.ts'] };
  expect(testsReachingChanged(tree, ['src/c.ts'], TESTS(tree), options)).toMatchObject({ ok: true, tests: ['src/runner.test.ts'] });
  // Without the CLI exemption both reach it (strict literal edges).
  expect(testsReachingChanged(tree, ['src/c.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['src/hint.test.ts', 'src/runner.test.ts'] });
});

test('GATE-REUSE-BY-DIFF closure: the preload static closure is every test\'s dependency; a load it cannot name is a full gate', () => {
  const files = {
    'test/preload.ts': "import { log } from '../src/log.ts';",
    'src/log.ts': "const p = './cfg.js'; export const log = () => { const name = p; require(name); };",
    'src/cfg.ts': 'export const cfg = 1;',
    'src/c.ts': 'export const c = 1;',
    'src/a.test.ts': "import { c } from './c';",
    'src/b.test.ts': '',
  };
  const tree = treeOf(files, ['test/preload.ts']);
  expect(testsReachingChanged(tree, ['src/log.ts'], TESTS(tree))).toMatchObject({ ok: false, reason: expect.stringContaining('src/log.ts changed') });
  // A load the preload closure cannot name may run before every test (top-level or not, the text cannot tell): full gate.
  expect(testsReachingChanged(tree, ['src/c.ts'], TESTS(tree))).toMatchObject({ ok: false, reason: expect.stringContaining('src/log.ts is opaque (non-literal import/require)') });
  // Without it the preload closure is clean and only the reaching test re-runs.
  const clean = { ...files, 'src/log.ts': "import { cfg } from './cfg'; export const log = () => cfg;" };
  expect(testsReachingChanged(treeOf(clean, ['test/preload.ts']), ['src/c.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['src/a.test.ts'] });
  expect(testsReachingChanged(treeOf(files, ['test/gone.ts']), ['src/c.ts'], TESTS(tree))).toMatchObject({ ok: false, reason: expect.stringContaining('missing') });
  expect(testsReachingChanged(treeOf({ ...files, 'test/preload.ts': "import '../src/nope';" }, ['test/preload.ts']), ['src/c.ts'], TESTS(tree)))
    .toMatchObject({ ok: false, reason: expect.stringContaining('opaque') });
});

test('GATE-REUSE-BY-DIFF closure: tsconfig path aliases resolve; bunfig preload parses or fails closed', () => {
  const tree: ClosureTree = { ...treeOf({ 'apps/pwa/src/c.ts': '', 'apps/pwa/src/c.test.ts': '', 'apps/pwa/src/u.test.tsx': "import { c } from '@/c';",
    'src/pkg.test.ts': "import x from 'lodash/fp'; import y from '@scope/z';", 'src/stray.test.ts': "import { c } from '@/c';" }),
    aliases: [{ scope: 'apps/pwa', prefix: '@/', target: 'apps/pwa/src' }] };
  // `@/c` outside the alias's scope is not a package name: an unknown alias is opaque, never «outside the repo».
  expect(testsReachingChanged(tree, ['apps/pwa/src/c.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['apps/pwa/src/u.test.tsx', 'src/stray.test.ts'], reached: 1, opaque: 1 });
  expect(bunfigPreload('# x\n[test]\n# bun test loads preload\npreload = ["./test/a.ts", "./test/b.ts"]\n')).toEqual(['test/a.ts', 'test/b.ts']);
  expect(bunfigPreload('[install]\nx = 1\n')).toEqual([]);
  expect(bunfigPreload(undefined)).toEqual([]);
  expect(bunfigPreload('[test]\npreload = PRELOADS\n')).toBeNull();
});

test('GATE-REUSE-BY-DIFF plan: code changes add the reaching tests; non-code changes and closure doubt stay full gates', () => {
  const tree = treeOf({ 'src/c.ts': '', 'src/c.test.ts': "import './c';", 'src/x.test.ts': '', 'src/y.test.ts': '', 'src/z.test.ts': '' });
  const closure = (changed: string[]) => testsReachingChanged(tree, changed, TESTS(tree));
  const planned = planPartialRegate({ ...base, changedFiles: ['src/c.ts', 'docs/a.md'], closure });
  expect(planned).toMatchObject({ ok: true, plan: { files: ['src/c.test.ts', 'src/x.test.ts', 'src/y.test.ts'] }, closure: { reached: 1, opaque: 0 } });
  expect(planPartialRegate({ ...base, changedFiles: ['src/c.ts', 'package.json'], closure })).toMatchObject({ ok: false, reason: expect.stringContaining('package.json') });
  expect(planPartialRegate({ ...base, changedFiles: ['src/c.ts'], closure: () => ({ ok: false, reason: 'preload changed' }) })).toEqual({ ok: false, reason: 'preload changed' });
  expect(planPartialRegate({ ...base, changedFiles: ['src/c.ts'], closure: () => { throw new Error('bad tree'); } })).toMatchObject({ ok: false, reason: expect.stringContaining('bad tree') });
  expect(planPartialRegate({ ...base, changedFiles: ['src/c.ts'], closure: () => ({ ok: true, tests: ['src/a b.test.ts'], reached: 1, opaque: 0, opaqueFiles: [] }) }))
    .toMatchObject({ ok: false, reason: expect.stringContaining('src/a b.test.ts') });
});

test('GATE-REUSE-BY-DIFF plan: a deleted changed test is not planned; a deleted prior-failure file is a full gate', () => {
  const exists = (file: string) => file !== 'src/old.test.ts';
  expect(planPartialRegate({ ...base, changedFiles: ['src/old.test.ts', 'src/new.test.ts'], existsAtTip: exists }))
    .toMatchObject({ ok: true, plan: { files: ['src/new.test.ts', 'src/x.test.ts', 'src/y.test.ts'] } });
  expect(planPartialRegate({ ...base, changedFiles: ['src/new.test.ts'], existsAtTip: (file) => file !== 'src/y.test.ts' }))
    .toMatchObject({ ok: false, reason: expect.stringContaining('prior failure file deleted') });
});

test('GATE-REUSE-BY-DIFF closure: the tip tree is read from git objects, not the working tree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-closure-git-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'bunfig.toml'), '[test]\npreload = ["./test/pre.ts"]\n');
    // JSONC with a comment, a trailing comma and a `src/**/*.ts` glob (a regex comment-stripper eats `/**/` … `*/`).
    mkdirSync(join(repo, 'app', 'src'), { recursive: true });
    writeFileSync(join(repo, 'app/tsconfig.json'), '{\n  // app\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] }, },\n  "include": ["src/**/*.ts"]\n}\n');
    writeFileSync(join(repo, 'app/src/k.ts'), 'export const k = 1;\n');
    writeFileSync(join(repo, 'app/src/k.test.ts'), "import { k } from '@/k';\n");
    writeFileSync(join(repo, 'test/pre.ts'), '');
    writeFileSync(join(repo, 'src/c.ts'), 'export const c = 1;\n');
    writeFileSync(join(repo, 'src/a.test.ts'), "import { c } from './c';\n");
    writeFileSync(join(repo, 'src/b.test.ts'), "test('b', () => 1);\n");
    git('add', '.'); git('commit', '-qm', 'one');
    const commit = git('rev-parse', 'HEAD');
    // The working tree differs from the commit: the closure must not see it.
    writeFileSync(join(repo, 'src/b.test.ts'), "import { c } from './c';\n");
    const tree = gitClosureTree(repo, commit);
    expect(tree.preload).toEqual(['test/pre.ts']);
    expect(tree.aliases).toEqual([{ scope: 'app', prefix: '@/', target: 'app/src' }]);
    expect(testsReachingChanged(tree, ['app/src/k.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['app/src/k.test.ts'] });
    expect(testsReachingChanged(tree, ['src/c.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['src/a.test.ts'] });
    expect(() => gitClosureTree(repo, 'c'.repeat(40))).toThrow('git ls-tree failed');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
