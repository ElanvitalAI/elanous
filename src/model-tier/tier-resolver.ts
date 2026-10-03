// M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// Resolve a user's tier intent → concrete provider/model spec.
//
// Precedence (high → low):
//   1. `modelTier.voice.stt` (per-surface override · §3.4a.1)
//   2. `modelTier.preset` (Phase 2 preset catalog · undefined today)
//   3. `modelTier.profile`-based default (casual & power both ↦ Balanced
//      today; Phase 3 can broaden)
//   4. DEFAULT_MODEL_TIER ('balanced')
//
// The resolver takes `ModelTierUserConfig | undefined` (not the full
// UserConfig) to avoid a circular import between user-config.ts and the
// model-tier package. Callers (cost-tracker / streaming-stt bridge /
// PWA settings) read `getUserConfig().modelTier` and pass it in.

import type { LLMProviderName } from '../user-config.js';
import {
  lookupEmbeddingTierSpec,
  type EmbeddingProvider,
  type EmbeddingTierSpec,
} from './embedding-tier-map.js';
import { lookupLlmTierSpec, type LlmTierSpec } from './llm-tier-map.js';
import { getSessionTierOverride } from './session-override.js';
import { STT_TIER_MAP, type SttTierSpec } from './tier-map.js';
import { TTS_TIER_MAP, type TtsTierSpec } from './tts-tier-map.js';
import {
  DEFAULT_MODEL_TIER,
  type ModelTier,
  type ModelTierUserConfig,
} from './types.js';
import {
  lookupVisionTierSpec,
  type VisionProvider,
  type VisionTierSpec,
} from './vision-tier-map.js';

/** Why the resolver picked this tier — used by `elanous voice status` to
 *  explain "you're on balanced because no override is set". */
export type SttTierSource =
  | 'session-override'
  | 'user-config-surface'
  | 'preset'
  | 'profile'
  | 'default';

export interface ResolvedSttTier extends SttTierSpec {
  /** The tier the resolver picked. */
  tier: ModelTier;
  /** Why this tier was picked — drives the UI rationale string. */
  source: SttTierSource;
}

/** Resolve STT tier from user-config slice. `undefined` → DEFAULT.
 *  When `opts.sessionId` is supplied AND a non-expired session
 *  override exists, the session override wins (M3-3 chat NL switch).
 *  Sessions without an override fall through to the normal chain. */
export function resolveSttTier(
  modelTier: ModelTierUserConfig | undefined,
  opts: { sessionId?: string } = {},
): ResolvedSttTier {
  // 0. Session override (M3-3 — chat NL switch wins for the active session).
  if (opts.sessionId) {
    const ov = getSessionTierOverride(opts.sessionId);
    if (ov?.stt) {
      return { ...STT_TIER_MAP[ov.stt], tier: ov.stt, source: 'session-override' };
    }
  }
  // 1. Per-surface override (Phase 1 power-user knob).
  const surface = modelTier?.voice?.stt;
  if (surface) {
    return { ...STT_TIER_MAP[surface], tier: surface, source: 'user-config-surface' };
  }

  // 2. Preset → STT tier. Phase 2: lookup in preset-catalog. For now we
  //    only honor the presence of `preset` to surface "preset-driven"
  //    in the source string; the tier itself falls through to default.
  //    When Phase 2 lands, replace this branch with the catalog read.
  if (modelTier?.preset) {
    return {
      ...STT_TIER_MAP[DEFAULT_MODEL_TIER],
      tier: DEFAULT_MODEL_TIER,
      source: 'preset',
    };
  }

  // 3. Profile-driven default — casual and power both land on
  //    Balanced today (PLAN §3.0.3). `custom` keeps the same default
  //    until an override or preset is set.
  if (modelTier?.profile) {
    return {
      ...STT_TIER_MAP[DEFAULT_MODEL_TIER],
      tier: DEFAULT_MODEL_TIER,
      source: 'profile',
    };
  }

  // 4. Zero-config default.
  return {
    ...STT_TIER_MAP[DEFAULT_MODEL_TIER],
    tier: DEFAULT_MODEL_TIER,
    source: 'default',
  };
}

// ── LLM resolver (M2-1 · Phase 2) ───────────────────────────────────

export type LlmTierSource =
  | 'session-override'
  | 'user-config-surface'
  | 'preset'
  | 'profile'
  | 'default';

export interface ResolvedLlmTier extends LlmTierSpec {
  tier: ModelTier;
  source: LlmTierSource;
  /** The provider this resolution applies to — surfaced so callers
   *  can echo "Anthropic · Claude Opus 4.7" rather than guess at
   *  the active provider themselves. */
  provider: LLMProviderName;
}

// ── TTS resolver (M2-2 · Phase 2) ───────────────────────────────────

export type TtsTierSource =
  | 'session-override'
  | 'user-config-surface'
  | 'preset'
  | 'profile'
  | 'default';

export interface ResolvedTtsTier extends TtsTierSpec {
  tier: ModelTier;
  source: TtsTierSource;
}

/** Resolve TTS tier from `modelTier.voice.tts`. Same precedence chain
 *  as the STT/LLM resolvers. */
export function resolveTtsTier(
  modelTier: ModelTierUserConfig | undefined,
  opts: { sessionId?: string } = {},
): ResolvedTtsTier {
  if (opts.sessionId) {
    const ov = getSessionTierOverride(opts.sessionId);
    if (ov?.tts) {
      return { ...TTS_TIER_MAP[ov.tts], tier: ov.tts, source: 'session-override' };
    }
  }
  const surface = modelTier?.voice?.tts;
  if (surface) {
    return { ...TTS_TIER_MAP[surface], tier: surface, source: 'user-config-surface' };
  }
  if (modelTier?.preset) {
    return { ...TTS_TIER_MAP[DEFAULT_MODEL_TIER], tier: DEFAULT_MODEL_TIER, source: 'preset' };
  }
  if (modelTier?.profile) {
    return { ...TTS_TIER_MAP[DEFAULT_MODEL_TIER], tier: DEFAULT_MODEL_TIER, source: 'profile' };
  }
  return { ...TTS_TIER_MAP[DEFAULT_MODEL_TIER], tier: DEFAULT_MODEL_TIER, source: 'default' };
}

/** Resolve LLM tier. Precedence mirrors STT (surface → preset → profile
 *  → default) — diverges only in that the resolver needs the active
 *  `llm.provider` to expand the tier ladder. */
export function resolveLlmTier(
  modelTier: ModelTierUserConfig | undefined,
  provider: LLMProviderName,
  opts: { sessionId?: string } = {},
): ResolvedLlmTier {
  if (opts.sessionId) {
    const ov = getSessionTierOverride(opts.sessionId);
    if (ov?.llm) {
      return {
        ...lookupLlmTierSpec(provider, ov.llm),
        tier: ov.llm,
        source: 'session-override',
        provider,
      };
    }
  }
  // 1. Per-surface override.
  if (modelTier?.llm) {
    return {
      ...lookupLlmTierSpec(provider, modelTier.llm),
      tier: modelTier.llm,
      source: 'user-config-surface',
      provider,
    };
  }
  // 2. Preset placeholder (Phase 2 preset-catalog hook).
  if (modelTier?.preset) {
    return {
      ...lookupLlmTierSpec(provider, DEFAULT_MODEL_TIER),
      tier: DEFAULT_MODEL_TIER,
      source: 'preset',
      provider,
    };
  }
  // 3. Profile-driven default.
  if (modelTier?.profile) {
    return {
      ...lookupLlmTierSpec(provider, DEFAULT_MODEL_TIER),
      tier: DEFAULT_MODEL_TIER,
      source: 'profile',
      provider,
    };
  }
  // 4. Zero-config default.
  return {
    ...lookupLlmTierSpec(provider, DEFAULT_MODEL_TIER),
    tier: DEFAULT_MODEL_TIER,
    source: 'default',
    provider,
  };
}

// ── Embedding resolver (M3-2 · Phase 3) ─────────────────────────────

export type EmbeddingTierSource =
  | 'session-override'
  | 'user-config-surface'
  | 'preset'
  | 'profile'
  | 'default';

export interface ResolvedEmbeddingTier extends EmbeddingTierSpec {
  tier: ModelTier;
  source: EmbeddingTierSource;
  provider: EmbeddingProvider;
}

/** Resolve the embedding tier. Same precedence chain as LLM: session
 *  override → per-surface (modelTier.embedding) → preset → profile →
 *  default. The provider is supplied by the caller — typical wiring
 *  reads `cfg.embedding?.provider` (future field) and falls back to
 *  'openai'. */
export function resolveEmbeddingTier(
  modelTier: ModelTierUserConfig | undefined,
  provider: EmbeddingProvider,
  opts: { sessionId?: string } = {},
): ResolvedEmbeddingTier {
  if (opts.sessionId) {
    // Note: session-override doesn't currently carry embedding/vision
    // slots — chat NL switch (M3-3) only touches voice surfaces. We
    // still consult the store for symmetry so a future override that
    // adds embedding wins automatically.
    const ov = getSessionTierOverride(opts.sessionId);
    // Cast-safe: SessionTierOverride won't have embedding today; left
    // as an extension hook.
    const overrideTier = (ov as { embedding?: ModelTier } | undefined)?.embedding;
    if (overrideTier) {
      return {
        ...lookupEmbeddingTierSpec(provider, overrideTier),
        tier: overrideTier,
        source: 'session-override',
        provider,
      };
    }
  }
  if (modelTier?.embedding) {
    return {
      ...lookupEmbeddingTierSpec(provider, modelTier.embedding),
      tier: modelTier.embedding,
      source: 'user-config-surface',
      provider,
    };
  }
  if (modelTier?.preset) {
    return {
      ...lookupEmbeddingTierSpec(provider, DEFAULT_MODEL_TIER),
      tier: DEFAULT_MODEL_TIER,
      source: 'preset',
      provider,
    };
  }
  if (modelTier?.profile) {
    return {
      ...lookupEmbeddingTierSpec(provider, DEFAULT_MODEL_TIER),
      tier: DEFAULT_MODEL_TIER,
      source: 'profile',
      provider,
    };
  }
  return {
    ...lookupEmbeddingTierSpec(provider, DEFAULT_MODEL_TIER),
    tier: DEFAULT_MODEL_TIER,
    source: 'default',
    provider,
  };
}

// ── Vision resolver (M3-2 · Phase 3) ────────────────────────────────

export type VisionTierSource =
  | 'session-override'
  | 'user-config-surface'
  | 'preset'
  | 'profile'
  | 'default';

export interface ResolvedVisionTier extends VisionTierSpec {
  tier: ModelTier;
  source: VisionTierSource;
  provider: VisionProvider;
}

export function resolveVisionTier(
  modelTier: ModelTierUserConfig | undefined,
  provider: VisionProvider,
  opts: { sessionId?: string } = {},
): ResolvedVisionTier {
  if (opts.sessionId) {
    const ov = getSessionTierOverride(opts.sessionId);
    const overrideTier = (ov as { vision?: ModelTier } | undefined)?.vision;
    if (overrideTier) {
      return {
        ...lookupVisionTierSpec(provider, overrideTier),
        tier: overrideTier,
        source: 'session-override',
        provider,
      };
    }
  }
  if (modelTier?.vision) {
    return {
      ...lookupVisionTierSpec(provider, modelTier.vision),
      tier: modelTier.vision,
      source: 'user-config-surface',
      provider,
    };
  }
  if (modelTier?.preset) {
    return {
      ...lookupVisionTierSpec(provider, DEFAULT_MODEL_TIER),
      tier: DEFAULT_MODEL_TIER,
      source: 'preset',
      provider,
    };
  }
  if (modelTier?.profile) {
    return {
      ...lookupVisionTierSpec(provider, DEFAULT_MODEL_TIER),
      tier: DEFAULT_MODEL_TIER,
      source: 'profile',
      provider,
    };
  }
  return {
    ...lookupVisionTierSpec(provider, DEFAULT_MODEL_TIER),
    tier: DEFAULT_MODEL_TIER,
    source: 'default',
    provider,
  };
}
