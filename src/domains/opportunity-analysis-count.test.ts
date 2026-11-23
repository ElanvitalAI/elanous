import { expect, test } from 'bun:test';
import { opportunityAnalysisCount } from './opportunity-analysis-count.js';

test('opportunity scan is capped at two, or one for a one-shot validation', () => {
  expect(opportunityAnalysisCount(8, { armed: true, armOnce: false })).toBe(2);
  expect(opportunityAnalysisCount(1, { armed: true, armOnce: false })).toBe(1);
  expect(opportunityAnalysisCount(8, { armed: false, armOnce: true })).toBe(1);
  expect(opportunityAnalysisCount(0, { armed: false, armOnce: true })).toBe(0);
  expect(opportunityAnalysisCount(8, { armed: false, armOnce: false })).toBe(0);
});
