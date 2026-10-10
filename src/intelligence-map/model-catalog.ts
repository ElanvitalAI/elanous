// ── PFC-S5 P1: model catalog ──
//
// Single JSON file at ~/.elanous/models.json. Loader uses a three-step
// cascade:
//   1. ELANOUS_MODELS_JSON env override
//   2. <home>/.elanous/models.json
//   3. BUILTIN_CATALOG (always safe fallback)
//
// Discovery filters builtin by env vars so an operator missing an API
// key doesn't see phantom models in IntelligenceMap results.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelCatalog, ModelEntry } from './types.js';

// 2026-05-03 snapshot — added Kimi (Moonshot) / Qwen 3.6 (Alibaba) /
// GLM 5.x (Zhipu) families. Open-weight vs cloud-only is captured by
// the new `openWeight` / `localPullable` fields on ModelEntry. Local
// hardware budget references — M3 Ultra 512GB unified / M5 Max 128GB
// unified — drive the per-model `minRamGb` gating.

export const BUILTIN_CATALOG: ModelCatalog = {
  version: 1,
  updated: Date.UTC(2026, 4, 3),    // 2026-05-03 snapshot timestamp
  models: [
    {
      // ⭐ 2026-09-25 (대표 「모델별 최신으로」) — opus 최신은 «5.5»(`claude-opus-5-5` · 09-21). `/v1/models` 실측 ⊕ 실호출 OK.
      //    📏 공식 $4/$20 · 1M ctx · 출력 128K (Opus 5 보다 싸다).
      id: 'claude-opus-5-5',
      provider: 'anthropic',
      family: 'claude',
      contextWindow: 1_000_000,
      inputPerMtok: 4,
      outputPerMtok: 20,
      local: false,
      tags: ['reasoning', 'coding', 'agentic', 'long-context'],
      bestFor: ['complex-architecture', 'multi-file-edit', 'deep-analysis'],
      envKey: 'ANTHROPIC_API_KEY',
      reservedOutputTokens: 16_000,
      reasoningEffortCeiling: 'high',
    },
    {
      // ⭐ 2026-08-18 신규 — opus 최신은 «5.0» 이다(대표 지적). Anthropic `/v1/models`
      //    실호출로 claude-opus-5 · claude-fable-5 실재 확인. 값은 claude-api 1차.
      id: 'claude-opus-5',
      provider: 'anthropic',
      family: 'claude',
      contextWindow: 1_000_000,
      inputPerMtok: 5,
      outputPerMtok: 25,
      local: false,
      tags: ['reasoning', 'coding', 'agentic', 'long-context'],
      bestFor: ['complex-architecture', 'multi-file-edit', 'deep-analysis'],
      envKey: 'ANTHROPIC_API_KEY',
      reservedOutputTokens: 16_000,
      reasoningEffortCeiling: 'high',
    },
    {
      // Opus 4.8 (2026-05-28) — 정직성/신뢰성 강화(4.7 대비 flaw 통과 ~4배↓).
      // ⛔ 2026-08-18 정정: pricing 이 «$15/$75» 로 적혀 있었으나 1차값은 $5/$25 다(3배 과대).
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      family: 'claude',
      contextWindow: 1_000_000,
      inputPerMtok: 5,
      outputPerMtok: 25,
      local: false,
      tags: ['reasoning', 'coding', 'long-context'],
      bestFor: ['complex-architecture', 'multi-file-edit', 'deep-analysis'],
      envKey: 'ANTHROPIC_API_KEY',
      reservedOutputTokens: 16_000,
      reasoningEffortCeiling: 'high',  // adaptive thinking (output_config.effort low/med/high)
    },
    {
      // Sonnet 5 (2026-06-30·omni-crawl 검증) — Sonnet 4.6 후속·최고 에이전틱
      // Sonnet(SWE-bench Pro 63.2%·Opus 4.8 근접). pricing sonnet-tier 표준
      // $3/$15(런치 인트로 $2/$10 ~08-31, 만료성이라 표준값 채택).
      id: 'claude-sonnet-5',
      provider: 'anthropic',
      family: 'claude',
      // ⛔ 2026-08-18 정정: 200_000 은 낡은 값 — Sonnet 5 는 1M context 다(claude-api 1차).
      contextWindow: 1_000_000,
      inputPerMtok: 3,
      outputPerMtok: 15,
      local: false,
      tags: ['reasoning', 'coding', 'balanced'],
      bestFor: ['daily-coding', 'multi-turn-chat', 'summarization'],
      envKey: 'ANTHROPIC_API_KEY',
      reservedOutputTokens: 8_000,
      reasoningEffortCeiling: 'high',  // adaptive thinking (sonnet-5 workhorse)
    },
    {
      id: 'claude-haiku-4-5',
      provider: 'anthropic',
      family: 'claude',
      // ⛔ 2026-08-18 정정: $0.8/$4 는 낡은 값 — 1차값은 $1.00/$5.00 이다(claude-api 레퍼런스).
      contextWindow: 200_000,
      inputPerMtok: 1,
      outputPerMtok: 5,
      local: false,
      tags: ['classification', 'summarization', 'cheap', 'fast'],
      bestFor: ['classification', 'routing', 'bulk-summarization'],
      envKey: 'ANTHROPIC_API_KEY',
      reasoningEffortCeiling: 'low',  // 빠른 budget tier — 경량 추론
    },
    {
      id: 'gpt-4o',
      provider: 'openai',
      family: 'gpt-4o',
      contextWindow: 128_000,
      inputPerMtok: 2.5,
      outputPerMtok: 10,
      local: false,
      tags: ['reasoning', 'coding', 'vision'],
      bestFor: ['multimodal', 'json-mode', 'daily-coding'],
      envKey: 'OPENAI_API_KEY',
      reservedOutputTokens: 8_000,
    },
    {
      id: 'gpt-4o-mini',
      provider: 'openai',
      family: 'gpt-4o',
      contextWindow: 128_000,
      inputPerMtok: 0.15,
      outputPerMtok: 0.6,
      local: false,
      tags: ['classification', 'summarization', 'cheap'],
      bestFor: ['bulk-classification', 'cheap-summarization'],
      envKey: 'OPENAI_API_KEY',
    },
    // ⭐⭐ GPT-6 Astra (2026-09-03 출시) — 현 OpenAI 최상단. 수치는 2026-09-09 라이브 1차 대조:
    //   developers.openai.com/api/내부 문서 `gpt-6-astra` (컨텍스트·effort·컷오프) ⊕
    //   openai.com/api/pricing/ (Input $10 · Cached $1 · Output $50 · Cache write $12.5).
    // ⛔ 값싼 모델이 아니다 — terra 대비 input 4배 · output 3.3배. 기본 코딩 드라이버를 바꾸지
    //   않고 «천장»으로만 둔다(llm-tier-map CODEX.loaded). 프런트엔드/복합 과제에 골라 쓴다.
    // ⚠️ 272K 초과 프롬프트는 input·cache 2배, output 1.5배로 «요청 전체»가 재과금된다.
    //   1.05M 컨텍스트를 채우는 것은 「크게 쓸 수 있다」가 아니라 「비싸진다」는 뜻이다.
    // ✅ 구독(Codex CLI) 경로 실측 2026-09-09: `codex exec --model gpt-6-astra` 가 응답했다.
    {
      id: 'gpt-6-astra',
      provider: 'openai-codex',
      family: 'gpt-6',
      contextWindow: 1_050_000,
      inputPerMtok: 10,
      outputPerMtok: 50,
      local: false,
      tags: ['reasoning', 'coding', 'agentic', 'frontier', 'long-context', 'computer-use'],
      bestFor: ['frontend-implementation', 'complex-architecture', 'long-horizon-agentic', 'computer-use'],
      reservedOutputTokens: 16_000,
      tier: 'loaded',
      reasoningEffortCeiling: 'max',
      releasedAt: '2026-09-03',
      classification: { source: 'builtin', at: '2026-09-09' },
      notes: 'effort low/medium/high/xhigh/max · 1.05M ctx(입력 상한 922K · 출력 128K) · 컷오프 2026-04-30. elanous 기본 effort=medium(비용) — 올리려면 llm.codexReasoning.effort.',
    },
    // ⭐⭐ GPT-6 Sol / Luna (2026-09-22 출시) — 🔑 ***중간 등급이 «접혔다»***.
    // ✅⭐⭐ 2026-09-23 — ***구독(ChatGPT 계정) 경로가 «열렸다». 막고 있던 것은 CLI 판이었다.***
    //   04:0x 에 `codex-cli 0.154.0` 으로 재니 셋 다 400 이었다:
    //     ERROR 400 "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."
    //   대표 이 `codex update` 를 치자(→ **0.155.1**) ***같은 계정·같은 명령이 곧바로 응답했다.***
    //     sol ✅ · luna ✅ · astra ✅ · 5.6-terra ✅ · (대조군) 없는 `gpt-6-terra` ❌ 400 ⇒ 탐침 생존
    //   ⊕ `codex debug models` 카탈로그에도 gpt-6-sol · gpt-6-luna 가 «생겼다».
    //   🔑 그래서 provider 는 `openai-codex` 다 — 운영이 타는 문이 거기다(대표 2026-09-23 기본값 지정).
    //   ⛔ ***「계정이 막혔다」가 아니라 「내 클라이언트가 낡았다」였다*** — 다음에 400 을 보면
    //      계정을 의심하기 «전»에 `codex --version` 을 본다.
    {
      id: 'gpt-6-sol',
      provider: 'openai-codex',
      family: 'gpt-6',
      contextWindow: 1_050_000,
      inputPerMtok: 2,
      outputPerMtok: 10,
      local: false,
      tags: ['coding', 'reasoning', 'agentic', 'balanced', 'long-context'],
      bestFor: ['daily-coding', 'multi-file-edit', 'autonomous-implementation', 'complex-architecture'],
      reservedOutputTokens: 12_000,
      tier: 'better',
      variantOf: 'gpt-6',
      effortAxis: 'sol',
      reasoningEffortCeiling: 'max',
      releasedAt: '2026-09-22',
      classification: { source: 'builtin', at: '2026-09-23' },
      notes: '대표 2026-09-23 운영 기본(medium) — 구 gpt-5.6-terra 대체. 구독·API 둘 다 확인. effort none/low/medium(기본)/high/xhigh/max · 1.05M ctx(입력 922K · 출력 128K) · 컷오프 2026-04-20. ⚠️ 272K 초과 프롬프트는 input·cache 2배 · output 1.5배로 «요청 전체»가 재과금된다.',
    },
    {
      id: 'gpt-6-luna',
      provider: 'openai-codex',
      family: 'gpt-6',
      contextWindow: 1_050_000,
      inputPerMtok: 0.1,
      outputPerMtok: 0.5,
      local: false,
      tags: ['cheap', 'fast', 'classification', 'agentic', 'long-context'],
      bestFor: ['bulk-tasks', 'cheap-assistance', 'simple-agentic', 'high-volume'],
      reservedOutputTokens: 8_000,
      tier: 'budget',
      variantOf: 'gpt-6',
      effortAxis: 'luna',
      reasoningEffortCeiling: 'max',
      releasedAt: '2026-09-22',
      classification: { source: 'builtin', at: '2026-09-23' },
      notes: '가장 싼 칸 — 5.6 Luna 대비 input 1/10 · output 1/12 인데 추론은 «High». effort none..max(기본 medium) · 컷오프 2026-05-18.',
    },
    // GPT-5.6 계열(2026-07-09 출시) — effort-ceiling 축의 3 변형(luna→terra→sol).
    // elanous-self 튜닝 매트릭스(2026-07-11) 실측 tier 매핑: luna=budget · terra=balanced/better
    // (코딩 sweet spot) · sol=best/loaded(장기추론). ChatGPT/Codex 구독 엔드포인트.
    {
      id: 'gpt-5.6-terra',
      provider: 'openai-codex',
      family: 'gpt-5.6',
      contextWindow: 1_050_000,
      inputPerMtok: 2,
      outputPerMtok: 12,
      local: false,
      tags: ['coding', 'reasoning', 'agentic', 'balanced'],
      bestFor: ['daily-coding', 'multi-file-edit', 'autonomous-implementation'],
      reservedOutputTokens: 12_000,
      tier: 'balanced',
      variantOf: 'gpt-5.6',
      effortAxis: 'terra',
      // ✅ 2026-09-23 — ***실측으로 고쳤다. 종전 'high' 는 틀린 값이었다.***
      //   🩸 내 1차 판은 «문서만 읽고» 물러선 것이었고 대표 이 *"제대로 탐침을 못한 것 같다"* 고
      //      지적해 다시 쟀다. 실제로 각 effort 를 «먹여» 봤다:
      //        codex exec -c model_reasoning_effort=<E> --model gpt-5.6-terra "…"
      //        low ✅ medium ✅ high ✅ xhigh ✅ max ✅ · (대조군) bogus ❌ ⇒ 탐침 생존
      //   ⛔ 종전 주석이 든 근거(*"예: terra 에 xhigh 금지"*)가 ***실측에 반증됐다.***
      //   ⚠️ 비용 제어가 필요하면 이 필드가 아니라 `llm.codexReasoning.effort` 로 한다 —
      //      「능력 상한」과 「우리가 쓰는 값」은 «다른 축»이고, 섞으면 능력 기술이 거짓이 된다.
      reasoningEffortCeiling: 'max',
      releasedAt: '2026-07-09',
      classification: { source: 'builtin', at: '2026-07-11' },
      notes: 'codex 계열 코딩 최적(3 effort 전부 성공·최속·안정) — elanous-self 자율구현 기본',
    },
    {
      id: 'gpt-5.6-sol',
      provider: 'openai-codex',
      family: 'gpt-5.6',
      contextWindow: 1_050_000,
      inputPerMtok: 4,
      outputPerMtok: 20,
      local: false,
      tags: ['reasoning', 'coding', 'long-context', 'frontier'],
      bestFor: ['complex-architecture', 'deep-analysis', 'long-horizon-agentic'],
      reservedOutputTokens: 16_000,
      tier: 'best',
      variantOf: 'gpt-5.6',
      effortAxis: 'sol',
      reasoningEffortCeiling: 'max',
      releasedAt: '2026-07-09',
      classification: { source: 'builtin', at: '2026-07-11' },
      notes: 'frontier 추론(max effort 지원). 순수코딩은 terra 대비 과잉조사·느림 — 심층추론용',
    },
    {
      id: 'gpt-5.6-luna',
      provider: 'openai-codex',
      family: 'gpt-5.6',
      contextWindow: 1_000_000,
      inputPerMtok: 1,
      outputPerMtok: 6,
      local: false,
      tags: ['cheap', 'fast', 'classification', 'agentic'],
      bestFor: ['bulk-tasks', 'cheap-assistance', 'simple-agentic'],
      reservedOutputTokens: 8_000,
      tier: 'budget',
      variantOf: 'gpt-5.6',
      effortAxis: 'luna',
      reasoningEffortCeiling: 'max',   // ✅ 2026-09-23 실측 — low~max 전부 응답(종전 'low' 는 틀렸다)
      releasedAt: '2026-07-09',
      classification: { source: 'builtin', at: '2026-07-11' },
      notes: '가장 빠르고 저렴 — bulk/mechanical',
    },
    {
      // ⭐⭐ xAI 최신 flagship. docs.x.ai 1차 (2026-09-22):
      //    Context 500k · <200k $2.00/$6.00 (캐시 $0.50) · 지식 컷오프 2026-05.
      // ⚠️ ***가격이 «구간»으로 갈린다*** — ≥200k 는 $4.00/$12.00. 이 칸은 «<200k» 다.
      // 📏 grok CLI 의 기본 모델이기도 하다(`grok models` 실측: `* grok-4.7 (default)`).
      id: 'grok-4.7',
      provider: 'grok',
      family: 'grok',
      contextWindow: 500_000,
      inputPerMtok: 2,
      outputPerMtok: 6,
      local: false,
      tags: ['reasoning', 'coding', 'agentic', 'long-context'],
      bestFor: ['coding', 'agentic-tool-calling'],
      envKey: 'GROK_API_KEY',
      reservedOutputTokens: 8_000,
    },
    {
      // ⭐ xAI flagship (2026-08-12 GA) — ⬇️ 2026-09-22 에 4.7 이 나와 강등. 수치는 docs.x.ai 1차:
      //    Context 500k · Input $2.00/1M · Output $6.00/1M · reasoning=Configurable.
      // ⚠️ 4.5 는 2M 이었는데 4.6 은 «500k 로 줄었다» — 오타가 아니다.
      id: 'grok-4.6',
      provider: 'grok',
      family: 'grok',
      contextWindow: 500_000,
      inputPerMtok: 2,
      outputPerMtok: 6,
      local: false,
      tags: ['reasoning', 'coding', 'agentic', 'long-context'],
      bestFor: ['coding', 'agentic-tool-calling'],
      envKey: 'GROK_API_KEY',
      reservedOutputTokens: 8_000,
    },
    {
      // ✅ 2026-08-18: 위 「두 카탈로그가 어긋난다」는 ***해소됐다*** — 어느 쪽도 맞지 않았다.
      //    `grok-4-1-fast` 는 xAI 에서 200 OK 로 응답하지만 «실제로는 grok-4.3 이 도는»
      //    레거시 별칭이었다(`/v1/models` 부재 ⊕ 실호출의 응답 model 필드로 확인).
      //    ⇒ 그 자리를 실물 장문 모델로 바꾼다. 값은 `/v1/language-models` 1차.
      id: 'grok-4.20',
      provider: 'grok',
      family: 'grok',
      contextWindow: 2_000_000,
      inputPerMtok: 1.25,
      outputPerMtok: 2.5,
      local: false,
      tags: ['reasoning', 'long-context', 'search'],
      bestFor: ['web-search', 'long-context-qa'],
      envKey: 'GROK_API_KEY',
      reservedOutputTokens: 8_000,
    },
    {
      id: 'gemini-2.5-flash',
      provider: 'gemini',
      family: 'gemini',
      contextWindow: 1_000_000,
      inputPerMtok: 0.3,
      outputPerMtok: 2.5,
      local: false,
      tags: ['classification', 'summarization', 'long-context', 'cheap'],
      bestFor: ['long-context-summarization', 'cheap-qa'],
      envKey: 'GEMINI_API_KEY',
      reservedOutputTokens: 8_000,
    },
    {
      id: 'qwen2.5-coder:32b',
      provider: 'ollama',
      family: 'qwen',
      sizeB: 32,
      contextWindow: 128_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      tags: ['coding', 'local', 'fast'],
      bestFor: ['bulk-refactor', 'boilerplate', 'no-network'],
      minRamGb: 24,
    },
    {
      id: 'llama3:70b',
      provider: 'ollama',
      family: 'llama',
      sizeB: 70,
      contextWindow: 8_192,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      tags: ['reasoning', 'local'],
      bestFor: ['offline-reasoning', 'privacy-sensitive'],
      minRamGb: 48,
    },

    // ── Kimi (Moonshot) · `api.moonshot.cn` · OpenAI-compatible ────────
    // K2.6 (2026-04-20) is the current flagship. K3 is WIP — not
    // released as of 2026-05-03. All K2-class weights are 1T MoE / 32B
    // active under Modified MIT (commercial OK; >100M MAU or >$20M MRR
    // must show "Powered by Kimi K2.6"). The 1T weights compress to
    // ~540GB at Q4 — borderline even on M3 Ultra 512GB; we mark them
    // cloud-only-practical via `localPullable: false`.
    {
      id: 'kimi-k2.6',
      provider: 'kimi',
      family: 'kimi',
      contextWindow: 256_000,
      inputPerMtok: 0.91,
      outputPerMtok: 3.78,
      local: false,
      openWeight: true,
      localPullable: false,
      tags: ['reasoning', 'coding', 'vision', 'agentic', 'flagship', 'long-context', 'multimodal'],
      bestFor: ['agentic-coding', 'vision-qa', 'frontier'],
      envKey: 'KIMI_API_KEY',
      huggingFaceRepo: 'moonshotai/Kimi-K2.6',
      reservedOutputTokens: 16_000,
      notes: 'Modified MIT · 1T/32B MoE · weights ~540GB Q4 (M3 Ultra borderline)',
    },
    {
      id: 'kimi-k2.5',
      provider: 'kimi',
      family: 'kimi',
      contextWindow: 256_000,
      inputPerMtok: 0.56,
      outputPerMtok: 2.94,
      local: false,
      openWeight: true,
      localPullable: false,
      tags: ['reasoning', 'coding', 'vision', 'agentic'],
      bestFor: ['agentic-tasks', 'cheap-frontier'],
      envKey: 'KIMI_API_KEY',
      huggingFaceRepo: 'moonshotai/Kimi-K2.5',
      notes: 'Modified MIT · 1T/32B MoE',
    },
    {
      id: 'kimi-latest',
      provider: 'kimi',
      family: 'kimi',
      contextWindow: 256_000,
      inputPerMtok: 0.91,
      outputPerMtok: 3.78,
      local: false,
      openWeight: false,
      tags: ['reasoning', 'rolling', 'agentic'],
      bestFor: ['production-stable'],
      envKey: 'KIMI_API_KEY',
      notes: 'Rolling alias — currently Kimi-K2.6',
    },
    {
      id: 'kimi-vl-a3b-instruct',
      provider: 'ollama',
      family: 'kimi',
      sizeB: 16,
      contextWindow: 128_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['vision', 'local', 'small', 'agentic', 'multimodal'],
      bestFor: ['offline-vision', 'low-vram-vqa'],
      minRamGb: 14,
      huggingFaceRepo: 'moonshotai/Kimi-VL-A3B-Instruct',
      mlxRepo: 'mlx-community/Kimi-VL-A3B-Instruct-4bit',
      notes: 'Modified MIT · 16B/3B MoE vision · M5 Max OK',
    },

    // ── Qwen 3.6 (Alibaba) · DashScope intl `dashscope-intl.aliyuncs.com`
    // Apache 2.0 open-weight family. Qwen3.6 (2026-04) is the current
    // open release. `qwen3.6-flash` is the API alias for the open-weight
    // 35B-A3B MoE — exposed both as cloud (`qwen` provider) and local
    // (`ollama` provider with same `huggingFaceRepo`).
    {
      id: 'qwen3.6-max-preview',
      provider: 'qwen',
      family: 'qwen',
      contextWindow: 262_000,
      inputPerMtok: 1.30,
      outputPerMtok: 7.80,
      local: false,
      openWeight: false,
      tags: ['reasoning', 'coding', 'agentic', 'flagship'],
      bestFor: ['frontier-coding', 'tool-use'],
      envKey: 'DASHSCOPE_API_KEY',
      reservedOutputTokens: 16_000,
      notes: 'DashScope intl · flagship preview · closed weights',
    },
    {
      id: 'qwen3.6-plus',
      provider: 'qwen',
      family: 'qwen',
      contextWindow: 1_000_000,
      inputPerMtok: 0.50,
      outputPerMtok: 3.00,
      local: false,
      openWeight: false,
      tags: ['reasoning', 'long-context', 'multimodal', 'agentic'],
      bestFor: ['1M-context-qa', 'vibe-coding'],
      envKey: 'DASHSCOPE_API_KEY',
      notes: 'DashScope intl · 1M ctx · multimodal',
    },
    {
      id: 'qwen3.6-flash',
      provider: 'qwen',
      family: 'qwen',
      contextWindow: 256_000,
      inputPerMtok: 0.20,
      outputPerMtok: 1.00,
      local: false,
      openWeight: true,
      localPullable: true,
      tags: ['cheap', 'agentic', 'multimodal', 'moe', 'coding'],
      bestFor: ['cheap-multimodal', 'daily-coding'],
      envKey: 'DASHSCOPE_API_KEY',
      huggingFaceRepo: 'Qwen/Qwen3.6-35B-A3B',
      mlxRepo: 'mlx-community/Qwen3.6-35B-A3B-4bit',
      notes: 'API alias for 35B-A3B open-weight — pull via Ollama qwen3.6:35b-a3b',
    },
    // Local-served qwen3.6 35B-A3B MoE (unsloth dynamic Q4 MLX). The
    // `qwen3.6-flash` entry above is the *cloud* alias for the same
    // open-weight family; this entry is the recipe for serving it on a
    // 64GB+ Apple Silicon box via LM Studio. The probe (lmstudio v0
    // endpoint) fills `loaded` / `capabilities` at runtime — the
    // catalog provides the offline hints (size, context, hardware
    // floor) so the wizard can suggest it even before LM Studio is up.
    // Loaded context defaults to 131K on M-class hosts (LM Studio
    // chooses based on free RAM); the 256K theoretical max is in the
    // contextWindow field for the cost/auto-compact gating.
    {
      id: 'qwen3.6-35b-a3b-ud-mlx',
      provider: 'local',
      family: 'qwen',
      sizeB: 35,
      contextWindow: 262_144,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      minRamGb: 22,
      tags: ['local', 'reasoning', 'agentic', 'tool-use', 'mlx', 'moe'],
      bestFor: ['local-coding', 'local-analysis', 'local-debugging', 'tool-use'],
      mlxRepo: 'unsloth/Qwen3.6-35B-A3B-Instruct-UD-Q4-MLX',
      huggingFaceRepo: 'unsloth/Qwen3.6-35B-A3B-Instruct',
      reservedOutputTokens: 8_000,
      notes:
        'unsloth UD Q4 MLX · 35B-A3B MoE · A3B = 3.5B active params, '
        + 'ships native tool_use + reasoning_content. Use spec: '
        + 'local-llm:local:qwen3.6-35b-a3b-ud-mlx',
    },
    {
      id: 'qwen3-coder-plus',
      provider: 'qwen',
      family: 'qwen',
      contextWindow: 1_000_000,
      inputPerMtok: 0.14,
      outputPerMtok: 0.57,
      local: false,
      openWeight: false,
      tags: ['coding', 'long-context', 'agentic'],
      bestFor: ['agentic-coding', 'repo-scale'],
      envKey: 'DASHSCOPE_API_KEY',
      notes: 'DashScope intl · coding agent · 1M ctx',
    },
    {
      id: 'qwen3-vl-plus',
      provider: 'qwen',
      family: 'qwen',
      contextWindow: 262_000,
      inputPerMtok: 0.02,
      outputPerMtok: 0.22,
      local: false,
      openWeight: false,
      tags: ['vision', 'multimodal', 'cheap'],
      bestFor: ['ocr', 'multi-image', 'video'],
      envKey: 'DASHSCOPE_API_KEY',
      notes: 'Cheapest cloud multimodal',
    },
    // Qwen open-weight local variants (Ollama tags via `ollama pull`).
    // Sizes are Q4_K_M GGUF approximate. minRamGb leaves headroom for
    // KV cache + OS — practical M5 Max / M3 Ultra Q4 deployment.
    {
      id: 'qwen3.6:35b-a3b',
      provider: 'ollama',
      family: 'qwen',
      sizeB: 35,
      contextWindow: 256_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'vision', 'local', 'long-context', 'multimodal'],
      bestFor: ['offline-coding', 'offline-vision', 'moe-throughput'],
      minRamGb: 32,
      huggingFaceRepo: 'Qwen/Qwen3.6-35B-A3B',
      mlxRepo: 'mlx-community/Qwen3.6-35B-A3B-4bit',
      notes: 'Apache 2.0 · MoE 3B active · ~24GB Q4 · M5 Max OK',
    },
    {
      id: 'qwen3.6:27b',
      provider: 'ollama',
      family: 'qwen',
      sizeB: 27,
      contextWindow: 256_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'dense', 'local', 'long-context'],
      bestFor: ['daily-coding-offline', 'dense-mid'],
      minRamGb: 24,
      huggingFaceRepo: 'Qwen/Qwen3.6-27B',
      mlxRepo: 'mlx-community/Qwen3.6-27B-4bit',
      notes: 'Apache 2.0 · 27B dense · ~17GB Q4 · M5 Max OK',
    },
    {
      id: 'qwen3-coder:30b-a3b',
      provider: 'ollama',
      family: 'qwen',
      sizeB: 30,
      contextWindow: 256_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'local'],
      bestFor: ['offline-coding'],
      minRamGb: 28,
      huggingFaceRepo: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      mlxRepo: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',
      notes: 'Coding-tuned MoE · 3B active',
    },
    {
      id: 'qwen3.5:397b-a17b',
      provider: 'ollama',
      family: 'qwen',
      sizeB: 397,
      contextWindow: 256_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'local', 'flagship', 'open-weight'],
      bestFor: ['m3-ultra-frontier', 'open-flagship'],
      minRamGb: 256,
      huggingFaceRepo: 'Qwen/Qwen3.5-397B-A17B',
      mlxRepo: 'mlx-community/Qwen3.5-397B-A17B-4bit',
      notes: 'Apache 2.0 · 397B MoE · Q4 ~220GB · M3 Ultra 512GB only',
    },

    // ── GLM 5.x (Zhipu) · `api.z.ai` / `open.bigmodel.cn` · OpenAI-compat
    // GLM-5.1 (2026-04-07) is the current flagship — 754B MoE / 40B
    // active under MIT. All recent GLM models (4.6+) are open-weight,
    // cloud-served too. M3 Ultra 512GB can serve glm-5/5.1 Q4 (~415GB);
    // M5 Max only the smaller variants.
    {
      id: 'glm-5.1',
      provider: 'glm',
      family: 'glm',
      contextWindow: 200_000,
      inputPerMtok: 1.40,
      outputPerMtok: 4.40,
      local: false,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'agentic', 'flagship', 'moe', 'open-weight'],
      bestFor: ['frontier-coding', 'agentic-tools'],
      envKey: 'ZHIPU_API_KEY',
      huggingFaceRepo: 'zai-org/GLM-5.1',
      mlxRepo: 'mlx-community/GLM-5.1-4bit',
      reservedOutputTokens: 12_000,
      notes: 'MIT · 754B/40B MoE · Q4 ~415GB · M3 Ultra 512GB only',
    },
    {
      id: 'glm-5',
      provider: 'glm',
      family: 'glm',
      contextWindow: 202_000,
      inputPerMtok: 1.00,
      outputPerMtok: 3.20,
      local: false,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'open-weight', 'flagship'],
      bestFor: ['open-frontier', 'self-hostable-agent'],
      envKey: 'ZHIPU_API_KEY',
      huggingFaceRepo: 'zai-org/GLM-5',
      mlxRepo: 'mlx-community/GLM-5-4bit',
      notes: 'MIT · 744B/40B MoE · M3 Ultra capable',
    },
    {
      id: 'glm-4.7',
      provider: 'glm',
      family: 'glm',
      contextWindow: 200_000,
      inputPerMtok: 0.60,
      outputPerMtok: 2.20,
      local: false,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'cheap', 'open-weight', 'legacy'],
      bestFor: ['cheap-frontier', 'self-hostable'],
      envKey: 'ZHIPU_API_KEY',
      huggingFaceRepo: 'zai-org/GLM-4.7',
      mlxRepo: 'mlx-community/GLM-4.7-4bit',
      notes: 'MIT · 358B MoE · M3 Ultra capable · superseded by GLM-5',
    },
    {
      id: 'glm-4.7-flash',
      provider: 'glm',
      family: 'glm',
      contextWindow: 200_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: false,
      openWeight: true,
      localPullable: true,
      tags: ['cheap', 'free', 'open-weight', 'small'],
      bestFor: ['free-tier-experiments', 'offline-light'],
      envKey: 'ZHIPU_API_KEY',
      huggingFaceRepo: 'zai-org/GLM-4.7-Flash',
      mlxRepo: 'mlx-community/GLM-4.7-Flash-4bit',
      notes: 'Free on BigModel · small Flash · pulls on M5 Max',
    },
    {
      id: 'glm-4.6',
      provider: 'glm',
      family: 'glm',
      contextWindow: 200_000,
      inputPerMtok: 0.60,
      outputPerMtok: 2.20,
      local: false,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'open-weight', 'legacy'],
      bestFor: ['legacy-stable', 'self-hostable'],
      envKey: 'ZHIPU_API_KEY',
      huggingFaceRepo: 'zai-org/GLM-4.6',
      mlxRepo: 'mlx-community/GLM-4.6-4bit',
      notes: 'MIT · 357B MoE · legacy (predecessor of 4.7)',
    },
    // GLM open-weight local variants
    {
      id: 'glm-4.5-air',
      provider: 'ollama',
      family: 'glm',
      sizeB: 106,
      contextWindow: 128_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['coding', 'moe', 'local'],
      bestFor: ['m5-max-flagship', 'offline-mid'],
      minRamGb: 80,
      huggingFaceRepo: 'zai-org/GLM-4.5-Air',
      mlxRepo: 'mlx-community/GLM-4.5-Air-4bit',
      notes: 'MIT · 106B/12B MoE · Q4 ~60GB · M5 Max OK',
    },
    {
      id: 'glm-z1:32b',
      provider: 'ollama',
      family: 'glm',
      sizeB: 32,
      contextWindow: 32_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['dense', 'local'],
      bestFor: ['offline-reasoning'],
      minRamGb: 28,
      huggingFaceRepo: 'THUDM/GLM-Z1-32B-0414',
      mlxRepo: 'mlx-community/GLM-Z1-32B-0414-4bit',
      notes: 'Apache 2.0 · 32B dense · YaRN to 128K',
    },
    {
      id: 'glm-z1:9b',
      provider: 'ollama',
      family: 'glm',
      sizeB: 9,
      contextWindow: 32_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['small', 'local'],
      bestFor: ['low-vram-reasoning'],
      minRamGb: 12,
      huggingFaceRepo: 'THUDM/GLM-4-Z1-9B-0414',
      mlxRepo: 'mlx-community/GLM-4-Z1-9B-0414-4bit',
      notes: 'Apache 2.0 · 9B · ~6GB Q4 · runs on small dev box',
    },

    // ── NVIDIA Nemotron 3 Nano Omni · latest only (2026-04-28) ────────
    // Hybrid Mamba-Transformer MoE · 30B total / 3B active · native 1M
    // ctx · multimodal (text + vision + audio + video) · agentic
    // reasoning (configurable trace generation). Released as the
    // current Nemotron 3 Nano variant in late April 2026 — supersedes
    // the December 2025 text-only Nano. NVIDIA Nemotron Open Model
    // License (commercial OK · derivatives OK · no attribution
    // required). Runs ~27 t/s on M5 Max 48GB MLX-8bit; 4bit/Q4
    // community quants are the default for Apple silicon.
    {
      id: 'nemotron3-nano-omni:30b-a3b',
      provider: 'ollama',
      family: 'nemotron',
      sizeB: 30,
      contextWindow: 1_000_000,
      inputPerMtok: 0,
      outputPerMtok: 0,
      local: true,
      openWeight: true,
      localPullable: true,
      tags: ['reasoning', 'coding', 'agentic', 'multimodal', 'vision', 'audio', 'moe', 'local', 'long-context'],
      bestFor: ['agentic-reasoning', 'multimodal-offline', 'long-context-1M'],
      minRamGb: 32,
      huggingFaceRepo: 'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4',
      mlxRepo: 'lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-MLX-8bit',
      notes: 'NVIDIA Open Model License · 30B/3B MoE · 1M ctx · text+vision+audio+video · Q4 ~28GB / MLX-8bit ~36GB · M5 Max OK',
    },
    // ⭐ 2026-10-10 (MK · MODEL-ROUTING-MATRIX) — `--child-llm-model` 이 이 둘을 «알 수 없음»으로 거부했다
    //    (UX 17:36 실측 · 해석은 이 표 ⊕ src/anthropic/models.ts 만 본다). 값은 Anthropic 공식 1차
    //    (platform.claude.com/내부 문서 `overview` · 2026-10-10T08:38Z 직접 확인)
    //    ⊕ OpenRouter /api/v1/models 실측(05:10Z) 이 같다. 별칭(`sonnet`·`haiku`)은 옮기지 않는다 — 별개 결정.
    // ⛔ 표의 «맨 끝»에 둔 것은 의도다 — `recommendModel` 은 같은 가격이면 표 순서로 고른다(안정 정렬).
    //    haiku-5-5($0.10/$0.50)는 gpt-6-luna 와 값이 같아, 앞에 두면 'cheap' 추천이 조용히 haiku 로 바뀐다
    //    (게다가 haiku 는 >100k 프롬프트가 5배라 이 칸 하나로는 싸다고 말할 수 없다). 추천 변경은 별개 결정.
    {
      // 📏 공식: Released 2026-09-28 · 1M ctx · 출력 128K · $2/$10 · 캐시 읽기 $0.10(입력의 5%) · Adaptive · 기본 effort high.
      id: 'claude-sonnet-5-5',
      provider: 'anthropic',
      family: 'claude',
      contextWindow: 1_000_000,
      inputPerMtok: 2,
      outputPerMtok: 10,
      local: false,
      tags: ['reasoning', 'coding', 'balanced', 'long-context'],
      bestFor: ['daily-coding', 'multi-turn-chat', 'summarization'],
      envKey: 'ANTHROPIC_API_KEY',
      reservedOutputTokens: 8_000,
      reasoningEffortCeiling: 'high',  // adaptive thinking (공식 «Adaptive»)
      releasedAt: '2026-09-28',
    },
    {
      // 📏 공식: Released 2026-10-07 · 1M ctx · 출력 128K · Adaptive · 기본 effort medium.
      // ⚠️ 가격이 프롬프트 길이 구간으로 갈린다 — ≤100k 토큰 $0.10/$0.50 · >100k $0.50/$2.50(요청 전체).
      //    칸이 하나라 «≤100k» 를 싣는다.
      id: 'claude-haiku-5-5',
      provider: 'anthropic',
      family: 'claude',
      contextWindow: 1_000_000,
      inputPerMtok: 0.1,
      outputPerMtok: 0.5,
      local: false,
      tags: ['classification', 'summarization', 'cheap', 'fast', 'long-context'],
      bestFor: ['classification', 'routing', 'bulk-summarization', 'subagent-tasks'],
      envKey: 'ANTHROPIC_API_KEY',
      reservedOutputTokens: 8_000,
      reasoningEffortCeiling: 'high',  // 공식: adaptive thinking ⊕ effort 파라미터 지원(haiku-4-5 의 'low' 와 다르다)
      releasedAt: '2026-10-07',
    },
  ],
};

// ── Reasoning-effort 상한 SSOT (2026-07-19) ─────────────────────────────

export type ReasoningEffortCeiling = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** ⭐ 모델이 지원하는 reasoning-effort 최대치의 단일 출처. provider/model 마다 상한이 천차만별
 *  (codex terra=high·sol=max · anthropic opus/sonnet=high(adaptive) · gemini=high · grok
 *  non-reasoning=none·4.5=high). 라우터/UI 가 상한을 넘겨 요청하지 않도록(예: terra 에 xhigh 금지)
 *  여기서만 판정한다. ① catalog 엔트리의 명시 필드 우선 → ② family/변종 패턴 폴백(catalog 미등재
 *  최신 tier-map 모델 커버). 미상이면 안전하게 'medium'. */
export function reasoningEffortCeiling(modelId: string | undefined): ReasoningEffortCeiling {
  if (!modelId) return 'medium';
  // ① catalog 명시 필드 우선(SSoT per-entry)
  const entry = BUILTIN_CATALOG.models.find((e) => e.id === modelId);
  if (entry?.reasoningEffortCeiling) return entry.reasoningEffortCeiling;
  // ② family/변종 패턴 폴백
  const m = modelId.toLowerCase();
  if (m.includes('astra') || m.startsWith('gpt-6')) return 'max';  // gpt-6-astra (low..max)
  if (m.includes('sol')) return 'max';           // gpt-5.6-sol
  // ✅ 2026-09-23 실측 — terra·luna 도 low~max 를 «전부» 받는다(각 effort 실호출).
  //    종전 'high'/'low' 는 추정이었고 틀렸다. 비용은 `llm.codexReasoning.effort` 로 제어한다.
  if (m.includes('terra')) return 'max';         // gpt-5.6-terra
  if (m.includes('luna')) return 'max';          // gpt-5.6-luna · gpt-6-luna
  if (m.includes('claude')) return m.includes('haiku') ? 'low' : 'high';  // opus/sonnet adaptive
  if (m.startsWith('gemini-')) return 'high';    // thinkingLevel HIGH / thinkingBudget
  if (m.includes('grok')) {
    if (m.includes('non-reasoning')) return 'none';
    if (m.includes('code-fast')) return 'low';
    return 'high';                               // 4.20/4.3 always-on · 4.5 configurable
  }
  if (m.startsWith('gpt-5')) return 'high';      // 기타 gpt-5.x
  if (m.startsWith('gpt-4') || m.startsWith('o1') || m.startsWith('o3')) return 'none';  // 비추론/구세대
  return 'medium';                               // local 등 미상 — 보수적
}

// ── Paths ──────────────────────────────────────────────────────────────

export function getCatalogPath(home: string = homedir()): string {
  return join(home, '.elanous', 'models.json');
}

export interface CatalogIoOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  path?: string;
}

function resolveCatalogPath(opts: CatalogIoOpts = {}): string {
  const env = opts.env ?? process.env;
  if (opts.path) return opts.path;
  const override = env.ELANOUS_MODELS_JSON?.trim();
  if (override) return override;
  return getCatalogPath(opts.home);
}

// ── Load / persist ─────────────────────────────────────────────────────

export interface LoadResult {
  catalog: ModelCatalog;
  source: 'env' | 'file' | 'builtin' | 'fallback';
  notices: string[];
  path: string;
}

export function loadCatalog(opts: CatalogIoOpts = {}): LoadResult {
  const path = resolveCatalogPath(opts);
  const notices: string[] = [];
  if (!existsSync(path)) {
    return { catalog: cloneBuiltin(), source: 'builtin', notices: ['no models.json — using builtin'], path };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ModelCatalog>;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.models)) {
      notices.push('models.json invalid shape → builtin fallback');
      return { catalog: cloneBuiltin(), source: 'fallback', notices, path };
    }
    return {
      catalog: {
        version: 1,
        updated: typeof raw.updated === 'number' ? raw.updated : Date.now(),
        models: raw.models.map(normaliseEntry),
      },
      source: opts.env?.ELANOUS_MODELS_JSON ? 'env' : 'file',
      notices,
      path,
    };
  } catch (err) {
    notices.push(`models.json parse failed (${(err as Error).message}) → builtin fallback`);
    return { catalog: cloneBuiltin(), source: 'fallback', notices, path };
  }
}

export async function persistCatalog(catalog: ModelCatalog, opts: CatalogIoOpts = {}): Promise<string> {
  const path = resolveCatalogPath(opts);
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify({ ...catalog, updated: catalog.updated ?? Date.now() }, null, 2), 'utf-8');
  renameSync(tmp, path);
  return path;
}

// ── Discovery ──────────────────────────────────────────────────────────

export interface DiscoverOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  path?: string;
  /** When true, re-persist the loaded catalog (or builtin) back to disk
   *  so future reads stay consistent. */
  persist?: boolean;
}

export async function discoverModels(opts: DiscoverOpts = {}): Promise<ModelCatalog> {
  const loaded = loadCatalog(opts);
  if (opts.persist && loaded.source !== 'file') {
    await persistCatalog(loaded.catalog, opts);
  }
  return loaded.catalog;
}

export function enabledModels(catalog: ModelCatalog, env: NodeJS.ProcessEnv = process.env): ModelEntry[] {
  return catalog.models.filter(m => {
    if (m.local) return true;
    if (!m.envKey) return true;
    const val = env[m.envKey];
    return typeof val === 'string' && val.trim().length > 0;
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function cloneBuiltin(): ModelCatalog {
  return {
    ...BUILTIN_CATALOG,
    models: BUILTIN_CATALOG.models.map(m => ({ ...m, tags: [...m.tags], bestFor: [...m.bestFor] })),
  };
}

function normaliseEntry(raw: unknown): ModelEntry {
  const src = raw as Record<string, unknown>;
  return {
    id: String(src.id ?? ''),
    provider: (src.provider as ModelEntry['provider']) ?? 'other',
    family: String(src.family ?? ''),
    sizeB: typeof src.sizeB === 'number' ? src.sizeB : null,
    contextWindow: Number(src.contextWindow ?? 0),
    inputPerMtok: Number(src.inputPerMtok ?? 0),
    outputPerMtok: Number(src.outputPerMtok ?? 0),
    local: Boolean(src.local),
    tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
    bestFor: Array.isArray(src.bestFor) ? src.bestFor.map(String) : [],
    ...(typeof src.envKey === 'string' ? { envKey: src.envKey } : {}),
    ...(typeof src.minRamGb === 'number' ? { minRamGb: src.minRamGb } : {}),
    ...(typeof src.notes === 'string' ? { notes: src.notes } : {}),
    ...(typeof src.openWeight === 'boolean' ? { openWeight: src.openWeight } : {}),
    ...(typeof src.localPullable === 'boolean' ? { localPullable: src.localPullable } : {}),
    ...(typeof src.huggingFaceRepo === 'string' ? { huggingFaceRepo: src.huggingFaceRepo } : {}),
    ...(typeof src.mlxRepo === 'string' ? { mlxRepo: src.mlxRepo } : {}),
    ...(typeof src.reservedOutputTokens === 'number' ? { reservedOutputTokens: src.reservedOutputTokens } : {}),
    // PLAN-model-intelligence-router · Part A — preserve auto-classifier
    // fields across load/persist (else an approved candidate loses its
    // tier / variant linkage / provenance on the next read).
    ...(isModelTierValue(src.tier) ? { tier: src.tier as ModelEntry['tier'] } : {}),
    ...(typeof src.variantOf === 'string' ? { variantOf: src.variantOf } : {}),
    ...(typeof src.effortAxis === 'string' ? { effortAxis: src.effortAxis } : {}),
    ...(typeof src.releasedAt === 'string' ? { releasedAt: src.releasedAt } : {}),
    ...(normaliseClassification(src.classification) !== undefined
      ? { classification: normaliseClassification(src.classification) }
      : {}),
  };
}

const _MODEL_TIER_VALUES = ['budget', 'balanced', 'better', 'best', 'loaded'];
function isModelTierValue(v: unknown): boolean {
  return typeof v === 'string' && _MODEL_TIER_VALUES.includes(v);
}

function normaliseClassification(raw: unknown): ModelEntry['classification'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = (raw as Record<string, unknown>).source;
  if (s !== 'builtin' && s !== 'auto' && s !== 'manual') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    source: s,
    ...(typeof r.confidence === 'number' ? { confidence: r.confidence } : {}),
    ...(typeof r.at === 'string' ? { at: r.at } : {}),
  };
}

function ensureDir(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true });
}
