// FED-OBSERVE — `eln fed snapshot` (대표 11-26 23:3x «특정 턴 동안 관찰하는 도구 … 정식으로 만들어 주세요»).
//
// S: the night of 11-26 Claude OP watched the federation with a shell script (seat-state/OP/tools/fed-observe-1126.sh) that
//    scraped pane screens (`els read`) for «Queue N», «Could not process» and «HH:MM에 점검» — a regex missed «23:27에 …
//    점검합니다», and the answer lived only in Claude OP's terminal.
// C: every fact it scraped already has a structured home: els panes (state · build · unread mail), the eln session store
//    (turns), the log store (errors · Cap refusals · queue holds), the msg store (unacked · ✋), fed-state (blocks · KPIs),
//    the cell-block ledger, the commitment ledger, the land-graph ledger, the trigger registry and the release checklist.
// Q: what one call answers «what is the federation doing, and what is abnormal» from those facts — for a person, for OP's
//    pulse and for the board?
// A: this file is the PURE half: `buildFedSnapshot(sources)` folds fail-open source readings (null = not measured, never 0)
//    into one snapshot; `detectAnomalies` applies named rules with one-line whys; the formatters print a table and a capped
//    anomaly block. The I/O half is snapshot-live.ts; the CLI saves every snapshot (rotating) under the fed-state dir.
//
// 세 얼굴: 관측 = the snapshot itself (+ `unmeasured` names every source that could not be read) · 판단 근거 = each anomaly
// carries its rule id and the facts behind it · 수복과 인계 = the anomaly block rides OP's pulse digest (≤1.5k chars).

export type SeatRole = 'coordinator' | 'hand' | 'loop' | 'other';
export type TurnOutcome = 'did' | 'reply' | 'no-op' | 'failed' | 'running' | 'unknown';

export interface PaneIn {
  readonly seat: string;
  readonly workspace?: string;
  readonly kind?: string;
  /** SEAT-STATE-ENUM state (WORKING · IDLE · EXITED …) and since (epoch ms). */
  readonly status?: { readonly state?: string; readonly since?: number };
  readonly build?: { readonly sha?: string; readonly age?: string; readonly stamp?: string; readonly desired?: string };
  readonly stalled?: boolean;
  readonly unreadMail?: { readonly count?: number; readonly oldestCreatedAt?: string | null };
  readonly reach?: string;
  readonly sessionId?: string | null;
  /** The workspace says this seat is its coordinator. */
  readonly coordinator?: boolean;
}

export interface PoolIn { readonly seat: string; readonly home: string; readonly state: 'idle' | 'working' | 'no-pane'; readonly cell?: string; readonly since?: number }
export interface TurnIn { readonly seat: string; readonly at: string | null; readonly outcome: TurnOutcome; readonly why?: string }
/** A log row already attributed to a seat. `kind`: fatal = the turn was lost (Could not process · over-budget · request
 *  too large · agent failed) · cap = a turn the gate refused (reason Cap) · error = any other error-level row. */
export interface ErrorIn { readonly seat: string; readonly at: string; readonly kind: 'fatal' | 'cap' | 'error'; readonly what: string }
export interface QueueIn { readonly seat: string; readonly held: number }
export interface MailIn { readonly seat: string; readonly unacked: number; readonly oldestAt: string | null }
export interface HandRaiseIn { readonly id: number; readonly from: string; readonly to: string; readonly blockedSeat: string; readonly reason: string; readonly waitedMs: number }
/** A cell a hand could not continue: open block rows ⊕ recent `work:block` facts. `on` = the seat it waits on. */
export interface BlockIn { readonly by: string; readonly on: string | null; readonly cell: string; readonly reason: string; readonly at: string }

/** One HOLD ledger row (src/hold-ledger) as the snapshot needs it. */
export type HoldLedgerIn = import('../hold-ledger/hold-ledger.js').Hold;

export interface FedSources {
  readonly now: Date;
  /** HOLD-AS-LEDGER-OBJECT: the HOLD ledger (null/absent = unreadable → hold-freeze falls back to the HOLD words of block reasons). */
  readonly holdLedger?: readonly HoldLedgerIn[] | null;
  readonly installedSha: string | null;
  readonly panes: readonly PaneIn[] | null;
  readonly pool: readonly PoolIn[] | null;
  readonly turns: readonly TurnIn[] | null;
  readonly errors: readonly ErrorIn[] | null;
  readonly queues: readonly QueueIn[] | null;
  readonly mail: readonly MailIn[] | null;
  readonly hands: readonly HandRaiseIn[] | null;
  readonly blocks: readonly BlockIn[] | null;
  readonly landingFreeze: { readonly reason: string; readonly by: string; readonly until: string | null } | null;
  readonly landHolds: readonly { readonly pr: string; readonly reason: string; readonly by: string }[] | null;
  readonly commitments: { readonly seat: string; readonly open: number; readonly overdue: number; readonly action: number } | null;
  readonly land: { readonly lastAt: string | null; readonly landedToday: number; readonly pending: number; readonly mode: string } | null;
  readonly judge: { readonly queue: number; readonly medianWaitMin: number | null } | null;
  readonly loops: { readonly windowMin: number; readonly ok: number; readonly goalNotMet: number; readonly failed: number; readonly stale: number; readonly running: number; readonly failing: readonly string[] } | null;
  readonly release: { readonly version: string; readonly green: number; readonly yellow: number; readonly total: number } | null;
  readonly kpi: { readonly landedPerHour: number; readonly opInboundPerHour: number; readonly idleWithWork: readonly string[] } | null;
  /** WORLD-REGISTRY one-liner from the lease ledger (absent/null = unread). */
  readonly world?: FedWorld | null;
  /** ALLOCATION-BUDGET one line («예산: codex 68% · openrouter $893 (오늘 $12/$50) · 상위 소비 …») — absent/null = unmeasured. */
  readonly budget?: string | null;
  readonly unmeasured: readonly string[];
}

/** WORLD-REGISTRY digest as the snapshot carries it (src/resource-ledger/world-summary.ts). */
export interface FedWorld { readonly line: string; readonly stale: boolean; readonly zombie: number; readonly unregistered: number; readonly noOwner: number }

export interface SeatRow {
  readonly seat: string;
  readonly role: SeatRole;
  readonly workspace: string | null;
  readonly pane: string;
  readonly since: string | null;
  readonly build: { readonly sha: string | null; readonly age: string | null; readonly desired: string | null };
  readonly stalled: boolean;
  readonly queue: number | null;
  readonly lastTurn: TurnIn | null;
  readonly errors: { readonly fatal: number; readonly cap: number; readonly other: number; readonly last: string | null; readonly lastFatal: string | null } | null;
  readonly mail: { readonly unacked: number; readonly oldestAgeMin: number | null } | null;
  readonly hand: { readonly state: string; readonly cell: string | null; readonly holding: boolean } | null;
  readonly session: string | null;
}

export interface Anomaly { readonly rule: string; readonly seat?: string; readonly severity: 'red' | 'yellow'; readonly why: string }

export interface FedSnapshot {
  readonly at: string;
  readonly installedSha: string | null;
  readonly seats: readonly SeatRow[];
  readonly totals: { readonly seats: number; readonly hands: { readonly idle: number; readonly holding: number; readonly working: number; readonly noPane: number } | null };
  readonly handsRaised: readonly HandRaiseIn[] | null;
  readonly holds: { readonly landingFreeze: FedSources['landingFreeze']; readonly landHolds: FedSources['landHolds']; readonly blockedOn: readonly BlockedOnGroup[] | null; readonly ledger?: { readonly active: number; readonly ids: readonly string[] } | null };
  readonly commitments: FedSources['commitments'];
  readonly land: FedSources['land'];
  readonly judge: FedSources['judge'];
  readonly loops: FedSources['loops'];
  readonly release: FedSources['release'];
  readonly kpi: FedSources['kpi'];
  readonly world?: FedWorld | null;
  readonly budget?: string | null;
  readonly anomalies: readonly Anomaly[];
  readonly unmeasured: readonly string[];
}

// ── thresholds (each one named; a rule that fires names its threshold in the why) ───────────────────────────────────
// 출처: OPS-RULES ✋ ladder — a ✋ that waits an hour has outlived every rung (lead 15m · OP 30m · CEO card).
export const HAND_UNANSWERED_MIN = 60;
// 출처: 11-26 21:xx TC HOLD froze 5 hands — three hands on one seat is no longer one cell's question.
export const HOLD_FREEZE_HANDS = 3;
// 출처: 11-26 22:45 1 039 overdue mail-reply follow-ups blew the digest; the digest cap (#40313) shows 5 per section.
export const COMMITMENTS_OVERDUE_MAX = 20;
export const MAIL_BACKLOG_COUNT = 20;
export const MAIL_OLDEST_MIN = 60;
export const CAP_REFUSALS_MAX = 3;
export const LAND_STALE_MIN = 60;
export const JUDGE_QUEUE_MAX = 5;
export const JUDGE_WAIT_MIN = 60;
/** Errors and blocks older than this do not count (the snapshot is «now»). */
export const RECENT_WINDOW_MIN = 60;
export const ANOMALY_MAX_CHARS = 1_500;

const up = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();
const ageMin = (iso: string | null | undefined, now: Date): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 60_000)) : null;
};
export const humanAge = (min: number | null): string => {
  if (min === null) return '?';
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}`;
  return `${Math.floor(min / 1440)}d`;
};
const one = (s: string, max: number): string => { const t = s.replace(/\s+/gu, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const HOLD_WORDS = /\bHOLD\b|\bban(?:ned)?\b|freeze|frozen|동결|금지|보류/iu;

/** Role from facts only: the workspace's coordinator seat, a loop tab, a hand in the pool, else other. */
export function roleOf(pane: Pick<PaneIn, 'seat' | 'coordinator'> | null, seat: string, poolSeats: ReadonlySet<string>): SeatRole {
  if (seat.startsWith('↻') || /^loops?\b/iu.test(seat)) return 'loop';
  if (pane?.coordinator || seat === 'OP') return 'coordinator';
  if (poolSeats.has(seat)) return 'hand';
  return 'other';
}

/** `hold` = a registered ledger HOLD covers these hands (or, with no ledger, the reason reads as a HOLD) · `holdIds` = the
 *  covering ledger HOLDs · `unregistered` = the reasons read as a HOLD but no active ledger HOLD of that seat covers them. */
export interface BlockedOnGroup { readonly on: string; readonly hands: readonly string[]; readonly hold: boolean; readonly sample: string; readonly holdIds?: readonly string[]; readonly unregistered?: boolean }

/** Blocks grouped by the awaited seat: which hands wait on whom, and whether a HOLD freezes them. With a readable HOLD ledger
 *  only registered HOLDs freeze (scope ∩ cell); HOLD words without a registered HOLD mark the group `unregistered`. */
export function blockedOn(blocks: readonly BlockIn[], now: Date, ledger?: readonly HoldLedgerIn[] | null): BlockedOnGroup[] {
  const words = blockedOnWords(blocks, now);
  if (!ledger) return words;
  const { frozenBy } = require('../hold-ledger/hold-ledger.js') as typeof import('../hold-ledger/hold-ledger.js');
  const { frozen } = frozenBy(ledger, blocks.map(b => ({ by: b.by, on: b.on, cell: b.cell, reason: b.reason, at: b.at })), now, RECENT_WINDOW_MIN * 60_000);
  // per awaited seat, three separate counts: hands a registered HOLD covers · hands whose block reads as a HOLD with no
  // registered HOLD covering them (unregistered — never hidden by a registered one) · other blocks.
  const recent = blocks.filter(b => { const a = ageMin(b.at, now); return a !== null && a <= RECENT_WINDOW_MIN; });
  const latest = new Map<string, BlockIn>();
  for (const b of recent) { const k = up(b.by); const p = latest.get(k); if (!p || Date.parse(p.at) <= Date.parse(b.at)) latest.set(k, b); }
  const out: BlockedOnGroup[] = [];
  for (const g of words) {
    const rows = frozen.filter(r => r.hold.owner === g.on);
    const registered = new Set(rows.flatMap(r => r.hands));
    const rest = g.hands.filter(h => !registered.has(h));
    const holdish = rest.filter(h => { const b = latest.get(h); return !!b && HOLD_WORDS.test(b.reason); });
    const other = rest.filter(h => !holdish.includes(h));
    if (registered.size) out.push({ on: g.on, hands: [...registered].sort(), hold: true, holdIds: rows.map(r => r.hold.id),
      sample: `${rows[0]!.hold.id} (${rows[0]!.hold.cells.join(',')} · until ${rows[0]!.hold.expiresAt.slice(11, 16)}Z): ${rows[0]!.hold.reason}` });
    if (holdish.length) out.push({ on: g.on, hands: holdish, hold: false, unregistered: true, sample: (() => { const b = latest.get(holdish[0]!)!; return `${b.cell}: ${b.reason}`; })() });
    if (other.length) out.push({ on: g.on, hands: other, hold: false, sample: (() => { const b = latest.get(other[0]!); return b ? `${b.cell}: ${b.reason}` : g.sample; })() });
  }
  return out.sort((a, b) => b.hands.length - a.hands.length || a.on.localeCompare(b.on));
}

function blockedOnWords(blocks: readonly BlockIn[], now: Date): BlockedOnGroup[] {
  const recent = blocks.filter(b => { const a = ageMin(b.at, now); return a !== null && a <= RECENT_WINDOW_MIN; });
  const groups = new Map<string, { hands: Set<string>; hold: boolean; sample: string; at: number }>();
  for (const b of recent) {
    const on = up(b.on) || '?';
    const g = groups.get(on) ?? { hands: new Set<string>(), hold: false, sample: '', at: 0 };
    g.hands.add(up(b.by));
    if (HOLD_WORDS.test(b.reason)) g.hold = true;
    const t = Date.parse(b.at);
    if (t >= g.at) { g.at = t; g.sample = `${b.cell}: ${b.reason}`; }
    groups.set(on, g);
  }
  return [...groups].map(([on, g]) => ({ on, hands: [...g.hands].sort(), hold: g.hold, sample: g.sample }))
    .sort((a, b) => b.hands.length - a.hands.length || a.on.localeCompare(b.on));
}

/** Pure: fold the source readings into one snapshot (anomalies included). */
export function buildFedSnapshot(src: FedSources): FedSnapshot {
  const now = src.now;
  const poolBySeat = new Map((src.pool ?? []).map(p => [up(p.seat), p] as const));
  const paneBySeat = new Map<string, PaneIn>();
  for (const p of src.panes ?? []) if (!paneBySeat.has(up(p.seat))) paneBySeat.set(up(p.seat), p);
  const seats = [...new Set([...paneBySeat.keys(), ...poolBySeat.keys()])].filter(Boolean);
  const recent = (iso: string) => { const a = ageMin(iso, now); return a !== null && a <= RECENT_WINDOW_MIN; };
  const errorsBySeat = new Map<string, ErrorIn[]>();
  for (const e of src.errors ?? []) if (recent(e.at)) errorsBySeat.set(up(e.seat), [...(errorsBySeat.get(up(e.seat)) ?? []), e]);
  const turnBySeat = new Map((src.turns ?? []).map(t => [up(t.seat), t] as const));
  const queueBySeat = new Map((src.queues ?? []).map(q => [up(q.seat), q.held] as const));
  const mailBySeat = new Map((src.mail ?? []).map(m => [up(m.seat), m] as const));
  // A hand is «holding» when it is idle and its latest recent work fact was a block — work exists but it may not move.
  const lastBlockBy = new Map<string, BlockIn>();
  for (const b of src.blocks ?? []) if (recent(b.at)) { const prev = lastBlockBy.get(up(b.by)); if (!prev || Date.parse(prev.at) <= Date.parse(b.at)) lastBlockBy.set(up(b.by), b); }
  const poolSeats = new Set(poolBySeat.keys());

  const rows: SeatRow[] = seats.map((seat) => {
    const pane = paneBySeat.get(seat) ?? null;
    const pool = poolBySeat.get(seat) ?? null;
    const errs = errorsBySeat.get(seat) ?? [];
    const newest = errs.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const lastErr = newest[0]; const lastFatal = newest.find(e => e.kind === 'fatal');
    // The pane's own unread counter (what its bell counts) first; the msg store for seats without a pane.
    const mail = (pane?.unreadMail && typeof pane.unreadMail.count === 'number'
      ? { seat, unacked: pane.unreadMail.count, oldestAt: pane.unreadMail.oldestCreatedAt ?? null } : null) ?? mailBySeat.get(seat) ?? null;
    const paneState = pane ? (pane.status?.state ?? 'UNKNOWN') : 'NO-PANE';
    const holding = !!pool && pool.state === 'idle' && lastBlockBy.has(seat);
    return {
      seat, role: roleOf(pane, seat, poolSeats), workspace: pane?.workspace ?? pool?.home ?? null,
      pane: paneState, since: pane?.status?.since ? new Date(pane.status.since).toISOString() : null,
      build: { sha: pane?.build?.sha ?? null, age: pane?.build?.age ?? null, desired: pane?.build?.desired ?? null }, stalled: pane?.stalled === true,
      queue: src.queues ? (queueBySeat.get(seat) ?? 0) : null,
      lastTurn: turnBySeat.get(seat) ?? null,
      errors: src.errors ? { fatal: errs.filter(e => e.kind === 'fatal').length, cap: errs.filter(e => e.kind === 'cap').length,
        other: errs.filter(e => e.kind === 'error').length, last: lastErr ? one(lastErr.what, 120) : null, lastFatal: lastFatal ? one(lastFatal.what, 120) : null } : null,
      mail: mail ? { unacked: mail.unacked, oldestAgeMin: ageMin(mail.oldestAt, now) } : null,
      hand: pool ? { state: holding ? 'holding' : pool.state, cell: pool.cell ?? null, holding } : null,
      session: pane?.sessionId ?? null,
    };
  });
  const order: Record<SeatRole, number> = { coordinator: 0, hand: 1, loop: 2, other: 3 };
  rows.sort((a, b) => order[a.role] - order[b.role] || a.seat.localeCompare(b.seat));

  const hands = src.pool ? {
    idle: rows.filter(r => r.hand?.state === 'idle').length, holding: rows.filter(r => r.hand?.holding).length,
    working: rows.filter(r => r.hand?.state === 'working').length, noPane: rows.filter(r => r.hand?.state === 'no-pane').length,
  } : null;
  const groups = src.blocks ? blockedOn(src.blocks, now, src.holdLedger) : null;
  const activeHolds = src.holdLedger ? src.holdLedger.filter(h => h.state === 'active' && Date.parse(h.expiresAt) > now.getTime()) : null;
  const base: Omit<FedSnapshot, 'anomalies'> = {
    at: now.toISOString(), installedSha: src.installedSha, seats: rows, totals: { seats: rows.length, hands },
    handsRaised: src.hands ? src.hands.slice().sort((a, b) => b.waitedMs - a.waitedMs) : null,
    holds: { landingFreeze: src.landingFreeze, landHolds: src.landHolds, blockedOn: groups, ledger: activeHolds ? { active: activeHolds.length, ids: activeHolds.map(h => h.id) } : null },
    commitments: src.commitments, land: src.land, judge: src.judge, loops: src.loops, release: src.release, kpi: src.kpi,
    ...(src.world !== undefined ? { world: src.world } : {}),
    ...(src.budget !== undefined ? { budget: src.budget } : {}),
    unmeasured: src.unmeasured,
  };
  return { ...base, anomalies: detectAnomalies(base, now) };
}

/** Pure: the named anomaly rules over a snapshot (red first). */
export function detectAnomalies(s: Omit<FedSnapshot, 'anomalies'>, now: Date): Anomaly[] {
  const out: Anomaly[] = [];
  for (const h of s.handsRaised ?? []) {
    const min = Math.round(h.waitedMs / 60_000);
    if (min >= HAND_UNANSWERED_MIN) out.push({ rule: 'hand-unanswered', seat: up(h.to), severity: 'red',
      why: `✋ #${h.id} ${up(h.from)}→${up(h.to)} unanswered ${humanAge(min)} (≥${HAND_UNANSWERED_MIN}m) — ${one(h.reason, 70)}` });
  }
  for (const g of s.holds.blockedOn ?? []) {
    if (g.hands.length < HOLD_FREEZE_HANDS) continue;
    if (g.unregistered) {
      out.push({ rule: 'hold-unregistered', seat: g.on, severity: 'yellow',
        why: `${g.on} HOLD-like blocks on ${g.hands.length} hands with no registered HOLD (${g.hands.slice(0, 4).join(',')}${g.hands.length > 4 ? ',…' : ''}) — register: eln hold add --owner ${g.on} --cells … --expires 2h --unlock … · ${one(g.sample, 60)}` });
      continue;
    }
    out.push({ rule: g.hold ? 'hold-freeze' : 'blocked-on', seat: g.on, severity: g.hold ? 'red' : 'yellow',
      why: `${g.on} ${g.hold ? 'HOLD freezes' : 'blocks'} ${g.hands.length} hands in ${RECENT_WINDOW_MIN}m (${g.hands.slice(0, 4).join(',')}${g.hands.length > 4 ? ',…' : ''}) — ${one(g.sample, 80)}` });
  }
  if (s.holds.landingFreeze) out.push({ rule: 'landing-freeze', severity: 'red', why: `landing frozen by ${s.holds.landingFreeze.by}: ${one(s.holds.landingFreeze.reason, 80)}${s.holds.landingFreeze.until ? ` until ${s.holds.landingFreeze.until}` : ''}` });
  if (s.commitments && s.commitments.overdue >= COMMITMENTS_OVERDUE_MAX) out.push({ rule: 'commitments-overdue', seat: s.commitments.seat, severity: 'red',
    why: `${s.commitments.seat} has ${s.commitments.overdue} overdue commitments (≥${COMMITMENTS_OVERDUE_MAX}) · open ${s.commitments.open} — eln commitment list --seat ${s.commitments.seat}` });
  for (const r of s.seats) {
    if (r.errors && r.errors.fatal > 0) out.push({ rule: 'turn-lost', seat: r.seat, severity: 'red', why: `${r.seat} lost ${r.errors.fatal} turn(s) in ${RECENT_WINDOW_MIN}m — ${r.errors.lastFatal ?? '?'}` });
    if (r.errors && r.errors.cap >= CAP_REFUSALS_MAX) out.push({ rule: 'cap-refusals', seat: r.seat, severity: 'yellow', why: `${r.seat} ${r.errors.cap} turns dropped by Cap (no retry) in ${RECENT_WINDOW_MIN}m (≥${CAP_REFUSALS_MAX})` });
    if (r.role === 'coordinator' && r.mail && (r.mail.unacked >= MAIL_BACKLOG_COUNT || (r.mail.unacked > 0 && (r.mail.oldestAgeMin ?? 0) >= MAIL_OLDEST_MIN))) {
      out.push({ rule: 'mail-backlog', seat: r.seat, severity: r.mail.unacked >= MAIL_BACKLOG_COUNT ? 'red' : 'yellow',
        why: `${r.seat} ${r.mail.unacked} unacked · oldest ${humanAge(r.mail.oldestAgeMin)} (≥${MAIL_BACKLOG_COUNT} or ≥${MAIL_OLDEST_MIN}m)` });
    }
    if (r.role === 'coordinator' && r.lastTurn && (r.lastTurn.outcome === 'failed' || r.lastTurn.outcome === 'no-op')) {
      out.push({ rule: `last-turn-${r.lastTurn.outcome}`, seat: r.seat, severity: r.lastTurn.outcome === 'failed' ? 'red' : 'yellow',
        why: `${r.seat} last turn ${r.lastTurn.outcome}${r.lastTurn.at ? ` @${clockOf(r.lastTurn.at)}` : ''}${r.lastTurn.why ? ` — ${one(r.lastTurn.why, 90)}` : ''}` });
    }
    if (r.build.sha && r.build.desired && r.build.sha !== r.build.desired && r.pane !== 'NO-PANE' && r.pane !== 'EXITED') {
      out.push({ rule: 'stale-build', seat: r.seat, severity: 'yellow', why: `${r.seat} runs build ${r.build.sha.slice(0, 10)}, desired ${r.build.desired.slice(0, 10)}${r.build.age ? ` (${r.build.age})` : ''}` });
    }
    if (r.stalled) out.push({ rule: 'stalled-pane', seat: r.seat, severity: 'red', why: `${r.seat} pane stalled (${r.pane} since ${r.since ? clockOf(r.since) : '?'})` });
    if (r.role === 'coordinator' && r.pane === 'NO-PANE') out.push({ rule: 'coordinator-no-pane', seat: r.seat, severity: 'red', why: `${r.seat} has no live pane` });
  }
  if (s.kpi && s.kpi.idleWithWork.length) out.push({ rule: 'idle-with-work', severity: 'yellow', why: `${s.kpi.idleWithWork.length} hand(s) idle with READY work: ${s.kpi.idleWithWork.slice(0, 5).join(',')}` });
  if (s.land) {
    const a = ageMin(s.land.lastAt, now);
    if (a === null || a >= LAND_STALE_MIN) out.push({ rule: 'land-stale', severity: 'yellow', why: `land graph last row ${a === null ? 'never' : `${humanAge(a)} ago`} (≥${LAND_STALE_MIN}m) · pending ${s.land.pending} · mode ${s.land.mode}` });
  }
  if (s.judge && (s.judge.queue >= JUDGE_QUEUE_MAX || (s.judge.medianWaitMin ?? 0) >= JUDGE_WAIT_MIN)) out.push({ rule: 'judge-queue', severity: 'yellow', why: `judge queue ${s.judge.queue} · median wait ${humanAge(s.judge.medianWaitMin === null ? null : Math.round(s.judge.medianWaitMin))}` });
  if (s.loops && (s.loops.failed + s.loops.goalNotMet) > 0) out.push({ rule: 'loops-failing', severity: s.loops.failed > 0 ? 'red' : 'yellow',
    why: `loops in ${humanAge(s.loops.windowMin)}: ${s.loops.failed} failed · ${s.loops.goalNotMet} goal-not-met (${s.loops.failing.slice(0, 4).join(',')})` });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
}

const clockOf = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5); };

/** The anomaly block (≤ maxChars): one head line, one line per anomaly, «… N more» when cut. '' when none. */
export function formatAnomalies(s: Pick<FedSnapshot, 'at' | 'anomalies' | 'unmeasured'>, maxChars = ANOMALY_MAX_CHARS): string {
  if (!s.anomalies.length) return '';
  const red = s.anomalies.filter(a => a.severity === 'red').length;
  const head = `[fed snapshot ${clockOf(s.at)} · ${s.anomalies.length} anomalies (${red} red)]`;
  const lines = [head];
  let used = head.length;
  for (let i = 0; i < s.anomalies.length; i++) {
    const a = s.anomalies[i]!;
    const line = `${a.severity === 'red' ? '✘' : '⚠'} [${a.rule}] ${a.why}`;
    const rest = s.anomalies.length - i - 1;
    const reserve = rest > 0 ? 40 : 0;
    if (used + 1 + line.length + reserve > maxChars) { lines.push(`… ${s.anomalies.length - i} more — eln fed snapshot --anomalies`); break; }
    lines.push(line); used += 1 + line.length;
  }
  return lines.join('\n');
}

const pad = (s: string, n: number): string => (Array.from(s).length >= n ? `${Array.from(s).slice(0, n - 1).join('')}… ` : s + ' '.repeat(n - Array.from(s).length + 1));

/** Human table: federation head, one row per seat, the federation lines, the anomalies. */
export function formatSnapshot(s: FedSnapshot, opts: { all?: boolean } = {}): string {
  const out: string[] = [];
  const h = s.totals.hands;
  // OP-OBSERVE-LANDED neighbour (11-27 22:39): «hands idle 0» here vs «idle-with-work 11» in `fed kpi` read as a contradiction.
  // They are two measures: the pool's FREE hands (no cell claimed, pane idle) and the KPI's hands whose pane went idle while
  // work was ready (a hand idle on its own claimed cell counts there, «working» here). Both are named on the head line.
  const iww = s.kpi ? String(s.kpi.idleWithWork.length) : '?';
  out.push(`fed snapshot ${s.at} · build ${(s.installedSha ?? '?').slice(0, 10)} · seats ${s.totals.seats}${h ? ` · hands free ${h.idle} (no cell) · holding ${h.holding} · working ${h.working} (cell or busy) · no-pane ${h.noPane}` : ' · hands ?'} · idle-with-work ${iww} (pane idle · work ready · = fed kpi)`);
  out.push(`${pad('SEAT', 14)}${pad('ROLE', 6)}${pad('PANE', 8)}${pad('BUILD', 9)}${pad('Q', 3)}${pad('LAST TURN', 16)}${pad('ERR f/c/o', 9)}${pad('MAIL', 10)}HAND`);
  const hidden = opts.all ? 0 : s.seats.filter(r => r.pane === 'NO-PANE' && r.role === 'hand').length;
  for (const r of s.seats) {
    if (!opts.all && r.pane === 'NO-PANE' && r.role === 'hand') continue;
    const turn = r.lastTurn ? `${r.lastTurn.outcome}${r.lastTurn.at ? ` ${clockOf(r.lastTurn.at)}` : ''}` : '-';
    const err = r.errors ? `${r.errors.fatal}/${r.errors.cap}/${r.errors.other}` : '?';
    const mail = r.mail ? `${r.mail.unacked}${r.mail.unacked ? `/${humanAge(r.mail.oldestAgeMin)}` : ''}` : '?';
    const build = r.build.sha ? `${r.build.sha.slice(0, 7)}${r.build.desired && r.build.desired !== r.build.sha ? '!' : ''}` : '-';
    const hand = r.hand ? `${r.hand.state}${r.hand.cell ? ` ${r.hand.cell}` : ''}` : '';
    out.push(`${pad(r.seat, 14)}${pad(r.role.slice(0, 5), 6)}${pad(r.pane.slice(0, 7) + (r.stalled ? '!' : ''), 8)}${pad(build, 9)}${pad(r.queue === null ? '?' : String(r.queue), 3)}${pad(turn, 16)}${pad(err, 9)}${pad(mail, 10)}${hand}`);
  }
  if (hidden) out.push(`(${hidden} declared hands without a pane hidden — --all shows them)`);
  const u = (v: unknown) => (v === null || v === undefined ? '?' : String(v));
  out.push(`✋ open ${s.handsRaised ? s.handsRaised.length : '?'}${s.handsRaised?.length ? ` (oldest ${humanAge(Math.round(s.handsRaised[0]!.waitedMs / 60_000))} #${s.handsRaised[0]!.id})` : ''}` +
    ` · holds: freeze ${s.holds.landingFreeze ? 'ON' : 'off'} · land holds ${s.holds.landHolds ? s.holds.landHolds.length : '?'}` +
    ` · blocked on ${s.holds.blockedOn ? s.holds.blockedOn.filter(g => g.hands.length).map(g => `${g.on}×${g.hands.length}${g.hold ? '(HOLD)' : ''}`).slice(0, 5).join(' ') || 'none' : '?'}`);
  out.push(`commitments ${s.commitments ? `${s.commitments.seat} open ${s.commitments.open} · overdue ${s.commitments.overdue} · action ${s.commitments.action}` : '?'}` +
    ` · land ${s.land ? `${s.land.mode} last ${s.land.lastAt ? clockOf(s.land.lastAt) : 'never'} · today ${s.land.landedToday} · pending ${s.land.pending}` : '?'}` +
    ` · judge ${s.judge ? `${s.judge.queue} (median ${s.judge.medianWaitMin === null ? '?' : `${Math.round(s.judge.medianWaitMin)}m`})` : '?'}`);
  out.push(`loops ${s.loops ? `${humanAge(s.loops.windowMin)}: ok ${s.loops.ok} · goal-not-met ${s.loops.goalNotMet} · failed ${s.loops.failed} · running ${s.loops.running}` : '?'}` +
    ` · release ${s.release ? `${s.release.version} green ${s.release.green} · yellow ${s.release.yellow} / ${s.release.total}` : '?'}` +
    ` · landed/h ${u(s.kpi?.landedPerHour)} · OP inbound/h ${u(s.kpi?.opInboundPerHour)}`);
  if (s.world !== undefined) out.push(s.world ? s.world.line : '세계: ? (lease ledger unread)');
  if (s.budget) out.push(s.budget);
  if (s.unmeasured.length) out.push(`unmeasured: ${s.unmeasured.join(' · ')}`);
  const block = formatAnomalies(s, 4_000);
  out.push(block || 'anomalies: none');
  return out.join('\n');
}
