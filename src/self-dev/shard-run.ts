import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDeterministicChildEnvironment } from '../../scripts/lib/deterministic-env.js';
import { withBaselineWorktree } from '../self-implement/gate-baseline.js';
import { aggregateGateTestShards, type GateShardAttempt, type GateShardAggregate } from './shard-aggregate.js';
import { planGateTestShards, type GateTestShard } from './shard-plan.js';

export interface ShardRunResult {
  aggregate: GateShardAggregate;
  shards: GateTestShard[];
  attempts: GateShardAttempt[];
  reason?: string;
  measurementFailures?: number;
}

export type ShardProcess = (cwd: string, files: readonly string[]) => {
  exitCode: number | null;
  signal?: string | null;
  junit?: string;
  rssMb?: number;
  seconds?: number;
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
): ShardRunResult {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid --shards count');
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
  let shards: GateTestShard[];
  try {
    shards = planGateTestShards(files, rss, seconds, budgetGiB, count);
  } catch (error) {
    return { aggregate: { status: 'unmeasured', retryShardIds: [] }, shards: [], attempts: [], reason: String(error), ...(measurementFailures ? { measurementFailures } : {}) };
  }
  const attempts: GateShardAttempt[] = [];
  const baseline = baselineWorktree(cwd, baseRef, (dir) => {
    let pending = shards;
    for (let round = 1; round <= 2 && pending.length; round++) {
      for (const shard of pending) {
        const runSafely = (location: string): ReturnType<ShardProcess> => {
          try { return run(location, shard.files); }
          catch { return { exitCode: null }; }
        };
        const current = runSafely(cwd);
        const base = runSafely(dir);
        attempts.push({
          shardId: shard.id, attempt: round,
          currentJUnit: current.junit, baselineJUnit: base.junit,
          currentExitCode: current.exitCode, baselineExitCode: base.exitCode,
          currentSignal: current.signal, baselineSignal: base.signal,
        });
      }
      const retry = new Set(aggregateGateTestShards(shards, attempts).retryShardIds);
      pending = shards.filter((shard) => retry.has(shard.id));
    }
    return aggregateGateTestShards(shards, attempts);
  });
  if ('retryShardIds' in baseline) return { aggregate: baseline, shards, attempts, ...(measurementFailures ? { measurementFailures } : {}) };
  return { aggregate: { status: 'unmeasured', retryShardIds: shards.map((shard) => shard.id) }, shards, attempts, reason: baseline.log, ...(measurementFailures ? { measurementFailures } : {}) };
}

export function runBunShard(cwd: string, files: readonly string[]): ReturnType<ShardProcess> {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-shard-junit-'));
  const report = join(dir, 'result.xml');
  const isolated = prepareDeterministicChildEnvironment('elanous-shard-test-env-');
  try {
    const measured = files.length === 1;
    const args = ['test', '--reporter=junit', `--reporter-outfile=${report}`, ...files];
    const started = performance.now();
    const result = Bun.spawnSync(['bun', ...args], {
      cwd, env: isolated.env, stdout: 'pipe', stderr: 'pipe', timeout: 300_000,
    });
    return {
      exitCode: result.exitCode,
      signal: result.signalCode ? String(result.signalCode) : undefined,
      junit: existsSync(report) ? readFileSync(report, 'utf8') : undefined,
      rssMb: measured ? result.resourceUsage.maxRSS / (1024 * 1024) : undefined,
      seconds: measured ? (performance.now() - started) / 1000 : undefined,
    };
  } finally {
    isolated.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}
