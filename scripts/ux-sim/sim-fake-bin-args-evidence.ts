#!/usr/bin/env bun
/** Write and read back a fake-bin argv receipt through the canonical logs CLI. */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../../src/debug/log.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { LOG_RETENTION_DEFAULTS, logsDbPath, registerLogStoreSink, setLogInstanceName } from '../../src/mss/logging/log-store.js';
import { prodInstanceRoot } from '../../src/instance/resolve.js';
import { __setIdentityFileForTests } from '../../src/mss/identity-store.js';
import { runLogsCli } from '../../src/cli/logs-cli.js';
import { resolveLogInstanceName } from '../../src/mss/logging/log-store.js';
import {
  FAKE_BIN_ARGS_COMPLETION_BOUNDARY,
  canonicalizePathWithMissingTail,
  isSafeFakeBinEvidenceRoot,
  isSafeFakeBinEvidenceStateRoot,
  isValidFakeBinArgsEvent,
  simulateFakeBinArgumentResponses,
  type FakeBinArgsRunEvent,
} from '../../src/ux-sim/fake-bin-args-sim.js';

export interface FakeBinArgsEvidenceResult {
  logRowId: string | number;
  runId: string;
  missionId: string;
  taskId: string;
  occurredAt: string;
  testRoot: string;
  productionRoot: string;
  storePath: string;
  event: FakeBinArgsRunEvent;
  completionBoundary: string;
}

async function readCanonicalLogs(event: FakeBinArgsRunEvent, instance: string): Promise<string[]> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  const oldWarn = console.warn;
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  const capture = (bucket: string[]) => ((chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown) => {
    bucket.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    if (typeof callback === 'function') (callback as (error?: Error | null) => void)(null);
    return true;
  });
  console.log = (...items: unknown[]) => { stdout.push(`${items.map(String).join(' ')}\n`); };
  console.error = (...items: unknown[]) => { stderr.push(`${items.map(String).join(' ')}\n`); };
  console.warn = console.error;
  process.stdout.write = capture(stdout) as typeof process.stdout.write;
  process.stderr.write = capture(stderr) as typeof process.stderr.write;
  try {
    // Same production `logs` action and federation flags, scoped to this isolated test store.
    const status = await runLogsCli({ event: event.event, all: true, includeTest: true, instance, json: true, limit: '1000' }, {
      // Keep the canonical logs action while constraining its target to this fake test world;
      // registering the test store globally would create a production-home instance registry.
      resolveTargets: () => ({ targets: [{ name: instance, dbPath: logsDbPath() }] }),
    });
    if (status !== 0) throw new Error(`canonical logs query failed rc=${status}: ${stderr.join('').trim()}`);
    return stdout.join('').split(/\r?\n/u).filter(Boolean);
  } finally {
    console.log = oldLog;
    console.error = oldError;
    console.warn = oldWarn;
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
  }
}

function verifyReadBack(lines: string[], event: FakeBinArgsRunEvent, testRoot: string): { id: string | number; occurredAt: string; storePath: string } {
  const rows = lines.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
  const matching = rows.filter((row) => {
    if (row.event !== event.event || typeof row.data !== 'string') return false;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      return data.runId === event.data.runId && data.missionId === event.data.missionId && data.taskId === event.data.taskId;
    } catch { return false; }
  });
  if (matching.length !== 1) throw new Error(`canonical logs readback expected one identity-bound event, found ${matching.length}`);
  const row = matching[0]!;
  if (!(typeof row.id === 'number' || typeof row.id === 'string') || !row.id) throw new Error('canonical log row has no event id');
  if (typeof row.ts !== 'string' || Number.isNaN(Date.parse(row.ts))) throw new Error('canonical log row has no valid timestamp');
  const data = JSON.parse(row.data as string) as unknown;
  if (!isValidFakeBinArgsEvent({ occurredAt: event.occurredAt, event: row.event, data }, event.data)) throw new Error('canonical logs payload differs from the validated simulation receipt');
  if (Math.abs(Date.parse(row.ts) - Date.parse(event.occurredAt)) > 10_000) throw new Error('canonical log timestamp is not adjacent to the simulated event timestamp');
  if (typeof row.store !== 'string' || !row.store.startsWith('test:')) throw new Error('canonical event was not read from a registered test instance');
  if (typeof row.storePath !== 'string' || resolve(row.storePath) !== resolve(testRoot, 'logs/logs.db')) throw new Error('canonical event came from an unexpected logs store');
  return { id: row.id, occurredAt: row.ts, storePath: row.storePath };
}

export async function runFakeBinArgsEvidence(): Promise<FakeBinArgsEvidenceResult> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const repoRealRoot = realpathSync(repoRoot);
  const requestedTestRoot = join(repoRoot, '.elanous-test');
  const oldStateDir = process.env.ELANOUS_STATE_DIR;
  const oldRunId = process.env.ELANOUS_RUN_ID;
  const oldConfigOverride = getElanousConfigDirOverride();
  let unregisterStore: (() => void) | undefined;
  const runId = `fake-bin-args-${crypto.randomUUID()}`;
  const missionId = `mission-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;

  try {
    mkdirSync(requestedTestRoot, { recursive: true });
    const isolatedRoot = realpathSync(requestedTestRoot);
    const productionRootPath = prodInstanceRoot();
    // Isolated train shards may provide a temporary HOME with no production instance yet.
    // Resolve an existing production root to catch symlinks; when absent, retain its canonical
    // lexical location without creating it or making absence a test failure.
    const productionRoot = canonicalizePathWithMissingTail(productionRootPath);
    if (!isSafeFakeBinEvidenceRoot(repoRealRoot, requestedTestRoot, isolatedRoot, productionRoot)) {
      throw new Error(`refusing unsafe test-state path: requested=${requestedTestRoot} actual=${isolatedRoot} production=${productionRoot}`);
    }
    const configuredStateRoot = process.env.ELANOUS_STATE_DIR;
    const requestedStateRoot = configuredStateRoot
      ? (existsSync(configuredStateRoot) ? realpathSync(configuredStateRoot) : resolve(configuredStateRoot))
      : isolatedRoot;
    if (!isSafeFakeBinEvidenceStateRoot(isolatedRoot, requestedStateRoot, requestedStateRoot, productionRoot)) {
      throw new Error(`refusing unsafe state root outside the isolated test root: ${requestedStateRoot}`);
    }
    mkdirSync(requestedStateRoot, { recursive: true });
    const stateRoot = realpathSync(requestedStateRoot);
    if (!isSafeFakeBinEvidenceStateRoot(isolatedRoot, requestedStateRoot, stateRoot, productionRoot)) {
      throw new Error(`refusing unsafe state root after realpath: requested=${requestedStateRoot} actual=${stateRoot}`);
    }
    process.env.ELANOUS_STATE_DIR = stateRoot;
    process.env.ELANOUS_RUN_ID = runId;
    setElanousConfigDir(stateRoot);
    // debug.log attaches a stable identity by default. Keep this test-world receipt identity
    // inside its isolated state root instead of creating ~/.elanous/identity.json.
    __setIdentityFileForTests(join(stateRoot, 'identity.json'));
    const instance = resolveLogInstanceName();
    setLogInstanceName(instance);
    unregisterStore = registerLogStoreSink((sink) => debug.registerSink(sink), 'ux.sim.fake-bin-args', LOG_RETENTION_DEFAULTS) ?? undefined;
    if (!unregisterStore) throw new Error('could not register isolated test logs.db sink');

    const simulation = simulateFakeBinArgumentResponses({ runId, missionId, taskId });
    if (!simulation.event || !isValidFakeBinArgsEvent(simulation.event, { runId, missionId, taskId })) throw new Error('fake-bin response/call receipt failed exact validation');
    if (simulation.completionBoundary !== FAKE_BIN_ARGS_COMPLETION_BOUNDARY || simulation.realToolExecutions !== 0 || simulation.shellExecutions !== 0) throw new Error('simulation completion boundary was not satisfied');
    debug.log('ux.sim.fake-bin-args', simulation.event.event, simulation.event.data);
    debug.flush();

    const readBackLines = await readCanonicalLogs(simulation.event, instance);
    const observed = verifyReadBack(readBackLines, simulation.event, stateRoot);
    const result: FakeBinArgsEvidenceResult = {
      logRowId: observed.id,
      runId,
      missionId,
      taskId,
      occurredAt: observed.occurredAt,
      testRoot: stateRoot,
      productionRoot,
      storePath: observed.storePath,
      event: simulation.event,
      completionBoundary: FAKE_BIN_ARGS_COMPLETION_BOUNDARY,
    };
    // Completion claims are emitted only after the canonical logs CLI returned the exact event row.
    console.log(`simulation E4 event=${simulation.event.event} logRowId=${observed.id} runId=${runId} missionId=${missionId} taskId=${taskId} occurredAt=${observed.occurredAt}`);
    console.log(`완료 경계 실물: ${FAKE_BIN_ARGS_COMPLETION_BOUNDARY}`);
    console.log('완료 경계 증거 명령: bun scripts/ux-sim/sim-fake-bin-args-evidence.ts');
    console.log(`canonical logs readback verified; fake executable calls=${simulation.calls.length}; real tool executions=0; real shell executions=0; store=${observed.storePath}`);
    console.log(`canonical readback receipt=${JSON.stringify(result)}`);
    return result;
  } finally {
    unregisterStore?.();
    __setIdentityFileForTests(null);
    resetElanousConfigDir();
    if (oldConfigOverride !== undefined) setElanousConfigDir(oldConfigOverride);
    if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = oldStateDir;
    if (oldRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = oldRunId;
  }
}

if (import.meta.main) await runFakeBinArgsEvidence();
