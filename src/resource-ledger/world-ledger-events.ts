// WORLD-REGISTRY events inside the lease ledger (resource-ledger/events.jsonl) — not a new ledger
// (LOOP-AGENTS §1 «정본 원장 넷 · 새 tsv/json 원장 금지» · FEDERATION-ORG-SYSTEM-1127 v2: WORLD-REGISTRY = 임대 장부 확장).
//   world-actor : one declaration of an actor's fields — `mode: owner` (an owner / guardian sub-agent / elanous tool registers)
//                 or `mode: discover` (a sweep saw it first / saw a static field change). Owner fields win over discover.
//   world-sweep : one enumeration of one scope (a host probe, or `registries` = loops · beats · els panes · host-registry):
//                 ok/error · ids that appeared · ids that went away · heartbeats that moved. Deltas only, so a quiet sweep is ~150 bytes.
// Pure: types + validation only (resource-ledger.ts validates every line with this before it accepts or appends it).
import { isDeclaredState, isWorldKind, type DeclaredState, type WorldKind } from './world-types.js';

export interface WorldActorFields {
  id: string;
  kind: WorldKind;
  mode: 'owner' | 'discover';
  registered?: boolean;
  declaredState?: DeclaredState;
  purpose?: string | null;
  owner?: string | null;
  subject?: string | null;
  wake?: string | null;
  kpi?: string | null;
  heartbeatSource?: string | null;
  slaMin?: number | null;
  host?: string | null;
  meta?: Record<string, unknown>;
}

export type WorldActorEvent = { event: 'world-actor'; at: string; by: string; actor: WorldActorFields };
export type WorldSweepEvent = {
  event: 'world-sweep'; at: string; by: string; scope: string; ok: boolean; error?: string;
  appeared: string[]; gone: string[]; beats: Record<string, string>; counts: Record<string, number>;
};
/** One control act on an actor (pause · resume · demote) — audited whether it applied, was refused or failed; `undo` names
 *  the reverse act so every applied control is reversible. Nothing here deletes an actor (retire=never). */
export const WORLD_CONTROL_ACTIONS = ['pause', 'resume', 'demote'] as const;
export type WorldControlAction = typeof WORLD_CONTROL_ACTIONS[number];
export type WorldControlEvent = {
  event: 'world-control'; at: string; by: string; actorId: string; action: WorldControlAction; to?: string; reason: string;
  result: 'applied' | 'refused' | 'failed'; detail: string; undo?: string;
};
export type WorldLedgerEvent = WorldActorEvent | WorldSweepEvent | WorldControlEvent;

export const WORLD_LEDGER_EVENT_TYPES = ['world-actor', 'world-sweep', 'world-control'] as const;

const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v: unknown, max = 1000) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ts = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function validWorldActorFields(a: unknown): a is WorldActorFields {
  if (!isRec(a)) return false;
  return text(a.id, 300) && isWorldKind(a.kind) && (a.mode === 'owner' || a.mode === 'discover')
    && (a.registered === undefined || typeof a.registered === 'boolean')
    && (a.declaredState === undefined || isDeclaredState(a.declaredState))
    && ['purpose', 'owner', 'subject', 'wake', 'kpi', 'heartbeatSource', 'host'].every(k => optText(a[k]))
    && (a.slaMin === undefined || a.slaMin === null || (typeof a.slaMin === 'number' && Number.isFinite(a.slaMin) && a.slaMin >= 0))
    && (a.meta === undefined || isRec(a.meta));
}

/** Validate one parsed ledger row of a world event type. */
export function validWorldLedgerEvent(row: Record<string, unknown>): boolean {
  if (!ts(row.at) || !text(row.by, 200)) return false;
  if (row.event === 'world-actor') return validWorldActorFields(row.actor);
  if (row.event === 'world-sweep') {
    return text(row.scope, 200) && typeof row.ok === 'boolean' && optText(row.error)
      && Array.isArray(row.appeared) && row.appeared.every(id => text(id, 300))
      && Array.isArray(row.gone) && row.gone.every(id => text(id, 300))
      && isRec(row.beats) && Object.entries(row.beats).every(([id, at]) => text(id, 300) && ts(at))
      && isRec(row.counts) && Object.values(row.counts).every(n => Number.isSafeInteger(n) && Number(n) >= 0);
  }
  if (row.event === 'world-control') {
    return text(row.actorId, 300) && typeof row.action === 'string' && (WORLD_CONTROL_ACTIONS as readonly string[]).includes(row.action)
      && optText(row.to, 40) && text(row.reason, 1000) && ['applied', 'refused', 'failed'].includes(String(row.result))
      && typeof row.detail === 'string' && row.detail.length <= 2000 && optText(row.undo, 400);
  }
  return false;
}
