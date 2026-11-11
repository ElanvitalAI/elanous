import { describe, expect, test } from 'bun:test';
import {
  assertRealTargetGuards,
  assertScenarioTargetAllowed,
  assertScenarioReceiptJsonSafe,
  resolveScenarioTarget,
  validateRealScenarioGuards,
  type ScenarioRealBudget,
} from './scenario-target.js';

const ONE_BUDGET_COUNT = 1; // Source: A2 budget tests reserve one operation at a time.

function realGuards(overrides: Partial<{
  allowWrites: readonly string[];
  budget: ScenarioRealBudget;
  syntheticMarker: boolean;
  stopFile: string;
  targets: readonly string[];
}> = {}) {
  return {
    budget: { llmCalls: ONE_BUDGET_COUNT, wallClockMs: 1_000, externalWrites: ONE_BUDGET_COUNT }, // Source: one isolated contract operation and one-second test budget.
    syntheticMarker: true,
    stopFile: '/test/world/stop',
    ...overrides,
  };
}

describe('SIM-SCENARIO-TARGET contract (stage one)', () => {
  test('defaults to sim, honors scenario target, then lets an explicit CLI target win', () => {
    expect(resolveScenarioTarget()).toEqual({ target: 'sim', source: 'default' });
    expect(resolveScenarioTarget('real')).toEqual({ target: 'real', source: 'scenario' });
    expect(resolveScenarioTarget('real', 'sim')).toEqual({ target: 'sim', source: 'cli' });
    expect(() => resolveScenarioTarget('other')).toThrow('invalid scenario target');
  });

  test('real requires an explicit test-universe root before execution', () => {
    expect(() => assertScenarioTargetAllowed('real')).toThrow('explicit --test universe');
    expect(() => assertScenarioTargetAllowed('real', '   ')).toThrow('explicit --test universe');
    expect(() => assertScenarioTargetAllowed('sim')).not.toThrow();
    expect(() => assertScenarioTargetAllowed('real', '/tmp/isolated-test-root')).not.toThrow();
  });

  test('real target requires all four guards and defaults its write allow-list to empty', () => {
    expect(() => validateRealScenarioGuards(undefined)).toThrow('all four safety guard declarations');
    expect(validateRealScenarioGuards(realGuards())).toMatchObject({
      allowWrites: [],
      budget: { llmCalls: ONE_BUDGET_COUNT, externalWrites: ONE_BUDGET_COUNT },
      syntheticMarker: true,
      stopFile: '/test/world/stop',
      targets: [],
    });
    expect(assertRealTargetGuards({ target: 'sim' })).toBeUndefined();
    expect(assertRealTargetGuards({ target: 'real', real: realGuards() })?.syntheticMarker).toBe(true);
    expect(() => assertRealTargetGuards({ target: 'sim' }, 'real')).toThrow('all four safety guard declarations');
  });

  test('rejects malformed budgets, missing safeguards, unknown guard keys, and bad names', () => {
    expect(() => validateRealScenarioGuards(realGuards({ budget: {
      llmCalls: 0.5, // Source: budgets count discrete calls and therefore must be integers.
      wallClockMs: 1_000,
      externalWrites: ONE_BUDGET_COUNT,
    } }))).toThrow('non-negative safe integers');
    expect(() => validateRealScenarioGuards(realGuards({ syntheticMarker: false }))).toThrow('syntheticMarker must be true');
    expect(() => validateRealScenarioGuards(realGuards({ stopFile: ' ' }))).toThrow('stop-file path');
    expect(() => validateRealScenarioGuards({ ...realGuards(), unexpected: true } as never)).toThrow('not a supported guard');
    expect(() => validateRealScenarioGuards(realGuards({ allowWrites: [''] }))).toThrow('non-empty names');
    expect(() => validateRealScenarioGuards(realGuards({ allowWrites: Array(1) as string[] }))).toThrow('dense list');
    expect(() => validateRealScenarioGuards(realGuards({ targets: Array(1) as string[] }))).toThrow('dense list');
  });

  test('receipt values reject JSON serialization collisions and cycles', () => {
    expect(() => assertScenarioReceiptJsonSafe({ steps: [{ result: { x: undefined } }] })).toThrow('only JSON values');
    expect(() => assertScenarioReceiptJsonSafe({ steps: [Number.NaN] })).toThrow('finite JSON numbers');
    expect(() => assertScenarioReceiptJsonSafe(-0)).toThrow('negative zero');
    expect(() => assertScenarioReceiptJsonSafe({ steps: [{ result: null }] })).not.toThrow();
    const circular: { next?: unknown } = {};
    circular.next = circular;
    expect(() => assertScenarioReceiptJsonSafe(circular)).toThrow('circular references');
    const symbolKey = { value: true, [Symbol('hidden')]: 'lost by JSON' };
    expect(() => assertScenarioReceiptJsonSafe(symbolKey)).toThrow('symbol keys');
    const hidden = {};
    Object.defineProperty(hidden, 'value', { value: true });
    expect(() => assertScenarioReceiptJsonSafe(hidden)).toThrow('enumerable data property');
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => true });
    expect(() => assertScenarioReceiptJsonSafe(accessor)).toThrow('enumerable data property');
    const customArray = Object.assign([true], { extra: false });
    expect(() => assertScenarioReceiptJsonSafe(customArray)).toThrow('custom array properties');
    const toJson = { value: true, toJSON: () => false };
    expect(() => assertScenarioReceiptJsonSafe(toJson)).toThrow('only JSON values');
  });
});
