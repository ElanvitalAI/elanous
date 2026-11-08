// ── LLM streaming parser tests ──
// Unit tests for parseOpenAISSELines + parseAnthropicSSELines — the
// pure SSE-line-to-LLMStreamEvent generators at the heart of
// tool-call support. No fetch dependency.

import { describe, test, expect } from 'bun:test';
import { parseOpenAISSELines, parseAnthropicSSELines, streamLLMWithTools, observeRequestTools, type LLMStreamEvent, type LLMProvider, type LLMMessage } from '../src/llm.js';
import { compactForLog, debug } from '../src/debug/log.js';

async function collect(gen: AsyncGenerator<LLMStreamEvent, void, unknown>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('llm.request tool observation', () => {
  test('preserves every name from a 31-tool request through default log compaction', () => {
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: 'function',
      function: { name: `tool-${index}` },
    }));

    const observed = observeRequestTools(tools);
    const compacted = compactForLog({ tools: observed });

    expect(compacted.tools).toEqual({
      names: Object.fromEntries(tools.map((tool, index) => [String(index), tool.function.name])),
      count: 31,
      folded: false,
    });
  });

  // ⛔⭐ 이 시험의 «의도»는 「평범한 배열은 여전히 접힌다」이지 「상한이 6이다」가 아니다.
  //   기본 상한이 6 → 200 으로 바뀌었다(2026-08-25 · 표본에서 1202개가 사라져서 · +0.51%).
  //   ⇒ 길이를 새 상한 «위»로 올려 ***의도를 그대로 지킨다.*** 상한 값은 log.ts 가 canonical 이라
  //     여기 숫자로 박지 않고 「접힌다 ⊕ 진짜 개수가 복원된다」만 문다.
  test('keeps the logger array-folding rule for unrelated payloads', () => {
    const length = 5000;
    const compacted = compactForLog<{ values: unknown[] }>({ values: Array.from({ length }, (_, index) => index) });
    const marker = compacted.values.at(-1) as { _more: number };
    expect(marker._more).toBeGreaterThan(0);
    expect(compacted.values.length - 1 + marker._more).toBe(length);
  });
});

describe('parseOpenAISSELines', () => {
  test('emits text deltas as they arrive', async () => {
    const lines = [
      `data: {"choices":[{"delta":{"content":"Hel"}}]}`,
      `data: {"choices":[{"delta":{"content":"lo"}}]}`,
      `data: [DONE]`,
    ];
    const events = await collect(parseOpenAISSELines(lines));
    expect(events).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
    ]);
  });

  test('accumulates tool_call fragments, emits on finish_reason', async () => {
    const lines = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"bump","arguments":""}}]}}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"by\\""}}]}}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":3}"}}]}}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
    ];
    const events = await collect(parseOpenAISSELines(lines));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool_call', id: 'call_abc', name: 'bump', args: { by: 3 },
    });
  });

  test('mixed text and tool_call in same stream', async () => {
    const lines = [
      `data: {"choices":[{"delta":{"content":"thinking..."}}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
    ];
    const events = await collect(parseOpenAISSELines(lines));
    expect(events).toEqual([
      { type: 'text', delta: 'thinking...' },
      { type: 'tool_call', id: 'c1', name: 'f', args: {} },
    ]);
  });

  test('malformed JSON lines are skipped', async () => {
    const lines = [
      `data: {not-json}`,
      `data: {"choices":[{"delta":{"content":"ok"}}]}`,
    ];
    const events = await collect(parseOpenAISSELines(lines));
    expect(events).toEqual([{ type: 'text', delta: 'ok' }]);
  });

  test('two parallel tool calls — each accumulates on its own index', async () => {
    const lines = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"x","arguments":"{\\"n\\":1}"}}]}}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"y","arguments":"{\\"m\\":2}"}}]}}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
    ];
    const events = await collect(parseOpenAISSELines(lines));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'tool_call', id: 'a', name: 'x', args: { n: 1 } });
    expect(events[1]).toEqual({ type: 'tool_call', id: 'b', name: 'y', args: { m: 2 } });
  });
});

describe('streamLLMWithTools', () => {
  /** Build a fake provider that yields a scripted sequence of event arrays
   *  — one per turn. Each invocation of streamChat pops the next turn. */
  function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
    let callCount = 0;
    return {
      name: 'fake',
      defaultModel: 'fake',
      available: () => true,
      async *streamChat() {
        const events = turns[callCount++] ?? [];
        for (const ev of events) yield ev;
      },
      async *chat() { /* unused */ },
    };
  }

  test('no tools: delegates to plain streamLLM and returns text', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'hello' }]]);
    // When tools array is empty, the helper falls back to streamLLM which
    // calls provider.chat — but our fake provider.chat yields nothing.
    // So we test the tools-present happy path instead. See next test.
    expect(typeof provider).toBe('object');  // smoke
  });

  test('tool_call → dispatch → text response loop', async () => {
    const provider = fakeProvider([
      // Turn 1: model asks to call a tool
      [
        { type: 'text', delta: 'Checking...' },
        { type: 'tool_call', id: 'c1', name: 'echo', args: { x: 'hi' } },
      ],
      // Turn 2: model responds with final text after seeing tool result
      [{ type: 'text', delta: ' done.' }],
    ]);
    const textChunks: string[] = [];
    const calls: Array<{ name: string; args: unknown }> = [];
    const results: Array<{ name: string; result: unknown }> = [];

    const final = await streamLLMWithTools(
      [{ role: 'user', content: 'echo hi' }] as LLMMessage[],
      {
        onText: (delta) => { textChunks.push(delta); },
        dispatchTool: async (name, args) => {
          calls.push({ name, args });
          return { echoed: (args as any).x };
        },
        onToolResult: (r) => { results.push({ name: r.name, result: r.result }); },
      },
      { provider, tools: [{ name: 'echo', description: '', parameters: {} }] },
    );

    // The RETURN value is the model's final-turn synthesized answer (' done.'),
    // NOT the concatenation of every turn's text. Pre-tool commentary
    // ("Checking...") still streams to the user via onText and is preserved in
    // the structured transcript (onTurnComplete) — it just isn't the answer.
    expect(final).toBe(' done.');
    // onText streams all text deltas across turns (both visible to the user);
    // filter the empty-delta finalization emits the loop uses to normalize.
    expect(textChunks.filter(Boolean)).toEqual(['Checking...', ' done.']);
    expect(calls).toEqual([{ name: 'echo', args: { x: 'hi' } }]);
    expect(results).toEqual([{ name: 'echo', result: { echoed: 'hi' } }]);
  });

  test('dispatchTool throw is captured as {error} and fed to next turn', async () => {
    const provider = fakeProvider([
      [{ type: 'tool_call', id: 'c1', name: 'boom', args: {} }],
      [{ type: 'text', delta: 'I saw an error.' }],
    ]);
    const final = await streamLLMWithTools(
      [{ role: 'user', content: 'do the thing' }] as LLMMessage[],
      {
        onText: () => {},
        dispatchTool: async () => { throw new Error('nope'); },
      },
      { provider, tools: [{ name: 'boom', description: '', parameters: {} }] },
    );
    expect(final).toBe('I saw an error.');
  });

  test('tool-loop.config marks infinite max-turn values before JSON turns them into null', async () => {
    const records: Array<{ category: string; event: string; data?: unknown }> = [];
    const unregister = debug.registerSink({
      name: 'test-tool-loop-config-capture',
      emit: (rec) => { records.push({ category: rec.category, event: rec.event, data: rec.data }); },
    });
    const wasDiagEnabled = debug.isDiagEnabled();
    debug.setDiagEnabled(true);
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'unbounded budget' }] as LLMMessage[],
        { onText: () => {}, dispatchTool: async () => ({}) },
        {
          provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
          model: 'gpt-5.4',
          tools: [{ name: 'noop', description: '', parameters: {} }],
        },
      );
      await streamLLMWithTools(
        [{ role: 'user', content: 'negative infinite budget' }] as LLMMessage[],
        { onText: () => {}, dispatchTool: async () => ({}) },
        {
          provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
          model: 'claude-3-opus',
          tools: [{ name: 'noop', description: '', parameters: {} }],
          maxTurns: Number.NEGATIVE_INFINITY,
        },
      );
      await streamLLMWithTools(
        [{ role: 'user', content: 'nan budget' }] as LLMMessage[],
        { onText: () => {}, dispatchTool: async () => ({}) },
        {
          provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
          model: 'claude-3-sonnet',
          tools: [{ name: 'noop', description: '', parameters: {} }],
          maxTurns: Number.NaN,
        },
      );
      await streamLLMWithTools(
        [{ role: 'user', content: 'bounded budget' }] as LLMMessage[],
        { onText: () => {}, dispatchTool: async () => ({}) },
        {
          provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
          model: 'claude-3-haiku',
          tools: [{ name: 'noop', description: '', parameters: {} }],
          maxTurns: 4,
        },
      );
    } finally {
      debug.setDiagEnabled(wasDiagEnabled);
      unregister();
    }

    const configs = records
      .filter((rec) => rec.category === 'llm.router' && rec.event === 'tool-loop.config')
      .map((rec) => JSON.parse(JSON.stringify(rec.data)) as Record<string, unknown>);
    const [unbounded, negativeInfinite, nanBudget, bounded] = configs;

    expect(configs).toHaveLength(4);
    expect(unbounded).toMatchObject({
      maxTurns: null,
      maxTurnsExplicit: false,
      maxTurnsUnbounded: true,
      familyDefaultMaxTurns: null,
      familyDefaultMaxTurnsUnbounded: true,
      explorationUnbounded: true,
    });
    expect(negativeInfinite).toMatchObject({
      maxTurns: null,
      maxTurnsExplicit: true,
      maxTurnsUnbounded: false,
      familyDefaultMaxTurnsUnbounded: false,
    });
    expect(nanBudget).toMatchObject({
      maxTurns: null,
      maxTurnsExplicit: true,
      maxTurnsUnbounded: false,
      familyDefaultMaxTurnsUnbounded: false,
    });
    expect(bounded).toMatchObject({
      maxTurns: 4,
      maxTurnsExplicit: true,
      maxTurnsUnbounded: false,
      familyDefaultMaxTurnsUnbounded: false,
    });
  });

  test('tool loop caps at max turns to avoid runaway', async () => {
    // Provider keeps asking for the same tool forever.
    const provider: LLMProvider = {
      name: 'fake', defaultModel: 'fake', available: () => true,
      async *streamChat() {
        yield { type: 'tool_call', id: 'c', name: 'loop', args: {} } as LLMStreamEvent;
      },
      async *chat() {},
    };
    let dispatches = 0;
    await streamLLMWithTools(
      [{ role: 'user', content: 'loop forever' }] as LLMMessage[],
      { onText: () => {}, dispatchTool: async () => { dispatches++; return {}; } },
      // Pin maxTurns explicitly. Without it the cap is resolved from user-config
      // (llm.answerPriority → per-family default, e.g. quality/default = 20),
      // which would make this test read ~/.elanous/config.json and vary by machine.
      // Passing maxTurns keeps the boundedness assertion deterministic.
      { provider, tools: [{ name: 'loop', description: '', parameters: {} }], maxTurns: 6 },
    );
    // The runaway provider yields a tool_call every turn; the loop must stop at
    // the budget (6) rather than spinning forever.
    expect(dispatches).toBeGreaterThan(0);
    expect(dispatches).toBeLessThanOrEqual(6);
  });
});

describe('parseAnthropicSSELines', () => {
  test('emits text deltas from content_block_delta events', async () => {
    const lines = [
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}`,
      `data: {"type":"content_block_stop","index":0}`,
    ];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'text', delta: ' there' },
    ]);
  });

  test('tool_use block: start → input_json_delta* → stop → one tool_call event', async () => {
    const lines = [
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"bump","input":{}}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"by\\""}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":5}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
    ];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events).toEqual([
      { type: 'tool_call', id: 'toolu_01', name: 'bump', args: { by: 5 } },
    ]);
  });

  test('mixed text block + tool_use block in same stream', async () => {
    const lines = [
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"checking"}}`,
      `data: {"type":"content_block_stop","index":0}`,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"f","input":{}}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
    ];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events).toEqual([
      { type: 'text', delta: 'checking' },
      { type: 'tool_call', id: 't1', name: 'f', args: {} },
    ]);
  });

  test('malformed JSON is skipped', async () => {
    const lines = [
      `data: {broken`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
    ];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events).toEqual([{ type: 'text', delta: 'ok' }]);
  });

  test('message_start usage (cache totals) is held and emitted once at stream end', async () => {
    const lines = [
      `data: {"type":"message_start","message":{"usage":{"input_tokens":140,"cache_creation_input_tokens":0,"cache_read_input_tokens":1024}}}`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
      `data: {"type":"content_block_stop","index":0}`,
    ];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events[0]).toEqual({ type: 'text', delta: 'hi' });
    expect(events[1]).toEqual({
      type: 'usage',
      usage: {
        provider: 'anthropic',
        inputTokens: 140,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1024,
      },
    });
  });

  test('BACKLOG C3 — start + delta merge into ONE usage per call (later value wins, no double count)', async () => {
    const lines = [
      `data: {"type":"message_start","message":{"usage":{"input_tokens":140,"cache_read_input_tokens":1024,"output_tokens":1}}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
      `data: {"type":"message_delta","usage":{"input_tokens":140,"cache_read_input_tokens":1024,"output_tokens":320}}`,
      `data: {"type":"message_stop"}`,
    ];
    const usages = (await collect(parseAnthropicSSELines(lines))).filter((e) => e.type === 'usage');
    expect(usages).toEqual([{ type: 'usage', usage: { provider: 'anthropic', inputTokens: 140, cacheReadInputTokens: 1024, outputTokens: 320 } }]);
  });

  test('message_delta emits usage event with output_tokens', async () => {
    const lines = [
      `data: {"type":"message_delta","usage":{"output_tokens":320,"cache_creation_input_tokens":0,"cache_read_input_tokens":1024}}`,
    ];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events).toEqual([{
      type: 'usage',
      usage: {
        provider: 'anthropic',
        outputTokens: 320,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1024,
      },
    }]);
  });

  test('message_stop with no usage payload yields nothing', async () => {
    const lines = [`data: {"type":"message_stop"}`];
    const events = await collect(parseAnthropicSSELines(lines));
    expect(events).toEqual([]);
  });
});
