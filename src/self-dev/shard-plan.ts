import { isGateSpawnLaneFile } from './spawn-lane-files.js';

export interface GateTestShard {
  id: string;
  files: string[];
  plannedRssMb: number;
  plannedSeconds: number;
}

/** Keep real child/PTY tests out of ordinary self-gate shards, within the caller's shard budget. */
export function planSelfGateSpawnSeparatedShards(
  files: readonly string[],
  rssMb: ReadonlyMap<string, number>,
  seconds: ReadonlyMap<string, number>,
  budgetGiB: number,
  shardCount: number,
): GateTestShard[] {
  const unique = [...new Set(files)];
  const spawn = unique.filter(isGateSpawnLaneFile);
  const regular = unique.filter((file) => !isGateSpawnLaneFile(file));
  if (!spawn.length || !regular.length) return planGateTestShards(unique, rssMb, seconds, budgetGiB, shardCount);
  if (shardCount < 2) throw new Error('self gate spawn lane needs at least two shards when regular and spawn tests coexist');
  const spawnCount = Math.min(3, spawn.length, shardCount - 1);
  const planned = [
    ...planGateTestShards(regular, rssMb, seconds, budgetGiB, shardCount - spawnCount),
    ...planGateTestShards(spawn, rssMb, seconds, budgetGiB, spawnCount),
  ];
  return planned.map((shard, index) => ({ ...shard, id: `shard-${index + 1}` }));
}

/** RSS values are the per-file rss_mb observations; the budget is in GiB (1 GiB = 1024 MB here). */
export function planGateTestShards(
  files: readonly string[],
  rssMb: ReadonlyMap<string, number>,
  seconds: ReadonlyMap<string, number>,
  budgetGiB: number,
  shardCount = Number.POSITIVE_INFINITY,
): GateTestShard[] {
  if (!Number.isFinite(budgetGiB) || budgetGiB <= 0) throw new Error('invalid shard memory budget');
  if (shardCount !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(shardCount) || shardCount < 1)) throw new Error('invalid shard count');
  const capacity = budgetGiB * 1024;
  const unique = [...new Set(files)];
  for (const file of unique) {
    const rss = rssMb.get(file);
    const duration = seconds.get(file);
    if (!file || rss === undefined || !Number.isFinite(rss) || rss <= 0
      || duration === undefined || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`missing or invalid RSS/seconds measurement: ${file}`);
    }
    if (rss > capacity) throw new Error(`test file exceeds shard memory budget: ${file}`);
  }
  const sorted = unique.sort((a, b) =>
    rssMb.get(b)! - rssMb.get(a)! || seconds.get(b)! - seconds.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  const shards: GateTestShard[] = [];
  for (const file of sorted) {
    const rss = rssMb.get(file)!;
    const duration = seconds.get(file)!;
    const eligible = shards.filter((shard) => shard.plannedRssMb + rss <= capacity)
      .sort((a, b) => a.plannedSeconds - b.plannedSeconds || a.plannedRssMb - b.plannedRssMb || a.id.localeCompare(b.id));
    let shard = eligible[0];
    if ((!shard || (shardCount !== Number.POSITIVE_INFINITY && shards.length < Math.min(shardCount, sorted.length))) && shards.length < shardCount) {
      shard = { id: `shard-${shards.length + 1}`, files: [], plannedRssMb: 0, plannedSeconds: 0 };
      shards.push(shard);
    }
    if (!shard) {
      const totalRssMb = sorted.reduce((sum, candidate) => sum + rssMb.get(candidate)!, 0);
      const largestRssMb = rssMb.get(sorted[0]!)!;
      throw new Error(`test files exceed ${shardCount} shard memory budgets (files=${unique.length} · totalRssMb=${Math.round(totalRssMb)} · largestRssMb=${Math.round(largestRssMb)} · budgetMb=${capacity} · neededShards≥${Math.ceil(totalRssMb / capacity)})`);
    }
    shard.files.push(file);
    shard.plannedRssMb += rss;
    shard.plannedSeconds += duration;
  }
  return shards;
}

/** OP FU (LAND-TRAIN-LIVE side) — opt-in `--fixed-shard-distribution`: no RSS/seconds measurement. Files are deduplicated,
 *  sorted by code point (input-order independent) and dealt round-robin into at most `shardCount` shards; real child/PTY
 *  tests keep their own lane exactly like the measured planner. Not a memory-safety guarantee — an over-budget shard
 *  surfaces as its own run result (signal/exit/incomplete JUnit ⇒ unmeasured), never as a pass. No empty shards. */
export function planFixedGateTestShards(files: readonly string[], shardCount: number): GateTestShard[] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error('invalid shard count');
  const sorted = [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const deal = (subset: readonly string[], count: number): string[][] => {
    const buckets: string[][] = Array.from({ length: Math.min(count, subset.length) }, () => []);
    subset.forEach((file, index) => buckets[index % buckets.length]!.push(file));
    return buckets;
  };
  const spawn = sorted.filter(isGateSpawnLaneFile);
  const regular = sorted.filter((file) => !isGateSpawnLaneFile(file));
  let groups: string[][];
  if (!spawn.length || !regular.length) groups = deal(sorted, shardCount);
  else {
    if (shardCount < 2) throw new Error('self gate spawn lane needs at least two shards when regular and spawn tests coexist');
    const spawnCount = Math.min(3, spawn.length, shardCount - 1);
    groups = [...deal(regular, shardCount - spawnCount), ...deal(spawn, spawnCount)];
  }
  return groups.map((group, index) => ({ id: `shard-${index + 1}`, files: group, plannedRssMb: 0, plannedSeconds: 0 }));
}
