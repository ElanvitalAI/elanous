import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJunitFileSeconds } from './gate-method';
import { readFileDurations } from './shard-plan';
import { createGateRunner, graphGateResult, judgeGate, readBaselineFileCache, readIsolatedRun } from './gate-node';
import { formatGateTiming, gateTiming } from './gate-timing';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('reads outer file suite time instead of nested describe time, including self-closing file suites', () => {
  const xml = '<testsuites><testsuite file="src/a&amp;b.test.ts" time="8"><testsuite file="src/nested.test.ts" time="90"><testcase name="case" time="2"/></testsuite></testsuite><testsuite time="10"><testsuite file="src/hidden.test.ts" time="40"/></testsuite><testsuite file="src/empty.test.ts" time="0"/></testsuites>';
  expect([...readJunitFileSeconds(xml)]).toEqual([['src/a&b.test.ts', 8], ['src/empty.test.ts', 0]]);
});

test('ignores invalid, negative, and missing top-level times and keeps the largest duplicate', () => {
  const xml = '<testsuite file="src/a.test.ts" time="2"/><testsuite file="src/a.test.ts" time="3"/><testsuite file="src/b.test.ts" time="NaN"/><testsuite file="src/c.test.ts" time="-1"/><testsuite file="src/d.test.ts"/>';
  expect([...readJunitFileSeconds(xml)]).toEqual([['src/a.test.ts', 3]]);
});

test('CDATA and comments cannot close a file suite or promote its nested suites', () => {
  const xml = `<testsuites>
    <testsuite file="src/outer.test.ts" time="8">
      <system-out><![CDATA[</testsuite><testsuite file="src/fake.test.ts" time="99"/>]]></system-out>
      <!-- </testsuite><testsuite file="src/comment.test.ts" time="98"/> -->
      <testsuite file="src/inner.test.ts" time="90"/>
    </testsuite>
    <testsuite file="src/next.test.ts" time="2"/>
  </testsuites>`;
  expect([...readJunitFileSeconds(xml)]).toEqual([['src/outer.test.ts', 8], ['src/next.test.ts', 2]]);
});

test('shard-plan uses outer suite times across reports and excludes nested suites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-method-'));
  scratch.push(dir);
  writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts" time="8"><testsuite file="src/inner.test.ts" time="100"/></testsuite><testsuite file="src/b.test.ts" time="2"/></testsuites>');
  writeFileSync(join(dir, 'pod-1.junit.xml'), '<testsuite file="src/a.test.ts" time="4"/>');
  expect([...readFileDurations(dir)]).toEqual([['src/a.test.ts', 8], ['src/b.test.ts', 2]]);
});

const CUT = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FILE = 'src/x.test.ts';
const summary = (rc: number, ran = true) => ({ rc, output: `3 pass\n0 fail\n${ran ? 'Ran 3 tests across 1 file.\n' : ''}` });

function gateFixture(cutRc: number, baseRc: number, cutRan = true) {
  const root = mkdtempSync(join(tmpdir(), 'gate-method-verdict-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const command: ReturnType<typeof createGateRunner>['command'] = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'install') return { rc: 0, output: '' };
    if (cmd === 'bun' && args[0] === 'run') return cwd.endsWith('/cut') ? summary(cutRc, cutRan) : summary(baseRc);
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: `${FILE}\n` };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'rg') return { rc: 1, output: '' };
    return { rc: 0, output: '' };
  };
  const podCommand: Parameters<typeof createGateRunner>[3] = async () => {
    const dir = join(root, 'job');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shard.log'), `${FILE}:\n(fail) A [1.00ms]\n2 pass\n1 fail\nRan 3 tests across 1 file.\n`);
    writeFileSync(join(dir, 'shard.rc'), '1\n');
    return { exitCode: 0, artifactsDir: dir, job: 'fake' };
  };
  const runner = createGateRunner(repo, undefined, command, podCommand,
    new PodPoolScheduler([{ context: 'pool-test', capacity: 1, k3dCluster: 'test' }]));
  runner.add = async () => {};
  runner.snapshot = async () => {};
  runner.remove = async () => {};
  runner.removeSnapshot = async () => {};
  return { root, runner, opts: { commit: CUT, version: '0.2.24', baselineVersion: '0.2.23', baselineCommit: BASE,
    repo, instanceRoot: root, ledgerRoot: root, pod: { pool: 'pool-test', shards: 1 } } };
}

test('cut and baseline rc 1 with zero failures are preexisting, not a gate error; cache retains the id', async () => {
  const { root, runner, opts } = gateFixture(1, 1);
  const result = await judgeGate(opts, runner);
  expect(result.outcome).toBe('ok');
  expect(result.error).toBeUndefined();
  expect(result.introduced).toEqual([]);
  expect(result.rcNonzeroNoFailures).toEqual([{ file: FILE, rc: 1, pass: 3, baseline: 'same' }]);
  expect(graphGateResult(result, false).summary).toContain('⚠ 종료코드만 비영 1');
  expect(readBaselineFileCache(root, BASE).get(`${FILE}\0local`)?.errors).toEqual([`${FILE} > [rc-nonzero]`]);
  const again = await judgeGate(opts, runner);
  expect(again.outcome).toBe('ok');
  expect(again.baselineCache?.hits).toBe(1);
  expect(again.rcNonzeroNoFailures[0]?.baseline).toBe('same');
});

test('baseline clean rc 0 leaves the cut rc-only failure introduced', async () => {
  const { runner, opts } = gateFixture(1, 0);
  const result = await judgeGate(opts, runner);
  expect(result.outcome).toBe('regression');
  expect(result.introduced).toEqual([`${FILE} > [rc-nonzero]`]);
  expect(result.rcNonzeroNoFailures).toEqual([{ file: FILE, rc: 1, pass: 3, baseline: 'clean' }]);
});

test('a clean rc 2 summary keeps the leaked-exit reading (clean), on the cut and the baseline alike', async () => {
  for (const [cutRc, baseRc] of [[2, 2], [2, 0]] as const) {
    const { runner, opts } = gateFixture(cutRc, baseRc);
    const result = await judgeGate(opts, runner);
    expect(result.outcome).toBe('ok');
    expect(result.error).toBeUndefined();
    expect(result.introduced).toEqual([]);
    expect(result.rcNonzeroNoFailures).toEqual([]);
  }
});

test('a foreign file header cannot become a requested file rc-only result or baseline cache entry', async () => {
  const foreign = { rc: 1, output: 'src/other.test.ts:\n3 pass\n0 fail\nRan 3 tests across 1 file.\n' };
  expect(() => readIsolatedRun(foreign, 'cut isolated', FILE)).toThrow('incomplete');
  const { root, runner, opts } = gateFixture(1, 1);
  const original = runner.command;
  runner.command = async (cmd, args, cwd, limitMs) =>
    cmd === 'bun' && args[0] === 'run' && cwd.endsWith('/baseline') ? foreign : original(cmd, args, cwd, limitMs);
  const result = await judgeGate(opts, runner);
  expect(result.outcome).toBe('error');
  expect(result.error).toContain('isolated run attributed to another file: src/other.test.ts');
  expect(result.rcNonzeroNoFailures).toEqual([]);
  expect(readBaselineFileCache(root, BASE).size).toBe(0);
});

test('root-level and absolute foreign file headers are also rejected; the requested file header is accepted', () => {
  for (const header of ['other.test.ts:', '/home/elsewhere/repo/src/other.test.ts:', './other.spec.tsx:', 'src/다른.test.ts:', 'src/with space/x.test.ts:', 'src/@scope+x/y.test.mts:']) {
    const run = { rc: 1, output: `${header}\n3 pass\n0 fail\nRan 3 tests across 1 file.\n` };
    expect(() => readIsolatedRun(run, 'cut isolated', FILE)).toThrow('isolated run attributed to another file');
  }
  const own = { rc: 1, output: `${FILE}:\n3 pass\n0 fail\nRan 3 tests across 1 file.\n` };
  expect(readIsolatedRun(own, 'cut isolated', FILE)).toEqual({ kind: 'rc-nonzero-no-failures', rc: 1, pass: 3 });
  const pod = { rc: 1, output: `/home/ubuntu/repo/${FILE}:\n3 pass\n0 fail\nRan 3 tests across 1 file.\n` };
  expect(readIsolatedRun(pod, 'cut isolated', FILE)).toEqual({ kind: 'rc-nonzero-no-failures', rc: 1, pass: 3 });
});

test('a foreign cut file header cannot seed the cut cache or reach baseline comparison', async () => {
  const { root, runner, opts } = gateFixture(1, 1);
  const original = runner.command;
  let baselineRuns = 0;
  runner.command = async (cmd, args, cwd, limitMs) => {
    if (cmd === 'bun' && args[0] === 'run' && cwd.endsWith('/cut'))
      return { rc: 1, output: `./src/other.test.ts:\n3 pass\n0 fail\nRan 3 tests across 1 file.\n` };
    if (cmd === 'bun' && args[0] === 'run' && cwd.endsWith('/baseline')) baselineRuns++;
    return original(cmd, args, cwd, limitMs);
  };
  const result = await judgeGate(opts, runner);
  expect(result.outcome).toBe('error');
  expect(result.error).toContain('isolated run attributed to another file: src/other.test.ts');
  expect(result.rcNonzeroNoFailures).toEqual([]);
  expect(baselineRuns).toBe(0);
  expect(readBaselineFileCache(root, CUT).size).toBe(0);
});

test('an isolated rc 1 without Ran summary remains incomplete', async () => {
  const { runner, opts } = gateFixture(1, 1, false);
  const result = await judgeGate(opts, runner);
  expect(result.outcome).toBe('error');
  expect(result.error).toContain('incomplete');
});

test('readIsolatedRun preserves incomplete summaries, zero tests, multiple files, mismatched names and unattributed errors', () => {
  expect(readIsolatedRun(summary(1), 'isolated', FILE)).toEqual({ kind: 'rc-nonzero-no-failures', rc: 1, pass: 3 });
  expect(readIsolatedRun(summary(0), 'isolated', FILE)).toEqual({ kind: 'read', failures: [], errors: [] });
  expect(readIsolatedRun(summary(2), 'isolated', FILE)).toEqual({ kind: 'read', failures: [], errors: [] });
  for (const output of ['0 fail\nRan 3 tests across 1 file.\n', '2 pass\n0 fail\nRan 3 tests across 1 file.\n']) {
    expect(() => readIsolatedRun({ rc: 1, output }, 'isolated', FILE)).toThrow('incomplete');
  }
  expect(readIsolatedRun({ rc: 1, output: `${FILE}:\n(fail) A [1.00ms]\n2 pass\n1 fail\nRan 3 tests across 1 file.\n` }, 'isolated', FILE))
    .toEqual({ kind: 'read', failures: [`${FILE} > A`], errors: [] });
  for (const output of ['3 pass\n0 fail\n', '0 pass\n0 fail\nRan 0 tests across 1 file.\n',
    '3 pass\n0 fail\nRan 3 tests across 2 files.\n',
    '3 pass\n1 fail\nRan 3 tests across 1 file.\n',
    `${FILE}:\n(fail) A [1.00ms]\n(fail) A [2.00ms]\n1 pass\n2 fail\nRan 3 tests across 1 file.\n`,
    '3 pass\n0 fail\n# Unhandled error between tests\nRan 3 tests across 1 file.\n',
    '3 pass\n0 fail\n  # Unhandled error between tests\nRan 3 tests across 1 file.\n']) {
    expect(() => readIsolatedRun({ rc: 1, output }, 'isolated', FILE)).toThrow('incomplete');
  }
});

test('baseline missing is distinguished from a clean baseline', async () => {
  const { runner, opts } = gateFixture(1, 1);
  const original = runner.command;
  runner.command = async (cmd, args, cwd, limitMs) => {
    if (cmd === 'bun' && args[0] === 'run' && cwd.endsWith('/baseline')) return { rc: 1, output: 'No tests found' };
    return original(cmd, args, cwd, limitMs);
  };
  const result = await judgeGate(opts, runner);
  expect(result.outcome).toBe('regression');
  expect(result.rcNonzeroNoFailures).toEqual([{ file: FILE, rc: 1, pass: 3, baseline: 'missing' }]);
  expect(result.introduced).toEqual([`${FILE} > [rc-nonzero]`]);
});

test('a real bun run that passes but exits 1 is read as rc-nonzero-no-failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-method-real-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/leak.test.ts'), "import { test, expect } from 'bun:test';\ntest('a', () => { expect(1).toBe(1); });\ntest('b', () => { process.exitCode = 1; expect(2).toBe(2); });\n");
  const run = spawnSync(process.execPath, ['test', './src/leak.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  expect(run.status).toBe(1);
  expect(readIsolatedRun({ rc: run.status!, output: `${run.stdout}\n${run.stderr}` }, 'cut isolated', 'src/leak.test.ts'))
    .toEqual({ kind: 'rc-nonzero-no-failures', rc: 1, pass: 2 });
}, 60_000);
