export const REVIEW_CAP_R5_LIMIT = 5;

export const REVIEW_CAP_RELEASE_PATHS = [
  'op-waiver',
  'over-cap-reason',
  'main-merge-review-inheritance',
] as const;

export type ReviewCapReleasePath = typeof REVIEW_CAP_RELEASE_PATHS[number];
export type ReviewCapBlocker = 'r5-cap' | 'review-loop-breaker' | 'review-loop-lock-corrupt';

export interface ReviewCapPolicyInput {
  pr: string;
  head: string;
  previousReviewCount: number;
  opAllowlisted: boolean;
  overCapReason?: string;
  priorAuthorization?: boolean;
  capClaimed?: boolean;
  mainMergeReviewInherited?: boolean;
  loopBreaker?: { reason: string; head?: string };
}

export interface ReviewCapPolicyDecision {
  incidentId: string;
  allowed: boolean;
  releasePaths: readonly ReviewCapReleasePath[];
  releasePath?: ReviewCapReleasePath;
  inheritedReviewHead?: string;
  blockedBy?: ReviewCapBlocker;
}

export function reviewCapIncidentId(pr: string, head: string): string {
  const safePr = pr.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-pr';
  const normalizedHead = /^[0-9a-f]{40}$/i.test(head) ? head.toLowerCase() : 'unpinned';
  return `review-cap:pr-${safePr}:head-${normalizedHead}`;
}

/** One fail-closed decision for the r5 cap and PR-scoped review loop locks. */
export function decideReviewCapPolicy(input: ReviewCapPolicyInput): ReviewCapPolicyDecision {
  const head = input.head.toLowerCase();
  const incidentId = reviewCapIncidentId(input.pr, head);
  const hasWaiver = input.capClaimed === true || input.priorAuthorization === true;
  const hasOverCapRelease = input.opAllowlisted && Boolean(input.overCapReason?.trim());
  const releasePath: ReviewCapReleasePath | undefined = input.mainMergeReviewInherited
    ? 'main-merge-review-inheritance'
    : hasWaiver ? 'op-waiver' : hasOverCapRelease ? 'over-cap-reason' : undefined;
  const canRelease = hasWaiver || hasOverCapRelease;

  if (input.previousReviewCount >= REVIEW_CAP_R5_LIMIT && !input.mainMergeReviewInherited && !canRelease) {
    return { incidentId, allowed: false, releasePaths: REVIEW_CAP_RELEASE_PATHS, blockedBy: 'r5-cap' };
  }

  const lock = input.loopBreaker;
  if (lock) {
    if (lock.reason === 'review-loop-lock-corrupt') {
      return { incidentId, allowed: false, releasePaths: REVIEW_CAP_RELEASE_PATHS, blockedBy: 'review-loop-lock-corrupt' };
    }
    if (lock.reason === 'two-consecutive-stale-reopen-rounds') {
      const sameHead = !/^[0-9a-f]{40}$/i.test(head) || !lock.head || lock.head.toLowerCase() === head;
      if (sameHead && !canRelease && !input.mainMergeReviewInherited) {
        return { incidentId, allowed: false, releasePaths: REVIEW_CAP_RELEASE_PATHS, blockedBy: 'review-loop-breaker' };
      }
    } else if (lock.reason === 'review-cap-exceeded' && !canRelease && !input.mainMergeReviewInherited) {
      return { incidentId, allowed: false, releasePaths: REVIEW_CAP_RELEASE_PATHS, blockedBy: 'review-loop-breaker' };
    } else if (lock.reason !== 'review-cap-exceeded') {
      return { incidentId, allowed: false, releasePaths: REVIEW_CAP_RELEASE_PATHS, blockedBy: 'review-loop-breaker' };
    }
  }

  return {
    incidentId,
    allowed: true,
    releasePaths: REVIEW_CAP_RELEASE_PATHS,
    ...(releasePath ? { releasePath } : {}),
    ...(input.mainMergeReviewInherited ? { inheritedReviewHead: head } : {}),
  };
}
