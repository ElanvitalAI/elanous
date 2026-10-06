/**
 * TASK-AGENT 판단부 — 슈퍼바이저 종료 어휘(+ PR·리뷰 관측) → «다음 한 수».
 *
 * RFC-task-agent-any-task-to-completion-2026-10-06 §A2 표를 순수 함수로 옮긴다.
 * 부작용이 없다(발사·리뷰·착지는 실행부 `actions.ts` 의 몫). 수확 원천 = run-c9ad6d6d `chooseTaskAction`.
 */
import type { SupervisorStopReason } from '../self-dev/run-supervisor.js';
import type { NextActionKind } from './actions.js';

export type TaskMove =
  | 'propose-green'
  | 'review'
  | 'propose-land'
  | 'narrow-relaunch'
  | 'wait-retry'
  | 'salvage-relaunch'
  | 'alternative'
  | 'decision-card'
  | 'wait';

export interface TaskJudgeInput {
  stopReason?: SupervisorStopReason;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  pr?: string | number;
  /** `self review --json` 판정. 관측 못 했으면 비운다(«통과»로 읽지 않는다). */
  review?: 'pass' | 'fail';
  mustFix?: readonly string[];
  /** 수마다 누적 실패 수. */
  failures?: Partial<Record<TaskMove, number>>;
}

export interface TaskJudgement {
  move: TaskMove;
  stage: 'observing' | 'closing' | 'reviewing' | 'repairing' | 'waiting' | 'escalated';
  reason: string;
  /** 실행부(`executeNextAction`)가 바로 받는 수면 그 종류. 없으면 발사·대기 계열(실행부 밖). */
  executorKind?: NextActionKind;
}

/** 같은 수가 이 횟수만큼 실패하면 다른 수로 넘어간다(RFC §A2 «같은 수 2번 실패»). */
export const SAME_MOVE_FAILURE_LIMIT = 2;

const EXECUTOR_KIND: Partial<Record<TaskMove, NextActionKind>> = {
  'propose-green': 'green',
  review: 'review',
  'propose-land': 'land',
  'narrow-relaunch': 'retry',
  'wait-retry': 'retry',
  'salvage-relaunch': 'retry',
  alternative: 'retry',
  'decision-card': 'decision',
};

function base(input: TaskJudgeInput): Omit<TaskJudgement, 'executorKind'> {
  const stop = input.stopReason;
  const merged = input.prState === 'MERGED' && input.pr !== undefined && input.pr !== '';
  if (merged) {
    return { move: 'propose-green', stage: 'closing', reason: `병합된 PR ${input.pr} 근거로 칸 green 제안` };
  }
  switch (stop) {
    case 'harvestable-awaiting-human':
    case 'needs-human':
      if (input.review === 'pass') return { move: 'propose-land', stage: 'reviewing', reason: 'self review 통과 — 착지 제안' };
      if (input.review === 'fail') {
        return { move: 'narrow-relaunch', stage: 'repairing', reason: `must-fix 로 좁혀 재발사: ${(input.mustFix ?? []).join(' · ') || '(must-fix 비어 있음)'}` };
      }
      return { move: 'review', stage: 'reviewing', reason: '수확 가능 런 — self review 필요' };
    case 'no-progress':
    case 'decomposable-no-progress':
      return { move: 'narrow-relaunch', stage: 'repairing', reason: `${stop} — 범위를 좁혀 한 번 재발사(판정선 유지)` };
    case 'provider-exhausted':
    case 'step-timeout':
      return { move: 'wait-retry', stage: 'waiting', reason: `${stop} — 대기 후 재시도` };
    case 'handed-off-to-salvage':
      return { move: 'salvage-relaunch', stage: 'repairing', reason: '수확 브랜치 diff 를 가져와 이어 발사' };
    case 'converged':
      return { move: 'wait', stage: 'observing', reason: '완주했으나 PR 병합 근거 대기' };
    case undefined:
      return { move: 'wait', stage: 'observing', reason: '종료 관측 대기' };
    default:
      return { move: 'decision-card', stage: 'escalated', reason: `표에 없는 종료 어휘 ${stop} — 근거 붙여 사람 결정` };
  }
}

/** 종료 어휘·관측에서 다음 한 수를 고른다. 같은 수 2회 실패 → 다른 수 → 그것도 실패 → 결정 카드. */
export function judgeNextMove(input: TaskJudgeInput): TaskJudgement {
  const failures = input.failures ?? {};
  let judged = base(input);
  if ((failures.alternative ?? 0) >= 1) {
    judged = { move: 'decision-card', stage: 'escalated', reason: `대안도 실패 — 런·PR·must-fix 근거로 사람 결정 (직전: ${judged.move})` };
  } else if (judged.move !== 'wait' && judged.move !== 'decision-card' && (failures[judged.move] ?? 0) >= SAME_MOVE_FAILURE_LIMIT) {
    judged = { move: 'alternative', stage: 'repairing', reason: `같은 수 ${SAME_MOVE_FAILURE_LIMIT}회 실패 — 다른 수 선택 (${judged.move})` };
  }
  const executorKind = EXECUTOR_KIND[judged.move];
  return executorKind ? { ...judged, executorKind } : judged;
}
