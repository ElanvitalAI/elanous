/**
 * Burst Board replay — a synthetic 4-minute scenario (120 snapshots × 2 s) for the demo and the fixtures:
 * calm 30 s → CEO «all resources» → hands burst → review jam → review step-up + cloud card → flow recovers →
 * landed/h crosses the target → early exit (stop → finish → close → cloud off) → receipt.
 * Deterministic state model, not live data: B2 (`collectBurstSnapshot`) swaps this for the burst planner + fed-state.
 */
import type { Hand } from '../hand-grid.js';
import type { HostTileProps } from '../host-tile.js';
import type { TickerEvent } from '../ticker.js';
import { BURST_FRAMES, renderBurstBoard, type BurstBoardSnapshot, type BurstLane } from './burst-board.js';

export const DEMO_TICKS = 120;
export const DEMO_TICK_MS = 2000;
/** Each replay tick stands for two minutes of a 4h burst. */
const BURST_SEC_PER_TICK = 120;
const T_TRIGGER = 15;
const T_JAM = 32;
const T_CARD = 50;
const T_STEP = 58;
const T_EXIT = 92;
const T_DONE = 106;

const EVENTS: ReadonlyArray<readonly [number, string]> = [
  [3, 'calm · 1 card landed'],
  [T_TRIGGER, 'CEO «all resources» → burst 4h'],
  [T_TRIGGER + 1, 'hands +4 (forecast miss 18:40)'],
  [T_TRIGGER + 5, 'node-b pregate +1'],
  [T_TRIGGER + 9, 'hands +6 · local at cap'],
  [T_JAM + 6, 'review queue 6 > 4 in 5m'],
  [T_CARD, 'local+LAN at cap → gcp3 card'],
  [T_STEP, 'review +2 · gcp3 on (card approved)'],
  [T_STEP + 14, 'review queue drained'],
  [84, 'landed/h 21 ≥ target 20'],
  [T_EXIT, 'forecast 15:40 ✓ → early exit'],
  [T_EXIT + 8, 'hands closed 10'],
  [T_EXIT + 12, 'gcp3 off'],
  [T_DONE, 'receipt filed'],
];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const ramp = (t: number, t0: number, t1: number, a: number, b: number): number => (t <= t0 ? a : t >= t1 ? b : a + ((b - a) * (t - t0)) / (t1 - t0));
const clock = (minutes: number): string => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
const stamp = (t: number): string => {
  const sec = Math.max(0, t - T_TRIGGER) * BURST_SEC_PER_TICK;
  return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
};

const HAND_HOSTS = ['mshq', 'mshq', 'mshq', 'mshq', 'mshq', 'mshq', 'minim5', 'minim5', 'node-b', 'node-b', 'node-b', 'node-c', 'node-c', 'mshq', 'mshq', 'node-b'] as const;

function handsAt(t: number): Hand[] {
  if (t >= T_DONE) return HAND_HOSTS.slice(0, 6).map((host, i) => ({ host, state: i < 2 ? 'busy' : 'idle' }));
  const opened = t < T_TRIGGER + 1 ? 6 : clamp(6 + (t - T_TRIGGER), 6, 16);
  const closing = t >= T_EXIT + 4 ? clamp((t - (T_EXIT + 4)) * 2, 0, 10) : 0;
  const hands: Hand[] = [];
  for (let i = 0; i < opened; i++) {
    const host = HAND_HOSTS[i]!;
    if (i < 6) {
      const busy = t < T_TRIGGER ? i < 3 - (t % 5 === 0 ? 1 : 0) : t < T_EXIT + 2;
      hands.push({ host, state: busy ? 'busy' : 'idle' });
      continue;
    }
    const born = T_TRIGGER + (i - 5);
    if (closing && i >= 16 - closing) {
      if (i >= 16 - closing + 2) continue;
      hands.push({ host, state: 'closing' });
      continue;
    }
    hands.push(t === born ? { host, state: 'new', task: `A${300 + i}` } : { host, state: t >= T_EXIT + 2 ? 'idle' : 'busy' });
  }
  return hands;
}

function reviewAt(t: number): { now: number; queue: number; bottleneck: boolean; steppedBy?: number } {
  const now = t >= T_STEP && t < T_DONE ? 4 : 2;
  let queue: number;
  if (t < T_JAM) queue = t < T_TRIGGER ? 1 : 2;
  else if (t < T_STEP) queue = Math.round(ramp(t, T_JAM, T_STEP - 4, 2, 9));
  else queue = Math.round(clamp(9 - (t - T_STEP) * 0.6, 1, 9));
  if (t >= T_EXIT + 2) queue = Math.max(0, queue - (t - T_EXIT - 2));
  return { now, queue, bottleneck: t >= T_JAM + 6 && t < T_STEP + 4, ...(t === T_STEP ? { steppedBy: 2 } : {}) };
}

function lanesAt(t: number): BurstLane[] {
  const calm = t < T_TRIGGER || t >= T_DONE;
  const winding = t >= T_EXIT;
  const hands = handsAt(t).filter((h) => h.state === 'busy' || h.state === 'new').length;
  const review = reviewAt(t);
  const pregate = t >= T_STEP && t < T_EXIT + 12 ? 8 : 6;
  const fast = calm ? 1 : winding ? 2 : 3;
  const drain = (q: number) => (winding ? Math.max(0, q - (t - T_EXIT)) : q);
  const backlog = calm ? 4 : Math.round(ramp(t, T_TRIGGER, T_STEP, 31, 12));
  return [
    { label: 'Hands', now: hands, plan: calm || winding ? hands : 16, queue: drain(backlog), waitMin: calm ? 9 : 4, leadMin: 2, speed: fast,
      ...(t === T_TRIGGER + 1 ? { steppedBy: 4 } : t === T_TRIGGER + 9 ? { steppedBy: 6 } : {}),
      ...(!calm && !winding && hands < 16 ? { note: `ready backlog ${backlog} > 2×hands` } : {}) },
    { label: 'Review', now: review.now, plan: calm ? 2 : review.bottleneck && t < T_STEP ? 4 : review.now, queue: review.queue,
      waitMin: review.bottleneck ? 11 : 3, leadMin: 1, speed: review.bottleneck ? 0 : fast, bottleneck: review.bottleneck,
      ...(review.steppedBy ? { steppedBy: review.steppedBy } : {}), ...(review.now > 2 ? { widened: true } : {}), ...(review.bottleneck ? { note: 'queue > 4 for 5m' } : {}) },
    { label: 'Pregate', now: pregate, plan: pregate, queue: drain(calm ? 0 : 2), waitMin: 3, leadMin: 3, speed: fast, ...(t === T_STEP ? { steppedBy: 2 } : {}), ...(pregate > 6 ? { widened: true } : {}) },
    { label: 'Judge', now: 4, plan: 4, queue: drain(calm ? 0 : 1), waitMin: 2, speed: fast },
    { label: 'Land', now: 2, plan: 2, queue: drain(calm ? 0 : t > T_STEP ? 3 : 1), speed: fast },
    { label: 'Green', now: calm ? 1 : 3, plan: calm ? 1 : 3, queue: 0, speed: calm ? 0 : 1 },
  ];
}

function hostsAt(t: number): Omit<HostTileProps, 'frame'>[] {
  const hands = handsAt(t);
  const on = (host: string) => hands.filter((h) => h.host === host && h.state !== 'closing').length;
  const burst = t >= T_TRIGGER && t < T_DONE;
  const hot = t >= T_TRIGGER && t < T_EXIT + 4;
  const cloud: HostTileProps['state'] = t >= T_CARD && t < T_STEP ? 'card' : t >= T_STEP && t < T_EXIT + 12 ? 'on' : 'off';
  return [
    { name: 'mshq', kind: 'local', used: on('mshq'), cap: 8, load: burst ? 14 : 4, role: `hands ${on('mshq')}`, state: on('mshq') >= 8 ? 'cap' : 'on' },
    { name: 'minim5', kind: 'lan', used: hot ? 4 : 1, cap: 4, load: hot ? 9 : 2, role: `pregate ${hot ? 4 : 1}`, state: hot ? 'cap' : 'on' },
    { name: 'node-b', kind: 'lan', used: on('node-b') + (burst ? 1 : 0), cap: 5, load: burst ? 6 : 1, role: `hands ${on('node-b')} · pregate ${burst ? 1 : 0}`, state: 'on', next: burst && t < T_TRIGGER + 9 },
    { name: 'node-c', kind: 'lan', used: on('node-c'), cap: 2, ...(on('node-c') ? { load: 3 } : {}), role: on('node-c') ? `hands ${on('node-c')}` : 'idle', state: 'on', next: burst && t >= T_TRIGGER + 9 && t < T_CARD },
    cloud === 'on'
      ? { name: 'gcp3', kind: 'cloud', used: 2, cap: 2, load: 5, role: 'pregate 2', state: 'on' }
      : { name: 'gcp3', kind: 'cloud', used: 0, cap: 2, state: cloud },
    { name: 'aws1', kind: 'cloud', used: 0, cap: 2, state: 'off' },
  ];
}

function landedAt(t: number): number {
  if (t < T_TRIGGER) return 8;
  if (t < T_JAM + 6) return Math.round(ramp(t, T_TRIGGER, T_JAM + 6, 8, 13));
  if (t < T_STEP + 4) return 13;
  if (t < T_DONE) return Math.round(ramp(t, T_STEP + 4, 84, 13, 21));
  return 9;
}

const series = (t: number, at: (t: number) => number): number[] => Array.from({ length: 12 }, (_, i) => at(Math.max(0, t - (11 - i) * 4)));

const spendAt = (t: number): number => (t < T_TRIGGER ? 0 : 1.2 + clamp(t - T_TRIGGER, 0, T_EXIT - T_TRIGGER) * 0.03)
  + clamp(Math.min(t, T_EXIT + 12) - T_STEP, 0, 999) * 0.15;

/** The snapshot the replay shows at tick `t` (0..119). */
export function burstDemoSnapshot(tick: number): BurstBoardSnapshot {
  const t = clamp(Math.floor(tick), 0, DEMO_TICKS - 1);
  const mode = t < T_TRIGGER ? 'calm' : t < T_EXIT ? 'burst' : t < T_DONE ? 'exiting' : 'done';
  const recovered = t >= T_STEP + 4;
  const pressure = mode === 'calm' || mode === 'done' ? 0.22 + (t % 3) * 0.01
    : t < T_JAM ? ramp(t, T_TRIGGER, T_JAM, 0.62, 0.78) : t < T_STEP + 4 ? ramp(t, T_JAM, T_STEP, 0.78, 0.91) : ramp(t, T_STEP + 4, T_EXIT, 0.85, 0.38);
  const forecastMin = mode === 'calm' ? 18 * 60 + 40 : recovered ? Math.round(ramp(t, T_STEP + 4, T_EXIT, 17 * 60 + 10, 15 * 60 + 40)) : 17 * 60 + 30;
  const past = EVENTS.filter(([at]) => at <= t).reverse();
  return {
    release: '0.3.37',
    mode,
    tick: t,
    rhythmMin: 60,
    preset: '4h',
    trigger: 'CEO «all resources»',
    elapsedSec: clamp(t - T_TRIGGER, 0, 999) * BURST_SEC_PER_TICK,
    totalSec: 4 * 3600,
    pressure,
    pressureAlarm: 0.75,
    deadline: '16:00 cut',
    forecast: clock(forecastMin),
    forecastOk: forecastMin <= 16 * 60,
    ...(mode !== 'calm' ? { forecastWas: '18:40' } : {}),
    spendUsd: spendAt(t),
    ceilingUsd: 30,
    lanes: lanesAt(t),
    hands: handsAt(t),
    hosts: hostsAt(t),
    landedPerHour: series(t, landedAt),
    greenPerHour: series(t, (x) => Math.max(5, landedAt(x) - 3)),
    landTarget: 20,
    events: past.slice(0, 4).map(([at, text]) => ({ at: stamp(at), text })),
    freshEvent: past[0]?.[0] === t,
    ...(mode === 'exiting' ? { exitStep: t < T_EXIT + 2 ? 1 : t < T_EXIT + 4 ? 2 : t < T_EXIT + 12 ? 3 : 4 } : {}),
    ...(mode === 'done' ? { receipt: { durationLabel: '2:34 of 4:00 (early exit)', landed: 41, spend: `$${spendAt(T_DONE).toFixed(2)} / $30`, handsClosed: 10, vmsOff: ['gcp3'], forecast: '15:40 ✓ (was 18:40 ✗)' } } : {}),
  };
}

/** Named fixtures for tests and captures — each one is a tick of the demo. */
export const BURST_FIXTURE_TICKS = {
  calm: 6,
  bursting: T_TRIGGER + 5,
  'review-bottleneck': T_JAM + 14,
  'cloud-card-pending': T_CARD + 2,
  'step-up': T_STEP,
  exit: T_EXIT + 5,
  receipt: T_DONE + 2,
} as const;
export type BurstFixtureName = keyof typeof BURST_FIXTURE_TICKS;
export const burstFixture = (name: BurstFixtureName): BurstBoardSnapshot => burstDemoSnapshot(BURST_FIXTURE_TICKS[name]);

export interface ReplayIo {
  readonly write: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly columns: () => number;
}

/** Play the scenario: each snapshot is shown for 2 s as 4 tweened frames (÷ speed). */
export async function playBurstReplay(io: ReplayIo, opts: { readonly speed?: number; readonly fromTick?: number } = {}): Promise<void> {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const frameMs = DEMO_TICK_MS / BURST_FRAMES / speed;
  io.write('\x1b[?25l');
  try {
    for (let t = opts.fromTick ?? 0; t < DEMO_TICKS; t++) {
      const snapshot = burstDemoSnapshot(t);
      for (let f = 0; f < BURST_FRAMES; f++) {
        const width = Math.max(40, Math.min(160, io.columns()));
        io.write(`\x1b[H\x1b[2J${renderBurstBoard(snapshot, width >= 100 ? Math.min(width, 120) : Math.min(width, 80), f).join('\n')}\n`);
        await io.sleep(frameMs);
      }
    }
  } finally {
    io.write('\x1b[?25h');
  }
}
