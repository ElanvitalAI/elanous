// SEAT-HUMAN-GOAL-PIN 배선 순수 모듈 (JUD-B HOLD judb-39578-bccca2bc8dbb · OP #131042/#131052)
//   ① 사람 출처는 직렬화에서 생략되지 않는다(openerKind 끝까지 전달 · 누락 = 사람 아님 유지).
//   ② 핀 해제는 update_goal complete 하나만 — 골 루프의 goalComplete=true(structured-final·상태질문·빈 우편)는 핀을 풀지 않는다.
import type { MessageSource } from '../session/index.js';

/** 골 루프 종결의 완료 경로(via) — run-goal-loop debug 'complete' 로그의 via 값. */
export type GoalCompletionVia = 'update_goal' | 'structured-final-phase' | 'status-question-final-answer';

export interface SerializedTurnInput {
  readonly prompt: string;
  readonly id?: string;
  readonly from?: MessageSource;
  readonly modelTier?: string;
  readonly sessionProvider?: unknown;
  readonly attachments?: readonly string[];
  readonly workReferences?: readonly import('../core-turn/seat-owner-check.js').WorkReference[];
  /** SEAT-HUMAN-GOAL-PIN ④ — 부모(TUI)가 소유한 핀 목표. 사람 줄이 아닌 턴에만 실린다(child 교체/재기동 뒤 복구). */
  readonly parentPinnedGoal?: string;
}

/**
 * ① 출처 직렬화(실경로 — local-chat-turn.turn 이 쓴다): 사람 출처도 from 으로 살아간다.
 *    MSG-SOURCE-HIERARCHY 정정(OP #131042): «사람은 기본이라 생략»은 핀 fail-closed 와 충돌한다 —
 *    출처는 from 문자열 유무가 아니라 구조화 필드로 끝까지 전달된다. 누락(undefined)은 여전히 생략(fail-closed).
 */
export function serializeTurnPayload(input: SerializedTurnInput): string {
  return JSON.stringify({
    prompt: input.prompt,
    ...(input.id ? { id: input.id } : {}),
    ...(input.modelTier ? { modelTier: input.modelTier } : {}),
    ...(input.sessionProvider ? { sessionProvider: input.sessionProvider } : {}),
    ...(input.attachments && input.attachments.length ? { attachments: input.attachments } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.workReferences ? { workReferences: input.workReferences } : {}),
    ...(input.parentPinnedGoal !== undefined ? { parentPinnedGoal: input.parentPinnedGoal } : {}),
  });
}

/**
 * ② 핀 해제 판정: 목표 완료 선언(update_goal complete)만 핀을 푼다.
 *    골 루프가 goalComplete=true 로 닫는 다른 경로(structured-final-phase — 대형 보고 종결,
 *    status-question-final-answer — 상태 질문 한 줄 답, 마커 등)는 «그 턴의 종결»이지
 *    «고정 목표의 완료 선언»이 아니다 — 핀은 유지된다(OP #131052).
 */
export function shouldReleasePinForGoalLoop(result: {
  readonly stopReason: string;
  readonly completionVia?: GoalCompletionVia;
}): boolean {
  return result.stopReason === 'goal_complete' && result.completionVia === 'update_goal';
}

/**
 * ③ 답이 나간 사람 턴의 핀 해제(GOAL-PIN-RELEASE): 사람 줄이 연 턴이 답을 내고 끝났고 활성 골 루프(goalStopReason)가
 *    없으면 그 줄은 이미 처리됐다 — 상태줄에 지시처럼 남기지 않는다. 알림 턴(사람 아님)은 해제하지 않는다.
 */
export function shouldReleasePinAfterAnsweredTurn(turn: {
  readonly from?: MessageSource;
  readonly answered: boolean;
  readonly goalStopReason?: string;
}): boolean {
  return turn.from?.kind === 'human' && turn.answered && (turn.goalStopReason === undefined || turn.goalStopReason === '');
}
