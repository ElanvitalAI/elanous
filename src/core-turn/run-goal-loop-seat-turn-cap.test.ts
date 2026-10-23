/**
 * TUI-SEAT-TURN-CAP(0.2.31) — 자리 TUI goal loop 의 core 턴 상한(도구 수·벽시계) ⊕ «할 일 0»(빈 우편 조회 연속) 판정.
 * ⛔ mock.module 없음 — runTurn·now 주입 seam 과 debug.log 교체만 쓴다(midrun-stall 시험과 같은 틀).
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { DELEGATE_HINT } from '../agent/delegate-hint.js';
import { runGoalLoop, type GoalLoopOptions } from './run-goal-loop.js';
import {
  SEAT_TURN_CAP_CONTINUE_PROMPT, SEAT_TURN_CAP_DEFAULTS, isEmptyMailListResult, isIdleWaitCall, parseSeatTurnCapConfig,
} from './seat-turn-cap.js';

const SEAT = { seat: 'OPT', ...SEAT_TURN_CAP_DEFAULTS };

const toolUse = (name: string, input: Record<string, unknown> = {}): LLMMessage => ({
  role: 'assistant', content: [{ type: 'tool_use', id: `${name}-1`, name, input }],
});
const completeUse: LLMMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'g1', name: 'update_goal', input: { status: 'complete', evidence: '남은 조치 0건 확인' } }],
};

type Call = { name: string; args?: Record<string, unknown> };
/** 한 core 턴 대본: 도구를 차례로 부르고(거부 안내를 받으면 멈출지 고른다), 끝에 메시지를 넘긴다. */
type Script = {
  calls: Call[];
  /** true 면 상한·idle 안내를 받아도 계속 부른다(받침 시험). */
  ignoreNotice?: boolean;
  /** 각 호출 «전» 에 시계를 이만큼 민다(ms). */
  advanceMs?: number;
  complete?: boolean;
  /** 턴 끝 stopReason(기본 end_turn). */
  stopReason?: CoreTurnResult['stopReason'];
};

async function drive(scripts: readonly Script[], opts: Partial<GoalLoopOptions>, mail: (i: number) => unknown = () => ({ ok: true, count: 0, messages: [] })) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const lastUserMessages: unknown[] = [];
  const executed: string[][] = [];
  const responses: Array<{ name: string; result: unknown }> = [];
  let clock = 1_000_000;
  let calls = 0;
  let mailCalls = 0;
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') events.push({ event, data });
  }) as typeof debug.log;
  const ctx: CoreTurnContext = {
    sessionId: 'seat-turn-cap',
    messages: [{ role: 'user', content: 'OP: 계속 — draft 다음 행.' }],
    tools: [],
    dispatchTool: async (name) => {
      executed.at(-1)!.push(name);
      if (name === 'MsgList') return mail(mailCalls++);
      return { ok: true };
    },
    signal: new AbortController().signal,
  } as CoreTurnContext;
  try {
    const result = await runGoalLoop(ctx, {
      maxIterations: 8,
      changedFiles: () => [],
      controlSpaceId: null,
      intentStallProvider: null,
      attachLifecycleBridge: () => () => {},
      startLivenessHeartbeat: () => () => {},
      now: () => clock,
      ...opts,
      runTurn: async (turnCtx) => {
        const script = scripts[Math.min(calls, scripts.length - 1)]!;
        calls += 1;
        executed.push([]);
        lastUserMessages.push([...turnCtx.messages].reverse().find((m) => m.role === 'user')?.content);
        const used: LLMMessage[] = [];
        for (const call of script.calls) {
          if (turnCtx.signal.aborted) return { stopReason: 'aborted', finalText: '(끊김)' } satisfies CoreTurnResult;
          clock += script.advanceMs ?? 0;
          const result = await turnCtx.dispatchTool(call.name, call.args ?? {}, { callId: `c${calls}` } as never) as Record<string, unknown> | null;
          responses.push({ name: call.name, result });
          used.push(toolUse(call.name, call.args ?? {}));
          const noticed = typeof result?.error === 'string' || typeof result?.notice === 'string';
          if (noticed && !script.ignoreNotice) break;
        }
        if (turnCtx.signal.aborted) return { stopReason: 'aborted', finalText: '(끊김)' } satisfies CoreTurnResult;
        turnCtx.callbacks?.onTurnComplete?.(script.complete ? [...used, completeUse] : used);
        return { stopReason: script.stopReason ?? 'end_turn', finalText: `반복 ${calls} — 진행 요약 한 줄` } satisfies CoreTurnResult;
      },
    });
    const count = (name: string) => events.filter((e) => e.event === name).length;
    const find = (name: string) => events.find((e) => e.event === name)?.data;
    return { result, events, count, find, calls, executed, lastUserMessages, responses };
  } finally {
    debug.log = originalLog;
  }
}

const shell = (n: number): Call[] => Array.from({ length: n }, () => ({ name: 'RunShell', args: { command: 'git status' } }));

describe('TUI-SEAT-TURN-CAP — 도구·벽시계 상한', () => {
  test('자리 TUI: 도구 61개째는 실행하지 않고 core 턴을 max_turns 로 마감 → 다음 반복이 이어받는다', async () => {
    const r = await drive([{ calls: shell(121) }, { calls: [], complete: true }], { seatTurnCap: SEAT });
    expect(r.executed[0]).toHaveLength(60);
    expect(r.calls).toBe(2);
    expect(r.lastUserMessages[1]).toBe(`${SEAT_TURN_CAP_CONTINUE_PROMPT}\n${DELEGATE_HINT}`);
    expect(r.find('seat-turn-cap')).toMatchObject({ seat: 'OPT', reason: 'tools', tools: 60, iteration: 1 });
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 2 });
  });

  test('자리 TUI: 벽시계 20분 초과 뒤 도구 호출 → 실행 0 ⊕ 같은 마감·다음 반복', async () => {
    const r = await drive([{ calls: shell(5), advanceMs: 6 * 60_000 }, { calls: [], complete: true }], { seatTurnCap: SEAT });
    // 6·12·18분은 실행, 24분째(4번째) 호출은 거부.
    expect(r.executed[0]).toHaveLength(3);
    expect(r.find('seat-turn-cap')).toMatchObject({ reason: 'wall', tools: 3, iteration: 1 });
    expect(r.lastUserMessages[1]).toBe(`${SEAT_TURN_CAP_CONTINUE_PROMPT}\n${DELEGATE_HINT}`);
    expect(r.result.stopReason).toBe('goal_complete');
  });

  test('안내를 무시하고 계속 부르면 받침이 그 core 턴만 끊는다 — goal loop 는 aborted 로 죽지 않고 다음 반복', async () => {
    const r = await drive([{ calls: shell(80), ignoreNotice: true }, { calls: [], complete: true }], { seatTurnCap: { ...SEAT, maxTools: 5 } });
    expect(r.executed[0]).toHaveLength(5);
    expect(r.find('seat-turn-cap')).toMatchObject({ reason: 'tools', backstopAborted: true });
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', iterations: 2 });
  });

  test('반복 하드캡(maxIterations)은 그대로 이긴다 — 넘으면 멈춤 ⊕ 자리 OP 에 알릴 이벤트', async () => {
    const r = await drive([{ calls: shell(10) }], { seatTurnCap: { ...SEAT, maxTools: 2 }, maxIterations: 3 });
    expect(r.calls).toBe(3);
    expect(r.result.stopReason).toBe('max_iterations');
    expect(r.count('seat-turn-cap')).toBe(3);
    expect(r.find('seat-turn-cap-exhausted')).toMatchObject({ seat: 'OPT', iterations: 3, capHits: 3, notify: 'seat-op' });
  });

  test('반증 — 사람 TUI(seatTurnCap 없음)는 상한이 없다: 121개 전부 실행 · 상한 이벤트 0', async () => {
    const r = await drive([{ calls: shell(121) }, { calls: [], complete: true }], {});
    expect(r.executed[0]).toHaveLength(121);
    expect(r.count('seat-turn-cap')).toBe(0);
    expect(r.lastUserMessages[1]).not.toBe(SEAT_TURN_CAP_CONTINUE_PROMPT);
  });
});

describe('TUI-SEAT-TURN-CAP — update_goal 과 상한(리뷰 r2)', () => {
  const progress = (n: number): Call[] => Array.from({ length: n }, () => ({ name: 'update_goal', args: { status: 'in_progress' } }));

  test('update_goal(in_progress) 도 도구로 세고 상한 뒤엔 같은 안내로 거부 → 다음 반복', async () => {
    const r = await drive([{ calls: progress(70) }, { calls: [], complete: true }], { seatTurnCap: { ...SEAT, maxTools: 60 } });
    expect(r.find('seat-turn-cap')).toMatchObject({ reason: 'tools', tools: 60, iteration: 1 });
    expect(r.calls).toBe(2);
    expect(r.lastUserMessages[1]).toBe(`${SEAT_TURN_CAP_CONTINUE_PROMPT}\n${DELEGATE_HINT}`);
  });

  test('상한 뒤의 update_goal(complete) 는 받아들인다(종결 신호 · 도구로 세지 않음) → goal 완료', async () => {
    // 이력 직접 주입 없음(complete:false) — 그 호출 자체의 tool_use 와 응답만으로 판정한다(리뷰 r3 GOODHART).
    const r = await drive(
      [{ calls: [...shell(3), { name: 'update_goal', args: { status: 'complete', evidence: '끝' } }], ignoreNotice: true }],
      { seatTurnCap: { ...SEAT, maxTools: 2 } },
    );
    expect(r.executed[0]).toHaveLength(2);
    // 셋째 셸은 상한 안내로 거부, 이어진 complete 는 수락 응답(거부 안내 아님).
    expect(r.responses[2]!.result).toMatchObject({ error: expect.stringContaining('SEAT TURN CAP') });
    expect(r.responses[3]).toEqual({ name: 'update_goal', result: { ok: true, recorded: 'complete' } });
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
  });

  test('상한 턴에 빈 근거 complete 가 오면 상한 이어가기가 아니라 근거 없는 완료 판정으로 간다', async () => {
    const r = await drive(
      [{ calls: [...shell(3), { name: 'update_goal', args: { status: 'complete', evidence: '' } }], ignoreNotice: true }, { calls: [], complete: true }],
      { seatTurnCap: { ...SEAT, maxTools: 2 } },
    );
    expect(r.count('complete-rejected-no-evidence')).toBe(1);
    expect(r.count('seat-turn-cap')).toBe(0);
    expect(r.lastUserMessages[1]).not.toBe(SEAT_TURN_CAP_CONTINUE_PROMPT);
    expect(r.result.stopReason).toBe('goal_complete');
  });

  test('lenient(자리 턴) ⊕ 상한 턴의 빈 근거 complete 는 그 턴 답으로 완료된다', async () => {
    const r = await drive(
      [{ calls: [...shell(3), { name: 'update_goal', args: { status: 'complete', evidence: '' } }], ignoreNotice: true }],
      { seatTurnCap: { ...SEAT, maxTools: 2 }, lenientCompletionEvidence: true },
    );
    expect(r.count('complete-evidence-lenient')).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', iterations: 1 });
  });

  test('상한에 한 번도 안 닿은 하드캡 종료는 seat-turn-cap-exhausted 를 내지 않는다', async () => {
    const r = await drive([{ calls: shell(2) }], { seatTurnCap: SEAT, maxIterations: 2 });
    expect(r.result.stopReason).toBe('max_iterations');
    expect(r.count('seat-turn-cap-exhausted')).toBe(0);
  });

  test('반증 — 사람 TUI(seatTurnCap 없음)는 update_goal 을 몇 번 불러도 상한 안내 0', async () => {
    const r = await drive([{ calls: progress(70) }, { calls: [], complete: true }], {});
    expect(r.count('seat-turn-cap')).toBe(0);
    expect(r.lastUserMessages[1]).not.toBe(SEAT_TURN_CAP_CONTINUE_PROMPT);
  });
});

describe('TUI-SEAT-TURN-CAP — 오류는 상한으로 덮지 않는다(리뷰 r1)', () => {
  test('상한에 닿은 뒤 core 턴이 error 로 끝나면 그대로 error — max_turns·다음 반복 0', async () => {
    const r = await drive([{ calls: shell(10), stopReason: 'error' }, { calls: [], complete: true }], { seatTurnCap: { ...SEAT, maxTools: 2 } });
    expect(r.result.stopReason).toBe('error');
    expect(r.calls).toBe(1);
    expect(r.count('seat-turn-cap')).toBe(0);
  });
});

describe('TUI-SEAT-TURN-CAP — «할 일 0»(idle-no-work)', () => {
  test('빈 MsgList 2연속 → goal 완료(idle-no-work) · 다음 반복 0', async () => {
    const r = await drive([{ calls: [{ name: 'MsgList' }, { name: 'MsgList' }, { name: 'MsgList' }] }], { seatTurnCap: SEAT });
    expect(r.executed[0]).toEqual(['MsgList', 'MsgList']);
    expect(r.calls).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
    expect(r.find('idle-no-work')).toMatchObject({ seat: 'OPT', emptyMailStreak: 2, iteration: 1 });
  });

  test('사이의 대기 sleep 은 연속을 끊지 않는다', async () => {
    const r = await drive([{ calls: [{ name: 'MsgList' }, { name: 'RunShell', args: { command: 'sleep 60' } }, { name: 'MsgList' }] }], { seatTurnCap: SEAT });
    expect(r.find('idle-no-work')).toBeDefined();
    expect(r.result.stopReason).toBe('goal_complete');
  });

  test('반증 — 사이에 새 우편(비지 않은 조회)이나 다른 일이 오면 연속이 끊긴다', async () => {
    const r = await drive(
      [{ calls: [{ name: 'MsgList' }, { name: 'MsgList' }, { name: 'RunShell', args: { command: 'git status' } }, { name: 'MsgList' }] }, { calls: [], complete: true }],
      { seatTurnCap: SEAT },
      (i) => i === 1 ? { ok: true, count: 1, messages: [{ id: 9 }] } : { ok: true, count: 0, messages: [] },
    );
    expect(r.count('idle-no-work')).toBe(0);
    expect(r.calls).toBe(2);
  });

  test('반증 — 사이의 update_goal(진행 선언)은 연속을 끊는다(리뷰 r1)', async () => {
    const r = await drive(
      [{ calls: [{ name: 'MsgList' }, { name: 'update_goal', args: { status: 'in_progress' } }, { name: 'MsgList' }] }, { calls: [], complete: true }],
      { seatTurnCap: SEAT },
    );
    expect(r.count('idle-no-work')).toBe(0);
    expect(r.calls).toBe(2);
  });

  test('반증 — 사람 TUI(seatTurnCap 없음)는 빈 MsgList 가 연속돼도 idle 완료 0', async () => {
    const r = await drive([{ calls: [{ name: 'MsgList' }, { name: 'MsgList' }, { name: 'MsgList' }] }, { calls: [], complete: true }], {});
    expect(r.executed[0]).toEqual(['MsgList', 'MsgList', 'MsgList']);
    expect(r.count('idle-no-work')).toBe(0);
    expect(r.calls).toBe(2);
  });
});

describe('TUI-SEAT-TURN-CAP — caller dispatcher 계약(열차 r19d · 리뷰 r5)', () => {
  // 메서드꼴 dispatcher(this 에 기댐) — 상한 유무와 상관없이 수신자가 살아 있어야 한다.
  async function runWithMethodDispatcher(seatTurnCap: GoalLoopOptions['seatTurnCap']) {
    const owner = {
      label: 'owner',
      seen: [] as string[],
      dispatchTool(this: { label: string; seen: string[] } | undefined, name: string) {
        this!.seen.push(`${this!.label}:${name}`);
        return Promise.resolve({ ok: true });
      },
    };
    const ctx = {
      sessionId: 'seat-turn-cap-this',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      signal: new AbortController().signal,
      dispatchTool(name: string, args: Record<string, unknown>) { return owner.dispatchTool.call(this === ctx ? owner : undefined, name); },
    } as unknown as CoreTurnContext;
    let threw: unknown;
    await runGoalLoop(ctx, {
      maxIterations: 1, changedFiles: () => [], controlSpaceId: null, intentStallProvider: null,
      attachLifecycleBridge: () => () => {}, startLivenessHeartbeat: () => () => {},
      ...(seatTurnCap ? { seatTurnCap } : {}),
      runTurn: async (turnCtx) => {
        try { await turnCtx.dispatchTool('Read', {}, { callId: 'r1' } as never); } catch (e) { threw = e; }
        return { stopReason: 'end_turn', finalText: 'done' } satisfies CoreTurnResult;
      },
    });
    return { threw, seen: owner.seen };
  }
  test('상한 없음(사람 TUI): ctx.dispatchTool 을 메서드로 부른다 — this 가 ctx', async () => {
    const r = await runWithMethodDispatcher(undefined);
    expect(r.threw).toBeUndefined();
    expect(r.seen).toEqual(['owner:Read']);
  });
  test('상한 있음(자리 TUI): 같은 수신자 계약', async () => {
    const r = await runWithMethodDispatcher(SEAT);
    expect(r.threw).toBeUndefined();
    expect(r.seen).toEqual(['owner:Read']);
  });
});

describe('seat-turn-cap helpers', () => {
  test('config 파서: 양의 정수만 받고, 유효 칸 0 이면 undefined', () => {
    expect(parseSeatTurnCapConfig({ maxTools: 30, maxWallMs: 600_000 })).toEqual({ maxTools: 30, maxWallMs: 600_000 });
    expect(parseSeatTurnCapConfig({ maxTools: 0, maxWallMs: -1, idleEmptyMsgListLimit: 1.5 })).toBeUndefined();
    expect(parseSeatTurnCapConfig('x')).toBeUndefined();
    expect(parseSeatTurnCapConfig(null)).toBeUndefined();
  });
  test('빈 우편 판정은 MsgList 구조체 count 만 본다 · sleep 판정', () => {
    expect(isEmptyMailListResult('MsgList', { count: 0, messages: [] })).toBe(true);
    expect(isEmptyMailListResult('msg_list', { count: 2 })).toBe(false);
    expect(isEmptyMailListResult('RunShell', { count: 0 })).toBe(false);
    // count 없이 messages 만 빈 결과는 «빈 우편» 으로 추정하지 않는다(리뷰 r1).
    expect(isEmptyMailListResult('MsgList', { messages: [] })).toBe(false);
    expect(isIdleWaitCall('RunShell', { command: 'sleep 60' })).toBe(true);
    expect(isIdleWaitCall('Bash', { command: 'sleep 5m;' })).toBe(true);
    expect(isIdleWaitCall('RunShell', { command: 'sleep 60 && eln msg list' })).toBe(false);
    // 반증(리뷰 r2) — 셸이 아닌 도구가 command:'sleep 60' 을 받아도 대기로 보지 않는다.
    expect(isIdleWaitCall('PtyShellSend', { command: 'sleep 60' })).toBe(false);
  });
});
