import { expect, test } from 'bun:test';
import type { ResearchEvidenceEnvelope, SixLevelResearchQuestionLadder } from './question-ladder-contract.js';
import { partialGroundingSnapshot } from './research-turn.js';

const ladder: SixLevelResearchQuestionLadder = {
  request: 'req',
  questions: [
    { id: 'q1', level: 1, prompt: '금리 전망 축', searchTerms: ['금리'] },
    { id: 'q2', level: 2, prompt: '환율 전망 축', searchTerms: ['환율'] },
  ],
  evidence: [],
};
const env = (questionId: string, outcome: ResearchEvidenceEnvelope['outcome']): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search', source: `https://example.test/${questionId}`, content: 'x', outcome, truncated: false,
});

test('partial snapshot exposes the failed axes as a structured array from the envelope questionId', () => {
  const snapshot = partialGroundingSnapshot('req', ladder, [env('q1', 'complete'), env('q2', 'failed'), env('q2', 'failed')]);
  expect(snapshot?.failedEvidenceCount).toBe(2);
  expect(snapshot?.failedAxes).toEqual(['환율 전망 축']);
});

test('no failed envelope: failedAxes is empty', () => {
  const snapshot = partialGroundingSnapshot('req', ladder, [env('q1', 'complete')]);
  expect(snapshot?.failedAxes).toEqual([]);
});

test('a failed envelope bound to an unknown question carries no axis name', () => {
  const snapshot = partialGroundingSnapshot('req', ladder, [env('q1', 'complete'), env('zz', 'failed')]);
  expect(snapshot?.failedEvidenceCount).toBe(1);
  expect(snapshot?.failedAxes).toEqual([]);
});
