import { expect, test } from 'bun:test';
import { withSimClock } from './fake-clock.js';
import { createPodFederationSim } from './pod-federation-sim.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { CLOUD_MONTHLY_BUDGET_KRW } from '../fleet/burst-auto-within-budget.js';
import { registerInventoryResource } from '../fleet/resource-inventory.js';

// Source: 내부 문서 `pod-federation-mapreduce` §5 specifies a virtual 15-minute cloud join.
const CLOUD_JOIN_MS = 15 * 60_000;

async function replay() {
  return withSimClock(Date.parse('2026-11-09T00:00:00.000Z'), async (clock) => {
    const sim = createPodFederationSim();
    const first = await sim.place({ runId: 'run-a', nodeId: 'build' });
    const second = await sim.place({ runId: 'run-b', nodeId: 'test' });
    const gate = await sim.place({ runId: 'run-gate', nodeId: 'shard', gate: true });
    expect(first?.host).toBe('minim5');
    expect(second?.host).toBe('mshq');
    expect(gate?.host).toBe('gate');
    expect(sim.bindings().filter((row) => !row.gate).every((row) => row.host !== 'gate')).toBe(true);

    const recovered = await sim.hostDown('minim5');
    expect(recovered).toEqual([{ runId: 'run-a', nodeId: 'build', attempt: 2, host: 'mshq' }]);
    expect(sim.finish({ runId: 'run-a', nodeId: 'build', attempt: 1, pieceId: 'piece-a' })).toBe('stale-attempt');
    expect(await sim.place({ runId: 'run-cloud', nodeId: 'analysis' })).toBeNull();
    expect(sim.lostWork()).toEqual([{ runId: 'run-cloud', nodeId: 'analysis' }]);

    sim.startCloudBurst();
    expect(sim.joinCloud()).toBe(false);
    clock.tick(CLOUD_JOIN_MS - 1);
    expect(sim.joinCloud()).toBe(false);
    clock.tick(1);
    expect(sim.joinCloud()).toBe(true);
    expect(await sim.resumeWaiting()).toEqual([{ runId: 'run-cloud', nodeId: 'analysis', attempt: 1, host: 'cloud' }]);
    expect(sim.parkCloud()).toBe(false);
    expect(sim.finish({ runId: 'run-a', nodeId: 'build', attempt: 2, pieceId: 'piece-a' })).toBe('accepted');
    expect(sim.finish({ runId: 'run-a', nodeId: 'build', attempt: 2, pieceId: 'piece-a' })).toBe('already-accepted');
    await expect(sim.place({ runId: 'run-a', nodeId: 'build' })).rejects.toThrow('cannot be reused');
    expect(sim.finish({ runId: 'run-cloud', nodeId: 'analysis', attempt: 1, pieceId: 'piece-cloud' })).toBe('accepted');
    expect(sim.parkCloud()).toBe(true);
    expect(sim.cloudStatus().state).toBe('parked');
    expect(sim.lostWork()).toEqual([]);
    // Source: 내부 문서 `pod-federation-mapreduce` §5 requires the fake fleet boundary to be exercised.
    expect(sim.fleetCalls().length).toBeGreaterThan(0);
    return sim.bindings();
  });
}

test('real PodPoolScheduler federates hosts, recovers host loss, protects gate, and joins cloud after 15 virtual minutes', async () => {
  expect(await replay()).toEqual(await replay());
});

test('a full gate lane waits even while task hosts have room', async () => {
  await withSimClock(Date.parse('2026-11-09T00:00:00.000Z'), async () => {
    const sim = createPodFederationSim();
    expect((await sim.place({ runId: 'gate-1', nodeId: 'shard', gate: true }))?.host).toBe('gate');
    expect(await sim.place({ runId: 'gate-2', nodeId: 'shard', gate: true })).toBeNull();
    expect((await sim.place({ runId: 'task-1', nodeId: 'build' }))?.host).toBe('minim5');
    expect(sim.lostWork()).toEqual([{ runId: 'gate-2', nodeId: 'shard' }]);
  });
});

test('a parked cloud VM can warm again for a later queued task', async () => {
  await withSimClock(Date.parse('2026-11-09T00:00:00.000Z'), async (clock) => {
    const sim = createPodFederationSim();
    await sim.place({ runId: 'a', nodeId: 'work' });
    await sim.place({ runId: 'b', nodeId: 'work' });
    await sim.place({ runId: 'c', nodeId: 'work' });
    expect(await sim.place({ runId: 'd', nodeId: 'work' })).toBeNull();
    sim.startCloudBurst();
    clock.tick(CLOUD_JOIN_MS);
    expect(sim.joinCloud()).toBe(true);
    expect((await sim.resumeWaiting()).map((row) => row.host)).toEqual(['cloud']);
    expect(sim.finish({ runId: 'd', nodeId: 'work', attempt: 1, pieceId: 'd' })).toBe('accepted');
    expect(sim.parkCloud()).toBe(true);

    expect(await sim.place({ runId: 'e', nodeId: 'work' })).toBeNull();
    sim.startCloudBurst();
    expect(sim.joinCloud()).toBe(false);
    clock.tick(CLOUD_JOIN_MS);
    expect(sim.joinCloud()).toBe(true);
    expect((await sim.resumeWaiting()).map((row) => row.host)).toEqual(['cloud']);
  });
});

test('automatic cloud burst waits for the budgeted admission window, joins after warm-up, then stops at zero demand without termination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-federation-auto-burst-'));
  try {
    await withSimClock(Date.parse('2026-11-10T00:00:00.000Z'), async (clock) => {
      const deniedSim = createPodFederationSim();
      const deniedLedger = new ResourceLedger(join(root, 'denied'));
      const now = Date.now();
      registerInventoryResource({ id: 'monthly-spend', machine: 'gcp2', name: 'monthly-spend', provider: 'gcp', ownerSeat: 'OP',
        role: 'gate', purpose: 'measured month usage', hourlyCost: 300_000, startSignedAt: now - 10 * 60 * 60_000 }, deniedLedger, now);
      // Source: 내부 문서 `CONDUCTOR` §6c — measured usage exceeds the monthly cap.
      const denied = await deniedSim.reconcileAutomaticBurst({ requestId: 'denied-burst', owner: 'NT-3', host: 'aws2', purpose: 'execution',
        now, queueDepth: 4, blockedCount: 1, threshold: 1, imageDigest: `sha256:${'c'.repeat(64)}`, hourlyCostKrw: 100_000, ttlHours: 2 }, deniedLedger); // Source: 내부 문서 `CONDUCTOR` §6c.
      expect(denied.state).toBe('budget-blocked');
      expect(deniedSim.cloudEvents()).toEqual([]);

      const sim = createPodFederationSim();
      const ledger = new ResourceLedger(root);
      const jobs = [];
      for (const [runId, nodeId] of [['auto-1', 'a'], ['auto-2', 'b'], ['auto-3', 'c'], ['auto-4', 'd']] as const)
        if (runId !== 'auto-4') jobs.push(await sim.place({ runId, nodeId }));
      expect(jobs.every(Boolean)).toBe(true);
      // Source: 내부 문서 `pod-federation-mapreduce` §2 — demand crosses the simulated admission threshold.
      const burst = { requestId: 'pod-burst-1', owner: 'NT-3', host: 'aws2' as const, purpose: 'execution' as const,
        now: Date.now(), queueDepth: 2, blockedCount: 2, threshold: 2, imageDigest: `sha256:${'c'.repeat(64)}`, // Source: 내부 문서 `pod-federation-mapreduce` §2.
        hourlyCostKrw: 100_000, ttlHours: 2 as const }; // Source: 내부 문서 `pod-federation-mapreduce` §2.
      sim.connectAutomaticBurst(burst, ledger);
      expect(await sim.place({ runId: 'auto-4', nodeId: 'd' })).toBeNull();
      await sim.waitAutomaticBurst();
      expect(await sim.reconcileAutomaticBurst({ ...burst, threshold: 3 }, ledger)).toMatchObject({ state: 'below-threshold' }); // Source: 내부 문서 `pod-federation-mapreduce` §2.
      expect(await sim.place({ runId: 'auto-5', nodeId: 'e' })).toBeNull();
      await sim.waitAutomaticBurst();
      expect(await sim.reconcileAutomaticBurst({ ...burst, now: Date.now() }, ledger)).toMatchObject({ state: 'warming', admissionAt: Date.now() + 60 * 60_000 }); // Source: CONDUCTOR §6c schedules admission one hour after reservation.
      const reservation = ledger.list({ kind: 'universe' }).find(row => row.attrs.type === 'burst-auto-budget-decision');
      // Source: CONDUCTOR §6c requires a positive reservation inside the monthly cap.
      expect(Number(reservation?.attrs.reservedKrw)).toBeGreaterThan(0); // Source: 내부 문서 `CONDUCTOR` §6c.
      expect(Number(reservation?.attrs.reservedKrw)).toBeLessThanOrEqual(CLOUD_MONTHLY_BUDGET_KRW);
      expect((await sim.reconcileAutomaticBurst({ ...burst, now: Date.now() }, ledger)).state).toBe('warming');
      clock.tick(15 * 60_000);
      expect((await sim.reconcileAutomaticBurst({ ...burst, now: Date.now() }, ledger)).state).toBe('waiting-for-admission');
      clock.tick(45 * 60_000);
      expect((await sim.reconcileAutomaticBurst({ ...burst, now: Date.now() }, ledger)).state).toBe('admitted');
      sim.resetCloudAdmission();
      expect(sim.cloudMemberCapacity()).toBe(0);
      expect((await sim.reconcileAutomaticBurst({ ...burst, now: Date.now() }, ledger)).state).toBe('admitted');
      expect(sim.cloudMemberCapacity()).toBeGreaterThan(0); // Source: 내부 문서 `pod-federation-mapreduce` §2 — admission restores configured worker capacity.
      expect((await sim.resumeWaiting()).map(row => row.host)).toEqual(['cloud', 'cloud']);
      // Source: a cloud worker stays withdrawn while its admitted lease drains; renewed demand cannot readmit it early.
      await sim.reconcilePoolDemand('admitted waiters drained');
      expect(ledger.list({ kind: 'universe' }).find(row => row.id === 'fleet-cloud-burst:pod-burst-1')?.attrs.state).toBe('draining');
      await sim.reconcilePoolDemand('still-held leases remain');
      expect(ledger.list({ kind: 'universe' }).find(row => row.id === 'fleet-cloud-burst:pod-burst-1')?.attrs.state).toBe('draining');
      expect(sim.cloudStatus().state).toBe('ready');
      expect(sim.cloudStatus().activeLeases).toBe(2);
      expect(sim.finish({ runId: 'auto-4', nodeId: 'd', attempt: 1, pieceId: 'auto-piece' })).toBe('accepted');
      expect(sim.finish({ runId: 'auto-5', nodeId: 'e', attempt: 1, pieceId: 'auto-piece-2' })).toBe('accepted');
      await sim.reconcilePoolDemand('all active leases finished');
      expect(ledger.list({ kind: 'universe' }).find(row => row.id === 'fleet-cloud-burst:pod-burst-1')?.attrs.state).toBe('stopped');
      expect(sim.cloudStatus().state).toBe('parked');
      expect(sim.cloudStatus().activeLeases).toBe(0);
      expect(sim.cloudEvents().filter(event => event.type === 'forbidden-terminate')).toHaveLength(0);
      expect(sim.fleetCalls().length).toBeGreaterThan(Number.MIN_VALUE);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
