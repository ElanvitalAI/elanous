/**
 * SIM world — RELEASE-TRAFFIC on the compound condition engine (Cell: SCHEDULER-TO-GRAPH-RUNNER · CEO 11-25 23:5x).
 * The REAL graphs/triggers/release-traffic.yaml is registered in a scratch trigger registry; a virtual clock walks the
 * night; synthetic events = release-graph state.json writes, RES lease rows, host up/down, hand config edits.
 * The graph run = runTrafficNode with a fake actuator (config map · ssh · lease request · update-all · cards).
 * Every scenario runs on 3 seeds (the release schedule shifts per seed) — expectations are literal, not derived.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { evaluatePredicate, parseWhen, type ConditionProbes } from '../loops/trigger-conditions.js';
import { liveFacts } from '../loops/trigger-facts.js';
import { listFires, openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from '../loops/trigger-registry.js';
import { readAudit, runTrafficNode, trafficTick, type TrafficDeps } from './release-traffic.js';

const REPO = join(import.meta.dir, '..', '..');
const SEEDS = [1, 2, 3];
const V = '0.3.40';

let dir: string; let db: Database; let clock: Date;
let config: Record<string, number>; let up: boolean; let capacityAsks: string[]; let updates: number; let cards: string[]; let runs: string[];
let releaseState: Record<string, unknown>; let rehearsal: Record<string, unknown> | null; let leases: unknown[];

const stateRoot = () => join(dir, 'state'); const seatState = () => join(dir, 'seat'); const resRoot = () => join(seatState(), 'RES', 'graph-state');
function flush(): void {
  mkdirSync(join(stateRoot(), 'release-graph', V), { recursive: true });
  writeFileSync(join(stateRoot(), 'release-graph', V, 'state.json'), JSON.stringify(releaseState));
  if (rehearsal) { mkdirSync(join(stateRoot(), 'release-graph', `${V}-rehearsal`), { recursive: true }); writeFileSync(join(stateRoot(), 'release-graph', `${V}-rehearsal`, 'state.json'), JSON.stringify(rehearsal)); }
  mkdirSync(resRoot(), { recursive: true }); writeFileSync(join(resRoot(), 'leases.json'), JSON.stringify(leases));
}
/** Schedule for a seed: base night 2026-11-26 (KST 00:00 rehearsal · 04:00 cut · 06:00 publish) shifted by seed × 7 min. */
function sched(seed: number) {
  const s = (iso: string) => new Date(Date.parse(iso) + seed * 7 * 60_000).toISOString();
  return { rehearsalAt: s('2026-11-25T15:00:00Z'), cutAt: s('2026-11-25T19:00:00Z'), publishAt: s('2026-11-25T21:00:00Z'), shift: (iso: string) => new Date(s(iso)) };
}
const fake = (): Omit<TrafficDeps, 'root' | 'live' | 'facts' | 'now'> => ({
  getSlots: h => config[h] ?? null, setSlots: (h, n) => { config[h] = n; return true; }, hostUp: () => up,
  requestCapacity: r => { capacityAsks.push(r); return 'ok: picked minim5 (local · $0)'; }, updateAll: () => { updates++; return true; },
  card: b => { cards.push(b); }, owner: () => 'REL',
});
const probes = (): ConditionProbes => ({
  now: () => clock, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
  publishedVersions: async () => [], installedVersion: async () => null,
});
function deps(): TriggerTickDeps {
  return {
    now: () => clock, probes: probes(), vars: { seatState: seatState(), stateRoot: stateRoot() },
    runGraph: async (_d, input, runId) => {
      flush(); runs.push(input.reason ?? '');
      const out = runTrafficNode({ input: { window: input.window, stage: 'live', vars: { stateRoot: stateRoot(), seatState: seatState() } } },
        { ...fake(), root: resRoot(), live: true, now: () => clock, facts: () => liveFacts(stateRoot(), seatState(), clock) });
      return out.outcome === 'ok' ? { status: 'done', runId } : { status: 'failed', runId, error: String(out.why) };
    },
    postCard: async (o, b) => { cards.push(`${o}|${b}`); return `c${cards.length}`; }, scheduleAction: async () => {},
  };
}
async function walk(times: Date[]): Promise<void> { for (const t of times) { clock = t; flush(); await tickTriggers(db, deps()); } }
const every = (from: Date, to: Date, min: number) => { const out: Date[] = []; for (let t = from.getTime(); t <= to.getTime(); t += min * 60_000) out.push(new Date(t)); return out; };

function setup(seed: number) {
  const s = sched(seed);
  releaseState = { version: V, clock: { rehearsalAt: s.rehearsalAt, cutAt: s.cutAt, publishAt: s.publishAt }, steps: {} };
  rehearsal = null; leases = [{ host: 'aws1', state: 'active', endsAt: '2026-11-26T12:00:00Z' }];
  flush();
  registerTrigger(db, readTriggerDecl(join(REPO, 'graphs', 'triggers', 'release-traffic.yaml'), REPO), { now: s.shift('2026-11-25T10:00:00Z') });
  return s;
}
const publish = (iso: string) => { (releaseState.steps as Record<string, unknown>).publish = { status: 'done', actualAt: iso }; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-traffic-sim-')); mkdirSync(seatState(), { recursive: true });
  db = openTriggerRegistry(stateRoot());
  config = { 'node-b': 5, 'aws1': 2 }; up = true; capacityAsks = []; updates = 0; cards = []; runs = [];
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe.each(SEEDS)('SIM release-traffic seed %i', (seed) => {
  test('normal night: reserve at rehearsal−15m → hold → publish → restore 5 + update-all once', async () => {
    const s = setup(seed);
    await walk(every(s.shift('2026-11-25T14:00:00Z'), s.shift('2026-11-25T14:40:00Z'), 10));
    expect(config).toEqual({ 'node-b': 5, 'aws1': 2 });
    await walk(every(s.shift('2026-11-25T14:45:00Z'), s.shift('2026-11-25T20:55:00Z'), 10));
    expect(config).toEqual({ 'node-b': 1, 'aws1': 5 });
    publish(s.shift('2026-11-25T21:02:00Z').toISOString());
    await walk(every(s.shift('2026-11-25T21:05:00Z'), s.shift('2026-11-25T23:00:00Z'), 10));
    expect(config).toEqual({ 'node-b': 5, 'aws1': 2 });
    expect(updates).toBe(1);
    const fires = listFires(db, 'release-traffic', 100);
    expect(fires.length).toBeLessThanOrEqual(4);
    expect(runs.some(r => r.includes('release.published=true'))).toBe(true);
    expect(readAudit(resRoot()).filter(r => r.to !== undefined).every(r => typeof r.undo === 'string')).toBe(true);
  });

  test('adopts the hand state (node-b=1 · aws1=5) instead of fighting it; restore node-b → 5, aws1 left', async () => {
    const s = setup(seed); config = { 'node-b': 1, 'aws1': 5 };
    await walk(every(s.shift('2026-11-25T15:00:00Z'), s.shift('2026-11-25T16:00:00Z'), 20));
    expect(readAudit(resRoot()).filter(r => r.to !== undefined)).toHaveLength(0);
    expect(readAudit(resRoot()).filter(r => r.adopt !== undefined)).toHaveLength(2);
    publish(s.shift('2026-11-25T21:00:00Z').toISOString());
    await walk([s.shift('2026-11-25T21:10:00Z'), s.shift('2026-11-25T21:20:00Z')]);
    expect(config).toEqual({ 'node-b': 5, 'aws1': 5 });
  });

  test('publish slips past 06:00: hold + one slip card; publish at +50m → restore', async () => {
    const s = setup(seed);
    await walk(every(s.shift('2026-11-25T17:00:00Z'), s.shift('2026-11-25T21:45:00Z'), 5));
    expect(config['node-b']).toBe(1);
    expect(cards.filter(c => c.includes('slipped'))).toHaveLength(1);
    publish(s.shift('2026-11-25T21:50:00Z').toISOString());
    await walk([s.shift('2026-11-25T21:52:00Z')]);
    expect(config['node-b']).toBe(5);
  });

  test('never published → timeout path (publishAt+2h) restores once with a card', async () => {
    const s = setup(seed);
    await walk(every(s.shift('2026-11-25T17:00:00Z'), s.shift('2026-11-25T23:30:00Z'), 10));
    expect(config).toEqual({ 'node-b': 5, 'aws1': 2 });
    expect(cards.filter(c => c.includes('window closed without publish'))).toHaveLength(1);
    expect(runs.some(r => r.includes('passed → abort-restore'))).toBe(true);
    expect(updates).toBe(0);
  });

  test('rehearsal fails: reservation stays (cut still needs node-b); release hard-stop → restore after 30m + card', async () => {
    const s = setup(seed); rehearsal = { kind: 'rehearsal', hardStop: { at: s.shift('2026-11-25T15:40:00Z').toISOString() }, steps: {} };
    await walk(every(s.shift('2026-11-25T15:00:00Z'), s.shift('2026-11-25T18:00:00Z'), 15));
    expect(config['node-b']).toBe(1);
    releaseState.hardStop = { at: s.shift('2026-11-25T19:10:00Z').toISOString(), by: 'REL', reason: 'cut failed' };
    await walk([s.shift('2026-11-25T19:15:00Z')]);
    expect(config['node-b']).toBe(1);
    await walk([s.shift('2026-11-25T19:30:00Z'), s.shift('2026-11-25T19:41:00Z'), s.shift('2026-11-25T19:50:00Z')]);
    expect(config['node-b']).toBe(5);
    expect(cards.filter(c => c.includes('without publish'))).toHaveLength(1);
  });

  test('aws1 lease expires mid-window → re-fire → capacity requested once (local first), no paid start', async () => {
    const s = setup(seed);
    await walk(every(s.shift('2026-11-25T17:00:00Z'), s.shift('2026-11-25T18:00:00Z'), 10));
    expect(capacityAsks).toHaveLength(0);
    leases = [{ host: 'aws1', state: 'stopped' }];
    await walk(every(s.shift('2026-11-25T18:10:00Z'), s.shift('2026-11-25T19:00:00Z'), 10));
    expect(capacityAsks).toHaveLength(1);
    expect(config).toEqual({ 'node-b': 1, 'aws1': 5 });
  });

  test('release host goes down → one card, slots unchanged', async () => {
    const s = setup(seed); up = false;
    await walk(every(s.shift('2026-11-25T17:00:00Z'), s.shift('2026-11-25T18:00:00Z'), 10));
    leases = [{ host: 'aws1', state: 'stopped' }]; await walk([s.shift('2026-11-25T18:10:00Z')]);
    expect(cards.filter(c => c.includes('not reachable'))).toHaveLength(1);
    expect(config['node-b']).toBe(1);
  });

  test('restore when slots were changed by hand meanwhile → that host is left + carded', async () => {
    const s = setup(seed);
    await walk([s.shift('2026-11-25T17:00:00Z')]);
    config['node-b'] = 3; // hand
    publish(s.shift('2026-11-25T21:00:00Z').toISOString());
    await walk([s.shift('2026-11-25T21:05:00Z')]);
    expect(config).toEqual({ 'node-b': 3, 'aws1': 2 });
    expect(cards.filter(c => c.includes('changed by hand'))).toHaveLength(1);
  });

  test('duplicate trigger fire (lock held) → busy no-op; replay of the same fire → no extra change', async () => {
    const s = setup(seed); clock = s.shift('2026-11-25T17:00:00Z'); flush();
    const d: TrafficDeps = { ...fake(), root: resRoot(), live: true, now: () => clock, facts: () => liveFacts(stateRoot(), seatState(), clock) };
    mkdirSync(join(resRoot(), 'release-traffic'), { recursive: true }); writeFileSync(join(resRoot(), 'release-traffic', '.lock'), '');
    expect(trafficTick(d).outcome).toBe('busy');
    expect(config['node-b']).toBe(5);
    rmSync(join(resRoot(), 'release-traffic', '.lock'));
    trafficTick(d); trafficTick(d); trafficTick(d);
    expect(readAudit(resRoot()).filter(r => r.to !== undefined)).toHaveLength(2);
  });

  test('process restart mid-window (fresh registry handle + node state on disk) → no double fire, no rewrite', async () => {
    const s = setup(seed);
    await walk(every(s.shift('2026-11-25T17:00:00Z'), s.shift('2026-11-25T18:00:00Z'), 10));
    const firesBefore = listFires(db, 'release-traffic', 100).length; const auditBefore = readAudit(resRoot()).length;
    db.close(); db = openTriggerRegistry(stateRoot());
    await walk(every(s.shift('2026-11-25T18:10:00Z'), s.shift('2026-11-25T20:00:00Z'), 10));
    expect(listFires(db, 'release-traffic', 100).length).toBe(firesBefore);
    expect(readAudit(resRoot()).length).toBe(auditBefore);
  });
});

describe.each(SEEDS)('SIM compound condition edges seed %i', (seed) => {
  const when = parseWhen({ any: [{ all: [{ time: { after: 'release.cutAt - 2h' } }, { event: 'release.graph.state', equals: 'rehearsal-passed' }] }],
    timeout: { after: 'release.publishAt + 30m', then: 'abort-restore' } });
  const ev = (facts: Record<string, string | boolean | null>) => evaluatePredicate(when, { ...probes(), facts: () => facts }, { expand: x => x, sinceIso: '' });
  const s = sched(seed);
  const base = { 'release.version': V, 'release.cutAt': s.cutAt, 'release.publishAt': s.publishAt };

  test('event arrives before the time window → not met until the time; key stable', async () => {
    clock = s.shift('2026-11-25T16:00:00Z');
    expect((await ev({ ...base, 'release.graph.state': 'rehearsal-passed' })).met).toBe(false);
    clock = s.shift('2026-11-25T17:00:00Z'); const a = await ev({ ...base, 'release.graph.state': 'rehearsal-passed' });
    clock = s.shift('2026-11-25T17:30:00Z'); const b = await ev({ ...base, 'release.graph.state': 'rehearsal-passed' });
    expect(a.met && b.met).toBe(true); expect(a.key).toBe(b.key);
    expect(a.evidence).toContain('✓');
  });
  test('time passes with the event missing → timeout path', async () => {
    clock = s.shift('2026-11-25T21:31:00Z'); const r = await ev({ ...base, 'release.graph.state': 'rehearsal-started' });
    expect(r.met).toBe(true); expect(r.key).toContain('timeout:abort-restore@');
  });
  test('event flaps (passed → started → passed) → same key, registry dedupe = one fire', async () => {
    clock = s.shift('2026-11-25T17:10:00Z');
    const k1 = (await ev({ ...base, 'release.graph.state': 'rehearsal-passed' })).key;
    expect((await ev({ ...base, 'release.graph.state': 'rehearsal-started' })).met).toBe(false);
    expect((await ev({ ...base, 'release.graph.state': 'rehearsal-passed' })).key).toBe(k1);
  });
  test('clock skew (now jumps back then forward) → key = resolved instant, unchanged', async () => {
    clock = s.shift('2026-11-25T17:05:00Z'); const k1 = (await ev({ ...base, 'release.graph.state': 'rehearsal-passed' })).key;
    clock = s.shift('2026-11-25T16:50:00Z'); expect((await ev({ ...base, 'release.graph.state': 'rehearsal-passed' })).met).toBe(false);
    clock = s.shift('2026-11-25T17:20:00Z'); expect((await ev({ ...base, 'release.graph.state': 'rehearsal-passed' })).key).toBe(k1);
  });
  test('missing fact → time unresolved, never met (no guessed clock)', async () => {
    clock = s.shift('2026-11-25T23:00:00Z');
    expect((await ev({ 'release.version': null, 'release.graph.state': 'idle' })).met).toBe(false);
  });
});

describe('SIM registry: two edges inside one minute window', () => {
  test('the second edge is deferred to the next tick, not lost', async () => {
    const s = setup(1);
    await walk([s.shift('2026-11-25T17:00:10Z')]);
    expect(config['node-b']).toBe(1);
    publish(s.shift('2026-11-25T17:00:20Z').toISOString());
    await walk([s.shift('2026-11-25T17:00:40Z')]);
    expect(config['node-b']).toBe(1);
    await walk([s.shift('2026-11-25T17:01:05Z')]);
    expect(config['node-b']).toBe(5);
  });
});
