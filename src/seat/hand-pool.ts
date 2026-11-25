// FEDERATION HAND POOL (대표 11-25 15:0x [B] «손 탭 = 연방 손 풀 · 빌려 씀 · 고향 = 만든 스페이스 · 끝나면 풀 복귀»).
//
// S: hand tabs belonged to one space; an idle TC hand sat while UX waited, and nobody knew which hand was free.
// C: canon allows four ledgers only — the pool must not be a fifth. Every fact it needs is already in one:
//    the seat registry ⊕ federation.yaml (who is a hand, where it was made), the release checklist (owner ⊕ status ⊕ claim
//    history = what it works on and who lent it), main's landed PRs, and the els pane state (WORKING / IDLE · since).
// Q: what is each hand doing, where is home, and who may borrow it?
// A: a pure view derived from those ledgers. `working(scope, cell)` = an open (yellow/red) cell it owns whose PR has not
//    landed; scope = the coordinator whose claim put it there. Cell done/green or its PR landed → the same view says idle —
//    the hand returns to the pool with no write. Idle > N h → close candidate on the Federation Board.
//    Judge hands (JUD-*, REVIEW-*) are kingdom-dedicated and never in the pool.
//
// 세 얼굴: 관측 = `eln seat pool` ⊕ the board line «🤝 Hand pool …» ⊕ `pool.lend` log line · 판단 근거 = each row's cell / scope /
// since · 수복과 인계 = `eln seat assign POOL <cell>` borrows the longest-idle hand (home scope first, then any scope).

import type { ChecklistHistory, ChecklistItem } from '../release-loop/checklist.js';

export const HAND_POOL_IDLE_CLOSE_HOURS = 6;
/** OWNER-IDLE-WAKE (대표 11-25 16:1x) — a hand whose live pane sat IDLE this long while it owns an open cell needs a wake, not a reassignment. */
export const OWNER_IDLE_WAKE_MS = 10 * 60_000;
/** The `eln seat assign` seat argument that means «pick from the pool». */
export const POOL_SEAT = 'POOL';
const NOT_HANDS = new Set(['CEO', 'CLAUDE-OP', POOL_SEAT]);
const BUSY_PANE = new Set(['WORKING', 'STALLED', 'WAITING_REPLY', 'WAITING_APPROVAL', 'BLOCKED']);

/** Judge hands belong to the judiciary kingdom (JUD, JUD-3, JUDGE-A, REVIEW-2 …) and are never lent. */
export function isJudgeHand(seat: string): boolean {
  return /^(JUD|JUDGE|REVIEW)(?:$|[-\d])/.test(seat.trim().toUpperCase());
}

/** Maker ≠ judge, by ROLE: a seat is on the judge side when its federation.yaml role is a judge/review role, its own id is
 *  a judiciary seat, or its coordinator (ladder parent) is one — so JUD-B / JUD-3 are judges whatever their suffix and a
 *  judge kingdom's hand with an arbitrary name is still a judge. */
export function isJudgeRole(seat: string, ctx: { parentOf?: (seat: string) => string; roleOf?: (seat: string) => string | undefined } = {}): boolean {
  const id = seat.trim().toUpperCase();
  if (!id) return false;
  const declared = (s: string): boolean => { try { return /^(jud|judge|judiciary|review|reviewer)(?:$|[-_\s])/i.test(ctx.roleOf?.(s)?.trim() ?? ''); } catch { return false; } };
  if (isJudgeHand(id) || declared(id)) return true;
  let parent = '';
  try { parent = ctx.parentOf?.(id)?.trim().toUpperCase() ?? ''; } catch { parent = ''; }
  return !!parent && parent !== id && (isJudgeHand(parent) || declared(parent));
}

export interface PoolLadder {
  readonly hq: string;
  parentOf(seat: string): string;
  depthOf(seat: string): number;
}

export interface PoolPane { readonly state: string; readonly since: number }

export interface HandPoolInput {
  readonly now: number;
  readonly seats: ReadonlySet<string>;
  readonly ladder: PoolLadder;
  readonly cells: readonly Pick<ChecklistItem, 'id' | 'owner' | 'status' | 'evidence' | 'updatedAt'>[];
  readonly history: readonly Pick<ChecklistHistory, 'at' | 'by' | 'id' | 'field' | 'to'>[];
  /** PR numbers already on main — a cell whose evidence names one of them is finished for the pool. */
  readonly landedPrs?: ReadonlySet<number>;
  /**
   * els pane state per seat (SEAT-STATE-ENUM code ⊕ since). Present = the pane list was read: a hand with no pane (or an
   * EXITED one) is `no-pane` — a registry row, not a hand anyone can borrow. Absent = the list could not be read (fail-soft:
   * the ledgers alone decide, as before).
   */
  readonly panes?: ReadonlyMap<string, PoolPane>;
  readonly idleCloseHours?: number;
}

export interface HandPoolEntry {
  readonly seat: string;
  /** The space that made the hand (its coordinator seat). */
  readonly home: string;
  /** `no-pane` = declared in the registry but no live els pane (only when the pane list was read). */
  readonly state: 'idle' | 'working' | 'no-pane';
  /** working: the coordinator scope it works for (≠ home = lent). */
  readonly scope?: string;
  readonly cell?: string;
  /** Epoch ms the current state began, when a ledger knows it. */
  readonly since?: number;
  readonly lent: boolean;
  readonly closeCandidate: boolean;
  readonly pane?: string;
  /** OWNER-IDLE-WAKE: the live pane is IDLE ≥ {@link OWNER_IDLE_WAKE_MS} while this hand owns the open `cell` — wake it. */
  readonly ownerIdle?: boolean;
}

const up = (s: string): string => s.trim().toUpperCase();
const ms = (iso: string | undefined): number | undefined => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : undefined; };

/** The seat a claim row gave the cell to (`to` is the seat or `{ owner, force, … }`). */
function claimTarget(to: unknown): string | undefined {
  if (typeof to === 'string') return up(to);
  if (to && typeof to === 'object' && typeof (to as { owner?: unknown }).owner === 'string') return up((to as { owner: string }).owner);
  return undefined;
}

function cellLanded(evidence: string | undefined, landed: ReadonlySet<number> | undefined): boolean {
  if (!evidence || !landed?.size) return false;
  for (const m of evidence.matchAll(/#(\d{3,6})\b/g)) if (landed.has(Number(m[1]))) return true;
  return false;
}

/** The hands of the federation: every declared seat that is not HQ, a space coordinator, a judge, or a person. */
export function poolHands(seats: ReadonlySet<string>, ladder: PoolLadder): string[] {
  const hq = up(ladder.hq);
  return [...seats].map(up).filter((s) => s && s !== hq && !NOT_HANDS.has(s) && !isJudgeHand(s) && ladder.depthOf(s) >= 3).sort();
}

export function buildHandPool(input: HandPoolInput): HandPoolEntry[] {
  const closeAfter = (input.idleCloseHours ?? HAND_POOL_IDLE_CLOSE_HOURS) * 3_600_000;
  const scopeOf = (actor: string, home: string): string => { const a = up(actor); return a && input.ladder.depthOf(a) <= 2 && a !== 'CEO' ? a : home; };
  // Idle since the latest thing a ledger saw it do: a cell of its changing, a claim row, the pane turning idle.
  const lastSeen = (seat: string, owned: readonly { id: string; updatedAt?: string }[], pane: PoolPane | undefined): number | undefined => {
    const ownedIds = new Set(owned.map((c) => c.id));
    const stamps = [
      ...owned.map((c) => ms(c.updatedAt)),
      ...input.history.filter((h) => ownedIds.has(h.id) || claimTarget(h.to) === seat).map((h) => ms(h.at)),
      ...(pane ? [pane.since] : []),
    ].filter((t): t is number => t !== undefined && t <= input.now);
    return stamps.length ? Math.max(...stamps) : undefined;
  };
  const out: HandPoolEntry[] = [];
  for (const seat of poolHands(input.seats, input.ladder)) {
    const home = up(input.ladder.parentOf(seat));
    const owned = input.cells.filter((c) => c.owner && up(c.owner) === seat);
    const open = owned.filter((c) => (c.status === 'yellow' || c.status === 'red') && !cellLanded(c.evidence, input.landedPrs))
      .sort((a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0));
    const pane = input.panes?.get(seat);
    const cell = open[0];
    // OWNER-IDLE-WAKE: the pane list was read and this hand has no live pane → a registry row, never counted as idle.
    if (input.panes && (!pane || pane.state === 'EXITED')) {
      const since = lastSeen(seat, owned, pane);
      out.push({ seat, home, state: 'no-pane', ...(cell ? { cell: cell.id } : {}), ...(since !== undefined ? { since } : {}), lent: false,
        closeCandidate: since !== undefined && input.now - since > closeAfter, ...(pane ? { pane: pane.state } : {}) });
      continue;
    }
    if (cell) {
      const claim = [...input.history].reverse().find((h) => h.id === cell.id && h.field === 'claim' && claimTarget(h.to) === seat);
      const scope = claim ? scopeOf(claim.by, home) : home;
      const since = ms(claim?.at) ?? ms(cell.updatedAt);
      const ownerIdle = pane?.state === 'IDLE' && input.now - pane.since >= OWNER_IDLE_WAKE_MS;
      out.push({ seat, home, state: 'working', scope, cell: cell.id, ...(since !== undefined ? { since } : {}), lent: scope !== home, closeCandidate: false,
        ...(pane ? { pane: pane.state } : {}), ...(ownerIdle ? { ownerIdle: true } : {}) });
      continue;
    }
    if (pane && BUSY_PANE.has(pane.state)) {
      out.push({ seat, home, state: 'working', scope: home, since: pane.since, lent: false, closeCandidate: false, pane: pane.state });
      continue;
    }
    const since = lastSeen(seat, owned, pane);
    out.push({ seat, home, state: 'idle', ...(since !== undefined ? { since } : {}), lent: false,
      closeCandidate: since !== undefined && input.now - since > closeAfter, ...(pane ? { pane: pane.state } : {}) });
  }
  return out;
}

/** Borrow one idle hand for `scope`: its own hands first, then any scope's — longest idle first, then by name. */
export function pickPoolHand(pool: readonly HandPoolEntry[], scope: string): HandPoolEntry | undefined {
  const s = up(scope);
  const idle = pool.filter((e) => e.state === 'idle' && e.pane !== 'EXITED');
  const order = (a: HandPoolEntry, b: HandPoolEntry): number => (a.since ?? 0) - (b.since ?? 0) || a.seat.localeCompare(b.seat);
  return idle.filter((e) => e.home === s).sort(order)[0] ?? idle.filter((e) => e.home !== s).sort(order)[0];
}

const hours = (msValue: number): string => { const h = Math.floor(msValue / 3_600_000); return h >= 1 ? `${h}h` : `${Math.floor(msValue / 60_000)}m`; };

/** Federation Board line: `🤝 Hand pool — idle 2 · working 3 (lent 1: TC-H-1 TC→UX) · close? 1: HAND-A 9h`. */
export function handPoolBoardLine(pool: readonly HandPoolEntry[], now: number): string {
  const idle = pool.filter((e) => e.state === 'idle');
  const working = pool.filter((e) => e.state === 'working');
  const lent = working.filter((e) => e.lent);
  const close = idle.filter((e) => e.closeCandidate);
  const noPane = pool.filter((e) => e.state === 'no-pane');
  const ownerIdle = working.filter((e) => e.ownerIdle);
  return `🤝 Hand pool — idle ${idle.length} · working ${working.length}`
    + (lent.length ? ` (lent ${lent.length}: ${lent.map((e) => `${e.seat} ${e.home}→${e.scope}`).join(', ')})` : '')
    + (ownerIdle.length ? ` · owner idle→wake ${ownerIdle.length}` : '')
    + (noPane.length ? ` · no pane ${noPane.length}` : '')
    + (close.length ? ` · close? ${close.length}: ${close.map((e) => `${e.seat} ${hours(now - (e.since ?? now))}`).join(', ')}` : '');
}

/**
 * OWNER-IDLE-WAKE — `eln seat pool` section: hands idle ≥ 10 min on a cell they own get the continue command (the same
 * owner ⊕ mail ⊕ idle-pane wake as an assignment, owner unchanged) instead of a reassignment. Empty when none.
 */
export function ownerIdleWakeLines(pool: readonly HandPoolEntry[], now: number): string[] {
  const idle = pool.filter((e) => e.state === 'working' && e.ownerIdle && e.cell);
  if (idle.length === 0) return [];
  return [`owner idle → wake (${idle.length}) — the owner continues its own cell; do not reassign:`,
    ...idle.map((e) => `  eln seat assign ${e.seat} ${e.cell} --why "owner idle ${e.since !== undefined ? hours(now - e.since) : '?'} — continue your cell"`)];
}

/** `eln seat pool` rows: live hands in the table; registry-only seats (no live pane) on one separate «no pane» line. */
export function handPoolLines(pool: readonly HandPoolEntry[], now: number): string[] {
  const noPane = pool.filter((e) => e.state === 'no-pane');
  const live = pool.filter((e) => e.state !== 'no-pane');
  return [...handPoolTable(live, now), ...(noPane.length ? [`no pane (${noPane.length}, registry only — not borrowable): ${noPane.map((e) => e.seat).join(' ')}`] : []),
    ...ownerIdleWakeLines(pool, now)];
}

function handPoolTable(pool: readonly HandPoolEntry[], now: number): string[] {
  const rows = pool.map((e) => [e.seat, e.home, e.state === 'working' ? `working(${e.scope}${e.cell ? `, ${e.cell}` : ''})` : 'idle',
    e.since !== undefined ? hours(now - e.since) : '-', e.pane ?? '-', e.ownerIdle ? 'owner idle → wake' : e.closeCandidate ? 'close?' : e.lent ? 'lent' : '']);
  const head = ['HAND', 'HOME', 'STATE', 'SINCE', 'PANE', 'NOTE'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [head, ...rows].map((cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd());
}
