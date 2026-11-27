// RESOURCE-FACTS sim — «a host goes unhealthy in the registry → every caller stops picking it without code change».
// A temp lease ledger + policy file; each seed writes one guardian/OP line (or policy edit) and asks every caller again
// after the cache TTL. Callers = CALLERS below (the kit's own faces; migrated call sites join this list).
// Seeds: ① guardian marks node-b unhealthy → gone everywhere; marked healthy again → back · ② an owner declares minim5 off
// in the world registry → gone · ③ OP reserves mbp in the policy file → gone until the policy clears it (a ledger «healthy» does not lift it)
// · ④ a paid VM approved in the ledger becomes a gate host, revoked → gone.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWorldEvents } from '../../resource-ledger/resource-ledger.js';
import type { HostProbe } from '../../guardian-agent/hosts.js';
import { FACTS_TTL_MS, resetResourceFactsCache, resourceFacts } from './facts.js';
import { factGet } from './get.js';
import { hostsFor, pickHost, type RoutePurpose } from './route.js';

let dir = ''; let ledger = ''; let policy = ''; let clock = 0;
const T0 = Date.parse('2026-11-27T02:00:00.000Z');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resource-facts-sim-')); ledger = join(dir, 'events.jsonl'); policy = join(dir, 'policy.json');
  clock = T0; resetResourceFactsCache();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetResourceFactsCache(); });

/** Advance past the cache TTL so the next read sees the new line. */
const tick = () => { clock += FACTS_TTL_MS + 1_000; };
const facts = () => resourceFacts({ policyFile: policy, ledgerPath: ledger, now: new Date(clock) });
// node-b is the least loaded so it wins whenever it is eligible — the hardest case for «stops picking it».
const LOAD: Record<string, number> = { 'node-b': 0.5, minim5: 3, mbp: 4, 'node-c': 5, gcp2: 0.1 }; // Source: R-TST36 synthetic per-host load fixture
const probe = (h: string): HostProbe => ({ host: h, reachable: true, load1: LOAD[h] ?? 6, ncpu: 10 });

const CALLERS: Record<string, (p: RoutePurpose) => readonly string[]> = {
  'pickHost': (p) => { const r = pickHost(p, { facts: facts(), probe, leaseFull: new Set() }); return r.host ? [r.host] : []; },
  'hostsFor': (p) => hostsFor(p, { facts: facts() }),
  'eln world facts get hosts.<purpose>': (p) => factGet(facts(), `hosts.${p}`) as string[],
};
const HEAVY: RoutePurpose[] = ['pregate', 'full-gate', 'tsc', 'test-run'];

function everyCallerSees(host: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, call] of Object.entries(CALLERS)) for (const p of HEAVY) out[`${name}:${p}`] = call(p).includes(host);
  return out;
}
const all = (o: Record<string, boolean>, v: boolean) => Object.values(o).every(x => x === v);

const line = (host: string, by: string, extra: Record<string, unknown>) => ({
  event: 'world-actor' as const, at: new Date(clock).toISOString(), by,
  actor: { id: `host:${host}`, kind: 'host' as const, mode: 'owner' as const, registered: true, host, owner: 'RES', ...extra },
});

test('seed ① guardian marks node-b unhealthy → every caller drops it; healthy again → every caller picks it', () => {
  expect(CALLERS.pickHost!('pregate')).toEqual(['node-b']);
  expect(all(everyCallerSees('node-b'), true)).toBe(true);

  recordWorldEvents([line('node-b', 'loop:guardian', { meta: { health: 'unhealthy', healthNote: 'load 135/32 · ssh flaps' } })], ledger);
  tick();
  expect(everyCallerSees('node-b')).toEqual(Object.fromEntries(Object.keys(everyCallerSees('node-b')).map(k => [k, false])));
  expect(CALLERS.pickHost!('pregate')).toEqual(['minim5']);
  expect(pickHost('tsc', { facts: facts(), probe, leaseFull: new Set() }).skipped).toContainEqual({ host: 'node-b', why: 'unhealthy (load 135/32 · ssh flaps)' });

  recordWorldEvents([line('node-b', 'loop:guardian', { meta: { health: 'healthy' } })], ledger);
  tick();
  expect(all(everyCallerSees('node-b'), true)).toBe(true);
});

test('seed ② an owner declares minim5 off in the world registry → every caller drops it', () => {
  expect(all(everyCallerSees('minim5'), false)).toBe(false);
  recordWorldEvents([line('minim5', 'RES', { declaredState: 'off' })], ledger);
  tick();
  expect(Object.entries(everyCallerSees('minim5')).filter(([, v]) => v)).toEqual([]);
});

test('seed ③ OP reserves mbp in the policy file → dropped; a guardian «healthy» line does not lift the reservation; clearing the policy does', () => {
  writeFileSync(policy, JSON.stringify({ hosts: { mbp: { health: 'reserved', note: 'demo rehearsal' } } }));
  tick();
  expect(Object.entries(everyCallerSees('mbp')).filter(([, v]) => v)).toEqual([]);
  recordWorldEvents([line('mbp', 'loop:guardian', { meta: { health: 'healthy' } })], ledger);
  tick();
  expect(CALLERS.hostsFor!('pregate')).not.toContain('mbp');
  writeFileSync(policy, JSON.stringify({}));
  tick();
  expect(CALLERS.hostsFor!('pregate')).toContain('mbp');
});

test('seed ④ a paid VM approved in the ledger becomes a gate host; approval revoked → gone', () => {
  expect(CALLERS.hostsFor!('pregate')).not.toContain('gcp2');
  recordWorldEvents([line('gcp2', 'OP', { meta: { paidApproved: true } })], ledger);
  tick();
  expect(CALLERS.pickHost!('pregate')).toEqual(['node-b']); // local before paid even when the VM is idler
  expect(CALLERS.hostsFor!('pregate')).toContain('gcp2');
  recordWorldEvents([line('gcp2', 'OP', { meta: { paidApproved: false } })], ledger);
  tick();
  expect(all(everyCallerSees('gcp2'), false)).toBe(true);
});
