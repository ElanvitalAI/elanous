// BOARD-STEWARD (`steward:BOARD` · OP-direct · CEO 11-25 23:1x) — the pure model of the one federation board.
//
// One board across spaces (space = tag: the owner's coordinator scope, or the cell's own `space` tag). Four duties, no LLM:
//   (1) rank   — op-pulse phase → one federation-wide `priorityOrder` (the ledger `eln work next` already reads), so
//                hands pull top-down regardless of space. Leaders keep supply only: a priority-order written by anyone
//                but OP/BOARD is flagged and overwritten.
//   (2) cut    — per release version: green → ship · yellow → waive (known issue, not critical) or defer (carry over) ·
//                a yellow MUST/critical P0 of this version → hold (the release graph L-0 decides; we never waive it).
//                After the L-8 publish signal the next board opens (carry-over ⊕ new) and the pulse phase resets.
//   (3) health — ready cells vs idle hands per space (target ≥ 2× hands) · blocked cells and the seat they wait on ·
//                WIP-1 violations (a hand holding N active cells → return the N−1 lowest-ranked to the board).
//   (4) cards  — one digest row per tick; one OP card only on a threshold breach, ≤ 3 per 10 minutes.
//
// 세 얼굴: 관측 = board-digest.jsonl ⊕ cut-list-<v>.json ⊕ board-state.json · 판단 근거 = the rules in this file (pure) ·
//          수복과 인계 = WIP returns and order rewrites (live only); everything else is a card to OP.

import type { PulsePhase } from '../../loops/op-pulse.js';
import { needsSpec } from '../space/work-next.js';

export interface BoardCellIn {
  readonly id: string;
  readonly title: string;
  readonly status: 'green' | 'yellow' | 'red' | 'done' | string;
  readonly owner?: string;
  readonly priority?: string;
  readonly predecessors?: readonly string[];
  readonly deadlineVersion?: string;
  readonly dispatchKind?: string;
  readonly knownIssue?: string;
  readonly must?: { readonly version: string } | undefined;
  readonly updatedAt: string;
  /** Explicit space tag; absent = the owner's coordinator scope, else `BOARD`. */
  readonly space?: string;
  readonly tags?: readonly string[];
  /** The cell's done-when (checklist doneCriterion) — blank on an unowned cell = needs-spec (POOL-PULL-NEEDS-SPEC). */
  readonly doneCriterion?: string;
}

export interface HandIn { readonly seat: string; readonly space: string; readonly idle: boolean }

export const BOARD_WRITERS: readonly string[] = ['OP', 'BOARD', 'CLAUDE-OP', 'STEWARD:BOARD'];
export const READY_PER_HAND = 2;
export const CARD_WINDOW_MS = 10 * 60_000;
export const ORDER_MAX = 32;

const PRI: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
const pri = (c: BoardCellIn): number => PRI[c.priority ?? ''] ?? 3;

export function cmpVersion(a?: string, b?: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0); const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

export const isOpen = (c: BoardCellIn): boolean => c.status === 'yellow' || c.status === 'red';
const isWorkCell = (c: BoardCellIn): boolean => c.dispatchKind !== 'decision' && c.dispatchKind !== 'umbrella';
export const isDemo = (c: BoardCellIn): boolean => /\bdemo\b|데모/i.test(c.title) || (c.tags ?? []).includes('demo');
export const isCritical = (c: BoardCellIn, version: string): boolean => (!!c.must && c.must.version === version) || (c.priority === 'P0' && (c.tags ?? []).includes('critical'));

export function spaceOf(c: BoardCellIn, scopeOf: (seat: string) => string): string {
  if (c.space?.trim()) return c.space.trim().toUpperCase();
  if (c.owner?.trim()) return scopeOf(c.owner).toUpperCase();
  return 'BOARD';
}

/** Phase weight: which cells float to the top in this phase (rules, not taste). Lower = earlier. */
export function phaseBand(c: BoardCellIn, phase: PulsePhase, version: string): number {
  const crit = isCritical(c, version);
  switch (phase) {
    case 'demo-freeze': return isDemo(c) && c.priority === 'P0' ? 0 : isDemo(c) ? 1 : crit ? 2 : 4;
    case 'pre-cut': case 'release-window': return crit ? 0 : c.deadlineVersion === version ? 1 : 3;
    case 'post-release': return c.status === 'red' ? 0 : crit ? 1 : 2;
    case 'night': return crit ? 0 : 2;
    default: return crit ? 0 : 1;
  }
}

/** (1) The federation-wide order: open work cells, ranked by phase band → priority → deadline version → age → id. */
export function rankBoard(cells: readonly BoardCellIn[], phase: PulsePhase, version: string): string[] {
  return cells.filter((c) => isOpen(c) && isWorkCell(c))
    .sort((a, b) => phaseBand(a, phase, version) - phaseBand(b, phase, version) || pri(a) - pri(b) || cmpVersion(a.deadlineVersion, b.deadlineVersion)
      || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, ORDER_MAX).map((c) => c.id);
}

export interface OrderLedger { readonly order: readonly string[]; readonly by?: string; readonly at?: string }

/** (4) A priority-order written by a leader (not OP/BOARD) is ignored and flagged. */
export function leaderWrite(ledger: OrderLedger, owner = 'OP'): { flagged: boolean; by: string | null } {
  const by = (ledger.by ?? '').trim().toUpperCase();
  if (!by || !ledger.order.length) return { flagged: false, by: by || null };
  return { flagged: !BOARD_WRITERS.includes(by) && by !== owner.trim().toUpperCase(), by };
}

export type CutDecision = 'ship' | 'waive' | 'defer' | 'hold';
export interface CutRow { readonly id: string; readonly decision: CutDecision; readonly why: string; readonly space: string }
export interface CutList { readonly version: string; readonly at: string; readonly by: 'steward:BOARD'; readonly rows: readonly CutRow[]; readonly counts: Record<CutDecision, number>; readonly holds: readonly string[] }

/** (2) Cut list of one version: green/done → ship · yellow critical → hold · yellow with known-issue text → waive · other yellow → defer. */
export function cutList(cells: readonly BoardCellIn[], version: string, at: string, scopeOf: (s: string) => string): CutList {
  const rows: CutRow[] = cells.filter((c) => !c.deadlineVersion || cmpVersion(c.deadlineVersion, version) <= 0).map((c): CutRow => {
    const space = spaceOf(c, scopeOf);
    if (c.status === 'green' || c.status === 'done') return { id: c.id, decision: 'ship', why: c.status, space };
    if (isCritical(c, version)) return { id: c.id, decision: 'hold', why: c.must ? `MUST ${c.must.version}` : 'critical P0', space };
    if (c.knownIssue?.trim()) return { id: c.id, decision: 'waive', why: 'known issue (not critical)', space };
    return { id: c.id, decision: 'defer', why: 'not critical · carry over', space };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const counts: Record<CutDecision, number> = { ship: 0, waive: 0, defer: 0, hold: 0 };
  for (const r of rows) counts[r.decision]++;
  return { version, at, by: 'steward:BOARD', rows, counts, holds: rows.filter((r) => r.decision === 'hold').map((r) => r.id) };
}

/** After publish: the next board = every open cell of the published board (carry-over) ⊕ cells already aimed at the next version. */
export function nextBoard(cells: readonly BoardCellIn[], published: string, next: string): { version: string; carried: string[]; fresh: string[] } {
  const carried = cells.filter((c) => isOpen(c) && (!c.deadlineVersion || cmpVersion(c.deadlineVersion, published) <= 0)).map((c) => c.id).sort();
  const fresh = cells.filter((c) => isOpen(c) && c.deadlineVersion && cmpVersion(c.deadlineVersion, published) > 0).map((c) => c.id).sort();
  return { version: next, carried, fresh };
}

/**
 * `idleHands` = idle hands with no open cell of their own (they need supply) · `idleHolding` = idle hands that hold an open
 * cell (11-26 22:43: TC «0 ready / 8 idle» were all of this kind — they need a wake on their own cell, not a split).
 */
export interface SpaceHealth { readonly space: string; readonly ready: number; readonly idleHands: number; readonly hands: number; readonly short: boolean; readonly idleHolding?: number }
export interface Blocked { readonly id: string; readonly on: string }
export interface WipViolation { readonly seat: string; readonly held: number; readonly keep: string; readonly giveBack: readonly string[] }
export interface Health { readonly spaces: readonly SpaceHealth[]; readonly blocked: readonly Blocked[]; readonly wip: readonly WipViolation[] }

/** (3) Health. `waitingOn(cell)` = the seat a cell waits on (verdict/receipt/block) or null when it is active. */
export function boardHealth(input: { cells: readonly BoardCellIn[]; hands: readonly HandIn[]; order: readonly string[]; scopeOf: (s: string) => string;
  waitingOn: (c: BoardCellIn) => string | null; isCoordinator: (s: string) => boolean }): Health {
  const done = new Set(input.cells.filter((c) => c.status === 'green' || c.status === 'done').map((c) => c.id));
  const known = new Set(input.cells.map((c) => c.id));
  const rankOf = (id: string): number => { const i = input.order.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const blocked: Blocked[] = [];
  const readyBy = new Map<string, number>();
  const heldBy = new Map<string, BoardCellIn[]>();
  for (const c of input.cells) {
    if (!isOpen(c) || !isWorkCell(c)) continue;
    const on = input.waitingOn(c);
    if (on) { blocked.push({ id: c.id, on: on.toUpperCase() }); continue; }
    const owner = c.owner?.trim().toUpperCase();
    if (owner && !input.isCoordinator(owner)) { const l = heldBy.get(owner) ?? []; l.push(c); heldBy.set(owner, l); continue; }
    const predsOk = (c.predecessors ?? []).every((p) => done.has(p) || !known.has(p));
    if (c.status === 'yellow' && predsOk) { const s = spaceOf(c, input.scopeOf); readyBy.set(s, (readyBy.get(s) ?? 0) + 1); }
  }
  const spaces = new Set<string>([...readyBy.keys(), ...input.hands.map((h) => h.space.toUpperCase())]);
  const rows: SpaceHealth[] = [...spaces].sort().map((space) => {
    const hs = input.hands.filter((h) => h.space.toUpperCase() === space);
    const idleAll = hs.filter((h) => h.idle);
    const idleHolding = idleAll.filter((h) => heldBy.has(h.seat.toUpperCase())).length;
    const idleHands = idleAll.length - idleHolding; const ready = readyBy.get(space) ?? 0;
    return { space, ready, idleHands, hands: hs.length, short: idleHands > 0 && ready < READY_PER_HAND * idleHands, ...(idleHolding ? { idleHolding } : {}) };
  });
  const wip: WipViolation[] = [...heldBy.entries()].filter(([, l]) => l.length > 1).map(([seat, l]) => {
    const sorted = [...l].sort((a, b) => rankOf(a.id) - rankOf(b.id) || pri(a) - pri(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    return { seat, held: l.length, keep: sorted[0]!.id, giveBack: sorted.slice(1).map((c) => c.id) };
  }).sort((a, b) => b.held - a.held || a.seat.localeCompare(b.seat));
  return { spaces: rows, blocked: blocked.sort((a, b) => a.id.localeCompare(b.id)), wip };
}

/** POOL-PULL-NEEDS-SPEC — open unowned work cells without a done-when, sorted (`eln work next` does not offer them). */
export function needsSpecCells(cells: readonly BoardCellIn[]): string[] {
  return cells.filter((c) => c.status === 'yellow' && isWorkCell(c) && needsSpec(c)).map((c) => c.id).sort();
}

/** The OP line for a needs-spec set (≤ 20 ids named). */
export function needsSpecLine(ids: readonly string[]): string {
  const named = ids.slice(0, 20).join(' · ') + (ids.length > 20 ? ` · +${ids.length - 20} more` : '');
  return `needs-spec ${ids.length}: pool cells without a done-when — hands skip them (eln work next). Set one: eln release checklist set <id> --done "<measurable line>" · ${named}`;
}

export interface Breach { readonly key: string; readonly line: string }

/** Threshold breaches worth an OP card (everything else is only the digest row). */
export function breaches(input: { health: Health; leader: { flagged: boolean; by: string | null }; cut: CutList | null; phaseChanged: boolean }): Breach[] {
  const out: Breach[] = [];
  const short = input.health.spaces.filter((s) => s.short);
  // 11-26 22:4x: «— leaders: split cells» was forwarded as a mail and nothing moved. The OP next-action planner acts on
  // supply itself (rule (c): assign cells with a done-when, record split requests); the card says that, not «mail leaders».
  if (short.length) out.push({ key: `supply:${short.map((s) => s.space).join(',')}`, line: `ready < 2× idle hands in ${short.map((s) => `${s.space} ${s.ready}/${s.idleHands}`).join(' · ')} — the OP planner (c) assigns cells nobody is on and records split requests; do not mail leaders` });
  const holding = input.health.spaces.filter((s) => (s.idleHolding ?? 0) > 0);
  if (holding.length) out.push({ key: `idle-holding:${holding.map((s) => `${s.space}${s.idleHolding}`).join(',')}`, line: `idle hands holding their own open cell: ${holding.map((s) => `${s.space} ${s.idleHolding}`).join(' · ')} — the OP planner (b) wakes each on its cell` });
  const bigWip = input.health.wip.filter((w) => w.held >= 3);
  if (bigWip.length) out.push({ key: `wip:${bigWip.map((w) => w.seat).join(',')}`, line: `WIP-1 broken: ${bigWip.map((w) => `${w.seat} holds ${w.held}`).join(' · ')}` });
  if (input.leader.flagged) out.push({ key: `leader-order:${input.leader.by}`, line: `leader ${input.leader.by} rewrote priority-order — ignored (leaders keep supply only)` });
  if (input.cut?.holds.length) out.push({ key: `cut-hold:${input.cut.version}:${input.cut.holds.join(',')}`, line: `cut ${input.cut.version}: ${input.cut.holds.length} critical yellow on hold (${input.cut.holds.slice(0, 5).join(' · ')})` });
  return out;
}

/** Select pool-scaled candidates before the independent send window; null means the pool could not be measured. */
export function cardCandidates(breach: readonly Breach[], limit: number | null): Breach[] {
  if (limit === null || !Number.isSafeInteger(limit) || limit < 0) return [];
  return breach.slice(0, limit);
}

/** Beacon-style cap: at most cap cards per CARD_WINDOW_MS, never the same key twice in the window. */
export function cardsAllowed(breach: readonly Breach[], sent: ReadonlyArray<{ at: number; key: string }>, now: number, cap: number | null): Breach[] {
  if (cap === null || !Number.isSafeInteger(cap) || cap < 0) return [];
  const recent = sent.filter((s) => now - s.at < CARD_WINDOW_MS);
  const seen = new Set(recent.map((s) => s.key));
  const allowed: Breach[] = [];
  const remaining = Math.max(0, cap - recent.length);
  for (const b of breach) {
    if (allowed.length >= remaining) break;
    if (seen.has(b.key)) continue;
    seen.add(b.key);
    allowed.push(b);
  }
  return allowed;
}

export function digestLine(input: { phase: PulsePhase; version: string; order: readonly string[]; health: Health; cut: CutList | null }): string {
  const sp = input.health.spaces.map((s) => `${s.space} ${s.ready}r/${s.idleHands}i${s.idleHolding ? `+${s.idleHolding}h` : ''}${s.short ? '!' : ''}`).join(' ');
  const cut = input.cut ? ` · cut ${input.cut.counts.ship}s/${input.cut.counts.waive}w/${input.cut.counts.defer}d/${input.cut.counts.hold}h` : '';
  return `[BOARD ${input.version} · ${input.phase}] top ${input.order.slice(0, 3).join(' > ') || '-'} · ${sp || 'no spaces'} · blocked ${input.health.blocked.length} · wip ${input.health.wip.length}${cut}`;
}
