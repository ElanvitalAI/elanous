// SEAT-HUMAN-GOAL-PIN 배선 회귀(실제 경로 — JUD-B HOLD judb-39578-bccca2bc8dbb 필수 ①② · OP #131042/#131052)
//   ① 사람 출처는 직렬화 경로에서 생략되지 않는다 — entry → local-chat-turn(직렬화) → repl(parseMessageSource) → chat(핀 판별).
//      runLocalChatTurn.turn 이 만드는 payload 가 사람 from 을 살려야 한다(fail-closed 유지: 누락 = 사람 아님).
//   ② 핀 해제는 update_goal complete(stopReason 'goal_complete' + via update_goal) 하나만 —
//      structured-final·상태 질문·빈 우편 턴의 goalComplete=true 는 핀을 풀지 않는다.
// 이 파일이 수리 전 RED: ① 현재 payload 는 human 을 생략하고 ② chat 은 gl.goalComplete 전체로 해제한다.
import { describe, expect, test } from 'bun:test';
import type { MessageSource } from '../session/index.js';
import { parseMessageSource } from '../session/index.js';
import { serializeTurnPayload, shouldReleasePinForGoalLoop } from './local-chat-turn-goalpin-wire.js';

describe('SEAT-HUMAN-GOAL-PIN — 실경로 배선 회귀 (HOLD 필수 ①②)', () => {
  test('구조화 작업 참조와 사람 출처 및 부모 목표를 함께 직렬화한다', () => {
    const workReferences = [{ kind: 'cell' as const, id: 'CELL-X', version: '0.3.33' }];
    const payload = JSON.parse(serializeTurnPayload({ prompt: '조사', from: { kind: 'human' }, parentPinnedGoal: '목표', workReferences }));
    expect(payload.workReferences).toEqual(workReferences);
    expect(payload.from.kind).toBe('human');
    expect(payload.parentPinnedGoal).toBe('목표');
    expect(JSON.parse(serializeTurnPayload({ prompt: '다음' })).workReferences).toBeUndefined();
  });
  test('① 사람 출처 payload 생존 — local-chat-turn 직렬화에서 from.kind=human 이 살아 repl parseMessageSource 가 본다', () => {
    const human: MessageSource = { kind: 'human' };
    const payload = JSON.parse(serializeTurnPayload({ prompt: '사람이 친 줄', from: human }));
    expect(parseMessageSource(payload.from)?.kind).toBe('human'); // 직렬화가 human 을 생략하면 undefined(RED)
    const notice: MessageSource = { kind: 'system', origin: 'queue-notice' };
    const noticePayload = JSON.parse(serializeTurnPayload({ prompt: 'OP 우편 도착', from: notice }));
    expect(parseMessageSource(noticePayload.from)?.kind).toBe('system');
    // from 미전달(구형 caller)은 여전히 생략 — fail-closed 는 유지된다.
    const absent = JSON.parse(serializeTurnPayload({ prompt: '출처 모름', from: undefined }));
    expect(absent.from).toBeUndefined();
    expect(parseMessageSource(absent.from)).toBeUndefined();
  });

  test('② 핀 해제 조건 — update_goal 경로(goal_complete·via update_goal)만 해제, structured-final·상태질문은 유지', () => {
    expect(shouldReleasePinForGoalLoop({ stopReason: 'goal_complete', completionVia: 'update_goal' })).toBe(true);
    expect(shouldReleasePinForGoalLoop({ stopReason: 'goal_complete', completionVia: 'structured-final-phase' })).toBe(false);
    expect(shouldReleasePinForGoalLoop({ stopReason: 'goal_complete', completionVia: 'status-question-final-answer' })).toBe(false);
    expect(shouldReleasePinForGoalLoop({ stopReason: 'waiting', completionVia: undefined })).toBe(false);
    expect(shouldReleasePinForGoalLoop({ stopReason: 'soft_stop', completionVia: undefined })).toBe(false);
    expect(shouldReleasePinForGoalLoop({ stopReason: 'goal_complete', completionVia: undefined })).toBe(false); // 마커 등 다른 완료 경로
  });
});
