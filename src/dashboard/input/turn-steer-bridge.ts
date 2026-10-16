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
  markTurnTypeaheadPriority,
  turnTypeaheadPendingIds,
  type TurnTypeaheadState,
} from '../../chat/turn-typeahead.js';
import { canInterruptRunningTools } from '../../chat/tool-interrupt-behavior.js';
import { debug } from '../../debug/log.js';
import {
  enqueuePendingUserInput,
  prioritizePendingUserInput,
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

export type PushNowDecision =
  /** 대기 항목이 없다. */
  | { kind: 'nothing' }
  /** 도는 도구가 전부 끊어도 된다 — 턴만 끊고(자식은 산다) 턴 종료 FIFO 가 곧바로 그 발화로 잇는다. */
  | { kind: 'interrupt'; runningTools: string[] }
  /** 끊을 수 없는 도구가 돈다 — 다음 도구 경계에 최우선으로 넣는다. */
  | { kind: 'priority'; blockingTools: string[] }
  /** 끊을 수 없는 도구가 돌고, 대기 항목이 전부 경계에 못 들어간다(슬래시·세션 없음) — 응답 뒤에 나간다. */
  | { kind: 'deferred'; blockingTools: string[] };

/** «지금 밀어 넣기» 판정. 순수. */
export function decidePushNow(
  state: TurnTypeaheadState,
  runningToolNames: readonly string[],
): PushNowDecision {
  if (state.queuedSubmissions.length === 0) return { kind: 'nothing' };
  const { ok, blocking } = canInterruptRunningTools(runningToolNames);
  if (ok) return { kind: 'interrupt', runningTools: [...new Set(runningToolNames)].sort() };
  const steerable = turnTypeaheadPendingIds(state).some(id => typeof id === 'string');
  return steerable ? { kind: 'priority', blockingTools: blocking } : { kind: 'deferred', blockingTools: blocking };
}

/** 큐의 레지스트리 항목을 버킷 맨 앞으로 옮기고 상태에 «최우선»을 적는다. 옮긴 수를 낸다. */
export function prioritizeTurnTypeaheadPending(ref: TurnTypeaheadRef): number {
  const ids = turnTypeaheadPendingIds(ref.state).filter((id): id is string => typeof id === 'string');
  const moved = prioritizePendingUserInput(ids);
  ref.state = markTurnTypeaheadPriority(ref.state);
  return moved;
}

export interface PushNowDeps {
  /** 지금 도는 도구 이름(중복 허용). */
  runningToolNames: () => readonly string[];
  /** 턴만 끊는다(자식은 산다) — 호출측이 «밀어 넣기 사유»를 적어 턴 종료가 복원 대신 제출하게 한다. */
  interruptTurn: () => void;
  pushNotice: (line: string) => void;
}

/** «지금 밀어 넣기» 한 번 — 판정하고 끊거나 최우선으로 올린다. 판정을 낸다. */
export function runTurnTypeaheadPushNow(ref: TurnTypeaheadRef, deps: PushNowDeps): PushNowDecision {
  const decision = decidePushNow(ref.state, deps.runningToolNames());
  if (decision.kind === 'interrupt') {
    deps.pushNotice('  ⚡ 지금 밀어 넣기 — 도는 응답을 끊고 바로 이어서 보냅니다.');
    deps.interruptTurn();
  } else if (decision.kind === 'priority') {
    prioritizeTurnTypeaheadPending(ref);
    deps.pushNotice(`  ⚡ 최우선 — ${decision.blockingTools.join(', ')} 은(는) 끊을 수 없어 끝나는 다음 도구 경계에 먼저 넣습니다.`);
  } else if (decision.kind === 'deferred') {
    deps.pushNotice(`  ⏳ 지금 넣을 수 있는 항목이 없습니다(슬래시 등) — ${decision.blockingTools.join(', ')} 은(는) 끊을 수 없어 응답 뒤에 보냅니다.`);
  }
  return decision;
}

/**
 * 턴 종료 핸드오프가 이 턴을 «중단»(큐를 composer 로 복원)으로 읽을지. «지금 밀어 넣기»로 끊은 턴은
 * 중단이 아니다 — 복원하지 않고 큐 머리를 곧바로 제출한다. 표지는 한 번 읽으면 지운다.
 */
export function consumeTurnEndInterrupted(
  lastTurnFinalStatus: 'completed' | 'interrupted' | 'failed' | undefined,
  steerInterruptRef: { pending: boolean },
): boolean {
  const steerInterrupted = steerInterruptRef.pending;
  steerInterruptRef.pending = false;
  return lastTurnFinalStatus === 'interrupted' && !steerInterrupted;
}
