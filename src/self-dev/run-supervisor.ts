// ── 런 슈퍼바이저 — 「끝까지 돌린다」를 «판정»으로 만든다 ───────────────────────

import { hasDelivered, resumeKey, triageRun, type FailureClassification } from './orchestrate.js';
import type { DeployVerifyFinding } from '../harness/browser-verify.js';
import type { SelfDevJobResult, SupervisorStopReason, SupervisorNext, ReviewRework } from './run-types.js';
import { authorRepairGoal } from '../harness/helper-repair.js';
export type { SupervisorStopReason } from './run-types.js';
export { SUPERVISOR_STOP_REASONS } from './run-types.js';
import { recordSelfDevRunSupervisorStop, selfDevRunsDir } from './run-store.js';
import { debug } from '../debug/log.js';
import { sweepFrozenMerges } from '../self-implement/frozen-merges.js';
import { routeSupervisorVerdict } from './supervisor-verdict-edges.js';
import { recordTaskAgentShadowMove, runCardFor, type TaskAgentShadowInput } from '../task-agent/shadow.js';
import { cardPrNumber, taskAgentStatePath } from '../task-agent/task-hand.js';
import {
  classifyMustFixRound, inferMustFixEvidence, judgeMustFixScope, proposeMustFixSplit,
  type MustFixRoundClassification, type MustFixRoundObservation, type MustFixScope, type MustFixScopeJudgement, type MustFixSplitProposal,
} from '../self-implement/review-mustfix-class.js';

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
  signatures?: Record<string, string>;
  oscillationRepairTaskIds?: string[];
  /** Feature of each `oscillationRepairTaskIds` entry (same index) — reruns that mint a new taskId per round keep the goal. */
  oscillationRepairFeatures?: string[];
  /** Authored repair goal texts of that round, by taskId. */
  oscillationRepairGoals?: Record<string, string>;
  /** Tasks whose one main-sync relaunch this round used. */
  mainSyncRelaunchTaskIds?: string[];
  /** Original feature and relaunch goal text of those tasks — a rerun may mint a new taskId, so the piece is also found by goal. */
  mainSyncRelaunchFeatures?: string[];
  /**
   * Tasks of this round that ended `status=failed` without a PR. Omitted when there are none — and on older
   * history, which never measured it, so the no-PR streak guard reads it as «not measured» and stays off.
   */
  noPrTaskIds?: string[];
  /**
   * Piece key (normalized feature — {@link noPrStreakKey}) of each `noPrTaskIds` entry, same index. A rework round mints a
   * new taskId for the same piece (run-27b03878: task:1ded008a8aeb → task:f54a6e6fca25 → task:fade5a6931a4), so the no-PR
   * streak pairs rounds by this key. Omitted on older history — the guard then pairs by taskId as before.
   */
  noPrFeatureKeys?: string[];
  /** REVIEW-MUSTFIX-CLASSIFY — that round's observed must-fix items; pairs the next round's classification. */
  mustFix?: MustFixRoundObservation;
  /**
   * PATTERN-MINE LOST-TIME — ms that round's undelivered results spent, banked into the ledger when their
   * generation is replaced by a rerun (failures and re-runs both count — «잃은 시간» is not only the last round).
   * A task held for a human (`decision.oscillation.heldTaskIds`) survives into the next round as the same
   * execution, so its time banks only when it leaves or at the terminal mine — never twice. Omitted when
   * nothing banked, so older history and rounds without a measured duration stay comparable.
   */
  lostTimeMsByTask?: Record<string, number>;
  /** Tasks that left this round without a measured duration; a later measured rerun cannot make their total known. */
  unknownTimeTaskIds?: string[];
}

/** Failed without a PR — a result that carries either a PR number or a PR URL has one (fixtures and older producers set only one). */
function failedWithoutPr(result: SupervisorJobResult): boolean {
  return result.status === 'failed' && result.prNumber === undefined && !result.prUrl;
}

/**
 * «Same piece» key for the no-PR streak guard: the feature text with whitespace collapsed, lower-cased and trailing
 * punctuation dropped. Empty when the result carries no feature — the caller then falls back to the taskId.
 */
export function noPrStreakKey(feature: unknown): string {
  return typeof feature === 'string' ? resumeKey(feature).replace(/[\s.,;:!?。…·]+$/u, '') : '';
}

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
  /** Pieces whose main sync is blocked for the first time — relaunched on the latest main instead of waiting for a human. */
  relaunchOnMain: string[];
  /** Relaunch goal by taskId for the `relaunchOnMain` pieces that kept a branch; the rerun receives these as `repairGoals`. */
  relaunchGoals?: Record<string, string>;
  needsHuman: string[];
  classifications: FailureClassification[];
  deliverableObservation: 'not-attempted' | 'failed' | 'observed';
  deliverableUnmeasured: boolean;
  deliverableMergeCompleteness: 'unmeasured' | 'complete' | 'incomplete';
  reviewMustFixTrend: ReviewRework['trend'];
  /** REVIEW-MUSTFIX-CLASSIFY — this round's leading must-fix class (② › ③ observed › ①); omitted when unmeasured (지금 동작 그대로). */
  mustFix?: MustFixRoundClassification;
  /** REVIEW-MUSTFIX-CLASSIFY — every oscillating task's measured class, so a mixed round keeps each task's decision. */
  mustFixByTask?: Record<string, MustFixRoundClassification>;
  /**
   * REVIEW-MUSTFIX-CLASSIFY 범위 축 — must-fix 한 줄마다 (가) in-scope / (나) split / (다) ask-owner.
   * split 은 같은 런 재수리에서 빠지고 «중간 착지 ⊕ 연결 골» 제안을 싣는다(파일·칸 쓰기는 다음 조각 — 이번엔 결정 칸까지).
   * ask-owner 는 칸 주인 HITL 제안. 진동 경로에서 must-fix 를 잰 조각만 — 없으면 생략(지금 동작 그대로).
   */
  mustFixScope?: {
    byTask: Record<string, MustFixScopeJudgement[]>;
    split?: Array<{ taskId: string; action: '중간 착지 ⊕ 연결 골'; proposals: MustFixSplitProposal[] }>;
    askOwner?: Array<{ taskId: string; hitl: string; items: string[] }>;
  };
  oscillation?: { taskIds: string[]; helper: 'review-oscillation'; signature: string; repairGoals?: Record<string, string>; heldTaskIds?: string[] };
  pendingDecision?: 'attempt-care-escalation';
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
  return t.rerunnable.length + t.reworkable.length + t.decomposable.length + t.repairable.length + t.relaunchOnMain.length;
}

/** The goal a main-sync relaunch runs: the same goal text under one head line naming the preserved branch. */
export function mainSyncRelaunchGoal(feature: string, branch: string): string {
  return `참고 가지: ${branch} — 앞 런 구현. 최신 main 위에서 같은 의도를 다시 구현하되 이 가지의 diff 를 참고\n${feature}`;
}

/** A piece gets one main-sync relaunch: spent when an earlier round recorded its task or its goal (original or relaunch text). */
function mainSyncRelaunchSpent(history: readonly SupervisorRound[]): (result: SelfDevJobResult) => boolean {
  const taskIds = new Set(history.flatMap((entry) => entry.mainSyncRelaunchTaskIds ?? []));
  const features = new Set(history.flatMap((entry) => entry.mainSyncRelaunchFeatures ?? []).map(resumeKey));
  return (result) => taskIds.has(result.taskId) || features.has(resumeKey(result.feature));
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

export function aggregateReviewTrend(results: readonly SelfDevJobResult[]): ReviewRework['trend'] | undefined {
  const trends = results.flatMap((result) => result.rework ? [result.rework.trend] : []);
  if (!trends.length) return undefined;
  const severity: readonly ReviewRework['trend'][] = ['unmeasured', 'improving', 'stable', 'worsening', 'oscillating'];
  return severity[Math.max(...trends.map((trend) => severity.indexOf(trend)))];
}

/**
 * REVIEW-MUSTFIX-CLASSIFY — this round's must-fix observation from the results' verbatim `reviewMustFix`.
 * Each item carries its `taskId` so the next round pairs per task (one task's recurrence never holds another).
 */
function mustFixFromResults(results: readonly SupervisorJobResult[]): MustFixRoundObservation {
  const items = results.flatMap((result) => (result.reviewMustFix ?? []).map((text) => {
    const evidence = inferMustFixEvidence(text);
    return { text, taskId: result.taskId, ...(evidence === undefined ? {} : { evidence }) };
  }));
  return items.length > 0 ? { items } : {};
}

/**
 * REVIEW-MUSTFIX-CLASSIFY — per-task class. `prev` is the preceding round's items of the same task or its repair
 * lineage (`oscillationRepairOf`), and only when that preceding round authored a repair for it — «수리 뒤 같은 지적»
 * means a repair ran between the last observation and this one, not «repaired at any time». Lineage items are
 * re-scoped to this task so the pure pairing accepts them; unrelated tasks never pair.
 */
function classifyTaskMustFix(result: SupervisorJobResult, preceding: SupervisorRound | undefined): MustFixRoundClassification {
  const pairIds = new Set([result.taskId, ...(result.oscillationRepairOf ? [result.oscillationRepairOf] : [])]);
  const repairedSincePrev = (preceding?.oscillationRepairTaskIds ?? []).some((id) => pairIds.has(id));
  const prevItems = repairedSincePrev
    ? (preceding?.mustFix?.items ?? []).filter((item) => item.taskId !== undefined && pairIds.has(item.taskId))
      .map((item) => ({ ...item, taskId: result.taskId }))
    : [];
  return classifyMustFixRound(prevItems.length > 0 ? { items: prevItems } : undefined, mustFixFromResults([result]));
}

/**
 * Classes/scopes that hold a task out of this round's same-run repair: ② post-land-evidence, and (나) split when
 * every must-fix item of the task is split (③ recurring items are split). A partly split task is repaired with its
 * non-split items only.
 */
const MUST_FIX_HELD = new Set<MustFixRoundClassification['class'] | MustFixScope>(['post-land-evidence', 'split']);
// ⚠️ 'post-land-evidence' 는 보류 «사유» 문면에만 쓰인다 — 보류 여부는 줄 단위 'split'(② 줄 포함)이 정한다.

/**
 * REVIEW-MUSTFIX-CLASSIFY 범위 축 — 한 조각의 must-fix 를 줄마다 범위 판정한다. `prevItems` 는 앞 회차 원장의 같은
 * 조각(또는 수리 계보) 지적 — 앞 회차가 must-fix 를 안 쟀으면 undefined(new-axis 신호를 안 낸다).
 */
function judgeTaskMustFixScope(
  result: SupervisorJobResult, preceding: SupervisorRound | undefined, classification: MustFixRoundClassification,
): MustFixScopeJudgement[] {
  const items = mustFixFromResults([result]).items ?? [];
  const pairIds = new Set([result.taskId, ...(result.oscillationRepairOf ? [result.oscillationRepairOf] : [])]);
  const precedingItems = preceding?.mustFix?.items;
  const prevItems = precedingItems === undefined ? undefined
    : precedingItems.filter((item) => item.taskId !== undefined && pairIds.has(item.taskId));
  return items.map((item) => judgeMustFixScope(item, {
    ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
    ...(result.targetPaths ? { targetPaths: result.targetPaths } : {}),
    ...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
    ...(result.rework?.rounds !== undefined ? { reviewRound: result.rework.rounds } : {}),
    ...(prevItems !== undefined ? { prevItems } : {}),
    ...(classification.recurring ? { recurring: classification.recurring } : {}),
  }));
}

/**
 * 범위 판정을 결정 칸으로 접고 줄마다 관측을 남긴다 — (나) 는 «중간 착지 ⊕ 연결 골» 제안, (다) 는 칸 주인 HITL 제안.
 * 실제 연결 골 파일·칸 근거 쓰기·intent 자동 주입 실행은 다음 조각.
 */
function mustFixScopeDecision(
  oscillating: readonly SupervisorJobResult[],
  taskClasses: ReadonlyMap<string, MustFixRoundClassification>,
  taskScopes: ReadonlyMap<string, MustFixScopeJudgement[]>,
): SupervisorDecision['mustFixScope'] {
  const byTask: Record<string, MustFixScopeJudgement[]> = {};
  const split: NonNullable<NonNullable<SupervisorDecision['mustFixScope']>['split']> = [];
  const askOwner: NonNullable<NonNullable<SupervisorDecision['mustFixScope']>['askOwner']> = [];
  for (const result of oscillating) {
    const judged = taskScopes.get(result.taskId) ?? [];
    if (judged.length === 0 || byTask[result.taskId]) continue;
    byTask[result.taskId] = judged;
    const cls = taskClasses.get(result.taskId)?.class ?? 'unmeasured';
    for (const j of judged) {
      const action = j.scope === 'split' ? 'split-link-goal' : j.scope === 'ask-owner' ? 'ask-owner-hitl' : 'fix-same-run';
      try { debug.log('self-dev.supervisor', 'mustfix-scope', { taskId: result.taskId, class: cls, scope: j.scope, signals: j.signals, action }); } catch { /* fail-open */ }
    }
    const splits = judged.filter((j) => j.scope === 'split');
    if (splits.length) {
      split.push({ taskId: result.taskId, action: '중간 착지 ⊕ 연결 골',
        proposals: splits.map((j) => proposeMustFixSplit(j)) });
    }
    const asks = judged.filter((j) => j.scope === 'ask-owner');
    if (asks.length) {
      askOwner.push({ taskId: result.taskId, items: asks.map((j) => j.text),
        hitl: `칸 주인에게 묻는다 — must-fix ${asks.length}건 범위 판단 불가(${[...new Set(asks.map((j) => j.reason))].join(' · ')})` });
    }
  }
  if (Object.keys(byTask).length === 0) return undefined;
  return { byTask, ...(split.length ? { split } : {}), ...(askOwner.length ? { askOwner } : {}) };
}

export function decideNextRun(input: {
  results: readonly SupervisorJobResult[];
  history?: readonly SupervisorRound[];
  limits?: SupervisorLimits;
  deployFindings?: ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] }>;
  deliverableObservation?: 'not-attempted' | 'failed' | 'observed';
  reviewed?: boolean;
  reviewReason?: string;
  deliverableMerge?: { readonly expected: number; readonly merged: number };
  reviewMustFixTrend?: ReviewRework['trend'];
  /** True: the rerun consumes the authored goal. False: it cannot, so oscillation stops for a human. Undefined: pure decision. */
  repairGoalExecution?: boolean;
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
  const t = triageRun(activeResults, deployFindings, observation === 'failed', undefined, mainSyncRelaunchSpent(history));
  const relaunchGoals: Record<string, string> = Object.fromEntries(activeResults.flatMap((result) =>
    t.relaunchOnMain.includes(result.taskId) && result.branch
      ? [[result.taskId, mainSyncRelaunchGoal(result.feature, result.branch)]] : []));
  const noteMainSyncRelaunch = (): void => {
    for (const taskId of t.relaunchOnMain) {
      const branch = activeResults.find((result) => result.taskId === taskId)?.branch ?? null;
      try { debug.log('self-dev.supervisor', 'merge-conflict-relaunch', { taskId, branch, attempt: 1 }); } catch { /* fail-open */ }
    }
  };
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
    relaunchOnMain: t.relaunchOnMain,
    ...(Object.keys(relaunchGoals).length > 0 ? { relaunchGoals } : {}),
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

  // A first main-sync block is relaunched before it is judged harvestable; the spent ones stop for a human as before.
  const harvestable = results.filter((result) => result.harvestable === true && !!result.branch
    && !t.relaunchOnMain.includes(result.taskId));
  if (harvestable.length > 0 && t.relaunchOnMain.length === 0) {
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
    && t.relaunchOnMain.length === 0
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
  const retryIds = [...new Set([...t.rerunnable, ...t.reworkable, ...t.decomposable, ...t.repairable, ...t.relaunchOnMain])];
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
      const stalledRetryIds = [...new Set([...t.rerunnable, ...t.reworkable, ...t.decomposable, ...t.repairable, ...t.relaunchOnMain])];
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

  // AUT-NO-PROGRESS-RETRY-LOOP — 같은 후보가 PR 없이 두 라운드 연속 실패하면 세 번째 Pod 를 띄우지 않는다
  //   (부검 run-1166bcd1 · run-1bde4815 · run-427bd632 · run-46a02f42). 직전 라운드가 noPrTaskIds 를 안 쟀으면 서지 않는다.
  //   호출자가 stallRounds 를 기본보다 늘렸으면(제자리 인내를 늘림) 서지 않는다 — 0.2.24 컷 회귀(orchestrate-cli.test 라운드 상한 둘).
  //   NO-PR-STREAK-FEATURE-KEY — 짝은 taskId 가 아니라 «같은 조각»(noPrFeatureKeys)으로 맞춘다: rework 가 라운드마다 taskId 를
  //   새로 만들어 taskId 짝은 운영에서 한 번도 안 섰다(run-27b03878). 키를 안 잰 옛 원장·feature 없는 결과는 taskId 로(fail-open).
  const previousNoPr = history.at(-1)?.noPrTaskIds;
  const previousNoPrKeys = history.at(-1)?.noPrFeatureKeys;
  if (previousNoPr !== undefined && retryIds.length > 0 && stallRounds <= DEFAULT_STALL_ROUNDS) {
    const failedNoPr = (taskId: string) => activeResults.find((result) => result.taskId === taskId && failedWithoutPr(result));
    const keyOf = (taskId: string): string => noPrStreakKey(activeResults.find((result) => result.taskId === taskId)?.feature);
    const pairedBy = (taskId: string): 'feature-key' | 'task-id' =>
      previousNoPrKeys !== undefined && keyOf(taskId) !== '' ? 'feature-key' : 'task-id';
    const sameAsPrevious = (taskId: string): boolean => pairedBy(taskId) === 'feature-key'
      ? previousNoPrKeys!.includes(keyOf(taskId))
      : previousNoPr.includes(taskId);
    const streak = retryIds.every((taskId) => sameAsPrevious(taskId) && failedNoPr(taskId) !== undefined);
    if (streak && !madeProgress(history.at(-1), thisRound)) {
      const errors = retryIds.flatMap((taskId) => {
        const message = failedNoPr(taskId)?.error?.message;
        return message ? [message.slice(0, 200)] : [];
      });
      try { debug.log('self-dev.supervisor', 'no-pr-streak-stop', {
        taskIds: retryIds, featureKeys: retryIds.map(keyOf), pairedBy: [...new Set(retryIds.map(pairedBy))], round, errors,
      }); } catch { /* fail-open */ }
      return {
        ...base,
        action: 'stop',
        stopReason: 'no-progress',
        why: ['PR 없이 2라운드 연속 실패 — 같은 골 재시도 대신 골·불변식 개정 또는 hold', ...errors].join(' · '),
      };
    }
  }

  const preceding = history.at(-1);
  const oscillating = activeResults.filter((result) => retryIds.includes(result.taskId) && result.rework
    && (result.rework.trend === 'oscillating'
      || !!result.rework.signature && preceding?.signatures?.[result.taskId] === result.rework.signature));
  if (oscillating.length > 0) {
    // Repaired = same taskId, explicit lineage (`oscillationRepairOf`), or a feature that IS an authored repair goal
    // text (orchestrate runs it as the piece's feature) — never a mere shared original feature.
    const isRepaired = (result: SupervisorJobResult): boolean => history.some((entry) =>
      (entry.oscillationRepairTaskIds ?? []).some((id, index) => id === result.taskId || id === result.oscillationRepairOf
        || (entry.oscillationRepairFeatures?.[index] !== undefined && entry.oscillationRepairFeatures[index] === result.feature
          && Object.values(entry.oscillationRepairGoals ?? {}).includes(result.feature))));
    // Per task: a task that already got its one oscillation repair is held for a human; a fresh one may get it.
    // REVIEW-MUSTFIX-CLASSIFY — 슈퍼바이저는 추이 대신 회차 분류를 먼저 본다(대표 10-12 «노하우가 아니라 로직으로» · 임의 임계 없음).
    //   ① new-defect — 그대로 수렴(진동 수리 유지).
    //   ② post-land-evidence — 증거는 착지 뒤에만 난다 ⇒ 같은 런 재수리 0, «그림자 착지 → 관측 → live» 쪼개기 결정.
    //   ③ recurring — 수리 뒤 같은 지적 ⇒ 교차 리뷰 제안을 결정에 싣고, 그 줄은 범위 축에서 (나) split 으로 같은 런 수리에서 뺀다.
    //   unmeasured — 분류 불가 ⇒ 지금 동작 그대로. 분류는 조각마다 — 한 조각의 분류가 다른 조각의 수리를 끊지 않는다.
    const taskClasses = new Map(oscillating.map((result) => [result.taskId, classifyTaskMustFix(result, preceding)]));
    // 범위 축 — must-fix 한 줄마다 (가)/(나)/(다). 모든 줄이 (나) 면 조각을 보류하고, 일부면 (나) 를 뺀 줄로만 수리한다.
    const taskScopes = new Map(oscillating.map((result) => [result.taskId,
      judgeTaskMustFixScope(result, preceding, taskClasses.get(result.taskId)!)]));
    const allSplit = (taskId: string): boolean => {
      const judged = taskScopes.get(taskId) ?? [];
      return judged.length > 0 && judged.every((j) => j.scope === 'split');
    };
    // 보류는 줄 단위 범위로만 가른다 — ② 줄은 범위 축에서 늘 split 이므로 ② 회차(모든 줄이 착지 뒤 증거)는 allSplit 와 같고,
    // 한 줄이라도 (가)/(다) 가 남으면 그 줄은 수리 골로 간다(조각 통째 보류 금지).
    const isClassHeld = (taskId: string): boolean => MUST_FIX_HELD.has('split') && allSplit(taskId);
    const fresh = oscillating.filter((result) => !isRepaired(result) && !isClassHeld(result.taskId));
    const classes = [...taskClasses.values()];
    // Decision-level class: ② (the only acting class) first, then observed ③, else ①.
    const mustFixClass = classes.find((c) => c.class === 'post-land-evidence') ?? classes.find((c) => c.class === 'recurring')
      ?? classes.find((c) => c.class === 'new-defect');
    // Held = already repaired once, classified ②, or every must-fix item is (나) split — none rides this round's rerun.
    const classHeld = [...new Set(oscillating.filter((result) => !isRepaired(result)
      && isClassHeld(result.taskId)).map((result) => result.taskId))];
    const held = [...new Set([...oscillating.filter(isRepaired).map((result) => result.taskId), ...classHeld])];
    const repairedHeld = held.filter((id) => !classHeld.includes(id));
    // Every task's measured class survives in the decision — a mixed round keeps ② split and the observed ③ cross-review suggestion both.
    const mustFixByTask: Record<string, MustFixRoundClassification> = Object.fromEntries(
      [...taskClasses].filter(([, c]) => c.class !== 'unmeasured'));
    const heldReasons = [...new Set([
      // 사유는 실제로 분류·범위로 보류된 조각에서만 — 수리되거나 이미 수리해 보류된 조각의 ② 사유는 싣지 않는다.
      ...classHeld.map((id) => taskClasses.get(id)!).filter((c) => MUST_FIX_HELD.has(c.class)).map((c) => c.reason),
      ...(classHeld.some((id) => !MUST_FIX_HELD.has(taskClasses.get(id)!.class))
        ? ['must-fix 가 전부 (나) 범위 밖 — 같은 런 재수리 0, 중간 착지 ⊕ 연결 골'] : []),
    ])];
    const heldReasonSuffix = heldReasons.length ? ` · ${heldReasons.join(' · ')}` : '';
    // (나) split 줄은 같은 런 수리 골에서 뺀다 — 수리는 (가)·(다) 줄로만.
    const repairMustFix = (result: SupervisorJobResult): string[] => {
      const splitTexts = new Set((taskScopes.get(result.taskId) ?? []).filter((j) => j.scope === 'split').map((j) => j.text));
      return (result.reviewMustFix ?? []).filter((text) => !splitTexts.has(text));
    };
    const repairGoals: Record<string, string> = Object.fromEntries(fresh.flatMap((result) => {
      const mustFix = repairMustFix(result);
      const goal = result.prNumber && mustFix.length
        ? authorRepairGoal({ pr: result.prNumber, category: 'review-oscillation', originalRequest: result.feature,
          mustFix }) : null;
      return goal ? [[result.taskId, goal]] : [];
    }));
    const mustFixScope = mustFixScopeDecision(oscillating, taskClasses, taskScopes);
    // A caller that declares it cannot run the authored goal (false), or one that can but has no goal for every fresh
    // oscillating task, would turn add-repair-task into a same-strategy relaunch — stop for a human instead.
    // Undefined is the pure decision (caller unknown): it names the first repair as the goal contract asks.
    const cannotRepair = fresh.length > 0 && (input.repairGoalExecution === false
      || (input.repairGoalExecution === true && fresh.some((result) => !repairGoals[result.taskId])));
    const action = fresh.length === 0 || cannotRepair ? 'stop' : 'add-repair-task';
    const taskIds = action === 'stop'
      ? [...new Set(oscillating.map((result) => result.taskId))]
      : [...new Set(fresh.map((result) => result.taskId))];
    const signatureOf = (results: readonly SupervisorJobResult[]): string => results.map((result) => result.rework!.signature).join(' · ') || '(서명 없음)';
    const signature = oscillating.filter((result) => taskIds.includes(result.taskId)).map((result) => result.rework!.signature).join(' · ');
    const withoutHeld = (ids: readonly string[]): string[] => ids.filter((id) => !held.includes(id));
    try { debug.log('self-dev.supervisor', 'oscillation-seen', { taskIds, signature, trend: reviewMustFixTrend, action, ...(held.length ? { held } : {}) }); } catch { /* fail-open */ }
    if (action === 'add-repair-task') noteMainSyncRelaunch();
    return {
      ...base,
      ...(action === 'add-repair-task' && held.length > 0 ? {
        rerunnable: withoutHeld(base.rerunnable), reworkable: withoutHeld(base.reworkable),
        decomposable: withoutHeld(base.decomposable), repairable: withoutHeld(base.repairable),
        needsHuman: [...new Set([...base.needsHuman, ...held])],
      } : {}),
      action,
      ...(action === 'stop' ? { stopReason: 'review-oscillating' as const } : {}),
      ...(mustFixClass ? { mustFix: mustFixClass } : {}),
      ...(Object.keys(mustFixByTask).length ? { mustFixByTask } : {}),
      ...(mustFixScope ? { mustFixScope } : {}),
      oscillation: { taskIds, helper: 'review-oscillation', signature, ...(Object.keys(repairGoals).length ? { repairGoals } : {}),
        ...(action === 'add-repair-task' && held.length ? { heldTaskIds: held } : {}) },
      pendingDecision: 'attempt-care-escalation',
      why: fresh.length === 0
        ? `리뷰 진동 반복 — ${signatureOf(oscillating)} · 사람 결정 필요(같은 전략 재발사 금지)${heldReasonSuffix}`
        : cannotRepair
          ? `리뷰 진동 — ${signatureOf(oscillating)} · ${input.repairGoalExecution === false ? '이 감독 경로가 수리 골 실행을 선언하지 않았다(미선언 또는 불가)' : '수리 원문/PR 관측 불가'} · 사람 결정 필요(같은 전략 재발사 금지)${heldReasonSuffix}`
          : `리뷰 진동 — ${signatureOf(fresh)} · review-oscillation 수리 조각을 한 번 붙인다${input.repairGoalExecution === true ? '' : '(실행 배선 미선언 — 결정 칸만)'}${repairedHeld.length ? ` · 이미 수리한 조각 ${repairedHeld.join(', ')} 은 사람 결정 대기` : ''}${classHeld.length ? ` · 분류로 보류한 조각 ${classHeld.join(', ')}` : ''}${heldReasonSuffix}`,
    };
  }

  noteMainSyncRelaunch();

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
    why: `다시 건다 — 그대로 재실행 ${t.rerunnable.length} · 재작업 ${t.reworkable.length} · 분해 ${t.decomposable.length} · 수리 ${t.repairable.length}${t.relaunchOnMain.length > 0 ? ` · main 위 재발사 ${t.relaunchOnMain.length}` : ''} · 라운드 ${round + 1}/${maxRounds}`,
  };
}

export function appendRound(
  history: readonly SupervisorRound[],
  results: readonly SupervisorJobResult[],
  reviewMustFixTrend?: SupervisorDecision['reviewMustFixTrend'],
  decision?: SupervisorDecision,
): SupervisorRound[] {
  const t = triageRun(results.filter((result) => result.salvage !== 'launched'), undefined, false, undefined, mainSyncRelaunchSpent(history));
  const baseCompleted = countBaseCompleted(results);
  const base = roundBase(results);
  // REVIEW-MUSTFIX-CLASSIFY — 회차 원장에 관측을 실어 다음 회차 짝으로 쓴다(관측 없는 옛 원장은 그대로).
  const mustFix = mustFixFromResults(results.filter((result) => result.salvage !== 'launched'));
  const noPrResults = results.filter(failedWithoutPr);
  const noPrTaskIds = noPrResults.map((result) => result.taskId);
  const noPrFeatureKeys = noPrResults.map((result) => noPrStreakKey(result.feature));
  // PATTERN-MINE LOST-TIME — 이 회차의 배달 안 된 실행 시간을 원장에 은행한다(실패·재실행 모두).
  //   진동 보류(held) 조각은 다음 회차로 «같은 실행»으로 살아 남으므로 여기서는 안 세고,
  //   떠나는 회차나 종단에서 한 번만 센다. durationMs 를 안 잰 결과는 지어내지 않는다(모르는 시간은 0 이 아니다).
  const heldTaskIds = new Set(decision?.oscillation?.heldTaskIds ?? []);
  const lostTimeMsByTask: Record<string, number> = {};
  const unknownTimeTaskIds = new Set<string>();
  for (const result of results) {
    if (heldTaskIds.has(result.taskId) || hasDelivered(result)) continue;
    if (result.durationMs === undefined) { unknownTimeTaskIds.add(result.taskId); continue; }
    lostTimeMsByTask[result.taskId] = (lostTimeMsByTask[result.taskId] ?? 0) + result.durationMs;
  }
  return [...history, {
    round: history.length,
    landed: countLanded(results),
    ...(baseCompleted > 0 || base !== undefined ? { baseCompleted, ...(base === undefined ? {} : { base }) } : {}),
    actionable: countActionable(t),
    ...(reviewMustFixTrend === undefined ? {} : { reviewMustFixTrend }),
    ...((mustFix.items ?? []).length > 0 ? { mustFix } : {}),
    ...(Object.keys(lostTimeMsByTask).length > 0 ? { lostTimeMsByTask } : {}),
    ...(unknownTimeTaskIds.size > 0 ? { unknownTimeTaskIds: [...unknownTimeTaskIds] } : {}),
    ...(results.some((result) => result.rework?.signature)
      ? { signatures: Object.fromEntries(results.filter((result) => result.rework?.signature).map((result) => [result.taskId, result.rework!.signature])) } : {}),
    ...(decision && decision.action !== 'stop' && decision.relaunchOnMain.length > 0 ? {
      mainSyncRelaunchTaskIds: decision.relaunchOnMain,
      mainSyncRelaunchFeatures: decision.relaunchOnMain.flatMap((id) => [
        results.find((result) => result.taskId === id)?.feature,
        decision.relaunchGoals?.[id],
      ].filter((feature): feature is string => feature !== undefined)),
    } : {}),
    ...(decision?.action === 'add-repair-task' && decision.oscillation ? (() => {
      // Each repaired task is recorded under its original goal feature and, when a rerun runs the authored goal as
      // the piece's new feature (orchestrate), under that repair text too — so the repair's own oscillation stops.
      const pairs = decision.oscillation.taskIds.flatMap((id) => {
        const feature = results.find((result) => result.taskId === id)?.feature ?? '';
        const repairGoal = decision.oscillation!.repairGoals?.[id];
        return repairGoal === undefined ? [[id, feature]] : [[id, feature], [id, repairGoal]];
      });
      return { oscillationRepairTaskIds: pairs.map(([id]) => id!), oscillationRepairFeatures: pairs.map(([, feature]) => feature!),
        ...(decision.oscillation.repairGoals ? { oscillationRepairGoals: decision.oscillation.repairGoals } : {}) };
    })() : {}),
    ...(noPrTaskIds.length > 0 ? { noPrTaskIds, noPrFeatureKeys } : {}),
  }];
}

/** PATTERN-MINE — 생애 기록부 한 줄. `struggled`·`watch` 원문과 그 생애가 잃은 시간. */
export interface PatternMineLifeRecord {
  readonly lifeId: string;
  readonly struggled?: string;
  readonly watch?: string;
  readonly lostTimeMs?: number;
}

/** PATTERN-MINE — decideNextRun 종단 서명(멈춤 어휘 · 진동 서명 · 실패 분류 · must-fix). */
export interface PatternMineTerminalSignature {
  readonly lifeId?: string;
  readonly stopReason?: string;
  readonly oscillationSignature?: string;
  readonly classificationKind?: string;
  readonly mustFix?: string;
}

export interface MinedFailurePattern {
  readonly pattern: string;
  readonly frequency: number;
  readonly lifeCount: number;
  /** Known only when every life bound to this pattern carried a time; null preserves unknown — never a default 0. */
  readonly lostTimeMs: number | null;
}

export interface PatternMineAggregate {
  readonly patterns: readonly MinedFailurePattern[];
  readonly lifeCount: number;
  /** Known only when every life carried a time; null preserves unknown — a missing input time is never summed as 0. */
  readonly lostTimeMs: number | null;
}

function patternMineLifePart(life: PatternMineLifeRecord): string {
  return [life.struggled, life.watch].filter((part): part is string => !!part && part.length > 0).join(' · ');
}

function patternMineSignaturePart(signature: PatternMineTerminalSignature | undefined): string {
  if (!signature) return '';
  return [signature.stopReason, signature.oscillationSignature, signature.classificationKind, signature.mustFix]
    .filter((part): part is string => !!part && part.length > 0).join(' · ');
}

/** Bind struggled/watch with a terminal signature. Empty both sides is not a pattern. */
export function bindPatternMineKey(life: PatternMineLifeRecord, signature?: PatternMineTerminalSignature): string {
  const lifePart = patternMineLifePart(life);
  const signaturePart = patternMineSignaturePart(signature);
  if (!lifePart && !signaturePart) return '';
  return signaturePart ? `${lifePart || '(기록 없음)'} ⊕ ${signaturePart}` : lifePart;
}

/**
 * PATTERN-MINE — 순수 집계. 생애 기록부 struggled·watch 를 종단 서명과 묶어
 * 패턴 빈도·생애 수·잃은 시간을 낸다. 입력이 비면 전부 0 이고 지어내지 않는다.
 * 잃은 시간을 모르는 생애가 하나라도 섞이면 그 합은 unknown(null)을 보존한다 — 0 으로 확정하지 않는다.
 */
export function mineFailurePatterns(input: {
  readonly lives: readonly PatternMineLifeRecord[];
  readonly signatures?: readonly PatternMineTerminalSignature[];
}): PatternMineAggregate {
  const lives = input.lives;
  const signatures = input.signatures ?? [];
  const runLevel = signatures.find((signature) => !signature.lifeId);
  const byLife = new Map(signatures.flatMap((signature) => signature.lifeId ? [[signature.lifeId, signature] as const] : []));
  const groups = new Map<string, { lives: Set<string>; frequency: number; lostTimeMs: number | undefined }>();

  const add = (pattern: string, lifeId: string | undefined, lostTimeMs: number | undefined): void => {
    if (!pattern) return;
    const group = groups.get(pattern) ?? { lives: new Set<string>(), frequency: 0, lostTimeMs: 0 };
    group.frequency += 1;
    if (lifeId) group.lives.add(lifeId);
    // UNKNOWN 보존 — 모르는 시간(전달 안 됨)은 0 이 아니라 unknown 이고, 한 번 섞이면 그 합은 끝까지 unknown 이다.
    if (lostTimeMs === undefined) group.lostTimeMs = undefined;
    else if (group.lostTimeMs !== undefined) group.lostTimeMs += lostTimeMs;
    groups.set(pattern, group);
  };

  for (const life of lives) {
    add(bindPatternMineKey(life, (life.lifeId ? byLife.get(life.lifeId) : undefined) ?? runLevel), life.lifeId, life.lostTimeMs);
  }
  for (const signature of signatures) {
    if (signature.lifeId ? lives.some((life) => life.lifeId === signature.lifeId) : lives.length > 0) continue;
    add(bindPatternMineKey({ lifeId: signature.lifeId ?? '' }, signature), signature.lifeId, undefined);
  }

  const lifeIds = new Set(lives.map((life) => life.lifeId));
  for (const signature of signatures) if (signature.lifeId) lifeIds.add(signature.lifeId);
  const signatureWithoutLife = signatures.some((signature) => signature.lifeId && !lives.some((life) => life.lifeId === signature.lifeId));
  const patternWithoutLife = groups.size > 0 && lives.length === 0;

  return {
    patterns: [...groups].map(([pattern, group]) => ({
      pattern, frequency: group.frequency, lifeCount: group.lives.size, lostTimeMs: group.lostTimeMs ?? null,
    })).sort((a, b) => b.frequency - a.frequency || a.pattern.localeCompare(b.pattern)),
    lifeCount: lifeIds.size,
    lostTimeMs: !signatureWithoutLife && !patternWithoutLife && lives.every((life) => life.lostTimeMs !== undefined)
      ? lives.reduce((sum, life) => sum + (life.lostTimeMs ?? 0), 0)
      : null,
  };
}

interface PatternMineLifeAccumulator {
  struggled: string[];
  watch: string[];
  lostTimeMs: number;
  /** True once any duration-carrying fact touched this life — a delivered result counts as known 0. */
  timeKnown: boolean;
  /** True when a contributing execution's duration was not measured — unknown wins over any known sum. */
  timeUnknown: boolean;
}

function patternMineRow(byLife: Map<string, PatternMineLifeAccumulator>, lifeId: string): PatternMineLifeAccumulator {
  const row = byLife.get(lifeId) ?? { struggled: [], watch: [], lostTimeMs: 0, timeKnown: false, timeUnknown: false };
  if (!byLife.has(lifeId)) byLife.set(lifeId, row);
  return row;
}

/** appendRound 회차 원장 ⊕ 이번 결과에서 struggled·watch 생애 기록부를 읽는다. */
export function patternMineLivesFromRounds(
  rounds: readonly SupervisorRound[],
  results: readonly SupervisorJobResult[],
): PatternMineLifeRecord[] {
  const byLife = new Map<string, PatternMineLifeAccumulator>();

  for (const result of results) {
    const row = patternMineRow(byLife, result.taskId);
    if (result.rework?.trend === 'oscillating' && result.rework.signature) {
      row.struggled.push(`리뷰 진동 ${result.rework.signature}`);
    }
    for (const text of result.reviewMustFix ?? []) {
      row.struggled.push(text);
      row.watch.push(text);
    }
    // PATTERN-MINE LOST-TIME — 종단 세대의 실행 시간. 배달된 결과는 잃은 시간이 0(known)이고,
    //   durationMs 를 안 실은 실패는 unknown 을 보존한다(0 이 아니다).
    if (hasDelivered(result)) row.timeKnown = true;
    else if (result.durationMs === undefined) row.timeUnknown = true;
    else {
      row.lostTimeMs += result.durationMs;
      row.timeKnown = true;
    }
  }

  for (const round of rounds) {
    for (const taskId of round.unknownTimeTaskIds ?? []) patternMineRow(byLife, taskId).timeUnknown = true;
    for (const [taskId, signature] of Object.entries(round.signatures ?? {})) {
      patternMineRow(byLife, taskId).struggled.push(`서명 ${signature}`);
    }
    for (const item of round.mustFix?.items ?? []) {
      const row = patternMineRow(byLife, item.taskId ?? `round-${round.round}`);
      row.struggled.push(item.text);
      if (item.evidence) row.watch.push(item.evidence);
    }
    for (const taskId of round.noPrTaskIds ?? []) patternMineRow(byLife, taskId).struggled.push('PR 없이 실패');
    // PATTERN-MINE LOST-TIME — 앞선 회차가 원장에 은행한 실패·재실행 시간을 생애에 합산한다.
    for (const [taskId, lostTimeMs] of Object.entries(round.lostTimeMsByTask ?? {})) {
      const row = patternMineRow(byLife, taskId);
      row.lostTimeMs += lostTimeMs;
      row.timeKnown = true;
    }
  }

  return [...byLife].map(([lifeId, row]) => ({
    lifeId,
    ...(row.struggled.length ? { struggled: [...new Set(row.struggled)].join(' · ') } : {}),
    ...(row.watch.length ? { watch: [...new Set(row.watch)].join(' · ') } : {}),
    // 아는 입력에 대해서만 시간을 낸다 — unknown 이 섞였거나 아는 것이 없으면 칸 자체를 안 만든다(0 이 아니다).
    ...(row.timeUnknown || !row.timeKnown ? {} : { lostTimeMs: row.lostTimeMs }),
  }));
}

/** decideNextRun 종단 결정에서 서명(실패 분류 · must-fix · 멈춤 어휘 · 진동 서명)을 읽는다. */
export function patternMineSignaturesFromDecision(decision: SupervisorDecision): PatternMineTerminalSignature[] {
  const shared = {
    ...(decision.stopReason ? { stopReason: decision.stopReason } : {}),
    ...(decision.oscillation?.signature ? { oscillationSignature: decision.oscillation.signature } : {}),
  };
  const perTask = decision.classifications.map((classification) => {
    const mustFix = decision.mustFixByTask?.[classification.taskId]?.class ?? decision.mustFix?.class;
    return {
      lifeId: classification.taskId,
      ...shared,
      classificationKind: classification.kind,
      ...(mustFix ? { mustFix } : {}),
    };
  });
  if (perTask.length > 0) return perTask;
  return shared.stopReason || shared.oscillationSignature ? [{ ...shared }] : [];
}

export interface SuperviseRunOptions {
  initial: readonly SupervisorJobResult[];
  rerun: (previous: readonly SupervisorJobResult[], invocation: { relaunch: true; repairGoals?: Record<string, string> }) => Promise<readonly SupervisorJobResult[]>;
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
  /** True only when rerun consumes `invocation.repairGoals`; omitted or false → a review oscillation stops for a human. */
  repairGoalExecution?: boolean;
  /**
   * TASK-AGENT-SHADOW — 멈춤이 확정되면 판단부를 그림자로 부른다(기본 `recordTaskAgentShadowMove`).
   * `false` 면 끈다. 던져도 런의 결말은 바뀌지 않는다(fail-soft).
   */
  taskAgentShadow?: ((input: TaskAgentShadowInput) => unknown) | false;
  /** TA-LAND-AFTER-REVIEW — false disables the hook; function replaces only the final rejudge for isolated tests. */
  taskAgentRejudge?: ((cardId: string, statePath: string) => Promise<unknown>) | false;
  /** Test-only external I/O for the real completion rejudge. The decision and shadow gate remain production code. */
  taskAgentRejudgeExternal?: Parameters<typeof import('../task-agent/rejudge-on-head.js').rejudgeAsyncResultCard>[2];
  /** Isolated state ledger for the terminal rejudge test; production uses the active instance. */
  taskAgentStatePath?: string;
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

/** The supervisor's terminal hook, limited to a uniquely run-bound TA land card. */
export async function rejudgeTerminalTaskCard(runId: string | null, deps: {
  statePath?: string;
  env?: NodeJS.ProcessEnv;
  rejudgeCard?: (cardId: string, statePath: string) => Promise<unknown>;
  external?: Parameters<typeof import('../task-agent/rejudge-on-head.js').rejudgeAsyncResultCard>[2];
} = {}): Promise<void> {
  const statePath = deps.statePath ?? taskAgentStatePath();
  const card = runCardFor(runId, { statePath, ...(deps.env ? { env: deps.env } : {}) });
  if (!card || card.status !== 'launched' || card.taLand !== true || cardPrNumber(card) === undefined) return;
  const { rejudgeAsyncResultCard } = await import('../task-agent/rejudge-on-head.js');
  const result = await (deps.rejudgeCard ?? ((id, path) => rejudgeAsyncResultCard(id, path, deps.external)))(card.id, statePath);
  const { requireSuccessfulRejudge } = await import('../task-agent/rejudge-on-head.js');
  requireSuccessfulRejudge(result);
  try { debug.log('task-agent', 'terminal-rejudge', { runId, card: card.id }); } catch { /* fail-soft */ }
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
      // Undeclared = cannot run the repair goal: an add-repair-task would otherwise be a same-strategy relaunch.
      repairGoalExecution: opts.repairGoalExecution === true,
      ...(aggregateReviewTrend(results) ? { reviewMustFixTrend: aggregateReviewTrend(results) } : {}),
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
      // PATTERN-MINE — 종단에서만 채굴한다. 판정·원장 형식은 그대로이고 관측만 남긴다.
      const patternMine = mineFailurePatterns({
        lives: patternMineLivesFromRounds(history, results),
        signatures: patternMineSignaturesFromDecision(decision),
      });
      try {
        opts.observe?.('pattern-mine', {
          runId,
          stopReason: decision.stopReason ?? null,
          lifeCount: patternMine.lifeCount,
          lostTimeMs: patternMine.lostTimeMs,
          frequency: patternMine.patterns.reduce((sum, mined) => sum + mined.frequency, 0),
          patterns: patternMine.patterns,
        });
      } catch { /* fail-open */ }
      try { debug.log('self-dev.supervisor', 'pattern-mine', { runId, lifeCount: patternMine.lifeCount, lostTimeMs: patternMine.lostTimeMs, frequency: patternMine.patterns.reduce((sum, mined) => sum + mined.frequency, 0), patterns: patternMine.patterns }); } catch { /* fail-open */ }
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
        if (opts.taskAgentRejudge !== false) {
          const rejudgeOptions = { ...(opts.taskAgentStatePath ? { statePath: opts.taskAgentStatePath } : {}), ...(opts.taskAgentRejudge ? { rejudgeCard: opts.taskAgentRejudge } : {}), ...(opts.taskAgentRejudgeExternal ? { external: opts.taskAgentRejudgeExternal } : {}) };
          try { await rejudgeTerminalTaskCard(runId, rejudgeOptions); }
          catch (error) {
            try { await rejudgeTerminalTaskCard(runId, rejudgeOptions); }
            catch (retryError) {
              try { debug.log('task-agent', 'terminal-rejudge-failed', { runId, stopReason: decision.stopReason, error: String(retryError), firstError: String(error), attempts: 2 }); } catch { /* fail-open */ }
            }
          }
        }
      }
      return results;
    }

    history = appendRound(history, results, decision.reviewMustFixTrend, decision);
    // Tasks that already had their one oscillation repair are held for a human — they are not handed to the rerun,
    // but their results stay in the round so the human hand-off (and the final review-oscillating stop) keeps them.
    const held = decision.oscillation?.heldTaskIds ?? [];
    const heldResults = results.filter((result) => held.includes(result.taskId));
    const repairGoals = { ...decision.relaunchGoals, ...decision.oscillation?.repairGoals };
    const rerunResults = await opts.rerun(held.length ? results.filter((result) => !held.includes(result.taskId)) : results,
      { relaunch: true, ...(Object.keys(repairGoals).length > 0 ? { repairGoals } : {}) });
    results = [...rerunResults, ...heldResults.filter((heldResult) => !rerunResults.some((result) => result.taskId === heldResult.taskId))];

    try {
      opts.onRound?.(results);
    } catch { /* fail-open */ }
  }
}
