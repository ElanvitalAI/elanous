import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateGateTestShards } from './shard-aggregate.js';
import { runBunShard, runShardedGateTests, type ShardProcess } from './shard-run.js';
import type { GateTestShard } from './shard-plan.js';

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
