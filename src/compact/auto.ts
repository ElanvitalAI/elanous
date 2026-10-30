import { resolveModelContextWindow } from '../models/context-window.js';
import { estimateMessagesTokens, type MessageLike } from '../tokens.js';
import type { ChatAutoCompactConfig } from '../user-config.js';

export interface AutoCompactDecision {
  fire: boolean;
  reason: string;
  usedTokens: number;
  maxTokens: number;
  windowTokens: number;
  budgetTokens?: number;
  ratio: number;
  preserveLastN: number;
  partial: boolean;
}

function inferContextWindow(modelId: string | undefined): number {
  const m = (modelId ?? '').toLowerCase();
  if (!m) return 32_000;
  if (m.includes('claude')) return 200_000;
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('gpt-4') || m.includes('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return 128_000;
  }
  if (m.includes('grok')) return 128_000;
  if (m.startsWith('local:')) return 32_000;
  return 32_000;
}

export function shouldAutoCompact(
  messages: MessageLike[],
  modelId: string | undefined,
  config: ChatAutoCompactConfig,
  observedInputTokens?: number,
): AutoCompactDecision {
  const hasObservedInputTokens = typeof observedInputTokens === 'number'
    && Number.isFinite(observedInputTokens)
    && observedInputTokens >= 0;
  const estimatedTokens = estimateMessagesTokens(messages);
  // Provider usage captures model/tokenizer overhead; current history also
  // includes tool output appended since that provider response.
  const usedTokens = hasObservedInputTokens ? Math.max(observedInputTokens, estimatedTokens) : estimatedTokens;
  const windowTokens = resolveModelContextWindow(modelId) ?? inferContextWindow(modelId);
  const configuredBudget = config.workingBudgetTokens;
  const budgetTokens = typeof configuredBudget === 'number'
    && Number.isInteger(configuredBudget)
    && configuredBudget > 0
    ? configuredBudget
    : undefined;
  const maxTokens = budgetTokens === undefined ? windowTokens : Math.min(windowTokens, budgetTokens);
  const ratio = maxTokens > 0 ? usedTokens / maxTokens : 0;
  const decision = {
    usedTokens,
    maxTokens,
    windowTokens,
    budgetTokens,
    ratio,
    preserveLastN: config.preserveLastN,
    partial: config.partial,
  };
  if (!config.enabled) return { fire: false, reason: 'disabled', ...decision };
  if (ratio < config.triggerRatio) return { fire: false, reason: 'under-threshold', ...decision };
  return { fire: true, reason: 'threshold-exceeded', ...decision };
}
