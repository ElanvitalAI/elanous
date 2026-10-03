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
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';
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
