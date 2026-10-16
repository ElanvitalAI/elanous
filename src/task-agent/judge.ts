/**
 * TASK-AGENT 판단부 — 슈퍼바이저 종료 어휘(+ PR·리뷰 관측) → «다음 한 수».
 *
 * RFC-task-agent-any-task-to-completion-2026-10-06 §A2 표를 순수 함수로 옮긴다.
 * 부작용이 없다(발사·리뷰·착지는 실행부 `actions.ts` 의 몫). 수확 원천 = run-c9ad6d6d `chooseTaskAction`.
 */
import { STOP_CLASS_POD_FAILURE, STOP_CLASS_NO_LAUNCH } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import type { SupervisorStopReason } from '../self-dev/run-supervisor.js';
import type { NextActionKind, RetryVariant } from './actions.js';
import type { CompletionKind } from './task-hand.js';

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
  /** Complete PR target paths when measured. Unknown is omitted, never treated as zero code diff. */
  prTargetPaths?: readonly string[];
  /** `self review --json` 판정. 관측 못 했으면 비운다(«통과»로 읽지 않는다). */
  review?: 'pass' | 'fail';
  mustFix?: readonly string[];
  /** 수마다 누적 실패 수. */
  failures?: Partial<Record<TaskMove, number>>;
  deliveryEvidence?: { ok: boolean; files: readonly string[]; reason: string };
  /** 과제 종결 종류(§A4b③) — 비거나 code-pr 이면 종전처럼 PR 병합이 종결이다. */
  completion?: CompletionKind;
  /** code-pr 밖 종류의 확인 증거(`completion-evidence.ts` 판독). 비면 «아직 못 받았다» — 통과로 읽지 않는다. */
  evidence?: { ok: boolean; ref: string };
  /** Only classified terminal evidence; an absent input preserves the existing stop-reason table. */
  terminalRun?: { kind: typeof STOP_CLASS_POD_FAILURE | typeof STOP_CLASS_NO_LAUNCH; reason: string; hasPr: boolean; hasHarvestBranch: boolean };
  /**
   * 같은 칸(checklistId)의 앞 런들 — 재발사 계열 수를 고르기 «전»에 받는 «선례»(RFC adaptive-graph-ops §9.10).
   * 없으면 지금 표 그대로(입력이 비어도 동작한다 — RUN-TAG-REWORK 가 원장에 서명을 달면 여기 입력이 된다).
   */
  precedents?: readonly TaskPrecedent[];
  /** 판정 관측 훅 — `task-agent.judge` 이벤트에 precedent {matched, priorRunId, signature} 를 싣는다. 없으면 관측 없이 종전 동작. */
  observe?: (event: 'task-agent.judge', data: { precedent: { matched: boolean; priorRunId?: string; signature?: string } }) => void;
}

/** 같은 칸의 앞 런 한 건 — 결말(outcome)과 must-fix 서명. `outcome: 'alternative-failed'` 는 «대안도 같은 서명으로 실패했다»는 예약 결말이다. */
export interface TaskPrecedent {
  runId: string;
  outcome: string;
  signature: string;
}

/** must-fix 서명의 분류 축(남은 must-fix 의 성격) — 해시에 함께 박는다. */
export const MUST_FIX_CLASSIFICATION = 'implementation-deficit';

/**
 * 남은 must-fix 원문을 정규화(공백 접기·trim·정렬)한 해시 ⊕ 분류 — 같은 칸의 앞 런과 비교하는 «서명».
 * must-fix 가 비면 서명도 없다(선례 비교 없음).
 */
export function mustFixSignature(mustFix?: readonly string[]): string | undefined {
  const normalized = [...(mustFix ?? [])]
    .map(fix => (typeof fix === 'string' ? fix.trim().replace(/\s+/gu, ' ') : ''))
    .filter(Boolean)
    .sort();
  if (!normalized.length) return undefined;
  let hash = 0x811c9dc5;
  const text = `${MUST_FIX_CLASSIFICATION}:${JSON.stringify(normalized)}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

export interface TaskJudgement {
  move: TaskMove;
  stage: 'observing' | 'closing' | 'reviewing' | 'repairing' | 'waiting' | 'escalated';
  reason: string;
  /** 실행부(`executeNextAction`)가 바로 받는 수면 그 종류. 없으면 발사·대기 계열(실행부 밖). */
  executorKind?: NextActionKind;
  /**
   * 실행부 `retry` 의 갈래(§A9 G2). 좁혀 재발사 · 기다렸다 재시도 · 수확 이어 발사 · 다른 수가
   * 같은 재발사로 접히지 않게 실행부에 넘긴다. retry 가 아닌 수에는 없다.
   */
  executorVariant?: RetryVariant;
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

const EXECUTOR_VARIANT: Partial<Record<TaskMove, RetryVariant>> = {
  'narrow-relaunch': 'narrow',
  'wait-retry': 'wait',
  'salvage-relaunch': 'salvage',
  alternative: 'alternative',
};

/** 사다리 R4 — 실행부 허용 목록에 올릴 수 있는 재발사 계열 수(설정 `taskAgent.liveMoves` 어휘 그대로). */
export const LIVE_RETRY_MOVES = ['narrow-relaunch', 'wait-retry', 'salvage-relaunch', 'alternative'] as const satisfies readonly TaskMove[];
export type LiveRetryMove = typeof LIVE_RETRY_MOVES[number];

const RETRY_MOVE_OF_VARIANT: Record<RetryVariant, LiveRetryMove> = {
  narrow: 'narrow-relaunch',
  wait: 'wait-retry',
  salvage: 'salvage-relaunch',
  alternative: 'alternative',
};

/** Only a measured complete file list can establish zero implementation target diff. */
export function isGoalOnlyPr(paths: readonly string[] | undefined): boolean {
  return paths !== undefined && paths.every((path) => /^docs\/goals\/[^/]+(?:\/.*)?$/.test(path));
}

/** 실행부 `retry` 가 어느 수인가 — 갈래 없는 재발사(리뷰 fail 의 must-fix 재발사)는 «좁혀 재발사»다. */
export function retryMoveOf(variant?: RetryVariant): LiveRetryMove {
  return RETRY_MOVE_OF_VARIANT[variant ?? 'narrow'];
}

function base(input: TaskJudgeInput): Omit<TaskJudgement, 'executorKind'> {
  // A goal document is a launch artifact. Its PR cannot prove implementation progress,
  // even when the PR has merged. Waiting also prevents the same goal's live retry.
  if (input.pr && isGoalOnlyPr(input.prTargetPaths)) {
    return { move: 'wait', stage: 'escalated', reason: `goal-only-pr — PR ${input.pr} target diff 0; 같은 골 재큐 중지·구현 근거 필요` };
  }
  if (input.deliveryEvidence) return input.deliveryEvidence.ok
    ? { move: 'propose-green', stage: 'closing', reason: `전달 근거 확인: ${input.deliveryEvidence.files.join(', ')}` }
    : { move: 'wait', stage: 'waiting', reason: input.deliveryEvidence.reason };
  if (input.terminalRun && !input.terminalRun.hasPr && !input.terminalRun.hasHarvestBranch && !input.pr) {
    const disposition = input.terminalRun.kind === STOP_CLASS_POD_FAILURE ? 'needs-owner'
      : input.terminalRun.kind === STOP_CLASS_NO_LAUNCH ? 'needs-relaunch' : undefined;
    if (disposition) return { move: 'wait', stage: 'escalated', reason: `failed/${disposition} — ${input.terminalRun.reason.replace(/[\r\n]+/gu, ' ').trim() || input.terminalRun.kind}` };
  }
  const stop = input.stopReason;
  const kind = input.completion;
  if (kind !== undefined && kind !== 'code-pr') {
    const ref = input.evidence?.ref?.trim() ?? '';
    // green 은 추적 가능한 근거(비지 않은 ref)가 있을 때만 — ok 인데 ref 가 비면 «증거 없음»으로 읽는다.
    if (input.evidence?.ok === true && ref) return { move: 'propose-green', stage: 'closing', reason: `확인 증거 ${ref} 근거로 칸 green 제안 — ${kind}` };
    if (input.evidence?.ok === false) return { move: 'narrow-relaunch', stage: 'repairing', reason: `확인 증거 미충족(${ref || '근거 없음'}) — ${kind} · 범위를 좁혀 재발사` };
    // 증거가 아직 없다 — 완주·종료 미관측이면 증거를 기다린다(PR 병합은 이 종류의 종결이 아니다). 그 밖의 종료 어휘는 아래 표 그대로.
    if (stop === 'converged' || stop === undefined) return { move: 'wait', stage: 'observing', reason: `확인 증거 대기 — ${kind}${input.evidence?.ok === true ? ' (ref 비어 있음)' : ''}` };
  }
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

/** 재발사 계열 — 대안(alternative)이 실패한 «같은 실패 흐름»에 속하는 수. */
const RETRY_FAMILY: ReadonlySet<TaskMove> = new Set<TaskMove>(['narrow-relaunch', 'wait-retry', 'salvage-relaunch']);

/**
 * 선례가 «같은 수로 재발사»를 막는 수 — narrow·salvage·그 자신(alternative).
 * 대기 후 재시도(wait-retry)는 «같은 수로 재발사»가 아니므로 선례 승격에서는 제외.
 */
const PRECEDENT_RELAUNCH_FAMILY: ReadonlySet<TaskMove> = new Set<TaskMove>(['narrow-relaunch', 'salvage-relaunch']);

/**
 * 종료 어휘·관측에서 다음 한 수를 고른다. 같은 수 2회 실패 → 다른 수 → 그것도 실패 → 결정 카드.
 *
 * ⭐ 새 관측이 이긴다(사후 리뷰 must-fix · #24453): 병합된 PR(propose-green)·종료 미관측(wait)·표 밖 어휘(decision-card)는
 * 실패 셈과 무관하게 그대로 간다. 「대안도 실패 → 결정 카드」 승격은 지금 수가 같은 실패 흐름일 때만 —
 * 재발사 계열이거나, 그 수 자신이 이미 같은 수 한도만큼 실패했을 때다.
 *
 * ⭐ 선례(RFC adaptive-graph-ops §9.10): 이번 런의 must-fix 서명이 앞 런 서명과 같으면 같은 수로 재발사하지 않는다 —
 * narrow/salvage → alternative, alternative 자신(또는 선례 결말이 `alternative-failed`)이면 결정 카드.
 * 선례가 없으면 지금 표 그대로.
 */
export function judgeNextMove(input: TaskJudgeInput): TaskJudgement {
  const failures = input.failures ?? {};
  let judged = base(input);
  const signature = mustFixSignature(input.mustFix);
  // 같은 서명 일치 «전체»를 스캔한다 — `alternative-failed` 유무는 목록 어느 위치에 있든 먼저 판정한다(anyMatch 우선, 순서 무관).
  const sameSignature = signature !== undefined
    ? (input.precedents ?? []).filter(prec => typeof prec?.signature === 'string' && prec.signature === signature
      && typeof prec?.runId === 'string' && prec.runId !== '')
    : [];
  const matched = sameSignature[0];
  input.observe?.('task-agent.judge', { precedent: { matched: matched !== undefined, priorRunId: matched?.runId, signature } });
  const escalatable = judged.move !== 'wait' && judged.move !== 'decision-card' && judged.move !== 'propose-green';
  const exhausted = escalatable && (failures[judged.move] ?? 0) >= SAME_MOVE_FAILURE_LIMIT;
  const inFailingFlow = RETRY_FAMILY.has(judged.move) || exhausted;
  if (escalatable && inFailingFlow && (failures.alternative ?? 0) >= 1) {
    judged = { move: 'decision-card', stage: 'escalated', reason: `대안도 실패 — 런·PR·must-fix 근거로 사람 결정 (직전: ${judged.move})` };
  } else if (exhausted) {
    judged = { move: 'alternative', stage: 'repairing', reason: `같은 수 ${SAME_MOVE_FAILURE_LIMIT}회 실패 — 다른 수 선택 (${judged.move})` };
  }
  // 선례 승격 — 실패 승격 다음: 이번 수가 같은 서명 앞 런의 수와 겹치지 않게 한다(같은 수로 재발사 차단).
  if (matched !== undefined && (PRECEDENT_RELAUNCH_FAMILY.has(judged.move) || judged.move === 'alternative')) {
    if (judged.move === 'alternative' || sameSignature.some(prec => prec.outcome === 'alternative-failed')) {
      judged = { move: 'decision-card', stage: 'escalated',
        reason: `같은 must-fix 서명 선례 ${matched.runId} — 대안도 같은 서명으로 실패 — 사람 결정 (서명 ${signature})` };
    } else {
      judged = { move: 'alternative', stage: 'repairing',
        reason: `같은 must-fix 서명 선례 ${matched.runId} — 같은 수로 재발사하지 않고 다른 수 선택 (서명 ${signature})` };
    }
  }
  const executorKind = EXECUTOR_KIND[judged.move];
  const executorVariant = EXECUTOR_VARIANT[judged.move];
  if (!executorKind) return judged;
  return executorVariant ? { ...judged, executorKind, executorVariant } : { ...judged, executorKind };
}
