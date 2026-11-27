// 수호자 — rotating maintenance windows (CEO 11-27 11:3x «머신 자원들은 정비 작업을 위해 2시간씩 유휴 시간»).
import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAINTENANCE_POLICY, inMaintenance, maintStateOf, overlapsCut, planMaintenance, POOL, resolveMaintenancePolicy, runMaintenanceTick, scheduleLines, type MaintHostIn, type MaintPorts, type MaintState } from './maintenance.js';
import { maintStateEvent } from './maintenance.js';
import { resolveFacts } from '../kit/resource-facts/facts.js';
import { hostsFor } from '../kit/resource-facts/route.js';

const P = DEFAULT_MAINTENANCE_POLICY;
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
const H = (host: string, state: MaintState = POOL, o: Partial<MaintHostIn> = {}): MaintHostIn => ({ host, state, inFlight: 0, onlyGateLease: false, healthy: true, ...o });
const doneAt = (d: Date, hoursAgo: number) => new Date(d.getTime() - hoursAgo * 3_600_000).toISOString();

describe('maintenance policy', () => {
  test('code defaults: every 24 h · 2 h block · T-15 · cut 03:00–06:30 · defer ≤ 2 · dry until apply', () => {
    expect(resolveMaintenancePolicy(null)).toEqual(P);
    // Source: #40411 — the CEO cadence: every 24 h · 2 h block · cut 03:00–06:30 · defer ≤ 2
    expect(P).toMatchObject({ everyH: 24, blockH: 2, leadMin: 15, cutStart: '03:00', cutEnd: '06:30', maxDefers: 2, apply: false });
    expect(resolveMaintenancePolicy({ everyH: 12, cutStart: '25:00', apply: true, hosts: { 'mbp': { everyH: 48 }, 'bad host': { skip: true } } }))
      .toEqual({ ...P, everyH: 12, apply: true, hosts: { 'mbp': { everyH: 48 } } });
  });

  test('cut window overlap (local time)', () => {
    expect(overlapsCut(local(2026, 11, 27, 1, 0).getTime(), local(2026, 11, 27, 3, 15).getTime(), P)).toBe(true);
    expect(overlapsCut(local(2026, 11, 27, 6, 30).getTime(), local(2026, 11, 27, 8, 45).getTime(), P)).toBe(false);
    expect(overlapsCut(local(2026, 11, 27, 23, 0).getTime(), local(2026, 11, 28, 1, 15).getTime(), P)).toBe(false);
    expect(overlapsCut(local(2026, 11, 27, 2, 0).getTime(), local(2026, 11, 27, 2, 59).getTime(), P)).toBe(false);
  });
});

describe('planMaintenance', () => {
  const now = local(2026, 11, 27, 13, 0);

  test('the most overdue host drains (T-15 · 2 h block) — one at a time', () => {
    const a = planMaintenance([H('node-b', { ...POOL, lastDoneAt: doneAt(now, 25) }), H('minim5', { ...POOL, lastDoneAt: doneAt(now, 30) }), H('mbp', { ...POOL, lastDoneAt: doneAt(now, 2) })], now, P);
    expect(a.map(x => [x.host, x.kind])).toEqual([['minim5', 'drain']]);
    expect(a[0]!.next).toMatchObject({ phase: 'draining', windowStart: new Date(now.getTime() + 15 * 60_000).toISOString(), windowEnd: new Date(now.getTime() + 135 * 60_000).toISOString() });
    // another host already out → nobody else drains
    const b = planMaintenance([H('node-b', { phase: 'maintenance', defers: 0, windowStart: now.toISOString(), windowEnd: doneAt(now, -1) }), H('minim5', { ...POOL, lastDoneAt: doneAt(now, 30) }), H('mbp')], now, P);
    expect(b).toEqual([]);
  });

  test('never overlaps the cut window (wait, not a defer)', () => {
    const t = local(2026, 11, 27, 1, 30);
    const a = planMaintenance([H('node-b'), H('minim5', { ...POOL, lastDoneAt: doneAt(t, 1) }), H('mbp', { ...POOL, lastDoneAt: doneAt(t, 1) })], t, P);
    expect(a.map(x => [x.host, x.kind])).toEqual([['node-b', 'wait']]);
    expect(a[0]!.why).toContain('cut window');
  });

  test('the only gate lease is never taken — not even after the defers run out', () => {
    const a = planMaintenance([H('node-b', { ...POOL, defers: 2 }, { onlyGateLease: true }), H('minim5', { ...POOL, lastDoneAt: doneAt(now, 1) }), H('mbp', { ...POOL, lastDoneAt: doneAt(now, 1) })], now, P);
    expect(a.map(x => [x.host, x.kind])).toEqual([['node-b', 'wait']]);
  });

  test('capacity tight → defer (1 h step) at most 2×, then forced', () => {
    const two = (s: MaintState) => [H('node-b', s), H('minim5', { ...POOL, lastDoneAt: doneAt(now, 1) }), H('mbp', { ...POOL, lastDoneAt: doneAt(now, 1) }, { healthy: false })];
    const d1 = planMaintenance(two(POOL), now, P);
    expect(d1.map(x => [x.kind, x.next.defers])).toEqual([['defer', 1]]);
    expect(planMaintenance(two(d1[0]!.next), new Date(now.getTime() + 30 * 60_000), P).map(x => x.kind)).toEqual(['wait']);
    const t2 = new Date(now.getTime() + 61 * 60_000);
    const d2 = planMaintenance(two(d1[0]!.next), t2, P);
    expect(d2.map(x => [x.kind, x.next.defers])).toEqual([['defer', 2]]);
    const f = planMaintenance(two(d2[0]!.next), new Date(t2.getTime() + 61 * 60_000), P);
    expect(f.map(x => [x.kind, x.next.phase, x.next.forced])).toEqual([['drain', 'draining', true]]);
  });

  test('draining → begin once in-flight work is 0 · still busy at window end → cancel (counted)', () => {
    const s: MaintState = { phase: 'draining', defers: 0, windowStart: now.toISOString(), windowEnd: doneAt(now, -2) };
    expect(planMaintenance([H('node-b', s, { inFlight: 2 })], now, P)).toEqual([]);
    expect(planMaintenance([H('node-b', s)], now, P).map(x => [x.kind, x.next.phase])).toEqual([['begin', 'maintenance']]);
    expect(planMaintenance([H('node-b', s, { inFlight: 1 })], new Date(now.getTime() + 2 * 3_600_000), P).map(x => [x.kind, x.next.phase, x.next.defers])).toEqual([['cancel', 'pool', 1]]);
  });

  test('maintenance → finish at window end (holdFullBlock) or as soon as healthy (holdFullBlock false)', () => {
    const s: MaintState = { phase: 'maintenance', defers: 1, windowStart: now.toISOString(), windowEnd: doneAt(now, -1) };
    expect(planMaintenance([H('node-b', s)], now, P)).toEqual([]);
    expect(planMaintenance([H('node-b', s)], now, { ...P, holdFullBlock: false }).map(x => [x.kind, x.next.phase, x.next.defers])).toEqual([['finish', 'pool', 0]]);
    expect(planMaintenance([H('node-b', s)], new Date(now.getTime() + 3_600_000), P).map(x => x.next.lastDoneAt)).toEqual([new Date(now.getTime() + 3_600_000).toISOString()]);
  });

  test('per-host skip / cadence from policy', () => {
    const pol = resolveMaintenancePolicy({ hosts: { 'node-b': { skip: true }, 'minim5': { everyH: 48 } } });
    expect(planMaintenance([H('node-b'), H('minim5', { ...POOL, lastDoneAt: doneAt(now, 30) })], now, pol)).toEqual([]);
  });
});

describe('routing + world row', () => {
  test('a host in a window is out of kit/resource-facts routing (draining and maintenance) · pool rows are untouched', () => {
    const at = '2026-11-27T04:00:00.000Z';
    const row = (host: string, phase: 'pool' | 'draining' | 'maintenance') => {
      const e = maintStateEvent(host, { phase, defers: 0 }, at);
      return { id: e.actor.id, kind: 'host', host, declaredState: 'live', state: 'live', reason: null, meta: e.actor.meta ?? {} };
    };
    const facts = resolveFacts({ actors: [row('node-b', 'draining'), row('minim5', 'pool'), row('mbp', 'maintenance')], policy: null });
    expect(hostsFor('pregate', { facts })).toEqual(['minim5', 'node-c']);
    expect(row('minim5', 'pool').meta.health).toBeUndefined();
    expect(inMaintenance({ maintenance: { phase: 'pool' } })).toBe(false);
    expect(maintStateOf({ maintenance: 'junk' })).toEqual(POOL);
  });

  test('schedule lines for `eln loop guardian world`', () => {
    const now = local(2026, 11, 27, 13, 0);
    const lines = scheduleLines([H('node-b', { ...POOL, lastDoneAt: doneAt(now, 20) }), H('minim5', { phase: 'draining', defers: 0, windowStart: local(2026, 11, 27, 13, 15).toISOString(), windowEnd: local(2026, 11, 27, 15, 15).toISOString() }), H('mbp')], now, P);
    expect(lines).toEqual(['node-b     pool        next window in 4h · last 17:00', 'minim5   draining    13:15–15:15', 'mbp      pool        next window due now · never']);
  });
});

describe('runMaintenanceTick', () => {
  test('begin runs the steps (destructive ones dry until apply) + orphan reap, saves state, one digest line', () => {
    const now = local(2026, 11, 27, 13, 0);
    const saved: Array<[string, string]> = []; const cmds: string[] = []; const digest: string[] = [];
    const ports: MaintPorts = {
      policy: () => P,
      hosts: () => [H('node-b', { phase: 'draining', defers: 0, windowStart: now.toISOString(), windowEnd: doneAt(now, -2) })],
      save: (h, s) => { saved.push([h, s.phase]); },
      run: (_h, c) => { cmds.push(c); return { ok: true, out: '3' }; },
      reap: () => 'reaped 0',
      digest: (l) => { digest.push(l); },
    };
    const r = runMaintenanceTick(ports, now);
    expect(saved).toEqual([['node-b', 'maintenance']]);
    expect(cmds.some(c => c.includes('worktree prune -n'))).toBe(true); // dry
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false); // destructive step not applied
    expect(digest).toHaveLength(1);
    expect(digest[0]).toContain('[정비] node-b begin');
    expect(digest[0]).toContain('orphans reaped 0');
    expect(r.lines).toEqual(digest);
    const applied: string[] = [];
    runMaintenanceTick({ ...ports, policy: () => ({ ...P, apply: true }), run: (_h, c) => { applied.push(c); return { ok: true, out: '' }; } }, now);
    expect(applied.some(c => c.includes('branch -d'))).toBe(true);
  });
});
