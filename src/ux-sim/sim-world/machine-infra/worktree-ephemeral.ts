// Dry classification only; scenarios never remove a worktree.
import { classifyEphemeralWorktree } from '../../../harness/worktree-ephemeral-policy.js';
import type { EphemeralFacts } from '../../../harness/worktree-ephemeral-policy.js';
import type { SimWorldScenario } from '../types.js';

const facts: EphemeralFacts = {
  ownerKnown: true, trackedClean: true, untrackedAbsent: true, ignoredAbsent: true,
  ptyInactive: true, merged: true, nowMs: 300_000_000, lastActivityMs: 100_000_000,
};

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'WT-EPHEMERAL-ELIGIBLE', title: 'clean merged idle worktree is a dry candidate', devices: [],
    async run(ctx) {
      const result = classifyEphemeralWorktree(facts);
      ctx.recorder.event('worktree-dry-classification', result);
      return result.eligible && result.reasons.length === 0 ? { ok: true }
        : { ok: false, reason: 'eligible-candidate-rejected', diff: JSON.stringify(result) };
    },
  },
  {
    id: 'WT-EPHEMERAL-ACTIVE-PTY', title: 'active PTY excludes a worktree even when otherwise eligible', devices: [],
    async run(ctx) {
      const result = classifyEphemeralWorktree({ ...facts, ptyInactive: false });
      ctx.recorder.event('worktree-dry-classification', result);
      return !result.eligible && result.reasons.length === 1 && result.reasons[0] === 'pty-active-or-unknown' ? { ok: true }
        : { ok: false, reason: 'active-pty-not-excluded', diff: JSON.stringify(result) };
    },
  },
];
