import { expect, test } from 'bun:test';
import { researchTurnForGrounding, runResearchQuestionLadder } from './research-turn.js';

const questions = Array.from({ length: 6 }, (_, index) => ({
  id: `q${index + 1}`,
  level: index + 1,
  prompt: `Question ${index + 1}`,
  searchTerms: [`term-${index + 1}-a`, `term-${index + 1}-b`],
}));

test('a research turn sends all six Bloom axes to native search and attaches source evidence by question', async () => {
  let calls: Array<{ id: string; terms: string[] }> = [];
  const result = await runResearchQuestionLadder('Why are bond yields rising?', {
    generate: async (prompt) => {
      expect(prompt).toContain('Why are bond yields rising?');
      return JSON.stringify({ questions });
    },
    invokeAxes: async (axes) => {
      calls = axes.map(({ id, searchTerms }) => ({ id, terms: searchTerms }));
      return {
        plan: axes.flatMap((axis) => axis.searchTerms.map((query) => ({ questionId: axis.id, tool: 'OmniSearch' as const, query }))),
        axes: axes.map((axis) => ({ questionId: axis.id, evidence: [{
          questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`,
          content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: true,
        }] })),
      };
    },
  });

  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(6);
  expect(calls).toEqual(questions.map((question) => ({ id: question.id, terms: question.searchTerms })));
  expect(result.ladder.questions).toHaveLength(6);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.ladder.evidence[0]).toMatchObject({ questionId: 'q1', sourceKind: 'web-search:test', source: 'https://example.org/q1', outcome: 'complete' });
  expect(result.output).toContain('Evidence');
});

test('an invalid generated ladder fails closed without launching research calls', async () => {
  let calls = 0;
  const result = await runResearchQuestionLadder('bond yields', {
    generate: async () => JSON.stringify({ questions: questions.slice(0, 5) }),
    invokeAxes: async () => { calls += 1; return { plan: [], axes: [] }; },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('exactly six questions');
  expect(calls).toBe(0);
});

test('search failures remain attached to their question while other questions finish', async () => {
  const result = await runResearchQuestionLadder('bond yields', {
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((question) => ({ questionId: question.id, evidence: question.id === 'q3' ? [{
        questionId: question.id, sourceKind: 'search-query', source: question.searchTerms[0]!,
        content: 'provider unavailable', outcome: 'failed' as const, truncated: false,
      }] : [{
        questionId: question.id, sourceKind: 'web-search:test', source: `https://example.org/${question.id}`,
        content: 'evidence', outcome: 'complete' as const, truncated: true,
      }] })),
    }),
  });
  expect(result.ok).toBe(false);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.ladder.evidence.find((item) => item.questionId === 'q3')).toMatchObject({ outcome: 'failed' });
  expect(result.ladder.evidence.find((item) => item.questionId === 'q2')).toMatchObject({ outcome: 'complete' });
  const grounding = researchTurnForGrounding(result);
  expect(grounding.ok).toBe(true);
  expect(grounding.output).toContain('[failed]');
});

test('grounding rejects the research result when all six axes fail', async () => {
  const result = await runResearchQuestionLadder('bond yields', {
    generate: async () => JSON.stringify({ questions }),
    invokeAxes: async (axes) => ({
      plan: [],
      axes: axes.map((question) => ({ questionId: question.id, evidence: [{
        questionId: question.id,
        sourceKind: 'search-query',
        source: question.searchTerms[0]!,
        content: 'provider unavailable',
        outcome: 'failed' as const,
        truncated: false,
      }] })),
    }),
  });

  expect(result.ok).toBe(false);
  expect(researchTurnForGrounding(result).ok).toBe(false);
  expect(researchTurnForGrounding(result).output).toContain('[failed]');
});
