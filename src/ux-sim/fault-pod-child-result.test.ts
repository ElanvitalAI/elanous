import { describe, expect, test } from 'bun:test';
import { classifyPodExit, podChildEvidenceLedgerRow } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import { podChildResultScenario, renderPodChildResult } from './fault-pod-child-result.js';

describe('simPodChildResult — Completed Job with unconverged partial child', () => {
  test('keeps child report-deficit and Completed/0 termination together while a later child is harvestable', () => {
    const scenario = podChildResultScenario();
    expect(scenario.firstAttempt).toMatchObject({
      childRunId: 'run-first-report-deficit',
      childResult: { ok: false, stage: 'aborted', failureClassification: 'report-deficit', completionDisposition: 'partial' },
      podTermination: { containerReason: 'Completed', exitCode: 0, jobConditionReason: 'CompletionsReached' },
      childEvidence: { error: 'report-deficit: missing child result summary' },
    });
    expect(scenario.harvestAttempt).toMatchObject({ prNumber: 32614, stage: 'pr-opened', terminalClass: 'merge-ready-not-merged' });
    expect(renderPodChildResult(scenario).join('\n')).toContain('failure=report-deficit');
    expect(renderPodChildResult(scenario).join('\n')).toContain('Completed · exit=0');
    expect(renderPodChildResult(scenario).join('\n')).toContain('completion=partial');
  });

  test('distinguishes the old text classifier from the exact completed-Pod child evidence', () => {
    const scenario = podChildResultScenario();
    expect(classifyPodExit({ logs: 'Pod exit 1: child-error — previous summary' }).class).toBe('child-error');
    expect(scenario.firstAttempt).toMatchObject({
      childResult: { failureClassification: 'report-deficit' },
      podTermination: { containerReason: 'Completed', exitCode: 0 },
    });
    expect(scenario.firstAttempt.childResult).not.toEqual({});
  });

  test('does not extend failed-Job rows with completed-child result fields', () => {
    const row = podChildEvidenceLedgerRow({
      job: 'si-task-failed', childRunId: 'run-failed', state: 'failed',
      result: { stage: 'aborted', ok: false, failureClassification: 'report-deficit' },
      noResultDiagnostic: null, noResultLogEvidence: null,
    });
    expect(row).toMatchObject({ childRunId: 'run-failed', job: 'si-task-failed', childEvidence: null });
    expect(row).not.toHaveProperty('childResult');
    expect(podChildEvidenceLedgerRow({
      job: 'si-task-ok', childRunId: 'run-ok', state: 'complete', result: { stage: 'pr-opened', ok: true },
    })).toBeNull();
  });
});
