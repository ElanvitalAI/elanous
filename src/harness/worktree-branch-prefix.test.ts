import { describe, expect, test } from 'bun:test';
import { branchGoalId, branchLineageSlug } from '../cli/pr-lineage.js';
import { WORKTREE_BRANCH_PREFIX, plannedSelfImplBranch, slugifyFeature } from './worktree-branch-prefix.js';

describe('plannedSelfImplBranch — goal id segment', () => {
  test('without goalId matches the previous self-impl/<slug> byte-for-byte', () => {
    const feature = 'Shared Prefix';
    const previous = `${WORKTREE_BRANCH_PREFIX}${slugifyFeature(feature)}`;
    expect(plannedSelfImplBranch(feature)).toBe(previous);
    expect(plannedSelfImplBranch(feature, undefined)).toBe(previous);
    expect(plannedSelfImplBranch(feature, '')).toBe(previous);
    expect(plannedSelfImplBranch(feature, '   ')).toBe(previous);
  });

  test('with goalId is readable by branchGoalId as the same id', () => {
    const goalId = 'c969c242a28942b0';
    const name = plannedSelfImplBranch('Fix the branch slug collision', goalId);
    expect(name.startsWith(WORKTREE_BRANCH_PREFIX)).toBe(true);
    expect(branchGoalId(name)).toBe(goalId);
  });

  test('omitting the goalid segment is not readable by branchGoalId', () => {
    const feature = 'Fix the branch slug collision';
    const goalId = 'c969c242a28942b0';
    const wrong = `${WORKTREE_BRANCH_PREFIX}${slugifyFeature(feature)}`;
    expect(branchGoalId(wrong)).toBeNull();
    expect(wrong).not.toBe(plannedSelfImplBranch(feature, goalId));
  });

  test('uses the same goalId digest when mutable feature text differs', () => {
    const goalId = '667c0b5f0fa204d6';
    const first = plannedSelfImplBranch('First launch decomposition', goalId);
    const second = plannedSelfImplBranch('Second launch decomposition with different advice', goalId);
    expect(first.slice(-8)).toBe(second.slice(-8));
    expect(first).not.toBe(second);
  });

  test('uses distinct goalId digests for different goals with the same feature', () => {
    const feature = 'Fix the branch slug collision';
    const first = plannedSelfImplBranch(feature, '667c0b5f0fa204d6');
    const second = plannedSelfImplBranch(feature, 'c969c242a28942b0');
    expect(first.slice(-8)).not.toBe(second.slice(-8));
  });

  test('two runs of one goal have distinct names and shared lineage while the legacy name is unchanged', () => {
    const feature = 'Shared Prefix';
    const goalId = '4b852b3a0f863ad2';
    const legacy = plannedSelfImplBranch(feature, goalId);
    const first = plannedSelfImplBranch(feature, goalId, 'run-c41218b4-9383-458c-b944-9f7351062861');
    const second = plannedSelfImplBranch(feature, goalId, 'run-0557cdea-0000-4000-8000-000000000000');
    expect(legacy).toBe(`self-impl/goalid-${goalId}-shared-prefix-0486e54f`);
    expect(first).toBe(`${legacy}-rc41218`);
    expect(second).toBe(`${legacy}-r0557cd`);
    expect(first).not.toBe(second);
    for (const branch of [legacy, first, second]) {
      expect(branchLineageSlug(branch)).toBe(branchLineageSlug(legacy));
      expect(branchGoalId(branch)).toBe(goalId);
    }
  });

  test('run suffix strips run- and separators then lowercases six alphanumerics without a goal id', () => {
    const legacy = plannedSelfImplBranch('Shared Prefix');
    expect(plannedSelfImplBranch('Shared Prefix', undefined, 'run-C4-12_18b4')).toBe(`${legacy}-rc41218`);
    expect(plannedSelfImplBranch('Shared Prefix')).toBe(legacy);
  });

  test('long feature plus goalId keeps readable length and self-impl/ prefix', () => {
    const feature = 'x'.repeat(200);
    const goalId = '667c0b5f0fa204d6';
    const name = plannedSelfImplBranch(feature, goalId);
    const readable = slugifyFeature(feature).replace(/-[0-9a-f]{8}$/, '');
    expect(name.startsWith(WORKTREE_BRANCH_PREFIX)).toBe(true);
    expect(branchGoalId(name)).toBe(goalId);
    expect(readable.length).toBeLessThanOrEqual(40);
    expect(name).toContain(`-${readable}-`);
  });
});
