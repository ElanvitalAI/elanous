// OP-PULSE BURST — the pressure-driven elastic mode (CEO 11-25 20:1x).
//
// S: some hours need far more than normal capacity (targets badly unmet · a deadline the current digestion rate will
//    miss). Until now that meant hand-launched tabs, «TA 신규 발사 0» exceptions in chat and VMs nobody turned off.
// C: burst must be (a) smart — OP sees from the forecast that the deadline will be missed and picks 2h/4h/8h, never an
//    auto-start; (b) elastic per lane by pressure with hysteresis; (c) budget-guarded (cloud money → CEO card unless a
//    pre-approved `burst.cloudBudget`); (d) cleanly exited (exact ids closed, VMs it started stopped, receipt).
// A: pure functions here — forecast() · pickPreset() · pressures() · planScale() · burstCourse() · startBurst() ·
//    recordLaunch() · exitBurst(). The CLI (`eln pulse burst …`) and the pulse measure node call them; actuators are the
//    existing commands listed in graphs/triggers/op-pulse.rhythm.yaml `burst.lanes[].actuator` (wired: false = TODO).
//
// 세 얼굴:
//   관측 = seat-state/OP/pulse/burst.json (state · launches with exact ids) · burst-receipts.jsonl (one receipt per burst)
//   판단 근거 = forecast rows (remaining vs rate → projected finish · shortfall) · lane pressure rows (signal → ratio)
//   수복과 인계 = exitBurst closes every recorded launch by id (no pkill) and returns hands to the pool; a close that
//          fails stays in the receipt as `closeFailed` (OP sees it in the next pulse); VM ups without budget → card

export type BurstLane = 'hands' | 'remote' | 'ta' | 'review' | 'pregate' | 'land' | 'judge' | 'vm';
export const BURST_LANES: readonly BurstLane[] = ['hands', 'remote', 'ta', 'review', 'pregate', 'land', 'judge', 'vm'];
export type BurstGoal = 'implement' | 'land' | 'green';

export interface LaneConfig { min: number; max: number; step: number; cooldownMin: number; upAt: number; downAt: number; costPerUnitHourUsd: number }

/** Code defaults per lane (the rhythm yaml `burst.lanes` overrides). Pressure ratio 1 = exactly at target. */
export const DEFAULT_LANES: Record<BurstLane, LaneConfig> = {
  hands: { min: 0, max: 8, step: 2, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 1.5 },
  remote: { min: 0, max: 6, step: 2, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 1.5 },
  ta: { min: 0, max: 6, step: 2, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 2 },
  review: { min: 0, max: 4, step: 1, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 1 },
  pregate: { min: 0, max: 4, step: 1, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 0 },
  land: { min: 0, max: 3, step: 1, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 0 },
  judge: { min: 0, max: 3, step: 1, cooldownMin: 15, upAt: 1.5, downAt: 0.8, costPerUnitHourUsd: 1 },
  vm: { min: 0, max: 2, step: 1, cooldownMin: 30, upAt: 2, downAt: 1, costPerUnitHourUsd: 3 },
};

export interface BurstPreset { name: '2h' | '4h' | '8h'; hours: number; rateGain: number; budgetUsd: number; lanes: Partial<Record<BurstLane, number>> }

/** Code defaults (rhythm yaml `burst.presets` overrides): rateGain = digestion multiplier the preset is expected to buy. */
export const DEFAULT_PRESETS: readonly BurstPreset[] = [
  { name: '2h', hours: 2, rateGain: 1.5, budgetUsd: 30, lanes: { hands: 2, remote: 2, ta: 2, review: 1, pregate: 1 } },
  { name: '4h', hours: 4, rateGain: 2, budgetUsd: 80, lanes: { hands: 4, remote: 4, ta: 4, review: 2, pregate: 2, land: 1, judge: 1 } },
  { name: '8h', hours: 8, rateGain: 2.5, budgetUsd: 200, lanes: { hands: 8, remote: 6, ta: 6, review: 4, pregate: 4, land: 2, judge: 2 } },
];

export interface BurstConfig { lanes: Record<BurstLane, LaneConfig>; presets: readonly BurstPreset[]; cloudBudgetUsd: number }
export const DEFAULT_BURST_CONFIG: BurstConfig = { lanes: DEFAULT_LANES, presets: DEFAULT_PRESETS, cloudBudgetUsd: 0 };

// ── forecast ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Deadline { label: string; at: string; source: 'release-cut' | 'release-publish' | 'demo' | 'p0-cell' | 'ceo' ; remaining: number }

export interface ForecastRow {
  label: string; at: string; source: Deadline['source'];
  remaining: number; ratePerH: number | null; hoursLeft: number;
  projectedFinish: string | null; shortfall: number;
  preset: BurstPreset['name'] | null; presetCloses: boolean; projectedWithBurst: string | null;
}

/** Digestion rate per hour: the rolling 1h rate when measured, else the 3h rate (cells landed+green). */
export function digestionRate(r1h: number | null, r3h: number | null): number | null {
  if (r1h !== null && r1h > 0) return r1h;
  if (r3h !== null) return r3h;
  return r1h;
}

/** Work done in `hoursLeft` with a preset burning for `preset.hours` at rate×gain, then base rate. */
function doneWith(rate: number, hoursLeft: number, preset: BurstPreset | null): number {
  if (!preset) return rate * hoursLeft;
  const burstH = Math.min(preset.hours, hoursLeft);
  return rate * preset.rateGain * burstH + rate * Math.max(0, hoursLeft - burstH);
}

/** Smallest preset whose projected work closes the gap; none closes → the largest, flagged (cut scope). */
export function pickPreset(rate: number, hoursLeft: number, remaining: number, presets: readonly BurstPreset[]): { preset: BurstPreset; closes: boolean } {
  const sorted = [...presets].sort((a, b) => a.hours - b.hours);
  for (const p of sorted) if (doneWith(rate, hoursLeft, p) >= remaining) return { preset: p, closes: true };
  return { preset: sorted[sorted.length - 1]!, closes: false };
}

export function forecast(deadlines: readonly Deadline[], ratePerH: number | null, now: Date, presets: readonly BurstPreset[]): ForecastRow[] {
  return deadlines.filter(d => Date.parse(d.at) > now.getTime()).map(d => {
    const hoursLeft = (Date.parse(d.at) - now.getTime()) / 3_600_000;
    const rate = ratePerH ?? 0;
    const projectedFinish = rate > 0 ? new Date(now.getTime() + (d.remaining / rate) * 3_600_000).toISOString() : null;
    const shortfall = Math.max(0, Math.ceil(d.remaining - rate * hoursLeft));
    if (shortfall === 0) return { label: d.label, at: d.at, source: d.source, remaining: d.remaining, ratePerH, hoursLeft, projectedFinish, shortfall, preset: null, presetCloses: true, projectedWithBurst: null };
    // A zero/unknown rate cannot be multiplied — the largest preset, flagged as not closing (cut scope or ask).
    const pick = rate > 0 ? pickPreset(rate, hoursLeft, d.remaining, presets) : { preset: [...presets].sort((a, b) => b.hours - a.hours)[0]!, closes: false };
    let withBurst: string | null = null;
    if (rate > 0) {
      const gainH = pick.preset.hours;
      const burstWork = rate * pick.preset.rateGain * gainH;
      const hours = d.remaining <= burstWork ? d.remaining / (rate * pick.preset.rateGain) : gainH + (d.remaining - burstWork) / rate;
      withBurst = new Date(now.getTime() + hours * 3_600_000).toISOString();
    }
    return { label: d.label, at: d.at, source: d.source, remaining: d.remaining, ratePerH, hoursLeft, projectedFinish, shortfall, preset: pick.preset.name, presetCloses: pick.closes, projectedWithBurst: withBurst };
  });
}

/** The ready-to-run proposal line for the pulse turn (OP decides · never auto-start). */
export function burstProposal(row: ForecastRow, preset: BurstPreset, phase: string, cloudBudgetUsd: number): string {
  const l = preset.lanes;
  const vm = l.vm ? (preset.budgetUsd <= cloudBudgetUsd ? `VM +${l.vm}` : `VM +${l.vm}(CEO 카드 — burst.cloudBudget $${cloudBudgetUsd})`) : 'VM 0';
  const hhmm = (iso: string | null) => iso ? iso.slice(11, 16) + 'Z' : '측정 불가';
  return `국면 ${phase} · 마감 ${row.label} ${hhmm(row.at)} · 현재 속도로 ${hhmm(row.projectedFinish)} 완료(부족 ${row.shortfall}칸) → 버스트 ${preset.name} 권고: `
    + `손 +${l.hands ?? 0} · 원격 +${l.remote ?? 0} · TA +${l.ta ?? 0} · 리뷰 +${l.review ?? 0} · 게이트 +${l.pregate ?? 0} · ${vm} · 예상 비용 $${preset.budgetUsd} · 예상 완료 ${hhmm(row.projectedWithBurst)}`
    + `${row.presetCloses ? '' : ' · ⚠ 가장 큰 버스트로도 못 닫음 → 범위 축소(엣지 FU) 함께'}`
    + ` — 실행: eln pulse burst start --preset ${preset.name} --goal land --until ${row.at}`;
}

// ── pressure → lane scale ───────────────────────────────────────────────────────────────────────────────────────────

export interface PressureSignals {
  targetGapRatio: number | null;     // target / measured (landed or green) — 2 = half the target
  readyBacklog: number | null; hands: number | null; readyPerHand: number;
  judgeWaitMin: number | null; judgeWaitTargetMin: number;
  judgeQueue: number | null;
  gateWaitMin: number | null; gateWaitTargetMin: number;
  reviewWaitMin: number | null; reviewWaitTargetMin: number;
  landQueue: number | null; landQueueTarget: number;
  hoursToDeadline: number | null;
}

export interface LanePressure { lane: BurstLane; pressure: number | null; why: string }

/** Deadline proximity amplifies every lane: ×1 beyond 8h, up to ×2 at the deadline. */
export function deadlineFactor(hours: number | null): number { return hours === null || hours >= 8 ? 1 : 1 + (8 - Math.max(0, hours)) / 8; }

const ratio = (v: number | null, target: number): number | null => v === null || target <= 0 ? null : v / target;

export function pressures(s: PressureSignals): LanePressure[] {
  const f = deadlineFactor(s.hoursToDeadline);
  const backlog = s.readyBacklog !== null && s.hands !== null ? s.readyBacklog / Math.max(1, s.hands * s.readyPerHand) : null;
  const prod = [s.targetGapRatio, backlog].filter((x): x is number => x !== null);
  const production = prod.length ? Math.max(...prod) : null;
  const judge = [ratio(s.judgeWaitMin, s.judgeWaitTargetMin), s.judgeQueue !== null ? s.judgeQueue / 10 : null].filter((x): x is number => x !== null);
  const scale = (v: number | null) => v === null ? null : Math.round(v * f * 100) / 100;
  const gate = scale(ratio(s.gateWaitMin, s.gateWaitTargetMin));
  return [
    { lane: 'hands', pressure: scale(production), why: `target gap ${s.targetGapRatio === null || s.targetGapRatio === undefined ? '?' : Math.round(s.targetGapRatio * 100) / 100} · backlog ${s.readyBacklog ?? '?'}/${s.hands ?? '?'} hands · deadline ×${f.toFixed(2)}` },
    { lane: 'remote', pressure: scale(production), why: 'same as hands (local tabs first, remote when hands hit max)' },
    { lane: 'ta', pressure: scale(backlog), why: `ready backlog ${s.readyBacklog ?? '?'} vs ${s.hands ?? '?'}×${s.readyPerHand}` },
    { lane: 'review', pressure: scale(ratio(s.reviewWaitMin, s.reviewWaitTargetMin)), why: `review wait ${s.reviewWaitMin ?? '?'}m vs ${s.reviewWaitTargetMin}m` },
    { lane: 'pregate', pressure: gate, why: `gate wait ${s.gateWaitMin ?? '?'}m vs ${s.gateWaitTargetMin}m` },
    { lane: 'land', pressure: scale(ratio(s.landQueue, s.landQueueTarget)), why: `land queue ${s.landQueue ?? '?'} vs ${s.landQueueTarget}` },
    { lane: 'judge', pressure: scale(judge.length ? Math.max(...judge) : null), why: `judge wait ${s.judgeWaitMin ?? '?'}m · queue ${s.judgeQueue ?? '?'}` },
  ];
}

export interface ScaleDecision { lane: BurstLane; from: number; to: number; pressure: number | null; why: string; blocked?: 'cooldown' | 'budget' | 'ceo-card' | 'max' | 'local-headroom' | 'downstream' }

/** Pipeline front → back (CEO 20:2x rule 2). Production lanes are ordered local → LAN → cloud (rule 1). */
export const PIPELINE: readonly BurstLane[] = ['hands', 'ta', 'remote', 'review', 'pregate', 'judge', 'land', 'vm'];
const STAGE: Record<BurstLane, number> = { hands: 0, ta: 0, remote: 0, vm: 0, review: 1, pregate: 2, judge: 3, land: 4 };
const PRODUCTION: ReadonlySet<BurstLane> = new Set(['hands', 'ta', 'remote', 'vm']);

/** Slot use per host (proven caps live in the rhythm yaml comment, not in code). kind orders the fill: local → lan → cloud. */
export interface HostSlots { host: string; kind: 'local' | 'lan' | 'cloud'; used: number; cap: number }

/** Minutes before a step adds throughput (tab ~2 · pregate warm ~3 · VM boot ~8). */
export const DEFAULT_LEAD_MIN: Record<BurstLane, number> = { hands: 2, remote: 3, ta: 2, review: 2, pregate: 3, judge: 2, land: 2, vm: 8 };

export interface ScaleInput {
  levels: Partial<Record<BurstLane, number>>;
  lastChangeAt: Partial<Record<BurstLane, string>>;
  pressures: readonly LanePressure[];
  /** Pressure slope per minute per lane (rate trend + incoming demand) — the anticipation input (rule 3). */
  slopePerMin?: Partial<Record<BurstLane, number>>;
  leadTimeMin?: Partial<Record<BurstLane, number>>;
  /** Slot use per host; absent = not measured (the host caps do not bound the step). */
  hosts?: readonly HostSlots[];
  /** The forecast still misses the deadline at the current levels (cloud is allowed only then). */
  forecastMisses: boolean;
  now: Date;
  config: BurstConfig;
  spentUsd: number;
  budgetUsd: number;
  cloudApprovedUsd: number;
  hoursLeft: number;
  /** urgency all-in: the bottleneck chain goes straight to its (local-bounded) max this plan instead of one step. */
  allIn?: boolean;
}

const headroom = (hosts: readonly HostSlots[] | undefined, kind: HostSlots['kind']): number | null =>
  hosts === undefined ? null : hosts.filter(h => h.kind === kind).reduce((n, h) => n + Math.max(0, h.cap - h.used), 0);

/**
 * The scale planner (CEO 20:2x three rules):
 *  1. LOCAL FIRST — hands (local tabs) are bounded by local slot headroom; remote (LAN hosts) only when local is full;
 *     a cloud VM only when local and LAN are at cap AND the forecast still misses — and then within burst.cloudBudget
 *     (+ approved card money) or blocked as `ceo-card`.
 *  2. FRONT-TO-BACK, ONE STEP — of the stages that want more, the most DOWNSTREAM one is the bottleneck (widening upstream
 *     would only grow its queue: back-pressure); exactly one lane steps up per plan, then re-measure. Scale-downs
 *     (pressure ≤ down_at · hysteresis) happen in the same plan.
 *  3. ANTICIPATE — a stage «wants more» when its pressure projected over the lane's lead time crosses up_at, so the step
 *     starts before the queue forms («step now: queue will exceed in T min»).
 */
export function planScale(input: ScaleInput): ScaleDecision[] {
  const out: ScaleDecision[] = [];
  const overBudget = input.spentUsd >= input.budgetUsd;
  const byLane = new Map(input.pressures.map(p => [p.lane, p] as const));
  const pressureOf = (lane: BurstLane) => byLane.get(PRODUCTION.has(lane) ? 'hands' : lane) ?? null;
  const level = (lane: BurstLane) => input.levels[lane] ?? input.config.lanes[lane].min;
  const cooling = (lane: BurstLane) => { const last = input.lastChangeAt[lane]; return last !== undefined && input.now.getTime() - Date.parse(last) < input.config.lanes[lane].cooldownMin * 60_000; };
  const projected = (lane: BurstLane): { now: number | null; value: number | null; lead: number } => {
    const now = pressureOf(lane)?.pressure ?? null;
    const lead = input.leadTimeMin?.[lane] ?? DEFAULT_LEAD_MIN[lane];
    const slope = input.slopePerMin?.[PRODUCTION.has(lane) ? 'hands' : lane] ?? 0;
    return { now, value: now === null ? null : Math.round((now + slope * lead) * 100) / 100, lead };
  };
  const wants = (lane: BurstLane) => { const pr = projected(lane); return pr.value !== null && pr.value >= input.config.lanes[lane].upAt; };
  for (const lane of PIPELINE) {
    const p = byLane.get(lane); const cfg = input.config.lanes[lane]; const from = level(lane);
    if (!p || p.pressure === null || p.pressure > cfg.downAt || from <= cfg.min || wants(lane)) continue;
    if (cooling(lane)) { out.push({ lane, from, to: from, pressure: p.pressure, why: p.why, blocked: 'cooldown' }); continue; }
    out.push({ lane, from, to: Math.max(cfg.min, from - cfg.step), pressure: p.pressure, why: `${p.why} · pressure dropped` });
  }
  const pressed = (['hands', 'review', 'pregate', 'judge', 'land'] as const).filter(wants);
  if (!pressed.length) return out;
  const stage = Math.max(...pressed.map(l => STAGE[l]));
  for (const l of pressed) if (STAGE[l] < stage) out.push({ lane: l, from: level(l), to: level(l), pressure: byLane.get(l)?.pressure ?? null, why: 'a downstream stage is the bottleneck — not widening upstream', blocked: 'downstream' });
  const chain: BurstLane[] = stage === 0 ? ['hands', 'ta', 'remote', 'vm'] : [PIPELINE.find(l => STAGE[l] === stage)!];
  const localFree = headroom(input.hosts, 'local'); const lanFree = headroom(input.hosts, 'lan');
  for (const lane of chain) {
    const cfg = input.config.lanes[lane]; const from = level(lane);
    const pr = projected(lane);
    const why = pressureOf(lane)?.why ?? '';
    let to = input.allIn ? cfg.max : Math.min(cfg.max, from + cfg.step);
    if (lane === 'hands' && localFree !== null) to = Math.min(to, from + localFree);
    if (lane === 'remote' && lanFree !== null) to = Math.min(to, from + lanFree);
    if (to <= from) {
      out.push({ lane, from, to: from, pressure: pr.now, why: `${why}${lane === 'hands' ? ` · local free slots ${localFree ?? '?'}` : lane === 'remote' ? ` · LAN free slots ${lanFree ?? '?'}` : ''}`, blocked: lane === 'hands' || lane === 'remote' ? 'local-headroom' : 'max' });
      continue;
    }
    if (lane === 'vm') {
      // Cloud is the last step: only with measured hosts that had no local/LAN slot free when this plan began
      // (local steps of this plan land first; the next plan re-measures before any VM).
      if (localFree === null || lanFree === null || localFree > 0 || lanFree > 0) break;
      if (!input.forecastMisses) { out.push({ lane, from, to: from, pressure: pr.now, why: 'local/LAN at cap but the forecast makes the deadline — no cloud', blocked: 'local-headroom' }); break; }
      const cost = (to - from) * cfg.costPerUnitHourUsd * Math.max(1, input.hoursLeft);
      const allowed = input.config.cloudBudgetUsd + input.cloudApprovedUsd;
      if (cost > allowed) { out.push({ lane, from, to: from, pressure: pr.now, why: `VM +${to - from} ≈ $${Math.round(cost)} > cloud budget $${allowed}`, blocked: 'ceo-card' }); break; }
    }
    if (cooling(lane) && !input.allIn) { out.push({ lane, from, to: from, pressure: pr.now, why, blocked: 'cooldown' }); break; }
    if (overBudget) { out.push({ lane, from, to: from, pressure: pr.now, why: `${why} · spent $${input.spentUsd} ≥ ceiling $${input.budgetUsd}`, blocked: 'budget' }); break; }
    const ahead = pr.now !== null && pr.now < cfg.upAt && pr.value !== null && pr.value >= cfg.upAt;
    out.push({ lane, from, to, pressure: pr.now, why: ahead ? `step now: pressure ${pr.now} → ${pr.value} in ${pr.lead} min (lead time) — the queue will exceed its target before the step lands` : why });
    if (!input.allIn) break;
  }
  return out;
}

// ── burst state · launches · exit ───────────────────────────────────────────────────────────────────────────────────

export interface BurstLaunch { lane: BurstLane; id: string; host?: string; at: string; closedAt?: string; closeFailed?: string }

export interface BurstState {
  id: string; status: 'active' | 'exited';
  goal: BurstGoal; preset: BurstPreset['name'] | null; scope: string[];
  startedAt: string; until: string; by: string;
  budgetUsd: number; spentUsd: number; cloudApprovedUsd: number;
  levels: Partial<Record<BurstLane, number>>; lastChangeAt: Partial<Record<BurstLane, string>>;
  launches: BurstLaunch[];
  baseline: { landed: number | null; green: number | null };
  exitedAt?: string; exitReason?: string;
  /** Which entry started it and, for a CEO line, its mail id (logged on the receipt). */
  trigger: string; ceoLine?: { msgId: number; crownDirective: string }; allIn: boolean;
}

export function startBurst(input: { goal: BurstGoal; until: string; scope: string[]; by: string; now: Date; preset?: BurstPreset | null; budgetUsd?: number; baseline?: { landed: number | null; green: number | null }; trigger?: string; ceoLine?: { msgId: number; crownDirective: string }; allIn?: boolean }, active: BurstState | null): BurstState {
  if (active && active.status === 'active') throw new Error(`burst ${active.id} is already active until ${active.until} — stop it first (eln pulse burst stop)`);
  if (Number.isNaN(Date.parse(input.until)) || Date.parse(input.until) <= input.now.getTime()) throw new Error(`--until must be a future ISO time (got ${input.until})`);
  const budget = input.budgetUsd ?? input.preset?.budgetUsd;
  if (budget === undefined || budget < 0) throw new Error('a burst needs a budget ceiling: --preset or --budget-usd');
  return { id: `burst-${input.now.toISOString().replace(/[-:]/g, '').slice(0, 13)}`, status: 'active', goal: input.goal, preset: input.preset?.name ?? null,
    scope: input.scope, startedAt: input.now.toISOString(), until: input.until, by: input.by, budgetUsd: budget, spentUsd: 0, cloudApprovedUsd: 0,
    levels: { ...(input.preset?.lanes ?? {}) }, lastChangeAt: {}, launches: [], baseline: input.baseline ?? { landed: null, green: null },
    trigger: input.trigger ?? `manual:${input.by}`, allIn: input.allIn === true, ...(input.ceoLine ? { ceoLine: input.ceoLine } : {}) };
}

/** A launch is recorded with its exact id (pane · TA run · host) so exit can close it — refused when over budget. */
export function recordLaunch(state: BurstState, launch: Omit<BurstLaunch, 'at'>, now: Date, costUsd = 0): BurstState {
  if (state.status !== 'active') throw new Error(`burst ${state.id} is ${state.status} — no new launches`);
  if (state.spentUsd + costUsd > state.budgetUsd) throw new Error(`budget ceiling: spent $${state.spentUsd} + $${costUsd} > $${state.budgetUsd} — launch refused`);
  if (!launch.id.trim()) throw new Error('a launch needs its exact id');
  return { ...state, spentUsd: state.spentUsd + costUsd, launches: [...state.launches, { ...launch, at: now.toISOString() }] };
}

export type BurstCourse = { action: 'continue' | 'extend' | 'shrink' | 'exit-early' | 'exit-until' | 'exit-budget'; why: string; until?: string };

/** Re-forecast inside a burst (every burst pulse): exit early when the base rate already makes it, extend/shrink to the preset that fits. */
export function burstCourse(state: BurstState, row: ForecastRow | null, now: Date, presets: readonly BurstPreset[]): BurstCourse {
  if (now.getTime() >= Date.parse(state.until)) return { action: 'exit-until', why: `until ${state.until} reached` };
  if (state.spentUsd >= state.budgetUsd) return { action: 'exit-budget', why: `spent $${state.spentUsd} ≥ ceiling $${state.budgetUsd}` };
  if (!row) return { action: 'continue', why: 'no deadline in scope to re-forecast' };
  if (row.shortfall === 0) return { action: 'exit-early', why: `base rate ${row.ratePerH}/h finishes ${row.remaining} by ${row.at} — caught up` };
  const left = (Date.parse(state.until) - now.getTime()) / 3_600_000;
  const need = row.preset ? presets.find(p => p.name === row.preset) : undefined;
  if (need && need.hours > left + 0.25) {
    const until = new Date(now.getTime() + need.hours * 3_600_000).toISOString();
    return { action: 'extend', why: `shortfall ${row.shortfall} needs ${need.name} — ${left.toFixed(1)}h left`, until: until < row.at ? until : row.at };
  }
  if (need && need.hours < left - 0.25) return { action: 'shrink', why: `${need.name} now suffices (${left.toFixed(1)}h left)`, until: new Date(now.getTime() + need.hours * 3_600_000).toISOString() };
  return { action: 'continue', why: `shortfall ${row.shortfall} · on course` };
}

export interface BurstReceipt {
  id: string; goal: BurstGoal; preset: string | null; scope: string[]; startedAt: string; exitedAt: string; minutes: number; reason: string;
  launched: number; closed: number; closeFailed: Array<{ lane: BurstLane; id: string; error: string }>;
  landed: number | null; green: number | null; costUsd: number; trigger: string; ceoLine: { msgId: number; crownDirective: string } | null;
}

/**
 * Clean exit: stop new launches (status exited), close every open launch by its exact id (VMs it started included),
 * return hands to the pool (the closer's job for hand tabs), and build the receipt. In-flight work is not killed —
 * TA runs are closed only after their own end (the closer decides per lane).
 */
export async function exitBurst(state: BurstState, input: { now: Date; reason: string; closer: (launch: BurstLaunch) => Promise<void>; landedNow: number | null; greenNow: number | null }): Promise<{ state: BurstState; receipt: BurstReceipt }> {
  const launches: BurstLaunch[] = [];
  const failed: BurstReceipt['closeFailed'] = [];
  for (const l of state.launches) {
    if (l.closedAt) { launches.push(l); continue; }
    try { await input.closer(l); launches.push({ ...l, closedAt: input.now.toISOString() }); }
    catch (error) { const msg = error instanceof Error ? error.message : String(error); failed.push({ lane: l.lane, id: l.id, error: msg }); launches.push({ ...l, closeFailed: msg }); }
  }
  const exited: BurstState = { ...state, status: 'exited', launches, exitedAt: input.now.toISOString(), exitReason: input.reason, levels: {} };
  const delta = (now: number | null, base: number | null) => now === null || base === null ? null : Math.max(0, now - base);
  return { state: exited, receipt: {
    id: state.id, trigger: state.trigger, ceoLine: state.ceoLine ?? null, goal: state.goal, preset: state.preset, scope: state.scope, startedAt: state.startedAt, exitedAt: input.now.toISOString(),
    minutes: Math.round((input.now.getTime() - Date.parse(state.startedAt)) / 60_000), reason: input.reason,
    launched: state.launches.length, closed: launches.filter(l => l.closedAt).length, closeFailed: failed,
    landed: delta(input.landedNow, state.baseline.landed), green: delta(input.greenNow, state.baseline.green), costUsd: state.spentUsd } };
}

/** Parse the rhythm yaml `burst` block over the code defaults. */
export function parseBurstConfig(raw: unknown, cloudBudgetFromConfig?: number): BurstConfig {
  const b = (raw && typeof raw === 'object' ? raw : {}) as { lanes?: Record<string, Record<string, unknown>>; presets?: unknown[]; cloud_budget_usd?: unknown };
  const lanes = { ...DEFAULT_LANES };
  for (const [name, row] of Object.entries(b.lanes ?? {})) {
    if (!BURST_LANES.includes(name as BurstLane)) throw new Error(`burst.lanes.${name} is not a known lane`);
    const d = DEFAULT_LANES[name as BurstLane];
    const n = (k: string, def: number) => { const v = row[k]; if (v === undefined) return def; if (typeof v !== 'number' || v < 0) throw new Error(`burst.lanes.${name}.${k} must be a non-negative number`); return v; };
    const cfg: LaneConfig = { min: n('min', d.min), max: n('max', d.max), step: n('step', d.step), cooldownMin: n('cooldown_min', d.cooldownMin), upAt: n('up_at', d.upAt), downAt: n('down_at', d.downAt), costPerUnitHourUsd: n('cost_per_unit_hour_usd', d.costPerUnitHourUsd) };
    if (cfg.downAt >= cfg.upAt) throw new Error(`burst.lanes.${name}: down_at must be below up_at (hysteresis)`);
    if (cfg.min > cfg.max) throw new Error(`burst.lanes.${name}: min > max`);
    lanes[name as BurstLane] = cfg;
  }
  const presets = Array.isArray(b.presets) && b.presets.length ? b.presets.map((p, i) => {
    const r = p as Record<string, unknown>;
    if (r.name !== '2h' && r.name !== '4h' && r.name !== '8h') throw new Error(`burst.presets[${i}].name must be 2h|4h|8h`);
    const hours = Number(r.hours); const gain = Number(r.rate_gain); const budget = Number(r.budget_usd);
    if (!(hours > 0) || !(gain > 1) || !(budget >= 0)) throw new Error(`burst.presets[${i}] needs hours > 0 · rate_gain > 1 · budget_usd ≥ 0`);
    return { name: r.name, hours, rateGain: gain, budgetUsd: budget, lanes: (r.lanes ?? {}) as Partial<Record<BurstLane, number>> } as BurstPreset;
  }) : DEFAULT_PRESETS;
  const cloud = cloudBudgetFromConfig ?? (typeof b.cloud_budget_usd === 'number' ? b.cloud_budget_usd : 0);
  return { lanes, presets, cloudBudgetUsd: cloud };
}
