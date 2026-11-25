/**
 * Burst Board — the same board in two body temperatures. Calm: a breathing dot, «Quiet» band, sparse slow dots.
 * Burst: «BURST 4h» header with a countdown, hands popping into the grid, dense lanes, a bottleneck piling up and
 * clearing after a step-up. Pure: snapshot + width + frame → lines. Every motion comes from the snapshot (counts,
 * measured rates, events that arrived in it); `frame` (0..3) only tweens between two 2-second snapshots.
 */
import {
  renderCountdown,
  renderFlowLane,
  renderHandGrid,
  renderHostTile,
  renderPulseDot,
  renderSparkline,
  renderTicker,
  type Hand,
  type HostTileProps,
  type TickerEvent,
} from '../index.js';
import { bar, cells, clean, fit, num, pad, padStart } from '../text.js';

export type BurstMode = 'calm' | 'burst' | 'exiting' | 'done';

export interface BurstLane {
  readonly label: string;
  readonly now: number;
  readonly plan: number;
  readonly queue: number;
  /** Minutes; undefined = «—». */
  readonly waitMin?: number;
  readonly leadMin?: number;
  /** Cells per snapshot the lane's dots advance (from the measured rate). */
  readonly speed: number;
  readonly bottleneck?: boolean;
  /** Stepped up in this snapshot — shows a «▲ +N» badge for the first half of the tween. */
  readonly steppedBy?: number;
  /** Scaled above its calm size — the track widens to a second row (full board only). */
  readonly widened?: boolean;
  readonly note?: string;
}

export interface BurstReceipt {
  readonly durationLabel: string;
  readonly landed: number;
  readonly spend: string;
  readonly handsClosed: number;
  readonly vmsOff: readonly string[];
  readonly forecast: string;
}

export interface BurstBoardSnapshot {
  readonly release: string;
  readonly mode: BurstMode;
  /** Snapshot index (one per 2-second refresh). */
  readonly tick: number;
  readonly rhythmMin: number;
  readonly preset?: string;
  readonly trigger?: string;
  readonly elapsedSec: number;
  readonly totalSec: number;
  readonly pressure: number;
  readonly pressureAlarm: number;
  readonly deadline: string;
  readonly forecast: string;
  readonly forecastOk: boolean;
  readonly forecastWas?: string;
  readonly spendUsd: number;
  readonly ceilingUsd: number;
  readonly lanes: readonly BurstLane[];
  readonly hands: readonly Hand[];
  readonly hosts: readonly Omit<HostTileProps, 'frame'>[];
  readonly landedPerHour: readonly number[];
  readonly greenPerHour: readonly number[];
  readonly landTarget: number;
  readonly events: readonly TickerEvent[];
  readonly freshEvent: boolean;
  /** Exit sequence step 1..4 while `mode` = exiting. */
  readonly exitStep?: number;
  readonly receipt?: BurstReceipt;
}

export const BURST_FRAMES = 4;
const KEYS = '[b]urst [p]lan [x]exit [?]';
export const EXIT_STEPS = ['Stop new launches', 'Finish in-flight', 'Close hands', 'Cloud off'] as const;

const dash = (v: number | undefined): string => (v === undefined ? '—' : `${num(v)}m`);

function header(s: BurstBoardSnapshot, width: number): string {
  const dot = renderPulseDot({ tick: s.tick, busy: s.mode === 'burst' || s.mode === 'exiting' });
  let left: string;
  switch (s.mode) {
    case 'calm': left = `${dot} Burst Board · ${s.release} · Calm · rhythm ${num(s.rhythmMin)}m`; break;
    case 'done': left = `${dot} Burst Board · ${s.release} · Burst ended · back to calm`; break;
    case 'exiting': left = `${dot} EXIT ${s.exitStep ?? 1}/4 · ${EXIT_STEPS[(s.exitStep ?? 1) - 1]} · Burst Board · ${s.release}`; break;
    case 'burst': left = `${dot} BURST ${s.preset ?? ''} · Burst Board · ${s.release}${s.trigger ? ` · trigger: ${clean(s.trigger)}` : ''}`; break;
  }
  if (width < 100) return fit(left, width);
  return `${pad(left, width - cells(KEYS) - 1)} ${KEYS}`;
}

function topLine(s: BurstBoardSnapshot, width: number): string {
  const p = Math.min(1, Math.max(0, s.pressure));
  const alarm = p >= s.pressureAlarm ? ' PRESSURE' : '';
  const gauge = `Pressure ${bar(p, width >= 100 ? 14 : 8)} ${p.toFixed(2)}${alarm}`;
  const fc = `Deadline ${clean(s.deadline)} · forecast ${clean(s.forecast)} ${s.forecastOk ? '✓' : '✗'}${s.forecastWas ? ` (was ${clean(s.forecastWas)})` : ''}`;
  const spend = `Spend $${s.spendUsd.toFixed(2)} / $${num(s.ceilingUsd)}`;
  return fit(width >= 100 ? `${gauge}   ${fc}   ${spend}` : `${gauge} · ${fc}`, width);
}

function laneRows(s: BurstBoardSnapshot, width: number, frame: number): string[] {
  const wide = width >= 100;
  const labelW = wide ? 18 : 12;
  const flowW = wide ? 28 : Math.max(8, width - labelW - 34);
  const head = wide
    ? `${pad('Pipeline', labelW)}  now → plan  queue  wait  lead  flow →`
    : `${pad('Pipeline', labelW)} now→plan  q wait flow →`;
  const rows = s.lanes.flatMap((lane, i) => {
    const flow = renderFlowLane({ items: lane.queue + (s.mode === 'exiting' ? 0 : lane.now), speed: lane.speed, blocked: lane.bottleneck, tick: s.tick + i, frame }, flowW);
    const badge = lane.steppedBy && frame < BURST_FRAMES / 2
      ? `▲ +${lane.steppedBy} ${lane.label.toLowerCase()}`
      : lane.bottleneck ? '▲ bottleneck' : lane.plan > lane.now ? '▲ step queued' : lane.plan < lane.now ? '▼ scale down' : '═';
    const note = wide && lane.note ? `  ${clean(lane.note)}` : '';
    const label = pad(` ${i + 1} ${clean(lane.label)}`, labelW);
    const line = wide
      ? `${label}  ${pad(`${padStart(num(lane.now), 3)} → ${num(lane.plan)}`, 10)}  ${padStart(num(lane.queue), 5)}  ${padStart(dash(lane.waitMin), 4)}  ${padStart(dash(lane.leadMin), 4)}  ${flow} ${badge}${note}`
      : `${label} ${pad(`${num(lane.now)}→${num(lane.plan)}`, 8)} ${padStart(num(lane.queue), 2)} ${padStart(dash(lane.waitMin), 4)} ${flow} ${badge}`;
    if (!wide || !lane.widened) return [fit(line, width)];
    const second = renderFlowLane({ items: Math.ceil((lane.queue + lane.now) / 2), speed: lane.speed, tick: s.tick + i + 3, frame }, flowW);
    return [fit(line, width), fit(`${' '.repeat(labelW + 30)}${second}`, width)];
  });
  return [fit(head, width), ...rows];
}

function handsBlock(s: BurstBoardSnapshot, width: number, frame: number, maxRows: number): string[] {
  const working = s.hands.filter((h) => h.state === 'busy' || h.state === 'new').length;
  const open = s.hands.filter((h) => h.state !== 'closing').length;
  return [
    fit(`Hands ${working} working / ${open} open`, width),
    ...renderHandGrid({ hands: s.hands, frame, frames: BURST_FRAMES, maxRows }, width - 2).map((l) => `  ${l}`),
  ];
}

function receiptBlock(r: BurstReceipt, width: number): string[] {
  return [
    fit(`Receipt · burst ${clean(r.durationLabel)} · forecast ${clean(r.forecast)}`, width),
    fit(`  landed ${num(r.landed)} · spend ${clean(r.spend)} · hands closed ${num(r.handsClosed)} · VMs off ${r.vmsOff.length ? r.vmsOff.map(clean).join(', ') : 'none'}`, width),
    fit('  every launched resource released ✓', width),
  ];
}

/** 120×36 full board (≥100 columns) or the 80×24 compact board; never more lines than the target height. */
export function renderBurstBoard(snapshot: BurstBoardSnapshot, width: number, frame = 0): string[] {
  const f = Math.max(0, Math.min(BURST_FRAMES - 1, Math.floor(frame)));
  const rule = '─'.repeat(Math.max(0, width));
  const busy = snapshot.mode === 'burst' || snapshot.mode === 'exiting';
  const status = busy
    ? fit(`${snapshot.mode === 'exiting' ? 'Exit ' : 'Burst'} ${renderCountdown({ elapsedSec: snapshot.elapsedSec, totalSec: snapshot.totalSec }, width - 6)}`, width)
    : fit('Quiet · resources at rest · cloud off', width);
  const wide = width >= 100;
  const throughput = renderSparkline({ label: 'Landed/h', values: snapshot.landedPerHour, target: snapshot.landTarget }, wide ? 60 : width);
  const ticker = renderTicker({ events: snapshot.events, fresh: snapshot.freshEvent, frame: f, frames: BURST_FRAMES }, width - 8);
  const events = fit(`Events  ${ticker}`, width);
  if (!wide) {
    return [
      header(snapshot, width), status, topLine(snapshot, width), rule,
      ...laneRows(snapshot, width, f), rule,
      ...(snapshot.receipt ? receiptBlock(snapshot.receipt, width) : handsBlock(snapshot, width, f, 4)), rule,
      throughput, events,
    ];
  }
  const green = renderSparkline({ label: 'Green/h', values: snapshot.greenPerHour, max: snapshot.landTarget }, width - cells(throughput) - 3);
  const hosts = snapshot.hosts.map((host) => `  ${renderHostTile({ ...host, frame: snapshot.tick }, width - 2)}`);
  return [
    header(snapshot, width), status, rule, topLine(snapshot, width), rule,
    ...laneRows(snapshot, width, f), rule,
    ...handsBlock(snapshot, width, f, 6), rule,
    fit('Hosts (local first → LAN → cloud)', width), ...hosts, rule,
    ...(snapshot.receipt ? [...receiptBlock(snapshot.receipt, width), rule] : []),
    fit(`${throughput}   ${green}`, width), events,
  ];
}
