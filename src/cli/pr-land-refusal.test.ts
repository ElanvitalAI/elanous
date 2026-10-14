import { expect, test } from 'bun:test';
import { classifyPrLandRefusal, observePrLandRefusal } from './pr-land-refusal.js';
import { readJourneyEdge } from '../self-dev/graph-journey-route.js';
import { debug } from '../debug/log.js';

// Captured `pr land` refusal lines from #26614, #26968, #27026, #27063, #27081 and #27113.
const cases = [
  ['✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required', { isDraft: true }, 'draft', 'ready'],
  ['✗ branch: PR head branch와 현재 브랜치가 다릅니다.', {}, 'head-branch', 'pr-head-checkout'],
  ['✗ ancestor-auto: ancestor-auto-not-ancestor: 123 is not an ancestor of 456', {}, 'not-ancestor', 'main-sync'],
  ['✗ ancestor-auto: review-not-reviewed', {}, 'review-missing', 'review'],
  ['✗ overlap-evidence: review-path-not-for-this-pr-head', {}, 'review-missing', 'review'],
  ['✗ ancestor-auto: review-must-fix-1', {}, 'other', 'next-move'],
] as const;

for (const [line, context, label, destination] of cases) {
  test(`real refusal ${label} routes to ${destination}`, () => {
    expect(classifyPrLandRefusal(line, context)).toBe(label);
    const route = readJourneyEdge('merge', label);
    expect(route.source).toBe('graph');
    expect(route.on).toBe('refusal');
    expect(route.to).toBe(destination);
  });
}

test('generic pinned preflight without draft evidence does not claim draft', () => {
  expect(classifyPrLandRefusal(cases[0][0])).toBe('other');
});

test('observed refusal emits one graph edge with recovery execution deferred', () => {
  const rows: { event: string; data?: unknown }[] = [];
  const off = debug.registerSink({ name: 'pr-land-refusal-test', emit: (row) => {
    if (row.event === 'graph-edge-taken') rows.push(row);
  } });
  try {
    observePrLandRefusal(cases[2][0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: {
      from: 'merge', on: 'refusal', label: 'not-ancestor', to: 'main-sync',
      taken: 'main-sync', reason: 'pr-land-refused; recovery-execution=none',
    } });
  } finally { off(); }
});
