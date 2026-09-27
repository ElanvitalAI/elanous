import { describe, expect, test } from 'bun:test';
import { blockedDraftDisposition } from './blocked-draft-policy.js';
import type { AbandonedClassification } from './abandoned-classification.js';

describe('blocked draft disposition', () => {
  for (const classification of ['provider-error', 'quota-exhausted', 'credential-failure'] as const) {
    test(`${classification} preserves a branch`, () => {
      expect(blockedDraftDisposition(classification)).toBe('preserve-branch');
    });
  }
  for (const classification of ['implementation-deficit', 'report-deficit', 'goal-unconvergeable-candidate', undefined] as const satisfies readonly (AbandonedClassification | undefined)[]) {
    test(`${classification ?? 'undefined'} opens a draft`, () => {
      expect(blockedDraftDisposition(classification)).toBe('open-draft');
    });
  }
});
