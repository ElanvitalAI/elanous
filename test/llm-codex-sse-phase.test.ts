import { afterEach, expect, test } from 'bun:test';
import { messagesToResponsesInput, streamCodexResponsesEvents, type LLMMessage } from '../src/llm.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('Codex SSE preserves message phase and explicit end_turn', async () => {
  const events = [
    { type: 'response.output_item.added', item: { id: 'msg1', type: 'message', role: 'assistant', content: [], phase: 'partial_answer' } },
    { type: 'response.output_text.delta', delta: 'I will check.' },
    { type: 'response.output_item.done', item: { id: 'msg1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will check.' }], phase: 'partial_answer' } },
    { type: 'response.output_item.done', item: { id: 'rs1', type: 'reasoning', summary: [], encrypted_content: 'opaque-token' } },
    { type: 'response.completed', response: { id: 'resp1', end_turn: false } },
  ];
  globalThis.fetch = (async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch;
  const received = [];
  for await (const event of streamCodexResponsesEvents('https://chatgpt.com/backend-api/codex/responses', 'token', {
    model: 'gpt-6-sol', instructions: 'sys', input: [],
  })) received.push(event);
  expect(received).toContainEqual({ type: 'text', delta: 'I will check.', phase: 'commentary' });
  expect(received).toContainEqual({ type: 'turn_end', endTurn: false });
  expect(received).toContainEqual({ type: 'codex_reasoning_item', item: {
    type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque-token',
  } });
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
