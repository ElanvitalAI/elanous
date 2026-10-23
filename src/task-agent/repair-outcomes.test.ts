import { expect, test } from 'bun:test';
import { measureRepairOutcomes } from './repair-outcomes.js';
import type { TaskCard } from './task-hand.js';

test('counts repair-result ledger transitions by time rather than rejudge decisions or latest card status', () => {
  const card = { id: 'ta-1', history: [
    { at: '2026-10-21T12:00:00Z', event: 'repair-result', runId: 'r0', effect: 'applied' },
    { at: '2026-10-21T13:00:00Z', event: 'repair-result', runId: 'r1', effect: 'applied' },
    { at: '2026-10-21T13:00:10Z', event: 'repair-result', runId: 'r1', effect: 'failed' },
    { at: '2026-10-21T13:00:20Z', event: 'repair-result', runId: 'r1', effect: 'applied' },
    { at: '2026-10-21T13:01:00Z', event: 'rejudge-on-head', effect: 'repair-applied' },
    { at: '2026-10-21T13:02:00Z', event: 'repair-result', runId: 'r2', effect: 'failed' },
    { at: '2026-10-21T13:03:00Z', event: 'repair-result', runId: 'r4', effect: 'skipped' },
    { at: '2026-10-21T13:02:10Z', event: 'repair-result', effect: 'applied' },
    { at: '2026-10-21T14:00:00Z', event: 'repair-result', runId: 'r3', effect: 'applied' },
  ] } as TaskCard;
  expect(measureRepairOutcomes([card], {
    since: Date.parse('2026-10-21T13:00:00Z'), until: Date.parse('2026-10-21T14:00:00Z'),
  })).toEqual({ applied: 1, failed: 1, unconfirmed: 0, results: 3, cards: 1, missingRunId: 1, unknownEffect: 1 });
});
