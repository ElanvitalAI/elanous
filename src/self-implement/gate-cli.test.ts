import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { runIsolationHardcodeGate } from '../../scripts/ci-isolation-hardcode-gate.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';
import { audit as auditEntryBudget, INDEX_MODULE_LIMIT } from '../../scripts/ratchets/next-tui-entry-budget.js';
import { landingHistoryLogArgs } from '../cli/pr-granularity.js';
import {
  classifyDirtyWorktreePaths,
  formatPartialObservationNote,
  formatPrFileOverlapObservation,
  formatPrWorktreeObservation,
  formatUnlistedSpawnLaneTests,
  formatUnrunImporterTests,
  observePrFileOverlap,
  observePrWorktreeDirtiness,
  parseDirtyWorktreePaths,
  runSelfGateCli as runSelfGateCliProduction,
  runSelfGateCliAsync as runSelfGateCliAsyncProduction,
  selectGateTestFiles, formatUnrunnableChangeKinds,
} from './gate-cli.js';
import { GATE_CALLER_TEST_LIMIT } from './gate-scope.js';
import { buildGateBaselineReport, type BaselineProcessResult } from './gate-baseline.js';
import type { ShardRunResult } from '../self-dev/shard-run.js';
import { aggregateGateTestShards } from '../self-dev/shard-aggregate.js';
import { GATE_SPAWN_LANE_FILES } from '../self-dev/spawn-lane-files.js';

const baseline = (output: string, status: BaselineProcessResult['status'] = 'test-fail'): BaselineProcessResult => ({ status, output, log: 'baseline' });
const fail = (name: string) => ({ status: 1, stdout: `test/a.test.ts:\n(fail) ${name}\n1 fail\n`, stderr: '' });
const originalEnv = { ...process.env };
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
type CommandResult = ReturnType<typeof ok>;
const importerLookup = (stdout = ''): [string, string[], CommandResult] => ['git', ['grep', '-l', '-e', '', '--', '*.test.ts', '*.test.tsx', '*.test.mts', '*.test.mtsx', '*.test.cts', '*.test.ctsx', '*.test.js', '*.test.jsx', '*.test.mjs', '*.test.mjsx', '*.test.cjs', '*.test.cjsx'], ok(stdout)];
const lsFiles = (stdout = ''): [string, string[], CommandResult] => ['git', ['ls-files'], ok(stdout)];
const fixtureRoots: string[] = [];
const skipEntryBudgetGateForFixture = (_cwd: string, _files: readonly string[]) => ({ affected: false, errors: [] });
const runSelfGateCli = (cwd: string, options: Parameters<typeof runSelfGateCliProduction>[1] = {}, deps: Parameters<typeof runSelfGateCliProduction>[2] = {}) =>
  runSelfGateCliProduction(cwd, options, { runEntryBudgetGate: skipEntryBudgetGateForFixture, ...deps });
const runSelfGateCliAsync = (cwd: string, options: Parameters<typeof runSelfGateCliAsyncProduction>[1] = {}, deps: Parameters<typeof runSelfGateCliAsyncProduction>[2] = {}) =>
  runSelfGateCliAsyncProduction(cwd, options, { runEntryBudgetGate: skipEntryBudgetGateForFixture, ...deps });

function fixtureRepository(files: Record<string, string>, linkNodeModules = false): { cwd: string; dispose: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-gate-cli-'));
  for (const [path, content] of Object.entries(files)) {
    const file = join(cwd, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  spawnSync('git', ['init', '--quiet'], { cwd });
  spawnSync('git', ['add', '.'], { cwd });
  if (linkNodeModules) symlinkSync(join(import.meta.dir, '../../node_modules'), join(cwd, 'node_modules'), 'dir');
  fixtureRoots.push(cwd);
  return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function prCommands(metadata: Record<string, unknown>, head = 'head-sha', porcelain = ''): Array<[string, string[], CommandResult]> {
  return [
    ['gh', ['pr', 'view', '6268', '--json', 'files,baseRefOid,headRefOid,headRefName,baseRefName'], ok(JSON.stringify(metadata))],
    ['git', ['rev-parse', 'HEAD'], ok(`${head}\n`)],
    ['git', ['cat-file', '-e', 'base-sha^{commit}'], ok()],
    ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok(porcelain)],
    importerLookup(),
    lsFiles(),
  ];
}

function overlapLogCommand(baseOid: string, baseRefName: string, stdout = ''): [string, string[], CommandResult] {
  return ['git', landingHistoryLogArgs(null, `${baseOid}..${baseRefName}`), ok(stdout)];
}

function prGateCommands(
  metadata: Record<string, unknown>,
  head = 'head-sha',
  porcelain = '',
): Array<[string, string[], CommandResult]> {
  const commands = [...prCommands(metadata, head, porcelain)];
  const baseRefName = typeof metadata.baseRefName === 'string' ? metadata.baseRefName.trim() : '';
  const baseOid = typeof metadata.baseRefOid === 'string' ? metadata.baseRefOid : 'base-sha';
  if (baseRefName) commands.push(overlapLogCommand(baseOid, baseRefName));
  return commands;
}

function scriptedCommand(entries: Array<[string, string[], CommandResult]>): (command: string, args: string[]) => CommandResult {
  return (command, args) => {
    const next = entries.shift();
    expect(next).toBeDefined();
    expect([command, args]).toEqual([next![0], next![1]]);
    return next![2];
  };
}

test('read-only gate preflight selects files without running exposure, tests, baseline or policy gates', () => {
  const called: string[] = [];
  const forbidden = (name: string) => () => { called.push(name); throw new Error(`${name} must not run`); };
  const deps = {
    changedFiles: () => ({ files: ['release/public/docs/new.md'], baseRef: 'HEAD' }),
    exists: () => false,
    runCommand: forbidden('exposure command'),
    runTests: forbidden('tests'), runBaseline: forbidden('baseline'),
    runIsolationGate: forbidden('policy'), runPwaGate: forbidden('policy'),
  };
  const picked = selectGateTestFiles('/repo', {}, deps);
  expect(picked.changedFiles).toEqual(['release/public/docs/new.md']);
  expect(picked.testFiles).toEqual([]);
  expect(picked.skipTestStep).toBe(true);
  expect(called).toEqual([]);
});

describe('runSelfGateCli', () => {
  test('real 1,265-module overflow fails changed gate before skipped test step', () => {
    const fixture = fixtureRepository({
      'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } }),
      'src/index.ts': "import './budget-0000';\n",
      'src/tui/entry.ts': 'export {};\n',
      'src/tui/local.ts': 'export {};\n',
      'src/tui.ts': 'export {};\n',
      'src/dashboard/loop-scheduler.ts': 'export {};\n',
      'bin/elanous.mjs': "await import('../src/index.ts');\n",
    }, true);
    for (let i = 0; i < INDEX_MODULE_LIMIT; i += 1) {
      writeFileSync(join(fixture.cwd, `src/budget-${String(i).padStart(4, '0')}.ts`),
        i + 1 < INDEX_MODULE_LIMIT ? `import './budget-${String(i + 1).padStart(4, '0')}';\n` : 'export const last = true;\n');
    }
    const result = runSelfGateCliProduction(fixture.cwd, {}, {
      changedFiles: () => ({ files: ['src/budget-0000.ts'], baseRef: 'HEAD' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('index static module count 1265 exceeds 1264');
  });

  test('entry budget blocks affected changes before skipTestStep and retains unrelated rc', () => {
    const calls: string[][] = [];
    const deps = {
      changedFiles: () => ({ files: ['src/tui/entry.ts'], baseRef: 'HEAD' }),
      exists: () => false,
      runTests: () => { throw new Error('no test selected'); },
      runEntryBudgetGate: (_cwd: string, files: readonly string[]) => {
        calls.push([...files]);
        return { affected: true, errors: ['index static module count 1265 exceeds 1264'] };
      },
    };
    const blocked = runSelfGateCliProduction('/repo', {}, deps);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.lines.join('\n')).toContain('next-tui-entry-budget: FAIL index static module count 1265 exceeds 1264');
    expect(calls).toEqual([['src/tui/entry.ts']]);
    const skipped = runSelfGateCliProduction('/repo', {}, { ...deps, changedFiles: () => ({ files: ['docs/note.md'], baseRef: 'HEAD' }),
      runEntryBudgetGate: () => ({ affected: false, errors: [] }) });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.lines).toContain('next-tui-entry-budget: skip (unrelated changes)');
    const unmeasured = runSelfGateCliProduction('/repo', {}, { ...deps, runEntryBudgetGate: () => { throw new Error('closure unavailable'); } });
    expect(unmeasured.exitCode).toBe(1);
    expect(unmeasured.lines.join('\n')).toContain('next-tui-entry-budget: UNMEASURED closure unavailable');
  });

  test('scenario adds an importer test to the programmatic self gate and rejects a stale head', () => {
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const scenario = { version: 1, baseSha, headSha, changedFiles: ['src/a.ts'], selectedTests: [{ path: 'test/importer.test.ts', reasons: ['import'] }], coverage: { status: 'measured', unmeasured: [], reach: [{ path: 'src/a.ts', changed: [], import: ['test/importer.test.ts'], spawn: [], unmeasured: [] }] } };
    const observed: string[][] = [];
    const deps = {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: baseSha }),
      exists: (path: string) => path === 'test/importer.test.ts',
      isRegularFile: () => true,
      runCommand: (command: string, args: string[]) => command === 'git' && args[0] === 'rev-parse'
        ? ok(args[1] === 'HEAD' ? headSha : baseSha) : ok(),
      runTests: (_cwd: string, files: readonly string[]) => { observed.push([...files]); return ok(); },
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    };
    const result = runSelfGateCli('/repo', { scenario }, deps);
    expect(result.exitCode).toBe(0);
    expect(observed).toEqual([['test/importer.test.ts']]);
    expect(result.lines).toContain('scenario tests: 1 (test/importer.test.ts)');
    const dir = mkdtempSync(join(tmpdir(), 'self-scenario-'));
    try {
      const scenarioFile = join(dir, 'scenario.json');
      writeFileSync(scenarioFile, JSON.stringify(scenario));
      expect(runSelfGateCli('/repo', { scenarioFile }, deps).testFiles).toContain('test/importer.test.ts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(() => runSelfGateCli('/repo', { scenario: { ...scenario, headSha: 'c'.repeat(40) } }, deps)).toThrow('stale head/base');
    expect(() => runSelfGateCli('/repo', { scenario: { ...scenario, coverage: { ...scenario.coverage, reach: [] } } }, deps)).toThrow('reach incomplete');
    const symlinkRepo = mkdtempSync(join(tmpdir(), 'self-scenario-link-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'self-scenario-outside-'));
    try {
      mkdirSync(join(symlinkRepo, 'test'));
      const outside = join(outsideDir, 'importer.test.ts');
      writeFileSync(outside, 'test("outside", () => {})');
      symlinkSync(outside, join(symlinkRepo, 'test/importer.test.ts'));
      const { isRegularFile: _injected, ...realFileDeps } = deps;
      expect(() => runSelfGateCli(symlinkRepo, { scenario }, realFileDeps)).toThrow('selected test is not a regular file');
      rmSync(join(symlinkRepo, 'test'), { recursive: true, force: true });
      symlinkSync(outsideDir, join(symlinkRepo, 'test'), 'dir');
      expect(() => runSelfGateCli(symlinkRepo, { scenario }, realFileDeps)).toThrow('selected test is not a regular file');
    } finally {
      rmSync(symlinkRepo, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
  test('default gate routes a real child test through separated shards', () => {
    const spawnFile = 'test/preview-terminal.test.ts';
    const files = [spawnFile, 'test/ordinary.test.ts'];
    let dispatched: [string, readonly string[], string, number] | undefined;
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runTests: () => { throw new Error('direct Bun runner must not run'); },
      runShards: (cwd, selected, ref, count) => {
        dispatched = [cwd, selected, ref, count ?? 2];
        return { shards: [], attempts: [], aggregate: { status: 'passed', retryShardIds: [] } };
      },
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(dispatched).toEqual(['/repo', files, 'HEAD', 2]);
    expect(result.exitCode).toBe(0);
  });

  test('--fixed-shard-distribution is opt-in while both shard paths receive the progress observer', () => {
    const files = ['test/b.test.ts', 'test/a.test.ts', 'test/c.test.ts'];
    const calls: unknown[][] = [];
    const deps = {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runTests: () => { throw new Error('direct Bun runner must not run'); },
      runShards: ((...args: unknown[]) => {
        calls.push(args);
        return { shards: [{ id: 'shard-1', files: ['test/a.test.ts'], plannedRssMb: 0, plannedSeconds: 0 }], attempts: [], aggregate: { status: 'passed', retryShardIds: [] } };
      }) as never,
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    };
    const plain = runSelfGateCli('/repo', { shards: 4 }, deps);
    expect(calls[0]?.slice(0, 7)).toEqual(['/repo', files, 'HEAD', 4, undefined, undefined, undefined]);
    expect(calls[0]?.[7]).toEqual({ onShardComplete: expect.any(Function) });
    expect(plain.lines.find((line) => line.startsWith('shards: '))).not.toContain('고정 분배');
    const fixed = runSelfGateCli('/repo', { shards: 4, fixedShardDistribution: true }, deps);
    expect(calls[1]?.slice(0, 7)).toEqual(['/repo', files, 'HEAD', 4, undefined, undefined, undefined]);
    expect(calls[1]?.[7]).toEqual({ fixedDistribution: true, onShardComplete: expect.any(Function) });
    expect(fixed.lines.find((line) => line.startsWith('shards: '))).toContain('고정 분배');
    expect(fixed.exitCode).toBe(0);
    expect(() => runSelfGateCli('/repo', { fixedShardDistribution: true }, deps)).toThrow('requires --shards');
    expect(calls).toHaveLength(2);
  });

  test('async production gate awaits shards and preserves the serial output/verdict contract', async () => {
    const files = ['test/a.test.ts', 'test/b.test.ts'];
    const sharded: ShardRunResult = {
      shards: [{ id: 'shard-1', files, plannedRssMb: 0, plannedSeconds: 0 }],
      attempts: [], aggregate: { status: 'passed', retryShardIds: [] },
    };
    let concurrency: number | undefined;
    const deps = {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runTests: () => { throw new Error('direct runner must not run'); },
      runShards: () => sharded,
      runShardsAsync: async (_cwd: string, _files: readonly string[], _base: string, _count: number,
        _run: unknown, _worktree: unknown, _budget: unknown, mode: { concurrency?: number }) => {
        concurrency = mode.concurrency;
        await Promise.resolve();
        return sharded;
      },
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    };
    const serial = runSelfGateCli('/repo', { shards: 2 }, deps as never);
    const asyncResult = await runSelfGateCliAsync('/repo', { shards: 2, shardConcurrency: 4 }, deps as never);
    expect(concurrency).toBe(4);
    expect(asyncResult.exitCode).toBe(serial.exitCode);
    expect(asyncResult.lines).toEqual(serial.lines);
    await expect(runSelfGateCliAsync('/repo', { shards: 2, shardConcurrency: 5 }, deps as never))
      .rejects.toThrow('invalid shard concurrency');
  });

  test('records each of three completed bundles before the runner returns and atomically replaces progress.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-progress-'));
    const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
    const stderr: string[] = [];
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'gate.cli' && event === 'shard-progress') events.push(data);
    });
    let clock = 1000;
    try {
      const result = runSelfGateCli('/repo', { shards: 3, artifactDir: dir }, {
        changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
        runShards: (_cwd, _files, _base, _count, _run, _worktree, _budget, mode) => {
          for (let index = 1; index <= 3; index++) {
            clock += 1000;
            mode?.onShardComplete?.({ shardId: `shard-${index}`, completedShards: index,
              totalShards: 3, completedFiles: index, totalFiles: 3 });
            expect(JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8')).completedShards).toBe(index);
          }
          return { shards: [], attempts: [], aggregate: { status: 'passed', retryShardIds: [] } };
        },
        writeProgressStderr: (line) => { stderr.push(line); }, now: () => clock,
        resolveRev: () => 'a'.repeat(40), envKey: () => 'test',
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      });
      expect(result.exitCode).toBe(0);
      expect(stderr).toHaveLength(3);
      expect(stderr[1]).toContain('bundles 2/3 · files 2/3 · elapsed 2s · remaining ~1s');
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({ completedShards: 3, totalShards: 3, completedFiles: 3, totalFiles: 3, elapsedMs: 3000, estimatedRemainingMs: 0 });
      expect(JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'))).toMatchObject(events[2] as object);
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('automatic host-cap fixed fallback is visible without changing the real shard verdict', () => {
    const result = runSelfGateCli('/repo', { shards: 12 }, {
      changedFiles: () => ({ files: ['test/a.test.ts'], baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards: [{ id: 'shard-1', files: ['test/a.test.ts'], plannedRssMb: 0, plannedSeconds: 0 }],
        attempts: [], aggregate: { status: 'passed', retryShardIds: [] }, distribution: 'fixed-cap-fallback',
        fallbackReason: 'host shard expansion cap 12 < needed 42' }),
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.find((line) => line.startsWith('shards: '))).toContain('호스트 상한 자동 고정 분배(host shard expansion cap 12 < needed 42)');
  });

  test('default gate gives all ten real child tests three spawn shards beside regular tests', () => {
    const files = [...GATE_SPAWN_LANE_FILES, 'test/ordinary.test.ts'];
    let shardCount: number | undefined;
    runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runTests: () => { throw new Error('direct Bun runner must not run'); },
      runShards: (_cwd, _selected, _ref, count) => {
        shardCount = count;
        return { shards: [], attempts: [], aggregate: { status: 'passed', retryShardIds: [] } };
      },
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(shardCount).toBe(4);
  });

  test('--shards dispatches selected tests and preserves the single gate verdict and policy gates', () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/f${i}.test.ts`);
    const observed: string[][] = [];
    const sharded: ShardRunResult = {
      shards: [
        { id: 'shard-1', files: files.slice(0, 3), plannedRssMb: 100, plannedSeconds: 1 },
        { id: 'shard-2', files: files.slice(3), plannedRssMb: 100, plannedSeconds: 1 },
      ],
      attempts: [],
      aggregate: { status: 'unmeasured', retryShardIds: ['shard-2'] },
    };
    const run = (value: ShardRunResult) => runSelfGateCli('/repo', { shards: 2 }, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runTests: () => { throw new Error('unsharded runner must not run'); },
      runShards: (cwd, selected, ref, count) => {
        observed.push([cwd, ref, String(count), ...selected]);
        return value;
      },
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    const unmeasured = run(sharded);
    expect(unmeasured.exitCode).toBe(1);
    expect(unmeasured.lines.join('\n')).toContain('shards: unmeasured (shard-2)');
    const passed = run({ ...sharded, aggregate: { status: 'passed', retryShardIds: [] } });
    expect(passed.exitCode).toBe(0);
    expect(passed.lines).toContain('tests: pass (6 files)');
    expect(passed.lines.find((line) => line.startsWith('shards: 2 '))).not.toContain('측정 실패');
    const fallback = run({ ...sharded, measurementFailures: 1, aggregate: { status: 'passed', retryShardIds: [] } });
    expect(fallback.lines.find((line) => line.startsWith('shards: 2 '))).toContain('측정 실패 1');
    expect(observed).toEqual(Array.from({ length: 3 }, () => ['/repo', 'HEAD', '2', ...files]));
    expect(() => runSelfGateCli('/repo', { shards: 0 })).toThrow('invalid --shards count');
  });

  test('--shards reports one introduced/preexisting judgment and blocks only the introduced failure', () => {
    const files = ['src/a.test.ts', 'src/b.test.ts'];
    const shards = files.map((file, i) => ({ id: `shard-${i + 1}`, files: [file], plannedRssMb: 10, plannedSeconds: 1 }));
    const junit = (file: string, fail: boolean) => `<testsuite file="${file}" tests="1"><testcase name="test">${fail ? '<failure message="red"/>' : ''}</testcase></testsuite>`;
    const attempts = shards.map((shard, i) => ({ shardId: shard.id, attempt: 1,
      currentJUnit: junit(shard.files[0]!, true), baselineJUnit: junit(shard.files[0]!, i === 0),
      currentExitCode: 1, baselineExitCode: i === 0 ? 1 : 0 }));
    const result = runSelfGateCli('/repo', { shards: 2 }, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards, attempts, aggregate: aggregateGateTestShards(shards, attempts) }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('[gate-baseline] introduced=1, preexisting=1, unknown=0');
    expect(result.lines.join('\n')).toContain('shard attempt: shard-1 #1');
    expect(result.lines.join('\n')).toContain('shard attempt: shard-2 #1');
    expect(result.lines.join('\n')).toContain('shard attempt: shard-1 #1 · 지금 exit 1 · 기준 exit 1 · 파일 src/a.test.ts');
  });

  test('--shards writes failure.json under --artifact-dir for a failed shard and names the path (OP FU · MK #8178)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-gate-failure-evidence-'));
    try {
      const files = ['src/a.test.ts'];
      const shards = [{ id: 'shard-9', files, plannedRssMb: 10, plannedSeconds: 1 }];
      const attempts = [{ shardId: 'shard-9', attempt: 1, currentExitCode: 2, baselineExitCode: 0, baselineJUnit: '<testsuite/>' }];
      const failureEvidence = [{ shardId: 'shard-9', side: 'current' as const, attempt: 1, files, exitCode: 2, signal: null,
        durationMs: 12, stdoutTail: 'out tail', stderrTail: 'err tail' }];
      const result = runSelfGateCli('/repo', { shards: 1, artifactDir: dir }, {
        changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
        runShards: () => ({ shards, attempts, failureEvidence, aggregate: { status: 'unmeasured', retryShardIds: ['shard-9'] } }),
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        resolveRev: () => null, envKey: () => 'test-env',
      });
      const path = join(dir, 'shard-9.failure.json');
      expect(result.lines).toContain(`shard failure evidence: ${path}`);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ shardId: 'shard-9', files, exitCode: 2, stdoutTail: 'out tail', stderrTail: 'err tail' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--shards names why an attempt was unmeasured — signal, exit and missing JUnit per side (OP 10-09 light RC)', () => {
    const files = ['src/a.test.ts'];
    const shards = [{ id: 'shard-1', files, plannedRssMb: 10, plannedSeconds: 1 }];
    const attempts = [
      { shardId: 'shard-1', attempt: 1, currentExitCode: null, baselineExitCode: 0, currentSignal: 'SIGTERM', baselineJUnit: '<testsuite/>' },
      { shardId: 'shard-1', attempt: 2, currentExitCode: 1, baselineExitCode: null },
    ];
    const result = runSelfGateCli('/repo', { shards: 1 }, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards, attempts, aggregate: { status: 'unmeasured', retryShardIds: ['shard-1'] } }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    const text = result.lines.join('\n');
    expect(text).toContain('shard attempt: shard-1 #1 · 지금 signal SIGTERM · 기준 exit 0 · 파일 src/a.test.ts');
    expect(text).toContain('shard attempt: shard-1 #2 · 지금 exit 1 · junit 없음 · 기준 exit ? · 파일 src/a.test.ts');
    expect(text).toContain('shards: unmeasured (shard-1)');
  });

  test('--shards reports both sides and selected files for a no-JUnit exit 2 without leaking secrets', () => {
    const files = ['src/a.test.ts', 'src/b.test.ts'];
    const shards = [{ id: 'shard-2', files, plannedRssMb: 10, plannedSeconds: 1 }];
    const attempts = [{ shardId: 'shard-2', attempt: 1, currentExitCode: 2, baselineExitCode: 2,
      currentDiagnostic: 'stderr: API_KEY=supersecretvalue12345 current bootstrap error',
      baselineDiagnostic: 'stderr: API_KEY=*** baseline bootstrap error' }];
    const result = runSelfGateCli('/repo', { shards: 1 }, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards, attempts, aggregate: { status: 'unmeasured', retryShardIds: ['shard-2'] } }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    const output = result.lines.join('\n');
    expect(result.exitCode).toBe(1);
    expect(output).toContain('shard attempt: shard-2 #1 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음 · 파일 src/a.test.ts,src/b.test.ts');
    expect(output).toContain('shard diagnostic: shard-2 #1 지금 · stderr: API_KEY=*** current bootstrap error');
    expect(output).toContain('shard diagnostic: shard-2 #1 기준 · stderr: API_KEY=*** baseline bootstrap error');
    expect(output).not.toContain('supersecretvalue12345');
  });

  test('--shards distinguishes the baseline files actually run when a new test exists only at head', () => {
    const files = ['src/old.test.ts', 'src/new.test.ts'];
    const shards = [{ id: 'shard-1', files, plannedRssMb: 10, plannedSeconds: 1 }];
    const attempts = [{ shardId: 'shard-1', attempt: 1, currentExitCode: 2, baselineExitCode: 2,
      baselineFiles: ['src/old.test.ts'], currentDiagnostic: 'stderr: current', baselineDiagnostic: 'stderr: baseline' }];
    const result = runSelfGateCli('/repo', { shards: 1 }, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards, attempts, aggregate: { status: 'unmeasured', retryShardIds: ['shard-1'] } }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.lines.join('\n')).toContain('파일 src/old.test.ts,src/new.test.ts · 기준 파일 src/old.test.ts');
  });

  test('default bun test command uses an isolated deterministic environment and cleans it', () => {
    process.env.ANTHROPIC_API_KEY = 'parent-secret';
    process.env.ELANOUS_CONFIG_DIR = '/parent/config';
    const fixture = fixtureRepository({
      'src/a.ts': 'export const value = 1;\n',
      'src/a.test.ts': [
        "import { test, expect } from 'bun:test';",
        "import { writeFileSync } from 'node:fs';",
        "test('captures env', () => {",
        "  writeFileSync('env.json', JSON.stringify({",
        "    secret: process.env.ANTHROPIC_API_KEY ?? null,",
        "    home: process.env.HOME,",
        "    xdg: process.env.XDG_CONFIG_HOME,",
        "    state: process.env.ELANOUS_STATE_DIR,",
        "    config: process.env.ELANOUS_CONFIG_DIR,",
        "  }));",
        "  expect(Bun.file('env.json').size).toBeGreaterThan(0);",
        "});",
      ].join('\n'),
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/a.test.ts',
        runBaseline: () => baseline('test/a.test.ts:\n1 pass\n', 'pass'),
      });
      expect(result.exitCode).toBe(0);
      const captured = JSON.parse(readFileSync(join(fixture.cwd, 'env.json'), 'utf8')) as Record<string, string | null>;
      expect(captured.secret).toBeNull();
      const root = captured.home;
      expect(root).toContain('elanous-gate-cli-test-env-');
      expect(captured.xdg).toBe(`${root}/.config`);
      expect(captured.state).toBe(`${root}/state`);
      expect(captured.config).toBe(`${root}/config`);
      expect(existsSync(root!)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  test('default bun test command reports deterministic environment setup failure without falling back', () => {
    process.env.ANTHROPIC_API_KEY = 'parent-secret';
    const fixture = fixtureRepository({
      'src/a.ts': 'export const value = 1;\n',
      'src/a.test.ts': "import { test } from 'bun:test';\ntest('never reaches parent env', () => {});\n",
      'tmp-file': 'not a directory\n',
    });
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(fixture.cwd, 'tmp-file');
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/a.test.ts',
        runBaseline: () => baseline('test/a.test.ts:\n1 pass\n', 'pass'),
      });
      const output = result.lines.join('\n');
      expect(result.exitCode).toBe(1);
      expect(output).toContain('deterministic environment setup failed');
      expect(output).not.toContain('parent-secret');
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      fixture.dispose();
    }
  });

  test('no changes and docs-only both skip tests with exit 0', () => {
    let called = 0;
    const noChanges = runSelfGateCli('/repo', {}, { changedFiles: () => ({ files: [], baseRef: 'HEAD' }), runTests: () => { called += 1; return { status: 0 }; } });
    const docsOnly = runSelfGateCli('/repo', {}, { changedFiles: () => ({ files: ['docs/a.md'], baseRef: 'HEAD' }), runTests: () => { called += 1; return { status: 0 }; } });
    expect(noChanges.exitCode).toBe(0);
    expect(docsOnly.exitCode).toBe(0);
    expect(docsOnly.lines).toContain('scope: (test step skipped)');
    expect(called).toBe(0);
  });

  test('base selection feeds committed changed files to resolveGateScope', () => {
    const commands: Array<[string, string[], CommandResult]> = [
      ['git', ['diff', '--name-only', 'main...HEAD'], ok('src/a.ts\n')],
      ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok()],
      importerLookup(),
      lsFiles(),
    ];
    const result = runSelfGateCli('/repo', { base: 'main' }, {
      runCommand: scriptedCommand(commands), exists: (path) => path === 'src/a.test.ts', runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain('scope: src/a.test.ts');
    expect(commands).toEqual([]);
  });

  test('reports changed-test count decrease without changing a passing exit code', () => {
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'base' }),
      exists: () => true,
      runCommand: (command, args) => {
        if (command === 'git' && args[0] === 'grep') return ok();
        if (command === 'git' && args[0] === 'show') return ok("test('one', () => {});\nit('two', () => {});\ntest('three', () => {});");
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
      readFile: () => "test('one', () => {});",
      runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain('[test-count] changed-test-files=1, test-cases=3→1, decrease=2; test case=test()/it() call');
  });

  test('sums per-file deletions instead of offsetting them with additions', () => {
    const baseByFile: Record<string, string> = {
      'src/deleted.test.ts': "test('one', () => {});\nit('two', () => {});\ntest('three', () => {});",
      'src/added.test.ts': "test('one', () => {});",
    };
    const currentByFile: Record<string, string> = {
      'src/deleted.test.ts': "test('one', () => {});",
      'src/added.test.ts': "test('one', () => {});\nit('two', () => {});\ntest('three', () => {});",
    };
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: Object.keys(baseByFile), baseRef: 'base' }),
      exists: () => true,
      runCommand: (command, args) => {
        if (command === 'git' && args[0] === 'grep') return ok();
        if (command === 'git' && args[0] === 'show') return ok(baseByFile[args[1]!.replace('base:', '')]!);
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
      readFile: (path) => currentByFile[path.replace('/repo/', '')],
      runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain('[test-count] changed-test-files=2, test-cases=4→4, decrease=2; test case=test()/it() call');
  });

  test('PR selection parses gh files, requires matching head, and passes baseRefOid to baseline', () => {
    const commands = prGateCommands({ files: [{ path: 'src/a.ts' }], baseRefOid: 'base-sha', headRefOid: 'head-sha' });
    let baselineRef = '';
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      listPrWorktrees: () => [],
      runCommand: scriptedCommand(commands), exists: (path) => path === 'src/a.test.ts',
      runTests: () => fail('base red'), runBaseline: (_cwd, _files, ref) => { baselineRef = ref; return baseline('test/a.test.ts:\n(fail) base red\n1 fail\n'); },
    });
    expect(result.exitCode).toBe(0);
    expect(baselineRef).toBe('base-sha');
    expect(result.lines[0]).toContain('base=base-sha');
    expect(commands).toEqual([]);
  });

  test('rejects PR whose head is not checked out before it can run tests', () => {
    const commands = prCommands({ files: [{ path: 'src/a.ts' }], baseRefOid: 'base-sha', headRefOid: 'pr-head' }, 'other-head');
    commands.pop();
    let tests = 0;
    expect(() => runSelfGateCli('/repo', { pr: '6268' }, {
      listPrWorktrees: () => [],
      runCommand: scriptedCommand(commands), runTests: () => { tests += 1; return ok(); },
    })).toThrow('does not match current HEAD');
    expect(tests).toBe(0);
    expect(commands).toHaveLength(3);
  });

  test('fetches a missing PR baseRefOid before using it as the baseline', () => {
    const commands = prGateCommands({ files: [{ path: 'src/a.ts' }], baseRefOid: 'base-sha', headRefOid: 'head-sha' });
    commands[2] = ['git', ['cat-file', '-e', 'base-sha^{commit}'], { status: 1, stdout: '', stderr: 'missing' }];
    const list = commands.pop()!;
    const importer = commands.pop()!;
    const status = commands.pop()!;
    commands.push(['git', ['fetch', 'origin', 'base-sha'], ok()], ['git', ['cat-file', '-e', 'base-sha^{commit}'], ok()], status, importer, list);
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands), exists: (path) => path === 'src/a.test.ts', runTests: () => ok(),
      listPrWorktrees: () => [],
    });
    expect(result.exitCode).toBe(0);
    expect(commands).toEqual([]);
  });

  test('separately reports unverified user files and elanous runtime artifacts when a related test is run', () => {
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts', 'package.json', '.elanous/debug/debug-x.log', '.elanous-child-liveness.hb'], baseRef: 'HEAD' }), exists: (path) => path === 'src/a.test.ts', runCommand: () => ok(), runTests: () => ok(),
    });
    expect(result.lines).toContain('unverified: 1 (package.json)');
    expect(result.lines).toContain('elanous runtime artifacts: 2 (.elanous/debug/debug-x.log, .elanous-child-liveness.hb)');
  });

  test('reports mixed document changes that contribute no derived tests without changing execution', () => {
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['AGENTS.md', 'src/a.ts'], baseRef: 'HEAD' }), exists: (path) => path === 'src/a.test.ts', runCommand: () => ok(), runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.testFiles).toEqual(['src/a.test.ts']);
    expect(result.documentPaths).toEqual(['AGENTS.md']);
    expect(result.documentsWithoutDerivedTests).toEqual(['AGENTS.md']);
    expect(result.lines).toContain('document paths: AGENTS.md');
    expect(result.lines).toContain('documents without derived tests: AGENTS.md');
  });

  test('scripts-only change runs its importer and reports an introduced failure through the baseline', () => {
    const fixture = fixtureRepository({
      'scripts/compute.ts': 'export const compute = () => 2;\n',
      'test/compute-consumer.test.ts': "import { compute } from '../scripts/compute.js';\ntest('compute', () => { if (compute() !== 1) throw new Error('new red'); });\n",
    });
    try {
      const ran: string[][] = [];
      const result = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, {
        changedFiles: () => ({ files: ['scripts/compute.ts'], baseRef: 'base-sha' }),
        runTests: (cwd, files) => {
          ran.push([...files]);
          const actual = spawnSync('bun', ['test', ...files], { cwd, encoding: 'utf8' });
          expect(actual.status).toBe(1);
          expect(actual.stderr).toContain('(fail) compute');
          return { status: actual.status, stdout: actual.stdout, stderr: actual.stderr };
        },
        runBaseline: (_cwd, files, ref) => {
          expect(files).toEqual(['test/compute-consumer.test.ts']);
          expect(ref).toBe('base-sha');
          return baseline('test/compute-consumer.test.ts:\n(pass) compute\n1 pass\n', 'pass');
        },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      });
      expect(ran).toEqual([['test/compute-consumer.test.ts']]);
      expect(result.testFiles).toEqual(['test/compute-consumer.test.ts']);
      expect(result.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
      expect(result.baseline).toEqual({ introduced: 1, preexisting: 0, unknown: 0, preconditionUnmet: 0 });
      expect(result.lines.join('\n')).toContain('[gate-baseline] introduced=1');
      expect(result.lines.join('\n')).toContain('- introduced: test/compute-consumer.test.ts > compute');
      expect(result.exitCode).toBe(1);
    } finally { fixture.dispose(); }
  });

  test('⛔ 소비자 배선 — 미등재 spawn-lane 드리프트가 gate 출력에 실린다(무인 리뷰 must-fix)', () => {
    const fixture = fixtureRepository({
      'src/service.ts': 'export const service = 1;\n',
      'bin/elanous.mjs': '#!/usr/bin/env bun\n',
      'test/spawns-cli.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('bun', ['bin/elanous.mjs']);\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, {
        changedFiles: () => ({ files: ['src/service.ts'], baseRef: 'HEAD' }),
        runTests: () => ok(),
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      });
      // `resolveGateScope` 이 채운 `runtimeEdgeImpact` 를 gate 출력이 실제로 읽는다 — 죽은 필드가 아니다.
      expect(result.lines).toContain('unlisted spawn-lane tests: 1 (test/spawns-cli.test.ts)  ⚠️ GATE_SPAWN_LANE_FILES 가 빠뜨린 실측 spawn-lane 시험 — 「보고만 한다. 막지 않는다.」');
      expect(result.exitCode).toBe(0);
    } finally { fixture.dispose(); }
  });

  test('⛔ 소비자 배선 — 색인을 못 만든 변경은 미등재 spawn-lane 을 「못 잰다」고 말한다', () => {
    const deps = {
      changedFiles: () => ({ files: ['scripts/compute.ts'], baseRef: 'HEAD' }),
      exists: () => false,
      runCommand: () => ({ status: 2, stderr: 'grep unavailable' }),
      runTests: () => ok(),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
    };
    const result = runSelfGateCli('/repo', { includeImporterTests: true }, deps);
    // 임포터 색인이 없으면(`runtimeEdgeImpact: null`) 측정은 «모름» 이다 — 0 이 아니다.
    expect(result.lines).toContain('unlisted spawn-lane tests: (not measured — no importer index)');
  });

  test('the light-rc opt-in still selects src/ importers alongside scripts/ importers', () => {
    const fixture = fixtureRepository({
      'src/service.ts': 'export const service = 1;\n',
      'scripts/compute.ts': 'export const compute = 1;\n',
      'test/service-consumer.test.ts': "import '../src/service.js';\n",
      'test/compute-consumer.test.ts': "import '../scripts/compute.js';\n",
    });
    try {
      let testCalls = 0;
      const options = { includeImporterTests: true };
      const deps = {
        changedFiles: () => ({ files: ['src/service.ts', 'scripts/compute.ts'], baseRef: 'HEAD' }),
        runTests: () => { testCalls++; return ok(); },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      };
      const preflight = selectGateTestFiles(fixture.cwd, options, deps);
      expect(testCalls).toBe(0);
      const result = runSelfGateCli(fixture.cwd, options, deps);
      expect(testCalls).toBe(1);
      expect(new Set(result.testFiles)).toEqual(new Set(['test/service-consumer.test.ts', 'test/compute-consumer.test.ts']));
      expect([...preflight.testFiles]).toEqual([...(result.testFiles ?? [])]);
      expect([...preflight.importerTestsAdded]).toEqual([...(result.importerTestsAdded ?? [])]);
      expect(preflight.unrunImporterTotal).toBe(0);
      expect(result.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
      expect(result.exitCode).toBe(0);
    } finally { fixture.dispose(); }
  });

  test('the production gate excludes comment-only source importers but still runs them for code edits', () => {
    const source = 'src/user-config.ts';
    const before = '/** bot: `@private_bot` */\nexport const config = 1;\n';
    const importers = Object.fromEntries(Array.from({ length: GATE_CALLER_TEST_LIMIT + 1 }, (_, index) =>
      [`test/config-${index}.test.ts`, "import '../src/user-config.js';\ntest('config', () => {});\n"]));
    const fixture = fixtureRepository({ [source]: before, ...importers });
    try {
      const committed = spawnSync('git', ['-c', 'user.name=TC', '-c', 'user.email=tc@test.local', 'commit', '-m', 'base', '--quiet'], { cwd: fixture.cwd, encoding: 'utf8' });
      expect(committed.status).toBe(0);
      const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf8' }).stdout.trim();
      const ran: string[][] = [];
      const deps = {
        changedFiles: () => ({ files: [source], baseRef: 'HEAD' }),
        runTests: (_cwd: string, files: readonly string[]) => { ran.push([...files]); return ok(); },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      };
      writeFileSync(join(fixture.cwd, source), before.replace('@private_bot', '@example_bot'));
      const comment = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, deps);
      expect(comment.testFiles).toEqual([]);
      expect(comment.lines).toContain(`comment-only importer expansion excluded: ${source}`);
      expect(comment.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
      expect(ran).toEqual([]);

      expect(spawnSync('git', ['add', source], { cwd: fixture.cwd }).status).toBe(0);
      expect(spawnSync('git', ['-c', 'user.name=TC', '-c', 'user.email=tc@test.local', 'commit', '-m', 'comment only', '--quiet'], { cwd: fixture.cwd }).status).toBe(0);
      const committedComment = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, {
        ...deps, changedFiles: () => ({ files: [source], baseRef: baseSha }),
      });
      expect(committedComment.testFiles).toEqual([]);
      expect(committedComment.lines).toContain(`comment-only importer expansion excluded: ${source}`);

      writeFileSync(join(fixture.cwd, source), '/** bot: `@example_bot` */\nexport const config = 2;\n');
      const code = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, deps);
      expect(code.testFiles).toHaveLength(GATE_CALLER_TEST_LIMIT + 1);
      expect(code.lines.some((line) => line.startsWith('comment-only importer expansion excluded:'))).toBe(false);
      expect(ran).toHaveLength(1);
    } finally { fixture.dispose(); }
  });

  test('the plain gate leaves scripts-only importer selection unchanged without the light-rc option', () => {
    const fixture = fixtureRepository({
      'scripts/compute.ts': 'export const compute = 1;\n',
      'test/compute-consumer.test.ts': "import '../scripts/compute.js';\n",
    });
    try {
      const deps = {
        changedFiles: () => ({ files: ['scripts/compute.ts'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('plain gate must not run scripts importer'); },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      };
      const preflight = selectGateTestFiles(fixture.cwd, {}, deps);
      const result = runSelfGateCli(fixture.cwd, {}, deps);
      expect(result.testFiles).toEqual([]);
      expect(preflight.testFiles).toEqual(result.testFiles);
      expect(preflight.skipTestStep).toBe(true);
      expect(result.lines).toContain('unrun importer tests: 0');
      expect(result.lines.some((line) => line.startsWith('importer tests added:'))).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally { fixture.dispose(); }
  });

  test('scripts-only importer lookup failure is reported as unmeasured rather than zero', () => {
    const deps = {
      changedFiles: () => ({ files: ['scripts/compute.ts'], baseRef: 'HEAD' }),
      exists: () => false,
      runCommand: () => ({ status: 2, stderr: 'grep unavailable' }),
      runTests: () => { throw new Error('lookup failed; no tests can run'); },
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
      runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
    };
    const preflight = selectGateTestFiles('/repo', { includeImporterTests: true }, deps);
    const result = runSelfGateCli('/repo', { includeImporterTests: true }, deps);
    expect(result.testFiles).toEqual([]);
    expect(preflight.testFiles).toEqual(result.testFiles);
    expect(preflight.lookupFailed).toBe('grep unavailable');
    expect(preflight.unrunImporterTotal).toBeNull();
    expect(result.lines).toContain('unrun importer tests: lookup failed (grep unavailable)');
    expect(result.lines).toContain('importer tests added: lookup failed (grep unavailable)');
    expect(result.lines).not.toContain('unrun importer tests: 0');
  });

  test('scripts-only importers beyond the caller cap join the opt-in test run', () => {
    const paths = Array.from({ length: GATE_CALLER_TEST_LIMIT + 1 }, (_, n) => `test/scripts-consumer-${String(n).padStart(2, '0')}.test.ts`);
    const fixture = fixtureRepository({
      'scripts/compute.ts': 'export const compute = 1;\n',
      ...Object.fromEntries(paths.map((path) => [path, "import '../scripts/compute.js';\n"])),
    });
    try {
      const ran: string[][] = [];
      const result = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, {
        changedFiles: () => ({ files: ['scripts/compute.ts'], baseRef: 'HEAD' }),
        runTests: (_cwd, files) => { ran.push([...files]); return ok(); },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      });
      expect(new Set(ran.flat())).toEqual(new Set(paths));
      expect(result.importerTestsAdded).toEqual([paths[GATE_CALLER_TEST_LIMIT]]);
      expect(result.lines).toContain(`importer tests added: 1 (reason=changed-source-importer · ${paths[GATE_CALLER_TEST_LIMIT]})`);
      expect(result.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
      expect(result.exitCode).toBe(0);
    } finally { fixture.dispose(); }
  });

  test('scripts importer that cannot be run remains an explicit partial observation', () => {
    const fixture = fixtureRepository({
      'scripts/compute.ts': 'export const compute = 1;\n',
      'test/compute-importer.test.ts': "import '../scripts/compute.js';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, { includeImporterTests: true }, {
        changedFiles: () => ({ files: ['scripts/compute.ts'], baseRef: 'HEAD' }),
        exists: () => false,
        runTests: () => { throw new Error('unrunnable importer must not run'); },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
      });
      expect(result.testFiles).toEqual([]);
      expect(result.lines).toContain('unrun importer tests: 1 (test/compute-importer.test.ts); unresolved relative specifiers: 0');
      expect(result.lines).toContain('importer tests added: 0 (reason=changed-source-importer)');
      expect(result.exitCode).toBe(0);
    } finally { fixture.dispose(); }
  });

  test('runs reverse importer tests that exist beside conventional tests', () => {
    const fixture = fixtureRepository({
      'src/service.ts': 'export const service = 1;\n',
      'src/service.test.ts': "import './service.js';\n",
      'test/consumer.test.ts': "import '../src/service.js';\n",
    });
    try {
      const ran: string[][] = [];
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/service.ts'], baseRef: 'HEAD' }),
        runTests: (_cwd, files) => { ran.push([...files]); return ok(); },
      });
      expect(ran).toEqual([['src/service.test.ts', 'test/consumer.test.ts']]);
      expect(result.lines).toContain('caller tests: test/consumer.test.ts (import)');
      expect(result.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
    } finally { fixture.dispose(); }
  });

  test('keeps importer observation explicit when a candidate is not an existing runnable file', () => {
    const fixture = fixtureRepository({
      'src/self-implement/goal-author.ts': 'export class GoalAuthor {}\n',
      'src/self-implement/goal-author.test.ts': "import { GoalAuthor } from './goal-author.js';\nvoid GoalAuthor;\n",
      'src/self-implement/goal-file-lint.test.ts': "export { GoalAuthor } from './goal-author.ts';\n",
      'src/self-dev/dev-cli.test.ts': "const load = import('../self-implement/goal-author');\nvoid load;\n",
      'src/self-implement/goal-author-tsx.test.ts': "import './goal-author.tsx';\n",
      'src/self-implement/comment.test.ts': "// import './goal-author.ts';\nconst text = \"import './goal-author.ts'\";\nvoid text;\n",
      'src/self-implement/multiline.test.ts': "import {\n  GoalAuthor,\n} from './goal-author';\nvoid GoalAuthor;\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/self-implement/goal-author.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/self-implement/goal-author.test.ts', runTests: () => ok(),
      });
      expect(result.testFiles).toEqual(['src/self-implement/goal-author.test.ts']);
      expect(result.exitCode).toBe(0);
      expect(result.unverified).toEqual([]);
      expect(result.lines).toContain('unrun importer tests: 3 (src/self-dev/dev-cli.test.ts, src/self-implement/goal-file-lint.test.ts, src/self-implement/multiline.test.ts); unresolved relative specifiers: 1');
    } finally {
      fixture.dispose();
    }
  });

  test('recognizes a static importer with from and its specifier on separate lines', () => {
    const fixture = fixtureRepository({
      'src/goal-author.ts': 'export const goal = 1;\n',
      'src/static-multiline.test.ts': "import { goal } from\n  './goal-author.js';\nvoid goal;\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/goal-author.ts'], baseRef: 'HEAD' }), exists: () => false, runTests: () => ok(),
      });
      expect(result.lines).toContain('unrun importer tests: 1 (src/static-multiline.test.ts); unresolved relative specifiers: 0');
    } finally {
      fixture.dispose();
    }
  });

  test('recognizes a dynamic importer with import and its specifier on separate lines', () => {
    const fixture = fixtureRepository({
      'src/goal-author.ts': 'export const goal = 1;\n',
      'src/dynamic-multiline.test.ts': "const load = import(\n  './goal-author.js'\n);\nvoid load;\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/goal-author.ts'], baseRef: 'HEAD' }), exists: () => false, runTests: () => ok(),
      });
      expect(result.lines).toContain('unrun importer tests: 1 (src/dynamic-multiline.test.ts); unresolved relative specifiers: 0');
    } finally {
      fixture.dispose();
    }
  });

  test('maps .mts importers to their emitted .mjs specifier', () => {
    const fixture = fixtureRepository({
      'src/module.mts': 'export const module = 1;\n',
      'src/module-importer.test.ts': "import './module.mjs';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/module.mts'], baseRef: 'HEAD' }), exists: () => false, runTests: () => ok(),
      });
      expect(result.lines).toContain('unrun importer tests: 1 (src/module-importer.test.ts); unresolved relative specifiers: 0');
    } finally {
      fixture.dispose();
    }
  });

  test('maps .cts importers to their emitted .cjs specifier', () => {
    const fixture = fixtureRepository({
      'src/module.cts': 'export const module = 1;\n',
      'src/module-importer.test.ts': "import './module.cjs';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/module.cts'], baseRef: 'HEAD' }), exists: () => false, runTests: () => ok(),
      });
      expect(result.lines).toContain('unrun importer tests: 1 (src/module-importer.test.ts); unresolved relative specifiers: 0');
    } finally {
      fixture.dispose();
    }
  });

  test('excludes source extensions that are not valid import specifiers for the changed source', () => {
    const fixture = fixtureRepository({
      'src/module.mts': 'export const module = 1;\n',
      'src/wrong-extension.test.ts': "import './module.cjs';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/module.mts'], baseRef: 'HEAD' }), exists: () => false, runTests: () => ok(),
      });
      expect(result.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 1');
    } finally {
      fixture.dispose();
    }
  });

  test('recognizes TSX importers and caps unrun importer names at the display limit', () => {
    const files: Record<string, string> = { 'src/view.tsx': 'export const View = 1;\n', 'src/view.test.tsx': "import './view.tsx';\n" };
    for (let index = 1; index <= 22; index += 1) files[`src/importer-${index}.test.ts`] = "import './view.jsx';\n";
    const fixture = fixtureRepository(files);
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/view.tsx'], baseRef: 'HEAD' }), exists: (path) => path === 'src/view.test.tsx', runTests: () => ok(),
      });
      expect(result.lines).toContain(`unrun importer tests: 22 (${Array.from({ length: 20 }, (_, index) => `src/importer-${index + 1}.test.ts`).join(', ')}, showing 20/22); unresolved relative specifiers: 0`);
    } finally {
      fixture.dispose();
    }
  });

  test('reports zero importers with a fixed output form', () => {
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }), exists: (path) => path === 'src/a.test.ts', runCommand: () => ok(), runTests: () => ok(),
    });
    expect(result.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
  });

  test('reports unresolved relative specifiers from the resolved importer observation', () => {
    const fixture = fixtureRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/a.test.ts': "import './a.js';\n",
      'src/importer.test.ts': "import './a.js';\nimport './missing-source.js';\nimport './fixture.json';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }), exists: (path) => path === 'src/a.test.ts', runTests: () => ok(),
      });
      expect(result.lines).toContain('unrun importer tests: 1 (src/importer.test.ts); unresolved relative specifiers: 1');
    } finally {
      fixture.dispose();
    }
  });

  test('keeps the gate result while making importer lookup failures visible', () => {
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }), exists: (path) => path === 'src/a.test.ts',
      runCommand: () => ({ status: 2, stderr: 'grep unavailable' }), runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.testFiles).toEqual(['src/a.test.ts']);
    expect(result.unverified).toEqual([]);
    expect(result.lines).toContain('unrun importer tests: lookup failed (grep unavailable)');
    expect(result.lines).toContain('caller tests: lookup failed (grep unavailable)');
    expect(result.lines).not.toContain('caller tests: (none)');
  });

  test('distinguishes worktree admission not checked, checked clean, and checked unrelated changes', () => {
    const notChecked = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['docs/a.md'], baseRef: 'HEAD' }), runCommand: () => ok(),
    });
    const checkedClean = runSelfGateCli('/repo', { base: 'main' }, {
      runCommand: scriptedCommand([
        ['git', ['diff', '--name-only', 'main...HEAD'], ok('docs/a.md\n')],
        ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok()],
      ]),
    });
    const checkedUnrelated = runSelfGateCli('/repo', { base: 'main' }, {
      runCommand: scriptedCommand([
        ['git', ['diff', '--name-only', 'main...HEAD'], ok('docs/a.md\n')],
        ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok('?? docs/goals/run.md\0')],
      ]),
    });
    expect(notChecked.lines).toContain('ignored unrelated worktree changes: (not checked)');
    expect(checkedClean.lines).toContain('ignored unrelated worktree changes: (none)');
    expect(checkedUnrelated.lines).toContain('ignored unrelated worktree changes: docs/goals/run.md');
  });

  test('parses NUL porcelain tracked, untracked, deleted, renamed, and copied paths', () => {
    const porcelain = ' M src/changed.ts\0?? docs/goals/run.md\0 D src/deleted.ts\0R  src/renamed.ts\0src/old-name.ts\0C  src/copied.ts\0src/original.ts\0';
    expect(parseDirtyWorktreePaths(porcelain)).toEqual([
      { path: 'src/changed.ts', kind: 'tracked' }, { path: 'docs/goals/run.md', kind: 'untracked' },
      { path: 'src/deleted.ts', kind: 'tracked' }, { path: 'src/renamed.ts', kind: 'tracked' },
      { path: 'src/old-name.ts', kind: 'tracked' }, { path: 'src/copied.ts', kind: 'tracked' },
      { path: 'src/original.ts', kind: 'tracked' },
    ]);
    expect(classifyDirtyWorktreePaths(porcelain, ['src/old-name.ts', 'src/untracked/new.test.ts'])).toEqual({
      overlapping: [{ path: 'src/old-name.ts', kind: 'tracked' }],
      unrelated: [
        { path: 'src/changed.ts', kind: 'tracked' }, { path: 'docs/goals/run.md', kind: 'untracked' },
        { path: 'src/deleted.ts', kind: 'tracked' }, { path: 'src/renamed.ts', kind: 'tracked' },
        { path: 'src/copied.ts', kind: 'tracked' }, { path: 'src/original.ts', kind: 'tracked' },
      ],
    });
  });

  test('allows unrelated PR worktree changes, reports them, and preserves selected target files', () => {
    const commands = prGateCommands(
      { files: [{ path: 'src/a.ts' }], baseRefOid: 'base-sha', headRefOid: 'head-sha' },
      'head-sha',
      '?? docs/goals/run.md\0',
    );
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands), exists: (path) => path === 'src/a.test.ts', runTests: () => ok(),
      listPrWorktrees: () => [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect(result.lines).toContain('ignored unrelated worktree changes: docs/goals/run.md');
    expect(commands).toEqual([]);
  });

  test('rejects overlapping tracked and untracked paths, including targets beneath an untracked directory', () => {
    for (const [porcelain, expected] of [
      [' M src/a.ts\0', 'tracked changes: src/a.ts'],
      ['?? src\0', 'untracked files: src'],
    ] as const) {
      let tests = 0;
      expect(() => runSelfGateCli('/repo', { base: 'main' }, {
        runCommand: scriptedCommand([
          ['git', ['diff', '--name-only', 'main...HEAD'], ok('src/a.ts\n')],
          ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok(porcelain)],
        ]),
        runTests: () => { tests += 1; return ok(); },
      })).toThrow(expected);
      expect(tests).toBe(0);
    }
  });

  test('rejects mixed dirty worktrees with only the relevant overlapping name', () => {
    expect(() => runSelfGateCli('/repo', { base: 'main' }, {
      runCommand: scriptedCommand([
        ['git', ['diff', '--name-only', 'main...HEAD'], ok('src/a.ts\n')],
        ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok('?? docs/goals/run.md\0 M src/a.ts\0')],
      ]),
    })).toThrow('tracked changes: src/a.ts');
  });

  test('calls baseline once with the PR base OID and uses its result for attribution', () => {
    const commands = prGateCommands({ files: [{ path: 'src/a.ts' }], baseRefOid: 'base-sha', headRefOid: 'head-sha' });
    const calls: Array<{ cwd: string; files: readonly string[]; ref: string }> = [];
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      listPrWorktrees: () => [],
      runCommand: scriptedCommand(commands), exists: (path) => path === 'src/a.test.ts', runTests: () => fail('base red'),
      runBaseline: (cwd, files, ref) => {
        calls.push({ cwd, files, ref });
        return baseline('test/a.test.ts:\n(fail) base red\n1 fail\n');
      },
    });
    expect(calls).toEqual([{ cwd: '/repo', files: ['src/a.test.ts'], ref: 'base-sha' }]);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('preexisting=1');
    expect(commands).toEqual([]);
  });

  test('introduced failures exit 1 while baseline-only failures exit 0', () => {
    const introduced = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'HEAD' }), exists: () => true, runTests: () => fail('new red'), runBaseline: () => baseline('test/a.test.ts:\n1 pass\n'),
    });
    const preexisting = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'HEAD' }), exists: () => true, runTests: () => fail('base red'), runBaseline: () => baseline('test/a.test.ts:\n(fail) base red\n1 fail\n'),
    });
    expect(introduced.exitCode).toBe(1);
    expect(introduced.lines.join('\n')).toContain('introduced=1');
    expect(preexisting.exitCode).toBe(0);
    expect(preexisting.lines.join('\n')).toContain('preexisting=1');
  });

  test('runs additional gates without update, preserves raw output, and blocks violations', () => {
    const calls: string[][] = [];
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
      exists: (path) => path === 'src/a.test.ts',
      runCommand: () => ok(),
      runTests: () => ok(),
      runIsolationGate: (out) => { calls.push(out.args ?? []); out.error('[isolation-gate] FAIL test/a.ts'); return 1; },
      runMockModuleRestoreGate: (out) => { calls.push(out.args ?? []); out.error('[mock-module-restore-gate] FAIL test/a.test.ts'); return 1; },
    });
    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([['--changed-files', 'src/a.ts'], ['--changed-files', 'src/a.ts']]);
    expect(result.lines.join('\n')).toContain('[isolation-gate] FAIL test/a.ts');
    expect(result.lines.join('\n')).toContain('[mock-module-restore-gate] FAIL test/a.test.ts');
    expect(result.lines).toContain('tests: pass (1 files)');
  });

  test('uses original gates to block changed violations while ignoring violations outside the changed scope', () => {
    const isolationScan = new Map([
      ['src/changed.ts', { count: 1, candidates: [{ lineNumber: 1, line: "join(homedir(), '.elanous')" }] }],
      ['src/outside.ts', { count: 1, candidates: [{ lineNumber: 1, line: "join(homedir(), '.elanous')" }] }],
    ]);
    const mockScan = new Map([
      ['test/changed.test.ts', { count: 1, modules: ['node:fs'] }],
      ['test/outside.test.ts', { count: 1, modules: ['node:child_process'] }],
    ]);
    const gateArgs: string[][] = [];
    const run = (files: string[]) => runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files, baseRef: 'HEAD' }),
      exists: () => true, runCommand: () => ok(), runTests: () => ok(),
      runIsolationGate: (out) => { gateArgs.push(out.args ?? []); return runIsolationHardcodeGate({ ...out, scan: () => isolationScan, loadBaseline: () => new Map() }); },
      runMockModuleRestoreGate: (out) => { gateArgs.push(out.args ?? []); return runMockModuleRestoreGate({ ...out, scan: () => mockScan, loadBaseline: () => new Map([['test/changed.test.ts', 0]]) }); },
      runDaemonPortGate: () => 0,
    });
    const changed = run(['src/changed.ts', 'test/changed.test.ts']);
    const outside = run(['src/a.ts']);
    expect(gateArgs).toEqual([
      ['--changed-files', 'src/changed.ts', 'test/changed.test.ts'],
      ['--changed-files', 'src/changed.ts', 'test/changed.test.ts'],
      ['--changed-files', 'src/a.ts'],
      ['--changed-files', 'src/a.ts'],
    ]);
    expect(changed.exitCode).toBe(1);
    expect(changed.lines.join('\n')).toContain('src/changed.ts');
    expect(changed.lines.join('\n')).toContain('test/changed.test.ts');
    expect(outside.exitCode).toBe(0);
    expect(outside.lines.join('\n')).not.toContain('src/outside.ts');
    expect(outside.lines.join('\n')).not.toContain('test/outside.test.ts');
  });

  test('scans actual changed-worktree violations instead of the gate source checkout', () => {
    const fixture = fixtureRepository({
      'src/worktree-only.ts': "const state = join(homedir(), '.elanous');\nexport { state };\n",
      'test/worktree-only.test.ts': "import { mock } from 'bun:test';\nmock.module('node:fs', () => ({}));\n",
      'scripts/isolation-hardcode-baseline.txt': '# empty baseline\n',
      'scripts/mock-module-restore-baseline.txt': '# empty baseline\n',
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/worktree-only.ts', 'test/worktree-only.test.ts'], baseRef: 'HEAD' }),
        exists: () => true,
        runCommand: () => ok(),
        runTests: () => ok(),
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('src/worktree-only.ts');
      expect(result.lines.join('\n')).toContain('test/worktree-only.test.ts');
      expect(result.lines.join('\n')).toContain('[isolation-gate] FAIL');
      expect(result.lines.join('\n')).toContain('[mock-module-restore-gate] FAIL');
    } finally {
      fixture.dispose();
    }
  });

  test('keeps clean additional gates passing and reports thrown gates as unmeasured', () => {
    const clean = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
      exists: (path) => path === 'src/a.test.ts', runCommand: () => ok(), runTests: () => ok(),
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0, runDaemonPortGate: () => 0,
    });
    const unmeasured = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
      exists: (path) => path === 'src/a.test.ts', runCommand: () => ok(), runTests: () => ok(),
      runIsolationGate: () => { throw new Error('script unavailable'); }, runMockModuleRestoreGate: () => 0, runDaemonPortGate: () => 0,
    });
    expect(clean.exitCode).toBe(0);
    expect(clean.lines).toContain('tests: pass (1 files)');
    expect(unmeasured.exitCode).toBe(1);
    expect(unmeasured.lines.join('\n')).toContain('isolation-gate: 게이트가 «못 쟀다» — script unavailable');
  });

  test('logs gate.baseline after baseline report with canonical keys and source gate-cli', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'HEAD' }),
        exists: () => true,
        runTests: () => ({
          status: 1,
          stdout: 'test/a.test.ts:\n(fail) intermittent timeout\n^ this test timed out after 5000ms.\n1 fail\n',
          stderr: '',
        }),
        runBaseline: () => baseline('test/a.test.ts:\n(pass) intermittent timeout\n1 pass\n'),
      });
      const payload = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown> | undefined;
      expect(result.exitCode).toBe(1);
      expect(payload).toEqual(expect.objectContaining({
        introduced: 1,
        preexisting: 0,
        unknown: 0,
        preconditionUnmet: 0,
        timedOut: 0,
        timeoutPassedAtBase: 1,
        unrunImporterTotal: 0,
        lookupFailed: false,
        source: 'gate-cli',
      }));
      expect(payload).toHaveProperty('failures');
      expect(payload).toHaveProperty('baselineFiles');
      expect(payload).toHaveProperty('baselineStatus');
      expect(payload).toHaveProperty('branch');
      expect(payload).toHaveProperty('workdir');
      expect(Object.keys(payload ?? {})).toEqual(expect.arrayContaining([
        'introduced', 'preexisting', 'unknown', 'preconditionUnmet', 'timedOut', 'timeoutPassedAtBase',
        'failures', 'baselineFiles', 'baselineStatus', 'unrunImporterTotal', 'lookupFailed',
        'branch', 'workdir', 'source',
      ]));
    } finally {
      log.mockRestore();
    }
  });

  test('sharded gate retries only timeout-only introduced failure and reports load-timeout with original diagnostic', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const file = 'src/a.test.ts';
    const rawTimeout = '^ this test timed out after 5000ms.';
    const report = buildGateBaselineReport(`${file}:\n(fail) slow startup\n${rawTimeout}\n1 fail`,
      { status: 'pass', output: `${file}:\n(pass) slow startup\n1 pass\n0 fail`, log: 'baseline clean' });
    const calls: unknown[][] = [];
    try {
      const result = runSelfGateCli('/repo', { shards: 1 }, {
        changedFiles: () => ({ files: [file], baseRef: 'HEAD' }), exists: () => true,
        runShards: () => ({ shards: [{ id: 'shard-1', files: [file], plannedRssMb: 10, plannedSeconds: 1 }],
          attempts: [], aggregate: { status: 'failed', retryShardIds: [], report } }),
        runTimeoutRecheck: (cwd, target, name, timeoutMs) => {
          calls.push([cwd, target, name, timeoutMs]);
          return { observation: 'pass', elapsedMs: 1234, output: 'Ran 1 test across 1 file.\n1 pass' };
        },
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0, runModelHardcodeGate: () => 0,
        runDaemonPortGate: () => 0, runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      });
      const baselinePayload = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown> | undefined;
      const recheckPayload = log.mock.calls.find((call) => call[0] === 'gate.baseline' && call[1] === 'timeout-recheck')?.[2] as Record<string, unknown> | undefined;
      expect(calls).toEqual([['/repo', file, 'slow startup', 60_000]]);
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('load-timeout=1');
      expect(baselinePayload?.introduced).toBe(0);
      expect(JSON.stringify(baselinePayload?.failures)).toContain(rawTimeout);
      expect(recheckPayload).toMatchObject({ result: 'pass', elapsedMs: 1234 });
    } finally {
      log.mockRestore();
    }
  });

  test('sharded gate does not retry or pass an introduced assertion that also prints a timeout marker', () => {
    const file = 'src/a.test.ts';
    const report = buildGateBaselineReport(`${file}:\nerror: expected true but received false\n(fail) assertion under load\n^ this test timed out after 5000ms.\n1 fail`,
      { status: 'pass', output: `${file}:\n(pass) assertion under load\n1 pass\n0 fail`, log: 'baseline clean' });
    let attempts = 0;
    const result = runSelfGateCli('/repo', { shards: 1 }, {
      changedFiles: () => ({ files: [file], baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards: [{ id: 'shard-1', files: [file], plannedRssMb: 10, plannedSeconds: 1 }],
        attempts: [], aggregate: { status: 'failed', retryShardIds: [], report } }),
      runTimeoutRecheck: () => { attempts += 1; return { observation: 'pass', elapsedMs: 1, output: 'pass' }; },
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0, runModelHardcodeGate: () => 0,
      runDaemonPortGate: () => 0, runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(attempts).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('introduced=1');
  });

  test('logs timeoutPassedAtBase=0 when the baseline also timed out', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'HEAD' }),
        exists: () => true,
        runTests: () => ({
          status: 1,
          stdout: 'test/a.test.ts:\n(fail) intermittent timeout\n^ this test timed out after 5000ms.\n1 fail\n',
          stderr: '',
        }),
        runBaseline: () => baseline('test/a.test.ts:\n(pass) intermittent timeout\n(fail) intermittent timeout\n^ this test timed out after 5000ms.\n1 pass, 1 fail\n'),
      });
      const payload = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown> | undefined;
      expect(payload).toEqual(expect.objectContaining({ timeoutPassedAtBase: 0, timedOut: 1 }));
    } finally {
      log.mockRestore();
    }
  });

  test('logs zero-valued gate.baseline on the all-tests-passing early return', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/a.test.ts',
        runCommand: () => ok(),
        runTests: () => ok(),
      });
      const payload = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown> | undefined;
      expect(result.exitCode).toBe(0);
      expect(result.lines).toContain('tests: pass (1 files)');
      expect(payload).toEqual(expect.objectContaining({
        introduced: 0,
        preexisting: 0,
        unknown: 0,
        preconditionUnmet: 0,
        timedOut: 0,
        timeoutPassedAtBase: 0,
        failures: [],
        baselineFiles: [],
        baselineStatus: 'pass',
        unrunImporterTotal: 0,
        lookupFailed: false,
        source: 'gate-cli',
      }));
      expect(Object.keys(payload ?? {})).toEqual(expect.arrayContaining([
        'introduced', 'preexisting', 'unknown', 'preconditionUnmet', 'timedOut', 'timeoutPassedAtBase',
        'failures', 'baselineFiles', 'baselineStatus', 'unrunImporterTotal', 'lookupFailed',
        'branch', 'workdir', 'source',
      ]));
    } finally {
      log.mockRestore();
    }
  });

  describe('formatUnrunnableChangeKinds — ⛔ 「통과」가 아니라 「안 쟀다」를 «말한다»', () => {
    test('러너 밖 확장자를 «확장자별 수»로 이름 댄다', () => {
      const line = formatUnrunnableChangeKinds([
        'apps/ios/ElanousiOS/A.swift', 'apps/ios/ElanousiOS/B.swift', 'docs/x.md', 'src/a.ts',
      ]);
      expect(line).toContain('3');
      expect(line).toContain('.swift×2');
      expect(line).toContain('.md×1');
      // ⭐ 그리고 그 수가 «무슨 뜻인지»를 말한다 — 수만 있으면 초록으로 읽힌다.
      expect(line).toContain('안 쟀다');
    });

    test('⛔ 다른 축의 게이트가 책임지는 경로는 «사각지대가 아니다»', () => {
      // 그렇게 세면 수가 늘 부풀어 이 줄이 «읽히지 않는 소음»이 된다.
      expect(formatUnrunnableChangeKinds(['apps/android/app/src/main/kotlin/A.kt']))
        .toContain('(none)');
    });

    test('JS/TS 만 바뀌면 (none)', () => {
      expect(formatUnrunnableChangeKinds(['src/a.ts', 'test/b.test.tsx', 'x.mjs']))
        .toContain('(none)');
    });

    test('확장자가 «없는» 파일도 «놓치지 않는다»', () => {
      expect(formatUnrunnableChangeKinds(['Makefile', 'scripts/some.dir/noext']))
        .toContain('(no extension)×2');
    });

    test('⭐ 이 줄이 «게이트 산출에 실제로 실린다» — 만들어 놓고 안 내보내면 없는 것과 같다', () => {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['apps/ios/ElanousiOS/A.swift'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('must not run'); },
        runAndroidGate: () => 0,
      });
      expect(result.lines.join('\n')).toContain('.swift×1');
    });
  });

  // 🚨 2026-09-07 — #15941 이 «샌 경로»를 무는 시험들.
  //    Kotlin 만 바뀐 PR 은 testArgs 가 비어 skipTestStep 으로 조기 리턴한다.
  //    그 자리에서 안드로이드 게이트가 «돌지 않으면» 컴파일도 안 되는 시험이 그대로 착지한다.
  // 🍎 2026-09-08 — iOS 축도 «같은 자리»에 있어야 한다.
  describe('ios gate on the skipTestStep path', () => {
    test('⭐ Swift 만 바뀌어 테스트 단계를 건너뛸 때에도 «iOS 게이트는 돈다»', () => {
      const seen: string[][] = [];
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['apps/ios/ElanousiOS/A.swift'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('bun tests must not run for a Swift-only change'); },
        runAndroidGate: () => 0,
        runIosGate: (out) => { seen.push([...(out.args ?? [])]); return 0; },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('apps/ios/ElanousiOS/A.swift');
      expect(result.exitCode).toBe(0);
    });

    test('⛔ iOS 게이트가 막으면 exit 1 — 조기 리턴이 그것을 덮지 않는다', () => {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['apps/ios/ElanousiOS/A.swift'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('must not run'); },
        runAndroidGate: () => 0,
        runIosGate: (out) => { out.error('[ios-gate] ⛔ FAIL — 돈 시험이 «0개»다.'); return 1; },
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('돈 시험이 «0개»');
    });

    test('⛔ bun 시험이 «통과»해도 iOS 게이트가 막으면 exit 1', () => {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.ts', 'src/a.test.ts'], baseRef: 'HEAD' }),
        runTests: () => ({ status: 0, stdout: '', stderr: '' }),
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runAndroidGate: () => 0, runIosGate: () => 1,
      });
      expect(result.exitCode).toBe(1);
    });

    test('⛔ bun 시험이 «통과»해도 PWA 빌드 게이트가 막으면 exit 1 (GATE-PWA)', () => {
      const seen: string[][] = [];
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/maturity/feature-maturity.ts', 'src/a.test.ts'], baseRef: 'HEAD' }),
        runTests: () => ({ status: 0, stdout: '', stderr: '' }),
        runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0,
        runAndroidGate: () => 0, runIosGate: () => 0,
        runPwaGate: (out) => { seen.push([...(out.args ?? [])]); out.error('[pwa-gate] FAIL — PWA 빌드 실패(rc=1)'); return 1; },
      });
      expect(seen[0]).toContain('src/maturity/feature-maturity.ts');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('policy gates on the skipTestStep path', () => {
    const noRelatedTests = {
      changedFiles: () => ({ files: ['src/zz-probe.ts'], baseRef: 'HEAD' }),
      exists: () => false,
      runTests: () => { throw new Error('bun tests must not run when no related test is selected'); },
    };
    test('⭐ 시험이 하나도 선택되지 않아도 실패하는 daemon-port-gate 는 exit 1 이고 줄에 이름이 남는다', () => {
      const result = runSelfGateCli('/repo', {}, {
        ...noRelatedTests,
        runDaemonPortGate: (out) => { out.error('[daemon-port-gate] FAIL src/zz-probe.ts:1'); return 1; },
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('daemon-port-gate');
      expect(result.lines).toContain('scope: (test step skipped)');
      expect(result.testFiles).toEqual([]);
    });
    test('⭐ 같은 경로에서 daemon-port-gate 가 통과하면 exit 0', () => {
      const result = runSelfGateCli('/repo', {}, {
        ...noRelatedTests,
        runIsolationGate: () => 0,
        runMockModuleRestoreGate: () => 0,
        runModelHardcodeGate: () => 0,
        runDaemonPortGate: (out) => { out.log('[daemon-port-gate] PASS'); return 0; },
      });
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('daemon-port-gate');
      expect(result.lines).toContain('scope: (test step skipped)');
    });
  });
  describe('android gate on the skipTestStep path', () => {
    test('⭐ Kotlin 만 바뀌어 테스트 단계를 건너뛸 때에도 «안드로이드 게이트는 돈다»', () => {
      const seen: string[][] = [];
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['apps/android/app/src/main/kotlin/A.kt'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('bun tests must not run for a Kotlin-only change'); },
        runAndroidGate: (out) => { seen.push([...(out.args ?? [])]); return 0; },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('apps/android/app/src/main/kotlin/A.kt');
      expect(result.exitCode).toBe(0);
    });

    test('⛔ 그 경로에서 안드로이드 게이트가 막으면 exit 1 이다 — 조기 리턴이 그것을 덮지 않는다', () => {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['apps/android/app/src/main/kotlin/A.kt'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('bun tests must not run'); },
        runAndroidGate: (out) => { out.error('[android-gate] ⛔ FAIL — 돈 시험이 «0개»다.'); return 1; },
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('돈 시험이 «0개»');
    });

    test('⛔ bun 시험이 «통과»해도 안드로이드 게이트가 막으면 exit 1 이다', () => {
      const result = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.ts', 'src/a.test.ts'], baseRef: 'HEAD' }),
        runTests: () => ({ status: 0, stdout: '', stderr: '' }),
        runIsolationGate: () => 0,
        runMockModuleRestoreGate: () => 0,
        runAndroidGate: () => 1,
      });
      expect(result.exitCode).toBe(1);
    });
  });

  test('logs zero-valued gate.baseline when skipTestStep returns exit 0 without running tests', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const noChanges = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: [], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('tests must not run'); },
      });
      const docsOnly = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['docs/a.md'], baseRef: 'HEAD' }),
        runTests: () => { throw new Error('tests must not run'); },
      });
      const payloads = log.mock.calls
        .filter((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')
        .map((call) => call[2] as Record<string, unknown>);
      expect(noChanges.exitCode).toBe(0);
      expect(docsOnly.exitCode).toBe(0);
      expect(docsOnly.lines).toContain('scope: (test step skipped)');
      expect(payloads).toHaveLength(2);
      for (const payload of payloads) {
        expect(payload).toEqual(expect.objectContaining({
          introduced: 0,
          preexisting: 0,
          unknown: 0,
          preconditionUnmet: 0,
          timedOut: 0,
          timeoutPassedAtBase: 0,
          failures: [],
          baselineFiles: [],
          baselineStatus: 'pass',
          unrunImporterTotal: 0,
          lookupFailed: false,
          source: 'gate-cli',
        }));
        expect(Object.keys(payload)).toEqual(expect.arrayContaining([
          'introduced', 'preexisting', 'unknown', 'preconditionUnmet', 'timedOut', 'timeoutPassedAtBase',
          'failures', 'baselineFiles', 'baselineStatus', 'unrunImporterTotal', 'lookupFailed',
          'branch', 'workdir', 'source',
        ]));
      }
    } finally {
      log.mockRestore();
    }
  });

  test('swallows debug.log exceptions without changing exitCode or lines', () => {
    const introducedDeps = {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'HEAD' }),
      exists: () => true,
      runTests: () => fail('new red'),
      runBaseline: () => baseline('test/a.test.ts:\n1 pass\n'),
    };
    const passingDeps = {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
      exists: (path: string) => path === 'src/a.test.ts',
      runCommand: () => ok(),
      runTests: () => ok(),
    };
    const skipTestStepDeps = {
      changedFiles: () => ({ files: ['docs/a.md'], baseRef: 'HEAD' }),
      runTests: () => { throw new Error('tests must not run'); },
    };
    const quiet = spyOn(debug, 'log').mockImplementation(() => {});
    let introduced;
    let passing;
    let skipped;
    try {
      introduced = runSelfGateCli('/repo', {}, introducedDeps);
      passing = runSelfGateCli('/repo', {}, passingDeps);
      skipped = runSelfGateCli('/repo', {}, skipTestStepDeps);
    } finally {
      quiet.mockRestore();
    }
    const throwing = spyOn(debug, 'log').mockImplementation(() => {
      throw new Error('log failed');
    });
    try {
      const introducedLogged = runSelfGateCli('/repo', {}, introducedDeps);
      const passingLogged = runSelfGateCli('/repo', {}, passingDeps);
      const skippedLogged = runSelfGateCli('/repo', {}, skipTestStepDeps);
      expect(introducedLogged.exitCode).toBe(introduced.exitCode);
      expect(introducedLogged.exitCode).toBe(1);
      expect(introducedLogged.lines).toEqual(introduced.lines);
      expect(passingLogged.exitCode).toBe(passing.exitCode);
      expect(passingLogged.exitCode).toBe(0);
      expect(passingLogged.lines).toEqual(passing.lines);
      expect(skippedLogged.exitCode).toBe(skipped.exitCode);
      expect(skippedLogged.exitCode).toBe(0);
      expect(skippedLogged.lines).toEqual(skipped.lines);
    } finally {
      throwing.mockRestore();
    }
  });

  test('pass summary names unrun importer total when observation is partial and introduced is 0', () => {
    const fixture = fixtureRepository({
      'src/goal-author.ts': 'export const goal = 1;\n',
      'src/goal-author.test.ts': "import './goal-author.js';\n",
      'src/importer.test.ts': "import './goal-author.js';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/goal-author.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/goal-author.test.ts',
        runTests: () => ok(),
      });
      const summary = result.lines.find((line) => line.includes('tests: pass') || line.startsWith('partial observation:')) ?? '';
      expect(result.exitCode).toBe(0);
      expect(result.testFiles).toEqual(['src/goal-author.test.ts']);
      expect(summary).toBe('partial observation: 1 unrun importer tests; tests: pass (1 files)');
      expect(summary.startsWith('partial observation:')).toBe(true);
      expect(summary).not.toMatch(/^tests: pass \(\d+ files\)$/);
    } finally {
      fixture.dispose();
    }
  });

  test('baseline introduced=0 summary names unrun importer total instead of claiming a complete observation', () => {
    const fixture = fixtureRepository({
      'src/goal-author.ts': 'export const goal = 1;\n',
      'src/goal-author.test.ts': "import './goal-author.js';\n",
      'src/importer.test.ts': "import './goal-author.js';\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/goal-author.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/goal-author.test.ts',
        runTests: () => fail('base red'),
        runBaseline: () => baseline('test/a.test.ts:\n(fail) base red\n1 fail\n'),
      });
      const summary = result.lines.find((line) => line.includes('[gate-baseline]') || line.startsWith('partial observation:')) ?? '';
      expect(result.exitCode).toBe(0);
      expect(summary).toContain('introduced=0');
      expect(summary.startsWith('partial observation: 1 unrun importer tests; ')).toBe(true);
      expect(summary).toContain('[gate-baseline] introduced=0');
    } finally {
      fixture.dispose();
    }
  });

  test('zero unrun importer tests keep the previous pass and baseline summary wording', () => {
    const passing = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
      exists: (path) => path === 'src/a.test.ts',
      runCommand: () => ok(),
      runTests: () => ok(),
    });
    const preexisting = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.test.ts'], baseRef: 'HEAD' }),
      exists: () => true,
      runTests: () => fail('base red'),
      runBaseline: () => baseline('test/a.test.ts:\n(fail) base red\n1 fail\n'),
    });
    expect(passing.exitCode).toBe(0);
    expect(passing.lines).toContain('unrun importer tests: 0; unresolved relative specifiers: 0');
    expect(passing.lines).toContain('tests: pass (1 files)');
    expect(passing.lines.join('\n')).not.toContain('partial observation');
    expect(preexisting.exitCode).toBe(0);
    expect(preexisting.lines.join('\n')).toContain('[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0');
    expect(preexisting.lines.join('\n')).not.toContain('partial observation');
  });

  test('unrun importer observation does not change exit code or run extra importer tests', () => {
    const fixture = fixtureRepository({
      'src/goal-author.ts': 'export const goal = 1;\n',
      'src/goal-author.test.ts': "import './goal-author.js';\n",
      'src/importer.test.ts': "import './goal-author.js';\n",
    });
    try {
      const ran: string[][] = [];
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/goal-author.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/goal-author.test.ts',
        runTests: (_cwd, files) => {
          ran.push([...files]);
          return fail('base red');
        },
        runBaseline: () => baseline('test/a.test.ts:\n(fail) base red\n1 fail\n'),
      });
      expect(result.exitCode).toBe(0);
      expect(ran).toEqual([['src/goal-author.test.ts']]);
      expect(result.testFiles).toEqual(['src/goal-author.test.ts']);
      expect(result.lines.join('\n')).toContain('partial observation: 1 unrun importer tests');
    } finally {
      fixture.dispose();
    }
  });

  test('truncated unrun importer names report shown count and total together', () => {
    const files: Record<string, string> = { 'src/view.tsx': 'export const View = 1;\n', 'src/view.test.tsx': "import './view.tsx';\n" };
    for (let index = 1; index <= 22; index += 1) files[`src/importer-${index}.test.ts`] = "import './view.jsx';\n";
    const fixture = fixtureRepository(files);
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/view.tsx'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/view.test.tsx',
        runTests: () => ok(),
      });
      const line = result.lines.find((entry) => entry.startsWith('unrun importer tests:')) ?? '';
      expect(line).toContain('showing 20/22');
      expect(line).toContain('unrun importer tests: 22');
      expect(line).not.toContain('+2 more');
      expect(line).not.toContain('showing 20 of 22');
    } finally {
      fixture.dispose();
    }
  });

  test('restoring the previous pass summary when unrun importer total is above 0 fails this check', () => {
    const current = formatPartialObservationNote(3, 'tests: pass (1 files)');
    const restored = 'tests: pass (1 files)';
    const trailing = 'tests: pass (1 files); partial observation: 3 unrun importer tests';
    expect(current).toBe('partial observation: 3 unrun importer tests; tests: pass (1 files)');
    expect(current.startsWith('partial observation:')).toBe(true);
    expect(current).toContain('3');
    expect(current).not.toBe(restored);
    expect(current).not.toBe(trailing);
    expect(restored).not.toContain('partial observation');
  });

  test('restoring +N more truncation fails this check', () => {
    const observation = {
      total: 22,
      files: Array.from({ length: 20 }, (_, index) => `src/importer-${index + 1}.test.ts`),
      truncated: true,
      unresolvedRelativeSpecifiers: 0,
    };
    const current = formatUnrunImporterTests(observation);
    const restored = `unrun importer tests: 22 (${observation.files.join(', ')}, +2 more); unresolved relative specifiers: 0`;
    expect(current).toContain('showing 20/22');
    expect(current).not.toBe(restored);
    expect(restored).not.toContain('showing 20/22');
  });

  test('non-truncated unrun importer names do not add a shown-of-total ratio', () => {
    const fixture = fixtureRepository({
      'src/goal-author.ts': 'export const goal = 1;\n',
      'src/static-multiline.test.ts': "import { goal } from\n  './goal-author.js';\nvoid goal;\n",
    });
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/goal-author.ts'], baseRef: 'HEAD' }),
        exists: () => false,
        runTests: () => ok(),
      });
      const line = result.lines.find((entry) => entry.startsWith('unrun importer tests:')) ?? '';
      expect(line).toBe('unrun importer tests: 1 (src/static-multiline.test.ts); unresolved relative specifiers: 0');
      expect(line).not.toContain('showing ');
      expect(line).not.toMatch(/\d+\/\d+/);
    } finally {
      fixture.dispose();
    }
  });

  test('partial observation wraps the unchanged gate-baseline head instead of reordering its keys', () => {
    const wrapped = formatPartialObservationNote(9, '[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0');
    expect(wrapped).toBe('partial observation: 9 unrun importer tests; [gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0');
    expect(wrapped.indexOf('partial observation:')).toBe(0);
    expect(wrapped.indexOf('[gate-baseline]')).toBeGreaterThan(wrapped.indexOf('partial observation:'));
    expect(wrapped).toContain('9');
    expect(formatPartialObservationNote(0, '[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0'))
      .toBe('[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0');
  });

  test('truncated unrun importer names of 9 show a 3/9 displayed-of-total ratio', () => {
    const current = formatUnrunImporterTests({
      total: 9,
      files: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'],
      truncated: true,
      unresolvedRelativeSpecifiers: 0,
    });
    expect(current).toContain('showing 3/9');
    expect(current).toContain('unrun importer tests: 9');
    expect(current).not.toContain('showing 3 of 9');
  });

  test('logs unrunImporterTotal=5 on gate.baseline when five importer tests were not run', () => {
    const files: Record<string, string> = { 'src/view.tsx': 'export const View = 1;\n', 'src/view.test.tsx': "import './view.tsx';\n" };
    for (let index = 1; index <= 5; index += 1) files[`src/importer-${index}.test.ts`] = "import './view.jsx';\n";
    const fixture = fixtureRepository(files);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: ['src/view.tsx'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/view.test.tsx',
        runTests: () => ok(),
      });
      const payload = log.mock.calls.find((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')?.[2] as Record<string, unknown> | undefined;
      expect(result.exitCode).toBe(0);
      expect(payload).toEqual(expect.objectContaining({
        introduced: 0,
        preexisting: 0,
        unknown: 0,
        preconditionUnmet: 0,
        timedOut: 0,
        timeoutPassedAtBase: 0,
        unrunImporterTotal: 5,
        lookupFailed: false,
        source: 'gate-cli',
      }));
    } finally {
      log.mockRestore();
      fixture.dispose();
    }
  });

  test('logs lookupFailed distinctly from a genuine zero unrunImporterTotal', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const failed = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/a.test.ts',
        runCommand: () => ({ status: 2, stderr: 'grep unavailable' }),
        runTests: () => ok(),
      });
      const zero = runSelfGateCli('/repo', {}, {
        changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
        exists: (path) => path === 'src/a.test.ts',
        runCommand: () => ok(),
        runTests: () => ok(),
      });
      const payloads = log.mock.calls
        .filter((call) => call[0] === 'self-implement' && call[1] === 'gate.baseline')
        .map((call) => call[2] as Record<string, unknown>);
      expect(failed.exitCode).toBe(0);
      expect(zero.exitCode).toBe(0);
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toEqual(expect.objectContaining({
        unrunImporterTotal: null,
        lookupFailed: true,
        introduced: 0,
        preexisting: 0,
        unknown: 0,
        preconditionUnmet: 0,
        timedOut: 0,
        timeoutPassedAtBase: 0,
        source: 'gate-cli',
      }));
      expect(payloads[1]).toEqual(expect.objectContaining({
        unrunImporterTotal: 0,
        lookupFailed: false,
        introduced: 0,
        preexisting: 0,
        unknown: 0,
        preconditionUnmet: 0,
        timedOut: 0,
        timeoutPassedAtBase: 0,
        source: 'gate-cli',
      }));
      expect(payloads[0]!.unrunImporterTotal).not.toBe(payloads[1]!.unrunImporterTotal);
      expect(payloads[0]!.lookupFailed).not.toBe(payloads[1]!.lookupFailed);
    } finally {
      log.mockRestore();
    }
  });

  test('rejects ambiguous --base and --pr invocation', () => {
    expect(() => runSelfGateCli('/repo', { base: 'main', pr: '1' })).toThrow('either --base <ref> or --pr <number>');
  });

  test('--pr reports a dirty worktree path for the PR branch without changing exit code', () => {
    const commands = prCommands({
      files: [{ path: 'src/a.ts' }],
      baseRefOid: 'base-sha',
      headRefOid: 'head-sha',
      headRefName: 'pr-branch',
      baseRefName: 'main',
    });
    commands.push(overlapLogCommand('base-sha', 'main'));
    let listed = 0;
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands),
      exists: (path) => path === 'src/a.test.ts',
      runTests: () => ok(),
      listPrWorktrees: () => {
        listed += 1;
        return [{ path: '/wt/pr-branch', branch: 'pr-branch' }];
      },
      inspectWorktreeDirtiness: (path) => {
        expect(path).toBe('/wt/pr-branch');
        return { dirty: true };
      },
    });
    expect(listed).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('dirty');
    expect(result.lines.join('\n')).toContain('/wt/pr-branch');
    expect(commands).toEqual([]);
  });

  test('--pr reports clean/absent when the PR branch worktree is missing and omits a dirty warning', () => {
    const commands = prCommands({
      files: [{ path: 'src/a.ts' }],
      baseRefOid: 'base-sha',
      headRefOid: 'head-sha',
      headRefName: 'pr-branch',
      baseRefName: 'main',
    });
    commands.push(overlapLogCommand('base-sha', 'main'));
    let listed = 0;
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands),
      exists: (path) => path === 'src/a.test.ts',
      runTests: () => ok(),
      listPrWorktrees: () => {
        listed += 1;
        return [];
      },
    });
    expect(listed).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain('pr worktree: clean/absent');
    expect(result.lines.join('\n')).not.toContain('dirty');
    expect(commands).toEqual([]);
  });

  test('--pr reports overlapping filenames from base-history commits without changing a passing exit code', () => {
    const commands = prCommands({
      files: [{ path: 'src/a.ts' }],
      baseRefOid: 'base-sha',
      headRefOid: 'head-sha',
      headRefName: 'pr-branch',
      baseRefName: 'main',
    });
    commands.push(
      overlapLogCommand('base-sha', 'main', 'commit abcdef1\nsrc/a.ts\n'),
    );
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands),
      exists: (path) => path === 'src/a.test.ts',
      runTests: () => ok(),
      listPrWorktrees: () => [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('overlap');
    expect(result.lines.join('\n')).toContain('src/a.ts');
    expect(commands).toEqual([]);
  });

  test('--pr lookup failures keep the prior exit code and say the observation could not be asked', () => {
    const commands = prCommands({
      files: [{ path: 'src/a.ts' }],
      baseRefOid: 'base-sha',
      headRefOid: 'head-sha',
      headRefName: 'pr-branch',
      baseRefName: 'main',
    });
    commands.push(['git', landingHistoryLogArgs(null, 'base-sha..main'), { status: 1, stdout: '', stderr: 'git log unavailable' }]);
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands),
      exists: (path) => path === 'src/a.test.ts',
      runTests: () => ok(),
      listPrWorktrees: () => ({ lookupFailed: 'worktree list unavailable' }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain('pr worktree: lookup failed (worktree list unavailable)');
    expect(result.lines).toContain('pr file overlap: lookup failed (git log failed)');
    expect(commands).toEqual([]);
  });

  test('uncommitted path without --pr omits the new observation lines', () => {
    const result = runSelfGateCli('/repo', {}, {
      changedFiles: () => ({ files: ['src/a.ts'], baseRef: 'HEAD' }),
      exists: (path) => path === 'src/a.test.ts',
      runCommand: () => ok(),
      runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).not.toContain('pr worktree:');
    expect(result.lines.join('\n')).not.toContain('pr file overlap:');
  });

  test('--base path omits the new observation lines', () => {
    const commands: Array<[string, string[], CommandResult]> = [
      ['git', ['diff', '--name-only', 'main...HEAD'], ok('src/a.ts\n')],
      ['git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ok()],
      importerLookup(),
      lsFiles(),
    ];
    const result = runSelfGateCli('/repo', { base: 'main' }, {
      runCommand: scriptedCommand(commands),
      exists: (path) => path === 'src/a.test.ts',
      runTests: () => ok(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).not.toContain('pr worktree:');
    expect(result.lines.join('\n')).not.toContain('pr file overlap:');
    expect(commands).toEqual([]);
  });


  test('real git overlap observes only commits after the PR base OID', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-gate-overlap-'));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status).toBe(0);
      return result;
    };
    try {
      git(['init', '--quiet', '-b', 'trunk']);
      git(['config', 'user.email', 'gate@example.com']);
      git(['config', 'user.name', 'gate']);
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/before.ts'), 'export const before = 1;\n');
      git(['add', 'src/before.ts']);
      git(['commit', '-m', 'before-base', '--quiet']);
      const beforeOid = git(['rev-parse', 'HEAD']).stdout.trim();
      writeFileSync(join(cwd, 'src/before.ts'), 'export const before = 2;\n');
      git(['add', 'src/before.ts']);
      git(['commit', '-m', 'before-base-edit', '--quiet']);
      const baseOid = git(['rev-parse', 'HEAD']).stdout.trim();
      writeFileSync(join(cwd, 'src/after.ts'), 'export const after = 1;\n');
      git(['add', 'src/after.ts']);
      git(['commit', '-m', 'after-base', '--quiet']);
      const afterOid = git(['rev-parse', 'HEAD']).stdout.trim();
      let overlapLogArgs: string[] = [];
      const overlap = observePrFileOverlap(cwd, ['src/before.ts', 'src/after.ts'], baseOid, 'trunk', (command, args, commandCwd) => {
        overlapLogArgs = args;
        // Reproduce a slow shard crossing a wall-clock second before Git reads the history.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
        const result = spawnSync(command, args, { cwd: commandCwd, encoding: 'utf8' });
        return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      });
      expect(overlap).toEqual({ status: 'overlap', files: ['src/after.ts'] });
      expect(overlap.status === 'overlap' ? overlap.files : []).not.toContain('src/before.ts');
      expect(overlapLogArgs).toEqual(landingHistoryLogArgs(null, `${baseOid}..trunk`));
      const none = observePrFileOverlap(cwd, ['src/before.ts'], baseOid, 'trunk', undefined);
      expect(none).toEqual({ status: 'none' });
      // The production query uses only the base range; this direct fixed-origin
      // query also verifies that the range excludes pre-base commits.
      const logged = spawnSync('git', landingHistoryLogArgs('1970-01-01T00:00:00Z', `${baseOid}..trunk`), { cwd, encoding: 'utf8' });
      expect(logged.status).toBe(0);
      expect(logged.stdout).toContain(afterOid);
      expect(logged.stdout).toContain('src/after.ts');
      expect(logged.stdout).not.toContain(beforeOid);
      expect(logged.stdout).not.toContain('src/before.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--pr missing headRefName is unavailable rather than clean/absent', () => {
    const commands = prCommands({
      files: [{ path: 'src/a.ts' }],
      baseRefOid: 'base-sha',
      headRefOid: 'head-sha',
      baseRefName: 'main',
    });
    commands.push(overlapLogCommand('base-sha', 'main'));
    const result = runSelfGateCli('/repo', { pr: '6268' }, {
      runCommand: scriptedCommand(commands),
      exists: (path) => path === 'src/a.test.ts',
      runTests: () => ok(),
      listPrWorktrees: () => [{ path: '/wt/pr-branch', branch: 'pr-branch' }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain('pr worktree: lookup failed (PR headRefName missing)');
    expect(result.lines.join('\n')).not.toContain('pr worktree: clean/absent');
    expect(commands).toEqual([]);
  });
  test('forcing both observations to none fails the dirty-worktree and overlap signals', () => {
    const worktree = observePrWorktreeDirtiness('/repo', 'pr-branch', {
      listPrWorktrees: () => [{ path: '/wt/pr-branch', branch: 'pr-branch' }],
      inspectWorktreeDirtiness: () => ({ dirty: true }),
    });
    const overlap = observePrFileOverlap(
      '/repo',
      ['src/a.ts'],
      'base-sha',
      'main',
      (command, args) => {
        expect([command, args]).toEqual(['git', landingHistoryLogArgs(null, 'base-sha..main')]);
        return ok('commit abcdef1\nsrc/a.ts\n');
      },
    );
    const forcedNoneWorktree = formatPrWorktreeObservation({ status: 'clean/absent' });
    const forcedNoneOverlap = formatPrFileOverlapObservation({ status: 'none' });
    expect(formatPrWorktreeObservation(worktree)).toContain('dirty');
    expect(formatPrWorktreeObservation(worktree)).toContain('/wt/pr-branch');
    expect(formatPrFileOverlapObservation(overlap)).toContain('src/a.ts');
    expect(forcedNoneWorktree).not.toContain('dirty');
    expect(forcedNoneWorktree).not.toContain('/wt/pr-branch');
    expect(forcedNoneOverlap).not.toContain('src/a.ts');
    expect(forcedNoneWorktree).not.toBe(formatPrWorktreeObservation(worktree));
    expect(forcedNoneOverlap).not.toBe(formatPrFileOverlapObservation(overlap));
  });
});

/**
 * ⛔⭐ 「changed=0」을 «초록»으로 읽는 사고를 막는 자리(2026-09-02 · 🅕 보고 · 🅣 재현).
 * 커밋 «전»에 `self gate --changed` 를 돌리면 작업 트리 변경은 «안 세므로» changed=0 이 나온다.
 * 그것은 「통과」가 아니라 ***「아무것도 안 쟀다」***인데, 문면이 그 둘을 안 갈랐다.
 * ⚠️ 이 시험이 «못 보는 것»: 실제 git 이 dirty 를 어떻게 세는지는 여기서 안 잰다(주입으로 판정한다).
 */
describe('self gate: changed=0 이 「통과」인지 「안 쟀다」인지 갈린다', () => {
  test('센 것이 0인데 커밋 안 된 변경이 있으면 «그렇게 말한다»', () => {
    const fixture = fixtureRepository({});
    try {
      const result = runSelfGateCli(fixture.cwd, { base: 'HEAD' }, {
        changedFiles: () => ({ files: [], baseRef: 'HEAD', ignoredDirtyPaths: ['docs/a.md', 'src/b.ts'] }),
        exists: () => false,
      });
      expect(result.lines.join('\n')).toContain('센 것이 0인데');
      expect(result.lines.join('\n')).toContain('2개');
    } finally { fixture.dispose(); }
  });

  test('센 것이 0이고 트리도 깨끗하면 «그 말을 안 한다»', () => {
    const fixture = fixtureRepository({});
    try {
      const result = runSelfGateCli(fixture.cwd, { base: 'HEAD' }, {
        changedFiles: () => ({ files: [], baseRef: 'HEAD', ignoredDirtyPaths: [] }),
        exists: () => false,
      });
      expect(result.lines.join('\n')).not.toContain('센 것이 0인데');
    } finally { fixture.dispose(); }
  });
});

describe('planRemoteGateShardCommands — GATE-REMOTE-SHARD-PLAN 게이트 노출 결선', () => {
  test('GATE-REMOTE-SHARD-PLAN: 183파일 가짜 입력이 조각 계획으로 갈라 원격 명령에 조각 인자가 실린다', async () => {
    // 동적 import: 베이스(export 없음)에서도 이 파일은 로드되고 이 시험만 빨개진다(RED 증인).
    const { planRemoteGateShardCommands } = await import('./gate-cli.js');
    const files = Array.from({ length: 183 }, (_, index) => `src/mod-${String(index).padStart(3, '0')}.ts`);
    const plan = planRemoteGateShardCommands(files, 4, { planFile: '/repo/shard-plan.json' });
    expect(plan.orchestrationId).toMatch(/^gate-183-[0-9a-f]{8}$/);
    expect(plan.shards).toHaveLength(4);
    expect(plan.commands).toHaveLength(4);
    expect(plan.shards.flatMap((shard) => shard.files)).toEqual(files);
    plan.commands.forEach((command, index) => {
      expect(command[command.indexOf('--orchestration-id') + 1]).toBe(plan.orchestrationId);
      expect(command[command.indexOf('--shard-id') + 1]).toBe(`${plan.orchestrationId}/shard-${index + 1}`);
      expect(command[command.indexOf('--shard-position') + 1]).toBe(String(index + 1));
      expect(command[command.indexOf('--shard-plan') + 1]).toBe('/repo/shard-plan.json');
      expect(command).toContain('--test');
    });
  });
});
