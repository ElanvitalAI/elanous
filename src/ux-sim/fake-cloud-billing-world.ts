import { createHash } from 'node:crypto';
import { createFakeCloudVm, type FakeCloudVmSnapshot } from './fake-cloud-vm.js';

// Source: a stopped VM has no active runtime charge in fake-cloud-vm's powered-time model.
const ZERO = 0;
// Source: fake-cloud-vm exposes powered-on duration in milliseconds and hourly rates.
const MILLISECONDS_PER_HOUR = 3_600_000;
// Source: worker IDs are deterministic and start at the first ordinal.
const FIRST_WORKER_ORDINAL = 1;

export type FakeCloudRole = 'train-worker' | 'gate-host' | 'remote-parent' | 'warm-pool';
export type FakeCloudReleasePhase = 'idle' | 'cut' | 'gate' | 'publish' | 'verify';
export type FakeCloudBakeFailure = 'image-download-failed' | 'credential-expired' | 'substitution-map-missing' | 'mirror-stale' | 'recipe-partial';

export interface FakeCloudImageBakeRequest {
  readonly imageId: string;
  readonly cutSha: string;
  readonly roleTags: readonly FakeCloudRole[];
  readonly requiredAssets: readonly string[];
  readonly bakedAssets: readonly string[];
  readonly bakeCostKrw: number;
  readonly registryDelayMs?: number;
  readonly failure?: FakeCloudBakeFailure;
}

export interface FakeCloudHostRequest {
  readonly id: string;
  readonly role: FakeCloudRole;
  readonly imageId: string;
  readonly cutSha: string;
  readonly requiredAssets: readonly string[];
  readonly hourlyCostKrw: number;
  readonly estimatedRuntimeMs: number;
  readonly readyAfterMs?: number;
  readonly deadlineAt?: number;
  readonly credentialsValid: boolean;
  readonly substitutionMapReady: boolean;
  readonly mirrorCurrent: boolean;
  readonly preemptDuringWarmup?: boolean;
  readonly fallbackHostId?: string;
}

export interface FakeCloudBillingEvent {
  readonly type:
    | 'image-bake-started' | 'image-bake-failed' | 'image-registry-ready'
    | 'host-request-refused' | 'host-started' | 'host-resumed' | 'host-preempted'
    | 'host-ready' | 'host-stopped' | 'vm-runtime-charged'
    | 'train-worker-demand' | 'release-phase' | 'release-gate-refused';
  readonly id?: string;
  readonly role?: FakeCloudRole;
  readonly reason?: string;
  readonly phase?: FakeCloudReleasePhase;
  readonly amountKrw?: number;
  readonly at: number;
}

export interface FakeCloudHostResult {
  readonly accepted: boolean;
  readonly id: string;
  readonly role: FakeCloudRole;
  readonly reason?: string;
  readonly fallbackHostId?: string;
  readonly humanIntervention: false;
  readonly vm?: FakeCloudVmSnapshot;
}

interface ImageRecord {
  readonly imageId: string;
  readonly cutSha: string;
  readonly digest: string;
  readonly roleTags: readonly FakeCloudRole[];
  readonly assets: readonly string[];
  readonly registryReadyAt: number;
  registryReady: boolean;
}

interface Reservation {
  readonly amountKrw: number;
  readonly role: FakeCloudRole;
  readonly baselineBilledKrw: number;
}

export interface FakeCloudBillingWorldOptions {
  readonly monthlyBudgetKrw: number;
}

export interface FakeCloudReleaseGatePlan {
  readonly trainWorkerDemand: number;
  readonly gateHosts: readonly FakeCloudHostRequest[];
  readonly workerTemplate: Omit<FakeCloudHostRequest, 'id' | 'role'>;
}

/**
 * Compose the existing fake-cloud-vm lifecycle with a local cost ledger,
 * deterministic image bake/registry, role admission and release-phase scaling.
 * No provider, registry, credential service, process, or network is contacted.
 */
export function createFakeCloudBillingWorld(options: FakeCloudBillingWorldOptions) {
  if (!Number.isFinite(options.monthlyBudgetKrw) || options.monthlyBudgetKrw < ZERO) {
    throw new Error('fake-cloud-billing-world: monthlyBudgetKrw must be nonnegative and finite');
  }

  const cloud = createFakeCloudVm();
  const images = new Map<string, ImageRecord>();
  const rolesByHost = new Map<string, FakeCloudRole>();
  const reservations = new Map<string, Reservation>();
  const billedRuntimeByHost = new Map<string, number>();
  const events: FakeCloudBillingEvent[] = [];
  const ledger: Array<{ readonly kind: 'image-bake' | 'vm-runtime'; readonly id: string; readonly amountKrw: number; readonly at: number }> = [];
  const trainingWorkers: string[] = [];
  const activeTrainingWorkers = new Set<string>();
  const gateHosts: string[] = [];
  let trainingWorkerOrdinal = FIRST_WORKER_ORDINAL;
  let trainingDemand = ZERO;
  let previousTrainingDemand = ZERO;
  let phase: FakeCloudReleasePhase = 'idle';
  let pendingReleasePlanKey: string | undefined;
  let releaseGateReady = false;
  let spentKrw = ZERO;

  function now(): number { return Date.now(); }

  function reservedKrw(): number {
    let total = ZERO;
    for (const [id, reservation] of reservations) {
      const billed = billedRuntimeByHost.get(id) ?? ZERO;
      const runBilled = Math.max(ZERO, billed - reservation.baselineBilledKrw);
      total += Math.max(ZERO, reservation.amountKrw - runBilled);
    }
    return total;
  }

  function committedKrw(): number { return spentKrw + reservedKrw(); }

  function pushEvent(event: Omit<FakeCloudBillingEvent, 'at'>): void {
    events.push({ ...event, at: now() });
  }

  function charge(kind: 'image-bake' | 'vm-runtime', id: string, amountKrw: number): void {
    if (amountKrw <= ZERO) return;
    spentKrw += amountKrw;
    ledger.push({ kind, id, amountKrw, at: now() });
    pushEvent({ type: 'vm-runtime-charged', id, amountKrw });
  }

  function reconcileRuntime(): void {
    for (const vm of cloud.statusAll()) {
      const previous = billedRuntimeByHost.get(vm.id) ?? ZERO;
      const delta = vm.estimatedCost - previous;
      if (delta > ZERO) charge('vm-runtime', vm.id, delta);
      billedRuntimeByHost.set(vm.id, vm.estimatedCost);
    }
    for (const image of images.values()) {
      if (!image.registryReady && now() >= image.registryReadyAt) {
        image.registryReady = true;
        pushEvent({ type: 'image-registry-ready', id: image.imageId });
      }
    }
  }

  function refuse(id: string, role: FakeCloudRole, reason: string, fallbackHostId?: string): FakeCloudHostResult {
    pushEvent({ type: 'host-request-refused', id, role, reason });
    return { accepted: false, id, role, reason, ...(fallbackHostId ? { fallbackHostId } : {}), humanIntervention: false };
  }

  function imageForRequest(request: FakeCloudHostRequest): ImageRecord | undefined {
    reconcileRuntime();
    const image = images.get(request.imageId);
    if (!image) return undefined;
    return image;
  }

  function openLeaseWhenReady(id: string): FakeCloudVmSnapshot {
    let vm = cloud.status(id);
    if (vm.state === 'ready' && vm.activeLeases === ZERO) {
      vm = cloud.openLease(id);
      pushEvent({ type: 'host-ready', id, role: rolesByHost.get(id) });
    }
    reconcileRuntime();
    return vm;
  }

  function stopHost(id: string): FakeCloudVmSnapshot {
    let vm = cloud.status(id);
    while (vm.activeLeases > ZERO) vm = cloud.closeLease(id);
    if (vm.state !== 'parked' && vm.state !== 'disappeared') vm = cloud.stop(id);
    reconcileRuntime();
    reservations.delete(id);
    activeTrainingWorkers.delete(id);
    pushEvent({ type: 'host-stopped', id, role: rolesByHost.get(id) });
    return vm;
  }

  function workerConfigurationMatches(id: string, template: Omit<FakeCloudHostRequest, 'id' | 'role'>): boolean {
    if (!template.credentialsValid || !template.substitutionMapReady || !template.mirrorCurrent) return false;
    const image = images.get(template.imageId);
    if (!image?.registryReady || image.cutSha !== template.cutSha || !image.roleTags.includes('train-worker')) return false;
    if (template.requiredAssets.some(asset => !image.assets.includes(asset))) return false;
    const vm = cloud.status(id);
    return vm.imageDigest === image.digest && vm.hourlyCost === template.hourlyCostKrw;
  }

  function reconcileActiveTrainingWorkers(): void {
    for (const id of [...activeTrainingWorkers]) {
      const vm = cloud.status(id);
      if (vm.state === 'ready') continue;
      activeTrainingWorkers.delete(id);
      if (vm.state === 'draining') stopHost(id);
      else if (vm.state === 'parked' || vm.state === 'disappeared') reservations.delete(id);
    }
  }

  function requestHost(request: FakeCloudHostRequest): FakeCloudHostResult {
    if (!request.credentialsValid) return refuse(request.id, request.role, 'credential-expired', request.fallbackHostId);
    if (!request.substitutionMapReady) return refuse(request.id, request.role, 'substitution-map-missing', request.fallbackHostId);
    if (!request.mirrorCurrent) return refuse(request.id, request.role, 'mirror-stale', request.fallbackHostId);
    const image = imageForRequest(request);
    if (!image) return refuse(request.id, request.role, 'image-not-found', request.fallbackHostId);
    if (!image.registryReady) return refuse(request.id, request.role, 'registry-not-synced', request.fallbackHostId);
    if (image.cutSha !== request.cutSha) return refuse(request.id, request.role, 'cut-sha-mismatch', request.fallbackHostId);
    if (!image.roleTags.includes(request.role)) return refuse(request.id, request.role, 'role-tag-missing', request.fallbackHostId);
    if (request.requiredAssets.some(asset => !image.assets.includes(asset))) {
      return refuse(request.id, request.role, 'recipe-incomplete', request.fallbackHostId);
    }
    const readyAfterMs = request.readyAfterMs ?? ZERO;
    const readyAt = now() + readyAfterMs;
    if (request.deadlineAt !== undefined && readyAt > request.deadlineAt) {
      return refuse(request.id, request.role, 'countdown-missed', request.fallbackHostId);
    }
    if (!Number.isFinite(request.hourlyCostKrw) || request.hourlyCostKrw < ZERO
      || !Number.isFinite(request.estimatedRuntimeMs) || request.estimatedRuntimeMs < ZERO) {
      return refuse(request.id, request.role, 'invalid-cost-reservation', request.fallbackHostId);
    }
    const estimatedCost = request.hourlyCostKrw * request.estimatedRuntimeMs / MILLISECONDS_PER_HOUR;
    const existingRole = rolesByHost.get(request.id);
    if (existingRole && existingRole !== request.role) return refuse(request.id, request.role, 'role-collision', request.fallbackHostId);
    if (existingRole === request.role) {
      const existingVm = cloud.status(request.id);
      if (existingVm.state !== 'parked') return refuse(request.id, request.role, 'host-already-assigned', request.fallbackHostId);
      if (existingVm.imageDigest !== image.digest || existingVm.hourlyCost !== request.hourlyCostKrw) {
        return refuse(request.id, request.role, 'vm-configuration-mismatch', request.fallbackHostId);
      }
    }
    if (committedKrw() + estimatedCost > options.monthlyBudgetKrw) {
      return refuse(request.id, request.role, 'monthly-budget-exhausted', request.fallbackHostId);
    }

    let vm: FakeCloudVmSnapshot;
    if (existingRole === request.role) {
      vm = cloud.resume(request.id, {
        readyAfterMs,
        stopAfterAt: now() + request.estimatedRuntimeMs,
      });
      pushEvent({ type: 'host-resumed', id: request.id, role: request.role });
    } else {
      vm = cloud.createFromImage({
        id: request.id,
        imageDigest: image.digest,
        hourlyCost: request.hourlyCostKrw,
        readyAfterMs,
        stopAfterAt: now() + request.estimatedRuntimeMs,
        terminationProtected: true,
      });
      rolesByHost.set(request.id, request.role);
      billedRuntimeByHost.set(request.id, ZERO);
      pushEvent({ type: 'host-started', id: request.id, role: request.role });
    }
    const baselineBilledKrw = billedRuntimeByHost.get(request.id) ?? ZERO;
    reservations.set(request.id, { amountKrw: estimatedCost, role: request.role, baselineBilledKrw });

    if (request.preemptDuringWarmup) {
      vm = cloud.disappear(request.id);
      reconcileRuntime();
      reservations.delete(request.id);
      rolesByHost.delete(request.id);
      pushEvent({ type: 'host-preempted', id: request.id, role: request.role, reason: 'warmup-preempted' });
      return refuse(request.id, request.role, 'warmup-preempted', request.fallbackHostId);
    }
    vm = openLeaseWhenReady(request.id);
    return { accepted: true, id: request.id, role: request.role, humanIntervention: false, vm };
  }

  function setTrainingWorkerDemand(desired: number, template: Omit<FakeCloudHostRequest, 'id' | 'role'>) {
    if (!Number.isInteger(desired) || desired < ZERO) throw new Error('fake-cloud-billing-world: invalid train-worker demand');
    trainingDemand = desired;
    reconcileActiveTrainingWorkers();
    for (const id of [...activeTrainingWorkers]) {
      if (!workerConfigurationMatches(id, template)) stopHost(id);
    }
    let pendingCapacity = Math.max(ZERO, desired - activeTrainingWorkers.size);
    for (const id of trainingWorkers) {
      if (activeTrainingWorkers.has(id)) continue;
      const vm = cloud.status(id);
      if (vm.state !== 'warming' && vm.state !== 'ready') continue;
      if (pendingCapacity > ZERO && workerConfigurationMatches(id, template)) pendingCapacity -= 1;
      else stopHost(id);
    }
    while (activeTrainingWorkers.size > desired) {
      const activeWorkerIds = [...activeTrainingWorkers];
      const id = activeWorkerIds[activeWorkerIds.length - FIRST_WORKER_ORDINAL];
      if (!id) break;
      stopHost(id);
      activeTrainingWorkers.delete(id);
    }
    const results: FakeCloudHostResult[] = [];
    while (activeTrainingWorkers.size < desired) {
      const readyId = trainingWorkers.find(id => !activeTrainingWorkers.has(id)
        && cloud.status(id).state === 'ready' && workerConfigurationMatches(id, template));
      if (readyId) {
        const vm = openLeaseWhenReady(readyId);
        activeTrainingWorkers.add(readyId);
        results.push({ accepted: true, id: readyId, role: 'train-worker', humanIntervention: false, vm });
        continue;
      }
      const warmingId = trainingWorkers.find(id => !activeTrainingWorkers.has(id)
        && cloud.status(id).state === 'warming' && workerConfigurationMatches(id, template));
      if (warmingId) {
        const vm = openLeaseWhenReady(warmingId);
        if (vm.state === 'ready') {
          activeTrainingWorkers.add(warmingId);
          results.push({ accepted: true, id: warmingId, role: 'train-worker', humanIntervention: false, vm });
          continue;
        }
        results.push({ accepted: false, id: warmingId, role: 'train-worker', reason: 'worker-not-ready', humanIntervention: false, vm });
        break;
      }
      const parkedId = trainingWorkers.find(id => !activeTrainingWorkers.has(id)
        && cloud.status(id).state === 'parked' && workerConfigurationMatches(id, template));
      const id = parkedId ?? `train-worker-${trainingWorkerOrdinal++}`;
      const result = requestHost({ ...template, id, role: 'train-worker' });
      results.push(result);
      if (!result.accepted) break;
      if (!parkedId) trainingWorkers.push(id);
      if (result.vm?.state === 'ready') activeTrainingWorkers.add(id);
      else break;
    }
    pushEvent({ type: 'train-worker-demand', reason: `desired=${desired}; active=${activeTrainingWorkers.size}` });
    return { desired, active: activeTrainingWorkers.size, results };
  }

  function beginReleaseGate(plan: FakeCloudReleaseGatePlan) {
    const planKey = JSON.stringify(plan);
    const retryingGate = phase === 'gate';
    if (retryingGate) {
      if (pendingReleasePlanKey !== planKey) throw new Error('fake-cloud-billing-world: retry plan does not match the pending release gate');
    } else if (phase !== 'idle') {
      throw new Error(`fake-cloud-billing-world: release gate already in ${phase}`);
    }

    const demandDuringGate = Math.max(ZERO, plan.trainWorkerDemand - plan.gateHosts.length);
    if (!retryingGate) {
      previousTrainingDemand = plan.trainWorkerDemand;
      const baseWorkers = setTrainingWorkerDemand(plan.trainWorkerDemand, plan.workerTemplate);
      if (baseWorkers.active !== plan.trainWorkerDemand) {
        pushEvent({ type: 'release-gate-refused', phase: 'idle', reason: 'training-workers-not-ready' });
        return { accepted: false as const, reason: 'training-workers-not-ready', retryable: true as const, phase, humanIntervention: false as const };
      }
      phase = 'cut';
      pushEvent({ type: 'release-phase', phase });
      const reduced = setTrainingWorkerDemand(demandDuringGate, plan.workerTemplate);
      if (reduced.active !== demandDuringGate) {
        phase = 'idle';
        setTrainingWorkerDemand(previousTrainingDemand, plan.workerTemplate);
        pushEvent({ type: 'release-gate-refused', phase, reason: 'training-slot-not-released' });
        return { accepted: false as const, reason: 'training-slot-not-released', retryable: false as const, phase, humanIntervention: false as const };
      }
      phase = 'gate';
      pendingReleasePlanKey = planKey;
      releaseGateReady = false;
      pushEvent({ type: 'release-phase', phase });
    }

    for (const host of plan.gateHosts) {
      const alreadyTracked = gateHosts.includes(host.id);
      let result: FakeCloudHostResult;
      if (alreadyTracked) {
        const vm = openLeaseWhenReady(host.id);
        if (vm?.state === 'ready' && vm.activeLeases > ZERO) continue;
        if (vm?.state === 'warming') {
          return { accepted: false as const, reason: 'gate-host-not-ready', retryable: true as const, phase, gateHosts: [...gateHosts], humanIntervention: false as const };
        }
        result = requestHost({ ...host, role: 'gate-host' });
      } else {
        result = requestHost({ ...host, role: 'gate-host' });
      }
      if (!result.accepted) {
        for (const id of gateHosts) stopHost(id);
        gateHosts.splice(ZERO, gateHosts.length);
        phase = 'idle';
        pendingReleasePlanKey = undefined;
        releaseGateReady = false;
        setTrainingWorkerDemand(previousTrainingDemand, plan.workerTemplate);
        pushEvent({ type: 'release-gate-refused', phase: 'gate', reason: result.reason });
        return { accepted: false as const, reason: result.reason, retryable: false as const, phase, humanIntervention: false as const };
      }
      if (result.vm?.state !== 'ready') {
        if (!alreadyTracked) gateHosts.push(host.id);
        return { accepted: false as const, reason: 'gate-host-not-ready', retryable: true as const, phase, gateHosts: [...gateHosts], humanIntervention: false as const };
      }
      if (!alreadyTracked) gateHosts.push(host.id);
    }
    releaseGateReady = true;
    return { accepted: true as const, phase, trainingSlots: demandDuringGate, gateHosts: [...gateHosts], humanIntervention: false as const };
  }

  function advanceReleasePhase(next: 'publish' | 'verify'): void {
    if (phase === 'gate' && !releaseGateReady) {
      pushEvent({ type: 'release-gate-refused', phase, reason: 'gate-hosts-not-ready' });
      throw new Error('fake-cloud-billing-world: release gate has not been accepted');
    }
    for (const id of gateHosts) {
      const vm = cloud.status(id);
      if (vm.state !== 'ready' || vm.activeLeases === ZERO) {
        reconcileRuntime();
        pushEvent({ type: 'release-gate-refused', phase, id, reason: 'gate-host-not-ready' });
        throw new Error(`fake-cloud-billing-world: gate host ${id} is not ready`);
      }
    }
    const expected = phase === 'gate' ? 'publish' : phase === 'publish' ? 'verify' : undefined;
    if (next !== expected) throw new Error(`fake-cloud-billing-world: cannot advance ${phase} to ${next}`);
    phase = next;
    pushEvent({ type: 'release-phase', phase });
  }

  function finishReleaseGate(template: Omit<FakeCloudHostRequest, 'id' | 'role'>) {
    if (phase !== 'verify') throw new Error(`fake-cloud-billing-world: release gate cannot finish from ${phase}`);
    for (const id of gateHosts) stopHost(id);
    gateHosts.splice(ZERO, gateHosts.length);
    const restored = setTrainingWorkerDemand(previousTrainingDemand, template);
    if (restored.active !== previousTrainingDemand) {
      return { accepted: false as const, reason: 'training-workers-not-restored', trainingDemand: restored.active, phase, gateHosts: [...gateHosts], humanIntervention: false as const };
    }
    phase = 'idle';
    pendingReleasePlanKey = undefined;
    releaseGateReady = false;
    pushEvent({ type: 'release-phase', phase });
    return { accepted: true as const, trainingDemand: restored.active, gateHosts: [...gateHosts], phase, humanIntervention: false as const };
  }

  return {
    bakeImage(request: FakeCloudImageBakeRequest) {
      if (!request.imageId.trim() || !request.cutSha.trim()) throw new Error('fake-cloud-billing-world: imageId and cutSha are required');
      if (!Number.isFinite(request.bakeCostKrw) || request.bakeCostKrw < ZERO) throw new Error('fake-cloud-billing-world: invalid image bake cost');
      if (!Number.isFinite(request.registryDelayMs ?? ZERO) || (request.registryDelayMs ?? ZERO) < ZERO) throw new Error('fake-cloud-billing-world: invalid registry delay');
      if (images.has(request.imageId)) throw new Error(`fake-cloud-billing-world: duplicate image ${request.imageId}`);
      const projected = committedKrw() + request.bakeCostKrw;
      if (projected > options.monthlyBudgetKrw) {
        pushEvent({ type: 'image-bake-failed', id: request.imageId, reason: 'monthly-budget-exhausted' });
        return { accepted: false as const, imageId: request.imageId, reason: 'monthly-budget-exhausted', humanIntervention: false as const };
      }
      if (request.failure) {
        pushEvent({ type: 'image-bake-failed', id: request.imageId, reason: request.failure });
        return { accepted: false as const, imageId: request.imageId, reason: request.failure, humanIntervention: false as const };
      }
      const missingAssets = request.requiredAssets.filter(asset => !request.bakedAssets.includes(asset));
      if (missingAssets.length > ZERO) {
        pushEvent({ type: 'image-bake-failed', id: request.imageId, reason: 'recipe-incomplete' });
        return { accepted: false as const, imageId: request.imageId, reason: 'recipe-incomplete', humanIntervention: false as const };
      }
      const digestInput = JSON.stringify({ cutSha: request.cutSha, roles: [...request.roleTags].sort(), assets: [...request.bakedAssets].sort() });
      const digest = `sha256:${createHash('sha256').update(digestInput).digest('hex')}`;
      const registryDelayMs = request.registryDelayMs ?? ZERO;
      const image: ImageRecord = {
        imageId: request.imageId,
        cutSha: request.cutSha,
        digest,
        roleTags: [...request.roleTags],
        assets: [...request.bakedAssets],
        registryReadyAt: now() + registryDelayMs,
        registryReady: registryDelayMs === ZERO,
      };
      images.set(image.imageId, image);
      spentKrw += request.bakeCostKrw;
      if (request.bakeCostKrw > ZERO) ledger.push({ kind: 'image-bake', id: request.imageId, amountKrw: request.bakeCostKrw, at: now() });
      pushEvent({ type: 'image-bake-started', id: request.imageId });
      if (image.registryReady) pushEvent({ type: 'image-registry-ready', id: request.imageId });
      return { accepted: true as const, imageId: image.imageId, digest, state: image.registryReady ? 'ready' as const : 'syncing' as const, humanIntervention: false as const };
    },

    imageStatus(imageId: string) {
      reconcileRuntime();
      const image = images.get(imageId);
      return image ? { imageId: image.imageId, cutSha: image.cutSha, digest: image.digest, state: image.registryReady ? 'ready' as const : 'syncing' as const } : undefined;
    },

    requestHost,
    hostStatus(id: string): FakeCloudVmSnapshot | undefined {
      try { return openLeaseWhenReady(id); } catch { return undefined; }
    },
    stopHost,
    setTrainingWorkerDemand,
    beginReleaseGate,
    advanceReleasePhase,
    finishReleaseGate,
    snapshot() {
      reconcileRuntime();
      reconcileActiveTrainingWorkers();
      reconcileRuntime();
      const vms = cloud.statusAll();
      return {
        phase,
        trainingDemand,
        activeTrainingWorkers: activeTrainingWorkers.size,
        trainingWorkers: trainingWorkers.map(id => ({ id, state: vms.find(vm => vm.id === id)?.state ?? 'unknown' })),
        gateHosts: [...gateHosts],
        monthlyBudgetKrw: options.monthlyBudgetKrw,
        spentKrw,
        reservedKrw: reservedKrw(),
        committedKrw: committedKrw(),
        remainingBudgetKrw: options.monthlyBudgetKrw - committedKrw(),
        ledger: ledger.map(entry => ({ ...entry })),
        events: events.map(event => ({ ...event })),
        vms,
      };
    },
    events(): FakeCloudBillingEvent[] { return events.map(event => ({ ...event })); },
  };
}
