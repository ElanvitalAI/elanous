// BURST-ACTUATOR-WIRED — a started burst launches through its lane doors and the beat counts launches, not targets.
// Expected values are literals from the 11-28 incident shape (burst-20261128T1409 · preset 4h · backlog 213 · 16 hands).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PulseMeasure } from './op-pulse.js';
import { DEFAULT_BURST_CONFIG, startBurst, type BurstState } from './op-pulse-burst.js';
import { actuateBurst, burstActuatorPolicyPath, normalizeBurstState, parseBurstActuatorPolicy, type BurstActuators } from './op-pulse-burst-actuate.js';
import { readActiveBurst, runPulse, writeBurst, type PulseExtra, type PulseProbes } from './op-pulse-run.js';

const RHYTHM = join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml');
const POLICY_TEXT = readFileSync(burstActuatorPolicyPath(), 'utf8');
const policy = parseBurstActuatorPolicy(POLICY_TEXT);
const T0 = new Date('2026-11-28T14:09:47.927Z');
const STOP_AT = '2026-11-29T04:15:00+09:00'; // the incident burst's end (KST)
const STOP_4H = '2026-11-28T18:09:47.927Z'; // T0 + 4 h
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const preset4h = DEFAULT_BURST_CONFIG.presets.find(p => p.name === '4h')!;

let dir: string; let clock: Date;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'burst-actuate-')); clock = min(0); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const burstPath = () => join(dir, 'seat', 'OP', 'pulse', 'burst.json');
const measure = (): PulseMeasure => ({ at: clock.toISOString(), version: '0.3.40', landedPerH: 3, greenPerH: 0, judgeQueue: 0, judgeWaitMedianMin: null, budget: [], unmeasured: [],
  spaces: [{ space: 'TC', landedPerH: 3, greenPerH: 0, hands: 16, idleWithWork: 4, readyCells: 213, blockedCells: 0 }] });
const extra = (): PulseExtra => ({ landed3hPerH: 3, green3hPerH: null, readyBacklog: 213, openInScope: 213,
  demand: { newP0PerH: 0, baselineP0PerH: null, activeRequirements: null, readyBacklogGrowthPerH: null }, gateWaitMin: null, reviewWaitMin: null, landQueue: null });
const calls: Array<{ lane: string; count: number }> = [];
const fakeDoors = (panes: string[]): BurstActuators => ({
  up: { hands: async ({ lane, count }) => { calls.push({ lane, count }); return { units: panes.splice(0, count).map(id => ({ id, host: `HAND-${id}` })) }; } },
  close: async () => {},
});
const probes = (doors?: BurstActuators): PulseProbes => ({ now: () => clock, localHour: () => 23, schedules: () => [], measure: async () => ({ measure: measure(), extra: extra() }), crownMails: () => [],
  ...(doors ? { burstActuators: () => doors } : {}) });
const pulse = (window: string, doors?: BurstActuators, stage = 'live') =>
  runPulse(probes(doors), { rhythmPath: RHYTHM, seatState: join(dir, 'seat'), stateRoot: join(dir, 'state'), window, stage });
const start = () => writeBurst(burstPath(), startBurst({ goal: 'land', until: STOP_AT, scope: ['ALL'], by: 'OP', now: T0, preset: preset4h }, null));

describe('burst-actuators policy (graphs/policies/burst-actuators.yaml)', () => {
  test('shipped doors: hands = els new · vm = eln hosts start · every other lane unwired', () => {
    expect(Object.entries(policy.lanes).map(([l, v]) => `${l}=${v.door}`).sort())
      .toEqual(['hands=els-new', 'judge=none', 'land=none', 'pregate=none', 'remote=none', 'review=none', 'ta=none', 'vm=hosts-start']);
    expect(policy.stallAfterMin).toBe(15);
    expect(policy.pressureTargets).toEqual({ gateWaitMin: 10, reviewWaitMin: 20, landQueue: 6, readyPerHandDefault: 2, judgeWaitMinDefault: 30 });
  });
  test('an unknown door, a door without its timeout, or an els-new without seats_dir is refused', () => {
    expect(() => parseBurstActuatorPolicy(POLICY_TEXT.replace('door: hosts-start', 'door: ssh-anything'))).toThrow('lanes.vm.door');
    expect(() => parseBurstActuatorPolicy(POLICY_TEXT.replace('    timeout_sec: 300\n', ''))).toThrow('lanes.vm.timeout_sec');
    expect(() => parseBurstActuatorPolicy(POLICY_TEXT.replace(/ {4}seats_dir: seats .*\n/, ''))).toThrow('seats_dir');
  });
});

describe('burst state: levels = executed, preset lanes = targets', () => {
  test('a fresh start runs nothing and keeps the preset as targets', () => {
    const s = startBurst({ goal: 'land', until: STOP_AT, scope: ['ALL'], by: 'OP', now: T0, preset: preset4h }, null);
    expect(s.levels).toEqual({});
    expect(s.targets).toEqual({ hands: 4, remote: 4, ta: 4, review: 2, pregate: 2, land: 1 });
  });
  test('a burst.json written before the fix (targets in levels, no launches) reads as 0 running', () => {
    const legacy = { ...startBurst({ goal: 'land', until: STOP_AT, scope: ['ALL'], by: 'OP', now: T0, preset: preset4h }, null), levels: { hands: 4, ta: 4 } } as BurstState;
    delete (legacy as { targets?: unknown }).targets;
    expect(normalizeBurstState(legacy)).toMatchObject({ levels: {}, targets: { hands: 4, ta: 4 } });
    writeBurst(burstPath(), legacy);
    expect(readActiveBurst(burstPath())).toMatchObject({ levels: {}, targets: { hands: 4, ta: 4 } });
  });
});

describe('the live pulse executes the plan', () => {
  test('first burst pulse (≤ 15 min after start) launches hands through the door · beat counts launches · state records exact ids', async () => {
    start(); clock = min(14); calls.length = 0;
    const r = await pulse('2026-11-28T14:24:00Z', fakeDoors(['w3:p11', 'w3:p12', 'w3:p13']));
    expect(calls).toEqual([{ lane: 'hands', count: 2 }]);
    const s = JSON.parse(readFileSync(burstPath(), 'utf8')) as BurstState;
    expect(s.launches.map(l => `${l.lane}:${l.id}:${l.host}`)).toEqual(['hands:w3:p11:HAND-w3:p11', 'hands:w3:p12:HAND-w3:p12']);
    expect(s.levels).toEqual({ hands: 2 });
    expect(s.lastChangeAt.hands).toBe(min(14).toISOString());
    expect(r.brief).toContain('실행(이번 펄스): 손 +2 · VM +0 · 가동 중 2 (손 2)');
    expect(r.brief).toContain('- 실행 hands: 계획 +2 → 실행 +2 (did · w3:p11, w3:p12)');
    expect(r.brief).not.toContain('버스트 무가동');
  });
  test('next pulse inside the lane cooldown launches nothing; after it, one more step', async () => {
    start(); clock = min(14);
    const doors = fakeDoors(['p1', 'p2', 'p3', 'p4']);
    await pulse('w1', doors);
    clock = min(24);
    const cooling = await pulse('w2', doors);
    expect(cooling.brief).toContain('실행(이번 펄스): 손 +0 · VM +0 · 가동 중 2 (손 2)');
    clock = min(30);
    await pulse('w3', doors);
    expect((JSON.parse(readFileSync(burstPath(), 'utf8')) as BurstState).levels).toEqual({ hands: 4 });
  });
  test('no doors (the 11-28 shape): beat says 손 +0 and, past stall_after_min, a ⚠ line names why', async () => {
    start(); clock = min(20);
    const r = await pulse('w1');
    expect(r.brief).toContain('실행(이번 펄스): 손 +0 · VM +0 · 가동 중 0');
    expect(r.brief).toContain('⚠ 버스트 무가동 20분 — 계획은 올리는데 실행 0: hands unwired');
    expect((JSON.parse(readFileSync(burstPath(), 'utf8')) as BurstState).launches).toEqual([]);
  });
  test('shadow stage: «would» rows, the door is never called, burst.json unchanged', async () => {
    start(); clock = min(14); calls.length = 0;
    const before = readFileSync(burstPath(), 'utf8');
    const r = await pulse('w1', fakeDoors(['p1', 'p2']), 'shadow');
    expect(calls).toEqual([]);
    expect(r.brief).toContain('- 실행 hands: 계획 +2 → 실행 +0 (would · stage shadow)');
    expect(readFileSync(burstPath(), 'utf8')).toBe(before);
    expect(existsSync(burstPath())).toBe(true);
  });
});

describe('actuateBurst edges', () => {
  const base = () => startBurst({ goal: 'land', until: STOP_4H, scope: ['ALL'], by: 'OP', now: T0, budgetUsd: 7 }, null);
  test('a door that throws → failed row, nothing recorded', async () => {
    const r = await actuateBurst({ state: base(), plan: [{ lane: 'hands', from: 0, to: 2, pressure: 5, why: 'x' }], policy, lanes: DEFAULT_BURST_CONFIG.lanes, now: T0, stage: 'live',
      actuators: { up: { hands: async () => { throw new Error('els socket gone'); } } } });
    expect(r.rows).toEqual([{ lane: 'hands', from: 0, planned: 2, executed: 0, ids: [], status: 'failed', note: 'els socket gone' }]);
    expect(r.state.launches).toEqual([]);
  });
  test('budget ceiling: a unit past it is named in the note, not hidden and not recorded', async () => {
    // 4 h × $1.5 = $6 per hand · ceiling $7 → the first is recorded, the second refused.
    const r = await actuateBurst({ state: base(), plan: [{ lane: 'hands', from: 0, to: 2, pressure: 5, why: 'x' }], policy, lanes: DEFAULT_BURST_CONFIG.lanes, now: T0, stage: 'live',
      actuators: { up: { hands: async () => ({ units: [{ id: 'p1' }, { id: 'p2' }] }) } } });
    expect(r.state.launches.map(l => l.id)).toEqual(['p1']);
    expect(r.state.spentUsd).toBe(6);
    expect(r.rows[0]!.status).toBe('partial');
    expect(r.rows[0]!.note).toContain('p2 launched but not recorded (budget ceiling');
  });
  test('scale-down closes the newest open launches of the lane by exact id', async () => {
    let s = base();
    s = { ...s, launches: ['p1', 'p2', 'p3'].map(id => ({ lane: 'hands' as const, id, at: T0.toISOString() })) };
    const closed: string[] = [];
    const r = await actuateBurst({ state: s, plan: [{ lane: 'hands', from: 3, to: 1, pressure: 0.5, why: 'dropped' }], policy, lanes: DEFAULT_BURST_CONFIG.lanes, now: min(30), stage: 'live',
      actuators: { up: {}, close: async (l) => { closed.push(l.id); } } });
    expect(closed).toEqual(['p3', 'p2']);
    expect(r.state.levels).toEqual({ hands: 1 });
  });
  test('a lane whose policy door is none stays unwired even when a door function exists', async () => {
    const r = await actuateBurst({ state: base(), plan: [{ lane: 'ta', from: 0, to: 2, pressure: 5, why: 'x' }], policy, lanes: DEFAULT_BURST_CONFIG.lanes, now: T0, stage: 'live',
      actuators: { up: { ta: async () => ({ units: [{ id: 'run-1' }] }) } } });
    expect(r.rows[0]).toMatchObject({ lane: 'ta', executed: 0, status: 'unwired' });
  });
});
