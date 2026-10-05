import { describe, expect, test } from 'bun:test';
import { selectPodMemoryTier } from './pod-memory-policy.js';
import type { GoalType } from '../self-implement/goal-author.js';
import type { PodMemoryTier } from '../task-orchestrator/surfaces/self-implement-pod.js';

describe('harness Pod memory tier policy', () => {
  test.each(['research', 'document'] as const)('%s without --pod-memory defaults to lite', (goalType) => {
    expect(selectPodMemoryTier(goalType, undefined)).toEqual({ tier: 'lite', reason: 'goal-type-default' });
    expect(selectPodMemoryTier(goalType, undefined, 'high')).toEqual({ tier: 'lite', reason: 'goal-type-default' });
  });

  test.each(['implement', 'operate'] as const)('%s without --pod-memory retains the existing tier', (goalType) => {
    expect(selectPodMemoryTier(goalType, undefined)).toEqual({ tier: 'standard', reason: 'existing-tier' });
    expect(selectPodMemoryTier(goalType, undefined, 'high')).toEqual({ tier: 'high', reason: 'existing-tier' });
  });

  test('explicit --pod-memory preserves each tier for every goal type', () => {
    for (const goalType of ['research', 'document', 'implement', 'operate'] as GoalType[]) {
      for (const tier of ['lite', 'standard', 'high'] as PodMemoryTier[]) {
        expect(selectPodMemoryTier(goalType, tier, 'high')).toEqual({ tier, reason: 'explicit-option' });
      }
    }
  });
});
