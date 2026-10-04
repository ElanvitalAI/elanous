// self-implement 오케스트레이터 (2026-07-19) — 세션 포크 → worktree → 구현 → gate → PR.
//
// 대표 지시: 외부 drive-tui 로 elanous 를 구동하는 능력의 **내부판**. elanous 가 TUI 대화의
// 자연어("이 기능 구현하고 PR 올려줘")를 인식해 SelfImplement 툴을 자율 호출 → 이 시퀀서가
// 6단계를 관통한다. 미션 plan/build 코드 무접촉 — 전 단계가 미션-무결합 재사용 seam(조사 실측).
//
// 설계 = runGoalLoop 과 동형의 headless 순수 시퀀서: 모든 외부 작용(fork/worktree/구현/gate/PR)을
// seam 으로 주입해 유닛 테스트 가능. 실 seam 어댑터(createWorktree·runIntegrityGate·
// dispatchOpenPullRequest 등) 는 P1 에서 배선. P0 = 순수 시퀀싱 로직 + seam-주입 테스트.
//
// HITL(제1원칙): 코딩은 자율, PR open 은 approvePr 게이트(대표 승인·draft 기본). 실패 시 worktree 는
// 보존(검사용). 관측 = self-implement.* 카테고리.

import {
  PR_EVIDENCE_AXES,
  decidePrEvidenceGate,
  extractGoalDocumentEvidence,
  parseGateLogTestRuns,
  type PrEvidenceInput,
} from './pr-evidence-artifact.js';
import { assessImplementationArtifactCompleteness } from './implementation-artifact-completeness.js';
import { runContractAtNode, type RunContract } from './graph-run-contract.js';
export {
  PR_EVIDENCE_AXES,
  composePrEvidenceArtifact,
  decidePrEvidenceGate,
  extractGoalDocumentEvidence,
  missingPrEvidenceAxes,
  parseGateLogTestRuns,
  type PrEvidenceAxis,
  type PrEvidenceInput,
} from './pr-evidence-artifact.js';
import { judgePredictionAccuracy } from './judge-prediction-accuracy.js';
import { measureReviewFindingRecurrence, type ReviewFindingRecurrence } from './review-finding-recurrence.js';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { hostname, loadavg } from 'node:os';
import { resolveHostId } from '../platform/host-id.js';
import { resolveInstanceName } from '../instance-identity.js';
import { citedReviewSymbols, MAX_CITED_REVIEW_SYMBOL_CHARS, measureReviewFindingKeyOverlap, normalizeReviewFindingKey, REVIEW_FINDING_KEY_VERSION, reviewFindingKey, shortNormalizedReviewFindingHash, type CitedReviewSymbol } from '../agent-substrate/review-finding-key.js';
export { citedReviewSymbols, MAX_CITED_REVIEW_SYMBOL_CHARS, normalizeReviewFindingKey, REVIEW_FINDING_KEY_VERSION, reviewFindingKey, shortNormalizedReviewFindingHash, type CitedReviewSymbol } from '../agent-substrate/review-finding-key.js';

function displayBranchName(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

export function formatAutoMergeSuccessMessage(input: {
  prNumber: number;
  mergedBase?: string | undefined;
  defaultBranch?: string | undefined;
}): string {
  const destination = input.mergedBase?.trim();
  const destinationName = destination ? displayBranchName(destination) : undefined;
  const defaultBranch = input.defaultBranch?.trim();
  const defaultBranchName = defaultBranch ? displayBranchName(defaultBranch) : undefined;
  const suffix = destination ? ` → ${destination}` : '';
  const isDefaultDestination = !!destinationName && !!defaultBranchName && destinationName === defaultBranchName;
  if (!destination || !defaultBranchName || isDefaultDestination) return `✅ 자동 병합 완료 (#${input.prNumber})${suffix}`;
  return `✅ 자동 병합 완료 (#${input.prNumber}) → ${destination} (${defaultBranchName}에는 아직 안 감)`;
}

import { GoalRunStore, insertGoalRunRecord, type GoalPriorRuns } from './goal-run-store.js';
import { writeGoalRunRecordFragment } from './goal-execution-records.js';
import { getUserConfig } from '../user-config.js';
import { appendRunLedgerEntry, loadRunLedger, parseRunShardIdentity, queryRunChain, type RunChainShardSibling, type RunLedgerEntry, type RunLedgerWriter, type RunOriginData, type RunShardIdentity } from './run-ledger.js';
import { emitSessionEvent, type SessionEventInput } from '../context-bus/session-events.js';
import { decideLineageSupersede, lineageSupersedeCloseComment, type LineageSupersedeOpenDraft } from './lineage-supersede.js';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { enqueueControlMemo, readSoftStopRequestStatus, type SoftStopRequestRead } from '../harness/control-inbox.js';
import { debug } from '../debug/log.js';
import { recordFailureEvent } from './heal-intake.js';
import { releasePathHold, releasePathHoldComment, RELEASE_PATH_LABEL } from '../self-dev/release-path-guard.js';
import { emitDecision } from '../live/detail-switch.js';
import { reworkDecision } from './decision-events.js';
import type { LogSink } from '../mss/logging/sink.js';
import type { LogQuery, LogStoreRow } from '../mss/logging/log-store.js';
import { refreshCodexQuotaSignals } from '../budget/codex-quota-refresh.js';
import { inspectActiveProvider, type ActiveProviderInfo } from '../provider-summary.js';
import { recordHitlEvent } from '../self-dev/hitl-log.js';
import { parseAskProseTitle } from '../self-dev/launch-preflight.js';
import { classifyReviewProviderFailure } from '../self-dev/review-provider-fallback.js';
import { classifyError } from '../session-runtime/retry-policy.js';
import { decomposeSelfDevGoal, inferHotPaths, type SelfDevDecomposeOptions } from '../self-dev/decompose.js';
import { boundaryGlobs, boundaryViolations } from './goal-boundary.js';
import { askAtExecution, type ExecutionClarificationResult } from './execution-clarification.js';
import { targetScopedGoalText } from './goal-text-path-scope.js';
import { dropStaleReverts, type RevertGuardResult } from './revert-guard.js';
import type { SelfDevGoalType } from '../self-dev/orchestrate.js';
import { DEFAULT_BRANCH_WORKTREE_BASE, gateGitResidue, observeGitResidue } from '../git-fs/worktree.js';
import { runGitCommand } from '../git-fs/runner.js';
import { nestInfo } from '../agent/nest-depth.js';
import type { ChildLlmSelection } from '../agent/run-context.js';
import type { DocumentReferenceStatus } from './self-implement-runtime.js';
import { DEV_PIPELINE_SINK_SURFACE } from './self-cli-sink-surface.js';
import { registerLoopAgentSafe, type LoopAgentInput } from '../domains/loop-agent-registry.js';
import { originObservationFields } from '../agent/origin-observation.js';
import { getHarnessSpace, normalizeSpaceId, resolveRunIdentity } from '../harness/harness-space.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { addNextMdReleaseNote, harnessReleaseNote, parseReleaseNoteSection, releaseNotesDir, renderReleaseNoteSection, writeReleaseNote, type ReleaseNoteFragment, type ReleaseNoteSection } from '../release-loop/release-note.js';
import { landingFreezeMessage } from '../release-loop/landing-freeze.js';
import { admitLandingMerge, owningRepoRoot } from './frozen-merges.js';
import { plannedSelfImplBranch } from '../harness/worktree-branch-prefix.js';
export { slugifyFeature } from '../harness/worktree-branch-prefix.js';
import { AUTO_REVIEW_LABEL, resolveAutoReviewLabels } from './context-capsule.js';
import { GOAL_TYPES, extractVerbatimOriginalAsk, leadingGoalMetadata, parseAskFile, parseGoalType, type GoalType } from './goal-author.js';
import { resolveAdaptiveMaxReworkDecision, resolveEscalateTier, resolveEscalateTarget, buildReworkFeature, failIndicator, isRepeatedUnverifiedOnlyGateFailure, unverifiedRepeatKey, appendReworkHistory, truncateReworkHistoryByItem, applyReworkBudgetDecision, parseContractConflictRelaxation, parseReworkBudgetDecision, resolveReworkBudgetCarry, stripReworkBudgetHeaders, countConsecutiveMustFixIds, mergeReworkNotes, resolveReworkKind, type ReworkPlanRevision, type ReworkNotePart } from './rework-policy.js';
import type { SupervisionReworkSource } from './supervision-vocabulary.js';
import { classifyReworkBudgetShadow } from './classify-shadow.js';
import { createReworkBudgetJudgment, REWORK_BUDGET_JUDGMENT, reworkBudgetEvidenceForObservation, reworkBudgetWorkflow } from './rework-budget-judgment.js';
import { runWorkflowToCompletion } from '../workflow-runtime/executor.js';
import { mapReworkVerdict, supervisionObservationFields } from './supervision-vocabulary.js';
import { resolveRunOutcome } from './run-outcome.js';
import { authorLimitationCountFromGoal, harvestEvidenceLines, harvestedEvidenceObservation, MAX_HARVESTED_EVIDENCE_CHARS, parseOffDiffEvidence, requiredEvidenceFromGoal, runRequiredEvidenceChecks, coverRequiredEvidence, type OffDiffEvidenceParse } from './off-diff-evidence.js';
import { pressDecisionSignals, type DecisionSignalPressResult } from './decision-signal-press.js';
import { inspectDecisionObservations, inspectDecisionSignalKinds, inspectDecisionSignalObservations } from '../../scripts/ask-marker-check.js';

type DecisionSignalPressReason =
  | 'goal-file-not-provided'
  | 'goal-file-not-found'
  | 'goal-file-not-a-file'
  | 'goal-file-inspection-failed'
  | 'goal-file-read-failed'
  | 'decision-signal-press-failed'
  | 'no-declared-signals';

type DecisionSignalPressSources = {
  readonly stat: (path: string) => { isFile(): boolean };
  readonly read: (path: string, encoding: BufferEncoding) => string;
  readonly inspectKinds: (goal: string) => unknown;
  readonly inspectObservations: (goal: string) => unknown;
  readonly inspectSignals: (goal: string) => readonly { signal: string; command?: string; kind: 'unit-test' | 'real' | 'unresolved' }[];
  readonly press: (input: { kinds: unknown; observations: unknown; signals: readonly { signal: string; command?: string; kind: 'unit-test' | 'real' | 'unresolved' }[] }, cwd: string) => DecisionSignalPressResult;
};

const defaultDecisionSignalPressSources: DecisionSignalPressSources = {
  stat: statSync,
  read: readFileSync,
  inspectKinds: inspectDecisionSignalKinds,
  inspectObservations: inspectDecisionObservations,
  inspectSignals: inspectDecisionSignalObservations,
  press: pressDecisionSignals,
};

/** Classifies every unpressed merge-decision path without changing merge policy. */
export function resolveDecisionSignalPress(
  goalFile: string | undefined,
  cwd: string,
  sources: DecisionSignalPressSources = defaultDecisionSignalPressSources,
): { decisionSignalPress?: DecisionSignalPressResult; decisionSignalPressReason?: DecisionSignalPressReason } {
  if (!goalFile) return { decisionSignalPressReason: 'goal-file-not-provided' };

  try {
    if (!sources.stat(goalFile).isFile()) return { decisionSignalPressReason: 'goal-file-not-a-file' };
  } catch (error) {
    return {
      decisionSignalPressReason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'goal-file-not-found'
        : 'goal-file-inspection-failed',
    };
  }

  let goal: string;
  try {
    goal = sources.read(goalFile, 'utf8');
  } catch {
    return { decisionSignalPressReason: 'goal-file-read-failed' };
  }

  const kinds = sources.inspectKinds(goal);
  const observations = sources.inspectObservations(goal);
  const signals = sources.inspectSignals(goal);
  try {
    const decisionSignalPress = sources.press({ kinds, observations, signals }, cwd);
    return signals.length === 0
      ? { decisionSignalPress, decisionSignalPressReason: 'no-declared-signals' }
      : { decisionSignalPress };
  } catch {
    return { decisionSignalPressReason: 'decision-signal-press-failed' };
  }
}
import type { RunOutcome, ReworkBudgetVerdict } from './run-outcome.js';
import type { EscalateTier } from './rework-policy.js';
import type { ClassifyShadowCallLLM } from './classify-shadow.js';
import { hasModuleLoadFailure, type GateTestFailure } from './gate-baseline.js';
import { commitWorktree, defaultBranchRef } from './seams.js';
import { detectUncommittedWork } from './uncommitted-work.js';
import { spawnSync } from 'node:child_process';
import { blockedDraftDisposition } from './blocked-draft-policy.js';
import { formatLlmMergeOutcome } from '../autopilot/build/llm-conflict-merge.js';
import { FOUND_CITED_PATH_REFUTATION_QUOTE, MISSING_CITED_PATH_REFUTATION_QUOTE, MUST_FIX_REFUTATION_ACKNOWLEDGEMENT_WITH_REASON, REFUTATION_QUOTE_GRAMMAR, observeMustFixCitedPaths, parseMustFixRefutationAcknowledgement, parseMustFixRefutations, renderMustFixCitedPathFacts, snapshotMustFixFindings, stableMustFixId, type ReflectEvidenceFacts, type ReflectGateFacts, type MustFixCitedPathFact, type MustFixFinding, type MustFixRecurrenceHistory, type MustFixRefutation, type MustFixRefutationKind } from './reflect-mustfix.js';
import type { IngestionEntry } from '../agent-substrate/execution/ingestion-policy.js';
import { buildReviewIntent } from '../agent-substrate/review-intent.js';
import { collectPriorDraftFindings, goalTitleFromTargetGoalFile } from './prior-draft-findings.js';
import { resolveDesignCheck, type DesignCheckOutcome } from '../design/design-check.js';
import { runDesignGate, type DesignGateResult } from '../design/design-gate.js';
import type { ReviewerContextBudget } from '../agent-substrate/pr-reviewer.js';
import { persistReviewArtifact, type ReviewArtifactWriter } from '../agent-substrate/review-artifact.js';
import { createArtifactStore } from '../artifact/index.js';
import { mapStageToRunStatus, type SelfImplementStage } from './run-status-mapping.js';
import type { LifecycleScreenComparison } from './lifecycle-screen-scoreboard.js';
import { activeTemplate, decideTemplate, graphAuthorityFields, nodeNameForStage, overlayDecisionObservation, resolveGraphAuthorityForUserConfig, routeGate, visitBudgetOf } from './graph-authority.js';
import type { GraphTemplate } from './graph-templates.js';
import { defaultOverlaysDir, loadGraphOverlays, type GraphOverlaySpec } from './graph-overlay-yaml.js';
import { graphIdentityOf, pipelineNodeEntryPayload } from './graph-templates.js';
import { AMBIGUOUS_STAGES, checkPipelineTraversal, nodesForStage, pipelineGraphIdentity, type PipelineNodeId, type PipelineTraversalCheck } from './pipeline-shape.js';
import { appendGateWorktreeFreshnessEvidence, gateEvidenceNote } from '../harness/review-adapter.js';
import { diffHeaderPaths } from '../agent-substrate/self-review-cli.js';
import { format as formatPrComment, type PrCommentRole } from '../agent-substrate/pr-comment-meta.js';
import { changedFiles, commitTitles, type SelfImplementCompletionDisposition } from './seams.js';
import {
  classifyAbandonedRun,
  isAbandonedClassificationOutcome,
  readWorktreePorcelain,
  type AbandonedClassificationResult,
  type QuotaAccountAvailabilityEvidence,
} from './abandoned-classification.js';
export type { QuotaAccountAvailabilityEvidence };
import { decideReworkSalvage, type ReworkSalvageEvidence } from './rework-salvage.js';
import { type SupervisorGoalFillEvidence, fillUnverifiableGoalSlots, type SupervisorGoalFillResult } from './goal-supervisor-fill.js';
import { escalateGoalDocumentClarifications, recordSupervisorPlanRevision, type GoalClarificationEscalationResult, type SupervisorPlanRevisionRelaxation, type SupervisorPlanRevisionResult } from './goal-clarification-escalation.js';
import { parseGoalDocumentClarifications } from './goal-author-clarification.js';
import {
  createFileAskUserQuestionResolver,
  type AskUserQuestionDispatchContext,
  type AskUserQuestionDispatchResult,
} from '../ask-user-question/tool.js';
import { acquireClarificationResolverLease, decideClarificationResolverInstall } from './clarification-resolver-lease.js';
import { inspectCodexRotation } from '../oauth/codex-account-store.js';
import { resolveDefaultProvider } from '../llm.js';
import { createWidgetAskUserResolver } from '../expression/widget/adapters/ask-user-resolver.js';
import { createNodeReadlineHost } from '../expression/widget/readline-host.js';
import type { HitlDelivery } from '../hitl/types.js';

export const UNMEASURED_ATTEMPT_ORDINAL = 'unmeasured' as const;
export type AttemptOrdinal = number | typeof UNMEASURED_ATTEMPT_ORDINAL;
export const MAX_TRACKED_RUN_ATTEMPT_ORDINALS = 256;

const attemptOrdinalsByRunId = new Map<string, number>();
const terminalSequencesByRunId = new Map<string, number>();

function incrementTerminalSequence(runId: string): number {
  const next = (terminalSequencesByRunId.get(runId) ?? 0) + 1;
  terminalSequencesByRunId.set(runId, next);
  return next;
}

export function incrementRunAttemptOrdinal(runId: string): AttemptOrdinal {
  try {
    if (!runId.trim()) return UNMEASURED_ATTEMPT_ORDINAL;
    const next = (attemptOrdinalsByRunId.get(runId) ?? 0) + 1;
    attemptOrdinalsByRunId.set(runId, next);
    while (attemptOrdinalsByRunId.size > MAX_TRACKED_RUN_ATTEMPT_ORDINALS) {
      const oldestRunId = attemptOrdinalsByRunId.keys().next().value;
      if (oldestRunId === undefined) break;
      attemptOrdinalsByRunId.delete(oldestRunId);
    }
    return next;
  } catch {
    return UNMEASURED_ATTEMPT_ORDINAL;
  }
}

export function readRunAttemptOrdinal(runId: string): AttemptOrdinal {
  try {
    if (!runId.trim()) return UNMEASURED_ATTEMPT_ORDINAL;
    return attemptOrdinalsByRunId.get(runId) ?? UNMEASURED_ATTEMPT_ORDINAL;
  } catch {
    return UNMEASURED_ATTEMPT_ORDINAL;
  }
}

export function formatReworkProgressLine(
  round: number,
  effectiveMax: number,
  escalateTier: string,
  attemptOrdinal: AttemptOrdinal,
): string {
  const rework = `rework ${round}/${effectiveMax}${escalateTier !== 'none' ? `·${escalateTier}` : ''}`;
  const attempt = typeof attemptOrdinal === 'number' && attemptOrdinal >= 2
    ? ` · 재발사 ${attemptOrdinal}`
    : '';
  return `${rework}${attempt} — 수정 중…`;
}

type ClarificationResolverSkipReason = Extract<ReturnType<typeof decideClarificationResolverInstall>, { install: false }>['skipReason'];

export function clarificationResolverSkipHint(reason: ClarificationResolverSkipReason): string {
  switch (reason) {
    case 'disabled':
      return 'tools.selfImplement.clarificationEscalation.enabled 를 true로 설정해야 설치된다';
    case 'timeout-not-configured':
      return 'tools.selfImplement.clarificationEscalation.timeoutMs 에 1 이상 2147483647 이하의 정수를 넣어야 설치된다';
    case 'unattended-proceeds-unanswered':
      return '무인 발사(비-TTY)라 사람 대기를 설치하지 않는다 — LLM 릴레이가 못 답한 되묻기는 미답으로 진행한다 (대표 2026-09-14)';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export interface SelfImplementGateResult {
  passed: boolean;
  log?: string;
  /** verify-by-breaking의 문자열 노트와 독립된 구조화 판정. `ran:false`는 실행된 0건과 다르다. */
  verifyByBreaking?: {
    ran: boolean;
    distinguishes: number;
    'does-not-distinguish': number;
    unknown: number;
    /** 이전 산출물과의 호환성을 위해 선택적으로 보존한 base에 없던 테스트 파일 수. */
    missingAtBase?: number;
    /** 게이트가 이미 분류한 파일별 판정. ran:false(미실행)와 빈 목록(실행했으나 해당 없음)을 구별한다. */
    files?: readonly { file: string; classification: 'distinguishes' | 'does-not-distinguish' | 'unknown' | 'missing-at-base' }[];
    skippedReason?: string;
  };
  /** gate test 스텝이 실제로 실행됐는지. scope로 제외되면 false다. */
  testStepExecuted?: boolean;
  /** gate가 이미 산정한 테스트 범위와 미검증 변경 사실. */
  scopeReason?: string;
  /** 재게이트가 실제로 잰 실행 범위 파일 수. 빈 집합과 측정 후 깨끗함을 가른다. */
  measuredFileCount?: number;
  /** 재게이트 실행 범위의 comparison base(merge-base SHA). */
  comparisonBase?: string | null;
  unverified?: readonly string[];
  missingTestFiles?: number;
  /** 변경된 테스트 파일에서 정적으로 센 선언 삭제 수. base를 읽지 못하면 null이며, 관측 전용이다. */
  testDeclarationDecline?: number | null;
  /** baseline 귀속 결과. preexisting/unknown은 통과해도 리뷰까지 보존한다. */
  baselineFailures?: readonly GateTestFailure[];
  /** reflect가 같은 런의 기계 gate 판정을 볼 수 있도록 보존한 요약. */
  reflectGateFacts?: ReflectGateFacts;
  /** 실행 집합에 없는 변경 소스 importer 테스트의 gate 관측. */
  importerTestsNotRun?: {
    total: number;
    files: readonly string[];
    truncated: boolean;
    unresolvedRelativeSpecifiers: number;
  } | null;
}

/**
 * ⭐ `OBS-T96` 🅐 — main 정합 관측 payload. ⛔ 순수 함수라 회귀가 «직접» 문다.
 *
 * `mergeTarget`은 호출부가 `defaultBranchRef`로 한 번 해석해 하위 병합기까지 전달한 실제 ref다.
 * `runBase`는 사용자가 선언한 base이므로, 두 값은 같은 칸에 섞지 않는다.
 */
export function mainSyncObservation(
  sync: {
    status: string;
    resolvedFiles?: readonly string[];
    sizeChange?: unknown;
    testDeclarationLoss?: readonly unknown[];
    testDeclarationUnmeasured?: readonly string[];
    errorStep?: string;
    errorDetail?: string;
  },
  mergeTarget: string | null,
  runBase: string | undefined,
  branch: string,
): Record<string, unknown> {
  return {
    status: sync.status,
    resolved: sync.resolvedFiles?.length ?? 0,
    // ⛔ 배열은 6에서 잘린다(log.ts) — 그만큼만 싣고 전체 수는 위 `resolved` 가 답한다
    resolvedFileNames: (sync.resolvedFiles ?? []).slice(0, 6),
    ...(sync.sizeChange === undefined ? {} : { sizeChange: sync.sizeChange }),
    ...(sync.testDeclarationLoss === undefined ? {} : { testDeclarationLoss: sync.testDeclarationLoss }),
    ...(sync.testDeclarationUnmeasured === undefined ? {} : { testDeclarationUnmeasured: sync.testDeclarationUnmeasured }),
    ...(sync.errorStep === undefined ? {} : { errorStep: sync.errorStep }),
    ...(sync.errorDetail === undefined ? {} : { errorDetail: sync.errorDetail }),
    mergeTarget,
    defaultBranchResolved: mergeTarget !== null,
    ...(runBase === undefined ? {} : { runBase }),
    branch,
  };
}

/**
 * ⭐ 기본 브랜치 해석 — ⛔ **실패를 «한 결과»로 모은다.**
 *
 * 🔑 왜 있나 — 종전엔 부르는 자리가 «둘»이고 실패가 «다르게» 끝났다:
 *   resume 경로는 광범위한 `catch {}` 가 예외를 «관측 없이» 삼켰고,
 *   pre-PR 경로는 예외를 그대로 던져 `default-branch-unresolved` 로 «정규화되지 않았다».
 *   ⇒ 같은 원인(원격이 없어 이름이 안 풀린다)이 두 자리에서 다른 얼굴로 나왔다.
 *
 * ✅ 그래서 「없다(null)」와 「못 읽었다(throw)」를 **둘 다** `target: null` 로 내되,
 *   후자는 `error` 를 «이름으로» 달아 관측이 그 둘을 구분할 수 있게 한다.
 *   ⛔ 「못 읽었다」를 「없다」로 접지 않는다 — 그러면 원인이 사라진다.
 */
function resolveDefaultBranchTarget(
  resolve: (cwd: string) => string | null,
  cwd: string,
): { target: string | null; error?: string } {
  try {
    return { target: resolve(cwd) };
  } catch (e) {
    return { target: null, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/**
 * ⭐ `OBS-T96` 🅐 — 정합 «뒤» 게이트 관측 payload.
 *
 * 🔑 실패일 때만 두 칸을 더한다 — 성공 경로 payload 를 바꾸면 기존 소비자가 흔들린다.
 *   `moduleLoadFailure` 는 ***「산출이 상했다」와 「그 순간 트리가 불일치했다」***를 가르는 값이다.
 */
type PostSyncStatus = 'merged' | 'llm-resolved';

type PostSyncGatePolicy = {
  exempted: boolean;
  exemptionWithheld: boolean;
  mustStop: boolean;
};

/** 타임아웃 또는 재실행 강등«뿐»인 게이트 실패 — 도입 0 · 미분류 0 · (timedOut + flakyRerun) > 0 · 자식 책임 없음. */
export const GATE_TIMEOUT_UNMEASURED_MERGE_REASON = 'gate-timeout-unmeasured';

function isTimeoutOnlyUnmeasuredGate(facts: {
  introduced?: number;
  unknown?: number;
  timedOut?: number;
  flakyRerun?: number;
  childResponsibility?: string;
} | undefined): facts is {
  introduced: 0;
  unknown: 0;
  timedOut: number;
  childResponsibility: 'none';
} {
  return facts?.introduced === 0
    && facts.unknown === 0
    && ((facts.timedOut ?? 0) + (facts.flakyRerun ?? 0)) > 0
    && facts.childResponsibility === 'none';
}

export function decideGateFailureDisposition(facts: {
  introduced: number;
  preexisting: number;
  unknown: number;
  unknownReason?: string;
  childResponsibility?: string;
} | undefined): 'escalate-child-unrelated' | 'rework-facts-unmeasured' | 'rework' {
  if (facts?.childResponsibility !== 'none') return 'rework';
  if (facts.unknownReason !== undefined || facts.unknown > 0 || facts.preexisting > 0) return 'escalate-child-unrelated';
  if (facts.introduced === 0 && facts.preexisting === 0 && facts.unknown === 0) return 'rework-facts-unmeasured';
  return 'rework';
}

function postSyncTimeoutOnly(facts: { introduced?: number; unknown?: number; timedOut?: number; flakyRerun?: number; childResponsibility?: string } | undefined): boolean {
  // Post-sync attribution may omit childResponsibility; zero introduced/unknown with only
  // timeout evidence is sufficient here, without weakening the main-loop predicate.
  return (facts?.childResponsibility === undefined || facts.childResponsibility === 'none')
    && isTimeoutOnlyUnmeasuredGate(facts && { ...facts, childResponsibility: 'none' });
}

function postSyncGatePolicy(
  passed: boolean,
  facts: { introduced?: number; unknown?: number; timedOut?: number; flakyRerun?: number; childResponsibility?: string } | undefined,
  syncStatus: PostSyncStatus,
): PostSyncGatePolicy {
  const timeoutOnly = !passed && postSyncTimeoutOnly(facts);
  const introduced = (facts?.introduced ?? 0) > 0;
  const childResponsibility = facts?.childResponsibility;
  const exemptionWithheld = !timeoutOnly && !passed
    && !introduced && childResponsibility === 'none'
    && syncStatus === 'llm-resolved';
  const exempted = !passed
    && (timeoutOnly || (!introduced && childResponsibility === 'none' && syncStatus === 'merged'));
  return {
    exempted,
    exemptionWithheld,
    mustStop: !passed && !timeoutOnly && (introduced || childResponsibility !== 'none' || exemptionWithheld),
  };
}

export function postSyncGateObservation(
  regate: {
    passed: boolean;
    log?: string;
    scopeReason?: string;
    testStepExecuted?: boolean;
    measuredFileCount?: number;
    comparisonBase?: string | null;
    reflectGateFacts?: { introduced: number; preexisting: number; unknown: number; timedOut?: number; flakyRerun?: number; childResponsibility?: string };
  },
  branch: string,
  detectModuleLoadFailure: (output: string) => boolean,
  syncStatus: PostSyncStatus,
): Record<string, unknown> {
  const facts = regate.reflectGateFacts;
  const { exempted, exemptionWithheld } = postSyncGatePolicy(
    regate.passed,
    facts,
    syncStatus,
  );
  return {
    passed: regate.passed,
    mode: 'full',
    branch,
    syncStatus,
    scopeReason: regate.scopeReason ?? 'unavailable',
    measuredFileCount: regate.measuredFileCount ?? 0,
    comparisonBase: regate.comparisonBase ?? null,
    childResponsibility: facts?.childResponsibility ?? null,
    exempted,
    exemptionWithheld,
    ...(regate.passed ? {} : {
      moduleLoadFailure: detectModuleLoadFailure(regate.log ?? ''),
      testStepExecuted: regate.testStepExecuted ?? null,
      ...(facts ? {
        introduced: facts.introduced,
        preexisting: facts.preexisting,
        unknown: facts.unknown,
        timedOut: facts.timedOut ?? 0,
      } : {}),
    }),
  };
}

/** 내부 리뷰 결과(reviewPullRequest·agent-substrate 매핑). verdict fail=must-fix 있음→rework/hold. */
export interface SelfImplementReview {
  verdict: 'pass' | 'warn' | 'fail';
  mustFix: string[];
  shouldFix: string[];
  summary: string;
  /** ★ 실제 리뷰가 돌았나(LLM 파싱 성공). ⚠️ auto-merge 안전 불변식: fail-soft pass(리뷰어 미주입/예외로
   *  verdict='pass' 됐지만 reviewed=false)엔 **자동 병합 금지**(리뷰 없이 main 병합=위험) → HITL 폴백. */
  reviewed: boolean;
  /** 리뷰가 실행되지 않은 실패 사유. 리뷰 엔진이 제공한 경우에만 관측으로 전달한다. */
  failureReason?: string;
  /** 리뷰 엔진이 실제로 사용한 diff 예산. 없는 값은 미검토/no-diff 등으로, 완전한 diff의 증거가 아니다. */
  diffTruncated?: boolean;
  diffShownChars?: number;
  diffTotalChars?: number;
  diffOmittedFiles?: number;
  /** 리뷰 엔진이 실제로 사용한 reviewer-provided context 예산. 관측 전용이며 병합 판정에는 사용하지 않는다. */
  contextItemCount?: number;
  contextShownChars?: number;
  contextTotalChars?: number;
  contextTruncated?: boolean;
  contextFullyIncludedItems?: number;
  contextTruncatedItems?: number;
  contextOmittedItems?: number;
  /**
   * 리뷰어가 파일을 스스로 읽을 수 있었나. **심이 말한 값만** 싣는다.
   * `true` = 읽을 수 있다 · `false` = 읽을 수 없다 · 미선언(`undefined`)은 관측에서 `'unknown'`.
   * ⛔ 오케스트레이터는 이 칸을 추측하지 않는다.
   */
  canSelfRead?: boolean;
}

/** reviewed 관측에 실리는 리뷰어 자기읽기 능력. 미선언은 필드 부재가 아니라 `'unknown'`. */
export type ReviewerCanSelfReadObservation = 'yes' | 'no' | 'unknown';

/** 심이 선언한 boolean 을 관측 삼가(`yes`/`no`/`unknown`)로 옮긴다. 미선언을 `no` 로 접지 않는다. */
export function reviewerCanSelfReadObservation(declared: boolean | undefined): ReviewerCanSelfReadObservation {
  if (declared === true) return 'yes';
  if (declared === false) return 'no';
  return 'unknown';
}

/** 각 단계의 외부 작용 — 주입 가능(테스트 fake·실 어댑터). */
/** #6022의 1,018줄 문서 삭제 단일 표본에 근거한 보수적 자동머지 차단선. 튜닝은 이 상수를 바꿔 수행한다. */
export const DOCS_MARKDOWN_AUTO_MERGE_DELETION_THRESHOLD = 500;

/** The repository's `docs/` directory is case-sensitive by convention; only its Markdown extension is case-insensitive because Git permits mixed-case filenames. */
function isDocsMarkdownPath(path: string): boolean {
  return path.startsWith('docs/') && path.toLowerCase().endsWith('.md');
}

/** Unified diff에서 docs/ 아래 Markdown 파일의 삭제 행만 센다. 이해할 수 없는 Git header는 fail-closed로 오류를 낸다. */
export function countDocsMarkdownDeletions(diff: string): number {
  let currentIsDocsMarkdown = false;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const paths = diffHeaderPaths(line);
      if (!paths) throw new Error('unparseable diff --git header');
      currentIsDocsMarkdown = paths.some(isDocsMarkdownPath);
      continue;
    }
    // `--- a/path`, `--- "a/path"`, and `--- /dev/null` are old-file headers; `---content` is a real deleted line.
    if (currentIsDocsMarkdown && line.startsWith('-') && !/^--- (?:a\/|"a\/|\/dev\/null$)/.test(line)) deletions++;
  }
  return deletions;
}

/** Unified diff에서 `내부 문서 `**`` 가 아닌 파일의 삭제 행을 센다. 헤더 파싱·fail-closed는 countDocsMarkdownDeletions 와 같다. */
export function countNonDocsMarkdownDeletions(diff: string): number {
  let currentIsNonDocsMarkdown = false;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const paths = diffHeaderPaths(line);
      if (!paths) throw new Error('unparseable diff --git header');
      currentIsNonDocsMarkdown = !paths.some(isDocsMarkdownPath);
      continue;
    }
    // `--- a/path`, `--- "a/path"`, and `--- /dev/null` are old-file headers; `---content` is a real deleted line.
    if (currentIsNonDocsMarkdown && line.startsWith('-') && !/^--- (?:a\/|"a\/|\/dev\/null$)/.test(line)) deletions++;
  }
  return deletions;
}

/** 리뷰 seam 이 받는 컨텍스트. ⛔ **여기 한 곳에서만 선언한다** — 종전엔 `orchestrator` 와 `seams` 가
 *  같은 모양을 **각자 인라인으로** 적었고, 그래서 `diffOutsideClaims[].result`(*"깨뜨려서 검증"* 의 출력을
 *  나르는 셋째 칸)가 **한쪽에서만 빠져도 컴파일이 통과**했다(런타임은 흐르는데 타입이 모르는 상태). */
export interface ReviewDiffContext {
  runId?: string;
  commits?: readonly string[];
  changedFiles?: readonly string[];
  goal?: string;
  /** This run's harness-authored goal document path; its diff presence is intended output, not a test side effect. */
  goalFile?: string;
  /** Harness-authored goal document path from the ledger; absent is unknown, not an exemption. */
  goalDocumentPath?: string;
  round?: number;
  appliedLastRound?: readonly string[];
  priorRunFindings?: import('./prior-draft-findings.js').PriorDraftFinding[];
  /** Existing run-chain projection of sibling shards; absent means no sibling runs were observed. */
  shardSiblings?: {
    items: readonly RunChainShardSibling[];
    shownItems: number;
    totalItems: number;
    omittedItems: number;
    truncated: boolean;
  };
  diffOutsideClaims?: readonly { claim: string; verify: string; result?: string }[];
  gateEvidenceNote?: string;
  preexistingTestFailures?: readonly string[];
  /** 실행 집합에 없는 변경 소스 importer 테스트의 gate 관측. */
  importerTestsNotRun?: {
    total: number;
    files: readonly string[];
    truncated: boolean;
    unresolvedRelativeSpecifiers: number;
  } | null;
  /** ★ 골의 `## REQUIRED EVIDENCE` 태그에 대한 하니스의 기계 판정. ⛔ 로그에만 남기면 판정자가 못 본다. */
  evidenceCoverage?: {
    required: number;
    covered: number;
    missing: readonly string[];
    coveredByLimitation: readonly string[];
    uncovered: readonly string[];
    coveredByLimitationCount: number;
    uncoveredCount: number;
    /** 골에 명시된 limitation 수. 요구 0과 declaration 부재를 구분한다. */
    limitationCount: number;
  };
  /** Read-only comparison of the worktree DESIGN.md declaration and installed craft rulebooks. */
  designCheck?: DesignCheckOutcome;
  /** Deterministic design-token result supplied to review, never the implementation gate. */
  designGate?: DesignGateResult | { unmeasured: string };
}

/** 런 사실(커밋 제목·변경 파일)을 fail-soft 로 걷어 온다. seam(git) 이 실패하면 그 종류를 생략하고,
 *  성공한 빈 변경 목록은 보존한 채 런은 계속 간다 — PR 개설을 막거나 예외를 위로 던지지 않는다. */
export function collectRunFacts(cwd: string): { commits?: readonly string[]; changedFiles?: readonly string[] } {
  if (!existsSync(join(cwd, '.git'))) return {};
  let commits: string[] | undefined;
  let files: string[] | undefined;
  try { commits = commitTitles(cwd); } catch { commits = undefined; }
  try { files = changedFiles(cwd); } catch { files = undefined; }
  return {
    ...(commits?.length ? { commits } : {}),
    ...(files === undefined ? {} : { changedFiles: files }),
  };
}

/**
 * ⭐ 자식이 실제로 바꾼 파일 중, 골이 선언한 대상 밖에 있는 것을 센다.
 *
 * ⛔ 원장의 경로별 `declared`/`traced`/`both` 와 혼동하지 않는다 — 그 값은 골 문서의
 *   다른 절에서 온 것이고, 이 관측은 `collectRunFacts` 가 모은 자식 변경만 쓴다.
 * ⛔ 막지 않는다. 세기만 한다. 대상 밖 편집이 필요한 경우가 있다.
 * ⛔ 선언을 못 읽으면 0 이 아니라 `unknown` 이다 — 못 읽은 것을 없음으로 접지 않는다.
 */
export const DECLARED_SCOPE_OUTSIDE_NAME_CAP = 6;

export type DeclaredScopeDiffStatus = 'known' | 'unknown' | 'unknown-changed-files';

export interface DeclaredScopeDiff {
  status: DeclaredScopeDiffStatus;
  outsideCount: number | null;
  outsideNames: readonly string[];
  nameCapReached: boolean;
  /**
   * ⭐⭐ ***선언했는데 «하나도 안 채워진» 대상 경로.***
   * ⛔ `outside` 의 «반대 방향»이다 — 그쪽은 「밖으로 샜나」, 이쪽은 「안을 «비웠나»」.
   * 🩸 2026-09-12 실측: A/B 네 판이 `docs/`·`TASK.md` 만 둔 채 ***「구현 완료 · gate 통과」***로 찍혔다.
   *    골은 `index.html`·`style.css` 를 «선언»했는데 ***그것을 보는 자가 «없었다».***
   */
  unmadeCount: number | null;
  unmadeNames: readonly string[];
  /**
   * ⭐⭐ ***선언 경로가 «몇 개였나».*** ⛔ 이것이 없으면 `unmadeCount>0` 을 「결함」으로 읽게 된다.
   * 🩸 [T] 지적(2026-09-12): 골의 `대상 경로:` 는 ***이미 있는 파일***을 자주 대고,
   *    한 조각이 그중 «하나»만 건드리는 것은 ***정상***이다.
   * ⇒ 🔑 찾는 신호는 `unmadeCount > 0` 이 «아니라» ***`unmadeCount === declaredCount`***(하나도 안 채웠다).
   */
  declaredCount: number | null;
}

export function declaredScopeDiffObservation(diff: DeclaredScopeDiff): Record<string, unknown> {
  return {
    declaredScopeDiffStatus: diff.status,
    declaredScopeOutsideCount: diff.outsideCount,
    declaredScopeOutsideNames: diff.outsideNames,
    declaredScopeOutsideNameCapReached: diff.nameCapReached,
    // ⛔ 「못 쟀다」(null)와 「0개」를 «다른 값»으로 낸다 — 앞 칸들과 같은 계약.
    declaredScopeUnmadeCount: diff.unmadeCount,
    declaredScopeUnmadeNames: diff.unmadeNames,
    declaredScopeDeclaredCount: diff.declaredCount,
  };
}

/**
 * 사람 표면에 낼 한 줄. ⛔ ***「하나도 안 만들었을 때만»*** 낸다 — 부분 달성은 다른 축이다.
 * ⛔ 「못 쟀다」(status!=='known')면 «조용하다» — 지어내지 않는다.
 */
export function declaredScopeUnmadeLine(diff: DeclaredScopeDiff): string | null {
  if (diff.status !== 'known') return null;
  if (diff.unmadeCount === null || diff.declaredCount === null) return null;
  if (diff.declaredCount === 0) return null;
  // ⛔⭐ ***「일부만 채웠다」는 «정상»이다*** — 조각이 선언 셋 중 하나만 건드리는 것은 흔하다([T] 2026-09-12).
  //    ⇒ 사람 줄은 ***「하나도 안 채웠을 때만»*** 낸다.
  if (diff.unmadeCount !== diff.declaredCount) return null;
  return `⚠️ 선언한 대상 ${diff.declaredCount}개를 «하나도» 안 만들었다 — ${diff.unmadeNames.join(' · ')}`;
}

function normalizeDeclaredScopePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function changedFileIsInsideDeclaredTarget(changedFile: string, declaredPath: string): boolean {
  const file = normalizeDeclaredScopePath(changedFile);
  const target = normalizeDeclaredScopePath(declaredPath);
  if (!file || !target) return false;
  return file === target || file.startsWith(`${target}/`);
}

function parseDeclaredTargetPathsFromAsk(askText: string): { readable: boolean; paths: readonly string[] } {
  const firstLine = askText.split(/\r?\n/).find((line) => line.trim() !== '');
  if (firstLine === undefined) return { readable: false, paths: [] };
  const match = /^\s*(?:대상\s*경로|target\s*paths?)\s*[:：]\s*(.*)$/i.exec(firstLine);
  if (!match) return { readable: false, paths: [] };
  const paths: string[] = [];
  for (const fragment of match[1]!.split(/[·,]/)) {
    const piece = fragment.trim().replace(/^`+|`+$/g, '');
    if (piece === '' || !/[/.]/.test(piece) || /\s/.test(piece)) continue;
    paths.push(normalizeDeclaredScopePath(piece));
  }
  return { readable: true, paths: [...new Set(paths.filter(Boolean))] };
}

function declaredPathsFromGoalDocumentText(document: string): { readable: boolean; paths: readonly string[] } {
  const originalAsk = extractVerbatimOriginalAsk(document)?.ask ?? null;
  if (originalAsk === null) return { readable: false, paths: [] };
  return parseDeclaredTargetPathsFromAsk(originalAsk);
}

/** Only paths explicitly designated as targets in the ask or piece text protect an intentional revert. */
function declaredRevertGuardPaths(text: string): string[] {
  const lines = targetScopedGoalText(text).split(/\r?\n/);
  const pieceTargets: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/^\s*(?:[-*+]\s+|>\s*)+/, '');
    const declaration = /^(?:조각\s+)?(?:대상\s*경로|target\s*paths?)\s*[:：]\s*(.*)$/i.exec(line);
    if (!declaration) continue;
    const fragments = [declaration[1]!];
    while (index + 1 < lines.length) {
      const next = lines[index + 1]!.trim().replace(/^(?:[-*+]\s+|>\s*)+/, '');
      const paths = parseDeclaredTargetPathsFromAsk(`대상 경로: ${next}`).paths;
      const tokens = next.split(/[·,]/).map((part) => part.trim().replace(/^`+|`+$/g, ''));
      if (!tokens.length || !tokens.every((token) => token && paths.includes(normalizeDeclaredScopePath(token)))) break;
      fragments.push(next);
      index++;
    }
    pieceTargets.push(...parseDeclaredTargetPathsFromAsk(`대상 경로: ${fragments.join(',')}`).paths);
  }
  return pieceTargets;
}

function revertGuardTargetPaths(feature: string, goalDocument?: string): string[] {
  const originalAsk = goalDocument ? extractVerbatimOriginalAsk(goalDocument)?.ask : undefined;
  return [...new Set([...declaredRevertGuardPaths(feature), ...(originalAsk ? declaredRevertGuardPaths(originalAsk) : [])])];
}

export function detectDeclaredScopeDiff(input: {
  goalDocument?: string | null;
  changedFiles?: readonly string[] | null;
  nameCap?: number;
}): DeclaredScopeDiff {
  const nameCap = input.nameCap ?? DECLARED_SCOPE_OUTSIDE_NAME_CAP;
  if (input.goalDocument === undefined || input.goalDocument === null) {
    return { status: 'unknown', outsideCount: null, outsideNames: [], nameCapReached: false, unmadeCount: null, unmadeNames: [], declaredCount: null };
  }
  const declared = declaredPathsFromGoalDocumentText(input.goalDocument);
  if (!declared.readable) {
    return { status: 'unknown', outsideCount: null, outsideNames: [], nameCapReached: false, unmadeCount: null, unmadeNames: [], declaredCount: null };
  }
  if (input.changedFiles === undefined || input.changedFiles === null) {
    return { status: 'unknown-changed-files', outsideCount: null, outsideNames: [], nameCapReached: false, unmadeCount: null, unmadeNames: [], declaredCount: null };
  }
  const outside = [...new Set(input.changedFiles.map(normalizeDeclaredScopePath).filter(Boolean))]
    .filter((file) => !declared.paths.some((target) => changedFileIsInsideDeclaredTarget(file, target)));
  // ⭐ 「선언했는데 «안 채워진»」 것 — `outside` 의 반대 방향이다.
  const changed = [...new Set(input.changedFiles.map(normalizeDeclaredScopePath).filter(Boolean))];
  const unmade = declared.paths.filter((target) => !changed.some((file) => changedFileIsInsideDeclaredTarget(file, target)));
  return {
    status: 'known',
    outsideCount: outside.length,
    outsideNames: outside.slice(0, nameCap),
    nameCapReached: outside.length > nameCap,
    unmadeCount: unmade.length,
    unmadeNames: unmade.slice(0, nameCap),
    declaredCount: declared.paths.length,
  };
}

function observeDeclaredScopeDiff(
  observe: ReturnType<typeof makeRunObserver>,
  input: {
    goalFile?: string;
    changedFiles?: readonly string[];
    nameCap?: number;
    /** ⛔ 없으면 «조용하다» — 관측은 그대로 남는다. */
    progress?: (stage: SelfImplementProgressStage, message: string) => void;
  },
): void {
  let goalDocument: string | null = null;
  if (input.goalFile) {
    try {
      goalDocument = readFileSync(input.goalFile, 'utf8');
    } catch {
      goalDocument = null;
    }
  }
  const diff = detectDeclaredScopeDiff({
    goalDocument,
    changedFiles: input.changedFiles,
    nameCap: input.nameCap,
  });
  observe('declared-scope-diff', declaredScopeDiffObservation(diff));
  // ⭐ 관측은 «언제나» 남기고, ***사람 줄은 「하나도 안 만들었을 때만»*** 낸다.
  const line = declaredScopeUnmadeLine(diff);
  if (line !== null) input.progress?.('declared-targets-unmade', line);
  // ⭐ 그 옆 — `경계:` 글로브에 닿은 변경. 못 읽었거나 변경 목록이 없으면 조용하다.
  if (goalDocument !== null && input.changedFiles !== undefined) {
    const violations = boundaryViolations(boundaryGlobs(goalDocument), input.changedFiles);
    if (violations.length > 0) {
      input.progress?.('boundary-violated', `⚠️ 경계로 선언한 경로를 고쳤다 — ${violations.join(' · ')}`);
    }
  }
}

/**
 * 최종 런 사실로 «갈아 끼운다» — ⛔ 덮어쓰기가 아니라 **먼저 지우고** 얹는다.
 *
 * ⛔⭐⭐ 종전엔 `{ ...ctx, ...collectRunFacts(cwd) }` 였다(리뷰 must-fix). 재수집이 실패하면
 *   `collectRunFacts` 가 그 키를 생략하고, 스프레드는 없는 키를 지우지 않는다.
 *   ⇒ ***루프 안에서 걷은 옛 커밋·옛 변경 파일이 「최종 사실」로 남았다.***
 *   그것은 이 절의 존재 이유(리뷰어가 관측과 잇는 좌표)를 정면으로 뒤집는다 —
 *   ***틀린 좌표는 빈 좌표보다 나쁘다***(빈 칸은 「없다」를 말하지만 틀린 칸은 「이것이다」를 말한다).
 * 🩹 두 키를 떼어 낸 나머지 위에 새 사실을 얹는다. 못 걷었으면 그 종류는 «없는 채로» 간다.
 */
export function withRefreshedRunFacts<T extends { commits?: readonly string[]; changedFiles?: readonly string[] }>(
  context: T,
  facts: { commits?: readonly string[]; changedFiles?: readonly string[] },
): Omit<T, 'commits' | 'changedFiles'> & { commits?: readonly string[]; changedFiles?: readonly string[] } {
  // ⛔⭐ 반환형을 `T` 로 «단언하지 않는다** — 이 함수는 두 키를 «지울 수 있으므로**, 그 키가 필수인
  //   `T` 에 대해 `as T` 는 거짓말이 된다(리뷰 should-fix). 지운 사실을 형에 그대로 적는다.
  const { commits: _staleCommits, changedFiles: _staleChangedFiles, ...withoutStaleRunFacts } = context;
  return { ...withoutStaleRunFacts, ...facts };
}

/** 감독자 입력이 «어떻게 배달됐나» — 이 값은 **한 집에서만** 산다.
 *
 *  📏 2026-08-22 실측(16차 `[F]`): 같은 값이 네 자리에 «각자» 적혀 있었고
 *  (`SelfImplementSeams.implement` · 이 파일의 라운드 지역 타입 · `headless-elanous-driver` 의
 *  `onSupervisorInput` 과 `formatSupervisionProgressLine`) 서로 «달랐다».
 *  `#10942` 가 이 파일 쪽만 `inbox-*` 로 넓히자 두 쪽을 잇는 `seams.ts` 가 컴파일을 못 했고,
 *  ***PWA 빌드 전체가 멈췄다*** — 그런데 `bun test` 는 전부 초록이었다.
 *  ⛔ 깨진 파일이 「그 PR 이 바꾼 파일」이 아니라서 **변경-파일-스코프 게이트 둘 다 원리상 못 봤다**.
 *  ⇒ 그래서 값을 늘리는 자리를 «하나»로 만든다. 다음에 상태가 늘면 네 자리가 «같이» 움직인다. */
export type SupervisorDeliveryState =
  | 'prompt-included'
  | 'delivered'
  | 'inbox-delivered'
  | 'inbox-send-failed'
  | 'not-delivered';

/** 사람이 읽는 supervision 줄에만 뜨는 «배달 전» 단계까지 포함한다.
 *  ⛔ `queued` 는 배달 «결과»가 아니라 대기 상태다 — 그래서 `SupervisorDeliveryState` 에 넣지 않는다. */
export type SupervisorDeliveryLine = SupervisorDeliveryState | 'queued';

export type ImplementTerminalStatus = {
  readonly reached: boolean;
  readonly changed: boolean;
  readonly toolCalls: number;
  readonly timedOut: boolean;
};

export interface SelfImplementSeams {
  /** Run-observer ledger sink. Tests inject an in-memory sink to avoid touching user state. */
  writeRunLedger?: RunLedgerWriter;
  /** Optional context-journal sink for isolated runs. */
  emitContextEvent?: (input: SessionEventInput) => void;
  /** Registers this run as an ephemeral loop-agent asset; failures are observed but never affect execution. */
  registerLoopAgent?: (input: LoopAgentInput) => void;
  /** Wraps implementation and gate promises with their effective wall-clock timeout; tests observe the actual stage budgets. */
  withStepTimeout?: <T>(promise: Promise<T>, ms: number, step: keyof StepTimeouts) => Promise<T>;
  /** Samples the one-minute machine load at the end of a gate observation. */
  sampleLoadAtEnd?: () => number | null | undefined;
  /** Refresh stale account-home quota signals before the first implementation call. */
  refreshCodexQuotaSignals?: () => Promise<unknown>;
  /** Pure active-brain inspection; tests inject a deterministic provider summary. */
  inspectActiveProvider?: () => ActiveProviderInfo;
  /** Read-only rotation authority snapshot; tests inject account availability without changing process state. */
  inspectCodexRotation?: typeof inspectCodexRotation;
  /**
   * Reads structured provider failures written by completed PTY children. `unavailable`
   * deliberately remains distinct from `none`: without a child universe or a readable
   * store, the orchestrator must not claim the child had zero provider failures.
   */
  queryChildProviderErrors?: (input: { runId: string; sinceMs: number; untilMs: number }) => Promise<
    | { status: 'found'; providerErrorCount: number; credentialFailureCount: number; lastProviderError?: { provider?: string; message?: string }; lastCredentialFailure?: { provider?: string; message?: string } }
    | { status: 'none' }
    | { status: 'unavailable'; reason?: string }
  >;
  /** Provider gate source; tests inject the provider rather than inherit ambient configuration. */
  currentProviderName?: () => string | undefined;
  /** 현재 세션을 포크해 새 sessionId 반환(history+model 계보). 생략 시 fork 없이 진행. */
  forkSession?: (parentSessionId: string) => Promise<string>;
  /** Terminal supervisor memos target the currently active child control inbox. */
  /** 반환값(게시한 기록 경로)은 여기서 쓰지 않는다 — 시험 주입이 `void` 여도 된다. */
  enqueueControlMemo?: (...args: Parameters<typeof enqueueControlMemo>) => unknown;
  /** Parent-space durable soft-stop marker. Tests inject this; production reads `stop-requested.json`. */
  readSoftStopRequestStatus?: (spaceId: string) => SoftStopRequestRead;
  /** Parent harness space whose durable stop marker is read. Tests inject this; production uses `getHarnessSpace()`. */
  parentSoftStopSpaceId?: string;
  /** disposable worktree 생성 → 경로·브랜치 ⊕ **어디서 갈랐나**(관측용).
   *  ⚠️ 관측 3필드는 **선택**이다 — 시임은 주입점이고, 테스트 더블에게 git SHA 를 지어내라고
   *  요구하면 계약이 아니라 부담이 된다. 실 시임(`defaultSeams`)은 항상 채운다.
   *  ⛔ 없을 때 0/빈 문자열로 채우지 마라 — 관측에는 `null` 로 싣는다(모름 ≠ 값). */
  synthesizeGoalContext?: (input: { goalFile?: string }) => Promise<Pick<import('../harness/harness-worktree-add.js').HarnessWorktreeGoalMetadata, 'goalTitle' | 'goalDescription' | 'goalDescriptionSource'>>;
  createWorktree: (opts: { branch: string; base?: string; runId?: string } & import('../harness/harness-worktree-add.js').HarnessWorktreeGoalMetadata) => Promise<{
    path: string; branch: string;
    /** Strict provenance values are returned only after their recording succeeds. */
    owner?: string;
    command?: string;
    createdAt?: string;
    /** Provenance write failure is non-fatal because the worktree is the run's workspace. */
    provenanceError?: string;
    /** 해소된 base ref(생략 시 'HEAD'). ⚠️ **요청 여부의 출처가 아니다** — 그것은 호출 입력이 안다. */
    base?: string | undefined;
    /** 실제 시작 커밋 SHA — "어디서 갈랐나" 에 답하는 값. */
    resolvedBase?: string;
    /** 하니스를 발사한 트리의 HEAD. resolvedBase 와 다르면 다른 뿌리에서 갈린 것이다. */
    invokedHead?: string;
    /** resolvedBase가 origin/main의 조상이거나 같은지. 판정 불가 시 생략한다. */
    baseIsIntegration?: boolean;
  }>;
  /** 기본 브랜치 해석 seam. 기본은 seams.ts의 origin/로컬 폴백 순서를 그대로 사용한다. */
  defaultBranchRef?: (worktreePath: string) => string | null;
  /** ★ se 스택 base 위에 해석된 기본 브랜치 ref를 반영하는 seam(구조적 정합·주입 테스트). */
  /** 호출부가 해석한 대상만 병합한다. Promise 결과의 기존 상태에 `default-branch-unresolved`를 더한다. */
  mergeMain?: (worktreePath: string, mergeTarget: string) => Promise<import('../autopilot/build/llm-conflict-merge.js').LlmMergeOutcome>;
  /** ★ G2(2026-07-21·병렬 auto-merge 안전) — worktree 변경을 커밋한다(mergeMain 이 clean tree 를 요구하므로
   *  PR 直前 main-싱크 전에 impl 변경을 먼저 커밋). 기본=commitWorktree. 미주입 시 G2 pre-PR 싱크 skip(fail-safe).
   *  [[ROADMAP-elanous-is-all-pty-unified-autonomy-2026-07-21]] G2. */
  commitWork?: (cwd: string, message: string) => void;
  /** Observe a finished child's uncommitted work before classifying a missing diff. */
  detectUncommittedWork?: typeof detectUncommittedWork;
  /** Commit only the measured, eligible target paths. An injected seam preserves the same path boundary. */
  commitFinishedChildWork?: (cwd: string, paths: readonly string[], message: string) => { ok: boolean; out: string };
  /** --ground 코드베이스 prepass seam. cwd는 구현 대상 worktree이며 실패는 goal-loop를 막지 않는다. */
  groundGoal?: (goalText: string, deps: { cwd: string }) => Promise<string>;
  /** ③ 구현 — cwd(worktree)에서 코딩 에이전트 구동(P1: 헤드리스 elanous spawn·goal-loop 아밍).
   *  escalateTier(#2) — sol 단일 승급으로 재시도하고 seam 이 그 대상을 honor한다. */
  /** ⚠️ `runId` 는 **필수**(리뷰 should-fix) — 오케스트레이터가 항상 보장하므로 옵셔널로 두면 새 seam
   *  구현이 전파를 조용히 빠뜨릴 수 있다. 필수로 선언해 컴파일 시점에 막는다. */
  implement: (ctx: { sessionId?: string; cwd: string; feature: string; /** 하니스가 워크트리에 깔아 둔 경로(워크트리 상대) — «자식의 변경» 판정에서 뺀다. PR 에는 그대로 실린다. */ harnessSeededPaths?: readonly string[]; documentReferences?: readonly DocumentReferenceStatus[]; escalateTier?: EscalateTier; childLlm?: ChildLlmSelection; signal?: AbortSignal; runId: string; shardIdentity?: RunShardIdentity; /** Execute judge only: raw PTY delta arrives every poll and must never render on a parent surface. */ onProgress?: (delta: string) => void; /** Parent-surface only: sparse boundary, supervision, and frame-stall progress lines. */ onSurfaceProgress?: (line: string) => void; onLifecycleScreenClassification?: (classification: LifecycleScreenComparison) => void; onSupervisorInput?: (text: string, updateDelivery?: (delivery: SupervisorDeliveryState, reason?: string) => void) => void; roundContext?: { round: number; effectiveMax: number; previousRoundFailure: string; landedSiblings?: { items: readonly { runId: string; shardId?: string; pieceIndex?: number; prNumber: number }[]; shownItems: number; totalItems: number; omittedItems: number; truncated: boolean } } }) => Promise<{ ok: boolean; summary: string; completionDisposition?: SelfImplementCompletionDisposition; /** ★ I-9 — 화면 **전체**에서 수확한 `EVIDENCE`/`RESULT` 줄. 미주입 시 `summary`(꼬리 2000자) 폴백(무회귀). */ evidenceTranscript?: string; /** 자식 화면에서 이미 센 도구 호출 횟수. 미주입은 모름이지 0이 아니다. */ toolCalls?: number; /** 자식 실행이 관측한 종결 상태. 미주입은 모름이지 false/0이 아니다. */ terminalStatus?: ImplementTerminalStatus }>;
  /** Same-goal prior-run projection for rework diagnosis. Null distinguishes an unreadable ledger from an empty history. */
  priorRunsByGoalId?: (goalId: string, limit: number) => GoalPriorRuns | null;
  /** Authored goal document path recorded by the goal ledger; undefined means the provenance is unknown. */
  goalDocumentPathByGoalId?: (goalId: string) => string | undefined;
  /** ★ 진단 합성 seam(#1·2026-07-22 대표 PLAN) — 재투입 전 raw 실패/리뷰 로그를 "왜 실패했고 어떻게 고칠지"
   *  1스텝 진단(luna/sol)으로. 사람이 하던 진단을 내부화 → fixing agent 가 근본부터 소화. 미주입=raw 폴백(무회귀). */
  diagnose?: (ctx: { runId: string; note: string; kind: 'gate' | 'review'; round: number; cwd: string; goal: string; history: readonly string[]; supervisorDecisionHistory?: readonly { round: number; verdict: ReworkBudgetVerdict; reason: string }[]; judgePredictionAccuracy?: ReturnType<typeof judgePredictionAccuracy>; effectiveMax: number; priorRuns?: GoalPriorRuns | null; reviewFindingTelemetry?: { citedReviewSymbolOccurrences: readonly CitedReviewSymbolOccurrence[]; normalizedReviewFindingRepeatCounts: readonly NormalizedReviewFindingOccurrence[]; symbolKeyedReviewFindingCount: number; proseFallbackReviewFindingCount: number }; refutations?: readonly MustFixRefutation[]; refutationRound?: number; purpose?: 'budget' | 'escalation-triage' }) => Promise<string>;
  /** Opt-in decomposition observer for terminal UNCONVERGEABLE runs; it never starts child execution. */
  decomposeShadowGoals?: (feature: string, options?: Pick<SelfDevDecomposeOptions, 'observation'>) => ReturnType<typeof decomposeSelfDevGoal>;
  /** Production provider for the declared rework-budget judgment contract. */
  judgmentCallLLM?: ClassifyShadowCallLLM;
  /** Optional complete recurrence observation for the rework-budget ledger. When omitted, the orchestrator measures the current and prior review findings. */
  reworkBudgetReviewFindingRecurrence?: () => ReviewFindingRecurrence | null;
  /** B0 shadow-only workflow-fabric classifier. Its result is observed but never controls rework. */
  classifyCallLLM?: ClassifyShadowCallLLM;
  /** 기존 review scope diff seam. 증거 수집은 이 문자열만 읽으며 worktree 파일을 열지 않는다. */
  reviewScopeDiff?: (cwd: string, prBase?: string, runId?: string, baseOrigin?: 'resolved-base' | 'default-origin-main') => Promise<string>;
  /** 변경 전 ref의 runtime source 전체. 생략 시 git에서 읽으며, 읽기 실패는 판정 미지로 남긴다. */
  reviewBaselineObservationSource?: (cwd: string, base: string) => Promise<string | undefined>;
  /** ④ gate — cwd 에서 bun test/build. postsync=정합 후 재게이트(merge-base 실행 범위). */
  gate: (cwd: string, ctx?: { runId?: string; mode?: 'postsync'; round?: number }) => Promise<SelfImplementGateResult>;
  /** Gate가 실행된 worktree HEAD가 local origin/main보다 뒤처진 커밋 수. 실패는 undefined(unknown)로 정직하게 남긴다. */
  gateWorktreeBehindMain?: (cwd: string) => Promise<number | undefined>;
  /** 변경 파일 목록 — 게이트 «라우터»가 「코드가 바뀌었나」를 판정하는 입력.
   *  ⛔ 미지정이면 실물 `changedFiles(cwd)` 를 쓴다. 못 얻으면 `undefined` 이고, 라우터는 그때 «돌린다»(fail-safe). */
  changedFilesForGateRoute?: (cwd: string) => readonly string[] | undefined;
  /** An execution choice is made only after a measured change crosses the authored target paths. */
  askExecutionClarification?: typeof askAtExecution;
  /** ★ ⑤ 내부 리뷰 seam(2026-07-21·review-gated merge) — gate 통과 diff 를 리뷰어(reviewPullRequest·
   *  agent-substrate·staged 하니스와 동일 엔진)가 비평. verdict fail(mustFix) → rework 재주입(A 확장),
   *  clean(pass/warn) → 병합 결정. 미주입 시 리뷰 스킵(gate 통과=바로 결정·종전 동작). */
  /** ⚠️ ctx 에 담는 것은 **오케스트레이터만 아는 것**이다 — `round`·`appliedLastRound`.
   *  `수용기준`·`의도적 스코프 경계` 는 ctx 로 나르지 않는다: 그 생산자는 **골 텍스트**이고
   *  `buildReviewIntent` 가 `goal` 하나로 직접 추출한다(`extractIntentBlocks` · 결정론 · LLM 0).
   *  ⇒ 같은 값을 두 경로로 나르면 갈라진다. 골을 SSOT 로 둔다. */
  reviewDiff?: (cwd: string, ctx?: ReviewDiffContext) => Promise<SelfImplementReview>;
  /** Read-only prior-draft reviewer findings; tests inject the lookup to avoid network access. */
  collectPriorDraftFindings?: typeof collectPriorDraftFindings;
  /** Existing run-chain query projection. The orchestrator only selects the current entry's producer-computed siblings. */
  queryRunChain?: () => { entries: readonly { runId: string; prNumber?: number | null; merged?: boolean; shardSiblings: readonly RunChainShardSibling[] }[] };
  /** Computes the worktree's design declaration verdict for review context; informational only. */
  resolveDesignCheck?: (worktreePath: string) => DesignCheckOutcome;
  /** Read-only design-token check for HTML/CSS changes; exceptions remain review-visible. */
  runDesignGate?: typeof runDesignGate;
  /** 실행 원장 우선, 기존 base 브랜치 PR 코멘트 폴백으로 자동 반영 항목을 읽는다. 실패·부재는 빈 목록으로 수렴한다. */
  findAppliedReviewItems?: (branch: string, goalId?: string) => Promise<{ basePrLocated: boolean; items: readonly string[]; headlineComments?: number; source?: 'ledger' | 'pr-comment' | 'unavailable' }>;
  /** ★ 반사-기각 seam(RFC-selfdev-judgment-context-substrate Facet C) — must-fix 재주입 前 각 항목을
   *  등가계약(goal)+diff 대비 반사해 accepted(계약 내 실버그)/rejected(계약 밖·scope creep·stale-diff
   *  아티팩트)로 가른다. 보수 default-accept·코더 분리 judge. 미주입 시 반사 스킵(전체 must-fix 재주입=종전).
   *  전부 rejected → rework 끊고 수렴(verdict warn 강등·auto-merge 는 --auto-merge armed 일 때만). */
  reflectMustFix?: (input: { mustFix: string[]; goal: string; cwd: string; evidenceFacts?: ReflectEvidenceFacts; gateFacts?: ReflectGateFacts; refutations?: readonly MustFixRefutation[]; recurrenceHistory?: readonly MustFixRecurrenceHistory[]; citedPathFacts?: readonly MustFixCitedPathFact[]; runId?: string; round?: number }) => Promise<{ accepted: string[]; rejected: { item: string; reason: string }[] }>;
  /** Read-only cited-path observer. Omission uses the deterministic target-worktree filesystem observation. */
  observeCitedPathFacts?: (mustFix: readonly string[], cwd: string, round: number) => MustFixCitedPathFact[] | Promise<MustFixCitedPathFact[]>;
  /** PR을 열기 전에 보존할 산출물이 있는지 판별한다. `base` 대비 branch 고유 변경과 미커밋 변경을 함께 본다.
   *  생략 시 기존 주입 seam 호환을 위해 산출물이 있다고 본다. */
  preservationHasChanges?: (ctx: { cwd: string; base?: string }) => boolean | Promise<boolean>;
  /** Test seam for blocked environment branch persistence; return whether the branch was pushed. */
  preserveBlockedBranch?: (ctx: { cwd: string; branch: string; title: string }) => boolean | Promise<boolean>;
  /** Hard-cap salvage evidence: a clean worktree and commits ahead of origin/main. */
  readReworkSalvageEvidence?: (cwd: string) => Promise<ReworkSalvageEvidence>;
  /** Starts exactly one detached `elanous dev --file <goal> --base <branch>` follow-up. */
  launchReworkSalvage?: (input: { goalFile: string; base: string; salvageAttempt: number }) => Promise<void>;
  /** Persist a full oversized PR body so its bounded PR counterpart can link to it. */
  persistPrBodyArtifact?: (input: { origin: string; body: string; originalChars: number }) => { path: string };
  /** ⑥ PR 생성. labels=생성 시 부착할 GitHub 라벨(G8 auto-review 자기판단 통과 시). */
  openPr: (opts: { title: string; body: string; head: string; base?: string; draft?: boolean; labels?: string[]; cwd: string }) => Promise<{ url: string; number: number }>;
  /** PR 생성 뒤 런의 라운드 대화를 게시한다. 실패는 PR 개설을 되돌리지 않는다. */
  postPrComment?: (opts: { number: number; body: string; cwd: string }) => Promise<void>;
  addPrLabel?: (opts: { number: number; label: string; cwd: string }) => Promise<void>;
  readPrFiles?: (opts: { number: number; cwd: string }) => Promise<string[]>;
  /** PR의 base/head SHA와 관측된 PR base를 한 응답에서 고정한다. 미주입·실패·빈 SHA면 검사 대상을 증명할 수 없어 fail-closed로 PR을 열어 둔다. */
  readPrCommitShas?: (opts: { number: number; cwd: string }) => Promise<{ baseCommit: string; headCommit: string; baseRefName?: string }>;
  /** 고정한 base/head SHA 쌍의 unified diff. 가변 PR 조회를 다시 사용하면 ABA head 변경에 안전하지 않으므로 두 SHA는 필수 입력이다. */
  readPrDiff?: (opts: { number: number; cwd: string; baseCommit: string; headCommit: string }) => Promise<string>;
  /** ★ ⑦ 병합 seam(2026-07-21·auto-merge) — 열린 PR 을 실제 병합(gh pr merge --squash). `matchHeadCommit`이 있으면
   * 검사한 고정 head 뒤 변경을 gh가 거부한다. autoMerge + 리뷰 clean 일 때만 호출(outward-facing·main 자율병합). */
  mergePr?: (opts: { number: number; cwd: string; matchHeadCommit?: string }) => Promise<{ merged: boolean; baseRefName?: string; mergeCommit?: string; detail?: string }>;
  /** Only successful merges trigger this injected, fail-closed draft inventory and mutation seam. */
  supersedeDraftsOnMerge?: (number: number, cwd: string) => Promise<void>;
  /** Post-merge cleanup is opt-in and injectable so tests never touch the filesystem. */
  postMergeCleanup?: {
    enabled: boolean;
    listActiveTerminalDirectories: () => { ok: boolean; value: string[] } | Promise<{ ok: boolean; value: string[] }>;
    isWorktreeInUse: (worktreePath: string, activeDirectories: readonly string[]) => boolean;
    /** `undefined` means inspection failed, never a clean worktree. */
    readWorktreePorcelain: (worktreePath: string) => string | undefined | Promise<string | undefined>;
    /** Resolve before removal: an external worktree cannot resolve itself after deletion. */
    resolveMainRepoRoot: (worktreePath: string) => string | null | Promise<string | null>;
    removeWorktree: (repoRoot: string, worktreePath: string) => void | Promise<void>;
    removeBranch: (repoRoot: string, branch: string) => void | Promise<void>;
    /** Inspect the launch-tree copy against the merged remote default branch; never delete on unknown evidence. */
    removeMatchingGoalCopy?: (repoRoot: string, goalFile: string, remoteBranch: string) => { outcome: 'removed' | 'kept'; reason: string } | Promise<{ outcome: 'removed' | 'kept'; reason: string }>;
  };
  /**
   * After a successful auto-merge only: list open drafts and close earlier ones
   * of the same askFile lineage. Tests inject both seams; production wires them
   * in defaultSeams. Failures stay observation-only.
   */
  lineageSupersede?: {
    listOpenDrafts: () => Promise<readonly { number: number; runId: string; openedAt: string }[]> | readonly { number: number; runId: string; openedAt: string }[];
    readRunLedger?: (runId: string) => RunLedgerEntry[] | null | Promise<RunLedgerEntry[] | null>;
    closeDraft: (input: { number: number; comment: string }) => void | Promise<void>;
  };
  /** ⑥ HITL 게이트 — PR open 전 승인. ★fail-closed: 생략/false 면 PR 안 열림(자동 승인 없음). review 동봉
   *  (2026-07-21) — HITL 이 리뷰 verdict 를 보고 판단, auto 모드는 verdict 로 자동 결정. */
  approvePr?: (summary: { branch: string; gateLog?: string; implSummary: string; review?: SelfImplementReview }) => Promise<boolean>;
  /** ⑤' apply-in-place(#25 P2/P3) — 비-git dir/config 타겟은 PR 이 없다 → 그림자(cwd)의 변경을 **백업 후
   *  실위치에 적용**한다. 생략 = git 타겟(PR 경로). 존재 = apply 타겟(deploy 가 HITL diff 확인 뒤 호출).
   *  ★auto 금지: 실 FS 쓰기라 호출측(deploy)이 반드시 HITL 게이트를 통과시킨 뒤에만 부른다. */
  apply?: (ctx: { cwd: string }) => { applied: boolean; backup: string; target: string; log: string };
  /** 진행 seam(2026-07-20 · 크로스-서피스 UX) — 각 단계 진입을 서피스로 push.
   *  생략 시 no-op(코어는 debug.log 만·기존 동작 불변). SurfaceUx.progress 로 매핑돼
   *  텔레그램/ACP 등에서 "수분 침묵" 을 완화. best-effort · 실패 삼킴은 호출측 책임. */
  onProgress?: (ev: { stage: SelfImplementProgressStage; message: string }) => void;
  /** Optional shadow checker override. Its failures are observed and never affect execution. */
  checkPipelineTraversal?: (observedNodes: readonly PipelineNodeId[], terminalNode: PipelineNodeId) => PipelineTraversalCheck;
  /** Dedicated additive pipeline-observation boundary. false disables only additive observations; throws and rejected promises are ignored. */
  observePipeline?: false | ((event: 'pipeline-node-entry' | 'pipeline-traversal-shadow' | 'graph-visit-budget', data: Record<string, unknown>) => void | Promise<void>);
  /** Complete review output persistence. The reviewed log contains only the returned artifact path. */
  persistReviewArtifact?: ReviewArtifactWriter;
  /** Complete rework-note persistence. The rework log contains only the returned artifact path and original length. */
  persistReworkNoteArtifact?: (input: { origin: string; runId: string; round: number; kind: string; note: string }) => { path: string };
  /** Persist the implement-abort child summary as its own artifact field — never mixed into the PR reason. */
  persistImplementAbortArtifact?: (input: ImplementAbortArtifactInput) => { path: string };
  /** Independent verifier for supervisor-proposed goal-slot fills. Omission rejects the proposed document. */
  //  ⛔ 증거 모양을 **여기서 다시 적지 않는다** — writer 쪽 타입과 갈리면 검사기가 못 보는 필드가 생긴다
  //    (실제로 `gateLog`·`observedFail` 이 그렇게 빠져 있었다). 한 곳에서 가져온다.
  independentlyCheckGoalSlots?: (
    document: string,
    evidence: SupervisorGoalFillEvidence,
  ) => Promise<boolean>;
  /** Delivers authored unresolved questions through AskUserQuestion before implementation begins. */
  escalateGoalClarifications?: (
    request: Record<string, unknown>,
    dispatchContext?: AskUserQuestionDispatchContext,
  ) => Promise<AskUserQuestionDispatchResult>;
  /** ⭐ 「이 표면에 답할 사람이 있나」. 기본은 실제 stdin 의 TTY 여부다 —
   *  ⛔ 실물에 매이면 테스트가 «환경»을 검사하게 되므로 주입 가능하게 둔다. */
  stdinIsInteractive?: () => boolean;
}

/** onProgress seam 이 통지하는 단계(관측·UX 라벨). */
export const SELF_IMPLEMENT_PROGRESS_STAGES = [
  'start', 'forked', 'worktree', 'implementing', 'implemented',
  'gating', 'gated', 'reviewing', 'reviewed', 'awaiting-approval',
  'pr-opening', 'pr-opened', 'merging', 'merged', 'worktree-completed',
  'aborted', 'gate-failed', 'review-blocked', 'merge-conflict', 'pr-declined',
  'awaiting-clarification', 'parked',
  // ⭐⭐ 🩸 2026-09-12 — ***「선언한 대상을 «하나도» 안 만들고 끝났다」를 사람 표면에 낸다.***
  //    ⛔ 기존 단계 이름을 «빌려 쓰지 않는다» — `progress()` 는 단계 이름으로 원장 행을 만들므로
  //       빌려 쓰면 그 단계 집계가 오염된다([T] 2026-09-12 · `#17767` 이후 계약).
  'declared-targets-unmade',
  // ⭐ `경계:` 글로브에 실제로 닿은 변경. 막지 않고 이름만 낸다.
  'boundary-violated',
] as const;

export type SelfImplementProgressStage = typeof SELF_IMPLEMENT_PROGRESS_STAGES[number];

export const MAX_PROGRESS_MESSAGE_CHARS = 500;
/** Cap for the `pr-open-failed` observation body. Progress still shows only the first line, itself capped by MAX_PROGRESS_MESSAGE_CHARS. */
export const MAX_PR_OPEN_ERROR_CHARS = 2000;
/** Separator between the preserved location and the error's first line on the aborted progress surface. */
const PR_OPEN_FAILED_PROGRESS_SEPARATOR = ' — ';

/**
 * Fit an aborted PR-open progress line into MAX_PROGRESS_MESSAGE_CHARS without letting a long
 * branch or worktree path consume the budget before the error's first line. The error line is
 * reserved first; location (and, if needed, the error line) is truncated only with what remains.
 */
export function formatPrOpenFailedProgress(location: string, errorFirstLine: string): string {
  const limit = MAX_PROGRESS_MESSAGE_CHARS;
  const reason = errorFirstLine.trim();
  if (!reason) return location.slice(0, limit);
  const separator = PR_OPEN_FAILED_PROGRESS_SEPARATOR;
  if (reason.length >= limit) return reason.slice(0, limit);
  const reasonBudget = reason.length + separator.length;
  const locationBudget = Math.max(0, limit - reasonBudget);
  const shownLocation = location.length <= locationBudget ? location : location.slice(0, locationBudget);
  return `${shownLocation}${separator}${reason}`.slice(0, limit);
}

export interface NormalizedReviewFindingOccurrence {
  hash: string;
  firstSeenRound: number;
  repeatedAtRound: number;
  occurrence: number;
  /** Distinct completed review rounds that observed this normalized finding, including this round. */
  observedRoundCount?: number;
}

export interface CitedReviewSymbolOccurrence {
  /** Fixed-length SHA-256 identity of the full cited symbol; `symbol` is preview-only. */
  hash: string;
  symbol: string;
  firstSeenRound: number;
  lastSeenRound: number;
  occurrence: number;
}

export const MAX_CITED_REVIEW_SYMBOLS_PER_RUN = 256;

export interface ReviewFindingBudget {
  items: string[];
  itemCount: number;
  shownChars: number;
  totalChars: number;
  truncated: boolean;
  fullyIncludedItems: number;
  truncatedItems: number;
  omittedItems: number;
}

const REVIEW_FINDING_RECORD_MAX_CHARS = 12_000;
export const SUPERVISOR_REASON_RECORD_MAX_CHARS = 12_000;

/** Extract the first supervisor REASON line without creating a value for blank or missing reasons. */
export function extractSupervisorReason(rawSupervisorResponse: string): string | undefined {
  for (const line of rawSupervisorResponse.split(/\r?\n/)) {
    if (!line.startsWith('REASON:')) continue;
    const reason = line.slice('REASON:'.length).trim();
    return reason ? reason.slice(0, SUPERVISOR_REASON_RECORD_MAX_CHARS) : undefined;
  }
  return undefined;
}

const REVIEW_SHARD_SIBLING_MAX_ITEMS = 16;
const REVIEW_SHARD_SIBLING_IDENTIFIER_MAX_CODE_POINTS = 160;

function boundShardSiblingIdentifier(identifier: string): string {
  const codePoints = Array.from(identifier);
  return codePoints.length <= REVIEW_SHARD_SIBLING_IDENTIFIER_MAX_CODE_POINTS
    ? identifier
    : `${codePoints.slice(0, REVIEW_SHARD_SIBLING_IDENTIFIER_MAX_CODE_POINTS - 1).join('')}…`;
}

function projectShardSibling(sibling: RunChainShardSibling): RunChainShardSibling {
  return {
    ...sibling,
    runId: boundShardSiblingIdentifier(sibling.runId),
    ...(sibling.shardId === undefined ? {} : { shardId: boundShardSiblingIdentifier(sibling.shardId) }),
  };
}

function budgetReviewShardSiblings(siblings: readonly RunChainShardSibling[]): NonNullable<ReviewDiffContext['shardSiblings']> {
  const totalItems = siblings.length;
  const items = siblings.slice(0, REVIEW_SHARD_SIBLING_MAX_ITEMS).map(projectShardSibling);
  return {
    items,
    shownItems: items.length,
    totalItems,
    omittedItems: totalItems - items.length,
    truncated: items.length < totalItems,
  };
}

/** Only multi-piece runs can have sibling shards, so avoid the full ledger projection otherwise. */
export function isShardSiblingLookupEligible(shardIdentity: Pick<RunShardIdentity, 'pieceTotal'>): boolean {
  return shardIdentity.pieceTotal > 1;
}

type ShardSiblingLookupPurpose = 'review-context' | 'rework-context';
type ShardSiblingLookupStatus = 'skipped' | 'succeeded-with-siblings' | 'succeeded-without-siblings' | 'failed';

function queryShardSiblingsForContext<
  T,
  TChain extends { entries: readonly { runId: string; prNumber?: number | null; merged?: boolean; shardSiblings: readonly RunChainShardSibling[] }[] },
>(
  purpose: ShardSiblingLookupPurpose,
  shardIdentity: Pick<RunShardIdentity, 'pieceTotal'>,
  query: () => TChain,
  project: (chain: TChain) => T | undefined,
  observe: ReturnType<typeof makeRunObserver>,
): T | undefined {
  if (!isShardSiblingLookupEligible(shardIdentity)) {
    observe('shard-sibling-query', { purpose, status: 'skipped' satisfies ShardSiblingLookupStatus, reason: 'not-sharded', pieceTotal: shardIdentity.pieceTotal });
    return undefined;
  }
  try {
    const projected = project(query());
    observe('shard-sibling-query', {
      purpose,
      status: (projected === undefined ? 'succeeded-without-siblings' : 'succeeded-with-siblings') satisfies ShardSiblingLookupStatus,
      pieceTotal: shardIdentity.pieceTotal,
    });
    return projected;
  } catch (error) {
    observe('shard-sibling-query', {
      purpose,
      status: 'failed' satisfies ShardSiblingLookupStatus,
      pieceTotal: shardIdentity.pieceTotal,
      reason: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    }, { level: 'warn' });
    return undefined;
  }
}

function budgetLandedShardSiblings(
  siblings: readonly RunChainShardSibling[],
  runChainEntries: readonly { runId: string; prNumber?: number | null; merged?: boolean }[],
): { items: readonly { runId: string; shardId?: string; pieceIndex?: number; prNumber: number }[]; shownItems: number; totalItems: number; omittedItems: number; truncated: boolean } | undefined {
  const landedByRunId = new Map(runChainEntries
    .filter((entry): entry is { runId: string; prNumber: number; merged: true } => entry.merged === true && typeof entry.prNumber === 'number')
    .map((entry) => [entry.runId, entry.prNumber]));
  const landed = siblings.flatMap((sibling) => {
    const prNumber = landedByRunId.get(sibling.runId);
    return prNumber === undefined ? [] : [{ ...projectShardSibling(sibling), prNumber }];
  });
  if (!landed.length) return undefined;
  const items = landed.slice(0, REVIEW_SHARD_SIBLING_MAX_ITEMS);
  return {
    items,
    shownItems: items.length,
    totalItems: landed.length,
    omittedItems: landed.length - items.length,
    truncated: items.length < landed.length,
  };
}

function budgetReviewFindings(items: readonly string[]): ReviewFindingBudget {
  const totalChars = items.reduce((total, item) => total + item.length, 0);
  const itemCount = items.length;
  if (itemCount === 0) {
    return { items: [], itemCount: 0, shownChars: 0, totalChars: 0, truncated: false, fullyIncludedItems: 0, truncatedItems: 0, omittedItems: 0 };
  }
  const itemBudget = Math.floor(REVIEW_FINDING_RECORD_MAX_CHARS / itemCount);
  let fullyIncludedItems = 0;
  let truncatedItems = 0;
  let omittedItems = 0;
  const shown = items.flatMap((item) => {
    if (item.length <= itemBudget) {
      fullyIncludedItems += 1;
      return [item];
    }
    const markerFor = (omitted: number) => `... [${omitted} chars omitted from review finding] ...`;
    let shownChars = Math.max(0, itemBudget - markerFor(item.length).length);
    let marker = markerFor(item.length - shownChars);
    shownChars = Math.max(0, itemBudget - marker.length);
    marker = markerFor(item.length - shownChars);
    if (marker.length > itemBudget) {
      omittedItems += 1;
      return [];
    }
    truncatedItems += 1;
    return [`${item.slice(0, shownChars)}${marker}`];
  });
  const shownChars = shown.reduce((total, item) => total + item.length, 0);
  return {
    items: shown,
    itemCount,
    shownChars,
    totalChars,
    truncated: shownChars < totalChars,
    fullyIncludedItems,
    truncatedItems,
    omittedItems,
  };
}

export type ObservationMeasurementBasis = 'new-observation-name' | 'existing-observation-fields' | 'no-observation';

type ObservationCall = { name: string; payloadKeys: Set<string> };
type DiffSourcePair = { path: string | undefined; before: string[]; after: string[] };

function isRuntimeSourcePath(path: string | undefined): boolean {
  if (path === undefined || !/\.[cm]?[jt]sx?$/i.test(path)) return false;
  return !/(?:^|\/)(?:__fixtures__|fixtures|__snapshots__|snapshots?|test|tests|docs?|reports?|generated|dist|build|coverage)(?:\/|$)|\.(?:test|spec|snap|fixture)\.[cm]?[jt]sx?$/i.test(path);
}

function diffSourcePairs(diff: string): DiffSourcePair[] {
  const pairs: DiffSourcePair[] = [];
  let pair: DiffSourcePair = { path: undefined, before: [], after: [] };
  const finishPair = (): void => {
    if (pair.before.length || pair.after.length) pairs.push(pair);
  };
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      finishPair();
      pair = { path: header[2], before: [], after: [] };
      continue;
    }
    const afterPath = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (afterPath) {
      if (afterPath[1] !== '/dev/null') pair.path = afterPath[1];
      continue;
    }
    if (/^(?:--- |@@|index |new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(line)) continue;
    if (line.startsWith('+')) pair.after.push(line.slice(1));
    else if (line.startsWith('-')) pair.before.push(line.slice(1));
    else if (line.startsWith(' ')) {
      pair.before.push(line.slice(1));
      pair.after.push(line.slice(1));
    }
  }
  finishPair();
  return pairs;
}

function skipSourceTrivia(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      return index < 0 ? source.length : skipSourceTrivia(source, index + 1);
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return index;
}

type QuotedScan = { value: string | undefined; end: number; expressions: string[] };

function scanTemplateExpression(source: string, from: number): { expression: string; end: number } | undefined {
  let depth = 1;
  for (let index = from; index < source.length; index += 1) {
    const quoted = scanQuoted(source, index);
    if (quoted) {
      index = quoted.end - 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) {
      return { expression: source.slice(from, index), end: index + 1 };
    }
  }
  return undefined;
}

function scanQuoted(source: string, from: number): QuotedScan | undefined {
  const quote = source[from];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  let value = '';
  const expressions: string[] = [];
  for (let index = from + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '\\') {
      if (index + 1 < source.length) value += source[++index]!;
      continue;
    }
    if (char === quote) return { value: expressions.length ? undefined : value, end: index + 1, expressions };
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      const parsed = scanTemplateExpression(source, index + 2);
      if (!parsed) return undefined;
      expressions.push(parsed.expression);
      index = parsed.end - 1;
      continue;
    }
    value += char;
  }
  return undefined;
}

function callArguments(source: string, openParen: number): { args: string[]; end: number } | undefined {
  const args: string[] = [];
  let start = openParen + 1;
  const stack = ['('];
  for (let index = start; index < source.length; index += 1) {
    const quoted = scanQuoted(source, index);
    if (quoted) {
      index = quoted.end - 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    const char = source[index]!;
    if (char === '(' || char === '{' || char === '[') stack.push(char);
    else if (char === ')' || char === '}' || char === ']') {
      const expected = char === ')' ? '(' : char === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) return undefined;
      stack.pop();
      if (!stack.length) {
        args.push(source.slice(start, index).trim());
        return { args, end: index + 1 };
      }
    } else if (char === ',' && stack.length === 1) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return undefined;
}

function objectPayloadKeys(source: string): Set<string> {
  const keys = new Set<string>();
  let index = skipSourceTrivia(source, 0);
  if (source[index] !== '{') return keys;
  let depth = 0;
  while (index < source.length) {
    const quoted = scanQuoted(source, index);
    if (quoted) {
      if (quoted.value !== undefined && depth === 1 && source[skipSourceTrivia(source, quoted.end)] === ':') keys.add(quoted.value);
      index = quoted.end;
      continue;
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      index = skipSourceTrivia(source, index);
      continue;
    }
    const char = source[index]!;
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (depth === 1 && /[A-Za-z_$]/.test(char)) {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))?.[0];
      if (identifier) {
        const end = index + identifier.length;
        if (source[skipSourceTrivia(source, end)] === ':') keys.add(identifier);
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return keys;
}

function observationCalls(source: string): ObservationCall[] {
  const calls: ObservationCall[] = [];
  for (let index = 0; index < source.length;) {
    const next = skipSourceTrivia(source, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const quoted = scanQuoted(source, index);
    if (quoted) {
      for (const expression of quoted.expressions) calls.push(...observationCalls(expression));
      index = quoted.end;
      continue;
    }
    const callee = /^(?:debug\.log|observe[A-Za-z0-9_]*)\b/.exec(source.slice(index))?.[0];
    if (!callee) {
      index += 1;
      continue;
    }
    const openParen = skipSourceTrivia(source, index + callee.length);
    if (source[openParen] !== '(') {
      index += callee.length;
      continue;
    }
    const parsed = callArguments(source, openParen);
    if (!parsed) {
      index += callee.length;
      continue;
    }
    const nameIndex = callee === 'debug.log' ? 1 : 0;
    const name = scanQuoted(parsed.args[nameIndex] ?? '', 0)?.value;
    if (name !== undefined) {
      const category = callee === 'debug.log' ? scanQuoted(parsed.args[0] ?? '', 0)?.value : undefined;
      const payloadIndex = callee === 'debug.log' ? 2 : 1;
      calls.push({ name: `${callee}:${category ?? ''}:${name}`, payloadKeys: objectPayloadKeys(parsed.args[payloadIndex] ?? '') });
    }
    for (const arg of parsed.args) calls.push(...observationCalls(arg));
    index = parsed.end;
  }
  return calls;
}

function callsByName(calls: readonly ObservationCall[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const call of calls) {
    const keys = result.get(call.name) ?? new Set<string>();
    for (const key of call.payloadKeys) keys.add(key);
    result.set(call.name, keys);
  }
  return result;
}

/** A literal runtime observation absent from the complete baseline name set is new; otherwise any added
 * call or top-level payload property on a baseline name counts as an existing-observation field extension. */
export function classifyObservationMeasurement(diff: string, baselineSource = ''): ObservationMeasurementBasis {
  const pairs = diffSourcePairs(diff).filter((pair) => isRuntimeSourcePath(pair.path));
  const baselineCalls = callsByName(observationCalls(baselineSource));
  for (const pair of pairs) {
    for (const call of observationCalls(pair.before.join('\n'))) {
      const keys = baselineCalls.get(call.name) ?? new Set<string>();
      for (const key of call.payloadKeys) keys.add(key);
      baselineCalls.set(call.name, keys);
    }
  }

  let existingObservationExtended = false;
  for (const pair of pairs) {
    const before = callsByName(observationCalls(pair.before.join('\n')));
    const after = callsByName(observationCalls(pair.after.join('\n')));
    for (const [name, afterKeys] of after) {
      if (!baselineCalls.has(name)) return 'new-observation-name';
      const beforeKeys = before.get(name);
      if (!beforeKeys || [...afterKeys].some((key) => !beforeKeys.has(key))) existingObservationExtended = true;
    }
  }
  return existingObservationExtended ? 'existing-observation-fields' : 'no-observation';
}

function baselineObservationSource(cwd: string, base: string): string | undefined {
  const matching = runGitCommand(cwd, [
    'grep', '-l', '-I', '-E', '(debug[.]log|observe[A-Za-z0-9_]*)', base, '--',
    '*.ts', '*.tsx', '*.mts', '*.mtsx', '*.cts', '*.ctsx', '*.js', '*.jsx', '*.mjs', '*.cjs',
  ], { encoding: 'utf8' });
  if (matching.status !== 0 && matching.status !== 1) return undefined;
  const sources: string[] = [];
  for (const matched of matching.stdout.split(/\r?\n/).filter(Boolean)) {
    const path = matched.startsWith(`${base}:`) ? matched.slice(base.length + 1) : matched;
    if (!isRuntimeSourcePath(path)) continue;
    const shown = runGitCommand(cwd, ['show', `${base}:${path}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (shown.status !== 0) return undefined;
    sources.push(shown.stdout);
  }
  return sources.join('\n');
}

export interface GoalExecutionRecord {
  runId: string;
  stage: SelfImplementStage;
  /** RFC 런 출처 O5(2026-09-25) — 이 기록을 남긴 기계(`resolveHostId` · 설치 인스턴스 ID)와 호스트 이름.
   *  원장 `goal_run` 에 넣을 때 비어 있으면 넣는 프로세스의 값으로 채운다(`GoalRunStore.insert`). */
  hostId?: string;
  hostname?: string;
  /** Optional opaque ID that joins a record to its originating request. */
  correlationId?: string;
  /** Optional opaque ID of the originating request's parent correlation. */
  parentCorrelationId?: string;
  /**
   * ⭐ 연합(오케스트레이션) 신원 — ⛔ 연합이 «아니면» 이 칸들이 «없다».
   *
   * 📍 왜 원장에도 있나(대표 2026-08-19 *"원장은 T 세션 쪽"*): 로그에는 `OBS-T101`(#10148·#10157)로
   *   실렸는데 ***원장 SQLite 기록에는 여전히 «0건»***이었다(2026-08-19 02:2x 실측 · 연합 런 완주 뒤에도).
   *   ⇒ 🔑 원장은 `GoalExecutionRecord` 를 JSON 으로 굳히므로 «이 타입에 없으면 영영 안 남는다».
   * ⭐ 키 이름은 로그와 «같게» 둔다 — 다르면 두 스토어를 조인할 수 없다.
   */
  /**
   * ⭐⭐ 이 런이 «어디까지 가려 했나» — ⛔ 「어디까지 갔나」(`stage`)와 «다른 값»이다.
   *
   * 🚨 왜 필요한가(2026-08-19 실측 · 🅢 「항상 초록」 제보의 반대편):
   *   원장 전수에 `(completed, pr-opened)` 가 **70건** 있다. 그것이 「정상」인지 「미완」인지
   *   ***원장만 보고는 못 갈랐다*** — 완료 «모드»가 안 남았기 때문이다.
   *   ⇒ 🔑 그래서 요약이 「merged 만 성공」으로 세면 그 70건이 «거짓 실패»가 되고,
   *     「끝났으면 성공」으로 세면 review-blocked 가 «거짓 성공»이 된다(그것이 🅢 가 잡은 병이다).
   * ⭐ 이 한 칸이 그 양쪽을 «동시에» 막는다 — 성공 판정이 `intent × stage` 로 정해진다.
   */
  completionIntent?: SelfImplementOptions['completion'] | 'not-auto-merge';
  /**
   * ⭐⭐ **쿼터로 죽었나 ⊕ 그때 회전이 「어디로 갔고 그 상태를 알았나」**.
   *
   * 🚨 왜 원장에도 있나 — 종전엔 이 증거가 ***`abandoned-classification` «로그 이벤트»에만*** 있었다.
   *   그런데 원장이 갖는 것은 `failureClassification`·`classificationBasis` ***둘뿐***이라,
   *   ***「이 주행에서 쿼터로 죽은 런이 몇이냐」를 원장만 보고는 못 셌다***(`F12` — 만들어졌는데 안 닿는다).
   *   ⇒ 이것은 연합 키가 「로그엔 있는데 원장엔 0건」이던 것과 ***같은 형태***다(2026-08-19 `#10165`).
   * ⛔ `quotaExhausted` 는 「죽은 원인」이 아니라 ***「죽을 무렵 찼다」는 상관***이다 —
   *   그 한계는 `abandoned-classification.ts` 머리말이 canonical이고 여기서 다시 주장하지 않는다.
   */
  quotaExhausted?: boolean;
  quotaAccountAvailability?: QuotaAccountAvailabilityEvidence;
  orchestrationId?: string;
  shardId?: string;
  siblingShardIds?: readonly string[];
  siblingShardCount?: number;
  shardPosition?: number;
  pieceTotal?: number;
  outcome: RunOutcome;
  ok: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  rounds?: number;
  /** Goal type parsed from the authored-goal metadata; absent when its declaration is malformed. */
  goalType?: GoalType;
  /** Whether goalType was declared, supplied by the parser default, or could not be parsed. */
  goalTypeSource?: 'declared' | 'default' | 'malformed';
  /**
   * Repository-relative ask-file lineage key copied from the goal header.
   * Absent when the goal has no AskFile line — never stored as an empty string.
   */
  askFile?: string;
  /** Optional for records written before classification bases were durable. */
  failureClassification?: AbandonedClassificationResult['classification'];
  /** Optional for records written before classification bases were durable. */
  classificationBasis?: AbandonedClassificationResult['classificationBasis'];
  /** A structured terminal decomposition exposed a goal-side candidate without scheduling another retry. */
  goalCauseObserved?: true;
  supervisorVerdict?: ReworkBudgetVerdict;
  /** First nonempty REASON line emitted with the supervisor's rework-budget verdict. */
  supervisorReason?: string;
  /** Identifies the key semantics used by repeatedReviewFindings and repeatedReviewFindingCount. */
  repeatedReviewFindingKeyVersion?: typeof REVIEW_FINDING_KEY_VERSION;
  repeatedReviewFindings?: boolean;
  repeatedReviewFindingCount?: number;
  /** Number of verbatim must-fix strings repeated across review rounds; distinct from semantic key repeats. */
  verbatimRepeatedReviewFindingCount?: number;
  /** Number of observed review rounds that supplied the comparison basis for repeat counts. */
  reviewFindingComparisonRoundCount?: number;
  normalizedRepeatedReviewFindingCount?: number;
  /** `null` means the recurrence source could not provide an atomic split. */
  ordinaryRepeatedReviewFindingCount?: number | null;
  /** `null` means the recurrence source could not provide an atomic split. */
  previouslyDismissedRepeatedReviewFindingCount?: number | null;
  normalizedRepeatedReviewFindingOccurrences?: NormalizedReviewFindingOccurrence[];
  symbolKeyedReviewFindingCount?: number;
  proseFallbackReviewFindingCount?: number;
  citedReviewSymbolRepeatCount?: number;
  citedReviewSymbolOccurrences?: CitedReviewSymbolOccurrence[];
  lastReviewFindings?: ReviewFindingBudget;
  tier?: EscalateTier;
  /**
   * ⛔⭐⭐⭐ **이 칸은 「이 런이 쓴 모델」이 «아니다».** `resolveEscalateTarget(tier)` 의 값 —
   *   즉 ***「승격 tier 가 가리키는 모델」***이고, `tier === 'none'` 이면 «없다».
   * 🚨 실측(2026-08-19 · 628건): `tier` 는 **622** 인데 이 칸은 ***18*** — ⇒ ***96%가 비어 있다.***
   *   그리고 SQLite 생성 컬럼 이름이 ***`executor`***(`json_extract(doc,'$.model')`)라
   *   ***「누가 실행했나」로 읽히는데 실제로는 그 뜻이 아니고 대부분 NULL 이다***(`F44`⊕`F16`).
   * ⛔ 이름을 지금 «바꾸지 않는다** — 생성 컬럼과 기존 질의가 걸린다. 대신 아래 세 칸을 «따로» 둔다.
   */

  model?: string;
  /** Commit from which this run's worktree was branched. */
  resolvedBase?: string;
  /** Pull request opened by this run. */
  prNumber?: number;
  /** Harness space occupied by this run's parent process; child spaces are intentionally not represented. */
  /** ⭐ 「이 런이 «실제로» 돈 두뇌」 — 런 «시작» 시점의 값이다(끝 시점 아님 · `F45`). */
  runProvider?: string;
  runModel?: string;
  runAuth?: string;
  parentHarnessSpaceId?: string;
  configRoot?: string;
  stateRoot?: string;
  /** Whether this landing's diff can be measured later through a named observation. */
  observationMeasurementBasis?: ObservationMeasurementBasis;
  /** Why an observation measurement basis was intentionally omitted for this newly written record. */
  observationMeasurementSkipped?: 'non-implement-goal-type';
  /** SHA-256 of the goal document body, excluding its appended execution-record section. */
  goalContentHash?: string;
  /** Last completed review's reviewer-provided context observation; absent means no such review/context, while truncated:false means fully shown. */
  reviewerContextBudget?: Pick<ReviewerContextBudget, 'itemCount' | 'shownChars' | 'totalChars' | 'truncated' | 'fullyIncludedItems' | 'truncatedItems' | 'omittedItems'>;
  /** Clarifications left unanswered after a delivery timeout while this run continued. */
  /**
   * ⛔⭐ 「물었는데 답이 «안 왔다»」로 진행한 런. ⚠️ 칸 이름이 `Timeout` 이지만 ***두 경우***를 덮는다 —
   *   어느 쪽이었는지는 `clarificationUnansweredOutcome` 이 말한다(⛔ 이름만 보고 「시간 초과」로 읽지 마라).
   */
  clarificationTimeoutUnanswered?: number;
  /** ⭐ 위 칸이 «왜» 생겼나 — `'timeout'`(실패 출력에 그 «글자»가 있을 때만) ↔ `'no-response'`(물었는데 답이 안 옴). */
  clarificationUnansweredOutcome?: 'timeout' | 'no-response';
  /** Existing clarification observation identifiers retained with a timeout continuation. */
  clarificationTimeoutQuestionIds?: string[];
}

function goalDocumentBody(document: string): string {
  const executionRecordSection = /^## 실행 기록(?:\r?\n|$)/m.exec(document);
  const body = executionRecordSection ? document.slice(0, executionRecordSection.index) : document;
  return body.replace(/\r?\n$/, '');
}

function goalContentHash(goalFile: string): string | undefined {
  try {
    return createHash('sha256').update(goalDocumentBody(readFileSync(goalFile, 'utf8'))).digest('hex');
  } catch {
    return undefined;
  }
}

/** Copy the goal header's AskFile lineage key. A missing or unreadable line omits the field. */
function askFileField(goalFile: string): Pick<GoalExecutionRecord, 'askFile'> {
  try {
    const askFile = parseAskFile(readFileSync(goalFile, 'utf8'));
    return askFile ? { askFile } : {};
  } catch {
    return {};
  }
}

function goalTypeFields(goalFile: string): Pick<GoalExecutionRecord, 'goalType' | 'goalTypeSource'> {
  try {
    const document = readFileSync(goalFile, 'utf8');
    const goalType = parseGoalType(document);
    const declaredGoalTypes = leadingGoalMetadata(document)
      .map((line) => /^- GoalType:[ \t]*(.*)$/.exec(line)?.[1].trim())
      .filter((value): value is string => value !== undefined);
    const hasValidGoalTypeDeclaration = declaredGoalTypes.length === 1
      && GOAL_TYPES.includes(declaredGoalTypes[0] as GoalType);
    if (goalType === null) return { goalTypeSource: 'malformed' };
    return hasValidGoalTypeDeclaration
      ? { goalType, goalTypeSource: 'declared' }
      : { goalType, goalTypeSource: 'default' };
  } catch {
    return {};
  }
}

type GoalExecutionRecordClassification =
  | {
      failureClassification: AbandonedClassificationResult['classification'];
      classificationBasis: AbandonedClassificationResult['classificationBasis'];
      goalCauseObserved?: true;
    }
  | {
      failureClassification?: never;
      classificationBasis?: never;
      goalCauseObserved?: never;
    };

/** A newly-created terminal record either has both abandoned-classification fields or neither. */
export type NewGoalExecutionRecord = Omit<GoalExecutionRecord, 'failureClassification' | 'classificationBasis' | 'goalCauseObserved'>
  & GoalExecutionRecordClassification;

function classificationFields(result: SelfImplementResult): GoalExecutionRecordClassification {
  return result.abandonedClassification
    ? {
        failureClassification: result.abandonedClassification.classification,
        classificationBasis: result.abandonedClassification.classificationBasis,
        ...(result.goalCauseObserved === true ? { goalCauseObserved: true } : {}),
      }
    : {};
}

/**
 * ⛔⭐ 「물었는데 답이 «안 왔다」로 진행했나」를 가르는 순수 판정.
 *
 * 🚨 왜 함수로 빼나 — 종전 조건은 `outcome === 'timeout'` 한 줄이었고, 그 값은
 *   ***실패 출력에 「timeout/timed out」이 «글자로» 있을 때만*** 난다. 그래서
 *   ***「리졸버는 설치됐는데 아무도 답을 안 한」 `no-response` 가 통째로 빠졌다***.
 *   ⇒ 그 판정이 인라인이면 다시 좁아져도 테스트가 못 문다.
 * ⛔ 두 상태를 «같은 값으로 접지 않는다** — 부른 쪽이 어느 쪽이었는지 남길 수 있게 «그 값을» 돌려준다.
 */
export function clarificationUnansweredOutcomeOf(outcome: string): 'timeout' | 'no-response' | undefined {
  return outcome === 'timeout' || outcome === 'no-response' ? outcome : undefined;
}

/**
 * ⛔ 시작 시점 provider 를 원장 칸으로 옮기는 순수 사상. 빈 값·`unknown` 은 «칸을 안 만든다».
 * ⭐ `unknown` 을 적지 않는 이유: 그것은 「모른다」인데, 칸이 있으면 세는 쪽이 「값이 있다」로 읽는다.
 */
export function runProviderFields(
  active: { provider?: string; model?: string; auth?: string } | undefined,
): { runProvider?: string; runModel?: string; runAuth?: string } {
  const keep = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t && t !== 'unknown' ? t : undefined;
  };
  const provider = keep(active?.provider); const model = keep(active?.model); const auth = keep(active?.auth);
  return {
    ...(provider === undefined ? {} : { runProvider: provider }),
    ...(model === undefined ? {} : { runModel: model }),
    ...(auth === undefined ? {} : { runAuth: auth }),
  };
}

function abandonedProviderMetadata(
  classification: AbandonedClassificationResult,
  active: { provider?: string; model?: string } | undefined,
): { provider?: string; model?: string } {
  if (!classification.providerError) return {};
  const { runProvider: provider, runModel: model } = runProviderFields(active);
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

/** ⛔ 원장이 쿼터 증거를 «잃지 않도록» 옮기는 순수 사상. 없으면 «칸을 안 만든다**(0 을 적지 않는다). */
export function quotaLedgerFields(
  abandoned: { readonly quotaExhausted?: boolean; readonly quotaAccountAvailability?: QuotaAccountAvailabilityEvidence } | undefined,
): { quotaExhausted?: boolean; quotaAccountAvailability?: QuotaAccountAvailabilityEvidence } {
  if (!abandoned) return {};
  return {
    ...(abandoned.quotaExhausted === undefined ? {} : { quotaExhausted: abandoned.quotaExhausted }),
    ...(abandoned.quotaAccountAvailability ? { quotaAccountAvailability: abandoned.quotaAccountAvailability } : {}),
  };
}

function reviewerContextBudgetFromReview(review: SelfImplementReview | undefined): GoalExecutionRecord['reviewerContextBudget'] {
  // Persist only the completed reviewer's supplied-context budget; diff and intent budgets answer different exposure questions.
  if (
    review?.reviewed !== true
    || review.contextItemCount === undefined
    || review.contextShownChars === undefined
    || review.contextTotalChars === undefined
    || review.contextTruncated === undefined
    || review.contextFullyIncludedItems === undefined
    || review.contextTruncatedItems === undefined
    || review.contextOmittedItems === undefined
  ) return undefined;
  return {
    itemCount: review.contextItemCount,
    shownChars: review.contextShownChars,
    totalChars: review.contextTotalChars,
    truncated: review.contextTruncated,
    fullyIncludedItems: review.contextFullyIncludedItems,
    truncatedItems: review.contextTruncatedItems,
    omittedItems: review.contextOmittedItems,
  };
}

export type GoalExecutionRecordWriter = (goalFile: string, record: GoalExecutionRecord) => void | Promise<void>;
/** Additive SQLite terminal-record writer. The production default is injected only at the call boundary. */
export type GoalRunRecordWriter = (goalFile: string, record: GoalExecutionRecord, goalId?: string) => void | Promise<void>;

export function appendGoalExecutionRecord(goalFile: string, record: GoalExecutionRecord): void {
  const existing = readFileSync(goalFile, 'utf8');
  const entry = [
    '## 실행 기록',
    `- runId: ${record.runId}`,
    `  stage: ${record.stage}`,
    `  outcome: ${record.outcome}`,
    `  ok: ${record.ok}`,
    ...(record.startedAt ? [`  startedAt: ${record.startedAt}`] : []),
    ...(record.completedAt ? [`  completedAt: ${record.completedAt}`] : []),
    ...(record.durationMs !== undefined ? [`  durationMs: ${record.durationMs}`] : []),
    ...(record.rounds !== undefined ? [`  rounds: ${record.rounds}`] : []),
    ...(record.goalType ? [`  goalType: ${record.goalType}`] : []),
    ...(record.goalTypeSource ? [`  goalTypeSource: ${record.goalTypeSource}`] : []),
    ...(record.failureClassification ? [`  failureClassification: ${record.failureClassification}`] : []),
    ...(record.classificationBasis ? [`  classificationBasis: ${record.classificationBasis}`] : []),
    ...(record.supervisorVerdict ? [`  supervisorVerdict: ${record.supervisorVerdict}`] : []),
    ...(record.supervisorReason ? [`  supervisorReason: ${record.supervisorReason}`] : []),
    ...(record.repeatedReviewFindingKeyVersion ? [`  repeatedReviewFindingKeyVersion: ${record.repeatedReviewFindingKeyVersion}`] : []),
    ...(record.repeatedReviewFindings !== undefined ? [`  repeatedReviewFindings: ${record.repeatedReviewFindings}`] : []),
    ...(record.repeatedReviewFindingCount !== undefined ? [`  repeatedReviewFindingCount: ${record.repeatedReviewFindingCount}`] : []),
    ...(record.verbatimRepeatedReviewFindingCount !== undefined ? [`  verbatimRepeatedReviewFindingCount: ${record.verbatimRepeatedReviewFindingCount}`] : []),
    ...(record.reviewFindingComparisonRoundCount !== undefined ? [`  reviewFindingComparisonRoundCount: ${record.reviewFindingComparisonRoundCount}`] : []),
    ...(record.normalizedRepeatedReviewFindingCount !== undefined ? [`  normalizedRepeatedReviewFindingCount: ${record.normalizedRepeatedReviewFindingCount}`] : []),
    ...(record.ordinaryRepeatedReviewFindingCount !== undefined ? [`  ordinaryRepeatedReviewFindingCount: ${record.ordinaryRepeatedReviewFindingCount}`] : []),
    ...(record.previouslyDismissedRepeatedReviewFindingCount !== undefined ? [`  previouslyDismissedRepeatedReviewFindingCount: ${record.previouslyDismissedRepeatedReviewFindingCount}`] : []),
    ...(record.normalizedRepeatedReviewFindingOccurrences?.length
      ? record.normalizedRepeatedReviewFindingOccurrences.map(({ hash, firstSeenRound, repeatedAtRound, occurrence, observedRoundCount }) => `  normalizedRepeatedReviewFinding: hash=${hash} firstSeenRound=${firstSeenRound} repeatedAtRound=${repeatedAtRound} occurrence=${occurrence}${observedRoundCount === undefined ? '' : ` observedRoundCount=${observedRoundCount}`}`)
      : []),
    ...(record.symbolKeyedReviewFindingCount !== undefined ? [`  symbolKeyedReviewFindingCount: ${record.symbolKeyedReviewFindingCount}`] : []),
    ...(record.proseFallbackReviewFindingCount !== undefined ? [`  proseFallbackReviewFindingCount: ${record.proseFallbackReviewFindingCount}`] : []),
    ...(record.citedReviewSymbolRepeatCount !== undefined ? [`  citedReviewSymbolRepeatCount: ${record.citedReviewSymbolRepeatCount}`] : []),
    ...(record.citedReviewSymbolOccurrences?.length
      ? record.citedReviewSymbolOccurrences.map(({ hash, symbol, firstSeenRound, lastSeenRound, occurrence }) => `  citedReviewSymbol: hash=${hash} symbol=${JSON.stringify(symbol)} firstSeenRound=${firstSeenRound} lastSeenRound=${lastSeenRound} occurrence=${occurrence}`)
      : []),
    ...(record.lastReviewFindings ? [
      `  lastReviewFindingCount: ${record.lastReviewFindings.itemCount}`,
      `  lastReviewFindingShownChars: ${record.lastReviewFindings.shownChars}`,
      `  lastReviewFindingTotalChars: ${record.lastReviewFindings.totalChars}`,
      `  lastReviewFindingsTruncated: ${record.lastReviewFindings.truncated}`,
      `  lastReviewFindingsFullyIncluded: ${record.lastReviewFindings.fullyIncludedItems}`,
      `  lastReviewFindingsTruncatedItems: ${record.lastReviewFindings.truncatedItems}`,
      `  lastReviewFindingsOmittedItems: ${record.lastReviewFindings.omittedItems}`,
      ...record.lastReviewFindings.items.map((item) => `  lastReviewFinding: ${item}`),
    ] : []),
    ...(record.tier ? [`  tier: ${record.tier}`] : []),
    ...(record.model ? [`  model: ${record.model}`] : []),
    ...(record.resolvedBase ? [`  resolvedBase: ${record.resolvedBase}`] : []),
    ...(record.prNumber !== undefined ? [`  prNumber: ${record.prNumber}`] : []),
    ...(record.parentHarnessSpaceId ? [`  parentHarnessSpaceId: ${record.parentHarnessSpaceId}`] : []),
    ...(record.configRoot ? [`  configRoot: ${record.configRoot}`] : []),
    ...(record.stateRoot ? [`  stateRoot: ${record.stateRoot}`] : []),
    ...(record.observationMeasurementBasis ? [`  observationMeasurementBasis: ${record.observationMeasurementBasis}`] : []),
    ...(record.observationMeasurementSkipped ? [`  observationMeasurementSkipped: ${record.observationMeasurementSkipped}`] : []),
    ...(record.goalContentHash ? [`  goalContentHash: ${record.goalContentHash}`] : []),
    ...(record.reviewerContextBudget ? [
      `  reviewerContextItemCount: ${record.reviewerContextBudget.itemCount}`,
      `  reviewerContextShownChars: ${record.reviewerContextBudget.shownChars}`,
      `  reviewerContextTotalChars: ${record.reviewerContextBudget.totalChars}`,
      `  reviewerContextTruncated: ${record.reviewerContextBudget.truncated}`,
      `  reviewerContextFullyIncludedItems: ${record.reviewerContextBudget.fullyIncludedItems}`,
      `  reviewerContextTruncatedItems: ${record.reviewerContextBudget.truncatedItems}`,
      `  reviewerContextOmittedItems: ${record.reviewerContextBudget.omittedItems}`,
    ] : []),
    ...(record.clarificationTimeoutUnanswered !== undefined ? [`  clarificationTimeoutUnanswered: ${record.clarificationTimeoutUnanswered}`] : []),
    ...(record.clarificationTimeoutQuestionIds?.length
      ? record.clarificationTimeoutQuestionIds.map((questionId) => `  clarificationTimeoutQuestionId: ${questionId}`)
      : []),
    '',
  ].join('\n');
  const goalId = existing.match(/^- GoalId: ([0-9a-f]{16})$/m)?.[1];
  if (goalId) {
    const path = writeGoalRunRecordFragment(goalId, record.runId, entry);
    logRunAwareFailSoft(record.runId, 'goal-record-fragment-written', { goalId, path });
  }
  // Legacy documents without GoalId have no fragment key; retain the append so the run is not lost.
  if (goalId && getUserConfig().tools.selfImplement.goalRecordInDoc === false) return;
  if (existing.includes(`- runId: ${record.runId}\n`)) return;
  appendFileSync(goalFile, `${existing.endsWith('\n') ? '' : '\n'}${entry}`);
}

export interface SelfImplementOptions {
  /** ⭐ 걸음을 «호출부»로 흘리는 이음매 — 노드에 들어갈 때마다 한 번.
   *  🩸 2026-09-08: 이 콜백은 «내부에» 있었고 ***호출부가 0*** 이라 걸음이 런 밖으로 안 나갔다.
   *    ⇒ 런 슈퍼바이저는 「시도의 요약 판정」만 보고 「어떻게 걸었나」를 «못 봤다».
   *  ⛔ 관측용이다 — 흐름을 바꾸지 않는다. ⛔ 던져도 런이 안 죽는다(호출부가 감싼다). */
  onNodeEntry?: (node: PipelineNodeId, round: number) => void;
  /** 시험이 런치 오버레이를 빼 «지금 YAML 예산»을 읽게 할 때 쓴다. 생략하면 디스크 오버레이다. */
  graphOverlays?: readonly GraphOverlaySpec[];
  /** Validated, run-local graph variant injected at launch; rejected plans never start the pipeline. */
  graphVariantPlan?: import('./graph-variant.js').GraphVariantPlan;
  /** ★ K run-identity — 이 self-implement 호출의 per-run join anchor. 미지정 시 상속(env)→canonical mint.
   *  리워크 라운드 전부가 이 값을 공유한다(`elanous self run <runId>` 가 호출 전체를 조인). */
  runId?: string;
  /** Authored goal document's stable identity, carried into self-implement observations when present. */
  goalId?: string;
  /** Optional opaque ID for joining this request with correlated execution records. */
  correlationId?: string;
  /** Optional opaque ID for the parent correlation in a nested request. */
  parentCorrelationId?: string;
  /** 자연어 feature 요청. */
  feature: string;
  /** 호출 단위 구현 자식 두뇌. provider와 model은 함께 비어 있지 않게 지정해야 하며, 모든 rework 라운드에 고정 전달한다. */
  childLlm?: ChildLlmSelection;
  /** 런타임이 이미 추출·저장소 경계 판정한 문서 참조. 모든 구현 라운드에 그대로 전달한다. */
  documentReferences?: readonly DocumentReferenceStatus[];
  /** ★ elanous 내부 프롬프트 인핸싱(가산·anti-drift·Phase 1 공용 심) — feature(원문)를 verbatim 보존 +
   *  커버리지 체크리스트를 얹어 round-0 goal-loop 에 전달. 브랜치명/PR제목은 원문(opts.feature) 유지.
   *  명시 override(undefined 면 entry 정책 결정: elanous-apparatus→ON·external-verbatim→OFF·§6e capability 구동).
   *  agent-mission 과 동일한 src/prompt-enhance/ 레이어를 소비(재발명 0). */
  enhance?: boolean;
  /** ★ 진입 클래스(§6e·capability 구동) — enhance mode-gating. 생략 시 기본 external-verbatim(보수·무회귀).
   *  elanous 내부 자연어 구동(데몬 dispatch)은 조립부가 elanous-apparatus를 명시해 enhance/ground를 켠다.
   *  외부 Claude Code/ACP 가 프롬프트를 직접 크래프트했으면 external-verbatim(→OFF·verbatim 존중). */
  entry?: IngestionEntry;
  /** 인핸싱 산출물 유형 힌트(예: 'PLAN 문서'). */
  deliverableHint?: string;
  /** --ground: round-0 objective에 codebase-only grounding을 prepend한다(기본 off). */
  ground?: boolean;
  /**
   * ★ entry-independent 기억 주입(PLAN §6e FIX) — elanous 기억을 가산 grounding 컨텍스트로(프롬프트 무접촉·
   * 인핸싱과 독립). 어떤 진입이든 기본 ON(false 로만 끔). agent-mission 과 동일 레이어(재발명 0).
   */
  memory?: boolean;
  /** 포크할 부모 세션(설정 + forkSession seam 있을 때만 포크). */
  parentSessionId?: string;
  /** PR base 브랜치(기본 provider 기본값). */
  base?: string;
  /** Whether the base came from a human-supplied argument or automatic base resolution. */
  baseSource?: 'human' | 'automatic';
  /** Rule used by the dev pipeline when it resolved the base; additive worktree observation context. */
  baseSelectionRule?: string;
  /** Goal document backing this run. It may be an authored input or a natural-language-derived artifact; provenance is tracked separately. Only file-backed goals are eligible for hard-cap salvage. */
  goalFile?: string;
  /** Caller-supplied marker for a run dispatched from natural-language input. */
  naturalLanguageDispatch?: boolean;
  /** Terminal execution-record writer. The production default appends to the goal file; tests inject a collector. */
  writeGoalExecutionRecord?: GoalExecutionRecordWriter;
  /** Additive SQLite execution-record writer. The production default persists to goal-runs.db; tests inject a collector or failure. */
  writeGoalRunRecord?: GoalRunRecordWriter;
  /** Explicit human delivery surface for pre-launch authored clarification escalation. */
  clarificationDelivery?: Exclude<HitlDelivery, 'all'>;
  /** Number of prior automatic hard-cap salvages in this run lineage (maximum one). */
  salvageAttempt?: number;
  /** PR draft 여부. 기본 true(안전). */
  draft?: boolean;
  /** 브랜치명. 생략 시 feature 에서 자동 생성. */
  branchName?: string;
  /** ★ Fix A(2026-07-21) — gate 실패 시 clean gate 에러를 goal-loop 에 재주입해 self-heal 하는 rework 최대 라운드.
   *  구조 근본: goal-loop 은 타입에러에 눈이 멀어(bun test 타입-블라인드·Lsp diagnostics 없음·tsc baseline
   *  노이즈) 첫 패스에서 미완성 코드를 낼 수 있다(F1 실측: refFacts 소비만·미정의→거짓 green). gate 의 clean
   *  scoped 에러(changedFileTypecheck)를 되먹여 고칠 기회를 준다. 0=rework 없음(종전 단발). 기본 2. */
  maxReworkRounds?: number;
  /**
   * Require durable goal/code/test artifacts before a successful gate may leave
   * the bounded rework loop. Opt-in preserves legacy goal-file fixtures while
   * harness-owned autonomous children can make output delivery mandatory.
   */
  requireOutputArtifacts?: boolean;
  /** rework 종료 판정의 그림자 실행 override. 미지정 시 user-config 기본값(ON)을 따른다. */
  reworkBudgetShadowStop?: boolean;
  /** Existing dev-pipeline completion contract, preserved without collapsing its four values into autoMerge. */
  completion?: 'worktree-only' | 'pr' | 'auto-merge' | 'unmanned';
  /** ★ auto-merge(2026-07-21·대표 확정 `--auto-merge`) — 내부 리뷰가 clean(verdict≠fail)이면 PR 을 자동
   *  병합(squash). 기본 false = HITL(draft PR·대표 승인 후 병합). **must-fix 있으면 무시**(항상 hold).
   *  outward-facing(main 병합)이라 명시 opt-in 만. mergePr seam 이 있어야 실제 병합(없으면 non-draft PR 까지).
   *  completion이 없던 기존 호출자의 호환 입력으로 유지한다. */
  autoMerge?: boolean;
  /** Pod-only: stop after passing the same merge guards, leaving the ready PR for host regate. */
  mergeByHost?: boolean;
  /** ★ G8 자기판단(2026-07-23·[[ROADMAP-elanous-is-all-pty-unified-autonomy-2026-07-21]] §2b) — PR 을 열 때
   *  `auto-review` opt-in 라벨을 붙일지. **2단 게이트**: 이 플래그(사람 옵트인) AND assessAutonomyEligibility
   *  (작업 위험도 자기판단·fail-safe) 통과여야 부착. 부적합(외부배포·실주문·설계분기·파괴·보안·리뷰 must-fix)이면
   *  플래그 있어도 안 붙이고 사유를 관측+PR 코멘트로. 붙으면 L3 폴러(pr-review-watch)가 이후 리뷰를 무인 완결. */
  autoReview?: boolean;
  /** --observe-only: child boot부터 SelfImplement 호출을 기록만 하고 실행하지 않는다. */
  observeOnly?: boolean;
  /** Test seam for the merge-decision signal press. Production uses the filesystem and pressDecisionSignals. */
  decisionSignalPressSources?: DecisionSignalPressSources;
  /** ★ B 근본수리(2026-07-21·6h 좀비 실측) — 파이프라인 각 자율 단계의 wall-clock 상한(ms). 무가드
   *  단계(gate·review·mergeMain·openPr 의 LLM/subprocess/network 호출)가 hang 하면 전체가 무한대기=좀비.
   *  단계별 타임아웃으로 "반드시 return"을 보장(CLI 는 실패 stage 에 process.exit → hung op 도 프로세스와 함께 종료).
   *  부분 override 가능·미지정 시 DEFAULT_STEP_TIMEOUTS. HITL(approvePr)은 사람 대기라 가드 대상 아님(제외). */
  stepTimeouts?: Partial<StepTimeouts>;
  seams: SelfImplementSeams;
}

/** 자율 단계별 wall-clock 상한(ms). 정상 소요를 넉넉히 넘겨 잡아 false-trigger 회피·6h 급 hang 만 포착. */
export interface StepTimeouts {
  worktree: number;
  implement: number;
  gate: number;
  review: number;
  merge: number;
  pr: number;
  decomposition: number;
}

/** 기본 상한 — 정상 최대치 + 버퍼(legit 느린 단계는 안 자르고, 무한 hang 만 끊음). */
export const DEFAULT_STEP_TIMEOUTS: StepTimeouts = {
  worktree: 90_000,
  // 대표 결정(2026-09-14): astra 도입 등 긴 구현을 위해 2시간까지 허용한다.
  implement: 7_200_000,
  gate: 900_000,
  review: 480_000,
  merge: 480_000,
  pr: 300_000,
  decomposition: 30_000,
};

/**
 * Ephemeral loop TTL must cover the orchestrator's worst-case wall clock:
 * setup/terminal steps once, and implement→gate→review for the initial pass
 * plus every permitted rework round. The effective per-step values include
 * caller overrides so the registry ceiling matches the run it describes.
 */
export function loopTtlMin(opts: Pick<SelfImplementOptions, 'maxReworkRounds' | 'stepTimeouts'>): number {
  const timeout = { ...DEFAULT_STEP_TIMEOUTS, ...(opts.stepTimeouts ?? {}) };
  const rounds = Math.max(0, opts.maxReworkRounds ?? 2) + 1;
  const setupAndTerminal = timeout.worktree + timeout.decomposition + timeout.merge + timeout.pr;
  const perRound = timeout.implement + timeout.gate + timeout.review;
  return Math.ceil((setupAndTerminal + (rounds * perRound)) / 60_000);
}

/** 단계 타임아웃 에러 — 어느 단계가 상한 초과했나 실어 관측·조정에 쓴다. */
export class StepTimeoutError extends Error {
  constructor(public readonly step: keyof StepTimeouts, public readonly ms: number) {
    super(`self-implement step '${step}' exceeded ${ms}ms wall-clock`);
    this.name = 'StepTimeoutError';
  }
}

/** seam 호출을 wall-clock 상한으로 감싼다 — 초과 시 StepTimeoutError throw(내부 op 은 취소 못 하나,
 *  호출자가 return→process.exit 하면 프로세스와 함께 종료). 구현 단계는 같은 프로세스 재발사에 대비해 별도 abort 한다. 정상 완료면 그 값 그대로. */
export function withStepTimeout<T>(p: Promise<T>, ms: number, step: keyof StepTimeouts): Promise<T> {
  if (!(ms > 0)) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(step, ms)), ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Parser-supported child guidance marker emitted by the eligible review-rework prompt. */
export function buildRefutationGuidance(): string {
  return `반론 검토 결과를 반드시 제출하라: 있으면 위 REFUTE 형식으로 회부하고, 없으면 한 줄로 \`${MUST_FIX_REFUTATION_ACKNOWLEDGEMENT_WITH_REASON}\` 형태의 구체적 판단 이유를 남겨라. ${REFUTATION_QUOTE_GRAMMAR} 같은 라운드의 기계 관측에 해당 finding의 missing cited path가 있으면 골 줄 대신 ${JSON.stringify(MISSING_CITED_PATH_REFUTATION_QUOTE)}를 인용할 수 있다. 같은 라운드의 기계 관측에 해당 finding의 found cited symbol이 있으면 골 줄 대신 ${JSON.stringify(FOUND_CITED_PATH_REFUTATION_QUOTE)}를 인용할 수 있다.`;
}

export type { SelfImplementStage } from './run-status-mapping.js';

export interface SelfImplementResult {
  /** ⭐ 이 시도가 «어떻게 걸었나» — 노드 진입 순서. 호출부가 `onNodeEntry` 를 주면 채워진다.
   *  🩸 2026-09-08 이전: 걸음이 런 «안»에서 끝나 런 슈퍼바이저가 「요약 판정」만 봤다.
   *  ⛔ 비어 있으면 «싣지 않는다» — 「안 걸었다」와 「관측을 안 붙였다」를 같은 값으로 두지 않기 위해서다. */
  walk?: readonly { node: string; round: number }[];
  /** Canonical run-identity join key; always present because resolveRunIdentity always mints or inherits one. */
  runId: string;
  ok: boolean;
  stage: SelfImplementStage;
  /** Pipeline node that produced this terminal result. */
  node: PipelineNodeId;
  /** Structured terminal disposition for every normal run exit. */
  outcome: RunOutcome;
  /** Normal completion contract: ordinary and reflected convergence are both successful, with distinct dispositions. */
  completionStatus?: 'completed' | 'review-reflect-converged';
  /**
   * ⭐ 「요구된 증거를 몇 개 충족했나」 — 원장으로 «나르기 위한» 칸.
   * 📍 왜 결과에 싣나: 이 값은 `runSelfImplementInner` 안에서 계산되는데
   *   원장 기록은 «바깥» `runSelfImplement` 의 콜백이 쓴다 — 두 함수가 다르다.
   *   ⇒ 그래서 스코프를 넓히는 대신 ***결과에 실어 나른다***(무동작 변경).
   * ⛔ 측정하지 «못한» 런에는 이 칸이 «없다» — 0 으로 채우지 않는다.
   */
  evidenceCoverageSummary?: { required: number; covered: number; uncovered: number };
  /** The exact merge-decision signal press, present only when this run pressed declared signals. */
  decisionSignalPress?: DecisionSignalPressResult;
  /** Present when must-fix reflection ran; preserves zero rejections separately from no reflection. */
  reviewReflectRejectedCount?: number;
  /** Present only when the hard cap prevented the final EXTEND from being applied. */
  supervisorWantedContinue?: true;
  /** Additive hard-cap disposition; outcome remains the stable public terminal contract. */
  salvage?: 'launched' | 'parked';
  /** Rework stopped on exclusively baseline/flaky/precondition failures; do not retry this goal against the same base. */
  terminationReason?: 'blocked-by-baseline';
  sessionId?: string;
  worktreePath?: string;
  branch?: string;
  gate?: SelfImplementGateResult;
  review?: SelfImplementReview;
  completionDisposition?: SelfImplementCompletionDisposition;
  /** Explicit supervisor rework verdict retained independently of workflow execution verdicts. */
  supervisorVerdict?: ReworkBudgetVerdict;
  /** First nonempty REASON line from the raw supervisor rework-budget response. */
  supervisorReason?: string;
  /** A structured decomposer observed multiple goal pieces; this remains a candidate, not a defect assertion. */
  goalCauseObserved?: true;
  /** Structured provider failures observed during this attempt; absent when none were observed. */
  providerErrors?: { count: number; provider: string; category: 'quota' | 'credential' | 'request' | 'other' };
  /** Derived from observed run signals plus an explicit supervisor contract-conflict verdict when present. */
  abandonedClassification?: AbandonedClassificationResult;
  /**
   * 자식이 인용한 것이 «실재한다»는 관측. 분류기는 이 값을 추론하지 않고 받아 쓴다.
   * ⛔ 인용을 내는 경로는 바꾸지 않는다 — 이 칸은 그 결과만 나른다.
   */
  citedEvidenceExists?: true;
  /** Account-rotation authority evidence used for the abandoned quota assessment. */
  quotaExhaustionAssessment?: QuotaExhaustionAssessment;
  /** Automatic merge was authorized before this run reached its terminal result. */
  mergeApprovalReceived?: true;
  merged?: boolean;
  /** Observed PR base for a confirmed merge; never inferred from the requested launch base. */
  mergedBase?: string;
  /** Review-budget acceptance retains these named must-fix findings as follow-up work. */
  followUpMustFix?: readonly string[];
  /** Count of named must-fix findings retained by a review-budget acceptance. */
  followUpMustFixCount?: number;
  /** auto-merge 가 «안 일어난» 이유. ⛔ 「armed 가 아닐 때만」이 아니다 —
   *  armed 였는데 «집행 직전»에 막힌 경우도 담는다(가드·삭제 임계·병합 시도 실패).
   *  ⇒ 이 필드가 비어 있으면 사람이 보는 마지막 줄이 «침묵»한다는 것이 이 필드의 존재 이유다. */
  mergeReason?: string;
  prUrl?: string;
  prNumber?: number;
  checkedHeadCommit?: string;
  detail?: string;
}

export const MAX_DIFF_EVIDENCE_CHARS = 16_000;

function addedDiffEvidence(diff: string): { text: string; truncated: boolean } {
  const added = diff.split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .filter((line) => /^(?:EVIDENCE|RESULT):/.test(line))
    .join('\n');
  return {
    text: added.slice(0, MAX_DIFF_EVIDENCE_CHARS),
    truncated: added.length > MAX_DIFF_EVIDENCE_CHARS,
  };
}

function isRepositoryRelativePath(candidate: string): boolean {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[\\/]|[A-Za-z]:[\\/])/.test(candidate)) return false;
  const parts = candidate.split('/');
  return parts.length > 1
    && parts.every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))
    && /\.[A-Za-z0-9]+$/.test(parts.at(-1)!);
}

function extractRepositoryRelativePaths(first: string): string[] {
  const candidates = first.split(/[\s,;()[\]{}"'`<>]+/).filter(Boolean);
  return candidates.filter(isRepositoryRelativePath);
}

function parseAskMarkdownH1(feature: string): string | undefined {
  // ⛔ 펜스는 «문자»만이 아니라 «길이»로 닫힌다(CommonMark): 닫는 줄은 같은 문자 · 여는 줄 이상의 길이 · 뒤에 정보 문자열 없음.
  //   🩸 2026-09-23(#20050 착지 직후 실물): GOAL 문서가 원래 ask 를 ```` 네 개 펜스로 싸고, 그 안에 ``` 블록이 있다.
  //   문자만 보면 안쪽 ``` 이 바깥 ```` 를 «닫아» 안팎이 뒤집히고 ```bash 안의 `# 주석` 이 다시 제목이 됐다.
  let fence: { marker: '`' | '~'; run: number } | undefined;
  for (const line of feature.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = trimmed[0] === '`' || trimmed[0] === '~' ? trimmed[0] : undefined;
    let run = 0;
    if (marker) {
      while (run < trimmed.length && trimmed[run] === marker) run += 1;
    }
    if (marker && run >= 3) {
      if (!fence) {
        fence = { marker, run };
        continue;
      }
      if (fence.marker === marker && run >= fence.run && trimmed.slice(run).trim() === '') {
        fence = undefined;
        continue;
      }
    }
    if (fence) continue;
    if (line[0] !== '#' || line[1] === '#') continue;
    if (line.length < 2 || !/\s/.test(line[1]!)) continue;
    const text = line.slice(1).trim();
    if (text) return text;
  }
  return undefined;
}

function prTitleCodePointCount(text: string): number {
  return Array.from(text).length;
}

function truncatePrTitle(text: string): string {
  const points = Array.from(text);
  return points.length <= 72 ? text : `${points.slice(0, 69).join('')}...`;
}

export function prTitle(feature: string): string {
  const proseTitle = parseAskProseTitle(feature);
  if (proseTitle) return truncatePrTitle(proseTitle);

  const headingTitle = parseAskMarkdownH1(feature);
  if (headingTitle) return truncatePrTitle(headingTitle);

  // ⛔ GOAL 문서는 원래 ask 를 `Original ask (verbatim, unmodified):` 아래 ```` 펜스로 싣는다 — 그 안은 «코드»가 아니라 인용된 마크다운이다.
  //   🩸 2026-09-23: #20051 이 펜스를 길이로 닫게 고치자 그 인용 블록 안의 H1 까지 «건너뛰어»,
  //   첫 줄이 `대상 경로:` 인 GOAL 문서 대부분이 경로 요약 제목으로 떨어졌다(실물: #20055 `src/self-implement: gate-baseline.ts, …`).
  //   ⇒ 인용된 ask 를 꺼내 그 «안»에서 같은 규칙(제목: 줄 → 펜스 밖 H1)으로 한 번 더 찾는다.
  //   ⚠️ 정보 문자열이 붙은 펜스(```bash 등)로 싸였으면 그 안은 «코드»다 — 인용된 마크다운으로 보지 않는다.
  const verbatim = extractVerbatimOriginalAsk(feature);
  const opener = verbatim?.range ? feature.slice(0, verbatim.range.start).split(/\r?\n/).filter((line, i, all) => i === all.length - 2)[0] ?? '' : '';
  const verbatimAsk = verbatim && /^\s*(`{3,}|~{3,})\s*$/.test(opener) ? verbatim.ask : undefined;
  if (verbatimAsk) {
    const askTitle = parseAskProseTitle(verbatimAsk) ?? parseAskMarkdownH1(verbatimAsk);
    if (askTitle) return truncatePrTitle(askTitle);
  }

  const first = feature.split('\n')[0]!.trim();
  const paths = extractRepositoryRelativePaths(first);
  if (!paths.length) return truncatePrTitle(first);

  const pathParts = paths.map((path) => path.split('/'));
  const commonParts: string[] = [];
  for (let index = 0; index < pathParts[0]!.length - 1; index++) {
    const part = pathParts[0]![index]!;
    if (!pathParts.every((parts) => parts[index] === part)) break;
    commonParts.push(part);
  }
  const fileNames = pathParts.map((parts) => parts.at(-1)!);
  const directoryPrefix = commonParts.length ? `${commonParts.join('/')}: ` : '';
  const titlePrefix = prTitleCodePointCount(directoryPrefix) + prTitleCodePointCount(fileNames[0]!) <= 72 ? directoryPrefix : '';
  const title = fileNames.reduce((result, fileName) => {
    const next = result ? `${result}, ${fileName}` : fileName;
    return prTitleCodePointCount(titlePrefix) + prTitleCodePointCount(next) <= 72 ? next : result;
  }, '');
  if (title) return `${titlePrefix}${title}`;
  const firstFileName = fileNames[0]!;
  return truncatePrTitle(firstFileName);
}

const BLOCKED_DRAFT_PR_HUMAN_JUDGMENT_ANCHOR = '## 사람 판단 필요';

/** 사람이 읽는 중단 사유 상한. 관측 `reason.slice(0, 240)` 과 같은 길이라 표시가 앞부분을 버리지 않는다. */
export const IMPLEMENT_ABORT_REASON_MAX_CHARS = 240;

/** GitHub PR 본문 상한. 제목·고정 문구·사유·참조를 포함한 최종 본문 전체에 적용한다. */
export const GITHUB_PR_BODY_MAX_CHARS = 65_536;

/** 런 시작 관측의 feature 가 읽기 쉬운 상태로 남는 상한. */
export const RUN_START_FEATURE_MAX_CHARS = 120;

type ImplementAbortArtifactOccurrence = {
  readonly round: number;
  readonly stage: 'review-blocked' | 'gate-failed' | 'aborted';
};

export type ImplementAbortArtifactInput = {
  readonly origin: string;
  readonly runId: string;
  readonly childSummary: string;
  readonly childSummaryChars: number;
  readonly reason: string;
  readonly reasonTruncated: boolean;
} & ImplementAbortArtifactOccurrence;

type ImplementAbortRecord = {
  readonly reason: string;
  readonly childSummary: string;
  readonly reasonTruncated: boolean;
  readonly childSummaryChars: number;
  readonly failureKind: Exclude<ReturnType<typeof classifyReviewProviderFailure>, 'other'> | null;
  readonly terminalStatus?: ImplementTerminalStatus;
};

type ChildSummaryArtifactRef = {
  readonly path: string;
  readonly chars: number;
};

function truncationMarkerCandidates(originalChars: number): readonly string[] {
  return [
    ` [truncated; originalChars=${originalChars}]`,
    `[truncated; originalChars=${originalChars}]`,
    '[truncated]',
    '…',
  ];
}

/** 길면 머리를 남기고 잘림을 값에 적는다. 반환 길이는 모든 입력에서 `maxChars` 이하다. */
export function boundReadableText(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text.length;
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (originalChars <= limit) return { text, truncated: false, originalChars };
  if (limit === 0) return { text: '', truncated: true, originalChars };
  const marker = truncationMarkerCandidates(originalChars).find((candidate) => candidate.length <= limit) ?? '';
  return { text: `${text.slice(0, limit - marker.length)}${marker}`, truncated: true, originalChars };
}

const IMPLEMENT_ABORT_PROGRESS_BASE = '중단 — 구현 실패';
const IMPLEMENT_ABORT_PROGRESS_NO_TOOL_CALLS = '중단 — 구현 실패: 자식이 도구를 한 번도 부르지 않았다 (구현 이전에 죽었다)';
const IMPLEMENT_ABORT_PROGRESS_SUMMARY_MAX = 120;

function clipImplementAbortReasonSummary(summary: string): string {
  // ⛔ **코드 포인트로 센다**(`R-CLM16`) — `.length`/`.slice` 는 UTF-16 «코드 «단위»»라
  //   이모지(서로게이트 쌍)를 «반으로 쪼갠다». 이 저장소의 중단 사유는 이모지를 자주 담는다.
  //   📏 실측 2026-08-27: `'🅣'.repeat(200)` 을 `.slice(0,117)` 하면 꼬리에 짝 잃은 `\ud83c` 가 남는다.
  //   ⇒ 화면·로그에 깨진 글리프가 찍힌다. 같은 저장소의 `truncatePreviousLandingSubject` 도 이 꼴이다.
  const points = Array.from(summary);
  return points.length > IMPLEMENT_ABORT_PROGRESS_SUMMARY_MAX
    ? `${points.slice(0, IMPLEMENT_ABORT_PROGRESS_SUMMARY_MAX - 3).join('')}...`
    : summary;
}

function firstImplementAbortReasonLine(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '') return '';
  const firstLine = reason.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.trim().replace(/[ \t]+/g, ' ');
}

/** 사람이 보는 구현 중단 진행 줄. 사유가 있으면 첫 줄만 붙이고, 120자를 넘으면 앞 117자와 `...` 이다.
 *  `toolCalls === 0` 이면 도구를 안 부른 사실을 앞세우고, 고정 문구는 상한 계산에서 뺀다. */
export function formatImplementAbortProgressLine(reason: string | undefined, toolCalls?: number): string {
  const summary = firstImplementAbortReasonLine(reason);
  if (toolCalls === 0) {
    if (summary === '') return IMPLEMENT_ABORT_PROGRESS_NO_TOOL_CALLS;
    return `${IMPLEMENT_ABORT_PROGRESS_NO_TOOL_CALLS} · ${clipImplementAbortReasonSummary(summary)}`;
  }
  if (summary === '') return IMPLEMENT_ABORT_PROGRESS_BASE;
  return `${IMPLEMENT_ABORT_PROGRESS_BASE}: ${clipImplementAbortReasonSummary(summary)}`;
}

/**
 * 구현 중단 산출 — 「왜 멈췄나」와 자식 요약 전문을 다른 값으로 가른다.
 * 사유는 읽기 가능한 상한 안에 두고, 상한을 넘기면 잘렸다는 사실을 사유 값에 남긴다.
 * 자식 요약 전문은 사유에 다시 섞지 않는다.
 */
export function buildImplementAbortRecord(childSummary: string, terminalStatus?: ImplementTerminalStatus): ImplementAbortRecord {
  const prefix = 'implement aborted';
  const trimmed = childSummary.trim();
  const unboundedReason = trimmed ? `${prefix}: ${trimmed}` : prefix;
  const bounded = boundReadableText(unboundedReason, IMPLEMENT_ABORT_REASON_MAX_CHARS);
  const classifiedFailure = classifyReviewProviderFailure(childSummary);
  return {
    reason: bounded.text,
    childSummary,
    reasonTruncated: bounded.truncated,
    childSummaryChars: childSummary.length,
    failureKind: classifiedFailure === 'other' ? null : classifiedFailure,
    ...(terminalStatus ? { terminalStatus } : {}),
  };
}

/** Persist the implement-abort child summary as its own artifact field — never mixed into the PR reason or body. */
export function persistImplementAbortChildSummary(
  persist: ((input: ImplementAbortArtifactInput) => { path: string }) | undefined,
  input: ImplementAbortArtifactInput,
): ChildSummaryArtifactRef {
  const persistFn = persist ?? ((item) => createArtifactStore().put('block', item.childSummary, {
    origin: item.origin,
    producer: 'implement-abort',
    tags: ['child-summary', 'full-output'],
    description: `implement-abort child summary (${item.childSummaryChars} chars)`,
    extra: {
      runId: item.runId,
      reason: item.reason,
      reasonTruncated: item.reasonTruncated,
      childSummaryChars: item.childSummaryChars,
      round: item.round,
      stage: item.stage,
    },
  }));
  return { path: persistFn(input).path, chars: input.childSummaryChars };
}

function childSummaryPointer(artifact: ChildSummaryArtifactRef): string {
  return `(자식 요약 전문은 영속 산출물에 보존 — ${artifact.path})`;
}

/** Canonical filesystem path, or undefined when the path cannot be resolved. */
function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** True when `target` is a descendant of `root` (not `root` itself, not an escape). */
function isInsideRepository(root: string, target: string): boolean {
  const result = relative(root, target);
  return Boolean(result) && result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result);
}

/** Nearest directory that contains a `.git` entry, walking up from `start`. */
function gitRootOf(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** True when a `.git` file or directory sits strictly between `root` and `target`. */
function hasNestedGitBetween(root: string, target: string): boolean {
  let dir = resolve(target);
  const resolvedRoot = resolve(root);
  while (dir !== resolvedRoot) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = resolve(dir, '..');
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * PR 본문에 실을 골 파일 경로.
 * 입력 경로와 현재 저장소 뿌리를 realpath 로 canonicalize 한 뒤, 그 canonical
 * 경로로 containment 와 중첩 Git 경계를 판정한다. 현재 저장소 소속일 때만
 * 뿌리부터의 상대 경로(`/` 구분)를 쓴다. 밖·다른 Git 저장소·중첩 저장소·
 * 내부 symlink 가 외부를 가리키는 경우·뿌리를 모르면 원문을 유지한다 —
 * 「모른다」를 `docs/…` 로 꾸미지 않는다.
 */
function formatGoalFileForPrBody(goalFile: string, cwd = process.cwd()): string {
  const root = gitRootOf(cwd);
  if (!root) return goalFile;
  const canonicalRoot = canonicalPath(root);
  const canonicalGoal = canonicalPath(resolve(cwd, goalFile));
  if (!canonicalRoot || !canonicalGoal) return goalFile;
  if (!isInsideRepository(canonicalRoot, canonicalGoal)) return goalFile;
  if (hasNestedGitBetween(canonicalRoot, canonicalGoal)) return goalFile;
  return relative(canonicalRoot, canonicalGoal).split(sep).join('/');
}

export class MergedReleaseNoteWriteError extends Error {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly directory: string;
  readonly fragment: ReleaseNoteFragment;

  constructor(prUrl: string, directory: string, fragment: ReleaseNoteFragment, cause: unknown) {
    super(`PR #${fragment.pr} was merged, but its release note could not be written to ${directory}: ${safeErrorDescription(cause)}`, { cause });
    this.name = 'MergedReleaseNoteWriteError';
    this.prNumber = fragment.pr;
    this.prUrl = prUrl;
    this.directory = directory;
    this.fragment = fragment;
  }
}

function goalDocumentForReleaseNote(goalFile?: string): string {
  if (!goalFile) return '';
  try { return readFileSync(goalFile, 'utf8'); }
  catch { return ''; }
}

function shardReleaseNote(feature: string): ReleaseNoteSection | undefined {
  const matches = [...feature.matchAll(/^## Shard identity\r?\n([^\r\n]+)/gm)];
  const identity = matches.at(-1)?.[1];
  if (!identity) return undefined;
  try {
    const value: unknown = JSON.parse(identity);
    if (!value || typeof value !== 'object' || !('releaseNote' in value)) return undefined;
    const note = (value as { releaseNote: unknown }).releaseNote;
    if (!note || typeof note !== 'object' || Array.isArray(note)) return undefined;
    const candidate = note as Record<string, unknown>;
    if (typeof candidate.line !== 'string' || typeof candidate.kind !== 'string'
      || typeof candidate.target !== 'string' || !candidate.docs || typeof candidate.docs !== 'object') return undefined;
    const doc = candidate.docs as Record<string, unknown>;
    if (typeof doc.path !== 'string' && typeof doc.none !== 'string') return undefined;
    const section = `## 릴리스 노트\n- 한 줄: ${candidate.line}\n- 종류: ${candidate.kind}\n- 문서: ${typeof doc.path === 'string' ? doc.path : `없음(${doc.none})`}\n- 대상: ${candidate.target}\n`;
    return parseReleaseNoteSection(section).fragment;
  } catch { return undefined; }
}

function releaseNoteForRun(goalFile: string | undefined, feature: string): ReleaseNoteSection {
  const note = goalFile ? undefined : shardReleaseNote(feature);
  if (note) return note;
  const shard = !goalFile && feature.includes('## Shard identity');
  return harnessReleaseNote(goalDocumentForReleaseNote(goalFile), prTitle(feature), shard);
}

/** GATE-CALLERS (OP 10-03): caller tests that exceeded the gate cap must stay visible in the PR body even when the gate log is cut. */
export function exposeGateLines(gateLog?: string): string[] {
  return (gateLog ?? '').split('\n').filter((line) => line.startsWith('[expose]'));
}

export function gateNotRunSection(gateLog?: string): string[] {
  const lines = (gateLog ?? '').split('\n').filter((line) => line.startsWith('⚠️ caller test cap exceeded'));
  return lines.length ? ['', '## Gate · 안 돈 소비자 시험(상한 초과)', ...lines.map((line) => `- ${line.replace(/^⚠️ caller test cap exceeded — not run: /, '')}`)] : [];
}

function prBody(feature: string, implSummary: string, gateLog?: string, review?: SelfImplementReview, reviewIntent?: string, autoReviewDeclineReasons?: readonly string[], evidence?: string, goalFile?: string, planRevision?: ReworkPlanRevision, releaseNote?: ReturnType<typeof harnessReleaseNote>, revertGuard?: RevertGuardResult): string {
  const note = releaseNote ?? releaseNoteForRun(goalFile, feature);
  const relaxation = planRevision?.relaxation
    ? ['', '## 감독 수용 기준 완화', `- 대상: ${planRevision.relaxation.target}`, `- 이전: ${planRevision.relaxation.expected}`, `- 완화: ${planRevision.relaxation.replacement}`, `- 이유: ${planRevision.reason}`, `- 적용: ${planRevision.application?.status ?? 'failed'}${planRevision.application?.detail ? ` (${planRevision.application.detail})` : ''}`, ...(planRevision.disposition ? [`- 충돌 처분: ${planRevision.disposition}`] : [])]
    : [];
  return [
    '## 요청',
    ...(goalFile ? [`- 골 파일: ${formatGoalFileForPrBody(goalFile)}`] : []),
    feature.trim(),
    '',
    '## 구현 요약',
    implSummary.trim() || '(요약 없음)',
    '',
    renderReleaseNoteSection(note).trimEnd(),
    // ★ I-9 — 성공 경로도 수확본을 싣는다. blocked 쪽만 실으면 **통과한 PR 에서 증거가 사라진다**.
    ...(evidence ? ['', '## 자식이 남긴 증거 (EVIDENCE/RESULT · 화면 전체에서 수확)', '```', evidence, '```'] : []),
    ...(reviewIntent ? ['', '## 리뷰 intent', reviewIntent] : []),
    ...(review ? ['', `## 내부 리뷰 — ${review.verdict}`, review.summary.trim().slice(0, 1500),
      ...(review.shouldFix.length ? ['', '**should-fix (비블로킹):**', ...review.shouldFix.slice(0, 8).map((f) => `- ${f}`)] : [])] : []),
    ...(autoReviewDeclineReasons?.length ? ['', '## Auto-review label not applied', 'The requested auto-review label was declined by the autonomy gate:', ...autoReviewDeclineReasons.map((reason) => `- ${reason}`)] : []),
    ...gateNotRunSection(gateLog),
    ...(gateLog || revertGuard ? ['', '## Gate',
      // 경고는 잘린 gate 로그의 코드블록 밖에서도 한눈에 보인다.
      ...((gateLog ?? '').split('\n').filter((line) => line.startsWith('⚠️ 동작 검증 0:'))),
      ...exposeGateLines(gateLog),
      ...(gateLog ? ['```', gateLog.trim().slice(0, 3000), '```'] : []),
      ...(revertGuard?.reverted.length ? [`- 되돌림 방지: ${revertGuard.reverted.length}파일 제외`] : []),
      ...(revertGuard?.protected.length ? [`- 되돌림 경고: 대상 경로 ${revertGuard.protected.length}파일 유지 (${revertGuard.protected.join(', ')})`] : []),
      ...(revertGuard?.warning ? [`- 되돌림 검사 실패(커밋 계속): ${revertGuard.warning}`] : [])] : []),
    ...relaxation,
    '',
    '🤖 self-implement 오케스트레이터 (elanous 자율 구현·리뷰-게이트 병합)',
  ].join('\n');
}

/**
 * PR 근거 아티팩트의 일곱 축을 이 런의 «실제 사실»에서 모은다.
 *
 * ⭐ 계획 · 위험 · 대안 · 판정 신호는 **골 문서에 이미 있다** — 새로 지어내지 않고 그 문면을 옮긴다
 *   (`## Answer` · `## 불변식` · `## 경계` ⊕ `⛔ 막힌 길` · `판정 신호:`). 그래서 골을 제대로 쓴
 *   런은 이 관문을 «실제로» 통과할 수 있고, 안 쓴 런은 무엇이 빠졌는지 이름으로 듣는다.
 * ⛔ 골 파일을 못 읽으면 그 축들은 «빈 채로» 둔다 — 「모른다」를 값으로 꾸미지 않는다(fail-soft).
 */
function collectPrEvidence(input: {
  feature: string;
  goalFile?: string;
  implSummary: string;
  gate: SelfImplementGateResult;
  review?: SelfImplementReview;
  runId: string;
  stage: string;
  branch: string;
  rounds: number;
  mergeReason?: string;
  provider?: string;
  planRevision?: ReworkPlanRevision;
}): PrEvidenceInput {
  let goalDocument = '';
  if (input.goalFile) {
    try {
      goalDocument = readFileSync(input.goalFile, 'utf8');
    } catch {
      goalDocument = '';  // fail-soft — 못 읽으면 그 축은 비고, 관문이 그 사실을 이름으로 낸다.
    }
  }
  const extracted = extractGoalDocumentEvidence(goalDocument);
  // 구현 요약은 계획의 «첫 줄»이 아니라 «실제로 밟은 것»이다 — 골의 Answer 앞에 둔다.
  const implSteps = input.implSummary.split(/\r?\n/).map((line) => line.replace(/^[-*\d.)\s]+/u, '').trim()).filter(Boolean);
  const testRuns = parseGateLogTestRuns(input.gate.log);
  return {
    goal: {
      ...(input.goalFile ? { goalFile: formatGoalFileForPrBody(input.goalFile) } : {}),
      objective: input.feature,
      decisionSignals: extracted.decisionSignals,
    },
    plan: {
      steps: [...extracted.steps, ...implSteps.slice(0, 6)],
      ...(input.planRevision?.relaxation ? {
        revision: {
          reason: input.planRevision.reason,
          target: input.planRevision.relaxation.target,
          from: input.planRevision.relaxation.expected,
          to: input.planRevision.relaxation.replacement,
        },
      } : {}),
    },
    ledger: {
      runId: input.runId,
      stage: input.stage,
      node: 'open-pr',
      branch: input.branch,
      rounds: input.rounds,
      ...(input.mergeReason ? { mergeReason: input.mergeReason } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    },
    ...(input.review ? {
      critique: {
        reviewed: !!input.review.reviewed,
        verdict: input.review.verdict,
        summary: input.review.summary,
        mustFix: input.review.mustFix ?? [],
        shouldFix: input.review.shouldFix ?? [],
      },
    } : {}),
    tests: {
      // 게이트 로그에서 명령을 못 뽑으면 게이트 자체를 «한 줄»로 싣는다 — 「돌았다」는 사실은 있다.
      runs: testRuns.length ? testRuns : [{ command: 'elanous self gate (변경 파일 범위)', detail: input.gate.passed ? 'passed' : 'failed' }],
      ...(input.gate.log ? { gateLog: input.gate.log } : {}),
    },
    risks: extracted.risks,
    alternatives: extracted.alternatives,
  };
}

type TerminalDecomposition = {
  shadow: ReturnType<typeof inferDecompositionShadow>;
  source: 'structured-decomposer' | 'path-count-fallback';
  pieces?: Array<{ id: string; feature: string; dependsOn: readonly string[]; goalType?: SelfDevGoalType }>;
  fallbackReason?: 'decomposer-failed' | 'decomposer-timeout' | 'no-fragments';
};

function hasMultipleStructuredTerminalPieces(decomposition: TerminalDecomposition | undefined): boolean {
  return decomposition?.source === 'structured-decomposer'
    && (decomposition.pieces?.length ?? 0) >= 2;
}

function terminalDecompositionLines(decomposition: TerminalDecomposition): string[] {
  if (decomposition.source === 'structured-decomposer') {
    return [
      `- 분해 판정 (구조화 분해기): 조각 ${decomposition.pieces!.length}개`,
      ...decomposition.pieces!.map((piece) => `  - ${piece.id} (종류: ${piece.goalType ?? '없음'}, 의존: ${piece.dependsOn.length ? piece.dependsOn.join(', ') : '없음'})`),
    ];
  }
  const fallback = decomposition.fallbackReason === 'decomposer-failed'
    ? '분해기 실패로 경로 세기로 폴백'
    : decomposition.fallbackReason === 'decomposer-timeout'
      ? '분해기 시간 초과로 경로 세기로 폴백'
      : '분해기가 조각을 내지 못해 경로 세기로 폴백';
  return [decomposition.shadow.splittable
    ? `- 분해 판정 (경로 세기 폴백): 조각 후보 ${decomposition.shadow.candidatePieceCount}개 (${decomposition.shadow.paths.join(', ')}) — ${fallback}`
    : `- 분해 판정 (경로 세기 폴백): 쪼갤 수 없음 — ${fallback}`];
}

type UndeliveredSupervisorInput = {
  readonly text: string;
  readonly reason: string;
};

type BlockedDraftPrState = {
  /** Caller-supplied: true only when salvageHardCap follows this preservation. The body does not infer it. */
  salvageStatusExpected: boolean;
  gate?: SelfImplementGateResult;
  typecheck?: { passed: boolean; log?: string };
  review?: SelfImplementReview;
  verdict?: ReworkBudgetVerdict;
  reason: string;
  rounds: number;
  evidence?: string;
  decomposition?: TerminalDecomposition;
  undeliveredSupervisorInputs: readonly UndeliveredSupervisorInput[];
  reasonTruncated?: boolean;
  childSummaryChars?: number;
  childSummaryArtifact?: ChildSummaryArtifactRef;
  terminalStatus?: ImplementTerminalStatus;
  planRevision?: ReworkPlanRevision;
  /** Classifier output for this unfinished run. Omitted means the cause was not classified. */
  abandonedClassification?: AbandonedClassificationResult;
};

const BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION = '자동 병합은 중지했습니다. 자동 후속 처리는 이 경로에서 별도로 실행될 수 있으므로, 아래 salvage 상태를 확인한 뒤 이 draft PR의 처분을 판단합니다.';
const BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION = '자동 병합은 중지했습니다. 아래 중단 사유의 verdict·reason·rework rounds를 보고 이 draft PR의 처분을 판단합니다.';

/** Named cause when classifyAbandonedRun was not run or its result was not supplied. Never a blank slot. */
export const BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION = 'unclassified';

export type BlockedDraftClassificationRecord = {
  readonly classification: string;
  readonly classificationBasis: string;
  readonly worktreeClean: boolean | null;
};

export function blockedDraftClassificationRecord(
  classification: AbandonedClassificationResult | undefined,
): BlockedDraftClassificationRecord {
  if (!classification) {
    return {
      classification: BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION,
      classificationBasis: BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION,
      worktreeClean: null,
    };
  }
  return {
    classification: classification.classification,
    classificationBasis: classification.classificationBasis,
    worktreeClean: classification.worktreeClean ?? null,
  };
}

export function formatBlockedDraftClassificationSection(
  classification: AbandonedClassificationResult | undefined,
): string[] {
  const record = blockedDraftClassificationRecord(classification);
  const human = record.classification === BLOCKED_DRAFT_UNCLASSIFIED_CLASSIFICATION
    ? `${record.classification} (분류를 못 함)`
    : record.classification;
  const worktreeCleanText = record.worktreeClean === null ? '(unknown)' : String(record.worktreeClean);
  return [
    '## 중단 원인 분류',
    `- 중단 원인: ${human}`,
    `- classification: ${record.classification}`,
    `- classificationBasis: ${record.classificationBasis}`,
    `- worktreeClean: ${worktreeCleanText}`,
    '',
    '```json',
    JSON.stringify(record),
    '```',
  ];
}

function blockedDraftPrBody(feature: string, implSummary: string, state: BlockedDraftPrState, goalFile?: string): string {
  return [
    BLOCKED_DRAFT_PR_HUMAN_JUDGMENT_ANCHOR,
    state.salvageStatusExpected
      ? BLOCKED_DRAFT_PR_SALVAGE_STATUS_INSTRUCTION
      : BLOCKED_DRAFT_PR_INTERRUPTION_REASON_INSTRUCTION,
    ...(state.decomposition ? terminalDecompositionLines(state.decomposition) : []),
    '',
    '## 중단 사유',
    `- verdict: ${state.verdict ?? '(예산 판정 미실행)'}`,
    `- reason: ${state.reason}`,
    `- rework rounds: ${state.rounds}`,
    ...(state.reasonTruncated !== undefined ? [`- reason truncated: ${state.reasonTruncated}`] : []),
    ...(state.childSummaryChars !== undefined ? [`- child summary chars: ${state.childSummaryChars}`] : []),
    ...(state.childSummaryArtifact ? [`- child summary artifact: ${state.childSummaryArtifact.path}`] : []),
    ...(state.terminalStatus ? [`- child terminal status: reached=${state.terminalStatus.reached}; changed=${state.terminalStatus.changed}; toolCalls=${state.terminalStatus.toolCalls}; timedOut=${state.terminalStatus.timedOut}`] : []),
    '',
    ...formatBlockedDraftClassificationSection(state.abandonedClassification),
    '',
    '## 미배달 감독 수리 지시',
    ...(state.undeliveredSupervisorInputs.length
      ? state.undeliveredSupervisorInputs.flatMap(({ text, reason }, index) => [
        `### 지시 ${index + 1}`,
        `- delivery: not-delivered`,
        `- reason: ${reason}`,
        text,
      ])
      : ['(없음 — 감독 수리 지시가 없었거나 모든 지시가 다음 라운드에 전달됨)']),
    '',
    // ★ I-9 — 화면 전체에서 수확한 증거. 꼬리 2000자에는 밀려서 안 실리던 것이다(RUN-T6 가 이것으로 죽었다).
    ...(state.evidence
      // ⛔ 여기서 다시 자르지 않는다 — 수확기가 이미 상한 안에서 **최신을 남기고** 잘랐다.
      //    다시 앞에서 자르면 그 최신 `RESULT` 가 날아간다(리뷰 1R must-fix).
      ? ['## 자식이 남긴 증거 (EVIDENCE/RESULT · 화면 전체에서 수확)', '```', state.evidence, '```', '']
      : ['## 자식이 남긴 증거', '(없음 — 자식이 `EVIDENCE:`/`RESULT:` 줄을 남기지 않았다)', '']),
    '## Gate',
    ...(state.gate === undefined
      ? ['(게이트 미실행)']
      : state.gate.log
        ? [...state.gate.log.split('\n').filter((line) => line.startsWith('⚠️ 동작 검증 0:')), ...exposeGateLines(state.gate.log), '```', state.gate.log.trim().slice(0, 3000), '```'] // 경고는 절단된 로그 밖에도 보존한다.
        : ['(게이트 실행됨 · 로그 없음)']),
    '',
    '## Main-sync typecheck',
    ...(state.typecheck === undefined
      ? ['(타입 재검 미실행)']
      : [`- passed: ${state.typecheck.passed}`, ...(state.typecheck.log ? ['```', state.typecheck.log.trim().slice(0, 3000), '```'] : [])]),
    ...(state.review?.mustFix.length ? ['', '## 마지막 리뷰 must-fix', ...state.review.mustFix.map((item) => `- ${item}`)] : []),
    '',
    prBody(feature, implSummary, undefined, state.review, undefined, undefined, undefined, goalFile, state.planRevision),
  ].join('\n');
}

type PreparedPrBody = {
  readonly body: string;
  readonly truncated: boolean;
  readonly originalChars: number;
};

const PR_BODY_TRUNCATION_MARKER_MAX_CHARS = 1_024;

type ChildProviderErrorQueryResult = Exclude<Awaited<ReturnType<NonNullable<SelfImplementSeams['queryChildProviderErrors']>>>, undefined>;

/** Aggregates only router-produced structured records; provider messages are never reparsed. */
export function queryStructuredChildProviderErrors(
  instances: readonly string[] | undefined,
  sinceMs: number,
  untilMs: number,
  query: (input: LogQuery) => readonly LogStoreRow[],
): ChildProviderErrorQueryResult {
  if (!instances?.length) return { status: 'unavailable', reason: 'child-instance-unavailable' };
  try {
    const rows = query({
      instances: [...instances],
      surfaces: [DEV_PIPELINE_SINK_SURFACE],
      exactCategories: ['llm.router.error'],
      sinceMs,
      untilMs,
    });
    if (rows.length === 0) return { status: 'none' };
    let credentialFailureCount = 0;
    let lastProviderError: { provider?: string; message?: string } | undefined;
    let lastCredentialFailure: { provider?: string; message?: string } | undefined;
    for (const row of rows) {
      let data: Record<string, unknown> | undefined;
      try {
        const parsed = row.data ? JSON.parse(row.data) : undefined;
        if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
      } catch { /* malformed payload is still a structured router-error record */ }
      const detail = {
        ...(typeof data?.provider === 'string' ? { provider: data.provider } : {}),
        ...(typeof data?.message === 'string' ? { message: data.message } : {}),
      };
      lastProviderError = detail;
      if (data?.authRejected === true) {
        credentialFailureCount++;
        lastCredentialFailure = detail;
      }
    }
    return { status: 'found', providerErrorCount: rows.length, credentialFailureCount, ...(lastProviderError ? { lastProviderError } : {}), ...(lastCredentialFailure ? { lastCredentialFailure } : {}) };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function persistFullPrBody(
  persist: SelfImplementSeams['persistPrBodyArtifact'] | undefined,
  input: { origin: string; body: string; originalChars: number },
): string {
  const artifact = (persist ?? ((item) => createArtifactStore().put('block', item.body, {
    origin: item.origin,
    producer: 'pr-body-boundary',
    tags: ['pr-body', 'full-output'],
    description: `full PR body (${item.originalChars} chars)`,
  })))(input);
  if (!artifact.path) throw new Error('full PR body artifact persistence returned no path');
  return artifact.path;
}

function preparePrBody(
  raw: string,
  persist: SelfImplementSeams['persistPrBodyArtifact'] | undefined,
  origin: string,
  essentialSuffix = '',
): PreparedPrBody {
  const bounded = boundReadableText(raw, GITHUB_PR_BODY_MAX_CHARS);
  if (!bounded.truncated) return { body: raw, truncated: false, originalChars: bounded.originalChars };
  const artifactPath = persistFullPrBody(persist, { origin, body: raw, originalChars: bounded.originalChars });
  const marker = `\n\n[truncated; originalChars=${bounded.originalChars}; full PR body artifact: ${artifactPath}]\n`;
  if (marker.length > PR_BODY_TRUNCATION_MARKER_MAX_CHARS || marker.length > GITHUB_PR_BODY_MAX_CHARS) {
    throw new Error(`full PR body artifact path is too long to retain a readable truncation marker (${marker.length} chars)`);
  }
  const available = GITHUB_PR_BODY_MAX_CHARS - marker.length;
  const retainedSuffix = boundReadableText(essentialSuffix, available).text;
  const prefix = essentialSuffix && raw.endsWith(essentialSuffix)
    ? raw.slice(0, raw.length - essentialSuffix.length)
    : raw;
  const retainedPrefix = prefix.slice(0, available - retainedSuffix.length);
  return { body: `${retainedPrefix}${marker}${retainedSuffix}`, truncated: true, originalChars: bounded.originalChars };
}

/** Assemble the blocked draft PR body and cap the final text at GitHub's 65,536-char limit. */
export function assembleBlockedDraftPrBody(
  feature: string,
  implSummary: string,
  state: BlockedDraftPrState,
  goalFile?: string,
  persist?: SelfImplementSeams['persistPrBodyArtifact'],
): { body: string; truncated: boolean; originalChars: number } {
  const raw = blockedDraftPrBody(feature, implSummary, state, goalFile);
  const classificationRecord = blockedDraftClassificationRecord(state.abandonedClassification);
  const essentialSuffix = [
    `- reason: ${state.reason}`,
    `- classification: ${classificationRecord.classification}`,
    JSON.stringify(classificationRecord),
    ...(state.reasonTruncated ? ['- reason truncated: true'] : []),
    ...(state.terminalStatus ? [`- child terminal status: reached=${state.terminalStatus.reached}; changed=${state.terminalStatus.changed}; toolCalls=${state.terminalStatus.toolCalls}; timedOut=${state.terminalStatus.timedOut}`] : []),
  ].join('\n');
  return preparePrBody(raw, persist, 'self-implement-blocked-draft-pr', essentialSuffix);
}

/**
 * self-implement 파이프라인. fork → worktree → implement → gate → PR(HITL) 순차.
 *
 * 종료:
 *   - pr-opened  : ✅ 전 단계 통과 + PR 생성.
 *   - aborted    : ③ 구현 실패(worktree 보존).
 *   - gate-failed: ④ gate 실패(worktree 보존·검사용).
 *   - pr-declined: ⑤ 대표 미승인(worktree 보존).
 *
 * worktree 는 실패/성공 모두 보존(정리는 caller/P3). 관측 = self-implement.*.
 */
/** Derives a deterministic, non-executing decomposition candidate from a goal. */
export function inferDecompositionShadow(goal: string): {
  splittable: boolean;
  candidatePieceCount: number;
  paths: string[];
  reason: string;
} {
  const paths = inferHotPaths(targetScopedGoalText(goal));
  const candidatePieceCount = paths.length;
  return {
    splittable: candidatePieceCount >= 2,
    candidatePieceCount,
    paths,
    reason: `${paths.length} eligible path(s) produce ${candidatePieceCount} candidate piece(s).`,
  };
}

export const DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT = 10;

/** Keeps timeout telemetry additive even if a fallback shadow is unreadable. */
export function decompositionFallbackObservation(shadow: Pick<ReturnType<typeof inferDecompositionShadow>, 'candidatePieceCount' | 'paths'>): Record<string, unknown> {
  try {
    const fallbackCandidatePieceCount = shadow.candidatePieceCount;
    const fallbackPaths = shadow.paths.slice(0, DECOMPOSITION_FALLBACK_PATHS_OBSERVATION_LIMIT);
    return {
      fallbackCandidatePieceCount,
      fallbackPaths,
      fallbackPathsTruncated: shadow.paths.length > fallbackPaths.length,
    };
  } catch {
    return {};
  }
}

/**
 * ⭐ 실행-태깅 관측기 (2026-07-26) — `self-implement` 발화에 runId 를 **자동으로** 싣는다.
 *
 * 왜: 동시에 여러 self-dev 가 돌면 로그가 한 카테고리에 섞여 어느 줄이 어느 실행인지 구분이 안 된다.
 *   실측 사건 — 같은 시간대 3개 dev 를 띄웠더니 한 실행의 실패 원인을 특정하지 못했고, **다른 실행의
 *   게이트 로그를 자기 것으로 오독**해 잘못된 결론에 도달했다. 조회가 실행을 못 가르면 관측이 있어도
 *   자기인지가 안 된다(제1원칙).
 *
 * ⚠️ `runId` 는 스프레드 **뒤**에 둔다 — 객체 리터럴은 나중 키가 이기므로, 앞에 두면 호출자
 *   `data.runId` 가 식별자를 **덮어쓴다**(리뷰 must-fix: 초판이 정확히 그 반대였다).
 *   순수 팩토리로 분리한 이유도 그 병합 규율을 **충돌을 실제로 주입해** 검증할 수 있게 하려는 것이다.
 */
export function repeatedBlockingFindingIds(
  current: readonly MustFixFinding[] | undefined,
  previous: readonly MustFixFinding[] | undefined,
): readonly string[] | undefined {
  if (!current || !previous) return undefined;
  const previousIds = new Set(previous.map(({ id }) => id));
  const repeatedIds = new Set<string>();
  return current.flatMap(({ id }) => {
    if (!previousIds.has(id) || repeatedIds.has(id)) return [];
    repeatedIds.add(id);
    return [id];
  });
}

interface ReworkBudgetRecurrenceDisagreementObservation {
  readonly recurrenceDisagreement: boolean | null;
  readonly recurrenceDisagreementKind: 'symbol-repeat-without-blocking-repeat' | 'blocking-repeat-without-symbol-repeat' | 'none' | 'unmeasured';
  readonly recurrenceDisagreementSymbolRepeatCount: number | null;
  readonly recurrenceDisagreementBlockingRepeatCount: number | null;
  readonly recurrenceDisagreementTerminalUnconvergeable: boolean | null;
}

export function reworkBudgetRecurrenceDisagreementObservation(
  repeatedBlockingIds: readonly string[] | undefined,
  recurrence: ReviewFindingRecurrence | null | undefined,
  terminalUnconvergeable: boolean,
): ReworkBudgetRecurrenceDisagreementObservation {
  const blockingRepeatCount = repeatedBlockingIds === undefined ? undefined : repeatedBlockingIds.length;
  const symbolRepeatCount = recurrence === null || recurrence === undefined
    ? undefined
    : Math.max(recurrence.citedReviewSymbolRepeatCount, recurrence.citedReviewSymbolBaseNameRepeatCount);
  if (blockingRepeatCount === undefined || symbolRepeatCount === undefined) {
    return {
      recurrenceDisagreement: null,
      recurrenceDisagreementKind: 'unmeasured',
      recurrenceDisagreementSymbolRepeatCount: symbolRepeatCount ?? null,
      recurrenceDisagreementBlockingRepeatCount: blockingRepeatCount ?? null,
      recurrenceDisagreementTerminalUnconvergeable: null,
    };
  }
  const symbolRepeated = symbolRepeatCount > 0;
  const blockingRepeated = blockingRepeatCount > 0;
  const disagrees = symbolRepeated !== blockingRepeated;
  const disagreementKind: ReworkBudgetRecurrenceDisagreementObservation['recurrenceDisagreementKind'] = !disagrees
    ? 'none'
    : symbolRepeated
      ? 'symbol-repeat-without-blocking-repeat'
      : 'blocking-repeat-without-symbol-repeat';
  return {
    recurrenceDisagreement: disagrees,
    recurrenceDisagreementKind: disagreementKind,
    recurrenceDisagreementSymbolRepeatCount: symbolRepeatCount,
    recurrenceDisagreementBlockingRepeatCount: blockingRepeatCount,
    recurrenceDisagreementTerminalUnconvergeable: terminalUnconvergeable && disagrees,
  };
}

/**
 * ⭐⭐ 연합(오케스트레이션) 키를 «관측에» 싣는 payload. ⛔ 순수 함수라 회귀가 «직접» 문다.
 *
 * 🚨 왜 필요한가 (대표 2026-08-19 *"원장은 T 세션 쪽"* · 🅢 §ⓐ§ⓑ 제보):
 *   `makeRunObserver` 는 `shardIdentity` 를 «인자로 받는데» 원장(writeLedger)에만 실었고
 *   ***로그(`log(...)`)에는 안 실었다.*** 그래서
 *     · `run-supervision.verdict` 3,000건 전수에서 orchestrationId 가 «전부 null» 이었고
 *     · 슈퍼바이저가 「형제가 어떻게 되고 있나」를 판정 축에 «넣을 수가 없었다»
 *   ⇒ 🔑 두 결손이 «같은 한 줄»에서 나왔다.
 *
 * ⛔ 기본값(`{ pieceTotal: 1 }` 단독)은 「연합 아님」이므로 «아무 칸도 만들지 않는다» —
 *   안 그러면 홀로 도는 런 전부에 pieceTotal=1 이 붙어 「연합인 척」한다(그럴듯한 값).
 */
export function federationObservation(shardIdentity: RunShardIdentity): Record<string, unknown> {
  const federated = shardIdentity.orchestrationId !== undefined
    || shardIdentity.shardId !== undefined
    || (shardIdentity.pieceTotal ?? 1) > 1;
  if (!federated) return {};
  return {
    ...(shardIdentity.orchestrationId === undefined ? {} : { orchestrationId: shardIdentity.orchestrationId }),
    ...(shardIdentity.shardId === undefined ? {} : { shardId: shardIdentity.shardId }),
    // ⛔ 배열은 6에서 잘린다 — 전체 수는 siblingShardCount 가 답한다(분모를 잃지 않는다)
    ...(shardIdentity.siblingShardIds === undefined ? {} : {
      siblingShardIds: shardIdentity.siblingShardIds.slice(0, 6),
      siblingShardCount: shardIdentity.siblingShardIds.length,
    }),
    ...(shardIdentity.pieceIndex === undefined ? {} : { shardPosition: shardIdentity.pieceIndex }),
    pieceTotal: shardIdentity.pieceTotal,
    ...(shardIdentity.shardIdentityReadFailure === undefined ? {} : { shardIdentityReadFailure: shardIdentity.shardIdentityReadFailure }),
  };
}

/**
 * ⭐ 「어디까지 가려 했나」를 값으로. ⛔ 순수 함수라 회귀가 «직접» 문다.
 *
 * ⛔ `stage`(어디까지 갔나)와 «섞지 마라» — 성공 판정은 ***intent × stage*** 로 나온다.
 *   auto-merge 의도 ⇒ `merged` 여야 성공  ·  not-auto-merge 의도 ⇒ `pr-opened` 도 성공
 */
/**
 * ⛔⭐ 왜 `pr-only` 가 «아니라» `not-auto-merge` 인가 (2026-08-19 정정):
 *   상위에는 완료 모드가 «네 값»이다 — `worktree-only` · `pr` · `auto-merge` · `unmanned`
 *   (`self-dev/dev-pipeline.ts:602`). 그런데 orchestrator 로 내려오는 것은
 *   `...(plan.completion === 'auto-merge' ? { autoMerge: true } : {})` — ***불리언 «하나»뿐***이다(:491).
 *   ⇒ 🔑 그래서 「auto-merge 가 아니다」까지가 ***이 층이 아는 «전부»***다.
 *   🚨 그것을 `pr-only` 라 부르면 ***「PR 을 연다」로 읽히는데 worktree-only 도 여기 들어온다*** — 이름이 거짓이 된다.
 *   ⇒ 📌 세 번째 값이 필요하면 `completion` 자체를 seam 으로 내려보내야 한다(계약 변경).
 */
export function completionIntentOf(opts: Pick<SelfImplementOptions, 'completion' | 'autoMerge' | 'mergeByHost'>): SelfImplementOptions['completion'] | 'not-auto-merge' {
  return opts.completion ?? (opts.autoMerge === true || opts.mergeByHost === true ? 'auto-merge' : 'not-auto-merge');
}

function autoMergeEnabled(opts: Pick<SelfImplementOptions, 'completion' | 'autoMerge' | 'mergeByHost'>): boolean {
  return completionIntentOf(opts) === 'auto-merge';
}

const SELF_IMPLEMENT_LOG_CATEGORY = 'self-implement';

/** Emits a run-aware auxiliary log without admitting it to the run ledger. */
function logRunAwareFailSoft(
  runId: string,
  event: string,
  data: Record<string, unknown>,
  log: typeof debug.log = debug.log.bind(debug),
): void {
  try { log(SELF_IMPLEMENT_LOG_CATEGORY, event, { ...data, runId }); } catch { /* fail-soft */ }
}

export function makeRunObserver(
  runId: string,
  goalIdOrLog?: string | typeof debug.log,
  suppliedLog: typeof debug.log = debug.log.bind(debug),
  writeLedger: RunLedgerWriter = appendRunLedgerEntry,
  shardIdentity: RunShardIdentity = { pieceTotal: 1 },
): (event: string, data: Record<string, unknown>, opt?: { category?: string; level?: 'warn' | 'error'; compact?: { stringMax?: number; arrayMax?: number; maxDepth?: number } }) => void {
  const goalId = typeof goalIdOrLog === 'string' ? goalIdOrLog : undefined;
  const log = typeof goalIdOrLog === 'function' ? goalIdOrLog : suppliedLog;
  return (event, data, opt) => {
    // ⛔ 전개(`{ ...data }`)도 try 안에 둔다 — data 에 던지는 접근자가 있으면 관측 관문이 런을 죽인다.
    //    「관측은 결론을 막지 않는다」가 이 관문의 계약이다(리뷰 should-fix).
    let observed: Record<string, unknown>;
    try {
      // ⭐ 연합 키를 «로그에도» 싣는다 — 종전엔 원장에만 실려 슈퍼바이저가 연합을 못 봤다(§ⓐ§ⓑ 공통 근본)
      observed = { ...data, runId, ...(goalId ? { goalId } : {}), ...federationObservation(shardIdentity) };
    } catch { return; }
    try {
      if (opt === undefined || opt.category === undefined) {
        log('self-implement', event, observed, opt);
      } else {
        const { category, ...logOpt } = opt;
        log(category, event, observed, logOpt);
      }
    } catch { /* fail-soft */ }
    try {
      writeLedger({
        timestamp: new Date().toISOString(),
        runId,
        event,
        data: observed,
        ...(goalId ? { goalId } : {}),
        ...shardIdentity,
      });
    } catch { /* fail-soft */ }
  };
}

async function runPostMergeCleanup(
  cleanup: SelfImplementSeams['postMergeCleanup'] | undefined,
  worktreePath: string,
  branch: string,
  goalFile: string | undefined,
  remoteBranch: string | undefined,
  observe: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  if (!cleanup?.enabled) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: cleanup ? 'disabled' : 'not-configured' });
    return;
  }
  let activeDirectories: { ok: boolean; value: string[] };
  try {
    activeDirectories = await cleanup.listActiveTerminalDirectories();
  } catch (error) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'terminal-discovery-failed', error: String(error) });
    return;
  }
  if (!activeDirectories.ok) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'terminal-discovery-failed' });
    return;
  }
  try {
    if (cleanup.isWorktreeInUse(worktreePath, activeDirectories.value)) {
      observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'worktree-in-use' });
      return;
    }
  } catch (error) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'terminal-classification-failed', error: String(error) });
    return;
  }
  let porcelain: string | undefined;
  try {
    porcelain = await cleanup.readWorktreePorcelain(worktreePath);
  } catch (error) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'change-inspection-failed', error: String(error) });
    return;
  }
  if (porcelain === undefined) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'change-inspection-failed' });
    return;
  }
  if (porcelain.length > 0) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'uncommitted-changes' });
    return;
  }
  let repoRoot: string | null;
  try {
    repoRoot = await cleanup.resolveMainRepoRoot(worktreePath);
  } catch (error) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'repository-root-unavailable', error: String(error) });
    return;
  }
  if (!repoRoot) {
    observe('post-merge-cleanup-preserved', { worktreePath, branch, reason: 'repository-root-unavailable' });
    return;
  }
  try {
    await cleanup.removeWorktree(repoRoot, worktreePath);
  } catch (error) {
    observe('post-merge-cleanup-failed', { worktreePath, branch, repoRoot, step: 'remove-worktree', error: String(error) });
    return;
  }
  try {
    await cleanup.removeBranch(repoRoot, branch);
  } catch (error) {
    observe('post-merge-cleanup-failed', { worktreePath, branch, repoRoot, step: 'remove-branch', error: String(error) });
    return;
  }
  observe('post-merge-cleanup-completed', { worktreePath, branch, repoRoot });
  if (!goalFile) return;
  if (!remoteBranch || !cleanup.removeMatchingGoalCopy) {
    observe('post-merge-cleanup-goal-copy', { goalFile, outcome: 'kept', reason: !remoteBranch ? 'remote-branch-unavailable' : 'seam-unavailable' });
    return;
  }
  try {
    const result = await cleanup.removeMatchingGoalCopy(repoRoot, goalFile, remoteBranch);
    observe('post-merge-cleanup-goal-copy', { goalFile, outcome: result.outcome, reason: result.reason });
  } catch {
    observe('post-merge-cleanup-goal-copy', { goalFile, outcome: 'kept', reason: 'inspection-failed' });
  }
}

function askFileFromLedger(entries: readonly RunLedgerEntry[] | null): string | undefined {
  if (!entries) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const value = entries[index]?.data.askFile;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function openedAtFromLedger(entries: readonly RunLedgerEntry[] | null, fallback: string): string {
  const timestamp = entries?.find((entry) => entry.event === 'pr-opened')?.timestamp;
  return typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : fallback;
}

/**
 * Successful auto-merge only. Listing, ledger reads, and closes are observation-only:
 * a failure here must not change the merge result. startDraftTriage (same runId) is untouched.
 */
async function runLineageSupersede(
  seam: SelfImplementSeams['lineageSupersede'] | undefined,
  input: { askFile?: string; runId: string; prNumber: number; openedAt: string },
  observe: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  if (!seam) return;
  let listed: readonly { number: number; runId: string; openedAt: string }[];
  try {
    listed = await seam.listOpenDrafts();
  } catch (error) {
    observe('lineage-supersede', { ok: false, step: 'list', error: error instanceof Error ? error.message : String(error), closed: [], notClosed: {} });
    return;
  }
  const readLedger = seam.readRunLedger ?? ((runId: string) => {
    try {
      return loadRunLedger(runId);
    } catch {
      return null;
    }
  });
  const drafts: LineageSupersedeOpenDraft[] = [];
  const ledgerErrors: { runId: string; error: string }[] = [];
  for (const draft of listed) {
    if (draft.number === input.prNumber) {
      drafts.push({ number: draft.number, runId: draft.runId, openedAt: draft.openedAt });
      continue;
    }
    try {
      const entries = await readLedger(draft.runId);
      const askFile = askFileFromLedger(entries);
      drafts.push({
        number: draft.number,
        runId: draft.runId,
        ...(askFile ? { askFile } : {}),
        openedAt: draft.openedAt || openedAtFromLedger(entries, ''),
      });
    } catch (error) {
      ledgerErrors.push({ runId: draft.runId, error: error instanceof Error ? error.message : String(error) });
      drafts.push({ number: draft.number, runId: draft.runId, openedAt: draft.openedAt });
    }
  }
  const decision = decideLineageSupersede(
    { ...(input.askFile ? { askFile: input.askFile } : {}), runId: input.runId, prNumber: input.prNumber, openedAt: input.openedAt },
    drafts,
  );
  const closed: number[] = [];
  const closeErrors: { number: number; error: string }[] = [];
  const comment = input.askFile ? lineageSupersedeCloseComment(input.askFile, input.prNumber) : '';
  for (const draft of decision.close) {
    try {
      await seam.closeDraft({ number: draft.number, comment });
      closed.push(draft.number);
    } catch (error) {
      closeErrors.push({ number: draft.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  observe('lineage-supersede', {
    ok: ledgerErrors.length === 0 && closeErrors.length === 0,
    closed,
    notClosed: decision.notClosed,
    ...(input.askFile ? { askFile: input.askFile } : {}),
    mergedPrNumber: input.prNumber,
    ...(ledgerErrors.length > 0 ? { ledgerErrors } : {}),
    ...(closeErrors.length > 0 ? { closeErrors } : {}),
  });
}

function mergeDecisionEvidenceCoverage(evidenceCoverage: {
  required: number;
  covered: number;
  coveredByLimitation: readonly string[];
  uncovered: readonly string[];
  coveredByLimitationCount: number;
  uncoveredCount: number;
} | undefined): Record<string, unknown> {
  return evidenceCoverage
    ? {
      evidenceCoverageMeasured: true,
      requiredEvidence: evidenceCoverage.required,
      coveredEvidence: evidenceCoverage.covered,
      coveredByLimitationEvidence: evidenceCoverage.coveredByLimitation,
      uncoveredEvidence: evidenceCoverage.uncovered,
      coveredByLimitationCount: evidenceCoverage.coveredByLimitationCount,
      uncoveredCount: evidenceCoverage.uncoveredCount,
    }
    : { evidenceCoverageMeasured: false };
}

function runOriginData(env: NodeJS.ProcessEnv = process.env): RunOriginData {
  return {
    hostId: resolveHostId(env),
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    substrate: env.ELANOUS_SUBSTRATE || 'host',
    instance: resolveInstanceName(),
    elanousVersion: (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version,
    ...(env.ELANOUS_POD_NAME ? { podName: env.ELANOUS_POD_NAME } : {}),
    ...(env.ELANOUS_NODE_NAME ? { nodeName: env.ELANOUS_NODE_NAME } : {}),
    ...(env.ELANOUS_POD_NAMESPACE ? { podNamespace: env.ELANOUS_POD_NAMESPACE } : {}),
    ...(env.ELANOUS_IMAGE_COMMIT ? { imageCommit: env.ELANOUS_IMAGE_COMMIT } : {}),
  };
}

export async function runSelfImplement(opts: SelfImplementOptions): Promise<SelfImplementResult> {
  if (opts.childLlm && (typeof opts.childLlm.provider !== 'string' || !opts.childLlm.provider.trim() || typeof opts.childLlm.model !== 'string' || !opts.childLlm.model.trim())) {
    throw new Error('childLlm.provider and childLlm.model must both be non-empty');
  }
  const identity = resolveRunIdentity({ explicit: opts.runId });
  const { runId } = identity;
  const branch = opts.branchName ?? plannedSelfImplBranch(opts.feature, opts.goalId, runId);
  try {
    debug.log('self-implement.branch', 'planned', {
      runId, goalId: opts.goalId, branch, runSuffix: opts.branchName === undefined ? branch.match(/-r[a-z0-9]{6}$/)?.[0] ?? null : null,
    });
  } catch { /* observation must not block the run */ }
  const attemptOrdinal = incrementRunAttemptOrdinal(runId);
  const shardIdentity = parseRunShardIdentity(opts.feature);
  const observeOuter = makeRunObserver(runId, opts.goalId, debug.log.bind(debug), opts.seams.writeRunLedger, shardIdentity);
  try {
    const origin = runOriginData();
    (opts.seams.writeRunLedger ?? appendRunLedgerEntry)({
      timestamp: new Date().toISOString(), runId, event: 'run-origin', data: origin,
      ...(opts.goalId ? { goalId: opts.goalId } : {}), ...shardIdentity,
    });
  } catch { /* observation must not block the run */ }
  if (opts.observeOnly) {
    observeOuter('cli.observed', { observeOnly: true, observeOnlySource: 'request' });
    return {
      runId,
      ok: true,
      stage: 'pr-declined',
      node: 'implement',
      ...resolveRunOutcome({ termination: 'completed' }),
      branch,
      detail: 'observe-only: SelfImplement execution skipped before child boot',
    };
  }
  const emitContext = (kind: 'task-claimed' | 'task-done', text: string, pr?: number): void => {
    try {
      (opts.seams.emitContextEvent ?? emitSessionEvent)({ kind, seat: 'TC', text,
        ref: `runId=${runId}${pr === undefined ? '' : ` PR=#${pr}`}` });
    } catch (error) {
      try { logRunAwareFailSoft(runId, 'context-event-failed', { kind, error: safeErrorDescription(error) }); }
      catch { /* context publication never changes the run result */ }
    }
  };
  emitContext('task-claimed', `Self-implement claimed: ${opts.feature.split(/\r?\n/, 1)[0]}`);
  const parentHarnessSpaceId = getHarnessSpace()?.id || undefined;
  const configRoot = getElanousConfigDir() || undefined;
  const stateRoot = elanousStateRoot() || undefined;
  let resolvedBase: string | undefined;
  const traversedNodes: PipelineNodeId[] = [];
  const roundClassifications: LifecycleScreenComparison[] = [];
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let roundCount = 0;
  let lastTier: EscalateTier | undefined;
  let lastReviewFindings: string[] | undefined;
  let reviewFindingRoundCount = 0;
  const verbatimReviewFindingOccurrences = new Map<string, number>();
  const normalizedReviewFindingFirstSeenRounds = new Map<string, number>();
  const normalizedReviewFindingObservedRoundCounts = new Map<string, number>();
  const normalizedReviewFindingRepeatCounts = new Map<string, number>();
  const normalizedRepeatedReviewFindingOccurrences: NormalizedReviewFindingOccurrence[] = [];
  let symbolKeyedReviewFindingCount = 0;
  let proseFallbackReviewFindingCount = 0;
  const citedReviewSymbolOccurrences = new Map<string, CitedReviewSymbolOccurrence>();
  let terminalNode: PipelineNodeId | undefined;
  let worktreePath: string | undefined;
  const loopId = `self-implement:${runId}`;
  const loopTtlMinutes = loopTtlMin(opts);
  let loopRegistrationFailureCount = 0;
  const registerRunLoop = (status: LoopAgentInput['status']): void => {
    try {
      (opts.seams.registerLoopAgent ?? registerLoopAgentSafe)({
        loopId,
        name: `Self-implement: ${opts.feature.slice(0, RUN_START_FEATURE_MAX_CHARS)}`,
        summary: `Autonomous self-implement run ${runId}`,
        loopKind: 'autonomous',
        lifecycle: 'ephemeral',
        ttlMin: loopTtlMinutes,
        ...(opts.goalId ? { missionId: opts.goalId } : {}),
        status,
      });
    } catch (error) {
      loopRegistrationFailureCount++;
      observeOuter('loop-agent-registration-failed', {
        loopId,
        status,
        failureCount: loopRegistrationFailureCount,
        reason: safeErrorDescription(error),
      }, { level: 'warn' });
    }
  };
  let loopRegistered = false;
  let mergeApprovalReceived = false;
  let autoMergeAuthorizedBeforeSync = false;
  let lastParsedSupervisorVerdict: ReworkBudgetVerdict | undefined;
  let lastParsedSupervisorReason: string | undefined;
  let providerErrorCount = 0;
  let credentialFailureCount = 0;
  let failureSequence = 0;
  let lastProviderErrorSeq = 0;
  let lastCredentialFailureSeq = 0;
  let lastFailedGateSeq = 0;
  let lastMustFixReviewSeq = 0;
  const recordFailureVerdict = async (kind: 'gate' | 'review'): Promise<void> => {
    // Capture child errors at the verdict boundary, not when terminal reporting eventually reads them.
    await mergeChildProviderErrors();
    if (kind === 'gate') lastFailedGateSeq = ++failureSequence;
    else lastMustFixReviewSeq = ++failureSequence;
  };
  const latestVerdictSeq = (): number => Math.max(lastFailedGateSeq, lastMustFixReviewSeq);
  const hasCurrentProviderError = (): boolean => providerErrorCount > 0 && lastProviderErrorSeq > latestVerdictSeq();
  const hasCurrentCredentialFailure = (): boolean => credentialFailureCount > 0 && lastCredentialFailureSeq > latestVerdictSeq();
  let lastProviderError: { provider?: string; message?: string } | undefined;
  let lastCredentialFailure: { provider?: string; message?: string } | undefined;
  let childProviderErrorQueryStatus: 'found' | 'none' | 'unavailable' | 'not-configured' = 'not-configured';
  let queriedProviderErrorCount = 0;
  let queriedCredentialFailureCount = 0;
  const providerErrorsForResult = (): Pick<SelfImplementResult, 'providerErrors'> => {
    if (providerErrorCount === 0) return {};
    const message = lastProviderError?.message ?? '';
    const category = classifyError({ message }) === 'quota-exceeded' || /spending[-_ ]limit/i.test(message)
      ? 'quota'
      : (credentialFailureCount > 0 && lastCredentialFailure?.message === message) || /\b(?:401|unauthorized|invalid[_ -]?(?:api[_ -]?key|token)|authentication failed)\b/i.test(message)
        ? 'credential'
        : isDeterministicRequestRejection(message)
          ? 'request'
          : 'other';
    return { providerErrors: { count: providerErrorCount, provider: lastProviderError?.provider ?? 'unknown', category } };
  };
  const mergeChildProviderErrors = async (): Promise<void> => {
    const query = opts.seams.queryChildProviderErrors;
    if (!query) return;
    try {
      const result = await query({ runId, sinceMs: startedAtMs, untilMs: Date.now() });
      childProviderErrorQueryStatus = result.status;
      if (result.status !== 'found') return;
      const newProviderErrors = Math.max(0, result.providerErrorCount - queriedProviderErrorCount);
      const newCredentialFailures = Math.max(0, result.credentialFailureCount - queriedCredentialFailureCount);
      providerErrorCount += newProviderErrors;
      credentialFailureCount += newCredentialFailures;
      if (newProviderErrors > 0) lastProviderErrorSeq = ++failureSequence;
      if (newCredentialFailures > 0) lastCredentialFailureSeq = newProviderErrors > 0 ? lastProviderErrorSeq : ++failureSequence;
      queriedProviderErrorCount = Math.max(queriedProviderErrorCount, result.providerErrorCount);
      queriedCredentialFailureCount = Math.max(queriedCredentialFailureCount, result.credentialFailureCount);
      lastProviderError = result.lastProviderError ?? lastProviderError;
      lastCredentialFailure = result.lastCredentialFailure ?? lastCredentialFailure;
    } catch {
      childProviderErrorQueryStatus = 'unavailable';
    }
  };
  const unregisterProviderErrorSink = debug.registerSink({
    name: `self-implement-provider-error-${runId}`,
    emit(record) {
      if (record.category !== 'llm.router.error') return;
      const data = record.data;
      if (!data || typeof data !== 'object') return;
      const { provider, message } = data as Record<string, unknown>;
      providerErrorCount++;
      lastProviderErrorSeq = ++failureSequence;
      lastProviderError = {
        ...(typeof provider === 'string' ? { provider } : {}),
        ...(typeof message === 'string' ? { message } : {}),
      };
      // ⛔⭐⭐⭐ 자격 거부는 「프로바이더 오류」의 부분집합이지만 ***사람이 할 다음 행동이 다르다***
      //   (2026-08-14 실측 · `[T]` 83차): grok 자식 «둘»이 401 로 죽었는데 부모가 남긴 것은
      //   「보고 결손」뿐이라, 사람이 ***「이 두뇌가 구현을 못 하나」를 진지하게 의심하고 런을 하나 더 날렸다.***
      //   ⇒ 재인증 한 번이면 끝나는 일에 두 런과 40분을 썼다.
      //   📌 `#9050` 이 분류 «어휘»(credential-failure)를 세웠는데 ***그 신호를 «넣는» 쪽이 없었다.***
      //      이 블록이 그 자리다 — 감지는 이미 도는 이 싱크가 하고, 갈래만 하나 더 만든다.
      // ⭐ 판정은 «여기서 안 한다» — 오류가 «태어나는» 자리(src/llm.ts 라우터)가
      //   status 를 실물로 갖고 있고, 그 신호는 채팅·ACP·self-implement 가 «같이» 쓴다.
      //   여기서 문면 정규식으로 다시 재면 소비자마다 다른 답이 나온다.
      if ((data as Record<string, unknown>).authRejected === true) {
        credentialFailureCount++;
        lastCredentialFailureSeq = lastProviderErrorSeq;
        lastCredentialFailure = { ...lastProviderError };
      }
    },
  } satisfies LogSink);
  let traversalFinalized = false;
  const progressDelivery = { delivered: 0, unwired: 0, callbackFailed: 0 };
  let capturedPrNumber: number | undefined;
  let openPrInvoked = false;
  const defaultProviderName = opts.seams.currentProviderName?.() ?? currentProviderName();
  const runProviderName = opts.childLlm?.provider ?? defaultProviderName;
  const logQuotaProvider = (assessment: QuotaExhaustionAssessment | undefined): void => {
    try {
      debug.log('self-implement.abandoned', 'quota-provider', {
        runProvider: runProviderName, defaultProvider: defaultProviderName, used: assessment?.exhausted !== undefined,
      });
    } catch { /* observation must not change the terminal result */ }
  };
  const instrumentedOpts: SelfImplementOptions = {
    ...opts,
    seams: {
      ...opts.seams,
      openPr: async (args) => {
        openPrInvoked = true;
        const pr = await opts.seams.openPr(args);
        const number = recordedPrNumber(pr.number);
        if (number !== undefined) capturedPrNumber = number;
        return pr;
      },
      onProgress: (event) => {
        if (!opts.seams.onProgress) {
          progressDelivery.unwired += 1;
          observeOuter('progress-delivery-outcome', { stage: event.stage, status: 'surface-callback-unwired', requesterSession: opts.parentSessionId ?? null });
          return;
        }
        try {
          opts.seams.onProgress(event);
          progressDelivery.delivered += 1;
          observeOuter('progress-delivery-outcome', { stage: event.stage, status: 'delivered', requesterSession: opts.parentSessionId ?? null });
        } catch {
          progressDelivery.callbackFailed += 1;
          observeOuter('progress-delivery-outcome', { stage: event.stage, status: 'callback-failed', requesterSession: opts.parentSessionId ?? null }, { level: 'warn' });
        }
      },
    },
  };
  const observeProgressDelivery = (): void => {
    observeOuter('progress-delivery', progressDelivery);
  };
  /** 이 런이 «따르는» 그래프의 신원.
   *
   *  ⛔⭐ 맥락은 «한 번» 정해지고 아래로는 «인자»로만 내려간다 — 이 관측기는 config 를 «안 읽는다».
   *    (읽으려면 async 가 필요하고, 여기서 읽으면 「해석이 두 자리」가 되어 갈릴 수 있다.)
   *  ⇒ 실행부(`runSelfImplementInner`)가 맥락을 정한 «뒤» 이 홀더에 심는다. 심기 «전»에는 옛 값이다. */
  /** ⭐ 방문 예산을 읽으려면 «지금 도는 선언»이 필요하다 — 신원과 «같은 패턴»으로 한 번 심는다.
   *  ⛔ 걸음(`traversedNodes`)은 이 스코프에 있고 선언은 안쪽에서 정해지므로, 둘을 잇는 자리가 여기다. */
  let runGraphTemplate: GraphTemplate | undefined;
  let runContract: RunContract | undefined;
  let runGraphIdentity: { graphId: string; graphVersion: string } | undefined;
  const setRunGraphIdentity = (identity: { graphId: string; graphVersion: string }): void => {
    runGraphIdentity = identity;
  };
  const observedGraphIdentity = (): { graphId: string; graphVersion: string } =>
    runGraphIdentity ?? pipelineGraphIdentity();

  const observePipeline = (event: 'pipeline-node-entry' | 'pipeline-traversal-shadow' | 'graph-visit-budget', data: Record<string, unknown>): void => {
    if (opts.seams.observePipeline === false) return;
    // ⭐ RFC §5 0단계 — 파이프라인 관측이 «전부» 이 함수를 지나므로 신원을 여기 «한 곳»에서 단다.
    //   ⛔ 호출부마다 붙이면 새 관측 자리가 생길 때 조용히 빠진다(오늘 이 저장소가 여러 번 밟은 꼴).
    // ⛔⭐ 신원은 «지금 도는 템플릿»에서 온다 — 옛 TS 상수를 쓰면 «걸음과 신원이 갈린다».
    //   🩸 2026-09-08 실측: 승격을 켠 research 런이 `investigate` 를 밟았는데
    //     원장의 graphVersion 은 «옛 TS 해시»였다 ⇒ 사후에 「어느 선언으로 돈 걸음인가」를 못 묻는다.
    //   ⛔ 여기서 «한 번» 해석한다 — 호출부마다 붙이면 새 관측 자리가 생길 때 조용히 빠진다.
    const graphIdentity = observedGraphIdentity();
    const attemptOrdinal = readRunAttemptOrdinal(runId);
    const identified = {
      ...graphIdentity,
      ...data,
      attemptOrdinal,
    };
    try {
      const pending = typeof opts.seams.observePipeline === 'function'
        ? opts.seams.observePipeline(event, { ...identified, runId })
        : observeOuter(event, identified, event === 'pipeline-traversal-shadow'
          ? { compact: { arrayMax: Number.MAX_SAFE_INTEGER } }
          : undefined);
      if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
        void Promise.resolve(pending).catch(() => {});
      }
    } catch { /* additive observation is fail-soft */ }
  };
  const observeNodeEntry = (node: PipelineNodeId, round: number): void => {
    // ⭐ 대표 지시(2026-09-08): ***걸음을 「위」로도 한 칸 흘린다.***
    //   🩸 그 전까지 슈퍼바이저가 받는 것은 «시도의 요약 판정»뿐이었다(stage·stopReason·분류 …).
    //     걸음(어느 노드를 몇 번 밟았나)은 ***런 안에서 끝났다*** — `onNodeEntry` 는 «있는데»
    //     ***호출부가 0*** 이었다(내부 기본값 no-op).
    //   ⛔ 새 관을 만들지 않는다 — 이미 있는 이음매에 «옵션 하나»를 연다.
    //   ⛔ fail-soft: 소비자가 던져도 걸음·관측이 죽지 않는다.
    try { opts.onNodeEntry?.(node, round); } catch { /* 관측 소비자는 실행을 막지 않는다 */ }
    // ⭐ RFC §5 — 선언된 «방문 예산»을 실행이 «읽는다»(사다리 ④). ⛔ 관측만이다 — 막지 않는다.
    //   🩸 이 줄 전에는 `maxVisits` 를 읽는 실행 코드가 `src/` 에 «하나도 없었다».
    //   ⛔ 예산부터 걸면 런이 조용히 죽고, 그때 「원래 그랬나」를 물을 자료가 없다.
    if (runGraphTemplate !== undefined) {
      const reading = visitBudgetOf(runGraphTemplate, traversedNodes, node);
      if (reading !== null) observePipeline('graph-visit-budget', { round, ...reading });
    }
    traversedNodes.push(node);
    if (node === 'implement') roundCount++;
    const fallbackGraphIdentity = observedGraphIdentity();
    const contractAtNode = runContract === undefined ? undefined : runContractAtNode(runContract);
    observePipeline('pipeline-node-entry', {
      ...pipelineNodeEntryPayload(
        runGraphTemplate ?? { graphId: fallbackGraphIdentity.graphId, version: fallbackGraphIdentity.graphVersion, nodes: [] },
        node,
      ),
      node,
      round,
      ...contractAtNode,
    });
    if (contractAtNode?.contractHonored === false) {
      observeOuter('graph-contract-violation', {
        node, round,
        contractSubstrate: contractAtNode.contractSubstrate,
        actualSubstrate: contractAtNode.actualSubstrate,
      }, { level: 'warn' });
    }
  };
  const observeRoundClassification = (classification: LifecycleScreenComparison): void => {
    roundClassifications.push(classification);
  };
  const observeRoundExecution = (tier: EscalateTier): void => {
    lastTier = tier;
  };
  const observeReviewFindings = (round: number, mustFix: readonly string[]): void => {
    reviewFindingRoundCount++;
    lastReviewFindings = [...mustFix];
    const findingsInRound = new Set(mustFix.map((finding) => finding.trim()).filter(Boolean));
    const reviewFindingKeysInRound = new Set<string>();
    for (const finding of findingsInRound) {
      const { key, source } = reviewFindingKey(finding);
      if (!key) continue;
      if (source === 'symbol') symbolKeyedReviewFindingCount++;
      else proseFallbackReviewFindingCount++;
      reviewFindingKeysInRound.add(key);
    }
    const citedSymbolsInRound = new Map<string, CitedReviewSymbol>();
    for (const citedSymbol of [...findingsInRound].flatMap(citedReviewSymbols)) {
      if (citedReviewSymbolOccurrences.has(citedSymbol.hash) || citedReviewSymbolOccurrences.size + citedSymbolsInRound.size < MAX_CITED_REVIEW_SYMBOLS_PER_RUN) {
        citedSymbolsInRound.set(citedSymbol.hash, citedSymbol);
      }
    }
    for (const finding of findingsInRound) {
      verbatimReviewFindingOccurrences.set(finding, (verbatimReviewFindingOccurrences.get(finding) ?? 0) + 1);
    }
    for (const reviewFindingKey of reviewFindingKeysInRound) {
      const firstSeenRound = normalizedReviewFindingFirstSeenRounds.get(reviewFindingKey);
      if (firstSeenRound === undefined) {
        normalizedReviewFindingFirstSeenRounds.set(reviewFindingKey, round);
        normalizedReviewFindingObservedRoundCounts.set(reviewFindingKey, 1);
        continue;
      }
      const observedRoundCount = (normalizedReviewFindingObservedRoundCounts.get(reviewFindingKey) ?? 1) + 1;
      normalizedReviewFindingObservedRoundCounts.set(reviewFindingKey, observedRoundCount);
      const occurrence = (normalizedReviewFindingRepeatCounts.get(reviewFindingKey) ?? 0) + 1;
      normalizedReviewFindingRepeatCounts.set(reviewFindingKey, occurrence);
      normalizedRepeatedReviewFindingOccurrences.push({
        hash: shortNormalizedReviewFindingHash(reviewFindingKey),
        firstSeenRound,
        repeatedAtRound: round,
        occurrence,
        observedRoundCount,
      });
    }
    for (const citedSymbol of citedSymbolsInRound.values()) {
      const observed = citedReviewSymbolOccurrences.get(citedSymbol.hash);
      if (observed === undefined) {
        citedReviewSymbolOccurrences.set(citedSymbol.hash, {
          ...citedSymbol,
          firstSeenRound: round,
          lastSeenRound: round,
          occurrence: 0,
        });
        continue;
      }
      citedReviewSymbolOccurrences.set(citedSymbol.hash, {
        ...observed,
        lastSeenRound: round,
        occurrence: observed.occurrence + 1,
      });
    }
  };
  /** ⭐ RFC §5 1단계 «게이트 ⑵» — 그림자 구간이 「골 종류 둘 이상」을 포함하는지 세려면 그 축이 원장에 있어야 한다.
   *  ⛔ 「골 파일이 없다」와 「읽었는데 못 읽었다」를 «같은 값»으로 접지 않는다 — 처방이 다르다.
   *  값 다섯: declared · default · malformed · no-goal-file · unreadable */
  const traversalGoalKind = (): { goalType?: string; goalTypeSource: string } => {
    if (!opts.goalFile) return { goalTypeSource: 'no-goal-file' };
    const fields = goalTypeFields(opts.goalFile);
    if (!fields.goalTypeSource) return { goalTypeSource: 'unreadable' };
    return { ...(fields.goalType ? { goalType: fields.goalType } : {}), goalTypeSource: fields.goalTypeSource };
  };
  const finalizeTraversal = (): void => {
    if (traversalFinalized) return;
    traversalFinalized = true;
    try {
      const checked = terminalNode
        ? (opts.seams.checkPipelineTraversal ?? checkPipelineTraversal)(traversedNodes, terminalNode)
        // ⭐ 0a — 「결과 노드를 못 얻었다」와 「검사가 던졌다」를 «다른 사유»로 낸다(종전엔 둘 다 unclassifiable 뿐이었다).
        : { classification: 'unclassifiable', terminalResolution: 'result-absent' as const, observedNodes: traversedNodes, terminalNode: null };
      observePipeline('pipeline-traversal-shadow', { ...checked, observedNodeCount: checked.observedNodes.length, ...traversalGoalKind() });
    } catch (error) {
      observePipeline('pipeline-traversal-shadow', {
        classification: 'unclassifiable', terminalResolution: 'error' as const, observedNodes: traversedNodes, observedNodeCount: traversedNodes.length, terminalNode: terminalNode ?? null, ...traversalGoalKind(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  let terminalResult: SelfImplementResult | undefined;
  let reviewReflectRejectedCount: number | undefined;
  const attachReviewReflectionOutcome = <T extends Omit<SelfImplementResult, 'runId'>>(result: T): T & Pick<SelfImplementResult, 'completionStatus' | 'reviewReflectRejectedCount'> => ({
    ...result,
    ...(result.outcome === 'completed' ? { completionStatus: result.completionStatus ?? 'completed' } : {}),
    ...(reviewReflectRejectedCount !== undefined ? { reviewReflectRejectedCount } : {}),
  });
  let observationMeasurementBasis: ObservationMeasurementBasis | undefined;
  let clarificationTimeout: Pick<GoalExecutionRecord, 'clarificationTimeoutUnanswered' | 'clarificationTimeoutQuestionIds' | 'clarificationUnansweredOutcome'> | undefined;
  let runActiveProvider: { provider?: string; model?: string; auth?: string } | undefined;
  let terminalSessionId: string | undefined;
  const terminalDetail = (sessionId: string | undefined) => ({
    sessionId: sessionId ?? null,
    parentSessionId: opts.parentSessionId ?? null,
    terminalSeq: incrementTerminalSequence(runId),
    terminalSeqScope: 'process' as const,
  });
  const recordGoalExecution = async (result: SelfImplementResult): Promise<void> => {
    if (!opts.goalFile) {
      // ⛔ 이 자리를 관측 관문(observeOuter)으로 «올리지 않는다» — 원장을 채우려고 관문의 통행량을
      //    바꾸면 「관문을 지난 것만 적는다」가 「적고 싶은 것을 관문에 태운다」로 뒤집힌다(리뷰 must-fix).
      // 이 보조 발화의 sink 실패도 종결 결과를 덮어쓰면 안 되므로 fail-soft 로 남긴다.
      logRunAwareFailSoft(runId, 'goal-execution-record', {
        goalFile: null,
        reason: 'no-goal-file',
      });
      return;
    }
    // ⛔ 레코드 «생성»도 try 안이다 — main 은 인자 자리에서 인라인으로 만들어 예외 경계 «안»에 있었다.
    //    가독성을 위해 const 로 빼면서 밖으로 나가면 보조 기록의 fail-soft 계약이 조용히 약해진다
    //    (리뷰 must-fix · 이 착지의 원장 목표와 무관한 리팩터링이다).
    try {
      const documentHash = goalContentHash(opts.goalFile);
      const reviewerContextBudget = reviewerContextBudgetFromReview(result.review);
      const goalType = goalTypeFields(opts.goalFile);
      const askFile = askFileField(opts.goalFile);
      const observationMeasurement = goalType.goalType !== undefined && goalType.goalType !== 'implement'
        ? { observationMeasurementSkipped: 'non-implement-goal-type' as const }
        : observationMeasurementBasis ? { observationMeasurementBasis } : {};
      const record: NewGoalExecutionRecord = {
        runId: result.runId,
        stage: result.stage,
        outcome: result.outcome,
        ok: result.ok,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        rounds: roundCount,
        ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
        // ⭐ 로그와 «같은» 규칙으로 연합 키를 굳힌다 — 두 스토어가 같은 키를 가져야 조인된다(`OBS-T101` §ⓐ)
        ...federationObservation(shardIdentity),
        // ⭐ 「어디까지 가려 했나」 — 이 칸이 없으면 (completed, pr-opened) 70건을 «정상/미완»으로 못 가른다
        completionIntent: completionIntentOf(opts),
        // ⭐ 「달성」의 «근사값»(`JDG-T60`) — ⛔ 측정 못 한 런에는 칸을 만들지 않는다
        ...(result.evidenceCoverageSummary ? {
          requiredEvidence: result.evidenceCoverageSummary.required,
          coveredEvidence: result.evidenceCoverageSummary.covered,
          uncoveredEvidence: result.evidenceCoverageSummary.uncovered,
        } : {}),
        ...goalType,
        ...askFile,
        ...classificationFields(result),
        ...quotaLedgerFields(result.abandonedClassification),
        ...(lastParsedSupervisorVerdict ? { supervisorVerdict: lastParsedSupervisorVerdict } : {}),
        ...(result.supervisorReason ? { supervisorReason: result.supervisorReason } : {}),
        ...(() => {
          const repeatedReviewFindingCount = normalizedReviewFindingRepeatCounts.size;
          const verbatimRepeatedReviewFindingCount = [...verbatimReviewFindingOccurrences.values()].filter((count) => count > 1).length;
          return normalizedReviewFindingFirstSeenRounds.size > 0
            ? {
                repeatedReviewFindingKeyVersion: REVIEW_FINDING_KEY_VERSION,
                repeatedReviewFindings: repeatedReviewFindingCount > 0,
                repeatedReviewFindingCount,
                verbatimRepeatedReviewFindingCount,
              }
            : {};
        })(),
        ...(verbatimReviewFindingOccurrences.size > 0 && reviewFindingRoundCount > 1
          ? { reviewFindingComparisonRoundCount: reviewFindingRoundCount }
          : {}),
        ...(normalizedReviewFindingFirstSeenRounds.size > 0 ? {
          normalizedRepeatedReviewFindingCount: normalizedReviewFindingRepeatCounts.size,
          symbolKeyedReviewFindingCount,
          proseFallbackReviewFindingCount,
          ...(normalizedRepeatedReviewFindingOccurrences.length ? { normalizedRepeatedReviewFindingOccurrences } : {}),
        } : {}),
        ...(citedReviewSymbolOccurrences.size > 0 ? {
          citedReviewSymbolRepeatCount: [...citedReviewSymbolOccurrences.values()].filter(({ occurrence }) => occurrence > 0).length,
          citedReviewSymbolOccurrences: [...citedReviewSymbolOccurrences.values()],
        } : {}),
        ...(lastReviewFindings?.length ? { lastReviewFindings: budgetReviewFindings(lastReviewFindings) } : {}),
        ...(lastTier ? { tier: lastTier } : {}),
        ...(() => {
          const target = lastTier ? resolveEscalateTarget(lastTier) : null;
          return target ? { model: target.model } : {};
        })(),
        // ⭐ 「실제로 어느 두뇌로 돌았나」 — ⛔ 위 `model` 과 «다른 값»이다(타입 머리말 참조)
        ...runProviderFields(runActiveProvider),
        ...(resolvedBase ? { resolvedBase } : {}),
        ...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
        ...(parentHarnessSpaceId ? { parentHarnessSpaceId } : {}),
        ...(configRoot ? { configRoot } : {}),
        ...(stateRoot ? { stateRoot } : {}),
        ...observationMeasurement,
        ...(documentHash ? { goalContentHash: documentHash } : {}),
        ...(reviewerContextBudget ? { reviewerContextBudget } : {}),
        ...clarificationTimeout,
      };
      try {
        await (opts.writeGoalExecutionRecord ?? appendGoalExecutionRecord)(opts.goalFile, record);
      } catch (error) {
        logRunAwareFailSoft(runId, 'goal-execution-record-failed', {
          goalFile: opts.goalFile,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await (opts.writeGoalRunRecord ?? insertGoalRunRecord)(opts.goalFile, record, opts.goalId);
      } catch (error) {
        logRunAwareFailSoft(runId, 'goal-run-store-failed', {
          goalFile: opts.goalFile,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      // ⛔ 성공 경로에는 «원래 관측이 없었다». 원장에 종결 요약을 싣자고 여기에 새로 심으면
      //    이 착지의 불변식(새 계측을 심지 않는다)을 정면으로 어긴다(리뷰 must-fix).
    } catch (error) {
      logRunAwareFailSoft(runId, 'goal-execution-record-failed', {
        goalFile: opts.goalFile,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  try {
    let evidenceCoverageSummary: { required: number; covered: number; uncovered: number } | undefined;
    /** ⭐ 「달성 근사값」을 결과에 «한 자리»에서 붙인다 — terminalResult 가 두 자리에서 서므로 각각에 붙이면 누락난다. */
    const withEvidenceCoverage = (r: SelfImplementResult): SelfImplementResult =>
      evidenceCoverageSummary ? { ...r, evidenceCoverageSummary } : r;
    const result = await runSelfImplementInner(
      instrumentedOpts,
      identity,
      attemptOrdinal,
      shardIdentity,
      observeNodeEntry,
      observeRoundClassification,
      (path) => {
        worktreePath = path;
        registerRunLoop('active');
        loopRegistered = true;
      },
      observeRoundExecution,
      observeReviewFindings,
      setRunGraphIdentity,
      (template) => { runGraphTemplate = template; },
      // ⭐ 「요구 증거 충족」을 받아 결과에 실어 원장까지 나른다(`JDG-T60`)
      (summary) => { evidenceCoverageSummary = summary; },
      () => ({
        citedReviewSymbolOccurrences: [...citedReviewSymbolOccurrences.values()],
        normalizedReviewFindingRepeatCounts: [...normalizedRepeatedReviewFindingOccurrences],
        symbolKeyedReviewFindingCount,
        proseFallbackReviewFindingCount,
      }),
      instrumentedOpts.seams.reworkBudgetReviewFindingRecurrence ?? (() => null),
      () => { mergeApprovalReceived = true; },
      () => { autoMergeAuthorizedBeforeSync = true; },
      (verdict) => { lastParsedSupervisorVerdict = verdict; },
      (reason) => { lastParsedSupervisorReason = reason; },
      (base) => { resolvedBase = base ?? undefined; },
      (basis) => { observationMeasurementBasis = basis; },
      (timeout) => { clarificationTimeout = timeout; },
      hasCurrentProviderError,
      hasCurrentCredentialFailure,
      () => hasCurrentProviderError() ? providerErrorsForResult().providerErrors?.category : undefined,
      (rejectedCount) => { reviewReflectRejectedCount = (reviewReflectRejectedCount ?? 0) + rejectedCount; },
      observeOuter,
      (active) => { runActiveProvider = active; },
      (sessionId) => { terminalSessionId = sessionId; },
      (contract) => { runContract = contract; },
      recordFailureVerdict,
      () => providerErrorCount > 0,
      () => credentialFailureCount > 0,
      hasCurrentProviderError,
      hasCurrentCredentialFailure,
    );
    terminalNode = result.node;
    await mergeChildProviderErrors();
    const addressedResult = attachAbandonedClassification(
      attachReviewReflectionOutcome({ ...result, ...providerErrorsForResult(), runId, ...(lastParsedSupervisorReason ? { supervisorReason: lastParsedSupervisorReason } : {}), ...(mergeApprovalReceived ? { mergeApprovalReceived: true } : {}) }),
      opts.goalFile,
      hasCurrentProviderError(),
      hasCurrentCredentialFailure(),
      opts.seams.inspectCodexRotation,
      runProviderName,
    );
    if (isAbandonedClassificationOutcome(addressedResult.outcome)) logQuotaProvider(addressedResult.quotaExhaustionAssessment);
    observeOuter('child-provider-error-query', { status: childProviderErrorQueryStatus });
    if (lastProviderError) {
      observeOuter('provider-error-observed', { count: providerErrorCount, ...lastProviderError });
    }
    // ⭐ 자격 거부는 «따로» 말한다 — 사람이 할 다음 행동이 「재인증」 하나로 끝나기 때문이다.
    if (lastCredentialFailure) {
      observeOuter('credential-failure-observed', { count: credentialFailureCount, ...lastCredentialFailure });
    }
    terminalResult = withEvidenceCoverage(addressedResult);
    observeDeclaredScopeDiff(observeOuter, {
      goalFile: opts.goalFile,
      changedFiles: opts.goalFile && addressedResult.worktreePath
        ? collectRunFacts(addressedResult.worktreePath).changedFiles
        : undefined,
      // ⛔ 이 스코프엔 `progress` 헬퍼가 «없다»(3695행 · 다른 스코프) — seam 을 직접 쓴다.
      progress: (stage, message) => { try { opts.seams.onProgress?.({ stage, message }); } catch { /* best-effort */ } },
    });
    observeRunOutcome(observeOuter, {
      node: addressedResult.node,
      stage: addressedResult.stage,
      outcome: addressedResult.outcome,
      worktreePath: addressedResult.worktreePath,
      review: addressedResult.review,
      completionDisposition: addressedResult.completionDisposition,
      supervisorVerdict: addressedResult.supervisorVerdict,
      goalCauseObserved: addressedResult.goalCauseObserved,
      mergeApprovalReceived: addressedResult.mergeApprovalReceived,
      abandonedClassification: addressedResult.abandonedClassification,
      providerErrors: addressedResult.providerErrors,
      activeProvider: runActiveProvider,
      quotaExhaustionAssessment: addressedResult.quotaExhaustionAssessment,
      mergeReason: addressedResult.mergeReason,
      followUpMustFix: addressedResult.followUpMustFix,
      followUpMustFixCount: addressedResult.followUpMustFixCount,
      prNumber: addressedResult.prNumber,
      prUrl: addressedResult.prUrl,
      completionStatus: addressedResult.completionStatus,
      reviewReflectRejectedCount: addressedResult.reviewReflectRejectedCount,
    }, roundClassifications);
    recordHitlEvent({
      kind: 'decision-surfaced',
      action: 'run-terminal',
      pattern: addressedResult.stage,
      feature: opts.feature,
      decision: addressedResult.outcome,
      detail: {
        runId,
        stage: addressedResult.stage,
        outcome: addressedResult.outcome,
        supervisorVerdict: addressedResult.supervisorVerdict ?? null,
        abandonedClassification: addressedResult.abandonedClassification ?? null,
        ...terminalDetail(addressedResult.sessionId),
      },
    });
    observeRunRollup(observeOuter, addressedResult, roundClassifications, roundCount, capturedPrNumber, openPrInvoked);
    observeProgressDelivery();
    return addressedResult;
  } catch (e) {
    if (e instanceof StepTimeoutError) {
      observeOuter('step-timeout', { step: e.step, ms: e.ms, branch, feature: opts.feature.slice(0, 80) }, { level: 'warn' });
      const result: SelfImplementResult = {
        runId,
        ok: false,
        stage: 'timed-out',
        node: 'implement',
        ...resolveRunOutcome({ termination: 'abandoned' }),
        branch,
        ...(worktreePath ? { worktreePath } : {}),
        ...(lastParsedSupervisorReason ? { supervisorReason: lastParsedSupervisorReason } : {}),
        ...(mergeApprovalReceived || (e.step === 'merge' && autoMergeAuthorizedBeforeSync) ? { mergeApprovalReceived: true } : {}),
        detail: worktreePath
          ? `자율 단계 '${e.step}' wall-clock ${e.ms}ms 초과 — hang 방지 종결(worktree 회수 경로: ${worktreePath})`
          : `자율 단계 '${e.step}' wall-clock ${e.ms}ms 초과 — hang 방지 종결(worktree 생성 전)`,
      };
      terminalNode = result.node;
      await mergeChildProviderErrors();
      const addressedResult = attachAbandonedClassification(attachReviewReflectionOutcome({ ...result, ...providerErrorsForResult() }), opts.goalFile, hasCurrentProviderError(), hasCurrentCredentialFailure(), opts.seams.inspectCodexRotation, runProviderName);
      logQuotaProvider(addressedResult.quotaExhaustionAssessment);
      observeOuter('child-provider-error-query', { status: childProviderErrorQueryStatus });
      if (lastProviderError) {
        observeOuter('provider-error-observed', { count: providerErrorCount, ...lastProviderError });
      }
      if (lastCredentialFailure) {
        observeOuter('credential-failure-observed', { count: credentialFailureCount, ...lastCredentialFailure });
      }
      terminalResult = addressedResult;   // ⛔ 이 분기(StepTimeoutError)는 스코프가 달라 부착 헬퍼가 «안 보인다» — 타임아웃 런은 달성 근사값이 «없다»(0 으로 채우지 않는다)
      observeDeclaredScopeDiff(observeOuter, {
        goalFile: opts.goalFile,
        changedFiles: opts.goalFile && addressedResult.worktreePath
          ? collectRunFacts(addressedResult.worktreePath).changedFiles
          : undefined,
        progress: (stage, message) => { try { opts.seams.onProgress?.({ stage, message }); } catch { /* best-effort */ } },
      });
      observeRunOutcome(observeOuter, {
        node: addressedResult.node,
        stage: addressedResult.stage,
        outcome: addressedResult.outcome,
        worktreePath: addressedResult.worktreePath,
        review: addressedResult.review,
        completionDisposition: addressedResult.completionDisposition,
        supervisorVerdict: addressedResult.supervisorVerdict,
        mergeApprovalReceived: addressedResult.mergeApprovalReceived,
        abandonedClassification: addressedResult.abandonedClassification,
        providerErrors: addressedResult.providerErrors,
        activeProvider: runActiveProvider,
        quotaExhaustionAssessment: addressedResult.quotaExhaustionAssessment,
        mergeReason: addressedResult.mergeReason,
        completionStatus: addressedResult.completionStatus,
        reviewReflectRejectedCount: addressedResult.reviewReflectRejectedCount,
      }, roundClassifications);
      recordHitlEvent({
        kind: 'decision-surfaced',
        action: 'run-terminal',
        pattern: addressedResult.stage,
        feature: opts.feature,
        decision: addressedResult.outcome,
        detail: {
          runId,
          stage: addressedResult.stage,
          outcome: addressedResult.outcome,
          supervisorVerdict: addressedResult.supervisorVerdict ?? null,
          abandonedClassification: addressedResult.abandonedClassification ?? null,
          ...terminalDetail(addressedResult.sessionId ?? terminalSessionId),
        },
      });
      observeRunRollup(observeOuter, addressedResult, roundClassifications, roundCount, capturedPrNumber, openPrInvoked);
      observeProgressDelivery();
      return addressedResult;
    }
    recordHitlEvent({
      kind: 'escalation',
      action: 'run-terminal',
      pattern: 'exception',
      feature: opts.feature,
      decision: 'rethrow',
      detail: {
        runId,
        stage: null,
        outcome: null,
        supervisorVerdict: null,
        abandonedClassification: null,
        terminalUnknownReason: e instanceof Error && e.name ? e.name : null,
        error: safeErrorDescription(e),
        ...terminalDetail(terminalSessionId),
      },
    });
    throw e;
  } finally {
    if (loopRegistered) registerRunLoop('ended');
    const terminalStage = terminalResult?.stage ?? 'crashed';
    try {
      const mappedStatus = mapStageToRunStatus(terminalStage)?.runStatus;
      if (!terminalResult || mappedStatus === 'failed' || (mappedStatus === undefined && terminalResult.ok === false) || signalIncompleteState(roundClassifications).latestSignalIncomplete) {
        recordFailureEvent({
          source: 'harness-run', kind: terminalStage, ref: runId,
          summary: opts.feature.split(/\r?\n/, 1)[0]?.trim() || `Harness run ${runId} failed`,
          at: new Date().toISOString(),
        });
      }
    } catch (error) {
      logRunAwareFailSoft(runId, 'heal-intake-record-failed', { stage: terminalStage, error: safeErrorDescription(error) });
    }
    if (terminalResult) await recordGoalExecution(terminalResult);
    // ⛔⭐⭐⭐ 종결을 «못 적고» 죽는 길을 막는다 (2026-08-11 · 🅣 71차 · 대표 「종료 때 정리가 안 되면 설계 문제」).
    //   `terminalResult` 는 «두 자리»에서만 선다 — 정상 종료 ⊕ `StepTimeoutError` 분기.
    //   ⇒ 그 밖의 예외로 죽으면 이 finally 가 «아무것도» 안 써서 그 런은 어느 원장에서도 「미완」으로 남고,
    //     발사 전 검사(`METHOD v33` ⑶)가 그 유령을 보고 «실제 발사»를 막는다(실측: 오늘 두 번).
    //   📏 실측 근거: 미완 57 중 종결이 어디에도 없는 것 ≈38 · 멈춘 자리가 «전부 노드 안»
    //     (pipeline-node-entry 22 · traversal-shadow 14 · progress-delivery 4).
    //   ⛔ 여기서 「추측」을 적지 않는다 — 아는 것(마지막 노드)만 적고 사유는 `crashed` 로 «구별»한다.
    //     `aborted`(스스로 중단을 판정했다)와 다른 값이다: 이쪽은 판정할 겨를이 «없었다».
    else {
      try {
        observeOuter('run-status', {
          stage: 'crashed', node: terminalNode ?? null,
          runStatus: 'failed', failureKind: 'crashed',
        }, { level: 'warn' });
      } catch { /* fail-soft — 종결 기록 실패가 원래 예외를 덮으면 안 된다 */ }
    }
    emitContext('task-done', `Self-implement ${terminalResult?.stage ?? 'crashed'}: ${opts.feature.split(/\r?\n/, 1)[0]}`,
      terminalResult?.prNumber ?? capturedPrNumber);
    finalizeTraversal();
    try { unregisterProviderErrorSink(); } catch { /* fail-soft — cleanup must not change the terminal result */ }
  }
}

function safeErrorDescription(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '[error description unavailable]';
  }
}


/** ⛔ 회전 스냅샷이 «이미 갖고 있는» 값을 증거 칸으로 옮기는 순수 사상.
 *
 * 🚨 왜 순수 함수로 빼나 — 종전 결손이 정확히 ***「생산자는 갖고 있는데 담는 칸이 좁다」***
 * (`PATTERNS.md` `F41`)였다. 그 좁힘이 «디스크를 타는 함수 안»에 숨어 있어서 테스트가 못 물었다.
 * ⇒ 사상을 밖으로 내면 ***칸이 다시 좁아지는 순간 테스트가 문다***.
 * ⛔ 여기서 판정을 «바꾸지 않는다** — `assessQuotaExhaustion` 의 결론은 그대로다(관측만 넓힌다). */
export function quotaAvailabilityEvidence(snapshot: {
  readonly reason: string;
  readonly candidateCount: number | undefined;
  readonly to?: string;
  readonly currentUsedPercent?: number;
  readonly currentSignalFresh?: boolean;
  readonly thresholdPercent?: number;
  readonly candidates?: readonly { readonly name: string; readonly home: string; readonly usedPercent?: number; readonly reached?: boolean }[];
  readonly freshByHome?: Record<string, boolean>;
}): QuotaAccountAvailabilityEvidence {
  const freshByHome = snapshot.freshByHome ?? {};
  const candidates = snapshot.candidates ?? [];
  const target = snapshot.to === undefined ? undefined : candidates.find((c) => c.name === snapshot.to);
  // ⛔ 「모른다」의 정의는 판정기의 것과 같아야 한다 — 사용률도 도달도 «둘 다» 모를 때다.
  //   한쪽만 보면 「reached=false 인데 사용률 모름」을 「안다」로 잘못 센다.
  const unknownState = candidates.filter((c) => c.usedPercent === undefined && c.reached === undefined).length;
  return {
    reason: snapshot.reason,
    candidateCount: snapshot.candidateCount,
    ...(snapshot.to === undefined ? {} : { to: snapshot.to }),
    // ⛔ 대상을 후보 목록에서 «못 찾으면» 신선도를 «안 낸다** — 모르는 것을 false 로 적지 않는다.
    ...(target === undefined ? {} : { toSignalFresh: freshByHome[target.home] === true }),
    ...(snapshot.currentUsedPercent === undefined ? {} : { currentUsedPercent: snapshot.currentUsedPercent }),
    ...(snapshot.currentSignalFresh === undefined ? {} : { currentSignalFresh: snapshot.currentSignalFresh }),
    ...(candidates.length === 0 ? {} : { unknownStateCandidateCount: unknownState }),
    ...(snapshot.thresholdPercent === undefined ? {} : { thresholdPercent: snapshot.thresholdPercent }),
  };
}

export interface QuotaExhaustionAssessment {
  readonly exhausted: boolean | undefined;
  readonly accountAvailability: QuotaAccountAvailabilityEvidence | undefined;
}

/** Pure account-axis assessment: a below-threshold current account is not exhausted merely because rotation has no candidate. */
export function assessQuotaExhaustion(
  providerName: string | undefined,
  accountAvailability: QuotaAccountAvailabilityEvidence | undefined,
): QuotaExhaustionAssessment {
  if (providerName !== 'openai-codex') return { exhausted: undefined, accountAvailability: undefined };
  // Missing candidate counts are not quota evidence, so represent them as undefined for conditional ledger fields.
  if (!accountAvailability || accountAvailability.candidateCount === undefined) return { exhausted: undefined, accountAvailability: undefined };
  if (accountAvailability.reason === 'no-candidate'
    && accountAvailability.currentUsedPercent !== undefined
    && accountAvailability.thresholdPercent !== undefined
    && accountAvailability.currentUsedPercent < accountAvailability.thresholdPercent) {
    return { exhausted: false, accountAvailability };
  }
  // reset-credit-available 도 쓸 수 있는 계정이 하나도 없다 — 그 권은 사람만 쓴다.
  if (accountAvailability.reason === 'no-candidate' || accountAvailability.reason === 'reset-credit-available') {
    return { exhausted: true, accountAvailability };
  }
  return { exhausted: false, accountAvailability };
}

/** ⭐ provider 가 「쓸 수 있는 Codex 계정이 하나도 없다」고 «말했나» — 회전 판정의 스냅샷만 읽는다.
 *  ⛔ 여기서 네트워크를 «치지 않는다**: 실측으로 그 호출이 2분 넘게 매달린 적이 있고
 *     판정 경로를 그런 것에 매달면 판정층이 피판정층에 의존하게 된다.
 *  ⛔ 그리고 「모른다」와 「안 찼다」를 같은 값으로 적지 않는다 — 스냅샷이 없으면 undefined 다.
 *  ⚠️ 이 읽기는 런이 죽은 «뒤»라 「죽은 원인」이 아니라 「죽을 무렵 찼다」는 상관이다(분류 주석 참조). */
// ⛔⭐ 내보내는 이유는 «테스트 편의»가 아니라 ***여기가 좁힘이 일어나는 자리***라서다.
//   순수 함수만 물면 「스냅샷을 실제로 안 좁히는가」는 원리상 못 문다(`MEAS-T83` 교훈).
export function readQuotaExhausted(
  rotationInspector: typeof inspectCodexRotation = inspectCodexRotation,
  providerName: string | undefined = currentProviderName(),
): QuotaExhaustionAssessment {
  try {
    // ⛔⭐ 프로세스 안 `UsageStore` 를 «읽지 않는다** — 그것은 TUI 기동에서만 채워지므로
    //   headless 하니스 런에서는 비어 있고, 그러면 이 얼굴이 «한 번도 안 뜬다»(1R 이 잡은 자리).
    //   ⇒ fetch 성공 때 남긴 «디스크 신호»를 읽는다(나이 상한이 걸려 있다).
    // ⛔⭐⭐⭐ 그리고 이 신호는 **codex 전용**이다(2R must-fix) — provider 를 «안 보면»
    //   Claude·Grok 으로 돈 런까지 codex 쿼터로 «오분류»한다. 그건 이 PR 이 고치려던
    //   「잡통」의 «반대 방향» 오류다.
    //   호출자는 구현 자식 provider 를 우선 넘긴다. 자식 선택이 없으면 프로세스 기본 provider 로 귀속한다.
    //   부모(리뷰·감독)의 별도 폴백이나 자식 내부 전환은 이 평가의 범위 밖이다.
    const snapshot = rotationInspector();
    // ⭐ 좁히지 않는다 — 스냅샷이 «이미 아는» 것을 증거로 그대로 옮긴다(`quotaAvailabilityEvidence`).
    // ⛔⭐ 「언제 읽었나」를 «값으로» 박는다 — 이 읽기는 런이 «끝난 뒤»다(타입 머리말 참조).
    const evidence = { ...quotaAvailabilityEvidence(snapshot), readPoint: 'postmortem' as const };
    // ⛔⭐ 정본 스토어가 아는 계정이 «0개»면 회전이 구성되지 않은 것이다 — 「쓸 계정 없음」을 소진으로 읽지 않는다.
    //   🩸 P6(2026-09-26 Pod 실물): Pod 는 계정 사본 하나만 받고 회전 목록이 없어 no-candidate → 「할당량 소진」으로
    //     분류됐다. 진짜 원인(게이트의 tsc 127 · P5)이 그 오분류에 가려졌다. 호스트의 진짜 소진(계정은 있는데 전부 찼다)은 그대로다.
    if (snapshot.knownAccountCount === 0) return { exhausted: undefined, accountAvailability: evidence };
    // ⛔⭐ 아는 계정이 «하나»뿐이면 no-candidate 는 «돌릴 곳이 원래 없다»는 뜻이지 «찼다»가 아니다.
    //   🩸 P2 #20869(2026-09-27 Pod 실물): Pod 는 배분받은 계정 사본 «하나»(third · 잔량 넉넉)만 갖고 그 계정의 사용률 신호가
    //     없었다 → 회전은 no-candidate → 「할당량 소진」으로 분류돼 진짜 원인(리뷰 UNCONVERGEABLE)을 가렸다.
    //   ⇒ 그 한 계정의 사용률도 도달 신호도 없으면 «모름». 사용률을 알면 종전 판정(임계 미만=false · 이상=true)에 맡긴다.
    if (snapshot.knownAccountCount === 1 && evidence.reason === 'no-candidate' && snapshot.currentUsedPercent === undefined && snapshot.currentReached !== true) {
      return { exhausted: undefined, accountAvailability: evidence };
    }
    return assessQuotaExhaustion(providerName, evidence);
  } catch {
    return { exhausted: undefined, accountAvailability: undefined };   // fail-soft — 관측은 결론을 막지 않는다
  }
}

/**
 * ⭐ **순수 판정** — codex 쿼터 신호를 이 런에 «적용해도 되는가».
 * ⛔ 이것을 순수 함수로 뽑은 이유: 주변 config 에 기대면 그 «분기»가 시험되지 않는다.
 *    실측 2026-08-05 — 처음엔 통합 테스트로 짰는데, 이 환경의 기본 provider 가 codex 라
 *    게이트를 «지워도 통과»했다(`F18`: 대역/환경이 한쪽 분기를 영영 안 실행시킨다).
 */
/** ⚠️⭐ **현재 운영 호출자 «0개»다** (2026-08-18 리뷰 should-fix · 전수: 이 정의 1 ⊕ 테스트 8).
 *  종전 유일 호출자 `readQuotaExhausted` 가 계정 축을 보는 `assessQuotaExhaustion` 으로 옮겨 갔다.
 *  ⛔ 지우지 않는 이유: 이 착지의 골이 «계약 보존»을 불변식으로 요구했다. 그래서 «의도적으로» 남긴다.
 *  ⛔ 그러나 「남겼다」와 「쓰인다」는 다르다 — 다음 창은 이 줄을 보고 «지울지»를 판단하라.
 *  📌 그리고 이 자리가 이 저장소의 그 형태다: ***부품은 있고 그것을 부르는 자리가 없다.***
 *     (관측 축의 `OBS-T84`·`#9851`·`#9860` 과 같은 형태 · 여기선 «불변식이 만들어 냈다») */
export function quotaSignalAppliesTo(providerName: string | undefined, signal: boolean | undefined): boolean | undefined {
  if (providerName !== 'openai-codex') return undefined;   // ⛔ 모르면 «안 쓴다» — 오분류보다 미분류가 낫다
  return signal;
}

/** 이 프로세스의 기본 provider 이름. ⛔ 못 읽으면 undefined — 그러면 신호를 «안 쓴다». */
function currentProviderName(): string | undefined {
  try {
    return resolveDefaultProvider().name;
  } catch {
    return undefined;
  }
}

/** Skip Git subprocesses when the checkout is missing — fake `/wt/…` test paths and vanished worktrees must not hang classification. */
function unfinishedWorktreeObservation(worktreePath: string | undefined): {
  worktreePorcelain: string | undefined;
  gitResidue: ReturnType<typeof gateGitResidue> | undefined;
} {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { worktreePorcelain: undefined, gitResidue: undefined };
  }
  return {
    worktreePorcelain: readWorktreePorcelain(worktreePath),
    gitResidue: gateGitResidue(worktreePath, Date.now(), observeGitResidue(worktreePath)),
  };
}

export function attachAbandonedClassification(
  result: SelfImplementResult,
  goalFile: string | undefined,
  providerError: boolean,
  credentialFailure = false,
  rotationInspector: typeof inspectCodexRotation = inspectCodexRotation,
  providerName: string | undefined = currentProviderName(),
): SelfImplementResult {
  if (!isAbandonedClassificationOutcome(result.outcome)) return result;
  // Inner terminal paths carry their original snapshot; only outer-only failures need one assessment here.
  const quotaExhaustionAssessment = result.quotaExhaustionAssessment
    ?? readQuotaExhausted(rotationInspector, providerName);
  const worktree = unfinishedWorktreeObservation(result.worktreePath);
  return {
    ...result,
    quotaExhaustionAssessment,
    abandonedClassification: classifyAbandonedRun({
      ...(goalFile ? { goalType: goalTypeFields(goalFile).goalType } : {}),
      ...(quotaExhaustionAssessment.exhausted ? { quotaExhausted: true } : {}),
      ...(quotaExhaustionAssessment.accountAvailability ? { quotaAccountAvailability: quotaExhaustionAssessment.accountAvailability } : {}),
      ...(credentialFailure ? { credentialFailure: true } : {}),
      ...(providerError ? { providerError: true } : {}),
      ...(providerError && result.providerErrors?.category ? { providerErrorCategory: result.providerErrors.category } : {}),
      worktreePorcelain: worktree.worktreePorcelain,
      ...(worktree.gitResidue ? { gitResidue: worktree.gitResidue } : {}),
      ...(result.completionDisposition ? { completionDisposition: result.completionDisposition } : {}),
      ...(result.supervisorVerdict ? { supervisorVerdict: result.supervisorVerdict } : {}),
      ...(result.goalCauseObserved ? { goalCauseObserved: true } : {}),
      ...(result.mergeApprovalReceived ? { mergeApprovalReceived: true } : {}),
      ...(result.citedEvidenceExists === true ? { citedEvidenceExists: true } : {}),
      stage: result.stage,
      reviewResultObserved: result.review !== undefined,
      mustFixReported: (result.review?.mustFix.length ?? 0) > 0,
    }),
  };
}

function signalIncompleteState(roundClassifications: readonly LifecycleScreenComparison[]): {
  latestSignalIncomplete: boolean;
  priorSignalIncomplete: boolean;
} {
  return {
    latestSignalIncomplete: roundClassifications.at(-1) === 'signal-incomplete',
    priorSignalIncomplete: roundClassifications.slice(0, -1).some((classification) => classification === 'signal-incomplete'),
  };
}

/** ⚠️ `export` 는 계약이다 — `run-status-mapping.test.ts` 가 이 심볼을 import 한다.
 *  빼면 그 파일이 **파싱 단계에서** 죽어(`SyntaxError: Export named … not found`)
 *  테스트가 실패하는 것이 아니라 **아예 안 돌고**, 전체 스위트에서는 한 줄로 묻힌다. */
export function observeRunOutcome(
  observe: ReturnType<typeof makeRunObserver>,
  result: Pick<SelfImplementResult, 'node' | 'stage'> & {
    outcome: SelfImplementResult['outcome'] | undefined;
    worktreePath: SelfImplementResult['worktreePath'] | undefined;
    review: SelfImplementResult['review'] | undefined;
    completionDisposition: SelfImplementResult['completionDisposition'] | undefined;
    supervisorVerdict: SelfImplementResult['supervisorVerdict'] | undefined;
    goalCauseObserved?: SelfImplementResult['goalCauseObserved'];
    mergeApprovalReceived: SelfImplementResult['mergeApprovalReceived'] | undefined;
    citedEvidenceExists?: SelfImplementResult['citedEvidenceExists'];
    abandonedClassification: SelfImplementResult['abandonedClassification'] | undefined;
    providerErrors?: SelfImplementResult['providerErrors'];
    activeProvider?: { provider?: string; model?: string };
    quotaExhaustionAssessment?: SelfImplementResult['quotaExhaustionAssessment'];
    mergeReason: SelfImplementResult['mergeReason'] | undefined;
    followUpMustFix?: SelfImplementResult['followUpMustFix'];
    followUpMustFixCount?: SelfImplementResult['followUpMustFixCount'];
    prNumber?: SelfImplementResult['prNumber'];
    prUrl?: SelfImplementResult['prUrl'];
    completionStatus?: SelfImplementResult['completionStatus'];
    reviewReflectRejectedCount?: SelfImplementResult['reviewReflectRejectedCount'];
  },
  roundClassifications: readonly LifecycleScreenComparison[] = [],
): void {
  const nodes = nodesForStage(result.stage);
  observe('pipeline-shape-shadow', {
    stage: result.stage,
    node: result.node,
    nodes,
    ambiguous: AMBIGUOUS_STAGES.has(result.stage),
    declared: nodes.length > 0,
  });
  // ⛔ 분류 관측은 `mapStageToRunStatus` 의 early return **앞**에 둔다(리뷰 should-fix).
  //    미매핑 stage 로 죽은 abandoned 런에서 분류가 조용히 빠지면, 이 기능이 막으려던
  //    바로 그 병(관측 공백)을 이 기능 자신이 만든다.
  if (isAbandonedClassificationOutcome(result.outcome)) {
    const abandoned = result.abandonedClassification ?? classifyAbandonedRun({
      worktreePorcelain: result.worktreePath ? readWorktreePorcelain(result.worktreePath) : undefined,
      ...(result.worktreePath ? { gitResidue: gateGitResidue(result.worktreePath, Date.now(), observeGitResidue(result.worktreePath)) } : {}),
      ...(result.completionDisposition ? { completionDisposition: result.completionDisposition } : {}),
      ...(result.supervisorVerdict ? { supervisorVerdict: result.supervisorVerdict } : {}),
      ...(result.goalCauseObserved ? { goalCauseObserved: true } : {}),
      ...(result.mergeApprovalReceived ? { mergeApprovalReceived: true } : {}),
      ...(result.citedEvidenceExists === true ? { citedEvidenceExists: true } : {}),
      ...(result.quotaExhaustionAssessment?.exhausted ? { quotaExhausted: true } : {}),
      ...(result.quotaExhaustionAssessment?.accountAvailability ? { quotaAccountAvailability: result.quotaExhaustionAssessment.accountAvailability } : {}),
      ...(result.providerErrors?.category ? { providerError: true, providerErrorCategory: result.providerErrors.category } : {}),
      stage: result.stage,
      reviewResultObserved: result.review !== undefined,
      mustFixReported: (result.review?.mustFix.length ?? 0) > 0,
    });
    observe('abandoned-classification', {
      ...abandoned,
      ...abandonedProviderMetadata(abandoned, result.activeProvider),
    }, { level: 'warn' });
  }
  const outcome = mapStageToRunStatus(result.stage);
  if (!outcome) return;
  const { latestSignalIncomplete, priorSignalIncomplete } = signalIncompleteState(roundClassifications);
  const effectiveOutcome = latestSignalIncomplete
    ? { runStatus: 'failed' as const, failureKind: 'review' as const }
    : outcome;
  observe('run-status', {
    stage: result.stage, node: result.node, ...effectiveOutcome,
    ...(latestSignalIncomplete ? { completionBlockedBy: 'signal-incomplete' } : {}),
    ...(priorSignalIncomplete ? { priorSignalIncomplete: true } : {}),
    ...(result.completionStatus ? { completionStatus: result.completionStatus } : {}),
    ...(result.reviewReflectRejectedCount !== undefined ? { reviewReflectRejectedCount: result.reviewReflectRejectedCount } : {}),
    ...(result.mergeReason ? { mergeReason: result.mergeReason } : {}),
    ...(result.mergeReason === 'review-budget-follow-up-required' && result.followUpMustFix !== undefined
      ? { followUpMustFix: result.followUpMustFix }
      : {}),
    ...(result.mergeReason === 'review-budget-follow-up-required' && result.followUpMustFixCount !== undefined
      ? { followUpMustFixCount: result.followUpMustFixCount }
      : {}),
    ...(result.mergeReason === 'review-budget-follow-up-required' && result.prNumber !== undefined
      ? { prNumber: result.prNumber }
      : {}),
    ...(result.mergeReason === 'review-budget-follow-up-required' && result.prUrl !== undefined
      ? { prUrl: result.prUrl }
      : {}),
  }, effectiveOutcome.runStatus === 'failed' ? { level: 'warn' } : undefined);
}

/** Last-line rollup PR slot: a real number, explicit absence, or unknown. Never invent a number. */
type RollupPrNumber = number | 'none' | 'unknown';

function recordedPrNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rollupPrNumber(
  result: Pick<SelfImplementResult, 'prNumber'>,
  capturedPrNumber: number | undefined,
  openPrInvoked: boolean,
): RollupPrNumber {
  return recordedPrNumber(result.prNumber)
    ?? recordedPrNumber(capturedPrNumber)
    ?? (openPrInvoked ? 'unknown' : 'none');
}

function observeRunRollup(
  observe: ReturnType<typeof makeRunObserver>,
  result: Pick<SelfImplementResult, 'node' | 'stage' | 'prNumber' | 'completionStatus' | 'reviewReflectRejectedCount'>,
  roundClassifications: readonly LifecycleScreenComparison[],
  roundCount: number,
  capturedPrNumber: number | undefined,
  openPrInvoked: boolean,
): void {
  const outcome = mapStageToRunStatus(result.stage);
  if (!outcome) return;
  const { latestSignalIncomplete, priorSignalIncomplete } = signalIncompleteState(roundClassifications);
  const effectiveOutcome = latestSignalIncomplete
    ? { runStatus: 'failed' as const, failureKind: 'review' as const }
    : outcome;
  observe('run-rollup', {
    stage: result.stage,
    runStatus: effectiveOutcome.runStatus,
    ...(effectiveOutcome.failureKind ? { failureKind: effectiveOutcome.failureKind } : {}),
    roundClassifications,
    roundCount,
    ...(latestSignalIncomplete ? { completionBlockedBy: 'signal-incomplete' } : {}),
    ...(priorSignalIncomplete ? { priorSignalIncomplete: true } : {}),
    ...(result.completionStatus ? { completionStatus: result.completionStatus } : {}),
    ...(result.reviewReflectRejectedCount !== undefined ? { reviewReflectRejectedCount: result.reviewReflectRejectedCount } : {}),
    prNumber: rollupPrNumber(result, capturedPrNumber, openPrInvoked),
  }, effectiveOutcome.runStatus === 'failed' ? { level: 'warn' } : undefined);
}

async function runSelfImplementInner(
  opts: SelfImplementOptions,
  identity?: { runId: string; source: ReturnType<typeof resolveRunIdentity>['source'] },
  attemptOrdinal: AttemptOrdinal = UNMEASURED_ATTEMPT_ORDINAL,
  shardIdentity: RunShardIdentity = { pieceTotal: 1 },
  onNodeEntry: (node: PipelineNodeId, round: number) => void = () => {},
  onRoundClassification: (classification: LifecycleScreenComparison) => void = () => {},
  onWorktreeCreated: (path: string) => void = () => {},
  onRoundExecution: (tier: EscalateTier) => void = () => {},
  onReviewFindings: (round: number, mustFix: readonly string[]) => void = () => {},
  /** ⭐ 이 런이 «따르는» 그래프 신원 — 맥락이 정해진 «직후» 한 번 불린다.
   *  ⛔ 이것이 없으면 걸음은 YAML 을 따르고 «신원은 옛 TS 상수»를 따라 둘이 갈린다. */
  onGraphResolved: (identity: { graphId: string; graphVersion: string }) => void = () => {},
  /** ⛔ 신원과 «별개»다 — 예산은 노드 목록을 봐야 하고 신원은 두 문자열이다. */
  onGraphTemplateResolved: (template: GraphTemplate) => void = () => {},
  /**
   * ⭐ 「요구 증거 충족」을 바깥으로 나른다 — ⛔ return 지점이 «열다섯»이라 각각에 실으면 누락이 난다.
   *   📍 이 파일이 이미 쓰는 콜백 인자 패턴(onNodeEntry·onReviewFindings …)을 그대로 따른다(재발명 0).
   */
  onEvidenceCoverage: (summary: { required: number; covered: number; uncovered: number }) => void = () => {},
  reviewFindingTelemetry: () => NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']> = () => ({ citedReviewSymbolOccurrences: [], normalizedReviewFindingRepeatCounts: [], symbolKeyedReviewFindingCount: 0, proseFallbackReviewFindingCount: 0 }),
  /** ⛔ 테스트 주입 심. ⭐ 기본이 «null 을 내는 것»이라 종전엔 이 축이 영영 안 떴다 —
   *  이제 null 이면 measureReviewFindingRecurrence 가 «실제로» 잰다. */
  reworkBudgetReviewFindingRecurrence: () => ReviewFindingRecurrence | null = () => null,
  onMergeApprovalReceived: () => void = () => {},
  onAutoMergeAuthorizedBeforeSync: () => void = () => {},
  onSupervisorVerdictParsed: (verdict: ReworkBudgetVerdict) => void = () => {},
  onSupervisorReasonParsed: (reason: string | undefined) => void = () => {},
  onResolvedBase: (base: string | null) => void = () => {},
  onObservationMeasurementBasis: (basis: ObservationMeasurementBasis) => void = () => {},
  onClarificationTimeout: (timeout: Pick<GoalExecutionRecord, 'clarificationTimeoutUnanswered' | 'clarificationTimeoutQuestionIds' | 'clarificationUnansweredOutcome'>) => void = () => {},
  hasProviderError: () => boolean = () => false,
  hasCredentialFailure: () => boolean = () => false,
  providerErrorCategory: () => NonNullable<SelfImplementResult['providerErrors']>['category'] | undefined = () => undefined,
  onReviewReflectRejected: (rejectedCount: number) => void = () => {},
  observe: ReturnType<typeof makeRunObserver> = makeRunObserver(identity?.runId ?? resolveRunIdentity({ explicit: opts.runId }).runId, opts.goalId, debug.log.bind(debug), opts.seams.writeRunLedger, shardIdentity),
  /** ⭐ 「이 런이 «실제로» 어느 두뇌로 돌았나」를 원장까지 나른다 — ⛔ 기록 «시점»에 다시 읽지 않는다
   *  (그러면 「런이 끝날 무렵의 provider」가 되어 `F45` 를 그대로 밟는다). 시작 시점 값을 넘긴다. */
  onActiveProvider: (active: { provider?: string; model?: string; auth?: string }) => void = () => {},
  onSessionCreated: (sessionId: string) => void = () => {},
  onRunContractResolved: (contract: RunContract) => void = () => {},
  onFailureVerdict: (kind: 'gate' | 'review') => Promise<void> = async () => {},
  hasObservedProviderError: () => boolean = hasProviderError,
  hasObservedCredentialFailure: () => boolean = hasCredentialFailure,
  hasCurrentProviderError: () => boolean = hasProviderError,
  hasCurrentCredentialFailure: () => boolean = hasCredentialFailure,
): Promise<Omit<SelfImplementResult, 'runId'>> {
  const s = opts.seams;
  const pipelineStartedAtMs = Date.now();
  // Graph authority is always ON; retain the resolved event with default provenance.
  // For research documents, its declared docs-only routing intentionally skips the gate.
  const graphAuthority = resolveGraphAuthorityForUserConfig();
  // ⛔ 골 파일이 «없을 수» 있다 — 그때는 골 종류를 모르므로 implement-loop 으로 간다(없는 길로 안 보낸다).
  // ⭐ 대표 지시 ② «변형» — 「최초 결정 시 해당 템플릿 변형을 한다」.
  const graphGoalType = opts.goalFile === undefined ? undefined : (goalTypeFields(opts.goalFile).goalType as GoalType | undefined);
  // ⛔ 오버레이는 «한 번» 읽는다 — 라운드마다 디스크를 읽으면 도는 중에 파일이 바뀌어 걸음이 갈린다.
  // ⛔ 이름이 `graph`인 이유: launch(②)·runtime(③) «둘 다» 이 목록에서 고른다. 단계는 인자로 갈린다.
  const graphOverlays = opts.graphOverlays ?? loadGraphOverlays(defaultOverlaysDir()).overlays;
  // ⛔ 「최초 결정」이 아는 상태만 준다 — 없는 값을 0 으로 «지어내지» 않는다(key-absent 가 그것을 말한다).
  const launchOverlayState = { ...(opts.goalId === undefined ? {} : { goal_id: opts.goalId }) };
  const graphDecision = decideTemplate({
    goalType: graphGoalType,
    authority: graphAuthority,
    overlays: graphOverlays,
    stage: 'launch',
    state: launchOverlayState,
  });
  // ⛔⭐ `let` 인 이유는 ③ «다이나믹»이다 — 라운드마다 runtime 오버레이가 «앞을 보는 것»만 바꾼다.
  //   ⛔ 지난 노드를 재정의하지 않는다(RFC §6: 그러면 원장을 사후에 해석할 수 없다).
  let graphTemplate = graphDecision.template;
  let variantSpec: import('./graph-yaml.js').GraphTemplateSpec | undefined;
  if (opts.graphVariantPlan !== undefined) {
    const { GRAPH_SPECS, specToTemplate } = await import('./graph-templates.js');
    const { graphVersionHash } = await import('./graph-yaml.js');
    const { applyGraphOverlays } = await import('./graph-overlay-yaml.js');
    const { createGraphVariant } = await import('./graph-variant.js');
    const { runLedgerPath } = await import('./run-ledger.js');
    const { stringify } = await import('yaml');
    const baseSpec = GRAPH_SPECS[graphTemplate.graphId];
    const variantRunId = identity?.runId ?? opts.runId;
    if (!baseSpec || !variantRunId || graphDecision.rejections.length) {
      throw new Error('graph variant rejected: missing graph specification, run identity, or valid launch overlay');
    }
    const launch = graphDecision.appliedIds.length
      ? applyGraphOverlays(baseSpec, graphOverlays.filter(overlay => graphDecision.appliedIds.includes(overlay.overlayId)))
      : undefined;
    if (launch && !launch.ok) throw new Error(`graph variant rejected: ${JSON.stringify(launch.rejections)}`);
    const sourceSpec = launch?.ok ? launch.template : baseSpec;
    const variant = createGraphVariant({ template: sourceSpec, goal: `g_${variantRunId.replace(/[^a-z0-9_-]/gi, '_')}`, plan: opts.graphVariantPlan });
    if (!variant.ok) throw new Error(`graph variant rejected: ${JSON.stringify(variant.rejections)}`);
    variantSpec = variant.template;
    graphTemplate = { ...specToTemplate(variantSpec), version: graphVersionHash(variantSpec) };
    const { runLedgerDir } = await import('./run-ledger.js');
    const graphFile = `${runLedgerPath(variantRunId)}.graph.yaml`;
    mkdirSync(runLedgerDir(), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(graphFile, stringify({
      graph_id: variantSpec.graphId, version: variantSpec.version,
      entry_node: variantSpec.entryNode, terminal_nodes: variantSpec.terminalNodes,
      ...(variantSpec.runContract ? { run_contract: variantSpec.runContract } : {}),
      nodes: variantSpec.nodes.map(n => ({
        node_id: n.nodeId, kind: n.kind, recipe: n.recipe, max_visits: n.maxVisits,
        ...(n.progress ? { progress: n.progress } : {}), ...(n.phases ? { phases: n.phases } : {}),
        ...(n.terminalStages ? { terminal_stages: n.terminalStages } : {}),
        ...(n.fanOut ? { fan_out: n.fanOut } : {}), ...(n.contract ? { contract: n.contract } : {}),
      })),
      edges: variantSpec.edges.map(e => ({
        from: e.from, ...(e.to === undefined ? { on: e.on, map: e.map } : { to: e.to }),
        ...(e.fallback ? { fallback: e.fallback } : {}),
        ...(e.observed === undefined ? {} : { observed: e.observed }),
      })),
    }), { flag: 'wx' });
    observe('graph-variant-applied', { graphId: variant.template.graphId, overlayId: variant.overlay.overlayId,
      graphFile, patches: variant.patches });
  }
  /** 단계 이름 → 그 템플릿의 노드 이름. */
  const node = (stage: PipelineNodeId): PipelineNodeId => nodeNameForStage(stage, graphTemplate) as PipelineNodeId;
  // ⛔⭐ 맥락이 정해진 «직후» 관측기에 심는다 — 이 줄이 없으면 걸음은 YAML 을 따르고 «신원은 안 따른다».
  onGraphResolved(graphIdentityOf(graphTemplate));
  // 권위는 항상 켜지지만 이벤트의 필드 모양은 유지하고 출처를 default로 기록한다.
  observe('graph-authority-resolved', graphAuthorityFields(graphAuthority, graphTemplate));
  // ⭐ 런 계약 — 런 시작 «한 번» 해석한다(대표 2026-09-26 «초반 계약을 노드가 준수»). 해석 출처(source)와
  //   실제 칸(actualSubstrate)을 같이 남겨 「계약이 Pod 인데 로컬에서 돌았나」를 원장이 답하게 한다.
  //   노드 진입 대조는 관측만 하며 실행을 막지 않는다.
  {
    const { resolveRunContract } = await import('./graph-run-contract.js');
    const runContract = resolveRunContract({ ...(graphTemplate.runContract ? { graph: graphTemplate.runContract } : {}), env: process.env });
    onRunContractResolved(runContract);
    observe('graph-run-contract-resolved', { ...graphIdentityOf(graphTemplate), ...runContract, ...runContractAtNode(runContract) });
  }
  // ⛔ 승격이 꺼져 있으면 «심지 않는다» — 그러면 예산 관측도 안 난다(운영 원장이 오늘과 같다).
  if (graphAuthority.enabled) onGraphTemplateResolved(graphTemplate);
  // ⛔ 선택을 «전부» 싣는다 — 얹힌 것만 실으면 「왜 안 얹혔나」를 사후에 못 묻는다.
  /** ⭐ ③ «다이나믹» — 라운드마다 runtime 오버레이를 다시 고른다.
   *  ⛔ **매번 «기준 선언»에서 다시 얹는다** — 이전 라운드 결과 위에 겹쳐 얹으면
   *    「이 걸음을 무엇이 만들었나」가 «누적»이 되어 사후에 못 푼다.
   *  오버레이 적용은 기존 실행 경로를 그대로 따른다. */
  const applyRuntimeOverlays = (round: number): void => {
    if (!graphAuthority.enabled) return;
    // ⛔ 「지금 아는 것」만 준다 — 없는 값을 0 으로 지어내지 않는다(key-absent 가 그것을 말한다).
    const runtimeOverlayState = { attempts: round, ...(opts.goalId === undefined ? {} : { goal_id: opts.goalId }) };
    const decision = decideTemplate({
      goalType: graphGoalType,
      authority: graphAuthority,
      overlays: graphOverlays,
      state: runtimeOverlayState,
      stage: 'runtime',
      ...(variantSpec ? { specs: { [variantSpec.graphId]: variantSpec } } : {}),
    });
    if (decision.appliedIds.length > 0) graphTemplate = decision.template;
    // ⛔⭐ 승격이 켜져 있으면 «언제나» 낸다 — 후보가 0이어도 낸다.
    //   🩸 안 내면 「얹을 게 없었다」와 「이 배선이 «안 돌았다»」가 원장에서 «같은 값»(0건)이 된다.
    //   ⇒ `considered` 가 그 둘을 가른다: 배선이 돌면 이 줄이 있고, 그 수가 «본 오버레이 수»다.
    observe('graph-overlay-decision', overlayDecisionObservation({
      ...graphIdentityOf(graphTemplate),
      stage: 'runtime', round,
      considered: graphOverlays.length,
      applied: decision.appliedIds,
      appliedPatches: decision.appliedPatches,
      selections: decision.selections,
      rejections: decision.rejections,
      state: runtimeOverlayState,
    }));
  };
  // ⛔ runtime 과 «같은 규율» — 켜져 있으면 후보가 0이어도 낸다(안 내면 「안 돌았다」와 구별 불가).
  if (graphAuthority.enabled) {
    // ⛔ 파이프라인 «걸음»과 다른 사건 이름을 쓴다 — 오버레이 결정은 노드 진입이 «아니다».
    //   섞으면 「이 런이 몇 노드를 밟았나」가 오염된다.
    observe('graph-overlay-decision', overlayDecisionObservation({
      ...graphIdentityOf(graphTemplate),
      stage: 'launch',
      considered: graphOverlays.length,
      applied: graphDecision.appliedIds,
      appliedPatches: graphDecision.appliedPatches,
      selections: graphDecision.selections,
      rejections: graphDecision.rejections,
      state: launchOverlayState,
    }));
  }
  const T: StepTimeouts = { ...DEFAULT_STEP_TIMEOUTS, ...(opts.stepTimeouts ?? {}) };
  const stepTimeout = s.withStepTimeout ?? withStepTimeout;
  const roundClassifications: LifecycleScreenComparison[] = [];
  let completionStatus: SelfImplementResult['completionStatus'];
  let completionDisposition: SelfImplementCompletionDisposition | undefined;
  const recordRoundClassification = (classification: LifecycleScreenComparison): void => {
    roundClassifications.push(classification);
    onRoundClassification(classification);
  };
  const { runId, source: runIdSource } = identity ?? resolveRunIdentity({ explicit: opts.runId });
  const branch = opts.branchName ?? plannedSelfImplBranch(opts.feature, opts.goalId, runId);
  try {
    debug.log('run-identity', 'own', {
      runId, branch, source: runIdSource, nestDepth: nestInfo().depth, ...originObservationFields(),
    });
  } catch { /* fail-soft */ }

  const progress = (stage: SelfImplementProgressStage, message: string): void => {
    logRunAwareFailSoft(runId, stage, { message: message.slice(0, MAX_PROGRESS_MESSAGE_CHARS) });
    try { s.onProgress?.({ stage, message }); } catch { /* best-effort */ }
  };
  // A goal file produced while dispatching natural language is a run artifact, not its origin.
  // Explicit natural-language provenance must therefore win over file presence; file-only runs remain authored.
  const goalSource = opts.naturalLanguageDispatch
    ? 'natural-language-dispatch'
    : opts.goalFile
      ? 'authored-goal-file'
      : 'no-goal-file';
  let activeProvider: Pick<ActiveProviderInfo, 'provider' | 'model' | 'auth'> | {
    provider: 'unknown'; model: 'unknown'; auth: 'unknown';
  };
  try {
    activeProvider = (s.inspectActiveProvider ?? inspectActiveProvider)();
  } catch {
    activeProvider = { provider: 'unknown', model: 'unknown', auth: 'unknown' };
  }
  // ⭐ 관측 이벤트와 «같은 값»을 원장으로도 보낸다 — 로그에만 있으면 원장 질의가 못 센다(`F12`).
  try { onActiveProvider(activeProvider); } catch { /* 보조 기록이 런을 죽이지 않는다 */ }
  const boundedFeature = boundReadableText(opts.feature, RUN_START_FEATURE_MAX_CHARS);
  const launchCwd = resolve(process.cwd());
  observe('start', {
    feature: boundedFeature.text, featureTruncated: boundedFeature.truncated, featureOriginalChars: boundedFeature.originalChars,
    branch, base: opts.base ?? null, draft: opts.draft ?? true,
    willFork: !!(opts.parentSessionId && s.forkSession), parentSessionId: opts.parentSessionId ?? null,
    nestDepth: nestInfo().depth, goalSource, goalFile: opts.goalFile === undefined ? null : resolve(launchCwd, opts.goalFile),
    targetRoot: gitRootOf(launchCwd) ?? launchCwd, ...originObservationFields(),
    provider: activeProvider.provider ?? null, model: activeProvider.model ?? null, auth: activeProvider.auth ?? null,
    ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
  });
  try {
    await (s.refreshCodexQuotaSignals ?? refreshCodexQuotaSignals)();
    observe('quota-refresh', { status: 'completed' });
  } catch (error) {
    observe('quota-refresh', {
      status: 'failed',
      reason: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    }, { level: 'warn' });
  }

  const { describeRole } = await import('../agent-substrate/execution/roles.js');
  const { resolveActiveCapabilities } = await import('../agent-substrate/execution/capabilities.js');
  const siEntry = opts.entry ?? 'external-verbatim';
  const siCaps = resolveActiveCapabilities('self-implement', {
    entry: siEntry,
    ...(opts.enhance !== undefined ? { explicitEnhance: opts.enhance } : {}),
  });
  const enhanceActive = siCaps.has('enhance');
  observe('role', {
    role: describeRole({ role: 'executor', executorKind: 'self' }),
    entry: siEntry, capabilities: [...siCaps.active], enhanceActive,
  });
  progress('start', `🔨 self-implement 시작 — ${prTitle(opts.feature)}`);

  let sessionId: string | undefined;
  if (opts.parentSessionId && s.forkSession) {
    // 하니스 자식 신분은 defaultSeams.forkSession 이 origin='harness' 로 남긴다.
    sessionId = await s.forkSession(opts.parentSessionId);
    onSessionCreated(sessionId);
    observe('forked', { sessionId, parent: opts.parentSessionId });
    progress('forked', '세션 포크(계보 보존)');
  }

  let goalContext: Pick<import('../harness/harness-worktree-add.js').HarnessWorktreeGoalMetadata, 'goalTitle' | 'goalDescription' | 'goalDescriptionSource'> = {};
  if (s.synthesizeGoalContext) {
    try {
      goalContext = await s.synthesizeGoalContext({ goalFile: opts.goalFile });
    } catch {
      observe('goal-context-failed', { goalFile: opts.goalFile ?? null }, { level: 'warn' });
    }
  }
  progress('worktree', `격리 worktree 생성 (${branch})`);
  const wt = await withStepTimeout(s.createWorktree({
    branch,
    runId,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.goalId?.trim() ? { goalId: opts.goalId } : {}),
    ...(opts.goalFile?.trim() ? { goalFile: opts.goalFile } : {}),
    ...goalContext,
  }), T.worktree, 'worktree');
  onWorktreeCreated(wt.path);
  // ⭐ 제1원칙 — **어디서 갈랐나**를 관측에 남긴다. 이것이 없어서 2026-07-29 에 하니스 런 둘이
  //   `main` 위에서 돌았고(호출자가 브랜치 워크트리에서 발사했는데도) 산출 diff 를 눈으로 봐야 알았다.
  //   ⚠️ `branch` 는 **새로 만든 브랜치 이름**이라 그 질문에 답하지 않는다.
  //   ⛔ 모르는 값은 `null` 이다 — 빈 문자열로 채우면 "안 갈렸다" 처럼 읽힌다.
  const resolvedBase = wt.resolvedBase ?? null;
  onResolvedBase(resolvedBase);
  const invokedHead = wt.invokedHead ?? null;
  const baseIsIntegration = wt.baseIsIntegration ?? null;
  const requestedBase = opts.base ?? null;
  const requestedBaseSource = opts.baseSource ?? (requestedBase === null ? 'automatic' : 'human');
  observe('worktree', {
    path: wt.path,
    branch: wt.branch,
    // ⭐ 우리가 **무엇을 요청했는지는 이미 안다** — 시임 반환에서 되읽지 않는다.
    //    커스텀 시임이 관측 필드를 생략하면 명시/생략이 둘 다 null 이 되어 구분이 사라진다(리뷰 must-fix).
    requestedBase,
    requestedBaseSource,
    baseSelectionRule: opts.baseSelectionRule ?? null,
    resolvedBase,
    invokedHead,
    baseIsIntegration,
    owner: wt.owner ?? null,
    command: wt.command ?? null,
    createdAt: wt.createdAt ?? null,
    provenanceError: wt.provenanceError ?? null,
    // 둘 다 알 때만 비교가 의미를 갖는다. 하나라도 모르면 판정하지 않는다(null).
    invokedHeadDiffers: resolvedBase !== null && invokedHead !== null ? resolvedBase !== invokedHead : null,
  });
  // ⛔ 발사 부모(`harness ask`·`dev`)에는 ELANOUS_HARNESS_SPACE_ID 가 «없다» — 그 env 는 자식에게만 심긴다.
  //   그래서 getHarnessSpace() 만 보면 운영에서 늘 undefined 이고 정지 확인이 «한 번도» 안 돈다(#20040 착지 직후 실측).
  //   `self send <space> --stop` 이 겨냥하는 것은 자식의 공간 = 워크트리 이름이다(아래 activeChildInboxId 와 같은 식 · dev-cli.ts recordRestart 폴백과 같다).
  const parentSoftStopSpaceId = s.parentSoftStopSpaceId || getHarnessSpace()?.id || normalizeSpaceId(basename(wt.path)) || undefined;
  const readParentSoftStop = s.readSoftStopRequestStatus ?? readSoftStopRequestStatus;
  const honorParentSoftStop = (
    beforeNode: 'gate' | 'review' | 'rework' | 'open-pr',
  ): { ok: false; stage: 'soft-stopped'; node: PipelineNodeId; worktreePath: string; branch: string; detail: string } | undefined => {
    if (!parentSoftStopSpaceId) return undefined;
    let read: SoftStopRequestRead;
    try {
      read = readParentSoftStop(parentSoftStopSpaceId);
    } catch (error) {
      observe('soft-stop-read-failed', {
        beforeNode,
        spaceId: parentSoftStopSpaceId,
        error: error instanceof Error ? error.message : String(error),
      }, { level: 'warn' });
      return undefined;
    }
    if (read.status === 'absent') return undefined;
    if (read.status === 'read-failed') {
      observe('soft-stop-read-failed', {
        beforeNode,
        spaceId: parentSoftStopSpaceId,
        code: read.code,
      }, { level: 'warn' });
      return undefined;
    }
    const requestedAtMs = Date.parse(read.request.requestedAt);
    if (!Number.isFinite(requestedAtMs) || requestedAtMs < pipelineStartedAtMs) return undefined;
    observe('soft-stop-honored', {
      beforeNode,
      spaceId: parentSoftStopSpaceId,
      requestedAt: read.request.requestedAt,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    return {
      ok: false,
      stage: 'soft-stopped',
      node: beforeNode === 'open-pr' ? 'open-pr' : beforeNode,
      worktreePath: wt.path,
      branch: wt.branch,
      detail: `soft stop honored before ${beforeNode}`,
    };
  };
  const harnessSeededPaths: string[] = [];
  if (opts.goalFile) {
    try {
      const goalFile = resolve(opts.goalFile);
      const goalFileRelativeToLaunchTree = relative(process.cwd(), goalFile);
      if (!goalFileRelativeToLaunchTree || goalFileRelativeToLaunchTree.startsWith(`..${sep}`) || isAbsolute(goalFileRelativeToLaunchTree)) {
        throw new Error('goal file is outside the launch repository');
      }
      const targetGoalFile = join(wt.path, goalFileRelativeToLaunchTree);
      if (!existsSync(targetGoalFile)) {
        mkdirSync(resolve(targetGoalFile, '..'), { recursive: true });
        copyFileSync(goalFile, targetGoalFile);
        // 하니스가 깐 것이므로 «자식의 변경»으로 세지 않는다(이미 있던 파일은 깐 것이 아니다).
        harnessSeededPaths.push(goalFileRelativeToLaunchTree.split(sep).join('/'));
      }
    } catch (error) {
      progress('worktree', `⚠️ goal document copy failed; continuing — ${String((error as Error)?.message ?? error).split('\n', 1)[0]}`);
    }
  }
  if (wt.provenanceError) {
    progress('worktree', `⚠️ worktree ownership was not recorded; continuing with ${wt.path} — ${wt.provenanceError}`);
  } else if (wt.owner) {
    progress('worktree', `격리 worktree 준비됨: ${wt.path} · owner=${wt.owner}`);
  }
  if (baseIsIntegration !== true) {
    observe('worktree-base-warning', {
      resolvedBase,
      invokedHead,
      baseIsIntegration,
      requestedBase,
      requestedBaseSource,
      message: baseIsIntegration === false
        ? '⚠️ resolved base is known not to be an ancestor of origin/main.'
        : '⚠️ unable to determine whether resolved base is an ancestor of origin/main.',
    }, { level: 'warn' });
  }
  if (opts.base && opts.base.startsWith('origin/se/')) {
    // ⛔⭐ 해석 실패는 «병합 실패»와 다른 사건이다 — 종전엔 하나의 `catch {}` 가 둘 다 삼켜
    //   「이름이 안 풀렸다」가 관측에서 통째로 사라졌다(리뷰 must-fix).
    const resolved = resolveDefaultBranchTarget(s.defaultBranchRef ?? defaultBranchRef, wt.path);
    if (resolved.target === null) {
      observe('resume-merge', {
        branch: wt.branch, base: opts.base, status: 'default-branch-unresolved',
        mergeTarget: null, defaultBranchResolved: false,
        ...(resolved.error === undefined ? {} : { resolveError: resolved.error }),
      });
    } else {
      const mergeTarget = resolved.target;
      try {
        const mergeMain = s.mergeMain ?? (await import('../autopilot/build/llm-conflict-merge.js')).mergeMainIntoWorktreeWithLlm;
        const outcome = await withStepTimeout(mergeMain(wt.path, mergeTarget), T.merge, 'merge');
        observe('resume-merge', { branch: wt.branch, base: opts.base, status: outcome.status, resolved: outcome.resolvedFiles?.length ?? 0, mergeTarget, defaultBranchResolved: true });
        if (outcome.status === 'conflict-unresolved' || outcome.status === 'error') progress('worktree', `⚠️ ${mergeTarget} 정합 ${outcome.status} → base(${opts.base}) 유지 — 머지된 PR 미반영(수동 정합 가능)`);
      } catch (e) {
        // ⛔ fail-soft 는 유지한다(재개는 계속돼야 한다). 다만 «조용히» 넘어가지 않는다.
        observe('resume-merge', {
          branch: wt.branch, base: opts.base, status: 'merge-failed',
          mergeTarget, defaultBranchResolved: true,
          error: String((e as Error)?.message ?? e).slice(0, 200),
        }, { level: 'warn' });
      }
    }
  }

  let round0Feature = opts.feature;
  if (enhanceActive) {
    const { enhancePrompt } = await import('../prompt-enhance/enhance.js');
    const enh = await enhancePrompt(opts.feature, {
      ...(opts.deliverableHint ? { deliverableHint: opts.deliverableHint } : {}),
    });
    round0Feature = enh.enhanced;
    observe('enhance', {
      checklist: enh.checklist.length, enhancedBy: enh.enhancedBy,
      origChars: enh.original.length, enhancedChars: enh.enhanced.length, verbatimPreserved: enh.verbatimPreserved,
    });
  }

  if (opts.ground) {
    try {
      const groundGoal = s.groundGoal ?? (await import('./ground-goal.js')).groundGoalInCodebase;
      const grounding = await groundGoal(opts.feature, { cwd: wt.path });
      if (grounding) {
        round0Feature = `${grounding}\n\n${round0Feature}`;
        observe('ground', { injected: true, chars: grounding.length });
      } else observe('ground', { injected: false });
    } catch {
      observe('ground', { injected: false, error: true }, { level: 'warn' });
    }
  } else {
    observe('ground', { injected: false, chars: 0 });
  }

  if (opts.memory !== false) {
    const { recallMemoryContext } = await import('../agent-substrate/execution/memory-context.js');
    const mem = await recallMemoryContext(opts.feature.slice(0, 300), { limit: 5 });
    if (mem) {
      round0Feature = `${round0Feature}\n\n${mem}`;
      observe('memory', { injected: true, chars: mem.length });
    } else observe('memory', { injected: false });
  }

  const maxRework = Math.max(0, opts.maxReworkRounds ?? 2);
  const selfImplementConfig = (await import('../user-config.js')).getUserConfig().tools.selfImplement;
  const shadowStop = opts.reworkBudgetShadowStop ?? selfImplementConfig.reworkBudget.shadowStop;
  // ⛔ 형태를 여기서 다시 적지 않는다 — seam 반환형에서 **파생**한다. 종전엔 같은 모양을 둘이 적어서
  //   seam 에 필드를 더해도 이쪽이 모르는 상태가 됐다(오늘 `ReviewDiffContext` 와 같은 뼈 · `F7`).
  let impl!: Awaited<ReturnType<SelfImplementSeams['implement']>>;
  // ★ I-9 — PR 본문에 실을 증거. ⛔ **파서와 같은 소스 규칙**을 쓴다(둘이 갈리면 PR 이 "(없음)" 이라
  //   거짓 표시한다 · 리뷰 4R). 수확본이 비면 **요약에서 수확**한다 — 요약 원문을 통째로 싣지 않는다.
  const harvestedForPr = (): string | undefined => {
    if (!impl) return undefined;
    const fromChild = impl.evidenceTranscript?.trim() ? impl.evidenceTranscript : undefined;
    const picked = fromChild ?? harvestEvidenceLines(impl.summary);
    return picked.trim() ? picked : undefined;
  };
  let offDiffEvidence: OffDiffEvidenceParse = { items: [], discardedMissingVerify: 0, discardedEmptyClaim: 0, missingResult: 0, orphanResult: 0, truncatedResult: 0, anchoredEvidence: 0 };
  let evidenceSource: 'diff-added-lines' | 'harvested' | 'summary-tail' = 'summary-tail';
  // ⛔⭐ 하니스가 센 증거 충족도 — **로그에만 남기면 판정자가 못 본다**(원장 `JDG-S4`·`JDG-S5`).
  let evidenceCoverage: {
    required: number;
    covered: number;
    missing: readonly string[];
    coveredByLimitation: readonly string[];
    uncovered: readonly string[];
    coveredByLimitationCount: number;
    uncoveredCount: number;
    limitationCount: number;
  } | undefined;
  let gate!: SelfImplementGateResult;
  let review: SelfImplementReview | undefined;
  const reviewMustFixCountHistory: number[] = [];
  const reviewMustFixTrend = (): string => {
    if (reviewMustFixCountHistory.length < 2) return '아직 못 잰다';
    return reviewMustFixCountHistory.every((count, index) => index === 0 || count < reviewMustFixCountHistory[index - 1]!)
      ? '줄고 있다'
      : '진동';
  };
  let reworkNote = '';
  /** 예산 판정기에 넘길 현재 지적. 리뷰 라운드는 must-fix 문장만, 그 외는 병합 노트다. */
  let reworkJudgeNote = '';
  let reworkKind: SupervisionReworkSource = 'gate';
  let reworkParts: ReworkNotePart[] = [];
  type PendingSupervisorDelivery = {
    readonly text: string;
    readonly update?: (delivery: SupervisorDeliveryState, reason?: string) => void;
  };
  let supervisorDeliveryUpdates: PendingSupervisorDelivery[] = [];
  const activeChildInboxId = normalizeSpaceId(basename(wt.path));
  const undeliveredSupervisorInputs: UndeliveredSupervisorInput[] = [];
  const recordUndeliveredSupervisorInput = (text: string, reason: string): void => {
    undeliveredSupervisorInputs.push({ text, reason });
  };
  const undeliveredSupervisorInputSnapshot = (): readonly UndeliveredSupervisorInput[] => undeliveredSupervisorInputs.map((input) => ({ ...input }));
  /** Terminal paths must consume every queued delivery callback exactly once. */
  const finalizeSupervisorDeliveries = (reason: string): void => {
    const pending = supervisorDeliveryUpdates;
    supervisorDeliveryUpdates = [];
    const sendToActiveChildInbox = reason === 'no-next-rework-round' || reason === 'rework-round-limit'
      ? s.enqueueControlMemo ?? enqueueControlMemo
      : undefined;
    for (const { text, update } of pending) {
      if (sendToActiveChildInbox) {
        try {
          sendToActiveChildInbox(activeChildInboxId, text);
        } catch {
          recordUndeliveredSupervisorInput(text, 'inbox-send-failed');
          update?.('inbox-send-failed', 'inbox-send-failed');
          continue;
        }
        update?.('inbox-delivered');
        continue;
      }
      recordUndeliveredSupervisorInput(text, reason);
      update?.('not-delivered', reason);
    }
  };
  const setReworkPart = (source: SupervisionReworkSource, note: string): void => {
    const next = { source, note };
    reworkParts = [...reworkParts.filter((part) => part.source !== source), next];
    const merged = mergeReworkNotes(reworkParts);
    reworkNote = merged.note;
    reworkJudgeNote = merged.note;
    reworkKind = resolveReworkKind(merged.sources);
  };
  let refutableFindings: MustFixFinding[] = [];
  let previousBlockingFindings: readonly MustFixFinding[] | undefined;
  let currentBlockingFindings: readonly MustFixFinding[] | undefined;
  const reviewFindingKeyHistory: string[][] = [];
  const reviewFindingHistory: Array<string[] | undefined> = [];
  type ReviewFindingRecurrenceGroup = {
    findings: string[];
    observedRounds: number[];
  };
  const reviewFindingRecurrenceGroups: ReviewFindingRecurrenceGroup[] = [];
  const normalizeObservedReviewFinding = (finding: string): string => finding.trim();
  const observeReviewFindingRecurrence = (round: number, mustFix: readonly string[]): void => {
    const findingsInRound = [...new Set(mustFix.map(normalizeObservedReviewFinding).filter(Boolean))];
    for (const finding of findingsInRound) {
      const matchingGroups = reviewFindingRecurrenceGroups.filter((group) => group.findings.some((observedFinding) => {
        const overlap = measureReviewFindingKeyOverlap(finding, observedFinding);
        observe('recurrence-comparison', {
          round,
          recurrencePredicate: 'comparable-with-shared-symbol',
          comparable: overlap.comparable,
          sharedSymbolCount: overlap.sharedSymbolCount,
          overlapRatio: overlap.overlapRatio,
        }, { category: 'self-dev.rework' });
        return overlap.comparable && overlap.sharedSymbolCount > 0;
      }));
      if (matchingGroups.length === 0) {
        reviewFindingRecurrenceGroups.push({ findings: [finding], observedRounds: [round] });
        continue;
      }
      const primary = matchingGroups[0]!;
      for (const group of matchingGroups.slice(1)) {
        primary.findings.push(...group.findings);
        primary.observedRounds = [...new Set([...primary.observedRounds, ...group.observedRounds])].sort((left, right) => left - right);
        reviewFindingRecurrenceGroups.splice(reviewFindingRecurrenceGroups.indexOf(group), 1);
      }
      primary.findings.push(finding);
      if (!primary.observedRounds.includes(round)) primary.observedRounds.push(round);
    }
  };
  const recurrenceHistoryFor = (mustFix: readonly string[]): MustFixRecurrenceHistory[] => mustFix.flatMap((item) => {
    const normalizedItem = normalizeObservedReviewFinding(item);
    const group = reviewFindingRecurrenceGroups.find((candidate) => candidate.findings.includes(normalizedItem));
    return group && group.observedRounds.length > 1
      ? [{ findingId: stableMustFixId(item), occurrence: group.observedRounds.length - 1, observedRounds: [...group.observedRounds].sort((left, right) => left - right) }]
      : [];
  });
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const recurrenceCitationWasCited = (reason: string, recurrence: MustFixRecurrenceHistory): boolean => {
    const occurrencePattern = new RegExp(`\\boccurrence\\s*=\\s*${recurrence.occurrence}\\b`);
    const roundsPattern = new RegExp(`\\[\\s*${recurrence.observedRounds.map((round) => escapeRegExp(String(round))).join('\\s*,\\s*')}\\s*\\]`);
    return occurrencePattern.test(reason) && roundsPattern.test(reason);
  };
  const failCounts: number[] = [];
  // 직전 gate 실패 라운드의 미검증 집합(정렬 키). 통과하면 비운다 — «연속» 반복만 센다.
  let lastGateUnverifiedKey: string | undefined;
  const reworkHistory: string[] = [];
  const supervisorDecisionHistory: Array<{ round: number; verdict: ReworkBudgetVerdict; reason: string }> = [];
  let judgedEffectiveMax: number | undefined;
  let lastReworkVerdict: ReworkBudgetVerdict | undefined;
  let lastSupervisorVerdict: ReworkBudgetVerdict | undefined;
  let lastSupervisorReason: string | undefined;
  let consecutiveUnresolvedBudget = 0;
  let pendingPlanRevision: ReworkPlanRevision | undefined;
  let lastPlanRevision: ReworkPlanRevision | undefined;
  const isReviewRework = (source: SupervisionReworkSource): boolean => {
    switch (source) {
      case 'review': return true;
      case 'gate':
      case 'supervisor': return false;
      default: {
        const exhaustive: never = source;
        return exhaustive;
      }
    }
  };
  let terminalDecomposition: TerminalDecomposition | undefined;
  const reflectRejectedAudit: string[] = [];
  let carriedAppliedItems: readonly string[] = [];
  if ((opts.base || opts.goalId) && s.findAppliedReviewItems) {
    try {
      const carried = await s.findAppliedReviewItems(opts.base ?? '', opts.goalId);
      carriedAppliedItems = carried.items;
      const source = carried.source ?? (carried.basePrLocated ? 'pr-comment' : 'unavailable');
      observe('review-context-carried', {
        base: opts.base,
        basePrLocated: carried.basePrLocated,
        carriedItems: carried.items.length,
        headlineComments: carried.headlineComments ?? 0,
        source,
        ...(source === 'unavailable'
          ? { reason: opts.base === DEFAULT_BRANCH_WORKTREE_BASE ? 'default-branch-sentinel' : 'base-pr-not-found' }
          : {}),
      });
    } catch {
      observe('review-context-carried', { base: opts.base, basePrLocated: false, carriedItems: 0, headlineComments: 0, source: 'unavailable', error: true, reason: 'lookup-failed' }, { level: 'warn' });
    }
  }
  const goalTitle = opts.goalFile ? goalTitleFromTargetGoalFile(opts.goalFile, wt.path) : undefined;
  let priorRunFindings: Awaited<ReturnType<typeof collectPriorDraftFindings>> = [];
  if (goalTitle) {
    try {
      priorRunFindings = await (s.collectPriorDraftFindings ?? collectPriorDraftFindings)({ goalTitle, currentRunId: runId, repoPath: wt.path });
    } catch (error) {
      observe('prior-findings.unreadable', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (priorRunFindings.length) {
    observe('prior-findings.loaded', {
      prs: priorRunFindings.length,
      items: priorRunFindings.reduce((sum, finding) => sum + finding.items.length, 0),
    });
  }
  let appliedLastRound: string[] | undefined;
  let reviewIntent = buildReviewIntent({ goal: opts.feature, goalFile: opts.goalFile, ...(priorRunFindings.length ? { priorRunFindings } : {}) });
  // ⛔⭐ 리뷰 루프가 만든 마지막 컨텍스트를 잡아 둔다 — PR 본문 조립 직전에 **최종 커밋**의
  //   런 사실로 갱신하기 위해서다(3R must-fix). 루프 안 수집은 `openPr` 단계가 만드는 커밋을
  //   못 본다: 자식은 파일만 남기고 실제 커밋은 `commitWork` 가 루프 뒤에서 만든다.
  let lastReviewContext: (ReviewDiffContext & { goal: string }) | undefined;
  let clarificationEscalation: GoalClarificationEscalationResult | undefined;
  const goalFileCandidates = opts.goalFile
    ? [...new Set([opts.goalFile, ...(!isAbsolute(opts.goalFile) ? [resolve(wt.path, opts.goalFile)] : [])])]
    : [];
  let resolvedGoalFile: string | undefined;
  let clarificationQuestionIds: string[] = [];
  const goalFileReadErrors: string[] = [];
  for (const candidate of goalFileCandidates) {
    try {
      const goalDocument = readFileSync(candidate, 'utf8');
      clarificationQuestionIds = [...new Set(parseGoalDocumentClarifications(goalDocument)
        .filter((clarification) => !clarification.answered)
        .map((clarification) => clarification.questionId))];
      resolvedGoalFile = candidate;
      break;
    } catch (error) {
      goalFileReadErrors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (opts.goalFile && resolvedGoalFile) {
    const clarificationConfig = (await import('../user-config.js')).getUserConfig().tools.selfImplement.clarificationEscalation;
    // ⛔ 타임아웃 «기본값 숫자»를 코드가 정하지 않는다 — 유효한 설정값이 있을 때만 설치한다.
    //    값이 없으면 무한 대기가 되므로, 켜져 있어도 설치하지 않고 지금 동작(폴백)을 유지한다.
    // ⛔⭐⭐⭐ 자기 인지 최소판 — «사람이 없는 표면»에 터미널 리졸버를 설치하지 않는다.
    //  이 리졸버는 process.stdin 을 읽는다. 비-TTY(백그라운드·크론·자식 런)에는 답할 사람이 없고,
    //  실측(2026-08-04)에서 그 조합이 「exit 0 으로 조용히 죽는 런」을 만들었다.
    //  ⇒ 설치를 «안 하면» 지금까지의 동작(폴백 문면 ⊕ 런 계속)으로 돌아간다 — 잃는 것이 없다.
    //  ⚠️ 이건 「어느 표면으로 물을지」의 답이 아니라 «틀린 표면을 고르지 않는다»까지다.
    const stdinIsInteractive = s.stdinIsInteractive ? s.stdinIsInteractive() : process.stdin.isTTY === true;
    const installDecision = decideClarificationResolverInstall(clarificationConfig, stdinIsInteractive);
    if (!installDecision.install) {
      observe('clarification-resolver-skipped', {
        reason: installDecision.skipReason,
        hint: clarificationResolverSkipHint(installDecision.skipReason),
      }, { level: 'warn' });
    }
    const clarificationResolverLease = acquireClarificationResolverLease(
      installDecision.install,
      // ⛔⭐ 표면을 «판정한 값»으로 고른다 — 종전엔 여기서 `stdinIsInteractive` 를 «다시» 읽었다.
      //   그러면 `decideClarificationResolverInstall` 이 낸 `surface` 가 테스트에서만 단언되는
      //   ***죽은 필드***가 되고, 판정과 선택이 갈릴 때 아무도 모른다(무인 리뷰 must-fix · 5라운드 잔여분).
      //   ⇒ 📌 「판정한 곳」과 「고르는 곳」을 «한 값»으로 묶는다. 판정이 바뀌면 선택이 «따라온다».
      () => (installDecision.install && installDecision.surface === 'terminal')
        ? createWidgetAskUserResolver({
          hostFactory: () => createNodeReadlineHost(),
          timeoutMs: clarificationConfig.timeoutMs,
        })
        : createFileAskUserQuestionResolver(clarificationConfig.timeoutMs!, {
          // ⛔ pending 쓰기/답 실패 원인을 production 관측으로 흘린다 — 중앙 end 이벤트의
          //    answerState 와 별개로, 파일 리졸버 내부 실패 사유를 잃지 않게 배선한다(MF-be357c62).
          observe: (state, data) => {
            observe('clarification-file-resolver', { state, ...data }, state === 'pending-write-failed' || state === 'answer-read-failed' ? { level: 'warn' } : undefined);
            if (state === 'pending-created' && data) {
              progress('awaiting-clarification', `사람의 clarification 답변 대기 중 (${data.pendingQuestionId}). 조회: elanous questions pending`);
            } else if (state === 'pending-removed' && data) {
              progress('awaiting-clarification', `clarification 답변 대기 종료 (${data.pendingQuestionId}).`);
            }
          },
        }),
    );
    try {
      // ⛔ 관측이 «거짓말하지 않게» — 우리가 «실제로 설치·소유»했을 때만 그 표면을 적는다.
      //    config 조건으로 적으면 거짓이 된다: 남의 리졸버가 이미 걸려 있어 lease 가
      //    설치를 건너뛰어도 'terminal' 로 기록됐다(무인 리뷰 R4).
      //    ⭐ 소유하고 있으면 답하는 것은 «우리 터미널 호스트»이므로 호출자 값보다 사실이 앞선다.
      const clarificationDispatchContext: AskUserQuestionDispatchContext | undefined = opts.parentSessionId
        ? { sessionId: opts.parentSessionId }
        : undefined;
      const { originHitlDelivery } = await import('../agent/surface-ux/hitl-delivery.js');
      const { listSubscribers } = await import('../session/index.js');
      clarificationEscalation = await escalateGoalDocumentClarifications({
        goalFile: resolvedGoalFile,
        dispatchContext: clarificationDispatchContext,
        resolveOriginDelivery: (sessionId) => originHitlDelivery(listSubscribers(sessionId)),
        // ⛔ seam 이 주입되면 전역 리졸버는 «불리지 않는다» — 그때 'terminal' 이라 적으면
        //    또 거짓이다(무인 리뷰 R5). 「설치했다」와 「그것이 답한다」는 다른 사실이다.
        delivery: opts.clarificationDelivery,
        ...((clarificationResolverLease.installed && !s.escalateGoalClarifications && installDecision.install)
          ? { resolvedDelivery: installDecision.delivery }
          : {}),
        ...(s.escalateGoalClarifications ? { dispatch: s.escalateGoalClarifications } : {}),
        fallback: (message) => process.stdout.write(`${message}\n`),
      });
    } finally {
      clarificationResolverLease.release();
    }
    observe('clarification-escalation', { ...clarificationEscalation, goalFile: resolvedGoalFile }, clarificationEscalation.outcome === 'failed' || clarificationEscalation.outcome === 'timeout' ? { level: 'warn' } : undefined);
    // ⛔⭐⭐ **종전엔 `'timeout'` 하나만 봤다.** 그런데 그 값은 ***실패 출력에 「timeout/timed out」이
    //   «글자로» 들어 있을 때만*** 난다(`goal-clarification-escalation.ts:289` `failedOutcome`).
    //   📏 실측(8일 · 478건): failed **3** · ***timeout 0*** · `no-response` **1**
    //     ⇒ 🚨 그래서 아래 원장 칸은 **0/628** 이었고, 「답이 안 와서 그냥 진행한」 그 1건이 ***안 남았다***.
    //   ⭐ `'no-response'` = 리졸버가 설치돼 물었는데 ***답이 안 온*** 상태 — 이 칸이 답해야 할 바로 그것이다.
    //   ⛔ 두 값을 «뭉개지 않는다** — 어느 쪽이었는지를 `clarificationUnansweredOutcome` 이 남긴다(`F44` 방지).
    const unansweredOutcome = clarificationUnansweredOutcomeOf(clarificationEscalation.outcome);
    if (unansweredOutcome) {
      onClarificationTimeout({
        clarificationTimeoutUnanswered: clarificationEscalation.unanswered,
        clarificationTimeoutQuestionIds: clarificationQuestionIds,
        clarificationUnansweredOutcome: unansweredOutcome,
      });
      // ⛔ 기존 문면(`미답 N개 (…)를 두고 진행`)을 «보존»한다 — 이 PR 의 목적이 아닌 계약 변경이다.
      //   ⭐ 갈라진 상태만 앞머리에서 말한다.
      progress('implemented', `⚠️ 골 clarification ${unansweredOutcome === 'timeout' ? '시간 초과' : '무응답'} — 미답 ${clarificationEscalation.unanswered}개 (${clarificationQuestionIds.join(', ')})를 두고 진행`);
    }
    if (clarificationEscalation.outcome === 'failed') {
      progress('aborted', '중단 — 골 clarification 전달 실패');
      return {
        ok: false,
        stage: 'aborted',
        node: 'implement',
        ...resolveRunOutcome({ termination: 'abandoned' }),
        sessionId,
        worktreePath: wt.path,
        branch: wt.branch,
        detail: `goal clarification escalation ${clarificationEscalation.outcome}: ${clarificationEscalation.error ?? 'no delivery result'}`,
      };
    }
  } else if (opts.goalFile) {
    observe('clarification-escalation', {
      goalFile: opts.goalFile,
      candidates: goalFileCandidates,
      readErrors: goalFileReadErrors,
      outcome: 'failed',
      reason: 'goal-file-unavailable',
    }, { level: 'warn' });
    progress('aborted', '중단 — 골 파일을 읽을 수 없음');
    return {
      ok: false,
      stage: 'aborted',
      node: 'implement',
      ...resolveRunOutcome({ termination: 'abandoned' }),
      sessionId,
      worktreePath: wt.path,
      branch: wt.branch,
      detail: `goal file unavailable: ${opts.goalFile}`,
    };
  }
  let round = 0;
  // PR이 열리기 전에 프로세스가 죽으면 PR 자체가 없으므로 잃을 대화도 없다. 따라서 파일로 영속화하지 않는다.
  const prCommentBuffer: string[] = [];
  // GitHub PR comment bodies are bounded; retain the RFC header and disclose omitted source rather than losing the whole record.
  const MAX_PR_COMMENT_BODY_CHARS = 60_000;
  const bufferPrComment = (roundNumber: number, role: PrCommentRole, title: string, details: readonly string[] = []): void => {
    const header = formatPrComment({ role, round: roundNumber, run: runId });
    const body = [
      header,
      title,
      ...(details.length ? ['', ...details.map((detail) => `- ${detail}`)] : []),
    ].join('\n');
    if (body.length <= MAX_PR_COMMENT_BODY_CHARS) {
      prCommentBuffer.push(body);
      return;
    }
    const omittedChars = body.length - MAX_PR_COMMENT_BODY_CHARS;
    const omission = `\n\n[${omittedChars} characters omitted; original body length ${body.length}]`;
    prCommentBuffer.push(`${body.slice(0, MAX_PR_COMMENT_BODY_CHARS - omission.length)}${omission}`);
  };
  const flushPrComments = async (pr: { number: number }): Promise<void> => {
    if (!prCommentBuffer.length) return;
    if (!s.postPrComment) {
      observe('pr.comment.seam-missing', { number: pr.number, buffered: prCommentBuffer.length }, { level: 'warn' });
      return;
    }
    for (const body of prCommentBuffer) {
      try {
        await s.postPrComment({ number: pr.number, body, cwd: wt.path });
      } catch (error) {
        observe('pr.comment.post-failed', { number: pr.number, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
      }
    }
  };
  let preservationBase = wt.resolvedBase;
  const runProviderName = opts.childLlm?.provider ?? (s.currentProviderName?.() ?? currentProviderName());
  let cachedQuotaExhaustionAssessment: QuotaExhaustionAssessment | undefined;
  const quotaExhaustionAssessmentForRun = (): QuotaExhaustionAssessment => {
    cachedQuotaExhaustionAssessment ??= readQuotaExhausted(s.inspectCodexRotation, runProviderName);
    return cachedQuotaExhaustionAssessment;
  };
  let finishedChildCommitMissing = false;
  let finishedChildCommitFailure: string | undefined;
  let finishedChildCommitted = false;
  const revertGuard: RevertGuardResult = { reverted: [], protected: [] };
  const inspectStaleReverts = (targets: readonly string[]): void => {
    const inspected = dropStaleReverts(wt.path, targets, runId, getUserConfig().harness?.revertGuard?.depth);
    for (const file of inspected.reverted) if (!revertGuard.reverted.includes(file)) revertGuard.reverted.push(file);
    for (const file of inspected.protected) if (!revertGuard.protected.includes(file)) revertGuard.protected.push(file);
    if (inspected.warning) revertGuard.warning = inspected.warning;
  };
  const classifyUnfinishedRun = (stage: SelfImplementStage, verdict?: ReworkBudgetVerdict, decomposition?: TerminalDecomposition): AbandonedClassificationResult => {
    const quotaExhaustionAssessment = quotaExhaustionAssessmentForRun();
    const worktree = unfinishedWorktreeObservation(wt.path);
    return classifyAbandonedRun({
      ...(opts.goalFile ? { goalType: goalTypeFields(opts.goalFile).goalType } : {}),
      ...(quotaExhaustionAssessment.exhausted ? { quotaExhausted: true } : {}),
      ...(quotaExhaustionAssessment.accountAvailability ? { quotaAccountAvailability: quotaExhaustionAssessment.accountAvailability } : {}),
      ...(hasCurrentCredentialFailure() ? { credentialFailure: true } : {}),
      ...(hasCurrentProviderError() ? { providerError: true } : {}),
      ...(hasCurrentProviderError() && providerErrorCategory() ? { providerErrorCategory: providerErrorCategory() } : {}),
      worktreePorcelain: worktree.worktreePorcelain,
      ...(worktree.gitResidue ? { gitResidue: worktree.gitResidue } : {}),
      ...(!finishedChildCommitMissing && !finishedChildCommitted && impl.completionDisposition ? { completionDisposition: impl.completionDisposition } : {}),
      ...(verdict ? { supervisorVerdict: verdict } : lastSupervisorVerdict ? { supervisorVerdict: lastSupervisorVerdict } : {}),
      ...(hasMultipleStructuredTerminalPieces(decomposition ?? terminalDecomposition) ? { goalCauseObserved: true } : {}),
      stage,
      reviewResultObserved: review !== undefined,
      mustFixReported: (review?.mustFix.length ?? 0) > 0,
    });
  };
  const preserveBlockedArtifacts = async ({ stage, reason, verdict, gate: preservedGate, typecheck, decomposition, childSummary, reasonTruncated, failureKind, terminalStatus, salvageStatusExpected }: { stage: 'review-blocked' | 'gate-failed' | 'aborted'; reason: string; verdict?: ReworkBudgetVerdict; gate?: SelfImplementGateResult; typecheck?: { passed: boolean; log?: string }; decomposition?: TerminalDecomposition; childSummary?: string; reasonTruncated?: boolean; failureKind?: ReturnType<typeof classifyReviewProviderFailure> | null; terminalStatus?: ImplementTerminalStatus; salvageStatusExpected: boolean }): Promise<{ url: string; number: number } | undefined> => {
    let childSummaryArtifact: ChildSummaryArtifactRef | undefined;
    if (childSummary !== undefined) {
      try {
        childSummaryArtifact = persistImplementAbortChildSummary(s.persistImplementAbortArtifact, {
          origin: 'self-implement-abort',
          runId,
          childSummary,
          childSummaryChars: childSummary.length,
          reason,
          reasonTruncated: reasonTruncated === true,
          round,
          stage,
        });
      } catch {
        observe('implement-abort-artifact-failed', { stage, childSummaryChars: childSummary.length }, { level: 'warn' });
      }
    }
    // Preserve direct goal evidence for a blocked draft without classifying the
    // abort reason. A missing goal or no declared signals remains unmeasured,
    // never a synthetic green result; pressDecisionSignals owns the 180-second bound.
    const pressPreservedDecisionSignals = () => {
      if (!opts.goalFile || !existsSync(opts.goalFile) || !statSync(opts.goalFile).isFile()) return undefined;
      const goal = readFileSync(opts.goalFile, 'utf8');
      const signals = inspectDecisionSignalObservations(goal);
      return signals.length > 0
        ? pressDecisionSignals({ kinds: inspectDecisionSignalKinds(goal), observations: inspectDecisionObservations(goal), signals }, wt.path)
        : undefined;
    };
    let decisionSignalObservation: {
      status: 'measured' | 'unmeasured' | 'failed';
      pressedGreen: readonly string[];
      pressedRed: readonly string[];
      pressedBaselineOnly: readonly string[];
      pressedCount: number;
      unpressed: readonly string[];
      error?: string;
    } = { status: 'unmeasured', pressedGreen: [], pressedRed: [], pressedBaselineOnly: [], pressedCount: 0, unpressed: [] };
    try {
      const press = pressPreservedDecisionSignals();
      if (press) {
        decisionSignalObservation = {
          status: 'measured',
          pressedGreen: press.pressedGreen.map(({ signal, command, exitCode, durationMs }) => `${signal}: ${command} (exit ${exitCode}, ${durationMs}ms)`),
          pressedRed: press.pressedRed.map(({ signal, command, exitCode, durationMs }) => `${signal}: ${command} (exit ${exitCode}, ${durationMs}ms)`),
          pressedBaselineOnly: press.pressedBaselineOnly.map(({ signal, command, exitCode, durationMs }) => `${signal}: ${command} (exit ${exitCode}, ${durationMs}ms)`),
          pressedCount: press.pressedCount,
          unpressed: press.unpressed.map(({ signal, command, reason, error }) => `${signal}: ${command ?? '(no command)'} (${reason}${error ? `: ${error}` : ''})`),
        };
      }
    } catch (error) {
      decisionSignalObservation = {
        status: 'failed',
        pressedGreen: [],
        pressedRed: [],
        pressedBaselineOnly: [],
        pressedCount: 0,
        unpressed: [],
        error: error instanceof Error ? error.message : String(error),
      };
      observe('blocked-draft-decision-signal-failed', { stage, error: decisionSignalObservation.error }, { level: 'warn' });
    }
    const abandonedClassification = classifyUnfinishedRun(stage, verdict, decomposition);
    const classificationRecord = blockedDraftClassificationRecord(abandonedClassification);
    observe('blocked-draft-classification', {
      stage,
      ...classificationRecord,
    }, { level: 'warn' });
    const observation = {
      branch: wt.branch,
      stage,
      verdict: verdict ?? null,
      reason: reason.slice(0, 240),
      rounds: round,
      autoMerge: false,
      classification: classificationRecord.classification,
      classificationBasis: classificationRecord.classificationBasis,
      ...(childSummary !== undefined ? { childSummaryChars: childSummary.length } : {}),
      ...(reasonTruncated !== undefined ? { reasonTruncated } : {}),
      ...(failureKind !== undefined ? { failureKind } : {}),
      ...(terminalStatus ? { terminalStatus } : {}),
      // Review trend is a human-readable label only: it never classifies this abort.
      reviewMustFixTrend: reviewMustFixTrend(),
      lastMustFix: review?.mustFix.length ?? null,
      findingIds: review ? review.mustFix.map((finding) => stableMustFixId(finding)) : [],
      ...(review ? { roundWarning: 'round is not comparable across restarts' } : {}),
      decisionSignal: decisionSignalObservation,
      undeliveredSupervisorInputs: undeliveredSupervisorInputSnapshot(),
      undeliveredSupervisorInputCount: undeliveredSupervisorInputs.length,
      ...(childSummaryArtifact ? { childSummaryArtifactPath: childSummaryArtifact.path } : {}),
    };
    if (s.preservationHasChanges && !await s.preservationHasChanges({ cwd: wt.path, base: preservationBase })) {
      observe('rework-blocked-draft-pr', { ...observation, skipped: 'no-changes' });
      progress(stage, '보존할 변경이 없어 draft PR을 열지 않음');
      return undefined;
    }
    const assembled = assembleBlockedDraftPrBody(
      opts.feature,
      childSummaryArtifact
        ? childSummaryPointer(childSummaryArtifact)
        : childSummary !== undefined
          ? `(자식 요약 전문 영속 실패 · ${childSummary.length} chars — 사유와 섞지 않음)`
          : impl.summary,
      {
        salvageStatusExpected,
        gate: preservedGate,
        typecheck,
        review,
        verdict,
        reason,
        rounds: round,
        undeliveredSupervisorInputs: undeliveredSupervisorInputSnapshot(),
        abandonedClassification,
        ...(decomposition ? { decomposition } : {}),
        ...(harvestedForPr() ? { evidence: harvestedForPr() as string } : {}),
        ...(reasonTruncated !== undefined ? { reasonTruncated } : {}),
        ...(childSummary !== undefined ? { childSummaryChars: childSummary.length } : {}),
        ...(childSummaryArtifact ? { childSummaryArtifact: childSummaryArtifact } : {}),
        ...(terminalStatus ? { terminalStatus } : {}),
        ...(lastPlanRevision ? { planRevision: lastPlanRevision } : {}),
      },
      opts.goalFile,
      s.persistPrBodyArtifact,
    );
    // no-changes wins; worktree-only remains local even for environment stops.
    const environmentStop = blockedDraftDisposition(classificationRecord.classification) === 'preserve-branch';
    const worktreeOnly = opts.completion === 'worktree-only';
    if (worktreeOnly || environmentStop) {
      let artifactPath: string | undefined;
      let artifactError: string | undefined;
      try {
        artifactPath = persistFullPrBody(s.persistPrBodyArtifact, {
          origin: worktreeOnly ? 'self-implement-blocked-draft-pr-worktree-only' : 'self-implement-blocked-draft-pr-environment-stop',
          body: assembled.body,
          originalChars: assembled.originalChars,
        });
      } catch (persistenceError) {
        artifactError = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      }
      let pushed = false;
      let committed = false;
      let pushError: Error | undefined;
      let preservationErrorStep: 'worktree' | 'commit' | 'push' | undefined;
      if (environmentStop && !worktreeOnly) {
        try {
          if (!s.preserveBlockedBranch && !existsSync(wt.path)) {
            preservationErrorStep = 'worktree';
            throw new Error(`worktree not found: ${wt.path}`);
          }
          if (s.preserveBlockedBranch) {
            pushed = await s.preserveBlockedBranch({ cwd: wt.path, branch: wt.branch, title: prTitle(opts.feature) });
            if (!pushed) throw new Error('브랜치 push가 성공하지 않았음');
          } else {
            preservationErrorStep = 'commit';
            const commit = commitWorktree(wt.path, prTitle(opts.feature));
            if (!commit.ok && !/nothing to commit/.test(commit.out)) throw new Error(commit.out);
            committed = commit.ok;
            if (runGitCommand(wt.path, ['remote', 'get-url', 'origin']).status === 0) {
              preservationErrorStep = 'push';
              const push = runGitCommand(wt.path, ['push', '-u', 'origin', `HEAD:refs/heads/${wt.branch}`]);
              if (push.status !== 0) throw new Error(push.stderr || push.stdout);
              pushed = true;
            }
          }
        } catch (error) {
          pushError = error instanceof Error ? error : new Error(String(error));
        }
      }
      observe('rework-blocked-draft-pr', {
        ...observation,
        skipped: worktreeOnly ? 'worktree-only' : 'environment-stop',
        ...(!worktreeOnly && environmentStop ? { pushed, committed } : {}),
        worktreePath: wt.path,
        ...(pushError ? { pushError: pushError.message, preservationErrorStep: preservationErrorStep ?? 'push' } : {}),
        ...(artifactPath ? { prBodyArtifactPath: artifactPath } : {}),
        ...(artifactError ? { prBodyArtifactError: artifactError } : {}),
      }, pushError ? { level: 'warn' } : undefined);
      if (pushError) {
        const failure = preservationErrorStep === 'worktree' ? '워크트리 부재로 보존 실패' : preservationErrorStep === 'commit' ? '로컬 브랜치 커밋 실패' : '원격 브랜치 보존 실패';
        progress('aborted', `환경 탓 중단 — ${failure}: ${wt.branch} (${pushError.message}; worktree: ${wt.path})`);
        if (preservationErrorStep === 'worktree') return undefined;
        throw new Error(`환경 탓 중단 — ${failure}: ${wt.branch} (worktree: ${wt.path})`, { cause: pushError });
      }
      if (worktreeOnly) {
        progress(stage, artifactPath
          ? `worktree-only 완료: draft PR을 열지 않음(worktree·branch 보존 · 중단 사유 보존: ${artifactPath} · worktree: ${wt.path} · branch: ${wt.branch})`
          : `worktree-only 완료: draft PR을 열지 않음(worktree·branch 보존 · 중단 사유 보존 실패: ${artifactError ?? 'unknown error'} · worktree: ${wt.path} · branch: ${wt.branch})`);
      } else {
        // No draft PR on this path, so the stop reason must be findable from the progress line itself.
        const reasonNote = artifactPath ? `중단 사유 보존: ${artifactPath}` : `중단 사유 보존 실패: ${artifactError ?? 'unknown error'}`;
        progress(stage, pushed
          ? `환경 탓 중단 — draft PR 없이 브랜치만 보존: ${wt.branch} · ${reasonNote}`
          : `환경 탓 중단 — draft PR 없이 로컬 브랜치만 보존(원격 origin 없음): ${wt.branch} · worktree: ${wt.path} · ${reasonNote}`);
      }
      return undefined;
    }
    progress('pr-opening', '중단 산출물을 draft PR로 보존…');
    let pr: { url: string; number: number };
    try {
      pr = await withStepTimeout(s.openPr({
        title: prTitle(opts.feature),
        body: assembled.body,
        head: wt.branch,
        ...(opts.base ? { base: opts.base } : {}),
        draft: true,
        cwd: wt.path,
      }), T.pr, 'pr');
    } catch (error) {
      const prError = error instanceof Error ? error.message : String(error);
      let artifactPath: string | undefined;
      let artifactError: string | undefined;
      try {
        artifactPath = persistFullPrBody(s.persistPrBodyArtifact, {
          origin: 'self-implement-blocked-draft-pr-open-failed',
          body: assembled.body,
          originalChars: assembled.originalChars,
        });
      } catch (persistenceError) {
        artifactError = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      }
      observe('rework-blocked-draft-pr', {
        ...observation,
        error: prError,
        ...(artifactPath ? { prBodyArtifactPath: artifactPath } : {}),
        ...(artifactError ? { prBodyArtifactError: artifactError } : {}),
      }, { level: 'warn' });
      progress('aborted', artifactPath
        ? `중단 산출물의 draft PR 생성 실패(worktree·branch 보존 · 판정 본문 보존: ${artifactPath})`
        : `중단 산출물의 draft PR 생성 실패(worktree·branch 보존 · 판정 본문 보존 실패: ${artifactError ?? 'unknown error'})`);
      return undefined;
    }
    observe('rework-blocked-draft-pr', {
      ...observation,
      url: pr.url,
      number: pr.number,
      ...(assembled.truncated ? { prBodyTruncated: true, prBodyOriginalChars: assembled.originalChars } : {}),
    });
    await flushPrComments(pr);
    progress('pr-opened', `중단 산출물 draft PR 개설 (#${pr.number}·사람 판단 대기)`);
    return pr;
  };
  const postSalvageStatus = async (pr: { number: number } | undefined, action: 'launched' | 'parked', reason?: string): Promise<void> => {
    if (!pr) return;
    if (!s.postPrComment) {
      observe('pr.comment.seam-missing', { number: pr.number, salvageAction: action }, { level: 'warn' });
      return;
    }
    const body = [
      formatPrComment({ role: 'author', round, run: runId }),
      `Rework salvage status: ${action}.`,
      ...(reason ? ['', `- reason: ${reason}`] : []),
    ].join('\n');
    try {
      await s.postPrComment({ number: pr.number, body, cwd: wt.path });
    } catch (error) {
      observe('pr.comment.post-failed', { number: pr.number, salvageAction: action, ...(reason ? { reason } : {}), error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    }
  };
  let pendingRefutations: { round: number; refutations: readonly MustFixRefutation[] } | undefined;
  // 수용된 반박은 판정·재주입을 바꾸지 않고, 이후 동일 ID 재발을 분리하는 관측 이력으로만 보존한다.
  const acceptedRefutationFindingIds = new Set<string>();
  const refutationGuidancePresented = (childFeature: string, eligible: boolean): boolean => eligible && childFeature.includes(buildRefutationGuidance());
  const parseSupervisorRefutationAdjudications = (diagnosis: string, refutations: readonly MustFixRefutation[]) => {
    const submittedIds = new Set(refutations.map(({ findingId }) => findingId));
    const verdictsByFinding = new Map<string, Set<'accepted' | 'rejected'>>();
    for (const raw of diagnosis.split(/\r?\n/)) {
      const match = /^REFUTE\s+\[(MF-[0-9a-f]{8})\]\s*:\s*(ACCEPT|REJECT)\s*$/i.exec(raw.trim());
      if (!match || !submittedIds.has(match[1]!)) continue;
      const verdict = match[2]!.toUpperCase() === 'ACCEPT' ? 'accepted' : 'rejected';
      const verdicts = verdictsByFinding.get(match[1]!) ?? new Set<'accepted' | 'rejected'>();
      verdicts.add(verdict);
      verdictsByFinding.set(match[1]!, verdicts);
    }
    return refutations.flatMap(({ findingId }) => {
      const verdicts = verdictsByFinding.get(findingId);
      if (!verdicts || verdicts.size !== 1) return [];
      return [{ findingId, verdict: [...verdicts][0]! }];
    });
  };
  // ⛔⭐ 관측 «형태»가 값에 따라 달라지면 안 된다 — 종전엔 `missing-cited-path` 가 0 일 때
  //   `enumerable:false` 로 «칸 자체가 사라졌다». 그러면 소비자는 「0」과 「이 빌드엔 그 갈래가 없다」를
  //   구별할 수 없고, 「한 번도 안 불렸다」를 셀 수도 없다(리뷰 should-fix · 🅢 #10622 의 「0 도 싣는다」와 같은 규율).
  const refutationKindCounts = (refutations: readonly MustFixRefutation[]): Record<MustFixRefutationKind, number> => ({
    'preservation-contract': refutations.filter(({ kind }) => kind === 'preservation-contract').length,
    'requested-criterion': refutations.filter(({ kind }) => kind === 'requested-criterion').length,
    'invariant-candidate': refutations.filter(({ kind }) => kind === 'invariant-candidate').length,
    'must-fix-conflict': refutations.filter(({ kind }) => kind === 'must-fix-conflict').length,
    'missing-cited-path': refutations.filter(({ kind }) => kind === 'missing-cited-path').length,
    'found-cited-path': refutations.filter(({ kind }) => kind === 'found-cited-path').length,
  });
  const acceptReviewBudget = async (unresolvedMustFix: readonly string[], hasNonReviewResidualWork: boolean) => {
    const decision = decideReworkSalvage({
      hardCapBlockedExtend: false,
      reviewBudgetExhausted: true,
      gatePassed: gate?.passed,
      unresolvedMustFix,
      hasNonReviewResidualWork,
    });
    if (decision.action === 'launch') {
      throw new Error('review-budget decision cannot launch a hard-cap salvage');
    }
    if (decision.action === 'parked') {
      observe('review-budget-acceptance', {
        action: 'blocked',
        reason: decision.reason,
        branch: wt.branch,
        ...(decision.reason === 'review-budget-gate-unavailable' ? { gateMeasured: false } : { gateMeasured: true }),
      }, { level: 'warn' });
      return { decision };
    }
    const followUpMustFix = `\n\n## Follow-up must-fix (${decision.unresolvedMustFix.length})\n${decision.unresolvedMustFix.map((finding) => `- ${finding}`).join('\n')}`;
    const releaseNote = releaseNoteForRun(opts.goalFile, opts.feature);
    // openPr's default seam delegates to PrManager.upsertPr, which stages, commits,
    // and pushes this worktree after the note is written and before creating the PR.
    addNextMdReleaseNote(wt.path, releaseNote);
    const preparedPrBody = preparePrBody(
      `${prBody(opts.feature, impl.summary, gate.log, review, reviewIntent, undefined, harvestedForPr(), opts.goalFile, lastPlanRevision, releaseNote)}${followUpMustFix}`,
      s.persistPrBodyArtifact,
      'self-implement-review-budget-pr',
      followUpMustFix,
    );
    const pr = await withStepTimeout(s.openPr({
      title: prTitle(opts.feature),
      body: preparedPrBody.body,
      head: wt.branch,
      ...(opts.base ? { base: opts.base } : {}),
      draft: false,
      cwd: wt.path,
    }), T.pr, 'pr');
    observe('review-budget-acceptance', {
      action: 'accepted',
      reason: decision.reason,
      branch: wt.branch,
      gateMeasured: true,
      unresolvedMustFixCount: decision.unresolvedMustFix.length,
      unresolvedMustFix: decision.unresolvedMustFix,
      autoMerge: false,
      url: pr.url,
      number: pr.number,
      ...(preparedPrBody.truncated ? { prBodyTruncated: true, prBodyOriginalChars: preparedPrBody.originalChars } : {}),
    });
    await flushPrComments(pr);
    return { decision, pr };
  };
  const baselineOnlyGate = (): boolean => {
    const failures = gate?.baselineFailures;
    return gate?.passed === false && !!failures?.length && gate.reflectGateFacts?.introduced === 0
      && gate.reflectGateFacts.unknown === 0
      && failures.every(({ attribution }) => attribution === 'preexisting' || attribution === 'flaky-timeout'
        || attribution === 'flaky-rerun' || attribution === 'precondition-unmet');
  };
  const noRetryBaseline = (): { terminationReason?: 'blocked-by-baseline' } => {
    if (!baselineOnlyGate()) return {};
    const failures = gate!.baselineFailures!;
    debug.log('self-implement.supervisor', 'no-retry-baseline', {
      runId,
      preexisting: failures.filter(({ attribution }) => attribution === 'preexisting').length,
      flaky: failures.filter(({ attribution }) => attribution === 'flaky-timeout' || attribution === 'flaky-rerun').length,
    });
    return { terminationReason: 'blocked-by-baseline' };
  };
  const salvageHardCap = async (hardCapBlockedExtend: boolean, pr?: { number: number }): Promise<'launched' | 'parked'> => {
    let evidence: ReworkSalvageEvidence | undefined;
    if (hardCapBlockedExtend) {
      try {
        evidence = s.readReworkSalvageEvidence ? await s.readReworkSalvageEvidence(wt.path) : undefined;
      } catch (error) {
        const reason = 'evidence-unavailable';
        observe('rework-salvage', { action: 'parked', reason, branch: wt.branch, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        await postSalvageStatus(pr, 'parked', reason);
        return 'parked';
      }
    }
    const quotaExhaustionAssessment = quotaExhaustionAssessmentForRun();
    const worktree = unfinishedWorktreeObservation(wt.path);
    const abandonedClassification = classifyAbandonedRun({
      ...(opts.goalFile ? { goalType: goalTypeFields(opts.goalFile).goalType } : {}),
      ...(quotaExhaustionAssessment.exhausted ? { quotaExhausted: true } : {}),
      ...(quotaExhaustionAssessment.accountAvailability ? { quotaAccountAvailability: quotaExhaustionAssessment.accountAvailability } : {}),
      ...(hasCurrentCredentialFailure() ? { credentialFailure: true } : {}),
      ...(hasCurrentProviderError() ? { providerError: true } : {}),
      ...(hasCurrentProviderError() && providerErrorCategory() ? { providerErrorCategory: providerErrorCategory() } : {}),
      worktreePorcelain: worktree.worktreePorcelain,
      ...(worktree.gitResidue ? { gitResidue: worktree.gitResidue } : {}),
      stage: isReviewRework(reworkKind) ? 'review-blocked' : 'gate-failed',
      reviewResultObserved: review !== undefined,
      mustFixReported: (review?.mustFix.length ?? 0) > 0,
    });
    observe('rework-salvage-classification', { ...abandonedClassification, branch: wt.branch });
    // Salvage may resume an observed environment interruption even when a later
    // gate/review verdict is the terminal classification. Keep its cause distinct.
    const salvageClassification = abandonedClassification.classification === 'implementation-deficit' && hasObservedProviderError()
      ? hasObservedCredentialFailure() ? 'credential-failure' : 'provider-error'
      : abandonedClassification.classification;
    const decision = decideReworkSalvage({
      hardCapBlockedExtend,
      goalFile: opts.goalFile,
      salvageAttempt: opts.salvageAttempt,
      evidence,
      abandonedClassification: salvageClassification,
    });
    if (decision.action !== 'launch') {
      const reason = decision.reason;
      observe('rework-salvage', { action: 'parked', reason, branch: wt.branch, ...(decision.action === 'parked' && decision.evidence ? { clean: decision.evidence.clean, aheadCommits: decision.evidence.aheadCommits } : {}) }, { level: 'warn' });
      await postSalvageStatus(pr, 'parked', reason);
      return 'parked';
    }
    const environmentReason = 'reason' in decision ? decision.reason : undefined;
    const salvageEvidence = 'evidence' in decision ? decision.evidence : undefined;
    const launchObservation = {
      branch: wt.branch,
      goalFile: opts.goalFile,
      ...(environmentReason ? { reason: environmentReason, abandonedClassification: salvageClassification } : {}),
      ...(salvageEvidence ? { clean: salvageEvidence.clean, aheadCommits: salvageEvidence.aheadCommits } : {}),
    };
    observe('rework-salvage', { action: 'launching', ...launchObservation });
    try {
      if (!s.launchReworkSalvage) throw new Error('launch seam unavailable');
      await s.launchReworkSalvage({ goalFile: opts.goalFile!, base: wt.branch, salvageAttempt: (opts.salvageAttempt ?? 0) + 1 });
      observe('rework-salvage', { action: 'launched', ...launchObservation });
      await postSalvageStatus(pr, 'launched');
      return 'launched';
    } catch (error) {
      const reason = 'launch-failed';
      observe('rework-salvage', { action: 'parked', reason, ...launchObservation, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
      await postSalvageStatus(pr, 'parked', reason);
      return 'parked';
    }
  };
  for (;;) {
    if (round > 0) {
      const stoppedBeforeRework = honorParentSoftStop('rework');
      if (stoppedBeforeRework) {
        finalizeSupervisorDeliveries('soft-stop-before-rework');
        return { ...stoppedBeforeRework, ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(gate ? { gate } : {}), ...(review ? { review } : {}) };
      }
      onNodeEntry(node('rework'), round);
    }
    const adaptiveRework = resolveAdaptiveMaxReworkDecision(maxRework, failCounts, selfImplementConfig.reworkBudget.maxRounds, reviewFindingHistory);
    let effectiveMax = Math.max(adaptiveRework.maxRework, judgedEffectiveMax ?? 0);
    observe('adaptive-cap', { ...adaptiveRework }, { category: 'self-dev.rework' });
    let diagnosis: string | undefined;
    let judgmentStarted = false;
    if (round > 0) {
      lastReworkVerdict = undefined;
      lastSupervisorReason = undefined;
    }
    let escalationTriage: 'absent' | 'failed' | 'judged' | undefined;
    let escalationJudgement: string | undefined;
    if (round > 0 && s.diagnose) {
      try {
        const priorHistory = reworkHistory.slice(0, -1);
        let priorRuns: GoalPriorRuns | null = null;
        if (opts.goalId) {
          try {
            if (s.priorRunsByGoalId) {
              priorRuns = s.priorRunsByGoalId(opts.goalId, 10);
            } else {
              const store = new GoalRunStore();
              try {
                priorRuns = store.priorRunsByGoalId(opts.goalId, 10);
              } finally {
                store.close();
              }
            }
          } catch (error) {
            observe('prior-runs', { goalId: opts.goalId, available: false, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
          }
        }
        const diagnosisRefutations = pendingRefutations;
        // Capture the accumulator only after the preceding review has merged its findings.
        // The optional seam may retain its input, so it must receive this round's immutable snapshot.
        const accumulatedReviewFindingTelemetry = reviewFindingTelemetry();
        const reviewFindingTelemetrySnapshot = {
          ...accumulatedReviewFindingTelemetry,
          citedReviewSymbolOccurrences: [...accumulatedReviewFindingTelemetry.citedReviewSymbolOccurrences],
          normalizedReviewFindingRepeatCounts: [...accumulatedReviewFindingTelemetry.normalizedReviewFindingRepeatCounts],
        };
        const predictionAccuracyBefore = supervisorDecisionHistory.length
          ? judgePredictionAccuracy(supervisorDecisionHistory)
          : undefined;
        diagnosis = await withStepTimeout(s.diagnose({ runId, note: reworkJudgeNote, kind: reworkKind, round, cwd: wt.path, goal: opts.feature, history: priorHistory, supervisorDecisionHistory, ...(predictionAccuracyBefore ? { judgePredictionAccuracy: predictionAccuracyBefore } : {}), effectiveMax, priorRuns, reviewFindingTelemetry: reviewFindingTelemetrySnapshot, ...(diagnosisRefutations ? { refutations: diagnosisRefutations.refutations, refutationRound: diagnosisRefutations.round } : {}), purpose: 'budget' }), T.review, 'review');
        const diagnosedDecision = parseReworkBudgetDecision(diagnosis);
        if (diagnosedDecision?.verdict === 'CONTRACT-CONFLICT') lastSupervisorVerdict = diagnosedDecision.verdict;
        let parsedDecision = diagnosedDecision;
        judgmentStarted = true;
        const judgmentCallLLM = s.judgmentCallLLM;
        if (diagnosedDecision?.verdict !== 'CONTRACT-CONFLICT' && !judgmentCallLLM) throw new Error('rework-budget@v1 requires a judgment provider');
        const judgmentProvider = judgmentCallLLM ? createReworkBudgetJudgment(judgmentCallLLM) : undefined;
        try {
          const result = diagnosedDecision?.verdict === 'CONTRACT-CONFLICT'
            ? undefined
            : await withStepTimeout(
              runWorkflowToCompletion(
                {
                  workflow: reworkBudgetWorkflow,
                  arguments: diagnosis,
                  artifactsDir: '',
                  persistRun: false,
                  judgmentContext: { kind: reworkKind, history: priorHistory },
                },
                {
                  callLLM: judgmentCallLLM!,
                  runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                  runJudgment: judgmentProvider!,
                },
              ),
              T.review,
              'review',
            );
          if (result) {
            const classified = result.outputs['rework-budget'];
            if (!result.ok || !classified?.ok || typeof classified.output !== 'string') {
              throw new Error(classified?.error ?? 'rework-budget@v1 judgment failed');
            }
            const picked = classified.output === 'EXTEND' || classified.output === 'SUFFICIENT' || classified.output === 'UNCONVERGEABLE'
              ? classified.output
              : undefined;
            if (!picked) throw new Error(`rework-budget@v1 returned unsupported class '${String(classified.output)}'`);
            parsedDecision = { verdict: picked, reason: diagnosedDecision?.reason ?? 'workflow-fabric classification' };
          }
          consecutiveUnresolvedBudget = 0;
        } catch (error) {
          const message = safeErrorDescription(error);
          if (!message.startsWith('rework-budget@v1 classification did not resolve a supported class')
            && !message.startsWith('rework-budget@v1 returned unsupported class')) throw error;
          consecutiveUnresolvedBudget++;
          observe('rework-budget-unresolved-fallback', { round, error: message.slice(0, 200), consecutive: consecutiveUnresolvedBudget }, { level: 'warn' });
          parsedDecision = consecutiveUnresolvedBudget >= 2
            ? { verdict: 'UNCONVERGEABLE', reason: 'rework-budget classification unresolved ×2' }
            : undefined;
        }
        let fabricObservation: Record<string, unknown> | undefined;
        if (s.classifyCallLLM) {
          try {
            const shadow = await withStepTimeout(classifyReworkBudgetShadow(diagnosis, s.classifyCallLLM), T.review, 'review');
            fabricObservation = {
              round,
              fabricOk: shadow.ok,
              fabricDurationMs: shadow.durationMs,
              ...(parsedDecision ? { legacyVerdict: parsedDecision.verdict } : {}),
              ...(shadow.picked !== 'unknown' ? { fabricPicked: shadow.picked } : {}),
              ...(parsedDecision && shadow.picked !== 'unknown' ? { agree: shadow.picked === parsedDecision.verdict } : {}),
              ...(shadow.error ? { fabricError: shadow.error } : {}),
            };
          } catch (error) {
            fabricObservation = {
              round,
              fabricOk: false,
              ...(parsedDecision ? { legacyVerdict: parsedDecision.verdict } : {}),
              fabricError: error instanceof Error ? error.message : String(error),
            };
          }
        }
        const before = effectiveMax;
        const budgetDecision = applyReworkBudgetDecision(
          effectiveMax,
          parsedDecision,
          selfImplementConfig.reworkBudget.maxRounds,
          reworkKind,
          priorHistory.length,
          consecutiveUnresolvedBudget >= 2 ? false : shadowStop,
          supervisorDecisionHistory.at(-1)?.verdict,
        );
        effectiveMax = budgetDecision.effectiveMax;
        if (parsedDecision) {
          if (diagnosisRefutations) {
            const adjudications = parseSupervisorRefutationAdjudications(diagnosis, diagnosisRefutations.refutations);
            if (adjudications.length) {
              for (const { findingId, verdict } of adjudications) {
                if (verdict === 'accepted') acceptedRefutationFindingIds.add(findingId);
              }
              observe('refute-supervisor-adjudicated', {
                round: diagnosisRefutations.round,
                diagnosisRound: round,
                submittedCount: diagnosisRefutations.refutations.length,
                kinds: refutationKindCounts(diagnosisRefutations.refutations),
                acceptedCount: adjudications.filter(({ verdict }) => verdict === 'accepted').length,
                rejectedCount: adjudications.filter(({ verdict }) => verdict === 'rejected').length,
                adjudications,
                findingIds: diagnosisRefutations.refutations.map(({ findingId }) => findingId),
              });
            }
            if (parsedDecision.verdict === 'CONTRACT-CONFLICT') {
              const acceptedIds = new Set(adjudications.filter(({ verdict }) => verdict === 'accepted').map(({ findingId }) => findingId));
              pendingPlanRevision = {
                reason: parsedDecision.reason,
                ...(acceptedIds.size ? { refutations: diagnosisRefutations.refutations.filter(({ findingId }) => acceptedIds.has(findingId)) } : {}),
              };
            }
            pendingRefutations = undefined;
          } else if (parsedDecision.verdict === 'CONTRACT-CONFLICT') {
            pendingPlanRevision = { reason: parsedDecision.reason };
          }
          if (parsedDecision.verdict === 'CONTRACT-CONFLICT') {
            const relaxation: SupervisorPlanRevisionRelaxation | undefined = parseContractConflictRelaxation(diagnosis);
            if (relaxation) pendingPlanRevision = { ...pendingPlanRevision!, relaxation };
            if (opts.goalFile) {
              try {
                const recorded: SupervisorPlanRevisionResult = recordSupervisorPlanRevision(opts.goalFile, { reason: parsedDecision.reason, round, ...(relaxation ? { relaxation } : {}) });
                pendingPlanRevision = { ...pendingPlanRevision!, ...(relaxation ? { relaxation } : {}), application: {
                  status: recorded.status === 'applied' || recorded.status === 'already-applied' ? recorded.status : 'failed',
                  ...(recorded.detail ? { detail: recorded.detail } : {}),
                }, disposition: budgetDecision.contractConflictDisposition };
              } catch (error) {
                pendingPlanRevision = { ...pendingPlanRevision!, ...(relaxation ? { relaxation } : {}), application: { status: 'failed', detail: error instanceof Error ? error.message : String(error) }, disposition: budgetDecision.contractConflictDisposition };
              }
            }
            lastPlanRevision = pendingPlanRevision;
          }
          // ⭐⭐ 「이 판정을 내리기 «직전»에 판사의 지난 적중률이 얼마였나」 —
          //   ⛔ push «전»에 잰다. 뒤에 재면 이번 판정이 섞여 「그때 무엇을 알고 있었나」가 흐려진다.
          //   🔑 이 값이 있어야 「되먹임 줄을 준 뒤 빗나감이 줄었나」를 «전/후»로 비교할 수 있다.
          //     그것 없이는 「판단의 질이 높아졌다」를 말할 자가 없다(2026-08-20 · 대표 물음).
          const predictionAccuracyForObservation = predictionAccuracyBefore
            ?? judgePredictionAccuracy(supervisorDecisionHistory);
          supervisorDecisionHistory.push({ round, verdict: parsedDecision.verdict, reason: parsedDecision.reason });
          onSupervisorVerdictParsed(parsedDecision.verdict);
          lastSupervisorReason = extractSupervisorReason(diagnosis);
          onSupervisorReasonParsed(lastSupervisorReason);
          lastReworkVerdict = parsedDecision.verdict;
          const carriedBudgetBefore = judgedEffectiveMax;
          judgedEffectiveMax = resolveReworkBudgetCarry(parsedDecision, effectiveMax, carriedBudgetBefore, budgetDecision.shadowed === true);
          const supervisionObservation = (() => {
            try {
              return supervisionObservationFields(mapReworkVerdict(parsedDecision.verdict, reworkKind));
            } catch (error) {
              return { supervisionMappingError: String(error instanceof Error ? error.message : error).slice(0, 120) };
            }
          })();
          const repeatedBlockingIds = repeatedBlockingFindingIds(currentBlockingFindings, previousBlockingFindings);
          // ⭐⭐ 심을 «안 주면» 이제 기본 생산자가 돈다 — 종전엔 기본값이 `() => null` 이고
          //   주입자가 «전수 0» 이라 이 두 칸이 «영원히» null 이었다(🅕 실측 · 🅣 확인).
          //   ⛔ 검출기가 죽은 게 아니라 «아무도 안 불렀다» — 그것이 이 저장소의 반복 형태다.
          const measuredRecurrence = measureReviewFindingRecurrence(currentBlockingFindings, previousBlockingFindings, {
            acceptedRefutationFindingIds: [...acceptedRefutationFindingIds],
          });
          const recurrence = reworkBudgetReviewFindingRecurrence() ?? measuredRecurrence;
          const recurrenceDisagreementObservation = reworkBudgetRecurrenceDisagreementObservation(
            repeatedBlockingIds,
            recurrence,
            parsedDecision.verdict === 'UNCONVERGEABLE' && budgetDecision.stop && budgetDecision.exit === 'blocked',
          );
          // Evidence is additive telemetry: an unreadable accessor must not alter this round's judgment or budget decision.
          const evidenceObservation = judgmentProvider
            ? reworkBudgetEvidenceForObservation(judgmentProvider.evidenceForObservation)
            : { evidence: null };
          observe('rework-budget', { round, verdict: parsedDecision.verdict, reason: parsedDecision.reason.slice(0, 240), effectiveMaxBefore: before, effectiveMaxAfter: effectiveMax, carriedBudgetBefore, carriedBudgetAfter: judgedEffectiveMax, historyRounds: priorHistory.length, kind: reworkKind, applied: budgetDecision.applied, stopped: budgetDecision.stop, exit: budgetDecision.exit, shadowed: budgetDecision.shadowed === true, repeatedBlockingFindingCount: repeatedBlockingIds?.length ?? null, repeatedBlockingFindingIds: repeatedBlockingIds ?? null, normalizedRepeatedReviewFindingCount: recurrence?.normalizedRepeatedReviewFindingCount ?? null, ordinaryRepeatedReviewFindingCount: recurrence?.ordinaryRepeatedReviewFindingCount ?? null, previouslyDismissedRepeatedReviewFindingCount: recurrence?.previouslyDismissedRepeatedReviewFindingCount ?? null, citedReviewSymbolRepeatCount: recurrence?.citedReviewSymbolRepeatCount ?? null, citedReviewSymbolBaseNameRepeatCount: recurrence?.citedReviewSymbolBaseNameRepeatCount ?? null, reviewFindingComparableCount: recurrence?.comparableFindings ?? null, reviewFindingKeyRepeatCount: recurrence?.reviewFindingKeyRepeatCount ?? null, ...recurrenceDisagreementObservation, ...evidenceObservation, judgePredictedBefore: predictionAccuracyForObservation.predicted, judgeFulfilledBefore: predictionAccuracyForObservation.fulfilled, judgeMissedBefore: predictionAccuracyForObservation.missed, judgePendingBefore: predictionAccuracyForObservation.pending, ...(budgetDecision.shadowed ? { wouldExit: budgetDecision.wouldExit } : {}), ...(budgetDecision.contractConflictDisposition ? { contractConflictDisposition: budgetDecision.contractConflictDisposition } : {}), ...(pendingPlanRevision?.relaxation ? { contractConflictRelaxation: { ...pendingPlanRevision.relaxation, reason: pendingPlanRevision.reason, application: pendingPlanRevision.application?.status ?? 'failed' } } : {}), ...supervisionObservation }, { ...(budgetDecision.exit === 'blocked' ? { level: 'warn' as const } : {}), compact: { stringMax: 256, arrayMax: 6, maxDepth: 5 } });
          if (parsedDecision.verdict === 'UNCONVERGEABLE' && budgetDecision.stop && budgetDecision.exit === 'blocked') {
            try {
              const shadow = inferDecompositionShadow(opts.feature);
              observe('decomposition-shadow', { round, ...shadow });
              const decompositionPromise = Promise.resolve().then(() => (s.decomposeShadowGoals ?? decomposeSelfDevGoal)(opts.feature, {
                observation: { goalId: opts.goalId, runId },
              }));
              const deadline = Symbol('decomposition-deadline');
              let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
              const settlement = await Promise.race([
                decompositionPromise.then(
                  (pieces) => ({ status: 'fulfilled' as const, pieces }),
                  (error) => ({ status: 'rejected' as const, error }),
                ),
                new Promise<typeof deadline>((resolve) => {
                  deadlineTimer = setTimeout(() => resolve(deadline), T.decomposition);
                }),
              ]);
              if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
              if (settlement === deadline) {
                terminalDecomposition = { shadow, source: 'path-count-fallback', fallbackReason: 'decomposer-timeout' };
                observe('decomposition-shadow-wait-exceeded', {
                  round,
                  deadlineMs: T.decomposition,
                  reason: 'deadline-exceeded',
                  ...decompositionFallbackObservation(shadow),
                }, { level: 'warn' });
                void decompositionPromise.then(
                  (pieces) => {
                    const visiblePieces = pieces.goals.map(({ id, feature, dependsOn, goalType, hotPaths }, index) => ({
                      id: id ?? String(index), feature: feature.slice(0, 240), dependsOn: dependsOn ?? [], ...(goalType ? { goalType } : {}), ...(hotPaths?.length ? { hotPaths } : {}),
                    }));
                    observe('decomposition-shadow-late-settled', {
                      round, status: 'fulfilled', outcome: pieces.goals.length ? 'structured-fragments' : 'no-fragments',
                      pieceCount: pieces.goals.length, pieces: visiblePieces,
                    });
                  },
                  (error) => observe('decomposition-shadow-late-settled', {
                    round, status: 'rejected', outcome: 'decomposer-failed',
                    error: String(error instanceof Error ? error.message : error).slice(0, 240),
                  }, { level: 'warn' }),
                );
              } else if (settlement.status === 'fulfilled') {
                const { pieces } = settlement;
                if (pieces.goals.length) {
                  const visiblePieces = pieces.goals.map(({ id, feature, dependsOn, goalType, hotPaths }, index) => ({
                    id: id ?? String(index),
                    feature: feature.slice(0, 240),
                    dependsOn: dependsOn ?? [],
                    ...(goalType ? { goalType } : {}),
                    ...(hotPaths?.length ? { hotPaths } : {}),
                  }));
                  terminalDecomposition = { shadow, source: 'structured-decomposer', pieces: visiblePieces };
                  observe('decomposition-shadow-goals', { round, pieceCount: pieces.goals.length, pieces: visiblePieces });
                } else {
                  terminalDecomposition = { shadow, source: 'path-count-fallback', fallbackReason: 'no-fragments' };
                  observe('decomposition-shadow-fallback', { round, reason: 'no-fragments' }, { level: 'warn' });
                }
              } else {
                terminalDecomposition = { shadow, source: 'path-count-fallback', fallbackReason: 'decomposer-failed' };
                observe('decomposition-shadow-fallback', {
                  round,
                  reason: 'decomposer-failed',
                  error: String(settlement.error instanceof Error ? settlement.error.message : settlement.error).slice(0, 240),
                }, { level: 'warn' });
              }
              if (terminalDecomposition) {
                for (const line of terminalDecompositionLines(terminalDecomposition)) progress('aborted', line.replace(/^- /, ''));
              }
            } catch {
              // Observation must not prevent the pre-existing terminal path.
            }
          }
          if (parsedDecision.verdict === 'EXTEND' && !budgetDecision.applied) {
            observe('rework-budget-warning', {
              round,
              hardCap: selfImplementConfig.reworkBudget.maxRounds,
              verdict: parsedDecision.verdict,
              message: `⚠️ 감독이 EXTEND 를 냈으나 하드 상한(${selfImplementConfig.reworkBudget.maxRounds})에 막혀 예산이 늘지 않았다.`,
            }, { level: 'warn' });
          }
          observe('run-supervision.verdict', { moment: 'between-round', round, kind: reworkKind, effectiveMax, ...supervisionObservation });
          if (fabricObservation) observe('rework-budget-fabric-shadow', fabricObservation);
          if (budgetDecision.stop) {
            if (budgetDecision.exit === 'proceed') {
              finalizeSupervisorDeliveries('supervisor-rework-proceed');
              break;
            }
            finalizeSupervisorDeliveries('supervisor-rework-blocked');
            const terminal = resolveRunOutcome({ termination: 'supervisor-abandoned', verdict: 'UNCONVERGEABLE', applied: true });
            // A structured decomposition with multiple pieces observes a goal-side candidate; it does not prove a defect.
            const goalCauseObserved = hasMultipleStructuredTerminalPieces(terminalDecomposition);
            // A prior explicit contract conflict remains the stronger classification signal; UNCONVERGEABLE only
            // describes the final stop. The independently observed candidate is still carried for its own path.
            const supervisorVerdict = lastSupervisorVerdict === 'CONTRACT-CONFLICT'
              ? lastSupervisorVerdict
              : 'UNCONVERGEABLE' as const;
            const supervisorOutcome = { supervisorVerdict, ...(goalCauseObserved ? { goalCauseObserved: true as const } : {}) };
            if (isReviewRework(reworkKind)) {
              if (reflectRejectedAudit.length && review) review.shouldFix = [...review.shouldFix, ...reflectRejectedAudit];
              const pr = await preserveBlockedArtifacts({ stage: 'review-blocked', verdict: parsedDecision.verdict, reason: parsedDecision.reason, gate, decomposition: terminalDecomposition, salvageStatusExpected: false });
              const quotaExhaustionAssessment = quotaExhaustionAssessmentForRun();
              return { ok: false, stage: 'review-blocked', node: 'rework', ...terminal, ...supervisorOutcome, sessionId, worktreePath: wt.path, branch: wt.branch, gate, review, quotaExhaustionAssessment, ...(lastSupervisorReason ? { supervisorReason: lastSupervisorReason } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: `rework judged unconvergeable after ${round} rework round(s): ${parsedDecision.reason}` };
            }
            const baselineStop = noRetryBaseline();
            const reason = baselineStop.terminationReason ?? parsedDecision.reason;
            const pr = await preserveBlockedArtifacts({ stage: 'gate-failed', verdict: parsedDecision.verdict, reason, gate, decomposition: terminalDecomposition, salvageStatusExpected: false });
            const quotaExhaustionAssessment = quotaExhaustionAssessmentForRun();
            return { ok: false, stage: 'gate-failed', node: 'rework', ...terminal, ...supervisorOutcome, ...baselineStop, sessionId, worktreePath: wt.path, branch: wt.branch, gate, quotaExhaustionAssessment, ...(lastSupervisorReason ? { supervisorReason: lastSupervisorReason } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: baselineStop.terminationReason ?? `rework judged unconvergeable after ${round} rework round(s): ${parsedDecision.reason}` };
          }
        } else {
          const repeatedBlockingIds = repeatedBlockingFindingIds(currentBlockingFindings, previousBlockingFindings);
          observe('rework-budget', { round, verdict: null, reason: null, effectiveMaxBefore: before, effectiveMaxAfter: effectiveMax, carriedBudgetBefore: judgedEffectiveMax, carriedBudgetAfter: judgedEffectiveMax, historyRounds: priorHistory.length, kind: reworkKind, applied: false, stopped: false, repeatedBlockingFindingCount: repeatedBlockingIds?.length ?? null, repeatedBlockingFindingIds: repeatedBlockingIds ?? null });
          if (fabricObservation) observe('rework-budget-fabric-shadow', fabricObservation);
        }
      } catch (error) {
        if (judgmentStarted) throw error;
        consecutiveUnresolvedBudget = 0;
      }
    } else if (round > 0) {
      consecutiveUnresolvedBudget = 0;
    }
    if (round > effectiveMax) {
      finalizeSupervisorDeliveries('rework-round-limit');
      if (lastReworkVerdict === 'UNCONVERGEABLE') {
        const terminal = resolveRunOutcome({ termination: 'supervisor-abandoned', verdict: 'UNCONVERGEABLE', applied: true });
        const reason = `rework judged unconvergeable after ${round - 1} rework round(s)`;
        if (isReviewRework(reworkKind)) {
          if (reflectRejectedAudit.length && review) review.shouldFix = [...review.shouldFix, ...reflectRejectedAudit];
          const pr = await preserveBlockedArtifacts({ stage: 'review-blocked', verdict: lastReworkVerdict, reason, gate, salvageStatusExpected: false });
          return { ok: false, stage: 'review-blocked', node: 'rework', ...terminal, sessionId, worktreePath: wt.path, branch: wt.branch, gate, review, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(lastSupervisorVerdict === 'CONTRACT-CONFLICT' ? { supervisorVerdict: lastSupervisorVerdict } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: reason };
        }
        const baselineStop = noRetryBaseline();
        const pr = await preserveBlockedArtifacts({ stage: 'gate-failed', verdict: lastReworkVerdict, reason: baselineStop.terminationReason ?? reason, gate, salvageStatusExpected: false });
        return { ok: false, stage: 'gate-failed', node: 'rework', ...terminal, ...baselineStop, sessionId, worktreePath: wt.path, branch: wt.branch, gate, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(lastSupervisorVerdict === 'CONTRACT-CONFLICT' ? { supervisorVerdict: lastSupervisorVerdict } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: baselineStop.terminationReason ?? reason };
      }
      const terminal = resolveRunOutcome({ termination: 'budget-exhausted', ...(lastReworkVerdict ? { lastVerdict: lastReworkVerdict } : {}) });
      // ⛔⭐ **보존(=커밋·push) 뒤에 발사한다.** 종전엔 발사가 먼저라, 인수 자식이 `--base <그 브랜치>`
      //   로 뜰 때 그 브랜치가 **아직 origin 에 없어** `assertBaseBranchOnOrigin` 이 던질 수 있었다
      //   (`#6138` 리뷰 should-fix · 원장 `RUN-T5`). 발사 자체가 산출을 잇는 것이므로 **산출이 원격에
      //   있고 나서** 띄우는 것이 순서다.
      const canSalvage = terminal.outcome === 'budget-exhausted'
        && lastReworkVerdict === 'EXTEND' && terminal.supervisorWantedContinue === true;
      if (isReviewRework(reworkKind)) {
        if (reflectRejectedAudit.length && review) review.shouldFix = [...review.shouldFix, ...reflectRejectedAudit];
        const reason = `review must-fix unresolved after ${round - 1} rework round(s)`;
        const acceptance = await acceptReviewBudget(
          review?.mustFix ?? [],
          reworkParts.some((part) => part.source === 'supervisor'),
        );
        if (acceptance.decision.action === 'accept') {
          return {
            ok: true,
            stage: 'pr-opened',
            node: 'open-pr',
            ...terminal,
            sessionId,
            worktreePath: wt.path,
            branch: wt.branch,
            gate,
            review,
            mergeReason: 'review-budget-follow-up-required',
            followUpMustFix: acceptance.decision.unresolvedMustFix,
            followUpMustFixCount: acceptance.decision.unresolvedMustFix.length,
            ...(acceptance.pr ? { prUrl: acceptance.pr.url, prNumber: acceptance.pr.number } : {}),
            detail: `${reason}; accepted with ${acceptance.decision.unresolvedMustFix.length} follow-up must-fix item(s)`,
          };
        }
        const pr = await preserveBlockedArtifacts({ stage: 'review-blocked', reason, gate, salvageStatusExpected: true });
        const salvage = await salvageHardCap(canSalvage, pr);
        const disposition = { ...terminal, ...(salvage ? { salvage } : {}) };
        return { ok: false, stage: 'review-blocked', node: 'rework', ...disposition, sessionId, worktreePath: wt.path, branch: wt.branch, gate, review, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(lastSupervisorVerdict === 'CONTRACT-CONFLICT' ? { supervisorVerdict: lastSupervisorVerdict } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: reason };
      }
      const baselineStop = noRetryBaseline();
      const reason = baselineStop.terminationReason ?? `gate failed after ${round - 1} rework round(s)`;
      const pr = await preserveBlockedArtifacts({ stage: 'gate-failed', reason, gate, salvageStatusExpected: !baselineStop.terminationReason });
      const salvage = baselineStop.terminationReason ? 'parked' : await salvageHardCap(canSalvage, pr);
      const disposition = { ...terminal, ...(salvage ? { salvage } : {}), ...baselineStop };
      return { ok: false, stage: 'gate-failed', node: 'rework', ...disposition, sessionId, worktreePath: wt.path, branch: wt.branch, gate, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(lastSupervisorVerdict === 'CONTRACT-CONFLICT' ? { supervisorVerdict: lastSupervisorVerdict } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: reason };
    }

    const reworkPromptNote = reworkNote;
    const escalateTier: EscalateTier = resolveEscalateTier(round, effectiveMax, reworkKind);
    const escalationEligible = round > 0 && escalateTier !== 'none';
    if (escalationEligible && s.diagnose) {
      try {
        escalationJudgement = await withStepTimeout(s.diagnose({
          runId, note: reworkNote, kind: reworkKind, round, cwd: wt.path, goal: opts.feature,
          history: reworkHistory.slice(0, -1), supervisorDecisionHistory, effectiveMax,
          purpose: 'escalation-triage',
        }), T.review, 'review');
        escalationTriage = escalationJudgement.trim() ? 'judged' : 'absent';
      } catch (error) {
        escalationTriage = 'failed';
        observe('rework-triage', {
          round, escalateTier, status: escalationTriage,
          error: error instanceof Error ? error.message : String(error),
        }, { level: 'warn' });
      }
    }
    const feature = round === 0
      ? round0Feature
      : buildReworkFeature(opts.feature, round, effectiveMax, reworkPromptNote, stripReworkBudgetHeaders(diagnosis), appliedLastRound, refutableFindings, pendingPlanRevision, reworkKind, buildRefutationGuidance(), escalationJudgement);
    const refutationGuidanceEligible = round > 0 && refutableFindings.length > 0;
    const dispatchedRefutationGuidance = refutationGuidancePresented(feature, refutationGuidanceEligible);
    pendingPlanRevision = undefined;
    onRoundExecution(escalateTier);
    progress('implementing', round === 0
      ? '구현 중 (헤드리스 goal-loop·수분 소요)…'
      : formatReworkProgressLine(round, effectiveMax, escalateTier, attemptOrdinal));
    if (round > 0) {
      try { emitDecision(reworkDecision({ runId, round, effectiveMax, escalateTier, kind: reworkKind })); } catch { /* observation must not interrupt rework */ }
    }
    let reworkArtifactPath: string | undefined;
    if (round > 0) {
      try {
        reworkArtifactPath = (s.persistReworkNoteArtifact ?? ((input) => createArtifactStore().put('block', JSON.stringify(input, null, 2), {
          origin: input.origin,
          producer: 'rework-observation',
          tags: ['rework', 'full-output'],
          description: `rework ${input.kind}, round ${input.round}`,
        })))({ origin: 'self-implement-rework', runId, round, kind: reworkKind, note: reworkNote }).path;
      } catch {
        observe('rework-artifact-failed', { round, kind: reworkKind }, { level: 'warn' });
      }
      observe('rework', {
        round, effectiveMax, escalateTier, kind: reworkKind, hasDiagnosis: !!diagnosis,
        ...(escalationEligible && escalationTriage ? { triageStatus: escalationTriage } : {}),
        ...(escalationEligible && escalationJudgement?.trim() ? { triageJudgement: escalationJudgement.trim().slice(0, 240) } : {}),
        noteTail: reworkNote.slice(-240), noteLength: reworkNote.length,
        ...(reworkArtifactPath ? { artifactPath: reworkArtifactPath } : {}),
      });
    }
    reworkParts = [];
    reworkNote = '';
    if (reworkPromptNote && supervisorDeliveryUpdates.length) {
      for (const { update } of supervisorDeliveryUpdates) update?.('prompt-included');
    }
    const deliveryUpdatesForThisRound = supervisorDeliveryUpdates;
    supervisorDeliveryUpdates = [];
    try {
      // ⭐ 대표 지시 ③ «다이나믹» — 「실제 구현간에 다이나믹 대응으로 바꿀수 있게」.
      //   ⛔ 라운드 «시작»에 «앞을 보는 것»만 얹는다. 지난 걸음은 안 건드린다.
      applyRuntimeOverlays(round);
      // ⭐ RFC §5 — 선언된 «방문 예산»을 실행이 «읽는다». ⛔ 관측만이다(막지 않는다) —
      //   「얼마나 물지」를 먼저 재야 하고, 예산부터 걸면 런이 조용히 죽는다.
      onNodeEntry(node('implement'), round);
    } catch (error) {
      for (const { text, update } of deliveryUpdatesForThisRound) {
        recordUndeliveredSupervisorInput(text, 'next-round-node-entry-failed');
        update?.('not-delivered', 'next-round-node-entry-failed');
      }
      throw error;
    }
    const implementAbortController = new AbortController();
    let implementPromise: ReturnType<SelfImplementSeams['implement']>;
    // Rework needs landed sibling PRs only after the initial round; shard eligibility avoids an expensive impossible lookup.
    const landedSiblings = round > 0
      ? queryShardSiblingsForContext('rework-context', shardIdentity, s.queryRunChain ?? queryRunChain, (chain) => {
        const current = chain.entries.find((entry) => entry.runId === runId);
        return current?.shardSiblings.length ? budgetLandedShardSiblings(current.shardSiblings, chain.entries) : undefined;
      }, observe)
      : undefined;
    // ⛔⭐ **이 콜백은 「호출별」로 닫힌다**(무인 리뷰 must-fix · 2026-08-14).
    //   `withStepTimeout` 이 던져도 자식 promise 는 «취소되지 않는다» — 자식은 계속 돌고
    //   그 뒤에도 `onSupervisorInput` 을 부른다. 닫는 표식이 없으면 그 늦은 입력이
    //   **이미 비워진** `supervisorDeliveryUpdates` 에 «다시» 쌓이고, 그 라운드의 종결자는
    //   이미 지나갔으므로 **영영 종결되지 않는다**(delivery 관측이 조용히 비게 된다).
    //   ⇒ 닫힌 뒤 도착한 입력은 그 자리에서 `not-delivered` 로 «이름을 대고» 끝낸다.
    let supervisorInputClosed = false;
    const closeSupervisorInput = (): void => { supervisorInputClosed = true; };
    try {
      implementPromise = s.implement({
      sessionId, cwd: wt.path, feature, runId, shardIdentity, signal: implementAbortController.signal,
      ...(harnessSeededPaths.length ? { harnessSeededPaths } : {}),
      onSurfaceProgress: (line) => progress('implementing', line.trimEnd()),
      onLifecycleScreenClassification: recordRoundClassification,
      ...(round > 0 ? { roundContext: { round, effectiveMax, previousRoundFailure: reworkPromptNote, ...(landedSiblings ? { landedSiblings } : {}) } } : {}),
      onSupervisorInput: (text, updateDelivery) => {
        const normalized = text.trim();
        if (!normalized) {
          updateDelivery?.('not-delivered', 'empty-supervisor-input');
          return;
        }
        if (supervisorInputClosed) {
          recordUndeliveredSupervisorInput(normalized, 'late-supervisor-input');
          updateDelivery?.('not-delivered', 'late-supervisor-input');
          return;
        }
        const superseded = supervisorDeliveryUpdates;
        supervisorDeliveryUpdates = [];
        for (const { text: supersededText, update } of superseded) {
          recordUndeliveredSupervisorInput(supersededText, 'superseded-by-later-supervisor-input');
          update?.('not-delivered', 'superseded-by-later-supervisor-input');
        }
        setReworkPart('supervisor', normalized);
        supervisorDeliveryUpdates.push({ text: normalized, update: updateDelivery });
      },
      ...(escalateTier !== 'none' ? { escalateTier } : {}),
      ...(opts.childLlm ? { childLlm: opts.childLlm } : {}),
      ...(opts.documentReferences ? { documentReferences: opts.documentReferences } : {}),
    });
    } catch (error) {
      closeSupervisorInput();
      for (const { text, update } of deliveryUpdatesForThisRound) {
        recordUndeliveredSupervisorInput(text, 'next-round-implement-call-failed');
        update?.('not-delivered', 'next-round-implement-call-failed');
      }
      throw error;
    }
    for (const { update } of deliveryUpdatesForThisRound) update?.('delivered');
    try {
      impl = await stepTimeout(implementPromise, T.implement, 'implement');
    } catch (error) {
      closeSupervisorInput();
      if (error instanceof StepTimeoutError) {
        implementAbortController.abort();
        logRunAwareFailSoft(runId, 'implement-timeout-abort', { round, ms: error.ms });
      }
      finalizeSupervisorDeliveries(error instanceof StepTimeoutError ? 'next-round-implement-timeout' : 'next-round-implement-rejected');
      throw error;
    }
    // ⭐ 성공 경로에서도 닫는다 — 이 호출은 끝났고, 이후 자식이 늦게 보내는 입력은
    //   「이 라운드의 재투입」이 아니다(다음 라운드는 자기 콜백을 새로 만든다).
    closeSupervisorInput();
    // A finished child can leave edits without a commit. Measure them before any
    // diff/no-changes classification, and commit only paths declared in the goal.
    finishedChildCommitMissing = false;
    finishedChildCommitFailure = undefined;
    finishedChildCommitted = false;
    if (impl.ok) {
      const work = (s.detectUncommittedWork ?? detectUncommittedWork)(wt.path);
      if (work.status === 'unavailable') {
        // Fail closed when the branch already carries commits: a PR could open without knowing whether the
        // goal's changes were committed (HARV1 review round 3). With no commits, the no-changes path decides.
        let branchFiles: readonly string[] | undefined;
        try { branchFiles = (s.changedFilesForGateRoute ?? changedFiles)(wt.path); } catch { branchFiles = undefined; }
        // Only a run that would open a PR needs the block — worktree-only completion opens none.
        // A path that isn't a git worktree at all (no .git) has nothing to open a PR from — only real worktrees block.
        const blocks = opts.completion !== 'worktree-only' && existsSync(join(wt.path, '.git'))
          && (branchFiles === undefined || branchFiles.length > 0);
        if (blocks) {
          finishedChildCommitMissing = true;
          finishedChildCommitFailure = `working tree status unavailable: ${work.reason ?? 'unknown'}`;
        }
        observe('finished-child-commit', { round, status: 'unavailable', reason: work.reason, blocked: blocks }, { level: 'warn' });
      } else if (work.status === 'changes') {
        let goalDocument: string | undefined;
        if (opts.goalFile) {
          try { goalDocument = readFileSync(opts.goalFile, 'utf8'); } catch { /* no declared scope */ }
        }
        const declared = goalDocument === undefined ? undefined : declaredPathsFromGoalDocumentText(goalDocument);
        const targets = declared?.readable
          ? declared.paths
          : inferHotPaths(targetScopedGoalText(opts.feature));
        const eligible = [...new Set([...work.trackedChanges, ...work.untrackedFiles])]
          .filter((path) => !harnessSeededPaths.includes(path)
            && targets.some((target) => changedFileIsInsideDeclaredTarget(path, target)));
        if (eligible.length) {
          inspectStaleReverts(revertGuardTargetPaths(opts.feature, goalDocument));
          const message = `self-implement: ${prTitle(opts.feature)}`;
          let outcome: { ok: boolean; out: string };
          try {
            outcome = (s.commitFinishedChildWork ?? ((cwd, paths, title) => {
              const env = { ...process.env };
              for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
              const childName = `elanous child ${runId}`;
              const childEmail = `child+${runId.replace(/[^a-zA-Z0-9-]/g, '')}@elanous.local`;
              env.GIT_AUTHOR_NAME = childName;
              env.GIT_AUTHOR_EMAIL = childEmail;
              env.GIT_COMMITTER_NAME = childName;
              env.GIT_COMMITTER_EMAIL = childEmail;
              const git = (args: string[]) => spawnSync('git', ['--no-optional-locks', ...args], {
                cwd, env, encoding: 'utf8', timeout: 20_000,
              });
              const staged = git(['add', '-A', '--', ...paths]);
              if (staged.status !== 0) return { ok: false, out: staged.stderr || staged.stdout || staged.error?.message || 'git add failed' };
              // --only commits these paths even when unrelated edits were staged before the child finished.
              const commit = git(['commit', '-m', title, '--only', '--', ...paths]);
              return { ok: commit.status === 0, out: commit.stderr || commit.stdout || commit.error?.message || '' };
            }))(wt.path, eligible, message);
          } catch (error) {
            outcome = { ok: false, out: safeErrorDescription(error) };
          }
          finishedChildCommitMissing = !outcome.ok;
          finishedChildCommitFailure = outcome.ok ? undefined : outcome.out;
          finishedChildCommitted = outcome.ok;
          observe('finished-child-commit', {
            round, status: outcome.ok ? 'committed' : 'commit-missing', paths: eligible,
            ...(outcome.ok ? {} : { reason: outcome.out.slice(0, 500) }),
          }, outcome.ok ? {} : { level: 'warn' });
        } else {
          observe('finished-child-commit', { round, status: 'out-of-scope' });
        }
      }
    }
    // ⭐ S3 — 자식 요약에서 diff 밖 이행 주장을 분류한다(자식 반환 계약은 그대로 둔다).
    //   ⛔ 버린 것을 **세어서** 남긴다 — 조용히 버리면 관측값이 항상 0이 되어 거짓 초록이 된다.
    // ★ I-9/RUN-T6 — 꼬리 2000자가 아니라 **수확본**에서 판다. 자식이 먼저 돌린 tsc·뮤테이션 출력이
    //   창 밖으로 밀려 파서에 도달조차 못 하던 자리다. 미주입 seam 은 종전대로 요약에서 판다(무회귀).
    // ⛔ `??` 가 아니라 **빈 문자열도 폴백**이다 — 수확본이 비면 *"수확했다"* 가 아니라 *"없다"* 이고,
    //    `??` 로 두면 관측이 `harvested` 라 **거짓을 말한다**(리뷰 3R).
    const harvested = impl.evidenceTranscript?.trim() ? impl.evidenceTranscript : undefined;
    const childEvidenceSource = harvested ?? impl.summary;
    let diffEvidence = '';
    let roundObservationMeasurementBasis: ObservationMeasurementBasis | undefined;
    let diffEvidenceTruncated = false;
    let diffEvidenceStatus: 'unavailable' | 'empty' | 'available' | 'failed' = 'unavailable';
    if (s.reviewScopeDiff) {
      try {
        const reviewBase = resolvedBase ?? 'origin/main';
        const reviewBaseOrigin = resolvedBase === null ? 'default-origin-main' : 'resolved-base';
        const scopeDiff = await s.reviewScopeDiff(wt.path, reviewBase, runId, reviewBaseOrigin);
        const baselineSource = await (s.reviewBaselineObservationSource ?? baselineObservationSource)(wt.path, reviewBase);
        if (baselineSource !== undefined) roundObservationMeasurementBasis = classifyObservationMeasurement(scopeDiff, baselineSource);
        const extracted = addedDiffEvidence(scopeDiff);
        diffEvidence = extracted.text;
        diffEvidenceTruncated = extracted.truncated;
        diffEvidenceStatus = diffEvidence ? 'available' : 'empty';
      } catch {
        diffEvidenceStatus = 'failed';
      }
    }
    if (roundObservationMeasurementBasis) onObservationMeasurementBasis(roundObservationMeasurementBasis);
    const evidenceText = diffEvidence ? `${childEvidenceSource}\n${diffEvidence}` : childEvidenceSource;
    evidenceSource = diffEvidence ? 'diff-added-lines' : harvested ? 'harvested' : 'summary-tail';
    offDiffEvidence = parseOffDiffEvidence(evidenceText);
    const requiredEvidence = requiredEvidenceFromGoal(opts.feature);
    const limitationCount = authorLimitationCountFromGoal(opts.feature);
    runRequiredEvidenceChecks(opts.feature, wt.path, runId);
    const coverage = coverRequiredEvidence(requiredEvidence, offDiffEvidence.items);
    evidenceCoverage = requiredEvidence.length || limitationCount
      ? {
        required: requiredEvidence.length,
        covered: coverage.covered.length,
        missing: coverage.missing,
        coveredByLimitation: coverage.coveredByLimitation,
        uncovered: coverage.uncovered,
        coveredByLimitationCount: coverage.coveredByLimitationCount,
        uncoveredCount: coverage.uncoveredCount,
        limitationCount,
      }
      : undefined;
    if (evidenceCoverage) {
      onEvidenceCoverage({
        required: evidenceCoverage.required,
        covered: evidenceCoverage.covered,
        uncovered: evidenceCoverage.uncoveredCount,
      });
    }
    const evidenceStringCount = evidenceText.match(/EVIDENCE/gi)?.length ?? 0;
    // ★ 수확본 본문 — PR 본문과 **같은** `harvestedForPr()` 결과. 수(count)만 남기면 조회가 조각을 재조립해야 한다.
    //    compact 기본 256자는 본문을 조용히 자르므로, 수확 상한(이미 정직한 절단)보다 좁히지 않는다.
    const harvestObs = harvestedEvidenceObservation(harvestedForPr());
    observe('off-diff-evidence', {
      round,
      evidenceStringCount,
      kept: offDiffEvidence.items.length,
      discardedMissingVerify: offDiffEvidence.discardedMissingVerify,
      truncatedResult: offDiffEvidence.truncatedResult,   // ★ 상한이 부족한지 물을 수 있게(계약 압력)
      anchoredEvidence: offDiffEvidence.anchoredEvidence,   // ★ I-23 — 충전율의 **정직한 분모**(evidenceStringCount 는 낱말 수라 분모가 아니다)
      // ★ I-24 — 골이 이름으로 요구한 증거의 **충족 여부**. 태그 동등이라 해석이 없다.
      ...(requiredEvidence.length ? {
        requiredEvidence: requiredEvidence.length,
        coveredEvidence: coverage.covered.length,
        missingEvidence: coverage.missing,
        coveredByLimitationEvidence: coverage.coveredByLimitation,
        uncoveredEvidence: coverage.uncovered,
        coveredByLimitationCount: coverage.coveredByLimitationCount,
        uncoveredCount: coverage.uncoveredCount,
      } : {}),
      evidenceSource,
      ...(diffEvidence || diffEvidenceStatus === 'failed' || diffEvidenceStatus === 'unavailable' || diffEvidenceTruncated ? { diffEvidenceStatus, diffEvidenceChars: diffEvidence.length, diffEvidenceTruncated } : {}),
      discardedEmptyClaim: offDiffEvidence.discardedEmptyClaim,
      missingResult: offDiffEvidence.missingResult,
      orphanResult: offDiffEvidence.orphanResult,
      ...harvestObs,
    }, { compact: { stringMax: Math.max(MAX_HARVESTED_EVIDENCE_CHARS, harvestObs.harvestedEvidence?.length ?? 0) } });
    if (impl.ok) completionDisposition = finishedChildCommitMissing || finishedChildCommitted ? undefined : impl.completionDisposition;
    const effectiveDisposition = impl.ok ? completionDisposition : impl.completionDisposition;
    observe('implemented', { ok: impl.ok, round, ...(effectiveDisposition ? { completionDisposition: effectiveDisposition } : {}) });
    progress('implemented', impl.ok ? (round === 0 ? '구현 완료' : `rework ${round} 완료`) : impl.completionDisposition ? '변경 없이 완료 검증' : '구현 실패(worktree 보존)');
    if (!impl.ok) {
      finalizeSupervisorDeliveries('next-round-implement-not-ok');
      const abort = buildImplementAbortRecord(impl.summary, impl.terminalStatus);
      const progressLine = formatImplementAbortProgressLine(abort.reason, impl.toolCalls);
      observe('implement-abort-reason', {
        hasReason: progressLine !== IMPLEMENT_ABORT_PROGRESS_BASE,
        // ⭐ 단위를 이름에 담는다(`R-CLM16`) — 「글자 수」와 UTF-16 코드 «단위»는 다르다.
        reasonCodePoints: Array.from(abort.reason).length,
        reasonCodeUnits: abort.reason.length,
        toolCalls: impl.toolCalls ?? null,
      });
      progress('aborted', progressLine);
      const pr = await preserveBlockedArtifacts({
        stage: 'aborted',
        reason: abort.reason,
        childSummary: abort.childSummary,
        reasonTruncated: abort.reasonTruncated,
        // ⛔ `null` 은 「분류를 못 했다」는 «값»이다 — 키를 빼면 「해당 없음」과 구분이 사라진다.
        //   그 구분은 #17894 가 «스스로» 만든 것이고(그 전엔 'other' 였다), 같은 판에서 조용히 지워졌다.
        failureKind: abort.failureKind,
        salvageStatusExpected: false,
        ...(abort.terminalStatus ? { terminalStatus: abort.terminalStatus } : {}),
      });
      return { ok: false, stage: 'aborted', node: 'implement', ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, worktreePath: wt.path, branch: wt.branch, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(impl.completionDisposition ? { completionDisposition: impl.completionDisposition } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: impl.summary };
    }

    if (finishedChildCommitMissing) {
      finalizeSupervisorDeliveries('finished-child-commit-missing');
      const detail = `finished child changes could not be committed: ${finishedChildCommitFailure ?? 'commit failed'}`;
      progress('aborted', detail);
      return { ok: false, stage: 'aborted', node: 'implement', ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, worktreePath: wt.path, branch: wt.branch, detail };
    }

    // Measure the existing declared-target boundary after implementation, before gate/PR.
    // Unknown declaration or changed files cannot justify an invented choice.
    let gateRouteFiles: readonly string[] | undefined;
    try { gateRouteFiles = (s.changedFilesForGateRoute ?? changedFiles)(wt.path); } catch { gateRouteFiles = undefined; }
    if (opts.goalFile) {
      let goalDocument: string | undefined;
      try { goalDocument = readFileSync(opts.goalFile, 'utf8'); } catch { /* unknown scope */ }
      const scope = detectDeclaredScopeDiff({ goalDocument, changedFiles: gateRouteFiles?.filter(file => !harnessSeededPaths.includes(file)), nameCap: gateRouteFiles?.length });
      if (scope.status === 'known' && scope.outsideCount !== null && scope.outsideCount > 0) {
        const result: ExecutionClarificationResult = await (s.askExecutionClarification ?? askAtExecution)({
          id: 'execution_scope', decision: 'Changing files outside the authored target paths',
          prompt: 'Implementation changed files outside the authored target paths. Keep the original scope or expand it?',
          whyNow: 'Continuing to gate or publish these edits would expand the requested scope.',
          impact: scope.outsideNames.some(file => {
            if (existsSync(join(wt.path, file))) return false;
            const tracked = runGitCommand(wt.path, ['ls-files', '--error-unmatch', '--', file], { encoding: 'utf8', timeout: 20_000 });
            return tracked.status === 0;
          }) ? 'critical' : 'high',
          options: [
            { label: 'Stay in scope', description: 'Do not accept out-of-scope changes.', recommended: true },
            { label: 'Expand scope', description: 'Accept the changed files outside the target paths.' },
          ],
        }, { runId }, { writeRunLedger: s.writeRunLedger });
        if ('parked' in result || 'deferred' in result || result.choice !== 'Expand scope') {
          finalizeSupervisorDeliveries('execution-scope-not-approved');
          observe('execution-scope-held', { outsideCount: scope.outsideCount, disposition: 'parked' in result ? 'parked' : 'in-scope-only' });
          if ('parked' in result) progress('parked', `critical 질문 ${result.questionId} 미응답 — 이 런만 대기`);
          return { ok: false, stage: 'parked' in result ? 'parked' : 'soft-stopped', node: 'implement', ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, worktreePath: wt.path, branch: wt.branch,
            detail: 'parked' in result ? `critical-unanswered: ${result.questionId}` : 'Out-of-scope edits held in the worktree; gate and publication skipped.' };
        }
      }
    }

    // ⛔⭐ 이 템플릿이 `gate` 노드를 «안 가지면» 그 단계는 돌지 않는다.
    //   📌 research-loop 이 그렇다 — 문서만 바뀐 판에는 «변경 파일 범위» 게이트가 돌 시험이 없다.
    //   ⚠️ 꺼진 상태에서는 언제나 implement-loop 이라 참이다 ⇒ 오늘과 «같은» 걸음이다.
    //   🚨 **알려진 구멍**: research 골이 «코드»를 만지면 이 판은 시험을 건너뛴다.
    //     기본이 꺼짐이라 지금 폭발 반경은 0이고, 기본을 켜기 «전»에 이 구멍을 먼저 막아야 한다.
    // ⛔⭐ 라우터가 판정한다 — 값은 «코드»가 낸다(RFC §4.3 ⑵). 「모른다」는 «돌린다» 쪽이다.
    //   🚨 이 줄이 2026-09-08 승격의 구멍 ⓐ 를 닫는다: research 골이 «코드»를 만지면 시험이 돈다.
    const gateRoute = routeGate(graphTemplate, gateRouteFiles);
    const runsGate = gateRoute.runsGate;
    progress('gating', !runsGate
      ? `gate 건너뜀 — 이 그래프(${graphTemplate.graphId})는 gate 노드를 갖지 않는다`
      : round === 0 ? 'gate 실행 (bun test/build+tsc)…' : `gate 재검 (rework ${round})…`);
    try {
      if (runsGate) {
        const stoppedBeforeGate = honorParentSoftStop('gate');
        if (stoppedBeforeGate) {
          finalizeSupervisorDeliveries('soft-stop-before-gate');
          return { ...stoppedBeforeGate, ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(review ? { review } : {}) };
        }
        onNodeEntry(node('gate'), round);
        gate = await stepTimeout(s.gate(wt.path, { runId, round }), T.gate, 'gate');
      } else {
        observe('gate-skipped-by-graph', { ...graphAuthorityFields(graphAuthority, graphTemplate), round, reason: gateRoute.reason, changedFileCount: gateRouteFiles?.length ?? null });
        gate = {
          passed: true,
          log: `이 그래프(${graphTemplate.graphId})는 gate 노드를 갖지 않아 게이트를 돌리지 않았다.`,
        };
      }
    } catch (error) {
      finalizeSupervisorDeliveries(error instanceof StepTimeoutError ? 'next-round-gate-timeout' : 'next-round-gate-failed');
      throw error;
    }
    let loadAtEnd: number | null = null;
    try {
      const sampled = (s.sampleLoadAtEnd ?? (() => loadavg()[0]))();
      loadAtEnd = typeof sampled === 'number' && Number.isFinite(sampled) ? sampled : null;
    } catch {
      loadAtEnd = null;
    }
    observe('gated', {
      passed: gate.passed,
      loadAtEnd,
      // ⛔ 「통과」와 「미실행」은 다른 값이다 — 원장에서도 가른다.
      gateExecuted: runsGate,
      gateRouteReason: gateRoute.reason,
      round,
      ...(gate.testStepExecuted !== undefined ? { testStepExecuted: gate.testStepExecuted } : {}),
      ...(gate.scopeReason !== undefined ? { scopeReason: gate.scopeReason } : {}),
      ...(gate.unverified !== undefined ? { unverified: gate.unverified } : {}),
      ...(gate.importerTestsNotRun !== undefined ? { importerTestsNotRun: gate.importerTestsNotRun } : {}),
      ...(gate.missingTestFiles !== undefined ? { missingTestFiles: gate.missingTestFiles } : {}),
      ...(gate.testDeclarationDecline !== undefined ? { testDeclarationDecline: gate.testDeclarationDecline } : {}),
      ...(gate.reflectGateFacts ? {
        ...(gate.reflectGateFacts.introduced !== undefined ? { introduced: gate.reflectGateFacts.introduced } : {}),
        ...(gate.reflectGateFacts.preexisting !== undefined ? { preexisting: gate.reflectGateFacts.preexisting } : {}),
        ...(gate.reflectGateFacts.unknown !== undefined ? { unknown: gate.reflectGateFacts.unknown } : {}),
        ...(gate.reflectGateFacts.timedOut !== undefined ? { timedOut: gate.reflectGateFacts.timedOut } : {}),
        ...(gate.reflectGateFacts.timeoutPassedAtBase !== undefined ? { timeoutPassedAtBase: gate.reflectGateFacts.timeoutPassedAtBase } : {}),
        ...(gate.reflectGateFacts.unknownReason !== undefined ? { unknownReason: gate.reflectGateFacts.unknownReason } : {}),
        ...(gate.reflectGateFacts.baselineBudgetMs !== undefined ? { baselineBudgetMs: gate.reflectGateFacts.baselineBudgetMs } : {}),
        ...(gate.reflectGateFacts.baselineFileCount !== undefined ? { baselineFileCount: gate.reflectGateFacts.baselineFileCount } : {}),
        ...(gate.reflectGateFacts.childResponsibility !== undefined ? { childResponsibility: gate.reflectGateFacts.childResponsibility } : {}),
      } : {}),
    });
    // A declared goal cannot leave the implementation loop on a terminal claim
    // alone.  Reuse the existing bounded gate-failure/rework path so a missing
    // durable goal/diff/test axis never becomes an unbounded child retry.
    if (gate.passed && opts.requireOutputArtifacts && (opts.goalFile || opts.goalId)) {
      let artifactGoalPath = opts.goalFile;
      if (!artifactGoalPath && opts.goalId) {
        try { artifactGoalPath = s.goalDocumentPathByGoalId?.(opts.goalId); } catch { artifactGoalPath = undefined; }
      }
      const artifactFacts = collectRunFacts(wt.path);
      const artifactCompleteness = assessImplementationArtifactCompleteness({
        goalDocumentAvailable: Boolean(artifactGoalPath && existsSync(artifactGoalPath)),
        changedFiles: artifactFacts.changedFiles,
        gateExecuted: runsGate,
        gatePassed: gate.passed,
      });
      if (!artifactCompleteness.complete) {
        gate = {
          ...gate,
          passed: false,
          log: `${gate.log ?? ''}\n[artifact-output-intervention] ${artifactCompleteness.recoveryNote}`.trim(),
        };
        setReworkPart('supervisor', artifactCompleteness.recoveryNote);
        observe('artifact-output-intervention', {
          round, missing: artifactCompleteness.missing, changedFiles: artifactFacts.changedFiles ?? [],
          goalDocumentPath: artifactGoalPath ?? null, gateExecuted: runsGate,
          recoveryNote: artifactCompleteness.recoveryNote,
        }, { level: 'warn' });
      }
    }
    // ⛔⭐ 「안 돌렸다」를 「통과」로 찍지 않는다 — 사람이 «시험이 돌았다»고 읽는다.
    //   📏 2026-09-08 실측: 승격을 켠 첫 research 런이 게이트를 «건너뛰고» 화면엔 `gate 통과` 를 찍었다.
    //     원장은 정직했고(걸음에 gate 없음 · gate-skipped-by-graph 3건) 화면만 거짓이었다.
    progress('gated', !runsGate
      ? `gate 미실행 — 이 그래프(${graphTemplate.graphId})는 gate 노드를 갖지 않는다`
      : gate.passed ? 'gate 통과' : `gate 실패(라운드 ${round})`);
    if (gate.passed) lastGateUnverifiedKey = undefined;
    if (!gate.passed) {
      await onFailureVerdict('gate');
      const facts = gate.reflectGateFacts;
      const failureDisposition = decideGateFailureDisposition(facts);
      // 타임아웃«뿐» — 도입 0 · 미분류 0 · 자식 책임 없음. 재작업으로 보내지 않고 리뷰로 진행한다.
      // 게이트를 통과로 접지하지 않는다(allowsBaselineOnlyFailure 는 그대로 timedOut===0 을 요구).
      // 이 런의 병합은 뒤에서 GATE_TIMEOUT_UNMEASURED_MERGE_REASON 으로 hitl 에 고정한다.
      if (isTimeoutOnlyUnmeasuredGate(facts)) {
        observe('gate-timeout-only-continued-to-review', {
          round,
          introduced: facts.introduced,
          preexisting: facts.preexisting,
          unknown: facts.unknown,
          timedOut: facts.timedOut,
          childResponsibility: facts.childResponsibility,
        }, { level: 'warn' });
        progress('gated', `gate 타임아웃만(도입 0 · 미분류 0 · timedOut ${facts.timedOut}) — 재작업 없이 리뷰로 진행`);
      } else {
      // ⛔⭐⭐ **면책이 판정에 도달하게 한다**(`JDG-S18`). 하니스는 *"이 실패는 자식이 수복할 수 없다"* 를
      //   이미 판정해 `childResponsibility:'none'` 으로 갖고 있는데, 그 사실이 `reflectMustFix` 에만
      //   가고 **런을 죽이는 `rework-budget` 판정에는 안 갔다**(그 파일의 참조 0).
      //   ⇒ 사람이 손으로 돌리면 초록인 런이 *"gate 가 계속 unknown"* 을 사유로 `UNCONVERGEABLE` 로 죽었다.
      // ⚠️ 게이트를 통과시키는 것이 아니다 — **판정자가 탓할 대상을 오해하지 않게** 사실을 같이 준다.
      const exoneration = failureDisposition === 'escalate-child-unrelated'
        ? `\n[판정 참고] 이 gate 결과는 **자식이 수복할 수 없는** 종류다`
          + `(unknown=${facts?.unknown}${facts?.unknownReason ? ` · ${facts.unknownReason}` : ''}).`
          + ` 자식의 구현 결손으로 세지 말 것 — 재작업을 반복해도 이 신호는 바뀌지 않는다.`
        : '';
      setReworkPart('gate', `${gate.log ?? ''}${exoneration}`);
      failCounts.push(failIndicator('gate', gate.log, 0));
      reviewFindingHistory.push(undefined);
      reworkHistory.splice(0, reworkHistory.length, ...appendReworkHistory(reworkHistory, reworkNote));
      bufferPrComment(round, 'author', `Round ${round}: child implementation completed.`, [
        `Child completion: ${impl.summary.trim() || '(summary unavailable)'}`,
      ]);
      const baselineBudgetExceeded = facts?.unknownReason === 'budget-exceeded';
      const unrelatedGateReason = baselineBudgetExceeded
        ? `baseline budget was exhausted before its test range could be measured${facts?.baselineBudgetMs !== undefined && facts.baselineFileCount !== undefined ? `: ${facts.baselineBudgetMs}ms across ${facts.baselineFileCount} file(s)` : ''}`
        : 'an environment deficiency is unrelated to the child';
      bufferPrComment(round, 'reviewer', failureDisposition === 'escalate-child-unrelated'
        ? `Round ${round}: gate failed because ${unrelatedGateReason}; escalating without rework.`
        : `Round ${round}: gate failed and requested rework.`, [
        `Gate: ${gate.log?.trim() || '(gate log unavailable)'}`,
      ]);
      if (failureDisposition === 'rework-facts-unmeasured' && facts) {
        observe('gate-failed-facts-unmeasured', {
          round,
          introduced: facts.introduced,
          preexisting: facts.preexisting,
          unknown: facts.unknown,
          childResponsibility: facts.childResponsibility,
        }, { level: 'warn' });
      }
      if (failureDisposition === 'escalate-child-unrelated' && facts) {
        finalizeSupervisorDeliveries('gate-failed-child-unrelated');
        const reason = `gate failed because ${unrelatedGateReason}${facts.unknownReason ? `: ${facts.unknownReason}` : ''}; escalating without rework`;
        observe('gate-failed-child-unrelated-escalated', {
          round,
          childResponsibility: facts.childResponsibility,
          introduced: facts.introduced,
          preexisting: facts.preexisting,
          unknown: facts.unknown,
          ...(facts.unknownReason !== undefined ? { unknownReason: facts.unknownReason } : {}),
          ...(facts.baselineBudgetMs !== undefined ? { baselineBudgetMs: facts.baselineBudgetMs } : {}),
          ...(facts.baselineFileCount !== undefined ? { baselineFileCount: facts.baselineFileCount } : {}),
          reason,
        }, { level: 'warn' });
        progress('gate-failed', baselineBudgetExceeded
          ? '중단 — baseline 예산 초과로 gate 실패(자식과 무관, 재작업 없이 사람 판단 대기)'
          : '중단 — 환경 결손으로 gate 실패(자식과 무관, 재작업 없이 사람 판단 대기)');
        const pr = await preserveBlockedArtifacts({ stage: 'gate-failed', reason, gate, salvageStatusExpected: false });
        return { ok: false, stage: 'gate-failed', node: 'rework', ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, worktreePath: wt.path, branch: wt.branch, gate, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: reason };
      }
      // ⭐ 반복 열쇠 = 미검증 집합. 실패 시험 0건인데 직전 gate 실패와 «같은» 집합이면 재작업이 그 신호를 못 바꾼다
      //   (run-7dd4cce6: 리뷰 지적 비교는 incomparable · 점수 1/3 · 예산 판정 EXTEND 로 헛돌았다).
      if (isRepeatedUnverifiedOnlyGateFailure({ previousKey: lastGateUnverifiedKey, unverified: gate.unverified, gateLog: gate.log, ...(facts ? { introduced: facts.introduced } : {}) })) {
        finalizeSupervisorDeliveries('gate-failed-unverified-repeat');
        const unverifiedFiles = [...new Set(gate.unverified ?? [])].sort();
        const reason = `gate failed twice in a row with no failing test and the same ${unverifiedFiles.length} unverified file(s); rework cannot change that signal — escalating without rework`;
        observe('gate-failed-unverified-repeat-escalated', {
          round,
          unverified: unverifiedFiles.slice(0, 20),
          unverifiedCount: unverifiedFiles.length,
          reason,
        }, { level: 'warn' });
        progress('gate-failed', `중단 — 실패 시험 0건 · 같은 미검증 파일 ${unverifiedFiles.length}개가 되풀이(재작업으로 안 바뀐다 · 사람 판단 대기)`);
        const pr = await preserveBlockedArtifacts({ stage: 'gate-failed', reason, gate, salvageStatusExpected: false });
        return { ok: false, stage: 'gate-failed', node: 'rework', ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, worktreePath: wt.path, branch: wt.branch, gate, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: reason };
      }
      lastGateUnverifiedKey = unverifiedRepeatKey(gate.unverified);
      round++;
      continue;
      }
    }

    // ⭐ 한 번 계산해 재사용한다(리뷰 should-fix — 종전엔 조건과 값에서 두 번 호출했다).
    let behind: number | undefined;
    try {
      behind = s.gateWorktreeBehindMain ? await s.gateWorktreeBehindMain(wt.path) : undefined;
    } catch {
      behind = undefined;
    }
    observe('gate-worktree-freshness', { behind: behind ?? 'unknown', round });
    const gateEvidence = appendGateWorktreeFreshnessEvidence(gateEvidenceNote(gate), behind);

    // Review needs sibling progress whenever review is configured; shard eligibility avoids an expensive impossible lookup.
    const shardSiblings = s.reviewDiff
      ? queryShardSiblingsForContext('review-context', shardIdentity, s.queryRunChain ?? queryRunChain, (chain) => {
        const current = chain.entries.find((entry) => entry.runId === runId);
        return current?.shardSiblings.length ? budgetReviewShardSiblings(current.shardSiblings) : undefined;
      }, observe)
      : undefined;
    const designCheck = (s.resolveDesignCheck ?? ((worktreePath: string) => resolveDesignCheck(
      join(worktreePath, 'DESIGN.md'),
      resolve(import.meta.dir, '..', '..', 'docs', 'design', 'craft'),
      { readFile: readFileSync, readdir: readdirSync },
    )))(wt.path);
    if (designCheck.ok) {
      observe('design-check', {
        status: 'available',
        declaredCount: designCheck.declaredRulebooks.length,
        availableCount: designCheck.availableRulebooks.length,
        unavailableCount: designCheck.unavailableRulebooks.length,
        unavailableRulebooks: designCheck.unavailableRulebooks,
      });
    } else {
      observe('design-check', {
        status: 'blocked',
        blockedOn: designCheck.blockedOn,
        path: designCheck.path,
      });
    }
    const runFacts = collectRunFacts(wt.path);
    let designGate: ReviewDiffContext['designGate'];
    // Git porcelain collapses untracked directories to `site/`; inspect their files too.
    let untrackedFiles: string[] = [];
    if (runFacts.changedFiles?.some((file) => file.endsWith('/'))) {
      try {
        const untracked = runGitCommand(wt.path, ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
        if (untracked.status === 0) untrackedFiles = untracked.stdout.split(/\r?\n/).filter(Boolean);
      } catch { /* change discovery must not stop review */ }
    }
    if ([...(runFacts.changedFiles ?? []), ...(gateRouteFiles ?? []), ...untrackedFiles].some((file) => /\.(?:html|css)$/i.test(file))) {
      try {
        designGate = (s.runDesignGate ?? runDesignGate)({ projectDir: wt.path, base: wt.resolvedBase });
      } catch (error) {
        designGate = { unmeasured: safeErrorDescription(error) };
      }
      observe('design-gate', 'unmeasured' in designGate
        ? { verdict: null, reason: null, p0Total: null, advisoryTotal: null, files: null, unmeasured: designGate.unmeasured }
        : { verdict: designGate.verdict, reason: designGate.reason ?? null, p0Total: designGate.p0Total, advisoryTotal: designGate.advisoryTotal, files: designGate.files.length });
    }
    let goalDocumentPath: string | undefined;
    try {
      goalDocumentPath = opts.goalId ? s.goalDocumentPathByGoalId?.(opts.goalId) : undefined;
    } catch {
      goalDocumentPath = undefined;
    }
    const reviewContext = {
      runId,
      ...runFacts,
      goal: opts.feature,
      goalFile: opts.goalFile,
      ...(priorRunFindings.length ? { priorRunFindings } : {}),
      ...(goalDocumentPath ? { goalDocumentPath } : {}),
      round,
      ...((round === 0 ? carriedAppliedItems : appliedLastRound)?.length
        ? { appliedLastRound: round === 0 ? carriedAppliedItems : appliedLastRound }
        : {}),
      ...(shardSiblings ? { shardSiblings } : {}),
      // ⭐ S3 — 자식이 주장하는 **diff 밖 이행**을 리뷰어에게 나른다. 종전엔 채널 자체가 없어
      //   diff 로 드러나지 않는 이행은 증명 불가였고, 같은 지적이 반복돼 런이 죽었다(실측 2건).
      ...(offDiffEvidence.items.length ? { diffOutsideClaims: offDiffEvidence.items } : {}),
      // ⛔⭐ 하니스가 이미 센 것을 판정자에게 준다(원장 `JDG-S4`·`JDG-S5` — 로그에만 있으면 못 본다).
      ...(evidenceCoverage ? { evidenceCoverage } : {}),
      ...(designCheck ? { designCheck } : {}),
      ...(designGate ? { designGate } : {}),
      ...(gateEvidence ? { gateEvidenceNote: gateEvidence } : {}),
      ...(gate.baselineFailures?.some((failure) => failure.attribution === 'preexisting')
        ? { preexistingTestFailures: gate.baselineFailures
          .filter((failure) => failure.attribution === 'preexisting')
          .map((failure) => failure.name) }
        : {}),
      ...(gate.importerTestsNotRun !== undefined ? { importerTestsNotRun: gate.importerTestsNotRun } : {}),
    };
    lastReviewContext = reviewContext;
    reviewIntent = buildReviewIntent(reviewContext);

    if (s.reviewDiff) {
      try {
        const stoppedBeforeReview = honorParentSoftStop('review');
        if (stoppedBeforeReview) {
          finalizeSupervisorDeliveries('soft-stop-before-review');
          return { ...stoppedBeforeReview, ...resolveRunOutcome({ termination: 'abandoned' }), sessionId, gate, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun() };
        }
        onNodeEntry(node('review'), round);
        progress('reviewing', '내부 리뷰 (리뷰어 비평)…');
        review = await withStepTimeout(s.reviewDiff(wt.path, reviewContext), T.review, 'review');
      } catch (error) {
        finalizeSupervisorDeliveries(error instanceof StepTimeoutError ? 'next-round-review-timeout' : 'next-round-review-failed');
        throw error;
      }
      onReviewFindings(round, review.mustFix);
      if (review.mustFix.length > 0) await onFailureVerdict('review');
      const reviewFindings = snapshotMustFixFindings([...review.mustFix, ...review.shouldFix]);
      const reviewMustFixFindings = reviewFindings.slice(0, review.mustFix.length);
      observeReviewFindingRecurrence(round, review.mustFix);
      previousBlockingFindings = currentBlockingFindings;
      currentBlockingFindings = reviewMustFixFindings;
      let reviewArtifactPath: string | undefined;
      try {
        reviewArtifactPath = (s.persistReviewArtifact ?? persistReviewArtifact)({
          origin: 'self-implement-review', runId, round, verdict: review.verdict,
          findings: [...review.mustFix, ...review.shouldFix], mustFix: review.mustFix,
          shouldFix: review.shouldFix, summary: review.summary,
          ...(opts.goalFile !== undefined ? { goalFile: opts.goalFile } : {}),
        }).path;
      } catch {
        observe('review-artifact-failed', { round, verdict: review.verdict }, { level: 'warn' });
      }
      const reviewFindingCounts = reviewFindingTelemetry();
      observe('reviewed', {
        verdict: review.verdict, mustFix: review.mustFix.length, shouldFix: review.shouldFix.length, round,
        findingIds: reviewFindings.map(({ id }) => id),
        reviewed: review.reviewed,
        symbolKeyedReviewFindingCount: reviewFindingCounts.symbolKeyedReviewFindingCount,
        proseFallbackReviewFindingCount: reviewFindingCounts.proseFallbackReviewFindingCount,
        canSelfRead: reviewerCanSelfReadObservation(review.canSelfRead),
        ...(review.failureReason !== undefined ? { failureReason: review.failureReason } : {}),
        ...(reviewArtifactPath ? { artifactPath: reviewArtifactPath } : {}),
      });
      if (review.reviewed) reviewMustFixCountHistory.push(review.mustFix.length);
      progress('reviewed', review.reviewed
        ? `리뷰: ${review.verdict} (must-fix ${review.mustFix.length}·should-fix ${review.shouldFix.length}) · 추이 ${reviewMustFixCountHistory.join('→')} (${reviewMustFixTrend()})`
        : `리뷰 미실행${review.failureReason !== undefined ? ` (${review.failureReason})` : ''}`);
      if (opts.goalFile) {
        let goalSlotFill: SupervisorGoalFillResult = 'unverifiable';
        try {
          goalSlotFill = await fillUnverifiableGoalSlots({
            path: opts.goalFile, round, gate, review,
            independentlyCheck: s.independentlyCheckGoalSlots ?? (async () => false),
          });
        } catch {
          goalSlotFill = 'rejected';
        }
        observe('goal-slot-fill', { round, result: goalSlotFill, gatePassed: gate.passed, reviewVerdict: review.verdict });
      }
      const evidenceFacts: ReflectEvidenceFacts = evidenceCoverage
        ? { requiredEvidence: evidenceCoverage.required, coveredEvidence: evidenceCoverage.covered, missingEvidence: evidenceCoverage.uncovered }
        : { requiredEvidence: 0, coveredEvidence: 0, missingEvidence: [] };
      const citedPathFacts = await (s.observeCitedPathFacts?.(review.mustFix, wt.path, round)
        ?? observeMustFixCitedPaths(review.mustFix, { cwd: wt.path, round }));
      if (citedPathFacts.length) {
        observe('review-cited-paths', {
          round,
          facts: citedPathFacts,
          missingCount: citedPathFacts.filter(({ existence }) => existence === 'missing').length,
          unknownCount: citedPathFacts.filter(({ existence }) => existence === 'unknown').length,
          // ⛔ `ambiguous` 를 «따로» 센다 — missing 에 섞으면 함수 이름마다 「없는 경로를 요구했다」가 뜬다.
          //   🔑 문면으로는 `Makefile`(허구일 수 있다)과 `buildRequest`(함수다)를 «가를 수 없다»(2026-08-19 인수).
          ambiguousCount: citedPathFacts.filter(({ existence }) => existence === 'ambiguous').length,
        }, { category: 'self-dev.rework' });
      }
      const refutations = refutableFindings.length
        ? parseMustFixRefutations(impl.summary, opts.feature, refutableFindings, ({ stage, findingId }) => {
          observe('refute-rejected', { round, stage, ...(findingId ? { findingId } : {}) });
        }, { citedPathFacts, round })
        : [];
      const refutationAcknowledgement = parseMustFixRefutationAcknowledgement(impl.summary);
      const refutationAcknowledged = refutableFindings.length && refutationAcknowledgement.acknowledged;
      if (!refutations.length) {
        observe('refute-not-submitted', {
          round,
          refutableCount: refutableFindings.length,
          findingIds: refutableFindings.map(({ id }) => id),
          submittedCount: 0,
          refutationGuidancePresented: dispatchedRefutationGuidance,
          refutationAcknowledged,
          ...(refutationAcknowledgement.reason ? { refutationAcknowledgementReason: refutationAcknowledgement.reason } : {}),
        });
      }
      if (refutations.length) {
        pendingRefutations = { round, refutations };
        observe('refute-submitted', {
          round,
          submittedCount: refutations.length,
          refutationGuidancePresented: dispatchedRefutationGuidance,
          kinds: refutationKindCounts(refutations),
          findingIds: refutations.map(({ findingId }) => findingId),
          refutations: refutations.map(({ findingId, quote, reason, kind }) => ({ findingId, quote, reason, kind })),
        });
      }
      if (refutations.length && s.reflectMustFix) {
        try {
          const originalMustFix = refutableFindings.map((finding) => finding.item);
          const recurrenceHistory = recurrenceHistoryFor(originalMustFix);
          const adjudicated = await withStepTimeout(s.reflectMustFix({ mustFix: originalMustFix, goal: opts.feature, cwd: wt.path, evidenceFacts, gateFacts: gate.reflectGateFacts, refutations, citedPathFacts, ...(recurrenceHistory.length ? { recurrenceHistory } : {}), runId, round }), T.review, 'review');
          observe('review-refute-adjudicated', {
            round,
            submittedCount: refutations.length,
            acceptedMustFixCount: adjudicated.accepted.length,
            rejectedMustFixCount: adjudicated.rejected.length,
            findingIds: refutations.map((refutation) => refutation.findingId),
            kinds: refutations.map((refutation) => refutation.kind),
          });
        } catch { /* fail-safe: REFUTE never changes a finding without supervisor judgment */ }
      }
      if (review.verdict === 'fail' && review.mustFix.length > 0) {
        let effectiveMustFix = review.mustFix;
        if (s.reflectMustFix) {
          // ⛔ 「진행 줄은 «한 줄»」 계약은 정상 기각과 예외 진단에 함께 적용한다.
          const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 60);
          try {
            const recurrenceHistory = recurrenceHistoryFor(review.mustFix);
            const reflected = await withStepTimeout(s.reflectMustFix({ mustFix: review.mustFix, goal: opts.feature, cwd: wt.path, evidenceFacts, gateFacts: gate.reflectGateFacts, citedPathFacts, ...(recurrenceHistory.length ? { recurrenceHistory } : {}), runId, round }), T.review, 'review');
            const rejectedItems = new Set(reflected.rejected.filter((r) => r.reason && r.reason.trim().length > 0).map((r) => r.item));
            const rejected = reflected.rejected.filter((r) => rejectedItems.has(r.item));
            effectiveMustFix = review.mustFix.filter((m) => !rejectedItems.has(m));
            observe('review-reflect', {
              round,
              acceptedCount: effectiveMustFix.length,
              rejectedCount: rejected.length,
              rejections: rejected.map((r) => ({ item: r.item.slice(0, 100), reason: r.reason.slice(0, 120) })),
              recurrenceHistoryCount: recurrenceHistory.length,
              recurrenceCitedRejectionCount: rejected.filter((rejection) => {
                const recurrence = recurrenceHistory.find(({ findingId }) => findingId === stableMustFixId(rejection.item));
                return recurrence !== undefined && recurrenceCitationWasCited(rejection.reason, recurrence);
              }).length,
            });
            onReviewReflectRejected(rejected.length);
            if (rejected.length) {
              reflectRejectedAudit.push(...rejected.map((r) => `[reflect-rejected] ${r.item} — ${r.reason}`));
            }
            // ⛔⭐⭐ **사람 산출에도 «한 줄» 낸다**(`[S]` 제보 2026-08-12 · `REFLECT-REJECTION-IS-INVISIBLE`).
            //   종전엔 이 값이 «원장에만» 있었다. 그래서 사람이 보는 줄이
            //     `리뷰: fail (must-fix 1)` → `자동 병합`
            //   으로 이어져 ***「무인 리뷰가 fail 인데 병합됐다 = 게이트가 안 문다」로 읽혔다.***
            //   실제로는 반사 기각이 must-fix 를 «사유와 함께» 기각해 판정이 fail→warn 으로 내려간 것이다.
            //   ⇒ 「값은 있는데 사람에게 안 보인다」 형태를 여기서 닫는다(⛔ 판정은 «바꾸지 않는다»).
            // ⛔⭐ **반사가 «돌았으면» 언제나 한 줄 낸다 — 기각 0건이어도**(2R must-fix ①).
            //   종전엔 「기각이 있을 때만」 냈다. 그러면 ***「반사가 돌았는데 아무것도 안 깎았다」와
            //   「반사가 아예 안 돌았다」가 «사람 산출에서 같은 모양»***이 된다 — 이 PR 이 없애려던 그 형태다.
            //   ⛔ 「진행 줄은 «한 줄»」도 계약이라 사유의 공백류를 자르기 «전»에 접는다(1R must-fix ②).
            progress('reviewing', `반사 기각 ${rejected.length}건 · 남은 must-fix ${effectiveMustFix.length}건`
              + (rejected.length ? ` — ${rejected.map((r) => `기각: ${oneLine(r.item)} ← ${oneLine(r.reason)}`).join(' / ')}` : ''));
          } catch (error) {
            // fail-safe: reflection failure must not alter the retained must-fix or fail verdict.
            progress('reviewing', `반사 실패 — ${oneLine(safeErrorDescription(error))}`);
          }
        }
        if (effectiveMustFix.length === 0) {
          finalizeSupervisorDeliveries('review-reflect-converged');
          completionStatus = 'review-reflect-converged';
          review.mustFix = [];
          review.verdict = 'warn';
          observe('review-reflect', { round, converged: true, allRejected: true });
          // ⭐ 「fail 이었는데 왜 병합되나」의 답을 «그 자리»에 적는다 — 다음 줄이 자동 병합이다.
          progress('reviewed', '리뷰: fail → warn (반사가 must-fix 를 «전부» 기각 — 사유는 위 줄과 PR 코멘트에)');
          break;
        }
        appliedLastRound = [...effectiveMustFix];
        refutableFindings = reviewMustFixFindings.filter(({ item }) => effectiveMustFix.includes(item));
        const reviewFindingKeys = effectiveMustFix
          .map(reviewFindingKey)
          .filter(({ key }) => key.length > 0);
        const reviewFindingKeysForRound = reviewFindingKeys.map(({ key }) => key);
        reviewFindingKeyHistory.push(reviewFindingKeysForRound);
        reviewFindingHistory.push([...effectiveMustFix]);
        const repeatCounts = countConsecutiveMustFixIds(reviewFindingKeyHistory);
        observe('repeat-count', {
          round,
          counts: repeatCounts.counts,
          longestId: repeatCounts.longestId,
          longestConsecutiveRounds: repeatCounts.longestConsecutiveRounds,
          keySources: reviewFindingKeys,
        }, { category: 'self-dev.rework' });
        const doesNotDistinguishFiles = gate.verifyByBreaking?.ran
          ? gate.verifyByBreaking.files
            ?.filter((entry) => entry.classification === 'does-not-distinguish')
            .map((entry) => entry.file) ?? []
          : [];
        const verifyByBreakingReworkNote = doesNotDistinguishFiles.length > 0
          ? `\n\n[verify-by-breaking] 다음 테스트/증거는 현재 변경을 구별하지 못했다: ${doesNotDistinguishFiles.join(', ')}\n` +
            `→ 각 파일이 이 변경 전에는 실패하고 수정 후에는 통과하도록 테스트 또는 증거를 보강하라.`
          : '';
        const citedPathReworkNote = citedPathFacts.length
          ? `\n\n[리뷰 인용 경로 관측]\n${renderMustFixCitedPathFacts(citedPathFacts).map((fact) => `- ${fact}`).join('\n')}\n→ missing은 대상 worktree에 인용 파일이 없다는 관측이다. found는 같은 라운드 기계 관측이 그 심볼을 찾았다는 관측이다. missing이면 ${JSON.stringify(MISSING_CITED_PATH_REFUTATION_QUOTE)}를, found이면 ${JSON.stringify(FOUND_CITED_PATH_REFUTATION_QUOTE)}를 인용할 수 있다. 이 사실을 보고 반론 여부를 검토하되 자동 기각하지 말라.`
          : '';
        // 예산 판정기의 «현재 지적»은 리뷰 must-fix 문장(제목·요지)이다. 인용 심볼·경로 조각으로 대신하지 않는다.
        // 부가 관측(verify-by-breaking·인용 경로)은 재작업 지시에는 남기되, 판정 입력·이력에서는 뺀다.
        const judgeMustFixNote = effectiveMustFix.map((finding) => `- ${finding}`).join('\n');
        setReworkPart('review', `${judgeMustFixNote}${verifyByBreakingReworkNote}${citedPathReworkNote}`);
        const judgeHistoryEntry = truncateReworkHistoryByItem(judgeMustFixNote, 1200);
        reworkJudgeNote = judgeMustFixNote;
        observe('rework-budget-input', {
          round,
          itemCount: effectiveMustFix.length,
          truncated: judgeHistoryEntry !== judgeMustFixNote || judgeHistoryEntry.includes('…[절단]'),
          totalChars: judgeMustFixNote.length,
        });
        failCounts.push(failIndicator('review', undefined, effectiveMustFix.length));
        reworkHistory.splice(0, reworkHistory.length, ...appendReworkHistory(reworkHistory, judgeMustFixNote));
        bufferPrComment(round, 'author', `Round ${round}: child implementation completed.`, [
          `Child completion: ${impl.summary.trim() || '(summary unavailable)'}`,
        ]);
        bufferPrComment(round, 'reviewer', `Round ${round}: reviewer requested ${effectiveMustFix.length} must-fix change(s).`, effectiveMustFix);
        round++;
        continue;
      }
    }
    bufferPrComment(round, 'author', `Round ${round}: child implementation completed.`, [
      `Child completion: ${impl.summary.trim() || '(summary unavailable)'}`,
    ]);
    if (review) {
      bufferPrComment(round, 'reviewer', `Round ${round}: review completed (${review.verdict}).`, [
        `Review summary: ${review.summary.trim() || '(summary unavailable)'}`,
      ]);
    }
    finalizeSupervisorDeliveries('no-next-rework-round');
    break;
  }

  if (review && reflectRejectedAudit.length) review.shouldFix = [...review.shouldFix, ...reflectRejectedAudit];

  const { decisionSignalPress, decisionSignalPressReason } = resolveDecisionSignalPress(opts.goalFile, wt.path, opts.decisionSignalPressSources);
  const decisionSignalResult = decisionSignalPress ? { decisionSignalPress } : {};
  const decisionSignalRed = (decisionSignalPress?.pressedRed.length ?? 0) > 0;
  const decisionSignalBaselineOnly = decisionSignalPress?.pressedBaselineOnly.length ?? 0;
  const preservedCompletionResult = !decisionSignalRed && completionDisposition
    ? { completionDisposition }
    : {};
  const reviewReal = !!review?.reviewed;
  const reviewDiffComplete = review?.diffTruncated === false;
  const requiredEvidenceMissing = evidenceCoverage !== undefined && evidenceCoverage.uncoveredCount > 0;
  const { latestSignalIncomplete } = signalIncompleteState(roundClassifications);
  const autoMerge = autoMergeEnabled(opts);
  const gateTimeoutUnmeasured = isTimeoutOnlyUnmeasuredGate(gate.reflectGateFacts);
  let canAuto = !gateTimeoutUnmeasured && autoMerge && reviewReal && review!.verdict !== 'fail' && reviewDiffComplete && !requiredEvidenceMissing && !latestSignalIncomplete && !decisionSignalRed;
  // ⭐⭐ 통과의 «이유»를 둘로 가른다 — ⛔ 막지는 «않는다»(대표 판단 2026-08-11: ⓐ 문면만).
  //   📏 근거(`JDG-T36` · merge-decision 300건 전수): `verifyByBreaking` 이 실린 8건의 auto 중 ***5건***이
  //     ***ran=true 인데 distinguishes=0***(아무것도 안 가르는 자기검증)이었고, 그 다섯이 «전부»
  //     `review-clean-armed` — 즉 ***「깨끗하다」고 말하면서 통과***했다.
  //   ⛔ `canAuto` 는 그대로 둔다: `JDG-T33` 이 보인 대로 이 값 «자체»가 틀릴 수 있어
  //     (모집단 0인데 distinguishes=1) 틀린 값으로 막으면 새 병목이 된다.
  //   ⛔ `ran === false`(skipped)는 «다른 것»이다 — 자식이 테스트를 안 건드린 경우이고
  //     그건 `skippedReason` 이 이미 가른다. 그래서 여기 조건에 넣지 않는다.
  const verifyInconclusive = gate.verifyByBreaking?.ran === true && (gate.verifyByBreaking.distinguishes ?? 0) === 0;
  const verifyNothingAtBase = verifyInconclusive && (gate.verifyByBreaking?.missingAtBase ?? 0) > 0;
  let mergeReason = canAuto ? (verifyNothingAtBase ? 'review-clean-verify-nothing-at-base' : verifyInconclusive ? 'review-clean-verify-inconclusive' : 'review-clean-armed')
    : gateTimeoutUnmeasured ? GATE_TIMEOUT_UNMEASURED_MERGE_REASON
    : !autoMerge ? 'no-auto-flag'
      : requiredEvidenceMissing ? 'required-evidence-uncovered'
        : decisionSignalRed ? 'decision-signal-red'
        : latestSignalIncomplete ? 'signal-incomplete'
        : !reviewReal ? 'no-real-review'
          : review!.verdict === 'fail' ? 'review-must-fix'
            : review!.diffTruncated === true ? 'review-diff-truncated'
              : 'review-diff-budget-unknown';
  let mergeSkipReason = canAuto ? undefined : mergeReason;
  if (canAuto) onAutoMergeAuthorizedBeforeSync();
  const mergeDecisionObservation = {
    autoMerge, reviewed: reviewReal, verdict: review?.verdict ?? 'none',
    decision: canAuto ? 'auto' : 'hitl', reason: mergeReason,
    ...mergeDecisionEvidenceCoverage(evidenceCoverage),
    ...(evidenceCoverage ? {
      evidenceSource,
      anchoredEvidence: offDiffEvidence.anchoredEvidence,
    } : {}),
    ...(review?.diffTruncated !== undefined ? { diffTruncated: review.diffTruncated } : {}),
    ...(review?.diffShownChars !== undefined ? { diffShownChars: review.diffShownChars } : {}),
    ...(review?.diffTotalChars !== undefined ? { diffTotalChars: review.diffTotalChars } : {}),
    ...(review?.diffOmittedFiles !== undefined ? { diffOmittedFiles: review.diffOmittedFiles } : {}),
    ...(review?.contextItemCount !== undefined ? { contextItemCount: review.contextItemCount } : {}),
    ...(review?.contextShownChars !== undefined ? { contextShownChars: review.contextShownChars } : {}),
    ...(review?.contextTotalChars !== undefined ? { contextTotalChars: review.contextTotalChars } : {}),
    ...(review?.contextTruncated !== undefined ? { contextTruncated: review.contextTruncated } : {}),
    ...(review?.contextFullyIncludedItems !== undefined ? { contextFullyIncludedItems: review.contextFullyIncludedItems } : {}),
    ...(review?.contextTruncatedItems !== undefined ? { contextTruncatedItems: review.contextTruncatedItems } : {}),
    ...(review?.contextOmittedItems !== undefined ? { contextOmittedItems: review.contextOmittedItems } : {}),
    ...(gate.verifyByBreaking ? { verifyByBreaking: gate.verifyByBreaking } : {}),
    ...(decisionSignalPress ? { decisionSignalPress, decisionSignalBaselineOnly } : {}),
    ...(decisionSignalPressReason ? { decisionSignalPressReason } : {}),
  };
  const recordMergeDecision = () => {
    observe('merge-decision', {
      ...mergeDecisionObservation,
      decision: canAuto ? 'auto' : 'hitl', reason: mergeReason,
    });
  };
  if (opts.completion === 'worktree-only' && !decisionSignalRed) {
    recordMergeDecision();
    progress('worktree-completed', '✅ 작업 트리 완료 — PR 생성 없이 worktree 보존');
    observe('worktree-completed', { branch: wt.branch, hadApprover: !!s.approvePr });
    return {
      ok: true, stage: 'worktree-completed', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), ...(mergeSkipReason ? { mergeReason: mergeSkipReason } : {}),
      detail: 'worktree-only completion: PR creation skipped',
    };
  }
  let approved = canAuto ? true : (s.approvePr
    ? await s.approvePr({ branch: wt.branch, ...(gate.log ? { gateLog: gate.log } : {}), implSummary: impl.summary, ...(review ? { review } : {}) })
    : false);
  if (!approved) {
    recordMergeDecision();
    observe('pr-declined', { branch: wt.branch, hadApprover: !!s.approvePr });
    return {
      ok: false, stage: 'pr-declined', node: 'open-pr', ...resolveRunOutcome({ termination: 'abandoned' }), ...decisionSignalResult, sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), ...(mergeSkipReason ? { mergeReason: mergeSkipReason } : {}),
      detail: s.approvePr ? 'PR not approved' : 'no approvePr seam — fail-closed(자동승인 금지)',
    };
  }

  if (s.mergeMain && s.commitWork) {
    onNodeEntry('main-sync', round);
    let goalDocument: string | undefined;
    if (opts.goalFile) {
      try { goalDocument = readFileSync(opts.goalFile, 'utf8'); } catch { /* no documented targets */ }
    }
    inspectStaleReverts(revertGuardTargetPaths(opts.feature, goalDocument));
    s.commitWork(wt.path, prTitle(opts.feature));
    // ⛔⭐ resume 경로와 «같은» 해석기를 쓴다 — 두 자리가 갈리면 같은 원인이 다른 얼굴로 나온다.
    const resolvedTarget = resolveDefaultBranchTarget(s.defaultBranchRef ?? defaultBranchRef, wt.path);
    const mergeTarget = resolvedTarget.target;
    if (mergeTarget === null) {
      const sync = { status: 'default-branch-unresolved' as const };
      observe('pre-pr-sync', {
        ...mainSyncObservation(sync, mergeTarget, opts.base, wt.branch),
        ...(resolvedTarget.error === undefined ? {} : { resolveError: resolvedTarget.error }),
      });
      progress('merge-conflict', '⚠️ 기본 브랜치 해석 실패 — 자동병합 차단(수동 정합 필요·HITL 결정)');
      canAuto = false;
      mergeReason = 'default-branch-unresolved';
      recordMergeDecision();
      return { ok: false, stage: 'merge-conflict', node: 'main-sync', ...resolveRunOutcome({ termination: 'abandoned' }), ...decisionSignalResult, sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), detail: 'pre-PR main sync default-branch-unresolved' };
    }
    progress('gating', `최신 ${mergeTarget} 정합 (병렬 드리프트·LLM 충돌해결)…`);
    const sync = await withStepTimeout(s.mergeMain(wt.path, mergeTarget), T.merge, 'merge');
    // ⛔⭐ `OBS-T96` 🅐 — 「무엇을 봤는지」를 남긴다. 수만 남기면 정합 실패가 «재현 불가»가 된다.
    observe('pre-pr-sync', mainSyncObservation(sync, mergeTarget, opts.base, wt.branch));
    if (sync.status === 'conflict-unresolved' || sync.status === 'error') {
      progress('merge-conflict', `⚠️ ${mergeTarget} 정합 ${sync.status}${sync.errorStep === undefined ? '' : ` (${sync.errorStep})`} — 자동병합 차단(수동 정합 필요·HITL 결정)`);
      canAuto = false;
      mergeReason = `main-sync-${sync.status}`;
      recordMergeDecision();
      return { ok: false, stage: 'merge-conflict', node: 'main-sync', ...resolveRunOutcome({ termination: 'abandoned' }), ...decisionSignalResult, sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), detail: `pre-PR main sync ${sync.status}` };
    }
    if (sync.status === 'llm-resolved' || sync.status === 'merged') {
      preservationBase = opts.base ?? mergeTarget;
      progress('gating', sync.status === 'llm-resolved'
        ? `${mergeTarget} 충돌해결됨 — ${formatLlmMergeOutcome(sync)} — 통합 결과 full 재-gate…`
        : `${mergeTarget} 정합됨 — 통합 결과 full 재-gate…`);
      onNodeEntry('regate', round);
      const regate = await withStepTimeout(s.gate(wt.path, { runId, mode: 'postsync', round }), T.gate, 'gate');
      if (!regate.passed) await onFailureVerdict('gate');
      // `mode` name/meaning stay: `full` = existing gate including tests. Both
      // conflict-resolved and clean-merge reuse this same `s.gate` invocation.
      const timeoutOnlyPostSync = !regate.passed && postSyncTimeoutOnly(regate.reflectGateFacts);
      const postSyncPolicy = postSyncGatePolicy(
        regate.passed,
        regate.reflectGateFacts,
        sync.status,
      );
      observe('gate.postsync', postSyncGateObservation(regate, wt.branch, hasModuleLoadFailure, sync.status));
      if (timeoutOnlyPostSync) {
        const facts = regate.reflectGateFacts!;
        observe('post-sync-gate-timeout-only-continued', {
          introduced: facts.introduced, unknown: facts.unknown, timedOut: facts.timedOut ?? 0,
        }, { level: 'warn' });
        canAuto = false;
        mergeReason = GATE_TIMEOUT_UNMEASURED_MERGE_REASON;
        mergeSkipReason = mergeReason;
        approved = s.approvePr
          ? await s.approvePr({
            branch: wt.branch,
            gateLog: [regate.log, `post-sync gate timeout-only (introduced=${facts.introduced}, unknown=${facts.unknown}, timedOut=${facts.timedOut ?? 'unmeasured'}, flakyRerun=${facts.flakyRerun ?? 'unmeasured'}); merge reason: ${GATE_TIMEOUT_UNMEASURED_MERGE_REASON}`].filter(Boolean).join('\n'),
            implSummary: impl.summary,
            ...(review ? { review } : {}),
          })
          : false;
      }
      if (postSyncPolicy.mustStop) {
        progress('gate-failed', sync.status === 'llm-resolved'
          ? '중단 — main 충돌해결 후 gate 실패(면책 보류·통합 깨짐)'
          : '중단 — main 정합 후 gate 실패(통합 깨짐)');
        const reason = postSyncPolicy.exemptionWithheld
          ? 'gate failed after main-sync (conflict-resolved exemption withheld)'
          : sync.status === 'llm-resolved'
            ? 'gate failed after main-sync (conflict-resolved integration break)'
            : 'gate failed after main-sync (clean-merge integration break)';
        canAuto = false;
        mergeReason = 'post-sync-gate-failed';
        recordMergeDecision();
        const pr = await preserveBlockedArtifacts({ stage: 'gate-failed', reason, gate: regate, salvageStatusExpected: false });
        return { ok: false, stage: 'gate-failed', node: 'regate', ...resolveRunOutcome({ termination: 'abandoned' }), ...decisionSignalResult, sessionId, worktreePath: wt.path, branch: wt.branch, gate: regate, quotaExhaustionAssessment: quotaExhaustionAssessmentForRun(), ...(review ? { review } : {}), ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}), detail: reason };
      }
      if (!regate.passed) {
        progress('gating', timeoutOnlyPostSync
          ? 'main 정합 후 gate 타임아웃만 — 사람 확인으로 진행'
          : 'main 정합 후 gate 실패는 자식 책임 없음으로 면책 — 통합 깨짐으로 중단하지 않고 계속 진행');
      }
      gate = regate;
    }
  }

  recordMergeDecision();
  if (!approved) {
    observe('pr-declined', { branch: wt.branch, hadApprover: !!s.approvePr });
    return { ok: false, stage: 'pr-declined', node: 'open-pr', ...resolveRunOutcome({ termination: 'abandoned' }), ...decisionSignalResult, sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason, detail: s.approvePr ? 'PR not approved' : 'no approvePr seam — fail-closed(자동승인 금지)' };
  }
  if (canAuto) onMergeApprovalReceived();
  const extractedOriginalAsk = extractVerbatimOriginalAsk(opts.feature);
  const { labels, declineReasons, eligibility } = resolveAutoReviewLabels(!!opts.autoReview, {
    objective: opts.feature,
    ...(extractedOriginalAsk !== null ? { originalAsk: extractedOriginalAsk.ask } : {}),
    ...(extractedOriginalAsk?.range !== undefined ? { originalAskRange: extractedOriginalAsk.range } : {}),
    ...(opts.base ? { target: opts.base } : {}),
    evidenceRequired: ['tsc'],
    ...(review ? { reviewVerdict: review.verdict } : {}),
  });
  if (opts.autoReview) debug.log('autoreview.decision', labels ? 'eligible' : 'declined', {
    surface: 'self-implement',
    branch: wt.branch,
    objective: opts.feature,
    eligible: eligibility?.eligible ?? false,
    riskHits: eligibility?.riskHits ?? [],
    suppressedRiskHits: eligibility?.suppressedRiskHits ?? [],
    ...(declineReasons ? { reasons: declineReasons } : {}),
  });
  // ⛔⭐⭐⭐ **본문을 만들기 «직전»에 한 번 더 걷는다**. 리뷰 루프 안 수집은 자식이 파일만 남긴
  //   상태라 커밋 제목이 없거나 옛것이다 — 위 `commitWork`(mergeMain 경로)가 만든 커밋은 여기서만 보인다.
  //   ⛔⭐ **`openPr` 이 «자기 안»에서 만드는 커밋은 여기서도 못 본다 — 원리적으로 못 본다.**
  //     그 커밋은 `openPr` 호출 «중»에 생기는데 PR 본문은 같은 호출에 «인자로» 넘겨야 한다.
  //     ⇒ 이 절이 싣는 커밋은 ***본문을 만들기 전까지 이미 존재하는*** 커밋이고, 그것이 이 착지의
  //       «결정»이다(미완이 아니다). 자율 런의 감독도 이 요구를 `CONTRACT-CONFLICT` 로 판정했다.
  //   fail-soft — 못 구하면 그 종류만 빠진다.
  if (lastReviewContext) {
    const refreshed = { ...withRefreshedRunFacts(lastReviewContext, collectRunFacts(wt.path)), goalFile: opts.goalFile };
    lastReviewContext = refreshed;
    reviewIntent = buildReviewIntent(refreshed);
  }
  const stoppedBeforePr = honorParentSoftStop('open-pr');
  if (stoppedBeforePr) {
    return { ...stoppedBeforePr, ...resolveRunOutcome({ termination: 'abandoned' }), ...decisionSignalResult, sessionId, gate, ...(review ? { review } : {}), ...(mergeSkipReason ? { mergeReason: mergeSkipReason } : {}) };
  }
  progress('pr-opening', 'PR 생성…');
  onNodeEntry('open-pr', round);
  // ⛔⭐⭐⭐ **PR 준비 «전»에 일곱 축을 센다** — 골 · 계획 · 원장 · 비판 · 시험 · 위험 · 대안.
  //   📏 계기(2026-09-17 실측 `gh pr view`): 같은 저장소의 `#18879` 와 `#18890` 이 이 일곱 축으로
  //     재면 각각 셋·다섯 칸이 «비어» 있었고, 그중 「원장」과 「위험」은 «둘 다» 0이었다.
  //     `prBody` 는 모든 인자가 optional 이라 비면 그 절이 «조용히 사라진다» — 그래서 결손이
  //     정상 산출과 구별되지 않았다. 이 관문이 그 부재를 «이름으로» 말한다.
  //   ⛔ «막지 않는다» — 골의 내용과 무관하게 착지를 죽이지 않는다. ***거절은 항상 관측으로 남는다***.
  //     (차단 스위치 `prEvidenceArtifactEnforce` 는 2026-09-26 설정 졸업으로 지웠다 — 한 번도 기본으로 안 켜졌다.)
  const prEvidence = collectPrEvidence({
    feature: opts.feature,
    goalFile: opts.goalFile,
    implSummary: impl.summary,
    gate,
    review,
    runId,
    stage: 'pr-opened',
    branch: wt.branch,
    rounds: round + 1,
    mergeReason,
    provider: activeProvider.provider,
    planRevision: lastPlanRevision,
  });
  const prEvidenceDecision = decidePrEvidenceGate(prEvidence);
  observe('pr-evidence-artifact', {
    accepted: prEvidenceDecision.missing.length === 0,
    axes: PR_EVIDENCE_AXES.length,
    missingCount: prEvidenceDecision.missing.length,
    missing: prEvidenceDecision.missing,
    ...(prEvidenceDecision.reason ? { reason: prEvidenceDecision.reason } : {}),
    ...(prEvidenceDecision.body ? { bodyChars: prEvidenceDecision.body.length } : {}),
  });
  const releaseNote = releaseNoteForRun(opts.goalFile, opts.feature);
  // openPr's default seam delegates to PrManager.upsertPr, which stages, commits,
  // and pushes this worktree after the note is written and before creating the PR.
  addNextMdReleaseNote(wt.path, releaseNote);
  const preparedPrBody = preparePrBody(
    [
      prBody(opts.feature, impl.summary, gate.log, review, reviewIntent, declineReasons, harvestedForPr(), opts.goalFile, lastPlanRevision, releaseNote, revertGuard),
      ...(prEvidenceDecision.body ? ['', '---', '', prEvidenceDecision.body] : []),
    ].join('\n'),
    s.persistPrBodyArtifact,
    'self-implement-pr',
  );
  let pr: { url: string; number: number };
  try {
    pr = await withStepTimeout(s.openPr({
      title: prTitle(opts.feature),
      body: preparedPrBody.body,
      head: wt.branch,
      ...(opts.base ? { base: opts.base } : {}),
      draft: canAuto ? false : (opts.draft ?? true),
      // The review poller must not see this PR before its actual paths have been inspected.
      ...(labels?.length ? { labels: labels.filter((label) => label !== AUTO_REVIEW_LABEL) } : {}),
      cwd: wt.path,
    }), T.pr, 'pr');
  } catch (error) {
    if (error instanceof StepTimeoutError) throw error;
    const prError = error instanceof Error ? error.message : String(error);
    const location = `draft PR 생성 실패(worktree·branch 보존 · ${wt.branch} · ${wt.path})`;
    const prErrorFirstLine = prError.split('\n', 1)[0] ?? '';
    observe('pr-open-failed', {
      branch: wt.branch,
      worktreePath: wt.path,
      error: prError.slice(0, MAX_PR_OPEN_ERROR_CHARS),
    }, { level: 'error' });
    progress('aborted', formatPrOpenFailedProgress(location, prErrorFirstLine));
    throw new Error(`${location}\n${prError}`);
  }
  observe('pr-opened', {
    url: pr.url,
    number: pr.number,
    branch: wt.branch,
    autoMerge: canAuto,
    autoReview: !!labels,
    ...(preparedPrBody.truncated ? { prBodyTruncated: true, prBodyOriginalChars: preparedPrBody.originalChars } : {}),
  });
  await flushPrComments(pr);

  // Inspect the opened PR itself: the goal text and the pre-sync worktree can differ from its final file list.
  let releaseHoldPath: string | undefined;
  let releasePathInspectionError: string | undefined;
  if (s.readPrFiles) {
    try {
      const files = await withStepTimeout(s.readPrFiles({ number: pr.number, cwd: wt.path }), T.pr, 'pr');
      if (!Array.isArray(files) || !files.every((path) => typeof path === 'string')) throw new Error('invalid PR file list');
      releaseHoldPath = releasePathHold(files);
    } catch (error) {
      releasePathInspectionError = safeErrorDescription(error);
    }
  } else if (canAuto || labels?.includes(AUTO_REVIEW_LABEL)) {
    releasePathInspectionError = 'readPrFiles seam unavailable';
  }
  if (releaseHoldPath) {
    debug.log('self-dev.merge', 'release-path-hold', { number: pr.number, path: releaseHoldPath, label: RELEASE_PATH_LABEL });
    canAuto = false;
    mergeSkipReason = mergeReason = 'release-path-hold';
    // Suppress the independent auto-review poller as well as this immediate merge path.
    // No merge is attempted even when an annotation fails; each failure is observable for OP repair.
    for (const [action, annotate] of [
      ['add-label', s.addPrLabel && (() => s.addPrLabel!({ number: pr.number, label: RELEASE_PATH_LABEL, cwd: wt.path }))],
      ['comment', s.postPrComment && (() => s.postPrComment!({ number: pr.number, body: releasePathHoldComment(releaseHoldPath), cwd: wt.path }))],
    ] as const) {
      if (!annotate) {
        observe('release-path-annotation-failed', { number: pr.number, path: releaseHoldPath, action, error: 'annotation seam unavailable' }, { level: 'error' });
        continue;
      }
      try { await annotate(); }
      catch (error) {
        observe('release-path-annotation-failed', { number: pr.number, path: releaseHoldPath, action, error: safeErrorDescription(error) }, { level: 'error' });
      }
    }
    recordMergeDecision();
    progress('pr-opened', `OP 승인 대기 (#${pr.number}): ${releaseHoldPath}`);
    return { ok: true, stage: 'pr-opened', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason, prUrl: pr.url, prNumber: pr.number, detail: `OP approval required: ${releaseHoldPath}` };
  }
  if (!releasePathInspectionError && labels?.includes(AUTO_REVIEW_LABEL)) {
    try {
      if (!s.addPrLabel) throw new Error('addPrLabel seam unavailable');
      await s.addPrLabel({ number: pr.number, label: AUTO_REVIEW_LABEL, cwd: wt.path });
    } catch (error) {
      observe('auto-review-label-failed', { number: pr.number, error: safeErrorDescription(error) }, { level: 'warn' });
    }
  }
  if (releasePathInspectionError && (canAuto || labels?.includes(AUTO_REVIEW_LABEL))) {
    observe('release-path-inspection-failed', { number: pr.number, error: releasePathInspectionError }, { level: 'error' });
    canAuto = false;
    mergeSkipReason = mergeReason = 'release-path-inspection-failed';
    recordMergeDecision();
    progress('pr-opened', `OP 승인 대기 (#${pr.number}): PR 경로 조회 실패`);
    return { ok: true, stage: 'pr-opened', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason, prUrl: pr.url, prNumber: pr.number };
  }

  if (canAuto && (s.mergePr || opts.mergeByHost)) {
    let docsMarkdownDeletions: number | undefined;
    let nonDocsMarkdownDeletions: number | undefined;
    let checkedHeadCommit: string | undefined;
    let observedPrBase: string | undefined;
    let guardFailure: string | undefined;
    if (!s.readPrCommitShas) {
      guardFailure = 'readPrCommitShas seam unavailable';
      observe('auto-merge-head-guard', { number: pr.number, protected: false, blocked: true, reason: guardFailure });
    } else if (!s.readPrDiff) {
      guardFailure = 'readPrDiff seam unavailable';
    } else {
      try {
        const commits = await withStepTimeout(s.readPrCommitShas({ number: pr.number, cwd: wt.path }), T.pr, 'pr');
        if (!commits.baseCommit || !commits.headCommit) {
          guardFailure = 'readPrCommitShas returned an empty base or head SHA';
        } else {
          checkedHeadCommit = commits.headCommit;
          observedPrBase = commits.baseRefName?.trim() || undefined;
          const diff = await withStepTimeout(s.readPrDiff({ number: pr.number, cwd: wt.path, ...commits }), T.pr, 'pr');
          if (typeof diff !== 'string') guardFailure = 'readPrDiff returned a non-string diff';
          else {
            docsMarkdownDeletions = countDocsMarkdownDeletions(diff);
            nonDocsMarkdownDeletions = countNonDocsMarkdownDeletions(diff);
          }
        }
      } catch (error) {
        guardFailure = `${checkedHeadCommit === undefined ? 'readPrCommitShas' : 'readPrDiff'} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (opts.mergeByHost && checkedHeadCommit && !/^[0-9a-f]{40}$/i.test(checkedHeadCommit)) guardFailure = 'checked head SHA is not a full commit hash';
    const blocked = guardFailure !== undefined || docsMarkdownDeletions! >= DOCS_MARKDOWN_AUTO_MERGE_DELETION_THRESHOLD;
    observe('auto-merge-docs-deletion-guard', {
      number: pr.number, threshold: DOCS_MARKDOWN_AUTO_MERGE_DELETION_THRESHOLD, blocked,
      ...(docsMarkdownDeletions !== undefined ? { docsMarkdownDeletions } : {}),
      ...(nonDocsMarkdownDeletions !== undefined ? { nonDocsMarkdownDeletions } : {}),
      ...(guardFailure ? { guardFailure } : {}),
    });
    if (blocked) {
      const detail = guardFailure
        ? `automatic merge blocked: ${guardFailure}; PR left open for human review`
        : `automatic merge blocked: docs Markdown deletion count ${docsMarkdownDeletions} meets threshold ${DOCS_MARKDOWN_AUTO_MERGE_DELETION_THRESHOLD}; PR left open for human review`;
      progress('pr-opened', `⚠️ ${detail}`);
      // ⛔⭐ 이 경로도 `canAuto` 가 «참»이었는데 막힌 자리다 ⇒ mergeSkipReason 은 undefined 다.
      //    판정(mergeReason)이 아니라 «집행 직전 가드»가 막았으므로 그 사실을 값으로 말한다.
      //    ⛔ 안 그러면 마지막 줄이 침묵하고, 그건 이 착지가 없애려던 상태다(리뷰 must-fix 2R).
      const guardSkipReason = mergeSkipReason ?? (guardFailure ? 'merge-guard-unevaluated' : 'docs-deletion-threshold');
      return { ok: true, stage: 'pr-opened', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason: guardSkipReason, prUrl: pr.url, prNumber: pr.number, detail };
    }
    if (opts.mergeByHost) {
      observe('merge-ready', { number: pr.number, checkedHeadCommit });
      progress('pr-opened', `호스트 재게이트 대기 (#${pr.number})`);
      return { ok: true, stage: 'merge-ready', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), checkedHeadCommit: checkedHeadCommit!, prUrl: pr.url, prNumber: pr.number };
    }
    // Landing freeze: the in-flight marker is written before the freeze is read, so a `freeze on` racing this merge waits.
    // The resume sweep merges from the repository that owns the run worktree (the worktree itself may be cleaned up).
    const heldEntry = () => {
      if (!checkedHeadCommit || !/^[0-9a-f]{40}$/i.test(checkedHeadCommit)) return null;
      const owner = owningRepoRoot(wt.path);
      // Without a known owning repository the held PR stays queued for a person; no sweep resumes it from a worktree.
      return owner ? { prNumber: pr.number, headCommit: checkedHeadCommit, repoRoot: owner } : { prNumber: pr.number, headCommit: checkedHeadCommit, repoRoot: wt.path, manual: true as const };
    };
    const landing = admitLandingMerge(heldEntry, undefined, {}, { prNumber: pr.number, repoRoot: owningRepoRoot(wt.path) ?? wt.path, ...(checkedHeadCommit ? { headCommit: checkedHeadCommit } : {}) });
    if (landing.kind === 'held' && !(checkedHeadCommit && /^[0-9a-f]{40}$/i.test(checkedHeadCommit))) {
      return { ok: true, stage: 'pr-opened', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason: 'merge-guard-unevaluated', prUrl: pr.url, prNumber: pr.number, detail: 'freeze: checked head SHA unavailable; PR left ready for review' };
    }
    if (landing.kind !== 'merge') {
      const detail = landing.kind === 'held' ? landingFreezeMessage(landing.freeze) : 'freeze lifted; a resume sweep is merging this PR';
      debug.log('harness.merge', 'frozen', { pr: pr.number, ...(landing.kind === 'held' ? { reason: landing.freeze.reason, until: landing.freeze.until } : { resumedElsewhere: true }) });
      progress('pr-opened', `#${pr.number} ready · ${detail}`);
      return { ok: true, stage: 'pr-opened', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason: landing.kind === 'held' ? 'frozen' : 'resumed-elsewhere', prUrl: pr.url, prNumber: pr.number, detail };
    }
    // The marker and claim live until the merge call itself settles — a step timeout does not stop a merge already
    // sent — and anything that throws before the merge call is made releases them.
    let merging: ReturnType<NonNullable<typeof s.mergePr>>;
    try {
      onNodeEntry('merge', round);
      progress('merging', '자동 병합 (리뷰 clean·squash)…');
      merging = s.mergePr!({ number: pr.number, cwd: wt.path, matchHeadCommit: checkedHeadCommit! });
    } catch (error) { landing.end(); throw error; }
    // The default merge seam resolves only after `gh pr view` reads MERGED, so settling is the confirmation.
    const release = (merged: boolean) => {
      try { landing.end(merged); } catch (error) { observe('landing-release-failed', { number: pr.number, error: safeErrorDescription(error) }, { level: 'error' }); }
    };
    void merging.then((outcome) => release(outcome.merged === true), () => release(false));
    const m = await withStepTimeout(merging, T.pr, 'pr');
    observe('merged', { number: pr.number, merged: m.merged, detail: m.detail ?? null });
    if (m.merged) {
      try {
        await s.supersedeDraftsOnMerge?.(pr.number, wt.path);
      } catch (error) {
        observe('draft-supersede-on-merge-failed', { number: pr.number, error: safeErrorDescription(error) }, { level: 'warn' });
      }
      const directory = releaseNotesDir(elanousStateRoot());
      const fragment: ReleaseNoteFragment = {
        pr: pr.number,
        ...releaseNote,
        source: 'harness',
        ...(m.mergeCommit ? { mergeSha: m.mergeCommit } : {}),
      };
      try {
        writeReleaseNote(directory, fragment);
      } catch (error) {
        observe('release-note-write-failed', { number: pr.number, prUrl: pr.url, directory, fragment, error: safeErrorDescription(error) }, { level: 'error' });
        throw new MergedReleaseNoteWriteError(pr.url, directory, fragment, error);
      }
      const mergedBase = m.baseRefName?.trim() || observedPrBase;
      const defaultBranch = resolveDefaultBranchTarget(s.defaultBranchRef ?? defaultBranchRef, wt.path).target ?? undefined;
      progress('merged', formatAutoMergeSuccessMessage({ prNumber: pr.number, mergedBase, defaultBranch }));
      await runPostMergeCleanup(s.postMergeCleanup, wt.path, wt.branch, opts.goalFile, mergedBase && defaultBranch && displayBranchName(mergedBase) === displayBranchName(defaultBranch) ? defaultBranch : undefined, observe);
      const mergedLedger = (() => {
        try { return loadRunLedger(runId); } catch { return null; }
      })();
      await runLineageSupersede(s.lineageSupersede, {
        ...askFileField(opts.goalFile ?? ''),
        runId,
        prNumber: pr.number,
        openedAt: openedAtFromLedger(mergedLedger, new Date().toISOString()),
      }, observe);
      return { ok: true, stage: 'merged', node: 'merge', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), merged: true, ...(mergedBase ? { mergedBase } : {}), prUrl: pr.url, prNumber: pr.number };
    }
    progress('pr-opened', `병합 실패 — PR 개설됨(#${pr.number}·수동 병합). ${m.detail ?? ''}`);
    // ⛔⭐ 이 경로는 `canAuto` 가 «참»이었는데 병합이 안 된 자리다 ⇒ mergeSkipReason 은 undefined 다.
    //    그대로 두면 마지막 산출 줄이 «침묵»한다 — 이 착지가 없애려던 바로 그 상태다(리뷰 must-fix).
    //    ⇒ 판정이 아니라 «집행»에서 막힌 것이므로 그 사실을 별도 값으로 말한다.
    const mergeAttemptSkipReason = mergeSkipReason ?? 'merge-attempt-failed';
    return { ok: true, stage: 'pr-opened', node: 'merge', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), mergeReason: mergeAttemptSkipReason, merged: false, prUrl: pr.url, prNumber: pr.number, ...(m.detail ? { detail: m.detail } : {}) };
  }
  progress('pr-opened', `✅ PR 개설 (#${pr.number})`);
  return { ok: true, stage: 'pr-opened', node: 'open-pr', ...resolveRunOutcome({ termination: 'completed' }), ...decisionSignalResult, ...preservedCompletionResult, ...(completionStatus ? { completionStatus } : {}), sessionId, worktreePath: wt.path, branch: wt.branch, gate, ...(review ? { review } : {}), ...(lastSupervisorReason ? { supervisorReason: lastSupervisorReason } : {}), ...(mergeSkipReason ? { mergeReason: mergeSkipReason } : {}), prUrl: pr.url, prNumber: pr.number };
}

/** 결정적 요청 거부 — 같은 요청을 다시 보내면 «같은» 답이 온다(BACKLOG B6).
 *  🩸 09-25: `Anthropic API 400 … invalid_request_error … temperature is deprecated` 가 `other` 로 분류돼
 *    슈퍼바이저가 「그대로 재실행」을 두 번 더 걸었다(API 과금 팔 · 매번 40초에 같은 400).
 *  ⛔ 429(속도)·408(타임아웃)·5xx(서버)·쿼터·자격은 여기 들지 않는다 — 그것들은 다시 걸면 풀릴 수 있다. */
export function isDeterministicRequestRejection(message: string): boolean {
  if (!message) return false;
  if (/\b(?:429|408|5\d\d)\b|rate[_ -]?limit|overloaded|timeout|timed out/i.test(message)) return false;
  return /invalid_request_error|\b(?:API|HTTP)\s*(?:400|404|422)\b|model[^.]{0,40}not supported|is deprecated for this model|unsupported (?:parameter|value)/i.test(message);
}
