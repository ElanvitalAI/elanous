// 착지 집사 policy pack (decision 11-27 «lane order = YAML policy, not lane-order.json»): graphs/loop-agents/land-steward/
// policies.yaml → the land order the land graph walks. Missing file / bad YAML / missing key → null → the body's built-in order.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { landOrder, type LedgerRow, type PrInfo } from '../land-graph/land-graph.js';
import { trainOrder } from './train.js';

export interface LanePin { readonly file: string; readonly prs: readonly number[] }
export interface LandPolicy { readonly laneOrder: { readonly mode: 'train' | 'pr-number'; readonly pins: readonly LanePin[] } }
export type OrderFn = (prs: readonly PrInfo[], rows: readonly LedgerRow[], nowMs: number) => PrInfo[];

export const landPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'loop-agents', 'land-steward', 'policies.yaml');

/** Parse the pack. Unknown mode or malformed pins are dropped (never guessed); no lane_order → null. */
export function parseLandPolicy(text: string): LandPolicy | null {
  let j: { lane_order?: { mode?: unknown; pins?: unknown } } | null;
  try { j = parse(text) as typeof j; } catch { return null; }
  const lo = j?.lane_order;
  if (!lo || (lo.mode !== 'train' && lo.mode !== 'pr-number')) return null;
  const pins = (Array.isArray(lo.pins) ? lo.pins : []).flatMap((p: unknown) => {
    const x = p as { file?: unknown; prs?: unknown };
    // a PR listed twice is listed once (first place wins) — the order stays a permutation of the open PRs
    const prs = [...new Set(Array.isArray(x?.prs) ? x.prs.filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : [])];
    return typeof x?.file === 'string' && x.file && prs.length >= 2 ? [{ file: x.file, prs }] : [];
  });
  return { laneOrder: { mode: lo.mode, pins } };
}

export function loadLandPolicy(path = landPolicyPath()): LandPolicy | null {
  try { return existsSync(path) ? parseLandPolicy(readFileSync(path, 'utf8')) : null; } catch { return null; }
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

/** The steward's live order: the pack's base mode (train | pr-number), then its pins. */
export function policyOrder(policy: LandPolicy): OrderFn {
  return withPins(policy.laneOrder.mode === 'train' ? trainOrder : landOrder, policy.laneOrder.pins);
}

/** Every land run (the land-graph CLI · steward shadow/off): the body's own landOrder, reordered ONLY by explicit pins —
 *  no pins → null (the body's order exactly as before the pack · Terra #40447 must-fix 1). The pack's `mode` is the
 *  steward's live choice, never a global default. */
export function pinOrder(policy: LandPolicy | null): OrderFn | null {
  return policy && policy.laneOrder.pins.length ? withPins(landOrder, policy.laneOrder.pins) : null;
}
