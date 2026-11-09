import { isObject } from '../primitives/guards.js';
/**
 * ENTRANCE-DISPATCH-SHADOW: pure, read-only decision contract for comparing the
 * graph entrance with the current dispatcher. This module never launches work.
 * Callers must pass one immutable observation snapshot for a single cycle.
 */

export type EntranceShadowDecision = 'would-run' | 'would-skip';

export interface EntranceShadowObserved<T> {
  state: 'observed';
  value: T;
  source: string;
  observedAt: string;
}

export interface EntranceShadowUnknown {
  state: 'unknown';
  reason: string;
  source: string;
  observedAt: string;
}

export type EntranceShadowInput<T> = EntranceShadowObserved<T> | EntranceShadowUnknown;

export interface EntranceShadowSnapshot {
  cycleId: string;
  cellId: string;
  version: string;
  observedAt: string;
  checklist: EntranceShadowInput<{
    status: 'green' | 'yellow' | 'red' | 'done';
    priority: 'P0' | 'P1' | 'P2';
    targetPathsGrounded: boolean;
  }>;
  hold: EntranceShadowInput<{ active: boolean; reason?: string }>;
  openPullRequests: EntranceShadowInput<{ sameCell: number; overlapping: boolean; overlapBlock: boolean }>;
  capacity: EntranceShadowInput<{
    podSlotsAvailable: number;
    podSlotsRequired: number;
    localSlotsAvailable: number;
    localSlotsRequired: number;
    seatShareAvailable: boolean;
  }>;
}

export type EntranceShadowReason =
  | 'checklist-not-yellow'
  | 'target-path-not-grounded'
  | 'held'
  | 'open-pr-conflict'
  | 'pod-capacity'
  | 'local-capacity'
  | 'seat-share-unavailable'
  | 'input-unknown';

export interface EntranceShadowRecord {
  schema: 'entrance-shadow/v1';
  cycleId: string;
  cellId: string;
  version: string;
  observedAt: string;
  /** Frozen source observations are retained so the decision can be audited later. */
  inputs: Pick<EntranceShadowSnapshot, 'checklist' | 'hold' | 'openPullRequests' | 'capacity'>;
  decision: EntranceShadowDecision;
  reason: EntranceShadowReason | 'eligible';
  substrate: 'pod' | 'local' | null;
  /** Always false: a shadow result is evidence only, never a launch instruction. */
  launched: false;
  /** Unknown source names are explicit so incomplete cycles cannot look like parity. */
  unknownInputs: string[];
}

function validStamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validInput(name: string, input: unknown): boolean {
  if (!isObject(input) || typeof input.source !== 'string' || !input.source.trim()
    || typeof input.observedAt !== 'string' || !validStamp(input.observedAt)) return false;
  try { structuredClone(input); } catch { return false; }
  if (input.state === 'unknown') return typeof input.reason === 'string' && !!input.reason.trim();
  if (input.state !== 'observed' || !isObject(input.value)) return false;
  const value = input.value;
  switch (name) {
    case 'checklist':
      return typeof value.status === 'string' && ['green', 'yellow', 'red', 'done'].includes(value.status)
        && typeof value.priority === 'string' && ['P0', 'P1', 'P2'].includes(value.priority)
        && typeof value.targetPathsGrounded === 'boolean';
    case 'hold':
      return typeof value.active === 'boolean' && (value.reason === undefined || typeof value.reason === 'string');
    case 'openPullRequests':
      return Number.isSafeInteger(value.sameCell) && Number(value.sameCell) >= 0
        && typeof value.overlapping === 'boolean' && typeof value.overlapBlock === 'boolean';
    case 'capacity':
      return Number.isSafeInteger(value.podSlotsAvailable) && Number(value.podSlotsAvailable) >= 0
        && Number.isSafeInteger(value.podSlotsRequired) && Number(value.podSlotsRequired) >= 0
        && Number.isSafeInteger(value.localSlotsAvailable) && Number(value.localSlotsAvailable) >= 0
        && Number.isSafeInteger(value.localSlotsRequired) && Number(value.localSlotsRequired) >= 0
        && typeof value.seatShareAvailable === 'boolean';
    default:
      return false;
  }
}

function copyInput(name: string, input: unknown, observedAt: string): EntranceShadowInput<unknown> {
  if (!validInput(name, input)) {
    return { state: 'unknown', reason: 'invalid or non-cloneable observation', source: 'validation', observedAt };
  }
  const row = input as EntranceShadowInput<unknown>;
  if (row.state === 'unknown') return { state: 'unknown', reason: row.reason, source: row.source, observedAt: row.observedAt };
  return { state: 'observed', value: structuredClone(row.value), source: row.source, observedAt: row.observedAt };
}

/**
 * Evaluate one frozen snapshot using fail-closed ordering. Unknown observations
 * are not silently interpreted as false; they yield would-skip/input-unknown.
 */
export function evaluateEntranceShadow(snapshot: EntranceShadowSnapshot): EntranceShadowRecord {
  if (!isObject(snapshot) || typeof snapshot.cycleId !== 'string' || !snapshot.cycleId.trim()
    || typeof snapshot.cellId !== 'string' || !snapshot.cellId.trim()
    || typeof snapshot.version !== 'string' || !snapshot.version.trim())
    throw new Error('cycleId, cellId, and version are required');
  const snapshotStampValid = typeof snapshot.observedAt === 'string' && validStamp(snapshot.observedAt);

  const inputs = [
    ['checklist', snapshot.checklist],
    ['hold', snapshot.hold],
    ['openPullRequests', snapshot.openPullRequests],
    ['capacity', snapshot.capacity],
  ] as const;
  const unknownInputs: string[] = [];
  if (!snapshotStampValid) unknownInputs.push('snapshot');
  for (const [name, input] of inputs) {
    if (!validInput(name, input) || (isObject(input) && input.state === 'unknown')) unknownInputs.push(name);
  }
  let reason: EntranceShadowRecord['reason'] = 'eligible';

  if (unknownInputs.length) reason = 'input-unknown';
  else if (snapshot.checklist.state !== 'observed' || snapshot.checklist.value.status !== 'yellow') reason = 'checklist-not-yellow';
  else if (!snapshot.checklist.value.targetPathsGrounded) reason = 'target-path-not-grounded';
  else if (snapshot.hold.state !== 'observed' || snapshot.hold.value.active) reason = 'held';
  else if (snapshot.openPullRequests.state !== 'observed'
    || snapshot.openPullRequests.value.sameCell > 0
    || (snapshot.openPullRequests.value.overlapBlock && snapshot.openPullRequests.value.overlapping)) reason = 'open-pr-conflict';
  else if (snapshot.capacity.state !== 'observed') reason = 'pod-capacity';
  else if (snapshot.capacity.value.podSlotsAvailable < snapshot.capacity.value.podSlotsRequired
    && snapshot.capacity.value.localSlotsAvailable < snapshot.capacity.value.localSlotsRequired) reason = 'local-capacity';
  else if (!snapshot.capacity.value.seatShareAvailable) reason = 'seat-share-unavailable';

  const capacity = validInput('capacity', snapshot.capacity) && snapshot.capacity.state === 'observed' ? snapshot.capacity.value : null;
  const substrate = reason !== 'eligible' || !capacity ? null
    : capacity.podSlotsAvailable >= capacity.podSlotsRequired ? 'pod'
      : capacity.localSlotsAvailable >= capacity.localSlotsRequired ? 'local' : null;

  const auditInputs = {
    checklist: copyInput('checklist', snapshot.checklist, snapshot.observedAt) as EntranceShadowSnapshot['checklist'],
    hold: copyInput('hold', snapshot.hold, snapshot.observedAt) as EntranceShadowSnapshot['hold'],
    openPullRequests: copyInput('openPullRequests', snapshot.openPullRequests, snapshot.observedAt) as EntranceShadowSnapshot['openPullRequests'],
    capacity: copyInput('capacity', snapshot.capacity, snapshot.observedAt) as EntranceShadowSnapshot['capacity'],
  };
  return {
    schema: 'entrance-shadow/v1',
    cycleId: snapshot.cycleId,
    cellId: snapshot.cellId,
    version: snapshot.version,
    observedAt: typeof snapshot.observedAt === 'string' ? snapshot.observedAt : '',
    inputs: auditInputs,
    decision: reason === 'eligible' ? 'would-run' : 'would-skip',
    reason,
    substrate,
    launched: false,
    unknownInputs,
  };
}
