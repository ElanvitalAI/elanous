import type { UserConfig } from "./schema.js";
import type { SkillTier } from "../skills/skill-tier.js";
import type { UrlRoutingConfig } from "../skills/url-router.js";
import type { DevRequestRoutingConfig } from "../skills/dev-request-router.js";
import type { DraftOnStopMode } from "../self-implement/draft-on-stop-mode.js";
import type { FoldMode } from "../log-entry.js";
import type { StreamingMode } from "../session/streaming/stream-compositor.js";
import type { ModelTier } from "../model-tier/types.js";
import type { RubricAxis } from "../release-loop/rubric-types.js";
import type { BashApprovalMode } from './shell.js';

// ── SkillRouter (existing) ───────────────────────────────────────────

export interface SkillRouterConfig {
  autoRoute: boolean;
  autoRouteCountdownMs: number;
  llmFallback: boolean;
  keywordScoreThreshold: number;
  llmConfidenceThreshold: number;
  autoRouteMinScore: number;
  autoRouteRequireAutoTrigger: boolean;
  /** Min active-model tier that unlocks full-menu LLM routing (classifier
   *  routes the whole menu when keyword is weak/empty). Default 'T1' —
   *  only frontier models; set 'T3' to also let local models route the
   *  full menu (measured: viable for capable local coders). 2026-07-20. */
  fullMenuTier: SkillTier;
  /** Confidence floor for a full-menu pick (stricter than the tiebreaker
   *  llmConfidenceThreshold). Default 0.85 — empirically separates true
   *  picks from casual-mention false-positives. 2026-07-20. */
  fullMenuConfidenceThreshold: number;
  /** S2 (2026-07-22) — extra skill names the harness may AUTO-EXECUTE
   *  during grounding, MERGED onto the built-in read-only allowlist
   *  (omni-digest/omni-market/kr-flow). Empty (default) = built-ins only
   *  (no change). Agent-batch/high-cost skills (stochastic-*, *-panel,
   *  *-consensus) are force-rejected even if listed. This is the
   *  operator-facing knob answering "autoTrigger 켜면 되지 않나" for the
   *  harness path (the dashboard path uses autoRouteRequireAutoTrigger). */
  harnessExecAllowlist: string[];
}

// ── LLM ──────────────────────────────────────────────────────────────

export type LLMProviderName =
  | 'auto' | 'grok' | 'openai' | 'anthropic' | 'local' | 'openai-codex' | 'gemini'
  // Chinese chat-model families · OpenAI-compatible cloud APIs.
  // Local open-weight variants (Kimi-VL · Qwen3.6 · GLM-Z1 etc.) still
  // route through the existing 'local' provider — these `kimi/qwen/glm`
  // entries name the *cloud* surface only.
  | 'kimi' | 'qwen' | 'glm'
  // 대표 2026-09-23 — OpenAI 호환 게이트웨이. kimi·qwen·glm 의 «첫 실제 경로»(모델 id `openrouter/<vendor>/<model>`).
  | 'openrouter'
  | 'opengateway'
  // 대표 2026-10-10 (BEDROCK-PROVIDER) — AWS Bedrock 의 Claude. 자격 = AWS 기본 자격 체인 · 명시 선택 전용(auto·폴백 후보 아님).
  | 'bedrock' | 'hq-proxy';

/** Provider-agnostic reasoning intensity. The HUD click cycle and the
 *  `/reasoning` slash command both operate on this 4-state cycle —
 *  each provider that supports a "think before answering" mode (codex
 *  Responses API, anthropic extended thinking, future gemini) maps
 *  `low`/`medium`/`high` onto its own native spec, and `off` always
 *  means "send no reasoning option / opt out". The native specs differ
 *  in granularity (codex has effort + summary, anthropic has
 *  budget_tokens, etc.) but the user-facing surface stays a single
 *  level for cross-provider muscle memory. */
/** ⭐ `xhigh` 추가(대표 2026-09-23). 📏 Codex API 가 400 으로 직접 답한 지원값은
 *  `none·minimal·low·medium·high·xhigh·max` 일곱이고, 실호출로 `xhigh`·`max` 수용을 확인했다.
 *  ⛔ 이 타입은 «provider 공통» 축이다 — `xhigh` 를 못 받는 provider·모델(anthropic·gemini·grok,
 *  그리고 `reasoningEffortCeiling` 이 high 이하인 모델)에서는 «high 로 깎인다»(wire 변환에서).
 *  `max` 는 «일부러» 안 넣었다 — 요청 범위 밖이고, 별칭 `max`(→ tier loaded)와 이름이 겹친다. */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export interface LLMConfig {
  provider: LLMProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Host that owns Codex OAuth refresh authority. Defaults to the HQ's mbp host. */
  codexTokenOwnerHost?: string;
  /** Override the text stream idle watchdog in milliseconds. Omitted keeps provider/family defaults. */
  streamIdleTimeoutMs?: number;
  /** OpenRouter 설정 한 곳(두 골이 같은 키를 쓴다):
   *  - `providerPreferences` — 상류 라우팅 선호; 도구 가능 기본값(require_parameters·allow_fallbacks)을 얕게 덮는다(OR-LLM-ROUTING-1).
   *  - `fallbackModel` — 유료 OpenRouter 폴백 모델; 체인에 openrouter 를 명시하고 모델·키를 모두 줄 때만 선택된다(OR-FALLBACK-TIER-1).
   *  - `upstreamPins` — 모델별 상류 고정 `{ "<wire id>": ["<상류 slug>", …] }`(OR-DEEPSEEK-TUNE · 지금은 deepseek/* 만 읽는다).
   *    기본값 = `src/llm/openrouter-upstream-pins.config.ts` · 모델별로 덮는다 · `[]` = 그 모델 고정 안 함.
   *    `providerPreferences` 에 order·only·allow_fallbacks 가 있으면 그쪽이 이긴다. */
  openrouter?: { providerPreferences?: Record<string, unknown>; fallbackModel?: string; upstreamPins?: Record<string, string[]> };
  /** Ordered rotation of providers the user can cycle through with
   *  `elanous provider:rotate` / `/provider next`. Each entry is a
   *  full (provider, model, apiKey, baseUrl) tuple that gets
   *  promoted to the active LLMConfig top-level fields when
   *  selected. Optional label used for `/provider use <label>`
   *  shortcuts and the rotation list display — defaults to
   *  `${provider}:${model}` when omitted. Empty / undefined list
   *  = no rotation configured (no `next` to advance to). */
  rotation?: RotationEntry[];
  /** ⭐⭐ codex «계정» 자동 회전 — 주간 리밋에 걸린 계정에서 다른 계정으로 넘긴다(`S4`).
   *  ⛔ **기본 ON** (대표 결정 2026-08-05) — `false` 일 때만 꺼진다.
   *  ⛔ 이것은 provider 회전(`rotation`)과 «다른 축»이다: 저 축은 provider·모델을 바꾸고,
   *    이 축은 «같은 provider 안에서 어느 계정의 토큰을 쓸지»를 바꾼다.
   *  리셋 크레딧 자동 소비는 별도 일일 상한으로 제한한다. */
  codexAccountRotation?: boolean;
  /** REVIEW-ACP-POD — Pod merge-ready PR 을 병합 전에 호스트 Claude ACP(구독)로 리뷰한다. `true` 일 때만 켜진다(기본 꺼짐 = 종전).
   *  env `ELANOUS_POD_HOST_ACP_REVIEW` 가 이 값보다 앞선다. ACP 를 못 쓰면 종전 길(Pod 리뷰 → 재게이트). */
  podHostAcpReview?: boolean;
  /** ⭐⭐ codex 계정 «알림» — 회전·리셋크레딧 소비를 텔레그램 등 outbound 로 보낼지.
   *  ⛔ **기본 ON** — `false` 일 때만 조용해진다.
   *  ⛔⭐ 위 `codexAccountRotation` 과 «다른 축»이다(대표 지시 2026-08-17 *"회전을 끄라는 게
   *    아니라 텔레그램 알림만"*). 종전엔 노브가 회전 하나뿐이라 알림을 끄면 «구독 과금 경로»까지
   *    죽었고, 그러자 한도 100% 계정에 고정되는 반대편 사고로 갔다(실측 30분 133건 → 회전 정지).
   *  ⛔ 꺼도 «조용히» 사라지지 않는다 — `oauth.codex-account / outbound-suppressed` 로 남는다. */
  codexAccountAlerts?: boolean;
  /** ⭐ 회전 «선제» 임계(%) — 사용률이 이 값 «이상»이면 리밋에 걸리기 «전»에 넘긴다.
   *  ⛔ 기본 95. 1~100 밖이거나 수가 아니면 판정기가 기본값을 쓴다(`#7579`).
   *  ⚠️ 이 셋(타입·파서·재노출)이 «다» 있어야 노브가 산다 — 위 형제 주석이 그 실측이다.
   *    `#7579` 는 이 셋을 «하나도» 안 넣어서 노브가 no-op 이었다(2026-08-07 실측으로 잡았다). */
  codexAccountRotationThresholdPercent?: number;
  /** Account-specific rotation thresholds; invalid entries fall back to the normalized global threshold. */
  codexAccountRotationThresholdPercentByAccount?: Record<string, number>;
  /** 회전이 «먼저 쓸» 계정 순서. 없으면 이름 코드포인트 순.
   *  🩸 2026-09-24(대표): 「third 부터 소진하고 그다음 team」 — 이름순(default<new<third)으론 못 만든다.
   *  ⛔ 여기 없는 계정은 버리지 않는다 — 뒤로 가서 이름순으로 붙는다. */
  codexAccountOrder?: string[];
  /** Automatic reset-credit uses across all Codex accounts per UTC day; default 1, 0 disables. */
  codexResetAutoConsumePerDay?: number;
  /** 대표 2026-09-28 «크레딧 사용 허가» — 주간 한도가 찬 codex 계정도 «선불 크레딧으로 계속» 쓴다(서버가 한도 소진 시 크레딧으로 넘긴다).
   *  켜면 회전이 «후보 없음»(→ grok 폴백) 대신 지금 계정에 머물고, Pod 배분도 찬 계정을 사용률 낮은 순으로 쓴다.
   *  순서는 여전히 «구독 잔량이 남은 계정 먼저». 기본 꺼짐(크레딧은 돈이다). */
  codexCreditsAllowed?: boolean;
  /** 대표 2026-09-28 codex «한도 정책» — 한도가 차면 무엇을 하나(`src/oauth/codex-quota-policy.ts` 가 canonical):
   *  `within-quota`(한도 안에서만 · 전부 차면 멈춤) · `fallback`(한도 안 ⊕ 폴백 체인 · 기본) · `credits`(크레딧까지).
   *  회전·Pod 배분·폴백·매시 한도 알림이 «이 한 값»을 같이 읽는다. 없으면 옛 `codexCreditsAllowed` 를 읽는다. */
  codexQuotaPolicy?: 'within-quota' | 'fallback' | 'credits';
  /** SUBSCRIPTION-EXHAUST-REROUTE (0.2.24) — codex 선불 크레딧 «예비분». 잔액이 이 값 이하로 «알려지면» 크레딧을 쓰지 않고
   *  회전이 `no-candidate` 를 내 폴백(우선 openrouter)으로 넘긴다. 잔액을 모르면 종전. 없으면 2000(`DEFAULT_CODEX_CREDIT_RESERVE`). */
  codexCreditReserve?: number;
  /** Grok weekly launch usage ceiling (percent); defaults to 80. */
  grokWeeklyCapPct?: number;
  /** 대표 2026-10-11 ZAI-CODING-PLAN-PROVIDER — `glm` 직결(Z.ai 코딩 엔드포인트 · `ZAI_API_KEY` 가 있을 때만 선다).
   *  `overage` = 플랜 창이 차면 무엇을 하나(codex `codexQuotaPolicy` 와 같은 축 · `src/llm/zai-coding-plan.ts` 가 canonical):
   *  `stop`(멈춤 · 기본) · `balance`(계정 잔액 «extra usage» 로 계속 · 잔액/월 상한이면 OpenRouter) · `openrouter`(바로 OpenRouter).
   *  `maxConcurrent` = 프로세스당 동시 호출 상한(기본 3). */
  zaiCodingPlan?: { overage?: 'stop' | 'balance' | 'openrouter'; maxConcurrent?: number };
  /** ⭐⭐ codex 가 «소진된 뒤» 갈 곳을 «순서»로 정한다 (대표 2026-08-13).
   *
   *  값: `['codex-rotate', 'grok']` 등 — 아는 칸은 `FALLBACK_STEPS`, 모르는 이름은 버린다(관측에 남는다).
   *  `openrouter` 는 명시적 체인·`llm.openrouter.fallbackModel`·API 키가 모두 있어야 한다(유료).
   *  ⛔ **미설정이면 `DEFAULT_FALLBACK_CHAIN`(`src/oauth/fallback-chain.ts`) = `['codex-rotate','grok']`** — 설정이 없어도 grok 으로 샌다(#10575).
   *    막으려면 `['codex-rotate']` 를 «명시»한다. 이 인스턴스의 값은 `elanous config get llm.fallbackChain` 으로 잰다.
   *
   *  ⭐ `grok` 칸이 안전한 이유: elanous 의 grok 경로는 ACP·프로바이더 «둘 다» 구독으로
   *    나간다(env 스크럽 ⊕ `resolveGrokCredential` 구독 1순위). 소진을 피하려다
   *    «다른 지갑을 여는» 일이 없다.
   *  ⚠️ 회전을 끄고(`codexAccountRotation: false`) `['grok']` 만 두는 구성도 성립한다 —
   *    「회전을 껐다」가 「grok 도 싫다」는 뜻은 아니다.
   *  ⛔ 판정은 `src/oauth/fallback-chain.ts` 가 «순수 함수»로 한다(전수 테스트). */
  fallbackChain?: string[];
  /** Ordered model ids to try when the primary review provider is unavailable. */
  reviewFallbackModels?: string[];
  /** Provider-agnostic reasoning level — primary control. Mapped per
   *  provider:
   *  - codex: low={effort:low, summary:concise}, medium={medium,detailed},
   *    high={high,detailed}, off=no reasoning block.
   *  - anthropic: low/medium/high → extended-thinking budget_tokens
   *    2k/8k/32k, off=no thinking.
   *  Other providers ignore (treat as off). When `codexReasoning` is
   *  ALSO set it takes precedence — it's the advanced fine-grained
   *  override for users who want to tune effort and summary
   *  independently. */
  reasoningLevel?: ReasoningLevel;
  /** Codex Responses API reasoning options (gpt-5 family only).
   *  Advanced fine-grained override — when set, supersedes
   *  `reasoningLevel` for the codex provider. When the wire body is
   *  built `reasoning: { effort, summary }` ships and
   *  `include: ["reasoning.encrypted_content"]` is added.
   *  - effort: 'minimal'|'low'|'medium'|'high' (model decides depth
   *    of reasoning before answering). undefined → use model default.
   *  - summary: 'auto'|'concise'|'detailed' (granularity of the
   *    reasoning summary surface). undefined → no summary stream
   *    (model still reasons internally, just opaque to the client).
   *  Omit the whole block AND `reasoningLevel` to opt out entirely. */
  codexReasoning?: {
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    summary?: 'auto' | 'concise' | 'detailed';
  };
  /** Tier 2 across-turn goal-execution loop 아밍(2026-07-19 goal-exec). enabled=true 면
   *  codex-family 턴을 `runGoalLoop` 으로 감싸 목표 완료(증거게이트·GOAL-COMPLETE 마커)까지
   *  across-turn 지속·continuation 재주입. 기본 미설정=off(비-아밍·안전). maxIterations 는
   *  폭주 하드캡(기본 8). config-first 아밍(`elanous config set llm.goalLoop.enabled true`). */
  goalLoop?: {
    enabled?: boolean;
    maxIterations?: number;
  };
  /** LLM-judge memory recall(2026-07-19 · 대표 지시 기본 ON). 세션 턴의 기억 주입이 키워드
   *  매칭 대신 경량 LLM 의미판정(WSD·claude-code findRelevantMemories 이식)으로 관련 기억을
   *  고른다. **미설정=ON**(judge 실패 시 키워드 fallback·fail-soft 라 항상 켜도 안전). 끄려면
   *  `enabled: false`. model 미지정 시 luna(경량). `elanous config set llm.memoryJudge.enabled false`. */
  memoryJudge?: {
    enabled?: boolean;
    model?: string;
    /** 크로스 회상(2026-07-19) — 턴 기억 주입에 파일메모리(①) 옆으로 self-log(②·surface_events)
     *  관련 top-K 를 함께 붙인다(한 쿼리로 두 시스템). 미설정=ON·fail-soft. 끄려면 false. */
    crossRecall?: boolean;
  };
  /** Tier 1(2026-07-19 goal-exec) — codex inspect-budget 하드월 면제 아밍. true 면
   *  codex-family 가 inspect-synthesis 강제 정지(2-file 하드스톱) 없이 넓게 조사한다
   *  (read-cap → CODEX_TOOL_DISCIPLINE explore 규율 + compaction 으로 대체·ref codex 동형).
   *  기본 미설정=off(옛 re-read taming 유지·안전). config-first 아밍. 비-codex 무영향. */
  codexInspectExempt?: boolean;
  /** Opt-out for the Codex `store=true` + `previous_response_id` wave.
   *  When true (default) the codex provider asks the backend to persist
   *  each response under the user's account and threads
   *  `previous_response_id` on subsequent turns so it can send only the
   *  delta input items. (CONFIG-ALWAYS-TRUE-OUT 11-05: the `codexStore`
   *  opt-out key was removed — no config ever set it false; an old key is ignored.) */
  /** Gemini safety filter level. Maps onto the native API's
   *  `safetySettings` array (4 categories × threshold). Wave C1
   *  (2026-05-04). Other providers ignore.
   *  - `default`: backend defaults (BLOCK_MEDIUM_AND_ABOVE per category)
   *  - `permissive`: BLOCK_ONLY_HIGH — allows political / creative /
   *    sensitive content that the default tier blocks. Use when the
   *    workflow needs frank discussion of policy / news / fiction.
   *  - `strict`: BLOCK_LOW_AND_ABOVE — conservative, blocks even
   *    borderline content. Use for kid-facing or compliance-sensitive
   *    deployments.
   *  Omit field for backend default. */
  geminiSafety?: 'default' | 'permissive' | 'strict';
  /** Gemini server-side native tools. Wave C2 (2026-05-04). When any
   *  field is true, monad-agent's client-side tool list is augmented
   *  with the corresponding native Gemini tool entry, executed server-
   *  side by Google's infrastructure. Useful when the model needs
   *  fresh information (googleSearch) or sandboxed code execution
   *  (codeExecution) without round-tripping through monad-agent's
   *  Bash/WebFetch. Omit fields for purely client-side tools.
   *  Note: native tools and client-side function declarations can be
   *  mixed in the same request. Other providers ignore. */
  geminiServerTools?: {
    googleSearch?: boolean;
    codeExecution?: boolean;
    urlContext?: boolean;
  };
  /** High-level intent for the tool-loop budget. Maps to per-family
   *  maxTurns when `maxTurns.<family>` is not explicitly overridden.
   *  - `cost`        — fast answers, lowest spend (claude 6 / codex 4 / gemini 4)
   *  - `balanced`    — typical use (claude 12 / codex 6 / gemini 6)
   *  - `quality`     — deeper exploration (claude 24 / codex 8 / gemini 8) — default
   *  - `exhaustive`  — push for completeness (claude 50 / codex 12 / gemini 12)
   *  codex/gemini caps stay tight even in exhaustive mode — their
   *  re-read pathology is real and the docs/HANDOFF measurements show
   *  hard cap is the only reliable brake. claude family swings widest
   *  because Opus self-regulates well (claude-code-fork pattern). */
  answerPriority?: 'cost' | 'balanced' | 'quality' | 'exhaustive';
  /** Per-family tool-loop budget override. When a field is set it
	   *  wins over the `answerPriority` mapping; null/0 means "unlimited"
	   *  (use with care — only safe for self-terminating models like
	   *  Anthropic Opus). When omitted, the field falls back to
	   *  answerPriority's mapping for that family. `default` covers any
	   *  family not explicitly listed (local / gpt / other). grok has
	   *  its own cell — same override path as codex, including unlimited. */
	  maxTurns?: MaxTurnsBudget;
  /** Local LLM (LM Studio / Ollama / MLX / Docker) parameter tuning
   *  policy. 2026-05-05 generalisation of the qwen-only auto-tuning
   *  introduced earlier in the same session — the user explicitly
   *  asked for a YAML-backed registry so per-family recipes live in
   *  documents rather than as scattered regex switches in code, and
   *  so a future tuning UI has a uniform model-id → params map to
   *  read from.
   *
   *  - `'predefined'` (default · undefined) — match the local model
   *    id against the built-in `presets.yaml` (overlaid by
   *    `~/.elanous/local-llm-presets.yaml` when present). Qwen3 family
   *    gets the official thinking-mode recipe (temp 0.6 · top_p 0.95
   *    · top_k 20 · max 8192 · auto `/no_think`); other families get
   *    their vendor-recommended values; unknown ids fall through to
   *    the catch-all `openai-default` (temp 0.3 · max 4096).
   *  - `'custom'` — ignore the registry; apply `localCustomParams`
   *    verbatim. Any field omitted in `localCustomParams` falls
   *    through to provider defaults (e.g. temp 0.3, max 4096).
   *  - `'none'` — apply no preset at all (legacy bare OpenAI-compat
   *    defaults). Useful when running an experimental model where
   *    the registry's catch-all values would mask issues.
   */
  localPresetMode?: 'predefined' | 'custom' | 'none';
  /** Active when `localPresetMode === 'custom'`. Each field maps 1:1
   *  to the OpenAI-compat request body. `auto_prepend_no_think`
   *  controls the qwen `/no_think` soft-switch tag injection (only
   *  meaningful for qwen-family models — silently ignored elsewhere). */
  localCustomParams?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    max_tokens?: number;
    auto_prepend_no_think?: boolean;
  };
  /** P1-2 (iPhone Showroom Phase 1 · 2026-05-14) — mission router
   *  policy. Tier 1 heuristic resolves a mission kind (plan / build /
   *  review / research / quick / vision); the entry under
   *  `missions[<kind>]` decides which provider/model gets that turn.
   *  Omit the slot entirely to take built-in defaults from
   *  `src/llm/mission-router.ts` DEFAULT_PROVIDER / DEFAULT_MODEL.
   *  `mode = 'manual'` short-circuits the router so the user's chip
   *  selection wins — useful when piloting an unfamiliar backend. */
  missionRouting?: MissionRoutingConfig;
  /** Explicit execution policy, independent from missionRouting's legacy
   * prediction table. New behavioural routing policy lives only in config. */
  routePolicy?: LlmRoutePolicyConfig;
  /** PLAN-model-intelligence-router · Part B — content-based per-task
   *  smart router. OFF by default. When `enabled`, turns whose model is
   *  `auto`/unpinned get a `ModelTier` chosen from the input's difficulty
   *  (`src/model-tier/task-router.ts`), then resolved to a concrete model
   *  via the tier ladder. An explicit model pin always bypasses it. This
   *  is orthogonal to `missionRouting` (which routes by mission *kind*,
   *  not content). `useClassifierLlm` enables the hybrid LLM escalation
   *  for ambiguous inputs; when false the router is heuristic-only (no
   *  per-turn LLM cost). */
  autoRoute?: AutoRouteConfig;
}

/** Persisted under `llm.autoRoute`. See {@link LLMConfig.autoRoute}. */
export interface AutoRouteConfig {
  enabled?: boolean;
  useClassifierLlm?: boolean;
  /** Phase B3 — apply the inline nuance nudge ("신중히"↑ / "대충 빨리"↓)
   *  on top of the content tier. */
  applyNuance?: boolean;
}

/** Partial slice persisted under `llm.missionRouting`. Source of truth
 *  for the type is `src/llm/mission-router.ts` — re-declared here to
 *  avoid a runtime import from user-config into the llm subtree. */
export interface MissionRoutingConfig {
  mode?: 'auto' | 'manual';
  missions?: Partial<Record<
    'plan' | 'build' | 'review' | 'research' | 'quick' | 'vision',
    { provider: string; model?: string }
  >>;
}

export interface LlmRoutePolicyConfig {
  /** codex-first keeps subscription-backed Codex tiers as the active coding lane. */
  mode?: 'codex-first' | 'active-provider';
  /** Opus may only be proposed after recorded evidence and HITL approval. */
  opusEscalation?: 'evidence-hitl';
}

/** One entry in the user's provider rotation list. Shape is a
 *  subset of LLMConfig (provider + override fields) plus an
 *  optional display label. When a rotation entry is activated the
 *  runtime copies these fields onto LLMConfig's top level and saves. */
export interface RotationEntry {
  provider: LLMProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Optional short name for CLI / slash picks: `elanous provider:use opus`. */
  label?: string;
}

// ── Skills ───────────────────────────────────────────────────────────

export type SkillSetName =
  | 'claudecode' | 'opencode' | 'codex' | 'hermes' | 'openclaw' | 'custom';

export type SkillSourceKind = 'preset' | 'shared' | 'connected' | 'package';

/** One skill root elanous reads. `mode` is always `ref` today (the folder is read where it is). */
export interface SkillSource {
  id: string;
  path: string;
  kind: SkillSourceKind;
  enabled: boolean;
}

export interface SkillsConfig {
  activeSet: SkillSetName;
  dirs: string[];
  /** Gift redemption API origin; defaults to https://elanous.ai. */
  giftEndpoint?: string;
  /**
   * EN5 — the one source list. On disk it holds only what `elanous connect` registered (kind `connected`, read in
   * place, never copied); the preset (`activeSet`/`dirs`), the shared `~/.agents/skills` root and Claude package
   * roots are derived at read time by `resolveSkillSources()`. The dev-only `connected: string[]` key (EN9, never
   * released) is read and folded in here; the next save writes `sources` instead.
   */
  sources?: SkillSource[];
  /** Explicit skill-name allowlist. When set and non-empty, the skill
   *  index filters to this list — all other skills are hidden from
   *  routing, autocompletion, and `/run-skill`. Use when a project
   *  only ever needs a small subset of the global skill folder. Empty
   *  or absent = no allowlist (all skills visible). Session 21. */
  allow?: string[];
  /** Skill-name blocklist. Takes precedence over `allow`. Use to hide
   *  one or two specific skills without having to enumerate everything
   *  else. Empty or absent = no blocks. Session 21. */
  deny?: string[];
  /** URL→skill auto-routing (PLAN-url-triage-routing-2026-07-22). When a
   *  free-typed message contains a URL and no guard keyword, the mapped
   *  digest/absorb skill auto-fires (interactive surfaces only — TUI +
   *  Telegram). See `skills/url-router.ts`. */
  urlRouting: UrlRoutingConfig;
  /** Conservative pre-LLM implementation-request detector. */
  devRequestRouting: DevRequestRoutingConfig;
  /**
   * Opt-in: append installed Claude package `installPath/skills` directories
   * from the live plugin ledger. Default off — turning this on is the only
   * way package instruction roots join the skill-dir list. Absent/false
   * preserves the previous list exactly.
   */
  includeClaudePackageSkills?: boolean;
  /**
   * Opt-in: convert installed Claude package `installPath/commands/*.md`
   * files into skill-index entries. Independent of
   * `includeClaudePackageSkills` — turning one on does not turn the other
   * on. Default off; absent/false leaves `buildSkillIndex` identical to
   * before this key existed. Discovery is not a skill-dir append (command
   * files are flat markdown, not `SKILL.md` trees).
   */
  includeClaudePackageCommands?: boolean;
}

/**
 * ★ G9 P5a(2026-07-25) — user-config 가 지정한 **유효 skill 디렉토리**를 해석한다. 종전엔 `getSkillIndex()`
 * 가 인자 없이 호출돼 항상 `~/.claude/skills`(LOCAL_SKILLS_DIR)만 봐서 `skills.activeSet`/`skills.dirs`(온보딩·
 * codex/opencode 등)를 **무시**했다(project_mission_toolset_optimality_review 백로그). 이 헬퍼가 그 갭을 메운다.
 * - activeSet !== 'custom' → 그 preset 디렉토리(skillSetDir).
 * - activeSet === 'custom' 또는 preset 미해석 → `dirs`(명시 커스텀).
 * - 둘 다 비면 → `~/.claude/skills`(기본·**무회귀**: 기본 activeSet='claudecode' 도 이 경로로 귀결).
 * - `includeClaudePackageSkills === true` 이면 그 뒤에 원장의 현행 `installPath/skills`
 *   (실재하는 것만, 중복 없이)를 붙인다. 기본값은 끄기 — 목록은 이전과 같다.
 * fail-soft: config 읽기 실패 시 기본 경로(스킬 라우팅이 조용히 죽지 않게).
 */
export interface DefaultSkillDirsOptions {
  /** Override `~/.claude/plugins`. Tests pass a temp root; production omits this. */
  pluginsRoot?: string;
  /** Override the installed package root. Tests pass a temp root; production omits this. */
  bundledSkillsRoot?: string;
  /** Override the shared-agent home for isolated discovery tests. */
  sharedAgentHome?: string;
}

// ── Obsidian ─────────────────────────────────────────────────────────

export interface ObsidianConfig {
  vault: string;
  /** 격리(test) 우주의 «쓰기 시험» 볼트(예 `elantest`) — 읽기는 늘 `vault`. 볼트 쓰기 가드의 허용 목록에 든다(대표·🅞 2026-09-26). */
  testVault?: string;
}

// ── Telegram ─────────────────────────────────────────────────────────

/** Report channel — a SEND-ONLY destination distinct from the Q&A
 *  `homeChannel`. Serves the multi-channel split (2026-07-05): inbound
 *  Q&A stays on the main bot + homeChannel, while reports (cron digests,
 *  autonomous-loop output, trading alerts) route here. `botToken` is
 *  optional — set it when the report channel is served by a DIFFERENT
 *  bot than the Q&A bot (e.g. a channel the user's report bot already
 *  owns); when omitted, the main `telegram.botToken` is reused. */
export interface TelegramReportChannel {
  chatId: number;
  botToken?: string;
}

/** A SEPARATE bot for `elanous telegram-test` — the standalone, isolated test
 *  messenger that runs outside the production daemon. `botToken` (required)
 *  is a distinct BotFather token so getUpdates never 409s against prod;
 *  `allowedUsers` is optional (falls back to the main allowlist). */
export interface TelegramTestChannel {
  botToken: string;
  allowedUsers?: number[];
  /** 무인 주입(scripts/telegram-inject.ts·#24)의 대상 봇 username(예: `@test_helper_bot`). 봇이 여럿일
   *  때 어느 봇(테스트 채널용)에 objective 를 주입할지 명시. env `TELEGRAM_TEST_BOT`/`--to` 로도 지정 가능. */
  botUsername?: string;
}

/** 멀티 봇/채널 — 채널 하나 = 봇 토큰 하나(elanous 전용) + chat + 역할 + 상호작용 여부.
 *  `interactive:true` 면 getUpdates Q&A 폴러를 띄우고, `false` 면 발송 전용(noti-only).
 *  `roles` 는 발송 라우팅 태그(qa/alert/report/digest 등). 변경은 재시작 시 적용(정적).
 *  channels 미지정 시 legacy botToken/homeChannel/reportChannel 에서 자동 파생. */
export interface TelegramChannel {
  name: string;
  botToken: string;
  chatId: number;
  interactive: boolean;
  roles: string[];
  /** 봇 username(예: `primary_bot`). 무인 유틸(scripts/telegram-inject.ts)이
   *  role/name 으로 대상 봇을 config 한 곳에서 찾도록 하는 조회용 필드. 선택. */
  botUsername?: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  allowedUsers: number[];
  /** Q&A channel — inbound + default outbound for the main bot. */
  homeChannel?: number;
  /** Send-only report destination (may use a separate bot). */
  reportChannel?: TelegramReportChannel;
  /** ★ 멀티 채널(명시). 지정 시 legacy 파생 대신 이 목록을 쓴다. resolveTelegramChannels 참조. */
  channels?: TelegramChannel[];
  /** Standalone `elanous telegram-test` bot — separate token, isolated,
   *  runs outside the production daemon. */
  testChannel?: TelegramTestChannel;
  /** 누가 Q&A 폴링을 하나 — 기본(없음·`'nexus'`)은 넥서스 데몬, `'standalone'` 이면
   *  넥서스는 폴링하지 않고 `elanous telegram run` 이 맡는다. */
  poller?: 'nexus' | 'standalone';
  /** 레거시 kind→역할 설정(읽기 호환). 선택한 채널의 봇이 kind 정책의
   *  운영/매매 경계를 지킬 때만 발송 라우팅에 적용한다. */
  kindRoles?: Record<string, string>;
  /** `#현장` 캡션에 행사 슬러그가 없을 때 쓸 기본 행사(예: `marketers-night-2026-10`). 없으면 `field-<로컬 날짜>`. */
  fieldDefaultEvent?: string;
  /** `#현장` 영상의 기본 렌더 모드. 미지정 시 standard, 캡션의 `즉석`/`instant` 가 우선. */
  fieldReelMode?: 'standard' | 'instant';
  /** 대화를 처음 열거나 6시간 이상 쉰 뒤 첫 말 앞에 `/v1/context/now` 요약을 한 메시지로 보낸다. 기본 켬. `false` 만 끈다. */
  contextFirst?: boolean;
}

// Discord mirrors Telegram's shape. User / channel IDs are Discord
// snowflakes (64-bit integers) — kept as strings since JS numbers
// can't represent full 64-bit range safely.
/** `elanous discord-test` scope (PLAN-multi-surface-pty-shell M4a-0) —
 *  SAME app/token as production (Discord gateway allows concurrent
 *  sessions per token, unlike telegram's 409-forced split; 실측
 *  2026-07-12), isolated by CHANNEL: the test runner only processes
 *  messages in `channelId`. `botToken` is an optional escape hatch
 *  for full-app isolation if ever needed. */
export interface DiscordTestChannel {
  /** Dedicated guild text channel snowflake (e.g. #elanous_test). */
  channelId: string;
  /** Optional allowlist override (falls back to discord.allowedUsers). */
  allowedUsers?: string[];
  /** Optional separate bot token (default: reuse discord.botToken). */
  botToken?: string;
}

export interface DiscordConfig {
  enabled: boolean;
  botToken?: string;
  /** Discord user IDs (snowflake strings) permitted to DM the bot.
   *  Empty = refuse everyone (safer default than "allow all"). */
  allowedUsers: string[];
  /** Channel snowflake for cron / push output (optional). */
  homeChannel?: string;
  /** EV12c — guild text channels where the production bot chats like a DM (allowlist still applies).
   *  Empty / absent = DM-only, as before. */
  chatChannels?: string[];
  /** Standalone `elanous discord-test` scope — same token, dedicated
   *  channel, isolated state. See DiscordTestChannel. */
  testChannel?: DiscordTestChannel;
  /** 첫 말·6시간 쉼 뒤 일반 답 앞에 맥락 요약을 보낸다. 기본 켬, false 만 끈다. */
  contextFirst?: boolean;
}

// ── Onboarding ───────────────────────────────────────────────────────

export interface OnboardingConfig {
  webFirst?: boolean;
  ready?: boolean;
  completed: boolean;
  completedAt?: string;
  version: number;
}

// ── Tools ────────────────────────────────────────────────────────────
// ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 2 · W2.9.
// Configures the tier-flip / deferred-tools behaviour at the user
// level. `deferred.mode === 'off'` opts out — every catalog spec is
// passed to the provider every turn (the pre-Wave-2 behaviour). Used
// for A/B baseline measurement (M1–M5) and for unblocking diagnosis
// when a deferred tool is misbehaving.
//
// `[[feedback_user_config_over_env]]`: env vars are NOT a fallback —
// the only knob is user-config. Tests inject via `getUserConfig` mock
// or by passing `enabled` directly to `applyDeferredTools`.

export type DeferredToolsMode = 'always' | 'off';

export interface DeferredToolsConfig {
  /** 'always' (default) — split catalog into active/deferred every
   *  turn. 'off' — ship every tool's full schema (pre-Wave-2 path).
   *  Anything else → coerced to 'always' at load time. */
  mode: DeferredToolsMode;
}

export interface AgentSpawnConfig {
  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 5 E3 —
   *  HOP_CAP. Max spawn-tree depth before `AgentRegistry.spawn`
   *  rejects with `AgentHopCapExceededError`. Default 5. Set 0 to
   *  forbid any nested spawn (top-level only). */
  hopCap: number;
}

export interface SelfImplementAutoStopConfig {
  enabled: boolean;
  minRung: number;
}

export interface SelfImplementAutoAssistConfig {
  enabled: boolean;
  minRung: number;
}

export interface SelfImplementScreenStallTerminationConfig {
  enabled: boolean;
  minRung: number;
}

export interface SelfImplementReworkBudgetConfig {
  /** false = 예산 판정기(UNCONVERGEABLE 등)를 실제로 따른다. 기본 false — 운영이 늘 쓰던 값(대표 결정 2026-09-24). */
  shadowStop: boolean;
  /** Maximum adaptive/supervisor rework rounds. 기본 3 — 운영 값과 맞춤(대표 결정 2026-09-24 · 이전 코드 기본 6). */
  maxRounds: number;
}

export interface SelfImplementDecompositionShadowConfig {
  enabled: boolean;
}

export interface SelfImplementClarificationEscalationConfig {
  enabled: boolean;
  /** ⛔ 기본값을 «두지 않는다». 유효한 값이 설정에 있을 때만 존재한다 —
   *  근거 없이 고른 수는 「재지 않고 정한 값」이 되고, 그 뒤로 아무도 다시 안 잰다.
   *  ⇒ 값이 없으면 리졸버를 설치하지 않는다(무한 대기 금지가 우선). */
  timeoutMs?: number;
}

export type SelfImplementChildInstanceMode = 'isolated' | 'inherit';

/** 자식 LLM 선호. `pinned` = 기존 provider·model 한 칸. `auto` = 사용자 `chain` 순서. */
export type ChildLlmPreferenceMode = 'pinned' | 'auto';

export interface ChildLlmChainEntry {
  provider: string;
  model?: string;
}

export interface ChildLlmPreferenceConfig {
  /** 있으면 pinned 의 값. 기존 고정 설정. */
  provider?: string;
  /** 기존 고정 설정. provider 없이 model 만 있으면 mode 는 auto 다. */
  model?: string;
  /** 없으면 provider 가 있을 때 pinned, 없을 때 auto. model 만 있어도 provider 가 없으면 auto. */
  mode?: ChildLlmPreferenceMode;
  /** auto 일 때의 사용자 순서. 원소는 { provider, model? }. */
  chain?: ChildLlmChainEntry[];
}

/** 예산이 모자랄 때의 행동. 판정(P15)은 이 칸을 읽기만 한다. */
export type BudgetGateOnShortfall = 'decompose' | 'wait-reset' | 'next-provider' | 'proceed';

/** 프로바이더별 사용률 상한(0~100). 이 값 이상이면 그 칸을 안 쓴다. */
export type BudgetGateMaxUsedPercent = { readonly [provider: string]: number };

export interface HarnessBudgetGateConfig {
  /** 0~100. 기본 15. 범위 밖이면 경고와 함께 기본. */
  minHeadroomPercent: number;
  /** 기본 next-provider. 모르는 값이면 경고와 함께 기본. */
  onShortfall: BudgetGateOnShortfall;
  /**
   * 선택. 없으면 `DEFAULT_BUDGET_GATE_MAX_USED_PERCENT`.
   * 프로바이더 값이 0~100 밖이면 그 칸만 경고 후 기본.
   */
  maxUsedPercent?: BudgetGateMaxUsedPercent;
}

export interface SelfImplementToolConfig {
  /** Explicit opt-in for the needs-human reason-specific automatic repair goal. Defaults off. */
  supervisor?: { reasonRepair?: boolean };
  /** Absolute root that holds per-repository child worktree directories. */
  worktreeRoot: string;
  /** Self-implement children receive a derived isolated universe by default; `inherit` keeps the parent's universe. */
  childInstanceMode: SelfImplementChildInstanceMode;
  /** ⭐ self-implement **PR 개설 승인 카드를 어느 표면으로 보낼지**(대표 지시 2026-08-01).
   *  ⛔ 종전엔 wired 채널(Telegram · Discord · Pushcut · terminal)을 전부 레이스해서,
   *  TUI 에서 시작한 런의 승인이 **아이폰 푸시로 튀어나갔다**(실측).
   *  - `'terminal'`(기본) — **터미널 채널 하나로만** 묻는다.
   *    ⚠️ *"런을 시작한 표면으로 동적 라우팅"* 이 **아니다** — 지금 이 승인자가 TUI 부팅
   *    경로에서만 등록돼 두 값이 우연히 일치할 뿐이다(동적 귀속은 원장 `COORD-S12` ⑵).
   *  - `'all'` — 종전 팬아웃(밖에 있을 때 폰으로 받고 싶으면 이쪽).
   *  ⚠️ 어느 값에서도 **fail-closed 는 그대로**다(타임아웃 = 거부 · PR 은 outward-facing). */
  prApprovalDelivery: 'terminal' | 'all';
  /** Records SelfImplement dispatches without starting an implementation run. */
  observeOnly: boolean;
  /** Also append terminal execution records to the authored goal document (default true). */
  goalRecordInDoc: boolean;
  /** Controls the persistent grounding loop used while authoring goals; absent preserves it. */
  goalAuthorPersistentGrounding?: boolean;
  /** Explicit opt-in for the one-shot Terra medium goal-author reviewer precheck; absent/off preserves legacy authoring. */
  goalAuthorReviewerPrecheck?: boolean;
  /** Uses the Fabric decomposer for SelfOrchestrate requests that omit `fabric_decompose`. */
  fabricDecompose: boolean;
  /** Normalized SelfOrchestrate goal count that automatically selects Fabric; null disables auto-selection. */
  fabricDecomposeAutoPathThreshold: number | null;
  autoStop: SelfImplementAutoStopConfig;
  autoAssist: SelfImplementAutoAssistConfig;
  screenStallTermination: SelfImplementScreenStallTerminationConfig;
  reworkBudget: SelfImplementReworkBudgetConfig;
  decompositionShadow: SelfImplementDecompositionShadowConfig;
  /** Opt-in delivery of authored goal clarifications from unattended dev runs. */
  clarificationEscalation: SelfImplementClarificationEscalationConfig;
  /** RUN-TTL: hours an open self-impl PR may go without a commit before the draft sweep asks for a rebase. Absent or invalid = 24. */
  runTtlHours?: number;
  /** DRAFT-CLEANUP-FIX: per-tick close cap of `harness drafts sweep`. Raw value — `resolveDraftSweepCloseCap` validates (1–100, default 10, warns). */
  draftSweepCloseCap?: unknown;
  /** RUN-TTL sweep step: `shadow` (default) only logs; `live` sends the resync memo / adds `elanous:needs-rebase`. Cap absent or invalid = 30. */
  runTtl?: { mode: 'shadow' | 'live'; cap?: number };
  /** STOP-AUTOHEAL: `shadow` (default) only records what the stop dispatcher would do (`event='autoheal'`); `live` runs the injected heal seams once per run per stop class. */
  autoheal?: { mode: 'shadow' | 'live' };
  /** 사용자 자식 모델 선호. 없으면 해석기가 auto + fallbackChain 으로 만든다.
   *  Overload failover (OVERLOAD-FAILOVER) may move an unpinned codex child to
   *  grok. A pinned codex provider is never moved. */
  childLlm?: ChildLlmPreferenceConfig;
  /** Explicit same-provider child escalation map. Absent preserves the existing model ladder. */
  escalateChild?: Readonly<Record<string, string>>;
  /** SUBSCRIPTION-EXHAUST-REROUTE (0.2.24) — `--child-llm-*` 없이 뜬 Pod 구현 자식의 기본 모델.
   *  `{ provider, model? }` · `'off'`(종전 codex 기본). 없으면 `openrouter/z-ai/glm-5.3`. 원값 — `resolvePodChildDefault` 가 검사한다. */
  podChildDefault?: unknown;
  /** ⭐ PR-open 사전 승인 (2026-07-26 · 대표 결정 "오토 선호 · 기본 ON").
   *
   *  self-build 가 gate 를 통과하면 **PR 을 자동 개설**한다(기본 `true`).
   *  PR 의 draft 여부는 별개 축 — 호출측 `draft` 인자(툴 기본 `true`)가 정한다.
   *
   *  왜 config 인가 — CLI 는 `--open-pr` **플래그가 곧 사람의 명시 승인**이라 무인
   *  진행이 되지만, 툴(ACP/데몬/텔레그램) 경로엔 그 등가물이 없어 매번 대화형 확인을
   *  받거나(무인이면) **완성 산출이 worktree 에 좌초**했다. 툴 파라미터로 열면 LLM 이
   *  자기 승인을 하게 되므로, **operator 가 사전에 한 번 정해두는** 이 노브가 옳은
   *  자리다 — 승인 주체는 사람으로 유지되고 시점만 앞당겨진다.
   *
   *  ⚠️ 경계: 이건 **PR 개설**까지만이다. **병합은 별도 게이트**(`autoMerge` + 리뷰
   *  clean)로 남는다 — draft PR 은 닫고 브랜치를 지우면 되돌릴 수 있지만 병합은 아니다.
   *  `false` 로 두면 종전대로 `ux.confirm`(채널 없으면 fail-closed). */
  autoOpenPr: boolean;
  /** DRAFT-NOT-ARCHIVE — 멈춘 런의 산출을 어디에 남기나. `'always'`(기본 · 종전) = draft PR ·
   *  `'needs-owner-only'` = 사람 판단이 필요한 멈춤만 draft PR(⊕ 주인 자리 라벨), 나머지는 수확 가지 `salvage/run-<6hex>/…` ⊕ 런 원장. */
  draftOnStop?: DraftOnStopMode;
  /** SALVAGE-RETENTION — 원격 `salvage/*` 보존 규칙(14일 초과 ⊕ 열린 PR·카드 참조 0). `'shadow'`(기본) = 수만 보고 · `'live'` = 다음 조각에서 삭제. */
  salvageRetention?: { mode: 'shadow' | 'live' };
}

export interface RunDevHarnessToolConfig {
  modelSurface?: boolean;
}

/** `SelfOrchestrate` 툴 표면.
 *
 *  ⛔⭐⭐ **왜 «기본 off» 인가**(대표 결정 2026-08-20 · RFC-one-door-many-entrances P5):
 *  ***흡수가 이미 끝났다.*** `SelfImplement` 가 `goals[]`·`concurrency`·`decompose`·`auto_merge` 를
 *  전부 받고, 그 인자가 있으면 ***`SelfOrchestrate` 와 «같은 함수»***(`runSelfOrchestrateCliCommand`)로 간다.
 *  ⇒ 🔑 두 툴이 같은 곳으로 가므로 «둘째 문»은 능력이 아니라 ***파편화***다.
 *  ⛔ 이것은 「덜 쓰니까 내린다」가 «아니다» — 호출 수와 무관한 «결정»이다(대표).
 *  ⚠️ CLI(`elanous self orchestrate`)는 «남는다» — 모델 표면만 내린다(RunDevHarness 선례와 동형).
 *  🩹 되돌리려면 `tools.selfOrchestrate.modelSurface = true`. */
export interface SelfOrchestrateToolConfig {
  modelSurface?: boolean;
}

export interface NativeStructureToolConfig {
  enabled: boolean;
  /**
   * Optional provider allowlist. Absent means "every provider" when
   * `enabled` is true — that is the back-compat for existing config
   * files that only have the boolean. An explicit empty list applies
   * to nobody.
   */
  providers?: readonly string[];
}

export interface ToolsConfig {
  deferred: DeferredToolsConfig;
  agentSpawn: AgentSpawnConfig;
  selfImplement: SelfImplementToolConfig;
  runDevHarness: RunDevHarnessToolConfig;
  selfOrchestrate: SelfOrchestrateToolConfig;
  nativeStructure: NativeStructureToolConfig;
}

// ── Debug ────────────────────────────────────────────────────────────
// Runtime tracer persistence. Decoupled from the chat mirror so users
// can keep a silent forensic trail without the noisy inline feed.

export interface DebugConfig {
  /** File sink — when true (default) every run writes a per-session
   *  JSONL log under ~/.local/share/elanous/debug/. Set to false to
   *  disable disk persistence; the in-memory ring buffer still feeds
   *  `/debug tail` when needed. */
  file: boolean;
  /** Startup debug level. When absent / invalid, keep the historical
   *  default (`trail`) and only switch modes when user-config
   *  explicitly requests it.
   *
   *  - `keytrace`: deepest level for keyboard/mouse dispatch analysis.
   *    Adds `key.trace.*` firehose on top of diag's hot-path gates.
   *    Use when reproducing a chord miss / wrong-surface keypress. */
  level: 'off' | 'trail' | 'diag' | 'normal' | 'verbose' | 'detail' | 'keytrace';
  /** Gate the runtime-debug host-tool family exposed to the LLM.
   *  Default `true` keeps the historical 9-tool surface
   *  (debug_getState/debug_getCallStack/debug_getAgentState/
   *  debug_getLastLlm/input_history_search/input_history_list/
   *  debug_setLevel/debug_openView/debug_selectEvent). Set to `false`
   *  during chatlog-only debugging sessions — only the single most
   *  essential tool (`debug_getLastLlm`) stays exposed so the LLM
   *  doesn't get distracted by self-introspection during a focused
   *  triage. Incident 2026-05-04 — Opus mis-recognized its catalog
   *  partly because half the slots were debug_*. */
  exposeFullLlmTools: boolean;
  /** OH9(2026-07-24) — 렌더 카테고리(dashboard·key·mouse·cursor 계열)
   *  발화 여부. 진단 강도 축(`level`)과 **직교**한 별도 스위치 —
   *  대표는 상시 diag+ 라 "진단은 켜두고 렌더만 끄는" 축이 필요하다.
   *  기본 `false`(억제). essential TUI 는 렌더 로그를 자동 억제한다.
   *  `true` 로 명시하면 렌더 로그를 살린다
   *  (override). 런타임 영속은 config 가 아니라 `<stateRoot>/logs/level.json`
   *  의 `render` 필드(overlay 오염 방지) — 이 config 값은 부팅 시드일 뿐.
   *  선례: `exposeFullLlmTools`(계열 통째 죽이는 불린). */
  renderLogs: boolean;
}

// ── Logs (통합 로그 패브릭 · 2026-07-13) ─────────────────────────────
// 크로스서피스 조회 스토어(~/.elanous/logs/logs.db)의 보존정책 노브.
// 파일 트레일(debug.file)과 별개 축 — 스토어는 조회면이라 보존이 유한.
// 설계: 내부 문서 `PLAN-unified-log-fabric-2026-07-13` §LF0.

export interface LogsConfig {
  retention: {
    /** 보존 일수(기본 7). 0 = age 정리 안 함. */
    maxAgeDays: number;
    /** DB 크기 상한 MB(기본 500). 초과 시 오래된 행부터 삭제. 0 = 무제한. */
    maxDbMb: number;
    /** 크기 정리 보존 하한 시간(기본 24). 이 시간 안의 행은 크기 정리로 지우지 않는다. 0 = 하한 없음(옛 동작). */
    minRetainHours: number;
  };
  /** 로그 출처 이름 오버라이드 (LF7-a). 미설정 시 자동 유도 —
   *  prod(기본) 또는 `test:<repo폴더명>` (ELANOUS_STATE_DIR 기준). */
  instanceName?: string;
}

// ── Shell / PTY ──────────────────────────────────────────────────────
// Gate for exposing PtyShell* native tools to the dashboard chat loop.
// Codex exposes shell/exec_command at agent-loop level by default; we
// keep it opt-in because (a) there's no session-level sandbox yet and
// (b) the dashboard scope has no natural "skill return" to auto-kill
// dangling processes. Skills still get PtyShell regardless — this
// flag only affects dashboard surface visibility + wiring.
export interface ShellConfig {
  /** When true, PtyShell tools are surfaced to the dashboard/chat
   *  LLM and an HITL approval prompt gates every PtyShellStart. */
  allowDashboardPty: boolean;
  /** When true, the Bash tool is surfaced to the dashboard/chat LLM.
   *  Bash runs under `bash -c` with cwd=process.cwd(); ctx.signal
   *  forwards so dashboard Esc kills in-flight children. Default OFF;
   *  enabled TUI Bash uses the configured dangerous-command approval policy. */
  allowDashboardBash: boolean;
  /** Require HITL before Bash dispatch for matched destructive commands by default.
   *  `all` additionally requires confirmation for every Bash call. */
  bashApproval: BashApprovalMode;
  /** When true, the TerminalModalInject tool is surfaced to the
   *  dashboard/chat LLM. Every call still goes through the approval
   *  modal (createInjectApprover), so enabling this doesn't bypass
   *  HITL — it just lets the model propose injects without going
   *  through a skill. Default OFF. */
  allowDashboardTerminalInject: boolean;
  /** When true, the ApiCall tool is surfaced to the dashboard/chat
   *  LLM. ApiCall is double-gated by the /api-allow host allowlist
   *  (empty by default) and a per-host rate limiter, so the exposure
   *  cost is lower than Bash/PtyShell. Default OFF so the user opts
   *  in deliberately. */
  allowDashboardApiCall: boolean;
  /** When true, the RunShell tool is surfaced to the dashboard/chat
   *  LLM. RunShell uses argv-exec (no shell interpretation) + the
   *  shell-primitive approval cache + NDJSON audit log at
   *  ~/.monad-agent/audit/. Default OFF. Can be used alongside Bash
   *  or as a replacement — RunShell is preferred for commands with
   *  a known argv shape, Bash for pipe-heavy shell strings. */
  allowDashboardRunShell: boolean;
}

/** ER1 — 액티브 덤퍼(오류 자동 보고). 기본 켬(첫 실행 안내 한 번 · 대표 10-01) · 신원(email/telegramUser)은 따로 «예»일 때만. */
export interface ErrorReportsConfig {
  /** false = never send. Absent retains the feature but sending waits for the first-run notice. */
  enabled?: boolean;
  /** Persisted only after the first-run notice was shown to a person. */
  noticeShown?: boolean;
  /** true = also send email / telegramUser below with each report. Default false. */
  identity?: boolean;
  email?: string;
  telegramUser?: string;
}

// ── Dashboard ────────────────────────────────────────────────────────

export interface DashboardConfig {
  /** Optional view registry config. Parsed by view-config.ts so this
   *  loader can preserve forward-compatible view schema additions. */
  views?: Record<string, unknown>;
  /** Optional semantic theme token config. Parsed by theme-tokens.ts;
   *  preserved as a raw object here so future token groups stay
   *  forward-compatible. */
  theme?: Record<string, unknown>;
  /** Prompt Bank live injection controls. Defaults are intentionally
   *  disabled so the bank can be populated and debugged before it
   *  affects real LLM turns. */
  promptBank: DashboardPromptBankConfig;
  /** Chat-log fold strategy. Default `task-unit` collapses each tool
   *  body to its header; `line` keeps the unfolder line-budget body;
   *  `kind-unit` coalesces adjacent same-kind operations. Runtime
   *  `/log fold <mode>` still overrides for subsequent turns. */
  foldMode?: FoldMode;
  /** Default-on for `--benchmark`: chat-only layout + input-focused
   *  boot, intended for scripted Q&A loops. Functionally equivalent
   *  to passing `--benchmark` on every invocation. CLI `--benchmark`
   *  still forces it on regardless of this setting. */
  benchmark?: boolean;
  /** Whether global virtual-window switching keys are registered.
   *  Defaults off so optional window navigation does not occupy keys
   *  required by essential input, reading, and escape controls. */
  enableVirtualWindowSwitchKeys: boolean;
  /** First-screen boot banner. Absent = `minimal`: only failures and first-run
   *  guidance reach the transcript; healthy daemon/PWA/hitl-port rows move to
   *  `/status`. `full` restores the historical band. */
  bootBanner?: 'minimal' | 'full';
}

export interface DashboardPromptBankConfig {
  enabled: boolean;
  dashboardTurns: boolean;
  skillRuns: boolean;
  budgetTokens: number;
  limit: number;
  record: boolean;
}

// ── Virtual Windows (VW-B3/B4 — rename persistence) ────────────────
//
// User-applied window / pane renames (^B R, ^B Shift+A) are scoped
// by the *spawn-time* title so they survive session restarts. Keys:
//
//   vw.windowNames[<spawn title>] = <user rename>
//   vw.paneNames[<spawn title>|<pane content title>] = <user rename>
//
// Applied when a matching VW / pane is created, overwritten when the
// user renames, cleared when the user renames back to empty.
// Deliberately global (not per-project): the user is one person, and
// VW spawn titles ("runner", "dashboard", ...) are app-level labels
// that carry the same meaning across projects.

export type VwKnownName = 'acp' | 'sim' | 'iul';

export interface VwEntryConfig {
  resident: boolean;
  foregroundOnStartup: boolean;
}

export interface VwConfig {
  windowNames: Record<string, string>;
  paneNames: Record<string, string>;
  entries: Record<VwKnownName, VwEntryConfig>;
  simResident: boolean;
  iulResident: boolean;
  iulForegroundOnStartup: boolean;
  order: VwKnownName[];
}

// ── ACP (AXON track) ─────────────────────────────────────────────────
//
// Per-brand HOP_CAP budget (follow-up #7). Controls the chain-depth
// at which `DualRoleManager.clientSessionCreate({parentSessionId})`
// throws `ReentrancyError`. Three was chosen in H3 #7 (srv → cli →
// srv → cli); brands that favor deep subagent nesting (claude) can
// raise it, brands where cheap root-to-root delegation dominates
// (codex) can keep the default. Values ≤ 0 are treated as missing to
// prevent a malformed config from disabling the guard entirely.

export interface AcpHopCapConfig {
  claude?: number;
  codex?: number;
  gemini?: number;
  /** Fallback when a brand isn't listed. When absent, the runtime
   *  uses its own constant (DEFAULT_HOP_CAP = 3). */
  default?: number;
}

export interface AcpConfig {
  hopCap: AcpHopCapConfig;
  /** ACP client permission response deadline (positive integer milliseconds). */
  toolApproval: { timeoutMs: number };
  /** ACP PR reviewer and final judge backend. Absent defers to DEFAULT_REVIEW_BACKEND. */
  reviewBackend?: string;
  /** Rework agent backend. Absent defers to the driver default (codex). */
  reworkBackend?: string;
  /** Optional executable override keyed by canonical ACP backend id.
   *  When present, this path wins over the normal project-local and PATH
   *  lookup sequence. */
  binaryPaths?: Record<string, string>;
  /** Soft tool-turn budget injected as a focus directive into slash
   *  `/cc`·`/cdx`·`/gem` prompts (targeted commands → tight). Natural-
   *  language delegation (elanous brain) stays generous and ignores this.
   *  Advisory (not hard-enforced). Omit ⇒ SLASH_FOCUS_TURNS_DEFAULT (8). */
  slashMaxTurns?: number;
  /** Edit-approval oversight for delegated (ACP) coding. Default OFF =
   *  autonomous: permission requests auto-approve so the delegate isn't
   *  babysat per edit (asking approval per write defeats delegation — the
   *  interactive-editor paradigm ACP inherited doesn't fit autonomous
   *  telegram delegation). Structured QUESTIONS still surface regardless.
   *  Set true to opt back into per-edit approval via the chat's HITL. */
  editApproval?: boolean;
}

// ── Plan mode config (Coding Pipeline P4 followup) ───────────────────
//
// Single flag for now — when true, dispatchEnterPlanMode also creates
// an isolated worktree (via enterWorktreeRuntime with autoBranch=true)
// so plan-mode work is staged on its own branch + dir before any
// edit touches the main checkout. Off by default so the existing
// "plan in place" workflow is unchanged.
export interface PlanConfig {
  /** Auto-create a per-plan worktree on EnterPlanMode. Branch name
   *  is synthesised from the plan's initialTitle (or a timestamp
   *  fallback). Default false. */
  autoWorktree: boolean;
}

// ── Goals (Plan-Mode UX P1 · 2026-05-05) ─────────────────────────
//
// `/goal <objective>` opens a persistent cross-turn goal that the
// Judge Loop (Mode A) drives autonomously until the auxiliary
// goal-judge model reports `done`, the budget is exhausted, the user
// preempts, or plan mode is entered. See:
//   내부 문서 `RESEARCH-plan-mode-goal-ralph-loop-2026-05-05`
//   내부 문서 `PLAN-plan-mode-ux-goal-ralph-2026-05-05`
export interface GoalsConfig {
  /** Max auto-turns the loop drives before forcing pause. Default 20
   *  (Hermes lineage). 0 disables the cap (not recommended). */
  maxTurns: number;
  /** Wall-clock cap in ms. Default 30 min. */
  wallClockMaxMs: number;
  /** Token budget per goal. 0 = no token cap. Default ~200k. */
  tokenBudget: number;
  /** Provider name to resolve via auxiliary client for the judge call.
   *  When empty, falls back to the primary provider's default model.
   *  Recommended: a fast, low-cost model (`grok-4.20-non-reasoning`,
   *  `gpt-4o-mini`, `claude-haiku-4-5`). */
  judgeModel: string;
  /** When the judge returns `empty` or fails to parse, how many times
   *  to retry before forcing PAUSE+ASK. Default 1. */
  judgeRetries: number;
  /** P2 — auto-resume on plan mode exit? Default false (explicit
   *  `/goal resume` required to avoid drift). */
  resumeOnPlanModeExit: boolean;
  /** Default mode for new goals. P1 only ships `judge`; `spec` is P3. */
  modeDefault: 'judge' | 'spec';
}

// ── Registry (Phase 6 FU · 2026-05-11) ──────────────────────────────
//
// Discovery wiring user-config. RFC #2161 Phase 6 originally shipped
// the omni-crawl bridge + cron interval as ELANOUS_* env vars (#2206 /
// #2209). That violated the "신규 옵션은 user-config 만 노출" rule
// (`내부 문서 `MANUAL-user-config`` §2 · memory
// `feedback_user_config_over_env.md`). This section is the canonical
// surface; cron's legacy env survives as fallback only.
//
// A6-real P4 (2026-05-11) retired the omni-crawl bridge entirely —
// its replacement is the grok-crawl (mandatory) + firecrawl-crawl
// (optional) source pair (P2 + P3). The bridge's user-config field
// and its `ELANOUS_OMNI_CRAWL_*` env fallbacks are no longer consulted.

export interface RegistryDiscoveryCronConfig {
  /** Discovery cron tick interval (ms). Clamped to [60_000, 86_400_000].
   *  Undefined / 0 = cron dormant (default · zero CPU on fresh install).
   *  Legacy env fallback: `ELANOUS_DISCOVERY_CRON_INTERVAL_MS`. */
  intervalMs?: number;
}

export interface RegistryDiscoveryFirecrawlConfig {
  /** Firecrawl API key. The NEXUS advanced wizard (FU A6-real P5)
   *  writes this when the user opts into Firecrawl-backed discovery.
   *  Empty / absent = source returns `missing-api-key` (CLI itself
   *  still has to be installed via `npm i -g firecrawl-cli` or
   *  similar — see `firecrawl-crawl.ts:isFirecrawlCliAvailable`).
   *  Legacy env fallback: `FIRECRAWL_API_KEY`. */
  apiKey?: string;
}

export interface RegistryDiscoveryConfig {
  cron: RegistryDiscoveryCronConfig;
  firecrawl: RegistryDiscoveryFirecrawlConfig;
}

export interface RegistryConfig {
  discovery: RegistryDiscoveryConfig;
}

// ── sessionFabric (P1 shadow fan-out · 2026-07-16) ───────────────────
// 멀티서피스 세션 shadow fan-out 게이트. 기본 부재(=OFF) — 기존 배달 경로 무접촉.
// shadowFanout=true 면 데몬이 세션 응답을 subscribeSession 구독자에게 **추가 미러**
// (기존 telegram/ACP 배달 위에 additive · 바인딩된 endpoint 는 제외). 실기기 dogfood 게이트.
export interface SessionFabricConfig {
  shadowFanout?: boolean;
  /** C2/C3/C4 배달 cutover — 서피스별 primary flip(기본 부재=OFF·옛 경로 유지). ON = 그 서피스
   *  배달이 fanOutSessionOutput 단일 경로로. tg/dc 는 실기기 dogfood 게이트 후에만 켠다.
   *  pwaMsg 는 메시지레벨 순수 additive(옛 메시지레벨 경로 없음·스트리밍은 C5) → 저위험. */
  primary?: { telegram?: boolean; discord?: boolean; pwaMsg?: boolean };
  /** C5 청크(스트리밍) cutover — 서피스별 스트리밍 flip(기본 부재=OFF·옛 streamer 유지). ON =
   *  그 서피스 스트리밍 배달이 fanOutSessionChunk + StreamingSurfaceSink 경로로. 메시지레벨
   *  primary 와 **직교**. 실기기 dogfood 게이트 후에만 켠다.
   *  acp(C5d·최고위험) = ACP broadcast 를 통합 fan-out 으로 흡수 — ON 시 push 가 fanOutSessionChunk
   *  경로로(byte-identical parity 후) + ACP 턴이 tg/dc/pwa 로 미러. 기본 부재=OFF. */
  streaming?: { telegram?: boolean; discord?: boolean; acp?: boolean };
  /** C5-enh 서피스 특유 노브. streamingMode = off|progress|partial|block(§6-8·기본 partial=현 full stream).
   *  editGapMs = 편집 간격(기본 1100). 반응(👀 → 완료/실패)은 늘 켬.
   *  텔레그램 강화(§5.2·§10-2·전부 기본 off·라이브 무접촉): typing = sendChatAction liveness ·
   *  fairQueue = supergroup 다중토픽 라운드로빈 · rotate = scroll-jump post-new-then-delete. 기본 부재=OFF. */
  telegram?: { streamingMode?: StreamingMode; editGapMs?: number; typing?: boolean; fairQueue?: boolean; rotate?: boolean };
  discord?: { streamingMode?: StreamingMode; editGapMs?: number };
}

// ── taste (Layer2 substrate · P4 중앙 진입점 수집 · 2026-07-18) ──────────
// 기본 부재(=OFF·opt-in). captureEnabled=true 면 intent-gate submitIntent 최상단이
// 모든 프롬프트(마커/passthrough 무관)를 비동기 fire-soft 로 distill → surface_events
// (kind:'taste'·category:'taste.capture'). hot-path 무증가(await 안 함). 모델=luna 경량.
// ⚠️armed=false·관측/가중용 · 매매 무접촉 · surface_events 위 파생(원장 무오염).
export interface TasteConfig {
  captureEnabled?: boolean;
  /** distill 모델 override(기본 luna). 관측용 per-run 노브. */
  model?: string;
  /** P6 능동 미션 제안 gate(기본 OFF). ON 이어도 gate 는 **제안만**·미션 생성/승인은 대표(HITL). */
  proposeEnabled?: boolean;
  /** 제안 임계(0..1·기본 보수 0.55). 테마 점수>임계 & 최근 좌절 없음일 때만 표면화. */
  proposeThreshold?: number;
  /** 같은 테마 재제안 쿨다운(일·기본 7). 대표 결정 라벨이 쌓이기 전 스팸 방지. */
  proposeCooldownDays?: number;
}

/** 웹 검색 프로바이더 게이트(sparse · 기본 OFF).
 *
 *  ⛔⭐ **왜 「기본 OFF」인가** — 대표 2026-08-06: tavily 는 콜당 싸지만(basic 1cr·~1s)
 *  **상시 경로에 켜져 있어** 크론 디깅·deep 리서치가 돌 때마다 고정비가 됐다.
 *  ***「싸다」와 「늘 켜 둔다」는 다른 축이다.*** 그래서 «능력은 남기고 상시성만» 끈다 —
 *  구현(`src/web-search/tavily.ts`)은 그대로 두고 등록만 이 스위치가 정한다.
 *
 *  ⚠️ 켜기: `elanous config set webSearch.tavily.enabled true` (또는 config.json 직접).
 */
export interface WebSearchConfig {
  tavily?: { enabled?: boolean };
  grokApi?: { enabled?: boolean };
  firecrawl?: { enabled?: boolean };
}

/** OpenDesign 데몬 접속. url 이 없으면 시안 생성은 꺼진 것이다. tokenFile 은 토큰 «경로»만 담는다. */
export interface OpenDesignConfig {
  url?: string;
  tokenFile?: string;
}

export interface DesignConfig {
  openDesign?: OpenDesignConfig;
}

// ── Notifications · APNs (W7-후속 · 2026-05-12) ─────────────────────
//
// `notifications.apns` is sparse — all 4 of keyId / teamId / bundleId /
// keyPath must be present to produce a valid `ApnsUserConfig`. Missing
// any → parser returns undefined → daemon boots the ios-push channel
// with transport=undefined (the channel's `send()` then resolves to
// `{ ok: false, reason: 'transport-not-configured' }` on attempted
// routes, surfacing the misconfiguration loudly without crashing boot).
//
// keyPath points at a .p8 file (PEM-formatted PKCS8 ECDSA-P256 private
// key, as Apple's developer.apple.com download). The actual file read
// + PEM parse lives in `src/notifications/outbound-boot.ts` so this
// schema parser never touches disk — keeps the user-config layer
// side-effect-free.

export interface ApnsUserConfig {
  /** Apple Auth Key ID — 10-char identifier next to the .p8 file. */
  keyId: string;
  /** Apple Team ID — 10-char identifier from the developer portal. */
  teamId: string;
  /** App bundle id — sent as `apns-topic` header. */
  bundleId: string;
  /** Absolute or `~`-prefixed path to the .p8 private key file. */
  keyPath: string;
  /** Defaults to 'production' (api.push.apple.com). 'sandbox' routes
   *  to api.sandbox.push.apple.com for dev / TestFlight builds. */
  environment?: 'production' | 'sandbox';
}

export interface NotificationsConfig {
  apns?: ApnsUserConfig;
}

// ── MCP client (B 트랙 Phase 2 · 2026-05-12) ──────────────────────
//
// `mcp.servers[]` declares external MCP servers that the NEXUS boot
// wire (`src/nexus/boot/register-mcp-clients.ts`) should spawn. Each
// server contributes its `tools/list` response as proxy ToolRuntimes
// registered under `<id>.<tool-name>` (RFC §8 Q2). Sparse — an empty
// or absent array means the substrate is no-op. Per Q5 the default
// `xcodebuild` recipe assumes a Homebrew install of getsentry's
// xcodebuildmcp; users wanting npx can swap the command array.
//
// `enabled` defaults to true; set false to keep a config row but
// suppress boot (useful when the binary isn't installed yet).
//
// See `내부 문서 `RFC-elanous-mcp-client-2026-05-12`` for the design.

/** MCP client transport. `streamable-http` is accepted as an alias of `http`. */
export type McpTransport = 'stdio' | 'http';

interface McpServerSpecBase {
  /** Stable identifier — used as the proxy tool prefix. */
  id: string;
  /** When false, skip spawn at boot. Defaults to true. */
  enabled?: boolean;
  /** Per-server `start()` and `tools/list` deadline in milliseconds. */
  handshakeTimeoutMs?: number;
  /** Explicitly pre-authorized outbound tools for this stable server id.
   * Omit or leave empty to fail closed until a grant is issued. */
  authorizedTools?: string[];
}

/** Child-process MCP server. `command` is required; there is no URL. */
export interface McpStdioServerSpec extends McpServerSpecBase {
  transport: 'stdio';
  command: string[];
  /** Opposite-transport field is not representable. */
  url?: never;
}

/** URL MCP server. `url` is required; there is no argv. Not spawned in this landing. */
export interface McpHttpServerSpec extends McpServerSpecBase {
  transport: 'http';
  url: string;
  /** Known authorization-server issuer for a reusable OAuth token. */
  oauthIssuer?: string;
  /** Token endpoint used to refresh the reusable OAuth token. */
  oauthTokenEndpoint?: string;
  /** Environment-variable name containing a static HTTP Bearer token. */
  bearerTokenEnv?: string;
  /** Opposite-transport field is not representable. */
  command?: never;
}

/**
 * Parsed MCP server. Discriminated on `transport` so `{ id }` and mixed
 * command/url combinations are not representable. Legacy command-only
 * config normalizes to `McpStdioServerSpec`.
 */
export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

export interface McpConfig {
  servers: McpServerSpec[];
  /** Default `start()` and `tools/list` deadline for MCP servers in milliseconds. */
  handshakeTimeoutMs?: number;
  /** Master switch — `false` skips the entire MCP-client boot wire at
   *  daemon start (every `mcp.servers[]` row is ignored). Default true
   *  / undefined = enabled. Set when one chatty server (e.g.
   *  `xcrun mcpbridge` whose `tools/list` hangs daemon-side · 2026-05-13
   *  dogfood) drags every startup through its 8s timeout. Toggle from
   *  the CLI with `elanous nexus run --no-mcp`. */
  enabled?: boolean;
  /** Trusted MCP server id for widget tool calls (`POST /v1/mcp/widgets/call`).
   *  Sparse — omitted means the HTTP route keeps its sole-ready fallback. */
  widgetServerId?: string;
}

/** Aside Browser endpoints are SSH stdio MCP servers; credentials stay on each host. */
export interface AsideRemoteTargetConfig {
  id: string;
  host: string;
  command: string[];
  enabled?: boolean;
  capabilities: Array<'browser' | 'repl' | 'selection'>;
}

export interface AsideConfig {
  targets: AsideRemoteTargetConfig[];
  defaultTargetId?: string;
  contextDefaults?: Record<string, string>;
  strictRedactMode?: boolean;
}

// ── BackgroundReasoning LLM (W9e-FU U5 · 2026-05-12) ──────────────────
//
// Drives the Patcher daemon's entity-extractor + embedding-generator
// callables. When omitted (or `endpoint` blank), `buildPatcherSubstrate`
// keeps the daemon dormant with `patcher-llm-deps-missing` (already
// surfaced via `console.warn`). LM-Studio's OpenAI-compatible endpoints
// are the dogfood default — pointed at any OpenAI-compatible API
// (LM-Studio / Ollama / Together / etc.) the resolver lights up.
//
// The actual fetch + JSON parse lives in
// `src/background-reasoning/patcher-llm-resolver.ts` so this schema
// parser stays side-effect-free.

export interface BackgroundReasoningLlmConfig {
  /** Base URL of the OpenAI-compatible API. Trailing slash optional. */
  endpoint: string;
  /** Model id for the entity-extractor (`POST {endpoint}/v1/chat/completions`).
   *  Defaults handled by the resolver — `lm-studio/qwen-7b` if omitted. */
  entityModel?: string;
  /** Model id for the embedding generator (`POST {endpoint}/v1/embeddings`).
   *  Defaults to `text-embedding-3-small` shape — local LM-Studio
   *  loads typically expose a generic embedding model. */
  embeddingModel?: string;
  /** Optional bearer token; LM-Studio's local server ignores this. */
  apiKey?: string;
}

export interface BackgroundReasoningConfig {
  llm?: BackgroundReasoningLlmConfig;
}

// ── LSP (Phase L4 of 내부 문서 `ROADMAP-lsp-integration`) ────────────────
//
// Multi-language LSP tool surface — typescript-language-server handles
// TS/JS out of the box; pyright and rust-analyzer entries add Python
// and Rust when the user installs the respective binaries. Per-language
// `{ command, args, extensions }` tuples let users override paths,
// flags, or file extensions without touching code.
//
// `enabled: false` at the top level kills the whole tool. Setting a
// language to `false` keeps the others working while hiding that one
// from dispatch. idleTimeoutMs is the LSP server pool's reap cadence —
// default matches the 10-minute value from L3's pool.ts.

export interface LspLanguageConfig {
  command: string;
  args?: readonly string[];
  /** Lower-cased extensions without the leading dot. */
  extensions: readonly string[];
}

export interface LspConfig {
  enabled: boolean;
  typescript: LspLanguageConfig | false;
  python:     LspLanguageConfig | false;
  rust:       LspLanguageConfig | false;
  idleTimeoutMs: number;
  /** Which language serves workspaceSymbol when no filePath anchor is
   *  available. Defaults to 'typescript'. */
  workspaceSymbolLanguage: 'typescript' | 'python' | 'rust';
}

// ── Voice (2026-04-30) ─────────────────────────────────────────────
// Single source of truth for voice subsystem config — STT provider,
// TTS provider + auto-TTS toggle, VAD mode + tuning, voice-chat
// multi-turn. User explicitly preferred user-config over scattered
// env vars (`ELANOUS_VOICE_*`, `ELANOUS_AUTO_TTS`, `TTS_PROVIDER`,
// `STREAMING_STT_PROVIDER`). Env is kept as backward-compat fallback
// (resolver helpers in voice/* still read it when config is absent),
// but new opts should land here first.
//
// Priority: user config > env > hardcoded default.

export type VoiceSttProviderId =
  | 'openai-realtime-stt'
  | 'gemini-live-stt'
  | 'whisper-cpp-local'
  | 'elevenlabs-scribe-realtime';

export type VoiceTtsProviderId =
  | 'openai-tts'
  | 'elevenlabs-tts'
  | 'edge-tts'
  | 'macos-say';

export type VoiceVadMode = 'server' | 'local' | 'manual';

/** G-VOX-2 (2026-06-02) — STT transport mode. Streaming = realtime WS
 *  (per-chunk transcripts · iPhone/iPad ChatView default). Batch = REST
 *  POST `/v1/voice/transcribe` (full audio → single transcript · 비-실
 *  시간 caller 용 · 현재 client impl 미존재 · forward-compat schema). */
export type VoiceSttMode = 'streaming' | 'batch';

export interface VoiceSttConfig {
  /** STT provider id used by `/voice-chat` continuous mode. When
   *  omitted, resolvers fall back to `STREAMING_STT_PROVIDER` env
   *  then the hardcoded default `'openai-realtime-stt'`. */
  provider?: VoiceSttProviderId;
  /** G-VOX-1 (2026-06-02) — OpenAI API key for openai-realtime-stt
   *  (also covers other openai-* providers). Falls back to
   *  `process.env.OPENAI_API_KEY` (legacy). User-config precedence per
   *  AGENTS.md §user-config-over-env. */
  apiKey?: string;
  /** G-VOX-1 (2026-06-02) — transcription model (session.update payload
   *  for openai-realtime-stt). Default `gpt-4o-mini-transcribe`. Set to
   *  `'gpt-realtime-whisper'` (2026-05 GA · best accuracy + tunable
   *  latency · $0.017/min vs $0.003/min). Legacy env fallback:
   *  `OPENAI_REALTIME_STT_MODEL`. */
  model?: string;
  /** G-VOX-1 (2026-06-02) — realtime BASE model (URL `?model=` query)
   *  for openai-realtime-stt. Default `gpt-realtime` (current GA · 2026-
   *  06-02 dogfood: 신규 sk-proj-* key 가 deprecated `gpt-4o-realtime-
   *  preview` 미보유). 향후 OpenAI 가 GA model name rotate 시 사용자가
   *  override. Legacy env fallback: `OPENAI_REALTIME_BASE_MODEL`. */
  realtimeBaseModel?: string;
  /** G-VOX-2 (2026-06-02) — STT transport mode. Default `'streaming'`
   *  (realtime WS · iPhone/iPad ChatView 의 voice 입구 = 항상 streaming).
   *  `'batch'` 는 forward-compat schema · 실 client impl 미존재. */
  mode?: VoiceSttMode;
  /** ISO 639-1 language hint forwarded to the STT provider's
   *  openSession opts. Set to 'ko' to force Korean transcription
   *  on openai-realtime-stt — without it, short Korean utterances
   *  are often misclassified as Japanese. */
  language?: string;
}

export interface VoiceTtsConfig {
  /** TTS provider id used by auto-TTS + `/say` slash. Falls back to
   *  `TTS_PROVIDER` env then `'openai-tts'`. */
  provider?: VoiceTtsProviderId;
  /** When true, assistant chunks are spoken aloud automatically as
   *  they stream. Equivalent to running `/auto-tts on` at boot.
   *  Falls back to `ELANOUS_AUTO_TTS` env then `false`. */
  auto?: boolean;
  /** Hard cap on segmenter buffer per-sentence (chars). When omitted
   *  the segmenter default (~2000) applies. Env fallback:
   *  `ELANOUS_AUTO_TTS_MAX_LENGTH`. */
  maxSentenceChars?: number;
  /** Drain cooldown (ms) inserted between auto-TTS commit/cancel and
   *  voice-chat `notifyResponseDone`. Without this gap the controller
   *  flips `speaking → listening` while the OS audio queue still has
   *  a tail of TTS playback, and the mic re-captures the assistant's
   *  own voice → echo loop into STT. Range 0–2000. Default 300. */
  drainCooldownMs?: number;
  /** Voice identifier forwarded to the active TTS provider (config화
   *  2026-07-12 — 대표 방침: env 대신 config 우선). elevenlabs-tts 는
   *  voice UUID (`ELEVENLABS_VOICE_ID` env fallback · 예: Seulki),
   *  openai-tts/edge-tts/macos-say 는 voice 이름. 미설정 시 각
   *  프로바이더의 env → 하드코딩 기본값 체인 유지. */
  voiceId?: string;
}

export interface VoiceVadConfig {
  /** `server` lets the upstream STT provider decide turn boundary
   *  (default — works on OpenAI realtime). `local` runs energy-based
   *  VAD inside the pipeline (good for whisper-cpp-local). `manual`
   *  requires explicit ESC to finalize. Env fallback:
   *  `ELANOUS_VOICE_VAD`. */
  mode?: VoiceVadMode;
  /** RMS energy threshold for `local` mode. Higher = less sensitive.
   *  Env fallback: `ELANOUS_VOICE_VAD_THRESHOLD`. Default 0.012. */
  threshold?: number;
  /** Below-threshold duration that triggers turn end (ms). Env
   *  fallback: `ELANOUS_VOICE_VAD_SILENCE_MS`. Default 800. */
  silenceMs?: number;
  /** Minimum above-threshold duration that counts as speech (ms).
   *  Env fallback: `ELANOUS_VOICE_VAD_MIN_SPEECH_MS`. Default 200. */
  minSpeechMs?: number;
}

export interface VoiceChatConfig {
  /** When true, the assistant's response triggers auto-relisten so
   *  the user can keep talking hands-free. Combined with VAD's
   *  automatic turn end and (sticky-aware) auto-submit, this yields
   *  a 5-min hands-free conversation cycle. Env fallback:
   *  `ELANOUS_VOICE_CHAT_MULTI_TURN`. */
  multiTurn?: boolean;
}

export type VoiceTelegramReplyMode = 'auto' | 'text' | 'voice';

export type VoiceTelegramDispatchMode = 'auto-reply' | 'tui-bridge';

export type VoiceDiscordChannelListenFilter = 'caller' | 'all';

export type IntakeAmbientCaptureMode = 'off' | 'suggest' | 'capture';

export interface VoiceTelegramConfig {
  /** Where Telegram inbound text / transcribed voice messages route.
   *  - 'auto-reply' (default): existing LLM reply path.
   *  - 'tui-bridge': inject final text into the live dashboard input
   *    when the dashboard shares the daemon process. */
  dispatch?: VoiceTelegramDispatchMode;
  /** Reply mode for incoming Telegram voice messages.
   *  - 'auto' (default): user voice → voice reply; user text → text reply.
   *  - 'text': always text reply.
   *  - 'voice': always voice reply.
   *  No env fallback — Telegram voice is a 신규 옵션 introduced in
   *  Phase 8 (2026-04-30) and is user-config only. */
  replyMode?: VoiceTelegramReplyMode;
  /** ISO 639-1 language hint passed to STT for incoming voice msgs.
   *  Improves Korean accuracy when set to 'ko'. */
  voiceLanguage?: string;
}

export interface VoiceDiscordConfig {
  /** ISO 639-1 language hint passed to STT for incoming voice
   *  attachments. Improves Korean accuracy when set to 'ko'. */
  voiceLanguage?: string;
  /** Voice-channel specific behavior for Discord Phase 6 follow-up. */
  voiceChannel?: {
    /** Enables the live Discord voice-channel surface. User-config first;
     *  env remains only as backward-compatible fallback. */
    enabled?: boolean;
    /** Default `/voice-join` speaker filter when the command omits an
     *  explicit suffix (`caller` or `all`). */
    listenFilter?: VoiceDiscordChannelListenFilter;
    /** Leave the voice channel automatically when it becomes empty from
     *  the bot's point of view. */
    leaveOnEmpty?: boolean;
    /** 재생 중 청취 정책 — true 면 barge-in(지속 발화 인터럽트), false/
     *  미설정이면 half-duplex. env `ELANOUS_VOICE_BARGE_IN` 은 backward-
     *  compat fallback (user-config 우선 · 갭 #4 2026-07-12). */
    bargeIn?: boolean;
    /** barge-in 인터럽트 인정에 필요한 지속 발화 길이(ms). 기본 350.
     *  env fallback `ELANOUS_VOICE_BARGE_IN_SUSTAIN_MS`. */
    bargeInSustainMs?: number;
    /** half-duplex 꼬리 여유(ms) — TTS 재생 지평선 뒤로 이만큼 더 인바운드
     *  를 무시. 기본 350. env fallback `ELANOUS_VOICE_SELF_ECHO_TAIL_MS`. */
    selfEchoTailMs?: number;
    /** 마지막 인바운드 패킷 후 STT 를 강제 finalize 하는 침묵 갭(ms).
     *  기본 700. env fallback `ELANOUS_VOICE_STT_SILENCE_FINALIZE_MS`. */
    sttSilenceFinalizeMs?: number;
  };
  /** 디스코드 보이스 채널 전용 STT provider override (config화 2026-07-12
   *  — `voice.discord.voiceLanguage` 와 같은 표면 스코프 선례). 미설정
   *  시 전역 체인(voice.stt.provider > STREAMING_STT_PROVIDER env >
   *  기본값). 전역 키 하나로는 TUI(gpt-realtime-whisper 튜닝)와 디스코드
   *  dogfood(scribe)가 충돌해서 표면별로 분리한다. */
  sttProvider?: VoiceSttProviderId;
}

export interface VoicePwaConfig {
  // 2026-09-26 설정 졸업: `voice.pwa.dispatch` 를 지웠다 — 그 값을 쓰던 `voice-pwa-dispatch.ts` 는 호출처 0(죽은 모듈)이었다.
}

export interface VoiceConfig {
  stt: VoiceSttConfig;
  tts: VoiceTtsConfig;
  vad: VoiceVadConfig;
  chat: VoiceChatConfig;
  discord: VoiceDiscordConfig;
  telegram: VoiceTelegramConfig;
  pwa: VoicePwaConfig;
}

export interface IntakeSurfaceConfig {
  ambientCapture?: IntakeAmbientCaptureMode;
}

export interface IntakeConfig {
  /** Maximum immediately scheduled Telegram absorption links per KST day. */
  eventMax?: number;
  /** Topic title used by the scheduled user absorption briefing and its topic-scoped feeds. */
  briefingTopic?: string;
  telegram: IntakeSurfaceConfig;
  discord: IntakeSurfaceConfig;
  approvals?: { repo?: string };
}

// ── Finance / Conatus domain pack (2026-07-05 · A0) ──────────────────
//
// The investment/Conatus capability (analyst orientation, resource map,
// and — later — first-class finance tools + trade gate) is an OPTIONAL
// domain pack. Core stays generic; when `enabled` is false (default) none
// of the finance orientation loads, so a non-investment deployment gets a
// plain agent. See docs/ROADMAP-conatus-elanous-knowledge-absorption §0.
export interface FinanceConfig {
  enabled: boolean;
  /** P5 PFC Layer-2 autonomous opportunity loop. DISARMED by default —
   *  when `enabled` is false the opportunity scan only REPORTS candidates;
   *  when true it auto-runs a bounded analysis for high-severity candidates
   *  (still analysis-only — no trade tools; trades stay HITL). `maxPerScan`
   *  is the budget furnace: at most this many analyses per scan. */
  autoLoop?: { enabled?: boolean; maxPerScan?: number };
  /** R5 (ROADMAP-organic-signal-engine) — dig-engine v2: DigTrigger →
   *  auto-mode goal auto-setup driven by the ContinuationScheduler.
   *  DISARMED by default and double-gated: this section AND the root
   *  `dispatch.enabled` flag must both be true before the daemon arms
   *  the dig-goal armer. Analysis-only (no trade tools); guards =
   *  termination preset + goal token budget + maxTurns + andon +
   *  dig-engine hourly/cooldown caps + `maxPerDay`. */
  dig?: { autoGoal?: { enabled?: boolean; maxPerDay?: number; maxTurns?: number; independentChecker?: boolean } };
  /** 온톨로지(kg) 새벽 공고화 arming. 둘 다 DISARMED 기본. READ-ONLY 판단(매매 격리).
   *  extract=dig/breaking→LLM 인과 추출(비용). anomalyDig=예측 이탈→dig_queue 자동 적재
   *  (분석 리서치·매매 아님). 새벽 배치(kg-consolidate)에서만 발동. */
  kg?: { extract?: { enabled?: boolean }; anomalyDig?: { enabled?: boolean } };
  /** ★ M4 · 새벽 수면 리플레이 자율 루프 arming(5+2 세 번째 루프). DISARMED 기본·이중
   *  게이트(dispatch.enabled AND 이 flag). idle-driven — 새벽 창(기본 06-07시)에만 arm.
   *  READ-ONLY 정리·회고(24h 기억→REPLAY.md·매매/발송 도구 격리). maxTurns 저턴(3정리). */
  replay?: { autoGoal?: { enabled?: boolean; maxTurns?: number; tokenCap?: number; windowStartHour?: number; windowEndHour?: number } };
  /** 파리티 검증된 Conatus TS 포트(conatus-backtest·conatus-screen·conatus-trend)로
   *  finance_backtest / finance_signals(screen·trend·factor)를 라우팅한다. DISARMED 기본 —
   *  false 면 기존 python shell-out 경로 100% 불변(fallback). true 면 python 미기동, TS
   *  포트 렌더로 대체(READ-ONLY·write 없음). sector_flow 는 포트 미커버라 항상 python. */
  conatusNativePort?: boolean;
  /** SEC EDGAR 가 요구하는 연락처 이메일 — 13F 조회의 `User-Agent` 에 싣는다. 코드에 박지 않는다
   *  (공개본에 개인 연락처가 실리고, 남이 돌리면 그 요청이 이 연락처로 간다). 없으면 13F 조회가
   *  «이 키를 설정하라»는 오류로 멈춘다 — SEC 는 연락처 없는 요청을 막는다. */
  secContactEmail?: string;
  /** ⭐ 실주문 마스터 스위치 (실돈·대표 정책 2026-07-22). DISARMED 기본(false) — false 면
   *  HITL 승인을 통과해도 실주문 executor 에 native placeOrder 미주입 → dry-run(실주문 0·기존 불변).
   *  true 로 켜야만(대표 명시) 정책 게이트(사용자요청 승인/자율 HITL) + verify + 소액상한 + 2단계 승인을
   *  전부 통과한 주문이 native tossOrder 로 실제 접수된다. 자율 크론 경로엔 절대 배선 안 함(정책=자율→HITL). */
  liveOrders?: boolean;
  /** ⚠️ 실주문 게이트 완화 (기본 false=엄격). true 면 실주문 경로(liveOrders+liveExecutor)에서
   *  ①소액상한 삭제(무제한) ②verify CLEARED 게이트 삭제 ③2단계→1단계 텔레그램 승인. 테스트 데몬
   *  전용 상정(운영은 false 유지=엄격: 100만 상한·verify·2단계 Pushcut). false 면 완화 전혀 없음. */
  relaxedGates?: boolean;
}

// ── Top-level ────────────────────────────────────────────────────────

/** G8 무인 리뷰루프 opt-in 라벨(auto-review) 자동부착 모드(sparse·기본 opt-in). §2b ROADMAP-elanous-is-all. */
export interface AutoReviewConfig {
  /** 'off'=전면 금지(kill switch·--auto-review 플래그도 무시) · 'opt-in'=플래그 있을 때만(기본) ·
   *  'auto'=플래그 없어도 저위험 작업(assessAutonomyEligibility 통과)에 자동 부착(G10 안전봉투 그물 위). */
  mode?: 'off' | 'opt-in' | 'auto';
  /** 2계층 리뷰 무게 판정(assessReviewDepth) 임계 — light(1차+tsc 충분)/heavy(2차 Opus 심판 머스트) 경계. sparse. */
  depth?: {
    /** light 최대 변경 파일 수(초과=heavy). 기본 5. */
    maxLightFiles?: number;
    /** light 최대 diff 라인(add+del·초과=heavy). 기본 200. */
    maxLightLines?: number;
    /** 핵심 경로 접두/부분매치(변경 시 heavy). 기본=시스템 코어(orchestrator·harness·boot 등). */
    corePaths?: string[];
    /** 계획문서 패턴(정규식·변경 시 heavy=방향 결정). 기본=PLAN/RFC/ROADMAP/MILESTONE/DESIGN/HANDOFF·docs/plans 등. */
    planDocPatterns?: string[];
  };
}

export type ModelRole = 'implement' | 'review' | 'research' | 'planning' | 'audit' | 'classify' | 'graph-grow' | 'coordinator' | 'guardian';

export type AgentModelRole = 'coordinator' | 'guardian';

export interface RoleModelConfig {
  implement?: string;
  review?: string;
  research?: string;
  planning?: string;
  audit?: string;
  classify?: string;
  'graph-grow'?: string;
  coordinator?: string;
  guardian?: string;
}

/** Sparse provider-agnostic model tier preferences by execution role. */
export type RoleModelTierConfig = Partial<Record<ModelRole, ModelTier>>;

/** 역할 한 칸이 담는 LLM 선택 — 세 칸 «전부» 옵셔널이라 「일부분만」이 1급이다.
 *  `{ provider: 'grok' }` 면 provider 만 갈리고 tier 는 아래 사다리가 채운다.
 *  ⛔ RFC-role-scoped-llm-selection-2026-08-18 §4a. */
export interface RoleLlmSpec {
  provider?: LLMProviderName;
  tier?: ModelTier;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
}

/** Reviewer-only ACP subscription selection; it is not a streaming LLM provider. */
export interface SubscriptionReviewerSpec {
  provider: 'claude-acp';
  executor?: 'cct' | 'cc';
}

/** Stable PR-number allocation for the three self-review lanes. Zero disables a lane. */
export interface ReviewerMixSpec { sol: number; claude: number; glm: number }

/** 역할별 LLM 선택(sparse). `reviewer` is the opt-in harness ACP lane. */
export type RoleLlmConfig = Partial<Record<ModelRole, RoleLlmSpec>> & { reviewer?: SubscriptionReviewerSpec; reviewerMix?: ReviewerMixSpec };

export type ModelResolutionSource = 'config' | 'tier' | 'environment' | 'default';

/** 해석된 값이 «어느 층»에서 왔는지 — ⛔ 값 옆에 출처를 두는 것이 이 축의 계약이다.
 *  `flag`/`config-role` 은 신설 층이고 나머지 넷은 기존 사다리 그대로다. */
export type RoleLlmSource = 'flag' | 'config-role' | ModelResolutionSource;

export interface RoleLlmResolution {
  model: string;
  provider: LLMProviderName;
  tier?: ModelTier;
  source: RoleLlmSource;
}

export interface ModelResolution {
  model: string;
  source: ModelResolutionSource;
}

export interface SetLaunchRoleLlmOptions {
  /** 대화형 변경(슬래시)처럼 «의도된» 교체일 때만 참. 발사 경로는 주지 않는다. */
  allowReplace?: boolean;
  /** 누가 세웠는지 — 관측에 남는다. */
  origin?: string;
}

export interface RoleLlmResolveOptions {
  config?: UserConfig;
  /** 발사 시점에 «한 번» 정해 아래로 내리는 인자 — 사다리 최상층(source='flag'). */
  overrides?: RoleLlmConfig;
  /** Test seam — 기본 process.env. `ELANOUS_ROLE_LLM_<ROLE>` 을 읽는다(source='environment'). */
  env?: NodeJS.ProcessEnv;
}

export type StewardLoopMode = 'off' | 'shadow' | 'live' | 'rescue';

export type SeatLoopMode = 'off' | 'shadow' | 'on' | 'live-safe';

export interface PersonaLoopConfig { enabled: boolean }

export interface SeatLoopConfig {
  /** Shadow observes by default; live-safe acts only through the shared rescue policy, while legacy on retains its behavior. */
  mode: SeatLoopMode;
  /** Validated loop-agent neighbor entries keyed by the observing seat. */
  neighbors?: Partial<Record<'OP' | 'TC' | 'MK' | 'UX', import('../loops/neighbors.js').Neighbor[]>>;
  /** Seat-to-seat and human questions default to shadow even when the checklist loop is on. */
  questions?: 'shadow' | 'on';
  seats?: string[];
  podPool?: string;
  reportPr?: number;
  /** Parent routing and age limits for checklist stalls; omitted values use findStalls defaults. */
  stall?: { parents?: Record<string, string>; redMinutes?: number; blockedMinutes?: number };
  /** Unlanded attempts of the same seat cell before the loop stops relaunching and asks a person. Absent or invalid means 3. */
  repeatStop?: number;
  /** OP-LOOP-DECIDE: OP seat filters open decision cards (repeat-stop → b · harness scope → b unless money/security/secret/public paths). shadow records only; live decides/routes. Absent = shadow. */
  opDecide?: { mode: 'shadow' | 'live' };
  /** IDLE-LADDER: when a seat's own queue is empty the loop picks idle work (landed-yellow rebuttal → next-release authoring → standing work → borrow an unlaunched neighbor cell). Absent = off (only the empty-queue minutes metric is recorded); 'shadow' records the pick only; 'live' lets live-safe/on launch it. */
  idleLadder?: 'shadow' | 'live';
}

export type EventSeat = 'OP' | 'TC' | 'MK' | 'UX';

export interface EventRoute { source: 'linear' | 'asana' | 'github'; kind: string; seat: EventSeat; loop: 'seat' }

export interface EventsConfig { mode: 'shadow' | 'on'; routes: EventRoute[]; linearAssignees: Record<string, EventSeat> }

export type HqFenceRole = 'telegram-poller' | 'cron' | 'seat-loop' | 'release-run' | 'conatus' | 'git-push' | 'ledger-cli';

export interface HqConfig {
  /** ssh host that keeps the lease record — homes push to it; it never sshes back (default cloud-vm). */
  arbiter?: string;
  /** This host's identity in the lease (default os.hostname()). */
  hostName?: string;
  /** Standby host (default node-b) — the quorum's third member; promoted only by the arbiter. */
  standby?: string;
  /** Lease TTL in seconds (default 1500 = 25 min). */
  ttlSeconds?: number;
  /** Arbiter silence threshold (default 3); applying promotion requires explicit opt-in. */
  autoPromote?: { enabled?: boolean; streak?: number };
  /** Roles that may still run when this host is fenced only for lack of quorum (never when a newer generation exists). Absent = none. */
  failOpenRoles?: HqFenceRole[];
  /** Per-host nexus health URL over the tailnet (default https://<host>.<tailnetDomain>:31415/v1/health). */
  healthUrls?: Record<string, string>;
  /** MagicDNS suffix (default: read from `tailscale status --json`). */
  tailnetDomain?: string;
  /** `tailscale` binary (default tailscale). */
  tailscaleBin?: string;
  /** Highest lease generation this host ever saw (default ~/.elanous-hq/seen-generation · 600). */
  seenGenerationFile?: string;
  /** Board writes only reject stale generations when explicitly enforced (default shadow). */
  boardFencing?: 'shadow' | 'enforce';
  /** Per-probe timeout in seconds (default 5). */
  probeTimeoutSeconds?: number;
}

/** GATE-REMOTE (10-06): heavy pre-landing checks (self gate · changed-file tsc · public-export test run) on a remote host at the same commit. */
export interface GateRemoteConfig {
  /** Auto-dispatch when the local 1-min load exceeds the threshold (default true). `--remote`/`--local` flags always win. */
  enabled?: boolean;
  /** ssh host (default node-b). */
  host?: string;
  /** Local 1-min load average above which checks go remote (default 20). */
  loadThreshold?: number;
  /** Legacy default cap for hosts without an entry in hostCaps (1..2, default 2). */
  hostCap?: number;
  /** Per SSH host concurrent heavy-check slots (1..8); overrides hostCap for that host. */
  hostCaps?: Record<string, number>;
  /** Bare mirror on the host (default ~/mirror/elanous-agent.git — shared with the release gate). */
  mirror?: string;
  /** Seconds to wait for a free host slot before running locally (default 600). */
  slotWaitSeconds?: number;
}

export interface ProjectConfig {
  /** `axes` is absent when the configured axes are invalid; `error` then carries the config error text. */
  rubric?: { axes?: RubricAxis[]; error?: string };
}

/** 설정에서 «졸업»하거나 죽어서 더는 읽지 않는 키. 설정 파일에 남아 있으면 로더는 값을 쓰지 않고
 *  관측 한 줄(프로세스당 한 번)과 `elanous doctor` 한 줄로 알린다 — 조용히 무시하지 않는다(설정 졸업 원칙 2). */
export interface RetiredConfigKey {
  /** 점 경로(예: `tools.selfImplement.decompositionShadow`). */
  readonly path: string;
  /** 사람이 읽는 사유·대체 한 문장. */
  readonly reason: string;
}

export const MAX_TURNS_BUDGET_KEYS = ['claude', 'codex', 'gemini', 'grok', 'openrouter', 'default'] as const;

type MaxTurnsBudgetKey = typeof MAX_TURNS_BUDGET_KEYS[number];

export type MaxTurnsBudget = Partial<Record<MaxTurnsBudgetKey, number | null>>;

export type { UserConfig } from "./schema.js";
