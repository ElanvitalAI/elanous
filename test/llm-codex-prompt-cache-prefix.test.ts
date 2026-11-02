// TUI-PROMPT-CACHE-PREFIX — Codex Responses 프롬프트 캐시 프리픽스 고정.
//
// 실측(2026-10-28 · seat-state/OP/tmp/TUI-TOKEN-BURN-ROOT-CAUSE-1028.md): 캐시 적중 ~25%.
//   ① 동적 system(부트 카드·git 스냅샷·메모리·루프 메모)이 전부 `instructions` 로 접혀 매 요청 바뀐다.
//   ② 합성 호출이 tools 를 빼서 tools 배열이 67k → 2자로 바뀐다.
//   ③ prompt_cache_key = 모델 + instructions 앞 500자 → 모든 자리·세션이 한 키. session 헤더 없음.
// 반증: stablePrefix 를 끄면(종전 직렬화) 두 요청의 instructions 가 달라지고, sessionId 를 안 주면
//       키가 세션과 무관해진다 — 아래 «legacy» 시험이 그 차이를 고정한다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  codexStagePromptCacheKey,
  codexSessionCacheKey,
  computePromptCacheKey,
  messagesToResponsesInput,
  streamCodexResponsesEvents,
  streamLLMWithTools,
} from '../src/llm';
import type { LLMMessage, LLMOpts, LLMProvider, LLMStreamEvent } from '../src/llm';
import { debug } from '../src/debug/log';
import { installCodexWireCapture } from '../src/ux-sim/codex-wire-capture';
import type { CodexWireCapture } from '../src/ux-sim/codex-wire-capture';
import { loadMockScenarioCatalog } from '../src/ux-sim/mock-scenario-catalog';

const STABLE = { role: 'system' as const, content: '=== AGENTS.md ===\nstable anchor' };
const volatile = (text: string): LLMMessage => ({ role: 'system', content: text, cacheVolatile: true });

function sessionMessages(turn: number): LLMMessage[] {
  const history: LLMMessage[] = [];
  for (let i = 0; i < turn; i++) {
    history.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
  }
  return [
    STABLE,
    volatile(`[git] HEAD=${turn}abc dirty=${turn}`),
    volatile(`[seat boot] unread=${turn * 3}`),
    ...history,
    { role: 'user', content: `q${turn} 한글🙂` },
  ];
}

describe('messagesToResponsesInput stablePrefix', () => {
  test('two prompts of one session keep instructions byte-identical; volatile goes before the latest user message', () => {
    const a = messagesToResponsesInput(sessionMessages(1), { stablePrefix: true });
    const b = messagesToResponsesInput(sessionMessages(2), { stablePrefix: true });
    expect(a.instructions).toBe(STABLE.content);
    expect(b.instructions).toBe(a.instructions);
    const dev = b.input.at(-2) as { role: string; content: Array<{ text: string }> };
    expect(dev.role).toBe('developer');
    expect(dev.content[0]!.text).toBe('[git] HEAD=2abc dirty=2\n\n[seat boot] unread=6');
    expect((b.input.at(-1) as { role: string }).role).toBe('user');
    // History before the volatile item is a strict prefix-extension of the
    // previous prompt's history (cacheable).
    expect(JSON.stringify(b.input.slice(0, 2))).toBe(JSON.stringify(a.input.slice(0, 2)));
    expect((a.input[0] as { role: string }).role).toBe('user');
  });

  test('mid-conversation system notes stay in place as developer items', () => {
    const messages: LLMMessage[] = [
      STABLE,
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'working' },
      { role: 'system', content: 'Your previous turn produced no text.' },
    ];
    const out = messagesToResponsesInput(messages, { stablePrefix: true });
    expect(out.instructions).toBe(STABLE.content);
    expect(out.input.at(-1)).toEqual({ role: 'developer', content: [{ type: 'input_text', text: 'Your previous turn produced no text.' }] });
  });

  test('a compacted context summary at the start of retained history stays out of cached instructions', () => {
    const summary = (text: string): LLMMessage => ({
      role: 'system',
      content: `<context_summary>\n${text}\n</context_summary>`,
    });
    const a = messagesToResponsesInput([summary('earlier work A'), { role: 'user', content: 'continue' }], { stablePrefix: true });
    const b = messagesToResponsesInput([summary('earlier work B'), { role: 'user', content: 'continue' }], { stablePrefix: true });

    expect(a.instructions).toBe(b.instructions);
    expect(a.input[0]).toEqual({
      role: 'developer',
      content: [{ type: 'input_text', text: '<context_summary>\nearlier work A\n</context_summary>' }],
    });
    expect(b.input[0]).toEqual({
      role: 'developer',
      content: [{ type: 'input_text', text: '<context_summary>\nearlier work B\n</context_summary>' }],
    });
  });

  test('legacy (stablePrefix off) still folds every system message into instructions', () => {
    const a = messagesToResponsesInput(sessionMessages(1));
    const b = messagesToResponsesInput(sessionMessages(2));
    expect(a.instructions).toContain('[git] HEAD=1abc');
    expect(b.instructions).not.toBe(a.instructions);
  });
});

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

async function collect(gen: AsyncGenerator<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function commonPrefixByteLength(left: string, right: string): number {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

test('exact Codex wire mock is registered as its own reusable UX simulation device', () => {
  const device = loadMockScenarioCatalog().devices.find((entry) => entry.id === 'codex-wire-capture');
  expect(device).toMatchObject({
    implementation: ['src/ux-sim/codex-wire-capture.ts'],
    tests: ['test/llm-codex-prompt-cache-prefix.test.ts'],
    logsRecorded: 'no',
  });
});

describe('streamCodexResponsesEvents session cache key', () => {
  let restoreFetch: () => void;
  let calls: CodexWireCapture[];
  let priorRunId: string | undefined;
  beforeEach(() => {
    calls = [];
    restoreFetch = installCodexWireCapture(calls);
    priorRunId = process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_RUN_ID;
  });
  afterEach(() => {
    restoreFetch();
    if (priorRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = priorRunId;
  });

  const TOOLS = [{ type: 'function', name: 'Read', parameters: { type: 'object' } }];
  const send = (turn: number, sessionId?: string) => {
    const { instructions, input } = messagesToResponsesInput(sessionMessages(turn), { stablePrefix: true });
    return collect(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses', 'b',
      { model: 'gpt-5-codex', instructions, input, tools: TOOLS },
      undefined,
      sessionId ? { sessionId } : {},
    ));
  };

  test('one session: identical instructions + tools, same key, session-id header', async () => {
    await send(1, 'sess-A');
    await send(2, 'sess-A');
    const [a, b] = calls;
    expect(b!.body.instructions).toBe(a!.body.instructions);
    expect(JSON.stringify(b!.body.tools)).toBe(JSON.stringify(a!.body.tools));
    expect(a!.body.prompt_cache_key).toBe(codexStagePromptCacheKey('sess-A', a!.body.model, a!.body.tools));
    expect(b!.body.prompt_cache_key).toBe(a!.body.prompt_cache_key);
    expect(a!.headers['session-id']).toBe('sess-A');
    expect(b!.headers['session-id']).toBe('sess-A');
    expect(a!.headers['session_id']).toBeUndefined();
  });

  test('different sessions get different keys', async () => {
    await send(1, 'sess-A');
    await send(1, 'sess-B');
    expect(calls[0]!.body.prompt_cache_key).not.toBe(calls[1]!.body.prompt_cache_key);
    expect(calls[1]!.headers['session-id']).toBe('sess-B');
  });

  test('no session/run id → legacy instructions-prefix key and no header', async () => {
    await send(1);
    expect(calls[0]!.body.prompt_cache_key).toBe(computePromptCacheKey('gpt-5-codex', STABLE.content));
    expect(calls[0]!.headers['session-id']).toBeUndefined();
  });

  test('harness run id is the fallback affinity key', async () => {
    process.env.ELANOUS_RUN_ID = 'run-123';
    await send(1);
    expect(calls[0]!.body.prompt_cache_key).toBe(
      codexStagePromptCacheKey('run-123', calls[0]!.body.model, calls[0]!.body.tools),
    );
    expect(calls[0]!.headers['session-id']).toBe('run-123');
  });

  test('request log carries matching instructions/tools hashes within a session', async () => {
    const previousLevel = debug.level();
    const originalLog = debug.log;
    const logged: Array<Record<string, unknown>> = [];
    debug.setLevel('trail');
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'llm.request' && event.startsWith('POST ')) logged.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    try {
      await send(1, 'sess-A');
      await send(2, 'sess-A');
    } finally {
      debug.log = originalLog;
      debug.setLevel(previousLevel);
    }
    expect(logged).toHaveLength(2);
    expect(logged[0]!.instructionsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(logged[1]!.instructionsHash).toBe(logged[0]!.instructionsHash);
    expect(logged[1]!.toolsHash).toBe(logged[0]!.toolsHash);
    expect(logged[0]!.cacheKeySource).toBe('session-model-tools');
    expect(logged[0]!.sessionHeader).toBe(true);
  });

  test('two mock turns compare the exact request byte prefix and preserve injected cache usage', async () => {
    const restorePriorFetch = installCodexWireCapture(calls, { cachedTokens: 512 });
    const previousLevel = debug.level();
    const originalLog = debug.log;
    const sizeEvents: Array<Record<string, unknown>> = [];
    debug.setLevel('trail');
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'llm.request' && event === 'request-size') sizeEvents.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    let firstEvents: LLMStreamEvent[] = [];
    let secondEvents: LLMStreamEvent[] = [];
    try {
      firstEvents = await send(1, 'sess-mock-prefix');
      secondEvents = await send(2, 'sess-mock-prefix');
    } finally {
      restorePriorFetch();
      debug.log = originalLog;
      debug.setLevel(previousLevel);
    }

    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    const second = calls[1]!;
    expect(first.wireJson).not.toBe(second.wireJson);
    expect(first.body.instructions).toBe(second.body.instructions);
    expect(first.body.tools).toEqual(second.body.tools);
    expect(first.body.prompt_cache_key).toBe(second.body.prompt_cache_key);

    // The exact fetch strings share the stable model/instructions and first
    // two input items. Their next input item differs; no raw prompt is logged.
    const sharedInputItems = JSON.stringify(first.body.input.slice(0, 2)).slice(1, -1);
    const expectedPrefix = `{"model":"gpt-5-codex","instructions":${JSON.stringify(first.body.instructions)},"input":[${sharedInputItems},`;
    const expectedPrefixBytes = Buffer.from(expectedPrefix, 'utf8');
    const actualPrefixBytes = commonPrefixByteLength(first.wireJson, second.wireJson);
    expect(actualPrefixBytes).toBeGreaterThanOrEqual(expectedPrefixBytes.length);
    expect(Buffer.from(first.wireJson, 'utf8').subarray(0, expectedPrefixBytes.length)).toEqual(expectedPrefixBytes);
    expect(Buffer.from(second.wireJson, 'utf8').subarray(0, expectedPrefixBytes.length)).toEqual(expectedPrefixBytes);

    // Fake Responses `response.completed` injection verifies the existing
    // usage normalization path; it is not evidence of provider cache hits.
    for (const events of [firstEvents, secondEvents]) {
      expect(events.find((event) => event.type === 'usage')).toMatchObject({
        type: 'usage', usage: { inputTokens: 1536, outputTokens: 7, cacheReadInputTokens: 512 },
      });
    }

    expect(sizeEvents).toHaveLength(2);
    sizeEvents.forEach((event, index) => {
      const wireJson = calls[index]!.wireJson;
      expect(event).toMatchObject({
        requestChars: wireJson.length,
        requestBytes: Buffer.byteLength(wireJson, 'utf8'),
        requestSha256: createHash('sha256').update(wireJson).digest('hex'),
      });
      expect(event.requestBytes).toBeGreaterThan(event.requestChars);
    });
  });
});

describe('codexSessionCacheKey', () => {
  test('folds long or unsafe ids to a hashed key', () => {
    expect(codexSessionCacheKey('a'.repeat(65), undefined)).toMatchObject({ hashed: true, source: 'session' });
    expect(codexSessionCacheKey('a b', undefined)!.key).toMatch(/^elanous-[0-9a-f]{32}$/);
    expect(codexSessionCacheKey('  ', undefined)).toBeNull();
    expect(codexSessionCacheKey(undefined, 'run-1')).toEqual({ key: 'run-1', source: 'run', hashed: false });
  });
});

describe('final-answer turn keeps the tools array on Codex', () => {
  const TOOLS = [
    { name: 'X', description: 'd', parameters: { type: 'object' } },
    { name: 'update_goal', description: 'terminal', parameters: { type: 'object' } },
  ];
  async function run(providerName: string) {
    const seen: LLMOpts[] = [];
    const turns: LLMStreamEvent[][] = [
      [
        { type: 'text', delta: '확인하겠습니다' },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: 'ok' } },
      ],
      [{ type: 'text', delta: '최종 답입니다.' }],
    ];
    let call = 0;
    const provider: LLMProvider = {
      name: providerName,
      defaultModel: 'gpt-5-codex',
      available: () => true,
      async *streamChat(_messages, opts = {}) {
        seen.push({ ...opts, tools: opts.tools ? [...opts.tools] : opts.tools });
        for (const ev of turns[call++] ?? []) yield ev;
      },
      async *chat() {},
    };
    await streamLLMWithTools([{ role: 'user', content: 'finish' }], {
      onText: () => {},
      dispatchTool: async () => ({ ok: true }),
    }, {
      provider, tools: TOOLS, maxTurns: 10, sessionId: 'sess-A',
      terminalToolNames: ['update_goal'],
      terminalCompletionAccepted: (_name, args) => args.status === 'complete',
    });
    return seen;
  }

  test('openai-codex: same tools + tool_choice none on the final turn', async () => {
    const seen = await run('openai-codex');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools!.map((t) => t.name)).toEqual(seen[0]!.tools!.map((t) => t.name));
    expect(seen[1]!.toolChoice).toBe('none');
    expect(seen[1]!.sessionId).toBe('sess-A');
  });

  test('other providers keep the legacy empty tools on the final turn', async () => {
    const seen = await run('scripted');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toEqual([]);
  });
});
