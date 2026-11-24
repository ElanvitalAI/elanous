import { describe, expect, it } from 'bun:test';
import { classificationAudit, isSecurityClass, isUncategorizedSecurityHold } from './security-hold-policy.js';

it('does not claim a request was sent merely because a review is eligible', () => {
  const row = { verdict: 'fail', mustFix: ['security finding'], securityFindings: [{ kind: 'security-only', text: 'security finding' }] };
  expect(classificationAudit(row)).toEqual({ version: 1, classificationRequest: 'not-sent', reason: 'security-only-unclassified' });
  expect(classificationAudit({ verdict: 'pass' }).classificationRequest).toBe('not-requested');
});

describe('security hold classification (fail closed)', () => {
  const security = { kind: 'security-only', text: 'security finding' };
  it('joins real string blockers to explicit findings without changing the verdict', () => {
    const row = { verdict: 'fail', mustFix: ['security finding'], securityFindings: [security] };
    expect(isUncategorizedSecurityHold(row)).toBe(true);
    expect(isUncategorizedSecurityHold({ ...row, mustFix: ['security finding', 'functional'] })).toBe(false);
    expect(isUncategorizedSecurityHold({ ...row, securityFindings: [{ ...security, securityClass: 'typo' }] })).toBe(false);
    expect(isUncategorizedSecurityHold({ ...row, verdict: 'pass' })).toBe(false);
    expect(isUncategorizedSecurityHold({ ...row, securityClass: 'typo' })).toBe(false);
    expect(isUncategorizedSecurityHold(null)).toBe(false);
  });
  it('recognizes exactly the four allowed classes', () => {
    for (const value of ['destructive', 'secret-leak', 'unauth-remote', 'cross-user-data']) expect(isSecurityClass(value)).toBe(true);
    for (const value of ['', 'other', null, 'Destructive']) expect(isSecurityClass(value)).toBe(false);
  });
});

import { normalizeExplicitSecurityHold, mergeReviewFollowUps } from './security-hold-policy.js';
describe('normalization', () => {
  it('preserves unclassified security holds and their follow-up metadata', () => {
    const input = { verdict: 'hold', mustFix: [{ kind: 'security-only', text: 'finding' }], fu: [{ text: 'later', cell: 'SMARTSEC-1' }], edges: ['edge'] };
    expect(normalizeExplicitSecurityHold(input)).toEqual({ result: input, downgraded: false });
    expect(input.mustFix).toHaveLength(1);
  });
  it('preserves every ambiguous, functional, mixed, classified or malformed hold', () => {
    const finding = { kind: 'security-only', text: 'security' };
    for (const input of [
      { verdict: 'hold', mustFix: ['legacy'] },
      { verdict: 'hold', mustFix: [finding, 'functional'] },
      { verdict: 'hold', mustFix: [finding, { kind: 'functional', text: 'failure' }] },
      { verdict: 'hold', mustFix: [{ ...finding, securityClass: 'destructive' }] },
      { verdict: 'hold', securityClass: 'typo', mustFix: [finding] },
      { verdict: 'fail', mustFix: [finding] },
      { verdict: 'hold', mustFix: [] },
    ]) expect(normalizeExplicitSecurityHold(input)).toEqual({ result: input, downgraded: false });
  });
  it('merges and deduplicates compatible historical follow-ups', () => {
    expect(mergeReviewFollowUps({ fu: [{ text: 'x' }], edges: ['x', 'y'], followUp: ['y'] })).toEqual([{ text: 'x' }, { text: 'y' }]);
  });
});

import { parseReviewResult, foldReviewResults } from './pr-reviewer.js';
it('fold preserves distinct functional blockers alongside security findings', () => {
  const security = parseReviewResult('VERDICT: FAIL\nMUST-FIX:\n- concern\nSECURITY-FINDINGS:\n- concern | none');
  const functional = parseReviewResult('VERDICT: FAIL\nMUST-FIX:\n- broken feature');
  const folded = foldReviewResults([security, functional]);
  expect(folded.verdict).toBe('fail');
  expect(folded.mustFix).toContain('broken feature');
  expect(folded.securityFindings).toBeUndefined();
});
