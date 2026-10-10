// M2-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 2) —
// LLM tier → model mapping.
//
// Unlike STT (one provider · five model ticks), LLM has many providers
// with their own model families. The 5-tick slider stays provider-
// agnostic — the user picks intent ("more accurate / cheaper / faster"),
// the resolver consults the *active provider* and routes to the
// right model on that provider's ladder.
//
// PLAN §5 example mapping (paraphrased):
//
//   Tier      | Anthropic    | OpenAI       | Gemini      | Local      | Codex (OAuth)
//   --------- | ------------ | ------------ | ----------- | ---------- | ------------
//   budget    | haiku 4.5    | 4o-mini      | flash 2.5   | qwen3.6-7b | codex-mini
//   balanced  | haiku 4.5    | 4o-mini      | flash 2.5   | qwen3.6-7b | gpt-5.4
//   better    | sonnet 4.6   | 4o           | pro 2.5     | glm-4.5-air| gpt-5.4
//   best      | opus 4.7     | o1           | pro thinking| qwen3.6-32b| gpt-5.4 (high)
//   loaded    | opus 4.7 +   | o1 + verbose | pro thinking| qwen3.6-32b| gpt-5.4 (high+
//             | extended     | reasoning    | + multi-turn| + grpo     | extended)
//             | thinking
//
// "loaded" composes the best model with extended/deep reasoning.
// Token cost projection is deferred to Phase 3 (BudgetGuard) — Phase 2
// surfaces tier label + model id + per-turn rationale only.

import type { LLMProviderName, ReasoningLevel } from '../user-config.js';
import type { ModelTier } from './types.js';

export interface LlmTierSpec {
  /** Provider-side model id (forwarded to LLMConfig.model when the
   *  user-config.modelTier.llm override is set). */
  model: string;
  /** Reasoning level the tier prefers. When the provider doesn't
   *  support reasoning, the resolver silently ignores it. */
  reasoningLevel?: ReasoningLevel;
  /** Short label for the slider tooltip. */
  label: string;
  /** One-liner for the active row · informs the user of trade-off. */
  rationale: string;
  /** `shipping` = wired on this provider today · `wip` = pulls a
   *  fallback (e.g. local-ladder tiers require user-installed binaries). */
  status: 'shipping' | 'wip';
}

type TierMap = Readonly<Record<ModelTier, LlmTierSpec>>;

// ── Per-provider tiers ──────────────────────────────────────────────

// Claude 계열 목적별 tier — codex luna/terra/sol 매핑과 동형(2026-07-19 최신 정비):
// haiku=budget(빠름/저렴/대량·분류)·sonnet=balanced/better(기본 워크호스·코딩)·opus=best/loaded
// (심층추론·아키텍처). reasoningLevel 은 4.8/5 계열에서 adaptive thinking effort 로 매핑(off=thinking 생략).
const ANTHROPIC: TierMap = {
  // ⭐ 2026-09-25 (대표 「모델별 최신으로」): best·loaded 를 opus «5.5» 로 — Anthropic `/v1/models` 실측 `claude-opus-5-5`(09-21) ⊕ 실호출 OK.
  //    📏 공식 문서(platform.claude.com opus-5-5) $4/$20 · 1M ctx · 출력 128K — Opus 5($5/$25)보다 «싸다». 캐시 읽기 $0.20 = 입력의 5%(통상 10%).
  //    sonnet 최신 = sonnet-5 · haiku 최신 = haiku-4-5 (같은 목록).
  budget: {
    model: 'claude-haiku-4-5',
    reasoningLevel: 'off',
    label: 'Claude Haiku 4.5',
    rationale: 'Fast · cheap · bulk/classification',
    status: 'shipping',
  },
  balanced: {
    model: 'claude-sonnet-5',
    reasoningLevel: 'off',
    label: 'Claude Sonnet 5',
    rationale: 'Default · fast reliable coding (workhorse)',
    status: 'shipping',
  },
  better: {
    model: 'claude-opus-5-5',
    reasoningLevel: 'medium',
    label: 'Claude Opus 5.5 · thinking medium',
    rationale: '대표 09-25 — 구현(역할 implement = better)은 Opus 5.5',
    status: 'shipping',
  },
  // ⭐ 2026-08-18: opus 최신은 «5.0» 이다(대표 지적 · Anthropic `/v1/models` 실측:
  //    claude-opus-5 · claude-sonnet-5 · claude-fable-5 가 모두 실재). 직전 문면은
  //    claude-opus-4-8 을 최상단으로 알고 있어 «두 세대» 늙어 있었다.
  //    📏 claude-opus-5 = 1M context · $5/$25 (claude-api 레퍼런스 1차).
  best: {
    model: 'claude-opus-5-5',
    reasoningLevel: 'medium',
    label: 'Claude Opus 5.5 · thinking medium',
    rationale: 'Best reasoning · architecture · long-horizon ($4/$20 · 캐시 읽기 $0.20=5%)',
    status: 'shipping',
  },
  loaded: {
    model: 'claude-opus-5-5',
    reasoningLevel: 'high',
    label: 'Claude Opus 5.5 · extended thinking',
    rationale: 'Loaded · deep multi-step · extended thinking',
    status: 'shipping',
  },
};

// ⚠️⭐ 2026-09-23 — ***이 `OPENAI`(API 키) 사다리는 «낡았다». 그러나 이 판에서 안 고쳤다.***
//
// 🩸 경위 — `#19851` 에서 GPT-6 로 옮겼다가 «같은 날 되돌렸다». 이유는 품질이 아니라 «계열»이다:
//    같은 날 `gpt-6-*` 를 `openai-codex` 계열로 확정했고(구독 경로가 실제로 열렸다),
//    그러면 이 사다리가 `gpt-6-sol` 을 가리키는 순간 ***자기 가드가 자기 값을 거부한다***
//    (`isRuntimeLlmModelCompatibleWithProvider('openai','gpt-6-sol') === false`).
//    ⇒ 한 모델을 «두 문»에 동시에 걸 수 없다는 것이 지금 계약이다.
//
// 📌 남은 일(별개 축) — ***`gpt-4o-mini`/`gpt-4o` 는 두 세대 낡았다.***
//    ⊕ ⏰ 공식: *"On **October 14, 2026**, GPT-5.5 will retire from ChatGPT, ChatGPT Work, and
//       Codex on all plans"* — ⚠️ 그 문장은 «API» 를 말하지 «않는다». API 에서도 사라지는지는
//       ***따로 재야 한다***(`curl /v1/models | grep gpt-5.5`). 재기 전엔 내리지 않는다.
//    📄 상세 = `내부 문서 `FINDING-the-tier-ladder-points-at-models-its-own-guard-rejects-2026-09-23``
// ⛔ 2026-09-25 되돌림: #20460 이 이 사다리를 gpt-6-* 로 옮겼는데 `isRuntimeLlmModelCompatibleWithProvider('openai', 'gpt-6-*')` 가 false —
//    다섯 칸이 전부 «자기 provider 로 못 부르는» 모델이 됐다. 09-23 대표 결정(계열 충돌 · model-defaults.test.ts)대로 API 경로는 GPT-6 로 안 옮긴다.
const OPENAI: TierMap = {
  budget: {
    model: 'gpt-4o-mini',
    reasoningLevel: 'off',
    label: 'GPT-4o-mini',
    rationale: 'Fast · cheap (⚠️ 두 세대 낡았다 — 위 머리말 참조)',
    status: 'shipping',
  },
  balanced: {
    model: 'gpt-4o-mini',
    reasoningLevel: 'off',
    label: 'GPT-4o-mini',
    rationale: 'Default · multi-turn (⚠️ 두 세대 낡았다)',
    status: 'shipping',
  },
  better: {
    model: 'gpt-4o',
    reasoningLevel: 'off',
    label: 'GPT-4o',
    rationale: 'Higher quality · multimodal',
    status: 'shipping',
  },
  best: {
    model: 'gpt-5.5',
    reasoningLevel: 'medium',
    label: 'GPT-5.5 · reasoning',
    rationale: 'Best · flagship reasoning (⏰ 2026-10-14 ChatGPT/Work/Codex 은퇴 — API 는 미측정)',
    status: 'shipping',
  },
  loaded: {
    model: 'gpt-5.5-pro',
    reasoningLevel: 'high',
    label: 'GPT-5.5 Pro · reasoning high',
    rationale: 'Loaded · deep multi-step reasoning (⏰ 위와 같음)',
    status: 'shipping',
  },
};

// Gemini 계열 목적별 tier (2026-07-19 flash 최신화·대표 지시). 강한 tier(best/loaded)=3.1-pro ·
// medium/low(budget/balanced/better)=flash 계열(구 gemini-2.5-flash stale 교체). 최신 flash =
// gemini-3.5-flash(워크호스)·gemini-3.1-flash-lite(최속/최저). reasoningLevel = thinkingLevel 매핑.
const GEMINI: TierMap = {
  // ⭐ 2026-09-25 (대표 「모델별 최신으로」): Gemini `models.list` 실측 — flash 최신 3.8(09-02) · flash-lite 최신 3.5(07-21) · pro 는 3.1-pro-preview 가 여전히 최신.
  //    📏 3.8-flash 실호출 OK. 단가(OpenRouter 목록) 3.8-flash $0.75/$3.75 · 3.5-flash-lite $0.3/$2.5.
  budget: {
    model: 'gemini-3.5-flash-lite',
    reasoningLevel: 'off',
    label: 'Gemini 3.5 Flash-Lite',
    rationale: 'Fast · cheap · bulk/classification',
    status: 'shipping',
  },
  // ⭐ 2026-08-18: flash 최신은 «3.7» 이다(대표 지적 · Gemini `/v1beta/models` 실측 —
  //    3.5 · 3.6 · 3.7-flash 가 모두 실재하고 전부 inputTokenLimit=1048576).
  balanced: {
    model: 'gemini-3.8-flash',
    reasoningLevel: 'off',
    label: 'Gemini 3.8 Flash',
    rationale: 'Default · low-latency workhorse (flash)',
    status: 'shipping',
  },
  better: {
    model: 'gemini-3.8-flash',
    reasoningLevel: 'medium',
    label: 'Gemini 3.8 Flash · thinking medium',
    rationale: 'Harder tasks · flash + reasoning (thinkingLevel)',
    status: 'shipping',
  },
  best: {
    model: 'gemini-3.1-pro-preview',
    reasoningLevel: 'medium',
    label: 'Gemini 3.1 Pro · thinking',
    rationale: 'Strong reasoning · larger context',
    status: 'shipping',
  },
  loaded: {
    model: 'gemini-3.1-pro-preview',
    reasoningLevel: 'high',
    label: 'Gemini 3.1 Pro · deep thinking',
    rationale: 'Loaded · deep reasoning · slowest',
    status: 'shipping',
  },
};

// ⭐ 상태 (값이 아니라 «마지막으로 잰 시각»으로 적는다 — 롤아웃은 이 주석보다 빨리 움직인다):
//    2026-09-23  구독 경로가 `gpt-6-sol` 을 400 으로 거부(계정 셋 전부 · `codex debug models` 카탈로그에도 없음)
//                — 공식 문서는 «subject to rollout» · 차단이 아니라 «아직 안 풀림»이었다.
//    2026-09-24  풀렸다 — `codex exec --model gpt-6-sol` 본문 `OK6`(🅕 · 대조군 gpt-5.6-sol `OK56`) ⊕
//                `codex/responses` 에 `gpt-6-sol` 요청 13건 · 400 0건(🅞 로그). 아래 표는 이미 gpt-6 으로 옮겨져 있다.
//
// 📌 ***다시 재는 명령*** (결과를 여기 박지 말고 위 «상태» 줄에 날짜와 함께 한 줄 더한다):
//      $ CODEX_HOME=$HOME/.codex-third codex exec --model gpt-6-sol \
//          --skip-git-repo-check "Reply with exactly: PONG"
//    ⛔⭐ ***`rc` 로 판정하지 마라 — `codex exec` 는 400 에도 `rc=0` 을 낸다.*** 본문을 본다
//       (`PONG` 이면 됨 · `not supported when using Codex` 면 거부). 대조군 모델을 같이 친다.
//
// ⭐ API 키 경로(`OPENAI` 사다리)는 09-23 부터 GPT-6 이었다 — 두 사다리가 한때 달랐던 것은 «경로가 달라서»였다.
//
// ── 아래는 종전 근거 (5.6 계열) ───────────────────────────────────────────────
// GPT-5.6 계열은 effort-ceiling 축의 3 변형(luna→terra→sol·크기/추론 상한 순·2026-07-09
// 출시). elanous-self 튜닝 매트릭스(2026-07-11) 실측: terra=코딩 최적(3 effort 전부 성공·최속·
// 안정)·sol=장기추론(느림·코딩엔 과잉조사)·luna=빠름/저렴.
// ⊕ 2026-09-23 정정: 이 저장소가 가진 5.6 «가격»이 공식과 달랐다(terra 2.5/15 → 실제 2/12 ·
//   sol 5/30 → 실제 4/20). 카탈로그는 고쳤다. 사다리 배치는 그 정정으로 안 바뀐다.
const CODEX: TierMap = {
  budget: {
    model: 'gpt-6-luna',
    reasoningLevel: 'off',
    label: 'GPT-6 Luna',
    rationale: 'Fast · cheap · bulk/mechanical ($0.1/$0.5 — 5.6 Luna 대비 1/10)',
    status: 'shipping',
  },
  balanced: {
    model: 'gpt-6-sol',
    reasoningLevel: 'low',
    label: 'GPT-6 Sol · low',
    rationale: 'Default · 빠른 코딩 (구 gpt-5.6-terra 자리 · 출력이 오히려 싸다 $10<$12)',
    status: 'shipping',
  },
  better: {
    model: 'gpt-6-sol',
    reasoningLevel: 'medium',
    label: 'GPT-6 Sol · medium',
    rationale: '대표 2026-09-23 운영 기본 — 일상 코딩·구현 역할',
    status: 'shipping',
  },
  best: {
    model: 'gpt-6-sol',
    reasoningLevel: 'high',
    label: 'GPT-6 Sol · high',
    rationale: 'Hard reasoning · architecture (⚠️ 여기부터 과잉설계·scope creep 신고가 급증한다)',
    status: 'shipping',
  },
  // ⭐ 2026-09-09: loaded 를 GPT-6 Astra 로 올린다(2026-09-03 출시 · 구독 경로 실측 확인).
  //   effort 는 «medium» 이 기본이다 — 상한은 max 지만 astra 는 ***sol 대비 input 5배·output 5배***라
  //   (2026-09-23 정정: 종전 문면 「terra 대비 4배/3.3배」는 terra 가격을 2.5/15 로 잘못 안 값이었다)
  //   기본을 올리면 사다리 맨 위 칸의 비용이 조용히 곱해진다. 더 깊게 필요하면 그때 올린다
  //   (`llm.codexReasoning.effort` = high/xhigh/max · 상한 판정은 reasoningEffortCeiling).
  // ⛔ 아래 칸들(=일상 코딩 드라이버)은 gpt-6-sol 이다. 여기만 astra 다.
  loaded: {
    model: 'gpt-6-astra',
    reasoningLevel: 'medium',
    label: 'GPT-6 Astra · medium',
    rationale: 'Loaded · frontier reasoning + frontend/computer-use (5x sol cost)',
    status: 'shipping',
  },
};

// ⛔⭐⭐ 2026-08-18 실측 — 이 사다리가 «없는 모델»을 가리키고 있었다.
//   LM Studio 에 실제로 있는 것과 대조하니 qwen3.6-coder-7b · glm-4.5-air · qwen3.6-32b 가
//   «하나도» 없었다. 그리고 ROLE_MODEL_DEFAULTS.implement 가 tier 'better' 라
//   ***구현 역할이 존재하지 않는 glm-4.5-air 를 불렀다.***
//   ⇒ 📌 gemini 축에서 같은 날 잡은 것과 «같은 병»이다(라우터가 카탈로그 밖을 가리킨다).
//
// ⭐ 그래서 이 표의 계약을 바꾼다 — ***「어느 모델이 옳은가」가 아니라 「지금 로딩된 것」***이다.
//   ⛔ 이름을 박으면 늙는다. 그러나 사다리는 값을 가져야 하므로, 값을 두되
//     ***`elanous local models --check` 로 라이브 대조***하게 한다(scripts/check-local-tier-models.ts).
//   📏 2026-08-18 기준 실물: qwen3.8-27b-mlx (256k · MLX · Apple Silicon 최적)
// ✅⭐ 2026-09-23 (대표 ⒜ 결정) — ***값에 `local:` 접두를 붙였다.***
//   🩸 종전엔 `qwen3.8-27b-mlx` 였고, 계열 추론이 «이름»으로 하므로 `startsWith('qwen')` 에 걸려
//      `qwen`(=DashScope 클라우드)으로 판정됐다. 그런데 이것은 LM Studio 로컬 실물이다.
//      ⇒ `isRuntimeLlmModelCompatibleWithProvider('local', …)` 가 «다섯 칸 전부» false 였다.
//   📌 접두 규약은 ***이미 설계돼 있었다*** — `user-config.ts:3621` 이 `local:` 를 읽고,
//      `llm.ts:3300`·`:3333` 이 요청 직전에 벗긴다(그 외 6곳이 접두를 다룬다).
//      즉 만들어져 있는 규약을 이 사다리«만» 안 따르고 있었다.
//   ⛔ 「모델 가문」과 「어디서 도나」는 «직교»다 — 한 필드가 둘을 겸하면 이 병이 재발한다.
const LOCAL: TierMap = {
  budget: {
    model: 'local:qwen3.8-27b-mlx',
    label: 'Qwen 3.8 27B (MLX)',
    rationale: 'Offline · 로컬 단일 실물 · LM Studio',
    status: 'wip',
  },
  balanced: {
    model: 'local:qwen3.8-27b-mlx',
    label: 'Qwen 3.8 27B (MLX)',
    rationale: 'Default local · 256k context',
    status: 'wip',
  },
  better: {
    model: 'local:qwen3.8-27b-mlx',
    label: 'Qwen 3.8 27B (MLX)',
    // ⭐ 구현 역할(ROLE_MODEL_DEFAULTS.implement)이 이 칸을 탄다 — 여기가 「구현부」다.
    rationale: 'Higher quality local · 구현 역할의 기본',
    status: 'wip',
  },
  best: {
    model: 'local:qwen3.8-27b-mlx',
    label: 'Qwen 3.8 27B (MLX)',
    rationale: 'Best local · 현재 로컬에 이보다 큰 실물이 없다',
    status: 'wip',
  },
  loaded: {
    model: 'local:qwen3.8-27b-mlx',
    // ⛔ reasoningLevel 을 'high' 로 두지 않는다 — 2026-08-18 실측: 이 모델의 thinking 은
    //   본문보다 «몇 배» 길고(reasoning 29~360 토큰 vs 본문 28) 변동이 신호를 덮는다.
    //   ⇒ 깊은 추론이 필요하면 호출부가 «명시»한다.
    // ⛔⭐ 그래서 이 칸은 지금 `best` 와 «모델도 설정도 같다». 라벨이 그것을 숨기면 안 된다
    //   (리뷰 must-fix) — 'multi-turn' 이라 쓰면 «없는 동작»을 광고하게 된다.
    //   🔵 로컬에 둘째 실물이 올라오면 그때 이 칸이 갈린다.
    label: 'Qwen 3.8 27B',
    rationale: 'Loaded local · 현재 best 와 동일(로컬 실물이 하나뿐) · 256k',
    status: 'wip',
  },
};

// Kimi · Qwen cloud · GLM cloud — share the cloud-Chinese ladder.
// 🚨⛔⭐⭐ 2026-09-23 — ***이 셋은 「선언」만 돼 있고 «배선되지 않았다».***
//   📏 실측: `getProviderForConfig({llm:{provider:'kimi'}})` → ***throw `unknown provider: kimi`***
//      (qwen · glm 도 같다 · 대조군 grok·openai-codex·gemini·anthropic 은 «생성된다»).
//   🔑 왜 — `llm.ts` 의 provider 생성 switch 에 ***case 가 없다***. 그 switch 끝의 exhaustiveness
//      폴백 주석이 ***이 일을 «예언»했다***:
//        *"Throws so a future provider added to the union without a case here fails loud at first call."*
//      ⇒ union(`LLMProviderName`)에만 더해졌고 «분기»는 안 왔다.
//   ⊕ 그래서 `catalog/providers/` 에도, 모델 레코드에도 없다(`#19880` 이 「구멍 13개」로 세던 것의
//     ***진짜 정체***다 — 카탈로그를 채워도 여전히 던진다).
//   ⛔ 그래서 `status` 를 `'wip'` 로 내린다 — 이 필드의 «자기 정의»가
//     *"`shipping` = wired on this provider today"* 이고, 셋은 wired 가 «아니다».
//   🔲 ***지우거나 구현하는 것은 이 판이 «아니다»*** — ⒜구현 ⒝union 에서 제거 ⒞드러내기 중 ⒞ 만 했다.
//     ⒜⒝ 는 범위가 크고 소유가 갈린다. 자(`provider-wiring-contract.test.ts`)가 그 결정을 기다린다.
const KIMI: TierMap = {
  // ⭐ 2026-09-25: 최신 세대 이름으로(moonshot-v1-* · k2.6 은 낡았다). 공식 목록가 kimi-k3 $3/$15 · 캐시 $0.30. ⚠️ 여전히 wip — 실행은 OpenRouter 경로(OPENROUTER_ROUTE_FOR_WIP_PROVIDER).
  budget:   { model: 'kimi-k3',       label: 'Kimi K3',    rationale: 'Fast · cheap',                     status: 'wip' },
  balanced: { model: 'kimi-k3',      label: 'Kimi K3',   rationale: 'Default',                          status: 'wip' },
  better:   { model: 'kimi-k3',     label: 'Kimi K3',  rationale: 'Higher quality · long context',    status: 'wip' },
  best:     { model: 'kimi-k3',            label: 'Kimi K3',rationale: 'Best · K2.6 flagship',             status: 'wip' },
  loaded:   { model: 'kimi-k3', reasoningLevel: 'high', label: 'Kimi K3 · reasoning high', rationale: 'Loaded · deep multi-step', status: 'wip' },
};

// ⬆️ 위 KIMI 블록 머리말과 «같은 사유» — 선언만 있고 배선이 없다(실측 throw).
const QWEN: TierMap = {
  // ⭐ 2026-09-25: 최신 세대 이름으로(qwen-turbo/plus/max · 3.6 은 낡았다 · OpenRouter 목록 qwen3.8-*). ⚠️ 여전히 wip — 실행은 OpenRouter 경로.
  budget:   { model: 'qwen3.8-flash',         label: 'Qwen3.8 Flash',         rationale: 'Fast · cheap',         status: 'wip' },
  balanced: { model: 'qwen3.8-27b',          label: 'Qwen3.8 27B',          rationale: 'Default',              status: 'wip' },
  better:   { model: 'qwen3.8-max',           label: 'Qwen3.8 Max',           rationale: 'Higher quality',       status: 'wip' },
  best:     { model: 'qwen3.8-max',   label: 'Qwen3.8 Max',  rationale: 'Best · flagship',      status: 'wip' },
  loaded:   { model: 'qwen3.8-max', reasoningLevel: 'high', label: 'Qwen3.8 Max · reasoning high', rationale: 'Loaded · deep multi-step', status: 'wip' },
};

// ⬆️ 위 KIMI 블록 머리말과 «같은 사유» — 선언만 있고 배선이 없다(실측 throw).
const GLM: TierMap = {
  // ⭐ 2026-09-25: 최신 세대 이름으로(glm-4-* · 5.1 은 낡았다 · OpenRouter 목록 glm-5.3*). ⚠️ 여전히 wip — 실행은 OpenRouter 경로.
  budget:   { model: 'glm-5.3-flash',        label: 'GLM 5.3 Flash',         rationale: 'Fast · cheap',        status: 'wip' },
  balanced: { model: 'glm-5.3',          label: 'GLM 5.3',           rationale: 'Default',             status: 'wip' },
  better:   { model: 'glm-5.3',         label: 'GLM 5.3',          rationale: 'Higher quality',      status: 'wip' },
  best:     { model: 'glm-5.3',            label: 'GLM 5.3',  rationale: 'Best · GLM-5.1 flagship', status: 'wip' },
  loaded:   { model: 'glm-5.3', reasoningLevel: 'high', label: 'GLM 5.3 · reasoning high', rationale: 'Loaded · deep multi-step', status: 'wip' },
};

// 2026-07-15 정비 — 구 grok-3 사다리(stale) → grok-4.x 라인업(omni-crawl). catalog/·model-alias 와 정합.
// Grok 계열 목적별 tier (2026-07-19 최신 정비·XAI API authoritative). 구 grok-4-1-fast-* 는
// API 미등재 stale → 4.20/4.3/4.5 계열로 교체. budget=4.20-non-reasoning(빠름·비추론·대장 요청) ·
// balanced=4.20(reasoning 워크호스) · better=4.3(1M ctx·reasoning always-on) · best/loaded=4.5
// (플래그십·코드/agentic·configurable reasoning). grok-code-fast-1 은 코딩전용 별도(tier 외).
// ⭐ 4.6 위주로 재편(대표 지시 2026-08-18) — 상위 셋을 flagship 4.6 의 «effort 사다리»로 통일하고,
//   하위 둘은 최저가 fast 계열로 내린다. 대표 이 정한 캐릭터 배치:
//     골저작 = 4.6            (effort 미지정 ⇒ better = low · 저작은 빠르게)
//     구현   = 4.6 · medium   (= best)
//     리뷰   = 4.6 · high     (= loaded)
//     luna 대응(budget) = fast non-reasoning
// ⛔ 옛 표는 grok-4.20/4.3/4.5 를 실었는데 ***`src/intelligence-map/model-catalog.ts` 에 «없다»***
//   (카탈로그가 싣는 grok 은 `grok-4.6` ⊕ `grok-4-1-fast` 뿐 · 2026-08-18 실측).
//   ⇒ 티어 표가 카탈로그보다 늙어 있었다. 4.6 재편이 그 어긋남도 같이 닫는다.
// 📍 별칭 정본 = model-alias.ts — 'grok'→grok-4.7 · 'grok-fast'→grok-4-1-fast-non-reasoning
// ⭐⭐ 2026-09-22 갱신: ***grok-4.7 이 나왔고 grok CLI 의 «기본»이다***(`grok models` 실측).
//    docs.x.ai 1차: 500k · <200k $2.00/$6.00(캐시 $0.50) · ≥200k $4.00/$12.00 · 컷오프 2026-05.
//    ⇒ better/best/loaded 를 4.7 로 올린다. 4.6 은 카탈로그에 «남기되» 강등한다.
//    ⛔ `grok-4.7-build-fast` 는 CLI 에 있으나 docs 에 «없어» 싣지 않았다(수치 미상).
const GROK: TierMap = {
  // ⭐⭐ 2026-08-18 «1차 자료»로 재편 (대표 지시) — xAI `/v1/models` ⊕ `/v1/language-models`
  //    ⊕ 각 ID 실호출(`/v1/chat/completions`)로 «응답 모델»까지 대조했다.
  // ⛔⭐ 그 대조가 잡은 것: `grok-4-1-fast*` 와 `grok-4` 는 «없는 모델이 아니라»
  //    ***200 OK 로 응답하면서 실제로는 `grok-4.3` 이 도는*** 레거시 별칭이다.
  //    ⇒ 직전 표는 budget 을 `grok-4-1-fast-non-reasoning`($0.20/$0.50)이라 «믿고» 있었지만
  //      실제로는 grok-4.3($1.25/$2.50)이 돌았다 — 6.25배. 200 이라 아무 신호도 없었다.
  //    ⇒ 그래서 이 표는 «실호출로 응답 모델을 확인한 ID»만 쓴다.
  // 📏 가격(=$/1M · `/v1/language-models` 값/10000) · context(omni-crawl grok-web 대조):
  //    grok-4.20-*  $1.25/$2.50 · 2M   |  grok-4.7 · 4.6  $2.00/$6.00 · 500k (<200k 구간)
  budget:   { model: 'grok-4.20-non-reasoning', reasoningLevel: 'off',    label: 'Grok 4.20 (non-reasoning)', rationale: '$1.25/$2.50 · 2M context · bulk/non-reasoning', status: 'shipping' },
  balanced: { model: 'grok-4.20',               reasoningLevel: 'low',    label: 'Grok 4.20 · reasoning low', rationale: '$1.25/$2.50 · 2M context — 저가 워크호스', status: 'shipping' },
  better:   { model: 'grok-4.7',                reasoningLevel: 'medium', label: 'Grok 4.7 · reasoning medium', rationale: 'Flagship 500k · 구현/판정 기본 (2026-09-22 4.7 로 승격)', status: 'shipping' },
  best:     { model: 'grok-4.7',                reasoningLevel: 'high',   label: 'Grok 4.7 · reasoning high',   rationale: 'Flagship 심층 — 골분해·리뷰 (2026-09-22 4.7 로 승격)', status: 'shipping' },
  // ⚠️ loaded 가 best 와 «같다» — grok-4.7 의 reasoning 상한이 high 이기 때문이고, 빈 칸이 아니다.
  //    ⛔ `grok-4.20-multi-agent` 는 후보였으나 실호출이 거부했다:
  //      "Multi Agent requests are not allowed on chat completions" ⇒ 사다리에 넣지 않는다.
  loaded:   { model: 'grok-4.7',                reasoningLevel: 'high',   label: 'Grok 4.7 · reasoning high',   rationale: 'Loaded — 4.7 의 추론 상한이 high 라 best 와 같다', status: 'shipping' },
};

// ── OpenRouter (대표 2026-09-23) ─────────────────────────────────────
//   kimi·qwen·glm 의 «첫 실제 경로». 사다리는 이름 기억이 아니라 ***실물 `/api/v1/models` 사실***로 골랐다
//   (2026-09-23 실측 · 전 칸 `tools`·`reasoning` 지원 · 가격 $/MTok 입력/출력):
//     budget   qwen3.8-flash      0.15/0.47  1M
//     balanced glm-5.3            0.039/4.8  1.05M   ← 기본(OPENROUTER_MODEL)
//     별도 모델 glm-5.3-flash     가격·창 미측정 (0으로 기록하지 않는다)
//   📏 OP 10-10 OpenRouter 실측: GLM-5.3 입력 $0.039/MTok · 출력 $4.8/MTok · 창 1.05M.
//     better   qwen3.8-max-0902   2/6        1M
//     best     kimi-k3            3/15       1.05M
//   ⚠️ GLM 가격 갱신·flash 단가 미측정으로 가격순 주장은 보류한다. 가격·창은 늙는다 — 카탈로그(`openrouter/*` 폴드)가 canonical.
//   `shipping` = «생성된다»(배선 계약). 도구 호출·도구 루프·elanous 실제 프롬프트 3/3 실측(리서치 문서 §9).
//   ⚠️ `loaded` 의 reasoningLevel 은 wire 로 «안» 간다 — 측정상 OpenRouter `reasoning.effort` 를 보내면
//      kimi·glm 이 «덜» 생각한다(필드 없음이 최대). 그래서 옮기지 않았다 — 리서치 문서 §9.
const OPENROUTER: TierMap = {
  budget:   { model: 'openrouter/qwen/qwen3.8-flash',     label: 'Qwen 3.8 Flash (OpenRouter)',   rationale: 'Fast · cheap · 1M ctx',            status: 'shipping' },
  balanced: { model: 'openrouter/z-ai/glm-5.3',           label: 'GLM 5.3 (OpenRouter)',          rationale: 'Default · $0.039/$4.8 per MTok · 1.05M ctx', status: 'shipping' },
  better:   { model: 'openrouter/qwen/qwen3.8-max-0902',  label: 'Qwen 3.8 Max (OpenRouter)',     rationale: 'Higher quality',                   status: 'shipping' },
  best:     { model: 'openrouter/moonshotai/kimi-k3',     label: 'Kimi K3 (OpenRouter)',          rationale: 'Best · Kimi flagship',             status: 'shipping' },
  loaded:   { model: 'openrouter/moonshotai/kimi-k3', reasoningLevel: 'high', label: 'Kimi K3 · reasoning high (OpenRouter)', rationale: 'Loaded · deep multi-step', status: 'shipping' },
};

// ── AWS Bedrock (BEDROCK-PROVIDER · 2026-10-11) ───────────────────
//   ⭐ 판단: ANTHROPIC 사다리의 «추론 수준·역할 배치»를 그대로 두고, 모델은 Bedrock 메시지 엔드포인트에서
//   확인한 5.5 계열 id(`src/llm/bedrock.ts` BEDROCK_MODELS · 출처 platform.claude.com «Claude in Amazon Bedrock»
//   Supported models)로만 채운다. 아래 칸(budget·balanced)은 ANTHROPIC 이 haiku-4-5·sonnet-5 를 쓰지만, 이 PR 이
//   카탈로그에 올린 Bedrock id 는 5.5 셋뿐이라 같은 등급의 5.5(haiku-5-5·sonnet-5-5)로 올렸다.
//   ⛔ bedrock 은 명시 선택 전용 — 이 표는 `--role-llm <role>=bedrock/<tier>` 같은 «명시» 해석에만 쓰인다.
//   ⚠️ status = `wip`: 실 AWS 호출(계정별 5.5 접근 조건)을 아직 안 쟀고, 셋업 키 감지 표(PROVIDER_ENV_SPEC)에도
//      없다(자격이 API 키가 아니라 AWS 체인이라). 첫 실호출 스모크 뒤 `shipping` 으로 올린다.
const BEDROCK: TierMap = {
  budget:   { model: 'anthropic.claude-haiku-5-5',  reasoningLevel: 'off',    label: 'Claude Haiku 5.5 (Bedrock)',  rationale: 'Fast · cheap · bulk/classification', status: 'wip' },
  balanced: { model: 'anthropic.claude-sonnet-5-5', reasoningLevel: 'off',    label: 'Claude Sonnet 5.5 (Bedrock)', rationale: 'Default · everyday coding (BEDROCK_DEFAULT_MODEL)', status: 'wip' },
  better:   { model: 'anthropic.claude-opus-5-5',   reasoningLevel: 'medium', label: 'Claude Opus 5.5 · thinking medium (Bedrock)', rationale: 'ANTHROPIC better 와 같은 배치(구현 = Opus 5.5)', status: 'wip' },
  best:     { model: 'anthropic.claude-opus-5-5',   reasoningLevel: 'medium', label: 'Claude Opus 5.5 · thinking medium (Bedrock)', rationale: 'Best reasoning · architecture', status: 'wip' },
  loaded:   { model: 'anthropic.claude-opus-5-5',   reasoningLevel: 'high',   label: 'Claude Opus 5.5 · extended thinking (Bedrock)', rationale: 'Loaded · deep multi-step', status: 'wip' },
};

/** 가격·창 미측정이라 기존 tier 배치를 바꾸지 않고 명시 모델로만 고르는 칸.
 *  소비 경로 = `lookupOpenRouterModelSpec()` ← `resolveRunFallback()`(openrouter 폴백 판정의 관측·ROUTE 결정). */
const OPENROUTER_EXPLICIT_MODELS: Readonly<Record<string, LlmTierSpec>> = {
  'z-ai/glm-5.3-flash': {
    model: 'openrouter/z-ai/glm-5.3-flash',
    label: 'GLM 5.3 Flash (OpenRouter)',
    rationale: 'Fast · 가격/창 미측정',
    status: 'shipping',
  },
};

// ── Combined lookup ─────────────────────────────────────────────────

/** Subset of LLMProviderName that has a tier ladder defined here.
 *  'auto' resolves at runtime to one of the concrete providers, so
 *  the tier resolver expands it via the user's active provider rotation. */
export type LlmTierProvider = Exclude<LLMProviderName, 'auto'>;

export const LLM_TIER_MAP_BY_PROVIDER: Readonly<Record<LlmTierProvider, TierMap>> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  gemini: GEMINI,
  'openai-codex': CODEX,
  local: LOCAL,
  kimi: KIMI,
  qwen: QWEN,
  glm: GLM,
  grok: GROK,
  openrouter: OPENROUTER,
  bedrock: BEDROCK,
} as const;

/** 사람이 쓰는 tier 별칭 → canonical ModelTier. "grok low tier" 같은 자연어 헷갈림을 SSOT 로 흡수한다.
 *  low=budget · mid/medium=better · high=best · max=loaded (+ canonical 이름은 그대로 통과). */
const TIER_ALIASES: Readonly<Record<string, ModelTier>> = {
  budget: 'budget', low: 'budget', cheap: 'budget', fast: 'budget', mini: 'budget', nano: 'budget',
  balanced: 'balanced', default: 'balanced', mid: 'better', medium: 'better', better: 'better', hard: 'better',
  best: 'best', high: 'best', strong: 'best', flagship: 'best',
  loaded: 'loaded', max: 'loaded', deep: 'loaded', maxi: 'loaded',
};

/** tier 인자(별칭 허용·대소문자 무관)를 canonical ModelTier 로. 못 알아보면 undefined. */
export function parseTierArg(raw: string): ModelTier | undefined {
  return TIER_ALIASES[raw.trim().toLowerCase()];
}

/** SSOT 조회에 쓸 수 있는 provider 이름 집합(tier ladder 가 정의된 것).
 *  ⛔ 순서는 표시용이라 손으로 적지만, «집합»은 `LLM_TIER_MAP_BY_PROVIDER` 키와 같아야 한다 —
 *  tsc 는 배열 누락을 못 잡는다(2026-09-23 `#19900` 이 `openrouter` 를 빠뜨려 배선 계약 자가 그것을
 *  한 번도 누르지 않았다). 자 = `provider-wiring-contract.test.ts`. */
export const TIER_PROVIDERS: readonly LlmTierProvider[] = [
  'anthropic', 'openai', 'openai-codex', 'gemini', 'grok', 'local', 'kimi', 'qwen', 'glm', 'openrouter', 'bedrock',
];

/** OpenRouter 모델 id(`openrouter/<vendor>/<model>` 또는 `<vendor>/<model>`)의 tier-map 칸.
 *  명시 칸(`glm-5.3-flash` 등) → 5-tier 사다리 순으로 찾는다. 모르면 undefined(«미등록»을 기본값으로 접지 않는다). */
export function lookupOpenRouterModelSpec(model: string): LlmTierSpec | undefined {
  const bare = model.trim().replace(/^openrouter\//, '');
  if (!bare) return undefined;
  const explicit = OPENROUTER_EXPLICIT_MODELS[bare];
  if (explicit) return explicit;
  const wanted = `openrouter/${bare}`;
  for (const tier of ['budget', 'balanced', 'better', 'best'] as const) {
    if (OPENROUTER[tier].model === wanted) return OPENROUTER[tier];
  }
  return undefined;
}

/** Resolve the spec for (provider, tier).
 *  `auto` and unknown providers have no concrete provider ladder, so both use
 *  Anthropic's balanced default instead of crossing into the Codex family.
 *  Existing execution path: src/llm/model-defaults.ts tierModel() calls this
 *  function to fill the active provider's model at runtime. Explicit providers
 *  keep their own ladders; CLI catalog commands reject unknown/'auto' directly. */
export function lookupLlmTierSpec(
  provider: LLMProviderName,
  tier: ModelTier,
): LlmTierSpec {
  if (provider === 'auto') {
    return ANTHROPIC.balanced;
  }
  const map = LLM_TIER_MAP_BY_PROVIDER[provider];
  if (!map) return ANTHROPIC.balanced;
  return map[tier];
}
