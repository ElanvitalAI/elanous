// LLM-USAGE-ALL-PROVIDERS-NONZERO — OpenRouter(Anthropic 상류) 사용량 파싱 시험.
// 실 네트워크 0. OpenRouter 는 OpenAI 호환 꼴에 캐시 «쓰기» 를 prompt_tokens_details.cache_write_tokens 로,
// 실제 청구액(USD)을 usage.cost 로 싣는다(OR-ANTHROPIC-CACHE · OR-BYOK-COST).
// byok 칸은 openrouter-byok-cost.test.ts 가 이미 커버 — 여기선 usage 객체의 OR 칸만.
import { describe, expect, test } from 'bun:test';
import { parseOpenAIUsage } from '../prompt-cache/openai.js';

describe('parseOpenAIUsage — OpenRouter 전용 칸', () => {
  test('cache_write_tokens 는 새 입력에서 빼고 cacheCreationInputTokens 로 옮긴다(Anthropic 규약)', () => {
    expect(parseOpenAIUsage({
      usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 750, cache_write_tokens: 200 } },
    })).toEqual({
      provider: 'openai', inputTokens: 50, outputTokens: 40,
      cacheReadInputTokens: 750, cacheCreationInputTokens: 200,
    });
  });

  test('usage.cost 는 reportedCostUsd 로 실는다', () => {
    const u = parseOpenAIUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0123 } });
    expect(u!.reportedCostUsd).toBe(0.0123);
    expect(u!.inputTokens).toBe(100);
  });

  test('cache 칸이 아예 없는 OR 호출은 cacheRead 칸을 만들지 않는다(행은 있다 — 칸 부재 ≠ 0행)', () => {
    expect(parseOpenAIUsage({ usage: { prompt_tokens: 100, completion_tokens: 10 } })).toEqual({
      provider: 'openai', inputTokens: 100, outputTokens: 10,
    });
  });

  test('캐시 적중 0 은 0 으로 그대로 기록한다(적중 0 ≡ 미제공 구별 표면)', () => {
    expect(parseOpenAIUsage({
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    })).toEqual({
      provider: 'openai', inputTokens: 100, outputTokens: 10,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
  });
});