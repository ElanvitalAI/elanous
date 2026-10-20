import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../core-turn/index.js';
import * as llm from '../llm.js';
import type { LLMMessage, LLMProvider } from '../llm.js';
import { extractLastAssistantText } from './core-turn-bridge.js';
import * as config from '../user-config.js';
import { debug } from '../debug/log.js';
import type { CoreTurnContext } from '../core-turn/index.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp, toolsForTuiRoute } from './core-turn-bridge.js';
import { buildWebSearchTool } from '../boot/daemon-tools/web-search.js';
import { buildUserConfig } from '../user-config.js';

const question = 'OpenAI 최근 모델이 뭐야?';
const search = { name: 'WebSearch', description: '', parameters: { type: 'object' as const } };

function fixture(text = question, overrides: { max?: number; configMax?: number; grant?: boolean } = {}) {
  const calls: CoreTurnContext[] = [];
  const pushes: string[] = [];
  const persisted: string[] = [];
  const completed: LLMMessage[][] = [];
  const dispatched: string[] = [];
  const log = spyOn(debug, 'log');
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: false } },
    chat: { ...base.chat, factQuestion: { maxToolTurns: overrides.configMax ?? 6 } },
  });
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    calls.push(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'system', content: 'base' }, { role: 'user', content: text }],
    getTools: () => [search],
    dispatchTool: async (name) => { dispatched.push(name); return { hits: [{ title: 'Model', snippet: 'A model', url: 'https://example.com/model' }] }; },
    onTurnComplete: ({ newMessages }) => {
      completed.push(newMessages);
      persisted.push(extractLastAssistantText(newMessages) ?? '');
    },
    ...(overrides.max !== undefined ? { resolveMaxToolTurns: () => overrides.max } : {}),
    ...(overrides.grant ? { budgetGrant: { tools: ['PtyShellSend'], perCall: 6, ceiling: 60 } } : {}),
  });
  const turn = {
    sessionId: 'fact-test', cwd: '/tmp', userText: text,
    promptBlocks: [{ type: 'text', text }], isAborted: () => false,
    push: async (delta: string) => { pushes.push(delta); },
    pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext;
  return { runTurn: () => runTurn(turn), calls, pushes, persisted, completed, dispatched, log };
}

afterEach(() => mock.restore());

test('user config parses a positive fact budget and falls back to six for malformed values', () => {
  const root = mkdtempSync(join(tmpdir(), 'fact-question-config-'));
  const path = join(root, 'config.json');
  try {
    for (const [value, expected] of [[3, 3], [0, 6], [-1, 6], ['6', 6], [2.5, 6]] as const) {
      writeFileSync(path, JSON.stringify({ chat: { factQuestion: { maxToolTurns: value } } }));
      expect(buildUserConfig(path).chat.factQuestion.maxToolTurns).toBe(expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fact question adds one-turn instruction, six-turn cap and search evidence without shell/browser', async () => {
  const f = fixture(question, { grant: true });
  await f.runTurn();
  expect(f.calls).toHaveLength(1);
  const ctx = f.calls[0]!;
  expect(ctx.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('WebSearch 를 1~2회') });
  expect(ctx.messages[1]).toEqual({ role: 'system', content: 'base' });
  expect(ctx.maxToolTurns).toBe(6);
  expect(ctx.budgetGrant).toBeUndefined();
  await ctx.dispatchTool('WebSearch', { query: 'model' });
  ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: 'A model [source](https://example.com/model)' }]);
  expect(f.dispatched).toEqual(['WebSearch']);
  expect(f.persisted).toEqual(['A model [source](https://example.com/model)']);
  expect(f.log).toHaveBeenCalledWith('chat.turn', 'tool-budget', {
    factQuestion: true, maxToolTurns: 6, count: 1, kinds: ['WebSearch'],
  });
  expect(buildWebSearchTool().description).toContain('answer directly from the snippets and URLs');
});

test('a configured budget is read, explicit resolver wins even with zero', async () => {
  const configured = fixture(question, { configMax: 3 });
  await configured.runTurn();
  expect(configured.calls[0]!.maxToolTurns).toBe(3);
  const concurrent = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    configured.calls[0]!.dispatchTool('WebSearch', { query: `query-${i}` })));
  expect(configured.dispatched).toHaveLength(3);
  expect(concurrent[3]).toEqual({ error: 'Tool budget reached. Answer using the evidence already collected.' });
  expect(concurrent[4]).toEqual(concurrent[3]);
  mock.restore();
  const explicit = fixture(question, { max: 0, configMax: 3, grant: true });
  await explicit.runTurn();
  expect(explicit.calls[0]!.maxToolTurns).toBe(0);
  expect(explicit.calls[0]!.budgetGrant).toEqual({ tools: ['PtyShellSend'], perCall: 6, ceiling: 60 });
});

test('real core turn caps repeated search requests and synthesizes from returned URL', async () => {
  mock.restore();
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, provider: 'openai', model: 'gpt-5.6', goalLoop: { enabled: false } },
    chat: { ...base.chat, factQuestion: { maxToolTurns: 6 }, autoCompact: { ...base.chat.autoCompact, enabled: false } },
    tools: { ...base.tools, deferred: { ...base.tools.deferred, mode: 'off' } },
  });
  const seen: LLMMessage[][] = [];
  const synthesis: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name: 'fact-test-provider', defaultModel: 'gpt-5.6', available: () => true,
    chat: async function* (messages) {
      synthesis.push(structuredClone(messages));
      const source = /https:\/\/example\.com\/model/.exec(JSON.stringify(messages))?.[0];
      if (!source) throw new Error('synthesis did not receive search evidence');
      yield `검색 결과의 Model 항목에 따르면 A model입니다. [출처](${source})`;
    },
    streamChat: async function* (messages) {
      seen.push(structuredClone(messages));
      if (seen.length > 12) throw new Error(`excessive model calls: ${seen.length}`);
      yield { type: 'tool_call', id: `search-${seen.length}`, name: 'WebSearch', args: { query: `model-${seen.length}` } };
      yield { type: 'tool_call', id: `search-${seen.length}-b`, name: 'WebSearch', args: { query: `model-${seen.length}-b` } };
    },
  };
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(provider);
  const persisted: LLMMessage[][] = [];
  const pushes: string[] = [];
  const dispatched: string[] = [];
  const budgetEvents: Array<{ factQuestion: boolean; count: number; kinds: string[]; maxToolTurns: number }> = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'chat.turn' && event === 'tool-budget') budgetEvents.push(data as typeof budgetEvents[number]);
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'system', content: 'base' }, { role: 'user', content: question }],
    getTools: () => [search],
    dispatchTool: async (name) => {
      dispatched.push(name);
      return { hits: [{ title: 'Model', snippet: 'A model', url: 'https://example.com/model' }] };
    },
    onTurnComplete: ({ newMessages }) => { persisted.push(newMessages); },
  });
  await runTurn({
    sessionId: 'fact-real-turn', cwd: '/tmp', userText: question,
    promptBlocks: [{ type: 'text', text: question }], isAborted: () => false,
    push: async (delta: string) => { pushes.push(delta); },
    pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext);
  expect(seen.length).toBeGreaterThan(3);
  expect(seen.length).toBeLessThan(7);
  expect(dispatched).toHaveLength(6);
  expect(dispatched.every((name) => name === 'WebSearch')).toBe(true);
  expect(JSON.stringify(persisted[0])).toContain('https://example.com/model');
  expect(synthesis).toHaveLength(1);
  expect(JSON.stringify(synthesis[0])).toContain('https://example.com/model');
  const savedAnswer = extractLastAssistantText(persisted[0]!);
  expect(savedAnswer).toContain('https://example.com/model');
  expect(savedAnswer).toEndWith('더 찾아볼까요?');
  expect(pushes.join('')).toBe(savedAnswer ?? '');
  expect(savedAnswer).toContain('A model');
  expect(budgetEvents).toContainEqual({ factQuestion: true, count: 6, kinds: ['WebSearch'], maxToolTurns: 6 });
}, 30_000);

test('budget followup targets last assistant rather than trailing tool result', async () => {
  const f = fixture();
  await f.runTurn();
  const ctx = f.calls[0]!;
  for (let i = 0; i < 6; i++) await ctx.dispatchTool('WebSearch', {});
  const trailing: LLMMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search-6', content: 'https://example.com/model' }] };
  const completed = [{ role: 'assistant' as const, content: '근거 [출처](https://example.com/model)' }, trailing];
  await ctx.callbacks?.onTurnComplete?.(completed);
  expect(completed[1]).toEqual(trailing);
  expect(f.completed[0]![1]).toEqual(trailing);
  expect(f.persisted).toEqual(['근거 [출처](https://example.com/model)\n더 찾아볼까요?']);
  expect(f.pushes).toEqual(['', '근거 [출처](https://example.com/model)\n더 찾아볼까요?']);
});

test('streamed synthesis appends only the followup and preserves tool-use blocks', async () => {
  const f = fixture();
  await f.runTurn();
  const ctx = f.calls[0]!;
  for (let i = 0; i < 6; i++) await ctx.dispatchTool('WebSearch', {});
  const answer = '근거 [출처](https://example.com/model)';
  ctx.callbacks?.onText?.(answer, answer);
  const toolUse = { type: 'tool_use' as const, id: 'search-6', name: 'WebSearch', input: { query: 'model' } };
  const toolResult: LLMMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search-6', content: 'source' }] };
  await ctx.callbacks?.onTurnComplete?.([
    { role: 'assistant', content: [toolUse, { type: 'text', text: answer }] },
    toolResult,
  ]);
  const saved = f.completed[0]!;
  expect(saved[0]?.content).toEqual([toolUse, { type: 'text', text: `${answer}\n더 찾아볼까요?` }]);
  expect(saved[1]).toEqual(toolResult);
  expect(f.pushes.join('')).toBe(f.persisted[0]);
  expect(f.pushes).toEqual([answer, '\n더 찾아볼까요?']);
});

test.each(['src/acp/server.ts 의 승인 정책 고쳐줘', '현재 파일을 읽어줘?'])(
  'non-fact request %s keeps messages, budget, grant and tool behavior untouched', async (request) => {
    const f = fixture(request, { grant: true });
    await f.runTurn();
    const ctx = f.calls[0]!;
    expect(ctx.messages).toEqual([{ role: 'system', content: 'base' }, { role: 'user', content: request }]);
    expect(ctx.maxToolTurns).toBeUndefined();
    expect(ctx.budgetGrant).toEqual({ tools: ['PtyShellSend'], perCall: 6, ceiling: 60 });
    await ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: '수정했습니다.' }]);
    expect(f.persisted).toEqual(['수정했습니다.']);
  },
);

test('a fact-shaped status question on an armed goal loop gets no fact budget, no search instruction and logs the skip', async () => {
  // 10-14 운영 TUI OP: «지금 … 상황은?» 이 goal loop ⊕ 사실 질문 예산 6 을 동시에 받아 소진 뒤 헛호출 7회.
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: true } },
    chat: { ...base.chat, factQuestion: { maxToolTurns: 2 } },
  });
  const coreCalls: CoreTurnContext[] = [];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    coreCalls.push(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const log = spyOn(debug, 'log');
  const text = '지금 0.2.29 판 상황은?';
  const turn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: text }],
    getTools: () => [search],
    dispatchTool: async () => ({ ok: true }),
  });
  await turn({
    sessionId: 'goal-fact', cwd: '/tmp', userText: text,
    promptBlocks: [{ type: 'text', text }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext);
  const ctx = coreCalls[0]!;
  expect(ctx.maxToolTurns).toBeUndefined();
  // The goal loop prepends its own execution contract; only the fact instruction must be absent.
  expect(ctx.messages.some((m) => typeof m.content === 'string' && m.content.includes('사실·최신 정보 질문이다'))).toBe(false);
  // The budget gate is not wrapped around dispatch: calls past the configured 2 still reach the host.
  for (let i = 0; i < 3; i += 1) {
    expect(await ctx.dispatchTool('WebSearch', {}, {} as never)).not.toEqual({ error: 'Tool budget reached. Answer using the evidence already collected.' });
  }
  expect(log).toHaveBeenCalledWith('chat.turn', 'fact-budget-skipped', { reason: 'goal-loop-armed', route: '코딩·구현' });
  expect(log).toHaveBeenCalledWith('chat.turn', 'tool-budget', expect.objectContaining({ factQuestion: false, maxToolTurns: null }));
});

test('TUI route selects one core turn, matching tools and visible/logged decision; daemon remains unfiltered', async () => {
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: true } },
  });
  const coreCalls: CoreTurnContext[] = [];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    coreCalls.push(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const routeLog = spyOn(debug, 'log');
  const specs = ['Edit', 'Write', 'Bash', 'Agent', 'decisions_pending', 'ops_seats', 'logs_query',
    'DashboardConfigSet', 'WebSearch', 'schedule_manage', 'Read'].map((name) => ({
    name, description: '', parameters: { type: 'object' as const },
  }));
  for (const [text, expected, preferred] of [
    ['나한테 온 결정 카드 있어?', '조회', 'decisions_pending'],
    ['답변을 좀 더 빠른 모델로 바꿔줘', '설정 변경', 'DashboardConfigSet'],
    ['이번 주 업계 소식 조사', '조사', 'WebSearch'],
    ['매일 아침 8시 뉴스', '상시 일', 'schedule_manage'],
  ] as const) {
    const pushes: string[] = [];
    const turn = bridgeCoreTurnToAcp({
      tuiRouting: true,
      getMessages: () => [{ role: 'user', content: text }], getTools: () => specs,
      dispatchTool: async () => ({}),
    });
    await turn({
      sessionId: 'tui-route', cwd: '/tmp', userText: text,
      promptBlocks: [{ type: 'text', text }], isAborted: () => false,
      push: async (delta: string) => { pushes.push(delta); },
      pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
      pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    } as unknown as AcpTurnContext);
    expect(coreCalls.at(-1)?.tools.map((tool) => tool.name)).toContain(preferred);
    expect(coreCalls.at(-1)?.tools.map((tool) => tool.name)).not.toContain('Edit');
    expect(coreCalls.at(-1)?.tools.map((tool) => tool.name)).not.toContain('Write');
    expect(coreCalls.at(-1)?.tools.map((tool) => tool.name)).not.toContain('Bash');
    expect(coreCalls.at(-1)?.tools.map((tool) => tool.name).includes('Agent')).toBe(expected === '조사');
    expect(pushes[0]).toBe(`라우팅: ${expected}\n`);
    expect(routeLog).toHaveBeenCalledWith('chat.route', 'decided', {
      route: expected, reason: expect.any(String), goalLoop: false, seat: null, seatKnown: false,
    });
  }
  expect(coreCalls).toHaveLength(4);
  expect(toolsForTuiRoute(specs, '조회').map((tool) => tool.name)[0]).toBe('decisions_pending');
  // review r4: the same lookup sentence on a bridge without tuiRouting (daemon ACP) keeps every tool and no route line.
  const daemonPushes: string[] = [];
  const daemonTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: '나한테 온 결정 카드 있어?' }], getTools: () => specs,
    dispatchTool: async () => ({}),
  });
  await daemonTurn({
    sessionId: 'daemon-route', cwd: '/tmp', userText: '나한테 온 결정 카드 있어?',
    promptBlocks: [{ type: 'text', text: '나한테 온 결정 카드 있어?' }], isAborted: () => false,
    push: async (delta: string) => { daemonPushes.push(delta); },
    pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext);
  expect(coreCalls.length).toBeGreaterThan(4);
  // Every host tool stays, and the goal loop arms as before (it adds update_goal).
  expect(coreCalls.at(-1)?.tools.map((tool) => tool.name)).toEqual([...specs.map((spec) => spec.name), 'update_goal']);
  expect(daemonPushes.some((delta) => delta.startsWith('라우팅:'))).toBe(false);
});

test('TUI read question runs one full-tool turn outside the goal loop; a write request keeps it (10-14 report: UpdateGoal on reads)', async () => {
  const routeLog = spyOn(debug, 'log');
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: true } },
  });
  const coreCalls: CoreTurnContext[] = [];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    coreCalls.push(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const specs = ['Edit', 'Write', 'Bash', 'Agent', 'Read', 'decisions_pending'].map((name) => ({
    name, description: '', parameters: { type: 'object' as const },
  }));
  const run = async (text: string) => {
    const pushes: string[] = [];
    await bridgeCoreTurnToAcp({
      tuiRouting: true,
      getMessages: () => [{ role: 'user', content: text }], getTools: () => specs,
      dispatchTool: async () => ({}),
    })({
      sessionId: 'read-route', cwd: '/tmp', userText: text,
      promptBlocks: [{ type: 'text', text }], isAborted: () => false,
      push: async (delta: string) => { pushes.push(delta); },
      pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
      pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    } as unknown as AcpTurnContext);
    return { tools: coreCalls.at(-1)!.tools.map((tool) => tool.name), pushes, calls: coreCalls.length };
  };
  const read = await run('OP 앞 글 읽고 제안 표로');
  expect(read.tools).toEqual(specs.map((spec) => spec.name));
  expect(read.pushes[0]).toBe('라우팅: 읽기·분석\n');
  expect(read.calls).toBe(1);
  const transcription = await run('도구 쓰지 말고 답해: 문서의 첫 줄을 그대로 옮기고');
  expect(transcription.pushes[0]).toBe('라우팅: 읽기·분석\n');
  expect(routeLog).toHaveBeenCalledWith('chat.route', 'decided', {
    route: '읽기·분석', reason: expect.any(String), goalLoop: false, seat: null, seatKnown: false,
  });
  const write = await run('지시 문서에 절 추가');
  expect(write.tools).toEqual([...specs.map((spec) => spec.name), 'update_goal']);
  expect(write.pushes.some((delta) => delta.startsWith('라우팅:'))).toBe(false);
});

test('TUI-H1-SEAT-GOALLOOP: a seat TUI sends an operational directive to the goal loop; a human TUI keeps the single read turn', async () => {
  const coreCalls: CoreTurnContext[] = [];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    coreCalls.push(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const log = spyOn(debug, 'log');
  const specs = ['Edit', 'Read', 'RunShell'].map((name) => ({ name, description: '', parameters: { type: 'object' as const } }));
  const text = 'OP 13:14: 계속 — draft 다음 행.';
  const run = async (seat: string | null, goalLoop: boolean) => {
    const base = config.getUserConfig();
    spyOn(config, 'getUserConfig').mockReturnValue({ ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: goalLoop } } });
    const pushes: string[] = [];
    await bridgeCoreTurnToAcp({
      tuiRouting: true, resolveSeat: () => seat,
      getMessages: () => [{ role: 'user', content: text }], getTools: () => specs,
      dispatchTool: async () => ({}),
    })({
      sessionId: 'seat-route', cwd: '/tmp', userText: text,
      promptBlocks: [{ type: 'text', text }], isAborted: () => false,
      push: async (delta: string) => { pushes.push(delta); },
      pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
      pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    } as unknown as AcpTurnContext);
    return { tools: coreCalls.at(-1)!.tools.map((tool) => tool.name), pushes };
  };
  // A fast short question is a deliberate single turn even in a seat — no warning (review r4 · «OP 13:14 뭐야?» is ops-shaped yet short).
  const short = 'OP 13:14 뭐야?';
  const shortTurn = bridgeCoreTurnToAcp({
    tuiRouting: true, resolveSeat: () => 'OPT',
    getMessages: () => [{ role: 'user', content: short }], getTools: () => specs, dispatchTool: async () => ({}),
  });
  await shortTurn({
    sessionId: 'seat-short', cwd: '/tmp', userText: short,
    promptBlocks: [{ type: 'text', text: short }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext);
  expect(log).toHaveBeenCalledWith('chat.route', 'decided', expect.objectContaining({ reason: 'short-question', goalLoop: false, seat: 'OPT' }));
  expect(log.mock.calls.some(([c, e]) => c === 'chat.route' && e === 'seat-ops-single-turn')).toBe(false);
  const seatTurn = await run('OPT', true);
  expect(seatTurn.tools).toEqual([...specs.map((spec) => spec.name), 'update_goal']);
  expect(seatTurn.pushes.some((delta) => delta.startsWith('라우팅:'))).toBe(false);
  expect(log).toHaveBeenCalledWith('chat.route', 'decided', { route: '읽기·분석', reason: 'seat-read', goalLoop: true, seat: 'OPT', seatKnown: true });
  const human = await run(null, true);
  expect(human.tools).toEqual(specs.map((spec) => spec.name));
  expect(human.pushes[0]).toBe('라우팅: 읽기·분석\n');
  expect(log).toHaveBeenCalledWith('chat.route', 'decided', { route: '읽기·분석', reason: 'read', goalLoop: false, seat: null, seatKnown: true });
  expect(log.mock.calls.some(([c, e]) => c === 'chat.route' && e === 'seat-ops-single-turn')).toBe(false);
  // 인지: a seat operational directive that still runs as a single turn (goal loop off) is warned, not silent.
  await run('OPT', false);
  expect(log).toHaveBeenCalledWith('chat.route', 'seat-ops-single-turn', expect.objectContaining({ seat: 'OPT', goalLoopEnabled: false }), { level: 'warn' });
  // A failed seat lookup is «unknown», not «not a seat» (review r2): routed as a human TUI, logged seatKnown:false.
  const failing = bridgeCoreTurnToAcp({
    tuiRouting: true, resolveSeat: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    getMessages: () => [{ role: 'user', content: text }], getTools: () => specs, dispatchTool: async () => ({}),
  });
  await failing({
    sessionId: 'seat-route-err', cwd: '/tmp', userText: text,
    promptBlocks: [{ type: 'text', text }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext);
  expect(log).toHaveBeenCalledWith('chat.route', 'seat-unresolved', expect.objectContaining({ error: expect.stringContaining('EACCES') }), { level: 'warn' });
  expect(log).toHaveBeenCalledWith('chat.route', 'decided', { route: '읽기·분석', reason: 'read', goalLoop: false, seat: null, seatKnown: false });
});

test('TUI routing skips only an explicit executor harness child; a human TUI in a harness space is routed', async () => {
  const coreCalls: CoreTurnContext[] = [];
  const coreSpy = spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    coreCalls.push(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const saved = { space: process.env.ELANOUS_HARNESS_SPACE, role: process.env.ELANOUS_HARNESS_ROLE };
  const specs = ['Edit', 'decisions_pending'].map((name) => ({ name, description: '', parameters: { type: 'object' as const } }));
  const run = async () => {
    const pushes: string[] = [];
    await bridgeCoreTurnToAcp({
      tuiRouting: true,
      getMessages: () => [{ role: 'user', content: '나한테 온 결정 카드 있어?' }], getTools: () => specs,
      dispatchTool: async () => ({}),
    })({
      sessionId: 'route-role', cwd: '/tmp', userText: '나한테 온 결정 카드 있어?',
      promptBlocks: [{ type: 'text', text: '나한테 온 결정 카드 있어?' }], isAborted: () => false,
      push: async (delta: string) => { pushes.push(delta); },
      pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
      pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    } as unknown as AcpTurnContext);
    return { tools: coreCalls.at(-1)!.tools.map((tool) => tool.name), pushes };
  };
  try {
    process.env.ELANOUS_HARNESS_SPACE = 'dev-harness';
    delete process.env.ELANOUS_HARNESS_ROLE;
    const human = await run();
    expect(human.tools).toEqual(['decisions_pending']);
    expect(human.pushes[0]).toBe('라우팅: 조회\n');
    process.env.ELANOUS_HARNESS_ROLE = 'executor';
    const executor = await run();
    expect(executor.tools).toContain('Edit');
    expect(executor.pushes.some((delta) => delta.startsWith('라우팅:'))).toBe(false);
  } finally {
    coreSpy.mockRestore();
    if (saved.space === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = saved.space;
    if (saved.role === undefined) delete process.env.ELANOUS_HARNESS_ROLE; else process.env.ELANOUS_HARNESS_ROLE = saved.role;
  }
});

test('memory_recall is on every quick route (the self-access discipline asks every turn to recall)', () => {
  const specs = ['memory_recall', 'Edit', 'WebSearch'].map((name) => ({
    name, description: '', parameters: { type: 'object' as const },
  }));
  for (const route of ['조회', '설정 변경', '조사', '상시 일'] as const) {
    const names = toolsForTuiRoute(specs, route).map((tool) => tool.name);
    expect(names).toContain('memory_recall');
    expect(names).not.toContain('Edit');
  }
});

test('«조사» carries the read-only MsgList and no shell or mailbox writer (TUI-QUICK-ROUTE-EXPLICIT-CMD)', () => {
  const specs = ['WebSearch', 'Read', 'MsgList', 'MsgPost', 'MsgAck', 'RunShell', 'Bash', 'Edit', 'Write'].map((name) => ({
    name, description: '', parameters: { type: 'object' as const },
  }));
  const research = toolsForTuiRoute(specs, '조사').map((tool) => tool.name);
  expect(research).toContain('MsgList');
  for (const writer of ['MsgPost', 'MsgAck', 'RunShell', 'Bash', 'Edit', 'Write']) expect(research).not.toContain(writer);
  // The other quick routes are unchanged — MsgList is added to «조사» only.
  for (const route of ['조회', '설정 변경', '상시 일'] as const) {
    expect(toolsForTuiRoute(specs, route).map((tool) => tool.name)).not.toContain('MsgList');
  }
});

test('Agent is allowed on the investigation quick route only', () => {
  const specs = ['Agent', 'Read', 'decisions_pending', 'DashboardConfigSet', 'schedule_manage'].map((name) => ({
    name, description: '', parameters: { type: 'object' as const },
  }));
  expect(toolsForTuiRoute(specs, '조사').map((tool) => tool.name)).toContain('Agent');
  for (const route of ['조회', '설정 변경', '상시 일'] as const) {
    expect(toolsForTuiRoute(specs, route).map((tool) => tool.name)).not.toContain('Agent');
  }
});
