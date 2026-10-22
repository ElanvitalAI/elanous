import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug, redactSecretText } from '../debug/log.js';
import { prepareDeterministicChildEnvironment } from '../../scripts/lib/deterministic-env.js';
import { withGateTestEnv } from '../../scripts/lib/gate-test-env.js';
import { withBaselineWorktree } from '../self-implement/gate-baseline.js';
import { aggregateGateTestShards, type GateShardAttempt, type GateShardAggregate } from './shard-aggregate.js';
import { GateShardCapacityError, planFixedGateTestShards, planSelfGateSpawnSeparatedShards, type GateTestShard } from './shard-plan.js';
import { isGateSpawnLaneFile } from './spawn-lane-files.js';

export interface ShardRunResult {
  aggregate: GateShardAggregate;
  shards: GateTestShard[];
  attempts: GateShardAttempt[];
  reason?: string;
  measurementFailures?: number;
  /** The measured RSS plan needed more bundles than the requested count. */
  expandedFrom?: number;
  /** A fixed plan selected explicitly, or after the measured plan exceeds host expansion capacity. */
  distribution?: 'fixed' | 'fixed-cap-fallback';
  fallbackReason?: string;
  /** OP FU (MK #8178 shard-9) — raw evidence of every failed shard process (exit≠0 · signal · no JUnit). Observation only:
   *  the aggregate never reads it. Absent = no shard process reported failure output. */
  failureEvidence?: ShardFailureEvidence[];
  /** Latest failed attempt's reason for each incomplete shard; copied into the gate artifact summary. */
  unmeasuredByShard?: Record<string, string>;
  /** git stderr tail (redacted · ≤2KB · one line) when the baseline worktree could not be added. */
  baselineStderrTail?: string;
}

/** What a failed shard process leaves behind so «test failure vs runner error» can be told apart after the fact. */
export interface ShardFailureOutput {
  durationMs: number;
  /** Last 64KB of the child's stdout/stderr (redacted). */
  stdoutTail: string;
  stderrTail: string;
}

export interface ShardFailureEvidence extends ShardFailureOutput {
  shardId: string;
  side: 'current' | 'baseline';
  attempt: number;
  files: string[];
  exitCode: number | null;
  signal: string | null;
}

export interface ShardRunMode {
  /** OP FU — sorted round-robin into `count` shards, zero pre-measurement runs. Default off: the measured planner. */
  fixedDistribution?: boolean;
  /** Measured on the executing host; override only for deterministic planning tests. */
  hostResources?: { cores: number; freeMemoryGiB: number; freeTmpGiB: number };
}

function hostResources(): ShardRunMode['hostResources'] | undefined {
  try {
    const tmp = statfsSync(tmpdir());
    // Linux page cache is reclaimable. `freemem()` alone saw only ~10 GiB on a WSL host
    // with 24 GiB MemAvailable and would incorrectly cap a two-shard plan at one.
    let freeMemoryGiB = freemem() / (1024 ** 3);
    if (process.platform === 'linux') {
      const availableKiB = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1];
      if (availableKiB) freeMemoryGiB = Number(availableKiB) / (1024 ** 2);
    }
    return {
      cores: availableParallelism(),
      freeMemoryGiB,
      freeTmpGiB: Number(tmp.bavail) * Number(tmp.bsize) / (1024 ** 3),
    };
  } catch { return undefined; }
}

/** One expansion slot needs one CPU, one shard memory budget, and 1 GiB of free tmp space.
 *  Explicitly requested shards remain the caller's choice; this only limits automatic growth. */
export function maxAutomaticShardCount(requested: number, budgetGiB: number, resources: ShardRunMode['hostResources']): number {
  if (!resources || !Number.isFinite(budgetGiB) || budgetGiB <= 0) return requested;
  const limit = Math.min(
    Math.floor(resources.cores),
    Math.floor(resources.freeMemoryGiB / budgetGiB),
    Math.floor(resources.freeTmpGiB),
  );
  return Math.max(requested, Number.isFinite(limit) ? limit : requested);
}

export type ShardProcess = (cwd: string, files: readonly string[]) => {
  exitCode: number | null;
  signal?: string | null;
  junit?: string;
  rssMb?: number;
  seconds?: number;
  /** Bounded, redacted process output for an abnormal exit before JUnit exists. */
  diagnostic?: string;
  /** Present only when the process failed (exit≠0 · signal · no JUnit) — observation only, never part of the verdict. */
  failure?: ShardFailureOutput;
};

export const SHARD_FAILURE_TAIL_BYTES = 64 * 1024;

function outputTail(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return '';
  const tail = bytes.length > SHARD_FAILURE_TAIL_BYTES ? bytes.subarray(bytes.length - SHARD_FAILURE_TAIL_BYTES) : bytes;
  return redactSecretText(Buffer.from(tail).toString('utf8'));
}

/** `<shardId>.failure.json` per failed shard (shard ids are already `shard-<n>`). Top level = the latest current-side
 *  failure (else the latest baseline one); `failures` keeps every failed side/attempt. Returns the written paths. */
export function writeShardFailureEvidence(dir: string, evidence: readonly ShardFailureEvidence[]): string[] {
  if (!evidence.length) return [];
  mkdirSync(dir, { recursive: true });
  const byShard = new Map<string, ShardFailureEvidence[]>();
  for (const item of evidence) byShard.set(item.shardId, [...(byShard.get(item.shardId) ?? []), item]);
  const written: string[] = [];
  for (const [shardId, failures] of byShard) {
    const primary = [...failures].reverse().find((item) => item.side === 'current') ?? failures[failures.length - 1]!;
    const path = join(dir, `${shardId.replace(/[^A-Za-z0-9._-]/g, '_')}.failure.json`);
    const { side, attempt, ...fields } = primary;
    writeFileSync(path, `${JSON.stringify({ ...fields, side, attempt, failures }, null, 2)}\n`);
    debug.log('self-dev.shard', 'failure-evidence', { shardId, path, failures: failures.length, exitCode: primary.exitCode, signal: primary.signal });
    written.push(path);
  }
  return written;
}

const DIAGNOSTIC_STREAM_LIMIT = 240;

function boundedDiagnostic(stdout: Uint8Array, stderr: Uint8Array): string | undefined {
  const oneStream = (bytes: Uint8Array): string => {
    const safe = redactSecretText(Buffer.from(bytes).toString('utf8')).replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim();
    if (safe.length <= DIAGNOSTIC_STREAM_LIMIT) return safe;
    // Bun can print the cause after a long preamble; keep both ends within the same bound.
    const head = Math.floor((DIAGNOSTIC_STREAM_LIMIT - 1) / 2);
    return `${safe.slice(0, head)}…${safe.slice(-(DIAGNOSTIC_STREAM_LIMIT - 1 - head))}`;
  };
  const out = oneStream(stdout);
  const err = oneStream(stderr);
  return [out && `stdout: ${out}`, err && `stderr: ${err}`].filter(Boolean).join(' · ') || undefined;
}

/** Absent only when the path provably is not a file there (missing, or not a regular file); any other stat error
 *  (permissions …) is not evidence of absence, so the file stays in the baseline run (fail-closed: unmeasured). */
const absentAtBaseline = (path: string): boolean => {
  try { return !statSync(path).isFile(); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'ENOENT' || code === 'ENOTDIR'; }
};

/** One process per bundle and per revision; a failed runner is retried only for its own bundle. */
export function runShardedGateTests(
  cwd: string,
  files: readonly string[],
  baseRef: string,
  count = 2,
  run: ShardProcess = runBunShard,
  baselineWorktree: typeof withBaselineWorktree = withBaselineWorktree,
  budgetGiB = 8,
  mode: ShardRunMode = {},
): ShardRunResult {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid --shards count');
  if (mode.fixedDistribution) {
    // Opt-in: no per-file pre-measurement at all — the shard runs themselves (JUnit · rc · signal · baseline) decide.
    let fixed: GateTestShard[];
    try { fixed = planFixedGateTestShards(files, count); }
    catch (error) { return { aggregate: { status: 'unmeasured', retryShardIds: [] }, shards: [], attempts: [], reason: String(error), distribution: 'fixed' }; }
    debug.log('self-dev.shard', 'fixed-distribution', { shards: fixed.length, files: fixed.reduce((sum, shard) => sum + shard.files.length, 0) });
    return { ...runPlannedShards(cwd, fixed, baseRef, run, baselineWorktree), distribution: 'fixed' };
  }
  const rss = new Map<string, number>();
  const seconds = new Map<string, number>();
  const failedMeasurements: string[] = [];
  for (const file of [...new Set(files)]) {
    let sample: ReturnType<ShardProcess>;
    try {
      sample = run(cwd, [file]);
    } catch {
      failedMeasurements.push(file);
      continue;
    }
    if (![0, 1].includes(sample.exitCode ?? -1) || sample.signal || !sample.junit
      || !Number.isFinite(sample.rssMb) || sample.rssMb! <= 0
      || !Number.isFinite(sample.seconds) || sample.seconds! < 0) {
      failedMeasurements.push(file);
      continue;
    }
    rss.set(file, sample.rssMb!);
    seconds.set(file, sample.seconds!);
  }
  if (failedMeasurements.length) {
    if (!rss.size) return { aggregate: { status: 'unmeasured', retryShardIds: [] }, shards: [], attempts: [], reason: 'no valid file measurements', measurementFailures: failedMeasurements.length };
    const averageRss = [...rss.values()].reduce((sum, value) => sum + value, 0) / rss.size;
    const averageSeconds = [...seconds.values()].reduce((sum, value) => sum + value, 0) / seconds.size;
    for (const file of failedMeasurements) {
      rss.set(file, averageRss);
      seconds.set(file, averageSeconds);
    }
  }
  const measurementFailures = failedMeasurements.length || undefined;
  const fixedAtHostCap = (maxCount: number, reason: string): ShardRunResult => {
    try {
      const fixed = planFixedGateTestShards(files, maxCount);
      debug.log('self-dev.shard', 'host-cap-fixed-fallback', { requested: count, cap: maxCount,
        files: new Set(files).size, reason, measurementFailures: measurementFailures ?? 0 });
      return { ...runPlannedShards(cwd, fixed, baseRef, run, baselineWorktree), distribution: 'fixed-cap-fallback',
        fallbackReason: reason, ...(measurementFailures ? { measurementFailures } : {}) };
    } catch (error) {
      return { aggregate: { status: 'unmeasured', retryShardIds: [] }, shards: [], attempts: [],
        reason: `host-cap fixed fallback failed: ${String(error)}; measured plan: ${reason}`,
        ...(measurementFailures ? { measurementFailures } : {}) };
    }
  };
  let shards: GateTestShard[] | undefined;
  let plannedCount = count;
  try {
    const fileCount = new Set(files).size;
    const totalRss = [...rss.values()].reduce((sum, value) => sum + value, 0);
    const lowerBound = Number.isFinite(budgetGiB) && budgetGiB > 0 ? Math.ceil(totalRss / (budgetGiB * 1024)) : count;
    plannedCount = Math.max(count, Math.min(fileCount, lowerBound));
    // The requested count may exceed the number of files. Only expansion is bounded by file count.
    const maxCount = Math.max(count, Math.min(fileCount, maxAutomaticShardCount(count, budgetGiB, mode.hostResources ?? hostResources())));
    if (plannedCount > maxCount) return fixedAtHostCap(maxCount, `host shard expansion cap ${maxCount} < needed ${plannedCount} (requested ${count}, measured RSS sum ${Math.round(totalRss)} MiB, budget ${budgetGiB} GiB)`);
    for (; plannedCount <= maxCount; plannedCount++) {
      try { shards = planSelfGateSpawnSeparatedShards(files, rss, seconds, budgetGiB, plannedCount); break; }
      catch (error) {
        if (!(error instanceof GateShardCapacityError)) throw error;
        if (plannedCount === maxCount) return fixedAtHostCap(maxCount, `host shard expansion cap ${maxCount} < needed ≥${maxCount + 1} (requested ${count}, ${error.message})`);
      }
    }
  } catch (error) {
    return { aggregate: { status: 'unmeasured', retryShardIds: [] }, shards: [], attempts: [], reason: String(error), ...(measurementFailures ? { measurementFailures } : {}) };
  }
  if (!shards) return { aggregate: { status: 'unmeasured', retryShardIds: [] }, shards: [], attempts: [], reason: 'shard planning produced no result' };
  if (plannedCount > count) debug.log('self-dev.shard', 'plan-expanded', {
    requested: count, planned: shards.length, files: new Set(files).size, budgetGiB,
    measurementFailures: measurementFailures ?? 0,
  });
  return { ...runPlannedShards(cwd, shards, baseRef, run, baselineWorktree), ...(plannedCount > count ? { expandedFrom: count } : {}), ...(measurementFailures ? { measurementFailures } : {}) };
}

/** Shared by the measured and the fixed planner: current + baseline per shard, one retry round, one aggregate. */
function runPlannedShards(
  cwd: string,
  shards: GateTestShard[],
  baseRef: string,
  run: ShardProcess,
  baselineWorktree: typeof withBaselineWorktree,
): ShardRunResult {
  const attempts: GateShardAttempt[] = [];
  const failureEvidence: ShardFailureEvidence[] = [];
  const keepFailure = (shardId: string, side: ShardFailureEvidence['side'], attempt: number, files: readonly string[], result: ReturnType<ShardProcess>) => {
    if (!result.failure) return;
    failureEvidence.push({ shardId, side, attempt, files: [...files], exitCode: result.exitCode, signal: result.signal ?? null, ...result.failure });
  };
  const baseline = baselineWorktree(cwd, baseRef, (dir) => {
    // LIGHT-RC-MEASURE ① — bun silently skips a path that is not in the baseline tree (exit 0), so a shard holding a
    // new test file could never yield a complete baseline JUnit. Run the baseline side on the files the base has; an
    // unreadable tree is not evidence of absence, so then every file stays in (the old shape).
    const treeReadable = (() => { try { return statSync(dir).isDirectory(); } catch { return false; } })();
    const atBase = (shard: GateTestShard) => treeReadable ? shard.files.filter((file) => !absentAtBaseline(join(dir, file))) : [...shard.files];
    let pending = shards;
    for (let round = 1; round <= 2 && pending.length; round++) {
      for (const shard of pending) {
        const runSafely = (location: string, selected: readonly string[]): ReturnType<ShardProcess> => {
          try { return run(location, selected); }
          catch { return { exitCode: null }; }
        };
        const baselineFiles = atBase(shard);
        if (baselineFiles.length < shard.files.length) {
          debug.log('self-dev.shard', 'baseline-files-absent', { shardId: shard.id, round, absent: shard.files.filter((file) => !baselineFiles.includes(file)) });
        }
        const current = runSafely(cwd, shard.files);
        const base = baselineFiles.length ? runSafely(dir, baselineFiles) : { exitCode: 0 };
        keepFailure(shard.id, 'current', round, shard.files, current);
        keepFailure(shard.id, 'baseline', round, baselineFiles, base);
        attempts.push({
          shardId: shard.id, attempt: round,
          currentJUnit: current.junit, baselineJUnit: base.junit,
          currentExitCode: current.exitCode, baselineExitCode: base.exitCode,
          currentSignal: current.signal, baselineSignal: base.signal,
          currentDiagnostic: current.diagnostic, baselineDiagnostic: base.diagnostic,
          baselineFiles,
          currentRoot: cwd, baselineRoot: dir,
        });
      }
      const retry = new Set(aggregateGateTestShards(shards, attempts).retryShardIds);
      pending = shards.filter((shard) => retry.has(shard.id));
    }
    return aggregateGateTestShards(shards, attempts);
  });
  const evidence = failureEvidence.length ? { failureEvidence } : {};
  if ('retryShardIds' in baseline) return {
    aggregate: baseline, shards, attempts, ...evidence,
    ...(baseline.retryShardIds.length ? { unmeasuredByShard: incompleteShardReasons(baseline.retryShardIds, attempts) } : {}),
  };
  const retryShardIds = shards.map((shard) => shard.id);
  // The stderr tail has its own budget (≤2KB, already redacted) so the 500-char log cut cannot drop it.
  const stderrTail = baseline.gitStderrTail;
  const stderrPart = stderrTail ? ` · git stderr: ${stderrTail}` : '';
  return {
    aggregate: { status: 'unmeasured', retryShardIds }, shards, attempts, reason: baseline.log, ...evidence,
    unmeasuredByShard: Object.fromEntries(retryShardIds.map((id) => [id, `baseline worktree: ${redactSecretText(baseline.log).replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').slice(0, 500)}${stderrPart}`])),
    ...(stderrTail ? { baselineStderrTail: stderrTail } : {}),
  };
}

function incompleteShardReasons(shardIds: readonly string[], attempts: readonly GateShardAttempt[]): Record<string, string> {
  return Object.fromEntries(shardIds.map((id) => {
    const latest = attempts.filter((attempt) => attempt.shardId === id).at(-1);
    if (!latest) return [id, 'no shard attempt recorded'];
    const side = (name: string, rc: number | null, signal: string | null | undefined, junit: string | undefined, diagnostic: string | undefined): string => {
      const safeDiagnostic = diagnostic ? redactSecretText(diagnostic).replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').slice(0, 500) : undefined;
      return `${name}: exit ${rc ?? 'unavailable'}, signal ${signal ?? 'none'}, JUnit ${junit === undefined ? 'missing' : 'present'}`
        + (safeDiagnostic ? `; ${safeDiagnostic}` : '');
    };
    const statuses = [
      side('current', latest.currentExitCode, latest.currentSignal, latest.currentJUnit, latest.currentDiagnostic),
      ...(latest.baselineFiles?.length === 0 ? [] : [side('baseline', latest.baselineExitCode, latest.baselineSignal, latest.baselineJUnit, latest.baselineDiagnostic)]),
    ];
    return [id, `${statuses.join(' · ')} · aggregate rejected (incomplete, malformed JUnit, or exit/JUnit mismatch)`];
  }));
}

export function selfGateShardTimeoutMs(files: readonly string[]): number {
  const spawnFiles = files.filter(isGateSpawnLaneFile);
  if (spawnFiles.length && spawnFiles.length !== files.length) throw new Error('self gate spawn lane mixed with regular tests');
  return spawnFiles.length ? 120_000 : 300_000;
}

export function runBunShard(cwd: string, files: readonly string[]): ReturnType<ShardProcess> {
  return runBunShardWithSpawn(cwd, files, Bun.spawnSync);
}

/** Child launch seam for verifying the actual command and process timeout. */
export function runBunShardWithSpawn(cwd: string, files: readonly string[], spawn: typeof Bun.spawnSync): ReturnType<ShardProcess> {
  const timeout = selfGateShardTimeoutMs(files);
  const spawnLane = timeout === 120_000;
  const dir = mkdtempSync(join(tmpdir(), 'elanous-shard-junit-'));
  const report = join(dir, 'result.xml');
  const isolated = prepareDeterministicChildEnvironment('elanous-shard-test-env-', { env: withGateTestEnv(process.env) });
  try {
    const measured = files.length === 1;
    const args = ['test', ...(spawnLane ? ['--timeout=120000'] : []), '--reporter=junit', `--reporter-outfile=${report}`, ...files];
    const started = performance.now();
    const result = spawn(['bun', ...args], {
      cwd, env: isolated.env, stdout: 'pipe', stderr: 'pipe', timeout,
    });
    const durationMs = performance.now() - started;
    const junit = existsSync(report) ? readFileSync(report, 'utf8') : undefined;
    const failed = result.exitCode !== 0 || !!result.signalCode || junit === undefined;
    return {
      exitCode: result.exitCode,
      signal: result.signalCode ? String(result.signalCode) : undefined,
      junit,
      ...(junit === undefined && (result.exitCode !== 0 || result.signalCode)
        ? { diagnostic: boundedDiagnostic(result.stdout, result.stderr) } : {}),
      rssMb: measured ? result.resourceUsage.maxRSS / (1024 * 1024) : undefined,
      seconds: measured ? durationMs / 1000 : undefined,
      ...(failed ? { failure: { durationMs: Math.round(durationMs), stdoutTail: outputTail(result.stdout), stderrTail: outputTail(result.stderr) } } : {}),
    };
  } finally {
    isolated.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}
