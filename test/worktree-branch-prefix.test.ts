import { expect, test } from 'bun:test';
import { WORKTREE_BRANCH_PREFIX, plannedSelfImplBranch } from '../src/harness/worktree-branch-prefix.js';

test('planned self-implement branch uses the shared disposable prefix', () => {
  expect(WORKTREE_BRANCH_PREFIX).toBe('self-impl/');
  expect(plannedSelfImplBranch('fixture goal').startsWith(WORKTREE_BRANCH_PREFIX)).toBe(true);
});
