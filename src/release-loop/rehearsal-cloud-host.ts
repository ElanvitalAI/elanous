/** Safety policy for the dedicated release rehearsal VM. Provider operations are injected at the edge. */
export const REHEARSAL_CLOUD_HOST = 'aws1' as const;
export const REHEARSAL_CLOUD_HOST_MAX_REPAIR_MS = 90 * 60_000;
export const REHEARSAL_CLOUD_HOST_CUTOFF_ESCALATION_MS = 30 * 60_000;

export interface RehearsalCloudHostIdentity {
  host: string;
  state: 'warming' | 'ready' | 'stopped' | 'failed';
  imageDigest: string;
  commit: string;
  lockHash: string;
}

export interface RehearsalCloudHostPort {
  /** Start or resume only the named rehearsal VM. This must not join train or Pod pools. */
  start(host: typeof REHEARSAL_CLOUD_HOST): Promise<void>;
  inspect(host: typeof REHEARSAL_CLOUD_HOST): Promise<RehearsalCloudHostIdentity>;
  openLease(host: typeof REHEARSAL_CLOUD_HOST): Promise<void>;
  closeLease(host: typeof REHEARSAL_CLOUD_HOST): Promise<void>;
  /** Stop only; termination is not part of this port. */
  stop(host: typeof REHEARSAL_CLOUD_HOST): Promise<void>;
}

export interface RehearsalCloudHostRequest {
  expected: { imageDigest: string; commit: string; lockHash: string };
  cutAt: string;
  startedAt: number;
  lastRehearsalAt?: number;
  finalStep: boolean;
  repair: 'none' | 'pending' | 'resolved' | 'handed-off';
  now: number;
}

export type RehearsalRepairState = RehearsalCloudHostRequest['repair'];
export interface RehearsalRepairHandoffObserver {
  currentRepair(): RehearsalRepairState;
  markHandoffRequired(): void;
  recordAlertFailure(warning: string): void;
}

export type RehearsalCloudHostResult<T> =
  | { outcome: 'postponed'; reason: string; alertWarning?: string }
  | { outcome: 'unmeasured'; reason: string }
  | { outcome: 'measured'; host: typeof REHEARSAL_CLOUD_HOST; value: T; measurementOutcome: 'ok' | 'regression' | 'unmeasured' | 'error'; receiptPersisted: boolean; stopped: boolean; repairHandoffRequired?: boolean; cleanupWarning?: string; clockWarning?: string; stopWarning?: string; alertWarnings?: string[] }
  | { outcome: 'failed'; reason: string };

type HostMeasurement<T> = { value: T; outcome: 'ok' | 'regression' | 'unmeasured' | 'error'; receiptPersisted: boolean };

/**
 * Runs one rehearsal on aws1 after its environment is ready and identity-bound.
 * A regression keeps the VM available for attribution/repair. Stop errors only alert;
 * they never rewrite a completed measurement. No alternate host is ever selected.
 */
export async function runRehearsalCloudHostStep<T>(
  request: RehearsalCloudHostRequest,
  port: RehearsalCloudHostPort,
  run: (host: typeof REHEARSAL_CLOUD_HOST) => Promise<HostMeasurement<T>>,
  alert: (message: string) => void | Promise<void>,
  now: () => number,
  handoffObserver: RehearsalRepairHandoffObserver,
): Promise<RehearsalCloudHostResult<T>> {
  if (!Number.isFinite(Date.parse(request.cutAt)) || !Number.isFinite(request.now)
      || !Number.isFinite(request.startedAt) || request.now < request.startedAt)
    return { outcome: 'unmeasured', reason: 'invalid rehearsal host schedule or clock' };
  let repairHandoffAlerted = false;
  let handoffAlertTask: Promise<void> | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  const notifyHandoff = async (): Promise<void> => {
    if (handoffObserver.currentRepair() !== 'pending') return;
    repairHandoffAlerted = true;
    try { handoffObserver.markHandoffRequired(); }
    catch (error) { handoffObserver.recordAlertFailure(`failed to persist repair handoff: ${error instanceof Error ? error.message : String(error)}`); }
    const warning = await safeAlert(alert, 'aws1 repair window reached 90 minutes; hand off the repair and persist its receipt before stopping');
    if (warning) handoffObserver.recordAlertFailure(warning);
  };
  if (request.repair === 'pending' && request.lastRehearsalAt !== undefined) {
    let scheduledAt: number;
    try { scheduledAt = now(); }
    catch (error) { return { outcome: 'unmeasured', reason: `repair deadline clock unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!Number.isFinite(scheduledAt)) return { outcome: 'unmeasured', reason: 'repair deadline clock returned an invalid time' };
    const delay = request.lastRehearsalAt + REHEARSAL_CLOUD_HOST_MAX_REPAIR_MS - scheduledAt;
    // Schedule before cloud start/readiness work so those operations cannot push the alert past its deadline.
    handoffTimer = setTimeout(() => { handoffAlertTask = notifyHandoff(); }, Math.max(0, delay));
  }
  try {
    try { await port.start(REHEARSAL_CLOUD_HOST); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const alertWarning = await safeAlert(alert, `aws1 start failed; rehearsal postponed without failover: ${reason}`);
      return { outcome: 'postponed', reason: `aws1 start failed; no failover: ${reason}`, ...(alertWarning ? { alertWarning } : {}) };
    }
    let identity: RehearsalCloudHostIdentity;
    try { identity = await port.inspect(REHEARSAL_CLOUD_HOST); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const alertWarning = await safeAlert(alert, `aws1 readiness probe failed; rehearsal postponed without failover: ${reason}`);
      return { outcome: 'postponed', reason: `aws1 readiness unknown; no failover: ${reason}`, ...(alertWarning ? { alertWarning } : {}) };
    }
    if (identity.state === 'warming') return { outcome: 'postponed', reason: 'aws1 is still warming; no failover' };
    if (identity.state !== 'ready') return { outcome: 'postponed', reason: `aws1 is not ready (${identity.state}); no failover` };
    if (identity.host !== REHEARSAL_CLOUD_HOST) return { outcome: 'unmeasured', reason: 'observed execution host is not aws1' };
    if (identity.imageDigest !== request.expected.imageDigest || identity.commit !== request.expected.commit
        || identity.lockHash !== request.expected.lockHash)
      return { outcome: 'unmeasured', reason: 'aws1 image, commit or dependency lock does not match the scheduled rehearsal' };

    await port.openLease(REHEARSAL_CLOUD_HOST);
    let measured: Awaited<ReturnType<typeof run>>;
    try { measured = await run(REHEARSAL_CLOUD_HOST); }
    catch (error) {
      try { await port.closeLease(REHEARSAL_CLOUD_HOST); } catch { /* Preserve the original run failure. */ }
      throw error;
    }
    const alertWarnings: string[] = [];
    const reportAlertFailure = async (message: string): Promise<void> => {
      const warning = await safeAlert(alert, message);
      if (warning) alertWarnings.push(warning);
    };
    let evaluatedAt: number | undefined, clockWarning: string | undefined;
    try {
      const value = now();
      if (!Number.isFinite(value) || value < request.startedAt) throw new Error('clock returned an invalid completion time');
      evaluatedAt = value;
    } catch (error) {
      clockWarning = error instanceof Error ? error.message : String(error);
      if (!clockWarning.trim()) clockWarning = 'completion clock failed without diagnostic';
    }
    const withinCutoff = evaluatedAt !== undefined
      && Date.parse(request.cutAt) - evaluatedAt <= REHEARSAL_CLOUD_HOST_CUTOFF_ESCALATION_MS;
    const repairWindowExpired = request.lastRehearsalAt !== undefined && evaluatedAt !== undefined
      && evaluatedAt - request.lastRehearsalAt >= REHEARSAL_CLOUD_HOST_MAX_REPAIR_MS;
    const repairHandoffRequired = repairWindowExpired && request.repair === 'pending';
    const imminentRegression = measured.outcome === 'regression' && withinCutoff;
    const unresolvedRepairAtCutoff = (request.repair === 'pending' || request.repair === 'handed-off') && withinCutoff;
    if (clockWarning && (measured.outcome === 'regression' || request.repair !== 'none'))
      await reportAlertFailure(`completion clock unavailable; preserve aws1 and escalate to OP: ${clockWarning}`);
    if (imminentRegression)
      await reportAlertFailure('rehearsal regression remains within 30 minutes of cut; preserve aws1 and escalate to OP');
    else if (unresolvedRepairAtCutoff)
      await reportAlertFailure(`rehearsal repair remains within 30 minutes of cut (${measured.outcome}); preserve aws1 and escalate to OP`);
    if (repairHandoffRequired && !repairHandoffAlerted) {
      if (handoffTimer) clearTimeout(handoffTimer);
      handoffAlertTask = notifyHandoff();
    }
    if (handoffAlertTask) await handoffAlertTask;
    let cleanupWarning: string | undefined, cleanupFailed = false;
    try { await port.closeLease(REHEARSAL_CLOUD_HOST); }
    catch (error) {
      cleanupFailed = true;
      cleanupWarning = error instanceof Error ? error.message : String(error);
      if (!cleanupWarning.trim()) cleanupWarning = 'lease cleanup failed without diagnostic';
    }
    const preserveMeasurement = (stopped: boolean, extra: { stopWarning?: string; repairHandoffRequired?: boolean } = {}): RehearsalCloudHostResult<T> => ({
      outcome: 'measured', host: REHEARSAL_CLOUD_HOST, value: measured.value, measurementOutcome: measured.outcome,
      receiptPersisted: measured.receiptPersisted, stopped, ...(cleanupFailed ? { cleanupWarning } : {}),
      ...(clockWarning ? { clockWarning } : {}), ...(alertWarnings.length ? { alertWarnings: [...alertWarnings] } : {}), ...extra,
    });
    if (cleanupFailed) {
      await reportAlertFailure(`aws1 lease cleanup failed; measurement retained: ${cleanupWarning}`);
      return preserveMeasurement(false, repairHandoffRequired ? { repairHandoffRequired: true } : {});
    }

    if (repairHandoffRequired) return preserveMeasurement(false, { repairHandoffRequired: true });
    if (measured.outcome !== 'ok') return preserveMeasurement(false);
    if (clockWarning || evaluatedAt === undefined) return preserveMeasurement(false);
    const cutoffEscalation = Date.parse(request.cutAt) - evaluatedAt <= REHEARSAL_CLOUD_HOST_CUTOFF_ESCALATION_MS;
    const mayStopForBound = repairWindowExpired && measured.receiptPersisted && request.repair === 'handed-off';
    const mayStopAfterFinal = request.finalStep && measured.receiptPersisted && request.repair === 'none';
    if (cutoffEscalation && request.repair !== 'none') return preserveMeasurement(false);
    if (!mayStopForBound && !mayStopAfterFinal)
      return preserveMeasurement(false);
    try {
      await port.stop(REHEARSAL_CLOUD_HOST);
      return preserveMeasurement(true);
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      await reportAlertFailure(`aws1 stop failed; measurement retained: ${warning}`);
      return preserveMeasurement(false, { stopWarning: warning });
    }
  } catch (error) {
    return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function safeAlert(alert: (message: string) => void | Promise<void>, message: string): Promise<string | undefined> {
  try { await alert(message); return undefined; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return detail.trim() ? detail : 'notification failed without diagnostic';
  }
}
