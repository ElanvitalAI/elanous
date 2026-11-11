import { describe, expect, spyOn, test } from 'bun:test';
import { withSimClock } from './fake-clock.js';
import { createFakeCloudBillingWorld, type FakeCloudHostRequest } from './fake-cloud-billing-world.js';

// Source: fake-cloud-vm tests anchor deterministic scenarios at a fixed UTC epoch.
const EPOCH = Date.parse('2026-11-10T00:00:00Z');
// Source: the sample image bake includes the full role recipe required by the rehearsal cell.
const IMAGE_ASSETS = ['agent', 'bun', 'runner'];
// Source: the worker fixture asks for the role-tagged image baked by this test.
const IMAGE_ID = 'cut-image';
// Source: the image digest must be pinned to the same immutable cut SHA for admission.
const CUT_SHA = 'cut-abc123';
// Source: one hour is the fake-cloud-vm rate conversion unit.
const HOUR_MS = 3_600_000;
// Source: immediate registry propagation is the deterministic default in fake-cloud-billing-world.
const NO_DELAY_MS = 0;
// Source: this alternate test image is free so the scenario isolates VM configuration admission.
const NO_BAKE_COST_KRW = 0;
// Source: this fixture intentionally delays image availability to observe registry synchronization.
const REGISTRY_DELAY_MS = 500;
// Source: bake cost is a fixed fixture charge used to prove budget accounting.
const BAKE_COST_KRW = 100;
// Source: the rehearsal worker runs for one hour at the fake hourly rate.
const HOURLY_COST_KRW = 3_600;
// Source: this is the higher rate reserved for a dedicated release gate host.
const GATE_HOURLY_COST_KRW = 7_200;
// Source: the worker warmup must miss this earlier rehearsal countdown deadline.
const COUNTDOWN_DELAY_MS = 700;
// Source: the asserted deadline falls before the configured worker warmup completes.
const COUNTDOWN_DEADLINE_MS = 600;
// Source: a short virtual tick accrues visible worker runtime spend without wall-clock delay.
const SHORT_RUNTIME_MS = 30_000;
// Source: a one-minute virtual release-gate run creates a positive runtime ledger entry.
const GATE_RUNTIME_MS = 60_000;
// Source: this budget admits two workers and one collision probe after the image bake.
const WORKER_BUDGET_KRW = 20_000;
// Source: this budget is consumed by baking alone, so worker admission must fail closed.
const EXHAUSTED_BUDGET_KRW = 100;
// Source: the release rehearsal budget comfortably reserves its workers and gate host.
const RELEASE_BUDGET_KRW = 50_000;
// Source: worker count for the scale-up scenario exercises the configured demand directly.
const TWO_WORKERS = 2;
// Source: scale-down leaves one training worker while the gate host occupies the reclaimed slot.
const ONE_WORKER = 1;
// Source: a fully consumed bake-only budget leaves no uncommitted monthly capacity.
const ZERO_BUDGET_KRW = 0;
// Source: an idle training queue is represented by zero requested workers.
const NO_WORKERS = 0;
// Source: a single initial worker run and its next reservation must exceed this fixed monthly cap.
const RESTART_BUDGET_KRW = 3_700;
// Source: warming fixtures delay readiness so demand accounting can be observed before and after the tick.
const WORKER_WARMUP_MS = 50;
// Source: this alternate immutable image uses another cut to verify parked-host configuration safety.
const ALTERNATE_IMAGE_ID = 'alternate-cut-image';
// Source: this distinct cut SHA must never replace the original image on a parked VM.
const ALTERNATE_CUT_SHA = 'cut-def456';
// Source: this release budget admits the two-hour, half-rate gate reservation but not a replacement worker after accrued spend.
const RESTORE_FAILURE_BUDGET_KRW = 8_000;
// Source: the restore-failure gate remains active for twice the worker's one-hour lease window.
const LONG_GATE_RUNTIME_MS = HOUR_MS * TWO_WORKERS;
// Source: the half-rate gate makes initial reservation fit while accrued cost blocks worker restoration.
const RESTORE_FAILURE_GATE_RATE_KRW = HOURLY_COST_KRW / TWO_WORKERS;

function bake(world: ReturnType<typeof createFakeCloudBillingWorld>, delayMs = NO_DELAY_MS) {
  return world.bakeImage({
    imageId: IMAGE_ID,
    cutSha: CUT_SHA,
    roleTags: ['train-worker', 'gate-host'],
    requiredAssets: IMAGE_ASSETS,
    bakedAssets: IMAGE_ASSETS,
    bakeCostKrw: BAKE_COST_KRW,
    registryDelayMs: delayMs,
  });
}

function host(id: string, overrides: Partial<FakeCloudHostRequest> = {}): FakeCloudHostRequest {
  return {
    id,
    role: 'train-worker',
    imageId: IMAGE_ID,
    cutSha: CUT_SHA,
    requiredAssets: IMAGE_ASSETS,
    hourlyCostKrw: HOURLY_COST_KRW,
    estimatedRuntimeMs: HOUR_MS,
    credentialsValid: true,
    substitutionMapReady: true,
    mirrorCurrent: true,
    ...overrides,
  };
}

describe('fake-cloud-billing-world', () => {
  test('REHEARSAL-IMAGE-BAKE pins a role recipe to a cut and waits for registry sync', async () => {
    await withSimClock(EPOCH, (clock) => {
      const world = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW });
      const baked = bake(world, REGISTRY_DELAY_MS);
      expect(baked).toMatchObject({ accepted: true, state: 'syncing', humanIntervention: false });
      expect(world.requestHost(host('early'))).toMatchObject({ accepted: false, reason: 'registry-not-synced', humanIntervention: false });
      clock.tick(REGISTRY_DELAY_MS);
      expect(world.imageStatus(IMAGE_ID)?.state).toBe('ready');
      expect(world.requestHost(host('worker'))).toMatchObject({ accepted: true, humanIntervention: false, vm: { state: 'ready' } });

      const staleCut = world.requestHost(host('stale-cut', { cutSha: 'another-cut' }));
      const wrongRole = world.requestHost(host('wrong-role', { role: 'remote-parent' }));
      const incomplete = world.requestHost(host('missing-asset', { requiredAssets: ['agent', 'docker'] }));
      const expired = world.requestHost(host('expired', { credentialsValid: false }));
      const missingMap = world.requestHost(host('no-substitutions', { substitutionMapReady: false }));
      const staleMirror = world.requestHost(host('stale-mirror', { mirrorCurrent: false }));
      const countdownMiss = world.requestHost(host('late', { readyAfterMs: COUNTDOWN_DELAY_MS, deadlineAt: EPOCH + COUNTDOWN_DEADLINE_MS }));
      const warmupPreempt = world.requestHost(host('preempted', { preemptDuringWarmup: true, fallbackHostId: 'warm-pool' }));

      expect([staleCut.reason, wrongRole.reason, incomplete.reason, expired.reason, missingMap.reason, staleMirror.reason, countdownMiss.reason, warmupPreempt.reason])
        .toEqual(['cut-sha-mismatch', 'role-tag-missing', 'recipe-incomplete', 'credential-expired', 'substitution-map-missing', 'mirror-stale', 'countdown-missed', 'warmup-preempted']);
      expect(warmupPreempt.fallbackHostId).toBe('warm-pool');

      const failedDownload = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW }).bakeImage({
        imageId: 'download-failure', cutSha: CUT_SHA, roleTags: ['train-worker'], requiredAssets: IMAGE_ASSETS,
        bakedAssets: IMAGE_ASSETS, bakeCostKrw: BAKE_COST_KRW, failure: 'image-download-failed',
      });
      const partialRecipe = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW }).bakeImage({
        imageId: 'partial-recipe', cutSha: CUT_SHA, roleTags: ['train-worker'], requiredAssets: IMAGE_ASSETS,
        bakedAssets: ['agent'], bakeCostKrw: BAKE_COST_KRW,
      });
      const bakeOverBudget = createFakeCloudBillingWorld({ monthlyBudgetKrw: EXHAUSTED_BUDGET_KRW - BAKE_COST_KRW }).bakeImage({
        imageId: 'over-budget-image', cutSha: CUT_SHA, roleTags: ['train-worker'], requiredAssets: IMAGE_ASSETS,
        bakedAssets: IMAGE_ASSETS, bakeCostKrw: BAKE_COST_KRW,
      });
      expect([failedDownload.reason, partialRecipe.reason, bakeOverBudget.reason]).toEqual([
        'image-download-failed', 'recipe-incomplete', 'monthly-budget-exhausted',
      ]);
    });
  });

  test('GUARDIAN-TRAIN-WORKER-LIFECYCLE scales by demand and enforces budget and role collisions', async () => {
    await withSimClock(EPOCH, (clock) => {
      const world = createFakeCloudBillingWorld({ monthlyBudgetKrw: WORKER_BUDGET_KRW });
      bake(world);
      const template = host('template');
      expect(world.setTrainingWorkerDemand(TWO_WORKERS, template).active).toBe(TWO_WORKERS);
      expect(world.snapshot().reservedKrw).toBe(HOURLY_COST_KRW * TWO_WORKERS);
      expect(world.requestHost(host('role-collision', { role: 'gate-host' }))).toMatchObject({ accepted: true });
      expect(world.requestHost(host('role-collision', { role: 'train-worker' })).reason).toBe('role-collision');
      clock.tick(SHORT_RUNTIME_MS);
      world.setTrainingWorkerDemand(ONE_WORKER, template);
      expect(world.snapshot().activeTrainingWorkers).toBe(ONE_WORKER);
      expect(world.snapshot().ledger.some((entry) => entry.kind === 'vm-runtime')).toBe(true);
      const workerCountBeforeIdle = world.snapshot().trainingWorkers.length;
      world.setTrainingWorkerDemand(NO_WORKERS, template);
      expect(world.snapshot().trainingWorkers.some((worker) => worker.state === 'parked')).toBe(true);
      world.setTrainingWorkerDemand(ONE_WORKER, template);
      expect(world.snapshot().trainingWorkers).toHaveLength(workerCountBeforeIdle);
      expect(world.events().some((event) => event.type === 'host-resumed')).toBe(true);

      const parkedWorkerId = world.snapshot().trainingWorkers.find((worker) => worker.state === 'parked')?.id;
      expect(parkedWorkerId).toBeDefined();
      const alternateImage = world.bakeImage({
        imageId: ALTERNATE_IMAGE_ID, cutSha: ALTERNATE_CUT_SHA, roleTags: ['train-worker'], requiredAssets: IMAGE_ASSETS,
        bakedAssets: IMAGE_ASSETS, bakeCostKrw: NO_BAKE_COST_KRW,
      });
      expect(alternateImage.accepted).toBe(true);
      expect(world.requestHost(host(parkedWorkerId!, { imageId: ALTERNATE_IMAGE_ID, cutSha: ALTERNATE_CUT_SHA })).reason)
        .toBe('vm-configuration-mismatch');
      expect(world.requestHost(host(parkedWorkerId!, { hourlyCostKrw: GATE_HOURLY_COST_KRW })).reason)
        .toBe('vm-configuration-mismatch');

      const budgetBound = createFakeCloudBillingWorld({ monthlyBudgetKrw: EXHAUSTED_BUDGET_KRW });
      bake(budgetBound);
      expect(budgetBound.requestHost(host('over-budget')).reason).toBe('monthly-budget-exhausted');
      expect(budgetBound.snapshot().remainingBudgetKrw).toBe(ZERO_BUDGET_KRW);

      const restartBound = createFakeCloudBillingWorld({ monthlyBudgetKrw: RESTART_BUDGET_KRW });
      bake(restartBound);
      expect(restartBound.requestHost(host('restart-reservation'))).toMatchObject({ accepted: true });
      clock.tick(SHORT_RUNTIME_MS);
      restartBound.stopHost('restart-reservation');
      expect(restartBound.requestHost(host('restart-reservation')).reason).toBe('monthly-budget-exhausted');

      const warmingWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: WORKER_BUDGET_KRW });
      bake(warmingWorld);
      const warmingTemplate = host('warming-template', { readyAfterMs: WORKER_WARMUP_MS });
      expect(warmingWorld.setTrainingWorkerDemand(ONE_WORKER, warmingTemplate).active).toBe(NO_WORKERS);
      expect(warmingWorld.setTrainingWorkerDemand(ONE_WORKER, warmingTemplate).active).toBe(NO_WORKERS);
      clock.tick(WORKER_WARMUP_MS);
      expect(warmingWorld.setTrainingWorkerDemand(ONE_WORKER, warmingTemplate).active).toBe(ONE_WORKER);

      const cancelledWarmWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: WORKER_BUDGET_KRW });
      bake(cancelledWarmWorld);
      const cancelledWarmTemplate = host('cancelled-warm-worker', { readyAfterMs: WORKER_WARMUP_MS });
      expect(cancelledWarmWorld.setTrainingWorkerDemand(ONE_WORKER, cancelledWarmTemplate).active).toBe(NO_WORKERS);
      expect(cancelledWarmWorld.snapshot().reservedKrw).toBe(HOURLY_COST_KRW);
      cancelledWarmWorld.setTrainingWorkerDemand(NO_WORKERS, cancelledWarmTemplate);
      expect(cancelledWarmWorld.snapshot().trainingWorkers).toMatchObject([{ state: 'parked' }]);
      expect(cancelledWarmWorld.snapshot().reservedKrw).toBe(NO_DELAY_MS);
      clock.tick(WORKER_WARMUP_MS);
      expect(cancelledWarmWorld.snapshot().trainingWorkers).toMatchObject([{ state: 'parked' }]);

      const cancelledReadyWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: WORKER_BUDGET_KRW });
      bake(cancelledReadyWorld);
      const cancelledReadyTemplate = host('cancelled-ready-worker', { readyAfterMs: WORKER_WARMUP_MS });
      expect(cancelledReadyWorld.setTrainingWorkerDemand(ONE_WORKER, cancelledReadyTemplate).active).toBe(NO_WORKERS);
      clock.tick(WORKER_WARMUP_MS);
      cancelledReadyWorld.setTrainingWorkerDemand(NO_WORKERS, cancelledReadyTemplate);
      expect(cancelledReadyWorld.snapshot().trainingWorkers).toMatchObject([{ state: 'parked' }]);
      expect(cancelledReadyWorld.snapshot().reservedKrw).toBe(NO_DELAY_MS);

      const expiredWorkerWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: WORKER_BUDGET_KRW });
      bake(expiredWorkerWorld);
      const expiringTemplate = host('expiring-worker');
      expiredWorkerWorld.setTrainingWorkerDemand(ONE_WORKER, expiringTemplate);
      clock.tick(HOUR_MS);
      expect(expiredWorkerWorld.snapshot().activeTrainingWorkers).toBe(NO_WORKERS);
      expect(expiredWorkerWorld.snapshot().trainingWorkers).toMatchObject([{ state: 'parked' }]);
      expect(expiredWorkerWorld.setTrainingWorkerDemand(ONE_WORKER, expiringTemplate).active).toBe(ONE_WORKER);
      expect(expiredWorkerWorld.events().some((event) => event.type === 'host-resumed')).toBe(true);

      const recutWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW });
      bake(recutWorld);
      const oldTemplate = host('old-template', { readyAfterMs: WORKER_WARMUP_MS });
      const oldWorker = recutWorld.setTrainingWorkerDemand(ONE_WORKER, oldTemplate);
      const oldWorkerId = oldWorker.results[0]?.id;
      clock.tick(WORKER_WARMUP_MS);
      recutWorld.bakeImage({
        imageId: ALTERNATE_IMAGE_ID, cutSha: ALTERNATE_CUT_SHA, roleTags: ['train-worker'], requiredAssets: IMAGE_ASSETS,
        bakedAssets: IMAGE_ASSETS, bakeCostKrw: NO_BAKE_COST_KRW,
      });
      const recut = recutWorld.setTrainingWorkerDemand(ONE_WORKER, host('new-template', {
        imageId: ALTERNATE_IMAGE_ID, cutSha: ALTERNATE_CUT_SHA,
      }));
      expect(recut.active).toBe(ONE_WORKER);
      expect(recut.results[0]?.id).not.toBe(oldWorkerId);
    });
  });

  test('RLA-CLOUD-ELASTIC reserves a gate host, reclaims and restores train capacity, and records spend', async () => {
    await withSimClock(EPOCH, (clock) => {
      const world = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW });
      bake(world);
      const workerTemplate = host('worker-template');
      const gateHost = host('gate-1', { role: 'gate-host', hourlyCostKrw: GATE_HOURLY_COST_KRW });
      const gate = world.beginReleaseGate({ trainWorkerDemand: TWO_WORKERS, gateHosts: [gateHost], workerTemplate });
      expect(gate).toMatchObject({ accepted: true, phase: 'gate', trainingSlots: ONE_WORKER, gateHosts: ['gate-1'], humanIntervention: false });
      expect(world.snapshot().activeTrainingWorkers).toBe(ONE_WORKER);
      clock.tick(GATE_RUNTIME_MS);
      world.advanceReleasePhase('publish');
      world.advanceReleasePhase('verify');
      const finished = world.finishReleaseGate(workerTemplate);
      expect(finished).toMatchObject({ accepted: true, phase: 'idle', trainingDemand: TWO_WORKERS, gateHosts: [], humanIntervention: false });
      expect(world.snapshot().activeTrainingWorkers).toBe(TWO_WORKERS);
      expect(world.snapshot().spentKrw).toBeGreaterThan(BAKE_COST_KRW);

      const warmWorkerWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW });
      bake(warmWorkerWorld);
      const warmWorkerPlan = {
        trainWorkerDemand: ONE_WORKER,
        gateHosts: [],
        workerTemplate: host('warming-release-worker', { readyAfterMs: WORKER_WARMUP_MS }),
      };
      const unreadyWorkers = warmWorkerWorld.beginReleaseGate(warmWorkerPlan);
      expect(unreadyWorkers).toMatchObject({ accepted: false, reason: 'training-workers-not-ready', retryable: true, humanIntervention: false });
      expect(warmWorkerWorld.snapshot().activeTrainingWorkers).toBe(NO_WORKERS);
      clock.tick(WORKER_WARMUP_MS);
      expect(warmWorkerWorld.beginReleaseGate(warmWorkerPlan)).toMatchObject({ accepted: true, phase: 'gate', trainingSlots: ONE_WORKER, humanIntervention: false });
      warmWorkerWorld.advanceReleasePhase('publish');
      warmWorkerWorld.advanceReleasePhase('verify');
      expect(warmWorkerWorld.finishReleaseGate(warmWorkerPlan.workerTemplate)).toMatchObject({ accepted: true, phase: 'idle' });

      const delayedGateHost = host('delayed-gate', { role: 'gate-host', readyAfterMs: WORKER_WARMUP_MS });
      const delayedGatePlan = { trainWorkerDemand: TWO_WORKERS, gateHosts: [delayedGateHost], workerTemplate };
      expect(world.beginReleaseGate(delayedGatePlan)).toMatchObject({ accepted: false, reason: 'gate-host-not-ready', retryable: true, phase: 'gate' });
      expect(() => world.advanceReleasePhase('publish')).toThrow('release gate has not been accepted');
      expect(() => world.advanceReleasePhase('verify')).toThrow('release gate has not been accepted');
      expect(world.snapshot().phase).toBe('gate');
      clock.tick(WORKER_WARMUP_MS);
      expect(world.beginReleaseGate(delayedGatePlan)).toMatchObject({ accepted: true, phase: 'gate', gateHosts: ['delayed-gate'] });
      world.advanceReleasePhase('publish');
      world.advanceReleasePhase('verify');
      expect(world.finishReleaseGate(workerTemplate)).toMatchObject({ accepted: true, phase: 'idle', trainingDemand: TWO_WORKERS });

      const restorationWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: RESTORE_FAILURE_BUDGET_KRW });
      bake(restorationWorld);
      const restorationTemplate = host('restoration-template');
      const tightGate = restorationWorld.beginReleaseGate({
        trainWorkerDemand: TWO_WORKERS,
        gateHosts: [host('tight-gate', {
          role: 'gate-host', hourlyCostKrw: RESTORE_FAILURE_GATE_RATE_KRW, estimatedRuntimeMs: LONG_GATE_RUNTIME_MS,
        })],
        workerTemplate: restorationTemplate,
      });
      expect(tightGate.accepted).toBe(true);
      clock.tick(HOUR_MS);
      restorationWorld.advanceReleasePhase('publish');
      restorationWorld.advanceReleasePhase('verify');
      expect(restorationWorld.finishReleaseGate(restorationTemplate)).toMatchObject({
        accepted: false, reason: 'training-workers-not-restored', phase: 'verify', humanIntervention: false,
      });
      expect(restorationWorld.snapshot().phase).toBe('verify');

      const expiredGateWorld = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW });
      bake(expiredGateWorld);
      const expiringGate = expiredGateWorld.beginReleaseGate({
        trainWorkerDemand: ONE_WORKER,
        gateHosts: [host('short-gate', { role: 'gate-host', estimatedRuntimeMs: GATE_RUNTIME_MS })],
        workerTemplate: host('short-gate-worker'),
      });
      expect(expiringGate.accepted).toBe(true);
      clock.tick(GATE_RUNTIME_MS);
      expect(() => expiredGateWorld.advanceReleasePhase('publish')).toThrow('gate host short-gate is not ready');
      expect(expiredGateWorld.snapshot().phase).toBe('gate');
      expiredGateWorld.stopHost('short-gate');
    });
  });

  test('network and process boundaries throw when injected and remain unused during all simulated paths', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('external network call forbidden in simulation');
      });
      const processGuard = spyOn(Bun, 'spawn').mockImplementation(() => {
        throw new Error('external process call forbidden in simulation');
      });
      try {
        expect(() => fetchGuard(new Request('https://example.invalid'))).toThrow('external network call forbidden');
        expect(() => processGuard(['external-command'])).toThrow('external process call forbidden');
        fetchGuard.mockClear();
        processGuard.mockClear();

        const world = createFakeCloudBillingWorld({ monthlyBudgetKrw: RELEASE_BUDGET_KRW });
        bake(world);
        const template = host('boundary-worker');
        expect(world.setTrainingWorkerDemand(ONE_WORKER, template).active).toBe(ONE_WORKER);
        const gate = world.beginReleaseGate({ trainWorkerDemand: ONE_WORKER, gateHosts: [host('boundary-gate', { role: 'gate-host' })], workerTemplate: template });
        expect(gate.accepted).toBe(true);
        world.advanceReleasePhase('publish');
        world.advanceReleasePhase('verify');
        expect(world.finishReleaseGate(template).accepted).toBe(true);
        clock.tick(SHORT_RUNTIME_MS);
        expect(fetchGuard).not.toHaveBeenCalled();
        expect(processGuard).not.toHaveBeenCalled();
      } finally {
        fetchGuard.mockRestore();
        processGuard.mockRestore();
      }
    });
  });
});
