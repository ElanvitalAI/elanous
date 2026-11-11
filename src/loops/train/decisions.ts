import { decideTrainVerdict, type TrainVerdictInput } from '../../../scripts/release-loop/train-verdict.js';
import { orderHotspotPrsByRadius } from './hotspot-radius-ordering.js';

export type TrainGateState = 'passed' | 'unmeasured' | 'conflict' | 'failed' | 'evidence';

export interface TrainQueueEntry {
  pr: string;
  head: string;
  state: 'open' | 'closed' | 'merged';
  gate: TrainGateState;
  expressRank?: number;
  mustRank?: number;
  /** A singleton candidate, including a PR that still needs its solo gate. */
  solo?: boolean;
  files?: readonly string[];
  radius?: number;
  priority?: 'S1' | 'normal';
}

export interface TrainRefusal {
  pr: string;
  head: string;
  base: string;
  runId: string;
  at: string;
  kind: 'batch-refusal' | 'infrastructure' | 'singleton-policy';
}

export interface TrainParkRecord {
  pr: string;
  head: string;
  at: string;
}

export interface TrainWorkerSlot {
  host: string;
  slot: number;
  expressOnly: boolean;
}

export interface TrainDecisionInput {
  base: string;
  queue: readonly TrainQueueEntry[];
  activePrs: readonly string[];
  refusals: readonly TrainRefusal[];
  /** Latest park rows for each PR/head; refusal events at or before these were adjudicated. */
  lastParks: readonly TrainParkRecord[];
  slots: readonly TrainWorkerSlot[];
  groupLimit: number;
  /** Exact train-verdict evidence for queue rows whose gate state is `evidence`. */
  gateVerdicts?: Readonly<Record<string, TrainVerdictInput>>;
}

export interface TrainAssignment {
  stage: 'express' | 'preflight' | 'group';
  host: string;
  slot: number;
  prs: string[];
}

export interface TrainDecisionResult {
  parked: string[];
  assignments: TrainAssignment[];
  waiting: Array<{ pr: string; reason: 'main-merge-conflict' | 'gate-not-ready' | 'no-free-slot' }>;
  skipped: Array<{ pr: string; reason: 'active' | 'not-open' }>;
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

function validate(input: TrainDecisionInput): void {
  if (!isSha(input.base)) throw new Error('train decision base must be a 40-character SHA');
  if (!Number.isInteger(input.groupLimit) || input.groupLimit < 1) throw new Error('train group limit must be a positive integer');
  const prs = new Set<string>();
  for (const row of input.queue) {
    if (!/^\d+$/.test(row.pr) || !isSha(row.head)) throw new Error(`invalid queued PR identity: ${row.pr}`);
    if (prs.has(row.pr)) throw new Error(`duplicate queued PR: ${row.pr}`);
    prs.add(row.pr);
    if (row.expressRank !== undefined && (!Number.isInteger(row.expressRank) || row.expressRank < 0)) {
      throw new Error(`invalid express rank for PR ${row.pr}`);
    }
    if (row.mustRank !== undefined && (!Number.isInteger(row.mustRank) || row.mustRank < 0)) {
      throw new Error(`invalid MUST rank for PR ${row.pr}`);
    }
  }
  const slotKeys = new Set<string>();
  for (const slot of input.slots) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slot.host) || !Number.isInteger(slot.slot) || slot.slot < 1) {
      throw new Error(`invalid train worker slot: ${slot.host}/${slot.slot}`);
    }
    const key = `${slot.host}/${slot.slot}`;
    if (slotKeys.has(key)) throw new Error(`duplicate train worker slot: ${key}`);
    slotKeys.add(key);
  }
  for (const refusal of input.refusals) {
    if (!/^\d+$/.test(refusal.pr) || !isSha(refusal.head) || !isSha(refusal.base) || !refusal.runId.trim()
      || !Number.isFinite(Date.parse(refusal.at))) {
      throw new Error(`invalid refusal identity for PR ${refusal.pr}`);
    }
  }
  for (const park of input.lastParks) {
    if (!/^\d+$/.test(park.pr) || !isSha(park.head) || !Number.isFinite(Date.parse(park.at))) {
      throw new Error(`invalid park identity for PR ${park.pr}`);
    }
  }
}

/** One canonical candidate order for all dispatch lanes. */
export function orderTrainQueueEntries(queue: readonly TrainQueueEntry[]): TrainQueueEntry[] {
  const measured = queue.filter(row => row.files !== undefined || row.radius !== undefined || row.priority !== undefined);
  if (measured.length > 0 && queue.some(row => row.files === undefined || row.radius === undefined)) {
    throw new Error('train decision hotspot radius is only partially measured');
  }
  // Source: train-manager.py dispatch order and RFC-train-manager-loop-agent.md §5.
  // Keep policy lanes ahead of radius; each lane uses the same hotspot ordering.
  const queueRank = new Map(queue.map((row, index) => [row.pr, index]));
  const rankedQueue = [...queue].sort((a, b) => {
    const aTier = a.expressRank !== undefined ? 0 : a.mustRank !== undefined ? 1 : a.solo ? 2 : 3;
    const bTier = b.expressRank !== undefined ? 0 : b.mustRank !== undefined ? 1 : b.solo ? 2 : 3;
    return aTier - bTier
      || (aTier === 0 ? a.expressRank! - b.expressRank! : 0)
      || (aTier === 1 ? a.mustRank! - b.mustRank! : 0)
      || queueRank.get(a.pr)! - queueRank.get(b.pr)!;
  });
  if (measured.length === 0) return rankedQueue;
  const lane = (row: TrainQueueEntry) => row.expressRank !== undefined ? 0 : row.mustRank !== undefined ? 1 : row.solo ? 2 : 3;
  const ordered: TrainQueueEntry[] = [];
  for (const tier of [0, 1, 2, 3]) {
    ordered.push(...orderHotspotPrsByRadius(rankedQueue.filter(row => lane(row) === tier)
      .map(row => ({ ...row, files: row.files!, radius: row.radius! }))));
  }
  return ordered;
}

/**
 * Pure decision core for the train loop. Inputs are one tick's immutable snapshots;
 * filesystem, GitHub, worker health, and queue writes stay at their adapters.
 */
export function planTrainDecisions(input: TrainDecisionInput): TrainDecisionResult {
  validate(input);
  const orderedQueue = orderTrainQueueEntries(input.queue);
  const gatePassed = (row: TrainQueueEntry): boolean => {
    if (row.gate === 'passed') return true;
    if (row.gate !== 'evidence') return false;
    const evidence = input.gateVerdicts?.[row.pr];
    return !!evidence && evidence.base === input.base && evidence.head === row.head
      && decideTrainVerdict(evidence).verdict === 'pass';
  };
  const active = new Set(input.activePrs);
  const queueByPr = new Map(input.queue.map((row) => [row.pr, row]));
  const lastParkByPrHead = new Map<string, number>();
  for (const park of input.lastParks) {
    const key = `${park.pr}:${park.head.toLowerCase()}`;
    const timestamp = Date.parse(park.at);
    const previous = lastParkByPrHead.get(key);
    if (previous === undefined || timestamp > previous) lastParkByPrHead.set(key, timestamp);
  }
  const refusalRuns = new Map<string, Set<string>>();
  for (const event of input.refusals) {
    const queued = queueByPr.get(event.pr);
    if (!queued || queued.state !== 'open' || active.has(event.pr) || event.kind !== 'batch-refusal') continue;
    // train-manager.py keys strikes to the still-current PR head; old-base events
    // remain relevant until that head changes or a later park adjudicates them.
    if (queued.head.toLowerCase() !== event.head.toLowerCase()) continue;
    const parkAt = lastParkByPrHead.get(`${event.pr}:${event.head.toLowerCase()}`);
    // Refusal events at or before the most recent park row are
    // already adjudicated. A re-queued same-head PR must earn two new refusals.
    if (parkAt !== undefined && Date.parse(event.at) <= parkAt) continue;
    const key = `${event.pr}:${event.head.toLowerCase()}`;
    const runs = refusalRuns.get(key) ?? new Set<string>();
    runs.add(event.runId);
    refusalRuns.set(key, runs);
  }

  const parked = new Set<string>();
  for (const [key, runs] of refusalRuns) {
    if (runs.size < 2) continue;
    const pr = key.slice(0, key.indexOf(':'));
    parked.add(pr);
  }

  const skipped: TrainDecisionResult['skipped'] = [];
  const waiting: TrainDecisionResult['waiting'] = [];
  const assigned = new Set<string>();
  for (const row of input.queue) {
    if (row.state !== 'open') skipped.push({ pr: row.pr, reason: 'not-open' });
    else if (active.has(row.pr)) skipped.push({ pr: row.pr, reason: 'active' });
    else if (!parked.has(row.pr) && row.gate === 'conflict') waiting.push({ pr: row.pr, reason: 'main-merge-conflict' });
    else if (!parked.has(row.pr) && !gatePassed(row) && !(row.gate === 'unmeasured' && (row.expressRank !== undefined || row.solo))) {
      waiting.push({ pr: row.pr, reason: 'gate-not-ready' });
    }
  }

  let freeSlots = [...input.slots];
  const assignments: TrainAssignment[] = [];
  const expressRows = orderedQueue
    .filter((row) => row.state === 'open' && !active.has(row.pr) && !parked.has(row.pr)
      && row.expressRank !== undefined && (gatePassed(row) || row.gate === 'unmeasured'));
  for (const row of expressRows) {
    const slotIndex = freeSlots.findIndex((slot) => slot.expressOnly);
    const selectedIndex = slotIndex >= 0 ? slotIndex : freeSlots.findIndex((slot) => !slot.expressOnly);
    if (selectedIndex < 0) {
      waiting.push({ pr: row.pr, reason: 'no-free-slot' });
      continue;
    }
    const [slot] = freeSlots.splice(selectedIndex, 1);
    assignments.push({ stage: row.solo && row.gate === 'unmeasured' ? 'preflight' : 'express',
      host: slot!.host, slot: slot!.slot, prs: [row.pr] });
    assigned.add(row.pr);
  }

  for (const slot of freeSlots.filter((candidate) => !candidate.expressOnly)) {
    const candidates = orderedQueue.filter((row) => row.state === 'open' && !active.has(row.pr) && !parked.has(row.pr)
      && !assigned.has(row.pr) && row.expressRank === undefined
      && (gatePassed(row) || (row.solo && row.gate === 'unmeasured')));
    if (candidates.length === 0) break;
    const first = candidates[0]!;
    const nextSolo = candidates.findIndex(row => row.solo);
    const group = first.solo ? [first] : candidates.slice(0, nextSolo < 0 ? undefined : nextSolo).slice(0, input.groupLimit);
    const stage = first.solo && first.gate === 'unmeasured' ? 'preflight' : 'group';
    assignments.push({ stage, host: slot.host, slot: slot.slot, prs: group.map((row) => row.pr) });
    for (const row of group) assigned.add(row.pr);
  }

  // Keep every eligible PR visible when the available slots are exhausted.
  // Group limits apply per worker slot, so overflow can be picked up by a later
  // slot; only the final unassigned rows are waiting for capacity.
  for (const row of orderedQueue) {
    if (row.state !== 'open' || active.has(row.pr) || parked.has(row.pr) || assigned.has(row.pr)) continue;
    if ((!gatePassed(row) && !(row.solo && row.gate === 'unmeasured')) || row.expressRank !== undefined) continue;
    waiting.push({ pr: row.pr, reason: 'no-free-slot' });
  }

  const uniqueWaiting = [...new Map(waiting.map((row) => [`${row.pr}:${row.reason}`, row])).values()];
  return {
    parked: input.queue.filter((row) => parked.has(row.pr)).map((row) => row.pr),
    assignments,
    waiting: uniqueWaiting,
    skipped,
  };
}
