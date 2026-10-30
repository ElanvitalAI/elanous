/**
 * Self-dev goal decomposition (S2 — the dependency-tree "generator").
 *
 * Splits ONE high-level feature into an ordered set of self-dev sub-goals
 * with dependency edges + hot-path declarations, which orchestrateSelfDev
 * then runs as a topological-parallel DAG.
 *
 * Deliberately NOT the mission `TaskGenerator` (task-orchestrator/
 * generator.ts): that operates at mission altitude (mixed surfaces, arcs,
 * acceptance checks, surface-monoculture heuristics) and forcing it to
 * emit self-implement-only tasks is a mis-fit. The right reuse level is
 * the LLM primitive (`streamLLM`), wrapped here in a thin, injectable
 * seam so isolated tests use a fake and never call a live model.
 *
 * Cf. PLAN-parallel-self-dev-orchestrator-2026-07-21 §6 (S2).
 */
import { debug } from '../debug/log.js';
import {
  resolveRoleModel,
  type ModelResolutionSource,
  type UserConfig,
} from '../user-config.js';
import {
  gradePhaseCompletability,
  type CompletabilitySizeSignals,
  type CompletabilityVerdict,
} from '../autopilot/mission-phase-granularity.js';
import {
  buildSelfDevArcClassifyPrompt,
  deriveSelfDevArcsFromGrouping,
  parseSelfDevArcGrouping,
  type SelfDevArc,
} from './arc-classify.js';
import type { RfcAuthorContext } from '../autopilot/mission-rfc-author.js';
import type { FabricDecomposition } from './fabric-decompose-adapter.js';
import type { SelfDevGoal } from './orchestrate.js';
import {
  groundDecomposePathClaims,
  type DecomposePathGrounding,
  type DecomposePathGroundingOptions,
} from './decompose-path-grounding.js';

/** LLM seam — `(prompt) => completion`. Default wires `streamLLM`. */
export type SelfDevDecomposeLlm = (prompt: string) => Promise<string>;
export type SelfDevDecomposer = 'default' | 'fabric';
type SelfDevDecomposerSelection = SelfDevDecomposer | 'fabric-rejected';
export type SelfDevFabricDecompose = (feature: string, context: RfcAuthorContext, resolve: SelfDevDecomposeLlm) => Promise<FabricDecomposition>;

/** Explicit Fabric selection never silently becomes the default decomposer. */
export class FabricDecompositionRejectedError extends Error {
  constructor(readonly result: Exclude<FabricDecomposition, { status: 'decomposed' }>) {
    super(`fabric decomposition rejected: ${result.status}${'message' in result ? `: ${result.message}` : ''}`);
    this.name = 'FabricDecompositionRejectedError';
  }
}

export interface SelfDevDecompositionObservationContext {
  /** Caller-specific observation names; omitted values preserve the decomposition defaults. */
  category?: string;
  event?: string;
  /** Stable goal identity when the caller has the authored goal document. */
  goalId?: string | null;
  /** Execution identity when decomposition occurs from an existing run. */
  runId?: string | null;
}

export interface SelfDevDecomposeOptions {
  llm?: SelfDevDecomposeLlm;
  /** Select the Fabric adapter; omitted preserves the existing default decomposition. */
  decomposer?: SelfDevDecomposer;
  /** Required context and resolver for the explicit Fabric adapter selection. */
  fabric?: { context: RfcAuthorContext; resolve: SelfDevDecomposeLlm; decompose?: SelfDevFabricDecompose };
  /** Name and identity of the observation caller without changing decomposition semantics. */
  observation?: SelfDevDecompositionObservationContext;
  /** Repository context for non-blocking path-claim observation. */
  pathGrounding?: DecomposePathGroundingOptions;
  /** Max sub-goals (default 6). */
  maxTasks?: number;
  /** Defaults applied to every produced goal. */
  base?: string;
  autoMerge?: boolean;
  /** Model for the default streamLLM seam. */
  model?: string;
  /** Explicitly request this many arcs; omitted preserves the flat result. */
  arcHint?: number;
  /** Optional injected seam for arc grouping; only used when arcHint is set. */
  arcLlm?: SelfDevArcClassifyLlm;
}

export type SelfDevArcClassifyLlm = (prompt: string) => Promise<string>;

/** Default maximum number of retained self-dev sub-goals. */
export const DEFAULT_MAX_TASKS = 6;
/** Bound human-readable decomposition text while preserving its truncation state. */
export const SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH = 500;

export interface SelfDevDecompositionMeta {
  recommendedMaxTasks: number;
  actualTaskCount: number;
  truncatedAtHardMax: boolean;
  exceededRecommendedMax: boolean;
  /** ⭐ 분해 결말의 원인을 값으로 구분한다.
   *  `decomposed`               분해가 실제로 조각을 냈다
   *  `single-no-subtasks`       LLM 이 답했는데 서브태스크가 «없었다»(그래서 단일 골로 간다)
   *  `missing-research-context` Fabric 분해에 필요한 연구 맥락이 없었다
   *  `grounding-empty`          Fabric 접지가 사용 가능한 연구 맥락을 만들지 못했다
   *  `authored-empty`           Fabric 저작이 분해할 arc를 만들지 못했다
   *  `llm-failed`               LLM 호출 자체가 «실패»했다(타임아웃·제공자 장애) ⇒ 분해를 «못 한» 것이다
   *  ⛔ 「쪼갤 필요가 없었다」와 Fabric 사전분해 실패는 다른 값이다. */
  outcome: 'decomposed' | 'single-no-subtasks' | 'slice-rejected' | 'missing-research-context' | 'grounding-empty' | 'authored-empty' | 'llm-failed';
  /** `llm-failed` 일 때만 실린다 — 문면의 «머리»를 자르지 않는다. */
  error?: string;
  /** Present for Fabric decomposition, including zero, to distinguish no omissions from no report. */
  omittedGoalCount?: number;
}

export interface SelfDevDecomposition {
  goals: SelfDevGoal[];
  decomposition: SelfDevDecompositionMeta;
  /** Present only for a valid explicitly requested arc grouping. */
  arcs?: SelfDevArc[];
  /** Present when valid grouping differs from the explicit request. */
  hintDeviation?: { requested: number; actual: number };
}

// ⛔⭐ 왜 `outcome` 이 생겼나(2026-08-11 73차 · `[T]` 실패 B 가 이 자리를 가리켰다):
//   LLM 호출이 실패하면 이 함수는 «조용히» 단일 골로 폴백했고, 관측은 `actualTaskCount:0` 만 남겼다.
//   ⇒ 바깥에서 「이 골은 쪼갤 필요가 없었다」와 ***「쪼개려다 실패했다」***가 «같은 값»으로 보였다.
//   📏 그래서 「너무 큰 골」이 안 쪼개진 채로 발사돼 rework 4라운드 뒤 게이트에서 죽었다.
//   ⭐ 이 창에서 같은 형태를 네 번째 고친다(`#8274` clarify · `#8283` 원장 · 여기 · ⊕ `#8288`).
export interface SelfDevDecompositionObservedSubtask {
  id: string;
  dependsOn: string[];
  feature?: string;
  featureTruncated: boolean;
  /** Computed from the original feature before its observation text is bounded. */
  pathGrounding: DecomposePathGrounding;
}

/** Discriminating inputs `gradePhaseCompletability` actually branched on. */
interface SelfDevSubtaskGradeInput {
  /** `prompt.trim().length` — `too_small` uses this, not the raw string. */
  promptLength: number;
  /** `acceptance.length` — this path always passes `[]`. */
  acceptanceCount: number;
  /** Omitted signals stay empty so a reader can see files/est were not passed. */
  sizeSignals: CompletabilitySizeSignals;
}

/** Per-subtask grade plus the inputs that produced it. */
interface SelfDevSubtaskGradeRationale {
  id: string;
  verdict: CompletabilityVerdict;
  input: SelfDevSubtaskGradeInput;
  concerns: string[];
  conjunctions: number;
  oversizeFactors: string[];
  completabilityScore: number;
  reason: string;
}

export interface SelfDevDecompositionObservation extends SelfDevDecompositionMeta {
  /** Number of registration-only goals folded into their dependency. */
  foldedRegistration: number;
  /** Number of retained subtasks whose original feature text grades `too_large`. */
  tooLargeSubtaskCount: number;
  /** Number of retained subtasks whose original feature text grades `too_small`. */
  tooSmallSubtaskCount: number;
  /** Whether at least two retained subtasks grade `too_large`. */
  hasMultipleTooLargeSubtasks: boolean;
  /** Present only when decomposition retained subtasks for observation. */
  subtasks?: SelfDevDecompositionObservedSubtask[];
  /** Present only when decomposition retained subtasks; one rationale per retained id. */
  gradeRationales?: SelfDevSubtaskGradeRationale[];
  /** Present only when explicit arc classification succeeded; arcs remain metadata, not execution units. */
  arcs?: SelfDevArc[];
  /** Present only when the valid grouping differs from the requested number of arcs. */
  hintDeviation?: { requested: number; actual: number };
}

function observeSubtask(
  goal: SelfDevGoal,
  pathGroundingOptions: DecomposePathGroundingOptions | undefined,
): SelfDevDecompositionObservedSubtask {
  const featureTruncated = (goal.feature?.length ?? 0) > SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH;
  return {
    id: goal.id ?? '',
    dependsOn: goal.dependsOn ?? [],
    ...(goal.feature === undefined ? {} : {
      feature: featureTruncated
        ? goal.feature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH)
        : goal.feature,
    }),
    featureTruncated,
    pathGrounding: groundDecomposePathClaims(goal.feature ?? '', pathGroundingOptions),
  };
}

function gradeRetainedSubtask(goal: SelfDevGoal): {
  id: string;
  grade: ReturnType<typeof gradePhaseCompletability>;
  input: SelfDevSubtaskGradeInput;
} {
  const feature = goal.feature ?? '';
  const input = { id: goal.id ?? '', title: feature, prompt: feature, acceptance: [] };
  const grade = gradePhaseCompletability(input);
  return {
    id: input.id,
    grade,
    input: {
      promptLength: input.prompt.trim().length,
      acceptanceCount: input.acceptance.length,
      sizeSignals: grade.sizeSignals,
    },
  };
}

function observeGradeRationale(
  graded: ReturnType<typeof gradeRetainedSubtask>,
): SelfDevSubtaskGradeRationale {
  const { id, grade, input } = graded;
  return {
    id,
    verdict: grade.verdict,
    input,
    concerns: grade.concerns,
    conjunctions: grade.conjunctions,
    oversizeFactors: grade.oversizeFactors,
    completabilityScore: grade.completabilityScore,
    reason: grade.reason,
  };
}

function observationIdentity(observationContext: SelfDevDecompositionObservationContext): { goalId: string | null; goalIdStatus: 'known' | 'unknown'; runId: string | null } {
  const goalId = observationContext.goalId?.trim();
  return {
    goalId: goalId || null,
    goalIdStatus: goalId ? 'known' : 'unknown',
    runId: observationContext.runId ?? null,
  };
}

function observeUnknownGoalId(observationContext: SelfDevDecompositionObservationContext): void {
  const identity = observationIdentity(observationContext);
  if (identity.goalIdStatus === 'unknown') {
    debug.log(observationContext.category ?? 'self-dev', `${observationContext.event ?? 'decomposition'}.goal-id-unknown`, identity);
  }
}

function observeDecomposerSelection(selection: SelfDevDecomposerSelection, observationContext: SelfDevDecompositionObservationContext = {}): void {
  observeUnknownGoalId(observationContext);
  debug.log(observationContext.category ?? 'self-dev', `${observationContext.event ?? 'decomposition'}.decomposer-selection`, {
    decomposer: selection,
    ...observationIdentity(observationContext),
  });
}

function applyGoalDefaultsAndHotPaths(goals: SelfDevGoal[], defaults: { base?: string; autoMerge?: boolean }): SelfDevGoal[] {
  return goals.map((goal) => {
    const hotPaths = [...new Set([...(goal.hotPaths ?? []), ...inferHotPaths(goal.feature ?? '')])];
    return {
      ...goal,
      ...(hotPaths.length ? { hotPaths } : {}),
      ...(defaults.base !== undefined ? { base: defaults.base } : {}),
      ...(defaults.autoMerge !== undefined ? { autoMerge: defaults.autoMerge } : {}),
    };
  });
}

const REGISTRATION_FILES = new Set([
  'src/nexus/api/http-server.ts',
  'src/index.ts',
  'src/telegram-commands.ts',
]);

function isRegistrationFile(path: string): boolean {
  return REGISTRATION_FILES.has(path) || /^graphs\/(?:[^/]+\/)*[^/]+\.yaml$/.test(path);
}

/** Fold only registration-only goals into their one retained dependency. */
export function foldRegistrationOnlyGoals(goals: SelfDevGoal[]): SelfDevGoal[] {
  let remaining = [...goals];
  let changed = true;
  while (changed) {
    changed = false;
    for (const registration of remaining) {
      const files = registration.hotPaths ?? [];
      if (files.length === 0 || !files.every(isRegistrationFile) || registration.dependsOn?.length !== 1) continue;
      const dependencyId = registration.dependsOn[0];
      const targetIndex = remaining.findIndex((goal) => goal.id === dependencyId && goal !== registration);
      if (targetIndex < 0) continue;
      const target = remaining[targetIndex]!;
      remaining = remaining.filter((goal) => goal !== registration).map((goal) => {
        if (goal === target) {
          const dependsOn = goal.dependsOn?.filter((id) => id !== registration.id && id !== goal.id);
          const { dependsOn: _old, ...rest } = goal;
          return {
            ...rest,
            ...(dependsOn?.length ? { dependsOn } : {}),
            feature: `${goal.feature}\nAlso register: ${registration.feature}`,
            hotPaths: [...new Set([...(goal.hotPaths ?? []), ...files])],
          };
        }
        if (!goal.dependsOn?.includes(registration.id!)) return goal;
        const dependsOn = [...new Set(goal.dependsOn.map((id) => id === registration.id ? target.id! : id))]
          .filter((id) => id !== goal.id);
        const { dependsOn: _old, ...rest } = goal;
        return dependsOn.length ? { ...rest, dependsOn } : rest;
      });
      debug.log('self-dev.decompose', 'fold-registration', { from: registration.id, into: target.id, files });
      changed = true;
      break;
    }
  }
  return remaining;
}

function observeDecomposition(
  goals: SelfDevGoal[],
  decomposition: SelfDevDecompositionMeta,
  arcClassification?: { arcs: SelfDevArc[]; hintDeviation?: { requested: number; actual: number } },
  observationContext: SelfDevDecompositionObservationContext = {},
  pathGroundingOptions?: DecomposePathGroundingOptions,
  foldedRegistration = 0,
): SelfDevDecomposition {
  const retainedSubtasks = decomposition.outcome === 'decomposed' ? goals : [];
  const gradedSubtasks = retainedSubtasks.map(gradeRetainedSubtask);
  const tooLargeSubtaskCount = gradedSubtasks.filter(({ grade }) => grade.verdict === 'too_large').length;
  const observation: SelfDevDecompositionObservation & { goalId: string | null; runId: string | null } = {
    ...decomposition,
    foldedRegistration,
    tooLargeSubtaskCount,
    tooSmallSubtaskCount: gradedSubtasks.filter(({ grade }) => grade.verdict === 'too_small').length,
    hasMultipleTooLargeSubtasks: tooLargeSubtaskCount >= 2,
    ...observationIdentity(observationContext),
    ...(decomposition.outcome === 'decomposed'
      ? {
        subtasks: retainedSubtasks.map((goal) => observeSubtask(goal, pathGroundingOptions)),
        gradeRationales: gradedSubtasks.map(observeGradeRationale),
      }
      : {}),
    ...(arcClassification ? {
      arcs: arcClassification.arcs,
      ...(arcClassification.hintDeviation ? { hintDeviation: arcClassification.hintDeviation } : {}),
    } : {}),
  };
  debug.log(observationContext.category ?? 'self-dev', observationContext.event ?? 'decomposition', observation,
    decomposition.outcome === 'llm-failed' ? { level: 'warn' } : undefined);
  return {
    goals,
    decomposition,
    ...(arcClassification ? {
      arcs: arcClassification.arcs,
      ...(arcClassification.hintDeviation ? { hintDeviation: arcClassification.hintDeviation } : {}),
    } : {}),
  };
}

function normalizeArcHint(arcHint: number | undefined): number | undefined {
  if (arcHint === undefined) return undefined;
  if (!Number.isInteger(arcHint) || arcHint < 2 || arcHint > 6) {
    throw new RangeError('arcHint must be an integer from 2 to 6');
  }
  return arcHint;
}

function normalizeMaxTasks(maxTasks: number | undefined): number {
  const normalized = maxTasks ?? DEFAULT_MAX_TASKS;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new RangeError('maxTasks must be a positive integer');
  }
  return normalized;
}

function pruneDanglingDependencies(goals: SelfDevGoal[]): SelfDevGoal[] {
  const retainedIds = new Set(goals.map((goal) => goal.id));
  return goals.map((goal) => {
    const dependsOn = goal.dependsOn?.filter((id) => retainedIds.has(id));
    if (!goal.dependsOn || dependsOn?.length === goal.dependsOn.length) return goal;
    const { dependsOn: _removed, ...withoutDependencies } = goal;
    return dependsOn?.length ? { ...withoutDependencies, dependsOn } : withoutDependencies;
  });
}

const SELF_DEV_CONCERN_CLASSES = ['investigate', 'design', 'add-one-unit', 'wire-into-existing', 'verify'] as const;
const SELF_DEV_CONCERN_SPLIT_THRESHOLD = 3;

/** Build the decomposition prompt (STRICT JSON out). Pure. */
export function buildSelfDevDecomposePrompt(feature: string, maxTasks = DEFAULT_MAX_TASKS): string {
  return [
    'You split a software feature request into independently-implementable sub-features',
    'for a fleet of autonomous coding agents that each run in an ISOLATED git worktree.',
    '',
    '## Feature',
    feature.trim(),
    '',
    '## Rules',
    `- Emit at most ${maxTasks} sub-features. Fewer is better — do NOT over-split, except when a sub-feature mixes ${SELF_DEV_CONCERN_SPLIT_THRESHOLD} or more concern classes — ${SELF_DEV_CONCERN_CLASSES.join(' / ')} — split it into sibling sub-features.`,
    '- SEPARATE DEFINE FROM WIRE: adding a new function/type/export is a SEPARATE task from wiring it into an existing runtime call site. A task that both defines a new symbol AND integrates it across modules tends to leave dead-code (defined but never called) that fails integration gates. Pattern: (a) add the function + its unit test; then (b) a dependent task that wires it into the specific existing call site — name the exact `file.ts:function` to modify.',
    '- Exception to SEPARATE DEFINE FROM WIRE: Keep a definition and its registration/wiring in the same sub-feature — a handler with its route, a command with its CLI registration, a node with its graph/recipe entry.',
    '- Each sub-feature must be a self-contained, mergeable unit of work.',
    '- LANDABLE SLICE CONTRACT: every sub-feature must state a completionBoundary that can be implemented and verified without a later sub-feature, future component, or unwired operational path. If it cannot stand alone, split it further or omit it.',
    '- Every sub-feature must name one existing mock scenario as mockScenario.id (MS-01, MS-02, ...), plus a concrete mockScenario.injection and mockScenario.observation. Describe the event or input injected and the output/event that proves the slice works.',
    '- List every required earlier slice explicitly in dependsOn. An empty list means this slice has no predecessor; never rely on implicit order or a future capability.',
    '- Declare futureAssumptions as an array. If the slice needs any future component, later slice, or unwired operational path, list it there; that slice will be rejected with a decompose.slice-rejected event containing its id and reason, and must be split or omitted.',
    '- `dependsOn`: list the `id`s of sub-features that MUST land first (e.g. a shared',
    '  type/interface before its consumers). Independent sub-features share NO dependency',
    '  so they run in parallel. No cycles.',
    '- `hotPaths`: repo file paths this sub-feature will edit. Two sub-features that edit',
    '  the same path are auto-serialized — declare paths honestly so overlaps are ordered.',
    '- `goalType`: classify each sub-feature as exactly one of `implement`, `research`,',
    '  `document`, or `operate`.',
    '- If the feature is already atomic, return a single sub-feature.',
    '',
    '## Output (STRICT JSON — no prose, no code fence)',
    '{"subtasks":[{"id":"<short-slug>","feature":"<imperative sub-feature text>",',
    '  "completionBoundary":"<standalone change and observable outcome>",',
    '  "mockScenario":{"id":"MS-01","injection":"<input/event injected>","observation":"<output/event observed>"},',
    '  "futureAssumptions":[],"dependsOn":["<explicit predecessor id>",...],',
    '  "hotPaths":["<path>",...],"goalType":"<implement|research|document|operate>"}]}',
  ].join('\n');
}

interface RawSubtask {
  id?: unknown;
  feature?: unknown;
  dependsOn?: unknown;
  hotPaths?: unknown;
  goalType?: unknown;
  completionBoundary?: unknown;
  mockScenario?: unknown;
  futureAssumptions?: unknown;
}

interface RejectedDecompositionSlice {
  id: string | null;
  reasons: string[];
}

interface ValidatedDecomposition {
  goals: SelfDevGoal[];
  rejected: RejectedDecompositionSlice[];
}

const SELF_DEV_GOAL_TYPES = new Set(['implement', 'research', 'document', 'operate'] as const);

function isSelfDevGoalType(value: unknown): value is SelfDevGoal['goalType'] {
  return typeof value === 'string' && SELF_DEV_GOAL_TYPES.has(value as never);
}

function extractRawSubtasks(raw: string): unknown[] {
  const obj = extractJsonObject(raw);
  return Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { subtasks?: unknown })?.subtasks)
      ? (obj as { subtasks: unknown[] }).subtasks
      : [];
}

function isRawSubtask(value: unknown): value is RawSubtask {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureSingleCompletionCriterion(feature: string, targetPaths: string[]): string {
  const lines = feature.split(/\r?\n/);
  const criteria = lines.filter((line) => /^\s*완료 기준\s*:/.test(line));
  if (criteria.length === 0) {
    return `${feature}\n완료 기준: ${targetPaths.join(' · ')}의 변경을 확인하고 관련 시험을 통과한다.`;
  }
  if (criteria.length === 1 && criteria[0]!.trim().length > '완료 기준:'.length) return feature;
  const criterionText = criteria
    .map((line) => line.replace(/^\s*완료 기준\s*:\s*/, '').trim())
    .filter(Boolean)
    .join(' · ');
  const normalizedCriterion = criterionText || `${targetPaths.join(' · ')}의 변경을 확인하고 관련 시험을 통과한다.`;
  const firstCriterionIndex = lines.findIndex((line) => /^\s*완료 기준\s*:/.test(line));
  const withoutCriteria = lines.filter((line) => !/^\s*완료 기준\s*:/.test(line));
  withoutCriteria.splice(Math.min(firstCriterionIndex, withoutCriteria.length), 0, `완료 기준: ${normalizedCriterion}`);
  return withoutCriteria.join('\n');
}

/**
 * G6 (1c) — 결정론적 hotPaths 추론. 분해된 sub-goal 의 feature 텍스트에서 repo 파일
 * 경로(src/…·docs/…·scripts/… + 확장자)를 뽑는다. LLM 이 hotPaths 를 안 채워도 hot-file
 * 직렬화(S2·병렬 머지충돌 회피)가 작동하게 하는 안전망. 알려진 top-dir 접두 + 확장자만
 * 매칭해 산문 오탐 차단(순수). [[ROADMAP-elanous-is-all-pty-unified-autonomy-2026-07-21]] G6.
 */
export function inferHotPaths(text: string): string[] {
  const matches = text.match(/\b(?:src|docs|apps|packages|scripts|tests?|bin)\/[\w./-]+\.[a-z0-9]{1,5}\b/gi) ?? [];
  return [...new Set(matches)];
}

/** A child without implementation targets inherits the parent's explicit target line and ask. */
export function inheritDecomposedTargetPaths(parentFeature: string, goals: SelfDevGoal[]): SelfDevGoal[] {
  const declaredTargets = (feature: string) => [...new Set(feature.split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]\s*)?대상 경로\s*:/.test(line))
    .flatMap(inferHotPaths))];
  const parentTargets = declaredTargets(parentFeature);
  if (!parentTargets.length) return goals;
  // A two-part implementation must not hand a pathless child its sibling's
  // target as part of the parent edit fence. Keep other decompositions below.
  if (goals.length === 2 && parentTargets.length >= 2
    && goals.every((goal) => goal.goalType === undefined || goal.goalType === 'implement')) {
    const own = goals.map((goal) => declaredTargets(goal.feature ?? ''));
    const undeclared = own.map((paths, index) => paths.length ? -1 : index).filter((index) => index >= 0);
    const declared = own.flat();
    const canDivide = undeclared.length === 2
      || (undeclared.length === 1 && declared.length > 0
        && declared.some((path) => parentTargets.includes(path))
        && parentTargets.some((path) => !declared.includes(path)));
    if (canDivide) {
      const claims = goals.map((goal, index) => own[index]!.length
        ? own[index]!
        : (goal.hotPaths ?? []).filter((path) => parentTargets.includes(path)));
      const claimedOwners = parentTargets.map((path) => goals.flatMap((_, index) => claims[index]!.includes(path) ? [index] : []));
      const sharedExplicitTarget = own.length === 2 && own[0]!.some((path) => own[1]!.includes(path));
      const conflictingClaims = sharedExplicitTarget || claimedOwners.some((indices) => indices.length > 1);
      const nameOwners = parentTargets.map((path) => {
        const stemWords = path.split('/').at(-1)!.replace(/\.[^.]+$/, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
        if (!stemWords.length || stemWords.join('').length < 4) return [];
        return goals.flatMap((goal, childIndex) => {
          const words = (goal.feature ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
          return words.some((_, start) => stemWords.every((word, offset) => words[start + offset] === word)) ? [childIndex] : [];
        });
      });
      const ambiguousName = nameOwners.some((indices, index) => claimedOwners[index]!.length === 0 && indices.length > 1);
      const conflictingNameClaim = claimedOwners.some((indices, index) => indices.length === 1
        && nameOwners[index]!.some((namedOwner) => namedOwner !== indices[0]));
      const claimCounts = [0, 1].map((index) => claimedOwners.filter((indices) => indices.length === 1 && indices[0] === index).length);
      const soleClaimant = claimCounts[0]! > 0 && claimCounts[1] === 0 ? 0
        : claimCounts[1]! > 0 && claimCounts[0] === 0 ? 1 : undefined;
      const conflictingUnclaimedHint = soleClaimant !== undefined && nameOwners.some((indices, index) =>
        claimedOwners[index]!.length === 0 && indices.includes(soleClaimant));
      const owners = parentTargets.map((_, index) => claimedOwners[index]!.length === 1
        ? claimedOwners[index]![0]
        : soleClaimant !== undefined ? 1 - soleClaimant
          : nameOwners[index]!.length === 1 ? nameOwners[index]![0] : undefined);
      const ownerCounts = [owners.filter((owner) => owner === 0).length, owners.filter((owner) => owner === 1).length];
      owners.forEach((owner, index) => {
        if (owner !== undefined) return;
        const next = ownerCounts[0]! <= ownerCounts[1]! ? 0 : 1;
        owners[index] = next;
        ownerCounts[next] = (ownerCounts[next] ?? 0) + 1;
      });
      // A named path wins over model order; if every path points at one child,
      // keep the old scope rather than inventing work for the other child.
      const partitions = goals.map((_, index) => parentTargets.filter((_, pathIndex) => owners[pathIndex] === index));
      const conflictingParentReference = goals.some((goal, index) =>
        own[index]!.length > 0 && (goal.hotPaths ?? []).some((path) =>
          parentTargets.includes(path) && !own[index]!.includes(path)));
      if (partitions.every((paths) => paths.length > 0)
        && !conflictingClaims && !ambiguousName && !conflictingNameClaim && !conflictingUnclaimedHint
        && !conflictingParentReference) return goals.map((goal, index) => {
        const targets = partitions[index]!;
        // A declared child target may add a helper outside the parent fence. Bare
        // hotPaths outside that fence are references, so do not widen the write fence.
        const explicitHelpers = own[index]!.filter((path) => !parentTargets.includes(path));
        const feature = `${goal.feature}${own[index]!.length ? '' : `\n대상 경로: ${targets.join(' · ')}`}`;
        return { ...goal, hotPaths: [...new Set([...targets, ...explicitHelpers])],
          feature: ensureSingleCompletionCriterion(feature, targets) };
      });
    }
  }
  const explicitChildTargets = goals.map((goal) => declaredTargets(goal.feature ?? ''));
  const explicitParentTargets = explicitChildTargets.map((paths) => paths.filter((path) => parentTargets.includes(path)));
  const explicitTargetsArePartition = goals.length === 2
    && explicitParentTargets.every((paths) => paths.length > 0)
    && new Set(explicitChildTargets.flat()).size === explicitChildTargets.flat().length
    && explicitParentTargets[0]!.every((path) => !explicitParentTargets[1]!.includes(path))
    && new Set(explicitParentTargets.flat()).size === parentTargets.length
    && parentTargets.every((path) => explicitParentTargets.flat().includes(path))
    && goals.every((goal, index) => (goal.hotPaths ?? []).every((path) =>
      !parentTargets.includes(path) || explicitChildTargets[index]!.includes(path)));
  return goals.map((goal, index) => {
    // hotPaths also contains inferred references; only an explicit target line establishes child scope.
    const own = explicitChildTargets[index]!;
    if (own.length) {
      if (explicitTargetsArePartition) {
        return { ...goal, hotPaths: own, feature: ensureSingleCompletionCriterion(goal.feature ?? '', own) };
      }
      return goal;
    }
    return { ...goal, hotPaths: [...new Set([...(goal.hotPaths ?? []), ...parentTargets])],
      feature: `${goal.feature}\n대상 경로: ${parentTargets.join(' · ')}` };
  });
}

/** Tolerant JSON extraction — LLM may wrap in a fence or prose. */
function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const open = candidate.indexOf('{');
    const close = candidate.lastIndexOf('}');
    if (open >= 0 && close > open) {
      try { return JSON.parse(candidate.slice(open, close + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Parse an LLM completion into `SelfDevGoal[]`. Pure + tolerant: unknown
 * shapes yield `[]`; `dependsOn` ids referencing unknown/self sub-features
 * are pruned by orchestrateSelfDev at wiring time. Returns [] when nothing
 * usable is found so the caller can fall back to a single-goal run.
 */
export function parseSelfDevDecomposition(
  raw: string,
  defaults: { base?: string; autoMerge?: boolean } = {},
): SelfDevGoal[] {
  const list = extractRawSubtasks(raw);
  const goals: SelfDevGoal[] = [];
  const seenIds = new Set<string>();
  list.forEach((st, i) => {
    if (!isRawSubtask(st)) return;
    const feature = typeof st.feature === 'string' ? st.feature.trim() : '';
    if (!feature) return;
    let id = typeof st.id === 'string' && st.id.trim() ? st.id.trim() : String(i);
    if (seenIds.has(id)) id = `${id}-${i}`;
    seenIds.add(id);
    const dependsOn = Array.isArray(st.dependsOn)
      ? st.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];
    // G6 — LLM 이 준 hotPaths + feature 텍스트서 결정론 추론한 경로 병합(dedup).
    //   LLM 누락에도 hot-file 직렬화가 작동하게(병렬 머지충돌 회피 안전망).
    const llmHot = Array.isArray(st.hotPaths)
      ? st.hotPaths.filter((p): p is string => typeof p === 'string')
      : [];
    const hotPaths = [...new Set([...llmHot, ...inferHotPaths(feature)])];
    goals.push({
      id,
      feature,
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(hotPaths.length ? { hotPaths } : {}),
      ...(isSelfDevGoalType(st.goalType) ? { goalType: st.goalType } : {}),
      ...(defaults.base !== undefined ? { base: defaults.base } : {}),
      ...(defaults.autoMerge !== undefined ? { autoMerge: defaults.autoMerge } : {}),
    });
  });
  return goals;
}

/** Parse the production decomposition contract and keep a reason for each rejected slice. */
function parseValidatedSelfDevDecomposition(
  subtasks: readonly unknown[],
  defaults: { base?: string; autoMerge?: boolean },
): ValidatedDecomposition {
  const goals: SelfDevGoal[] = [];
  const rejected: RejectedDecompositionSlice[] = [];
  const allIds = new Set(subtasks.flatMap((value) => isRawSubtask(value)
    && typeof value.id === 'string' && value.id.trim() ? [value.id.trim()] : []));
  const seenIds = new Set<string>();

  subtasks.forEach((value, index) => {
    if (!isRawSubtask(value)) {
      rejected.push({ id: null, reasons: ['slice must be an object'] });
      return;
    }
    const feature = typeof value.feature === 'string' ? value.feature.trim() : '';
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : String(index);
    const reasons: string[] = [];
    const completionBoundary = typeof value.completionBoundary === 'string' ? value.completionBoundary.trim() : '';
    if (!feature) reasons.push('feature is missing');
    if (!completionBoundary) reasons.push('completionBoundary is missing');

    const mock = value.mockScenario as { id?: unknown; injection?: unknown; observation?: unknown } | undefined;
    const scenarioId = typeof mock?.id === 'string' ? mock.id.trim() : '';
    const injection = typeof mock?.injection === 'string' ? mock.injection.trim() : '';
    const observation = typeof mock?.observation === 'string' ? mock.observation.trim() : '';
    if (!/^MS-[A-Z0-9][A-Z0-9-]*$/i.test(scenarioId)) reasons.push('mockScenario.id must be an MS id');
    if (!injection) reasons.push('mockScenario.injection is missing');
    if (!observation) reasons.push('mockScenario.observation is missing');

    if (!Array.isArray(value.futureAssumptions)) reasons.push('futureAssumptions must be declared as an array');
    else if (value.futureAssumptions.length > 0) reasons.push('future assumptions require split or omission');

    if (value.dependsOn === undefined) reasons.push('dependsOn is missing; declare an explicit id array');
    else if (!Array.isArray(value.dependsOn)) reasons.push('dependsOn must be an explicit id array');
    const dependsOn = Array.isArray(value.dependsOn)
      ? value.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string' && dependency.trim().length > 0)
      : [];
    if (Array.isArray(value.dependsOn) && dependsOn.length !== value.dependsOn.length) reasons.push('dependsOn contains an invalid predecessor id');
    for (const dependency of dependsOn) {
      if (dependency === id || !allIds.has(dependency)) reasons.push(`dependsOn references a missing or self predecessor: ${dependency}`);
    }

    let uniqueId = id;
    if (seenIds.has(uniqueId)) uniqueId = `${uniqueId}-${index}`;
    seenIds.add(uniqueId);
    if (reasons.length) {
      rejected.push({ id, reasons: [...new Set(reasons)] });
      return;
    }

    const llmHot = Array.isArray(value.hotPaths)
      ? value.hotPaths.filter((path): path is string => typeof path === 'string')
      : [];
    const hotPaths = [...new Set([...llmHot, ...inferHotPaths(feature)])];
    goals.push({
      id: uniqueId,
      feature,
      completionBoundary,
      mockScenario: { id: scenarioId, injection, observation },
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(hotPaths.length ? { hotPaths } : {}),
      ...(isSelfDevGoalType(value.goalType) ? { goalType: value.goalType } : {}),
      ...defaults,
    });
  });

  // A dependent slice cannot stay independently landable when its predecessor was rejected.
  let removedDependent = true;
  while (removedDependent) {
    removedDependent = false;
    const validIds = new Set(goals.map((goal) => goal.id));
    for (const goal of [...goals]) {
      const missing = (goal.dependsOn ?? []).filter((dependency) => !validIds.has(dependency));
      if (missing.length === 0) continue;
      goals.splice(goals.indexOf(goal), 1);
      rejected.push({ id: goal.id ?? null, reasons: [`dependsOn references a rejected predecessor: ${missing.join(', ')}`] });
      removedDependent = true;
    }
  }
  return { goals, rejected };
}

/**
 * Decompose a feature into a self-dev DAG via the LLM seam. Falls back to
 * a single goal (the whole feature) when decomposition yields nothing —
 * the orchestrator always has at least one job to run.
 */
async function finalizeDecomposition(
  feature: string,
  goals: SelfDevGoal[],
  decomposition: SelfDevDecompositionMeta,
  opts: SelfDevDecomposeOptions,
  arcHint: number | undefined,
  foldedRegistration = 0,
): Promise<SelfDevDecomposition> {
  goals = inheritDecomposedTargetPaths(feature, goals);
  if (arcHint === undefined || goals.length === 0) return observeDecomposition(goals, decomposition, undefined, opts.observation, opts.pathGrounding, foldedRegistration);
  try {
    const arcLlm = opts.arcLlm ?? opts.llm ?? (await defaultDecomposeLlm(opts.model));
    const tasks = goals.map((goal) => ({ id: goal.id ?? '', title: goal.feature ?? '', description: goal.feature, dependsOn: goal.dependsOn }));
    const grouping = parseSelfDevArcGrouping(await arcLlm(buildSelfDevArcClassifyPrompt(feature, tasks, arcHint)));
    const classification = grouping ? deriveSelfDevArcsFromGrouping(tasks, grouping, arcHint) : null;
    if (!classification) return observeDecomposition(goals, decomposition, undefined, opts.observation, opts.pathGrounding, foldedRegistration);
    const arcByTask = new Map(classification.arcs.flatMap((arc) => arc.taskIds.map((taskId) => [taskId, arc])));
    const taskIdsForArc = new Map(classification.arcs.map((arc) => [arc.id, arc.taskIds]));
    const orderedGoals = goals.map((goal) => {
      const arcDependencies = arcByTask.get(goal.id ?? '')?.dependsOn.flatMap((arcId) => taskIdsForArc.get(arcId) ?? []) ?? [];
      const dependsOn = [...new Set([...(goal.dependsOn ?? []), ...arcDependencies])].filter((id) => id !== goal.id);
      return dependsOn.length ? { ...goal, dependsOn } : goal;
    });
    return observeDecomposition(pruneDanglingDependencies(orderedGoals), decomposition, classification, opts.observation, opts.pathGrounding, foldedRegistration);
  } catch {
    return observeDecomposition(goals, decomposition, undefined, opts.observation, opts.pathGrounding, foldedRegistration);
  }
}

export async function decomposeSelfDevGoal(
  feature: string,
  opts: SelfDevDecomposeOptions = {},
): Promise<SelfDevDecomposition> {
  const maxTasks = normalizeMaxTasks(opts.maxTasks);
  const arcHint = normalizeArcHint(opts.arcHint);
  const hardMaxTasks = maxTasks * 2;
  const defaults = { ...(opts.base !== undefined ? { base: opts.base } : {}), ...(opts.autoMerge !== undefined ? { autoMerge: opts.autoMerge } : {}) };
  const single: SelfDevGoal = { id: '0', feature, ...defaults };

  if (opts.decomposer === 'fabric') {
    if (!opts.fabric) {
      observeDecomposerSelection('fabric-rejected', opts.observation);
      throw new FabricDecompositionRejectedError({ status: 'missing-research-context', message: 'explicit fabric decomposition requires fabric context and resolver' });
    }
    const decompose = opts.fabric.decompose ?? (async (request, context, resolve) => {
      const { decomposeSelfDevGoalWithFabric } = await import('./fabric-decompose-adapter.js');
      return decomposeSelfDevGoalWithFabric({ context: { ...context, goal: request }, resolve });
    });
    const result = await decompose(feature, opts.fabric.context, opts.fabric.resolve);
    if (result.status !== 'decomposed') {
      observeDecomposerSelection('fabric-rejected', opts.observation);
      throw new FabricDecompositionRejectedError(result);
    }
    observeDecomposerSelection('fabric', opts.observation);
    const actualTaskCount = result.goals.length;
    const prepared = actualTaskCount > 0
      ? applyGoalDefaultsAndHotPaths(result.goals.slice(0, hardMaxTasks), defaults)
      : [single];
    const goals = foldRegistrationOnlyGoals(prepared);
    return finalizeDecomposition(feature, pruneDanglingDependencies(goals), {
      recommendedMaxTasks: maxTasks,
      actualTaskCount,
      truncatedAtHardMax: actualTaskCount > hardMaxTasks,
      exceededRecommendedMax: actualTaskCount > maxTasks,
      outcome: actualTaskCount === 0 ? 'single-no-subtasks' : 'decomposed',
      omittedGoalCount: result.omittedGoalCount,
    }, opts, actualTaskCount > 0 ? arcHint : undefined, prepared.length - goals.length);
  }

  observeDecomposerSelection('default', opts.observation);
  let raw: string;
  try {
    const llm = opts.llm ?? (await defaultDecomposeLlm(opts.model));
    raw = await llm(buildSelfDevDecomposePrompt(feature, maxTasks));
  } catch (error) {
    return observeDecomposition([single], { recommendedMaxTasks: maxTasks, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'llm-failed', error: String((error as { message?: unknown })?.message ?? error) }, undefined, opts.observation);
  }
  const rawSubtasks = extractRawSubtasks(raw);
  const actualTaskCount = rawSubtasks.length;
  const decomposition: SelfDevDecompositionMeta = { recommendedMaxTasks: maxTasks, actualTaskCount, truncatedAtHardMax: actualTaskCount > hardMaxTasks, exceededRecommendedMax: actualTaskCount > maxTasks, outcome: actualTaskCount === 0 ? 'single-no-subtasks' : 'decomposed' };
  const validated = parseValidatedSelfDevDecomposition(rawSubtasks.slice(0, hardMaxTasks), defaults);
  for (const rejection of validated.rejected) {
    debug.log(opts.observation?.category ?? 'self-dev.decompose', 'decompose.slice-rejected', {
      ...observationIdentity(opts.observation ?? {}),
      sliceId: rejection.id,
      reasons: rejection.reasons,
    }, { level: 'warn' });
  }
  const parsedGoals = validated.goals;
  const foldedGoals = foldRegistrationOnlyGoals(parsedGoals);
  const goals = parsedGoals.length > 0 ? pruneDanglingDependencies(foldedGoals) : [single];
  const finalDecomposition = parsedGoals.length === 0 && validated.rejected.length > 0
    ? { ...decomposition, outcome: 'slice-rejected' as const }
    : decomposition;
  return finalizeDecomposition(feature, goals, finalDecomposition, opts, parsedGoals.length > 0 ? arcHint : undefined, parsedGoals.length - foldedGoals.length);
}

/** Where the decompose model came from — `'explicit'` is the caller's `model` argument layer. */
export type DecomposeModelSource = 'explicit' | ModelResolutionSource;

export interface DecomposeModelResolution {
  model: string;
  source: DecomposeModelSource;
}

export interface DecomposeModelDeps {
  /** Config handed to the planning-role default; omitted uses the user config. */
  config?: UserConfig;
}

/**
 * ROLE-RELAY-SPLIT — the decompose model selector (pure).
 *
 * An explicit `model` argument wins; the default is the existing planning-role
 * resolver `resolveRoleModel('planning')` (env `ELANOUS_SKILL_PLAN_MODEL` ·
 * `roleLlm.planning` · tier `best` — the same tier the old default used), NOT
 * the review env `ELANOUS_PR_REVIEW_MODEL`: changing the review model must
 * not drag the decompose model along.
 */
export function decomposeModel(explicit?: string, deps: DecomposeModelDeps = {}): DecomposeModelResolution {
  const pinned = explicit?.trim();
  if (pinned) return { model: pinned, source: 'explicit' };
  const resolved = resolveRoleModel('planning', deps.config);
  return { model: resolved.model, source: resolved.source };
}

/** Default LLM seam — lazy `streamLLM` wire (kept out of the test path). */
async function defaultDecomposeLlm(model?: string): Promise<SelfDevDecomposeLlm> {
  const { streamLLM } = await import('../llm.js');
  const { model: resolved, source } = decomposeModel(model);
  debug.log('self-dev.decompose', 'model', { model: resolved, source });
  return (prompt: string) => streamLLM([{ role: 'user', content: prompt }], () => {}, { model: resolved, reasoningEffort: 'low' });
}
