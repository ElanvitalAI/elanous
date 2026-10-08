// ── User config ──
//
// Reads the ACTIVE instance config for user-tunable behaviour that lives
// outside environment variables and outside individual SKILL.md frontmatter.
//
// ⛔ The path is NOT fixed — it is the resolved config dir (`elanous where`).
//    📏 2026-09-22 실측: `~/.config/elanous/config.json` 은 «없다»(그 자리는 legacy)이고
//       실물은 `~/.elanous/config.json` 이다. 옛 경로는 legacy-elanous-config-migrate.ts 가 «정당하게» 쓴다.
//    ⚠️ 그래서 여기에 경로를 «박지 않는다» — 박으면 또 늙는다(이 줄이 그렇게 늙었다).
//
// Sections:
//   - skillRouter — Phase 2 router gating (kept for back-compat).
//   - llm         — provider choice, API key, model, base URL.
//   - skills      — list of skill root dirs + active preset name.
//   - obsidian    — vault path.
//   - telegram    — bot token, allowlist, home channel.
//   - onboarding  — first-run marker so the wizard only fires once.
//
// Design principles:
//   - Absent file → default object.
//   - Malformed JSON → default object.
//   - Unknown keys are preserved in `raw` for forward-compat.
//   - Typed getters coerce to defaults when types are wrong.
//   - Cache is process-wide and opt-in reload.
//
// saveUserConfig() atomically writes the config (tmp → rename) so a
// crashed wizard cannot corrupt an existing file. Mode 0600 when the
// telegram bot token is present.

import { DRAFT_ON_STOP_MODES, parseDraftOnStopMode, type DraftOnStopMode } from './self-implement/blocked-draft-policy.js';
import { isCodexQuotaPolicy } from './oauth/codex-quota-policy.js';
import { defaultObsidianVault } from './obsidian/default-vault.js';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync,
  statSync, accessSync, constants as fsConstants,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname } from 'node:path';
import {
  REMOTE_HOME,
  GROK_MODEL,
  OPENAI_MODEL,
  ANTHROPIC_MODEL,
  LOCAL_LLM_MODEL,
  GEMINI_MODEL,
  KIMI_MODEL,
  QWEN_MODEL,
  GLM_MODEL,
} from './config.js';
import type { SkillTier } from './skills/runner.js';
import { sharedAgentSkillRoots } from './skills/shared-agent-skill-roots.js';
import {
  isModelTier,
  isModelTierProfile,
  type BudgetUserConfig,
  type ModelTier,
  type ModelTierUserConfig,
  type SmartDefaultsUserConfig,
} from './model-tier/types.js';
import { lookupLlmTierSpec } from './model-tier/llm-tier-map.js';
import { userConfigPath as nexusUserConfigPath } from './nexus/config/paths.js';
import { type StreamingMode, isStreamingMode } from './session/streaming/stream-compositor.js';
import type { DevRequestRoutingConfig } from './skills/dev-request-router.js';
import type { UrlRoutingConfig } from './skills/url-router.js';
import { migrateLegacyXdgUserConfig } from './storage/legacy-elanous-config-migrate.js';
import { withFileLockSync } from './storage/file-lock.js';
import { debug } from './debug/log.js';
import type { FoldMode } from './log-entry.js';
import {
  CLAUDE_PACKAGE_MISSING,
  INSTALLED_PLUGINS_FILENAME,
  KNOWN_MARKETPLACES_FILENAME,
  defaultClaudePluginsRoot,
  readClaudePackageLedger,
} from './plugins/adapters/claude-package.js';
// ⭐ provider↔credential SSOT — provider 를 바꾸는 자리가 키도 함께 해석해야 401 이 안 난다(escalate 근본수리).
import { resolveProviderCredential, observeCredentialResolution } from './llm/provider-credentials.js';
import {
  parseGroundingSources,
  type GroundingConfig,
} from './grounding/sources.js';

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

const SR_DEFAULTS: SkillRouterConfig = {
  autoRoute: false,
  autoRouteCountdownMs: 1500,
  llmFallback: false,
  keywordScoreThreshold: 2,
  llmConfidenceThreshold: 0.75,
  fullMenuTier: 'T1',
  fullMenuConfidenceThreshold: 0.85,
  // 2.0 requires either two explicit triggers OR one explicit + two
  // extracted — a lone auto-extracted keyword (0.6) surfaces as a
  // Tab-confirm hint but never fires silently. Tightened from 1.0 in
  // session 21 after observing frequent false-positive auto-routes
  // from short Korean trigger keywords ("요약", "정리") shared across
  // many skills' descriptions.
  autoRouteMinScore: 2.0,
  autoRouteRequireAutoTrigger: true,
  harnessExecAllowlist: [],
};

// ── LLM ──────────────────────────────────────────────────────────────

export type LLMProviderName =
  | 'auto' | 'grok' | 'openai' | 'anthropic' | 'local' | 'openai-codex' | 'gemini'
  // Chinese chat-model families · OpenAI-compatible cloud APIs.
  // Local open-weight variants (Kimi-VL · Qwen3.6 · GLM-Z1 etc.) still
  // route through the existing 'local' provider — these `kimi/qwen/glm`
  // entries name the *cloud* surface only.
  | 'kimi' | 'qwen' | 'glm'
  // 대표 2026-09-23 — OpenAI 호환 게이트웨이. kimi·qwen·glm 의 «첫 실제 경로»(모델 id `openrouter/<vendor>/<model>`).
  | 'openrouter';

/** Stored config retains its established provider normalization contract. */
// ⛔ 2026-09-23 — 손으로 적은 목록이라 새 provider 를 «조용히» 거른다: `openrouter` 를 배선(#19900)했는데
//   여기 없어서 config 로 고르면 정규화가 `auto` 로 떨궜다(「직렬화 드롭」). 자 = `test/llm-provider-name-lists.test.ts`.
export const CONFIG_LLM_PROVIDER_NAMES: readonly LLMProviderName[] = [
  'auto', 'grok', 'openai', 'anthropic', 'local', 'openai-codex', 'gemini', 'openrouter',
];

/** `ELANOUS_LLM_PROVIDER` additionally permits every declared runtime provider. */
export const RUNTIME_LLM_PROVIDER_NAMES: readonly LLMProviderName[] = [
  'auto', 'grok', 'openai', 'anthropic', 'local', 'openai-codex', 'gemini', 'kimi', 'qwen', 'glm', 'openrouter',
];

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
   *  ⛔ 리셋 크레딧 «소비»는 여기에 «없다» — 되돌릴 수 없어 사람이 명시적으로 한다. */
  codexAccountRotation?: boolean;
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
  /** 대표 2026-09-28 «크레딧 사용 허가» — 주간 한도가 찬 codex 계정도 «선불 크레딧으로 계속» 쓴다(서버가 한도 소진 시 크레딧으로 넘긴다).
   *  켜면 회전이 «후보 없음»(→ grok 폴백) 대신 지금 계정에 머물고, Pod 배분도 찬 계정을 사용률 낮은 순으로 쓴다.
   *  순서는 여전히 «구독 잔량이 남은 계정 먼저». 기본 꺼짐(크레딧은 돈이다). */
  codexCreditsAllowed?: boolean;
  /** 대표 2026-09-28 codex «한도 정책» — 한도가 차면 무엇을 하나(`src/oauth/codex-quota-policy.ts` 가 canonical):
   *  `within-quota`(한도 안에서만 · 전부 차면 멈춤) · `fallback`(한도 안 ⊕ 폴백 체인 · 기본) · `credits`(크레딧까지).
   *  회전·Pod 배분·폴백·매시 한도 알림이 «이 한 값»을 같이 읽는다. 없으면 옛 `codexCreditsAllowed` 를 읽는다. */
  codexQuotaPolicy?: 'within-quota' | 'fallback' | 'credits';
  /** ⭐⭐ codex 가 «소진된 뒤» 갈 곳을 «순서»로 정한다 (대표 2026-08-13).
   *
   *  값: `['codex-rotate', 'grok']` — 아는 칸은 그 둘뿐이고, 모르는 이름은 버린다(관측에 남는다).
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
   *  delta input items. Set false for a fully stateless wire shape —
   *  privacy-leaning users who don't want server-side conversation
   *  retention. Other providers ignore. */
  codexStore?: boolean;
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

const LLM_DEFAULTS: LLMConfig = { provider: 'auto' };

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
  /** Include the existing shared ~/.agents/skills directory. Default true; false opts out. */
  includeSharedAgentSkills?: boolean;
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

export function skillSetDir(name: SkillSetName): string | null {
  switch (name) {
    case 'claudecode': return join(REMOTE_HOME, '.claude', 'skills');
    case 'opencode':   return join(REMOTE_HOME, '.config', 'opencode', 'skills');
    case 'codex':      return join(REMOTE_HOME, '.codex', 'skills');
    case 'hermes':     return join(REMOTE_HOME, '.hermes', 'skills');
    case 'openclaw':   return join(REMOTE_HOME, '.openclaw', 'workspace', 'skills');
    default:           return null;
  }
}

export const SKILL_SET_NAMES: SkillSetName[] = [
  'claudecode', 'opencode', 'codex', 'hermes', 'openclaw', 'custom',
];

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

/** Resolve the `skills/` directory shipped with this installed package. */
export function bundledSkillsDir(packageRoot: string = dirname(import.meta.dir)): string {
  return join(packageRoot, 'skills');
}

function packageOptIn(cfg?: UserConfig): boolean {
  try { return (cfg ?? getUserConfig()).skills.includeClaudePackageSkills === true; } catch { return false; }
}

/** Stable id for a connected root: the agent it belongs to, else the folder (plugin) name. */
export function skillSourceId(path: string): string {
  if (/[/\\]\.codex[/\\]skills\/?$/.test(path)) return 'codex';
  if (/[/\\]\.claude[/\\]skills\/?$/.test(path)) return 'claude';
  const parts = path.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1] === 'skills' ? parts[parts.length - 2] : parts[parts.length - 1];
  return `plugin:${last ?? 'skills'}`;
}

/** Parse persisted `skills.sources` ⊕ the dev-only `skills.connected` key into connected sources (deduped by path). */
export function parsePersistedSkillSources(rawSources: unknown, legacyConnected: unknown): SkillSource[] | undefined {
  const out: SkillSource[] = [];
  const seen = new Set<string>();
  const push = (source: SkillSource) => { if (!seen.has(source.path)) { seen.add(source.path); out.push(source); } };
  if (Array.isArray(rawSources)) {
    for (const row of rawSources) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.path !== 'string' || !r.path.trim()) continue;
      const path = r.path.trim();
      push({ id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : skillSourceId(path), path, kind: 'connected', enabled: r.enabled !== false });
    }
  }
  if (Array.isArray(legacyConnected)) {
    for (const path of legacyConnected) if (typeof path === 'string' && path.trim()) push({ id: skillSourceId(path.trim()), path: path.trim(), kind: 'connected', enabled: true });
  }
  return out.length ? out : undefined;
}

/**
 * ★ EN5 — the ONE function every reader uses (loader · setup checklist · connect · onboarding).
 * Order is the historical order, so an old config resolves to exactly the old directory list:
 * preset (activeSet/dirs) → shared ~/.agents/skills (only when it exists) → connected → Claude package roots (opt-in).
 * Packaged `skills/` is appended by defaultSkillDirs, not listed here.
 */
export function resolveSkillSources(cfg?: UserConfig, opts?: DefaultSkillDirsOptions): SkillSource[] {
  const claudecode = skillSetDir('claudecode')!; // = ~/.claude/skills (LOCAL_SKILLS_DIR)
  const preset = (paths: string[], id: string): SkillSource[] => paths.map((path, i) => ({ id: paths.length > 1 ? `${id}:${i + 1}` : id, path, kind: 'preset', enabled: true }));
  let sources: SkillSource[] = preset([claudecode], 'claudecode');
  try {
    const sk = (cfg ?? getUserConfig()).skills;
    if (sk.activeSet !== 'custom') {
      const d = skillSetDir(sk.activeSet);
      if (d) sources = preset([d], sk.activeSet);
      else if (sk.dirs.length > 0) sources = preset([...sk.dirs], 'custom');
    } else if (sk.dirs.length > 0) {
      sources = preset([...sk.dirs], 'custom');
    }
    const has = (path: string) => sources.some((source) => source.path === path);
    const shared = sharedAgentSkillRoots({
      home: opts?.sharedAgentHome ?? REMOTE_HOME,
      includeSharedAgentSkills: sk.includeSharedAgentSkills !== false,
    });
    try { debug.log('skills.roots', 'shared-agent', { found: shared.length }); }
    catch { /* discovery remains fail-soft when observation is unavailable */ }
    for (const path of shared) if (!has(path)) sources.push({ id: 'agents', path, kind: 'shared', enabled: true });
    for (const source of sk.sources ?? []) if (!has(source.path)) sources.push({ ...source, kind: 'connected' });
    if (sk.includeClaudePackageSkills === true) {
      for (const path of appendClaudePackageSkillDirs([], opts?.pluginsRoot)) {
        if (!has(path)) sources.push({ id: `package:${skillSourceId(path).replace(/^plugin:/, '')}`, path, kind: 'package', enabled: true });
      }
    }
  } catch { /* fail-soft — config 없거나 파싱 실패 시 기본 경로 */ }
  return sources;
}

export function defaultSkillDirs(
  cfg?: UserConfig,
  opts?: DefaultSkillDirsOptions,
): string[] {
  const sources = resolveSkillSources(cfg, opts);
  const paths = sources.filter((source) => source.enabled).map((source) => source.path);
  // Historical: the package opt-in path also collapsed duplicate user dirs; the plain path kept them (index dedupes later).
  const base = sources.some((source) => source.kind === 'package') || packageOptIn(cfg) ? uniqueSkillDirsPreserveOrder(paths) : paths;
  return appendBundledSkillsDir(base, opts?.bundledSkillsRoot);
}

let claudePackageSkillDirsLedgerReads = 0;

/** 캐시를 걷었으므로 no-op 이다. 시험이 부르던 이름이라 계약을 유지한다. */
export function __resetClaudePackageSkillDirsCacheForTests(): void {
  /* no cache to reset — 원장을 매 호출 다시 읽는다 */
}

export function __claudePackageSkillDirsLedgerReadCountForTests(): number {
  return claudePackageSkillDirsLedgerReads;
}


/** Existence+access check for a Claude package `skills/` dir. Named so a false
 *  "always true" mutation makes the nonexistent-path test fail. Re-run on
 *  every opt-in call so a cached ledger mtime cannot keep a deleted dir or
 *  omit a dir that appeared / became readable after the first read. */
function isExistingClaudePackageSkillDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueSkillDirsPreserveOrder(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

function collectClaudePackageSkillDirCandidates(pluginsRoot: string): string[] {
  claudePackageSkillDirsLedgerReads += 1;
  try {
    const ledger = readClaudePackageLedger({ pluginsRoot });
    if (ledger.status !== 'ok') return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const pkg of ledger.packages) {
      if (!pkg.installPath || pkg.installPath === CLAUDE_PACKAGE_MISSING) continue;
      const skillsDir = join(pkg.installPath, 'skills');
      if (seen.has(skillsDir)) continue;
      seen.add(skillsDir);
      out.push(skillsDir);
    }
    return out;
  } catch {
    return [];
  }
}

/** ⛔ 캐시하지 않는다 — 원장을 «매 호출» 다시 읽는다.
 *
 *  📏 앞선 판은 `(경로, mtime)` 을 키로 캐시했고 리뷰가 그것을 막았다(2026-09-03 must-fix):
 *    ⓐ 성공 뒤 원장이 «읽기 불가»가 되어도 mtime 이 그대로면 캐시된 경로를 계속 더한다
 *       ⇒ 「원장을 못 읽으면 기존 목록 그대로」라는 이 착지의 수용 기준을 «위반»한다
 *    ⓑ 같은 mtime 으로 내용만 바뀐 재작성도 못 본다
 *  ⇒ 원장은 «파일 둘»이고 JSON 이 작다. 매번 읽는 비용보다 「낡은 답을 준다」가 비싸다.
 *  ⚠️ 이 함수는 opt-in(설정을 켠) 경로에서만 불린다 — 기본 경로는 여기 오지 않는다. */
function readClaudePackageSkillDirCandidates(pluginsRoot?: string): string[] {
  return collectClaudePackageSkillDirCandidates(pluginsRoot ?? defaultClaudePluginsRoot());
}

function appendClaudePackageSkillDirs(base: string[], pluginsRoot?: string): string[] {
  const extra = readClaudePackageSkillDirCandidates(pluginsRoot)
    .filter(isExistingClaudePackageSkillDir);
  return uniqueSkillDirsPreserveOrder([...base, ...extra]);
}

function appendBundledSkillsDir(base: string[], packageRoot?: string): string[] {
  const bundled = bundledSkillsDir(packageRoot);
  if (!isExistingClaudePackageSkillDir(bundled) || base.includes(bundled)) return base;
  return [...base, bundled];
}

/** Defaults for URL→skill auto-routing. enabled=true so the two main
 *  interactive channels (TUI + Telegram) route URLs out of the box;
 *  guard keywords keep code-reference / argumentative uses on the LLM
 *  path (R5/R8). Tunable via user config. */
export function urlRoutingDefaults(): UrlRoutingConfig {
  return {
    enabled: true,
    twoStage: true,
    defaultTargets: ['obsidian'],
    guardKeywords: [
      // code / build intents — URL is a reference, not a digest target
      '참고', '참조', '구현', '고쳐', '수정', '디버그', '리팩', '기반으로',
      '이 코드', '이거 보고', '보고 구현', '보고 만들',
      'implement', 'clone', 'fix', 'debug', 'refactor', 'based on',
      // argumentative / comparative analysis — not a plain digest
      '반박', '비교', '평가해', '검증해',
    ],
    absorbKeywords: ['absorb', '흡수', '지식화', 'vault', '지식창고'],
    map: { youtube: 'youtube-master', x: 'omni-digest', github: 'omni-digest', web: 'omni-digest' },
    absorbSkill: 'yt-vault',
  };
}

function parseUrlRouting(raw: unknown): UrlRoutingConfig {
  const d = urlRoutingDefaults();
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const m = (r.map && typeof r.map === 'object') ? r.map as Record<string, unknown> : {};
  const skillName = (v: unknown, fb: string) => (typeof v === 'string' && v.trim() ? v.trim() : fb);
  return {
    enabled: r.enabled === false ? false : true,     // default true
    twoStage: r.twoStage === false ? false : true,   // default true
    defaultTargets: strArray(r.defaultTargets, d.defaultTargets),
    guardKeywords: strArray(r.guardKeywords, d.guardKeywords),
    absorbKeywords: strArray(r.absorbKeywords, d.absorbKeywords),
    map: {
      youtube: skillName(m.youtube, d.map.youtube),
      x: skillName(m.x, d.map.x),
      github: skillName(m.github, d.map.github),
      web: skillName(m.web, d.map.web),
    },
    absorbSkill: skillName(r.absorbSkill, d.absorbSkill),
  };
}

export function devRequestRoutingDefaults(): DevRequestRoutingConfig {
  return {
    enabled: true,
    verbs: ['구현해줘', '고쳐줘', '만들어줘', '추가해줘', '수정해줘', '손봐줘', '붙여줄래', '잡아줘', '펴줘', '봉합해줘'],
    guardKeywords: ['어떻게', '왜 이래', '설명해줘', '알려줘', '읽어서', '어디서 쓰이는지', '회상해줘'],
  };
}

function parseDevRequestRouting(raw: unknown): DevRequestRoutingConfig {
  const d = devRequestRoutingDefaults();
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return {
    enabled: r.enabled === false ? false : true,
    verbs: strArray(r.verbs, d.verbs),
    guardKeywords: strArray(r.guardKeywords, d.guardKeywords),
  };
}

function skillsDefaults(): SkillsConfig {
  // Sprint 10a (2026-04-28) — claudecode promoted to default per user
  // feedback. Priority order in the wizard picker:
  // claudecode → codex → openclaw → hermes → opencode.
  const d = skillSetDir('claudecode');
  return {
    activeSet: 'claudecode',
    dirs: d ? [d] : [],
    giftEndpoint: 'https://elanous.ai',
    includeSharedAgentSkills: true,
    allow: [],
    deny: [],
    urlRouting: urlRoutingDefaults(),
    devRequestRouting: devRequestRoutingDefaults(),
  };
}

// ── Obsidian ─────────────────────────────────────────────────────────

export interface ObsidianConfig {
  vault: string;
  /** 격리(test) 우주의 «쓰기 시험» 볼트(예 `elantest`) — 읽기는 늘 `vault`. 볼트 쓰기 가드의 허용 목록에 든다(대표·🅞 2026-09-26). */
  testVault?: string;
}

function obsidianDefaults(): ObsidianConfig {
  return { vault: defaultObsidianVault({ env: process.env, home: REMOTE_HOME }) };
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

/** Parse a stored `telegram.reportChannel` into a typed value, or
 *  undefined when absent/malformed. A finite `chatId` is required; a
 *  non-empty string `botToken` is optional. Malformed input drops to
 *  undefined (feature off) rather than throwing — consistent with the
 *  rest of the strict parser's fail-soft posture. */
function normalizeReportChannel(raw: unknown): TelegramReportChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rc = raw as Record<string, unknown>;
  const chatId = typeof rc.chatId === 'number' ? rc.chatId : undefined;
  if (chatId === undefined || !Number.isFinite(chatId)) return undefined;
  const botToken = typeof rc.botToken === 'string' && rc.botToken.trim()
    ? rc.botToken.trim()
    : undefined;
  return botToken ? { chatId, botToken } : { chatId };
}

/** A SEPARATE bot for `elanous telegram-test` — the standalone, isolated test
 *  messenger that runs outside the production daemon. `botToken` (required)
 *  is a distinct BotFather token so getUpdates never 409s against prod;
 *  `allowedUsers` is optional (falls back to the main allowlist). */
export interface TelegramTestChannel {
  botToken: string;
  allowedUsers?: number[];
  /** 무인 주입(scripts/telegram-inject.ts·#24)의 대상 봇 username(예: `@example_temp_bot`). 봇이 여럿일
   *  때 어느 봇(테스트 채널용)에 objective 를 주입할지 명시. env `TELEGRAM_TEST_BOT`/`--to` 로도 지정 가능. */
  botUsername?: string;
}

/** Parse `telegram.testChannel`. Requires a non-empty `botToken`; drops to
 *  undefined otherwise (feature off) — fail-soft, like normalizeReportChannel. */
function normalizeTestChannel(raw: unknown): TelegramTestChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tc = raw as Record<string, unknown>;
  const botToken = typeof tc.botToken === 'string' && tc.botToken.trim()
    ? tc.botToken.trim()
    : undefined;
  if (!botToken) return undefined;
  const allowedUsers = Array.isArray(tc.allowedUsers)
    ? tc.allowedUsers.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : undefined;
  const botUsername = typeof tc.botUsername === 'string' && tc.botUsername.trim()
    ? tc.botUsername.trim()
    : undefined;
  return {
    botToken,
    ...(allowedUsers && allowedUsers.length ? { allowedUsers } : {}),
    ...(botUsername ? { botUsername } : {}),
  };
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
  /** 봇 username(예: `example_monad_bot`). 무인 유틸(scripts/telegram-inject.ts)이
   *  role/name 으로 대상 봇을 config 한 곳에서 찾도록 하는 조회용 필드. 선택. */
  botUsername?: string;
}

/** 저장된 telegram.channels[] 파싱. 각 항목은 botToken+chatId 필수. fail-soft. */
function normalizeKindRoles(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0));
  return Object.keys(out).length ? out : undefined;
}

function normalizeTelegramChannels(raw: unknown): TelegramChannel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TelegramChannel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const botToken = typeof c.botToken === 'string' && c.botToken.trim() ? c.botToken.trim() : undefined;
    const chatId = typeof c.chatId === 'number' && Number.isFinite(c.chatId) ? c.chatId : undefined;
    if (!botToken || chatId === undefined) continue;
    const botUsername = typeof c.botUsername === 'string' && c.botUsername.trim()
      ? c.botUsername.trim().replace(/^@/, '')
      : undefined;
    out.push({
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `ch-${out.length}`,
      botToken,
      chatId,
      interactive: c.interactive !== false, // 기본 true
      roles: Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === 'string') : [],
      ...(botUsername ? { botUsername } : {}),
    });
  }
  return out.length ? out : undefined;
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

const TELEGRAM_DEFAULTS: TelegramConfig = { enabled: false, allowedUsers: [] };

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

/** Parse `discord.testChannel`. Requires a non-empty `channelId`;
 *  drops to undefined otherwise (feature off) — fail-soft, mirrors
 *  telegram's normalizeTestChannel. */
function normalizeDiscordTestChannel(raw: unknown): DiscordTestChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tc = raw as Record<string, unknown>;
  const channelId = typeof tc.channelId === 'string' && tc.channelId.trim()
    ? tc.channelId.trim()
    : typeof tc.channelId === 'number' ? String(tc.channelId) : undefined;
  if (!channelId) return undefined;
  const allowedUsers = Array.isArray(tc.allowedUsers)
    ? (tc.allowedUsers as unknown[]).map(v => String(v)).filter(Boolean)
    : undefined;
  const botToken = typeof tc.botToken === 'string' && tc.botToken.trim() ? tc.botToken.trim() : undefined;
  return {
    channelId,
    ...(allowedUsers && allowedUsers.length ? { allowedUsers } : {}),
    ...(botToken ? { botToken } : {}),
  };
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

const DISCORD_DEFAULTS: DiscordConfig = { enabled: false, allowedUsers: [] };

// ── Onboarding ───────────────────────────────────────────────────────

export interface OnboardingConfig {
  webFirst?: boolean;
  ready?: boolean;
  completed: boolean;
  completedAt?: string;
  version: number;
}

const ONBOARDING_VERSION = 1;

const ONBOARDING_DEFAULTS: OnboardingConfig = { completed: false, version: 0 };

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

/**
 * 대표 2026-09-26 상한. codex 계정은 95% 이상이면 그 계정을 안 쓰고,
 * grok 은 주간 최대 50% 중 🅢 가드 48% 에서 멈춘다.
 * 🅞 흡수 크론의 «codex ≥80%» 는 이 판정의 상한이 아니다.
 */
export const DEFAULT_BUDGET_GATE_MAX_USED_PERCENT: BudgetGateMaxUsedPercent = {
  'openai-codex': 95,
  grok: 48,
};
/** 발사 관문이 grok 주간 사용률에 실제로 적용하는 상한. `elanous usage` 와 같은 수를 이 값 미만으로만 통과시킨다. */
export const LAUNCH_GROK_USED_PERCENT_CAP = 80;

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
  /** RUN-TTL sweep step: `shadow` (default) only logs; `live` sends the resync memo / adds `elanous:needs-rebase`. Cap absent or invalid = 30. */
  runTtl?: { mode: 'shadow' | 'live'; cap?: number };
  /** STOP-AUTOHEAL: `shadow` (default) only records what the stop dispatcher would do (`event='autoheal'`); `live` runs the injected heal seams once per run per stop class. */
  autoheal?: { mode: 'shadow' | 'live' };
  /** 사용자 자식 모델 선호. 없으면 해석기가 auto + fallbackChain 으로 만든다.
   *  Overload failover (OVERLOAD-FAILOVER) may move an unpinned codex child to
   *  grok. A pinned codex provider is never moved. */
  childLlm?: ChildLlmPreferenceConfig;
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

/**
 * Provider-scoped gate for native structure.
 *
 * Comparison is exact string equality (no case-fold, no alias map,
 * no trim). This file already treats `llm.provider` as an exact token
 * (`RUNTIME_LLM_PROVIDER_NAMES.includes`). This goal does not own the
 * spelling/normalization contract, so inventing one here would silently
 * disagree with callers that pass the stored provider name as-is.
 *
 * Disabled always wins. A missing list keeps the historical "all
 * providers" meaning. Consumers are not wired here — this predicate
 * is the means they will call from a later goal.
 */
export function isNativeStructureEnabledForProvider(
  nativeStructure: NativeStructureToolConfig,
  provider: string,
): boolean {
  if (nativeStructure.enabled !== true) return false;
  const list = nativeStructure.providers;
  if (list === undefined) return true;
  return list.includes(provider);
}

export interface ToolsConfig {
  deferred: DeferredToolsConfig;
  agentSpawn: AgentSpawnConfig;
  selfImplement: SelfImplementToolConfig;
  runDevHarness: RunDevHarnessToolConfig;
  selfOrchestrate: SelfOrchestrateToolConfig;
  nativeStructure: NativeStructureToolConfig;
}

const TOOLS_DEFAULTS: ToolsConfig = {
  deferred: { mode: 'always' },
  agentSpawn: { hopCap: 5 },
  runDevHarness: {},
  selfOrchestrate: {},
  nativeStructure: { enabled: false },
  // 대표 결정(2026-07-26): 오토 선호 — 기본 ON.
  selfImplement: { worktreeRoot: join(homedir(), '.elanous', 'worktrees'), childInstanceMode: 'isolated', prApprovalDelivery: 'terminal' as const, observeOnly: false, goalRecordInDoc: true, fabricDecompose: false, fabricDecomposeAutoPathThreshold: 5, autoOpenPr: true, autoStop: { enabled: true, minRung: 2 }, autoAssist: { enabled: true, minRung: 2 }, screenStallTermination: { enabled: true, minRung: 2 }, reworkBudget: { shadowStop: false, maxRounds: 3 }, decompositionShadow: { enabled: false }, clarificationEscalation: { enabled: false } },
};

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

const DEBUG_DEFAULTS: DebugConfig = { file: true, level: 'trail', exposeFullLlmTools: true, renderLogs: false };

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
  };
  /** 로그 출처 이름 오버라이드 (LF7-a). 미설정 시 자동 유도 —
   *  prod(기본) 또는 `test:<repo폴더명>` (ELANOUS_STATE_DIR 기준). */
  instanceName?: string;
}

const LOGS_DEFAULTS: LogsConfig = { retention: { maxAgeDays: 7, maxDbMb: 500 } };

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
   *  forwards so dashboard Esc kills in-flight children. Default OFF
   *  because Bash has side effects without an approval gate. */
  allowDashboardBash: boolean;
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
  /** When true, the GetDashboardState tool is surfaced to the
   *  dashboard/chat LLM. Read-only — returns current window/pane/
   *  PTY/terminal-session layout. Default ON because it's the
   *  primary vehicle for Design Principle "LLM sees current static
   *  state". Users who prefer zero tool surface can flip off. */
  allowDashboardState: boolean;
  /** Umbrella kill-switch for ALL dashboard-only optional tools
   *  (DashboardState + TerminalModal family + any future dashboard-
   *  scoped specs). When false, `buildDashboardOptionalToolSpecs`
   *  short-circuits to [] regardless of the per-tool flags above.
   *
   *  2026-05-03 PM++ — Added for stabilization mode: TUI tool
   *  exposure (DashboardState always-on + TerminalModal always-added)
   *  diverges from JSON-test (`elanous repro`) tool exposure and
   *  potentially confounds codex behavior measurement (W5-G's
   *  no-content-read streak counts dashboard tool calls toward the
   *  streak even though they're not Read/Edit/Write/Lsp). Setting
   *  this false reduces TUI tool surface to host tools only — same
   *  set the JSON test path uses — so codex behavior is comparable.
   *
   *  Default ON for backward compat. Flip OFF to standardize. */
  allowDashboardOptionalTools: boolean;
}

const SHELL_DEFAULTS: ShellConfig = {
  allowDashboardPty: false,
  allowDashboardBash: false,
  allowDashboardTerminalInject: false,
  allowDashboardApiCall: false,
  allowDashboardRunShell: false,
  allowDashboardState: true,
  allowDashboardOptionalTools: true,
};

// ── Chat presentation ───────────────────────────────────────────────
// Dashboard/system-prompt level presentation heuristics. Kept under
// user-config so every threshold is tunable and the prompt module can
// stay pure. P1 restores the missing `chat` wrapper from the pre-#600
// shape, then adds the first subtree: `chat.conciseness`.

export interface ChatConcisenessConfig {
  enabled: boolean;
  finalMessageMaxLines: number;
  preambleMaxWords: number;
  flatBullets: boolean;
}

export interface ChatToolOutputConfig {
  persistOnOverflow: boolean;
  retentionDays: number;
  previewLines: number;
}

export interface ChatAutoCompactConfig {
  enabled: boolean;
  triggerRatio: number;
  preserveLastN: number;
  /** ★ 핵심 앵커 보존(2026-07-21) — Layer 3 요약이 뭉개면 안 되는 **맨 앞 앵커**
   *  (페이즈 프롬프트/WM/premise = 첫 user 메시지) pin 개수. 리딩 system 메시지가
   *  앞서도 첫 user 메시지까지 자동 확장. 기본 1(첫 앵커 pin). 0=비활성(롤백 seam). */
  preserveFirstN: number;
  partial: boolean;
  workingBudgetTokens: number;
}

export interface ChatSystemPromptConfig {
  overridePath?: string;
  taskVariant: string;
  /** Optional builtin prompt-family override. When set, bypasses
   *  model-family inference and forces one of the builtin variants.
   *  Useful for A/B testing Codex vs GPT lane behavior without
   *  patching the registry. */
  forceBuiltinVariant?: 'gpt' | 'codex' | 'claude' | 'local';
}

export type ChatRenderingStreamingMode = 'byte' | 'line';

export interface ChatRenderingStreamingConfig {
  mode: ChatRenderingStreamingMode;
  catchUpThresholdLines: number;
  catchUpAgeMs: number;
}

/** Legacy exported type name; the compact boundary no longer has configurable fields. */
export interface ChatRenderingCompactBoundaryConfig {}

export interface ChatRenderingWrapConfig {
  urlAware: boolean;
}

export type ChatRenderingToolDisplayMode = 'legacy' | 'inline-to-block';

export interface ChatRenderingToolConfig {
  displayMode: ChatRenderingToolDisplayMode;
  blockMaxLines: number;
}

export type ChatRenderingDiffColorTier = 'auto' | 'truecolor' | '256' | 'ansi16';
export type ChatRenderingDiffHeaderStyle = 'legacy' | 'edited';
export type ChatRenderingDiffTurnBrowserMode = 'all' | 'files' | 'turns';

export interface ChatRenderingDiffConfig {
  colorTier: ChatRenderingDiffColorTier;
  headerStyle: ChatRenderingDiffHeaderStyle;
  turnBrowserHistory: number;
  turnBrowserMode: ChatRenderingDiffTurnBrowserMode;
}

export interface ChatRenderingHudConfig {
  gaugeWarnRatio: number;
  gaugeDangerRatio: number;
}

export interface ChatRenderingConfig {
  streaming: ChatRenderingStreamingConfig;
  wrap: ChatRenderingWrapConfig;
  tool: ChatRenderingToolConfig;
  diff: ChatRenderingDiffConfig;
  hud: ChatRenderingHudConfig;
}

/** PR2 (HANDOFF 2026-05-04 §5.2) — knobs for the 4-layer compact
 *  pipeline. `verifyProbe` opts into Wave 5's Gemini-style verify
 *  step before accepting a Layer 3 summary. `archive*` controls the
 *  per-session JSONL archive at ~/.elanous/compact-archive/. */
export interface ChatCompactConfig {
  verifyProbe: boolean;
  archiveEnabled: boolean;
  archiveRetentionDays: number;
  archiveRetentionMb: number;
}

/** ER1 — 액티브 덤퍼(오류 자동 보고). 기본 켬(첫 실행 안내 한 번 · 대표 10-01) · 신원(email/telegramUser)은 따로 «예»일 때만. */
export interface ErrorReportsConfig {
  /** false = never send. Absent = on (the first-run notice says how to turn it off). */
  enabled?: boolean;
  /** true = also send email / telegramUser below with each report. Default false. */
  identity?: boolean;
  email?: string;
  telegramUser?: string;
}

export function parseErrorReportsConfig(raw: unknown): ErrorReportsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: ErrorReportsConfig = {};
  if (r.enabled === false || r.enabled === 'false') out.enabled = false;
  else if (r.enabled === true || r.enabled === 'true') out.enabled = true;
  if (r.identity === true || r.identity === 'true') out.identity = true;
  if (typeof r.email === 'string' && r.email.trim()) out.email = r.email.trim();
  if (typeof r.telegramUser === 'string' && r.telegramUser.trim()) out.telegramUser = r.telegramUser.trim();
  return Object.keys(out).length ? out : undefined;
}

export interface ChatConfig {
  factQuestion: { maxToolTurns: number };
  /** Short questions may receive a tool-free first reply. Default true. */
  fastPath: boolean;
  conciseness: ChatConcisenessConfig;
  toolOutput: ChatToolOutputConfig;
  autoCompact: ChatAutoCompactConfig;
  compact: ChatCompactConfig;
  autoCopyQaToClipboard: boolean;
  systemPrompt: ChatSystemPromptConfig;
  rendering: ChatRenderingConfig;
  /** Wave 8 (2026-05-04) — tool deny list. Names matching here are
   *  filtered out of every model's tool catalog before the LLM call.
   *  Useful for security / budget control (e.g. block `WebFetch` in
   *  air-gapped environments, or `mcp__github` to disable a whole
   *  MCP server). Matching: exact tool name OR `mcp__<server>` prefix
   *  (matches all tools from that MCP server). Empty array = no
   *  filtering. ref/claude-code-fork `filterToolsByDenyRules` pattern
   *  (`src/tools.ts:262-269`). */
  toolDeny: string[];
}

const CHAT_CONCISENESS_DEFAULTS: ChatConcisenessConfig = {
  enabled: true,
  finalMessageMaxLines: 10,
  preambleMaxWords: 12,
  flatBullets: true,
};

export const CHAT_DEFAULTS: ChatConfig = {
  factQuestion: { maxToolTurns: 6 },
  fastPath: true,
  conciseness: { ...CHAT_CONCISENESS_DEFAULTS },
  toolOutput: {
    persistOnOverflow: true,
    retentionDays: 7,
    previewLines: 8,
  },
  autoCompact: {
    enabled: true,
    triggerRatio: 0.85,
    preserveLastN: 4,
    preserveFirstN: 1,
    partial: true,
    workingBudgetTokens: 256_000,
  },
  compact: {
    verifyProbe: false,
    archiveEnabled: true,
    archiveRetentionDays: 30,
    archiveRetentionMb: 100,
  },
  autoCopyQaToClipboard: false,
  systemPrompt: {
    overridePath: undefined,
    taskVariant: 'default',
    forceBuiltinVariant: undefined,
  },
  toolDeny: [],
  rendering: {
    streaming: {
      mode: 'byte',
      catchUpThresholdLines: 50,
      catchUpAgeMs: 200,
    },
    wrap: {
      urlAware: false,
    },
    tool: {
      displayMode: 'inline-to-block',
      blockMaxLines: 8,
    },
    diff: {
      colorTier: 'auto',
      headerStyle: 'legacy',
      turnBrowserHistory: 8,
      turnBrowserMode: 'all',
    },
    hud: {
      gaugeWarnRatio: 0.7,
      gaugeDangerRatio: 0.85,
    },
  },
};

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
  /** Whether supplemental global dashboard keys are registered.
   *  Defaults off so optional pane/window controls do not occupy keys
   *  required by essential input, reading, and escape controls. */
  enableSupplementalGlobalKeys: boolean;
}

export interface DashboardPromptBankConfig {
  enabled: boolean;
  dashboardTurns: boolean;
  skillRuns: boolean;
  budgetTokens: number;
  limit: number;
  record: boolean;
}

const DASHBOARD_PROMPT_BANK_DEFAULTS: DashboardPromptBankConfig = {
  enabled: false,
  dashboardTurns: false,
  skillRuns: false,
  budgetTokens: 1200,
  limit: 8,
  record: true,
};

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

const VW_KNOWN_NAMES: VwKnownName[] = ['acp', 'sim', 'iul'];
const VW_ORDER_DEFAULT: VwKnownName[] = ['acp', 'sim', 'iul'];
const VW_ENTRY_DEFAULTS: Record<VwKnownName, VwEntryConfig> = {
  acp: { resident: true, foregroundOnStartup: false },
  sim: { resident: false, foregroundOnStartup: false },
  iul: { resident: false, foregroundOnStartup: false },
};

const VW_DEFAULTS: VwConfig = {
  windowNames: {},
  paneNames: {},
  entries: {
    acp: { ...VW_ENTRY_DEFAULTS.acp },
    sim: { ...VW_ENTRY_DEFAULTS.sim },
    iul: { ...VW_ENTRY_DEFAULTS.iul },
  },
  simResident: false,
  iulResident: false,
  iulForegroundOnStartup: false,
  order: [...VW_ORDER_DEFAULT],
};

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
  /** Remove provider billing credentials from ACP child environments.
   *  Default ON; set false only when API-key authentication is intended. */
  scrubBillingEnv: boolean;
}

const ACP_DEFAULTS: AcpConfig = { hopCap: {}, toolApproval: { timeoutMs: 60_000 }, scrubBillingEnv: true };

function acpApprovalTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : undefined;
}

function acpApprovalTimeoutEnv(): number | undefined {
  const raw = process.env.ELANOUS_ACP_TOOL_APPROVAL_TIMEOUT_MS;
  return raw !== undefined && /^\d+$/.test(raw) ? acpApprovalTimeoutMs(Number(raw)) : undefined;
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

const PLAN_DEFAULTS: PlanConfig = { autoWorktree: false };

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
  /** P2 — pause active goal on EnterPlanMode. Default true (Codex). */
  pauseOnPlanModeEnter: boolean;
  /** P2 — auto-resume on plan mode exit? Default false (explicit
   *  `/goal resume` required to avoid drift). */
  resumeOnPlanModeExit: boolean;
  /** Default mode for new goals. P1 only ships `judge`; `spec` is P3. */
  modeDefault: 'judge' | 'spec';
}

const GOALS_DEFAULTS: GoalsConfig = {
  maxTurns: 20,
  wallClockMaxMs: 30 * 60_000,
  tokenBudget: 200_000,
  judgeModel: '',
  judgeRetries: 1,
  pauseOnPlanModeEnter: true,
  resumeOnPlanModeExit: false,
  modeDefault: 'judge',
};

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

const REGISTRY_DEFAULTS: RegistryConfig = {
  discovery: {
    cron: {},
    firecrawl: {},
  },
};

// ── modelTier / budget / smartDefaults (M1-1 · 2026-05-12) ───────────
//
// Three sparse sub-trees for the friction-free model selection UX. Each
// parser returns `undefined` when nothing concrete was set so the
// UserConfig stays sparse — resolvers in `src/model-tier/` fall through
// to the zero-config defaults (Balanced tier, no cap, auto-suggest on).

function spreadIfDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
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
function parseTasteConfig(raw: unknown): TasteConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: TasteConfig = {};
  if (typeof r.captureEnabled === 'boolean') out.captureEnabled = r.captureEnabled;
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim();
  if (typeof r.proposeEnabled === 'boolean') out.proposeEnabled = r.proposeEnabled;
  if (typeof r.proposeThreshold === 'number' && Number.isFinite(r.proposeThreshold)) out.proposeThreshold = r.proposeThreshold;
  if (typeof r.proposeCooldownDays === 'number' && Number.isFinite(r.proposeCooldownDays)) out.proposeCooldownDays = r.proposeCooldownDays;
  return Object.keys(out).length > 0 ? out : undefined;
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
}

/** OpenDesign 데몬 접속. url 이 없으면 시안 생성은 꺼진 것이다. tokenFile 은 토큰 «경로»만 담는다. */
export interface OpenDesignConfig {
  url?: string;
  tokenFile?: string;
}

export interface DesignConfig {
  openDesign?: OpenDesignConfig;
}

function parseOpenDesignConfig(raw: unknown): OpenDesignConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: OpenDesignConfig = {};
  if (typeof r.url === 'string' && r.url.trim()) out.url = r.url.trim();
  if (typeof r.tokenFile === 'string' && r.tokenFile.trim()) out.tokenFile = r.tokenFile.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseDiagnosticsConfig(raw: unknown): UserConfig['diagnostics'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).uploadUrl;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined;
    return { uploadUrl: url.href };
  } catch { return undefined; }
}

function parseDesignConfig(raw: unknown): DesignConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const openDesign = parseOpenDesignConfig(r.openDesign);
  return openDesign ? { openDesign } : undefined;
}
function parseWebSearchConfig(raw: unknown): WebSearchConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: WebSearchConfig = {};
  if (r.tavily && typeof r.tavily === 'object' && !Array.isArray(r.tavily)) {
    const t = r.tavily as Record<string, unknown>;
    if (typeof t.enabled === 'boolean') out.tavily = { enabled: t.enabled };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** tavily 를 **상시 경로**에 쓸 것인가. ⛔ 미설정이면 **false**(부재 = 끔).
 *  ⭐ 한 자리에서만 판정한다 — 소비처가 각자 `?.enabled` 를 읽으면 기본값 해석이 갈린다. */
export function isTavilySearchEnabled(cfg: Pick<UserConfig, 'webSearch'> = getUserConfig()): boolean {
  return cfg.webSearch?.tavily?.enabled === true;
}

function parseSessionFabricConfig(raw: unknown): SessionFabricConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: SessionFabricConfig = {};
  if (typeof r.shadowFanout === 'boolean') out.shadowFanout = r.shadowFanout;
  if (r.primary && typeof r.primary === 'object' && !Array.isArray(r.primary)) {
    const p = r.primary as Record<string, unknown>;
    const primary: { telegram?: boolean; discord?: boolean; pwaMsg?: boolean } = {};
    if (typeof p.telegram === 'boolean') primary.telegram = p.telegram;
    if (typeof p.discord === 'boolean') primary.discord = p.discord;
    if (typeof p.pwaMsg === 'boolean') primary.pwaMsg = p.pwaMsg;
    if (Object.keys(primary).length > 0) out.primary = primary;
  }
  if (r.streaming && typeof r.streaming === 'object' && !Array.isArray(r.streaming)) {
    const p = r.streaming as Record<string, unknown>;
    const streaming: { telegram?: boolean; discord?: boolean; acp?: boolean } = {};
    if (typeof p.telegram === 'boolean') streaming.telegram = p.telegram;
    if (typeof p.discord === 'boolean') streaming.discord = p.discord;
    if (typeof p.acp === 'boolean') streaming.acp = p.acp;
    if (Object.keys(streaming).length > 0) out.streaming = streaming;
  }
  for (const surf of ['telegram', 'discord'] as const) {
    const raw = r[surf];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const s = raw as Record<string, unknown>;
      const surfCfg: { streamingMode?: StreamingMode; editGapMs?: number; typing?: boolean; fairQueue?: boolean; rotate?: boolean } = {};
      if (isStreamingMode(s.streamingMode)) surfCfg.streamingMode = s.streamingMode;
      if (typeof s.editGapMs === 'number' && Number.isFinite(s.editGapMs) && s.editGapMs > 0) surfCfg.editGapMs = s.editGapMs;
      // 텔레그램 전용 강화 노브(§5.2·§10-2). discord 에 오면 무시(파서는 관대·sink 가 미사용).
      if (surf === 'telegram') {
        if (typeof s.typing === 'boolean') surfCfg.typing = s.typing;
        if (typeof s.fairQueue === 'boolean') surfCfg.fairQueue = s.fairQueue;
        if (typeof s.rotate === 'boolean') surfCfg.rotate = s.rotate;
      }
      if (Object.keys(surfCfg).length > 0) out[surf] = surfCfg;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseNextFluentConfig(raw: unknown): UserConfig['nextFluent'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<UserConfig['nextFluent']> = {};
  if (typeof r.personas === 'boolean') out.personas = r.personas;
  if (r.models && typeof r.models === 'object' && !Array.isArray(r.models)) {
    out.models = Object.fromEntries(
      Object.entries(r.models).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseModelTierFieldOrUndefined(v: unknown): ModelTier | undefined {
  return isModelTier(v) ? v : undefined;
}

function parseModelTierConfig(raw: unknown): ModelTierUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  // Compatibility is read-only: the normalized config and subsequent writes use profile.
  let profile = isModelTierProfile(r.profile) ? r.profile : undefined;
  if (r.profile === undefined && r.persona !== undefined) {
    debug.log('config', 'deprecated-key', { from: 'modelTier.persona', to: 'modelTier.profile' });
    if (isModelTierProfile(r.persona)) profile = r.persona;
  }
  const preset = typeof r.preset === 'string' && r.preset.trim().length > 0
    ? r.preset.trim()
    : undefined;
  const voiceRaw = r.voice && typeof r.voice === 'object' && !Array.isArray(r.voice)
    ? r.voice as Record<string, unknown>
    : undefined;
  const voiceStt = voiceRaw ? parseModelTierFieldOrUndefined(voiceRaw.stt) : undefined;
  const voiceTts = voiceRaw ? parseModelTierFieldOrUndefined(voiceRaw.tts) : undefined;
  // M2-2b — per-context voice identity sub-tree. Each context is a
  // non-empty string voice id; invalid keys drop silently so the
  // sparse-parse pattern stays consistent with siblings.
  const ttsVoiceRaw = voiceRaw && voiceRaw.ttsVoice && typeof voiceRaw.ttsVoice === 'object' && !Array.isArray(voiceRaw.ttsVoice)
    ? voiceRaw.ttsVoice as Record<string, unknown>
    : undefined;
  const ttsVoice: Record<string, string> = {};
  if (ttsVoiceRaw) {
    for (const ctx of ['default', 'chat', 'digest', 'alert', 'discord']) {
      const v = ttsVoiceRaw[ctx];
      if (typeof v === 'string' && v.trim().length > 0) ttsVoice[ctx] = v.trim();
    }
  }
  const voiceTtsVoice = Object.keys(ttsVoice).length > 0 ? ttsVoice : undefined;
  const voice = voiceStt !== undefined || voiceTts !== undefined || voiceTtsVoice !== undefined
    ? {
        ...spreadIfDefined('stt', voiceStt),
        ...spreadIfDefined('tts', voiceTts),
        ...spreadIfDefined('ttsVoice', voiceTtsVoice),
      }
    : undefined;
  const llm = parseModelTierFieldOrUndefined(r.llm);
  const embedding = parseModelTierFieldOrUndefined(r.embedding);
  const vision = parseModelTierFieldOrUndefined(r.vision);
  const out: ModelTierUserConfig = {
    ...spreadIfDefined('profile', profile),
    ...spreadIfDefined('preset', preset),
    ...spreadIfDefined('voice', voice),
    ...spreadIfDefined('llm', llm),
    ...spreadIfDefined('embedding', embedding),
    ...spreadIfDefined('vision', vision),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseFiniteNonNegativeUsd(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseBudgetConfig(raw: unknown): BudgetUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const monthlyUsdCap = parseFiniteNonNegativeUsd(r.monthlyUsdCap);
  const dailyUsdCap = parseFiniteNonNegativeUsd(r.dailyUsdCap);
  const fallbackTier = parseModelTierFieldOrUndefined(r.fallbackTier);
  const notifyAtPct = typeof r.notifyAtPct === 'number'
    && Number.isFinite(r.notifyAtPct)
    && r.notifyAtPct >= 0
    && r.notifyAtPct <= 100
    ? r.notifyAtPct
    : undefined;
  const out: BudgetUserConfig = {
    ...spreadIfDefined('monthlyUsdCap', monthlyUsdCap),
    ...spreadIfDefined('dailyUsdCap', dailyUsdCap),
    ...spreadIfDefined('fallbackTier', fallbackTier),
    ...spreadIfDefined('notifyAtPct', notifyAtPct),
  };
  return Object.keys(out).length > 0 ? out : undefined;
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

function parseApnsConfig(raw: unknown): ApnsUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const keyId    = typeof r.keyId    === 'string' && r.keyId.trim().length    > 0 ? r.keyId.trim()    : undefined;
  const teamId   = typeof r.teamId   === 'string' && r.teamId.trim().length   > 0 ? r.teamId.trim()   : undefined;
  const bundleId = typeof r.bundleId === 'string' && r.bundleId.trim().length > 0 ? r.bundleId.trim() : undefined;
  const keyPath  = typeof r.keyPath  === 'string' && r.keyPath.trim().length  > 0 ? r.keyPath.trim()  : undefined;
  if (!keyId || !teamId || !bundleId || !keyPath) return undefined;
  const environment: 'production' | 'sandbox' | undefined =
    r.environment === 'sandbox' ? 'sandbox'
    : r.environment === 'production' ? 'production'
    : undefined;
  return {
    keyId, teamId, bundleId, keyPath,
    ...spreadIfDefined('environment', environment),
  };
}

function parseNotificationsConfig(raw: unknown): NotificationsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const apns = parseApnsConfig(r.apns);
  if (!apns) return undefined;
  return { apns };
}

function parseMcpCommand(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const command: string[] = [];
  for (const part of raw) {
    if (typeof part !== 'string' || part.length === 0) return undefined;
    command.push(part);
  }
  if (command.length === 0) return undefined;
  return command;
}

function normalizeMcpTransport(raw: unknown): McpTransport | undefined {
  if (typeof raw !== 'string') return undefined;
  const kind = raw.trim();
  if (kind === 'stdio') return 'stdio';
  if (kind === 'http' || kind === 'streamable-http') return 'http';
  return undefined;
}

/** User-visible diagnostic for the one silent-drop contract this landing breaks. */
export function formatMcpUrlWithoutTransportDiagnostic(id: string): string {
  return `[user-config] mcp server "${id}" has a url but no transport; set transport to "http"`;
}

function warnMcpUrlWithoutTransport(id: string): void {
  const message = formatMcpUrlWithoutTransportDiagnostic(id);
  try { console.warn(message); } catch { /* parse must never throw */ }
  try {
    debug.log('user-config.mcp', 'url-without-transport', { id, hint: 'http' });
  } catch { /* parse must never throw */ }
}

/** ⛔⭐ **권한 필드다 — 「모르는 값은 허가하지 않는다」로 읽는다.**
 *
 *  배열이 아니면 `undefined`(= 아무것도 허가 안 함) · 배열이면 «비지 않은 문자열»만 남긴다.
 *  ⇒ 오타·잘못된 타입이 «허가를 늘리는» 방향으로는 절대 못 간다(항목 단위 fail-closed).
 *  ⛔ 서버 전체를 버리지는 않는다 — 오타 하나로 서버가 조용히 사라지면 더 나쁘다.
 *
 *  📌 이 함수가 «없어서» 회귀가 났다: 필드는 `McpServerSpec` 에 있는데 파서가 안 읽어
 *  config 에 적은 `authorizedTools` 가 조용히 버려졌고, `registerMcpClients` 가 항상 빈
 *  배열을 돌아 ***모든 MCP 프록시 툴이 영구히 거부***됐다(사후 리뷰가 잡음). */
function parseMcpHandshakeTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const timeoutMs = Math.floor(raw);
  return timeoutMs >= 1 && timeoutMs <= 2_147_483_647 ? timeoutMs : undefined;
}

function parseMcpAuthorizedTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name.length === 0) continue;
    if (!out.includes(name)) out.push(name);   // 중복은 접는다 — 결정론
  }
  return out;
}

function parseMcpServerSpec(raw: unknown): McpServerSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.trim().length > 0 ? r.id.trim() : undefined;
  if (!id) return undefined;
  const enabled: boolean | undefined =
    typeof r.enabled === 'boolean' ? r.enabled : undefined;
  // ⛔ 권한 필드 — 네 반환 경로 «전부»에 실어야 한다(하나만 빠져도 그 조합에서 허가가 죽는다).
  const authorizedTools = parseMcpAuthorizedTools(r.authorizedTools);
  const handshakeTimeoutMs = parseMcpHandshakeTimeoutMs(r.handshakeTimeoutMs);
  // Presence ≠ validity. `null` / `42` / `''` / `'   '` are explicit
  // malformed transports (silent drop), not "transport omitted".
  const transportPresent = Object.hasOwn(r, 'transport');
  const transport = normalizeMcpTransport(r.transport);
  const url = typeof r.url === 'string' && r.url.length > 0 ? r.url : undefined;
  const oauthIssuer = typeof r.oauthIssuer === 'string' && r.oauthIssuer.trim().length > 0
    ? r.oauthIssuer.trim()
    : undefined;
  const oauthTokenEndpoint = typeof r.oauthTokenEndpoint === 'string' && r.oauthTokenEndpoint.trim().length > 0
    ? r.oauthTokenEndpoint.trim()
    : undefined;
  const bearerTokenEnv = typeof r.bearerTokenEnv === 'string' && r.bearerTokenEnv.trim().length > 0
    ? r.bearerTokenEnv.trim()
    : undefined;
  const command = parseMcpCommand(r.command);

  // 1. Field combination validity — before transport inference.
  // `{ id, command, url }` is mixed malformed whether or not transport is
  // written: legacy `command` already means stdio, so this is not the
  // URL-only copy-paste trap. Silent drop, never warn.
  if (r.command !== undefined && r.url !== undefined) return undefined;
  if (transport === 'http' && r.command !== undefined) return undefined;
  if (transport === 'stdio' && r.url !== undefined) return undefined;

  // 2. Explicit transport value validation.
  if (transportPresent && transport === undefined) return undefined;

  // 3. Legacy stdio inference: omitted transport + command → child process.
  if (!transportPresent && command) {
    return {
      id,
      transport: 'stdio',
      command,
      ...spreadIfDefined('enabled', enabled),
      ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
      ...spreadIfDefined('authorizedTools', authorizedTools),
    };
  }

  // 4. URL-only trap: omitted transport + url (and no command — mixed
  // already returned). Intentional break of silent-drop: name the entry
  // and tell the user to set `http`.
  if (!transportPresent && url) {
    warnMcpUrlWithoutTransport(id);
    return undefined;
  }

  if (transport === 'http') {
    if (!url) return undefined;
    return {
      id,
      transport: 'http',
      url,
      ...spreadIfDefined('oauthIssuer', oauthIssuer),
      ...spreadIfDefined('oauthTokenEndpoint', oauthTokenEndpoint),
      ...spreadIfDefined('bearerTokenEnv', bearerTokenEnv),
      ...spreadIfDefined('enabled', enabled),
      ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
      ...spreadIfDefined('authorizedTools', authorizedTools),
    };
  }

  // Explicit `stdio` requires command.
  if (!command) return undefined;
  return {
    id,
    transport: 'stdio',
    command,
    ...spreadIfDefined('enabled', enabled),
    ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
    ...spreadIfDefined('authorizedTools', authorizedTools),
  };
}

function parseMcpConfig(raw: unknown): McpConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === false ? false : undefined; // strict false flips off
  const handshakeTimeoutMs = parseMcpHandshakeTimeoutMs(r.handshakeTimeoutMs);
  const widgetServerId = typeof r.widgetServerId === 'string' && r.widgetServerId.trim().length > 0
    ? r.widgetServerId.trim()
    : undefined;
  const servers: McpServerSpec[] = [];
  if (Array.isArray(r.servers)) {
    for (const entry of r.servers) {
      const spec = parseMcpServerSpec(entry);
      if (spec) servers.push(spec);
    }
  }
  // Keep a named widget binding even when the server list is empty or
  // absent so boot can log unknown-widget-server-id and fall back.
  // The master switch alone is still enough to retain `{ enabled: false }`.
  if (servers.length === 0 && enabled === undefined && handshakeTimeoutMs === undefined && widgetServerId === undefined) return undefined;
  return {
    servers,
    ...(enabled === false ? { enabled: false } : {}),
    ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
    ...spreadIfDefined('widgetServerId', widgetServerId),
  };
}

function parseBackgroundReasoningLlmConfig(raw: unknown): BackgroundReasoningLlmConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const endpoint = typeof r.endpoint === 'string' && r.endpoint.trim().length > 0 ? r.endpoint.trim() : undefined;
  if (!endpoint) return undefined;
  const entityModel = typeof r.entityModel === 'string' && r.entityModel.trim().length > 0 ? r.entityModel.trim() : undefined;
  const embeddingModel = typeof r.embeddingModel === 'string' && r.embeddingModel.trim().length > 0 ? r.embeddingModel.trim() : undefined;
  const apiKey = typeof r.apiKey === 'string' && r.apiKey.trim().length > 0 ? r.apiKey.trim() : undefined;
  return {
    endpoint,
    ...spreadIfDefined('entityModel', entityModel),
    ...spreadIfDefined('embeddingModel', embeddingModel),
    ...spreadIfDefined('apiKey', apiKey),
  };
}

function parseBackgroundReasoningConfig(raw: unknown): BackgroundReasoningConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const llm = parseBackgroundReasoningLlmConfig(r.llm);
  if (!llm) return undefined;
  return { llm };
}

function parseSmartDefaultsConfig(raw: unknown): SmartDefaultsUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const autoSuggest = typeof r.autoSuggest === 'boolean' ? r.autoSuggest : undefined;
  const suppressPatternHints = typeof r.suppressPatternHints === 'boolean'
    ? r.suppressPatternHints
    : undefined;
  const out: SmartDefaultsUserConfig = {
    ...spreadIfDefined('autoSuggest', autoSuggest),
    ...spreadIfDefined('suppressPatternHints', suppressPatternHints),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse `tools.nativeStructure.providers`.
 *
 * Absent / undefined → no list (legacy "all providers when enabled").
 * A well-formed string array (including empty) is kept as written.
 * Any other shape is invalid: fall back to "no list" and let the
 * caller emit the existing `[user-config] … 기본값 …` stderr note.
 */
function parseNativeStructureProviders(raw: unknown): {
  providers: readonly string[] | undefined;
  invalid: boolean;
} {
  if (raw === undefined) return { providers: undefined, invalid: false };
  if (!Array.isArray(raw)) return { providers: undefined, invalid: true };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { providers: undefined, invalid: true };
    out.push(item);
  }
  return { providers: out, invalid: false };
}

function parseToolsConfig(raw: unknown): ToolsConfig {
  // Fallback to defaults on any malformed input — we never want to
  // crash a session on a typo in tools.deferred.mode.
  const empty: ToolsConfig = {
    deferred: { ...TOOLS_DEFAULTS.deferred },
    agentSpawn: { ...TOOLS_DEFAULTS.agentSpawn },
    runDevHarness: { ...TOOLS_DEFAULTS.runDevHarness },
    selfOrchestrate: { ...TOOLS_DEFAULTS.selfOrchestrate },
    nativeStructure: { ...TOOLS_DEFAULTS.nativeStructure },
    selfImplement: { ...TOOLS_DEFAULTS.selfImplement },
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const root = raw as Record<string, unknown>;
  const runDevHarnessRaw = (root.runDevHarness && typeof root.runDevHarness === 'object' && !Array.isArray(root.runDevHarness))
    ? root.runDevHarness as Record<string, unknown>
    : {};
  const runDevHarness: RunDevHarnessToolConfig = typeof runDevHarnessRaw.modelSurface === 'boolean'
    ? { modelSurface: runDevHarnessRaw.modelSurface }
    : {};
  const selfOrchestrateRaw = (root.selfOrchestrate && typeof root.selfOrchestrate === 'object' && !Array.isArray(root.selfOrchestrate))
    ? root.selfOrchestrate as Record<string, unknown>
    : {};
  const selfOrchestrate: SelfOrchestrateToolConfig = typeof selfOrchestrateRaw.modelSurface === 'boolean'
    ? { modelSurface: selfOrchestrateRaw.modelSurface }
    : {};
  const nativeStructureRaw = (root.nativeStructure && typeof root.nativeStructure === 'object' && !Array.isArray(root.nativeStructure))
    ? root.nativeStructure as Record<string, unknown>
    : {};
  const nativeStructureProvidersRaw = nativeStructureRaw.providers;
  const nativeStructureProvidersParsed = parseNativeStructureProviders(nativeStructureProvidersRaw);
  if (nativeStructureProvidersParsed.invalid) {
    try {
      process.stderr.write(
        `[user-config] tools.nativeStructure.providers 는 문자열 배열이어야 합니다(${JSON.stringify(nativeStructureProvidersRaw)}) — 기본값(목록 없음)으로 진행합니다.\n`,
      );
    } catch { /* swallow — stderr 가 닫힌 경우 */ }
  }
  const nativeStructure: NativeStructureToolConfig = {
    enabled: typeof nativeStructureRaw.enabled === 'boolean'
      ? nativeStructureRaw.enabled
      : TOOLS_DEFAULTS.nativeStructure.enabled,
    ...(nativeStructureProvidersParsed.providers === undefined
      ? {}
      : { providers: nativeStructureProvidersParsed.providers }),
  };
  const deferred = (root.deferred && typeof root.deferred === 'object' && !Array.isArray(root.deferred))
    ? root.deferred as Record<string, unknown>
    : {};
  const rawMode = deferred.mode;
  const mode: DeferredToolsMode = rawMode === 'off' ? 'off' : 'always';
  // Wave 5 E3: agentSpawn.hopCap
  const agentSpawnRaw = (root.agentSpawn && typeof root.agentSpawn === 'object' && !Array.isArray(root.agentSpawn))
    ? root.agentSpawn as Record<string, unknown>
    : {};
  const hopCapRaw = agentSpawnRaw.hopCap;
  const hopCap = typeof hopCapRaw === 'number' && Number.isFinite(hopCapRaw) && hopCapRaw >= 0
    ? Math.floor(hopCapRaw)
    : TOOLS_DEFAULTS.agentSpawn.hopCap;
  // ⭐ selfImplement.autoOpenPr — 기본 ON(대표 결정). **명시적 false 만** 끈다:
  //   오타/누락/비-boolean 은 기본값(true)으로 수렴한다(다른 노브와 동형 fail-soft).
  const selfImplRaw = (root.selfImplement && typeof root.selfImplement === 'object' && !Array.isArray(root.selfImplement))
    ? root.selfImplement as Record<string, unknown>
    : {};
  const observeOnly = typeof selfImplRaw.observeOnly === 'boolean'
    ? selfImplRaw.observeOnly
    : TOOLS_DEFAULTS.selfImplement.observeOnly;
  const goalRecordInDoc = typeof selfImplRaw.goalRecordInDoc === 'boolean'
    ? selfImplRaw.goalRecordInDoc
    : TOOLS_DEFAULTS.selfImplement.goalRecordInDoc;
  const goalAuthorPersistentGrounding = typeof selfImplRaw.goalAuthorPersistentGrounding === 'boolean'
    ? selfImplRaw.goalAuthorPersistentGrounding
    : undefined;
  const fabricDecompose = selfImplRaw.fabricDecompose === true;
  const fabricDecomposeAutoPathThresholdRaw = selfImplRaw.fabricDecomposeAutoPathThreshold;
  const fabricDecomposeAutoPathThreshold = fabricDecomposeAutoPathThresholdRaw === null
    ? null
    : typeof fabricDecomposeAutoPathThresholdRaw === 'number'
      && Number.isFinite(fabricDecomposeAutoPathThresholdRaw)
      && Number.isInteger(fabricDecomposeAutoPathThresholdRaw)
      && fabricDecomposeAutoPathThresholdRaw >= 1
      ? fabricDecomposeAutoPathThresholdRaw
      : TOOLS_DEFAULTS.selfImplement.fabricDecomposeAutoPathThreshold;
  const worktreeRootRaw = selfImplRaw.worktreeRoot;
  const expandedWorktreeRoot = typeof worktreeRootRaw === 'string' && worktreeRootRaw.trim()
    ? worktreeRootRaw.trim().replace(/^~(?=\/|$)/, homedir())
    : undefined;
  const worktreeRoot = expandedWorktreeRoot && isAbsolute(expandedWorktreeRoot)
    ? expandedWorktreeRoot
    : TOOLS_DEFAULTS.selfImplement.worktreeRoot;
  const childInstanceMode: SelfImplementChildInstanceMode = selfImplRaw.childInstanceMode === 'inherit'
    ? 'inherit'
    : 'isolated';
  const autoOpenPrRaw = selfImplRaw.autoOpenPr;
  const autoStopRaw = (selfImplRaw.autoStop && typeof selfImplRaw.autoStop === 'object' && !Array.isArray(selfImplRaw.autoStop))
    ? selfImplRaw.autoStop as Record<string, unknown>
    : {};
  const autoStop = {
    // 설정 졸업 1-a(2026-09-24): 기본 켬 · `enabled` 는 폐기 키(`RETIRED_CONFIG_KEYS`) — 파일 값을 읽지 않는다.
    enabled: TOOLS_DEFAULTS.selfImplement.autoStop.enabled,
    minRung: typeof autoStopRaw.minRung === 'number' && Number.isFinite(autoStopRaw.minRung)
      ? Math.max(0, Math.floor(autoStopRaw.minRung))
      : TOOLS_DEFAULTS.selfImplement.autoStop.minRung,
  };
  const autoAssistRaw = (selfImplRaw.autoAssist && typeof selfImplRaw.autoAssist === 'object' && !Array.isArray(selfImplRaw.autoAssist))
    ? selfImplRaw.autoAssist as Record<string, unknown>
    : {};
  const autoAssist = {
    // 설정 졸업 1-a(2026-09-24): 기본 켬 · `enabled` 는 폐기 키(`RETIRED_CONFIG_KEYS`) — 파일 값을 읽지 않는다.
    enabled: TOOLS_DEFAULTS.selfImplement.autoAssist.enabled,
    minRung: typeof autoAssistRaw.minRung === 'number' && Number.isFinite(autoAssistRaw.minRung)
      ? Math.max(0, Math.floor(autoAssistRaw.minRung))
      : TOOLS_DEFAULTS.selfImplement.autoAssist.minRung,
  };
  const screenStallTerminationRaw = (selfImplRaw.screenStallTermination && typeof selfImplRaw.screenStallTermination === 'object' && !Array.isArray(selfImplRaw.screenStallTermination))
    ? selfImplRaw.screenStallTermination as Record<string, unknown>
    : {};
  const screenStallTermination = {
    // 설정 졸업 1-a(2026-09-24): 기본 켬 · `enabled` 는 폐기 키(`RETIRED_CONFIG_KEYS`) — 파일 값을 읽지 않는다.
    enabled: TOOLS_DEFAULTS.selfImplement.screenStallTermination.enabled,
    minRung: typeof screenStallTerminationRaw.minRung === 'number' && Number.isFinite(screenStallTerminationRaw.minRung)
      ? Math.max(0, Math.floor(screenStallTerminationRaw.minRung))
      : TOOLS_DEFAULTS.selfImplement.screenStallTermination.minRung,
  };
  const reworkBudgetRaw = (selfImplRaw.reworkBudget && typeof selfImplRaw.reworkBudget === 'object' && !Array.isArray(selfImplRaw.reworkBudget))
    ? selfImplRaw.reworkBudget as Record<string, unknown>
    : {};
  const reworkBudgetMaxRoundsRaw = reworkBudgetRaw.maxRounds;
  const reworkBudgetMaxRounds = typeof reworkBudgetMaxRoundsRaw === 'number'
    && Number.isFinite(reworkBudgetMaxRoundsRaw)
    && Number.isInteger(reworkBudgetMaxRoundsRaw)
    && reworkBudgetMaxRoundsRaw >= 1
    ? reworkBudgetMaxRoundsRaw
    : TOOLS_DEFAULTS.selfImplement.reworkBudget.maxRounds;
  if (reworkBudgetMaxRoundsRaw !== undefined && reworkBudgetMaxRoundsRaw !== reworkBudgetMaxRounds) {
    try {
      process.stderr.write(
        `[user-config] tools.selfImplement.reworkBudget.maxRounds 는 1 이상의 유한한 정수여야 합니다(${JSON.stringify(reworkBudgetMaxRoundsRaw)}) — 기본값 ${TOOLS_DEFAULTS.selfImplement.reworkBudget.maxRounds} 로 진행합니다.\n`,
      );
    } catch { /* swallow — stderr 가 닫힌 경우 */ }
  }
  const reworkBudget = {
    shadowStop: typeof reworkBudgetRaw.shadowStop === 'boolean'
      ? reworkBudgetRaw.shadowStop
      : TOOLS_DEFAULTS.selfImplement.reworkBudget.shadowStop,
    maxRounds: reworkBudgetMaxRounds,
  };
  // 폐기 키(`RETIRED_CONFIG_KEYS`) — 설정 파일 값은 읽지 않는다(읽는 곳이 없다 · 2026-09-24 설정 졸업 0-a).
  //   타입 칸은 기존 시험 픽스처가 넣으므로 남기고, 값은 늘 기본이다.
  const decompositionShadow = { enabled: TOOLS_DEFAULTS.selfImplement.decompositionShadow.enabled };
  const clarificationEscalationRaw = (selfImplRaw.clarificationEscalation && typeof selfImplRaw.clarificationEscalation === 'object' && !Array.isArray(selfImplRaw.clarificationEscalation))
    ? selfImplRaw.clarificationEscalation as Record<string, unknown>
    : {};
  // ⛔ 정수화 «뒤에» 양수를 본다 — 0 < v < 1 이 Math.floor 로 0 이 되어 「즉시 만료」가 된다(리뷰 지적).
  const clarificationTimeoutRaw = clarificationEscalationRaw.timeoutMs;
  const clarificationTimeoutMs = typeof clarificationTimeoutRaw === 'number'
    && Number.isFinite(clarificationTimeoutRaw)
    && Math.floor(clarificationTimeoutRaw) >= 1
    // ⛔ setTimeout 은 32-bit 상한(2^31-1)을 넘는 지연을 «즉시 만료»로 축소한다 —
    //    「아주 길게 기다리라」가 「기다리지 마라」가 된다(무인 리뷰 R6).
    && Math.floor(clarificationTimeoutRaw) <= 2_147_483_647
    ? Math.floor(clarificationTimeoutRaw)
    : undefined;
  const clarificationEscalation: SelfImplementClarificationEscalationConfig = {
    enabled: clarificationEscalationRaw.enabled === true,
    ...(clarificationTimeoutMs === undefined ? {} : { timeoutMs: clarificationTimeoutMs }),
  };
  const childLlm = parseChildLlmPreference(selfImplRaw.childLlm);
  const runTtlHoursRaw = selfImplRaw.runTtlHours;
  const runTtlHours = typeof runTtlHoursRaw === 'number' && Number.isFinite(runTtlHoursRaw) && runTtlHoursRaw > 0 ? runTtlHoursRaw : undefined;
  const runTtlRaw = selfImplRaw.runTtl && typeof selfImplRaw.runTtl === 'object' && !Array.isArray(selfImplRaw.runTtl)
    ? selfImplRaw.runTtl as Record<string, unknown> : undefined;
  const runTtl = runTtlRaw ? {
    mode: runTtlRaw.mode === 'live' ? 'live' as const : 'shadow' as const,
    ...(typeof runTtlRaw.cap === 'number' && Number.isSafeInteger(runTtlRaw.cap) && runTtlRaw.cap >= 0 ? { cap: runTtlRaw.cap } : {}),
  } : undefined;
  const autohealRaw = selfImplRaw.autoheal && typeof selfImplRaw.autoheal === 'object' && !Array.isArray(selfImplRaw.autoheal)
    ? selfImplRaw.autoheal as Record<string, unknown> : undefined;
  // ⛔ 모르는 값은 좁은 쪽(shadow) — 오타가 live 를 켜면 안 된다.
  const autoheal = autohealRaw ? { mode: autohealRaw.mode === 'live' ? 'live' as const : 'shadow' as const } : undefined;
  // ⭐ 관측(리뷰 should-fix) — 오타/비-boolean 은 기본값(ON)으로 수렴하는데, 그게 조용하면
  //   "껐다고 믿었는데 자동 개설되는" 운영 사고가 된다. 값이 **있는데 boolean 이 아닐 때만**
  //   경고한다(부재는 정상). 로거 대신 stderr — 이 파일의 기존 경고와 동형(부트 시점·의존 0).
  if (autoOpenPrRaw !== undefined && typeof autoOpenPrRaw !== 'boolean') {
    try {
      process.stderr.write(
        `[user-config] tools.selfImplement.autoOpenPr 가 boolean 이 아닙니다(${JSON.stringify(autoOpenPrRaw)}) — 기본값 ${TOOLS_DEFAULTS.selfImplement.autoOpenPr} 로 진행합니다. 끄려면 false 를 명시하세요.\n`,
      );
    } catch { /* swallow — stderr 가 닫힌 경우 */ }
  }
  // ⛔ 알 수 없는 값은 **좁은 쪽**(terminal)으로 떨어뜨린다 — 오타가 팬아웃을 켜면 안 된다.
  const prApprovalDelivery: 'terminal' | 'all' =
    (selfImplRaw as { prApprovalDelivery?: unknown }).prApprovalDelivery === 'all' ? 'all' : 'terminal';
  const autoOpenPr = autoOpenPrRaw === false
    ? false
    : TOOLS_DEFAULTS.selfImplement.autoOpenPr;
  const draftOnStopParsed = parseDraftOnStopMode((selfImplRaw as { draftOnStop?: unknown }).draftOnStop);
  if (draftOnStopParsed.invalid) {
    try {
      process.stderr.write(`[user-config] tools.selfImplement.draftOnStop 값이 알 수 없습니다(${JSON.stringify((selfImplRaw as { draftOnStop?: unknown }).draftOnStop)}) — 'always' 로 진행합니다. 허용값: ${DRAFT_ON_STOP_MODES.join(' | ')}\n`);
    } catch { /* swallow */ }
  }
  const draftOnStop = draftOnStopParsed.mode;
  const salvageRetentionRaw = (selfImplRaw as { salvageRetention?: unknown }).salvageRetention;
  const salvageRetentionModeRaw = salvageRetentionRaw && typeof salvageRetentionRaw === 'object' ? (salvageRetentionRaw as { mode?: unknown }).mode : undefined;
  if (salvageRetentionModeRaw !== undefined && salvageRetentionModeRaw !== 'shadow' && salvageRetentionModeRaw !== 'live') {
    try { process.stderr.write(`[user-config] tools.selfImplement.salvageRetention.mode 값이 알 수 없습니다(${JSON.stringify(salvageRetentionModeRaw)}) — 'shadow' 로 진행합니다. 허용값: shadow | live\n`); } catch { /* swallow */ }
  }
  const salvageRetention = { mode: salvageRetentionModeRaw === 'live' ? 'live' as const : 'shadow' as const };
  return {
    deferred: { mode },
    agentSpawn: { hopCap },
    runDevHarness,
    selfOrchestrate,
    nativeStructure,
    selfImplement: { worktreeRoot, childInstanceMode, prApprovalDelivery, observeOnly, goalRecordInDoc, goalAuthorPersistentGrounding, fabricDecompose, fabricDecomposeAutoPathThreshold, autoOpenPr, draftOnStop, salvageRetention, autoStop, autoAssist, screenStallTermination, reworkBudget, decompositionShadow, clarificationEscalation, ...(childLlm ? { childLlm } : {}), ...(runTtlHours !== undefined ? { runTtlHours } : {}), ...(runTtl ? { runTtl } : {}), ...(autoheal ? { autoheal } : {}) },
  };
}

const CHILD_LLM_MODES = ['pinned', 'auto'] as const;

/** 잘못된 값은 경고와 함께 버린다 — 설정 한 줄이 발사를 막지 않는다. 없으면 undefined(해석기가 기본).
 *  비객체·비문자열 provider/model 도 경고 후 버리고 기본으로 진행한다. 발사를 막지 않는다. */
export function parseChildLlmPreference(raw: unknown): ChildLlmPreferenceConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('tools.selfImplement.childLlm', `객체가 아니다(${JSON.stringify(raw)}) — 버리고 기본으로 진행`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const out: ChildLlmPreferenceConfig = {};
  let droppedInvalidProvider = false;
  if (v.provider !== undefined) {
    if (typeof v.provider === 'string') out.provider = v.provider;
    else {
      droppedInvalidProvider = true;
      warnUserConfigDrop('tools.selfImplement.childLlm.provider', `문자열이 아니다(${JSON.stringify(v.provider)}) — 버림`);
    }
  }
  if (v.model !== undefined) {
    if (typeof v.model === 'string') out.model = v.model;
    else warnUserConfigDrop('tools.selfImplement.childLlm.model', `문자열이 아니다(${JSON.stringify(v.model)}) — 버림`);
  }
  if (v.mode !== undefined) {
    if ((CHILD_LLM_MODES as readonly string[]).includes(v.mode as string)) out.mode = v.mode as ChildLlmPreferenceMode;
    else warnUserConfigDrop('tools.selfImplement.childLlm.mode', `pinned|auto 가 아니다(${JSON.stringify(v.mode)}) — 기본으로 진행`);
  }
  if (v.chain !== undefined) {
    if (!Array.isArray(v.chain)) {
      warnUserConfigDrop('tools.selfImplement.childLlm.chain', `배열이 아니다(${JSON.stringify(v.chain)}) — 버림`);
    } else {
      const chain: ChildLlmChainEntry[] = [];
      for (const [index, item] of v.chain.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          warnUserConfigDrop('tools.selfImplement.childLlm.chain', `[${index}] 객체가 아니다(${JSON.stringify(item)}) — 건너뜀`);
          continue;
        }
        const entry = item as Record<string, unknown>;
        if (typeof entry.provider !== 'string' || !entry.provider.trim()) {
          warnUserConfigDrop('tools.selfImplement.childLlm.chain', `[${index}].provider 가 빈 문자열이 아니다(${JSON.stringify(entry.provider)}) — 건너뜀`);
          continue;
        }
        if (entry.model !== undefined && typeof entry.model !== 'string') {
          warnUserConfigDrop('tools.selfImplement.childLlm.chain', `[${index}].model 이 문자열이 아니다(${JSON.stringify(entry.model)}) — 건너뜀`);
          continue;
        }
        chain.push({
          provider: entry.provider,
          ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
        });
      }
      out.chain = chain;
    }
  }
  // mode 추론은 여기 하지 않는다. provider 가 없으면 auto — model 만 남은 설정도 같다.
  // 기존 model-only 거절 문면은 발사 경계가 따로 보존한다.
  // 잘못된 provider 를 버린 뒤에 model 만 남으면 그 거절이 발사를 막는다.
  // 그 한 줄은 경고로 끝내고 기본으로 진행한다.
  if (droppedInvalidProvider && out.model !== undefined && out.provider === undefined && out.mode === undefined && out.chain === undefined) {
    delete out.model;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const BUDGET_GATE_ON_SHORTFALL = ['decompose', 'wait-reset', 'next-provider', 'proceed'] as const;
export const DEFAULT_BUDGET_GATE: HarnessBudgetGateConfig = {
  minHeadroomPercent: 15,
  onShortfall: 'next-provider',
  maxUsedPercent: { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT },
};

function percentInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** 칸마다 0~100. 범위 밖·비수치는 경고 후 그 칸의 기본. 객체가 아니면 기본 전체. */
export function parseBudgetGateMaxUsedPercent(raw: unknown): BudgetGateMaxUsedPercent {
  const fallback = { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT };
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('harness.budgetGate.maxUsedPercent', `객체가 아니다(${JSON.stringify(raw)}) — 기본 ${JSON.stringify(fallback)} 로 진행`);
    return fallback;
  }
  const out: { [provider: string]: number } = { ...fallback };
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!provider.trim()) continue;
    if (percentInRange(value)) out[provider] = value;
    else {
      const kept = fallback[provider];
      warnUserConfigDrop(
        `harness.budgetGate.maxUsedPercent.${provider}`,
        `0~100 이 아니다(${JSON.stringify(value)}) — ${kept === undefined ? '버림' : `기본 ${kept} 로 진행`}`,
      );
    }
  }
  return out;
}

/** 범위 밖·모르는 값은 경고와 함께 기본. 섹션이 없어도 기본을 돌려준다. */
export function parseHarnessBudgetGate(raw: unknown): HarnessBudgetGateConfig {
  const fallback = {
    minHeadroomPercent: DEFAULT_BUDGET_GATE.minHeadroomPercent,
    onShortfall: DEFAULT_BUDGET_GATE.onShortfall,
    maxUsedPercent: { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT },
  };
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('harness.budgetGate', `객체가 아니다(${JSON.stringify(raw)}) — 기본 ${fallback.minHeadroomPercent}/${fallback.onShortfall} 로 진행`);
    return fallback;
  }
  const v = raw as Record<string, unknown>;
  let minHeadroomPercent = fallback.minHeadroomPercent;
  if (v.minHeadroomPercent !== undefined) {
    const n = v.minHeadroomPercent;
    if (percentInRange(n)) minHeadroomPercent = n;
    else warnUserConfigDrop('harness.budgetGate.minHeadroomPercent', `0~100 이 아니다(${JSON.stringify(n)}) — 기본 ${fallback.minHeadroomPercent} 로 진행`);
  }
  let onShortfall = fallback.onShortfall;
  if (v.onShortfall !== undefined) {
    if ((BUDGET_GATE_ON_SHORTFALL as readonly string[]).includes(v.onShortfall as string)) onShortfall = v.onShortfall as BudgetGateOnShortfall;
    else warnUserConfigDrop('harness.budgetGate.onShortfall', `허용값이 아니다(${JSON.stringify(v.onShortfall)}) — 기본 ${fallback.onShortfall} 로 진행`);
  }
  const maxUsedPercent = parseBudgetGateMaxUsedPercent(v.maxUsedPercent);
  return { minHeadroomPercent, onShortfall, maxUsedPercent };
}

function parseRegistryConfig(raw: unknown): RegistryConfig {
  const empty: RegistryConfig = { discovery: { cron: {}, firecrawl: {} } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const root = raw as Record<string, unknown>;
  const discovery = (root.discovery && typeof root.discovery === 'object' && !Array.isArray(root.discovery))
    ? root.discovery as Record<string, unknown>
    : {};
  const cron = (discovery.cron && typeof discovery.cron === 'object' && !Array.isArray(discovery.cron))
    ? discovery.cron as Record<string, unknown>
    : {};
  const firecrawl = (discovery.firecrawl && typeof discovery.firecrawl === 'object' && !Array.isArray(discovery.firecrawl))
    ? discovery.firecrawl as Record<string, unknown>
    : {};
  const intervalMs = typeof cron.intervalMs === 'number' && Number.isFinite(cron.intervalMs) && cron.intervalMs > 0
    ? cron.intervalMs
    : undefined;
  const apiKey = typeof firecrawl.apiKey === 'string' && firecrawl.apiKey.trim().length > 0
    ? firecrawl.apiKey.trim()
    : undefined;
  return {
    discovery: {
      cron: {
        ...(intervalMs !== undefined ? { intervalMs } : {}),
      },
      firecrawl: {
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
    },
  };
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

const LSP_DEFAULTS: LspConfig = {
  enabled: true,
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['py'],
  },
  rust: {
    command: 'rust-analyzer',
    // rust-analyzer defaults to stdio when no transport flag is given;
    // no args needed in the common case. Users can override.
    args: [],
    extensions: ['rs'],
  },
  idleTimeoutMs: 10 * 60 * 1000,
  workspaceSymbolLanguage: 'typescript',
};

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
  telegram: IntakeSurfaceConfig;
  discord: IntakeSurfaceConfig;
  approvals?: { repo?: string };
}

/** Hardcoded fallbacks used when neither user config nor env supplies
 *  a value. Resolvers in `voice/*` keep these in sync — exported here
 *  so docs / tests can reference one canonical source. */
export const VOICE_HARDCODED_DEFAULTS = {
  sttProvider: 'openai-realtime-stt' as VoiceSttProviderId,
  ttsProvider: 'openai-tts' as VoiceTtsProviderId,
  ttsAuto: false,
  vadMode: 'server' as VoiceVadMode,
  vadThreshold: 0.012,
  vadSilenceMs: 800,
  vadMinSpeechMs: 200,
  chatMultiTurn: false,
  ttsDrainCooldownMs: 300,
  discordVoiceChannelEnabled: false,
  discordVoiceChannelListenFilter: 'caller' as VoiceDiscordChannelListenFilter,
  discordVoiceChannelLeaveOnEmpty: true,
} as const;

function normalizeVoiceSttProvider(v: unknown): VoiceSttProviderId {
  if (v === 'gemini-live-stt' || v === 'whisper-cpp-local'
    || v === 'elevenlabs-scribe-realtime') return v;
  return 'openai-realtime-stt';
}
function normalizeVoiceTtsProvider(v: unknown): VoiceTtsProviderId {
  if (v === 'elevenlabs-tts' || v === 'edge-tts' || v === 'macos-say') return v;
  return 'openai-tts';
}
function normalizeVoiceVadMode(v: unknown): VoiceVadMode {
  if (v === 'local' || v === 'manual') return v;
  return 'server';
}
function normalizeVoiceTelegramDispatch(v: unknown): VoiceTelegramDispatchMode | undefined {
  if (v === 'auto-reply' || v === 'tui-bridge') return v;
  return undefined;
}
function normalizeVoiceDiscordChannelListenFilter(
  v: unknown,
): VoiceDiscordChannelListenFilter | undefined {
  if (v === 'caller' || v === 'all') return v;
  return undefined;
}
function normalizeIntakeAmbientCaptureMode(v: unknown): IntakeAmbientCaptureMode | undefined {
  if (v === 'off' || v === 'suggest' || v === 'capture') return v;
  return undefined;
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
  /** Layer an LLM qualitative narrative (관전 포인트) on top of the
   *  deterministic morning digest. Opt-out (default on when a provider
   *  is available); fail-soft — no provider or an LLM error just drops
   *  the narrative and sends the structured base unchanged (P1d). */
  morningNarrative?: boolean;
  /** A2 — 아침 브리핑에 finviz S&P 히트맵 이미지(firecrawl 스크린샷) 첨부.
   *  기본 true · firecrawl 키 있을 때만 동작(없으면 자동 skip·fail-soft). */
  morningHeatmapImage?: boolean;
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

const FINANCE_DEFAULTS: FinanceConfig = {
  enabled: false,
  morningNarrative: true,
  morningHeatmapImage: true,
  autoLoop: { enabled: false, maxPerScan: 2 },
  dig: { autoGoal: { enabled: false, maxPerDay: 2, maxTurns: 6, independentChecker: false } },
  kg: { extract: { enabled: false }, anomalyDig: { enabled: false } },
  replay: { autoGoal: { enabled: false, maxTurns: 3, tokenCap: 80_000, windowStartHour: 6, windowEndHour: 7 } },
  conatusNativePort: false,
  liveOrders: false,
  relaxedGates: false,
};

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

export type ModelRole = 'implement' | 'review' | 'research' | 'planning' | 'audit' | 'classify' | 'graph-grow';

export interface RoleModelConfig {
  implement?: string;
  review?: string;
  research?: string;
  planning?: string;
  audit?: string;
  classify?: string;
  'graph-grow'?: string;
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
}

/** 역할별 LLM 선택(sparse) — provider 를 «역할마다» 정할 수 있는 유일한 자리. */
export type RoleLlmConfig = Partial<Record<ModelRole, RoleLlmSpec>>;

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

// ⛔ 역할 기본값은 «모델 이름»이 아니라 «필요 성능(tier)»이다 (대표 2026-08-18).
//    이름으로 박아 두면 llm.provider 를 바꿔도 따라오지 않는다 — 티어면 활성 provider 의
//    사다리가 채운다. 무거운 저작(planning)만 best 이고 나머지는 그 아래로 충분하다.
/** ⭐ export 인 이유 — **문서가 이 값을 「재게」 하기 위해서다**(AGENTS.md §페이즈별 LLM ⑹ⓐ).
 *  ⛔ 진입 문서에 역할별 기본 티어·env 이름을 «적으면» 그 표가 늙는다. 그래서 적지 않고 여기서 읽는다. */
export const ROLE_MODEL_DEFAULTS: Record<ModelRole, { environment: string; tier: ModelTier }> = {
  implement: { environment: 'ELANOUS_SELF_IMPLEMENT_MODEL', tier: 'better' },
  // ⭐⭐ 2026-09-23 (대표 승인) — ***`loaded` → `best`.*** 「천장」이 상시 레인이 돼 있었다.
  //
  // 🩸 무엇이 어긋나 있었나 — ***바로 위 주석이 이 값을 반박한다***:
  //    *"무거운 저작(planning)만 best 이고 나머지는 그 아래로 충분하다"* (대표 2026-08-18)
  //    그런데 review 만 `loaded` 로 ***best 보다 한 칸 «위»***에 있었다.
  //
  // 📏 실측 2026-09-23 (codex 과금 인시던트 중에 드러났다):
  //    ⑴ `loaded` 를 «자동으로» 부르는 페이즈는 ***이것 하나***였다(여섯 중 하나 · 전수 확인).
  //    ⑵ 21시간 창에서 `gpt-6-astra` ***1,925건 = codex 요청의 19%***
  //       (⚠️ 조회가 상한 40,000행에 닿아 이 수는 «하한»이다).
  //    ⑶ astra 는 sol 대비 ***input·output 각 5배***($10/$50 ↔ $2/$10).
  //    ⑷ 🔑 그런데 ***5배를 내면서 추론은 «덜» 했다*** — review=astra·medium ↔ planning=sol·high.
  //       「더 깊게 보라」가 목적이었다면 그 목적을 배반하는 값이었다.
  //
  // ✅ 바꾼 뒤: review = `best` = (codex 기준) gpt-6-sol·***high*** — 공식 문서상 Reasoning 등급이
  //    astra 와 «같은 Highest» 이고 effort 는 오히려 «올라간다». 비용은 1/5.
  // ⛔ 사람이 «명시로» 고르는 길은 «안» 막는다 — `--tier max` · `/model astra` 는 그대로다
  //    (`llm-tier-map` 의 별칭 max/deep/maxi → loaded 는 손대지 않았다).
  // 🔲 ***안 쟀다*** — 「리뷰 품질이 떨어지나」. 떨어지면 되돌릴 자리는 이 한 줄이다.
  review: { environment: 'ELANOUS_PR_REVIEW_MODEL', tier: 'best' },
  research: { environment: 'ELANOUS_MEMORY_JUDGE_MODEL', tier: 'better' },
  planning: { environment: 'ELANOUS_SKILL_PLAN_MODEL', tier: 'best' },
  audit: { environment: 'ELANOUS_MEMORY_JUDGE_MODEL', tier: 'better' },
  classify: { environment: 'ELANOUS_ACTION_CLASSIFIER_MODEL', tier: 'budget' },
  'graph-grow': { environment: 'ELANOUS_GRAPH_GROW_MODEL', tier: 'better' },
};

/** Resolve `auto` through the same runtime provider selector that dispatches LLM calls.
 * The deferred require preserves the existing user-config ↔ llm module boundary.
 *
 * ⭐ export 인 이유(2026-08-18): `tools.nativeStructure.providers` 를 판정하려면 소비처가
 *   ***「지금 어느 provider 인가」***를 알아야 한다. `config.llm.provider` 를 그대로 읽으면
 *   `'auto'` 를 그 문자열대로 비교해 «영영 안 맞는다» — 그것이 이 함수가 푸는 문제다.
 *   ⛔ 소비처가 이 로직을 다시 쓰면 두 자리가 갈린다. 한 자리만 둔다. */
export function resolveActiveProvider(config: UserConfig): LLMProviderName {
  if (config.llm.provider !== 'auto') return config.llm.provider;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { decideProviderForConfig, getProvider } = require('./llm.js') as typeof import('./llm.js');
  // ⭐ 2026-09-24 — 런타임이 실제로 보내는 곳과 같은 결정을 쓴다(종전 `getProvider()` 는 auto 에서 codex 를 건너뛰었다).
  const decided = decideProviderForConfig(config).provider;
  if (typeof decided === 'string' && decided.startsWith('auto:')) return decided.slice('auto:'.length) as LLMProviderName;
  return getProvider().name as LLMProviderName;
}

/** 기존 사다리 ③~⑥ — 문면·순서·의미를 그대로 둔다(무회귀가 1차 제약).
 *  ⛔ provider 를 «인자로만» 받는다 — 여기서 전역을 다시 읽으면 「한 번 정하고 인자로 내린다」가 끊긴다. */
function resolveRoleLlmBaseline(role: ModelRole, config: UserConfig, provider: LLMProviderName): RoleLlmResolution {
  const configured = config.roleModels?.[role]?.trim();
  if (configured) return { model: configured, provider, source: 'config' };
  const tier = config.roleModelTiers?.[role];
  if (tier) return { model: lookupLlmTierSpec(provider, tier).model, provider, tier, source: 'tier' };
  const { environment, tier: defaultTier } = ROLE_MODEL_DEFAULTS[role];
  const fromEnvironment = process.env[environment]?.trim();
  if (fromEnvironment) return { model: fromEnvironment, provider, source: 'environment' };
  return { model: lookupLlmTierSpec(provider, defaultTier).model, provider, tier: defaultTier, source: 'default' };
}

/** provider «만» 갈렸을 때 — 모델 «이름»을 박는 층(roleModels·env)은 건너뛴다.
 *  ⛔ 이름은 provider 에 매인 값이라 다른 provider 로 그 이름을 부르면 「없는 모델」이 된다
 *  (110차 grok-4-1-fast 사건과 같은 축: 요청한 식별자와 응답이 갈린다). 티어는 provider 를 따라온다. */
function resolveRoleTierOnly(role: ModelRole, config: UserConfig, provider: LLMProviderName): RoleLlmResolution {
  const configuredTier = config.roleModelTiers?.[role];
  const tier = configuredTier ?? ROLE_MODEL_DEFAULTS[role].tier;
  return { model: lookupLlmTierSpec(provider, tier).model, provider, tier, source: configuredTier ? 'tier' : 'default' };
}

/** 해석 결과를 관측에 싣는다 — ⛔ 값 옆에 «출처»를 둔다.
 *  발사 인자(overrides)가 주어졌거나 config.roleLlm 이 그 역할을 갖고 있을 때만 찍는다:
 *  그 축이 «판에 있을 때»는 맞았든 틀렸든 남고, 아무도 안 쓰면 소음이 없다.
 *  ⚠️ deferred require — user-config ↔ debug 모듈 경계를 보존한다(resolveActiveProvider 와 동형). */
function observeRoleLlm(role: ModelRole, resolution: RoleLlmResolution, requested: RoleLlmSpec | undefined): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
    debug.log('harness.role-llm', 'resolve', {
      role,
      model: resolution.model,
      provider: resolution.provider,
      ...(resolution.tier ? { tier: resolution.tier } : {}),
      source: resolution.source,
      ...(requested ? { requestedProvider: requested.provider ?? null, requestedTier: requested.tier ?? null } : {}),
    });
  } catch { /* 관측 실패가 해석을 막지 않는다 — fail-open */ }
}

/** 발사 시점에 «한 번» 정해지는 override — 프로세스 진입점(CLI 액션)이 세우고 아래는 인자로 읽는다.
 *  ⛔ 이것은 「환경변수를 흉내낸 전역」이 아니다: ①진입점에서 «한 번만» 세울 수 있고
 *  ②다른 값으로 다시 세우면 «거부»하며 ③해석 결과에 source='flag' 로 «출처가 남는다».
 *  RFC-role-scoped-llm-selection-2026-08-18 §2a — 조용히 덮이는 전역이 이 축의 실패 모드다. */
let launchRoleLlmOverrides: RoleLlmConfig | undefined;

export interface SetLaunchRoleLlmOptions {
  /** 대화형 변경(슬래시)처럼 «의도된» 교체일 때만 참. 발사 경로는 주지 않는다. */
  allowReplace?: boolean;
  /** 누가 세웠는지 — 관측에 남는다. */
  origin?: string;
}

export function setLaunchRoleLlmOverrides(overrides: RoleLlmConfig, opts: SetLaunchRoleLlmOptions = {}): void {
  const previous = launchRoleLlmOverrides;
  const next = JSON.stringify(overrides);
  if (previous !== undefined && JSON.stringify(previous) !== next && !opts.allowReplace) {
    // ⛔ 발사 경로에서 «두 번 다르게» 정해지면 그것은 사고다 — 조용히 덮지 않고 멈춘다.
    //   ⭐ throw «전에» 관측을 남긴다 — 예외만 던지면 「무엇이 무엇으로 덮이려 했나」가 로그에 안 남는다.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
      debug.log('harness.role-llm', 'overrides-rejected', {
        origin: opts.origin ?? 'unknown', previous, attempted: overrides,
      });
    } catch { /* fail-open */ }
    throw new Error(
      `역할별 LLM 은 발사 시점에 한 번만 정한다 — 이미 ${JSON.stringify(previous)} 로 정해졌고 ${next} 로 다시 정하려 했다`,
    );
  }
  launchRoleLlmOverrides = overrides;
  if (previous !== undefined && JSON.stringify(previous) !== next) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
      debug.log('harness.role-llm', 'overrides-replaced', {
        origin: opts.origin ?? 'unknown', previous: previous ?? null, next: overrides,
      });
    } catch { /* fail-open */ }
  }
}

export function getLaunchRoleLlmOverrides(): RoleLlmConfig | undefined {
  return launchRoleLlmOverrides;
}

/** 테스트 전용 — 프로세스 수명 안에서 발사 override 를 지운다. */
export function clearLaunchRoleLlmOverrides(): void {
  launchRoleLlmOverrides = undefined;
}

export interface RoleLlmResolveOptions {
  config?: UserConfig;
  /** 발사 시점에 «한 번» 정해 아래로 내리는 인자 — 사다리 최상층(source='flag'). */
  overrides?: RoleLlmConfig;
}

/** ★ 역할별 LLM 해석 SSOT — RFC-role-scoped-llm-selection-2026-08-18 §4c.
 *  사다리: ① overrides(flag) → ② config.roleLlm → ③~⑥ 기존(resolveRoleLlmBaseline).
 *  ⛔ 아무 override 도 없으면 ③~⑥ 만 타므로 산출이 종전과 «같다»(§4f 불변식 · NL 진입 무변경). */
export function resolveRoleLlm(role: ModelRole, opts: RoleLlmResolveOptions = {}): RoleLlmResolution {
  const config = opts.config ?? getUserConfig();
  // 전역 provider 는 필요할 때만 푼다 — 역할이 provider 를 명시했으면 전역 provider 가 없어도 해석된다.
  let activeProvider: LLMProviderName | undefined;
  const globalProvider = (): LLMProviderName => (activeProvider ??= resolveActiveProvider(config));
  // 명시 인자가 있으면 그것이 진실 — 없을 때만 발사 시점에 정해진 값을 읽는다(둘 다 source='flag').
  const flagSpec = (opts.overrides ?? launchRoleLlmOverrides)?.[role];
  const layers: ReadonlyArray<readonly [RoleLlmSpec | undefined, RoleLlmSource]> = [
    [flagSpec, 'flag'],
    [config.roleLlm?.[role], 'config-role'],
  ];
  for (const [spec, source] of layers) {
    if (!spec) continue;
    const provider = spec.provider ?? globalProvider();
    const pinned = spec.model?.trim();
    let resolution: RoleLlmResolution | undefined;
    if (pinned) resolution = { model: pinned, provider, ...(spec.tier ? { tier: spec.tier } : {}), source };
    else if (spec.tier) resolution = { model: lookupLlmTierSpec(provider, spec.tier).model, provider, tier: spec.tier, source };
    else if (spec.provider) resolution = { ...resolveRoleTierOnly(role, config, provider), source };
    if (resolution) { observeRoleLlm(role, resolution, spec); return resolution; }
    // 세 칸이 «다 비었으면» 아래 층으로 흘린다 — 빈 칸은 선언이 아니다.
  }
  const baseline = resolveRoleLlmBaseline(role, config, globalProvider());
  if (opts.overrides || launchRoleLlmOverrides || config.roleLlm?.[role]) observeRoleLlm(role, baseline, flagSpec);
  return baseline;
}

/** Resolves a model role without forcing a sparse user setting when it is empty.
 *  ⭐ 이제 resolveRoleLlm 위의 «얇은 래퍼»다 — 그래야 기존 소비자 «전부»가 새 사다리를 자동으로 탄다
 *  (옆에 새 함수를 두면 「형태만 있고 실행 경로엔 없다」가 된다). */
export function resolveRoleModel(role: ModelRole, config: UserConfig = getUserConfig()): ModelResolution {
  const resolved = resolveRoleLlm(role, { config });
  const source: ModelResolutionSource =
    resolved.source === 'flag' || resolved.source === 'config-role' ? 'config' : resolved.source;
  return { model: resolved.model, source };
}


export type OrchestratorSeat = 'OP' | 'TC' | 'MK' | 'UX';
export interface OrchestratorLoopConfig {
  /** ORCH1 graph mode — shadow writes observations only; live appends delegations (default shadow). */
  mode: 'off' | 'shadow' | 'live';
  seatTrees: Partial<Record<OrchestratorSeat, string[]>>;
  seatCaps: Record<OrchestratorSeat, number>;
  /** Max new delegations per tick; absent means no limit. */
  maxDelegatePerTick?: number;
  /** Per-seat release gate; absent seats retain the spawn-budget default. */
  releaseGate?: Partial<Record<OrchestratorSeat, number>>;
  trafficMode: 'shadow' | 'live';
  idleRequest?: 'off' | 'shadow' | 'live';
  /** FINISH-RATE — the queue tick reads finish metrics before launching; shadow logs the hold only, on holds (default shadow). */
  finishGate?: 'off' | 'shadow' | 'on';
  /** ORCH-TA-HAND — the delegate node hands its picked cell to TASK-AGENT (`handTask`). Absent = off · shadow = card only ·
   *  live = launch (only when the tick mode is live too; a live hand skips the seat journal so the cell launches once). */
  handToTaskAgent?: 'off' | 'shadow' | 'live';
  /** Demo: hand only this cell id (others keep the seat path). Absent = every delegatable cell. */
  handToTaskAgentCell?: string;
  /** COORD-HA — the tick CLI probes LLM ⊕ task board for the degradation ladder. Absent = shadow (probe and log only) ·
   *  live = the tick acts on it (L1 rules only · L2 no new assignment) · off = no probe. */
  degradationSignal?: 'off' | 'shadow' | 'live';
}

export const ORCHESTRATOR_DEFAULTS: OrchestratorLoopConfig = {
  mode: 'shadow', seatTrees: {}, seatCaps: { TC: 8, UX: 6, MK: 6, OP: 4 }, trafficMode: 'shadow', idleRequest: 'shadow', finishGate: 'shadow',
};

export function parseOrchestratorLoopConfig(raw: unknown): OrchestratorLoopConfig {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawTrees = value.seatTrees && typeof value.seatTrees === 'object' && !Array.isArray(value.seatTrees)
    ? value.seatTrees as Record<string, unknown> : {};
  const rawCaps = value.seatCaps && typeof value.seatCaps === 'object' && !Array.isArray(value.seatCaps)
    ? value.seatCaps as Record<string, unknown> : {};
  const rawGate = value.releaseGate && typeof value.releaseGate === 'object' && !Array.isArray(value.releaseGate)
    ? value.releaseGate as Record<string, unknown> : {};
  const seatTrees: OrchestratorLoopConfig['seatTrees'] = {};
  const seatCaps = { ...ORCHESTRATOR_DEFAULTS.seatCaps };
  const releaseGate: NonNullable<OrchestratorLoopConfig['releaseGate']> = {};
  for (const seat of ['OP', 'TC', 'MK', 'UX'] as const) {
    if (Array.isArray(rawTrees[seat])) seatTrees[seat] = rawTrees[seat].filter((path): path is string => typeof path === 'string' && isAbsolute(path));
    const cap = rawCaps[seat];
    if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 0) seatCaps[seat] = cap;
    const gate = rawGate[seat];
    if (typeof gate === 'number' && Number.isSafeInteger(gate) && gate >= 0) releaseGate[seat] = gate;
  }
  const mode = value.mode === 'off' || value.mode === 'live' ? value.mode : 'shadow';
  const maxDelegatePerTick = value.maxDelegatePerTick;
  return { mode, seatTrees, seatCaps,
    ...(typeof maxDelegatePerTick === 'number' && Number.isSafeInteger(maxDelegatePerTick) && maxDelegatePerTick >= 0 ? { maxDelegatePerTick } : {}),
    ...(Object.keys(releaseGate).length ? { releaseGate } : {}),
    trafficMode: value.trafficMode === 'live' ? 'live' : 'shadow',
    idleRequest: value.idleRequest === 'off' || value.idleRequest === 'live' ? value.idleRequest : 'shadow',
    finishGate: value.finishGate === 'off' || value.finishGate === 'on' ? value.finishGate : 'shadow',
    ...(value.handToTaskAgent === 'shadow' || value.handToTaskAgent === 'live' ? { handToTaskAgent: value.handToTaskAgent } : {}),
    ...(typeof value.handToTaskAgentCell === 'string' && value.handToTaskAgentCell.trim() ? { handToTaskAgentCell: value.handToTaskAgentCell.trim() } : {}),
    ...(value.degradationSignal === 'off' || value.degradationSignal === 'shadow' || value.degradationSignal === 'live' ? { degradationSignal: value.degradationSignal } : {}) };
}

export type StewardLoopMode = 'off' | 'shadow' | 'live' | 'rescue';

export type SeatLoopMode = 'off' | 'shadow' | 'on' | 'live-safe';

export interface PersonaLoopConfig { enabled: boolean }

export interface SeatLoopConfig {
  /** Shadow observes by default; live-safe acts only through the shared rescue policy, while legacy on retains its behavior. */
  mode: SeatLoopMode;
  /** Validated loop-agent neighbor entries keyed by the observing seat. */
  neighbors?: Partial<Record<'OP' | 'TC' | 'MK' | 'UX', import('./loops/neighbors.js').Neighbor[]>>;
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
}

export type EventSeat = 'OP' | 'TC' | 'MK' | 'UX';
export interface EventRoute { source: 'linear' | 'asana' | 'github'; kind: string; seat: EventSeat; loop: 'seat' }
export interface EventsConfig { mode: 'shadow' | 'on'; routes: EventRoute[]; linearAssignees: Record<string, EventSeat> }

export function parseEventsConfig(input: unknown): EventsConfig {
  const events = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const routes: EventRoute[] = [];
  const linearAssignees: Record<string, EventSeat> = Object.create(null);
  if (events.linearAssignees && typeof events.linearAssignees === 'object' && !Array.isArray(events.linearAssignees)) {
    for (const [id, seat] of Object.entries(events.linearAssignees)) {
      if (id.trim() && (seat === 'OP' || seat === 'TC' || seat === 'MK' || seat === 'UX')) linearAssignees[id] = seat;
    }
  }
  if (Array.isArray(events.routes)) for (const value of events.routes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const route = value as Record<string, unknown>;
    if ((route.source === 'linear' || route.source === 'asana' || route.source === 'github') && typeof route.kind === 'string' && route.kind.trim()
      && (route.seat === 'OP' || route.seat === 'TC' || route.seat === 'MK' || route.seat === 'UX') && route.loop === 'seat')
      routes.push({ source: route.source, kind: route.kind, seat: route.seat, loop: route.loop });
  }
  return { mode: events.mode === 'on' ? 'on' : 'shadow', routes, linearAssignees };
}

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
  /** Concurrent heavy checks per remote host (default and ceiling 2 — config may only lower it). */
  hostCap?: number;
  /** Bare mirror on the host (default ~/mirror/elanous-agent.git — shared with the release gate). */
  mirror?: string;
  /** Seconds to wait for a free host slot before running locally (default 600). */
  slotWaitSeconds?: number;
}

export function parseGateRemoteConfig(raw: unknown): GateRemoteConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: GateRemoteConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  for (const key of ['host', 'mirror'] as const) if (typeof r[key] === 'string' && (r[key] as string).trim()) out[key] = (r[key] as string).trim();
  for (const key of ['loadThreshold', 'slotWaitSeconds'] as const) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  if (typeof r.hostCap === 'number' && Number.isSafeInteger(r.hostCap) && r.hostCap > 0 && r.hostCap <= 2) out.hostCap = r.hostCap;
  return Object.keys(out).length ? out : undefined;
}

export interface ProjectConfig {
  /** `axes` is absent when the configured axes are invalid; `error` then carries the config error text. */
  rubric?: { axes?: import('./release-loop/rubric.js').RubricAxis[]; error?: string };
}

/** Validate one project's `rubric.axes` — throws the config error text (key duplicate · non-numeric weight). */
export function parseProjectRubricAxes(id: string, axes: unknown): Array<{ key: string; weight: number }> {
  if (!Array.isArray(axes)) throw new Error(`[user-config] projects.${id}.rubric.axes 는 배열이어야 합니다`);
  const seen = new Set<string>();
  const parsed: Array<{ key: string; weight: number }> = [];
  for (const [index, axis] of axes.entries()) {
    const field = `projects.${id}.rubric.axes[${index}]`;
    if (!axis || typeof axis !== 'object' || Array.isArray(axis)) throw new Error(`[user-config] ${field} 는 {key,weight} 객체여야 합니다`);
    const { key, weight } = axis as Record<string, unknown>;
    if (typeof key !== 'string' || !key.trim()) throw new Error(`[user-config] ${field}.key 는 빈 문자열일 수 없습니다`);
    if (seen.has(key)) throw new Error(`[user-config] projects.${id}.rubric.axes 키 중복: ${key}`);
    if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new Error(`[user-config] ${field}.weight 는 유한한 숫자여야 합니다: ${String(weight)}`);
    seen.add(key);
    parsed.push({ key, weight });
  }
  return parsed;
}

/**
 * Project rubric axes (P3b CORE-GENERIC). Loading never throws — one bad project entry must not
 * stop every command — so an invalid entry keeps its error text and `resolveRubricAxes` raises it.
 */
function parseProjectsConfig(raw: unknown): Record<string, ProjectConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const projects: Record<string, ProjectConfig> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (id === '__proto__' || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rubric = (entry as Record<string, unknown>).rubric;
    if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) continue;
    const axes = (rubric as Record<string, unknown>).axes;
    if (axes === undefined) continue;
    try {
      projects[id] = { rubric: { axes: parseProjectRubricAxes(id, axes) } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`${error} — 이 프로젝트의 루브릭 축 해석은 오류로 멈춘다`);
      projects[id] = { rubric: { error } };
    }
  }
  return Object.keys(projects).length ? projects : undefined;
}

export interface UserConfig {
  projects?: Record<string, ProjectConfig>;
  /** Default personal topic watch; absent = enabled when user sources exist. */
  watch?: { enabled?: boolean };
  starter?: { topics?: string[] };
  /** GUARD-ONE-a: omitted means shadow. `live` is parsed for the later cutover, but `elanous guardian tick`
   *  refuses it until a human-confirmed operational change (GUARD-ONE-a ships shadow only). */
  guardian?: { mode?: 'shadow' | 'live' };
  /** TA-JUDGE-LIVE-SAFE: task-agent judge moves executed for real. Only `review` · `propose-green` are honoured
   *  (`src/task-agent/live-moves.ts` drops anything else with a warning). Absent = env ELANOUS_TASK_AGENT_LIVE_MOVES, else none (pure shadow). */
  taskAgent?: { liveMoves?: string[]; parentHost?: { host?: string; cwd?: string; elanous?: string; configDir?: string; podPool?: string } };
  events?: EventsConfig;
  /** GATE-REMOTE — see GateRemoteConfig. Absent = defaults (auto on · node-b · load 20 · cap 2). */
  gateRemote?: GateRemoteConfig;
  /** Explicit HTTPS destination for doctor diagnostics; absent means no upload. */
  diagnostics?: { uploadUrl?: string };
  /** HQ lease (본부 임대 · 10-04 HQ-HB/HQ-FENCE): arbiter host over ssh, this host's name, per-role fail-open when the arbiter is unreachable (default: fail closed). */
  hq?: HqConfig;
  /** Root CLI help audience; absent or invalid means owner. */
  cli?: { helpRole?: 'owner' | 'contributor' | 'general' };
  /** Daemon public demonstration mode; absent means off. */
  nexus?: { demoMode?: boolean };
  /** Execution-phase HITL answer deadline; absent means 30 minutes. */
  hitl?: { executionDeadlineMinutes?: number };
  /** Deferred (quiet-hours) outbound queue. `deferredMaxAttempts`: failed flushes before an item is quarantined; absent = env ELANOUS_OUTBOUND_DEFERRED_MAX_ATTEMPTS, else 5. */
  outbound?: { deferredMaxAttempts?: number };
  coo?: { linearProject?: string };
  decisions?: { linearProjection: { enabled: boolean }; requireCrossCheck: boolean;
    crossCheckNeighbor: Record<EventSeat, EventSeat>; crossCheckWaitMinutes: number };
  /** Per-seat goal and Pod limits; missing or invalid limits use seat-budget defaults. */
  org?: { budget?: Record<string, { dailyGoals?: number; concurrentPods?: number }> };
  /** Steward and seat loops are parsed independently. An absent seat defaults to shadow. */
  loops?: { owners?: Record<string, EventSeat>; defaultOwner?: EventSeat; orchestrator?: OrchestratorLoopConfig; steward?: { mode?: StewardLoopMode; linearTeam?: string; roles?: Record<string, { maxConcurrent?: number }>; budget?: number; tracks?: Record<string, string>; alertAfterFailures?: number; launch?: 'off' | 'shadow' | 'live'; maxParallel?: number; podPool?: string }; seat?: SeatLoopConfig; persona?: PersonaLoopConfig };
  /** 🔐 Pod 의 Grok API 키 과금은 명시 opt-in 만. 생략·잘못된 값은 false.
   *  budgetGate 와 같은 `harness` 객체다 — 중복 선언이면 뒤 타입이 앞을 지운다. */
  harness?: { edgeRail?: { canaryOkRuns?: number; failureMultiplier?: number; minSamples?: number }; /** Goal authoring grade; absent or invalid config resolves to full. */ authorGrade?: 'full' | 'lite'; revertGuard?: { depth: number }; pod?: { grokApiKeyOptIn: boolean }; budgetGate?: HarnessBudgetGateConfig; exposeGate?: 'warn' | 'strict'; difficultyPlacement?: boolean; defaultRepo?: string; /** Optional GitHub repository name (owner/repo), distinct from the local defaultRepo path. */ repo?: string; substrate?: 'local' | 'pod'; podPool?: string; worktreeAddTimeoutSec?: number; queue?: { seatCap?: Partial<Record<'OP' | 'TC' | 'MK' | 'UX', number>>; /** Direct `harness say|ask` goes through the seat queue first (ONEDOOR-2). Absent = env ELANOUS_HARNESS_QUEUE_DIRECT_SAY, else off. */ directSay?: boolean; /** SEAT-CAP-STALE: a run whose last ledger progress is older than this stops holding its seat. Absent = env ELANOUS_HARNESS_QUEUE_STALE_RUN_MINUTES, else 30. */ staleRunMinutes?: number; /** Seat-less runs count in one bucket with this cap instead of every seat. Absent = env ELANOUS_HARNESS_QUEUE_UNKNOWN_SEAT_CAP, else 2. */ unknownSeatCap?: number; /** QUEUE-BURST: most launches one scheduled tick may make (30 s apart, each within seat cap and Pod pool headroom). Absent or invalid = 5; 1 = one launch per tick. */ burstMax?: number }; /** `harness say` 문장을 Pod 안에서 저작부터 돌릴지. 생략·false = 끔(호스트가 저작). */ authorOnPod?: boolean; /** SIBLING-RESYNC-ON-MERGE: most open sibling PR file inventories fetched per merge. Absent or invalid = 40. */ siblingResync?: { maxFetch?: number }; /** Stopped-PR repair goals: shadow records only (default); live enqueues them. */ helper?: { repair?: 'shadow' | 'live'; /** Live launches allowed per UTC day. Absent or invalid means 3. */ repairPerDay?: number };
  /** Nested elanous launches. Only depth 0 may set `allow`. Absent or any other value refuses. A depth >= 1 `--nested-elanous allow` is ignored. */
  nestedElanous?: 'allow' | 'refuse';
  /** Maximum nested elanous depth; safe positive integer, default 2. */
  nestedElanousMaxDepth?: number;
  /** Minutes a Pod launch may wait in one stage (admission · pool slot) before a `launch-stalled` event; positive number, default 15. */
  launchStallMinutes?: number;
  /** Follow-up goal after a merged harness PR. Omitted and anything but `live` record only. */
  followUp?: 'shadow' | 'live';
};
  /** ☸️ Pod 실행 칸 — `pool` = 기존 기본 풀(`컨텍스트[@ssh호스트][:상한][#k3d-레지스트리:포트]` 쉼표 · 앞이 우선). harness 실행은 인자·ELANOUS_POD_POOL·harness.podPool 다음으로 읽는다. */
  pod?: { pool?: string; /** 호스트 Git 미러 디렉터리 — Pod Job 에 읽기 전용으로 마운트한다. */ hostMirror?: string; /** 원격 그라운딩 엔드포인트(호스트 nexus · tailnet 주소) — Pod 가 토큰으로 «질의→인용»만 묻는다(P13). */ groundingUrl?: string; /** 읽기 전용 Pod lease 권장에 쓰는 계정별 동시 수. */ lease?: { perAccount?: number }; /** 실측 권고를 Pod 발사 기본값으로 쓸지 (기본 off). */ memory?: { adviseDefaults?: boolean }; /** 명령 Job 자식 로그(child.log) 상한 바이트. 양의 정수만. 넘으면 끝부분 우선. */ childLogMaxBytes?: number };
  skillRouter: SkillRouterConfig;
  llm: LLMConfig;
  skills: SkillsConfig;
  obsidian: ObsidianConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  finance: FinanceConfig;
  onboarding: OnboardingConfig;
  debug: DebugConfig;
  logs: LogsConfig;
  shell: ShellConfig;
  chat: ChatConfig;
  /** ER1 — optional so older fixtures stay valid; absent = defaults. */
  errorReports?: ErrorReportsConfig;
  voice: VoiceConfig;
  intake: IntakeConfig;
  dashboard: DashboardConfig;
  vw: VwConfig;
  acp: AcpConfig;
  lsp: LspConfig;
  plan: PlanConfig;
  goals: GoalsConfig;
  registry: RegistryConfig;
  // ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 2 W2.9.
  //   User-level knob for the tier-flip / deferred-tools machinery.
  //   `tools.deferred.mode='off'` shuttles every catalog spec to the
  //   provider every turn (pre-Wave-2 behaviour) — used for A/B
  //   baseline measurement and ad-hoc diagnosis.
  tools: ToolsConfig;
  // M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1):
  //   Three optional sub-trees that drive the friction-free model
  //   selection UX. All three are sparse — undefined means "use the
  //   zero-config default" (Balanced tier, no budget cap, auto-suggest
  //   on). See `src/model-tier/types.ts` for the type definitions.
  modelTier?: ModelTierUserConfig;
  budget?: BudgetUserConfig;
  smartDefaults?: SmartDefaultsUserConfig;
  /** Sparse model aliases by execution role; missing or empty values fall through. */
  roleModels?: RoleModelConfig;
  /** Sparse provider-agnostic model tier preferences by execution role. */
  roleModelTiers?: RoleModelTierConfig;
  /** 역할별 provider(⊕ tier·model) — 전역 `llm.provider` 를 «역할 단위»로 덮는 유일한 config 자리. */
  roleLlm?: RoleLlmConfig;
  /** P1 멀티서피스 세션 shadow fan-out 게이트(sparse·기본 OFF). */
  sessionFabric?: SessionFabricConfig;
  /** Layer2 Taste substrate 수집 게이트(P4·기본 OFF·opt-in). */
  taste?: TasteConfig;
  /** 웹 검색 프로바이더 게이트(기본 OFF — `isTavilySearchEnabled()` 로만 읽는다). */
  webSearch?: WebSearchConfig;
  /** OpenDesign 시안 생성. 기본 없음 = 꺼짐. url 이 없으면 클라이언트가 호출하지 않는다. */
  design?: DesignConfig;
  /** G8 무인 리뷰루프 auto-review 라벨 자동부착 모드(sparse·기본 opt-in). §2b ROADMAP-elanous-is-all. */
  autoReview?: AutoReviewConfig;
  /** 표시·집계 시간대 (IANA 이름 · 예 `Asia/Seoul`). 2026-07-24 신설.
   *
   *  종전엔 시간대를 **선언할 자리 자체가 없어서** 각 파일이 `'Asia/Seoul'` 을 문자열로
   *  박거나(9곳) UTC 를 그대로 표시했다(~40곳). 그 결과 같은 제품의 두 서피스가 9시간
   *  어긋났고, LLM 컨텍스트 팩에 UTC 가 사실로 주입됐다.
   *
   *  생략(권장)하면 `src/time/format.ts` 의 `resolveTimeZone()` 이 `process.env.TZ` →
   *  OS 설정(`Intl`) → `UTC` 순으로 해석한다. launchd 데몬은 TZ 를 물려받지 못하므로
   *  OS 설정이 실질 기본이 된다. 명시는 여러 머신에서 표기를 고정하고 싶을 때만.
   *
   *  ⚠️ 저장·전송은 언제나 UTC ISO 다. 이 값은 **표시와 날짜키에만** 영향한다. */
  timezone?: string;
  // W7-후속 (2026-05-12 · iOS Phase 0.5 production wire):
  //   Outbound notification channel settings. Sparse — when `apns`
  //   isn't present or any required field is missing, the daemon
  //   wires the ios-push channel with transport=undefined (resolves
  //   to 'transport-not-configured' if a route attempts to send).
  //   See `src/notifications/outbound-boot.ts` for the boot wire.
  notifications?: NotificationsConfig;
  // B 트랙 Phase 2 (RFC-elanous-mcp-client-2026-05-12 · 2026-05-12):
  //   External MCP servers (xcrun mcpbridge · xcodebuildmcp · …)
  //   that the NEXUS boot wire spawns + registers as proxy
  //   ToolRuntimes. Sparse — undefined or empty servers[] = no-op.
  //   See `src/nexus/boot/register-mcp-clients.ts` for the boot wire.
  mcp?: McpConfig;
  // W9e-FU U5 (2026-05-12) — `background-reasoning.llm.*` drives the
  // Patcher daemon's LLM callable wire. When omitted, `buildPatcherSubstrate`
  // surfaces `patcher-llm-deps-missing` and stays dormant. The resolver
  // (`src/background-reasoning/patcher-llm-resolver.ts`) consumes the
  // resolved config and produces `entityExtractorCallable` +
  // `embeddingCallable` via fetch against the OpenAI-compatible endpoint.
  backgroundReasoning?: BackgroundReasoningConfig;
  /** §5-③ — autonomous idle-continuation. When `enabled` (default
   *  false) the NEXUS daemon starts a ContinuationScheduler that drives
   *  an active auto-mode goal on idle. Off by default: this ignites
   *  self-firing turns, so it stays opt-in. */
  dispatch?: { enabled?: boolean };
  /** next-fluent(태스크 완료 시 다음 액션 1-클릭 칩·2026-07-15). 라우트는 늘 켬.
   *  `personas` 켜면 로컬 LLM 이유 부여(기본 결정론·무비용). */
  nextFluent?: { personas?: boolean; models?: Record<string, string> };
  /** Ops Observability P3 — 셀프교정 자율 경계. health check 크론이 이상 감지 시
   *  자동 개입(재큐/재시작)까지 할지. 기본 disarmed(관측+알림만·HITL). 매매/재부팅은
   *  이 게이트가 armed 여도 항상 제외. 대표 결정 전까지 undefined=false. */
  ops?: { selfHeal?: { armed?: boolean }; cronRepoRoot?: string };
  /** 승인 뒤 조율 채널 페이즈 배달(기본 OFF) 및 트랙 에이전트(기본 OFF, 최대 동시 2개). */
  autopilot?: {
    trackCourier?: { enabled?: boolean; channelPr?: number; handoffMinutes?: number };
    trackAgent?: { enabled: boolean; maxConcurrent: number; shadow: boolean; shadowMaxDecisionsPerDay: number };
  };
  /** 하니스 예산 게이트 설정. 판정은 P15 — 여기선 칸만 싣는다. 파서는 항상 기본을 채운다.
   *  선택이다 — 기존 UserConfig 리터럴이 이 칸 없이 컴파일되게 한다. 해석기는 없으면 기본을 쓴다.
   *  타입 칸은 위 `harness.budgetGate` 한 곳이다(중복 선언 금지). */
  /** 그라운딩 출처 레지스트리. 잘못된 항목은 경고와 함께 건너뛴다. 없으면 빈 목록. */
  grounding?: GroundingConfig;
  raw: Record<string, unknown>;
  // Phase 2 (PLAN-config-unification-elanous-root-2026-05-10):
  //   NEXUS schema co-resident at root of `~/.elanous/config.json`.
  //   Read by `src/nexus/config/user-config.ts:readUserConfig` for daemon
  //   state · exposed here so `elanous config get/set global.nexus.*` and
  //   `tabs.<id>.*` resolve through the same dotted-path resolver as
  //   Path A keys (llm.provider · skillRouter.* · etc.). Type 'version'
  //   matches the on-disk key — there is no Path A collision.
  version?: number;
  global?: Record<string, unknown>;
  tabs?: Record<string, Record<string, unknown>>;
}

function parseRoleModelConfig(raw: unknown): RoleModelConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed = Object.fromEntries(
    (['implement', 'review', 'research', 'planning', 'audit', 'classify'] as const)
      .flatMap((role) => typeof values[role] === 'string' && values[role].trim()
        ? [[role, values[role].trim()]]
        : []),
  ) as RoleModelConfig;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseRoleModelTierConfig(raw: unknown): RoleModelTierConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed = Object.fromEntries(
    (['implement', 'review', 'research', 'planning', 'audit', 'classify'] as const)
      .flatMap((role) => isModelTier(values[role]) ? [[role, values[role]]] : []),
  ) as RoleModelTierConfig;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/** 역할별 LLM 파서 — ⛔ 「조용히 무시」를 만들지 않는 것이 이 함수의 계약이다.
 *  잘못된 provider/tier 는 «버리되» 무엇을 버렸는지 호출자가 알 수 있게 이유를 낸다
 *  (CLI 는 그 이유로 거부하고, config 로딩은 나머지를 살린다). */
export function parseRoleLlmEntry(raw: unknown): { ok: true; spec: RoleLlmSpec } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'object 가 아니다' };
  const v = raw as Record<string, unknown>;
  const spec: RoleLlmSpec = {};
  if (v.provider !== undefined) {
    if (typeof v.provider !== 'string' || !RUNTIME_LLM_PROVIDER_NAMES.includes(v.provider as LLMProviderName)) {
      return { ok: false, reason: `provider 가 알려진 값이 아니다: ${String(v.provider)} (허용: ${RUNTIME_LLM_PROVIDER_NAMES.join('|')})` };
    }
    spec.provider = v.provider as LLMProviderName;
  }
  if (v.tier !== undefined) {
    if (!isModelTier(v.tier)) return { ok: false, reason: `tier 가 알려진 값이 아니다: ${String(v.tier)}` };
    spec.tier = v.tier;
  }
  if (v.model !== undefined) {
    if (typeof v.model !== 'string' || !v.model.trim()) return { ok: false, reason: 'model 이 빈 문자열이다' };
    spec.model = v.model.trim();
  }
  if (Object.keys(spec).length === 0) return { ok: false, reason: 'provider·tier·model 중 하나는 있어야 한다' };
  return { ok: true, spec };
}

export const MODEL_ROLES: readonly ModelRole[] = ['implement', 'review', 'research', 'planning', 'audit', 'classify', 'graph-grow'];

export function isModelRole(v: unknown): v is ModelRole {
  return typeof v === 'string' && (MODEL_ROLES as readonly string[]).includes(v);
}

const AUTO_REVIEW_MODES = ['off', 'opt-in', 'auto'] as const;

function positiveFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** One stderr line for a dropped config value — same path as other sections
 *  (nativeStructure providers, llm model-provider mismatch). Never throws. */
function warnUserConfigDrop(section: string, detail: string): void {
  try {
    process.stderr.write(`[user-config] ${section} ${detail}\n`);
  } catch { /* swallow — stderr 가 닫힌 경우 */ }
}

/** Copy `autoReview` into AutoReviewConfig. Absent section stays undefined
 *  (reader default 'opt-in' is not applied here). Invalid mode is dropped,
 *  not coerced. Depth numbers are positive finite only. */
function parseAutoReviewConfig(raw: unknown): AutoReviewConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('autoReview', `섹션이 객체가 아니다(${JSON.stringify(raw)}) — 버림`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const out: AutoReviewConfig = {};
  if (v.mode !== undefined) {
    if ((AUTO_REVIEW_MODES as readonly string[]).includes(v.mode as string)) {
      out.mode = v.mode as AutoReviewConfig['mode'];
    } else {
      warnUserConfigDrop('autoReview.mode', `허용값이 아니다(${JSON.stringify(v.mode)}) — 버림(기본으로 접지 않음)`);
    }
  }
  if (v.depth !== undefined) {
    if (!v.depth || typeof v.depth !== 'object' || Array.isArray(v.depth)) {
      warnUserConfigDrop('autoReview.depth', `객체가 아니다(${JSON.stringify(v.depth)}) — 버림`);
    } else {
      const d = v.depth as Record<string, unknown>;
      const depth: NonNullable<AutoReviewConfig['depth']> = {};
      if (d.maxLightFiles !== undefined) {
        const n = positiveFiniteNumber(d.maxLightFiles);
        if (n === undefined) warnUserConfigDrop('autoReview.depth.maxLightFiles', `양의 유한수가 아니다(${JSON.stringify(d.maxLightFiles)}) — 버림`);
        else depth.maxLightFiles = n;
      }
      if (d.maxLightLines !== undefined) {
        const n = positiveFiniteNumber(d.maxLightLines);
        if (n === undefined) warnUserConfigDrop('autoReview.depth.maxLightLines', `양의 유한수가 아니다(${JSON.stringify(d.maxLightLines)}) — 버림`);
        else depth.maxLightLines = n;
      }
      if (d.corePaths !== undefined) {
        if (!Array.isArray(d.corePaths) || d.corePaths.some((x) => typeof x !== 'string')) {
          warnUserConfigDrop('autoReview.depth.corePaths', `문자열 배열이 아니다(${JSON.stringify(d.corePaths)}) — 버림`);
        } else {
          depth.corePaths = d.corePaths;
        }
      }
      if (d.planDocPatterns !== undefined) {
        if (!Array.isArray(d.planDocPatterns) || d.planDocPatterns.some((x) => typeof x !== 'string')) {
          warnUserConfigDrop('autoReview.depth.planDocPatterns', `문자열 배열이 아니다(${JSON.stringify(d.planDocPatterns)}) — 버림`);
        } else {
          depth.planDocPatterns = d.planDocPatterns;
        }
      }
      if (Object.keys(depth).length > 0) out.depth = depth;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keeps `taskAgent.liveMoves` as raw strings — the allow-list (and the unknown-entry warning) lives in the task agent. */
/** HARNESS-PARENT-ON-MSB1 — `taskAgent.parentHost` (기본 없음 = 끔). 문자열 칸만 받는다. */
function parseTaskAgentParentHost(raw: unknown): NonNullable<UserConfig['taskAgent']>['parentHost'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('taskAgent.parentHost', '객체가 아니다 — 버림(로컬 발사)');
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const key of ['host', 'cwd', 'elanous', 'configDir', 'podPool'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

function parseTaskAgentConfig(raw: unknown): UserConfig['taskAgent'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('taskAgent', '섹션이 객체가 아니다 — 버림');
    return undefined;
  }
  const parentHost = parseTaskAgentParentHost((raw as Record<string, unknown>).parentHost);
  const liveMoves = (raw as Record<string, unknown>).liveMoves;
  if (liveMoves === undefined) return parentHost ? { parentHost } : undefined;
  // 설정이 «있으면» 환경 변수로 내려가지 않는다 — 배열이 아니면 빈 목록(fail-closed), 문자열 밖 항목은 글자로 바꿔 넘겨
  // 실행부가 «모르는 항목»으로 경고하고 버리게 한다(유효한 항목은 산다).
  if (!Array.isArray(liveMoves)) {
    warnUserConfigDrop('taskAgent.liveMoves', '배열이 아니다 — 빈 목록(실행 0)');
    return { liveMoves: [], ...(parentHost ? { parentHost } : {}) };
  }
  return { liveMoves: liveMoves.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry)), ...(parentHost ? { parentHost } : {}) };
}

function parseGuardianConfig(raw: unknown): UserConfig['guardian'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('guardian', '섹션이 객체가 아니다 — 버림');
    return undefined;
  }
  const mode = (raw as Record<string, unknown>).mode;
  if (mode === 'shadow' || mode === 'live') return { mode };
  if (mode !== undefined) warnUserConfigDrop('guardian.mode', 'shadow 또는 live 가 아니다 — 버림');
  return undefined;
}

/** Parse optional ops fields independently; invalid settings cannot silently select a cron cwd. */
function parseOpsConfig(raw: unknown): UserConfig['ops'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('ops', `섹션이 객체가 아니다(${JSON.stringify(raw)}) — 버림`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const parsed: NonNullable<UserConfig['ops']> = {};
  if (v.selfHeal !== undefined) {
    if (!v.selfHeal || typeof v.selfHeal !== 'object' || Array.isArray(v.selfHeal)) {
      warnUserConfigDrop('ops.selfHeal', `객체가 아니다(${JSON.stringify(v.selfHeal)}) — 버림`);
    } else {
      const armed = (v.selfHeal as Record<string, unknown>).armed;
      if (armed !== undefined) {
        if (typeof armed === 'boolean') parsed.selfHeal = { armed };
        else warnUserConfigDrop('ops.selfHeal.armed', `불리언이 아니다(${JSON.stringify(armed)}) — 버림`);
      }
    }
  }
  if (v.cronRepoRoot !== undefined) {
    if (typeof v.cronRepoRoot === 'string' && v.cronRepoRoot.trim()) parsed.cronRepoRoot = v.cronRepoRoot.trim();
    else warnUserConfigDrop('ops.cronRepoRoot', `비어 있거나 문자열이 아니다(${JSON.stringify(v.cronRepoRoot)}) — 버림`);
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function parseAutopilotConfig(raw: unknown): UserConfig['autopilot'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed: NonNullable<UserConfig['autopilot']> = {};
  const courier = values.trackCourier;
  if (courier && typeof courier === 'object' && !Array.isArray(courier)) {
    const v = courier as Record<string, unknown>;
    parsed.trackCourier = {
      enabled: v.enabled === true,
      ...(typeof v.channelPr === 'number' && Number.isSafeInteger(v.channelPr) && v.channelPr > 0 ? { channelPr: v.channelPr } : {}),
      handoffMinutes: typeof v.handoffMinutes === 'number' && Number.isFinite(v.handoffMinutes) && v.handoffMinutes > 0 ? v.handoffMinutes : 60,
    };
  }
  const agent = values.trackAgent;
  if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
    const v = agent as Record<string, unknown>;
    parsed.trackAgent = {
      enabled: v.enabled === true,
      maxConcurrent: typeof v.maxConcurrent === 'number' && Number.isSafeInteger(v.maxConcurrent) && v.maxConcurrent > 0
        ? Math.min(v.maxConcurrent, 2) : 2,
      shadow: v.shadow === true,
      shadowMaxDecisionsPerDay: typeof v.shadowMaxDecisionsPerDay === 'number'
        && Number.isSafeInteger(v.shadowMaxDecisionsPerDay) && v.shadowMaxDecisionsPerDay >= 0
        ? v.shadowMaxDecisionsPerDay : 20,
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseRoleLlmConfig(raw: unknown): RoleLlmConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed: RoleLlmConfig = {};
  const dropped: Array<{ role: ModelRole; reason: string }> = [];
  for (const role of MODEL_ROLES) {
    if (values[role] === undefined) continue;
    const entry = parseRoleLlmEntry(values[role]);
    if (entry.ok) parsed[role] = entry.spec;
    else dropped.push({ role, reason: entry.reason });
  }
  // ⛔ config 로딩은 «나머지를 살리려고» 잘못된 칸을 버리는데, 그 사실이 어디에도 안 남으면
  //   사용자는 「왜 내 설정이 안 먹지」를 영영 못 푼다(CLI 는 이름을 대며 거부하는데 여기만 조용했다).
  //   ⇒ 버린 것을 «이름과 이유»로 남긴다. 로딩 자체는 계속한다.
  if (dropped.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
      debug.log('harness.role-llm', 'config-entry-dropped', { dropped, droppedCount: dropped.length });
    } catch { /* fail-open */ }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function defaultConfig(): UserConfig {
  return {
    cli: { helpRole: 'owner' },
    coo: { linearProject: '외부 행정·큰 일 (COO)' },
    decisions: { linearProjection: { enabled: false }, requireCrossCheck: false,
      crossCheckNeighbor: { OP: 'TC', TC: 'OP', MK: 'OP', UX: 'OP' }, crossCheckWaitMinutes: 120 },
    loops: { owners: {}, defaultOwner: 'OP', orchestrator: parseOrchestratorLoopConfig(undefined), steward: { mode: 'shadow' }, seat: { mode: 'shadow', questions: 'shadow', seats: ['MK'], podPool: 'pool-node-b@node-b:8' }, persona: { enabled: false } },
    skillRouter: { ...SR_DEFAULTS },
    llm: { ...LLM_DEFAULTS },
    skills: skillsDefaults(),
    obsidian: obsidianDefaults(),
    telegram: { ...TELEGRAM_DEFAULTS, allowedUsers: [] },
    discord: { ...DISCORD_DEFAULTS, allowedUsers: [] },
    finance: { ...FINANCE_DEFAULTS },
    onboarding: { ...ONBOARDING_DEFAULTS },
    debug: { ...DEBUG_DEFAULTS },
    logs: { retention: { ...LOGS_DEFAULTS.retention } },
    shell: { ...SHELL_DEFAULTS },
    chat: {
      factQuestion: { ...CHAT_DEFAULTS.factQuestion },
      fastPath: CHAT_DEFAULTS.fastPath,
      conciseness: { ...CHAT_CONCISENESS_DEFAULTS },
      toolOutput: { ...CHAT_DEFAULTS.toolOutput },
      autoCompact: { ...CHAT_DEFAULTS.autoCompact },
      compact: { ...CHAT_DEFAULTS.compact },
      autoCopyQaToClipboard: CHAT_DEFAULTS.autoCopyQaToClipboard,
      systemPrompt: { ...CHAT_DEFAULTS.systemPrompt },
      toolDeny: [],
      rendering: {
        streaming: { ...CHAT_DEFAULTS.rendering.streaming },
        wrap: { ...CHAT_DEFAULTS.rendering.wrap },
        tool: { ...CHAT_DEFAULTS.rendering.tool },
        diff: { ...CHAT_DEFAULTS.rendering.diff },
        hud: { ...CHAT_DEFAULTS.rendering.hud },
      },
    },
    voice: { stt: {}, tts: {}, vad: {}, chat: {}, discord: {}, telegram: {}, pwa: {} },
    intake: { eventMax: 10, telegram: {}, discord: {} },
    dashboard: {
      promptBank: { ...DASHBOARD_PROMPT_BANK_DEFAULTS },
      foldMode: 'task-unit',
      enableVirtualWindowSwitchKeys: false,
      enableSupplementalGlobalKeys: false,
    },
    vw: {
      windowNames: {},
      paneNames: {},
      entries: {
        acp: { ...VW_ENTRY_DEFAULTS.acp },
        sim: { ...VW_ENTRY_DEFAULTS.sim },
        iul: { ...VW_ENTRY_DEFAULTS.iul },
      },
      simResident: false,
      iulResident: false,
      iulForegroundOnStartup: false,
      order: [...VW_ORDER_DEFAULT],
    },
    acp: { hopCap: { ...ACP_DEFAULTS.hopCap }, toolApproval: { timeoutMs: acpApprovalTimeoutEnv() ?? ACP_DEFAULTS.toolApproval.timeoutMs }, scrubBillingEnv: ACP_DEFAULTS.scrubBillingEnv },
    lsp: cloneLspDefaults(),
    plan: { ...PLAN_DEFAULTS },
    goals: { ...GOALS_DEFAULTS },
    registry: {
      discovery: {
        cron: { ...REGISTRY_DEFAULTS.discovery.cron },
        firecrawl: { ...REGISTRY_DEFAULTS.discovery.firecrawl },
      },
    },
    tools: {
      deferred: { ...TOOLS_DEFAULTS.deferred },
      agentSpawn: { ...TOOLS_DEFAULTS.agentSpawn },
      runDevHarness: { ...TOOLS_DEFAULTS.runDevHarness },
    selfOrchestrate: { ...TOOLS_DEFAULTS.selfOrchestrate },
      nativeStructure: { ...TOOLS_DEFAULTS.nativeStructure },
      selfImplement: { ...TOOLS_DEFAULTS.selfImplement },
    },
    harness: { revertGuard: { depth: 50 }, nestedElanousMaxDepth: 2, budgetGate: { ...DEFAULT_BUDGET_GATE }, exposeGate: 'warn', difficultyPlacement: false, followUp: 'shadow' },
    grounding: { sources: [] },
    raw: {},
  };
}

let cache: UserConfig | null = null;
let cachedPath: string | null = null;
// Phase 4 (PLAN-config-unification-elanous-root-2026-05-10):
//   Cache invalidation across modules / processes that share the unified
//   `~/.elanous/config.json`. NEXUS daemon's `patchUserConfig` (Path B
//   writer) atomically renames the file behind us; without an mtime
//   check the in-memory cache here would keep serving stale state.
let cachedMtimeMs: number | null = null;

// Config overlay — a pure transform applied to EVERY resolved config
// (cache-hit returns the already-overlaid object; every rebuild re-applies
// it). null in production = zero behavior change. `nexus run --test`
// [ISO-2 · 2026-07-13 은퇴] 종전에는 test-state-dir-flag.ts 가
// `buildTestSafeDaemonConfig` 를 여기 걸어 격리 테스트 데몬의 아웃바운드를
// in-memory 로 가렸다. overlay 뷰가 디스크에 박제되는 오염 사건(#4029) 후
// config 완전 격리(물질화 사본 + `elanous config sync-test`)로 대체 — 이제
// 프로덕션 설치 지점은 없다. 메커니즘은 테스트 주입용으로만 남긴다.
let configOverlay: ((c: UserConfig) => UserConfig) | null = null;

/** Install (or clear with null) the global config overlay. Resets the cache
 *  so the next getUserConfig() rebuilds through the new overlay. */
export function setUserConfigOverlay(fn: ((c: UserConfig) => UserConfig) | null): void {
  configOverlay = fn;
  resetUserConfig();
}

function applyOverlay(cfg: UserConfig): UserConfig {
  return configOverlay ? configOverlay(cfg) : cfg;
}

/** test-safe 변환 정책의 원전(pure). [ISO-2] 이제 overlay 로 걸리지 않고
 *  `elanous config sync-test`(config-test-sync.ts 의 raw 동형 변환)가 물질화
 *  시점에 같은 정책을 적용한다 — 파리티 테스트가 두 구현의 의미론 일치를
 *  고정. Telegram: test token 스왑(없으면 off) + 운영 아웃바운드 경로
 *  (report/home/channels) 제거. Discord: off. */
export function buildTestSafeDaemonConfig(cfg: UserConfig): UserConfig {
  const testToken = cfg.telegram.testChannel?.botToken?.trim();
  const testAllow = cfg.telegram.testChannel?.allowedUsers;
  const telegram: TelegramConfig = testToken
    ? {
        ...cfg.telegram,
        botToken: testToken,
        allowedUsers: testAllow && testAllow.length > 0 ? testAllow : cfg.telegram.allowedUsers,
        reportChannel: undefined,
        homeChannel: undefined,
        channels: undefined,
      }
    : {
        ...cfg.telegram,
        enabled: false,
        reportChannel: undefined,
        homeChannel: undefined,
        channels: undefined,
      };
  return { ...cfg, telegram, discord: { ...cfg.discord, enabled: false } };
}

function readMtimeMsOrNull(path: string): number | null {
  try { return statSync(path).mtimeMs; }
  catch { return null; }
}

// Phase 1 (PLAN-config-unification-elanous-root-2026-05-10):
//   XDG_CONFIG_HOME explicit  → legacy XDG path (test isolation + Phase 6 deprecation)
//   else                      → NEXUS canonical helper (~/.elanous/config.json · honors ELANOUS_DAEMON_DIR)
//
// Phase 3 (same PLAN): on first call from a non-XDG environment, migrate
// any legacy ~/.config/elanous/config.json into ~/.elanous/config.json (top-
// level merge · idempotent · legacy → .bak). Subsequent calls short-
// circuit via the once-per-process flag inside the migrate helper.
//
// Phase 6 (same PLAN): emit a one-time stderr warning when the user is
// still relying on XDG_CONFIG_HOME so Linux-fleet / CI users discover
// the new canonical path before a future release drops the back-compat.
let xdgDeprecationWarned = false;
export function __resetXdgDeprecationWarningForTests(): void {
  xdgDeprecationWarned = false;
}
function isInsideBunTest(): boolean {
  return process.argv.some((a) => a.endsWith('.test.ts') || a.endsWith('.test.js'));
}

function emitXdgDeprecationWarningOnce(xdgPath: string): void {
  if (xdgDeprecationWarned) return;
  xdgDeprecationWarned = true;
  if (process.env.ELANOUS_SUPPRESS_XDG_WARNING === '1') return;
  // Test runtimes are silent by default to keep suite output clean. The
  // dedicated assertion test passes ELANOUS_TEST_FORCE_XDG_WARNING=1 to
  // bypass this gate.
  if (isInsideBunTest() && process.env.ELANOUS_TEST_FORCE_XDG_WARNING !== '1') return;
  process.stderr.write(
    `[elanous config] XDG_CONFIG_HOME is set; reading ${xdgPath} (legacy).\n`
    + `  Canonical path is now ~/.elanous/config.json (since 2026-05-10).\n`
    + `  Unset XDG_CONFIG_HOME to migrate · ELANOUS_SUPPRESS_XDG_WARNING=1 to silence.\n`,
  );
}

export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    const xdgPath = join(xdg, 'elanous', 'config.json');
    emitXdgDeprecationWarningOnce(xdgPath);
    return xdgPath;
  }
  migrateLegacyXdgUserConfig();
  return nexusUserConfigPath();
}

function defaultPath(): string { return userConfigPath(); }

/** Sibling path to the primary config: `~/.elanous/llm-fallback.json`.
 *  User-curated · daemon writes NEVER touch this file (read-only contract).
 *  When the primary config's `llm` section is missing or effectively empty
 *  (provider absent / 'auto' / 'none'), `buildUserConfig` merges from this
 *  fallback so the setup gate (`checkLlm`) stays satisfied even when
 *  `~/.elanous/config.json` gets sparse-wiped by a misbehaving writer.
 *
 *  Suggested permissions: `chmod 0444` to prevent accidental in-place edits. */
export function llmFallbackPath(): string {
  return userConfigPath().replace(/config\.json$/, 'llm-fallback.json');
}

/** Read the read-only LLM fallback file. Returns the parsed `llm` blob
 *  or null when the file is missing / unreadable / not an object.
 *
 *  The fallback file's top level IS the `llm` shape (provider · baseUrl ·
 *  apiKey · model · rotation · …). It is NOT a full UserConfig — only the
 *  `llm` section.  Mirrors `jq '.llm' ~/.elanous/config.json > llm-fallback.json`. */
export function readLlmFallback(): Record<string, unknown> | null {
  const path = llmFallbackPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch { /* swallow */ }
  return null;
}

/** Heuristic: is the primary config's `llm` section effectively empty?
 *  True when `provider` is missing / 'auto' / 'none' — these all fail the
 *  setup gate, so fallback merge is appropriate. */
function isLlmSectionEmpty(llm: Record<string, unknown>): boolean {
  const provider = typeof llm.provider === 'string' ? llm.provider : '';
  return !provider || provider === 'auto' || provider === 'none';
}

let didLogFallbackOnce = false;

/** Log one stderr line the first time fallback is consumed during the
 *  process lifetime. Helps the user notice "primary config got wiped /
 *  daemon is using fallback now" without spamming repeated emits. */
function logFallbackUsedOnce(): void {
  if (didLogFallbackOnce) return;
  didLogFallbackOnce = true;
  try {
    process.stderr.write(
      '[user-config] primary llm section missing/empty — loaded from llm-fallback.json (read-only substrate).\n',
    );
  } catch { /* swallow — stderr 가 닫힌 경우 */ }
}

/** Resolve the process-scoped provider override before credential parsing.
 * `ELANOUS_LLM_PROVIDER` intentionally wins over config so one invocation and
 * inherited child processes can select a provider without mutating user config. */
function runtimeLlmProviderOverride(): LLMProviderName | undefined {
  const requested = process.env.ELANOUS_LLM_PROVIDER?.trim();
  if (!requested) return undefined;
  if (!(RUNTIME_LLM_PROVIDER_NAMES as readonly string[]).includes(requested)) {
    throw new Error(`Invalid ELANOUS_LLM_PROVIDER "${requested}". Allowed providers: ${RUNTIME_LLM_PROVIDER_NAMES.join(', ')}`);
  }
  return requested as LLMProviderName;
}

/** Lightweight model-id family — prefix/substring only. No catalog, no
 *  `src/llm/model-defaults.ts` (that module imports this file). */
export type RuntimeLlmModelFamily =
  | 'grok' | 'anthropic' | 'openai' | 'openai-codex' | 'gemini' | 'local'
  | 'kimi' | 'qwen' | 'glm' | 'openrouter' | 'unknown';

export function inferRuntimeLlmModelFamily(model: string | undefined): RuntimeLlmModelFamily {
  if (!model) return 'unknown';
  const m = model.trim().toLowerCase();
  if (!m) return 'unknown';
  // ⛔ 2026-09-23 — 게이트웨이 접두가 «먼저»다. 안 그러면 `openrouter/anthropic/claude-…` 가 `anthropic` 으로
  //   읽혀 openrouter 와 «비호환»이 되고, `openrouter/z-ai/…` 는 `unknown` 이라 아무 provider 와도 «호환»이 됐다.
  if (m.startsWith('openrouter/')) return 'openrouter';
  if (m.includes('grok')) return 'grok';
  if (m.includes('claude')) return 'anthropic';
  if (m.startsWith('gemini-') || m.includes('gemini')) return 'gemini';
  if (m.startsWith('local:')) return 'local';
  if (m.startsWith('kimi')) return 'kimi';
  if (m.startsWith('qwen')) return 'qwen';
  if (m.startsWith('glm')) return 'glm';
  // openai-codex 구독 모델만 여기 — gpt-5.5 등 Chat Completions 모델은 openai.
  // ⛔ openai 와 openai-codex 를 한 계열로 접지 마라. 서로 다른 엔드포인트다.
  // ✅ 2026-09-23 (대표 ⒜ 결정) — ***`gpt-6` 를 여기 «더했다».***
  //   종전엔 `gpt-6-*` 가 아래 `startsWith('gpt-')` 로 떨어져 `openai` 가 됐고, 그래서
  //   ***사다리가 «자기 가드가 거부하는 모델»을 가리켰다*** (`CODEX.loaded = gpt-6-astra`).
  //   📏 구독 경로 실호출로 확인(codex-cli 0.155.1): gpt-6-sol · luna · astra 전부 응답.
  //   ⚠️ 이 셋은 API 로도 불린다(`/v1/models` 에 있다). 「계열」이 재는 것은 «가용성»이 아니라
  //      ***「우리가 어느 문으로 보내나」***다 — 5.6 계열도 API 에 있지만 여기로 온다.
  if (m.includes('codex') || m.startsWith('gpt-5.6') || m.startsWith('gpt-6')) return 'openai-codex';
  // Exact o1/o3/o4 ids are standard OpenAI models; prefix-only (`o1-`) misses them.
  if (
    m.startsWith('gpt-')
    || m === 'o1' || m.startsWith('o1-')
    || m === 'o3' || m.startsWith('o3-')
    || m === 'o4' || m.startsWith('o4-')
  ) return 'openai';
  return 'unknown';
}

/** Cycle-safe compatibility: same-provider model overrides pass;
 *  cross-family ids fail. Unknown prefixes and `auto` stay silent.
 *  ⛔ `openai` 와 `openai-codex` 는 별개 provider — 양방향 호환으로 접지 않는다. */
export function isRuntimeLlmModelCompatibleWithProvider(
  provider: LLMProviderName,
  model: string | undefined,
): boolean {
  if (!model) return true;
  if (provider === 'auto') return true;
  const family = inferRuntimeLlmModelFamily(model);
  if (family === 'unknown') return true;
  if (provider === 'local') return family === 'local';
  return provider === family;
}

function observeRuntimeLlmModelProviderMismatch(provider: LLMProviderName, model: string): void {
  debug.log('user-config.llm', 'model-provider-mismatch', { provider, model });
  try {
    process.stderr.write(
      `[user-config] llm model-provider mismatch: provider=${provider} model=${model}\n`,
    );
  } catch { /* swallow — stderr 가 닫힌 경우 */ }
}

function defaultModelForProvider(provider: LLMProviderName): string | undefined {
  switch (provider) {
    case 'grok': return GROK_MODEL;
    case 'openai': return OPENAI_MODEL;
    // ⛔ 2026-09-25 — 구독(codex) 경로를 API 상수(`OPENAI_MODEL`=gpt-4o-mini)로 접지 않는다.
    //   실측: Pod 에 `ELANOUS_LLM_PROVIDER=openai-codex` 만 주자 `Codex API 400: The 'gpt-4o-mini' model is
    //   not supported when using Codex with a ChatGPT account.` 로 첫 호출에서 죽었다. ⇒ CODEX 사다리에서 파생.
    case 'openai-codex': return lookupLlmTierSpec('openai-codex', 'balanced').model;
    case 'anthropic': return ANTHROPIC_MODEL;
    case 'local': return LOCAL_LLM_MODEL;
    case 'gemini': return GEMINI_MODEL;
    case 'kimi': return KIMI_MODEL;
    case 'qwen': return QWEN_MODEL;
    case 'glm': return GLM_MODEL;
    case 'auto': return undefined;
  }
}

function resolveRuntimeLlmModel(
  baseProvider: LLMProviderName,
  selectedProvider: LLMProviderName,
  configuredModel: string | undefined,
  escalationProvider: string | undefined,
): string | undefined {
  if (escalationProvider) return process.env.ELANOUS_ESCALATE_MODEL?.trim() || configuredModel;
  const explicitModel = process.env.ELANOUS_LLM_MODEL?.trim();
  if (explicitModel) {
    // Model env still wins. A foreign family is named before the request,
    // not rewritten — same-provider overrides stay silent.
    if (!isRuntimeLlmModelCompatibleWithProvider(selectedProvider, explicitModel)) {
      observeRuntimeLlmModelProviderMismatch(selectedProvider, explicitModel);
    }
    return explicitModel;
  }
  return selectedProvider !== baseProvider
    ? defaultModelForProvider(selectedProvider) ?? configuredModel
    : configuredModel;
}

/** ⛔⭐⭐ 「없음·깨짐·비-객체」 세 경우는 **종전대로 `defaultConfig()` 를 그대로 돌려준다**.
 *  ⚠️ 초판은 그 셋을 「빈 raw(`{}`)로 파싱」 경로로 바꿨는데, `defaultConfig()` 와 `{}` 파싱은
 *  **같은 값이 아니다** — 실측: `skills.activeSet` 이 `claudecode` → `opencode` 로 회귀했고
 *  그 회귀가 «기존 테스트 기대값을 고치는» 것으로 덮였다(무인 리뷰 must-fix · 2026-08-14).
 *  ⇒ per-run 오버라이드는 그 셋에도 «얹기»만 한다. 계약을 바꾸지 않는다. */
function defaultConfigWithRuntimeProvider(): UserConfig {
  const cfg = defaultConfig();
  // ⚠️ 무효값 거부는 이 경로에서도 살아 있어야 한다 — config 가 없을 때 오타가 조용히 무시되면
  //   사람이 grok 으로 돌고 있다고 «믿으면서» 기본 provider 로 돈다.
  const override = runtimeLlmProviderOverride();
  // ⛔⭐ 두 env 의 우선순위는 **모든 경로에서 같아야 한다**(무인 리뷰 must-fix 2R).
  //   파싱 경로가 `escalate → runtime → config` 인데 이 경로만 `runtime` 우선이면,
  //   같은 환경에서 config 파일이 «있느냐 없느냐»로 provider 가 갈린다.
  const escalationProvider = process.env.ELANOUS_ESCALATE_PROVIDER?.trim();
  if (!override && !escalationProvider) {
    cfg.llm = {
      ...cfg.llm,
      model: resolveRuntimeLlmModel(cfg.llm.provider ?? 'auto', cfg.llm.provider ?? 'auto', str(cfg.llm.model), undefined),
    };
    return cfg;
  }
  const selected = escalationProvider ? normalizeProvider(escalationProvider) : override!;
  // ⭐ provider 를 바꾸는 자리는 **키도 함께** 해석한다 — 그러지 않으면 새 기기에서
  //   `ELANOUS_LLM_PROVIDER=grok` 이 provider 만 바꾸고 자격이 없어 401 로 죽는다(파싱 경로와 같은 규율).
  const baseProvider = cfg.llm.provider ?? 'auto';
  const cred = resolveProviderCredential({ provider: selected, rotation: cfg.llm.rotation, baseApiKey: cfg.llm.apiKey, baseProvider });
  observeCredentialResolution(selected, cred, 'escalate');
  cfg.llm = {
    ...cfg.llm,
    provider: selected,
    ...(cred.apiKey ? { apiKey: cred.apiKey } : {}),
    ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
    model: resolveRuntimeLlmModel(baseProvider, selected, str(cfg.llm.model), escalationProvider || undefined),
  };
  debug.log('user-config.llm', 'provider-resolved', {
    provider: selected,
    source: escalationProvider ? 'escalate-env' : 'env',
  });
  return cfg;
}

/** 설정에서 «졸업»하거나 죽어서 더는 읽지 않는 키. 설정 파일에 남아 있으면 로더는 값을 쓰지 않고
 *  관측 한 줄(프로세스당 한 번)과 `elanous doctor` 한 줄로 알린다 — 조용히 무시하지 않는다(설정 졸업 원칙 2). */
export interface RetiredConfigKey {
  /** 점 경로(예: `tools.selfImplement.decompositionShadow`). */
  readonly path: string;
  /** 사람이 읽는 사유·대체 한 문장. */
  readonly reason: string;
}

export const RETIRED_CONFIG_KEYS: readonly RetiredConfigKey[] = [
  { path: 'tools.selfImplement.decompositionShadow', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-24 설정 졸업)' },
  { path: 'tools.selfImplement.autoStop.enabled', reason: '기본 켬으로 졸업 — 지워도 된다 · 조율은 minRung (2026-09-24)' },
  { path: 'tools.selfImplement.autoAssist.enabled', reason: '기본 켬으로 졸업 — 지워도 된다 · 조율은 minRung (2026-09-24)' },
  { path: 'tools.selfImplement.screenStallTermination.enabled', reason: '기본 켬으로 졸업 — 지워도 된다 · 조율은 minRung (2026-09-24)' },
  // 설정 졸업 단계 2(2026-09-26): 로더가 싣기만 하고 읽는 곳이 없던 넷 — 저장소 전수 rg(시험 제외) 결과 user-config.ts 밖 소비자 0.
  { path: 'chat.rendering.hud.variantBadge', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2)' },
  { path: 'chat.rendering.hud.tokenGauge', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2)' },
  { path: 'chat.rendering.tool.inlineOneLine', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2)' },
  { path: 'vw.acpResident', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · vw.acp.resident 도 소비자 없음)' },
  { path: 'discord.sprint21', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · 런타임 sprint21-runtime 은 호출처 0·휴면)' },
  { path: 'tools.selfImplement.prEvidenceArtifactEnforce', reason: '차단 스위치 졸업 — PR 근거 관문은 막지 않고 관측만 한다(2026-09-26 설정 졸업 · 한 번도 기본으로 안 켜졌다)' },
  { path: 'voice.discord.dispatch', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · 값을 쓰던 디스코드 음성 어댑터는 호출처 0)' },
  { path: 'voice.discord.replyMode', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · 값을 쓰던 디스코드 음성 어댑터는 호출처 0)' },
  { path: 'voice.pwa.dispatch', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · voice-pwa-dispatch 는 호출처 0)' },
  { path: 'voice.stt.mode', reason: '타입에 없는 키 — 읽는 곳이 없다 (2026-09-26 설정 졸업 2)' },
  { path: 'voice.stt.language', reason: '타입에 없는 키 — 읽는 곳이 없다 (2026-09-26 설정 졸업 2)' },
  // 설정 졸업 1-d(2026-09-26): 3층(트리 파생)은 늘 켠다 — 리더 미지정이면 운영으로 떨어지므로 새 설치의 동작은 같다.
  { path: 'instance.treeDerivedTest', reason: '늘 켬으로 졸업 — 지워도 된다 (2026-09-26 설정 졸업 1-d)' },
  { path: 'tools.selfImplement.selfResolveClarifications', reason: '늘 켬으로 졸업 — 지워도 된다 (2026-09-26 설정 졸업 1-c · self author 도 harness 와 같이 되묻기를 자동 답변)' },
  { path: 'chat.rendering.compactBoundary.enabled', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.wrap.preserveOsc8', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.adaptiveBg', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.syntaxPerHunk', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.cache', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.turnSummary', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.turnBrowser', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'sessionFabric.telegram.reactions', reason: '늘 켬 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'sessionFabric.discord.reactions', reason: '늘 켬 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'nextFluent.enabled', reason: '늘 켬 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'tools.selfImplement.graphAuthoritative', reason: '2026-09-26 설정 졸업 — 그래프 권위는 항상 켬 · 지워도 된다' },
];

/** 설정 원문(JSON 객체)에서 폐기 키가 «있는» 항목만 돌려준다. 순수. */
export function findRetiredConfigKeys(raw: unknown, keys: readonly RetiredConfigKey[] = RETIRED_CONFIG_KEYS): RetiredConfigKey[] {
  return keys.filter(({ path }) => {
    let node: unknown = raw;
    for (const segment of path.split('.')) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return false;
      node = (node as Record<string, unknown>)[segment];
    }
    return true;
  });
}

/** 설정 «파일»의 폐기 키. 파일이 없거나 JSON 이 아니면 빈 목록(doctor 는 그 경우 다른 줄로 이미 말한다). */
export function findRetiredConfigKeysInFile(path: string = defaultPath(), read: (p: string) => string = (p) => readFileSync(p, 'utf-8')): RetiredConfigKey[] {
  try {
    return findRetiredConfigKeys(JSON.parse(read(path)));
  } catch {
    return [];
  }
}

let retiredConfigKeysObserved = false;
export function __resetRetiredConfigKeysObservationForTests(): void {
  retiredConfigKeysObserved = false;
}

function observeRetiredConfigKeysOnce(raw: Record<string, unknown>): void {
  if (retiredConfigKeysObserved) return;
  const retired = findRetiredConfigKeys(raw);
  if (!retired.length) return;
  retiredConfigKeysObserved = true;
  try {
    debug.log('user-config.retired', 'retired-key-present', { paths: retired.map(({ path }) => path) });
  } catch { /* observation must never break config loading */ }
}

/** Owner tracks the steward may assign (key → what that track owns). The one place the role table lives. */
function parseStewardTracks(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = Object.fromEntries(Object.entries(input as Record<string, unknown>)
    .filter((e): e is [string, string] => /^[A-Za-z][\w-]{0,15}$/.test(e[0]) && typeof e[1] === 'string' && e[1].trim().length > 0)
    .map(([k, v]) => [k, v.trim()]));
  return Object.keys(out).length ? out : undefined;
}

function parseDecisionsConfig(input: unknown): NonNullable<UserConfig['decisions']> {
  const defaults: Record<EventSeat, EventSeat> = { OP: 'TC', TC: 'OP', MK: 'OP', UX: 'OP' };
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const neighbors = { ...defaults };
  if (raw.crossCheckNeighbor !== undefined) {
    if (!raw.crossCheckNeighbor || typeof raw.crossCheckNeighbor !== 'object' || Array.isArray(raw.crossCheckNeighbor)) {
      warnUserConfigDrop('decisions.crossCheckNeighbor', '자리별 이웃 자리 객체가 아닙니다 — 기본값으로 진행합니다.');
    } else {
      const values = raw.crossCheckNeighbor as Record<string, unknown>;
      for (const seat of Object.keys(defaults) as EventSeat[]) {
        if (values[seat] === undefined) continue;
        const to = values[seat];
        if ((to === 'OP' || to === 'TC' || to === 'MK' || to === 'UX') && to !== seat) neighbors[seat] = to;
        else warnUserConfigDrop(`decisions.crossCheckNeighbor.${seat}`, '다른 자리가 아닙니다 — 기본값으로 진행합니다.');
      }
      for (const seat of Object.keys(values)) {
        if (!(seat in defaults)) warnUserConfigDrop(`decisions.crossCheckNeighbor.${seat}`, '알 수 없는 자리입니다 — 기본값으로 진행합니다.');
      }
    }
  }
  const wait = raw.crossCheckWaitMinutes;
  if (wait !== undefined && !(typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0)) {
    warnUserConfigDrop('decisions.crossCheckWaitMinutes', '양의 정수가 아닙니다 — 기본값 120으로 진행합니다.');
  }
  return { linearProjection: { enabled: (raw.linearProjection as { enabled?: unknown } | undefined)?.enabled === true },
    requireCrossCheck: raw.requireCrossCheck === true, crossCheckNeighbor: neighbors,
    crossCheckWaitMinutes: typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0 ? wait : 120 };
}

function parseLoopOwners(input: unknown): { owners: Record<string, EventSeat>; defaultOwner: EventSeat } {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const valid = (value: unknown): value is EventSeat => value === 'OP' || value === 'TC' || value === 'MK' || value === 'UX';
  const defaultOwner = valid(raw.defaultOwner) ? raw.defaultOwner : 'OP';
  if (raw.defaultOwner !== undefined && !valid(raw.defaultOwner)) warnUserConfigDrop('loops.defaultOwner', '잘못된 자리 — 기본 OP 로 진행');
  // Prototype-less: a loop titled «__proto__» (or «constructor») must keep its owner (review round 3).
  const owners: Record<string, EventSeat> = Object.create(null) as Record<string, EventSeat>;
  if (raw.owners !== undefined) {
    if (!raw.owners || typeof raw.owners !== 'object' || Array.isArray(raw.owners)) {
      warnUserConfigDrop('loops.owners', '객체가 아니다 — 기본 자리로 진행');
    } else {
      for (const [key, value] of Object.entries(raw.owners)) {
        if (key.trim() && valid(value)) owners[key] = value;
        else warnUserConfigDrop(`loops.owners.${key}`, `잘못된 자리 — 기본 ${defaultOwner} 로 진행`);
      }
    }
  }
  return { owners, defaultOwner };
}

function parseSeatLoopsConfig(input: unknown): SeatLoopConfig {
  const defaults: SeatLoopConfig = { mode: 'shadow', questions: 'shadow', seats: ['MK'], podPool: 'pool-node-b@node-b:8' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;
  const seat = (input as Record<string, unknown>).seat;
  if (!seat || typeof seat !== 'object' || Array.isArray(seat)) return defaults;
  const values = seat as Record<string, unknown>;
  const mode = values.mode;
  return {
    mode: mode === 'on' || mode === 'shadow' || mode === 'live-safe' || mode === 'off' ? mode : 'shadow',
    questions: values.questions === 'on' ? 'on' : 'shadow',
    seats: Array.isArray(values.seats) && values.seats.length > 0
      && values.seats.every((value) => typeof value === 'string' && /^(?:MK|OP|TC|UX)$/.test(value))
      ? [...new Set(values.seats as string[])] : ['MK'],
    podPool: typeof values.podPool === 'string' && values.podPool.trim() ? values.podPool.trim() : defaults.podPool,
    ...(() => {
      const raw = values.neighbors;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const neighbors: NonNullable<SeatLoopConfig['neighbors']> = {};
      for (const [owner, entries] of Object.entries(raw)) {
        if (!/^(?:OP|TC|MK|UX)$/.test(owner) || !Array.isArray(entries)) continue;
        const valid = entries.filter((entry): entry is import('./loops/neighbors.js').Neighbor => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
          const value = entry as Record<string, unknown>;
          const heartbeat = value.heartbeat && typeof value.heartbeat === 'object' && !Array.isArray(value.heartbeat)
            ? value.heartbeat as Record<string, unknown> : undefined;
          const onAbsent = value.onAbsent && typeof value.onAbsent === 'object' && !Array.isArray(value.onAbsent)
            ? value.onAbsent as Record<string, unknown> : undefined;
          return typeof value.id === 'string' && /^(?:op|tc|mk|ux)-seat$/.test(value.id)
            && value.id !== `${owner.toLowerCase()}-seat`
            && Array.isArray(value.exchange) && value.exchange.length > 0
            && value.exchange.every((item) => typeof item === 'string' && ['status', 'request', 'decision', 'blocked'].includes(item))
            && !!heartbeat && Number.isSafeInteger(heartbeat.everyMinutes) && (heartbeat.everyMinutes as number) > 0
            && Number.isSafeInteger(heartbeat.missedTicks) && (heartbeat.missedTicks as number) > 0
            && !!onAbsent && typeof onAbsent.action === 'string' && ['delegate', 'defer', 'escalate'].includes(onAbsent.action)
            && typeof onAbsent.delegateTo === 'string' && onAbsent.delegateTo.trim().length > 0;
        });
        neighbors[owner as keyof typeof neighbors] = valid;
      }
      return { neighbors };
    })(),
    ...(typeof values.reportPr === 'number' && Number.isSafeInteger(values.reportPr) && values.reportPr > 0
      ? { reportPr: values.reportPr } : {}),
    ...(() => {
      const stall = values.stall;
      if (!stall || typeof stall !== 'object' || Array.isArray(stall)) return {};
      const raw = stall as Record<string, unknown>;
      const parents = raw.parents && typeof raw.parents === 'object' && !Array.isArray(raw.parents)
        ? Object.fromEntries(Object.entries(raw.parents).filter(([from, to]) =>
          /^(?:MK|OP|TC|UX)$/.test(from) && typeof to === 'string' && /^(?:MK|OP|TC|UX)$/.test(to) && from !== to))
        : undefined;
      const minutes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      return { stall: {
        ...(parents ? { parents } : {}),
        ...(minutes(raw.redMinutes) ? { redMinutes: raw.redMinutes } : {}),
        ...(minutes(raw.blockedMinutes) ? { blockedMinutes: raw.blockedMinutes } : {}),
      } };
    })(),
    ...(typeof values.repeatStop === 'number' && Number.isSafeInteger(values.repeatStop) && values.repeatStop > 0
      ? { repeatStop: values.repeatStop } : {}),
    ...(() => {
      const raw = values.opDecide;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const mode = (raw as Record<string, unknown>).mode;
      return mode === 'shadow' || mode === 'live' ? { opDecide: { mode } } : {};
    })(),
  };
}

function parseStewardLoopsConfig(input: unknown): UserConfig['loops'] {
  const loops = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const value = loops.steward;
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const roles: NonNullable<NonNullable<UserConfig['loops']>['steward']>['roles'] = {};
  if (s.roles && typeof s.roles === 'object' && !Array.isArray(s.roles)) {
    for (const [role, entry] of Object.entries(s.roles)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const max = (entry as Record<string, unknown>).maxConcurrent;
      if (typeof max === 'number' && Number.isInteger(max) && max >= 0) roles[role] = { maxConcurrent: max };
    }
  }
  return { steward: {
    mode: s.mode === 'off' || s.mode === 'shadow' || s.mode === 'live' || s.mode === 'rescue' ? s.mode :
      s.launch === 'off' || s.launch === 'shadow' || s.launch === 'live' ? s.launch : 'shadow',
    // A valid legacy launch setting remains effective when mode is absent; explicit mode always wins.
    ...(s.launch === 'off' || s.launch === 'shadow' || s.launch === 'live' ? { launch: s.launch } : {}),
    ...(typeof s.maxParallel === 'number' && Number.isSafeInteger(s.maxParallel) && s.maxParallel > 0 ? { maxParallel: s.maxParallel } : {}),
    ...(typeof s.podPool === 'string' && s.podPool.trim() ? { podPool: s.podPool.trim() } : {}),
    ...(typeof s.linearTeam === 'string' && s.linearTeam.trim() ? { linearTeam: s.linearTeam.trim() } : {}),
    ...(Object.keys(roles).length ? { roles } : {}),
    ...(typeof s.budget === 'number' && Number.isFinite(s.budget) && s.budget >= 0 ? { budget: s.budget } : {}),
    ...(typeof s.alertAfterFailures === 'number' && Number.isSafeInteger(s.alertAfterFailures) && s.alertAfterFailures > 0 ? { alertAfterFailures: s.alertAfterFailures } : {}),
    ...(parseStewardTracks(s.tracks) ? { tracks: parseStewardTracks(s.tracks)! } : {}),
  } };
}

export function parseCliHelpRole(raw: unknown): NonNullable<UserConfig['cli']>['helpRole'] {
  const cli = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return cli.helpRole === 'general' || cli.helpRole === 'contributor' ? cli.helpRole : 'owner';
}

const HQ_FENCE_ROLES: readonly HqFenceRole[] = ['telegram-poller', 'cron', 'seat-loop', 'release-run', 'conatus', 'git-push'];
/** `hq` block (HQ-HB · HQ-FENCE): keep only well-typed fields — absent/invalid fields fall back to the hq module defaults. */
export function parseHqConfig(raw: unknown): HqConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const out: HqConfig = {};
  for (const key of ['arbiter', 'hostName', 'standby', 'tailnetDomain', 'tailscaleBin', 'seenGenerationFile'] as const) {
    const v = str(r[key]); if (v) out[key] = v;
  }
  if (typeof r.ttlSeconds === 'number' && Number.isFinite(r.ttlSeconds) && r.ttlSeconds > 0) out.ttlSeconds = r.ttlSeconds;
  if (typeof r.probeTimeoutSeconds === 'number' && Number.isFinite(r.probeTimeoutSeconds) && r.probeTimeoutSeconds > 0) out.probeTimeoutSeconds = r.probeTimeoutSeconds;
  if (r.boardFencing === 'shadow' || r.boardFencing === 'enforce') out.boardFencing = r.boardFencing;
  if (r.autoPromote && typeof r.autoPromote === 'object' && !Array.isArray(r.autoPromote)) {
    const auto = r.autoPromote as Record<string, unknown>;
    const setting: NonNullable<HqConfig['autoPromote']> = {};
    if (typeof auto.enabled === 'boolean') setting.enabled = auto.enabled;
    if (typeof auto.streak === 'number' && Number.isSafeInteger(auto.streak) && auto.streak > 0) setting.streak = auto.streak;
    if (Object.keys(setting).length) out.autoPromote = setting;
  }
  if (Array.isArray(r.failOpenRoles)) out.failOpenRoles = r.failOpenRoles.filter((v): v is HqFenceRole => HQ_FENCE_ROLES.includes(v as HqFenceRole));
  if (r.healthUrls && typeof r.healthUrls === 'object' && !Array.isArray(r.healthUrls)) {
    out.healthUrls = Object.fromEntries(Object.entries(r.healthUrls as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return Object.keys(out).length ? out : undefined;
}

export function buildUserConfig(path: string = defaultPath()): UserConfig {
  if (!existsSync(path)) return defaultConfigWithRuntimeProvider();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return defaultConfigWithRuntimeProvider();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultConfigWithRuntimeProvider();
  const rawObj = raw as Record<string, unknown>;
  observeRetiredConfigKeysOnce(rawObj);
  const harness = rawObj.harness && typeof rawObj.harness === 'object' && !Array.isArray(rawObj.harness) ? rawObj.harness as Record<string, unknown> : {};
  const harnessPod = harness.pod && typeof harness.pod === 'object' && !Array.isArray(harness.pod) ? harness.pod as Record<string, unknown> : {};
  const legacyPod = rawObj.pod && typeof rawObj.pod === 'object' && !Array.isArray(rawObj.pod) ? rawObj.pod as Record<string, unknown> : {};

  const sr = (rawObj.skillRouter ?? {}) as Record<string, unknown>;
  let llm = (rawObj.llm ?? {}) as Record<string, unknown>;
  // LLM fallback substrate (2026-05-13) — when primary's `llm` section is
  // sparse / wiped, merge from `~/.elanous/llm-fallback.json`. The fallback
  // file is user-curated + read-only (0444), so even if a misbehaving
  // writer flattens config.json the daemon can still boot.
  if (isLlmSectionEmpty(llm)) {
    const fallback = readLlmFallback();
    if (fallback !== null && !isLlmSectionEmpty(fallback)) {
      // Primary is "empty" by isLlmSectionEmpty heuristic (provider
      // missing / 'auto' / 'none'). Fallback wins so its non-sentinel
      // provider replaces primary's sentinel. Non-llm fields (rare ·
      // primary might have stray non-provider keys) are preserved on
      // the LHS spread.
      llm = { ...llm, ...fallback };
      logFallbackUsedOnce();
    }
  }
  const runtimeProvider = runtimeLlmProviderOverride();
  const escalationProvider = process.env.ELANOUS_ESCALATE_PROVIDER?.trim();
  const baseProvider = normalizeProvider(llm.provider);
  // Per-run provider selection wins over saved config, but an explicit escalation
  // provider remains the narrower existing override for its child process.
  const selectedProvider = escalationProvider
    ? normalizeProvider(escalationProvider)
    : runtimeProvider ?? baseProvider;
  debug.log('user-config.llm', 'provider-resolved', {
    provider: selectedProvider,
    source: escalationProvider ? 'escalate-env' : runtimeProvider ? 'env' : 'config',
  });
  const sk = (rawObj.skills ?? {}) as Record<string, unknown>;
  const ob = (rawObj.obsidian ?? {}) as Record<string, unknown>;
  const tg = (rawObj.telegram ?? {}) as Record<string, unknown>;
  const dc = (rawObj.discord ?? {}) as Record<string, unknown>;
  const fin = (rawObj.finance ?? {}) as Record<string, unknown>;
  const ob2 = (rawObj.onboarding ?? {}) as Record<string, unknown>;
  const dbg = (rawObj.debug ?? {}) as Record<string, unknown>;
  const logsRaw = (rawObj.logs ?? {}) as Record<string, unknown>;
  const sh = (rawObj.shell ?? {}) as Record<string, unknown>;
  const chat = (rawObj.chat ?? {}) as Record<string, unknown>;
  const chatFactQuestion = (chat.factQuestion && typeof chat.factQuestion === 'object' && !Array.isArray(chat.factQuestion))
    ? chat.factQuestion as Record<string, unknown> : {};
  const chatConciseness = (chat.conciseness ?? {}) as Record<string, unknown>;
  const chatToolOutput = (chat.toolOutput ?? {}) as Record<string, unknown>;
  const chatAutoCompact = (chat.autoCompact ?? {}) as Record<string, unknown>;
  const chatCompact = (chat.compact ?? {}) as Record<string, unknown>;
  const chatSystemPrompt = (chat.systemPrompt ?? {}) as Record<string, unknown>;
  const chatRendering = (chat.rendering ?? {}) as Record<string, unknown>;
  const chatRenderingStreaming = (chatRendering.streaming ?? {}) as Record<string, unknown>;
  const chatRenderingWrap = (chatRendering.wrap ?? {}) as Record<string, unknown>;
  const chatRenderingDiff = (chatRendering.diff ?? {}) as Record<string, unknown>;
  const chatRenderingHud = (chatRendering.hud ?? {}) as Record<string, unknown>;
  const voice = (rawObj.voice ?? {}) as Record<string, unknown>;
  const voiceStt = (voice.stt ?? {}) as Record<string, unknown>;
  const voiceTts = (voice.tts ?? {}) as Record<string, unknown>;
  const voiceVad = (voice.vad ?? {}) as Record<string, unknown>;
  const voiceChat = (voice.chat ?? {}) as Record<string, unknown>;
  const voiceDiscord = (voice.discord ?? {}) as Record<string, unknown>;
  const voiceDiscordChannel = (voiceDiscord.voiceChannel ?? {}) as Record<string, unknown>;
  const voiceTelegram = (voice.telegram ?? {}) as Record<string, unknown>;
  const voicePwa = (voice.pwa ?? {}) as Record<string, unknown>;
  const intake = (rawObj.intake ?? {}) as Record<string, unknown>;
  const intakeTelegram = (intake.telegram ?? {}) as Record<string, unknown>;
  const intakeDiscord = (intake.discord ?? {}) as Record<string, unknown>;
  const dash = (rawObj.dashboard ?? {}) as Record<string, unknown>;
  const retiredModeKeys = (['uiMode', 'defaultMode'] as const)
    .filter((key) => Object.prototype.hasOwnProperty.call(dash, key));
  if (retiredModeKeys.length > 0) {
    debug.log('dashboard.ui-mode', 'retired-config-ignored', { key: retiredModeKeys.join(',') });
  }
  const dashPromptBank = (dash.promptBank ?? {}) as Record<string, unknown>;
  const vw = (rawObj.vw ?? {}) as Record<string, unknown>;
  const acp = (rawObj.acp ?? {}) as Record<string, unknown>;
  const acpHopCap = (acp.hopCap ?? {}) as Record<string, unknown>;
  const acpToolApproval = (acp.toolApproval ?? {}) as Record<string, unknown>;
  const lspRaw = (rawObj.lsp ?? {}) as Record<string, unknown>;

  // RFC #2161 (PLAN-config-unification-elanous-root) — `elanous nexus config
  // set` writes user-level entries under `global.<...>`. The Phase 2
  // typed-root surface (below) exposes `global` but legacy parsers still
  // reach for top-level keys. For schemas that have already migrated to
  // the `global.` namespace via the CLI, prefer the namespaced read and
  // fall back to the legacy top-level slot.
  const rawGlobalObj =
    rawObj.global && typeof rawObj.global === 'object' && !Array.isArray(rawObj.global)
      ? (rawObj.global as Record<string, unknown>)
      : undefined;
  const rawNotifications = rawGlobalObj?.notifications ?? rawObj.notifications;
  const autopilotConfig = parseAutopilotConfig(rawObj.autopilot);
  const stewardLoops = parseStewardLoopsConfig(rawObj.loops);
  const orgRaw = rawObj.org && typeof rawObj.org === 'object' && !Array.isArray(rawObj.org) ? rawObj.org as Record<string, unknown> : {};
  const budgetRaw = orgRaw.budget && typeof orgRaw.budget === 'object' && !Array.isArray(orgRaw.budget) ? orgRaw.budget as Record<string, unknown> : {};
  const seatBudgets: NonNullable<NonNullable<UserConfig['org']>['budget']> = Object.create(null);
  for (const [seat, value] of Object.entries(budgetRaw)) {
    if (!seat || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const dailyGoals = row.dailyGoals;
    const concurrentPods = row.concurrentPods;
    seatBudgets[seat] = {
      ...(typeof dailyGoals === 'number' && Number.isSafeInteger(dailyGoals) && dailyGoals >= 0 ? { dailyGoals } : {}),
      ...(typeof concurrentPods === 'number' && Number.isSafeInteger(concurrentPods) && concurrentPods >= 0 ? { concurrentPods } : {}),
    };
  }

  const nexus = rawObj.nexus && typeof rawObj.nexus === 'object' && !Array.isArray(rawObj.nexus)
    ? rawObj.nexus as Record<string, unknown> : {};
  const gateRemoteConfig = parseGateRemoteConfig(rawObj.gateRemote);
  const projects = parseProjectsConfig(rawObj.projects);
  return {
    ...(projects ? { projects } : {}),
    ...(rawObj.starter && typeof rawObj.starter === 'object' && !Array.isArray(rawObj.starter)
      && Array.isArray((rawObj.starter as Record<string, unknown>).topics)
      ? { starter: { topics: ((rawObj.starter as { topics: unknown[] }).topics).filter((topic): topic is string => typeof topic === 'string' && !!topic.trim()) } } : {}),
    ...(rawObj.watch && typeof rawObj.watch === 'object' && !Array.isArray(rawObj.watch)
      && typeof (rawObj.watch as Record<string, unknown>).enabled === 'boolean'
      ? { watch: { enabled: (rawObj.watch as { enabled: boolean }).enabled } } : {}),
    nexus: { demoMode: nexus.demoMode === true },
    ...(Object.keys(seatBudgets).length ? { org: { budget: seatBudgets } } : {}),
    pod: {
      ...(typeof legacyPod.pool === 'string' && legacyPod.pool.trim() ? { pool: legacyPod.pool.trim() } : {}),
      ...(typeof legacyPod.hostMirror === 'string' && legacyPod.hostMirror.trim() ? { hostMirror: legacyPod.hostMirror.trim() } : {}),
      ...(typeof legacyPod.childLogMaxBytes === 'number' && Number.isSafeInteger(legacyPod.childLogMaxBytes) && legacyPod.childLogMaxBytes > 0 ? { childLogMaxBytes: legacyPod.childLogMaxBytes } : {}),
      ...(typeof legacyPod.groundingUrl === 'string' ? { groundingUrl: legacyPod.groundingUrl } : {}),
      memory: { adviseDefaults: Boolean(legacyPod.memory && typeof legacyPod.memory === 'object' && !Array.isArray(legacyPod.memory)
        && (legacyPod.memory as Record<string, unknown>).adviseDefaults === true) },
      lease: { perAccount: (() => {
        const lease = legacyPod.lease && typeof legacyPod.lease === 'object' && !Array.isArray(legacyPod.lease)
          ? (legacyPod.lease as Record<string, unknown>) : {};
        return typeof lease.perAccount === 'number' && Number.isSafeInteger(lease.perAccount) && lease.perAccount > 0
          ? lease.perAccount : 4;
      })() },
    },
    harness: {
      edgeRail: (() => {
        const value = harness.edgeRail && typeof harness.edgeRail === 'object' && !Array.isArray(harness.edgeRail)
          ? harness.edgeRail as Record<string, unknown> : {};
        return {
          canaryOkRuns: typeof value.canaryOkRuns === 'number' && Number.isSafeInteger(value.canaryOkRuns) && value.canaryOkRuns > 0 ? value.canaryOkRuns : 3,
          failureMultiplier: typeof value.failureMultiplier === 'number' && Number.isFinite(value.failureMultiplier) && value.failureMultiplier > 1 ? value.failureMultiplier : 2,
          minSamples: typeof value.minSamples === 'number' && Number.isSafeInteger(value.minSamples) && value.minSamples > 0 ? value.minSamples : 30,
        };
      })(),
      revertGuard: { depth: (() => {
        const value = harness.revertGuard && typeof harness.revertGuard === 'object' && !Array.isArray(harness.revertGuard)
          ? (harness.revertGuard as Record<string, unknown>).depth : undefined;
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 50;
      })() },
      pod: { grokApiKeyOptIn: harnessPod.grokApiKeyOptIn === true },
      difficultyPlacement: harness.difficultyPlacement === true,
      exposeGate: harness.exposeGate === 'strict' ? 'strict' : 'warn',
      queue: { seatCap: Object.fromEntries(Object.entries(
        harness.queue && typeof harness.queue === 'object' && !Array.isArray(harness.queue)
          && (harness.queue as Record<string, unknown>).seatCap && typeof (harness.queue as Record<string, unknown>).seatCap === 'object'
          && !Array.isArray((harness.queue as Record<string, unknown>).seatCap)
          ? (harness.queue as { seatCap: Record<string, unknown> }).seatCap : {},
      ).filter(([seat, cap]) => /^(OP|TC|MK|UX)$/.test(seat) && typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0)),
      ...(harness.queue && typeof harness.queue === 'object' && !Array.isArray(harness.queue)
        && typeof (harness.queue as Record<string, unknown>).directSay === 'boolean'
        ? { directSay: (harness.queue as { directSay: boolean }).directSay } : {}),
      ...(() => {
        const queue = harness.queue && typeof harness.queue === 'object' && !Array.isArray(harness.queue)
          ? harness.queue as Record<string, unknown> : {};
        const stale = queue.staleRunMinutes, unknownCap = queue.unknownSeatCap, burstMax = queue.burstMax;
        return {
          ...(typeof burstMax === 'number' && Number.isSafeInteger(burstMax) && burstMax > 0 ? { burstMax } : {}),
          ...(typeof stale === 'number' && Number.isSafeInteger(stale) && stale > 0 ? { staleRunMinutes: stale } : {}),
          ...(typeof unknownCap === 'number' && Number.isSafeInteger(unknownCap) && unknownCap >= 0 ? { unknownSeatCap: unknownCap } : {}),
        };
      })() },
      ...(harness.substrate === 'local' || harness.substrate === 'pod' ? { substrate: harness.substrate } : {}),
      ...(typeof harness.podPool === 'string' && harness.podPool.trim() ? { podPool: harness.podPool.trim() } : {}),
      ...(typeof harness.worktreeAddTimeoutSec === 'number' && Number.isSafeInteger(harness.worktreeAddTimeoutSec)
        && harness.worktreeAddTimeoutSec > 0 && harness.worktreeAddTimeoutSec <= 2_147_483
        ? { worktreeAddTimeoutSec: harness.worktreeAddTimeoutSec } : {}),
      ...(typeof harness.defaultRepo === 'string' && isAbsolute(harness.defaultRepo)
        ? { defaultRepo: harness.defaultRepo } : {}),
      ...(typeof harness.repo === 'string' && harness.repo.trim()
        ? { repo: harness.repo.trim() } : {}),
      helper: (() => {
        const helper = harness.helper && typeof harness.helper === 'object' && !Array.isArray(harness.helper)
          ? harness.helper as Record<string, unknown> : {};
        const repairPerDay = helper.repairPerDay;
        return {
          repair: helper.repair === 'live' ? 'live' as const : 'shadow' as const,
          repairPerDay: typeof repairPerDay === 'number' && Number.isSafeInteger(repairPerDay) && repairPerDay >= 0
            ? repairPerDay : 3,
        };
      })(),
      ...(harness.authorGrade === 'lite' || harness.authorGrade === 'full' ? { authorGrade: harness.authorGrade } : {}),
      ...(harness.authorOnPod === true ? { authorOnPod: true } : {}),
      ...(() => {
        const sibling = harness.siblingResync && typeof harness.siblingResync === 'object' && !Array.isArray(harness.siblingResync)
          ? harness.siblingResync as Record<string, unknown> : undefined;
        const maxFetch = sibling?.maxFetch;
        return typeof maxFetch === 'number' && Number.isSafeInteger(maxFetch) && maxFetch >= 0 ? { siblingResync: { maxFetch } } : {};
      })(),
      ...(harness.nestedElanous === 'allow' || harness.nestedElanous === 'refuse'
        ? { nestedElanous: harness.nestedElanous } : {}),
      nestedElanousMaxDepth: typeof harness.nestedElanousMaxDepth === 'number'
        && Number.isSafeInteger(harness.nestedElanousMaxDepth) && harness.nestedElanousMaxDepth > 0
        ? harness.nestedElanousMaxDepth : 2,
      ...(typeof harness.launchStallMinutes === 'number' && Number.isFinite(harness.launchStallMinutes) && harness.launchStallMinutes > 0
        ? { launchStallMinutes: harness.launchStallMinutes } : {}),
      followUp: harness.followUp === 'live' ? 'live' : 'shadow',
      budgetGate: parseHarnessBudgetGate(
        rawObj.harness && typeof rawObj.harness === 'object' && !Array.isArray(rawObj.harness)
          ? (rawObj.harness as Record<string, unknown>).budgetGate
          : undefined,
      ),
    },
    skillRouter: {
      autoRoute: sr.autoRoute === true,
      autoRouteCountdownMs: clampNum(sr.autoRouteCountdownMs, SR_DEFAULTS.autoRouteCountdownMs, 0, 10000),
      llmFallback: sr.llmFallback === true,
      keywordScoreThreshold: clampNum(sr.keywordScoreThreshold, SR_DEFAULTS.keywordScoreThreshold, 0, 100),
      llmConfidenceThreshold: clampNum(sr.llmConfidenceThreshold, SR_DEFAULTS.llmConfidenceThreshold, 0, 1),
      autoRouteMinScore: clampNum(sr.autoRouteMinScore, SR_DEFAULTS.autoRouteMinScore, 0, 100),
      autoRouteRequireAutoTrigger: sr.autoRouteRequireAutoTrigger === false ? false : true,
      fullMenuTier: (['T1', 'T2', 'T3'].includes(sr.fullMenuTier as string) ? sr.fullMenuTier : SR_DEFAULTS.fullMenuTier) as SkillTier,
      fullMenuConfidenceThreshold: clampNum(sr.fullMenuConfidenceThreshold, SR_DEFAULTS.fullMenuConfidenceThreshold, 0, 1),
      harnessExecAllowlist: Array.isArray(sr.harnessExecAllowlist)
        ? (sr.harnessExecAllowlist as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [...SR_DEFAULTS.harnessExecAllowlist],
    },
    llm: {
      // ★ 자율 escalation 장치(#2·2026-07-22 대표) — self-dev rework 마지막 라운드가 강한 모델(opus)로 뜨도록
      //   driver 가 escalate 스폰의 자식 env 에 ELANOUS_ESCALATE_MODEL/PROVIDER 를 심으면 여기서 llm 티어 override.
      //   config 파일 무변경·escalate 스폰에만 존재하는 env escape-hatch(자기완결). 미설정=종전.
      ...(() => {
        // ⭐ escalate 401 근본수리(2026-07-26 · 대표 결정) — 종전엔 `provider` 만 전환하고
        //   `apiKey: str(llm.apiKey)` 로 **base 키를 그대로** 들고 가, escalate(tier=opus·anthropic)가
        //   openai-codex 키로 anthropic 에 붙어 **100% 401 즉사**했다(실측: toolCalls 0 · 자율 완주 블로커).
        //   provider 를 바꾸는 자리에서 **키도 함께** 해석한다 — rotation(config) → env → (미전환 시만) 상속.
        //   ⚠️ escalate 는 provider↔model 이 정합해서 `llm.ts` 의 key-family 가드가 발동조차 안 한다.
        //      그래서 판정을 하나 더 얹는 게 아니라 이 자리에서 해석하는 것이 근본이다.
        const escalateProvider = selectedProvider;
        const rotation = parseRotation(llm.rotation);
        const baseApiKey = str(llm.apiKey);

        // ⚠️ **전환이 실제로 일어난 경우에만** 새 해석을 적용한다 (리뷰 must-fix #5488 2R).
        //    무조건 rotation→env→base 순서로 바꾸면, escalate 와 **무관한 평상시 경로**에서도 머신 env
        //    (OPENAI_API_KEY 등)가 config 의 `llm.apiKey` 를 덮는다 = 이 수리 범위 밖의 인증 계약 변경.
        //    provider 가 그대로면 종전과 **글자 그대로 동일**(str(llm.apiKey))해야 무회귀다.
        if (escalateProvider === baseProvider) {
          return { provider: escalateProvider, apiKey: baseApiKey, rotation, baseUrl: str(llm.baseUrl) };
        }

        const cred = resolveProviderCredential({ provider: escalateProvider, rotation, baseApiKey, baseProvider });
        observeCredentialResolution(escalateProvider, cred, 'escalate');
        return {
          provider: escalateProvider,
          ...(cred.apiKey ? { apiKey: cred.apiKey } : {}),
          rotation,
          // ⚠️ baseUrl 도 키와 **같은 규율**(리뷰 should-fix 10R) — 전환인데 옛 엔드포인트를 물려주면
          //    새 키·provider 를 이전 주소로 보낸다(401 과 같은 계열). rotation 명시가 없으면 undefined
          //    = provider 기본 엔드포인트. 전환이 아닌 경로는 위 early-return 이 종전값을 그대로 준다.
          ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
        };
      })(),
      model: resolveRuntimeLlmModel(baseProvider, selectedProvider, str(llm.model), escalationProvider || undefined),
      // ★ escalate effort override(#2·2026-07-22 대표) — ELANOUS_ESCALATE_EFFORT 있으면 reasoning effort 를 그 값으로
      //   (sol high 등 강한 시도). reasoningLevel(anthropic/일반)+codexReasoning(openai-codex/sol) 둘 다 커버. 미설정=종전.
      reasoningLevel: parseReasoningLevel(process.env.ELANOUS_ESCALATE_EFFORT?.trim() || llm.reasoningLevel),
      codexReasoning: (() => {
        const esc = process.env.ELANOUS_ESCALATE_EFFORT?.trim();
        const base = parseCodexReasoning(llm.codexReasoning);
        return esc ? { ...base, effort: esc as NonNullable<LLMConfig['codexReasoning']>['effort'] } : base;
      })(),
      goalLoop: parseGoalLoop(llm.goalLoop),
      memoryJudge: parseMemoryJudge(llm.memoryJudge),
      codexInspectExempt: llm.codexInspectExempt === true ? true : undefined,
      // ⛔⭐ 「false 만 끈다」 — 미설정·true 는 undefined 로 두어 기본 ON 을 유지한다(대표 결정 ②).
      //   ⚠️ 이 줄이 «없으면» 타입만 있고 파서가 안 읽어 ***노브가 no-op 이 된다***(실측으로 잡았다).
      codexAccountRotation: llm.codexAccountRotation === false ? false : undefined,
      // ⛔⭐ 알림 축도 «false 만 끈다» — 회전 축과 같은 관용구, 다른 스위치.
      codexAccountAlerts: llm.codexAccountAlerts === false ? false : undefined,
      // ⛔ 여기서 «수만» 통과시킨다 — 범위 정규화는 판정기(`normalizedRotationThresholdPercent`)가
      //   한 자로 한다. 두 곳에서 정규화하면 두 자가 갈린다.
      codexAccountRotationThresholdPercent: typeof llm.codexAccountRotationThresholdPercent === 'number'
        ? llm.codexAccountRotationThresholdPercent
        : undefined,
      codexAccountRotationThresholdPercentByAccount: llm.codexAccountRotationThresholdPercentByAccount
        && typeof llm.codexAccountRotationThresholdPercentByAccount === 'object'
        && !Array.isArray(llm.codexAccountRotationThresholdPercentByAccount)
        ? Object.fromEntries(Object.entries(llm.codexAccountRotationThresholdPercentByAccount)
          .filter(([, value]) => typeof value === 'number'))
        : undefined,
      // ⛔ 같은 모양(문자열 배열)이라 아래 fallbackChain 과 «같은 자»를 쓴다.
      codexCreditsAllowed: llm.codexCreditsAllowed === true ? true : undefined,
      codexQuotaPolicy: isCodexQuotaPolicy(llm.codexQuotaPolicy) ? llm.codexQuotaPolicy : undefined,
      codexAccountOrder: Array.isArray(llm.codexAccountOrder)
        ? llm.codexAccountOrder.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
        : undefined,
      // ⛔ 여기선 «배열이고 문자열 원소만» 통과시킨다 — 아는 이름인지의 판정은
      //   `normalizeFallbackChain()` 이 «한 자»로 한다(두 곳에서 정규화하면 자가 갈린다).
      fallbackChain: Array.isArray(llm.fallbackChain)
        ? llm.fallbackChain.filter((s: unknown): s is string => typeof s === 'string')
        : undefined,
      reviewFallbackModels: Array.isArray(llm.reviewFallbackModels)
        ? llm.reviewFallbackModels.filter((s: unknown): s is string => typeof s === 'string')
        : undefined,
      codexStore: llm.codexStore === false ? false : undefined,
      geminiSafety: llm.geminiSafety === 'permissive' || llm.geminiSafety === 'strict'
        ? llm.geminiSafety
        : (llm.geminiSafety === 'default' ? 'default' : undefined),
      geminiServerTools: parseGeminiServerTools(llm.geminiServerTools),
      answerPriority: parseAnswerPriority(llm.answerPriority),
      maxTurns: parseMaxTurnsBudget(llm.maxTurns),
      missionRouting: parseMissionRouting(llm.missionRouting),
      routePolicy: parseLlmRoutePolicy(llm.routePolicy),
      autoRoute: parseAutoRoute(llm.autoRoute),
    },
    skills: {
      activeSet: normalizeSkillSet(sk.activeSet),
      dirs: strArray(sk.dirs, skillsDefaults().dirs),
      giftEndpoint: str(sk.giftEndpoint) ?? 'https://elanous.ai',
      includeSharedAgentSkills: sk.includeSharedAgentSkills !== false,
      ...(() => { const sources = parsePersistedSkillSources(sk.sources, sk.connected); return sources ? { sources } : {}; })(),
      allow: strArray(sk.allow, []),
      deny: strArray(sk.deny, []),
      urlRouting: parseUrlRouting(sk.urlRouting),
      devRequestRouting: parseDevRequestRouting(sk.devRequestRouting),
      includeClaudePackageSkills: sk.includeClaudePackageSkills === true ? true : undefined,
      includeClaudePackageCommands: sk.includeClaudePackageCommands === true ? true : undefined,
    },
    obsidian: {
      vault: str(ob.vault) ?? obsidianDefaults().vault,
      ...(str(ob.testVault) ? { testVault: str(ob.testVault)! } : {}),
    },
    telegram: {
      enabled: tg.enabled === true,
      botToken: str(tg.botToken),
      allowedUsers: numArray(tg.allowedUsers, []),
      homeChannel: typeof tg.homeChannel === 'number' ? tg.homeChannel : undefined,
      reportChannel: normalizeReportChannel(tg.reportChannel),
      channels: normalizeTelegramChannels(tg.channels),
      testChannel: normalizeTestChannel(tg.testChannel),
      ...(tg.poller === 'standalone' || tg.poller === 'nexus' ? { poller: tg.poller } : {}),
      ...(normalizeKindRoles(tg.kindRoles) ? { kindRoles: normalizeKindRoles(tg.kindRoles)! } : {}),
      ...(str(tg.fieldDefaultEvent) ? { fieldDefaultEvent: str(tg.fieldDefaultEvent)! } : {}),
      ...(tg.fieldReelMode === 'instant' || tg.fieldReelMode === 'standard' ? { fieldReelMode: tg.fieldReelMode } : {}),
      ...(tg.contextFirst === false ? { contextFirst: false } : {}),
    },
    discord: {
      enabled: dc.enabled === true,
      botToken: str(dc.botToken),
      // Discord IDs are 64-bit snowflakes — too big for JS number.
      // Store as strings. Accept either strings or (legacy) numbers
      // in stored JSON and normalize on load.
      allowedUsers: Array.isArray(dc.allowedUsers)
        ? (dc.allowedUsers as unknown[]).map(v => String(v)).filter(Boolean)
        : [],
      homeChannel: typeof dc.homeChannel === 'string' ? dc.homeChannel
        : typeof dc.homeChannel === 'number' ? String(dc.homeChannel) : undefined,
      testChannel: normalizeDiscordTestChannel((dc as Record<string, unknown>).testChannel),
      ...(dc.contextFirst === false ? { contextFirst: false } : {}),
      ...(Array.isArray(dc.chatChannels)
        ? { chatChannels: (dc.chatChannels as unknown[]).map(v => String(v).trim()).filter(Boolean) }
        : {}),
      // Sprint 21 wiring sub-block (2026-05-01)
    },
    finance: {
      enabled: fin.enabled === true,
      morningNarrative: fin.morningNarrative !== false,
      morningHeatmapImage: fin.morningHeatmapImage !== false,
      autoLoop: {
        enabled: ((fin.autoLoop ?? {}) as Record<string, unknown>).enabled === true,
        maxPerScan: Math.max(1, Math.min(Number(((fin.autoLoop ?? {}) as Record<string, unknown>).maxPerScan ?? 2) || 2, 5)),
      },
      // R5 — strict-true arming + clamped budgets (autoLoop pattern).
      dig: {
        autoGoal: {
          enabled: (((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).enabled === true,
          maxPerDay: Math.max(1, Math.min(Number((((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).maxPerDay ?? 2) || 2, 5)),
          maxTurns: Math.max(1, Math.min(Number((((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).maxTurns ?? 6) || 6, 12)),
          independentChecker: (((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).independentChecker === true,
        },
      },
      // 온톨로지 새벽 공고화 arming(strict-true·READ-ONLY 판단·매매 격리).
      kg: {
        extract: { enabled: (((fin.kg ?? {}) as Record<string, unknown>).extract as Record<string, unknown> ?? {}).enabled === true },
        anomalyDig: { enabled: (((fin.kg ?? {}) as Record<string, unknown>).anomalyDig as Record<string, unknown> ?? {}).enabled === true },
      },
      // M4 — 새벽 수면 리플레이 자율 루프 arming(strict-true·READ-ONLY·매매 격리·저턴).
      replay: {
        autoGoal: {
          enabled: (((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).enabled === true,
          maxTurns: Math.max(1, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).maxTurns ?? 3) || 3, 6)),
          tokenCap: Math.max(20_000, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).tokenCap ?? 80_000) || 80_000, 200_000)),
          windowStartHour: Math.max(0, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).windowStartHour ?? 6) || 6, 23)),
          windowEndHour: Math.max(1, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).windowEndHour ?? 7) || 7, 24)),
        },
      },
      // 파리티 검증된 Conatus TS 포트 라우팅(strict-true·기본 false → python 경로 불변).
      conatusNativePort: fin.conatusNativePort === true,
      secContactEmail: typeof fin.secContactEmail === 'string' && fin.secContactEmail.includes('@')
        ? fin.secContactEmail.trim()
        : undefined,
      liveOrders: fin.liveOrders === true,
      relaxedGates: fin.relaxedGates === true,
    },
    onboarding: {
      ...(typeof ob2.webFirst === 'boolean' ? { webFirst: ob2.webFirst } : {}),
      ...(typeof ob2.ready === 'boolean' ? { ready: ob2.ready } : {}),
      completed: ob2.completed === true,
      completedAt: str(ob2.completedAt),
      version: typeof ob2.version === 'number' ? ob2.version : 0,
    },
    debug: {
      // Default ON — explicit `false` opts out. Any other value
      // (missing key, wrong type) falls back to the default so a
      // stale/incomplete config doesn't disable the forensic log.
      file: dbg.file === false ? false : DEBUG_DEFAULTS.file,
      level: normalizeDebugLevel(dbg.level),
      exposeFullLlmTools: dbg.exposeFullLlmTools === false
        ? false
        : DEBUG_DEFAULTS.exposeFullLlmTools,
      // OH9 — 기본 false(억제). 명시 true 만 렌더 로그를 살린다(override).
      renderLogs: dbg.renderLogs === true ? true : DEBUG_DEFAULTS.renderLogs,
    },
    logs: {
      retention: (() => {
        const r = ((logsRaw.retention ?? {}) as Record<string, unknown>);
        const num = (v: unknown, d: number): number =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
        return {
          maxAgeDays: num(r.maxAgeDays, LOGS_DEFAULTS.retention.maxAgeDays),
          maxDbMb: num(r.maxDbMb, LOGS_DEFAULTS.retention.maxDbMb),
        };
      })(),
      ...(typeof logsRaw.instanceName === 'string' && logsRaw.instanceName.trim().length > 0
        ? { instanceName: logsRaw.instanceName.trim() }
        : {}),
    },
    shell: {
      // Default OFF — explicit `true` required to surface any of the
      // mutating/network tools at the dashboard chat level. Any non-
      // true value = off.
      allowDashboardPty: sh.allowDashboardPty === true,
      allowDashboardBash: sh.allowDashboardBash === true,
      allowDashboardTerminalInject: sh.allowDashboardTerminalInject === true,
      allowDashboardApiCall: sh.allowDashboardApiCall === true,
      allowDashboardRunShell: sh.allowDashboardRunShell === true,
      // State tool defaults ON — explicit false required to hide.
      allowDashboardState: sh.allowDashboardState !== false,
      // Umbrella optional-tools kill-switch defaults ON — explicit
      // false required to short-circuit `buildDashboardOptionalToolSpecs`.
      allowDashboardOptionalTools: sh.allowDashboardOptionalTools !== false,
    },
    ...((): { errorReports?: ErrorReportsConfig } => { const er = parseErrorReportsConfig(rawObj.errorReports); return er ? { errorReports: er } : {}; })(),
    chat: {
      factQuestion: {
        maxToolTurns: typeof chatFactQuestion.maxToolTurns === 'number'
          && Number.isSafeInteger(chatFactQuestion.maxToolTurns) && chatFactQuestion.maxToolTurns > 0
          ? chatFactQuestion.maxToolTurns : CHAT_DEFAULTS.factQuestion.maxToolTurns,
      },
      fastPath: chat.fastPath === false || chat.fastPath === 'false' ? false : CHAT_DEFAULTS.fastPath,
      conciseness: {
        enabled: chatConciseness.enabled === false ? false : CHAT_CONCISENESS_DEFAULTS.enabled,
        finalMessageMaxLines: clampNum(
          chatConciseness.finalMessageMaxLines,
          CHAT_CONCISENESS_DEFAULTS.finalMessageMaxLines,
          1,
          100,
        ),
        preambleMaxWords: clampNum(
          chatConciseness.preambleMaxWords,
          CHAT_CONCISENESS_DEFAULTS.preambleMaxWords,
          1,
          50,
        ),
        flatBullets: chatConciseness.flatBullets === false ? false : CHAT_CONCISENESS_DEFAULTS.flatBullets,
      },
      toolOutput: {
        persistOnOverflow: chatToolOutput.persistOnOverflow === false ? false : CHAT_DEFAULTS.toolOutput.persistOnOverflow,
        retentionDays: clampNum(
          chatToolOutput.retentionDays,
          CHAT_DEFAULTS.toolOutput.retentionDays,
          1,
          365,
        ),
        previewLines: clampNum(
          chatToolOutput.previewLines,
          CHAT_DEFAULTS.toolOutput.previewLines,
          1,
          500,
        ),
      },
      autoCompact: {
        enabled: chatAutoCompact.enabled === false ? false : CHAT_DEFAULTS.autoCompact.enabled,
        triggerRatio: clampNum(
          chatAutoCompact.triggerRatio,
          CHAT_DEFAULTS.autoCompact.triggerRatio,
          0.5,
          0.99,
        ),
        preserveLastN: clampNum(
          chatAutoCompact.preserveLastN,
          CHAT_DEFAULTS.autoCompact.preserveLastN,
          0,
          100,
        ),
        preserveFirstN: clampNum(
          chatAutoCompact.preserveFirstN,
          CHAT_DEFAULTS.autoCompact.preserveFirstN,
          0,
          100,
        ),
        partial: chatAutoCompact.partial === false ? false : CHAT_DEFAULTS.autoCompact.partial,
        workingBudgetTokens: positiveIntOr(
          chatAutoCompact.workingBudgetTokens,
          CHAT_DEFAULTS.autoCompact.workingBudgetTokens,
        ),
      },
      compact: {
        verifyProbe: chatCompact.verifyProbe === true,
        archiveEnabled: chatCompact.archiveEnabled === false ? false : CHAT_DEFAULTS.compact.archiveEnabled,
        archiveRetentionDays: clampNum(
          chatCompact.archiveRetentionDays,
          CHAT_DEFAULTS.compact.archiveRetentionDays,
          0,
          365,
        ),
        archiveRetentionMb: clampNum(
          chatCompact.archiveRetentionMb,
          CHAT_DEFAULTS.compact.archiveRetentionMb,
          0,
          10_000,
        ),
      },
      autoCopyQaToClipboard:
        chat.autoCopyQaToClipboard === true
          ? true
          : CHAT_DEFAULTS.autoCopyQaToClipboard,
      // Wave 8 — toolDeny: accept readonly string[] from raw config,
      // filter to non-empty strings, dedupe. No clamp on length —
      // the catalog has ~150 tools, blocking ~10 is reasonable.
      toolDeny: (() => {
        const raw = (chat as { toolDeny?: unknown }).toolDeny;
        if (!Array.isArray(raw)) return [];
        const cleaned: string[] = [];
        const seen = new Set<string>();
        for (const item of raw) {
          if (typeof item !== 'string') continue;
          const trimmed = item.trim();
          if (trimmed.length === 0) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          cleaned.push(trimmed);
        }
        return cleaned;
      })(),
      systemPrompt: {
        overridePath: str(chatSystemPrompt.overridePath),
        taskVariant: str(chatSystemPrompt.taskVariant) ?? CHAT_DEFAULTS.systemPrompt.taskVariant,
        forceBuiltinVariant: (() => {
          const raw = str(chatSystemPrompt.forceBuiltinVariant)?.toLowerCase();
          return raw === 'gpt' || raw === 'codex' || raw === 'claude' || raw === 'local'
            ? raw
            : CHAT_DEFAULTS.systemPrompt.forceBuiltinVariant;
        })(),
      },
      rendering: {
        streaming: {
          mode: normalizeChatRenderingStreamingMode(chatRenderingStreaming.mode),
          catchUpThresholdLines: clampNum(
            chatRenderingStreaming.catchUpThresholdLines,
            CHAT_DEFAULTS.rendering.streaming.catchUpThresholdLines,
            1,
            1000,
          ),
          catchUpAgeMs: clampNum(
            chatRenderingStreaming.catchUpAgeMs,
            CHAT_DEFAULTS.rendering.streaming.catchUpAgeMs,
            1,
            10_000,
          ),
        },
        wrap: {
          urlAware: chatRenderingWrap.urlAware === true,
        },
        tool: {
          displayMode: normalizeChatRenderingToolDisplayMode(
            chatRendering && typeof (chatRendering as Record<string, unknown>).tool === 'object'
              ? ((chatRendering as Record<string, unknown>).tool as Record<string, unknown>).displayMode
              : undefined,
          ),
          blockMaxLines: clampNum(
            chatRendering && typeof (chatRendering as Record<string, unknown>).tool === 'object'
              ? ((chatRendering as Record<string, unknown>).tool as Record<string, unknown>).blockMaxLines
              : undefined,
            CHAT_DEFAULTS.rendering.tool.blockMaxLines,
            1,
            200,
          ),
        },
        diff: {
          colorTier: normalizeChatRenderingDiffColorTier(chatRenderingDiff.colorTier),
          headerStyle: normalizeChatRenderingDiffHeaderStyle(chatRenderingDiff.headerStyle),
          turnBrowserHistory: clampNum(
            chatRenderingDiff.turnBrowserHistory,
            CHAT_DEFAULTS.rendering.diff.turnBrowserHistory,
            1,
            20,
          ),
          turnBrowserMode: normalizeChatRenderingDiffTurnBrowserMode(chatRenderingDiff.turnBrowserMode),
        },
        hud: {
          gaugeWarnRatio: clampNum(
            chatRenderingHud.gaugeWarnRatio,
            CHAT_DEFAULTS.rendering.hud.gaugeWarnRatio,
            0,
            1,
          ),
          gaugeDangerRatio: clampNum(
            chatRenderingHud.gaugeDangerRatio,
            CHAT_DEFAULTS.rendering.hud.gaugeDangerRatio,
            0,
            1,
          ),
        },
      },
    },
    voice: {
      // Sparse parse: only set fields the user EXPLICITLY put in the
      // config file. Missing fields stay `undefined` so resolvers can
      // fall through to env (backward compat) → hardcoded default.
      stt: {
        ...(voiceStt.provider !== undefined
          ? { provider: normalizeVoiceSttProvider(voiceStt.provider) }
          : {}),
        // G-VOX-1/2 (2026-06-02) — sparse parse · 사용자가 명시한 키만 set.
        ...(typeof voiceStt.apiKey === 'string' && voiceStt.apiKey.trim().length > 0
          ? { apiKey: voiceStt.apiKey.trim() }
          : {}),
        ...(typeof voiceStt.model === 'string' && voiceStt.model.trim().length > 0
          ? { model: voiceStt.model.trim() }
          : {}),
        ...(typeof voiceStt.realtimeBaseModel === 'string' && voiceStt.realtimeBaseModel.trim().length > 0
          ? { realtimeBaseModel: voiceStt.realtimeBaseModel.trim() }
          : {}),
        ...(voiceStt.mode === 'streaming' || voiceStt.mode === 'batch'
          ? { mode: voiceStt.mode }
          : {}),
        ...(typeof voiceStt.language === 'string' && voiceStt.language.trim().length > 0
          ? { language: voiceStt.language.trim() }
          : {}),
      },
      tts: {
        ...(voiceTts.provider !== undefined
          ? { provider: normalizeVoiceTtsProvider(voiceTts.provider) }
          : {}),
        ...(typeof voiceTts.auto === 'boolean' ? { auto: voiceTts.auto } : {}),
        ...(typeof voiceTts.maxSentenceChars === 'number' && voiceTts.maxSentenceChars > 0
          ? { maxSentenceChars: Math.floor(voiceTts.maxSentenceChars) }
          : {}),
        ...(typeof voiceTts.drainCooldownMs === 'number'
          && voiceTts.drainCooldownMs >= 0
          && voiceTts.drainCooldownMs <= 2000
          ? { drainCooldownMs: Math.floor(voiceTts.drainCooldownMs) }
          : {}),
        ...(typeof voiceTts.voiceId === 'string' && voiceTts.voiceId.trim().length > 0
          ? { voiceId: voiceTts.voiceId.trim() }
          : {}),
      },
      vad: {
        ...(voiceVad.mode !== undefined
          ? { mode: normalizeVoiceVadMode(voiceVad.mode) }
          : {}),
        ...(typeof voiceVad.threshold === 'number' && voiceVad.threshold >= 0 && voiceVad.threshold <= 1
          ? { threshold: voiceVad.threshold }
          : {}),
        ...(typeof voiceVad.silenceMs === 'number' && voiceVad.silenceMs >= 50 && voiceVad.silenceMs <= 10000
          ? { silenceMs: Math.floor(voiceVad.silenceMs) }
          : {}),
        ...(typeof voiceVad.minSpeechMs === 'number' && voiceVad.minSpeechMs >= 0 && voiceVad.minSpeechMs <= 5000
          ? { minSpeechMs: Math.floor(voiceVad.minSpeechMs) }
          : {}),
      },
      chat: {
        ...(typeof voiceChat.multiTurn === 'boolean' ? { multiTurn: voiceChat.multiTurn } : {}),
      },
      discord: {
        ...(typeof voiceDiscord.voiceLanguage === 'string' && voiceDiscord.voiceLanguage.length > 0
          ? { voiceLanguage: voiceDiscord.voiceLanguage }
          : {}),
        ...(typeof voiceDiscord.voiceChannel === 'object' && voiceDiscord.voiceChannel !== null
          ? {
              voiceChannel: {
                ...(typeof voiceDiscordChannel.enabled === 'boolean'
                  ? { enabled: voiceDiscordChannel.enabled }
                  : {}),
                ...(normalizeVoiceDiscordChannelListenFilter(voiceDiscordChannel.listenFilter) !== undefined
                  ? { listenFilter: normalizeVoiceDiscordChannelListenFilter(voiceDiscordChannel.listenFilter)! }
                  : {}),
                ...(typeof voiceDiscordChannel.leaveOnEmpty === 'boolean'
                  ? { leaveOnEmpty: voiceDiscordChannel.leaveOnEmpty }
                  : {}),
                ...(typeof voiceDiscordChannel.bargeIn === 'boolean'
                  ? { bargeIn: voiceDiscordChannel.bargeIn }
                  : {}),
                ...(typeof voiceDiscordChannel.bargeInSustainMs === 'number'
                  && voiceDiscordChannel.bargeInSustainMs >= 50 && voiceDiscordChannel.bargeInSustainMs <= 5000
                  ? { bargeInSustainMs: Math.floor(voiceDiscordChannel.bargeInSustainMs) }
                  : {}),
                ...(typeof voiceDiscordChannel.selfEchoTailMs === 'number'
                  && voiceDiscordChannel.selfEchoTailMs >= 0 && voiceDiscordChannel.selfEchoTailMs <= 5000
                  ? { selfEchoTailMs: Math.floor(voiceDiscordChannel.selfEchoTailMs) }
                  : {}),
                ...(typeof voiceDiscordChannel.sttSilenceFinalizeMs === 'number'
                  && voiceDiscordChannel.sttSilenceFinalizeMs >= 100 && voiceDiscordChannel.sttSilenceFinalizeMs <= 10000
                  ? { sttSilenceFinalizeMs: Math.floor(voiceDiscordChannel.sttSilenceFinalizeMs) }
                  : {}),
              },
            }
          : {}),
        // override 필드라 normalize(기본값 강제) 대신 유효 id 만 수용 —
        // 오타는 조용히 openai 로 바뀌는 대신 미설정(전역 체인)으로 남는다.
        ...(voiceDiscord.sttProvider === 'openai-realtime-stt'
          || voiceDiscord.sttProvider === 'gemini-live-stt'
          || voiceDiscord.sttProvider === 'whisper-cpp-local'
          || voiceDiscord.sttProvider === 'elevenlabs-scribe-realtime'
          ? { sttProvider: voiceDiscord.sttProvider }
          : {}),
      },
      telegram: {
        ...(normalizeVoiceTelegramDispatch(voiceTelegram.dispatch) !== undefined
          ? { dispatch: normalizeVoiceTelegramDispatch(voiceTelegram.dispatch)! }
          : {}),
        ...(voiceTelegram.replyMode === 'auto'
          || voiceTelegram.replyMode === 'text'
          || voiceTelegram.replyMode === 'voice'
          ? { replyMode: voiceTelegram.replyMode as VoiceTelegramReplyMode }
          : {}),
        ...(typeof voiceTelegram.voiceLanguage === 'string' && voiceTelegram.voiceLanguage.length > 0
          ? { voiceLanguage: voiceTelegram.voiceLanguage }
          : {}),
      },
      pwa: {
      },
    },
    intake: {
      eventMax: typeof intake.eventMax === 'number' && Number.isSafeInteger(intake.eventMax) && intake.eventMax >= 0 ? intake.eventMax : 10,
      telegram: {
        ...(normalizeIntakeAmbientCaptureMode(intakeTelegram.ambientCapture) !== undefined
          ? { ambientCapture: normalizeIntakeAmbientCaptureMode(intakeTelegram.ambientCapture)! }
          : {}),
      },
      discord: {
        ...(normalizeIntakeAmbientCaptureMode(intakeDiscord.ambientCapture) !== undefined
          ? { ambientCapture: normalizeIntakeAmbientCaptureMode(intakeDiscord.ambientCapture)! }
          : {}),
      },
      ...(intake.approvals && typeof intake.approvals === 'object' && !Array.isArray(intake.approvals)
        && typeof (intake.approvals as Record<string, unknown>).repo === 'string'
        ? { approvals: { repo: (intake.approvals as { repo: string }).repo } }
        : {}),
    },
    dashboard: {
      views: dash.views && typeof dash.views === 'object' && !Array.isArray(dash.views)
        ? dash.views as Record<string, unknown>
        : undefined,
      theme: dash.theme && typeof dash.theme === 'object' && !Array.isArray(dash.theme)
        ? dash.theme as Record<string, unknown>
        : undefined,
      foldMode: dash.foldMode === 'line' || dash.foldMode === 'task-unit' || dash.foldMode === 'kind-unit'
        ? dash.foldMode
        : 'task-unit',
      benchmark: dash.benchmark === true ? true : undefined,
      enableVirtualWindowSwitchKeys: dash.enableVirtualWindowSwitchKeys === true,
      enableSupplementalGlobalKeys: dash.enableSupplementalGlobalKeys === true,
      promptBank: {
        enabled: dashPromptBank.enabled === true,
        dashboardTurns: dashPromptBank.dashboardTurns === true,
        skillRuns: dashPromptBank.skillRuns === true,
        budgetTokens: clampNum(
          dashPromptBank.budgetTokens,
          DASHBOARD_PROMPT_BANK_DEFAULTS.budgetTokens,
          100,
          20000,
        ),
        limit: clampNum(
          dashPromptBank.limit,
          DASHBOARD_PROMPT_BANK_DEFAULTS.limit,
          1,
          100,
        ),
        record: dashPromptBank.record === false ? false : DASHBOARD_PROMPT_BANK_DEFAULTS.record,
      },
    },
    vw: (() => {
      const entries = {
        acp: parseVwEntry('acp', vw.acp, {}),
        sim: parseVwEntry('sim', vw.sim, { resident: vw.simResident === true ? true : VW_DEFAULTS.simResident }),
        iul: parseVwEntry('iul', vw.iul, {
          resident: vw.iulResident === true ? true : VW_DEFAULTS.iulResident,
          foregroundOnStartup: vw.iulForegroundOnStartup === true ? true : VW_DEFAULTS.iulForegroundOnStartup,
        }),
      };
      const order = Array.isArray(vw.order)
        ? parseVwOrder(vw.order)
        : (vw && typeof vw === 'object' && VW_KNOWN_NAMES.some((name) => name in (vw as Record<string, unknown>))
            ? parseNamedVwOrder(vw as Record<string, unknown>)
            : [...VW_ORDER_DEFAULT]);
      return {
        windowNames: stringRecord(vw.windowNames),
        paneNames: stringRecord(vw.paneNames),
        entries,
        simResident: entries.sim.resident,
        iulResident: entries.iul.resident,
        iulForegroundOnStartup: entries.iul.foregroundOnStartup,
        order,
      };
    })(),
    acp: {
      hopCap: parseHopCap(acpHopCap),
      toolApproval: {
        timeoutMs: acpApprovalTimeoutMs(acpToolApproval.timeoutMs)
          ?? acpApprovalTimeoutEnv() ?? ACP_DEFAULTS.toolApproval.timeoutMs,
      },
      ...(typeof acp.reviewBackend === 'string' && acp.reviewBackend.trim()
        ? { reviewBackend: acp.reviewBackend.trim() }
        : {}),
      ...(typeof acp.reworkBackend === 'string' && acp.reworkBackend.trim()
        ? { reworkBackend: acp.reworkBackend.trim() }
        : {}),
      ...(Object.keys(stringRecord(acp.binaryPaths)).length > 0
        ? { binaryPaths: stringRecord(acp.binaryPaths) }
        : {}),
      ...(typeof acp.slashMaxTurns === 'number' && acp.slashMaxTurns > 0
        ? { slashMaxTurns: Math.floor(acp.slashMaxTurns) }
        : {}),
      ...(acp.editApproval === true ? { editApproval: true } : {}),
      scrubBillingEnv: acp.scrubBillingEnv !== false,
    },
    lsp: parseLspConfig(lspRaw),
    plan: parsePlanConfig(rawObj.plan),
    goals: parseGoalsConfig(rawObj.goals),
    registry: parseRegistryConfig(rawObj.registry),
    tools: parseToolsConfig(rawObj.tools),
    ...(rawObj.hitl && typeof rawObj.hitl === 'object' && !Array.isArray(rawObj.hitl)
      && typeof (rawObj.hitl as Record<string, unknown>).executionDeadlineMinutes === 'number'
      ? { hitl: { executionDeadlineMinutes: (rawObj.hitl as { executionDeadlineMinutes: number }).executionDeadlineMinutes } }
      : {}),
    ...(rawObj.outbound && typeof rawObj.outbound === 'object' && !Array.isArray(rawObj.outbound)
      && Number.isSafeInteger((rawObj.outbound as Record<string, unknown>).deferredMaxAttempts)
      && ((rawObj.outbound as { deferredMaxAttempts: number }).deferredMaxAttempts) > 0
      ? { outbound: { deferredMaxAttempts: (rawObj.outbound as { deferredMaxAttempts: number }).deferredMaxAttempts } }
      : {}),
    ...(parseHqConfig(rawObj.hq) ? { hq: parseHqConfig(rawObj.hq)! } : {}),
    ...(gateRemoteConfig ? { gateRemote: gateRemoteConfig } : {}),
    cli: { helpRole: parseCliHelpRole(rawObj.cli) },
    coo: { linearProject: typeof (rawObj.coo as { linearProject?: unknown } | undefined)?.linearProject === 'string' && (rawObj.coo as { linearProject: string }).linearProject.trim()
      ? (rawObj.coo as { linearProject: string }).linearProject.trim() : '외부 행정·큰 일 (COO)' },
    decisions: parseDecisionsConfig(rawObj.decisions),
    loops: { ...(stewardLoops ?? {}), ...parseLoopOwners(rawObj.loops), orchestrator: parseOrchestratorLoopConfig((rawObj.loops as { orchestrator?: unknown } | undefined)?.orchestrator), seat: parseSeatLoopsConfig(rawObj.loops),
      persona: { enabled: (rawObj.loops as { persona?: { enabled?: unknown } } | undefined)?.persona?.enabled === true } },
    events: parseEventsConfig(rawObj.events),
    guardian: parseGuardianConfig(rawObj.guardian),
    taskAgent: parseTaskAgentConfig(rawObj.taskAgent),
    // M1-1: sparse — undefined when the user hasn't set anything, so
    // resolvers fall through to zero-config defaults.
    ...spreadIfDefined('modelTier', parseModelTierConfig(rawObj.modelTier)),
    ...spreadIfDefined('sessionFabric', parseSessionFabricConfig(rawObj.sessionFabric)),
    ...spreadIfDefined('nextFluent', parseNextFluentConfig(rawObj.nextFluent)),
    ...spreadIfDefined('taste', parseTasteConfig(rawObj.taste)),
    ...spreadIfDefined('webSearch', parseWebSearchConfig(rawObj.webSearch)),
    ...spreadIfDefined('design', parseDesignConfig(rawObj.design)),
    diagnostics: parseDiagnosticsConfig(rawObj.diagnostics),
    ...spreadIfDefined('budget', parseBudgetConfig(rawObj.budget)),
    ...spreadIfDefined('smartDefaults', parseSmartDefaultsConfig(rawObj.smartDefaults)),
    ...spreadIfDefined('roleModels', parseRoleModelConfig(rawObj.roleModels)),
    ...spreadIfDefined('roleModelTiers', parseRoleModelTierConfig(rawObj.roleModelTiers)),
    ...spreadIfDefined('roleLlm', parseRoleLlmConfig(rawObj.roleLlm)),
    ...spreadIfDefined('autoReview', parseAutoReviewConfig(rawObj.autoReview)),
    ...spreadIfDefined('ops', parseOpsConfig(rawObj.ops)),
    ...(autopilotConfig ? { autopilot: autopilotConfig } : {}),
    grounding: parseGroundingSources(rawObj.grounding),
    ...spreadIfDefined('notifications', parseNotificationsConfig(rawNotifications)),
    ...spreadIfDefined('mcp', parseMcpConfig(rawObj.mcp)),
    ...spreadIfDefined('backgroundReasoning', parseBackgroundReasoningConfig(rawObj.backgroundReasoning)),
    raw: rawObj,
    // Phase 2 (PLAN-config-unification-elanous-root-2026-05-10):
    //   NEXUS schema fields surface at the typed root so `elanous config
    //   get global.<...>` resolves through the shared dotted-path
    //   resolver. Daemon-side reader (`src/nexus/config/user-config.ts`)
    //   continues to read these directly from the same JSON file.
    version: typeof rawObj.version === 'number' ? rawObj.version : undefined,
    global: rawObj.global && typeof rawObj.global === 'object' && !Array.isArray(rawObj.global)
      ? rawObj.global as Record<string, unknown>
      : undefined,
    tabs: rawObj.tabs && typeof rawObj.tabs === 'object' && !Array.isArray(rawObj.tabs)
      ? rawObj.tabs as Record<string, Record<string, unknown>>
      : undefined,
  };
}

function parseVwOrder(raw: unknown): Array<'acp' | 'sim' | 'iul'> {
  const seen = new Set<'acp' | 'sim' | 'iul'>();
  const out: Array<'acp' | 'sim' | 'iul'> = [];
  const push = (value: unknown) => {
    if (value !== 'acp' && value !== 'sim' && value !== 'iul') return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) push(entry);
  }
  for (const fallback of VW_ORDER_DEFAULT) push(fallback);
  return out;
}

function parseVwEntry(
  name: VwKnownName,
  raw: unknown,
  legacy: { resident?: boolean; foregroundOnStartup?: boolean } = {},
): VwEntryConfig {
  const defaults = VW_ENTRY_DEFAULTS[name];
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const resident = obj.resident === true
    ? true
    : obj.resident === false
      ? false
      : legacy.resident ?? defaults.resident;
  const foregroundOnStartup = obj.foregroundOnStartup === true
    ? true
    : legacy.foregroundOnStartup ?? defaults.foregroundOnStartup;
  return { resident, foregroundOnStartup };
}

function parseNamedVwOrder(raw: Record<string, unknown>): VwKnownName[] {
  const keyed = Object.keys(raw).filter((key): key is VwKnownName =>
    VW_KNOWN_NAMES.includes(key as VwKnownName),
  );
  const orderHints = new Map<VwKnownName, number>();
  for (const name of keyed) {
    const entry = raw[name];
    if (!entry || typeof entry !== 'object') continue;
    const hint = (entry as Record<string, unknown>).order;
    if (typeof hint === 'number' && Number.isFinite(hint)) {
      orderHints.set(name, Math.trunc(hint));
    }
  }
  if (orderHints.size === 0) return parseVwOrder(keyed);
  const fallbackPos = new Map<VwKnownName, number>();
  parseVwOrder(keyed).forEach((name, idx) => fallbackPos.set(name, idx));
  return [...VW_KNOWN_NAMES].sort((a, b) => {
    const ah = orderHints.get(a);
    const bh = orderHints.get(b);
    if (ah !== undefined && bh !== undefined && ah !== bh) return ah - bh;
    if (ah !== undefined && bh === undefined) return -1;
    if (ah === undefined && bh !== undefined) return 1;
    return (fallbackPos.get(a) ?? 999) - (fallbackPos.get(b) ?? 999);
  });
}

function parsePlanConfig(raw: unknown): PlanConfig {
  if (!raw || typeof raw !== 'object') return { ...PLAN_DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    autoWorktree: r.autoWorktree === true,
  };
}

function parseGoalsConfig(raw: unknown): GoalsConfig {
  if (!raw || typeof raw !== 'object') return { ...GOALS_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const modeRaw = typeof r.modeDefault === 'string' ? r.modeDefault : '';
  return {
    maxTurns: clampNum(r.maxTurns, GOALS_DEFAULTS.maxTurns, 1, 1000),
    wallClockMaxMs: clampNum(r.wallClockMaxMs, GOALS_DEFAULTS.wallClockMaxMs, 60_000, 24 * 60 * 60_000),
    tokenBudget: clampNum(r.tokenBudget, GOALS_DEFAULTS.tokenBudget, 0, 10_000_000),
    judgeModel: typeof r.judgeModel === 'string' ? r.judgeModel : GOALS_DEFAULTS.judgeModel,
    judgeRetries: clampNum(r.judgeRetries, GOALS_DEFAULTS.judgeRetries, 0, 10),
    pauseOnPlanModeEnter: r.pauseOnPlanModeEnter !== false,
    resumeOnPlanModeExit: r.resumeOnPlanModeExit === true,
    modeDefault: modeRaw === 'spec' ? 'spec' : 'judge',
  };
}

function cloneLspDefaults(): LspConfig {
  return {
    enabled: LSP_DEFAULTS.enabled,
    typescript: cloneLspLang(LSP_DEFAULTS.typescript),
    python:     cloneLspLang(LSP_DEFAULTS.python),
    rust:       cloneLspLang(LSP_DEFAULTS.rust),
    idleTimeoutMs: LSP_DEFAULTS.idleTimeoutMs,
    workspaceSymbolLanguage: LSP_DEFAULTS.workspaceSymbolLanguage,
  };
}

function cloneLspLang(e: LspLanguageConfig | false): LspLanguageConfig | false {
  if (e === false) return false;
  return {
    command: e.command,
    ...(e.args ? { args: [...e.args] } : {}),
    extensions: [...e.extensions],
  };
}

function parseLspLanguage(
  raw: unknown,
  fallback: LspLanguageConfig | false,
): LspLanguageConfig | false {
  if (raw === false) return false;
  if (!raw || typeof raw !== 'object') return cloneLspLang(fallback);
  const r = raw as Record<string, unknown>;
  // Fallback entry is false when the user hasn't configured this
  // language; an explicit `{ command: 'x' }` overrides. If the user
  // supplies an object without `command`, we treat it as "enable
  // defaults for this language" — but only when the default is not
  // already `false` (otherwise we'd silently conjure a binary name).
  const cmd = str(r.command) ?? (fallback !== false ? fallback.command : undefined);
  if (!cmd) return cloneLspLang(fallback);
  const args = Array.isArray(r.args)
    ? (r.args as unknown[]).filter(a => typeof a === 'string') as string[]
    : (fallback !== false && fallback.args ? [...fallback.args] : undefined);
  const exts = Array.isArray(r.extensions) && r.extensions.length > 0
    ? (r.extensions as unknown[]).filter(a => typeof a === 'string').map(s => (s as string).toLowerCase().replace(/^\./, ''))
    : (fallback !== false ? [...fallback.extensions] : []);
  return {
    command: cmd,
    ...(args ? { args } : {}),
    extensions: exts,
  };
}

function parseLspConfig(raw: Record<string, unknown>): LspConfig {
  return {
    enabled: raw.enabled === false ? false : true,
    typescript: parseLspLanguage(raw.typescript, LSP_DEFAULTS.typescript),
    python:     parseLspLanguage(raw.python,     LSP_DEFAULTS.python),
    rust:       parseLspLanguage(raw.rust,       LSP_DEFAULTS.rust),
    idleTimeoutMs: clampNum(raw.idleTimeoutMs, LSP_DEFAULTS.idleTimeoutMs, 5_000, 60 * 60 * 1000),
    workspaceSymbolLanguage: (raw.workspaceSymbolLanguage === 'python' || raw.workspaceSymbolLanguage === 'rust')
      ? raw.workspaceSymbolLanguage
      : 'typescript',
  };
}

function parseHopCap(raw: Record<string, unknown>): AcpHopCapConfig {
  const out: AcpHopCapConfig = {};
  for (const k of ['claude', 'codex', 'gemini', 'default'] as const) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

function normalizeDebugLevel(v: unknown): DebugConfig['level'] {
  switch (v) {
    case 'off':
    case 'trail':
    case 'diag':
    case 'normal':
    case 'verbose':
    case 'detail':
    case 'keytrace':
      return v;
    default:
      return DEBUG_DEFAULTS.level;
  }
}

function normalizeChatRenderingStreamingMode(v: unknown): ChatRenderingStreamingMode {
  return v === 'line' ? 'line' : CHAT_DEFAULTS.rendering.streaming.mode;
}

function normalizeChatRenderingToolDisplayMode(v: unknown): ChatRenderingToolDisplayMode {
  return v === 'inline-to-block' ? 'inline-to-block' : CHAT_DEFAULTS.rendering.tool.displayMode;
}

function normalizeChatRenderingDiffColorTier(v: unknown): ChatRenderingDiffColorTier {
  switch (v) {
    case 'truecolor':
    case '256':
    case 'ansi16':
      return v;
    default:
      return CHAT_DEFAULTS.rendering.diff.colorTier;
  }
}

function normalizeChatRenderingDiffHeaderStyle(v: unknown): ChatRenderingDiffHeaderStyle {
  return v === 'edited' ? 'edited' : CHAT_DEFAULTS.rendering.diff.headerStyle;
}

function normalizeChatRenderingDiffTurnBrowserMode(v: unknown): ChatRenderingDiffTurnBrowserMode {
  switch (v) {
    case 'files':
    case 'turns':
      return v;
    default:
      return CHAT_DEFAULTS.rendering.diff.turnBrowserMode;
  }
}

/** Follow-up #7 — resolve the effective HOP_CAP for a brand from
 *  user-config. Returns `undefined` when no brand-specific and no
 *  `default` entry is set; the DRM resolver then falls back to
 *  `DEFAULT_HOP_CAP`. Exposed as a helper so the dashboard boot can
 *  wire it into `setAcpHopCapResolver` without replicating the lookup
 *  chain. */
export function resolveAcpHopCapFromConfig(
  brandId: string,
  config: UserConfig = getUserConfig(),
): number | undefined {
  const hc = config.acp.hopCap;
  if (brandId === 'claude' && hc.claude !== undefined) return hc.claude;
  if (brandId === 'codex' && hc.codex !== undefined) return hc.codex;
  if (brandId === 'gemini' && hc.gemini !== undefined) return hc.gemini;
  return hc.default;
}

/** 자식 worktree 뿌리 — ⭐ **소비처는 이 함수만 부른다**(`getUserConfig().tools….worktreeRoot` 를 직접 쓰지 않는다).
 *
 *  ⛔ 왜 함수로 뽑나(리뷰 2R must-fix ①②): 소비처마다 같은 표현식을 손으로 쓰면
 *  ⑴ 누가 `worktreeRoot: undefined` 를 넘겨도 「인자를 썼다」는 검사는 통과하고
 *  ⑵ 별칭·래퍼로 부르면 소스 스캔이 못 본다.
 *  ⇒ 🩹 값을 «내는 자리»를 하나로 만들면 그 둘이 «구조적으로» 사라진다 — 넘길 잘못된 값이 없다.
 *  ⭐ 그리고 이 함수 하나만 런타임으로 검증하면 모든 소비처의 전달값이 같이 검증된다. */
export function configuredWorktreeRoot(): string {
  return getUserConfig().tools.selfImplement.worktreeRoot;
}

export function getUserConfig(path: string = defaultPath()): UserConfig {
  if (cache && cachedPath === path) {
    // Phase 4: serve cached only when on-disk file is unchanged. mtimeMs
    // null means file is missing → fall through and rebuild defaults.
    const currentMtimeMs = readMtimeMsOrNull(path);
    if (currentMtimeMs !== null && currentMtimeMs === cachedMtimeMs) {
      return cache;
    }
  }
  cache = applyOverlay(buildUserConfig(path));
  cachedPath = path;
  cachedMtimeMs = readMtimeMsOrNull(path);
  return cache;
}

export function reloadUserConfig(path: string = defaultPath()): UserConfig {
  cache = applyOverlay(buildUserConfig(path));
  cachedPath = path;
  cachedMtimeMs = readMtimeMsOrNull(path);
  return cache;
}

export function resetUserConfig(): void {
  cache = null;
  cachedPath = null;
  cachedMtimeMs = null;
  __resetClaudePackageSkillDirsCacheForTests();
}

/** Default backup path — sits next to config.json so `elanous provider
 *  restore` can find it without extra arguments. A/B comparison: if
 *  you want multiple named backups, use `saveUserConfigBackupTo(path)`. */
export function backupConfigPath(path: string = defaultPath()): string {
  return `${path}.bak`;
}

/** Copy the current config.json to its `.bak` sibling. Returns true
 *  if a backup was written, false if the source doesn't exist. Throws
 *  on IO failure (bad permissions etc). Used by `elanous provider set`
 *  before mutating config so the user can always roll back. */
export function backupUserConfig(
  path: string = defaultPath(),
  backupPath: string = backupConfigPath(path),
): boolean {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf-8');
  writeFileSync(backupPath, raw);
  return true;
}

/** Restore config.json from its `.bak` sibling. Returns true if the
 *  restore happened, false if no backup was found. Deletes the backup
 *  afterwards so repeated restores can't resurrect an ancient state. */
export function restoreUserConfig(
  path: string = defaultPath(),
  backupPath: string = backupConfigPath(path),
): boolean {
  if (!existsSync(backupPath)) return false;
  const raw = readFileSync(backupPath, 'utf-8');
  writeFileSync(path, raw);
  return true;
}

// ── Rotation helpers ──
//
// The user maintains an ordered list of provider-shaped entries
// (provider, model, apiKey, baseUrl, label). `elanous provider:rotate`
// / `/provider next` advance through the list; `elanous provider:use
// <label>` jumps to a specific entry by label / provider name /
// model substring. The active LLMConfig fields at the top level
// (provider, apiKey, model, baseUrl) are copied FROM the selected
// entry when it activates — so the rest of the app sees the new
// settings through the existing cfg.llm channel without any
// rotation-awareness.

/** Build the default display label for a rotation entry. Used when
 *  the user didn't supply one — keeps the list readable. */
export function rotationEntryLabel(e: RotationEntry): string {
  return e.label ?? (e.model ? `${e.provider}:${e.model}` : e.provider);
}

/** Vendor-default model identifier per provider. Used by the model
 *  picker (status-bar pill popup) to surface a real model name even
 *  when a rotation entry was added without an explicit `model` field
 *  (e.g. `elanous provider:rotate add anthropic` with no `-m`). Sourced
 *  from the same defaults `elanous provider:rotate add` uses; lives
 *  here so UI consumers don't import from src/index.ts (which would
 *  pull in the entire CLI surface). */
export const PROVIDER_DEFAULT_MODEL: Record<LLMProviderName, string> = {
  auto: '',
  // ⛔ 2026-09-23: `claude-opus-4-8` 은 별칭 감사가 ***stale*** 로 판정한 값이었다
  //    (`auditFamilyAliasFreshness` → recommendedModel: claude-opus-5). 실물 flagship 으로 맞춘다.
  // ⭐ 2026-09-25 (대표 「모델별 최신으로」): anthropic → opus 5.5 · gemini → 3.8-flash. 근거 = 각 provider 목록 실측(사다리 머리말).
  //   ⛔ openai(API 키)는 gpt-4o 그대로 — `gpt-6-*` 는 openai-codex 계열이라 openai 로 부르면 호환 판정이 거부한다(09-23 대표 · 같은 날 되돌림).
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4o',
  // ⛔ 2026-09-23: `gpt-5.5` 는 ***두 세대 낡았다***. 운영 기본은 `gpt-6-sol` 이고
  //    (대표 2026-09-23 · `llm.ts` `CODEX_DEFAULT_MODEL`), 이 표만 안 따라왔다.
  //    ⚠️ `llm.ts` 에서 import 하지 «않는다» — 이 파일은 UI 소비자가 CLI 표면을 안 끌어오게
  //    «일부러» 독립돼 있다(이 상수의 머리말). ⇒ 값을 맞추고 «자»로 묶는다.
  'openai-codex': 'gpt-6-sol',
  // ⛔ 2026-08-18: 'grok-4-1-fast' 는 «200 OK 로 응답하지만 실제로는 grok-4.3 이 도는»
  //    레거시 별칭이었다(xAI 실호출 대조). 실물 flagship 으로 고친다.
  grok: 'grok-4.7',
  // 대표 2026-09-23 — 사다리 balanced 와 같다(`llm.ts` OPENROUTER_MODEL). 자가 둘을 묶는다.
  openrouter: 'openrouter/z-ai/glm-5.3',
  // ⛔ 2026-08-18: 'gemini-2.0-flash' 는 카탈로그의 «가장 낡은» 항목이었다. 같은 날 grok 을
  //    고치면서 이 줄이 빠졌다. 카탈로그가 recommended 로 표시한 실물 flash 로 맞춘다.
  gemini: 'gemini-3.8-flash',
  // ⛔ 2026-08-18: 'llama-3' 는 이 저장소가 로컬 LLM 을 쓰기 시작한 이래 «한 번도» 갱신되지 않았고
  //    LM Studio 실물 목록에 없다. 같은 날 grok·gemini 에서 잡은 것과 같은 병(기본값이 실물을 안 가리킨다).
  // ⛔ 2026-09-23 — ***`local:` 접두를 붙인다.*** `#19867` 에서 사다리에만 붙여 «정렬이 깨졌고»
  //   `local-tier-resolution.test.ts` 가 그것을 물었다(내가 낸 회귀 · origin/main 에서도 3 fail).
  //   ⭐ 접두가 «옳은» 이유 둘: ⑴ 요청 직전에 벗겨진다(`llm.ts` stripLocalLlmSpec)
  //     ⑵ 클라우드 `qwen-*` 과 ***이름이 겹치는 것을 가른다*** — 접두 없이는 계열 추론이
  //        `qwen3.8-27b-mlx` 를 클라우드 qwen 으로 읽는다(그게 `#19867` 에서 고친 그 병이다).
  local: 'local:qwen3.8-27b-mlx',
  kimi: 'kimi-k2.6',
  qwen: 'qwen3.6-flash',
  glm: 'glm-5.1',
};

/** Resolve the display model for a rotation entry — falls back to the
 *  provider's vendor default when the entry doesn't pin a model. */
export function modelDisplayForRotationEntry(e: RotationEntry): string {
  return e.model ?? PROVIDER_DEFAULT_MODEL[e.provider] ?? '';
}

/** Find the rotation index that matches the current active top-level
 *  (provider, model). Returns -1 when no entry matches — typical when
 *  the user set the active provider manually without adding it to
 *  the rotation. Callers should treat -1 as "start from the top on
 *  next rotate". */
export function currentRotationIndex(cfg: UserConfig): number {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return -1;
  for (let i = 0; i < rot.length; i++) {
    const e = rot[i]!;
    if (e.provider !== cfg.llm.provider) continue;
    // When the entry has an explicit model, require match; otherwise
    // any model of the same provider is considered "current".
    if (e.model && cfg.llm.model && e.model !== cfg.llm.model) continue;
    return i;
  }
  return -1;
}

/** Apply a rotation entry to the active LLMConfig fields. Pure
 *  function — returns a new cfg without mutating the input. The
 *  apiKey / baseUrl fall back to the previous active values when
 *  the entry doesn't provide them, so partial entries (provider +
 *  model only, relying on env-var API keys) keep working. */
export function applyRotationEntry(cfg: UserConfig, entry: RotationEntry): UserConfig {
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      provider: entry.provider,
      // Explicit undefined ERASES the field; only copy when present
      // OR when the previous cfg had no corresponding top-level.
      ...(entry.model   !== undefined ? { model:   entry.model }   : {}),
      ...(entry.apiKey  !== undefined ? { apiKey:  entry.apiKey }  : {}),
      ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    },
  };
}

/** Advance the rotation by one step (wraps to index 0 after the last
 *  entry). Returns { cfg, entry } — the new cfg and the freshly-
 *  activated entry, or { cfg: original, entry: null } if rotation is
 *  empty. Caller is responsible for saveUserConfig + reloadUserConfig. */
export function rotateNextProvider(cfg: UserConfig): { cfg: UserConfig; entry: RotationEntry | null } {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return { cfg, entry: null };
  const cur = currentRotationIndex(cfg);
  const next = cur < 0 ? 0 : (cur + 1) % rot.length;
  const entry = rot[next]!;
  return { cfg: applyRotationEntry(cfg, entry), entry };
}

/** Jump to the first rotation entry matching `needle` — checked
 *  against (in priority order): label exact match, provider exact
 *  match, model substring match, provider substring match. Returns
 *  { cfg, entry } on success or { cfg: original, entry: null } on
 *  no-match. Case-insensitive. */
export function jumpToRotationEntry(
  cfg: UserConfig,
  needle: string,
): { cfg: UserConfig; entry: RotationEntry | null } {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return { cfg, entry: null };
  const q = needle.toLowerCase();
  // Priority scan: label exact > provider exact > model contains > provider contains.
  const byLabel = rot.findIndex(e => (e.label ?? '').toLowerCase() === q);
  const byProv  = rot.findIndex(e => e.provider.toLowerCase() === q);
  const byMdlSub = rot.findIndex(e => (e.model ?? '').toLowerCase().includes(q));
  const byProvSub = rot.findIndex(e => e.provider.toLowerCase().includes(q));
  const idx = [byLabel, byProv, byMdlSub, byProvSub].find(i => i >= 0) ?? -1;
  if (idx < 0) return { cfg, entry: null };
  const entry = rot[idx]!;
  return { cfg: applyRotationEntry(cfg, entry), entry };
}

/** Append an entry to the rotation (dedup by label-or-provider:model
 *  so repeated adds are idempotent). Does NOT modify the active
 *  top-level llm fields — use rotateNextProvider / jumpToRotationEntry
 *  for that. */
export function addRotationEntry(cfg: UserConfig, entry: RotationEntry): UserConfig {
  const key = rotationEntryLabel(entry);
  const existing = cfg.llm.rotation ?? [];
  const filtered = existing.filter(e => rotationEntryLabel(e) !== key);
  return {
    ...cfg,
    llm: { ...cfg.llm, rotation: [...filtered, entry] },
  };
}

/** Remove rotation entry by label / provider / model (same matching
 *  rules as jumpToRotationEntry). Returns new cfg + the removed
 *  entry, or {cfg, removed: null} when no match. */
export function removeRotationEntry(
  cfg: UserConfig,
  needle: string,
): { cfg: UserConfig; removed: RotationEntry | null } {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return { cfg, removed: null };
  const q = needle.toLowerCase();
  const idx = rot.findIndex(e =>
    (e.label ?? '').toLowerCase() === q
    || e.provider.toLowerCase() === q
    || (e.model ?? '').toLowerCase() === q,
  );
  if (idx < 0) return { cfg, removed: null };
  const removed = rot[idx]!;
  const next = rot.slice(0, idx).concat(rot.slice(idx + 1));
  return {
    cfg: { ...cfg, llm: { ...cfg.llm, rotation: next.length > 0 ? next : undefined } },
    removed,
  };
}

export function saveUserConfig(
  cfg: UserConfig,
  path: string = defaultPath(),
): void {
  const chatRendering = {
    ...CHAT_DEFAULTS.rendering,
    ...(cfg.chat.rendering ?? {}),
    streaming: {
      ...CHAT_DEFAULTS.rendering.streaming,
      ...(cfg.chat.rendering?.streaming ?? {}),
    },
    wrap: {
      ...CHAT_DEFAULTS.rendering.wrap,
      ...(cfg.chat.rendering?.wrap ?? {}),
    },
    tool: {
      ...CHAT_DEFAULTS.rendering.tool,
      ...(((cfg.chat.rendering as unknown as { tool?: Record<string, unknown> } | undefined)?.tool) ?? {}),
    },
    diff: {
      ...CHAT_DEFAULTS.rendering.diff,
      ...(cfg.chat.rendering?.diff ?? {}),
    },
    hud: {
      ...CHAT_DEFAULTS.rendering.hud,
      ...(cfg.chat.rendering?.hud ?? {}),
    },
  };
  const rawRest = { ...(cfg.raw ?? {}) };
  // projects: raw entries are kept verbatim — an invalid entry loaded from disk is preserved, not blocked (its error
  // surfaces in resolveRubricAxes) — and typed axes handed to save are validated (invalid ones refuse the save).
  const rawProjectsValue = rawRest.projects;
  const rawProjects = rawRest.projects && typeof rawRest.projects === 'object' && !Array.isArray(rawRest.projects)
    ? rawRest.projects as Record<string, unknown> : undefined;
  const savedProjects: Record<string, unknown> | undefined = rawProjects || cfg.projects ? { ...(rawProjects ?? {}) } : undefined;
  for (const [id, project] of Object.entries(cfg.projects ?? {})) {
    if (project?.rubric?.axes === undefined) continue;
    const axes = parseProjectRubricAxes(id, project.rubric.axes);
    const rawProject = rawProjects?.[id] && typeof rawProjects[id] === 'object' && !Array.isArray(rawProjects[id])
      ? rawProjects[id] as Record<string, unknown> : {};
    const rawRubric = rawProject.rubric && typeof rawProject.rubric === 'object' && !Array.isArray(rawProject.rubric)
      ? rawProject.rubric as Record<string, unknown> : {};
    savedProjects![id] = { ...rawProject, rubric: { ...rawRubric, axes } };
  }
  // Strip typed sections from raw so we don't double-write stale copies.
  delete rawRest.skillRouter;
  delete rawRest.llm;
  delete rawRest.skills;
  delete rawRest.obsidian;
  delete rawRest.telegram;
  delete rawRest.discord;
  delete rawRest.onboarding;
  delete rawRest.debug;
  delete rawRest.shell;
  delete rawRest.chat;
  delete rawRest.dashboard;
  delete rawRest.vw;
  delete rawRest.acp;
  delete rawRest.lsp;
  delete rawRest.plan;
  delete rawRest.controlPlane;
  // Phase 2: NEXUS schema fields are written explicitly below so the
  // round-trip preserves any cfg.global / cfg.tabs / cfg.version mutations
  // applied between read and write (e.g. `elanous config set global.x ...`).
  delete rawRest.version;
  delete rawRest.global;
  delete rawRest.tabs;
  // M1-2b (PLAN-friction-free-model-selection-ux-2026-05-12) — the
  // three friction-free-UX sub-trees round-trip through their typed
  // parsers; strip from raw so stale copies don't double-write.
  delete rawRest.modelTier;
  delete rawRest.sessionFabric;
  delete rawRest.nextFluent;
  delete rawRest.taste;
  delete rawRest.budget;
  delete rawRest.smartDefaults;
  delete rawRest.grounding;
  delete rawRest.diagnostics;
  delete rawRest.projects;
  delete rawRest.starter;
  delete rawRest.watch;
  delete rawRest.guardian;
  const rawHarness = rawRest.harness && typeof rawRest.harness === 'object' && !Array.isArray(rawRest.harness)
    ? rawRest.harness as Record<string, unknown> : {};
  delete rawRest.harness;
  const rawAutopilot = rawRest.autopilot && typeof rawRest.autopilot === 'object' && !Array.isArray(rawRest.autopilot)
    ? rawRest.autopilot as Record<string, unknown> : {};
  const rawLoops = rawRest.loops && typeof rawRest.loops === 'object' && !Array.isArray(rawRest.loops)
    ? rawRest.loops as Record<string, unknown> : {};
  const rawSteward = rawLoops.steward && typeof rawLoops.steward === 'object' && !Array.isArray(rawLoops.steward)
    ? rawLoops.steward as Record<string, unknown> : {};
  if (cfg.loops) delete rawRest.loops;
  if (cfg.pod?.hostMirror) {
    const rawPod = rawRest.pod && typeof rawRest.pod === 'object' && !Array.isArray(rawRest.pod)
      ? rawRest.pod as Record<string, unknown> : {};
    rawRest.pod = { ...rawPod, hostMirror: cfg.pod.hostMirror };
  }

  const out: Record<string, unknown> = {
    harness: stripUndef({
      ...rawHarness,
      pod: cfg.harness?.pod ?? rawHarness.pod,
      budgetGate: cfg.harness?.budgetGate ?? rawHarness.budgetGate,
      exposeGate: cfg.harness?.exposeGate ?? rawHarness.exposeGate,
      revertGuard: cfg.harness?.revertGuard ?? rawHarness.revertGuard,
      difficultyPlacement: cfg.harness?.difficultyPlacement ?? rawHarness.difficultyPlacement,
      defaultRepo: cfg.harness?.defaultRepo ?? rawHarness.defaultRepo,
      repo: cfg.harness?.repo,
      substrate: cfg.harness?.substrate,
      podPool: cfg.harness?.podPool,
      authorOnPod: cfg.harness?.authorOnPod === true ? true : undefined,
      followUp: cfg.harness?.followUp === 'live' ? 'live' : undefined,
      queue: cfg.harness?.queue ?? rawHarness.queue,
      helper: cfg.harness?.helper ?? rawHarness.helper,
    }),
    ...rawRest,
    ...(savedProjects ? { projects: savedProjects } : rawProjectsValue !== undefined ? { projects: rawProjectsValue } : {}),
    ...(cfg.starter ? { starter: cfg.starter } : {}),
    ...(cfg.watch ? { watch: cfg.watch } : {}),
    ...(cfg.guardian ? { guardian: cfg.guardian } : {}),
    ...(cfg.loops ? { loops: {
      ...rawLoops,
      owners: cfg.loops.owners ?? {}, defaultOwner: cfg.loops.defaultOwner ?? 'OP',
      ...(cfg.loops.steward ? { steward: { ...rawSteward, mode: cfg.loops.steward.mode ?? cfg.loops.steward.launch ?? 'shadow' } } : {}),
      ...(cfg.loops.orchestrator ? { orchestrator: cfg.loops.orchestrator } : {}),
      ...(cfg.loops.seat ? { seat: {
        mode: cfg.loops.seat.mode,
        questions: cfg.loops.seat.questions ?? 'shadow',
        seats: cfg.loops.seat.seats ?? ['MK'],
        podPool: cfg.loops.seat.podPool ?? 'pool-node-b@node-b:8',
        ...(cfg.loops.seat.neighbors ? { neighbors: cfg.loops.seat.neighbors } : {}),
        ...(cfg.loops.seat.reportPr === undefined ? {} : { reportPr: cfg.loops.seat.reportPr }),
        ...(cfg.loops.seat.stall ? { stall: cfg.loops.seat.stall } : {}),
        ...(cfg.loops.seat.repeatStop === undefined ? {} : { repeatStop: cfg.loops.seat.repeatStop }),
        ...(cfg.loops.seat.opDecide ? { opDecide: cfg.loops.seat.opDecide } : {}),
      } } : {}),
    } } : {}),
    ...(cfg.autopilot ? { autopilot: {
      ...rawAutopilot,
      ...cfg.autopilot,
      ...(cfg.autopilot.trackAgent ? { trackAgent: {
        ...(rawAutopilot.trackAgent && typeof rawAutopilot.trackAgent === 'object' && !Array.isArray(rawAutopilot.trackAgent)
          ? rawAutopilot.trackAgent as Record<string, unknown> : {}),
        ...cfg.autopilot.trackAgent,
      } } : {}),
      ...(cfg.autopilot.trackCourier ? { trackCourier: {
        ...(rawAutopilot.trackCourier && typeof rawAutopilot.trackCourier === 'object' && !Array.isArray(rawAutopilot.trackCourier)
          ? rawAutopilot.trackCourier as Record<string, unknown> : {}),
        ...cfg.autopilot.trackCourier,
      } } : {}),
    } } : {}),
    skillRouter: cfg.skillRouter,
    llm: stripUndef({
      provider: cfg.llm.provider,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      // Persist the rotation exactly as held in memory — each entry
      // stripped of its own undefined fields so the on-disk JSON
      // stays minimal. Omit the key entirely when no rotation is
      // configured (keeps configs of single-provider users clean).
      rotation: cfg.llm.rotation && cfg.llm.rotation.length > 0
        ? cfg.llm.rotation.map(e => stripUndef({
            provider: e.provider,
            model:    e.model,
            apiKey:   e.apiKey,
            baseUrl:  e.baseUrl,
            label:    e.label,
          }))
        : undefined,
      // Reasoning fields (added 2026-05-03). Both omitted by stripUndef
      // when undefined so opt-out users keep the legacy minimal JSON.
      // CRITICAL: these MUST be in sync with the parser in getUserConfig
      // — a missing field here = silent drop on every save (user
      // changes /reasoning to high → file write loses it → reload
      // picks up capability fallback 'medium' → user thinks fix
      // regressed).
      reasoningLevel: cfg.llm.reasoningLevel,
      codexReasoning: cfg.llm.codexReasoning,
      goalLoop: cfg.llm.goalLoop,
      memoryJudge: cfg.llm.memoryJudge,
      codexInspectExempt: cfg.llm.codexInspectExempt,
      codexAccountRotation: cfg.llm.codexAccountRotation,
      codexAccountAlerts: cfg.llm.codexAccountAlerts,
      codexAccountRotationThresholdPercent: cfg.llm.codexAccountRotationThresholdPercent,
      codexAccountRotationThresholdPercentByAccount: cfg.llm.codexAccountRotationThresholdPercentByAccount,
      codexAccountOrder: cfg.llm.codexAccountOrder,
      // ★ 2026-09-28: 타입·파서에만 넣고 이 whitelist 를 빠뜨려 `config set llm.codexCreditsAllowed true` 가 «직렬화 드롭» 됐다(#21375 직후 운영 실측).
      codexCreditsAllowed: cfg.llm.codexCreditsAllowed,
      codexQuotaPolicy: cfg.llm.codexQuotaPolicy,
      fallbackChain: cfg.llm.fallbackChain,
      reviewFallbackModels: cfg.llm.reviewFallbackModels,
      codexStore: cfg.llm.codexStore,
      geminiSafety: cfg.llm.geminiSafety,
      geminiServerTools: cfg.llm.geminiServerTools,
      answerPriority: cfg.llm.answerPriority,
      maxTurns: cfg.llm.maxTurns,
      missionRouting: cfg.llm.missionRouting,
    }),
    skills: stripUndef({
      activeSet: cfg.skills.activeSet,
      dirs: [...cfg.skills.dirs],
      giftEndpoint: cfg.skills.giftEndpoint === 'https://elanous.ai' ? undefined : cfg.skills.giftEndpoint,
      // EN5 — only connected roots are persisted (preset/shared/package are derived). The dev-only `connected` key is not written back.
      sources: cfg.skills.sources && cfg.skills.sources.some((source) => source.kind === 'connected')
        ? cfg.skills.sources.filter((source) => source.kind === 'connected').map(({ id, path, enabled }) => ({ id, path, enabled }))
        : undefined,
      // Omit allow/deny when empty to keep disk JSON minimal for the
      // common "no filter" case.
      allow: cfg.skills.allow && cfg.skills.allow.length > 0 ? [...cfg.skills.allow] : undefined,
      deny:  cfg.skills.deny  && cfg.skills.deny.length  > 0 ? [...cfg.skills.deny]  : undefined,
      // ⚠️ 옵셔널이다 — 없는데 접으면 saveUserConfig 가 터진다(테스트가 그 경로를 탄다).
      urlRouting: cfg.skills.urlRouting ? {
        enabled: cfg.skills.urlRouting.enabled,
        twoStage: cfg.skills.urlRouting.twoStage,
        defaultTargets: [...cfg.skills.urlRouting.defaultTargets],
        guardKeywords: [...cfg.skills.urlRouting.guardKeywords],
        absorbKeywords: [...cfg.skills.urlRouting.absorbKeywords],
        map: { ...cfg.skills.urlRouting.map },
        absorbSkill: cfg.skills.urlRouting.absorbSkill,
      } : undefined,
      devRequestRouting: cfg.skills.devRequestRouting ? {
        enabled: cfg.skills.devRequestRouting.enabled,
        verbs: [...cfg.skills.devRequestRouting.verbs],
        guardKeywords: [...cfg.skills.devRequestRouting.guardKeywords],
      } : undefined,
      includeClaudePackageSkills: cfg.skills.includeClaudePackageSkills === true ? true : undefined,
      includeClaudePackageCommands: cfg.skills.includeClaudePackageCommands === true ? true : undefined,
    }),
    obsidian: { vault: cfg.obsidian.vault, ...(cfg.obsidian.testVault ? { testVault: cfg.obsidian.testVault } : {}) },
    telegram: stripUndef({
      enabled: cfg.telegram.enabled,
      botToken: cfg.telegram.botToken,
      allowedUsers: [...cfg.telegram.allowedUsers],
      homeChannel: cfg.telegram.homeChannel,
      reportChannel: cfg.telegram.reportChannel
        ? stripUndef({
            chatId: cfg.telegram.reportChannel.chatId,
            botToken: cfg.telegram.reportChannel.botToken,
          })
        : undefined,
      channels: cfg.telegram.channels
        ? cfg.telegram.channels.map(c => ({ ...c, roles: [...c.roles] }))
        : undefined,
      testChannel: cfg.telegram.testChannel
        ? stripUndef({
            botToken: cfg.telegram.testChannel.botToken,
            allowedUsers: cfg.telegram.testChannel.allowedUsers
              ? [...cfg.telegram.testChannel.allowedUsers] : undefined,
            // ★ botUsername 은 타입·파서(normalizeTestChannel)에 있으나 이 저장
            //   직렬화 whitelist 에서 빠져 `config set` 후 재읽기에서 드롭되던 모순
            //   (2026-07-22). round-trip 을 맞춘다.
            botUsername: cfg.telegram.testChannel.botUsername,
          })
        : undefined,
      // ★ 2026-09-25: `poller`(T1 분리 스위치)가 파서엔 있고 이 whitelist 에 없어 `config set telegram.poller` 가
      //   「직렬화 드롭」으로 조용히 사라졌다 — 운영 전환 스위치를 켤 방법이 없었다(07-22 botUsername 과 같은 모양).
      poller: cfg.telegram.poller,
      fieldDefaultEvent: cfg.telegram.fieldDefaultEvent,
      fieldReelMode: cfg.telegram.fieldReelMode,
    }),
    discord: stripUndef({
      enabled: cfg.discord.enabled,
      botToken: cfg.discord.botToken,
      allowedUsers: [...cfg.discord.allowedUsers],
      homeChannel: cfg.discord.homeChannel,
      chatChannels: cfg.discord.chatChannels ? [...cfg.discord.chatChannels] : undefined,
      testChannel: cfg.discord.testChannel
        ? stripUndef({
            channelId: cfg.discord.testChannel.channelId,
            allowedUsers: cfg.discord.testChannel.allowedUsers
              ? [...cfg.discord.testChannel.allowedUsers] : undefined,
            botToken: cfg.discord.testChannel.botToken,
          })
        : undefined,
    }),
    // ★ finance 직렬화 whitelist 를 스키마 전체와 정합(2026-07-22). 종전엔 enabled/morningNarrative/
    //   autoLoop 3개만 저장 → morningHeatmapImage·dig·kg·replay·conatusNativePort·liveOrders 는 `config set`
    //   후 재읽기에서 드롭(botUsername 모순과 동종). stripUndef 로 미설정 필드는 생략, 설정분은 round-trip.
    finance: stripUndef({
      enabled: cfg.finance.enabled,
      morningNarrative: cfg.finance.morningNarrative,
      morningHeatmapImage: cfg.finance.morningHeatmapImage,
      autoLoop: cfg.finance.autoLoop,
      dig: cfg.finance.dig,
      kg: cfg.finance.kg,
      replay: cfg.finance.replay,
      conatusNativePort: cfg.finance.conatusNativePort,
      secContactEmail: cfg.finance.secContactEmail,
      liveOrders: cfg.finance.liveOrders,
      relaxedGates: cfg.finance.relaxedGates,
    }),
    onboarding: stripUndef({
      webFirst: cfg.onboarding.webFirst,
      ready: cfg.onboarding.ready,
      completed: cfg.onboarding.completed,
      completedAt: cfg.onboarding.completedAt,
      version: cfg.onboarding.version,
    }),
    debug: cfg.debug,
    logs: cfg.logs,
    shell: cfg.shell,
    errorReports: cfg.errorReports ? stripUndef({ ...cfg.errorReports }) : undefined,
    chat: stripUndef({
      fastPath: cfg.chat.fastPath,
      conciseness: stripUndef({
        enabled: cfg.chat.conciseness.enabled,
        finalMessageMaxLines: cfg.chat.conciseness.finalMessageMaxLines,
        preambleMaxWords: cfg.chat.conciseness.preambleMaxWords,
        flatBullets: cfg.chat.conciseness.flatBullets,
      }),
      toolOutput: stripUndef({
        persistOnOverflow: cfg.chat.toolOutput.persistOnOverflow,
        retentionDays: cfg.chat.toolOutput.retentionDays,
        previewLines: cfg.chat.toolOutput.previewLines,
      }),
      autoCompact: stripUndef({
        enabled: cfg.chat.autoCompact.enabled,
        triggerRatio: cfg.chat.autoCompact.triggerRatio,
        preserveLastN: cfg.chat.autoCompact.preserveLastN,
        preserveFirstN: cfg.chat.autoCompact.preserveFirstN,
        partial: cfg.chat.autoCompact.partial,
      }),
      autoCopyQaToClipboard: cfg.chat.autoCopyQaToClipboard,
      systemPrompt: stripUndef({
        overridePath: cfg.chat.systemPrompt.overridePath,
        taskVariant: cfg.chat.systemPrompt.taskVariant,
        forceBuiltinVariant: cfg.chat.systemPrompt.forceBuiltinVariant,
      }),
      rendering: stripUndef({
        streaming: stripUndef({
          mode: chatRendering.streaming.mode,
          catchUpThresholdLines: chatRendering.streaming.catchUpThresholdLines,
          catchUpAgeMs: chatRendering.streaming.catchUpAgeMs,
        }),
        wrap: stripUndef({
          urlAware: chatRendering.wrap.urlAware,
        }),
        tool: stripUndef({
          displayMode: chatRendering.tool.displayMode,
          blockMaxLines: chatRendering.tool.blockMaxLines,
        }),
        diff: stripUndef({
          colorTier: chatRendering.diff.colorTier,
          headerStyle: chatRendering.diff.headerStyle,
          turnBrowserHistory: chatRendering.diff.turnBrowserHistory,
          turnBrowserMode: chatRendering.diff.turnBrowserMode,
        }),
        hud: stripUndef({
          gaugeWarnRatio: chatRendering.hud.gaugeWarnRatio,
          gaugeDangerRatio: chatRendering.hud.gaugeDangerRatio,
        }),
      }),
    }),
    intake: { ...(rawRest.intake && typeof rawRest.intake === 'object' ? rawRest.intake as Record<string, unknown> : {}), ...cfg.intake },
    dashboard: stripUndef({
      views: cfg.dashboard.views,
      theme: cfg.dashboard.theme,
      promptBank: cfg.dashboard.promptBank,
      foldMode: cfg.dashboard.foldMode,
      benchmark: cfg.dashboard.benchmark,
      enableVirtualWindowSwitchKeys: cfg.dashboard.enableVirtualWindowSwitchKeys,
      enableSupplementalGlobalKeys: cfg.dashboard.enableSupplementalGlobalKeys,
    }),
    acp: stripUndef({
      hopCap: stripUndef({
        claude: cfg.acp.hopCap.claude,
        codex: cfg.acp.hopCap.codex,
        gemini: cfg.acp.hopCap.gemini,
        default: cfg.acp.hopCap.default,
      }),
      reviewBackend: cfg.acp.reviewBackend,
      reworkBackend: cfg.acp.reworkBackend,
      binaryPaths: cfg.acp.binaryPaths && Object.keys(cfg.acp.binaryPaths).length > 0
        ? { ...cfg.acp.binaryPaths }
        : undefined,
      slashMaxTurns: cfg.acp.slashMaxTurns,
      editApproval: cfg.acp.editApproval ? true : undefined,
      toolApproval: acpApprovalTimeoutMs(
        (cfg.raw?.acp as { toolApproval?: { timeoutMs?: unknown } } | undefined)?.toolApproval?.timeoutMs,
      ) !== undefined || cfg.acp.toolApproval.timeoutMs !== (acpApprovalTimeoutEnv() ?? ACP_DEFAULTS.toolApproval.timeoutMs)
        ? { timeoutMs: cfg.acp.toolApproval.timeoutMs } : undefined,
      scrubBillingEnv: cfg.acp.scrubBillingEnv === false ? false : undefined,
    }),
    lsp: stripUndef({
      enabled: cfg.lsp.enabled,
      typescript: cfg.lsp.typescript === false ? false : stripUndef({
        command: cfg.lsp.typescript.command,
        args: cfg.lsp.typescript.args ? [...cfg.lsp.typescript.args] : undefined,
        extensions: [...cfg.lsp.typescript.extensions],
      }),
      python: cfg.lsp.python === false ? false : stripUndef({
        command: cfg.lsp.python.command,
        args: cfg.lsp.python.args ? [...cfg.lsp.python.args] : undefined,
        extensions: [...cfg.lsp.python.extensions],
      }),
      rust: cfg.lsp.rust === false ? false : stripUndef({
        command: cfg.lsp.rust.command,
        args: cfg.lsp.rust.args ? [...cfg.lsp.rust.args] : undefined,
        extensions: [...cfg.lsp.rust.extensions],
      }),
      idleTimeoutMs: cfg.lsp.idleTimeoutMs,
      workspaceSymbolLanguage: cfg.lsp.workspaceSymbolLanguage,
    }),
    // VW config now prefers named entries (`iul`, `acp`, `sim`) so
    // registration order in JSON is itself the canonical order.
    ...(() => {
      const order = cfg.vw.order ?? VW_ORDER_DEFAULT;
      const orderedEntries = order.map((name) => {
        const entry = cfg.vw.entries?.[name] ?? VW_ENTRY_DEFAULTS[name];
        const defaults = VW_ENTRY_DEFAULTS[name];
        const value = stripUndef({
          resident: entry.resident !== defaults.resident ? entry.resident : undefined,
          foregroundOnStartup: entry.foregroundOnStartup === true ? true : undefined,
        });
        const preserveForOrder = JSON.stringify(order) !== JSON.stringify(VW_ORDER_DEFAULT);
        return [name, (Object.keys(value).length > 0 || preserveForOrder) ? value : undefined] as const;
      });
      const hasNamedEntries = orderedEntries.some(([, value]) => value !== undefined);
      const hasNames = Object.keys(cfg.vw.windowNames).length > 0 || Object.keys(cfg.vw.paneNames).length > 0;
      if (!hasNamedEntries && !hasNames) return {};
      const named: Record<string, unknown> = {};
      for (const [name, value] of orderedEntries) {
        if (value !== undefined) named[name] = value;
      }
      return {
        vw: {
          ...stripUndef({
            windowNames: Object.keys(cfg.vw.windowNames).length > 0 ? { ...cfg.vw.windowNames } : undefined,
            paneNames: Object.keys(cfg.vw.paneNames).length > 0 ? { ...cfg.vw.paneNames } : undefined,
          }),
          ...named,
        },
      };
    })(),
    // Plan: omit the key entirely when the (single) flag matches the
    // default to keep on-disk JSON minimal for users who don't opt in.
    ...(cfg.plan.autoWorktree ? { plan: { autoWorktree: true } } : {}),
    // Registry (FU A6-real P5 round-trip): only persist non-empty
    // discovery sub-blocks so a clean install's config.json stays
    // free of empty `registry: { discovery: { cron: {}, firecrawl: {} } }`.
    ...(() => {
      const discovery: Record<string, unknown> = {};
      const cron = cfg.registry?.discovery?.cron;
      const firecrawl = cfg.registry?.discovery?.firecrawl;
      if (cron && typeof cron.intervalMs === 'number' && cron.intervalMs > 0) {
        discovery.cron = { intervalMs: cron.intervalMs };
      }
      if (firecrawl && typeof firecrawl.apiKey === 'string' && firecrawl.apiKey.trim().length > 0) {
        discovery.firecrawl = { apiKey: firecrawl.apiKey };
      }
      return Object.keys(discovery).length > 0 ? { registry: { discovery } } : {};
    })(),
    // Phase 2: round-trip NEXUS schema fields when present. omit when
    // unset so a Path-A-only user's file stays clean (no empty global:{}).
    ...(typeof cfg.version === 'number' ? { version: cfg.version } : {}),
    ...(cfg.global && Object.keys(cfg.global).length > 0 ? { global: cfg.global } : {}),
    ...(cfg.tabs && Object.keys(cfg.tabs).length > 0 ? { tabs: cfg.tabs } : {}),
    // M1-2b: sparse — emit only when explicitly set. Keeps Path-A-only
    // users' file clean (no empty modelTier:{} blobs).
    ...(cfg.modelTier ? { modelTier: parseModelTierConfig(cfg.modelTier) } : {}),
    ...(cfg.sessionFabric ? { sessionFabric: cfg.sessionFabric } : {}),
    ...(cfg.nextFluent ? { nextFluent: cfg.nextFluent } : {}),
    ...(cfg.taste ? { taste: cfg.taste } : {}),
    ...(cfg.webSearch ? { webSearch: cfg.webSearch } : {}),
    ...(cfg.design ? { design: cfg.design } : {}),
    ...(cfg.diagnostics?.uploadUrl ? { diagnostics: parseDiagnosticsConfig(cfg.diagnostics) } : {}),
    ...(cfg.budget ? { budget: cfg.budget } : {}),
    ...(cfg.smartDefaults ? { smartDefaults: cfg.smartDefaults } : {}),
    ...(cfg.grounding && cfg.grounding.sources.length > 0
      ? { grounding: { sources: cfg.grounding.sources } }
      : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  // FU3: lock-protected atomic write. Path B's patchUserConfig acquires
  // the same lock so simultaneous writers cannot lose each other's
  // updates. Read phase is NOT inside the lock — callers that need full
  // R-M-W exclusion should re-read inside a withFileLockSync block.
  withFileLockSync(path + '.lock', () => {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
    // Bundle 2' (2026-04-27) · always chmod 600. Was previously gated on
    // `cfg.telegram.botToken` — but the file also contains `llm.apiKey`,
    // future Discord/MCP tokens, and other personal config (skill paths,
    // vault path). Owner-only is the safe default. On Windows chmodSync
    // sets the readonly bit and is best-effort; we suppress errors so a
    // host that rejects the call doesn't block the wizard.
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  });
  cache = cfg;
  cachedPath = path;
  // Phase 4: capture post-write mtime so the next getUserConfig() can
  // distinguish "our own write" (cache valid) from "external writer
  // updated the file behind us" (cache stale · reload).
  cachedMtimeMs = readMtimeMsOrNull(path);
}

// ── VW rename mutators (VW-B3/B4) ────────────────────────────────
//
// Pure setters that return a new UserConfig with one VW entry
// inserted / removed. Callers pair them with saveUserConfig() to
// persist. Passing an empty string removes the override — matches
// the VW registry rule that setPaneTitle('') clears the map entry.

export function setVwWindowName(cfg: UserConfig, spawnTitle: string, next: string | undefined): UserConfig {
  const map = { ...cfg.vw.windowNames };
  const trimmed = (next ?? '').trim();
  if (!trimmed) delete map[spawnTitle];
  else map[spawnTitle] = trimmed;
  return { ...cfg, vw: { ...cfg.vw, windowNames: map } };
}

export function setVwPaneName(cfg: UserConfig, key: string, next: string | undefined): UserConfig {
  const map = { ...cfg.vw.paneNames };
  const trimmed = (next ?? '').trim();
  if (!trimmed) delete map[key];
  else map[key] = trimmed;
  return { ...cfg, vw: { ...cfg.vw, paneNames: map } };
}

/** PLAN-model-intelligence-router · Part B / Phase B4 — pin a concrete
 *  model (and optional provider) as the active LLM selection. Used by the
 *  setup-once cadence: the suggester resolves a model from intent, then
 *  this writes it as a plain pin so subsequent turns behave like a
 *  hand-picked model (no per-turn routing). Pure — caller persists via
 *  `saveUserConfig`. */
export function withLlmModel(
  cfg: UserConfig,
  model: string,
  provider?: LLMProviderName,
): UserConfig {
  const trimmed = (model ?? '').trim();
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      ...(trimmed ? { model: trimmed } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

/** Build the composite key used for pane-name lookups. Kept here
 *  so the VW registry and user-config stay aligned on the format. */
export function vwPaneKey(windowSpawnTitle: string, paneContentTitle: string): string {
  return `${windowSpawnTitle}|${paneContentTitle}`;
}

export function markOnboardingComplete(cfg: UserConfig): UserConfig {
  return {
    ...cfg,
    onboarding: {
      completed: true,
      completedAt: new Date().toISOString(),
      version: ONBOARDING_VERSION,
    },
  };
}

export function currentOnboardingVersion(): number { return ONBOARDING_VERSION; }

// ── Coercion helpers ─────────────────────────────────────────────────

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function positiveIntOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function strArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : fallback;
}

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length > 0 && typeof val === 'string' && val.length > 0) {
      out[k] = val;
    }
  }
  return out;
}

function numArray(v: unknown, fallback: number[]): number[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

function normalizeProvider(v: unknown): LLMProviderName {
  const allowed = CONFIG_LLM_PROVIDER_NAMES;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) {
    return v as LLMProviderName;
  }
  // Phase 2 (RFC #2161 · 2026-05-10) — alias resolution via Layer A
  // catalog (`catalog/providers/*.yaml`). 'claude' → 'anthropic',
  // 'codex' → 'openai-codex' (special case · keep legacy split for the
  // openai-codex switch path; full merge is Phase 4 scope), etc. Only
  // accept registry-resolved id when it lands inside the legacy union
  // — preserves the silent-fallback-to-'auto' contract for typos.
  if (typeof v === 'string' && v.trim()) {
    // Special case: 'codex' alias maps to 'openai' in registry, but the
    // legacy switch path needs 'openai-codex' to dispatch to the Codex
    // adapter. Honor the explicit codex alias as 'openai-codex'.
    const lower = v.trim().toLowerCase();
    if (lower === 'codex') return 'openai-codex';
    try {
      // Lazy import to avoid circular module init order during
      // user-config bootstrap (registry loader reads YAML which sits
      // outside the user-config dependency graph).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { normalizeProviderId } = require('./registry/normalize.js') as {
        normalizeProviderId: (s: string | null | undefined) => string | null;
      };
      const fromRegistry = normalizeProviderId(v);
      if (fromRegistry && (allowed as string[]).includes(fromRegistry)) {
        return fromRegistry as LLMProviderName;
      }
    } catch {
      // Fall through to 'auto' if registry isn't available yet.
    }
  }
  return 'auto';
}

/** Parse the optional `llm.rotation` array from raw JSON into
 *  typed RotationEntry[]. Rejects malformed entries (missing
 *  provider, unknown provider name) so a garbled config can't
 *  crash the runtime — just silently drops bad rows. Returns
 *  undefined when no rotation is configured (preserves the
 *  absence so callers can distinguish "never set up" from
 *  "empty array"). */
/** Validate provider-agnostic reasoning level. Same fault-tolerance
 *  as `parseRotation` / `parseCodexReasoning` — silent drop on
 *  garbage. */
/** ⭐ export 인 이유 — 시험 러너는 config 를 격리해 `getUserConfig()` 경로로는 이 파서를 못 문다(2026-09-23 실측). */
export function parseReasoningLevel(raw: unknown): ReasoningLevel | undefined {
  const allowed = ['off', 'low', 'medium', 'high', 'xhigh'] as const;
  if (typeof raw !== 'string') return undefined;
  return (allowed as readonly string[]).includes(raw) ? raw as ReasoningLevel : undefined;
}

/** Validate Codex Responses API reasoning options. Returns undefined
 *  when the input is missing OR when both fields fail validation —
 *  mirroring `parseRotation`'s "silent drop on garbage" stance so a
 *  malformed config never crashes the LLM stack. */
function parseCodexReasoning(raw: unknown): { effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; summary?: 'auto' | 'concise' | 'detailed' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  // GPT-5.6(sol/terra/luna) — xhigh/max 신규 effort. 하위 모델은 무시(모델이 depth 결정).
  const effortAllowed = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  const summaryAllowed = ['auto', 'concise', 'detailed'] as const;
  const out: { effort?: typeof effortAllowed[number]; summary?: typeof summaryAllowed[number] } = {};
  if (typeof obj.effort === 'string' && (effortAllowed as readonly string[]).includes(obj.effort)) {
    out.effort = obj.effort as typeof effortAllowed[number];
  }
  if (typeof obj.summary === 'string' && (summaryAllowed as readonly string[]).includes(obj.summary)) {
    out.summary = obj.summary as typeof summaryAllowed[number];
  }
  return (out.effort !== undefined || out.summary !== undefined) ? out : undefined;
}

function parseGoalLoop(raw: unknown): { enabled?: boolean; maxIterations?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { enabled?: boolean; maxIterations?: number } = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.maxIterations === 'number' && obj.maxIterations > 0) out.maxIterations = Math.floor(obj.maxIterations);
  return (out.enabled !== undefined || out.maxIterations !== undefined) ? out : undefined;
}

function parseMemoryJudge(raw: unknown): { enabled?: boolean; model?: string; crossRecall?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { enabled?: boolean; model?: string; crossRecall?: boolean } = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.model === 'string' && obj.model.trim()) out.model = obj.model.trim();
  if (typeof obj.crossRecall === 'boolean') out.crossRecall = obj.crossRecall;
  return (out.enabled !== undefined || out.model !== undefined || out.crossRecall !== undefined) ? out : undefined;
}

function parseGeminiServerTools(raw: unknown): { googleSearch?: boolean; codeExecution?: boolean; urlContext?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { googleSearch?: boolean; codeExecution?: boolean; urlContext?: boolean } = {};
  if (obj.googleSearch === true) out.googleSearch = true;
  if (obj.codeExecution === true) out.codeExecution = true;
  if (obj.urlContext === true) out.urlContext = true;
  return (Object.keys(out).length > 0) ? out : undefined;
}

function parseAnswerPriority(raw: unknown): 'cost' | 'balanced' | 'quality' | 'exhaustive' | undefined {
  return raw === 'cost' || raw === 'balanced' || raw === 'quality' || raw === 'exhaustive'
    ? raw
    : undefined;
}

function parseMaxTurnsField(raw: unknown): number | null | undefined {
	  // Tri-state: positive int = explicit cap, null/0 = unlimited,
	  // anything else = field omitted (fall through to answerPriority).
	  if (raw === null || raw === 0) return null;
	  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	  return undefined;
	}

	/** Budget-override keys. Pair of NAMED_MAX_TURNS_FAMILIES in llm.ts —
	 *  adding a name here is what opens `llm.maxTurns.<family>` (incl. 0/null
	 *  = unlimited). Kept as a local const so this file does not import llm.ts
	 *  (hot-path cycle). `default` stays the residual bucket. */
		const MAX_TURNS_BUDGET_KEYS = ['claude', 'codex', 'gemini', 'grok', 'openrouter', 'default'] as const;
		type MaxTurnsBudgetKey = typeof MAX_TURNS_BUDGET_KEYS[number];
		export type MaxTurnsBudget = Partial<Record<MaxTurnsBudgetKey, number | null>>;

	function parseMaxTurnsBudget(raw: unknown): MaxTurnsBudget | undefined {
	  if (!raw || typeof raw !== 'object') return undefined;
	  const obj = raw as Record<string, unknown>;
	  const out: MaxTurnsBudget = {};
	  for (const key of MAX_TURNS_BUDGET_KEYS) {
	    const parsed = parseMaxTurnsField(obj[key]);
	    if (parsed !== undefined) out[key] = parsed;
	  }
	  return Object.keys(out).length > 0 ? out : undefined;
	}

function parseRotation(raw: unknown): RotationEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RotationEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const provider = normalizeProvider(obj.provider);
    // Skip entries that defaulted to 'auto' — usually means the
    // provider field was garbage. A true "auto" rotation entry
    // wouldn't make sense (rotation implies explicit choice).
    if (provider === 'auto' && obj.provider !== 'auto') continue;
    out.push({
      provider,
      model:   str(obj.model),
      apiKey:  str(obj.apiKey),
      baseUrl: str(obj.baseUrl),
      label:   str(obj.label),
    });
  }
  return out.length > 0 ? out : undefined;
}

const MISSION_KINDS: ReadonlyArray<'plan' | 'build' | 'review' | 'research' | 'quick' | 'vision'> = [
  'plan', 'build', 'review', 'research', 'quick', 'vision',
];

function parseMissionRouting(raw: unknown): MissionRoutingConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: MissionRoutingConfig = {};
  if (obj.mode === 'auto' || obj.mode === 'manual') out.mode = obj.mode;
  const missionsRaw = obj.missions;
  if (missionsRaw && typeof missionsRaw === 'object') {
    const missions: MissionRoutingConfig['missions'] = {};
    for (const kind of MISSION_KINDS) {
      const entry = (missionsRaw as Record<string, unknown>)[kind];
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const provider = str(e.provider);
      if (!provider) continue;
      missions[kind] = { provider, model: str(e.model) };
    }
    if (Object.keys(missions).length > 0) out.missions = missions;
  }
  if (out.mode === undefined && out.missions === undefined) return undefined;
  return out;
}

function parseLlmRoutePolicy(raw: unknown): LlmRoutePolicyConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const mode = v.mode === 'codex-first' || v.mode === 'active-provider' ? v.mode : undefined;
  const opusEscalation = v.opusEscalation === 'evidence-hitl' ? v.opusEscalation : undefined;
  return mode || opusEscalation ? { ...(mode ? { mode } : {}), ...(opusEscalation ? { opusEscalation } : {}) } : undefined;
}

function parseAutoRoute(raw: unknown): AutoRouteConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: AutoRouteConfig = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.useClassifierLlm === 'boolean') out.useClassifierLlm = obj.useClassifierLlm;
  if (typeof obj.applyNuance === 'boolean') out.applyNuance = obj.applyNuance;
  if (out.enabled === undefined && out.useClassifierLlm === undefined && out.applyNuance === undefined) {
    return undefined;
  }
  return out;
}

function normalizeSkillSet(v: unknown): SkillSetName {
  return (typeof v === 'string' && (SKILL_SET_NAMES as string[]).includes(v))
    ? v as SkillSetName
    : 'opencode';
}

function stripUndef<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
