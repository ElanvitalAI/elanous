/** Pure, fail-closed planning for a release gate measured across hosts. No host command runs here. */
export interface GateShardIdentity {
  id: string;
  files: string[];
  /** Execution requirement, never a concrete host identity. */
  requiredOs?: 'darwin' | 'linux';
}

export interface GateShardReceipt extends GateShardIdentity {
  head40: string;
  base40: string;
  host: string;
  envKey: string;
  status: 'complete' | 'unmeasured';
  /** A complete measurement can contain existing or introduced failures. */
  failureIds: string[];
  errorIds: string[];
  /** Relative path to the measurement artifact, checked by the caller before reuse. */
  evidencePath: string;
  evidenceSha256: string;
  measuredAt: string;
  attempt: number;
}

export interface GateShardHost {
  id: string;
  platform: 'darwin' | 'linux' | 'other';
  available: boolean;
  reserved: boolean;
}

export interface GateShardDispatchInput {
  head40: string;
  base40: string;
  shards: readonly GateShardIdentity[];
  receipts: readonly GateShardReceipt[];
  hosts: readonly GateShardHost[];
  rerouteShard?: string | 'auto';
  shardHost?: string;
  /** IDs known to pass on macOS, supplied by the caller's env-known policy. */
  macPassShardIds?: readonly string[];
}

export type GateShardAction =
  | { shardId: string; files: string[]; kind: 'reuse'; receipt: GateShardReceipt }
  | { shardId: string; files: string[]; kind: 'run'; host: string; replacing?: GateShardReceipt }
  | { shardId: string; files: string[]; kind: 'unmeasured'; reason: string };

const SHA40 = /^[a-f0-9]{40}$/i;
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const sameFiles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((file, i) => file === b[i]);

export function validGateShardIdentity(head40: string, base40: string, shards: readonly GateShardIdentity[]): boolean {
  if (!SHA40.test(head40) || !SHA40.test(base40) || shards.length === 0) return false;
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const shard of shards) {
    if (!safeId(shard.id) || ids.has(shard.id) || shard.files.length === 0
      || (shard.requiredOs !== undefined && shard.requiredOs !== 'darwin' && shard.requiredOs !== 'linux')) return false;
    ids.add(shard.id);
    for (const file of shard.files) {
      if (!/^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file) || file.split('/').includes('..') || files.has(file)) return false;
      files.add(file);
    }
  }
  return true;
}

export function eligibleGateShardReceipt(
  receipt: GateShardReceipt,
  shard: GateShardIdentity,
  head40: string,
  base40: string,
): boolean {
  return receipt.status === 'complete' && receipt.id === shard.id
      && receipt.head40 === head40 && receipt.base40 === base40 && sameFiles(receipt.files, shard.files)
      && receipt.envKey.trim().length > 0 && receipt.host.trim().length > 0
      && receipt.evidencePath.trim().length > 0 && /^[a-f0-9]{64}$/i.test(receipt.evidenceSha256)
      && Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0
      && Array.isArray(receipt.failureIds) && receipt.failureIds.every((id) => typeof id === 'string')
      && Array.isArray(receipt.errorIds) && receipt.errorIds.every((id) => typeof id === 'string');
}

/** Reuse only exact complete measurements. A requested remeasure replaces one shard, not the whole sweep. */
export function planGateShardDispatch(input: GateShardDispatchInput): GateShardAction[] {
  if (!validGateShardIdentity(input.head40, input.base40, input.shards)) throw new Error('invalid gate shard identity');
  if (input.rerouteShard && input.rerouteShard !== 'auto' && !input.shards.some((s) => s.id === input.rerouteShard))
    throw new Error(`unknown reroute shard: ${input.rerouteShard}`);
  if (input.shardHost && !input.hosts.some((host) => host.id === input.shardHost)) throw new Error(`unknown shard host: ${input.shardHost}`);
  const hosts = input.hosts.filter((host) => host.available && !host.reserved);
  const macPass = new Set(input.macPassShardIds ?? []);
  let nextHost = 0;
  return input.shards.map((shard) => {
    const receipt = [...input.receipts].reverse().find((r) => eligibleGateShardReceipt(r, shard, input.head40, input.base40));
    const prior = [...input.receipts].reverse().find((r) => r.id === shard.id && r.head40 === input.head40 && r.base40 === input.base40 && sameFiles(r.files, shard.files));
    const forced = input.rerouteShard === shard.id;
    const auto = input.rerouteShard === 'auto' && (prior?.status === 'unmeasured'
      || (macPass.has(shard.id) && !!prior && (prior.failureIds.length > 0 || prior.errorIds.length > 0)));
    const receiptHost = hosts.find((host) => host.id === receipt?.host);
    if (receipt && !forced && !auto && (!shard.requiredOs || receiptHost?.platform === shard.requiredOs))
      return { shardId: shard.id, files: [...shard.files], kind: 'reuse', receipt };
    let candidates = hosts.filter((host) => !shard.requiredOs || host.platform === shard.requiredOs);
    if (input.shardHost && (forced || auto)) candidates = candidates.filter((host) => host.id === input.shardHost);
    else if (auto && macPass.has(shard.id)) candidates = candidates.filter((host) => host.platform === 'darwin');
    if ((forced || auto) && prior && candidates.some((host) => host.id !== prior.host)) candidates = candidates.filter((host) => host.id !== prior.host);
    if (!candidates.length) return { shardId: shard.id, files: [...shard.files], kind: 'unmeasured', reason: 'no eligible host' };
    const host = candidates[nextHost++ % candidates.length]!;
    return { shardId: shard.id, files: [...shard.files], kind: 'run', host: host.id, ...(prior ? { replacing: prior } : {}) };
  });
}

export type GateShardReduction =
  | { status: 'complete'; failureIds: string[]; errorIds: string[]; receipts: GateShardReceipt[] }
  | { status: 'unmeasured'; reason: string };

/** Require exactly one exact, complete receipt per expected shard; classification remains with judgeGate. */
export function reduceGateShardReceipts(input: { head40: string; base40: string; shards: readonly GateShardIdentity[]; receipts: readonly GateShardReceipt[] }): GateShardReduction {
  if (!validGateShardIdentity(input.head40, input.base40, input.shards)) return { status: 'unmeasured', reason: 'invalid gate shard identity' };
  const selected: GateShardReceipt[] = [];
  for (const shard of input.shards) {
    const matched = input.receipts.filter((r) => eligibleGateShardReceipt(r, shard, input.head40, input.base40));
    if (matched.length !== 1) return { status: 'unmeasured', reason: `${shard.id}: expected one complete receipt, found ${matched.length}` };
    selected.push(matched[0]!);
  }
  return { status: 'complete', receipts: selected,
    failureIds: [...new Set(selected.flatMap((r) => r.failureIds))].sort(),
    errorIds: [...new Set(selected.flatMap((r) => r.errorIds))].sort() };
}
