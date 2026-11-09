import { expect, test } from 'bun:test';
import type { TypecheckDriftResult } from '../cli/pr-land-drift-repair.js';
import { simulatePrLandDriftAutorepair } from './pr-land-drift-autorepair-device.js';

const drift: TypecheckDriftResult = {
  verdict: 'drift', receiptBase: 'b'.repeat(40), failBase: 'c'.repeat(40),
  errors: [{ file: 'src/changed.ts', line: 1, column: 1, code: 'TS2304', message: 'changed symbol', symbols: ['ChangedType'], raw: '' }],
  symbols: ['ChangedType'], changedFiles: ['src/changed.ts'],
};
const unrelated: TypecheckDriftResult = { ...drift, verdict: 'drift-unrelated', reason: 'unrelated diagnostic' };
const { receiptBase: _receiptBase, ...withoutReceipt } = drift;
const unmeasured: TypecheckDriftResult = { ...withoutReceipt, verdict: 'drift-unmeasured', reason: 'missing same-head receipt' };
const base = { pr: 71, failedBase: 'c'.repeat(40), output: 'fixture tsc failure', prFiles: ['src/changed.ts'] };

test('PR land drift simulator bounds repair launches and records false positives, misses, and cost', async () => {
  const result = await simulatePrLandDriftAutorepair([
    { ...base, head: '1'.repeat(40), result: drift, mode: 'live', actualDrift: true },
    { ...base, head: '1'.repeat(40), result: drift, mode: 'live', actualDrift: true },
    { ...base, head: '2'.repeat(40), result: drift, mode: 'live', actualDrift: true },
    { ...base, head: '3'.repeat(40), result: drift, mode: 'live', actualDrift: true },
    { ...base, pr: 72, head: '4'.repeat(40), result: unrelated, mode: 'live', actualDrift: false },
    { ...base, pr: 73, head: '5'.repeat(40), result: unmeasured, mode: 'live', actualDrift: true },
    { ...base, pr: 74, head: '6'.repeat(40), result: drift, mode: 'shadow', actualDrift: true },
    { ...base, pr: 75, head: '7'.repeat(40), result: drift, mode: 'off', actualDrift: true },
  ]);

  expect(result.decisions.map(({ plan, allowed }) => [plan.action, allowed])).toEqual([
    ['launch', true], ['escalate', false], ['launch', true], ['escalate', false],
    ['skip', false], ['skip', false], ['launch', false], ['launch', false],
  ]);
  expect(result.launched).toHaveLength(2);
  expect(result.launched.every(({ files }) => files.includes('src/changed.ts'))).toBe(true);
  expect(result.escalated).toHaveLength(2);
  expect(result.falseLaunches).toBe(0);
  expect(result.missedDrifts).toBe(1);
  expect(result.costUnits).toBe(2);
});
