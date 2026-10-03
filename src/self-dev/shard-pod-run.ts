import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { runPodCommand } from '../task-orchestrator/surfaces/pod-command-job.js';
import type { PoolLeaseMeasure } from '../task-orchestrator/surfaces/pod-lease.js';
import { aggregateGateTestShards, type GateShardAttempt } from './shard-aggregate.js';
import { assignGateShardsToPool, type ShardPlacement } from './shard-placement.js';
import type { GateTestShard } from './shard-plan.js';
import type { ShardRunResult } from './shard-run.js';

type PodShardCommand = typeof runPodCommand;

/** Execute already-measured GT2 bundles through the existing Pod command Job, never through SSH. */
export async function runGateShardsOnPod(
  shards: readonly GateTestShard[],
  pool: PoolLeaseMeasure,
  poolSpec: string,
  currentCommit: string,
  baselineCommit: string,
  deps: { run?: PodShardCommand; read?: (path: string) => string; measure?: () => PoolLeaseMeasure } = {},
): Promise<ShardRunResult & { placements: ShardPlacement[] }> {
  const run = deps.run ?? (await import('../task-orchestrator/surfaces/pod-command-job.js')).runPodCommand;
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const { parsePodPool } = await import('../task-orchestrator/surfaces/pod-pool.js');
  const poolMembers = parsePodPool(poolSpec);
  const specs = poolSpec.split(',').map((spec) => spec.trim()).filter(Boolean);
  const members = new Map(poolMembers.map((member, index) => [member.context, specs[index]!]));
  const measure = deps.measure ?? (async () => (await import('../task-orchestrator/surfaces/pod-lease.js')).measurePoolLease(poolMembers));
  for (const commit of [currentCommit, baselineCommit]) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Pod shard source requires a 40-character commit SHA');
  }
  const attempts: GateShardAttempt[] = [];
  const planned = [...shards];
  let placements = assignGateShardsToPool(planned, pool);
  if (placements.some((placement) => !members.has(placement.context))) throw new Error('leased pool member is not in Pod pool spec');
  let pending = planned;
  for (let round = 1; round <= 2 && pending.length; round++) {
    const failed = new Set<string>();
    for (const shard of pending) {
      const context = placements.find((entry) => entry.shardId === shard.id)!.context;
      let current: { exitCode: number | null; junit?: string } = { exitCode: null };
      let base: { exitCode: number | null; junit?: string } = { exitCode: null };
      try {
        // Pin the context by narrowing the existing pool spec; do not send a command over SSH.
        const member = members.get(context);
        if (!member) throw new Error(`pool context not in spec: ${context}`);
        const executeOnMember = async (commit: string) => {
          const report = `shard-${shard.id}.xml`;
          const result = await run({ command: ['bash', '-c', 'mkdir -p "$HOME/outbox"; bun install --frozen-lockfile >/dev/null && bun test --reporter=junit --reporter-outfile="$HOME/outbox/$1" "${@:2}"', 'shard', report, ...shard.files],
            pool: member,
            clone: true, memoryLimit: `${Math.max(4, Math.ceil(shard.plannedRssMb / 1024))}Gi`,
            source: { kind: 'commit', sha: commit } });
          return { exitCode: result.exitCode, junit: read(join(result.artifactsDir, report)) };
        };
        current = await executeOnMember(currentCommit);
        base = await executeOnMember(baselineCommit);
      } catch {
        failed.add(context);
      }
      attempts.push({ shardId: shard.id, attempt: round, currentExitCode: current.exitCode, baselineExitCode: base.exitCode,
        ...(current.junit ? { currentJUnit: current.junit } : {}), ...(base.junit ? { baselineJUnit: base.junit } : {}) });
    }
    const retry = new Set(aggregateGateTestShards(planned, attempts).retryShardIds);
    pending = planned.filter((shard) => retry.has(shard.id));
    if (pending.length && round === 1 && failed.size) {
      try {
        const available = await measure();
        const toMove = new Set(pending.filter((shard) => failed.has(placements.find((entry) => entry.shardId === shard.id)!.context)).map((shard) => shard.id));
        const reassigned = assignGateShardsToPool(planned.filter((shard) => toMove.has(shard.id)),
          { members: available.members.filter((member) => !failed.has(member.context) && members.has(member.context)) });
        placements = placements.map((placement) => reassigned.find((next) => next.shardId === placement.shardId) ?? placement);
      } catch (error) {
        return { aggregate: { status: 'unmeasured', retryShardIds: [...retry] }, shards: planned, attempts, placements, reason: String(error) };
      }
    }
  }
  return { aggregate: aggregateGateTestShards(planned, attempts), shards: planned, attempts, placements };
}
