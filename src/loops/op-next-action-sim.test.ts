/**
 * SIM world — OP next-best-action planner (OP-NEXT-BEST-ACTION · CEO 11-26). Seeds 1–5 vary the world (hand count,
 * cell ids, mail ids, ages); each scenario is one shape observed live on 11-26:
 *   idle hands + no ready cells · directive mail unconverted · land stalled · release run missing · bulletin stale
 * plus idle hands × ready cells (direct assign) and the quiet world (next 3 goals). For each: the planner's top
 * action (rule · actor) and the state change after the planner's actuators — or a fake OP doing the NEXT ACTION — ran.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNextActions, planNextActions, renderNextActionBlock, type NaCell, type NaHand, type NextAction, type NextActionState, type NextActuators } from './op-next-action.js';
import { runPulse, type PulseExtra, type PulseProbes } from './op-pulse-run.js';
import type { PulseMeasure } from './op-pulse.js';

const SEEDS = [1, 2, 3, 4, 5];
const NOW = '2026-11-26T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const ago = (min: number) => new Date(nowMs - min * 60_000).toISOString();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A mutable federation: the actuators and the fake OP change it; the planner reads a snapshot of it. */
class World {
  cells: NaCell[] = []; hands: NaHand[] = [];
  directives: NextActionState['directives'] = [];
  dismissed: number[] = [];
  handRaises: NextActionState['handRaises'] = [];
  land = { readyToLand: 0, landedLastHour: 3, mode: 'live' as string };
  releases: Array<{ version: string; cutAt: string | null; publishAt: string | null; hasRun: boolean }> = [];
  bulletinAgeMin: number | null = 10;
  alarms: string[] = []; goalsWritten: string[] = []; mails: string[] = []; hints = new Map<string, string>();
  constructor(readonly r: () => number) {}
  int(lo: number, hi: number) { return lo + Math.floor(this.r() * (hi - lo + 1)); }
  snapshot(): NextActionState {
    return { now: NOW, version: '0.3.38', released: '0.3.37', cells: this.cells.map(c => ({ ...c })), hands: this.hands.map(h => ({ ...h })),
      directives: this.directives, dismissed: this.dismissed, handRaises: this.handRaises, land: { ...this.land }, releases: this.releases.map(x => ({ ...x })),
      bulletin: { ageMin: this.bulletinAgeMin } };
  }
  actuators(): NextActuators {
    return {
      // OP-PUSH-BUDGET: the planner hints; the woken hand claims its hinted cell on `eln work next`.
      hint: (entries) => { for (const e of entries) { if (!this.cells.some(x => x.id === e.cell)) throw new Error(`no cell ${e.cell}`); this.hints.set(e.cell, e.seat); } return `hints ${entries.length}`; },
      wake: (seat) => {
        const cell = [...this.hints].find(([c, s]) => s === seat && !this.cells.find(x => x.id === c)?.owner)?.[0];
        if (cell) { this.cells = this.cells.map(x => x.id === cell ? { ...x, owner: seat } : x); this.hands = this.hands.map(h => h.seat === seat ? { ...h, state: 'working' } : h); }
        this.mails.push(`wake ${seat}`); return `mail #${9000 + this.mails.length}`;
      },
      landTick: () => { const n = this.land.readyToLand; this.land = { ...this.land, readyToLand: 0, landedLastHour: n }; return `landed ${n}`; },
      releaseRun: (v) => { this.releases = this.releases.map(x => x.version === v ? { ...x, hasRun: true } : x); return `run ${v} created`; },
      alarm: (key) => { this.alarms.push(key); return `card ${key}`; },
      writeGoals: (lines) => { this.goalsWritten.push(...lines); return `${lines.length} goals`; },
    };
  }
  /** The fake OP turn: does exactly the NEXT ACTION (register · split+assign · bulletin · close hand). */
  opDoes(a: NextAction): void {
    if (a.rule === 'a') this.cells.push({ id: `DIR-${a.target!.msgId}`, title: 'from directive', status: 'yellow', priority: 'P0', source: `#${a.target!.msgId}`, doneCriterion: 'x', updatedAt: NOW });
    if (a.rule === 'c') {
      // the pieces OP writes; free hands pull them on `eln work next`
      const pieces = a.commands.filter(c => c.startsWith('eln release checklist add')).length;
      const seats = this.hands.filter(h => h.state === 'idle' && !h.judge).map(h => h.seat).slice(0, pieces);
      seats.forEach((s, i) => { this.cells.push({ id: `${a.target!.cell}-S${i + 1}`, title: 'piece', status: 'yellow', priority: 'P0', owner: s, doneCriterion: 'piece done', updatedAt: NOW });
        this.hands = this.hands.map(h => h.seat === s ? { ...h, state: 'working' } : h); });
    }
    if (a.rule === 'f') this.bulletinAgeMin = 0;
    if (a.rule === 'h') this.handRaises = (this.handRaises ?? []).filter(h => h.msgId !== a.target!.msgId);
  }
}

function busyWorld(seed: number): World {
  const w = new World(rng(seed));
  const n = w.int(3, 6);
  for (let i = 0; i < n; i++) w.hands.push({ seat: `TC-H${seed}${i}`, home: 'TC', state: 'working', since: nowMs - w.int(5, 90) * 60_000 });
  for (let i = 0; i < n; i++) w.cells.push({ id: `C${seed}-${i}`, title: `cell ${i}`, status: 'yellow', priority: i === 0 ? 'P0' : 'P1', owner: `TC-H${seed}${i}`, doneCriterion: `test ${i} passes`, updatedAt: ago(w.int(10, 300)) });
  w.cells.push({ id: `G${seed}`, title: 'done one', status: 'green', updatedAt: ago(30) });
  return w;
}

const run = async (w: World, stage = 'live') => {
  const plan = planNextActions(w.snapshot());
  const results = await executeNextActions(plan, w.actuators(), stage);
  return { plan, results, top: plan.actions[0] };
};

describe('SIM next-action — 11-26 shapes × seeds 1–5', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: idle hands + no ready cells → (c) split the top P0 cell, then the pieces are owned`, async () => {
      const w = busyWorld(seed);
      const idle = w.int(2, 5);
      for (let i = 0; i < idle; i++) w.hands.push({ seat: `UX-H${seed}${i}`, home: 'UX', state: 'idle', since: nowMs - (60 + i) * 60_000 });
      const { top, results } = await run(w);
      expect(top?.rule).toBe('c');
      expect(top?.actor).toBe('op');
      expect(top?.target?.cell).toBe(`C${seed}-0`);
      expect(results.every(r => r.status === 'todo')).toBe(true);
      expect(renderNextActionBlock(results, [])).toContain(`NEXT ACTION (do it) — (c) split C${seed}-0`);
      w.opDoes(top!);
      const pieces = w.cells.filter(c => c.id.startsWith(`C${seed}-0-S`));
      expect(pieces.length).toBe(Math.min(idle, 4));
      expect(pieces.every(c => !!c.owner && !!c.doneCriterion)).toBe(true);
      expect(planNextActions(w.snapshot()).actions.some(a => a.rule === 'c' && a.target?.cell === `C${seed}-0`)).toBe(false);
    });

    test(`seed ${seed}: idle hands + ready cells → (b) hinted ⊕ woken, hands claim via work next`, async () => {
      const w = busyWorld(seed);
      const idle = w.int(1, 4);
      for (let i = 0; i < idle; i++) w.hands.push({ seat: `MK-H${seed}${i}`, home: 'MK', state: 'idle', since: nowMs - (30 + i) * 60_000 });
      w.hands.push({ seat: `JUD-H${seed}`, home: 'JUD', state: 'idle', judge: true });
      const ready = w.int(1, 4);
      for (let i = 0; i < ready; i++) w.cells.push({ id: `R${seed}-${i}`, title: `ready ${i}`, status: 'yellow', priority: 'P0', doneCriterion: 'd', updatedAt: ago(100 - i) });
      const { top, results } = await run(w);
      expect(top?.rule).toBe('b');
      expect(top?.actor).toBe('planner');
      const pairs = Math.min(idle, ready);
      expect(results.filter(r => r.status === 'did').length).toBe(pairs);
      expect(w.cells.filter(c => c.id.startsWith(`R${seed}-`) && c.owner?.startsWith('MK-H')).length).toBe(pairs);
      expect(w.cells.some(c => c.owner === `JUD-H${seed}`)).toBe(false);
      // Longest idle first: MK-H<seed><idle-1> has been idle the longest (30 + i min).
      expect(renderNextActionBlock(results, [])).toContain(`did (b) prioritize R${seed}-0 for MK-H${seed}${idle - 1} (pull)`);
      expect(w.mails.filter(m => m.startsWith('wake ')).length).toBe(pairs); // one wake per hand, no assign mail
    });

    test(`seed ${seed}: directive mail unconverted → (a) register cells; after the cell cites it, no action`, async () => {
      const w = busyWorld(seed);
      const id = 40000 + w.int(1, 999);
      w.directives = [{ msgId: id, crownDirective: `crown-${seed}`, kind: 'request', from: 'OP', body: 'TG-OP CEO: build the next-action planner', createdAt: ago(w.int(5, 120)) }];
      const { top } = await run(w);
      expect(top?.rule).toBe('a');
      expect(top?.target?.msgId).toBe(id);
      expect(top?.commands[0]).toContain(`--source '#${id}'`);
      w.opDoes(top!);
      expect(w.cells.some(c => c.source === `#${id}`)).toBe(true);
      expect(planNextActions(w.snapshot()).actions.some(a => a.rule === 'a')).toBe(false);
      w.cells = w.cells.filter(c => c.source !== `#${id}`); w.dismissed = [id];
      expect(planNextActions(w.snapshot()).actions.some(a => a.rule === 'a')).toBe(false);
    });

    test(`seed ${seed}: land stalled → (d) alarm + one land-graph tick; shadow mode → one CEO question`, async () => {
      const w = busyWorld(seed);
      const ready = w.int(1, 7);
      w.land = { readyToLand: ready, landedLastHour: 0, mode: 'live' };
      const { top, results } = await run(w);
      expect(top?.rule).toBe('d');
      expect(results[0]?.status).toBe('did');
      expect(w.alarms).toEqual([`d:land`]);
      expect(w.land).toEqual({ readyToLand: 0, landedLastHour: ready, mode: 'live' });
      const s = busyWorld(seed); s.land = { readyToLand: ready, landedLastHour: 0, mode: 'shadow' };
      const shadow = await run(s);
      expect(shadow.top?.actor).toBe('ceo');
      expect(shadow.results[0]?.status).toBe('todo');
      expect(s.land.readyToLand).toBe(ready);
    });

    test(`seed ${seed}: release cut passed with no run → (e) run created; unknown publish time → CEO question`, async () => {
      const w = busyWorld(seed);
      const late = w.int(6, 600);
      w.releases = [{ version: '0.3.38', cutAt: ago(late), publishAt: new Date(nowMs + 60 * 60_000).toISOString(), hasRun: false },
        { version: '0.3.37', cutAt: ago(late + 60), publishAt: ago(late), hasRun: false }];
      const { top, results } = await run(w);
      expect(top?.rule).toBe('e');
      expect(top?.target?.version).toBe('0.3.38');
      expect(results.filter(r => r.action.rule === 'e').length).toBe(1);
      expect(w.releases.find(r => r.version === '0.3.38')?.hasRun).toBe(true);
      expect(planNextActions(w.snapshot()).actions.some(a => a.rule === 'e')).toBe(false);
      const u = busyWorld(seed); u.releases = [{ version: '0.3.38', cutAt: ago(late), publishAt: null, hasRun: false }];
      expect((await run(u)).top?.actor).toBe('ceo');
      const early = busyWorld(seed); early.releases = [{ version: '0.3.38', cutAt: ago(2), publishAt: NOW, hasRun: false }];
      expect(planNextActions(early.snapshot()).actions.some(a => a.rule === 'e')).toBe(false);
    });

    test(`seed ${seed}: bulletin stale → (f) the OP turn rewrites it`, async () => {
      const w = busyWorld(seed);
      w.bulletinAgeMin = w.int(46, 700);
      const { top, results } = await run(w);
      expect(top?.rule).toBe('f');
      expect(results[0]?.status).toBe('todo');
      w.opDoes(top!);
      expect(planNextActions(w.snapshot()).actions.some(a => a.rule === 'f')).toBe(false);
      w.bulletinAgeMin = null;
      expect(planNextActions(w.snapshot()).actions[0]?.evidence).toBe('BULLETIN-NOW.md missing');
    });

    test(`seed ${seed}: nothing to do → (g) the next 3 goals are written from the top open cells`, async () => {
      const w = busyWorld(seed);
      const { top, plan } = await run(w);
      expect(top?.rule).toBe('g');
      expect(plan.goals.length).toBe(3);
      expect(plan.goals[0]).toStartWith(`C${seed}-0 (P0)`);
      expect(w.goalsWritten.length).toBe(3);
    });
  }
});

describe('SIM next-action — ladder, stage and failure paths', () => {
  test('ladder order: directive before hand-raise before assign before land before release before bulletin', () => {
    const w = busyWorld(7);
    w.hands.push({ seat: 'X-H', home: 'X', state: 'idle' });
    w.cells.push({ id: 'R', title: 'r', status: 'yellow', priority: 'P1', updatedAt: NOW });
    w.directives = [{ msgId: 1, from: 'OP', kind: 'mission', body: 'm', createdAt: ago(5) }];
    w.handRaises = [{ msgId: 2, seat: 'TC', line: 'blocked', ageMin: 20, ceoOnly: false }];
    w.land = { readyToLand: 2, landedLastHour: 0, mode: 'live' };
    w.releases = [{ version: '0.3.38', cutAt: ago(30), publishAt: NOW, hasRun: false }];
    w.bulletinAgeMin = 100;
    expect(planNextActions(w.snapshot()).actions.map(a => a.rule)).toEqual(['a', 'h', 'b', 'd', 'e', 'f']);
  });
  test('shadow stage changes nothing (would-lines only); a throwing actuator is kept as failed for the OP turn', async () => {
    const w = busyWorld(8); w.land = { readyToLand: 3, landedLastHour: 0, mode: 'live' };
    const shadow = await run(w, 'shadow');
    expect(shadow.results[0]?.status).toBe('would');
    expect(w.land.readyToLand).toBe(3);
    const results = await executeNextActions(planNextActions(w.snapshot()), { landTick: () => { throw new Error('tick lock held'); } }, 'live');
    expect(results[0]).toMatchObject({ status: 'failed', evidence: 'tick lock held' });
    expect(renderNextActionBlock(results, [])).toContain('failed (d)');
  });
  test('unmeasured inputs never produce actions', () => {
    const plan = planNextActions({ now: NOW, version: null, cells: null, hands: null, directives: null, handRaises: null, land: null, releases: null, bulletin: null });
    expect(plan.actions).toEqual([]);
    expect(plan.unmeasured).toEqual(['cells', 'directives', 'hand-raises', 'hands', 'land', 'releases', 'bulletin']);
  });
});

describe('SIM next-action inside the OP pulse', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-next-action-sim-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const green = (): PulseMeasure => ({ at: NOW, version: '0.3.38', landedPerH: 24, greenPerH: 12, judgeQueue: 1, judgeWaitMedianMin: 5, budget: [], unmeasured: [],
    spaces: [{ space: 'TC', landedPerH: 14, greenPerH: 7, hands: 3, idleWithWork: 0, readyCells: 9, blockedCells: 0 }] });
  const extra: PulseExtra = { landed3hPerH: 20, green3hPerH: null, readyBacklog: 9, openInScope: 10, demand: { newP0PerH: 0, baselineP0PerH: 1, activeRequirements: 1, readyBacklogGrowthPerH: 0 }, gateWaitMin: null, reviewWaitMin: null, landQueue: null };
  const probes = (w: World): PulseProbes => ({ now: () => new Date(NOW), localHour: () => 14, schedules: () => [], measure: async () => ({ measure: green(), extra }), crownMails: () => [],
    nextActionState: async () => w.snapshot(), nextActuators: () => w.actuators() });
  const io = () => ({ rhythmPath: join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml'), seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') });

  test('all-green pulse with an unconverted directive → a turn whose brief opens with NEXT ACTION; goal met by next-action', async () => {
    const w = busyWorld(3);
    w.directives = [{ msgId: 41234, crownDirective: 'crown-9', from: 'OP', body: 'do it', createdAt: ago(10) }];
    const r = await runPulse(probes(w), { ...io(), window: 'w1', stage: 'live' });
    expect(r.outcome).toBe('turn');
    expect(r.brief).toContain('NEXT ACTION (do it) — (a) register cells for CEO directive #41234');
    const ledger = readFileSync(join(dir, 'state', 'loops', 'op-pulse.jsonl'), 'utf8');
    expect(ledger).toContain('"goal":"met","window":"w1","by":"next-action"');
    expect(readFileSync(join(dir, 'state', 'loops', 'op-next-action.jsonl'), 'utf8')).toContain('"rule":"a"');
  });
  test('all-green pulse where the planner did everything (land tick) → no turn; did-line in the pulse note', async () => {
    const w = busyWorld(4); w.land = { readyToLand: 2, landedLastHour: 0, mode: 'live' };
    const r = await runPulse(probes(w), { ...io(), window: 'w2', stage: 'live' });
    expect(r.outcome).toBe('green');
    expect(w.land.landedLastHour).toBe(2);
    expect(readFileSync(r.tablePath, 'utf8')).toContain('did (d) outcome alarm + one land-graph tick (2 ready, 0 landed) (alarm card d:land · landed 2)');
  });
});
