import { debug } from '../debug/log.js';
import { ResourceLedger } from '../control-plane/ledger.js';
import { prepareBudgetedBurstReadyLadders } from '../fleet/burst-auto-wire-ladder.js';
import { openBurstReadyLease, type BurstReadyPurpose, type BurstReadyTtlHours } from '../fleet/burst-ready-ladder.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { withSimClock } from './fake-clock.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const PREP_READY_MS = 5 * 60 * 1000;
const IMAGE = `sha256:${'a'.repeat(64)}`;
const PURPOSES: readonly BurstReadyPurpose[] = ['gate', 'implementation', 'execution'];
const TTLS: readonly BurstReadyTtlHours[] = [2, 4];

export interface BurstReadyLadderRunEvidence {
  readonly purpose: BurstReadyPurpose;
  readonly ttlHours: BurstReadyTtlHours;
  readonly vmId: string;
  readonly preparedAt: number;
  readonly readyAt: number;
  readonly prematureAdmissionRejected: boolean;
  readonly earlyReadyAdmissionRejected: boolean;
  readonly admittedAt: number;
  readonly postExpiryAdmissionRejected: boolean;
  readonly drainingAt: number;
  readonly leaseClosedAt: number;
  readonly stopAfterAt: number;
  readonly stoppedAt: number;
  readonly finalState: string;
  readonly poweredOnMs: number;
}

export interface BurstReadyLadderSimulationResult {
  readonly pass: boolean;
  readonly runs: readonly BurstReadyLadderRunEvidence[];
  readonly mockVmCount: number;
  readonly forbiddenTerminateCount: number;
  readonly allPreparedOneHourAhead: boolean;
  readonly allPrematureAdmissionsRejected: boolean;
  readonly allReadyBeforeAdmissionRejected: boolean;
  readonly allAdmittedReady: boolean;
  readonly allDeadlineDraining: boolean;
  readonly allPostExpiryAdmissionsRejected: boolean;
  readonly allLeasesDrainedAfterExpiry: boolean;
  readonly allPoweredOnDurationMatches: boolean;
  readonly allStoppedAfterDrain: boolean;
}

/** S2 device: runs the real planner and existing fake cloud VM without a provider adapter. */
export async function runBurstReadyLadderSimulation(runId: string, scenarioId: string): Promise<BurstReadyLadderSimulationResult> {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('burst-ready-ladder simulation runId must be a UUID');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(scenarioId)) throw new Error('burst-ready-ladder simulation scenarioId is invalid');

  const runs: BurstReadyLadderRunEvidence[] = [];
  let mockVmCount = 0;
  let forbiddenTerminateCount = 0;
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'burst-ready-sim-ledger-'));
  try { await withSimClock(Date.parse('2026-11-03T00:00:00Z'), async (clock) => {
    const fleet = createFakeCloudVm();
    const ledger = new ResourceLedger(ledgerRoot);
    for (const purpose of PURPOSES) {
      for (const ttlHours of TTLS) {
        const admissionAt = clock.now() + HOUR_MS;
        const requestId = `${purpose}-${ttlHours}h-${runs.length + 1}`;
        const prices = { gate: 100, implementation: 200, execution: 300 };
        const result = prepareBudgetedBurstReadyLadders({
          requestId, owner: 'SIM', now: clock.now(), imageDigest: IMAGE,
          pressures: {
            gate: { queued: purpose === 'gate' ? 1 : 0, blocked: 0 },
            implementation: { queued: purpose === 'implementation' ? 1 : 0, blocked: 0 },
            execution: { queued: purpose === 'execution' ? 1 : 0, blocked: 0 },
          },
          hourlyCostKrw: prices, ttlHours, maxMachinesPerPurpose: 1,
        }, {
          ledger,
          prepare: (plan) => fleet.createFromImage({
            id: plan.requestId, imageDigest: plan.imageDigest, hourlyCost: prices[plan.purpose],
            readyAfterMs: PREP_READY_MS, stopAfterAt: plan.stopAfterAt, terminationProtected: true,
          }),
        });
        if (result.decision.status !== 'planned' || result.ladderPlans.length !== 1 || result.prepared.length !== 1) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h budget did not authorize exactly one prepared VM`);
        }
        const plan = result.ladderPlans[0]!;
        const vm = result.prepared[0]!;
        clock.setTime(plan.prepareAt);
        mockVmCount++;
        if (vm.state !== 'warming' || vm.readyAt !== plan.prepareAt + PREP_READY_MS) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h did not prepare at the planned warm-up boundary`);
        }
        let prematureAdmissionRejected = false;
        try { fleet.openLease(vm.id); }
        catch (error) {
          prematureAdmissionRejected = error instanceof Error && error.message.includes('new lease refused');
        }
        if (!prematureAdmissionRejected || fleet.status(vm.id).activeLeases !== 0) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h admitted work before the VM was ready`);
        }

        clock.setTime(vm.readyAt);
        if (fleet.status(vm.id).state !== 'ready') {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h was not ready before admission`);
        }
        let earlyReadyAdmissionRejected = false;
        try {
          openBurstReadyLease(plan, clock.now(), () => fleet.openLease(vm.id));
        } catch (error) {
          earlyReadyAdmissionRejected = error instanceof Error && error.message.includes('before scheduled time');
        }
        if (!earlyReadyAdmissionRejected || fleet.status(vm.id).activeLeases !== 0) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h admitted work after warm-up but before scheduled time`);
        }

        clock.setTime(plan.admissionAt);
        const admitted = openBurstReadyLease(plan, clock.now(), () => fleet.openLease(vm.id));
        if (admitted.state !== 'ready' || admitted.activeLeases !== 1) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h admission was not backed by ready capacity`);
        }

        clock.setTime(plan.stopAfterAt);
        const draining = fleet.status(vm.id);
        if (draining.state !== 'draining' || draining.activeLeases !== 1) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h did not drain active work at TTL expiry`);
        }
        let postExpiryAdmissionRejected = false;
        try { openBurstReadyLease(plan, clock.now(), () => fleet.openLease(vm.id)); }
        catch (error) {
          postExpiryAdmissionRejected = error instanceof Error && error.message.includes('at or after TTL expiry');
        }
        if (!postExpiryAdmissionRejected || fleet.status(vm.id).activeLeases !== 1) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h accepted new work after TTL expiry`);
        }

        const leaseClosedAt = plan.stopAfterAt + 5 * 60 * 1000;
        clock.setTime(leaseClosedAt);
        const stopped = fleet.closeLease(vm.id);
        if (stopped.state !== 'parked' || stopped.activeLeases !== 0) {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h did not stop after active work drained`);
        }
        const events = fleet.events().filter((event) => event.id === vm.id);
        const prepared = events.find((event) => event.type === 'create-from-image');
        const ready = events.find((event) => event.type === 'ready');
        const admission = events.find((event) => event.type === 'lease-opened');
        const leaseClosed = events.find((event) => event.type === 'lease-closed');
        const deadline = events.find((event) => event.type === 'stop-after-draining');
        const stop = events.find((event) => event.type === 'stop');
        if (prepared?.type !== 'create-from-image' || ready?.type !== 'ready'
          || admission?.type !== 'lease-opened' || leaseClosed?.type !== 'lease-closed'
          || deadline?.type !== 'stop-after-draining' || stop?.type !== 'stop') {
          throw new Error(`burst-ready-ladder: ${purpose} ${ttlHours}h event evidence is incomplete`);
        }
        runs.push({
          purpose,
          ttlHours,
          vmId: vm.id,
          preparedAt: prepared.at,
          readyAt: ready.at,
          prematureAdmissionRejected,
          earlyReadyAdmissionRejected,
          admittedAt: admission.at,
          postExpiryAdmissionRejected,
          drainingAt: deadline.at,
          leaseClosedAt: leaseClosed.at,
          stopAfterAt: plan.stopAfterAt,
          stoppedAt: stop.at,
          finalState: stopped.state,
          poweredOnMs: stopped.poweredOnMs,
        });
      }
    }
    forbiddenTerminateCount = fleet.events().filter((event) => event.type === 'forbidden-terminate').length;
  }); } finally { rmSync(ledgerRoot, { recursive: true, force: true }); }

  const allPreparedOneHourAhead = runs.length === PURPOSES.length * TTLS.length
    && runs.every((run) => run.admittedAt - run.preparedAt === HOUR_MS);
  const allPrematureAdmissionsRejected = runs.every((run) => run.prematureAdmissionRejected);
  const allReadyBeforeAdmissionRejected = runs.every((run) => run.earlyReadyAdmissionRejected);
  const allAdmittedReady = runs.every((run) => run.readyAt <= run.admittedAt);
  const allDeadlineDraining = runs.every((run) => run.drainingAt === run.stopAfterAt);
  const allPostExpiryAdmissionsRejected = runs.every((run) => run.postExpiryAdmissionRejected);
  const allLeasesDrainedAfterExpiry = runs.every((run) => run.leaseClosedAt > run.stopAfterAt);
  const drainGraceMs = 5 * 60 * 1000;
  const allPoweredOnDurationMatches = runs.every((run) => run.poweredOnMs === HOUR_MS + run.ttlHours * HOUR_MS + drainGraceMs);
  const allStoppedAfterDrain = runs.every((run) => run.stoppedAt === run.leaseClosedAt && run.finalState === 'parked');
  const result = {
    pass: allPreparedOneHourAhead && allPrematureAdmissionsRejected && allReadyBeforeAdmissionRejected && allAdmittedReady && allDeadlineDraining
      && allPostExpiryAdmissionsRejected && allLeasesDrainedAfterExpiry && allPoweredOnDurationMatches
      && allStoppedAfterDrain && mockVmCount === runs.length && forbiddenTerminateCount === 0,
    runs,
    mockVmCount,
    forbiddenTerminateCount,
    allPreparedOneHourAhead,
    allPrematureAdmissionsRejected,
    allReadyBeforeAdmissionRejected,
    allAdmittedReady,
    allDeadlineDraining,
    allPostExpiryAdmissionsRejected,
    allLeasesDrainedAfterExpiry,
    allPoweredOnDurationMatches,
    allStoppedAfterDrain,
  };
  debug.log('fleet.burst', 'ready-ladder-completed', {
    runId,
    scenarioId,
    purposeCount: PURPOSES.length,
    ttlHours: [...TTLS],
    purposes: [...PURPOSES],
    runCount: runs.length,
    warmupLeadMs: HOUR_MS,
    allPreparedOneHourAhead,
    allPrematureAdmissionsRejected,
    allReadyBeforeAdmissionRejected,
    allAdmittedReady,
    allDeadlineDraining,
    allPostExpiryAdmissionsRejected,
    allLeasesDrainedAfterExpiry,
    allPoweredOnDurationMatches,
    allStoppedAfterDrain,
    mockVmCount,
    forbiddenTerminateCount,
  });
  return result;
}
