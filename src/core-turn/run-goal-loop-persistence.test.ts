/**
 * ELN-PERSISTENCE-LADDER ③ 통합 — 목표 루프의 턴 상한 끊음은 «진척 없음» 기준만(§⑯ OP orders ELN-UNIVERSAL-AGENT-1124 §⑫).
 * 진척 = 새 파일 · 새 근거 · 새 산출(progressBeyondSignature). 완료 판정식 = update_goal(status=complete, evidence).
 * ⛔ mock.module 없음 — runTurn 주입 seam 과 debug.log 교체만 쓴다(intent-stall 관례).
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { runGoalLoop, type GoalLoopOptions } from './run-goal-loop.js';

function baseCtx(): CoreTurnContext {
  return {
    sessionId: 'persistence-ladder',
    messages: [{ role: 'user', content: 'implement x' }],
    tools: [],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
  } as CoreTurnContext;
}

type Turn = { text: string; messages?: LLMMessage[] };

const spinUse: LLMMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 's1', name: 'read_file', input: { path: 'src/x.ts' } }],
};
const completeUse: LLMMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'g1', name: 'update_goal', input: { status: 'complete', evidence: 'x 구현 · 시험 통과' } }],
};
function resultOf(id: string, content: string): LLMMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } as unknown as LLMMessage;
}

async function drive(turns: readonly Turn[], opts: GoalLoopOptions = {}) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let calls = 0;
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') events.push({ event, data });
  }) as typeof debug.log;
  try {
    const result = await runGoalLoop(baseCtx(), {
      maxIterations: 8, // 출처: #144681 — main runGoalLoop 기본 반복 하드캡(?? 8)과 동일한 고정값
      changedFiles: () => [],
      controlSpaceId: null,
      ...opts,
      runTurn: async (ctx) => {
        const turn = turns[Math.min(calls, turns.length - 1)]!;
        calls += 1;
        if (turn.messages) ctx.callbacks?.onTurnComplete?.(turn.messages);
        return { stopReason: 'end_turn', finalText: turn.text } satisfies CoreTurnResult;
      },
    });
    const count = (name: string) => events.filter((e) => e.event === name).length;
    return { result, events, count, calls };
  } finally {
    debug.log = originalLog;
  }
}

describe('ELN-PERSISTENCE-LADDER ③ — 목표 루프 진척 기준', () => {
  test('③-② 무진척 — 같은 도구만 반복(새 파일·근거·산출 0)은 noProgressLimit 에서 끊는다', async () => {
    const r = await drive([
      { text: 't1', messages: [spinUse] },
      { text: 't2', messages: [spinUse] },
      { text: 't3', messages: [spinUse] },
    ], { noProgressLimit: 2 });
    expect(r.result.stopReason).toBe('no_progress');
    expect(r.calls).toBe(3);
    expect(r.count('no-progress-stop')).toBe(1);
  });

  test('③-③ 진척 — 같은 시그니처여도 매번 새 결과 내용(새 근거·새 산출)이면 이어 돌아 완료 판정식까지 간다', async () => {
    const r = await drive([
      { text: 't1', messages: [spinUse, resultOf('s1', 'v1')] },
      { text: 't2', messages: [spinUse, resultOf('s1', 'v2-새-출력')] },
      { text: 't3', messages: [completeUse] },
    ], { noProgressLimit: 2 });
    expect(r.calls).toBe(3);
    expect(r.result.goalComplete).toBe(true);
    expect(r.count('no-progress-stop')).toBe(0);
  });

  test('③-① 무진척 도달 전 완료 판정식(update_goal complete)이면 그 턴에 루프가 끝난다', async () => {
    const r = await drive([
      { text: 't1', messages: [spinUse] },
      { text: 't2', messages: [spinUse] },
      { text: 't3', messages: [completeUse] },
    ], { noProgressLimit: 2 });
    expect(r.result.goalComplete).toBe(true);
    expect(r.count('no-progress-stop')).toBe(0);
  });

  test('③-④ 새 파일 쓰기 턴은 같은 도구 시그니처 반복 중에도 진척으로 본다', async () => {
    const writeUse: LLMMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'src/each-new.ts', content: 'z' } }],
    };
    const writeUse2: LLMMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: 'src/each-new-2.ts', content: 'z' } }],
    };
    const r = await drive([
      { text: 't1', messages: [writeUse] },
      { text: 't2', messages: [writeUse2] },
      { text: 't3', messages: [completeUse] },
    ], { noProgressLimit: 2 });
    expect(r.calls).toBe(3);
    expect(r.result.goalComplete).toBe(true);
  });
});