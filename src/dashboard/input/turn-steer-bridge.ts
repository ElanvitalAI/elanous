// ── TUI typeahead 큐 ↔ 턴 «안» 주입 레지스트리 다리 (10-14 중복 수리) ────────────
//
// 🚨 무엇을 푸는가: 턴 중 Enter 한 발화는 ⓐ TUI 큐(턴 종료 뒤 새 프롬프트)와 ⓑ 레지스트리
//   (다음 도구 경계에서 도는 턴 안으로) «두 곳»에 든다. 한쪽이 가져가면 다른 쪽에서도 지워야 하는데
//   레지스트리 쪽 비우기 운영 호출이 0이라 같은 발화가 두 번 들어갔다:
//     ① 마지막 바퀴에 도구 호출이 없어 배수 기회가 없으면 → 턴 종료 승격 ⊕ 다음 턴 둘째 바퀴 배수
//     ② Ctrl+↑ 되꺼내기 → 고치기 전 문면이 레지스트리에 남아 모델로
//     ③ Esc 중단 복원 → composer 로 돌아간 글이 다음 턴에 또
//   그리고 배수 통지가 «앞에서부터 N개» 떨어내 같은 버킷의 남의 항목(goal-loop 메모)만큼 엉뚱한 대기 발화를 지웠다.
// ⭐ 짝은 «레지스트리 id» 하나로 맞춘다 — 위치·문자열로 맞추지 않는다.
// ⛔ 이 모듈은 상태 전이와 레지스트리 호출만 한다. 화면·로그는 호출측(대시보드)이 받는다.

import {
  attachTurnTypeaheadPendingId,
  drainedIntoTurn,
  drainTurnTypeaheadOnce,
  isTurnTypeaheadSteerable,
  type TurnTypeaheadState,
} from '../../chat/turn-typeahead.js';
import { debug } from '../../debug/log.js';
import {
  enqueuePendingUserInput,
  removePendingUserInput,
  type PendingUserInputRemovalReason,
} from '../../session/pending-input.js';

export interface TurnTypeaheadRef {
  state: TurnTypeaheadState;
}

export interface SteerDrainedEvent {
  /** 이 TUI 큐에서 실제로 떨어낸(=턴 안으로 들어간) 발화 — 남의 항목은 빠진다. */
  texts: string[];
  remaining: number;
}

/**
 * 큐 «마지막» 항목(방금 Enter 한 것)을 레지스트리에도 넣고 id 를 짝짓는다.
 * 슬래시·빈 글·세션 없음이면 넣지 않는다(턴 종료 FIFO 로만 간다). 넣었으면 id 를 낸다.
 */
export function steerLastTurnTypeaheadSubmission(
  ref: TurnTypeaheadRef,
  sessionId: string | null | undefined,
  onDrained: (event: SteerDrainedEvent) => void,
): string | null {
  const index = ref.state.queuedSubmissions.length - 1;
  const text = ref.state.queuedSubmissions[index];
  if (!sessionId || text === undefined || !isTurnTypeaheadSteerable(text)) return null;
  const id = enqueuePendingUserInput(sessionId, text, (drained, items) => {
    const result = drainedIntoTurn(ref.state, drained, items);
    ref.state = result.state;
    onDrained({ texts: result.matched, remaining: result.state.queuedSubmissions.length });
  });
  if (id) {
    ref.state = attachTurnTypeaheadPendingId(ref.state, index, id);
    debug.log('dashboard.turn-typeahead', 'queued', { id, length: text.length });
  }
  return id;
}

/**
 * 큐를 «다른 길»로 떠난 항목(턴 종료 승격·되꺼내기·중단 복원)을 레지스트리에서도 떨어낸다.
 * ⭐ 턴 종료 승격(`submitted-as-prompt`)은 «주입 한 번»이다 — 경계 배수(`llm.interjection drained {ids}`)와
 *   합쳐 id 별 주입 횟수를 센다(RFC v2 P1 ⓒ). 그래서 그 id 를 따로 남긴다.
 */
export function releaseTurnTypeaheadPending(
  ids: readonly string[] | undefined,
  reason: PendingUserInputRemovalReason = 'unspecified',
): number {
  if (!ids || ids.length === 0) return 0;
  if (reason === 'submitted-as-prompt') {
    for (const id of ids) debug.log('dashboard.turn-typeahead', 'submitted-as-prompt', { id });
  }
  return removePendingUserInput(ids, reason);
}

/**
 * 턴 종료 핸드오프 한 걸음 — 큐 드레인 → 레지스트리 해제 → (승격이면) Enter 주입.
 * ⭐ 대시보드 inner-loop 가 «이 함수»를 부른다 — 시험이 같은 순서를 베끼지 않고 실제 경로를 문다.
 *   ⛔ 해제는 Enter «전»이다: Enter 가 composer 를 거쳐 새 프롬프트로 나가는 순간 레지스트리에 남아 있으면
 *   그 턴 둘째 바퀴 배수에 같은 발화가 «또» 들어간다.
 */
export function handoffTurnTypeaheadAtTurnEnd(
  ref: TurnTypeaheadRef,
  carriedInitial: string | null | undefined,
  opts: { interrupted: boolean },
  injectEnter: () => void,
): ReturnType<typeof drainTurnTypeaheadOnce> {
  const drained = drainTurnTypeaheadOnce(ref.state, carriedInitial, opts);
  ref.state = drained.state;
  releaseTurnTypeaheadPending(drained.releasedPendingIds, drained.injectEnter ? 'submitted-as-prompt' : 'restored-after-interrupt');
  if (drained.injectEnter) injectEnter();
  return drained;
}
