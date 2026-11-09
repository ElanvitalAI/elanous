// PLAN-model-intelligence-router-2026-07-10 · Part B / Phase B4 —
// Setup-once model resolution (cadence ②).
//
// The router (task-router.ts / auto-route.ts) picks a model PER TURN. This
// module is the ONE-TIME cadence: at setup the user states their intent
// once ("mostly quick chat and light coding") and we resolve a single
// concrete model, then pin it to config. Zero per-turn cost afterwards —
// it behaves exactly like a hand-picked model until the user re-runs it
// (or Part A surfaces a better candidate).
//
// It reuses the SAME classify→tier→model path as the live router
// (`resolveAutoRoute`), so a setup pick and an auto route agree; the only
// differences are (1) it always runs (no enable gate) and (2) an empty
// intent resolves to the balanced default rather than a bulk-cheap guess.

import { resolveAutoRoute, type AutoRouteDeps } from './auto-route.js';
import { lookupLlmTierSpec } from './llm-tier-map.js';
import type { RouteTierOpts } from './task-router.js';
import { DEFAULT_MODEL_TIER, type ModelTier } from './types.js';
import type { ReasoningLevel } from '../user-config/types.js';

export interface SetupModelSuggestion {
  provider: string;
  model: string;
  reasoningLevel?: ReasoningLevel;
  tier: ModelTier;
  /** 'heuristic' | 'llm' | 'fallback' | 'default' */
  source: string;
  rationale: string;
}

/** Resolve a one-time setup model from an intent string. Empty/blank
 *  intent → the balanced default (zero-config baseline). Never throws. */
export async function suggestSetupModel(
  intent: string,
  deps: AutoRouteDeps,
  opts: RouteTierOpts = {},
): Promise<SetupModelSuggestion> {
  const text = (intent ?? '').trim();
  if (text.length === 0) {
    const spec = lookupLlmTierSpec(deps.provider, DEFAULT_MODEL_TIER);
    return {
      provider: deps.provider,
      model: spec.model,
      reasoningLevel: spec.reasoningLevel,
      tier: DEFAULT_MODEL_TIER,
      source: 'default',
      rationale: 'no intent given · zero-config balanced default',
    };
  }
  const route = await resolveAutoRoute({ text, kind: 'chat' }, deps, { ...opts, enabled: true });
  // resolveAutoRoute only returns null when enabled=false, which we never
  // pass here — but stay defensive so callers get a usable suggestion.
  if (!route) {
    const spec = lookupLlmTierSpec(deps.provider, DEFAULT_MODEL_TIER);
    return {
      provider: deps.provider,
      model: spec.model,
      reasoningLevel: spec.reasoningLevel,
      tier: DEFAULT_MODEL_TIER,
      source: 'default',
      rationale: 'router returned no route · balanced default',
    };
  }
  return {
    provider: deps.provider,
    model: route.model,
    reasoningLevel: route.reasoningLevel,
    tier: route.tier,
    source: route.source,
    rationale: route.rationale,
  };
}
