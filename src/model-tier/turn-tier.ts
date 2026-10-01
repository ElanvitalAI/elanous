import type { UserConfig } from '../user-config.js';
import { resolveLlmTier, type LlmTierSource } from './tier-resolver.js';
import type { ModelTier } from './types.js';
import type { ReasoningLevel } from '../user-config.js';

export type TurnReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
const REASONING_EFFORT: Record<ReasoningLevel, TurnReasoningEffort> = { off: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };

/** Only a person's explicit LLM choice changes a chat turn's model. */
export function explicitTurnTier(
  cfg: UserConfig,
  sessionId: string,
): { model: string; tier: ModelTier; source: LlmTierSource; reasoningEffort?: TurnReasoningEffort } | undefined {
  try {
    const resolved = resolveLlmTier(cfg.modelTier, cfg.llm.provider, { sessionId });
    if (resolved.source !== 'session-override' && resolved.source !== 'user-config-surface') return undefined;
    // On codex the balanced·better·best tiers share one model and differ only in reasoning level (low·medium·high),
    // so carrying the model alone left the slider a no-op there (10-01 live).
    const reasoningEffort = resolved.reasoningLevel ? REASONING_EFFORT[resolved.reasoningLevel] : undefined;
    return { model: resolved.model, tier: resolved.tier, source: resolved.source, ...(reasoningEffort ? { reasoningEffort } : {}) };
  } catch {
    return undefined;
  }
}
