// 결함 주입 심 «TUI 턴 400 자동 회복» ── classic TUI 턴이 모델 API 400(대화 기록 어긋남)을 받으면
// ① 새 백엔드 세션 ⊕ 직전 요약으로 1회 재시도 → ② 또 400 이면 llm.fallbackChain 다음 공급자로 그 턴 재시도
// → 둘 다 실패면 턴당 2회 상한에서 사람에게 이유 한 줄 — 를 프로세스 안(S1)에서 재현한다.
//
// 🚨 왜 이것이 있나 (TUI-400-AUTOHEAL-FALLBACK · 대표 10-22)
// 10-22 07:1x OPT TUI 턴이 «Codex API 400(대화 기록 어긋남 의심)» 로 끝나고 멈췄다. 지문 `codex-400-bad-request` 는
// «/session new 뒤 다시» 를 사람에게 보여줄 뿐이었고 OP 가 손으로 쳐서 회복했다. 이 심이 그 멈춤(RED)과 회복(GREEN)을 가른다.
//
// ⛔ 흉내 내지 않는다 — 생산 턴 경로를 그대로 부른다:
//   `runDashboardChatMainPlainTurn`(classic TUI plain 턴) → `bootDashboardAcpSession`(in-process ACP · 대시보드와 같은 부트)
//   → `bridgeCoreTurnToAcp` → `runCoreTurn` → `streamLLMWithTools` → 생산 `PROVIDERS['openai-codex']`(Responses API HTTP)
//   ⊕ 폴백 대상 생산 `PROVIDERS.glm`(zai 코딩 플랜 · 자격 env 하나만 가짜). 자동 회복 배선도 대시보드와 같은
//   `createDashboardTurnAutoheal` 이고, 요약은 생산 `compactConversation`(같은 codex 경로로 요약 요청)이다.
// 주입은 HTTP 경계 하나뿐: codex 쪽은 스크립트된 400(실제 «No tool call found for function call output» 꼴) 또는
// 정상 SSE · zai 코딩 엔드포인트는 정상 SSE 또는 400. 화면 쪽은 줄 배열(렌더 없음 — 렌더는 headless-tui 심의 몫).
// 관측 = 화면 줄 · self-health.autoheal 이벤트 · 공급자별 HTTP 호출 수 · 영수증(명령 ⊕ injectionId ⊕ 결과) · 층 L1.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetKeyCacheForTests } from '../config.js';
import { debug } from '../debug/log.js';
import { PROVIDERS } from '../llm.js';
import { ZAI_CODING_PLAN_URL } from '../llm/zai-coding-plan.js';
import { ZAI_POD_SECRET_KEY } from '../task-orchestrator/surfaces/pod-zai-child.js';
import { setUserConfigOverlay } from '../user-config.js';
import { getCompactSystemPrompt } from '../compact/index.js';
import { bootDashboardAcpSession } from '../dashboard/acp-boot.js';
import {
  runDashboardChatMainPlainTurn,
  type DashboardChatMainPlainTurnRuntimeDeps,
} from '../dashboard/input/chat-main-plain-turn-runtime.js';
import { createDashboardTurnAutoheal } from '../dashboard/input/turn-autoheal.js';
import type { ChatMessage } from '../chat/index.js';

export const TUI_400_AUTOHEAL_LEVEL = 'L1' as const;
export const TUI_400_AUTOHEAL_EVIDENCE_COMMAND = 'bun test src/ux-sim/fault-tui-400-autoheal.test.ts';

/** 실제 codex 400 «대화 기록 어긋남» 본문 꼴(seat-autowake 가 잡는 `No tool call found for function call output with call_id`). */
export const TUI_400_HISTORY_MISMATCH_BODY = JSON.stringify({
  error: {
    message: 'No tool call found for function call output with call_id call_autoheal_sim.',
    type: 'invalid_request_error', param: 'input', code: null,
  },
});
export const TUI_400_CODEX_ANSWER = '[tui-400-autoheal] codex OK';
export const TUI_400_ZAI_ANSWER = '[tui-400-autoheal] zai OK';
export const TUI_400_SUMMARY = '[tui-400-autoheal] 요약: 앞 질문은 src/a.ts 읽기';

/** 시나리오 — codex «HTTP 호출»별 응답 스크립트(요약 요청은 따로 정상 응답) ⊕ zai 응답.
 *  ⚠️ 생산 재시도 정책(`fetchApiWithRetry` → `decideRetry`)이 400 을 같은 공급자로 한 번 더 보낸다 —
 *  그래서 «턴 한 번 실패» = codex 400 두 번이다(llm.retry 관측으로 센다). 스크립트는 그 실측 꼴을 따른다. */
export type Tui400Scenario = 'heal-new-session' | 'heal-provider' | 'exhausted';

const SCRIPTS: Readonly<Record<Tui400Scenario, { codex: ReadonlyArray<'400' | 'ok'>; zai: '400' | 'ok' }>> = {
  'heal-new-session': { codex: ['400', '400', 'ok'], zai: 'ok' },
  'heal-provider': { codex: ['400', '400', '400', '400'], zai: 'ok' },
  exhausted: { codex: ['400', '400', '400', '400'], zai: '400' },
};

const ISOLATED_LLM_ENV_KEYS = [
  'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL', 'OPENROUTER_API_KEY', 'OPENGATEWAY_API_KEY', 'ZAI_API_KEY',
  'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER',
] as const;

export interface Tui400Observation {
  readonly level: typeof TUI_400_AUTOHEAL_LEVEL;
  readonly injectionId: string;
  readonly scenario: Tui400Scenario;
  /** 턴 마감 상태(finalizeTurn). */
  readonly status: string;
  /** 'recovered-new-session' | 'recovered-provider' | 'stopped' */
  readonly result: 'recovered-new-session' | 'recovered-provider' | 'stopped';
  /** 사람이 본 줄(빈 줄 제외). */
  readonly screen: readonly string[];
  /** 화면에 흐른 답(스트림 텍스트). */
  readonly answer: string;
  readonly codexTurnCalls: number;
  readonly codexSummaryCalls: number;
  readonly zaiCalls: number;
  /** llm.retry «retry» 줄 수 — 생산 재시도 정책이 같은 공급자로 다시 보낸 횟수. */
  readonly sameProviderRetries: number;
  /** 새 백엔드 세션으로 바뀌었나(ACP 세션 id 비교). */
  readonly sessionRenewed: boolean;
  /** 재시도 직전 TUI 기록의 역할 줄 — [system?, 요약 assistant, 현재 user]. */
  readonly historyRoles: readonly string[];
  readonly autoheal: ReadonlyArray<{ event: string; data: Record<string, unknown> }>;
}

export function tui400Receipt(o: Pick<Tui400Observation, 'injectionId' | 'result'>): string {
  return `영수증: ${TUI_400_AUTOHEAL_EVIDENCE_COMMAND} ⊕ ${o.injectionId} ⊕ ${o.result}`;
}

export function renderTui400(o: Tui400Observation): string[] {
  return [
    `tui-400-autoheal · 층 ${o.level} · 주입 ${o.injectionId} · 시나리오 ${o.scenario} · 결과 ${o.result} · 턴 ${o.status}`,
    `  HTTP: codex 턴 ${o.codexTurnCalls} · codex 요약 ${o.codexSummaryCalls} · zai ${o.zaiCalls} · 같은 공급자 재시도 ${o.sameProviderRetries} · 새 세션 ${o.sessionRenewed ? '예' : '아니오'}`,
    ...o.screen.map((line) => `  화면│ ${line}`),
    `  답: ${o.answer || '(없음)'}`,
    ...o.autoheal.map((row) => `  self-health.autoheal ${row.event} ${JSON.stringify(row.data)}`),
    tui400Receipt(o),
  ];
}

/** 정상 SSE 한 토막 — 엔드포인트 모양을 따른다(Chat Completions `choices[].delta` · Responses `output_text.delta`). */
function okStream(url: string, text: string): Response {
  const events: unknown[] = url.includes('/chat/completions') || url === ZAI_CODING_PLAN_URL
    ? [{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }]
    : [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { id: 'ok' } }];
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 결함 주입 본체 — 생산 classic TUI plain 턴을 그대로 한 번 돈다. */
export async function simTui400Autoheal(
  scenario: Tui400Scenario,
  opts: {
    injectionId?: string;
    /** false = 자동 회복 배선 없이(수리 전 동작 · 10-22 실측 멈춤 재현). 기본 true. */
    autoheal?: boolean;
  } = {},
): Promise<Tui400Observation> {
  const injectionId = opts.injectionId ?? `inj-${randomUUID()}`;
  const script = SCRIPTS[scenario];
  const savedEnv = { ...process.env };
  const savedGrok = PROVIDERS.grok;
  const savedFetch = globalThis.fetch;
  const savedLog = debug.log;
  const home = mkdtempSync(join(tmpdir(), 'fault-tui-400-'));
  const rows: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  let codexTurnCalls = 0;
  let codexSummaryCalls = 0;
  let zaiCalls = 0;
  let session: Awaited<ReturnType<typeof bootDashboardAcpSession>>['session'] | null = null;
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.CODEX_HOME = join(home, '.codex');
    process.env.ELANOUS_STATE_DIR = join(home, 'state');
    for (const key of ISOLATED_LLM_ENV_KEYS) delete process.env[key];
    process.env.ELANOUS_KEEP_ENV_KEYS = '1';
    _resetKeyCacheForTests();
    // ② 의 «다음 공급자» = 생산 glm(zai 코딩 플랜). 자격 env 하나만 가짜 값 — 공급자 코드는 그대로.
    process.env[ZAI_POD_SECRET_KEY] = 'fake-zai-test-only';
    // grok 자격은 os.homedir() 의 auth.json 이라 HOME 격리로 못 지운다 — 체인 밖으로 새지 않게 이 한 칸만 막는다.
    PROVIDERS.grok = { ...savedGrok!, available: () => false };
    setUserConfigOverlay((config) => ({
      ...config,
      llm: {
        ...config.llm, provider: 'openai-codex', apiKey: 'fake-codex-test-only',
        fallbackChain: ['codex-rotate', 'zai'], goalLoop: { ...(config.llm.goalLoop ?? {}), enabled: false },
      },
    }));
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === 'string' ? init.body : '';
        if (url === ZAI_CODING_PLAN_URL) {
          zaiCalls += 1;
          if (script.zai === '400') return new Response(TUI_400_HISTORY_MISMATCH_BODY, { status: 400 });
          return okStream(url, TUI_400_ZAI_ANSWER);
        }
        // 요약(생산 compactConversation)도 같은 codex 경로로 간다 — 요약 요청은 정상 응답(스크립트 밖).
        // 판별은 생산 요약 프롬프트(`getCompactSystemPrompt`) 그대로 — 문구가 바뀌어도 같이 따라간다.
        if (body.includes(JSON.stringify(getCompactSystemPrompt()).slice(1, 61))) {
          codexSummaryCalls += 1;
          return okStream(url, TUI_400_SUMMARY);
        }
        const step = script.codex[codexTurnCalls] ?? '400';
        codexTurnCalls += 1;
        if (step === '400') return new Response(TUI_400_HISTORY_MISMATCH_BODY, { status: 400 });
        return okStream(url, TUI_400_CODEX_ANSWER);
      },
      { preconnect: (savedFetch as unknown as { preconnect?: unknown }).preconnect },
    ) as typeof fetch;
    debug.log = ((category: string, event: string, data: Record<string, unknown>): void => {
      rows.push({ category, event, data: data ?? {} });
    }) as typeof debug.log;

    // 대화 기록 — 짝 없는 도구 호출이 남은 «어긋난» 기록(실측 400 의 모양).
    const history: ChatMessage[] = [
      { role: 'system', content: 'tui-400-autoheal system' },
      { role: 'user', content: '앞 질문: src/a.ts 읽어줘' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_autoheal_sim', name: 'Read', input: { path: 'src/a.ts' } }] },
    ] as unknown as ChatMessage[];
    const cwd = home;
    const boot = await bootDashboardAcpSession({
      getCwd: () => cwd,
      getChatHistory: () => history,
      getPreamble: () => [],
      // 실제 TUI 턴처럼 도구가 실린 턴(streamLLMWithTools 도구 경로) — 모델이 안 부르면 실행은 0.
      getTools: () => [{ name: 'tui_400_probe', description: 'tui-400-autoheal probe', parameters: { type: 'object' } }],
      getActiveModel: () => null,
      dispatchTool: async () => ({ error: 'no tools in tui-400-autoheal' }),
      pushTurnToolHistory: (msgs) => { for (const m of msgs) history.push(m as ChatMessage); },
    });
    session = boot.session;
    session.setOriginSessionIdReader(() => null);
    const firstSessionId = session.currentSessionId;
    const screen: string[] = [];
    let answer = '';
    let status = 'unknown';
    let historyRoles: string[] = [];
    const userText = `tui-400-autoheal ${injectionId}: 다시 해줘`;
    const userMsg = { role: 'user', content: userText };
    const liveSession = session;
    const deps = {
      debugLog: (category: string, event: string, payload: Record<string, unknown>) => { debug.log(category, event, payload); },
      userText, contextText: '', turnStartedAt: Date.now(),
      thinking: { update() {}, updateAnimated() {}, updateMetrics() {}, reflow() {}, stop() {} },
      benchmarkMode: false, attachedSessionId: null,
      chat: { history }, chatLines: screen, contextRegistry: {}, sessionRegistry: {}, sync: {},
      chatFooterLine: { current: null }, acpTurnRef: {},
      blockAttach: (line: string) => line,
      pushChatLine: (line: string) => { screen.push(line); },
      pushDebugLine: () => {}, setChatScrollBottom: () => {}, draw: () => {}, pinChatTail: () => {},
      termCols: () => 140, getSessionCwd: () => cwd,
      getUserConfig: () => ({ voice: { tts: { drainCooldownMs: 0 } } }),
      inspectActiveProvider: () => ({ model: 'gpt-6-sol' }), getActivePluginName: () => undefined,
      buildTurnPromptRuntime: () => ({ promptBankContext: '', turnProfile: {} }),
      loadAttachments: async () => {},
      buildTurnMessage: () => ({ userMsg }),
      beginCodeEditTurn: async () => {},
      buildTurnPreamble: () => [],
      runAutoCompact: async () => {},
      readToolDispatchCount: () => 0,
      attachChatStreamingKeys: () => () => {},
      createOptionalSpecs: async () => [],
      createTurnStreamRuntime: () => ({
        onText(chunk: string) { answer += chunk; }, onToolCall() {}, onToolResult() {}, getAssistantStart: () => 0,
      }),
      runTurnUsageRuntime: () => {},
      runTurnPrelude: () => ({ searchPlannerState: {} }),
      armAcpTurnRef: () => {}, resetAcpTurnRef: () => {},
      acpSession: {
        send: (o: Parameters<typeof liveSession.send>[0]) => {
          historyRoles = history.map((m) => `${m.role}${typeof m.content === 'string' && m.content.startsWith('Compacted conversation summary') ? ':summary' : ''}`);
          return liveSession.send(o);
        },
      },
      ...(opts.autoheal === false ? {} : {
        autoheal: createDashboardTurnAutoheal({
          session: liveSession, getCwd: () => cwd, remote: false, activeModel: () => undefined, summaryTimeoutMs: 10_000,
        }),
      }),
      autoTts: { pushChunk() {}, commit() {}, cancel() {} },
      voiceChat: { getPhase: () => 'idle', transitionToSpeaking() {}, notifyResponseDone() {} },
      finalizeStreamLifecycle: (_c: () => void, _a: boolean, s: 'completed' | 'interrupted' | 'failed') => s,
      recordTurnMetrics: async () => {},
      commitAssistantRenderState: () => ({ lastAssistantRaw: null, lastAssistantRange: null, lastAssistantMode: 'rendered' }),
      applyAssistantRenderState: () => {},
      runTailAutoCopy: async () => {}, runCodeEditPostTurn: async () => {}, runHandoffMirror: async () => {},
      parseActionBlock: () => null, isBrowseMode: () => false, enterSyncMode: () => {},
      applyActionBlock: () => ({}), runActionEffects: async () => {},
      warningLine: (message: string) => message,
      pushErrorLine: (message: string) => { screen.push(message); },
      pushFailureNotice: (notice: string) => { screen.push(notice); },
      finalizeTurn: (s: string) => { status = s; },
    } as unknown as DashboardChatMainPlainTurnRuntimeDeps;
    await runDashboardChatMainPlainTurn(deps);
    const autoheal = rows.filter((row) => row.category === 'self-health.autoheal')
      .map(({ event, data }) => ({ event, data }));
    const recovered = autoheal.find((row) => row.event === 'recovered');
    const result = status !== 'completed' || !recovered ? 'stopped'
      : recovered.data.step === 'provider-fallback' ? 'recovered-provider' : 'recovered-new-session';
    return {
      level: TUI_400_AUTOHEAL_LEVEL,
      injectionId,
      scenario,
      status,
      result,
      screen: screen.filter((line) => line !== ''),
      answer,
      codexTurnCalls,
      codexSummaryCalls,
      zaiCalls,
      sameProviderRetries: rows.filter((row) => row.category === 'llm.retry' && row.event === 'retry').length,
      sessionRenewed: liveSession.currentSessionId !== firstSessionId,
      historyRoles,
      autoheal,
    };
  } finally {
    try { await session?.close(); } catch { /* best-effort teardown */ }
    debug.log = savedLog;
    globalThis.fetch = savedFetch;
    PROVIDERS.grok = savedGrok!;
    setUserConfigOverlay(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    _resetKeyCacheForTests();
    rmSync(home, { recursive: true, force: true });
  }
}
