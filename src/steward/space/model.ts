// STEWARD-SPACE (행정관) — the pure core. One instance per coordinator scope (`steward:<scope>`): it sees only its scope's
// seats, cells (owner = the coordinator or its hands) and PRs (author in scope), plans rows and never talks to another
// loop. Rows a scope cannot resolve (no free hand, needs another kingdom) are `escalate` rows kept in its own ledger; the
// HQ instance reads them and does the cross-scope matching (lend an idle hand of one scope to another's backlog).
//
// 세 얼굴:
//   관측 = every planned/done row in `<state>/steward/space/<scope>/ledger.jsonl` ⊕ graph run outputs ⊕ `eln steward space status`
//   판단 근거 = rules only (no LLM): idle ≥ 10 min (an idle owner of a yellow cell is woken there, never reassigned) · yellow P0/P1 stalled ≥ 2 h · same-head receipt · verdict files · caps
//   수복과 인계 = one batched exception card per tick to the scope's coordinator (≤ 10 lines + count) · only refused /
//               ambiguous rows are exceptions; «no free hand» / «over the cap» is capacity → `defer` (11-25 15:37 flood:
//               64+45+32 escalate rows in one shadow tick were capacity, not decisions)

import { isJudgeRole } from '../../seat/hand-pool.js';
import { cellWaitOf } from './cell-wait.js';
import { STEWARD_SPACE_DEFAULTS as D, STEWARD_SPACE_FORBIDDEN_HOSTS, type ResolvedScope, type StewardSpaceProfile } from './config.js';

export interface SeatView {
  readonly seat: string;
  /** els activityState: working · idle · blocked · exited · done · unknown. */
  readonly activity: string;
  /** How long the pane has been quiet; null = unknown (never counted as idle). */
  readonly idleForMs: number | null;
  /** The seat's last real activity (model row, or a long continuous els WORKING) — activity.ts; absent = els clock only. */
  readonly lastActiveMs?: number;
}

export interface CellView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner?: string;
  readonly priority?: string;
  readonly updatedAt: string;
}

export interface PrView {
  readonly number: number;
  readonly head: string;
  readonly branch: string;
  readonly title: string;
  readonly draft: boolean;
  readonly updatedAt: string;
  readonly files?: readonly string[];
}

export interface ReceiptView { readonly pr: number; readonly head12: string; readonly host: string; readonly status: string; readonly atMs: number }
export interface VerdictView { readonly pr: number; readonly head12: string; readonly kind: 'jud' | 'judb' | 'hold'; readonly verdict: string; readonly atMs: number }
export interface HostView { readonly host: string; readonly load1: number | null; readonly ncpu: number | null; readonly stopped: boolean }
export interface MergedView { readonly number: number; readonly branch: string; readonly mergedAtMs: number }
/** An open ✋: `sender` raised (or forwarded) it, `blockedSeat` is waiting on its outcome — neither is woken meanwhile. */
export interface OpenHandView { readonly receiver: string; readonly waitedMs: number; readonly sender?: string; readonly blockedSeat?: string }

export interface Snapshot {
  readonly nowMs: number;
  readonly hq: string;
  /** Coordinator seats (depth 2 on the federation ladder) that have at least one known seat. */
  readonly coordinators: readonly string[];
  /** seat → its coordinator (or hq), for every known seat. */
  readonly parent: Readonly<Record<string, string>>;
  readonly seats: readonly SeatView[];
  readonly version: string;
  readonly cells: readonly CellView[];
  readonly prs: readonly PrView[];
  readonly merged: readonly MergedView[];
  readonly receipts: readonly ReceiptView[];
  readonly verdicts: readonly VerdictView[];
  readonly hosts: readonly HostView[];
  /** Age of the UTIL snapshot; null = none (every host closed). */
  readonly utilAgeMs: number | null;
  readonly openHands: readonly OpenHandView[];
  /** seat → its latest `eln work next` call (epoch ms). A hand that pulled is not woken. */
  readonly pulls?: Readonly<Record<string, number>>;
  /** SHARED-WAKE-LEDGER: seat → the last wake by ANY waker inside the 20-min window. */
  readonly wakes?: Readonly<Record<string, { readonly by: string; readonly atMs: number }>>;
  /** federation.yaml seat roles (seat → role) — absent = prefix rules only. */
  readonly roles?: Readonly<Record<string, string>>;
  readonly sourceErrors: readonly string[];
}

export type RowAction = 'reclaim' | 'wake' | 'assign' | 'dispatch' | 'judge-assign' | 'handoff' | 'watch' | 'digest' | 'escalate' | 'reject' | 'ambiguous' | 'defer';

export interface Row {
  readonly node: string;
  readonly scope: string;
  readonly action: RowAction;
  /** cell id · `#PR` · seat. */
  readonly target: string;
  readonly reason: string;
  readonly seat?: string;
  readonly host?: string;
  readonly head12?: string;
  readonly lentFrom?: string;
  /** reclaim: the cell's owner exactly as the ledger holds it (the compare-and-set expectation). */
  readonly owner?: string;
  readonly priority?: string;
  /** shadow = «would do» only · live = executed (see `done`). */
  readonly mode: 'shadow' | 'live';
  readonly done?: boolean;
  readonly error?: string;
}

export interface ScopeState {
  assigned: Record<string, { seat: string; at: string }>;
  seatCooldown: Record<string, string>;
  dispatched: Record<string, { head12: string; host: string; at: string; seat?: string }>;
  judgeAssigned: Record<string, { seat: string; at: string }>;
  cards: Record<string, string>;
  /** WAKE-OWNER: seat → last steward wake (cell · count of wakes with no activity since the first of them). */
  woken?: Record<string, { at: string; cell: string; count: number }>;
  lastDigestAt?: string;
  /** `escalations` = this tick's exception rows (reject · ambiguous · escalate) · `wanting` = cells left without a hand,
   *  which HQ may cover by lending an idle hand of another scope. */
  lastTick?: { at: string; runId: string; counts: Record<string, number>; idleLeft: string[]; escalations: Row[]; wanting?: string[]; rollup: string };
}

export const emptyScopeState = (): ScopeState => ({ assigned: {}, seatCooldown: {}, dispatched: {}, judgeAssigned: {}, cards: {} });

const MIN = 60_000;
const ageMs = (iso: string | undefined, now: number): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
};
const within = (iso: string | undefined, now: number, minutes: number): boolean => ageMs(iso, now) < minutes * MIN;

// ── scope membership ───────────────────────────────────────────────────────────────────────────

/** A seat's scope: the HQ seat and each coordinator are their own scope; a hand belongs to its coordinator; an unknown
 *  seat belongs to HQ (the ladder's default parent). */
export function scopeOf(snap: Pick<Snapshot, 'hq' | 'coordinators' | 'parent'>, seat: string | undefined): string {
  const s = (seat ?? '').trim().toUpperCase();
  if (!s) return snap.hq;
  if (s === snap.hq || snap.coordinators.includes(s)) return s;
  const parent = snap.parent[s];
  return parent && (parent === snap.hq || snap.coordinators.includes(parent)) ? parent : snap.hq;
}

/** Every scope this snapshot knows: sub-coordinators first (sorted), HQ last — HQ reads their escalations. */
export function scopesOf(snap: Pick<Snapshot, 'hq' | 'coordinators'>): string[] {
  return [...[...snap.coordinators].filter((c) => c !== snap.hq).sort(), snap.hq];
}

/** The PR's author seat from its branch prefix (`tc-h-cx-6/…` → TC-H-CX-6) when that is a known seat. */
export function authorOfBranch(branch: string, knownSeats: ReadonlySet<string>): string | null {
  const head = branch.split('/')[0]?.trim().toUpperCase() ?? '';
  return branch.includes('/') && knownSeats.has(head) ? head : null;
}

export function knownSeatsOf(snap: Pick<Snapshot, 'parent' | 'seats' | 'coordinators' | 'hq'>): Set<string> {
  return new Set([...Object.keys(snap.parent), ...snap.seats.map((s) => s.seat), ...snap.coordinators, snap.hq]);
}

export function prScope(snap: Snapshot, pr: Pick<PrView, 'branch'>, known = knownSeatsOf(snap)): { scope: string; author: string | null } {
  const author = authorOfBranch(pr.branch, known);
  return { scope: scopeOf(snap, author ?? undefined), author };
}

/** Maker ≠ judge by role (federation.yaml role · judiciary id · judiciary coordinator) — {@link isJudgeRole}. */
export const judgeSide = (snap: Pick<Snapshot, 'parent' | 'roles'>, seat: string): boolean =>
  isJudgeRole(seat, { parentOf: (s) => snap.parent[s] ?? '', roleOf: (s) => snap.roles?.[s] });
/** A cell is judge work when its owner (coordinator or hand) is on the judge side; unowned cells are maker work. */
export const judgeCell = (snap: Pick<Snapshot, 'parent' | 'roles'>, cell: Pick<CellView, 'owner'>): boolean => {
  const owner = (cell.owner ?? '').split('/')[0]!.trim().toUpperCase();
  return !!owner && owner !== '-' && owner !== 'NONE' && judgeSide(snap, owner);
};

const isHand = (snap: Snapshot, seat: string): boolean => seat !== snap.hq && !snap.coordinators.includes(seat);

/** Idle hands of a scope, longest idle first. */
export function idleHands(snap: Snapshot, scope: string, state: ScopeState): SeatView[] {
  return snap.seats
    .filter((s) => isHand(snap, s.seat) && scopeOf(snap, s.seat) === scope)
    .filter((s) => s.activity === 'idle' && s.idleForMs !== null && s.idleForMs >= D.idleMinMinutes * MIN)
    .filter((s) => !within(state.seatCooldown[s.seat], snap.nowMs, D.cooldownMinutes))
    .sort((a, b) => (b.idleForMs ?? 0) - (a.idleForMs ?? 0) || a.seat.localeCompare(b.seat));
}

const UNOWNED = (owner: string | undefined): boolean => !owner || owner === '-' || owner.toLowerCase() === 'none';
const ownerSeat = (owner: string | undefined): string => (owner ?? '').split('/')[0]!.trim().toUpperCase();
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1 };

/** Yellow P0/P1 cells this scope must move: unowned cells belong to HQ; an owned cell belongs to its owner's scope and
 *  is movable once untouched ≥ 2 h while its owner is not working. */
export function movableCells(snap: Snapshot, scope: string, state: ScopeState): CellView[] {
  const working = new Set(snap.seats.filter((s) => s.activity === 'working').map((s) => s.seat));
  return snap.cells
    .filter((c) => c.status === 'yellow' && c.priority !== undefined && c.priority in PRIORITY_RANK)
    .filter((c) => !within(state.assigned[c.id]?.at, snap.nowMs, D.cooldownMinutes))
    .filter((c) => {
      if (UNOWNED(c.owner)) return scope === snap.hq;
      const owner = ownerSeat(c.owner);
      // A coordinator is always «working» on coordination; its held cells move on age alone.
      return scopeOf(snap, owner) === scope && (!working.has(owner) || !isHand(snap, owner)) && ageMs(c.updatedAt, snap.nowMs) >= D.stallMinutes * MIN;
    })
    .sort(cellOrder);
}

/** P0 before P1, then the longest untouched, then id. */
function cellOrder(a: CellView, b: CellView): number {
  return (PRIORITY_RANK[a.priority ?? ''] ?? 9) - (PRIORITY_RANK[b.priority ?? ''] ?? 9) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id);
}

// ── R1 lease ⊕ reclaim (PULL default · 대표 11-25 17:1x) ────────────────────────────────────────

/** An owned yellow cell is leased to its owner this long past the owner's last activity. */
export const LEASE_MINUTES = 45;
/** Reclaims per scope per tick. */
export const RECLAIM_PER_TICK = 8;

/** Push (assign) only these — everything else waits on the board for `eln work next`. */
export const isPushCell = (cell: Pick<CellView, 'id' | 'priority'>): boolean => cell.priority === 'P0' || /DEMO/i.test(cell.id);

/** leaseUntil = the latest of: the cell's last change (a claim sets it), the owner's last activity (model row · continuous
 *  els WORKING), the owner's PR pushes and pregate receipts — plus {@link LEASE_MINUTES}. */
export function leaseUntilMs(snap: Snapshot, cell: CellView, known = knownSeatsOf(snap)): number {
  const owner = ownerSeat(cell.owner);
  const seat = snap.seats.find((s) => s.seat === owner);
  const prs = snap.prs.filter((pr) => authorOfBranch(pr.branch, known) === owner);
  const stamps = [
    Date.parse(cell.updatedAt),
    seat?.lastActiveMs ?? (seat?.activity === 'idle' && seat.idleForMs !== null ? snap.nowMs - seat.idleForMs : NaN),
    seat?.activity === 'working' ? snap.nowMs : NaN,
    ...prs.map((pr) => Date.parse(pr.updatedAt)),
    ...snap.receipts.filter((r) => prs.some((pr) => pr.number === r.pr)).map((r) => r.atMs),
  ].filter((t) => Number.isFinite(t));
  return (stamps.length ? Math.max(...stamps) : 0) + LEASE_MINUTES * MIN;
}

/** Hand-owned yellow cells of this scope whose lease ran out → back to the board (owner cleared, history kept). */
export function planReclaim(snap: Snapshot, input: { scope: ResolvedScope }): Row[] {
  const { scope } = input;
  const mode = scope.mode === 'live' ? 'live' : 'shadow';
  const known = knownSeatsOf(snap);
  return snap.cells
    .filter((c) => c.status === 'yellow' && !UNOWNED(c.owner))
    .map((c) => ({ c, owner: ownerSeat(c.owner), until: leaseUntilMs(snap, c, known) }))
    .filter(({ owner, until }) => isHand(snap, owner) && scopeOf(snap, owner) === scope.scope && until < snap.nowMs)
    .sort((a, b) => a.until - b.until || a.c.id.localeCompare(b.c.id))
    .slice(0, RECLAIM_PER_TICK)
    .map(({ c, owner, until }) => ({ node: 'r1', scope: scope.scope, action: 'reclaim' as const, target: c.id, seat: owner, owner: c.owner!, priority: c.priority, mode,
      reason: `lease-expired:${Math.floor((snap.nowMs - until) / MIN)}m` }));
}

// ── R1 wake (idle owner) ───────────────────────────────────────────────────────────────────────

/** WAKE-OWNER (11-25 16:4x · TC live «defer 26 · idle 10», 0 assigned): an idle hand that owns a yellow cell is woken on
 *  that cell, never re-offered as a free hand. Not again within this many minutes. */
export const WAKE_COOLDOWN_MINUTES = 20;
/** Wakes in a row with no activity after which the hand is an exception line («not responding to wake»), not woken. */
export const WAKE_MAX_UNANSWERED = 3;

/** A woken seat answered once it worked, or once its pane re-entered idle after the wake (a turn ran in between). */
export function wakeAnswered(seat: SeatView | undefined, wokeAt: string, nowMs: number): boolean {
  if (!seat) return false;
  if (seat.activity === 'working') return true;
  return seat.activity === 'idle' && seat.idleForMs !== null && seat.idleForMs < ageMs(wokeAt, nowMs);
}

export interface WakePlan {
  readonly rows: Row[];
  /** Idle hands that own a yellow cell — never free hands this tick. */
  readonly owners: ReadonlySet<string>;
  /** Cells of owners woken now, in wake cooldown, waiting on a ✋ or over the cap — not reassigned this tick. */
  readonly held: ReadonlySet<string>;
  /** seat → wake count after this tick's wake (1 = first wake since the hand last answered). */
  readonly counts: Readonly<Record<string, number>>;
  /** Seats whose stored wake was answered — the tick drops them from `state.woken`. */
  readonly answered: readonly string[];
  /** «take work next» nudges for hands with no active cell — planMatch emits them AFTER the P0/demo push, only for
   *  hands the push did not use (a P0 push beats a pull nudge). */
  readonly nudges: readonly Row[];
}

export function planWake(snap: Snapshot, input: { scope: ResolvedScope; state: ScopeState; reclaimed?: ReadonlySet<string> }): WakePlan {
  const { scope, state } = input;
  const reclaimed = input.reclaimed ?? new Set<string>();
  // A free hand is nudged to pull only when the board has something to pull. The board = unowned · reclaimed · held by
  // this scope's own coordinator (rail 30: leader-owned yellow cells are claimable by its hands) — and not waiting.
  const waitOf = (id: string) => cellWaitOf(id, snap);
  const board = snap.cells.some((c) => c.status === 'yellow' && (UNOWNED(c.owner) || reclaimed.has(c.id) || ownerSeat(c.owner) === scope.scope) && !waitOf(c.id));
  const mode = scope.mode === 'live' ? 'live' : 'shadow';
  const rows: Row[] = [];
  const nudges: Row[] = [];
  const owners = new Set<string>();
  const held = new Set<string>();
  const counts: Record<string, number> = {};
  const seats = new Map(snap.seats.map((s) => [s.seat, s]));
  const answered = Object.entries(state.woken ?? {}).filter(([seat, w]) => wakeAnswered(seats.get(seat), w.at, snap.nowMs)).map(([seat]) => seat);
  const waiting = new Set(snap.openHands.flatMap((h) => [h.sender, h.blockedSeat]).filter((s): s is string => !!s).map((s) => s.trim().toUpperCase()));
  let budget = scope.caps.assign;
  for (const hand of idleHands(snap, scope.scope, state)) {
    const owned = snap.cells.filter((c) => c.status === 'yellow' && !UNOWNED(c.owner) && !reclaimed.has(c.id) && ownerSeat(c.owner) === hand.seat).sort(cellOrder);
    // Waiting cells (JUD verdict · RES receipt · HOLD · train) are not work: a hand whose every cell waits is woken with
    // «take work next», never on its own cell (rail 30: woken on a waiting cell → idle again right away).
    const own = owned.filter((c) => !waitOf(c.id));
    const allWaiting = owned.length > 0 && own.length === 0;
    for (const c of owned) if (waitOf(c.id)) held.add(c.id);
    // PULL default: a hand that called `eln work next` since it went idle is not woken (it pulled; an empty board is fine).
    const pulledAt = snap.pulls?.[hand.seat];
    const pulled = pulledAt !== undefined && snap.nowMs - pulledAt <= (hand.idleForMs ?? 0);
    if (!own.length) {
      // A free hand: nudge it to pull, never push a cell at it (push stays for P0/demo cells below).
      if (pulled || !board) continue;
    } else owners.add(hand.seat);
    const cell = own[0];
    const hold = (): void => { for (const c of own) held.add(c.id); };
    const prior = answered.includes(hand.seat) ? undefined : state.woken?.[hand.seat];
    const base = { node: 'r1', scope: scope.scope, target: cell?.id ?? hand.seat, seat: hand.seat, ...(cell?.priority ? { priority: cell.priority } : {}), mode } as const;
    if (pulled) { hold(); continue; }
    if (waiting.has(hand.seat)) { hold(); rows.push({ ...base, action: 'defer', reason: 'wake-skip:open-hand' }); continue; }
    const other = snap.wakes?.[hand.seat];
    if (other && other.by !== `steward:${scope.scope}` && snap.nowMs - other.atMs < WAKE_COOLDOWN_MINUTES * MIN) {
      hold(); rows.push({ ...base, action: 'defer', reason: `already-woken:${other.by}@${new Date(other.atMs).toISOString().slice(11, 16)}Z` }); continue;
    }
    if (prior && within(prior.at, snap.nowMs, WAKE_COOLDOWN_MINUTES)) { hold(); rows.push({ ...base, action: 'defer', reason: 'wake-cooldown' }); continue; }
    if (prior && prior.count >= WAKE_MAX_UNANSWERED) {
      // Its cells stay movable (the 2 h stall rule hands them to a free hand); the hand itself is not offered as free.
      rows.push({ ...base, action: 'ambiguous', target: hand.seat, reason: `wake-not-answered:${prior.count}x` });
      continue;
    }
    hold();
    if (budget <= 0) { rows.push({ ...base, action: 'defer', reason: 'wake-tick-cap' }); continue; }
    budget--;
    counts[hand.seat] = (prior?.count ?? 0) + 1;
    (cell ? rows : nudges).push({ ...base, action: 'wake', reason: `${cell ? 'idle-owner' : allWaiting ? 'idle-all-waiting' : 'idle-no-pull'}:${Math.floor((hand.idleForMs ?? 0) / MIN)}m` });
  }
  return { rows, owners, held, counts, answered, nudges };
}

// ── R1 match ───────────────────────────────────────────────────────────────────────────────────

export interface MatchInput {
  readonly scope: ResolvedScope;
  readonly state: ScopeState;
  /** HQ only: cells the sub-scopes could not staff (ids) and idle hands they could not use. */
  readonly wanting?: readonly string[];
  readonly lendable?: readonly { seat: string; from: string }[];
}

/** Rows ⊕ idle hands left over ⊕ cells left without a hand (capacity — `defer`, never an exception row). */
export function planMatch(snap: Snapshot, input: MatchInput): { rows: Row[]; idleLeft: string[]; wanting: string[]; wake: WakePlan } {
  const { scope, state } = input;
  const mode = scope.mode === 'live' ? 'live' : 'shadow';
  // Idle owners first: woken on their own cell, never free hands; their held cells are not reassigned this tick.
  // PULL default (대표 11-25 17:1x): leases that ran out go back to the board first; R1 is the safety net — it wakes idle
  // hands that did not pull and pushes only P0/demo cells (and HQ's cross-scope lending of those).
  const reclaim = planReclaim(snap, { scope });
  const reclaimed = new Set(reclaim.map((r) => r.target));
  const wake = planWake(snap, { scope, state, reclaimed });
  const rows: Row[] = [...reclaim, ...wake.rows];
  const woken = new Set(wake.rows.filter((r) => r.action === 'wake').map((r) => r.seat));
  const hands = idleHands(snap, scope.scope, state).filter((s) => !wake.owners.has(s.seat) && !woken.has(s.seat)).map((s) => ({ seat: s.seat, from: undefined as string | undefined }));
  const cells = movableCells(snap, scope.scope, state).filter((c) => !wake.held.has(c.id) && !reclaimed.has(c.id) && isPushCell(c));
  if (scope.scope === snap.hq) {
    const byId = new Map(snap.cells.map((c) => [c.id, c]));
    for (const id of input.wanting ?? []) {
      const cell = byId.get(id);
      if (cell && cell.status === 'yellow' && isPushCell(cell) && !wake.held.has(cell.id) && !cells.some((c) => c.id === cell.id)) cells.push(cell);
    }
    for (const lend of input.lendable ?? []) if (!hands.some((h) => h.seat === lend.seat)) hands.push({ seat: lend.seat, from: lend.from });
    cells.sort(cellOrder);
  }
  let budget = scope.caps.assign;
  const wanting: string[] = [];
  for (const cell of cells) {
    if (budget <= 0) { rows.push({ node: 'r1', scope: scope.scope, action: 'defer', target: cell.id, reason: 'tick-cap', priority: cell.priority, mode }); continue; }
    // An idle owner gets its own stalled cell back first (a reminder, not a reassignment).
    const own = ownerSeat(cell.owner);
    // Maker ≠ judge (RX-1..4 · 11-25: JUD-B / JUD-3 proposed for implementation cells): only same-side hands qualify.
    const side = judgeCell(snap, cell);
    const fits = (h: { seat: string }): boolean => judgeSide(snap, h.seat) === side;
    let index = hands.findIndex((h) => h.seat === own && fits(h));
    if (index < 0) index = hands.findIndex((h) => h.from === undefined && fits(h));
    if (index < 0) index = hands.findIndex(fits);
    if (index < 0) {
      // Capacity, not a decision: the cell waits for the next idle hand (HQ sees it as `wanting` and may lend one).
      rows.push({ node: 'r1', scope: scope.scope, action: 'defer', target: cell.id, reason: scope.scope === snap.hq ? 'no-idle-hand-anywhere' : 'no-hand-in-scope', priority: cell.priority, mode });
      wanting.push(cell.id);
      continue;
    }
    const [hand] = hands.splice(index, 1);
    budget--;
    rows.push({ node: 'r1', scope: scope.scope, action: 'assign', target: cell.id, seat: hand!.seat, priority: cell.priority, mode,
      reason: UNOWNED(cell.owner) ? 'unowned' : own === hand!.seat ? 'own-stalled' : `stalled-from:${own}`,
      ...(hand!.from ? { lentFrom: hand!.from } : {}) });
  }
  // Pull nudges go only to hands the push did not take; a nudged hand is not lent to another scope this tick.
  const assigned = new Set(rows.filter((r) => r.action === 'assign').map((r) => r.seat));
  const nudged = wake.nudges.filter((r) => !assigned.has(r.seat));
  rows.push(...nudged);
  const nudgedSeats = new Set(nudged.map((r) => r.seat));
  return { rows, idleLeft: hands.filter((h) => h.from === undefined && !nudgedSeats.has(h.seat)).map((h) => h.seat), wanting, wake };
}

// ── R2 receipt ─────────────────────────────────────────────────────────────────────────────────

export interface ReceiptInput {
  readonly scope: ResolvedScope;
  readonly state: ScopeState;
  readonly hosts: readonly string[];
  readonly hostSlots: number;
  readonly maxLoadPerCore: number;
  /** `<pr>-<head12>` already dispatched by any steward (global marker) — never twice. */
  readonly dispatchedAnywhere: ReadonlySet<string>;
  /** Steward pregates still running per host (any scope). */
  readonly inflightByHost: ReadonlyMap<string, number>;
}

export const hasReceipt = (snap: Snapshot, pr: number, head12: string): boolean => snap.receipts.some((r) => r.pr === pr && r.head12 === head12);

/** Hosts open for a new pregate: pre-approved, never HQ, measured within the UTIL window, below the load cap. */
export function openHosts(snap: Snapshot, input: Pick<ReceiptInput, 'hosts' | 'hostSlots' | 'maxLoadPerCore' | 'inflightByHost'>): string[] {
  if (snap.utilAgeMs === null || snap.utilAgeMs > D.utilMaxAgeMinutes * MIN) return [];
  return input.hosts.filter((host) => !STEWARD_SPACE_FORBIDDEN_HOSTS.has(host)).filter((host) => {
    const view = snap.hosts.find((h) => h.host === host);
    if (!view || view.stopped || view.load1 === null || !view.ncpu) return false;
    return view.load1 / view.ncpu <= input.maxLoadPerCore && (input.inflightByHost.get(host) ?? 0) < input.hostSlots;
  }).sort((a, b) => {
    const la = snap.hosts.find((h) => h.host === a)!; const lb = snap.hosts.find((h) => h.host === b)!;
    return la.load1! / la.ncpu! - lb.load1! / lb.ncpu! || a.localeCompare(b);
  });
}

export function planReceipts(snap: Snapshot, input: ReceiptInput): Row[] {
  const { scope } = input;
  const mode = scope.mode === 'live' ? 'live' : 'shadow';
  const known = knownSeatsOf(snap);
  const rows: Row[] = [];
  const inflight = new Map(input.inflightByHost);
  let budget = scope.caps.pregate;
  const wanting = snap.prs.filter((pr) => !pr.draft && prScope(snap, pr, known).scope === scope.scope)
    .filter((pr) => !hasReceipt(snap, pr.number, pr.head.slice(0, 12)))
    .filter((pr) => !input.dispatchedAnywhere.has(`${pr.number}-${pr.head.slice(0, 12)}`))
    .sort((a, b) => a.number - b.number);
  for (const pr of wanting) {
    const head12 = pr.head.slice(0, 12);
    const target = `#${pr.number}`;
    if (budget <= 0) { rows.push({ node: 'r2', scope: scope.scope, action: 'defer', target, head12, reason: 'tick-cap', mode }); continue; }
    const host = openHosts(snap, { ...input, inflightByHost: inflight })[0];
    if (!host) { rows.push({ node: 'r2', scope: scope.scope, action: 'defer', target, head12, reason: 'no-host-slot', mode }); continue; }
    inflight.set(host, (inflight.get(host) ?? 0) + 1);
    budget--;
    const author = prScope(snap, pr, known).author;
    rows.push({ node: 'r2', scope: scope.scope, action: 'dispatch', target, head12, host, reason: 'no-same-head-receipt', mode, ...(author ? { seat: author } : {}) });
  }
  return rows;
}

// ── R3 judge ───────────────────────────────────────────────────────────────────────────────────

const GREEN = /PASS/;
/** The four security classes that still need a security verdict (OPS 11-23 완화 — 비밀·자격 · members · 원격 노출). */
const SECURITY_PATH = /^(src\/oauth\/|src\/members\/|scripts\/[^/]*deploy)|(secret|credential|cred[-_/]|oauth)/;

export function planJudge(snap: Snapshot, input: { scope: ResolvedScope; state: ScopeState }): Row[] {
  const { scope, state } = input;
  const mode = scope.mode === 'live' ? 'live' : 'shadow';
  const rows: Row[] = [];
  const hands = idleHands(snap, scope.scope, state);
  let budget = scope.caps.judge;
  const queue = snap.prs.filter((pr) => !pr.draft).flatMap((pr) => {
    const head12 = pr.head.slice(0, 12);
    const receipt = snap.receipts.filter((r) => r.pr === pr.number && r.head12 === head12 && GREEN.test(r.status)).sort((a, b) => a.atMs - b.atMs)[0];
    if (!receipt || snap.nowMs - receipt.atMs < D.judgeWaitMinutes * MIN) return [];
    if (snap.verdicts.some((v) => v.pr === pr.number && v.head12 === head12)) return [];
    if (within(state.judgeAssigned[`${pr.number}-${head12}`]?.at, snap.nowMs, D.cooldownMinutes * 2)) return [];
    return [{ pr, head12, waited: snap.nowMs - receipt.atMs, security: (pr.files ?? []).some((f) => SECURITY_PATH.test(f)) }];
  }).sort((a, b) => b.waited - a.waited || a.pr.number - b.pr.number);
  for (const item of queue) {
    const target = `#${item.pr.number}`;
    const reason = item.security ? 'green-no-verdict:security-4' : 'green-no-verdict';
    if (budget <= 0) { rows.push({ node: 'r3', scope: scope.scope, action: 'defer', target, head12: item.head12, reason: 'tick-cap', mode }); continue; }
    const hand = hands.shift();
    if (!hand) { rows.push({ node: 'r3', scope: scope.scope, action: 'defer', target, head12: item.head12, reason: 'no-judge-hand', mode }); continue; }
    budget--;
    rows.push({ node: 'r3', scope: scope.scope, action: 'judge-assign', target, head12: item.head12, seat: hand.seat, reason, mode });
  }
  return rows;
}

// ── R4 land (hand-off only) ────────────────────────────────────────────────────────────────────

/** PASS on the current head = the existing poller/train lands it (no new landing path). An open PR whose PASS is older
 *  than 30 min is an ambiguous row for the coordinator; a hold verdict is not a hand-off. */
export function planHandoff(snap: Snapshot, input: { scope: ResolvedScope }): Row[] {
  const mode = input.scope.mode === 'live' ? 'live' : 'shadow';
  const rows: Row[] = [];
  for (const pr of snap.prs.filter((p) => !p.draft)) {
    const head12 = pr.head.slice(0, 12);
    const verdicts = snap.verdicts.filter((v) => v.pr === pr.number && v.head12 === head12);
    if (verdicts.some((v) => v.kind === 'hold' || v.verdict.toLowerCase() === 'hold')) continue;
    const pass = verdicts.filter((v) => v.verdict.toLowerCase() === 'pass').sort((a, b) => a.atMs - b.atMs)[0];
    if (!pass) continue;
    const stale = snap.nowMs - pass.atMs >= D.passNotLandedMinutes * MIN;
    rows.push({ node: 'r4', scope: input.scope.scope, action: stale ? 'ambiguous' : 'handoff', target: `#${pr.number}`, head12,
      reason: stale ? 'pass-not-landed' : 'pass-to-poller', mode });
  }
  return rows;
}

// ── R5 watch ───────────────────────────────────────────────────────────────────────────────────

export interface WatchInput {
  readonly scope: ResolvedScope;
  readonly state: ScopeState;
  readonly cutTimes: readonly string[];
  readonly cutWindowMinutes: number;
  readonly timeZoneOffsetMinutes?: number;
}

/** Minutes until the next HH:MM cut (local clock given by offset; default the process clock). */
export function minutesToNextCut(nowMs: number, cutTimes: readonly string[], offsetMinutes = -new Date(nowMs).getTimezoneOffset()): { cut: string; minutes: number } | null {
  const local = new Date(nowMs + offsetMinutes * MIN);
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  let best: { cut: string; minutes: number } | null = null;
  for (const cut of cutTimes) {
    const m = /^(\d{2}):(\d{2})$/.exec(cut);
    if (!m) continue;
    const at = Number(m[1]) * 60 + Number(m[2]);
    const minutes = (at - nowMin + 24 * 60) % (24 * 60);
    if (!best || minutes < best.minutes) best = { cut, minutes };
  }
  return best;
}

export function planWatch(snap: Snapshot, input: WatchInput): { rows: Row[]; resolvedCells: string[]; resolvedPrs: string[] } {
  const { scope, state } = input;
  const mode = scope.mode === 'live' ? 'live' : 'shadow';
  const rows: Row[] = [];
  const resolvedCells: string[] = [];
  const resolvedPrs: string[] = [];
  const cells = new Map(snap.cells.map((c) => [c.id, c]));
  const seats = new Map(snap.seats.map((s) => [s.seat, s]));
  for (const [cellId, a] of Object.entries(state.assigned)) {
    const cell = cells.get(cellId);
    if (!cell || cell.status !== 'yellow' || Date.parse(cell.updatedAt) > Date.parse(a.at)) { resolvedCells.push(cellId); continue; }
    const age = ageMs(a.at, snap.nowMs);
    if (age >= 2 * 60 * MIN) { resolvedCells.push(cellId); continue; }
    if (age >= 20 * MIN && seats.get(a.seat)?.activity === 'idle')
      rows.push({ node: 'r5', scope: scope.scope, action: 'ambiguous', target: cellId, seat: a.seat, reason: 'assign-not-picked', mode });
  }
  for (const [pr, d] of Object.entries(state.dispatched)) {
    const number = Number(pr);
    if (hasReceipt(snap, number, d.head12)) {
      const receipt = snap.receipts.find((r) => r.pr === number && r.head12 === d.head12)!;
      rows.push({ node: 'r5', scope: scope.scope, action: 'watch', target: `#${pr}`, head12: d.head12, host: receipt.host, reason: `receipt:${receipt.status}`, mode });
      resolvedPrs.push(pr);
    } else if (!snap.prs.some((p) => p.number === number && p.head.startsWith(d.head12))) resolvedPrs.push(pr);
    else if (ageMs(d.at, snap.nowMs) >= D.pregateStuckMinutes * MIN) {
      rows.push({ node: 'r5', scope: scope.scope, action: 'ambiguous', target: `#${pr}`, head12: d.head12, host: d.host, reason: 'pregate-stuck', mode });
      resolvedPrs.push(pr);
    }
  }
  if (scope.profile === 'release') {
    const next = minutesToNextCut(snap.nowMs, input.cutTimes, input.timeZoneOffsetMinutes);
    const open = snap.cells.filter((c) => c.priority === 'P0' && (c.status === 'yellow' || c.status === 'red'));
    if (next && next.minutes <= input.cutWindowMinutes && open.length > 0)
      rows.push({ node: 'r5', scope: scope.scope, action: 'ambiguous', target: `cut@${next.cut}`, reason: `cut-readiness:P0-open=${open.length}:in=${next.minutes}m`, mode });
  }
  if (scope.profile === 'resource') {
    const backlog = snap.prs.filter((p) => !p.draft && !hasReceipt(snap, p.number, p.head.slice(0, 12))).length;
    const stopped = snap.hosts.filter((h) => h.stopped).map((h) => h.host);
    if (backlog > 10 && stopped.length > 0)
      rows.push({ node: 'r5', scope: scope.scope, action: 'ambiguous', target: 'vm-pressure', reason: `receiptless=${backlog}:stopped=${stopped.join(',')}`, mode });
  }
  return { rows, resolvedCells, resolvedPrs };
}

// ── R6 digest ──────────────────────────────────────────────────────────────────────────────────

export interface DigestCounts { landedPerHour: number; idle: number; blocked: number; openHands: number; oldestHandMin: number; /** This tick's wakes. */ woken?: number; /** This tick's lease reclaims. */ reclaimed?: number }

export function digestCounts(snap: Snapshot, scope: string): DigestCounts {
  const known = knownSeatsOf(snap);
  const landed = snap.merged.filter((m) => snap.nowMs - m.mergedAtMs <= 60 * MIN && prScope(snap, m, known).scope === scope).length;
  const mine = snap.seats.filter((s) => scopeOf(snap, s.seat) === scope && isHand(snap, s.seat));
  const hands = snap.openHands.filter((h) => h.receiver === scope);
  return {
    landedPerHour: landed,
    idle: mine.filter((s) => s.activity === 'idle').length,
    blocked: mine.filter((s) => s.activity === 'blocked').length,
    openHands: hands.length,
    oldestHandMin: hands.length ? Math.floor(Math.max(...hands.map((h) => h.waitedMs)) / MIN) : 0,
  };
}

/** The one-line rollup: «scope · landed/h · idle · blocked · open ✋ age». */
export function rollupLine(scope: string, c: DigestCounts): string {
  return `${scope} · landed/h ${c.landedPerHour} · idle ${c.idle}${c.woken ? ` · wake ${c.woken}` : ''}${c.reclaimed ? ` · reclaimed ${c.reclaimed}` : ''} · blocked ${c.blocked} · ✋ ${c.openHands}${c.openHands ? ` (oldest ${c.oldestHandMin}m)` : ''}`;
}

export function digestDue(state: ScopeState, nowMs: number): boolean {
  return !within(state.lastDigestAt, nowMs, D.digestEveryMinutes);
}

// ── X exceptions ───────────────────────────────────────────────────────────────────────────────

export const EXCEPTION_ACTIONS: ReadonlySet<RowAction> = new Set(['reject', 'ambiguous', 'escalate']);
export const rowKey = (row: Row): string => `${row.node}:${row.action}:${row.target}:${row.head12 ?? ''}:${row.reason}`;
/** Lines on one card; the rest is a count (the coordinator reads the ledger for the tail). */
export const CARD_MAX_LINES = 10;

/** This scope's exception rows, one per key (a row repeated by two nodes counts once). */
export function exceptionRows(scope: string, rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => r.scope === scope && EXCEPTION_ACTIONS.has(r.action)).filter((r) => {
    const key = rowKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The ONE card for one scope this tick: its reject/ambiguous rows go to its own coordinator. A sub-scope's `escalate`
 * rows are not mailed by it — HQ reads them from its ledger; at HQ every exception row is the OP card. Keys already carded
 * within the repeat window are dropped; at most {@link CARD_MAX_LINES} lines, then «… 외 N건». Null = nothing new.
 */
/** Federation hand pool [B] — pull-first means HQ mostly REPORTS imbalance: per space, idle hands (≥ idle threshold) vs
 *  ready board cells (yellow · unowned or held by that space's coordinator · unowned cells count under HQ = the pool).
 *  One line when some space has idle hands while another space of the same side (maker/judge) has ready cells; null otherwise. */
export function poolImbalanceLine(snap: Snapshot): string | null {
  const judge = (s: string): boolean => judgeSide(snap, s);
  const idle = new Map<string, number>(); const ready = new Map<string, number>();
  for (const s of snap.seats) {
    if (!isHand(snap, s.seat) || s.activity !== 'idle' || s.idleForMs === null || s.idleForMs < D.idleMinMinutes * MIN) continue;
    const sc = scopeOf(snap, s.seat); idle.set(sc, (idle.get(sc) ?? 0) + 1);
  }
  for (const c of snap.cells) {
    if (c.status !== 'yellow') continue;
    const owner = ownerSeat(c.owner);
    const sc = UNOWNED(c.owner) ? snap.hq : owner === snap.hq || snap.coordinators.includes(owner) ? owner : null;
    if (sc) ready.set(sc, (ready.get(sc) ?? 0) + 1);
  }
  const idleSpaces = [...idle].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const pairs: string[] = [];
  for (const [space, n] of idleSpaces) {
    const others = [...ready].filter(([sc, r]) => r > 0 && sc !== space && (ready.get(space) ?? 0) === 0 && judge(sc) === judge(space))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (others.length) pairs.push(`space ${space} idle ${n} / ${others.map(([sc, r]) => `space ${sc} ready ${r}`).join(' · ')}`);
  }
  return pairs.length ? pairs.join(' ; ') : null;
}

export function exceptionCard(scope: string, hq: string, rows: readonly Row[], state: ScopeState, nowMs: number):
  { to: string; title: string; body: string; keys: string[] } | null {
  const fresh = exceptionRows(scope, rows)
    .filter((r) => scope === hq || r.action !== 'escalate')
    .filter((r) => !within(state.cards[rowKey(r)], nowMs, D.cardRepeatMinutes));
  if (!fresh.length) return null;
  const title = `[행정관 · ${scope}] 예외 카드 ${fresh.length}건`;
  const lines = fresh.slice(0, CARD_MAX_LINES).map((r) => `- ${r.action} ${r.target}${r.head12 ? `@${r.head12}` : ''}${r.seat ? ` · ${r.seat}` : ''}${r.lentFrom ? ` (from ${r.lentFrom})` : ''} — ${r.reason}`);
  const more = fresh.length > CARD_MAX_LINES ? [`… 외 ${fresh.length - CARD_MAX_LINES}건 (eln steward space status --scope ${scope})`] : [];
  return { to: scope, title, body: [title, ...lines, ...more, '결정은 보드에 적으면 다음 틱이 집행합니다.'].join('\n'), keys: fresh.map(rowKey) };
}

export function profileUses(profile: StewardSpaceProfile, node: string, nodes: Record<StewardSpaceProfile, ReadonlySet<string>>): boolean {
  return nodes[profile].has(node);
}
