interface StickyGatePool { id?: string | null; available: boolean; imageDigest: string | null }
interface StickyGateShard { id?: string | null; files?: string[] | null }
interface StickyGateReceipt { shardId: string; status: 'complete' | 'stalled'; pool?: string | null; imageDigest: string }
interface StickyGateShardAction {
  shardId: string; files: string[]; kind: 'reuse' | 'run' | 'unmeasured'; pool?: string; imageDigest?: string;
}
interface StickyGatePlan {
  mode: 'full' | 'partial' | 'HOLD'; pinnedDigest: string | null; excludedPools: string[];
  shards: StickyGateShardAction[]; reason?: string;
}
interface StickyGatePlanInput {
  phase: 'start' | 'resume'; pools: readonly StickyGatePool[]; shards: readonly StickyGateShard[];
  pinnedDigest?: string | null; receipts?: readonly StickyGateReceipt[];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/i;
const validDigest = (value: string | null | undefined): value is string => typeof value === 'string' && DIGEST.test(value);
const normalizeDigest = (value: string | null | undefined): string | null => validDigest(value) ? value.toLowerCase() : null;
const validPoolIdentity = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim().length > 0;

function hold(input: StickyGatePlanInput, pinnedDigest: string | null, reason: string, excludedPools: string[] = []): StickyGatePlan {
  return { mode: 'HOLD', pinnedDigest, excludedPools, reason,
    shards: input.shards.map((shard, index) => ({
      shardId: validPoolIdentity(shard?.id) ? shard.id : `unmeasured-${index}`,
      files: Array.isArray(shard?.files) ? [...shard.files] : [], kind: 'unmeasured',
    })) };
}

function isValidPool(pool: StickyGatePool | null | undefined): pool is StickyGatePool & { id: string } {
  return !!pool && validPoolIdentity(pool.id);
}

function isValidShard(shard: StickyGateShard | null | undefined): shard is StickyGateShard & { id: string; files: string[] } {
  return !!shard && validPoolIdentity(shard.id) && Array.isArray(shard.files) && shard.files.length > 0
    && shard.files.every((file) => typeof file === 'string') && new Set(shard.files).size === shard.files.length;
}

/**
 * Deterministic E4 planning simulation. A production caller must persist the chosen digest at run start
 * and pass it unchanged on resume; this module itself never runs a host command or pulls an image.
 */
export function planStickyGateImages(input: StickyGatePlanInput): StickyGatePlan {
  if (!input.shards.length || !input.pools.length) return hold(input, null, 'empty pool or shard inventory');
  const pools = input.pools.filter(isValidPool);
  const validShards = input.shards.filter(isValidShard);
  if (pools.length !== input.pools.length || new Set(pools.map((pool) => pool.id)).size !== pools.length
    || validShards.length !== input.shards.length || new Set(validShards.map((shard) => shard.id)).size !== validShards.length)
    return hold(input, null, 'invalid pool or shard identity');

  let pinnedDigest: string | null = null;
  if (input.phase === 'resume') {
    pinnedDigest = normalizeDigest(input.pinnedDigest);
    if (!pinnedDigest) return hold(input, null, 'run image digest missing');
  } else if (input.pinnedDigest !== undefined && input.pinnedDigest !== null) {
    pinnedDigest = normalizeDigest(input.pinnedDigest);
    if (!pinnedDigest) return hold(input, null, 'invalid pinned image digest');
  } else {
    pinnedDigest = pools.map((pool) => pool.available ? normalizeDigest(pool.imageDigest) : null)
      .find((digest): digest is string => digest !== null) ?? null;
    if (!pinnedDigest) return hold(input, null, 'no available pool has a valid image digest');
  }

  const excludedPools = pools.filter((pool) => !pool.available || normalizeDigest(pool.imageDigest) !== pinnedDigest)
    .map((pool) => pool.id);
  const eligiblePools = pools.filter((pool) => pool.available && normalizeDigest(pool.imageDigest) === pinnedDigest);
  if (!eligiblePools.length) return hold(input, pinnedDigest, 'no available pool has the pinned digest', excludedPools);

  const receipts = input.receipts ?? [];
  const shardIds = new Set(validShards.map((shard) => shard.id));
  if (receipts.some((receipt) => !shardIds.has(receipt.shardId))
    || new Set(receipts.map((receipt) => receipt.shardId)).size !== receipts.length)
    return hold(input, pinnedDigest, 'receipt inventory does not match the shard plan', excludedPools);

  const receiptByShard = new Map(receipts.map((receipt) => [receipt.shardId, receipt]));
  const completedReceipts = input.phase === 'resume' ? receipts.filter((receipt) => receipt.status === 'complete') : [];
  const mismatchedCompleteDigest = completedReceipts.some((receipt) => normalizeDigest(receipt.imageDigest) !== pinnedDigest);
  const missingCompletePool = completedReceipts.some((receipt) => !validPoolIdentity(receipt.pool));
  const mixedCompleteReceipt = mismatchedCompleteDigest || missingCompletePool;
  const fullSweep = input.phase === 'start' || mixedCompleteReceipt
    || !validShards.some((shard) => receiptByShard.get(shard.id)?.status === 'complete');
  const mode: StickyGatePlan['mode'] = fullSweep ? 'full' : 'partial';
  const shards: StickyGateShardAction[] = [];
  let nextPool = 0;
  for (const shard of validShards) {
    const receipt = receiptByShard.get(shard.id);
    const canReuse = input.phase === 'resume' && !fullSweep && receipt?.status === 'complete'
      && normalizeDigest(receipt.imageDigest) === pinnedDigest && validPoolIdentity(receipt.pool);
    if (canReuse) {
      shards.push({ shardId: shard.id, files: [...shard.files], kind: 'reuse', pool: receipt.pool ?? undefined, imageDigest: pinnedDigest });
      continue;
    }
    const pool = eligiblePools[nextPool++ % eligiblePools.length]!;
    shards.push({ shardId: shard.id, files: [...shard.files], kind: 'run', pool: pool.id, imageDigest: pinnedDigest });
  }

  return { mode, pinnedDigest, excludedPools, shards,
    ...(mixedCompleteReceipt ? { reason: mismatchedCompleteDigest
      ? 'completed receipts contain a different image digest' : 'completed receipt is missing pool identity' } : {}) };
}
