// SIM-FEDERATION-DAY (대표 11-25 17:0x «남은 공백을 바로 덮고 · 시뮬 월드에 풍부하게 담고 · 합성 이벤트를 잘 쓰라») — one
// compressed federation day as a reusable device. It answers «with OP turns long and continuing (#40092), which of today's
// devices become excessive or counterproductive, and does a proposed retune fix it?» and keeps answering it for later rails.
//
// World (27 seats): OP · leaders TC/UX/MK · kingdoms JUD/JUD-B/JUD-C/REVIEW-1 · RES/RES-INFRA · REL · CLAUDE-OP (coach) ·
// ORCHESTRATOR (stewards) · CEO · 16 hands (TC-H1..12 · UX-H1..2 · MK-H1 · JUD-H1). A ranked board (P0 demo · P1 · P2 cells),
// hand work → PR → RES receipt → JUD verdict → landed. Mail to OP follows the 11-25 ledger shape (P0 19/h · P1 14/h · P2 122/h).
// Day events (each switchable): crown steers · demo-cell priority push · flood burst · P0 incident · rail migration mid-day
// (every seat restarts · unacked mail replays · orphan cond-watch waiters) · a hand that never answers wakes · a hand that
// repeats the same call · delegated results returning to OP.
//
// REAL code: createInternalTurnGate (ELN-SEAT-TURN-PACING) · decideGoalDrive · classifySeatMail ⊕ midTurnMailAction ·
// isUrgentPost ⊕ backpressureVerdict (MAIL-ANTI-FLOOD G) · shouldAutoCompact (CHAT_DEFAULTS) · OWNER_IDLE_WAKE_MS ·
// ASSIGN_DUE_MS · and the real streamLLMWithTools loop for the same-args dedup case. Models (named in FLAGS): hand dynamics,
// the #40096 steward wake, work-next/lease (not on main), and the retunes proposed by the verify-3u report.
//
// Arms: A before #40092 · B after (ops 16:40) · C B ⊕ #40096 steward wake · D C ⊕ retunes (projection) · E rail 28 · F rail 29 — see FLAGS.
// 세 얼굴: 관측 = DayResult (coverage four ⊕ H1–H8 ⊕ claims/leases/stale/steer-return) · 판단 근거 = the real functions above ·
// 수복 = none (a sim — each D flag names the file a retune would change).

import { createInternalTurnGate, DEFAULT_PACING_MAX_CONSECUTIVE, DEFAULT_PACING_MIN_INTERVAL_MS } from '../tui/input/internal-turn.js';
import type { InternalTurnOrigin } from '../chat/internal-turn-origin.js';
import { decideGoalDrive, driveWindow } from '../session-autopilot/goal-drive.js';
import { classifySeatMail, midTurnMailAction } from '../tui/queue-finish-first.js';
import { INFO_MAIL_IDLE_BATCH_MS } from '../tui/core/queue.js';
import { backpressureVerdict, isUrgentPost, BACKPRESSURE_DEFAULTS } from '../msg/post-discipline.js';
import { shouldAutoCompact } from '../compact/auto.js';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import { OWNER_IDLE_WAKE_MS } from '../seat/hand-pool.js';
import { ASSIGN_DUE_MS } from '../seat/seat-assign.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../llm.js';

export type Arm = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const ARMS: readonly Arm[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const S = 1000;
const MIN = 60 * S;
const T0 = Date.parse('2026-11-25T00:00:00.000Z'); // 09:00 KST
const OP_MODEL = 'gpt-6.1-terra';

/** Arm switches. A/B/C = code on main (C adds open PR #40096); D = the verify-3u retunes, each named by the file it changes. */
export interface Flags {
  /** acp/turn-budget.ts — OP tool rounds per turn (4 before #40092 · 400 after). */
  maxRounds: number;
  /** session-autopilot/goal-drive.ts — drive continuation on. */
  drive: boolean;
  /** tui/queue-finish-first.ts — idle seat drains held passive mail. */
  idleDrain: boolean;
  /** steward/space/model.ts planWake (#40096 · open PR) — idle owner ≥10 min → assign+wake · steward-only cooldown 20 min. */
  stewardWake: boolean;
  /** OP still assigns/wakes hands itself (the 16:46 TC-H-POOL-2 assign after the 16:43 ack). */
  opDirectWake: boolean;
  /** TC still runs CEO-1555-ACCEL «재가동 쉬는 손 16» (no retract reached its plan). */
  leaderWakes: boolean;
  /** D · seat/seat-assign.ts — refuse a second assign/wake of the same seat inside ASSIGN_DUE_MS by another actor (one waker). */
  oneWakerPerHand: boolean;
  /** D · msg/self-timer-watch.ts ⊕ scheduler — one alarm per cause (the 30-min check from two sources · watch notify ⊕ reply). */
  oneWakePerCause: boolean;
  /** D · tui/input/internal-turn.ts noteTurnStarted — a mail/notice turn is an external event: reset the pacing run. */
  pacingResetOnMail: boolean;
  /** D · msg/post-discipline.ts isUrgentPost — a reply to the receiver's own ask (replyTo · result) is never folded. */
  passReplyToOwnAsk: boolean;
  /** D (#40100 · open PR) — directive expiry/retract: a withdrawn or expired order is not re-executed on replay. */
  directiveExpiry: boolean;
  /** D · cond-watch waiters die with their TUI (reap on restart). */
  reapOrphans: boolean;
  /** D · incident mode: N alerts for one incident steer once. */
  incidentCollapse: boolean;
  /** future (not on main) · work-next: a hand that finishes claims the next ranked unowned cell itself. */
  workNext: boolean;
  /** rail 28 · seat/seat-assign.ts — the same actor · seat · cell inside ASSIGN_DUE_MS is a no-op (no mail · no wake). */
  assignIdempotent: boolean;
  /** rail 28 · session-autopilot/goal-drive.ts — a standing/KPI goal never continues · ≤5 side effects per continuation. */
  driveNarrowed: boolean;
  /** rail 28 · #40096 — a live steward scope refuses another seat's assign into it unless --p0 (OP → TC hands). */
  stewardRefusesForeign: boolean;
}
export const FLAGS: Record<Arm, Flags> = {
  A: { maxRounds: 4, drive: false, idleDrain: false, stewardWake: false, opDirectWake: true, leaderWakes: true, oneWakerPerHand: false, oneWakePerCause: false,
    pacingResetOnMail: false, passReplyToOwnAsk: false, directiveExpiry: false, reapOrphans: false, incidentCollapse: false, workNext: false, assignIdempotent: false, driveNarrowed: false, stewardRefusesForeign: false },
  B: { maxRounds: 400, drive: true, idleDrain: true, stewardWake: false, opDirectWake: true, leaderWakes: true, oneWakerPerHand: false, oneWakePerCause: false,
    pacingResetOnMail: false, passReplyToOwnAsk: false, directiveExpiry: false, reapOrphans: false, incidentCollapse: false, workNext: false, assignIdempotent: false, driveNarrowed: false, stewardRefusesForeign: false },
  C: { maxRounds: 400, drive: true, idleDrain: true, stewardWake: true, opDirectWake: true, leaderWakes: true, oneWakerPerHand: false, oneWakePerCause: false,
    pacingResetOnMail: false, passReplyToOwnAsk: false, directiveExpiry: false, reapOrphans: false, incidentCollapse: false, workNext: false, assignIdempotent: false, driveNarrowed: false, stewardRefusesForeign: false },
  D: { maxRounds: 400, drive: true, idleDrain: true, stewardWake: true, opDirectWake: false, leaderWakes: true, oneWakerPerHand: true, oneWakePerCause: true,
    pacingResetOnMail: true, passReplyToOwnAsk: true, directiveExpiry: true, reapOrphans: true, incidentCollapse: true, workNext: true, assignIdempotent: true, driveNarrowed: true, stewardRefusesForeign: false },
  // rail 28 (89a92411): #40096 steward wake · work-next · lease · seat-assign idempotency · live steward refuses other seats' assign ·
  // #40100 directive expiry/retract · #40104 flood mode. Not yet (rail 29 · #40097): drive narrowing · delegated-result wake.
  E: { maxRounds: 400, drive: true, idleDrain: true, stewardWake: true, opDirectWake: true, leaderWakes: true, oneWakerPerHand: true, oneWakePerCause: false,
    pacingResetOnMail: false, passReplyToOwnAsk: false, directiveExpiry: true, reapOrphans: false, incidentCollapse: false, workNext: true, assignIdempotent: true, driveNarrowed: false, stewardRefusesForeign: true },
  // rail 29 (announced · #40097): E ⊕ goal-drive narrowing (standing/KPI never continues · ≤5 side effects) ⊕ delegated-result wake.
  F: { maxRounds: 400, drive: true, idleDrain: true, stewardWake: true, opDirectWake: true, leaderWakes: true, oneWakerPerHand: true, oneWakePerCause: false,
    pacingResetOnMail: false, passReplyToOwnAsk: true, directiveExpiry: true, reapOrphans: false, incidentCollapse: false, workNext: true, assignIdempotent: true, driveNarrowed: true, stewardRefusesForeign: true },
};

/** Day events — all on by default; a scenario flag turns one off (`--no-<name>` in the runner). */
export interface Scenario {
  hours: number;
  crownSteers: boolean; demoPush: boolean; flood: boolean; incident: boolean; railMigration: boolean; deadHand: boolean;
  repeatingHand: boolean; delegatedResults: boolean;
  /** «standing KPI goal + non-idempotent side-effect tool» — the 16:40–17:00 loop (77 SEAT-ASSIGN in 20 min · 39 distinct · MVP-B ×9). */
  kpiLoop: boolean;
}
export const FULL_DAY: Scenario = { hours: 8, crownSteers: true, demoPush: true, flood: true, incident: true, railMigration: true, deadHand: true,
  repeatingHand: true, delegatedResults: true, kpiLoop: false };
export const KPI_LOOP_DAY: Scenario = { ...FULL_DAY, kpiLoop: true };

export const HANDS = [...Array.from({ length: 12 }, (_, i) => `TC-H${i + 1}`), 'UX-H1', 'UX-H2', 'MK-H1', 'JUD-H1'] as const;
export const SEATS = ['OP', 'TC', 'UX', 'MK', 'JUD', 'JUD-B', 'JUD-C', 'REVIEW-1', 'RES', 'RES-INFRA', 'REL', ...HANDS] as const;
const LEADER_OF = (hand: string): string => hand.startsWith('UX') ? 'UX' : hand.startsWith('MK') ? 'MK' : hand.startsWith('JUD') ? 'JUD' : 'TC';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const poisson = (r: () => number, perHour: number, horizonS: number): number[] => {
  const out: number[] = []; let t = 0;
  for (;;) { t += -Math.log(1 - r()) * (3600 / perHour); if (t >= horizonS) return out; out.push(Math.floor(t)); }
};

type Cls = 'P0' | 'P1' | 'P2';
interface Mail { at: number; cls: Cls; cause: string; intent: string | null; crown: string | null; kind: 'mail' | 'reply' | 'order' | 'retract' | 'incident' | 'flood' | 'hand' | 'card';
  askAt?: number; withdraws?: string; replayed?: boolean }
interface Sched { at: number; origin: InternalTurnOrigin; cause: string }
interface Cell { id: string; rank: number; prio: 'P0' | 'P1' | 'P2'; owner: string | null; workLeftS: number; state: 'yellow' | 'pr' | 'receipt' | 'pass' | 'landed'; nextAt: number }
interface Hand { id: string; working: boolean; until: number; idleSince: number; pickupAt: number | null; dead: boolean; repeating: boolean;
  cell: Cell | null; wakes: Array<{ at: number; src: string }>; stewardWokeAt: number }

export const COORDINATORS = ['OP', 'TC', 'UX', 'MK', 'JUD', 'RES', 'REL'] as const;
export type CoordId = (typeof COORDINATORS)[number];
/** Inbound per hour from everyone but OP (ledger 11-25 06:00–08:00 · OP's own orders are generated by the OP engine). */
const INBOUND: Record<CoordId, { p0: number; p1: number; p2: number; handRaise: number }> = {
  OP: { p0: 16, p1: 8, p2: 122, handRaise: 0 },
  TC: { p0: 10, p1: 40, p2: 75, handRaise: 1.5 },
  UX: { p0: 3, p1: 3, p2: 19, handRaise: 0.5 },
  MK: { p0: 1, p1: 3, p2: 11, handRaise: 0.3 },
  JUD: { p0: 1, p1: 26, p2: 13, handRaise: 0.3 }, // 대표 live note 16:53: JUD activity 15/30 min
  RES: { p0: 4, p1: 9, p2: 9, handRaise: 0.3 },
  REL: { p0: 1, p1: 4, p2: 6, handRaise: 0 },
};

export interface SeatMetrics {
  seat: CoordId; turnsPerH: number; roundsPerH: number; opens: Record<string, number>; driveContinue: number; driveOpened: number; driveRunCapDropped: number;
  pacingRefusedPerH: number; dedupRefusalsPerH: number; steersPerH: number; outPer30m: number; inboundPerH: number; foldedPerH: number;
  handRaises: number; handResolveP50Min: number; handEscalated: number; cardsHandled: number; cardLatencyP50Min: number;
  readyCellsVsIdleHands: string; inputMtokPerH: number; compactions: number; compactionsMidTurn: number; dupCauseOpens: number; schedRefusedPerH: number;
}
export interface DayResult {
  arm: Arm; seed: number; hours: number;
  // coverage four
  idleWithWorkMinPerH: number; opInboundPerH: number; mailOpenedTurnsPerH: number; landedPerH: number;
  // H1 · H2
  handWakesPerH: number; dupWakesPerH: number; dupBySource: Record<string, number>; staleExecutions: number; doubleAssignsPerH: number; deadHandWakes: number;
  // H3 (OP) · H6 · extras
  incidentSteers: number; opOutFoldable: number; peerToTcFolded: number;
  delegatedResults: number; delegatedFolded: number; delegatedP50Min: number; delegatedWithin5Pct: number; floodFolded: number;
  workNextClaims: number; leaseReclaims: number; steerGoalReturnPct: number;
  // KPI loop
  opAssigns: number; opAssignsDistinctPct: number; maxOpAssignsPer20m: number; maxSameAssignPer20m: number; idempotentNoops: number; stewardRefusals: number;
  seats: Record<CoordId, SeatMetrics>;
}

type Turn = { origin: string; cause: string; roundsLeft: number; nextRoundAt: number; outbound: number; viaGate: boolean; rounds: number };
interface Coord {
  id: CoordId; gate: ReturnType<typeof createInternalTurnGate>; gateNow: number; busy: boolean; turn: Turn | null;
  queue: Mail[]; held: Mail[]; folded: Mail[]; sched: Sched[]; turnStamps: number[]; opened: Map<string, number[]>;
  driveHist: number[]; drivePending: { attempt: number; at: number } | null; ctx: number; inputTok: number; lastDrainAt: number;
  pendingRaises: Array<{ at: number; by: string; escalated: boolean }>; raiseLat: number[]; escalated: number;
  pendingCards: number[]; cardLat: number[];
  m: { turns: number; rounds: number; opens: Record<string, number>; driveContinue: number; driveOpened: number; driveRunCap: number; pacing: number; dedup: number;
    steers: number; out: number; inbound: number; folded: number; compactions: number; compactionsMid: number; dupCause: number; schedRefused: number };
}

export function runDay(arm: Arm, seed: number, sc: Scenario = FULL_DAY): DayResult {
  const f = FLAGS[arm];
  const H = sc.hours; const HZ = H * 3600;
  const r = mulberry32(seed * 7919 + 13);
  let now = 0;
  const ms = (): number => T0 + now * S;
  const ac = { ...CHAT_DEFAULTS.autoCompact, enabled: true };

  // ── board: 6 P0 demo · 14 P1 · 20 P2, ranked; the first 16 owned by the hands ──
  const cells: Cell[] = Array.from({ length: 40 }, (_, i) => ({ id: `C${String(i + 1).padStart(2, '0')}`, rank: i, prio: i < 6 ? 'P0' : i < 20 ? 'P1' : 'P2',
    owner: null, workLeftS: between(r, 30, 90) * 60, state: 'yellow', nextAt: 0 }));
  const hands: Hand[] = HANDS.map((id, i) => {
    const working = r() < 0.5;
    const cell = cells[i]!; cell.owner = id;
    return { id, working, until: working ? between(r, 300, 1800) : 0, idleSince: working ? 0 : -between(r, 0, 1800), pickupAt: null,
      dead: sc.deadHand && id === 'TC-H7', repeating: sc.repeatingHand && id === 'TC-H9', cell, wakes: [], stewardWokeAt: -1e9 };
  });

  // ── coordinators (one engine · real gate per seat) ──
  const C = {} as Record<CoordId, Coord>;
  for (const id of COORDINATORS) {
    const c: Coord = { id, gate: null as never, gateNow: ms(), busy: false, turn: null, queue: [], held: [], folded: [], sched: [], turnStamps: [], opened: new Map(),
      driveHist: [], drivePending: null, ctx: 60_000, inputTok: 0, lastDrainAt: -1e9, pendingRaises: [], raiseLat: [], escalated: 0, pendingCards: [], cardLat: [],
      m: { turns: 0, rounds: 0, opens: {}, driveContinue: 0, driveOpened: 0, driveRunCap: 0, pacing: 0, dedup: 0, steers: 0, out: 0, inbound: 0, folded: 0,
        compactions: 0, compactionsMid: 0, dupCause: 0, schedRefused: 0 } };
    c.gate = createInternalTurnGate({ isTurnRunning: () => c.busy, getBufferText: () => '', getTypeaheadCount: () => 0, pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0, now: () => c.gateNow, log: () => {}, turnLifeLog: () => {},
      pacing: { minIntervalMs: DEFAULT_PACING_MIN_INTERVAL_MS, maxConsecutive: DEFAULT_PACING_MAX_CONSECUTIVE } });
    c.gate.port.attach(() => true);
    C[id] = c;
  }

  // ── inbound streams (seeded before any arm-dependent draw) ──
  const stream: Array<{ to: CoordId; m: Mail }> = [];
  for (const id of COORDINATORS) {
    const rate = INBOUND[id];
    for (const at of poisson(r, rate.p0, HZ)) stream.push({ to: id, m: { at, cls: 'P0', cause: `alert-${id}-${at}`, intent: 'alert', crown: null, kind: 'mail' } });
    for (const at of poisson(r, rate.p1, HZ)) stream.push({ to: id, m: { at, cls: 'P1', cause: `req-${id}-${at}`, intent: 'request', crown: null, kind: 'mail' } });
    for (const at of poisson(r, rate.p2, HZ)) stream.push({ to: id, m: { at, cls: 'P2', cause: `info-${id}-${at}`, intent: 'info', crown: null, kind: 'mail' } });
    for (const at of poisson(r, rate.handRaise, HZ)) stream.push({ to: id, m: { at, cls: 'P0', cause: `hand-${id}-${at}`, intent: 'alert', crown: null, kind: 'hand' } });
  }
  for (let k = 0; k < H * 6; k++) stream.push({ to: 'OP', m: { at: 30 + k * 600, cls: 'P1', cause: `coach-board-${k}`, intent: 'decision', crown: null, kind: 'mail' } });
  for (let k = 0; k < H; k++) stream.push({ to: 'OP', m: { at: 300 + k * 3600, cls: 'P1', cause: `resource-opt-${k}`, intent: 'request', crown: null, kind: 'mail' } });
  stream.push({ to: 'OP', m: { at: 60, cls: 'P0', cause: 'order-1555', intent: 'request', crown: 'CEO-1555-ACCEL', kind: 'order' } });
  stream.push({ to: 'TC', m: { at: 90, cls: 'P0', cause: 'order-1555', intent: 'request', crown: 'CEO-1555-ACCEL', kind: 'order' } });
  stream.push({ to: 'OP', m: { at: 1200, cls: 'P0', cause: 'retract-1555', intent: 'request', crown: 'CEO-1640-RETRACT', kind: 'retract' } });
  if (sc.crownSteers) for (const at of poisson(r, 3, HZ)) stream.push({ to: 'OP', m: { at, cls: 'P0', cause: `crown-${at}`, intent: 'request', crown: 'CEO', kind: 'mail' } });
  if (sc.demoPush) stream.push({ to: 'OP', m: { at: 2 * 3600, cls: 'P0', cause: 'demo-push', intent: 'request', crown: 'CEO-DEMO', kind: 'mail' } });
  if (sc.flood) for (let k = 0; k < 12; k++) stream.push({ to: 'OP', m: { at: 3 * 3600 + k * 10, cls: 'P2', cause: `flood-${k}`, intent: 'info', crown: null, kind: 'flood' } });
  if (sc.incident && H >= 6) for (let k = 0; k < 10; k++) stream.push({ to: 'OP', m: { at: 6 * 3600 + k * 30, cls: 'P0', cause: 'incident-1', intent: 'alert', crown: null, kind: 'incident' } });
  stream.sort((a, b) => a.m.at - b.m.at);
  for (const { m } of stream) if (classifySeatMail({ intent: m.intent, crownDirective: m.crown }) !== m.cls) throw new Error(`class drift ${m.cause}`);
  const railAt = sc.railMigration && H >= 5 ? 4 * 3600 : -1;
  for (const c of Object.values(C)) for (let k = 0; k < H * 2; k++) {
    c.sched.push({ at: 44 + k * 1800 + COORDINATORS.indexOf(c.id) * 7, origin: 'scheduled', cause: `check-30-${k}` });
    if (!f.oneWakePerCause && c.id === 'OP') c.sched.push({ at: 314 + k * 1800, origin: 'scheduled', cause: `check-30-${k}` });
    if (c.id === 'OP') c.sched.push({ at: 531 + k * 1800, origin: 'retro', cause: `retro-${k}` });
  }

  // ── world counters ──
  let idleWithWork = 0;
  let handWakes = 0; let dupWakes = 0; let doubleAssign = 0; let landed = 0; let mailTurns = 0;
  const dupBySource: Record<string, number> = {};
  let staleExecutions = 0; const orderInForce: Record<string, boolean> = { OP: false, TC: false };
  let incidentSteers = 0; let incidentSteered = false; let opOutFoldable = 0; let floodFolded = 0; let deadHandWakes = 0; let workNextClaims = 0; let leaseReclaims = 0;
  let steerTotal = 0; let steerReturns = 0; const pendingSteerReturn: number[] = [];
  const delegated: Array<{ askAt: number; arrivedAt: number; seenAt: number | null; folded: boolean }> = [];
  const late: Array<{ to: CoordId; m: Mail }> = [];
  const readiness: Record<string, { ready: number; idle: number; n: number }> = {};

  const opAssigns: Array<{ at: number; key: string }> = []; let idempotentNoops = 0; let stewardRefusals = 0;
  const refusedForeign = (h: Hand): boolean => { if (f.stewardRefusesForeign && LEADER_OF(h.id) === 'TC') { stewardRefusals += 1; return true; } return false; };
  /** OP's SeatAssign: one mail + one wake per call on main (no idempotency) · rail 28: same actor·seat·cell inside ASSIGN_DUE_MS = no-op. */
  const opAssign = (h: Hand): boolean => {
    const key = `${h.id}:${h.cell?.id ?? '-'}`;
    if (refusedForeign(h)) return false;
    if (f.assignIdempotent && opAssigns.some((a) => a.key === key && now - a.at < ASSIGN_DUE_MS / S)) { idempotentNoops += 1; return false; }
    opAssigns.push({ at: now, key });
    return wakeHand(h, 'OP');
  };
  const recentByOther = (h: Hand, src: string): Array<{ at: number; src: string }> => h.wakes.filter((w) => now - w.at < ASSIGN_DUE_MS / S && w.src !== src);
  const wakeHand = (h: Hand, src: string): boolean => {
    if (f.oneWakerPerHand && recentByOther(h, src).length > 0) return false;
    handWakes += 1; if (!h.dead) mailTurns += 1;
    const recent = h.wakes.filter((w) => now - w.at < 20 * 60 && w.src !== src);
    if (recent.length) { dupWakes += 1; const k = `${recent[0]!.src}+${src}`; dupBySource[k] = (dupBySource[k] ?? 0) + 1; }
    if (recentByOther(h, src).length) doubleAssign += 1;
    h.wakes.push({ at: now, src });
    if (h.dead) { deadHandWakes += 1; return true; }
    if (!h.working && h.pickupAt === null) h.pickupAt = now + between(r, 60, 240);
    return true;
  };

  const compact = (c: Coord, mid: boolean): void => {
    if (shouldAutoCompact([], OP_MODEL, ac, c.ctx).fire) { c.m.compactions += 1; if (mid) c.m.compactionsMid += 1; c.ctx = Math.round(c.ctx * 0.3); }
  };
  /** A seat posts one mail. OP → a coordinator is an order from above: never folded (isUrgentPost) and opens a turn on arrival. */
  const post = (c: Coord, to: CoordId | 'hand' | 'other'): void => {
    c.m.out += 1;
    if (c.id === 'OP' && to !== 'hand' && to !== 'other') {
      const urgent = isUrgentPost({ from: 'OP', to, kind: 'request', intent: 'request', senderAbove: true, replyTo: null, refs: null, crownDirective: null,
        priority: null, origin: null, doneWhen: null, deadlineAt: null, needsReply: false, cls: 'request' });
      const bp = backpressureVerdict({ urgent: false, pendingPassive: 0, turnsLastHour: C[to].turnStamps.filter((t) => now - t < 3600).length }, BACKPRESSURE_DEFAULTS);
      if (urgent && bp.fold) opOutFoldable += 1;
      late.push({ to, m: { at: now + 5, cls: 'P1', cause: `op-order-${now}-${to}`, intent: 'request', crown: null, kind: 'mail' } });
    }
    if (r() < 0.25 && sc.delegatedResults && c.id === 'OP') {
      const back = now + between(r, 300, 1800);
      late.push({ to: 'OP', m: { at: back, cls: 'P2', cause: `ask-${now}`, intent: null, crown: null, kind: 'reply', askAt: now } });
      if (!f.oneWakePerCause) c.sched.push({ at: back + 2, origin: 'scheduled', cause: `ask-${now}` }); // cond-watch notify (mail-reply)
    }
  };
  const absorb = (c: Coord, m: Mail): void => {
    if (m.kind === 'order') {
      if (m.replayed && f.directiveExpiry) return; // #40100: an expired/retracted order is not re-executed
      if (m.replayed) staleExecutions += 1;
      orderInForce[c.id] = true;
    }
    if (m.kind === 'retract') { orderInForce[c.id] = false; if (f.directiveExpiry || f.opDirectWake === false) orderInForce.TC = false; }
    if (m.kind === 'reply') { const d = delegated.find((x) => x.arrivedAt === m.at && x.askAt === m.askAt); if (d && d.seenAt === null) d.seenAt = now; }
    if (m.kind === 'hand') c.pendingRaises.push({ at: m.at, by: m.cause, escalated: false });
    if (m.kind === 'card') c.pendingCards.push(m.at);
  };
  const deliver = (to: CoordId, m: Mail): void => {
    const c = C[to]; c.m.inbound += 1;
    const ownAsk = m.kind === 'reply';
    if (m.kind === 'reply') delegated.push({ askAt: m.askAt!, arrivedAt: m.at, seenAt: null, folded: false });
    const urgent = m.cls !== 'P2' || (f.passReplyToOwnAsk && ownAsk);
    if (!urgent) {
      const v = backpressureVerdict({ urgent: false, pendingPassive: c.held.length + c.queue.filter((x) => x.cls === 'P2').length + c.folded.length,
        turnsLastHour: c.turnStamps.filter((x) => now - x < 3600).length }, BACKPRESSURE_DEFAULTS);
      if (v.fold) { c.folded.push(m); c.m.folded += 1; if (m.kind === 'flood') floodFolded += 1; if (ownAsk) delegated.at(-1)!.folded = true; return; }
    }
    if (c.busy) {
      if (m.kind === 'incident' && f.incidentCollapse && incidentSteered) { c.held.push(m); return; }
      const action = midTurnMailAction({ id: m.cause, text: m.cause, source: 'seat-mail', mailClass: m.cls }, m.cls, true, ms());
      if (action.kind === 'held' && !(f.passReplyToOwnAsk && ownAsk)) { c.held.push(m); return; }
      c.m.steers += 1; if (c.id === 'OP') { steerTotal += 1; if (m.kind === 'incident') { incidentSteers += 1; incidentSteered = true; } }
      if (c.turn) { c.turn.roundsLeft = Math.min(c.turn.roundsLeft + 2, f.maxRounds); if (c.id === 'OP' && c.turn.roundsLeft > 2) pendingSteerReturn.push(now); }
      c.ctx += 1500; absorb(c, m);
    } else c.queue.push(m);
  };

  const openTurn = (c: Coord, origin: string, cause: string, needed: number, viaGate: boolean): void => {
    c.busy = true;
    if (!viaGate) { c.gate.noteTurnStarted(); if (f.pacingResetOnMail) c.gate.noteHumanTurn(); }
    c.m.turns += 1; c.m.opens[origin] = (c.m.opens[origin] ?? 0) + 1;
    if (origin === 'mail' || origin === 'digest') mailTurns += 1;
    c.turnStamps.push(now);
    const list = c.opened.get(cause) ?? []; if (list.some((t) => now - t < 20 * 60)) c.m.dupCause += 1; list.push(now); c.opened.set(cause, list);
    c.turn = { origin, cause, roundsLeft: Math.min(needed, f.maxRounds), nextRoundAt: now + between(r, 12, 24), outbound: 0, viaGate, rounds: 0 };
    const reading = [...c.queue, ...c.held, ...c.folded];
    c.ctx += 1500 * reading.length;
    for (const m of reading) absorb(c, m);
    c.queue.length = 0; c.held.length = 0; c.folded.length = 0;
    compact(c, false);
  };
  const neededFor = (c: Coord, origin: string, cause: string): number =>
    origin === 'goal-continue' ? between(r, 6, 20) : origin === 'digest' ? between(r, 2, 5) : cause.startsWith('check-30') ? between(r, c.id === 'OP' ? 12 : 6, c.id === 'OP' ? 30 : 15)
      : origin === 'retro' ? between(r, 3, 6) : cause.startsWith('orphan') ? between(r, 2, 5) : between(r, 3, 9);

  const round = (c: Coord, t: Turn): void => {
    t.rounds += 1; c.m.rounds += 1; c.inputTok += c.ctx; c.ctx += between(r, 1200, 3200); compact(c, true);
    if (c.id === 'OP') while (pendingSteerReturn.length) { pendingSteerReturn.pop(); steerReturns += 1; }
    // ✋ / steward cards are resolved in the next round after they were read
    for (const p of c.pendingRaises.splice(0)) c.raiseLat.push((now - p.at) / 60);
    for (const at of c.pendingCards.splice(0)) c.cardLat.push((now - at) / 60);
    const sweeping = (t.cause.startsWith('check-30') || t.origin === 'goal-continue' || t.origin === 'restart') && r() < 0.35;
    if (c.id === 'OP' && sc.kpiLoop && r() < 0.5) {
      // standing KPI «쉬는 손 0»: every round re-checks the pool (IDLE until the woken hand's turn starts) and re-assigns
      const cap = t.origin === 'goal-continue' && f.driveNarrowed ? Math.max(0, 5 - t.outbound) : 4;
      for (const h of hands.filter((x) => !x.working).slice(0, cap)) if (opAssign(h)) { t.outbound += 1; c.m.out += 1; }
    } else if (c.id === 'OP' && sweeping && f.opDirectWake) {
      for (const h of hands.filter((x) => !x.working).slice(0, f.maxRounds <= 4 ? 1 : 3)) {
        if (!orderInForce.OP && r() > 0.25) continue; // retracted: OP mostly leaves wakes to the steward (ops: one assign 3 min after the ack)
        if (refusedForeign(h)) continue;
        if (!orderInForce.OP) staleExecutions += 1;
        if (wakeHand(h, 'OP')) { t.outbound += 1; c.m.out += 1; }
      }
    }
    if ((c.id === 'TC' || c.id === 'UX' || c.id === 'MK') && f.leaderWakes && sweeping) {
      for (const h of hands.filter((x) => LEADER_OF(x.id) === c.id && !x.working && now - x.idleSince >= 300).slice(0, orderInForce.TC && c.id === 'TC' ? 3 : 1)) {
        if (wakeHand(h, c.id)) { t.outbound += 1; c.m.out += 1; }
      }
    }
    if (c.id === 'JUD') { const ready = cells.find((x) => x.state === 'receipt' && now >= x.nextAt - 300); if (ready) { ready.state = 'pass'; ready.nextAt = now + between(r, 300, 900); t.outbound += 1; c.m.out += 1; } }
    if (c.id === 'RES') { const ready = cells.find((x) => x.state === 'pr' && now >= x.nextAt - 300); if (ready) { ready.state = 'receipt'; ready.nextAt = now + between(r, 300, 900); t.outbound += 1; c.m.out += 1; } }
    const pOut = c.id === 'OP' ? 0.3 : c.id === 'TC' ? 0.35 : 0.2;
    if (r() < pOut) {
      t.outbound += 1;
      if (c.id === 'OP') { const pick = r(); post(c, pick < 0.4 ? 'hand' : pick < 0.6 ? 'TC' : pick < 0.7 ? 'RES' : pick < 0.8 ? 'UX' : pick < 0.85 ? 'JUD' : 'other'); }
      else post(c, 'other');
    }
    t.roundsLeft -= 1; t.nextRoundAt = now + between(r, 12, 24);
  };
  const endTurn = (c: Coord, t: Turn): void => {
    // H5 dedup: a status file / receipts dir re-read every ~5 rounds is blocked from its 3rd read in one turn (runDedupCase: 30 rounds → 4 of 6)
    c.m.dedup += Math.max(0, Math.floor(t.rounds / 5) - 2);
    c.turn = null; c.busy = false; c.gateNow = ms();
    if (t.viaGate) c.gate.noteTurnSettled();
    const selfWakePending = c.sched.some((x) => x.cause.startsWith('self-wake'));
    if (!f.drive) { if (!selfWakePending && (t.roundsLeft > 0 || r() < 0.3)) c.sched.push({ at: now + 300, origin: 'scheduled', cause: `self-wake-${t.cause}` }); return; }
    const agents = r() < (c.id === 'OP' ? 0.45 : 0.25);
    const standing = sc.kpiLoop && c.id === 'OP' && f.driveNarrowed; // rail 28: a standing/KPI goal never drives
    const v = standing ? { kind: 'stop' as const, reason: 'no-goal' as const } : decideGoalDrive({ goalId: `pin:${c.id}`, failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, waitingOn: 0,
      backgroundRunning: agents ? 1 : 0, sameReply: false, stateChanged: t.outbound > 0, openWork: t.roundsLeft > 0,
      ...(r() < 0.3 ? { modelWakeInMs: 10 * MIN } : {}), history: driveWindow(c.driveHist, ms()), now: ms() });
    if (v.kind === 'continue') { c.m.driveContinue += 1; c.driveHist.push(ms()); c.drivePending = { attempt: 0, at: now }; }
    else if (!selfWakePending && r() < 0.5) c.sched.push({ at: now + 600, origin: 'scheduled', cause: `self-wake-${t.cause}` });
  };
  const tickCoord = (c: Coord): void => {
    c.gateNow = ms();
    if (c.turn && now >= c.turn.nextRoundAt) { if (c.turn.roundsLeft > 0) round(c, c.turn); else endTurn(c, c.turn); }
    // ✋ ladder: unresolved 10 min → escalate to OP
    for (const p of c.pendingRaises) if (!p.escalated && c.id !== 'OP' && now - p.at >= 600) { p.escalated = true; c.escalated += 1; }
    if (c.busy) { for (const s of c.sched) if (s.at <= now) { s.at = now + 5; c.m.schedRefused += 1; } return; }
    if (now === 0 || now === railAt) { openTurn(c, 'restart', 'restart', c.id === 'OP' ? 25 : 8, false); return; }
    const urgent = c.queue.filter((m) => m.cls !== 'P2');
    if (urgent.length) { openTurn(c, 'mail', urgent[0]!.cause, neededFor(c, 'mail', urgent[0]!.cause), false); return; }
    const due = c.sched.filter((s) => s.at <= now).sort((a, b) => a.at - b.at)[0];
    if (due) {
      const g = c.gate.startTurnIfIdle(`wake ${due.cause}`, { origin: due.origin });
      if (g.opened) {
        c.gate.takePending(); c.sched.splice(c.sched.indexOf(due), 1);
        if (f.oneWakePerCause) for (let i = c.sched.length - 1; i >= 0; i--) if (c.sched[i]!.cause === due.cause) c.sched.splice(i, 1);
        openTurn(c, due.origin, due.cause, neededFor(c, due.origin, due.cause), true); return;
      }
      c.m.schedRefused += 1; if (g.reason === 'Cap') c.m.pacing += 1; due.at = g.retryAt ? Math.ceil((g.retryAt - T0) / S) : now + 5;
    }
    if (c.drivePending && now >= c.drivePending.at) {
      const g = c.gate.startTurnIfIdle('drive', { origin: 'goal-continue', reason: 'autopilot drive' });
      if (g.opened) { c.gate.takePending(); c.m.driveOpened += 1; c.drivePending = null; openTurn(c, 'goal-continue', 'drive', neededFor(c, 'goal-continue', 'drive'), true); return; }
      if (g.reason === 'Cap') c.m.pacing += 1;
      if (g.reason === 'Cap' && g.retryAt === undefined) { c.m.driveRunCap += 1; c.drivePending = null; }
      else if (c.drivePending.attempt >= 12) c.drivePending = null;
      else { c.drivePending.attempt += 1; c.drivePending.at = g.retryAt ? Math.ceil((g.retryAt - T0) / S) : now + 5; }
    }
    const passive = [...c.queue, ...c.held, ...c.folded];
    if (f.idleDrain && passive.length && now - Math.min(...passive.map((m) => m.at)) >= INFO_MAIL_IDLE_BATCH_MS / S && now - c.lastDrainAt > 60) {
      c.lastDrainAt = now; openTurn(c, 'digest', `digest-${now}`, neededFor(c, 'digest', ''), false);
    }
  };

  let si = 0;
  for (now = 0; now < HZ; now += 1) {
    if (now === railAt) {
      for (const c of Object.values(C)) { c.turn = null; c.busy = false; }
      C.OP.queue.push({ at: now, cls: 'P0', cause: 'order-1555', intent: 'request', crown: 'CEO-1555-ACCEL', kind: 'order', replayed: true });
      C.TC.queue.push({ at: now, cls: 'P0', cause: 'order-1555', intent: 'request', crown: 'CEO-1555-ACCEL', kind: 'order', replayed: true });
      if (!f.reapOrphans) for (let k = 0; k < 4; k++) C.OP.sched.push({ at: now + between(r, 120, 1500), origin: 'scheduled', cause: `orphan-watch-${k}` });
      for (const h of hands) if (h.working) h.until += 300;
    }
    // hands
    for (const h of hands) {
      if (h.working && now >= h.until) {
        h.working = false; h.idleSince = now;
        if (h.cell && !h.repeating) { h.cell.workLeftS -= 1500; if (h.cell.workLeftS <= 0) { h.cell.state = 'pr'; h.cell.nextAt = now + between(r, 600, 1500); h.cell.owner = null; h.cell = null; } }
        if (!h.cell && f.workNext && !h.dead) {
          const next = cells.filter((x) => x.state === 'yellow' && x.owner === null).sort((a, b) => a.rank - b.rank)[0];
          if (next) { next.owner = h.id; h.cell = next; workNextClaims += 1; h.working = true; h.until = now + between(r, 600, 1800); }
        }
      }
      if (!h.working && h.pickupAt !== null && now >= h.pickupAt) {
        h.pickupAt = null; h.working = true; h.until = now + between(r, 600, 1800);
        if (!h.cell) { const next = cells.filter((x) => x.state === 'yellow' && x.owner === null).sort((a, b) => a.rank - b.rank)[0]; if (next) { next.owner = h.id; h.cell = next; } }
      }
    }
    if (now % 60 === 0) {
      const unowned = cells.filter((x) => x.state === 'yellow' && x.owner === null).length;
      for (const h of hands) if (!h.working && !h.dead && (h.cell || unowned > 0)) idleWithWork += 1;
      for (const lead of ['TC', 'UX', 'MK', 'JUD']) {
        const mine = hands.filter((h) => LEADER_OF(h.id) === lead);
        const rd = readiness[lead] ?? { ready: 0, idle: 0, n: 0 };
        rd.ready += cells.filter((x) => x.state === 'yellow' && (x.owner === null || mine.some((h) => h.id === x.owner && !h.working))).length / (lead === 'TC' ? 1 : 4);
        rd.idle += mine.filter((h) => !h.working).length; rd.n += 1; readiness[lead] = rd;
      }
    }
    if (f.workNext && now % 600 === 0) for (const h of hands) if (h.dead && h.cell && now - h.idleSince > 1800) { h.cell.owner = null; h.cell = null; leaseReclaims += 1; }
    for (const x of cells) if ((x.state === 'pass') && now >= x.nextAt) { x.state = 'landed'; landed += 1; }
    // stewards: TC live — a card to TC when something is deferred · #40096 wake
    if (now % 600 === 0) {
      if (r() < 0.3) late.push({ to: 'TC', m: { at: now, cls: 'P1', cause: `card-${now}`, intent: 'decision', crown: null, kind: 'card' } });
      if (f.stewardWake) {
        let cap = 4;
        for (const h of hands) {
          if (cap <= 0 || LEADER_OF(h.id) !== 'TC') continue;
          if (h.working || (now - h.idleSince) * S < OWNER_IDLE_WAKE_MS || now - h.stewardWokeAt < 20 * 60) continue;
          // #40096 wake: an idle owner on its own yellow cell · main R1 match: an idle hand without a cell gets the top unowned cell
          if (!h.cell) { const next = cells.filter((x) => x.state === 'yellow' && x.owner === null).sort((a, b) => a.rank - b.rank)[0]; if (!next) continue; next.owner = h.id; h.cell = next; }
          if (wakeHand(h, 'STEWARD')) { h.stewardWokeAt = now; cap -= 1; }
        }
      }
    }
    // mail
    late.sort((a, b) => a.m.at - b.m.at);
    while (late.length && late[0]!.m.at <= now) { const x = late.shift()!; deliver(x.to, x.m); }
    while (si < stream.length && stream[si]!.m.at <= now) { const x = stream[si++]!; deliver(x.to, x.m); }
    for (const id of COORDINATORS) tickCoord(C[id]);
  }

  const perH = (n: number): number => Math.round((n / H) * 10) / 10;
  const p50 = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round((s[Math.floor(s.length / 2)] ?? 0) * 10) / 10 : 0; };
  const seats = {} as Record<CoordId, SeatMetrics>;
  for (const id of COORDINATORS) {
    const c = C[id]; const rd = readiness[id];
    seats[id] = { seat: id, turnsPerH: perH(c.m.turns), roundsPerH: perH(c.m.rounds), opens: c.m.opens, driveContinue: c.m.driveContinue, driveOpened: c.m.driveOpened,
      driveRunCapDropped: c.m.driveRunCap, pacingRefusedPerH: perH(c.m.pacing), dedupRefusalsPerH: perH(c.m.dedup), steersPerH: perH(c.m.steers),
      outPer30m: perH(c.m.out) / 2, inboundPerH: perH(c.m.inbound), foldedPerH: perH(c.m.folded), handRaises: c.raiseLat.length + c.pendingRaises.length,
      handResolveP50Min: p50(c.raiseLat), handEscalated: c.escalated, cardsHandled: c.cardLat.length, cardLatencyP50Min: p50(c.cardLat),
      readyCellsVsIdleHands: rd ? `${Math.round(rd.ready / rd.n)}:${Math.round(rd.idle / rd.n)}` : '-', inputMtokPerH: Math.round((c.inputTok / H) / 1e5) / 10,
      compactions: c.m.compactions, compactionsMidTurn: c.m.compactionsMid, dupCauseOpens: c.m.dupCause, schedRefusedPerH: perH(c.m.schedRefused) };
  }
  const lat = delegated.map((d) => (d.seenAt === null ? Infinity : (d.seenAt - d.arrivedAt) / 60)).sort((a, b) => a - b);
  const tcPerH = C.TC.turnStamps.length / H;
  return { arm, seed, hours: H, idleWithWorkMinPerH: perH(idleWithWork), opInboundPerH: seats.OP.inboundPerH, mailOpenedTurnsPerH: perH(mailTurns), landedPerH: perH(landed),
    handWakesPerH: perH(handWakes), dupWakesPerH: perH(dupWakes), dupBySource, staleExecutions, doubleAssignsPerH: perH(doubleAssign), deadHandWakes,
    incidentSteers, opOutFoldable, peerToTcFolded: tcPerH > BACKPRESSURE_DEFAULTS.maxTurnsPerHour ? Math.round(tcPerH - BACKPRESSURE_DEFAULTS.maxTurnsPerHour) : 0,
    delegatedResults: delegated.length, delegatedFolded: delegated.filter((d) => d.folded).length,
    delegatedP50Min: lat.length ? Math.round(Math.min(lat[Math.floor(lat.length / 2)] ?? 0, 999) * 10) / 10 : 0,
    delegatedWithin5Pct: lat.length ? Math.round((lat.filter((x) => x <= 5).length / lat.length) * 100) : 0, floodFolded,
    workNextClaims, leaseReclaims, steerGoalReturnPct: steerTotal ? Math.round((steerReturns / steerTotal) * 100) : 0,
    opAssigns: opAssigns.length, opAssignsDistinctPct: opAssigns.length ? Math.round((new Set(opAssigns.map((a) => a.key)).size / opAssigns.length) * 100) : 0,
    maxOpAssignsPer20m: Math.max(0, ...opAssigns.map((a) => opAssigns.filter((b) => b.at >= a.at && b.at - a.at < 1200).length)),
    maxSameAssignPer20m: Math.max(0, ...opAssigns.map((a) => opAssigns.filter((b) => b.key === a.key && b.at >= a.at && b.at - a.at < 1200).length)),
    idempotentNoops, stewardRefusals, seats };
}

// ── H4: the real gate — mail turns that bypass the door never reset the pacing run ───────────────────────
export function runPacingCase(): Array<{ step: string; result: string }> {
  let t = T0; let running = false;
  const gate = createInternalTurnGate({ isTurnRunning: () => running, getBufferText: () => '', getTypeaheadCount: () => 0, pendingKeyCount: () => 0,
    lastHumanKeyAt: () => 0, now: () => t, log: () => {}, turnLifeLog: () => {},
    pacing: { minIntervalMs: DEFAULT_PACING_MIN_INTERVAL_MS, maxConsecutive: DEFAULT_PACING_MAX_CONSECUTIVE } });
  gate.port.attach(() => true);
  const rows: Array<{ step: string; result: string }> = [];
  const auto = (origin: InternalTurnOrigin, label: string): void => {
    t += 10 * MIN;
    const g = gate.startTurnIfIdle(label, { origin });
    rows.push({ step: `${origin} ${label}`, result: g.opened ? 'opened' : `${g.reason} ${g.detail ?? ''}${g.retryAt ? ' retryAt' : ' no-retryAt'}`.trim() });
    if (g.opened) { gate.takePending(); gate.noteTurnStarted(); running = true; t += 3 * MIN; running = false; gate.noteTurnSettled(); }
  };
  const mailTurn = (): void => { t += 4 * MIN; gate.noteTurnStarted(); running = true; t += 2 * MIN; running = false; gate.noteTurnSettled(); };
  auto('goal-continue', 'drive-1'); mailTurn(); mailTurn();
  auto('retro', 'self-retro'); mailTurn();
  auto('goal-continue', 'drive-2'); mailTurn(); mailTurn(); mailTurn();
  auto('self-pull', 'pull'); mailTurn();
  auto('goal-continue', 'drive-3'); mailTurn(); mailTurn();
  auto('goal-continue', 'drive-4');
  auto('scheduled', 'alarm');
  auto('goal-continue', 'drive-5');
  return rows;
}

// ── H5: the real tool loop — one 30-round OP check turn with legitimate repeats ───────────────────────────
export interface DedupRow { arm: 'before' | 'after'; rounds: number; dispatched: number; blocked: string[] }
export async function runDedupCase(): Promise<DedupRow[]> {
  const script: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (let i = 0; i < 30; i++) {
    if (i % 5 === 0) script.push({ name: 'Read', args: { file_path: '/hq/seat-state/OPC/coach-notes.md' } });
    else if (i % 6 === 1) script.push({ name: 'ListDir', args: { path: '/hq/.elanous/review-results' } });
    else if (i % 4 === 2) script.push({ name: 'Bash', args: { command: 'eln msg list --to OP' } });
    else if (i % 4 === 3) script.push({ name: 'Bash', args: { command: 'eln seat pool' } });
    else script.push({ name: 'Bash', args: { command: `eln release checklist status --round ${i}` } });
  }
  const out: DedupRow[] = [];
  for (const arm of ['before', 'after'] as const) {
    let i = 0; let dispatched = 0; const got: string[] = [];
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: OP_MODEL, available: () => true,
      async *chat() { yield 'done'; },
      streamChat(_messages, options) {
        const synthesis = (options as { toolChoice?: string } | undefined)?.toolChoice === 'none' || !(options as { tools?: unknown[] } | undefined)?.tools?.length;
        const step = !synthesis && i < script.length ? script[i++] : null;
        return (async function* () {
          if (step) { yield { type: 'tool_call', id: `c${i}`, name: step.name, args: step.args } as LLMStreamEvent; yield { type: 'finish', reason: 'tool_calls' } as LLMStreamEvent; }
          else { yield { type: 'text', delta: 'done' } as LLMStreamEvent; yield { type: 'finish', reason: 'stop' } as LLMStreamEvent; }
        })();
      },
    };
    await streamLLMWithTools([{ role: 'user', content: 'OP 30분 점검 — 끝까지' }],
      { onText() {}, dispatchTool: async (name: string, args: Record<string, unknown>) => { dispatched += 1; got.push(`${name}:${JSON.stringify(args)}`); return 'ok'; } },
      { provider, model: OP_MODEL, tools: ['Read', 'ListDir', 'Bash'].map((name) => ({ name, description: name, parameters: { type: 'object' } })),
        sessionId: `sim-fedday-dedup-${arm}`, seatLoop: arm === 'after', ...(arm === 'before' ? { maxTurns: 4 } : {}) } as never);
    const left = new Map<string, number>(); for (const k of got) left.set(k, (left.get(k) ?? 0) + 1);
    const blocked: string[] = [];
    for (const s of script.slice(0, i)) { const k = `${s.name}:${JSON.stringify(s.args)}`; const n = left.get(k) ?? 0; if (n > 0) left.set(k, n - 1); else blocked.push(s.name); }
    out.push({ arm, rounds: i, dispatched, blocked });
  }
  return out;
}

/** Mean of numeric fields over seeds (the report table). */
export function meanRow(rows: readonly DayResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rows[0] ?? {})) if (typeof v === 'number' && k !== 'seed') out[k] = Math.round((rows.reduce((s, x) => s + (x[k as keyof DayResult] as number), 0) / rows.length) * 10) / 10;
  return out;
}

// ── PULL-CLAIMABLE-WAITING scenario (rail 30 · live 11-25 18:2x) ──────────────────────────────────────────────────────
// «hands own cells that are waiting on JUD + coordinator-owned board». Live: 0.3.36 yellow 105 (coordinator-owned 20 ·
// hand-owned 66), 0 `eln work next` calls in 15 min, hands idle again right after waking.
// World: 16 hands (TC-H1..12 under TC · UX-H1..4 under UX), each owning 2 cells whose PRs wait on a JUD verdict
// (green receipt, no verdict, PASS after 40–100 min); TC holds 20 yellow cells and UX 8 (the leaders' board); 4 unowned.
// A hand works an ACTIVE cell 25–45 min, opens its PR (the cell now waits on JUD), and its turn ends waiting on a reply.
// REAL code (after): workNext (in-memory CAS ledger) · cellWaitOf · decideGoalDrive · planMatch (행정관 R1, 10-min ticks).
// before = origin/main c128c95c0c rules expressed through the same real functions: leader-held cells hidden from
// workNext (scopeOf(TC)=OP, never READY), no waitOf (every held yellow = WIP), drive pulls only on closed/none and
// stops on waitingOn > 0, the steward wakes an idle owner on its (waiting) own cell → the hand finds nothing to do.
import { workNext, readyCells, type BoardCell } from '../steward/space/work-next.js';
import { cellWaitOf } from '../steward/space/cell-wait.js';
import { emptyScopeState, planMatch, type Snapshot } from '../steward/space/model.js';
import { resolveScope } from '../steward/space/config.js';

export interface PullWaitingResult {
  readonly arm: 'before' | 'after';
  /** Σ over minutes of hands idle while `eln work next` (after rules) would have handed them a cell. */
  readonly idleWithWorkHandMin: number;
  readonly workNextCalls: number;
  readonly claims: number;
  readonly coordinatorCellClaims: number;
  /** A claim of a cell another hand already held at that moment — must be 0 (CAS). */
  readonly doubleClaims: number;
  readonly stewardWakes: number;
  readonly takeWorkNextNudges: number;
  readonly cellsGreen: number;
}

export function runPullWaitingCase(arm: 'before' | 'after', seed = 1, hours = 2): PullWaitingResult {
  const r = mulberry32(seed);
  const after = arm === 'after';
  const hands = [...Array.from({ length: 12 }, (_, i) => `TC-H${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `UX-H${i + 1}`)];
  const leader = (s: string): string => (s.startsWith('UX') ? 'UX' : s.startsWith('TC') ? 'TC' : 'OP');
  const scopeOfSeat = (s: string): string => (hands.includes(s) ? leader(s) : 'OP');
  const iso = (ms: number): string => new Date(ms).toISOString();
  const cells = new Map<string, BoardCell & { owner?: string }>();
  const prs: Array<{ number: number; head: string; branch: string; title: string; draft: boolean; updatedAt: string }> = [];
  const receipts: Array<{ pr: number; head12: string; host: string; status: string; atMs: number }> = [];
  const verdicts: Array<{ pr: number; head12: string; kind: 'jud'; verdict: string; atMs: number }> = [];
  const verdictDue = new Map<number, number>();
  let prNo = 1000;
  const openPr = (cellId: string, owner: string, at: number): void => {
    const number = ++prNo; const head = String(number).padStart(12, '0') + 'f'.repeat(28);
    prs.push({ number, head, branch: `${owner.toLowerCase()}/${cellId.toLowerCase()}`, title: `fix: work (${cellId})`, draft: false, updatedAt: iso(at) });
    receipts.push({ pr: number, head12: head.slice(0, 12), host: 'minim5', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: at });
    verdictDue.set(number, at + between(r, 40, 100) * MIN);
  };
  const add = (id: string, owner: string | undefined, priority: string): void => { cells.set(id, { id, title: id.toLowerCase(), status: 'yellow', priority, updatedAt: iso(T0 - 30 * MIN), ...(owner ? { owner } : {}) }); };
  for (const h of hands) for (const k of [1, 2]) { const id = `${h}-W${k}`; add(id, h, 'P1'); openPr(id, h, T0 - between(r, 0, 30) * MIN); }
  for (let i = 1; i <= 20; i++) add(`TC-BOARD-${i}`, 'TC', i <= 4 ? 'P1' : 'P2');
  for (let i = 1; i <= 8; i++) add(`UX-BOARD-${i}`, 'UX', 'P2');
  for (let i = 1; i <= 4; i++) add(`FREE-${i}`, undefined, 'P2');
  const facts = () => ({ prs, receipts, verdicts });
  const waitOf = (c: BoardCell) => cellWaitOf(c.id, facts());
  type HandState = { activity: 'working' | 'idle'; cell?: string; until: number; idleSince: number; lastActive: number };
  const st = new Map<string, HandState>(hands.map((h) => [h, { activity: 'idle', until: 0, idleSince: T0 - 12 * MIN, lastActive: T0 - 12 * MIN }]));
  let workNextCalls = 0; let claims = 0; let coordinatorCellClaims = 0; let doubleClaims = 0; let stewardWakes = 0; let nudges = 0; let idleWithWork = 0;
  const swap = (id: string, input: { expectedOwner: string | null; to: string }) => {
    const c = cells.get(id);
    if (!c) return { outcome: 'missing' as const };
    if ((c.owner ?? null) !== input.expectedOwner || c.status !== 'yellow') return { outcome: 'lost' as const };
    if (c.owner && hands.includes(c.owner)) doubleClaims++;
    cells.set(id, { ...c, owner: input.to, updatedAt: iso(now) });
    return { outcome: 'swapped' as const };
  };
  let now = T0;
  const visible = (seat: string): BoardCell[] => [...cells.values()].filter((c) => after || !(c.owner && c.owner === scopeOfSeat(seat)));
  const pull = (seat: string): void => {
    workNextCalls++;
    const res = workNext(seat, { now: () => now, version: '0.3.36', cells: () => visible(seat), scopeOf: scopeOfSeat,
      lastActiveMs: (s) => st.get(s)?.lastActive ?? now, swap, ...(after ? { waitOf } : {}) });
    const s = st.get(seat)!;
    if (res.code === 0) {
      claims++;
      if (res.from && res.from === scopeOfSeat(seat)) coordinatorCellClaims++;
      Object.assign(s, { activity: 'working', cell: res.cell.id, until: now + between(r, 25, 45) * MIN, lastActive: now });
    } else if (res.code === 4 && !waitOf(res.cell)) {
      Object.assign(s, { activity: 'working', cell: res.cell.id, until: now + between(r, 25, 45) * MIN, lastActive: now });
    }
  };
  const ownState = (seat: string): 'open' | 'closed' | 'none' => {
    const mine = [...cells.values()].filter((c) => c.owner === seat);
    if (!mine.length) return 'none';
    return mine.some((c) => c.status === 'yellow') ? 'open' : 'closed';
  };
  const turnEnd = (seat: string, waitingOn: number): void => {
    const cell = ownState(seat);
    const hand = { cell, workNextAvailable: true } as const;
    const base = { failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false, backgroundRunning: 0, sameReply: false, history: [], now };
    const v = after ? decideGoalDrive({ ...base, waitingOn, handPull: hand })
      : (waitingOn > 0 || cell === 'open' ? { kind: 'stop' as const } : { kind: 'continue' as const });
    if (v.kind === 'continue') pull(seat);
  };
  const scopeCfg = (scope: string) => resolveScope(scope, 'OP', { scopes: { [scope]: { mode: 'live' } } });
  const stewardState: Record<string, ReturnType<typeof emptyScopeState>> = { TC: emptyScopeState(), UX: emptyScopeState() };
  const end = T0 + hours * 60 * MIN;
  for (now = T0; now < end; now += MIN) {
    // JUD verdicts land → the cell is landed (green).
    for (const [pr, due] of verdictDue) {
      if (due > now) continue;
      verdictDue.delete(pr);
      const p = prs.find((x) => x.number === pr)!;
      verdicts.push({ pr, head12: p.head.slice(0, 12), kind: 'jud', verdict: 'PASS', atMs: now });
      const id = [...cells.keys()].find((k) => p.title.includes(`(${k})`));
      if (id) cells.set(id, { ...cells.get(id)!, status: 'green', updatedAt: iso(now) });
      prs.splice(prs.indexOf(p), 1);
    }
    // Working hands finish: PR opens, the cell now waits on JUD, the turn ends waiting on a reply.
    for (const h of hands) {
      const s = st.get(h)!;
      if (s.activity !== 'working' || s.until > now) continue;
      openPr(s.cell!, h, now);
      Object.assign(s, { activity: 'idle', cell: undefined, idleSince: now, lastActive: now });
      turnEnd(h, 1);
    }
    // Steward R1 every 10 min.
    if ((now - T0) % (10 * MIN) === 0) {
      for (const scope of ['TC', 'UX']) {
        const snap: Snapshot = {
          nowMs: now, hq: 'OP', coordinators: ['TC', 'UX'], parent: Object.fromEntries(hands.map((h) => [h, leader(h)])),
          seats: hands.map((h) => { const s = st.get(h)!; return { seat: h, activity: s.activity, idleForMs: s.activity === 'idle' ? now - s.idleSince : null, lastActiveMs: s.lastActive }; }),
          version: '0.3.36', cells: [...cells.values()].map((c) => ({ id: c.id, title: c.title, status: c.status, ...(c.owner ? { owner: c.owner } : {}), ...(c.priority ? { priority: c.priority } : {}), updatedAt: c.updatedAt })),
          prs: after ? prs : [], merged: [], receipts: after ? receipts : [], verdicts: after ? verdicts : [], hosts: [], utilAgeMs: null, openHands: [], sourceErrors: [],
        };
        const plan = planMatch(snap, { scope: scopeCfg(scope), state: stewardState[scope]! });
        for (const row of plan.rows) {
          if (row.action !== 'wake' || !row.seat) continue;
          stewardWakes++;
          stewardState[scope]!.woken = { ...stewardState[scope]!.woken, [row.seat]: { at: iso(now), cell: row.target, count: 1 } };
          const s = st.get(row.seat)!;
          s.lastActive = now;
          if (row.target === row.seat) { nudges++; pull(row.seat); continue; }
          // Woken on its own cell: work it if active; a waiting cell → nothing to do, idle again.
          if (!waitOf(cells.get(row.target)!)) Object.assign(s, { activity: 'working', cell: row.target, until: now + between(r, 25, 45) * MIN });
          else s.idleSince = now;
        }
      }
    }
    // Idle-with-work: idle ≥ 1 min while the after-rules board has a READY cell for this hand.
    for (const h of hands) {
      const s = st.get(h)!;
      if (s.activity !== 'idle') continue;
      const ready = readyCells([...cells.values()], { seat: h, scope: scopeOfSeat(h), nowMs: now, scopeOf: scopeOfSeat, lastActiveMs: () => now, waitOf });
      if (ready.length) idleWithWork++;
    }
  }
  return { arm, idleWithWorkHandMin: idleWithWork, workNextCalls, claims, coordinatorCellClaims, doubleClaims, stewardWakes, takeWorkNextNudges: nudges,
    cellsGreen: [...cells.values()].filter((c) => c.status === 'green').length };
}
