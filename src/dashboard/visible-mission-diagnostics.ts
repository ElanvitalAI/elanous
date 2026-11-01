import type { VisibleMissionResult } from '../sidetab-core/visible-agent-mission.js';

/** Keep failure logs to the bounded, redacted diagnostic fields produced by the visible-mission runner. */
export function visibleMissionFailureLogData(
  agent: string,
  result: Pick<VisibleMissionResult, 'ok' | 'failureStage' | 'failureScreen'>,
  interactionId?: string,
): { agent: string; failureStage: string | null; failureScreen: string | null; interactionId?: string } | null {
  if (result.ok) return null;
  return {
    agent,
    failureStage: result.failureStage ?? null,
    failureScreen: result.failureScreen ?? null,
    ...(interactionId ? { interactionId } : {}),
  };
}
