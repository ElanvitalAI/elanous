/** LIGHT-RC-MEASURE (0.2.23) — the sharded gate behind `release light-rc` came back «못 쟀다» for every shard:
 *  ① a shard holding a test file absent from the baseline tree could never yield a complete baseline JUnit,
 *  ② one `<skipped/>` case voided its whole shard, and ③ the reason never reached the light-rc result. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runSelfGateCli, type SelfGateCliResult } from '../self-implement/gate-cli.js';
import type { DispatchDeps, DispatchOptions } from '../self-implement/gate-remote.js';
import type { withBaselineWorktree } from '../self-implement/gate-baseline.js';
import { aggregateGateTestShards } from '../self-dev/shard-aggregate.js';
import { runShardedGateTests, type ShardProcess } from '../self-dev/shard-run.js';
import { formatLightRc, runLightRc, type LightRcDeps } from './light-rc.js';

const REPO = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const junit = (cases: readonly { file: string; name: string; skipped?: boolean }[]) => {
  const files = [...new Set(cases.map((c) => c.file))];
  return `<testsuites tests="${cases.length}">` + files.map((file) => {
    const own = cases.filter((c) => c.file === file);
    return `<testsuite file="${file}" tests="${own.length}" failures="0">`
      + own.map((c) => `<testcase file="${file}" name="${c.name}">${c.skipped ? '<skipped/>' : ''}</testcase>`).join('')
      + '</testsuite>';
  }).join('') + '</testsuites>';
};

describe('① a test file absent from the baseline tree', () => {
  test('the baseline side runs only the files the base has, and the shard is measured (passed)', () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-lrm-base-'));
    dirs.push(base);
    const old = 'test/old.test.ts';
    const added = 'test/new.test.ts';
    mkdirSync(join(base, 'test'));
    writeFileSync(join(base, old), "import { test } from 'bun:test'; test('old', () => {});\n");
    const calls: Array<{ cwd: string; files: string[] }> = [];
    const run: ShardProcess = (cwd, files) => {
      calls.push({ cwd, files: [...files] });
      return { exitCode: 0, junit: junit(files.map((file) => ({ file, name: `case-${file}` }))), rssMb: 100, seconds: 1 };
    };
    const baseline = ((_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit(base)) as typeof withBaselineWorktree;
    const result = runShardedGateTests('/head', [old, added], 'HEAD', 1, run, baseline, 8);
    expect(result.aggregate.status).toBe('passed');
    expect(result.shards).toHaveLength(1);
    const baselineCalls = calls.filter((call) => call.cwd === base);
    expect(baselineCalls).toEqual([{ cwd: base, files: [old] }]);
    expect(baselineCalls.some((call) => call.files.includes(added))).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.baselineFiles).toEqual([old]);
  });

  test('a shard whose every file is new skips the baseline run and still measures', () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-lrm-base-'));
    dirs.push(base);
    const added = 'test/new.test.ts';
    const calls: string[] = [];
    const run: ShardProcess = (cwd, files) => {
      calls.push(cwd);
      return { exitCode: 0, junit: junit(files.map((file) => ({ file, name: 'x' }))), rssMb: 100, seconds: 1 };
    };
    const baseline = ((_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit(base)) as typeof withBaselineWorktree;
    const result = runShardedGateTests('/head', [added], 'HEAD', 1, run, baseline, 8);
    expect(calls.filter((cwd) => cwd === base)).toEqual([]);
    expect(result.attempts[0]!.baselineFiles).toEqual([]);
    expect(result.aggregate.status).toBe('passed');
  });

  test('a directory at the baseline path is not the baseline test file (review r1)', () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-lrm-base-'));
    dirs.push(base);
    const added = 'test/new.test.ts';
    mkdirSync(join(base, added), { recursive: true });
    const calls: string[] = [];
    const run: ShardProcess = (cwd, files) => {
      calls.push(cwd);
      return { exitCode: 0, junit: junit(files.map((file) => ({ file, name: 'x' }))), rssMb: 100, seconds: 1 };
    };
    const baseline = ((_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit(base)) as typeof withBaselineWorktree;
    const result = runShardedGateTests('/head', [added], 'HEAD', 1, run, baseline, 8);
    expect(result.attempts[0]!.baselineFiles).toEqual([]);
    expect(calls.filter((cwd) => cwd === base)).toEqual([]);
    expect(result.aggregate.status).toBe('passed');
  });

  test('an unreadable baseline path is not read as absent — the file stays in the baseline run (review r2)', () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-lrm-base-'));
    dirs.push(base);
    const locked = 'locked/a.test.ts';
    mkdirSync(join(base, 'locked'));
    writeFileSync(join(base, locked), "import { test } from 'bun:test'; test('a', () => {});\n");
    chmodSync(join(base, 'locked'), 0o000);
    try {
      // The case under test is a stat error other than ENOENT/ENOTDIR — prove this host actually raises one (root would not).
      let code: string | undefined;
      try { statSync(join(base, locked)); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
      expect(code).toBe('EACCES');
      const calls: Array<{ cwd: string; files: string[] }> = [];
      const run: ShardProcess = (cwd, files) => {
        calls.push({ cwd, files: [...files] });
        return { exitCode: 0, junit: junit(files.map((file) => ({ file, name: 'a' }))), rssMb: 100, seconds: 1 };
      };
      const baseline = ((_cwd: string, _ref: string, visit: (dir: string) => unknown) => visit(base)) as typeof withBaselineWorktree;
      const result = runShardedGateTests('/head', [locked], 'HEAD', 1, run, baseline, 8);
      expect(result.attempts[0]!.baselineFiles).toEqual([locked]);
      expect(calls.filter((call) => call.cwd === base)).toEqual([{ cwd: base, files: [locked] }]);
    } finally {
      chmodSync(join(base, 'locked'), 0o755);
    }
  });

  test('a new file failing now goes through the existing classifier (new at HEAD ⇒ introduced)', () => {
    const shard = { id: 'shard-1', files: ['test/old.test.ts', 'test/new.test.ts'], plannedRssMb: 1, plannedSeconds: 1 };
    const current = '<testsuites tests="2"><testsuite file="test/old.test.ts" tests="1"><testcase file="test/old.test.ts" name="old"></testcase></testsuite>'
      + '<testsuite file="test/new.test.ts" tests="1" failures="1"><testcase file="test/new.test.ts" name="fresh"><failure message="assertion failed"/></testcase></testsuite></testsuites>';
    const result = aggregateGateTestShards([shard], [{
      shardId: 'shard-1', attempt: 1, currentJUnit: current, baselineJUnit: junit([{ file: 'test/old.test.ts', name: 'old' }]),
      currentExitCode: 1, baselineExitCode: 0, baselineFiles: ['test/old.test.ts'],
    }]);
    expect(result.status).toBe('failed');
    expect(result.report).toMatchObject({ introduced: 1, preexisting: 0 });
  });

  test('a dead or report-less baseline side is still unmeasured', () => {
    const shard = { id: 'shard-1', files: ['test/old.test.ts'], plannedRssMb: 1, plannedSeconds: 1 };
    const ok = junit([{ file: 'test/old.test.ts', name: 'old' }]);
    const base = { shardId: 'shard-1', attempt: 1, currentJUnit: ok, baselineJUnit: ok, currentExitCode: 0, baselineExitCode: 0, baselineFiles: ['test/old.test.ts'] };
    expect(aggregateGateTestShards([shard], [{ ...base, baselineSignal: 'SIGKILL' }]).status).toBe('unmeasured');
    expect(aggregateGateTestShards([shard], [{ ...base, baselineJUnit: undefined }]).status).toBe('unmeasured');
    expect(aggregateGateTestShards([shard], [{ ...base, baselineJUnit: '<testsuites' }]).status).toBe('unmeasured');
    expect(aggregateGateTestShards([shard], [{ ...base, baselineFiles: ['test/elsewhere.test.ts'] }]).status).toBe('unmeasured');
  });
});

describe('② skipped cases', () => {
  const shard = { id: 'shard-1', files: ['test/a.test.ts'], plannedRssMb: 1, plannedSeconds: 1 };
  const file = 'test/a.test.ts';

  test('the same case skipped on both sides, the rest passing ⇒ passed', () => {
    const both = junit([{ file, name: 'ran' }, { file, name: 'env-only', skipped: true }]);
    const result = aggregateGateTestShards([shard], [{ shardId: 'shard-1', attempt: 1, currentJUnit: both, baselineJUnit: both, currentExitCode: 0, baselineExitCode: 0 }]);
    expect(result).toEqual({ status: 'passed', retryShardIds: [] });
  });

  test('passed at base but skipped now ⇒ report.unknown 1 (never green)', () => {
    const current = junit([{ file, name: 'ran' }, { file, name: 'hidden', skipped: true }]);
    const baseline = junit([{ file, name: 'ran' }, { file, name: 'hidden' }]);
    const result = aggregateGateTestShards([shard], [{ shardId: 'shard-1', attempt: 1, currentJUnit: current, baselineJUnit: baseline, currentExitCode: 0, baselineExitCode: 0 }]);
    expect(result.status).toBe('failed');
    expect(result.report?.unknown).toBe(1);
    expect(result.report?.introduced).toBe(0);
  });

  test('skipped-now regression on top of a real failure adds to the same report', () => {
    const current = '<testsuites tests="3"><testsuite file="test/a.test.ts" tests="3" failures="1">'
      + '<testcase file="test/a.test.ts" name="ran"></testcase><testcase file="test/a.test.ts" name="hidden"><skipped/></testcase>'
      + '<testcase file="test/a.test.ts" name="broke"><failure message="assertion failed"/></testcase></testsuite></testsuites>';
    const baseline = junit([{ file, name: 'ran' }, { file, name: 'hidden' }, { file, name: 'broke' }]);
    const result = aggregateGateTestShards([shard], [{ shardId: 'shard-1', attempt: 1, currentJUnit: current, baselineJUnit: baseline, currentExitCode: 1, baselineExitCode: 0 }]);
    expect(result.status).toBe('failed');
    expect(result.report).toMatchObject({ introduced: 1, unknown: 1 });
  });
});

describe('repeated case names (test.each rows · same-named cases in one describe)', () => {
  const shard = { id: 'shard-1', files: ['test/a.test.ts'], plannedRssMb: 1, plannedSeconds: 1 };
  const repeated = (failSecond: boolean) => '<testsuites tests="3"><testsuite file="test/a.test.ts" tests="3" failures="' + (failSecond ? 1 : 0) + '">'
    + '<testcase file="test/a.test.ts" classname="each" name="row %s"></testcase>'
    + `<testcase file="test/a.test.ts" classname="each" name="row %s">${failSecond ? '<failure message="assertion failed"/>' : ''}</testcase>`
    + '<testcase file="test/a.test.ts" classname="each" name="other"></testcase></testsuite></testsuites>';

  test('are told apart by order instead of voiding the shard', () => {
    const ok = repeated(false);
    expect(aggregateGateTestShards([shard], [{ shardId: 'shard-1', attempt: 1, currentJUnit: ok, baselineJUnit: ok, currentExitCode: 0, baselineExitCode: 0 }]))
      .toEqual({ status: 'passed', retryShardIds: [] });
  });

  test('a repeat that fails only now is introduced, by its ordinal', () => {
    const result = aggregateGateTestShards([shard], [{ shardId: 'shard-1', attempt: 1, currentJUnit: repeated(true), baselineJUnit: repeated(false), currentExitCode: 1, baselineExitCode: 0 }]);
    expect(result.status).toBe('failed');
    expect(result.report).toMatchObject({ introduced: 1, unknown: 0 });
    expect(result.report?.failures.map((failure) => failure.name)).toEqual(['test/a.test.ts > each > row %s #2']);
  });
});

describe('③ the unmeasured reason reaches the light-rc result', () => {
  const REASON = 'shard-2 signal SIGTERM';
  const gate = (over: Partial<SelfGateCliResult> = {}): SelfGateCliResult => ({
    exitCode: 1, lines: ['[self gate] fake'], changedFiles: [], testFiles: [], unverified: [], documentPaths: [],
    documentsWithoutDerivedTests: [], alwaysIncludeMissing: [], ...over,
  });
  const deps = (over: Partial<LightRcDeps>): LightRcDeps => ({
    cwd: REPO, git: () => ({ rc: 0, stdout: 'abc123\n' }), previousVersion: () => '0.2.22', ...over,
  });

  test('self gate --shards: the unmeasured line text is also on the result (unmeasuredReason)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-lrm-gate-'));
    dirs.push(cwd);
    writeFileSync(join(cwd, 'a.test.ts'), 'test("x", () => {});\n');
    const result = runSelfGateCli(cwd, { base: 'base-sha', shards: 2, alwaysInclude: ['a.test.ts'] }, {
      changedFiles: () => ({ files: [], baseRef: 'base-sha' }),
      runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0, runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runShards: () => ({ shards: [], attempts: [], aggregate: { status: 'unmeasured', retryShardIds: ['shard-2'] } }),
    });
    expect(result.baseline).toBeUndefined();
    expect(result.unmeasuredReason).toBe('shard-2');
    expect(result.lines).toContain(`shards: unmeasured (${result.unmeasuredReason})`);
  });

  test('local path: result.unmeasured carries the gate reason and the summary prints it', async () => {
    const result = await runLightRc('0.2.23', { base: 'abc123', local: true, log: () => {} }, deps({
      runGate: () => gate({ unmeasuredReason: REASON }),
      dispatch: async (opts: DispatchOptions) => opts.runLocal(),
    }));
    expect(result.introduced).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.unmeasured).toBe(REASON);
    const lines = formatLightRc(result);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.trim().startsWith('shards: unmeasured (')).toBe(true);
    expect(lines[2]).toContain(REASON);
  });

  test('remote path: the reason is read from the child JSON', async () => {
    const result = await runLightRc('0.2.23', { base: 'abc123', log: () => {} }, deps({
      dispatch: async (_opts: DispatchOptions, dispatchDeps?: DispatchDeps) => {
        dispatchDeps!.write!.out(`${JSON.stringify({ ok: false, introduced: null, preexisting: null, unclassified: null, alwaysIncludeMissing: [], gateExitCode: 1, remote: null, unmeasured: REASON, host: 'node-b' })}\n`);
        return 1;
      },
    }));
    expect(result.unmeasured).toBe(REASON);
    expect(result.ok).toBe(false);
    expect(formatLightRc(result).some((line) => line.trim().startsWith(`shards: unmeasured (${REASON})`))).toBe(true);
  });

  test('end to end: the child CLI --json carries unmeasured, and the parent reads that line', async () => {
    const out: string[] = [];
    const priorExitCode = process.exitCode;
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = new Command();
      registerReleaseCommands(cmd, {}, {}, {}, deps({
        runGate: () => gate({ unmeasuredReason: REASON }),
        dispatch: async (opts: DispatchOptions) => opts.runLocal(),
      }));
      await cmd.parseAsync(['release', 'light-rc', '--version', '0.2.23', '--base', 'abc123', '--local', '--json'], { from: 'user' });
    } finally { write.mockRestore(); err.mockRestore(); log.mockRestore(); process.exitCode = priorExitCode; }
    const childLine = out.join('');
    expect(JSON.parse(childLine)).toMatchObject({ ok: false, introduced: null, unmeasured: REASON });
    const parent = await runLightRc('0.2.23', { base: 'abc123', log: () => {} }, deps({
      dispatch: async (_opts: DispatchOptions, dispatchDeps?: DispatchDeps) => { dispatchDeps!.write!.out(childLine); return 1; },
    }));
    expect(parent.unmeasured).toBe(REASON);
  });

  test('a measured gate leaves unmeasured null and prints no third line', async () => {
    const result = await runLightRc('0.2.23', { base: 'abc123', local: true, log: () => {} }, deps({
      runGate: () => gate({ exitCode: 0, baseline: { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 } }),
      dispatch: async (opts: DispatchOptions) => opts.runLocal(),
    }));
    expect(result.unmeasured).toBeNull();
    expect(result.ok).toBe(true);
    expect(formatLightRc(result)).toHaveLength(2);
  });
});
