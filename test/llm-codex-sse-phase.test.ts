import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { messagesToResponsesInput, streamCodexResponsesEvents, streamLLMWithTools, type LLMMessage, type LLMProvider } from '../src/llm.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

let device: FakeFetchDevice | undefined;
afterEach(() => { device?.restore(); device = undefined; });

test('Codex SSE preserves message phase and explicit end_turn', async () => {
  const events = [
    { type: 'response.output_item.added', item: { id: 'msg1', type: 'message', role: 'assistant', content: [], phase: 'partial_answer' } },
    { type: 'response.output_text.delta', delta: 'I will check.' },
    { type: 'response.output_item.done', item: { id: 'msg1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will check.' }], phase: 'partial_answer' } },
    { type: 'response.output_item.done', item: { id: 'rs1', type: 'reasoning', summary: [], encrypted_content: 'opaque-token' } },
    { type: 'response.completed', response: { id: 'resp1', status: 'completed', end_turn: false } },
  ];
  device = createFakeFetchDevice([{
    url: '/backend-api/codex/responses', method: 'POST',
    response: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
  }]);
  const received = [];
  for await (const event of streamCodexResponsesEvents('https://chatgpt.com/backend-api/codex/responses', 'token', {
    model: 'gpt-6-sol', instructions: 'sys', input: [],
  })) received.push(event);
  expect(received).toContainEqual({ type: 'text', delta: 'I will check.', phase: 'commentary' });
  expect(received).toContainEqual({ type: 'turn_end', endTurn: false });
  expect(received).toContainEqual({ type: 'usage', usage: { provider: 'openai', stopReason: 'completed' } });
  expect(received).toContainEqual({ type: 'codex_reasoning_item', item: {
    type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque-token',
  } });
});

test('Codex SSE retains incomplete response status in usage', async () => {
  device = createFakeFetchDevice([{
    url: '/backend-api/codex/responses', method: 'POST',
    response: new Response('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
  }]);
  const received = [];
  for await (const event of streamCodexResponsesEvents('https://chatgpt.com/backend-api/codex/responses', 'token', {
    model: 'gpt-6-sol', instructions: 'sys', input: [],
  })) received.push(event);
  expect(received).toContainEqual({ type: 'usage', usage: { provider: 'openai', stopReason: 'incomplete' } });
});

test('Codex status reaches turn usage callback and llm.usage/llm.request logs', async () => {
  const oldMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  const logged: Array<{ category: string; data: Record<string, unknown> }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    if (category === 'llm.usage' || category === 'llm.request') logged.push({ category, data: (data ?? {}) as Record<string, unknown> });
  });
  try {
    for (const status of ['completed', 'incomplete', undefined]) {
      logged.length = 0;
      device?.restore();
      device = createFakeFetchDevice([{
        url: '/backend-api/codex/responses', method: 'POST',
        response: new Response(`data: ${JSON.stringify({ type: `response.${status ?? 'completed'}`, response: { ...(status ? { status } : {}), usage: { input_tokens: 3, output_tokens: 2 } } })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }),
      }]);
      const provider: LLMProvider = {
        name: 'probe-codex', defaultModel: 'gpt-6-sol', available: () => true,
        async *chat() { yield 'done'; },
        streamChat: (_messages, opts) => streamCodexResponsesEvents('https://chatgpt.com/backend-api/codex/responses', 'token', {
          model: opts?.model ?? 'gpt-6-sol', instructions: 'sys', input: [],
        }),
      };
      const surfaced: string[] = [];
      await streamLLMWithTools([{ role: 'user', content: 'observe status' }], {
        onText: () => {}, dispatchTool: async () => ({}), onUsage: usage => { if (usage.stopReason) surfaced.push(usage.stopReason); },
      }, { provider });
      expect(surfaced).toEqual(status ? [status] : []);
      if (status) {
        expect(logged.some(row => row.category === 'llm.usage' && row.data.stopReason === status)).toBe(true);
        expect(logged.some(row => row.category === 'llm.request' && row.data.stopReason === status)).toBe(true);
      } else {
        expect(logged.some(row => row.category === 'llm.usage' && 'stopReason' in row.data)).toBe(false);
        expect(logged.some(row => row.category === 'llm.request' && 'stopReason' in row.data)).toBe(false);
      }
    }
  } finally {
    logSpy.mockRestore();
    if (oldMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = oldMode;
  }
});

test('assistant phase survives stateless Responses input mapping', () => {
  const messages: LLMMessage[] = [
    { role: 'assistant', content: 'Checking.', phase: 'commentary', codexReasoningItems: [
      { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque-token' },
    ] },
    { role: 'user', content: 'Continue.' },
  ];
  const { input } = messagesToResponsesInput(messages);
  expect(input[0]).toEqual({ type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque-token' });
  expect(input[1]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }], phase: 'commentary' });
  const storedInput = messagesToResponsesInput(messages, { replayCodexReasoning: false }).input;
  expect(storedInput[0]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }], phase: 'commentary' });
});
