import { readJourneyEdge, recordJourneyEdge } from '../self-dev/graph-journey-route.js';
import { debug } from '../debug/log.js';

/** Observed `pr land` refusal reasons. Classification never retries a landing. */
export type PrLandRefusal = 'draft' | 'head-branch' | 'not-ancestor' | 'review-missing'
  | 'gate-host-busy' | 'gate-merge-conflict' | 'gate-touch-clean'
  | 'pr-base-unreadable' | 'public-export-leak' | 'other';

export function classifyPrLandRefusal(message: string, context: { isDraft?: boolean } = {}): PrLandRefusal {
  if (context.isDraft === true && message.startsWith('✗ expected-head: PR OPEN non-draft')) return 'draft';
  if (message.startsWith('✗ branch: PR head branch와 현재 브랜치가 다릅니다.')) return 'head-branch';
  if (message.startsWith('✗ ancestor-auto: ancestor-auto-not-ancestor:')) return 'not-ancestor';
  if (/^✗ (?:ancestor-auto|overlap-evidence): (?:review-missing|review-not-reviewed|review-error|review-no-result|review-unreadable|review-pr-mismatch|review-head-mismatch|review-path-not-for-this-pr-head|review-verdict-null|review-must-fix-unknown)(?:\b|$)/.test(message)) return 'review-missing';
  if (message.startsWith('✗ heavy-remote: PR base=unreadable ≠ main')) return 'pr-base-unreadable';
  if (/^✗ heavy-remote: (?:원격|병합 직전 원격|[a-z][a-z0-9-]*) 게이트 gate-host-busy(?:\b|\s|$)/.test(message)) return 'gate-host-busy';
  if (message.startsWith('✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stdout: CONFLICT (content): Merge conflict')) return 'gate-merge-conflict';
  if (message.startsWith('✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stderr: 건드린 src/scripts 파일과 baseline 밖 test 파일은 tsc 클린이어야 합니다(touch-clean).')) return 'gate-touch-clean';
  if (message.startsWith('✗ public-export-leak: 바뀐 파일')) return 'public-export-leak';
  return 'other';
}

/** Direct landing failures are observed only when today's refusal shape is recognized. */
export function observeDirectPrLandRefusal(message: string): void {
  if (classifyPrLandRefusal(message) === 'other') return;
  observePrLandRefusal(message);
}

/** Read the declared recovery edge and observe the refusal. No recovery command runs here. */
export function observePrLandRefusal(message: string, context: { isDraft?: boolean } = {}): void {
  try {
    const route = readJourneyEdge('merge', classifyPrLandRefusal(message, context));
    if (route.to !== null) recordJourneyEdge(route, route.to, 'pr-land-refused; recovery-execution=none');
    else debug.log('self-implement', 'graph-edge-unresolved', { from: 'merge', label: route.label, reason: 'pr-land-refused; recovery-execution=none' });
  } catch { /* An observation failure must never change the landing refusal. */ }
}
