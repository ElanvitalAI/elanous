import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { parseAnthropicSSELines, parseOpenAISSELines, resolveDefaultOutputTokens, streamLLM, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';

test('output budget follows role and catalog model allowance', () => {
  expect(resolveDefaultOutputTokens('grok-4.6', 'planning', true)).toBe(8_000);
  expect(resolveDefaultOutputTokens('grok-4.6', 'classify', true)).toBe(512);
  expect(resolveDefaultOutputTokens('grok-4.6', undefined, false)).toBe(4_096);
});

test('tool-enabled final answer also continues a length cut once', async () => {
  const oldMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  try {
    let calls = 0;
    const reasons: string[] = [];
    const provider: LLMProvider = {
      name: 'test-output-limit', defaultModel: 'grok-4.6', available: () => true,
      chat: async function* () { yield ''; },
      streamChat: async function* () {
        calls++;
        yield { type: 'text', delta: calls === 1 ? 'first ' : 'second' };
        yield { type: 'finish', reason: calls === 1 ? 'length' : 'stop' };
      },
    };
    const answer = await streamLLMWithTools([{ role: 'user', content: 'Design a ticketing system' }], {
      onText: () => {}, dispatchTool: async () => ({}),
    }, {
      provider,
      tools: [{ name: 'Lookup', description: 'lookup', parameters: { type: 'object', properties: {} } }],
      onFinishReason: (reason) => reasons.push(reason),
      maxTurns: 1, // Source: #36522
      longAnswer: true,
    });
    expect(answer).toBe('first second');
    expect(calls).toBe(2);
    expect(reasons).toEqual(['length', 'stop']);
  } finally {
    if (oldMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = oldMode;
  }
});

test('OpenAI SSE preserves a text finish reason', async () => {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'part' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`,
    'data: [DONE]',
  ];
  const events: LLMStreamEvent[] = [];
  for await (const event of parseOpenAISSELines(lines)) events.push(event);
  expect(events).toEqual([{ type: 'text', delta: 'part' }, { type: 'finish', reason: 'length' }]);
});

test('Anthropic max_tokens maps to the shared length reason', async () => {
  const events: LLMStreamEvent[] = [];
  for await (const event of parseAnthropicSSELines([
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
    'data: {"type":"message_stop"}',
  ])) events.push(event);
  expect(events).toEqual([
    { type: 'text', delta: 'part' },
    { type: 'finish', reason: 'length' },
    { type: 'usage', usage: { provider: 'anthropic', stopReason: 'max_tokens' } },
  ]);
});

test('a length cut continues once and reports terminal stop', async () => {
  const oldMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  try {
    const calls: Array<{ maxTokens?: number; messages: unknown[] }> = [];
    const provider: LLMProvider = {
      name: 'test-output-limit', defaultModel: 'grok-4.6', available: () => true,
      chat: async function* () { yield ''; },
      streamChat: async function* (messages, opts) {
        calls.push({ maxTokens: opts?.maxTokens, messages });
        yield { type: 'text', delta: calls.length === 1 ? 'first ' : 'second' };
        yield { type: 'finish', reason: calls.length === 1 ? 'length' : 'stop' };
      },
    };
    const chunks: string[] = [];
    const reasons: string[] = [];
    const answer = await streamLLM([{ role: 'user', content: 'Design a ticketing system' }], (delta) => chunks.push(delta), {
      provider, longAnswer: true, onFinishReason: (reason) => reasons.push(reason),
    });
    expect(answer).toBe('first second');
    expect(chunks.join('')).toBe(answer);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxTokens).toBe(8_000);
    expect(reasons).toEqual(['stop']);
  } finally {
    if (oldMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = oldMode;
  }
});

test('streamLLM continuation sums both provider calls before recording usage', async () => {
  const oldMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  let calls = 0;
  const done: Record<string, unknown>[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.router.done' && event === 'streamLLM') done.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    const provider: LLMProvider = {
      name: 'test-output-limit', defaultModel: 'grok-4.6', available: () => true,
      chat: async function* () { yield ''; },
      streamChat: async function* () {
        calls++;
        yield { type: 'usage', usage: calls === 1
          ? { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 10, reportedCostUsd: 0.01 }
          : { inputTokens: 130, outputTokens: 15, cacheReadInputTokens: 20, reportedCostUsd: 0.02 } };
        yield { type: 'text', delta: calls === 1 ? 'first ' : 'second' };
        yield { type: 'finish', reason: calls === 1 ? 'length' : 'stop' };
      },
    };
    expect(await streamLLM([{ role: 'user', content: 'design' }], () => {}, { provider })).toBe('first second');
    expect(calls).toBe(2);
    expect(done).toHaveLength(1);
    expect(done[0]?.usage).toEqual({ inputTokens: 230, outputTokens: 35, cacheReadInputTokens: 30, reportedCostUsd: 0.03 });
    expect(done[0]?.finishReason).toBe('stop');
  } finally {
    spy.mockRestore();
    if (oldMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = oldMode;
  }
});

test('a second length cut is reported without a third request', async () => {
  const oldMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  try {
    let calls = 0;
    let terminalReason: string | undefined;
    const provider: LLMProvider = {
      name: 'test-output-limit', defaultModel: 'grok-4.6', available: () => true,
      chat: async function* () { yield ''; },
      streamChat: async function* () {
        calls++;
        yield { type: 'text', delta: String(calls) };
        yield { type: 'finish', reason: 'length' };
      },
    };
    const answer = await streamLLM([{ role: 'user', content: 'Design a ticketing system' }], () => {}, {
      provider, onFinishReason: (reason) => { terminalReason = reason; },
    });
    expect(answer).toBe('12');
    expect(calls).toBe(2);
    expect(terminalReason).toBe('length');
  } finally {
    if (oldMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = oldMode;
  }
});
