import { decidePodReuseCleanup } from './pod-reuse-cleanup.js';
import type { WarmWorkerKey } from './pod-warm-worker-protocol.js';

/** An admitted si-v1 worker is identified by the pool, never by a Job name alone. */
export interface ChildPodLease {
  workerId: string;
  podUid: string;
  leaseId: string;
  generation: number;
  key: WarmWorkerKey;
  sourceSha: string;
}

export interface ChildPodReuseCommandResult {
  status: number | null;
  stdout?: string;
}

export interface ChildPodCleanupReceipt {
  clean: boolean;
  reason: string;
  /** Known residual lower bound; null means unmeasured surfaces and no observed residue. */
  observedResidue: number | null;
}

/** Operations execute inside the admitted worker, after its child result and artifacts have been collected. */
export interface ChildPodReuseOperations {
  stopChildProcesses: (lease: ChildPodLease) => Promise<{ remaining: number }>;
  git: (lease: ChildPodLease, args: readonly string[]) => Promise<ChildPodReuseCommandResult>;
  removeRunCredentials: (lease: ChildPodLease) => Promise<{ remaining: number }>;
  returnLease: (lease: ChildPodLease, receipt: ChildPodCleanupReceipt) => Promise<void>;
  quarantine: (lease: ChildPodLease, receipt: ChildPodCleanupReceipt) => Promise<void>;
  observe: (event: 'return-decision' | 'clean-failed' | 'quarantine-failed', data: Record<string, unknown>) => void;
}

export interface ChildPodReturnResult {
  outcome: 'returned' | 'quarantined';
  reason: string;
}

/**
 * A completed child may return to the pool only after all four independent
 * checks succeed. A missing return-decision observation also blocks return;
 * the worker stays out of the lease pool until quarantine succeeds.
 */
export async function cleanAndReturnChildPod(
  lease: ChildPodLease,
  ops: ChildPodReuseOperations,
): Promise<ChildPodReturnResult> {
  const facts = { workerId: lease.workerId, podUid: lease.podUid,
    leaseId: lease.leaseId, generation: lease.generation };
  const log = (event: Parameters<ChildPodReuseOperations['observe']>[0], data: Record<string, unknown>) => {
    try { ops.observe(event, { ...facts, ...data }); } catch { /* logging must not return an unsafe lease */ }
  };
  let reason = '';
  let observedResidue = 0;
  let processMeasured = false;
  let gitMeasured = false;
  let credentialsMeasured = false;
  let credentialsRemoved = false;
  try {
    if (!lease.workerId || !lease.podUid || !lease.leaseId || !lease.key
      || !Number.isSafeInteger(lease.generation) || lease.generation < 1
      || !lease.key.context || !lease.key.architecture
      || !/^sha256:[0-9a-f]{64}$/.test(lease.key.imageDigest)
      || !/^[0-9a-f]{64}$/.test(lease.key.lockHash)
      || !/^[0-9a-f]{40}$/.test(lease.sourceSha)) {
      reason = 'invalid-lease';
    } else {
      const stopped = await ops.stopChildProcesses(lease);
      if (Number.isSafeInteger(stopped.remaining) && stopped.remaining >= 0) {
        observedResidue += stopped.remaining;
        processMeasured = true;
      }
      if (!Number.isSafeInteger(stopped.remaining) || stopped.remaining !== 0) {
        reason = 'child-processes-remain';
      } else {
        const plan = decidePodReuseCleanup({ base: lease.sourceSha, resetExitCode: 0,
          cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' });
        const reset = await ops.git(lease, plan.resetArgs);
        if (reset.status !== 0) reason = 'reset-failed';
        else {
          const clean = await ops.git(lease, plan.cleanArgs);
          if (clean.status !== 0) reason = 'clean-failed';
          else {
            const status = await ops.git(lease, plan.statusArgs);
            if (status.status === 0 && typeof status.stdout === 'string') {
              observedResidue += status.stdout.split('\0').filter(Boolean).length;
              gitMeasured = true;
            }
            const decision = decidePodReuseCleanup({ base: lease.sourceSha,
              resetExitCode: reset.status, cleanExitCode: clean.status,
              statusExitCode: status.status, statusPorcelain: status.stdout ?? '' });
            if (status.status === 0 && typeof status.stdout !== 'string') reason = 'status-unavailable';
            else if (decision.outcome !== 'reuse') reason = decision.reason ?? 'worktree-not-clean';
          }
        }
      }
    }
  } catch (error) {
    reason = `cleanup-error:${error instanceof Error ? error.message : String(error)}`;
  }
  // A failed process or Git check never skips credential revocation.
  try {
    const credentials = await ops.removeRunCredentials(lease);
    credentialsRemoved = credentials.remaining === 0;
    if (Number.isSafeInteger(credentials.remaining) && credentials.remaining >= 0) {
      observedResidue += credentials.remaining;
      credentialsMeasured = true;
    }
    if (!credentialsRemoved && !reason) reason = 'credentials-remain';
  } catch (error) {
    const credentialReason = `credential-revoke-error:${error instanceof Error ? error.message : String(error)}`;
    reason = reason ? `${reason};${credentialReason}` : credentialReason;
  }
  if (!reason && credentialsRemoved) {
    try {
      // Git clean and credential revocation can reveal child processes that appeared after the
      // pre-cleanup survey. A lease returns clean only when the re-survey immediately before
      // returnLease also reports zero remaining processes.
      const resurvey = await ops.stopChildProcesses(lease);
      if (!Number.isSafeInteger(resurvey.remaining) || resurvey.remaining !== 0) {
        reason = 'child-processes-resurfaced';
        if (Number.isSafeInteger(resurvey.remaining) && resurvey.remaining > 0) observedResidue += resurvey.remaining;
      } else {
        // Eligibility is observed only after the final process re-survey succeeds.
        ops.observe('return-decision', { ...facts, outcome: 'eligible' });
        await ops.returnLease(lease, { clean: true, reason: 'clean', observedResidue: 0 });
        log('return-decision', { outcome: 'returned' });
        return { outcome: 'returned', reason: 'clean' };
      }
    } catch (error) {
      reason = `return-or-observation-error:${error instanceof Error ? error.message : String(error)}`;
    }
  }
  log('clean-failed', { reason });
  try { await ops.quarantine(lease, { clean: false, reason,
    observedResidue: observedResidue > 0 || (processMeasured && gitMeasured && credentialsMeasured)
      ? observedResidue : null }); }
  catch (error) {
    log('quarantine-failed', { reason, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  log('return-decision', { outcome: 'quarantined', reason });
  return { outcome: 'quarantined', reason };
}
