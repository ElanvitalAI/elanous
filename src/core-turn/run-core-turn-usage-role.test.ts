/** OP #124624 (RED first): every core-turn stream call must carry a turn-kind usageRole so `llm.usage` rows keep `role`.
 *  Delivery path: run-core-turn.ts `streamOptions` → `streamLLMWithTools` opts.usageRole → llm.ts streamLLMWithTools
 *  usage event → `logAgentTurnUsage` → debug.log('llm.usage', 'llm-usage', { role }) (llm.ts:8541–8555, usage row at 9966).
 *  Defect at HEAD 9203a15581: streamOptions attaches `usageRole: 'research'` only when `researchTurn` (run-core-turn.ts:1170);
 *  a general (non-research) core turn sends NO usageRole, so its `llm.usage` / 'llm-usage' row is left with no `role` field.
 *  Harness copied from run-core-turn-synthesis-cap.test.ts (lightest existing runCoreTurn-driving test). */
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import * as debugModule from '../debug/log.js';
import * as llmModule from '../llm.js';
import type { LLMProvider } from '../llm.js';
import { resolveRequestMaxTokens } from '../llm/output-budget.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { runCoreTurn } from './run-core-turn.js';

const tool: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };

beforeEach(() => {
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: { activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
});
afterEach(() => mock.restore());

/** streamOptions always sets `researchTurn` (run-core-turn.ts:1172), so `'researchTurn' in opts` marks exactly the
 *  core-turn streamOptions-shaped calls and excludes unrelated internal streamLLMWithTools callers. */
type StreamOpts = { researchTurn?: boolean; usageRole?: string };
async function captureCoreStreamRoles(request: string, harness: Parameters<typeof runCoreTurn>[1]): Promise<string[]> {
  const roles: Array<string | undefined> = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, options) => {
    const opts = options as (StreamOpts & Record<string, unknown>) | undefined;
    if (opts && 'researchTurn' in opts) roles.push(opts.usageRole);
    return 'ok';
  });
  await runCoreTurn({
    sessionId: 'usage-role', messages: [{ role: 'user', content: request }], tools: [tool],
    dispatchTool: async () => null, signal: new AbortController().signal, userText: request,
  }, harness);
  return roles.map(role => role ?? '<missing>');
}

test('OP #124624 RED: a general (non-research) core turn stamps usageRole "main" on its stream options', async () => {
  // Fails at HEAD 9203a15581: streamOptions omits usageRole for non-research turns →
  // bun expect failure "expected '<missing>' to be 'main'" (usageRole is undefined today).
  const roles = await captureCoreStreamRoles('hello there', {});
  // 출처: #124624 — 캡처 최소 1회 보장(0이면 시험 자체가 무효, streamOptions 미도달)
  expect(roles.length).toBeGreaterThan(0);
  expect(roles.every(role => role === 'main')).toBe(true);
});

test('research core turns keep usageRole "research" (existing behavior preserved)', async () => {
  // Control for the same defect fix: the research branch (run-core-turn.ts:1170) must stay intact.
  const roles = await captureCoreStreamRoles('compare bond yield changes', {
    now: () => 1_000_000,
    runResearch: async () => ({ ok: true, output: 'Counterevidence: yields can fall.' }),
  });
  // 출처: #124624 — 캡처 최소 1회 보장(0이면 시험 자체가 무효, streamOptions 미도달)
  expect(roles.length).toBeGreaterThan(0);
  expect(roles.every(role => role === 'research')).toBe(true);
});

// ── A210 Terra 셀프리뷰 mustFix(정본 node-b ~/.elanous/review-results/MVPB-R3-39490-ecc09565818c.json) ──
// 통과 기준 원문: "외부 LLM 공급자만 스텁하고 실제 `runCoreTurn`을 실행해 생성된 `llm.usage` 행에서
// 일반 턴 `role: 'main'`과 연구 턴 `role: 'research'`를 확인한다."
// 위 두 시험은 내부 프로덕션 함수 streamLLMWithTools 를 대체하므로 행(rows)까지의 실경로를 증명하지
// 못한다 — 아래 두 시험이 그 몫을 한다. 실경로: runCoreTurn streamOptions(usageRole) → 실
// streamLLMWithTools(llm.ts:8720 주입 공급자 소유, 9507 streamChat 소비, 9966 logAgentTurnUsage) →
// debug 'llm-usage' 행(llm.ts:8553, role 은 opts.usageRole).
// llm.ts:8714-8720 — 게이트 포드의 강제 가짜 스위치(ELANOUS_TEST_FAKE_LLM=1 등)가 주입 공급자보다
// 우선하므로 이 파일에서만 들어올린다(src/llm-usage-attribution.test.ts 와 같은 해제).
const FORCED_FAKE_ENV_KEYS = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE'] as const;
let savedForcedFakeEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of FORCED_FAKE_ENV_KEYS) { savedForcedFakeEnv[key] = process.env[key]; delete process.env[key]; }
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedForcedFakeEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** 이 시험들의 유일한 스텁: 외부 LLM 공급자 경계(llm.ts LLMProvider). streamChat 이 usage 이벤트를
 *  한 번 내면 실 경로의 logAgentTurnUsage 가 그대로 행을 만든다. */
function usagePathProvider(): LLMProvider {
  return {
    name: 'usage-path-stub',
    defaultModel: 'usage-path-stub-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } };
      yield { type: 'text', delta: 'stub reply' };
    },
  };
}

/** 실 runCoreTurn 실행 후 이 스텁 공급자가 만든 스트림의 'llm-usage' 행만 모은다(runCoreTurn 내부의
 *  다른 공급자 곁가지 호출이 있어도 섞이지 않게 provider/model 로 거른다). */
async function captureUsageRows(request: string, harness: Partial<Parameters<typeof runCoreTurn>[1]>): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  // 출처: #39493 — r3b 게이트 RED: debug 는 debug/log.ts:950 `export const debug = new DebugLog()` 인스턴스다
  // (모듈 top-level `log` export 는 없음) — spyOn(debugModule, 'log') 는 9966 logAgentTurnUsage → 8553
  // debug.log 를 못 잡아 행이 0개였다. 인스턴스 메서드를 스파이해야 실 llm.usage 행이 잡힌다.
  const log = spyOn(debugModule.debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.usage' && event === 'llm-usage') rows.push({ ...((data ?? {}) as Record<string, unknown>) });
  });
  try {
    await runCoreTurn({
      sessionId: 'usage-role-path', messages: [{ role: 'user', content: request }], tools: [tool],
      dispatchTool: async () => null, signal: new AbortController().signal, userText: request,
      // 출처: #39493 r2 게이트 RED(FOCUSED_NEW_FAILURE) — initialProvider 는 CoreTurnContext(제1인자,
      // core-turn/types.ts:202) 필드다. 제2인자 RunCoreTurnOptions 에 두면 초과 속성으로 무시되고
      // llm.ts:8718 fakeDefault(test)가 가짜 공급자가 이 턴을 대신 소유해 이 스텁 streamChat 은
      // 소비되지 않는다(행 0 → 시험 무효). ctx 로 넣어야 1182 streamOptions 가 llm.ts:8720 으로 싣는다.
      initialProvider: usagePathProvider(),
    }, harness);
  } finally { log.mockRestore(); }
  return rows.filter(row => row.provider === 'usage-path-stub' || row.model === 'usage-path-stub-model');
}

test('A210 mustFix: a general core turn leaves role "main" on its real llm.usage rows (no streamLLMWithTools mock)', async () => {
  const rows = await captureUsageRows('hello there', {});
  // 출처: #39493 — A210 mustFix(MVPB-R3-39490 정본): 최소 1행 보장(0이면 실경로 미도달, 시험 무효)
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.role === 'main')).toBe(true);
});

test('A210 mustFix: a research core turn leaves role "research" on its real llm.usage rows (no streamLLMWithTools mock)', async () => {
  const rows = await captureUsageRows('compare bond yield changes', {
    now: () => 1_000_000,
    runResearch: async () => ({ ok: true, output: 'Counterevidence: yields can fall.' }),
  });
  // 출처: #39493 — A210 mustFix(MVPB-R3-39490 정본): 최소 1행 보장(0이면 실경로 미도달, 시험 무효)
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.role === 'research')).toBe(true);
});

// ── A210 Terra 셀프리뷰 r2 mustFix(정본 ~/.elanous/review-results/MVPB-R3-39493-eb85bfc006ce.json) ──
// 원문: «출력 예산 회귀 시험은 `chat.ts`의 `'main'`→`undefined` 변환 경로를 건너뛰고 해석기만 직접
// 호출하므로 해당 변환이 깨져도 통과한다; 통과 증거로 실제 chat 진입점에서 `usageRole: 'main'`을
// 전달하고 공급자 요청의 출력 토큰 예산이 기본값인 것을 관측하라.» 이 저장소엔 chat.ts 변환 진입점이
// 없다(정본 pathWarnings «경로 미확인: chat.ts») — 실제 변환 사슬은 run-core-turn.ts:1172 usageRole
// 스탬프 → llm.ts:5035 requestMaxTokens → output-budget.ts:6 resolveRequestMaxTokens('main' 과
// undefined 는 같은 기본 버킷) → llm.ts:4911 providerOpts.maxTokens. 아래 시험은 그 실경로
// (runCoreTurn 일반 턴 → 실 streamLLMWithTools → 스텁 공급자가 받은 providerOpts)를 관측해 'main'
// 이 기본(역할 미지정) 출력 토큰 예산을 보존함을 고정한다. 해석기 호출은 기대값 오라클로만 쓴다.
test('A210 mustFix r2: a general core turn keeps the default provider output budget through the real stream entry', async () => {
  const model = 'usage-path-stub-model';
  const seen: Array<{ usageRole: string | null; maxTokens: number | null }> = [];
  const provider = {
    ...usagePathProvider(),
    async *streamChat(_messages: unknown, opts: { usageRole?: string; maxTokens?: number } = {}) {
      seen.push({ usageRole: opts.usageRole ?? null, maxTokens: opts.maxTokens ?? null });
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } };
      yield { type: 'text', delta: 'stub reply' };
    },
  } as unknown as LLMProvider;
  await runCoreTurn({
    sessionId: 'usage-role-budget-path', messages: [{ role: 'user', content: 'hello there' }], tools: [tool],
    dispatchTool: async () => null, signal: new AbortController().signal, userText: 'hello there',
    // 출처: #39493 — r3 습득: initialProvider 는 제1인자 CoreTurnContext 필드(제2인자에 두면 초과 속성으로 무시)
    initialProvider: provider,
  }, {});
  const mainRows = seen.filter(row => row.usageRole === 'main');
  // 출처: #39493 — 실경로 관측 최소 1회(0이면 진입점 미도달, 시험 무효)
  expect(mainRows.length).toBeGreaterThan(0);
  const mainMax = mainRows[0]?.maxTokens;
  // 출처: #39493 — 'main' 은 기본(역할 미지정) 예산 버킷과 같은 값이어야 한다(output-budget.ts:10)
  expect(mainMax).toBe(resolveRequestMaxTokens(model, undefined));
  // 출처: #39493 — 역할 버킷으로 흐려지지 않음('classify' 2_048 은 기본 버킷과 다름)
  expect(mainMax).not.toBe(resolveRequestMaxTokens(model, 'classify'));
});

// A210 r6 — Terra mustFix(dfb 판정) «chat 진입점 변환 경계 우회» 수리: runTurn(src/session/chat.ts) 진입에서
// llmOpts.usageRole 'main' → undefined 좁힘(chat.ts:531)이 실제 공급자 요청 예산에 반영되는지 관측한다.
// 실경로: runTurn(llmOpts.usageRole) → chat.ts:531 resolveDefaultOutputTokens(model, 'main'→undefined, longAnswer)
// → streamLLM → 공급자 streamChat(_, { maxTokens }) — runCoreTurn 사슬과 별개의 두 번째 실경로 핀.
import { createSession } from '../session/index.js';
import { runTurn } from '../session/chat.js';
import { resolveDefaultOutputTokens } from '../llm.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

test('runTurn 좁힘 경계: usageRole main은 기본 버킷, classify는 통과 (A210 #124624)', async () => {
  const MODEL = 'test-usage-role-model';
  const seen: Array<{ maxTokens: number | null }> = [];
  const provider = {
    name: 'stub-runturn-usage-role', defaultModel: MODEL,
    streamChat: async function* (_messages: unknown, opts: { maxTokens?: number } = {}) {
      seen.push({ maxTokens: opts.maxTokens ?? null });
      yield { type: 'text' as const, delta: '확인' };
    },
  } as unknown as NonNullable<Parameters<typeof runTurn>[0]['provider']>;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elanous-usage-role-runturn-'));
  const prevRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = root;
  const runOnce = async (usageRole: 'main' | 'classify') => {
    seen.length = 0;
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL, title: 'usage-role-runturn' });
    await runTurn({
      sessionId: session.id, userText: '그 일 어떻게 됐어?',
      userConfig: { llm: { provider: provider.name, model: MODEL } } as unknown as NonNullable<Parameters<typeof runTurn>[0]['userConfig']>,
      provider, skipMemoryInjection: true, llmOpts: { usageRole },
    });
    return seen.map(s => s.maxTokens);
  };
  let mainMaxes: Array<number | null>, classifyMaxes: Array<number | null>;
  try {
    mainMaxes = await runOnce('main');
    classifyMaxes = await runOnce('classify');
  } finally {
    // Bun 은 undefined 대입을 문자열 "undefined" 로 남겨 뒤 시험을 오염시킨다 — 원래 미설정이면 delete 로 복원한다.
    if (prevRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = prevRoot;
  }
  // 출처: #124624
  expect(mainMaxes.length).toBeGreaterThan(0);
  expect(mainMaxes[0]).toBe(resolveDefaultOutputTokens(MODEL, undefined, false));
  // 출처: #124624
  expect(classifyMaxes.length).toBeGreaterThan(0);
  expect(classifyMaxes[0]).toBe(resolveDefaultOutputTokens(MODEL, 'classify', false));
  expect(classifyMaxes[0]).not.toBe(mainMaxes[0]);
});
