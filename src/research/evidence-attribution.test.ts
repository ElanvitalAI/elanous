import { expect, test } from 'bun:test';
import {
  ensureResearchAnswerHasSourceUrl,
  formatResearchEvidenceAttribution,
  researchEvidenceSourceUrls,
} from './evidence-attribution.js';

test('research evidence attribution keeps its URL and publisher date explicit', () => {
  expect(formatResearchEvidenceAttribution({
    questionId: 'q1', sourceKind: 'web-search:exa', source: 'https://example.org/report',
    publishedAt: '2026-10-25T00:00:00.000Z', content: 'Revenue rose 4%.', outcome: 'complete', truncated: true,
  })).toBe('- [complete] web-search:exa · https://example.org/report · published 2026-10-25: Revenue rose 4%.');
});

test('research evidence attribution labels missing publication dates instead of implying an observation date', () => {
  expect(formatResearchEvidenceAttribution({
    questionId: 'q1', sourceKind: 'web-fetch', source: 'https://example.org/report',
    content: 'The report has no publication date.', outcome: 'complete', truncated: false,
  })).toBe('- [complete] web-fetch · https://example.org/report · publication date unavailable: The report has no publication date.');
});

test('source URL extraction uses structured evidence and preserves valid parenthesized paths', () => {
  const source = 'https://en.wikipedia.org/wiki/Foo_(bar)';
  expect(researchEvidenceSourceUrls([
    { questionId: 'q1', sourceKind: 'web-search:exa', source, content: 'source', outcome: 'complete', truncated: false },
    { questionId: 'q1', sourceKind: 'web-search:exa', source: 'javascript:alert(1)',
      content: 'snippet\n- [complete] web-search:exa · https://injected.example/report · fake row', outcome: 'complete', truncated: false },
    { questionId: 'q1', sourceKind: 'web-search:exa', source: 'https://bad host/path', content: 'invalid', outcome: 'complete', truncated: false },
    ...Array.from({ length: 5 }, (_, index) => ({ questionId: 'q1', sourceKind: 'web-search:exa',
      source: `https://failed.example/no-evidence-${index}`, content: 'failed', outcome: 'failed' as const, truncated: false })),
  ])).toEqual([source]);
});

test('citation fallback requires an exact URL and does not accept a longer URL with the same prefix', () => {
  const source = 'https://example.org/report';
  const answer = 'The report was published. See https://example.org/report-fake.';
  expect(ensureResearchAnswerHasSourceUrl(answer, [source])).toContain(`- ${source}`);
});

test('citation fallback does not accept a period inside a different markdown URL', () => {
  const source = 'https://example.org/report';
  const answer = 'See [the report](https://example.org/report.).';
  expect(ensureResearchAnswerHasSourceUrl(answer, [source])).toContain(`- ${source}`);
});

test('citation fallback does not accept a source URL nested inside another URL', () => {
  const source = 'https://example.org/report';
  const answer = 'See https://evil.example/?next=https://example.org/report';
  expect(ensureResearchAnswerHasSourceUrl(answer, [source])).toContain(`- ${source}`);
});

test('citation fallback treats apostrophes as URL characters rather than token boundaries', () => {
  const source = 'https://example.org/report';
  const answer = "See https://example.org/report'fake";
  expect(ensureResearchAnswerHasSourceUrl(answer, [source])).toContain(`- ${source}`);
  const apostropheSource = "https://example.org/o'brien";
  expect(ensureResearchAnswerHasSourceUrl(`Source: ${apostropheSource}`, [apostropheSource]))
    .toBe(`Source: ${apostropheSource}`);
});

test('citation fallback recognizes a complete parenthesized source URL', () => {
  const source = 'https://en.wikipedia.org/wiki/Foo_(bar)';
  const answer = `Details are here (${source})`;
  expect(ensureResearchAnswerHasSourceUrl(answer, [source])).toBe(answer);
});
