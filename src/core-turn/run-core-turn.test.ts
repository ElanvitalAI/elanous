import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LLMMessage, LLMToolSpec, StreamWithToolsHandlers } from '../llm.js';
import * as llmModule from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { debug } from '../debug/log.js';
import { requestsNamedSkill, runCoreTurn } from './run-core-turn.js';
import type { CoreTurnContext, CoreTurnResult } from './types.js';

const tool: LLMToolSpec = {
  name: 'Read',
  description: 'Read a file',
  parameters: { type: 'object', properties: {} },
};

const signal = new AbortController().signal;
let surfaceUserText: string | undefined;
let deferredUserText: string | undefined;

beforeEach(() => {
  surfaceUserText = undefined;
  deferredUserText = undefined;
  spyOn(llmModule, 'streamLLMWithTools').mockResolvedValue('done');
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(({ userText } = {}) => {
    surfaceUserText = userText;
    return {
      id: 'default',
      selectionReason: 'test',
      baselineContexts: [],
      defaultFamilies: [],
      conditionalFamilies: [],
    } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>;
  });
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools, options = {}) => {
    deferredUserText = options.userText;
    return {
      messages: [...messages],
      tools: [...tools],
      stats: {
        activeCount: tools.length,
        deferredCount: 0,
        warmPreloaded: [],
        injected: false,
        deferredNames: [],
        unhydratableNames: [],
        unhydratableCount: 0,
      },
    } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>;
  });
});

afterEach(() => mock.restore());

describe('named installed skill research routing', () => {
  test.each([
    ['CEO original', 'omni crawl 로 grokbot 사용사례를 찾아주고 elanous 와 어떤 연계를 하면 될까요?', true],
    ['hyphenated slug', 'omni-crawl 로 사용사례를 찾아줘', true],
    ['spaced slug', 'omni crawl로 사용사례를 조사해줘', true],
    ['concatenated slug', 'omnicrawl으로 사례를 정리해줘', true],
    ['installed skill without action', 'omni crawl 에 대해 알려줘', false],
    ['uninstalled slug', 'other-crawl 로 사용사례를 찾아줘', false],
    ['no skill name', 'grokbot 사용사례를 찾아줘', false],
  ])('%s', (_name, prompt, expected) => {
    expect(requestsNamedSkill(prompt, ['omni-crawl'])).toBe(expected);
  });

  test('the CEO original prompt bypasses the text-only research pre-answer when skill_exec is available', async () => {
    const prompt = 'omni crawl 로 grokbot 사용사례를 찾아주고 elanous 와 어떤 연계를 하면 될까요?';
    const statuses: string[] = [];
    const events: string[] = [];
    let researchCalls = 0;
    let researchTurn: boolean | undefined;
    let toolChoice: unknown;
    let selectedTools: string[] = [];
    let firstTurnTools: string[] = [];
    const routeEvents: Record<string, unknown>[] = [];
    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'research.turn' && event === 'named-skill-route-first') {
        routeEvents.push(data as Record<string, unknown>);
      }
    });
    let answerGuidance: string | undefined;
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, opts) => {
      events.push('llm');
      answerGuidance = _messages.find((message) => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('<research-answer-guidance>'))?.content as string | undefined;
      researchTurn = opts?.researchTurn;
      toolChoice = opts?.toolChoice;
      selectedTools = opts?.tools?.map((candidate) => candidate.name) ?? [];
      firstTurnTools = opts?.firstTurnTools?.map((candidate) => candidate.name) ?? [];
      return 'done';
    });
    await runCoreTurn({
      sessionId: 'named-skill-first-routing',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ ...tool, name: 'skill_exec' }, { ...tool, name: 'WebSearch' }],
      dispatchTool: async () => null,
      signal,
      userText: prompt,
      callbacks: { onStatus: (line) => { statuses.push(line); events.push('status'); } },
    }, { runResearch: async () => {
      researchCalls += 1;
      return { ok: true, output: 'mock evidence' };
    } });
    expect(researchTurn).toBe(true);
    expect(toolChoice).toEqual({ name: 'skill_exec' });
    expect(selectedTools).toEqual(['skill_exec', 'WebSearch']);
    expect(firstTurnTools).toEqual(['skill_exec']);
    expect(routeEvents).toEqual([expect.objectContaining({
      requestedSkillName: 'omni-crawl', selectedTool: 'skill_exec', availableToolNames: ['skill_exec'],
    })]);
    expect(answerGuidance).toContain('작은 후속 작업은 추가 질문 없이 현재 턴에서 먼저 처리한다.');
    expect(answerGuidance).toContain('답은 결론(무엇을 찾았고 무엇을 해 두었는지)을 먼저 말하고, 근거를 짧게 덧붙인다.');
    expect(answerGuidance).toContain('비용·외부 노출·되돌리기 어려움이 큰 다음 단계만 그 하나를 확인한다. 그 밖에는 묻지 않는다.');
    expect(answerGuidance).toContain('다음 할 일 목록을 형식으로 요구하지 않는다.');
    expect(answerGuidance).toContain('질문에 필요한 만큼 읽기 좋게 설명하며, 고정 줄 수나 글자 수로 자르지 않는다.');
    expect(answerGuidance).not.toContain('추천 하나');
    expect(researchCalls).toBe(0);
    expect(statuses).toEqual(['omni-crawl (skill_exec)로 질문에 나온 주제와 요구 조건의 근거를 찾습니다.\n출처의 주장과 제약을 비교해 확인된 사실을 가립니다.\n확인한 결론과 짧은 근거로 답합니다.']);
    expect(statuses[0]!.split('\n')).toHaveLength(3);
    expect(events).toEqual(['status', 'llm']);
    expect(statuses).not.toContain('먼저 답변을 시작하고 근거를 확인합니다.');
  });

  test('CEO original research answer keeps a readable 45-line mock intact without a forced next-step section', async () => {
    const prompt = 'omni crawl 로 grokbot 사용사례를 찾아주고 elanous 와 어떤 연계를 하면 될까요?';
    const answer = [
      '결론: elanous 연계는 MCP 연결이 가장 빠르고, 로컬 CLI는 터널이 필요합니다.',
      '[근거](https://example.test/docs) — 공식 문서의 연결 방식입니다.',
      ...Array.from({ length: 43 }, (_, index) => `세부 근거 ${index + 1}: 질문 범위 안의 비교 자료와 제약입니다.`),
    ].join('\n');
    let guidance: string | undefined;
    let researchCalls = 0;
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages) => {
      guidance = messages.find((message) => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('<research-answer-guidance>'))?.content as string | undefined;
      return answer;
    });
    const result = await runCoreTurn({
      sessionId: 'research-answer-budget-no-truncation',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ ...tool, name: 'skill_exec' }, { ...tool, name: 'WebSearch' }],
      dispatchTool: async () => null,
      signal,
      userText: prompt,
    }, { runResearch: async () => { researchCalls += 1; return { ok: true, output: 'mock evidence' }; } });
    expect(guidance).toContain('작은 후속 작업은 추가 질문 없이 현재 턴에서 먼저 처리한다.');
    expect(guidance).toContain('답은 결론(무엇을 찾았고 무엇을 해 두었는지)을 먼저 말하고, 근거를 짧게 덧붙인다.');
    expect(guidance).toContain('다음 할 일 목록을 형식으로 요구하지 않는다.');
    expect(guidance).toContain('고정 줄 수나 글자 수로 자르지 않는다.');
    expect(answer.split('\n')).toHaveLength(45);
    expect(researchCalls).toBe(0);
    expect(result.finalText).toBe(answer);
    expect(result.finalText).not.toContain('다음 할 일:');
  });

  test('generic research opening plan names the available research tools and output', async () => {
    const prompt = 'grokbot 사용사례를 여러 소스로 조사하고 elanous 연계 방법을 비교해줘';
    const statuses: string[] = [];
    const events: string[] = [];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async () => { events.push('llm'); return 'done'; });
    await runCoreTurn({
      sessionId: 'research-opening-plan-tools',
      messages: [{ role: 'user', content: prompt }],
      tools: [
        { ...tool, name: 'MsgList' }, { ...tool, name: 'WebFetch' }, { ...tool, name: 'Agent' },
        { ...tool, name: 'Read' }, { ...tool, name: 'OmniSearch' }, { ...tool, name: 'memory_recall' },
        { ...tool, name: 'Write' },
      ],
      dispatchTool: async () => null,
      signal,
      userText: prompt,
      callbacks: { onStatus: (line) => { statuses.push(line); events.push('status'); } },
    }, { runResearch: async () => ({ ok: false, output: '' }) });
    expect(statuses[0]).toBe('OmniSearch → WebFetch → Agent → Read → memory_recall → MsgList로 질문에 나온 주제와 요구 조건의 근거를 찾습니다.\n출처의 주장과 제약을 비교해 확인된 사실을 가립니다.\n확인한 결론과 짧은 근거로 답합니다.');
    expect(statuses[0]!.split('\n')).toHaveLength(3);
    expect(events[0]).toBe('status');
  });

  test('named skill request keeps the full pool when skill_exec is unavailable', async () => {
    const prompt = 'omni crawl 로 grokbot 사용사례를 찾아주고 elanous 와 어떤 연계를 하면 될까요?';
    let receivedTools: string[] = [];
    let firstTurnTools: string[] | undefined;
    let toolChoice: unknown;
    const statuses: string[] = [];
    const routeEvents: Record<string, unknown>[] = [];
    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'research.turn' && event === 'named-skill-route-first') {
        routeEvents.push(data as Record<string, unknown>);
      }
    });
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, opts) => {
      receivedTools = opts?.tools?.map((candidate) => candidate.name) ?? [];
      firstTurnTools = opts?.firstTurnTools?.map((candidate) => candidate.name);
      toolChoice = opts?.toolChoice;
      return 'done';
    });
    await runCoreTurn({
      sessionId: 'named-skill-missing-executor-fallback',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ ...tool, name: 'FallbackTool' }, { ...tool, name: 'Read' }],
      dispatchTool: async () => null,
      signal,
      userText: prompt,
      callbacks: { onStatus: (line) => statuses.push(line) },
    }, { runResearch: async () => ({ ok: false, output: '' }) });
    expect(receivedTools).toEqual(['FallbackTool', 'Read']);
    expect(firstTurnTools).toBeUndefined();
    expect(toolChoice).toBeUndefined();
    expect(routeEvents).toEqual([]);
    expect(statuses[0]).toBe('Read로 질문에 나온 주제와 요구 조건의 근거를 찾습니다.\n출처의 주장과 제약을 비교해 확인된 사실을 가립니다.\n확인한 결론과 짧은 근거로 답합니다.');
  });

  test('research opening plan does not claim tools are available when the pool is empty', async () => {
    const prompt = 'grokbot 사례를 여러 소스로 조사해줘';
    const statuses: string[] = [];
    await runCoreTurn({
      sessionId: 'research-opening-plan-no-tools',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      dispatchTool: async () => null,
      signal,
      userText: prompt,
      callbacks: { onStatus: (line) => statuses.push(line) },
    }, { runResearch: async () => ({ ok: false, output: '' }) });
    expect(statuses[0]).toBe('현재 사용할 수 있는 조사 도구가 없습니다.\n근거를 확인할 수 없어 결론을 단정하지 않습니다.\n도구가 활성화되면 출처를 확인해 답합니다.');
    expect(statuses[0]!.split('\n')).toHaveLength(3);
  });
});

async function run(messages: LLMMessage[], userText?: string): Promise<void> {
  await runCoreTurn({
    sessionId: 'surface-selection-test',
    messages,
    tools: [tool],
    dispatchTool: async () => null,
    signal,
    ...(userText !== undefined ? { userText } : {}),
  });
}

describe('runCoreTurn surface input isolation', () => {
  test('forwards the active provider, skip list, and runId to the research path', async () => {
    spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
      id: 'research/agent', domain: 'research', selectionReason: 'test',
      baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
    } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
    const codexProvider = { name: 'openai-codex', defaultModel: 'gpt-6.1-codex' } as CoreTurnContext['initialProvider'];
    let routing: Pick<CoreTurnContext, 'initialProvider' | 'skipProviders' | 'runId'> | undefined;
    await runCoreTurn({
      sessionId: 'research-provider-routing',
      messages: [{ role: 'user', content: 'Why are bond yields rising?' }],
      tools: [tool],
      dispatchTool: async () => null,
      signal,
      userText: 'Why are bond yields rising?',
      initialProvider: codexProvider,
      skipProviders: ['anthropic'],
      runId: 'run-core-turn-research-123',
    }, { runResearch: async (_request, _signal, _admitToolCall, providerRouting) => {
      routing = providerRouting;
      return { ok: true, output: 'mock evidence' };
    } });
    expect(routing?.initialProvider).toBe(codexProvider);
    expect(routing?.skipProviders).toEqual(['anthropic']);
    expect(routing?.runId).toBe('run-core-turn-research-123');
  });

  test('sets the bounded tool-result policy for the TUI/core-turn history path', async () => {
    let toolResultInlineLimitBytes: number | undefined;
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, opts) => {
      toolResultInlineLimitBytes = opts?.toolResultInlineLimitBytes;
      return 'done';
    });
    await runCoreTurn({
      sessionId: 'tool-result-inline-limit',
      messages: [{ role: 'user', content: 'inspect output' }],
      tools: [tool],
      dispatchTool: async () => 'large output',
      signal,
    });
    expect(toolResultInlineLimitBytes).toBe(50 * 1024);
  });

  test('forwards transient status callbacks from the stream to the host', async () => {
    const statuses: string[] = [];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
      handlers.onStatus?.('스트림 무응답 · 재시도');
      return 'done';
    });
    await runCoreTurn({
      sessionId: 'stream-status-forwarding',
      messages: [{ role: 'user', content: 'recover stream' }],
      tools: [tool],
      dispatchTool: async () => null,
      signal,
      callbacks: { onStatus: (line) => statuses.push(line) },
    });
    expect(statuses).toEqual(['스트림 무응답 · 재시도']);
  });
  test('passes the selected research surface to the tool-loop guard once', async () => {
    spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
      id: 'research/agent', domain: 'research', selectionReason: 'test',
      baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
    } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
    let researchTurn: boolean | undefined;
    let dateLines = 0;
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, opts) => {
      researchTurn = opts?.researchTurn;
      dateLines = messages.filter((message) => message.role === 'system'
        && typeof message.content === 'string' && message.content.startsWith('Current local date:')).length;
      return 'done';
    });
    await runCoreTurn({
      sessionId: 'surface-selection-test',
      messages: [{ role: 'user', content: '최신 채권 금리 조사' }],
      tools: [tool],
      dispatchTool: async () => null,
      signal,
      userText: '최신 채권 금리 조사',
    }, { runResearch: async () => ({ ok: true, output: 'test evidence' }) });
    expect(researchTurn).toBe(true);
    expect(dateLines).toBe(1);
  });

  test('emits capability.resolve/tool-tier-split from the real turn entry', async () => {
    const records: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      records.push({ category, event, data: data as Record<string, unknown> });
    });
    await run([{ role: 'user', content: 'read source' }]);
    expect(records.filter((record) => record.category === 'capability.resolve' && record.event === 'tool-tier-split')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ sessionId: 'surface-selection-test', activeCount: 1, immediate: ['Read'] }) }),
    ]);
    expect(records.filter((record) => record.category === 'capability.resolve' && record.event === 'tier-split')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({
        sessionId: 'surface-selection-test', activeTools: ['Read'], excludedTools: [],
      }) }),
    ]);
  });

  test('reports the model attempted by the tool stream to the hosting callback', async () => {
    const resolved: string[] = [];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, opts) => {
      opts?.onResolvedProvider?.('openrouter', 'openrouter/z-ai/glm-5.3');
      return 'done';
    });
    await runCoreTurn({
      sessionId: 'grounding-model-observation',
      messages: [{ role: 'user', content: 'inspect repository' }],
      tools: [tool],
      dispatchTool: async () => null,
      signal,
      callbacks: { onResolvedProvider: (provider, model) => resolved.push(`${provider}/${model}`) },
    });
    expect(resolved).toEqual(['openrouter/openrouter/z-ai/glm-5.3']);
  });

  test('[skips-machine-turns] uses the original human prompt for surface selection after a goal-loop prompt', async () => {
    await run([
      { role: 'user', content: 'please inspect the browser page' },
      { role: 'assistant', content: 'I will inspect it.' },
      { role: 'user', content: 'Continue working on the goal and provide evidence.' },
    ], 'please inspect the browser page');

    expect(surfaceUserText).toBe('please inspect the browser page');
    expect(deferredUserText).toBe('Continue working on the goal and provide evidence.');
  });

  test('[deferred-unchanged] keeps the latest message text for deferred preload when it differs from the human prompt', async () => {
    await run([{ role: 'user', content: 'machine continuation text' }], 'original human prompt');

    expect(surfaceUserText).toBe('original human prompt');
    expect(deferredUserText).toBe('machine continuation text');
  });

  test('[extractor-semantics] leaves deferred preload empty when the latest user message has no text', async () => {
    await run([
      { role: 'user', content: 'earlier human text' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }] },
    ]);

    expect(surfaceUserText).toBeUndefined();
    expect(deferredUserText).toBeUndefined();
  });

  test('does not substitute a machine user message when no original human prompt exists', async () => {
    await run([{ role: 'user', content: 'machine continuation text' }]);

    expect(surfaceUserText).toBeUndefined();
    expect(deferredUserText).toBe('machine continuation text');
  });
});

function authStatusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function turnCtx(signal = new AbortController().signal) {
  return {
    sessionId: 'auth-rejection-test',
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [tool],
    dispatchTool: async () => null,
    signal,
  };
}

describe('runCoreTurn dispatch completion observation', () => {
  test('logs a matching successful completion with injected duration', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const times = [1_000, 1_100];
    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'core.turn') events.push({ category, event, data: data as Record<string, unknown> });
    });
    let handler: StreamWithToolsHandlers['dispatchTool'];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
      handler = handlers.dispatchTool;
      return 'done';
    });

    await runCoreTurn({ ...turnCtx(), dispatchTool: async () => 'tool result' }, { now: () => times.shift()! });
    await handler!('Read', {});

    const [started, done] = events.filter(({ event }) => event === 'dispatch' || event === 'dispatch-done');
    expect(started).toMatchObject({
      category: 'core.turn',
      event: 'dispatch',
      data: {
        sessionId: 'auth-rejection-test',
        tool: 'Read',
        dispatchCount: 1,
        hasAbortSignal: true,
        signalAlreadyAborted: false,
        signalSource: 'core-turn-created',
      },
    });
    expect(done).toMatchObject({ category: 'core.turn', event: 'dispatch-done', data: { tool: 'Read', dispatchCount: 1, durationMs: 100, success: true } });
  });

  test('distinguishes parent turn abort signal source and aborted state on the dispatch row', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const ctrl = new AbortController();
    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'core.turn' && event === 'dispatch') events.push({ event, data: data as Record<string, unknown> });
    });
    let handler: StreamWithToolsHandlers['dispatchTool'];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
      handler = handlers.dispatchTool;
      return 'done';
    });

    await runCoreTurn({ ...turnCtx(ctrl.signal), dispatchTool: async () => 'tool result' });
    ctrl.abort();
    await handler!('Read', {}, { callId: 'call-1' });

    expect(events).toEqual([
      {
        event: 'dispatch',
        data: expect.objectContaining({
          sessionId: 'auth-rejection-test',
          tool: 'Read',
          dispatchCount: 1,
          hasAbortSignal: true,
          signalAlreadyAborted: true,
          signalSource: 'parent-turn',
        }),
      },
    ]);
  });

  test.each([
    ['synchronous throw', () => { throw new Error('sync failure'); }],
    ['asynchronous rejection', async () => { throw new Error('async failure'); }],
  ])('logs one failed completion and rethrows the original %s', async (_kind, throwTool) => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const error = new Error('original tool error');
    spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'dispatch-done') events.push({ event, data: data as Record<string, unknown> });
    });
    let handler: StreamWithToolsHandlers['dispatchTool'];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
      handler = handlers.dispatchTool;
      return 'done';
    });
    await runCoreTurn({ ...turnCtx(), dispatchTool: async () => {
      try {
        await throwTool();
      } catch {
        throw error;
      }
    } }, { now: () => 100 });

    await expect(handler!('Read', {}, { callId: 'call-1' })).rejects.toBe(error);
    expect(events).toEqual([{ event: 'dispatch-done', data: expect.objectContaining({ tool: 'Read', dispatchCount: 1, durationMs: 0, success: false }) }]);
  });

  test('completion log failure preserves success result and original tool error', async () => {
    let handler: StreamWithToolsHandlers['dispatchTool'];
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
      handler = handlers.dispatchTool;
      return 'done';
    });
    spyOn(debug, 'log').mockImplementation((_category, event) => {
      if (event === 'dispatch-done') throw new Error('log failed');
    });

    await runCoreTurn({ ...turnCtx(), dispatchTool: async () => 'preserved' });
    await expect(handler!('Read', {}, { callId: 'success' })).resolves.toBe('preserved');

    const toolError = new Error('original tool error');
    await runCoreTurn({ ...turnCtx(), dispatchTool: async () => { throw toolError; } });
    await expect(handler!('Read', {}, { callId: 'failure' })).rejects.toBe(toolError);
  });
});

describe('runCoreTurn auth rejection vs ordinary error', () => {
  test('status 401 auth rejection is a distinct value from an ordinary throw', async () => {
    const authErr = authStatusError(
      401,
      'LLM API 401: {"error":"Invalid or expired credentials (auth_kind=bearer, x_xai_token_auth=xai-grok-cli, upstream=PermissionDenied, reason=no auth context)"}',
    );
    const ordinaryErr = new Error('provider exploded');

    spyOn(llmModule, 'streamLLMWithTools').mockRejectedValue(authErr);
    const authResult: CoreTurnResult = await runCoreTurn(turnCtx());

    spyOn(llmModule, 'streamLLMWithTools').mockRejectedValue(ordinaryErr);
    let ordinaryCaught: unknown;
    try {
      await runCoreTurn(turnCtx());
    } catch (err) {
      ordinaryCaught = err;
    }

    expect(authResult.stopReason).toBe('auth_rejected');
    expect(ordinaryCaught).toBe(ordinaryErr);
    expect(authResult.stopReason).not.toBe('error');
  });

  test('status 403 policy denial stays a generic error rethrow', async () => {
    const forbidden = authStatusError(403, 'LLM API 403: forbidden by policy');
    spyOn(llmModule, 'streamLLMWithTools').mockRejectedValue(forbidden);
    let caught: unknown;
    try {
      await runCoreTurn(turnCtx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(forbidden);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(forbidden.message);
  });

  test('abort still returns aborted with partial text', async () => {
    const ctrl = new AbortController();
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
      handlers.onText?.('partial', 'partial');
      ctrl.abort();
      throw new Error('AbortError: signal aborted');
    });
    const result = await runCoreTurn(turnCtx(ctrl.signal));
    expect(result.stopReason).toBe('aborted');
    expect(result.finalText).toBe('partial');
  });
});
