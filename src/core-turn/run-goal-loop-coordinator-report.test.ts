// ELN-OP-CHARACTER — 조율자(OP) 자리의 목표 루프는 «한 것 · 남은 것 · 증거» 3단 최종 보고 틀을 강제하지 않는다
// (사람이 그 형식을 요청할 때만). 손 자리 자리 턴은 종전 틀 그대로. 기대값 = 독립 리터럴.
// ⛔ mock.module 없음 — runTurn 주입 seam 만 쓴다.
import { describe, expect, test } from 'bun:test';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import type { LLMMessage } from '../llm.js';
import { runGoalLoop } from './run-goal-loop.js';
import { SEAT_TURN_CAP_DEFAULTS } from './seat-turn-cap.js';

// 상한 값은 시험 입력(기대값 아님) — 기본 상한 한 벌을 그대로 쓴다.
const CAP = SEAT_TURN_CAP_DEFAULTS;

async function drive(seat: string | null, maxIterations: number): Promise<string[]> {
  const seen: string[] = [];
  let calls = 0;
  const ctx = {
    sessionId: `coord-report-${seat ?? 'none'}`,
    messages: [{ role: 'user', content: '네 편 영상 재촬영' }],
    tools: [],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
  } as unknown as CoreTurnContext;
  await runGoalLoop(ctx, {
    maxIterations,
    changedFiles: () => [],
    controlSpaceId: null,
    intentStallProvider: null,
    attachLifecycleBridge: () => () => {},
    startLivenessHeartbeat: () => () => {},
    ...(seat ? { seatTurnCap: { seat, ...CAP } } : {}),
    runTurn: async (turnCtx) => {
      calls += 1;
      seen.push(...turnCtx.messages.map((m: LLMMessage) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
      turnCtx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: `r${calls}`, name: 'Read', input: { file_path: `x${calls}` } }] }]);
      return { stopReason: 'end_turn', finalText: `진행 ${calls}` } satisfies CoreTurnResult;
    },
  });
  return seen;
}

describe('coordinator goal loop report shape', () => {
  test('OP seat: no forced 3-part final report; short factual report instead', async () => {
    const seen = (await drive('OP', 2)).join('\n');
    expect(seen).not.toContain('한 것 · 남은 것 · 확인한 증거');
    expect(seen).not.toContain('최종 보고(한 것 · 남은 것 · 증거)');
    expect(seen).toContain('결론 먼저');
    expect(seen).toContain('사람이 그 형식을 요청했을 때만');
  });

  test('OP seat with a single iteration: last-iteration note is the coordinator one', async () => {
    const seen = (await drive('OP', 1)).join('\n');
    expect(seen).not.toContain('한 것 · 남은 것 · 확인한 증거');
    expect(seen).toContain('[last iteration]');
  });

  test('hand seat (TC) and non-seat: current 3-part template unchanged', async () => {
    for (const seat of ['TC', null]) {
      const seen = (await drive(seat, 2)).join('\n');
      expect(seen).toContain('한 것 · 남은 것 · 확인한 증거');
      expect(seen).toContain('최종 보고(한 것 · 남은 것 · 증거)');
      expect(seen).not.toContain('사람이 그 형식을 요청했을 때만');
    }
  });
});
