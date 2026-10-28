/** S1 device for a release gate's shard dispatch. It replaces host execution, not planning or reduction. */
import { createHash } from 'node:crypto';
import {
  planGateShardDispatch,
  reduceGateShardReceipts,
  type GateShardAction,
  type GateShardDispatchInput,
  type GateShardReceipt,
  type GateShardReduction,
} from '../../scripts/release-loop/gate-shard-dispatch.js';

export interface FakeGateShardHostResult {
  shardId: string;
  host: string;
  status: 'complete' | 'unmeasured';
  failureIds: string[];
  errorIds: string[];
  envKey?: string;
}

export interface GateShardRerouteScenario {
  input: GateShardDispatchInput;
  /** A result is supplied only for an expected host call. An omitted result remains unmeasured. */
  hostResults: readonly FakeGateShardHostResult[];
}

export interface FakeGateShardHostCall {
  shardId: string;
  host: string;
  files: string[];
  head40: string;
  base40: string;
}

export interface GateShardRerouteObservation {
  actions: GateShardAction[];
  hostCalls: FakeGateShardHostCall[];
  /** One selected receipt per reused or executed shard; no predecessor fills a failed remeasurement. */
  receipts: GateShardReceipt[];
  reduction: GateShardReduction;
}

/** Stage inputs without making dispatch decisions; the production planner receives them unchanged. */
export function gateShardRerouteScenario(
  input: GateShardDispatchInput,
  hostResults: readonly FakeGateShardHostResult[],
): GateShardRerouteScenario {
  return { input, hostResults };
}

/**
 * Inject deterministic fake host results into the production planner and reducer. This never starts a gate,
 * Pod, SSH command, or host sweep. The fake evidence digest is a scenario marker, not an artifact verification;
 * the caller of the production planner still owns verification before reuse.
 */
export function simGateShardHostReroute(scenario: GateShardRerouteScenario): GateShardRerouteObservation {
  const actions = planGateShardDispatch(scenario.input);
  const hostCalls: FakeGateShardHostCall[] = [];
  const receipts: GateShardReceipt[] = [];
  for (const action of actions) {
    if (action.kind === 'reuse') {
      receipts.push(action.receipt);
      continue;
    }
    if (action.kind === 'unmeasured') continue;
    hostCalls.push({ shardId: action.shardId, host: action.host, files: [...action.files],
      head40: scenario.input.head40, base40: scenario.input.base40 });
    const result = scenario.hostResults.find((row) => row.shardId === action.shardId && row.host === action.host);
    if (!result) continue;
    const evidence = JSON.stringify({ head40: scenario.input.head40, base40: scenario.input.base40,
      shardId: action.shardId, host: action.host, files: action.files, result });
    receipts.push({ id: action.shardId, files: [...action.files], head40: scenario.input.head40, base40: scenario.input.base40,
      host: action.host, envKey: result.envKey ?? `sim:${action.host}`, status: result.status,
      failureIds: [...result.failureIds], errorIds: [...result.errorIds],
      evidencePath: `sim/${action.shardId}-${action.host}.json`,
      evidenceSha256: createHash('sha256').update(evidence).digest('hex'),
      measuredAt: '2026-10-27T00:00:00.000Z', attempt: (action.replacing?.attempt ?? 0) + 1 });
  }
  const reduction = reduceGateShardReceipts({ head40: scenario.input.head40, base40: scenario.input.base40,
    shards: scenario.input.shards, receipts });
  return { actions, hostCalls, receipts, reduction };
}
