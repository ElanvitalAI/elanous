// Shared types for prompt-caching across providers.
//
// Kept in a small module so adapters (anthropic.ts, openai.ts) and
// the metrics module all import the same shape without circular deps
// into llm.ts.

/** Unified usage payload returned by `onUsage`. Anthropic fills every
 *  field it reports; OpenAI fills `cacheReadInputTokens` from
 *  `prompt_tokens_details.cached_tokens` and leaves
 *  `cacheCreationInputTokens` as 0 (their API doesn't distinguish —
 *  caching is automatic and creation cost is rolled into
 *  `prompt_tokens`). All fields are optional so partial payloads
 *  (e.g. Anthropic message_delta only carries output + cache totals)
 *  round-trip cleanly. */
export interface LLMUsage {
  /** Origin provider — lets the metrics module tag accumulated tokens. */
  provider?: 'anthropic' | 'openai';
  /** 이 사용량을 낸 턴의 모델(내보내는 쪽이 알 때만). 턴 지표가 설정 모델 대신 이것으로 ctx 최대치·단가를 잡는다. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Hidden reasoning tokens billed under output (OpenAI o1/o3 family,
   *  qwen 3.6 / qwen3 thinking variants, gpt-oss). Reported by
   *  OpenAI-compat servers as `completion_tokens_details.reasoning_tokens`
   *  alongside the visible `completion_tokens` total. The visible
   *  answer-token count is `outputTokens - reasoningOutputTokens`.
   *  Surfacing this lets the cost panel separate "you paid for
   *  thinking" from "you paid for the answer" — important for local
   *  thinkers like qwen 3.6 where reasoning often outweighs the
   *  visible reply by 5-10x. */
  reasoningOutputTokens?: number;
  /** provider 가 «응답에 실어 보낸» 실제 청구액(USD) — OpenRouter `usage.cost`(요청에 `usage:{include:true}`).
   *  ⭐ 추정(카탈로그 단가)이 아니라 청구 사실이다 — 비용 판정이 이것을 먼저 쓴다(BACKLOG C7). */
  reportedCostUsd?: number;
  /** OR-BYOK-COST — OpenRouter `usage.is_byok === true`(상류 키로 청구된 호출 · OR `cost` 는 0). */
  byok?: true;
  /** OR-BYOK-COST — OpenRouter `usage.cost_details.upstream_inference_cost`(상류 키로 실제 청구된 USD).
   *  ⛔ 칸이 없거나 숫자가 아니면 «없다»(=미상) — 0 으로 꾸미지 않는다. */
  upstreamCostUsd?: number;
}

/** Back-compat alias for callers that imported `AnthropicUsage` from
 *  the v1 shape (feat/prompt-caching). Identical runtime structure;
 *  kept as a type so downstream code doesn't need edits. */
export type AnthropicUsage = LLMUsage;

/** Supported cache TTL tiers. `'5m'` is default (ephemeral — the wire
 *  shape omits the ttl field entirely). `'1h'` is the extended tier
 *  — 2x creation cost, same read cost; opt-in for agent sessions
 *  where prefix reuse spans > 5 minutes. */
export type CacheTTL = '5m' | '1h';

/** Wire shape of cache_control Anthropic accepts. `ttl` is optional —
 *  omitted for the 5m default, set to '1h' for extended. */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

/** Pre-baked 5m marker. Exported because many tests + adapters
 *  compare by reference — avoids churn when a new ttl tier arrives. */
export const EPHEMERAL_CACHE: CacheControl = { type: 'ephemeral' };

/** Pre-baked 1h marker. Use via `cacheControlFor(ttl)` helper so we
 *  don't sprinkle the object literal across three adapters. */
export const EPHEMERAL_CACHE_1H: CacheControl = { type: 'ephemeral', ttl: '1h' };

/** Pick the cache_control marker for a requested ttl. Single source
 *  of truth so adapter changes (e.g. adding '15m' someday) land here. */
export function cacheControlFor(ttl: CacheTTL | undefined): CacheControl {
  return ttl === '1h' ? EPHEMERAL_CACHE_1H : EPHEMERAL_CACHE;
}
