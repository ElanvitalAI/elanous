import { setDefaultTimeout, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { _setGpt6CodexGuardFlagsForTest, _usesAdaptiveThinkingForContractTest, AnthropicProvider, billingRouteForProvider, codexOAuthAvailable, getGpt6CodexGuardFlags, getGpt6CodexGuardStats, logAgentTurnUsage, PROVIDERS, resetGpt6CodexGuardObservations, streamLLM, streamLLMWithTools, type Gpt6CodexGuardId, type LLMProvider } from './llm.js';
import { _resetCodexBillingDecisionForTesting, noteCodexBillingDecision } from './oauth/codex-billing-route.js';

test('credits-allowed Codex rotation records credit billing even when Codex auth is not inferred as OAuth', () => {
  // 인증 추론이 oauth 가 «아닌» 우주(빈 HOME·자격 미러 결손)를 고정한다 — oauth 우주에선
  // 수정 전 코드(auth === 'oauth' 조건)도 통과하므로 이 시험이 그 경로를 물지 못한다.
  const keys = ['HOME', 'ELANOUS_STATE_DIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_CODEX_ACCOUNT_HOME'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = mkdtempSync(join(tmpdir(), 'llm-credit-billing-'));
  for (const k of ['HOME', 'ELANOUS_STATE_DIR', 'XDG_CONFIG_HOME', 'CODEX_HOME'] as const) process.env[k] = root;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_CODEX_ACCOUNT_HOME;
  _resetCodexBillingDecisionForTesting();
  const spy = spyOn(debug, 'log');
  try {
    expect(codexOAuthAvailable()).toBe(false);
    // 결정이 없으면 기존 경로 그대로 — 크레딧이 아니다.
    expect(billingRouteForProvider('openai-codex', 'gpt-5.6-terra')).not.toBe('credit');
    noteCodexBillingDecision('credits-allowed');
    expect(billingRouteForProvider('openai-codex', 'gpt-5.6-terra')).toBe('credit');
    logAgentTurnUsage('gpt-5.6-terra', {
      provider: 'openai', inputTokens: 1_000_000, outputTokens: 0,
    }, { providerName: 'openai-codex', site: 'codex-credit-billing-test' });
    const row = spy.mock.calls.find((call) =>
      call[0] === 'llm.usage'
      && call[1] === 'llm-usage'
      && (call[2] as { site?: string })?.site === 'codex-credit-billing-test');
    expect(row).toBeDefined();
    expect(row![2]).toMatchObject({ billing: 'credit', billingProvider: 'openai-codex' });
    expect((row![2] as { cost: unknown }).cost).toMatchObject({ kind: 'credit', usd: null });
  } finally {
    spy.mockRestore();
    _resetCodexBillingDecisionForTesting();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function observeDone(run: () => Promise<unknown>) {
  const done: Record<string, unknown>[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.router.done' && event === 'streamLLM') done.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    await run();
    return done;
  } finally {
    log.mockRestore();
  }
}

test('streamLLM always consumes streamChat usage, aggregates raw fields, and preserves callback fail-softness', async () => {
  let chatCalls = 0;
  let streamCalls = 0;
  const provider: LLMProvider = {
    name: 'grok',
    defaultModel: 'grok-4.6',
    available: () => true,
    async *chat() { chatCalls++; yield 'fallback'; },
    async *streamChat() {
      streamCalls++;
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 2 } };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, cacheCreationInputTokens: 1 } };
      yield { type: 'text', delta: 'answer' };
    },
  };
  const usages: number[] = [];
  const chunks: string[] = [];
  let withCallback = '';
  let withoutCallback = '';
  const done = await observeDone(async () => {
    withCallback = await streamLLM([{ role: 'user', content: 'question' }], (delta) => chunks.push(delta), {
      provider,
      onUsage: ({ inputTokens }) => {
        usages.push(inputTokens ?? 0);
        throw new Error('telemetry unavailable');
      },
    });
    withoutCallback = await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider });
  });

  expect(withCallback).toBe('answer');
  expect(withoutCallback).toBe('answer');
  expect(usages).toEqual([12, 8]);
  expect(chunks).toEqual(['answer']);
  expect(chatCalls).toBe(0);
  expect(streamCalls).toBe(2);
  expect(done).toHaveLength(2);
  expect(done.map((entry) => entry.usage)).toEqual([
    { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 },
    { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 },
  ]);
});

test('streamLLM retains chat fallback and observes usage as unmeasured without streamChat', async () => {
  let chatCalls = 0;
  const provider: LLMProvider = {
    name: 'grok',
    defaultModel: 'grok-4.6',
    available: () => true,
    async *chat() { chatCalls++; yield 'fallback'; },
  };
  let text = '';
  const done = await observeDone(async () => {
    text = await streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider });
  });

  expect(text).toBe('fallback');
  expect(chatCalls).toBe(1);
  expect(done).toHaveLength(1);
  expect(done[0]?.usage).toBe('unmeasured');
});

test('streamLLM preserves an injected unregistered provider at the streaming boundary', async () => {
  const provider: LLMProvider = {
    name: 'injected-test-provider',
    defaultModel: 'injected-model',
    available: () => true,
    async *chat() { yield 'injected'; },
  };

  await expect(streamLLM([{ role: 'user', content: 'question' }], () => {}, { provider }))
    .resolves.toBe('injected');
});

test('streamLLM reroutes an incompatible Codex provider and Grok model before streaming', async () => {
  const codex = PROVIDERS['openai-codex']!;
  const grok = PROVIDERS.grok!;
  const originalCodexStream = codex.streamChat;
  const originalGrokStream = grok.streamChat;
  let codexCalls = 0;
  let receivedModel = '';
  codex.streamChat = async function* () { codexCalls++; yield { type: 'text', delta: 'wrong-provider' }; };
  grok.streamChat = async function* (_messages, opts) {
    receivedModel = opts?.model ?? '';
    yield { type: 'text', delta: 'rerouted' };
  };
  try {
    const text = await streamLLM([{ role: 'user', content: 'question' }], () => {}, {
      provider: codex,
      model: 'grok-4.6',
    });
    expect(text).toBe('rerouted');
    expect(codexCalls).toBe(0);
    expect(receivedModel).toBe('grok-4.6');
  } finally {
    codex.streamChat = originalCodexStream;
    grok.streamChat = originalGrokStream;
  }
});

test('streamLLMWithTools reroutes an incompatible Codex provider and Grok model before streaming', async () => {
  const codex = PROVIDERS['openai-codex']!;
  const grok = PROVIDERS.grok!;
  const originalCodexStream = codex.streamChat;
  const originalGrokStream = grok.streamChat;
  let codexCalls = 0;
  let receivedModel = '';
  codex.streamChat = async function* () { codexCalls++; yield { type: 'text', delta: 'wrong-provider' }; };
  grok.streamChat = async function* (_messages, opts) {
    receivedModel = opts?.model ?? '';
    yield { type: 'text', delta: 'rerouted-tools' };
  };
  try {
    const text = await streamLLMWithTools(
      [{ role: 'user', content: 'question' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider: codex, model: 'grok-4.6', tools: [{ name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } }] },
    );
    expect(text).toBe('rerouted-tools');
    expect(codexCalls).toBe(0);
    expect(receivedModel).toBe('grok-4.6');
  } finally {
    codex.streamChat = originalCodexStream;
    grok.streamChat = originalGrokStream;
  }
});

test('streamLLMWithTools preserves compatible provider/model pairs before streaming', async () => {
  const grok = PROVIDERS.grok!;
  const originalGrokStream = grok.streamChat;
  let receivedModel = '';
  grok.streamChat = async function* (_messages, opts) {
    receivedModel = opts?.model ?? '';
    yield { type: 'text', delta: 'compatible' };
  };
  try {
    const text = await streamLLMWithTools(
      [{ role: 'user', content: 'question' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider: grok, model: 'grok-4.6', tools: [{ name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } }] },
    );
    expect(text).toBe('compatible');
    expect(receivedModel).toBe('grok-4.6');
  } finally {
    grok.streamChat = originalGrokStream;
  }
});

test('Anthropic request for Claude 5.5 includes interleaved-thinking beta', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const sent: { model: string; beta: string | null }[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
    const headers = new Headers(init?.headers);
    sent.push({ model: JSON.parse(String(init?.body)).model, beta: headers.get('anthropic-beta') });
    return new Response('data: {"type":"message_stop"}\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    for await (const _event of AnthropicProvider.streamChat!([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-5-5', promptCache: false,
    })) { /* consume the response */ }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe('claude-sonnet-5-5');
    expect(sent[0]?.beta?.split(',')).toContain('interleaved-thinking-2025-05-14');
  } finally {
    fetchSpy.mockRestore();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

// 🩸 2026-09-25 — 도구 루프 조립부가 reasoning 꺼진 adaptive 모델(claude-sonnet-5)에 temperature 를 보내 400.
import { anthropicTemperatureField } from './llm.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('adaptive thinking contract stays on 4.7+ and 5.x, not legacy 3.7/4.5', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-4-7']) {
    expect(_usesAdaptiveThinkingForContractTest(model)).toBe(true);
  }
  for (const model of ['claude-3-7-sonnet', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku']) {
    expect(_usesAdaptiveThinkingForContractTest(model)).toBe(false);
  }
});

test('anthropic temperature field: adaptive models never get temperature, even with thinking off', () => {
  expect(anthropicTemperatureField('claude-sonnet-5', false, undefined)).toEqual({});
  expect(anthropicTemperatureField('claude-opus-5', false, 0.7)).toEqual({});
  expect(anthropicTemperatureField('claude-sonnet-4-7', false, undefined)).toEqual({});
  expect(anthropicTemperatureField('claude-haiku-4-5-20251001', false, undefined)).toEqual({ temperature: 0.3 });
  expect(anthropicTemperatureField('claude-haiku-4-5-20251001', true, undefined)).toEqual({});
  expect(anthropicTemperatureField('claude-haiku-4-5-20251001', false, 0.9)).toEqual({ temperature: 0.9 });
});

// BACKLOG B7 — anthropic 기본 모델은 사다리 best(최신 Opus)에서 파생 · 옛 haiku 상수가 아니다(대표 09-25).
test('ANTHROPIC_MODEL defaults to the anthropic ladder best model (latest Opus), not the legacy haiku constant', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_MODEL;
  const r = Bun.spawnSync({
    cmd: [process.execPath, '-e', `import { ANTHROPIC_MODEL } from ${JSON.stringify(new URL('./config.ts', import.meta.url).href)}; import { lookupLlmTierSpec } from ${JSON.stringify(new URL('./model-tier/llm-tier-map.ts', import.meta.url).href)}; console.log(JSON.stringify({ got: ANTHROPIC_MODEL, want: lookupLlmTierSpec('anthropic', 'best').model }))`],
    env, stdout: 'pipe', stderr: 'pipe',
  });
  const { got, want } = JSON.parse(new TextDecoder().decode(r.stdout).trim());
  expect(got).toBe(want);
  expect(got).not.toContain('haiku');
});

async function runGpt6ToolCall(
  call: { name: string; args: Record<string, unknown> },
  options: { model?: string; maxTurns?: number; callsPerStream?: number; flags?: Partial<Record<Gpt6CodexGuardId, boolean>> } = {},
): Promise<{ result: string; toolResults: string[]; dispatches: number }> {
  let turn = 0;
  let dispatches = 0;
  const toolResults: string[] = [];
  const provider: LLMProvider = {
    name: 'gpt6-guard-test-provider',
    defaultModel: 'gpt-6-sol',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      if (turn < (options.callsPerStream ?? 1)) {
        turn++;
        const args = call.name === 'Grep' && (options.callsPerStream ?? 1) > 1 && typeof call.args.pattern === 'string'
          ? { ...call.args, pattern: `${call.args.pattern}-${turn}` }
          : call.args;
        yield { type: 'tool_call', id: `call-${turn}`, name: call.name, args };
        return;
      }
      yield { type: 'text', delta: 'done' };
    },
  };
  if (options.flags !== undefined) _setGpt6CodexGuardFlagsForTest(options.flags);
  try {
    const result = await streamLLMWithTools(
      [
        { role: 'system', content: `=== Collaboration guide (AGENTS.md @ .) ===\nAnchor text\n=== end AGENTS.md @ . ===` },
        { role: 'user', content: 'inspect' },
      ],
      {
        onText() {},
        onToolResult: ({ result }) => toolResults.push(String(result)),
        dispatchTool: async () => { dispatches++; return 'executed'; },
      },
      {
        provider,
        model: options.model ?? 'gpt-6-sol',
        tools: [{ name: call.name, description: 'test tool', parameters: { type: 'object', properties: {} } }],
        maxTurns: options.maxTurns ?? 3,
        slowToolTickMs: 60_000,
      },
    );
    return { result, toolResults, dispatches };
  } finally {
    if (options.flags !== undefined) _setGpt6CodexGuardFlagsForTest(undefined);
  }
}

test('GPT-6 anchor Read/Grep and literal Glob retain existing blocks while recording observations', async () => {
  const anchorPath = join(process.cwd(), 'AGENTS.md');
  const calls = [
    { name: 'Read', args: { file_path: anchorPath } },
    { name: 'Grep', args: { pattern: 'routing', glob: '**/AGENTS.md' } },
    { name: 'Glob', args: { pattern: 'src/llm.ts' } },
  ] as const;
  const guardIds = ['anchor-read', 'anchor-grep', 'literal-glob'] as const;
  expect(Object.values(getGpt6CodexGuardFlags()).every((enabled) => !enabled)).toBe(true);
  resetGpt6CodexGuardObservations();
  for (const call of calls) {
    const observed = await runGpt6ToolCall(call);
    expect(observed.dispatches).toBe(0);
  }
  const shadowStats = getGpt6CodexGuardStats();
  for (const id of guardIds) expect(shadowStats[id]).toEqual({ wouldBlock: 1, blocked: 1 });

  resetGpt6CodexGuardObservations();
  for (let index = 0; index < calls.length; index++) {
    const id = guardIds[index]!;
    const active = await runGpt6ToolCall(calls[index]!, { flags: { [id]: true } });
    expect(active.dispatches).toBe(0);
    expect(active.toolResults[0]).toContain(idleMessageForGuard(id));
    expect(getGpt6CodexGuardStats()[id]).toEqual({ wouldBlock: 1, blocked: 1 });
  }
});

function idleMessageForGuard(id: Gpt6CodexGuardId): string {
  if (id === 'anchor-read') return 'ANCHOR READ BLOCKED';
  if (id === 'anchor-grep') return 'ANCHOR GREP BLOCKED';
  return 'LITERAL-PATH GLOB BLOCKED';
}

test('GPT-6 exploration budget retains existing rejection through streamLLMWithTools', async () => {
  resetGpt6CodexGuardObservations();
  const shadow = await runGpt6ToolCall(
    { name: 'Grep', args: { pattern: 'candidate', path: 'src', output_mode: 'content' } },
    { maxTurns: 8, callsPerStream: 4 },
  );
  expect(shadow.dispatches).toBe(2);
  expect(getGpt6CodexGuardStats()['exploration-budget']).toEqual({ wouldBlock: 1, blocked: 1 });

  resetGpt6CodexGuardObservations();
  const enabled = await runGpt6ToolCall(
    { name: 'Grep', args: { pattern: 'candidate', path: 'src', output_mode: 'content' } },
    { maxTurns: 8, callsPerStream: 4, flags: { 'exploration-budget': true, 'search-only-streak': false } },
  );
  expect(enabled.dispatches).toBe(2);
  expect(enabled.toolResults.some((result) => result.includes('EXPLORATION BUDGET EXHAUSTED'))).toBe(true);
  expect(getGpt6CodexGuardStats()['exploration-budget']).toEqual({ wouldBlock: 1, blocked: 1 });
});

test('GPT-6 max-turn synthesis retains existing budget boundary', async () => {
  resetGpt6CodexGuardObservations();
  const shadow = await runGpt6ToolCall(
    { name: 'Bash', args: { command: 'printf one' } },
    { maxTurns: 10, callsPerStream: 10 },
  );
  expect(shadow.dispatches).toBe(8);
  expect(getGpt6CodexGuardStats()['max-turns']).toEqual({ wouldBlock: 2, blocked: 2 });

  resetGpt6CodexGuardObservations();
  const enabled = await runGpt6ToolCall(
    { name: 'Bash', args: { command: 'printf one' } },
    { maxTurns: 10, callsPerStream: 10, flags: { 'max-turns': true, 'force-synthesis': false } },
  );
  expect(enabled.dispatches).toBe(8);
  expect(enabled.toolResults.some((result) => result.includes('tool-loop budget exhausted'))).toBe(true);
  expect(getGpt6CodexGuardStats()['max-turns']).toEqual({ wouldBlock: 2, blocked: 2 });
});

test('legacy Codex anchor Read blocking remains active independently of GPT-6 flags', async () => {
  resetGpt6CodexGuardObservations();
  const result = await runGpt6ToolCall(
    { name: 'Read', args: { file_path: join(process.cwd(), 'AGENTS.md') } },
    { model: 'gpt-5.4-codex' },
  );
  expect(result.dispatches).toBe(0);
  expect(result.toolResults[0]).toContain('ANCHOR READ BLOCKED');
  expect(getGpt6CodexGuardStats()['anchor-read']).toEqual({ wouldBlock: 0, blocked: 0 });
});

test('GPT-6 guard flags leave the ordinary GPT family tool behavior unchanged', async () => {
  resetGpt6CodexGuardObservations();
  const result = await runGpt6ToolCall(
    { name: 'Glob', args: { pattern: 'src/llm.ts' } },
    { model: 'gpt-4o' },
  );
  expect(result.dispatches).toBe(1);
  expect(result.result).toBe('done');
  expect(getGpt6CodexGuardStats()['literal-glob']).toEqual({ wouldBlock: 0, blocked: 0 });
});

// MODEL-FAMILY-GPT6-GUARDS-FU-COUNTERS — counters vs. events through the production
// streamLLMWithTools entry. `wouldBlock` = the guard predicate held this turn;
// `blocked` = the guard actually stopped/rejected (grace burn and arming are not blocks).
async function runGpt6GuardStream(options: {
  user: string;
  dispatchResult: string;
  callsPerStream: number;
  maxTurns?: number;
  flags?: Partial<Record<Gpt6CodexGuardId, boolean>>;
  synthesisText?: string;
  call?: { name: string; args: Record<string, unknown> };
}): Promise<{ result: string; events: Array<{ event: string; data: Record<string, unknown> }> }> {
  let turn = 0;
  const call = options.call ?? { name: 'Read', args: { file_path: 'src/llm.ts' } };
  const provider: LLMProvider = {
    name: 'gpt6-guard-counter-test-provider',
    defaultModel: 'gpt-6-sol',
    available: () => true,
    async *chat() { yield options.synthesisText ?? ''; },
    async *streamChat() {
      if (turn < options.callsPerStream) {
        turn++;
        yield { type: 'tool_call', id: `call-${turn}`, name: call.name, args: { ...call.args, offset: turn } };
        return;
      }
      yield { type: 'text', delta: 'done' };
    },
  };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'llm.router') events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
  if (options.flags !== undefined) _setGpt6CodexGuardFlagsForTest(options.flags);
  try {
    const result = await streamLLMWithTools(
      [{ role: 'user', content: options.user }],
      { onText() {}, dispatchTool: async () => options.dispatchResult },
      {
        provider,
        model: 'gpt-6-sol',
        tools: [{ name: call.name, description: 'test tool', parameters: { type: 'object', properties: {} } }],
        maxTurns: options.maxTurns ?? 12,
        slowToolTickMs: 60_000,
      },
    );
    return { result, events };
  } finally {
    spy.mockRestore();
    if (options.flags !== undefined) _setGpt6CodexGuardFlagsForTest(undefined);
  }
}

const UNPARSED_AUTO_NARROWED = '[AUTO-NARROWED] partial window only';
const PARSED_AUTO_NARROWED = '[AUTO-NARROWED] Read(file_path="src/llm.ts")\n12  const value = computeValue();';
const INSPECT_FLAGS = { 'inspect-budget': true, 'followup-hard-stop': true } as const;

function eventNames(events: Array<{ event: string }>): string[] {
  return events.map((e) => e.event);
}

test('GPT-6 followup-hard-stop: grace>0 burn records wouldBlock without blocked', async () => {
  resetGpt6CodexGuardObservations();
  const { events } = await runGpt6GuardStream({
    user: 'inspect the module layout', dispatchResult: UNPARSED_AUTO_NARROWED, callsPerStream: 3, flags: INSPECT_FLAGS,
  });
  const names = eventNames(events);
  expect(names).toContain('tool-loop.inspect-synthesis-phase.codex-grace-burned');
  expect(names).not.toContain('tool-loop.inspect-synthesis-phase.codex-immediate-stop');
  expect(getGpt6CodexGuardStats()['followup-hard-stop']).toEqual({ wouldBlock: 1, blocked: 0 });
});

test('GPT-6 followup-hard-stop: grace=0 immediate stop is the only blocked increment', async () => {
  resetGpt6CodexGuardObservations();
  const { events } = await runGpt6GuardStream({
    user: 'inspect the module layout', dispatchResult: UNPARSED_AUTO_NARROWED, callsPerStream: 4, flags: INSPECT_FLAGS,
  });
  const names = eventNames(events);
  expect(names.filter((n) => n === 'tool-loop.inspect-synthesis-phase.codex-grace-burned')).toHaveLength(1);
  expect(names.filter((n) => n === 'tool-loop.inspect-synthesis-phase.codex-immediate-stop')).toHaveLength(1);
  expect(getGpt6CodexGuardStats()['followup-hard-stop']).toEqual({ wouldBlock: 2, blocked: 1 });
});

test('GPT-6 inspect-budget execution: arming is wouldBlock only, never blocked', async () => {
  resetGpt6CodexGuardObservations();
  const { events } = await runGpt6GuardStream({
    user: 'debug the crash in the module', dispatchResult: PARSED_AUTO_NARROWED, callsPerStream: 2, flags: INSPECT_FLAGS,
  });
  const armed = events.filter((e) => e.event === 'tool-loop.inspect-synthesis-armed');
  expect(armed).toHaveLength(1);
  expect(armed[0]!.data.reason).toBe('codex-inspect-budget-execution');
  expect(getGpt6CodexGuardStats()['inspect-budget']).toEqual({ wouldBlock: 1, blocked: 0 });
});

test('GPT-6 force-synthesis: unmet (natural end · empty synthesis) vs met events match counters', async () => {
  resetGpt6CodexGuardObservations();
  const natural = await runGpt6GuardStream({
    user: 'run it', dispatchResult: 'ok', callsPerStream: 1, call: { name: 'Bash', args: { command: 'printf one' } },
  });
  expect(eventNames(natural.events)).not.toContain('tool-loop.force-synthesis-pass.emitted');
  expect(eventNames(natural.events)).not.toContain('tool-loop.synthesis-ignored.hard-stop');
  expect(getGpt6CodexGuardStats()['force-synthesis']).toEqual({ wouldBlock: 0, blocked: 0 });

  resetGpt6CodexGuardObservations();
  const empty = await runGpt6GuardStream({
    user: 'run it', dispatchResult: 'ok', callsPerStream: 10, maxTurns: 10, synthesisText: 'short',
    call: { name: 'Bash', args: { command: 'printf one' } },
  });
  // max-turns synthesis phase hard-stops first (legacy-active) → W5-E force-synthesis on that hard stop.
  const emptyEnd = empty.events.find((e) => e.event === 'tool-loop.synthesis-ignored.hard-stop');
  expect(emptyEnd?.data.forceSynthesisAttempted).toBe(true);
  expect(eventNames(empty.events)).not.toContain('tool-loop.force-synthesis-pass.emitted');
  expect(getGpt6CodexGuardStats()['force-synthesis']).toEqual({ wouldBlock: 1, blocked: 1 });

  resetGpt6CodexGuardObservations();
  const met = await runGpt6GuardStream({
    user: 'run it', dispatchResult: 'ok', callsPerStream: 10, maxTurns: 10,
    synthesisText: 'A substantive synthesized final answer that is comfortably longer than fifty characters.',
    call: { name: 'Bash', args: { command: 'printf one' } },
  });
  expect(eventNames(met.events)).toContain('tool-loop.force-synthesis-pass.emitted');
  expect(eventNames(met.events)).not.toContain('tool-loop.synthesis-ignored.hard-stop');
  expect(getGpt6CodexGuardStats()['force-synthesis']).toEqual({ wouldBlock: 1, blocked: 1 });
});

// Scope note: the GPT-6 guard counters are module-level (process-global). Two streams running
// concurrently in one process add into the SAME tally — there is no per-stream / per-run split.
test('GPT-6 guard counters are process-global: concurrent streams aggregate into one tally', async () => {
  resetGpt6CodexGuardObservations();
  await Promise.all([1, 2].map(() => runGpt6GuardStream({
    user: 'debug the crash in the module', dispatchResult: PARSED_AUTO_NARROWED, callsPerStream: 2, flags: INSPECT_FLAGS,
  })));
  expect(getGpt6CodexGuardStats()['inspect-budget']).toEqual({ wouldBlock: 2, blocked: 0 });
});
