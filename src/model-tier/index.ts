// M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// Barrel export for the model-tier package.

export {
  DEFAULT_MODEL_TIER,
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  TTS_VOICE_CONTEXTS,
  isModelTier,
  isModelTierProfile,
  isTtsVoiceContext,
  modelTierRank,
  type BudgetUserConfig,
  type ModelTier,
  type ModelTierProfile,
  type ModelTierSurface,
  type ModelTierUserConfig,
  type ModelTierVoiceConfig,
  type SmartDefaultsUserConfig,
  type TtsVoiceContext,
  type TtsVoiceContextConfig,
} from './types.js';

export {
  STT_TIER_MAP,
  sttTierEffectiveUsdPerMin,
  type SttTierSpec,
} from './tier-map.js';

export {
  projectSttAllTiers,
  projectSttTierMonthlyCost,
  type CostEstimateInputs,
  type SttCostEstimate,
  type UsageSample,
} from './cost-estimate.js';

export {
  resolveEmbeddingTier,
  resolveLlmTier,
  resolveSttTier,
  resolveTtsTier,
  resolveVisionTier,
  type EmbeddingTierSource,
  type LlmTierSource,
  type ResolvedEmbeddingTier,
  type ResolvedLlmTier,
  type ResolvedSttTier,
  type ResolvedTtsTier,
  type ResolvedVisionTier,
  type SttTierSource,
  type TtsTierSource,
  type VisionTierSource,
} from './tier-resolver.js';

export {
  EMBEDDING_TIER_MAP_BY_PROVIDER,
  lookupEmbeddingTierSpec,
  type EmbeddingProvider,
  type EmbeddingTierSpec,
} from './embedding-tier-map.js';

export {
  VISION_TIER_MAP_BY_PROVIDER,
  lookupVisionTierSpec,
  type VisionProvider,
  type VisionTierSpec,
} from './vision-tier-map.js';

export {
  LLM_TIER_MAP_BY_PROVIDER,
  lookupLlmTierSpec,
  type LlmTierProvider,
  type LlmTierSpec,
} from './llm-tier-map.js';

export {
  TTS_TIER_MAP,
  projectTtsMonthlyCost,
  type TtsTierSpec,
} from './tts-tier-map.js';

export {
  PRESETS,
  PRESET_IDS,
  getPreset,
  isPresetId,
  type PresetId,
  type PresetSpec,
} from './preset-catalog.js';

export {
  DEFAULT_AMBIGUITY_THRESHOLD,
  buildTierClassifyMessages,
  classifyTierHeuristic,
  parseTierClassifyReply,
  routeTier,
  type RouteTierOpts,
  type RouterInput,
  type TierRoute,
  type TierRouteSource,
} from './task-router.js';

export {
  resolveAutoRoute,
  type AutoRouteDeps,
  type AutoRouteResult,
  type ResolveAutoRouteOpts,
} from './auto-route.js';

export {
  getRouterDecisionPath,
  logRouterDecision,
  readRouterDecisions,
  type RouterDecision,
  type LogRouterDecisionOpts,
} from './router-decision-log.js';

export {
  suggestSetupModel,
  type SetupModelSuggestion,
} from './setup-suggest.js';

export {
  adjustTier,
  detectNuanceDelta,
  type NuanceSignal,
} from './nuance-adjust.js';

export {
  suggestPresetForText,
  type PresetSuggestion,
} from './preset-suggest.js';

export {
  buildPresetSuggestMessages,
  createLocalLlmPresetRunner,
  parsePresetSuggestReply,
  suggestPresetForTextLLM,
  type LlmMessage,
  type LlmMessageRole,
  type LlmPresetSuggestion,
  type LlmRunner,
  type LocalLlmRunnerOpts,
  type SuggestPresetLlmOpts,
  type SuggestionSource,
} from './preset-suggest-llm.js';

export {
  buildNlTierIntentMessages,
  detectTierIntentFromChat,
  parseNlTierIntentReply,
  planNlTierSwitch,
  type CurrentTierSlots,
  type DetectTierIntentOpts,
  type NlTierApplyPlan,
  type NlTierDetection,
  type NlTierIntent,
} from './nl-tier-switch.js';

export {
  _resetSessionTierOverridesForTesting,
  clearSessionTierOverride,
  getSessionTierOverride,
  listSessionTierOverrides,
  setSessionTierOverride,
  type SessionTierOverride,
  type SetOverrideOpts,
} from './session-override.js';
