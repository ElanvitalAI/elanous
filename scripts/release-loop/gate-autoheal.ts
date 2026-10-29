import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLockSync } from '../../src/storage/file-lock.js';

/** Deterministic recovery policy for release gate incidents. Side effects are supplied by callers. */
export type GateAutohealCause = 'shard-pod-death' | 'timeout' | 'host-down' | 'interference' | 'true-regression' | 'environment';
export type GateAutohealAction = 'reroute-shard' | 'retry-shard' | 'partial-resume' | 'host-switch' | 'hitl';

export interface GateAutohealInput {
  cause: GateAutohealCause;
  signature: string;
  shardElapsedMs: number;
  overallElapsedMs: number;
  priorSameSignatureCount?: number;
  shardKeys?: readonly string[];
}

export interface GateAutohealDecision {
  action: GateAutohealAction;
  cause: GateAutohealCause;
  signature: string;
  reason: string;
  shardElapsedMs: number;
  overallElapsedMs: number;
  shardKey?: string;
}

export interface GateResultForAutoheal {
  outcome: 'ok' | 'regression' | 'error';
  introduced?: readonly string[];
  error?: string;
  durationMs: number;
  stalledShards?: readonly { shard: number; files: readonly string[]; reason: string; detail?: string; stall?: { sinceCheckoutMs: number } }[];
  interferenceErrors?: readonly string[];
  loadFlaky?: readonly string[];
}

interface GateAutohealLedger {
  schema: 1;
  overallElapsedMs: number;
  shards: Record<string, number>;
  signatures: Record<string, number>;
}

const emptyLedger = (): GateAutohealLedger => ({ schema: 1, overallElapsedMs: 0, shards: {}, signatures: {} });

/** Persist the incident budget across graph-node process restarts, keyed by release version and run id. */
export function decideAndRecordGateAutoheal(input: GateAutohealInput & { version: string; runId: string; shardKey: string; storeRoot: string }): GateAutohealDecision {
  const path = join(input.storeRoot, 'release', input.version, 'gate-autoheal', `${input.runId.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const unlock = acquireLockSync(`${path}.lock`, { breakDeadHolder: true });
  try {
    let ledger = emptyLedger();
    if (existsSync(path)) {
      try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as GateAutohealLedger;
      if (parsed.schema !== 1 || !Number.isFinite(parsed.overallElapsedMs) || !parsed.shards || !parsed.signatures) throw new Error('invalid ledger');
      ledger = parsed;
      } catch {
        return { action: 'hitl', cause: input.cause, signature: input.signature, reason: 'autoheal history unreadable; refusing another automatic action', shardElapsedMs: 0, overallElapsedMs: 0, shardKey: input.shardKey };
      }
    }
    const shardKeys = [...new Set(input.shardKeys?.length ? input.shardKeys : [input.shardKey])];
    const signatureKey = `${input.shardKey}:${input.signature}`;
    const priorSameSignatureCount = ledger.signatures[signatureKey] ?? 0;
    const elapsed = Math.max(0, input.shardElapsedMs);
    const shards = { ...ledger.shards };
    for (const key of shardKeys) shards[key] = (shards[key] ?? 0) + elapsed;
    const shardElapsedMs = Math.max(0, ...shardKeys.map((key) => shards[key] ?? 0));
    const overallElapsedMs = ledger.overallElapsedMs + Math.max(0, input.overallElapsedMs);
    const decision = decideGateAutoheal({ ...input, shardElapsedMs, overallElapsedMs, priorSameSignatureCount });
    ledger = { schema: 1, overallElapsedMs, shards,
      signatures: { ...ledger.signatures, [signatureKey]: priorSameSignatureCount + 1 } };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return { ...decision, shardKey: input.shardKey };
  } finally { unlock(); }
}

export const GATE_AUTOHEAL_SHARD_CAP_MS = 60 * 60 * 1000;
export const GATE_AUTOHEAL_OVERALL_CAP_MS = 90 * 60 * 1000;

/** One signature may be acted on once; seeing it again, or crossing either timebox, stops in HITL. */
export function decideGateAutoheal(input: GateAutohealInput): GateAutohealDecision {
  const shardElapsedMs = Math.max(0, input.shardElapsedMs);
  const overallElapsedMs = Math.max(0, input.overallElapsedMs);
  let action: GateAutohealAction;
  let reason: string;
  if (shardElapsedMs >= GATE_AUTOHEAL_SHARD_CAP_MS) {
    action = 'hitl'; reason = 'per-shard timebox exceeded';
  } else if (overallElapsedMs >= GATE_AUTOHEAL_OVERALL_CAP_MS) {
    action = 'hitl'; reason = 'overall timebox exceeded';
  } else if ((input.priorSameSignatureCount ?? 0) >= 1) {
    action = 'hitl'; reason = 'same incident signature repeated';
  } else {
    switch (input.cause) {
      case 'shard-pod-death': action = 'reroute-shard'; reason = 'replace failed shard Pod'; break;
      case 'timeout': action = 'retry-shard'; reason = 'retry the timed-out shard within its budget'; break;
      case 'host-down': action = 'host-switch'; reason = 'move the gate to a healthy host'; break;
      case 'interference': action = 'partial-resume'; reason = 'resume only the unmeasured or affected work'; break;
      case 'true-regression': action = 'hitl'; reason = 'measured regression requires a human decision'; break;
      case 'environment': action = 'hitl'; reason = 'environment cause is not safe to repair automatically'; break;
    }
  }
  return { action, cause: input.cause, signature: input.signature, reason, shardElapsedMs, overallElapsedMs };
}

export function gateAutohealCause(result: GateResultForAutoheal): GateAutohealCause | undefined {
  if (result.outcome === 'ok') return undefined;
  if (result.outcome === 'regression' && (result.introduced?.length ?? 0) > 0) return 'true-regression';
  if (/host.*(?:down|unreachable)|(?:down|unreachable).*host|ssh.*(?:failed|timeout)/i.test(result.error ?? '')) return 'host-down';
  if (result.stalledShards?.some((shard) => /timeout/.test(shard.reason))) return 'timeout';
  if ((result.interferenceErrors?.length ?? 0) > 0 || (result.loadFlaky?.length ?? 0) > 0) return 'interference';
  if (result.stalledShards?.some((shard) => /pod.*(?:deleted|evicted|terminated|lost|not found)|(?:pod-dead|pod-evicted|pod-deleted)/i.test(`${shard.reason} ${shard.detail ?? ''}`))) return 'shard-pod-death';
  return 'environment';
}
