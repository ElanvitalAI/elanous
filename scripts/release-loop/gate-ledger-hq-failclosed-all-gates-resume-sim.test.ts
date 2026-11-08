import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, type GateRunner } from './gate-node.js';
import { appendGateShardLedgerBatch, gateShardLedgerPath, type GateShardLedgerRow } from '../../src/release-loop/gate-shard-ledger.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { PodCommandResult } from '../../src/task-orchestrator/surfaces/pod-command-job.js';

setDefaultTimeout(60_000);

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
  writeFileSync(join(repo, 'package.json'), '{"name":"gate-ledger-sim","version":"1.0.0"}\n');
  writeFileSync(join(repo, 'bun.lock'), 'lockfileVersion = 1\n');
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

function makeRunner(repo: string, podCalls: string[], ledgerBatchFailure = false): GateRunner {
  const command: GateRunner['command'] = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run') return { rc: 0, output: '1 pass\n0 fail\nRan 1 test across 1 file.\n' };
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
  const tools = {
    graphRecipePins: () => GRAPH_PINS,
    podImageDigest: () => IMAGE,
    remoteRun: (_host: string, script: string) => ({ status: 0, stdout: script === 'uname -s' ? 'Linux\n' : '', stderr: '' }),
    appendShardLedgerBatch: (path: string, rows: readonly GateShardLedgerRow[], required: boolean, batchId?: ReturnType<typeof randomUUID>) => {
      if (ledgerBatchFailure) throw new Error('simulated HQ append outage');
      return appendGateShardLedgerBatch(path, rows, required, batchId);
    },
  };
  return createGateRunner(repo, undefined, command, podCommand, new PodPoolScheduler([
    { context: 'gate-sim', sshHost: 'sim-remote', capacity: 1, k3dCluster: 'gate-sim' },
  ]), undefined, tools);
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
    const invalidRcRunner = makeRunner(repo, invalidRcCalls);
    const invalidRcLogDir = join(root, 'invalid-rc-logs');
    await invalidRcRunner.sweep(repo, invalidRcLogDir, podOptions(repo, invalidRcLedger, invalidRcLogDir));
    expect(invalidRcCalls, 'an HQ batch with an unexpected exit code must be rerun').toEqual(['pod']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
