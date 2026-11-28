/**
 * SMART-MERGE ③(c) — the LLM step reuses the existing hunk resolver (src/autopilot/build/llm-conflict-merge.ts
 * `defaultLlmResolve`: hunk-by-hunk prompts, markers checked, sibling-intent) with the model picked by difficulty
 * (src/seat/model-by-difficulty.ts: hot / wide paths → terra, otherwise luna / glm). Runs only in the detached capsule.
 */
import type { LlmResolve } from './conflict-ladder.js';

export function modelForConflict(paths: readonly string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('../seat/model-by-difficulty.js') as typeof import('../seat/model-by-difficulty.js');
  const d = m.cellDifficulty({ cellId: 'SMART-MERGE-CONFLICT', paths });
  const pick = m.pickHandModel(d.tier, () => null);
  return pick.none ? m.TIER_MODEL[d.tier].model : pick.model;
}

/** Default capsule resolver: `defaultLlmResolve` with ELANOUS_CONFLICT_MODEL set for this file's difficulty. */
export function defaultSmartMergeLlm(): LlmResolve {
  return async (path, conflicted, worktree) => {
    const { defaultLlmResolve } = await import('../autopilot/build/llm-conflict-merge.js');
    const prev = process.env.ELANOUS_CONFLICT_MODEL;
    if (!prev) process.env.ELANOUS_CONFLICT_MODEL = modelForConflict([path]);
    try {
      // mode 'on' = MERGE-INTENT-RESOLVE: both sides' commit intents go into the prompt (e.g. «ours restructured tickAgent
      // into TICK_STEPS · theirs added a parked-target filter» → re-apply theirs' small insertions into the moved code).
      return await defaultLlmResolve(path, conflicted, 'origin/main', { ...(worktree ? { worktreePath: worktree } : {}), mode: 'on', mergeConflictAuto: true });
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_CONFLICT_MODEL; else process.env.ELANOUS_CONFLICT_MODEL = prev;
    }
  };
}
