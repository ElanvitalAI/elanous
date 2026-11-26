/**
 * Burst Board engine — one path from planner output to a board snapshot, shared by the live board and the replay.
 *
 * S  The board must show the burst planner's own numbers (no hand-made screen values).
 * C  The live board reads the real probes; the demo replay needs the same planner driven by a synthetic world.
 * Q  How do both produce a BurstBoardSnapshot without two renderers' worth of logic?
 * A  `planBurst` calls the real `pressures` + `planScale`; `boardSnapshot` maps planner rows + KPI + hosts + burst
 *    state onto the scene type. Anything not measured stays undefined/null and the scene prints «no data».
 */
import { DEFAULT_LEAD_MIN, planScale, pressures, type BurstConfig, type BurstLane as PlannerLane, type BurstState, type HostSlots,
  type LanePressure, type PressureSignals, type ScaleDecision } from '../../../loops/op-pulse-burst.js';
import type { Hand } from '../hand-grid.js';
import type { HostTileProps } from '../host-tile.js';
import type { TickerEvent } from '../ticker.js';
import type { BurstBoardSnapshot, BurstLane, BurstMode, BurstReceipt } from './burst-board.js';

/** Board rows, front → back. Hands folds the planner's production lanes (hands · remote · ta). */
export const BOARD_LANES = [
  { label: 'Hands', lanes: ['hands', 'remote'] as PlannerLane[], pressureLane: 'hands' as PlannerLane },
  { label: 'Review', lanes: ['review'] as PlannerLane[], pressureLane: 'review' as PlannerLane },
  { label: 'Pregate', lanes: ['pregate'] as PlannerLane[], pressureLane: 'pregate' as PlannerLane },
  { label: 'Judge', lanes: ['judge'] as PlannerLane[], pressureLane: 'judge' as PlannerLane },
  { label: 'Land', lanes: ['land'] as PlannerLane[], pressureLane: 'land' as PlannerLane },
] as const;

export interface PlannedBurst { readonly pressures: readonly LanePressure[]; readonly plan: readonly ScaleDecision[] }

export interface PlanInput {
  readonly signals: PressureSignals;
  readonly active: BurstState | null;
  readonly config: BurstConfig;
  readonly hosts?: readonly HostSlots[];
  readonly now: Date;
  readonly forecastMisses: boolean;
  readonly hoursLeft: number;
}

/** The real planner — same call `eln pulse burst plan` makes. */
export function planBurst(input: PlanInput): PlannedBurst {
  const press = pressures(input.signals);
  const a = input.active;
  const plan = planScale({
    levels: a?.levels ?? {}, lastChangeAt: a?.lastChangeAt ?? {}, pressures: press, now: input.now, config: input.config,
    spentUsd: a?.spentUsd ?? 0, budgetUsd: a?.budgetUsd ?? Infinity, cloudApprovedUsd: a?.cloudApprovedUsd ?? 0,
    hoursLeft: input.hoursLeft, forecastMisses: input.forecastMisses, ...(a?.allIn ? { allIn: true } : {}),
    ...(input.hosts ? { hosts: input.hosts } : {}),
  });
  return { pressures: press, plan };
}

/** Per-board-lane measured queue · wait · base capacity (standing, not burst-added). null = not measured. */
export interface LaneMeasure { readonly queue: number | null; readonly waitMin: number | null; readonly base: number | null; readonly ratePerH?: number | null }

export interface HostMeasure extends HostSlots { readonly load?: number | null; readonly role?: string; readonly sim?: boolean; readonly card?: boolean; readonly off?: boolean }

export interface BoardInput {
  readonly source: 'live' | 'replay';
  readonly tick: number;
  readonly release: string | null;
  readonly mode: BurstMode;
  readonly active: BurstState | null;
  readonly planned: PlannedBurst | null;
  readonly config: BurstConfig;
  readonly measures: Partial<Record<(typeof BOARD_LANES)[number]['label'], LaneMeasure>>;
  readonly hands: readonly Hand[] | null;
  readonly hosts: readonly HostMeasure[] | null;
  readonly landedPerHour: readonly number[] | null;
  readonly greenPerHour: readonly number[] | null;
  readonly landTarget: number;
  readonly events: readonly TickerEvent[];
  readonly freshEvent: boolean;
  readonly deadline: string | null;
  readonly forecast: string | null;
  readonly forecastOk: boolean | null;
  readonly forecastWas?: string;
  readonly elapsedSec: number;
  readonly totalSec: number;
  readonly rhythmMin: number;
  readonly steppedThisTick?: Partial<Record<PlannerLane, number>>;
  readonly exitStep?: number;
  readonly receipt?: BurstReceipt;
  readonly gaps: readonly string[];
  readonly nextHost?: string | null;
  /** Wall clock of the snapshot (HH:MM). */
  readonly clock?: string;
}

const level = (active: BurstState | null, config: BurstConfig, lane: PlannerLane): number => active?.levels[lane] ?? config.lanes[lane].min;

/** Highest lane pressure, or null when nothing was measured. */
export function boardPressure(planned: PlannedBurst | null, config: BurstConfig): number | null {
  if (!planned) return null;
  const vals = planned.pressures.filter((p) => p.pressure !== null).map((p) => (p.pressure as number) / (config.lanes[p.lane].upAt * 2));
  return vals.length ? Math.min(1, Math.max(...vals)) : null;
}

export function boardSnapshot(input: BoardInput): BurstBoardSnapshot {
  const { active, config, planned } = input;
  const decisions = planned?.plan ?? [];
  const stepping = decisions.find((d) => d.to > d.from && !d.blocked);
  const lanes: BurstLane[] = BOARD_LANES.map((row) => {
    const m = input.measures[row.label];
    const added = row.lanes.reduce((n, l) => n + level(active, config, l), 0);
    const base = m?.base ?? null;
    const now = base === null ? null : base + added;
    const mine = decisions.filter((d) => row.lanes.includes(d.lane));
    const up = mine.filter((d) => !d.blocked).reduce((n, d) => n + (d.to - d.from), 0);
    const pr = planned?.pressures.find((p) => p.lane === row.pressureLane) ?? null;
    const bottleneck = stepping ? row.lanes.includes(stepping.lane) && STAGE_OF[stepping.lane] > 0 : false;
    const blocked = mine.find((d) => d.blocked);
    const stepped = row.lanes.reduce((n, l) => n + (input.steppedThisTick?.[l] ?? 0), 0);
    const note = stepping && row.lanes.includes(stepping.lane) ? stepping.why : blocked ? `held: ${blocked.blocked} · ${blocked.why}` : pr?.pressure === null ? 'no data' : undefined;
    const rate = m?.ratePerH ?? null;
    return {
      label: row.label,
      ...(now === null ? {} : { now, plan: now + up }),
      queue: m?.queue ?? undefined,
      ...(m?.waitMin === null || m?.waitMin === undefined ? {} : { waitMin: Math.round(m.waitMin) }),
      leadMin: Math.max(...row.lanes.map((l) => DEFAULT_LEAD_MIN[l])),
      speed: rate === null ? 0 : Math.max(0, Math.min(3, Math.round(rate / 8))),
      ...(bottleneck ? { bottleneck: true } : {}),
      ...(stepped > 0 ? { steppedBy: stepped } : {}),
      ...(base !== null && added > 0 && row.label !== 'Hands' ? { widened: true } : {}),
      ...(pr ? { pressure: pr.pressure } : {}),
      ...(note ? { note } : {}),
    } as BurstLane;
  });
  const hosts: Omit<HostTileProps, 'frame'>[] = (input.hosts ?? []).map((h) => ({
    name: h.host, kind: h.kind, used: h.used, cap: h.cap,
    ...(h.load === null || h.load === undefined ? {} : { load: Math.round(h.load * 10) / 10 }),
    ...(h.role ? { role: h.role } : {}),
    state: h.card ? 'card' : h.off ? 'off' : h.used >= h.cap ? 'cap' : 'on',
    ...(input.nextHost === h.host ? { next: true } : {}),
    ...(h.sim ? { sim: true } : {}),
  }));
  return {
    release: input.release ?? 'no data',
    mode: input.mode,
    tick: input.tick,
    rhythmMin: input.rhythmMin,
    ...(active?.preset ? { preset: active.preset } : {}),
    ...(active ? { trigger: active.ceoLine ? `CEO «all resources» (#${active.ceoLine.msgId})` : active.trigger } : {}),
    elapsedSec: input.elapsedSec,
    totalSec: input.totalSec,
    pressure: boardPressure(planned, config),
    pressureAlarm: 0.75,
    deadline: input.deadline ?? 'no data',
    forecast: input.forecast ?? 'no data',
    forecastOk: input.forecastOk ?? false,
    ...(input.forecastWas ? { forecastWas: input.forecastWas } : {}),
    spendUsd: active?.spentUsd ?? 0,
    ceilingUsd: active?.budgetUsd ?? 0,
    lanes,
    hands: input.hands ?? [],
    hosts,
    landedPerHour: input.landedPerHour ?? [],
    greenPerHour: input.greenPerHour ?? [],
    landTarget: input.landTarget,
    events: input.events,
    freshEvent: input.freshEvent,
    ...(input.exitStep ? { exitStep: input.exitStep } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    source: input.source,
    gaps: input.gaps,
    plan: decisions.map((d) => ({ lane: d.lane, from: d.from, to: d.to, why: d.why, ...(d.blocked ? { blocked: d.blocked } : {}) })),
    pressures: (planned?.pressures ?? []).map((p) => ({ lane: p.lane, pressure: p.pressure, why: p.why })),
    ...(active ? { burstId: active.id } : {}),
    ...(input.clock ? { clock: input.clock } : {}),
    handsMeasured: input.hands !== null,
    hostsMeasured: input.hosts !== null,
  };
}

const STAGE_OF: Record<PlannerLane, number> = { hands: 0, ta: 0, remote: 0, vm: 0, review: 1, pregate: 2, judge: 3, land: 4 };
