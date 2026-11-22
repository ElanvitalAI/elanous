// CHAT-TOOLS-ENTRY-VIA-CORE-TURN — JUD-B ACP clause. ACP (daemon ACP and the in-process classic TUI dashboard session)
// already runs every prompt through runCoreTurn; this pins that its research decision is the core's structured route on
// a web-tool pool — no `isResearchAgentIntent` sentence regex in the bridge (R-SIG). Outermost entry = the ACP bridge
// (`bridgeCoreTurnToAcp` → real runCoreTurn → research ladder); only the model (plan + answer), the search (invokeAxes)
// and the clock are fakes. Zero real calls; the host's real home is never read (`os.homedir` spy, #38331 idiom).
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { LLMMessage } from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import type { ResearchRouteFields } from '../core-turn/research-route.js';
import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import type { ResearchQuestionLadderRunOptions } from '../auto-research/research-turn.js';
import type { CoreTurnContext } from '../core-turn/types.js';
import type { AcpTurnContext } from './server.js';

const root = mkdtempSync(join(os.tmpdir(), 'elanous-acp-core-route-'));
const fakeHome = join(root, 'home');
mkdirSync(fakeHome, { recursive: true });
// Bun caches HOME at startup: the fake home is the os.homedir spy (#38331 · src/cli/fleet-screen-cli.test.ts idiom).
const homeSpy = spyOn(os, 'homedir').mockReturnValue(fakeHome);
const SAVED_ENV_NAMES = ['ELANOUS_STATE_DIR', 'ELANOUS_SESSION_ROOT', 'CODEX_HOME', 'ELANOUS_HARNESS_ROLE'] as const;
const savedEnv = new Map<string, string | undefined>(SAVED_ENV_NAMES.map(name => [name, process.env[name]]));
process.env.ELANOUS_STATE_DIR = join(root, 'state');
process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
process.env.CODEX_HOME = join(root, 'codex-home');
const FAKE_SWITCHES = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE',
  'ELANOUS_HARNESS_SPACE', 'ELANOUS_HARNESS_SPACE_ID', 'ELANOUS_TOOL_PROFILE'] as const;
const savedSwitches = new Map<string, string | undefined>();

const llm = await import('../llm.js');
const config = await import('../user-config.js');
const researchTurn = await import('../auto-research/research-turn.js');
const runObserver = await import('../nexus/api/research-run-observer.js');
const core = await import('../core-turn/run-core-turn.js');
const goalLoop = await import('../core-turn/run-goal-loop.js');
const { RESEARCH_TURN_MAX_TOOL_TURNS } = await import('../core-turn/research-policy.js');
const { debug } = await import('../debug/log.js');
const { HARNESS_ROLE_ENV } = await import('../harness/harness-space.js');
const { routeResearchOutput } = await import('../research/output-router.js');
const { bridgeCoreTurnToAcp, extractLastAssistantText } = await import('./core-turn-bridge.js');

const realLadder = researchTurn.runResearchQuestionLadder;
const realCoreTurn = core.runCoreTurn;
type InvokeAxes = NonNullable<ResearchQuestionLadderRunOptions['invokeAxes']>;
type GeneratePreparation = NonNullable<ResearchQuestionLadderRunOptions['generatePreparation']>;

/** The R2 rehearsal question, verbatim (RES REHEARSAL-0328 R2). */
const DEMO_QUESTION = '11~12월 미국·한국 주식 전망은 어때?';
/** Local, not on the legacy fast path, not pre-filtered, not a TUI goal-loop turn — the structured route decides. */
const LOCAL_REQUEST = '지난 대화에서 내가 말한 회의 요점을 세 줄로 요약해줘';
const GREETING = '안녕하세요';
/** A sentence the legacy `isResearchAgentIntent` regex calls research (src/acp/core-turn-bridge.test.ts fixture). */
const LEGACY_RESEARCH_TEXT = '현재 채권 금리가 왜 올라가나요?';
const EVIDENCE_URL = 'https://www.example.org/market-outlook';
// 출처: #38265 (src/core-turn/first-answer-30s.test.ts · GROUNDING-FIRST-ANSWER-30S 칸 완료선) — 첫 답(출처 1개 이상)은 30초 안.
const FIRST_ANSWER_BUDGET_MS = 30_000;
// 출처: #38265 (research-policy.ts RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS 주석 · REHEARSAL-0328 U2b) — q0 근거 +2.5s. Fake search latency per axis batch.
const FAKE_SEARCH_MS = 2_500;
const FACT: ResearchRouteFields = { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'dated public forecast' };
const LOCAL: ResearchRouteFields = { needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'local request' };
const WEB_SEARCH: LLMToolSpec = { name: 'WebSearch', description: 'Search the web', parameters: { type: 'object', properties: {} } };
const READ: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
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
/** The plan answers per research request (the ladder's `request`): a fake model that reads its own question. */
const streamedPlan = (plan: string): GeneratePreparation => async (_prompt, _signal, onChunk) => { onChunk?.(plan); return plan; };
const envelope = (questionId: string): ResearchEvidenceEnvelope => ({
  questionId, sourceKind: 'web-search:test', source: EVIDENCE_URL, observedAt: '2026-11-17T00:00:00.000Z',
  content: `Evidence from ${EVIDENCE_URL}`, outcome: 'complete', truncated: true,
});

let searches: Array<{ request: string; terms: string[] }> = [];
let routeEvents: Array<Record<string, unknown>> = [];
let firstCited: Array<Record<string, unknown>> = [];
let modelCalls = 0;
let coreCalls: CoreTurnContext[] = [];
let clock = 0;
const spies: Array<{ mockRestore(): void }> = [];

function world(opts: { search: 'evidence' | 'down'; planFor: (request: string) => string }): void {
  spies.push(spyOn(researchTurn, 'runResearchQuestionLadder').mockImplementation(async (request, options) => {
    const invokeAxes: InvokeAxes = async (axes) => {
      searches.push({ request, terms: axes.flatMap(axis => axis.searchTerms) });
      clock += FAKE_SEARCH_MS;
      return { plan: [], axes: axes.map(axis => ({ questionId: axis.id, evidence: opts.search === 'down' ? [] : [envelope(axis.id)] })) };
    };
    return realLadder(request, {
      ...options, generatePreparation: streamedPlan(opts.planFor(request)), invokeAxes, enableResearchFanout: false, allowOutputSkill: false,
      routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
    });
  }));
}

beforeEach(() => {
  for (const name of FAKE_SWITCHES) { savedSwitches.set(name, process.env[name]); delete process.env[name]; }
  delete process.env[HARNESS_ROLE_ENV];
  searches = []; routeEvents = []; firstCited = []; modelCalls = 0; coreCalls = []; clock = 1_800_000_000_000;
  const base = config.getUserConfig();
  spies.push(
    // Fake clock: fakes jump it (search · model), and every read ticks 1ms so no wait loop can stall on a frozen clock.
    spyOn(Date, 'now').mockImplementation(() => (clock += 1)),
    spyOn(config, 'getUserConfig').mockImplementation(() => ({
      ...base,
      chat: { ...base.chat, autoCompact: { ...base.chat.autoCompact, enabled: false } },
    })),
    spyOn(runObserver, 'registerResearchRun').mockImplementation(() => ({ event() {}, finish() {} })),
    spyOn(core, 'runCoreTurn').mockImplementation(async (ctx, options) => { coreCalls.push(ctx); return realCoreTurn(ctx, options); }),
    // The fake model answers from its INPUT: only a call that received the search evidence cites the evidence URL.
    spyOn(llm, 'streamLLMWithTools').mockImplementation(async (messages, handlers, llmOpts) => {
      modelCalls += 1;
      clock += 1_000;
      llmOpts?.onFinishReason?.('stop');
      const grounded = messages.some(message => typeof message.content === 'string' && message.content.includes(`Evidence from ${EVIDENCE_URL}`));
      const text = grounded ? `근거 기반 전망 (${EVIDENCE_URL})` : 'bare model reply: 어느 해 11~12월인가요?';
      handlers.onText(text, text);
      handlers.onTurnComplete?.([{ role: 'assistant', content: text }]);
      return text;
    }),
    spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'research' && event === 'route') routeEvents.push((data ?? {}) as Record<string, unknown>);
      if (category === 'research.turn' && event === 'first-cited-text') firstCited.push((data ?? {}) as Record<string, unknown>);
    }) as typeof debug.log),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  for (const [name, value] of savedSwitches) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(() => {
  homeSpy.mockRestore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** One ACP prompt through the bridge: `tuiRouting` = the in-process classic TUI dashboard session, else daemon ACP. */
async function acpTurn(userText: string, opts: { tuiRouting: boolean; sessionId?: string }) {
  let visible = '';
  const persisted: string[] = [];
  const dispatched: string[] = [];
  const runTurn = bridgeCoreTurnToAcp({
    ...(opts.tuiRouting ? { tuiRouting: true, resolveSeat: () => null } : {}),
    getMessages: (): LLMMessage[] => [{ role: 'system', content: 'base' }, { role: 'user', content: userText }],
    getTools: () => [READ, WEB_SEARCH],
    dispatchTool: async (name) => { dispatched.push(name); return { hits: [] }; },
    onTurnComplete: ({ newMessages }) => { persisted.push(extractLastAssistantText(newMessages) ?? ''); },
  });
  await runTurn({
    sessionId: opts.sessionId ?? `acp-core-route-${opts.tuiRouting ? 'tui' : 'daemon'}`, cwd: root, userText,
    promptBlocks: [{ type: 'text', text: userText }], isAborted: () => false,
    push: async (delta: string) => { visible += delta; },
    pushWithMeta: async (text: string, meta?: { elanous?: { textOperation?: string } }) => {
      if (meta?.elanous?.textOperation === 'replace') visible = text;
    },
    pushSessionUpdate: async () => {}, pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext);
  return { visible, persisted, dispatched, answer: [visible, ...persisted].join('\n') };
}

const SURFACES = [{ name: 'daemon ACP', tuiRouting: false }, { name: 'classic TUI (in-process ACP)', tuiRouting: true }] as const;

describe('ACP prompts take the core turn and its structured research route', () => {
  for (const surface of SURFACES) {
    test(`${surface.name}: the R2 demo question enters research, searches, cites the URL, first cited answer within 30s (fake clock)`, async () => {
      world({ search: 'evidence', planFor: () => validPlan(FACT) });
      const startedAt = clock;
      const out = await acpTurn(DEMO_QUESTION, surface);
      // The whole ACP turn (fake clock: searches + model calls) ends inside the first-answer budget, so its first cited
      // text does too; the core's own first-cited-text record agrees when it is emitted.
      // 출처: #38265 — FIRST_ANSWER_BUDGET_MS (GROUNDING-FIRST-ANSWER-30S 완료선).
      expect(clock - startedAt).toBeLessThanOrEqual(FIRST_ANSWER_BUDGET_MS);
      expect(coreCalls).toHaveLength(1);
      expect(searches).not.toEqual([]);
      expect(routeEvents).toContainEqual(expect.objectContaining({ route: 'entered', by: 'structured' }));
      expect(out.answer).toContain(EVIDENCE_URL);
      expect(out.visible).not.toContain('bare model reply');
      // 출처: #38265 — FIRST_ANSWER_BUDGET_MS (GROUNDING-FIRST-ANSWER-30S 완료선).
      for (const row of firstCited) expect(row.elapsedMs as number).toBeLessThanOrEqual(FIRST_ANSWER_BUDGET_MS);
    });

    test(`${surface.name}: search down — no bare model reply, no model call`, async () => {
      world({ search: 'down', planFor: () => validPlan(FACT) });
      const out = await acpTurn(DEMO_QUESTION, surface);
      expect(searches).not.toEqual([]);
      expect(out.answer).not.toContain('bare model reply');
      expect(modelCalls).toBe(0);
    });

    test(`${surface.name}: localOnly route — 0 external search calls`, async () => {
      world({ search: 'evidence', planFor: () => validPlan(LOCAL) });
      const out = await acpTurn(LOCAL_REQUEST, surface);
      expect(searches).toEqual([]);
      expect(out.dispatched).not.toContain('WebSearch');
      expect(routeEvents).toContainEqual(expect.objectContaining({ route: 'skipped', by: 'structured', reason: 'local-only' }));
    });

    test(`${surface.name}: a greeting does not enter research — 0 search calls`, async () => {
      world({ search: 'evidence', planFor: () => validPlan(LOCAL) });
      const out = await acpTurn(GREETING, surface);
      expect(searches).toEqual([]);
      expect(out.dispatched).not.toContain('WebSearch');
      expect(routeEvents).not.toContainEqual(expect.objectContaining({ route: 'entered' }));
    });

    test(`${surface.name}: duplicate route keys (entered first, localOnly last) confirm nothing — 0 search calls (#38166)`, async () => {
      world({ search: 'evidence', planFor: () => `${validPlan(FACT).slice(0, -1)},"route":${JSON.stringify(LOCAL)}}` });
      const out = await acpTurn(LOCAL_REQUEST, surface);
      expect(searches).toEqual([]);
      expect(out.dispatched).not.toContain('WebSearch');
    });
  }

  test('concurrent prompts keep their own route: the demo question searches, the local request in parallel does not', async () => {
    world({ search: 'evidence', planFor: (request) => validPlan(request.includes(DEMO_QUESTION) ? FACT : LOCAL) });
    const [demo, local] = await Promise.all([
      acpTurn(DEMO_QUESTION, { tuiRouting: false, sessionId: 'acp-concurrent-demo' }),
      acpTurn(LOCAL_REQUEST, { tuiRouting: false, sessionId: 'acp-concurrent-local' }),
    ]);
    expect(searches).not.toEqual([]);
    expect(searches.every(entry => entry.request.includes(DEMO_QUESTION))).toBe(true);
    expect(demo.answer).toContain(EVIDENCE_URL);
    expect(local.dispatched).not.toContain('WebSearch');
  });

  test('goal-loop turn (excluded path) keeps its pre-existing research budget verdict unchanged', async () => {
    // CHAT-GOAL-LOOP-DEFAULT-OFF — the only bridge goal-loop path is the harness executor (structural explicit goal).
    process.env[HARNESS_ROLE_ENV] = 'executor';
    const goalCalls: CoreTurnContext[] = [];
    spies.push(spyOn(goalLoop, 'runGoalLoop').mockImplementation(async (ctx) => {
      goalCalls.push(ctx);
      return { finalText: 'goal loop reply', iterations: 1, stopReason: 'goal_complete', goalComplete: true } as Awaited<ReturnType<typeof goalLoop.runGoalLoop>>;
    }));
    // A harness executor prompt is routed «코딩·구현» (goal loop); the regex budget stays there.
    await acpTurn(LEGACY_RESEARCH_TEXT, { tuiRouting: false });
    expect(goalCalls).toHaveLength(1);
    expect(goalCalls[0]!.maxToolTurns).toBe(RESEARCH_TURN_MAX_TOOL_TURNS);
    expect(coreCalls).toHaveLength(0);
  });

  test('the same text on a single core turn gets no bridge regex budget (the core route decides)', async () => {
    world({ search: 'evidence', planFor: () => validPlan(LOCAL) });
    await acpTurn(LEGACY_RESEARCH_TEXT, { tuiRouting: false });
    // The bridge's call is the first; a structured local-only verdict re-runs the core turn as an ordinary turn.
    expect(coreCalls).not.toEqual([]);
    expect(coreCalls.map(ctx => ctx.maxToolTurns)).toEqual(coreCalls.map(() => undefined));
  });
});
