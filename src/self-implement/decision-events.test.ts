import { describe, expect, test } from 'bun:test';
import type { DecisionEvent } from '../live/detail-switch.js';
import { escalateDecision, gateDecision, mergeDecision, reviewDecision, reworkDecision } from './decision-events.js';

function expectOneLineFields(event: DecisionEvent): void {
  for (const field of ['what', 'reason', 'purpose', 'target'] as const) {
    expect(event[field].trim().length).toBeGreaterThan(0);
    expect(event[field]).not.toMatch(/[\r\n]/);
  }
}

describe('self-implement decision events', () => {
  test('gate has a phase without changing its decision text or run attribution', () => {
    const event = gateDecision({ runId: 'run-gate', reason: 'no-changes', testStepSkipped: true });
    expect(event).toMatchObject({
      kind: 'VERIFY', phase: 'gate', runId: 'run-gate', what: '구현 게이트 시험 범위',
      reason: 'no-changes', purpose: '변경된 파일에 맞는 검증을 선택한다', target: '시험 생략 · 나머지 게이트',
    });
    expectOneLineFields(event);
  });

  test('review carries available counts, including zero, but never review prose in refs', () => {
    const event = reviewDecision({ verdict: 'fail', reviewed: true, mustFix: 2, shouldFix: 1 });
    expect(event).toMatchObject({
      kind: 'VERIFY', phase: 'review', refs: { mustFix: 2, shouldFix: 1 },
      what: '구현물 리뷰 결과', reason: 'fail · 실제 리뷰 완료 · must-fix 2 · should-fix 1',
      purpose: '병합 전에 변경을 검토한다', target: '리뷰 또는 재작업',
    });
    expect(reviewDecision({ verdict: 'pass', reviewed: true, mustFix: 0 }).refs).toEqual({ mustFix: 0 });
    expect(reviewDecision({ verdict: 'pass', reviewed: false, reason: 'private review text' }).refs).toEqual({});
    expectOneLineFields(event);
  });

  test('review carries its first must-fix finding on one line while keeping counts in refs', () => {
    const event = reviewDecision({ verdict: 'fail', reviewed: true, mustFix: 2, shouldFix: 0, topFinding: 'src/a.ts 에서 null 검사가 빠졌다\n줄 12' });
    expect(event.reason).toBe('must-fix 2 · src/a.ts 에서 null 검사가 빠졌다 줄 12');
    expect(event.refs).toEqual({ mustFix: 2, shouldFix: 0 });
    expectOneLineFields(event);
  });

  test('review redacts secrets before truncating findings and explicit failure reasons', () => {
    const secret = 'OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
    const event = reviewDecision({ verdict: 'fail', reviewed: true, mustFix: 2, shouldFix: 0, topFinding: `null 검사 누락 ${secret}` });
    expect(event.reason).toContain('null 검사 누락');
    expect(event.reason).not.toContain(secret);
    expect(event.reason.length).toBeLessThanOrEqual(200);
    expectOneLineFields(event);

    const long = reviewDecision({ verdict: 'fail', reviewed: true, mustFix: 1, topFinding: '긴 지적 '.repeat(100) });
    expect(long.reason.length).toBe(200);
    const overridden = reviewDecision({ verdict: 'fail', reviewed: true, mustFix: 1, topFinding: '다른 지적', reason: `reviewer unavailable ${secret}` });
    expect(overridden.reason).toContain('reviewer unavailable');
    expect(overridden.reason).not.toContain(secret);
    expect(overridden.reason).not.toContain('다른 지적');
    expectOneLineFields(overridden);
  });

  test('zero must-fix keeps its previous reason even if a finding was supplied', () => {
    const event = reviewDecision({ verdict: 'pass', reviewed: true, mustFix: 0, shouldFix: 0, topFinding: '무시할 지적' });
    expect(event.reason).toBe('pass · 실제 리뷰 완료 · must-fix 0 · should-fix 0');
    expect(event.refs).toEqual({ mustFix: 0, shouldFix: 0 });
    expectOneLineFields(event);
  });

  test('rework identifies its implement round and effective maximum', () => {
    const event = reworkDecision({ round: 2, effectiveMax: 3, escalateTier: 'none', kind: 'rework' });
    expect(event).toMatchObject({
      kind: 'HEAL', phase: 'implement', refs: { round: 2, max: 3 },
      what: '구현 재작업 2/3', reason: 'rework · 에스컬레이션 none',
      purpose: '검증에서 발견한 문제를 고친다', target: '다음 구현 라운드',
    });
    expectOneLineFields(event);
  });

  test('successful merge ships only the confirmed PR number', () => {
    const event = mergeDecision({ number: 21408, merged: true, reason: 'gh MERGED' });
    expect(event).toMatchObject({
      kind: 'SHIP', phase: 'land', refs: { pr: 21408 }, what: 'PR #21408 병합 확인',
      reason: 'gh MERGED', purpose: '확인된 병합 결과만 배송한다', target: '병합 완료',
    });
    expectOneLineFields(event);
  });

  test('failed merge escalates to a human instead of shipping', () => {
    const event = mergeDecision({ number: 21408, merged: false, reason: 'gh OPEN' });
    expect(event).toMatchObject({
      kind: 'ESCALATE', phase: 'land', refs: { pr: 21408 }, what: 'PR #21408 병합 실패',
      reason: 'gh OPEN', purpose: '확인된 병합 결과만 배송한다', target: '사람',
    });
    expectOneLineFields(event);
  });

  test('shell escalation carries only its identifier, not the answer', () => {
    const event = escalateDecision({ shellId: 'shell-7', answer: 'private answer', interactive: true, mode: 'question' });
    expect(event).toMatchObject({
      kind: 'ESCALATE', phase: 'implement', refs: { shell: 'shell-7' }, what: '셸 응답 요청',
      reason: 'question · 대화형 · 응답 수신', purpose: '셸 프롬프트의 operator 결정을 받는다', target: '셸 shell-7',
    });
    expectOneLineFields(event);
  });
});
