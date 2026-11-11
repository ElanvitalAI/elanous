/** S1 device: injects fake attempt outcomes at the existing task and gate launch boundaries. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapInventory, type MapCard, type MapInventory, type MapItem, type MapPorts } from '../task-agent/map-reduce.js';
import { reduceMapRun, type MapReduceAttemptReceipt, type MapReducePieceReceipt,
  type MapReducePolicy, type MapReduceReceipt, type MapRunRow } from '../task-agent/map-run-ledger.js';
import { gateShardRuntimeIdentityKey, planGateShardDispatch, reduceGateShardReceipts,
  type GateShardHost, type GateShardIdentity, type GateShardReceipt } from '../../scripts/release-loop/gate-shard-dispatch.js';

export interface MapReduceSimPiece extends MapItem { files: string[]; outcomes: readonly ('complete' | 'failed')[] }
export interface MapReduceSimInput {
  runId: string;
  head40: string;
  base40: string;
  seed: string;
  retryMax: number;
  costLimit: number;
  hosts: readonly string[];
  pieces: readonly MapReduceSimPiece[];
}
export interface MapReduceSimObservation {
  taskReceipt: ReturnType<typeof reduceMapRun>['receipt'];
  gateReceipt: MapReduceReceipt | undefined;
  gateActions: Array<{ pieceId: string; host: string | null; attempt: number | null; costLimit: number | null; kind: string }>;
  taskLaunches: Array<{ pieceId: string; host: string | null; attempt: number; costLimit: number | null }>;
}

function costFor(_piece: MapReduceSimPiece, _attempt: number): number { return 1; } // Source: SIM fixture charges one normalized cost unit per fake attempt (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function policy(input: MapReduceSimInput): MapReducePolicy {
  return { seed: input.seed, retryMax: input.retryMax, costLimit: input.costLimit };
}
function gateReceipt(input: MapReduceSimInput, shard: GateShardIdentity, host: string,
  attempts: readonly MapReduceAttemptReceipt[]): GateShardReceipt {
  const imageDigest = `sha256:${'a'.repeat(64)}`; // Source: SHA-256 digest shape required by GateShardReceipt (NUMGUARD)
  const runtimeIdentity = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64',
    envFingerprint: 'b'.repeat(64), baseImageDigest: `sha256:${'c'.repeat(64)}` }; // Source: runtime identity fingerprint shape required by GateShardReceipt (NUMGUARD)
  const lockfileHash = 'd'.repeat(64); // Source: lockfile hash uses SHA-256 shape required by GateShardReceipt (NUMGUARD)
  const final = attempts.at(-1)!;
  const failures = final.status === 'failed' ? [`${shard.files[0]} > scripted-attempt-failure`] : [];
  const piece: MapReducePieceReceipt = { pieceId: shard.id, host, status: final.status === 'complete' ? 'complete' : 'failed',
    reservedCost: (shard.estimatedCost ?? 0) * (input.retryMax + 1), attempts: [...attempts] };
  return { ...shard, version: '0.3.9', head40: input.head40, base40: input.base40,
    graphSha: 'e'.repeat(64), recipeSha: 'f'.repeat(64), graphEntry: 'sim-mapreduce-v1',
    recipeCommand: 'sim-mapreduce', recipeTimeoutMs: 1000, host, // Source: finite test-only recipe timeout satisfies receipt identity validation (NUMGUARD)
    envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!, envFingerprint: runtimeIdentity.envFingerprint,
    imageDigest, runtimeIdentity, lockfileHash,
    testedFileHashes: Object.fromEntries(shard.files.map((file) => [file, sha(file)])),
    executions: attempts.map((attempt) => ({ branch: '', attemptId: `${shard.id}-${attempt.attempt}`,
      host: attempt.host, imageDigest, runtimeIdentity })),
    mapReduceSeed: input.seed,
    status: 'complete', failureIds: failures, errorIds: [], evidencePath: `sim/${shard.id}-${final.attempt}.json`,
    evidenceSha256: sha(JSON.stringify({ shard: shard.id, attempts })), measuredAt: '2026-11-10T00:00:00.000Z',
    attempt: final.attempt, mapReducePiece: piece };
}

function gateHosts(ids: readonly string[]): GateShardHost[] {
  return ids.map((id) => ({ id, platform: 'linux', available: true, reserved: false }));
}

function buildTaskRow(card: MapCard, outcome: 'complete' | 'failed', cost: number): MapRunRow {
  return { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId, recipe: card.recipe,
    kind: outcome === 'complete' ? 'implementation-remains' : 'hold',
    verdict: outcome === 'complete' ? 'implementation-remains' : 'hold',
    reason: outcome === 'complete' ? 'sim-complete' : 'sim-attempt-failed',
    evidence: outcome === 'complete' ? ['sim-receipt'] : [], result: { cost } };
}

/** Runs the production planners and reducers; only host work is replaced with deterministic outcomes. */
export async function simMapReduceMultihost(input: MapReduceSimInput): Promise<MapReduceSimObservation> {
  if (!input.hosts.length || !input.pieces.length) throw new Error('SIM-MAPREDUCE needs hosts and pieces');
  const mapPolicy = policy(input);
  const shards = input.pieces.map(({ id, files, estimatedCost }) => ({ id, files: [...files], estimatedCost })) satisfies GateShardIdentity[];
  const planned = planGateShardDispatch({ head40: input.head40, base40: input.base40, shards, receipts: [],
    hosts: gateHosts(input.hosts), mapReducePolicy: mapPolicy });
  const gateActions: MapReduceSimObservation['gateActions'] = [];
  const gateAttempts = new Map<string, MapReduceAttemptReceipt[]>();
  const latestGateReceipts = new Map<string, GateShardReceipt>();
  const gatePieces = new Map<string, MapReducePieceReceipt>();
  const runAction = (shard: GateShardIdentity, host: string, attempt: number): void => {
    const history = gateAttempts.get(shard.id) ?? [];
    const outcome = input.pieces.find((piece) => piece.id === shard.id)?.outcomes[attempt - 1];
    if (!outcome) {
      const piece: MapReducePieceReceipt = { pieceId: shard.id, host, status: 'unmeasured',
        reservedCost: (shard.estimatedCost ?? 0) * (input.retryMax + 1), attempts: history };
      gatePieces.set(shard.id, piece);
      return;
    }
    history.push({ attempt, host, status: outcome, cost: costFor(input.pieces.find((piece) => piece.id === shard.id)!, attempt) });
    gateAttempts.set(shard.id, history);
    const receipt = gateReceipt(input, shard, host, history);
    latestGateReceipts.set(shard.id, receipt);
    gatePieces.set(shard.id, receipt.mapReducePiece!);
  };
  for (const action of planned) {
    gateActions.push({ pieceId: action.shardId, host: action.kind === 'run' ? action.host : null,
      attempt: action.kind === 'run' ? action.attempt ?? 1 : null,
      costLimit: action.kind === 'run' ? action.costLimit ?? null : null, kind: action.kind });
    if (action.kind === 'run') runAction(shards.find((shard) => shard.id === action.shardId)!, action.host, action.attempt ?? 1);
    else if (action.kind === 'unmeasured') gatePieces.set(action.shardId, {
      pieceId: action.shardId, host: null, status: action.reason === 'budget-exceeded' ? 'budget-exceeded' : 'unmeasured',
      reservedCost: 0, attempts: [],
    });
  }
  for (const shard of shards) {
    let attempts = gateAttempts.get(shard.id) ?? [];
    while (attempts.length && attempts.length < input.retryMax + 1 && attempts.at(-1)?.status === 'failed') {
      const prior = latestGateReceipts.get(shard.id)!;
      const retry = planGateShardDispatch({ head40: input.head40, base40: input.base40, shards: [shard],
        receipts: [prior], hosts: gateHosts(input.hosts), rerouteShard: shard.id, mapReducePolicy: mapPolicy });
      const action = retry[0]!;
      gateActions.push({ pieceId: shard.id, host: action.kind === 'run' ? action.host : null,
        attempt: action.kind === 'run' ? action.attempt ?? null : null,
        costLimit: action.kind === 'run' ? action.costLimit ?? null : null, kind: action.kind });
      if (action.kind !== 'run') {
        gatePieces.set(shard.id, { pieceId: shard.id, host: prior.host,
          status: action.reason === 'budget-exceeded' ? 'budget-exceeded' : 'unmeasured',
          reservedCost: (shard.estimatedCost ?? 0) * (input.retryMax + 1), attempts });
        break;
      }
      runAction(shard, action.host, action.attempt ?? attempts.length + 1);
      attempts = gateAttempts.get(shard.id) ?? attempts;
    }
  }
  const gateReduction = reduceGateShardReceipts({ head40: input.head40, base40: input.base40, shards,
    receipts: [...latestGateReceipts.values()], mapReducePolicy: mapPolicy,
    mapReducePieces: shards.map((shard) => gatePieces.get(shard.id)!).filter(Boolean) });

  const ledgerRoot = mkdtempSync(join(tmpdir(), 'sim-mapreduce-'));
  try {
    const taskLaunches: MapReduceSimObservation['taskLaunches'] = [];
    const inventory: MapInventory<MapReduceSimPiece> = { items: input.pieces, complete: true,
      snapshotTime: '2026-11-10T00:00:00.000Z', snapshotRef: `sim:${input.seed}`,
      recipeSha: input.head40, mainSha: input.base40, checklistSnapshotPath: '/tmp/sim-checklist.json',
      requestedPool: input.hosts[0]!, selectedPool: input.hosts[0]!, imageCommit: input.head40 };
    const result = await mapInventory({ recipe: 'green-close', source: 'landed-but-yellow', dryRun: false,
      root: ledgerRoot, mapRunId: input.runId, mapReduce: mapPolicy, hosts: input.hosts }, {
      inventory: async () => inventory,
      buildCard: (item, context) => ({ id: `card-${item.id}`, itemId: item.id, mapRunId: context.mapRunId,
        recipe: context.recipe, text: `simulate ${item.id}` }),
      launchCard: async (card, item, context) => {
        const host = context.host ?? '';
        const attempt = context.attempt ?? 1;
        taskLaunches.push({ pieceId: item.id, host, attempt, costLimit: context.costLimit ?? null });
        const outcome = item.outcomes[attempt - 1] ?? 'failed';
        return buildTaskRow(card, outcome, costFor(item, attempt));
      },
      log: () => undefined,
    });
    const taskReceipt = reduceMapRun(result.mapRunId, ledgerRoot).receipt;
    return { taskReceipt, gateReceipt: 'mapReduceReceipt' in gateReduction ? gateReduction.mapReduceReceipt : undefined,
      gateActions, taskLaunches };
  } finally {
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
}
