// M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// Model tier vocabulary.
//
// 5-tick 1-D scale (decision M1) collapsing the (quality × cost × latency)
// trade-off space of every model-pickable surface. The slider UX never
// names a model id; users only express intent ("more accurate / cheaper /
// faster") and the resolver maps it to a concrete provider+model+options
// bundle (see `tier-map.ts` + `tier-resolver.ts`).
//
// Phase 1 wires this for STT (PR #2308 trigger). Phase 2 extends to LLM
// and TTS — same 5 ticks, different per-surface maps. Per-surface tiers
// can disagree (decision M2 = same-tier default, per-surface override
// allowed).
//
// These types are intentionally co-located so `user-config.ts` and the
// per-surface map / resolver files don't cycle through each other.

// ── Tier vocabulary ────────────────────────────────────────────────

/** Slider tick — decision M1 ("Budget · Balanced · Better · Best · Loaded").
 *  Ordering encodes the "more = better/expensive" direction; consumers
 *  may rely on it to compare ticks (e.g. budget-guard fallback). */
export type ModelTier = 'budget' | 'balanced' | 'better' | 'best' | 'loaded';

/** Slider ticks in user-facing left → right order. */
export const MODEL_TIERS: readonly ModelTier[] = [
  'budget',
  'balanced',
  'better',
  'best',
  'loaded',
] as const;

/** Human-readable label per tier — surfaced by PWA slider + CLI
 *  `elanous voice status`. Title-cased to match PLAN §3.2 spec. */
export const MODEL_TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  budget: 'Budget',
  balanced: 'Balanced',
  better: 'Better',
  best: 'Best',
  loaded: 'Loaded',
} as const;

/** Decision M1.2 — the tick a casual user lands on when they never touch
 *  settings. Same on every surface; preserves zero-config baseline. */
export const DEFAULT_MODEL_TIER: ModelTier = 'balanced';

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v);
}

/** Numeric rank (0..4) for tier comparisons (e.g. budget-guard fallback
 *  picks the lower-ranked tier). */
export function modelTierRank(t: ModelTier): number {
  return MODEL_TIERS.indexOf(t);
}

// ── Surface vocabulary ─────────────────────────────────────────────

/** Surfaces that share the 5-tick scale. Phase 1 = `stt` only; Phase 2
 *  adds `llm` and `tts`. Embedding / vision land in Phase 3. */
export type ModelTierSurface = 'stt' | 'llm' | 'tts';

// ── Model tier profile ─────────────────────────────────────────────

/** Zero-config baseline (§3.0 of the PLAN) — model tier profiles.
 *  - `casual`: never touches settings; surfaces minimal UI.
 *  - `power`: opens slider / picker / preset etc.
 *  - `custom`: preset or per-surface overrides decide. */
export type ModelTierProfile = 'casual' | 'power' | 'custom';

export function isModelTierProfile(v: unknown): v is ModelTierProfile {
  return v === 'casual' || v === 'power' || v === 'custom';
}

// ── User-config sub-shapes ─────────────────────────────────────────

/** Per-context TTS voice identity (M2-2b · Phase 2 · decision M9).
 *  Voice ID is orthogonal to the TTS quality tier (M2-2) — quality
 *  controls the *model* (latency · language coverage · fidelity);
 *  identity controls the *voice* (warmth · accent · gender · custom
 *  clone). Each context can carry its own voice so e.g. morning
 *  digest reads in a Korean female voice while alerts use an urgent
 *  male voice. `default` is the fallback when a specific context
 *  isn't set.
 *
 *  Values are ElevenLabs voice ids (or future provider-prefixed
 *  ids like `openai:nova`). M2-2b stores raw strings; the v2
 *  follow-up will validate against the live ElevenLabs library. */
export interface TtsVoiceContextConfig {
  default?: string;
  chat?: string;
  digest?: string;
  alert?: string;
  discord?: string;
}

/** Voice-surface tier overrides. */
export interface ModelTierVoiceConfig {
  stt?: ModelTier;
  tts?: ModelTier;
  /** M2-2b · Phase 2 — per-context voice identity (Voice ID picker). */
  ttsVoice?: TtsVoiceContextConfig;
}

export const TTS_VOICE_CONTEXTS = ['default', 'chat', 'digest', 'alert', 'discord'] as const;
export type TtsVoiceContext = typeof TTS_VOICE_CONTEXTS[number];

export function isTtsVoiceContext(v: unknown): v is TtsVoiceContext {
  return typeof v === 'string' && (TTS_VOICE_CONTEXTS as readonly string[]).includes(v);
}

/** Root `modelTier` sub-tree of UserConfig. Sparse — every field is
 *  optional so the resolver can fall through (surface override → preset
 *  → profile → default). */
export interface ModelTierUserConfig {
  profile?: ModelTierProfile;
  preset?: string;
  voice?: ModelTierVoiceConfig;
  llm?: ModelTier;
  embedding?: ModelTier;
  vision?: ModelTier;
}

/** Budget cap (§3.4) — decision M4 = no default cap. Undefined
 *  `monthlyUsdCap` means "passive · cost dashboard only · no fallback".
 *  When set, cost-tracker triggers fallback at `notifyAtPct` (default
 *  80%) using `fallbackTier` (default 'budget'). */
export interface BudgetUserConfig {
  monthlyUsdCap?: number;
  dailyUsdCap?: number;
  fallbackTier?: ModelTier;
  notifyAtPct?: number;
}

/** Zero-config auto-suggest controls (§3.0.4). `autoSuggest` enables the
 *  three casual-user alerts (cost drift · new default · pattern hint).
 *  When `false` the casual user sees no proactive UI ever. */
export interface SmartDefaultsUserConfig {
  autoSuggest?: boolean;
  suppressPatternHints?: boolean;
}
