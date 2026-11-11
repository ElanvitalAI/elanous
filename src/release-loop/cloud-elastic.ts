import type { FakeCloudProviderRequest, FakeCloudVmSnapshot } from '../ux-sim/fake-cloud-vm.js';
import { ResourceLedger } from '../control-plane/ledger.js';
import { randomUUID } from 'node:crypto';

export const CLOUD_ELASTIC_MONTHLY_CAP_KRW = 5_000_000;
// Source: .rules/30-harness/testing-gates.md — elapsed lease cost is measured in milliseconds per hour.
const HOUR_MS = 3_600_000;

export interface CloudElasticRequest extends FakeCloudProviderRequest {
  readonly event: string;
  readonly purpose: string;
  readonly provider: 'aws' | 'gcp';
  readonly hostType: string;
}
export interface CloudElasticGraphRequest {
  readonly request: CloudElasticRequest;
  readonly approval: { readonly by: 'OP'; readonly approved: true; readonly approvedAt: string; readonly estimateKrw: number;
    readonly requestSha256: string; readonly rateSource: string };
}
export interface CloudElasticProvider {
  start(request: FakeCloudProviderRequest): FakeCloudVmSnapshot;
  join(id: string): FakeCloudVmSnapshot;
  leave(id: string): FakeCloudVmSnapshot;
  status(id: string): FakeCloudVmSnapshot;
  readonly monthlySpentKrw: number;
  markOrphan?(id: string, reason: string): void;
}
export type CloudElasticEvent =
  | { readonly type: 'request'; readonly at: number; readonly event: string; readonly id: string; readonly provider: 'aws' | 'gcp'; readonly hostType: string; readonly purpose: string; readonly expectedHours: number; readonly estimatedCostKrw: number }
  | { readonly type: 'start' | 'start-denied' | 'join' | 'work' | 'orphan'; readonly at: number; readonly id: string; readonly detail?: string }
  | { readonly type: 'leave'; readonly at: number; readonly id: string; readonly detail?: string; readonly costKrw: number };
export interface CloudElasticResult {
  readonly status: 'left'; readonly events: readonly CloudElasticEvent[]; readonly spentBeforeKrw: number;
  readonly costKrw: number; readonly vmState: FakeCloudVmSnapshot['state'];
}

interface BudgetReservation { estimateKrw: number; startedAt: number; hourlyCostKrw: number }
interface BudgetState { tail: Promise<void>; reservations: Map<string, BudgetReservation> }
const providerBudgets = new WeakMap<CloudElasticProvider, BudgetState>();
async function withBudgetLock<T>(state: BudgetState, action: () => T | Promise<T>): Promise<T> {
  const previous = state.tail;
  let unlock!: () => void;
  state.tail = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  try { return await action(); } finally { unlock(); }
}
async function reserveMonthlyBudget(provider: CloudElasticProvider, id: string, estimateKrw: number, hourlyCostKrw: number): Promise<() => Promise<void>> {
  let state = providerBudgets.get(provider);
  if (!state) { state = { tail: Promise.resolve(), reservations: new Map() }; providerBudgets.set(provider, state); }
  const startedAt = Date.now();
  await withBudgetLock(state, () => {
    if (state!.reservations.has(id)) throw new Error(`cloud-elastic: request ${id} already has an active budget reservation`);
    const current = provider.monthlySpentKrw + [...state!.reservations.values()].reduce((sum, reservation) => {
      const accruedKrw = Math.max(0, Date.now() - reservation.startedAt) / HOUR_MS * reservation.hourlyCostKrw;
      return sum + Math.max(reservation.estimateKrw, accruedKrw);
    }, 0);
    if (current + estimateKrw > CLOUD_ELASTIC_MONTHLY_CAP_KRW)
      throw new Error(`cloud-elastic: monthly cap exceeded (${current + estimateKrw} > ${CLOUD_ELASTIC_MONTHLY_CAP_KRW})`);
    state!.reservations.set(id, { estimateKrw, startedAt, hourlyCostKrw });
  });
  let released = false;
  return async () => {
    if (released) return;
    await withBudgetLock(state!, () => { state!.reservations.delete(id); released = true; });
  };
}

/** Adapter for the Nexus resource ledger; callers inject it as runCloudElasticRecipe's event sink. */
export function createNexusCloudElasticEventSink(ledger = new ResourceLedger(), owner = 'RLA') {
  return (event: CloudElasticEvent): void => {
    const eventName = `release-loop.cloud-elastic/${event.type}`;
    ledger.register({ id: `release-loop-cloud-elastic:${event.id}:${randomUUID()}`, kind: 'universe', machine: 'nexus',
      name: eventName, owner, attrs: { ...event, recordType: 'release-loop-cloud-elastic-event', eventType: event.type, eventName },
      observedAt: event.at, ttlMs: 90 * 24 * 60 * 60 * 1000 }, owner);
  };
}

/** These graph nodes are the only recipe entry points for the existing hand tools. */
export const CLOUD_ELASTIC_RECIPE_NODES = {
  join: { id: 'cloud-join', recipe: 'cmd:cloud-join', script: '~/elanous-hq/seat-state/OP/tools/cloud-join.sh', purpose: 'join an approved, ready VM to the worker pool' },
  leave: { id: 'cloud-leave', recipe: 'cmd:cloud-leave', script: '~/elanous-hq/seat-state/OP/tools/cloud-leave.sh', purpose: 'drain workers and stop the VM without terminating it' },
} as const;
export function cloudElasticRecipeNodes(runHandTool: (script: string, vm: FakeCloudVmSnapshot) => Promise<void>) {
  return {
    join: (vm: FakeCloudVmSnapshot) => runHandTool(CLOUD_ELASTIC_RECIPE_NODES.join.script, vm),
    leave: (vm: FakeCloudVmSnapshot) => runHandTool(CLOUD_ELASTIC_RECIPE_NODES.leave.script, vm),
  };
}

/** Event → budgeted provider start → recipe join → work → recipe leave. */
export async function runCloudElasticRecipe(
  request: CloudElasticRequest,
  provider: CloudElasticProvider,
  joinNode: (vm: FakeCloudVmSnapshot) => Promise<void>,
  work: (vm: FakeCloudVmSnapshot) => Promise<void>,
  leaveNode: (vm: FakeCloudVmSnapshot) => Promise<void> = async (vm) => { provider.leave(vm.id); },
  recordEvent: (event: CloudElasticEvent) => void = () => {},
): Promise<CloudElasticResult> {
  if (!request.event.trim() || !request.purpose.trim() || !request.hostType.trim()) throw new Error('cloud-elastic request needs event, purpose, and hostType');
  const spentBeforeKrw = provider.monthlySpentKrw;
  if (!Number.isFinite(spentBeforeKrw) || spentBeforeKrw < 0 || !Number.isFinite(request.expectedHours) || request.expectedHours <= 0
    || !Number.isFinite(request.hourlyCostKrw) || request.hourlyCostKrw < 0) throw new Error('cloud-elastic request has invalid monthly spend or cost estimate');
  const estimate = request.expectedHours * request.hourlyCostKrw;
  const events: CloudElasticEvent[] = [];
  const record = (event: CloudElasticEvent) => { events.push(event); recordEvent(event); };
  record({ type: 'request', at: Date.now(), event: request.event, id: request.id,
    provider: request.provider, hostType: request.hostType, purpose: request.purpose, expectedHours: request.expectedHours, estimatedCostKrw: estimate });
  let releaseBudget: () => Promise<void> = async () => {};
  try { releaseBudget = await reserveMonthlyBudget(provider, request.id, estimate, request.hourlyCostKrw); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record({ type: 'start-denied', at: Date.now(), id: request.id, detail });
    throw error;
  }
  let vm: FakeCloudVmSnapshot;
  try { vm = provider.start(request); }
  catch (error) {
    await releaseBudget();
    record({ type: 'start-denied', at: Date.now(), id: request.id, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  let leaveStarted = false;
  let leaveRecorded = false;
  const recordLeave = (stopped: FakeCloudVmSnapshot, detail = `estimatedCostKrw=${stopped.estimatedCost}`) => {
    leaveRecorded = true;
    record({ type: 'leave', at: Date.now(), id: stopped.id, detail, costKrw: stopped.estimatedCost });
  };
  try {
    record({ type: 'start', at: Date.now(), id: vm.id });
    await joinNode(vm);
    const joined = provider.join(vm.id);
    record({ type: 'join', at: Date.now(), id: vm.id });
    await work(joined);
    record({ type: 'work', at: Date.now(), id: vm.id });
    const beforeLeave = provider.status(vm.id);
    leaveStarted = true;
    await leaveNode(beforeLeave);
    const stopped = provider.status(vm.id);
    if (stopped.state !== 'parked') throw new Error(`cloud-elastic: leave did not stop ${vm.id}`);
    const costKrw = stopped.estimatedCost;
    recordLeave(stopped);
    await releaseBudget();
    if (provider.monthlySpentKrw > CLOUD_ELASTIC_MONTHLY_CAP_KRW) throw new Error(`cloud-elastic: monthly cap exceeded after work (${provider.monthlySpentKrw} > ${CLOUD_ELASTIC_MONTHLY_CAP_KRW})`);
    return { status: 'left', events, spentBeforeKrw, costKrw, vmState: stopped.state };
  } catch (error) {
    const current = provider.status(vm.id);
    if (current.state === 'parked') {
      if (!leaveRecorded) recordLeave(current, `cleanup-after-error estimatedCostKrw=${current.estimatedCost}`);
      await releaseBudget();
      throw error;
    }
    if (leaveStarted) {
      const reason = error instanceof Error ? error.message : String(error);
      provider.markOrphan?.(vm.id, reason);
      try { record({ type: 'orphan', at: Date.now(), id: vm.id, detail: reason }); } catch { /* keep the provider's orphan evidence if Nexus is unavailable */ }
      throw new Error(`cloud-elastic: orphan VM ${vm.id}; ${reason}`, { cause: error });
    }
    try {
      leaveStarted = true;
      await leaveNode(current);
      const stopped = provider.status(vm.id);
      if (stopped.state !== 'parked') throw new Error(`cloud-elastic: leave did not stop ${vm.id}`);
      recordLeave(stopped, `cleanup-after-error estimatedCostKrw=${stopped.estimatedCost}`);
      await releaseBudget();
    } catch (leaveError) {
      const afterLeave = provider.status(vm.id);
      if (afterLeave.state === 'parked') {
        if (!leaveRecorded) recordLeave(afterLeave, `cleanup-after-error estimatedCostKrw=${afterLeave.estimatedCost}`);
        await releaseBudget();
        throw error;
      }
      const reason = leaveError instanceof Error ? leaveError.message : String(leaveError);
      provider.markOrphan?.(vm.id, reason);
      try { record({ type: 'orphan', at: Date.now(), id: vm.id, detail: reason }); } catch { /* provider event remains the fallback evidence */ }
      throw new Error(`cloud-elastic: orphan VM ${vm.id}; ${reason}`, { cause: error });
    }
    throw error;
  }
}
