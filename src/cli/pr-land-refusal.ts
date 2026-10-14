import { readJourneyEdge, recordJourneyEdge } from '../self-dev/graph-journey-route.js';
import { debug } from '../debug/log.js';

/** The five outcomes of an observed `pr land` refusal. This function never retries a landing. */
export type PrLandRefusal = 'draft' | 'head-branch' | 'not-ancestor' | 'review-missing' | 'other';

export function classifyPrLandRefusal(message: string, context: { isDraft?: boolean } = {}): PrLandRefusal {
  if (context.isDraft === true && message.startsWith('✗ expected-head: PR OPEN non-draft')) return 'draft';
  if (message.startsWith('✗ branch: PR head branch와 현재 브랜치가 다릅니다.')) return 'head-branch';
  if (message.startsWith('✗ ancestor-auto: ancestor-auto-not-ancestor:')) return 'not-ancestor';
  if (/^✗ (?:ancestor-auto|overlap-evidence): (?:review-missing|review-not-reviewed|review-error|review-no-result|review-unreadable|review-pr-mismatch|review-head-mismatch|review-path-not-for-this-pr-head|review-verdict-null|review-must-fix-unknown)(?:\b|$)/.test(message)) return 'review-missing';
  return 'other';
}

/** Read the declared recovery edge and observe the refusal. No recovery command runs here. */
export function observePrLandRefusal(message: string, context: { isDraft?: boolean } = {}): void {
  const route = readJourneyEdge('merge', classifyPrLandRefusal(message, context));
  if (route.to !== null) recordJourneyEdge(route, route.to, 'pr-land-refused; recovery-execution=none');
  else debug.log('self-implement', 'graph-edge-unresolved', { from: 'merge', label: route.label, reason: 'pr-land-refused; recovery-execution=none' });
}
