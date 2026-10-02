// ── TUI TRUE-execution badge (self-cognition §1) ──────────────────────
//
// Resolves the compact engine/model badge for the dashboard chat
// completion line — `✔ 완료 (19s · ↓ 200 tokens · 🧠 terra(high))`.
// The value is the model that ACTUALLY ran this turn (from the route
// decision recorded in the ACP bridge's getActiveModel), not the config
// original — so the "config=opus but codex/terra ran" illusion is
// visible at a glance (#3 badge · #4 opus-respect surfaced, not silenced).
//
// TUI-surface presentation leaf — home = src/tui/chat/ (RFC §6b · M2).
// Moved out of dashboard/ (표면-중립 분해): the badge is pure TUI chat
// completion-line presentation. dashboard/execution-badge.ts is now a
// re-export shim for backward compat until callers migrate.

import { currentRouteDecision } from '../../llm/route-decision.js';
import { getUserConfig } from '../../user-config.js';
import { effectiveReasoningLevel, modelSupportsReasoning } from '../../llm.js';
import { executionBadge } from '../../telegram-exec-footer.js';

/** The compact self-turn execution badge for the dashboard surface, or
 *  undefined when no model can be resolved. Reads the per-turn route
 *  decision recorded during the turn (getActiveModel) and enriches it
 *  with the effective reasoning effort via the same path the telegram
 *  execution footer uses, so both surfaces report the same truth. */
export function resolveDashboardExecutionBadge(): string | undefined {
  const cfg = getUserConfig();
  const decision = currentRouteDecision('dashboard');
  const model = decision?.model || cfg.llm.model;
  if (!model) return undefined;
  const effort = decision?.effort
    ?? (modelSupportsReasoning(cfg.llm.provider, model)
      ? effectiveReasoningLevel(cfg.llm, cfg.llm.provider, model)
      : undefined);
  return executionBadge({ model, ...(effort ? { effort } : {}) });
}
