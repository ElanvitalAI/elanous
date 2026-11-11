/**
 * 🅢 70차 — 표면 판정 입력이 «라운드가 돌아도» 이 턴의 사람 문장으로 남는지.
 *
 * ⛔ 왜 이 시험이 필요한가: `runGoalLoop` 은 라운드 사이에 «기계가 쓴» user 메시지를
 *   여섯 자리에서 밀어 넣는다(증거 요구 · 계속 진행 · 리드백 · 재시도 둘). 그래서
 *   `runCoreTurn` 이 매 라운드 「마지막 user 메시지」를 다시 읽으면 2라운드부터
 *   표면이 «기계 문장»으로 갈린다. 루프 진입 시 한 번 정해 인자로 내리는지를 문다.
 *
 * ⚠️ 이 시험은 `runTurn` seam 을 주입해 LLM·툴 디스패치를 «건드리지 않는다».
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { clearPendingUserInput, drainPendingUserInput } from '../session/pending-input.js';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import { runGoalLoop } from './run-goal-loop.js';

const originalLog = debug.log;

afterEach(() => {
  mock.restore();
  debug.log = originalLog;
});

const HUMAN = '웹에서 최신 뉴스 검색해줘';

function baseCtx(overrides: Partial<CoreTurnContext> = {}): CoreTurnContext {
  return {
    sessionId: 'goal-loop-surface-input',
    messages: [{ role: 'user', content: HUMAN }],
    tools: [],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
    ...overrides,
  } as CoreTurnContext;
}

/** 라운드마다 ctx.userText 를 기록한다.
 *  ⭐ 텍스트 마커로만 완료를 주장하면 루프가 «리드백 게이트»를 걸어 기계 메시지를 밀어 넣고 한 번 더 돈다
 *  — 그래야 「2라운드 이후에도 사람 문장이 남는가」를 실제로 물 수 있다. */
function recordingRunTurn(seen: (string | undefined)[]): (ctx: CoreTurnContext) => Promise<CoreTurnResult> {
  return async (ctx) => {
    seen.push(ctx.userText);
    return { stopReason: 'end_turn', finalText: 'GOAL-COMPLETE' };
  };
}

describe('runGoalLoop — 표면 판정 입력(userText)', () => {
  test('[pinned-across-rounds] 기계 메시지가 라운드마다 붙어도 «사람 문장»이 그대로 내려간다', async () => {
    const seen: (string | undefined)[] = [];
    await runGoalLoop(baseCtx(), { maxIterations: 3, runTurn: recordingRunTurn(seen) });

    expect(seen.length).toBeGreaterThan(1);           // 실제로 여러 라운드가 돌았다
    for (const value of seen) expect(value).toBe(HUMAN); // ⛔ 어느 라운드도 기계 문장으로 안 바뀐다
  });

  test('[carrier-wins] 운반자가 이미 있으면 그 값이 이긴다', async () => {
    const seen: (string | undefined)[] = [];
    await runGoalLoop(
      baseCtx({ userText: 'carrier prompt', messages: [{ role: 'user', content: 'stale message text' }] }),
      { maxIterations: 2, runTurn: recordingRunTurn(seen) },
    );

    expect(seen.length).toBeGreaterThan(0); // ⛔ 「한 번도 안 불렸다」로 공허하게 통과하지 않게
    for (const value of seen) expect(value).toBe('carrier prompt');
  });

  test('[no-human-no-value] 사람 문장이 없으면 «빈 값»이고 기계 문장으로 대체되지 않는다', async () => {
    const seen: (string | undefined)[] = [];
    await runGoalLoop(
      baseCtx({ messages: [{ role: 'assistant', content: 'no human turn here' }] }),
      { maxIterations: 2, runTurn: recordingRunTurn(seen) },
    );

    expect(seen.length).toBeGreaterThan(0); // ⛔ 공허한 통과 방지
    for (const value of seen) expect(value).toBeUndefined();
  });

  test('[tool-boundary-supervisor-memo] 도구 결과 뒤 감독 메모는 실제 pending-input 소비 경로로 다음 요청에 한 번만 전달되고 관측한다', async () => {
    const sessionId = 'goal-loop-tool-boundary-memo';
    const memo = 'inspect the failing check';
    const observations: Array<{ event: string; data: Record<string, unknown> }> = [];
    let memoAvailable = false;
    const nextModelRequests: string[][] = [];

    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'goal.loop') observations.push({ event, data: data as Record<string, unknown> });
    });

    try {
      await runGoalLoop(baseCtx({ sessionId }), {
        maxIterations: 1,
        controlSpaceId: 'surface-input-test',
        drainControlInbox: () => {
          if (!memoAvailable) return { stop: false, count: 0, memos: [] };
          memoAvailable = false;
          return { stop: false, count: 1, memos: [memo] };
        },
        runTurn: async (ctx) => {
          memoAvailable = true;
          ctx.callbacks?.onToolResult?.({ id: 'call-1', name: 'read_file', result: {} });
          nextModelRequests.push(drainPendingUserInput(ctx.sessionId!));
          return { stopReason: 'end_turn', finalText: 'done' };
        },
      });

      expect(nextModelRequests).toEqual([[memo]]);
      expect(drainPendingUserInput(sessionId)).toEqual([]);
      expect(observations.filter(({ event }) => event === 'control-memo-after-tool-result')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ sessionId, memoCount: 1 }) }),
      ]);
    } finally {
      clearPendingUserInput(sessionId);
    }
  });

  test('[tool-boundary-stop] 메모 배수와 soft-stop은 같은 drain 결과를 함께 처리한다', async () => {
    const sessionId = 'goal-loop-tool-boundary-stop';
    let fullDrains = 0;
    let softStopDrains = 0;

    try {
      const result = await runGoalLoop(baseCtx({ sessionId }), {
        maxIterations: 1,
        controlSpaceId: 'surface-input-stop-test',
        drainControlInbox: () => {
          fullDrains += 1;
          return fullDrains === 2
            ? { stop: true, count: 2, memos: ['preserve the stop'] }
            : { stop: false, count: 0, memos: [] };
        },
        drainSoftStopControlInbox: () => {
          softStopDrains += 1;
          return { stop: false, count: 0, memos: [] };
        },
        runTurn: async (ctx) => {
          if (fullDrains === 1) {
            ctx.callbacks?.onToolResult?.({ id: 'call-1', name: 'read_file', result: {} });
          }
          return { stopReason: 'aborted', finalText: 'done' };
        },
      });

      expect(fullDrains).toBe(2);
      // soft-stop drain runs once per loop iteration (iteration count × 1).
      expect(softStopDrains).toBe(2);
      // An aborted turn must not bypass the stop latch (run-goal-loop.ts comment).
      expect(result.stopReason).toBe('aborted');
      expect(drainPendingUserInput(sessionId)).toEqual(['preserve the stop']);
    } finally {
      clearPendingUserInput(sessionId);
    }
  });

  test('[tool-boundary-accepted-completion-stop] accepted completion after a tool result opens the soft-stop latch', async () => {
    let fullDrains = 0;
    let softStopDrains = 0;

    const result = await runGoalLoop(baseCtx({ sessionId: 'goal-loop-tool-boundary-accepted-completion-stop' }), {
      maxIterations: 1,
      controlSpaceId: 'surface-input-accepted-completion-stop-test',
      drainControlInbox: () => {
        fullDrains += 1;
        return { stop: false, count: 0, memos: [] };
      },
      drainSoftStopControlInbox: () => {
        softStopDrains += 1;
        return softStopDrains === 2
          ? { stop: true, count: 1, memos: [] }
          : { stop: false, count: 0, memos: [] };
      },
      runTurn: async (ctx) => {
        ctx.callbacks?.onToolResult?.({ id: 'complete-1', name: 'read_file', result: {} });
        ctx.callbacks?.onTurnComplete?.([{
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'complete-1', name: 'read_file', input: {} }],
        }]);
        return { stopReason: 'end_turn', finalText: 'done' };
      },
    });

    expect(fullDrains).toBe(1);
    expect(softStopDrains).toBe(2);
    expect(result.stopReason).toBe('soft_stop');
  });

  test('[tool-boundary-no-session] sessionId가 없으면 메모를 보존하고 후속 세션의 다음 요청에 한 번만 전달한다', async () => {
    const memo = 'this must survive until a session exists';
    const observations: string[] = [];
    let fullDrains = 0;
    let softStopDrains = 0;
    let memoAvailable = false;
    let memoPreserved = true;
    const nextModelRequests: string[][] = [];
    const drainControlInbox = () => {
      fullDrains += 1;
      if (!memoAvailable || !memoPreserved) return { stop: false, count: 0, memos: [] };
      memoPreserved = false;
      return { stop: false, count: 1, memos: [memo] };
    };
    const drainSoftStopControlInbox = () => {
      softStopDrains += 1;
      return { stop: false, count: 0, memos: [] };
    };
    debug.log = ((category: string, event: string) => {
      if (category === 'goal.loop') observations.push(event);
    }) as typeof debug.log;

    await runGoalLoop(baseCtx({ sessionId: undefined }), {
      maxIterations: 1,
      controlSpaceId: 'surface-input-no-session-test',
      drainControlInbox,
      drainSoftStopControlInbox,
      runTurn: async (ctx) => {
        ctx.callbacks?.onToolResult?.({ id: 'call-1', name: 'read_file', result: {} });
        return { stopReason: 'end_turn', finalText: 'done' };
      },
    });

    expect(fullDrains).toBe(0);
    expect(softStopDrains).toBe(2);
    expect(memoPreserved).toBe(true);

    const sessionId = 'goal-loop-session-after-preservation';
    try {
      await runGoalLoop(baseCtx({ sessionId }), {
        maxIterations: 1,
        controlSpaceId: 'surface-input-no-session-test',
        drainControlInbox,
        drainSoftStopControlInbox,
        runTurn: async (ctx) => {
          memoAvailable = true;
          ctx.callbacks?.onToolResult?.({ id: 'call-2', name: 'read_file', result: {} });
          nextModelRequests.push(drainPendingUserInput(ctx.sessionId!));
          return { stopReason: 'end_turn', finalText: 'done' };
        },
      });

      expect(fullDrains).toBe(2);
      // Each of the two maxIterations: 1 executions drains at entry and after its tool result (2 × 2 = 4).
      expect(softStopDrains).toBe(4);
      expect(nextModelRequests).toEqual([[memo]]);
      expect(observations.filter((event) => event === 'control-memo-after-tool-result')).toHaveLength(1);
    } finally {
      clearPendingUserInput(sessionId);
    }
  });
});
