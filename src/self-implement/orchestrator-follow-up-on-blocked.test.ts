import { expect, test } from 'bun:test';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import type { FollowUpDraftRecord } from './follow-up-goals.js';

test('UNCONVERGEABLE review drafts the must-fix and shadow decomposition without queueing in live mode', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  delete process.env.ELANOUS_SUBSTRATE;
  const drafts: FollowUpDraftRecord[] = [];
  let enqueued = 0;
  try {
    const result = await runSelfImplement({
      goalId: 'FLEX-FU-ON-FAIL', feature: 'FLEX-FU-ON-FAIL 실패 뒤 후속\n둘째 줄',
      maxReworkRounds: 2, reworkBudgetShadowStop: false, memory: false,
      seams: seams({
        preservationHasChanges: () => false,
        reviewDiff: async () => ({ verdict: 'fail', mustFix: ['must A'], shouldFix: [], reviewed: true, summary: 'blocked' }),
        diagnose: async () => 'BUDGET: UNCONVERGEABLE\nREASON: the same finding does not converge',
        judgmentCallLLM: async () => 'UNCONVERGEABLE',
        decomposeShadowGoals: async () => ({
          goals: [{ id: 'one', feature: 'piece one', dependsOn: [] }, { id: 'two', feature: 'piece two', dependsOn: [] }],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
        }),
        followUp: {
          mode: 'live', readDrafts: () => drafts, appendDraft: (row) => { drafts.push(row); },
          enqueue: () => { enqueued++; },
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, stage: 'review-blocked', supervisorVerdict: 'UNCONVERGEABLE' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ ending: 'blocked', runId: result.runId, stage: 'review-blocked', prNumber: 0, queued: false, remainings: ['must A', 'piece one', 'piece two'] });
    expect(enqueued).toBe(0);
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
  }
});
