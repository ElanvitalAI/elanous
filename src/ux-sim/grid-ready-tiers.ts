import type { FakeCloudVmSnapshot } from './fake-cloud-vm.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';

export interface GridReadyHost {
  readonly vm: FakeCloudVmSnapshot;
  readonly maxLeases: number;
}

export interface GridColdProvision {
  readonly vmId: string;
  readonly hourlyCost: number;
  readonly readyAfterMs: number;
  readonly approvalId: string;
}

export interface GridReadyTierInput {
  /** Number of additional work slots the grid still needs. */
  readonly demand: number;
  readonly hosts: readonly GridReadyHost[];
  /** The pinned image digest required for this work. */
  readonly imageDigest: string;
  /** Resume timing and authorization metadata for the cold fallback. */
  readonly provision?: GridColdProvision;
  /** End of the burst window; resumed or newly created VMs stop after draining. */
  readonly stopAfterAt?: number;
  /** Delay before a resumed warm host becomes ready. */
  readonly warmReadyAfterMs?: number;
}

export type GridReadyTierDecision =
  | { readonly tier: 'hot'; readonly action: 'lease'; readonly hostId: string }
  | { readonly tier: 'pending'; readonly action: 'wait'; readonly hostId: string; readonly readyAfterMs: number }
  | { readonly tier: 'warm'; readonly action: 'resume'; readonly hostId: string; readonly readyAfterMs: number; readonly stopAfterAt: number }
  | {
      readonly tier: 'cold';
      readonly action: 'create-from-image';
      readonly vmId: string;
      readonly imageDigest: string;
      readonly hourlyCost: number;
      readonly readyAfterMs: number;
      readonly approvalId: string;
      readonly stopAfterAt: number;
    };

function requireCapacityDeadline(stopAfterAt: number | undefined, readyAfterMs: number, label: string): number {
  if (stopAfterAt === undefined) throw new Error(`grid-ready-tiers: stopAfterAt is required to ${label}`);
  if (!Number.isFinite(stopAfterAt) || stopAfterAt <= Date.now() + readyAfterMs) {
    throw new Error(`grid-ready-tiers: stopAfterAt must leave time for ${label} readiness`);
  }
  return stopAfterAt;
}

/**
 * Pick one next action, in cost order: ready capacity, stopped matching
 * capacity, then a new VM from the pinned image. The caller applies the action
 * through fake-cloud-vm and calls again against the remaining demand.
 */
export function decideGridReadyTier(input: GridReadyTierInput): GridReadyTierDecision | undefined {
  if (!Number.isSafeInteger(input.demand) || input.demand < 0) {
    throw new Error('grid-ready-tiers: demand must be a nonnegative integer');
  }
  if (!input.imageDigest.trim()) throw new Error('grid-ready-tiers: imageDigest is required');
  if (input.stopAfterAt !== undefined && !Number.isFinite(input.stopAfterAt)) {
    throw new Error('grid-ready-tiers: stopAfterAt must be a finite epoch');
  }
  if (input.warmReadyAfterMs !== undefined && (!Number.isFinite(input.warmReadyAfterMs) || input.warmReadyAfterMs < 0)) {
    throw new Error('grid-ready-tiers: warmReadyAfterMs must be a nonnegative duration');
  }
  if (input.demand === 0) return undefined;

  const ids = new Set<string>();
  for (const host of input.hosts) {
    const { vm, maxLeases } = host;
    if (!vm.id.trim()) throw new Error('grid-ready-tiers: host id is required');
    if (ids.has(vm.id)) throw new Error(`grid-ready-tiers: duplicate host ${vm.id}`);
    ids.add(vm.id);
    if (!Number.isSafeInteger(maxLeases) || maxLeases < 1) {
      throw new Error(`grid-ready-tiers: maxLeases must be a positive integer for ${vm.id}`);
    }
  }

  const hot = input.hosts
    .filter(({ vm, maxLeases }) => vm.state === 'ready' && vm.imageDigest === input.imageDigest && vm.activeLeases < maxLeases)
    .sort((left, right) => left.vm.id.localeCompare(right.vm.id))[0];
  if (hot) return { tier: 'hot', action: 'lease', hostId: hot.vm.id };

  const pending = input.hosts
    .filter(({ vm }) => vm.state === 'warming' && vm.imageDigest === input.imageDigest)
    .sort((left, right) => left.vm.id.localeCompare(right.vm.id))[0];
  if (pending) return {
    tier: 'pending', action: 'wait', hostId: pending.vm.id,
    readyAfterMs: Math.max(0, pending.vm.readyAt - Date.now()),
  };

  const warm = input.hosts
    .filter(({ vm }) => vm.state === 'parked' && vm.imageDigest === input.imageDigest)
    .sort((left, right) => left.vm.id.localeCompare(right.vm.id))[0];
  if (warm) {
    const readyAfterMs = input.warmReadyAfterMs ?? 0;
    const stopAfterAt = requireCapacityDeadline(input.stopAfterAt, readyAfterMs, 'resume warm capacity');
    return {
      tier: 'warm', action: 'resume', hostId: warm.vm.id, readyAfterMs, stopAfterAt,
    };
  }

  const provision = input.provision;
  if (!provision) throw new Error('grid-ready-tiers: provision metadata is required for cold capacity');
  const stopAfterAt = requireCapacityDeadline(input.stopAfterAt, provision.readyAfterMs, 'create cold capacity');
  if (!provision.vmId.trim() || ids.has(provision.vmId)) {
    throw new Error('grid-ready-tiers: cold vmId must be nonempty and unused');
  }
  if (!Number.isFinite(provision.hourlyCost) || provision.hourlyCost < 0) {
    throw new Error('grid-ready-tiers: hourlyCost must be nonnegative');
  }
  if (!Number.isFinite(provision.readyAfterMs) || provision.readyAfterMs < 0) {
    throw new Error('grid-ready-tiers: readyAfterMs must be a nonnegative duration');
  }
  if (!provision.approvalId.trim()) throw new Error('grid-ready-tiers: approvalId is required for cold capacity');
  return {
    tier: 'cold',
    action: 'create-from-image',
    vmId: provision.vmId,
    imageDigest: input.imageDigest,
    hourlyCost: provision.hourlyCost,
    readyAfterMs: provision.readyAfterMs,
    approvalId: provision.approvalId,
    stopAfterAt,
  };
}

/** Stateful fake-device consumer for decisions; cold approvals are single-use. */
const approvalsConsumedByFleet = new WeakMap<object, Set<string>>();

export function createGridReadyTierExecutor(fleet = createFakeCloudVm()) {
  const consumedLeaseDecisions = new WeakSet<object>();
  let consumedApprovals = approvalsConsumedByFleet.get(fleet);
  if (!consumedApprovals) {
    consumedApprovals = new Set<string>();
    approvalsConsumedByFleet.set(fleet, consumedApprovals);
  }
  return {
    apply(decision: GridReadyTierDecision): FakeCloudVmSnapshot | undefined {
      if (decision.action === 'lease') {
        if (consumedLeaseDecisions.has(decision)) {
          throw new Error(`grid-ready-tiers: lease decision for ${decision.hostId} was already consumed`);
        }
        const vm = fleet.openLease(decision.hostId);
        consumedLeaseDecisions.add(decision);
        return vm;
      }
      if (decision.action === 'wait') return fleet.status(decision.hostId);
      if (decision.action === 'resume') {
        requireCapacityDeadline(decision.stopAfterAt, decision.readyAfterMs, 'resume warm capacity');
        return fleet.resume(decision.hostId, { readyAfterMs: decision.readyAfterMs, stopAfterAt: decision.stopAfterAt });
      }
      if (!decision.approvalId.trim()) throw new Error('grid-ready-tiers: approvalId is required for cold capacity');
      requireCapacityDeadline(decision.stopAfterAt, decision.readyAfterMs, 'create cold capacity');
      if (consumedApprovals.has(decision.approvalId)) {
        throw new Error(`grid-ready-tiers: approval ${decision.approvalId} was already consumed`);
      }
      const vm = fleet.createFromImage({
        id: decision.vmId,
        imageDigest: decision.imageDigest,
        hourlyCost: decision.hourlyCost,
        readyAfterMs: decision.readyAfterMs,
        stopAfterAt: decision.stopAfterAt,
        terminationProtected: true,
      });
      consumedApprovals.add(decision.approvalId);
      return vm;
    },
    consumedApprovalIds(): string[] { return [...consumedApprovals].sort(); },
  };
}

export interface GridReadyDemandRunInput {
  readonly demand: number;
  readonly imageDigest: string;
  readonly maxLeases: number;
  readonly stopAfterAt?: number;
  readonly warmReadyAfterMs?: number;
  /** Return the approved cold VM details for this remaining demand. */
  readonly provisionForDemand?: (remainingDemand: number) => GridColdProvision;
  /** Called after warm/cold start or while an existing matching VM is warming. */
  readonly waitUntilReady: (hostId: string, readyAfterMs: number, fleet: ReturnType<typeof createFakeCloudVm>) => Promise<void>;
}

/** Apply one action at a time and wait for capacity before consuming another slot. */
export async function runGridReadyDemand(
  input: GridReadyDemandRunInput,
  fleet = createFakeCloudVm(),
): Promise<{ readonly fleet: ReturnType<typeof createFakeCloudVm>; readonly decisions: GridReadyTierDecision[] }> {
  if (!Number.isSafeInteger(input.demand) || input.demand < 0) {
    throw new Error('grid-ready-tiers: demand must be a nonnegative integer');
  }
  if (!Number.isSafeInteger(input.maxLeases) || input.maxLeases < 1) {
    throw new Error('grid-ready-tiers: maxLeases must be a positive integer');
  }
  const executor = createGridReadyTierExecutor(fleet);
  const decisions: GridReadyTierDecision[] = [];
  let remainingDemand = input.demand;
  while (remainingDemand > 0) {
    const snapshots = fleet.statusAll();
    const matchingCapacityInProgress = snapshots.some((vm) => vm.imageDigest === input.imageDigest
      && (vm.state === 'warming' || vm.state === 'parked' || (vm.state === 'ready' && vm.activeLeases < input.maxLeases)));
    const decision = decideGridReadyTier({
      demand: remainingDemand,
      hosts: snapshots.map((vm) => ({ vm, maxLeases: input.maxLeases })),
      imageDigest: input.imageDigest,
      ...(input.stopAfterAt === undefined ? {} : { stopAfterAt: input.stopAfterAt }),
      ...(input.warmReadyAfterMs === undefined ? {} : { warmReadyAfterMs: input.warmReadyAfterMs }),
      ...(!input.provisionForDemand || matchingCapacityInProgress ? {} : { provision: input.provisionForDemand(remainingDemand) }),
    });
    if (!decision) break;
    decisions.push(decision);
    executor.apply(decision);
    if (decision.action === 'lease') {
      remainingDemand -= 1;
      continue;
    }
    const hostId = 'hostId' in decision ? decision.hostId : decision.vmId;
    await input.waitUntilReady(hostId, decision.readyAfterMs, fleet);
    if (fleet.status(hostId).state !== 'ready') {
      throw new Error(`grid-ready-tiers: ${decision.action} did not start a usable VM`);
    }
  }
  return { fleet, decisions };
}

/** Runnable UX-sim scenario used by the CLI and the focused contract test. */
export async function runGridReadyTierScenario(
  waitUntilReady: GridReadyDemandRunInput['waitUntilReady'] = async (_hostId, readyAfterMs) => {
    await new Promise<void>((resolve) => setTimeout(resolve, readyAfterMs));
  },
): Promise<{ readonly fleet: ReturnType<typeof createFakeCloudVm>; readonly decisions: GridReadyTierDecision[] }> {
  const fleet = createFakeCloudVm();
  const imageDigest = 'sha256:ux-sim-grid-image';
  const stopAfterAt = Date.now() + 60_000;
  fleet.createFromImage({ id: 'hot-sim-1', imageDigest, hourlyCost: 36, stopAfterAt });
  fleet.createFromImage({ id: 'warm-sim-1', imageDigest, hourlyCost: 36 });
  fleet.stop('warm-sim-1');
  fleet.createFromImage({ id: 'wrong-image-sim-1', imageDigest: 'sha256:older-image', hourlyCost: 36 });
  const result = await runGridReadyDemand({
    demand: 3,
    imageDigest,
    maxLeases: 1,
    stopAfterAt,
    warmReadyAfterMs: 25,
    provisionForDemand: () => ({ vmId: 'cold-sim-1', hourlyCost: 36, readyAfterMs: 25, approvalId: 'approval-ux-sim-grid-1' }),
    waitUntilReady,
  }, fleet);
  return result;
}
