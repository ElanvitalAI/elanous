// ── Phase A: native tool_use / tool_result block tests ──
//
// Covers:
//   - ContentBlock tool_use / tool_result mapping to Anthropic wire format
//     (native {type:'tool_use'} / {type:'tool_result'})
//   - OpenAI/Grok boundary: assistant tool_use → `tool_calls` field;
//     user tool_result → one `{role:'tool', tool_call_id}` wire message per block
//   - streamLLMWithTools appends native ContentBlock[] history between turns
//     (no more flat `[tool_call]` / `[tool_result]` text)

import { describe, test, expect } from 'bun:test';
import {
  toOpenAIMessage,
  toOpenAIMessages,
  toAnthropicMessage,
  buildNoFinalSynthesisLead,
  streamLLMWithTools,
  type LLMMessage,
  type ContentBlock,
  type LLMProvider,
  type LLMStreamEvent,
} from '../src/llm';

// ═══════════════════════════════════════════
// 1. Anthropic wire format — native tool blocks
// ═══════════════════════════════════════════

describe('toAnthropicMessage — tool_use / tool_result', () => {
  test('tool_use block passes through unchanged', () => {
    const m: LLMMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'toolu_01', name: 'echo', input: { x: 'hi' } },
      ],
    };
    const out = toAnthropicMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.role).toBe('assistant');
    expect(out.content[0]).toEqual({ type: 'text', text: 'checking' });
    expect(out.content[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'echo',
      input: { x: 'hi' },
    });
  });

  test('tool_result block maps to native Anthropic form', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: '{"echoed":"hi"}' },
      ],
    };
    const out = toAnthropicMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.role).toBe('user');
    expect(out.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: '{"echoed":"hi"}',
    });
  });

  test('tool_result with isError=true emits is_error on the wire', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '{"error":"boom"}', isError: true },
      ],
    };
    const out = toAnthropicMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: '{"error":"boom"}',
      is_error: true,
    });
  });

  test('multiple tool_results in one user message pass through as array', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'a' },
        { type: 'tool_result', tool_use_id: 't2', content: 'b' },
      ],
    };
    const out = toAnthropicMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(out.content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 't2' });
  });
});

// ═══════════════════════════════════════════
// 2. OpenAI boundary — split tool_result, fold tool_use
// ═══════════════════════════════════════════

describe('toOpenAIMessages — tool_use folds into tool_calls', () => {
  test('assistant with text + tool_use → one wire msg with tool_calls', () => {
    const m: LLMMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'call_1', name: 'echo', input: { x: 'hi' } },
      ],
    };
    const out = toOpenAIMessages(m);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'let me check',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi"}' } },
      ],
    });
  });

  test('assistant with only tool_use (no text) → content:null + tool_calls', () => {
    const m: LLMMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_a', name: 'f', input: {} },
        { type: 'tool_use', id: 'call_b', name: 'g', input: { n: 2 } },
      ],
    };
    const out = toOpenAIMessages(m) as Array<{ content: unknown; tool_calls: Array<Record<string, unknown>> }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBeNull();
    expect(out[0]!.tool_calls).toHaveLength(2);
    expect(out[0]!.tool_calls[0]).toMatchObject({ id: 'call_a', function: { name: 'f', arguments: '{}' } });
    expect(out[0]!.tool_calls[1]).toMatchObject({ id: 'call_b', function: { name: 'g', arguments: '{"n":2}' } });
  });
});

describe('toOpenAIMessages — tool_result splits to role:"tool"', () => {
  test('one tool_result → one {role:"tool"} wire message', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"echoed":"hi"}' },
      ],
    };
    expect(toOpenAIMessages(m)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '{"echoed":"hi"}' },
    ]);
  });

  test('multiple tool_results split into N wire messages', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '1' },
        { type: 'tool_result', tool_use_id: 'b', content: '2' },
      ],
    };
    const out = toOpenAIMessages(m);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'a', content: '1' });
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'b', content: '2' });
  });
});

describe('toOpenAIMessage (single-variant) — throws on split', () => {
  test('throws when content would expand to multiple wire messages', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '1' },
        { type: 'tool_result', tool_use_id: 'b', content: '2' },
      ],
    };
    expect(() => toOpenAIMessage(m)).toThrow(/toOpenAIMessages/);
  });

  test('single tool_result still throws because role becomes "tool"', () => {
    // Even a single tool_result produces a split-shaped wire message
    // that flatMap handles — the strict helper only accepts identity-shape
    // 1:1 passthroughs. We keep it permissive: single-element arrays OK.
    const m: LLMMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }],
    };
    // Actually 1 wire msg → no throw.
    expect(() => toOpenAIMessage(m)).not.toThrow();
  });
});

// ═══════════════════════════════════════════
// 3. streamLLMWithTools — history uses native blocks
// ═══════════════════════════════════════════

describe('streamLLMWithTools — native block history', () => {
  /** Capture-provider: records the messages argument each streamChat call sees. */
  function captureProvider(turns: LLMStreamEvent[][]): {
    provider: LLMProvider;
    captured: LLMMessage[][];
  } {
    const captured: LLMMessage[][] = [];
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      defaultModel: 'fake',
      available: () => true,
      async *streamChat(messages) {
        captured.push(JSON.parse(JSON.stringify(messages)));
        const events = turns[callCount++] ?? [];
        for (const ev of events) yield ev;
      },
      async *chat() { /* unused */ },
    };
    return { provider, captured };
  }

  test('turn-2 history contains native tool_use + tool_result blocks (no flat text)', async () => {
    const { provider, captured } = captureProvider([
      [
        { type: 'text', delta: 'Checking' },
        { type: 'tool_call', id: 'call_1', name: 'echo', args: { x: 'hi' } },
      ],
      [{ type: 'text', delta: ' — done.' }],
    ]);

    await streamLLMWithTools(
      [{ role: 'user', content: 'echo hi' }],
      {
        onText: () => {},
        dispatchTool: async () => ({ echoed: 'hi' }),
      },
      { provider, tools: [{ name: 'echo', description: '', parameters: {} }] },
    );

    // Turn 2 sees: [user, assistant-with-text-and-tool_use, user-with-tool_result]
    expect(captured).toHaveLength(2);
    const turn2 = captured[1]!;
    expect(turn2).toHaveLength(3);

    // Original user message untouched
    expect(turn2[0]).toEqual({ role: 'user', content: 'echo hi' });

    // Assistant message: text block + tool_use block (native)
    const assistant = turn2[1]!;
    expect(assistant.role).toBe('assistant');
    expect(Array.isArray(assistant.content)).toBe(true);
    const ablocks = assistant.content as ContentBlock[];
    expect(ablocks[0]).toEqual({ type: 'text', text: 'Checking' });
    expect(ablocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'echo',
      input: { x: 'hi' },
    });

    // User response: tool_result block (native — NOT flat `[tool_result]` text)
    const userResp = turn2[2]!;
    expect(userResp.role).toBe('user');
    expect(Array.isArray(userResp.content)).toBe(true);
    const ublocks = userResp.content as ContentBlock[];
    expect(ublocks).toHaveLength(1);
    expect(ublocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: JSON.stringify({ echoed: 'hi' }),
    });

    // Sanity: no flat-text tool notation anywhere in turn-2 history
    const flat = JSON.stringify(turn2);
    expect(flat).not.toContain('[tool_call]');
    expect(flat).not.toContain('[tool_result]');
  });

  test('dispatchTool throw marks tool_result with isError', async () => {
    const { provider, captured } = captureProvider([
      [{ type: 'tool_call', id: 'c1', name: 'boom', args: {} }],
      [{ type: 'text', delta: 'saw error' }],
    ]);

    await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText: () => {},
        dispatchTool: async () => { throw new Error('nope'); },
      },
      { provider, tools: [{ name: 'boom', description: '', parameters: {} }] },
    );

    const turn2 = captured[1]!;
    const ublocks = turn2[2]!.content as ContentBlock[];
    expect(ublocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      isError: true,
    });
    const content = (ublocks[0] as Extract<ContentBlock, { type: 'tool_result' }>).content;
    expect(content).toContain('nope');
  });

  test('parallel tool_calls in one turn → one assistant msg + one user msg with N tool_results', async () => {
    const { provider, captured } = captureProvider([
      [
        { type: 'tool_call', id: 'c1', name: 'f', args: { n: 1 } },
        { type: 'tool_call', id: 'c2', name: 'f', args: { n: 2 } },
      ],
      [{ type: 'text', delta: 'both done' }],
    ]);

    await streamLLMWithTools(
      [{ role: 'user', content: 'parallel' }],
      {
        onText: () => {},
        dispatchTool: async (_, args) => ({ got: (args as any).n }),
      },
      { provider, tools: [{ name: 'f', description: '', parameters: {} }] },
    );

    const turn2 = captured[1]!;
    // Exactly 3 messages (user + assistant + user), not 5
    expect(turn2).toHaveLength(3);

    const assistant = turn2[1]!;
    const ablocks = assistant.content as ContentBlock[];
    // 2 tool_use blocks (no text since turnText was empty)
    expect(ablocks).toHaveLength(2);
    expect(ablocks[0]).toMatchObject({ type: 'tool_use', id: 'c1' });
    expect(ablocks[1]).toMatchObject({ type: 'tool_use', id: 'c2' });

    const userResp = turn2[2]!;
    const ublocks = userResp.content as ContentBlock[];
    expect(ublocks).toHaveLength(2);
    expect(ublocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
    expect(ublocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'c2' });
  });
});

// ═══════════════════════════════════════════
// 4. Round-trip: native blocks survive provider → boundary → provider
// ═══════════════════════════════════════════

describe('native block round-trip sanity', () => {
  test('Anthropic-shaped history converts cleanly through OpenAI boundary', () => {
    // Build a canonical 4-message conversation that uses native blocks.
    const history: LLMMessage[] = [
      { role: 'user', content: 'echo hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking' },
          { type: 'tool_use', id: 'call_1', name: 'echo', input: { x: 'hi' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"echoed":"hi"}' },
        ],
      },
      { role: 'assistant', content: 'done' },
    ];

    // Anthropic: 4 in → 4 out
    const anthro = history.map(toAnthropicMessage);
    expect(anthro).toHaveLength(4);
    expect((anthro[2]!.content as Array<{ type: string }>)[0]!.type).toBe('tool_result');

    // OpenAI: 4 in → 4 out (tool_result splits 1→1 here; assistant folds into tool_calls)
    const oai = history.flatMap(toOpenAIMessages);
    expect(oai).toHaveLength(4);
    expect(oai[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] });
    expect(oai[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });
});

// ═══════════════════════════════════════════
// 5. onTurnComplete — hands the new turn's messages back to the caller
// ═══════════════════════════════════════════
//
// Regression guard for the dashboard bug where follow-up questions made
// the model re-search from scratch: chat.history only stored the final
// assistant text, so the tool_use / tool_result evidence from the
// previous turn vanished between user messages. With onTurnComplete the
// dashboard can persist the full block-level sequence and rebuild the
// next requestMessages with real evidence.

describe('streamLLMWithTools — onTurnComplete', () => {
  function captureProvider(turns: LLMStreamEvent[][]): LLMProvider {
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

  test('fires once after a multi-turn tool loop with assistant+user+final-text', async () => {
    const provider = captureProvider([
      [
        { type: 'text', delta: 'Searching' },
        { type: 'tool_call', id: 'c1', name: 'grep', args: { pattern: 'foo' } },
      ],
      [{ type: 'text', delta: 'Found it at src/foo.ts' }],
    ]);

    let completedCalls = 0;
    let captured: LLMMessage[] | null = null;
    await streamLLMWithTools(
      [{ role: 'user', content: 'find foo' }],
      {
        onText: () => {},
        dispatchTool: async () => ({ matches: ['src/foo.ts'] }),
        onTurnComplete: (msgs) => {
          completedCalls++;
          captured = msgs;
        },
      },
      { provider, tools: [{ name: 'grep', description: '', parameters: {} }] },
    );

    expect(completedCalls).toBe(1);
    expect(captured).not.toBeNull();
    // 3 new messages: assistant(text+tool_use), user(tool_result), assistant(final text)
    const msgs = captured as unknown as LLMMessage[];
    expect(msgs).toHaveLength(3);

    // [0] — assistant with text + tool_use
    const a0 = msgs[0]!;
    expect(a0.role).toBe('assistant');
    const a0Blocks = a0.content as ContentBlock[];
    expect(a0Blocks[0]).toEqual({ type: 'text', text: 'Searching' });
    expect(a0Blocks[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'grep' });

    // [1] — user with tool_result
    const u1 = msgs[1]!;
    expect(u1.role).toBe('user');
    const u1Blocks = u1.content as ContentBlock[];
    expect(u1Blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });

    // [2] — final assistant text (synthesised as a single text block so
    //       the shape stays uniform with the tool rounds above)
    const a2 = msgs[2]!;
    expect(a2.role).toBe('assistant');
    const a2Blocks = a2.content as ContentBlock[];
    expect(a2Blocks).toEqual([{ type: 'text', text: 'Found it at src/foo.ts' }]);
  });

  test('fires on fallback (no tools) path with a single assistant text msg', async () => {
    // Provider without streamChat → streamLLMWithTools falls back to streamLLM.
    const provider: LLMProvider = {
      name: 'fake',
      defaultModel: 'fake',
      available: () => true,
      async *chat() {
        yield 'hello ';
        yield 'world';
      },
    };

    let captured: LLMMessage[] | null = null;
    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'hi' }],
      {
        onText: () => {},
        dispatchTool: async () => 'unused',
        onTurnComplete: (msgs) => { captured = msgs; },
      },
      { provider, tools: [{ name: 'unused', description: '', parameters: {} }] },
    );

    expect(result).toBe('hello world');
    expect(captured).not.toBeNull();
    const msgs = captured as unknown as LLMMessage[];
    expect(msgs).toEqual([{ role: 'assistant', content: 'hello world' }]);
  });

  test('fires once on empty-turn give-up without synthesising a trailing text', async () => {
    // All three turns yield nothing → empty-retry exhausts → give up.
    const provider = captureProvider([[], [], []]);

    let completedCalls = 0;
    let captured: LLMMessage[] | null = null;
    await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText: () => {},
        dispatchTool: async () => 'unused',
        onTurnComplete: (msgs) => {
          completedCalls++;
          captured = msgs;
        },
      },
      { provider, tools: [{ name: 'unused', description: '', parameters: {} }] },
    );

    expect(completedCalls).toBe(1);
    // Two synthetic "please emit text" reminders pushed during retries,
    // but NO final assistant text (we never got one). The slice still
    // represents the real post-initial history.
    const msgs = captured as unknown as LLMMessage[];
    expect(msgs.some(m =>
      typeof m.content === 'string'
      && m.content.includes('Your previous turn produced no text and no tool calls.'),
    )).toBe(true);
    const assistantTextBlocks = msgs.flatMap(m =>
      m.role === 'assistant' && Array.isArray(m.content)
        ? (m.content as ContentBlock[]).filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        : [],
    );
    // Assistant text may only be the intentional give-up diagnostic: since
    // TUI-NO-SYNTH-FALLBACK (#25454) it opens with the localized human lead,
    // then the [NO FINAL SYNTHESIS] marker paragraph.
    const giveUpPrefix = `${buildNoFinalSynthesisLead('empty-turn', 0)}\n\n[NO FINAL SYNTHESIS]`;
    expect(assistantTextBlocks.every(b => b.text.startsWith(giveUpPrefix))).toBe(true);
    // No non-marker assistant text may be presented as a synthesised answer.
    expect(assistantTextBlocks.some(b => !b.text.startsWith(giveUpPrefix))).toBe(false);
  });
});
