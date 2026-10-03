import type { PoolLeaseMeasure } from '../task-orchestrator/surfaces/pod-lease.js';
import type { GateTestShard } from './shard-plan.js';

export interface ShardPlacement {
  shardId: string;
  context: string;
}

/** Assign only to measurable, ready Pod lease members. No remote work is performed here. */
export function assignGateShardsToPool(
  shards: readonly GateTestShard[],
  pool: PoolLeaseMeasure,
  previous: readonly ShardPlacement[] = [],
  failedContext?: string,
): ShardPlacement[] {
  const ids = new Set(shards.map((shard) => shard.id));
  if (ids.size !== shards.length) throw new Error('duplicate shard id');
  if (shards.some((shard) => !Number.isFinite(shard.plannedRssMb) || shard.plannedRssMb <= 0)) throw new Error('invalid shard RSS');
  const reservationBytes = (shard: GateTestShard) => Math.max(4, Math.ceil(shard.plannedRssMb / 1024)) * 1024 ** 3;
  if (previous.some((placement) => !ids.has(placement.shardId))) throw new Error('unknown shard placement');
  const retained = previous.filter((placement) => placement.context !== failedContext);
  if (new Set(previous.map((placement) => placement.shardId)).size !== previous.length) throw new Error('duplicate shard placement');
  const members = pool.members.filter((member) => member.context !== failedContext && member.reason === null
    && member.running !== null && member.pending !== null && member.availableMemoryByNodeBytes !== null
    && Number.isSafeInteger(member.capacity) && member.capacity > 0
    && member.availableMemoryByNodeBytes.every((bytes) => Number.isFinite(bytes) && bytes >= 0));
  if (new Set(members.map((member) => member.context)).size !== members.length) throw new Error('duplicate pool context');
  const state = members.map((member) => ({
    context: member.context,
    slots: Math.max(0, member.capacity - member.running! - member.pending!),
    nodes: [...member.availableMemoryByNodeBytes!],
    weight: member.availableMemoryByNodeBytes!.reduce((sum, bytes) => sum + Math.max(0, bytes), 0),
    assigned: 0,
  }));
  for (const placement of retained) {
    const member = state.find((entry) => entry.context === placement.context);
    const shard = shards.find((entry) => entry.id === placement.shardId)!;
    if (!member) throw new Error(`placed shard has no healthy pool member: ${placement.shardId}`);
    const node = member.nodes.findIndex((bytes) => bytes >= reservationBytes(shard));
    if (node < 0 || member.slots < 1) throw new Error(`placed shard exceeds pool lease: ${placement.shardId}`);
    member.nodes[node]! -= reservationBytes(shard);
    member.slots--;
    member.assigned++;
  }
  const assigned = new Map(retained.map((placement) => [placement.shardId, placement.context]));
  for (const shard of shards) {
    if (assigned.has(shard.id)) continue;
    const bytes = reservationBytes(shard);
    const eligible = state.filter((member) => member.slots > 0 && member.nodes.some((free) => free >= bytes))
      .sort((a, b) => a.assigned / a.weight - b.assigned / b.weight || b.weight - a.weight || a.context.localeCompare(b.context));
    const member = eligible[0];
    if (!member) throw new Error(`no pool lease memory for shard: ${shard.id}`);
    const node = member.nodes.findIndex((free) => free >= bytes);
    member.nodes[node]! -= bytes;
    member.slots--;
    member.assigned++;
    assigned.set(shard.id, member.context);
  }
  return shards.map((shard) => ({ shardId: shard.id, context: assigned.get(shard.id)! }));
}
