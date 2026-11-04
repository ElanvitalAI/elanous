export interface CloudBurstVmSnapshot {
  readonly id: string;
  readonly imageDigest: string;
  readonly state: 'warming' | 'ready' | 'draining' | 'parked';
  readonly readyAt: number;
  readonly poweredOnMs: number;
  readonly estimatedCost: number;
  readonly terminationProtected: boolean;
  readonly stopAfterAt?: number;
}

export interface CloudBurstRequest {
  readonly requestId: string;
  /** Opaque, user-owned credential/profile reference; never a credential value. */
  readonly accountRef?: string;
  readonly imageDigest: string;
  readonly ttlMs: number;
}

export interface CloudBurstLocalPort {
  tryAcquire(input: { requestId: string; ttlMs: number }): Promise<{ resourceId: string; expiresAt: number } | undefined>;
}

export interface CloudBurstRunUsage {
  readonly state: 'warming' | 'ready' | 'draining' | 'parked';
  /** Usage for exactly one burst receipt, excluding any earlier/later use of the VM. */
  readonly poweredOnMs: number;
  readonly estimatedCost: number;
}

export interface CloudBurstCloudPort {
  quote(accountRef: string, imageDigest: string): Promise<{ hourlyCost: number; readyAfterMs: number }>;
  list(accountRef: string): Promise<readonly CloudBurstVmSnapshot[]>;
  resume(accountRef: string, id: string, options: { hourlyCost: number; readyAfterMs: number; stopAfterAt: number }): Promise<CloudBurstVmSnapshot>;
  createFromImage(accountRef: string, input: {
    id: string;
    imageDigest: string;
    hourlyCost: number;
    readyAfterMs: number;
    stopAfterAt: number;
    terminationProtected: true;
  }): Promise<CloudBurstVmSnapshot>;
  status(accountRef: string, id: string): Promise<CloudBurstVmSnapshot>;
  stop(accountRef: string, id: string): Promise<CloudBurstVmSnapshot>;
  reportRun(receipt: CloudBurstReceipt): Promise<CloudBurstRunUsage>;
}

export interface CloudBurstReceipt {
  readonly requestId: string;
  readonly accountRef: string;
  readonly vmId: string;
  readonly source: 'warm' | 'cold';
  readonly baselinePoweredOnMs: number;
  readonly hourlyCost: number;
  readonly startedAt: number;
  readonly stopAfterAt: number;
}

export type CloudBurstResult =
  | { readonly source: 'local'; readonly resourceId: string; readonly expiresAt: number; readonly estimatedCost: 0 }
  | { readonly source: 'warm' | 'cold'; readonly vm: CloudBurstVmSnapshot; readonly receipt: CloudBurstReceipt; readonly startReport: string };

function validateRequest(request: CloudBurstRequest): void {
  if (!request.requestId.trim()) throw new Error('cloud-burst: requestId is required');
  if (!/^sha256:[a-f0-9]{64}$/.test(request.imageDigest)) throw new Error('cloud-burst: pinned sha256 imageDigest is required');
  if (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0) throw new Error('cloud-burst: ttlMs must be positive');
}

export function renderCloudBurstStartReport(receipt: CloudBurstReceipt, vm: CloudBurstVmSnapshot): string {
  return `Cloud Burst run ${receipt.requestId} (${vm.id}): state=${vm.state}; quotedHourlyCost=${receipt.hourlyCost} provider-cost-units/hour; stopAfterAt=${receipt.stopAfterAt}; finalCost=available-after-run-via-receipt`;
}

/** Local capacity is attempted first. Cloud expansion reuses only a protected, parked VM with the requested image pin. */
export async function requestCloudBurstBasic(
  request: CloudBurstRequest,
  ports: { local: CloudBurstLocalPort; cloud: CloudBurstCloudPort },
): Promise<CloudBurstResult> {
  validateRequest(request);

  const local = await ports.local.tryAcquire({ requestId: request.requestId, ttlMs: request.ttlMs });
  if (local) {
    if (!Number.isFinite(local.expiresAt)) throw new Error('cloud-burst: local adapter returned an invalid expiry');
    return { source: 'local', resourceId: local.resourceId, expiresAt: local.expiresAt, estimatedCost: 0 };
  }

  const accountRef = request.accountRef?.trim();
  if (!accountRef) throw new Error('cloud-burst: connect a user-owned cloud account reference before cloud expansion');

  const quote = await ports.cloud.quote(accountRef, request.imageDigest);
  if (!Number.isFinite(quote.hourlyCost) || quote.hourlyCost < 0) throw new Error('cloud-burst: provider quote hourlyCost must be nonnegative');
  if (!Number.isFinite(quote.readyAfterMs) || quote.readyAfterMs < 0) throw new Error('cloud-burst: provider quote readyAfterMs must be nonnegative');
  if (request.ttlMs <= quote.readyAfterMs) throw new Error('cloud-burst: ttlMs must exceed provider readiness estimate');

  const hosts = await ports.cloud.list(accountRef);
  const warm = hosts
    .filter(vm => vm.state === 'parked' && vm.terminationProtected && vm.imageDigest === request.imageDigest)
    .sort((left, right) => left.id.localeCompare(right.id))[0];

  // Start the requested TTL only after local lookup, provider quote, and cloud inventory complete.
  const startedAt = Date.now();
  const stopAfterAt = startedAt + request.ttlMs;
  if (!Number.isFinite(stopAfterAt) || stopAfterAt <= startedAt + quote.readyAfterMs) {
    throw new Error('cloud-burst: remaining TTL is insufficient for provider readiness');
  }

  const vm = warm
    ? await ports.cloud.resume(accountRef, warm.id, { hourlyCost: quote.hourlyCost, readyAfterMs: quote.readyAfterMs, stopAfterAt })
    : await ports.cloud.createFromImage(accountRef, {
        id: request.requestId,
        imageDigest: request.imageDigest,
        hourlyCost: quote.hourlyCost,
        readyAfterMs: quote.readyAfterMs,
        stopAfterAt,
        terminationProtected: true,
      });
  if (!vm.terminationProtected) {
    try {
      await ports.cloud.stop(accountRef, vm.id);
    }
    catch {
      throw new Error(`cloud-burst: provider did not confirm termination protection and stop failed for ${vm.id}`);
    }
    throw new Error(`cloud-burst: provider did not confirm termination protection; stopped ${vm.id}`);
  }

  const receipt: CloudBurstReceipt = {
    requestId: request.requestId,
    accountRef,
    vmId: vm.id,
    source: warm ? 'warm' : 'cold',
    baselinePoweredOnMs: warm?.poweredOnMs ?? 0,
    hourlyCost: quote.hourlyCost,
    startedAt,
    stopAfterAt,
  };
  return { source: receipt.source, vm, receipt, startReport: renderCloudBurstStartReport(receipt, vm) };
}

/** Refreshes provider state through the same runtime used by the installed command. */
export async function getCloudBurstCostReport(receipt: CloudBurstReceipt, cloud: CloudBurstCloudPort): Promise<string> {
  const usage = await cloud.reportRun(receipt);
  if (!Number.isFinite(usage.poweredOnMs) || usage.poweredOnMs < 0
    || !Number.isFinite(usage.estimatedCost) || usage.estimatedCost < 0) {
    throw new Error('cloud-burst: provider did not return a valid run-scoped usage report');
  }
  return `Cloud Burst ${receipt.requestId} (${receipt.vmId}): state=${usage.state}; runPoweredOnMs=${usage.poweredOnMs}; estimatedCost=${usage.estimatedCost} provider-cost-units; stopAfterAt=${receipt.stopAfterAt}`;
}
