import { ResourceLedger, type ResourceRecord } from '../control-plane/ledger.js';
import { debug } from '../debug/log.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { withFileLockSync } from '../storage/file-lock.js';

export const CLOUD_MONTHLY_BUDGET_KRW = 2_000_000;
export const BURST_PURPOSES = ['gate', 'implementation', 'execution'] as const;
export type BurstPurpose = typeof BURST_PURPOSES[number];
export type BurstTtlHours = 2 | 4;

export interface BurstPressure { readonly queued: number; readonly blocked: number }
export interface BurstBudgetInput {
  readonly requestId: string;
  readonly owner: string;
  readonly now: number;
  readonly imageDigest: string;
  readonly pressures: Readonly<Record<BurstPurpose, BurstPressure>>;
  readonly hourlyCostKrw: Readonly<Record<BurstPurpose, number>>;
  readonly ttlHours: BurstTtlHours;
  readonly maxMachinesPerPurpose: number;
}
export interface BurstPlan { readonly requestId: string; readonly purpose: BurstPurpose; readonly count: number; readonly ttlHours: BurstTtlHours; readonly estimatedCostKrw: number }
export interface BurstBudgetDecision { readonly status: 'planned' | 'budget-blocked' | 'no-demand'; readonly spentThisMonthKrw: number; readonly remainingKrw: number; readonly plans: readonly BurstPlan[]; readonly reason?: string }
export interface BurstPlanLedger {
  readonly path: string;
  list(filter?: { kind?: string }, now?: number): readonly ResourceRecord[];
  register(record: ResourceRecord, owner: string): ResourceRecord;
}
/** Pure planner batch; it must not provision or persist before the budget decision is committed. */
export type BurstLadderPlanner = (requests: readonly { requestId: string; purpose: BurstPurpose; imageDigest: string; admissionAt: number; ttlHours: BurstTtlHours }[]) => readonly unknown[];

function monthSpend(rows: readonly ResourceRecord[], from: number, to: number): number {
  return rows.reduce((sum, row) => {
    if (!(row.attrs.inventory === true || row.attrs.inventory === 'archived')) return sum;
    const rate = row.attrs.hourlyCost;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return sum;
    const started = Number(row.attrs.startSignedAt) || row.observedAt;
    const ended = row.attrs.inventory === 'archived' ? Number(row.attrs.stoppedAt) || to : to;
    return sum + Math.max(0, Math.min(to, ended) - Math.max(from, started)) / 3_600_000 * rate;
  }, 0);
}

/** Budget gate and NEXUS decision record only. It never provisions resources. */
export function decideBurstWithinBudget(
  input: BurstBudgetInput,
  dependencies: { ledger?: BurstPlanLedger; planLadder: BurstLadderPlanner },
): BurstBudgetDecision {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(input.requestId)) throw new Error('requestId must be a safe identifier of at most 32 characters');
  if (!input.owner.trim()) throw new Error('owner is required');
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)) throw new Error('a pinned sha256 imageDigest is required');
  if (!Number.isFinite(input.now) || input.now <= 0) throw new Error('now must be a positive epoch timestamp');
  if (input.ttlHours !== 2 && input.ttlHours !== 4) throw new Error('ttlHours must be 2 or 4');
  if (!Number.isInteger(input.maxMachinesPerPurpose) || input.maxMachinesPerPurpose < 1) throw new Error('maxMachinesPerPurpose must be a positive integer');

  const demandByPurpose = new Map<BurstPurpose, number>();
  for (const purpose of BURST_PURPOSES) {
    const pressure = input.pressures[purpose]; const rate = input.hourlyCostKrw[purpose];
    if (!Number.isInteger(pressure.queued) || pressure.queued < 0 || !Number.isInteger(pressure.blocked) || pressure.blocked < 0) throw new Error(`invalid pressure: ${purpose}`);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`hourly cost must be positive: ${purpose}`);
    demandByPurpose.set(purpose, Math.min(input.maxMachinesPerPurpose, Math.max(pressure.queued, pressure.blocked)));
  }

  const ledger = dependencies.ledger ?? new ResourceLedger();
  mkdirSync(dirname(ledger.path), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${ledger.path}.burst-budget.lock`, () => {
    const recordId = `fleet-burst-decision:${input.requestId}`;
    const prior = ledger.list({ kind: 'universe' }, input.now).find(row => row.id === recordId);
    if (prior) {
      if (prior.owner !== input.owner) throw new Error('burst request id is owned by another seat');
      return prior.attrs.decision as BurstBudgetDecision;
    }
    const monthStart = Date.UTC(new Date(input.now).getUTCFullYear(), new Date(input.now).getUTCMonth(), 1);
    const rows = ledger.list({}, input.now);
    const spentThisMonthKrw = monthSpend(rows.filter(row => row.kind === 'fleet-resource'), monthStart, input.now);
    const pendingReservationsKrw = rows
      .filter(row => row.kind === 'universe' && row.attrs.type === 'burst-auto-budget-decision' && row.attrs.status === 'planned' && row.observedAt >= monthStart)
      .reduce((sum, row) => sum + Math.max(0, Number(row.attrs.reservedKrw) || 0), 0);
    const remainingKrw = Math.max(0, CLOUD_MONTHLY_BUDGET_KRW - spentThisMonthKrw - pendingReservationsKrw);
    const plans: BurstPlan[] = []; let committed = 0;
    for (const purpose of BURST_PURPOSES) {
      const demand = demandByPurpose.get(purpose)!; if (!demand) continue;
      const perMachine = input.hourlyCostKrw[purpose] * input.ttlHours;
      const count = Math.min(demand, Math.floor((remainingKrw - committed) / perMachine));
      if (count < 1) continue;
      plans.push({ requestId: input.requestId, purpose, count, ttlHours: input.ttlHours, estimatedCostKrw: count * perMachine });
      committed += count * perMachine;
    }
    const ladderRequests = plans.flatMap(plan => Array.from({ length: plan.count }, (_, index) => ({
      requestId: `${input.requestId}-${plan.purpose}-${index + 1}`, purpose: plan.purpose, imageDigest: input.imageDigest,
      ttlHours: input.ttlHours, admissionAt: input.now + 60 * 60 * 1000,
    })));
    // Validate/build every ladder plan before publishing the reservation decision.
    dependencies.planLadder(ladderRequests);
    const hasDemand = [...demandByPurpose.values()].some(Boolean);
    const status = plans.length ? 'planned' : hasDemand ? 'budget-blocked' : 'no-demand';
    const decision: BurstBudgetDecision = { status, spentThisMonthKrw, remainingKrw, plans,
      ...(status === 'budget-blocked' ? { reason: 'monthly budget exhausted or next machine exceeds remaining budget' } : {}) };
    const record: ResourceRecord = {
      id: recordId, kind: 'universe', machine: 'nexus', name: 'burst-auto-budget-decision', owner: input.owner,
      attrs: { type: 'burst-auto-budget-decision', requestId: input.requestId, status, monthlyBudgetKrw: CLOUD_MONTHLY_BUDGET_KRW, spentThisMonthKrw, pendingReservationsKrw, reservedKrw: committed, remainingKrw, decision, realResourcesCreated: 0 },
      observedAt: input.now, ttlMs: 90 * 24 * 60 * 60 * 1000,
    };
    ledger.register(record, input.owner);
    debug.log('fleet.burst', 'budget-decision', { requestId: input.requestId, status, spentThisMonthKrw, plans: plans.length, realResourcesCreated: 0 });
    return decision;
  });
}
