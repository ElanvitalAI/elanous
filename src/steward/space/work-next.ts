// PULL (대표 11-25 17:1x «PULL 이 기본 · PUSH 는 예외») — `eln work next [--scope <space>]`: the calling seat claims the
// top-ranked READY cell of its scope in one compare-and-set, instead of waiting for a coordinator or the 행정관 to push.
//   READY  = yellow · not a decision/umbrella cell · every predecessor green/done · not waiting (cell-wait.ts) · unowned,
//            owned by the scope's own COORDINATOR (a leader-owned cell is the board — rail 30, 11-25 18:2x: 20+28 yellow
//            cells sat on TC/UX/OP unclaimable; the claim keeps «assignedBy: <leader>» in the history reason), or owned by
//            a hand of the same scope whose lease ran out (owner's last activity + 45 min — the steward's reclaim clock).
//   rank   = priority (P0 · P1 · P2 · none) → deadline version → oldest change → id.
//   WIP 1  = counts ACTIVE cells only: a held cell that waits on someone else (JUD verdict · RES receipt · HOLD · train)
//            does not block a claim; a held ACTIVE cell is handed back first (exit 4 = continue your own next cell).
//   empty  = exit 3 («일감 0»).
// Federation hand pool [B] (대표 11-25 «hands move across spaces regardless of home»): after WIP the claim order is
//   (2) P0 / priority-order cells in ANY space, ranked by the OP pulse's `priorityOrder` ledger (index of the first entry
//       that is the cell id or a substring of id/title · unmatched P0 after every match) → version → age → id ·
//   (3) the home space board (as before) · (4) other spaces' boards (borrow: unowned or coordinator-held only).
//   A claim outside the home space is a `pool.lend {from: home, to: cellSpace, seat, cell, via: work-next}` row ⊕ the
//   claim history reason. Maker ≠ judge: JUD-*/REVIEW-* hands claim only judge-space cells and the rest never claim those.
//   A cell with skill tags is skipped by a hand lacking any of them. No home lock — a closed cell frees the hand.
// POOL-PULL-NEEDS-SPEC (0.3.38 P1 · OP 11-27 16:30): with `pull.requireDoneWhen` (graphs/policies/seat-assign.yaml) an
//   unowned cell without a done-when (doneCriterion) is never offered — hands claimed them and asked TC for the KPI
//   contract (hand blocks 10→34). The ledger row carries `skipped: {needs-spec: [...]}`; the board steward lists them to OP.
// Two seats racing for one cell: the ledger write is BEGIN IMMEDIATE and the owner swap checks the owner it ranked on
// (swapOwnerIf); the loser moves to its next candidate. Every call is one row in `<state>/steward/work-next.jsonl`
// — the 행정관 does not wake a hand that pulled since it went idle.
//
// 세 얼굴: 관측 = work-next.jsonl ⊕ checklist history (claim rows, actor = the seat, reason «work next») ·
//          판단 근거 = rank ⊕ lease (rules, no LLM) · 수복과 인계 = a lost race retries the next cell; exit 3 tells the
//          seat «일감 0» so it stops instead of asking.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isJudgeRole } from '../../seat/hand-pool.js';
import { LEASE_MINUTES } from './model.js';
import type { CellWait } from './cell-wait.js';

export interface BoardCell {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner?: string;
  readonly priority?: string;
  readonly predecessors?: readonly string[];
  readonly deadlineVersion?: string;
  readonly dispatchKind?: string;
  readonly doneCriterion?: string;
  readonly updatedAt: string;
  /** Skill tags (optional) — a hand lacking any of them skips the cell. */
  readonly skills?: readonly string[];
}

export interface WorkNextDeps {
  readonly now: () => number;
  readonly version: string;
  readonly cells: () => readonly BoardCell[];
  /** seat → its coordinator scope (federation ladder). */
  readonly scopeOf: (seat: string) => string;
  /** The seat's last real activity (activity.ts clock); undefined = unknown. */
  readonly lastActiveMs: (seat: string) => number | undefined;
  /** Why a cell waits on someone else (cell-wait.ts) — absent/undefined = active. */
  readonly waitOf?: (cell: BoardCell) => CellWait | null | undefined;
  readonly swap: (id: string, input: { expectedOwner: string | null; to: string; actor: string; reason: string }) => { outcome: 'swapped' | 'lost' | 'missing' };
  readonly record?: (row: Record<string, unknown>) => void;
  /** Coordinator seats (ladder depth 2). Absent = only the caller's own scope counts as a coordinator (pre-pool shape). */
  readonly isCoordinator?: (seat: string) => boolean;
  /** Judge side by role (federation.yaml role ⊕ judiciary id ⊕ judiciary coordinator). Absent = {@link isJudgeRole} on the ladder. */
  readonly isJudge?: (seat: string) => boolean;
  /** OP pulse priority list (federation.priorityOrder ledger) — absent/empty = P0 by version then age. */
  readonly priorityOrder?: () => readonly string[];
  /** The hand's skill tags; absent = none (tagged cells are skipped). */
  readonly skillsOf?: (seat: string) => readonly string[] | undefined;
  /** `pool.lend` observation (logs) — the work-next.jsonl row carries it too. */
  readonly lend?: (row: { from: string; to: string; seat: string; cell: string; via: 'work-next' }) => void;
  /** HAND-PULL-ON-BLOCK (cell-block.ts) — a board cell parked as blocked-on:<seat>, as seen by the caller; undefined = no block. */
  readonly blockOf?: (cell: BoardCell) => 'blocked' | 'reoffer' | 'reserved' | 'ready' | undefined;
  /** A claimed cell that was parked by `eln work block` — close its block row (resume). */
  readonly resume?: (cell: BoardCell, seat: string) => void;
  /** PR-DONE: the owner's closing move on its own (waiting) cell — worktree dirty or commits unpushed. null = handed off. */
  readonly prDone?: (cell: BoardCell) => string | null;
  /** OP-PULL-HINT: the seat the OP planner hinted this cell to (fresh hints only). The hinted seat gets it first, other
   *  seats take it only after every unhinted cell — a hint, never a lock. Absent = no hints. */
  readonly hintOf?: (cell: BoardCell) => string | undefined;
  /** POOL-PULL-NEEDS-SPEC: policy `pull.requireDoneWhen` — true = unowned cells without a done-when are skipped. Absent = false. */
  readonly requireDoneWhen?: () => boolean;
}

export type WorkNextResult =
  | { readonly code: 0; readonly cell: BoardCell; readonly from: string | null; readonly line: string; readonly lentTo?: string; readonly waiting?: readonly string[] }
  | { readonly code: 3; readonly line: string; readonly breakdown?: string }
  | { readonly code: 4; readonly cell: BoardCell; readonly line: string };

const MIN = 60_000;
const RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
const ownerSeat = (owner: string | undefined): string => (owner ?? '').split('/')[0]!.trim().toUpperCase();
const unowned = (owner: string | undefined): boolean => !owner || owner === '-' || owner.toLowerCase() === 'none';

/** Owner lease end: max(cell's last change, owner's last activity) + {@link LEASE_MINUTES}. */
export function boardLeaseUntilMs(cell: Pick<BoardCell, 'updatedAt'>, ownerLastActiveMs: number | undefined): number {
  const stamps = [Date.parse(cell.updatedAt), ownerLastActiveMs ?? NaN].filter((t) => Number.isFinite(t));
  return (stamps.length ? Math.max(...stamps) : 0) + LEASE_MINUTES * MIN;
}

function versionKey(v: string | undefined): number[] { return v ? v.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0) : [Number.MAX_SAFE_INTEGER]; }
function cmpVersion(a: string | undefined, b: string | undefined): number {
  const x = versionKey(a); const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

/** READY cells of `scope` for `seat`, best first. */
export function readyCells(cells: readonly BoardCell[], input: { seat: string; scope: string; nowMs: number; scopeOf: (seat: string) => string; lastActiveMs: (seat: string) => number | undefined; waitOf?: (cell: BoardCell) => CellWait | null | undefined }): BoardCell[] {
  const status = new Map(cells.map((c) => [c.id, c.status]));
  return cells
    .filter((c) => c.status === 'yellow' && c.dispatchKind !== 'decision' && c.dispatchKind !== 'umbrella')
    .filter((c) => (c.predecessors ?? []).every((p) => { const s = status.get(p); return s === undefined || s === 'green' || s === 'done'; }))
    .filter((c) => !input.waitOf?.(c))
    .filter((c) => {
      if (unowned(c.owner)) return true;
      const owner = ownerSeat(c.owner);
      if (owner === input.seat) return false;
      // The scope's own coordinator holding a yellow cell = the board (leaders route, hands work).
      if (owner === input.scope) return true;
      return input.scopeOf(owner) === input.scope && boardLeaseUntilMs(c, input.lastActiveMs(owner)) < input.nowMs;
    })
    .sort((a, b) => (RANK[a.priority ?? ''] ?? 3) - (RANK[b.priority ?? ''] ?? 3) || cmpVersion(a.deadlineVersion, b.deadlineVersion)
      || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id));
}

/** POOL-PULL-NEEDS-SPEC — an unowned cell with no measurable done-when (blank doneCriterion): not offered to hands. */
export const needsSpec = (c: Pick<BoardCell, 'owner' | 'doneCriterion'>): boolean => unowned(c.owner) && !c.doneCriterion?.trim();

export const cellLine = (c: BoardCell): string => `${c.id} · ${c.title.replace(/\s+/g, ' ').slice(0, 160)} · done-when: ${(c.doneCriterion?.trim() || c.title).replace(/\s+/g, ' ').slice(0, 240)}`;

export function workNext(seatRaw: string, deps: WorkNextDeps, opts: { scope?: string } = {}): WorkNextResult {
  const seat = seatRaw.trim().toUpperCase();
  const scope = (opts.scope ?? deps.scopeOf(seat)).trim().toUpperCase();
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const record = (row: Record<string, unknown>): void => { try { deps.record?.({ at, seat, scope, version: deps.version, ...row }); } catch { /* the ledger never blocks a claim */ } };
  const cells = deps.cells();
  // WIP 1 counts ACTIVE work: the caller's own yellow cells that wait on someone else do not block a claim.
  const mine = cells.filter((c) => c.status === 'yellow' && !unowned(c.owner) && ownerSeat(c.owner) === seat)
    .sort((a, b) => (RANK[a.priority ?? ''] ?? 3) - (RANK[b.priority ?? ''] ?? 3) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id));
  const waits = new Map(mine.map((c) => [c.id, deps.waitOf?.(c) ?? null]));
  const held = mine.find((c) => !waits.get(c.id));
  if (held) {
    record({ outcome: 'wip', cell: held.id, ...(mine.length > 1 ? { waiting: mine.filter((c) => waits.get(c.id)).map((c) => `${c.id}:${waits.get(c.id)}`) } : {}) });
    return { code: 4, cell: held, line: `WIP 1 — continue your own cell ${cellLine(held)}` };
  }
  // PR-DONE: a waiting cell whose PR is not yet handed off (dirty tree · unpushed commits) is closed first.
  for (const c of mine) {
    let todo: string | null = null;
    try { todo = deps.prDone?.(c) ?? null; } catch { todo = null; }
    if (todo) {
      record({ outcome: 'pr-done', cell: c.id, todo });
      return { code: 4, cell: c, line: `PR-DONE — finish your own cell ${cellLine(c)} first: ${todo}; then eln work next` };
    }
  }
  const waiting = mine.map((c) => `${c.id}:${waits.get(c.id)}`);
  const isCoordinator = deps.isCoordinator ?? ((s: string) => s === scope);
  // HAND-PULL-ON-BLOCK — a cell blocked on a seat that has not answered is never READY; once it answers, its last holder
  // gets it first (ranked first) and other hands wait out the grace window (cell-block.ts blockState).
  const blockOf = (cell: BoardCell) => { try { return deps.blockOf?.(cell); } catch { return undefined; } };
  const hintOf = (cell: BoardCell) => { try { return deps.hintOf?.(cell)?.trim().toUpperCase() || undefined; } catch { return undefined; } };
  let requireDoneWhen = false;
  try { requireDoneWhen = deps.requireDoneWhen?.() === true; } catch { requireDoneWhen = true; }
  const skippedSpec: string[] = [];
  const candidates = poolCandidates(cells, { hintedToMe: (cell) => hintOf(cell) === seat, seat, scope, nowMs, scopeOf: deps.scopeOf, isCoordinator, lastActiveMs: deps.lastActiveMs,
    isJudge: deps.isJudge ?? ((s: string) => isJudgeRole(s, { parentOf: deps.scopeOf })), priorityOrder: safeOrder(deps), skills: deps.skillsOf?.(seat) ?? [], ...(deps.waitOf ? { waitOf: deps.waitOf } : {}) })
    .filter(({ cell }) => { const b = blockOf(cell); return b !== 'blocked' && b !== 'reserved'; })
    .filter(({ cell }) => { if (!requireDoneWhen || !needsSpec(cell)) return true; skippedSpec.push(cell.id); return false; });
  const skipped = skippedSpec.length ? { skipped: { 'needs-spec': skippedSpec.slice(0, 20) } } : {};
  const hintRank = (cell: BoardCell) => { const h = hintOf(cell); return h === seat ? 0 : h ? 2 : 1; };
  const reoffered = candidates.filter(({ cell }) => blockOf(cell) === 'reoffer');
  const rest = candidates.filter(({ cell }) => blockOf(cell) !== 'reoffer');
  // stable: within each hint rank the pool order stands
  const ordered = [...reoffered, ...[0, 1, 2].flatMap((r) => rest.filter(({ cell }) => hintRank(cell) === r))];
  for (const { cell, space, tier } of ordered) {
    const from = unowned(cell.owner) ? null : cell.owner!;
    const lent = space !== null && space !== scope;
    const block = blockOf(cell);
    const base = !from ? 'work next' : block === 'reoffer' ? `work next · re-offered after block (assignedBy: ${ownerSeat(from)})`
      : isCoordinator(ownerSeat(from)) ? `work next · board cell (assignedBy: ${ownerSeat(from)})` : `work next · lease expired (owner ${ownerSeat(from)})`;
    const reason = lent ? `${base} · pool.lend ${scope}→${space} (${tier})` : base;
    const result = deps.swap(cell.id, { expectedOwner: cell.owner ?? null, to: seat, actor: seat, reason });
    if (result.outcome !== 'swapped') { record({ outcome: 'lost', cell: cell.id }); continue; }
    if (block) { try { deps.resume?.(cell, seat); } catch { /* the block row only stays open */ } }
    const lend = lent ? { from: scope, to: space!, seat, cell: cell.id, via: 'work-next' as const } : null;
    if (lend) { try { deps.lend?.(lend); } catch { /* observation never blocks a claim */ } }
    record({ outcome: 'claimed', cell: cell.id, from, tier, leaseUntil: new Date(nowMs + LEASE_MINUTES * MIN).toISOString(), ...(lend ? { event: 'pool.lend', lend } : {}), ...(waiting.length ? { waiting } : {}), ...skipped });
    return { code: 0, cell, from, line: cellLine(cell), ...(lend ? { lentTo: lend.to } : {}), ...(waiting.length ? { waiting } : {}) };
  }
  const breakdown = emptyBreakdown(cells, { seat, candidates: ordered.length, blocked: cells.filter((c) => { const b = blockOf(c); return b === 'blocked' || b === 'reserved'; }).length,
    waiting: mine.length, judge: (deps.isJudge ?? ((s: string) => isJudgeRole(s, { parentOf: deps.scopeOf })))(seat) })
    + (skippedSpec.length ? ` · needs-spec ${skippedSpec.length} (no done-when — OP sets one)` : '');
  record({ outcome: 'empty', breakdown, ...(waiting.length ? { waiting } : {}), ...skipped });
  return { code: 3, line: `일감 0 — no READY cell in ${scope} or the pool (${deps.version})`, breakdown };
}

/** Why the pool came back empty — one line the knock and the CLI show (counts, rules only). */
function emptyBreakdown(cells: readonly BoardCell[], input: { seat: string; candidates: number; blocked: number; waiting: number; judge: boolean }): string {
  const yellow = cells.filter((c) => c.status === 'yellow');
  const done = cells.filter((c) => c.status === 'green' || c.status === 'done').length;
  const routed = yellow.filter((c) => c.dispatchKind === 'decision' || c.dispatchKind === 'umbrella').length;
  const ownedByMe = yellow.filter((c) => !unowned(c.owner) && ownerSeat(c.owner) === input.seat).length;
  const unownedN = yellow.filter((c) => unowned(c.owner)).length;
  return `board ${cells.length} · yellow ${yellow.length} · done ${done} · decision/umbrella ${routed} · unowned ${unownedN} · mine waiting ${input.waiting} (held ${ownedByMe})`
    + ` · blocked ${input.blocked} · claimable ${input.candidates} · side ${input.judge ? 'judge' : 'maker'} (other-side, unmet predecessors, waits, skills and live hand leases excluded)`;
}

const safeOrder = (deps: WorkNextDeps): readonly string[] => { try { return deps.priorityOrder?.() ?? []; } catch { return []; } };


/** The space a cell belongs to: coordinator owner = that space · hand owner = the hand's scope · unowned = null (shared). */
export function cellSpace(cell: Pick<BoardCell, 'owner'>, scopeOf: (seat: string) => string, isCoordinator: (seat: string) => boolean): string | null {
  if (unowned(cell.owner)) return null;
  const owner = ownerSeat(cell.owner);
  return isCoordinator(owner) ? owner : scopeOf(owner).toUpperCase();
}

/** Rank of a cell in the OP pulse priority order: index of the first matching entry, else the list length. */
export function priorityIndex(cell: Pick<BoardCell, 'id' | 'title'>, order: readonly string[]): number {
  const hay = `${cell.id} ${cell.title}`.toLowerCase();
  const i = order.findIndex((e) => { const k = e.trim().toLowerCase(); return !!k && (cell.id.toLowerCase() === k || hay.includes(k)); });
  return i < 0 ? order.length : i;
}

export interface PoolCandidate { readonly cell: BoardCell; readonly space: string | null; readonly tier: 'pool-p0' | 'home' | 'borrow' }

/** Claim order for one hand: pool P0/priority (any space) → home board → other spaces' boards. */
export function poolCandidates(cells: readonly BoardCell[], input: { seat: string; scope: string; nowMs: number; scopeOf: (seat: string) => string;
  isCoordinator: (seat: string) => boolean; isJudge: (seat: string) => boolean; lastActiveMs: (seat: string) => number | undefined; waitOf?: (cell: BoardCell) => CellWait | null | undefined;
  priorityOrder: readonly string[]; skills: readonly string[]; hintedToMe?: (cell: BoardCell) => boolean }): PoolCandidate[] {
  const judgeHand = input.isJudge(input.seat);
  const hinted = (c: BoardCell): boolean => { try { return input.hintedToMe?.(c) === true; } catch { return false; } };
  const have = new Set(input.skills.map((s) => s.trim().toLowerCase()));
  const status = new Map(cells.map((c) => [c.id, c.status]));
  const space = (c: BoardCell): string | null => cellSpace(c, input.scopeOf, input.isCoordinator);
  const eligible = cells
    .filter((c) => c.status === 'yellow' && c.dispatchKind !== 'decision' && c.dispatchKind !== 'umbrella')
    .filter((c) => (c.predecessors ?? []).every((p) => { const s = status.get(p); return s === undefined || s === 'green' || s === 'done'; }))
    .filter((c) => !input.waitOf?.(c))
    .filter((c) => (c.skills ?? []).every((t) => have.has(t.trim().toLowerCase())))
    // OP-PULL-HINT: a cell the OP planner hinted to this hand is claimable by it whoever holds it (the planner picked it as
    // «nobody on it» — unowned, a coordinator's, or a gone hand's), the way the old direct assign was.
    .filter((c) => hinted(c) || judgeHand === (!unowned(c.owner) && input.isJudge(ownerSeat(c.owner))))
    .filter((c) => {
      if (unowned(c.owner)) return true;
      const owner = ownerSeat(c.owner);
      if (owner === input.seat) return false;
      if (hinted(c)) return true;
      if (input.isCoordinator(owner)) return true; // any space's coordinator-held cell is that space's board
      // A hand-owned cell moves only inside its own space, after the lease ran out.
      return input.scopeOf(owner).toUpperCase() === input.scope && boardLeaseUntilMs(c, input.lastActiveMs(owner)) < input.nowMs;
    });
  const base = (a: BoardCell, b: BoardCell): number => (RANK[a.priority ?? ''] ?? 3) - (RANK[b.priority ?? ''] ?? 3) || cmpVersion(a.deadlineVersion, b.deadlineVersion)
    || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id);
  const order = input.priorityOrder;
  const inPool = (c: BoardCell): boolean => c.priority === 'P0' || priorityIndex(c, order) < order.length;
  const pool = eligible.filter(inPool).sort((a, b) => priorityIndex(a, order) - priorityIndex(b, order) || base(a, b));
  const rest = eligible.filter((c) => !inPool(c));
  const home = rest.filter((c) => { const sp = space(c); return sp === null || sp === input.scope; }).sort(base);
  const borrow = rest.filter((c) => { const sp = space(c); return sp !== null && sp !== input.scope; }).sort(base);
  return [...pool.map((cell) => ({ cell, space: space(cell), tier: 'pool-p0' as const })), ...home.map((cell) => ({ cell, space: space(cell), tier: 'home' as const })),
    ...borrow.map((cell) => ({ cell, space: space(cell), tier: 'borrow' as const }))];
}

export function appendJsonl(path: string, row: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}
