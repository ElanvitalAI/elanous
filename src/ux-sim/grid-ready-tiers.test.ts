import { describe, expect, test } from 'bun:test';
import { withSimClock } from './fake-clock.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { createGridReadyTierExecutor, decideGridReadyTier, runGridReadyDemand, runGridReadyTierScenario } from './grid-ready-tiers.js';

const EPOCH = Date.parse('2026-11-02T00:00:00Z');
const IMAGE = 'sha256:grid-image';

function hosts(fleet: ReturnType<typeof createFakeCloudVm>) {
  return fleet.statusAll().map((vm) => ({ vm, maxLeases: 1 }));
}

describe('grid-ready-tiers over fake-cloud-vm', () => {
  test('uses ready capacity before stopped capacity and stops planning at zero demand', async () => {
    await withSimClock(EPOCH, () => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'hot-z', imageDigest: IMAGE, hourlyCost: 1 });
      fleet.createFromImage({ id: 'warm-a', imageDigest: IMAGE, hourlyCost: 1 });
      fleet.stop('warm-a');
      fleet.createFromImage({ id: 'wrong-hot', imageDigest: 'sha256:wrong', hourlyCost: 1 });

      expect(decideGridReadyTier({ demand: 2, hosts: hosts(fleet), imageDigest: IMAGE }))
        .toEqual({ tier: 'hot', action: 'lease', hostId: 'hot-z' });
      expect(decideGridReadyTier({ demand: 0, hosts: hosts(fleet), imageDigest: IMAGE })).toBeUndefined();
    });
  });

  test('S7 stopAfter drains leases and stops without termination', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'hot', imageDigest: IMAGE, hourlyCost: 36, stopAfterAt: EPOCH + 1_000 });
      const { fleet: resultFleet, decisions } = await runGridReadyDemand({
        demand: 1,
        imageDigest: IMAGE,
        maxLeases: 1,
        stopAfterAt: EPOCH + 1_000,
        waitUntilReady: async () => {},
      }, fleet);
      expect(decisions).toMatchObject([{ tier: 'hot', action: 'lease', hostId: 'hot' }]);
      clock.tick(1_000);

      expect(resultFleet.status('hot').state).toBe('draining');
      expect(() => resultFleet.openLease('hot')).toThrow('new lease refused');
      expect(resultFleet.closeLease('hot')).toMatchObject({ state: 'parked', activeLeases: 0, poweredOnMs: 1_000, estimatedCost: 0.01 });
      expect(resultFleet.events().filter((event) => event.type === 'stop')).toHaveLength(1);
      expect(resultFleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
    });
  });

  test('S13 resumes a parked VM for the burst window and returns it to stop after draining', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      const executor = createGridReadyTierExecutor(fleet);
      fleet.createFromImage({ id: 'warm', imageDigest: IMAGE, hourlyCost: 36 });
      fleet.stop('warm');

      const decision = decideGridReadyTier({ demand: 1, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: EPOCH + 1_000, warmReadyAfterMs: 100 });
      expect(decision).toMatchObject({ tier: 'warm', action: 'resume', hostId: 'warm', readyAfterMs: 100, stopAfterAt: EPOCH + 1_000 });
      if (!decision || decision.action !== 'resume') throw new Error('expected warm-stop resume decision');

      expect(executor.apply(decision)).toMatchObject({ state: 'warming', stopAfterAt: EPOCH + 1_000 });
      clock.tick(100);
      fleet.openLease('warm');
      clock.tick(900);
      expect(fleet.status('warm').state).toBe('draining');
      expect(fleet.closeLease('warm')).toMatchObject({ state: 'parked', poweredOnMs: 1_000, estimatedCost: 0.01 });
      expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
    });
  });

  test('S15 exhausts hot, resumes warm-stop, then provisions cold from the pinned image', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      const executor = createGridReadyTierExecutor(fleet);
      fleet.createFromImage({ id: 'hot', imageDigest: IMAGE, hourlyCost: 36 });
      fleet.createFromImage({ id: 'warm', imageDigest: IMAGE, hourlyCost: 36 });
      fleet.stop('warm');
      fleet.createFromImage({ id: 'wrong-image', imageDigest: 'sha256:old-image', hourlyCost: 36 });
      fleet.stop('wrong-image');
      fleet.createFromImage({ id: 'wrong-ready', imageDigest: 'sha256:old-image', hourlyCost: 36 });

      const burstEnd = EPOCH + 5_000;
      const first = decideGridReadyTier({ demand: 3, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: burstEnd });
      expect(first).toMatchObject({ tier: 'hot', action: 'lease', hostId: 'hot' });
      if (!first || first.action !== 'lease') throw new Error('expected hot lease decision');
      executor.apply(first);

      const second = decideGridReadyTier({ demand: 2, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: burstEnd, warmReadyAfterMs: 100 });
      expect(second).toMatchObject({ tier: 'warm', action: 'resume', hostId: 'warm', readyAfterMs: 100, stopAfterAt: burstEnd });
      if (!second || second.action !== 'resume') throw new Error('expected warm-stop resume decision');
      executor.apply(second);

      const whileWarming = decideGridReadyTier({ demand: 2, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: burstEnd });
      expect(whileWarming).toMatchObject({ tier: 'pending', action: 'wait', hostId: 'warm', readyAfterMs: 100 });
      if (!whileWarming || whileWarming.action !== 'wait') throw new Error('expected warming capacity wait');
      expect(executor.apply(whileWarming)?.state).toBe('warming');
      clock.tick(second.readyAfterMs);

      const resumedReady = decideGridReadyTier({ demand: 2, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: burstEnd });
      if (!resumedReady || resumedReady.action !== 'lease') throw new Error('expected resumed host lease');
      expect(resumedReady).toMatchObject({ tier: 'hot', hostId: 'warm' });
      executor.apply(resumedReady);

      const third = decideGridReadyTier({ demand: 1, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: burstEnd, provision: { vmId: 'cold', hourlyCost: 36, readyAfterMs: 100, approvalId: 'approval-cold-1' } });
      expect(third).toEqual({ tier: 'cold', action: 'create-from-image', vmId: 'cold', imageDigest: IMAGE, hourlyCost: 36, readyAfterMs: 100, approvalId: 'approval-cold-1', stopAfterAt: burstEnd });
      if (!third || third.action !== 'create-from-image') throw new Error('expected cold provision decision');
      expect(executor.apply(third)?.stopAfterAt).toBe(burstEnd);
      expect(() => executor.apply(third)).toThrow('already consumed');
      const secondExecutor = createGridReadyTierExecutor(fleet);
      expect(() => secondExecutor.apply({ ...third, vmId: 'cold-reused-approval' })).toThrow('already consumed');
      clock.tick(third.readyAfterMs);
      expect(fleet.status('cold').state).toBe('ready');
      executor.apply({ tier: 'hot', action: 'lease', hostId: 'cold' });
      expect(executor.consumedApprovalIds()).toEqual(['approval-cold-1']);

      expect(fleet.statusAll().map((vm) => vm.imageDigest)).toContain(IMAGE);
      expect(fleet.events().filter((event) => event.type === 'forbidden-terminate')).toHaveLength(0);
    });
  });

  test('rejects malformed demand and lease capacity', () => {
    const fleet = createFakeCloudVm();
    const vm = { id: 'hot', imageDigest: IMAGE, state: 'ready' as const, readyAt: EPOCH, activeLeases: 0, poweredOnMs: 0, estimatedCost: 0, terminationProtected: true };
    expect(() => decideGridReadyTier({ demand: -1, hosts: [], imageDigest: IMAGE })).toThrow('demand');
    expect(() => decideGridReadyTier({ demand: 1, hosts: [{ vm, maxLeases: 0 }], imageDigest: IMAGE })).toThrow('maxLeases');
  });

  test('warm and cold capacity require a burst deadline', () => {
    const fleet = createFakeCloudVm();
    fleet.createFromImage({ id: 'parked', imageDigest: IMAGE, hourlyCost: 36 });
    fleet.stop('parked');
    expect(() => decideGridReadyTier({ demand: 1, hosts: hosts(fleet), imageDigest: IMAGE }))
      .toThrow('stopAfterAt is required to resume warm capacity');
    expect(() => decideGridReadyTier({
      demand: 1,
      hosts: [],
      imageDigest: IMAGE,
      provision: { vmId: 'cold', hourlyCost: 36, readyAfterMs: 0, approvalId: 'approval-1' },
    })).toThrow('stopAfterAt is required to create cold capacity');
  });

  test('executor refuses empty cold approval before creating a VM', () => {
    const fleet = createFakeCloudVm();
    const executor = createGridReadyTierExecutor(fleet);
    expect(() => executor.apply({
      tier: 'cold',
      action: 'create-from-image',
      vmId: 'unauthorized-cold',
      imageDigest: IMAGE,
      hourlyCost: 36,
      readyAfterMs: 0,
      approvalId: '   ',
      stopAfterAt: Date.now() + 60_000,
    })).toThrow('approvalId is required');
    expect(fleet.statusAll()).toHaveLength(0);
  });

  test('executor consumes a hot lease decision once', () => {
    const fleet = createFakeCloudVm();
    fleet.createFromImage({ id: 'hot-once', imageDigest: IMAGE, hourlyCost: 1 });
    const executor = createGridReadyTierExecutor(fleet);
    const decision = decideGridReadyTier({ demand: 1, hosts: hosts(fleet), imageDigest: IMAGE });
    if (!decision || decision.action !== 'lease') throw new Error('expected hot lease decision');
    executor.apply(decision);
    expect(fleet.status('hot-once').activeLeases).toBe(1);
    expect(() => executor.apply(decision)).toThrow('already consumed');
    expect(fleet.status('hot-once').activeLeases).toBe(1);
  });

  test('planner and executor reject expired or too-short warm and cold windows', () => {
    const fleet = createFakeCloudVm();
    fleet.createFromImage({ id: 'parked', imageDigest: IMAGE, hourlyCost: 36 });
    fleet.stop('parked');
    const now = Date.now();
    expect(() => decideGridReadyTier({ demand: 1, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: now - 1 }))
      .toThrow('must leave time for resume warm capacity readiness');
    expect(() => decideGridReadyTier({ demand: 1, hosts: hosts(fleet), imageDigest: IMAGE, stopAfterAt: now + 99, warmReadyAfterMs: 100 }))
      .toThrow('must leave time for resume warm capacity readiness');

    const coldExecutor = createGridReadyTierExecutor(createFakeCloudVm());
    expect(() => coldExecutor.apply({
      tier: 'cold', action: 'create-from-image', vmId: 'short-window-cold', imageDigest: IMAGE,
      hourlyCost: 36, readyAfterMs: 100, approvalId: 'approval-short-window', stopAfterAt: now + 99,
    })).toThrow('must leave time for create cold capacity readiness');
    expect(coldExecutor.consumedApprovalIds()).toEqual([]);
  });

  test('the grid demand runner applies each tier through fake-cloud-vm and waits before re-evaluating', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'hot', imageDigest: IMAGE, hourlyCost: 36 });
      fleet.createFromImage({ id: 'wrong-hot', imageDigest: 'sha256:other', hourlyCost: 36 });
      fleet.createFromImage({ id: 'warm', imageDigest: IMAGE, hourlyCost: 36 });
      fleet.stop('warm');

      const result = await runGridReadyDemand({
        demand: 3,
        imageDigest: IMAGE,
        maxLeases: 1,
        stopAfterAt: EPOCH + 5_000,
        warmReadyAfterMs: 100,
        provisionForDemand: () => ({ vmId: 'cold', hourlyCost: 36, readyAfterMs: 200, approvalId: 'approval-cold-2' }),
        waitUntilReady: async (_hostId, readyAfterMs) => { clock.tick(readyAfterMs); },
      }, fleet);

      expect(result.decisions.map(({ tier, action }) => [tier, action])).toEqual([
        ['hot', 'lease'], ['warm', 'resume'], ['hot', 'lease'], ['cold', 'create-from-image'], ['hot', 'lease'],
      ]);
      expect(result.fleet.status('wrong-hot').activeLeases).toBe(0);
      expect(result.fleet.status('cold')).toMatchObject({ state: 'ready', activeLeases: 1, stopAfterAt: EPOCH + 5_000 });
      expect(result.fleet.events().filter((event) => event.type === 'forbidden-terminate')).toHaveLength(0);
    });
  });

  test('the runnable UX-sim scenario executes the planner and fake device path', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const result = await runGridReadyTierScenario(async (_hostId, readyAfterMs) => { clock.tick(readyAfterMs); });
      expect(result.decisions.map(({ tier, action }) => [tier, action])).toEqual([
        ['hot', 'lease'], ['warm', 'resume'], ['hot', 'lease'], ['cold', 'create-from-image'], ['hot', 'lease'],
      ]);
      expect(result.fleet.statusAll().filter(({ activeLeases }) => activeLeases > 0)).toHaveLength(3);
      expect(result.fleet.status('wrong-image-sim-1').activeLeases).toBe(0);
      expect(result.fleet.events().filter(({ type }) => type === 'forbidden-terminate')).toHaveLength(0);
    });
  });
});
