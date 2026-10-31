import { describe, expect, test } from 'bun:test';
import { assessDraftInventory, buildDraftInventory } from './draft-inventory-builder.js';

describe('draft inventory simulation', () => {
  test('builds a deterministic 200-case inventory and exercises both production draft triage functions', () => {
    const inventory = buildDraftInventory();
    const assessment = assessDraftInventory(inventory);

    expect(inventory).toHaveLength(200);
    expect(assessment.total).toBe(200);
    expect(assessment.byScenario).toEqual({
      'merged-twin': 25,
      'duplicate-open': 25,
      'harvest-reference': 25,
      'all-files-landed': 25,
      'protected-label': 25,
      running: 25,
      stale: 25,
      harvestable: 25,
    });
    expect(assessment.byAction).toEqual({ close: 125, keep: 75 });
    expect(assessment.triageByAction).toEqual({ 'close-a': 0, 'close-b': 75, 'close-c': 25, harvest: 25, human: 75 });
    expect(assessment.mismatches).toEqual([]);
    expect(assessment.protectedOrRunningClosed).toBe(0);
    expect(assessDraftInventory(buildDraftInventory())).toEqual(assessment);
  });

  test('rejects invalid inventory sizes instead of silently changing the sample', () => {
    expect(() => buildDraftInventory(-1)).toThrow(RangeError);
    expect(() => buildDraftInventory(1.5)).toThrow(RangeError);
  });
});
