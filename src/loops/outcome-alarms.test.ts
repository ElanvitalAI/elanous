// OUTCOME-DONE-ALARMS — «done» is not an outcome: land-graph (ready but 0 landed for 30 min) · release (cut-at + 5 min, no
// run) · op-bulletin (BULLETIN-NOW.md older than 45 min) → ONE card to the owner and OP per episode. Fake clocks and probes,
// a temp registry, literal expectations.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { bulletinOutcome, landOutcome, liveOutcomeProbes, releaseOutcome, type OutcomeProbe, type OutcomeReading } from './outcome-alarms.js';
import { listOutcomes, openTriggerRegistry, registerTrigger, tickTriggers, type TriggerDecl, type TriggerTickDeps } from './trigger-registry.js';
import { loopsListLines, loopTone } from '../els/loop-agents.js';

const T0 = Date.parse('2026-11-26T07:00:00.000Z');
let dir: string;
let db: Database;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'outcome-alarms-')); db = openTriggerRegistry(join(dir, 'state')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function decl(graphId: string, owner: string): TriggerDecl {
  // 출처: fixture-only policy literals (a condition trigger that never fires; only the outcome step is under test).
  return { graphId, file: `graphs/triggers/${graphId}.yaml`, owner, condition: { predicate: { kind: 'all', of: [] }, cooldownMin: 2, onMaxWait: 'fire' },
    goal: { kind: 'file-mtime', path: '{stateRoot}/x' }, goalDeadlineMin: 20, maxAttempts: 2, backoffSec: [60], cutoverAfter: 2, staleAfterMin: 30 };
}

function harness(probes: Record<string, OutcomeProbe>) {
  let now = T0;
  const cards: { to: string; body: string }[] = [];
  const deps: TriggerTickDeps = {
    now: () => new Date(now),
    runGraph: async () => ({ status: 'done', runId: 'r' }),
    postCard: async (to, body) => { cards.push({ to, body }); return `msg#${cards.length}`; },
    scheduleAction: async () => {},
    vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
    probes: { 'all': () => ({ met: false }) } as unknown as TriggerTickDeps['probes'],
    outcomes: probes,
  };
  return { deps, cards, at: (min: number) => { now = T0 + min * 60_000; } };
}

describe('outcome readings', () => {
  test('land: ≥3 ready and 0 landed is bad (held 30 min); one landing or < 3 ready is fine', () => {
    expect(landOutcome({ landedRecent: 0, readyNotLanded: 4, mode: 'shadow' })).toMatchObject({ summary: 'landed 0/30m · ready 4 · shadow', bad: true, holdMin: 30 });
    expect(landOutcome({ landedRecent: 1, readyNotLanded: 4 }).bad).toBe(false);
    expect(landOutcome({ landedRecent: 0, readyNotLanded: 2 }).bad).toBe(false);
    expect(landOutcome({ landedRecent: 0, readyNotLanded: null })).toMatchObject({ summary: 'landed 0/30m · ready ?', bad: false });
  });

  test('release: a scheduled newer version whose cut passed 5+ min with no run = missing-run; a run, < 5 min, or released = fine', () => {
    const now = new Date('2026-11-26T07:06:00.000Z');
    const schedules = [{ version: '0.3.37', cutAt: '2026-11-26T07:00:00.000Z' }, { version: '0.3.36', cutAt: '2026-11-25T19:00:00.000Z' }];
    const bad = releaseOutcome({ now, released: '0.3.36', schedules, hasRun: () => false });
    expect(bad).toMatchObject({ summary: 'missing-run 0.3.37', bad: true, holdMin: 0, key: 'missing-run:0.3.37' });
    expect(bad.detail).toBe('missing-run: 0.3.37 cut-at 2026-11-26T07:00:00.000Z passed 6 min ago and no release graph run exists · start: eln release graph run 0.3.37 --cut-at <iso> --publish-at <iso>');
    expect(releaseOutcome({ now, released: '0.3.36', schedules, hasRun: v => v === '0.3.37' }).bad).toBe(false);
    expect(releaseOutcome({ now: new Date('2026-11-26T07:04:00.000Z'), released: '0.3.36', schedules, hasRun: () => false }).bad).toBe(false);
    expect(releaseOutcome({ now, released: '0.3.37', schedules, hasRun: () => false })).toMatchObject({ summary: 'runs ok', bad: false });
  });

  test('bulletin: older than 45 min is bad, keyed by its mtime; 45 min is still fine; missing is bad', () => {
    const now = new Date(T0);
    expect(bulletinOutcome({ now, mtimeMs: T0 - 46 * 60_000 })).toMatchObject({ summary: 'bulletin 46m old', bad: true, key: `bulletin:${T0 - 46 * 60_000}` });
    expect(bulletinOutcome({ now, mtimeMs: T0 - 45 * 60_000 }).bad).toBe(false);
    expect(bulletinOutcome({ now, mtimeMs: null })).toMatchObject({ summary: 'bulletin missing', bad: true });
  });
});

describe('alarm card: owner ⊕ OP, once per episode (dedupe)', () => {
  test('land graph: bad for < 30 min → no card; at 30 min → one card to TC and OP; still bad → no second card; recover then bad again → new card', async () => {
    let reading: OutcomeReading = landOutcome({ landedRecent: 0, readyNotLanded: 4 });
    registerTrigger(db, decl('land-graph', 'TC'));
    const h = harness({ 'land-graph': () => reading });
    await tickTriggers(db, h.deps);
    h.at(29); await tickTriggers(db, h.deps);
    expect(h.cards).toEqual([]);
    h.at(30); const events = await tickTriggers(db, h.deps);
    expect(h.cards.map(c => c.to)).toEqual(['TC', 'OP']);
    expect(h.cards[0]!.body).toBe('[graph-outcome alarm] land-graph: the loop reports done but its outcome is landed 0/30m · ready 4 — 4 PRs ready to land (every gate passes) but 0 landed in 30+ min · check: eln loop trigger watch land-graph');
    expect(events.filter(e => e.event === 'outcome-alarm')).toEqual([{ graphId: 'land-graph', event: 'outcome-alarm', detail: 'landed 0/30m · ready 4 → TC:msg#1 OP:msg#2' }]);
    h.at(32); await tickTriggers(db, h.deps);
    h.at(90); await tickTriggers(db, h.deps);
    expect(h.cards.length).toBe(2);
    reading = landOutcome({ landedRecent: 1, readyNotLanded: 4 });
    h.at(92); await tickTriggers(db, h.deps);
    expect(listOutcomes(db).get('land-graph')).toMatchObject({ summary: 'landed 1/30m · ready 4', bad: false, badSince: null });
    reading = landOutcome({ landedRecent: 0, readyNotLanded: 5 });
    h.at(94); await tickTriggers(db, h.deps);
    h.at(124); await tickTriggers(db, h.deps);
    expect(h.cards.length).toBe(4);
  });

  test('release: missing-run alarms at once; owner OP gets ONE card (no duplicate cc); same version never re-alarms', async () => {
    registerTrigger(db, decl('release-rocket', 'OP'));
    const now = (): Date => new Date(T0);
    const h = harness({ 'release-rocket': n => releaseOutcome({ now: n, released: '0.3.36', schedules: [{ version: '0.3.37', cutAt: new Date(now().getTime() - 5 * 60_000).toISOString() }], hasRun: () => false }) });
    await tickTriggers(db, h.deps);
    expect(h.cards.map(c => c.to)).toEqual(['OP']);
    expect(h.cards[0]!.body).toContain('missing-run: 0.3.37');
    h.at(2); await tickTriggers(db, h.deps);
    h.at(4); await tickTriggers(db, h.deps);
    expect(h.cards.length).toBe(1);
  });

  test('bulletin: stale → one card; rewritten then stale again → a new card (new mtime key)', async () => {
    registerTrigger(db, decl('op-bulletin', 'OP'));
    let mtime = T0 - 50 * 60_000;
    const h = harness({ 'op-bulletin': n => bulletinOutcome({ now: n, mtimeMs: mtime }) });
    await tickTriggers(db, h.deps);
    h.at(10); await tickTriggers(db, h.deps);
    expect(h.cards.length).toBe(1);
    mtime = T0 + 11 * 60_000;
    h.at(12); await tickTriggers(db, h.deps);
    expect(h.cards.length).toBe(1);
    h.at(60); await tickTriggers(db, h.deps);
    expect(h.cards.length).toBe(2);
    expect(h.cards[1]!.body).toContain('bulletin 49m old');
  });

  test('a throwing or empty probe never cards; graphs without a probe are untouched', async () => {
    registerTrigger(db, decl('land-graph', 'TC'));
    registerTrigger(db, decl('op-pulse', 'OP'));
    const h = harness({ 'land-graph': () => { throw new Error('ledger locked'); } });
    await tickTriggers(db, h.deps);
    expect(h.cards).toEqual([]);
    expect(listOutcomes(db).size).toBe(0);
  });
});

describe('live probes read the files loops already write', () => {
  test('land ledger ⊕ last-tick readyNotLanded · BULLETIN-NOW.md mtime · release run dir', () => {
    const stateRoot = join(dir, 'live'); const seatState = join(dir, 'seat');
    mkdirSync(join(stateRoot, 'land-graph'), { recursive: true });
    mkdirSync(join(seatState, 'OPS'), { recursive: true });
    mkdirSync(join(stateRoot, 'release-graph', '0.3.38'), { recursive: true });
    writeFileSync(join(stateRoot, 'release-graph', '0.3.38', 'state.json'), '{}');
    writeFileSync(join(stateRoot, 'land-graph', 'last-tick.json'), JSON.stringify({ at: 'x', mode: 'shadow', decisions: 5, landed: [], ready: 3, readyNotLanded: 3 }));
    writeFileSync(join(stateRoot, 'land-graph', 'ledger.jsonl'), [
      JSON.stringify({ at: new Date(T0 - 40 * 60_000).toISOString(), pr: 1, head: 'a', mode: 'live', event: 'landed' }),
      JSON.stringify({ at: new Date(T0 - 5 * 60_000).toISOString(), pr: 2, head: 'b', mode: 'live', event: 'landed', synthetic: true }),
    ].join('\n') + '\n');
    const bulletin = join(seatState, 'OPS', 'BULLETIN-NOW.md');
    writeFileSync(bulletin, 'x');
    utimesSync(bulletin, new Date(T0 - 60 * 60_000), new Date(T0 - 60 * 60_000));
    const probes = liveOutcomeProbes({ stateRoot, seatState, releases: () => ({ released: '0.3.36', schedules: [
      { version: '0.3.37', cutAt: new Date(T0 - 120 * 60_000).toISOString() }, { version: '0.3.38', cutAt: new Date(T0 - 60 * 60_000).toISOString() }] }) });
    const now = new Date(T0);
    expect(probes['land-graph']!(now)).toMatchObject({ summary: 'landed 0/30m · ready 3 · shadow', bad: true });
    expect(probes['op-bulletin']!(now)).toMatchObject({ summary: 'bulletin 60m old', bad: true });
    expect(probes['release-rocket']!(now)).toMatchObject({ summary: 'missing-run 0.3.37', bad: true });
    expect(liveOutcomeProbes({ stateRoot: join(dir, 'none'), seatState })['land-graph']!(now)).toBe(null);
  });
});

describe('loop tab line shows the outcome', () => {
  test('«↻ loops (N)» row carries the summary; a bad outcome is ⚠ and the loop is red even when «done»', () => {
    const agent = { id: 'land-graph', owner: 'TC', stage: 'live', lastStatus: 'done', lastAt: new Date(T0 - 60_000).toISOString(), outcome: { summary: 'landed 0/30m · ready 4', bad: true } };
    expect(loopTone(agent)).toBe('error');
    expect(loopTone({ ...agent, outcome: { summary: 'landed 2/30m · ready 0', bad: false } })).toBe('ok');
    const lines = loopsListLines('TC', [{ agent, fireAtMs: [] }], 0, T0, 120, false);
    expect(lines[0]).toBe('● ↻ loops (1) · TC · 1 in exception');
    expect(lines[3]).toBe('› ● land-graph ▁▁▁▁▁▁  1m · done · ⚠ landed 0/30m · ready 4 · on cond');
  });
});

describe('sim world: a seeded federation evening (seeds 1–5 · 2-min ticks · 4 h)', () => {
  // The land graph flips between stalled (ready ≥3, 0 landed) and landing at random; invariant per seed: one card pair per
  // bad episode that lasted ≥ 30 min, none for shorter ones, and never two cards for the same episode.
  function rng(seed: number): () => number { let x = (seed * 2654435761) >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      let bad = false;
      registerTrigger(db, decl('land-graph', 'TC'));
      const h = harness({ 'land-graph': () => landOutcome({ landedRecent: bad ? 0 : 1, readyNotLanded: bad ? 4 : 0 }) });
      let episodeStart = -1; let expected = 0;
      for (let min = 0; min <= 240; min += 2) {
        if (r() < 0.08) bad = !bad;
        if (bad && episodeStart < 0) episodeStart = min;
        if (!bad) episodeStart = -1;
        if (bad && min - episodeStart === 30) expected += 1;
        h.at(min); await tickTriggers(db, h.deps);
      }
      expect(h.cards.length).toBe(expected * 2);
      expect(h.cards.every((c, i) => c.to === (i % 2 === 0 ? 'TC' : 'OP'))).toBe(true);
      db.query('DELETE FROM graph_trigger_registry').run();
      db.query('DELETE FROM graph_trigger_outcomes').run();
    });
  }
});
