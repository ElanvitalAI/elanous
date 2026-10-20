// TUI-STREAM-RETRY — 흐르던 스트림이 소켓 끊김으로 죽으면 같은 공급자로 다시 건 «뒤에만» 폴백한다.
// 실측(2026-10-14 06:27Z TUI): codex 200 OK·reasoning delta 뒤 «The socket connection was closed unexpectedly» →
// llm.retry 0건 · 곧장 provider-fallback-exhausted 로 턴이 죽었다.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { runDashboardPlainTurnStream, type DashboardPlainTurnAcpSend } from './dashboard/input/dashboard-plain-turn-stream.js';
import { createTurnStreamFormatter } from './dashboard/turn-stream-formatter.js';
import { setUserConfigOverlay } from './user-config.js';
import { testFakeLlmProvider } from './ux-sim/fake-llm.js';
import { OverloadFailoverError } from './session-runtime/retry-api.js';
import {
  _explainAndLogFallbackCandidatesForTest,
  _setStreamDisconnectRetryDelayForTest,
  PROVIDERS,
  streamLLM,
  streamLLMWithTools,
  type LLMMessage,
  type LLMProvider,
  type LLMStreamEvent,
} from './llm.js';

type Logged = { category: string; event: string; data: Record<string, unknown> };

function socketClosed(): Error {
  return Object.assign(
    new Error('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'),
    { code: 'ECONNRESET' },
  );
}

/** 호출마다 대본 하나를 흘린다 — `throw` 칸이 있으면 그 자리에서 끊긴다. */
function scriptedProvider(scripts: Array<Array<LLMStreamEvent | 'throw'>>, name = 'probe-provider') {
  let calls = 0;
  const provider: LLMProvider = {
    name,
    defaultModel: name === 'probe-provider' ? 'gpt-4o-mini' : `${name}-model`,
    available: () => true,
    async *streamChat() {
      const script = scripts[Math.min(calls, scripts.length - 1)]!;
      calls++;
      for (const step of script) {
        if (step === 'throw') throw socketClosed();
        yield step;
      }
    },
    async *chat() {},
  };
  return { provider, calls: () => calls };
}

let logs: Logged[] = [];
let logSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  logs = [];
  logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    logs.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
  _setStreamDisconnectRetryDelayForTest(() => 0);
});

afterEach(() => {
  logSpy?.mockRestore();
  _setStreamDisconnectRetryDelayForTest(undefined);
});

async function run(provider: LLMProvider, dispatchTool: () => Promise<unknown> = async () => ({ ok: true })) {
  // 델타 그대로 — 화면에 실제로 «덧붙는» 조각.
  const screen: string[] = [];
  let completed: LLMMessage[] = [];
  const text = await streamLLMWithTools(
    [{ role: 'user', content: 'go' }],
    {
      onText: (delta) => { screen.push(delta); },
      dispatchTool,
      onTurnComplete: (messages) => { completed = messages; },
    },
    {
      provider,
      model: 'gpt-4o-mini',
      tools: [{ name: 'probe', description: 'side-effecting probe', parameters: {} }],
      maxTurns: 4,
    },
  );
  return { text, screen, completed };
}

/** TUI 실경로 — `streamLLMWithTools` → (델타만 나르는 ACP 관) → `runDashboardPlainTurnStream` → `createTurnStreamFormatter`.
 *  formatter 이벤트를 채팅 화면처럼 접어 «최종 렌더 문자열»을 돌려준다(커밋된 블록 ⊕ 현재 블록). */
async function runThroughTuiPath(provider: LLMProvider) {
  const committed: string[] = [];
  let current: string[] = [];
  const formatter = createTurnStreamFormatter({
    emit: (event) => {
      if (event.type === 'assistant.replaceBlock') current = [...event.lines];
      else if (event.type === 'assistant.commit') { committed.push(...current); current = []; }
    },
    thinking: { update: () => {}, updateMetrics: () => {} },
    termCols: () => 200,
    wrapOpts: {},
    formatResponse: (full) => (full.length === 0 ? [] : [full]),
    text: (line) => line,
    muted: (text) => text,
    ptyCallLine: () => null,
    ptyResultLine: () => null,
    renderToolCallEvent: () => null,
    renderToolResultVariants: () => null,
    toolRendering: {},
    brainIcon: '',
  });
  const acpSession: DashboardPlainTurnAcpSend = {
    // 실 ACP 관(core-turn-bridge → dashboard-session)은 «델타만» 나른다 — accumulated 는 버려진다.
    send: (req) => streamLLMWithTools(
      [{ role: 'user', content: req.userText }],
      { onText: (delta) => req.onText(delta), dispatchTool: async () => ({ ok: true }) },
      { provider, model: 'gpt-4o-mini', maxTurns: 2, signal: req.signal, tools: [{ name: 'probe', description: 'side-effecting probe', parameters: {} }] },
    ),
  };
  await runDashboardPlainTurnStream({
    userText: 'go',
    abortCtrl: new AbortController(),
    acpSession,
    onText: (chunk, accumulated) => formatter.onText(chunk, accumulated),
    onToolCall: () => {},
    onToolResult: () => {},
    onUsage: () => {},
    autoTts: { pushChunk: () => {}, commit: () => {}, cancel: () => {} },
    voiceChat: { getPhase: () => 'idle', transitionToSpeaking: () => {}, notifyResponseDone: () => {} },
    drainCooldownMs: 0,
    resetTurnRef: () => {},
  });
  return [...committed, ...current].join('\n');
}

describe('mid-stream socket close → same-provider retry', () => {
  it('retries after partial text/reasoning deltas and completes the turn; screen shows the answer once', async () => {
    const { provider, calls } = scriptedProvider([
      [{ type: 'reasoning', kind: 'summary_delta', delta: 'thinking' }, { type: 'text', delta: 'Hello ' }, { type: 'text', delta: 'wor' }, 'throw'],
      [{ type: 'text', delta: 'Hello' }, { type: 'text', delta: ' world' }],
    ]);
    const { text, screen, completed } = await run(provider);

    expect(calls()).toBe(2);
    expect(text).toBe('Hello world');
    // 델타만 이어 붙이는 소비자 기준 — 이미 보인 'Hello wor' 는 다시 안 나가고 'ld' 만 이어 붙는다.
    expect(screen.join('')).toBe('Hello world');
    // 이력: 끊긴 조각이 따로 남지 않는다.
    expect(JSON.stringify(completed)).not.toContain('Hello worHello');

    const retries = logs.filter((l) => l.category === 'llm.retry' && l.event === 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.data).toMatchObject({
      provider: 'probe-provider',
      scope: 'stream-disconnect',
      category: 'network-transient',
      attempt: 1,
      rewoundTextChars: 'Hello wor'.length,
    });
  });

  it('renders the retried answer exactly once through the real TUI plain-turn path', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'text', delta: 'Hello ' }, { type: 'text', delta: 'wor' }, 'throw'],
      [{ type: 'text', delta: 'Hello world' }],
    ]);
    expect(await runThroughTuiPath(provider)).toBe('Hello world');
  });

  it('when the retry diverges from what was shown, commits a boundary once and keeps only the retry in history', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'text', delta: 'partial ans' }, 'throw'],
      [{ type: 'text', delta: 'full answer' }],
    ]);
    const rendered = await runThroughTuiPath(provider);
    // 화면엔 «커밋 없이 지우는» 신호가 없다 — 옛 조각은 지난 서술로 남고 새 본문은 한 번만 나온다.
    expect(rendered).toBe('partial ans\nfull answer');
    expect(rendered.split('full answer')).toHaveLength(2);
    expect(logs.some((l) => l.category === 'llm.retry' && l.event === 'stream-retry-display-diverged')).toBe(true);

    const { provider: again } = scriptedProvider([
      [{ type: 'text', delta: 'partial ans' }, 'throw'],
      [{ type: 'text', delta: 'full answer' }],
    ]);
    const { text, completed } = await run(again);
    expect(text).toBe('full answer');
    expect(JSON.stringify(completed)).not.toContain('partial ans');
  });

  it('gives up after the bounded number of same-provider retries', async () => {
    const { provider, calls } = scriptedProvider([[{ type: 'text', delta: 'x' }, 'throw']]);
    await expect(run(provider)).rejects.toThrow(/socket connection was closed/);
    expect(calls()).toBe(6); // 첫 시도 1 + 재시도 5
    expect(logs.filter((l) => l.category === 'llm.retry' && l.event === 'retry')).toHaveLength(5);
    expect(logs.some((l) => l.category === 'llm.retry' && l.event === 'max-attempts-exhausted')).toBe(true);
  });
});

describe('tool calls are never dispatched twice', () => {
  it('keeps the result of an already-dispatched tool and only re-sends the broken turn', async () => {
    let dispatched = 0;
    const { provider, calls } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'probe', args: {} }],
      [{ type: 'text', delta: 'half' }, 'throw'],
      [{ type: 'text', delta: 'done after tool' }],
    ]);
    const { text } = await run(provider, async () => { dispatched++; return { ok: true }; });

    expect(dispatched).toBe(1);
    expect(calls()).toBe(3);
    expect(text).toContain('done after tool');
    expect(text).not.toContain('half');
  });

  it('does not retry a stream that already emitted a tool_call before the disconnect', async () => {
    let dispatched = 0;
    const { provider, calls } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'probe', args: {} }, 'throw'],
      [{ type: 'text', delta: 'should not be reached' }],
    ]);
    await expect(run(provider, async () => { dispatched++; return { ok: true }; })).rejects.toThrow(/socket connection was closed/);

    expect(calls()).toBe(1);
    expect(dispatched).toBe(0);
    expect(logs.some((l) => l.category === 'llm.retry')).toBe(false);
  });
});

describe('fallback candidate skip reasons', () => {
  it('logs why each configured chain step was skipped, including the folded codex-credits step', () => {
    const candidates = _explainAndLogFallbackCandidatesForTest(['openai-codex'], ['codex-rotate', 'codex-credits', 'not-a-step']);

    expect(candidates).not.toContain('openai-codex');
    const line = logs.find((l) => l.category === 'llm.router' && l.event === 'fallback-candidates');
    expect(line).toBeDefined();
    expect(line!.data.failedProvider).toBe('openai-codex');
    expect(line!.data.skipped).toEqual(expect.arrayContaining([
      { step: 'codex-rotate', provider: 'openai-codex', reason: 'already-attempted' },
      { step: 'codex-credits', provider: 'openai-codex', reason: 'folded-into-earlier-step' },
      { step: 'not-a-step', reason: 'unknown-step' },
    ]));
  });
});

describe('retry budget is per provider', () => {
  const originalProviders = { ...PROVIDERS };
  const savedEnv: Record<string, string | undefined> = {};
  let tmpHome: string | null = null;

  beforeEach(() => {
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL']) {
      savedEnv[key] = process.env[key];
    }
    tmpHome = mkdtempSync(join(tmpdir(), 'llm-stream-retry-'));
    process.env.HOME = tmpHome;
    process.env.XDG_CONFIG_HOME = tmpHome;
    process.env.CODEX_HOME = join(tmpHome, 'codex-home');
    for (const key of ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    Object.assign(PROVIDERS, originalProviders);
    setUserConfigOverlay(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  });

  it('a simulated codex 503 continues on the configured zai step through the fake LLM', async () => {
    let codexCalls = 0;
    PROVIDERS['openai-codex'] = {
      name: 'openai-codex', defaultModel: 'gpt-6-sol', available: () => true,
      async *streamChat() {
        codexCalls++;
        throw new OverloadFailoverError({ provider: 'codex', status: 503, kind: 'overloaded',
          streak: 3, cause: new Error('server_is_overloaded') });
      },
      async *chat() {},
    };
    PROVIDERS.glm = { ...testFakeLlmProvider, name: 'glm', defaultModel: 'glm-5.3', available: () => true };
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm,
      provider: 'openai-codex', fallbackChain: ['codex-rotate', 'zai'] } }));

    const answer = await streamLLM(
      [{ role: 'user', content: 'go' }],
      () => {},
      { initialProvider: PROVIDERS['openai-codex'] },
    );
    expect(answer).toBe('[test-fake-llm] OK');
    expect(codexCalls).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({ category: 'llm.router', event: 'overload-failover',
      data: expect.objectContaining({ blockedProvider: 'openai-codex', fallbackProvider: 'glm', status: 503 }) }));
  });

  it('text stream skips a candidate that loses availability before the Codex overload switch', async () => {
    let grokChecks = 0;
    PROVIDERS.grok = { ...testFakeLlmProvider, name: 'grok', available: () => ++grokChecks <= 2 };
    PROVIDERS.glm = { ...testFakeLlmProvider, name: 'glm', defaultModel: 'glm-5.3', available: () => true };
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm,
      fallbackChain: ['codex-rotate', 'grok', 'zai'] } }));
    const codex: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6-sol', available: () => true,
      async *chat() {},
      async *streamChat() {
        throw new OverloadFailoverError({ provider: 'codex', status: 503, kind: 'overloaded',
          streak: 3, cause: new Error('server_is_overloaded') });
      },
    };
    const answer = await streamLLM([{ role: 'user', content: 'go' }], () => {}, { initialProvider: codex });
    expect(answer).toBe('[test-fake-llm] OK');
    expect(grokChecks).toBeGreaterThanOrEqual(3);
    expect(logs).toContainEqual(expect.objectContaining({ category: 'llm.router', event: 'overload-failover',
      data: expect.objectContaining({ fallbackProvider: 'glm' }) }));
  });

  it('tool stream skips a candidate that loses availability after a real fake HTTP 503 retry', async () => {
    let grokChecks = 0;
    let codexFetches = 0;
    const originalFetch = globalThis.fetch;
    PROVIDERS.grok = { ...testFakeLlmProvider, name: 'grok', available: () => ++grokChecks <= 2 };
    PROVIDERS.glm = { ...testFakeLlmProvider, name: 'glm', defaultModel: 'glm-5.3', available: () => true };
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm,
      provider: 'openai-codex', model: 'gpt-6-sol', apiKey: 'fake-codex-test-only',
      fallbackChain: ['codex-rotate', 'grok', 'zai'] } }));
    globalThis.fetch = Object.assign(async () => {
      codexFetches++;
      return new Response('{"error":{"message":"server_is_overloaded"}}', { status: 503 });
    }, { preconnect: originalFetch.preconnect });
    try {
      const answer = await streamLLMWithTools([{ role: 'user', content: 'go' }],
        { onText: () => {}, dispatchTool: async () => ({ ok: true }) },
        { tools: [{ name: 'probe', description: 'probe', parameters: {} }], maxTurns: 1 });
      expect(answer).toBe('[test-fake-llm] OK');
      expect(codexFetches).toBeGreaterThanOrEqual(2);
      expect(logs.filter((l) => l.category === 'llm.retry' && l.data.status === 503).length).toBeGreaterThanOrEqual(2);
      expect(grokChecks).toBeGreaterThanOrEqual(3);
      expect(logs).toContainEqual(expect.objectContaining({ category: 'llm.router', event: 'overload-failover',
        data: expect.objectContaining({ fallbackProvider: 'glm' }) }));
    } finally { globalThis.fetch = originalFetch; }
  });

  it('falls back only after the first provider spends its retries, then gives the next provider a fresh budget', async () => {
    const first = scriptedProvider([[{ type: 'text', delta: 'x' }, 'throw']], 'grok');
    const second = scriptedProvider([
      [{ type: 'text', delta: 'y' }, 'throw'],
      [{ type: 'text', delta: 'fallback answer' }],
    ], 'anthropic');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = first.provider;
    PROVIDERS.anthropic = second.provider;
    PROVIDERS.gemini = scriptedProvider([[]], 'gemini').provider;
    PROVIDERS.local = scriptedProvider([[]], 'local').provider;

    const text = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      { onText: () => {}, dispatchTool: async () => ({ ok: true }) },
      { provider: undefined, tools: [{ name: 'probe', description: 'side-effecting probe', parameters: {} }], maxTurns: 2 },
    );

    expect(text).toBe('fallback answer');
    expect(first.calls()).toBe(6);
    expect(second.calls()).toBe(2);
    const retries = logs.filter((l) => l.category === 'llm.retry' && l.event === 'retry');
    expect(retries.filter((l) => l.data.provider === 'grok')).toHaveLength(5);
    expect(retries.filter((l) => l.data.provider === 'anthropic').map((l) => l.data.attempt)).toEqual([1]);
    const fallback = logs.find((l) => l.category === 'llm.router' && l.event === 'provider-fallback');
    expect(fallback?.data).toMatchObject({ blockedProvider: 'grok', fallbackProvider: 'anthropic' });
    expect(logs.some((l) => l.category === 'llm.router' && l.event === 'fallback-candidates')).toBe(true);
  });
});
