import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { adviseLaunch, compareLaunchAdvice } from '../harness/launch-advice.js';
import type { QueuePool } from '../harness/harness-queue.js';
import type { ReleaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { ReleaseRunClaimConflict, releaseRunLockOwnerAlive, withDirectReleaseRunLock, withForceReleaseRunMarker } from './release-single-flight.js';

export type ReleaseIfReadySkip = { skipped: true; reason: Exclude<ReleaseReadiness, { ready: true }>['reason']; detail: string };

export async function runReleaseIfReady<T>(version: string, deps: {
  readiness: (version: string, options?: { isPidAlive?: (pid: number) => boolean }) => ReleaseReadiness | Promise<ReleaseReadiness>;
  run: () => Promise<T>;
  ledgerRoot?: string;
  pid?: number;
  now?: () => Date;
  advice?: typeof adviseLaunch;
  pool?: () => QueuePool | undefined;
  /** Explicit operator override: keep readiness checks, bypass only the same-version lock. */
  forceNew?: boolean;
}): Promise<ReleaseIfReadySkip | { skipped: false; result: T }> {
  const skip = (readiness: Exclude<ReleaseReadiness, { ready: true }>): ReleaseIfReadySkip => {
    const detail = readiness.reason === 'checklist-blocked'
      ? [...readiness.details.red, ...readiness.details.undecided, ...readiness.details.blocked].join(', ')
      : readiness.details;
    debug.log('release-loop.readiness', readiness.reason, { version, detail });
    return { skipped: true, reason: readiness.reason, detail };
  };
  const ledgerRoot = deps.ledgerRoot ?? releaseLedgerRoot();
  const readiness = await deps.readiness(version, { isPidAlive: deps.forceNew ? () => false
    : (pid) => releaseRunLockOwnerAlive(version, ledgerRoot, pid) });
  if (!readiness.ready) return skip(readiness);

  if (deps.forceNew) return withForceReleaseRunMarker(version, ledgerRoot, async () => {
    const atStart = await deps.readiness(version, { isPidAlive: () => false });
    if (!atStart.ready) return skip(atStart);
    return { skipped: false, result: await deps.run() };
  });

  try {
    return await withDirectReleaseRunLock(version, ledgerRoot, async () => {
      // This call still checks publication and checklist, but must not treat our own lock as another runner.
      const insideLock = await deps.readiness(version, { isPidAlive: () => false });
      if (!insideLock.ready) return skip(insideLock);
      debug.log('release-loop.readiness', 'ready', { version });
      try {
        const advice = (deps.advice ?? adviseLaunch)({ pool: deps.pool?.(), caller: 'release-run' });
        const { kind } = compareLaunchAdvice(advice, 'launched');
        debug.log('resource.advice', 'launch-advice', { caller: 'release-run', verdict: advice.verdict, why: advice.why, actual: 'launched', kind, version });
      } catch {
        // Shadow only: a throwing advice seam must never affect the launch decision or result.
      }
      return { skipped: false, result: await deps.run() };
    }, { pid: deps.pid, now: deps.now });
  } catch (error) {
    if (!(error instanceof ReleaseRunClaimConflict)) throw error;
    const detail = 'run.lock already exists';
    debug.log('release-loop.readiness', 'already-running', { version, detail });
    return { skipped: true, reason: 'already-running', detail };
  }
}
