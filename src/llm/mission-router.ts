// ── Mission router (P1-1 · iPhone Showroom 강화 cascade · 2026-05-14) ──
//
// Maps a user turn (text + optional attachments) onto one of 6 mission
// kinds, then resolves the preferred backend provider/model for that
// mission. Tier 1 is a pure heuristic — Korean + English regex over
// the input plus attachment + length signals. No I/O, no network.
//
// Tier 2 (injected LLM classifier · P1-3) uses the classify-role judge layer.
// Tier 3 (cloud LLM · deferred) can plug into this same `MissionRouter` interface;
// the public surface stays stable so consumers
// (`elanous/route/predict` envelope · iOS chip · …) don't churn.
//
// Default mission → provider map mirrors the ROADMAP §3.1 table:
//   plan     → claude (opus tier)
//   build    → codex-app-server (gpt-5)
//   review   → gemini (pro)
//   research → gemini (flash)
//   quick    → claude (haiku tier)
//   vision   → gemini (pro)
//
// User overrides via `~/.elanous/config.json` `llm.missionRouting` (P1-2)
// flow through MissionRoutingConfig — pass the user-config slice into
// createMissionRouter({ config }) at boot.

import { judge } from './judge-layer.js';

export type MissionKind = 'plan' | 'build' | 'review' | 'research' | 'quick' | 'vision';

export type MissionAttachmentKind = 'image' | 'audio' | 'video' | 'document';

export interface MissionAttachment {
  kind: MissionAttachmentKind;
}

export interface MissionPredictionInput {
  text: string;
  sessionId?: string;
  attachments?: ReadonlyArray<MissionAttachment>;
}

export interface MissionPrediction {
  mission: MissionKind;
  provider: string;
  /** Resolved model name when configured · undefined falls back to provider default. */
  model?: string;
  /** Heuristic confidence in [0, 1]. P1-3 uses < 0.6 to trigger Tier 2. */
  confidence: number;
  /** 1 = heuristic · 2 = local LLM (P1-3) · 3 = cloud LLM (deferred). */
  tier: 1 | 2 | 3;
  /** Optional ranked runner-ups (same provider field, different confidence). */
  alternatives?: Array<{ provider: string; confidence: number }>;
}

export interface MissionRouter {
  predict(input: MissionPredictionInput): Promise<MissionPrediction>;
}

/** Slice persisted under `llm.missionRouting` in user-config (P1-2). */
export interface MissionRoutingConfig {
  /** `auto` (default) routes via predictor · `manual` pins to current backend. */
  mode?: 'auto' | 'manual';
  missions?: Partial<Record<MissionKind, MissionRoutingEntry>>;
}

export interface MissionRoutingEntry {
  provider: string;
  model?: string;
}

// ── Built-in mission → provider/model defaults ──

export const DEFAULT_PROVIDER: Record<MissionKind, string> = {
  plan: 'claude',
  build: 'codex-app-server',
  review: 'gemini',
  research: 'gemini',
  quick: 'claude',
  vision: 'gemini',
};

export const DEFAULT_MODEL: Partial<Record<MissionKind, string>> = {
  plan: 'claude-opus-4-7',
  build: 'gpt-5',                    // build=codex-app-server 라우팅(catalog/openai 아님·codex SKU)
  review: 'gemini-3.1-pro-preview',  // 2026-07-15 정정: gemini-3-pro(미확정 id) → catalog canonical
  research: 'gemini-3.7-flash',
  quick: 'claude-haiku-4-5',
  vision: 'gemini-3.1-pro-preview',
};

// ── Slash override (P2-2 · 2026-05-14) ──
//
// User types `/c plan this` → mission router skips heuristic + Tier 2,
// returns provider=claude with mission='quick' and tier=1 + confidence=1.0
// so callers (iOS chip · PWA chip) see an unambiguous force. The slash
// token itself is left in the text; downstream send paths may strip it
// if they choose (out of scope here — single-source mapping table only).
//
// Mapping:
//   /c claude      (provider=claude · default model)
//   /g gemini      (provider=gemini · gemini-3.1-pro-preview)
//   /o codex       (provider=codex-app-server · gpt-5)
//   /l local       (provider=local · model from user-config)
//   /h haiku       (provider=claude · claude-haiku-4-5)

interface SlashRule {
  provider: string;
  model?: string;
}

const SLASH_OVERRIDES: Record<string, SlashRule> = {
  c: { provider: 'claude', model: 'claude-opus-4-7' },
  g: { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
  o: { provider: 'codex-app-server', model: 'gpt-5' },
  l: { provider: 'local' },
  h: { provider: 'claude', model: 'claude-haiku-4-5' },
};

const SLASH_PATTERN = /^\/([cgolh])(?:\s|$)/i;

/** Detect an opening slash-override token in the user input. Returns
 *  the matched rule + the lower-case key when present, undefined when
 *  the input doesn't start with a recognized slash form. */
export function detectSlashOverride(text: string): { key: string; rule: SlashRule } | undefined {
  const m = SLASH_PATTERN.exec(text.trimStart());
  if (!m) return undefined;
  const key = m[1]!.toLowerCase();
  const rule = SLASH_OVERRIDES[key];
  if (!rule) return undefined;
  return { key, rule };
}

// ── Tier 1 heuristic — Korean + English bilingual regex ──
//
// Patterns deliberately avoid `\b` for Korean (word boundaries don't
// apply to Hangul). Each list uses Unicode-property classes via the
// `/u` flag where Hangul tokens appear. Order matters: vision wins
// over text patterns when an image is attached, and the patterns
// below are evaluated in declared order — first match wins, so
// keep narrower buckets above broader ones.

const PATTERNS: Array<{ mission: MissionKind; re: RegExp; confidence: number }> = [
  // Plan — design / architecture / planning verbs. `spec` is left out
  // intentionally: it shows up as a noun ("per this spec") in build
  // requests too often to be a reliable plan signal.
  {
    mission: 'plan',
    re: /(\bplan\b|\bdesign\b|\barchitect(?:ure)?\b|\bsketch\b|\boutline\b|구상|계획|설계|기획|아키텍처)/iu,
    confidence: 0.78,
  },
  // Build — implementation / refactor / fix verbs.
  {
    mission: 'build',
    re: /(\bimplement\b|\bbuild\b|\bcode\b|\bcoding\b|\bwrite\b|\bfix\b|\brefactor\b|\bport\b|구현|작성해|짜줘|만들어|리팩터링|리팩토링|코딩|코드\s*(?:작성|짜|쓰)|버그\s*수정|고쳐)/iu,
    confidence: 0.75,
  },
  // Review — audit / critique / improve.
  {
    mission: 'review',
    re: /(\breview\b|\baudit\b|\bcritique\b|\bevaluate\b|\bassess\b|\bimprove\b|평가|검토|리뷰|봐줘|개선|점검|살펴)/iu,
    confidence: 0.72,
  },
  // Research — search / lookup / investigate.
  {
    mission: 'research',
    re: /(\bresearch\b|\bsearch\b|\bfind\b|\blook\s*up\b|\binvestigate\b|\bexplore\b|찾아|조사|리서치|검색|알아봐|알려줘|조회)/iu,
    confidence: 0.7,
  },
];

const SHORT_INPUT_THRESHOLD = 20;

/** Heuristic-only classification. Pure · no I/O · same input → same output. */
export function classifyMissionTier1(input: MissionPredictionInput): {
  mission: MissionKind;
  confidence: number;
} {
  const attachments = input.attachments ?? [];
  // 1. Image attachment is unambiguous vision intent — wins over everything.
  if (attachments.some((a) => a.kind === 'image')) {
    return { mission: 'vision', confidence: 0.95 };
  }
  // 2. Video attachments also route to vision (frame extraction at send time).
  if (attachments.some((a) => a.kind === 'video')) {
    return { mission: 'vision', confidence: 0.9 };
  }
  const text = (input.text ?? '').trim();
  // 3. Pattern match first — a short Korean prompt like "설계해줘"
  //    (12 chars) still carries clear plan intent and must not be
  //    drowned by the short-input rule.
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      return { mission: p.mission, confidence: p.confidence };
    }
  }
  // 4. Short input with no pattern signal → quick (fast tier).
  //    Catches "ㅇㅇ" / "ok" / "네" / "go" / "yes please".
  if (text.length > 0 && text.length <= SHORT_INPUT_THRESHOLD) {
    return { mission: 'quick', confidence: 0.7 };
  }
  // 5. Fallback — quick with low confidence (Tier 2 will pick this up).
  return { mission: 'quick', confidence: 0.4 };
}

function resolveEntry(
  mission: MissionKind,
  config: MissionRoutingConfig | undefined,
): MissionRoutingEntry {
  const override = config?.missions?.[mission];
  if (override && typeof override.provider === 'string' && override.provider.length > 0) {
    return { provider: override.provider, model: override.model };
  }
  return { provider: DEFAULT_PROVIDER[mission], model: DEFAULT_MODEL[mission] };
}

/** Tier 2 seam — injected LLM classifier (P1-3). When confidence from
 *  Tier 1 drops below TIER2_THRESHOLD the router calls this client
 *  to refine the mission with a grammar-constrained 1-token
 *  prediction. Implementations are pluggable — the substrate today
 *  is the LocalLLMPool slot abstraction in
 *  src/background-reasoning/local-llm-process.ts; a future PR wires
 *  the qwen-2.5 grammar path through.
 *
 *  Contract: classify with the supplied classify-role provider/model,
 *  respond with one of the 6 MissionKind strings + a confidence in [0, 1].
 *  Throw on unrecoverable error; the router
 *  swallows and falls back to Tier 1. */
export interface MissionLocalLLMClient {
  classify(input: {
    text: string;
    attachments?: ReadonlyArray<MissionAttachment>;
    /** The classify-role selection the client must use. */
    provider: string;
    model: string;
  }): Promise<{ mission: MissionKind; confidence: number; /** The model actually used — must equal the requested one or the decision is discarded. */ model?: string }>;
}

export const TIER2_CONFIDENCE_THRESHOLD = 0.6;

/** 30 s TTL · per-prompt LRU cache. Bound at 64 entries so a long-
 *  lived daemon doesn't drift unbounded. */
const TIER2_CACHE_TTL_MS = 30_000;
const TIER2_CACHE_LIMIT = 64;

class MissionLRU {
  private store = new Map<string, { value: { mission: MissionKind; confidence: number }; expiresAt: number }>();
  constructor(private readonly ttlMs: number, private readonly limit: number) {}
  get(key: string, nowMs: number): { mission: MissionKind; confidence: number } | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= nowMs) {
      this.store.delete(key);
      return undefined;
    }
    // Touch — move to end so LRU eviction targets cold entries.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }
  set(key: string, value: { mission: MissionKind; confidence: number }, nowMs: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: nowMs + this.ttlMs });
    while (this.store.size > this.limit) {
      const firstKey = this.store.keys().next().value;
      if (firstKey === undefined) break;
      this.store.delete(firstKey);
    }
  }
  /** Test-only helper. */
  size(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
}

function tier2CacheKey(input: MissionPredictionInput): string {
  const text = (input.text ?? '').trim().toLowerCase();
  const kinds = (input.attachments ?? []).map((a) => a.kind).sort().join(',');
  return `${kinds}|${text}`;
}

/** Default factory. When `localLLM` is provided AND Tier 1 confidence
 *  falls below TIER2_CONFIDENCE_THRESHOLD, the router calls Tier 2
 *  with a 30 s LRU cache in front. Tier 2 errors degrade gracefully
 *  to the Tier 1 result so chat input never stalls on classifier
 *  hiccups.
 *
 *  `configProvider` is invoked on every predict() so user-config edits
 *  (`elanous config mission set …`) take effect without a daemon
 *  restart. Static `config` (when configProvider is omitted) is the
 *  legacy path — kept for tests that want a frozen slice. */
export function createMissionRouter(opts?: {
  config?: MissionRoutingConfig;
  configProvider?: () => MissionRoutingConfig | undefined;
  localLLM?: MissionLocalLLMClient;
  /** Test seam — override the wall clock for cache TTL determinism. */
  now?: () => number;
}): MissionRouter {
  const staticConfig = opts?.config;
  const configProvider = opts?.configProvider;
  const localLLM = opts?.localLLM;
  const now = opts?.now ?? (() => Date.now());
  const cache = new MissionLRU(TIER2_CACHE_TTL_MS, TIER2_CACHE_LIMIT);
  return {
    async predict(input) {
      // P2-2 slash override — wins over everything (heuristic, Tier 2,
      // user config). `/c plan this` forces provider=claude regardless
      // of pattern match or rotation entry.
      const slash = detectSlashOverride(input.text ?? '');
      if (slash) {
        return {
          mission: 'quick',
          provider: slash.rule.provider,
          model: slash.rule.model,
          confidence: 1.0,
          tier: 1,
        };
      }
      const t1 = classifyMissionTier1(input);
      let mission = t1.mission;
      let confidence = t1.confidence;
      let tier: 1 | 2 | 3 = 1;
      if (localLLM && t1.confidence < TIER2_CONFIDENCE_THRESHOLD) {
        const key = tier2CacheKey(input);
        const cached = cache.get(key, now());
        if (cached) {
          mission = cached.mission;
          confidence = cached.confidence;
          tier = 2;
        } else {
          const decision = await judge({
            site: 'llm.mission-router', prompt: JSON.stringify({ text: input.text ?? '', attachments: input.attachments ?? [] }),
            call: async ({ provider, model }) => {
              const refined = await localLLM.classify({ text: input.text ?? '', attachments: input.attachments, provider, model });
              // Enforce the classify-role model: a client that ignored it (or can't say) doesn't get to decide.
              return { text: refined.model === model && model ? JSON.stringify(refined) : 'null', modelId: refined.model };
            },
            schema: (value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
              const row = value as Record<string, unknown>;
              if (typeof row.mission !== 'string' || !Object.hasOwn(DEFAULT_PROVIDER, row.mission) ||
                  typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) ||
                  row.confidence < 0 || row.confidence > 1) return null;
              return { mission: row.mission as MissionKind, confidence: row.confidence };
            },
          });
          if (decision.ok) {
            cache.set(key, decision.value, now());
            mission = decision.value.mission;
            confidence = decision.value.confidence;
            tier = 2;
          }
        }
      }
      // configProvider runs per-call so user-config edits propagate
      // without a daemon restart. Errors in the provider degrade to
      // static fallback — never break a predict on a config blip.
      let liveConfig: MissionRoutingConfig | undefined = staticConfig;
      if (configProvider) {
        try {
          liveConfig = configProvider() ?? staticConfig;
        } catch {
          liveConfig = staticConfig;
        }
      }
      const entry = resolveEntry(mission, liveConfig);
      return {
        mission,
        provider: entry.provider,
        model: entry.model,
        confidence,
        tier,
      };
    },
  };
}

// ── Lazy singleton for production wire (parallel to globalAgentCliConversationStore) ──

let _global: MissionRouter | undefined;

/** Lazy singleton — created on first call · safe under repeated import.
 *  Pass `configProvider` during boot so user-config edits take effect
 *  without restarting the daemon. The static `config` form is kept
 *  for callers that intentionally want a frozen slice. */
export function globalMissionRouter(
  arg?: MissionRoutingConfig | (() => MissionRoutingConfig | undefined),
): MissionRouter {
  if (_global === undefined) {
    if (typeof arg === 'function') {
      _global = createMissionRouter({ configProvider: arg });
    } else {
      _global = createMissionRouter({ config: arg });
    }
  }
  return _global;
}

/** Test seam — drop the cached singleton so the next call rebuilds. */
export function resetGlobalMissionRouter(): void {
  _global = undefined;
}
