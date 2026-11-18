/**
 * APP-BUILD-TOOL-WALL-CAP — 자리 턴 상한에 «실제로» 끊긴 승인만 신뢰 재개(RETRYABLE) 대상이다.
 * 사람 거절·사람 중단·만료된 승인은 그대로 실패로 남는다. 가짜 signal·고정 시각만 쓴다.
 */
import { describe, expect, test } from 'bun:test';
import { seatCapInterruptedApprovalExpiry } from './child-plugin-runtime.js';
import { SeatTurnCapAbort } from '../core-turn/seat-turn-cap.js';

const NOW = Date.parse('2026-11-17T07:00:00.000Z');
const LIVE = '2026-11-17T07:10:00.000Z';
const EXPIRED = '2026-11-17T06:59:59.000Z';

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe('seatCapInterruptedApprovalExpiry', () => {
  test('상한에 끊긴 턴 ⊕ 제시한 미만료 승인 = 그 만료 시각으로 재개 대상', () => {
    expect(seatCapInterruptedApprovalExpiry(abortedWith(new SeatTurnCapAbort('wall')), LIVE, NOW)).toBe(LIVE);
  });

  test('턴이 살아 있는 동안의 거절은 재개 대상이 아니다', () => {
    expect(seatCapInterruptedApprovalExpiry(new AbortController().signal, LIVE, NOW)).toBeUndefined();
    expect(seatCapInterruptedApprovalExpiry(undefined, LIVE, NOW)).toBeUndefined();
  });

  test('사람 중단은 재개 대상이 아니다', () => {
    expect(seatCapInterruptedApprovalExpiry(abortedWith(new Error('person cancelled')), LIVE, NOW)).toBeUndefined();
  });

  test('제시 전에 끊겼거나 승인이 만료됐으면 재개 대상이 아니다', () => {
    const capped = abortedWith(new SeatTurnCapAbort('wall'));
    expect(seatCapInterruptedApprovalExpiry(capped, undefined, NOW)).toBeUndefined();
    expect(seatCapInterruptedApprovalExpiry(capped, EXPIRED, NOW)).toBeUndefined();
    expect(seatCapInterruptedApprovalExpiry(capped, 'not-a-date', NOW)).toBeUndefined();
  });
});
