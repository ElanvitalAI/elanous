// WIP1-ASSIGN-GUARD (0.3.38 P0 · OP 11-27 12:10) — a hand holds ONE active cell, on every assign path.
//
// S: measured 12:10 — OP's direct assignments put a new P1 on hands already holding an active P0 → 17 hand ✋
//    «both are mine, set order / reassign» (12 climbed back to OP). The steward and the coordinator CLI stacked the same way.
// C: `eln work next` keeps WIP 1 for a hand's own pull; the push path (seat assign · SeatAssign tool · space/resource
//    steward) did not. Open PR #40171 («hand WIP 1 at every push path») queues at the ledger write but is CONFLICTING and
//    not on main — its `wipHolder` predicate is not reusable yet, so this is the minimal predicate inside seat assign.
// Q: what does an assign onto a busy hand do, without flapping and without asking OP?
// A: (1) the hand holds an active cell of equal or higher priority → refuse «WIP-1: <hand> holds <cell>» and name the top
//    idle hand of the same pool; (2) the new cell is strictly higher (P0 over P1) → allow, and each lower active cell goes
//    back to the board through the veto path (compare-and-set ⊕ history row ⊕ mail = the audit); (3) cells the hand owns
//    but has not touched within the window are stale — they go back to the board the same way so the hand ends at WIP 1.
//    WIP1-ASSIGN-GUARD-ACTIVE (15:5x): (2) only when the lower cell is NOT actively worked (commit · push · worktree edit/test ·
//    ledger activity within wip1.active_recent_min, or the hand's pane busy on it) — else refuse «WIP-1: <hand> actively on <cell>».
//    No flapping: a returned lower cell assigned back to the same hand is refused by (1); equal priority never preempts.
// Policy values: graphs/policies/seat-assign.yaml (wip1 ⊕ takeover). 세 얼굴: 관측 = `seat.assign.refused code=wip-1` ⊕
// `seat.assign.wip-return` log lines ⊕ the veto's history row and mail · 판단 근거 = the held cell ⊕ priorities in the line ·
// 수복과 인계 = the refusal names the idle hand to assign instead; the returned cell is on the board for the next pull.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { pickPoolHand, type HandPoolEntry } from './hand-pool.js';

export interface Wip1Policy { readonly activeWindowMs: number; readonly priorityOrder: readonly string[]; readonly unrankedAs: string;
  /** WIP1-ASSIGN-GUARD-ACTIVE: a lower cell with activity this recent (or a busy pane on it) is never displaced. */
  readonly activeRecentMs: number; readonly activePanes: readonly string[] }
export interface TakeoverPolicy { readonly replyWaitMin: number; readonly staleHours: number; readonly keepBranch: string }
/** POOL-PULL-NEEDS-SPEC: `eln work next` skips unowned cells without a done-when (the board steward lists them to OP). */
export interface PullPolicy { readonly requireDoneWhen: boolean }
export interface SeatAssignPolicy { readonly wip1: Wip1Policy; readonly takeover: TakeoverPolicy; readonly pull: PullPolicy }

export const seatAssignPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'seat-assign.yaml');

const num = (v: unknown, key: string): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`seat-assign policy: ${key} must be a positive number`); return v; };
const strList = (v: unknown, key: string): string[] => { if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`seat-assign policy: ${key} must be a list of strings`); return v as string[]; };
const str = (v: unknown, key: string): string => { if (typeof v !== 'string' || !v.trim()) throw new Error(`seat-assign policy: ${key} must be a string`); return v.trim(); };

/** Parse + validate (pure). A missing or malformed value throws — a broken policy is loud, never silently defaulted. */
export function parseSeatAssignPolicy(text: string): SeatAssignPolicy {
  const y = (parse(text) ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const w = y.wip1 ?? {}, t = y.takeover ?? {}, pl = y.pull ?? {};
  // pull.requireDoneWhen: absent = true (the default behaviour); present and not a boolean = loud.
  if (pl.requireDoneWhen !== undefined && typeof pl.requireDoneWhen !== 'boolean') throw new Error('seat-assign policy: pull.requireDoneWhen must be true or false');
  const order = w.priority_order;
  if (!Array.isArray(order) || !order.length || order.some(p => typeof p !== 'string')) throw new Error('seat-assign policy: wip1.priority_order must be a list of priorities');
  const priorityOrder = (order as string[]).map(p => p.trim().toUpperCase());
  const unrankedAs = str(w.unranked_as, 'wip1.unranked_as').toUpperCase();
  if (!priorityOrder.includes(unrankedAs)) throw new Error('seat-assign policy: wip1.unranked_as must be one of wip1.priority_order');
  return {
    wip1: { activeWindowMs: num(w.active_window_min, 'wip1.active_window_min') * 60_000, priorityOrder, unrankedAs,
      activeRecentMs: num(w.active_recent_min, 'wip1.active_recent_min') * 60_000, activePanes: strList(w.active_panes, 'wip1.active_panes').map(p => p.toUpperCase()) },
    takeover: { replyWaitMin: num(t.reply_wait_min, 'takeover.reply_wait_min'), staleHours: num(t.stale_hours, 'takeover.stale_hours'), keepBranch: str(t.keep_branch, 'takeover.keep_branch') },
    pull: { requireDoneWhen: pl.requireDoneWhen !== false },
  };
}

let cached: { path: string; policy: SeatAssignPolicy } | null = null;
export function loadSeatAssignPolicy(path = seatAssignPolicyPath()): SeatAssignPolicy {
  if (cached?.path === path) return cached.policy;
  if (!existsSync(path)) throw new Error(`seat-assign policy missing: ${path}`);
  const policy = parseSeatAssignPolicy(readFileSync(path, 'utf8'));
  cached = { path, policy };
  return policy;
}

/** POOL-PULL-NEEDS-SPEC — `pull.requireDoneWhen` of the shipped policy; an unreadable policy keeps the default (true). */
export function livePullRequiresDoneWhen(): boolean {
  try { return loadSeatAssignPolicy().pull.requireDoneWhen; } catch { return true; }
}

/** The uncommitted-WIP takeover rule — one sentence every coordinator prompt and writer answer uses (OPS-RULES 11-27). */
export function wipTakeoverRule(p: TakeoverPolicy): string {
  return `Someone else's uncommitted WIP blocking a cell: send its owner one line → no reply in ${p.replyWaitMin} min → keep a preservation copy `
    + `(branch ${p.keepBranch}, or \`git stash push -u -m <tag>\` with the stash SHA recorded) → take it over. WIP untouched for ${p.staleHours} h: `
    + 'take it over at once the same way. Reading and copying WIP is always allowed — never answer «preserve the existing WIP, do not touch it».';
}

/** The rule from the policy file; a broken file names itself instead of a rule (the prompt still renders). */
export function liveWipTakeoverRule(): string {
  try { return wipTakeoverRule(loadSeatAssignPolicy().takeover); }
  catch (error) { return `Uncommitted-WIP takeover rule: see graphs/policies/seat-assign.yaml (unreadable: ${String(error).slice(0, 80)}).`; }
}

const ownerSeat = (owner: string | undefined): string => (owner ?? '').split('/')[0]!.trim().toUpperCase();

/** Rank of a priority (0 = highest). */
export function priorityRank(priority: string | undefined, p: Wip1Policy): number {
  const at = p.priorityOrder.indexOf((priority ?? p.unrankedAs).toUpperCase());
  return at >= 0 ? at : p.priorityOrder.indexOf(p.unrankedAs);
}

export type HeldCell = Pick<ChecklistItem, 'id' | 'status' | 'owner' | 'priority' | 'updatedAt'>;

export type Wip1Decision =
  | { readonly kind: 'clear'; readonly stale: readonly HeldCell[] }
  | { readonly kind: 'refuse'; readonly holder: HeldCell; readonly suggest?: string; readonly line: string; readonly why: 'holds' | 'actively-on' }
  | { readonly kind: 'preempt'; readonly returns: readonly HeldCell[]; readonly stale: readonly HeldCell[] };

/**
 * The WIP-1 decision for `seat` taking `cell` (pure). `held` = cells of the ledger; `pool` = the hand pool view (the
 * hand's working cell counts as active even if the ledger row is old).
 */
/** Latest outside activity on a cell (commit · push · worktree edit/test) since a time, with what it was. null = none seen. */
export type CellActivity = (cellId: string, sinceMs: number) => { readonly atMs: number; readonly signal: string } | null;

/**
 * WIP1-SUGGEST-IDLE (OP 11-27 16:3x · WIP-1 suggested TC-H-POOL-3 while it held an active P0): the hands a suggestion or a
 * POOL pick may name — zero active cells by the guard's own definition: the pool view says idle, its pane is not busy
 * (wip1.active_panes), and it owns no yellow cell touched within wip1.active_window_min.
 */
export function freeHands(pool: readonly HandPoolEntry[], held: readonly HeldCell[], nowMs: number, policy: Wip1Policy): HandPoolEntry[] {
  return pool.filter(e => {
    if (e.state !== 'idle') return false;
    if (e.pane && policy.activePanes.includes(e.pane.toUpperCase())) return false;
    const id = e.seat.trim().toUpperCase();
    return !held.some(c => c.status === 'yellow' && ownerSeat(c.owner) === id && Number.isFinite(Date.parse(c.updatedAt)) && nowMs - Date.parse(c.updatedAt) <= policy.activeWindowMs);
  });
}

/** The «nobody free» line: the cell is not pushed onto a busy hand. */
export const noIdleHandLine = (cellId: string): string => `no idle hand — ${cellId} stays on the board for pull`;

export function wip1Decide(input: { readonly seat: string; readonly cell: Pick<ChecklistItem, 'id' | 'priority'>; readonly held: readonly HeldCell[];
  readonly pool: readonly HandPoolEntry[]; readonly nowMs: number; readonly policy: Wip1Policy;
  /** WIP1-ASSIGN-GUARD-ACTIVE: absent = only the ledger and the pane count. A throw = «unknown» = actively worked (kept). */
  readonly activity?: CellActivity }): Wip1Decision {
  const seat = input.seat.trim().toUpperCase();
  const mine = input.held.filter(c => c.id !== input.cell.id && c.status === 'yellow' && ownerSeat(c.owner) === seat);
  const entry = input.pool.find(e => e.seat.toUpperCase() === seat);
  const isActive = (c: HeldCell): boolean => {
    const age = input.nowMs - Date.parse(c.updatedAt);
    return (Number.isFinite(age) && age <= input.policy.activeWindowMs) || (entry?.state === 'working' && entry.cell === c.id);
  };
  const active = mine.filter(isActive);
  const stale = mine.filter(c => !isActive(c));
  if (!active.length) return { kind: 'clear', stale };
  const newRank = priorityRank(input.cell.priority, input.policy);
  const blocking = active.filter(c => priorityRank(c.priority, input.policy) <= newRank)
    .sort((a, b) => priorityRank(a.priority, input.policy) - priorityRank(b.priority, input.policy))[0];
  const pick = pickPoolHand(freeHands(input.pool.filter(e => e.seat.toUpperCase() !== seat), input.held, input.nowMs, input.policy), entry?.home ?? seat);
  const prio = (c: { priority?: string }) => (c.priority ?? input.policy.unrankedAs).toUpperCase();
  const tail = (_holder: HeldCell) => pick ? `suggest ${pick.seat} (idle · ${pick.home} pool): eln seat assign ${pick.seat} ${input.cell.id}`
    : noIdleHandLine(input.cell.id);
  if (blocking) {
    const line = `WIP-1: ${seat} holds ${blocking.id} (${prio(blocking)}) — ${input.cell.id} (${prio(input.cell)}) not stacked; ${tail(blocking)}`;
    return { kind: 'refuse', holder: blocking, ...(pick ? { suggest: pick.seat } : {}), line, why: 'holds' };
  }
  // WIP1-ASSIGN-GUARD-ACTIVE: a strictly higher cell displaces a lower one only when nobody is working on it right now.
  const since = input.nowMs - input.policy.activeRecentMs;
  const workedBy = (c: HeldCell): string | null => {
    if (entry?.cell === c.id && entry.pane && input.policy.activePanes.includes(entry.pane.toUpperCase())) return `pane ${entry.pane.toUpperCase()}`;
    const ledger = Date.parse(c.updatedAt);
    if (Number.isFinite(ledger) && ledger >= since) return `ledger ${Math.max(0, Math.round((input.nowMs - ledger) / 60_000))}m ago`;
    let seen: ReturnType<CellActivity> = null;
    try { seen = input.activity?.(c.id, since) ?? null; } catch { return 'activity check unavailable'; }
    return seen && seen.atMs >= since ? `${seen.signal} ${Math.max(0, Math.round((input.nowMs - seen.atMs) / 60_000))}m ago` : null;
  };
  for (const c of active) {
    const signal = workedBy(c);
    if (!signal) continue;
    const line = `WIP-1: ${seat} actively on ${c.id} (${prio(c)} · ${signal}) — ${input.cell.id} (${prio(input.cell)}) does not displace it; ${tail(c)}`;
    return { kind: 'refuse', holder: c, ...(pick ? { suggest: pick.seat } : {}), line, why: 'actively-on' };
  }
  return { kind: 'preempt', returns: active, stale };
}
