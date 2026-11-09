import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, parseOptions, runGateNode, type GateRunner, type GateTools } from './gate-node.js';
import { hardRehearsalGateArgs, hardRehearsalGateVersion } from './gate-radius-live.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { appendGateShardLedgerBatch, gateShardLedgerPath, readGateShardLedger, type GateShardLedgerRow } from '../../src/release-loop/gate-shard-ledger.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { PodCommandResult } from '../../src/task-orchestrator/surfaces/pod-command-job.js';

setDefaultTimeout(60_000);
const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

const BASE = 'b'.repeat(40);
const ENV = 'c'.repeat(64);
const IMAGE = `sha256:${'d'.repeat(64)}`;
const TEST_FILE = 'src/ledger-sim.test.ts';
const VERSION = '0.3.7';
const GRAPH_PINS = { graphSha: '1'.repeat(64), recipeSha: '2'.repeat(64), graphEntry: 'gate-entry-v1',
  recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14_400_000 };
const EXECUTION_IDENTITY = { imageDigest: IMAGE, bunVersion: '1.4.2', platform: 'linux', architecture: 'x64',
  envFingerprint: ENV, baseImageDigest: IMAGE };

function sourceTree(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'pwa'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"gate-ledger-sim","version":"1.0.0"}\n');
  writeFileSync(join(repo, 'bun.lock'), 'lockfileVersion = 1\n');
  writeFileSync(join(repo, 'apps', 'pwa', 'bun.lock'), '{"lockfileVersion":1,"configVersion":1,"workspaces":{"":{"name":"sim-pwa"}},"packages":{}}\n');
  writeFileSync(join(repo, TEST_FILE), "import { test } from 'bun:test';\ntest('ledger sim', () => {});\n");
  for (const args of [['init', '-q'], ['config', 'user.name', 'Gate ledger sim'], ['config', 'user.email', 'sim@example.invalid'], ['add', '.'], ['commit', '-qm', 'gate ledger simulation']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  }
  return repo;
}

function runCommit(repo: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}

function makeRunner(repo: string, podCalls: string[], ledgerBatchFailure = false, graphRunId?: string, runId?: string): GateRunner {
  return createGateRunner(repo, undefined, undefined, undefined, undefined, undefined, {
    ...makeGateTools(repo, podCalls, ledgerBatchFailure),
    graphRunId: graphRunId ?? null, runId: runId ?? null,
  });
}

function makeGateTools(repo: string, podCalls: string[], ledgerBatchFailure = false): GateTools {
  const command: GateRunner['command'] = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run') return { rc: 0, output: '1 pass\n0 fail\nRan 1 test across 1 file.\n' };
    if (cmd === 'bun' && args[0] === 'install') return { rc: 0, output: 'simulated bun install\n' };
    if (cmd === 'rg') return { rc: 1, output: '' };
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { rc: result.status ?? 2, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  const podCommand = async (): Promise<PodCommandResult> => {
    podCalls.push('pod');
    const artifactsDir = join(repo, '..', `artifacts-${podCalls.length}`);
    mkdirSync(artifactsDir, { recursive: true });
    const output = '1 pass\n0 fail\nRan 1 test across 1 file.\n';
    const junit = `<testsuites><testsuite file="${TEST_FILE}" tests="1"><testcase name="ledger sim" file="${TEST_FILE}"/></testsuite></testsuites>`;
    writeFileSync(join(artifactsDir, 'shard.log'), output);
    writeFileSync(join(artifactsDir, 'shard.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.log'), output);
    writeFileSync(join(artifactsDir, 'part-0.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'part-0.junit.xml'), junit);
    writeFileSync(join(artifactsDir, 'junit.xml'), junit);
    writeFileSync(join(artifactsDir, 'runtime-identity.json'), JSON.stringify(EXECUTION_IDENTITY));
    writeFileSync(join(artifactsDir, 'install.rc'), '0\n');
    writeFileSync(join(artifactsDir, 'install.log'), '');
    return { exitCode: 0, artifactsDir, job: `sim-${podCalls.length}` };
  };
  return {
      command,
      podCommand,
      poolOverride: new PodPoolScheduler([
        // Source: #36029 gate-ledger simulation models one remote slot so shard reuse order is deterministic.
        { context: 'gate-sim', sshHost: 'sim-remote', capacity: 1, k3dCluster: 'gate-sim' },
      ]),
      graphRecipePins: () => GRAPH_PINS,
      podImageDigest: () => IMAGE,
      remoteRun: (_host: string, script: string) => ({ status: 0, stdout: script === 'uname -s' ? 'Linux\n' : '', stderr: '' }),
      appendShardLedgerBatch: (path: string, rows: readonly GateShardLedgerRow[], required: boolean, batchId?: ReturnType<typeof randomUUID>) => {
        if (ledgerBatchFailure) throw new Error('simulated HQ append outage');
        return appendGateShardLedgerBatch(path, rows, required, batchId);
      },
  };
}

function podOptions(repo: string, ledgerPath: string, logDir: string) {
  return { pool: 'gate-sim@sim-remote:1', shards: 1, freshShards: false,
    shardsFile: { path: join(logDir, 'shards.json'), version: VERSION, ledgerPath, receiptRoot: join(repo, 'receipts'),
      base40: BASE, envFingerprint: ENV, expectedImageDigest: IMAGE, graphPins: GRAPH_PINS, executionIdentity: EXECUTION_IDENTITY } };
}

test('GATE-LEDGER-HQ-SINGLE sim: append loss holds remote gates; resumed cuts use HQ evidence without local logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-ledger-hq-sim-'));
  try {
    const repo = sourceTree(root);
    const commit = runCommit(repo);
    const podCalls: string[] = [];
    const runner = makeRunner(repo, podCalls, true);
    const blockedParent = join(root, 'blocked-ledger-parent');
    writeFileSync(blockedParent, 'not a directory');
    const failedLedger = join(blockedParent, 'gate-shards.jsonl');
    const failedLogDir = join(root, 'failed-logs');
    await expect(runner.sweep(repo, failedLogDir, podOptions(repo, failedLedger, failedLogDir)))
      .rejects.toThrow('remote gate refused: HQ shard ledger');
    expect(podCalls).toEqual([]);

    const batchFailureCalls: string[] = [];
    const batchFailureRunner = makeRunner(repo, batchFailureCalls, true);
    const batchLedger = gateShardLedgerPath(VERSION, join(root, 'batch-failure-hq'));
    const batchLogDir = join(root, 'batch-failure-logs');
    await expect(batchFailureRunner.sweep(repo, batchLogDir, podOptions(repo, batchLedger, batchLogDir)))
      .rejects.toThrow('remote gate refused: HQ shard result batch write failed');
    expect(batchFailureCalls).toEqual(['pod']);

    const ledgerPath = gateShardLedgerPath(VERSION, join(root, 'hq'));
    const observedAt = '2026-11-08T00:00:00.000Z';
    const row: GateShardLedgerRow = { v: 1, version: VERSION, phase: 'cut', shardId: 'pod-0', files: [TEST_FILE],
      host: 'sim-remote', executor: 'pod', imageDigest: IMAGE, measuredImageDigest: IMAGE, currentImageDigest: IMAGE,
      commit, envFingerprint: ENV, startedAt: '2026-11-07T23:59:00.000Z', endedAt: '2026-11-07T23:59:10.000Z', observedAt,
      state: 'done', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, failureIds: [], errorIds: [], attribution: 'complete',
      logPath: null, junitPath: null, stopReason: null, attemptId: 'prior-attempt' };
    expect(appendGateShardLedgerBatch(ledgerPath, [row], true, '00000000-0000-4000-8000-000000000001')).toBeNull();
    const resumedCalls: string[] = [];
    const resumedRunner = makeRunner(repo, resumedCalls);
    const emptyLogDir = join(root, 'resume-without-shard-logs');
    const resumed = await resumedRunner.sweep(repo, emptyLogDir, podOptions(repo, ledgerPath, emptyLogDir));
    expect(resumed.rc).toBe(0);
    expect(resumedCalls, 'a complete HQ cut batch must resume without local shard logs or a new Pod').toEqual([]);

    const invalidRcLedger = gateShardLedgerPath(VERSION, join(root, 'invalid-rc-hq'));
    expect(appendGateShardLedgerBatch(invalidRcLedger, [{ ...row, rc: 2 }], true, '00000000-0000-4000-8000-000000000002')).toBeNull();
    const invalidRcCalls: string[] = [];
    const graphRunId = 'gate-ledger-hq-single-sim-run';
    const invalidRcRunner = makeRunner(repo, invalidRcCalls, false, graphRunId);
    const invalidRcLogDir = join(root, 'invalid-rc-logs');
    await invalidRcRunner.sweep(repo, invalidRcLogDir, podOptions(repo, invalidRcLedger, invalidRcLogDir));
    expect(invalidRcCalls, 'an HQ batch with an unexpected exit code must be rerun').toEqual(['pod']);
    const persisted = readGateShardLedger(invalidRcLedger);
    expect(persisted?.rows.some((entry) => entry.state === 'done' && entry.runId === graphRunId),
      'the rerun writes a completed HQ row scoped to this release run').toBe(true);
    expect(persisted?.rows.some((entry) => entry.runId === graphRunId), 'raw HQ JSONL row remains queryable by its release run').toBe(true);
    expect(readFileSync(invalidRcLedger, 'utf8')).toContain(`"runId":"${graphRunId}"`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-LEDGER-HQ-SINGLE sim: hard-rehearsal CLI run scope reaches HQ plan, execution, and reuse rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-ledger-hard-cli-sim-'));
  try {
    const repo = sourceTree(root);
    const commit = runCommit(repo);
    const runId = 'hard-00000000-0000-4000-8000-000000000001';
    const args = [...hardRehearsalGateArgs('0.3.8', runId, commit, '0.3.7', 'sim-pool:1').slice(1), '--baseline-commit', commit];
    const gateVersion = hardRehearsalGateVersion('0.3.8', runId);
    const podCalls: string[] = [];
    const instanceRoot = join(root, 'instance');
    const ledgerPath = gateShardLedgerPath(gateVersion, instanceRoot);
    const priorCwd = process.cwd();
    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    process.chdir(repo);
    process.env.ELANOUS_STATE_DIR = instanceRoot;
    setElanousConfigDir(instanceRoot);
    const gateTools = makeGateTools(repo, podCalls);
    try {
      // Default CLI → judge → createGateRunner → sweep path; only GateTools external boundaries are simulated.
      expect(await runGateNode(args, { ELANOUS_STATE_DIR: instanceRoot }, undefined, undefined, () => IMAGE, undefined, gateTools)).toBe(0);
    } finally {
      process.chdir(priorCwd);
      if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDir;
      resetElanousConfigDir();
    }
    const afterExecution = readGateShardLedger(ledgerPath);
    expect(afterExecution?.malformed).toBe(0);
    expect(afterExecution?.rows.every((row) => row.runId === runId), 'CLI run id is persisted on every HQ plan/execution event').toBe(true);
    expect(afterExecution?.rows.some((row) => row.state === 'pending'), 'HQ ledger includes the planned event').toBe(true);
    expect(afterExecution?.rows.some((row) => row.state === 'done' && row.ran === 1), 'HQ ledger includes measured execution').toBe(true);

    // Repeat the actual direct hard-rehearsal CLI invocation. A separate graph context with the
    // same run ID would miss regressions in direct-CLI scope propagation and HQ reuse rows.
    const priorCwdForReuse = process.cwd();
    const priorStateDirForReuse = process.env.ELANOUS_STATE_DIR;
    process.chdir(repo);
    process.env.ELANOUS_STATE_DIR = instanceRoot;
    setElanousConfigDir(instanceRoot);
    try {
      // Keep the Pod shard receipt, but remove the separate file-CAS copy so the next CLI run
      // exercises the HQ shard receipt reuse path and writes a reuseDecision row.
      rmSync(join(instanceRoot, 'release', gateVersion, 'gate-logs', 'cut', 'receipts', 'files'), { recursive: true, force: true });
      expect(await runGateNode(args, { ELANOUS_STATE_DIR: instanceRoot }, undefined, undefined, () => IMAGE, undefined, gateTools)).toBe(0);
    } finally {
      process.chdir(priorCwdForReuse);
      if (priorStateDirForReuse === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDirForReuse;
      resetElanousConfigDir();
    }
    const afterReuse = readGateShardLedger(ledgerPath);
    expect(afterReuse?.malformed).toBe(0);
    expect(afterReuse?.rows.every((row) => row.runId === runId), 'hard rehearsal run id remains on reuse rows').toBe(true);
    expect(afterReuse?.rows.some((row) => row.reuseDecision === 'reuse' && row.runId === runId), 'HQ reuse decision retains CLI run id').toBe(true);
    expect(podCalls).toEqual(['pod']);

    // Reusing a runner for an unscoped invocation must clear its previous CLI identity.
    const priorCwdAfterRun = process.cwd();
    const priorStateDirAfterRun = process.env.ELANOUS_STATE_DIR;
    const beforeUnscoped = afterReuse?.rows.length ?? 0;
    process.chdir(repo);
    process.env.ELANOUS_STATE_DIR = instanceRoot;
    setElanousConfigDir(instanceRoot);
    try {
      const unscopedArgs = args.filter((arg, index) => arg !== '--run-id' && args[index - 1] !== '--run-id');
      const unscopedRunner = makeRunner(repo, podCalls, false, undefined, runId);
      expect(await runGateNode(unscopedArgs, { ELANOUS_STATE_DIR: instanceRoot }, unscopedRunner, undefined, () => IMAGE)).toBe(2);
    } finally {
      process.chdir(priorCwdAfterRun);
      if (priorStateDirAfterRun === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDirAfterRun;
      resetElanousConfigDir();
    }
    const afterUnscoped = readGateShardLedger(ledgerPath);
    const unscopedRows = afterUnscoped?.rows.slice(beforeUnscoped) ?? [];
    expect(unscopedRows.length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-LEDGER-HQ-SINGLE sim: direct CLI parser accepts hard-rehearsal run scope', () => {
  const runId = 'hard-00000000-0000-4000-8000-000000000001';
  expect(parseOptions(['--commit', BASE, '--version', '0.3.8-rc.1', '--baseline-version', '0.3.7', '--run-id', runId,
    '--executor', 'pod', '--pod-pool', 'sim-pool@sim-remote:1', '--pod-shards', '1', '--rehearsal-baseline'], {}))
    .toMatchObject({ runId, rehearsalBaseline: true });
  expect(() => parseOptions(['--commit', BASE, '--version', '0.3.8-rc.1', '--baseline-version', '0.3.7', '--run-id', runId,
    '--executor', 'pod', '--pod-pool', 'sim-pool@sim-remote:1', '--pod-shards', '1'], {}))
    .toThrow('--run-id is only valid with --rehearsal-baseline');
});
