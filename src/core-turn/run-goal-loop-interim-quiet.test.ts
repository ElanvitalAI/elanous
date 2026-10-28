/**
 * TUI-GOAL-INTERIM-QUIET (0.2.36 · 대표 10-22) — 골이 열린 동안 반복마다 최종 보고형 문단(«…보고할 수 없습니다»)이
 * 쌓이던 구조. 계약: 중간 답은 진행 한 줄 · 최종 보고는 complete|blocked 또는 마지막 반복에서 한 번 · 반복마다 관측 칸.
 * ⛔ mock.module 없음 — runTurn 주입 seam 과 debug.log 교체만 쓴다.
 */
import { describe, expect, test } from 'bun:test';
import type { CoreTurnCallbacks, CoreTurnContext, CoreTurnResult } from './types.js';
import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { DELEGATE_HINT } from '../agent/delegate-hint.js';
import {
  GOAL_CONTINUATION_PROMPT,
  GOAL_FINAL_ITERATION_NOTE,
  GOAL_INTERIM_REPLY_RULE,
  GOAL_SYSTEM_PREAMBLE,
  isInterimReportShaped,
  runGoalLoop,
} from './run-goal-loop.js';

const read = (i: number): LLMMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: `r${i}`, name: 'read_file', input: { path: `src/x${i}.ts` } }],
});

async function drive(texts: readonly string[], maxIterations: number) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const userMessages: unknown[] = [];
  const turnMessages: LLMMessage[][] = [];
  const interimSignals: Array<[string, number]> = [];
  let calls = 0;
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') events.push({ event, data });
  }) as typeof debug.log;
  try {
    const ctx = {
      sessionId: 'interim-quiet',
      messages: [{ role: 'user', content: '네 편 영상 재촬영' }],
      tools: [],
      dispatchTool: async () => null,
      signal: new AbortController().signal,
      callbacks: { onGoalInterim: (text, iteration) => { interimSignals.push([text, iteration]); } } satisfies CoreTurnCallbacks,
    } as CoreTurnContext;
    const result = await runGoalLoop(ctx, {
      maxIterations,
      changedFiles: () => [],
      controlSpaceId: null,
      runTurn: async (turnCtx) => {
        const i = calls++;
        turnMessages.push([...turnCtx.messages]);
        userMessages.push([...turnCtx.messages].reverse().find((m) => m.role === 'user')?.content);
        turnCtx.callbacks?.onTurnComplete?.([read(i)]);
        return { stopReason: 'end_turn', finalText: texts[Math.min(i, texts.length - 1)]! } satisfies CoreTurnResult;
      },
    });
    return { result, events, userMessages, turnMessages, interimSignals, calls };
  } finally {
    debug.log = originalLog;
  }
}

describe('TUI-GOAL-INTERIM-QUIET', () => {
  test('계약: 첫 반복 계약과 매 반복 재주입 둘 다 «중간 답은 진행 한 줄»을 말한다', () => {
    expect(GOAL_SYSTEM_PREAMBLE).toContain(GOAL_INTERIM_REPLY_RULE);
    expect(GOAL_CONTINUATION_PROMPT).toContain('진행 한 줄');
    expect(GOAL_CONTINUATION_PROMPT).toContain('보고할 수 없습니다');
  });

  test('마지막 반복 직전에만 «최종 보고 한 번» 줄이 붙는다', async () => {
    const r = await drive(['과제1 렌더 끝 · 다음 과제2'], 3);
    expect(r.calls).toBe(3);
    expect(String(r.userMessages[1])).toBe(`${GOAL_CONTINUATION_PROMPT}\n${DELEGATE_HINT}`);
    expect(String(r.userMessages[2])).toBe(`${GOAL_CONTINUATION_PROMPT}\n${GOAL_FINAL_ITERATION_NOTE}`);
    expect(String(r.userMessages[1]).split(DELEGATE_HINT)).toHaveLength(2);
    expect(String(r.userMessages[2])).not.toContain(DELEGATE_HINT);
  });

  test('관측: 골이 계속 열린 재주입마다 interim-reply · 최종 보고형 답은 reportShaped=true · 진행 한 줄은 false', async () => {
    const r = await drive([
      '과제2·3 재촬영본은 완료되지 않았으므로 네 편의 최종 경로를 보고할 수 없습니다.',
      '과제3 RSS 노드 추가 · 다음 Limit 5 설정',
      '마지막',
    ], 3);
    const interim = r.events.filter((e) => e.event === 'interim-reply').map((e) => [e.data.reportShaped, e.data.lastIteration]);
    // r2 must-fix: 셋째(마지막) 반복 뒤엔 다음 반복이 없다 — 재주입도 관측도 없다.
    expect(r.calls).toBe(3);
    expect(interim).toEqual([[true, false], [false, true]]);
  });

  test('반복 경계: n8n형 복수 미완 답을 각 반복의 공용 접기 판정에 넘기고 마지막 답은 남긴다', async () => {
    const replies = ['1단계 렌더했습니다.\n아직 못 했습니다.', '2단계 렌더했습니다.\n아직 못 했습니다.', '최종 영상: /tmp/final.mp4'];
    const r = await drive(replies, 3);
    expect(r.events.filter((e) => e.event === 'interim-reply').map((e) => e.data.reportShaped)).toEqual([true, true]);
    expect(r.interimSignals).toEqual([[replies[0]!, 1], [replies[1]!, 2]]);
    expect(r.result.finalText).toBe(replies[2]);
    expect(r.interimSignals.some(([text]) => text === replies[2])).toBe(false);
  });

  test('반복 경계: 판정기 분류와 무관하게 다음 반복에 들어가는 답을 보내고 최종 답은 제외한다', async () => {
    const replies = ['1단계 렌더했습니다.\n아직 못 했습니다.', '2단계 렌더 결과를 확인했습니다.', '최종 영상: /tmp/final.mp4'];
    const r = await drive(replies, 3);
    expect(r.calls).toBe(3);
    expect(isInterimReportShaped(replies[1]!)).toBe(false);
    expect(r.interimSignals).toEqual([[replies[0]!, 1], [replies[1]!, 2]]);
    expect(r.result.finalText).toBe(replies[2]);
    expect(r.interimSignals.some(([text]) => text === replies[2])).toBe(false);
  });

  test('빈 값이나 공백만 있는 중간 응답은 화면 접기 신호를 만들지 않는다', async () => {
    const r = await drive([' \n\t ', '최종 답'], 2);
    expect(r.calls).toBe(2);
    expect(r.interimSignals).toEqual([]);
    expect(r.events.filter((e) => e.event === 'interim-reply').map((e) => e.data.finalChars)).toEqual([4]);
  });

  test('r2 반례: 상한에 닿은 뒤엔 소비되지 않을 재주입 메시지를 쌓지 않는다', async () => {
    const r = await drive(['과제1 렌더 끝 · 다음 과제2'], 2);
    expect(r.calls).toBe(2);
    expect(r.events.filter((e) => e.event === 'interim-reply')).toHaveLength(1);
    // 마지막 turn 이 본 history 의 끝 user 는 마지막 반복 줄이 붙은 재주입 하나뿐이다.
    const lastTurnUsers = r.turnMessages[1]!.filter((m) => m.role === 'user' && m.content === `${GOAL_CONTINUATION_PROMPT}\n${GOAL_FINAL_ITERATION_NOTE}\n${DELEGATE_HINT}`);
    expect(lastTurnUsers).toHaveLength(1);
  });

  test('r2 반례: maxIterations=1 — 재주입·관측 0 · 마지막 반복 줄은 첫 turn 앞 system 으로 한 번', async () => {
    const r = await drive(['아직 확인하지 못했습니다'], 1);
    expect(r.calls).toBe(1);
    expect(r.events.filter((e) => e.event === 'interim-reply')).toHaveLength(0);
    const first = r.turnMessages[0]!;
    expect(first[0]).toMatchObject({ role: 'system', content: GOAL_SYSTEM_PREAMBLE });
    expect(first.filter((m) => m.role === 'system' && m.content === GOAL_FINAL_ITERATION_NOTE)).toHaveLength(1);
    expect(String(r.userMessages[0])).toBe('네 편 영상 재촬영');
  });

  test('maxIterations>1 이면 첫 turn 앞에 마지막 반복 줄이 없다', async () => {
    const r = await drive(['과제1 렌더 끝 · 다음 과제2'], 3);
    expect(r.turnMessages[0]!.some((m) => m.content === GOAL_FINAL_ITERATION_NOTE)).toBe(false);
  });

  test('r1 반례: 완료 신호가 반려돼(텍스트 마커만) 다른 재주입이 가도 마지막 반복 줄이 붙고 관측도 남는다', async () => {
    // GOAL-COMPLETE 텍스트 마커만 = read-back 재주입(continuation 이 아니다).
    const r = await drive(['아직 확인하지 못했습니다\nGOAL-COMPLETE'], 2);
    const last = String(r.userMessages[1]);
    expect(last.startsWith('[finalize]')).toBe(true);
    expect(last.endsWith(`${GOAL_FINAL_ITERATION_NOTE}\n${DELEGATE_HINT}`)).toBe(true);
    const interim = r.events.filter((e) => e.event === 'interim-reply');
    expect(interim[0]!.data).toMatchObject({ reportShaped: true, lastIteration: true });
  });

  test('판별기 반례: 진행 한 줄·완료 문장은 최종 보고형이 아니다', () => {
    expect(isInterimReportShaped('과제1 MP4 재생 확인 · 다음 과제2 탭')).toBe(false);
    expect(isInterimReportShaped('아직 확인하지 못했습니다')).toBe(true);
    expect(isInterimReportShaped('Tests are not yet verified')).toBe(true);
  });
});
