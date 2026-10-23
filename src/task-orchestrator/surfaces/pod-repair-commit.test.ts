import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordHarnessWorktreeProvenance } from '../../harness/harness-worktree-add.js';
import { REPAIR_REF, readPodRepairArtifact, writePodRepairCommit } from './pod-repair-commit.js';
import { GATE_ENV_DEFICIT_HARVESTABLE_MARK } from '../../self-implement/gate-env-retry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pod-repair-'));
  roots.push(root);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Pod test');
  git(repo, 'config', 'user.email', 'pod@example.test');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const baseHead = git(repo, 'rev-parse', 'HEAD');
  const worktree = join(root, 'worktree');
  git(repo, 'worktree', 'add', '-qb', 'repair', worktree);
  recordHarnessWorktreeProvenance(worktree, { owner: 'dev:run-child', command: 'elanous dev', createdAt: new Date().toISOString() });
  return { root, repo, worktree, baseHead };
}

test('repair commits in the child worktree and returns a verifiable bundle on the pinned PR head', () => {
  const f = fixture();
  writeFileSync(join(f.worktree, 'file.txt'), 'repaired\n');
  const outbox = join(f.root, 'outbox');
  const result = writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo, outbox,
    output: JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.worktree }) });
  expect(result.commit).not.toBe(f.baseHead);
  expect(result.baseHead).toBe(f.baseHead);
  const bundle = join(outbox, 'repair', 'commit.bundle');
  expect(JSON.parse(readFileSync(join(outbox, 'repair', 'result.json'), 'utf8'))).toEqual(result);
  expect(readPodRepairArtifact(join(outbox, 'repair'), { pr: 42, baseHead: f.baseHead, runId: 'run-parent' })).toEqual(result);
  expect(() => readPodRepairArtifact(join(outbox, 'repair'), { pr: 42, baseHead: f.baseHead, runId: 'other-run' })).toThrow('repair result mismatch');
  expect(git(f.worktree, 'rev-parse', REPAIR_REF)).toBe(result.commit);
  const receiver = join(f.root, 'receiver');
  execFileSync('git', ['clone', '-q', f.repo, receiver]);
  git(receiver, 'bundle', 'verify', bundle);
  git(receiver, 'fetch', bundle, REPAIR_REF);
  expect(git(receiver, 'rev-parse', 'FETCH_HEAD')).toBe(result.commit);
  expect(git(receiver, 'merge-base', result.commit, f.baseHead)).toBe(f.baseHead);
  writeFileSync(bundle, 'truncated');
  expect(() => readPodRepairArtifact(join(outbox, 'repair'), { pr: 42, baseHead: f.baseHead, runId: 'run-parent' })).toThrow('checksum mismatch');
});

test('repair refuses a worktree owned by a different child run before staging its files', () => {
  const f = fixture();
  git(f.worktree, 'config', '--worktree', 'elanous.harness.owner', 'dev:other-child');
  writeFileSync(join(f.worktree, 'file.txt'), 'other child change\n');
  expect(() => writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo, outbox: join(f.root, 'outbox'),
    output: JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.worktree }) }))
    .toThrow('not owned by the completed child run');
  expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('');
});

test('repair refuses a stale source head and a result without successful worktree completion', () => {
  const f = fixture();
  const stale = '0'.repeat(40);
  expect(() => writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: stale, repo: f.repo, outbox: join(f.root, 'outbox'),
    output: JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.worktree }) })).toThrow('source head changed');
  expect(() => writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo, outbox: join(f.root, 'outbox'),
    output: JSON.stringify({ ok: true, stage: 'pr-opened', runId: 'run-child', worktreePath: f.worktree }) })).toThrow('neither successful worktree-only nor environment-deficit harvestable');
});

test('environment-deficit harvest exports a pinned repair bundle after child exit 1; other gate failures cannot', () => {
  const f = fixture();
  writeFileSync(join(f.worktree, 'file.txt'), 'implementation kept for rejudge\n');
  const base = { ok: false, stage: 'gate-failed', runId: 'run-child', worktreePath: f.worktree, harvestable: true,
    gate: { passed: false, reflectGateFacts: { introduced: 0, childResponsibility: 'none', unknownReason: 'infrastructure-failure' } } };
  const outbox = join(f.root, 'outbox');
  const request = { runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo, outbox };
  expect(() => writePodRepairCommit({ ...request, output: JSON.stringify({ ...base, detail: 'introduced test failure' }) }))
    .toThrow('neither successful worktree-only nor environment-deficit harvestable');
  expect(() => writePodRepairCommit({ ...request, output: JSON.stringify({ ...base,
    gate: { passed: false, reflectGateFacts: { introduced: 1, childResponsibility: 'none', unknownReason: 'infrastructure-failure' } },
    detail: GATE_ENV_DEFICIT_HARVESTABLE_MARK }) })).toThrow('neither successful worktree-only nor environment-deficit harvestable');
  expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('');
  const result = writePodRepairCommit({ ...request,
    output: JSON.stringify({ ...base, detail: `gate failed after retry; ${GATE_ENV_DEFICIT_HARVESTABLE_MARK} — implementation kept` }) });
  expect(result.commit).not.toBe(f.baseHead);
  expect(readPodRepairArtifact(join(outbox, 'repair'), { pr: 42, baseHead: f.baseHead, runId: 'run-parent' })).toEqual(result);
});

test('repair rejects a child result that points at the original Pod checkout', () => {
  const f = fixture();
  expect(() => writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo, outbox: join(f.root, 'outbox'),
    output: JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.repo }) })).toThrow('separate worktree');
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseHead);
});

test('repair rejects a final failure even when an earlier JSON line reported success', () => {
  const f = fixture();
  const output = [JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.worktree }),
    JSON.stringify({ ok: false, stage: 'failed', reason: 'child gate failed' })].join('\n');
  expect(() => writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo,
    outbox: join(f.root, 'outbox'), output })).toThrow('final result is neither successful worktree-only nor environment-deficit harvestable');
  expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.baseHead);
  const untypedError = [JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.worktree }),
    JSON.stringify({ error: 'child gate failed' })].join('\n');
  expect(() => writePodRepairCommit({ runId: 'run-parent', pr: 42, baseHead: f.baseHead, repo: f.repo,
    outbox: join(f.root, 'outbox'), output: untypedError })).toThrow('final result is neither successful worktree-only nor environment-deficit harvestable');
});

test('installed CLI exports a repair bundle while the old PR checkout has no exporter source', () => {
  const f = fixture();
  expect(existsSync(join(f.repo, 'src/task-orchestrator/surfaces/pod-repair-commit.ts'))).toBe(false);
  writeFileSync(join(f.worktree, 'file.txt'), 'repaired from old PR\n');
  const outputPath = join(f.root, 'si.out');
  writeFileSync(outputPath, JSON.stringify({ ok: true, stage: 'worktree-completed', runId: 'run-child', worktreePath: f.worktree }) + '\n');
  const entry = new URL('../../../bin/elanous.mjs', import.meta.url).pathname;
  const outbox = join(f.root, 'outbox');
  const run = spawnSync(process.execPath, [entry, '--test', 'self', 'repair-commit-export', '42', f.baseHead, outputPath, f.repo, outbox],
    { cwd: f.repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELANOUS_PARENT_RUN_ID: 'run-parent' } });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('ELANOUS_POD_REPAIR_COMMIT');
  expect(readPodRepairArtifact(join(outbox, 'repair'), { pr: 42, baseHead: f.baseHead, runId: 'run-parent' }).commit).not.toBe(f.baseHead);
});
