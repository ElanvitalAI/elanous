import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gateArtifactCounts, runSelfGateCli } from './gate-cli.js';
import {
  fetchRemoteGateArtifacts, newRemoteArtifactDir, parseRemoteArtifactFetch, remoteArtifactCleanupScript, remoteArtifactFetchScript,
  remoteCommitSupportsArtifactDir, writeRemoteUnavailableGateArtifacts, type RemoteSsh,
} from './gate-artifacts.js';
import { runShardedGateTests, type ShardRunResult } from '../self-dev/shard-run.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ENV = 'host-x|bun r1|darwin-arm64';
const roots: string[] = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'elanous-gate-artifacts-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const quietGates = {
  runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0, runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
  runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
};
const artifactDeps = { resolveRev: (ref: string) => (ref === 'HEAD' ? HEAD : ref === 'origin/main' ? BASE : null), envKey: () => ENV };

const files = ['src/z.test.ts', 'src/a.test.ts', 'src/m.test.ts'];
const sharded: ShardRunResult = {
  shards: [
    { id: 'shard-1', files: ['src/z.test.ts', 'src/a.test.ts'], plannedRssMb: 10, plannedSeconds: 1 },
    { id: 'shard-2', files: ['src/m.test.ts'], plannedRssMb: 10, plannedSeconds: 1 },
  ],
  attempts: [
    { shardId: 'shard-1', attempt: 1, currentJUnit: '<testsuite name="cur-1"/>', baselineJUnit: '<testsuite name="base-1"/>',
      currentExitCode: 0, baselineExitCode: 0, baselineFiles: ['src/z.test.ts'] },
    { shardId: 'shard-2', attempt: 1, baselineJUnit: '<testsuite name="base-2"/>', currentExitCode: 2, baselineExitCode: 0,
      currentDiagnostic: 'stderr: bootstrap error' },
  ],
  aggregate: { status: 'unmeasured', retryShardIds: ['shard-2'] },
  unmeasuredByShard: { 'shard-2': 'current: exit 2; stderr: bootstrap error' },
};

function runSharded(artifactDir?: string) {
  return runSelfGateCli('/repo', { base: 'origin/main', shards: 2, ...(artifactDir ? { artifactDir } : {}) }, {
    changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
    runShards: () => sharded, ...quietGates, ...artifactDeps,
  });
}

describe('self gate --artifact-dir (R2 입력 재료)', () => {
  test('baseline setup failure with zero attempts preserves the cause for every planned shard', () => {
    const dir = join(tmp(), 'out');
    let measurements = 0;
    const failingBaseline = () => ({
      status: 'unknown' as const, unknownReason: 'infrastructure-failure' as const,
      childResponsibility: 'none' as const, log: 'baseline setup failed:\nENOSPC in /tmp',
    });
    const result = runSelfGateCli('/repo', { base: 'origin/main', shards: 2, artifactDir: dir }, {
      changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
      runShards: (cwd, selected, base, count) => runShardedGateTests(cwd, selected, base, count,
        (_location, measuredFiles) => {
          measurements++;
          expect(measuredFiles).toHaveLength(1);
          return { exitCode: 0, junit: '<testsuite/>', rssMb: 100, seconds: 1 };
        }, failingBaseline as typeof import('./gate-baseline.js').withBaselineWorktree,
        8, { hostResources: { cores: 8, freeMemoryGiB: 64, freeTmpGiB: 8 } }),
      ...quietGates, ...artifactDeps,
    });
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(measurements).toBe(files.length);
    expect(summary).toMatchObject({
      verdict: 'unmeasured', shards: 2, shardsDetail: [],
      unmeasuredReason: 'baseline setup failed: ENOSPC in /tmp',
      unmeasuredByShard: {
        'shard-1': 'baseline worktree: baseline setup failed: ENOSPC in /tmp',
        'shard-2': 'baseline worktree: baseline setup failed: ENOSPC in /tmp',
      },
    });
    expect(result.lines).toContain('shards: unmeasured (baseline setup failed: ENOSPC in /tmp)');
    expect(result.lines).toContain('shard unmeasured: shard-1 · baseline worktree: baseline setup failed: ENOSPC in /tmp');
  });

  test('writes summary.json and per-shard current/baseline JUnit; a side without JUnit gets no junitPath, only a diagnostic', () => {
    const dir = join(tmp(), 'out');
    const result = runSharded(dir);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({
      head40: HEAD, base40: BASE, envKey: ENV, shards: 2,
      cohort: ['src/a.test.ts', 'src/m.test.ts', 'src/z.test.ts'],
      verdict: 'unmeasured', unmeasuredReason: 'shard-2', verdictLine: 'shards: unmeasured (shard-2)', exitCode: 1,
      unmeasuredByShard: { 'shard-2': 'current: exit 2; stderr: bootstrap error' },
    });
    expect(summary.artifactsUnavailable).toBeUndefined();
    const [s1, s2] = summary.shardsDetail;
    expect(s1).toEqual({
      shardId: 'shard-1', attempt: 1, files: ['src/a.test.ts', 'src/z.test.ts'],
      current: { runId: 'shard-1-1-current', head40: HEAD, envKey: ENV, cohort: ['src/a.test.ts', 'src/z.test.ts'], rc: 0, signal: null,
        resultPath: join(dir, 'shard-1-1-current.result.json'), junitPath: join(dir, 'shard-1-1-current.xml') },
      baseline: { runId: 'shard-1-1-baseline', head40: BASE, envKey: ENV, cohort: ['src/z.test.ts'], rc: 0, signal: null,
        resultPath: join(dir, 'shard-1-1-baseline.result.json'), junitPath: join(dir, 'shard-1-1-baseline.xml') },
    });
    expect(s2.current.junitPath).toBeUndefined();
    expect(s2.unmeasuredReason).toBe('current: exit 2; stderr: bootstrap error');
    expect('junitPath' in s2.current).toBe(false);
    expect(s2.current).toMatchObject({ rc: 2, diagnostic: 'stderr: bootstrap error' });
    expect(s2.baseline.junitPath).toBe(join(dir, 'shard-2-1-baseline.xml'));
    expect(s2.baseline.cohort).toBeNull();
    expect(readFileSync(join(dir, 'shard-1-1-current.xml'), 'utf8')).toBe('<testsuite name="cur-1"/>');
    expect(readFileSync(join(dir, 'shard-1-1-baseline.xml'), 'utf8')).toBe('<testsuite name="base-1"/>');
    expect(readFileSync(join(dir, 'shard-2-1-baseline.xml'), 'utf8')).toBe('<testsuite name="base-2"/>');
    expect(existsSync(join(dir, 'shard-2-1-current.xml'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([
      'shard-1-1-baseline.result.json', 'shard-1-1-baseline.xml', 'shard-1-1-current.result.json', 'shard-1-1-current.xml',
      'shard-2-1-baseline.result.json', 'shard-2-1-baseline.xml', 'shard-2-1-current.result.json', 'summary.json']);
    expect(result.lines.at(-1)).toBe(`artifacts: ${join(dir, 'summary.json')} (junit 3)`);
  });

  test('each shard/attempt/side gets its own result file — the summary run and the file agree; four distinct result paths, none is summary.json', () => {
    const dir = join(tmp(), 'out');
    runSharded(dir);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    const readResult = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
    expect(readResult('shard-1-1-current.result.json')).toEqual({
      runId: 'shard-1-1-current', head40: HEAD, envKey: ENV, cohort: ['src/a.test.ts', 'src/z.test.ts'], rc: 0, signal: null,
      junitPath: join(dir, 'shard-1-1-current.xml'), resultPath: join(dir, 'shard-1-1-current.result.json'),
    });
    expect(readResult('shard-2-1-baseline.result.json')).toEqual({
      runId: 'shard-2-1-baseline', head40: BASE, envKey: ENV, cohort: null, rc: 0, signal: null,
      junitPath: join(dir, 'shard-2-1-baseline.xml'), resultPath: join(dir, 'shard-2-1-baseline.result.json'),
    });
    // JUnit 없는 쪽: junitPath 를 지어내지 않고 diagnostic 만.
    const noJunit = readResult('shard-2-1-current.result.json');
    expect(noJunit).toEqual({
      runId: 'shard-2-1-current', head40: HEAD, envKey: ENV, cohort: ['src/m.test.ts'], rc: 2, signal: null,
      diagnostic: 'stderr: bootstrap error', resultPath: join(dir, 'shard-2-1-current.result.json'),
    });
    expect('junitPath' in noJunit).toBe(false);
    const runs = summary.shardsDetail.flatMap((shard: { current: unknown; baseline: unknown }) => [shard.current, shard.baseline]);
    for (const run of runs) expect(readResult(`${run.runId}.result.json`)).toEqual(run);
    expect(new Set(runs.map((run: { resultPath: string }) => run.resultPath)).size).toBe(4);
    expect(runs.some((run: { resultPath: string }) => run.resultPath === join(dir, 'summary.json'))).toBe(false);
  });

  test('without the option nothing is written and the verdict, exit code and lines are unchanged', () => {
    const dir = join(tmp(), 'out');
    const plain = runSharded();
    expect(existsSync(dir)).toBe(false);
    const withArtifacts = runSharded(dir);
    expect(withArtifacts.exitCode).toBe(plain.exitCode);
    expect(withArtifacts.lines.slice(0, -1)).toEqual(plain.lines);
    expect(withArtifacts.baseline).toEqual(plain.baseline);
  });

  test('the unsharded path names why there is no JUnit instead of leaving it silently empty', () => {
    const dir = join(tmp(), 'out');
    const result = runSelfGateCli('/repo', { base: 'origin/main', artifactDir: dir }, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'origin/main' }), exists: () => true,
      runTests: () => ({ status: 0, stdout: '', stderr: '' }), ...quietGates, ...artifactDeps,
    });
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ shards: 0, shardsDetail: [], cohort: ['src/a.test.ts'], verdict: 'passed',
      verdictLine: 'tests: pass (1 files)', unshardedRc: 0, artifactsUnavailable: 'unsharded', exitCode: result.exitCode });
  });

  test('an empty --artifact-dir is not silently ignored — one warning line, verdict unchanged, nothing written', () => {
    const plain = runSharded();
    const empty = runSelfGateCli('/repo', { base: 'origin/main', shards: 2, artifactDir: '  ' }, {
      changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
      runShards: () => sharded, ...quietGates, ...artifactDeps,
    });
    expect(empty.exitCode).toBe(plain.exitCode);
    expect(empty.lines.slice(0, -1)).toEqual(plain.lines);
    expect(empty.lines.at(-1)).toBe('⚠ artifacts: --artifact-dir 가 빈 경로라 안 썼다 (판정은 그대로다)');
  });

  test('a skipped test step is recorded as no-tests', () => {
    const dir = join(tmp(), 'out');
    runSelfGateCli('/repo', { artifactDir: dir }, {
      changedFiles: () => ({ files: ['docs/x.md'], baseRef: 'HEAD' }), exists: () => false, ...quietGates, ...artifactDeps,
    });
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ head40: HEAD, base40: HEAD, verdict: 'skipped', artifactsUnavailable: 'no-tests', cohort: [], shardsDetail: [] });
  });

  test('a write failure is one warning line — the verdict and exit code stay', () => {
    const blocker = join(tmp(), 'file');
    writeFileSync(blocker, 'x');
    const plain = runSharded();
    const failed = runSharded(join(blocker, 'out'));
    expect(failed.exitCode).toBe(plain.exitCode);
    expect(failed.lines.slice(0, -1)).toEqual(plain.lines);
    expect(failed.lines.at(-1)).toStartWith('⚠ artifacts: ');
  });

  test.each(['remote-unsupported', 'remote-fetch-failed'] as const)('remote without fetched artifacts writes an honest summary: %s', (reason) => {
    const dir = join(tmp(), 'out');
    writeRemoteUnavailableGateArtifacts(dir, '/repo', 'origin/main', 1, reason, artifactDeps.resolveRev, artifactDeps.envKey);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ head40: HEAD, base40: BASE, envKey: ENV, shardsDetail: [], verdict: null, exitCode: 1, artifactsUnavailable: reason });
    expect(readdirSync(dir)).toEqual(['summary.json']);
  });

  test('re-using a directory removes only the JUnit the previous summary recorded — unrelated files stay', () => {
    const dir = join(tmp(), 'out');
    runSharded(dir);
    expect(existsSync(join(dir, 'shard-1-1-current.xml'))).toBe(true);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'custom-1-current.xml'), 'keep');
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    runSelfGateCli('/repo', { base: 'origin/main', shards: 2, artifactDir: dir }, {
      changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
      runShards: () => ({ ...sharded, attempts: [sharded.attempts[1]!] }), ...quietGates, ...artifactDeps,
    });
    expect(existsSync(join(dir, 'shard-1-1-current.xml'))).toBe(false);
    expect(existsSync(join(dir, 'shard-1-1-baseline.xml'))).toBe(false);
    expect(readFileSync(join(dir, 'custom-1-current.xml'), 'utf8')).toBe('keep');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'shard-1-1-current.result.json'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['custom-1-current.xml', 'notes.txt', 'shard-2-1-baseline.result.json', 'shard-2-1-baseline.xml',
      'shard-2-1-current.result.json', 'summary.json']);
  });

  test('a trailing slash on --artifact-dir still clears the previous run\'s JUnit and result files', () => {
    const dir = join(tmp(), 'out');
    runSharded(`${dir}/`);
    expect(existsSync(join(dir, 'shard-1-1-current.result.json'))).toBe(true);
    runSelfGateCli('/repo', { base: 'origin/main', shards: 2, artifactDir: `${dir}/` }, {
      changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
      runShards: () => ({ ...sharded, attempts: [sharded.attempts[1]!] }), ...quietGates, ...artifactDeps,
    });
    expect(readdirSync(dir).sort()).toEqual(['shard-2-1-baseline.result.json', 'shard-2-1-baseline.xml', 'shard-2-1-current.result.json', 'summary.json']);
  });

  test('a previous summary whose resultPath points at a non-result file does not delete it', () => {
    const dir = join(tmp(), 'out');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ shardsDetail: [
      { current: { runId: 'shard-9-1-current', resultPath: join(dir, 'notes.txt') }, baseline: { resultPath: join(dir, 'notes.txt') } },
    ] }));
    runSharded(dir);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep');
  });

  test('the real CLI still refuses an empty --artifact-dir (exit 2) before dispatching anywhere — even with --remote', () => {
    const repo = resolve(import.meta.dir, '../..');
    const run = spawnSync('bun', ['bin/elanous.mjs', 'self', 'gate', '--changed', '--artifact-dir', ' ', '--remote', 'node-c'],
      { cwd: repo, encoding: 'utf8', timeout: 120_000 });
    expect(run.status).toBe(2);
    expect(`${run.stdout}${run.stderr}`).toContain('--artifact-dir needs a non-empty directory');
    expect(`${run.stdout}${run.stderr}`).not.toContain('cannot be combined with --remote');
  }, 120_000);
});

// ── SIDE-VERIFY ③ — summary 판정 정수(OPT 열차 영수증) ─────────────────────────
const zeroReport = {
  introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, missingAtBase: 0, timedOut: 0, timeoutPassedAtBase: 0,
  flakyRerun: 0, rerunNotRun: 0, mayVaryNonTimeout: 0, rerunAttempted: 0, rerunRecovered: 0,
  timeoutVariabilityCounts: { mayVary: 0, same: 0, unknown: 0 }, worktreeFailuresParsed: true,
  failures: [], files: [], baselineStatus: 'pass' as const, log: 'shard baseline JUnit complete',
};
const readSummary = (dir: string) => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const countsOf = (summary: Record<string, unknown>): Record<string, unknown> => ({
  introduced: summary.introduced, preexisting: summary.preexisting, unknown: summary.unknown,
  preconditionUnmet: summary.preconditionUnmet, unrunImporters: summary.unrunImporters,
});

describe('self gate --artifact-dir · 판정 정수 칸 (SIDE-VERIFY ③)', () => {
  test('sharded path with a report (shardBaseline): the counts are the gate\'s own numbers, no unavailable reason', () => {
    const dir = join(tmp(), 'out');
    const result = runSelfGateCli('/repo', { base: 'origin/main', shards: 2, artifactDir: dir }, {
      changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
      runShards: () => ({ ...sharded, aggregate: { status: 'failed', retryShardIds: [], report: { ...zeroReport, introduced: 1, preexisting: 2, unknown: 3, preconditionUnmet: 4 } } }),
      ...quietGates, ...artifactDeps,
    });
    const summary = readSummary(dir);
    expect(result.baseline).toEqual({ introduced: 1, preexisting: 2, unknown: 3, preconditionUnmet: 4 });
    expect(countsOf(summary)).toEqual({ introduced: 1, preexisting: 2, unknown: 3, preconditionUnmet: 4, unrunImporters: 0 });
    expect('countsUnavailableReason' in summary).toBe(false);
    expect(summary).toMatchObject({ verdict: 'failed', exitCode: 1 });
  });

  test('sharded path that passed without a report writes zeros — measured zero, not unknown', () => {
    const dir = join(tmp(), 'out');
    runSelfGateCli('/repo', { base: 'origin/main', shards: 2, artifactDir: dir }, {
      changedFiles: () => ({ files, baseRef: 'origin/main' }), exists: () => true,
      runShards: () => ({ ...sharded, aggregate: { status: 'passed', retryShardIds: [] } }), ...quietGates, ...artifactDeps,
    });
    const summary = readSummary(dir);
    expect(countsOf(summary)).toEqual({ introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 0 });
    expect(summary.countsUnavailableReason).toBeUndefined();
  });

  test('unmeasured (uncomputed) shards write null — never 0 — and say why in one field', () => {
    const dir = join(tmp(), 'out');
    const result = runSharded(dir);
    const summary = readSummary(dir);
    expect(result.baseline).toBeUndefined();
    expect(countsOf(summary)).toEqual({ introduced: null, preexisting: null, unknown: null, preconditionUnmet: null, unrunImporters: 0 });
    expect(summary.countsUnavailableReason).toBe('shards unmeasured (shard-2)');
    for (const key of ['introduced', 'preexisting', 'unknown', 'preconditionUnmet', 'unrunImporters']) expect(key in summary).toBe(true);
  });

  test('baseline (unsharded) path: a failing run carries the baseline report numbers; a passing run carries zeros', () => {
    const failDir = join(tmp(), 'fail');
    const failed = runSelfGateCli('/repo', { base: 'origin/main', artifactDir: failDir }, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'origin/main' }), exists: () => true,
      runTests: () => ({ status: 1, stdout: '', stderr: 'src/a.test.ts:\n(fail) compute [1.00ms]\n\n 0 pass\n 1 fail\nRan 1 tests across 1 files.\n' }),
      runBaseline: () => ({ status: 'pass', output: 'src/a.test.ts:\n(pass) compute\n1 pass\n', log: 'baseline' }),
      ...quietGates, ...artifactDeps,
    });
    expect(failed.baseline).toBeDefined();
    expect(failed.baseline!.introduced + failed.baseline!.unknown).toBeGreaterThan(0);
    const failSummary = readSummary(failDir);
    expect(countsOf(failSummary)).toEqual({ ...failed.baseline, unrunImporters: 0 });
    expect(failSummary).toMatchObject({ verdict: 'failed', exitCode: 1, artifactsUnavailable: 'unsharded' });
    expect(failSummary.countsUnavailableReason).toBeUndefined();

    const passDir = join(tmp(), 'pass');
    runSelfGateCli('/repo', { base: 'origin/main', artifactDir: passDir }, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'origin/main' }), exists: () => true,
      runTests: () => ({ status: 0, stdout: '', stderr: '' }), ...quietGates, ...artifactDeps,
    });
    expect(countsOf(readSummary(passDir))).toEqual({ introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 0 });
  });

  test('a skipped test step writes measured zeros', () => {
    const dir = join(tmp(), 'out');
    runSelfGateCli('/repo', { artifactDir: dir }, {
      changedFiles: () => ({ files: ['docs/x.md'], baseRef: 'HEAD' }), exists: () => false, ...quietGates, ...artifactDeps,
    });
    expect(countsOf(readSummary(dir))).toEqual({ introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 0 });
  });

  test('importer lookup failure: unrunImporters is null with the reason; the other counts stay', () => {
    expect(gateArtifactCounts({ baseline: { introduced: 1, preexisting: 0, unknown: 0, preconditionUnmet: 0 } },
      { unrunImporters: null, importerLookupFailed: 'git grep rc=128' })).toEqual({
      counts: { introduced: 1, preexisting: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: null },
      reason: 'importer lookup failed (git grep rc=128)',
    });
    expect(gateArtifactCounts({}, { unrunImporters: null, unmeasuredReason: 'shard-1' }).reason)
      .toBe('shards unmeasured (shard-1); importer lookup failed');
    expect(gateArtifactCounts({ baseline: { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 } }, { unrunImporters: 3 }))
      .toEqual({ counts: { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 3 } });
  });

  test.each(['remote-unsupported', 'remote-fetch-failed'] as const)('remote without fetched artifacts: every count is null, reason = %s', (reason) => {
    const dir = join(tmp(), 'out');
    writeRemoteUnavailableGateArtifacts(dir, '/repo', 'origin/main', 1, reason, artifactDeps.resolveRev, artifactDeps.envKey);
    const summary = readSummary(dir);
    expect(countsOf(summary)).toEqual({ introduced: null, preexisting: null, unknown: null, preconditionUnmet: null, unrunImporters: null });
    expect(summary.countsUnavailableReason).toBe(reason);
  });

  test('remote fetch keeps the remote summary\'s numbers as they are — only paths are rewritten', () => {
    const remoteDir = newRemoteArtifactDir('fedcba9876543210');
    const local = join(tmp(), 'out');
    const remote = { ...remoteSummary(remoteDir), introduced: 2, preexisting: 5, unknown: null, preconditionUnmet: null, unrunImporters: 7,
      countsUnavailableReason: 'shards unmeasured (shard-2)' };
    const ssh: RemoteSsh = () => ({ rc: 0, stderr: '', stdout: encode({
      'summary.json': JSON.stringify(remote), 'shard-1-1-current.xml': '<x/>', 'shard-1-1-baseline.xml': '<x/>', 'shard-2-1-baseline.xml': '<x/>',
    }) });
    expect(fetchRemoteGateArtifacts({ host: REMOTE_HOST, remoteDir, localDir: local, ssh }).ok).toBe(true);
    const summary = readSummary(local);
    expect(countsOf(summary)).toEqual({ introduced: 2, preexisting: 5, unknown: null, preconditionUnmet: null, unrunImporters: 7 });
    expect(summary.countsUnavailableReason).toBe('shards unmeasured (shard-2)');
  });
});

// ── SIDE-VERIFY-GATE-SHARDS ② — 원격 산출 회수 ──────────────────────────────
const REMOTE_HOST = 'node-c';
const REMOTE_ENV = 'node-c|bun r9|linux-x64';
function remoteSummary(remoteDir: string) {
  return {
    head40: HEAD, base40: BASE, envKey: REMOTE_ENV, shards: 2, cohort: ['src/a.test.ts', 'src/m.test.ts'],
    shardsDetail: [
      { shardId: 'shard-1', attempt: 1, files: ['src/a.test.ts'],
        current: { head40: HEAD, envKey: REMOTE_ENV, cohort: ['src/a.test.ts'], rc: 0, signal: null, resultPath: `${remoteDir}/summary.json`, junitPath: `${remoteDir}/shard-1-1-current.xml` },
        baseline: { head40: BASE, envKey: REMOTE_ENV, cohort: ['src/a.test.ts'], rc: 0, signal: null, resultPath: `${remoteDir}/summary.json`, junitPath: `${remoteDir}/shard-1-1-baseline.xml` } },
      { shardId: 'shard-2', attempt: 1, files: ['src/m.test.ts'],
        current: { head40: HEAD, envKey: REMOTE_ENV, cohort: ['src/m.test.ts'], rc: 2, signal: null, resultPath: `${remoteDir}/summary.json`, diagnostic: 'stderr: boom' },
        baseline: { head40: BASE, envKey: REMOTE_ENV, cohort: null, rc: 0, signal: null, resultPath: `${remoteDir}/summary.json`, junitPath: `${remoteDir}/shard-2-1-baseline.xml` } },
    ],
    verdict: 'unmeasured', exitCode: 1,
  };
}
/** 이 칸 이후 꼴 — run 마다 runId ⊕ 독립 결과 파일. */
function remoteSummaryWithResults(remoteDir: string) {
  const summary = remoteSummary(remoteDir);
  const files: Record<string, string> = {
    'shard-1-1-current.xml': '<testsuite name="cur-1"/>', 'shard-1-1-baseline.xml': '<testsuite name="base-1"/>', 'shard-2-1-baseline.xml': '<x/>',
  };
  for (const shard of summary.shardsDetail) {
    for (const [side, run] of [['current', shard.current], ['baseline', shard.baseline]] as const) {
      const runId = `${shard.shardId}-${shard.attempt}-${side}`;
      Object.assign(run, { runId, resultPath: `${remoteDir}/${runId}.result.json` });
      files[`${runId}.result.json`] = JSON.stringify(run);
    }
  }
  return { summary, files };
}
const encode = (files: Record<string, string>, end = true) =>
  `${Object.entries(files).map(([name, body]) => `${name}\n${Buffer.from(body).toString('base64')}\n`).join('')}${end ? '__GATE_ARTIFACTS_END__\n' : ''}`;

describe('self gate --artifact-dir · 원격 산출 회수', () => {
  test('fetch success: files land locally, junitPath/resultPath point at the local dir, head40/envKey stay remote, remoteHost recorded', () => {
    const remoteDir = newRemoteArtifactDir('0123456789abcdef');
    const local = join(tmp(), 'out');
    const scripts: string[] = [];
    const ssh: RemoteSsh = (host, script) => {
      scripts.push(`${host}:${script}`);
      return { rc: 0, stderr: '', stdout: encode({
        'summary.json': JSON.stringify(remoteSummary(remoteDir)),
        'shard-1-1-current.xml': '<testsuite name="cur-1"/>',
        'shard-1-1-baseline.xml': '<testsuite name="base-1"/>',
        'shard-2-1-baseline.xml': '<testsuite name="base-2"/>',
      }) };
    };
    const result = fetchRemoteGateArtifacts({ host: REMOTE_HOST, remoteDir, localDir: local, ssh });
    expect(result).toMatchObject({ ok: true, remoteDirKept: false });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toStartWith(`node-c:D='${remoteDir}'`);
    expect(scripts[0]).toContain('rm -rf "$D"');
    const summary = JSON.parse(readFileSync(join(local, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ head40: HEAD, base40: BASE, envKey: REMOTE_ENV, verdict: 'unmeasured', exitCode: 1, remoteHost: REMOTE_HOST });
    const [s1, s2] = summary.shardsDetail;
    expect(s1.current).toMatchObject({ envKey: REMOTE_ENV, junitPath: join(local, 'shard-1-1-current.xml'), resultPath: join(local, 'summary.json') });
    expect(s1.baseline.junitPath).toBe(join(local, 'shard-1-1-baseline.xml'));
    expect(s2.current).toEqual({ head40: HEAD, envKey: REMOTE_ENV, cohort: ['src/m.test.ts'], rc: 2, signal: null, resultPath: join(local, 'summary.json'), diagnostic: 'stderr: boom' });
    expect(s2.baseline.junitPath).toBe(join(local, 'shard-2-1-baseline.xml'));
    expect(readFileSync(join(local, 'shard-1-1-current.xml'), 'utf8')).toBe('<testsuite name="cur-1"/>');
    expect(readdirSync(local).sort()).toEqual(['shard-1-1-baseline.xml', 'shard-1-1-current.xml', 'shard-2-1-baseline.xml', 'summary.json']);
    expect(JSON.stringify(summary)).not.toContain(remoteDir);
  });

  test.each([
    ['ssh failure', { rc: 255, stdout: '', stderr: 'ssh: connect to host node-c: timed out' }, 'ssh rc=255'],
    ['remote dir missing (the remote run never wrote it)', { rc: 3, stdout: '', stderr: '__GATE_ARTIFACTS_MISSING__\n' }, 'remote artifact dir missing'],
    ['output cut before the end marker', { rc: 0, stdout: encode({ 'summary.json': '{}' }, false), stderr: '' }, 'cut or malformed'],
    ['no summary.json came back', { rc: 0, stdout: encode({ 'shard-1-1-current.xml': '<x/>' }), stderr: '' }, 'summary.json missing'],
    ['a JUnit the summary names did not come back', { rc: 0, stderr: '', stdout: encode({
      'summary.json': JSON.stringify(remoteSummary(`/tmp/elanous-gate-artifacts-${'ab'.repeat(8)}`)),
      'shard-1-1-current.xml': '<x/>', 'shard-1-1-baseline.xml': '<x/>' }) }, 'remote JUnit not fetched: shard-2-1-baseline.xml'],
  ] as const)('fetch failure is reported, never thrown, and writes nothing: %s', (_name, run, reason) => {
    const local = join(tmp(), 'out');
    const result = fetchRemoteGateArtifacts({ host: REMOTE_HOST, remoteDir: newRemoteArtifactDir('ab'.repeat(8)), localDir: local, ssh: () => run });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(reason);
    expect(existsSync(join(local, 'summary.json'))).toBe(false);
  });

  test('the fetch script round-trips real files through sh/base64 and removes the remote dir', () => {
    const remoteDir = newRemoteArtifactDir();
    mkdirSync(remoteDir, { recursive: true });
    try {
      const xml = `<testsuite name="ü-ñ">${'x'.repeat(5000)}\n</testsuite>\n`;
      writeFileSync(join(remoteDir, 'summary.json'), JSON.stringify(remoteSummary(remoteDir)));
      for (const name of ['shard-1-1-current.xml', 'shard-1-1-baseline.xml', 'shard-2-1-baseline.xml']) writeFileSync(join(remoteDir, name), xml);
      writeFileSync(join(remoteDir, 'empty.xml'), '');
      const sh: RemoteSsh = (_host, script) => {
        const run = spawnSync('sh', ['-s'], { input: script, timeout: 60_000 });
        return { rc: run.status, stdout: run.stdout, stderr: run.stderr };
      };
      const local = join(tmp(), 'out');
      const result = fetchRemoteGateArtifacts({ host: 'localhost', remoteDir, localDir: local, ssh: sh });
      expect(result).toMatchObject({ ok: true, remoteDirKept: false });
      expect(readFileSync(join(local, 'shard-1-1-current.xml'), 'utf8')).toBe(xml);
      expect(existsSync(remoteDir)).toBe(false);
    } finally { rmSync(remoteDir, { recursive: true, force: true }); }
  }, 60_000);

  test.each(['base64', 'tr'])('a %s failure on the host is remote-fetch-failed: nothing written locally, the remote dir removed', (tool) => {
    const remoteDir = newRemoteArtifactDir();
    const shim = tmp();
    writeFileSync(join(shim, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    mkdirSync(remoteDir, { recursive: true });
    try {
      writeFileSync(join(remoteDir, 'summary.json'), JSON.stringify(remoteSummary(remoteDir)));
      const sh: RemoteSsh = (_host, script) => {
        const run = spawnSync('sh', ['-s'], { input: script, timeout: 60_000, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
        return { rc: run.status, stdout: run.stdout, stderr: run.stderr };
      };
      const local = join(tmp(), 'out');
      const result = fetchRemoteGateArtifacts({ host: 'localhost', remoteDir, localDir: local, ssh: sh });
      expect(result).toEqual({ ok: false, reason: 'remote artifact read failed: summary.json' });
      expect(existsSync(local)).toBe(false);
      expect(existsSync(remoteDir)).toBe(false);
    } finally { rmSync(remoteDir, { recursive: true, force: true }); }
  }, 60_000);

  test('run result files come back too: each is written locally with junitPath/resultPath rewritten, the rest stays remote', () => {
    const remoteDir = newRemoteArtifactDir('1122334455667788');
    const local = join(tmp(), 'out');
    const { summary, files } = remoteSummaryWithResults(remoteDir);
    const ssh: RemoteSsh = () => ({ rc: 0, stderr: '', stdout: encode({ 'summary.json': JSON.stringify(summary), ...files }) });
    const result = fetchRemoteGateArtifacts({ host: REMOTE_HOST, remoteDir, localDir: local, ssh });
    if (!result.ok) throw new Error(`fetch failed: ${result.reason}`);
    expect(result.junitFiles).toHaveLength(3);
    const localSummary = JSON.parse(readFileSync(join(local, 'summary.json'), 'utf8'));
    const [s1, s2] = localSummary.shardsDetail;
    expect(s1.current).toMatchObject({ runId: 'shard-1-1-current', resultPath: join(local, 'shard-1-1-current.result.json'), junitPath: join(local, 'shard-1-1-current.xml') });
    expect(s2.current).toEqual({ runId: 'shard-2-1-current', head40: HEAD, envKey: REMOTE_ENV, cohort: ['src/m.test.ts'], rc: 2, signal: null,
      resultPath: join(local, 'shard-2-1-current.result.json'), diagnostic: 'stderr: boom' });
    for (const run of [s1.current, s1.baseline, s2.current, s2.baseline]) {
      expect(JSON.parse(readFileSync(run.resultPath, 'utf8'))).toEqual(run);
    }
    expect(readdirSync(local).sort()).toEqual([
      'shard-1-1-baseline.result.json', 'shard-1-1-baseline.xml', 'shard-1-1-current.result.json', 'shard-1-1-current.xml',
      'shard-2-1-baseline.result.json', 'shard-2-1-baseline.xml', 'shard-2-1-current.result.json', 'summary.json']);
    for (const name of readdirSync(local)) expect(readFileSync(join(local, name), 'utf8')).not.toContain(remoteDir);
  });

  test.each([
    ['a field differs from the summary run (rc)', (files: Record<string, string>) => {
      const run = JSON.parse(files['shard-1-1-current.result.json']!); run.rc = 9; files['shard-1-1-current.result.json'] = JSON.stringify(run);
    }, (_s: ReturnType<typeof remoteSummary>) => {}, 'remote run result disagrees with summary: shard-1-1-current.result.json'],
    ['the result file carries an extra key the summary run does not', (files: Record<string, string>) => {
      const run = JSON.parse(files['shard-2-1-current.result.json']!); run.extra = 1; files['shard-2-1-current.result.json'] = JSON.stringify(run);
    }, (_s: ReturnType<typeof remoteSummary>) => {}, 'remote run result disagrees with summary: shard-2-1-current.result.json'],
    ['the result file lacks a key the summary run has (diagnostic)', (files: Record<string, string>) => {
      const run = JSON.parse(files['shard-2-1-current.result.json']!); delete run.diagnostic; files['shard-2-1-current.result.json'] = JSON.stringify(run);
    }, (_s: ReturnType<typeof remoteSummary>) => {}, 'remote run result disagrees with summary: shard-2-1-current.result.json'],
    ['the summary resultPath names a different file than <runId>.result.json', (_files: Record<string, string>) => {},
      (summary: ReturnType<typeof remoteSummary>) => { summary.shardsDetail[0]!.current.resultPath = '/tmp/elanous-gate-artifacts-x/other.json'; },
      'remote runId/resultPath mismatch: shard-1-1-current'],
  ] as const)('a run result that does not match its summary run is a fetch failure — nothing written: %s', (_name, editFiles, editSummary, reason) => {
    const remoteDir = newRemoteArtifactDir('a1b2c3d4e5f60718');
    const local = join(tmp(), 'out');
    const { summary, files } = remoteSummaryWithResults(remoteDir);
    editFiles(files); editSummary(summary);
    const ssh: RemoteSsh = () => ({ rc: 0, stderr: '', stdout: encode({ 'summary.json': JSON.stringify(summary), ...files }) });
    expect(fetchRemoteGateArtifacts({ host: REMOTE_HOST, remoteDir, localDir: local, ssh })).toEqual({ ok: false, reason });
    expect(existsSync(local)).toBe(false);
  });

  test('a run result the summary names but that did not come back is a fetch failure — nothing written', () => {
    const remoteDir = newRemoteArtifactDir('8877665544332211');
    const local = join(tmp(), 'out');
    const { summary, files } = remoteSummaryWithResults(remoteDir);
    delete (files as Record<string, string>)['shard-2-1-current.result.json'];
    const ssh: RemoteSsh = () => ({ rc: 0, stderr: '', stdout: encode({ 'summary.json': JSON.stringify(summary), ...files }) });
    const result = fetchRemoteGateArtifacts({ host: REMOTE_HOST, remoteDir, localDir: local, ssh });
    expect(result).toEqual({ ok: false, reason: 'remote run result not fetched: shard-2-1-current.result.json' });
    expect(existsSync(local)).toBe(false);
  });

  test('the real sh/base64 fetch carries *.result.json written by writeGateArtifacts on the "host"', () => {
    const remoteDir = newRemoteArtifactDir();
    try {
      runSharded(remoteDir);
      const sh: RemoteSsh = (_host, script) => {
        const run = spawnSync('sh', ['-s'], { input: script, timeout: 60_000 });
        return { rc: run.status, stdout: run.stdout, stderr: run.stderr };
      };
      const local = join(tmp(), 'out');
      const result = fetchRemoteGateArtifacts({ host: 'localhost', remoteDir, localDir: local, ssh: sh });
      expect(result).toMatchObject({ ok: true, remoteDirKept: false });
      expect(readdirSync(local).filter((name) => name.endsWith('.result.json')).sort()).toEqual([
        'shard-1-1-baseline.result.json', 'shard-1-1-current.result.json', 'shard-2-1-baseline.result.json', 'shard-2-1-current.result.json']);
      const run = JSON.parse(readFileSync(join(local, 'shard-1-1-current.result.json'), 'utf8'));
      expect(run).toMatchObject({ runId: 'shard-1-1-current', head40: HEAD, envKey: ENV, rc: 0,
        junitPath: join(local, 'shard-1-1-current.xml'), resultPath: join(local, 'shard-1-1-current.result.json') });
      expect(existsSync(remoteDir)).toBe(false);
    } finally { rmSync(remoteDir, { recursive: true, force: true }); }
  }, 60_000);

  test('parse rejects unsafe names and stray lines instead of half-reading them', () => {
    expect(parseRemoteArtifactFetch(encode({ '../evil': 'x' }))).toBeNull();
    expect(parseRemoteArtifactFetch(`summary.json\n__GATE_ARTIFACTS_END__\n`)).toBeNull();
    expect(parseRemoteArtifactFetch(encode({ 'summary.json': '{}' }))?.files.get('summary.json')?.toString()).toBe('{}');
    expect(parseRemoteArtifactFetch(`${encode({ 'summary.json': '{}' })}junk\n`)).toBeNull();
    // Everything came back but the remote dir could not be removed — a success that says so.
    expect(parseRemoteArtifactFetch(encode({ 'summary.json': '{}' }, false) + '__GATE_ARTIFACTS_END_KEPT__\n')?.remoteDirKept).toBe(true);
  });

  test('remote dirs are only ever our own /tmp prefix — scripts refuse anything else', () => {
    expect(() => remoteArtifactFetchScript('/tmp/x')).toThrow();
    expect(() => remoteArtifactCleanupScript("/tmp/elanous-gate-artifacts-abcdef12'; rm -rf ~")).toThrow();
    expect(() => newRemoteArtifactDir('../x')).toThrow();
    expect(remoteArtifactCleanupScript(newRemoteArtifactDir('ab'.repeat(8)))).toContain(`rm -rf '/var/tmp/elanous-gate-artifacts-${'ab'.repeat(8)}'`);
  });

  test('a measured commit without the artifact module is remote-unsupported (the flag is not sent)', () => {
    const asked: string[] = [];
    expect(remoteCommitSupportsArtifactDir('/r', 'HEAD', (_repo, spec) => { asked.push(spec); return false; })).toBe(false);
    expect(asked).toEqual(['HEAD:src/self-implement/gate-artifacts.ts']);
    expect(remoteCommitSupportsArtifactDir('/r', 'HEAD', () => true)).toBe(true);
    // This tree has it.
    expect(remoteCommitSupportsArtifactDir(resolve(import.meta.dir, '../..'))).toBe(true);
  });
});
