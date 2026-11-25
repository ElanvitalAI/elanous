/**
 * SIM world — RES ready pool · burst lease · release reservation on a virtual clock with a fake actuator
 * (RES-READY-POOL-RESERVATION · 대표 11-25 22:3x «resource-kingdom graphs first»). Edges: host never ready, catch-up
 * fails, ssh late boot (sanitize retries inside the actuator — sim = slow ok), ttl expiry mid-pregate, release phase
 * overlap, budget hit, adopted hand lease. Seeds ≥ 3 vary the host order and failing step.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLease, dueLeases, loadLeases, markReady, loadReady, loadReservation, markRequesterDone, permitPath, releasePhase, requestLease,
  staleHosts } from './burst.js';
import { runNode, type NodeContext, type NodeDeps } from './res-nodes.js';
import { evaluatePredicate, parsePredicate, type ConditionProbes } from '../loops/trigger-conditions.js';

let dir: string; let seat: string; let state: string; let clock: Date;
let calls: string[]; let failStep: string | null; let inflight: number;

const deps = (): NodeDeps => ({
  now: () => clock,
  actuate: (step, host) => {
    calls.push(`${step}:${host}`);
    if (step === 'inflight') return { status: 0, stdout: `${inflight}\n`, stderr: '' };
    return step === failStep ? { status: 1, stdout: '', stderr: `${step} failed (sim)` } : { status: 0, stdout: '{"ok":true}\n', stderr: '' };
  },
});
const ctx = (graphId: string, runId: string, stage = 'live', nodeInput: Record<string, unknown> = {}): NodeContext =>
  ({ graphId, runId, input: { window: `w-${runId}`, stage, vars: { seatState: seat, stateRoot: state } }, nodeInput });
const root = () => join(seat, 'RES', 'graph-state');

/** Walk a graph's edges with the node runner (the registry's runner does the same in live). */
function walk(graphId: string, runId: string, entry: string, edges: Record<string, Record<string, string>>, recipe: Record<string, string>, stage = 'live'): string[] {
  const path: string[] = []; let node = entry;
  for (let i = 0; i < 30 && node !== 'done' && node !== 'failed'; i++) {
    const out = runNode(recipe[node]!, ctx(graphId, runId, stage), deps());
    path.push(`${node}=${out.outcome}`);
    node = edges[node]![out.outcome] ?? 'failed';
  }
  path.push(node);
  return path;
}

const READY_EDGES = { pick: { picked: 'start', none: 'mark', shadow: 'mark' }, start: { ok: 'sanitize', fail: 'fail' }, sanitize: { ok: 'catchup', fail: 'fail' },
  catchup: { ok: 'auth', fail: 'fail' }, auth: { ok: 'smoke', fail: 'fail' }, smoke: { ok: 'ready', fail: 'fail' }, ready: { ok: 'stop' }, stop: { ok: 'mark', fail: 'failed' },
  fail: { ok: 'failed' }, mark: { ok: 'done' } };
const READY_RECIPE = { pick: 'ready-pick', start: 'step:start', sanitize: 'step:sanitize', catchup: 'step:catchup', auth: 'step:auth', smoke: 'step:smoke',
  ready: 'ready-mark', stop: 'run-stop', fail: 'run-fail', mark: 'window-done' };
const LEASE_EDGES = { route: { activate: 'start', drain: 'drain', none: 'mark' }, start: { ready: 'register', stale: 'sanitize', fail: 'failed' },
  sanitize: { ok: 'catchup', fail: 'fail' }, catchup: { ok: 'auth', fail: 'fail' }, auth: { ok: 'smoke', fail: 'fail' }, smoke: { ok: 'ready', fail: 'fail' },
  ready: { ok: 'register' }, register: { ok: 'mark' }, drain: { wait: 'mark', stop: 'stop' }, stop: { ok: 'mark', fail: 'failed' }, fail: { ok: 'failed' }, mark: { ok: 'done' } };
const LEASE_RECIPE = { route: 'lease-route', start: 'lease-start', sanitize: 'step:sanitize', catchup: 'step:catchup', auth: 'step:auth', smoke: 'step:smoke',
  ready: 'ready-mark', register: 'lease-register', drain: 'lease-drain', stop: 'run-stop', fail: 'run-fail', mark: 'window-done' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'res-graphs-sim-')); seat = join(dir, 'seat'); state = join(dir, 'state');
  mkdirSync(seat, { recursive: true }); mkdirSync(state, { recursive: true });
  clock = new Date('2026-11-25T13:00:00Z'); calls = []; failStep = null; inflight = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const probes = (): ConditionProbes => ({ now: () => clock, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0, publishedVersions: async () => [], installedVersion: async () => null });
const expand = (s: string) => s.replaceAll('{seatState}', seat).replaceAll('{stateRoot}', state);

describe('ready pool', () => {
  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}: never-ready hosts are made ready one per run, each stopped; the predicate goes quiet`, async () => {
      const hosts = ['aws1', 'aws2', 'gcp1', 'gcp2', 'gcp3'].slice(0, seed + 1);
      const pred = parsePredicate({ kind: 'res', check: 'ready-stale', hosts, max_age_days: 7 });
      for (let i = 0; i < hosts.length; i++) {
        const r = await evaluatePredicate(pred, probes(), { expand, sinceIso: clock.toISOString() });
        expect(r.met).toBe(true);
        const path = walk('res-ready-pool', `r${seed}-${i}`, 'pick', READY_EDGES, READY_RECIPE);
        expect(path.at(-1)).toBe('done');
        expect(calls.at(-1)).toBe(`stop:${hosts[i]}`);
      }
      expect((await evaluatePredicate(pred, probes(), { expand, sinceIso: clock.toISOString() })).met).toBe(false);
      expect(Object.values(loadReady(root())).every(r => r.state === 'ready')).toBe(true);
      expect(readFileSync(join(root(), 'BOARD.md'), 'utf8')).toContain('| aws1 | ready |');
      // 8 days later every host is stale again.
      clock = new Date(clock.getTime() + 8 * 86_400_000);
      expect(staleHosts(root(), hosts, 7, clock).length).toBe(hosts.length);
    });
  }

  for (const [seed, step] of [[1, 'catchup'], [2, 'sanitize'], [3, 'smoke']] as const) {
    test(`seed ${seed}: ${step} fails → host marked failed and STOPPED, permit revoked, lease not left live`, () => {
      failStep = step;
      const path = walk('res-ready-pool', `f${seed}`, 'pick', READY_EDGES, READY_RECIPE);
      expect(path).toContain(`${step}=fail`);
      expect(path.at(-1)).toBe('failed');
      expect(calls).toContain('stop:aws1');
      expect(loadReady(root()).aws1?.state).toBe('failed');
      expect(existsSync(permitPath(root(), 'aws1'))).toBe(false);
      expect(loadLeases(root()).every(l => l.state === 'failed')).toBe(true);
    });
  }

  test('shadow stage picks but never actuates or writes ready state', () => {
    const path = walk('res-ready-pool', 's1', 'pick', READY_EDGES, READY_RECIPE, 'shadow');
    expect(path).toEqual(['pick=shadow', 'mark=ok', 'done']);
    expect(calls).toEqual([]);
    expect(loadReady(root())).toEqual({});
  });

  test('catch-up runs with a graph-issued permit bound to the live lease (no hand-written REL file)', () => {
    let permitSeen: unknown = null;
    const d = deps(); const inner = d.actuate!;
    d.actuate = (s, h, l) => { if (s === 'catchup') permitSeen = JSON.parse(readFileSync(permitPath(root(), h), 'utf8')); return inner(s, h, l); };
    const c = (n: string, id = 'p1') => runNode(n, ctx('res-ready-pool', id), d);
    expect(c('ready-pick').outcome).toBe('picked');
    for (const s of ['step:start', 'step:sanitize', 'step:catchup']) expect(c(s).outcome).toBe('ok');
    expect(permitSeen).toMatchObject({ issuer: 'res-graph', host: 'aws1', graph: 'res-ready-pool' });
  });
});

describe('burst lease', () => {
  test('never-ready host: activation runs ready steps first, then registers; ttl expiry mid-pregate waits, then stops at ttl+15m', async () => {
    requestLease(root(), { host: 'aws2', ttlMin: 240, reason: 'sim', requester: 'OP' }, clock);
    const pred = parsePredicate({ kind: 'res', check: 'lease-due' });
    expect((await evaluatePredicate(pred, probes(), { expand, sinceIso: '' })).met).toBe(true);
    const a = walk('res-burst-lease', 'a1', 'route', LEASE_EDGES, LEASE_RECIPE);
    expect(a).toEqual(['route=activate', 'start=stale', 'sanitize=ok', 'catchup=ok', 'auth=ok', 'smoke=ok', 'ready=ok', 'register=ok', 'mark=ok', 'done']);
    expect(JSON.parse(readFileSync(join(root(), 'burst-hosts.json'), 'utf8'))).toEqual([expect.objectContaining({ host: 'aws2', pregateSlots: 2 })]);
    expect((await evaluatePredicate(pred, probes(), { expand, sinceIso: '' })).met).toBe(false);
    clock = new Date(clock.getTime() + 241 * 60_000); inflight = 1;
    expect(walk('res-burst-lease', 'd1', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=drain', 'drain=wait', 'mark=ok', 'done']);
    expect(JSON.parse(readFileSync(join(root(), 'burst-hosts.json'), 'utf8'))).toEqual([]); // no NEW pregate lands on it
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(walk('res-burst-lease', 'd2', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=drain', 'drain=wait', 'mark=ok', 'done']);
    clock = new Date(clock.getTime() + 11 * 60_000); // past ttl + 15m: stop even with inflight
    expect(walk('res-burst-lease', 'd3', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=drain', 'drain=stop', 'stop=ok', 'mark=ok', 'done']);
    expect(loadLeases(root())[0]!.state).toBe('stopped');
    expect(dueLeases(root(), clock)).toEqual([]);
  });

  test('ready host: activation skips the ready steps; requester done → drain → stop', () => {
    markReady(root(), 'gcp1', 'ready', 'sim verified', clock);
    requestLease(root(), { host: 'gcp1', ttlMin: 60, reason: 'sim', requester: 'OP' }, clock);
    expect(walk('res-burst-lease', 'b1', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=activate', 'start=ready', 'register=ok', 'mark=ok', 'done']);
    markRequesterDone(root(), 'gcp1', clock);
    expect(walk('res-burst-lease', 'b2', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=drain', 'drain=stop', 'stop=ok', 'mark=ok', 'done']);
  });

  test('budget hit drains without waiting for inflight', () => {
    requestLease(root(), { host: 'gcp2', ttlMin: 600, budgetUsd: 2, reason: 'sim', requester: 'OP', ratePerHourUsd: 1 }, clock);
    walk('res-burst-lease', 'g1', 'route', LEASE_EDGES, LEASE_RECIPE);
    clock = new Date(clock.getTime() + 121 * 60_000); inflight = 3;
    expect(walk('res-burst-lease', 'g2', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=drain', 'drain=stop', 'stop=ok', 'mark=ok', 'done']);
    expect(readFileSync(join(root(), 'receipts.jsonl'), 'utf8')).toContain('"spentUsd":2.02');
  });

  test('start failure → lease failed, no register; activation catch-up failure → host stopped', () => {
    requestLease(root(), { host: 'aws1', ttlMin: 60, reason: 'sim', requester: 'OP' }, clock);
    failStep = 'start';
    expect(walk('res-burst-lease', 'x1', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=activate', 'start=fail', 'failed']);
    expect(loadLeases(root())[0]!.state).toBe('failed');
    requestLease(root(), { host: 'aws1', ttlMin: 60, reason: 'sim2', requester: 'OP' }, new Date(clock.getTime() + 60_000));
    failStep = 'catchup'; calls = [];
    expect(walk('res-burst-lease', 'x2', 'route', LEASE_EDGES, LEASE_RECIPE).at(-1)).toBe('failed');
    expect(calls).toContain('stop:aws1');
  });

  test("adopted hand lease (tonight's aws1): active until ends-at, permit issued, drained by the graph at ends-at", () => {
    const l = adoptLease(root(), { host: 'aws1', startedAt: '2026-11-25T13:09:11Z', endsAt: '2026-11-25T17:09:11Z', reason: 'CEO 4h', requester: 'OP' }, clock);
    expect(l.state).toBe('active');
    expect(JSON.parse(readFileSync(permitPath(root(), 'aws1'), 'utf8'))).toMatchObject({ issuer: 'res-graph', leaseId: l.id });
    expect(() => requestLease(root(), { host: 'aws1', ttlMin: 60, reason: 'dup', requester: 'OP' }, clock)).toThrow(/already has lease/);
    expect(dueLeases(root(), clock)).toEqual([]);
    clock = new Date('2026-11-25T17:09:12Z');
    expect(walk('res-burst-lease', 'h1', 'route', LEASE_EDGES, LEASE_RECIPE)).toEqual(['route=drain', 'drain=stop', 'stop=ok', 'mark=ok', 'done']);
    expect(existsSync(permitPath(root(), 'aws1'))).toBe(false);
  });

  test('a leased host is never picked by the ready pool', () => {
    requestLease(root(), { host: 'aws1', ttlMin: 60, reason: 'sim', requester: 'OP' }, clock);
    expect(staleHosts(root(), ['aws1', 'aws2'], 7, clock).map(s => s.host)).toEqual(['aws2']);
  });
});

describe('release reservation', () => {
  const run = (v: string, clockDef: Record<string, string>, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(state, 'release-graph', v), { recursive: true });
    writeFileSync(join(state, 'release-graph', v, 'state.json'), JSON.stringify({ version: v, clock: clockDef, steps: {}, ...extra }));
  };
  test('pre-cut → window → idle transitions each fire once; reservation follows the release graph state', async () => {
    run('0.3.36', { rehearsalAt: '2026-11-25T13:00:00Z', cutAt: '2026-11-25T19:00:00Z', publishAt: '2026-11-25T21:00:00Z' });
    const pred = parsePredicate({ kind: 'res', check: 'release-phase' });
    const key = async () => (await evaluatePredicate(pred, probes(), { expand, sinceIso: '' })).key;
    const sync = () => runNode('reservation-sync', ctx('res-reservation', 'z'), deps());
    expect(await key()).toBe('res-phase:idle');
    clock = new Date('2026-11-25T17:30:00Z'); // cut − 90m
    expect(await key()).toBe('res-phase:reserved@0.3.36');
    expect(sync()).toMatchObject({ change: 'reserved', phase: 'pre-cut' });
    expect(loadReservation(root())).toMatchObject({ active: true, nonReleaseSlots: 1, host: 'node-b' });
    clock = new Date('2026-11-25T19:30:00Z');
    expect(await key()).toBe('res-phase:reserved@0.3.36'); // pre-cut → window keeps one key (no re-fire)
    expect(sync()).toMatchObject({ change: 'unchanged', phase: 'window' });
    clock = new Date('2026-11-25T21:46:00Z'); // publish + 46m: max_wait tail passed
    expect(await key()).toBe('res-phase:idle');
    expect(sync()).toMatchObject({ change: 'lifted' });
    expect(loadReservation(root())?.active).toBe(false);
  });

  test('overlap: a done/hard-stopped run or a rehearsal never reserves; the live release wins', () => {
    run('0.3.35', { cutAt: '2026-11-25T12:00:00Z', publishAt: '2026-11-25T14:00:00Z' }, { done: true });
    run('0.3.36', { cutAt: '2026-11-25T14:00:00Z', publishAt: '2026-11-25T16:00:00Z' });
    expect(releasePhase(state, clock)).toMatchObject({ phase: 'pre-cut', version: '0.3.36' });
    run('0.3.36', { cutAt: '2026-11-25T14:00:00Z', publishAt: '2026-11-25T16:00:00Z' }, { hardStop: { at: 'x', by: 'OP', reason: 'no-go' } });
    expect(releasePhase(state, clock).phase).toBe('idle');
  });

  test('shadow stage computes the phase without writing the reservation', () => {
    run('0.3.36', { cutAt: '2026-11-25T13:30:00Z', publishAt: '2026-11-25T15:00:00Z' });
    expect(runNode('reservation-sync', ctx('res-reservation', 's', 'shadow'), deps()).outcome).toBe('ok');
    expect(loadReservation(root())).toBeNull();
  });
});
