/**
 * GOAL-LOOP-MIDRUN-STALL-1 (0.2.24) — 도구를 한 번 이상 쓴 «뒤» 도구 없는 텍스트 턴(「이제 X 를 고치겠다」)으로
 * 끝나면, 일상 답변으로 수락하기 전에 같은 GOAL_INTENT_STALL_PROMPT 재촉을 런당 1회 넣는다.
 * 두 번째 중간 정체는 종전대로 text-only-accept. 가드가 꺼진 provider 는 바이트 동일.
 * ⛔ mock.module 없음 — runTurn·changedFiles 주입 seam 과 debug.log 교체만 쓴다(intent-stall 시험과 같은 틀).
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import {
  GOAL_CONTINUATION_PROMPT,
  GOAL_INTENT_STALL_PROMPT,
  runGoalLoop,
  type GoalLoopOptions,
} from './run-goal-loop.js';

const MIDRUN_TEXT = '파일을 읽었습니다. 이제 수정하겠습니다';

function baseCtx(): CoreTurnContext {
  return {
    sessionId: 'midrun-stall',
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
const editFileUse: LLMMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'e1', name: 'edit_file', input: { path: 'src/x.ts' } }],
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

describe('GOAL-LOOP-MIDRUN-STALL — 도구 뒤 말뿐인 턴 재촉(런당 1회)', () => {
  test('도구 1회 뒤 텍스트만 → intent-stall-midrun 1회 ⊕ 재촉 메시지 1개 ⊕ 다시 텍스트만이면 text-only-accept', async () => {
    const r = await drive([
      { text: '읽었습니다', messages: [readFileUse] },
      { text: MIDRUN_TEXT },
      { text: MIDRUN_TEXT },
    ], { intentStallProvider: 'openrouter' });
    expect(r.calls).toBe(3);
    expect(r.count('intent-stall-midrun')).toBe(1);
    expect(r.lastUserMessages.filter((m) => m === GOAL_INTENT_STALL_PROMPT)).toHaveLength(1);
    expect(r.lastUserMessages[2]).toBe(GOAL_INTENT_STALL_PROMPT);
    // 도구 0회 재촉(④-0)과는 배타 — 그 이벤트는 안 난다.
    expect(r.count('intent-stall-reprompt')).toBe(0);
    expect(r.count('intent-stall-exhausted')).toBe(0);
    expect(r.count('text-only-accept')).toBe(1);
    const order = r.events.map((e) => e.event).filter((e) => e.startsWith('intent-stall') || e === 'text-only-accept');
    expect(order).toEqual(['intent-stall-midrun', 'text-only-accept']);
    const midrun = r.events.find((e) => e.event === 'intent-stall-midrun');
    expect(midrun?.data).toMatchObject({
      sessionId: 'midrun-stall', iterations: 2, finalChars: MIDRUN_TEXT.length, provider: 'openrouter',
    });
    expect(r.result).toEqual({ finalText: MIDRUN_TEXT, iterations: 3, stopReason: 'end_turn', goalComplete: false });
  });

  test('재촉 뒤 도구를 다시 부르면 진행하고, 이후 두 번째 중간 정체는 재촉 없이 text-only-accept(런당 1회)', async () => {
    const r = await drive([
      { text: '읽었습니다', messages: [readFileUse] },
      { text: MIDRUN_TEXT },
      { text: '고쳤습니다', messages: [editFileUse] },
      { text: '설명만 합니다' },
    ], { intentStallProvider: 'openrouter' });
    expect(r.calls).toBe(4);
    expect(r.count('intent-stall-midrun')).toBe(1);
    expect(r.lastUserMessages).toEqual([
      'implement x', GOAL_CONTINUATION_PROMPT, GOAL_INTENT_STALL_PROMPT, GOAL_CONTINUATION_PROMPT,
    ]);
    expect(r.count('text-only-accept')).toBe(1);
    expect(r.result).toEqual({ finalText: '설명만 합니다', iterations: 4, stopReason: 'end_turn', goalComplete: false });
  });

  test('재촉 뒤 도구 호출 → update_goal 완료 경로는 그대로 goal_complete', async () => {
    const r = await drive([
      { text: '읽었습니다', messages: [readFileUse] },
      { text: MIDRUN_TEXT },
      { text: '완료', messages: [editFileUse, completeUse] },
    ], { intentStallProvider: 'openrouter' });
    expect(r.count('intent-stall-midrun')).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 3 });
  });

  test('재촉 턴도 maxIterations 에 센다(하드캡이 이긴다)', async () => {
    const r = await drive([
      { text: '읽었습니다', messages: [readFileUse] },
      { text: MIDRUN_TEXT },
    ], { intentStallProvider: 'openrouter', maxIterations: 2 });
    expect(r.calls).toBe(2);
    expect(r.count('intent-stall-midrun')).toBe(1);
    expect(r.count('text-only-accept')).toBe(0);
    expect(r.result).toMatchObject({ stopReason: 'max_iterations', goalComplete: false, iterations: 2 });
  });

  for (const provider of ['openai-codex', 'grok', 'anthropic', null] as const) {
    test(`가드 꺼짐(provider=${provider}) — 도구 뒤 텍스트만 턴은 재촉 0 · 오늘처럼 바로 text-only-accept`, async () => {
      const r = await drive([
        { text: '읽었습니다', messages: [readFileUse] },
        { text: MIDRUN_TEXT },
      ], { intentStallProvider: provider });
      expect(r.calls).toBe(2);
      expect(r.count('intent-stall-midrun')).toBe(0);
      expect(r.lastUserMessages).not.toContain(GOAL_INTENT_STALL_PROMPT);
      expect(r.count('text-only-accept')).toBe(1);
      expect(r.result).toEqual({ finalText: MIDRUN_TEXT, iterations: 2, stopReason: 'end_turn', goalComplete: false });
    });
  }

  test('도구 0회 정체는 기존 ④-0 경로(intent-stall-reprompt)로만 가고 midrun 은 안 난다', async () => {
    const r = await drive([{ text: '먼저 파일을 읽겠습니다' }], { intentStallProvider: 'openrouter' });
    expect(r.count('intent-stall-reprompt')).toBe(2);
    expect(r.count('intent-stall-exhausted')).toBe(1);
    expect(r.count('intent-stall-midrun')).toBe(0);
  });
});
