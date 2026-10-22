import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPartialPlan, partialPlanPath, planPartialRegate, planSameCommitRecheck, planStalledShardRecheck, readPartialPlan,
  readPartialPlanResult, recheckPlanPath, writePartialPlan, writeRecheckPlan } from './gate-partial';
import { existsTestFileAtCommit } from './gate-recheck-plan-node';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const input = { version: '0.2.30', measuredCommit: SHA, forCommit: SHA,
  failures: ['src/b.test.ts > second', 'src/a.test.ts > first', 'src/b.test.ts > third'],
  errors: ['src/a.test.ts > errored'], existsAtCommit: () => true };

test('G1 recheck selects only failed files, once each, on the same commit', () => {
  const result = planSameCommitRecheck(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.files).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  expect(result.plan).toMatchObject({ kind: 'recheck', priorCommit: SHA, forCommit: SHA,
    priorFailures: input.failures, priorErrors: input.errors });
  // The different-commit partial plan keeps its original invariant.
  expect(planPartialRegate({ version: input.version, priorCommit: SHA, forCommit: SHA,
    changedFiles: ['src/a.test.ts'], priorFailures: input.failures, priorErrors: input.errors }).ok).toBe(false);
});

test('G1 recheck refuses another commit, absent failures, unsafe ids, and missing files', () => {
  expect(planSameCommitRecheck({ ...input, forCommit: OTHER })).toMatchObject({ ok: false, reason: expect.stringContaining('same commit') });
  expect(planSameCommitRecheck({ ...input, failures: [], errors: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('no failed') });
  expect(planSameCommitRecheck({ ...input, failures: ['src/../x.test.ts > fail'], errors: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('unsafe') });
  expect(planSameCommitRecheck({ ...input, existsAtCommit: () => false })).toMatchObject({ ok: false, reason: expect.stringContaining('missing') });
  expect(planSameCommitRecheck({ ...input, existsAtCommit: () => { throw new Error('unavailable'); } })).toMatchObject({ ok: false, reason: expect.stringContaining('unreadable') });
});

test('G1 recheck shares the partial-plan slot, is consumed only on its commit, and rejects tampering as an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-recheck-'));
  try {
    const result = planSameCommitRecheck(input);
    if (!result.ok) throw new Error(result.reason);
    const path = writeRecheckPlan(root, result.plan);
    expect(path).toBe(recheckPlanPath(root, input.version));
    expect(path).toBe(partialPlanPath(root, input.version));
    expect(readFileSync(path, 'utf8')).toContain('src/a.test.ts');
    // The legacy G1 plan is valid but not a stalled-shard plan; keep its existing full-gate behavior.
    expect(readPartialPlan([root], input.version, SHA)).toBeNull();
    expect(readPartialPlanResult([root], input.version, SHA)).toMatchObject({ plan: null, fallbackReason: 'recheck-not-stalled-only' });
    expect(readPartialPlan([root], input.version, OTHER)).toBeNull();
    expect(readPartialPlanResult([root], input.version, OTHER)).toMatchObject({ plan: null, fallbackReason: 'plan-commit-mismatch' });
    for (const bad of [
      null,
      { ...result.plan, forCommit: OTHER },
      { ...result.plan, files: ['src/a.test.ts'] },
      { ...result.plan, files: ['src/a.test.ts', 'src/b.test.ts', 'src/passing.test.ts'] },
      { ...result.plan, priorFailures: ['../../x.test.ts > case'] },
    ]) {
      writeFileSync(path, JSON.stringify(bad));
      expect(() => readPartialPlan([root], input.version, SHA)).toThrow(/invalid gate (?:partial|recheck) plan/);
      expect(() => readPartialPlanResult([root], input.version, SHA)).toThrow(/invalid gate (?:partial|recheck) plan/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('G1 stalled recheck reruns only incomplete-shard files and carries completed failures and errors', () => {
  const result = planStalledShardRecheck({ version: input.version, measuredCommit: SHA, forCommit: SHA,
    failures: ['src/done.test.ts > known fail'], errors: ['src/error.test.ts > [error]'],
    stalledFiles: ['src/stalled.test.ts'], preservedShardCount: 4, existsAtCommit: () => true });
  expect(result).toMatchObject({ ok: true, plan: { kind: 'recheck', files: ['src/stalled.test.ts'], preservedShardCount: 4,
    stalledFiles: ['src/stalled.test.ts'], priorFailures: ['src/done.test.ts > known fail'], priorErrors: ['src/error.test.ts > [error]'] } });
  if (!result.ok) return;
  const root = mkdtempSync(join(tmpdir(), 'gate-stalled-recheck-'));
  try {
    writeRecheckPlan(root, result.plan);
    expect(readPartialPlan([root], input.version, SHA)).toMatchObject({ files: result.plan.files, priorFailures: result.plan.priorFailures });
    expect(readPartialPlan([root], input.version, OTHER)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('G1 stalled recheck refuses to remeasure any file already measured by a completed shard', () => {
  expect(planStalledShardRecheck({ version: input.version, measuredCommit: SHA, forCommit: SHA,
    failures: ['src/stalled.test.ts > introduced'], errors: [], stalledFiles: ['src/stalled.test.ts'],
    existsAtCommit: () => true })).toMatchObject({ ok: false, reason: expect.stringContaining('overlaps') });
});

test('G1 refuses to overwrite an active changed-commit partial plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-recheck-partial-'));
  try {
    const result = planSameCommitRecheck(input);
    if (!result.ok) throw new Error(result.reason);
    const path = recheckPlanPath(root, input.version);
    writeRecheckPlan(root, result.plan);
    writeFileSync(path, JSON.stringify({ version: input.version, priorCommit: OTHER, forCommit: SHA,
      files: ['src/a.test.ts'], priorFailures: [], priorErrors: [] }));
    expect(() => writeRecheckPlan(root, result.plan)).toThrow('partial plan already exists');
    expect(readPartialPlan([root], input.version, SHA)).toMatchObject({ forCommit: SHA, priorCommit: OTHER });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('G1 refuses to overwrite a recheck plan for another commit of the same version', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-recheck-commit-'));
  try {
    const first = planSameCommitRecheck(input);
    const next = planSameCommitRecheck({ ...input, measuredCommit: OTHER, forCommit: OTHER });
    if (!first.ok || !next.ok) throw new Error('test recheck plan invalid');
    const path = writeRecheckPlan(root, first.plan);
    const saved = readFileSync(path, 'utf8');
    expect(() => writeRecheckPlan(root, next.plan)).toThrow('another commit');
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(writeRecheckPlan(root, first.plan)).toBe(path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('G1 and changed-commit partial writers cannot clobber each other in the shared slot', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-recheck-writers-'));
  try {
    const recheck = planSameCommitRecheck(input);
    if (!recheck.ok) throw new Error(recheck.reason);
    const partial = { version: input.version, priorCommit: OTHER, forCommit: SHA,
      files: ['src/a.test.ts'], priorFailures: [], priorErrors: [] };
    const path = writeRecheckPlan(root, recheck.plan);
    const saved = readFileSync(path, 'utf8');
    expect(() => writePartialPlan(root, partial)).toThrow('recheck plan already exists');
    expect(readFileSync(path, 'utf8')).toBe(saved);
    clearPartialPlan(root, input.version);
    writePartialPlan(root, partial);
    const savedPartial = readFileSync(path, 'utf8');
    expect(() => writeRecheckPlan(root, recheck.plan)).toThrow('partial plan already exists');
    expect(readFileSync(path, 'utf8')).toBe(savedPartial);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('G1 Git entry accepts blobs and refuses a .test.ts tree at the measured commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-recheck-git-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    mkdirSync(join(repo, 'src', 'folder.test.ts'), { recursive: true });
    writeFileSync(join(repo, 'src', 'file.test.ts'), 'test("ok", () => {});\n');
    writeFileSync(join(repo, 'src', 'folder.test.ts', 'inside.txt'), 'tree marker\n');
    git('add', 'src');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    expect(existsTestFileAtCommit(repo, commit, 'src/file.test.ts')).toBe(true);
    expect(existsTestFileAtCommit(repo, commit, 'src/folder.test.ts')).toBe(false);
    expect(existsTestFileAtCommit(repo, commit, 'src/missing.test.ts')).toBe(false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
