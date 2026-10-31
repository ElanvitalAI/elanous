import { expect, test } from 'bun:test';
import { measureRepairOutcomes, measureRepairTierModels } from './repair-outcomes.js';
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

test('groups repair attempts in a half-open 24h window and lists only evidenced Sol calls', () => {
  const card = { id: 'ta-tier', tier: '특', history: [
    { at: '2026-10-21T13:00:01Z', event: 'harness.role-llm', runId: 'sol-in' },
    { at: '2026-10-21T13:00:02Z', event: 'repair-result', runId: 'glm-in', effect: 'failed' },
  ], repairs: [
    { at: '2026-10-21T12:59:59Z', runId: 'sol-before', toModel: 'openai-codex/gpt-6-sol', status: 'applied' },
    { at: '2026-10-21T13:00:00Z', runId: 'sol-in', toModel: 'openai-codex/gpt-6-sol', status: 'requested' },
    { at: '2026-10-21T13:00:01Z', runId: 'glm-in', toModel: 'openrouter/z-ai/glm-5.3', status: 'failed' },
    { at: '2026-10-21T14:00:00Z', runId: 'sol-after', toModel: 'openai-codex/gpt-6-sol', status: 'applied' },
  ] } as unknown as TaskCard;
  const lowTier = { ...card, id: 'ta-low', tier: '하', history: [], repairs: [
    { at: '2026-10-21T13:20:00Z', runId: 'sol-unseen', toModel: 'openai-codex/gpt-6-sol', status: 'failed' },
  ] } as unknown as TaskCard;
  const measured = measureRepairTierModels([card, lowTier], {
    since: Date.parse('2026-10-21T13:00:00Z'), until: Date.parse('2026-10-21T14:00:00Z'),
  });
  expect(measured).toMatchObject({
    samples: 3,
    measured: true,
    solCalls: [{ card: 'ta-tier', runId: 'sol-in', tier: '특', model: 'openai-codex/gpt-6-sol' }],
    solCallUnmeasured: [{ card: 'ta-low', runId: 'sol-unseen', tier: '하', model: 'openai-codex/gpt-6-sol' }],
  });
  expect(measured.byTierModel).toContainEqual({ tier: '특', model: 'openai-codex/gpt-6-sol', n: 1, measured: true, observedN: 1 });
  expect(measured.byTierModel).toContainEqual({ tier: '특', model: 'openrouter/z-ai/glm-5.3', n: 1, measured: true, observedN: 1 });
  expect(measured.byTierModel).toContainEqual({ tier: '중', model: 'openai-codex/gpt-6-sol', n: null, measured: false, observedN: 0 });
  const empty = measureRepairTierModels([], { since: 0, until: 1 });
  expect(empty).toMatchObject({ samples: 0, measured: false, unmeasuredReason: 'no repair attempts in the requested window' });
  expect(empty.byTierModel).toHaveLength(4);
  expect(empty.byTierModel.every((row) => row.n === null && !row.measured && row.observedN === 0)).toBe(true);
});
