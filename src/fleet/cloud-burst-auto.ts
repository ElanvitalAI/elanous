import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ResourceLedger, type ResourceRecord } from '../control-plane/ledger.js';
import type { CloudVmAdapter } from '../release-loop/cloud-vm-adapter.js';
import { archiveInventoryResource, registerInventoryResource } from './resource-inventory.js';
import { prepareBudgetedBurstReadyLadders } from './burst-auto-wire-ladder.js';
import type { BurstPurpose, BurstTtlHours } from './burst-auto-within-budget.js';
import { acquireLockAsync } from '../storage/file-lock.js';

const HOUR_MS = 60 * 60 * 1000;
const MAX_REQUEST_ID_LENGTH = 36; // Source: RFC 4122 UUID text form; older 32-character IDs remain accepted.
const CLOUD_BURST_LOCK_OPTIONS = {
  staleMs: 300_000, // Source: storage/file-lock.ts LockOpts default stale recovery window.
  retryBusyMs: 250,
  maxTries: 240, // Source: storage/file-lock.ts async lock retry policy.
  breakDeadHolder: true,
} as const;

export interface CloudBurstAutoInput {
  readonly requestId: string;
  readonly owner: string;
  readonly host: CloudBurstVmHost;
  readonly purpose: BurstPurpose;
  readonly now: number;
  readonly queueDepth: number;
  readonly blockedCount: number;
  readonly threshold: number;
  readonly imageDigest: string;
  readonly hourlyCostKrw: number;
  readonly ttlHours: BurstTtlHours;
}

/** Only the worker aliases approved for automatic task bursts; protected and gate hosts are excluded. */
export type CloudBurstVmHost = 'aws2' | 'aws3' | 'gcp2';

export interface CloudBurstAutoResult {
  readonly state: 'below-threshold' | 'budget-blocked' | 'warming' | 'waiting-for-admission' | 'admitted' | 'draining' | 'stopped';
  readonly admissionAt?: number;
  readonly reason?: string;
}

function providerFor(host: string): 'aws' | 'gcp' {
  if (host.startsWith('aws')) return 'aws';
  if (host.startsWith('gcp')) return 'gcp';
  throw new Error(`cloud burst requires an aws or gcp cloud-vm host alias: ${host}`);
}

function lifecycleId(requestId: string): string { return `fleet-cloud-burst:${requestId}`; }
function isSafeRequestId(requestId: string): boolean {
  return requestId.length <= MAX_REQUEST_ID_LENGTH && /^[A-Za-z0-9._-]+$/.test(requestId);
}
function budgetLedgerRequestId(requestId: string): string {
  if (requestId.length <= 32) return requestId;
  return `b-${createHash('sha256').update(requestId).digest('hex').slice(0, 30)}`; // Source: 120-bit digest suffix keeps UUID keys inside the budget ledger's 32-character contract.
}

function saveLifecycle(ledger: ResourceLedger, requestId: string, owner: string, now: number, attrs: Record<string, unknown>): void {
  ledger.register({ id: lifecycleId(requestId), kind: 'universe', machine: 'nexus', name: 'cloud-burst-lifecycle', owner,
    attrs: { type: 'cloud-burst-lifecycle', requestId, ...attrs }, observedAt: now, ttlMs: 90 * 24 * HOUR_MS }, owner);
}

const requestQueues = new Map<string, Promise<void>>();

async function serializeRequest<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = requestQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  requestQueues.set(key, next);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (requestQueues.get(key) === next) requestQueues.delete(key);
  }
}

/** Reconcile one cost-bounded burst slot through the configured CloudVmAdapter boundary. */
export async function reconcileCloudBurstAuto(
  input: CloudBurstAutoInput,
  dependencies: {
    readonly ledger?: ResourceLedger;
    readonly cloudVm: CloudVmAdapter;
    readonly join: (host: CloudBurstVmHost, purpose: BurstPurpose) => Promise<void>;
    readonly isWarm: (host: CloudBurstVmHost) => Promise<boolean>;
    readonly activeLeases: (host: CloudBurstVmHost) => Promise<number>;
    readonly admit: (host: CloudBurstVmHost, purpose: BurstPurpose) => Promise<void>;
    readonly withdraw: (host: CloudBurstVmHost, purpose: BurstPurpose) => Promise<void>;
  },
): Promise<CloudBurstAutoResult> {
  const ledger = dependencies.ledger ?? new ResourceLedger();
  if (!isSafeRequestId(input.requestId)) throw new Error('cloud burst requestId must be a safe identifier');
  if (!(['aws2', 'aws3', 'gcp2'] as const).includes(input.host)) throw new Error(`cloud burst host alias is not approved: ${input.host}`);
  mkdirSync(dirname(ledger.path), { recursive: true, mode: 0o700 });
  return serializeRequest(ledger.path, async () => {
    const requestKey = createHash('sha256').update(input.requestId).digest('hex');
    const requestLock = await acquireLockAsync(`${ledger.path}.cloud-burst-request-${requestKey}.lock`, CLOUD_BURST_LOCK_OPTIONS);
    try {
      if (!requestLock.stillHeld()) throw new Error('cloud burst request lock was lost');
      const existing = ledger.list({ kind: 'universe' }, input.now).find(candidate => candidate.id === lifecycleId(input.requestId));
      const lockedHost = existing?.attrs.host ?? input.host;
      if (!(['aws2', 'aws3', 'gcp2'] as const).includes(lockedHost as CloudBurstVmHost)) throw new Error('cloud burst lifecycle has an invalid host');
      const hostLock = await acquireLockAsync(`${ledger.path}.cloud-burst-host-${lockedHost}.lock`, CLOUD_BURST_LOCK_OPTIONS);
      try {
        if (!requestLock.stillHeld() || !hostLock.stillHeld()) throw new Error('cloud burst ownership lock was lost');
        return await reconcileCloudBurstAutoLocked(input, dependencies, ledger, () => {
          if (!requestLock.stillHeld() || !hostLock.stillHeld()) throw new Error('cloud burst ownership lock was lost');
        });
      } finally { hostLock.release(); }
    } finally { requestLock.release(); }
  });
}

async function reconcileCloudBurstAutoLocked(
  input: CloudBurstAutoInput,
  dependencies: {
    readonly ledger?: ResourceLedger;
    readonly cloudVm: CloudVmAdapter;
    readonly join: (host: CloudBurstVmHost, purpose: BurstPurpose) => Promise<void>;
    readonly isWarm: (host: CloudBurstVmHost) => Promise<boolean>;
    readonly activeLeases: (host: CloudBurstVmHost) => Promise<number>;
    readonly admit: (host: CloudBurstVmHost, purpose: BurstPurpose) => Promise<void>;
    readonly withdraw: (host: CloudBurstVmHost, purpose: BurstPurpose) => Promise<void>;
  },
  ledger: ResourceLedger,
  assertOwnership: () => void,
): Promise<CloudBurstAutoResult> {
  if (!isSafeRequestId(input.requestId)) throw new Error('cloud burst requestId must be a safe identifier');
  if (!Number.isFinite(input.now) || input.now <= 0) throw new Error('cloud burst now must be a positive epoch');
  if (!(['aws2', 'aws3', 'gcp2'] as const).includes(input.host)) throw new Error(`cloud burst host alias is not approved: ${input.host}`);
  if (!Number.isInteger(input.queueDepth) || input.queueDepth < 0 || !Number.isInteger(input.blockedCount) || input.blockedCount < 0)
    throw new Error('cloud burst queue depth and blocked count must be nonnegative integers');
  if (!Number.isInteger(input.threshold) || input.threshold < 1) throw new Error('cloud burst threshold must be positive');
  const row = ledger.list({ kind: 'universe' }, input.now).find(candidate => candidate.id === lifecycleId(input.requestId));
  if (row && row.owner !== input.owner) throw new Error('cloud burst request id is owned by another seat');
  if (row?.attrs.host !== undefined && row.attrs.host !== input.host) throw new Error(`cloud burst host changed for request ${input.requestId}`);
  const hostOwner = ledger.list({ kind: 'universe' }, input.now).find(candidate => {
    if (candidate.attrs.type !== 'cloud-burst-lifecycle' || candidate.id === lifecycleId(input.requestId)) return false;
    return candidate.attrs.host === input.host
      && ['warming', 'waiting-for-admission', 'admitted', 'draining'].includes(String(candidate.attrs.state));
  });
  if (!row && hostOwner) return { state: 'warming', reason: `cloud host is owned by request ${String(hostOwner.attrs.requestId)}` };
  let attrs: Record<string, unknown> = { ...(row?.attrs ?? {}) };
  const persist = (next: Record<string, unknown>) => { assertOwnership(); attrs = { ...attrs, ...next }; saveLifecycle(ledger, input.requestId, input.owner, input.now, attrs); };
  if (attrs.state === 'stopped') return { state: 'stopped' };
  const active = attrs.state === 'warming' || attrs.state === 'waiting-for-admission' || attrs.state === 'admitted' || attrs.state === 'draining';
  const demand = input.blockedCount > 0 && input.queueDepth >= input.threshold;
  const expired = row && Number(attrs.stopAfterAt) > 0 && input.now >= Number(attrs.stopAfterAt);
  if (!demand || expired) {
    if (!active) return { state: 'below-threshold' };
    const host = String(attrs.host ?? input.host) as CloudBurstVmHost;
    const purpose = String(attrs.purpose ?? input.purpose) as BurstPurpose;
    assertOwnership(); await dependencies.withdraw(host, purpose);
    const leases = await dependencies.activeLeases(host);
    if (leases > 0) {
      persist({ state: 'draining', queueDepth: input.queueDepth });
      return { state: 'draining', reason: `${leases} active lease(s)` };
    }
    assertOwnership(); await dependencies.cloudVm.stop(host);
    const inventoryId = `burst-${input.requestId}`;
    const inventory = ledger.list({ kind: 'fleet-resource' }, input.now).find(candidate => candidate.id === `fleet:${inventoryId}`);
    if (inventory?.attrs.inventory === true) archiveInventoryResource(inventoryId, input.owner, ledger, input.now);
    const decisionId = `fleet-burst-decision:${budgetLedgerRequestId(input.requestId)}`;
    const decision = ledger.list({ kind: 'universe' }, input.now).find(candidate => candidate.id === decisionId);
    if (decision) ledger.register({ ...decision, attrs: { ...decision.attrs, status: 'stopped', reservedKrw: 0 }, observedAt: input.now }, input.owner);
    persist({ state: 'stopped', stoppedAt: input.now, queueDepth: 0 });
    return { state: 'stopped' };
  }
  if (!demand && !row) return { state: 'below-threshold' };
  if (attrs.state === 'budget-blocked') return { state: 'budget-blocked', reason: 'monthly cloud budget denied this request' };
  if (!row) {
    const provider = providerFor(input.host);
    const purposePressure = { gate: { queued: 0, blocked: 0 }, implementation: { queued: 0, blocked: 0 }, execution: { queued: 0, blocked: 0 } };
    purposePressure[input.purpose] = { queued: input.queueDepth, blocked: input.blockedCount };
    const result = prepareBudgetedBurstReadyLadders({
      requestId: budgetLedgerRequestId(input.requestId), owner: input.owner, now: input.now, imageDigest: input.imageDigest,
      pressures: purposePressure, hourlyCostKrw: { gate: input.hourlyCostKrw, implementation: input.hourlyCostKrw, execution: input.hourlyCostKrw },
      ttlHours: input.ttlHours, maxMachinesPerPurpose: 1,
    }, { ledger, prepare: plan => plan });
    if (result.decision.status !== 'planned' || result.ladderPlans.length === 0) {
      persist({ state: 'budget-blocked', host: input.host, purpose: input.purpose, queueDepth: input.queueDepth });
      return { state: 'budget-blocked', reason: result.decision.reason ?? 'monthly cloud budget denied the burst' };
    }
    const plan = result.ladderPlans[0]!;
    // Reserve inventory before starting so a provider start can never become unaccounted spend.
    assertOwnership();
    registerInventoryResource({ id: `burst-${input.requestId}`, machine: input.host, name: `cloud-burst-${input.requestId}`,
      provider, ownerSeat: input.owner, role: input.purpose === 'execution' ? 'map-reduce' : input.purpose,
      purpose: `Pod federation ${input.purpose} burst ${input.requestId}`,
      hourlyCost: input.hourlyCostKrw, startSignedAt: input.now, expiresAt: plan.stopAfterAt,
      state: { requestId: input.requestId, status: 'reserved' } }, ledger, input.now);
    // Save the admission window and TTL before start: a timed-out command may have
    // reached the provider, so a retry must recover this exact reservation.
    persist({ state: 'warming', host: input.host, purpose: input.purpose,
      queueDepth: input.queueDepth, admissionAt: plan.admissionAt, stopAfterAt: plan.stopAfterAt, imageDigest: input.imageDigest });
    try { assertOwnership(); await dependencies.cloudVm.start(input.host); }
    catch (error) {
      // The command may have timed out after the provider accepted the start. Keep the reservation
      // and inventory active until a later status reconciliation proves the VM is stopped.
      persist({ state: 'warming', host: input.host, purpose: input.purpose,
        queueDepth: input.queueDepth, admissionAt: plan.admissionAt, stopAfterAt: plan.stopAfterAt, imageDigest: input.imageDigest,
        reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    assertOwnership(); const status = await dependencies.cloudVm.status(input.host);
    const state = status.state === 'running' ? 'waiting-for-admission' : 'warming';
    persist({ state, host: input.host, purpose: input.purpose,
      queueDepth: input.queueDepth, admissionAt: plan.admissionAt, stopAfterAt: plan.stopAfterAt, imageDigest: input.imageDigest });
    return { state: 'warming', admissionAt: plan.admissionAt };
  }
  const host = String(attrs.host ?? input.host) as CloudBurstVmHost;
  if (host !== input.host) throw new Error(`cloud burst host changed for request ${input.requestId}`);
  const purpose = String(attrs.purpose ?? input.purpose) as BurstPurpose;
  const leases = attrs.state === 'draining' ? await dependencies.activeLeases(host) : 0;
  if (attrs.state === 'draining' && leases > 0) {
    // Keep the worker withdrawn while old leases finish; a renewed queue cannot
    // reopen admission on a host that is still draining.
    return { state: 'draining', reason: `${leases} active lease(s)` };
  }
  if (attrs.state === 'draining' && !demand) {
    assertOwnership(); await dependencies.cloudVm.stop(host);
    const inventoryId = `burst-${input.requestId}`;
    const inventory = ledger.list({ kind: 'fleet-resource' }, input.now).find(candidate => candidate.id === `fleet:${inventoryId}`);
    if (inventory?.attrs.inventory === true) archiveInventoryResource(inventoryId, input.owner, ledger, input.now);
    const decisionId = `fleet-burst-decision:${budgetLedgerRequestId(input.requestId)}`;
    const decision = ledger.list({ kind: 'universe' }, input.now).find(candidate => candidate.id === decisionId);
    if (decision) ledger.register({ ...decision, attrs: { ...decision.attrs, status: 'stopped', reservedKrw: 0 }, observedAt: input.now }, input.owner);
    persist({ state: 'stopped', stoppedAt: input.now, queueDepth: 0 });
    return { state: 'stopped' };
  }
  assertOwnership(); const status = await dependencies.cloudVm.status(host);
  if (status.state !== 'running') {
    if (attrs.state === 'admitted') { assertOwnership(); await dependencies.withdraw(host, purpose); }
    const restarted: Record<string, unknown> = { ...attrs, state: 'warming', queueDepth: input.queueDepth };
    delete restarted.joinedAt;
    delete restarted.admittedAt;
    attrs = restarted;
    persist(restarted);
    if (status.state === 'stopped') { assertOwnership(); await dependencies.cloudVm.start(host); }
    return { state: 'warming', admissionAt: Number(attrs.admissionAt) };
  }
  if (attrs.joinedAt === undefined) {
    assertOwnership(); await dependencies.join(input.host, purpose);
    persist({ state: 'warming', joinedAt: input.now, queueDepth: input.queueDepth });
  }
  if (!(await dependencies.isWarm(input.host))) {
    if (attrs.state === 'admitted') {
      assertOwnership(); await dependencies.withdraw(host, purpose);
      delete attrs.joinedAt;
      delete attrs.admittedAt;
    }
    persist({ state: 'warming', queueDepth: input.queueDepth });
    return { state: 'warming', admissionAt: Number(attrs.admissionAt) };
  }
  const admissionAt = Number(attrs.admissionAt);
  if (input.now < admissionAt) {
    persist({ state: 'waiting-for-admission', queueDepth: input.queueDepth });
    return { state: 'waiting-for-admission', admissionAt };
  }
  // `admit` must be an idempotent reconciliation: after process restart the ledger can say admitted
  // while the new in-memory pool still has the reserved zero-capacity candidate.
  assertOwnership(); await dependencies.admit(host, purpose);
  persist({ state: 'admitted', admittedAt: attrs.admittedAt ?? input.now, queueDepth: input.queueDepth });
  return { state: 'admitted', admissionAt };
}
