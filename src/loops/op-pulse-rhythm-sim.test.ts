/**
 * SIM device — op-pulse keeps its phase rhythm through retries (11-25 rail 47: a 30m cadence beat ~hourly and the
 * retry hit «run id already exists»). Virtual clock, one tick per minute, real runPulse + real pulse-due, fake measure
 * (gaps → a turn; the OP turn never writes the goal line, so every window goes deadline → retry). Seeds jitter the
 * tick second and the start minute. Expectations are literal minutes, independent of the rhythm code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PulseMeasure } from './op-pulse.js';
import { pulseDueNow, runPulse, writeBurst, type PulseExtra, type PulseProbes } from './op-pulse-run.js';
import { startBurst } from './op-pulse-burst.js';
import { listFires, openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from './trigger-registry.js';
import { registerGraphTriggerDispatchBinding } from './graph-trigger-dispatch-lease.js';
import type { ConditionProbes } from './trigger-conditions.js';

const ROOT = join(import.meta.dir, '../..');
const RHYTHM = join(ROOT, 'graphs/triggers/op-pulse.rhythm.yaml');
let dir: string; let clock: Date;
const gapMeasure = (): PulseMeasure => ({ at: clock.toISOString(), version: '0.3.37', landedPerH: 6, greenPerH: 12, judgeQueue: 2, judgeWaitMedianMin: 10, budget: [], unmeasured: [],
  spaces: [{ space: 'TC', landedPerH: 6, greenPerH: 7, hands: 3, idleWithWork: 0, readyCells: 9, blockedCells: 0 }] });
const extra: PulseExtra = { landed3hPerH: 20, green3hPerH: null, readyBacklog: 9, openInScope: 10, demand: { newP0PerH: 0, baselineP0PerH: 1, activeRequirements: 1, readyBacklogGrowthPerH: 0 }, gateWaitMin: null, reviewWaitMin: null, landQueue: null };
const probes = (): PulseProbes => ({ now: () => clock, localHour: () => 14, schedules: () => [], measure: async () => ({ measure: gapMeasure(), extra }), crownMails: () => [] });
const io = () => ({ rhythmPath: RHYTHM, seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-pulse-rhythm-')); mkdirSync(join(dir, 'seat'), { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Sim { runIds: string[]; windows: () => string[]; tick: () => Promise<void>; reopen: () => void; close: () => void; started: Set<string> }
function sim(start: string, opts: { failFirstRun?: boolean } = {}): Sim {
  const stateRoot = join(dir, 'state');
  let db = openTriggerRegistry(stateRoot);
  const started = new Set<string>(); const runIds: string[] = []; let calls = 0;
  const cp = { now: () => clock, pulseDue: async () => pulseDueNow(probes(), io()) } as unknown as ConditionProbes;
  const deps: TriggerTickDeps = { now: () => clock, probes: cp, vars: { seatState: join(dir, 'seat'), stateRoot },
    runGraph: async (_d, input, runId) => {
      if (started.has(runId)) throw new Error(`run id already exists: op-pulse/${runId}`); // the graph runner's refusal
      started.add(runId); runIds.push(runId); calls++;
      if (opts.failFirstRun && calls === 1) throw new Error('measure probe exploded');
      await runPulse(probes(), { ...io(), window: input.window, stage: input.stage });
      return { status: 'done', runId };
    }, postCard: async () => 'card', scheduleAction: async () => {} };
  registerTrigger(db, readTriggerDecl('graphs/triggers/op-pulse.yaml', ROOT), { now: new Date(start) });
  return { runIds, started,
    windows: () => listFires(db, 'op-pulse', 100).map(f => f.window).sort(),
    tick: async () => { await tickTriggers(db, deps); },
    reopen: () => { db.close(); db = openTriggerRegistry(stateRoot); },
    close: () => db.close() };
}
const at = (base: string, min: number, sec: number) => new Date(Date.parse(base) + min * 60_000 + sec * 1000);

for (const seed of [1, 2, 3]) {
  const jitter = (seed * 17) % 50; // tick second inside each minute
  const base = `2026-11-25T03:0${seed}:00.000Z`;
  const w = (min: number) => new Date(Date.parse(base) + min * 60_000).toISOString();

  describe(`SIM op-pulse rhythm · seed ${seed}`, () => {
    test('normal cadence (build 60m) holds through deadline → retry on every window', async () => {
      const s = sim(base);
      for (let i = 0; i <= 150; i++) { clock = at(base, i, jitter); await s.tick(); }
      expect(s.windows()).toEqual([w(0), w(60), w(120)]);
      expect(new Set(s.runIds).size).toBe(s.runIds.length);
      s.close();
    });
    test('burst cadence (15m) holds through retries', async () => {
      clock = at(base, 0, 0);
      writeBurst(join(dir, 'seat', 'OP', 'pulse', 'burst.json'), startBurst({ goal: 'land', until: at(base, 600, 0).toISOString(), scope: ['ALL'], by: 'sim', now: clock, budgetUsd: 0 }, null));
      const s = sim(base);
      for (let i = 0; i <= 50; i++) { clock = at(base, i, jitter); await s.tick(); }
      expect(s.windows()).toEqual([w(0), w(15), w(30), w(45)]);
      expect(new Set(s.runIds).size).toBe(s.runIds.length);
      s.close();
    });
    test('retry after an exception gets a fresh run id, even when its key was already used', async () => {
      const s = sim(base, { failFirstRun: true });
      clock = at(base, 0, jitter); await s.tick();
      // A crashed earlier dispatch already bound and started window#2 (the 11-25 collision).
      const stale = registerGraphTriggerDispatchBinding({ triggerId: 'condition:op-pulse', dedupeKey: `${w(0)}#2`, graphId: 'op-pulse' }, { registryRoot: join(dir, 'state'), stateRoot: join(dir, 'state') });
      s.started.add(stale.runId);
      for (let i = 1; i <= 8; i++) { clock = at(base, i, jitter); await s.tick(); }
      const fire = s.windows().length;
      expect(fire).toBe(1);
      expect(s.runIds.length).toBe(2);
      expect(s.runIds[1]).not.toBe(stale.runId);
      expect(s.runIds[1]).not.toBe(s.runIds[0]);
      s.close();
    });
    test('restart mid-cooldown keeps the rhythm (no double fire, no lost beat)', async () => {
      const s = sim(base);
      for (let i = 0; i <= 70; i++) { clock = at(base, i, jitter); await s.tick(); if (i === 3 || i === 62) s.reopen(); }
      expect(s.windows()).toEqual([w(0), w(60)]);
      s.close();
    });
    test('condition true at the same minute twice → one fire', async () => {
      const s = sim(base);
      clock = at(base, 0, jitter); await s.tick(); await s.tick();
      clock = at(base, 0, 55); await s.tick();
      expect(s.windows()).toEqual([w(0)]);
      expect(s.runIds.length).toBe(1);
      s.close();
    });
  });
}
