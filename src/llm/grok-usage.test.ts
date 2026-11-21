// LLM-USAGE-GROK-BLIND — grok/xAI 응답의 usage 를 읽어 원장에 남긴다. 실 네트워크 0 (가짜 fetch).
// 출처: 아래 SSE/JSON 은 xAI chat/completions 의 실제 모양(usage.prompt_tokens · prompt_tokens_details.cached_tokens ·
//   completion_tokens_details.reasoning_tokens)을 따른 고정 시험값이다 — 실측 수치가 아니다.
import { describe, expect, test } from 'bun:test';
import { streamOpenAIEvents, type LLMStreamEvent } from '../llm.js';
import { parseOpenAIUsage } from '../prompt-cache/openai.js';
import { estimateTokens } from '../tokens.js';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { formatCacheUsageReport, summarizeCacheUsage } from '../budget/cache-usage-report.js';
import { rollupRunUsage } from '../budget/run-usage-rollup.js';

const PROXY_URL = 'https://cli-chat-proxy.grok.com/v1/chat/completions';
const API_URL = 'https://api.x.ai/v1/chat/completions';

const STREAM_WITH_USAGE = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"안녕"}}]}',
  'data: {"choices":[{"delta":{"content":"하세요"},"finish_reason":"stop"}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"total_tokens":1040,"prompt_tokens_details":{"text_tokens":1000,"cached_tokens":750},"completion_tokens_details":{"reasoning_tokens":12}}}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const STREAM_WITHOUT_USAGE = [
  'data: {"choices":[{"delta":{"content":"abcdefgh"}}]}',
  'data: {"choices":[{"delta":{"content":"ijklmnop"},"finish_reason":"stop"}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const NON_STREAM = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 7 } },
};

const MESSAGES = [{ role: 'user', content: 'hello grok' }];

async function drive(url: string, sse: string): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  await withFakeFetchDevice([{
    url, method: 'POST',
    response: () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }], async () => {
    for await (const ev of streamOpenAIEvents(url, 'k', { model: 'grok-4.7', messages: MESSAGES }, undefined, undefined, undefined, false)) events.push(ev);
  });
  return events;
}

function usageEvents(events: LLMStreamEvent[]) {
  return events.flatMap((ev) => ev.type === 'usage' ? [ev.usage] : []);
}

describe('stream — 마지막 usage 청크', () => {
  test('프록시 URL 에서도 usage 청크를 읽고 캐시 적중분을 입력에서 뺀다', async () => {
    const usages = usageEvents(await drive(PROXY_URL, STREAM_WITH_USAGE));
    expect(usages).toEqual([{
      provider: 'openai', inputTokens: 250, outputTokens: 40, cacheReadInputTokens: 750, cacheCreationInputTokens: 0,
      reasoningOutputTokens: 12, stopReason: 'stop',
    }]);
    expect(usages[0]!.estimated).toBeUndefined();
  });
});

describe('non-stream 응답', () => {
  test('usage 객체를 같은 규약으로 읽는다', () => {
    expect(parseOpenAIUsage(NON_STREAM)).toEqual({
      provider: 'openai', inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, reasoningOutputTokens: 7,
    });
  });

  test('xAI 변형 필드명(input_tokens/output_tokens · input_tokens_details · cached_prompt_text_tokens)', () => {
    expect(parseOpenAIUsage({ usage: { input_tokens: 300, output_tokens: 20, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 5 } } })).toEqual({
      provider: 'openai', inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, reasoningOutputTokens: 5,
    });
    expect(parseOpenAIUsage({ usage: { prompt_tokens: 90, completion_tokens: 10, cached_prompt_text_tokens: 40 } })).toEqual({
      provider: 'openai', inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 40, cacheCreationInputTokens: 0,
    });
  });
});

describe('usage 가 아예 없을 때 — 추정', () => {
  test('grok 엔드포인트는 추정치를 estimated:true 로 낸다', async () => {
    const usages = usageEvents(await drive(PROXY_URL, STREAM_WITHOUT_USAGE));
    expect(usages).toEqual([{
      provider: 'openai', inputTokens: estimateTokens(JSON.stringify(MESSAGES)), outputTokens: estimateTokens('abcdefghijklmnop'),
      estimated: true, stopReason: 'stop',
    }]);
  });

  test('api.x.ai 도 같다', async () => {
    const usages = usageEvents(await drive(API_URL, STREAM_WITHOUT_USAGE));
    expect(usages.map((u) => u.estimated)).toEqual([true]);
  });

  test('grok 이 아닌 엔드포인트는 추정하지 않는다(종전 그대로)', async () => {
    const usages = usageEvents(await drive('https://example.test/v1/chat/completions', STREAM_WITHOUT_USAGE));
    expect(usages).toEqual([{ provider: 'openai', stopReason: 'stop' }]);
  });
});

describe('원장 집계 · 캐시 적중률 표면', () => {
  test('rollup 은 추정 호출 수를 «추정» 칸으로 센다 — 없으면 칸 자체가 없다', () => {
    const rows = rollupRunUsage([
      { runId: 'r', model: 'grok-4.7', inputTokens: 5, outputTokens: 6, estimated: true },
      { runId: 'r', model: 'grok-4.7', inputTokens: 250, outputTokens: 40 },
    ]);
    expect(rows[0]!.estimatedCalls).toBe(1);
    expect(rollupRunUsage([{ runId: 'r', model: 'm', inputTokens: 1 }])[0]!.estimatedCalls).toBeUndefined();
  });

  test('eln usage cache 는 grok 적중률을 고정 입력에서 정확히 계산해 보인다', () => {
    const report = summarizeCacheUsage([
      { billingProvider: 'grok', model: 'grok-4.7', inputTokens: 250, cacheReadInputTokens: 750, cacheCreationInputTokens: 0 },
      { billingProvider: 'anthropic', model: 'claude', inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    ]);
    const text = formatCacheUsageReport(report);
    expect(text).toContain('grok 캐시 적중률 75.0%');
    expect(text.split('\n').filter((l) => l.startsWith('grok 캐시')).length).toBe(1);
  });

  test('grok 행이 없으면 grok 줄도 없다', () => {
    const text = formatCacheUsageReport(summarizeCacheUsage([{ billingProvider: 'anthropic', model: 'c', inputTokens: 1, cacheReadInputTokens: 0 }]));
    expect(text).not.toContain('grok 캐시');
  });
});
