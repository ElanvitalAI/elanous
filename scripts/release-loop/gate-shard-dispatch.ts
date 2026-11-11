/** Pure, fail-closed planning for a release gate measured across hosts. No host command runs here. */
import { runtimeIdentityKey } from '../../src/runtime-identity.js';
import { mapReduceHostForPiece, reduceMapReduceReceipt, validMapReducePieceReceipt, validMapReducePolicy,
  type MapReducePieceReceipt, type MapReducePolicy } from '../../src/task-agent/map-run-ledger.js';

export function gateShardRuntimeIdentityKey(identity: { bunVersion: string; platform: string;
  architecture: string; baseImageDigest?: string } | null | undefined, lockHash: string | null | undefined): string | null {
  if (!identity) return null;
  return runtimeIdentityKey({ baseImageDigest: identity.baseImageDigest ?? '', lockHash: lockHash ?? '',
    os: identity.platform, architecture: identity.architecture, bunVersion: identity.bunVersion });
}

export interface GateShardIdentity {
  id: string;
  files: string[];
  /** Execution requirement, never a concrete host identity. */
  requiredOs?: 'darwin' | 'linux';
  /** Conservative cost reservation per attempt, in the caller's documented unit. */
  estimatedCost?: number;
}

export interface GateShardExecutionEvidence {
  branch: string;
  attemptId: string;
  host: string;
  imageDigest: string;
  runtimeIdentity: { bunVersion: string; platform: string; architecture: string; envFingerprint: string; baseImageDigest?: string };
}

export interface GateShardReceipt extends GateShardIdentity {
  version: string;
  /** Graph execution run that produced this formal measurement; moved-tip carry is scoped to this run. */
  graphRunId?: string;
  graphSha: string;
  recipeSha: string;
  /** Exact gate node entry and command at receipt time; per shard despite same graph node. */
  graphEntry?: string;
  recipeCommand?: string;
  recipeTimeoutMs?: number;
  head40: string;
  base40: string;
  host: string;
  envKey: string;
  /** Duplicated top-level environment fact for explicit fieldwise comparison. */
  envFingerprint?: string;
  /** Executed imageID digest (not a mutable image ref). */
  imageDigest?: string;
  /** Bun/platform/architecture fingerprint observed inside the executed Pod. */
  runtimeIdentity?: { bunVersion: string; platform: string; architecture: string; envFingerprint: string; baseImageDigest?: string };
  /** Source-derived runtime/dependency identity at the measured commit, carried with each shard receipt. */
  runtimeSourceFingerprint?: string;
  /** Named lockfile component of the runtime reuse tuple. */
  lockfileHash?: string;
  /** SHA-256 of the exact test-file blobs this shard actually measured. */
  testedFileHashes?: Record<string, string>;
  /** Every Pod attempt that contributed to this logical shard; summary identity is valid only when these agree. */
  executions?: GateShardExecutionEvidence[];
  /** Seed under which mapReducePiece was planned; required before policy-mode reuse. */
  mapReduceSeed?: string;
  status: 'complete' | 'unmeasured';
  /** A complete measurement can contain existing or introduced failures. */
  failureIds: string[];
  errorIds: string[];
  /** Relative path to the measurement artifact, checked by the caller before reuse. */
  evidencePath: string;
  evidenceSha256: string;
  /** Integrity checksum of the structured receipt record; never used as a reuse key. */
  recordSha256?: string;
  measuredAt: string;
  attempt: number;
  mapReducePiece?: MapReducePieceReceipt;
}

export interface GateShardHost {
  id: string;
  platform: 'darwin' | 'linux' | 'other';
  available: boolean;
  reserved: boolean;
}

export type GateProgressState = 'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'unmeasured';

/** A host group or planned Pod shard as seen by the release gate's live progress observer. */
export interface GateProgressGroup {
  id: string;
  state: GateProgressState;
  /** Original shard-board state before retry is normalized to running for summaries. */
  rawState?: string;
  /** Current Pod attempt identity; absent while a retry is being scheduled. */
  attemptId?: string;
  host?: string;
  /** Exact failure and error case count when shard output is complete; unknown otherwise. */
  failureCount?: number | null;
  startedAtMs?: number;
  endedAtMs?: number;
}

/** Deduplicate repeated observations while preserving raw retry and attempt transitions. */
export function gateProgressTransitionKey(group: GateProgressGroup): string {
  return JSON.stringify([group.rawState ?? group.state, group.attemptId ?? null, group.failureCount ?? null]);
}

export interface GateProgressSummary {
  executor: 'host' | 'pod';
  host: string | null;
  completed: number;
  total: number;
  failed: number;
  groups: Array<{ id: string; state: GateProgressState; host: string | null; elapsedMs: number | null }>;
}

/** Keep the progress event shape identical for serial host groups and parallel Pod shards. */
export function summarizeGateProgress(input: {
  executor: 'host' | 'pod';
  groups: readonly GateProgressGroup[];
  nowMs: number;
}): GateProgressSummary {
  const terminal = new Set<GateProgressState>(['done', 'failed', 'timeout', 'unmeasured']);
  const hosts = [...new Set(input.groups.flatMap((group) => group.host?.trim() ? [group.host.trim()] : []))].sort();
  return {
    executor: input.executor,
    host: hosts.length ? hosts.join(',') : null,
    completed: input.groups.filter((group) => terminal.has(group.state)).length,
    total: input.groups.length,
    failed: input.groups.filter((group) => group.state === 'failed' || group.state === 'timeout').length,
    groups: input.groups.map((group) => {
      const end = group.endedAtMs ?? input.nowMs;
      const elapsedMs = Number.isFinite(group.startedAtMs) && Number.isFinite(end)
        ? Math.max(0, end - group.startedAtMs!) : null;
      return { id: group.id, state: group.state, host: group.host?.trim() || null, elapsedMs };
    }),
  };
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
  /** Failures proven preexisting by the previous same-head verdict for this exact baseline. */
  sameHeadPreexistingFailureIds?: readonly string[];
  /** Shards whose test/import radius intersects the diff from each receipt baseline. */
  invalidatedShardIds?: readonly string[];
  /** Proof from changed-file/import-closure analysis that these moved-baseline shards are untouched. */
  radiusUnchangedShardIds?: readonly string[];
  graphEntry?: string;
  recipeCommand?: string;
  recipeTimeoutMs?: number;
  environmentIdentity?: { baseImageDigest?: string; imageDigest?: string; bunVersion: string; platform: string; architecture: string; envFingerprint: string };
  lockfileHash?: string;
  testedFileHashesByShard?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Shared MAPREDUCE-FANOUT policy. Omitted for legacy single-attempt gate runs. */
  mapReducePolicy?: MapReducePolicy;
}

/** Preserve the producer shard assignment while applying a changed-test import radius. Missing or incomplete inventory fails closed. */
export function planGateReceiptRadius(input: { receipts: readonly GateShardReceipt[]; tests: readonly string[];
  selectedFiles: readonly string[]; priorCommit: string }): { shards: GateShardIdentity[]; invalidatedShardIds: string[]; unchangedShardIds: string[] } | null {
  if (!input.receipts.length || !input.tests.length || !/^[a-f0-9]{40}$/i.test(input.priorCommit)) return null;
  const receipts = [...input.receipts].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  const measuredFiles = receipts.flatMap((receipt) => receipt.files);
  const measuredFileSet = new Set(measuredFiles);
  // A test-file append is monotonic: retain the complete prior inventory and put each new file
  // in its own new shard. Removed files, duplicate ownership, or gaps still invalidate the proof.
  if (receipts.some((receipt, index) => receipt.id !== `pod-${index}` || receipt.status !== 'complete' || receipt.head40 !== input.priorCommit || !receipt.files.length)
    || measuredFileSet.size !== measuredFiles.length
    || measuredFiles.some((file) => !input.tests.includes(file))
    || input.selectedFiles.some((file) => !input.tests.includes(file))) return null;
  const invalidatedShardIds: string[] = [];
  const unchangedShardIds: string[] = [];
  const shards = receipts.map((receipt) => {
    const changed = receipt.files.some((file) => input.selectedFiles.includes(file));
    (changed ? invalidatedShardIds : unchangedShardIds).push(receipt.id);
    return { id: receipt.id, files: [...receipt.files] };
  });
  const appendedFiles = input.tests.filter((file) => !measuredFileSet.has(file)).sort();
  for (const file of appendedFiles) {
    const id = `pod-${shards.length}`;
    shards.push({ id, files: [file] });
    invalidatedShardIds.push(id);
  }
  return { shards, invalidatedShardIds, unchangedShardIds };
}

export type GateShardAction =
  | { shardId: string; files: string[]; kind: 'reuse'; receipt: GateShardReceipt; reason: string }
  | { shardId: string; files: string[]; kind: 'run'; host: string; reason: string; attempt?: number; costLimit?: number; replacing?: GateShardReceipt }
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
      || (shard.requiredOs !== undefined && shard.requiredOs !== 'darwin' && shard.requiredOs !== 'linux')
      || (shard.estimatedCost !== undefined && (!Number.isFinite(shard.estimatedCost) || shard.estimatedCost < 0))) return false;
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
  allowMovedHead = false,
  allowSameHeadUnhashed = false,
): boolean {
  return receipt.status === 'complete' && /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(receipt.version)
      && typeof receipt.graphEntry === 'string' && receipt.graphEntry.trim().length > 0
      && typeof receipt.recipeCommand === 'string' && receipt.recipeCommand.trim().length > 0
      && Number.isSafeInteger(receipt.recipeTimeoutMs) && receipt.recipeTimeoutMs! > 0
      && /^[a-f0-9]{64}$/i.test(receipt.graphSha) && /^[a-f0-9]{64}$/i.test(receipt.recipeSha) && receipt.id === shard.id
      && /^[a-f0-9]{40}$/i.test(receipt.head40) && (receipt.head40 === head40 || allowMovedHead) && receipt.base40 === base40 && sameFiles(receipt.files, shard.files)
      && receipt.envKey.trim().length > 0 && receipt.host.trim().length > 0
      && typeof receipt.imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest)
      && !!receipt.runtimeIdentity && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(receipt.runtimeIdentity.bunVersion)
      && /^[a-z0-9_-]{1,32}$/.test(receipt.runtimeIdentity.platform) && /^[a-z0-9_-]{1,32}$/.test(receipt.runtimeIdentity.architecture)
      && /^[a-f0-9]{64}$/i.test(receipt.runtimeIdentity.envFingerprint)
      && typeof receipt.runtimeIdentity.baseImageDigest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(receipt.runtimeIdentity.baseImageDigest)
      && receipt.envFingerprint === receipt.runtimeIdentity.envFingerprint
      && receipt.envKey === gateShardRuntimeIdentityKey(receipt.runtimeIdentity, receipt.lockfileHash)
      && typeof receipt.lockfileHash === 'string' && /^[a-f0-9]{64}$/i.test(receipt.lockfileHash)
      && (validTestedFileHashesForFiles(receipt.testedFileHashes, receipt.files)
        || (allowSameHeadUnhashed && receipt.head40 === head40 && receipt.testedFileHashes === undefined))
      && Array.isArray(receipt.executions) && receipt.executions.length > 0
      && receipt.executions.every((execution) => typeof execution.branch === 'string'
        && typeof execution.attemptId === 'string' && execution.attemptId.trim().length > 0
        && typeof execution.host === 'string' && execution.host.trim().length > 0
        && execution.imageDigest === receipt.imageDigest
        && JSON.stringify(execution.runtimeIdentity) === JSON.stringify(receipt.runtimeIdentity))
      && receipt.evidencePath.trim().length > 0 && /^[a-f0-9]{64}$/i.test(receipt.evidenceSha256)
      && Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0
      && Array.isArray(receipt.failureIds) && receipt.failureIds.every((id) => typeof id === 'string')
      && Array.isArray(receipt.errorIds) && receipt.errorIds.every((id) => typeof id === 'string');
}

/** Reuse only exact complete measurements. A requested remeasure replaces one shard, not the whole sweep. */
export function planGateShardDispatch(input: GateShardDispatchInput): GateShardAction[] {
  if (!validGateShardIdentity(input.head40, input.base40, input.shards)) throw new Error('invalid gate shard identity');
  if (input.mapReducePolicy && !validMapReducePolicy(input.mapReducePolicy)) throw new Error('invalid shared map-reduce policy');
  if (input.rerouteShard && input.rerouteShard !== 'auto' && !input.shards.some((s) => s.id === input.rerouteShard))
    throw new Error(`unknown reroute shard: ${input.rerouteShard}`);
  if (input.shardHost && !input.hosts.some((host) => host.id === input.shardHost)) throw new Error(`unknown shard host: ${input.shardHost}`);
  const hosts = input.hosts.filter((host) => host.available && !host.reserved);
  const macPass = new Set(input.macPassShardIds ?? []);
  let nextHost = 0;
  let reservedCost = 0; // Source: budget accumulation starts with no reservations (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
  const radiusUnchanged = new Set(input.radiusUnchangedShardIds ?? []);
  const dispatchShards = input.mapReducePolicy
    ? [...input.shards].sort((left, right) => left.id.localeCompare(right.id))
    : input.shards;
  return dispatchShards.map((shard) => {
    const prior = [...input.receipts].reverse().find((r) => r.id === shard.id && r.base40 === input.base40 && sameFiles(r.files, shard.files));
    const currentFileHashes = input.testedFileHashesByShard?.[shard.id];
    const currentLockfileValid = typeof input.lockfileHash === 'string' && /^[a-f0-9]{64}$/i.test(input.lockfileHash);
    const currentFileHashesValid = validTestedFileHashesForFiles(currentFileHashes, shard.files);
    const envFields = ['baseImageDigest', 'bunVersion', 'platform', 'architecture'] as const;
    const storedEnv = prior?.runtimeIdentity && prior.imageDigest && prior.envFingerprint
      ? { ...prior.runtimeIdentity, envFingerprint: prior.envFingerprint } : undefined;
    const environmentMismatch = storedEnv && input.environmentIdentity
      ? envFields.find((field) => storedEnv[field] !== input.environmentIdentity![field])
      : (!input.environmentIdentity ? 'environment-unmeasured' as const : undefined);
    const recipeMismatch = prior && input.graphEntry && input.recipeCommand && Number.isSafeInteger(input.recipeTimeoutMs)
      ? (prior.graphEntry !== input.graphEntry ? 'graph-entry-mismatch' : prior.recipeCommand !== input.recipeCommand ? 'recipe-command-mismatch'
        : prior.recipeTimeoutMs !== input.recipeTimeoutMs ? 'recipe-timeout-mismatch' : undefined)
      : prior ? 'shard-recipe-unmeasured' : undefined;
    const receipt = [...input.receipts].reverse().find((r) => eligibleGateShardReceipt(r, shard, input.head40, input.base40,
      radiusUnchanged.has(shard.id), r.head40 === input.head40)
      && (!input.mapReducePolicy || r.mapReduceSeed === input.mapReducePolicy.seed
        && r.mapReducePiece?.pieceId === shard.id
        && validMapReducePieceReceipt(input.mapReducePolicy, r.mapReducePiece))
      && receiptFailureSetMatchesBaseline(r, shard, input.head40, input.sameHeadPreexistingFailureIds)
      && currentLockfileValid && r.lockfileHash === input.lockfileHash
      && currentFileHashesValid && sameTestedFileHashes(r.testedFileHashes, currentFileHashes)
      && !!input.graphEntry && !!input.recipeCommand && Number.isSafeInteger(input.recipeTimeoutMs)
      && r.graphEntry === input.graphEntry && r.recipeCommand === input.recipeCommand && r.recipeTimeoutMs === input.recipeTimeoutMs
      && !!input.environmentIdentity?.imageDigest && /^sha256:[a-f0-9]{64}$/i.test(input.environmentIdentity.imageDigest)
      && envFields.every((field) => ({ ...r.runtimeIdentity })[field] === input.environmentIdentity![field]));
    const failureBaselineMismatch = !!prior && [...prior.failureIds, ...prior.errorIds].length > 0
      && !receiptFailureSetMatchesBaseline(prior, shard, input.head40, input.sameHeadPreexistingFailureIds);
    const invalidated = new Set(input.invalidatedShardIds ?? []).has(shard.id);
    const forced = input.rerouteShard === shard.id || invalidated;
    const auto = input.rerouteShard === 'auto' && (prior?.status === 'unmeasured'
      || (macPass.has(shard.id) && !!prior && (prior.failureIds.length > 0 || prior.errorIds.length > 0)));
    const receiptHost = hosts.find((host) => host.id === receipt?.host);
    if (receipt && (receipt.head40 === input.head40 || radiusUnchanged.has(shard.id)) && !forced && !auto && !invalidated && (!shard.requiredOs || receiptHost?.platform === shard.requiredOs)) {
      if (input.mapReducePolicy && receipt.mapReducePiece) reservedCost += receipt.mapReducePiece.reservedCost;
      return { shardId: shard.id, files: [...shard.files], kind: 'reuse', receipt, reason: 'unchanged-radius-from-' + receipt.head40.slice(0, 12) };
    }
    const testedContentMismatch = input.testedFileHashesByShard !== undefined
      && !sameTestedFileHashes(prior?.testedFileHashes, input.testedFileHashesByShard[shard.id]);
    const lockfileMismatch = input.lockfileHash !== undefined && prior?.lockfileHash !== input.lockfileHash;
    const rerunReason = invalidated ? 'radius-invalidated' : !currentLockfileValid ? 'runtime-lockfile-unmeasured'
      : !currentFileHashesValid ? 'tested-file-identity-unmeasured' : testedContentMismatch ? 'tested-file-content-mismatch'
      : failureBaselineMismatch ? 'baseline-failure-identity-mismatch'
        : lockfileMismatch ? 'runtime-lockfile-mismatch' : (prior && prior.head40 !== input.head40 && !radiusUnchanged.has(shard.id)) ? 'radius-proof-missing' : environmentMismatch ? 'environment-' + environmentMismatch + '-mismatch'
      : recipeMismatch ?? (forced ? 'reroute-requested' : receipt ? 'receipt-ineligible' : 'receipt-unavailable');
    let candidates = hosts.filter((host) => !shard.requiredOs || host.platform === shard.requiredOs);
    if (input.shardHost && (forced || auto)) candidates = candidates.filter((host) => host.id === input.shardHost);
    else if (auto && macPass.has(shard.id)) candidates = candidates.filter((host) => host.platform === 'darwin');
    if ((forced || auto) && prior && candidates.some((host) => host.id !== prior.host)) candidates = candidates.filter((host) => host.id !== prior.host);
    if (!candidates.length) return { shardId: shard.id, files: [...shard.files], kind: 'unmeasured', reason: 'no eligible host' };
    const previousAttempts = input.mapReducePolicy
      ? prior?.mapReduceSeed === input.mapReducePolicy.seed ? prior?.mapReducePiece?.attempts.length ?? 0 : 0
      : prior?.attempt ?? 0;
    const attempt = previousAttempts + 1; // Source: gate attempt receipts are one-based (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    if (input.mapReducePolicy && prior && attempt > input.mapReducePolicy.retryMax + 1) // Source: one initial dispatch plus retry.max retries (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
      return { shardId: shard.id, files: [...shard.files], kind: 'unmeasured', reason: 'retry-limit-exceeded' };
    const cost = shard.estimatedCost;
    if (input.mapReducePolicy && (!Number.isFinite(cost) || cost! < 0))
      return { shardId: shard.id, files: [...shard.files], kind: 'unmeasured', reason: 'cost-estimate-unmeasured' };
    const reservation = input.mapReducePolicy ? cost! * (input.mapReducePolicy.retryMax + 1) : 0; // Source: reserve one estimate for the initial attempt plus retry.max (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    if (input.mapReducePolicy && reservedCost + reservation > input.mapReducePolicy.costLimit)
      return { shardId: shard.id, files: [...shard.files], kind: 'unmeasured', reason: 'budget-exceeded' };
    reservedCost += reservation;
    const host = input.mapReducePolicy
      ? mapReduceHostForPiece(input.mapReducePolicy.seed, shard.id, attempt, candidates.map((candidate) => candidate.id))
      : candidates[nextHost++ % candidates.length]?.id;
    if (!host) return { shardId: shard.id, files: [...shard.files], kind: 'unmeasured', reason: 'no eligible host' };
    return { shardId: shard.id, files: [...shard.files], kind: 'run', host, reason: rerunReason,
      ...(input.mapReducePolicy ? { attempt, costLimit: cost } : {}), ...(prior ? { replacing: prior } : {}) };
  });
}

function receiptFailureSetMatchesBaseline(receipt: GateShardReceipt, shard: GateShardIdentity, head40: string,
  sameHeadPreexistingFailureIds: readonly string[] | undefined): boolean {
  const receiptIds = [...new Set([...receipt.failureIds, ...receipt.errorIds])].sort();
  if (!receiptIds.length) return true;
  if (receipt.head40 !== head40 || !Array.isArray(sameHeadPreexistingFailureIds)
    || !sameHeadPreexistingFailureIds.every((id) => typeof id === 'string')) return false;
  const files = new Set(shard.files);
  const baselineIds = [...new Set(sameHeadPreexistingFailureIds)].filter((id) => {
    const separator = id.indexOf(' > ');
    return separator > 0 && files.has(id.slice(0, separator));
  }).sort();
  return baselineIds.length > 0 && JSON.stringify(receiptIds) === JSON.stringify(baselineIds);
}

function sameTestedFileHashes(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
  if (!a || !b) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return JSON.stringify(ak) === JSON.stringify(bk) && ak.every((file) => /^[a-f0-9]{64}$/i.test(a[file] ?? '') && a[file] === b[file]);
}

function validTestedFileHashesForFiles(hashes: Readonly<Record<string, string>> | undefined, files: readonly string[]): boolean {
  if (!hashes) return false;
  const keys = Object.keys(hashes).sort();
  return JSON.stringify(keys) === JSON.stringify([...files].sort())
    && Object.values(hashes).every((hash) => /^[a-f0-9]{64}$/i.test(hash));
}

export type GateShardReduction =
  | { status: 'complete'; failureIds: string[]; errorIds: string[]; receipts: GateShardReceipt[]; mapReduceReceipt?: ReturnType<typeof reduceMapReduceReceipt> }
  | { status: 'unmeasured'; reason: string; mapReduceReceipt?: ReturnType<typeof reduceMapReduceReceipt> };

/** Require exactly one exact, complete receipt per expected shard; classification remains with judgeGate. */
export function reduceGateShardReceipts(input: { head40: string; base40: string; shards: readonly GateShardIdentity[]; receipts: readonly GateShardReceipt[]; mapReducePolicy?: MapReducePolicy; mapReducePieces?: readonly MapReducePieceReceipt[] }): GateShardReduction {
  if (!validGateShardIdentity(input.head40, input.base40, input.shards)) return { status: 'unmeasured', reason: 'invalid gate shard identity' };
  const selected: GateShardReceipt[] = [];
  for (const shard of input.shards) {
    const matched = input.receipts.filter((r) => eligibleGateShardReceipt(r, shard, input.head40, input.base40));
    if (matched.length !== 1) {
      const mapReduceReceipt = input.mapReducePolicy && input.mapReducePieces
        ? reduceMapReduceReceipt(input.mapReducePolicy, input.shards.map((candidate) => candidate.id), input.mapReducePieces)
        : undefined;
      return { status: 'unmeasured', reason: `${shard.id}: expected one complete receipt, found ${matched.length}`,
        ...(mapReduceReceipt ? { mapReduceReceipt } : {}) };
    }
    selected.push(matched[0]!);
  }
  const mapReduceReceipt = input.mapReducePolicy
    ? reduceMapReduceReceipt(input.mapReducePolicy, input.shards.map((shard) => shard.id),
      input.mapReducePieces ? [...input.mapReducePieces] : selected.flatMap((receipt, index) => receipt.mapReducePiece
        ? [receipt.mapReducePiece]
        : [{ pieceId: input.shards[index]!.id, host: null, status: 'unmeasured' as const,
          reservedCost: 0, // Source: missing execution evidence carries no measured reservation (NUMGUARD)
          attempts: [] }]))
    : undefined;
  return { status: 'complete', receipts: selected,
    failureIds: [...new Set(selected.flatMap((r) => r.failureIds))].sort(),
    errorIds: [...new Set(selected.flatMap((r) => r.errorIds))].sort(),
    ...(mapReduceReceipt ? { mapReduceReceipt } : {}) };
}
