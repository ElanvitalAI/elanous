import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { debug } from '../debug/log.js';
import {
  runDashboardChatMainPlainTurn,
  type DashboardChatMainPlainTurnRuntimeDeps,
} from '../dashboard/input/chat-main-plain-turn-runtime.js';
import { startEventLoopStallMonitor } from '../dashboard/event-loop-stall-monitor.js';
import { createRunningBuildStatus } from '../dashboard/running-build-status.js';
import {
  FAILURE_SIGNATURES,
  formatFailureNotice,
  matchFailureEvent,
  matchFailureText,
} from './signatures.js';

// 「영어 덤프」 판정 — 영어 낱말 넷 이상이 이어지면 덤프로 본다(`/session new`·`eln logs` 같은 명령 이름은 둘까지).
const ENGLISH_DUMP = /[A-Za-z]+(?:\s+[A-Za-z]+){3,}/;

const findFailureSignature = (id: string) => FAILURE_SIGNATURES.find((sig) => sig.id === id) ?? null;

/** 한글·전각은 두 칸으로 센 화면 폭(근사). */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return width;
}

let matched: string[] = [];
let spy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  matched = [];
  spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'tui.failure-signature' && event === 'matched') matched.push(String(data?.id));
  }) as never);
});
afterEach(() => { spy?.mockRestore(); });

/** 던져진 턴 오류 하나를 실제 plain-turn 런타임에 주입하고 화면 줄·/detail 원문·꼬리줄 사유를 모은다. */
async function injectTurnError(error: unknown) {
  const chatLines: string[] = [];
  const errorLines: string[] = [];
  const notices: Array<{ notice: string; raw: string }> = [];
  const finals: Array<string | undefined> = [];
  const stops: Array<{ status?: string; errorText?: string }> = [];
  const debugEvents: string[] = [];
  const deps = {
    debugLog: (category: string, event: string) => { debugEvents.push(`${category}/${event}`); },
    userText: 'hi', contextText: '', turnStartedAt: 1,
    thinking: {
      update() {}, updateAnimated() {}, updateMetrics() {}, reflow() {},
      stop(opts?: { status?: string; errorText?: string }) { stops.push(opts ?? {}); },
    },
    benchmarkMode: false, attachedSessionId: null,
    chat: { history: [] }, chatLines, contextRegistry: {}, sessionRegistry: {}, sync: {},
    chatFooterLine: { current: null }, acpTurnRef: {},
    blockAttach: (line: string) => line,
    pushChatLine: (line: string) => { chatLines.push(line); },
    pushDebugLine: () => {}, setChatScrollBottom: () => {}, draw: () => {}, pinChatTail: () => {},
    termCols: () => 140, getSessionCwd: () => '/tmp',
    getUserConfig: () => ({ voice: { tts: { drainCooldownMs: 0 } } }),
    inspectActiveProvider: () => ({ model: 'm' }), getActivePluginName: () => undefined,
    buildTurnPromptRuntime: () => ({ promptBankContext: '', turnProfile: {} }),
    loadAttachments: async () => {},
    buildTurnMessage: () => ({ userMsg: { content: 'hi' } }),
    beginCodeEditTurn: async () => {},
    buildTurnPreamble: () => [],
    runAutoCompact: async () => {},
    attachChatStreamingKeys: () => () => {},
    createOptionalSpecs: async () => [],
    createTurnStreamRuntime: () => ({ onText() {}, onToolCall() {}, onToolResult() {}, getAssistantStart: () => 0 }),
    runTurnUsageRuntime: () => {},
    runTurnPrelude: () => ({ searchPlannerState: {} }),
    armAcpTurnRef: () => {}, resetAcpTurnRef: () => {},
    acpSession: { send: async () => { throw error; } },
    autoTts: { pushChunk() {}, commit() {}, cancel() {} },
    voiceChat: { getPhase: () => 'idle', transitionToSpeaking() {}, notifyResponseDone() {} },
    finalizeStreamLifecycle: (_c: () => void, _a: boolean, status: 'completed' | 'interrupted' | 'failed') => status,
    recordTurnMetrics: async () => {},
    commitAssistantRenderState: () => ({ lastAssistantRaw: null, lastAssistantRange: null, lastAssistantMode: 'rendered' }),
    applyAssistantRenderState: () => {},
    runTailAutoCopy: async () => {}, runCodeEditPostTurn: async () => {}, runHandoffMirror: async () => {},
    parseActionBlock: () => null, isBrowseMode: () => false, enterSyncMode: () => {},
    applyActionBlock: () => ({}), runActionEffects: async () => {},
    warningLine: (message: string) => message,
    pushErrorLine: (message: string) => { errorLines.push(message); },
    pushFailureNotice: (notice: string, raw: string) => { notices.push({ notice, raw }); chatLines.push(notice); },
    finalizeTurn: (_status: string, error?: string) => { finals.push(error); },
  } as unknown as DashboardChatMainPlainTurnRuntimeDeps;
  await runDashboardChatMainPlainTurn(deps);
  return { chatLines, errorLines, notices, finals, stops, debugEvents };
}

describe('실패 지문 사전', () => {
  test('id 는 겹치지 않고 모든 지문에 원인·처방이 있으며 한 화면 줄에 든다', () => {
    const ids = FAILURE_SIGNATURES.map((sig) => sig.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sig of FAILURE_SIGNATURES) {
      expect(sig.text ?? sig.event).toBeDefined();
      const notice = formatFailureNotice(sig, { rawHint: '/detail open' });
      expect(notice).not.toMatch(ENGLISH_DUMP);
      // 140칸 한 줄(한글 두 칸) 안 — 처방이 «…+N» 으로 잘리지 않게.
      expect(displayWidth(notice)).toBeLessThanOrEqual(130);
    }
  });

  test('가드 지문(#7·#12·#15)도 오류 문자열로 맞는다', () => {
    expect(matchFailureText('Tool budget reached. Answer using the evidence already collected.')?.id).toBe('tool-budget-reached');
    expect(matchFailureText('RUNTIME BLOCKED — repeated broad search loop detected (4 consecutive broad-search calls).')?.id).toBe('broad-search-loop');
    expect(matchFailureText('[SYNTHESIS IGNORED] The model kept issuing tool calls.')?.id).toBe('synthesis-ignored');
  });

  test('공급자 소진 문면 속 400 은 400 처방이 이긴다(원인 지문 우선)', () => {
    expect(matchFailureText('[LLM PROVIDER BLOCKED] fallback candidates exhausted\n- codex: Codex API 400: {"detail":"Bad Request"}')?.id)
      .toBe('codex-400-bad-request');
  });

  test('이벤트 지문은 문턱 아래에서 안 맞는다', () => {
    expect(matchFailureEvent({ category: 'tui.event-loop', event: 'stall', data: { lagMs: 400 } })).toBeNull();
    expect(matchFailureEvent({ category: 'tui.event-loop', event: 'stall', data: { lagMs: 14_357 } })?.id).toBe('event-loop-stall');
  });
});

describe('지문 1회 주입 — 화면 한 줄 · 영어 덤프 0 · 관측 1', () => {
  for (const [id, error] of [
    ['codex-400-bad-request', new Error('Codex API 400: {"detail":"Bad Request"}')],
    ['codex-400-bad-request', new Error('LLM API 400: {"detail":"Bad Request"}')],
    ['provider-fallback-exhausted', new Error('[LLM PROVIDER BLOCKED] fallback candidates exhausted\n- codex-rotate: The socket connection was closed unexpectedly')],
  ] as const) {
    test(`턴 오류 ${id}: 처방 한 줄 · 원문은 /detail · 꼬리 사유도 한국어`, async () => {
      const sig = findFailureSignature(id)!;
      const { chatLines, errorLines, notices, finals } = await injectTurnError(error);
      expect(errorLines).toEqual([]);
      // 턴 시작 때 밀어 넣는 빈 줄은 빼고 본다.
      expect(chatLines.filter((line) => line !== '')).toEqual([`⚠ ${sig.cause} → ${sig.next} · 원문 /detail open`]);
      for (const line of chatLines) expect(line).not.toMatch(ENGLISH_DUMP);
      expect(notices[0]!.raw).toBe(error.message);
      expect(finals).toEqual([sig.cause]);
      expect(matched).toEqual([id]);
    });
  }

  for (const message of [
    'LLM API 500: upstream exploded',
    // 모델과 무관한 400 — 400 처방(/session new)으로 바꾸지 않는다.
    'storage API 400 Bad Request',
    // 공급자 머리만 있고 소진 문구가 없는 오류 — 소진 처방으로 바꾸지 않는다.
    '[LLM PROVIDER STOPPED] category is not provider-dependent; do not spend remaining fallbacks\n- local: LLM API 401',
    '[LLM PROVIDER BLOCKED] policy denied\n- grok: LLM API 403',
  ]) {
    test(`지문 아닌 턴 오류는 옛 동작 — 원문 Error 줄 · 관측 0: ${message.split('\n')[0]}`, async () => {
      const { errorLines, notices } = await injectTurnError(new Error(message));
      expect(errorLines).toEqual([message]);
      expect(notices).toEqual([]);
      expect(matched).toEqual([]);
    });
  }

  test('Codex API 400: 처방 한 줄 ⊕ #27452 복구(thinking 멈춤)는 «원문»으로 판정돼 둘 다 걸린다', async () => {
    const { chatLines, stops, debugEvents } = await injectTurnError(new Error('Codex API 400: {"detail":"Bad Request"}'));
    const sig = findFailureSignature('codex-400-bad-request')!;
    expect(chatLines.filter((line) => line !== '')).toEqual([`⚠ ${sig.cause} → ${sig.next} · 원문 /detail open`]);
    expect(stops).toContainEqual({ status: 'failed', errorText: sig.cause });
    expect(debugEvents).toContain('chat.compact-400-recovery/thinking-stopped');
    expect(matched).toEqual(['codex-400-bad-request']);
  });

  test('LLM API 400: 처방 한 줄 · #27452 복구는 Codex 400 전용이라 안 걸린다', async () => {
    const { chatLines, debugEvents } = await injectTurnError(new Error('LLM API 400 Bad Request'));
    expect(chatLines.filter((line) => line !== '')).toHaveLength(1);
    expect(debugEvents).not.toContain('chat.compact-400-recovery/thinking-stopped');
    expect(matched).toEqual(['codex-400-bad-request']);
  });

  test('event-loop-stall: 2초 넘는 정지는 지문 관측 1 · 짧은 정지는 0', () => {
    let now = 0;
    let tick: (() => void) | undefined;
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    startEventLoopStallMonitor({
      intervalMs: 100, thresholdMs: 250, now: () => now,
      setIntervalFn: (callback) => { tick = callback; return {}; },
      clearIntervalFn: () => {},
      getContext: () => ({ streamingInFlight: true, thinkingMessage: null }),
      log: (c, e, d) => logs.push([c, e, d]),
    });
    now += 500; tick?.();
    now += 14_457; tick?.();
    expect(logs.filter(([c]) => c === 'tui.failure-signature')).toEqual([
      ['tui.failure-signature', 'matched', { id: 'event-loop-stall', surface: 'event-loop' }],
    ]);
  });

  test('stale-build: 옛 판으로 넘어가는 순간 한 번 · 해소 뒤 재전환도 센다', () => {
    let t = 0;
    let installedSha = 'a'.repeat(40);
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const status = createRunningBuildStatus({
      build: () => ({ version: 'v', sha: 'a'.repeat(40), source: 'installed' }),
      readInstalled: () => ({ sha: installedSha }),
      now: () => t,
      ttlMs: 1,
      log: (c, e, d) => logs.push([c, e, d]),
    });
    status();
    installedSha = 'b'.repeat(40);
    t = 10; status();
    t = 20; status();
    expect(logs.map(([c, e]) => `${c}/${e}`)).toEqual(['tui.run-state/stale', 'tui.failure-signature/matched']);
    expect(logs[1]![2]).toEqual({ id: 'stale-build', surface: 'status-bar' });
    installedSha = 'a'.repeat(40);
    t = 30; status();
    installedSha = 'c'.repeat(40);
    t = 40; status();
    expect(logs.filter(([c]) => c === 'tui.failure-signature')).toHaveLength(2);
  });
});

// ── TUI-400-AUTOHEAL-FALLBACK (대표 10-22) — 400(대화 기록 어긋남)이면 멈추지 않고 스스로 회복한다 ──
// ① 새 백엔드 세션 ⊕ 직전 요약으로 1회 재시도 → ② 또 400 이면 fallbackChain 다음 공급자로 그 턴 재시도
// → 둘 다 실패면 턴당 2회 상한에서 사람에게 이유 한 줄. 판정 대상은 생산 plain-turn 런타임 그대로다.
const HISTORY_400 = 'Codex API 400: {"error":{"message":"No tool call found for function call output with call_id call_autoheal_sim.","type":"invalid_request_error"}}';

async function injectAutoheal(script: ReadonlyArray<Error | string>, opts: {
  fallbackProvider?: string | null; emitBeforeError?: boolean; withAutoheal?: boolean;
} = {}) {
  const chatLines: string[] = [];
  const errorLines: string[] = [];
  const notices: Array<{ notice: string; raw: string }> = [];
  const finals: Array<{ status: string; error?: string }> = [];
  const debugEvents: Array<{ category: string; event: string; payload: Record<string, unknown> }> = [];
  const sends: Array<{ history: unknown[]; meta?: Record<string, unknown> }> = [];
  const renewed: string[] = [];
  const summarized: unknown[][] = [];
  const system = { role: 'system', content: 'sys' };
  const prior = [
    { role: 'user', content: '앞 질문' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_autoheal_sim', name: 'Read', input: {} }] },
  ];
  const history: unknown[] = [system, ...prior];
  let step = 0;
  const deps = {
    debugLog: (category: string, event: string, payload: Record<string, unknown>) => { debugEvents.push({ category, event, payload }); },
    userText: '다시 해줘', contextText: '', turnStartedAt: 1,
    thinking: { update() {}, updateAnimated() {}, updateMetrics() {}, reflow() {}, stop() {} },
    benchmarkMode: false, attachedSessionId: null,
    chat: { history }, chatLines, contextRegistry: {}, sessionRegistry: {}, sync: {},
    chatFooterLine: { current: null }, acpTurnRef: {},
    blockAttach: (line: string) => line,
    pushChatLine: (line: string) => { chatLines.push(line); },
    pushDebugLine: () => {}, setChatScrollBottom: () => {}, draw: () => {}, pinChatTail: () => {},
    termCols: () => 140, getSessionCwd: () => '/tmp',
    getUserConfig: () => ({ voice: { tts: { drainCooldownMs: 0 } } }),
    inspectActiveProvider: () => ({ model: 'm' }), getActivePluginName: () => undefined,
    buildTurnPromptRuntime: () => ({ promptBankContext: '', turnProfile: {} }),
    loadAttachments: async () => {},
    buildTurnMessage: () => ({ userMsg: { role: 'user', content: '다시 해줘' } }),
    beginCodeEditTurn: async () => {},
    buildTurnPreamble: () => [],
    runAutoCompact: async () => {},
    readToolDispatchCount: () => 0,
    attachChatStreamingKeys: () => () => {},
    createOptionalSpecs: async () => [],
    createTurnStreamRuntime: () => ({ onText() {}, onToolCall() {}, onToolResult() {}, getAssistantStart: () => 0 }),
    runTurnUsageRuntime: () => {},
    runTurnPrelude: () => ({ searchPlannerState: {} }),
    armAcpTurnRef: () => {}, resetAcpTurnRef: () => {},
    acpSession: {
      send: async (o: { onText: (chunk: string) => void; meta?: Record<string, unknown> }) => {
        sends.push({ history: [...history], ...(o.meta ? { meta: o.meta } : {}) });
        const next = script[step++];
        if (next === undefined) throw new Error('script exhausted');
        if (opts.emitBeforeError) o.onText('부분 답');
        if (next instanceof Error) throw next;
        o.onText(next);
        return { stopReason: 'end_turn' };
      },
    },
    ...(opts.withAutoheal === false ? {} : {
      autoheal: {
        renewBackendSession: async () => { const id = `sess-${renewed.length + 1}`; renewed.push(id); return id; },
        summarizeHistory: async (p: readonly unknown[]) => { summarized.push([...p]); return '요약: 앞 질문을 읽던 중'; },
        peekFallbackProvider: () => (opts.fallbackProvider === undefined ? 'grok' : opts.fallbackProvider),
      },
    }),
    autoTts: { pushChunk() {}, commit() {}, cancel() {} },
    voiceChat: { getPhase: () => 'idle', transitionToSpeaking() {}, notifyResponseDone() {} },
    finalizeStreamLifecycle: (_c: () => void, _a: boolean, status: 'completed' | 'interrupted' | 'failed') => status,
    recordTurnMetrics: async () => {},
    commitAssistantRenderState: () => ({ lastAssistantRaw: null, lastAssistantRange: null, lastAssistantMode: 'rendered' }),
    applyAssistantRenderState: () => {},
    runTailAutoCopy: async () => {}, runCodeEditPostTurn: async () => {}, runHandoffMirror: async () => {},
    parseActionBlock: () => null, isBrowseMode: () => false, enterSyncMode: () => {},
    applyActionBlock: () => ({}), runActionEffects: async () => {},
    warningLine: (message: string) => message,
    pushErrorLine: (message: string) => { errorLines.push(message); },
    pushFailureNotice: (notice: string, raw: string) => { notices.push({ notice, raw }); chatLines.push(notice); },
    finalizeTurn: (status: string, error?: string) => { finals.push({ status, ...(error !== undefined ? { error } : {}) }); },
  } as unknown as DashboardChatMainPlainTurnRuntimeDeps;
  await runDashboardChatMainPlainTurn(deps);
  const autoheal = debugEvents.filter((row) => row.category === 'self-health.autoheal');
  return { chatLines, errorLines, notices, finals, sends, renewed, summarized, history, autoheal, system, prior };
}

describe('TUI-400-AUTOHEAL-FALLBACK — 400 이면 스스로 회복(턴당 2회 상한)', () => {
  test('① 400 → 새 백엔드 세션 ⊕ 직전 요약으로 1회 재시도해 그 턴을 끝낸다', async () => {
    const r = await injectAutoheal([new Error(HISTORY_400), '회복된 답']);
    expect(r.finals).toEqual([{ status: 'completed' }]);
    expect(r.sends).toHaveLength(2);
    expect(r.renewed).toEqual(['sess-1']);
    // 요약은 «현재 질문을 뺀» 직전 기록으로 — 그리고 재시도 기록은 [system, 요약, 현재 질문] 하나뿐이다.
    expect(r.summarized).toEqual([[r.system, ...r.prior]]);
    expect(r.sends[1]!.history).toEqual([
      r.system,
      { role: 'assistant', content: 'Compacted conversation summary:\n\n요약: 앞 질문을 읽던 중' },
      { role: 'user', content: '다시 해줘' },
    ]);
    expect(r.chatLines.filter((line) => line.startsWith('자동 회복'))).toEqual(['자동 회복: 새 세션 ⊕ 요약으로 다시 시도 (1/2)']);
    expect(r.notices).toEqual([]);
    expect(r.autoheal.map((row) => row.event)).toEqual(['attempt', 'recovered']);
    expect(r.autoheal[0]!.payload).toMatchObject({ step: 'new-session', attempt: 1, sessionRenewed: true });
  });

  test('② 또 400 → fallbackChain 다음 공급자로 그 턴을 다시 보낸다', async () => {
    const r = await injectAutoheal([new Error(HISTORY_400), new Error(HISTORY_400), 'grok 답']);
    expect(r.finals).toEqual([{ status: 'completed' }]);
    expect(r.sends).toHaveLength(3);
    expect(r.sends[2]!.meta).toEqual({ elanousAutoheal: { providerFallback: true } });
    expect(r.chatLines.filter((line) => line.startsWith('자동 회복'))).toEqual([
      '자동 회복: 새 세션 ⊕ 요약으로 다시 시도 (1/2)',
      '자동 회복: 공급자 grok 로 다시 시도 (2/2)',
    ]);
    expect(r.autoheal.map((row) => `${row.event}:${String(row.payload.step ?? '')}`))
      .toEqual(['attempt:new-session', 'attempt:provider-fallback', 'recovered:provider-fallback']);
  });

  test('③ 둘 다 실패 → 2회에서 멈추고 사람에게 이유 한 줄(무한 반복 0)', async () => {
    const r = await injectAutoheal([new Error(HISTORY_400), new Error(HISTORY_400), new Error(HISTORY_400), 'never']);
    expect(r.sends).toHaveLength(3);
    expect(r.finals.map((f) => f.status)).toEqual(['failed']);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.notice).toBe('⚠ 자동 회복 2회 실패(새 세션 → 공급자 grok) → 잠시 뒤 다시 · eln usage · 원문 /detail open');
    expect(displayWidth(r.notices[0]!.notice)).toBeLessThanOrEqual(130);
    expect(r.notices[0]!.raw).toBe(HISTORY_400);
    expect(r.autoheal.at(-1)).toMatchObject({ event: 'exhausted', payload: { attempts: 2, reason: 'max-attempts' } });
  });

  test('③-b 대체 공급자가 없으면 1회 뒤 그 이유로 멈춘다', async () => {
    const r = await injectAutoheal([new Error(HISTORY_400), new Error(HISTORY_400), 'never'], { fallbackProvider: null });
    expect(r.sends).toHaveLength(2);
    expect(r.notices[0]!.notice).toBe('⚠ 자동 회복 1회 실패(새 세션 · 대체 공급자 없음) → 잠시 뒤 다시 · eln usage · 원문 /detail open');
    expect(r.autoheal.at(-1)).toMatchObject({ event: 'exhausted', payload: { attempts: 1, reason: 'no-fallback-provider' } });
  });

  test('반증: 답이 이미 흘렀으면 다시 보내지 않는다(중복 출력·부작용 0) — 옛 처방 한 줄', async () => {
    const r = await injectAutoheal([new Error(HISTORY_400), 'never'], { emitBeforeError: true });
    expect(r.sends).toHaveLength(1);
    expect(r.renewed).toEqual([]);
    expect(r.notices[0]!.notice).toBe(formatFailureNotice(findFailureSignature('codex-400-bad-request')!, { rawHint: '/detail open' }));
    expect(r.autoheal).toEqual([expect.objectContaining({ event: 'skipped', payload: expect.objectContaining({ reason: 'output-emitted' }) })]);
  });

  test('반증: 400 아닌 오류는 회복하지 않는다', async () => {
    const r = await injectAutoheal([new Error('LLM API 500: upstream exploded'), 'never']);
    expect(r.sends).toHaveLength(1);
    expect(r.errorLines).toEqual(['LLM API 500: upstream exploded']);
    expect(r.autoheal).toEqual([]);
  });

  test('반증: autoheal 배선이 없는 호출부는 옛 동작 그대로(한 번 · 처방 한 줄)', async () => {
    const r = await injectAutoheal([new Error(HISTORY_400), 'never'], { withAutoheal: false });
    expect(r.sends).toHaveLength(1);
    expect(r.notices).toHaveLength(1);
  });
});
