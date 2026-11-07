// 턴 UX 시뮬레이터 계약 — ⛔ 이 장치가 «진짜 렌더 경로»를 탄다는 것이 존재 이유다.
import { afterEach, describe, test, expect, mock, spyOn } from 'bun:test';
import { simFooterLine, simLines, simTypeaheadState, type TurnSimSpec } from './turn-states.js';
import { simRenderLogFrame } from './render-frame.js';
import { renderTurnTypeaheadQueueRow } from '../chat/turn-typeahead.js';
import { simEscGate } from './interaction.js';
import { TURN_ABORT_TURN_ONLY } from '../turn-abort-scope.js';
import { runGoalLoop } from '../core-turn/run-goal-loop.js';
import type { CoreTurnContext } from '../core-turn/types.js';
import * as core from '../core-turn/run-core-turn.js';
import { debug } from '../debug/log.js';
import { bridgeCoreTurnToAcp } from '../acp/core-turn-bridge.js';
import type { AcpTurnContext } from '../acp/server.js';

afterEach(() => mock.restore());

describe('turn-states — 국면별 상태 팩토리', () => {
  test('idle 은 스트리밍 표시줄이 «없다»', () => {
    expect(simFooterLine({ phase: 'idle' })).toBeNull();
    expect(simLines({ phase: 'idle' })).toEqual([]);
  });

  test('국면마다 footer 문면이 다르다 — 화면에서 관측한 형태를 재현한다', () => {
    expect(simFooterLine({ phase: 'thinking' })).toContain('Thinking');
    expect(simFooterLine({ phase: 'streaming' })).toContain('Streaming');
    expect(simFooterLine({ phase: 'streaming-with-subagents', children: 3 })).toContain('Agent (3 tools)');
    expect(simFooterLine({ phase: 'harness-child' })).toContain('SelfImplement');
  });

  test('서브에이전트 국면은 자식 수만큼 Agent 줄을 만든다', () => {
    const lines = simLines({ phase: 'streaming-with-subagents', children: 3 });
    expect(lines.filter((l) => l.includes('⏺ Agent('))).toHaveLength(3);
  });

  test('⭐ 큐 상태를 «실제 판정기»로 만든다 — 손으로 객체를 짓지 않는다', () => {
    const state = simTypeaheadState({ phase: 'streaming', queued: ['첫째', '둘째'], draft: 'xy' });
    expect(state.queuedSubmissions).toEqual(['첫째', '둘째']);
    expect(state.buffer).toBe('xy');
  });

});

describe('simRenderLogFrame — 실제 위젯 render 를 탄다', () => {
  const streaming: TurnSimSpec = { phase: 'streaming' };

  test('스트리밍 표시줄이 프레임에 실제로 그려진다', () => {
    expect(simRenderLogFrame(streaming).text).toContain('Streaming');
  });

  test('idle 은 표시줄이 없다', () => {
    expect(simRenderLogFrame({ phase: 'idle' }).text).not.toContain('Streaming…');
  });

  test('폭·높이를 주면 그 안에서 그린다', () => {
    const frame = simRenderLogFrame(streaming, { width: 60, height: 8 });
    expect(frame.lines.length).toBeLessThanOrEqual(8);
  });

  test('⭐⭐ 「공급했는데 안 그려진다」를 «값»으로 답한다 — 이 장치의 핵심 쓰임', () => {
    const ta = simTypeaheadState({ phase: 'streaming', queued: ['대기 발화'] });
    const queueRow = renderTurnTypeaheadQueueRow(ta, 100)!;
    expect(queueRow).toContain('대기 발화');
    const frame = simRenderLogFrame(streaming, { extraState: { queueRow } });
    // ⭐⭐⭐ 「공급 → 렌더」가 «끝까지» 이어진다. 이 단언이 이 장치의 존재 이유다.
    //   📏 2026-08-19: 이 갈림을 라이브로 찾는 데 «한 시간»이 들었고, 이 장치로는 «0.04초»다.
    //   ⛔ 이 줄이 깨지면 「위쪽 층은 옳게 공급하는데 아래 층이 필드를 떨어뜨린다」는 뜻이다 —
    //     실제로 `widgets/log/widget.ts` 의 «필드를 골라 담는» 매핑에서 한 번 잃었다.
    expect(frame.text).toContain(queueRow.slice(0, 12));
  });

  test('⛔ 스트리밍이 아니면(footer 없음) 큐 행을 그리지 않는다 — 그때는 「대기」 개념이 없다', () => {
    const ta = simTypeaheadState({ phase: 'idle', queued: ['대기 발화'] });
    const queueRow = renderTurnTypeaheadQueueRow(ta, 100)!;
    const frame = simRenderLogFrame({ phase: 'idle' }, { extraState: { queueRow } });
    expect(frame.text).not.toContain(queueRow.slice(0, 12));
  });

  test('⭐ 큐 행은 스트리밍 표시줄 «바로 위»다 (대표 지시: 입력기가 아니라 스트리밍 프롬프트)', () => {
    const ta = simTypeaheadState({ phase: 'streaming', queued: ['대기 발화'] });
    const queueRow = renderTurnTypeaheadQueueRow(ta, 100)!;
    const frame = simRenderLogFrame(streaming, { extraState: { queueRow } });
    const qIdx = frame.lines.findIndex((l) => l.includes(queueRow.slice(0, 12)));
    const fIdx = frame.lines.findIndex((l) => l.includes('Streaming'));
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(fIdx).toBeGreaterThan(qIdx);      // 큐 행이 «위»에 있다
  });

  test('자리 상한 뒤 idle 창에서 다음 입력 초안과 Esc가 다시 동작한다', async () => {
    const ctx = {
      sessionId: 'ux-sim-seat-cap-boundary',
      messages: [{ role: 'user', content: '자리 작업을 계속해줘' }],
      tools: [],
      dispatchTool: async () => ({ ok: true }),
      signal: new AbortController().signal,
    } as unknown as CoreTurnContext;
    const result = await runGoalLoop(ctx, {
      seatTurnCap: { seat: 'UX', maxTools: 1, maxWallMs: 5_000, idleEmptyMsgListLimit: 2 },
      maxIterations: 3,
      changedFiles: () => [],
      controlSpaceId: null,
      intentStallProvider: null,
      attachLifecycleBridge: () => () => {},
      startLivenessHeartbeat: () => () => {},
      runTurn: async (turn) => {
        await turn.dispatchTool('RunShell', { command: 'true' }, {} as never);
        return { stopReason: 'end_turn', finalText: '상한 직전 진행' };
      },
    });
    expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false, iterations: 1 });

    const idleFrame = simRenderLogFrame({ phase: 'idle' });
    const input = simTypeaheadState({ phase: 'idle', draft: '다음 요청' });
    const escape = simEscGate({ runningChildren: 0 });
    escape.esc();
    expect(idleFrame.text).not.toContain('Streaming');
    expect(input.buffer).toBe('다음 요청');
    expect(escape.abortReason()).toBe(TURN_ABORT_TURN_ONLY);
  });

  test('TUI-HIDE-ROUTING-NOTICE — production route decision is logged but absent from the rendered turn', async () => {
    let coreContext: CoreTurnContext | undefined;
    spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
      coreContext = ctx;
      return { stopReason: 'end_turn', finalText: '' };
    });
    const routeLog = spyOn(debug, 'log');
    const pushes: string[] = [];
    const turn = bridgeCoreTurnToAcp({ tuiRouting: true, getMessages: () => [], getTools: () => [], dispatchTool: async () => ({}) });
    await turn({
      sessionId: 'ux-sim-route', cwd: '/tmp', userText: '나한테 온 결정 카드 있어?',
      promptBlocks: [{ type: 'text', text: '나한테 온 결정 카드 있어?' }], isAborted: () => false,
      push: async (delta: string) => { pushes.push(delta); }, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
      pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    } as unknown as AcpTurnContext);
    coreContext?.callbacks?.onText?.('결정 카드가 없습니다.', '결정 카드가 없습니다.');
    const frame = simRenderLogFrame({ phase: 'streaming', lines: pushes });

    expect(routeLog).toHaveBeenCalledWith('core-turn.route', 'decided', expect.objectContaining({ route: '조회', goalLoop: false }));
    expect(pushes).toEqual(['결정 카드가 없습니다.']);
    expect(frame.text).toContain('결정 카드가 없습니다.');
    expect(frame.text).not.toContain('라우팅:');
  });
});
