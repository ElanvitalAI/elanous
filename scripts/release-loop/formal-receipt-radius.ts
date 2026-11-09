import { testsReachingChangedForGateReuse, type ClosureTree } from './gate-closure.js';

export interface FormalReceiptRadiusFallback {
  readonly priorCommit: string;
  readonly files: string[];
  readonly priorFailures: string[];
  readonly priorErrors: string[];
}

export interface FormalReceiptRadiusDecision {
  readonly fallback: FormalReceiptRadiusFallback | null;
  readonly reason: 'formal-receipt-radius-proven' | 'formal-receipt-no-consumers' | string;
}

/** The production consumer used when formal shard receipts need a measured radius fallback. */
export function selectFormalReceiptRadiusFallback(input: {
  priorCommit: string;
  tree: ClosureTree;
  changed: readonly string[];
  tests: readonly string[];
  priorFailures: readonly string[];
  priorErrors: readonly string[];
}): FormalReceiptRadiusDecision {
  const closure = testsReachingChangedForGateReuse(input.tree, input.changed, input.tests);
  if (!closure.ok) return { fallback: null, reason: 'formal-receipt-radius-opaque:' + closure.reason };
  if (!closure.tests.length) return { fallback: null, reason: 'formal-receipt-no-consumers' };
  return {
    fallback: { priorCommit: input.priorCommit, files: closure.tests,
      priorFailures: [...input.priorFailures], priorErrors: [...input.priorErrors] },
    reason: 'formal-receipt-radius-proven',
  };
}
