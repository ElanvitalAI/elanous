import { describe, expect, test } from 'bun:test';
import {
  REVIEW_ROUND_CAP,
  countStoredCompletedReviews,
  deviceRequestReview,
  rejudgeOnHeadDevice,
  type RejudgeOnHeadIsolationCard,
  type StoredReviewResult,
} from './task-agent-rejudge-on-head-device.js';
import { REJUDGE_HEAD_CAP } from '../task-agent/rejudge-on-head.js';
import { reviewResultPath } from '../task-agent/review-result-capture.js';

/**
 * DEVICE-FIRST-STAGE — 이 시험이 이 장치의 유일한 호출자다(운영 코드 아님 · 배선 증거 = 위 import).
 * 격리 카드 fixture 는 부모 칸의 완료 경계 실물(저장 완료 4·5·미회수 1)을 그대로 옮긴다.
 */

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OTHER_HEAD = 'ffffffffffffffffffffffffffffffffffffffff';

const stored = (head: string, verdict: 'pass' | 'warn' | 'fail' = 'pass', extra: Partial<StoredReviewResult> = {}): StoredReviewResult => ({
  pr: 26030, head, reviewed: true, verdict, resultPath: `/tmp/review-results/26030-${head.slice(0, 12)}.json`, ...extra,
});

const card = (reviewRequests: readonly StoredReviewResult[], pr = 26030, head = HEAD): RejudgeOnHeadIsolationCard => ({
  id: 'sim-card-26030', statePath: '/tmp/sim-state/tasks.json', pr, head, reviewRequests,
});

describe('task-agent rejudge-on-head device (ux-sim)', () => {
  test('DEVICE-FIRST-STAGE: 부모 칸에서 물려받은 완료 경계를 이 조각1/4 범위만 채운다 — 부모 전체를 다 완', () => {
    expect(REVIEW_ROUND_CAP).toBe(5);
    // 장치는 기존 task-agent cap 계약(REJUDGE_HEAD_CAP)을 import 로 소비·재사용한다.
    expect(rejudgeOnHeadDevice(card([stored(HEAD)])).rejudgeHeadCap).toBe(REJUDGE_HEAD_CAP);
  });

  test('격리 카드에 저장 완료 결과 정확히 5개 → requestReview 전에 추가 리뷰 0건 · reviewer 호출 0회 · cap-reached', () => {
    const fixture = card([stored(OTHER_HEAD), stored(HEAD, 'warn'), stored(HEAD), stored(HEAD), stored(HEAD)]);
    const report = rejudgeOnHeadDevice(fixture);
    expect(report.decision).toBe('cap-reached');
    expect(report.storedCompleted).toBe(5);
    expect(report.reviewRequestsAllowed).toBe(0);
    expect(report.reviewerCalls).toBe(0);
    expect(report.evidencePath).toBe(reviewResultPath(fixture.statePath, fixture.id, fixture.pr, fixture.head));
    expect(report.nextDecisionNeeded).toBe(true);
    expect(report.ledgerReason).toContain('cap-reached');
    expect(report.head).toBe(HEAD); // 기존 head 보존
    let reviewerCalls = 0;
    const requested = deviceRequestReview(fixture, () => { reviewerCalls++; });
    expect(requested.requested).toBe(0);
    expect(reviewerCalls).toBe(0);
    expect(fixture.reviewRequests).toHaveLength(5); // 5건 그대로 보존
  });

  test('저장 완료 결과 정확히 4개 → 기존 호출 경로 유지(reviewer 호출 1회)', () => {
    const fixture = card([stored(OTHER_HEAD), stored(HEAD, 'warn'), stored(HEAD), stored(HEAD)]);
    const report = rejudgeOnHeadDevice(fixture);
    expect(report.decision).toBe('review-allowed');
    expect(report.storedCompleted).toBe(4);
    expect(report.reviewRequestsAllowed).toBe(1);
    let reviewerCalls = 0;
    const requested = deviceRequestReview(fixture, () => { reviewerCalls++; });
    expect(requested.requested).toBe(1);
    expect(reviewerCalls).toBe(1);
    expect(report.nextDecisionNeeded).toBe(false);
  });

  test('미회수 파일 1개 → 0회로 센다(오판 없음) · 원장 이유 일치', () => {
    const fixture = card([stored(OTHER_HEAD), stored(HEAD, 'warn'), stored(HEAD), stored(HEAD), stored(HEAD, 'fail', { unrecovered: true, resultPath: undefined })]);
    const counted = countStoredCompletedReviews(fixture);
    expect(counted.storedCompleted).toBe(4); // 미회수는 0회로 센다
    expect(counted.unrecovered).toBe(1);
    const report = rejudgeOnHeadDevice(fixture);
    expect(report.decision).toBe('review-allowed');
    expect(report.reviewRequestsAllowed).toBe(1); // 오판 없음: cap-reached 아님
    expect(report.ledgerReason).toContain('unrecovered 1 counted 0');
    let reviewerCalls = 0;
    expect(deviceRequestReview(fixture, () => { reviewerCalls++; }).requested).toBe(1);
    expect(reviewerCalls).toBe(1);
  });
});