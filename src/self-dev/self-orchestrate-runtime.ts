// SelfOrchestrate 네이티브 툴 런타임 (D · front door · 2026-07-21) — elanous 가 자연어("이것들 병렬로
// 구현해줘")를 인식해 **병렬 self-dev 오케스트레이터**(orchestrateSelfDev)를 자율 호출하는 ToolRuntime.
//
// 재발명0: 단일 SelfImplement 툴(self-implement-runtime)의 패턴을 그대로 이식 — 다른 건 코어가
// runSelfImplement(단일) 대신 orchestrateSelfDev(N 병렬)이라는 점뿐. 세포 role: 이 프로세스가
// coordinator, 각 goal 은 격리 worktree executor 서브프로세스(defaultSelfImplementSpawn 이 role=executor 주입).
//
// ★ 안전 기본값(fail-closed·SelfImplement 동형) — 기본은 **worktree-only**(auto-merge/PR 없음·검토 후 승격).
//   auto_merge=true 명시일 때만 리뷰 clean goal 을 main 에 병합(outward-facing·opt-in). 자율 트리거 표면이
//   커지므로(TUI/스킬) 안전 기본이 핵심. 진행표시(board)+막 릴레이는 후속(PLAN-harness-cell-roles D).

import { posix as posixPath } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from '../tool-runtime/types.js';
import { orchestrateSelfDev, type SelfDevJobResult, type OrchestrateSelfDevOptions, type SelfDevGoal } from './orchestrate.js';
import { processBirthId, type SelfDevRunParticipant, type SelfDevRunState } from './run-store.js';
import { HARNESS_RUN_ID_ENV, resolveRunIdentity as defaultResolveRunIdentity } from '../harness/harness-space.js';
import { decomposeSelfDevGoal, type SelfDevDecomposition, type SelfDevDecomposeOptions } from './decompose.js';
import { decomposeFabricRequest, type FabricDecomposeRequestOptions, type FabricDecomposeRequestResult } from './fabric-decompose-adapter.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { resolveObserveOnlyDecision } from '../self-implement/observe-only.js';
import { inspectArtifactLaunchDeclaration, writeAuthoredGoal } from '../self-implement/goal-author.js';
import { classifyReviewProviderFailure } from './review-provider-fallback.js';

// ── test seam — 실 서브프로세스 spawn 없이 코어를 주입(격리 테스트). null = 실 구현. ──
/** ⛔ supervise 는 엔진 옵션이 «아니라» 중앙 심의 스위치다 — 그래서 엔진 타입에 안 넣고 여기서 얹는다. */
type OrchestrateFn = (
  opts: OrchestrateSelfDevOptions & {
    supervise?: { rounds?: number; stallRounds?: number };
    deliverable?: { readonly document: string; readonly attribution: 'all' | 'last'; readonly goalPath?: string };
  },
) => Promise<SelfDevJobResult[]>;
type OrchestrateCliCommand = typeof import('./orchestrate-cli.js').runSelfOrchestrateCliCommand;
type DecomposeFn = (feature: string, options?: SelfDevDecomposeOptions) => Promise<SelfDevDecomposition>;
type FabricDecomposeFn = (feature: string, options?: FabricDecomposeRequestOptions) => Promise<FabricDecomposeRequestResult>;
type GoalAuthorFn = typeof writeAuthoredGoal;
/**
 * ⭐⭐⭐ NL 도 «중앙 관통 라인»을 탄다 (2026-08-19 · P0).
 *
 * ⛔ **종전엔 `orchestrateSelfDev` 를 «직접» 불러 `runDevPipeline` 을 «우회»했다.**
 *   그 우회의 대가는 「엔진을 못 탄다」가 아니다 — 엔진은 같다. 잃는 것은 ***그 라인 위에 놓인 것들***이다:
 *     · `completion`·`autoReview` 결정 (dev-pipeline 이 그 두 축의 «유일한 결정 자리»다)
 *     · 런 슈퍼바이저 스위치 (「끝까지 돌린다」)
 *     · 그 라인이 앞으로 얻을 «모든» 통제
 *   📏 같은 병이 데몬/ACP 입구에도 있다(RFC-one-door-many-entrances §2 2판 — autoMerge·autoReview 를
 *     «아예 안 넘긴다»). ⇒ 이 교체는 그 병의 «첫 치료»다.
 *
 * ⭐ 대표 2026-08-06: *"입구를 단일화해야 합니다 … 계속 스캐터드 된 상황으로 나아가고 있는 것 같습니다"*
 *   ⇒ 입구를 «줄이는» 게 아니라 ***입구 뒤를 통합***한다(RFC §3). 이 함수가 그 이음매다.
 *
 * ⚠️ 아직 안 준 것: `runtime`(체크포인트·onEvent)을 비워 둔다 ⇒ **NL 로 띄운 연합 런은 재개할 수 없다.**
 *   ⛔ 이것을 「없는 셈」 치지 않고 이름으로 남긴다 — 다음 칸이다.
 */
let orchestrateCliCommand: OrchestrateCliCommand | undefined;

const centralOrchestrate: OrchestrateFn = async (opts) => {
  const runSelfOrchestrateCliCommand = orchestrateCliCommand
    ?? (await import('./orchestrate-cli.js')).runSelfOrchestrateCliCommand;
  const { supervise, deliverable, stopAfterFailure, onStopAfterFailure, ...engineOpts } = opts;
  const outcome = await runSelfOrchestrateCliCommand({
    goals: engineOpts.goals as never[],
    ...(engineOpts.concurrency === undefined ? {} : { concurrency: engineOpts.concurrency }),
    ...(engineOpts.parentRequest === undefined ? {} : { parentRequest: engineOpts.parentRequest }),
    ...(deliverable === undefined ? {} : { deliverable }),
    runtime: {
      ...(stopAfterFailure === undefined ? {} : { stopAfterFailure }),
      ...(onStopAfterFailure === undefined ? {} : { onStopAfterFailure }),
    },
    ...(supervise ? { supervise } : {}),
  });
  // ⛔ 실패를 «빈 배열»로 삼키지 않는다 — 호출부가 「0개 성공」과 구별할 수 없게 된다.
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.results;
};

let orchestrateFn: OrchestrateFn = centralOrchestrate;
let decomposeFn: DecomposeFn = decomposeSelfDevGoal;
let fabricDecomposeFn: FabricDecomposeFn = decomposeFabricRequest;
let goalAuthor: GoalAuthorFn = writeAuthoredGoal;

export function _setGoalAuthorForTesting(author: GoalAuthorFn | null): void {
  goalAuthor = author ?? writeAuthoredGoal;
}
type FabricDecomposeConfig = {
  enabled: boolean;
  autoPathThreshold: number | null;
};
type FabricDecomposeConfigReader = () => FabricDecomposeConfig;

function readUserFabricDecomposeConfig(): FabricDecomposeConfig {
  const config = getUserConfig().tools?.selfImplement;
  return {
    enabled: config?.fabricDecompose === true,
    autoPathThreshold: config?.fabricDecomposeAutoPathThreshold ?? null,
  };
}

let fabricDecomposeConfigReader: FabricDecomposeConfigReader = readUserFabricDecomposeConfig;

export function readFabricDecomposeConfig(): FabricDecomposeConfig {
  return fabricDecomposeConfigReader();
}

/** ⛔ CLI(`self orchestrate --fabric-decompose`)도 «같은» 변환을 쓴다 — 재발명 0. */
export function fabricResultToDecomposition(result: FabricDecomposeRequestResult): SelfDevDecomposition {
  switch (result.status) {
    case 'decomposed':
      return {
        goals: result.goals,
        decomposition: { recommendedMaxTasks: result.goals.length, actualTaskCount: result.goals.length, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: result.goals.length === 0 ? 'single-no-subtasks' : 'decomposed' },
      };
    case 'missing-research-context':
    case 'grounding-empty':
    case 'authored-empty':
      return {
        goals: [],
        decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: result.status },
      };
    case 'grounding-failed':
    case 'author-failed':
      return {
        goals: [],
        decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'llm-failed', error: result.message },
      };
  }
}

export type FabricDecompositionOutcome = {
  status: FabricDecomposeRequestResult['status'];
  outcome: SelfDevDecomposition['decomposition']['outcome'];
  omittedGoalCount?: number;
  /** 예산(전체 조각 상한) 때문에 분해를 건너뛴 아크 수. 0 도 싣는다 — 없으면 「안 걸렸다」와 「이 경로가 안 낸다」가 같은 값이 된다. */
  budgetSkippedArcCount?: number;
  /** 그 예산이 실제로 결과를 제한했나. */
  budgetLimited?: boolean;
  message?: string;
};

function fabricDecompositionOutcome(result: FabricDecomposeRequestResult): FabricDecompositionOutcome {
  const decomposition = fabricResultToDecomposition(result);
  return {
    status: result.status,
    outcome: decomposition.decomposition.outcome,
    ...(result.status === 'decomposed'
      ? {
        omittedGoalCount: result.omittedGoalCount,
        budgetSkippedArcCount: result.budgetSkippedArcCount,
        budgetLimited: result.budgetLimited,
      }
      : { message: result.status === 'authored-empty' ? 'fabric RFC authored no arcs' : result.message }),
  };
}

function observeFabricDecomposition(outcome: FabricDecompositionOutcome, surface: string, goals?: number): void {
  debug.log('self-dev.orchestrate', 'runtime.fabric-decomposition', {
    surface,
    ...outcome,
    ...(goals === undefined ? {} : { goals }),
  }, outcome.outcome === 'llm-failed' ? { level: 'warn' } : undefined);
}

type FabricDecomposeSource = 'request' | 'config' | 'path-threshold' | 'default' | 'post-threshold';
type FabricDecomposerSelectionSource = Exclude<FabricDecomposeSource, 'post-threshold'>;

type FabricDecomposerSelection = {
  decomposer: 'fabric' | 'default';
  source: FabricDecomposerSelectionSource;
};

/**
 * Trust an explicit array of normalized repository-relative paths. The caller
 * must supply paths; this function never infers them from natural-language goals.
 */
export function normalizeTargetPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    const path = posixPath.normalize(entry);
    if (posixPath.isAbsolute(path) || path === '..' || path.startsWith('../')) return undefined;
    paths.add(path);
  }
  return [...paths];
}

export function selectFabricDecomposer(
  requestFabricDecompose: unknown,
  config: FabricDecomposeConfig,
  normalizedPathCount: number | undefined,
): FabricDecomposerSelection {
  if (typeof requestFabricDecompose === 'boolean') {
    return { decomposer: requestFabricDecompose ? 'fabric' : 'default', source: 'request' };
  }
  if (config.enabled) return { decomposer: 'fabric', source: 'config' };
  if (normalizedPathCount !== undefined
    && Number.isInteger(normalizedPathCount)
    && normalizedPathCount >= 0
    && config.autoPathThreshold !== null
    && normalizedPathCount >= config.autoPathThreshold) {
    return { decomposer: 'fabric', source: 'path-threshold' };
  }
  return { decomposer: 'default', source: 'default' };
}

export function observeDecomposerSelection(
  decomposer: 'fabric' | 'default',
  source: FabricDecomposeSource,
  surface: string,
  normalizedPathCount: number | undefined,
  autoPathThreshold: number | null,
): void {
  debug.log('self-dev.orchestrate', 'runtime.decomposer-selection', {
    surface,
    decomposer,
    source,
    normalizedPathCount,
    autoPathThreshold,
  });
}

/** CLI(`self orchestrate` · `harness orchestrate`)가 분해기 플래그만 주고 분해를 안 켰을 때 내는 문장. */
export const FABRIC_DECOMPOSE_REQUIRES_DECOMPOSE_ERROR =
  '--fabric-decompose 는 --decompose 와 «함께» 쓴다 (분해를 켜야 어느 분해기를 쓸지가 의미를 갖는다)';

/** ask 머리의 `대상 경로:` 라벨이 «몇 갈래»를 대는지 센다.
 *
 *  🩸 2026-09-08: 이 수가 «없어서»(하드코딩 `undefined`) 패브릭 자동 경로가 구조적으로 죽어 있었다.
 *  ⛔ 못 세면 `undefined` 다 — ***0 이 아니다***. 「경로가 없다」와 「안 셌다」는 다른 값이고,
 *    0 으로 내면 임계 비교가 «조용히» 거짓이 된다.
 *  📌 구분자는 저작 규약과 같다(`·`). ⚠️ 이 규약이 바뀌면 이 함수도 같이 바뀐다. */
export function countAskTargetPaths(request: string): number | undefined {
  const line = request.split('\n').find((l) => /^\s*-?\s*(대상 경로|target paths)\s*:/i.test(l));
  if (line === undefined) return undefined;
  const body = line.slice(line.indexOf(':') + 1);
  const parts = body.split('\u00b7').map((p) => p.replace(/`/g, '').trim()).filter((p) => p.length > 0);
  return parts.length === 0 ? undefined : parts.length;
}

export type OrchestrateDecomposePrepareInput = {
  request: string;
  goals: SelfDevGoal[];
  decompose?: boolean;
  fabricDecompose?: boolean;
  maxTasks?: string | number;
  base?: string;
  autoMerge?: boolean;
  openPr?: boolean;
  autoReview?: boolean;
  onInfo?: (message: string) => void;
};

export type OrchestrateDecomposePrepareArgsInput<
  TGoal extends SelfDevGoal = SelfDevGoal,
  TMaxTasks extends string | number = string | number,
> = {
  request: string;
  goals: TGoal[];
  decompose?: boolean;
  fabricDecompose?: boolean;
  maxTasks?: TMaxTasks;
  base?: string;
  autoMerge?: boolean;
  openPr?: boolean;
  autoReview?: boolean;
  json?: boolean;
  onInfo?: (message: string) => void;
};

export type OrchestrateDecomposePrepareArgs<
  TGoal extends SelfDevGoal = SelfDevGoal,
  TMaxTasks extends string | number = string | number,
> = {
  request: string;
  goals: TGoal[];
  decompose?: boolean;
  fabricDecompose?: boolean;
  maxTasks?: TMaxTasks;
  base?: string;
  autoMerge?: boolean;
  openPr?: boolean;
  autoReview?: boolean;
  onInfo?: (message: string) => void;
};

export type OrchestrateDecomposePrepareResult =
  | { ok: true; goals: SelfDevGoal[] }
  | { ok: false; error: string; exitCode: number };

interface OrchestrateRunLedgerDeps {
  readonly saveRun: (state: SelfDevRunState) => void;
  readonly addParticipant: (runId: string, participant: SelfDevRunParticipant) => void;
  readonly checkpointDependencies: (
    prior: Pick<SelfDevRunState, 'dependencies'> | null,
    goals: readonly SelfDevGoal[],
  ) => Record<string, string[]> | undefined;
}

interface OrchestrateRunLedgerInput {
  readonly runId: string;
  readonly createdAt: number;
  readonly prior: Pick<SelfDevRunState, 'dependencies' | 'results'> | null;
  readonly goals: readonly SelfDevGoal[];
  readonly pid: number;
  readonly seat?: SelfDevRunState['seat'];
  readonly runIdSource: SelfDevRunParticipant['runIdSource'];
  readonly now: () => number;
  readonly onPersistenceFailure?: (stage: 'checkpoint' | 'participant', error: unknown) => void;
}

interface OrchestrateRunLedgerBinding {
  readonly checkpoint: (results: SelfDevRunState['results']) => void;
}

interface OrchestrateCheckpointRestoreInput {
  readonly resume?: string | null;
  readonly goals: SelfDevGoal[];
  readonly loadRun: (runId: string) => SelfDevRunState | null | undefined;
  readonly json?: boolean;
  readonly onInfo?: (message: string) => void;
}

interface OrchestrateCheckpointRestoreResult {
  readonly prior: SelfDevRunState | null;
  readonly goals: SelfDevGoal[];
}

type OrchestrateRunIdentityResolver = (input: { explicit?: string; inherited?: string }) => { runId: string; source: SelfDevRunParticipant['runIdSource'] };
type OrchestrateResumeDisposition = 'skip' | 'rerun' | 'rerun-duplicate-risk';
type OrchestrateResumeDispositionClassifier<T> = (result: T) => OrchestrateResumeDisposition;

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 `;;` goal 분리 규칙. */
export function splitOrchestrateGoalTexts(parts: readonly string[]): string[] {
  const joined = parts.join(' ');
  return (joined.includes(';;') ? joined.split(';;') : parts).map((goal) => goal.trim()).filter(Boolean);
}

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 `;;` 요청 문자열 결합 규칙. */
export function normalizeOrchestrateRequest(input: readonly string[] | string): string {
  const joined = typeof input === 'string' ? input : input.join(' ');
  return joined.replace(/;;/g, ' ').trim();
}

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 분해 준비 인자 조립 규칙. */
export function buildOrchestrateDecomposePrepareArgs<
  TGoal extends SelfDevGoal,
  TMaxTasks extends string | number = string | number,
>(input: OrchestrateDecomposePrepareArgsInput<TGoal, TMaxTasks>): OrchestrateDecomposePrepareArgs<TGoal, TMaxTasks> {
  return {
    request: input.request,
    goals: input.goals,
    ...(input.decompose ? { decompose: true } : {}),
    ...(input.fabricDecompose ? { fabricDecompose: true } : {}),
    ...(input.maxTasks ? { maxTasks: input.maxTasks } : {}),
    ...(input.base ? { base: input.base } : {}),
    ...(input.autoMerge ? { autoMerge: true } : {}),
    ...(input.openPr ? { openPr: true } : {}),
    ...(input.autoReview ? { autoReview: true } : {}),
    ...(input.json ? {} : input.onInfo ? { onInfo: input.onInfo } : {}),
  };
}

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 재개 skip 수 집계. 판정은 호출부가 주입한 classifyResumeDisposition 만 쓴다. */
export function countOrchestrateResumeSkips<T>(
  results: readonly T[],
  classifyResumeDisposition: OrchestrateResumeDispositionClassifier<T>,
): number {
  return results.filter((result) => classifyResumeDisposition(result) === 'skip').length;
}

interface OrchestrateRunIdentityInput {
  readonly resume?: string | null;
  readonly prior: Pick<SelfDevRunState, 'createdAt'> | null;
  readonly json?: boolean;
  readonly resolveRunIdentity?: OrchestrateRunIdentityResolver;
  readonly harnessRunIdEnv?: string;
  readonly getEnv?: (key: string) => string | undefined;
  readonly setEnv?: (key: string, value: string) => void;
  readonly now: () => number;
  readonly onInfo?: (message: string) => void;
}

interface OrchestrateRunIdentityBinding {
  readonly runId: string;
  readonly runIdSource: SelfDevRunParticipant['runIdSource'];
  readonly createdAt: number;
}

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 run identity 해석·env 기록·createdAt 결정. */
export function resolveOrchestrateRunIdentity(input: OrchestrateRunIdentityInput): OrchestrateRunIdentityBinding {
  if (input.resume && !input.prior && !input.json) input.onInfo?.(`[self-dev] ⚠️ resume run '${input.resume}' 없음 — 전체 신규 실행`);
  const harnessRunIdEnv = input.harnessRunIdEnv ?? HARNESS_RUN_ID_ENV;
  const resolveRunIdentity = input.resolveRunIdentity ?? defaultResolveRunIdentity;
  const { runId, source: runIdSource } = resolveRunIdentity({
    explicit: input.resume ?? undefined,
    inherited: input.getEnv ? input.getEnv(harnessRunIdEnv) : process.env[harnessRunIdEnv],
  });
  if (input.setEnv) input.setEnv(harnessRunIdEnv, runId);
  else process.env[harnessRunIdEnv] = runId;
  return { runId, runIdSource, createdAt: input.prior?.createdAt ?? input.now() };
}

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 체크포인트 goal 원형 복원 판단. */
export function restoreOrchestrateCheckpointGoals(
  input: OrchestrateCheckpointRestoreInput,
): OrchestrateCheckpointRestoreResult {
  const prior = input.resume ? input.loadRun(input.resume) ?? null : null;
  if (prior?.goals?.length) {
    const goals = prior.goals;
    if (!input.json) input.onInfo?.(`[self-dev] 재개 — 체크포인트의 goal 원형 ${goals.length}개 복원(의존성 ${goals.filter((g) => g.dependsOn?.length).length}건)`);
    return { prior, goals };
  }
  if (input.resume && prior && !input.json) {
    input.onInfo?.('[self-dev] ⚠️ 이 체크포인트엔 goal 원형이 없다(옛 판) — 인자 goals 를 쓴다. 의존성은 복원되지 않는다');
  }
  return { prior, goals: input.goals };
}

/** `harness orchestrate` 와 `self orchestrate` 가 공유하는 run-store 원장 기록 조립. */
export function bindOrchestrateRunLedger(
  deps: OrchestrateRunLedgerDeps,
  input: OrchestrateRunLedgerInput,
): OrchestrateRunLedgerBinding {
  const dependencies = deps.checkpointDependencies(input.prior, input.goals);
  const pidStart = processBirthId(input.pid);
  const checkpoint = (results: SelfDevRunState['results']): void => {
    try {
      deps.saveRun({
        runId: input.runId,
        createdAt: input.createdAt,
        updatedAt: input.now(),
        results,
        dependencies,
        goals: [...input.goals],
        pid: input.pid,
        ...(pidStart ? { pidStart } : {}),
        ...(input.seat ? { seat: input.seat } : {}),
      });
    } catch (error) {
      if (input.onPersistenceFailure) input.onPersistenceFailure('checkpoint', error);
      else throw error;
    }
  };

  checkpoint(input.prior?.results ?? []);
  try {
    deps.addParticipant(input.runId, {
      id: `process:${input.pid}`,
      kind: 'process',
      transports: [],
      registeredAt: input.now(),
      runIdSource: input.runIdSource,
    });
  } catch (error) {
    if (input.onPersistenceFailure) input.onPersistenceFailure('participant', error);
    else throw error;
  }

  return { checkpoint };
}

/**
 * `harness orchestrate` 와 `self orchestrate` 가 공유하는 분해 전처리.
 * 분해 활성 검사 · 분해기 선택/관측 · maxTasks 정규화 · 실행 · goal 후처리를 한 곳에서 한다.
 */
export async function prepareOrchestrateDecomposeGoals(
  input: OrchestrateDecomposePrepareInput,
): Promise<OrchestrateDecomposePrepareResult> {
  if (input.fabricDecompose && !input.decompose) {
    return { ok: false, error: FABRIC_DECOMPOSE_REQUIRES_DECOMPOSE_ERROR, exitCode: 2 };
  }
  if (!input.decompose) {
    return { ok: true, goals: input.goals };
  }

  // ⭐ 대표 지시(2026-09-08) — 「큰 미션은 패브릭으로 분해했어야」의 실측 수리.
  //   🩸 이 줄은 ***`undefined` 로 «못 박혀»*** 있었다 ⇒ `selectFabricDecomposer` 의 자동 경로
  //     분기가 ***구조적으로 죽어*** 있었다.
  //     📏 원장 30일 실측: decomposer-selection 128건 전부 ('default','default') 이고
  //        `normalizedPathCount` 는 ***128/128 이 None*** — 임계는 살아 있는데 «비교가 성립한 적이 없다».
  //   ⛔ 「채우면 패브릭이 돈다」가 «아니다» — 같은 날 실측: 대상 경로가 있는 골 51건 중 ***≥5 는 0건***
  //     (최대 4). ⇒ 이 수리는 ***「값을 실어 다음 물음을 «잴 수 있게»」***까지다.
  //   ⛔ 그래서 임계(5)를 «여기서 안 내린다» — 그것은 자를 결과에 맞추는 짓이다.
  const normalizedPathCount = countAskTargetPaths(input.request);
  const fabricDecomposeConfig = fabricDecomposeConfigReader();
  const selection = selectFabricDecomposer(input.fabricDecompose, fabricDecomposeConfig, normalizedPathCount);
  input.onInfo?.(`[self-dev] goal 분해 중 (${selection.decomposer === 'fabric' ? 'Fabric grounding/RFC' : 'LLM'})…`);
  observeDecomposerSelection(selection.decomposer, selection.source, 'cli', normalizedPathCount, fabricDecomposeConfig.autoPathThreshold);
  const decomposeOpts: SelfDevDecomposeOptions = {
    ...(input.maxTasks ? { maxTasks: Math.max(1, Number(input.maxTasks) || 6) } : {}),
    ...(input.base ? { base: input.base } : {}),
    ...(input.autoMerge ? { autoMerge: true } : {}),
  };

  let goals: SelfDevGoal[];
  if (selection.decomposer === 'fabric') {
    if (input.maxTasks) {
      input.onInfo?.(`[self-dev] --max-tasks ${decomposeOpts.maxTasks} 는 fabric 경로 전체 조각 수 상한이다`);
    }
    const fabricResult = await fabricDecomposeFn(input.request, { decomposeOptions: decomposeOpts });
    if (fabricResult.status !== 'decomposed') {
      return {
        ok: false,
        error: `[self-dev] fabric 분해가 goal 을 못 냈다: status=${fabricResult.status}${'message' in fabricResult && fabricResult.message ? ` — ${fabricResult.message}` : ''}`,
        exitCode: 1,
      };
    }
    goals = fabricResultToDecomposition(fabricResult).goals;
  } else {
    goals = (await decomposeFn(input.request, decomposeOpts)).goals;
  }
  if (input.openPr) goals = goals.map((goal) => ({ ...goal, openPr: true }));
  if (input.autoReview) goals = goals.map((goal) => ({ ...goal, autoReview: true }));
  input.onInfo?.(`[self-dev] ${goals.length} 서브-goal · 의존성 ${goals.filter((goal) => goal.dependsOn?.length).length}건`);
  return { ok: true, goals };
}

function formatFabricDecompositionOutcome(outcome: FabricDecompositionOutcome): string {
  return `[self-orchestrate] Fabric decomposition ${outcome.status} (${outcome.outcome})${outcome.message ? ` — ${outcome.message}` : ''}`;
}
/** 테스트 헬퍼 — orchestrate 코어를 fake 로 대체(실 worktree/PR 무접촉). null = 실 코어. */
export function _setOrchestrateForTesting(f: OrchestrateFn | null): void {
  // ⛔ 심 «해제»도 중앙 심으로 돌아가야 한다 — 옛 기본값으로 되돌리면 우회가 조용히 살아난다.
  orchestrateFn = f ?? centralOrchestrate;
}
/** 테스트 seam — 중앙 CLI 소비자를 대체한다. undefined = 실 중앙 소비자. */
export function _setOrchestrateCliCommandForTesting(f?: OrchestrateCliCommand): void {
  orchestrateCliCommand = f;
}
/** 테스트 헬퍼 — 분해기를 fake 로 대체(실 LLM 무접촉). null = 실 분해기. */
export function _setDecomposeForTesting(f: DecomposeFn | null): void {
  decomposeFn = f ?? decomposeSelfDevGoal;
}
/** 테스트 seam — 명시적 Fabric 분해 경로를 fake로 대체한다. null = 실 decomposeFabricRequest. */
export function _setFabricDecomposeForTesting(f: FabricDecomposeFn | null): void {
  fabricDecomposeFn = f ?? decomposeFabricRequest;
}

/** 테스트 seam — 설정 snapshot을 fake로 대체한다. undefined = 실 user config. */
export function _setFabricDecomposeConfigReaderForTesting(reader?: FabricDecomposeConfigReader): void {
  fabricDecomposeConfigReader = reader ?? readUserFabricDecomposeConfig;
}

/** `SelfOrchestrate` 를 «모델 표면»에 올릴까 — 기본 off.
 *
 *  ⛔⭐⭐ **흡수가 이미 끝났다**(대표 결정 2026-08-20 · RFC-one-door-many-entrances P5):
 *  `SelfImplement` 가 `goals[]`·`concurrency`·`decompose`·`auto_merge` 를 전부 받고,
 *  그 인자가 있으면 ***이 툴과 «같은 함수»***(`runSelfOrchestrateCliCommand`)로 간다.
 *  ⇒ 🔑 두 문이 같은 곳으로 가므로 둘째 문은 «능력»이 아니라 ***파편화***다.
 *
 *  ⛔ 이것은 「덜 쓰니까 내린다」가 «아니다» — 호출 수와 «무관한» 결정이다(대표).
 *  ⚠️ CLI(`elanous self orchestrate`)는 «남는다» — 모델 표면만 내린다(RunDevHarness 선례와 동형).
 *  🩹 되돌리려면 `tools.selfOrchestrate.modelSurface = true`. */
export function isSelfOrchestrateModelSurfaceEnabled(): boolean {
  // ⛔ 동적 require 를 쓰지 «않는다» — 이 파일은 ESM 이고 getUserConfig 는 «이미 import» 돼 있다.
  //   선례(dev-harness.ts)가 require 를 쓰지만 그것을 그대로 베끼면 ESM 실행에서 깨진다(리뷰 #10602).
  const configured = getUserConfig().tools.selfOrchestrate.modelSurface;
  const enabled = configured === true;
  debug.log('tools.surface', 'self-orchestrate-exposure', {
    enabled,
    source: configured === undefined ? 'default' : 'config',
  });
  return enabled;
}

export function buildSelfOrchestrateSpec(): LLMToolSpec {
  return {
    name: 'SelfOrchestrate',
    description:
      'Autonomously develop MULTIPLE features/fixes IN PARALLEL — each goal runs as its own isolated ' +
      'git-worktree self-implement subprocess (coordinator↔executor cell roles), concurrency-capped. ' +
      'Per goal: headless coding agent + integrity gate + internal review. By DEFAULT worktree-only ' +
      '(no PR/merge) so you can inspect before promoting. Set auto_merge=true to merge review-clean ' +
      'goals to main (outward-facing — explicit opt-in). Use when the user wants several things built ' +
      'at once OR one composite request whose work has a sequence/dependency (e.g. "이것들 병렬로 구현해줘", ' +
      '"먼저 조사하고 그 결과로 구현한 다음 점검 명세를 만들어줘", "이 목록 다 만들어줘"). ' +
      'Long-running (minutes). For a SINGLE feature use SelfImplement instead.',
    parameters: {
      type: 'object',
      properties: {
        goals: {
          type: 'array',
          items: { type: 'string' },
          description: 'decompose=true이면 순서·의존 관계를 가진 복합 사용자 원문 요청 하나를 그대로 넣는다(분해기가 서브-DAG로 나눈다). false이면 이미 분리한 독립 기능/수정 항목들을 넣는 goal 목록이며, 각 항목은 각각 격리 worktree self-implement로 실행한다.',
        },
        auto_merge: {
          type: 'boolean',
          description: '리뷰 clean 시 자동 병합(main·outward-facing). 기본 false = worktree 만(검토 후 수동 승격·안전).',
        },
        concurrency: {
          type: 'number',
          description: '동시 실행 잡 수(선택·기본 2).',
        },
        deliverable: {
          type: 'object',
          properties: {
            document: { type: 'string' },
            attribution: { enum: ['all', 'last'] },
          },
          required: ['document', 'attribution'],
          additionalProperties: false,
          description: '연합 런 산출물 선언 문서와 귀속 범위.',
        },
        decompose: {
          type: 'boolean',
          description: 'CLI --decompose와 동일: 서로 성격이 다른 일이 순서·의존 관계를 가진 하나의 원문 요청이면, 모델이 미리 쪼개지 말고 원문 하나를 goals로 넘겨 true로 켜서 의존성·hot-path 서브-DAG로 분해한 뒤 실행한다. 사용자가 이미 나열한 서로 독립인 목록이면 각 항목을 goals 배열로 넘기고 false로 둔다. 기본 false.',
        },
        fabric_decompose: {
          type: 'boolean',
          description: 'decompose=true일 때만 Fabric grounding/RFC 어댑터를 명시적으로 사용한다. 기본 false는 기존 분해기를 보존한다.',
        },
        target_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'decompose=true 복합 요청의 정규화된 저장소 상대 대상 파일 경로. Fabric 자동 선택은 이 목록의 고유 경로 수만 사용하며, 자연어 goals 항목을 경로로 추정하지 않는다.',
        },
        supervise: {
          type: 'boolean',
          description: '런이 끝나면 실패를 트리아지해서 다시 걸 수 있는 조각이 있으면 스스로 재개한다(끝까지 돌린다). 착지가 늘지도 남은 일이 줄지도 않으면 스스로 멈춘다. 기본 false.',
        },
        supervise_rounds: {
          type: 'number',
          description: 'supervise=true일 때 재개 라운드 상한(선택·기본 3).',
        },
      },
      required: ['goals'],
      additionalProperties: false,
    },
  };
}

function isDeliverableRequest(value: unknown): value is { readonly document: string; readonly attribution: 'all' | 'last' } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.document === 'string'
    && (candidate.attribution === 'all' || candidate.attribution === 'last');
}

function stoppedChildSummary(result: SelfDevJobResult): string {
  return [result.error?.message, result.screenTail].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
}

function formatResults(results: SelfDevJobResult[]): string {
  const done = results.filter((r) => r.status === 'done');
  const merged = done.filter((r) => r.merged);
  const failed = results.filter((r) => r.status === 'failed');
  const lines: string[] = [
    `[self-orchestrate] ${results.length} goal · done ${done.length}${merged.length ? ` (병합 ${merged.length})` : ''}${failed.length ? ` · 실패 ${failed.length}` : ''}`,
  ];
  for (const r of results) {
    const head = `  ${r.status === 'done' ? (r.merged ? '✅ merged' : '✅ done') : r.status === 'failed' ? '❌ failed' : `· ${r.status}`}`;
    const tail = r.prUrl ? ` — ${r.prUrl}` : r.worktreePath ? ` — ${r.worktreePath}` : r.error ? ` — ${r.error.code}` : '';
    lines.push(`${head}: ${r.feature.slice(0, 60)}${tail}`);
  }
  if (failed.length) lines.push('실패/막힌 goal 은 `elanous self parked` 로 정황(화면 outcome 포함)·`repair-signals` 로 수리 신호 확인.');
  return lines.join('\n');
}

export interface SelfOrchestrateRunResult {
  output: string;
  ok: boolean;
  total: number;
  done: number;
  merged: number;
  failed: number;
  /** 명시적 Fabric 분해의 상태·기존 3결말·미산출 사유. */
  fabricDecomposition?: FabricDecompositionOutcome;
}

export const selfOrchestrateRuntime: ToolRuntime<Record<string, unknown>, SelfOrchestrateRunResult> = {
  id: 'self_orchestrate',
  spec: buildSelfOrchestrateSpec(),
  async run(req, ctx: ToolRuntimeContext): Promise<SelfOrchestrateRunResult> {
    const goals = Array.isArray(req.goals)
      ? (req.goals as unknown[]).filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim())
      : [];
    if (goals.length === 0) throw new Error('SelfOrchestrate: `goals` (non-empty string array) is required');
    const autoMerge = req.auto_merge === true;   // ★ 안전 기본 false(worktree-only)
    const concurrency = typeof req.concurrency === 'number' && req.concurrency > 0 ? Math.floor(req.concurrency) : undefined;
    const decompose = req.decompose === true;
    // ⭐ 입구는 «번역»만 한다 — 판정·루프는 중앙 심(orchestrate-cli)이 갖는다.
    const supervise = req.supervise === true;
    const superviseRounds = typeof req.supervise_rounds === "number" && req.supervise_rounds > 0
      ? Math.floor(req.supervise_rounds)
      : undefined;
    const requestFabricDecompose = req.fabric_decompose;
    const deliverable = isDeliverableRequest(req.deliverable) ? req.deliverable : undefined;
    const normalizedTargetPaths = decompose ? normalizeTargetPaths(req.target_paths) : undefined;
    // Request intent wins without reading config: reader failures and side effects
    // cannot affect an explicit true or false selection.
    const normalizedPathCount = normalizedTargetPaths?.length;
    const fabricDecomposeConfig = typeof requestFabricDecompose === 'boolean'
      ? { enabled: false, autoPathThreshold: null }
      : fabricDecomposeConfigReader();
    const fabricDecomposerSelection = selectFabricDecomposer(requestFabricDecompose, fabricDecomposeConfig, normalizedPathCount);
    const { decomposer, source: fabricDecomposeSource } = fabricDecomposerSelection;
    const fabricDecompose = decomposer === 'fabric';
    debug.log('self-dev.orchestrate', 'runtime.invoke', {
      surface: ctx.surface, goals: goals.length, autoMerge, concurrency: concurrency ?? 'default(2)', decompose, fabricDecompose, fabricDecomposeSource,
    });
    if (fabricDecompose && !decompose) throw new Error('SelfOrchestrate: `fabric_decompose` requires `decompose=true`');

    // ⛔⭐⭐⭐ 관측 전용은 **위임 계열 전체**에 걸린다 — `SelfImplement` 하나만 막으면 형제가 샌다.
    //   실측(2026-08-02 · F4): `observeOnly` 를 켜고 코퍼스를 돌렸는데 자식이 `SelfOrchestrate` 를 골랐고,
    //   그 툴은 관문이 없어 **진짜 오케스트레이션이 돌았다**. 턴이 안 닫혀
    //   `llm.tool-loop.slow-tool awaiting {tool: SelfOrchestrate}` 가 30초마다 반복되며 측정이 멈췄다
    //   (러너는 정직하게 「진행 정지」로 끊었고, 멈춘 것은 사실이었다).
    //   ⇒ 스위치의 이름은 `selfImplement.observeOnly` 지만 **뜻은 「이 세션에서 자율 구현을 시작하지 않는다」**다.
    //   ⚠️ 열거가 아니라 계열로 잠근다 — 새 위임 툴이 생기면 그것도 이 관문을 지나야 한다([[JDG-T16]] 열거의 폐쇄성).
    const observeOnly = resolveObserveOnlyDecision();
    debug.log('self-dev.orchestrate', 'runtime.observe-only-decision', { surface: ctx.surface, observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
    if (observeOnly.enabled) {
      debug.log('self-dev.orchestrate', 'runtime.observed', { surface: ctx.surface, goals: goals.length, observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
      return {
        output: `SelfOrchestrate 관측 전용 측정 모드 — 호출이 접수되어 기록되었습니다. 이 세션에서는 오케스트레이션을 시작하지 않습니다. 같은 요청을 이 턴에서 직접 구현하지 말고 응답을 마무리하세요: ${goals.join(' · ').slice(0, 120)}`,
        ok: true, total: 0, done: 0, merged: 0, failed: 0,
      };
    }

    let decomposition: SelfDevDecomposition | undefined;
    let fabricDecomposition: FabricDecompositionOutcome | undefined;
    if (decompose) {
      if (fabricDecompose) {
        observeDecomposerSelection('fabric', fabricDecomposeSource, ctx.surface, normalizedPathCount, fabricDecomposeConfig.autoPathThreshold);
        const fabricResult = await fabricDecomposeFn(goals.join(' '));
        fabricDecomposition = fabricDecompositionOutcome(fabricResult);
        observeFabricDecomposition(fabricDecomposition, ctx.surface, fabricResult.status === 'decomposed' ? fabricResult.goals.length : undefined);
        if (fabricResult.status !== 'decomposed') {
          return {
            output: formatFabricDecompositionOutcome(fabricDecomposition),
            ok: fabricDecomposition.outcome !== 'llm-failed',
            total: 0,
            done: 0,
            merged: 0,
            failed: 0,
            fabricDecomposition,
          };
        }
        decomposition = fabricResultToDecomposition(fabricResult);
      } else {
        observeDecomposerSelection('default', fabricDecomposeSource, ctx.surface, normalizedPathCount, fabricDecomposeConfig.autoPathThreshold);
        const defaultDecomposition = await decomposeFn(goals.join(' '));
        decomposition = defaultDecomposition;
        if (fabricDecomposeSource === 'default' && defaultDecomposition.decomposition.exceededRecommendedMax) {
          observeDecomposerSelection('fabric', 'post-threshold', ctx.surface, normalizedPathCount, fabricDecomposeConfig.autoPathThreshold);
          const fabricResult = await fabricDecomposeFn(goals.join(' '));
          fabricDecomposition = fabricDecompositionOutcome(fabricResult);
          observeFabricDecomposition(fabricDecomposition, ctx.surface, fabricResult.status === 'decomposed' ? fabricResult.goals.length : undefined);
          if (fabricResult.status === 'decomposed') decomposition = fabricResultToDecomposition(fabricResult);
        }
      }
    }
    const orchestrateGoals = decomposition
      ? decomposition.goals.map((goal) => ({ ...goal, ...(autoMerge ? { autoMerge: true } : {}) }))
      : goals.map((feature) => ({ feature, ...(autoMerge ? { autoMerge: true } : {}) }));
    const originalRequest = decompose ? goals.join(' ') : undefined;
    let derivedDeliverable: { readonly document: string; readonly attribution: 'all' | 'last'; readonly goalPath?: string } | undefined = deliverable ?? (originalRequest === undefined
      ? undefined
      : { document: originalRequest, attribution: 'all' as const });
    if (derivedDeliverable) {
      const launchDeclaration = inspectArtifactLaunchDeclaration(derivedDeliverable.document);
      if (!launchDeclaration.declared) {
        // The central CLI owns the existing no-launch-declaration observation.
      } else if (!launchDeclaration.extracted) {
        debug.log('self-dev.deliverable-wiring', 'skipped', { reason: 'invalid-launch-declaration', goalIdCount: orchestrateGoals.length });
        derivedDeliverable = undefined;
      } else if (launchDeclaration.declaration?.port === undefined) {
        // The central CLI owns the existing no-port-declaration observation.
      } else {
        const authored = await goalAuthor(derivedDeliverable.document, process.cwd(), { goalTitle: 'SelfOrchestrate deliverable' });
        derivedDeliverable = { ...derivedDeliverable, goalPath: authored.path };
      }
    }
    const runOptions = {
      ...(originalRequest === undefined ? {} : { parentRequest: originalRequest }),
      ...(derivedDeliverable === undefined ? {} : { deliverable: derivedDeliverable }),
      ...(supervise ? { supervise: superviseRounds ? { rounds: superviseRounds } : {} } : {}),
    };
    const stopAfterFailure = (result: SelfDevJobResult): string | null => {
      const reason = classifyReviewProviderFailure(stoppedChildSummary(result));
      return reason === 'rate-limited' ? reason : null;
    };
    const onStopAfterFailure = ({ reason, remainingGoals }: { reason: string; remainingGoals: number }): void => {
      debug.log('self-dev.orchestrate', 'runtime.stop-rate-limited', {
        surface: ctx.surface,
        reason,
        remainingGoals,
      }, { level: 'warn' });
    };
    const results = await orchestrateFn({
      goals: orchestrateGoals,
      ...runOptions,
      ...(concurrency === undefined ? {} : { concurrency }),
      stopAfterFailure,
      onStopAfterFailure,
    });

    const done = results.filter((r) => r.status === 'done').length;
    const merged = results.filter((r) => r.merged).length;
    const failed = results.filter((r) => r.status === 'failed').length;
    return {
      output: formatResults(results),
      ok: failed === 0,
      total: results.length,
      done,
      merged,
      failed,
      ...(fabricDecomposition ? { fabricDecomposition } : {}),
    };
  },
};
