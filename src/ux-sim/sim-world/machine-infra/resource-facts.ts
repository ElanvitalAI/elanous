// SIM-WORLD machine-infra · RESOURCE-FACTS-FROM-LEDGER (대표 11-27 «머신들도 원장에 의해서 라우팅되게» · «시뮬레이션 월드에서
//다 충분히 검증»). Each scenario writes REAL lease-ledger lines (world-actor rows — what the guardian/OP/RES write) or a
// REAL policy file under ctx.universeRoot, then asks every REAL caller on main again — the kit (`pickHost` · `hostsFor` ·
// `eln world facts get`) and the migrated call sites (land-graph retry rotation · throughput controller · RES policy ·
// seat hand pool · ops dashboard · placement shadow). Only the outside is faked: host load probes (no ssh) and the clock.
// No real ledger, policy or state is opened: the facts paths point into the universe (RESOURCE_FACTS_* · restored after).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostProbe } from '../../../guardian-agent/hosts.js';
import { recordWorldEvents } from '../../../resource-ledger/resource-ledger.js';
import { resetResourceFactsCache, resourceFacts } from '../../../kit/resource-facts/facts.js';
import { factGet } from '../../../kit/resource-facts/get.js';
import { hostsFor, pickHost, type RoutePurpose } from '../../../kit/resource-facts/route.js';
import { defaultRetryHosts, tscHostsFor } from '../../../land-graph/red-receipt.js';
import { retryHosts } from '../../../cli/land-graph-cli.js';
import { pregateHosts } from '../../../loops/throughput-controller-live.js';
import { resolveResPolicy } from '../../../res-policy/policy.js';
import { preapprovedPool } from '../../../seat/resource-preapproval.js';
import { dashboardHosts } from '../../../ops-dashboard/operating-dashboard.js';
import { filterPlacementCandidates, type PlacementSnapshot } from '../../../guardian/placement-shadow.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, detail: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof detail === 'string' ? detail : JSON.stringify(detail) });

interface Universe { ledger: string; policy: string; root: string; write(host: string, extra: Record<string, unknown>, by?: string): void; policyFile(body: unknown): void }

/** Points the facts at the universe for the scenario body and restores the process env afterwards (never the real ledger). */
async function inUniverse(ctx: SimWorldScenarioContext, body: (u: Universe) => SimWorldScenarioOutcome | Promise<SimWorldScenarioOutcome>): Promise<SimWorldScenarioOutcome> {
  const root = join(ctx.universeRoot, 'resource-facts');
  mkdirSync(root, { recursive: true });
  const u: Universe = {
    root, ledger: join(root, 'events.jsonl'), policy: join(root, 'policy.json'),
    write(host, extra, by = 'loop:guardian') {
      recordWorldEvents([{ event: 'world-actor', at: new Date().toISOString(), by, actor: { id: `host:${host}`, kind: 'host', mode: 'owner', registered: true, host, owner: 'RES', ...extra } }], u.ledger);
      resetResourceFactsCache(); // = the 30 s TTL elapsed
      ctx.recorder.event('ledger-line', { host, by, ...extra });
    },
    policyFile(b) { writeFileSync(u.policy, typeof b === 'string' ? b : JSON.stringify(b)); resetResourceFactsCache(); ctx.recorder.event('policy-edit', { body: typeof b === 'string' ? b.slice(0, 40) : b }); },
  };
  const saved = { ledger: process.env.RESOURCE_FACTS_LEDGER, policy: process.env.RESOURCE_FACTS_POLICY };
  process.env.RESOURCE_FACTS_LEDGER = u.ledger; process.env.RESOURCE_FACTS_POLICY = u.policy;
  resetResourceFactsCache();
  try { return await body(u); } finally {
    if (saved.ledger === undefined) delete process.env.RESOURCE_FACTS_LEDGER; else process.env.RESOURCE_FACTS_LEDGER = saved.ledger;
    if (saved.policy === undefined) delete process.env.RESOURCE_FACTS_POLICY; else process.env.RESOURCE_FACTS_POLICY = saved.policy;
    resetResourceFactsCache();
  }
}

// The outside: load per core from a fixed table (node-b idlest so it is the hardest host to make callers stop picking).
const LOAD: Record<string, number> = { 'node-b': 0.5, minim5: 3, mbp: 4, 'node-c': 5 }; // Source: R-TST36 synthetic per-host load fixture
const probe = (h: string): HostProbe => ({ host: h, reachable: true, load1: LOAD[h] ?? 1, ncpu: 10 });
const green = (name: string): PlacementSnapshot['hosts'][number] => ({
  host: name, load1Pct: 12, load15Pct: 15, memoryAvailablePct: 55, diskUsedPct: 40, // Source: R-TST36 synthetic green-host fixture (placement-shadow.test.ts)
  tools: ['repo', 'bun', 'node_modules', 'codex'], ssh: true, maintenance: false, runningKinds: [], tabCount: 0, trainRows: 0, warmPoolPods: 0, cloudRunning: false,
});

/** Every caller → the hosts it would use now. */
function callers(seatRoot: string): Record<string, readonly string[]> {
  const pick = (p: RoutePurpose) => { const r = pickHost(p, { probe, leaseFull: new Set() }); return r.host ? [r.host] : []; };
  return {
    'kit pickHost(pregate)': pick('pregate'),
    'kit pickHost(tsc)': pick('tsc'),
    'kit pickHost(review)': pick('review'),
    'kit hostsFor(full-gate)': hostsFor('full-gate'),
    'eln world facts get hosts.pregate': factGet(resourceFacts(), 'hosts.pregate') as string[],
    'land-graph defaultRetryHosts': defaultRetryHosts(),
    'land-graph tscHostsFor': tscHostsFor(0).split(' '),
    'land-graph retryHosts(configured)': retryHosts({ retryHosts: ['node-b', 'minim5', 'mbp'] }),
    'throughput pregateHosts': pregateHosts(),
    'res-policy preApprovedTestHosts': resolveResPolicy(undefined).preApprovedTestHosts,
    'seat hand pool': preapprovedPool(seatRoot).hosts,
    'ops dashboard hosts': dashboardHosts(),
    'placement shadow (test)': filterPlacementCandidates({ workKind: 'test', hosts: ['node-b', 'minim5', 'node-c', 'mshq', 'aws2', 'gcp2'].map(green) }).map(c => c.host),
  };
}
const holding = (seatRoot: string, host: string) => Object.entries(callers(seatRoot)).filter(([, hs]) => hs.includes(host)).map(([k]) => k).sort();
/** Callers whose candidate set holds `host` by default (pickHost only when it would win). */
const EVERY_MSB1 = (seatRoot: string) => holding(seatRoot, 'node-b');

const unhealthy: SimWorldScenario = {
  id: 'RF-UNHEALTHY', title: 'the guardian marks node-b unhealthy → every caller stops picking it; healthy again → every caller has it back',
  run: (ctx) => inUniverse(ctx, (u) => {
    const seat = join(u.root, 'seat-state');
    const before = EVERY_MSB1(seat);
    if (before.length !== Object.keys(callers(seat)).length) return fail('node-b not used by every caller at start', before);
    u.write('node-b', { meta: { health: 'unhealthy', healthNote: 'load 135/32 · ssh flaps' } });
    const during = holding(seat, 'node-b');
    const skip = pickHost('pregate', { probe, leaseFull: new Set() }).skipped.find(s => s.host === 'node-b')?.why;
    u.write('node-b', { meta: { health: 'healthy' } });
    const after = holding(seat, 'node-b');
    ctx.recorder.event('rf-unhealthy', { during, skip, after: after.length });
    return during.length === 0 && skip === 'unhealthy (load 135/32 · ssh flaps)' && after.length === before.length ? { ok: true } : fail('a caller kept an unhealthy host', { during, skip, after });
  }),
};

const maintenance: SimWorldScenario = {
  id: 'RF-MAINTENANCE', title: 'minim5 under maintenance (owner declares it off · RES reserves it in the policy file) → gone from every caller; back after',
  run: (ctx) => inUniverse(ctx, (u) => {
    const seat = join(u.root, 'seat-state');
    const all = Object.keys(callers(seat)).filter(k => !k.startsWith('kit pickHost')); // pickHost picks the idlest (node-b)
    u.write('minim5', { declaredState: 'off' }, 'RES');
    const off = holding(seat, 'minim5');
    u.write('minim5', { declaredState: 'live' }, 'RES');
    u.policyFile({ hosts: { minim5: { health: 'reserved', note: 'maintenance window 11-27 13:00' } } });
    const reserved = holding(seat, 'minim5');
    u.policyFile({});
    const back = holding(seat, 'minim5');
    ctx.recorder.event('rf-maintenance', { off, reserved, back });
    return off.length === 0 && reserved.length === 0 && all.every(k => back.includes(k)) ? { ok: true } : fail('maintenance host still routed', { off, reserved, back, all });
  }),
};

const paidNotApproved: SimWorldScenario = {
  id: 'RF-PAID-NOT-APPROVED', title: 'a paid VM is never routed — burst included — until OP approves it in the registry; approved → local still first; revoked → gone',
  run: (ctx) => inUniverse(ctx, (u) => {
    const seat = join(u.root, 'seat-state');
    const pre = holding(seat, 'gcp2');
    const burstNoFlag = hostsFor('burst');
    u.write('gcp2', { meta: { paidApproved: true } }, 'OP');
    const approved = hostsFor('pregate');
    const stillLocal = pickHost('pregate', { probe: (h) => (h === 'gcp2' ? { host: h, reachable: true, load1: 0, ncpu: 64 } : probe(h)), leaseFull: new Set() }).host;
    u.write('gcp2', { meta: { paidApproved: false } }, 'OP');
    const revoked = holding(seat, 'gcp2');
    const burst = hostsFor('burst');
    ctx.recorder.event('rf-paid', { pre, burstNoFlag, approved, stillLocal, revoked, burst });
    // placement shadow may still *propose* a cloud start (shadow only) — that is the cloud-start proposal path, not routing.
    const routing = (l: string[]) => l.filter(k => k !== 'placement shadow (test)');
    return routing(pre).length === 0 && burstNoFlag.length === 0 && approved.includes('gcp2') && stillLocal === 'node-b' && routing(revoked).length === 0 && burst.length === 0
      ? { ok: true } : fail('paid VM routed without approval', { pre, burstNoFlag, approved, stillLocal, revoked, burst });
  }),
};

const ledgerDown: SimWorldScenario = {
  id: 'RF-LEDGER-DOWN', title: 'the lease ledger is corrupt / the policy file is garbage → every caller still answers from defaults with «default used», never throws, never routes heavy work to HQ',
  run: (ctx) => inUniverse(ctx, (u) => {
    const seat = join(u.root, 'seat-state');
    writeFileSync(u.ledger, '{"event":"world-actor", broken\n\u0000\n');
    u.policyFile('{not json');
    let threw: string | null = null; let got: Record<string, readonly string[]> = {};
    try { got = callers(seat); } catch (e) { threw = (e as Error).message; }
    const f = resourceFacts();
    const empty = Object.entries(got).filter(([, hs]) => hs.length === 0).map(([k]) => k);
    const hq = holding(seat, 'mshq');
    ctx.recorder.event('rf-ledger-down', { threw, warnings: f.warnings, empty, hq });
    return threw === null && empty.length === 0 && hq.length === 0 && f.warnings.some(w => w.startsWith('default used')) && f.warnings.some(w => w.includes('unreadable'))
      ? { ok: true } : fail('ledger down broke a caller', { threw, warnings: f.warnings, empty, hq });
  }),
};

const ledgerMissingThenBack: SimWorldScenario = {
  id: 'RF-LEDGER-RECOVERS', title: 'no ledger at all → defaults; the guardian writes its first host rows → the ledger wins (roles · a new host joins) without a restart',
  run: (ctx) => inUniverse(ctx, (u) => {
    const seat = join(u.root, 'seat-state');
    const cold = resourceFacts();
    const coldOk = cold.sources.join() === 'default' && cold.warnings.some(w => w.startsWith('world ledger missing'));
    u.write('studio9', { meta: { roles: ['test', 'gate', 'review', 'hand'], priority: 0, ncpu: 24 } });
    u.write('node-c', { meta: { roles: ['hand'] } });
    const warm = resourceFacts();
    const joined = holding(seat, 'studio9');
    const minihGate = hostsFor('pregate').includes('node-c');
    ctx.recorder.event('rf-ledger-recovers', { coldOk, sources: warm.sources, joined, minihGate });
    return coldOk && warm.sources.includes('ledger') && joined.includes('throughput pregateHosts') && joined.includes('res-policy preApprovedTestHosts') && joined.includes('kit pickHost(pregate)') === false && !minihGate
      ? { ok: true } : fail('ledger rows did not take over from defaults', { coldOk, sources: warm.sources, joined, minihGate });
  }),
};

const allOut: SimWorldScenario = {
  id: 'RF-ALL-OUT', title: 'every gate host marked unhealthy → pickHost says «no host» with a reason per host (callers wait, nothing lands on HQ or an unapproved VM)',
  run: (ctx) => inUniverse(ctx, (u) => {
    for (const h of ['minim5', 'mbp', 'node-b', 'node-c']) u.write(h, { meta: { health: 'unhealthy', healthNote: 'drill' } });
    const r = pickHost('pregate', { probe, leaseFull: new Set() });
    const lists = { pregate: hostsFor('pregate'), throughput: pregateHosts() };
    ctx.recorder.event('rf-all-out', { host: r.host, why: r.why, lists });
    return r.host === null && r.why.startsWith('no host for pregate') && r.skipped.some(s => s.host === 'mshq' && s.why === 'no role gate') && r.skipped.some(s => s.host === 'aws1' && s.why === 'paid VM not approved') && lists.pregate.length === 0 && lists.throughput.length === 0
      ? { ok: true } : fail('all-out world still routed somewhere', { r, lists });
  }),
};

export const simWorldScenarios: readonly SimWorldScenario[] = [unhealthy, maintenance, paidNotApproved, ledgerDown, ledgerMissingThenBack, allOut];
