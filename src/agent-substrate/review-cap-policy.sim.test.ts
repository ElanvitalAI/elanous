import { expect, test } from 'bun:test';
import { decideReviewCapPolicy, reviewCapIncidentId } from './review-cap-policy.js';

const PR = '36848';
const HEAD = 'a'.repeat(40);

test('review cap and same-head loop breaker share an incident and the same OP release routes', () => {
  const cap = decideReviewCapPolicy({
    pr: PR, head: HEAD, previousReviewCount: 5, opAllowlisted: false,
  });
  const loop = decideReviewCapPolicy({
    pr: PR, head: HEAD, previousReviewCount: 4, opAllowlisted: false,
    loopBreaker: { reason: 'two-consecutive-stale-reopen-rounds', head: HEAD },
  });

  expect(cap).toMatchObject({
    incidentId: reviewCapIncidentId(PR, HEAD), allowed: false, blockedBy: 'r5-cap',
    releasePaths: ['op-waiver', 'over-cap-reason', 'main-merge-review-inheritance'],
  });
  expect(loop).toMatchObject({ incidentId: cap.incidentId, allowed: false,
    blockedBy: 'review-loop-breaker', releasePaths: cap.releasePaths });
});

test('a claimed OP waiver releases both cap and same-head loop lock under the same incident', () => {
  const cap = decideReviewCapPolicy({ pr: PR, head: HEAD, previousReviewCount: 5,
    opAllowlisted: true, overCapReason: 'approved retry', capClaimed: true });
  const loop = decideReviewCapPolicy({ pr: PR, head: HEAD, previousReviewCount: 5,
    opAllowlisted: true, overCapReason: 'approved retry', capClaimed: true,
    loopBreaker: { reason: 'two-consecutive-stale-reopen-rounds', head: HEAD } });

  expect(cap).toMatchObject({ incidentId: loop.incidentId, allowed: true, releasePath: 'op-waiver' });
  expect(loop).toMatchObject({ incidentId: cap.incidentId, allowed: true, releasePath: 'op-waiver' });
});

test('an over-cap reason is only a release route while OP allowlisting is active', () => {
  const denied = decideReviewCapPolicy({ pr: PR, head: HEAD, previousReviewCount: 5,
    opAllowlisted: false, overCapReason: 'requested retry' });
  const released = decideReviewCapPolicy({ pr: PR, head: HEAD, previousReviewCount: 5,
    opAllowlisted: true, overCapReason: 'requested retry' });

  expect(denied).toMatchObject({ allowed: false, blockedBy: 'r5-cap' });
  expect(released).toMatchObject({ allowed: true, releasePath: 'over-cap-reason' });
});

test('an unknown current head keeps a stale-reopen lock fail-closed', () => {
  const unknown = decideReviewCapPolicy({ pr: PR, head: 'unknown', previousReviewCount: 1,
    opAllowlisted: false, loopBreaker: { reason: 'two-consecutive-stale-reopen-rounds', head: HEAD } });
  expect(unknown).toMatchObject({ allowed: false, blockedBy: 'review-loop-breaker' });
});

test('a conflict-free main merge inherits the prior review without spending an r5 round', () => {
  const inherited = decideReviewCapPolicy({ pr: PR, head: 'b'.repeat(40), previousReviewCount: 5,
    opAllowlisted: false, mainMergeReviewInherited: true,
    loopBreaker: { reason: 'review-cap-exceeded', head: HEAD } });

  expect(inherited).toMatchObject({ allowed: true, releasePath: 'main-merge-review-inheritance',
    inheritedReviewHead: 'b'.repeat(40) });
});

test('verified main-merge inheritance releases a same-head stale-reopen lock', () => {
  const inherited = decideReviewCapPolicy({ pr: PR, head: HEAD, previousReviewCount: 4,
    opAllowlisted: false, mainMergeReviewInherited: true,
    loopBreaker: { reason: 'two-consecutive-stale-reopen-rounds', head: HEAD } });
  expect(inherited).toMatchObject({ allowed: true, releasePath: 'main-merge-review-inheritance' });
});
