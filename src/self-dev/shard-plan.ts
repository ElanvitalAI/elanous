export interface GateTestShard {
  id: string;
  files: string[];
  plannedRssMb: number;
  plannedSeconds: number;
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
    if (!shard) throw new Error(`test files exceed ${shardCount} shard memory budgets`);
    shard.files.push(file);
    shard.plannedRssMb += rss;
    shard.plannedSeconds += duration;
  }
  return shards;
}
