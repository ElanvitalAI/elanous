import type { GoalType } from '../self-implement/goal-author.js';
import type { PodMemoryTier } from '../task-orchestrator/surfaces/self-implement-pod.js';

export type PodMemorySelectionReason = 'explicit-option' | 'goal-type-default' | 'existing-tier';

/** Select the harness Pod tier without discarding the existing implementation/operate decision. */
export function selectPodMemoryTier(
  goalType: GoalType,
  explicitPodMemory: PodMemoryTier | undefined,
  existingTier: PodMemoryTier = 'standard',
): { tier: PodMemoryTier; reason: PodMemorySelectionReason } {
  if (explicitPodMemory !== undefined) return { tier: explicitPodMemory, reason: 'explicit-option' };
  if (goalType === 'research' || goalType === 'document') return { tier: 'lite', reason: 'goal-type-default' };
  return { tier: existingTier, reason: 'existing-tier' };
}
