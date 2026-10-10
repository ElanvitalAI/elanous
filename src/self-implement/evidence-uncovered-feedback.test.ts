import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { formatUncoveredEvidenceFeedback, coverRequiredEvidence, parseOffDiffEvidence, requiredEvidenceFromGoal } from './off-diff-evidence.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';

const goal = ['goal', '## REQUIRED EVIDENCE', '- [requested] test result', '- [wiring] caller connection'].join('\n');
const requested = 'EVIDENCE: [requested] focused test passed || bun test focused.test.ts\nRESULT: 1 pass';
const reviewDiff = async () => ({ verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false });

describe('uncovered required-evidence feedback', () => {
  test('formats every uncovered tag with a matching EVIDENCE and RESULT line without changing coverage', () => {
    const uncovered = ['wiring', 'preservation'];
    const feedback = formatUncoveredEvidenceFeedback(uncovered);
    expect(feedback).toContain('[wiring], [preservation]');
    for (const tag of uncovered) {
      expect(feedback).toContain(`EVIDENCE: [${tag}] <확인한 내용> || <재현 명령>`);
      expect(feedback).toContain('RESULT: <그 명령의 실제 결과>');
    }
    expect(coverRequiredEvidence(requiredEvidenceFromGoal(goal), parseOffDiffEvidence(requested).items).uncovered).toEqual(['wiring']);
  });

  test('one uncovered tag opens exactly one rework round and the second uncovered decision defers merge', async () => {
    const calls: Array<{ feature: string; round?: number; failure?: string }> = [];
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: goal, autoMerge: true, maxReworkRounds: 2, seams: seams({
        implement: async ({ feature, roundContext }) => {
          calls.push({ feature, round: roundContext?.round, failure: roundContext?.previousRoundFailure });
          return { ok: true, summary: requested };
        },
        reviewDiff,
        mergePr: async () => { throw new Error('uncovered evidence must not merge'); },
      }) });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.round).toBeUndefined();
      expect(calls[1]?.round).toBe(1);
      expect(calls[1]?.feature).toContain('EVIDENCE: [wiring]');
      expect(calls[1]?.failure).toContain('EVIDENCE: [wiring]');
      expect(calls[1]?.feature).not.toContain('EVIDENCE: [preservation]');
      expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'required-evidence-uncovered' });
      expect(events.filter(({ category, event }) => category === 'self-implement.evidence' && event === 'uncovered-feedback'))
        .toEqual([{ category: 'self-implement.evidence', event: 'uncovered-feedback', data: { uncovered: ['wiring'], round: 1 } }]);
      expect(events.filter(({ event }) => event === 'merge-decision').at(-1)?.data).toMatchObject({
        reason: 'required-evidence-uncovered', uncoveredEvidence: ['wiring'], coveredEvidence: 1,
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('a Pod host-merge run (mergeByHost without autoMerge) gets the same single feedback round', async () => {
    const calls: Array<{ round?: number; feature: string }> = [];
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      await runSelfImplement({ feature: goal, mergeByHost: true, maxReworkRounds: 2, seams: seams({
        implement: async ({ feature, roundContext }) => {
          calls.push({ round: roundContext?.round, feature });
          return { ok: true, summary: requested };
        },
        reviewDiff,
        mergePr: async () => { throw new Error('a host-merge run never merges inside the run'); },
      }) });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.round).toBe(1);
      expect(calls[1]?.feature).toContain('EVIDENCE: [wiring]');
      expect(events.filter(({ category, event }) => category === 'self-implement.evidence' && event === 'uncovered-feedback'))
        .toEqual([{ category: 'self-implement.evidence', event: 'uncovered-feedback', data: { uncovered: ['wiring'], round: 1 } }]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('a child that supplies both tags in the feedback round can pass the evidence merge guard', async () => {
    let calls = 0;
    const events: Array<{ event: string; data: unknown }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => { events.push({ event, data }); }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: goal, autoMerge: true, maxReworkRounds: 1, seams: seams({
        implement: async () => ({
          ok: true,
          summary: ++calls === 1 ? requested : `${requested}\nEVIDENCE: [wiring] caller verified || bun test wiring.test.ts\nRESULT: 1 pass`,
        }),
        reviewDiff,
      }) });
      expect(calls).toBe(2);
      expect(events.filter(({ event }) => event === 'merge-decision').at(-1)?.data).toMatchObject({
        requiredEvidence: 2, coveredEvidence: 2, uncoveredEvidence: [], uncoveredCount: 0,
      });
      expect(result.mergeReason).not.toBe('required-evidence-uncovered');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('without a rework round, defers as before and does not send feedback', async () => {
    let calls = 0;
    const events: string[] = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event) => { events.push(event); }) as typeof debug.log;
    try {
      const result = await runSelfImplement({ feature: goal, autoMerge: true, maxReworkRounds: 0, seams: seams({
        implement: async () => { calls++; return { ok: true, summary: requested }; },
        reviewDiff,
        mergePr: async () => { throw new Error('uncovered evidence must not merge'); },
      }) });
      expect(calls).toBe(1);
      expect(events).not.toContain('uncovered-feedback');
      expect(result).toMatchObject({ stage: 'pr-opened', mergeReason: 'required-evidence-uncovered' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });
});
