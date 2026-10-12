import type { LLMProviderName } from '../user-config.js';

/** Lightweight model-id family — prefix/substring only. No catalog, no
 *  `src/llm/model-defaults.ts` (that module imports this file). */
export type RuntimeLlmModelFamily =
  | 'grok' | 'anthropic' | 'openai' | 'openai-codex' | 'gemini' | 'local'
  | 'kimi' | 'qwen' | 'glm' | 'openrouter' | 'bedrock' | 'unknown';

export function inferRuntimeLlmModelFamily(model: string | undefined): RuntimeLlmModelFamily {
  if (!model) return 'unknown';
  const m = model.trim().toLowerCase();
  if (!m) return 'unknown';
  // ⛔ 2026-09-23 — 게이트웨이 접두가 «먼저»다. 안 그러면 `openrouter/anthropic/claude-…` 가 `anthropic` 으로
  //   읽혀 openrouter 와 «비호환»이 되고, `openrouter/z-ai/…` 는 `unknown` 이라 아무 provider 와도 «호환»이 됐다.
  if (m.startsWith('openrouter/')) return 'openrouter';
  // ⭐ BEDROCK-PROVIDER — Bedrock 전용 꼴(`anthropic.claude-…`·지역 접두·`bedrock/…`)이 `includes('claude')` 보다 «먼저».
  //   1st-party id(`claude-…`)는 그대로 anthropic 이다(불변).
  if (m.startsWith('bedrock/') || /^(?:[a-z]{2,6}\.)?anthropic\.claude-/.test(m)) return 'bedrock';
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
  // bedrock 은 1st-party claude id 도 받는다(공급자가 `anthropic.` 접두로 바꿔 보낸다).
  if (provider === 'bedrock') return family === 'bedrock' || family === 'anthropic';
  return provider === family;
}

