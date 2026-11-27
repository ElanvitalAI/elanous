// 임대관 host facts → WORLD-REGISTRY → kit/resource-facts routing (CEO 10:5x «machines must be routed by the ledger»).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsChanged, hostFacts, hostFactsEvents, writeHostFacts, type HostProbe } from './hosts.js';
import { readResourceLedger } from '../resource-ledger/resource-ledger.js';
import { foldWorld } from '../resource-ledger/world-registry.js';
import { resolveFacts } from '../kit/resource-facts/facts.js';
import { hostsFor } from '../kit/resource-facts/route.js';
import { filterPlacementCandidates } from '../guardian/placement-shadow.js';

const up = (host: string, load1: number, ncpu: number): HostProbe => ({ host, reachable: true, load1, ncpu });
const down = (host: string): HostProbe => ({ host, reachable: false, load1: null, ncpu: null, why: 'ssh: connect timed out' });
const routed = (path: string, at: Date) => hostsFor('pregate', { facts: resolveFacts({ actors: foldWorld(readResourceLedger(path), at).actors, policy: null, now: at }) });

describe('임대관 host facts', () => {
  test('one probe → resource-facts schema (health · healthNote · load · ncpu · leases) — never roles', () => {
    expect(hostFacts(up('minim5', 4, 16), 2, '2026-11-27T10:00:00.000Z')).toEqual({ health: 'healthy', load1: 4, ncpu: 16, leases: 2, factsAt: '2026-11-27T10:00:00.000Z' });
    expect(hostFacts(down('node-b'), 0, '2026-11-27T10:00:00.000Z')).toEqual({ health: 'unhealthy', healthNote: 'ssh: connect timed out', load1: null, ncpu: null, leases: 0, factsAt: '2026-11-27T10:00:00.000Z' });
    expect(hostFacts(up('mbp', 1, 18), 0, '2026-11-27T10:00:00.000Z', true)).toMatchObject({ health: 'reserved', healthNote: 'maintenance window' });
    const ev = hostFactsEvents([up('minim5', 4, 16)], [], {}, new Date('2026-11-27T10:00:00.000Z'));
    expect(Object.keys(ev[0]!.actor.meta ?? {}).sort()).toEqual(['factsAt', 'health', 'healthNote', 'leases', 'load1', 'ncpu']);
    expect(ev[0]!.actor.meta?.roles).toBeUndefined();
  });

  test('rewritten only on a material change or after 5 min', () => {
    const prev = hostFacts(up('minim5', 4, 16), 2, '2026-11-27T09:58:00.000Z');
    expect(factsChanged(prev, hostFacts(up('minim5', 5, 16), 2, '2026-11-27T10:00:00.000Z'))).toBe(false);
    expect(factsChanged(prev, hostFacts(up('minim5', 12, 16), 2, '2026-11-27T10:00:00.000Z'))).toBe(true);
    expect(factsChanged(prev, hostFacts(up('minim5', 4, 16), 3, '2026-11-27T10:00:00.000Z'))).toBe(true);
    expect(factsChanged(prev, hostFacts(down('minim5'), 2, '2026-11-27T10:00:00.000Z'))).toBe(true);
    expect(factsChanged(prev, hostFacts(up('minim5', 4, 16), 2, '2026-11-27T10:03:00.000Z'))).toBe(true);
  });

  test('a row in a maintenance window stays reserved even while its probe is healthy', () => {
    const now = new Date('2026-11-27T10:00:00.000Z');
    const ev = hostFactsEvents([up('mbp', 1, 18)], [{ id: 'host:mbp', meta: { maintenance: { phase: 'draining', defers: 0 } } }], {}, now);
    expect(ev.map(e => [e.actor.id, e.actor.meta?.health])).toEqual([['host:mbp', 'reserved']]);
  });

  test('end to end: written facts drive kit/resource-facts — an unhealthy host leaves pregate routing; recovery brings it back', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'host-facts-')), 'events.jsonl'); writeFileSync(path, '');
    const t0 = new Date('2026-11-27T10:00:00.000Z'); const t1 = new Date('2026-11-27T10:06:00.000Z');
    expect(writeHostFacts([up('minim5', 2, 16), down('node-b'), up('mbp', 3, 18), up('node-c', 1, 14)], t0, path)).toBe(4);
    expect(routed(path, t0)).toEqual(['minim5', 'mbp', 'node-c']);
    expect(writeHostFacts([up('minim5', 2, 16), up('node-b', 4, 32), up('mbp', 3, 18), up('node-c', 1, 14)], t1, path)).toBe(4);
    expect(routed(path, t1)).toEqual(['minim5', 'mbp', 'node-b', 'node-c']);
  });

  test('a facts write that cannot land returns 0 and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-facts-bad-')); const blocker = join(dir, 'blocker'); writeFileSync(blocker, 'x');
    expect(writeHostFacts([up('minim5', 1, 16)], new Date(), join(blocker, 'events.jsonl'))).toBe(0);
  });

  test('placement shadow never offers the HQ host for tsc / test / review (seat tabs only)', () => {
    const facts = (host: string) => ({ host, load1Pct: 10, load15Pct: 10, memoryAvailablePct: 80, diskUsedPct: 20, tools: ['repo', 'bun', 'node_modules', 'codex'], ssh: true, maintenance: false, runningKinds: [], tabCount: 0, trainRows: 0, warmPoolPods: 0 });
    for (const workKind of ['tsc', 'test', 'review'] as const) expect(filterPlacementCandidates({ workKind, hosts: [facts('mshq'), facts('node-b')] }).map(c => c.host)).toEqual(['node-b']);
    expect(filterPlacementCandidates({ workKind: 'tab', hosts: [facts('mshq'), facts('node-b')] }).map(c => c.host)).toEqual(['mshq', 'node-b']);
  });
});
