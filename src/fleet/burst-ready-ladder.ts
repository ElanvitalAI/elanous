const HOUR_MS = 60 * 60 * 1000;

export const BURST_READY_PURPOSES = ['gate', 'implementation', 'execution'] as const;
export type BurstReadyPurpose = typeof BURST_READY_PURPOSES[number];
export type BurstReadyTtlHours = 2 | 4;

export interface BurstReadyLadderRequest {
  readonly requestId: string;
  readonly purpose: BurstReadyPurpose;
  readonly imageDigest: string;
  /** Requested work admission time, in Unix milliseconds. */
  readonly admissionAt: number;
  readonly ttlHours: BurstReadyTtlHours;
}

export interface BurstReadyLadderPlan extends BurstReadyLadderRequest {
  readonly prepareAt: number;
  readonly ttlMs: number;
  readonly stopAfterAt: number;
}

/** Refuse admission until the scheduled start and at/after TTL expiry. */
export function assertBurstAdmissionWindow(plan: BurstReadyLadderPlan, now: number): void {
  if (!Number.isFinite(now)) throw new Error('burst-ready-ladder: now must be a finite epoch');
  if (now < plan.admissionAt) {
    throw new Error(`burst-ready-ladder: admission refused before scheduled time ${plan.admissionAt}`);
  }
  if (now >= plan.stopAfterAt) {
    throw new Error(`burst-ready-ladder: admission refused at or after TTL expiry ${plan.stopAfterAt}`);
  }
}

/** Put the time-window check directly around the lease-opening operation. */
export function openBurstReadyLease<T>(plan: BurstReadyLadderPlan, now: number, openLease: () => T): T {
  assertBurstAdmissionWindow(plan, now);
  return openLease();
}

/** Plan the warm-up boundary and a TTL that starts at admission, not at preparation. */
export function planBurstReadyLadder(request: BurstReadyLadderRequest): BurstReadyLadderPlan {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(request.requestId)) {
    throw new Error('burst-ready-ladder: requestId must be 1-64 safe identifier characters');
  }
  if (!(BURST_READY_PURPOSES as readonly string[]).includes(request.purpose)) {
    throw new Error('burst-ready-ladder: purpose must be gate, implementation, or execution');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(request.imageDigest)) {
    throw new Error('burst-ready-ladder: pinned sha256 imageDigest is required');
  }
  if (!Number.isFinite(request.admissionAt) || request.admissionAt <= HOUR_MS) {
    throw new Error('burst-ready-ladder: admissionAt must be a positive Unix-millisecond epoch');
  }
  if (request.ttlHours !== 2 && request.ttlHours !== 4) {
    throw new Error('burst-ready-ladder: ttlHours must be 2 or 4');
  }

  const ttlMs = request.ttlHours * HOUR_MS;
  const prepareAt = request.admissionAt - HOUR_MS;
  const stopAfterAt = request.admissionAt + ttlMs;
  if (!Number.isFinite(stopAfterAt) || stopAfterAt <= request.admissionAt) {
    throw new Error('burst-ready-ladder: stopAfterAt is outside the supported epoch range');
  }
  return { ...request, prepareAt, ttlMs, stopAfterAt };
}
