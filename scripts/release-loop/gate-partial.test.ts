import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedFilesBetween, mergePartialFailures, partialPlanPath, planPartialRegate, readPartialPlan, writePartialPlan, testFileOfId } from './gate-partial';

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
