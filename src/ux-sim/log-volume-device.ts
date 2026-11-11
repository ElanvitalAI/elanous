import { correlateGateLog, createGateCorrelationContext, currentGateCorrelationContext, withGateCorrelationContext } from '../mss/logging/gate-correlation.js';
import { withRunnerGateObservation } from '../graph-runner/runner.js';

export interface LogVolumeObservation {
  runId: string;
  invocation: string;
  batch: string;
  phase: string;
}

/** Exercise the production correlation seam while many simulated gate runs interleave. */
export async function runLogVolumeWorld(runIds: readonly string[]): Promise<LogVolumeObservation[]> {
  const observations: LogVolumeObservation[] = [];
  await Promise.all(runIds.map(async (runId) => withRunnerGateObservation({
    runId, invocation: `invocation-${runId}`, batch: `batch-${runId}`,
  }, async () => {
    correlateGateLog('release.gate', 'phase-prepare', {});
    await Promise.resolve();
    const first = correlateGateLog('release.gate', 'phase-heartbeat', {}) as LogVolumeObservation;
    await Promise.resolve();
    const second = correlateGateLog('release.gate', 'heartbeat-interrupted', {}) as LogVolumeObservation;
    observations.push(first, second);
  })));
  return observations;
}

/** Verify that reusing an identity template never shares a mutable phase between tasks. */
export async function runSharedGateTemplateWorld(): Promise<[string, string]> {
  const template = createGateCorrelationContext({ runId: 'template', phase: 'startup' });
  const first = withGateCorrelationContext(template, async () => {
    correlateGateLog('release.gate', 'phase-first', {});
    await Promise.resolve();
    return currentGateCorrelationContext()?.phase ?? 'missing';
  });
  const second = withGateCorrelationContext(template, async () => {
    correlateGateLog('release.gate', 'phase-second', {});
    await Promise.resolve();
    return currentGateCorrelationContext()?.phase ?? 'missing';
  });
  return Promise.all([first, second]) as Promise<[string, string]>;
}
