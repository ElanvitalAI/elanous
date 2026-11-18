import { describe, expect, test } from 'bun:test';
import { approvalHold, isApprovalHold, normalizeApproval, shellQuote } from './approval-outcome.js';

describe('approval outcome', () => {
  test('only declined is a refusal; the rest hold the node', () => {
    expect(isApprovalHold({ approved: false, reason: 'declined' })).toBe(false);
    expect(isApprovalHold({ approved: true })).toBe(false);
    for (const reason of ['timeout', 'turn-cancelled', 'host-cancelled', 'unavailable'] as const)
      expect(isApprovalHold({ approved: false, reason })).toBe(true);
  });

  test('a plain boolean keeps its old meaning: false is a refusal', () => {
    expect(normalizeApproval(false)).toEqual({ approved: false, reason: 'declined' });
    expect(normalizeApproval(true)).toEqual({ approved: true });
  });

  test('the resume command quotes a path with spaces and is left out when the path is unknown', () => {
    const known = approvalHold({ graphId: 'g', runId: 'run-1', graphPath: "/tmp/my graphs/it's.yaml" }, 'review-publish', 'timeout');
    expect(known.resume).toBe("eln graph run '/tmp/my graphs/it'\\''s.yaml' --resume run-1");
    expect(known.decide).toBe('eln graph approve g run-1   (add --reject to refuse)');
    expect(approvalHold({ graphId: 'g', runId: 'run-1' }, 'review-publish', 'timeout').resume).toBeUndefined();
    expect(shellQuote('/plain/path.yaml')).toBe('/plain/path.yaml');
  });
});
