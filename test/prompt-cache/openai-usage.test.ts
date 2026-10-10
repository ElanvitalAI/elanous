import { describe, expect, test } from 'bun:test';
import { parseOpenAIUsage, parseOpenAISSELines } from '../../src/prompt-cache/index.js';
// parseOpenAISSELines is re-exported via llm.ts; we import it from there
// for the integration slice below.
import { parseOpenAISSELines as parseSSE, type LLMStreamEvent } from '../../src/llm.js';

async function collect(gen: AsyncGenerator<LLMStreamEvent, void, unknown>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// We alias the two parseOpenAISSELines imports for clarity; they
// resolve to the same export. Keeps the test expressive about which
// surface the assertion targets.
void parseOpenAISSELines;

describe('parseOpenAIUsage — event shapes', () => {
  test('final chunk with prompt_tokens_details.cached_tokens', () => {
    const ev = {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        // ⛔ prompt_tokens 는 캐시 적중분을 «포함»한다(1164 = 새 140 + 캐시 1024) — elanous 는 새 입력만 inputTokens 에(BACKLOG C4).
        prompt_tokens: 1164,
        completion_tokens: 320,
        total_tokens: 1484,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    };
    expect(parseOpenAIUsage(ev)).toEqual({
      provider: 'openai',
      inputTokens: 140,
      outputTokens: 320,
      cacheReadInputTokens: 1024,
      cacheCreationInputTokens: 0,
    });
  });

  test('usage without cached_tokens (Grok / older OpenAI) → no cache fields', () => {
    const ev = {
      usage: { prompt_tokens: 140, completion_tokens: 320 },
    };
    expect(parseOpenAIUsage(ev)).toEqual({
      provider: 'openai',
      inputTokens: 140,
      outputTokens: 320,
    });
  });

  test('non-final chunk (no usage) → null', () => {
    expect(parseOpenAIUsage({ choices: [{ delta: { content: 'hi' } }] })).toBeNull();
  });

  test('null / non-object → null', () => {
    expect(parseOpenAIUsage(null)).toBeNull();
    expect(parseOpenAIUsage('string')).toBeNull();
  });

  test('empty usage object → null', () => {
    expect(parseOpenAIUsage({ usage: {} })).toBeNull();
  });
});

describe('parseOpenAISSELines — usage chunk emitted', () => {
  test('final chunk with usage yields a usage event alongside text', async () => {
    const lines = [
      `data: {"choices":[{"delta":{"content":"Hi"}}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":8}}}`,
      `data: [DONE]`,
    ];
    const events = await collect(parseSSE(lines));
    expect(events).toEqual([
      { type: 'text', delta: 'Hi' },
      {
        type: 'usage',
        usage: {
          provider: 'openai',
          inputTokens: 4 /* 12 − 캐시 8 */,
          outputTokens: 3,
          cacheReadInputTokens: 8,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
  });

  test('chunks without usage do not emit usage events', async () => {
    const lines = [
      `data: {"choices":[{"delta":{"content":"a"}}]}`,
      `data: {"choices":[{"delta":{"content":"b"}}]}`,
      `data: [DONE]`,
    ];
    const events = await collect(parseSSE(lines));
    expect(events.filter(e => e.type === 'usage')).toEqual([]);
  });
});

describe('BACKLOG C4·C11 — cached prompt tokens are subtracted once, across vendor shapes', () => {
  test('fresh + cacheRead equals prompt_tokens (sum invariant)', () => {
    const u = parseOpenAIUsage({ usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } } })!;
    expect((u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0)).toBe(1000);
  });
  test('Kimi top-level cached_tokens and DeepSeek prompt_cache_hit_tokens', () => {
    expect(parseOpenAIUsage({ usage: { prompt_tokens: 100, completion_tokens: 1, cached_tokens: 60 } })).toMatchObject({ inputTokens: 40, cacheReadInputTokens: 60 });
    expect(parseOpenAIUsage({ usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 70 } })).toMatchObject({ inputTokens: 30, cacheReadInputTokens: 70 });
  });
});

describe('BACKLOG C7 — OpenRouter reported cost', () => {
  test('usage.cost is carried as reportedCostUsd', () => {
    expect(parseOpenAIUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00042 } })).toMatchObject({ reportedCostUsd: 0.00042 });
    expect(parseOpenAIUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } })!.reportedCostUsd).toBeUndefined();
  });
});

describe('parseOpenAIUsage — OpenRouter cache writes (OR-ANTHROPIC-CACHE)', () => {
  test('prompt_tokens_details.cache_write_tokens → cacheCreationInputTokens, removed from new input', () => {
    const ev = { usage: { prompt_tokens: 5000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1500 } } };
    expect(parseOpenAIUsage(ev)).toEqual({
      provider: 'openai', inputTokens: 500, outputTokens: 10, cacheReadInputTokens: 3000, cacheCreationInputTokens: 1500,
    });
  });
  test('first turn: write only (no read yet) → read 0, creation = writes', () => {
    const ev = { usage: { prompt_tokens: 4000, completion_tokens: 5, prompt_tokens_details: { cache_write_tokens: 3500 } } };
    expect(parseOpenAIUsage(ev)).toEqual({
      provider: 'openai', inputTokens: 500, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 3500,
    });
  });
});
