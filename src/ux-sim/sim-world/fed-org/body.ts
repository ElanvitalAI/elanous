// FED-ORG-SIM body model (CEO 11-27 00:1x «루프 에이전트 몸 구조도 최적화안») — the L1 body of the loop agents.
// 14 bodies (today's trigger registry + #40309/#40310/#40318 steps) × 4 body variants, 24 simulated hours, LLM 0.
// Calibration: space-advisor-tc 613 ticks/day, 339 no-op (55 %) · board-steward 148 ticks, digest-only · op-pulse
// 72/101 heartbeat-only · op-turn-enforce 12/12 noop · NotIdle 2002 log rows/24 h (`eln logs --grep NotIdle`).
import { seededRandom } from './model.js';

export type BodyVariant = 'A-cron' | 'B-event' | 'C-reactive' | 'D-shared';
export const BODY_VARIANTS: readonly BodyVariant[] = ['A-cron', 'B-event', 'C-reactive', 'D-shared'];

export interface BodyDef {
  readonly id: string;
  /** today: cron period (min) or condition cooldown/max-wait. */
  readonly today: { readonly kind: 'cron'; readonly every: number } | { readonly kind: 'cond'; readonly cooldown: number; readonly maxWait: number };
  /** domain events per hour (mail · ✋ · PR · land · ledger) that this body should react to. */
  readonly eventsPerH: number;
  /** seconds per run. */
  readonly runSec: number;
  /** today the run asks for an OP turn (pulse · bulletin · enforce) — refused when OP is busy (NotIdle). */
  readonly needsOpTurn: boolean;
  /** today the body has a goal-not-met check (3 of 14). */
  readonly goalCheck: boolean;
  /** share of events that need judgment (voice) rather than a closed rule. */
  readonly judgment: number;
  /** priority under a shared scheduler (0 = highest). */
  readonly prio: number;
  /** reaction SLA (min) used for goal attainment. */
  readonly slaMin: number;
}

export const BODIES: readonly BodyDef[] = [
  { id: 'hand-escalation-step', today: { kind: 'cron', every: 5 }, eventsPerH: 74, runSec: 15, needsOpTurn: false, goalCheck: false, judgment: 0.15, prio: 0, slaMin: 10 },
  { id: 'space-advisor-tc', today: { kind: 'cron', every: 2 }, eventsPerH: 40, runSec: 15, needsOpTurn: false, goalCheck: true, judgment: 0.2, prio: 0, slaMin: 10 },
  { id: 'land-graph', today: { kind: 'cond', cooldown: 2, maxWait: 10 }, eventsPerH: 12, runSec: 90, needsOpTurn: false, goalCheck: true, judgment: 0.05, prio: 0, slaMin: 15 },
  { id: 'board-steward', today: { kind: 'cron', every: 10 }, eventsPerH: 8, runSec: 20, needsOpTurn: false, goalCheck: false, judgment: 0.1, prio: 1, slaMin: 20 },
  { id: 'op-pulse', today: { kind: 'cond', cooldown: 5, maxWait: 70 }, eventsPerH: 1.5, runSec: 60, needsOpTurn: true, goalCheck: true, judgment: 0.6, prio: 1, slaMin: 30 },
  { id: 'op-bulletin', today: { kind: 'cond', cooldown: 15, maxWait: 30 }, eventsPerH: 6, runSec: 60, needsOpTurn: true, goalCheck: false, judgment: 0.3, prio: 2, slaMin: 30 },
  { id: 'op-turn-enforce', today: { kind: 'cron', every: 1 }, eventsPerH: 12, runSec: 5, needsOpTurn: false, goalCheck: false, judgment: 0, prio: 1, slaMin: 5 },
  { id: 'op-next-action', today: { kind: 'cron', every: 5 }, eventsPerH: 4, runSec: 10, needsOpTurn: true, goalCheck: false, judgment: 0.5, prio: 1, slaMin: 15 },
  { id: 'scheduled-wake', today: { kind: 'cron', every: 1 }, eventsPerH: 10, runSec: 3, needsOpTurn: true, goalCheck: false, judgment: 0, prio: 0, slaMin: 5 },
  { id: 'mail-relay', today: { kind: 'cron', every: 1 }, eventsPerH: 120, runSec: 4, needsOpTurn: false, goalCheck: false, judgment: 0, prio: 0, slaMin: 3 },
  { id: 'watchers-check', today: { kind: 'cron', every: 5 }, eventsPerH: 1, runSec: 10, needsOpTurn: false, goalCheck: false, judgment: 0.2, prio: 2, slaMin: 15 },
  { id: 'release-rocket', today: { kind: 'cron', every: 2 }, eventsPerH: 1, runSec: 10, needsOpTurn: false, goalCheck: false, judgment: 0.1, prio: 1, slaMin: 10 },
  { id: 'release-traffic', today: { kind: 'cond', cooldown: 0, maxWait: 60 }, eventsPerH: 0.5, runSec: 30, needsOpTurn: false, goalCheck: false, judgment: 0.1, prio: 1, slaMin: 15 },
  { id: 'res-burst-lease', today: { kind: 'cond', cooldown: 0, maxWait: 60 }, eventsPerH: 0.5, runSec: 60, needsOpTurn: false, goalCheck: false, judgment: 0.1, prio: 1, slaMin: 15 },
];

export interface BodyResult {
  readonly variant: BodyVariant;
  readonly seed: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  /** p95 for the board/pulse/bulletin/release class (prio ≥ 1). */
  readonly latencyP95Slow: number;
  readonly runsPerH: number;
  readonly wastedPerH: number;
  readonly wastedShare: number;
  readonly missedPerDay: number;
  readonly missedCap: number;
  readonly missedNotIdle: number;
  readonly llmPerH: number;
  readonly spawnsPerH: number;
  readonly cpuSecPerH: number;
  readonly residentProcs: number;
  readonly recoverMin: number;
  readonly goalAttainment: number;
}

const DEBOUNCE = 0.5;
const MAX_COALESCE = 3;
const GLOBAL_CAP = 6;        // trigger tick: runs started per minute before «Cap» skips
const SHARED_WORKERS = 4;    // shared runtime in-process workers
const SPAWN_CPU = 1.4;       // bun process start (s)
const OP_BUSY = 0.55;        // share of minutes the OP turn is busy (S0/S1 calibration)
const SILENT_FAIL = 0.04;    // a run that ends «done» without the outcome
const CRASH_AT = 12 * 60;

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

/** One simulated day of all 14 bodies under one body variant. Pure. */
export function simulateBodies(variant: BodyVariant, seed: number, hours = 24): BodyResult {
  const r = seededRandom(seed * 4099 + BODY_VARIANTS.indexOf(variant) * 131);
  const T = hours * 60;
  const pending: number[][] = BODIES.map(() => []);
  const lastRun = BODIES.map(() => -1e9);
  const firstPending = BODIES.map(() => -1);
  const lat: number[] = []; const latSlow: number[] = [];
  let runs = 0, wasted = 0, missedCap = 0, missedNotIdle = 0, llm = 0, spawns = 0, cpu = 0, onTime = 0, total = 0, lost = 0;
  const crashDown = variant === 'B-event' ? 60 : variant === 'A-cron' ? 1 : 1;   // B: in-memory watch, no cursor → max-wait fallback
  let caughtUpAt = -1;
  const shared = variant === 'D-shared';
  const reactive = variant === 'C-reactive' || shared;
  const event = variant !== 'A-cron';
  const burst = Array.from({ length: hours }, () => (r() < 0.3 ? 2 : 0.6));
  for (let t = 0; t < T; t++) {
    const down = t >= CRASH_AT && t < CRASH_AT + crashDown;
    BODIES.forEach((b, i) => {
      const lam = (b.eventsPerH * burst[Math.floor(t / 60)]) / 60;
      let k = 0; let p = Math.exp(-lam); let u = r(); while (u > p && k < 50) { u -= p; k++; p *= lam / k; }
      for (let j = 0; j < k; j++) {
        total++;
        if (down && variant === 'B-event') { lost++; continue; } // watcher dead, no durable cursor
        pending[i].push(t - r()); // arrived during the minute just past
        if (firstPending[i] < 0) firstPending[i] = t;
      }
    });
    if (down) continue;
    // which bodies are due
    const due: number[] = [];
    BODIES.forEach((b, i) => {
      const has = pending[i].length > 0;
      if (!event) {
        if (b.today.kind === 'cron') { if (t % b.today.every === 0) due.push(i); }
        else if ((has && t - lastRun[i] >= b.today.cooldown) || t - lastRun[i] >= b.today.maxWait) due.push(i);
      } else if (has) {
        const newest = pending[i][pending[i].length - 1];
        if ((t - newest >= DEBOUNCE || t - firstPending[i] >= MAX_COALESCE) && t - lastRun[i] >= (b.prio === 0 ? 0 : 1)) due.push(i);
      } else if (!reactive && b.today.kind === 'cond' && t - lastRun[i] >= b.today.maxWait) due.push(i); // B keeps a max-wait safety tick
      else if (reactive && t - lastRun[i] >= 60) due.push(i); // C/D: hourly goal probe (observe → judge vs done-when)
    });
    due.sort((a, b) => BODIES[a].prio - BODIES[b].prio);
    const cap = shared ? SHARED_WORKERS : (event ? GLOBAL_CAP + 2 : GLOBAL_CAP);
    due.forEach((i, n) => {
      const b = BODIES[i];
      if (n >= cap) {
        if (shared) return;                // backpressure: stays due, runs next minute
        missedCap++; if (!event) lastRun[i] = t; return; // stale-skipped window
      }
      runs++; lastRun[i] = t;
      if (shared) cpu += b.runSec * 0.05 + 0.1; else { spawns++; cpu += SPAWN_CPU + b.runSec * 0.05; }
      const batch = pending[i].splice(0);
      firstPending[i] = -1;
      if (!batch.length) { wasted++; return; }
      // today: a run that needs an OP turn is refused when OP is busy (NotIdle) — the batch is lost until the next window
      if (b.needsOpTurn && !reactive && r() < OP_BUSY) {
        missedNotIdle++;
        if (event) { pending[i].unshift(...batch); firstPending[i] = t; } // B re-fires on the still-pending event
        return;
      }
      const judged = batch.filter(() => r() < b.judgment).length;
      if (reactive) llm += judged > 0 ? 1 : 0;      // voice wakes only on judgment/HITL, once per batch
      else llm += b.needsOpTurn ? 1 : judged > 0 ? 1 : 0; // today: every OP-turn run is an LLM turn · a judgment = a card → a seat turn
      const silentFail = r() < SILENT_FAIL;
      const detected = reactive || b.goalCheck;     // C/D verify node · today only 3 of 14 check goal-not-met
      if (silentFail && detected) { pending[i].unshift(...batch); firstPending[i] = t; return; } // retry next minute
      const wait = (b.runSec / 60) + (shared ? 0.05 : 0.02);
      for (const e of batch) {
        const l = t - e + wait;
        lat.push(l); if (b.prio >= 1) latSlow.push(l);
        if (!silentFail && l <= b.slaMin) onTime++;
      }
    });
    if (t > CRASH_AT + crashDown && caughtUpAt < 0 && pending.every((q) => q.every((e) => e >= CRASH_AT + crashDown))) caughtUpAt = t;
  }
  const H = hours;
  return {
    variant, seed, latencyP50: pct(lat, 0.5), latencyP95: pct(lat, 0.95), latencyP95Slow: pct(latSlow, 0.95), runsPerH: runs / H, wastedPerH: wasted / H,
    wastedShare: runs ? wasted / runs : 0, missedPerDay: (missedCap + missedNotIdle) * (24 / H), missedCap, missedNotIdle,
    llmPerH: llm / H, spawnsPerH: spawns / H, cpuSecPerH: cpu / H, residentProcs: shared ? 1 : 0,
    recoverMin: (caughtUpAt < 0 ? T - CRASH_AT : caughtUpAt - CRASH_AT) + (lost ? 0 : 0),
    goalAttainment: total ? onTime / total : 0,
  };
}
