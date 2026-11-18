// CHAT-TOOLS-ENTRY-VIA-CORE-TURN — JUD-B TUI clause (OP #84368: the Next TUI is the demo and daily surface). A Next TUI
// tool turn runs through the single core turn like `chat --tools` (#38246): research route, grounding-first, citation
// guard. Outermost in-process entry = the repl child (`runRepl` → runOneTurn → runTurn → runCoreTurn → research ladder);
// only the model (plan + answer), the search (invokeAxes) and the clock are fakes. Zero real calls, and the host's real
// home (`~/.elanous` · `~/.codex`) is never read: `os.homedir` is spied (#38331 idiom) and every env is restored.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '../llm.js';
import type { ResearchRouteFields } from '../core-turn/research-route.js';
import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import type { ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';
import type { RunTurnOpts, RunTurnResult } from '../session/chat.js';
import type { UserConfig } from '../user-config/types.js';

const root = mkdtempSync(join(os.tmpdir(), 'elanous-tui-core-turn-'));
const fakeHome = join(root, 'home');
mkdirSync(fakeHome, { recursive: true });
// Bun caches HOME at startup: the fake home is the os.homedir spy (#38331 · src/cli/fleet-screen-cli.test.ts idiom).
const homeSpy = spyOn(os, 'homedir').mockReturnValue(fakeHome);
const SAVED_ENV_NAMES = ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT', 'CODEX_HOME', 'COORD_ID', 'ELANOUS_HARNESS_SPACE',
  'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_NEXT_TUI_BG_STATUS', 'ELANOUS_NEXT_TUI_STREAM', 'ELANOUS_NEXT_TUI_SELF_HEALTH'] as const;
const savedEnv = new Map<string, string | undefined>(SAVED_ENV_NAMES.map(name => [name, process.env[name]]));
process.env.ELANOUS_STATE_DIR = join(root, 'state');
process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
process.env.CODEX_HOME = join(root, 'codex-home');
for (const name of ['COORD_ID', 'ELANOUS_HARNESS_SPACE', 'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_NEXT_TUI_BG_STATUS',
  'ELANOUS_NEXT_TUI_STREAM', 'ELANOUS_NEXT_TUI_SELF_HEALTH'] as const) delete process.env[name];
// runTurn arms the goal loop on a cwd seat (`…/seats/<X>/…`); run from a neutral directory so the host checkout path
// cannot turn the demo question into a seat goal-loop turn.
const savedCwd = process.cwd();
process.chdir(root);
// streamLLM fences injected fakes off when a global fake switch is on (gate pods set one); this file spies the model itself.
const FAKE_SWITCHES = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE',
  'ELANOUS_TOOL_PROFILE'] as const;
const savedSwitches = new Map<string, string | undefined>();

const llm = await import('../llm.js');
const memory = await import('../memory.js');
const surfaceEvents = await import('../domains/surface-events.js');
const userIntent = await import('../user-intent/index.js');
const webSearch = await import('../web-search/index.js');
const researchTurn = await import('../auto-research/research-turn.js');
const runObserver = await import('../nexus/api/research-run-observer.js');
const webSearchTool = await import('../skills/tools/web-search.js');
const chat = await import('../session/chat.js');
const { debug } = await import('../debug/log.js');
const { routeResearchOutput } = await import('../research/output-router.js');
const { GROUNDING_UNAVAILABLE } = await import('../core-turn/grounding-first.js');
const { getUserConfig } = await import('../user-config.js');
const { createSession } = await import('../session/index.js');
const { runRepl } = await import('./index.js');
const { decideTuiCoreTurn } = await import('./tui-core-turn.js');

const realLadder = researchTurn.runResearchQuestionLadder;
const realRunTurn = chat.runTurn;
type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
type GeneratePreparation = NonNullable<ResearchQuestionLadderRunOptions['generatePreparation']>;

/** The R2 rehearsal question, verbatim (RES REHEARSAL-0328 R2). */
const DEMO_QUESTION = '11~12월 미국·한국 주식 전망은 어때?';
/** A local request that is not on the legacy fast path, not pre-filtered and not a TUI goal-loop (coding/debug) turn —
 *  the structured route alone decides. */
const LOCAL_REQUEST = '지난 대화에서 내가 말한 회의 요점을 세 줄로 요약해줘';
const GREETING = '안녕하세요';
const EVIDENCE_URL = 'https://www.example.org/market-outlook';
// 출처: #38265 (src/core-turn/first-answer-30s.test.ts · GROUNDING-FIRST-ANSWER-30S 칸 완료선) — 첫 답(출처 1개 이상)은 30초 안.
const FIRST_ANSWER_BUDGET_MS = 30_000;
// 출처: #38265 (research-policy.ts RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS 주석 · REHEARSAL-0328 U2b) — q0 근거 +2.5s. Fake search latency per axis batch.
const FAKE_SEARCH_MS = 2_500;
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public forecast' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local request' };
const validPlan = (route: ResearchRouteFields) => JSON.stringify({
  route,
  outputContract: {
    deliverable: 'A sourced answer', format: 'Short memo',
    sections: [{ id: 'facts', title: 'Facts', purpose: 'State the supported facts.' }],
    completionCriteria: ['Every claim is supported or marked uncertain.'],
  },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: index + 1, prompt: `Question ${index + 1}`, searchTerms: [`plan term ${index + 1}`], sectionId: 'facts',
  })),
});
const streamedPlan = (plan: string): GeneratePreparation => async (_prompt, _signal, onChunk) => { onChunk?.(plan); return plan; };
const envelope = (questionId: string): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search:test', source: EVIDENCE_URL, observedAt: '2026-11-17T00:00:00.000Z',
  content: `Evidence from ${EVIDENCE_URL}`, outcome: 'complete', truncated: true,
});

const provider: LLMProvider = {
  name: 'test-provider', defaultModel: 'test-model', available: () => true,
  async *chat() { yield 'plain'; }, async *streamChat() { yield { type: 'text', delta: 'plain' } as const; },
} as unknown as LLMProvider;

let searches: string[][] = [];
let routeEvents: Array<Record<string, unknown>> = [];
let routeRecords: Array<Record<string, unknown>> = [];
let firstCited: Array<Record<string, unknown>> = [];
let omitted: Array<Record<string, unknown>> = [];
let printed: Array<Record<string, unknown>> = [];
let webSearchToolCalls = 0;
let modelCalls = 0;
let clock = 0;
/** Per-test model override (the beforeEach spy delegates to it) — one spy per method, never a spy on a spy. */
let modelOverride: typeof llm.streamLLMWithTools | undefined;
const spies: Array<{ mockRestore(): void }> = [];

function world(opts: { searchConfigured: boolean; search: 'evidence' | 'down'; plan: GeneratePreparation }): void {
  spies.push(
    spyOn(webSearch, 'getAvailableWebSearchProviders').mockReturnValue(
      (opts.searchConfigured ? [{ id: 'fake-search', available: () => true }] : []) as unknown as ReturnType<typeof webSearch.getAvailableWebSearchProviders>),
    spyOn(webSearch, 'webSearchProvidersPendingAsyncReadiness').mockReturnValue([]),
    spyOn(researchTurn, 'runResearchQuestionLadder').mockImplementation(async (request, options) => {
      const invokeAxes: InvokeAxes = async (axes) => {
        searches.push(axes.flatMap(axis => axis.searchTerms));
        clock += FAKE_SEARCH_MS;
        // Search down = the bridge's shape when every provider fails: no evidence for any axis.
        return { plan: [], axes: axes.map(axis => ({ questionId: axis.id, evidence: opts.search === 'down' ? [] : [envelope(axis.id)] })) };
      };
      return realLadder(request, {
        ...options, generatePreparation: opts.plan, invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
        routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
      });
    }),
  );
}

beforeEach(() => {
  for (const name of FAKE_SWITCHES) { savedSwitches.set(name, process.env[name]); delete process.env[name]; }
  searches = []; routeEvents = []; routeRecords = []; firstCited = []; omitted = []; printed = [];
  webSearchToolCalls = 0; modelCalls = 0; clock = 1_800_000_000_000; modelOverride = undefined;
  spies.push(
    // Fake clock: fakes jump it (search · model), and every read ticks 1ms so no wait loop can stall on a frozen clock.
    spyOn(Date, 'now').mockImplementation(() => (clock += 1)),
    spyOn(memory, 'buildMemoryInjection').mockReturnValue({ block: '', tokens: 0, injectedIds: [] }),
    spyOn(memory, 'buildMemoryInjectionLLM').mockResolvedValue({ block: '', tokens: 0, injectedIds: [] }),
    spyOn(surfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
    spyOn(surfaceEvents, 'recallEvents').mockReturnValue([]),
    spyOn(userIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
    spyOn(llm, 'getProviderForConfig').mockImplementation(() => provider),
    spyOn(llm, 'getProviderForConfigAsync').mockImplementation(async () => provider),
    spyOn(runObserver, 'registerResearchRun').mockImplementation(() => ({ event() {}, finish() {} })),
    // The fake model answers from its INPUT: only a call that received the search evidence cites the evidence URL.
    spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers, llmOpts) => {
      if (modelOverride) return modelOverride(messages, handlers, llmOpts);
      modelCalls += 1;
      clock += 1_000;
      llmOpts?.onFinishReason?.('stop');
      const grounded = messages.some(message => typeof message.content === 'string' && message.content.includes(`Evidence from ${EVIDENCE_URL}`));
      const text = grounded ? `근거 기반 전망 (${EVIDENCE_URL})` : 'bare model reply: 어느 해 11~12월인가요?';
      handlers.onText(text, text);
      handlers.onTurnComplete?.([{ role: 'assistant', content: text }]);
      return text;
    }),
    spyOn(webSearchTool, 'dispatchWebSearch').mockImplementation(async () => {
      webSearchToolCalls += 1;
      return { query: 'q', providerName: 'fake-search', hits: [], numHits: 0 } as unknown as Awaited<ReturnType<typeof webSearchTool.dispatchWebSearch>>;
    }),
    // runRepl prints one JSON line per scripted turn (`console.log(JSON.stringify(out))`).
    spyOn(console, 'log').mockImplementation(((line: unknown) => {
      if (typeof line !== 'string') return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if ('turnId' in parsed) printed.push(parsed);
      } catch { /* not a turn line */ }
    }) as typeof console.log),
    spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      const row = (data ?? {}) as Record<string, unknown>;
      if (category === 'research' && event === 'route') routeEvents.push(row);
      if (category === 'research.turn' && event === 'first-cited-text') firstCited.push(row);
      if (category === 'chat.tools' && event === 'core-turn-route') routeRecords.push(row);
      if (category === 'chat.tools' && event === 'web-search-omitted') omitted.push(row);
    }) as typeof debug.log),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  for (const [name, value] of savedSwitches) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.ELANOUS_HARNESS_SPACE;
});

afterAll(() => {
  process.chdir(savedCwd);
  homeSpy.mockRestore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function testConfig(overrides: { goalLoop?: boolean } = {}): UserConfig {
  const base = getUserConfig();
  return {
    ...base,
    llm: { ...base.llm, goalLoop: { ...(base.llm.goalLoop ?? {}), enabled: overrides.goalLoop === true } },
    chat: { ...base.chat, toolDeny: [] },
  } as UserConfig;
}

let scenarioSeq = 0;
/** One Next TUI repl-child turn through the outermost in-process entry (scripted scenario → runOneTurn). */
async function replTurn(prompt: string, opts: { goalLoop?: boolean; enableTools?: boolean; nextTui?: boolean } = {}): Promise<Record<string, unknown>> {
  const scenarioPath = join(root, `tc-tac-scenario-${++scenarioSeq}.json`);
  writeFileSync(scenarioPath, JSON.stringify({ turns: [{ id: 't1', prompt }] }));
  const code = await runRepl({
    cfg: testConfig(opts), initialSessionId: undefined, forceNew: true, enableTools: opts.enableTools ?? true,
    scenarioPath, scriptedFromStdin: false, jsonOutput: true, exitAfterScenario: true,
    // The Next TUI child sets the structured flag (fast-repl-child.ts · `repl --next-tui`); `false` = the plain REPL.
    ...(opts.nextTui === false ? {} : { nextTui: true }),
  });
  expect(code).toBe(0);
  expect(printed).toHaveLength(1);
  return printed[0]!;
}

describe('Next TUI (repl child) tool turns run through the core turn', () => {
  test('the R2 demo question enters research, searches, cites the evidence URL, first cited answer within 30s (fake clock)', async () => {
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(FACT)) });
    const out = await replTurn(DEMO_QUESTION);
    expect(searches).not.toEqual([]);
    expect(routeEvents).toContainEqual(expect.objectContaining({ route: 'entered', by: 'structured' }));
    expect(String(out.reply)).toContain(EVIDENCE_URL);
    expect(String(out.reply)).not.toContain('bare model reply');
    // The whole repl turn (fake clock: searches + model calls) ends inside the first-answer budget, so its first
    // cited text does too; the core's own first-cited-text record agrees when it is emitted.
    // 출처: #38265 — FIRST_ANSWER_BUDGET_MS (GROUNDING-FIRST-ANSWER-30S 완료선).
    expect(out.durationMs as number).toBeLessThanOrEqual(FIRST_ANSWER_BUDGET_MS);
    // 출처: #38265 — FIRST_ANSWER_BUDGET_MS (GROUNDING-FIRST-ANSWER-30S 완료선).
    for (const row of firstCited) expect(row.elapsedMs as number).toBeLessThanOrEqual(FIRST_ANSWER_BUDGET_MS);
    // Plan-latency observation works for the TUI: one route record, the plan was paid and timed.
    expect(routeRecords).toEqual([expect.objectContaining({
      surface: 'tui', coreTurn: true, webSearch: true, planCalled: true, planLatencyMs: expect.any(Number),
    })]);
  });

  test('search down: GROUNDING_UNAVAILABLE, never a bare model reply', async () => {
    world({ searchConfigured: true, search: 'down', plan: streamedPlan(validPlan(FACT)) });
    const out = await replTurn(DEMO_QUESTION);
    expect(searches).not.toEqual([]);
    expect(out.reply).toBe(GROUNDING_UNAVAILABLE);
    expect(modelCalls).toBe(0);
  });

  test('localOnly route: 0 external search calls and an ordinary answer', async () => {
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(LOCAL)) });
    const out = await replTurn(LOCAL_REQUEST);
    expect(searches).toEqual([]);
    expect(webSearchToolCalls).toBe(0);
    expect(routeEvents).toContainEqual(expect.objectContaining({ route: 'skipped', by: 'structured', reason: 'local-only' }));
    expect(out.reply).not.toBe(GROUNDING_UNAVAILABLE);
  });

  test('a greeting does not enter research: 0 search calls', async () => {
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(LOCAL)) });
    await replTurn(GREETING);
    expect(searches).toEqual([]);
    expect(webSearchToolCalls).toBe(0);
    expect(routeEvents).not.toContainEqual(expect.objectContaining({ route: 'entered' }));
  });

  test('duplicate route keys (entered first, localOnly last) confirm nothing: 0 external search calls (#38166)', async () => {
    const plan = `${validPlan(FACT).slice(0, -1)},"route":${JSON.stringify(LOCAL)}}`;
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(plan) });
    await replTurn(LOCAL_REQUEST);
    expect(searches).toEqual([]);
    expect(webSearchToolCalls).toBe(0);
  });
});

describe('Next TUI exclusions keep the old path (no coreTurn flag, no added WebSearch) — skip branches are recorded', () => {
  async function capturedTurn(prompt: string, opts: { goalLoop?: boolean; enableTools?: boolean; searchConfigured?: boolean; nextTui?: boolean } = {}): Promise<RunTurnOpts> {
    spies.push(
      spyOn(webSearch, 'getAvailableWebSearchProviders').mockReturnValue(
        (opts.searchConfigured === false ? [] : [{ id: 'fake-search', available: () => true }]) as unknown as ReturnType<typeof webSearch.getAvailableWebSearchProviders>),
      spyOn(webSearch, 'webSearchProvidersPendingAsyncReadiness').mockReturnValue([]),
    );
    let captured: RunTurnOpts | undefined;
    spies.push(spyOn(chat, 'runTurn').mockImplementation(async (turn): Promise<RunTurnResult> => {
      captured = turn;
      turn.onDelta?.('old path reply');
      return { text: 'old path reply', provider: 'test', model: 'test',
        meta: { id: turn.sessionId } as unknown as RunTurnResult['meta'], usedTokens: 0, droppedMessages: 0, memoryIds: [] };
    }));
    await replTurn(prompt, opts);
    if (!captured) throw new Error('runTurn was not called');
    return captured;
  }
  const toolNames = (turn: RunTurnOpts) => (turn.tools ?? []).map(tool => tool.name);

  test('control: a plain Next TUI tool turn sets coreTurn and adds WebSearch', async () => {
    const turn = await capturedTurn(DEMO_QUESTION);
    expect(turn.coreTurn).toBe(true);
    expect(turn.utteranceSurface).toBe('tui');
    expect(toolNames(turn)).toContain('WebSearch');
    expect(routeRecords).toEqual([expect.objectContaining({ surface: 'tui', coreTurn: true, webSearch: true, planCalled: false })]);
  });

  test('no search provider configured: still the core turn, WebSearch omitted and the omission logged', async () => {
    const turn = await capturedTurn(DEMO_QUESTION, { searchConfigured: false });
    expect(turn.coreTurn).toBe(true);
    expect(toolNames(turn)).not.toContain('WebSearch');
    expect(omitted).toEqual([{ surface: 'tui', reason: 'no-search-provider' }]);
    expect(routeRecords).toEqual([expect.objectContaining({ coreTurn: true, webSearch: false })]);
  });

  test('plain `elanous repl` (runRepl without the Next TUI flag): old path — no coreTurn, unchanged tool pool, no new event', async () => {
    const nextTuiTurn = await capturedTurn(DEMO_QUESTION);
    expect(nextTuiTurn.coreTurn).toBe(true);
    // capturedTurn pushed three spies (search registry ×2 · runTurn): restore them before the second capture.
    for (const spy of spies.splice(spies.length - 3).reverse()) spy.mockRestore();
    routeRecords = []; omitted = []; printed = [];
    const plain = await capturedTurn(DEMO_QUESTION, { nextTui: false });
    expect(plain.coreTurn).toBeUndefined();
    expect(plain.onResearchPlanSettled).toBeUndefined();
    expect(plain.utteranceSurface).toBe('tui');
    // The plain pool is the Next TUI pool without the added WebSearch — nothing added, nothing dropped.
    expect(toolNames(plain)).toEqual(toolNames(nextTuiTurn).filter(name => name !== 'WebSearch'));
    expect(toolNames(plain)).not.toContain('WebSearch');
    expect(routeRecords).toEqual([]);
    expect(omitted).toEqual([]);
  });

  test('harness child (ELANOUS_HARNESS_SPACE): old direct path', async () => {
    process.env.ELANOUS_HARNESS_SPACE = 'dev-harness';
    const turn = await capturedTurn(DEMO_QUESTION);
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).not.toContain('WebSearch');
    expect(routeRecords).toEqual([expect.objectContaining({ coreTurn: false, skipReason: 'harness-child', webSearch: false })]);
  });

  test('goal-loop turn (coding request): the goal loop path, not the coreTurn flag', async () => {
    const turn = await capturedTurn('이 버그 고쳐서 커밋해줘');
    expect(turn.goalLoop).toBe(true);
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).not.toContain('WebSearch');
    expect(routeRecords).toEqual([expect.objectContaining({ coreTurn: false, skipReason: 'goal-loop' })]);
  });

  test('goal loop armed by config (llm.goalLoop.enabled): not the coreTurn flag', async () => {
    const turn = await capturedTurn(DEMO_QUESTION, { goalLoop: true });
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).not.toContain('WebSearch');
    expect(routeRecords).toEqual([expect.objectContaining({ coreTurn: false, skipReason: 'goal-loop' })]);
  });

  test('--no-tools: no tools, no coreTurn flag', async () => {
    const turn = await capturedTurn(DEMO_QUESTION, { enableTools: false });
    expect(turn.coreTurn).toBeUndefined();
    expect(turn.tools).toBeUndefined();
    expect(routeRecords).toEqual([expect.objectContaining({ coreTurn: false, skipReason: 'no-tools' })]);
  });

  test('decideTuiCoreTurn: exclusions in order, the rest is the core turn', () => {
    expect(decideTuiCoreTurn({ hasTools: false, harnessChild: true, goalLoop: true })).toEqual({ coreTurn: false, reason: 'no-tools' });
    expect(decideTuiCoreTurn({ hasTools: true, harnessChild: true, goalLoop: true })).toEqual({ coreTurn: false, reason: 'harness-child' });
    expect(decideTuiCoreTurn({ hasTools: true, harnessChild: false, goalLoop: true })).toEqual({ coreTurn: false, reason: 'goal-loop' });
    expect(decideTuiCoreTurn({ hasTools: true, harnessChild: false, goalLoop: false })).toEqual({ coreTurn: true });
  });
});

describe('field parity: what the direct loop returned to the TUI survives the move to the core turn', () => {
  test('status lines, stream idle override, session provider pin and finish reason reach the TUI on a coreTurn turn', async () => {
    world({ searchConfigured: false, search: 'evidence', plan: streamedPlan(validPlan(LOCAL)) });
    let seenOpts: Record<string, unknown> | undefined;
    modelOverride = async (_messages, handlers, llmOpts) => {
      seenOpts = llmOpts as unknown as Record<string, unknown>;
      handlers.onStatus?.('스트림 무응답 · 재시도 1/1');
      llmOpts?.onFinishReason?.('length');
      handlers.onText('partial answer', 'partial answer');
      return 'partial answer';
    };
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'cli' });
    const statusLines: string[] = [];
    const finishSeen: string[] = [];
    const result = await realRunTurn({
      userConfig: testConfig(), sessionId: session.id, userText: LOCAL_REQUEST, utteranceSurface: 'tui', coreTurn: true,
      systemPrompt: 'TUI prompt', skipMemoryInjection: true,
      tools: [{ name: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } }],
      dispatchTool: async () => 'read result',
      llmOpts: { streamIdleTimeoutMs: 1_000, onFinishReason: (reason) => { finishSeen.push(reason); } },
      onStatusLine: (line) => { statusLines.push(line); },
    });
    expect(statusLines).toContain('스트림 무응답 · 재시도 1/1');
    expect(seenOpts?.streamIdleTimeoutMs).toBe(1_000);
    expect(seenOpts?.initialProvider).toBe(provider);
    expect(result.finishReason).toBe('length');
    expect(finishSeen).toContain('length');
  });
});
