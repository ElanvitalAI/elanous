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

import { parseChecklistTargetPaths, type ChecklistItem } from '../release-loop/checklist.js';
import { preapprovalLine, type PreapprovedPool } from './resource-preapproval.js';
import { isJudgeHand, pickPoolHand, POOL_SEAT, type HandPoolEntry } from './hand-pool.js';

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
}

export type SeatAssignResult =
  | { readonly ok: true; readonly seat: string; readonly cellId: string; readonly version: string; readonly from: string | null; readonly mailId: number;
    readonly dueAt: string; readonly wake: string; readonly writers: readonly AttributedWriter[]; readonly writerCheck: string; readonly lines: readonly string[];
    /** Set when the same seat+cell was assigned < 30 min ago and that mail is unanswered: no new mail, no wake. */ readonly already?: true;
    /** Set when the hand came from another scope's pool. */ readonly lend?: { readonly from: string; readonly to: string; readonly via: string } }
  | { readonly ok: false; readonly code: 'not-coordinator' | 'unknown-seat' | 'unknown-cell' | 'live-writer' | 'pool-empty' | 'judge-hand' | 'steward-owns'; readonly reason: string; readonly writers?: readonly AttributedWriter[] };

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
  writers: readonly AttributedWriter[]; writerCheck: string; pool: PreapprovedPool; actor: string; lendFrom?: string }): string {
  const done = input.item.doneCriterion?.trim() || `the cell title holds: ${input.item.title.slice(0, 120)}`;
  return [
    `[SEAT-ASSIGN] cell ${input.item.id} (${input.version}${input.item.priority ? ` · ${input.item.priority}` : ''}) → ${input.seat} · by ${input.actor}`,
    `title: ${input.item.title.slice(0, 160)}`,
    `done-when: ${done.slice(0, 240)}`,
    `due: ${input.due.toISOString()} (${hhmm(input.due)}, +30m) — first PR or a blocked line by then`,
    ...(input.why?.trim() ? [`why: ${input.why.trim().slice(0, 200)}`] : []),
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
  const log = (event: string, data: Record<string, unknown>) => { try { deps.log?.(event, data); } catch { /* fail-open */ } };
  const ladder = deps.coordinators();
  const coordinators = new Set(['OP', ...(ladder.hq ? [ladder.hq.toUpperCase()] : []), ...ladder.spaces.map(s => s.toUpperCase())]);
  if (!coordinators.has(actor) && !(actor && ladder.isCoordinator?.(actor))) {
    log('seat.assign.refused', { seat, cellId, actor, code: 'not-coordinator' });
    return { ok: false, code: 'not-coordinator', reason: `seat assign: ${actor || '(no seat)'} is not a coordinator (${[...coordinators].join(' · ')}${ladder.isCoordinator ? ' · space coordinators' : ''}) — pass --from <coordinator seat>` };
  }
  // FEDERATION HAND POOL — POOL picks; a named hand is looked up for its home (lend) — judge hands stay in their kingdom.
  let pooled: HandPoolEntry | undefined;
  if (deps.handPool && (seat === POOL_SEAT || !isJudgeHand(seat))) {
    let entries: readonly HandPoolEntry[] = [];
    try { entries = await deps.handPool(); } catch (error) { log('seat.assign.pool-unavailable', { actor, error: String(error).slice(0, 160) }); }
    if (seat === POOL_SEAT) {
      pooled = pickPoolHand(entries, actor);
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
  // PULL default: a live scope steward owns assignment; hands claim with `eln work next`. Assign is the exception path.
  const ownerScope = deps.liveStewardScope?.(seat) ?? null;
  if (ownerScope && !input.steward && !input.p0 && actor !== ownerScope) {
    log('seat.assign.refused', { seat, cellId, actor, code: 'steward-owns', scope: ownerScope });
    return { ok: false, code: 'steward-owns', reason: `seat assign: steward:${ownerScope} owns assignment; use --p0 for P0 (hands pull with \`eln work next\`)` };
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
  if (blocking.length) {
    const who = blocking.map(w => `${w.seat ?? 'unattributed'} ${w.ref}${w.branch ? ` (${w.branch})` : ''}`).join(' · ');
    log('seat.assign.refused', { seat, cellId, actor, code: 'live-writer', writers: blocking.map(w => w.ref) });
    return { ok: false, code: 'live-writer', reason: `seat assign: another live writer holds ${cellId}'s paths — ${who}`, writers };
  }
  const lend = pooled && pooled.home !== actor ? { from: pooled.home, to: actor, via: `steward:${(deps.hq ?? ladder.hq ?? 'OP').toUpperCase()}` } : undefined;
  const reason = `${input.why?.trim() || `seat assign by ${actor}`}${lend ? ` · pool.lend ${lend.from}→${lend.to}` : ''}`;
  const assigned = deps.assign(cell.version, cell.item.id, seat, { actor, reason });
  if (lend) log('pool.lend', { ...lend, seat, cell: cell.item.id, version: cell.version });
  const due = new Date(now.getTime() + ASSIGN_DUE_MS);
  const pool = deps.pool();
  const body = assignmentMailBody({ seat, item: cell.item, version: cell.version, due, ...(input.why ? { why: input.why } : {}), paths, writers, writerCheck, pool, actor, ...(lend ? { lendFrom: lend.from } : {}) });
  const mail = deps.post({ from: actor, to: seat, body, kind: SEAT_ASSIGN_MAIL_KIND, intent: 'request',
    doneWhen: cell.item.doneCriterion?.trim() || `cell ${cell.item.id}: a PR or a blocked line`, deadlineAt: due.toISOString(), refs: [`cell:${cell.item.id}`] });
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
  log('seat.assign', { seat, cellId: cell.item.id, version: cell.version, actor, from: assigned.from, outcome: assigned.outcome, mailId: mail.id, wake, writers: writers.length, writerCheck });
  const lines = [
    `✅ ${cell.item.id} → ${seat} (owner ${assigned.from ?? 'none'} → ${seat}${assigned.outcome === 'same' ? ', unchanged' : ''}) · mail #${mail.id} · due ${hhmm(due)} · wake ${wake}`,
    `writers (${writerCheck}):`,
    ...(writers.length ? writers.map(writerLine) : ['- none']),
    ...(lend ? [`🤝 pool.lend ${seat}: ${lend.from} → ${lend.to} (${lend.via}) — returns to the pool when ${cell.item.id} is green/done or its PR lands`] : []),
    preapprovalLine(pool),
  ];
  return { ok: true, seat, cellId: cell.item.id, version: cell.version, from: assigned.from, mailId: mail.id, dueAt: due.toISOString(), wake, writers, writerCheck, lines, ...(lend ? { lend } : {}) };
}
