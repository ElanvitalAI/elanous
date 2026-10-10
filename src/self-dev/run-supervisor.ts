// ── 런 슈퍼바이저 — 「끝까지 돌린다」를 «판정»으로 만든다 ───────────────────────

import { hasDelivered, triageRun, type FailureClassification } from './orchestrate.js';
import type { DeployVerifyFinding } from '../harness/browser-verify.js';
import type { SelfDevJobResult, SupervisorStopReason, SupervisorNext } from './run-types.js';
export type { SupervisorStopReason } from './run-types.js';
import { recordSelfDevRunSupervisorStop, selfDevRunsDir } from './run-store.js';
import { debug } from '../debug/log.js';
import { sweepFrozenMerges } from '../self-implement/frozen-merges.js';
import { routeSupervisorVerdict } from './supervisor-verdict-edges.js';
import { recordTaskAgentShadowMove, type TaskAgentShadowInput } from '../task-agent/shadow.js';

export interface SupervisorRound {
  round: number;
  landed: number;
  /**
   * Pieces that finished (`ok=true`) with at least one new commit against
   * this run's own `--base` — not a main merge. Omitted on rounds that
   * never measured it, so older history stays comparable.
   */
  baseCompleted?: number;
  /** The run's own `--base` those completions were counted against. */
  base?: string;
  actionable: number;
  reviewMustFixTrend?: SupervisorDecision['reviewMustFixTrend'];
}

export const SUPERVISOR_STOP_REASONS = [
  'converged',
  'human-stopped',
  'parent-signals-red',
  'needs-human',
  'no-actionable-work',
  'harvestable-awaiting-human',
  'handed-off-to-salvage',
  'max-rounds',
  'no-progress',
  'provider-exhausted',
  'step-timeout',
  'decomposable-no-progress',
  'review-unobserved',
  'deliverable-unobserved',
  'deliverable-merged',
] as const satisfies readonly SupervisorStopReason[];

export const SUPERVISOR_ACTIONS = ['relaunch', 'add-repair-task', 'stop'] as const;

export interface DecomposePromotionOutcome {
  readonly reason: string;
  readonly pieceCount?: number;
  readonly dependsOnEdges?: number;
  readonly hotPathEdges?: number;
}

interface DecomposePromotionObservation {
  attempted: boolean;
  reason: string;
  pieceCount?: number;
  dependsOnEdges?: number;
  hotPathEdges?: number;
}

export interface SupervisorDecision {
  action: 'relaunch' | 'add-repair-task' | 'stop';
  stopReason?: SupervisorStopReason;
  why: string;
  round: number;
  rerunnable: string[];
  reworkable: string[];
  decomposable: string[];
  repairable: string[];
  needsHuman: string[];
  classifications: FailureClassification[];
  deliverableObservation: 'not-attempted' | 'failed' | 'observed';
  deliverableUnmeasured: boolean;
  deliverableMergeCompleteness: 'unmeasured' | 'complete' | 'incomplete';
  reviewMustFixTrend: 'unmeasured' | 'improving' | 'stable' | 'worsening';
}

export interface SupervisorLimits {
  maxRounds?: number;
  stallRounds?: number;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_STALL_ROUNDS = 2;

export function parentUnlandedProgressLine(feature: string, parentPrNumber?: number, parentNoPr = false): string {
  const detail = parentNoPr
    ? '앞 조각 커밋 main 미착지'
    : parentPrNumber === undefined
      ? '앞 조각 PR 번호 미확인 · main 착지 미확인'
      : `앞 조각 PR #${parentPrNumber} 미병합`;
  return `[supervisor] ⏸ 조각 ${feature} 대기 — ${detail}`;
}

export function countLanded(results: readonly SelfDevJobResult[]): number {
  return results.filter(hasDelivered).length;
}

/** One base label for the round. Mixed or missing bases stay unnamed. */
export function roundBase(results: readonly SelfDevJobResult[]): string | undefined {
  const bases = [...new Set(results.flatMap((result) => result.base === undefined ? [] : [result.base]))];
  return bases.length === 1 ? bases[0] : undefined;
}

/**
 * Finished pieces (`ok=true`) that added at least one commit against this
 * run's own `--base`. A main merge is not required, and a commit without
 * `ok=true` is not completion.
 */
export function countBaseCompleted(results: readonly SelfDevJobResult[]): number {
  return results.filter((result) => result.ok === true && (result.commitsAheadOfBase ?? 0) >= 1).length;
}

export function madeProgress(prev: SupervisorRound | undefined, next: SupervisorRound): boolean {
  if (!prev) return true;
  if (next.landed > 0) return true;
  if ((next.baseCompleted ?? 0) > (prev.baseCompleted ?? 0)) return true;
  if (next.actionable < prev.actionable) return true;
  return next.reviewMustFixTrend === 'improving';
}

function awaitingHumanStopWhy(classifications: readonly FailureClassification[]): string {
  const lines = classifications.map((c) => c.errorMessage ?? c.taskId);
  return `열린 PR 을 사람이 본다 — ${lines.join(' · ')}`;
}

function countActionable(t: ReturnType<typeof triageRun>): number {
  return t.rerunnable.length + t.reworkable.length + t.decomposable.length + t.repairable.length;
}

type GoalPlanRevisionObservation = SelfDevJobResult['goalPlanRevision'];
type GoalPlanRevisionReadObservation = Extract<NonNullable<GoalPlanRevisionObservation>, { status: 'read' }>;
type GoalPlanRevisionReadFailureObservation = Extract<NonNullable<GoalPlanRevisionObservation>, { status: 'read-failed' }>;

const GOAL_PLAN_REVISION_OBSERVATION_UNAVAILABLE = '골 개정 관측 불가 — 결과에 관측이 없다';

function formatGoalPlanRevisionObservation(results: readonly SelfDevJobResult[]): string | undefined {
  const carried = results
    .filter((result) => Object.hasOwn(result, 'goalPlanRevision'))
    .map((result) => result.goalPlanRevision as GoalPlanRevisionObservation);
  if (carried.length === 0) return GOAL_PLAN_REVISION_OBSERVATION_UNAVAILABLE;

  const parts: string[] = [];
  if (carried.some((observation) => observation === undefined)) {
    parts.push('골 개정 관측을 아직 읽지 않았다');
  }

  const readFailures = carried.filter((observation): observation is GoalPlanRevisionReadFailureObservation => observation?.status === 'read-failed');
  if (readFailures.length > 0) {
    const reasons = [...new Set(readFailures.map((observation) => observation.reason))];
    parts.push(`골 개정 관측 읽기 실패 — ${reasons.join(' · ')}`);
  }

  const read = carried.filter((observation): observation is GoalPlanRevisionReadObservation => observation?.status === 'read');
  if (read.length > 0) {
    const attempted = read.reduce((total, observation) => total + observation.attempted, 0);
    const applied = read.reduce((total, observation) => total + observation.applied, 0);
    const failureReasons = [...new Set(read.flatMap((observation) => observation.failureReasons))];
    parts.push(attempted === 0
      ? '골 개정 시도 없음 — 원장을 읽었으나 시도 0 · 적용 0'
      : `골 개정 시도 ${attempted} · 적용 ${applied}${failureReasons.length ? ` · 실패 사유 ${failureReasons.join(' · ')}` : ''}`);
  }

  return parts.join(' · ');
}

export type SupervisorJobResult = SelfDevJobResult & {
  reviewReason?: string;
  salvage?: 'launched' | 'parked';
  next?: SupervisorNext;
};

export function decideNextRun(input: {
  results: readonly SupervisorJobResult[];
  history?: readonly SupervisorRound[];
  limits?: SupervisorLimits;
  deployFindings?: ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] }>;
  deliverableObservation?: 'not-attempted' | 'failed' | 'observed';
  reviewed?: boolean;
  reviewReason?: string;
  deliverableMerge?: { readonly expected: number; readonly merged: number };
  reviewMustFixTrend?: 'improving' | 'stable' | 'worsening';
}): SupervisorDecision {
  const results = [...input.results];
  const history = [...(input.history ?? [])];
  const maxRounds = input.limits?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const stallRounds = input.limits?.stallRounds ?? DEFAULT_STALL_ROUNDS;
  const observation = input.deliverableObservation
    ?? (input.deployFindings !== undefined ? 'observed' : 'not-attempted');
  const deliverableMergeCompleteness: SupervisorDecision['deliverableMergeCompleteness'] = input.deliverableMerge === undefined
    ? 'unmeasured'
    : input.deliverableMerge.merged >= input.deliverableMerge.expected ? 'complete' : 'incomplete';
  const reviewMustFixTrend: SupervisorDecision['reviewMustFixTrend'] = input.reviewMustFixTrend ?? 'unmeasured';
  const handedOff = results.filter((result) => result.salvage === 'launched');
  const activeResults = results.filter((result) => result.salvage !== 'launched');
  const handedOffIds = new Set(handedOff.map((result) => result.taskId));
  const deployFindings = input.deployFindings === undefined ? undefined
    : new Map([...input.deployFindings].filter(([taskId]) => !handedOffIds.has(taskId)));
  const t = triageRun(activeResults, deployFindings, observation === 'failed');
  const round = history.length;
  const landed = countLanded(results);
  const baseCompleted = countBaseCompleted(results);
  const completionBase = roundBase(results);
  const actionable = countActionable(t);
  const thisRound: SupervisorRound = {
    round,
    landed,
    ...(baseCompleted > 0 || completionBase !== undefined ? { baseCompleted, ...(completionBase === undefined ? {} : { base: completionBase }) } : {}),
    actionable,
    reviewMustFixTrend,
  };
  const goalPlanRevisionObservation = formatGoalPlanRevisionObservation(results);
  const withGoalPlanRevisionObservation = (why: string): string => goalPlanRevisionObservation
    && goalPlanRevisionObservation !== GOAL_PLAN_REVISION_OBSERVATION_UNAVAILABLE
    ? `${why} · ${goalPlanRevisionObservation}`
    : why;
  const withNoProgressGoalPlanRevisionObservation = (why: string): string => goalPlanRevisionObservation
    ? `${why} · ${goalPlanRevisionObservation}`
    : why;

  const base = {
    round,
    deliverableObservation: observation,
    deliverableUnmeasured: t.deliverableUnmeasured,
    deliverableMergeCompleteness,
    reviewMustFixTrend,
    rerunnable: t.rerunnable,
    reworkable: t.reworkable,
    decomposable: t.decomposable,
    repairable: t.repairable,
    needsHuman: t.needsHuman,
    classifications: t.classifications,
  };

  const unlandedParents = results.filter((result) => result.blockReason === 'parent-unlanded');
  if (unlandedParents.length > 0) {
    return {
      ...base,
      action: 'stop',
      stopReason: 'needs-human',
      why: unlandedParents.map((result) => parentUnlandedProgressLine(result.feature.split('\n')[0]!, result.parentPrNumber, result.parentNoPr === true)).join(' · '),
    };
  }

  const harvestable = results.filter((result) => result.harvestable === true && !!result.branch);
  if (harvestable.length > 0) {
    return {
      ...base,
      action: 'stop',
      stopReason: 'harvestable-awaiting-human',
      why: withGoalPlanRevisionObservation(`구현 완료 · 수확 대기 — ${harvestable.map((result) => result.branch).join(' · ')}`),
    };
  }

  if (deliverableMergeCompleteness === 'complete') {
    return {
      ...base,
      action: 'stop',
      stopReason: 'deliverable-merged',
      why: withGoalPlanRevisionObservation(`산출물 전체가 이미 병합됐다 — 기대 ${input.deliverableMerge!.expected} · 병합 ${input.deliverableMerge!.merged}`),
    };
  }

  if (handedOff.length > 0 && t.classifications.length === 0) {
    for (const { taskId: jobId } of handedOff) {
      try { debug.log('self-dev.supervisor', 'handed-off-to-salvage', { jobId }); } catch { /* fail-open */ }
    }
    return {
      ...base,
      action: 'stop',
      stopReason: 'handed-off-to-salvage',
      why: withGoalPlanRevisionObservation(`수확 자식에게 넘겼다 — ${handedOff.map((result) => result.taskId).join(' · ')}`),
    };
  }

  if (t.classifications.length === 0) {
    if (input.reviewed === false && input.reviewReason !== 'no-diff') {
      return {
        ...base,
        action: 'stop',
        stopReason: 'review-unobserved',
        why: withGoalPlanRevisionObservation(`조각은 끝났으나 리뷰를 «못 돌렸다» — 착지 ${landed} · ⛔ 「리뷰 통과」가 아니다`),
      };
    }
    if (observation === 'failed') {
      return {
        ...base,
        action: 'stop',
        stopReason: 'deliverable-unobserved',
        why: withGoalPlanRevisionObservation(`조각은 끝났으나 산출물을 «못 봤다» — 착지 ${landed} · ⛔ 「결함 0」이 아니다`),
      };
    }
    return {
      ...base,
      action: 'stop',
      stopReason: 'converged',
      why: withGoalPlanRevisionObservation(`완주 — 미해결 조각 0 · 이번 라운드 착지 ${landed}`),
    };
  }

  // 열린 PR(awaiting-human)만 남으면 제자리·재작업으로 읽지 않는다. 다른 자동 작업이 있으면 기존 규칙을 그대로 탄다.
  const awaitingHuman = t.classifications.filter((c) => c.kind === 'awaiting-human' && c.action === 'needs-human');
  if (
    awaitingHuman.length > 0
    && t.rerunnable.length === 0
    && t.reworkable.length === 0
    && t.decomposable.length === 0
    && t.repairable.length === 0
  ) {
    return {
      ...base,
      action: 'stop',
      stopReason: 'needs-human',
      why: withGoalPlanRevisionObservation(awaitingHumanStopWhy(awaitingHuman)),
    };
  }

  if (!t.actionable) {
    if (t.needsHuman.length > 0) {
      return {
        ...base,
        action: 'stop',
        stopReason: 'needs-human',
        why: withGoalPlanRevisionObservation(`자동으로 다시 걸 수 있는 조각이 없다 — 사람이 볼 것 ${t.needsHuman.length}`),
      };
    }
    return {
      ...base,
      action: 'stop',
      stopReason: 'no-actionable-work',
      why: withGoalPlanRevisionObservation('자동으로 다시 걸 수 있는 조각도 사람이 볼 것도 없다 — 미해결 분류는 완료로 재분류하지 않는다'),
    };
  }

  // Only stop when every candidate for the next round is blocked by observed quota exhaustion.
  const retryIds = [...new Set([...t.rerunnable, ...t.reworkable, ...t.decomposable, ...t.repairable])];
  if (retryIds.length > 0 && retryIds.every((taskId) => results.some((result) =>
    result.taskId === taskId && result.providerErrors?.category === 'quota'))) {
    const failures = results.filter((result) => retryIds.includes(result.taskId));
    return {
      ...base,
      action: 'stop',
      stopReason: 'provider-exhausted',
      why: `공급자 한도 소진 — ${failures.map((result) => `${result.providerErrors!.provider} 오류 ${result.providerErrors!.count}건`).join(' · ')}. elanous usage 로 잔량 확인 · --role-llm/--child-llm-provider 로 다른 공급자 선택`,
    };
  }

  if (round + 1 > maxRounds) {
    return {
      ...base,
      action: 'stop',
      stopReason: 'max-rounds',
      why: withGoalPlanRevisionObservation(`라운드 상한(${maxRounds})에 닿았다 — 남은 조각 ${actionable} · 다시 걸려면 상한을 올려라`),
    };
  }

  const recent = [...history, thisRound].slice(-(stallRounds + 1));
  if (recent.length > stallRounds) {
    const stalled = recent.slice(1).every((r, i) => !madeProgress(recent[i], r));
    if (stalled) {
      const decomposableResult = results.find((result) =>
        t.decomposable.includes(result.taskId)
        && (result.decomposeProposal?.pieces?.length ?? 0) >= 2,
      );
      const pieces = decomposableResult?.decomposeProposal?.pieces;
      if (decomposableResult && pieces && pieces.length >= 2) {
        return {
          ...base,
          action: 'stop',
          stopReason: 'decomposable-no-progress',
          why: withGoalPlanRevisionObservation(`${stallRounds}라운드 연속 제자리지만 분해 제안이 있다 — ${decomposableResult.feature}을(를) 조각 ${pieces.length}개로: ${pieces.map((piece) => piece.feature).join(' · ')}`),
        };
      }
      // 🩸 2026-09-24 🅕: 결말을 가른 것은 공급자 오류 수가 아니라 «리뷰가 시간 안에 판정을 냈나»였다(n=3 · step-timeout 0·1·2
      //   가 결말과 같은 순서). 제자리의 원인이 단계 시간 초과면 «골을 의심하라» 대신 그 이름을 댄다.
      const stalledRetryIds = [...new Set([...t.rerunnable, ...t.reworkable, ...t.decomposable, ...t.repairable])];
      const timedOut = results.filter((result) => stalledRetryIds.includes(result.taskId) && result.stage === 'timed-out');
      if (stalledRetryIds.length > 0 && timedOut.length === stalledRetryIds.length) {
        const providerNote = timedOut.some((result) => result.providerErrors)
          ? ` · 같은 라운드 공급자 오류: ${timedOut.filter((result) => result.providerErrors).map((result) => `${result.providerErrors!.provider} ${result.providerErrors!.count}건(${result.providerErrors!.category})`).join(' · ')}`
          : '';
        return {
          ...base,
          action: 'stop',
          stopReason: 'step-timeout',
          why: `${stallRounds}라운드 연속 제자리 — 재시도 후보 ${timedOut.length}개가 전부 단계 시간 초과(timed-out)로 판정 없이 끝났다${providerNote}. 골 결손이 아니라 단계 예산 문제일 수 있다 — 공급자 지연(elanous usage · --role-llm)·리뷰 diff 크기를 본다`,
        };
      }
      return {
        ...base,
        action: 'stop',
        stopReason: 'no-progress',
        why: withNoProgressGoalPlanRevisionObservation(`${stallRounds}라운드 연속 제자리 — base=${completionBase ?? 'main'} 기준 완료 ${baseCompleted} · 착지 ${landed} · 남은 조각도 안 줄었다(${actionable}). 골·불변식을 의심할 자리`),
      };
    }
  }

  if (t.repairable.length > 0) {
    return {
      ...base,
      action: 'add-repair-task',
      why: `수리 조각을 붙인다 — 수리 ${t.repairable.length} · 그대로 재실행 ${t.rerunnable.length} · 재작업 ${t.reworkable.length} · 분해 ${t.decomposable.length} · 라운드 ${round + 1}/${maxRounds}`,
    };
  }

  return {
    ...base,
    action: 'relaunch',
    why: `다시 건다 — 그대로 재실행 ${t.rerunnable.length} · 재작업 ${t.reworkable.length} · 분해 ${t.decomposable.length} · 수리 ${t.repairable.length} · 라운드 ${round + 1}/${maxRounds}`,
  };
}

export function appendRound(
  history: readonly SupervisorRound[],
  results: readonly SupervisorJobResult[],
  reviewMustFixTrend?: SupervisorDecision['reviewMustFixTrend'],
): SupervisorRound[] {
  const t = triageRun(results.filter((result) => result.salvage !== 'launched'));
  const baseCompleted = countBaseCompleted(results);
  const base = roundBase(results);
  return [...history, {
    round: history.length,
    landed: countLanded(results),
    ...(baseCompleted > 0 || base !== undefined ? { baseCompleted, ...(base === undefined ? {} : { base }) } : {}),
    actionable: countActionable(t),
    ...(reviewMustFixTrend === undefined ? {} : { reviewMustFixTrend }),
  }];
}

export interface SuperviseRunOptions {
  initial: readonly SupervisorJobResult[];
  rerun: (previous: readonly SupervisorJobResult[], invocation: { relaunch: true }) => Promise<readonly SupervisorJobResult[]>;
  limits?: SupervisorLimits;
  enrich?: (results: readonly SupervisorJobResult[]) => readonly SupervisorJobResult[];
  onDecision?: (decision: SupervisorDecision) => void;
  promoteDecomposition?: (input: {
    readonly decision: SupervisorDecision;
    readonly previous: readonly SelfDevJobResult[];
  }) => Promise<DecomposePromotionOutcome> | DecomposePromotionOutcome;
  onRound?: (results: readonly SupervisorJobResult[]) => void;
  runStore?: { runId?: string; operatorDir?: string; dir?: string; isolatedDir?: string };
  observe?: (event: string, data: Record<string, unknown>) => void;
  sweepPendingMerges?: typeof sweepFrozenMerges;
  /**
   * TASK-AGENT-SHADOW — 멈춤이 확정되면 판단부를 그림자로 부른다(기본 `recordTaskAgentShadowMove`).
   * `false` 면 끈다. 던져도 런의 결말은 바뀌지 않는다(fail-soft).
   */
  taskAgentShadow?: ((input: TaskAgentShadowInput) => unknown) | false;
  observeDeliverables?: () => Promise<{
    readonly deployFindings: ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] | readonly unknown[] }>;
    readonly unmeasured: readonly unknown[];
  }>;
}

type SupervisorStopStorageSource = 'operator-dir' | 'run-store-dir' | 'process-default';

function resolveSupervisorStopStorage(runStore: SuperviseRunOptions['runStore']): {
  path: string;
  source: SupervisorStopStorageSource;
} {
  if (runStore?.operatorDir !== undefined) return { path: runStore.operatorDir, source: 'operator-dir' };
  if (runStore?.dir !== undefined) return { path: runStore.dir, source: 'run-store-dir' };
  return { path: selfDevRunsDir(), source: 'process-default' };
}

export async function superviseRun(opts: SuperviseRunOptions): Promise<SupervisorJobResult[]> {
  let results = [...opts.initial];
  let history: SupervisorRound[] = [];

  for (;;) {
    try {
      const resumed = await (opts.sweepPendingMerges ?? sweepFrozenMerges)();
      if (resumed.pending || resumed.merged) opts.observe?.('frozen-merges', resumed);
    } catch (error) {
      try { debug.log('harness.merge', 'resume-failed', { error: String(error) }); } catch { /* observation must not interrupt supervision */ }
    }
    if (opts.enrich) results = [...opts.enrich(results)];

    let observed: {
      deployFindings?: ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] }>;
      state: 'not-attempted' | 'failed' | 'observed';
    } = { state: 'not-attempted' };

    if (opts.observeDeliverables !== undefined) {
      try {
        const seen = await opts.observeDeliverables();
        observed = {
          deployFindings: seen.deployFindings as ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] }>,
          state: seen.unmeasured.length > 0 ? 'failed' : 'observed',
        };
        try {
          opts.observe?.('deliverable-observe.observed', {
            addressCount: seen.deployFindings.size,
            results: [...seen.deployFindings.entries()].map(([taskId, result]) => ({ taskId, ...result })),
            unmeasured: seen.unmeasured,
          });
        } catch { /* fail-open */ }
      } catch (error) {
        observed = { state: 'failed' };
        try {
          opts.observe?.('deliverable-observe.failed', { error: String(error) });
        } catch { /* fail-open */ }
      }
    }

    const unreviewed = results.filter((result) => result.reviewed === false);
    const allUnreviewedAreNoDiff = unreviewed.length > 0
      && unreviewed.every((result) => result.reviewReason === 'no-diff');

    const decision = decideNextRun({
      results,
      history,
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(observed.deployFindings ? { deployFindings: observed.deployFindings } : {}),
      deliverableObservation: observed.state,
      ...(unreviewed.length > 0 ? {
        reviewed: false,
        ...(allUnreviewedAreNoDiff ? { reviewReason: 'no-diff' } : {}),
      } : {}),
    });

    const runId = opts.runStore?.runId ?? results.find((result) => result.runId?.trim())?.runId ?? null;

    let decomposePromotion: DecomposePromotionObservation = decision.decomposable.length === 0
      ? { attempted: false, reason: 'no-decomposable-decision' }
      : decision.action === 'stop'
        ? { attempted: false, reason: 'decision-stopped' }
        : { attempted: false, reason: 'shim-omitted' };

    if (decision.action !== 'stop' && decision.decomposable.length > 0 && opts.promoteDecomposition !== undefined) {
      try {
        const outcome = await opts.promoteDecomposition({ decision, previous: results });
        decomposePromotion = {
          attempted: true,
          reason: outcome.reason,
          ...(outcome.pieceCount === undefined ? {} : { pieceCount: outcome.pieceCount }),
          ...(outcome.dependsOnEdges === undefined ? {} : { dependsOnEdges: outcome.dependsOnEdges }),
          ...(outcome.hotPathEdges === undefined ? {} : { hotPathEdges: outcome.hotPathEdges }),
        };
      } catch (error) {
        decomposePromotion = { attempted: true, reason: `shim-failed: ${String(error)}` };
      }
    }

    try {
      const walkSummary = results.some((r) => r.walk !== undefined)
        ? {
            walkNodeCount: results.reduce((n, r) => n + (r.walk?.length ?? 0), 0),
            walkNodes: [...new Set(results.flatMap((r) => (r.walk ?? []).map((w) => w.node)))].sort(),
          }
        : { walkNodeCount: null, walkNodes: null };

      opts.observe?.('decision', {
        ...walkSummary,
        runId,
        round: decision.round,
        action: decision.action,
        stopReason: decision.stopReason ?? null,
        why: decision.why,
        rerunnable: decision.rerunnable.length,
        reworkable: decision.reworkable.length,
        decomposable: decision.decomposable.length,
        repairable: decision.repairable.length,
        needsHuman: decision.needsHuman.length,
        deliverableObservation: decision.deliverableObservation,
        deliverableUnmeasured: decision.deliverableUnmeasured,
        shards: results.length,
        kinds: decision.classifications.map((c) => `${c.kind}:${c.action}`),
        decomposePromotionAttempted: decomposePromotion.attempted,
        decomposePromotionReason: decomposePromotion.reason,
        ...(decomposePromotion.pieceCount === undefined ? {} : { decomposePieceCount: decomposePromotion.pieceCount }),
        ...(decomposePromotion.dependsOnEdges === undefined ? {} : { decomposeDependsOnEdges: decomposePromotion.dependsOnEdges }),
        ...(decomposePromotion.hotPathEdges === undefined ? {} : { decomposeHotPathEdges: decomposePromotion.hotPathEdges }),
      });
    } catch { /* fail-open */ }

    try {
      opts.onDecision?.(decision);
    } catch { /* fail-open */ }

    if (decision.action === 'stop') {
      const reason = decision.stopReason ?? 'unregistered-stop';
      const next = routeSupervisorVerdict(reason, results).next;
      try { debug.log('self-dev.supervisor', 'verdict-edge', { runId, reason, next }); } catch { /* observation must not interrupt supervision */ }
      results = results.map((result) => ({ ...result, next }));
      if (runId && decision.stopReason) {
        const storage = resolveSupervisorStopStorage(opts.runStore);
        const persistence = recordSelfDevRunSupervisorStop(runId, decision.stopReason, storage.path, next);
        const storageObservation = {
          storagePath: storage.path,
          storageSource: storage.source,
        };
        try {
          opts.observe?.(`supervisor-stop.${persistence.outcome}`, {
            runId,
            reason: decision.stopReason,
            outcome: persistence.outcome,
            ...storageObservation,
          });
        } catch { /* fail-open */ }
      }
      if (decision.stopReason && opts.taskAgentShadow !== false) {
        // TASK-AGENT-SHADOW — 판단부를 그림자로 부른다(실행 0). 어떤 오류도 런의 결말을 바꾸지 않는다.
        try {
          const pr = results.find((result) => typeof result.prNumber === 'number' && result.prNumber > 0)?.prNumber;
          const reviewed = results.filter((result) => result.prNumber === pr && result.selfReview && result.merged !== true);
          const selfReview = pr && reviewed.length === 1 ? reviewed[0]!.selfReview : undefined;
          await (opts.taskAgentShadow ?? recordTaskAgentShadowMove)({ runId, stopReason: decision.stopReason, results,
            ...(selfReview ? { selfReview } : {}), cycleId: `${runId ?? 'unknown'}:${decision.round}` });
        } catch (error) {
          try { debug.log('task-agent', 'shadow-move-failed', { runId, stopReason: decision.stopReason, error: String(error) }); } catch { /* fail-open */ }
        }
      }
      return results;
    }

    history = appendRound(history, results, decision.reviewMustFixTrend);
    results = [...await opts.rerun(results, { relaunch: true })];

    try {
      opts.onRound?.(results);
    } catch { /* fail-open */ }
  }
}
