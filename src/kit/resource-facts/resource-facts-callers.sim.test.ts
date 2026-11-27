// RESOURCE-FACTS sim (2/3) — the MIGRATED call sites, unchanged code, read the registry: one guardian ledger line marking a
// host unhealthy (or an owner declaring it off) removes it from every one of them; the next line brings it back.
// Callers: land-graph retry rotation (red-receipt · land-graph-cli retryHosts incl. a configured list) · throughput
// controller pregate hosts · RES policy pre-approved test hosts · seat hand-pool default · ops dashboard probe list ·
// placement shadow candidates · steward/guardian read hostsFor directly (covered by the kit sim).
// Seeds: ① node-b unhealthy → gone everywhere → healthy → back · ② minim5 declared off → gone everywhere ·
// ③ a new host registered with roles joins every caller without code change.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWorldEvents } from '../../resource-ledger/resource-ledger.js';
import { defaultRetryHosts, nextHost, tscHostsFor } from '../../land-graph/red-receipt.js';
import { retryHosts } from '../../cli/land-graph-cli.js';
import { pregateHosts } from '../../loops/throughput-controller-live.js';
import { DEFAULT_RES_POLICY, resolveResPolicy } from '../../res-policy/policy.js';
import { preapprovedPool } from '../../seat/resource-preapproval.js';
import { dashboardHosts } from '../../ops-dashboard/operating-dashboard.js';
import { filterPlacementCandidates, type PlacementSnapshot } from '../../guardian/placement-shadow.js';
import { resetResourceFactsCache } from './facts.js';

let dir = '';
const saved = { ledger: process.env.RESOURCE_FACTS_LEDGER, policy: process.env.RESOURCE_FACTS_POLICY };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resource-facts-callers-'));
  process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl');
  process.env.RESOURCE_FACTS_POLICY = join(dir, 'policy.json');
  resetResourceFactsCache();
});
afterEach(() => {
  if (saved.ledger === undefined) delete process.env.RESOURCE_FACTS_LEDGER; else process.env.RESOURCE_FACTS_LEDGER = saved.ledger;
  if (saved.policy === undefined) delete process.env.RESOURCE_FACTS_POLICY; else process.env.RESOURCE_FACTS_POLICY = saved.policy;
  rmSync(dir, { recursive: true, force: true });
  resetResourceFactsCache();
});

const write = (host: string, extra: Record<string, unknown>) => {
  recordWorldEvents([{ event: 'world-actor', at: new Date().toISOString(), by: 'loop:guardian',
    actor: { id: `host:${host}`, kind: 'host', mode: 'owner', registered: true, host, owner: 'RES', ...extra } }], process.env.RESOURCE_FACTS_LEDGER!);
  resetResourceFactsCache(); // the TTL elapsed (the kit sim proves the TTL path)
};

const green = (name: string): PlacementSnapshot['hosts'][number] => ({
  host: name, load1Pct: 12, load15Pct: 15, memoryAvailablePct: 55, diskUsedPct: 40, // Source: R-TST36 synthetic green-host fixture (placement-shadow.test.ts)
  tools: ['repo', 'bun', 'node_modules', 'codex'], ssh: true, maintenance: false, runningKinds: [], tabCount: 0, trainRows: 0, warmPoolPods: 0,
});
const placement = (hosts: string[]) => filterPlacementCandidates({ workKind: 'test', hosts: hosts.map(green) }).map(c => c.host);

const CALLERS: Record<string, () => readonly string[]> = {
  'red-receipt defaultRetryHosts': () => defaultRetryHosts(),
  'red-receipt nextHost': () => [nextHost(undefined), nextHost(undefined, undefined, 1), nextHost(undefined, undefined, 2)],
  'red-receipt tscHostsFor': () => tscHostsFor(0).split(' '),
  'land-graph-cli retryHosts (configured list)': () => retryHosts({ retryHosts: ['node-b', 'minim5', 'mbp'] }),
  'land-graph-cli retryHosts (default)': () => retryHosts({}),
  'throughput pregateHosts': () => pregateHosts(),
  'res-policy default preApprovedTestHosts': () => DEFAULT_RES_POLICY.preApprovedTestHosts,
  'res-policy resolved preApprovedTestHosts': () => resolveResPolicy(undefined).preApprovedTestHosts,
  'seat hand pool (code default)': () => preapprovedPool(join(dir, 'no-seat-state')).hosts,
  'ops dashboard probe list': () => dashboardHosts(),
  'placement shadow candidates': () => placement(['node-b', 'minim5', 'mbp', 'mshq', 'studio9']),
};
const seen = (host: string) => Object.fromEntries(Object.entries(CALLERS).map(([k, f]) => [k, f().includes(host)]));
const none = (o: Record<string, boolean>) => Object.entries(o).filter(([, v]) => v).map(([k]) => k);

test('seed ① node-b unhealthy in the registry → every migrated caller drops it; healthy again → every caller has it', () => {
  expect(none(seen('node-b')).sort()).toEqual(Object.keys(CALLERS).sort());
  write('node-b', { meta: { health: 'unhealthy', healthNote: 'load 135/32' } });
  expect(none(seen('node-b'))).toEqual([]);
  write('node-b', { meta: { health: 'healthy' } });
  expect(none(seen('node-b')).sort()).toEqual(Object.keys(CALLERS).sort());
});

test('seed ② minim5 declared off by its owner → every migrated caller drops it', () => {
  expect(none(seen('minim5')).length).toBe(Object.keys(CALLERS).length);
  write('minim5', { declaredState: 'off' });
  expect(none(seen('minim5'))).toEqual([]);
});

test('seed ③ a new host registered with roles joins the registry-driven callers without a code change; HQ never does', () => {
  write('studio9', { meta: { roles: ['test', 'gate', 'review', 'hand'], priority: 0 } });
  const joined = none(seen('studio9'));
  // a caller-configured list (land.graph.retryHosts) is the caller's choice and stays as configured.
  expect(joined.sort()).toEqual(Object.keys(CALLERS).filter(k => k !== 'land-graph-cli retryHosts (configured list)' && !k.startsWith('red-receipt') && k !== 'land-graph-cli retryHosts (default)').sort());
  expect(none(seen('mshq'))).toEqual([]);
});

test('seed ④ every tsc host out in the registry → the retry rotation names no host (never the blocked one it avoids)', () => {
  for (const h of ['minim5', 'mbp', 'node-b', 'node-c']) write(h, { meta: { health: 'unhealthy' } });
  expect(defaultRetryHosts()).toEqual([]);
  expect(nextHost('node-b')).toBe('');
  expect(tscHostsFor(0)).toBe('');
});
