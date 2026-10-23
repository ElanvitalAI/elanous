// ── Phase B: agent runner tests ──
//
// Covers runAgent + AgentRegistry end-to-end using a fake LLMProvider
// that yields scripted events. No network, no real model.
//
// Event ordering invariant (per run):
//   status:thinking
//   [text | status:tool → tool_call → tool_result → status:thinking]*
//   status:done → done         (on success)
//   status:error → error       (on throw)
//   status:aborted             (on abort — no `error` frame)

import { describe, test, expect } from 'bun:test';
import {
  AgentRegistry, collectAgentText,
} from '../src/agent/registry';
import {
  buildAgentMessages, filterAgentTools, resolveAgentModel,
} from '../src/agent/runner';
import type {
  AgentDefinition, AgentEvent,
} from '../src/agent/types';
import type {
  LLMProvider, LLMStreamEvent, LLMToolSpec,
} from '../src/llm';

// ── Test helpers ──

/** Fake provider scripted with one event array per turn. `chat` delegates
 *  to `streamChat` + text filter, matching the real-provider contract so
 *  streamLLM (used when no tools) also works. */
function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const p: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat(messages, opts) {
      for await (const ev of p.streamChat!(messages, opts)) {
        if (ev.type === 'text') yield ev.delta;
      }
    },
  };
  return p;
}

/** Provider that hangs until its AbortSignal fires, then throws AbortError.
 *  Both streamChat and chat must hang — streamLLM uses chat when no tools. */
function hangingProvider(): LLMProvider {
  async function hang(opts: { signal?: AbortSignal } | undefined): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const sig = opts?.signal;
      const err = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!sig) return;
      if (sig.aborted) { reject(err()); return; }
      sig.addEventListener('abort', () => reject(err()), { once: true });
    });
  }
  return {
    name: 'hang',
    defaultModel: 'hang',
    available: () => true,
    async *streamChat(_msgs, opts) { await hang(opts); },
    async *chat(_msgs, opts) { await hang(opts); },
  };
}

function simpleDefinition(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'test-agent',
    systemPrompt: 'You are a test agent.',
    ...over,
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent, void, unknown>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ═══════════════════════════════════════════
// 1. buildAgentMessages — parent prefix forwarding
// ═══════════════════════════════════════════

describe('buildAgentMessages', () => {
  test('no prefix: system = definition.systemPrompt verbatim', () => {
    const msgs = buildAgentMessages(simpleDefinition(), 'hi');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are a test agent.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('prefix is joined with blank line so siblings share the cache prefix', () => {
    const msgs = buildAgentMessages(
      simpleDefinition({ systemPrompt: 'persona-A' }),
      'query',
      'PARENT_CONTEXT',
    );
    expect(msgs[0]!.content).toBe('PARENT_CONTEXT\n\npersona-A');
  });
});

// ═══════════════════════════════════════════
// 2. filterAgentTools — allowlist policy
// ═══════════════════════════════════════════

describe('filterAgentTools', () => {
  const hostTools: LLMToolSpec[] = [
    { name: 'alpha', description: '', parameters: {} },
    { name: 'beta',  description: '', parameters: {} },
    { name: 'gamma', description: '', parameters: {} },
  ];

  test('undefined allowlist → no tools (policy: explicit allow)', () => {
    expect(filterAgentTools(hostTools, undefined)).toBeUndefined();
  });

  test('empty allowlist → no tools', () => {
    expect(filterAgentTools(hostTools, [])).toBeUndefined();
  });

  test('specific names → only those exposed', () => {
    const out = filterAgentTools(hostTools, ['alpha', 'gamma']);
    expect(out).toHaveLength(2);
    expect(out!.map(t => t.name)).toEqual(['alpha', 'gamma']);
  });

  test('unknown names dropped silently', () => {
    const out = filterAgentTools(hostTools, ['alpha', 'missing']);
    expect(out).toHaveLength(1);
    expect(out![0]!.name).toBe('alpha');
  });

  test('no overlap → undefined', () => {
    expect(filterAgentTools(hostTools, ['nope'])).toBeUndefined();
  });
});

// ═══════════════════════════════════════════
// 3. runAgent — happy path event sequence
// ═══════════════════════════════════════════

describe('runAgent — success path', () => {
  test('text-only response yields status → text deltas → status:done → done', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([
      [{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }],
    ]);

    const { task, events } = registry.spawn({
      definition: simpleDefinition(),
      prompt: 'greet',
      provider,
    });

    const collected = await collectEvents(events);

    // Event shape (in order)
    expect(collected[0]).toEqual({ type: 'status', stage: 'thinking' });
    expect(collected[1]).toEqual({ type: 'text', delta: 'Hel' });
    expect(collected[2]).toEqual({ type: 'text', delta: 'lo' });
    expect(collected[3]).toEqual({ type: 'status', stage: 'done' });
    expect(collected[4]).toEqual({ type: 'done', text: 'Hello' });

    // Task state
    expect(task.state).toBe('done');
    expect(task.result).toBe('Hello');
    expect(task.startedAt).toBeGreaterThan(0);
    expect(task.finishedAt).toBeGreaterThanOrEqual(task.startedAt!);
  });

  test('tool round emits status:tool → tool_call → tool_result → status:thinking', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([
      [
        { type: 'text', delta: 'checking' },
        { type: 'tool_call', id: 'c1', name: 'echo', args: { x: 'hi' } },
      ],
      [{ type: 'text', delta: ' done' }],
    ]);

    const { task, events } = registry.spawn({
      definition: simpleDefinition({ tools: ['echo'] }),
      prompt: 'echo hi',
      tools: [{ name: 'echo', description: '', parameters: {} }],
      dispatchTool: async (_, args) => ({ echoed: (args as any).x }),
      provider,
    });

    const collected = await collectEvents(events);
    const types = collected.map(e => e.type + (e.type === 'status' ? `:${e.stage}` : ''));

    // ⛔⭐ 이 열에 ***빈 델타 `text` 가 «없다»***는 것이 계약이다(2026-08-26).
    //   📏 LLM 층은 툴 라운드마다 `onText('', '')` 를 «지움 표식»으로 낸다(llm.ts:7535 도 그것으로 가른다).
    //      ⛔ 그런데 ***AgentEvent 의 `text` 에는 «지움» 의미가 «없다»*** — 소비자 셋이 전부
    //      무조건 이어붙이기만 한다(skills/tools/agent.ts · subagent-callable.ts · log-adapter.ts).
    //   ⇒ runner 가 그 빈 델타를 «떨군다». 그러지 않으면 툴 라운드마다 ***내용 없는 이벤트***가 흘러
    //     UI 플러시·줄 버퍼·로그가 헛돈다.
    //   ⚠️ 🕳️ 남은 결손(이 시험이 «안» 무는 것): ***「지움」이 agent 스트림에 «전달되지 않는다».***
    //      ⇒ 델타를 이어붙인 라이브 소비자는 `"checking done"` 을 들고 있는데
    //        최종 `task.result` 는 `" done"` 이다. ***둘이 어긋난다.***
    //        📌 AgentEvent 에 «지움» 의미가 생겨야 닫힌다 — 별개 축이다.
    expect(types).toEqual([
      'status:thinking',
      'text',
      'status:tool',
      'tool_call',
      'tool_result',
      'status:thinking',
      'text',
      'status:done',
      'done',
    ]);

    const toolCall = collected.find(e => e.type === 'tool_call')!;
    expect(toolCall).toMatchObject({ id: 'c1', name: 'echo', args: { x: 'hi' } });
    const toolResult = collected.find(e => e.type === 'tool_result')!;
    expect(toolResult).toMatchObject({ id: 'c1', name: 'echo', result: { echoed: 'hi' } });

    expect(task.state).toBe('done');
    // 🪞⭐⭐ 2026-08-26 — 옛 기대는 `'checking done'`(툴 «전» 서술 + 툴 «후» 답)이었다.
    //   📏 실측: `' done'` — ***툴 라운드 «전» 텍스트는 «지워진다».***
    //   📍 기전 = src/llm.ts `finalizeVisibleAssistantText(full, finalTurn, sawToolRound)`
    //             ⇒ `sawToolRound ? finalTurn : full`
    //      ⊕ `clearVisibleAssistantTextForToolRound` 가 라운드마다 `onText('', '')`(=지워라)를 낸다
    //   🔑 ***이름 «둘»이 그 의도를 말한다*** — "visible assistant text" 를 툴 라운드에서 «지운다».
    //      모델이 툴 부르기 «전»에 하는 서술("checking")은 «작업 메모»이고, 사용자에게 보이는 답은
    //      툴 «뒤» 텍스트다. ⇒ 늙은 것은 계약이 아니라 ***이 기대값***이다.
    expect(task.result).toBe(' done');
  });

  test('dispatchTool default throws when agent has no handler', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([
      [{ type: 'tool_call', id: 'c1', name: 'missing', args: {} }],
      [{ type: 'text', delta: 'saw the error tool_result' }],
    ]);

    const { events } = registry.spawn({
      definition: simpleDefinition({ tools: ['missing'] }),
      prompt: 'call it',
      tools: [{ name: 'missing', description: '', parameters: {} }],
      // dispatchTool omitted — should throw, and streamLLMWithTools
      // captures the error into the tool_result content.
      provider,
    });

    const collected = await collectEvents(events);
    const toolResult = collected.find(e => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect((toolResult as any).result).toMatchObject({ error: expect.stringContaining('no dispatchTool') });
  });
});

// ═══════════════════════════════════════════
// 4. runAgent — error / abort paths
// ═══════════════════════════════════════════

describe('runAgent — failure paths', () => {
  test('provider throw → error event, task.state = "error"', async () => {
    const registry = new AgentRegistry();
    const provider: LLMProvider = {
      name: 'boom', defaultModel: 'boom', available: () => true,
      async *streamChat() { throw new Error('upstream 500'); },
      async *chat() { throw new Error('upstream 500'); },
    };

    const { task, events } = registry.spawn({
      definition: simpleDefinition(),
      prompt: 'break',
      provider,
    });

    const collected = await collectEvents(events);
    const last = collected[collected.length - 1]!;
    expect(last.type).toBe('error');
    expect((last as any).message).toContain('upstream 500');
    expect(task.state).toBe('error');
    expect(task.error).toContain('upstream 500');
  });

  test('abort before run completes → status:aborted, task.state = "aborted"', async () => {
    const registry = new AgentRegistry();
    const { task, events } = registry.spawn({
      definition: simpleDefinition(),
      prompt: 'hang',
      provider: hangingProvider(),
    });

    // Consume events in the background; abort from the main path.
    const drain = collectEvents(events);
    // Yield so runAgent can register the abort listener first.
    await new Promise(r => setTimeout(r, 10));
    const ok = registry.abort(task.id);
    expect(ok).toBe(true);

    const collected = await drain;
    const last = collected[collected.length - 1]!;
    expect(last).toEqual({ type: 'status', stage: 'aborted' });
    expect(task.state).toBe('aborted');
    expect(task.error).toBeUndefined();
  });

  test('abort on already-finished task returns false (idempotent)', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([[{ type: 'text', delta: 'quick' }]]);
    const { task, events } = registry.spawn({
      definition: simpleDefinition(),
      prompt: 'go',
      provider,
    });
    await collectEvents(events);
    expect(task.state).toBe('done');
    expect(registry.abort(task.id)).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 5. collectAgentText — convenience collector
// ═══════════════════════════════════════════

describe('collectAgentText', () => {
  test('returns the final assistant text', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([[{ type: 'text', delta: 'partial' }, { type: 'text', delta: ' rest' }]]);
    const { events } = registry.spawn({
      definition: simpleDefinition(),
      prompt: 'x',
      provider,
    });
    const text = await collectAgentText(events);
    expect(text).toBe('partial rest');
  });

  test('throws on error event', async () => {
    const registry = new AgentRegistry();
    const provider: LLMProvider = {
      name: 'x', defaultModel: 'x', available: () => true,
      async *streamChat() { throw new Error('nope'); },
      async *chat() { throw new Error('nope'); },
    };
    const { events } = registry.spawn({
      definition: simpleDefinition(),
      prompt: 'x',
      provider,
    });
    expect(collectAgentText(events)).rejects.toThrow(/nope/);
  });
});

// ═══════════════════════════════════════════
// 6. AgentRegistry lifecycle
// ═══════════════════════════════════════════

describe('AgentRegistry', () => {
  test('spawn creates a unique task id per call', () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([[{ type: 'text', delta: '' }], [{ type: 'text', delta: '' }]]);
    const h1 = registry.spawn({ definition: simpleDefinition(), prompt: 'a', provider });
    const h2 = registry.spawn({ definition: simpleDefinition(), prompt: 'b', provider });
    expect(h1.task.id).not.toBe(h2.task.id);
    expect(registry.size).toBe(2);
  });

  test('list(state) filters by task state', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const { events } = registry.spawn({ definition: simpleDefinition(), prompt: 'q', provider });
    await collectEvents(events);
    expect(registry.list('done')).toHaveLength(1);
    expect(registry.list('running')).toHaveLength(0);
  });

  test('abortAll signals every live task', async () => {
    const registry = new AgentRegistry();
    const h1 = registry.spawn({ definition: simpleDefinition(), prompt: 'a', provider: hangingProvider() });
    const h2 = registry.spawn({ definition: simpleDefinition(), prompt: 'b', provider: hangingProvider() });

    // Start draining so the runAgent generators hook up their abort listeners.
    const d1 = collectEvents(h1.events);
    const d2 = collectEvents(h2.events);
    await new Promise(r => setTimeout(r, 10));

    expect(registry.abortAll()).toBe(2);
    await Promise.all([d1, d2]);
    expect(h1.task.state).toBe('aborted');
    expect(h2.task.state).toBe('aborted');
  });

  test('prune drops finished tasks older than threshold', async () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider([[{ type: 'text', delta: 'done' }]]);
    const { task, events } = registry.spawn({ definition: simpleDefinition(), prompt: 'q', provider });
    await collectEvents(events);
    expect(registry.size).toBe(1);

    // Pretend the task finished 10 minutes ago
    task.finishedAt = Date.now() - 10 * 60 * 1000;
    const removed = registry.prune(5 * 60 * 1000);
    expect(removed).toBe(1);
    expect(registry.size).toBe(0);
  });

  test('prune never removes live tasks', async () => {
    const registry = new AgentRegistry();
    const { task } = registry.spawn({ definition: simpleDefinition(), prompt: 'q', provider: hangingProvider() });
    task.state = 'running';   // simulate live
    task.finishedAt = undefined;
    expect(registry.prune(0)).toBe(0);
    registry.abort(task.id);
  });

  test('register creates a task without starting it', () => {
    const registry = new AgentRegistry();
    const task = registry.register(simpleDefinition(), 'pending query');
    expect(task.state).toBe('pending');
    expect(task.startedAt).toBeUndefined();
    expect(registry.get(task.id)).toBe(task);
  });
});

// ═══════════════════════════════════════════
// 7. resolveAgentModel — definition model resolution (TUI-AGENT-MODEL-FALLBACK · 결함 #34)
// ═══════════════════════════════════════════

describe('resolveAgentModel — definition model resolution', () => {
  test("definition 'haiku' under current provider 'openai-codex' → parent fallback (incompatible-provider)", () => {
    // 결함 #34: codex 부모에서 Claude 별칭 모델이 그대로 요청되어 죽었다.
    // 폴백은 «못 부를 때만» — model 이 undefined 로 돌아가면 streamLLMWithTools 가
    // 부모와 같은 설정 결정 경로(resolveDefaultProvider)를 탄다.
    expect(resolveAgentModel('haiku', { currentProviderName: () => 'openai-codex' }))
      .toEqual({ model: undefined, reason: 'incompatible-provider' });
  });

  test("definition 'haiku' under current provider 'anthropic' → canonical id kept (definition)", () => {
    expect(resolveAgentModel('haiku', { currentProviderName: () => 'anthropic' }))
      .toEqual({ model: 'claude-haiku-4-5', reason: 'definition' });
  });

  test("'inherit' — trimmed, case-insensitive — is an inheritance marker, never a model name", () => {
    expect(resolveAgentModel('inherit')).toEqual({ model: undefined, reason: 'declared-inherit' });
    expect(resolveAgentModel(' Inherit ')).toEqual({ model: undefined, reason: 'declared-inherit' });
  });

  test('no definition model → no-definition-model (parent inherit)', () => {
    expect(resolveAgentModel(undefined)).toEqual({ model: undefined, reason: 'no-definition-model' });
  });

  test('provider lookup failure → inherit the parent as provider-unknown, never judged against a fake name nor sent unjudged', () => {
    // 조회 실패를 'auto' 같은 가짜 이름으로 숨기지 않는다(호환 판정 0회) · 정의 모델을
    // 판정 없이 넘기지도 않는다(모델 이름으로 공급자가 다시 골라질 수 있다) → 부모 모델 상속.
    let compatAsked = false;
    expect(resolveAgentModel('sonnet', {
      currentProviderName: () => { throw new Error('no provider configured'); },
      isCompatible: () => { compatAsked = true; return true; },
    })).toEqual({ model: undefined, reason: 'provider-unknown' });
    expect(compatAsked).toBe(false);
  });

  test("model id whose inferProvider is null → sent verbatim as unknown-model, never dropped to inherit", () => {
    // isModelCompatible 은 추론 null 을 true 로 내므로 추론을 «먼저» 본다 —
    // 이 케이스가 'definition' 이 아니라 'unknown-model' 로 나오는 것이 그 순서의 증명이다.
    // local 자유 이름을 상속으로 떨구면 회귀다.
    expect(resolveAgentModel('my-local-model', {
      currentProviderName: () => 'local',
      inferProvider: () => null,
    })).toEqual({ model: 'my-local-model', reason: 'unknown-model' });
  });
});

// ═══════════════════════════════════════════
// 8. runAgent — definition model fallback, fake-provider end-to-end
// ═══════════════════════════════════════════

describe('runAgent — definition model fallback', () => {
  /** fakeProvider variant with a pinned provider name that records the
   *  model each streamChat call actually received. */
  function recordingProvider(
    name: string,
    seen: (string | undefined)[],
    turns: LLMStreamEvent[][],
  ): LLMProvider {
    let call = 0;
    const p: LLMProvider = {
      name,
      defaultModel: `${name}-default-model`,
      available: () => true,
      async *streamChat(_messages: unknown, opts?: unknown) {
        seen.push((opts as { model?: string } | undefined)?.model);
        const events = turns[call++] ?? [];
        for (const ev of events) yield ev;
      },
      async *chat(messages, opts) {
        for await (const ev of p.streamChat!(messages, opts)) {
          if (ev.type === 'text') yield ev.delta;
        }
      },
    };
    return p;
  }

  test("codex provider + definition model 'haiku' → run finishes on the provider default, never requests a Claude id", async () => {
    // 결함 #34 의 판정 신호: 'haiku' 정의가 openai-codex 공급자에서 404 로 죽지 않고
    // 부모(공급자 기본) 모델로 돈다 — opts.model 은 'haiku' 도 'claude-haiku-4-5' 도 아니다.
    const registry = new AgentRegistry();
    const seen: (string | undefined)[] = [];
    const provider = recordingProvider('openai-codex', seen, [
      [{ type: 'text', delta: 'fallback ok' }],
    ]);

    const { task, events } = registry.spawn({
      definition: simpleDefinition({ model: 'haiku' }),
      prompt: 'greet',
      provider,
    });

    await collectEvents(events);

    expect(task.state).toBe('done');
    expect(task.result).toBe('fallback ok');
    expect(seen.length).toBeGreaterThan(0);
    for (const m of seen) {
      expect(m).not.toBe('haiku');
      expect(m).not.toBe('claude-haiku-4-5');
      // 부정만으로는 'inherit' 같은 잘못된 값도 통과한다 — 실제로 실린 값이
      // 부모(이 공급자)의 기본 모델임을 양(+)으로 단언한다.
      expect(m).toBe(provider.defaultModel);
    }
  });

  test("anthropic provider + definition model 'sonnet' → keeps the resolved canonical id 'claude-sonnet-5'", async () => {
    // 맞는 공급자에서는 정의 모델을 지킨다 — sonnet 정의가 Claude 부모에서
    // inherit 로 떨어지면 회귀다.
    const registry = new AgentRegistry();
    const seen: (string | undefined)[] = [];
    const provider = recordingProvider('anthropic', seen, [
      [{ type: 'text', delta: 'kept' }],
    ]);

    const { task, events } = registry.spawn({
      definition: simpleDefinition({ model: 'sonnet' }),
      prompt: 'greet',
      provider,
    });

    await collectEvents(events);

    expect(task.state).toBe('done');
    expect(seen).toContain('claude-sonnet-5');
  });
});

// ── SUBAGENT-ENCAPSULATION — «못 했다»형 답은 안에서 잇는다 · 밖으로는 완료·이상만 ──
import { classifySubagentExit, SUBAGENT_CONTINUE_INSIDE_CAP, SUBAGENT_CONTINUE_INSIDE_PROMPT } from '../src/agent/runner';
import { createGlobalSubagentCallable } from '../src/agent/subagent-callable';

describe('SUBAGENT-ENCAPSULATION', () => {
  function capturingProvider(replies: string[]): { provider: LLMProvider; calls: () => number; lastUser: () => string[]; seen: () => string[][] } {
    let call = 0;
    const lastUsers: string[] = [];
    const seenMessages: string[][] = [];
    const provider: LLMProvider = {
      name: 'fake', defaultModel: 'fake-model', available: () => true,
      async *streamChat(messages) {
        seenMessages.push(messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`));
        const u = [...messages].reverse().find((m) => m.role === 'user');
        lastUsers.push(typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content));
        yield { type: 'text', delta: replies[Math.min(call++, replies.length - 1)]! };
      },
      async *chat(messages, opts) { for await (const ev of provider.streamChat!(messages, opts)) if (ev.type === 'text') yield ev.delta; },
    };
    return { provider, calls: () => call, lastUser: () => lastUsers, seen: () => seenMessages };
  }
  const FIRST = '과제2 녹화는 아직 하지 못했습니다.';
  const LAST = '과제2 녹화 완료 · lecture/과제2.mp4';
  const tools: LLMToolSpec[] = [{ name: 'Read', description: '', parameters: { type: 'object' } }];

  test('반례(10-22 n8n 실물): 첫 답이 «…하지 못했습니다» 면 안에서 이어가 완료 답을 밖으로 낸다', async () => {
    const reg = new AgentRegistry();
    const cap = capturingProvider(['과제2 녹화는 아직 하지 못했습니다.', '과제2 녹화 완료 · lecture/과제2.mp4']);
    const h = reg.spawn({ definition: simpleDefinition(), prompt: '과제2 녹화', tools, provider: cap.provider, dispatchTool: async () => 'ok' });
    const text = await collectAgentText(h.events);
    expect(text).toContain('완료');
    expect(cap.calls()).toBe(2);
    expect(cap.lastUser()[1]).toBe(SUBAGENT_CONTINUE_INSIDE_PROMPT);
    expect(h.task.result).toBe('과제2 녹화 완료 · lecture/과제2.mp4');
  });

  test('r1 must-fix: 안에서 이어간 걸음의 답은 부모 스트림에 안 닿는다 — 텍스트 델타 합 === 마지막 답', async () => {
    const reg = new AgentRegistry();
    const cap = capturingProvider([FIRST, LAST]);
    const h = reg.spawn({ definition: simpleDefinition(), prompt: '과제2 녹화', tools, provider: cap.provider, dispatchTool: async () => 'ok' });
    let streamed = '';
    let done = '';
    for await (const ev of h.events) {
      if (ev.type === 'text') streamed += ev.delta;
      if (ev.type === 'done') done = ev.text;
    }
    expect(streamed).toBe(LAST);
    expect(streamed).not.toContain('하지 못했습니다');
    expect(done).toBe(LAST);
    // should-fix: 둘째 걸음이 앞 걸음의 답을 이력으로 받는다(안에서 이어가며 잊지 않는다).
    expect(cap.seen()[1]!.some((m) => m.startsWith('assistant:') && m.includes(FIRST))).toBe(true);
    expect(cap.seen()[1]!.at(-1)).toBe(`user:${SUBAGENT_CONTINUE_INSIDE_PROMPT}`);
  });

  test('GOODHART: 실제 부모 소비 경로(subagent-callable)의 출력 === 마지막 답 · 첫 미완 답 없음', async () => {
    const reg = new AgentRegistry();
    const cap = capturingProvider([FIRST, LAST]);
    const callable = createGlobalSubagentCallable({
      registry: reg,
      resolveDefinition: () => simpleDefinition({ tools: ['Read'] }),
      hostTools: tools,
      dispatchTool: async () => 'ok',
      provider: cap.provider,
    });
    const handle = await callable({ definitionName: 'test-agent', prompt: '과제2 녹화' });
    const result = await handle.done;
    expect(result.status).toBe('completed');
    expect(result.output).toBe(LAST);
    expect(result.output).not.toContain(FIRST);
    expect(cap.calls()).toBe(2);
  });

  test('한 걸음에 끝나면 텍스트는 그대로 흐른다(버퍼가 답을 삼키지 않는다)', async () => {
    const reg = new AgentRegistry();
    const cap = capturingProvider([LAST]);
    const h = reg.spawn({ definition: simpleDefinition(), prompt: 'x', tools, provider: cap.provider, dispatchTool: async () => 'ok' });
    let streamed = '';
    for await (const ev of h.events) if (ev.type === 'text') streamed += ev.delta;
    expect(streamed).toBe(LAST);
    expect(cap.calls()).toBe(1);
  });

  test('이상 상황(BLOCKED:·권한 없음)은 이어가지 않고 바로 밖으로', async () => {
    const reg = new AgentRegistry();
    const cap = capturingProvider(['BLOCKED: n8n 로그인 필요 · 세션 재시도 2회']);
    const h = reg.spawn({ definition: simpleDefinition(), prompt: 'x', tools, provider: cap.provider, dispatchTool: async () => 'ok' });
    await collectAgentText(h.events);
    expect(cap.calls()).toBe(1);
  });

  test('같은 미완 답이 반복되면(같은 원인) 상한 전에 밖으로 · 계속 미완이면 상한에서 멈춘다', async () => {
    const reg = new AgentRegistry();
    const same = capturingProvider(['아직 하지 못했습니다.']);
    const h1 = reg.spawn({ definition: simpleDefinition(), prompt: 'x', tools, provider: same.provider, dispatchTool: async () => 'ok' });
    await collectAgentText(h1.events);
    expect(same.calls()).toBe(2);
    const diff = capturingProvider(['A 는 하지 못했습니다.', 'B 는 하지 못했습니다.', 'C 는 하지 못했습니다.', 'D']);
    const h2 = reg.spawn({ definition: simpleDefinition(), prompt: 'y', tools, provider: diff.provider, dispatchTool: async () => 'ok' });
    await collectAgentText(h2.events);
    expect(diff.calls()).toBe(1 + SUBAGENT_CONTINUE_INSIDE_CAP);
  });

  test('판별기: 완료·진행 답은 done · 미완형은 incomplete · 이상 사유가 섞이면 abnormal', () => {
    expect(classifySubagentExit('과제1 MP4 재생 확인 완료')).toBe('done');
    expect(classifySubagentExit('보너스 영상은 완료되지 않았습니다')).toBe('incomplete');
    expect(classifySubagentExit('권한이 없어 완료하지 못했습니다')).toBe('abnormal');
  });
});
