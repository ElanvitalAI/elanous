// LA-B1 (sim #40379 · BUTLER-TICK-CADENCE): a max-wait fire on an unchanged, already-met state must keep that state key as
// the fired edge. Before the fix the wait key replaced it, the same state looked «new», and the trigger re-fired one cooldown
// later: a quiet judge-butler ran at [1,11,13,23,25] min instead of [1,11,21,31] (doubled gh/ssh reads).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConditionProbes } from './trigger-conditions.js';
import { openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from './trigger-registry.js';

const REPO = resolve(import.meta.dir, '../..');
const T0 = Date.parse('2026-11-27T02:00:00Z');
const MIN = 60_000; // 출처: #40388 — one minute in ms (the scenario clock unit, not a bound)
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(mtimes: (minute: number) => Record<string, number>) {
  const root = mkdtempSync(join(tmpdir(), 'trigger-maxwait-'));
  dirs.push(root);
  const stateRoot = join(root, 'state'); const seatState = join(root, 'seat-state');
  mkdirSync(seatState, { recursive: true });
  const db = openTriggerRegistry(stateRoot);
  let clock = T0;
  registerTrigger(db, readTriggerDecl(join('graphs', 'triggers', 'judge-butler.yaml'), REPO), { now: new Date(clock) });
  const runs: number[] = [];
  const minute = () => (clock - T0) / MIN;
  const probes: ConditionProbes = {
    now: () => new Date(clock), watch: async () => null, readJson: () => undefined, readLines: () => [],
    mtimeMs: (path) => { const hit = Object.entries(mtimes(minute())).find(([k]) => path.endsWith(k)); return hit ? hit[1] : null; },
    cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
    publishedVersions: async () => [], installedVersion: async () => null,
  };
  const heartbeat = join(stateRoot, 'loop-agents', 'judge-butler', 'last-tick.json');
  const deps: TriggerTickDeps = {
    now: () => new Date(clock), vars: { seatState, stateRoot }, probes,
    runGraph: async (_d, _input, runId) => {
      runs.push(minute());
      mkdirSync(join(stateRoot, 'loop-agents', 'judge-butler'), { recursive: true });
      writeFileSync(heartbeat, '{}'); utimesSync(heartbeat, new Date(clock), new Date(clock));
      return { status: 'done', runId };
    },
    postCard: async () => 'card', scheduleAction: async () => {},
  };
  const at = async (m: number) => { clock = T0 + m * MIN; await tickTriggers(db, deps, { only: 'judge-butler' }); };
  return { runs, at, close: () => db.close() };
}

test('quiet world: one tick on register, then exactly one per 10-min max-wait — no extra tick one cooldown later', async () => {
  const w = world(() => ({}));
  try {
    for (let m = 1; m <= 31; m += 1) await w.at(m);
    expect(w.runs).toEqual([1, 11, 21, 31]);
  } finally { w.close(); }
});

test('a real change still fires at once (after the 2-min cooldown) and restarts the 10-min clock', async () => {
  const w = world((m): Record<string, number> => (m >= 5 ? { 'release/features.sqlite': 5_000 } : {}));
  try {
    for (let m = 1; m <= 25; m += 1) await w.at(m);
    expect(w.runs).toEqual([1, 5, 15, 25]);
  } finally { w.close(); }
});
