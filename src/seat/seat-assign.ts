// OP-HANDLES-L2b ⊕ L5 (TRACE-OP-RESOURCE-OPTIMIZATION-1125 §5–§7): `eln seat assign <seat> <cell-id> [--why]` and the
// seat tool SeatAssign — one step from «idle hand × open cell» to «the hand is working on it».
//   1. the actor is a coordinator (HQ or a space coordinator, from the federation ladder — never a literal list);
//   2. the seat is a declared federation seat (seat registry ⊕ federation.yaml);
//   3. built-in owner check: open PRs / recent commits touching the cell's target paths are listed; the command refuses
//      ONLY when another seat's live writer (an open PR updated in the last 2 h) holds those paths — and prints who;
//   4. the cell owner becomes the seat (history: actor ⊕ reason);
//   5. one structured assignment mail (cell · done-when · due +30 m · writer table · pre-approved resource line);
//   6. the seat is woken when its pane is idle (wakeRecipient types only into an idle, empty pane).
// 세 얼굴: 관측 = `seat.assign` log line ⊕ checklist history ⊕ mail row · 판단 근거 = writer table in the mail/output ·
// 수복과 인계 = a refusal names the live writer (seat · PR) so the coordinator assigns elsewhere instead of asking around.
//
// OP-DIRECT-ASSIGN (CEO 11-26 18:2x · release 0.3.38 P0): the live scope 행정관 («steward:TC owns assignment») refused OP 3×
// for non-P0 cells while 16 hands sat idle, so OP fell back to mailing TC/UX. New default: while hands sit idle — any idle
// hand with no claimed cell, or ready cells < 2 × idle hands — HQ (OP) assigns directly past the steward, any priority.
// Other seats stay gated. The steward keeps a veto (`eln seat veto` · src/seat/seat-veto.ts): reason-bound, audited, mailed to OP.
//
// COORD-RIGHTS (CEO 11-27 08:0x «조율자가 다른 탭을 보고 컨트롤하는 게 막혀 있다 — 권한부터 더 주라»): the steward gate no
// longer refuses any coordinator. OP (HQ) assigns past a live steward always; a space coordinator (UX · JUD · MK …) assigns
// a borrowed hand past another scope's steward too. Each pass is audited (`seat.assign.op-direct` / `seat.assign.coord-direct`
// log ⊕ the history reason ⊕ the output line), and the steward keeps its veto. `--force` also passes a live writer (audited).
// The per-sender fold is 10 / 10 min (was 3 — OP was folded at its 4th assignment on 11-27 06:34).
//
// ASSIGN-CAP-POLICY (CEO 11-27 10:4x «고정값 금지 · 조율자는 막히면 안 된다»): live 10:41 the 행정관 assigned on OP's
// identity, so steward ⊕ OP shared one 10/10-min budget → `steward-refused code=rate-folded` while 25 hands sat idle and
// 39 cells stalled. Now: (1) the cap is policy — `seat.assign.rateMax` / `seat.assign.rateWindowMs` (config), default
// max(30, 2 × idle hands) per window for coordinators and steward actors, a small cap for anyone else; (2) a steward's
// assignments count under `steward:<scope>` (its mails carry that ref), not OP's; (3) the cap only folds duplicates and
// oscillation — one cell assigned more than ASSIGN_FLAP_MAX times in the window folds, and a distinct cell to an idle
// hand not yet assigned in the window always goes through; (4) every fold logs one `seat.assign.folded` line.

import { parseChecklistTargetPaths, type ChecklistItem } from '../release-loop/checklist.js';
import { preapprovalLine, type PreapprovedPool } from './resource-preapproval.js';
import { isJudgeHand, pickPoolHand, POOL_SEAT, type HandPoolEntry } from './hand-pool.js';
import { freeHands, noIdleHandLine, wip1Decide, type CellActivity, type HeldCell, type Wip1Decision, type Wip1Policy } from './seat-assign-wip1.js';

export const ASSIGN_DUE_MS = 30 * 60_000;
export const LIVE_WRITER_MS = 2 * 60 * 60_000;
export const SEAT_ASSIGN_MAIL_KIND = 'assign';
/** The same seat+cell is not re-assigned (no mail, no wake) while its last assign mail is this young and unanswered. */
export const ASSIGN_REPEAT_WINDOW_MS = 30 * 60_000;

export interface WriterRow {
  readonly kind: 'pr' | 'commit';
  /** `#123` or a short sha. */
  readonly ref: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly branch?: string;
  /** The files of this writer that touch the cell's paths. */
  readonly paths: readonly string[];
}

export interface AttributedWriter extends WriterRow {
  /** The federation seat named in the branch or title, when one is. */
  readonly seat?: string;
  /** An open PR updated within LIVE_WRITER_MS. Commits on main have landed: never live. */
  readonly live: boolean;
}

export interface SeatAssignInput {
  readonly seat: string;
  readonly cellId: string;
  readonly actor: string;
  readonly why?: string;
  readonly version?: string;
  /** P0/demo push past a live scope steward (`--p0`). */
  readonly p0?: boolean;
  /** The call comes from the scope steward itself (it already holds the shared wake claim). */
  readonly steward?: boolean;
  /** SEAT-ASSIGN-GUARD: a human's explicit override (`--force`) — past the off-target and rate guards. Never set by a loop. */
  readonly force?: boolean;
  /** SEAT-ASSIGN-GUARD: who called (resource-steward · next-action · cli:<ppid> …) — logged on every outcome. */
  readonly caller?: string;
}

// SEAT-ASSIGN-GUARD (11-27 P0 · after rail 74 still 35 `[SEAT-ASSIGN] … by OP` mails: 16:20Z ×17 · 16:44Z ×16 · 16:47Z ×2,
// all 0.3.37 cells, pulling hands off 0.3.38). The caller was the resource steward inside OP's TUI (`resource
// steward-assigned` · trigger «seat-idle …») spawning `eln seat assign` per matching-table row with the PLAN's version.
// The guard lives here so every path is covered: ≤3 assigns per sender per 10 min (the rest become a work-priority hint ·
// folded) and only cells of the current target release (`release.graph.version`) unless a human forces it.
// 출처: SEAT-ASSIGN-GUARD cell (coordinator 11-27 01:5x) — «≤3 assigns per sender per 10 min».
// ASSIGN-CAP-POLICY (11-27 10:4x): defaults only — `seat.assign.*` config overrides; the coordinator cap scales with the pool.
export const ASSIGN_RATE_WINDOW_MS = 10 * 60_000;
/** Coordinator / steward default cap = max(this, ASSIGN_RATE_IDLE_FACTOR × idle hands) per window. */
export const ASSIGN_RATE_COORD_FLOOR = 30;
export const ASSIGN_RATE_IDLE_FACTOR = 2;
/** A non-coordinator sender's default cap per window. */
export const ASSIGN_RATE_HAND_MAX = 3;
/** One cell assigned more than this many times in the window is oscillation — the next one folds. */
export const ASSIGN_FLAP_MAX = 2;

/** `seat.assign.*` in config.json — every field optional; absent/invalid = the pool-scaled default. */
export interface AssignRatePolicy { readonly rateMax?: number; readonly rateWindowMs?: number; readonly handRateMax?: number }

/** One assignment mail of the window: `by` is the rate key (`steward:<scope>` for a steward's mail, else the sender). */
export interface AssignLedgerRow { readonly from: string; readonly to: string; readonly cell: string; readonly by: string }

/** The rate key: a steward (space 행정관 `--steward` or the resource steward) counts under `steward:<scope>`, never the seat it acts for. */
export function assignRateActor(actor: string, opts: { readonly steward?: boolean; readonly caller?: string }): string {
  const a = actor.trim().toUpperCase();
  return opts.steward || opts.caller?.trim() === 'resource-steward' ? `steward:${a}` : a;
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** The per-window cap: config first, else coordinators/stewards max(floor, factor × idle hands), else the small hand cap. */
export function assignRateCap(input: { readonly coordinator: boolean; readonly idleHands: number; readonly policy?: AssignRatePolicy }): number {
  if (!input.coordinator) return positive(input.policy?.handRateMax) ?? ASSIGN_RATE_HAND_MAX;
  return positive(input.policy?.rateMax) ?? Math.max(ASSIGN_RATE_COORD_FLOOR, ASSIGN_RATE_IDLE_FACTOR * Math.max(0, input.idleHands));
}

export function assignRateWindowMs(policy?: AssignRatePolicy): number {
  return positive(policy?.rateWindowMs) ?? ASSIGN_RATE_WINDOW_MS;
}

export interface SeatAssignDeps {
  readonly now: () => Date;
  /** `spaces` = known space coordinator seats; `isCoordinator` = the live ladder's answer (depth HQ or space coordinator). */
  readonly coordinators: () => { readonly hq?: string; readonly spaces: readonly string[]; readonly isCoordinator?: (seat: string) => boolean };
  readonly federationSeats: () => ReadonlySet<string>;
  readonly findCell: (cellId: string, version?: string) => { readonly version: string; readonly item: ChecklistItem } | undefined;
  /** Open PRs and recent main commits touching any of these paths. A throw = the check is unavailable (never a refusal). */
  readonly writers: (paths: readonly string[]) => readonly WriterRow[];
  readonly assign: (version: string, cellId: string, seat: string, options: { actor: string; reason: string }) => { readonly from: string | null; readonly outcome: 'assigned' | 'same' };
  readonly post: (mail: { from: string; to: string; body: string; kind: string; intent: 'request'; doneWhen: string; deadlineAt: string; refs: string[] }) => { readonly id: number };
  readonly wake: (seat: string, mailId: number, from: string) => Promise<{ readonly result: string; readonly reason?: string }>;
  readonly pool: () => PreapprovedPool;
  /**
   * FEDERATION HAND POOL — the derived pool view (src/seat/hand-pool.ts). Present: `seat = POOL` borrows the longest-idle
   * hand (the actor's own scope first), and a hand whose home is another scope is logged as `pool.lend`. Absent: the seat
   * argument must name the hand, as before.
   */
  readonly handPool?: () => Promise<readonly HandPoolEntry[]> | readonly HandPoolEntry[];
  /** The HQ coordinator (cross-scope lends go through its 행정관: `via steward:<hq>`). */
  readonly hq?: string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * PULL default (대표 11-25 17:1x): the scope whose 행정관 is LIVE for this hand (null = none). While it is live the steward
   * owns assignment in that scope — another seat's assign is refused unless `--p0` (P0/demo) or the steward itself.
   */
  readonly liveStewardScope?: (seat: string) => string | null;
  /**
   * ASSIGN-IDEMPOTENT (11-25 17:5x · OP loop: 77 assign mails in 20 min, 39 distinct, one cell to MVP-B 9× in 11 min):
   * the latest assign mail to this seat for this cell since `sinceMs`, and whether anyone answered it. Absent = no check.
   */
  readonly recentAssign?: (seat: string, cellId: string, sinceMs: number) => { readonly id: number; readonly atMs: number; readonly answered: boolean } | null;
  /** SHARED-WAKE-LEDGER: claim the 20-min wake window for the seat (any waker). Absent = no shared ledger. */
  readonly claimWake?: (seat: string, cellId: string, by: string) => { readonly ok: true } | { readonly ok: false; readonly line: string };
  /** ASSIGN-CAP-POLICY: every assignment mail since `sinceMs` (any sender). Absent = no rate guard. A throw = none. */
  readonly assignLedger?: (sinceMs: number) => readonly AssignLedgerRow[];
  /** ASSIGN-CAP-POLICY: `seat.assign.*` from config. Absent or a throw = the pool-scaled default. */
  readonly ratePolicy?: () => AssignRatePolicy | null;
  /** SEAT-ASSIGN-GUARD: the current target release (`release.graph.version`). null/absent = no version guard. */
  readonly targetVersion?: () => string | null;
  /** SEAT-ASSIGN-GUARD: a folded assign becomes a pull hint (priorityOrder ⊕ hint) — the hand claims on `eln work next`. */
  readonly hint?: (cellId: string, seat: string, by: string) => void;
  /** MODEL-BY-DIFFICULTY: set the hand's model for this cell (writes the seat directive) → the mail line. Absent = no routing. */
  readonly modelFor?: (seat: string, item: ChecklistItem, paths: readonly string[]) => { readonly line: string; readonly tier: string } | null;
  /** OP-DIRECT-ASSIGN: open (yellow) cells nobody owns — the board's «ready» count. Absent or a throw = 0. */
  readonly readyCells?: () => number;
  /** WIP1-ASSIGN-GUARD: the cells of the current release (owner ⊕ status ⊕ priority ⊕ updatedAt). Absent = no WIP-1 guard. */
  readonly heldCells?: () => readonly HeldCell[];
  /** WIP1-ASSIGN-GUARD: graphs/policies/seat-assign.yaml `wip1`. A throw = the guard is unavailable (logged, assign proceeds). */
  readonly wip1Policy?: () => Wip1Policy;
  /** WIP1-ASSIGN-GUARD: put a hand's cell back on the board through the veto path (CAS ⊕ history row ⊕ mail). */
  readonly returnToBoard?: (cellId: string, reason: string) => { readonly ok: boolean; readonly line: string };
  /** WIP1-ASSIGN-GUARD-ACTIVE: the latest commit · push · worktree edit/test on the hand's cell since a time. Absent = ledger ⊕ pane only. */
  readonly cellActivity?: (seat: string, ...args: Parameters<CellActivity>) => ReturnType<CellActivity>;
}

/** The idle-hands pressure that opens HQ's direct assignment past a live scope steward. */
export interface IdlePressure { readonly idle: number; readonly idleUnclaimed: number; readonly ready: number }

/** OP-DIRECT-ASSIGN rule: hands sit idle — any idle hand with no claimed cell, or ready < 2 × idle. No idle hand = closed. */
export function opDirectAssignOpen(p: IdlePressure): boolean {
  return p.idle > 0 && (p.idleUnclaimed > 0 || p.ready < 2 * p.idle);
}

export function idlePressureOf(entries: readonly HandPoolEntry[], ready: number): IdlePressure {
  const idle = entries.filter(e => e.state === 'idle');
  return { idle: idle.length, idleUnclaimed: idle.filter(e => !e.cell).length, ready };
}

export type SeatAssignResult =
  | { readonly ok: true; readonly seat: string; readonly cellId: string; readonly version: string; readonly from: string | null; readonly mailId: number;
    readonly dueAt: string; readonly wake: string; readonly writers: readonly AttributedWriter[]; readonly writerCheck: string; readonly lines: readonly string[];
    /** Set when the same seat+cell was assigned < 30 min ago and that mail is unanswered: no new mail, no wake. */ readonly already?: true;
    /** Set when the hand came from another scope's pool. */ readonly lend?: { readonly from: string; readonly to: string; readonly via: string };
    /** OP-DIRECT-ASSIGN: HQ assigned past this live scope steward (which keeps a veto) under this idle pressure. */
    readonly opDirect?: { readonly steward: string; readonly pressure: IdlePressure; readonly by: 'op-direct' | 'coord-direct' };
    /** WIP1-ASSIGN-GUARD: cells of the hand put back on the board (lower priority preempted · stale). */
    readonly returned?: readonly string[] }
  | { readonly ok: false; readonly code: 'not-coordinator' | 'unknown-seat' | 'unknown-cell' | 'live-writer' | 'pool-empty' | 'judge-hand' | 'steward-owns' | 'off-target' | 'rate-folded' | 'wip-1'; readonly reason: string; readonly writers?: readonly AttributedWriter[]; readonly suggest?: string };

const PATH_TOKEN = /(?:^|[\s`'"(])((?:src|scripts|docs|bin|tests?|packages|apps|\.rules)\/[A-Za-z0-9_.\/-]+)/g;

/** The cell's target paths: the labelled «대상 경로:» line of title/body ⊕ repo-looking paths in body/doneCriterion. */
export function cellTargetPaths(item: Pick<ChecklistItem, 'title' | 'body' | 'doneCriterion'>): string[] {
  const out = new Set<string>();
  for (const text of [item.title, item.body ?? '']) for (const path of parseChecklistTargetPaths(text)) if (path) out.add(path);
  for (const text of [item.body ?? '', item.doneCriterion ?? '']) for (const match of text.matchAll(PATH_TOKEN)) out.add(match[1]!.replace(/[.,;:)]+$/, ''));
  return [...out].filter(path => path.length > 0 && !path.includes('..'));
}

/** True when a changed file and a target path are the same file or one contains the other. */
export function pathTouches(file: string, target: string): boolean {
  const a = file.replace(/\/+$/, '');
  const b = target.replace(/\/+$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Name the seat behind a writer: the longest federation seat id that appears as a whole token in branch ⊕ title. */
export function attributeWriter(row: WriterRow, seats: ReadonlySet<string>, now: Date): AttributedWriter {
  const text = `${row.branch ?? ''} ${row.title}`.toUpperCase();
  const seat = [...seats].sort((x, y) => y.length - x.length)
    .find(id => new RegExp(`(^|[^A-Z0-9-])${id.replace(/[-]/g, '\\-')}($|[^A-Z0-9-])`).test(text));
  const age = now.getTime() - Date.parse(row.updatedAt);
  return { ...row, ...(seat ? { seat } : {}), live: row.kind === 'pr' && Number.isFinite(age) && age <= LIVE_WRITER_MS };
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function writerLine(writer: AttributedWriter): string {
  return `- ${writer.kind === 'pr' ? 'PR' : 'commit'} ${writer.ref} · ${writer.seat ?? 'seat ?'} · ${writer.live ? 'LIVE' : writer.kind === 'pr' ? 'stale' : 'landed'} · ${writer.updatedAt.slice(0, 16)} · ${writer.title.slice(0, 70)}${writer.paths.length ? ` · ${writer.paths.slice(0, 3).join(', ')}` : ''}`;
}

export function assignmentMailBody(input: { seat: string; item: ChecklistItem; version: string; due: Date; why?: string; paths: readonly string[];
  writers: readonly AttributedWriter[]; writerCheck: string; pool: PreapprovedPool; actor: string; lendFrom?: string; modelLine?: string }): string {
  const done = input.item.doneCriterion?.trim() || `the cell title holds: ${input.item.title.slice(0, 120)}`;
  return [
    `[SEAT-ASSIGN] cell ${input.item.id} (${input.version}${input.item.priority ? ` · ${input.item.priority}` : ''}) → ${input.seat} · by ${input.actor}`,
    `title: ${input.item.title.slice(0, 160)}`,
    `done-when: ${done.slice(0, 240)}`,
    `due: ${input.due.toISOString()} (${hhmm(input.due)}, +30m) — first PR or a blocked line by then`,
    ...(input.why?.trim() ? [`why: ${input.why.trim().slice(0, 200)}`] : []),
    ...(input.modelLine ? [input.modelLine] : []),
    ...(input.lendFrom ? [`borrowed from the ${input.lendFrom} pool — you return to the pool when this cell is green/done or its PR lands`] : []),
    `target paths: ${input.paths.length ? input.paths.join(' · ') : 'none declared in the cell'}`,
    `writer check is built in: open PRs/recent commits on the cell's paths shown below (${input.writerCheck}) — no other live writer, so do not ask «기존 writer·중복» first`,
    ...(input.writers.length ? input.writers.map(writerLine) : ['- none']),
    preapprovalLine(input.pool),
    'You own this cell now. Start; reply only with a PR number or a blocked line.',
  ].join('\n');
}

export async function seatAssign(input: SeatAssignInput, deps: SeatAssignDeps): Promise<SeatAssignResult> {
  let seat = input.seat.trim().toUpperCase();
  const actor = input.actor.trim().toUpperCase();
  const cellId = input.cellId.trim();
  const caller = input.caller?.trim() || 'unknown';
  const log = (event: string, data: Record<string, unknown>) => { try { deps.log?.(event, event.startsWith('seat.assign') ? { ...data, caller } : data); } catch { /* fail-open */ } };
  const ladder = deps.coordinators();
  const coordinators = new Set(['OP', ...(ladder.hq ? [ladder.hq.toUpperCase()] : []), ...ladder.spaces.map(s => s.toUpperCase())]);
  if (!coordinators.has(actor) && !(actor && ladder.isCoordinator?.(actor))) {
    log('seat.assign.refused', { seat, cellId, actor, code: 'not-coordinator' });
    return { ok: false, code: 'not-coordinator', reason: `seat assign: ${actor || '(no seat)'} is not a coordinator (${[...coordinators].join(' · ')}${ladder.isCoordinator ? ' · space coordinators' : ''}) — pass --from <coordinator seat>` };
  }
  // FEDERATION HAND POOL — POOL picks; a named hand is looked up for its home (lend) — judge hands stay in their kingdom.
  let pooled: HandPoolEntry | undefined;
  let poolEntries: readonly HandPoolEntry[] | undefined;
  if (deps.handPool && (seat === POOL_SEAT || !isJudgeHand(seat))) {
    let entries: readonly HandPoolEntry[] = [];
    try { entries = await deps.handPool(); poolEntries = entries; } catch (error) { log('seat.assign.pool-unavailable', { actor, error: String(error).slice(0, 160) }); }
    if (seat === POOL_SEAT) {
      // WIP1-SUGGEST-IDLE: POOL never picks a hand with an active cell (the WIP-1 guard's definition) — none free = stays on board.
      let candidates = entries;
      let free = false;
      try {
        const policy = deps.heldCells && deps.wip1Policy ? deps.wip1Policy() : null;
        if (policy && deps.heldCells) { candidates = freeHands(entries, deps.heldCells(), deps.now().getTime(), policy); free = true; }
      } catch (error) { log('seat.assign.wip1-unavailable', { seat, cellId, actor, error: String(error).slice(0, 160) }); }
      pooled = pickPoolHand(candidates, actor);
      if (!pooled && free) {
        log('seat.assign.refused', { seat, cellId, actor, code: 'pool-empty', why: 'no-free-hand' });
        return { ok: false, code: 'pool-empty', reason: `seat assign: ${noIdleHandLine(cellId)} (${entries.length} hands, none with zero active cells)` };
      }
      if (!pooled) {
        log('seat.assign.refused', { seat, cellId, actor, code: 'pool-empty' });
        return { ok: false, code: 'pool-empty', reason: `seat assign: no idle hand in the federation pool (${entries.length} hands, all working) — eln seat pool` };
      }
      seat = pooled.seat;
    } else pooled = entries.find(e => e.seat === seat);
  } else if (seat === POOL_SEAT) {
    return { ok: false, code: 'pool-empty', reason: 'seat assign: the hand pool view is unavailable here — name the hand' };
  }
  if (isJudgeHand(seat) && !isJudgeHand(actor)) {
    log('seat.assign.refused', { seat, cellId, actor, code: 'judge-hand' });
    return { ok: false, code: 'judge-hand', reason: `seat assign: ${seat} is a judge hand (judiciary kingdom only) — it is not in the federation hand pool` };
  }
  const seats = deps.federationSeats();
  if (!seats.has(seat)) {
    log('seat.assign.refused', { seat, cellId, actor, code: 'unknown-seat' });
    return { ok: false, code: 'unknown-seat', reason: `seat assign: ${seat} is not a registered federation seat (seat registry ⊕ federation.yaml)` };
  }
  const cell = deps.findCell(cellId, input.version);
  if (!cell) {
    log('seat.assign.refused', { seat, cellId, actor, code: 'unknown-cell' });
    return { ok: false, code: 'unknown-cell', reason: `seat assign: no cell ${cellId}${input.version ? ` in ${input.version}` : ''}` };
  }
  // ASSIGN-IDEMPOTENT: the same seat+cell assigned < 30 min ago, still unanswered → no new mail, no wake, no owner write.
  const nowMs = deps.now().getTime();
  let recent: ReturnType<NonNullable<SeatAssignDeps['recentAssign']>> = null;
  try { recent = deps.recentAssign?.(seat, cell.item.id, nowMs - ASSIGN_REPEAT_WINDOW_MS) ?? null; } catch { recent = null; }
  if (recent && !recent.answered) {
    const line = `already assigned #${recent.id} at ${hhmm(new Date(recent.atMs))} — ${cell.item.id} → ${seat} (unanswered; no new mail, no wake)`;
    log('seat.assign.already', { seat, cellId: cell.item.id, actor, mailId: recent.id });
    return { ok: true, seat, cellId: cell.item.id, version: cell.version, from: cell.item.owner ?? null, mailId: recent.id,
      dueAt: new Date(recent.atMs + ASSIGN_DUE_MS).toISOString(), wake: 'skipped (already assigned)', writers: [], writerCheck: 'not re-checked', lines: [`↺ ${line}`], already: true };
  }
  // SEAT-ASSIGN-GUARD ① — only the current target release, unless a human forces it.
  let target: string | null = null;
  try { target = deps.targetVersion?.() ?? null; } catch { target = null; }
  if (target && cell.version !== target && !input.force) {
    log('seat.assign.refused', { seat, cellId: cell.item.id, actor, code: 'off-target', version: cell.version, target });
    return { ok: false, code: 'off-target', reason: `seat assign: ${cell.item.id} is a ${cell.version} cell — the target release is ${target} (release.graph.version); a human can pass --force` };
  }
  // WIP1-ASSIGN-GUARD — a hand holds ONE active cell (every caller: OP · coordinators · stewards; --force/--p0 do not lift it).
  // Only hands are bound: the seat must be in the federation hand pool view. Refusal here; returns run after the writer check.
  let wip1: Wip1Decision | null = null;
  if (deps.heldCells && poolEntries?.some(e => e.seat.toUpperCase() === seat)) {
    try {
      const policy = deps.wip1Policy?.();
      if (!policy) throw new Error('no wip1 policy');
      const activityOf = deps.cellActivity;
      wip1 = wip1Decide({ seat, cell: cell.item, held: deps.heldCells(), pool: poolEntries, nowMs, policy, ...(activityOf ? { activity: (id: string, since: number) => activityOf(seat, id, since) } : {}) });
    } catch (error) { log('seat.assign.wip1-unavailable', { seat, cellId: cell.item.id, actor, error: String(error).slice(0, 160) }); wip1 = null; }
    if (wip1?.kind === 'refuse') {
      log('seat.assign.refused', { seat, cellId: cell.item.id, actor, code: 'wip-1', why: wip1.why, holder: wip1.holder.id, holderPriority: wip1.holder.priority ?? null, priority: cell.item.priority ?? null, ...(wip1.suggest ? { suggest: wip1.suggest } : {}) });
      return { ok: false, code: 'wip-1', reason: `seat assign: ${wip1.line}`, ...(wip1.suggest ? { suggest: wip1.suggest } : {}) };
    }
  }
  // SEAT-ASSIGN-GUARD ② ⊕ ASSIGN-CAP-POLICY — fold only oscillation and over-cap repeats; a distinct cell to an idle,
  // not-yet-assigned hand always goes through. The cap is per rate key (a steward never spends its coordinator's budget).
  const rateActor = assignRateActor(actor, { ...(input.steward ? { steward: true } : {}), caller });
  let policy: AssignRatePolicy | null = null;
  try { policy = deps.ratePolicy?.() ?? null; } catch { policy = null; }
  const windowMs = assignRateWindowMs(policy ?? undefined);
  let ledger: readonly AssignLedgerRow[] = [];
  try { ledger = deps.assignLedger?.(nowMs - windowMs) ?? []; } catch { ledger = []; }
  if (deps.assignLedger && !input.force) {
    const idleSeats = new Set((poolEntries ?? []).filter(e => e.state === 'idle').map(e => e.seat.toUpperCase()));
    const cap = assignRateCap({ coordinator: true, idleHands: idleSeats.size, ...(policy ? { policy } : {}) });
    const sent = ledger.filter(r => r.by.toUpperCase() === rateActor.toUpperCase()).length;
    const cellAssigns = ledger.filter(r => r.cell === cell.item.id).length;
    const handFresh = !ledger.some(r => r.to.toUpperCase() === seat);
    const distinctIdle = idleSeats.has(seat) && handFresh && cellAssigns === 0;
    const flap = cellAssigns >= ASSIGN_FLAP_MAX;
    if (flap || (sent >= cap && !distinctIdle)) {
      const why = flap ? 'flap' : 'cap';
      let hinted = 'no hint path';
      try { if (deps.hint) { deps.hint(cell.item.id, seat, actor); hinted = `hinted ${cell.item.id} → ${seat} (eln work priority)`; } } catch (error) { hinted = `hint failed: ${String(error).slice(0, 80)}`; }
      log('seat.assign.folded', { seat, cellId: cell.item.id, actor, rateActor, why, sent, cap, cellAssigns, windowMin: Math.round(windowMs / 60_000), idleHands: idleSeats.size, hinted });
      const detail = flap
        ? `${cell.item.id} was already assigned ${cellAssigns}× in ${Math.round(windowMs / 60_000)} min (oscillation, max ${ASSIGN_FLAP_MAX})`
        : `${rateActor} already sent ${sent} assignments in ${Math.round(windowMs / 60_000)} min (cap ${cap} = max(${ASSIGN_RATE_COORD_FLOOR}, ${ASSIGN_RATE_IDLE_FACTOR} × ${idleSeats.size} idle) or seat.assign.rateMax) and ${seat} is not a fresh idle hand`;
      return { ok: false, code: 'rate-folded', reason: `seat assign: ${detail} — folded: ${hinted}; ${seat} pulls it with eln work next` };
    }
  }

  // PULL default: a live scope steward owns assignment; hands claim with `eln work next`. Assign is the exception path.
  // COORD-RIGHTS: a coordinator is never refused here — the pass is audited and the steward keeps its veto.
  const ownerScope = deps.liveStewardScope?.(seat) ?? null;
  let opDirect: { steward: string; pressure: IdlePressure; by: 'op-direct' | 'coord-direct' } | undefined;
  if (ownerScope && !input.steward && !input.p0 && actor !== ownerScope) {
    const hq = (deps.hq ?? ladder.hq ?? 'OP').toUpperCase();
    let entries: readonly HandPoolEntry[] = [];
    try { entries = deps.handPool ? await deps.handPool() : []; } catch (error) { log('seat.assign.pool-unavailable', { actor, error: String(error).slice(0, 160) }); }
    let ready = 0;
    try { ready = Math.max(0, deps.readyCells?.() ?? 0); } catch { ready = 0; }
    const pressure = idlePressureOf(entries, ready);
    const by = actor === 'OP' || actor === hq ? 'op-direct' as const : 'coord-direct' as const;
    opDirect = { steward: ownerScope, pressure, by };
    log(`seat.assign.${by}`, { seat, cellId, actor, steward: ownerScope, ...pressure });
  }
  const now = deps.now();
  const paths = cellTargetPaths(cell.item);
  let writers: AttributedWriter[] = [];
  let writerCheck = paths.length ? 'checked' : 'no target paths declared';
  if (paths.length) {
    try { writers = deps.writers(paths).map(row => attributeWriter(row, seats, now)); }
    catch (error) { writerCheck = `writer check unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160); }
  }
  const blocking = writers.filter(w => w.live && w.seat !== seat);
  const forcedPast = blocking.length && input.force ? blocking.map(w => `${w.seat ?? 'unattributed'} ${w.ref}`).join(' · ') : '';
  if (forcedPast) log('seat.assign.force-past-writer', { seat, cellId, actor, writers: blocking.map(w => w.ref) });
  if (blocking.length && !input.force) {
    const who = blocking.map(w => `${w.seat ?? 'unattributed'} ${w.ref}${w.branch ? ` (${w.branch})` : ''}`).join(' · ');
    log('seat.assign.refused', { seat, cellId, actor, code: 'live-writer', writers: blocking.map(w => w.ref) });
    return { ok: false, code: 'live-writer', reason: `seat assign: another live writer holds ${cellId}'s paths — ${who}`, writers };
  }
  // WIP1-ASSIGN-GUARD — preempted lower cells ⊕ stale cells go back to the board (veto path) before the owner write.
  const returned: string[] = [];
  const returnLines: string[] = [];
  if (wip1 && deps.returnToBoard) { // a refuse already returned above
    const rows = [...(wip1.kind === 'preempt' ? wip1.returns.map(c => ({ c, why: `WIP-1: ${actor} assigned ${cell.item.id} (${cell.item.priority ?? '-'}) to ${seat}, above ${c.id} (${c.priority ?? '-'})` })) : []),
      ...wip1.stale.map(c => ({ c, why: `WIP-1: ${seat} takes ${cell.item.id}; ${c.id} had no activity in the window (stale)` }))];
    for (const { c, why } of rows) {
      let r: { ok: boolean; line: string };
      try { r = deps.returnToBoard(c.id, why); } catch (error) { r = { ok: false, line: String(error).slice(0, 120) }; }
      log('seat.assign.wip-return', { seat, cellId: cell.item.id, actor, returned: c.id, ok: r.ok, why, line: r.line.slice(0, 160) });
      if (r.ok) returned.push(c.id);
      returnLines.push(`${r.ok ? '↩' : '⚠'} ${r.line}`);
    }
  }
  const lend = pooled && pooled.home !== actor ? { from: pooled.home, to: actor, via: `steward:${(deps.hq ?? ladder.hq ?? 'OP').toUpperCase()}` } : undefined;
  const reason = `${input.why?.trim() || `seat assign by ${actor}`}${lend ? ` · pool.lend ${lend.from}→${lend.to}` : ''}${opDirect ? ` · ${opDirect.by} past steward:${opDirect.steward} (idle ${opDirect.pressure.idle} · ready ${opDirect.pressure.ready})` : ''}${forcedPast ? ` · force past live writer ${forcedPast}` : ''}`;
  const assigned = deps.assign(cell.version, cell.item.id, seat, { actor, reason });
  if (lend) log('pool.lend', { ...lend, seat, cell: cell.item.id, version: cell.version });
  const due = new Date(now.getTime() + ASSIGN_DUE_MS);
  const pool = deps.pool();
  // MODEL-BY-DIFFICULTY: the hand's model is set before it starts (directive → its next turn); the tier rides in the mail.
  let model: { readonly line: string; readonly tier: string } | null = null;
  try { model = deps.modelFor?.(seat, cell.item, paths) ?? null; } catch (error) { log('seat.model-failed', { seat, cellId: cell.item.id, error: String(error).slice(0, 120) }); }
  const body = assignmentMailBody({ seat, item: cell.item, version: cell.version, due, ...(input.why ? { why: input.why } : {}), paths, writers, writerCheck, pool, actor, ...(lend ? { lendFrom: lend.from } : {}), ...(model ? { modelLine: model.line } : {}) });
  const mail = deps.post({ from: actor, to: seat, body, kind: SEAT_ASSIGN_MAIL_KIND, intent: 'request',
    doneWhen: cell.item.doneCriterion?.trim() || `cell ${cell.item.id}: a PR or a blocked line`, deadlineAt: due.toISOString(),
    refs: [`cell:${cell.item.id}`, ...(rateActor.startsWith('steward:') ? [rateActor] : [])] });
  let wake = 'not-attempted';
  // SHARED-WAKE-LEDGER: any waker inside 20 min → no second wake (the assignment mail still stands). The steward claimed already.
  let claim: { readonly ok: true } | { readonly ok: false; readonly line: string } = { ok: true };
  if (!input.steward && deps.claimWake) {
    try { claim = deps.claimWake(seat, cell.item.id, actor); } catch { claim = { ok: true }; }
  }
  if (!claim.ok) wake = `skipped (${claim.line})`;
  else {
    try { const woke = await deps.wake(seat, mail.id, actor); wake = woke.reason ? `${woke.result} (${woke.reason})` : woke.result; }
    catch (error) { wake = `failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  log('seat.assign', { seat, cellId: cell.item.id, version: cell.version, actor, from: assigned.from, outcome: assigned.outcome, mailId: mail.id, wake, writers: writers.length, writerCheck, ...(opDirect ? { opDirect: opDirect.steward } : {}), ...(model ? { tier: model.tier } : {}) });
  const lines = [
    `✅ ${cell.item.id} → ${seat} (owner ${assigned.from ?? 'none'} → ${seat}${assigned.outcome === 'same' ? ', unchanged' : ''}) · mail #${mail.id} · due ${hhmm(due)} · wake ${wake}`,
    `writers (${writerCheck}):`,
    ...(writers.length ? writers.map(writerLine) : ['- none']),
    ...(lend ? [`🤝 pool.lend ${seat}: ${lend.from} → ${lend.to} (${lend.via}) — returns to the pool when ${cell.item.id} is green/done or its PR lands`] : []),
    ...(opDirect ? [`⚡ ${opDirect.by} past steward:${opDirect.steward} (idle ${opDirect.pressure.idle} · ready ${opDirect.pressure.ready}) — veto: eln seat veto ${cell.item.id} --from ${opDirect.steward} --reason <line> [--to <seat>]`] : []),
    ...returnLines,
    ...(model ? [model.line] : []),
    preapprovalLine(pool),
  ];
  return { ok: true, seat, cellId: cell.item.id, version: cell.version, from: assigned.from, mailId: mail.id, dueAt: due.toISOString(), wake, writers, writerCheck, lines, ...(lend ? { lend } : {}), ...(opDirect ? { opDirect } : {}), ...(returned.length ? { returned } : {}) };
}
