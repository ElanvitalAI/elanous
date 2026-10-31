// RFC #2161 Phase 1 — Layer A Static Catalog types.
//
// Pure type definitions. Runtime lives in `loader.ts` / `normalize.ts`.
// PWA mirror lives in `apps/pwa/.../registry-types.ts` (Phase 5+ scope).
//
// Cross-ref: 내부 문서 `RFC-provider-ssot-consolidation-2026-05-10` §4.1 (Layer
// A) · §5 (capability spec) · §6 (2-tier catalog).

// ── Provider-level capabilities (RFC §5.1 · 14 flags) ────────────────

export interface ProviderCapabilities {
  /** Per-call SDK conversation resumption (Claude SDK pattern). */
  sessionResume: boolean;
  /** Model Context Protocol — pass MCP server set per call. */
  mcp: boolean;
  /** Lifecycle hooks (pre/post-tool, pre/post-message). */
  hooks: boolean;
  /** elanous's `/skill/` system invokable from within a provider call. */
  skills: boolean;
  /** Inline sub-agent definitions (Claude SDK `options.agents`). */
  agents: boolean;
  /** Per-call allowed/denied tool list. */
  toolRestrictions: boolean;
  /** Structured JSON output mode. */
  structuredOutput: boolean;
  /** Per-call env var injection. */
  envInjection: boolean;
  /** Per-call cost ceiling. */
  costControl: boolean;
  /** Reasoning effort selection (gpt-5 'minimal'…'xhigh'). */
  effortControl: boolean;
  /** Extended thinking opt-in (Claude `thinking`, Gemini reasoning). */
  thinkingControl: boolean;
  /** Fallback model when primary unavailable / rate-limited. */
  fallbackModel: boolean;
  /** Sandboxed execution (containerized / restricted FS). */
  sandbox: boolean;
  /** RFC §5.1 P14 — `local` provider only · sub-host fan-out routing. */
  multiHostFanout: boolean;
}

// ── Model-level capabilities (RFC §5.2 · 19 fields) ──────────────────

/** What kind of multimodal vision input the model accepts. */
export type ModelVision = 'images' | 'video' | 'pdf' | null;

/** Reasoning level the model exposes via API. `null` = no reasoning
 *  control surfaced. */
export type ModelReasoning = 'off' | 'low' | 'medium' | 'high' | null;

/** Tool-calling protocol the adapter wires up. `none` = model does not
 *  surface tool calls (e.g. embedding-only). */
export type ToolCallingFormat =
  | 'native-anthropic'
  | 'native-openai'
  | 'native-gemini'
  | 'none';

/** Streaming wire protocol — used by the adapter to pick decoder. */
export type StreamingProtocol = 'sse' | 'ws' | 'polling';

/** Tokenizer family — drives accurate token counting for cost / context
 *  prepass. RFC §5.2 M18. */
export type TokenizerFamily =
  | 'cl100k'
  | 'gpt-4'
  | 'claude'
  | 'gemini'
  | 'tiktoken'
  | 'llama'
  | 'unknown';

/** Model "kind" — RFC §5.2 M19. embedding / image / audio models live in
 *  the same catalog so policies and discovery cover them too. */
export type ModelKind = 'chat' | 'embedding' | 'image' | 'audio';

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million input tokens when served from prompt-cache. */
  cachedInputPerMTok?: number;
}

export interface ModelRateLimits {
  /** Requests per minute. */
  rpm?: number;
  /** Tokens per minute. */
  tpm?: number;
}

export interface ModelAudio {
  input: boolean;
  output: boolean;
}

/** RFC §5.3 — Layer D (auto-discovery) provenance for a model entry. */
export interface ModelDiscoveryMeta {
  /** Where this entry came from. */
  source:
    | 'manual'
    | 'auto-anthropic-api'
    | 'auto-openai-api'
    | 'auto-gemini-api'
    | 'auto-grok-api'
    | 'auto-grok-crawl'
    | 'auto-firecrawl-crawl'
    | 'auto-local-host'
    | 'auto-openrouter-api';
  /** Last time the source confirmed the entry (ISO date). */
  lastSeen: string;
  /** True when Layer D filled the entry without manual review. */
  autoFilled: boolean;
  /** omni-crawl reliability for autoFilled entries. */
  confidence?: 'high' | 'medium' | 'low';
}

// ── Catalog entries ──────────────────────────────────────────────────

export interface ProviderRegistration {
  /** Canonical provider id (e.g. 'anthropic'). */
  id: string;
  displayName: string;
  /** Aliases that normalize to `id` (e.g. ['claude'] for 'anthropic'). */
  aliases: string[];
  /** Model id prefixes that route to this provider when `inferProviderFromModel`
   *  has no other signal. e.g. ['claude-', 'anthropic/']. */
  modelPrefixes: string[];
  /** Env var that holds the API key for the native endpoint. */
  apiKeyEnv: string;
  /** Default endpoint URL (production). */
  endpointPattern: string;
  /** Wire shape the adapter uses for streaming. */
  defaultStreaming: StreamingProtocol;
  /** Tool-call protocol negotiated at the adapter layer. */
  toolCallingFormat: ToolCallingFormat;
  /** Provider-level capability defaults · models can override per RFC §5.2.1. */
  capabilities: ProviderCapabilities;
  /** Maintained by elanous core (true) vs community/local-only (false). */
  builtIn: boolean;
  /** 대표 2026-09-23 «카탈로그를 파생한다» — true 면 이 provider 의 모델은 YAML 이 아니라 발견
   *  스냅숏(`discovery-snapshot.json`)에서 카탈로그로 «접힌다»(`openrouter/<id>` 네임스페이스 ·
   *  YAML 이 늘 이긴다). 선언한 provider 만 접는다 — 다른 소스의 스냅숏은 여전히 «평행 표면»이다. */
  catalogFromDiscovery?: boolean;
}

export interface ModelSpec {
  /** Canonical model id (e.g. 'claude-opus-4-7'). */
  id: string;
  /** Provider id (must match a `ProviderRegistration.id`). */
  provider: string;
  displayName: string;
  /** Family identifier for shortcut resolution (e.g. 'claude-4'). */
  family?: string;
  /** Short alias picked up by `resolveFamilyShortcut` (e.g. 'opus'). */
  familyShortcut?: string;
  /** Context window in tokens. */
  contextSize?: number;
  /** Soft cap on response token count. */
  outputMaxTokens?: number;
  vision?: ModelVision;
  audio?: ModelAudio;
  reasoning?: ModelReasoning;
  toolCalling?: ToolCallingFormat;
  streamingProtocol?: StreamingProtocol;
  pricing?: ModelPricing;
  rateLimits?: ModelRateLimits;
  /** ISO date when the provider deprecates · null when active. */
  deprecated?: string | null;
  releaseDate?: string;
  tokenizer?: TokenizerFamily;
  kind?: ModelKind;
  /** Partial capability override applied on top of provider defaults
   *  (RFC §5.2.1). */
  capabilities?: Partial<ProviderCapabilities>;
  discoveryMeta?: ModelDiscoveryMeta;
}

// ── Pattern fallback (per-provider _patterns.yaml) ────────────────────

/** Used when a model id matches a prefix but no explicit ModelSpec
 *  exists. Lets the catalog ship light: explicit specs for shipping
 *  models, pattern fallback for the long tail (RFC §4.1 _patterns.yaml). */
export interface ModelPatternFallback {
  /** Provider id this pattern set belongs to. */
  provider: string;
  /** Prefix → fallback model spec template. Keys are case-insensitive. */
  prefixes: Array<{
    prefix: string;
    /** Capabilities/fields applied when no explicit ModelSpec matches. */
    fallback: Partial<ModelSpec>;
  }>;
}

// ── Top-level catalog (loader output) ─────────────────────────────────

export interface Catalog {
  /** Catalog release version from catalog/meta/catalogVersion.yaml. */
  catalogVersion: number;
  /** Indexed by provider id. */
  providers: Map<string, ProviderRegistration>;
  /** Indexed by canonical model id. */
  models: Map<string, ModelSpec>;
  /** Indexed by provider id · used by `inferProviderFromModel` long-tail
   *  fallback. */
  patterns: Map<string, ModelPatternFallback>;
  /** Source-of-record manifest for debugging / dev reload. */
  manifest: {
    builtinSource: string;     // 'monad-agent/catalog/'
    globalSource: string;      // '~/.elanous/catalog/' (or the test override)
    /** Number of files contributing to this snapshot. */
    fileCount: number;
    /** When the loader built this snapshot. */
    loadedAt: string;
  };
}

// ── Capability lookup keys (UI grids) ─────────────────────────────────

export const CAPABILITY_KEYS: readonly (keyof ProviderCapabilities)[] = [
  'skills',
  'toolRestrictions',
  'structuredOutput',
  'thinkingControl',
  'effortControl',
  'sessionResume',
  'mcp',
  'hooks',
  'agents',
  'envInjection',
  'costControl',
  'fallbackModel',
  'sandbox',
  'multiHostFanout',
];

/** All-false template — every flag explicitly listed so a missing field
 *  is a tsc error. */
export const PROVIDER_CAPABILITIES_NONE: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
  multiHostFanout: false,
};
