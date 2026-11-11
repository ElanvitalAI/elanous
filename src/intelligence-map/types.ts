// ── PFC-S5 P1: intelligence-map shared types ──

export type ModelProvider =
  | 'anthropic'
  | 'openai'
  | 'openai-codex'  // ChatGPT/Codex 구독 엔드포인트(gpt-5.6-sol/terra/luna)
  | 'grok'
  | 'gemini'
  | 'kimi'      // Moonshot — api.moonshot.cn (OpenAI-compat)
  | 'qwen'      // Alibaba DashScope (OpenAI-compat)
  | 'glm'       // Zhipu BigModel / Z.ai (OpenAI-compat)
  | 'nemotron'  // NVIDIA build.nvidia.com NIM (OpenAI-compat)
  | 'openrouter' // OpenRouter model ids include the vendor prefix
  | 'ollama'
  | 'local'
  | 'other';

export interface ModelEntry {
  id: string;
  provider: ModelProvider;
  family: string;
  sizeB?: number | null;
  contextWindow: number;
  inputPerMtok: number;   // USD per 1M input tokens
  outputPerMtok: number;  // USD per 1M output tokens
  local: boolean;
  tags: string[];         // coarse capability tags
  bestFor: string[];      // use-case hints
  envKey?: string;        // ENV var that enables this provider (undefined = always on)
  minRamGb?: number;      // local only
  notes?: string;
  /** Open-weight on Hugging Face (downloadable) — orthogonal to `local`.
   *  A model can be cloud-hosted AND open-weight (e.g. GLM-5.1, Kimi-K2.6).
   *  Cloud-only / closed = false. Used by setup wizard to surface
   *  "downloadable for local serving" hints. */
  openWeight?: boolean;
  /** Hugging Face repo path (e.g. `Qwen/Qwen3.6-35B-A3B`). Set when the
   *  model has a canonical HF source. Allows the wizard to produce
   *  exact `huggingface-cli download` and Ollama tag suggestions. */
  huggingFaceRepo?: string;
  /** Tokens reserved for the model's output. The effective input
   *  budget for `/context` and auto-compact gating is
   *  `contextWindow - reservedOutputTokens`. Codex's `BASELINE_TOKENS
   *  = 12_000` was the inspiration — most modern coding/agent models
   *  reserve 8-20K depending on tool/streaming output norms. When
   *  unset, the input budget equals the full context window (no
   *  reservation). */
  reservedOutputTokens?: number;
  /** mlx-community HF repo for Apple Silicon optimized weights
   *  (e.g. `mlx-community/Qwen3.6-35B-A3B-4bit`). Preferred over
   *  `huggingFaceRepo` when the local node is Apple silicon — LM
   *  Studio + MLX runtime is the fastest path on M-series Macs. The
   *  setup wizard surfaces this first and falls back to
   *  `huggingFaceRepo` (GGUF / safetensors) when MLX isn't present.
   *
   *  Convention: paths default to **4bit** quantization variants.
   *  `minRamGb` and `notes` size estimates assume Q4_K_M / 4bit MLX
   *  unless explicitly stated otherwise. Higher-quality 6bit / 8bit
   *  variants exist on mlx-community for most repos but cost ~1.5×
   *  / ~2× the disk + RAM — out of scope for the default catalog. */
  mlxRepo?: string;
  /** Realistic local-pull feasibility. False when the open-weight is
   *  too large for typical hardware (e.g. 1T MoE Kimi-K2.6 ~540GB Q4).
   *  When `local: true` this is implicit-true; when `local: false` and
   *  `openWeight: true` this captures the practical-capacity verdict. */
  localPullable?: boolean;

  // ── PLAN-model-intelligence-router · Part A (auto model intelligence) ──
  // All optional + additive so existing catalog rows and every consumer
  // are untouched. Populated by the auto-classifier (Part A3) for newly
  // discovered models; the builtin catalog may leave them unset.

  /** Coarse tier bucket (budget..loaded) used by the tier ladder + the
   *  smart router. When set, the router/setup-suggest can map a routed
   *  tier straight to this model without the per-provider hardcoded map.
   *  Type-only import — no runtime coupling to the model-tier package. */
  tier?: import('../model-tier/types.js').ModelTier;

  /** A0 decision — effort/variant modelling. When this entry is one
   *  effort variant of a family flagship (e.g. gpt-5.6-luna is a variant
   *  of gpt-5.6), `variantOf` names the parent model id and `effortAxis`
   *  labels the variant ('luna' / 'terra' / 'reasoning-high' / ...). Each
   *  variant stays its own ModelEntry (distinct id + pricing) but is
   *  linked here so the router can pick a variant by effort. */
  variantOf?: string;
  effortAxis?: string;

  /** ⭐ Reasoning-effort 상한 SSOT (2026-07-19). 모델마다 지원하는 reasoning effort 최대치가
   *  천차만별이다 — codex terra=high·sol=max · anthropic opus/sonnet=high(adaptive effort) ·
   *  gemini 3.1=high(thinkingLevel) · grok 4.20-non-reasoning=none·4.5=high(configurable).
   *  라우터/UI 가 모델별 상한을 넘겨 요청하지 않도록(예: terra 에 xhigh 금지) 단일 출처로 둔다.
   *  'none'=reasoning 미지원(비추론 변종). 미지정=상한 미상(안전하게 medium 취급). 소비:
   *  `reasoningEffortCeiling(modelId)`. */
  reasoningEffortCeiling?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** ISO date the model was released/announced — freshness signal for
   *  the watcher (Part A2) and "new default" re-suggest (cadence ②). */
  releasedAt?: string;

  /** Provenance of this entry. `builtin` = shipped in BUILTIN_CATALOG;
   *  `auto` = added by the classifier and NOT yet human-approved (a
   *  candidate); `manual` = human-edited/approved. The router should
   *  treat `auto` (unapproved) entries as advisory only until promoted
   *  to `manual` via the HITL flow (Part A4). */
  classification?: {
    source: 'builtin' | 'auto' | 'manual';
    confidence?: number;
    at?: string;
  };
}

export interface ModelCatalog {
  version: 1;
  updated: number;
  models: ModelEntry[];
}

// ── System snapshot ────────────────────────────────────────────────────

export interface SystemSnapshot {
  cpuCount: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cpuPercent: number;
  freeMemGb: number;
  totalMemGb: number;
  freeMemPercent: number;
  platform: string;
  arch: string;
  snapshotAt: number;
}

// ── Cost ───────────────────────────────────────────────────────────────

export interface UsageEvent {
  ts: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  goalSlug?: string;
  taskId?: string;
}

export interface CostPerModel {
  tokens: number;
  usd: number;
  count: number;
}

export interface CostPerGoal {
  tokens: number;
  usd: number;
}

export interface CostSnapshot {
  totalUsd: number;
  weeklyUsd: number;
  monthlyUsd: number;
  perModel: Record<string, CostPerModel>;
  perGoal: Record<string, CostPerGoal>;
  weekStart: number;      // ISO epoch — 7 days before snapshot
  monthStart: number;     // 30 days before snapshot
  eventsCount: number;
  snapshotAt: number;
}

export interface CostCapConfig {
  weeklyCapUsd?: number;
  monthlyCapUsd?: number;
}

export type CostCapStatus = 'ok' | 'warning' | 'tripped';
