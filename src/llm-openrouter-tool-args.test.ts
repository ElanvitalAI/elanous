// OR-TOOLARGS-REPAIR (2026-10-10) — OpenRouter tool-call arguments that are not valid JSON
// (truncated at the output limit, or malformed) must NOT run the tool with `{}`.
//   · OpenRouter: broken args → tool_call carries `argsInvalid` → the tool loop does not dispatch,
//     returns the standard dispatch-error result `{ error }` (isError) so the model re-issues the call
//   · finish_reason=length with tool calls → `tool-args-maybe-truncated` observation
//   · valid args → event identical to the pre-fix parser (byte-identical)
//   · other providers (grok · openai compat) → unchanged: broken args still become `{}` with no flag
// Fake fetch via spyOn (never mock.module) · no network.
import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import {
  buildInvalidToolArgsMessage, getProviderForConfig, parseOpenAISSELines, streamLLMWithTools,
  type LLMMessage, type LLMProvider, type LLMStreamEvent, type LLMToolSpec,
} from './llm.js';
import type { UserConfig } from './user-config.js';

const tools: LLMToolSpec[] = [{ name: 'Write', description: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }];

const sse = (argsChunks: string[], finishReason: string): string[] => [
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Write', arguments: '' } }] } }] })}`,
  ...argsChunks.map((a) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a } }] } }] })}`),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}`,
  'data: [DONE]',
];
const BROKEN = ['{"file_path":"/tmp/a.ts","content":"export const x', ' = 1;\\nexport const y'];
const VALID = ['{"file_path":"/tmp/a.ts",', '"content":"ok"}'];

async function collect(gen: AsyncGenerator<LLMStreamEvent, void, unknown>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function captureLogs() {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    logs.push({ category, event, data });
  }) as typeof debug.log);
  return { logs, restore: () => spy.mockRestore() };
}

// ── parser ────────────────────────────────────────────────────────────────────

test('parser (OpenRouter flag): truncated args at finish_reason=length → args {} ⊕ argsInvalid ⊕ observations', async () => {
  const { logs, restore } = captureLogs();
  try {
    const evs = await collect(parseOpenAISSELines(sse(BROKEN, 'length'), { flagInvalidToolArgs: true }));
    const chars = BROKEN.join('').length;
    expect(evs).toEqual([{ type: 'tool_call', id: 'c1', name: 'Write', args: {}, argsInvalid: { chars, finishReason: 'length' } }]);
    const invalid = logs.filter((l) => l.event === 'tool-args-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.category).toBe('llm.openrouter');
    expect(invalid[0]!.data).toMatchObject({ tool: 'Write', chars, finishReason: 'length' });
    expect(String(invalid[0]!.data.head).length).toBeLessThanOrEqual(60);
    const trunc = logs.filter((l) => l.event === 'tool-args-maybe-truncated');
    expect(trunc).toHaveLength(1);
    expect(trunc[0]!.data).toMatchObject({ finishReason: 'length', tools: ['Write'], chars: [chars] });
  } finally {
    restore();
  }
});

test('parser (OpenRouter flag): malformed args at finish_reason=tool_calls → argsInvalid with that reason', async () => {
  const { logs, restore } = captureLogs();
  try {
    const evs = await collect(parseOpenAISSELines(sse(['{"file_path": oops}'], 'tool_calls'), { flagInvalidToolArgs: true }));
    expect(evs).toEqual([{ type: 'tool_call', id: 'c1', name: 'Write', args: {}, argsInvalid: { chars: 19, finishReason: 'tool_calls' } }]);
    expect(logs.filter((l) => l.event === 'tool-args-maybe-truncated')).toHaveLength(0);
  } finally {
    restore();
  }
});

test('parser (OpenRouter flag): valid args at finish_reason=length → executes normally, only a truncation observation', async () => {
  const { logs, restore } = captureLogs();
  try {
    const flagged = await collect(parseOpenAISSELines(sse(VALID, 'length'), { flagInvalidToolArgs: true }));
    const plain = await collect(parseOpenAISSELines(sse(VALID, 'length')));
    expect(flagged).toEqual([{ type: 'tool_call', id: 'c1', name: 'Write', args: { file_path: '/tmp/a.ts', content: 'ok' } }]);
    expect(JSON.stringify(flagged)).toBe(JSON.stringify(plain));
    expect(logs.filter((l) => l.event === 'tool-args-maybe-truncated')).toHaveLength(1);
    expect(logs.filter((l) => l.event === 'tool-args-invalid')).toHaveLength(0);
  } finally {
    restore();
  }
});

test('parser invariant: valid args, normal finish → flagged output byte-identical to the unflagged parser', async () => {
  const flagged = await collect(parseOpenAISSELines(sse(VALID, 'tool_calls'), { flagInvalidToolArgs: true }));
  const plain = await collect(parseOpenAISSELines(sse(VALID, 'tool_calls')));
  expect(JSON.stringify(flagged)).toBe(JSON.stringify(plain));
});

test('parser invariant: without the flag, broken args still collapse to {} with no argsInvalid and no observation', async () => {
  const { logs, restore } = captureLogs();
  try {
    const evs = await collect(parseOpenAISSELines(sse(BROKEN, 'length')));
    expect(evs).toEqual([{ type: 'tool_call', id: 'c1', name: 'Write', args: {} }]);
    expect(logs.filter((l) => l.event === 'tool-args-invalid' || l.event === 'tool-args-maybe-truncated')).toHaveLength(0);
  } finally {
    restore();
  }
});

// ── provider wiring (fake fetch) ──────────────────────────────────────────────

async function streamFrom(llm: Record<string, unknown>, lines: string[]): Promise<LLMStreamEvent[]> {
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async () =>
    new Response(lines.map((l) => `${l}\n\n`).join(''), { status: 200 })) as unknown as typeof fetch);
  try {
    const provider = getProviderForConfig({ llm } as unknown as UserConfig);
    return await collect(provider.streamChat!([{ role: 'user', content: 'hi' }], { tools }));
  } finally {
    mock.mockRestore();
  }
}

test('provider: OpenRouter stream flags broken tool args', async () => {
  const evs = await streamFrom({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-key' }, sse(BROKEN, 'length'));
  const calls = evs.filter((e) => e.type === 'tool_call');
  expect(calls).toHaveLength(1);
  expect((calls[0] as any).argsInvalid).toEqual({ chars: BROKEN.join('').length, finishReason: 'length' });
});

test('invariant: grok and openai compat streams keep the old {} behaviour (no argsInvalid)', async () => {
  for (const llm of [
    { provider: 'grok', model: 'grok-4.7', apiKey: 'xai-test' },
    { provider: 'openai', model: 'gpt-5.6', apiKey: 'sk-test' },
  ]) {
    const evs = await streamFrom(llm, sse(BROKEN, 'length'));
    expect(evs.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'c1', name: 'Write', args: {} }]);
  }
});

// ── tool loop ─────────────────────────────────────────────────────────────────

const loopTools: LLMToolSpec[] = [{ name: 'Lookup', description: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }];

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let i = 0;
  return {
    name: 'openrouter',
    defaultModel: 'openrouter/z-ai/glm-5.3',
    available: () => true,
    async *streamChat() { for (const ev of turns[i++] ?? []) yield ev; },
    async *chat() { /* unused */ },
  } as LLMProvider;
}

test('tool loop: argsInvalid call is NOT dispatched; an {error} result goes back and the model can retry', async () => {
  const dispatched: Array<{ name: string; args: unknown }> = [];
  const results: Array<{ name: string; result: unknown }> = [];
  const argsInvalid = { chars: 57, finishReason: 'length' };
  const { logs, restore } = captureLogs();
  let final: string;
  try {
    final = await streamLLMWithTools(
      [{ role: 'user', content: 'write the file' }] as LLMMessage[],
      {
        onText: () => {},
        dispatchTool: async (name, args) => { dispatched.push({ name, args }); return { ok: true }; },
        onToolResult: (r) => { results.push({ name: r.name, result: r.result }); },
      },
      {
        provider: fakeProvider([
          [{ type: 'tool_call', id: 'c1', name: 'Lookup', args: {}, argsInvalid }],
          [{ type: 'tool_call', id: 'c2', name: 'Lookup', args: { q: 'a' } }],
          [{ type: 'text', delta: 'done' }],
        ]),
        tools: loopTools,
      },
    );
  } finally {
    restore();
  }
  expect(final).toBe('done');
  // Only the re-issued (valid) call ran.
  expect(dispatched).toEqual([{ name: 'Lookup', args: { q: 'a' } }]);
  expect(results[0]).toEqual({ name: 'Lookup', result: { error: buildInvalidToolArgsMessage(argsInvalid) } });
  expect(String((results[0]!.result as { error: string }).error)).toContain('NOT executed');
  expect(logs.filter((l) => l.event === 'tool-loop.tool-args-invalid.blocked')[0]?.data).toMatchObject({ tool: 'Lookup', chars: 57, finishReason: 'length' });
});

test('tool loop invariant: a call without argsInvalid dispatches exactly as before', async () => {
  const dispatched: unknown[] = [];
  await streamLLMWithTools(
    [{ role: 'user', content: 'x' }] as LLMMessage[],
    { onText: () => {}, dispatchTool: async (_n, args) => { dispatched.push(args); return {}; } },
    {
      provider: fakeProvider([[{ type: 'tool_call', id: 'c1', name: 'Lookup', args: {} }], [{ type: 'text', delta: 'ok' }]]),
      tools: loopTools,
    },
  );
  expect(dispatched).toEqual([{}]);
});

test('message: names the length cut and the retry instruction', () => {
  expect(buildInvalidToolArgsMessage({ chars: 10, finishReason: 'length' })).toContain('finish_reason=length');
  expect(buildInvalidToolArgsMessage({ chars: 10, finishReason: null })).toContain('Re-issue the call');
});
