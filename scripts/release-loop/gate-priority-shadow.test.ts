import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from '../../src/debug/log.js';
import { HostPoolLease } from '../../src/pod-lease/host-lease.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { PoolLeaseRecommendation } from '../../src/task-orchestrator/surfaces/pod-lease.js';
import { admitGateShard, gatePriorityShadowDecision, poolGateAdmission, type GatePriorityShadowDecision } from './gate-node';

function poolReading(recommended: number, pending: number): PoolLeaseRecommendation {
  return { recommended, limitedBy: 'capacity', reason: null, capacitySlots: 1, memorySlots: 1,
    placeableSlots: 1, accountSlots: null, running: 0, pending, pendingJobs: [], unleasedRunning: 0 };
}

function fixturePool(pending: () => number, recommended: () => number): { pool: PodPoolScheduler; cleanup: () => void } {
  const leaseRoot = mkdtempSync(join(tmpdir(), 'gate-priority-shadow-'));
  const pool = new PodPoolScheduler([{ context: 'fixture-context', sshHost: 'fixture-host', capacity: 1, k3dCluster: 'fixture' }], {
    status: () => poolReading(recommended(), pending()),
    pollMs: 5,
    hostLease: new HostPoolLease(`fixture-${randomUUID()}`, { dir: leaseRoot }),
  });
  return { pool, cleanup: () => rmSync(leaseRoot, { recursive: true, force: true }) };
}

test('GATE-PRIORITY shadow recommends gate-first in a real admission 1+1 fixture and both Pod records stay unchanged', async () => {
  const pods = [
    { runId: 'gate-run', host: 'fixture-host', phase: 'Pending' },
    { runId: 'harness-run', host: 'fixture-host', phase: 'Pending' },
  ];
  const before = structuredClone(pods);
  const readyAt = Date.now() + 40;
  let sawNoCapacity = false;
  const { pool, cleanup } = fixturePool(
    () => pods.filter((pod) => pod.phase === 'Pending').length,
    () => {
      const ready = Date.now() >= readyAt;
      if (!ready) sawNoCapacity = true;
      return ready ? 1 : 0;
    },
  );
  const events: GatePriorityShadowDecision[] = [];
  let release: (() => void) | undefined;
  try {
    const observation = (gateWaiting: boolean) => ({ gateRunId: pods[0]!.runId, host: pods[0]!.host,
      competingRunId: pods[1]!.runId, competingHost: pods[1]!.host,
      gateImageState: 'verified' as const, competingImageState: 'verified' as const,
      gateWaiting, lowerPriorityWaiting: true });
    const result = await admitGateShard(poolGateAdmission(pool, 'gate-run', observation), {
      waitMs: 1_000, firstReasonMs: 2, reasonPollMs: 5, onWait: () => {}, onPriorityShadow: (event) => events.push(event),
    });
    release = result.release;
    expect(result.outcome).toBe('granted');
    expect(result.waitedMs).toBeGreaterThan(0);
    expect(sawNoCapacity).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'gate-priority-shadow-decision', decision: 'gate-first',
      gateRunId: 'gate-run', host: 'fixture-host', competingRunId: 'harness-run',
      gateImageState: 'verified', competingImageState: 'verified',
      selectionRationale: 'same-host-contention-and-verified-gate-image; gate-policy-priority',
    });
    expect(pods).toEqual(before);
  } finally {
    release?.();
    cleanup();
  }
});

test('GATE-PRIORITY production observation uses known single-host data and emits unknown competitor/image once', async () => {
  const pods = [{ runId: 'gate-run', host: 'fixture-host', phase: 'Pending' },
    { runId: 'unidentified', host: 'fixture-host', phase: 'Pending' }];
  const before = structuredClone(pods);
  const readyAt = Date.now() + 30;
  const { pool, cleanup } = fixturePool(() => pods.filter((pod) => pod.phase === 'Pending').length,
    () => Date.now() >= readyAt ? 1 : 0);
  const events: GatePriorityShadowDecision[] = [];
  let release: (() => void) | undefined;
  try {
    const admission = poolGateAdmission(pool, 'gate-run');
    expect(admission.priorityShadowObservation?.(false)).toMatchObject({
      gateRunId: 'gate-run', host: 'fixture-host', competingRunId: null, competingHost: null,
      gateImageState: 'unknown', competingImageState: 'unknown', gateWaiting: false, lowerPriorityWaiting: null,
    });
    const result = await admitGateShard(admission, {
      waitMs: 1_000, firstReasonMs: 2, reasonPollMs: 5, onWait: () => {}, onPriorityShadow: (event) => events.push(event),
    });
    release = result.release;
    expect(result.outcome).toBe('granted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'insufficient-evidence', gateRunId: 'gate-run', host: 'fixture-host',
      competingRunId: null, gateImageState: 'unknown', competingImageState: 'unknown', gateWaiting: true,
      selectionRationale: 'lower-priority-wait-state-unknown' });
    expect(pods).toEqual(before);
  } finally {
    release?.();
    cleanup();
  }

  const leaseRoot = mkdtempSync(join(tmpdir(), 'gate-priority-multihost-'));
  try {
    const multiHost = new PodPoolScheduler([
      { context: 'fixture-a', sshHost: 'host-a', capacity: 1, k3dCluster: 'fixture-a' },
      { context: 'fixture-b', sshHost: 'host-b', capacity: 1, k3dCluster: 'fixture-b' },
    ], { status: () => poolReading(0, 0), hostLease: new HostPoolLease(`fixture-${randomUUID()}`, { dir: leaseRoot }) });
    expect(poolGateAdmission(multiHost, 'gate-run').priorityShadowObservation?.(false).host).toBeNull();
  } finally {
    rmSync(leaseRoot, { recursive: true, force: true });
  }
});

test('GATE-PRIORITY production gate wait persists a run-attributed decision row', async () => {
  const previousLevel = debug.level();
  debug.setLevel('trail');
  const gateRunId = `run-${randomUUID()}`;
  const competingRunId = `run-${randomUUID()}`;
  const pods = [{ runId: gateRunId, host: 'fixture-host', phase: 'Pending' },
    { runId: competingRunId, host: 'fixture-host', phase: 'Pending' }];
  const before = structuredClone(pods);
  const readyAt = Date.now() + 30;
  const { pool, cleanup } = fixturePool(() => pods.filter((pod) => pod.phase === 'Pending').length,
    () => Date.now() >= readyAt ? 1 : 0);

  try {
    const admission = poolGateAdmission(pool, gateRunId, (gateWaiting) => ({
      gateRunId, host: 'fixture-host', competingRunId, competingHost: 'fixture-host',
      gateImageState: 'verified', competingImageState: 'verified', gateWaiting, lowerPriorityWaiting: true,
    }));
    const result = await admitGateShard(admission, {
      waitMs: 1_000, firstReasonMs: 2, reasonPollMs: 5, onWait: () => {},
    });
    expect(result.outcome).toBe('granted');
    expect(pods).toEqual(before);
    debug.flush();

    const rows = readFileSync(debug.path(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      category?: string; event?: string; data?: Record<string, unknown>;
    });
    expect(rows.find(({ category, event, data }) => category === 'release-loop.gate'
      && event === 'gate-priority-shadow-decision' && data?.gateRunId === gateRunId)).toMatchObject({
      category: 'release-loop.gate',
      event: 'gate-priority-shadow-decision',
      data: {
        gateRunId, host: 'fixture-host', competingRunId, decision: 'gate-first',
        gateImageState: 'verified', competingImageState: 'verified',
        selectionRationale: 'same-host-contention-and-verified-gate-image; gate-policy-priority',
      },
    });
  } finally {
    debug.setLevel(previousLevel);
    cleanup();
  }
});

test('GATE-PRIORITY shadow refuses gate-first when either image is not verified', () => {
  expect(gatePriorityShadowDecision({ gateRunId: 'gate', host: 'host', competingRunId: 'harness', competingHost: 'host',
    gateImageState: 'verified', competingImageState: 'mismatch', gateWaiting: true, lowerPriorityWaiting: true }))
    .toMatchObject({ decision: 'insufficient-evidence', selectionRationale: 'image-state-not-verified' });
});

test('GATE-PRIORITY immediate admission emits no wait observation', async () => {
  const events: GatePriorityShadowDecision[] = [];
  let observationReads = 0;
  const result = await admitGateShard({
    acquire: async () => () => {},
    waitReason: () => null,
    priorityShadowObservation: (gateWaiting) => {
      observationReads++;
      return { gateRunId: 'gate', host: 'host', competingRunId: null, competingHost: null,
        gateImageState: 'unknown', competingImageState: 'unknown', gateWaiting, lowerPriorityWaiting: null };
    },
  }, { waitMs: 500, firstReasonMs: 1, onWait: () => {}, onPriorityShadow: (event) => events.push(event) });

  expect(result.outcome).toBe('granted');
  expect(events).toHaveLength(0);
  expect(observationReads).toBe(0);
});
