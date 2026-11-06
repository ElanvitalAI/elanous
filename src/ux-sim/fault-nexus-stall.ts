import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildGridData } from '../nexus/api/grid.js';
import { measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { createLoopEdgesDataSource } from '../nexus/api/loop-edges.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { runDashboardStreamingScenario } from './dashboard-event-loop-stall-monitor-device.js';

export interface NexusStallExpected {
  kubectlCalls: number;
  hostReady: boolean;
  /** Schedulable nodes the production lease measurement saw (null = unmeasured). A down host must drop to 0. */
  leaseSchedulableNodes: number | null;
  /** Lower bound on the ping lag: an injected synchronous stall must show up in it (0 = no lower bound). */
  minLagMs: number;
  loopEdgeCount: number;
  gridMember: { running: number | null; pending: number | null; reasonIncludes: string | null };
}

export interface NexusStallCase {
  name: string;
  input: {
    hangMs: number; unreachable: boolean; maxLagMs: number; ledgerRows?: number; hostDown?: boolean;
    /** Inject a parent event-loop pause before the worker-completion handler takes its final sample. */
    loopEdgeCompletionStallMs?: number;
    /** Ledger files of `ledgerRows` rows each. loop-edges skips files over 5MB, so a big ledger is many files under it. */
    ledgerFiles?: number;
  };
  expected: NexusStallExpected;
}

export const NEXUS_STALL_CONTRACT_CASES: readonly NexusStallCase[] = [
  {
    name: 'unreachable kubectl returns promptly and records each production request',
    input: { hangMs: 0, unreachable: true, maxLagMs: 1_000 },
    expected: { kubectlCalls: 3, hostReady: false, leaseSchedulableNodes: null, minLagMs: 0, loopEdgeCount: 1,
      gridMember: { running: null, pending: null, reasonIncludes: 'unreachable' } },
  },
  {
    name: 'synchronous delay is observed at the production grid boundary',
    input: { hangMs: 20, unreachable: false, maxLagMs: 2_000 },
    // 3 synchronous kubectl calls × 20ms land on the event loop before the ping callback runs (pre-GRID-POD-LEASE-ASYNC).
    expected: { kubectlCalls: 3, hostReady: false, leaseSchedulableNodes: 0, minLagMs: 60, loopEdgeCount: 1,
      gridMember: { running: 0, pending: 0, reasonIncludes: null } },
  },
  {
    name: 'healthy host stays schedulable in the production lease measurement',
    input: { hangMs: 0, unreachable: false, maxLagMs: 2_000, hostDown: false },
    expected: { kubectlCalls: 3, hostReady: true, leaseSchedulableNodes: 1, minLagMs: 0, loopEdgeCount: 1,
      gridMember: { running: 0, pending: 0, reasonIncludes: null } },
  },
];

export interface NexusStallObservation {
  caseName: string;
  passed: boolean;
  kubectlCalls: number;
  hostReady: boolean;
  leaseSchedulableNodes: number | null;
  /** The existing synchronous grid dependency seam; independent from the loop-edge worker measurement. */
  gridEventLoopLagMs: number;
  /** Ping lag while the loop-edge worker is actively projecting run ledgers. */
  eventLoopLagMs: number;
  loopEdgeRefreshOverlapped: boolean;
  dashboardMaxLagMs: number;
  loopEdgeCount: number;
  syntheticLedgerRows: number;
  maxLagMs: number;
  grid: ReturnType<typeof buildGridData>;
}

export type NexusStallPort = (input: NexusStallCase['input']) => Promise<Omit<NexusStallObservation, 'caseName' | 'passed'>>;

export async function runNexusStallContract(port: NexusStallPort, maxLagMs?: number): Promise<NexusStallObservation[]> {
  const observations: NexusStallObservation[] = [];
  for (const contractCase of NEXUS_STALL_CONTRACT_CASES) {
    const input = maxLagMs === undefined ? contractCase.input : { ...contractCase.input, maxLagMs };
    const actual = await port(input);
    const member = actual.grid.members[0];
    observations.push({
      ...actual,
      caseName: contractCase.name,
      passed: actual.kubectlCalls === contractCase.expected.kubectlCalls
        && actual.gridEventLoopLagMs < input.maxLagMs
        && actual.eventLoopLagMs < 50
        && actual.loopEdgeRefreshOverlapped
        // The lower bound comes from the contract case itself, so removing the injected stall fails this case.
        && actual.gridEventLoopLagMs >= contractCase.expected.minLagMs
        && actual.hostReady === contractCase.expected.hostReady
        && actual.leaseSchedulableNodes === contractCase.expected.leaseSchedulableNodes
        && actual.loopEdgeCount === contractCase.expected.loopEdgeCount
        && member?.running === contractCase.expected.gridMember.running
        && member?.pending === contractCase.expected.gridMember.pending
        && (contractCase.expected.gridMember.reasonIncludes === null
          ? member?.reason === null
          : member?.reason?.includes(contractCase.expected.gridMember.reasonIncludes) === true),
    });
  }
  return observations;
}

export async function runFaultNexusStallCase(input: NexusStallCase['input']): Promise<Omit<NexusStallObservation, 'caseName' | 'passed'>> {
  const fake = createFakeKubectl({ context: 'fake-context', node: 'fake-node',
    hangMs: input.hangMs, unreachable: input.unreachable });
  if (input.hostDown ?? true) fake.setHostState({ ready: false, egress: false });
  let leaseSchedulableNodes: number | null = null;
  const syntheticLedgerRows = input.ledgerRows ?? 20_000;
  const ledgerFiles = input.ledgerFiles ?? 1;
  if (!Number.isSafeInteger(ledgerFiles) || ledgerFiles < 1 || ledgerFiles > 500) throw new Error('ledgerFiles must be an integer between 1 and 500');
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'fault-nexus-stall-'));
  try {
    for (let file = 1; file <= ledgerFiles; file++) {
      const runId = `run-00000000-0000-4000-8000-${String(file).padStart(12, '0')}`;
      const facts = Array.from({ length: syntheticLedgerRows }, (_, index) => JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        runId,
        event: index === 0 ? 'start' : 'observation',
        data: { index, payload: 'x'.repeat(64), ...(index === 0 ? { seat: 'UX' } : {}) },
      }));
      writeFileSync(join(ledgerRoot, `${runId}.jsonl`), `${facts.join('\n')}\n`, 'utf8');
    }
    const pingScheduledAt = performance.now();
    const eventLoopLag = new Promise<number>((resolve) => {
      setTimeout(() => resolve(Math.max(0, performance.now() - pingScheduledAt)), 0);
    });
    const grid = buildGridData({
      readHq: () => ({ record: null, ageSeconds: null, expired: null }),
      poolSpec: () => 'fake-context:2',
      // Same production measurement buildGridData would run by default; wrapped only to observe the host-down effect.
      measure: (pool) => {
        const measured = measurePoolLease(pool, { skipDnsProbe: true, kubectl: fake.kubectl });
        leaseSchedulableNodes = measured.members[0]?.availableMemoryByNodeBytes?.length ?? null;
        return measured;
      },
    });
    const gridEventLoopLagMs = await eventLoopLag;
    const edgeRequest = new Request('http://localhost/v1/loops/edges?since=1970-01-01T00:00:00.000Z&limit=500');
    let resolveRefreshStarted!: () => void;
    let rejectRefreshStarted!: (error: Error) => void;
    const refreshStarted = new Promise<void>((resolve, reject) => {
      resolveRefreshStarted = resolve;
      rejectRefreshStarted = reject;
    });
    let eventLoopLagDuringRefresh!: Promise<number>;
    let finishLoopEdgeSampler: (() => void) | null = null;
    let loopEdgeRefreshOverlapped = false;
    const edges = createLoopEdgesDataSource({
      workerOptions: { ledgerDir: ledgerRoot, seatIds: ['UX'], isolatedSources: true },
      onRefreshWorkStarted: (isWorkerComputing) => {
        eventLoopLagDuringRefresh = new Promise<number>((resolve) => {
          const intervalMs = 5;
          let expectedAt = performance.now() + intervalMs;
          let maxLag = 0;
          let settled = false;
          let timer: ReturnType<typeof setInterval>;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            const sampledAt = performance.now();
            maxLag = Math.max(maxLag, Math.max(0, sampledAt - expectedAt));
            clearInterval(timer);
            resolve(maxLag);
          };
          timer = setInterval(() => {
            const computingAtSampleStart = isWorkerComputing();
            const sampledAt = performance.now();
            maxLag = Math.max(maxLag, sampledAt - expectedAt);
            expectedAt = sampledAt + intervalMs;
            const computing = isWorkerComputing();
            if (computingAtSampleStart || computing) {
              loopEdgeRefreshOverlapped = true;
            }
          }, intervalMs);
          finishLoopEdgeSampler = () => {
            // Include a final latency sample without inventing a compute-overlap observation.
            finish();
          };
        });
        resolveRefreshStarted();
      },
      onRefreshWorkFailed: () => {
        finishLoopEdgeSampler?.();
        rejectRefreshStarted(new Error('loop-edge worker ended before refresh started'));
      },
      onRefreshWorkCompleted: () => {
        const completionStallMs = input.loopEdgeCompletionStallMs ?? 0;
        if (completionStallMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, completionStallMs);
        }
        finishLoopEdgeSampler?.();
      },
    });
    await edges.read(edgeRequest).json();
    await refreshStarted;
    const eventLoopLagMs = await eventLoopLagDuringRefresh;
    await edges.waitForRefresh(edgeRequest);
    const loopEdgeCount = ((await edges.read(edgeRequest).json()) as { edges: unknown[] }).edges.length;
    edges.close();
    const dashboard = runDashboardStreamingScenario({ keypresses: 1, workerEventsPerKey: 1 });
    return { kubectlCalls: fake.calls.length, hostReady: fake.hostState().ready, leaseSchedulableNodes, gridEventLoopLagMs, eventLoopLagMs, loopEdgeRefreshOverlapped, dashboardMaxLagMs: dashboard.maxLagMs,
      loopEdgeCount, syntheticLedgerRows, maxLagMs: input.maxLagMs, grid };
  } finally {
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
}

export interface NexusStallScenarioResult {
  observations: NexusStallObservation[];
  samples: number[];
  maxLagMs: number;
}

export async function runFaultNexusStallScenario(options: { maxLagMs?: number; hangMs?: number; ledgerRows?: number } = {}): Promise<NexusStallScenarioResult> {
  const maxLagMs = options.maxLagMs ?? 2_000;
  if (!Number.isFinite(maxLagMs) || maxLagMs <= 0) throw new Error('maxLagMs must be a positive finite number');
  const observations = await runNexusStallContract((input) => runFaultNexusStallCase({
    ...input,
    ...(options.hangMs === undefined ? {} : { hangMs: options.hangMs }),
    ...(options.ledgerRows === undefined ? {} : { ledgerRows: options.ledgerRows }),
  }), maxLagMs);
  const samples = observations.map(({ eventLoopLagMs }) => eventLoopLagMs);
  return { observations, samples, maxLagMs: samples.reduce((maximum, sample) => Math.max(maximum, sample), 0) };
}
