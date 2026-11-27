/**
 * Burst Board B2 — `collectBurstSnapshot`: the live board's data, read from the same sources as `eln pulse burst plan`.
 *   planner  = livePulseProbes().measure → pressures → planScale (burst-engine.planBurst) over the rhythm yaml config
 *   burst    = <seat-state>/OP/pulse/burst.json (active burst) · burst-receipts.jsonl (last receipt)
 *   fed-state= fedKpi() landed/h (federation ledger) for the throughput line
 *   RES      = capacity catalog (hosts · load1) + live leases (cloud on/off) + pregate slot caps from the RES policy
 * Every source is read inside its own try; a failed source becomes a «no data» gap — the board never crashes on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BURST_CONFIG, type BurstConfig, type BurstState } from '../../../loops/op-pulse-burst.js';
import type { Hand } from '../hand-grid.js';
import type { BurstBoardSnapshot, BurstReceipt } from './burst-board.js';
import { boardSnapshot, planBurst, type HostMeasure, type LaneMeasure, type PlannedBurst } from './burst-engine.js';

export interface LiveReadings {
  readonly now: Date;
  readonly release: string | null;
  readonly planned: PlannedBurst | null;
  readonly config: BurstConfig;
  readonly active: BurstState | null;
  readonly lastReceipt: { id: string; landed?: number | null; minutes: number; launched: number; closed: number; costUsd: number; reason: string } | null;
  readonly landedPerHour: readonly number[] | null;
  readonly greenPerHour: readonly number[] | null;
  readonly hands: readonly Hand[] | null;
  readonly hosts: readonly HostMeasure[] | null;
  readonly measures: Partial<Record<'Hands' | 'Review' | 'Pregate' | 'Veto' | 'Land', LaneMeasure>>;
  readonly landTarget: number;
  readonly gaps: readonly string[];
  readonly events: readonly { at: string; text: string }[];
  /** Test universe only: the synthetic forecast the «all resources» driver writes (burst-allin.ts). */
  readonly synthetic?: { lanes?: Partial<Record<'Hands' | 'Review' | 'Pregate' | 'Veto' | 'Land', { queue: number | null; waitMin: number | null }>>; deadline: string; forecast: string; forecastOk: boolean; forecastWas?: string; landedPerHour: readonly number[] } | null;
}

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Pure: readings → snapshot (tested with literal readings, incl. every source missing). */
export function liveSnapshot(r: LiveReadings, tick: number): BurstBoardSnapshot {
  const a = r.active;
  const startedAt = a ? Date.parse(a.startedAt) : r.now.getTime();
  const totalSec = a ? Math.max(1, Math.round((Date.parse(a.until) - startedAt) / 1000)) : 4 * 3600;
  const receipt: BurstReceipt | undefined = !a && r.lastReceipt ? {
    durationLabel: `${Math.floor(r.lastReceipt.minutes / 60)}:${String(r.lastReceipt.minutes % 60).padStart(2, '0')} (${r.lastReceipt.reason})`,
    landed: r.lastReceipt.landed ?? 0, spend: `$${r.lastReceipt.costUsd.toFixed(2)}`, handsClosed: r.lastReceipt.closed, vmsOff: [], forecast: r.lastReceipt.id,
  } : undefined;
  const nowMs = r.now.getTime();
  const launched: Hand[] = (a?.launches ?? []).filter((l) => (l.lane === 'hands' || l.lane === 'remote') && !l.closedAt)
    .map((l) => ({ host: l.host ?? 'mshq', state: nowMs - Date.parse(l.at) < 6_000 ? 'new' : 'busy', task: l.id } as Hand));
  const hands = r.hands === null && launched.length === 0 ? null : [...(r.hands ?? []), ...launched];
  const steppedThisTick: Record<string, number> = {};
  for (const [lane, at] of Object.entries(a?.lastChangeAt ?? {})) if (at && nowMs - Date.parse(at) < 6_000) steppedThisTick[lane] = Number(a?.levels[lane as keyof typeof a.levels] ?? 0);
  const syn = r.synthetic ?? null;
  // Test universe: lanes the real probes leave unmeasured start from 0 so the burst's own steps show (queue/wait = synthetic).
  const measures: LiveReadings['measures'] = { ...r.measures };
  if (syn) for (const label of ['Hands', 'Review', 'Pregate', 'Veto', 'Land'] as const) {
    const m = measures[label];
    const sl = syn.lanes?.[label];
    measures[label] = { ...(m ?? { queue: null, waitMin: null }), base: m?.base ?? 0, ...(sl ? { queue: sl.queue, waitMin: sl.waitMin } : {}) } as LaneMeasure;
  }
  return boardSnapshot({
    source: 'live', tick, release: r.release, mode: a ? 'burst' : receipt ? 'done' : 'calm', active: a, planned: r.planned,
    config: r.config,
    measures, hands, hosts: r.hosts, landedPerHour: syn ? syn.landedPerHour : r.landedPerHour, steppedThisTick, greenPerHour: r.greenPerHour, landTarget: r.landTarget,
    events: r.events, freshEvent: false, deadline: syn ? syn.deadline : a ? `until ${hhmm(new Date(a.until))}` : null, forecast: syn?.forecast ?? null, forecastOk: syn?.forecastOk ?? null,
    ...(syn?.forecastWas ? { forecastWas: syn.forecastWas } : {}),
    elapsedSec: Math.max(0, Math.round((r.now.getTime() - startedAt) / 1000)), totalSec, rhythmMin: 60,
    ...(receipt ? { receipt } : {}), gaps: r.gaps, clock: hhmm(r.now),
  });
}

const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 60);

/** Active JUD vetoes on the land graph (holds by the veto owner) — the board's «Veto» lane (JUD-RELAX: veto only). null = unread. */
export function liveVetoCount(): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { holdVerdict, readHolds } = require('../../../land-graph/land-graph.js') as typeof import('../../../land-graph/land-graph.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { effectiveInstanceRoot } = require('../../../instance/resolve.js') as typeof import('../../../instance/resolve.js');
    return Object.values(readHolds(effectiveInstanceRoot())).filter(h => holdVerdict(h).block !== null).length;
  } catch { return null; }
}

/** Read every live source once (slow: one git fetch inside the pulse measure). */
export async function readLiveSources(opts: { seatState?: string; now?: Date } = {}): Promise<LiveReadings> {
  const now = opts.now ?? new Date();
  const gaps: string[] = [];
  const seatState = opts.seatState ?? process.env.ELANOUS_SEAT_STATE ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state');
  const burstPath = join(seatState, 'OP', 'pulse', 'burst.json');
  const receiptsPath = join(seatState, 'OP', 'pulse', 'burst-receipts.jsonl');
  let active: BurstState | null = null;
  try { active = (await import('../../../loops/op-pulse-run.js')).readActiveBurst(burstPath); } catch (e) { gaps.push(`burst state (${short(e)})`); }
  let lastReceipt: LiveReadings['lastReceipt'] = null;
  try {
    if (existsSync(receiptsPath)) {
      const last = readFileSync(receiptsPath, 'utf8').trim().split('\n').filter(Boolean).at(-1);
      if (last) lastReceipt = JSON.parse(last);
    }
  } catch (e) { gaps.push(`burst receipt (${short(e)})`); }
  let planned: PlannedBurst | null = null;
  let config: BurstConfig = DEFAULT_BURST_CONFIG;
  let release: string | null = null;
  let hands: Hand[] | null = null;
  const measures: LiveReadings['measures'] = {};
  try {
    const { loadRhythmAndBurst } = await import('../../../loops/op-pulse-run.js');
    const { rhythmRow } = await import('../../../loops/op-pulse.js');
    const { livePulseProbes } = await import('../../../loops/op-pulse-live.js');
    const { rhythm, burst: cfg } = loadRhythmAndBurst(join(import.meta.dir, '../../../../graphs/triggers/op-pulse.rhythm.yaml'));
    config = cfg;
    const { measure, extra } = await livePulseProbes().measure(now);
    release = measure.version;
    for (const u of measure.unmeasured) gaps.push(u);
    const row = rhythmRow(rhythm, active ? 'burst' : 'build');
    const handsN = measure.spaces.reduce((n, s) => n + (s.hands ?? 0), 0) || null;
    planned = planBurst({
      signals: { targetGapRatio: measure.landedPerH && row.targets.landedPerH ? row.targets.landedPerH / Math.max(0.1, measure.landedPerH) : null,
        readyBacklog: extra.readyBacklog, hands: handsN, readyPerHand: row.targets.readyPerHand ?? 2,
        judgeWaitMin: measure.judgeWaitMedianMin === null ? null : Math.round(measure.judgeWaitMedianMin), judgeWaitTargetMin: row.targets.judgeWaitMedianMin ?? 30, judgeQueue: measure.judgeQueue,
        gateWaitMin: extra.gateWaitMin, gateWaitTargetMin: 10, reviewWaitMin: extra.reviewWaitMin, reviewWaitTargetMin: 20,
        landQueue: extra.landQueue, landQueueTarget: 6, hoursToDeadline: null },
      active, config: cfg, now, forecastMisses: true, hoursLeft: active ? (Date.parse(active.until) - now.getTime()) / 3_600_000 : 4,
      ...(extra.hosts ? { hosts: extra.hosts } : {}),
    });
    measures.Hands = { queue: extra.readyBacklog, waitMin: null, base: handsN };
    measures.Veto = { queue: liveVetoCount(), waitMin: null, base: null };
    measures.Review = { queue: null, waitMin: extra.reviewWaitMin, base: null };
    measures.Pregate = { queue: null, waitMin: extra.gateWaitMin, base: null };
    measures.Land = { queue: extra.landQueue, waitMin: null, base: null };
    hands = [];
    for (const s of measure.spaces) {
      const idle = s.idleWithWork ?? 0;
      for (let i = 0; i < (s.hands ?? 0); i++) hands.push({ host: s.space, state: i < (s.hands ?? 0) - idle ? 'busy' : 'idle' });
    }
  } catch (e) { gaps.push(`planner (${short(e)})`); }
  let landedPerHour: number[] | null = null;
  try {
    const { fedKpi } = await import('../../../fed-state/kpi.js');
    landedPerHour = Array.from({ length: 24 }, (_, i) => Math.round(fedKpi({ window: '1h', now: new Date(now.getTime() - (23 - i) * 10 * 60_000) }).landedPerHour));
    if (landedPerHour.every((v) => v === 0)) gaps.push('fed-state landed (empty ledger)');
  } catch (e) { gaps.push(`fed-state (${short(e)})`); }
  let hosts: HostMeasure[] | null = null;
  try {
    const { loadCatalog } = await import('../../../res-graphs/capacity.js');
    const { resRoot, loadLeases, liveLease } = await import('../../../res-graphs/burst.js');
    const { DEFAULT_RES_POLICY, pregateSlotCap } = await import('../../../res-policy/policy.js');
    const root = resRoot(seatState);
    const leases = loadLeases(root);
    const used = new Map<string, number>();
    for (const l of active?.launches ?? []) if (l.host && !l.closedAt) used.set(l.host, (used.get(l.host) ?? 0) + 1);
    // mshq runs the burst's local hand tabs as well as its pregate slots: cap = hand max + review max + pregate slots.
    hosts = [{ host: 'mshq', kind: 'local', used: used.get('mshq') ?? 0, cap: pregateSlotCap(DEFAULT_RES_POLICY, 'mshq') + config.lanes.hands.max + config.lanes.review.max } as HostMeasure,
      ...loadCatalog(root).filter((h) => h.leasable !== false).map((h): HostMeasure => {
        const lease = h.kind === 'cloud' ? liveLease(leases, h.host) : undefined;
        return { host: h.host, kind: h.kind, used: used.get(h.host) ?? 0, cap: pregateSlotCap(DEFAULT_RES_POLICY, h.host), load: h.load1 ?? null,
          ...(h.kind === 'cloud' && !lease ? { off: true } : {}), ...(lease ? { role: `lease ${lease.state}` } : {}) };
      })].sort((x, y) => ['local', 'lan', 'cloud'].indexOf(x.kind) - ['local', 'lan', 'cloud'].indexOf(y.kind));
  } catch (e) { gaps.push(`RES capacity (${short(e)})`); }
  const events = (active?.launches ?? []).slice(-5).reverse().map((l) => ({ at: hhmm(new Date(l.at)), text: `${l.lane} launched ${l.id}${l.host ? ` on ${l.host}` : ''}` }));
  return { now, release, planned, config, active, lastReceipt, landedPerHour, greenPerHour: null, hands, hosts, measures, landTarget: 20, gaps, events, synthetic: readSynthetic(seatState) };
}

/**
 * Fast re-read (every redraw tick): only the test-universe files that change during a burst — burst state, last
 * receipt, synthetic forecast. The slow planner/fed-state/RES reads stay on their 30 s cycle.
 */
export function refreshFast(r: LiveReadings, seatState: string, now: Date, readActive: (path: string) => BurstState | null): LiveReadings {
  const pulse = join(seatState, 'OP', 'pulse');
  let active = r.active;
  try { active = readActive(join(pulse, 'burst.json')); } catch { /* keep the last read */ }
  let lastReceipt = r.lastReceipt;
  try {
    const p = join(pulse, 'burst-receipts.jsonl');
    if (existsSync(p)) { const last = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).at(-1); if (last) lastReceipt = JSON.parse(last); }
  } catch { /* keep */ }
  const used = new Map<string, number>();
  for (const l of active?.launches ?? []) if (l.host && !l.closedAt) used.set(l.host, (used.get(l.host) ?? 0) + 1);
  const hosts = r.hosts?.map((h) => ({ ...h, used: used.get(h.host) ?? 0 })) ?? null;
  const events = (active?.launches ?? []).slice(-5).reverse().map((l) => ({ at: hhmm(new Date(l.at)), text: `${l.lane} launched ${l.id}${l.host ? ` on ${l.host}` : ''}` }));
  return { ...r, now, active, lastReceipt, hosts, events: events.length ? events : r.events, synthetic: readSynthetic(seatState) };
}

/** The synthetic forecast file — read only from a test universe, never from the real seat-state. */
export function readSynthetic(seatState: string): LiveReadings['synthetic'] {
  if (seatState === join(process.env.HOME ?? '', 'elanous-hq', 'seat-state')) return null;
  try {
    const p = join(seatState, 'OP', 'pulse', 'burst-forecast.json');
    if (!existsSync(p)) return null;
    const f = JSON.parse(readFileSync(p, 'utf8'));
    return f && f.synthetic === true ? f : null;
  } catch { return null; }
}

/** B2 entry: one live snapshot. */
export async function collectBurstSnapshot(opts: { seatState?: string; now?: Date; tick?: number } = {}): Promise<BurstBoardSnapshot> {
  return liveSnapshot(await readLiveSources(opts), opts.tick ?? 0);
}
