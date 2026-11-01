import { expect, test } from 'bun:test';
import {
  executeGoalAuthorReviewerDialog,
  runGoalAuthorReviewerPrecheck,
} from './goal-author.js';
import type { LLMMessage } from '../llm.js';
import { supervisorReauthorRequestObservations, type SupervisorDecision } from '../self-dev/run-supervisor.js';

const firstFix = 'The result has a measurable criterion and an observable source.';
const secondFix = 'The result has a named owner and a time bound.';

const goalDocument = (): string => [
  'Reviewable goal',
  '- GoalId: 1234567890abcdef',
  '- RootIntent: preserve measurable authoring',
  '- GoalType: implement',
  '',
  '## PROBLEM', '- The current goal needs clearer acceptance.',
  '',
  '## WHAT TO BUILD', '- Make the goal measurable.',
  'Original ask (verbatim, unmodified):', '```text', '대상 경로: src/self-implement/goal-author.ts', `${firstFix} ${secondFix}`, '```',
  '',
  '## ACCEPTANCE CRITERIA', '- The result has a measurable criterion.',
  '',
  '## REQUIRED EVIDENCE', '- [requested] focused test output',
  '',
  '## TRACED PATHS', '- src/self-implement/goal-author.ts — author entrypoint',
  '',
  '## SCOPE BOUNDARY', '- 대상 경로: src/self-implement/goal-author.ts',
  '',
  '## 답하지 못하는 것', '- No unresolved questions.',
  '',
  '## 불변식', '- The original ask remains verbatim.',
  '',
  '## 판정 신호', '- Condition: the authoring result is reviewed', '- Observation: revised acceptance is present', '- Expected result: the criterion is measurable.',
].join('\n');

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG: two fake-provider proposals share one run-bound dialogue with the supervisor request', async () => {
  let activeDocument = goalDocument();
  let providerCalls = 0;
  const stream: typeof import('../llm.js').streamLLM = async (_messages: LLMMessage[], _onChunk, options = {}) => {
    providerCalls += 1;
    const fix = providerCalls === 1 ? firstFix : secondFix;
    const originalText = providerCalls === 1
      ? '- The result has a measurable criterion.'
      : `- ${firstFix}`;
    const revisedText = `${originalText}\n- ${fix}`;
    const revisedDocument = activeDocument.replace(originalText, revisedText);
    options.onResolvedProvider?.(options.provider!.name, options.model!);
    return JSON.stringify({
      suggestions: [],
      fixes: [fix],
      fixEvidence: [{ fix, originalText, revisedText }],
      remainingNeedsHuman: [],
      revisedDocument,
    });
  };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const conversationId = 'run-dialog-1';
  const dialog = await executeGoalAuthorReviewerDialog(
    true,
    activeDocument,
    conversationId,
    async (document, context) => {
      activeDocument = document;
      return runGoalAuthorReviewerPrecheck(document, { stream, reviewContext: context });
    },
    (event, data) => events.push({ event, data }),
  );

  expect(providerCalls).toBe(2);
  expect(dialog).toMatchObject({ outcome: 'cap-hit', rounds: 2, hitl: true });
  expect(dialog.status).toBe('completed');
  expect(dialog.document).toContain(`- ${firstFix}`);
  expect(dialog.document).toContain(`- ${secondFix}`);
  const reviewerRounds = events.filter((entry) => entry.event === 'author.reviewer.round');
  expect(reviewerRounds).toHaveLength(2);
  expect(reviewerRounds.map(({ data }) => data)).toEqual([
    expect.objectContaining({ conversationId, runId: conversationId, round: 1, proposalCount: 1, appliedCount: 1, rejectedCount: 0, rejectionReasonCodes: [] }),
    expect.objectContaining({ conversationId, runId: conversationId, round: 2, proposalCount: 1, appliedCount: 1, rejectedCount: 0, rejectionReasonCodes: [] }),
  ]);
  const closed = events.find((entry) => entry.event === 'author.dialog.closed');
  expect(closed?.data).toEqual({ conversationId, runId: conversationId, outcome: 'cap-hit', rounds: 2, hitl: true });

  const decision = {
    action: 'relaunch',
    reauthor: { round: 1, classifications: [{ taskId: 'task-1', kind: 'authorship-defect' }] },
  } as unknown as SupervisorDecision;
  const lineageLookups: string[] = [];
  const supervisorEvents = supervisorReauthorRequestObservations(decision, 'parent-run-1', [
    { taskId: 'task-1', feature: 'goal', status: 'done', runId: 'review-run-1' },
  ], (sourceRunId) => { lineageLookups.push(sourceRunId); return sourceRunId === 'parent-run-1' ? conversationId : null; });
  expect(lineageLookups).toEqual(['parent-run-1']);
  expect(supervisorEvents).toEqual([{
    event: 'supervisor.reauthor-request',
    data: {
      conversationId,
      runId: conversationId,
      parentRunId: 'parent-run-1',
      sourceReviewRunId: 'review-run-1',
      attempt: 1,
      classification: 'authorship-defect',
    },
  }]);
  expect(supervisorEvents[0]!.data.conversationId).toBe(closed?.data.conversationId);
  expect(supervisorEvents[0]!.data.runId).toBe(reviewerRounds[0]!.data.runId);

  const unjoined = supervisorReauthorRequestObservations(decision, 'parent-run-unjoined', [
    { taskId: 'task-1', feature: 'goal', status: 'done', runId: 'review-run-unjoined' },
  ]);
  expect(unjoined).toEqual([{
    event: 'supervisor.reauthor-unjoined',
    data: {
      parentRunId: 'parent-run-unjoined',
      sourceReviewRunId: 'review-run-unjoined',
      taskId: 'task-1',
      attempt: 1,
      classification: 'authorship-defect',
      reason: 'author-run-id-unresolved',
    },
  }]);
});

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG: provider error preserves the current document and closes fail-soft', async () => {
  const original = goalDocument();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const dialog = await executeGoalAuthorReviewerDialog(
    true,
    original,
    'run-provider-error',
    async () => { throw new Error('provider unavailable'); },
    (event, data) => events.push({ event, data }),
  );
  expect(dialog).toMatchObject({ document: original, outcome: 'provider-error', rounds: 1, hitl: false });
  expect(events.at(-1)?.data).toEqual({
    conversationId: 'run-provider-error', runId: 'run-provider-error', outcome: 'provider-error', rounds: 1, hitl: false,
  });
});

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG: needs-human findings survive later reviewer rounds', async () => {
  const original = goalDocument();
  let round = 0;
  const dialog = await executeGoalAuthorReviewerDialog(
    true,
    original,
    'run-needs-human-union',
    async (document) => {
      round += 1;
      return {
        suggestions: [], fixes: [], fixEvidence: [], appliedFixes: [], unappliedItems: [],
        remainingNeedsHuman: [round === 1 ? 'first-round-question' : 'second-round-question'],
        revisedDocument: document,
      };
    },
  );
  expect(dialog.result?.remainingNeedsHuman).toEqual(['first-round-question', 'second-round-question']);
});

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG: a later provider error rolls back earlier round edits to the authored original', async () => {
  const original = goalDocument();
  let calls = 0;
  const stream: typeof import('../llm.js').streamLLM = async (_messages: LLMMessage[], _onChunk, options = {}) => {
    calls += 1;
    if (calls === 2) throw new Error('provider unavailable on follow-up');
    const originalText = '- The result has a measurable criterion.';
    const revisedText = `${originalText}\n- ${firstFix}`;
    options.onResolvedProvider?.(options.provider!.name, options.model!);
    return JSON.stringify({
      suggestions: [], fixes: [firstFix],
      fixEvidence: [{ fix: firstFix, originalText, revisedText }],
      remainingNeedsHuman: [], revisedDocument: original.replace(originalText, revisedText),
    });
  };
  const dialog = await executeGoalAuthorReviewerDialog(true, original, 'run-follow-up-error',
    (document, context) => runGoalAuthorReviewerPrecheck(document, { stream, reviewContext: context }));
  expect(calls).toBe(2);
  expect(dialog).toMatchObject({ outcome: 'provider-error', rounds: 2, hitl: false, document: original });
  expect(dialog.result).toMatchObject({
    revisedDocument: original,
    appliedFixes: [],
    unappliedItems: [firstFix],
    remainingNeedsHuman: [firstFix],
  });
});

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG: unsupported proposals are rejected with a reason code', async () => {
  const original = goalDocument();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const dialog = await executeGoalAuthorReviewerDialog(
    true,
    original,
    'run-rejected-proposal',
    async (document) => ({
      suggestions: [],
      fixes: ['Add a requirement that was never requested.'],
      remainingNeedsHuman: [],
      revisedDocument: document.replace('The current goal needs clearer acceptance.', 'Add a requirement that was never requested.'),
      appliedFixes: [],
      unappliedItems: [],
    }),
    (event, data) => events.push({ event, data }),
  );
  expect(dialog.document).toBe(original);
  expect(dialog).toMatchObject({ outcome: 'cap-hit', rounds: 2, hitl: true });
  expect(events.filter((entry) => entry.event === 'author.reviewer.round').map((entry) => entry.data)).toEqual([
    expect.objectContaining({ proposalCount: 1, appliedCount: 0, rejectedCount: 1, rejectionReasonCodes: ['fix-not-grounded'] }),
    expect.objectContaining({ proposalCount: 1, appliedCount: 0, rejectedCount: 1, rejectionReasonCodes: ['fix-not-grounded'] }),
  ]);
});

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG: disabled precheck is observed as skipped, not converged', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const dialog = await executeGoalAuthorReviewerDialog(false, goalDocument(), 'run-disabled', async () => {
    throw new Error('disabled dialogue must not call the reviewer');
  }, (event, data) => events.push({ event, data }));
  expect(dialog).toMatchObject({ status: 'skipped', outcome: 'skipped', rounds: 0, hitl: false });
  expect(events).toEqual([{
    event: 'author.reviewer-precheck.skipped',
    data: { authorRunId: 'run-disabled', conversationId: 'run-disabled', runId: 'run-disabled', reason: 'disabled', providerCalls: 0 },
  }]);
});
