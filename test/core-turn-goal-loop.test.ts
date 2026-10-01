// Tier 2 · across-turn goal-loop 코어 단위 테스트 (2026-07-19 goal-exec · 정제).
// runCoreTurn 을 opts.runTurn seam 으로 주입 — 모듈 mock 오염 회피(AGENTS.md).
//
// 정제(2026-07-19): 완료 신호가 텍스트 마커 → 구조화 도구 update_goal(complete)+evidence 로
// 승격. 마커는 deprecated fallback(read-back 게이트)로만 감지. context-pressure bail 추가.

import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGoalLoop,
  resetGoalLoopLifecycleBridgeForTesting,
  GOAL_COMPLETE_MARKER,
  GOAL_BLOCKED_MARKER,
  UPDATE_GOAL_TOOL_NAME,
  buildUpdateGoalToolSpec,
} from '../src/core-turn/run-goal-loop.js';
import type { GoalLoopResult } from '../src/core-turn/run-goal-loop.js';
import type { CoreTurnContext, CoreTurnResult } from '../src/core-turn/types.js';
import {
  buildToolLoopPhaseRejectionMessage,
  getToolLoopPhaseRejectedTools,
} from '../src/llm.js';
import type { LLMMessage } from '../src/llm.js';
import { debug } from '../src/debug/log.js';
import { getChannelBus, resetTerminalMatrix } from '../src/terminal-matrix/index.js';
import { publishLifecycleRecord, snapshotRunLifecycle, subscribeRunLifecycle, validateLifecycleRecord } from '../src/signal/lifecycle-record.js';
import { readRunLifecycle, resetLifecycleBridgeForTesting } from '../src/signal/lifecycle-bridge.js';
import { controlInboxPath, drainControlInbox, drainSoftStopControlInbox, enqueueControlMemo, enqueueSoftStop } from '../src/harness/control-inbox.js';

describe('getToolLoopPhaseRejectedTools', () => {
  it('canonical rejection stub만 rejected tool names로 판정한다', () => {
    expect(getToolLoopPhaseRejectedTools(
      buildToolLoopPhaseRejectionMessage('verify-action', ['Write', 'Bash'], 0),
    )).toEqual(['Write', 'Bash']);
    expect(getToolLoopPhaseRejectedTools('normal tool result')).toBeNull();
    expect(getToolLoopPhaseRejectedTools('')).toBeNull();
    expect(getToolLoopPhaseRejectedTools('The marker TOOL CALL REJECTED — Write did NOT run. is only quoted prose.')).toBeNull();
  });
});

// ⭐ 2026-09-25: `debug.log` 가 `ELANOUS_HOST_ID` 를 `hostId` 로 자동 부착한다(#20468) — 앞 파일이 남긴 env 가
//   관측 payload `toEqual` 을 깨지 않게 이 파일 동안 비우고 되돌린다.
let priorHostId: string | undefined;
beforeEach(() => {
  priorHostId = process.env.ELANOUS_HOST_ID;
  delete process.env.ELANOUS_HOST_ID;
});

afterEach(() => {
  resetGoalLoopLifecycleBridgeForTesting();
  if (priorHostId === undefined) delete process.env.ELANOUS_HOST_ID;
  else process.env.ELANOUS_HOST_ID = priorHostId;
});

function baseCtx(userText: string): CoreTurnContext {
  return {
    sessionId: 't',
    messages: [{ role: 'user', content: userText }],
    tools: [],
    dispatchTool: async () => ({}),
    signal: new AbortController().signal,
  };
}

// tool_use 블록을 가진 assistant 메시지 — hadToolActivity=true 유발.
const toolTurn: LLMMessage[] = [
  { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Read', input: {} }] as any },
];

// update_goal(status, evidence) 도구 호출을 담은 assistant 메시지 — 구조화 종결 신호.
function updateGoalTurn(status: 'complete' | 'blocked', evidence: string, reason?: string): LLMMessage[] {
  return [{
    role: 'assistant',
    content: [{
      type: 'tool_use', id: 'ug', name: UPDATE_GOAL_TOOL_NAME,
      input: { status, evidence, ...(reason ? { reason } : {}) },
    }] as any,
  }];
}

function completeWithRejectedToolTurn(rejectedTools: string[]): LLMMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'write-1', name: rejectedTools[0] ?? 'Write', input: {},
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'write-1',
        content: buildToolLoopPhaseRejectionMessage('verify-action', rejectedTools, 0),
        isError: true,
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'ug', name: UPDATE_GOAL_TOOL_NAME,
        input: { status: 'complete', evidence: 'claimed file and tests' },
      }],
    },
  ];
}

describe('runGoalLoop — across-turn 목표 실행 (구조화 완료)', () => {
  it('update_goal(complete)+evidence 까지 반복 후 완료한다', async () => {
    let call = 0;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      call += 1;
      if (call < 3) {
        ctx.callbacks?.onTurnComplete?.(toolTurn);
        return { stopReason: 'end_turn', finalText: 'working...' };
      }
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '파일 X 생성 + bun test 통과 확인'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const r = await runGoalLoop(baseCtx('build X'), { runTurn });
    expect(r.stopReason).toBe('goal_complete');
    expect(r.goalComplete).toBe(true);
    expect(r.iterations).toBe(3);
  });

  for (const surface of ['running-harness', 'running-tui']) {
    it(`외부 stop을 ${surface}의 현재 iteration 뒤 drain하고 다음 iteration에는 진입하지 않는다`, async () => {
      const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-soft-stop-'));
      const observed: Array<{ event: string; stop?: unknown }> = [];
      let calls = 0;
      try {
        const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
          calls += 1;
          enqueueSoftStop(surface, {
            env: { ELANOUS_STATE_DIR: isolated },
            log: (_category, event, data) => observed.push({ event, stop: data.stop }),
          });
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: 'current iteration finished' };
        };
        const r = await runGoalLoop(baseCtx('build X'), {
          runTurn,
          controlSpaceId: surface,
          drainControlInbox: (spaceId) => drainControlInbox(spaceId, {
            env: { ELANOUS_STATE_DIR: isolated },
            log: (_category, event, data) => observed.push({ event, stop: data.stop }),
          }),
          drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, {
            env: { ELANOUS_STATE_DIR: isolated },
            log: (_category, event, data) => observed.push({ event, stop: data.stop }),
          }),
        });

        expect(calls).toBe(1);
        expect(r).toEqual({
          finalText: 'current iteration finished', iterations: 1, stopReason: 'soft_stop', goalComplete: false,
        });
        // ⭐ drain 은 **iteration 진입 직전**에 돈다(리뷰 must-fix) — 그래서 첫 진입의 빈 drain 이
        //    앞에 하나 더 있고, stop 은 **두 번째 진입**에서 잡혀 재진입만 막는다.
        expect(observed).toEqual([
          { event: 'soft-stop-drain', stop: false },
          { event: 'drain', stop: false },
          { event: 'stop-enqueue', stop: undefined },
          { event: 'soft-stop-request-written', stop: undefined },
          { event: 'soft-stop-drain', stop: true },
        ]);
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    });
  }

  it('첫 tool result 뒤 stop만 소비해 같은 turn의 두 번째 tool result를 막고 memo를 보존한다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-post-tool-stop-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    const forwarded: string[] = [];
    const records: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'goal-loop-post-tool-stop-test',
      emit: (record) => {
        if (record.category === 'goal.loop') records.push({ event: record.event, data: record.data });
      },
    });
    const ctx = baseCtx('build X');
    ctx.callbacks = { onToolResult: (call) => forwarded.push(call.name) };
    try {
      const result = await runGoalLoop(ctx, {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async (turnCtx) => {
          enqueueControlMemo('running-harness', 'next turn memo', io);
          enqueueSoftStop('running-harness', io);
          turnCtx.callbacks?.onToolResult?.({ id: 'first', name: 'Read', result: 'first result' });
          if (!turnCtx.signal.aborted) {
            turnCtx.callbacks?.onToolResult?.({ id: 'second', name: 'Write', result: 'second result' });
            throw new Error('second tool result was not stopped');
          }
          return { stopReason: 'aborted', finalText: 'stopped after first result' };
        },
      });

      expect(result).toEqual({ finalText: 'stopped after first result', iterations: 1, stopReason: 'soft_stop', goalComplete: false });
      expect(forwarded).toEqual(['Read']);
      expect(drainControlInbox('running-harness', io).memos).toEqual(['next turn memo']);
      expect(records.find((record) => record.event === 'soft-stop-after-tool-result')?.data).toMatchObject({
        iterations: 1, spaceId: 'running-harness',
      });
      expect(records.some((record) => record.event === 'soft-stop')).toBe(false);
    } finally {
      off?.();
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('same tool result batch의 update_goal(complete)는 post-tool stop보다 우선한다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-post-tool-stop-complete-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    const forwarded: string[] = [];
    const ctx = baseCtx('build X');
    ctx.callbacks = { onToolResult: (call) => forwarded.push(call.name) };
    try {
      const result = await runGoalLoop(ctx, {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async (turnCtx) => {
          enqueueSoftStop('running-harness', io);
          turnCtx.callbacks?.onToolResult?.({ id: 'complete', name: UPDATE_GOAL_TOOL_NAME, result: { ok: true } });
          turnCtx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'completion evidence'));
          return { stopReason: 'aborted', finalText: 'completed before stop' };
        },
      });

      expect(result).toEqual({ finalText: 'completed before stop', iterations: 1, stopReason: 'goal_complete', goalComplete: true });
      expect(forwarded).toEqual([UPDATE_GOAL_TOOL_NAME]);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('불완전 update_goal과 deprecated 완료 마커가 있어도 post-tool stop 뒤 다음 turn으로 진행하지 않는다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-post-tool-stop-incomplete-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    let calls = 0;
    try {
      const result = await runGoalLoop(baseCtx('build X'), {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async (turnCtx) => {
          calls += 1;
          enqueueSoftStop('running-harness', io);
          turnCtx.callbacks?.onToolResult?.({ id: 'incomplete', name: UPDATE_GOAL_TOOL_NAME, result: { ok: true } });
          turnCtx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', ''));
          return { stopReason: 'end_turn', finalText: GOAL_COMPLETE_MARKER };
        },
      });

      expect(result).toEqual({ finalText: GOAL_COMPLETE_MARKER, iterations: 1, stopReason: 'soft_stop', goalComplete: false });
      expect(calls).toBe(1);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  for (const stopReason of ['aborted', 'error', 'auth_rejected'] as const) {
    it(`불완전 update_goal은 ${stopReason} terminal 결과를 다음 turn으로 숨기지 않는다`, async () => {
      let calls = 0;
      const result = await runGoalLoop(baseCtx('build X'), {
        runTurn: async (turnCtx) => {
          calls += 1;
          turnCtx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', ''));
          return { stopReason, finalText: `${stopReason} result` };
        },
      });

      expect(result).toEqual({ finalText: `${stopReason} result`, iterations: 1, stopReason, goalComplete: false });
      expect(calls).toBe(1);
    });
  }

  it('stop signal이 없으면 tool result callback과 turn 수를 그대로 유지한다', async () => {
    const forwarded: string[] = [];
    let calls = 0;
    const ctx = baseCtx('build X');
    ctx.callbacks = { onToolResult: (call) => forwarded.push(call.name) };
    const result = await runGoalLoop(ctx, {
      controlSpaceId: 'running-harness',
      drainControlInbox: () => ({ stop: false, count: 0 }),
      drainSoftStopControlInbox: () => ({ stop: false, count: 0 }),
      runTurn: async (turnCtx) => {
        calls += 1;
        turnCtx.callbacks?.onToolResult?.({ id: 'first', name: 'Read', result: 'first result' });
        turnCtx.callbacks?.onToolResult?.({ id: 'second', name: 'Write', result: 'second result' });
        turnCtx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'evidence'));
        return { stopReason: 'end_turn', finalText: 'done' };
      },
    });

    expect(result.stopReason).toBe('goal_complete');
    expect(calls).toBe(1);
    expect(forwarded).toEqual(['Read', 'Write']);
  });

  it('preserves the caller abort reason on the per-turn signal', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled this goal loop');
    const ctx = baseCtx('build X');
    ctx.signal = controller.signal;
    let observedSignal: AbortSignal | undefined;
    const pending = runGoalLoop(ctx, {
      runTurn: async (turnCtx) => {
        observedSignal = turnCtx.signal;
        await new Promise<void>((resolve) => turnCtx.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { stopReason: 'aborted', finalText: 'cancelled' };
      },
    });

    controller.abort(reason);
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(reason);
    expect(result).toMatchObject({ iterations: 1, stopReason: 'aborted' });
  });

  it('releases each caller abort listener after a no-signal iteration', async () => {
    const controller = new AbortController();
    const ctx = baseCtx('build X');
    ctx.signal = controller.signal;
    const remove = spyOn(controller.signal, 'removeEventListener');

    const result = await runGoalLoop(ctx, {
      maxIterations: 2,
      runTurn: async (turnCtx) => {
        turnCtx.callbacks?.onTurnComplete?.(toolTurn);
        return { stopReason: 'end_turn', finalText: 'continue' };
      },
    });

    expect(result).toMatchObject({ iterations: 2, stopReason: 'max_iterations' });
    expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(2);
  });

  // ⭐ 리뷰 must-fix 회귀(2026-07-30) — 종전 코드는 drain 을 turn 직후에 둬서 **같은 iteration 의
  //    완료 판정을 soft_stop 으로 덮고** `goalComplete:false` 를 반환했다. 골이 끝난 iteration 에서
  //    stop 을 만나면 완료가 사라지는 버그였다.
  it('stop 이 걸린 iteration 에서 목표가 완료되면 goal_complete 가 이긴다 (soft_stop 이 덮지 않는다)', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-stop-vs-complete-'));
    let calls = 0;
    try {
      const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
        calls += 1;
        // 같은 iteration 안에서 외부 stop 이 들어오고, 그 turn 이 목표를 완료 선언한다.
        enqueueSoftStop('running-harness', { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} });
        ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'claimed file and tests'));
        return { stopReason: 'end_turn', finalText: 'done' };
      };
      const r = await runGoalLoop(baseCtx('build X'), {
        runTurn,
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} }),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} }),
        changedFiles: () => ['src/x.ts'],
      });

      expect(calls).toBe(1);
      expect(r.stopReason).toBe('goal_complete');
      expect(r.goalComplete).toBe(true);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  // ⭐ 같은 must-fix 의 다른 절반 — 완료가 아니면 stop 이 재진입을 막는지도 고정한다(위 for 루프가
  //    그것을 보지만, 여기서는 **turn 이 두 번 불리지 않는다**를 완료 케이스와 나란히 둔다).
  it('stop 이 걸리면 완료가 아닌 iteration 뒤에는 재진입하지 않는다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-stop-blocks-reentry-'));
    let calls = 0;
    try {
      const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
        calls += 1;
        enqueueSoftStop('running-harness', { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} });
        ctx.callbacks?.onTurnComplete?.(toolTurn);
        return { stopReason: 'end_turn', finalText: `turn ${calls}` };
      };
      const r = await runGoalLoop(baseCtx('build X'), {
        runTurn,
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} }),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} }),
      });

      expect(calls).toBe(1);
      expect(r.stopReason).toBe('soft_stop');
      expect(r.goalComplete).toBe(false);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('iteration entry에서 stop과 같이 소비된 감독 메모를 관측에 남기고 재진입하지 않는다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-stop-with-control-memo-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    const records: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'goal-loop-stop-with-control-memo-test',
      emit: (record) => {
        if (record.category === 'goal.loop') records.push({ event: record.event, data: record.data });
      },
    });
    let calls = 0;
    try {
      enqueueControlMemo('running-harness', 'memo preserved in stop observation', io);
      enqueueSoftStop('running-harness', io);

      const result = await runGoalLoop(baseCtx('build X'), {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async () => {
          calls += 1;
          return { stopReason: 'end_turn', finalText: `turn ${calls}` };
        },
      });

      expect(result.stopReason).toBe('soft_stop');
      expect(result.goalComplete).toBe(false);
      expect(calls).toBe(0);
      const survived = drainControlInbox('running-harness', io);
      expect(survived.memos).toEqual(['memo preserved in stop observation']);
      expect(survived.stop).toBe(false);
      expect(records.find((record) => record.event === 'soft-stop-with-control-memo')?.data).toMatchObject({
        iterations: 0,
        spaceId: 'running-harness',
        drained: 1,
        memoCount: 1,
        memos: ['memo preserved in stop observation'],
        receivedCount: 1,
      });
    } finally {
      off?.();
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('런 시작 전 soft stop과 함께 온 감독 메모는 다음 런에 한 번만 배달된다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-entry-stop-memo-survival-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    const seenByRun: string[][] = [];
    try {
      enqueueControlMemo('running-harness', 'memo for next run only', io);
      enqueueSoftStop('running-harness', io);

      const first = await runGoalLoop(baseCtx('first run'), {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async () => {
          throw new Error('first run must stop before entering runTurn');
        },
      });

      const second = await runGoalLoop(baseCtx('second run'), {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async (ctx) => {
          const tail = ctx.messages[ctx.messages.length - 1];
          seenByRun.push([typeof tail?.content === 'string' ? tail.content : '']);
          return { stopReason: 'end_turn', finalText: 'second run saw memo' };
        },
        maxIterations: 1,
      });

      const third = await runGoalLoop(baseCtx('third run'), {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async (ctx) => {
          const tail = ctx.messages[ctx.messages.length - 1];
          seenByRun.push([typeof tail?.content === 'string' ? tail.content : '']);
          return { stopReason: 'end_turn', finalText: 'third run did not see memo' };
        },
        maxIterations: 1,
      });

      expect(first).toEqual({ finalText: '', iterations: 0, stopReason: 'soft_stop', goalComplete: false });
      expect(second.stopReason).toBe('end_turn');
      expect(third.stopReason).toBe('end_turn');
      expect(seenByRun[0]?.[0]).toContain('- memo for next run only');
      expect(seenByRun[1]?.[0]).not.toContain('memo for next run only');
      expect(drainControlInbox('running-harness', io)).toMatchObject({ stop: false, memos: [] });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('iteration entry에서 stop-only drain 뒤 full drain이 stop과 memo를 함께 보면 soft_stop으로 끝내고 memo를 복구한다', async () => {
    const restored: string[] = [];
    let calls = 0;
    const result = await runGoalLoop(baseCtx('racing stop'), {
      controlSpaceId: 'running-harness',
      drainSoftStopControlInbox: () => ({ stop: false, count: 0, memos: [], memoEntries: [], receivedCount: 0 }),
      drainControlInbox: () => ({
        stop: true,
        count: 2,
        memos: ['racing memo survives'],
        memoEntries: [{ body: 'racing memo survives' }],
        receivedCount: 1,
      }),
      enqueueControlMemo: (_spaceId, memo) => {
        restored.push(typeof memo === 'string' ? memo : memo.body);
      },
      runTurn: async () => {
        calls += 1;
        throw new Error('runTurn must not run after racing stop');
      },
    });

    expect(result).toEqual({ finalText: '', iterations: 0, stopReason: 'soft_stop', goalComplete: false });
    expect(calls).toBe(0);
    expect(restored).toEqual(['racing memo survives']);
  });

  // ⭐ 감독 메모 — 부모가 «도는 자식»에게 보낸 한 줄이 다음 turn 의 요청문에 «덧붙는다».
  //   ⛔ 「대체」가 아니라 「덧붙임」임을 고정한다 — 독립 user 메시지로 밀어 넣으면 그것이
  //     「가장 최신 요청」이 되어 계획을 밀어낸다(그 형태가 앞선 시도를 죽였다).
  it('감독 메모가 이어가기 문구를 «대체하지 않고» 실린 순서대로 덧붙는다', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-control-memo-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    const seen: string[] = [];
    let calls = 0;
    try {
      const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
        calls += 1;
        const tail = ctx.messages[ctx.messages.length - 1];
        seen.push(typeof tail?.content === 'string' ? tail.content : '');
        if (calls === 1) {
          enqueueControlMemo('running-harness', 'first memo', io);
          enqueueControlMemo('running-harness', 'second memo', io);
        } else {
          enqueueSoftStop('running-harness', io);
        }
        ctx.callbacks?.onTurnComplete?.(toolTurn);
        return { stopReason: 'end_turn', finalText: `turn ${calls}` };
      };
      const r = await runGoalLoop(baseCtx('build X'), {
        runTurn,
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
      });

      expect(calls).toBe(2);
      expect(r.stopReason).toBe('soft_stop');
      // ⓐ 첫 turn 은 메모가 «없다» — 종전과 같은 요청문
      expect(seen[0]).not.toContain('감독 메모');
      // ⓑ 둘째 turn 에 메모가 붙었고, ***이어가기 문구가 남아 있다***(대체가 아니다)
      expect(seen[1]).toContain('감독 메모');
      expect(seen[1]).toContain('- first memo');
      expect(seen[1]).toContain('- second memo');
      expect(seen[1]).toContain('[continue]');
      // ⓒ 실린 «순서»가 보존된다
      expect(seen[1].indexOf('- first memo')).toBeLessThan(seen[1].indexOf('- second memo'));
      // ⓓ 이어가기 문구가 메모 «앞»에 있다 — 덧붙임이지 앞지르기가 아니다
      expect(seen[1].indexOf('[continue]')).toBeLessThan(seen[1].indexOf('감독 메모'));
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('urgent structured memos precede normal and legacy memos after continuation and expose intake counts', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'goal-loop-structured-control-memo-'));
    const io = { env: { ELANOUS_STATE_DIR: isolated }, log: () => {} };
    const seen: string[] = [];
    const records: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'goal-loop-structured-control-memo-test',
      emit: (record) => {
        if (record.category === 'goal.loop') records.push({ event: record.event, data: record.data });
      },
    });
    let calls = 0;
    try {
      const result = await runGoalLoop(baseCtx('build X'), {
        controlSpaceId: 'running-harness',
        drainControlInbox: (spaceId) => drainControlInbox(spaceId, io),
        drainSoftStopControlInbox: (spaceId) => drainSoftStopControlInbox(spaceId, io),
        runTurn: async (ctx) => {
          calls += 1;
          const tail = ctx.messages[ctx.messages.length - 1];
          seen.push(typeof tail?.content === 'string' ? tail.content : '');
          if (calls === 1) {
            enqueueControlMemo('running-harness', { version: 1, kind: 'review', urgency: 'normal', body: 'normal memo' }, io);
            enqueueControlMemo('running-harness', 'legacy memo', io);
            enqueueControlMemo('running-harness', { version: 1, kind: 'stop-risk', urgency: 'urgent', body: 'urgent memo' }, io);
            const ready = `${controlInboxPath('running-harness', io.env)}.ready`;
            writeFileSync(join(ready, 'record-ffffffffffffffff-00000000-0000-0000-0000-000000000001'), 'memo:CONTROL_MEMO_FRAME:not-base64\\n', 'utf8');
          } else enqueueSoftStop('running-harness', io);
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: `turn ${calls}` };
        },
      });

      expect(result.stopReason).toBe('soft_stop');
      expect(seen[1]).toContain('[continue]');
      expect(seen[1].indexOf('[continue]')).toBeLessThan(seen[1].indexOf('감독 메모'));
      expect(seen[1]).toContain('- urgent memo');
      expect(seen[1]).toContain('- normal memo');
      expect(seen[1]).toContain('- legacy memo');
      expect(seen[1].indexOf('- urgent memo')).toBeLessThan(seen[1].indexOf('- normal memo'));
      expect(seen[1].indexOf('- normal memo')).toBeLessThan(seen[1].indexOf('- legacy memo'));
      const observation = records.find((record) => record.event === 'control-memo');
      expect(observation?.data).toMatchObject({ receivedCount: 4, urgentCount: 1, malformedFallbackCount: 1 });
    } finally {
      off?.();
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('caller-side dispatch records the selected tool while forwarding its arguments and result', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    let off: (() => void) | undefined;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-dispatch';
    try {
      off = debug.registerSink({
        name: 'goal-loop-dispatch-test',
        emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }),
      });
      const ctx = baseCtx('dispatch once');
      const dispatchPromise = Promise.resolve({ forwarded: true });
      ctx.dispatchTool = (name, args, dctx) => {
        expect(name).toBe('Read');
        expect(args).toEqual({ path: 'x.ts' });
        expect(dctx).toEqual({ callId: 'goal-dispatch-1' });
        return dispatchPromise;
      };
      await runGoalLoop(ctx, {
        runTurn: async (turnCtx) => {
          const forwarded = turnCtx.dispatchTool('Read', { path: 'x.ts' }, { callId: 'goal-dispatch-1' });
          expect(forwarded).toBe(dispatchPromise);
          await expect(forwarded).resolves.toEqual({ forwarded: true });
          return { stopReason: 'end_turn', finalText: 'done' };
        },
      });
    } finally {
      off?.();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
    }

    expect(records).toContainEqual(expect.objectContaining({
      category: 'goal.loop', event: 'dispatch',
      data: expect.objectContaining({ sessionId: 't', runId: expect.any(String), iteration: 1, tool: 'Read', dispatchCount: 1 }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      category: 'goal.loop', event: 'iteration',
      data: expect.objectContaining({ dispatchCount: 1 }),
    }));
  });

  it('iteration records dispatchCount zero when the model selects no tools', async () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'goal-loop-zero-dispatch-test',
      emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      await runGoalLoop(baseCtx('no tool'), {
        runTurn: async () => ({ stopReason: 'end_turn', finalText: 'done' }),
      });
    } finally {
      off?.();
    }

    expect(records).toContainEqual(expect.objectContaining({
      category: 'goal.loop', event: 'iteration',
      data: expect.objectContaining({ dispatchCount: 0 }),
    }));
    expect(records.some((record) => record.category === 'goal.loop' && record.event === 'dispatch')).toBe(false);
  });

  it('caller-side observation failure does not prevent goal-loop dispatch', async () => {
    const ctx = baseCtx('fail open');
    let dispatched = false;
    ctx.dispatchTool = async () => { dispatched = true; return { ok: true }; };
    const originalLog = debug.log.bind(debug);
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, ...rest: unknown[]) => {
      if (category === 'goal.loop' && event === 'dispatch') throw new Error('sink unavailable');
      return originalLog(category, event, ...(rest as [Record<string, unknown>, { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' } | undefined]));
    }) as typeof debug.log);
    try {
      await runGoalLoop(ctx, {
        runTurn: async (turnCtx) => {
          await turnCtx.dispatchTool('Read', {}, { callId: 'goal-fail-open' });
          return { stopReason: 'end_turn', finalText: 'done' };
        },
      });
    } finally {
      log.mockRestore();
    }
    expect(dispatched).toBe(true);
  });

  it('update_goal 도구를 매 턴 catalog 에 주입한다', async () => {
    let sawTool = false;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      sawTool = ctx.tools.some((t) => t.name === UPDATE_GOAL_TOOL_NAME);
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '증거 있음'));
      return { stopReason: 'end_turn', finalText: 'x' };
    };
    await runGoalLoop(baseCtx('goal'), { runTurn });
    expect(sawTool).toBe(true);
  });

  it('update_goal dispatch 는 실 dispatcher 로 새지 않고 관측·집계한 뒤 ack 를 돌려준다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    let off: (() => void) | undefined;
    let leaked = false;
    let acked: unknown;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-update-goal-dispatch';
    try {
      off = debug.registerSink({
        name: 'goal-loop-update-goal-dispatch-test',
        emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }),
      });
      const ctx = baseCtx('goal');
      ctx.dispatchTool = async (name) => { if (name === UPDATE_GOAL_TOOL_NAME) leaked = true; return {}; };
      const runTurn = async (c: CoreTurnContext): Promise<CoreTurnResult> => {
        acked = await c.dispatchTool(UPDATE_GOAL_TOOL_NAME, { status: 'complete', evidence: 'e' });
        c.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'e'));
        return { stopReason: 'end_turn', finalText: 'x' };
      };
      await runGoalLoop(ctx, { runTurn });
    } finally {
      off?.();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
    }
    expect(leaked).toBe(false);
    expect((acked as { ok?: boolean }).ok).toBe(true);
    expect(records).toContainEqual(expect.objectContaining({
      category: 'goal.loop', event: 'dispatch',
      data: expect.objectContaining({ sessionId: 't', runId: expect.any(String), iteration: 1, tool: UPDATE_GOAL_TOOL_NAME, dispatchCount: 1 }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      category: 'goal.loop', event: 'iteration',
      data: expect.objectContaining({ dispatchCount: 1 }),
    }));
  });

  it('evidence 없는 complete 는 완료로 인정하지 않는다(증거-게이트)', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '   '));
      return { stopReason: 'end_turn', finalText: 'claiming done' };
    };
    const r = await runGoalLoop(baseCtx('x'), { runTurn, maxIterations: 4 });
    expect(r.stopReason).toBe('max_iterations');
    expect(r.goalComplete).toBe(false);
    expect(r.iterations).toBe(4);
  });

  it('순수 텍스트 턴(도구 없음)은 재루프 없이 수용한다(trivial chat)', async () => {
    const runTurn = async (): Promise<CoreTurnResult> =>
      ({ stopReason: 'end_turn', finalText: 'the answer is 42' });
    const r = await runGoalLoop(baseCtx('what is X'), { runTurn });
    expect(r.iterations).toBe(1);
    expect(r.goalComplete).toBe(false);
    expect(r.stopReason).toBe('end_turn');
  });

  it('도구 작업이 수렴 안 하면 maxIterations 에서 멈춘다(매 턴 다른 진전)', async () => {
    let call = 0;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      call += 1;
      ctx.callbacks?.onTurnComplete?.([
        { role: 'assistant', content: [{ type: 'tool_use', id: String(call), name: 'Read', input: { f: call } }] as any },
      ]);
      return { stopReason: 'end_turn', finalText: 'still working' };
    };
    const r = await runGoalLoop(baseCtx('endless'), { runTurn, maxIterations: 4 });
    expect(r.stopReason).toBe('max_iterations');
    expect(r.iterations).toBe(4);
    expect(r.goalComplete).toBe(false);
  });

  it('동일 tool 시그니처 반복 시 no_progress 로 멈춘다(anti-spin 레일)', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(toolTurn); // 매번 동일 시그니처 → spin
      return { stopReason: 'end_turn', finalText: 'spinning' };
    };
    const r = await runGoalLoop(baseCtx('spin'), { runTurn, noProgressLimit: 2, maxIterations: 20 });
    expect(r.stopReason).toBe('no_progress');
    expect(r.iterations).toBeLessThan(20);
  });

  it('update_goal(blocked) 는 3연속일 때만 no_progress 로 수용한다(조기 give-up 방지)', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('blocked', '', '같은 컴파일 에러 반복'));
      return { stopReason: 'end_turn', finalText: '막힘' };
    };
    const r = await runGoalLoop(baseCtx('blocked'), { runTurn, maxIterations: 20 });
    expect(r.stopReason).toBe('no_progress');
    expect(r.iterations).toBe(3);
  });

  it('GOAL-BLOCKED 마커도 3연속 fallback 으로 수용한다(deprecated)', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(toolTurn);
      return { stopReason: 'end_turn', finalText: `막힘\n${GOAL_BLOCKED_MARKER}` };
    };
    const r = await runGoalLoop(baseCtx('blocked'), { runTurn, maxIterations: 20 });
    expect(r.stopReason).toBe('no_progress');
    expect(r.iterations).toBe(3);
  });

  it('완료 텍스트 마커만으로는 완료하지 않고 read-back 후 2회째 HITL 승격한다', async () => {
    // 마커는 spoofable → update_goal 재확정 요구(read-back). 계속 마커만 내면 no_progress.
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(toolTurn);
      return { stopReason: 'end_turn', finalText: `확인 완료\n${GOAL_COMPLETE_MARKER}` };
    };
    const r = await runGoalLoop(baseCtx('상수값 알려줘'), { runTurn, maxIterations: 20 });
    expect(r.stopReason).toBe('no_progress');
    expect(r.goalComplete).toBe(false);
    expect(r.iterations).toBe(2); // 1회 read-back → 2회째 승격
  });

  it('마커가 산문 안에 포함돼도 read-back 을 트리거하지 않는다(단독 줄만·회귀)', async () => {
    let call = 0;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      call += 1;
      if (call < 2) {
        // 마커가 산문 안(부분매칭) → 완료도 read-back 도 아님, 진행 계속.
        ctx.callbacks?.onTurnComplete?.([
          { role: 'assistant', content: [{ type: 'tool_use', id: String(call), name: 'Read', input: { f: call } }] as any },
        ]);
        return { stopReason: 'end_turn', finalText: `상수 값은 ${GOAL_COMPLETE_MARKER} 입니다.` };
      }
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '상수값=42 소스에서 확인'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const r = await runGoalLoop(baseCtx('상수값 알려줘'), { runTurn });
    expect(r.iterations).toBe(2);
    expect(r.stopReason).toBe('goal_complete');
  });

  it('컨텍스트 오버플로 임박 시 context_pressure 로 bail 한다(재주입 금지)', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onUsage?.({ inputTokens: 9000 });
      ctx.callbacks?.onTurnComplete?.(toolTurn);
      return { stopReason: 'end_turn', finalText: 'working' };
    };
    const r = await runGoalLoop(baseCtx('big goal'), {
      runTurn, maxIterations: 20, contextTokenLimit: 10_000, contextPressureRatio: 0.85,
    });
    expect(r.stopReason).toBe('context_pressure');
    expect(r.goalComplete).toBe(false);
    expect(r.iterations).toBe(1);
  });

  it('성공 시 helper 스냅샷과 evidence로 complete를 정확히 한 번 발행하고 실계약을 통과한다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-complete';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-complete';
    resetTerminalMatrix();
    try {
      const files = ['src/actual.ts', 'test/actual.test.ts'];
      const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
        ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'tests passed with evidence'));
        return { stopReason: 'end_turn', finalText: 'done' };
      };
      const result = await runGoalLoop(baseCtx('x'), { runTurn, changedFiles: () => files });
      const records = snapshotRunLifecycle(getChannelBus(), 'run-goal-loop-complete');
      const complete = records.filter((record) => record.name === 'complete');

      expect(result).toEqual({ finalText: 'done', iterations: 1, stopReason: 'goal_complete', goalComplete: true });
      expect(complete).toHaveLength(1);
      expect(complete[0]).toMatchObject({ payload: { summary: 'tests passed with evidence', changedFiles: files } });
      expect(validateLifecycleRecord(complete[0])).toBeNull();
    } finally {
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('스냅샷 실패도 빈 목록과 실패 사실을 담은 complete로 보존한다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-complete-helper';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-complete-helper';
    resetTerminalMatrix();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'evidence'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    try {
      const thrown = await runGoalLoop(baseCtx('throwing helper'), {
        runTurn,
        changedFiles: () => { throw new Error('git unavailable'); },
      });
      expect(thrown).toEqual({ finalText: 'done', iterations: 1, stopReason: 'goal_complete', goalComplete: true });
      const snapshotFailureRecords = snapshotRunLifecycle(getChannelBus(), 'run-goal-loop-complete-helper');
      expect(snapshotFailureRecords.map((record) => record.name)).toEqual(['started', 'complete']);
      expect(snapshotFailureRecords[1]).toMatchObject({
        payload: {
          changedFiles: [],
          summary: expect.stringContaining('Changed-files snapshot failed: git unavailable'),
        },
      });
      expect(log.mock.calls.some(([category, event]) =>
        category === 'goal.loop' && event === 'complete-lifecycle-snapshot-failed',
      )).toBe(true);

      resetTerminalMatrix();
      const empty = await runGoalLoop(baseCtx('empty helper'), { runTurn, changedFiles: () => [] });
      expect(empty).toEqual({ finalText: 'done', iterations: 1, stopReason: 'goal_complete', goalComplete: true });
      const complete = snapshotRunLifecycle(getChannelBus(), 'run-goal-loop-complete-helper')
        .filter((record) => record.name === 'complete');
      expect(complete).toHaveLength(1);
      expect(complete[0]).toMatchObject({ payload: { changedFiles: [] } });
    } finally {
      log.mockRestore();
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('complete의 긴 파일 목록은 레코드 계층에서 절단되고 bus 예외는 성공 결과를 바꾸지 않는다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-complete-truncated';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-complete-truncated';
    resetTerminalMatrix();
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'evidence'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    try {
      await runGoalLoop(baseCtx('truncate'), {
        runTurn,
        changedFiles: () => Array.from({ length: 51 }, (_, index) => `src/${index}.ts`),
      });
      const complete = snapshotRunLifecycle(getChannelBus(), 'run-goal-loop-complete-truncated')
        .find((record) => record.name === 'complete')!;
      expect(complete.truncated).toBe(true);
      expect(complete.truncatedFields).toEqual(['changedFiles']);
      expect(complete.payload.changedFiles).toHaveLength(50);

      resetTerminalMatrix();
      const bus = getChannelBus();
      const originalPublish = bus.publish.bind(bus);
      const publish = spyOn(bus, 'publish').mockImplementation((channel, message) => {
        if (channel.includes('/lifecycle') && (message.meta as { name?: string } | undefined)?.name === 'complete') {
          throw new Error('bus down');
        }
        return originalPublish(channel, message);
      });
      const result = await runGoalLoop(baseCtx('bus failure'), { runTurn, changedFiles: () => ['src/x.ts'] });
      expect(result.finalText).toBe('done');
      expect(result.iterations).toBe(1);
      expect(result.stopReason).toBe('goal_complete');
      expect(result.goalComplete).toBe(true);
      publish.mockRestore();
    } finally {
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('abort/error 는 즉시 전파하고 started/failed lifecycle을 발행한다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_RUN_ID = 'run-core-turn-goal-loop';
    process.env.ELANOUS_PTY_ID = 'pty-core-turn-goal-loop';
    resetTerminalMatrix();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const runTurn = async (): Promise<CoreTurnResult> =>
        ({ stopReason: 'aborted', finalText: 'partial' });
      const r = await runGoalLoop(baseCtx('x'), { runTurn });
      expect(r.stopReason).toBe('aborted');
      expect(r.iterations).toBe(1);
      const records = snapshotRunLifecycle(getChannelBus(), 'run-core-turn-goal-loop');
      expect(records.map((record) => record.name)).toEqual(['started', 'failed']);
      expect(records[1]).toMatchObject({ payload: { reason: 'aborted' } });
      expect(log.mock.calls.filter(([, event]) => event === 'lifecycle.published'))
        .toHaveLength(2);
    } finally {
      log.mockRestore();
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('발행 프로세스에 브리지를 한 번 붙여 SQLite에 미러링하고 종료 시 해제한다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    const originalStateDir = process.env.ELANOUS_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-loop-lifecycle-bridge-'));
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-bridge';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-bridge';
    process.env.ELANOUS_STATE_DIR = stateDir;
    resetTerminalMatrix();
    resetLifecycleBridgeForTesting();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const runTurn = async (): Promise<CoreTurnResult> =>
        ({ stopReason: 'aborted', finalText: 'partial' });
      await runGoalLoop(baseCtx('x'), { runTurn });

      expect(readRunLifecycle('run-goal-loop-bridge').map(({ record }) => record.name))
        .toEqual(['started', 'failed']);
      expect(log.mock.calls.filter(([category, event]) =>
        category === 'signal' && event === 'lifecycle.bridge-attached',
      )).toHaveLength(1);

      resetGoalLoopLifecycleBridgeForTesting();
      publishLifecycleRecord(getChannelBus(), {
        runId: 'run-goal-loop-bridge', ptyId: 'pty-goal-loop-bridge', subjectPtyId: 'pty-goal-loop-bridge',
        depth: 0, role: 'child', seq: 99_999, at: Date.now(), class: 'progress', name: 'progress', truncated: false,
      });
      expect(readRunLifecycle('run-goal-loop-bridge')).toHaveLength(2);
    } finally {
      log.mockRestore();
      resetGoalLoopLifecycleBridgeForTesting();
      resetTerminalMatrix();
      resetLifecycleBridgeForTesting();
      rmSync(stateDir, { recursive: true, force: true });
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
      if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalStateDir;
    }
  });

  it('순차·동시 goal loop 호출도 프로세스 브리지를 한 번만 붙이고 lifecycle을 한 번만 쓴다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-bridge-once';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-bridge-once';
    resetTerminalMatrix();
    let attachCalls = 0;
    let writes = 0;
    let detachCalls = 0;
    const attach = (bus: ReturnType<typeof getChannelBus>, runId: string) => {
      attachCalls += 1;
      const subscription = subscribeRunLifecycle(bus, runId, () => {
        writes += 1;
      });
      return () => {
        detachCalls += 1;
        subscription.unsubscribe();
      };
    };
    const runTurn = async (): Promise<CoreTurnResult> =>
      ({ stopReason: 'aborted', finalText: 'partial' });
    try {
      await runGoalLoop(baseCtx('sequential one'), { runTurn, attachLifecycleBridge: attach });
      await runGoalLoop(baseCtx('sequential two'), { runTurn, attachLifecycleBridge: attach });
      await Promise.all([
        runGoalLoop(baseCtx('concurrent one'), { runTurn, attachLifecycleBridge: attach }),
        runGoalLoop(baseCtx('concurrent two'), { runTurn, attachLifecycleBridge: attach }),
      ]);

      expect(attachCalls).toBe(1);
      expect(writes).toBe(8);
      resetGoalLoopLifecycleBridgeForTesting();
      expect(detachCalls).toBe(1);
    } finally {
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('브리지 저장소가 불능이어도 goal loop 결과를 바꾸지 않는다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    const originalStateDir = process.env.ELANOUS_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-loop-lifecycle-bridge-failsoft-'));
    const blockedPath = join(stateDir, 'not-a-directory');
    writeFileSync(blockedPath, 'file');
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-bridge-failsoft';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-bridge-failsoft';
    process.env.ELANOUS_STATE_DIR = blockedPath;
    resetTerminalMatrix();
    resetLifecycleBridgeForTesting();
    try {
      const runTurn = async (): Promise<CoreTurnResult> =>
        ({ stopReason: 'aborted', finalText: 'partial' });
      const result = await runGoalLoop(baseCtx('x'), { runTurn });
      expect(result).toMatchObject({ stopReason: 'aborted', iterations: 1, goalComplete: false });
    } finally {
      resetTerminalMatrix();
      resetLifecycleBridgeForTesting();
      rmSync(stateDir, { recursive: true, force: true });
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
      if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalStateDir;
    }
  });

  it('정체성이 없으면 lifecycle을 발행하지 않고 skip 관측을 남긴다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    delete process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_PTY_ID;
    resetTerminalMatrix();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const runTurn = async (): Promise<CoreTurnResult> =>
        ({ stopReason: 'aborted', finalText: 'partial' });
      await runGoalLoop(baseCtx('x'), { runTurn });
      expect(snapshotRunLifecycle(getChannelBus(), 'missing-identity')).toEqual([]);
      expect(log.mock.calls.filter(([category, event]) =>
        category === 'signal' && event === 'lifecycle.skip-no-identity',
      )).toHaveLength(2);
      expect(log.mock.calls.filter(([category, event]) =>
        category === 'signal' && event === 'lifecycle.bridge.skip-no-identity',
      )).toHaveLength(1);
    } finally {
      log.mockRestore();
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('도구 턴 사이에 continuation 프롬프트를 재주입한다', async () => {
    const seenLastUser: string[] = [];
    let call = 0;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      call += 1;
      const last = ctx.messages[ctx.messages.length - 1];
      if (last && typeof last.content === 'string') seenLastUser.push(last.content);
      if (call < 2) {
        ctx.callbacks?.onTurnComplete?.(toolTurn);
        return { stopReason: 'end_turn', finalText: 'work' };
      }
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'evidence'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    await runGoalLoop(baseCtx('do it'), { runTurn });
    expect(seenLastUser.some((s) => s.includes('[continue]'))).toBe(true);
  });

  it('preamble 를 leading system 으로 주입한다(injectPreamble 기본 true)', async () => {
    let firstMsgRole = '';
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      firstMsgRole = ctx.messages[0]?.role ?? '';
      return { stopReason: 'end_turn', finalText: 'x' };
    };
    await runGoalLoop(baseCtx('goal'), { runTurn });
    expect(firstMsgRole).toBe('system');
  });

  it('update_goal 스펙 스키마 — status enum + evidence required', () => {
    const spec = buildUpdateGoalToolSpec();
    expect(spec.name).toBe(UPDATE_GOAL_TOOL_NAME);
    const params = spec.parameters as any;
    expect(params.properties.status.enum).toEqual(['complete', 'blocked']);
    expect(params.required).toContain('status');
    expect(params.required).toContain('evidence');
  });
});

describe('runGoalLoop — rejected tool-call completion contradiction', () => {
  it('same-turn rejection + complete → rejects once and injects rejected tool names', async () => {
    const seenLastUser: string[] = [];
    let call = 0;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      call += 1;
      const last = ctx.messages[ctx.messages.length - 1];
      if (last && typeof last.content === 'string') seenLastUser.push(last.content);
      ctx.callbacks?.onTurnComplete?.(
        call === 1
          ? completeWithRejectedToolTurn(['Write', 'Bash'])
          : updateGoalTurn('complete', 'Write와 Bash 재실행 확인'),
      );
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const result = await runGoalLoop(baseCtx('build X'), { runTurn, maxIterations: 6 });
    expect(result.stopReason).toBe('goal_complete');
    expect(result.iterations).toBe(2);
    expect(seenLastUser.some((content) => content.includes('[tool call rejected]') && content.includes('Write, Bash'))).toBe(true);
  });

  it('same-turn rejection remains after one retry → fail-open completion and observation', async () => {
    const log = spyOn(debug, 'log');
    try {
      const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
        ctx.callbacks?.onTurnComplete?.(completeWithRejectedToolTurn(['Write']));
        return { stopReason: 'end_turn', finalText: 'still claiming' };
      };
      const result = await runGoalLoop(baseCtx('build X'), { runTurn, maxIterations: 6 });
      expect(result.stopReason).toBe('goal_complete');
      expect(result.goalComplete).toBe(true);
      expect(result.iterations).toBe(2);
      const failopen = log.mock.calls.find(([, event]) => event === 'complete-rejected-tool-call-failopen');
      expect(failopen).toBeDefined();
      expect(failopen![2]).toMatchObject({ rejectedTools: ['Write'] });
    } finally {
      log.mockRestore();
    }
  });

  it('complete with no rejected tool result preserves normal completion', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'tests passed'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const result = await runGoalLoop(baseCtx('build X'), { runTurn, maxIterations: 6 });
    expect(result.stopReason).toBe('goal_complete');
    expect(result.iterations).toBe(1);
  });
});

// OH8 후속 PR-2 — run_tests evidence 대조. 완료주장 vs 마지막 run_tests ok 반증(텍스트 파싱 아님).
// run_tests 결과는 onToolResult 콜백(CoreToolResult { id, name, result })으로 흐른다.
function runTestsResult(ok: boolean, fail: number, unmatchedFilters: string[], pass: number) {
  return { requestedFilters: [], filesRan: pass + fail, unmatchedFilters, pass, fail, ok };
}

describe('runGoalLoop — run_tests evidence 대조 (OH8 후속 PR-2)', () => {
  it('(a) 마지막 run_tests ok=false + complete → 반려·불일치 재주입·재시도', async () => {
    const seenLastUser: string[] = [];
    let call = 0;
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      call += 1;
      const last = ctx.messages[ctx.messages.length - 1];
      if (last && typeof last.content === 'string') seenLastUser.push(last.content);
      if (call === 1) {
        // 테스트 실패인데 complete 주장 → 반려되어야.
        ctx.callbacks?.onToolResult?.({ id: 'rt1', name: 'run_tests', result: runTestsResult(false, 2, [], 5) });
        ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '구현 완료 주장'));
        return { stopReason: 'end_turn', finalText: 'claiming done' };
      }
      // 재시도 턴: 테스트를 통과시키고 다시 complete → 이제 인정.
      ctx.callbacks?.onToolResult?.({ id: 'rt2', name: 'run_tests', result: runTestsResult(true, 0, [], 7) });
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '테스트 7 pass 확인'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const r = await runGoalLoop(baseCtx('build X'), { runTurn, maxIterations: 6 });
    expect(r.stopReason).toBe('goal_complete');
    expect(r.iterations).toBe(2);
    // 불일치 프롬프트가 재주입됐다(fail 수치 포함).
    expect(seenLastUser.some((s) => s.includes('[evidence mismatch]') && s.includes('fail=2'))).toBe(true);
  });

  it('(b) 재시도 후에도 ok=false → fail-open 통과(goal_complete)', async () => {
    // 매 턴 테스트 실패 + complete 주장. 1회 반려 후에도 계속 실패 → fail-open 통과.
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onToolResult?.({ id: 'rt', name: 'run_tests', result: runTestsResult(false, 1, ['ghost.test.ts'], 3) });
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '완료 주장 유지'));
      return { stopReason: 'end_turn', finalText: 'still claiming' };
    };
    const r = await runGoalLoop(baseCtx('build X'), { runTurn, maxIterations: 6 });
    expect(r.stopReason).toBe('goal_complete'); // fail-open — hard-block 아님
    expect(r.goalComplete).toBe(true);
    expect(r.iterations).toBe(2); // 1회 반려 → 2회째 fail-open 통과
  });

  it('(c) run_tests 안 돎(lastRunTests=null·매매류) → 반려 미발동·정상 complete', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      // onToolResult 없음 = run_tests 미노출(비코딩/매매 루프). fail-closed 자연 보존.
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '집행 완료 증거'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const r = await runGoalLoop(baseCtx('trade'), { runTurn, maxIterations: 6 });
    expect(r.stopReason).toBe('goal_complete');
    expect(r.goalComplete).toBe(true);
    expect(r.iterations).toBe(1);
  });

  it('(d) 마지막 run_tests ok=true + complete → 정상 통과(반려 없음)', async () => {
    const runTurn = async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
      ctx.callbacks?.onToolResult?.({ id: 'rt', name: 'run_tests', result: runTestsResult(true, 0, [], 9) });
      ctx.callbacks?.onTurnComplete?.(updateGoalTurn('complete', '테스트 9 pass 확인'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    const r = await runGoalLoop(baseCtx('build X'), { runTurn, maxIterations: 6 });
    expect(r.stopReason).toBe('goal_complete');
    expect(r.goalComplete).toBe(true);
    expect(r.iterations).toBe(1);
  });

  it('기존 onToolResult 콜백을 체이닝한다(끊지 않음)', async () => {
    const forwarded: string[] = [];
    const ctx = baseCtx('build X');
    ctx.callbacks = {
      onToolResult: (c) => { forwarded.push(c.name); },
    };
    const runTurn = async (c: CoreTurnContext): Promise<CoreTurnResult> => {
      c.callbacks?.onToolResult?.({ id: 'rt', name: 'run_tests', result: runTestsResult(true, 0, [], 1) });
      c.callbacks?.onTurnComplete?.(updateGoalTurn('complete', 'ok'));
      return { stopReason: 'end_turn', finalText: 'done' };
    };
    await runGoalLoop(ctx, { runTurn });
    expect(forwarded).toContain('run_tests'); // caller 콜백까지 forward
  });

  it('모든 비완료 종료 경로는 started 뒤 failed 하나를 stopReason과 함께 발행한다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-terminal-paths';
    const cases: Array<{
      name: string;
      expected: GoalLoopResult['stopReason'];
      options: Omit<Parameters<typeof runGoalLoop>[1], 'runTurn'>;
      runTurn: (ctx: CoreTurnContext) => Promise<CoreTurnResult>;
    }> = [
      { name: 'aborted', expected: 'aborted', options: {}, runTurn: async () => ({ stopReason: 'aborted', finalText: 'partial' }) },
      { name: 'error', expected: 'error', options: {}, runTurn: async () => ({ stopReason: 'error', finalText: 'failed' }) },
      { name: 'text-only', expected: 'end_turn', options: {}, runTurn: async () => ({ stopReason: 'end_turn', finalText: 'answer' }) },
      {
        name: 'context-pressure', expected: 'context_pressure', options: { contextTokenLimit: 100, contextPressureRatio: 0.5 },
        runTurn: async (ctx) => {
          ctx.callbacks?.onUsage?.({ inputTokens: 50 });
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: 'working' };
        },
      },
      {
        name: 'max-iterations', expected: 'max_iterations', options: { maxIterations: 1 },
        runTurn: async (ctx) => {
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: 'working' };
        },
      },
      {
        name: 'no-progress', expected: 'no_progress', options: { noProgressLimit: 1 },
        runTurn: async (ctx) => {
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: 'spinning' };
        },
      },
      {
        name: 'blocked', expected: 'no_progress', options: {},
        runTurn: async (ctx) => {
          ctx.callbacks?.onTurnComplete?.(updateGoalTurn('blocked', '', 'blocked'));
          return { stopReason: 'end_turn', finalText: 'blocked' };
        },
      },
      {
        name: 'marker-readback', expected: 'no_progress', options: {},
        runTurn: async (ctx) => {
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: GOAL_COMPLETE_MARKER };
        },
      },
      {
        name: 'soft-stop', expected: 'soft_stop', options: {
          controlSpaceId: 'terminal-path-soft-stop',
          drainControlInbox: () => ({ stop: false, count: 0 }),
          drainSoftStopControlInbox: (() => {
            let calls = 0;
            return () => ({ stop: ++calls > 1, count: 0 });
          })(),
        },
        runTurn: async (ctx) => {
          ctx.callbacks?.onTurnComplete?.(toolTurn);
          return { stopReason: 'end_turn', finalText: 'stopped' };
        },
      },
    ];
    try {
      for (const testCase of cases) {
        process.env.ELANOUS_RUN_ID = `run-goal-loop-terminal-${testCase.name}`;
        resetTerminalMatrix();
        const result = await runGoalLoop(baseCtx(testCase.name), { ...testCase.options, runTurn: testCase.runTurn });
        const terminal = snapshotRunLifecycle(getChannelBus(), process.env.ELANOUS_RUN_ID)
          .filter((record) => record.name === 'complete' || record.name === 'failed');
        expect(result.stopReason).toBe(testCase.expected);
        expect(result.goalComplete).toBe(false);
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ name: 'failed', payload: { reason: testCase.expected } });
      }
    } finally {
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });

  it('terminal lifecycle publish가 던져도 비완료 반환값은 바뀌지 않는다', async () => {
    const originalRunId = process.env.ELANOUS_RUN_ID;
    const originalPtyId = process.env.ELANOUS_PTY_ID;
    process.env.ELANOUS_RUN_ID = 'run-goal-loop-terminal-publish-throw';
    process.env.ELANOUS_PTY_ID = 'pty-goal-loop-terminal-publish-throw';
    resetTerminalMatrix();
    const bus = getChannelBus();
    const publish = spyOn(bus, 'publish').mockImplementation(() => { throw new Error('bus down'); });
    try {
      const result = await runGoalLoop(baseCtx('aborted'), {
        runTurn: async () => ({ stopReason: 'aborted', finalText: 'partial' }),
      });
      expect(result).toEqual({ finalText: 'partial', iterations: 1, stopReason: 'aborted', goalComplete: false });
    } finally {
      publish.mockRestore();
      resetTerminalMatrix();
      if (originalRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = originalRunId;
      if (originalPtyId === undefined) delete process.env.ELANOUS_PTY_ID;
      else process.env.ELANOUS_PTY_ID = originalPtyId;
    }
  });
});
