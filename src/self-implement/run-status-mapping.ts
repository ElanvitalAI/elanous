export type RunStatus = 'completed' | 'failed' | 'cancelled' | 'parked';
/** ⭐ `crashed` — ***잡히지 않은 예외로 죽어 종결을 스스로 못 적은*** 런 (2026-08-11 · 🅣⊕🅢 어휘 합의).
 *  ⛔ `aborted`(스스로 중단을 «판정»했다)와 다른 값이다 — 이쪽은 «판정할 겨를이 없었다».
 *  📏 왜 생겼나: 실측 미완 57 중 ≈38 이 어느 원장에도 종결이 없었고, 멈춘 자리가 전부 「노드 안」이었다. */
export type FailureKind = 'gate' | 'review' | 'merge-conflict' | 'aborted' | 'timed-out' | 'crashed';

export interface MappedRunOutcome {
  runStatus: RunStatus;
  failureKind?: FailureKind;
}

export type SelfImplementStage =
  | 'merged'
  | 'pr-opened'
  | 'merge-ready'
  | 'worktree-completed'
  | 'gate-failed'
  | 'review-blocked'
  | 'merge-conflict'
  | 'aborted'
  | 'timed-out'
  | 'pr-declined'
  | 'soft-stopped'
  | 'parked';

const STAGE_OUTCOMES = {
  merged: { runStatus: 'completed' },
  'pr-opened': { runStatus: 'completed' },
  'merge-ready': { runStatus: 'completed' },
  'worktree-completed': { runStatus: 'completed' },
  'gate-failed': { runStatus: 'failed', failureKind: 'gate' },
  'review-blocked': { runStatus: 'failed', failureKind: 'review' },
  'merge-conflict': { runStatus: 'failed', failureKind: 'merge-conflict' },
  aborted: { runStatus: 'failed', failureKind: 'aborted' },
  'timed-out': { runStatus: 'failed', failureKind: 'timed-out' },
  'pr-declined': { runStatus: 'cancelled' },
  'soft-stopped': { runStatus: 'cancelled' },
  parked: { runStatus: 'parked' },
} satisfies Record<SelfImplementStage, MappedRunOutcome>;

const RUN_STATUSES = new Set<RunStatus>(['completed', 'failed', 'cancelled', 'parked']);

/** Runtime guard for the run-status payload produced by observeRunOutcome. */
export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value as RunStatus);
}

export function mapStageToRunStatus(stage: string): MappedRunOutcome | null {
  if (!Object.hasOwn(STAGE_OUTCOMES, stage)) return null;
  return { ...STAGE_OUTCOMES[stage as SelfImplementStage] };
}
