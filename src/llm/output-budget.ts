import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import { resolveModelContextWindow } from '../models/context-window.js';
import type { ModelRole } from '../user-config/types.js';

/** A request default, not a hard cap. Explicit callers retain their chosen value. */
export function resolveRequestMaxTokens(model: string, role: ModelRole | undefined, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  // Source: LLM-MAXTOKENS-STOPREASON OP completion line; long design/implementation answers need more than the measured 2048 default.
  const roleBudget = role === 'classify' ? 2_048 : role === 'review' ? 8_192
    : role === 'planning' || role === 'research' || role === 'audit' ? 12_288 : 16_384;
  const catalog = BUILTIN_CATALOG.models.find(entry => entry.id === model || `openrouter/${entry.id}` === model);
  const context = resolveModelContextWindow(model);
  // Source: the existing model catalog's reservedOutputTokens and contextWindow; unknown models retain the 8192 fallback.
  const catalogLimit = catalog?.reservedOutputTokens ?? Number.POSITIVE_INFINITY;
  const contextLimit = context ? Math.floor(context / 8) : Number.POSITIVE_INFINITY;
  const modelBudget = Number.isFinite(catalogLimit) || Number.isFinite(contextLimit)
    ? Math.min(catalogLimit, contextLimit) : 8_192;
  return Math.max(1, Math.min(roleBudget, modelBudget));
}
