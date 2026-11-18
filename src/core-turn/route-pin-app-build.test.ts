// APP-BUILD-NATURAL-ROUTE-DETERMINISTIC — a one-line app request always exposes and forces app_build first.
// The real tier split runs (manifest routes are deferred there); only the model is faked.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import * as llmModule from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { debug } from '../debug/log.js';
import { runCoreTurn } from './run-core-turn.js';
import { appBuildRouteMode, resolveTurnRoutePin, wantsAppBuildRoute } from '../plugins/core/turn-route-pin.js';

const TICKETING_LINE = '용평 리조트 콘서트 티케팅 앱 만들어줘';
// The 11-21 demo line as 대표 types it in the web chat (WEBCHAT-ONE-LINE-APP-BUILD probe, 11-17).
const DEMO_LINE = '콘서트 티케팅 시스템 만들어 배포해줘';
const signal = new AbortController().signal;
const plain = (name: string): LLMToolSpec => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const appBuild: LLMToolSpec = {
  name: 'app_build', description: 'Build a new application, test and publish the approved result.',
  parameters: { type: 'object', properties: { ask: { type: 'string' } }, required: ['ask'] },
  pluginId: 'elanous-app-build', handlerRef: 'graph:app-build', allowedGraphIds: ['app-build'],
  route: { triggers: ['앱 만들어'], examples: [], sideEffects: 'mutating', risk: 'high', cost: 'spends-llm', requiresConfirm: true },
};
const appDeploy: LLMToolSpec = {
  ...appBuild, name: 'app_deploy', pluginId: 'elanous-app-deploy', handlerRef: 'native:app_deploy', allowedGraphIds: [],
  route: { ...appBuild.route!, triggers: ['deploy app'] },
};

interface FakeTurn { called: string[]; firstTurnTools?: string[]; toolChoice?: unknown; pool: string[] }

let current: FakeTurn = { called: [], pool: [] };
let pinEvents: Record<string, unknown>[] = [];

/** Fake model: obeys a named tool choice on the first request, otherwise prefers Bash (the observed drift). */
async function runFake(line: string, tools: LLMToolSpec[]): Promise<FakeTurn> {
  current = { called: [], pool: [] };
  await runCoreTurn({
    sessionId: 'route-pin-app-build', messages: [{ role: 'user', content: line }], tools,
    dispatchTool: async (name) => { current.called.push(name); return { ok: true }; },
    signal, userText: line,
  }, { runResearch: async () => ({ ok: true, output: 'fake evidence' }) });
  return current;
}

beforeEach(() => {
  pinEvents = [];
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(() => ({
    id: 'default', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  }) as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'capability.resolve' && event === 'route-pin-forced') pinEvents.push(data as Record<string, unknown>);
  });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, opts) => {
    current.firstTurnTools = opts?.firstTurnTools?.map((tool) => tool.name);
    current.toolChoice = opts?.toolChoice;
    current.pool = opts?.tools?.map((tool) => tool.name) ?? [];
    const forced = opts?.toolChoice && typeof opts.toolChoice === 'object' ? opts.toolChoice.name : undefined;
    const name = forced ?? 'Bash';
    await handlers.dispatchTool(name, name === 'app_build' ? { ask: 'line' } : { command: 'bun --version' }, { callId: 'c1' });
    return 'done';
  });
});
afterEach(() => mock.restore());

describe('app-build natural route pin', () => {
  test('precondition: the real tier split defers the app_build manifest route', () => {
    const split = applyDeferredTools([], [plain('Bash'), appBuild], { enabled: true });
    expect(split.tools.map((tool) => tool.name)).not.toContain('app_build');
    expect(split.stats.deferredNames).toContain('app_build');
  });

  test('the ticketing line exposes and forces app_build first on every repeated run', async () => {
    const runs = ['13:57', '14:33', 'again', 'again', 'again'];
    for (const _run of runs) {
      const turn = await runFake(TICKETING_LINE, [plain('Bash'), plain('Read'), appDeploy, appBuild]);
      expect(turn.firstTurnTools).toEqual(['app_build']);
      expect(turn.toolChoice).toEqual({ name: 'app_build' });
      const [firstInPool] = turn.pool;
      expect(firstInPool).toBe('app_build');
      expect(turn.called).toEqual(['app_build']);
    }
    expect(pinEvents).toHaveLength(runs.length);
    for (const event of pinEvents) expect(event).toMatchObject({ tool: 'app_build', pluginId: 'elanous-app-build', reason: 'app-build-intent', wasDeferred: true });
  });

  test.each([
    '공연 티켓 예매 서비스 만들어줘',
    '티케팅 시스템 만들어줘 좌석 선택하고 결제까지',
    'Build a ticketing app for the ski resort concert',
  ])('equivalent app lines also pin app_build: %s', async (line) => {
    const turn = await runFake(line, [plain('Bash'), appBuild]);
    expect(turn.toolChoice).toEqual({ name: 'app_build' });
    expect(turn.called).toEqual(['app_build']);
  });

  test.each([
    'README 파일 읽어줘',
    '앱 만들지 말고 배포 방법만 알려줘',
    '앱은 만들지 말고 서비스 소개 글만 만들어줘',
    "don't build an app, just explain the deploy check",
    '기존 앱 산출물을 배포해줘',
  ])('non-app or opted-out line is not forced: %s', async (line) => {
    const turn = await runFake(line, [plain('Bash'), appBuild]);
    expect(turn.firstTurnTools).toBeUndefined();
    expect(turn.toolChoice).toBeUndefined();
    expect(turn.pool).not.toContain('app_build');
  });

  test.each([
    '결제 서비스에 단위 테스트 만들어줘',
    '시스템 프롬프트 만들어줘',
    'create a unit test for the logging service',
    'make sure the service is running',
    '웹사이트 설명 문서 만들어줘',
  ])('Claude r1 MF: code/ops work that only mentions a service/system is never forced: %s', async (line) => {
    expect(appBuildRouteMode(line)).not.toBe('force');
    const turn = await runFake(line, [plain('Bash'), appBuild]);
    expect(turn.firstTurnTools).toBeUndefined();
    expect(turn.toolChoice).toBeUndefined();
  });

  test.each([
    '용평 리조트 콘서트 티케팅 앱 만들어줘',
    '공연 티켓 예매 서비스 만들어줘',
    'build a booking web app for my ski school',
  ])('high-confidence product lines are forced: %s', (line) => {
    expect(appBuildRouteMode(line)).toBe('force');
  });

  test('WEBCHAT-ONE-LINE-APP-BUILD: with web tools in the pool (web chat, TUI) the one-line app request still forces app_build — research is not entered', async () => {
    const researchRuns: string[] = [];
    const routes: Record<string, unknown>[] = [];
    (debug.log as unknown as { mockImplementation: (fn: (c: string, e: string, d: unknown) => void) => void }).mockImplementation((category, event, data) => {
      if (category === 'capability.resolve' && event === 'route-pin-forced') pinEvents.push(data as Record<string, unknown>);
      if (category === 'research' && event === 'route') routes.push(data as Record<string, unknown>);
    });
    current = { called: [], pool: [] };
    await runCoreTurn({
      sessionId: 'route-pin-web', messages: [{ role: 'user', content: DEMO_LINE }],
      tools: [plain('WebSearch'), plain('WebFetch'), plain('Bash'), appDeploy, appBuild],
      dispatchTool: async (name) => { current.called.push(name); return { ok: true }; },
      signal, userText: DEMO_LINE,
    }, { runResearch: async () => { researchRuns.push('research'); return { ok: true, output: 'fake evidence' }; } });
    expect(current.toolChoice).toEqual({ name: 'app_build' });
    expect(current.called).toEqual(['app_build']);
    expect(researchRuns).toEqual([]);
    expect(routes).toContainEqual(expect.objectContaining({ route: 'skipped', by: 'prefilter', reason: 'route-pin-forced' }));
  });

  test.each([
    ['legacy route (no web tool)', [] as string[]],
    ['structured route (web tools)', ['WebSearch', 'WebFetch']],
  ])('#38215 REVIEW-2 ①: an app line that asks for research keeps its research step — exposed, not forced (%s)', async (_label, webTools) => {
    const line = '경쟁사 리서치해서 공연 예매 서비스 만들어줘';
    expect(appBuildRouteMode(line)).toBe('expose');
    const routes: Record<string, unknown>[] = [];
    (debug.log as unknown as { mockImplementation: (fn: (c: string, e: string, d: unknown) => void) => void }).mockImplementation((category, event, data) => {
      if (category === 'research' && event === 'route') routes.push(data as Record<string, unknown>);
    });
    current = { called: [], pool: [] };
    await runCoreTurn({
      sessionId: 'route-pin-explicit-research', messages: [{ role: 'user', content: line }],
      tools: [...webTools.map(plain), plain('Bash'), plain('Read'), appDeploy, appBuild],
      dispatchTool: async (name) => { current.called.push(name); return { ok: true }; },
      signal, userText: line,
    }, { runResearch: async () => ({ ok: true, output: 'fake evidence' }) });
    expect(current.toolChoice).not.toEqual({ name: 'app_build' });
    expect(routes.some((route) => route.reason === 'route-pin-forced')).toBe(false);
  });

  test('a research question with web tools still enters research (the pin only takes app lines)', async () => {
    const routes: Record<string, unknown>[] = [];
    (debug.log as unknown as { mockImplementation: (fn: (c: string, e: string, d: unknown) => void) => void }).mockImplementation((category, event, data) => {
      if (category === 'research' && event === 'route') routes.push(data as Record<string, unknown>);
    });
    current = { called: [], pool: [] };
    await runCoreTurn({
      sessionId: 'route-pin-web-research', messages: [{ role: 'user', content: '오늘 코스피 마감 지수 알려줘' }],
      tools: [plain('WebSearch'), plain('WebFetch'), plain('Bash'), appDeploy, appBuild],
      dispatchTool: async (name) => { current.called.push(name); return { ok: true }; },
      signal, userText: '오늘 코스피 마감 지수 알려줘',
    }, { runResearch: async () => ({ ok: true, output: 'fake evidence' }) });
    expect(current.toolChoice).not.toEqual({ name: 'app_build' });
    expect(routes.some((route) => route.reason === 'route-pin-forced')).toBe(false);
  });

  test('an ambiguous creation cue only exposes app_build in the pool without forcing it', async () => {
    const line = '결제 서비스에 단위 테스트 만들어줘';
    expect(appBuildRouteMode(line)).toBe('expose');
    const turn = await runFake(line, [plain('Bash'), appBuild]);
    expect(turn.pool).toContain('app_build');
    expect(turn.toolChoice).toBeUndefined();
  });

  test('app_build unavailable (no plugin) → no forcing and no error', async () => {
    const turn = await runFake(TICKETING_LINE, [plain('Bash'), plain('Read')]);
    expect(turn.firstTurnTools).toBeUndefined();
    expect(turn.toolChoice).toBeUndefined();
    expect(turn.called).toEqual(['Bash']);
  });

  test('a same-named tool from another plugin is not pinned', () => {
    expect(resolveTurnRoutePin(TICKETING_LINE, [{ ...appBuild, pluginId: 'other-plugin' }])).toBeUndefined();
    expect(resolveTurnRoutePin(TICKETING_LINE, [appBuild])?.tool.name).toBe('app_build');
    expect(wantsAppBuildRoute('앱은 만들지 않고 설명만 해줘')).toBe(false);
  });
});
