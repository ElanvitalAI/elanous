// OP-GOAL-DRIVEN-LOOP (owner 11-25) — controller integration: the drive loop reads the goal's OWN checklist
// count (done check `checklist:<version>:<status>>=n`) and lets a real increase cross the 3-continuation cap
// exactly once. Fail-closed by design: unknown/failed reads buy nothing, and a single-cell check
// (`checklist:<version>:<id>=<status>`) never consults counts — other cells' churn must not feed a goal's drive.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, readAutopilotState, type AutopilotDeps } from './autopilot.js';

const millisecondsPerMinute = 60_000; // Unit conversion: 60 seconds × 1,000 milliseconds.
// Each turn end carries a fresh transcript fingerprint: a real productive turn differs from the last one, so the
// runaway guard (AUTOPILOT_RUNAWAY_REPEATS — 3 identical no-op self wakes → backoff) stays intact and is NOT what
// the cap assertions measure. The stop under test is the drive cap, not the wake backoff.
let turnSeq = 0;
const end = () => {
  turnSeq += 1;
  return { selfInitiated: true, failed: false, stateChanged: true, fingerprint: `turn-${turnSeq}`, toolRows: [] as [] };
};
const openTaskGoal = (pilot: ReturnType<typeof createAutopilot>, doneCheck: string) =>
  pilot.set({
    on: true, goal: '0.3.36 그린 5개 칸', doneCriterion: '판정 한 줄', kind: 'task',
    deadline: '2026-11-30T00:00:00.000Z', expectedMinutes: 60, doneCheck,
  }, 'tool');

const root = mkdtempSync(join(tmpdir(), 'goal-driven-integration-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir = ''; let file = ''; let T = 0; let logs: Array<[string, Record<string, unknown>]> = [];
const advance = (min: number) => { T += min * millisecondsPerMinute; };
const make = (checklistCount?: AutopilotDeps['checklistCount']) => {
  logs = [];
  return createAutopilot({
    file, now: () => T,
    log: (...entry: [string, Record<string, unknown>]) => { logs.push(entry); },
    raiseDecision: () => undefined, postProgress: () => {},
    ...(checklistCount !== undefined ? { checklistCount } : {}),
  });
};
const continues = () => logs.filter(([event]) => event === 'drive-continue');
const stops = () => logs.filter(([event]) => event === 'drive-stop');
const persistedProgress = () => {
  const saved = readAutopilotState(file);
  if (!saved) throw new Error('autopilot state was not persisted');
  return saved.driveProgress ?? {};
};

beforeEach(() => {
  dir = join(root, `case-${Math.random().toString(36).slice(2)}`);
  file = join(dir, 'autopilot.json');
  T = 0;
});

test('a task goal at the cap continues once when its own checklist count rose; the same count never buys a second turn', () => {
  const counts = [2, 2, 2, 2, 3, 3];
  const pilot = make(() => counts.shift());
  openTaskGoal(pilot, 'checklist:0.3.36:green>=5');
  for (let i = 0; i < 4; i++) { pilot.turnEnded(end()); advance(5); }
  expect(continues().length).toBe(3); // three continuations, then the cap holds — the count never rose
  expect(stops().at(-1)?.[1].reason).toBe('cap');
  advance(5);
  const fifth = pilot.turnEnded(end()); // the goal's own green count rose 2 → 3
  expect(fifth.drive).toBeDefined();
  expect(continues().at(-1)?.[1].signal).toBe('progress');
  advance(5);
  const sixth = pilot.turnEnded(end()); // same count again — the high-water consumed the increase once
  expect(sixth.drive).toBeUndefined();
  expect(stops().at(-1)?.[1].reason).toBe('cap');
  const saved = readAutopilotState(file);
  if (!saved) throw new Error('autopilot state was not persisted');
  const lifeId = Object.keys(saved.driveProgress ?? {})[0]!;
  expect(saved.driveProgress?.[lifeId]).toEqual({ goalId: lifeId, version: '0.3.36', status: 'green', target: 5, count: 3 });
});

test('an unknown or failing count read fails closed — the cap holds and nothing is persisted', () => {
  for (const checklistCount of [undefined, (): number | undefined => undefined, (): number | undefined => { throw new Error('read failed'); }] as Array<AutopilotDeps['checklistCount']>) {
    const pilot = make(checklistCount);
    openTaskGoal(pilot, 'checklist:0.3.36:green>=5');
    for (let i = 0; i < 4; i++) { pilot.turnEnded(end()); advance(5); }
    expect(continues().length).toBe(3);
    expect(stops().at(-1)?.[1].reason).toBe('cap');
    expect(persistedProgress()).toEqual({});
  }
});

test('a single-cell checklist check stays binary — counts never feed its drive', () => {
  const pilot = make(() => 4); // a count exists, but the goal's check is not a count check
  openTaskGoal(pilot, 'checklist:0.3.36:CELL-9=green');
  for (let i = 0; i < 4; i++) { pilot.turnEnded(end()); advance(5); }
  expect(continues().length).toBe(3);
  expect(stops().at(-1)?.[1].reason).toBe('cap');
  expect(persistedProgress()).toEqual({});
});
