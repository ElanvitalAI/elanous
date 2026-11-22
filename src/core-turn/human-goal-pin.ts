// SEAT-HUMAN-GOAL-PIN (OP 배정 #128939 · OP 필수 #129875/#129908 정정) —
//   사람 줄(왕관 표기 포함)은 «고정 목표»로 승격해 완료 전 알림 턴이 목표를 못 바꾸게 한다.
//   원인: runGoalLoop 진입 때 objective = «마지막 user 메시지 200자»(run-goal-loop.ts extractObjective)
//   → 우편·캡슐 알림 턴이 도착하면 알림 줄이 목표를 덮어 1순위 지시가 밀렸다(«크론 5개» 30분+ 무시).
//   계약(완료선 · OP #128939 · #129908 확정 필수):
//   ① 판별은 구조화 출처(opener kind)로만 — from 미전달(opener 없음)은 사람이 아니다(fail-closed · OP #130461):
//      핀 없음·목표 없음. 텍스트 접두사·정규식·키워드 판별 금지(MSG-SOURCE-HIERARCHY 대표 11-17 §1).
//   ② 고정 중 자동 줄(system · agent) → objective = 고정 목표 그대로(알림 줄이 목표를 못 바꿈).
//   ③ update_goal(complete) → releasePinnedGoal 해제 — 이후 알림 턴은 종전 extractObjective 파생.
//   ④ 저장소는 부모(TUI) 소유 — 부모 상태줄이 같은 프로세스 싱글턴을 읽고, child 는 payload 로
//      받은 parentPinnedGoal 을 우선한다(child 교체/재기동 뒤 복구). 세션 분리(옆 세션 오염 없음).
//   순수 함수 모듈(부작용 없음) — 저장소는 주입(DIP): 인메모리 기본.

import type { MessageSource } from '../session/index.js';

/** 고정 목표 저장소(세션 → 목표). 순수 주입형 — 부모(TUI) 배선이 세션 수명과 결합. */
export interface GoalPinStore {
  readonly pinned: ReadonlyMap<string, string>;
  pin(sessionId: string, objective: string): void;
  release(sessionId: string): void;
}

export function createInMemoryGoalPinStore(): GoalPinStore {
  const pinned = new Map<string, string>();
  return {
    pinned,
    pin: (sessionId, objective) => { pinned.set(sessionId, objective); },
    release: (sessionId) => { pinned.delete(sessionId); },
  };
}

export interface PinnedObjectiveInput {
  readonly sessionId: string;
  /** MSG-SOURCE-HIERARCHY — 이 턴을 연 구조화 출처. 미전달(opener 없음)은 사람 아님 — fail-closed(OP #130461). */
  readonly from?: MessageSource;
  /** 이번 턴을 연 줄 원문(사람 줄만 핀 목표가 된다). */
  readonly turnText: string;
  /** 부모(TUI)가 소유한 핀 목표 — payload 로 전달. 이 프로세스 저장소보다 우선(child 교체 뒤 복구). */
  readonly parentPinnedGoal?: string;
}

export interface PinnedObjectiveResult {
  /** 자동 출처(system · agent) 줄이면 true(사람 줄 아님). */
  readonly noticeTurn: boolean;
  /** 고정 목표가 살아 있으면 true. */
  readonly pinned: boolean;
  /** 골 루프에 줄 objective — 고정 중이면 고정 목표, 아니면 undefined(종전 extractObjective 파생). */
  readonly objective?: string;
}

/** 계산 + 저장소 갱신(사람 줄이면 pin). 순수 모듈의 유일한 상태 조작점 — 호출부는 턴당 1회. */
export function resolvePinnedObjective(
  input: PinnedObjectiveInput,
  store: GoalPinStore,
): PinnedObjectiveResult {
  // ① 판별은 구조화 출처로만 한다 — 문구·접두사·정규식은 안 본다.
  //   미전달 opener = 사람 아님(fail-closed · OP #130461): 어떤 줄이 사람 줄인지 확실하지 않으면 핀을 못 만든다.
  const humanLine = input.from?.kind === 'human' && input.turnText.trim().length > 0;
  if (humanLine) {
    // 사람 줄 진입 — (재)고정. 새 사람 지시가 고정 목표를 갱신한다(마지막 사람 줄이 이긴다).
    const objective = input.turnText.slice(0, 200);
    store.pin(input.sessionId, objective);
    return { noticeTurn: false, pinned: true, objective };
  }
  // ② 자동 줄(system · agent) — 핀은 유지하고 이 줄은 목표로 안 쓴다.
  //   ④ 부모 소유 핀(payload)이 이 프로세스 저장소보다 우선한다.
  const existing = input.parentPinnedGoal ?? store.pinned.get(input.sessionId);
  if (existing !== undefined) {
    return { noticeTurn: true, pinned: true, objective: existing };
  }
  return { noticeTurn: true, pinned: false };
}

/** 목표 완료(update_goal complete) — 고정 해제. */
export function releasePinnedGoal(sessionId: string, store: GoalPinStore): void {
  store.release(sessionId);
}

/** 세션 단위 싱글턴(프로세스 수명) — 부모(TUI) 배선: runLocalChatTurn 이 쓰고 entry.ts 상태줄이 읽는다. */
const sessionStore = createInMemoryGoalPinStore();
export function sessionGoalPinStore(): GoalPinStore {
  return sessionStore;
}
/** 상태줄용 — 이 세션의 고정 목표(없으면 undefined). 부모 프로세스의 저장소를 본다. */
export function pinnedGoalOf(sessionId: string): string | undefined {
  return sessionStore.pinned.get(sessionId);
}