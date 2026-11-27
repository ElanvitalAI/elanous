// LLM-ACCOUNT-POLICY facts inside the lease ledger (resource-ledger/events.jsonl) — not a new ledger (LOOP-AGENTS §1 «정본
// 원장 넷 · 새 tsv/json 원장 금지»):
//   llm-override : one override set/clear {scope · action · by · why · until · untilEvent} — CEO / OP / RES / GUARDIAN.
//                  Ranked CEO > safety (YAML hard stops, never stored) > OP=RES > GUARDIAN; each one expires.
//   llm-state    : the guardian 연료관's evaluated levels (per resource, with since) and the current phase (with since) —
//                  the ONE fact consumers read for «what level / phase are we in» (no consumer evaluates levels itself).
// Pure: types + validation (resource-ledger.ts validates every line with this before it accepts or appends it).
import { isLevelAction, isResourceId, LEVELS, type Level, type LevelAction } from '../kit/resource-facts/llm-accounts.js';

export const OVERRIDE_ACTORS = ['CEO', 'OP', 'RES', 'GUARDIAN'] as const;
export type OverrideActor = typeof OVERRIDE_ACTORS[number];

export interface LlmOverrideSet {
  event: 'llm-override'; at: string; by: OverrideActor; op: 'set';
  id: string;
  /** `<provider>:<account>` · `<provider>:<account>:credits` · `<provider>` · `*`. */
  scope: string;
  action: LevelAction;
  why: string;
  /** ISO — always present (default = at + overrides.default_hours). */
  until: string;
  /** Expires earlier when this event is seen, e.g. `reset:openai-codex:team,openai-codex:third` (all back at L0). */
  untilEvent?: string;
  /** Crown evidence for a CEO override (bus id / decision id). */
  ref?: string;
}
export interface LlmOverrideClear { event: 'llm-override'; at: string; by: OverrideActor; op: 'clear'; id: string; why: string; ref?: string }
/** Override rank by actor (= kit/resource-facts LAYER_RANK order): who may clear whose. */
export const OVERRIDE_RANK: Readonly<Record<OverrideActor, number>> = { CEO: 3, OP: 2, RES: 2, GUARDIAN: 1 };
export type LlmOverrideEvent = LlmOverrideSet | LlmOverrideClear;

export interface LlmStateEvent {
  event: 'llm-state'; at: string; by: 'GUARDIAN';
  revision: string | null;
  phase: string;
  phaseSince: string;
  /** A phase the rules want but that needs 대표 (requires_ceo) — held until a CEO `mode:<phase>` override. */
  pendingPhase?: string | null;
  levels: Record<string, { level: Level; since: string; remainingPercent?: number | null }>;
  maintenance?: boolean;
  /** Credit balances the levels were judged on (guardian 연료관): the day (operator day), its start, the latest sample, and
   *  the day's cumulative spend (sum of every drop between samples). */
  credits?: Record<string, { day: string; startBalance: number; balance: number; spent?: number }>;
}
export type LlmPolicyLedgerEvent = LlmOverrideEvent | LlmStateEvent;
export const LLM_POLICY_EVENT_TYPES = ['llm-override', 'llm-state'] as const;

const ts = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isOverrideScope = (v: unknown): v is string => v === '*' || isResourceId(v) || (typeof v === 'string' && /^[a-z0-9][a-z0-9._-]*$/u.test(v));
export const isOverrideActor = (v: unknown): v is OverrideActor => typeof v === 'string' && (OVERRIDE_ACTORS as readonly string[]).includes(v);
export const isUntilEvent = (v: unknown): v is string => typeof v === 'string' && /^reset:[a-z0-9._:-]+(,[a-z0-9._:-]+)*$/u.test(v)
  && v.slice('reset:'.length).split(',').every(isResourceId);

export function validLlmPolicyEvent(row: Record<string, unknown>): boolean {
  if (!ts(row.at)) return false;
  if (row.event === 'llm-override') {
    if (!isOverrideActor(row.by) || !text(row.id, 80) || !text(row.why, 500)) return false;
    if (row.op === 'clear') return row.by !== 'CEO' || text(row.ref, 200); // a CEO clear carries its crown too
    if (row.op !== 'set') return false;
    // A CEO-rank override always carries its crown (the decision id) — also on a direct append.
    if (row.by === 'CEO' && !text(row.ref, 200)) return false;
    return isOverrideScope(row.scope) && isLevelAction(row.action) && ts(row.until)
      && (row.untilEvent === undefined || isUntilEvent(row.untilEvent)) && (row.ref === undefined || text(row.ref, 200));
  }
  if (row.event === 'llm-state') {
    if (row.by !== 'GUARDIAN' || !text(row.phase, 60) || !ts(row.phaseSince)) return false;
    if (!(row.revision === null || text(row.revision, 64))) return false;
    if (!(row.pendingPhase === undefined || row.pendingPhase === null || text(row.pendingPhase, 60))) return false;
    if (row.maintenance !== undefined && typeof row.maintenance !== 'boolean') return false;
    if (row.credits !== undefined && !(isRec(row.credits) && Object.entries(row.credits).every(([k, v]) => isResourceId(k) && isRec(v)
      && typeof v.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(v.day) && Number.isFinite(v.startBalance) && Number.isFinite(v.balance)
      && (v.spent === undefined || (Number.isFinite(v.spent) && Number(v.spent) >= 0))))) return false;
    return isRec(row.levels) && Object.entries(row.levels).every(([k, v]) => isResourceId(k) && isRec(v)
      && (LEVELS as readonly string[]).includes(String(v.level)) && ts(v.since)
      && (v.remainingPercent === undefined || v.remainingPercent === null || (typeof v.remainingPercent === 'number' && Number.isFinite(v.remainingPercent))));
  }
  return false;
}
