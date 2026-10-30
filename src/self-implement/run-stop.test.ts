import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { boundRunStopCause, buildRunStopTerminalEvidence, classifyMergeHoldStop, classifyPodExitStop, classifyRunStopReason, classifyStopReasonFromGraph, classifyTerminalHarnessFailure, readRunStopRecord, recordRunStop, runStopChildAttempts, runStopRecorded, RUN_STOP_CLASSES } from './run-stop.js';
import { debug } from '../debug/log.js';
import { spyOn } from 'bun:test';
import type { RunLedgerEntry } from './run-ledger.js';
import { podChildEvidenceLedgerRow } from '../task-orchestrator/surfaces/pod-failure-reason.js';

// Warm the module before test bodies so a slow cold import cannot spill into the next test.
beforeAll(async () => { await import('./stop-autoheal.js'); }, 30_000);

describe('recordRunStop', () => {
  test('appends one stop with a closed class and preserves earlier entries', () => {
    const prior: RunLedgerEntry = { runId: 'run-test', event: 'merge-decision', data: { reason: 'no-auto-flag' } };
    const entries = [prior];
    recordRunStop({ runId: 'run-test', class: 'main-sync', cause: 'merge held: main-sync-conflict-unresolved', evidenceRef: 'run-ledger:run-test:merge-decision', nextMove: 'Review merge decision' }, (entry) => entries.push(entry));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe(prior);
    expect(entries[1]).toMatchObject({ runId: 'run-test', event: 'stop', data: { class: 'main-sync', cause: 'merge held: main-sync-conflict-unresolved', evidenceRef: 'run-ledger:run-test:merge-decision', nextMove: 'Review merge decision' } });
    expect(RUN_STOP_CLASSES).toEqual(['env-unrelated', 'main-sync', 'pod-died', 'pod-vanished', 'review-repeat', 'review-out-of-scope', 'review-budget-exhausted', 'scope-escape', 'evidence-uncovered', 'fabric', 'launch-failed', 'gate-failed', 'implement-aborted', 'out-of-scope-held', 'provider-auth-missing', 'provider-unavailable', 'merge-held-release-path', 'pr-guard-failed', 'gate-unmeasured', 'unclassified']);
  });

  test('unknown class is unclassified; cause is one line at most 120 characters without truncation marker', () => {
    const entries: RunLedgerEntry[] = [];
    recordRunStop({ runId: 'run-test', class: 'invented', cause: `reason\n생략] ${'x'.repeat(200)}\rraw`, evidenceRef: 'run-ledger:run-test:implemented', nextMove: 'Inspect evidence' }, (entry) => entries.push(entry));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.class).toBe('unclassified');
    const cause = entries[0]!.data.cause as string;
    expect(Array.from(cause).length).toBeLessThanOrEqual(120);
    expect(cause).toBe('reason');
    expect(cause).not.toMatch(/[\r\n]|생략\]/);
  });

  test('long single-line causes are capped without appending a truncation suffix', () => {
    const entries: RunLedgerEntry[] = [];
    recordRunStop({ runId: 'run-test', cause: 'x'.repeat(250), evidenceRef: 'ledger', nextMove: 'Inspect' }, (entry) => entries.push(entry));
    expect(entries[0]!.data.cause).toBe('x'.repeat(120));
    expect(entries[0]!.data.class).toBe('unclassified');
  });

  test('cause never carries a raw log tail: ANSI stripped, first non-empty line only', () => {
    const tail = ['', '\x1b[31merror: unknown option --bogus\x1b[0m', ...Array.from({ length: 50 }, (_, i) => `    at frame${i} (file.ts:${i})`)].join('\n');
    expect(boundRunStopCause(tail)).toBe('error: unknown option --bogus');
    expect(boundRunStopCause('')).toBe('stop reason unclassified');
  });

  test('classifiers map known reasons into the closed list and the rest to unclassified', () => {
    const reasonCases = [
      ['implement aborted', 'implement-aborted'], ['Out-of-scope edits held', 'out-of-scope-held'],
      ['grok login XAI key provider-auth-missing', 'provider-auth-missing'], ['openrouter_unavailable', 'provider-unavailable'],
      ['release-path-hold', 'merge-held-release-path'], ['pr-guard-failed', 'pr-guard-failed'], ['SSH rc255 gate-unmeasured', 'gate-unmeasured'],
    ] as const;
    for (const [reason, expected] of reasonCases) expect(classifyStopReasonFromGraph(reason)).toBe(expected);
    expect(classifyStopReasonFromGraph('OOMKilled')).toBe('pod-died');
    expect(classifyStopReasonFromGraph('OOM')).toBe('pod-died');
    expect(classifyStopReasonFromGraph('room pressure')).toBeUndefined();
    expect(classifyMergeHoldStop('main-sync-conflict-unresolved')).toBe('main-sync');
    expect(classifyMergeHoldStop('required-evidence-uncovered')).toBe('evidence-uncovered');
    expect(classifyMergeHoldStop('review-must-fix')).toBe('review-repeat');
    expect(classifyMergeHoldStop('review-warn-with-must-fix')).toBe('review-repeat');
    expect(classifyMergeHoldStop('review-budget-exhausted')).toBe('review-budget-exhausted');
    expect(classifyMergeHoldStop('no-real-review')).toBe('review-out-of-scope');
    expect(classifyMergeHoldStop('something-new')).toBe('unclassified');
    expect(classifyMergeHoldStop(undefined)).toBe('unclassified');
    expect(classifyPodExitStop('pod-failure')).toBe('pod-died');
    // 호스트 재게이트 실패 종료 — stage 둘째 인자가 있으면 gate-failed, 없으면 지금과 똑같이 pod-died.
    expect(classifyPodExitStop('pod-failure', 'host-regate-failed')).toBe('gate-failed');
    expect(classifyPodExitStop('OOMKilled')).toBe('pod-died');
    expect(classifyPodExitStop('no-launch')).toBe('launch-failed');
    expect(classifyPodExitStop('unknown')).toBe('unclassified');
  });

  test('HARNESS-HEAL-EXITS routes exhausted failure shapes into the existing prescription ladder', async () => {
    const cases = [
      [{ stage: 'aborted', abandonedClassification: 'report-deficit' }, 'pod-died', 'resume-from-salvage'],
      [{ stage: 'gate-failed' }, 'gate-failed', 'needs-owner'],
      [{ stage: 'review-blocked', supervisorVerdict: 'EXTEND' }, 'review-repeat', 'needs-owner'],
      [{ stage: 'aborted', providerErrorCategory: 'credential', abandonedClassification: 'credential-failure' }, 'provider-auth-missing', 'switch-provider'],
      [{ stage: 'aborted', supervisorVerdict: 'UNCONVERGEABLE' }, 'review-repeat', 'needs-owner'],
      [{ stage: 'review-blocked', mergeReason: 'review-budget-exhausted' }, 'review-budget-exhausted', 'review-round-reauthor'],
    ] as const;
    const { pickAutohealAction } = await import('./stop-autoheal.js');
    for (const [failure, expectedClass, expectedAction] of cases) {
      const actualClass = classifyTerminalHarnessFailure(failure);
      expect(actualClass).toBe(expectedClass);
      expect(pickAutohealAction(actualClass).action).toBe(expectedAction);
    }
  });

  test('records the observation and remembers the run; readRunStopRecord round-trips the schema', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const runId = `run-stop-observe-${Date.now()}`;
      expect(runStopRecorded(runId)).toBe(false);
      const entry = recordRunStop({ runId, site: 'merge-hold', class: 'main-sync', cause: 'merge held: main-sync', evidenceRef: 'pr', nextMove: 'sync' }, () => {});
      expect(runStopRecorded(runId)).toBe(true);
      expect(log).toHaveBeenCalledWith('self-implement.run-stop', 'recorded', expect.objectContaining({ runId, site: 'merge-hold', class: 'main-sync' }));
      expect(readRunStopRecord(entry)).toEqual({ class: 'main-sync', site: 'merge-hold', cause: 'merge held: main-sync', evidenceRef: 'pr', nextMove: 'sync' });
      expect(readRunStopRecord({ runId, event: 'merge-decision', data: {} })).toBeUndefined();
    } finally { log.mockRestore(); }
  });

  test('SELFIMPL-STOP-CAUSE-EVIDENCE keeps retry attempts, classifies known causes, and writes only allowlisted artifact facts', () => {
    const secret = 'sk-live-do-not-persist';
    const childEvidenceEntry = (childRunId: string, stage: string, error: string, exitCode: number): RunLedgerEntry => ({
      runId: 'run-parent', event: 'pod-child-evidence', data: podChildEvidenceLedgerRow({
        childRunId, job: 'job-retry', state: 'complete',
        result: { stage, ok: false, error, childEvidence: { terminalReason: stage } },
        podTermination: { job: 'job-retry', path: 'result-marker', observedAt: '2026-10-30T00:00:00.000Z', jobLookup: 'ok', jobUid: 'job-uid',
          jobConditionReason: 'unknown', activeDeadlineSeconds: 'unknown', deadlineExceeded: 'unknown', podLookup: 'terminated',
          containerReason: 'Error', exitCode, finishedAt: '2026-10-30T00:00:00.000Z', oomKilled: false },
      })!,
    });
    const ledger: RunLedgerEntry[] = [
      childEvidenceEntry('run-child-first', 'implement', `tdd-evidence-missing ${secret}`, 1),
      { runId: 'run-parent', event: 'pod-oom-retry-intent', data: { attempt: 2, fromChildRunId: 'run-child-first', job: 'job-retry' } },
      childEvidenceEntry('run-child-retry', 'decompose', `401 invalid api key ${secret}`, 1),
    ];
    const classify = (values: readonly unknown[]) => classifyRunStopReason({ observedText: values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)) });
    const attempts = runStopChildAttempts(ledger, classify);
    expect(attempts).toMatchObject([
      { childRunId: 'run-child-first', job: 'job-retry', attempt: 'unknown', stage: 'implement', outcome: 'failed', exitCode: 1, reasonCode: 'tdd-evidence-missing' },
      { childRunId: 'run-child-retry', job: 'job-retry', attempt: 2, stage: 'decompose', outcome: 'failed', exitCode: 1, reasonCode: 'decomposition-401-invalid-api-key' },
    ]);
    expect(classifyRunStopReason({ terminationReason: 'goal-only-rework-exhausted' })).toBe('goal-only-same-cell');
    expect(classifyRunStopReason({ observedText: ['unrelated same-cell PR detail'] })).toBe('unknown');
    expect(classifyRunStopReason({ observedText: ['generic 401 invalid api key'] })).toBe('unknown');
    const terminalEvidence = buildRunStopTerminalEvidence({ stage: 'aborted', node: 'implement', outcome: 'abandoned', entries: ledger });
    expect(terminalEvidence).toMatchObject({ childRunId: 'run-child-retry', job: 'job-retry', attempt: 2, stage: 'aborted', node: 'implement', outcome: 'abandoned', exitCode: 1, reasonCode: 'decomposition-401-invalid-api-key' });
    expect(buildRunStopTerminalEvidence({ stage: 'aborted', node: 'unknown', outcome: 'abandoned', entries: [] })).toMatchObject({ childRunId: 'unknown', job: 'unknown', attempt: 'unknown', exitCode: 'unknown', reasonCode: 'unknown' });

    let artifactPath = '';
    let artifact = Buffer.alloc(0);
    const runId = `run-stop-evidence-test-${Date.now()}`;
    const entry = recordRunStop({ runId, class: 'implement-aborted', cause: 'terminal failure', evidenceRef: `run-ledger:${runId}:aborted`, nextMove: 'inspect',
      terminalEvidence,
      writeEvidenceArtifact: (path, bytes) => { artifactPath = path; artifact = bytes; },
    }, () => {});
    const persisted = readRunStopRecord(entry)!;
    expect(persisted.terminalEvidence?.detailArtifact).toMatchObject({ path: artifactPath, byteLength: artifact.byteLength, sha256: createHash('sha256').update(artifact).digest('hex') });
    expect(artifact.toString('utf8')).not.toContain(secret);
    expect(artifact.toString('utf8')).toContain('decomposition-401-invalid-api-key');
    expect(persisted.terminalEvidence?.childRunId).toBe('run-child-retry');
  });
});
