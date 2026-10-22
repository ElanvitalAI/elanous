import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateGateTestShards } from './shard-aggregate.js';
import { maxAutomaticShardCount, runBunShard, runBunShardWithSpawn, runShardedGateTests, SHARD_FAILURE_TAIL_BYTES, selfGateShardTimeoutMs, writeShardFailureEvidence, type ShardProcess } from './shard-run.js';
import { GATE_SPAWN_LANE_FILES, isGateSpawnLaneFile } from './spawn-lane-files.js';
import { planFixedGateTestShards, type GateTestShard } from './shard-plan.js';
import { withFakeBins, type FakeBinSpec } from '../ux-sim/fake-bin.js';

const xml = (files: readonly string[], failing: readonly string[]) => `<testsuites tests="${files.length}">`
  + files.map((file) => `<testsuite file="${file}" tests="1" failures="${failing.includes(file) ? 1 : 0}">`
    + `<testcase name="case-${file}">${failing.includes(file) ? '<failure message="assertion failed"/>' : ''}</testcase></testsuite>`).join('')
  + '</testsuites>';

test('six fake test files in two processes have the same introduced/preexisting verdict as one bundle', () => {
  const files = Array.from({ length: 6 }, (_, i) => `test/f${i}.test.ts`);
  const currentFail = [files[0]!, files[3]!];
  const baselineFail = [files[0]!];
  const calls: string[][] = [];
  const run: ShardProcess = (cwd, selected) => {
    calls.push([cwd, ...selected]);
    const failed = selected.filter((file) => (cwd === '/head' ? currentFail : baselineFail).includes(file));
    return { exitCode: failed.length ? 1 : 0, junit: xml(selected, failed), rssMb: 1000, seconds: 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run, baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 3);
  expect(result.shards).toHaveLength(2);
  expect(result.shards.flatMap((s) => s.files).sort()).toEqual(files);
  expect(result.shards.every((s) => s.plannedRssMb <= 3072)).toBe(true);
  expect(calls.filter((call) => call.length > 2)).toHaveLength(4);
  expect(result.aggregate.status).toBe('failed');
  const whole: GateTestShard[] = [{ id: 'whole', files, plannedRssMb: 6000, plannedSeconds: 6 }];
  const unsharded = aggregateGateTestShards(whole, [{
    shardId: 'whole', attempt: 1, currentJUnit: xml(files, currentFail), baselineJUnit: xml(files, baselineFail),
    currentExitCode: 1, baselineExitCode: 1,
  }]);
  expect(result.aggregate.report).toMatchObject({ introduced: unsharded.report?.introduced, preexisting: unsharded.report?.preexisting });
  expect(result.aggregate.report?.failures.map((f) => [f.name, f.attribution]).sort())
    .toEqual(unsharded.report?.failures.map((f) => [f.name, f.attribution]).sort());
});

test('self gate separates real spawn files under the same shard budget and retains every file', () => {
  const files = ['test/preview-terminal.test.ts', 'test/cli-dev-command.test.ts', 'test/plain-a.test.ts', 'test/plain-b.test.ts'];
  const calls: string[][] = [];
  const run: ShardProcess = (cwd, selected) => {
    calls.push([cwd, ...selected]);
    return { exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 3, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 1);
  expect(result.aggregate.status).toBe('passed');
  expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files.sort());
  expect(new Set(result.shards.map((shard) => shard.id)).size).toBe(result.shards.length);
  expect(result.shards.every((shard) => shard.files.every(isGateSpawnLaneFile)
    || shard.files.every((file) => !isGateSpawnLaneFile(file)))).toBe(true);
  expect(calls.filter(([cwd]) => cwd === '/head')).toHaveLength(files.length + result.shards.length);
  expect(selfGateShardTimeoutMs(['test/plain-a.test.ts'])).toBe(300_000);
  expect(selfGateShardTimeoutMs(['test/preview-terminal.test.ts'])).toBe(120_000);
  expect(() => selfGateShardTimeoutMs(['test/plain-a.test.ts', 'test/preview-terminal.test.ts'])).toThrow('mixed');
  const expanded = runShardedGateTests('/head', files, 'HEAD', 1, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 1,
    { hostResources: { cores: 16, freeMemoryGiB: 16, freeTmpGiB: 16 } });
  expect(expanded.aggregate.status).toBe('passed');
  expect(expanded.expandedFrom).toBe(1);
});

test('183 measured importer files expand the requested 16 shards until every 8 GiB bundle fits', () => {
  const files = Array.from({ length: 183 }, (_, i) => `test/importer-${String(i).padStart(3, '0')}.test.ts`);
  const run: ShardProcess = (cwd, selected) => {
    const failed = selected.filter((file) => (cwd === '/head' ? [files[0], files[1]] : [files[0]]).includes(file));
    return { exitCode: failed.length ? 1 : 0, junit: xml(selected, failed), rssMb: 1741, seconds: 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 16, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8,
    { hostResources: { cores: 64, freeMemoryGiB: 512, freeTmpGiB: 64 } });
  expect(result.aggregate.status).toBe('failed');
  expect(result.aggregate.report).toMatchObject({ introduced: 1, preexisting: 1 });
  expect(result.expandedFrom).toBe(16);
  expect(result.shards.length).toBeGreaterThanOrEqual(39);
  expect(result.shards.every((shard) => shard.plannedRssMb <= 8192)).toBe(true);
  expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files);
});

test('host expansion cap runs a fixed plan instead of declaring all importer tests unmeasured', () => {
  expect(maxAutomaticShardCount(2, 8, { cores: 16, freeMemoryGiB: 24, freeTmpGiB: 6 })).toBe(3);
  expect(maxAutomaticShardCount(2, 8, { cores: 16, freeMemoryGiB: 80, freeTmpGiB: 2 })).toBe(2);
  const files = Array.from({ length: 8 }, (_, i) => `test/importer-${i}.test.ts`);
  let bundleRuns = 0;
  const run: ShardProcess = (_cwd, selected) => {
    if (selected.length > 1) bundleRuns++;
    return { exitCode: 0, junit: xml(selected, []), rssMb: 5000, seconds: 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8,
    { hostResources: { cores: 16, freeMemoryGiB: 24, freeTmpGiB: 6 } });
  expect(result.aggregate.status).toBe('passed');
  expect(result.distribution).toBe('fixed-cap-fallback');
  expect(result.fallbackReason).toContain('host shard expansion cap 3 < needed 5');
  expect(result.shards).toHaveLength(3);
  expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files);
  expect(bundleRuns).toBeGreaterThan(0);
});

test('requested shards above file count do not trip the automatic expansion cap', () => {
  const file = 'test/one.test.ts';
  const run: ShardProcess = (_cwd, selected) => ({ exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1 });
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', [file], 'HEAD', 16, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8,
    { hostResources: { cores: 32, freeMemoryGiB: 64, freeTmpGiB: 64 } });
  expect(result.aggregate.status).toBe('passed');
  expect(result.shards).toHaveLength(1);
  expect(result.shards[0]?.files).toEqual([file]);
});

test('packing failure at host cap also tries the bounded fixed plan', () => {
  const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
  let bundles = 0;
  const run: ShardProcess = (_cwd, selected) => {
    if (selected.length > 1) bundles++;
    return { exitCode: 0, junit: xml(selected, []), rssMb: 5120, seconds: 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8,
    { hostResources: { cores: 8, freeMemoryGiB: 16, freeTmpGiB: 8 } });
  expect(result.aggregate.status).toBe('passed');
  expect(result.distribution).toBe('fixed-cap-fallback');
  expect(result.fallbackReason).toContain('host shard expansion cap 2 < needed ≥3');
  expect(result.fallbackReason).toContain('requested 2');
  expect(result.shards).toHaveLength(2);
  expect(bundles).toBeGreaterThan(0);
});

test('a failed fixed fallback shard remains unmeasured with its child failure evidence', () => {
  const files = Array.from({ length: 4 }, (_, i) => `test/importer-${i}.test.ts`);
  const run: ShardProcess = (_cwd, selected) => selected.length === 1
    ? { exitCode: 0, junit: xml(selected, []), rssMb: 6000, seconds: 1 }
    : { exitCode: 137, signal: 'SIGKILL', diagnostic: 'out of memory' };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8,
    { hostResources: { cores: 4, freeMemoryGiB: 16, freeTmpGiB: 4 } });
  expect(result.distribution).toBe('fixed-cap-fallback');
  expect(result.aggregate.status).toBe('unmeasured');
  expect(result.attempts).not.toHaveLength(0);
  expect(Object.values(result.unmeasuredByShard ?? {}).join(' ')).toContain('SIGKILL');
});

test('each incomplete shard records the final child exit and diagnostic after retry', () => {
  const files = ['test/a.test.ts', 'test/b.test.ts'];
  const run: ShardProcess = (cwd, selected) => selected.length === 1
    ? { exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1 }
    : cwd === '/head'
      ? { exitCode: 1, diagnostic: 'stderr: ENOSPC in /tmp' }
      : { exitCode: 0, junit: xml(selected, []) };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 1, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8);
  expect(result.aggregate).toEqual({ status: 'unmeasured', retryShardIds: ['shard-1'] });
  expect(result.unmeasuredByShard?.['shard-1']).toContain('current: exit 1, signal none, JUnit missing; stderr: ENOSPC in /tmp');
  expect(result.unmeasuredByShard?.['shard-1']).toContain('baseline: exit 0, signal none, JUnit present');
});

test('a baseline worktree-add failure carries its git stderr tail into every unmeasured shard reason', () => {
  const files = ['test/a.test.ts'];
  const run: ShardProcess = (_cwd, selected) => ({ exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1 });
  const baseline = () => ({
    status: 'unknown' as const, unknownReason: 'infrastructure-failure' as const, childResponsibility: 'none' as const,
    log: 'baseline worktree-add-failed (code 128, elapsed 90900ms, limit 300000ms, target /tmp/b, base origin/main@0123456789ab)',
    gitStderrTail: 'fatal: unable to write new index file',
  });
  const result = runShardedGateTests('/head', files, 'HEAD', 1, run,
    baseline as unknown as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8);
  expect(result.aggregate.status).toBe('unmeasured');
  expect(result.baselineStderrTail).toBe('fatal: unable to write new index file');
  expect(result.unmeasuredByShard?.['shard-1']).toBe('baseline worktree: baseline worktree-add-failed (code 128, elapsed 90900ms, limit 300000ms, target /tmp/b, base origin/main@0123456789ab) · git stderr: fatal: unable to write new index file');
});

describe('shared baseline worktree (--shards ≥2) · real withBaselineWorktree ⊕ fake git worktree add', () => {
  // Real git subprocesses (rev-parse · worktree list) can exceed Bun's 5 s default under gate-pod load — per test, not file-wide.
  const GIT_TIMEOUT_MS = 60_000;
  const realGit = Bun.which('git');
  const sh = (cwd: string, ...args: string[]) => {
    const result = spawnSync(realGit!, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const repo = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'shard-add-stderr-'));
    sh(cwd, 'init', '-q');
    sh(cwd, 'config', 'user.email', 'shard@example.test');
    sh(cwd, 'config', 'user.name', 'Shard Test');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    sh(cwd, 'add', 'a.txt');
    sh(cwd, 'commit', '-qm', 'base');
    return cwd;
  };
  const passing: ShardProcess = (_cwd, selected) => ({ exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1 });
  const files = ['test/a.test.ts', 'test/b.test.ts'];
  const failWith = async (spec: FakeBinSpec) => {
    if (!realGit) throw new Error('git unavailable');
    const cwd = repo();
    try {
      const head = sh(cwd, 'rev-parse', 'HEAD');
      const result = await withFakeBins({ git: { whenArgsStartWith: ['worktree', 'add'], otherwise: realGit, ...spec } },
        () => runShardedGateTests(cwd, files, 'HEAD', 2, passing, undefined, 8, { fixedDistribution: true }));
      return { head, result };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  test('stderr present: every shard reason names target, base@sha12 and the git stderr tail', async () => {
    const { head, result } = await failWith({ exitCode: 128, stderr: "fatal: could not create leading directories of '/tmp/x/.git': Resource temporarily unavailable\n" });
    expect(result.aggregate.status).toBe('unmeasured');
    expect(Object.keys(result.unmeasuredByShard ?? {})).toEqual(['shard-1', 'shard-2']);
    for (const reason of Object.values(result.unmeasuredByShard ?? {})) {
      expect(reason).toMatch(/^baseline worktree: baseline worktree-add-failed \(code 128, elapsed \d+ms, limit \d+ms, target \S*elanous-gate-baseline-\S+, base HEAD@[0-9a-f]{12}\) · git stderr: fatal: could not create leading directories/);
      expect(reason).toContain(`base HEAD@${head.slice(0, 12)}`);
    }
    expect(result.baselineStderrTail).toBe("fatal: could not create leading directories of '/tmp/x/.git': Resource temporarily unavailable");
  }, GIT_TIMEOUT_MS);

  test('killed without stderr: the reason still names target and base, and says the stderr was empty with the signal', async () => {
    const { head, result } = await failWith({ killSignal: 'KILL' });
    expect(result.aggregate.status).toBe('unmeasured');
    const reasons = Object.values(result.unmeasuredByShard ?? {});
    expect(reasons).toHaveLength(2);
    for (const reason of reasons) {
      expect(reason).toMatch(/^baseline worktree: baseline worktree-add-signal-SIGKILL \(code null, elapsed \d+ms, limit \d+ms, target \S*elanous-gate-baseline-\S+, base HEAD@[0-9a-f]{12}\) · git stderr: \(비었음 · signal=SIGKILL · errorCode=none\)$/);
      expect(reason).toContain(`base HEAD@${head.slice(0, 12)}`);
    }
    expect(result.baselineStderrTail).toBe('(비었음 · signal=SIGKILL · errorCode=none)');
  }, GIT_TIMEOUT_MS);

  test('success path is unchanged: no stderr part, no baselineStderrTail', () => {
    if (!realGit) throw new Error('git unavailable');
    const cwd = repo();
    try {
      const result = runShardedGateTests(cwd, files, 'HEAD', 2, passing, undefined, 8, { fixedDistribution: true });
      expect(result.aggregate.status).not.toBe('unmeasured');
      expect(result.baselineStderrTail).toBeUndefined();
      expect(result.unmeasuredByShard).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, GIT_TIMEOUT_MS);
});

test('large spawn files can expand beyond the normal three spawn bundles without mixing lanes', () => {
  const files = [...GATE_SPAWN_LANE_FILES, 'test/ordinary.test.ts'];
  const run: ShardProcess = (_cwd, selected) => ({ exitCode: 0, junit: xml(selected, []), rssMb: selected[0] === 'test/ordinary.test.ts' ? 100 : 5000, seconds: 1 });
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8,
    { hostResources: { cores: 16, freeMemoryGiB: 128, freeTmpGiB: 16 } });
  expect(result.aggregate.status).toBe('passed');
  expect(result.shards).toHaveLength(files.length);
  expect(result.expandedFrom).toBe(2);
  expect(result.shards.every((shard) => shard.plannedRssMb <= 8192)).toBe(true);
  expect(result.shards.every((shard) => shard.files.every(isGateSpawnLaneFile)
    || shard.files.every((file) => !isGateSpawnLaneFile(file)))).toBe(true);
});

test('all ten real child files occupy three bounded shards beside a regular shard', () => {
  const files = [...GATE_SPAWN_LANE_FILES, 'test/ordinary.test.ts'];
  const run: ShardProcess = (_cwd, selected) => ({
    exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1,
  });
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 4, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8);
  expect(result.aggregate.status).toBe('passed');
  expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files.sort());
  expect(result.shards.filter((shard) => shard.files.every(isGateSpawnLaneFile))).toHaveLength(3);
  expect(result.shards.filter((shard) => shard.files.every((file) => !isGateSpawnLaneFile(file)))).toHaveLength(1);
});

test('explicit four shards are all spawn shards when only real child files are selected', () => {
  const files = [...GATE_SPAWN_LANE_FILES];
  const run: ShardProcess = (_cwd, selected) => ({
    exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1,
  });
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 4, run,
    baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8);
  expect(result.aggregate.status).toBe('passed');
  expect(result.shards).toHaveLength(4);
  expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files.sort());
  expect(result.shards.every((shard) => shard.files.every(isGateSpawnLaneFile))).toBe(true);
});

test('one unavailable file measurement uses the mean weights and still executes every shard', () => {
  const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
  const calls: string[][] = [];
  const run: ShardProcess = (cwd, selected) => {
    calls.push([cwd, ...selected]);
    if (selected.length === 1 && selected[0] === files[1]) throw new Error('measurement crashed');
    return { exitCode: 0, junit: xml(selected, []), rssMb: selected[0] === files[2] ? 300 : 100, seconds: selected[0] === files[2] ? 3 : 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run, baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 1);
  expect(result.measurementFailures).toBe(1);
  expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files);
  expect(result.shards.find((shard) => shard.files.includes(files[1]!))?.plannedRssMb).toBe(300);
  expect(result.shards.find((shard) => shard.files.includes(files[1]!))?.plannedSeconds).toBe(3);
  expect(result.aggregate.status).toBe('passed');
  expect(result.attempts).toHaveLength(2);
  expect(calls.filter(([cwd, ...selected]) => cwd === '/base' && selected.length > 0)).toHaveLength(2);
});

test('one dead bundle is the only one retried; an unfinished retry fails closed', () => {
  const files = Array.from({ length: 6 }, (_, i) => `test/f${i}.test.ts`);
  const calls: string[][] = [];
  let kill = true;
  const run: ShardProcess = (cwd, selected) => {
    calls.push([cwd, ...selected]);
    if (selected.length > 1 && cwd === '/head' && selected.includes(files[0]!) && kill) {
      kill = false;
      return { exitCode: null, signal: 'SIGKILL', junit: '<testsuites' };
    }
    return { exitCode: 0, junit: xml(selected, []), rssMb: 1000, seconds: 1 };
  };
  const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base');
  const result = runShardedGateTests('/head', files, 'HEAD', 2, run, baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 3);
  expect(result.aggregate).toEqual({ status: 'passed', retryShardIds: [] });
  const retried = result.attempts.filter((attempt) => attempt.attempt === 2);
  expect(retried).toHaveLength(1);
  expect(result.attempts.filter((attempt) => attempt.shardId === retried[0]!.shardId)).toHaveLength(2);
  expect(result.attempts.filter((attempt) => attempt.shardId !== retried[0]!.shardId)).toHaveLength(1);
  expect(calls.filter((call) => call.length > 2)).toHaveLength(6);
  const alwaysDead: ShardProcess = (cwd, selected) => selected.length === 1
    ? { exitCode: 0, junit: xml(selected, []), rssMb: 1000, seconds: 1 }
    : { exitCode: null, signal: 'SIGKILL' };
  expect(runShardedGateTests('/head', files, 'HEAD', 2, alwaysDead, baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 3).aggregate.status).toBe('unmeasured');
});

test('six real fake test files execute in two local Bun bundle processes and merge into one verdict', () => {
  const head = mkdtempSync(join(tmpdir(), 'elanous-shard-head-'));
  const base = mkdtempSync(join(tmpdir(), 'elanous-shard-base-'));
  const files = Array.from({ length: 6 }, (_, i) => `test/f${i}.test.ts`);
  try {
    mkdirSync(join(head, 'test'));
    mkdirSync(join(base, 'test'));
    for (const [index, file] of files.entries()) {
      for (const [cwd, failed] of [[head, index === 0 || index === 3], [base, index === 0]] as const) {
        writeFileSync(join(cwd, file), `import { test, expect } from 'bun:test'; test('case-${index}', () => expect(1).toBe(${failed ? 2 : 1}));\n`);
      }
    }
    const baseline = (_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit(base);
    const result = runShardedGateTests(head, files, 'HEAD', 2, runBunShard,
      baseline as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree, 8);
    expect(result.shards).toHaveLength(2);
    expect(result.shards.flatMap((shard) => shard.files).sort()).toEqual(files);
    expect(result.attempts).toHaveLength(2);
    expect(result.aggregate.status).toBe('failed');
    expect(result.aggregate.report).toMatchObject({ introduced: 1, preexisting: 1, unknown: 0 });
  } finally {
    rmSync(head, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test('real Bun JUnit runner records process RSS, duration, and selected files only', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-shard-run-test-'));
  try {
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'test/a.test.ts'), "import { test } from 'bun:test'; test('a', () => {});\n");
    const result = runBunShard(cwd, ['test/a.test.ts']);
    expect(result.exitCode).toBe(0);
    expect(result.junit).toContain('test/a.test.ts');
    expect(result.rssMb).toBeGreaterThan(0);
    expect(result.seconds).toBeGreaterThanOrEqual(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Bun child launch gets 120s for real spawn files and retains 300s for regular tests', () => {
  const launched: Array<{ command: readonly string[]; timeout: number | undefined }> = [];
  const spawn = ((command: string[], options: { timeout?: number }) => {
    launched.push({ command, timeout: options.timeout });
    return { exitCode: 0, signalCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(), resourceUsage: { maxRSS: 1024 * 1024 } };
  }) as unknown as typeof Bun.spawnSync;
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-shard-launch-test-'));
  try {
    runBunShardWithSpawn(cwd, ['test/preview-terminal.test.ts'], spawn);
    runBunShardWithSpawn(cwd, ['test/ordinary.test.ts'], spawn);
    expect(launched).toHaveLength(2);
    expect(launched[0]?.command).toContain('--timeout=120000');
    expect(launched[0]?.timeout).toBe(120_000);
    expect(launched[1]?.command).not.toContain('--timeout=120000');
    expect(launched[1]?.timeout).toBe(300_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Bun child receives the isolated baseline with explicit fake LLM off and endpoint', () => {
  const previousFake = process.env.ELANOUS_TEST_FAKE_LLM;
  const previousEndpoint = process.env.OPENAI_BASE_URL;
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-shard-env-test-'));
  let childEnv: Record<string, string | undefined> | undefined;
  try {
    process.env.ELANOUS_TEST_FAKE_LLM = '0';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9555';
    const spawn = ((_command: string[], options: { env?: Record<string, string | undefined> }) => {
      childEnv = options.env;
      return { exitCode: 0, signalCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(), resourceUsage: { maxRSS: 1024 * 1024 } };
    }) as unknown as typeof Bun.spawnSync;
    runBunShardWithSpawn(cwd, ['test/preview-terminal.test.ts'], spawn);
    expect(childEnv).toMatchObject({ TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      ELANOUS_TEST_FAKE_LLM: '0', OPENAI_BASE_URL: 'http://127.0.0.1:9555' });
  } finally {
    if (previousFake === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM;
    else process.env.ELANOUS_TEST_FAKE_LLM = previousFake;
    if (previousEndpoint === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousEndpoint;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a Bun exit 2 before JUnit preserves only bounded, redacted output', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-shard-exit-test-'));
  try {
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'test/early.test.ts'), [
      "console.log('phase=bootstrap ' + 'x'.repeat(800));",
      "console.error('stderr preamble ' + 'y'.repeat(400) + ' API_KEY=supersecretvalue12345 crash before test');",
      'process.exit(2);',
    ].join('\n'));
    const result = runBunShard(cwd, ['test/early.test.ts']);
    expect(result.exitCode).toBe(2);
    expect(result.junit).toBeUndefined();
    expect(result.diagnostic).toContain('phase=bootstrap');
    expect(result.diagnostic).toContain('API_KEY=***');
    expect(result.diagnostic).toContain('crash before test');
    expect(result.diagnostic).not.toContain('supersecretvalue12345');
    expect(result.diagnostic!.length).toBeLessThan(510);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe('fixed shard distribution (opt-in · no pre-measurement)', () => {
  type Baseline = typeof import('../self-implement/gate-baseline.js').withBaselineWorktree;
  const baseline = ((_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base')) as unknown as Baseline;
  const files = Array.from({ length: 7 }, (_, i) => `test/g${i}.test.ts`);

  test('the same file set in any order gets the same sorted round-robin assignment, every file exactly once', () => {
    const expected = planFixedGateTestShards(files, 3);
    expect(expected.map((shard) => shard.files)).toEqual([
      ['test/g0.test.ts', 'test/g3.test.ts', 'test/g6.test.ts'],
      ['test/g1.test.ts', 'test/g4.test.ts'],
      ['test/g2.test.ts', 'test/g5.test.ts'],
    ]);
    for (const order of [[...files].reverse(), [files[3]!, files[0]!, files[6]!, files[1]!, files[5]!, files[2]!, files[4]!], [...files, files[2]!]]) {
      const planned = planFixedGateTestShards(order, 3);
      expect(planned).toEqual(expected);
      const dealt = planned.flatMap((shard) => shard.files);
      expect(dealt.length).toBe(files.length);
      expect([...dealt].sort()).toEqual([...files].sort());
    }
  });

  test('no empty shards, invalid N rejected, spawn lane kept apart', () => {
    expect(planFixedGateTestShards(files.slice(0, 2), 8).map((shard) => shard.id)).toEqual(['shard-1', 'shard-2']);
    expect(planFixedGateTestShards([], 4)).toEqual([]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => planFixedGateTestShards(files, bad)).toThrow('invalid shard count');
    const spawnFile = [...GATE_SPAWN_LANE_FILES][0]!;
    const mixed = planFixedGateTestShards([spawnFile, ...files], 4);
    expect(mixed.every((shard) => shard.files.every(isGateSpawnLaneFile) || shard.files.every((file) => !isGateSpawnLaneFile(file)))).toBe(true);
    expect(mixed.flatMap((shard) => shard.files).sort()).toEqual([spawnFile, ...files].sort());
    expect(() => planFixedGateTestShards([spawnFile, files[0]!], 1)).toThrow('spawn lane');
  });

  test('runShardedGateTests makes zero single-file measurement runs and keeps the aggregate shape', () => {
    const calls: string[][] = [];
    const run: ShardProcess = (cwd, selected) => {
      calls.push([cwd, ...selected]);
      return { exitCode: 0, junit: xml(selected, []) };
    };
    const result = runShardedGateTests('/head', [...files].reverse(), 'HEAD', 3, run, baseline, undefined, { fixedDistribution: true });
    expect(result.distribution).toBe('fixed');
    expect(result.measurementFailures).toBeUndefined();
    expect(result.shards.map((shard) => shard.files)).toEqual(planFixedGateTestShards(files, 3).map((shard) => shard.files));
    // one current + one baseline run per shard — none is a per-file RSS sample
    expect(calls).toHaveLength(6);
    expect(calls.filter(([cwd]) => cwd === '/head').map((call) => call.slice(1))).toEqual(result.shards.map((shard) => shard.files));
    expect(result.aggregate).toEqual({ status: 'passed', retryShardIds: [] });
  });

  test('a timed-out / OOM-killed or JUnit-less shard is unmeasured, never passed', () => {
    const killed: ShardProcess = (cwd, selected) => selected.includes('test/g1.test.ts') && cwd === '/head'
      ? { exitCode: null, signal: 'SIGKILL' }
      : { exitCode: 0, junit: xml(selected, []) };
    const oom = runShardedGateTests('/head', files, 'HEAD', 3, killed, baseline, undefined, { fixedDistribution: true });
    expect(oom.aggregate.status).toBe('unmeasured');
    expect(oom.aggregate.retryShardIds).toEqual(['shard-2']);
    expect(oom.attempts.filter((attempt) => attempt.shardId === 'shard-2')).toHaveLength(2);
    const noJUnit: ShardProcess = (cwd, selected) => cwd === '/head' && selected.includes('test/g0.test.ts')
      ? { exitCode: 1, junit: undefined }
      : { exitCode: 0, junit: xml(selected, []) };
    expect(runShardedGateTests('/head', files, 'HEAD', 3, noJUnit, baseline, undefined, { fixedDistribution: true }).aggregate.status).toBe('unmeasured');
  });

  test('without the mode the measured planner still samples every file first', () => {
    const singles: string[] = [];
    const run: ShardProcess = (cwd, selected) => {
      if (selected.length === 1 && cwd === '/head') singles.push(selected[0]!);
      return { exitCode: 0, junit: xml(selected, []), rssMb: 100, seconds: 1 };
    };
    const result = runShardedGateTests('/head', files, 'HEAD', 3, run, baseline, 1);
    expect(result.distribution).toBeUndefined();
    expect(singles.slice(0, files.length)).toEqual(files);
  });
});

describe('OP FU (MK #8178 shard-9) — a failed shard leaves <shardId>.failure.json; a passing one leaves nothing', () => {
  const files = ['test/ok.test.ts', 'test/boom.test.ts'];
  const baseline = ((_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit('/base')) as typeof import('../self-implement/gate-baseline.js').withBaselineWorktree;
  // Fake child: test/boom exits 2 before writing JUnit (huge stdout, a secret on stderr); everything else writes JUnit and exits 0.
  const fakeSpawn = ((command: string[]) => {
    const outfile = command.find((arg) => arg.startsWith('--reporter-outfile='))!.slice('--reporter-outfile='.length);
    const selected = command.filter((arg) => arg.endsWith('.test.ts'));
    if (selected.includes('test/boom.test.ts')) {
      const stdout = new TextEncoder().encode(`HEAD-MARKER ${'x'.repeat(SHARD_FAILURE_TAIL_BYTES)} TAIL-MARKER`);
      const stderr = new TextEncoder().encode('error: preload crashed API_KEY=supersecretvalue12345');
      return { exitCode: 2, signalCode: null, stdout, stderr, resourceUsage: { maxRSS: 1024 * 1024 } };
    }
    writeFileSync(outfile, xml(selected, []));
    return { exitCode: 0, signalCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(), resourceUsage: { maxRSS: 1024 * 1024 } };
  }) as unknown as typeof Bun.spawnSync;
  const run: ShardProcess = (cwd, selected) => runBunShardWithSpawn(cwd, selected, fakeSpawn);

  test('exit 2 · no JUnit → failure.json with the shard files and the bounded stdout/stderr tails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-shard-failure-test-'));
    try {
      const result = runShardedGateTests('/head', files, 'HEAD', 2, run, baseline, undefined, { fixedDistribution: true });
      expect(result.aggregate.status).toBe('unmeasured');
      const boomShard = result.shards.find((shard) => shard.files.includes('test/boom.test.ts'))!;
      const okShard = result.shards.find((shard) => shard.files.includes('test/ok.test.ts'))!;
      expect(boomShard.id).not.toBe(okShard.id);
      expect(result.failureEvidence!.every((item) => item.shardId === boomShard.id)).toBe(true);
      const written = writeShardFailureEvidence(dir, result.failureEvidence!);
      expect(written).toEqual([join(dir, `${boomShard.id}.failure.json`)]);
      expect(readdirSync(dir)).toEqual([`${boomShard.id}.failure.json`]);
      const record = JSON.parse(readFileSync(written[0]!, 'utf8'));
      expect(record).toMatchObject({ shardId: boomShard.id, files: boomShard.files, exitCode: 2, signal: null, side: 'current' });
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.stdoutTail).toEndWith('TAIL-MARKER');
      expect(record.stdoutTail).not.toContain('HEAD-MARKER');
      expect(Buffer.byteLength(record.stdoutTail)).toBeLessThanOrEqual(SHARD_FAILURE_TAIL_BYTES);
      expect(record.stderrTail).toContain('preload crashed');
      expect(record.stderrTail).not.toContain('supersecretvalue12345');
      // both sides and both rounds are kept under `failures`
      expect(record.failures.map((item: { side: string; attempt: number }) => `${item.side}#${item.attempt}`))
        .toEqual(['current#1', 'baseline#1', 'current#2', 'baseline#2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passing shards report no failure output and write no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-shard-failure-pass-'));
    try {
      const result = runShardedGateTests('/head', ['test/ok.test.ts'], 'HEAD', 1, run, baseline, undefined, { fixedDistribution: true });
      expect(result.aggregate.status).toBe('passed');
      expect(result.failureEvidence).toBeUndefined();
      expect(run('/head', ['test/ok.test.ts']).failure).toBeUndefined();
      expect(writeShardFailureEvidence(join(dir, 'never'), [])).toEqual([]);
      expect(existsSync(join(dir, 'never'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
