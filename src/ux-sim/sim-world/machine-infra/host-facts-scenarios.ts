// SIM-WORLD machine-infra · 임대관 host facts → WORLD-REGISTRY → kit/resource-facts routing (CEO 10:5x «machines must be routed
// by the ledger»). The real writer against a real lease ledger in the scenario's universe; routing through the real
// resource-facts resolver (pure, no cache). Each seed draws a case from a literal table — literal expectations only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeHostFacts, type HostProbe } from '../../../guardian-agent/hosts.js';
import { readResourceLedger, recordWorldEvents } from '../../../resource-ledger/resource-ledger.js';
import { foldWorld } from '../../../resource-ledger/world-registry.js';
import { resolveFacts } from '../../../kit/resource-facts/facts.js';
import { hostsFor } from '../../../kit/resource-facts/route.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, detail: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const ledgerIn = (root: string) => { const dir = join(root, 'resource-ledger'); mkdirSync(dir, { recursive: true }); const p = join(dir, 'events.jsonl'); writeFileSync(p, ''); return p; };
const up = (host: string, load1: number, ncpu: number): HostProbe => ({ host, reachable: true, load1, ncpu });
const down = (host: string): HostProbe => ({ host, reachable: false, load1: null, ncpu: null, why: 'ssh: connect timed out' });
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length]!;
const routed = (path: string | null, at: Date) => hostsFor('pregate', { facts: resolveFacts({ actors: path ? foldWorld(readResourceLedger(path), at).actors : null, policy: null, now: at }) });

/** normal — the pulse's facts route pregate: an unreachable host disappears from every caller, the rest keep policy order. */
const routedByFacts: SimWorldScenario = {
  id: 'HOSTFACTS-ROUTED', title: 'host facts written each pulse route pregate through resource-facts (an unreachable host is gone, the HQ host never)',
  async run(ctx) {
    const cases = [
      { probes: [up('minim5', 2, 16), up('mbp', 3, 18), up('node-b', 4, 32), up('node-c', 1, 14), up('mshq', 0, 24)], want: ['minim5', 'mbp', 'node-b', 'node-c'] },
      { probes: [up('minim5', 2, 16), up('mbp', 3, 18), down('node-b'), up('node-c', 1, 14)], want: ['minim5', 'mbp', 'node-c'] },
      { probes: [down('minim5'), up('mbp', 3, 18), up('node-b', 4, 32), down('node-c')], want: ['mbp', 'node-b'] },
      { probes: [down('minim5'), down('mbp'), down('node-b'), down('node-c')], want: [] },
    ] as const;
    const c = pick(ctx.random, cases);
    const path = ledgerIn(ctx.universeRoot); const at = new Date('2026-11-27T10:00:00.000Z');
    const written = writeHostFacts(c.probes, at, path);
    const got = routed(path, at);
    ctx.recorder.event('hostfacts-routed', { written, got });
    return written === c.probes.length && JSON.stringify(got) === JSON.stringify(c.want) ? { ok: true } : fail('facts did not route pregate', { written, got, want: c.want });
  },
};

/** edge — a host in a maintenance window is written `reserved` and leaves routing even while its probe is healthy. */
const maintReserved: SimWorldScenario = {
  id: 'HOSTFACTS-MAINT-RESERVED', title: 'a host in a maintenance window is written reserved (out of routing) although its probe is healthy; back in pool → healthy',
  async run(ctx) {
    const host = pick(ctx.random, ['minim5', 'mbp', 'node-b'] as const);
    const path = ledgerIn(ctx.universeRoot);
    const t0 = new Date('2026-11-27T10:00:00.000Z'); const t1 = new Date('2026-11-27T10:02:00.000Z'); const t2 = new Date('2026-11-27T10:04:00.000Z');
    const probes = [up('minim5', 2, 16), up('mbp', 3, 18), up('node-b', 4, 32)];
    writeHostFacts(probes, t0, path);
    recordWorldEvents([{ event: 'world-actor', at: t0.toISOString(), by: 'loop:guardian/lease', actor: { id: `host:${host}`, kind: 'host', mode: 'owner', host, meta: { maintenance: { phase: 'draining', defers: 0 } } } }], path);
    writeHostFacts(probes, t1, path);
    const all = ['minim5', 'mbp', 'node-b'];
    // only the hosts this scenario wrote — node-c (and any other default host) still routes from the resource-facts defaults
    const during = routed(path, t1).filter(h => all.includes(h));
    recordWorldEvents([{ event: 'world-actor', at: t1.toISOString(), by: 'loop:guardian/lease', actor: { id: `host:${host}`, kind: 'host', mode: 'owner', host, meta: { maintenance: { phase: 'pool', defers: 0 } } } }], path);
    writeHostFacts(probes, t2, path);
    const after = routed(path, t2).filter(h => all.includes(h));
    ctx.recorder.event('hostfacts-maint', { host, during, after });
    return JSON.stringify(during) === JSON.stringify(all.filter(h => h !== host)) && JSON.stringify(after) === JSON.stringify(all)
      ? { ok: true } : fail('maintenance did not gate routing', { host, during, after });
  },
};

/** fault — an unreadable ledger routes from the defaults; a write that cannot land returns 0 and never throws. */
const ledgerFault: SimWorldScenario = {
  id: 'HOSTFACTS-LEDGER-FAULT', title: 'a missing / corrupt ledger → resource-facts defaults; a failed facts write is observed, never thrown',
  async run(ctx) {
    const f = pick(ctx.random, ['missing', 'corrupt', 'blocked'] as const);
    const dir = join(ctx.universeRoot, 'resource-ledger'); mkdirSync(dir, { recursive: true });
    const path = join(dir, 'events.jsonl');
    if (f === 'corrupt') writeFileSync(path, '{"event":"world-actor", torn\n');
    const blocker = join(dir, 'blocker'); writeFileSync(blocker, 'not a directory\n');
    let threw = ''; let rows = -1;
    try { rows = writeHostFacts([up('minim5', 1, 16)], new Date(), f === 'blocked' ? join(blocker, 'events.jsonl') : f === 'corrupt' ? path : join(blocker, 'x.jsonl')); } catch (e) { threw = (e as Error).message; }
    let actors: ReturnType<typeof foldWorld>['actors'] | null = null;
    try { actors = foldWorld(readResourceLedger(path), new Date()).actors; } catch { actors = null; }
    const got = hostsFor('pregate', { facts: resolveFacts({ actors: f === 'missing' ? null : actors, policy: null }) });
    ctx.recorder.event('hostfacts-fault', { fault: f, rows, threw, got });
    return threw === '' && rows === 0 && JSON.stringify(got) === JSON.stringify(['minim5', 'mbp', 'node-b', 'node-c'])
      ? { ok: true } : fail('a ledger fault leaked into the pulse or routing', { fault: f, rows, threw, got });
  },
};

/** normal — a quiet pulse writes 0 rows; a load jump / a lost host / a new lease writes again. */
const onChange: SimWorldScenario = {
  id: 'HOSTFACTS-ON-CHANGE', title: 'the 임대관 rewrites a host row only on a material change (quiet pulse = 0 rows)',
  async run(ctx) {
    const path = ledgerIn(ctx.universeRoot);
    const first = writeHostFacts([up('node-b', 8, 32), up('minim5', 4, 16)], new Date('2026-11-27T10:00:00.000Z'), path);
    const quiet = writeHostFacts([up('node-b', 9, 32), up('minim5', 4, 16)], new Date('2026-11-27T10:02:00.000Z'), path);
    const c = pick(ctx.random, [
      { probes: [up('node-b', 40, 32), up('minim5', 4, 16)], rows: 1 },
      { probes: [up('node-b', 8, 32), down('minim5')], rows: 1 },
      { probes: [down('node-b'), down('minim5')], rows: 2 },
    ] as const);
    const changed = writeHostFacts(c.probes, new Date('2026-11-27T10:04:00.000Z'), path);
    ctx.recorder.event('hostfacts-on-change', { first, quiet, changed });
    return first === 2 && quiet === 0 && changed === c.rows ? { ok: true } : fail('rows written without a change (or a change missed)', { first, quiet, changed, want: c.rows });
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [routedByFacts, maintReserved, ledgerFault, onChange];
