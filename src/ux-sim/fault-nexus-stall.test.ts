import { describe, expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { buildGridData } from '../nexus/api/grid.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { runFaultNexusStallCase, runFaultNexusStallScenario, runNexusStallContract, type NexusStallPort } from './fault-nexus-stall.js';

const gridDeps = (kubectl: ReturnType<typeof createFakeKubectl>['kubectl']) => ({
  readHq: () => ({ record: null, ageSeconds: null, expired: null }),
  poolSpec: () => 'fake-context:2',
  kubectl,
});

const makeFake = (options: { hangMs?: number; unreachable?: boolean } = {}) => createFakeKubectl({
  context: 'fake-context', node: 'fake-node', ...options,
});

describe('SIM-NEXUS-CHAOS fake kubectl integration', () => {
  test('buildGridData uses the existing synchronous kubectl boundary and preserves the healthy default', () => {
    const fake = makeFake();
    const result = buildGridData(gridDeps(fake.kubectl));

    expect(result.members).toMatchObject([{
      context: 'fake-context', capacity: 2, running: 0, pending: 0, occupied: 0, reason: null,
    }]);
    expect(fake.calls).toHaveLength(3);
  });

  test('buildGridData observes a finite synchronous kubectl stall and retains call records', () => {
    const fake = makeFake({ hangMs: 20 });
    const started = performance.now();
    const result = buildGridData(gridDeps(fake.kubectl));
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.members[0]).toMatchObject({ running: 0, pending: 0, reason: null });
    expect(fake.calls).toHaveLength(3);
  });

  test('accepts the finite synchronous stall upper bound and rejects values beyond it', () => {
    expect(() => makeFake({ hangMs: 1_000 })).not.toThrow();
    for (const hangMs of [1_001, 1e308, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeFake({ hangMs })).toThrow('fake-kubectl hangMs must be between 0 and 1000 milliseconds');
    }
  });

  test('grid lag uses the pre-work ping while loop-edge lag overlaps active worker projection', async () => {
    const result = await runFaultNexusStallCase({ hangMs: 20, unreachable: false, maxLagMs: 2_000, ledgerRows: 0 });

    expect(result.kubectlCalls).toBe(3);
    expect(result.gridEventLoopLagMs).toBeGreaterThanOrEqual(50);
    expect(result.gridEventLoopLagMs).toBeLessThan(2_000);
    expect(result.eventLoopLagMs).toBeLessThan(50);
  });

  test('production stall scenario returns bounded lag samples for each contract case', async () => {
    const result = await runFaultNexusStallScenario({ maxLagMs: 2_000 });
    expect(result.observations).toHaveLength(3);
    expect(result.observations.every((observation) => observation.passed)).toBe(true);
    expect(result.observations.map((observation) => observation.hostReady)).toEqual([false, false, true]);
    expect(result.observations.every((observation) => observation.kubectlCalls === 3)).toBe(true);
    expect(result.observations.every((observation) => observation.loopEdgeCount === 1 && observation.syntheticLedgerRows === 20_000)).toBe(true);
    expect(result.samples).toHaveLength(3);
    expect(result.maxLagMs).toBe(Math.max(...result.samples));
  });

  test('contract rejects incorrect unreachable, host and production grid observations', async () => {
    const incorrectPort: NexusStallPort = async () => ({
      kubectlCalls: 3,
      hostReady: true,
      leaseSchedulableNodes: 5,
      gridEventLoopLagMs: 0,
      eventLoopLagMs: 0,
      loopEdgeRefreshOverlapped: true,
      dashboardMaxLagMs: 0,
      loopEdgeCount: 0,
      syntheticLedgerRows: 1_000,
      maxLagMs: 1_000,
      grid: {
        hq: { record: null, ageSeconds: null, expired: null, reason: null },
        members: [{ context: 'fake-context', capacity: 2, running: 0, pending: 0, occupied: 0, reason: null }],
        poolReason: null,
      },
    });
    const observations = await runNexusStallContract(incorrectPort);

    expect(observations.map((observation) => observation.passed)).toEqual([false, false, false]);
  });

  test('a down host changes what the production lease measurement reports', async () => {
    const down = await runFaultNexusStallCase({ hangMs: 0, unreachable: false, maxLagMs: 2_000, ledgerRows: 0, hostDown: true });
    const up = await runFaultNexusStallCase({ hangMs: 0, unreachable: false, maxLagMs: 2_000, ledgerRows: 0, hostDown: false });
    expect(down.hostReady).toBe(false);
    expect(down.leaseSchedulableNodes).toBe(0);
    expect(up.leaseSchedulableNodes).toBe(1);
  });

  test('removing the injected kubectl stall fails the synchronous-delay contract case', async () => {
    const withoutStall = await runFaultNexusStallScenario({ maxLagMs: 2_000, hangMs: 0, ledgerRows: 0 });
    const delayCase = withoutStall.observations.find((observation) => observation.caseName.startsWith('synchronous delay'));
    expect(delayCase?.gridEventLoopLagMs).toBeLessThan(60);
    expect(delayCase?.passed).toBe(false);
  });

  // 반증 짝(MANUAL-ux-simulation-devices §4b): 수리 전 main 에서는 상한을 넘는다 → test.failing.
  // GRID-POD-LEASE-ASYNC 측정 주입은 동기 경계를 그대로 다루므로 이 계약은 아직 의도된 fail 이다.
  test.failing('GRID-POD-LEASE-ASYNC: a stalled kubectl must not block the ping beyond 50ms', async () => {
    const stalled = await runFaultNexusStallCase({ hangMs: 20, unreachable: false, maxLagMs: 50, ledgerRows: 0 });
    expect(stalled.gridEventLoopLagMs).toBeLessThan(50);
  });

  // LOOP-P-1 regression: a worker refresh of the large run-ledger set must not block the event loop.
  // loop-edges 는 5MB 넘는 파일을 건너뛰므로 «큰 원장»은 5MB 아래 파일 여럿(20 × 2만 줄)으로 만든다.
  test('LOOP-EDGES-ASYNC-CACHE: 20 ledger files of 20k rows must not block the ping beyond 50ms', async () => {
    const loaded = await runFaultNexusStallCase({ hangMs: 0, unreachable: false, maxLagMs: 50, ledgerRows: 20_000, ledgerFiles: 20 });
    expect(loaded.loopEdgeCount).toBe(20);
    expect(loaded.eventLoopLagMs).toBeLessThan(50);
    expect(loaded.loopEdgeRefreshOverlapped).toBe(true);
  });

  test('LOOP-EDGES-ASYNC-CACHE: the completion sample captures a delayed final loop turn', async () => {
    const loaded = await runFaultNexusStallCase({ hangMs: 0, unreachable: false, maxLagMs: 2_000, ledgerRows: 20_000, ledgerFiles: 20, loopEdgeCompletionStallMs: 60 });
    expect(loaded.eventLoopLagMs).toBeGreaterThanOrEqual(50);
    expect(loaded.loopEdgeRefreshOverlapped).toBe(true);
  });

  test('synchronous event-loop stall remains within the strict latency bound', async () => {
    const loaded = await runFaultNexusStallScenario({ maxLagMs: 50, hangMs: 0, ledgerRows: 20_000 });
    expect(loaded.observations.every(({ eventLoopLagMs }) => eventLoopLagMs < 50)).toBe(true);
  });

  test('buildGridData interprets unreachable kubectl as an unmeasured pool and records each call', () => {
    const fake = makeFake({ unreachable: true });
    const result = buildGridData(gridDeps(fake.kubectl));

    expect(result.members[0]).toMatchObject({ running: null, pending: null, occupied: null, reason: expect.stringContaining('unreachable') });
    expect(result.poolReason).toBeNull();
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]).toEqual(expect.arrayContaining(['--context', 'fake-context', '--request-timeout=10s', 'get', 'nodes', '-o', 'json']));
  });
});
