import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { allowsBaselineOnlyFailure, buildGateBaselineReport } from '../self-implement/gate-baseline.js';
import { aggregateGateTestShards, type GateShardAttempt } from './shard-aggregate.js';
import type { GateTestShard } from './shard-plan.js';

const shards: GateTestShard[] = ['a', 'b', 'c'].map((name, index) => ({
  id: `shard-${index + 1}`, files: [`test/${name}.test.ts`], plannedRssMb: 1000, plannedSeconds: 10,
}));
const junit = (file: string, entries: readonly { name: string; failed?: boolean; timeout?: boolean }[]) =>
  `<testsuites><testsuite file="${file}" tests="${entries.length}">`
  + entries.map(({ name, failed, timeout }) => `<testcase file="${file}" name="${name}">`
    + (failed ? `<failure message="${timeout ? 'this test timed out after 5000ms' : 'assertion failed'}"/>` : '')
    + '</testcase>').join('') + '</testsuite></testsuites>';
const attempt = (id: number, current: string, baseline: string, currentExitCode = 1, baselineExitCode = 1): GateShardAttempt => ({
  shardId: `shard-${id}`, attempt: 1, currentJUnit: current, baselineJUnit: baseline, currentExitCode, baselineExitCode,
});

describe('aggregateGateTestShards', () => {
  test('three shard JUnits yield the same introduced/preexisting judgment as one full suite', () => {
    const a = 'test/a.test.ts';
    const b = 'test/b.test.ts';
    const c = 'test/c.test.ts';
    const results = [
      attempt(1, junit(a, [{ name: 'old', failed: true }, { name: 'new', failed: true }]), junit(a, [{ name: 'old', failed: true }, { name: 'new' }])),
      attempt(2, junit(b, [{ name: 'ok' }]), junit(b, [{ name: 'ok' }]), 0, 0),
      attempt(3, junit(c, [{ name: 'legacy', failed: true }]), junit(c, [{ name: 'legacy', failed: true }])),
    ];
    const aggregate = aggregateGateTestShards(shards, results);
    const whole = buildGateBaselineReport(
      [a + ':', '(fail) old', '(fail) new', b + ':', '(pass) ok', c + ':', '(fail) legacy'].join('\n'),
      { status: 'test-fail', log: 'whole', output: [a + ':', '(fail) old', '(pass) new', b + ':', '(pass) ok', c + ':', '(fail) legacy'].join('\n') },
    );
    expect(aggregate.status).toBe('failed');
    expect(aggregate.report).toMatchObject({ introduced: whole.introduced, preexisting: whole.preexisting, unknown: whole.unknown });
    expect(aggregate.report?.failures.map((failure) => [failure.name, failure.attribution])).toEqual(whole.failures.map((failure) => [failure.name, failure.attribution]));
    expect(allowsBaselineOnlyFailure(aggregate.report!)).toBe(allowsBaselineOnlyFailure(whole));
    expect(aggregate.retryShardIds).toEqual([]);
  });

  test('a dead shard is the only reassignment; a completed sibling remains usable on retry', () => {
    const a = junit('test/a.test.ts', [{ name: 'old', failed: true }]);
    const b = junit('test/b.test.ts', [{ name: 'ok' }]);
    const c = junit('test/c.test.ts', [{ name: 'ok' }]);
    const completed = [attempt(1, a, a), attempt(3, c, c, 0, 0)];
    const dead = { ...attempt(2, b, b, 0, 0), currentExitCode: null, currentJUnit: '<testsuite' };
    expect(aggregateGateTestShards(shards, [...completed, dead])).toEqual({ status: 'unmeasured', retryShardIds: ['shard-2'] });
    const recovered = aggregateGateTestShards(shards, [...completed, dead, { ...attempt(2, b, b, 0, 0), attempt: 2 }]);
    expect(recovered.status).toBe('passed');
    expect(recovered.retryShardIds).toEqual([]);
    expect(recovered.report).toMatchObject({ introduced: 0, preexisting: 1 });
  });

  test('reads JUnit as XML: a <testcase> inside CDATA is text, and a truncated tail after a complete report is unmeasured', () => {
    const file = 'test/a.test.ts';
    const b = junit('test/b.test.ts', [{ name: 'ok' }]);
    const c = junit('test/c.test.ts', [{ name: 'ok' }]);
    const cdata = `<testsuites><testsuite file="${file}" tests="1"><testcase file="${file}" name="old">`
      + `<failure message="assertion failed"><![CDATA[expected <testcase name="ghost"/> to be absent]]></failure>`
      + '</testcase></testsuite></testsuites>';
    const withCdata = aggregateGateTestShards(shards, [attempt(1, cdata, cdata), attempt(2, b, b, 0, 0), attempt(3, c, c, 0, 0)]);
    expect(withCdata.retryShardIds).toEqual([]);
    expect(withCdata.report?.failures.find((failure) => failure.name.endsWith('> old'))?.attribution).toBe('preexisting');
    const complete = junit(file, [{ name: 'ok' }]);
    const truncated = `${complete}\n<truncated`;
    expect(aggregateGateTestShards(shards, [attempt(1, truncated, complete, 0, 0), attempt(2, b, b, 0, 0), attempt(3, c, c, 0, 0)]))
      .toEqual({ status: 'unmeasured', retryShardIds: ['shard-1'] });
  });

  test('incomplete or contradictory JUnit cannot turn a missing case into a green result', () => {
    const a = junit('test/a.test.ts', [{ name: 'old', failed: true }]);
    const b = junit('test/b.test.ts', [{ name: 'ok' }]);
    const c = junit('test/c.test.ts', [{ name: 'ok' }]);
    const all = [attempt(1, a, a), attempt(2, b, b, 0, 0), attempt(3, c, c, 0, 0)];
    expect(aggregateGateTestShards(shards, all.map((entry, i) => i === 0 ? { ...entry, currentJUnit: a.replace('tests="1"', 'tests="2"') } : entry)).retryShardIds).toEqual(['shard-1']);
    expect(aggregateGateTestShards(shards, all.map((entry, i) => i === 1 ? { ...entry, currentExitCode: 1 } : entry)).retryShardIds).toEqual(['shard-2']);
    expect(aggregateGateTestShards(shards, all.slice(0, 2)).retryShardIds).toEqual(['shard-3']);
    expect(aggregateGateTestShards(shards, all.map((entry, i) => i === 0 ? { ...entry, currentJUnit: a.replace('</testsuite>', '') } : entry)).retryShardIds).toEqual(['shard-1']);
  });

  test('a testcase inherits its file from the enclosing suite, including nested suites', () => {
    const file = 'test/a.test.ts';
    const direct = `<testsuite file="${file}" tests="1"><testcase name="ok"/></testsuite>`;
    expect(aggregateGateTestShards([shards[0]!], [attempt(1, direct, direct, 0, 0)]))
      .toEqual({ status: 'passed', retryShardIds: [] });
    const nested = `<testsuites tests="1"><testsuite file="${file}" tests="1">`
      + '<testsuite tests="1"><testcase name="ok"/></testsuite></testsuite></testsuites>';
    expect(aggregateGateTestShards([shards[0]!], [attempt(1, nested, nested, 0, 0)]))
      .toEqual({ status: 'passed', retryShardIds: [] });
  });

  test('actual bun test JUnit marks the completed shard done without retry', () => {
    const file = 'src/self-dev/shard-plan.test.ts';
    const directory = mkdtempSync(join(process.cwd(), '.shard-junit-'));
    try {
      const report = join(directory, 'report.xml');
      const run = Bun.spawnSync(['bun', 'test', file, '--reporter=junit', `--reporter-outfile=${report}`], {
        cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
      });
      expect(run.exitCode).toBe(0);
      const xml = readFileSync(report, 'utf8');
      expect(xml).toContain(`<testsuite name="${file}" file="${file}"`);
      expect(xml).toContain('<testcase name=');
      const only = [{ id: 'shard-1', files: [file], plannedRssMb: 1, plannedSeconds: 1 }];
      const result = aggregateGateTestShards(only, [
        { shardId: 'shard-1', attempt: 1, currentJUnit: xml, baselineJUnit: xml, currentExitCode: 0, baselineExitCode: 0 },
      ]);
      expect(result).toEqual({ status: 'passed', retryShardIds: [] });
      // The suite owns the file even if a JUnit emitter omits it on individual cases.
      const suiteOwned = xml.replace(/(<testcase\b[^>]*?) file="[^"]*"/g, '$1');
      expect(aggregateGateTestShards(only, [
        { shardId: 'shard-1', attempt: 1, currentJUnit: suiteOwned, baselineJUnit: suiteOwned, currentExitCode: 0, baselineExitCode: 0 },
      ]).retryShardIds).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a case skipped now but passed at base is counted unknown, not unmeasured — skips no longer void the shard, but a skip must not hide a regression (TC decision 10-10 · LIGHT-RC-MEASURE ②)', () => {
    const file = 'test/a.test.ts';
    const full = junit(file, [{ name: 'ran' }, { name: 'required' }]);
    const skipped = full.replace(`<testcase file="${file}" name="required"></testcase>`,
      `<testcase file="${file}" name="required"><skipped/></testcase>`);
    const result = aggregateGateTestShards([shards[0]!], [attempt(1, skipped, full, 0, 0)]);
    expect(result.status).toBe('failed');
    expect(result.retryShardIds).toEqual([]);
    expect(result.report).toMatchObject({ introduced: 0, unknown: 1 });
    expect(result.report?.failures.map((failure) => [failure.name, failure.attribution])).toEqual([[`${file} > required`, 'unknown']]);
  });

  test('signal or exit 137 requires reassignment even with complete preexisting failure JUnit', () => {
    const file = 'test/a.test.ts';
    const failed = junit(file, [{ name: 'old', failed: true }]);
    const healthy = attempt(1, failed, failed);
    expect(aggregateGateTestShards([shards[0]!], [{ ...healthy, currentExitCode: 137 }]))
      .toEqual({ status: 'unmeasured', retryShardIds: ['shard-1'] });
    expect(aggregateGateTestShards([shards[0]!], [{ ...healthy, baselineSignal: 'SIGKILL' }]))
      .toEqual({ status: 'unmeasured', retryShardIds: ['shard-1'] });
  });

  test('sibling suites for one file sum declarations without counting nested parent twice', () => {
    const file = 'test/a.test.ts';
    const xml = `<testsuites tests="2"><testsuite file="${file}" tests="1">`
      + `<testcase file="${file}" name="first"/>` + '</testsuite>'
      + `<testsuite file="${file}" tests="1"><testcase file="${file}" name="second"/></testsuite></testsuites>`;
    expect(aggregateGateTestShards([shards[0]!], [attempt(1, xml, xml, 0, 0)]))
      .toEqual({ status: 'passed', retryShardIds: [] });
    const incomplete = xml.replace('name="second"/>', 'name="second"/><testcase file="test/b.test.ts" name="alien"/>');
    expect(aggregateGateTestShards([shards[0]!], [attempt(1, incomplete, xml, 0, 0)]).retryShardIds)
      .toEqual(['shard-1']);
  });

  test('standard JUnit error counts separately from failures at root and suite and contributes to attribution', () => {
    const file = 'test/a.test.ts';
    const current = `<testsuites tests="1" failures="0" errors="1"><testsuite file="${file}" tests="1" failures="0" errors="1">`
      + `<testcase name="broken"><error message="load error"/></testcase></testsuite></testsuites>`;
    const baseline = `<testsuites tests="1" failures="0" errors="0"><testsuite file="${file}" tests="1" failures="0" errors="0">`
      + '<testcase name="broken"/></testsuite></testsuites>';
    const result = aggregateGateTestShards([shards[0]!], [attempt(1, current, baseline, 1, 0)]);
    expect(result.retryShardIds).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.report).toMatchObject({ introduced: 1, preexisting: 0 });
    expect(result.report?.failures[0]).toMatchObject({ attribution: 'introduced' });
  });

  test('contradictory suite failure and error totals cannot complete even with exit 0', () => {
    const file = 'test/a.test.ts';
    const good = `<testsuites tests="1" failures="0" errors="0"><testsuite file="${file}" tests="1" failures="0" errors="0">`
      + '<testcase name="ok"/></testsuite></testsuites>';
    for (const attribute of ['failures', 'errors'] as const) {
      const bad = good.replace(`<testsuite file="${file}" tests="1" failures="0" errors="0"`,
        `<testsuite file="${file}" tests="1" failures="${attribute === 'failures' ? 1 : 0}" errors="${attribute === 'errors' ? 1 : 0}"`);
      expect(aggregateGateTestShards([shards[0]!], [attempt(1, bad, good, 0, 0)]))
        .toEqual({ status: 'unmeasured', retryShardIds: ['shard-1'] });
    }
    const wrongRoot = good.replace('<testsuites tests="1" failures="0" errors="0">',
      '<testsuites tests="1" failures="0" errors="1">');
    expect(aggregateGateTestShards([shards[0]!], [attempt(1, wrongRoot, good, 0, 0)]).retryShardIds)
      .toEqual(['shard-1']);
  });

  test('nested suite totals include descendant failure/error cases without double counting', () => {
    const file = 'test/a.test.ts';
    const report = `<testsuites tests="2" failures="1" errors="1"><testsuite file="${file}" tests="2" failures="1" errors="1">`
      + '<testsuite tests="1" failures="1" errors="0"><testcase name="assert"><failure/></testcase></testsuite>'
      + '<testsuite tests="1" failures="0" errors="1"><testcase name="throw"><error/></testcase></testsuite>'
      + '</testsuite></testsuites>';
    const result = aggregateGateTestShards([shards[0]!], [attempt(1, report, report)]);
    expect(result.retryShardIds).toEqual([]);
    expect(result.status).toBe('passed');
    expect(result.report).toMatchObject({ introduced: 0, preexisting: 2 });
    const wrongParent = report.replace(`file="${file}" tests="2" failures="1" errors="1"`,
      `file="${file}" tests="2" failures="1" errors="0"`);
    expect(aggregateGateTestShards([shards[0]!], [attempt(1, wrongParent, report)]).retryShardIds)
      .toEqual(['shard-1']);
  });

  test('JUnit base pass plus current timeout retains the existing passed-at-base classification', () => {
    const file = 'test/a.test.ts';
    const current = junit(file, [{ name: 'slow', failed: true, timeout: true }]);
    const baseline = junit(file, [{ name: 'slow' }]);
    const result = aggregateGateTestShards([shards[0]!], [attempt(1, current, baseline, 1, 0)]);
    expect(result.status).toBe('failed');
    expect(result.report).toMatchObject({ introduced: 1, timeoutPassedAtBase: 1 });
    expect(result.report?.failures[0]).toMatchObject({ attribution: 'introduced', timeoutRegression: 'passed-at-base' });
  });
});
