// PLAN-model-intelligence-router-2026-07-10 · Part B / Phase B2 —
// Auto-route bridge: ties the content classifier (`task-router.ts`) to the
// tier ladder (`llm-tier-map.ts`) so one call turns a raw input into a
// concrete model override.
//
// This is the seam call-sites use. It stays PURE + injectable: the caller
// supplies the active provider, the optional classifier `runLlm`, and the
// enable gate. It never reads global config or calls an LLM itself — that
// keeps it unit-testable and lets the runner own the streamLLM wiring.
//
// Contract (PLAN §3.1): returns `null` — meaning "no override, keep the
// caller's default" — whenever routing is disabled. The caller is ALSO
// responsible for not invoking this when the model is explicitly pinned;
// see the runner gate. When enabled it returns a concrete model +
// reasoningLevel drawn from the chosen tier.

import type { LLMProviderName } from '../user-config/types.js';
import { lookupLlmTierSpec } from './llm-tier-map.js';
import { adjustTier, detectNuanceDelta } from './nuance-adjust.js';
import type { LlmRunner } from './preset-suggest-llm.js';
import { routeTier, type RouteTierOpts, type RouterInput, type TierRouteSource } from './task-router.js';
import type { ModelTier } from './types.js';
import type { ReasoningLevel } from '../user-config/types.js';

export interface AutoRouteDeps {
  /** Active provider — the tier ladder is provider-specific. */
  provider: LLMProviderName;
  /** Optional classifier LLM for the hybrid escalation. Omit for
   *  heuristic-only routing (zero per-turn LLM cost). */
  runLlm?: LlmRunner;
}

export interface AutoRouteResult {
  /** Concrete model id to use as `modelOverride`. */
  model: string;
  /** Reasoning level the tier prefers (may be undefined). */
  reasoningLevel?: ReasoningLevel;
  tier: ModelTier;
  source: TierRouteSource;
  rationale: string;
}

export interface ResolveAutoRouteOpts extends RouteTierOpts {
  /** Master gate. When false/omitted the bridge is a no-op (returns
   *  null). The runner reads `cfg.llm.autoRoute.enabled` into this. */
  enabled?: boolean;
  /** Phase B3 — apply the inline user-nuance tier nudge ("신중히" bumps
   *  up, "대충 빨리" drops down) on top of the content tier. */
  applyNuance?: boolean;
}

/** Resolve an input to a concrete model override, or `null` when routing
 *  is disabled. Never throws — a classifier failure degrades to the
 *  heuristic tier inside `routeTier`. */
export async function resolveAutoRoute(
  input: RouterInput,
  deps: AutoRouteDeps,
  opts: ResolveAutoRouteOpts = {},
): Promise<AutoRouteResult | null> {
  if (!opts.enabled) return null;
  const route = await routeTier(input, deps.runLlm, opts);
  let tier = route.tier;
  let rationale = route.rationale;
  if (opts.applyNuance) {
    const nuance = detectNuanceDelta(input.text);
    if (nuance.delta !== 0) {
      const adjusted = adjustTier(tier, nuance.delta);
      if (adjusted !== tier) {
        rationale = `${rationale} · nuance ${nuance.delta > 0 ? '+' : ''}${nuance.delta} (${nuance.matched.join(',')})`;
        tier = adjusted;
      }
    }
  }
  const spec = lookupLlmTierSpec(deps.provider, tier);
  return {
    model: spec.model,
    reasoningLevel: spec.reasoningLevel,
    tier,
    source: route.source,
    rationale,
  };
}
