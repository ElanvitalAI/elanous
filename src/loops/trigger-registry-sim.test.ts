/**
 * SIM device — graph trigger registry on a virtual clock (SCHEDULER-TO-GRAPH-RUNNER Phase 1).
 * The graph runner, the owner's mailbox, and the schedule CRUD are synthetic; the registry DB, the run-id
 * binding SSOT, the goal predicate files, and the cutover marker are real files in a temp universe.
 * Scenarios: single registration · dedupe on double trigger · failure → retry → exception card ·
 * goal deadline miss · shadow → cutover (schedule and marker legacy) · cutover failure keeps shadow · stale skip.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { listFires, listTriggers, openTriggerRegistry, registerTrigger, tickTriggers, type TriggerDecl, type TriggerRunInput,
  type TriggerTickDeps } from './trigger-registry.js';

let dir: string;
let db: Database;
let clock: Date;
let runs: Array<{ graphId: string; window: string; stage: string; attempt: number; runId: string }>;
let cards: Array<{ owner: string; body: string }>;
let scheduleCalls: string[];
let runOutcome: (input: TriggerRunInput) => 'done' | 'failed';
let onRun: (input: TriggerRunInput) => void;
let scheduleFails: boolean;

function deps(): TriggerTickDeps {
  return {
    now: () => clock,
    vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
    runGraph: async (_decl, input, runId) => {
      runs.push({ graphId: input.graphId, window: input.window, stage: input.stage, attempt: input.attempt, runId });
      onRun(input);
      const status = runOutcome(input);
      return status === 'done' ? { status, runId } : { status, runId, error: 'synthetic node failure' };
    },
    postCard: async (owner, body) => { cards.push({ owner, body }); return `card-${cards.length}`; },
    scheduleAction: async (action, id) => {
      if (scheduleFails) throw new Error('crontab locked');
      scheduleCalls.push(`${action}:${id}`);
    },
  };
}

const at = (iso: string) => { clock = new Date(iso); };
const goalFile = () => join(dir, 'seat', 'BULLETIN-NOW.md');
function touchGoal(iso: string) {
  writeFileSync(goalFile(), 'bulletin');
  utimesSync(goalFile(), new Date(iso), new Date(iso));
}

function bulletin(overrides: Partial<TriggerDecl> = {}): TriggerDecl {
  return { graphId: 'sim-bulletin', file: 'graphs/triggers/sim.yaml', owner: 'SIM-OWNER', cron: '5,35 * * * *', timeZone: 'UTC',
    // 출처: RFC-loop-agents-graph-runner-topology §19b — sim literals: 3 attempts with 60s/120s backoff are this sim's own fixture, not product defaults.
    goal: { kind: 'file-mtime', path: '{seatState}/BULLETIN-NOW.md' }, goalDeadlineMin: 20, maxAttempts: 3, backoffSec: [60, 120],
    legacy: { kind: 'schedule', id: 'legacy-bulletin-7' }, cutoverAfter: 2, staleAfterMin: 15, ...overrides };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trigger-sim-'));
  mkdirSync(join(dir, 'seat'), { recursive: true });
  db = openTriggerRegistry(join(dir, 'state'));
  runs = []; cards = []; scheduleCalls = []; scheduleFails = false;
  runOutcome = () => 'done'; onRun = () => {};
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('SIM graph trigger registry', () => {
  test('single registration: three registers of one graph leave one row and one run per window', async () => {
    registerTrigger(db, bulletin()); registerTrigger(db, bulletin()); registerTrigger(db, bulletin());
    expect(listTriggers(db).map(r => r.graphId)).toEqual(['sim-bulletin']);
    at('2026-11-25T09:05:30Z');
    await tickTriggers(db, deps());
    expect(runs).toHaveLength(1);
  });

  test('dedupe: a double trigger (two concurrent ticks, then a late third) runs the window once', async () => {
    registerTrigger(db, bulletin());
    at('2026-11-25T09:05:10Z');
    const [a, b] = await Promise.all([tickTriggers(db, deps()), tickTriggers(db, deps())]);
    at('2026-11-25T09:09:00Z');
    const c = await tickTriggers(db, deps());
    expect(runs.map(r => [r.window, r.attempt])).toEqual([['2026-11-25T09:05:00.000Z', 1]]);
    expect([...a, ...b, ...c].filter(e => e.event === 'deduped').length).toBeGreaterThanOrEqual(2);
    // The run identity is the shared binding SSOT: the same window/attempt resolves to the same runId.
    const fire = listFires(db, 'sim-bulletin')[0]!;
    expect(fire.runId).toBe(runs[0]!.runId);
  });

  test('failure → retry with backoff → exception card to the owner, never silent', async () => {
    registerTrigger(db, bulletin({ legacy: undefined }));
    runOutcome = () => 'failed';
    at('2026-11-25T09:05:00Z'); await tickTriggers(db, deps());
    expect(listFires(db, 'sim-bulletin')[0]!.status).toBe('retry-wait');
    at('2026-11-25T09:05:59Z'); await tickTriggers(db, deps());
    expect(runs).toHaveLength(1); // backoff 60s not yet elapsed
    at('2026-11-25T09:06:00Z'); await tickTriggers(db, deps());
    at('2026-11-25T09:08:00Z'); await tickTriggers(db, deps());
    expect(runs.map(r => r.attempt)).toEqual([1, 2, 3]);
    const fire = listFires(db, 'sim-bulletin')[0]!;
    expect([fire.status, fire.attempt, fire.card]).toEqual(['exception', 3, 'card-1']);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.owner).toBe('SIM-OWNER');
    expect(cards[0]!.body).toContain('sim-bulletin window 2026-11-25T09:05:00.000Z (live) failed 3/3 attempts: graph run failed: synthetic node failure');
    at('2026-11-25T09:20:00Z'); await tickTriggers(db, deps());
    expect(cards).toHaveLength(1); // one card per exception window
  });

  test('a run that succeeds but misses its goal deadline retries, then recovers when the goal appears', async () => {
    registerTrigger(db, bulletin({ legacy: undefined }));
    at('2026-11-25T09:05:00Z'); await tickTriggers(db, deps());
    at('2026-11-25T09:15:00Z');
    const pending = await tickTriggers(db, deps());
    expect(pending.some(e => e.event === 'goal-pending')).toBe(true);
    at('2026-11-25T09:25:00Z'); await tickTriggers(db, deps());
    expect(listFires(db, 'sim-bulletin')[0]!.status).toBe('retry-wait');
    onRun = () => touchGoal('2026-11-25T09:26:10Z');
    at('2026-11-25T09:26:00Z'); await tickTriggers(db, deps());
    at('2026-11-25T09:27:00Z'); const events = await tickTriggers(db, deps());
    expect(events.some(e => e.event === 'done' && e.window === '2026-11-25T09:05:00.000Z')).toBe(true);
    expect(runs.map(r => r.attempt)).toEqual([1, 2]);
    expect(cards).toHaveLength(0);
  });

  test('shadow → cutover: two goal-verified shadow windows disable the legacy schedule, then runs are live', async () => {
    registerTrigger(db, bulletin());
    onRun = () => touchGoal(clock.toISOString()); // the legacy path produces the effect in shadow
    at('2026-11-25T09:05:00Z'); await tickTriggers(db, deps());
    at('2026-11-25T09:06:00Z'); await tickTriggers(db, deps());
    expect(listTriggers(db)[0]!.stage).toBe('shadow');
    expect(scheduleCalls).toEqual([]);
    at('2026-11-25T09:35:00Z'); const events = await tickTriggers(db, deps());
    at('2026-11-25T09:36:00Z'); events.push(...await tickTriggers(db, deps()));
    expect(events.map(e => e.event)).toContain('cutover');
    expect(scheduleCalls).toEqual(['disable:legacy-bulletin-7']);
    expect(listTriggers(db)[0]!.stage).toBe('live');
    at('2026-11-25T10:05:00Z'); await tickTriggers(db, deps());
    expect(runs.map(r => r.stage)).toEqual(['shadow', 'shadow', 'live']);
  });

  test('cutover failure keeps shadow (legacy still on) and cards the owner', async () => {
    registerTrigger(db, bulletin({ cutoverAfter: 1 }));
    scheduleFails = true;
    onRun = () => touchGoal(clock.toISOString());
    at('2026-11-25T09:05:00Z'); const events = await tickTriggers(db, deps());
    at('2026-11-25T09:06:00Z'); events.push(...await tickTriggers(db, deps()));
    expect(events.map(e => e.event)).toContain('cutover-failed');
    expect(listTriggers(db)[0]!.stage).toBe('shadow');
    expect(cards[0]!.body).toContain('[graph-trigger cutover failed] sim-bulletin');
    expect(cards[0]!.body).toContain('crontab locked');
  });

  test('marker legacy: cutover writes the marker the legacy watchdog checks', async () => {
    registerTrigger(db, bulletin({ cutoverAfter: 1, legacy: { kind: 'marker', path: '{seatState}/.graph-cutover/sim-bulletin' } }));
    onRun = () => touchGoal(clock.toISOString());
    at('2026-11-25T09:05:00Z'); await tickTriggers(db, deps());
    at('2026-11-25T09:06:00Z'); await tickTriggers(db, deps());
    const marker = join(dir, 'seat', '.graph-cutover', 'sim-bulletin');
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8')).graphId).toBe('sim-bulletin');
    expect(listTriggers(db)[0]!.stage).toBe('live');
  });

  test('restart after a long gap fires nothing stale and never replays old windows', async () => {
    registerTrigger(db, bulletin());
    at('2026-11-25T09:30:00Z'); // latest due 09:05 is 25 min old > staleAfter 15
    const events = await tickTriggers(db, deps());
    expect(events.map(e => [e.event, e.window])).toEqual([['stale-skipped', '2026-11-25T09:05:00.000Z']]);
    at('2026-11-25T09:35:20Z'); await tickTriggers(db, deps());
    expect(runs.map(r => r.window)).toEqual(['2026-11-25T09:35:00.000Z']);
  });
});
