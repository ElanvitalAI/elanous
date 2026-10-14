import { expect, test } from 'bun:test';
import { repairMustFixFromReview } from './repair-review.js';

const head = 'a'.repeat(40);
const result = (over: Record<string, unknown> = {}) => JSON.stringify({ pr: 30, headCommit: head, reviewed: true, verdict: 'fail', mustFix: ['fix the guard'], ...over });

test('returns verbatim must-fix text only for the captured exact PR head', () => {
  expect(repairMustFixFromReview(`progress\n${result()}`, 30, head)).toEqual(['fix the guard']);
  expect(repairMustFixFromReview(result(), 31, head)).toBeNull();
  expect(repairMustFixFromReview(result(), 30, 'b'.repeat(40))).toBeNull();
  expect(repairMustFixFromReview(result({ reviewed: false }), 30, head)).toBeNull();
  expect(repairMustFixFromReview(result({ error: 'overload' }), 30, head)).toBeNull();
  expect(repairMustFixFromReview(result({ mustFix: ['fix the guard', 3] }), 30, head)).toBeNull();
});
