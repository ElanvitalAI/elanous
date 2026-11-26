/**
 * Burst Board sim world — seeded event streams drive a small burst planner seam (pressure with hysteresis, lane
 * step-ups, host caps, cloud card, budget ceiling, exit) and turn every tick into a BurstBoardSnapshot. The live
 * planner (`pulse burst plan`) is not on main yet; `planBurstTick` is the seam B2 replaces with it, so the screen
 * is checked against whatever numbers the planner produced (`plan` per tick), never against hand-made values.
 */
import type { Hand } from '../tui/widgets/hand-grid.js';
import type { HostTileProps } from '../tui/widgets/host-tile.js';
import type { TickerEvent } from '../tui/widgets/ticker.js';
import type { BurstBoardSnapshot, BurstLane, BurstMode } from '../tui/widgets/scenes/burst-board.js';
import { simRandom } from './widget-sim.js';

export type BurstWorldEdge =
  | 'oscillation' | 'card-withdrawn' | 'host-down' | 'budget-ceiling' | 'zero-hands' | 'hands-60' | 'long-ids' | 'clock-skew';

export interface BurstWorldOptions {
  readonly seed: number;
  readonly ticks?: number;
  readonly edges?: readonly BurstWorldEdge[];
}

export interface BurstPlanTick {
  readonly tick: number;
  readonly mode: BurstMode;
  readonly pressure: number;
  readonly lanes: readonly { readonly label: string; readonly now: number; readonly plan: number; readonly queue: number }[];
  readonly hands: number;
  readonly spendUsd: number;
  readonly openBurstHands: number;
}

export interface BurstWorldFrame {
  readonly snapshot: BurstBoardSnapshot;
  readonly plan: BurstPlanTick;
  /** Same state as the previous tick (nothing arrived, nothing moved). */
  readonly still: boolean;
}

interface Host { name: string; kind: HostTileProps['kind']; cap: number; down: boolean; on: boolean }

const ALARM_ON = 0.75;
const ALARM_OFF = 0.55;
const CEILING = 30;

/** Run one seeded world; returns one frame per tick. */
export function runBurstWorld(opts: BurstWorldOptions): BurstWorldFrame[] {
  const rnd = simRandom(opts.seed);
  const edges = new Set(opts.edges ?? []);
  const ticks = opts.ticks ?? 120;
  const tAllIn = 10 + Math.floor(rnd() * 8);
  const hosts: Host[] = [
    { name: 'mshq', kind: 'local', cap: edges.has('hands-60') ? 40 : 8, down: false, on: true },
    { name: 'minim5', kind: 'lan', cap: 4, down: false, on: true },
    { name: 'node-b', kind: 'lan', cap: edges.has('hands-60') ? 20 : 5, down: false, on: true },
    { name: edges.has('long-ids') ? 'gcp3-very-long-cloud-host-name-東京' : 'gcp3', kind: 'cloud', cap: edges.has('hands-60') ? 8 : 2, down: false, on: false },
  ];
  const baseHands = edges.has('zero-hands') ? 0 : 3;
  let hands = baseHands;
  let review = 2;
  let backlog = 4;
  let reviewQ = 1;
  let landedPerHour = 8;
  let spend = 0;
  let alarm = false;
  let mode: BurstMode = 'calm';
  let exitStep = 0;
  let exitAt = -1;
  let card: 'none' | 'pending' | 'approved' | 'withdrawn' = 'none';
  const landed: number[] = [];
  const events: TickerEvent[] = [];
  const frames: BurstWorldFrame[] = [];
  let prevKey = '';
  const handHost: string[] = [];
  const stamp = (t: number) => {
    const skew = edges.has('clock-skew') && t % 7 === 3 ? -90 : 0; // clock skew: a sample arrives stamped in the past
    const s = Math.max(0, (t - tAllIn) * 120 + skew);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  };
  const push = (t: number, text: string) => { events.unshift({ at: stamp(t), text }); events.length = Math.min(events.length, 4); };

  for (let t = 0; t < ticks; t++) {
    let fresh = false;
    const say = (text: string) => { push(t, text); fresh = true; };
    const surge = t >= tAllIn - 4 && mode !== 'done' ? 2 + Math.floor(rnd() * 3) : rnd() < 0.2 ? 1 : 0;
    backlog += mode === 'exiting' || mode === 'done' ? 0 : surge;
    if (t === tAllIn) { mode = 'burst'; say('CEO «all resources» → burst 4h'); }
    const capTotal = hosts.filter((h) => !h.down && (h.kind !== 'cloud' || h.on)).reduce((a, h) => a + h.cap, 0);
    if (mode === 'burst') {
      // planner seam: step hands toward backlog/2 within live host capacity and budget
      const want = Math.min(capTotal, Math.ceil(backlog / 2), edges.has('hands-60') ? 64 : 16);
      if (spend >= CEILING) { if (!events[0]?.text.startsWith('budget')) say('budget ceiling hit → no new hands'); }
      else if (want > hands && !edges.has('zero-hands')) { const add = Math.min(4, want - hands); hands += add; say(`hands +${add}`); }
      if (reviewQ > 4 && card === 'none' && hands >= capTotal) { card = 'pending'; say('local+LAN at cap → cloud card'); }
      if (card === 'pending' && edges.has('card-withdrawn') && t > tAllIn + 20) { card = 'withdrawn'; say('cloud card withdrawn'); }
      else if (card === 'pending' && !edges.has('card-withdrawn') && t > tAllIn + 18) { card = 'approved'; hosts[3]!.on = true; say('cloud card approved'); }
      if (reviewQ > 6 && review < 4) { review += 2; say('review +2'); }
      if (edges.has('host-down') && t === tAllIn + 12) { hosts[2]!.down = true; hands = Math.min(hands, capTotal - hosts[2]!.cap); say('node-b down → hands rebalanced'); }
    }
    // flow: hands produce PRs into review, review drains at its capacity
    const produced = Math.min(backlog, Math.ceil(hands / 3));
    backlog -= produced;
    reviewQ += produced;
    const reviewed = Math.min(reviewQ, review);
    reviewQ -= reviewed;
    landedPerHour = Math.max(0, Math.round(landedPerHour * 0.7 + reviewed * 3 * 0.3));
    landed.push(landedPerHour);
    if (mode === 'burst' || mode === 'exiting') spend = Math.min(CEILING, spend + 0.05 * hands + (hosts[3]!.on ? 0.15 : 0));
    // pressure with hysteresis
    const raw = Math.min(1, (backlog + reviewQ * 2) / 40);
    const pressure = edges.has('oscillation') ? (t % 2 === 0 ? 0.74 : 0.56) : raw;
    if (!alarm && pressure >= ALARM_ON) alarm = true;
    else if (alarm && pressure <= ALARM_OFF) alarm = false;
    if (mode === 'burst' && t > tAllIn + 30 && landedPerHour >= 20 && exitAt < 0) { mode = 'exiting'; exitAt = t; exitStep = 1; say('target met → early exit'); }
    if (mode === 'burst' && t >= ticks - 24 && exitAt < 0) { mode = 'exiting'; exitAt = t; exitStep = 1; say('time box → exit'); }
    if (mode === 'exiting') {
      exitStep = Math.min(4, 1 + Math.floor((t - exitAt) / 3));
      if (exitStep >= 3) hands = Math.max(baseHands, hands - 3);
      if (exitStep >= 4) hosts[3]!.on = false;
      if (exitStep === 4 && hands === baseHands) { mode = 'done'; say('receipt filed'); }
    }
    while (handHost.length < hands) {
      const i = handHost.length;
      const used = (name: string) => handHost.filter((h) => h === name).length;
      const host = hosts.find((h) => !h.down && (h.kind !== 'cloud' || h.on) && used(h.name) < h.cap) ?? hosts[0]!;
      handHost.push(host.name);
      void i;
    }
    handHost.length = hands;
    const handList: Hand[] = handHost.map((host, i) => ({
      host,
      state: i >= (frames.at(-1)?.plan.hands ?? hands) ? 'new' : i < Math.ceil(hands * 0.8) || mode === 'burst' ? 'busy' : 'idle',
      ...(edges.has('long-ids') ? { task: `CARD-${'X'.repeat(40)}-${i}-한글` } : {}),
    }));
    const lanes: BurstLane[] = [
      { label: 'Hands', now: hands, plan: mode === 'burst' ? Math.min(capTotal, Math.ceil(backlog / 2) + hands) : hands, queue: backlog, speed: mode === 'calm' || mode === 'done' ? 1 : 3 },
      { label: 'Review', now: review, plan: reviewQ > 6 ? review + 2 : review, queue: reviewQ, speed: reviewQ > 4 ? 0 : 2, bottleneck: reviewQ > 4, widened: review > 2 },
      { label: 'Pregate', now: 6, plan: 6, queue: Math.min(3, reviewed), speed: 2 },
      { label: 'Land', now: 2, plan: 2, queue: reviewed, speed: reviewed ? 2 : 0 },
    ];
    const hostTiles: Omit<HostTileProps, 'frame'>[] = hosts.map((h) => {
      if (h.down) return { name: h.name, kind: h.kind, used: 0, cap: h.cap, state: 'off' };
      if (h.kind === 'cloud' && !h.on) return { name: h.name, kind: h.kind, used: 0, cap: h.cap, state: card === 'pending' ? 'card' : 'off' };
      const used = handHost.filter((x) => x === h.name).length;
      return { name: h.name, kind: h.kind, used, cap: h.cap, role: `hands ${used}`, state: used >= h.cap ? 'cap' : 'on' };
    });
    const openBurstHands = Math.max(0, hands - baseHands);
    const plan: BurstPlanTick = { tick: t, mode, pressure, lanes: lanes.map(({ label, now, plan: p, queue }) => ({ label, now: now ?? 0, plan: p ?? 0, queue: queue ?? 0 })), hands, spendUsd: spend, openBurstHands };
    const snapshot: BurstBoardSnapshot = {
      release: '0.3.37', mode, tick: t, rhythmMin: 60, preset: '4h', trigger: 'CEO «all resources»',
      elapsedSec: Math.max(0, t - tAllIn) * 120, totalSec: 4 * 3600, pressure, pressureAlarm: alarm ? 0 : 2,
      deadline: '16:00 cut', forecast: landedPerHour >= 20 ? '15:40' : '17:30', forecastOk: landedPerHour >= 20,
      spendUsd: spend, ceilingUsd: CEILING, lanes, hands: handList, hosts: hostTiles,
      landedPerHour: landed.slice(-12), greenPerHour: landed.slice(-12).map((x) => Math.max(0, x - 3)), landTarget: 20,
      events: [...events], freshEvent: fresh,
      ...(mode === 'exiting' ? { exitStep } : {}),
      ...(mode === 'done' ? { receipt: { durationLabel: `${Math.floor(((exitAt - tAllIn) * 120) / 3600)}h burst`, landed: landed.reduce((a, b) => a + b, 0), spend: `$${spend.toFixed(2)} / $${CEILING}`, handsClosed: Math.max(0, (frames.reduce((m, f) => Math.max(m, f.plan.hands), 0)) - hands), vmsOff: [hosts[3]!.name], forecast: '15:40 ✓' } } : {}),
    };
    // «still» = the planner state did not change (tick-driven breath and blink are allowed to differ between ticks, not frames)
    const key = JSON.stringify({ ...plan, tick: 0 }) + JSON.stringify(handList) + fresh;
    frames.push({ snapshot, plan, still: key === prevKey && !fresh && lanes.every((l) => (l.queue ?? 0) + (l.now ?? 0) === 0 || l.speed === 0) && handList.every((h) => h.state !== 'new') });
    prevKey = key;
  }
  return frames;
}
