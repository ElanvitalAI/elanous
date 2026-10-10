/**
 * GOAL-LOOP-INTENT-STALL (0.2.24 · OP or-audit-1010) — OpenRouter 구현 자식이 도구를 한 번도 안 부르고
 * 말만 한 턴을 «실제로 도구를 호출하라»로 최대 2번 재촉한다. 다른 provider 는 종전 그대로(텍스트 수용).
 * ⛔ mock.module 없음 — runTurn·changedFiles 주입 seam 과 debug.log 교체만 쓴다.
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import {
  GOAL_CONTINUATION_PROMPT,
  GOAL_INTENT_STALL_MAX_REPROMPTS,
  GOAL_INTENT_STALL_PROMPT,
  runGoalLoop,
  type GoalLoopOptions,
} from './run-goal-loop.js';

const STALL_TEXT = '먼저 파일을 읽겠습니다';

function baseCtx(): CoreTurnContext {
  return {
    sessionId: 'intent-stall',
    messages: [{ role: 'user', content: 'implement x' }],
    tools: [],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
  } as CoreTurnContext;
}

type Turn = { text: string; messages?: LLMMessage[] };

const readFileUse: LLMMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/x.ts' } }],
};
const completeUse: LLMMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'g1', name: 'update_goal', input: { status: 'complete', evidence: 'x 구현 · 시험 통과' } }],
};

async function drive(turns: readonly Turn[], opts: GoalLoopOptions) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const lastUserMessages: unknown[] = [];
  let calls = 0;
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') events.push({ event, data });
  }) as typeof debug.log;
  try {
    const result = await runGoalLoop(baseCtx(), {
      maxIterations: 8,
      changedFiles: () => [],
      controlSpaceId: null,
      ...opts,
      runTurn: async (ctx) => {
        const turn = turns[Math.min(calls, turns.length - 1)]!;
        calls += 1;
        lastUserMessages.push([...ctx.messages].reverse().find((m) => m.role === 'user')?.content);
        if (turn.messages) ctx.callbacks?.onTurnComplete?.(turn.messages);
        return { stopReason: 'end_turn', finalText: turn.text } satisfies CoreTurnResult;
      },
    });
    const count = (name: string) => events.filter((e) => e.event === name).length;
    return { result, events, count, calls, lastUserMessages };
  } finally {
    debug.log = originalLog;
  }
}

describe('GOAL-LOOP-INTENT-STALL — OpenRouter 한정 재촉', () => {
  test('상한은 2 이고 재촉 문면은 새 상수 하나다', () => {
    expect(GOAL_INTENT_STALL_MAX_REPROMPTS).toBe(2);
    expect(GOAL_INTENT_STALL_PROMPT).toContain('도구를 호출');
    expect(GOAL_INTENT_STALL_PROMPT).not.toBe(GOAL_CONTINUATION_PROMPT);
  });

  for (const provider of ['openai-codex', 'grok', 'anthropic', null] as const) {
    test(`(a) provider=${provider} — 텍스트만 낸 첫 턴은 오늘처럼 바로 text-only-accept (재촉 0)`, async () => {
      const r = await drive([{ text: STALL_TEXT }], { intentStallProvider: provider });
      expect(r.calls).toBe(1);
      expect(r.count('intent-stall-reprompt')).toBe(0);
      expect(r.count('intent-stall-exhausted')).toBe(0);
      expect(r.count('text-only-accept')).toBe(1);
      expect(r.result).toEqual({ finalText: STALL_TEXT, iterations: 1, stopReason: 'end_turn', goalComplete: false });
    });
  }

  test('(a) 생략 시 비-executor 프로세스는 ELANOUS_LLM_PROVIDER=openrouter 여도 가드가 꺼져 오늘과 같다', async () => {
    const prevRole = process.env.ELANOUS_HARNESS_ROLE;
    const prevProvider = process.env.ELANOUS_LLM_PROVIDER;
    process.env.ELANOUS_HARNESS_ROLE = 'coordinator';
    process.env.ELANOUS_LLM_PROVIDER = 'openrouter';
    try {
      const r = await drive([{ text: STALL_TEXT }], {});
      expect(r.calls).toBe(1);
      expect(r.count('intent-stall-reprompt')).toBe(0);
      expect(r.result).toEqual({ finalText: STALL_TEXT, iterations: 1, stopReason: 'end_turn', goalComplete: false });
      const start = r.events.find((e) => e.event === 'start');
      expect(start?.data).toMatchObject({ intentStallGuard: false });
    } finally {
      if (prevRole === undefined) delete process.env.ELANOUS_HARNESS_ROLE; else process.env.ELANOUS_HARNESS_ROLE = prevRole;
      if (prevProvider === undefined) delete process.env.ELANOUS_LLM_PROVIDER; else process.env.ELANOUS_LLM_PROVIDER = prevProvider;
    }
  });

  test('(b) 생략 시 executor 프로세스는 ELANOUS_LLM_PROVIDER=openrouter 릴레이로 가드가 켜진다', async () => {
    const prev = { role: process.env.ELANOUS_HARNESS_ROLE, provider: process.env.ELANOUS_LLM_PROVIDER };
    process.env.ELANOUS_HARNESS_ROLE = 'executor';
    process.env.ELANOUS_LLM_PROVIDER = 'openrouter';
    try {
      const r = await drive([{ text: STALL_TEXT }, { text: '읽었습니다', messages: [readFileUse] }, { text: '완료', messages: [completeUse] }], {});
      expect(r.events.find((e) => e.event === 'start')?.data).toMatchObject({ intentStallGuard: true, intentStallProvider: 'openrouter' });
      expect(r.count('intent-stall-reprompt')).toBe(1);
      expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true });
    } finally {
      for (const [k, v] of [['ELANOUS_HARNESS_ROLE', prev.role], ['ELANOUS_LLM_PROVIDER', prev.provider]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('(a) executor 가 provider 를 못 풀면 경고를 남기고 가드를 끈다(fail-open = 오늘과 같다)', async () => {
    const prev = { role: process.env.ELANOUS_HARNESS_ROLE, provider: process.env.ELANOUS_LLM_PROVIDER };
    process.env.ELANOUS_HARNESS_ROLE = 'executor';
    process.env.ELANOUS_LLM_PROVIDER = 'not-a-provider';
    try {
      const r = await drive([{ text: STALL_TEXT }], {});
      expect(r.count('intent-stall-provider-unresolved')).toBe(1);
      expect(r.events.find((e) => e.event === 'start')?.data).toMatchObject({ intentStallGuard: false, intentStallProvider: null });
      expect(r.count('intent-stall-reprompt')).toBe(0);
      expect(r.result).toEqual({ finalText: STALL_TEXT, iterations: 1, stopReason: 'end_turn', goalComplete: false });
    } finally {
      for (const [k, v] of [['ELANOUS_HARNESS_ROLE', prev.role], ['ELANOUS_LLM_PROVIDER', prev.provider]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('(b) 텍스트가 아예 빈 턴도 도구 0회면 같은 정체로 보고 재촉한다', async () => {
    const r = await drive([{ text: '' }, { text: '읽었습니다', messages: [readFileUse] }, { text: '완료', messages: [completeUse] }], { intentStallProvider: 'openrouter' });
    expect(r.count('intent-stall-reprompt')).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true });
  });

  test('(b) openrouter — 텍스트만 → 재촉 → 도구 호출 → 완료로 진행한다', async () => {
    const r = await drive([
      { text: STALL_TEXT },
      { text: '읽었습니다', messages: [readFileUse] },
      { text: '완료', messages: [completeUse] },
    ], { intentStallProvider: 'openrouter' });
    expect(r.calls).toBe(3);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 3 });
    expect(r.lastUserMessages[1]).toBe(GOAL_INTENT_STALL_PROMPT);
    expect(r.lastUserMessages[2]).toBe(GOAL_CONTINUATION_PROMPT);
    expect(r.count('intent-stall-reprompt')).toBe(1);
    expect(r.count('intent-stall-exhausted')).toBe(0);
    expect(r.count('text-only-accept')).toBe(0);
    const reprompt = r.events.find((e) => e.event === 'intent-stall-reprompt');
    expect(reprompt?.data).toMatchObject({ attempt: 1, iterations: 1, finalChars: STALL_TEXT.length, provider: 'openrouter' });
  });

  test('(c) openrouter — 텍스트만 ×3 → 재촉 2번 뒤 오늘과 같은 포기 ⊕ exhausted 이벤트', async () => {
    const r = await drive([{ text: STALL_TEXT }], { intentStallProvider: 'openrouter' });
    expect(r.calls).toBe(3);
    expect(r.count('intent-stall-reprompt')).toBe(2);
    expect(r.events.filter((e) => e.event === 'intent-stall-reprompt').map((e) => e.data.attempt)).toEqual([1, 2]);
    expect(r.count('intent-stall-exhausted')).toBe(1);
    expect(r.count('text-only-accept')).toBe(1);
    const order = r.events.map((e) => e.event).filter((e) => e.startsWith('intent-stall') || e === 'text-only-accept');
    expect(order).toEqual(['intent-stall-reprompt', 'intent-stall-reprompt', 'intent-stall-exhausted', 'text-only-accept']);
    expect(r.result).toEqual({ finalText: STALL_TEXT, iterations: 3, stopReason: 'end_turn', goalComplete: false });
  });

  test('(c) openrouter — 재촉 턴도 maxIterations 에 센다(하드캡이 이긴다)', async () => {
    const r = await drive([{ text: STALL_TEXT }], { intentStallProvider: 'openrouter', maxIterations: 2 });
    expect(r.calls).toBe(2);
    expect(r.count('intent-stall-reprompt')).toBe(2);
    expect(r.result).toMatchObject({ stopReason: 'max_iterations', goalComplete: false, iterations: 2 });
  });

  // GOAL-LOOP-MIDRUN-STALL 이 이 계약을 바꿨다 — 도구 «뒤»의 말뿐인 턴은 런당 1회 재촉한다(상세 = run-goal-loop-midrun-stall.test.ts).
  test('(d) openrouter — 도구를 부른 뒤의 텍스트만 턴은 ④-0(도구 0회) 재촉이 아니라 중간 재촉 1회 뒤 수용한다', async () => {
    const r = await drive([
      { text: '읽었습니다', messages: [readFileUse] },
      { text: '설명만 합니다' },
    ], { intentStallProvider: 'openrouter' });
    expect(r.calls).toBe(3);
    expect(r.lastUserMessages[1]).toBe(GOAL_CONTINUATION_PROMPT);
    expect(r.lastUserMessages[2]).toBe(GOAL_INTENT_STALL_PROMPT);
    expect(r.count('intent-stall-reprompt')).toBe(0);
    expect(r.count('intent-stall-exhausted')).toBe(0);
    expect(r.count('intent-stall-midrun')).toBe(1);
    expect(r.count('text-only-accept')).toBe(1);
    expect(r.result).toEqual({ finalText: '설명만 합니다', iterations: 3, stopReason: 'end_turn', goalComplete: false });
  });

  test('(d) codex — 같은 순서에서 가드가 꺼진 provider 는 오늘처럼 바로 수용한다(재촉 0)', async () => {
    const turns: Turn[] = [{ text: '읽었습니다', messages: [readFileUse] }, { text: '설명만 합니다' }];
    const cx = await drive(turns, { intentStallProvider: 'openai-codex' });
    expect(cx.calls).toBe(2);
    expect(cx.count('intent-stall-midrun')).toBe(0);
    expect(cx.count('intent-stall-reprompt')).toBe(0);
    expect(cx.result).toEqual({ finalText: '설명만 합니다', iterations: 2, stopReason: 'end_turn', goalComplete: false });
  });
});
