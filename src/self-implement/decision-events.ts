import type { DecisionEvent } from '../live/detail-switch.js';
import { redactSecretText } from '../debug/log.js';

const line = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown';

export function reworkDecision(input: { runId?: string; round: number; effectiveMax: number; escalateTier: string; kind: string }): DecisionEvent {
  return {
    kind: 'HEAL', phase: 'implement', refs: { round: input.round, max: input.effectiveMax },
    what: line(`구현 재작업 ${input.round}/${input.effectiveMax}`),
    reason: line(`${input.kind} · 에스컬레이션 ${input.escalateTier}`),
    purpose: '검증에서 발견한 문제를 고친다', target: '다음 구현 라운드',
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

export function gateDecision(input: { runId?: string; reason: string; testStepSkipped: boolean }): DecisionEvent {
  return {
    kind: 'VERIFY', phase: 'gate', what: '구현 게이트 시험 범위',
    reason: line(input.reason), purpose: '변경된 파일에 맞는 검증을 선택한다',
    target: input.testStepSkipped ? '시험 생략 · 나머지 게이트' : '대상 시험 · 나머지 게이트',
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

export function reviewDecision(input: { runId?: string; verdict: string; reviewed: boolean; mustFix?: number; shouldFix?: number; topFinding?: string; reason?: string }): DecisionEvent {
  const fallback = input.mustFix !== undefined && input.mustFix > 0 && input.topFinding?.trim()
    ? `must-fix ${input.mustFix} · ${redactSecretText(input.topFinding)}`
    : `${input.verdict} · 실제 리뷰 ${input.reviewed ? '완료' : '미실행'} · must-fix ${input.mustFix ?? 0} · should-fix ${input.shouldFix ?? 0}`;
  return {
    kind: 'VERIFY', phase: 'review',
    refs: { ...(input.mustFix !== undefined ? { mustFix: input.mustFix } : {}), ...(input.shouldFix !== undefined ? { shouldFix: input.shouldFix } : {}) },
    what: '구현물 리뷰 결과',
    reason: line(redactSecretText(input.reason ?? fallback)),
    purpose: '병합 전에 변경을 검토한다',
    target: input.reviewed && input.verdict === 'pass' ? '병합 판단' : '리뷰 또는 재작업',
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

export function escalateDecision(input: { runId?: string; shellId: string; answer: string | null; interactive: boolean; mode: 'question' | 'confirm'; safeDecline?: boolean }): DecisionEvent {
  return {
    kind: 'ESCALATE', phase: 'implement', refs: { shell: input.shellId }, what: '셸 응답 요청',
    reason: `${input.mode} · ${input.interactive ? '대화형' : '비대화형'} · 응답 ${input.answer === null ? '없음' : '수신'}${input.safeDecline ? ' · 안전 거절 선택' : ''}`,
    purpose: '셸 프롬프트의 operator 결정을 받는다', target: line(`셸 ${input.shellId}`),
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

export function mergeDecision(input: { number: number; merged: boolean; reason: string; runId?: string }): DecisionEvent {
  return {
    kind: input.merged ? 'SHIP' : 'ESCALATE', phase: 'land', refs: { pr: input.number },
    what: line(`PR #${input.number} ${input.merged ? '병합 확인' : '병합 실패'}`),
    reason: line(input.reason), purpose: '확인된 병합 결과만 배송한다',
    target: input.merged ? '병합 완료' : '사람',
    ...(input.runId ? { runId: input.runId } : {}),
  };
}
