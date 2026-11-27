/**
 * Burst Board replay — `--replay demo`: a 4-minute compressed scenario (120 snapshots × 2 s; one snapshot = 2 min).
 *
 * S  The demo must show calm → CEO «all resources» → hands burst → review jam → widen → recovery → target crossed →
 *    early exit → receipt, and never fail on stage.
 * C  Hand-drawn numbers would make the board a slide. The planner, forecast and burst course live in op-pulse-burst.
 * Q  How does a replay stay real but deterministic?
 * A  A small synthetic world (test universe: queues, host slots, a pressure curve from the CEO bundle) feeds the REAL
 *    `pressures` → `planScale` → `forecast` → `burstCourse` every tick; `startBurst` / `recordLaunch` keep the burst
 *    state; decisions are applied after each lane's lead time. Only the world constants below are scenario inputs —
 *    every number on screen is computed from them by the planner code. Cloud is a «sim» tile (no paid VM).
 */
import { burstCourse, DEFAULT_BURST_CONFIG, DEFAULT_LEAD_MIN, forecast, recordLaunch, startBurst, type BurstLane as PlannerLane,
  type BurstState, type HostSlots, type ScaleDecision } from '../../../loops/op-pulse-burst.js';
import type { Hand } from '../hand-grid.js';
import type { TickerEvent } from '../ticker.js';
import { fit } from '../text.js';
import { BURST_FRAMES, renderBurstBoard, type BurstBoardSnapshot, type BurstReceipt } from './burst-board.js';
import { boardSnapshot, planBurst, type HostMeasure, type LaneMeasure } from './burst-engine.js';
import { paintBoard, renderBurstPanels, type PanelOverlay } from './burst-board-panels.js';

export const DEMO_TICKS = 120;
export const DEMO_TICK_MS = 2000;
const SIM_MIN_PER_TICK = 2;
const DT_H = SIM_MIN_PER_TICK / 60;

/** Scenario inputs (the synthetic world) — the only hand-set values; the screen is computed from them. */
export const DEMO_WORLD = {
  startIso: '2026-11-26T03:00:00.000Z', // 12:00 KST
  utcOffsetMin: 9 * 60,
  triggerTick: 15, // calm 30 s, then the CEO line
  warmupTicks: 30, // one hour of calm history for the rolling landed/h
  ceoMsgId: 166501,
  deadlineIso: '2026-11-26T07:00:00.000Z', // 16:00 KST cut
  bundleCells: 64, // cells the CEO bundle drops into the ready backlog
  calmArrivalPerH: 7,
  budgetUsd: 150,
  cardApproveAfterTicks: 4, // the sim CEO presses v this many snapshots after the card appears
  base: { hands: 6, review: 2, pregate: 4, judge: 2, land: 2 },
  ratePerUnitH: { hands: 1.2, review: 5, pregate: 4, judge: 10, land: 10 },
  calmTarget: 8,
  burstTarget: 20,
  handsPerVm: 4,
  caps: { 'mshq': 14, 'minim5': 4, 'node-b': 5, 'node-c': 2, 'gcp3': 2, 'aws1': 2 } as Record<string, number>,
} as const;

type Stage = 'review' | 'pregate' | 'judge' | 'land';
interface World {
  t: number;
  backlog: number;
  q: Record<Stage, number>;
  landedTicks: number[];
  greenTicks: number[];
  state: BurstState | null;
  pending: Array<{ lane: PlannerLane; to: number; at: number }>;
  cardSince: number | null;
  events: Array<{ t: number; text: string }>;
  hands: Array<{ host: string; born: number; task: string; closing?: number }>;
  seq: number;
  exitAt: number | null;
  forecastWas: string | null;
  receipt: BurstReceipt | null;
  landedAtStart: number;
  totalLanded: number;
}

const clock = (d: Date): string => {
  const m = Math.floor(d.getTime() / 60_000) + DEMO_WORLD.utcOffsetMin;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const timeAt = (t: number): Date => new Date(Date.parse(DEMO_WORLD.startIso) + t * SIM_MIN_PER_TICK * 60_000);
const lvl = (w: World, lane: PlannerLane): number => w.state?.levels[lane] ?? 0;

function placement(w: World): HostMeasure[] {
  const c = DEMO_WORLD.caps;
  const hands = lvl(w, 'hands');
  const remote = lvl(w, 'remote');
  const pregate = lvl(w, 'pregate');
  const vm = lvl(w, 'vm');
  const lanAPregate = Math.min(c['node-b']!, pregate);
  const lanARemote = Math.min(c['node-b']! - lanAPregate, remote);
  const lanBRemote = Math.min(c['node-c']!, remote - lanARemote);
  const card = w.cardSince !== null && vm === 0 && w.exitAt === null;
  const mshq = DEMO_WORLD.base.hands + hands;
  return [
    { host: 'mshq', kind: 'local', used: mshq, cap: c['mshq']!, load: 4 + mshq * 0.8, role: `hands ${mshq}` },
    { host: 'minim5', kind: 'lan', used: DEMO_WORLD.base.pregate, cap: c['minim5']!, load: 9, role: `pregate ${DEMO_WORLD.base.pregate}` },
    { host: 'node-b', kind: 'lan', used: lanAPregate + lanARemote, cap: c['node-b']!, load: 1 + (lanAPregate + lanARemote) * 1.1, role: `pregate ${lanAPregate} · hands ${lanARemote}` },
    { host: 'node-c', kind: 'lan', used: lanBRemote, cap: c['node-c']!, ...(lanBRemote ? { load: 2.5 } : {}), role: lanBRemote ? `hands ${lanBRemote}` : 'idle' },
    { host: 'gcp3', kind: 'cloud', used: vm, cap: c['gcp3']!, sim: true, ...(card ? { card: true } : vm === 0 ? { off: true } : { load: 3, role: `hands ${vm * DEMO_WORLD.handsPerVm}` }) },
    { host: 'aws1', kind: 'cloud', used: 0, cap: c['aws1']!, sim: true, off: true },
  ];
}

const slots = (hosts: readonly HostMeasure[]): HostSlots[] => hosts.filter((h) => h.kind !== 'cloud').map((h) => ({ host: h.host, kind: h.kind, used: h.used, cap: h.cap }));
const placedRemote = (w: World): number => placement(w).filter((h) => h.kind === 'lan').reduce((n, h) => n + Number(/hands (\d+)/.exec(h.role ?? '')?.[1] ?? 0), 0);
const handCount = (w: World): number => DEMO_WORLD.base.hands + lvl(w, 'hands') + placedRemote(w) + lvl(w, 'vm') * DEMO_WORLD.handsPerVm;
const cap = (w: World, s: Stage): number => (DEMO_WORLD.base[s] + lvl(w, s)) * DEMO_WORLD.ratePerUnitH[s];
const rolling = (xs: readonly number[], end: number, n = 30): number => xs.slice(Math.max(0, end - n + 1), end + 1).reduce((a, b) => a + b, 0) * (30 / n);
const waitMin = (q: number, perH: number): number => (perH > 0 ? (q / perH) * 60 : 0);

function laneMeasures(w: World): Partial<Record<'Hands' | 'Review' | 'Pregate' | 'Veto' | 'Land', LaneMeasure>> {
  const handsRate = handCount(w) * DEMO_WORLD.ratePerUnitH.hands;
  const m = (s: Stage): LaneMeasure => ({ queue: Math.round(w.q[s]), waitMin: waitMin(w.q[s], cap(w, s)), base: DEMO_WORLD.base[s], ratePerH: cap(w, s) });
  return {
    Hands: { queue: Math.round(w.backlog), waitMin: waitMin(w.backlog, handsRate), base: DEMO_WORLD.base.hands, ratePerH: handsRate },
    // JUD-RELAX (CEO 11-26): veto only — no item waits for a JUD judgement in the demo world either.
    Review: m('review'), Pregate: m('pregate'), Veto: { queue: 0, waitMin: null, base: 0 }, Land: m('land'),
  };
}

function signals(w: World, now: Date) {
  const landedH = rolling(w.landedTicks, w.landedTicks.length - 1);
  const target = w.state?.status === 'active' ? DEMO_WORLD.burstTarget : DEMO_WORLD.calmTarget;
  return {
    targetGapRatio: landedH > 0 ? Math.round((target / landedH) * 100) / 100 : null,
    readyBacklog: Math.round(w.backlog), hands: handCount(w), readyPerHand: 2,
    judgeWaitMin: Math.round(waitMin(w.q.judge, cap(w, 'judge'))), judgeWaitTargetMin: 30, judgeQueue: Math.round(w.q.judge),
    gateWaitMin: Math.round(waitMin(w.q.pregate, cap(w, 'pregate'))), gateWaitTargetMin: 10,
    reviewWaitMin: Math.round(waitMin(w.q.review, cap(w, 'review'))), reviewWaitTargetMin: 20,
    landQueue: Math.round(w.q.land), landQueueTarget: 6,
    hoursToDeadline: Math.max(0, (Date.parse(DEMO_WORLD.deadlineIso) - now.getTime()) / 3_600_000),
  };
}

const remaining = (w: World): number => Math.round(w.backlog + w.q.review + w.q.pregate + w.q.judge + w.q.land);

function forecastRow(w: World, now: Date) {
  const rate = rolling(w.landedTicks, w.landedTicks.length - 1);
  return forecast([{ label: '16:00 cut', at: DEMO_WORLD.deadlineIso, source: 'release-cut', remaining: remaining(w) }], rate, now, DEFAULT_BURST_CONFIG.presets)[0] ?? null;
}

/** Move work one tick through the pipeline (back → front so an item advances one stage per tick). */
function flow(w: World): void {
  const producing = w.exitAt === null;
  const handsOut = producing ? Math.min(w.backlog, handCount(w) * DEMO_WORLD.ratePerUnitH.hands * DT_H) : 0;
  w.backlog = w.backlog - handsOut + (w.state === null || w.receipt ? DEMO_WORLD.calmArrivalPerH * DT_H : 0);
  const move = (from: Stage, into: Stage | null): number => {
    const out = Math.min(w.q[from], cap(w, from) * DT_H);
    w.q[from] -= out;
    if (into) w.q[into] += out;
    return out;
  };
  const landed = move('land', null);
  move('pregate', 'land'); // JUD-RELAX: pregate → land (JUD = veto only, no judge stage)
  move('review', 'pregate');
  w.q.review += handsOut;
  w.landedTicks.push(landed);
  w.greenTicks.push(landed * 0.8);
  w.totalLanded += landed;
}

function hostRoom(w: World): string[] {
  const room: string[] = [];
  for (const h of placement(w)) {
    const n = h.host === 'mshq' ? lvl(w, 'hands') : h.host === 'gcp3' ? lvl(w, 'vm') * DEMO_WORLD.handsPerVm : h.kind === 'lan' ? Number(/hands (\d+)/.exec(h.role ?? '')?.[1] ?? 0) : 0;
    for (let i = 0; i < n; i++) room.push(h.host);
  }
  return room;
}

function syncHands(w: World): void {
  const room = hostRoom(w);
  const live = w.hands.filter((h) => h.closing === undefined);
  const want = new Map<string, number>();
  for (const host of room) want.set(host, (want.get(host) ?? 0) + 1);
  const have = new Map<string, number>();
  for (const h of live) {
    const n = (have.get(h.host) ?? 0) + 1;
    have.set(h.host, n);
    if (n > (want.get(h.host) ?? 0)) h.closing = w.t;
  }
  for (const [host, n] of want) {
    for (let i = have.get(host) ?? 0; i < n; i++) {
      w.seq += 1;
      w.hands.push({ host, born: w.t, task: `C-${1100 + w.seq}` });
    }
  }
  w.hands = w.hands.filter((h) => h.closing === undefined || w.t - h.closing < 2);
}

function handsView(w: World): Hand[] {
  const busyBase = w.backlog >= 1 ? Math.min(DEMO_WORLD.base.hands, Math.max(1, Math.ceil(w.backlog))) : 1;
  const base: Hand[] = Array.from({ length: DEMO_WORLD.base.hands }, (_, i) => ({ host: 'mshq', state: i < busyBase ? 'busy' : 'idle' }));
  const finishing = w.exitAt !== null;
  const extra: Hand[] = w.hands.map((h) => (h.closing !== undefined ? { host: h.host, state: 'closing' }
    : h.born === w.t ? { host: h.host, state: 'new', task: h.task } : { host: h.host, state: finishing ? 'idle' : 'busy' }));
  return [...base, ...extra];
}

function setLevel(w: World, lane: PlannerLane, to: number, now: Date): void {
  w.state = { ...w.state!, levels: { ...w.state!.levels, [lane]: to }, lastChangeAt: { ...w.state!.lastChangeAt, [lane]: now.toISOString() } };
}

function applyDecisions(w: World, plan: readonly ScaleDecision[], now: Date): Partial<Record<PlannerLane, number>> {
  const stepped: Partial<Record<PlannerLane, number>> = {};
  if (!w.state || w.state.status !== 'active') return stepped;
  for (const p of w.pending.filter((x) => x.at <= w.t)) {
    const from = w.state.levels[p.lane] ?? 0;
    if (p.to <= from) continue;
    for (let i = from; i < p.to; i++) w.state = recordLaunch(w.state, { lane: p.lane, id: `sim-${p.lane}-${w.t}-${i}`, ...(p.lane === 'vm' ? { host: 'gcp3' } : {}) }, now, 0);
    setLevel(w, p.lane, p.to, now);
    stepped[p.lane] = p.to - from;
    w.events.push({ t: w.t, text: `${p.lane} ${from} → ${p.to}${p.lane === 'vm' ? ' · gcp3 sim on' : ''}` });
  }
  w.pending = w.pending.filter((x) => x.at > w.t);
  for (const d of plan) {
    if (d.blocked === 'ceo-card' && d.lane === 'vm' && w.cardSince === null) {
      w.cardSince = w.t;
      w.events.push({ t: w.t, text: 'local+LAN at cap → gcp3 card (sim)' });
    }
    if (d.blocked || d.to === d.from) continue;
    if (d.to < d.from) {
      setLevel(w, d.lane, d.to, now);
      w.events.push({ t: w.t, text: `${d.lane} ${d.from} → ${d.to} · pressure dropped` });
      continue;
    }
    if (w.pending.some((p) => p.lane === d.lane)) continue;
    w.pending.push({ lane: d.lane, to: d.to, at: w.t + Math.max(1, Math.ceil(DEFAULT_LEAD_MIN[d.lane] / SIM_MIN_PER_TICK)) });
    w.events.push({ t: w.t, text: `plan ${d.lane} +${d.to - d.from} · ${d.why.split(' · ')[0]}` });
  }
  return stepped;
}

function spend(w: World): void {
  if (!w.state || w.state.status !== 'active') return;
  const cfg = DEFAULT_BURST_CONFIG.lanes;
  const levels = w.state.levels;
  const perH = (Object.keys(levels) as PlannerLane[]).reduce((n, l) => n + (levels[l] ?? 0) * cfg[l].costPerUnitHourUsd, 0);
  w.state = { ...w.state, spentUsd: Math.round((w.state.spentUsd + perH * DT_H) * 100) / 100 };
}

/** Exit sequence: stop (2 ticks) → finish in-flight (2) → close hands 3 per tick → cloud off → receipt. */
function exitTick(w: World, now: Date, finish: string): number | undefined {
  const k = w.t - w.exitAt!;
  if (k === 0) w.state = { ...w.state!, status: 'exited' };
  if (k < 2) return 1;
  if (k < 4) return 2;
  const lv = { ...w.state!.levels };
  const prod: PlannerLane[] = ['hands', 'remote', 'ta', 'review', 'pregate', 'judge', 'land'];
  let closed = 0;
  for (const l of prod) while ((lv[l] ?? 0) > 0 && closed < 3) { lv[l] = (lv[l] ?? 0) - 1; closed += 1; }
  if (closed) {
    w.state = { ...w.state!, levels: lv };
    w.events.push({ t: w.t, text: `hands closed ${closed}` });
    return 3;
  }
  if ((lv.vm ?? 0) > 0) {
    lv.vm = 0;
    w.state = { ...w.state!, levels: lv };
    w.events.push({ t: w.t, text: 'gcp3 sim off' });
    return 4;
  }
  if (w.receipt === null) {
    const s = w.state!;
    const minutes = Math.round((now.getTime() - Date.parse(s.startedAt)) / 60_000);
    w.receipt = {
      durationLabel: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} of 4:00 (early exit)`,
      landed: Math.round(w.totalLanded - w.landedAtStart),
      spend: `$${s.spentUsd.toFixed(2)} / $${s.budgetUsd}`,
      handsClosed: s.launches.filter((l) => l.lane !== 'vm').length,
      vmsOff: s.launches.some((l) => l.lane === 'vm') ? ['gcp3 (sim)'] : [],
      forecast: `${finish} ✓ (was ${w.forecastWas ?? '—'} ✗)`,
    };
    w.events.push({ t: w.t, text: `receipt filed · ${s.launches.length} launches closed` });
  }
  return undefined;
}

function runDemo(seed: number): BurstBoardSnapshot[] {
  const w: World = { t: -DEMO_WORLD.warmupTicks, backlog: 4, q: { review: 1, pregate: 1, judge: 0, land: 0 }, landedTicks: [], greenTicks: [], state: null, pending: [],
    cardSince: null, events: [], hands: [], seq: 0, exitAt: null, forecastWas: null, receipt: null, landedAtStart: 0, totalLanded: 0 };
  const out: BurstBoardSnapshot[] = [];
  const cfg = DEFAULT_BURST_CONFIG;
  let exitFinish = 'no data';
  for (; w.t < DEMO_TICKS; w.t++) {
    const now = timeAt(w.t);
    if (w.t === DEMO_WORLD.triggerTick) {
      w.backlog += DEMO_WORLD.bundleCells + (seed - 1) * 2;
      const row = forecastRow(w, now);
      w.forecastWas = row?.projectedFinish ? clock(new Date(row.projectedFinish)) : 'no data';
      w.landedAtStart = w.totalLanded;
      w.state = startBurst({ goal: 'land', until: new Date(now.getTime() + 4 * 3_600_000).toISOString(), scope: ['ALL'], by: 'CEO', now,
        preset: cfg.presets.find((p) => p.name === '4h')!, budgetUsd: DEMO_WORLD.budgetUsd, baseline: { landed: 0, green: 0 },
        trigger: 'ceo-line', ceoLine: { msgId: DEMO_WORLD.ceoMsgId, crownDirective: 'all resources' }, allIn: true }, null);
      w.events.push({ t: w.t, text: `CEO «all resources» → burst 4h · forecast ${w.forecastWas} ✗` });
    }
    if (w.cardSince !== null && w.state?.status === 'active' && w.state.cloudApprovedUsd === 0 && w.t - w.cardSince >= DEMO_WORLD.cardApproveAfterTicks) {
      w.state = { ...w.state, cloudApprovedUsd: 30 };
      w.events.push({ t: w.t, text: 'card approved $30 (sim)' });
    }
    flow(w);
    const hosts = placement(w);
    const row = forecastRow(w, now);
    const active = w.state?.status === 'active' ? w.state : null;
    const planned = planBurst({ signals: signals(w, now), active, config: cfg, hosts: slots(hosts), now, forecastMisses: (row?.shortfall ?? 1) > 0,
      hoursLeft: active ? (Date.parse(active.until) - now.getTime()) / 3_600_000 : 4 });
    const stepped = w.exitAt === null ? applyDecisions(w, planned.plan, now) : {};
    spend(w);
    if (active && w.exitAt === null) {
      const course = burstCourse(w.state!, row, now, cfg.presets);
      if (course.action.startsWith('exit')) {
        w.exitAt = w.t;
        w.pending = [];
        exitFinish = row?.projectedFinish ? clock(new Date(row.projectedFinish)) : 'no data';
        w.events.push({ t: w.t, text: `${course.action} · forecast ${exitFinish} ✓` });
      }
    }
    const exitStep = w.exitAt !== null ? exitTick(w, now, exitFinish) : undefined;
    const mode: BurstBoardSnapshot['mode'] = w.state === null ? 'calm' : w.exitAt === null ? 'burst' : w.receipt ? 'done' : 'exiting';
    syncHands(w);
    if (w.t < 0) continue;
    const series = (xs: number[]) => Array.from({ length: 24 }, (_, i) => Math.round(rolling(xs, xs.length - 1 - (23 - i) * 2)));
    const visible = w.events.filter((e) => e.t >= 0).slice(-5).reverse();
    const startedAt = w.state ? Date.parse(w.state.startedAt) : now.getTime();
    const localFull = hosts.filter((h) => h.kind === 'local').every((h) => h.used >= h.cap);
    const nextHost = mode === 'burst' ? (localFull ? hosts.find((h) => h.kind === 'lan' && h.used < h.cap)?.host ?? null : 'mshq') : null;
    out.push(boardSnapshot({
      source: 'replay', tick: w.t, release: '0.3.37 · test universe', mode, active: w.state, planned: w.exitAt !== null ? null : w.state === null ? { pressures: planned.pressures, plan: [] } : planned, config: cfg,
      measures: laneMeasures(w), hands: handsView(w), hosts, landedPerHour: series(w.landedTicks), greenPerHour: series(w.greenTicks),
      landTarget: w.state && mode !== 'done' ? DEMO_WORLD.burstTarget : DEMO_WORLD.calmTarget,
      events: visible.map((e) => ({ at: clock(timeAt(e.t)), text: e.text })) satisfies TickerEvent[], freshEvent: visible[0]?.t === w.t,
      deadline: '16:00 cut', forecast: row?.projectedFinish ? clock(new Date(row.projectedFinish)) : row ? 'no rate' : 'no data', forecastOk: row ? row.shortfall === 0 : null,
      ...(w.forecastWas && mode !== 'calm' ? { forecastWas: w.forecastWas } : {}),
      elapsedSec: Math.max(0, Math.round((now.getTime() - startedAt) / 1000)), totalSec: 4 * 3600, rhythmMin: 60,
      steppedThisTick: stepped, ...(exitStep && mode === 'exiting' ? { exitStep } : {}), ...(w.receipt && mode === 'done' ? { receipt: w.receipt } : {}),
      gaps: [], nextHost, clock: clock(now),
    }));
  }
  return out;
}

const cache = new Map<number, BurstBoardSnapshot[]>();
/** All 120 snapshots for a seed (seed 1 = the demo; 2·3 shift the bundle size). */
export function burstDemoRun(seed = 1): BurstBoardSnapshot[] {
  let run = cache.get(seed);
  if (!run) { run = runDemo(seed); cache.set(seed, run); }
  return run;
}

/** The snapshot the replay shows at tick `t` (0..119). */
export function burstDemoSnapshot(tick: number, seed = 1): BurstBoardSnapshot {
  const run = burstDemoRun(seed);
  return run[Math.min(run.length - 1, Math.max(0, Math.floor(tick)))]!;
}

const firstTick = (pred: (s: BurstBoardSnapshot) => boolean, fallback: number): number => burstDemoRun(1).find(pred)?.tick ?? fallback;

/** Named fixtures — each one is the first demo tick where that state appears (found in the run, not hard-coded). */
export const BURST_FIXTURES = {
  calm: () => 6,
  bursting: () => firstTick((s) => s.mode === 'burst' && s.hands.some((h) => h.state === 'new'), DEMO_WORLD.triggerTick + 1),
  'review-bottleneck': () => firstTick((s) => s.lanes.some((l) => l.label === 'Review' && l.bottleneck === true), 40),
  'cloud-card-pending': () => firstTick((s) => s.hosts.some((h) => h.state === 'card'), 50),
  'step-up': () => firstTick((s) => s.lanes.some((l) => l.label === 'Review' && (l.steppedBy ?? 0) > 0), 58),
  exit: () => firstTick((s) => s.mode === 'exiting' && (s.exitStep ?? 0) >= 3, 97),
  receipt: () => firstTick((s) => s.mode === 'done', 110),
} as const;
export type BurstFixtureName = keyof typeof BURST_FIXTURES;
export const BURST_FIXTURE_NAMES = Object.keys(BURST_FIXTURES) as BurstFixtureName[];
export const burstFixture = (name: BurstFixtureName): BurstBoardSnapshot => burstDemoSnapshot(BURST_FIXTURES[name]());

/** A replay-only queue snapshot, not a live measurement or a derived severity. */
export function replayQueuePressure(snapshot: BurstBoardSnapshot): string {
  const labels = ['Judge', 'Review', 'Pregate'] as const;
  return `REPLAY (synthetic) · ${labels.map((label) => {
    const lane = snapshot.lanes.find((item) => item.label === label);
    return lane ? `${label} ${lane.queue}q${lane.waitMin == null ? '' : `/${lane.waitMin}m`}` : `${label} unavailable`;
  }).join(' · ')}`;
}

export interface ReplayIo {
  readonly write: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly columns: () => number;
  readonly rows?: () => number;
  readonly color?: boolean;
}

/** Board for a terminal size: framed panels at ≥140×40, the B1 line board below that (120×36 · 80×24 fallbacks). */
export function renderForTerminal(snapshot: BurstBoardSnapshot, columns: number, rows: number, frame: number, color: boolean, overlay?: PanelOverlay): string[] {
  if (columns >= 140 && rows >= 40) {
    const width = Math.min(columns, 200);
    const height = Math.min(rows, 80);
    return paintBoard(renderBurstPanels(snapshot, width, height, frame, overlay), color);
  }
  return renderBurstBoard(snapshot, columns >= 100 ? Math.min(columns, 120) : Math.min(columns, 80), frame);
}

/** Play the scenario: each snapshot is shown for 2 s as 4 tweened frames (÷ speed). Redraws in place (no clear → no flicker). */
export async function playBurstReplay(io: ReplayIo, opts: { readonly speed?: number; readonly fromTick?: number; readonly seed?: number } = {}): Promise<void> {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const frameMs = DEMO_TICK_MS / BURST_FRAMES / speed;
  io.write('\x1b[?25l\x1b[2J');
  try {
    for (let t = opts.fromTick ?? 0; t < DEMO_TICKS; t++) {
      const snapshot = burstDemoSnapshot(t, opts.seed ?? 1);
      for (let f = 0; f < BURST_FRAMES; f++) {
        const columns = Math.max(40, io.columns());
        const rows = io.rows?.() ?? 36;
        const lines = renderForTerminal(snapshot, columns, rows, f, io.color === true);
        if (columns < 140 || rows < 40) {
          const width = columns >= 100 ? Math.min(columns, 120) : Math.min(columns, 80);
          lines[width >= 100 ? 2 : 3] = fit(replayQueuePressure(snapshot), width);
        }
        io.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
        await io.sleep(frameMs);
      }
    }
  } finally {
    io.write('\x1b[?25h');
  }
}
