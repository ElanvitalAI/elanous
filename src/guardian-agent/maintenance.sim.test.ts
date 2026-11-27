// Sim — rotating maintenance windows over 3 days of 2-min pulses (CEO 11-27 11:3x): the rotation never drops the pool below
// need, never overlaps the cut window, takes at most one host out at a time, and services every host.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAINTENANCE_POLICY, overlapsCut, planMaintenance, POOL, type MaintenancePolicy, type MaintHostIn, type MaintState } from './maintenance.js';

interface SimHost { host: string; state: MaintState; inFlight: number; healthy: boolean; gate: boolean }

function simulate(hosts: SimHost[], p: MaintenancePolicy, days: number, seed: number) {
  let r = seed; const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const t0 = new Date(2026, 10, 27, 9, 0).getTime();
  const log = { mostOut: 0, leastPool: Number.POSITIVE_INFINITY, cutHits: 0, windows: new Map<string, number>(), forced: 0, defers: 0, defersPeak: 0 };
  for (let t = t0; t < t0 + days * 24 * 3_600_000; t += 2 * 60_000) {
    const now = new Date(t);
    for (const h of hosts) {
      if (h.state.phase === 'pool' && rnd() < 0.2) h.inFlight = Math.min(4, h.inFlight + 1); // new work only in the pool
      if (h.inFlight > 0 && rnd() < 0.3) h.inFlight -= 1;                                   // in-flight runs finish
    }
    const view: MaintHostIn[] = hosts.map(h => ({ host: h.host, state: h.state, inFlight: h.inFlight, onlyGateLease: h.gate, healthy: h.healthy }));
    for (const a of planMaintenance(view, now, p)) {
      const h = hosts.find(x => x.host === a.host)!;
      if (a.kind === 'drain') {
        log.windows.set(a.host, (log.windows.get(a.host) ?? 0) + 1);
        if (a.next.forced) log.forced++;
        if (overlapsCut(t, Date.parse(a.next.windowEnd!), p)) log.cutHits++;
      }
      if (a.kind === 'defer') { log.defers++; log.defersPeak = Math.max(log.defersPeak, a.next.defers); }
      h.state = a.next;
    }
    const out = hosts.filter(h => h.state.phase !== 'pool').length;
    const pool = hosts.filter(h => h.state.phase === 'pool' && h.healthy).length;
    log.mostOut = Math.max(log.mostOut, out);
    if (!hosts.some(h => h.state.forced && h.state.phase !== 'pool')) log.leastPool = Math.min(log.leastPool, pool);
  }
  return log;
}

const fleet = (names: string[], o: Partial<SimHost> = {}): SimHost[] => names.map(host => ({ host, state: POOL, inFlight: 0, healthy: true, gate: false, ...o }));

describe('maintenance rotation sim (3 days · 2-min pulses)', () => {
  test('4 local hosts, need 2: one out at a time · pool ≥ need · no cut overlap · every host serviced ≥ 2× · nothing forced', () => {
    const log = simulate(fleet(['node-b', 'minim5', 'mbp', 'node-c']), DEFAULT_MAINTENANCE_POLICY, 3, 7);
    expect(log.mostOut).toBe(1);
    expect(log.leastPool).not.toBe(Number.POSITIVE_INFINITY);
    expect([2, 3, 4].includes(log.leastPool)).toBe(true); // need = 2 local hosts
    expect(log.cutHits).toBe(0);
    expect([...log.windows.keys()].sort()).toEqual(['mbp', 'node-c', 'minim5', 'node-b']);
    expect([...log.windows.values()].every(n => n >= 2)).toBe(true); // ≥ 2 windows per host in 3 days
    expect(log.forced).toBe(0);
  });

  test('tight capacity (2 healthy of 3, need 2): defers stop at 2, then the window is forced — still one at a time, no cut overlap', () => {
    const hosts = fleet(['node-b', 'minim5', 'mbp']);
    hosts[2]!.healthy = false;
    const log = simulate(hosts, DEFAULT_MAINTENANCE_POLICY, 3, 11);
    expect(log.defersPeak).toBe(2);
    expect(log.forced).not.toBe(0);
    expect(log.mostOut).toBe(1);
    expect(log.cutHits).toBe(0);
  });

  test('a host holding the only gate lease is never drained', () => {
    const hosts = fleet(['node-b', 'minim5', 'mbp', 'node-c']);
    hosts[0]!.gate = true;
    const log = simulate(hosts, DEFAULT_MAINTENANCE_POLICY, 2, 3);
    expect(log.windows.get('node-b') ?? 0).toBe(0);
    expect(log.windows.get('minim5') ?? 0).not.toBe(0);
  });
});
