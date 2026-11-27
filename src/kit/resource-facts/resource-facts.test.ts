import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWorldEvents } from '../../resource-ledger/resource-ledger.js';
import { acceptReviewModel, capOf, expiryOf, resetResourceFactsCache, resolveFacts, resourceFacts } from './facts.js';
import { factGet } from './get.js';
import { hostAllowed, hostsFor, pickHost } from './route.js';
import type { HostProbe } from '../../guardian-agent/hosts.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'resource-facts-')); resetResourceFactsCache(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetResourceFactsCache(); });

const flat = (load1: number, ncpu = 10) => (h: string): HostProbe => ({ host: h, reachable: true, load1, ncpu });
const hostLine = (host: string, meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: 'world-actor' as const, at: '2026-11-27T01:00:00.000Z', by: 'loop:guardian',
  actor: { id: `host:${host}`, kind: 'host' as const, mode: 'owner' as const, registered: true, host, owner: 'RES', meta, ...extra },
});

test('ledger and policy both missing → code defaults, a «default used» warning, never a throw', () => {
  const f = resourceFacts({ policyFile: join(dir, 'none.json'), ledgerPath: join(dir, 'none.jsonl') });
  expect(f.sources).toEqual(['default']);
  expect(f.warnings.some(w => w.startsWith('world ledger missing'))).toBe(true);
  expect(f.warnings.some(w => w.startsWith('default used: hosts'))).toBe(true);
  expect(f.review.primary).toBe('terra');
  expect(capOf('accountCap', f)).toBe(0.95);
  // the HQ host is never a test/gate candidate, paid VMs are not approved by default
  expect(hostsFor('tsc', { facts: f })).toEqual(['minim5', 'mbp', 'node-b', 'node-c']);
  expect(hostsFor('pregate', { facts: f })).not.toContain('mshq');
});

test('a corrupt policy file and a corrupt ledger fall back with warnings', () => {
  writeFileSync(join(dir, 'policy.json'), '{not json');
  writeFileSync(join(dir, 'events.jsonl'), 'garbage\n');
  const f = resourceFacts({ policyFile: join(dir, 'policy.json'), ledgerPath: join(dir, 'events.jsonl') });
  expect(f.warnings.some(w => w.includes('unreadable'))).toBe(true);
  expect(f.hosts.length).toBeGreaterThan(0);
});

test('policy file overrides defaults: roles, health, review, caps, expiries, retry hosts', () => {
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({
    hosts: { 'node-c': { health: 'reserved', note: 'A164 queue' }, newbox: { roles: ['test', 'gate'], priority: 0 } },
    review: { primary: 'terra', fallback: 'grok', fallbackAfterFailures: 3 },
    caps: { accountCap: 0.9 }, expiries: { 'review-auto-chain': '2026-12-01T00:00:00Z' }, retryHosts: ['minim5', 'node-b'],
  }));
  const f = resourceFacts({ policyFile: join(dir, 'policy.json'), ledgerPath: join(dir, 'none.jsonl') });
  expect(hostsFor('test-run', { facts: f })[0]).toBe('newbox');
  expect(hostsFor('test-run', { facts: f })).not.toContain('node-c');
  expect(hostAllowed('node-c', 'pregate', f)?.why).toBe('reserved (A164 queue)');
  expect(f.review.fallbackAfterFailures).toBe(3);
  expect(capOf('accountCap', f)).toBe(0.9);
  expect(expiryOf('review-auto-chain', f)).toBe(Date.parse('2026-12-01T00:00:00Z'));
  expect(factGet(f, 'retryHosts')).toEqual(['minim5', 'node-b']);
  expect(factGet(f, 'expiry.review-auto-chain.epoch')).toBe(Date.parse('2026-12-01T00:00:00Z') / 1000);
});

test('migrated call sites pick hosts from the registry: ledger roles and health win over defaults', () => {
  const ledger = join(dir, 'events.jsonl');
  recordWorldEvents([
    hostLine('node-b', { roles: ['test', 'gate', 'review'], health: 'unhealthy', healthNote: 'load 135/32' }),
    hostLine('minim5', { roles: ['test', 'gate'] }),
    hostLine('studio2', { roles: ['test', 'gate'], ncpu: 24, priority: 0 }),
  ], ledger);
  const f = resourceFacts({ policyFile: join(dir, 'none.json'), ledgerPath: ledger });
  expect(f.sources).toContain('ledger');
  expect(hostsFor('pregate', { facts: f })).toEqual(['studio2', 'minim5', 'mbp', 'node-c']);
  const r = pickHost('pregate', { facts: f, probe: flat(1), leaseFull: new Set() });
  expect(r.host).toBe('studio2');
  expect(r.skipped.find(s => s.host === 'node-b')?.why).toBe('unhealthy (load 135/32)');
});

test('pickHost: least load per core wins; needCpu, exclude, leases at capacity and unreachable hosts are skipped', () => {
  const f = resolveFacts({ actors: null, policy: null });
  const loads: Record<string, number> = { minim5: 9, mbp: 2, 'node-b': 1, 'node-c': 5 }; // Source: R-TST36 synthetic per-host load fixture
  const probe = (h: string): HostProbe => (h === 'node-c' ? { host: h, reachable: false, load1: null, ncpu: null, why: 'ssh timeout' } : { host: h, reachable: true, load1: loads[h]!, ncpu: 10 });
  expect(pickHost('tsc', { facts: f, probe, leaseFull: new Set() }).host).toBe('node-b');
  expect(pickHost('tsc', { facts: f, probe, leaseFull: new Set(['node-b']) }).host).toBe('mbp');
  expect(pickHost('tsc', { facts: f, probe, leaseFull: new Set(), exclude: ['node-b', 'mbp'] }).host).toBe('minim5');
  expect(pickHost('tsc', { facts: f, probe, leaseFull: new Set(), needCpu: 9.5 }).host).toBe(null);
  const none = pickHost('tsc', { facts: f, probe, leaseFull: new Set(), needCpu: 9.5 });
  expect(none.why.startsWith('no host for tsc')).toBe(true);
});

test('paid VMs: routed only once approved — for burst too', () => {
  const f = resolveFacts({ actors: null, policy: { hosts: { gcp2: { paidApproved: true } } } });
  expect(hostsFor('pregate', { facts: f })).toContain('gcp2');
  expect(hostsFor('pregate', { facts: f })).not.toContain('aws1');
  expect(hostsFor('burst', { facts: f })).toEqual(['gcp2']);
});

test('a malformed policy entry is dropped alone: the ledger and the other entries still apply', () => {
  const actors = [{ id: 'host:node-b', kind: 'host', host: 'node-b', declaredState: 'live', state: 'live', reason: null, meta: { health: 'unhealthy' } }];
  const policy = { hosts: { 'node-b': null, 'node-c': { health: 'reserved' } }, caps: 'x', review: { primary: 'terra' } } as unknown as Parameters<typeof resolveFacts>[0]['policy'];
  const f = resolveFacts({ actors, policy });
  expect(hostsFor('pregate', { facts: f })).toEqual(['minim5', 'mbp']);
  expect(f.warnings).toContain('policy hosts.node-b is not an object — ignored');
  expect(f.warnings).toContain('policy caps is not an object — ignored');
});

test('a policy reservation holds over a ledger «healthy» (the stronger exclusion wins)', () => {
  const actors = [{ id: 'host:mbp', kind: 'host', host: 'mbp', declaredState: 'live', state: 'live', reason: null, meta: { health: 'healthy' } }];
  const f = resolveFacts({ actors, policy: { hosts: { mbp: { health: 'reserved', note: 'rehearsal' } } } });
  expect(hostAllowed('mbp', 'pregate', f)?.why).toBe('reserved (rehearsal)');
});

test('caps out of range are refused with a warning (shares 0..1 · Percent 0..100)', () => {
  const f = resolveFacts({ actors: null, policy: { caps: { accountCap: 95, grokWeeklyExhaustedPercent: 700, fuelLow: 0.8, claudeSwitchPercent: 90 } } });
  expect([f.caps.accountCap, f.caps.grokWeeklyExhaustedPercent, f.caps.fuelLow, f.caps.claudeSwitchPercent]).toEqual([0.95, 70, 0.8, 90]);
  expect(f.warnings.filter(w => w.includes('out of range')).length).toBe(2);
});

test('a host declared off in the world registry disappears from routing', () => {
  const ledger = join(dir, 'events.jsonl');
  recordWorldEvents([hostLine('mbp', {}, { declaredState: 'off' })], ledger);
  const f = resourceFacts({ policyFile: join(dir, 'none.json'), ledgerPath: ledger });
  expect(hostsFor('review', { facts: f })).toEqual(['minim5', 'node-b']);
});

test('LLM account rows feed account names and usage', () => {
  const f = resolveFacts({ actors: [{ id: 'llm-account:openai-codex:fourth', kind: 'llm-account', host: null, declaredState: 'live', state: 'live', reason: null, meta: { usedPercent: 42 } }], policy: null });
  expect(f.accountNames['openai-codex']).toContain('fourth');
  expect(f.accounts[0]).toMatchObject({ provider: 'openai-codex', account: 'fourth', usedPercent: 42, source: 'ledger' });
});

test('review policy: primary and fallback accepted (fallback role named), forbidden family refused', () => {
  const p = resolveFacts({ actors: null, policy: null }).review;
  expect(acceptReviewModel('gpt-6.1-terra', p)).toMatchObject({ ok: true, role: 'primary' });
  expect(acceptReviewModel('grok-4.7-fast', p)).toMatchObject({ ok: true, role: 'fallback' });
  expect(acceptReviewModel('z-ai/glm-5', p).ok).toBe(false);
  expect(acceptReviewModel('', p).ok).toBe(false);
});

test('the cache answers within the TTL and re-reads after it', () => {
  const pfile = join(dir, 'policy.json');
  writeFileSync(pfile, JSON.stringify({ caps: { accountCap: 0.8 } }));
  const t0 = new Date('2026-11-27T01:00:00Z');
  expect(capOf('accountCap', resourceFacts({ policyFile: pfile, ledgerPath: join(dir, 'x'), now: t0 }))).toBe(0.8);
  writeFileSync(pfile, JSON.stringify({ caps: { accountCap: 0.7 } }));
  expect(capOf('accountCap', resourceFacts({ policyFile: pfile, ledgerPath: join(dir, 'x'), now: new Date(t0.getTime() + 5_000) }))).toBe(0.8);
  expect(capOf('accountCap', resourceFacts({ policyFile: pfile, ledgerPath: join(dir, 'x'), now: new Date(t0.getTime() + 31_000) }))).toBe(0.7);
});
