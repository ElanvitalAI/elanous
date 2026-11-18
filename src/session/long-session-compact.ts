// ── OP-LONG-SESSION-COMPACT core (trigger-only scope) ──
//
// Root cause (D1): `runTurn` trimmed every request to its input cap (DEFAULT_TOKEN_BUDGET = 24k,
// tokens.ts, unless the caller passes opts.maxTokens) BEFORE anything checked the compaction
// trigger, which is ratio × min(window, workingBudgetTokens) (compact/auto.ts). For any model whose
// threshold lies above the cap the trigger was unreachable: turn-start compaction never fired and the
// oldest rows — the seat instruction first — were dropped silently by the trim.
//
// Fix (this scope only): keep the existing threshold, but never above the request's input cap, so
// the stored session is compacted before the trim would have to cut anything:
//   trigger = min(ratio × min(window, workingBudgetTokens), inputCap)
// The cap, the trim and the session compactor themselves are unchanged.

import { resolveAutoCompactWindow } from '../compact/auto.js';
import type { ChatAutoCompactConfig } from '../user-config/chat.js';

/** Turn-start compaction threshold: the existing one, clamped to the request input cap. */
export function resolveTurnCompactTrigger(
  modelId: string | undefined,
  config: Pick<ChatAutoCompactConfig, 'triggerRatio' | 'workingBudgetTokens'>,
  inputCapTokens: number,
): number {
  const windowTokens = resolveAutoCompactWindow(modelId);
  const budget = config.workingBudgetTokens;
  const workingBudget = typeof budget === 'number' && Number.isInteger(budget) && budget > 0 ? budget : Number.POSITIVE_INFINITY;
  const ratio = Number.isFinite(config.triggerRatio) ? Math.min(1, Math.max(0, config.triggerRatio)) : 1;
  const existingThreshold = Math.floor(ratio * Math.min(windowTokens, workingBudget));
  return Math.max(0, Math.min(existingThreshold, inputCapTokens));
}

interface WireLike { role: string; content: string | unknown[] }

export interface PreservingTrimResult<T> {
  kept: T[];
  dropped: number;
  used: number;
  /** True when even the preserved rows exceed the cap — the caller must fail visibly. */
  overBudget: boolean;
}

/**
 * Trim used after a turn-start compaction: drops the oldest conversation rows first but always keeps
 * every system row (system prompt · summary · pinned), the anchor (first user message) and the most
 * recent user turn (the last user message and everything after it).
 */
export function trimKeepingAnchorAndLatestTurn<T extends WireLike>(
  wire: T[],
  capTokens: number,
  measure: (messages: T[]) => number,
): PreservingTrimResult<T> {
  const firstUser = wire.findIndex(message => message.role === 'user');
  let lastUser = -1;
  for (let i = wire.length - 1; i >= 0 && lastUser < 0; i--) if (wire[i]!.role === 'user') lastUser = i;
  const preserved = (index: number) => wire[index]!.role === 'system' || index === firstUser || (lastUser >= 0 && index >= lastUser);
  const removed = new Set<number>();
  const current = () => wire.filter((_, index) => !removed.has(index));
  let used = measure(wire);
  for (let index = 0; index < wire.length && used > capTokens; index++) {
    if (preserved(index)) continue;
    removed.add(index);
    used = measure(current());
  }
  return { kept: current(), dropped: removed.size, used, overBudget: used > capTokens };
}
