/**
 * ELN-SEAT-TURN-HARD-CAP ④ — 벽시계 상한이 «진행 중인 긴 도구»를 실제로 끊는가.
 * 가짜 상한 타이머(scheduleSeatWallCap) · 가짜 runTurn 은 llm.ts 처럼 도구 Promise 를 «경주 없이» 기다린다
 * (llm.ts: `result = await handlers.dispatchTool(...)` — abort 와 race 하지 않는다).
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import { debug } from '../debug/log.js';
import { runGoalLoop, type GoalLoopOptions } from './run-goal-loop.js';
import { SEAT_TURN_CAP_DEFAULTS } from './seat-turn-cap.js';
import { buildReplTools } from '../repl/index.js';
import { dispatchBash } from '../skills/tools/index.js';

const SEAT = { seat: 'QSEAT', ...SEAT_TURN_CAP_DEFAULTS, maxWallMs: 900_000 }; // 출처: 내부 문서 `TURN-CAPSULE-EVENTS` — 운영 15분 자리 턴 상한(chat.seatTurnCap.maxWallMs)

function harness() {
  let clock = 1_000_000;
  const timers: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const schedule: NonNullable<GoalLoopOptions['scheduleSeatWallCap']> = (callback, delayMs) => {
    const timer = { at: clock + delayMs, callback, disposed: false };
    timers.push(timer);
    return { dispose: () => { timer.disposed = true; } };
  };
  const advance = (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => !t.disposed && t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.disposed = true;
      due.callback();
    }
  };
  return { schedule, advance, events, now: () => clock };
}

async function run(h: ReturnType<typeof harness>, dispatchTool: CoreTurnContext['dispatchTool'], onStarted: Promise<void>) {
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') h.events.push({ event, data });
  }) as typeof debug.log;
  try {
    return await runGoalLoop({
      sessionId: 'seat-cap-inflight',
      messages: [{ role: 'user', content: '긴 셸' }],
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
      runTurn: async (turnCtx): Promise<CoreTurnResult> => {
        // run-core-turn.ts 처럼 턴 signal 을 dctx 에 실어 보낸다 · llm.ts 처럼 경주 없이 기다린다.
        const call = turnCtx.dispatchTool('Bash', { command: 'sleep 20' }, { callId: 'b1', signal: turnCtx.signal } as never);
        await onStarted;
        h.advance(SEAT.maxWallMs + 1);
        await call;
        return { stopReason: turnCtx.signal.aborted ? 'aborted' : 'end_turn', finalText: '(셸 끝)' };
      },
    });
  } finally {
    debug.log = originalLog;
  }
}

const deadline = (ms: number) => Bun.sleep(ms).then(() => { throw new Error(`turn still waiting on in-flight tool after ${ms}ms`); });

describe('ELN-SEAT-TURN-HARD-CAP ④ — 상한이 진행 중 긴 도구를 끊는다', () => {
  test('대조 — dctx.signal 을 읽는 도구는 상한 틱에 끊기고 턴이 max_turns 로 닫힌다', async () => {
    const h = harness();
    let started!: () => void;
    const onStarted = new Promise<void>((r) => { started = r; });
    const result = await Promise.race([run(h, async (_n, _a, dctx) => {
      const signal = (dctx as { signal: AbortSignal }).signal;
      started();
      return await new Promise((resolve) => {
        if (signal.aborted) resolve({ aborted: true });
        else signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
      });
    }, onStarted), deadline(2_000)]);
    expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false });
    expect(h.events.find((e) => e.event === 'seat-turn-cap')?.data).toMatchObject({ reason: 'wall', backstopAborted: true });
  });

  test('실물 — 자리 TUI(REPL) 도구 표면의 Bash(sleep 20)가 상한 틱 뒤 5초 안에 끊긴다', async () => {
    const h = harness();
    let started!: () => void;
    const onStarted = new Promise<void>((r) => { started = r; });
    // 자리 TUI 의 사람 턴 signal(ESC) — 상한과 무관하게 살아 있다(repl/index.ts activeTurnSignal).
    const humanTurn = new AbortController();
    const tools = buildReplTools({
      getSignal: () => humanTurn.signal,
      dispatchBash: (args, options) => { started(); return dispatchBash(args, options); },
    });
    const t0 = Date.now();
    // session/chat.ts 와 같은 배선: dispatchTool(name, args, ctx) → turnTools.dispatch(name, args, ctx)
    const result = await Promise.race([
      run(h, (n, a, c) => (tools.dispatch as (n: string, a: Record<string, unknown>, c: unknown) => Promise<unknown>)(n, a, c), onStarted),
      deadline(5_000),
    ]);
    expect(Date.now() - t0).toBeLessThan(5_000); // 출처: 내부 문서 `TURN-CAPSULE-EVENTS` — 상한 틱 뒤 셸 자식 kill·정착 여유(종전 실측 +247초)
    expect(result).toMatchObject({ stopReason: 'max_turns' });
  }, 30_000);
});
