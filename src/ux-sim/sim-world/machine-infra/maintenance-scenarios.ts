// SIM-WORLD machine-infra · rotating maintenance windows (CEO 11-27 11:3x «머신 자원들은 정비 작업을 위해 2시간씩 유휴 시간»).
// The real planner / tick / world-row save against an isolated lease ledger; time is simulated (2-min pulses), ssh is injected.
// Expectations are literals (pool need 2 · one host out · no cut overlap · defer 2 then force · first window times).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeHostFacts } from '../../../guardian-agent/hosts.js';
import { readResourceLedger } from '../../../resource-ledger/resource-ledger.js';
import { foldWorld } from '../../../resource-ledger/world-registry.js';
import { resolveFacts } from '../../../kit/resource-facts/facts.js';
import { hostsFor } from '../../../kit/resource-facts/route.js';
import { DEFAULT_MAINTENANCE_POLICY, overlapsCut, planMaintenance, POOL, runMaintenanceTick, saveMaintState, type MaintHostIn, type MaintState } from '../../../guardian-agent/maintenance.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, detail: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const P = DEFAULT_MAINTENANCE_POLICY;
const TICK = 2 * 60_000;

interface Host { host: string; state: MaintState; inFlight: number; healthy: boolean; gate: boolean }
const fleet = (names: readonly string[]): Host[] => names.map(host => ({ host, state: POOL, inFlight: 0, healthy: true, gate: false }));

function rotate(hosts: Host[], startMs: number, minutes: number, random: () => number) {
  const out = { mostOut: 0, leastPool: Number.POSITIVE_INFINITY, cutHits: 0, windows: {} as Record<string, number>, forced: 0, defersPeak: 0, firstDrainAt: null as number | null };
  for (let t = startMs; t < startMs + minutes * 60_000; t += TICK) {
    for (const h of hosts) {
      if (h.state.phase === 'pool' && random() < 0.25) h.inFlight = Math.min(5, h.inFlight + 1);
      if (h.inFlight > 0 && random() < 0.35) h.inFlight -= 1;
    }
    const view: MaintHostIn[] = hosts.map(h => ({ host: h.host, state: h.state, inFlight: h.inFlight, onlyGateLease: h.gate, healthy: h.healthy }));
    for (const a of planMaintenance(view, new Date(t), P)) {
      const h = hosts.find(x => x.host === a.host)!;
      if (a.kind === 'drain') {
        out.windows[a.host] = (out.windows[a.host] ?? 0) + 1;
        if (out.firstDrainAt === null) out.firstDrainAt = t;
        if (a.next.forced) out.forced++;
        if (overlapsCut(t, Date.parse(a.next.windowEnd!), P)) out.cutHits++;
      }
      if (a.kind === 'defer') out.defersPeak = Math.max(out.defersPeak, a.next.defers);
      h.state = a.next;
    }
    out.mostOut = Math.max(out.mostOut, hosts.filter(h => h.state.phase !== 'pool').length);
    if (!hosts.some(h => h.state.forced && h.state.phase !== 'pool')) out.leastPool = Math.min(out.leastPool, hosts.filter(h => h.state.phase === 'pool' && h.healthy).length);
  }
  return out;
}

/** normal — 4 local hosts over 3 days: one out at a time · pool ≥ 2 · no cut overlap · every host ≥ 2 windows · nothing forced. */
const rotation: SimWorldScenario = {
  id: 'MAINT-ROTATION', title: 'windows rotate over 4 hosts for 3 days without dropping the pool below 2 or touching the cut window',
  async run(ctx) {
    const start = new Date(2026, 10, 27, 7 + Math.floor(ctx.random() * 10), 0).getTime();
    const o = rotate(fleet(['node-b', 'minim5', 'mbp', 'node-c']), start, 3 * 24 * 60, ctx.random);
    ctx.recorder.event('maint-rotation', { ...o, leastPool: o.leastPool });
    const counts = Object.values(o.windows);
    return o.mostOut === 1 && o.leastPool === 3 && o.cutHits === 0 && counts.length === 4 && counts.every(n => n >= 2) && o.forced === 0
      ? { ok: true } : fail('rotation broke a capacity or cut rule', o);
  },
};

/** edge — tight capacity (2 healthy of 3): defers stop at 2, then forced; still one at a time, no cut overlap. */
const tight: SimWorldScenario = {
  id: 'MAINT-TIGHT-FORCE', title: 'tight capacity defers a window at most twice, then forces it (one host at a time, cut window respected)',
  async run(ctx) {
    const hosts = fleet(['node-b', 'minim5', 'mbp']);
    hosts[Math.floor(ctx.random() * 3)]!.healthy = false;
    const o = rotate(hosts, new Date(2026, 10, 27, 9, 0).getTime(), 2 * 24 * 60, ctx.random);
    ctx.recorder.event('maint-tight', o);
    return o.defersPeak === 2 && o.forced >= 1 && o.mostOut === 1 && o.cutHits === 0 ? { ok: true } : fail('defer/force contract broken', o);
  },
};

/** edge — the cut window (03:00–06:30) is never overlapped: the first window starts at a literal time for each start. */
const cutWindow: SimWorldScenario = {
  id: 'MAINT-CUT-WINDOW', title: 'a due host waits out the cut window — the first window opens at the literal expected time',
  async run(ctx) {
    const cases = [
      { start: [0, 44], first: [0, 44] },   // ends 02:59 — before the cut
      { start: [1, 30], first: [6, 30] },
      { start: [2, 50], first: [6, 30] },
      { start: [5, 0], first: [6, 30] },
      { start: [6, 0], first: [6, 30] },
      { start: [9, 0], first: [9, 0] },
    ] as const;
    const c = cases[Math.floor(ctx.random() * cases.length) % cases.length]!;
    const start = new Date(2026, 10, 28, c.start[0], c.start[1]).getTime();
    const o = rotate(fleet(['node-b', 'minim5', 'mbp', 'node-c']), start, 12 * 60, () => 0.9); // no new work → drains at once
    const want = new Date(2026, 10, 28, c.first[0], c.first[1]).getTime();
    ctx.recorder.event('maint-cut', { start: c.start, first: o.firstDrainAt === null ? null : new Date(o.firstDrainAt).toTimeString().slice(0, 5), cutHits: o.cutHits });
    return o.firstDrainAt === want && o.cutHits === 0 ? { ok: true } : fail('first window at the wrong time / overlapped the cut', { want: c.first, got: o.firstDrainAt && new Date(o.firstDrainAt).toTimeString().slice(0, 5), cutHits: o.cutHits });
  },
};

/** fault — a failing ssh step and a throwing reaper never break the tick: state is saved, the digest names each FAIL. */
const stepFault: SimWorldScenario = {
  id: 'MAINT-STEP-FAULT', title: 'injected step failures (ssh error · throw · reaper crash) are reported in the digest; the window still begins',
  async run(ctx) {
    const ids = ['worktrees', 'branches', 'docker', 'build-cache', 'tmp', 'disk'] as const;
    const bad = ids[Math.floor(ctx.random() * ids.length) % ids.length]!;
    const mode = ctx.random() < 0.5 ? 'error' : 'throw';
    const now = new Date(2026, 10, 27, 13, 0);
    const saved: string[] = []; const digest: string[] = [];
    let threw = '';
    try {
      runMaintenanceTick({
        policy: () => P,
        hosts: () => [{ host: 'minim5', state: { phase: 'draining', defers: 0, windowStart: now.toISOString(), windowEnd: new Date(now.getTime() + 2 * 3_600_000).toISOString() }, inFlight: 0, onlyGateLease: false, healthy: true }],
        save: (h, s) => { saved.push(`${h}:${s.phase}`); },
        run: (_h, cmd) => {
          const isBad = (bad === 'worktrees' && cmd.includes('worktree prune')) || (bad === 'branches' && cmd.includes('branch --merged')) || (bad === 'docker' && cmd.includes('docker'))
            || (bad === 'build-cache' && cmd.includes('.bun/install/cache')) || (bad === 'tmp' && cmd.includes('find /tmp')) || (bad === 'disk' && cmd.includes('df -Pk'));
          if (isBad && mode === 'throw') throw new Error('ssh: connection reset');
          return isBad ? { ok: false, out: 'exit 255' } : { ok: true, out: '1' };
        },
        reap: () => { throw new Error('reaper unavailable'); },
        digest: (l) => { digest.push(l); },
      }, now);
    } catch (e) { threw = (e as Error).message; }
    ctx.recorder.event('maint-step-fault', { bad, mode, saved, digest, threw });
    const line = digest[0] ?? '';
    const want = bad === 'disk' ? 'disk FAIL' : `${bad}(dry) FAIL`; // disk has no dry form
    return threw === '' && JSON.stringify(saved) === JSON.stringify(['minim5:maintenance']) && digest.length === 1
      && line.includes(want) && line.includes('orphans FAIL reaper unavailable')
      ? { ok: true } : fail('a step fault broke the tick or vanished from the digest', { bad, mode, saved, digest, threw });
  },
};

/** normal — the state round-trips through the host's world row: a draining host leaves routing, back in pool it returns. */
const worldRow: SimWorldScenario = {
  id: 'MAINT-WORLD-ROW', title: 'maintenance state lives in the world row: draining/maintenance → out of resource-facts routing; pool + next pulse → back in',
  async run(ctx) {
    const dir = join(ctx.universeRoot, 'resource-ledger'); mkdirSync(dir, { recursive: true });
    const path = join(dir, 'events.jsonl'); writeFileSync(path, '');
    const host = (['node-b', 'minim5', 'mbp'] as const)[Math.floor(ctx.random() * 3) % 3]!;
    const at = '2026-11-27T04:00:00.000Z';
    const pool0 = ['minim5', 'mbp', 'node-b']; // resource-facts gate order (policy defaults)
    // the 임대관 already wrote every host's facts row (as each pulse does)
    writeHostFacts(pool0.map(h => ({ host: h, reachable: true, load1: 2, ncpu: 16 })), new Date(at), path);
    const seen: string[][] = [];
    for (const phase of ['draining', 'maintenance', 'pool'] as const) {
      saveMaintState(host, phase === 'pool' ? { phase, defers: 0, lastDoneAt: at } : { phase, defers: 0, windowStart: at, windowEnd: at }, at, path);
      if (phase === 'pool') writeHostFacts(pool0.map(h => ({ host: h, reachable: true, load1: 2, ncpu: 16 })), new Date(Date.parse(at) + 2 * 60_000), path); // the next pulse
      const now = new Date(Date.parse(at) + 3 * 60_000);
      seen.push(hostsFor('pregate', { facts: resolveFacts({ actors: foldWorld(readResourceLedger(path), now).actors, policy: null, now }) }).filter(h => pool0.includes(h)));
    }
    const out = pool0.filter(h => h !== host);
    ctx.recorder.event('maint-world-row', { host, seen });
    return JSON.stringify(seen) === JSON.stringify([out, out, pool0]) ? { ok: true } : fail('world-row maintenance state did not gate routing', { host, seen, want: [out, out, pool0] });
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [rotation, tight, cutWindow, stepFault, worldRow];
