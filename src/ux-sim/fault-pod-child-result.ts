import { classifyPodTerminal } from '../self-dev/draft-residue.js';
import { podChildEvidenceLedgerRow, type PodTermination } from '../task-orchestrator/surfaces/pod-failure-reason.js';

export interface PodChildResultScenario {
  firstAttempt: Record<string, unknown>;
  harvestAttempt: Record<string, unknown>;
}

/** Replays a successful Kubernetes Job carrying a failed/partial child result. */
export function podChildResultScenario(): PodChildResultScenario {
  const podTermination: PodTermination = {
    job: 'si-task-report-deficit', path: 'result-marker', observedAt: '2026-10-28T09:35:13Z',
    jobLookup: 'ok', jobUid: 'job-uid-1', jobConditionReason: 'CompletionsReached',
    activeDeadlineSeconds: 14400, deadlineExceeded: false, podLookup: 'terminated',
    containerReason: 'Completed', exitCode: 0, finishedAt: '2026-10-28T09:35:13Z', oomKilled: false,
  };
  const firstAttempt = podChildEvidenceLedgerRow({
    job: podTermination.job, childRunId: 'run-first-report-deficit', state: 'complete',
    result: {
      stage: 'aborted', ok: false, failureClassification: 'report-deficit',
      completionDisposition: 'partial', childEvidence: { error: 'report-deficit: missing child result summary' },
    },
    noResultDiagnostic: null, noResultLogEvidence: null, podTermination,
  });
  const harvestAttempt = classifyPodTerminal({
    childRunId: 'run-second-harvest', state: 'complete', env: { ELANOUS_HARNESS_SEAT: 'UX' },
    disposition: { stage: 'pr-opened', ok: true, prNumber: 32614,
      prUrl: 'https://github.com/ElanvitalAI/elanous/pull/32614', branch: 'self-impl/coord-entrance-fold' },
    at: '2026-10-28T09:35:29Z',
  });
  return { firstAttempt: firstAttempt ?? {}, harvestAttempt };
}

export function renderPodChildResult(scenario: PodChildResultScenario): string[] {
  const first = scenario.firstAttempt as { childResult?: Record<string, unknown>; podTermination?: PodTermination };
  return [
    `pod-child-result · child completion=${String(first.childResult?.completionDisposition ?? 'unknown')}`,
    `  first: child=${String(first.childResult?.ok)} · stage=${String(first.childResult?.stage)} · failure=${String(first.childResult?.failureClassification)}`,
    `  pod: ${String(first.podTermination?.containerReason)} · exit=${String(first.podTermination?.exitCode)} · childRunId=${String(scenario.firstAttempt.childRunId)}`,
    `  harvest: PR #${String(scenario.harvestAttempt.prNumber)} · ${String(scenario.harvestAttempt.terminalClass)}`,
  ];
}
