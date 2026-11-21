// LLM-USAGE-ALL-PROVIDERS-NONZERO — claude(Anthropic 1st-party) 사용량 파싱 시험.
// 실 네트워크 0. SSE 원문은 Anthropic Messages 스트리밍 실제 모양(message_start.message.usage ·
// message_delta.usage · message_stop)을 따른 고정 시험값이다 — 실측 수치가 아니다.
// bedrock 런타임 경로는 같은 파서를 경유하므로(bedrock-runtime.test.ts «usage» describe) 여기선 1st-party 만.
import { describe, expect, test } from 'bun:test';
import { parseAnthropicUsage } from '../prompt-cache/anthropic.js';
import { parseAnthropicSSELines, type LLMStreamEvent } from '../llm.js';

const MESSAGE_START = {
  type: 'message_start',
  message: { usage: { input_tokens: 140, output_tokens: 1, cache_creation_input_tokens: 512, cache_read_input_tokens: 1024 } },
};
const MESSAGE_DELTA = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 320 } };
const MESSAGE_STOP = { type: 'message_stop' };

/** 한 요소 = 한 물리 줄. parseAnthropicSSELines 는 «줄» 반복기를 받는다 —
 *  event:/data: 두 줄을 한 문자열(줄바꿈 포함)로 넘기면 data: 접두가 아니라 전부 스킵된다. */
function lines(events: unknown[]): string[] {
  return events.flatMap((e) => [`event: ${(e as { type: string }).type}`, `data: ${JSON.stringify(e)}`, '']);
}

async function collect(events: unknown[]): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of parseAnthropicSSELines(lines(events))) out.push(ev);
  return out;
}

function usages(events: LLMStreamEvent[]) {
  return events.flatMap((ev) => ev.type === 'usage' ? [ev.usage] : []);
}

describe('parseAnthropicUsage — 단일 이벤트', () => {
  test('message_start: input·cacheCreation·cacheRead 를 규약 칸으로 옮긴다', () => {
    expect(parseAnthropicUsage(MESSAGE_START)).toEqual({
      provider: 'anthropic', inputTokens: 140, outputTokens: 1,
      cacheCreationInputTokens: 512, cacheReadInputTokens: 1024,
    });
  });

  test('message_delta: 누적 output', () => {
    expect(parseAnthropicUsage(MESSAGE_DELTA)).toEqual({ provider: 'anthropic', outputTokens: 320 });
  });

  test('usage 가 없는 이벤트는 null(스킵 — 이벤트 낭비 0)', () => {
    expect(parseAnthropicUsage({ type: 'content_block_stop' })).toBeNull();
    expect(parseAnthropicUsage({ type: 'message_start', message: {} })).toBeNull();
    expect(parseAnthropicUsage(null)).toBeNull();
  });
});

describe('parseAnthropicSSELines — 한 호출에 한 줄(BACKLOG C3)', () => {
  test('message_start+delta 를 message_stop 에 합쳐 0이 아닌 input/output/cacheRead/cacheCreation 한 줄로 낸다', async () => {
    const usage = usages(await collect([
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      MESSAGE_DELTA,
      MESSAGE_STOP,
    ]));
    expect(usage).toHaveLength(1);
    // usage.stopReason 은 공급자 원문을 그대로 실는다(정규화된 값은 finish 이벤트의 reason 에서).
    expect(usage[0]).toEqual({
      provider: 'anthropic', inputTokens: 140, outputTokens: 320,
      cacheCreationInputTokens: 512, cacheReadInputTokens: 1024, stopReason: 'end_turn',
    });
    expect(usage[0]!.inputTokens!).toBeGreaterThan(0);
    expect(usage[0]!.outputTokens!).toBeGreaterThan(0);
    expect(usage[0]!.cacheReadInputTokens!).toBeGreaterThan(0);
    expect(usage[0]!.cacheCreationInputTokens!).toBeGreaterThan(0);
  });

  test('message_stop 없이 끊겨도 모은 사용량을 잃지 않는다(원장 0행 방어선)', async () => {
    const usage = usages(await collect([MESSAGE_START, MESSAGE_DELTA]));
    expect(usage).toEqual([{
      provider: 'anthropic', inputTokens: 140, outputTokens: 320,
      cacheCreationInputTokens: 512, cacheReadInputTokens: 1024, stopReason: 'end_turn',
    }]);
  });
});