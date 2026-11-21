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

test('a Grok Reddit search summary reaches the partial answer only with a returned Reddit citation', () => {
  const reddit = 'https://www.reddit.com/r/stocks/comments/2027/outlook/';
  const hit: ResearchEvidenceEnvelope = { questionId: 'q1', sourceKind: 'web-search:grok', source: reddit,
    content: '2027 market outlook', outcome: 'partial', truncated: true };
  const summary: ResearchEvidenceEnvelope = { questionId: 'q1', sourceKind: 'search-summary:grok',
    source: 'grok-search-summary', outcome: 'partial', truncated: true,
    content: JSON.stringify({ provider: 'grok', summary: 'Investors split on AI risks and growth.', citationUrls: [reddit] }) };
  const snapshot = partialGroundingSnapshot('req', ladder, [hit, summary]);
  expect(snapshot?.redditSnippets).toEqual([{ url: reddit, kind: 'provider-synthesis', sourceKind: 'search-summary:grok',
    snippet: expect.stringContaining('Investors split on AI risks and growth.') }]);
  const injected = partialGroundingSnapshot('req', ladder, [hit, { ...summary,
    content: JSON.stringify({ provider: 'grok', summary: 'fake', citationUrls: ['https://www.reddit.com/r/fake/'] }) }]);
  expect(injected?.redditSnippets).toEqual([]);
});

test('same Reddit URL preserves separate excerpts and provider synthesis with their sources', () => {
  const reddit = 'https://www.reddit.com/r/stocks/comments/shared/outlook/';
  const evidence: ResearchEvidenceEnvelope[] = [
    { questionId: 'q1', sourceKind: 'web-search:grok', source: reddit, content: 'Grok captured post note', outcome: 'complete', truncated: false },
    { questionId: 'q1', sourceKind: 'social-search:reddit:firecrawl', source: reddit, content: 'Firecrawl captured different note', outcome: 'complete', truncated: false },
    { questionId: 'q1', sourceKind: 'search-summary:grok', source: 'grok-search-summary', content: JSON.stringify({ summary: 'Cross-post sentiment is mixed', citationUrls: [reddit] }), outcome: 'partial', truncated: true },
  ];
  const notes = partialGroundingSnapshot('req', ladder, evidence)?.redditSnippets;
  expect(notes).toEqual([
    { url: reddit, kind: 'source-excerpt', sourceKind: 'web-search:grok', snippet: 'Grok captured post note' },
    { url: reddit, kind: 'source-excerpt', sourceKind: 'social-search:reddit:firecrawl', snippet: 'Firecrawl captured different note' },
    { url: reddit, kind: 'provider-synthesis', sourceKind: 'search-summary:grok', snippet: expect.stringContaining('Cross-post sentiment is mixed') },
  ]);
});
