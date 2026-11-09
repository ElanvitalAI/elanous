import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as gatePartial from './gate-partial';
import { changedFilesBetween, mergePartialFailures, partialPlanPath, planPartialRegate, readPartialPlan, readPartialPlanResult, writePartialPlan, testFileOfId } from './gate-partial';
import { buildClosureGraph, bunfigPreload, gitClosureTree, testsReachingChanged, testsReachingChangedCliLazyRequireShadow, testsReachingChangedCliLazyRequireCandidate, testsReachingChangedForGateReuse, TRACEABLE_RELEASE_JSON, type ClosureTree } from './gate-closure';

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

test('GATE-REUSE-BY-DIFF: docs-only append with a clean prior cut produces a zero-file carry plan', () => {
  const planned = planPartialRegate({ ...base, changedFiles: ['README.md', 'docs/manual/usage.md'], priorFailures: [], priorErrors: [] });
  expect(planned).toMatchObject({ ok: true, plan: { kind: 'carry', files: [], priorCommit: P, forCommit: N } });
  if (!planned.ok) return;
  const root = mkdtempSync(join(tmpdir(), 'gate-carry-'));
  try {
    writePartialPlan(root, planned.plan);
    expect(readPartialPlan([root], base.version, N)).toMatchObject({ kind: 'carry', files: [] });
    expect(readPartialPlan([root], base.version, 'c'.repeat(40))).toBeNull();
    writeFileSync(partialPlanPath(root, base.version), JSON.stringify({ ...planned.plan, priorFailures: ['src/x.test.ts > failure'] }));
    expect(() => readPartialPlan([root], base.version, N)).toThrow('invalid gate partial plan');
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect(planPartialRegate({ ...base, changedFiles: ['test/fixtures/readme.md'], priorFailures: [], priorErrors: [] }).ok).toBe(false);
  expect(planPartialRegate({ ...base, changedFiles: ['src/deleted.test.ts'], priorFailures: [], priorErrors: [], existsAtTip: () => false }).ok).toBe(false);
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

test('RELEASE-APPEND-SCOPE-SKIP: the known-issues JSON selects its real reader test; other JSON stays full', () => {
  const tree = treeOf({
    [TRACEABLE_RELEASE_JSON]: '[]',
    'scripts/release-loop/known-issues-node.ts': "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; export const issues = JSON.parse(readFileSync(join(import.meta.dir, 'known-issues-0.2.33-approved.json'), 'utf8'));",
    'scripts/release-loop/known-issues-node.test.ts': "import { spawnSync } from 'node:child_process'; import { join } from 'node:path'; test('issues', () => spawnSync('bun', [join(import.meta.dir, 'known-issues-node.ts')]));",
    'src/unrelated.test.ts': "test('other', () => true);",
  });
  const closure = (changed: string[]) => testsReachingChanged(tree, changed, TESTS(tree));
  expect(closure([TRACEABLE_RELEASE_JSON])).toMatchObject({ ok: true, tests: ['scripts/release-loop/known-issues-node.test.ts'], reached: 1 });
  const plan = planPartialRegate({ ...base, changedFiles: [TRACEABLE_RELEASE_JSON], priorFailures: [], closure });
  expect(plan).toMatchObject({ ok: true, plan: { files: ['scripts/release-loop/known-issues-node.test.ts'] } });
  expect(planPartialRegate({ ...base, changedFiles: ['scripts/release-loop/other.json'], priorFailures: [], closure }))
    .toMatchObject({ ok: false, reason: expect.stringContaining('non-test change') });
});

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

test('GATE-REUSE-BY-DIFF closure: type-only imports do not reach runtime code, value imports do', () => {
  const tree = treeOf({
    'src/contracts.ts': 'export interface Contract { value: string; }',
    'src/runtime.ts': 'export const value = 1;',
    'src/types-only.test.ts': "import type { Contract } from './contracts.js'; test('types', () => ({ value: 'ok' } satisfies Contract));",
    'src/inline-type.test.ts': "import { type Contract } from './contracts.js'; test('inline type', () => ({ value: 'ok' } satisfies Contract));",
    'src/value.test.ts': "import { value } from './runtime.js'; test('runtime', () => value);",
  });
  expect(testsReachingChanged(tree, ['src/contracts.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: [], reached: 0, opaque: 0 });
  expect(testsReachingChanged(tree, ['src/runtime.ts'], TESTS(tree))).toMatchObject({ ok: true, tests: ['src/value.test.ts'], reached: 1, opaque: 0 });
});

const GATE_LIVE_MAIN_COMMIT = '6d2eb2f3cfb09a3552a206078a6f42c14c9b71dd';
const GATE_LIVE_MAIN_TEST_COUNT = 6687;
const GATE_LIVE_MAIN_SELECTED_COUNT = 5473;
const GATE_LIVE_MAIN_SELECTION_SHA256 = 'd857a71e6e1337307e394c91a9c3567fb9c968a104d1043b58bbf9bce8b288c9';

test('GATE-CLOSURE-LAZY-REQUIRE live parity: the tracked main corpus keeps the exact main selection set', () => {
  // Golden values were measured by main's original gate-closure.ts on this pinned main tree.
  const tree = gitClosureTree(process.cwd(), GATE_LIVE_MAIN_COMMIT);
  const tests = TESTS(tree);
  expect(tests).toHaveLength(GATE_LIVE_MAIN_TEST_COUNT);
  const live = testsReachingChangedForGateReuse(tree, ['scripts/release-loop/gate-closure.ts'], tests);
  expect(live.ok).toBe(true);
  if (!live.ok) return;
  expect(live.tests).toHaveLength(GATE_LIVE_MAIN_SELECTED_COUNT);
  expect(createHash('sha256').update(live.tests.join('\n')).digest('hex')).toBe(GATE_LIVE_MAIN_SELECTION_SHA256);
}, 900_000);

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: only CLI-path tests retain function-local require reach', () => {
  const tree = treeOf({
    'bin/elanous.mjs': "import '../src/index.ts';",
    // sim-cli is reached only through the function-local require. Keep erased TS syntax before it so the
    // candidate parser must use transformed-JS offsets rather than masking the wrong source range.
    'src/index.ts': "import { spawnSync } from 'node:child_process';\ntype ErasedBeforeRuntime = { first: string; second: { nested: number } };\n// another erased offset\nexport const run: () => unknown = () => { spawnSync('bun', ['helper']); return require('./sim-cli.ts'); };",
    'src/sim-cli.ts': 'export const sim = true;',
    'test/cli-spawn.test.ts': "import { spawnSync } from 'node:child_process'; spawnSync('bun', ['bin/' + 'elanous.mjs']);",
    'test/module-import.test.ts': "import '../src/index.ts';",
    'test/helpers/cli-spawn-helper.ts': "import { spawnSync } from 'node:child_process'; import { join } from 'node:path'; export const launch = () => spawnSync('bun', [join('bin', 'elanous.mjs')]);",
    'test/cli-helper-spawn.test.ts': "import { launch } from './helpers/cli-spawn-helper.ts'; launch();",
    'test/helpers/cli-path-helper.ts': "export const cliPath = ['bin', 'elanous.mjs'].join('/');",
    'test/helpers/process-launch-helper.ts': "import { spawnSync } from 'node:child_process'; export const launchPath = (path: string) => spawnSync('bun', [path]);",
    'test/cli-split-helpers.test.ts': "import { cliPath } from './helpers/cli-path-helper.ts'; import { launchPath } from './helpers/process-launch-helper.ts'; launchPath(cliPath);",
  });
  const tests = TESTS(tree);
  const shadow = testsReachingChangedCliLazyRequireCandidate(tree, ['src/sim-cli.ts'], tests);
  expect(shadow.current).toMatchObject({ ok: true, tests: ['test/cli-helper-spawn.test.ts', 'test/cli-spawn.test.ts', 'test/cli-split-helpers.test.ts', 'test/module-import.test.ts'], reached: 2, opaque: 2 });
  expect(shadow.proposed).toMatchObject({ ok: true, tests: ['test/cli-helper-spawn.test.ts', 'test/cli-spawn.test.ts',
    'test/cli-split-helpers.test.ts'] });
  expect(shadow.cliSpawnTests).toEqual(['test/cli-spawn.test.ts']);
  expect(testsReachingChangedForGateReuse(tree, ['src/sim-cli.ts'], tests)).toMatchObject({ ok: true,
    tests: ['test/cli-helper-spawn.test.ts', 'test/cli-spawn.test.ts', 'test/cli-split-helpers.test.ts', 'test/module-import.test.ts'] });
  const entrypoint = testsReachingChangedCliLazyRequireCandidate(tree, ['bin/' + 'elanous.mjs'], tests);
  expect(entrypoint.proposed).toMatchObject({ ok: true,
    tests: ['test/cli-helper-spawn.test.ts', 'test/cli-spawn.test.ts', 'test/cli-split-helpers.test.ts'] });
  // The conservative radius includes module-import tests through the lazy edge; the candidate drops only that edge.
  if (!shadow.current.ok) throw new Error(shadow.current.reason);
  expect(shadow.current.tests).toContain('test/module-import.test.ts');
  expect(shadow.proposed.ok && shadow.proposed.tests).not.toContain('test/module-import.test.ts');
});

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: top-level and immediately invoked process spawns stay opaque', () => {
  const tree = treeOf({
    'src/index.ts': "import { spawnSync } from 'node:child_process'; spawnSync('bun', ['helper']); export const load = () => require('./lazy-only.ts');",
    'src/iife.ts': "import { spawnSync } from 'node:child_process'; (() => spawnSync('bun', ['helper']))(); export const load = () => require('./lazy-only.ts');",
    'src/lazy-only.ts': 'export const value = 1;',
    'test/module-import.test.ts': "import '../src/index.ts'; import '../src/iife.ts';",
  });
  const shadow = testsReachingChangedCliLazyRequireCandidate(tree, ['src/lazy-only.ts'], TESTS(tree));
  expect(shadow.proposed).toMatchObject({ ok: true, tests: ['test/module-import.test.ts'] });
  const iifeTree = treeOf({
    'src/iife.ts': "import { spawnSync } from 'node:child_process'; (() => spawnSync('bun', ['helper']))(); export const load = () => require('./lazy-only.ts');",
    'src/lazy-only.ts': 'export const value = 1;',
    'test/iife-import.test.ts': "import '../src/iife.ts';",
  });
  const iifeShadow = testsReachingChangedCliLazyRequireCandidate(iifeTree, ['src/lazy-only.ts'], TESTS(iifeTree));
  expect(iifeShadow.current.ok && iifeShadow.current.opaqueFiles).toContain('src/iife.ts: spawns a command with an opaque repo input');
  expect(iifeShadow.proposed).toMatchObject({ ok: true, tests: ['test/iife-import.test.ts'] });
  const assertedIifeTree = treeOf({
    'src/asserted-iife.ts': "import { spawnSync } from 'node:child_process'; ((() => spawnSync('bun', ['helper'])) as () => unknown)(); export const load = () => require('./lazy-only.ts');",
    'src/lazy-only.ts': 'export const value = 1;',
    'test/asserted-iife-import.test.ts': "import '../src/asserted-iife.ts';",
  });
  const assertedIife = testsReachingChangedCliLazyRequireCandidate(assertedIifeTree, ['src/lazy-only.ts'], TESTS(assertedIifeTree));
  expect(assertedIife.current.ok && assertedIife.current.opaqueFiles)
    .toContain('src/asserted-iife.ts: spawns a command with an opaque repo input');
  expect(assertedIife.proposed).toMatchObject({ ok: true, tests: ['test/asserted-iife-import.test.ts'] });
});

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: production function-local spawn is a measured candidate reduction only', () => {
  const tree = treeOf({
    'src/changed-runtime.ts': 'export const target = process.env.TARGET;',
    'src/production-cli-helper.ts': "import { spawnSync } from 'node:child_process'; export const run = () => { const target = require('./changed-runtime.ts'); return spawnSync('bun', ['bin/' + 'elanous.mjs', target]); };",
    'test/production-cli-helper.test.ts': "import { run } from '../src/production-cli-helper'; test('production helper', run);",
  });
  const comparison = testsReachingChangedCliLazyRequireCandidate(tree, ['src/changed-runtime.ts'], TESTS(tree));
  expect(comparison.current).toMatchObject({ ok: true, tests: ['test/production-cli-helper.test.ts'] });
  expect(comparison.proposed).toMatchObject({ ok: true, tests: [] });
  expect(testsReachingChangedForGateReuse(tree, ['src/changed-runtime.ts'], TESTS(tree)))
    .toMatchObject({ ok: true, tests: comparison.current.ok ? comparison.current.tests : [] });
});

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: top-level require is never omitted', () => {
  const tree = treeOf({
    'src/index.ts': "require('./sim-cli.ts');",
    'src/sim-cli.ts': 'export const sim = true;',
    'test/module-import.test.ts': "import '../src/index.ts';",
  });
  const shadow = testsReachingChangedCliLazyRequireCandidate(tree, ['src/sim-cli.ts'], TESTS(tree));
  expect(shadow.proposed).toMatchObject({ ok: true, tests: ['test/module-import.test.ts'] });
});

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: require-call-only dependency is omitted from proposed reach', () => {
  const tree = treeOf({
    'src/index.ts': "export const load = () => require('./lazy-only.ts');",
    'src/lazy-only.ts': 'export const value = 1;',
    'test/module-import.test.ts': "import '../src/index.ts';",
  });
  const shadow = testsReachingChangedCliLazyRequireCandidate(tree, ['src/lazy-only.ts'], TESTS(tree));
  expect(shadow.current).toMatchObject({ ok: true, tests: ['test/module-import.test.ts'] });
  expect(shadow.proposed).toMatchObject({ ok: true, tests: [] });
  // Live stays on main's existing calculation and does not consume the new shadow candidate.
  const legacy = testsReachingChangedCliLazyRequireShadow(tree, ['src/lazy-only.ts'], TESTS(tree));
  if (!legacy.current.ok || !legacy.proposed.ok) throw new Error('legacy baseline should be decidable');
  expect(testsReachingChangedForGateReuse(tree, ['src/lazy-only.ts'], TESTS(tree)))
    .toEqual({ ...legacy.current, tests: legacy.proposed.tests });
});

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: normalized resolve path to CLI stays in the conservative set', () => {
  const tree = treeOf({
    'bin/elanous.mjs': "import '../src/index.ts';",
    'src/index.ts': "export const load = () => require('./lazy-only.ts');",
    'src/lazy-only.ts': 'export const value = 1;',
    'test/cli-resolve-path.test.ts': "import { spawnSync } from 'node:child_process'; import { resolve } from 'node:path'; spawnSync('bun', [resolve(root, 'bin/', 'elanous.mjs')]);",
  });
  const shadow = testsReachingChangedCliLazyRequireCandidate(tree, ['src/lazy-only.ts'], TESTS(tree));
  expect(shadow.cliSpawnTests).toEqual(['test/cli-resolve-path.test.ts']);
  expect(shadow.proposed).toMatchObject({ ok: true, tests: ['test/cli-resolve-path.test.ts'] });
});

test('GATE-CLOSURE-LAZY-REQUIRE shadow simulation: only actual filesystem readers make modules opaque', () => {
  const tree = treeOf({
    'src/changed.ts': 'export const changed = true;',
    'src/domain-log.ts': 'export class Log { readFile() { return "memory"; } }',
    'src/fs-reader.ts': "import * as fs from 'node:fs'; export const read = () => fs.readFileSync(process.env.INPUT!, 'utf8');",
    'src/object-reader-escape.ts': "import { readFileSync } from 'node:fs'; const readers = { read: readFileSync }; export const read = () => readers.read(process.env.INPUT!, 'utf8');",
    'src/namespace-reader-escape.ts': "import * as fs from 'node:fs'; const readLater = (reader: typeof fs.readFileSync) => reader(process.env.INPUT!, 'utf8'); export const read = () => readLater(fs.readFileSync);",
    'src/promises-destructure-reader.ts': "import * as fs from 'node:fs'; const { readFile: read } = fs.promises; export const load = () => read(process.env.INPUT!, 'utf8');",
    'src/promises-alias-destructure-reader.ts': "import * as fs from 'node:fs'; const p = fs.promises; const { readFile: read } = p; export const load = () => read(process.env.INPUT!, 'utf8');",
    'src/promises-reader.ts': "const fs = require('fs'); export const read = () => fs.promises.readFile(process.env.INPUT!, 'utf8');",
    'src/named-promises-reader.ts': "import { promises as fs } from 'node:fs'; export const read = () => fs.readFile(process.env.INPUT!, 'utf8');",
    'test/domain-log.test.ts': "import { Log } from '../src/domain-log'; test('memory log', () => new Log().readFile());",
    'test/fs-reader.test.ts': "import { read } from '../src/fs-reader'; test('fs reader', read);",
    'test/object-reader-escape.test.ts': "import { read } from '../src/object-reader-escape'; test('object reader escape', read);",
    'test/namespace-reader-escape.test.ts': "import { read } from '../src/namespace-reader-escape'; test('namespace reader escape', read);",
    'test/promises-destructure-reader.test.ts': "import { load } from '../src/promises-destructure-reader'; test('promises destructure reader', load);",
    'test/promises-alias-destructure-reader.test.ts': "import { load } from '../src/promises-alias-destructure-reader'; test('promises alias destructure reader', load);",
    'test/promises-reader.test.ts': "import { read } from '../src/promises-reader'; test('promises reader', read);",
    'test/named-promises-reader.test.ts': "import { read } from '../src/named-promises-reader'; test('named promises reader', read);",
  });
  const comparison = testsReachingChangedCliLazyRequireCandidate(tree, ['src/changed.ts'], TESTS(tree));
  expect(comparison.current).toMatchObject({ ok: true, tests: ['test/domain-log.test.ts', 'test/fs-reader.test.ts',
    'test/named-promises-reader.test.ts', 'test/promises-reader.test.ts'], reached: 0, opaque: 4 });
  expect(comparison.proposed).toMatchObject({ ok: true, tests: ['test/fs-reader.test.ts', 'test/named-promises-reader.test.ts',
    'test/namespace-reader-escape.test.ts', 'test/object-reader-escape.test.ts', 'test/promises-alias-destructure-reader.test.ts',
    'test/promises-destructure-reader.test.ts', 'test/promises-reader.test.ts'] });
  expect(comparison.current.ok && comparison.current.opaqueFiles).toEqual([
    'src/domain-log.ts: reads a file through an opaque path',
    'src/fs-reader.ts: reads a file through an opaque path',
    'src/named-promises-reader.ts: reads a file through an opaque path',
    'src/promises-reader.ts: reads a file through an opaque path',
    'test/domain-log.test.ts: reads a file through an opaque path',
  ]);
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

test('GATE-REUSE-BY-DIFF closure: only actual process APIs make a module opaque for spawning', () => {
  const tree = treeOf({
    'src/domain.ts': 'export const run = (r: RegExp, x: string, git: { fork(): void }) => { x.match(r); git.fork(); };',
    'src/shadowed-spawn.ts': "import { spawn } from 'node:child_process'; export const run = (spawn: (...args: unknown[]) => void) => spawn('fake');",
    'src/shadowed-namespace.ts': "import * as cp from 'node:child_process'; export const run = (cp: { spawn(): void }) => cp.spawn();",
    'src/typed-child-namespace.ts': "import { spawn } from 'node:child_process'; export const run = (cp: { spawn: typeof spawn }) => cp.spawn('bun', ['dynamicPath']);",
    'src/shadowed-alias.ts': "import { spawn } from 'node:child_process'; export const run = (spawn: (...args: unknown[]) => void) => { const start = spawn; start('fake'); };",
    'src/child-computed.ts': "export const run = (method: string) => require('node:child_process')[method]('bun', ['dynamicPath']);",
    'src/child-namespace-alias.ts': "import * as cp from 'node:child_process'; const child = cp; export const run = () => child.spawn('bun', ['dynamicPath']);",
    'src/non-process-computed.ts': "const methods = { fork() {} }; export const run = () => methods['fork']();",
    'src/nested-spawn-alias.ts': "import { sp" + "awn } from 'node:child_process'; export function run(run: (...args: unknown[]) => void) { { const run = sp" + "awn; run('bun', ['dynamicPath']); } }",
    'src/child-named.ts': "import { spawn as launch } from 'node:child_process'; export const run = () => launch('bun', ['bin/' + 'elanous.mjs']);",
    'src/child-namespace.ts': "import * as cp from 'child_process'; export const run = () => cp.execFile('bun', ['bin/' + 'elanous.mjs']);",
    'src/child-require.ts': "const { fork: start } = require('node:child_process'); export const run = () => start('worker.js');",
    'src/bun-launch.ts': "export const run = () => Bun.spawn(['bun', 'bin/' + 'elanous.mjs']);",
    'src/bun-alias-top-level.ts': "const launch = Bun.spawn; launch(['bun', process.env.APP_COMMAND!]);",
    'src/bun-destructure-top-level.ts': "const { spawn: run } = Bun; run(['bun', process.env.APP_COMMAND!]);",
    'src/bun-asserted-alias.ts': "const launch = Bun.spawn as typeof Bun.spawn; launch(['bun', process.env.APP_COMMAND!]);",
    'src/bun-dollar-destructure.ts': "const { $: run } = Bun; run`echo hello`;",
    'src/bun-sync.ts': "export const run = () => Bun.spawnSync(['bun', 'bin/' + 'elanous.mjs']);",
    'src/bun-dollar.ts': "export const run = () => Bun.$`echo bin/" + "elanous.mjs`;",
    'src/child-alias.ts': "import { spawn } from 'node:child_process'; const start = spawn; export const run = () => start('bun', ['bin/' + 'elanous.mjs']);",
    'src/child-require-alias.ts': "const start = require('node:child_process').spawn; export const run = () => start('bun', ['bin/' + 'elanous.mjs']);",
    'src/tsx-launch.tsx': "import { spawn } from 'node:child_process'; export const App = () => <main>{spawn('bun', ['bin/' + 'elanous.mjs']).pid}</main>;",
    'test/domain-methods.test.ts': "import { run } from '../src/domain'; test('methods', () => run(/x/, 'x', { fork() {} }));",
    'test/shadowed-spawn.test.ts': "import { run } from '../src/shadowed-spawn'; test('shadowed spawn', () => run(() => {}));",
    'test/shadowed-namespace.test.ts': "import { run } from '../src/shadowed-namespace'; test('shadowed namespace', () => run({ spawn() {} }));",
    'test/typed-child-namespace.test.ts': "import { run } from '../src/typed-child-namespace'; test('typed child namespace', run);",
    'test/shadowed-alias.test.ts': "import { run } from '../src/shadowed-alias'; test('shadowed spawn alias', () => run(() => {}));",
    'test/child-computed.test.ts': "import { run } from '../src/child-computed'; test('computed child_process method', () => run('spawn'));",
    'test/child-namespace-alias.test.ts': "import { run } from '../src/child-namespace-alias'; test('nested namespace alias', run);",
    'test/non-process-computed.test.ts': "import { run } from '../src/non-process-computed'; test('non-process computed method', run);",
    'test/nested-spawn-alias.test.ts': "import { run } from '../src/nested-spawn-alias'; test('nested alias beats outer shadow', () => run(() => {}));",
    'test/child-named.test.ts': "import { run } from '../src/child-named'; test('spawn', run);",
    'test/child-namespace.test.ts': "import { run } from '../src/child-namespace'; test('execFile', run);",
    'test/child-require.test.ts': "import { run } from '../src/child-require'; test('fork', run);",
    'test/bun-launch.test.ts': "import { run } from '../src/bun-launch'; test('bun spawn', run);",
    'test/bun-alias-top-level.test.ts': "import '../src/bun-alias-top-level';",
    'test/bun-destructure-top-level.test.ts': "import '../src/bun-destructure-top-level';",
    'test/bun-asserted-alias.test.ts': "import '../src/bun-asserted-alias';",
    'test/bun-dollar-destructure.test.ts': "import '../src/bun-dollar-destructure';",
    'test/bun-sync.test.ts': "import { run } from '../src/bun-sync'; test('bun spawnSync', run);",
    'test/bun-dollar.test.ts': "import { run } from '../src/bun-dollar'; test('bun shell', run);",
    'test/child-alias.test.ts': "import { run } from '../src/child-alias'; test('alias', run);",
    'test/child-require-alias.test.ts': "import { run } from '../src/child-require-alias'; test('require alias', run);",
    'test/tsx-launch.test.tsx': "import { App } from '../src/tsx-launch'; test('tsx spawn', App);",
  });
  const graph = buildClosureGraph(tree, { shadowCandidatePrecision: true });
  expect(graph.opaque.get('src/domain.ts')).toBeUndefined();
  expect(graph.opaque.get('src/shadowed-spawn.ts')).toBeUndefined();
  expect(graph.opaque.get('src/shadowed-namespace.ts')).toBeUndefined();
  expect(graph.opaque.get('src/typed-child-namespace.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('src/shadowed-alias.ts')).toBeUndefined();
  expect(graph.opaque.get('src/non-process-computed.ts')).toBeUndefined();
  expect(graph.opaque.get('src/child-computed.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('src/child-namespace-alias.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('src/nested-spawn-alias.ts')).toBe('spawns a command with an opaque repo input');
  for (const file of ['src/child-named.ts', 'src/child-namespace.ts', 'src/child-require.ts', 'src/bun-launch.ts', 'src/bun-alias-top-level.ts', 'src/bun-destructure-top-level.ts', 'src/child-alias.ts', 'src/child-require-alias.ts', 'src/child-computed.ts', 'src/child-namespace-alias.ts', 'src/tsx-launch.tsx', 'src/bun-sync.ts', 'src/bun-dollar.ts', 'src/bun-asserted-alias.ts', 'src/bun-dollar-destructure.ts'])
    expect(graph.opaque.get(file)).toBe('spawns a command with an opaque repo input');
  const domain = testsReachingChangedCliLazyRequireCandidate(tree, ['src/domain.ts'], TESTS(tree));
  expect(domain.proposed.ok).toBe(true);
  if (!domain.proposed.ok) return;
  expect(domain.proposed.tests).toContain('test/domain-methods.test.ts');
  expect(graph.opaque.get('src/domain.ts')).toBeUndefined();
});

test('GATE-REUSE-BY-DIFF closure: tests with runtime-selected file and command paths are opaque and rerun', () => {
  const tree = treeOf({
    'scripts/check.ts': 'export const check = true;',
    'test/spawn-dynamic.test.ts': "import { spawnSync } from 'node:child_process'; const command = process.env.TEST_COMMAND; spawnSync(command, process.argv.slice(2));",
    'test/read-dynamic.test.ts': "import { readFileSync } from 'node:fs'; readFileSync(process.env.TEST_FIXTURE, 'utf8');",
    'test/read-bracket.test.ts': "import { readFileSync } from 'node:fs'; readFileSync(process.env['TEST_FIXTURE'], 'utf8');",
    'test/read-helper.test.ts': "import { readFileSync } from 'node:fs'; readFileSync(resolveFixturePath(), 'utf8');",
    'test/read-alias.test.ts': "import { readFileSync as load } from 'node:fs'; load(process.env.TEST_FIXTURE, 'utf8');",
    'test/read-require-alias.test.ts': "const { readFileSync: load } = require('fs'); load(process.env.TEST_FIXTURE, 'utf8');",
    'src/file-loader.ts': "import { readFileSync as load } from 'node:fs'; export const loadFixture = () => load(process.env.TEST_FIXTURE, 'utf8');",
    'test/read-through-module.test.ts': "import { loadFixture } from '../src/file-loader'; loadFixture();",
    'src/command-runner.ts': "import { spawnSync } from 'node:child_process'; export const run = (command: string) => spawnSync(command, []);",
    'test/spawn-through-module.test.ts': "import { run } from '../src/command-runner'; run(process.env.TEST_COMMAND!);",
    'test/unrelated.test.ts': 'test("plain", () => 1);',
  });
  expect(testsReachingChanged(tree, ['scripts/check.ts'], TESTS(tree))).toMatchObject({
    ok: true, tests: ['test/read-alias.test.ts', 'test/read-bracket.test.ts', 'test/read-dynamic.test.ts', 'test/read-helper.test.ts',
      'test/read-require-alias.test.ts', 'test/read-through-module.test.ts', 'test/spawn-dynamic.test.ts', 'test/spawn-through-module.test.ts'], opaque: 8,
  });
});


test('GATE-REUSE-BY-DIFF closure: process launch names require a child_process binding', () => {
  const tree = treeOf({
    'src/session-store.ts': 'export class SessionStore { fork(id: string) { return id; } }',
    'test/session-store.test.ts': "import { SessionStore } from '../src/session-store'; const store = new SessionStore(); store.fork('id');",
    'test/child-process-fork.test.ts': "import { fork as childFork } from 'node:child_process'; childFork('command', []);",
    'test/require-destructure-fork.test.ts': "const cp = require('node:child_process'); const { fork: launch } = cp; launch('command', []);",
    'test/proxy-child-process-fork.test.ts': "const cp = new Proxy(require('node:child_process'), {}); cp.fork('command', []);",
    'test/bun-shell-template.test.ts': 'Bun.$`echo hello`;',
    'test/unresolved-fork.test.ts': 'function callUnknown(store: unknown) { store.fork(); }',
  });
  const graph = buildClosureGraph(tree);
  expect(graph.opaque.get('src/session-store.ts')).toBeUndefined();
  expect(graph.opaque.get('test/session-store.test.ts')).toBeUndefined();
  expect(graph.opaque.get('test/child-process-fork.test.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('test/require-destructure-fork.test.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('test/proxy-child-process-fork.test.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('test/bun-shell-template.test.ts')).toBe('spawns a command with an opaque repo input');
  expect(graph.opaque.get('test/unresolved-fork.test.ts')).toBe('spawns a command with an opaque repo input');
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
    'src/runner.ts': "import { spawnSync } from 'node:child_process'; export const go = () => spawnSync('bun', ['bin/' + 'elanous.mjs']);",
    'src/hint.test.ts': "import { hint } from './hint';",
    'src/runner.test.ts': "import { go } from './runner';",
  });
  const options = { cliEntries: ['bin/' + 'elanous.mjs', 'src/index.ts'] };
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
    expect(() => gitClosureTree(repo, 'c'.repeat(40))).toThrow('CutSnapshot ls-tree failed');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// RELEASE-GATE-RADIUS-POD-IMAGE (#29549 Sol r5): reuse is never opened by a diff-only match.
// imageDigest is the executed container imageID digest from a Pod shard result, never a Job image ref/tag.
const DIGEST_035 = `sha256:${'e'.repeat(64)}`;
const DIGEST_NEXT = `sha256:${'f'.repeat(64)}`;
const podShard = (imageDigest?: string | null) => ({ imageDigest });

function imageDigestsMatch(prior: readonly { imageDigest?: string | null }[], current?: readonly { imageDigest?: string | null }[]) {
  const decide = (gatePartial as { partialPlanImageDigestsMatch?: (a: readonly { imageDigest?: string | null }[], b?: readonly { imageDigest?: string | null }[]) => { reuse: 0 | 1; reason: string } }).partialPlanImageDigestsMatch;
  expect(typeof decide).toBe('function');
  return decide!(prior, current);
}

function collectedShardImages(dir: string, commit?: string): Array<{ imageDigest?: string | null }> {
  const collect = (gatePartial as { collectExecutedPodShardImages?: (dir: string, commit?: string) => Array<{ imageDigest?: string | null }> }).collectExecutedPodShardImages;
  expect(typeof collect).toBe('function');
  return collect!(dir, commit);
}

test('RELEASE-GATE-RADIUS-POD-IMAGE: matching executed shard digests allow reuse on the production plan path', () => {
  const shards = [podShard(DIGEST_035), podShard(DIGEST_035)];
  expect(imageDigestsMatch(shards)).toEqual({ reuse: 1, reason: 'executed-pod-image-digest-match' });
  expect(imageDigestsMatch(shards, shards)).toEqual({ reuse: 1, reason: 'executed-pod-image-digest-match' });
  const planned = planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'], priorShards: shards, currentShards: shards });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  expect(planned.plan.shardImageDigests).toEqual([DIGEST_035, DIGEST_035]);
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-digest-match-'));
  try {
    writePartialPlan(root, planned.plan);
    expect(readPartialPlanResult([root], base.version, N)).toEqual({
      plan: planned.plan,
      fallbackReason: null,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GATE-RADIUS-POD-IMAGE: mismatched executed shard digests force full fallback with a mismatch reason', () => {
  const shards = [podShard(DIGEST_035), podShard(DIGEST_NEXT)];
  expect(imageDigestsMatch(shards)).toEqual({ reuse: 0, reason: 'executed-pod-image-digest-mismatch' });
  expect(planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'], priorShards: shards }))
    .toEqual({ ok: false, reason: 'executed-pod-image-digest-mismatch' });
  const mixedCurrent = planPartialRegate({
    ...base, changedFiles: ['src/x.test.ts'],
    priorShards: [podShard(DIGEST_035), podShard(DIGEST_035)],
    currentShards: [podShard(DIGEST_NEXT), podShard(DIGEST_NEXT)],
  });
  expect(mixedCurrent).toEqual({ ok: false, reason: 'executed-pod-image-digest-mismatch' });
  const planned = planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'] });
  if (!planned.ok) throw new Error('plan');
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-digest-mismatch-'));
  try {
    writePartialPlan(root, { ...planned.plan, shardImageDigests: [DIGEST_035, DIGEST_NEXT] });
    expect(readPartialPlanResult([root], base.version, N)).toEqual({
      plan: null,
      fallbackReason: 'executed-pod-image-digest-mismatch',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GATE-RADIUS-POD-IMAGE: missing executed shard digest forces full fallback with a missing reason', () => {
  expect(imageDigestsMatch([podShard(DIGEST_035), podShard()])).toEqual({ reuse: 0, reason: 'executed-pod-image-digest-missing' });
  expect(imageDigestsMatch([])).toEqual({ reuse: 0, reason: 'executed-pod-image-digest-missing' });
  expect(imageDigestsMatch([podShard('registry.local/elanous:0.2.35')])).toEqual({ reuse: 0, reason: 'executed-pod-image-digest-missing' });
  expect(imageDigestsMatch([podShard(`registry.local/elanous@${DIGEST_035}`)])).toEqual({ reuse: 0, reason: 'executed-pod-image-digest-missing' });
  expect(planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'], priorShards: [podShard(DIGEST_035), podShard()] }))
    .toEqual({ ok: false, reason: 'executed-pod-image-digest-missing' });
  expect(planPartialRegate({
    ...base, changedFiles: ['src/x.test.ts'],
    priorShards: [podShard(DIGEST_035)],
    currentShards: [podShard()],
  })).toEqual({ ok: false, reason: 'executed-pod-image-digest-missing' });
  const planned = planPartialRegate({ ...base, changedFiles: ['src/x.test.ts'] });
  if (!planned.ok) throw new Error('plan');
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-digest-missing-'));
  try {
    mkdirSync(join(root, 'release', base.version), { recursive: true });
    writeFileSync(partialPlanPath(root, base.version), JSON.stringify({ ...planned.plan, shardImageDigests: [DIGEST_035, ''] }));
    expect(readPartialPlanResult([root], base.version, N)).toEqual({
      plan: null,
      fallbackReason: 'executed-pod-image-digest-missing',
    });
    writeFileSync(partialPlanPath(root, base.version), JSON.stringify({ ...planned.plan, shardImageDigests: [] }));
    expect(readPartialPlanResult([root], base.version, N)).toEqual({
      plan: null,
      fallbackReason: 'executed-pod-image-digest-missing',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GATE-RADIUS-POD-IMAGE: 0.2.35 rehearsal receipt digest decides the next remeasurement plan', () => {
  const rehearsal = [podShard(DIGEST_035), podShard(DIGEST_035)];
  const rematch = planPartialRegate({ ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'], priorShards: rehearsal, currentShards: rehearsal });
  expect(rematch).toMatchObject({ ok: true, plan: { version: '0.2.35', shardImageDigests: [DIGEST_035, DIGEST_035] } });
  expect(planPartialRegate({
    ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'],
    priorShards: rehearsal, currentShards: [podShard(DIGEST_NEXT), podShard(DIGEST_NEXT)],
  })).toEqual({ ok: false, reason: 'executed-pod-image-digest-mismatch' });
  expect(planPartialRegate({
    ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'],
    priorShards: rehearsal, currentShards: [podShard(DIGEST_035), podShard()],
  })).toEqual({ ok: false, reason: 'executed-pod-image-digest-missing' });
  const root = mkdtempSync(join(tmpdir(), 'gate-partial-035-receipt-'));
  try {
    const cut = join(root, 'release', '0.2.35', 'gate-logs', 'cut');
    mkdirSync(cut, { recursive: true });
    const row = (n: number, imageDigest?: string) =>
      writeFileSync(join(cut, `pod-${n}.json`), JSON.stringify({ commit: P, files: [`src/${n}.test.ts`], shardCount: 2, sweepId: 'sweep-035',
        attemptId: `attempt-${n}`, ...(imageDigest ? { imageDigest } : {}) }));
    row(0, DIGEST_035);
    row(1, DIGEST_035);
    writeFileSync(join(cut, 'pod-0-retry.json'), JSON.stringify({ commit: P, image: `registry.local/elanous:0.2.35`, imageDigest: DIGEST_035 }));
    expect(collectedShardImages(cut, P)).toEqual([{ imageDigest: DIGEST_035 }, { imageDigest: DIGEST_035 }, { imageDigest: DIGEST_035 }]);
    const fromLogs = planPartialRegate({ ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'], priorCutLogs: cut });
    expect(fromLogs).toMatchObject({ ok: true, plan: { version: '0.2.35', shardImageDigests: [DIGEST_035, DIGEST_035, DIGEST_035] } });
    if (!fromLogs.ok) return;
    writePartialPlan(root, fromLogs.plan);
    expect(readPartialPlanResult([root], '0.2.35', N)).toEqual({ plan: fromLogs.plan, fallbackReason: null });
    writeFileSync(join(cut, 'pod-0-retry.json'), JSON.stringify({ commit: P, imageDigest: DIGEST_NEXT }));
    expect(planPartialRegate({ ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'], priorCutLogs: cut }))
      .toEqual({ ok: false, reason: 'executed-pod-image-digest-mismatch' });
    writeFileSync(join(cut, 'pod-0-retry.json'), JSON.stringify({ commit: P, imageDigest: DIGEST_035 }));
    row(1, DIGEST_NEXT);
    expect(planPartialRegate({ ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'], priorCutLogs: cut }))
      .toEqual({ ok: false, reason: 'executed-pod-image-digest-mismatch' });
    row(1);
    expect(planPartialRegate({ ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'], priorCutLogs: cut }))
      .toEqual({ ok: false, reason: 'executed-pod-image-digest-missing' });
    row(1, `registry.local/elanous@${DIGEST_035}`);
    expect(planPartialRegate({ ...base, version: '0.2.35', changedFiles: ['src/x.test.ts'], priorCutLogs: cut }))
      .toEqual({ ok: false, reason: 'executed-pod-image-digest-missing' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
