import { REJUDGE_HEAD_CAP } from '../task-agent/rejudge-on-head.js';
import { reviewResultPath } from '../task-agent/review-result-capture.js';

/**
 * TA-REJUDGE-ON-HEAD ux-sim mock 장치(L2) — 부모 칸에서 물려받은 리뷰 회차 상한 완료 경계를
 * 고정 입력 격리 카드로 검증한다.
 *
 * - 왜: 재판정의 상한 논리는 `src/task-agent/rejudge-on-head.ts` 에 성숙하게 존재한다(재게이트 상한
 *   `REJUDGE_HEAD_CAP` · `regateUnmeasured` «못 잰 것은 상한에 안 센다» · `cap-reached … needs owner`).
 *   이 장치는 그 계약을 «중복 구현하지 않고» import 로 소비·재사용한다 — 같은 카드 자리의
 *   `<state>/review-results/<card>-<pr>-<head12>.json` 근거 경로는 기존 `reviewResultPath` 를 그대로 쓴다.
 * - 계약: 같은 PR 에서 «저장 완료»된 review-results 원문 회차가 `REVIEW_ROUND_CAP`(5) 에 닿으면
 *   `requestReview` 전에 추가 리뷰를 막는다(요청 0건 · reviewer 호출 0회) — cap-reached · 근거 경로 ·
 *   다음 판단 필요(nextDecisionNeeded) 상태와 원장 이유를 남긴다. 기존 head 와 저장 5건은 보존한다.
 * - 파일 미회수(결과 파일을 회수하지 못한 회차)는 0회로 센다 — 상한에 오판으로 넣지 않는다.
 * - 장치는 운영 코드가 아니다 — 이 모듈의 유일한 호출자는 같은 무대의 mock 시험
 *   `task-agent-rejudge-on-head-device.test.ts` 다(DEVICE-FIRST-STAGE 의도적 경계).
 */

/** 한 PR 의 저장 완료된 리뷰 회차 상한 — 부모 칸의 완료 경계(원문 5회). */
export const REVIEW_ROUND_CAP = 5;

export interface StoredReviewResult {
  pr: number;
  head: string;
  /** 회수되어 reviewed 판정이 난 회차만 저장 완료로 센다. */
  reviewed?: boolean;
  verdict?: string;
  resultPath?: string;
  /** 결과 파일을 회수하지 못한 회차 — 0회로 센다(상한에 안 넣는다). */
  unrecovered?: boolean;
}

export interface RejudgeOnHeadIsolationCard {
  id: string;
  statePath: string;
  pr: number;
  head: string;
  reviewRequests: readonly StoredReviewResult[];
}

export type RejudgeOnHeadDeviceDecision = 'review-allowed' | 'cap-reached';

export interface RejudgeOnHeadDeviceReport {
  card: string;
  pr: number;
  head: string;
  decision: RejudgeOnHeadDeviceDecision;
  /** 유효한 저장 완료 review-results 회차 수(미회수 제외). */
  storedCompleted: number;
  /** 회수되지 않은 회차 수 — 0회로 세므로 저장 완료 수에 들지 않는다. */
  unrecovered: number;
  /** 이번 review tick 에 requestReview 전에 남는 추가 요청 수 — cap-reached 면 0. */
  reviewRequestsAllowed: number;
  /** reviewer 호출 수 — cap-reached 면 requestReview 가 막혀 0회. */
  reviewerCalls: number;
  evidencePath: string;
  nextDecisionNeeded: boolean;
  reason: string;
  ledgerReason: string;
  /** 소비·재사용하는 기존 task-agent 재게이트 상한 계약값. */
  rejudgeHeadCap: number;
}

/** 저장 완료 회차와 미회수 회차를 센다 — 미회수·다른 PR 은 저장 완료에서 뺀다. */
export function countStoredCompletedReviews(card: RejudgeOnHeadIsolationCard): { storedCompleted: number; unrecovered: number } {
  const entries = card.reviewRequests.filter((entry) => entry.pr === card.pr);
  const completed = entries.filter((entry) => entry.reviewed === true
    && ['pass', 'warn', 'fail'].includes(String(entry.verdict ?? ''))
    && entry.unrecovered !== true && typeof entry.resultPath === 'string' && entry.resultPath !== '');
  const unrecovered = entries.filter((entry) => entry.unrecovered === true).length;
  return { storedCompleted: completed.length, unrecovered };
}

/** 격리 카드 하나를 이번 review tick 판단으로 옮긴다 — 저장 완료 5회면 cap-reached 로 막는다. */
export function rejudgeOnHeadDevice(card: RejudgeOnHeadIsolationCard): RejudgeOnHeadDeviceReport {
  const { storedCompleted, unrecovered } = countStoredCompletedReviews(card);
  const evidencePath = reviewResultPath(card.statePath, card.id, card.pr, card.head);
  const base = {
    card: card.id, pr: card.pr, head: card.head, storedCompleted, unrecovered,
    evidencePath, rejudgeHeadCap: REJUDGE_HEAD_CAP,
  };
  if (storedCompleted >= REVIEW_ROUND_CAP) {
    return {
      ...base,
      decision: 'cap-reached',
      reviewRequestsAllowed: 0,
      reviewerCalls: 0,
      nextDecisionNeeded: true,
      reason: `reviewed ${storedCompleted} rounds already (cap ${REVIEW_ROUND_CAP} · unmeasured ${unrecovered} not counted) — no more review; needs owner`,
      ledgerReason: `cap-reached: stored review-results ${storedCompleted}/${REVIEW_ROUND_CAP} · head ${card.head.slice(0, 12)} preserved · unrecovered ${unrecovered} counted 0`,
    };
  }
  return {
    ...base,
    decision: 'review-allowed',
    reviewRequestsAllowed: 1,
    reviewerCalls: 1,
    nextDecisionNeeded: false,
    reason: `stored review-results ${storedCompleted}/${REVIEW_ROUND_CAP} — existing requestReview call path preserved`,
    ledgerReason: `review-allowed: stored review-results ${storedCompleted}/${REVIEW_ROUND_CAP} · unrecovered ${unrecovered} counted 0`,
  };
}

/** requestReview 게이트 — cap-reached 면 reviewer 를 부르지 않고 요청 0건을 돌려준다. */
export function deviceRequestReview(
  card: RejudgeOnHeadIsolationCard,
  callReviewer: () => void,
): { requested: 0 | 1; decision: RejudgeOnHeadDeviceDecision; report: RejudgeOnHeadDeviceReport } {
  const report = rejudgeOnHeadDevice(card);
  if (report.decision === 'cap-reached') return { requested: 0, decision: report.decision, report };
  callReviewer();
  return { requested: 1, decision: report.decision, report };
}