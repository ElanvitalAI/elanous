// LLM-USAGE-ALL-PROVIDERS-NONZERO — codex(OpenAI Responses API) 사용량 파싱 시험.
// 실 네트워크 0(withFakeFetchDevice 가짜 fetch). 아래 usage JSON 은 Responses API 의 실제 모양
// (response.usage.input_tokens · input_tokens_details.cached_tokens · output_tokens_details.reasoning_tokens)
// 을 따른 고정 시험값이다 — 실측 수치가 아니다. grok-usage.test.ts(LLM-USAGE-GROK-BLIND)와 같은 관례.
import { describe, expect, test } from 'bun:test';
import { streamCodexResponsesEvents, type LLMStreamEvent } from '../llm.js';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';

const URL_ = 'https://chatgpt.com/backend-api/codex/responses';
const BODY = {
  model: 'gpt-6.1-sol',
  instructions: 'you are a usage-parsing fixture',
  input: [{ role: 'user', content: 'count tokens' }],
};

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function drive(events: unknown[]): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  await withFakeFetchDevice([{
    url: URL_, method: 'POST',
    response: () => new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }], async () => {
    for await (const ev of streamCodexResponsesEvents(URL_, 'k', BODY)) out.push(ev);
  });
  return out;
}

function usages(events: LLMStreamEvent[]) {
  return events.flatMap((ev) => ev.type === 'usage' ? [ev.usage] : []);
}

describe('codex usage — response.completed', () => {
  test('input/output/cacheRead/reasoning 을 0이 아닌 값으로 한 usage 이벤트에 낸다(캐시 적중분은 새 입력에서 뺀다)', async () => {
    const u = usages(await drive([
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1100, output_tokens: 320, input_tokens_details: { cached_tokens: 1024 }, output_tokens_details: { reasoning_tokens: 64 } } } },
    ]));
    expect(u).toEqual([{
      provider: 'openai', stopReason: 'completed',
      inputTokens: 76, outputTokens: 320, cacheReadInputTokens: 1024, reasoningOutputTokens: 64,
    }]);
    expect(u[0]!.inputTokens!).toBeGreaterThan(0);
    expect(u[0]!.outputTokens!).toBeGreaterThan(0);
    expect(u[0]!.cacheReadInputTokens!).toBeGreaterThan(0);
  });

  test('input_tokens_details 가 없으면 prompt_tokens_details.cached_tokens 를 쓴다(필드명 변형 폴백)', async () => {
    const u = usages(await drive([
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 300, output_tokens: 20, prompt_tokens_details: { cached_tokens: 120 } } } },
    ]));
    expect(u).toEqual([{
      provider: 'openai', stopReason: 'completed',
      inputTokens: 180, outputTokens: 20, cacheReadInputTokens: 120,
    }]);
  });
});

describe('codex usage — 미측정 폴백', () => {
  test('response.incomplete 에 usage 가 없으면 stopReason 만 실는다(토큰 칸 부재 → 원장 0행 감시 대상)', async () => {
    const u = usages(await drive([
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ]));
    expect(u).toEqual([{ provider: 'openai', stopReason: 'incomplete' }]);
    expect(u[0]!.inputTokens).toBeUndefined();
    expect(u[0]!.outputTokens).toBeUndefined();
  });
});