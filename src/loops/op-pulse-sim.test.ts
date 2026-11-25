/**
 * SIM device — OP pulse on a virtual clock with fake measures (CEO 11-25 20:0x–20:2x).
 * Scenarios: gaps → one turn brief in the inbox (live) · all green → heartbeat line, no turn · phase change → turn even
 * when green · CEO all-in line → burst started at once (ceo line on state) · CEO urgent → 4h proposal OP starts · slow
 * rate near a cut → deadline proposal · registry: the op-pulse graph fires only when pulse-due holds · the OP TUI inbox
 * watcher opens exactly one origin-'pulse' turn per pulse.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PulseMeasure } from './op-pulse.js';
import { deliverPulseTurn, runPulse, type PulseExtra, type PulseProbes } from './op-pulse-run.js';
import { createPulseInboxWatcher } from '../seat/seat-pulse-inbox.js';
import { openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from './trigger-registry.js';
import type { ConditionProbes } from './trigger-conditions.js';

const RHYTHM = join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml');
const ROOT = join(import.meta.dir, '../..');
let dir: string; let clock: Date; let m: PulseMeasure; let extra: PulseExtra;
let schedules: Array<{ version: string; cutAt?: string | null; publishAt?: string | null }>;
let mails: Array<{ id: number; crownDirective?: string | null; refs?: readonly string[] | null; createdAt: string }>;

const green = (): PulseMeasure => ({ at: clock.toISOString(), version: '0.3.37', landedPerH: 24, greenPerH: 12, judgeQueue: 2, judgeWaitMedianMin: 10, budget: ['codex ok'], unmeasured: [],
  spaces: [{ space: 'TC', landedPerH: 14, greenPerH: 7, hands: 3, idleWithWork: 0, readyCells: 9, blockedCells: 0 }] });
const probes = (): PulseProbes => ({ now: () => clock, localHour: () => 14, schedules: () => schedules, measure: async () => ({ measure: m, extra }), crownMails: () => mails });
const io = () => ({ rhythmPath: RHYTHM, seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') });
const run = (window: string, stage = 'live') => runPulse(probes(), { ...io(), window, stage });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'op-pulse-sim-'));
  clock = new Date('2026-11-25T03:00:00Z'); // 12:00 KST, no window (local hour faked to 14)
  m = green(); schedules = []; mails = [];
  extra = { landed3hPerH: 20, green3hPerH: null, readyBacklog: 9, openInScope: 10, demand: { newP0PerH: 0, baselineP0PerH: 1, activeRequirements: 1, readyBacklogGrowthPerH: 0 }, gateWaitMin: null, reviewWaitMin: null, landQueue: null };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SIM pulse runner', () => {
  test('all green → heartbeat line, no turn, goal line written', async () => {
    const r = await run('w1');
    expect(r.outcome).toBe('green');
    expect(r.brief).toBe(null);
    const ledger = readFileSync(join(dir, 'state', 'loops', 'op-pulse.jsonl'), 'utf8');
    expect(ledger).toContain('"goal":"met","window":"w1"');
    expect(readFileSync(r.tablePath, 'utf8')).toContain('전부 초록');
  });
  test('gaps → turn with the phase/rhythm head line and the gap rows', async () => {
    m = { ...green(), landedPerH: 6, spaces: [{ space: 'UX', landedPerH: 1, greenPerH: 0, hands: 3, idleWithWork: 5, readyCells: 1, blockedCells: 2 }] };
    const r = await run('w2');
    expect(r.outcome).toBe('turn');
    expect(r.brief!.split('\n')[0]).toBe('[pulse w2] 국면: build · 리듬: 60분 · 착지 20/h · 초록 10/h · 판정 대기 ≤30m · 손잡이 reprioritize, lend-hands, judge-relief, vm-ask, burst-propose');
    expect(r.brief).toContain('- FED · landed/h = 6 (목표 ≥ 20)');
    expect(r.brief).toContain('- UX · idle-with-work = 5 (목표 ≤ 3)');
    const out = deliverPulseTurn({ ...io(), window: 'w2', stage: 'live', brief: r.brief!, runId: 'run-1', now: clock, shadowDir: join(dir, 'shadow') });
    expect(out.delivered).toBe('inbox');
    const shadow = deliverPulseTurn({ ...io(), window: 'w2', stage: 'shadow', brief: r.brief!, runId: 'run-1', now: clock, shadowDir: join(dir, 'shadow') });
    expect(shadow.delivered).toBe('shadow');
  });
  test('phase change → a turn even when all green (leaders get the new beat)', async () => {
    await run('w1');
    schedules = [{ version: '0.3.37', cutAt: '2026-11-25T03:30:00Z', publishAt: '2026-11-25T05:00:00Z' }];
    clock = new Date('2026-11-25T03:10:00Z');
    const r = await run('w2');
    expect(r.phase.phase).toBe('pre-cut');
    expect(r.phaseChanged).toBe('build → pre-cut');
    expect(r.outcome).toBe('turn');
  });
  test('CEO all-in line → max burst started at once, CEO line on the state; local first, no VM step', async () => {
    mails = [{ id: 777, crownDirective: 'crown-42', refs: ['urgency:all-in'], createdAt: '2026-11-25T02:59:00Z' }];
    const r = await run('w3');
    expect(r.entry?.trigger).toBe('ceo-all-in');
    expect(r.burstStarted).toMatchObject({ preset: '8h', allIn: true, trigger: 'ceo-all-in', ceoLine: { msgId: 777, crownDirective: 'crown-42' }, until: '2026-11-25T11:00:00.000Z' });
    expect(r.phase.phase).toBe('burst');
    const burst = JSON.parse(readFileSync(join(dir, 'seat', 'OP', 'pulse', 'burst.json'), 'utf8'));
    expect(burst.status).toBe('active');
    expect(r.brief).not.toContain('vm:');
  });
  test('shadow stage never writes burst state', async () => {
    mails = [{ id: 778, crownDirective: 'crown-43', refs: ['urgency:all-in'], createdAt: '2026-11-25T02:59:00Z' }];
    await run('w3', 'shadow');
    expect(existsSync(join(dir, 'seat', 'OP', 'pulse', 'burst.json'))).toBe(false);
  });
  test('CEO urgent → 4h proposal that OP starts now', async () => {
    mails = [{ id: 779, crownDirective: 'crown-44', refs: ['urgency:urgent'], createdAt: '2026-11-25T02:59:00Z' }];
    const r = await run('w4');
    expect(r.entry?.trigger).toBe('ceo-urgent');
    expect(r.brief).toContain('버스트 진입(ceo-urgent · OP 가 지금 시작)');
    expect(r.brief).toContain('eln pulse burst start --preset 4h');
  });
  test('slow rate near a cut → deadline proposal with the right preset; fast rate → none', async () => {
    schedules = [{ version: '0.3.37', cutAt: '2026-11-25T09:00:00Z', publishAt: '2026-11-25T11:00:00Z' }];
    m = { ...green(), landedPerH: 5 }; extra = { ...extra, openInScope: 40 };
    const slow = await run('w5');
    expect(slow.forecast[0]).toMatchObject({ shortfall: 10, preset: '4h' });
    expect(slow.entry?.trigger).toBe('deadline');
    m = { ...green(), landedPerH: 24 }; extra = { ...extra, openInScope: 40 };
    clock = new Date('2026-11-25T04:10:00Z');
    const fast = await run('w6');
    expect(fast.entry).toBe(null);
  });
  test('demand surge that capacity cannot absorb → demand proposal', async () => {
    schedules = [{ version: '0.3.37', cutAt: '2026-11-25T09:00:00Z', publishAt: '2026-11-25T11:00:00Z' }];
    m = { ...green(), landedPerH: 5 }; extra = { ...extra, openInScope: 40, demand: { newP0PerH: 9, baselineP0PerH: 2, activeRequirements: 2, readyBacklogGrowthPerH: 0 } };
    const r = await run('w7');
    expect(r.entry?.trigger).toBe('demand-surge');
  });
});

describe('SIM registry + inbox', () => {
  test('op-pulse graph fires only when pulse-due holds (fake measure)', async () => {
    const stateRoot = join(dir, 'state'); mkdirSync(join(dir, 'seat'), { recursive: true });
    const db = openTriggerRegistry(stateRoot);
    const runs: string[] = [];
    let due = { met: false, key: 'cadence:build@never', evidence: 'not yet' };
    const cp = { now: () => clock, pulseDue: async () => due } as unknown as ConditionProbes;
    const deps: TriggerTickDeps = { now: () => clock, probes: cp, vars: { seatState: join(dir, 'seat'), stateRoot },
      runGraph: async (_d, input, runId) => { runs.push(input.reason ?? ''); return { status: 'done', runId }; },
      postCard: async () => 'card', scheduleAction: async () => {} };
    registerTrigger(db, readTriggerDecl('graphs/triggers/op-pulse.yaml', ROOT), { now: new Date('2026-11-25T03:00:00Z') });
    for (const t of ['03:02', '03:04', '03:06']) { clock = new Date(`2026-11-25T${t}:00Z`); await tickTriggers(db, deps); }
    expect(runs).toEqual([]);
    due = { met: true, key: 'cadence:build@never', evidence: 'build cadence 60m · last pulse never' };
    for (const t of ['03:08', '03:10', '03:12']) { clock = new Date(`2026-11-25T${t}:00Z`); await tickTriggers(db, deps); }
    expect(runs).toEqual(['condition: build cadence 60m · last pulse never']);
    db.close();
  });
  test('the OP TUI opens exactly one origin-pulse turn per pulse id', () => {
    const inbox = join(dir, 'seat', 'OP', 'pulse', 'inbox.json'); const consumed = join(dir, 'seat', 'OP', 'pulse', 'inbox.consumed');
    const opened: Array<{ text: string; origin: string }> = [];
    let idle = false;
    const w = createPulseInboxWatcher({ inboxPath: inbox, consumedPath: consumed, setTimer: () => 0, clearTimer: () => {},
      startTurnIfIdle: (text, opts) => { if (!idle) return { opened: false, reason: 'NotIdle' }; opened.push({ text, origin: opts.origin }); return { opened: true, turnId: `t${opened.length}` }; } });
    expect(w.poll()).toBe(false);
    deliverPulseTurn({ ...io(), window: 'w9', stage: 'live', brief: '[pulse w9] 국면: build', runId: 'r9', now: clock, shadowDir: join(dir, 'shadow') });
    expect(w.poll()).toBe(false); // busy → retried
    idle = true;
    expect(w.poll()).toBe(true);
    expect(w.poll()).toBe(false);
    expect(opened).toEqual([{ text: '[pulse w9] 국면: build', origin: 'pulse' }]);
  });
});
