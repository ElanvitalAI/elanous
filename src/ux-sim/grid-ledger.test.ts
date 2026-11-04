import { describe, expect, test } from 'bun:test';
import { buildGridData } from '../nexus/api/grid.js';
import type { PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import { podDeathAfterPartialScenario } from './fault-pod-death.js';
import { withSimClock } from './fake-clock.js';
import { simulateGridChaos, type GridChaosTopology } from './grid-chaos-driver.js';
import { createGridChaosLedgerAdapter, createGridLedger, type GridCaps, type GridLeaseInput } from './grid-ledger.js';

const caps: GridCaps = { trainShards: 2, gatePods: 2, taPods: 1, taParents: 1, remoteGateSlots: 1 };
const grid = { id: 'g1', hosts: [{ host: 'test-context', capacity: 2 }], caps };
const lease = (fp: string, overrides: Partial<GridLeaseInput> = {}): GridLeaseInput => ({
  fp, grid: 'g1', host: 'test-context', lane: 'ta', mission: { cell: 'SIM-DEV-GRID-LEDGER', pr: 34325, goalId: 'grid-ledger' }, ...overrides,
});

describe('grid-ledger', () => {
  test('createLease ignores untyped terminal fields and keeps the lease capacity-accounted', () => {
    const ledger = createGridLedger({ now: () => Date.parse('2026-11-02T00:00:00.000Z') });
    ledger.registerGrid(grid);
    const widenedInput = { ...lease('fp-extra'), endedAt: '2026-11-02T00:00:01.000Z' };
    const created = ledger.createLease(widenedInput);
    expect(created).not.toHaveProperty('endedAt');
    expect(ledger.who({ host: 'test-context' }).leases[0]).toMatchObject({ state: 'active' });
    expect(() => ledger.createLease(lease('fp-capacity'))).toThrow('grid-capacity-exceeded:taPods');
  });

  test('creates leases, rejects duplicate claims, and enforces host and lane capacities', () => {
    const ledger = createGridLedger({ now: () => Date.parse('2026-11-02T00:00:00.000Z') });
    ledger.registerGrid(grid);
    expect(() => ledger.registerGrid(grid)).toThrow('duplicate-grid');
    const substitutedCaps = { trainShards: 2, gatePods: 2, taTasks: 1, taParents: 1, remoteGateSlots: 1 } as unknown as GridCaps;
    expect(() => ledger.registerGrid({ ...grid, id: 'bad-grid', caps: substitutedCaps })).toThrow('invalid-grid-cap-shape');
    const missingCap = { trainShards: 2, gatePods: 2, taParents: 1, remoteGateSlots: 1 } as unknown as GridCaps;
    expect(() => ledger.registerGrid({ ...grid, id: 'missing-cap-grid', caps: missingCap })).toThrow('invalid-grid-cap-shape');
    expect(ledger.createLease(lease('fp-1'))).toMatchObject({ fp: 'fp-1', since: '2026-11-02T00:00:00.000Z', heartbeatAt: '2026-11-02T00:00:00.000Z' });
    expect(() => ledger.createLease(lease('fp-1'))).toThrow('duplicate-fingerprint');
    expect(() => ledger.createLease(lease('fp-2'))).toThrow('grid-capacity-exceeded:taPods');
    expect(() => ledger.createLease(lease('fp-3', { lane: 'hand', mission: { cell: 'cell-2' } }))).not.toThrow();
    expect(() => ledger.createLease(lease('fp-4', { lane: 'hand', mission: { cell: 'cell-3' } }))).toThrow('host-capacity-exceeded');
  });

  test('heartbeat advances a live lease; who(host|cell|pr) distinguishes active, expired, and ended', () => {
    let clock = Date.parse('2026-11-02T00:00:00.000Z');
    const ledger = createGridLedger({ now: () => clock, heartbeatTtlMs: 1_000 });
    ledger.registerGrid(grid);
    ledger.createLease(lease('fp-live'));
    expect(ledger.who({ host: 'test-context' }).leases.map((row) => [row.lease.fp, row.state])).toEqual([['fp-live', 'active']]);
    expect(ledger.who({ cell: 'SIM-DEV-GRID-LEDGER' }).leases[0]?.lease.fp).toBe('fp-live');
    expect(ledger.who({ pr: 34325 }).leases[0]?.lease.fp).toBe('fp-live');
    clock += 1_001;
    expect(ledger.who({ host: 'test-context' }).leases[0]?.state).toBe('expired');
    expect(() => ledger.createLease(lease('fp-replacement'))).toThrow('grid-capacity-exceeded:taPods');
    const renewed = ledger.heartbeat('fp-live');
    expect(renewed.heartbeatAt).toBe(new Date(clock).toISOString());
    expect(ledger.who({ host: 'test-context' }).leases[0]?.state).toBe('active');
    clock += 10;
    expect(ledger.endLease('fp-live')).toBe(true);
    expect(ledger.endLease('fp-live')).toBe(false);
    expect(ledger.who({ host: 'test-context' }).leases[0]).toMatchObject({ state: 'ended', lease: { fp: 'fp-live', endedAt: new Date(clock).toISOString() } });
    expect(() => ledger.heartbeat('fp-live')).toThrow('lease-ended');
    expect(ledger.createLease(lease('fp-replacement'))).toMatchObject({ fp: 'fp-replacement' });
  });

  test('resource summary compares ledger occupancy to fake kubectl and preserves an unmeasured reading', () => {
    const ledger = createGridLedger({ now: () => Date.parse('2026-11-02T00:00:00.000Z') });
    ledger.registerGrid(grid);
    ledger.createLease(lease('fp-observed'));
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '16Gi', cpu: '8' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: {} }] }), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'job-1', labels: { 'elanous.substrate': 'pod' }, annotations: { 'elanous.dev/host-lease-admitted': 'true' } } }] }), stderr: '' };
      if (args.includes('pods')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'pod-1', namespace: 'elanous-test', labels: { 'elanous.substrate': 'pod', 'elanous.job': 'job-1' } }, status: { phase: 'Running' }, spec: { nodeName: 'node-1', containers: [{ resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } } }] } }] }), stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected kubectl call' };
    };
    const measured = buildGridData({
      readHq: () => ({ record: null, ageSeconds: null, expired: null, reason: null }),
      poolSpec: () => 'test-context:2',
      kubectl,
    });
    expect(measured.members[0]).toMatchObject({ running: 1, pending: 0, occupied: 1, capacity: 2, reason: null });
    expect(ledger.resourceSummary('g1', measured).hosts[0]).toMatchObject({ ledgerLeases: 1, byLane: { ta: 1 }, observedOccupied: 1, measurement: 'measured', difference: 0 });

    const unmeasured = buildGridData({
      readHq: () => ({ record: null, ageSeconds: null, expired: null, reason: null }),
      poolSpec: () => 'test-context:2',
      kubectl: () => { throw new Error('metrics unavailable'); },
    });
    expect(ledger.resourceSummary('g1', unmeasured).hosts[0]).toMatchObject({ ledgerLeases: 1, observedOccupied: null, measurement: 'unmeasured', difference: null });
    expect(ledger.resourceSummary('g1', unmeasured).hosts[0]?.reason).toContain('metrics unavailable');
  });

  test('chaos-driver applyLoss seam ends the actual leases selected by session identity', () => {
    const ledger = createGridLedger({ now: () => Date.parse('2026-11-02T00:00:00.000Z') });
    ledger.registerGrid(grid);
    ledger.createLease(lease('fp-session-1'));
    ledger.createLease(lease('fp-session-2', { lane: 'hand' }));
    const adapter = createGridChaosLedgerAdapter(ledger, { grids: [{ id: 'g1', hosts: [{ id: 'test-context', sessions: [
      { id: 'session-1', leaseId: 'fp-session-1' }, { id: 'session-2', leaseId: 'fp-session-2' },
    ] }] }] });

    expect(adapter.applyLoss({ affectedSessionIds: ['session-2'], targetGridId: 'g1', targetHostIds: ['test-context'] })).toEqual(['fp-session-2']);
    expect(ledger.who({ host: 'test-context' }).leases.map(({ lease: row, state }) => [row.fp, state])).toEqual([
      ['fp-session-1', 'active'], ['fp-session-2', 'ended'],
    ]);
    expect(adapter.applyLoss({ affectedSessionIds: ['session-2'], targetGridId: 'g1', targetHostIds: ['test-context'] })).toEqual([]);
    expect(() => adapter.applyLoss({ affectedSessionIds: ['unknown-session'], targetGridId: 'g1', targetHostIds: ['test-context'] })).toThrow('unknown chaos session');
    const missingLease = createGridChaosLedgerAdapter(ledger, { grids: [{ id: 'g1', hosts: [{ id: 'test-context', sessions: [
      { id: 'valid', leaseId: 'fp-session-1' }, { id: 'missing', leaseId: 'fp-missing' },
    ] }] }] });
    expect(() => missingLease.applyLoss({ affectedSessionIds: ['valid', 'missing'], targetGridId: 'g1', targetHostIds: ['test-context'] })).toThrow('unknown chaos lease');
    expect(ledger.who({ host: 'test-context' }).leases.find(({ lease: row }) => row.fp === 'fp-session-1')?.state).toBe('active');
  });

  test('chaos-driver rejects a lease whose real location differs from the targeted session before mutating', () => {
    const ledger = createGridLedger({ now: () => Date.parse('2026-11-02T00:00:00.000Z') });
    ledger.registerGrid({ ...grid, hosts: [{ host: 'actual-host', capacity: 2 }] });
    ledger.createLease(lease('fp-misplaced', { host: 'actual-host' }));
    const misplacedTopology = { grids: [{ id: 'g1', hosts: [{ id: 'target-host', sessions: [
      { id: 'session-target', leaseId: 'fp-misplaced' },
    ] }] }] };
    const adapter = createGridChaosLedgerAdapter(ledger, misplacedTopology);

    expect(() => adapter.applyLoss({ affectedSessionIds: ['session-target'], targetGridId: 'g1', targetHostIds: ['target-host'] }))
      .toThrow('chaos lease location mismatch: fp-misplaced');
    expect(ledger.who({ host: 'actual-host' }).leases[0]?.state).toBe('active');
  });

  test('seeded chaos driver ends selected leases in the actual grid ledger', async () => {
    const hostRows: Array<{ grid: string; host: string; sessionId: string; leaseId: string }> = [];
    const topology: GridChaosTopology = {
      headquartersGridId: 'g0',
      grids: ['g0', 'g1', 'g2'].map(gridId => ({ id: gridId, hosts: [0, 1].map(hostIndex => {
        const host = `${gridId}-host-${hostIndex}`;
        const sessionId = `${host}-session`;
        const leaseId = `${host}-lease`;
        hostRows.push({ grid: gridId, host, sessionId, leaseId });
        return { id: host, sessions: [{ id: sessionId, processId: `${sessionId}-process`, leaseId,
          podDeathScenario: podDeathAfterPartialScenario({ job: `${host}-job`, runId: `${host}-run` }) }] };
      }) })),
    };
    const epoch = Date.parse('2026-11-02T00:00:00.000Z');
    await withSimClock(epoch, async clock => {
      const actualLedger = createGridLedger({ now: clock.now });
      for (const gridId of ['g0', 'g1', 'g2']) actualLedger.registerGrid({ id: gridId,
        hosts: hostRows.filter(row => row.grid === gridId).map(row => ({ host: row.host, capacity: 2 })), caps });
      for (const row of hostRows) actualLedger.createLease(lease(row.leaseId, { grid: row.grid, host: row.host, lane: 'hand' }));

      const result = simulateGridChaos({ seed: 7, topology, ledger: createGridChaosLedgerAdapter(actualLedger, topology), clock });
      const expectedTargets = [
        { attack: 'kong', leaseIds: ['g0-host-0-lease', 'g0-host-1-lease'] },
        { attack: 'monkey', leaseIds: ['g1-host-1-lease'] },
        { attack: 'gorilla', leaseIds: ['g2-host-0-lease', 'g2-host-1-lease'] },
      ];
      expect(JSON.stringify(result.events.map(event => ({ attack: event.attack, leaseIds: event.affectedLeaseIds })))).toBe(JSON.stringify(expectedTargets));
      const ended = new Set(expectedTargets.flatMap(event => event.leaseIds));
      expect(result.duplicateLeaseLosses).toEqual([]);
      for (const row of hostRows) {
        const state = actualLedger.who({ host: row.host }).leases[0]?.state;
        expect(state).toBe(ended.has(row.leaseId) ? 'ended' : 'active');
      }
    });
  });
});
