import { expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { BudgetInputs } from '../self-implement/budget-gate.js';
import { budgetInputsWithLiveSupply } from './budget-consumer.js';
import { SUPPLY_AXES, type LiveSupplySnapshot } from './snapshot.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const direct = {
  preference: { chain: [{ provider: 'openai-codex' }], budgetGate: { onShortfall: 'stop' } } as unknown as BudgetInputs['preference'],
  codexCandidates: [
    { name: 'primary', usedPercent: 20, creditBalance: 3 },
    { name: 'second', usedPercent: 70 },
  ],
  grokUsedPercent: 30,
  maxUsedPercent: { 'openai-codex': 95, grok: 80 },
} satisfies BudgetInputs;

function sample(): LiveSupplySnapshot {
  return {
    version: 1, sequence: 7,
    observedAt: '2026-10-26T11:59:00.000Z', expiresAt: '2026-10-26T12:01:00.000Z',
    sources: Object.fromEntries(SUPPLY_AXES.map(axis => [axis, {
      status: 'unknown', observedAt: null, reason: 'unmeasured',
    }])) as LiveSupplySnapshot['sources'],
    values: {},
  };
}

test('fresh negative account and Grok facts narrow a new child decision without changing credit policy', () => {
  const snapshot = sample();
  snapshot.sources.codex = { status: 'measured', observedAt: snapshot.observedAt, reason: null };
  snapshot.sources.grok = { status: 'measured', observedAt: snapshot.observedAt, reason: null };
  snapshot.values.codex = { accounts: [
    { name: 'primary', usedPercent: 96, signalAt: snapshot.observedAt, available: false },
    { name: 'second', usedPercent: 10, signalAt: snapshot.observedAt, available: true },
  ] };
  snapshot.values.grok = { quota: 'exhausted', observedAt: snapshot.observedAt };
  const result = budgetInputsWithLiveSupply(direct, snapshot, NOW);
  expect(result.codexCandidates).toEqual([
    { name: 'primary', usedPercent: 96, creditBalance: 3, reached: true },
    { name: 'second', usedPercent: 70 },
  ]);
  expect(result.grokUsedPercent).toBe(100);
  expect(result.preference).toBe(direct.preference);
  expect(result.maxUsedPercent).toBe(direct.maxUsedPercent);
});

test('expired and unmeasured sources keep the direct policy inputs', () => {
  const expired = sample();
  expired.expiresAt = '2026-10-26T11:59:59.000Z';
  expired.sources.grok = { status: 'measured', observedAt: expired.observedAt, reason: null };
  expired.values.grok = { quota: 'exhausted', observedAt: expired.observedAt };
  expect(budgetInputsWithLiveSupply(direct, expired, NOW)).toBe(direct);
  expect(budgetInputsWithLiveSupply(direct, sample(), NOW)).toBe(direct);
});

test('unmatched or invalid Codex samples and unknown Grok quota fall back with axis reasons', () => {
  const observations: Array<{ event: string; data?: unknown }> = [];
  const originalLog = debug.log;
  debug.log = ((category, event, data) => {
    if (category === 'live-supply') observations.push({ event, data });
  }) as typeof debug.log;
  try {
    const unmatched = sample();
    unmatched.sources.codex = { status: 'measured', observedAt: unmatched.observedAt, reason: null };
    unmatched.sources.grok = { status: 'measured', observedAt: unmatched.observedAt, reason: null };
    unmatched.values.codex = { accounts: [{ name: 'other-account', usedPercent: 99, signalAt: unmatched.observedAt, available: false }] };
    unmatched.values.grok = { quota: 'unknown', observedAt: unmatched.observedAt };
    expect(budgetInputsWithLiveSupply(direct, unmatched, NOW)).toEqual(direct);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'snapshot-fallback', data: expect.objectContaining({ axis: 'codex', reason: 'no-matching-account' }) }),
      expect.objectContaining({ event: 'snapshot-fallback', data: expect.objectContaining({ axis: 'grok', reason: 'quota-unknown' }) }),
    ]));
    expect(observations.some(row => row.event === 'snapshot-consumed')).toBe(false);

    observations.length = 0;
    const invalid = sample();
    invalid.sources.codex = { status: 'measured', observedAt: invalid.observedAt, reason: null };
    invalid.values.codex = { accounts: [{ name: 'primary', usedPercent: 101, signalAt: invalid.observedAt, available: null as unknown as boolean }] };
    expect(budgetInputsWithLiveSupply(direct, invalid, NOW)).toEqual(direct);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'snapshot-fallback', data: expect.objectContaining({ axis: 'codex', reason: 'invalid-account' }) }),
    ]));
    expect(observations.some(row => row.event === 'snapshot-consumed'
      && typeof row.data === 'object' && row.data !== null && 'axis' in row.data && row.data.axis === 'codex')).toBe(false);
  } finally { debug.log = originalLog; }
});
