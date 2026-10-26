import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import type { BloomResearchQuestion } from './question-ladder-contract.js';
import * as llmModule from '../llm.js';
import * as researchBridgeModule from '../research-bridge/index.js';

const originalLlmModule = { ...llmModule };
const originalResearchBridgeModule = { ...researchBridgeModule };

mock.module('../llm.js', () => ({
  streamLLM: async () => JSON.stringify({ questions: Array.from({ length: 6 }, (_, index) => ({
    id: `default-q${index + 1}`,
    level: index + 1,
    prompt: `default question ${index + 1}`,
    searchTerms: [`default term ${index + 1}`],
  })) }),
}));

let axisCalls = 0;
mock.module('../research-bridge/index.js', () => ({
  invokeResearchAxes: async (questions: readonly BloomResearchQuestion[]) => {
    axisCalls += 1;
    return {
      plan: [],
      axes: questions.map((question) => ({ questionId: question.id, evidence: [{
        questionId: question.id,
        sourceKind: 'web-search:test',
        source: `https://example.org/${question.id}`,
        content: `source for ${question.id}`,
        outcome: 'complete' as const,
        truncated: true,
      }] })),
    };
  },
}));

afterAll(() => {
  mock.module('../llm.js', () => originalLlmModule);
  mock.module('../research-bridge/index.js', () => originalResearchBridgeModule);
});

let runResearchQuestionLadder: typeof import('./research-turn.js').runResearchQuestionLadder;
beforeAll(async () => {
  ({ runResearchQuestionLadder } = await import('./research-turn.js'));
}, 60_000);

test('the production no-options call uses the default generator and native axis bridge', async () => {
  const result = await runResearchQuestionLadder('a research topic');

  expect(result.ok).toBe(true);
  expect(axisCalls).toBe(1);
  expect(result.ladder.questions).toHaveLength(6);
  expect(result.ladder.evidence).toHaveLength(6);
  expect(result.output).toContain('https://example.org/default-q1');
});
