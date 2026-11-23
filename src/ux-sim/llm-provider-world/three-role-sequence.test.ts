import { expect, test } from 'bun:test';
import { runThreeRoleSequence } from './three-role-sequence.js';

// OP completion boundary: each role is checked at every injected stage, not just the decision helper.
test('synthetic hand, TA and review progress default → team → explicitly allowed credit → reset', async () => {
  const result = await runThreeRoleSequence(true);
  for (const role of ['hand-seat', 'ta-child', 'review']) {
    expect(result.rows.filter(row => row.role === role).map(row => [row.stage, row.row, row.status])).toEqual([
      ['default', 'codex-default', 'ok'], ['team', 'codex-team', 'ok'], ['credit', 'openrouter', 'ok'], ['reset', 'codex-default', 'ok'],
    ]);
  }
  expect(result.tags).toHaveLength(12);
  expect(result.ledger.some(row => row.action === 'switch' && row.to === 'codex-team')).toBe(true);
  expect(result.ledger.some(row => row.action === 'switch' && row.to === 'openrouter')).toBe(true);
  expect(result.ledger.some(row => row.action === 'return' && row.to === 'codex-default')).toBe(true);
});

test('TA without credit permission stops on exhausted subscriptions and resumes after reset', async () => {
  const result = await runThreeRoleSequence(false);
  expect(result.rows.filter(row => row.role === 'ta-child').map(row => [row.stage, row.row, row.status])).toEqual([
    ['default', 'codex-default', 'ok'], ['team', 'codex-team', 'ok'], ['credit', 'stop', 'stop'], ['reset', 'codex-default', 'ok'],
  ]);
  expect(result.rows.filter(row => row.stage === 'credit' && row.role !== 'ta-child').every(row => row.row === 'openrouter' && row.status === 'ok')).toBe(true);
});
