// CHAT-TOOLS-ENTRY-VIA-CORE-TURN (R2 0.3.28 rehearsal) — `chat --tools` / `elanous agent` tool turns run through the
// single core turn: research route, grounding-first, citation guard. Real runChatTurnCli → runTurn → runCoreTurn →
// research ladder; only the model (plan + answer) and the search (invokeAxes) are fakes. Zero real calls.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '../llm.js';
import type { ResearchRouteFields } from '../core-turn/research-route.js';
import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import type { ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';
import type { RunTurnOpts, RunTurnResult } from '../session/chat.js';

const root = mkdtempSync(join(tmpdir(), 'elanous-chat-tools-core-turn-'));
// Other test files share this Bun process: restore the store env in afterAll so their sessions do not land here.
const savedStoreEnv = { ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR, ELANOUS_SESSION_ROOT: process.env.ELANOUS_SESSION_ROOT };
process.env.ELANOUS_STATE_DIR = join(root, 'state');
process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
// streamLLM fences injected fakes off when a global fake switch is on (gate pods set one); this file spies the model itself.
const FAKE_SWITCHES = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE',
  'ELANOUS_HARNESS_SPACE', 'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_TOOL_PROFILE'] as const;
const savedSwitches = new Map<string, string | undefined>();

const llm = await import('../llm.js');
const memory = await import('../memory.js');
const surfaceEvents = await import('../domains/surface-events.js');
const userIntent = await import('../user-intent/index.js');
const webSearch = await import('../web-search/index.js');
const researchTurn = await import('../auto-research/research-turn.js');
const runObserver = await import('../nexus/api/research-run-observer.js');
const stdoutJson = await import('./stdout-json.js');
const webSearchTool = await import('../skills/tools/web-search.js');
const { debug } = await import('../debug/log.js');
const { routeResearchOutput } = await import('../research/output-router.js');
const { GROUNDING_UNAVAILABLE } = await import('../core-turn/grounding-first.js');
const { getUserConfig } = await import('../user-config.js');
const { runChatTurnCli } = await import('./agent-cli.js');

const realLadder = researchTurn.runResearchQuestionLadder;
type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
type GeneratePreparation = NonNullable<ResearchQuestionLadderRunOptions['generatePreparation']>;

/** The R2 rehearsal question, verbatim (RES REHEARSAL-0328 R2). */
const DEMO_QUESTION = '11~12월 미국·한국 주식 전망은 어때?';
/** A local request that is neither on the legacy fast path nor pre-filtered — the route alone decides. */
const LOCAL_REQUEST = "이 에러 로그 보고 버그 고쳐줘: TypeError: Cannot read properties of undefined (reading 'id')\n    at handler (index:12)";
const EVIDENCE_URL = 'https://www.example.org/market-outlook';
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public forecast' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local error log' };
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
let modelCalls = 0;
let routeEvents: Array<Record<string, unknown>> = [];
let costEvents: Array<Record<string, unknown>> = [];
let printed: string[] = [];
let webSearchToolCalls = 0;
/** The fake provider's finish reason for this turn (`stop` = a normal end; `length` = output cut at the token cap). */
let providerFinish = 'stop';
const spies: Array<{ mockRestore(): void }> = [];

function world(opts: { searchConfigured: boolean; search: 'evidence' | 'down'; plan: GeneratePreparation }): void {
  spies.push(
    spyOn(webSearch, 'getAvailableWebSearchProviders').mockReturnValue(
      (opts.searchConfigured ? [{ id: 'fake-search', available: () => true }] : []) as unknown as ReturnType<typeof webSearch.getAvailableWebSearchProviders>),
    spyOn(webSearch, 'webSearchProvidersPendingAsyncReadiness').mockReturnValue([]),
    spyOn(researchTurn, 'runResearchQuestionLadder').mockImplementation(async (request, options) => {
      const invokeAxes: InvokeAxes = async (axes) => {
        searches.push(axes.flatMap(axis => axis.searchTerms));
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
  searches = []; modelCalls = 0; routeEvents = []; costEvents = []; printed = []; webSearchToolCalls = 0; providerFinish = 'stop';
  spies.push(
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
      modelCalls += 1;
      llmOpts?.onFinishReason?.(providerFinish);
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
    spyOn(stdoutJson, 'writeStdoutJson').mockImplementation(async (text: string) => { printed.push(text); }),
    spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'research' && event === 'route') routeEvents.push((data ?? {}) as Record<string, unknown>);
      if (category === 'chat.tools' && event === 'core-turn-route') costEvents.push((data ?? {}) as Record<string, unknown>);
    }) as typeof debug.log),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const [name, value] of savedSwitches) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  process.exitCode = 0;
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedStoreEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function cliTurn(userText: string, surface?: 'agent'): Promise<{ reply: string; incomplete: boolean; finishReason: string | null; stopReason: string | null }> {
  const cfg = getUserConfig();
  cfg.chat.toolDeny = [];
  await runChatTurnCli({
    cfg, userText, explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true, enableTools: true,
    ...(surface ? { surface } : {}),
  });
  expect(printed).toHaveLength(1);
  return JSON.parse(printed[0]!) as { reply: string; incomplete: boolean; finishReason: string | null; stopReason: string | null };
}

describe('chat --tools / agent run through the core turn', () => {
  test('the R2 demo question enters research, searches, and answers citing the evidence URL (chat --tools and agent)', async () => {
    for (const surface of [undefined, 'agent'] as const) {
      searches = []; routeEvents = []; printed = [];
      world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(FACT)) });
      const out = await cliTurn(DEMO_QUESTION, surface);
      expect(searches).not.toEqual([]);
      expect(routeEvents).toContainEqual(expect.objectContaining({ route: 'entered', by: 'structured' }));
      expect(out.reply).toContain(EVIDENCE_URL);
      expect(out.reply).not.toContain('bare model reply');
      // Cost axis: this turn paid one question-plan call, and its latency is on the route event.
      expect(costEvents).toEqual([expect.objectContaining({ coreTurn: true, planCalled: true, planLatencyMs: expect.any(Number) })]);
      costEvents = [];
      for (const spy of spies.splice(spies.length - 3)) spy.mockRestore();
    }
  });

  test('search down: GROUNDING_UNAVAILABLE, never a bare model reply — provider configured or not', async () => {
    for (const searchConfigured of [true, false]) {
      searches = []; printed = []; modelCalls = 0;
      world({ searchConfigured, search: 'down', plan: streamedPlan(validPlan(FACT)) });
      const out = await cliTurn(DEMO_QUESTION);
      expect(searches).not.toEqual([]);
      expect(out.reply).toBe(GROUNDING_UNAVAILABLE);
      expect(modelCalls).toBe(0);
      for (const spy of spies.splice(spies.length - 3)) spy.mockRestore();
    }
  });

  test('localOnly route: 0 external search calls and an ordinary answer', async () => {
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(LOCAL)) });
    const out = await cliTurn(LOCAL_REQUEST);
    expect(searches).toEqual([]);
    expect(webSearchToolCalls).toBe(0);
    expect(routeEvents).toContainEqual(expect.objectContaining({ route: 'skipped', by: 'structured', reason: 'local-only' }));
    expect(out.reply).not.toBe(GROUNDING_UNAVAILABLE);
  });

  test('a provider length stop stays visible: finishReason length, incomplete, exit 1; a normal stop is complete, exit 0', async () => {
    // OP REVIEW-1 #38246: the core turn returned the provider finish reason as providerFinishReason and runTurn dropped it.
    for (const [finish, incomplete, exitCode] of [['length', true, 1], ['stop', false, 0]] as const) {
      printed = []; providerFinish = finish; process.exitCode = 0;
      world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(LOCAL)) });
      const out = await cliTurn(LOCAL_REQUEST);
      expect(JSON.parse(printed[0]!)).toHaveProperty('finishReason', finish);
      expect(out.finishReason).toBe(finish);
      expect(out.stopReason).toBe(finish);
      expect(out.incomplete).toBe(incomplete);
      expect(process.exitCode).toBe(exitCode);
      for (const spy of spies.splice(spies.length - 3)) spy.mockRestore();
    }
  });

  test('a research synthesis cut at the token cap stays visible: finishReason length, incomplete, exit 1', async () => {
    // The R2/demo path: the answer that reaches the user is the research synthesis, so ITS finish reason must surface.
    providerFinish = 'length'; process.exitCode = 0;
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(validPlan(FACT)) });
    const out = await cliTurn(DEMO_QUESTION);
    expect(out.reply).toContain(EVIDENCE_URL);
    expect(JSON.parse(printed[0]!)).toHaveProperty('finishReason', 'length');
    expect(out.incomplete).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test('duplicate route keys (entered first, localOnly last) confirm nothing: 0 external search calls', async () => {
    const plan = `${validPlan(FACT).slice(0, -1)},"route":${JSON.stringify(LOCAL)}}`;
    world({ searchConfigured: true, search: 'evidence', plan: streamedPlan(plan) });
    await cliTurn(LOCAL_REQUEST);
    // The ladder's privacy gate judges the CLOSED plan root: two `route` keys confirm nothing, so nothing leaves.
    expect(searches).toEqual([]);
    expect(webSearchToolCalls).toBe(0);
  });
});

describe('the four exclusions keep the old path (no coreTurn flag, no added WebSearch)', () => {
  async function capturedTurn(extra: Partial<Parameters<typeof runChatTurnCli>[0]>): Promise<RunTurnOpts> {
    spies.push(spyOn(webSearch, 'getAvailableWebSearchProviders').mockReturnValue(
      [{ id: 'fake-search', available: () => true }] as unknown as ReturnType<typeof webSearch.getAvailableWebSearchProviders>));
    let captured: RunTurnOpts | undefined;
    const cfg = getUserConfig();
    cfg.chat.toolDeny = [];
    await runChatTurnCli({
      cfg, userText: DEMO_QUESTION, explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true, enableTools: true,
      ...extra,
      runTurn: async (turn): Promise<RunTurnResult> => {
        captured = turn;
        turn.onDelta?.('old path reply');
        return { text: 'old path reply', provider: 'test', model: 'test',
          meta: { id: turn.sessionId } as unknown as RunTurnResult['meta'], usedTokens: 0, droppedMessages: 0, memoryIds: [] };
      },
    });
    if (!captured) throw new Error('runTurn was not called');
    return captured;
  }
  const toolNames = (turn: RunTurnOpts) => (turn.tools ?? []).map(tool => tool.name);

  test('control: a plain chat --tools turn sets coreTurn and adds WebSearch', async () => {
    const turn = await capturedTurn({});
    expect(turn.coreTurn).toBe(true);
    expect(toolNames(turn)).toContain('WebSearch');
  });

  test('harness child (ELANOUS_HARNESS_SPACE): old direct path', async () => {
    process.env.ELANOUS_HARNESS_SPACE = 'dev-harness';
    const turn = await capturedTurn({});
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).not.toContain('WebSearch');
  });

  test('--goal-loop: the goal loop path, not the coreTurn flag', async () => {
    const turn = await capturedTurn({ goalLoop: true });
    expect(turn.goalLoop).toBe(true);
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).not.toContain('WebSearch');
  });

  test('ask: the ask utterance surface, not the coreTurn flag', async () => {
    const turn = await capturedTurn({ surface: 'ask' });
    expect(turn.utteranceSurface).toBe('ask');
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).not.toContain('WebSearch');
  });

  test('allowedToolNames (purpose-built surface): only its allowlist, no coreTurn flag', async () => {
    const turn = await capturedTurn({ allowedToolNames: ['Read'] });
    expect(turn.coreTurn).toBeUndefined();
    expect(toolNames(turn)).toContain('Read');
    expect(toolNames(turn).filter(name => name !== 'Read')).toHaveLength(0);
  });
});
