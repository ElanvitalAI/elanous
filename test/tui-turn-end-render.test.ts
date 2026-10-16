// TUI «턴이 끝나는 자리» 화면 결함 — #5 진행 표시 정지 · #22 401 조용한 완료 (10-14 TUI OP 실측).
// 실제 `startPinnedThinking` ⊕ `finalizeDashboardTurn` 을 실제 plain-turn 런타임에 물려 갈래마다
// footer 가 비워지고 «Thinking…» 프레임이 다시 칠해지지 않는지 잰다.
import { describe, expect, test } from 'bun:test';
import { goalLoopIterationThinking } from '../src/dashboard/goal-loop-thinking.js';
import { startPinnedThinking, type ThinkingHandle } from '../src/thinking-line.js';
import { finalizeDashboardTurn } from '../src/dashboard/turn-finalize-runtime.js';
import {
  runDashboardChatMainPlainTurn,
  type DashboardChatMainPlainTurnRuntimeDeps,
} from '../src/dashboard/input/chat-main-plain-turn-runtime.js';
import { CoreTurnAuthRejectedError, AUTH_REJECTED_NOTICE } from '../src/core-turn/auth-rejected-notice.js';
import { tuiSourceText } from './helpers/dashboard-source.js';

const strip = (s: string | null): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

const abortRef: { current: AbortController | null } = { current: null };

function harness(send: DashboardChatMainPlainTurnRuntimeDeps['acpSession']['send']) {
  const footer = { current: null as string | null };
  const chatLines: string[] = [];
  const errorLines: string[] = [];
  const thinking: ThinkingHandle = startPinnedThinking({ target: footer, onFrame: () => {}, intervalMs: 0, message: 'Thinking' });
  const noop = () => {};
  const deps = {
    userText: 'q', contextText: '', turnStartedAt: Date.now(), thinking, benchmarkMode: false, attachedSessionId: null,
    chat: { history: [] }, chatLines, contextRegistry: {}, sessionRegistry: {}, sync: {}, chatFooterLine: footer, acpTurnRef: {},
    blockAttach: (l: string) => l, pushChatLine: (l: string) => { chatLines.push(l); }, pushDebugLine: noop,
    setChatScrollBottom: noop, draw: noop, pinChatTail: noop, termCols: () => 120, getSessionCwd: () => '/tmp',
    getUserConfig: () => ({ voice: { tts: { drainCooldownMs: 0 } } }), inspectActiveProvider: () => ({ model: 'm' }),
    getActivePluginName: () => undefined,
    buildTurnPromptRuntime: () => ({ promptBankContext: '', turnProfile: {} }),
    loadAttachments: async () => {}, buildTurnMessage: () => ({ userMsg: { content: 'q' } }), beginCodeEditTurn: async () => {},
    buildTurnPreamble: () => [], runAutoCompact: async () => {},
    attachChatStreamingKeys: (ctrl: AbortController) => { abortRef.current = ctrl; return noop; },
    createOptionalSpecs: async () => [],
    createTurnStreamRuntime: () => ({
      onText: () => { thinking.update('Streaming'); }, onToolCall: noop, onToolResult: noop, getAssistantStart: () => 0,
    }),
    runTurnUsageRuntime: noop, runTurnPrelude: () => ({ searchPlannerState: {} }), armAcpTurnRef: noop, resetAcpTurnRef: noop,
    acpSession: { send },
    autoTts: { pushChunk: noop, commit: noop, cancel: noop },
    voiceChat: { getPhase: () => 'idle', transitionToSpeaking: noop, notifyResponseDone: noop },
    finalizeStreamLifecycle: (cleanup: () => void, aborted: boolean, status: 'completed' | 'interrupted' | 'failed') => {
      cleanup();
      return aborted ? 'interrupted' : status;
    },
    recordTurnMetrics: async () => {}, commitAssistantRenderState: () => ({}) as never, applyAssistantRenderState: noop,
    runTailAutoCopy: async () => {}, runCodeEditPostTurn: async () => {}, runHandoffMirror: async () => {},
    parseActionBlock: () => null, isBrowseMode: () => false, enterSyncMode: noop, applyActionBlock: () => ({}),
    runActionEffects: async () => {}, warningLine: (m: string) => m,
    pushErrorLine: (m: string) => { errorLines.push(m); },
    finalizeTurn: (status: 'completed' | 'interrupted' | 'failed', error?: string) => finalizeDashboardTurn({
      thinking, finalStatus: status, ...(error !== undefined ? { finalError: error } : {}), engineBadge: '',
      chatFooterLine: footer, pushChatLine: (l) => { chatLines.push(l); }, setChatScrollBottom: noop,
      consumeQuickControl: () => false, muted: (t) => t, draw: noop,
    }),
  } as unknown as DashboardChatMainPlainTurnRuntimeDeps;
  return { deps, footer, chatLines, errorLines, thinking };
}

describe('턴 마감 갈래마다 진행 표시를 거둔다 (#5)', () => {
  const branches: Array<[string, DashboardChatMainPlainTurnRuntimeDeps['acpSession']['send'], RegExp]> = [
    ['성공', async ({ onText }) => { onText('답'); }, /완료/],
    ['오류(400)', async () => { throw new Error('Codex API 400: {"detail":"Bad Request"}'); }, /실패/],
    ['인증 거절(401)', async () => { throw new CoreTurnAuthRejectedError('Codex API 401: unauthorized'); }, /실패/],
    ['중단(Esc)', async ({ onText }) => { onText('부분'); abortRef.current!.abort(); }, /중단/],
  ];
  for (const [name, send, marker] of branches) {
    test(`${name} — footer 는 비고, 마감 줄 하나, 늦은 update 는 다시 칠하지 않는다`, async () => {
      const h = harness(send);
      await runDashboardChatMainPlainTurn(h.deps);
      expect(h.footer.current).toBeNull();
      const markers = h.chatLines.map(strip).filter((l) => /완료|실패|중단/.test(l));
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatch(marker);
      expect(h.chatLines.map(strip).some((l) => /Thinking…|Streaming…/.test(l))).toBe(false);
      // 턴 마감 뒤 도착한 이벤트(같은 손잡이 재사용·늦은 usage)가 멈춘 프레임을 footer 에 다시 쓰면 안 된다.
      h.thinking.update('Streaming');
      h.thinking.updateMetrics({ outputTokens: 10 });
      h.thinking.updateAnimated(() => 'Thinking');
      expect(h.footer.current).toBeNull();
    });
  }

  test('같은 손잡이로 두 번째 턴을 마감해도 «Thinking…» 줄이 이력에 남지 않는다', async () => {
    const h = harness(async ({ onText }) => { onText('답'); });
    await runDashboardChatMainPlainTurn(h.deps);
    await runDashboardChatMainPlainTurn(h.deps);
    expect(h.chatLines.map(strip).some((l) => /Thinking…|Streaming…/.test(l))).toBe(false);
    expect(h.footer.current).toBeNull();
  });
});

describe('401 은 처방 한 줄로 끝난다 (#22)', () => {
  test('오류 줄 1개 = 처방 ⊕ 원문 · 마감 줄은 «실패»(«완료» 아님)', async () => {
    const h = harness(async () => { throw new CoreTurnAuthRejectedError('Codex API 401: {"detail":"Unauthorized"}'); });
    await runDashboardChatMainPlainTurn(h.deps);
    expect(h.errorLines).toHaveLength(1);
    expect(h.errorLines[0]).toStartWith(AUTH_REJECTED_NOTICE);
    expect(h.errorLines[0]).toContain('원문: Codex API 401');
    expect(h.errorLines[0]).not.toContain('\n');
    const lines = h.chatLines.map(strip);
    expect(lines.some((l) => /완료/.test(l))).toBe(false);
    expect(lines.some((l) => /실패 — ⚠ 모델 공급자가 인증을 거절/.test(l))).toBe(true);
  });
});

describe('/goal 반복 진행 표시 (#5 · 리뷰 r1 지적: 루프가 끝난 뒤 새 표시를 달면 아무도 안 거둔다)', () => {
  // 대시보드 do-while 의 모양을 그대로 돈다 — 반복 머리에서 손잡이를 고르고, 턴 뒤 goal 판정으로 계속/끝.
  async function driveGoalLoop(actions: Array<'continue' | 'stop'>) {
    const footer = { current: null as string | null };
    const chatLines: string[] = [];
    let started = 0;
    const footerDuringSend: Array<string | null> = [];
    const start = () => { started += 1; return startPinnedThinking({ target: footer, onFrame: () => {}, intervalMs: 0, message: 'Thinking' }); };
    let thinking = startPinnedThinking({ target: footer, onFrame: () => {}, intervalMs: 0, message: 'Routing' });
    let iteration = 0;
    let next: string | null = null;
    let step = 0;
    do {
      thinking = goalLoopIterationThinking(iteration++, thinking, start);
      const h = harness(async ({ onText }) => { footerDuringSend.push(footer.current); onText('답'); });
      const live = thinking;
      (h.deps as { thinking: ThinkingHandle }).thinking = live;
      (h.deps as { chatFooterLine: { current: string | null } }).chatFooterLine = footer;
      (h.deps as { pushChatLine: (l: string) => void }).pushChatLine = (l) => { chatLines.push(l); };
      (h.deps as { finalizeTurn: DashboardChatMainPlainTurnRuntimeDeps['finalizeTurn'] }).finalizeTurn = (status, error) => finalizeDashboardTurn({
        thinking: live, finalStatus: status, ...(error !== undefined ? { finalError: error } : {}), engineBadge: '',
        chatFooterLine: footer, pushChatLine: (l) => { chatLines.push(l); }, setChatScrollBottom: () => {},
        consumeQuickControl: () => false, muted: (t) => t, draw: () => {},
      });
      await runDashboardChatMainPlainTurn(h.deps);
      const action = actions[step++] ?? 'stop';
      next = action === 'continue' ? 'Continue the active goal.' : null;
    } while (next !== null);
    return { footer, chatLines, started, footerDuringSend };
  }

  for (const actions of [['stop'], ['continue', 'stop'], ['continue', 'continue', 'stop']] as const) {
    test(`반복 ${actions.length}회 — 새 표시 ${actions.length - 1}개 · 반복마다 살아 있는 표시 · 끝나면 footer 비고 «Thinking…» 0`, async () => {
      const r = await driveGoalLoop([...actions]);
      expect(r.started).toBe(actions.length - 1);
      expect(r.footerDuringSend).toHaveLength(actions.length);
      for (const shown of r.footerDuringSend) expect(strip(shown)).toMatch(/(Routing|Thinking|Streaming)…/);
      expect(r.footer.current).toBeNull();
      expect(r.chatLines.map(strip).filter((l) => /완료/.test(l))).toHaveLength(actions.length);
      expect(r.chatLines.map(strip).some((l) => /Thinking…|Streaming…|Routing…/.test(l))).toBe(false);
    });
  }

  test('대시보드 소스 — 손잡이 선택은 do 머리(제출 전)에만 있고, 루프 꼬리(상한·판정 뒤)에는 새 표시가 없다', () => {
    const source = tuiSourceText();
    const loopStart = source.indexOf('let goalLoopIteration = 0;');
    const loopEnd = source.indexOf('} while (goalLoopUserText !== null);', loopStart);
    expect(loopStart).toBeGreaterThan(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const body = source.slice(loopStart, loopEnd);
    const pick = body.indexOf('thinking = goalLoopIterationThinking(goalLoopIteration++, thinking,');
    const submit = body.indexOf('await runDashboardChatMainSubmitIntent(');
    expect(pick).toBeGreaterThan(0);
    expect(pick).toBeLessThan(submit);
    expect(body.slice(submit)).not.toContain('startPinnedThinking(');
  });
});
