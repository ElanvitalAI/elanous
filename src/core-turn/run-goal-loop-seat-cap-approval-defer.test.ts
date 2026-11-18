/**
 * APP-BUILD-TOOL-WALL-CAP(11-17 run d2eab21a) — 자리 턴 벽시계 상한이 승인 창을 쥔 app_build 를 끊지 않는다.
 * 가짜 시계·가짜 타이머·가짜 도구만 쓴다(mock.module 없음 · 실시간 대기 0).
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import { debug } from '../debug/log.js';
import { runGoalLoop, type GoalLoopOptions } from './run-goal-loop.js';
import {
  SEAT_CAP_APPROVAL_DEFER_MAX_MS, SEAT_CAP_DEFERRED_WRAPUP_MS, SEAT_TURN_CAP_DEFAULTS, isSeatTurnCapAbort,
} from './seat-turn-cap.js';

const SEAT = { seat: 'MVP-B', ...SEAT_TURN_CAP_DEFAULTS };

type Timer = { at: number; callback: () => void; disposed: boolean };

function harness() {
  let clock = 1_000_000;
  const timers: Timer[] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const schedule: NonNullable<GoalLoopOptions['scheduleSeatWallCap']> = (callback, delayMs) => {
    const timer: Timer = { at: clock + delayMs, callback, disposed: false };
    timers.push(timer);
    return { dispose: () => { timer.disposed = true; } };
  };
  /** 시계를 민 뒤, 그 시각까지 온 타이머를 시각 순으로 발화한다. */
  const advance = (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => !t.disposed && t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.disposed = true;
      due.callback();
    }
  };
  const live = () => timers.filter((t) => !t.disposed).length;
  return { schedule, advance, live, events, now: () => clock };
}

async function run(h: ReturnType<typeof harness>, runTurn: (turnCtx: CoreTurnContext) => Promise<CoreTurnResult>,
  dispatchTool: CoreTurnContext['dispatchTool']) {
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') h.events.push({ event, data });
  }) as typeof debug.log;
  try {
    return await runGoalLoop({
      sessionId: 'seat-cap-approval-defer',
      messages: [{ role: 'user', content: '앱 만들어서 배포해줘' }],
      tools: [],
      dispatchTool,
      signal: new AbortController().signal,
    } as CoreTurnContext, {
      changedFiles: () => [],
      controlSpaceId: null,
      intentStallProvider: null,
      attachLifecycleBridge: () => () => {},
      startLivenessHeartbeat: () => () => {},
      now: h.now,
      seatTurnCap: SEAT,
      scheduleSeatWallCap: h.schedule,
      runTurn,
    });
  } finally {
    debug.log = originalLog;
  }
}

const aborted = (signal: AbortSignal) => new Promise<'aborted'>((resolve) => {
  if (signal.aborted) resolve('aborted');
  else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
});

describe('APP-BUILD-TOOL-WALL-CAP — 승인 도구 실행 중 상한은 미룬다', () => {
  test('상한이 진행 중 app_build 를 끊지 않고 승인 창이 상한 틱을 넘어 산다 · 돌아온 뒤 턴을 닫는다', async () => {
    const h = harness();
    let finishBuild!: (value: unknown) => void;
    let windowAfterTick: boolean | undefined;
    let turnSignalAfterTick: boolean | undefined;
    const result = await run(h, async (turnCtx) => {
      const call = turnCtx.dispatchTool('app_build', { ask: 'x' }, { callId: 'a1', signal: turnCtx.signal } as never);
      await Promise.resolve();
      h.advance(SEAT.maxWallMs + 1);
      turnSignalAfterTick = turnCtx.signal.aborted;
      finishBuild({ ok: true, status: 'completed', published: true });
      const built = await call as Record<string, unknown>;
      expect(built).toMatchObject({ published: true });
      // 상한 뒤 다른 도구는 막힌다.
      const refused = await turnCtx.dispatchTool('RunShell', { command: 'ls' }, { callId: 'r1' } as never) as { error?: string };
      expect(refused.error).toContain('SEAT TURN CAP');
      return { stopReason: 'end_turn', finalText: '게시 완료 — 요약 한 줄' };
    }, async (_name, _args, dctx) => {
      // 승인 창은 턴 signal 에서 파생된다(child-plugin-runtime: AbortSignal.any([context.signal, timeout])).
      const window = AbortSignal.any([(dctx as { signal: AbortSignal }).signal]);
      return await new Promise((resolve) => {
        finishBuild = (value) => { windowAfterTick = window.aborted; resolve(value); };
      });
    });
    expect(turnSignalAfterTick).toBe(false);
    expect(windowAfterTick).toBe(false);
    const deferred = h.events.filter((e) => e.event === 'seat-turn-cap-deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.data).toMatchObject({ tool: 'app_build', reason: 'wall', seat: 'MVP-B' });
    expect(h.events.find((e) => e.event === 'seat-turn-cap')?.data).toMatchObject({ reason: 'wall', deferred: 'wall', backstopAborted: false });
    expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false, iterations: 1 });
    expect(h.live()).toBe(0);
  });

  test('상한은 보통 도구에는 그대로 걸린다 — 진행 중 셸 호출을 상한 reason 으로 끊는다 · 미룸 0', async () => {
    const h = harness();
    let reason: unknown;
    const result = await run(h, async (turnCtx) => {
      const call = turnCtx.dispatchTool('RunShell', { command: 'bun build' }, { callId: 's1', signal: turnCtx.signal } as never);
      await Promise.resolve();
      h.advance(SEAT.maxWallMs + 1);
      reason = turnCtx.signal.reason;
      await Promise.race([call, aborted(turnCtx.signal)]);
      return { stopReason: 'aborted', finalText: '(벽시계 상한 중단)' };
    }, () => new Promise(() => {}));
    expect(isSeatTurnCapAbort(reason)).toBe(true);
    expect(h.events.filter((e) => e.event === 'seat-turn-cap-deferred')).toHaveLength(0);
    expect(h.events.find((e) => e.event === 'seat-turn-cap')?.data).toMatchObject({ reason: 'wall', backstopAborted: true });
    expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false });
  });

  test('승인 창 마감(미룸 상한)이 지나면 돌아오지 않는 app_build 라도 턴을 깨끗이 닫는다', async () => {
    const h = harness();
    const marks: Array<[string, boolean]> = [];
    const result = await run(h, async (turnCtx) => {
      const call = turnCtx.dispatchTool('app_build', { ask: 'x' }, { callId: 'a1', signal: turnCtx.signal } as never);
      await Promise.resolve();
      h.advance(SEAT.maxWallMs + 1);
      marks.push(['cap-tick', turnCtx.signal.aborted]);
      h.advance(SEAT_CAP_APPROVAL_DEFER_MAX_MS - 1);
      marks.push(['before-deadline', turnCtx.signal.aborted]);
      h.advance(1);
      marks.push(['deadline', turnCtx.signal.aborted]);
      await Promise.race([call, aborted(turnCtx.signal)]);
      return { stopReason: 'aborted', finalText: '(승인 창 마감)' };
    }, () => new Promise(() => {}));
    expect(marks).toEqual([['cap-tick', false], ['before-deadline', false], ['deadline', true]]);
    expect(h.events.find((e) => e.event === 'seat-turn-cap')?.data).toMatchObject({ reason: 'wall', deferred: 'wall', backstopAborted: true });
    expect(h.events.filter((e) => e.event === 'seat-turn-cap-exhausted')).toHaveLength(1);
    expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false, iterations: 1 });
    expect(h.live()).toBe(0);
  });

  test('미룬 상한에서 app_build 가 돌아온 뒤 모델이 멈추면 요약 여유 뒤 턴을 닫는다', async () => {
    const h = harness();
    let finishBuild!: () => void;
    const marks: Array<[string, boolean]> = [];
    const result = await run(h, async (turnCtx) => {
      const call = turnCtx.dispatchTool('app_build', { ask: 'x' }, { callId: 'a1', signal: turnCtx.signal } as never);
      await Promise.resolve();
      h.advance(SEAT.maxWallMs + 1);
      finishBuild();
      await call;
      h.advance(SEAT_CAP_DEFERRED_WRAPUP_MS - 1);
      marks.push(['wrapup-before', turnCtx.signal.aborted]);
      h.advance(1);
      marks.push(['wrapup', turnCtx.signal.aborted]);
      return { stopReason: 'aborted', finalText: '(요약 여유 마감)' };
    }, () => new Promise((resolve) => { finishBuild = () => resolve({ ok: true }); }));
    expect(marks).toEqual([['wrapup-before', false], ['wrapup', true]]);
    expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false });
    expect(h.live()).toBe(0);
  });
});
