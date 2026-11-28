// Land graph lane order — the order the land graph walks, the hot-file lanes and the slot advice (CODE-BODY-TO-KIND · was the
// land-steward's train.ts ⊕ policy.ts). Every choice is the policy pack's (graphs/loop-agents/<agent>/policies.yaml, decision
// 11-27 «lane order = YAML policy»):
//   lane_order.mode   train | pr-number — pr-number = the body's own landOrder (churn victims → PR number)
//   lane_order.train  { keys: [churn | priority | age | number …], priority: <regex> } — what «train» means (knowhow T3 · T9)
//   lane_order.pins   explicit order inside one hot-file lane (the listed PRs keep their slots, take them in the pinned sequence)
// Missing file / bad YAML / unknown mode / train without keys → null → the body's built-in order (never a guessed default).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { churnVictims, landOrder, type LedgerRow, type PrInfo } from './land-graph.js';

export type OrderKey = 'churn' | 'priority' | 'age' | 'number';
const ORDER_KEYS: readonly OrderKey[] = ['churn', 'priority', 'age', 'number'];
export interface TrainSpec { readonly keys: readonly OrderKey[]; readonly priority: RegExp | null }
export interface LanePin { readonly file: string; readonly prs: readonly number[] }
export interface LandPolicy { readonly laneOrder: { readonly mode: 'train' | 'pr-number'; readonly pins: readonly LanePin[]; readonly train?: TrainSpec | null } }
export type OrderFn = (prs: readonly PrInfo[], rows: readonly LedgerRow[], nowMs: number) => PrInfo[];

export const landPolicyPath = (root = resolve(import.meta.dir, '../..'), agent = 'land-steward'): string => join(root, 'graphs', 'loop-agents', agent, 'policies.yaml');

function parseTrain(raw: unknown): TrainSpec | null {
  const t = raw as { keys?: unknown; priority?: unknown } | null;
  const keys = Array.isArray(t?.keys) ? t.keys.filter((k): k is OrderKey => (ORDER_KEYS as readonly unknown[]).includes(k)) : [];
  if (!keys.length || keys.length !== (t?.keys as unknown[]).length) return null; // an unknown key refuses the spec (never a partial order)
  let priority: RegExp | null = null;
  if (typeof t?.priority === 'string' && t.priority) { try { priority = new RegExp(t.priority, 'iu'); } catch { return null; } }
  if (keys.includes('priority') && !priority) return null;
  return { keys, priority };
}

/** Parse the pack. Unknown mode or malformed pins are dropped (never guessed); no lane_order → null. */
export function parseLandPolicy(text: string): LandPolicy | null {
  let j: { lane_order?: { mode?: unknown; pins?: unknown; train?: unknown } } | null;
  try { j = parse(text) as typeof j; } catch { return null; }
  const lo = j?.lane_order;
  if (!lo || (lo.mode !== 'train' && lo.mode !== 'pr-number')) return null;
  const pins = (Array.isArray(lo.pins) ? lo.pins : []).flatMap((p: unknown) => {
    const x = p as { file?: unknown; prs?: unknown };
    // a PR listed twice is listed once (first place wins) — the order stays a permutation of the open PRs
    const prs = [...new Set(Array.isArray(x?.prs) ? x.prs.filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : [])];
    return typeof x?.file === 'string' && x.file && prs.length >= 2 ? [{ file: x.file, prs }] : [];
  });
  const train = lo.train === undefined ? null : parseTrain(lo.train);
  return { laneOrder: { mode: lo.mode, pins, ...(train ? { train } : {}) } };
}

export function loadLandPolicy(path = landPolicyPath()): LandPolicy | null {
  try { return existsSync(path) ? parseLandPolicy(readFileSync(path, 'utf8')) : null; } catch { return null; }
}

/** The train order a spec defines: each key in turn (churn = most churn refusals first · priority = a title matching the
 *  pattern first · age = oldest createdAt first · number = lowest PR number first). */
export function trainOrderOf(spec: TrainSpec): OrderFn {
  return (prs, rows, nowMs) => {
    const churn = spec.keys.includes('churn') ? churnVictims(prs, rows, nowMs) : new Map<number, number>();
    const by: Record<OrderKey, (a: PrInfo, b: PrInfo) => number> = {
      churn: (a, b) => (churn.get(b.number) ?? 0) - (churn.get(a.number) ?? 0),
      priority: (a, b) => (spec.priority!.test(a.title) ? 0 : 1) - (spec.priority!.test(b.title) ? 0 : 1),
      age: (a, b) => (a.createdAt ? Date.parse(a.createdAt) : Number.MAX_SAFE_INTEGER) - (b.createdAt ? Date.parse(b.createdAt) : Number.MAX_SAFE_INTEGER),
      number: (a, b) => a.number - b.number,
    };
    return [...prs].sort((a, b) => { for (const k of spec.keys) { const d = by[k](a, b); if (d) return d; } return 0; });
  };
}

/** Re-sequence each pinned lane inside the slots its PRs hold in `base` (other PRs untouched). */
function withPins(base: OrderFn, pins: readonly LanePin[]): OrderFn {
  return (prs, rows, nowMs) => {
    const out = base(prs, rows, nowMs);
    for (const pin of pins) {
      const inLane = (p: PrInfo) => pin.prs.includes(p.number) && p.files.includes(pin.file);
      const slots = out.map((p, i) => (inLane(p) ? i : -1)).filter(i => i >= 0);
      const seq = pin.prs.map(n => out.find(p => p.number === n && inLane(p))).filter((p): p is PrInfo => !!p);
      slots.forEach((slot, k) => { out[slot] = seq[k]!; });
    }
    return out;
  };
}

/** The base order of a pack: train (its spec) · pr-number (the body's landOrder) · train without a spec → the body's order. */
const baseOrder = (policy: LandPolicy): OrderFn => (policy.laneOrder.mode === 'train' && policy.laneOrder.train ? trainOrderOf(policy.laneOrder.train) : landOrder);

/** The agent's live order: the pack's base mode, then its pins. */
export function policyOrder(policy: LandPolicy): OrderFn {
  return withPins(baseOrder(policy), policy.laneOrder.pins);
}

/** Every land run (the land-graph CLI · agent shadow/off): the body's own landOrder, reordered ONLY by explicit pins —
 *  no pins → null (the body's order exactly as before the pack · Terra #40447 must-fix 1). The pack's `mode` is the
 *  agent's live choice, never a global default. */
export function pinOrder(policy: LandPolicy | null): OrderFn | null {
  return policy && policy.laneOrder.pins.length ? withPins(landOrder, policy.laneOrder.pins) : null;
}

export interface Lane { file: string; prs: number[] }
const IGNORE = (f: string) => /\.md$/iu.test(f) || f.startsWith('docs/');
/** Hot-file lanes among open PRs, drafts included (a draft on the same file still churns its lane-mates) · docs never count · widest first. */
export function lanes(prs: readonly PrInfo[]): Lane[] {
  const by = new Map<string, number[]>();
  for (const p of prs) if (p.state === 'OPEN') for (const f of p.files) if (!IGNORE(f)) by.set(f, [...(by.get(f) ?? []), p.number]);
  return [...by.entries()].filter(([, n]) => n.length >= 2).map(([file, n]) => ({ file, prs: n.sort((a, b) => a - b) }))
    .sort((a, b) => b.prs.length - a.prs.length || a.file.localeCompare(b.file));
}

export interface SlotAdvice { slots: number; advise: number; why: string }
/** Advice only (knowhow T6): +1 when ready PRs waited for a slot while the last hour landed under the lands target. */
export function slotAdvice(slots: number, waitingForSlot: number, landsLastHour: number, kpi: number): SlotAdvice {
  if (waitingForSlot > 0 && landsLastHour < kpi) return { slots, advise: slots + 1, why: `${waitingForSlot} ready PR(s) waited for a slot while the last hour landed ${landsLastHour} < ${kpi} — land.graph.slots ${slots} → ${slots + 1} (TC)` };
  return { slots, advise: slots, why: waitingForSlot ? `${waitingForSlot} wait for a slot · lands/h ${landsLastHour} ≥ ${kpi}` : 'no PR waits for a slot' };
}
