// 기차 매니저 — sub-loop agent of 착지 집사 (knowhow: graphs/loop-agents/land-steward/knowhow.md T1·T3·T6·T9).
// The merge-train era (seat-state/OP/tools/train-manager.py · train-batch graphs) batched PRs into one gate; the land graph
// replaced that batch path with per-PR lands on the merge result. What the train manager still owns:
//   order  — churn victims first (T3) → crown / P0 (T9) → oldest → PR number. Feeds tickLand via LandDeps.order.
//   lanes  — hot files touched by ≥ 2 open PRs; the body lands one PR per file per tick and the next one re-merges main (T1/T2).
//   slots  — advice only (T6): +1 when ready PRs wait for slots and the last hour landed fewer than the KPI.
import { churnVictims, type LedgerRow, type PrInfo } from '../land-graph/land-graph.js';

const CROWN = /\u{1F451}|\bP0\b|crown/iu; // the crown mark is escaped (public-export check)
export const priorityOf = (p: Pick<PrInfo, 'title'>): number => (CROWN.test(p.title) ? 0 : 1);

/** Land order: churn victims (most churn refusals first) → priority → age (createdAt) → PR number. */
export function trainOrder(prs: readonly PrInfo[], rows: readonly LedgerRow[], nowMs: number): PrInfo[] {
  const churn = churnVictims(prs, rows, nowMs);
  const age = (p: PrInfo) => (p.createdAt ? Date.parse(p.createdAt) : Number.MAX_SAFE_INTEGER);
  return [...prs].sort((a, b) => (churn.get(b.number) ?? 0) - (churn.get(a.number) ?? 0) || priorityOf(a) - priorityOf(b) || age(a) - age(b) || a.number - b.number);
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
export function slotAdvice(slots: number, waitingForSlot: number, landsLastHour: number, kpi: number): SlotAdvice {
  if (waitingForSlot > 0 && landsLastHour < kpi) return { slots, advise: slots + 1, why: `${waitingForSlot} ready PR(s) waited for a slot while the last hour landed ${landsLastHour} < ${kpi} — land.graph.slots ${slots} → ${slots + 1} (TC)` };
  return { slots, advise: slots, why: waitingForSlot ? `${waitingForSlot} wait for a slot · lands/h ${landsLastHour} ≥ ${kpi}` : 'no PR waits for a slot' };
}
