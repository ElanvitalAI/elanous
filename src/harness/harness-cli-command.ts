import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { dlopen, FFIType } from 'bun:ffi';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { constants as osConstants, hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { HarnessCliInputError } from '../cli/cli-user-error.js';
import { writeStdoutFully } from '../cli/stdout-flush.js';
import { findGitDir } from '../git-fs/locate.js';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';
import { loadSelfDevRun } from '../self-dev/run-store.js';
import { normalizeRunId } from './harness-space.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { lookupGoal, type GoalLookupOptions, type GoalLookupResult } from '../self-implement/goal-lookup.js';
import { archiveGoals, type GoalArchiveOptions } from '../self-implement/goal-archive.js';
import { detectBursts, formatIncidentBurstWarning, incidentLastLines, readRunExits, recentBurst, recordRunExit } from './harness-incidents.js';
import { Command, InvalidArgumentError, Option } from 'commander';
import { runGitCommand } from '../git-fs/runner.js';
import { GOAL_TYPES, lintGoalFile, parseGoalId, parseGoalType, resolveGoalAuthorGrade, tracedPathReferences, type GoalAuthorGrade, type GoalAuthorGradeSelection, type GoalType } from '../self-implement/goal-author.js';
import { templateForGoalType } from '../self-implement/graph-templates.js';
import { appendRunLedgerEntry, listRunLedgers, loadFederatedRunLedger, loadRunLedger, queryRunScreenKey, runLedgerDir, type RunLedgerEntry, type RunLedgerMatch, type RunLedgerWriter } from '../self-implement/run-ledger.js';
import { classifyPodExit, parsePodTermination, podFailureLedgerAxes, type PodExitClass, type PodFailureLedgerAxes, type PodTermination } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import type { PodChildEvidence } from '../task-orchestrator/surfaces/self-implement.js';
import { classifyPodExitStop, readRunStopRecord, recordRunStop, runStopRecorded, RUN_STOP_EVENT } from '../self-implement/run-stop.js';
import { captureStopKnowhowCandidate } from '../self-implement/stop-autoheal.js';
import { ensureOpenRouterChildModelLive, resolveChildLlmEffort, resolveImplementationChildModel } from '../self-dev/dev-cli.js';
import { resolveHarnessTarget } from '../self-implement/harness-target-options.js';
import { buildRunProgressRows, isPartialRunningRuns, queryRunningRuns, renderRunProgressTable } from '../self-implement/running-runs.js';
import { launchBindingRunIds, readLaunchBinding } from './launch-registry.js';
import { psProcessStartMs } from './harness-stop.js';
import { DevPipelineError } from '../self-dev/dev-pipeline.js';
import { collectDraftMetrics, collectOverlapMetrics, DRAFT_SWEEP_CONCURRENCY, mapBounded, resolveDraftSweepCloseCap, runDraftSweep, sweepFailureReason, validateDraftSweepApplyPlan, type DraftSweepAdapters, type DraftSweepResult, type OverlapMetricAdapters, type SweepDraft, type SweepMergedPr, type SweepReviewGate } from '../self-dev/draft-sweep.js';
import { readAskPreflightRowsSince, readSalvagedRowsSince } from '../self-dev/ask-launch-io.js';
import { replayPodTerminals, type DraftResidueReplayOptions, type PrTerminalRecord } from '../self-dev/draft-residue.js';
import { draftClaimComment, draftReleaseComment } from '../self-dev/draft-triage-rules.js';
import { readTaskAgentState, taskAgentStatePath, type TaskCard } from '../task-agent/task-hand.js';
import { debug } from '../debug/log.js';
import { installHarnessSalvageCommand, installHarnessSalvageRetentionCommand } from './harness-salvage-cli.js';
import { decideNestedElanousLaunch, readNestedElanousDepth } from './nested-elanous-policy.js';
import { dispatchTask, type DispatchTaskInput, type DispatchTaskDeps } from '../execution-loop/dispatch-task.js';
import { LAUNCH_DOOR_RECEIPT_ENV, harnessLaunchBudgetDecision, launchRequestId, openLaunchRequestDoor, preLaunchGate, resolveLaunchBudget, type PreLaunchGateDeps } from '../execution-loop/launch-gate.js';
import { PR_LABELS } from '../github/pr-labels.js';
import { ghAutomationEnv } from '../autopilot/pr-manager.js';
import { decideBudget, readBudgetInputsLive, type BudgetDecision, type BudgetInputs } from '../self-implement/budget-gate.js';
import { installDeliverableVerifyCliCommand, type InstallDeliverableVerifyCliDeps } from './deliverable-verify-cli.js';
import { getUserConfig } from '../user-config.js';
import type { SiblingResyncAdapters, SiblingResyncResult, SiblingRunTarget } from '../self-implement/sibling-resync.js';
import type { RunTtlAdapters, RunTtlResult } from '../self-implement/run-ttl.js';
import type { ControlMemoPayload } from './control-inbox.js';
import { resolveRepositoryName } from './repository-name.js';
import { installHarnessCliSinkHook } from './harness-cli-sink.js';
import { addHarnessQueue, HarnessQueueDuplicateError, harnessQueueReceiptPath, listHarnessQueue, queueSeatForCwd, reconcileHarnessQueue, removeHarnessQueue, setHarnessQueuePriority, tickHarnessQueue, type HarnessQueueDeps, type QueueItem, type QueueSeat } from './harness-queue.js';
import { writeHarnessQueueReceipt } from './harness-queue-child.js';
import { decideBackpressure, readBackpressureSignals, type BackpressureReadDeps } from './dispatch-backpressure.js';
import { parseDoorSince, queryLaunchDoors, renderLaunchDoors, type DoorTable } from './launch-stamp.js';
import { resolveHarnessSubstrate, type ResolvedHarnessSubstrate } from './harness-substrate-default.js';
import { podChildProviderRefusal } from '../task-orchestrator/surfaces/pod-child-providers.js';
import { runHarnessPlanRfc } from './harness-plan-rfc.js';
import { classifyGarbage, isGarbageProcessTarget, type GarbageProcess } from './process-garbage.js';
import type { MissionSolveOutcome } from './mission-solve-loop.js';
import { formatAxis, formatAxisObservations, inspectAskMarkers, inspectUnpressedDecisionSignals } from '../../scripts/ask-marker-check.js';
import { enterJourneyNode, ensureJourneyKey, exitJourneyNode, JOURNEY_KEY_ENV, passJourneyNode, withJourneyNode } from '../self-dev/graph-journey-nodes.js';
import { intakeTakesQueue, readJourneyEdge, recordJourneyEdge } from '../self-dev/graph-journey-route.js';
import { appendBenchLedger, BENCH_LOG_CATEGORY, benchBaseBranch, defaultBenchGitRun, ensureBenchBase, nextBenchRound, parseBenchSpec, readBenchLedger, type BenchBase, type BenchGitRun } from '../bench/bench.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { codeRevision } from '../version/code-revision.js';

let harnessPlanRfcForTesting: typeof runHarnessPlanRfc | undefined;
let harnessAskMarkerInspectorForTesting: ((ask: string) => readonly string[]) | undefined;
let harnessUnpressedDecisionSignalInspectorForTesting:
  | ((ask: string) => ReturnType<typeof inspectUnpressedDecisionSignals>)
  | undefined;

function warningDetailsFromAxis(axis: Parameters<typeof formatAxis>[0]): readonly string[] {
  return [formatAxis(axis), ...formatAxisObservations(axis)]
    .filter((detail) => detail.startsWith('⚠️') || detail.startsWith('❌'));
}

function inspectHarnessAskMarkerWarnings(ask: string): readonly string[] {
  const inspector = harnessAskMarkerInspectorForTesting;
  if (inspector) return inspector(ask);
  const markerWarnings = inspectAskMarkers(ask).flatMap(warningDetailsFromAxis);
  let unpressedWarnings: readonly string[];
  try {
    const inspectUnpressed = harnessUnpressedDecisionSignalInspectorForTesting ?? inspectUnpressedDecisionSignals;
    unpressedWarnings = warningDetailsFromAxis(inspectUnpressed(ask));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const firstLine = message.split(/\r\n|\n|\r/, 1)[0] ?? '';
    unpressedWarnings = [`⚠️ ask 마커 — 안 눌릴 신호 검사 실패: ${firstLine}`];
  }
  return [...markerWarnings, ...unpressedWarnings];
}

/** Test-only override for dry-run ask-marker inspection. */
export function setHarnessAskMarkerInspectorForTesting(inspector: ((ask: string) => readonly string[]) | undefined): void {
  harnessAskMarkerInspectorForTesting = inspector;
}

/** Test-only override for dry-run unpressed-decision-signal inspection. */
export function setHarnessUnpressedDecisionSignalInspectorForTesting(
  inspector: ((ask: string) => ReturnType<typeof inspectUnpressedDecisionSignals>) | undefined,
): void {
  harnessUnpressedDecisionSignalInspectorForTesting = inspector;
}

/** Test-only override for the RFC plan handler installed by the singleton CLI. */
export function setHarnessPlanRfcForTesting(fn: typeof runHarnessPlanRfc | undefined): void {
  harnessPlanRfcForTesting = fn;
}

export { HarnessCliInputError } from '../cli/cli-user-error.js';

export type HarnessSupervisorSource = 'flag' | 'default';

export interface HarnessAskSayOptions {
  seat?: QueueSeat;
  json?: boolean;
  base?: string;
  target?: string;
  yes?: boolean;
  forcePreflight?: boolean;
  forceGate?: boolean;
  autoMerge?: boolean;
  mergeByHost?: boolean;
  observeOnly?: boolean;
  supervise?: boolean;
  supervisorSource?: HarnessSupervisorSource;
  goalType?: GoalType;
  authorGrade?: GoalAuthorGrade;
  authorGradeSource?: GoalAuthorGradeSelection['source'];
  correlation?: string;
  /** Depth 0 only. At depth >= 1 this flag is ignored and the launch stays refused. */
  nestedElanous?: 'allow';
  queue?: boolean;
  /** RUN-IDENTITY — 태스크 카드 신분이 대기열 줄 우선순위로 옮겨온 값(승인·선점이 신분을 읽는다 · 칸 러브릭보다 위). */
  runPriority?: number;
}

export interface ResolvedHarnessSupervisor {
  readonly supervise: boolean;
  readonly supervisorSource: HarnessSupervisorSource;
}

export function resolveHarnessSupervisor(opts: Pick<HarnessAskSayOptions, 'supervise'>): ResolvedHarnessSupervisor {
  return opts.supervise === false
    ? { supervise: false, supervisorSource: 'flag' }
    : { supervise: true, supervisorSource: 'default' };
}

export interface HarnessAskSayChildLlmOptions extends HarnessAskSayOptions {
  childLlmProvider?: string;
  childLlmModel?: string;
  childLlmEffort?: string;
  /** BENCH-ISOLATED-ARMS — `<id>[:<base-sha>]` · base 를 `bench/<id>/base` 로 고정한다(`--base` 와 함께 못 쓴다). */
  bench?: string;
}

/** BENCH-ISOLATED-ARMS — 시험이 실제 원격·운영 config 를 안 건드리게 주입한다. */
export interface HarnessBenchDeps {
  readonly git?: BenchGitRun;
  readonly configDir?: string;
  readonly imageCommit?: () => string | null;
  /** 부모(이 발사 프로세스)가 도는 코드 커밋 — 기본 `codeRevision()`(코드 자신의 위치 · cwd 무관). */
  readonly codeCommit?: () => string | null;
}

export interface HarnessPlanOptions extends HarnessAskSayOptions {
  roleLlm?: string[];
  /** ⭐ `plan` 문만 이 값을 넘긴다 — 주입된 핸들러가 「쓸까 말까」를 알아야 한다(ask·say 엔 없다). */
  dryRun?: boolean;
}

export type HarnessAskHandler = (goalPath: string, opts: HarnessAskSayChildLlmOptions) => Promise<void>;
export type HarnessSayHandler = (words: string[], opts: HarnessAskSayChildLlmOptions) => Promise<void>;
export type HarnessPlanHandler = (words: string[], opts: HarnessPlanOptions) => Promise<void>;
export type HarnessMissionHandler = (missionId: string, opts: { executor?: 'self-implement' }) => Promise<void>;
export type HarnessMissionLoopHandler = (missionIds: readonly string[], opts: { executor?: 'self-implement' }) => Promise<readonly MissionSolveOutcome[]>;

function renderHarnessMissionOutcomes(outcomes: readonly MissionSolveOutcome[]): void {
  for (const outcome of outcomes) {
    const detail = outcome.detail ?? outcome.terminal;
    console.log(`🧩 미션 '${outcome.missionId}' — ${outcome.status}${detail ? `: ${detail}` : ''}`);
  }
}

function humanErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const humanMessage = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^at\s/.test(line) && !/^\s*at\s/.test(line));
  return `❌ ${humanMessage || 'harness command failed'}`;
}

async function runInjectedHarnessHandler(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(humanErrorLine(error));
    process.exitCode = error instanceof DevPipelineError ? error.exitCode : 1;
  }
}

function registerHarnessCommonOptions(command: Command): Command {
  return command
    .option('--json', '구조화 출력')
    .option('--base <branch>', '분기 base')
    .addOption(new Option('--no-auto-merge', 'self: PR 생성 후 자동 병합을 끔'))
    .option('--merge-by-host', 'Pod: merge-ready 까지 실행하고 병합은 발사 호스트가 재게이트')
    .option('--observe-only', 'elanous: child boot부터 SelfImplement 호출을 기록만 한다')
    .addOption(new Option('--no-supervise', 'self: supervisor 재개를 끔').hideHelp())
    .option('--dry-run', '변경 없이 발사 계획만 출력')
    .addOption(new Option('--nested-elanous <policy>', '깊이 0만: 중첩 elanous 발사를 허용(allow). 깊이 1 이상은 무시되고 거부가 유지된다').choices(['allow']));
}

type HarnessDryRunOpts = { dryRun?: boolean };

function isHarnessDryRun(opts: HarnessDryRunOpts): boolean {
  return opts.dryRun === true;
}

function renderGoalTemplateDryRun(goalPath: string, goalTypeOverride?: GoalType): string {
  // ⛔ 「골 문서를 못 읽었다」와 「읽었는데 종류가 잘못됐다」는 «다른 값」이다 —
  //   같은 문면으로 접으면 사람이 오타를 찾는 대신 경로를 의심한다(그 반대도 같다).
  if (goalTypeOverride !== undefined) {
    const template = templateForGoalType(goalTypeOverride);
    return `[dry-run] 골 종류·템플릿: ${goalTypeOverride} · ${template?.graphId ?? '템플릿 없음'}`;
  }
  let document: string;
  try {
    document = readFileSync(goalPath, 'utf8');
  } catch {
    return '[dry-run] 골 종류·템플릿: 읽지 못함 · 미상';
  }
  const goalType = parseGoalType(document);
  if (!goalType) return '[dry-run] 골 종류·템플릿: 미상 · 미상';
  const template = templateForGoalType(goalType);
  return `[dry-run] 골 종류·템플릿: ${goalType} · ${template?.graphId ?? '템플릿 없음'}`;
}

function printHarnessAskMarkerDryRun(goalPath?: string): void {
  if (!goalPath) {
    console.log('[dry-run] ask 마커 — 골 문서가 아직 없다 (⛔ 「경고 없음」이 아니다)');
    return;
  }
  let ask: string;
  try {
    ask = readFileSync(goalPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`[dry-run] ⚠️ ask 마커 — 골 문서 판독 실패: ${message}`);
    return;
  }
  try {
    const warnings = inspectHarnessAskMarkerWarnings(ask);
    if (warnings.length === 0) {
      console.log('[dry-run] ✅ ask 마커 — 경고 없음');
    } else {
      for (const warning of warnings) console.log(`[dry-run] ⚠️ ask 마커 — ${warning}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`[dry-run] ⚠️ ask 마커 — 검사 실패: ${message}`);
  }
  for (const finding of lintGoalFile(ask, 'main').filter(({ tag }) => tag === 'release-note')) {
    console.log(`[dry-run] ⚠️ 릴리스 노트 — ${finding.message}`);
  }
}

function printHarnessLaunchDryRun(preview: {
  readonly input: string;
  readonly entrance: string;
  readonly wouldStart: string;
  readonly goalPath?: string;
  readonly goalType?: GoalType;
  readonly target?: string;
}): void {
  console.log(`[dry-run] 입력: ${preview.input}`);
  console.log(`[dry-run] 입구: ${preview.entrance}`);
  console.log(`[dry-run] 시작 예정: ${preview.wouldStart}`);
  console.log(preview.goalPath
    ? '[dry-run] 전제 검사: ask 마커·릴리스 노트 린트만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음'
    : '[dry-run] 전제 검사: ask 마커만 돌렸다 · 원격 조회(열린 PR·런 원장)는 돌리지 않음');
  printHarnessAskMarkerDryRun(preview.goalPath);
  if (preview.goalPath) console.log(renderGoalTemplateDryRun(preview.goalPath, preview.goalType));
  if (preview.target !== undefined) {
    const target = resolveHarnessTarget(preview.target);
    console.log(`[dry-run] target: ${target.canonicalTarget ?? resolve(preview.target)} · ${target.status}`);
  }
}

function registerHarnessAskSayOptions(command: Command): Command {
  return registerHarnessCommonOptions(command)
    .option('--target <path>', 'self: harness가 작업할 레포 또는 디렉터리(self-mission 전용)')
    .option('--yes', 'git 아닌 프로젝트에 git init 및 첫 커밋을 만들도록 동의')
    .option('--correlation <id>', '요청과 런을 잇는 불투명 correlation 값')
    .addOption(new Option('--seat <seat>', '런 귀속 자리 (OP|TC|MK|UX)').choices(['OP', 'TC', 'MK', 'UX']))
    .option('--no-queue', '비상시 자리별 대기열을 건너뛰고 직접 발사')
    .option('--run-priority <n>', 'RUN-IDENTITY — 태스크 카드 신분이 대기열 줄 우선순위로 옮겨온 값(승인·선점이 신분을 읽는다 · 칸 러브릭보다 위)', (value: string) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new InvalidArgumentError('유한한 숫자여야 한다');
      return n;
    })
    .addOption(new Option('--goal-type <type>', `골 종류 (${GOAL_TYPES.join('|')})`).choices([...GOAL_TYPES]))
    .option('--force-preflight', '전제 검사 막힘을 명시 요청으로 우회(관측에 남음)')
    .option('--force-gate', '같은 골 실행 중 막힘을 명시 요청으로 우회(관측에 남음; 예산 막힘은 우회 불가)')
    .option('--child-llm-provider <id>', 'self: 구현 자식 LLM provider(--child-llm-model과 함께)')
    .option('--child-llm-model <id>', 'self: 구현 자식 LLM model(--child-llm-provider와 함께)')
    .option('--child-llm-effort <level>', 'self: 구현 자식 추론 노력 minimal|low|medium|high|xhigh|max — 모델 상한을 넘으면 «거부»한다(--child-llm-provider와 함께)')
    .addOption(new Option('--substrate <kind>', '실행 칸 — local(설정 없을 때 기본 · 이 기계) | pod(k8s Pod · 같은 그래프가 원격에서 돈다)').choices(['local', 'pod']))
    .option('--pod-pool <spec>', 'pod: 풀 — 인자 > ELANOUS_POD_POOL > harness.podPool > 기존 pod.pool > 현재 컨텍스트')
    .addOption(new Option('--pod-memory <tier>', 'pod: 메모리 등급 — lite(2Gi · 문서·조사·네트워크 스킬 골 · OOM 이면 high 로 한 번 재시도) | standard(16Gi) | high(32Gi) · 없으면 골 문면 `Pod 메모리: <등급>` 한 줄 · 그것도 없으면 골이 apps/pwa/ 를 담을 때 high').choices(['lite', 'standard', 'high']))
    .option('--after <goal-or-pr>', 'pod: 선행 — 이 골 ID(16자) 또는 PR(#N) 이 병합될 때까지 Pod 발사가 큐에서 이유와 함께 기다린다(병합 없이 닫히면 blocked) · 골 문면 `선행: #N` 한 줄과 같다 · 대상 파일만 겹치면 선행이 아니다(경고만)')
    .option('--source <spec>', 'pod: 원천 — commit:<40자 sha> | pr:<정수> | worktree:<경로> | files:<경로>[,<경로>…] · `--substrate pod` 와 함께')
    .option('--repair-commit-only <expected-head>', 'pod: 기존 PR head에서 수리한 커밋을 bundle로 반환(PR 생성 없음)')
    .option('--bench <id[:sha]>', '벤치 팔 — base 를 bench/<id>/base 로 고정(없으면 sha·생략 시 origin/main 으로 만든다 · 있으면 sha 일치 확인 · 불일치 거부) · 팔 가지 bench/<id>/<arm> · PR 라벨 elanous:bench · PR 직전 main 동기화 생략 · 원장 elanous bench ls <id>');
}

function registerHarnessPlanOptions(command: Command): Command {
  return registerHarnessCommonOptions(command)
    .option(
      '--role-llm <role=provider[/tier]>',
      '⭐ 역할별 LLM (반복 가능 · implement|review|research|planning|audit|classify) 예: implement=grok/best · review=anthropic · planning=/best',
      (value: string, previous: string[] = []) => [...previous, value],
    );
}

function registerHarnessMissionOptions(command: Command): Command {
  return command
    .addOption(new Option('--executor <executor>', '실행기 (self-implement; 생략 시 self-implement)').choices(['self-implement']))
    .option('--dry-run', '변경 없이 발사 계획만 출력');
}

function normalizeHarnessCommonOptions(opts: HarnessAskSayOptions): HarnessAskSayOptions {
  return {
    ...(opts.json ? { json: true } : {}),
    ...(opts.seat !== undefined ? { seat: opts.seat } : {}),
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.yes === true ? { yes: true } : {}),
    ...(opts.autoMerge === false ? { autoMerge: false } : {}),
    ...(opts.mergeByHost === true ? { mergeByHost: true } : {}),
    ...(opts.observeOnly ? { observeOnly: true } : {}),
    ...(opts.goalType !== undefined ? { goalType: opts.goalType } : {}),
    ...(opts.authorGrade !== undefined ? { authorGrade: opts.authorGrade } : {}),
    ...(opts.authorGradeSource !== undefined ? { authorGradeSource: opts.authorGradeSource } : {}),
    ...resolveHarnessSupervisor(opts),
    ...resolveNestedElanousOption(opts),
  };
}

export class NestedElanousRefused extends Error {
  constructor(readonly depth: number) {
    super(`nested elanous refused (allow-ignored, depth ${depth})`);
    this.name = 'NestedElanousRefused';
  }
}

/**
 * Depth 0 may keep `--nested-elanous allow`.
 * Depth >= 1 cannot flip the refusal: the flag is ignored, logged, and the launch stops.
 * No flag means an ordinary launch — unset depth is 0 and nothing is refused here.
 */
export function resolveNestedElanousOption(
  opts: Pick<HarnessAskSayOptions, 'nestedElanous'>,
  env: Record<string, string | undefined> = process.env,
): { nestedElanous?: 'allow' } {
  if (opts.nestedElanous !== 'allow') return {};
  const decision = decideNestedElanousLaunch({ depth: readNestedElanousDepth(env), allow: true });
  if (decision.reason === 'allow-ignored') throw new NestedElanousRefused(decision.depth);
  if (!decision.allowed) return {};
  return { nestedElanous: 'allow' };
}

function normalizeHarnessAskSayOptions(opts: HarnessAskSayChildLlmOptions): HarnessAskSayChildLlmOptions {
  return {
    ...normalizeHarnessCommonOptions(opts),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.correlation !== undefined ? { correlation: opts.correlation } : {}),
    ...(opts.forcePreflight === true ? { forcePreflight: true } : {}),
    ...(opts.runPriority !== undefined ? { runPriority: opts.runPriority } : {}),
    ...(opts.childLlmProvider !== undefined ? { childLlmProvider: opts.childLlmProvider } : {}),
    ...(opts.childLlmModel !== undefined ? { childLlmModel: opts.childLlmModel } : {}),
    // ⛔⭐⭐ 🩸 2026-09-12 — ***이 줄이 «없어서» `--child-llm-effort` 가 조용히 삼켜졌다.***
    //    옵션은 등록됐고 판정 함수도 맞았는데 ***통로가 «안 날랐다»***.
    //    🔑 해석 줄에 `effort=` 가 «안 찍히는» 것으로 잡았다 — 그 줄을 둔 이유가 이것이다.
    ...(opts.childLlmEffort !== undefined ? { childLlmEffort: opts.childLlmEffort } : {}),
  };
}

/** Reject a supplied `--child-llm-model` at argv time — before ask/say authoring or dry-run. */
function assertHarnessChildLlmModel(opts: HarnessAskSayChildLlmOptions): void {
  // ⛔ 노력만 오고 모델·provider 가 없으면 «조용히 무시하지 않는다».
  if (opts.childLlmEffort !== undefined && !opts.childLlmProvider?.trim()) {
    throw new DevPipelineError('--child-llm-provider 필요(--child-llm-effort와 함께)');
  }
  if (opts.childLlmModel === undefined) return;
  const provider = opts.childLlmProvider;
  if (!provider?.trim()) {
    throw new DevPipelineError('--child-llm-provider 필요(--child-llm-model과 함께)');
  }
  resolveImplementationChildModel(provider, opts.childLlmModel);
  if (opts.childLlmEffort !== undefined) {
    resolveChildLlmEffort(provider, opts.childLlmModel, opts.childLlmEffort);
  }
}

/** Shared post-parse gate: validate child model before any ask/say early return (including `--dry-run`). */
type HarnessSubstrateOpts = { substrate?: 'local' | 'pod'; podPool?: string; podMemory?: 'lite' | 'standard' | 'high'; after?: string; autoMerge?: boolean; base?: string; json?: boolean; target?: string; source?: string; repairCommitOnly?: string; seat?: QueueSeat };
function resolveLaunchSubstrate(opts: HarnessSubstrateOpts): ResolvedHarnessSubstrate {
  const resolved = resolveHarnessSubstrate({ flag: opts, config: getUserConfig(), env: process.env });
  debug.log('harness.substrate', 'resolved', resolved);
  const head = `[harness] substrate=${resolved.substrate}${resolved.substrate === 'pod' ? ` pool=${resolved.pool}` : ''} (${resolved.source})`;
  if (opts.json) console.error(head);
  else console.log(head);
  return resolved;
}
type PodExit = { status: number | null; signal?: string | null };
type PodExitReason = 'signal' | 'human-stop' | 'supervisor' | 'no-launch' | 'unknown' | 'preflight-refused'
  | 'pod-error' | 'launch-gate-blocked' | 'dep-blocked' | 'ENOBUFS' | 'OOMKilled';

function unknownPodExitTailReason(output: string): PodExitReason | undefined {
  const tail = output.slice(-16_000);
  if (/\bOOMKilled\b/i.test(tail)) return 'OOMKilled';
  if (/\bENOBUFS\b/i.test(tail)) return 'ENOBUFS';
  if (/launch gate[^\r\n]*blocked|blocked[^\r\n]*launch gate/i.test(tail)) return 'launch-gate-blocked';
  if (/\bpod-error\b/i.test(tail)) return 'pod-error';
  if (/\b(?:DEP_FAILED|DEPENDENCY_NEEDS_HUMAN|DEP_BLOCKED_REBASE_READY)\b/.test(tail)) return 'dep-blocked';
  return undefined;
}
/** GitHub lists at most this many files for one pull request; a list that reaches it is not provably complete. */
export const GITHUB_PR_FILES_LIST_CAP = 3000;
const STOPPING_SUPERVISOR_VERDICTS = new Set(['UNCONVERGEABLE', 'CONTRACT-CONFLICT']);
// Ledger events that only exist once the child actually ran — any of them rules out «never reached the Pod».
const LAUNCH_EVIDENCE_EVENTS = new Set(['job-applied', 'pod-child-run', 'reviewed', 'rework-budget', 'pr-opened']);

/** Keep the run identity seen at launch even if the bounded output tail later drops it. */
export function harnessPodRunId(output: string): string | undefined {
  return output.match(/\[self-dev\][^\r\n]*\brun\s+(run-[a-z0-9_-]{8,64})(?=\s|$)/i)?.[1];
}

/** Classify a missing Pod result from run-scoped evidence, never from a nonzero exit alone. */
export function classifyHarnessPodExit(
  exit: PodExit,
  output: string,
  deps: {
    loadLedger?: typeof loadRunLedger;
    hasJobApplied?: (runId: string | undefined, output: string) => boolean | undefined;
    supervisorDecision?: (runId: string) => { stopReason?: string; why?: string } | undefined;
    loadCheckpoint?: typeof loadSelfDevRun;
    runId?: string;
  } = {},
): { lines: string[]; reason: PodExitReason | 'pod-failure'; podErrorCode?: 'pod-job-failed' } {
  const occupiedNewLine = output.split('\n').find((line) =>
    /^\[self-dev\] run run-[a-z0-9_-]{8,64} \[preflight:new-path-occupied:[0-9a-f-]{36}\] /.test(line));
  const observedRunId = deps.runId ?? harnessPodRunId(output);
  const preflightRunId = occupiedNewLine ? harnessPodRunId(occupiedNewLine) : undefined;
  const preflightAttemptId = occupiedNewLine?.match(/\[preflight:new-path-occupied:([0-9a-f-]{36})\]/)?.[1];
  const preflightPath = occupiedNewLine?.match(/신설 traced path 가 이미 점유됨: (.+) — 골의 신설: 경로를 바로잡아야 한다$/)?.[1];
  let preflightReceipt = false;
  if (exit.status === 2 && !exit.signal && occupiedNewLine && preflightRunId && preflightRunId === observedRunId && preflightPath && preflightAttemptId) {
    try {
      const entries = (deps.loadLedger ?? loadRunLedger)(preflightRunId) ?? [];
      const receiptIndex = entries.findIndex((entry) => entry.runId === preflightRunId && entry.event === 'preflight-refused'
        && entry.data.kind === 'occupied-new-traced-path' && entry.data.path === preflightPath
        && entry.data.attemptId === preflightAttemptId);
      preflightReceipt = receiptIndex >= 0 && !entries.slice(receiptIndex + 1).some((entry) => LAUNCH_EVIDENCE_EVENTS.has(entry.event));
    } catch { /* Unreadable run evidence cannot establish a host refusal. */ }
  }
  if (preflightReceipt && occupiedNewLine) {
    const runId = preflightRunId;
    try { debug.log('harness.pod', 'exit-classified', { runId, reason: 'preflight-refused', status: exit.status, signal: exit.signal ?? null }); }
    catch { /* observation is fail-soft */ }
    return { reason: 'preflight-refused', lines: [occupiedNewLine] };
  }
  let podFailure: string | undefined;
  let podJobFailed = false;
  let podJobFailedFromResult = false;
  let podChildFailed = false;
  for (const line of output.split('\n').reverse()) {
    if (!line.trimStart().startsWith('[{') || !line.includes('"error"')) continue;
    try {
      const results: unknown = JSON.parse(line);
      if (!Array.isArray(results)) continue;
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const error = (result as { error?: { code?: string; message?: string } }).error;
        if (typeof error?.code !== 'string' || typeof error.message !== 'string' || !error.code.startsWith('pod-')) continue;
        podFailure = error.message;
        podJobFailed = error.code === 'pod-job-failed';
        podJobFailedFromResult = podJobFailed;
        podChildFailed = error.code === 'pod-child-failed';
        break;
      }
    } catch { /* Non-result stdout cannot establish that a Pod child ran. */ }
    if (podFailure) break;
  }
  if (!podFailure) {
    const summary = output.split('\n').find((line) => /\s❌\sfailed · .* — pod-[\w-]+: /.test(line));
    podFailure = summary?.split(/\s❌\sfailed · .* — pod-[\w-]+: /)[1];
    podJobFailed = summary?.includes(' — pod-job-failed: ') ?? false;
    // src/self-dev/orchestrate-summary-line.ts prints the pod-child-failed message (the Pod reason) on this line.
    podChildFailed = summary?.includes(' — pod-child-failed: ') ?? false;
  }
  // Only the run announced at launch — another run id quoted in the output is not this run (review round 3).
  const runId = observedRunId ? normalizeRunId(observedRunId) : undefined;
  if (podFailure) {
    const childError = podJobFailed ? podFailure.split('childError=')[1]?.split('\\n', 1)[0]?.split('\n', 1)[0] : undefined;
    try { debug.log('harness.pod', 'exit-classified', { runId, reason: 'pod-failure', status: exit.status, signal: exit.signal ?? null }); } catch { /* observation is fail-soft */ }
    return { reason: 'pod-failure', ...(podJobFailedFromResult ? { podErrorCode: 'pod-job-failed' as const } : {}), lines: [podChildFailed
      ? `Pod 안 자식이 실패했다 — ${podFailure.split('\\n', 1)[0]}`
      : podJobFailed && childError && childError !== 'no-result-line'
        ? `Pod 안 자식이 실패했다 — ${childError}`
        : `Pod 실행이 실패했다 — ${podFailure.split('\\n', 1)[0]}`] };
  }
  let ledger: ReturnType<typeof loadRunLedger> = null;
  let ledgerReadable = false;
  if (runId) {
    try { ledger = (deps.loadLedger ?? loadRunLedger)(runId); ledgerReadable = ledger !== null; } catch { /* unreadable is not absent */ }
  }
  const signal = exit.signal ?? (exit.status !== null && exit.status > 128
    ? Object.entries(osConstants.signals).find(([, number]) => number === exit.status! - 128)?.[0] : undefined);
  const humanStop = ledger?.some((entry) => entry.event === 'human-stop');
  // A continuing verdict (EXTEND · SUFFICIENT) is not why the run ended — only stopping verdicts count.
  const supervisor = [...(ledger ?? [])].reverse().find((entry) =>
    (entry.event === 'supervisor-decision' || entry.event === 'supervisor-verdict' || entry.event === 'rework-budget')
      && STOPPING_SUPERVISOR_VERDICTS.has(String(entry.data.supervisorVerdict ?? entry.data.verdict))
    || entry.event === 'run-status' && entry.data.stage === 'review-blocked');
  let decision: { stopReason?: string; why?: string } | undefined;
  if (runId) {
    try { decision = (deps.supervisorDecision ?? lookupHarnessSupervisorDecision)(runId); } catch { /* unknown */ }
  }
  const verdict = decision?.stopReason ?? supervisor?.data.supervisorVerdict ?? supervisor?.data.verdict
    ?? (supervisor?.event === 'run-status' ? supervisor.data.stage : undefined);
  const reasonText = decision?.why ?? supervisor?.data.supervisorReason ?? supervisor?.data.reason;
  const ledgerPrUrl = [...(ledger ?? [])].reverse().find((entry) => entry.event === 'pr-opened'
    && (typeof entry.data.url === 'string' || typeof entry.data.prUrl === 'string'))?.data;
  let checkpoint: ReturnType<typeof loadSelfDevRun> = null;
  if (runId) {
    try { checkpoint = (deps.loadCheckpoint ?? loadSelfDevRun)(runId); } catch { /* unreadable is not absent */ }
  }
  const pr = output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b/)?.[0]
    ?? (typeof ledgerPrUrl?.url === 'string' ? ledgerPrUrl.url
      : typeof ledgerPrUrl?.prUrl === 'string' ? ledgerPrUrl.prUrl : undefined)
    ?? checkpoint?.results.find((result) => result.prUrl)?.prUrl;
  let reason: PodExitReason;
  let line: string;
  if (humanStop) {
    reason = 'human-stop';
    line = '사람이 멈춘 런이다';
  } else if (signal) {
    reason = 'signal';
    line = `런이 멈췄다(${signal}) — \`harness stop\` 이나 세션 종료일 수 있다 · 그 전까지 만든 PR 은 남아 있다`;
  } else if (typeof verdict === 'string' || checkpoint?.supervisorStopReason) {
    reason = 'supervisor';
    line = `감독 판정: ${verdict ?? checkpoint?.supervisorStopReason}${typeof reasonText === 'string' && reasonText.trim() ? ` — ${reasonText.trim().split(/\r?\n/, 1)[0]}` : ''}`;
  } else {
    let applied: boolean | undefined;
    try { applied = (deps.hasJobApplied ?? hasHarnessPodJobApplied)(runId, output); } catch { /* unknown */ }
    const noLaunch = ledgerReadable && !ledger?.some((entry) => LAUNCH_EVIDENCE_EVENTS.has(entry.event))
      && applied === false && !pr;
    reason = noLaunch ? 'no-launch' : unknownPodExitTailReason(output) ?? 'unknown';
    line = noLaunch
      ? 'Pod 실행에 닿지 못했다 — 풀·컨텍스트·SSH 연결을 확인하거나 `--substrate local` 로 명시하라'
      : reason === 'unknown' ? 'Pod 실행 여부 또는 종료 이유를 확인하지 못했다'
        : `Pod 종료 출력에서 확인한 원인: ${reason}`;
  }
  try { debug.log('harness.pod', 'exit-classified', { runId, reason, status: exit.status, signal: signal ?? null }); } catch { /* observation is fail-soft */ }
  return { reason, lines: [line, ...(pr ? [`PR 이 남아 있다: ${pr}`] : [])] };
}

/** The classified status is the same exit handed to the launcher; ledger failure is never an exit failure. */
export function recordClassifiedHarnessPodExit(runId: string | undefined, reason: string, status: number,
  context: { entrance?: string; seat?: string; output?: string } = {}): void {
  if (!runId) return;
  try {
    const ledger = reason === 'preflight-refused' ? undefined : loadRunLedger(runId);
    const childEvidence = latestPodChildEvidence(ledger);
    const podTermination = latestPodTermination(ledger);
    const signal = status > 128
      ? Object.entries(osConstants.signals).find(([, number]) => number === status - 128)?.[0] ?? null : null;
    const cwd = process.cwd();
    const seat = context.seat ?? process.env.ELANOUS_HARNESS_SEAT;
    recordRunExit({ runId, reason: childEvidence?.scopeEscape === true ? 'scope-escape' : reason, status, signal, at: new Date().toISOString(),
      ...(context.entrance ? { entrance: context.entrance } : {}),
      ...(['OP', 'TC', 'MK', 'UX'].includes(seat ?? '') ? { seat } : {}),
      cwd: `${basename(dirname(cwd))}/${basename(cwd)}`, hostname: hostname().split('.')[0]!, pid: process.pid,
      ...(context.output ? { lastLines: incidentLastLines(context.output) } : {}),
      ...(childEvidence ? { childEvidence } : {}),
      ...(podTermination ? { podTermination } : {}),
    }, effectiveInstanceRoot());
  } catch { /* incident writes cannot change Pod output or exit */ }
}

/**
 * The current attempt's `pod-child-evidence` rows (same job · childRunId as the last `pod-child-run`), oldest first.
 * Also fenced by position: only rows written after that start count, so a reused job/childRunId pair cannot
 * hand an earlier attempt's row (childEvidence or podTermination) to a later one.
 */
function currentPodChildEvidenceRows(entries: readonly RunLedgerEntry[] | null | undefined): { job: string; rows: Record<string, unknown>[] } | undefined {
  // The current attempt's start is the fence. An earlier Pod's terminal facts cannot
  // classify a later attempt when that attempt has no JSON or its ledger write failed.
  let startIndex = -1;
  entries?.forEach((entry, index) => { if (entry.event === 'pod-child-run') startIndex = index; });
  const current = startIndex >= 0 ? entries![startIndex]!.data : undefined;
  if (typeof current?.job !== 'string' || typeof current.childRunId !== 'string') return undefined;
  const rows = (entries ?? []).filter((entry, index) => index > startIndex && entry.event === 'pod-child-evidence'
    && entry.data?.job === current.job && entry.data?.childRunId === current.childRunId).map((entry) => entry.data);
  return { job: current.job, rows };
}

/** JOB-FAILURE-TERMINATION-CAPTURE — the current attempt's latest well-formed capture of its own Job (a later
 *  evidence row of the same attempt without one does not drop it); another Job's or round's never crosses over. */
function latestPodTermination(entries: readonly RunLedgerEntry[] | null | undefined): PodTermination | undefined {
  const current = currentPodChildEvidenceRows(entries);
  if (!current) return undefined;
  for (const row of current.rows.slice().reverse()) {
    const parsed = parsePodTermination(row.podTermination, current.job);
    if (parsed) return parsed;
  }
  return undefined;
}

function latestPodChildEvidence(entries: readonly RunLedgerEntry[] | null | undefined): PodChildEvidence | undefined {
  const data = currentPodChildEvidenceRows(entries)?.rows.at(-1);
  const evidence = data?.childEvidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const row = evidence as Record<string, unknown>;
  const object = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (('scopeEscape' in row && row.scopeEscape !== true)
    || ('goalCauseObserved' in row && row.goalCauseObserved !== true)
    || ('classification' in row && typeof row.classification !== 'string')
    || ('newScope' in row && !Array.isArray(row.newScope))
    || ('scopeStopReasons' in row && !Array.isArray(row.scopeStopReasons))
    || ('abandonedClassification' in row && !object(row.abandonedClassification))
    || ('accountAvailability' in row && !object(row.accountAvailability))) return undefined;
  return row as PodChildEvidence;
}

/** Every Pod launch entrance (harness ask/say · dev ask --substrate pod) warns once after a recent burst; it never blocks the launch. */
export function warnRecentIncidentBurst(
  root: string = effectiveInstanceRoot(), now: Date = new Date(), write: (line: string) => void = (line) => console.error(line),
  context: { seat?: string; entrance?: string } = {},
): boolean {
  try {
    const seat = context.seat ?? process.env.ELANOUS_HARNESS_SEAT;
    const burst = recentBurst(root, now, { entrance: context.entrance,
      ...(['OP', 'TC', 'MK', 'UX'].includes(seat ?? '') ? { seat } : {}) });
    if (!burst) return false;
    write(formatIncidentBurstWarning(burst));
    try { debug.log('harness.incident', 'burst', { reason: burst.reason, count: burst.count,
      ...(burst.seat ? { seat: burst.seat } : {}), ...(burst.entrance ? { entrance: burst.entrance } : {}) }); } catch { /* observation is fail-soft */ }
    return true;
  } catch { return false; /* incident reads cannot block a launch */ }
}

function lookupHarnessSupervisorDecision(runId: string): { stopReason?: string; why?: string } | undefined {
  const path = logsDbPath();
  if (!existsSync(path)) return undefined;
  const store = LogStore.openReadOnly(path);
  try {
    let beforeId: number | undefined;
    for (;;) {
      const rows = store.query({ exactCategories: ['self-dev.supervisor'], events: ['decision'], grep: runId,
        limit: 1_000, ...(beforeId === undefined ? {} : { beforeId }) });
      for (const row of rows) {
        try {
          const data = JSON.parse(row.data ?? '{}') as Record<string, unknown>;
          if (data.runId !== runId) continue;
          return data.action === 'stop' && typeof data.stopReason === 'string'
            ? { stopReason: data.stopReason, ...(typeof data.why === 'string' ? { why: data.why } : {}) }
            : undefined;
        } catch { /* Malformed observation is not evidence. */ }
      }
      if (rows.length < 1_000) return undefined;
      beforeId = rows.at(-1)!.id;
    }
  } finally { store.close(); }
}

function hasHarnessPodJobApplied(runId: string | undefined, output: string): boolean | undefined {
  const job = output.match(/\bsi-[a-z0-9-]+\b/i)?.[0];
  if (!runId && !job) return undefined;
  const path = logsDbPath();
  if (!existsSync(path)) return undefined;
  const store = LogStore.openReadOnly(path);
  try {
    for (const needle of new Set([runId, job].filter((value): value is string => value !== undefined))) {
      let beforeId: number | undefined;
      for (;;) {
        const rows = store.query({ exactCategories: ['self-implement.pod'], events: ['job-applied'],
          grep: needle, limit: 1_000, ...(beforeId === undefined ? {} : { beforeId }) });
        if (rows.some((row) => {
          try {
            const data = JSON.parse(row.data ?? '{}') as Record<string, unknown>;
            return (runId !== undefined && data.runId === runId)
              || (job !== undefined && data.job === job && (runId === undefined || data.runId === undefined || data.runId === runId));
          } catch { return false; }
        })) return true;
        if (rows.length < 1_000) break;
        beforeId = rows.at(-1)!.id;
      }
    }
    return false;
  } finally { store.close(); }
}

/** 10-05 PODPROVIDER — say which child provider a local run will use (an unnamed choice follows config). */
function announceLocalChildProvider(opts: unknown): void {
  const child = opts as HarnessAskSayChildLlmOptions;
  if (!child.childLlmProvider?.trim()) return;
  console.error(`child provider 요청 = ${child.childLlmProvider.trim()}${child.childLlmModel?.trim() ? `/${child.childLlmModel.trim()}` : ''} (local)`);
}

/** `harness.queue.directSay` (ONEDOOR-2 · OP 10-06 기본 끔): config > env ELANOUS_HARNESS_QUEUE_DIRECT_SAY > false. */
export function harnessQueueDirectSay(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const configured = getUserConfig().harness?.queue?.directSay;
    if (typeof configured === 'boolean') return configured;
  } catch { /* An unreadable config keeps the old direct path. */ }
  const raw = env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** `harness.authorOnPod` — 명시 true 만 켠다. 읽기 실패는 끔(호스트 저작)으로 둔다. */
function harnessAuthorOnPod(): boolean {
  try { return getUserConfig().harness?.authorOnPod === true; }
  catch { return false; }
}

/** ⭐ 런 계약의 실행 칸 = pod — 호스트는 그래프를 안 돌리고 Pod 로 보낸다(harness-pod-dispatch.ts). */
async function onPod(opts: unknown, entrance: 'cli-harness-ask' | 'cli-harness-say', input: string, pool: string,
  recordDispatch: (input: DispatchTaskInput, deps?: DispatchTaskDeps) => ReturnType<typeof dispatchTask> = dispatchTask,
  authorOnPod = false): Promise<void> {
  const o = opts as HarnessSubstrateOpts;
  if (o.target !== undefined) {
    debug.log('harness.pod', 'target-refused', { target: o.target });
    console.error('`--target` 은 Pod 경로에서 아직 지원하지 않는다 — 로컬로 돌리거나 `--target` 을 빼라');
    console.error('Pod 로 특정 원천을 주려면 `--source`');
    process.exitCode = 2;
    return;
  }
  if (o.after !== undefined && !/^(?:#?[1-9]\d*|[a-f0-9]{16})$/.test(o.after.trim())) {
    console.error(`--after 는 PR 번호(#N) 또는 골 ID(16자 16진수)여야 한다: ${o.after}`);
    process.exitCode = 2;
    return;
  }
  warnRecentIncidentBurst(effectiveInstanceRoot(), new Date(), (line) => console.error(line),
    { entrance, seat: o.seat });
  let dispatchRecorded = false;
  try {
    const goalText = entrance === 'cli-harness-ask' ? readFileSync(input, 'utf8') : input;
    await recordDispatch({
      goalId: (entrance === 'cli-harness-ask' ? parseGoalId(goalText) : null)
        ?? `request-${createHash('sha256').update(goalText).digest('hex').slice(0, 32)}`,
      title: goalText.split(/\r?\n/, 1)[0]?.trim() || 'Untitled request',
      goalText,
      targetPaths: entrance === 'cli-harness-ask' ? tracedPathReferences(goalText).map((reference) => reference.path) : [],
      spec: { input: entrance === 'cli-harness-ask' ? { file: input } : { text: input }, humanReadableOutput: false },
    });
    dispatchRecorded = true;
  } catch (error) {
    try { debug.log('execution-loop.gate', 'dispatch-unavailable', { reason: String(error) }); } catch { /* fail-soft */ }
  }
  const { dispatchHarnessOnPod } = await import('./harness-pod-dispatch.js');
  let output = '';
  let runId: string | undefined;
  const child = opts as HarnessAskSayChildLlmOptions;
  const podAuthorGrade = authorOnPod && entrance === 'cli-harness-say'
    ? child.authorGradeSource && child.authorGrade
      ? { grade: child.authorGrade, source: child.authorGradeSource }
      : resolveGoalAuthorGrade(child.authorGrade, getUserConfig().harness?.authorGrade)
    : undefined;
  // 10-05 PODPROVIDER: say which child provider the Pod will use when the launch named one.
  if (child.childLlmProvider?.trim()) console.error(`child provider 요청 = ${child.childLlmProvider.trim()}${child.childLlmModel?.trim() ? `/${child.childLlmModel.trim()}` : ''} (pod · 자격 없으면 발사 전 거부)`);
  const status = await dispatchHarnessOnPod({ entrance, input, podPool: pool, ...(authorOnPod && entrance === 'cli-harness-say' ? { authorOnPod: true } : {}),
    ...(child.childLlmProvider?.trim() ? { childLlmProvider: child.childLlmProvider.trim() } : {}),
    ...(child.childLlmModel?.trim() ? { childLlmModel: child.childLlmModel.trim() } : {}),
    ...(child.childLlmEffort?.trim() ? { childLlmEffort: child.childLlmEffort.trim() } : {}), ...(authorOnPod && podAuthorGrade ? { authorGrade: podAuthorGrade.grade, authorGradeSource: podAuthorGrade.source } : {}), ...(dispatchRecorded ? { dispatchRecorded: true } : {}), ...(o.podMemory ? { podMemory: o.podMemory } : {}), ...((opts as HarnessAskSayChildLlmOptions).goalType ? { goalType: (opts as HarnessAskSayChildLlmOptions).goalType } : {}), ...(o.after ? { after: o.after } : {}), ...(o.autoMerge === false ? { autoMerge: false } : {}), ...(o.base ? { base: o.base } : {}), ...(o.json ? { json: true } : {}), ...(o.source ? { source: o.source } : {}), ...(o.repairCommitOnly ? { repairCommitOnly: o.repairCommitOnly } : {}), ...(o.seat ? { seat: o.seat } : {}) },
    { onOutput: (text) => {
      runId ??= harnessPodRunId(output + text);
      output = (output + text).slice(-16_000);
    } });
  if (status !== 0) {
    // onPod is the existing ask/say caller: classify the dispatchHarnessOnPod output for both entrances.
    const classified = classifyHarnessPodExit({ status }, output, { ...(runId ? { runId } : {}) });
    recordClassifiedHarnessPodExit(runId ?? harnessPodRunId(output), classified.reason, status,
      { entrance, seat: o.seat, output });
    recordHarnessPodStop(runId ?? harnessPodRunId(output), status, classified, output);
    for (const line of classified.lines) console.error(line);
    process.exitCode = status;
  }
}

/**
 * STOP-RECORD — a nonzero Pod exit appends one `stop` line to the host run ledger (additive: the
 * `exit-classified` log and the existing ledger stay as they are). A failed Pod Job loses its in-Pod
 * ledger, so without this line the run reads `outcome: unknown`. Skips when a stop is already recorded.
 */
export function recordHarnessPodStop(
  runId: string | undefined,
  status: number,
  classified: { reason: string; lines: string[]; podErrorCode?: 'pod-job-failed' },
  output?: string,
  deps: { loadLedger?: typeof loadRunLedger; record?: typeof recordRunStop; write?: RunLedgerWriter } = {},
): boolean {
  if (!runId) return false;
  try {
    if (runStopRecorded(runId)) return false;
    const ledger = (deps.loadLedger ?? loadRunLedger)(runId);
    if (ledger?.some((entry) => entry.event === RUN_STOP_EVENT)) return false;
    const childEvidence = latestPodChildEvidence(ledger);
    const scopeEscape = childEvidence?.scopeEscape === true;
    // SCOPE-ESCAPE-AS-REFINE — out-of-scope edits without a stop reason are «new scope», not a scope-escape stop.
    if (childEvidence?.newScope?.length || childEvidence?.scopeStopReasons?.length) {
      try {
        debug.log('harness.pod', scopeEscape ? 'scope-escape-stop' : 'scope-new-scope', { runId, scopeEscape,
          ...(childEvidence.newScope ? { newScope: childEvidence.newScope } : {}),
          ...(childEvidence.scopeStopReasons ? { scopeStopReasons: childEvidence.scopeStopReasons } : {}) });
      } catch { /* observation cannot change the stop record */ }
    }
    if (classified.reason === 'preflight-refused') {
      (deps.record ?? recordRunStop)({
        runId, site: 'preflight', class: 'launch-failed',
        cause: 'Preflight refused: occupied new traced path',
        evidenceRef: `run-ledger:${runId}:preflight-refused`,
        nextMove: 'Correct the declared new path in the goal before relaunch',
      }, ...(deps.write ? [deps.write] : []));
      return true;
    }
    const nextMove = classified.reason === 'no-launch' ? 'Check Pod launch gate and pool, then relaunch'
      : 'Inspect Pod exit classification and harvest the branch before relaunch';
    const evidenceRef = `logs:harness.pod/exit-classified:${runId}`;
    // AUT-POD-EXIT-UNCLASSIFIED ⓑ — only an unclassified exit reads the child output; classified reasons stay byte-identical.
    const detail = classified.reason === 'unknown' ? podExitDetail(runId, status, output) : undefined;
    if (detail) {
      const write = deps.write ?? ((entry: RunLedgerEntry) => appendRunLedgerEntry(entry));
      (deps.record ?? recordRunStop)({
        runId, site: 'pod-exit', class: scopeEscape ? 'scope-escape' : classifyPodExitStop(classified.reason),
        cause: `Pod exit ${status}: ${detail.podExitClass}${detail.lead ? ` — ${detail.lead}` : ''}`,
        evidenceRef, nextMove, ...(childEvidence ? { childEvidence } : {}),
      }, (entry) => write({ ...entry, data: { ...entry.data, podExitClass: detail.podExitClass, tail: detail.tail, ...detail.axes } }));
      return true;
    }
    // The classified line is our own one-line verdict («Pod 안 자식이 실패했다 — OOMKilled»), not the raw output tail.
    const verdict = classified.lines[0]?.split(' — ').slice(1).join(' — ').trim();
    const stopEntry = (deps.record ?? recordRunStop)({
      runId, site: 'pod-exit', class: scopeEscape ? 'scope-escape' : classifyPodExitStop(classified.reason),
      cause: `Pod exit ${status}: ${scopeEscape ? 'scope-escape' : classified.reason}${verdict ? ` — ${verdict}` : ''}`,
      evidenceRef, nextMove, ...(childEvidence ? { childEvidence } : {}),
      ...(classified.podErrorCode === 'pod-job-failed' ? { terminationReason: classified.podErrorCode } : {}),
    }, ...(deps.write ? [deps.write] : []));
    // Host-only Pod exits do not pass through orchestrator.autohealRecordedStop. Capture the
    // exact Job failure here, after the durable stop write, without initiating a heal action.
    if (classified.podErrorCode === 'pod-job-failed' && stopEntry) {
      try {
        const record = readRunStopRecord(stopEntry);
        if (record) {
          const goalId = ledger?.find((entry) => entry.goalId)?.goalId;
          const captured = captureStopKnowhowCandidate({ runId, ...(goalId ? { goalId } : {}), record },
          join(effectiveInstanceRoot(), 'self-implement', 'knowhow-candidates'));
          if (captured) debug.log('self-implement.autoheal', 'knowhow-candidate', {
            runId, cell: captured.candidate.cell, reason: captured.candidate.reason,
            created: captured.created, occurrences: captured.candidate.occurrences, path: captured.path,
          });
        }
      } catch (error) {
        try { debug.log('self-implement.autoheal', 'knowhow-candidate-failed', {
          runId, error: error instanceof Error ? error.message : String(error),
        }); } catch { /* observation is fail-soft */ }
      }
    }
    return true;
  } catch { return false; /* ledger observation cannot change Pod output or exit */ }
}

const POD_EXIT_TAIL_LINES = 5;
const POD_EXIT_TAIL_LINE_CHARS = 240;
const POD_EXIT_CAUSE_LEAD_CHARS = 160;

/**
 * The closed Pod exit class ⊕ the last meaningful output lines for an exit the host could not classify.
 * Empty output is no evidence at all — `unknown` with an empty tail, never a guess. Fail-soft: a throw reads as `unknown`.
 */
function podExitDetail(runId: string, status: number, output: string | undefined): { podExitClass: PodExitClass; tail: string[]; lead: string; axes: PodFailureLedgerAxes } {
  let podExitClass: PodExitClass = 'unknown';
  let tail: string[] = [];
  // The rejection's reason code · check name · untruncated path, and the absence of a child result line, are
  //   kept as their own ledger fields — the human `cause` line is bounded and cannot carry them.
  let axes: PodFailureLedgerAxes = {};
  if (output?.trim()) {
    try {
      const exit = classifyPodExit({ logs: output, containerExitCode: status });
      podExitClass = exit.class;
      tail = exit.tail.slice(-POD_EXIT_TAIL_LINES).map((line) => Array.from(line).slice(0, POD_EXIT_TAIL_LINE_CHARS).join(''));
      axes = podFailureLedgerAxes(exit);
    } catch { podExitClass = 'unknown'; tail = []; axes = {}; }
  }
  // The last meaningful line is where the child died (`Error: ENOSPC …`) — earlier tail lines are context.
  const lead = Array.from(tail.at(-1) ?? '').slice(0, POD_EXIT_CAUSE_LEAD_CHARS).join('');
  try { debug.log('harness.pod', 'exit-classified-detail', { runId, podExitClass, tailLines: tail.length, ...axes }); } catch { /* observation is fail-soft */ }
  return { podExitClass, tail, lead, axes };
}

/**
 * POD-ANTHROPIC-PROVIDER ⓓ — 발사 관문과 Pod 가 «한 목록»(`POD_CHILD_PROVIDERS`)을 본다.
 * 🩸 10-10: 관문은 anthropic 을 «예산 판정 밖» 으로 통과시켰고 Pod 단계가 rc=2 로 죽었다(관문·Pod 목록 엇갈림).
 * Pod 기질에서 목록 밖 provider 는 발사 «전»에 Pod 와 같은 문면으로 거부한다 — 로컬 기질은 판정하지 않는다.
 */
export function podChildProviderLaunchRefusal(substrate: ResolvedHarnessSubstrate['substrate'], childLlmProvider: string | undefined): string | undefined {
  return substrate === 'pod' ? podChildProviderRefusal(childLlmProvider) : undefined;
}

function refusePodChildProviderBeforeLaunch(resolved: ResolvedHarnessSubstrate, opts: { readonly childLlmProvider?: string }): boolean {
  const refusal = podChildProviderLaunchRefusal(resolved.substrate, opts.childLlmProvider);
  if (!refusal) return false;
  console.error(`❌ launch gate: ${refusal}`);
  try { debug.log('execution-loop.launch-gate', 'pod-child-provider-refused', { provider: opts.childLlmProvider?.trim() ?? null, substrate: resolved.substrate }); }
  catch { /* observation is fail-soft */ }
  process.exitCode = 2;
  return true;
}

export { harnessLaunchBudgetDecision } from '../execution-loop/launch-gate.js';

async function readHarnessLaunchBudget(
  opts: { readonly childLlmProvider?: string; readonly childLlmModel?: string } = {},
): Promise<BudgetDecision | 'unknown'> {
  try {
    const { decision, warning, unmeasuredProvider } = harnessLaunchBudgetDecision(await readBudgetInputsLive(), opts);
    if (warning) {
      console.error(`⚠️ launch gate: ${warning}`);
      try {
        if (unmeasuredProvider) debug.log('execution-loop.launch-gate', 'budget-unmeasured', { provider: unmeasuredProvider });
        if (!opts.childLlmProvider?.trim() && warning.includes('code default')) debug.log('execution-loop.launch-gate', 'budget-chain-defaulted', { warning, action: decision.action, provider: decision.provider });
      } catch { /* observation is fail-soft */ }
    }
    return decision;
  }
  catch (error) {
    try { debug.log('execution-loop.launch-gate', 'budget-unavailable', { reason: String(error) }); } catch { /* observation is fail-soft */ }
    return 'unknown';
  }
}

type BenchLaunchRow = Parameters<typeof appendBenchLedger>[0];

/** BENCH-ISOLATED-ARMS ④ — 원장 «launched» 줄. ⛔ 원장을 못 써도 발사는 막지 않는다(관측 `bench`/`ledger-unwritten`). */
function recordBenchLaunch(bench: BenchBase, opts: HarnessAskSayChildLlmOptions, substrate: string, entrance: string, deps: HarnessBenchDeps): BenchLaunchRow {
  const configDir = deps.configDir ?? getElanousConfigDir();
  const childLlmModel = opts.childLlmModel?.trim() || null;
  let round = 1;
  try { round = nextBenchRound(readBenchLedger(bench.id, configDir), childLlmModel); } catch { /* 못 읽으면 1 — 줄에 그대로 남는다 */ }
  let imageCommit: string | null = null;
  try { imageCommit = deps.imageCommit ? deps.imageCommit() : getUserConfig().harness?.imageCommit ?? null; } catch { imageCommit = null; }
  // ⭐ base sha 와 «다른 칸»이다 — base 는 자식 작업 가지의 출발점일 뿐, 부모·Pod 발사 코드는 지금 도는 코드다
  //   (10-11 사고: 부모를 base 의 옛 트리에서 띄워 옛 발사 코드가 provider 를 조용히 바꿨다).
  let parentCodeCommit: string | null = null;
  try { parentCodeCommit = deps.codeCommit ? deps.codeCommit() : codeRevision() ?? null; } catch { parentCodeCommit = null; }
  const row: BenchLaunchRow = {
    ts: new Date().toISOString(), event: 'launched', benchId: bench.id, baseBranch: bench.branch, baseSha: bench.sha,
    parentCodeCommit, imageCommit, childLlmProvider: opts.childLlmProvider?.trim() || null, childLlmModel, round,
    entrance, substrate, ...(opts.seat ? { seat: opts.seat } : {}),
  };
  try { appendBenchLedger(row, configDir); }
  catch (error) { try { debug.log(BENCH_LOG_CATEGORY, 'ledger-unwritten', { benchId: bench.id, event: 'launched', reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ } }
  return row;
}

function recordBenchFinish(launched: BenchLaunchRow, deps: HarnessBenchDeps): void {
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : Number(process.exitCode ?? 0) || 0;
  try { appendBenchLedger({ ...launched, ts: new Date().toISOString(), event: 'finished', exitCode }, deps.configDir ?? getElanousConfigDir()); }
  catch (error) { try { debug.log(BENCH_LOG_CATEGORY, 'ledger-unwritten', { benchId: launched.benchId, event: 'finished', reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ } }
}

async function dispatchHarnessAskSay(
  opts: HarnessAskSayChildLlmOptions & HarnessDryRunOpts,
  dryRunPreview: {
    readonly input: string;
    readonly entrance: string;
    readonly wouldStart: string;
    readonly goalPath?: string;
  },
  dispatch: (resolved: ResolvedHarnessSubstrate, stampedOpts: HarnessAskSayChildLlmOptions & HarnessDryRunOpts) => Promise<void>,
  gate: PreLaunchGateDeps & { readBudget?: () => Promise<BudgetDecision | 'unknown'> } = {},
  queueDeps?: HarnessQueueDeps,
  immediateLaunch?: HarnessQueueDeps['launch'],
  immediateExit?: () => Promise<number>,
  benchDeps: HarnessBenchDeps = {},
): Promise<void> {
  // HARNESS-FULL-GRAPH — 여정 조인 키는 이 발사 동안만 환경에 싣는다(자식은 그동안 물려받는다).
  const journeyPreset = Boolean(process.env[JOURNEY_KEY_ENV]?.trim());
  try { await runInjectedHarnessHandler(async () => {
    // POD-ANTHROPIC-PROVIDER ⓓ — Pod 가 못 받는 provider 는 모델 검사·대기열·관문 «전»에(그리고 `--dry-run` 머리 줄보다 먼저) 거부한다 —
    //   Pod 와 같은 목록·같은 문면. 기질 판정은 아래 resolveLaunchSubstrate 와 같은 리졸버(같은 입력)다.
    if (refusePodChildProviderBeforeLaunch(resolveHarnessSubstrate({ flag: opts as HarnessSubstrateOpts, config: getUserConfig(), env: process.env }), opts)) return;
    if (opts.childLlmModel !== undefined) await ensureOpenRouterChildModelLive(opts.childLlmProvider, opts.childLlmModel, { persist: !isHarnessDryRun(opts) });
    assertHarnessChildLlmModel(opts);
    // BENCH-ISOLATED-ARMS ① — 기준선 가지를 발사 «전»에 고정한다(꼴이 틀리거나 sha 가 어긋나면 발사 0).
    let bench: BenchBase | undefined;
    if (opts.bench !== undefined) {
      const spec = parseBenchSpec(opts.bench);
      if (opts.base !== undefined) {
        console.error(`❌ --bench 와 --base 는 함께 못 쓴다 — 벤치 base 는 ${benchBaseBranch(spec.id)} 로 정해진다`);
        process.exitCode = 2;
        return;
      }
      if (isHarnessDryRun(opts)) {
        console.log(`[dry-run] bench: ${spec.id} → base ${benchBaseBranch(spec.id)} (${spec.sha ?? '가지가 있으면 그 sha · 없으면 발사 시점 origin/main'}) · 원격 변경 없음`);
      } else {
        try {
          bench = ensureBenchBase(spec, benchDeps.git ?? defaultBenchGitRun(process.cwd()));
        } catch (error) {
          try { debug.log(BENCH_LOG_CATEGORY, 'base-refused', { benchId: spec.id, requestedSha: spec.sha ?? null, reason: error instanceof Error ? error.message : String(error) }); } catch { /* observation is fail-soft */ }
          throw error;
        }
        try { debug.log(BENCH_LOG_CATEGORY, 'base-ensured', { benchId: bench.id, branch: bench.branch, sha: bench.sha, created: bench.created }); } catch { /* observation is fail-soft */ }
        console.error(`🧪 bench ${bench.id} — base ${bench.branch} @ ${bench.sha.slice(0, 12)}${bench.created ? ' (새로 만듦)' : ' (기존 가지 · sha 일치)'}`);
        opts = { ...opts, base: bench.branch };
      }
    }
    if (isHarnessDryRun(opts)) {
      resolveLaunchSubstrate(opts);
      printHarnessLaunchDryRun(dryRunPreview);
      const repair = opts as HarnessSubstrateOpts;
      if (repair.repairCommitOnly) console.log(`[dry-run] repair forwarding: --pod-source ${repair.source} --repair-commit-only ${repair.repairCommitOnly} --no-auto-merge`);
      return;
    }
    ensureJourneyKey();
    const journey = { provenance: dryRunPreview.entrance, ...(opts.goalType ? { goalType: opts.goalType as GoalType } : {}) };
    // Resolve the launch directory once; descendants and the checkpoint retain the same identity.
    const queued = process.env.ELANOUS_HARNESS_QUEUE_LAUNCH && process.env.ELANOUS_HARNESS_SEAT;
    const queueSeat = queued === 'OP' || queued === 'TC' || queued === 'MK' || queued === 'UX' ? queued : undefined;
    let cwdSeatMemo: { seat: QueueSeat | undefined } | undefined;
    const cwdSeat = (): QueueSeat | undefined =>
      (cwdSeatMemo ??= { seat: queueSeatForCwd(process.cwd(), getUserConfig().loops?.orchestrator?.seatTrees) }).seat;
    const assigned = opts.seat ?? queueSeat ?? cwdSeat();
    const inheritedSeat = process.env.ELANOUS_HARNESS_SEAT;
    const directSay = harnessQueueDirectSay();
    const shouldQueue = directSay && opts.queue !== false && !process.env.ELANOUS_HARNESS_QUEUE_LAUNCH
      && Boolean(opts.seat ?? cwdSeat());
    const resolved = shouldQueue
      ? resolveHarnessSubstrate({ flag: opts as HarnessSubstrateOpts, config: getUserConfig(), env: process.env })
      : resolveLaunchSubstrate(opts);
    const podSeat = resolved.substrate === 'pod' && ['OP', 'TC', 'MK', 'UX'].includes(inheritedSeat ?? '')
      ? inheritedSeat as QueueSeat : undefined;
    const stampedSeat = resolved.substrate === 'pod' ? opts.seat ?? queueSeat ?? podSeat ?? assigned : assigned;
    // HARNESS-FULL-GRAPH 2판 — 대기열을 탈지는 «그래프»가 정한다. 코드는 상태 값(queued|direct)만 내고,
    // 다음 노드는 YAML(⊕ 조건이 맞는 launch 오버레이)의 intake 간선이 고른다. 기본 YAML 은 오늘과 같은 길이다.
    // ⛔ 대기열은 자리가 있어야 하고 대기열 자식·--no-queue 는 다시 줄 서지 않는다 — 그 셋은 그래프가 못 넘는다.
    const intakeLabel = shouldQueue && stampedSeat ? 'queued' : 'direct';
    // intake 는 판정만 하는 관측 노드 — 진입·출구를 한 자리에서.
    passJourneyNode('intake', { ...journey, outcome: intakeLabel });
    const intakeRoute = readJourneyEdge('intake', intakeLabel, { seat: stampedSeat ?? 'none', substrate: resolved.substrate });
    const queueEligible = opts.queue !== false && !process.env.ELANOUS_HARNESS_QUEUE_LAUNCH && Boolean(stampedSeat);
    const takeQueue = intakeTakesQueue(intakeLabel, intakeRoute, queueEligible);
    // 실제로 탄 간선을 전제 검사 «뒤»에 남긴다(그래프 답과 다르면 honored=false · 이유).
    recordJourneyEdge(intakeRoute, takeQueue ? 'queue' : 'launch-gate', intakeRoute.to === 'queue' && !takeQueue ? (opts.queue === false ? '--no-queue' : process.env.ELANOUS_HARNESS_QUEUE_LAUNCH ? 'queue-child' : 'no-seat') : undefined);
    if (directSay && opts.queue === false) {
      try { debug.log('harness.queue', 'bypass', { seat: stampedSeat ?? null, reason: '--no-queue' }); }
      catch { /* Observation must not prevent an emergency launch. */ }
    } else if (takeQueue && stampedSeat) {
      resolveNestedElanousOption(opts);
      const flags: string[] = [];
      const values: Array<[string, string | undefined]> = [
        // 벤치는 «--bench id:sha» 로 넘긴다 — 대기열 자식이 sha 를 다시 확인하고 원장 줄을 쓴다.
        ['--base', bench ? undefined : opts.base], ['--bench', bench ? `${bench.id}:${bench.sha}` : undefined],
        ['--target', opts.target], ['--correlation', opts.correlation],
        ['--goal-type', opts.goalType], ...(dryRunPreview.entrance === 'cli-harness-say' ? [['--author-grade', opts.authorGradeSource === 'flag' ? opts.authorGrade : undefined] as [string, string | undefined]] : []), ['--child-llm-provider', opts.childLlmProvider],
        ['--child-llm-model', opts.childLlmModel], ['--child-llm-effort', opts.childLlmEffort],
        ['--pod-pool', (opts as HarnessSubstrateOpts).podPool], ['--pod-memory', (opts as HarnessSubstrateOpts).podMemory],
        ['--after', (opts as HarnessSubstrateOpts).after], ['--source', (opts as HarnessSubstrateOpts).source], ['--repair-commit-only', (opts as HarnessSubstrateOpts).repairCommitOnly],
        // RUN-IDENTITY — 신분이 줄 우선순위로 흐른다(승인·선점이 읽는다 · 대기열 자식이 다시 상속).
        ['--run-priority', opts.runPriority !== undefined ? String(opts.runPriority) : undefined],
      ];
      for (const [flag, value] of values) if (value !== undefined) flags.push(flag, value);
      if ((opts as HarnessSubstrateOpts).source !== undefined && resolved.substrate !== 'pod') {
        console.error('`--source` 는 `--substrate pod` 와 함께');
        process.exitCode = 2;
        return;
      }
      if (resolved.substrate === 'pod' && opts.target !== undefined) {
        console.error('`--target` 은 Pod 경로에서 아직 지원하지 않는다 — 로컬로 돌리거나 `--target` 을 빼라');
        console.error('Pod 로 특정 원천을 주려면 `--source`');
        process.exitCode = 2;
        return;
      }
      for (const [enabled, flag] of [
        [opts.json, '--json'], [opts.yes, '--yes'], [opts.autoMerge === false, '--no-auto-merge'],
        [opts.mergeByHost, '--merge-by-host'], [opts.observeOnly, '--observe-only'],
        [opts.supervise === false, '--no-supervise'], [opts.forcePreflight, '--force-preflight'],
        [opts.forceGate, '--force-gate'],
      ] as const) if (enabled) flags.push(flag);
      let row: QueueItem;
      enterJourneyNode('queue', journey);
      try {
        row = await addHarnessQueue({ seat: stampedSeat, launchCwd: process.cwd(), refuseDuplicate: true,
        ...(dryRunPreview.goalPath ? { ask: dryRunPreview.goalPath } : { say: dryRunPreview.input }),
        ...(opts.runPriority !== undefined ? { runPriority: opts.runPriority } : {}),
        launchArgs: ['harness', dryRunPreview.goalPath ? 'ask' : 'say', dryRunPreview.goalPath ?? dryRunPreview.input,
          '--seat', stampedSeat, ...((opts as HarnessSubstrateOpts).substrate ? ['--substrate', (opts as HarnessSubstrateOpts).substrate!] : []), ...flags,
          ...(opts.nestedElanous ? ['--nested-elanous', opts.nestedElanous] : [])],
        }, queueDeps);
        await queueDeps?.afterEnqueue?.(row);
      } catch (error) {
        if (!(error instanceof HarnessQueueDuplicateError)) {
          exitJourneyNode('queue', { ...journey, outcome: 'error', data: { error: error instanceof Error ? error.message : String(error) } });
          throw error;
        }
        console.error(`발사 거절 — ${error.message.replace(/[\r\n]+/g, ' ')}`);
        exitJourneyNode('queue', { ...journey, outcome: 'refused' });
        process.exitCode = 1;
        return;
      }
      // NEEDS-OWNER-BOUNDARY (direct say/ask): the immediate-launch tick stays ungated — a person-initiated
      // command answers itself, so pre-hold launch behavior is preserved. An embedder can still opt in via
      // deps.queue.needsOwnerGate.
      const result = await withJourneyNode('queue', journey, () => tickHarnessQueue(
        { ...queueDeps, ...(immediateLaunch ? { launch: immediateLaunch } : {}), needsOwnerGate: queueDeps?.needsOwnerGate ?? false }, row.id));
      exitJourneyNode('queue', { ...journey, outcome: result.outcome === 'launched' && result.item?.id === row.id ? 'launched' : 'waiting', data: { queueItemId: row.id, queueTick: result.outcome } });
      if (result.outcome === 'launched' && result.item?.id === row.id) {
        if (immediateExit) process.exitCode = await immediateExit();
      } else if (result.outcome === 'waiting') {
        const reason = listHarnessQueue(queueDeps).find((item) => item.id === row.id)?.waitingReason ?? result.reason;
        console.log(`대기열에 들어갔다 — ${reason.replace(/[\r\n]+/g, ' ')}`);
        process.exitCode = 0;
      } else if (result.outcome === 'skipped' && result.item?.id === row.id && result.item.status !== 'queued') {
        // Another tick won the race for this row. Only a confirmed launch (pid recorded) is reported as launched;
        // a row still `launching` may yet fail, so the direct call ends non-zero instead of claiming success.
        const confirmed = (result.item.status === 'launched' || result.item.status === 'finished') && result.item.pid !== undefined;
        const log = join(queueDeps?.root ?? effectiveInstanceRoot(), 'harness', `${row.id}.log`);
        if (confirmed) console.log(`다른 대기열 tick 이 이미 발사했다 — ${row.id} (pid ${result.item.pid}) · 출력: ${log}`);
        else console.error(`다른 대기열 tick 이 발사 중이다(확정 전) — ${row.id} (${result.item.status}) · harness queue list 로 확인`);
        try { debug.log('harness.queue', 'raced-launch', { id: row.id, seat: row.seat, status: result.item.status, confirmed }); }
        catch { /* Observation cannot change the launch outcome. */ }
        process.exitCode = confirmed ? 0 : 1;
      } else {
        throw new Error(`harness queue: ${result.reason}`);
      }
      return;
    }
    // Depth >= 1 cannot re-allow. Drop the flag here so the launch sees the refusal, not the raw argv.
    const nested = resolveNestedElanousOption(opts);
    const stampedOpts = {
      ...opts,
      ...(stampedSeat ? { seat: stampedSeat } : {}),
      ...(nested.nestedElanous ? { nestedElanous: nested.nestedElanous } : { nestedElanous: undefined }),
    };
    const launch = async () => {
      const previous = process.env.ELANOUS_HARNESS_SEAT;
      if (stampedSeat) process.env.ELANOUS_HARNESS_SEAT = stampedSeat;
      else delete process.env.ELANOUS_HARNESS_SEAT;
      // The source label selects the declared author or same-PR rework edge; substrate remains data for decompose.
      passJourneyNode('dispatch', { ...journey, outcome: (stampedOpts as HarnessSubstrateOpts).repairCommitOnly ? 'pr-source' : 'fresh',
        data: { substrate: resolved.substrate } });
      const benchRow = bench ? recordBenchLaunch(bench, stampedOpts, resolved.substrate, dryRunPreview.entrance, benchDeps) : undefined;
      try { await dispatch(resolved, stampedOpts); }
      finally {
        if (benchRow) recordBenchFinish(benchRow, benchDeps);
        if (previous === undefined) delete process.env.ELANOUS_HARNESS_SEAT;
        else process.env.ELANOUS_HARNESS_SEAT = previous;
      }
    };
    // Without a GoalId, match the request to a live run's exact verbatim original ask; still check budget.
    let identity = dryRunPreview.input;
    let goalId: string | null = null;
    if (dryRunPreview.goalPath) {
      try {
        identity = readFileSync(dryRunPreview.goalPath, 'utf8');
        goalId = parseGoalId(identity);
      } catch { /* The launch handler owns file-read errors. */ }
    }
    goalId ??= launchRequestId(identity);
    // Under bun test with no injected gate deps, skip the live reads (≈5 s of codex rotation + run scans) —
    // CLI wiring tests time out on them. Gate tests inject deps or opt in with ELANOUS_LAUNCH_GATE_LIVE=1.
    if (process.env.NODE_ENV === 'test' && Object.keys(gate).length === 0 && process.env.ELANOUS_LAUNCH_GATE_LIVE !== '1') {
      try { debug.log('execution-loop.launch-gate', 'skipped-test-env', { goalId }); } catch { /* observation is fail-soft */ }
      passJourneyNode('launch-gate', { ...journey, outcome: 'pass', data: { skipped: 'test-env' } });
      await launch();
      return;
    }
    enterJourneyNode('launch-gate', journey);
    // LAUNCH-SINGLE-DOOR-1C — 부모(hand)가 소비한 영수증 상속: 이 요청이면 그 영수증으로 지나간다(한 번만 읽고 지운다).
    const inheritedLaunchDoorReceipt = process.env[LAUNCH_DOOR_RECEIPT_ENV];
    delete process.env[LAUNCH_DOOR_RECEIPT_ENV];
    // 주입된 문이 없으면 생산 우주의 기본 문을 쓴다(시험 환경은 관문 관례와 같이 건너뛴다 — 시험 단언이 단일문 때문에 바뀌지 않는다).
    const launchDoor = gate.launchDoor ?? (process.env.NODE_ENV === 'test' ? undefined : openLaunchRequestDoor({ source: dryRunPreview.entrance }));
    const launchDoorRequestId = launchDoor?.requestId(identity);
    const decision = await withJourneyNode('launch-gate', journey, async () => {
      const { budget, budgetSource, snapshotAgeSec } = await resolveLaunchBudget({
        provider: opts.childLlmProvider,
        measureLocal: gate.readBudget ?? (() => readHarnessLaunchBudget(opts)),
        env: gate.readBudget ? { ELANOUS_SUBSTRATE: 'local' } : process.env,   // an injected budget reader is a host measurement, whatever substrate runs the test
      });
      const gateDecision = preLaunchGate({ goalId, budget, budgetSource, ...(snapshotAgeSec !== undefined ? { snapshotAgeSec } : {}), forceLaunch: opts.forceGate === true }, gate);
      // LAUNCH-SINGLE-DOOR-1C — 관문을 통과한 요청만 단일문을 두드린다: 소비 영수증은 requestId 기준 최초 1회만
      // 발급되고, 이미 소비됐으면 중복 발사로 거절한다(force 와 부모 상속 영수증은 그대로 지나간다).
      if (gateDecision.action !== 'proceed' || launchDoor === undefined || launchDoorRequestId === undefined) return gateDecision;
      const doorConsumption = launchDoor.consume(launchDoorRequestId, {
        force: opts.forceGate === true,
        ...(inheritedLaunchDoorReceipt !== undefined ? { inheritedReceipt: inheritedLaunchDoorReceipt } : {}),
      });
      if (doorConsumption.status === 'refused') {
        return { ...gateDecision, action: 'blocked-duplicate' as const, reason: doorConsumption.reason };
      }
      return gateDecision;
    });
    exitJourneyNode('launch-gate', { ...journey, outcome: decision.action === 'proceed' ? 'pass' : 'refuse', data: { action: decision.action } });
    if (decision.action !== 'proceed') {
      console.error(`❌ launch gate: ${decision.action} — ${decision.reason.split(/\r?\n/, 1)[0]}`);
      process.exitCode = 3;
      return;
    }
    const warnings = [
      ...(decision.sameGoalActiveRuns === 'unknown' ? ['active runs unknown'] : []),
      ...(decision.budget === 'unknown' ? ['budget unknown'] : decision.budget.action === 'next-provider' ? [decision.budget.reasons.join(' · ') || 'next-provider'] : []),
    ];
    if (warnings.length > 0) console.error(`⚠️ launch gate: ${warnings.join(' · ').split(/\r?\n/, 1)[0]}`);
    try {
      await launch();
    } catch (error) {
      // LAUNCH-SINGLE-DOOR-1C — 발사 실패 사유를 원장에 append 한다(관측 — 소비된 영수증은 그대로다).
      if (launchDoor !== undefined && launchDoorRequestId !== undefined) {
        launchDoor.fail(launchDoorRequestId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }); } finally { if (!journeyPreset) delete process.env[JOURNEY_KEY_ENV]; }
}

function normalizeHarnessPlanOptions(opts: HarnessPlanOptions): HarnessPlanOptions {
  return {
    ...normalizeHarnessCommonOptions(opts),
    ...(Array.isArray(opts.roleLlm) && opts.roleLlm.length > 0 ? { roleLlm: opts.roleLlm } : {}),
  };
}

export type HarnessProcessParentStatus = 'absent' | 'present' | 'unknown';
export type HarnessProcessPidUniverse = 'complete' | 'subset';
export type HarnessProcessLaunchdEvidence = 'managed' | 'no-evidence' | 'unqueried';

export type HarnessLaunchdPidObservation =
  | { readonly status: 'ok'; readonly pids: readonly number[] }
  | { readonly status: 'failed'; readonly reason: string };

export interface ObserveHarnessLaunchdPidsDeps {
  readonly platform?: NodeJS.Platform | string;
  readonly execLaunchctlList?: () => string;
}

export interface HarnessProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly cpuPercent: number;
  readonly elapsedSeconds: number;
  readonly command: string;
  readonly cwd?: string;
  readonly cwdStatus?: 'observed' | 'unknown';
  readonly cwdFailureReason?: string;
  readonly ownership?: HarnessProcessOwnershipObservation;
  readonly parentStatus?: HarnessProcessParentStatus;
}

export const HARNESS_PROCESS_OWNERSHIP_ENV = {
  runId: 'ELANOUS_RUN_ID',
  originSession: 'ELANOUS_ORIGIN_SESSION',
  stateDir: 'ELANOUS_STATE_DIR',
} as const;

export type HarnessProcessOwnershipObservation =
  | {
      readonly status: 'observed';
      readonly runId?: string;
      readonly originSession?: string;
      readonly stateDir?: string;
    }
  | {
      readonly status: 'unknown';
      readonly reason: string;
    };

export interface ReadProcessOwnershipDeps {
  readonly execProcessEnv?: (pid: number) => string;
  readonly execPsEww?: (pid: number) => string;
  readonly execPsArgv?: (pid: number) => string;
  readonly argvCommand?: string;
  readonly readLinuxEnviron?: (pid: number) => string;
}

export interface HarnessProcessClassificationThresholds {
  readonly resourceCpuPercent: number;
  readonly longRunningElapsedSeconds: number;
}

export const HARNESS_PROCESS_RESOURCE_CPU_PERCENT = 50;
export const HARNESS_PROCESS_LONG_RUNNING_ELAPSED_SECONDS = 60 * 60;

export const DEFAULT_HARNESS_PROCESS_THRESHOLDS: HarnessProcessClassificationThresholds = {
  resourceCpuPercent: HARNESS_PROCESS_RESOURCE_CPU_PERCENT,
  longRunningElapsedSeconds: HARNESS_PROCESS_LONG_RUNNING_ELAPSED_SECONDS,
};

export type HarnessProcessClass = 'resource-consuming' | 'long-running-only';
export type HarnessProcessListStage = 'ps-exec' | 'ps-parse';
export type HarnessProcessWorktreeStage = 'lsof' | 'git-worktree-list';

export interface HarnessProcessListOk {
  readonly status: 'ok';
  readonly records: readonly HarnessProcessRecord[];
  readonly excludedCount: number;
  readonly livePids?: readonly number[];
  readonly pidUniverse?: HarnessProcessPidUniverse;
}

export interface HarnessProcessListIncomplete {
  readonly status: 'incomplete';
  readonly records: readonly HarnessProcessRecord[];
  readonly stage: 'ps-parse';
  readonly reason: string;
  readonly malformedCount: number;
  readonly excludedCount: number;
  readonly livePids?: readonly number[];
  readonly pidUniverse?: HarnessProcessPidUniverse;
}

export type HarnessProcessListObservation =
  | HarnessProcessListOk
  | HarnessProcessListIncomplete
  | { readonly status: 'failed'; readonly stage: HarnessProcessListStage; readonly reason: string };

export type HarnessWorktreeListObservation =
  | { readonly status: 'ok'; readonly paths: readonly string[] }
  | { readonly status: 'failed'; readonly stage: 'git-worktree-list'; readonly reason: string };

export type HarnessProcessWorktreeAssociation =
  | { readonly status: 'associated'; readonly path: string }
  | { readonly status: 'unassociated' }
  | { readonly status: 'unknown'; readonly stage: HarnessProcessWorktreeStage; readonly reason: string };

export interface HarnessProcessObservationFailure {
  readonly stage: HarnessProcessListStage;
  readonly reason: string;
  readonly malformedCount?: number;
}

export type HarnessProcessLastActivity =
  | { readonly status: 'observed'; readonly timestamp: string; readonly ageSeconds: number }
  | { readonly status: 'unknown' }
  | { readonly status: 'absent' }
  | { readonly status: 'lookup-failed' }
  | { readonly status: 'unreadable' };

/** lastActivity 는 런 원장 전이만 본다 — 로그 스토어는 안 본다. */
export const HARNESS_PROCESS_LAST_ACTIVITY_SCOPE = '원장만';
export const HARNESS_PROCESS_LAST_ACTIVITY_SCOPE_LINE =
  'lastActivity 자: 런 원장 전이만 (로그 스토어는 안 본다)';

export interface HarnessProcessLedgerEntry {
  readonly timestamp?: string;
  readonly event?: string;
  readonly data?: Record<string, unknown>;
}

export type HarnessProcessLedgerLookup = (
  runId: string,
  stateDir?: string,
) => readonly HarnessProcessLedgerEntry[] | null;

export interface HarnessProcessObservationRow extends HarnessProcessRecord {
  readonly parentStatus: HarnessProcessParentStatus;
  readonly classification: HarnessProcessClass;
  readonly worktree: HarnessProcessWorktreeAssociation;
  readonly launchd?: HarnessProcessLaunchdEvidence;
  readonly ownership: HarnessProcessOwnershipObservation;
  readonly lastActivity: HarnessProcessLastActivity;
}

export interface HarnessProcessReport {
  readonly thresholds: HarnessProcessClassificationThresholds;
  readonly observationStatus: 'ok' | 'failed' | 'incomplete';
  readonly observationFailure?: HarnessProcessObservationFailure;
  readonly excludedCount: number;
  readonly unclassifiedCount: number;
  readonly parentPresentCount: number;
  readonly resourceConsuming: readonly HarnessProcessObservationRow[];
  readonly longRunningOnly: readonly HarnessProcessObservationRow[];
  readonly parentUnknown: readonly HarnessProcessObservationRow[];
  readonly garbage: readonly GarbageProcess[];
}

export interface HarnessProcessObservationDeps {
  listProcesses?: () => HarnessProcessListObservation | readonly HarnessProcessRecord[];
  listWorktrees?: () => HarnessWorktreeListObservation | readonly string[];
  observeLaunchdPids?: () => HarnessLaunchdPidObservation;
  lookupLedger?: HarnessProcessLedgerLookup;
  openProcessHandle?: (pid: number) => HarnessProcessSignalHandle;
  readStartTime?: (pid: number) => string;
  repositoryRoot?: string;
  nowMs?: number;
  thresholds?: HarnessProcessClassificationThresholds;
  write?: (text: string) => void;
}

export function formatHarnessProcessElapsed(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

function observationFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error).trim();
  return text || 'unknown observation failure';
}

function normalizeProcessListObservation(
  listed: HarnessProcessListObservation | readonly HarnessProcessRecord[],
): HarnessProcessListObservation {
  if (Array.isArray(listed)) return { status: 'ok', records: listed, excludedCount: 0 };
  return listed as HarnessProcessListObservation;
}

function normalizeWorktreeListObservation(
  listed: HarnessWorktreeListObservation | readonly string[],
): HarnessWorktreeListObservation {
  if (Array.isArray(listed)) return { status: 'ok', paths: listed };
  return listed as HarnessWorktreeListObservation;
}

export function associateHarnessProcessWorktree(
  record: Pick<HarnessProcessRecord, 'cwd' | 'cwdStatus' | 'cwdFailureReason'>,
  worktrees: HarnessWorktreeListObservation | readonly string[],
): HarnessProcessWorktreeAssociation {
  const listed = normalizeWorktreeListObservation(worktrees);
  if (listed.status === 'failed') return { status: 'unknown', stage: listed.stage, reason: listed.reason };
  if (record.cwdStatus === 'unknown') {
    return { status: 'unknown', stage: 'lsof', reason: record.cwdFailureReason ?? 'lsof cwd unconfirmed' };
  }
  if (record.cwdStatus !== 'observed' && !record.cwd) {
    return { status: 'unknown', stage: 'lsof', reason: 'cwd unconfirmed' };
  }
  if (!record.cwd) return { status: 'unassociated' };
  const normalized = resolve(record.cwd);
  let best: string | undefined;
  for (const worktree of listed.paths) {
    const root = resolve(worktree);
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (normalized === root || normalized.startsWith(prefix)) {
      if (best === undefined || root.length > best.length) best = root;
    }
  }
  return best ? { status: 'associated', path: best } : { status: 'unassociated' };
}

const KERNEL_PARENT_PIDS = new Set([0, 1]);

export function resolveHarnessProcessParentStatus(
  record: Pick<HarnessProcessRecord, 'pid' | 'ppid' | 'parentStatus'>,
  livePids: ReadonlySet<number>,
  pidUniverse: HarnessProcessPidUniverse = 'complete',
): HarnessProcessParentStatus {
  if (record.parentStatus) return record.parentStatus;
  if (KERNEL_PARENT_PIDS.has(record.ppid)) return 'absent';
  if (livePids.has(record.ppid)) return 'present';
  if (pidUniverse === 'subset') return 'unknown';
  return 'absent';
}

export function classifyHarnessProcess(
  record: HarnessProcessRecord,
  thresholds: HarnessProcessClassificationThresholds = DEFAULT_HARNESS_PROCESS_THRESHOLDS,
): HarnessProcessClass | undefined {
  if (record.cpuPercent >= thresholds.resourceCpuPercent) return 'resource-consuming';
  if (record.elapsedSeconds >= thresholds.longRunningElapsedSeconds) return 'long-running-only';
  return undefined;
}

export function defaultLookupHarnessProcessLedger(
  runId: string,
  stateDir?: string,
): readonly HarnessProcessLedgerEntry[] | null {
  if (stateDir) {
    const ledger = loadRunLedger(runId, runLedgerDir(stateDir));
    if (ledger !== null) return ledger;
  }
  return loadFederatedRunLedger(runId, { includeTest: true });
}

export function resolveHarnessProcessLastActivity(
  ownership: HarnessProcessOwnershipObservation,
  lookupLedger: HarnessProcessLedgerLookup = defaultLookupHarnessProcessLedger,
  nowMs: number = Date.now(),
): HarnessProcessLastActivity {
  const runId = ownership.status === 'observed' ? ownership.runId : undefined;
  if (!runId) return { status: 'unknown' };
  let ledger: readonly HarnessProcessLedgerEntry[] | null;
  try {
    ledger = lookupLedger(runId, ownership.status === 'observed' ? ownership.stateDir : undefined);
  } catch {
    return { status: 'lookup-failed' };
  }
  if (ledger === null) return { status: 'absent' };
  const timestamp = ledger.at(-1)?.timestamp;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return { status: 'unreadable' };
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return { status: 'unreadable' };
  const ageSeconds = Math.max(0, Math.floor((nowMs - time) / 1000));
  return { status: 'observed', timestamp, ageSeconds };
}

export function renderHarnessProcessLastActivity(activity: HarnessProcessLastActivity): string {
  if (activity.status === 'unknown') return '미상';
  if (activity.status === 'absent') return '없음';
  if (activity.status === 'lookup-failed') return '조회 실패';
  if (activity.status === 'unreadable') return '시각 못 읽음';
  return `${activity.timestamp} (${formatHarnessProcessElapsed(activity.ageSeconds)})`;
}

function renderHarnessProcessLastActivityCell(activity: HarnessProcessLastActivity): string {
  const value = renderHarnessProcessLastActivity(activity);
  if (activity.status === 'unknown') return value;
  return `${value} · ${HARNESS_PROCESS_LAST_ACTIVITY_SCOPE}`;
}

export function parseLaunchctlListOutput(out: string): readonly number[] {
  const pids: number[] = [];
  const seen = new Set<number>();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

export function resolveHarnessProcessLaunchdEvidence(
  pid: number,
  observation: HarnessLaunchdPidObservation,
): HarnessProcessLaunchdEvidence {
  if (observation.status === 'failed') return 'unqueried';
  return observation.pids.includes(pid) ? 'managed' : 'no-evidence';
}

export function observeHarnessLaunchdPids(deps: ObserveHarnessLaunchdPidsDeps = {}): HarnessLaunchdPidObservation {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return { status: 'failed', reason: `launchctl unavailable on ${platform}` };
  try {
    const out = deps.execLaunchctlList
      ? deps.execLaunchctlList()
      : execFileSync('launchctl', ['list'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    return { status: 'ok', pids: parseLaunchctlListOutput(out) };
  } catch (error) {
    return { status: 'failed', reason: observationFailureReason(error) };
  }
}

export function buildHarnessProcessReport(
  records: HarnessProcessListObservation | readonly HarnessProcessRecord[],
  worktrees: HarnessWorktreeListObservation | readonly string[] = [],
  thresholds: HarnessProcessClassificationThresholds = DEFAULT_HARNESS_PROCESS_THRESHOLDS,
  pidUniverse: HarnessProcessPidUniverse = 'subset',
  launchd: HarnessLaunchdPidObservation = { status: 'failed', reason: 'launchd observation not supplied' },
  lookupLedger: HarnessProcessLedgerLookup = defaultLookupHarnessProcessLedger,
  nowMs: number = Date.now(),
): HarnessProcessReport {
  const listed = normalizeProcessListObservation(records);
  if (listed.status === 'failed') {
    return {
      thresholds,
      observationStatus: 'failed',
      observationFailure: { stage: listed.stage, reason: listed.reason },
      excludedCount: 0,
      unclassifiedCount: 0,
      parentPresentCount: 0,
      resourceConsuming: [],
      longRunningOnly: [],
      parentUnknown: [],
      garbage: [],
    };
  }
  const livePids = new Set(listed.livePids ?? listed.records.map((record) => record.pid));
  const universe = listed.pidUniverse ?? pidUniverse;
  const garbage = classifyGarbage(listed.records.map((record) => ({
    ...record,
    launchd: resolveHarnessProcessLaunchdEvidence(record.pid, launchd),
  })), { nowMs }).garbage;
  const resourceConsuming: HarnessProcessObservationRow[] = [];
  const longRunningOnly: HarnessProcessObservationRow[] = [];
  const parentUnknown: HarnessProcessObservationRow[] = [];
  let unclassifiedCount = 0;
  let parentPresentCount = 0;
  for (const record of listed.records) {
    if (!record.command.includes('elanous.mjs')) continue;
    const classification = classifyHarnessProcess(record, thresholds);
    if (classification === undefined) {
      unclassifiedCount += 1;
      continue;
    }
    const parentStatus = resolveHarnessProcessParentStatus(record, livePids, universe);
    if (parentStatus === 'present') {
      parentPresentCount += 1;
      continue;
    }
    const ownership = resolveHarnessProcessOwnership(record);
    const row: HarnessProcessObservationRow = {
      ...record,
      parentStatus,
      classification,
      worktree: associateHarnessProcessWorktree(record, worktrees),
      launchd: resolveHarnessProcessLaunchdEvidence(record.pid, launchd),
      ownership,
      lastActivity: resolveHarnessProcessLastActivity(ownership, lookupLedger, nowMs),
    };
    if (parentStatus === 'unknown') parentUnknown.push(row);
    else if (classification === 'resource-consuming') resourceConsuming.push(row);
    else longRunningOnly.push(row);
  }
  if (listed.status === 'incomplete') {
    return {
      thresholds,
      observationStatus: 'incomplete',
      observationFailure: {
        stage: listed.stage,
        reason: listed.reason,
        malformedCount: listed.malformedCount,
      },
      excludedCount: listed.excludedCount,
      unclassifiedCount,
      parentPresentCount,
      resourceConsuming,
      longRunningOnly,
      parentUnknown,
      garbage,
    };
  }
  return {
    thresholds,
    observationStatus: 'ok',
    excludedCount: listed.excludedCount,
    unclassifiedCount,
    parentPresentCount,
    resourceConsuming,
    longRunningOnly,
    parentUnknown,
    garbage,
  };
}

function renderWorktreeAssociation(worktree: HarnessProcessWorktreeAssociation): string {
  if (worktree.status === 'associated') return worktree.path;
  if (worktree.status === 'unassociated') return 'unassociated';
  return `확인 불가(${worktree.stage}: ${worktree.reason})`;
}

function renderLaunchdEvidence(evidence: HarnessProcessLaunchdEvidence): string {
  if (evidence === 'managed') return 'launchd 가 관리한다';
  if (evidence === 'no-evidence') return '근거 없음';
  return '못 물어봤다';
}

function renderOwnershipObservation(ownership: HarnessProcessOwnershipObservation): string {
  if (ownership.status === 'unknown') return `확인 불가(${ownership.reason})`;
  const parts: string[] = [];
  if (ownership.runId) parts.push(`run=${ownership.runId}`);
  if (ownership.originSession) parts.push(`session=${ownership.originSession}`);
  if (ownership.stateDir) parts.push(`state=${ownership.stateDir}`);
  return parts.length > 0 ? parts.join(' ') : '없음';
}

function renderHarnessProcessRow(row: HarnessProcessObservationRow): string[] {
  return [
    `- pid=${row.pid} ppid=${row.ppid} elapsed=${formatHarnessProcessElapsed(row.elapsedSeconds)} cpu=${row.cpuPercent.toFixed(1)}% worktree=${renderWorktreeAssociation(row.worktree)} lastActivity=${renderHarnessProcessLastActivityCell(row.lastActivity)}`,
    `  command=${row.command}`,
    `  launchd=${renderLaunchdEvidence(row.launchd ?? 'unqueried')}`,
    `  ownership=${renderOwnershipObservation(row.ownership)}`,
  ];
}

function renderGarbageGroup(garbage: readonly GarbageProcess[]): string[] {
  return [
    `가비지 ${garbage.length}:`,
    ...garbage.map((row) => `- pid=${row.pid} ppid=${row.ppid} elapsed=${formatHarnessProcessElapsed(row.elapsedSeconds)} reason=${row.reason} command=${row.command.slice(0, 120)}`),
  ];
}

export function renderHarnessProcessReport(report: HarnessProcessReport): string[] {
  const { resourceCpuPercent, longRunningElapsedSeconds } = report.thresholds;
  const lines = [
    '━━ harness processes (READ-ONLY) ━━',
    '프로세스를 죽이지 않는다 — 종료는 사람 판단이다',
    `분류 기준: 자원소비 CPU >= ${resourceCpuPercent}% · 장기실행만 경과 >= ${formatHarnessProcessElapsed(longRunningElapsedSeconds)} 그리고 CPU < ${resourceCpuPercent}%`,
    '대상: 부모 부재가 확인된 프로세스만 자원소비/장기실행만에 넣는다',
    HARNESS_PROCESS_LAST_ACTIVITY_SCOPE_LINE,
  ];
  if (report.observationStatus === 'failed') {
    const failure = report.observationFailure;
    lines.push(`관찰 실패/확인 불가 (${failure?.stage ?? 'ps-exec'}: ${failure?.reason ?? 'unknown observation failure'})`);
    lines.push('자원소비와 장기실행만은 확인하지 않았다 — 빈 관찰이 아니다');
    lines.push('가비지 확인 불가 — ps 관찰 실패');
    return lines;
  }
  if (report.observationStatus === 'incomplete') {
    const failure = report.observationFailure;
    lines.push(`불완전 관측 (ps-parse: ${failure?.reason ?? 'unparseable ps rows'}) · 해석 실패 ${failure?.malformedCount ?? 0}행`);
    lines.push('일부 행만 해석됐다 — 아래 수는 확정이 아니다');
  }
  if (report.excludedCount > 0) {
    lines.push(`모집단 제외 ${report.excludedCount}행`);
    lines.push('제외 기준: command에 elanous.mjs가 없고 시험 데몬·러너 대상도 아닌 행');
  }
  lines.push(`분류 제외 ${report.unclassifiedCount}행`);
  lines.push(`부모 생존 제외 ${report.parentPresentCount}행`);
  lines.push(`자원소비 ${report.resourceConsuming.length} · 장기실행만 ${report.longRunningOnly.length}`);
  if (report.parentUnknown.length > 0) lines.push(`부모 확인 불가 ${report.parentUnknown.length} — 자원소비/장기실행만에 넣지 않았다`);
  const empty = report.resourceConsuming.length === 0 && report.longRunningOnly.length === 0 && report.parentUnknown.length === 0;
  if (empty && report.observationStatus === 'ok') {
    if (report.garbage.length === 0) lines.push('관찰 대상 없음');
    lines.push(...renderGarbageGroup(report.garbage));
    return lines;
  }
  if (empty && report.observationStatus === 'incomplete') {
    lines.push('해석된 행 중 분류 대상이 없다 — 빈 관찰이 아니다');
    lines.push(...renderGarbageGroup(report.garbage));
    return lines;
  }
  if (report.resourceConsuming.length > 0) {
    lines.push('자원소비:');
    for (const row of report.resourceConsuming) lines.push(...renderHarnessProcessRow(row));
  }
  if (report.longRunningOnly.length > 0) {
    lines.push('장기실행만:');
    for (const row of report.longRunningOnly) lines.push(...renderHarnessProcessRow(row));
  }
  if (report.parentUnknown.length > 0) {
    lines.push('부모 확인 불가:');
    for (const row of report.parentUnknown) lines.push(...renderHarnessProcessRow(row));
  }
  lines.push(...renderGarbageGroup(report.garbage));
  return lines;
}

function parsePsEtime(raw: string): number | undefined {
  const daysSplit = raw.split('-');
  let days = 0;
  let clock = raw;
  if (daysSplit.length === 2) {
    days = Number(daysSplit[0]);
    clock = daysSplit[1] ?? '';
  }
  if (!Number.isFinite(days)) return undefined;
  const parts = clock.split(':').map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return days * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return days * 86400 + parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return days * 86400 + parts[0]!;
  return undefined;
}

type ParsedHarnessProcessPsLine =
  | { readonly kind: 'record'; readonly record: HarnessProcessRecord }
  | { readonly kind: 'blank' }
  | { readonly kind: 'excluded'; readonly pid: number }
  | { readonly kind: 'malformed'; readonly line: string; readonly pid?: number };

function parseHarnessProcessPsPid(line: string): number | undefined {
  const match = /^\s*(\d+)\s+(\d+)\b/.exec(line);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}

function parseHarnessProcessPsLine(line: string): ParsedHarnessProcessPsLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'blank' };
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\S+)\s+(.*)$/.exec(line);
  if (!match) return { kind: 'malformed', line: trimmed, pid: parseHarnessProcessPsPid(line) };
  const command = match[5]!.trim();
  const pid = Number(match[1]);
  if (!isGarbageProcessTarget(command)) return { kind: 'excluded', pid };
  const elapsedSeconds = parsePsEtime(match[4]!);
  if (elapsedSeconds === undefined) return { kind: 'malformed', line: trimmed, pid };
  return {
    kind: 'record',
    record: {
      pid,
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]!.replace(',', '.')),
      elapsedSeconds,
      command,
    },
  };
}

export function parseHarnessProcessPsOutput(out: string): HarnessProcessListObservation {
  const records: HarnessProcessRecord[] = [];
  const malformed: string[] = [];
  const livePids: number[] = [];
  const seenPids = new Set<number>();
  let excludedCount = 0;
  let sawContent = false;
  let pidUniverse: HarnessProcessPidUniverse = 'complete';
  const rememberPid = (pid: number | undefined): void => {
    if (pid === undefined) {
      pidUniverse = 'subset';
      return;
    }
    if (seenPids.has(pid)) return;
    seenPids.add(pid);
    livePids.push(pid);
  };
  for (const line of out.split('\n')) {
    const parsed = parseHarnessProcessPsLine(line);
    if (parsed.kind === 'blank') continue;
    if (parsed.kind === 'excluded') {
      excludedCount++;
      rememberPid(parsed.pid);
      continue;
    }
    sawContent = true;
    rememberPid(parsed.kind === 'record' ? parsed.record.pid : parsed.pid);
    if (parsed.kind === 'malformed') {
      malformed.push(parsed.line);
      continue;
    }
    records.push(parsed.record);
  }
  if (malformed.length > 0) {
    const reason = `unparseable ps rows: ${malformed.slice(0, 3).join(' | ')}`;
    if (records.length === 0 && sawContent) return { status: 'failed', stage: 'ps-parse', reason };
    return {
      status: 'incomplete',
      records,
      stage: 'ps-parse',
      reason,
      malformedCount: malformed.length,
      excludedCount,
      livePids,
      pidUniverse,
    };
  }
  return { status: 'ok', records, excludedCount, livePids, pidUniverse };
}

function readProcessCwd(pid: number): Pick<HarnessProcessRecord, 'cwd' | 'cwdStatus' | 'cwdFailureReason'> {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((entry) => entry.startsWith('n'));
    const cwd = line?.slice(1).trim();
    if (!cwd) return { cwdStatus: 'unknown', cwdFailureReason: 'lsof cwd missing' };
    return { cwd, cwdStatus: 'observed' };
  } catch (error) {
    return { cwdStatus: 'unknown', cwdFailureReason: observationFailureReason(error) };
  }
}

/** One `lsof` for many pids (a per-pid lsof costs ~0.1–0.3 s); lsof exits 1 when some pid is gone yet prints the rest. */
function batchProcessCwdReader(pids: readonly number[]): (pid: number) => Pick<HarnessProcessRecord, 'cwd' | 'cwdStatus' | 'cwdFailureReason'> {
  const cwds = new Map<number, string>();
  let failure: string | undefined;
  if (pids.length) {
    const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.error || typeof result.stdout !== 'string') failure = observationFailureReason(result.error ?? new Error('lsof output missing'));
    else {
      let current: number | undefined;
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('p')) current = Number(line.slice(1));
        else if (line.startsWith('n') && current !== undefined && line.length > 1) cwds.set(current, line.slice(1).trim());
      }
    }
  }
  return (pid) => {
    const cwd = cwds.get(pid);
    return cwd ? { cwd, cwdStatus: 'observed' } : { cwdStatus: 'unknown', cwdFailureReason: failure ?? 'lsof cwd missing' };
  };
}

const OWNERSHIP_ENV_KEYS = new Set<string>(Object.values(HARNESS_PROCESS_OWNERSHIP_ENV));

function ownershipValueFromEntry(entry: string, key: string): string | undefined {
  const prefix = `${key}=`;
  if (!entry.startsWith(prefix)) return undefined;
  const value = entry.slice(prefix.length);
  return value.length > 0 ? value : undefined;
}

function parseOwnershipEnvEntries(entries: readonly string[]): HarnessProcessOwnershipObservation {
  let runId: string | undefined;
  let originSession: string | undefined;
  let stateDir: string | undefined;
  for (const entry of entries) {
    if (!entry.includes('=')) continue;
    const key = entry.slice(0, entry.indexOf('='));
    if (!OWNERSHIP_ENV_KEYS.has(key)) continue;
    const value = ownershipValueFromEntry(entry, key);
    if (key === HARNESS_PROCESS_OWNERSHIP_ENV.runId) runId = value;
    else if (key === HARNESS_PROCESS_OWNERSHIP_ENV.originSession) originSession = value;
    else if (key === HARNESS_PROCESS_OWNERSHIP_ENV.stateDir) stateDir = value;
  }
  return {
    status: 'observed',
    ...(runId ? { runId } : {}),
    ...(originSession ? { originSession } : {}),
    ...(stateDir ? { stateDir } : {}),
  };
}

export function parseProcessOwnershipEnv(out: string): HarnessProcessOwnershipObservation {
  return parseOwnershipEnvEntries(out.split('\0'));
}

function extractPsEwwCommandColumn(out: string): string | undefined {
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*PID\b/.test(line) && /\bCOMMAND\b/.test(line)) continue;
    const match = /^\s*\d+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
    if (!match) return undefined;
    const command = match[1]!.trim();
    return command.length > 0 ? command : undefined;
  }
  return undefined;
}

function envRegionAfterConfirmedArgvPrefix(commandColumn: string, argvCommand: string): string | undefined {
  const argv = argvCommand.trim();
  const column = commandColumn.trim();
  if (argv.length === 0) return undefined;
  const matches: number[] = [];
  for (let index = 0; index <= column.length - argv.length; index++) {
    if (column.slice(index, index + argv.length) !== argv) continue;
    const end = index + argv.length;
    const beforeOk = index === 0 || /\s/.test(column[index - 1]!);
    const afterOk = end === column.length || /\s/.test(column[end]!);
    if (beforeOk && afterOk) matches.push(index);
  }
  if (matches.length !== 1 || matches[0] !== 0) return undefined;
  return column.slice(argv.length).trimStart();
}

function parsePsEwwEnvRegion(envRegion: string): HarnessProcessOwnershipObservation {
  const assignmentRe = /(^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g;
  const assignments: Array<{ key: string; keyStart: number; valueStart: number }> = [];
  for (const match of envRegion.matchAll(assignmentRe)) {
    const lead = match[1] ?? '';
    assignments.push({
      key: match[2]!,
      keyStart: (match.index ?? 0) + lead.length,
      valueStart: (match.index ?? 0) + match[0].length,
    });
  }
  const entries: string[] = [];
  for (let i = 0; i < assignments.length; i++) {
    const current = assignments[i]!;
    if (!OWNERSHIP_ENV_KEYS.has(current.key)) continue;
    const valueEnd = i + 1 < assignments.length ? assignments[i + 1]!.keyStart : envRegion.length;
    entries.push(`${current.key}=${envRegion.slice(current.valueStart, valueEnd).trimEnd()}`);
  }
  return parseOwnershipEnvEntries(entries);
}

export function parsePsEwwOwnershipEnv(out: string, argvCommand: string): HarnessProcessOwnershipObservation {
  const commandColumn = extractPsEwwCommandColumn(out);
  if (commandColumn === undefined) return { status: 'unknown', reason: 'ps eww: command column unreadable' };
  const envRegion = envRegionAfterConfirmedArgvPrefix(commandColumn, argvCommand);
  if (envRegion === undefined) return { status: 'unknown', reason: 'ps eww: argv prefix unconfirmed' };
  return parsePsEwwEnvRegion(envRegion);
}

export function resolveHarnessProcessOwnership(
  record: Pick<HarnessProcessRecord, 'ownership'>,
): HarnessProcessOwnershipObservation {
  return record.ownership ?? { status: 'unknown', reason: 'ownership unconfirmed' };
}

function readLinuxEnvironFile(pid: number): string {
  return readFileSync(`/proc/${pid}/environ`, { encoding: 'utf8' });
}

function readPsEwwOutput(pid: number): string {
  const out = execFileSync('ps', ['eww', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (typeof out !== 'string' || !out.trim()) throw new Error('ps eww: empty output');
  return out;
}

function readPsArgv(pid: number): string {
  const out = execFileSync('ps', ['-www', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const argv = typeof out === 'string' ? out.trim() : '';
  if (!argv) throw new Error('ps argv: empty output');
  return argv;
}

function readPsEwwOwnership(pid: number, deps: ReadProcessOwnershipDeps): HarnessProcessOwnershipObservation {
  const out = (deps.execPsEww ?? readPsEwwOutput)(pid);
  if (typeof out !== 'string' || !out.trim()) throw new Error('ps eww: empty output');
  const argv = deps.argvCommand ?? (deps.execPsArgv ?? readPsArgv)(pid);
  return parsePsEwwOwnershipEnv(out, argv);
}

export function readProcessOwnership(
  pid: number,
  deps: ReadProcessOwnershipDeps = {},
): HarnessProcessOwnershipObservation {
  try {
    if (deps.execProcessEnv) {
      try {
        return parseProcessOwnershipEnv(deps.execProcessEnv(pid));
      } catch {
        return readPsEwwOwnership(pid, deps);
      }
    }
    const tryLinuxFirst = deps.readLinuxEnviron !== undefined || deps.execPsEww === undefined;
    if (tryLinuxFirst) {
      try {
        return parseProcessOwnershipEnv((deps.readLinuxEnviron ?? readLinuxEnvironFile)(pid));
      } catch {
        return readPsEwwOwnership(pid, deps);
      }
    }
    return readPsEwwOwnership(pid, deps);
  } catch (error) {
    return { status: 'unknown', reason: observationFailureReason(error) };
  }
}

/** Narrows the per-process reads (`lsof` cwd ≈ 0.1 s each · `ps eww`) of `defaultListHarnessProcesses`. */
export interface HarnessProcessListOptions {
  /** Keep only matching records; the others are dropped before any per-process read. */
  readonly include?: (record: HarnessProcessRecord) => boolean;
  /** Skip the ownership (`ps eww`) read — for callers that only need the cwd. */
  readonly cwdOnly?: boolean;
  /** Wall-clock budget for the per-process reads; records past it keep `cwdStatus: 'unknown'` (reason names the budget). */
  readonly deadlineMs?: number;
  readonly readCwd?: (pid: number) => Pick<HarnessProcessRecord, 'cwd' | 'cwdStatus' | 'cwdFailureReason'>;
  readonly psOutput?: () => string;
  readonly clock?: () => number;
}

export function defaultListHarnessProcesses(options: HarnessProcessListOptions = {}): HarnessProcessListObservation {
  let out: string;
  try {
    out = options.psOutput ? options.psOutput() : execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,etime=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return { status: 'failed', stage: 'ps-exec', reason: observationFailureReason(error) };
  }
  const parsed = parseHarnessProcessPsOutput(out);
  if (parsed.status === 'failed') return parsed;
  const clock = options.clock ?? Date.now;
  const selected = options.include ? parsed.records.filter(options.include) : parsed.records;
  const readCwd = options.readCwd ?? (options.cwdOnly ? batchProcessCwdReader(selected.map((record) => record.pid)) : readProcessCwd);
  const deadline = options.deadlineMs === undefined ? Infinity : clock() + options.deadlineMs;
  const records = selected.map((record) => {
    // A host with hundreds of harness processes made the serial reads take minutes (10-08 queue tick hang).
    if (clock() >= deadline) {
      return { ...record, cwdStatus: 'unknown' as const, cwdFailureReason: `observation deadline ${options.deadlineMs}ms exceeded` };
    }
    return {
      ...record,
      ...readCwd(record.pid),
      ...(options.cwdOnly ? {} : { ownership: readProcessOwnership(record.pid) }),
    };
  });
  if (parsed.status === 'incomplete') {
    return {
      status: 'incomplete',
      records,
      stage: parsed.stage,
      reason: parsed.reason,
      malformedCount: parsed.malformedCount,
      excludedCount: parsed.excludedCount,
      livePids: parsed.livePids,
      pidUniverse: parsed.pidUniverse,
    };
  }
  return {
    status: 'ok',
    records,
    excludedCount: parsed.excludedCount,
    livePids: parsed.livePids,
    pidUniverse: parsed.pidUniverse,
  };
}

function defaultListHarnessWorktreePaths(): HarnessWorktreeListObservation {
  try {
    const result = runGitCommand(process.cwd(), ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) {
      return {
        status: 'failed',
        stage: 'git-worktree-list',
        reason: result.stderr.trim() || `git worktree list failed (status=${result.status})`,
      };
    }
    const paths: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
    }
    return { status: 'ok', paths };
  } catch (error) {
    return { status: 'failed', stage: 'git-worktree-list', reason: observationFailureReason(error) };
  }
}

/** 사람 모드 한 줄. JSON 은 호출자가 마지막 줄에 따로 찍는다. */
export function formatBudgetLine(decision: BudgetDecision): string {
  const who = decision.provider
    ? `${decision.provider}${decision.model ? `/${decision.model}` : ''}`
    : '(provider 없음)';
  const why = decision.reasons.length > 0 ? decision.reasons.join(' · ') : '(이유 없음)';
  return `budget: ${decision.action} ${who} — ${why}`;
}

/** 마지막 줄 JSON. `outcome` 은 그래프 러너가 간선을 고르는 칸과 같은 이름이다. */
export function budgetOutcomeJson(decision: BudgetDecision): string {
  return JSON.stringify({
    outcome: decision.action,
    provider: decision.provider ?? null,
    model: decision.model ?? null,
    reasons: [...decision.reasons],
  });
}

/**
 * `elanous harness budget [--json]`.
 * 읽기(`readBudgetInputs`)와 판정(`decideBudget`)을 이 순서로 부른다.
 * dev-cli·흡수 크론에 자동 적용하지 않는다.
 */
export async function runHarnessBudget(opts: { json?: boolean } = {}, io: {
  log: (line: string) => void;
  read?: () => BudgetInputs | Promise<BudgetInputs>;
} = { log: (line) => console.log(line) }): Promise<BudgetDecision> {
  const inputs = await (io.read ?? readBudgetInputsLive)();
  const decision = decideBudget(inputs);
  try {
    debug.log('harness.budget-gate', 'decided', {
      action: decision.action,
      provider: decision.provider,
      reasons: [...decision.reasons],
    });
  } catch { /* observation must not block the decision */ }
  if (opts.json) {
    io.log(budgetOutcomeJson(decision));
  } else {
    io.log(formatBudgetLine(decision));
  }
  return decision;
}

const DRAFT_SWEEP_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A review body still names a must-fix. «must-fix 0» and «must-fix: 0» are a cleared list, not a remaining one. */
function mustFixRemains(text: string): boolean {
  if (!/(?:^|\n)\s*(?:[-*]\s*)?(?:must-fix|must fix)\b/i.test(text)) return false;
  return !/(?:^|\n)\s*(?:[-*]\s*)?(?:must-fix|must fix)\s*[:=]?\s*0\b/i.test(text);
}

type GithubPull = {
  number: number;
  title: string;
  draft: boolean;
  state: 'open' | 'closed';
  head: { ref: string; sha?: string };
  base?: { ref: string };
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at?: string;
  merged_at: string | null;
  body?: string | null;
  merge_commit_sha?: string | null;
};

type GhExecute = (args: string[]) => string;

// Explicit env preserves the augmented PATH under Bun (cron may start with a minimal PATH).
// Authentication comes from the same automation policy used by the PR manager, not the user's keyring.
// Failure details are bounded and redact the token before reaching the sweep result or debug log.
function ghFailure(args: string[], error: unknown, token: string | undefined): Error {
  const failure = error as { status?: number | null; code?: number | string; stderr?: string | Buffer };
  const exit = failure.status ?? (typeof failure.code === 'number' ? failure.code : 'unknown');
  const stderr = String(failure.stderr ?? '');
  const stderrTail = (token ? stderr.replaceAll(token, '[REDACTED]') : stderr).slice(-300).replace(/[\r\n]+/g, ' ').trim();
  try { debug.log('harness.drafts', 'gh-failed', { args0: args[0], exit, stderrTail }); }
  catch { /* Logging must not hide the gh failure. */ }
  // gh never ran (e.g. «Executable not found: gh»): no exit or stderr to report, so keep the spawn error itself.
  if (typeof failure.status !== 'number' && !stderrTail && error instanceof Error) return error;
  return new Error(`gh ${args.slice(0, 2).join(' ')} exit=${exit}: ${stderrTail}`);
}

const executeGh: GhExecute = (args) => {
  const env = ghAutomationEnv(process.env);
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env,
    });
  } catch (error) { throw ghFailure(args, error, env.GH_TOKEN); }
};

/** Merge-time adapter: reuse the sweep's GitHub inventory and worktree liveness without a second triage implementation. */
export async function supersedeMergedGoalDrafts(
  number: number, cwd: string,
  execute: GhExecute = executeGh, git: DraftSweepGitExecute = runGitCommand,
  options: { onlyExplicitSameCell?: boolean } = {},
): Promise<void> {
  const remote = git(cwd, ['config', '--get', 'remote.origin.url']);
  const repository = remote.status === 0 ? githubRemoteRepository(remote.stdout) : undefined;
  if (!repository) throw new Error('Merge repository unavailable');
  // The PR can change between open and merge; never authorize a close using locally reconstructed metadata.
  const pr = ghJson<GithubPull>(['api', `repos/${repository}/pulls/${number}`], execute);
  if (!pr || pr.number !== number || pr.state !== 'closed' || !pr.merged_at || !pr.title?.trim()
    || !pr.head?.ref?.trim() || !pr.created_at || !Array.isArray(pr.labels)
    || !Number.isFinite(Date.parse(pr.created_at)) || !Number.isFinite(Date.parse(pr.merged_at))
    || Date.parse(pr.merged_at) < Date.parse(pr.created_at)) {
    throw new Error('Merged PR metadata unavailable');
  }
  const merged: SweepMergedPr & { createdAt: string; mergedAt: string } = {
    number: pr.number, title: pr.title, body: pr.body ?? undefined, branch: pr.head.ref,
    createdAt: pr.created_at, mergedAt: pr.merged_at,
  };
  if (options.onlyExplicitSameCell && !/^Supersedes:\s*#\d+\s*$/m.test(merged.body ?? '')) return;
  const { supersedeDraftsOnMerge } = await import('../self-dev/draft-sweep.js');
  await supersedeDraftsOnMerge({ repository, merged, adapters: githubDraftSweepAdapters(execute, git, cwd),
    ...(options.onlyExplicitSameCell ? { onlyExplicitSameCell: true } : {}) });
}

/**
 * SIBLING-RESYNC-ON-MERGE — merge-time adapter: open harness PRs whose files intersect the merged PR get a
 * resync memo in their live run's control inbox, or the quiet `elanous:needs-rebase` marker when no run is alive.
 */
export async function resyncMergedSiblings(
  number: number, cwd: string,
  execute: GhExecute = executeGh, git: DraftSweepGitExecute = runGitCommand,
  overrides: Partial<Pick<SiblingResyncAdapters, 'resolveRun' | 'sendResync'>> & {
    maxFetch?: number; fetchConcurrency?: number; log?: (category: string, event: string, data: Record<string, unknown>) => void;
  } = {},
): Promise<SiblingResyncResult> {
  const remote = git(cwd, ['config', '--get', 'remote.origin.url']);
  const repository = remote.status === 0 ? githubRemoteRepository(remote.stdout) : undefined;
  if (!repository) throw new Error('Merge repository unavailable');
  const sweep = githubDraftSweepAdapters(execute, git, cwd);
  const [{ requestSiblingResync }, inbox, pod] = await Promise.all([
    import('../self-implement/sibling-resync.js'),
    import('./control-inbox.js'),
    import('./self-send-target.js'),
  ]);
  const maxFetch = overrides.maxFetch ?? (() => {
    try { return getUserConfig().harness?.siblingResync?.maxFetch; } catch { return undefined; }
  })();
  let ledgerMatches: readonly RunLedgerMatch[] | undefined;
  return requestSiblingResync({
    merged: { number },
    ...(maxFetch !== undefined ? { maxFetch } : {}),
    ...(overrides.fetchConcurrency !== undefined ? { fetchConcurrency: overrides.fetchConcurrency } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
    adapters: {
      mergedFiles: async () => sweep.getPrFiles!(repository, number),
      listOpenPrs: async () => {
        const all: GithubPull[] = [];
        for (let page = 1; page <= 100; page++) {
          const batch = githubPullsPage(repository, 'open', page, execute);
          if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete open PR inventory');
          all.push(...batch);
          if (batch.length < 100) break;
          if (page === 100) throw new Error('Open PR inventory exceeded pagination limit');
        }
        // No per-PR call here: the core prefilters, prioritizes and caps file fetches (#24893 review should-fix ①).
        return all.filter((pr) => pr.base?.ref === 'main' && pr.head?.ref?.startsWith('self-impl/') && pr.number !== number)
          .map((pr) => ({ number: pr.number, branch: pr.head.ref, labels: pr.labels.map((label) => label.name) }));
      },
      prFiles: async (prNumber) => sweep.getPrFiles!(repository, prNumber),
      resolveRun: overrides.resolveRun ?? (async (pr) => {
        ledgerMatches ??= listRunLedgers().matches;
        return resolveOwningRunForPr(ledgerMatches, repository, pr.number, 'sibling-resync');
      }),
      sendResync: overrides.sendResync ?? (({ spaceId }, memo) => deliverResyncMemo(spaceId, memo, inbox, pod)),
      addMarker: async (prNumber, label) => sweep.setLabels(repository, prNumber, { add: label, remove: [] }),
    },
  });
}

/** The PR's owning run, alive only when running and its control screen resolves (shared by SIBLING-RESYNC and RUN-TTL). */
function resolveOwningRunForPr(ledgerMatches: readonly RunLedgerMatch[], repository: string, number: number,
  caller: string): SiblingRunTarget {
  const runId = currentDraftSweepRunId(ledgerMatches, repository, number);
  if (!runId) return { alive: false, reason: 'owner-run-unknown' };
  const status = queryRunningRuns({ runIds: [runId], caller }).entries.find((entry) => entry.runId === runId)?.status;
  if (status !== 'running' && status !== 'probable-running') return { alive: false, runId, reason: `run-${status ?? 'not-running'}` };
  const screen = queryRunScreenKey(runId).screenKey;
  if (!screen) return { alive: false, runId, reason: 'screen-key-unresolved' };
  return { alive: true, runId, spaceId: screen };
}

/** One supervisor memo into a live run's control inbox — Pod runs through their fragment, host runs through the file inbox. */
function deliverResyncMemo(spaceId: string, memo: ControlMemoPayload,
  inbox: typeof import('./control-inbox.js'), pod: typeof import('./self-send-target.js')): void {
  if (pod.readPodFragment(spaceId)) {
    if (!pod.dispatchPodSelfSend(spaceId, { memo })) throw new Error('pod fragment unreachable');
    return;
  }
  inbox.enqueueControlMemo(spaceId, memo, { explicitInboxDir: inbox.controlInboxPath(spaceId) });
}

const execFileAsync = promisify(execFile);
const executeGhAsync = async (args: string[]): Promise<string> => {
  const env = ghAutomationEnv(process.env);
  try {
    return (await execFileAsync('gh', args, {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env,
    })).stdout;
  } catch (error) { throw ghFailure(args, error, env.GH_TOKEN); }
};

/** RUN-TTL adapters: open self-impl PRs, head commit time (async, bounded by the core), owning run, memo, label. */
export async function githubRunTtlAdapters(repository: string, execute: GhExecute = executeGh,
  executeAsync: (args: string[]) => Promise<string> = executeGhAsync, root: string = effectiveInstanceRoot(),
  shared: Partial<Pick<GithubDraftSweepAdapters, 'openPullRequests' | 'runLedgerMatches'>> = {}): Promise<RunTtlAdapters> {
  const [inbox, pod] = await Promise.all([import('./control-inbox.js'), import('./self-send-target.js')]);
  const ledger = join(root, 'run-ttl', 'memos.jsonl');
  let sent: Set<string> | undefined;
  const loadSent = (): Set<string> => {
    if (sent) return sent;
    sent = new Set<string>();
    try {
      for (const line of readFileSync(ledger, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const key = (JSON.parse(line) as { key?: unknown }).key; if (typeof key === 'string') sent.add(key); } catch { /* skip */ }
      }
    } catch (error) {
      // Only a missing journal is «nothing sent yet»; an unreadable one cannot prove «once».
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { sent = undefined; throw error; }
    }
    return sent;
  };
  let ledgerMatches: readonly RunLedgerMatch[] | undefined;
  return {
    listOpenPrs: async () => {
      const all: GithubPull[] = [];
      // Inside the draft sweep the open listing is already in memory — one listing per sweep (DRAFT-SWEEP-SLOW).
      if (shared.openPullRequests) all.push(...await shared.openPullRequests(repository));
      else for (let page = 1; page <= 100; page++) {
        const batch = githubPullsPage(repository, 'open', page, execute);
        if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete open PR inventory');
        all.push(...batch);
        if (batch.length < 100) break;
        if (page === 100) throw new Error('Open PR inventory exceeded pagination limit');
      }
      return all.filter((pr) => pr.base?.ref === 'main' && pr.head?.ref?.startsWith('self-impl/') && typeof pr.head.sha === 'string')
        .map((pr) => ({ number: pr.number, branch: pr.head.ref, labels: pr.labels.map((label) => label.name),
          createdAt: pr.created_at, headSha: pr.head.sha! }));
    },
    lastCommitAt: async (pr) => {
      const rows = JSON.parse(await executeAsync(['api', `repos/${repository}/commits?sha=${pr.headSha}&per_page=1`])) as
        Array<{ sha?: string; commit?: { committer?: { date?: string } } }>;
      const head = Array.isArray(rows) ? rows[0] : undefined;
      return head?.sha === pr.headSha ? head.commit?.committer?.date : undefined;
    },
    resolveRun: async (pr) => {
      ledgerMatches ??= shared.runLedgerMatches?.() ?? listRunLedgers().matches;
      return resolveOwningRunForPr(ledgerMatches, repository, pr.number, 'run-ttl');
    },
    sendMemo: ({ spaceId }, memo) => deliverResyncMemo(spaceId, memo, inbox, pod),
    addLabel: async (prNumber, label) => { execute(['pr', 'edit', String(prNumber), '--repo', repository, '--add-label', label]); },
    memoSent: (key) => loadSent().has(key),
    recordMemoSent: (key) => {
      mkdirSync(dirname(ledger), { recursive: true });
      appendFileSync(ledger, `${JSON.stringify({ key, at: new Date().toISOString() })}\n`);
      loadSent().add(key);
    },
  };
}

function ghJson<T>(args: string[], execute: GhExecute): T {
  return JSON.parse(execute(args)) as T;
}

function githubPullsPage(repository: string, state: 'open' | 'closed', page: number, execute: GhExecute): GithubPull[] {
  // Closed PRs newest-updated first: a merged twin that matters was merged after the oldest open draft, so paging can stop there.
  const order = state === 'closed' ? '&sort=updated&direction=desc' : '';
  return ghJson<GithubPull[]>(['api', `repos/${repository}/pulls?state=${state}${order}&per_page=100&page=${page}`], execute);
}

function ledgerPrRepository(data: Record<string, unknown>, number: number): string | undefined {
  const value = data.repository ?? data.repo ?? data.nameWithOwner;
  const named = typeof value === 'string' ? value : value && typeof value === 'object'
    ? (value as Record<string, unknown>).nameWithOwner ?? (value as Record<string, unknown>).full_name : undefined;
  const url = data.url ?? data.html_url;
  const match = typeof url === 'string'
    ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url)
    : null;
  if (typeof url === 'string' && (!match || Number(match[2]) !== number)) return undefined;
  const fromUrl = match?.[1];
  if (typeof named === 'string' && fromUrl && named !== fromUrl) return undefined;
  const repository = typeof named === 'string' ? named : fromUrl;
  return repository && DRAFT_SWEEP_REPOSITORY.test(repository) ? repository : undefined;
}

/** A PR number alone is not run identity; ledgers without verifiable repository ownership stay unknown. */
export function draftSweepRunStatus(ledgerMatches: readonly RunLedgerMatch[], running: ReadonlyMap<string, string>,
  repository: string, number: number): string | undefined {
  const statuses = new Set<string>();
  for (const match of ledgerMatches) {
    const prEvents = match.entries.filter((entry) => entry.event === 'pr-opened' && entry.data.number === number);
    if (prEvents.length === 0 || prEvents.some((entry) => ledgerPrRepository(entry.data, number) !== repository)) continue;
    const terminal = [...match.entries].reverse().find((item) => item.event === 'run-status')?.data.runStatus;
    const status = running.get(match.runId) ?? (typeof terminal === 'string' &&
      ['completed', 'failed', 'cancelled', 'abandoned'].includes(terminal) ? terminal : undefined);
    if (status && status !== 'unknown') statuses.add(status);
  }
  if (statuses.has('running')) return 'running';
  if (statuses.has('probable-running')) return 'probable-running';
  return statuses.size === 1 ? [...statuses][0] : undefined;
}

function currentDraftSweepRunId(matches: readonly RunLedgerMatch[], repository: string, number: number): string | undefined {
  const owners = matches.flatMap((match) => {
    const events = match.entries.filter((entry) => entry.event === 'pr-opened' && entry.data.number === number);
    if (events.length === 0 || events.some((entry) => ledgerPrRepository(entry.data, number) !== repository)) return [];
    const times = events.map((entry) => Date.parse(entry.timestamp ?? ''));
    return [{ runId: match.runId, time: times.every(Number.isFinite) ? Math.max(...times) : NaN }];
  });
  if (owners.length === 1) return owners[0]!.runId;
  if (owners.some((owner) => !Number.isFinite(owner.time))) return undefined;
  owners.sort((a, b) => b.time - a.time);
  if (owners.length > 1 && owners[0]!.time === owners[1]!.time) return undefined;
  return owners[0]?.runId;
}

type DraftSweepGitExecute = (cwd: string, args: string[]) => Pick<ReturnType<typeof runGitCommand>, 'status' | 'stdout' | 'stderr'>;

function githubRemoteRepository(url: string): string | undefined {
  const remote = url.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote);
  return match?.[1];
}

/** One PR's sweep evidence read in a GraphQL batch. A `null` field was not complete in the batch ⇒ its REST path is used. */
interface GraphqlPrDetail {
  readonly files: string[] | null;
  readonly comments: string[] | null;
  readonly reviews: Array<{ state?: string; body?: string; submittedAt?: string; commitOid?: string }> | null;
  readonly headSha: string | null;
  readonly headCommittedAt: string | null;
  readonly mergeCommit: { oid: string; message: string } | null;
}

/** PRs per GraphQL request: three nested connections × 100 nodes stays far under the node limit and costs ~1 point. */
const DRAFT_SWEEP_GRAPHQL_BATCH = 40;

type GraphqlConnection<T> = { totalCount?: number; nodes?: T[] | null; pageInfo?: { hasNextPage?: boolean } } | null | undefined;
const completeNodes = <T>(connection: GraphqlConnection<T>): T[] | null =>
  connection && Array.isArray(connection.nodes) && connection.pageInfo?.hasNextPage === false
    && (connection.totalCount === undefined || connection.totalCount === connection.nodes.length) ? connection.nodes : null;

/**
 * Batched PR evidence (files · issue comments · reviews · head · merge commit) — one GraphQL request per
 * DRAFT_SWEEP_GRAPHQL_BATCH PRs instead of 3–7 REST calls per PR (DRAFT-SWEEP-SLOW, 10-08: ~1,300 PRs ⇒ >600 s).
 * Fail-soft: an unreadable batch or PR yields no entry, and the caller falls back to the per-PR REST path.
 */
async function graphqlPrDetails(repository: string, numbers: readonly number[],
  executeAsync: (args: string[]) => Promise<string>): Promise<Map<number, GraphqlPrDetail>> {
  const details = new Map<number, GraphqlPrDetail>();
  const [owner, name] = repository.split('/');
  if (!owner || !name || numbers.length === 0) return details;
  const batches: number[][] = [];
  for (let index = 0; index < numbers.length; index += DRAFT_SWEEP_GRAPHQL_BATCH) batches.push(numbers.slice(index, index + DRAFT_SWEEP_GRAPHQL_BATCH));
  let failedBatches = 0;
  // Fields the batch could not prove complete (each one is read again over REST by the caller).
  const incompleteFields = { files: 0, comments: 0, reviews: 0 };
  await mapBounded(batches, DRAFT_SWEEP_CONCURRENCY, async (batch) => {
    const fields = batch.map((number) => `p${number}: pullRequest(number: ${number}) { number headRefOid headRef { target { ... on Commit { committedDate } } } `
      + 'files(first: 100) { totalCount nodes { path } pageInfo { hasNextPage } } '
      + 'comments(first: 100) { totalCount nodes { body } pageInfo { hasNextPage } } '
      + 'reviews(first: 100) { totalCount nodes { state body submittedAt commit { oid } } pageInfo { hasNextPage } } '
      + 'mergeCommit { oid message } }').join(' ');
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
    let repositoryNode: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(await executeAsync(['api', 'graphql', '-f', `query=${query}`])) as { data?: { repository?: Record<string, unknown> } };
      repositoryNode = parsed?.data?.repository ?? undefined;
    } catch { repositoryNode = undefined; }
    if (!repositoryNode || typeof repositoryNode !== 'object' || Array.isArray(repositoryNode)) { failedBatches += 1; return; }
    for (const number of batch) {
      const pr = repositoryNode[`p${number}`] as {
        number?: number; headRefOid?: string; headRef?: { target?: { committedDate?: string } | null } | null;
        files?: GraphqlConnection<{ path?: string }>; comments?: GraphqlConnection<{ body?: string }>;
        reviews?: GraphqlConnection<{ state?: string; body?: string; submittedAt?: string; commit?: { oid?: string } | null }>;
        mergeCommit?: { oid?: string; message?: string } | null;
      } | null | undefined;
      if (!pr || pr.number !== number) continue;
      const files = completeNodes(pr.files);
      const comments = completeNodes(pr.comments);
      const reviews = completeNodes(pr.reviews);
      const detail: GraphqlPrDetail = {
        files: files && files.every((file) => typeof file?.path === 'string') ? files.map((file) => file.path!) : null,
        comments: comments && comments.every((comment) => typeof comment?.body === 'string') ? comments.map((comment) => comment.body!) : null,
        reviews: reviews && reviews.every((review) => review && typeof review === 'object')
          ? reviews.map((review) => ({ state: review.state, body: review.body, submittedAt: review.submittedAt,
            commitOid: review.commit?.oid })) : null,
        headSha: typeof pr.headRefOid === 'string' && pr.headRefOid ? pr.headRefOid : null,
        headCommittedAt: typeof pr.headRef?.target?.committedDate === 'string' ? pr.headRef.target.committedDate : null,
        mergeCommit: pr.mergeCommit && typeof pr.mergeCommit.oid === 'string' && typeof pr.mergeCommit.message === 'string'
          ? { oid: pr.mergeCommit.oid, message: pr.mergeCommit.message } : null,
      };
      if (detail.files === null) incompleteFields.files += 1;
      if (detail.comments === null) incompleteFields.comments += 1;
      if (detail.reviews === null) incompleteFields.reviews += 1;
      details.set(number, detail);
    }
  });
  if (failedBatches > 0 || details.size < numbers.length || Object.values(incompleteFields).some((count) => count > 0)) {
    try {
      debug.log('self-dev.draft-sweep', 'graphql-fallback', { requested: numbers.length, resolved: details.size, failedBatches, incompleteFields });
    } catch { /* fail-soft */ }
  }
  return details;
}

/** GitHub draft-sweep adapters plus the shared inventory the RUN-TTL step reuses (one open-PR listing per sweep). */
export type GithubDraftSweepAdapters = DraftSweepAdapters & {
  /** The sweep's cached open PR listing — RUN-TTL reads it instead of paging the same list again. */
  openPullRequests(repository: string): Promise<GithubPull[]>;
  /** The sweep's cached run-ledger scan. */
  runLedgerMatches(): readonly RunLedgerMatch[];
};

/** DRAFT-LINEAGE-ONE-1 — how the sweep stops a superseded run: `harness stop` (process ⊕ Pod Job by run label). */
export type DraftSweepStopRun = (runId: string) => Promise<Pick<import('./harness-stop.js').HarnessStopResult, 'process' | 'jobsDeleted' | 'scanned'>>;
const defaultDraftSweepStopRun: DraftSweepStopRun = async (runId) => {
  const { stopHarnessRun, defaultHarnessStopDeps } = await import('./harness-stop.js');
  return stopHarnessRun(runId, defaultHarnessStopDeps());
};

export interface GithubDraftSweepAdapterOptions {
  /** Read-only preview bounds. Reaching a bound is reported as an incomplete inventory. */
  maxInventoryPages?: number;
  maxDrafts?: number;
  maxMerged?: number;
  onInventoryProgress?: (event: { state: 'open' | 'closed'; page: number; rows: number }) => void;
  /** Test seam: provide an isolated run-ledger inventory instead of enumerating the host's stores. */
  runLedgerMatches?: () => readonly RunLedgerMatch[];
  /** Test seam: provide isolated running-run observations instead of inspecting host processes and PTY stores. */
  runningRunStatuses?: () => ReadonlyMap<string, string>;
  /** Test seam for bounded GitHub check-run backoff. */
  checkRunRetryDelaysMs?: readonly number[];
  checkRunSleep?: (milliseconds: number) => Promise<void>;
}

function createGithubDraftSweepAdapters(execute: GhExecute, git: DraftSweepGitExecute, cwd: string,
  executeAsync: (args: string[]) => Promise<string> = execute === executeGh ? executeGhAsync : async (args) => execute(args),
  stopRun: DraftSweepStopRun = defaultDraftSweepStopRun, options: GithubDraftSweepAdapterOptions = {}): GithubDraftSweepAdapters {
  const ensuredSweepLabels = new Set<string>();
  const maxInventoryPages = Number.isSafeInteger(options.maxInventoryPages) && options.maxInventoryPages! > 0
    ? Math.min(options.maxInventoryPages!, 100) : 100;
  const maxDrafts = Number.isSafeInteger(options.maxDrafts) && options.maxDrafts! > 0 ? options.maxDrafts : undefined;
  const maxMerged = Number.isSafeInteger(options.maxMerged) && options.maxMerged! > 0 ? options.maxMerged : undefined;
  let inventoryIncompleteReason: string | undefined;
  const markInventoryIncomplete = (reason: string) => { inventoryIncompleteReason ??= reason; };
  const checkRunRetryDelays = options.checkRunRetryDelaysMs ?? [1_000, 2_000, 4_000];
  const sleepForCheckRunRetry = options.checkRunSleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let checkRunsQueue: Promise<void> = Promise.resolve();
  let checkRunsUnavailableReason: string | undefined;
  const inventory = async (repository: string, state: 'open' | 'closed'): Promise<GithubPull[]> => {
    // ⛔ A large repository has tens of thousands of closed PRs (2026-09-28: 21k → «exceeded pagination limit», no sweep at all).
    //    Merged twins only matter after the oldest open draft was opened, so the closed listing stops at that time.
    let cutoff: number | undefined;
    if (state === 'closed') {
      const drafts = (await listed(open, repository, 'open')).filter((pr) => pr.draft);
      if (drafts.length === 0) return [];
      cutoff = Math.min(...drafts.map((pr) => Date.parse(pr.created_at)));
      if (!Number.isFinite(cutoff)) throw new Error('Incomplete GitHub PR inventory');
    }
    const all: GithubPull[] = [];
    for (let page = 1; page <= maxInventoryPages; page++) {
      let batch: GithubPull[];
      try { batch = githubPullsPage(repository, state, page, execute); }
      catch (error) {
        if (maxInventoryPages < 100) {
          markInventoryIncomplete(`${state} PR inventory stopped after ${page - 1} pages (${all.length} rows): ${sweepFailureReason(error)}`);
          return all;
        }
        throw error;
      }
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete GitHub PR inventory');
      all.push(...batch);
      options.onInventoryProgress?.({ state, page, rows: all.length });
      if (batch.length < 100) return all;
      // An unknown update time cannot prove the rest is older — keep paging.
      const oldest = Date.parse(batch[batch.length - 1]!.updated_at ?? '');
      if (cutoff !== undefined && Number.isFinite(oldest) && oldest < cutoff) return all;
    }
    if (maxInventoryPages < 100) {
      markInventoryIncomplete(`${state} PR inventory capped at ${maxInventoryPages} pages (${all.length} rows observed)`);
      return all;
    }
    throw new Error('GitHub PR inventory exceeded pagination limit');
  };
  const open = new Map<string, Promise<GithubPull[]>>();
  const closed = new Map<string, Promise<GithubPull[]>>();
  const listed = (cache: Map<string, Promise<GithubPull[]>>, repository: string, state: 'open' | 'closed') => {
    if (!cache.has(repository)) cache.set(repository, inventory(repository, state));
    return cache.get(repository)!;
  };
  const ghJsonAsync = async <T>(args: string[]): Promise<T> => JSON.parse(await executeAsync(args)) as T;
  // GitHub stops listing a pull request's files at 3,000, and the cut looks like a normal last page.
  // A list that reaches the cap cannot prove it is complete, so it is reported as unknown (undefined):
  // a draft without a provable file list never qualifies for the all-files-landed close.
  const filesFor = async (repository: string, number: number): Promise<string[] | undefined> => {
    const files: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await ghJsonAsync<Array<{ filename: string }>>(['api', `repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`]);
      if (!Array.isArray(batch) || batch.length > 100 || batch.some((file) => typeof file.filename !== 'string')) throw new Error('Incomplete PR file inventory');
      files.push(...batch.map((file) => file.filename));
      if (files.length >= GITHUB_PR_FILES_LIST_CAP) {
        debug.log('drafts.cleanup', 'file-inventory-capped', { number, listed: files.length });
        return undefined;
      }
      if (batch.length < 100) return files;
    }
    throw new Error('PR file inventory exceeded pagination limit');
  };
  // Batched evidence per PR, read once per adapter (= once per sweep) and shared by listing and review/gate.
  const detailCache = new Map<string, Promise<GraphqlPrDetail | undefined>>();
  const prefetchDetails = async (repository: string, numbers: readonly number[]): Promise<void> => {
    const missing = [...new Set(numbers)].filter((number) => !detailCache.has(`${repository}#${number}`));
    if (missing.length === 0) return;
    const fetched = graphqlPrDetails(repository, missing, executeAsync);
    for (const number of missing) detailCache.set(`${repository}#${number}`, fetched.then((map) => map.get(number)));
    await fetched;
  };
  const detailFor = (repository: string, number: number): Promise<GraphqlPrDetail | undefined> =>
    detailCache.get(`${repository}#${number}`) ?? Promise.resolve(undefined);
  const prFiles = async (repository: string, number: number): Promise<string[] | undefined> =>
    (await detailFor(repository, number))?.files ?? filesFor(repository, number);
  const latestFileChangesFor = async (draft: SweepDraft, repository: string): Promise<Record<string, string> | undefined> => {
    if (!draft.changedFiles?.length) return undefined;
    const changes: Record<string, string> = {};
    for (let page = 1; page <= 100; page++) {
      const batch = await ghJsonAsync<Array<{ sha: string; commit: { committer: { date: string } } }>>(
        ['api', `repos/${repository}/pulls/${draft.number}/commits?per_page=100&page=${page}`]);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete draft commit inventory');
      for (const commit of batch) {
        const changedAt = commit.commit?.committer?.date;
        if (!commit.sha || !changedAt || !Number.isFinite(Date.parse(changedAt))) return undefined;
        const detail = await ghJsonAsync<{ files?: Array<{ filename: string; previous_filename?: string }> }>(
          ['api', `repos/${repository}/commits/${commit.sha}?per_page=100`]);
        // GitHub truncates very large commit file lists; never infer coverage from a partial list.
        if (!Array.isArray(detail.files) || detail.files.length >= 100) return undefined;
        for (const file of detail.files) {
          for (const name of [file.filename, file.previous_filename]) {
            if (!name || !draft.changedFiles.includes(name)) continue;
            if (!changes[name] || Date.parse(changes[name]) < Date.parse(changedAt)) changes[name] = changedAt;
          }
        }
      }
      if (batch.length < 100) return draft.changedFiles.every((file) => changes[file]) ? changes : undefined;
    }
    return undefined;
  };
  const issueCommentsFor = async (repository: string, number: number, what: 'review' | 'landing' | 'same-cell'): Promise<string[]> => {
    const comments: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await ghJsonAsync<Array<{ body?: string }>>(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error(`Incomplete ${what} comment inventory`);
      comments.push(...batch.map((comment) => comment.body ?? ''));
      if (batch.length < 100) return comments;
    }
    throw new Error(`${what === 'review' ? 'Review' : what === 'same-cell' ? 'Same-cell' : 'Landing'} comment inventory exceeded pagination limit`);
  };
  const reviewsFor = async (repository: string, number: number): Promise<Array<{ state?: string; body?: string; submittedAt?: string; commitOid?: string }>> => {
    const reviews: Array<{ state?: string; body?: string; submittedAt?: string; commitOid?: string }> = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await ghJsonAsync<Array<{ state?: string; body?: string; submitted_at?: string; commit_id?: string }>>(
        ['api', `repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`]);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete review inventory');
      reviews.push(...batch.map((review) => ({ state: review.state, body: review.body,
        submittedAt: review.submitted_at, commitOid: review.commit_id })));
      if (batch.length < 100) return reviews;
    }
    throw new Error('Review inventory exceeded pagination limit');
  };
  const readCheckRuns = async (repository: string, sha: string): Promise<Array<{ conclusion?: string | null }>> => {
    const runs: Array<{ conclusion?: string | null }> = [];
    for (let page = 1; page <= 100; page++) {
      let result: { total_count?: number; check_runs?: Array<{ conclusion?: string | null }> } | undefined;
      let attempt = 0;
      while (true) {
        try {
          result = await ghJsonAsync<{ total_count?: number; check_runs?: Array<{ conclusion?: string | null }> }>(
            ['api', `repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`]);
          break;
        } catch (error) {
          const reason = sweepFailureReason(error);
          const retryable = /(?:\b403\b|\b429\b|rate.?limit|secondary rate)/i.test(reason);
          if (!retryable || attempt >= checkRunRetryDelays.length) {
            const incomplete = `check-run inventory incomplete for ${repository}@${sha}: ${reason}`;
            checkRunsUnavailableReason ??= incomplete;
            markInventoryIncomplete(incomplete);
            throw new Error(incomplete);
          }
          await sleepForCheckRunRetry(checkRunRetryDelays[attempt++]!);
        }
      }
      if (!Array.isArray(result?.check_runs) || result.check_runs.length > 100 || !Number.isSafeInteger(result.total_count) || result.total_count! < 0) {
        const incomplete = `check-run inventory incomplete for ${repository}@${sha}: malformed page ${page}`;
        checkRunsUnavailableReason ??= incomplete;
        markInventoryIncomplete(incomplete);
        throw new Error(incomplete);
      }
      runs.push(...result.check_runs);
      if (runs.length >= result.total_count!) return runs;
      if (result.check_runs.length < 100) {
        const incomplete = `check-run inventory incomplete for ${repository}@${sha}: expected ${result.total_count}, received ${runs.length} (check-runs may have changed during pagination or the response may be incomplete)`;
        checkRunsUnavailableReason ??= incomplete;
        markInventoryIncomplete(incomplete);
        throw new Error(incomplete);
      }
    }
    const incomplete = `check-run inventory incomplete for ${repository}@${sha}: pagination limit reached`;
    checkRunsUnavailableReason ??= incomplete;
    markInventoryIncomplete(incomplete);
    throw new Error(incomplete);
  };
  const checkRunsFor = async (repository: string, sha: string): Promise<Array<{ conclusion?: string | null }>> => {
    let release!: () => void;
    const previous = checkRunsQueue;
    checkRunsQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (checkRunsUnavailableReason) throw new Error(checkRunsUnavailableReason);
      return await readCheckRuns(repository, sha);
    } finally { release(); }
  };
  const headCommitTimeFor = async (repository: string, number: number): Promise<string | undefined> => {
    let latest: string | undefined;
    for (let page = 1; page <= 100; page++) {
      const batch = await ghJsonAsync<Array<{ commit?: { committer?: { date?: string } } }>>(
        ['api', `repos/${repository}/pulls/${number}/commits?per_page=100&page=${page}`]);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete PR commit inventory');
      for (const commit of batch) {
        const date = commit.commit?.committer?.date;
        if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Incomplete PR commit timestamp');
        latest = date;
      }
      if (batch.length < 100) return latest;
    }
    throw new Error('PR commit inventory exceeded pagination limit');
  };
  const reviewGateForDraft = async (draft: SweepDraft, repository: string): Promise<SweepReviewGate | undefined> => {
    const cached = await detailFor(repository, draft.number);
    const sha = cached?.headSha
      ?? (await ghJsonAsync<{ head?: { sha?: string } }>(['api', `repos/${repository}/pulls/${draft.number}`]))?.head?.sha;
    if (!sha) return undefined;
    const reviews = cached?.reviews ?? await reviewsFor(repository, draft.number);
    if (!Array.isArray(reviews)) throw new Error('Incomplete review inventory');
    const comments = cached?.comments ?? await issueCommentsFor(repository, draft.number, 'review');
    const legacyText = [...comments, ...reviews.map((review) => review.body ?? '')].join('\n');
    const currentHeadReviews = reviews.filter((review) => review && typeof review === 'object'
      && review.commitOid === sha
      && typeof review.submittedAt === 'string' && Number.isFinite(Date.parse(review.submittedAt)))
      .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!));
    const latestHeadReview = currentHeadReviews.at(-1);
    const triageReview = latestHeadReview?.state === 'APPROVED' ? 'approved'
      : latestHeadReview?.state === 'CHANGES_REQUESTED' ? 'changes-requested'
        : latestHeadReview?.state === 'COMMENTED' ? 'commented'
          : latestHeadReview?.state === 'DISMISSED' ? 'dismissed'
            : latestHeadReview?.state === 'PENDING' ? 'pending' : 'unknown';
    const [status, checkRuns] = await Promise.all([
      ghJsonAsync<{ state?: string }>(['api', `repos/${repository}/commits/${sha}/status`]),
      checkRunsFor(repository, sha),
    ]);
    const conclusions = checkRuns?.map((run) => run.conclusion ?? null) ?? [];
    const gatePass = status?.state === 'success'
      && checkRuns !== undefined && conclusions.length > 0
      && conclusions.every((conclusion) => conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral');
    const gateFail = status?.state === 'failure' || status?.state === 'error'
      || conclusions.some((conclusion) => conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out' || conclusion === 'action_required');
    return {
      ...(reviews.some((review) => review.state === 'APPROVED') || /(?:^|\n)\s*VERDICT:\s*PASS\b/i.test(legacyText)
        ? { review: 'pass' as const } : {}),
      ...(mustFixRemains(legacyText) ? { mustFix: true } : {}),
      ...(gatePass && !gateFail ? { gate: 'pass' as const } : gateFail ? { gate: 'fail' as const } : {}),
      triageReview,
    };
  };
  const claimCommentsFor = async (repository: string, number: number): Promise<string[]> => {
    const batched = (await detailFor(repository, number))?.comments;
    if (batched) return batched;
    const pages = ghJson<Array<Array<{ body: string; created_at: string }>>>(['api', '--paginate', '--slurp',
      `repos/${repository}/issues/${number}/comments?per_page=100`], execute);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)
      || page.some((comment) => typeof comment.body !== 'string' || !Number.isFinite(Date.parse(comment.created_at)))))
      throw new Error('Incomplete claim comments');
    return pages.flat().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((comment) => comment.body);
  };
  const landingCommentsFor = async (repository: string, number: number): Promise<string[]> =>
    ((await detailFor(repository, number))?.comments ?? await issueCommentsFor(repository, number, 'landing'))
      .filter((body) => /\blanding-verified\b/i.test(body));
  const mergeCommitMessageFor = async (repository: string, pr: GithubPull): Promise<string | undefined> => {
    if (!pr.merge_commit_sha) return undefined;
    const cached = (await detailFor(repository, pr.number))?.mergeCommit;
    if (cached && cached.oid === pr.merge_commit_sha) return cached.message;
    return (await ghJsonAsync<{ commit: { message: string } }>(['api', `repos/${repository}/commits/${pr.merge_commit_sha}`])).commit.message;
  };
  // The whole draft / merged inventory is enriched once (bounded concurrency) and then paged from memory.
  const draftRows = new Map<string, Promise<SweepDraft[]>>();
  const mergedRows = new Map<string, Promise<SweepMergedPr[]>>();
  const enrichedDrafts = (repository: string): Promise<SweepDraft[]> => {
    if (!draftRows.has(repository)) draftRows.set(repository, (async () => {
      const prs = (await listed(open, repository, 'open')).filter((pr) => pr.draft);
      const selected = maxDrafts === undefined ? prs : prs.slice(0, maxDrafts);
      if (selected.length < prs.length) markInventoryIncomplete(`draft inventory capped at ${maxDrafts} drafts (${prs.length} drafts listed)`);
      await prefetchDetails(repository, selected.map((pr) => pr.number));
      const matches = readRunLedgerMatches();
      return mapBounded(selected, DRAFT_SWEEP_CONCURRENCY, async (pr): Promise<SweepDraft> => {
        return {
          number: pr.number, title: pr.title, branch: pr.head.ref,
          labels: pr.labels.map((item) => item.name), createdAt: pr.created_at, body: pr.body ?? undefined,
          changedFiles: await prFiles(repository, pr.number),
          ...(pr.head.sha ? { headSha: pr.head.sha } : {}),
          ...(pr.updated_at ? { updatedAt: pr.updated_at } : {}),
          runId: currentDraftSweepRunId(matches, repository, pr.number),
        };
      });
    })());
    return draftRows.get(repository)!;
  };
  const enrichedMerged = (repository: string): Promise<SweepMergedPr[]> => {
    if (!mergedRows.has(repository)) mergedRows.set(repository, (async () => {
      const prs = (await listed(closed, repository, 'closed')).filter((pr) => pr.merged_at !== null && pr.base?.ref === 'main');
      const selected = maxMerged === undefined ? prs : prs.slice(0, maxMerged);
      if (selected.length < prs.length) markInventoryIncomplete(`merged PR inventory capped at ${maxMerged} records (${prs.length} records listed)`);
      await prefetchDetails(repository, selected.map((pr) => pr.number));
      return mapBounded(selected, DRAFT_SWEEP_CONCURRENCY, async (pr): Promise<SweepMergedPr> => ({
        number: pr.number, title: pr.title, branch: pr.head.ref, body: pr.body ?? undefined,
        mergedAt: pr.merged_at ?? undefined, changedFiles: await prFiles(repository, pr.number),
        mergeCommitMessage: await mergeCommitMessageFor(repository, pr),
        landingVerifiedComments: await landingCommentsFor(repository, pr.number) }));
    })());
    return mergedRows.get(repository)!;
  };
  let ledgerMatches: readonly RunLedgerMatch[] | undefined;
  let running: ReadonlyMap<string, string> | undefined;
  const readRunLedgerMatches = (): readonly RunLedgerMatch[] => {
    ledgerMatches ??= options.runLedgerMatches?.() ?? listRunLedgers().matches;
    return ledgerMatches;
  };
  const readRunningRunStatuses = (): ReadonlyMap<string, string> => {
    running ??= options.runningRunStatuses?.() ?? new Map(queryRunningRuns().entries.map((entry) => [entry.runId, entry.status]));
    return running;
  };
  const runStatusFor = (draft: Pick<SweepDraft, 'number' | 'branch' | 'runId'>, repository: string): string | undefined => {
    const matches = readRunLedgerMatches();
    const statuses = readRunningRunStatuses();
    if (draft.runId) {
      const match = matches.find((entry) => entry.runId === draft.runId);
      return match ? draftSweepRunStatus([match], statuses, repository, draft.number) : undefined;
    }
    return draftSweepRunStatus(matches, statuses, repository, draft.number);
  };
  return {
    inventoryStatus: async () => ({ complete: inventoryIncompleteReason === undefined, ...(inventoryIncompleteReason ? { reason: inventoryIncompleteReason } : {}) }),
    openPullRequests: (repository) => listed(open, repository, 'open'),
    runLedgerMatches: readRunLedgerMatches,
    getPrFiles: async (repository, number) => prFiles(repository, number),
    getDraftSnapshot: async (repository, number) => {
      const pr = await ghJsonAsync<GithubPull>(['api', `repos/${repository}/pulls/${number}`]);
      if (!pr || pr.number !== number || !Array.isArray(pr.labels) || !pr.head?.sha || !pr.updated_at
        || (pr.state !== 'open' && pr.state !== 'closed')) return undefined;
      return { number: pr.number, state: pr.state, draft: pr.draft, headSha: pr.head.sha,
        branch: pr.head.ref, updatedAt: pr.updated_at, labels: pr.labels.map((item) => item.name) };
    },
    getPr: async (repository, number) => {
      const pr = ghJson<GithubPull>(['api', `repos/${repository}/pulls/${number}`], execute);
      if (!pr || pr.number !== number || typeof pr.head?.ref !== 'string' || !Array.isArray(pr.labels)) return undefined;
      return { number: pr.number, title: pr.title, branch: pr.head.ref, labels: pr.labels.map((label) => label.name),
        createdAt: pr.created_at, mergedAt: pr.merged_at ?? undefined };
    },
    listRecentClosed: async (repository, createdSince) => {
      const rows: SweepMergedPr[] = [];
      for (let page = 1; page <= 100; page++) {
        const batch = githubPullsPage(repository, 'closed', page, execute);
        if (!Array.isArray(batch) || batch.length > 100 || batch.some((pr) => !pr.updated_at || !Number.isFinite(Date.parse(pr.updated_at))
          || !Array.isArray(pr.labels) || !pr.created_at || !Number.isFinite(Date.parse(pr.created_at)))) throw new Error('Incomplete closed metric inventory');
        for (const pr of batch) if (pr.base?.ref === 'main' && (pr.head?.ref?.startsWith('self-impl/')
          || pr.labels.some((label) => label.name?.startsWith('elanous:')))) rows.push({
          number: pr.number, title: pr.title, branch: pr.head.ref,
          labels: pr.labels.map((label) => label.name),
          createdAt: pr.created_at, mergedAt: pr.merged_at ?? undefined,
        });
        if (batch.length < 100 || Date.parse(batch.at(-1)!.updated_at!) < createdSince.getTime()) return rows;
      }
      throw new Error('Closed metric inventory exceeded pagination limit');
    },
    listDrafts: async (page, perPage, repository): Promise<SweepDraft[]> =>
      (await enrichedDrafts(repository)).slice((page - 1) * perPage, page * perPage),
    getHeadCommitTime: async (repository, number) => (await detailFor(repository, number))?.headCommittedAt
      ?? await headCommitTimeFor(repository, number).catch(() => undefined),
    listMerged: async (page, perPage, repository): Promise<SweepMergedPr[]> =>
      (await enrichedMerged(repository)).slice((page - 1) * perPage, page * perPage),
    getRunStatus: async (draft, repository) => runStatusFor(draft, repository),
    getLatestFileChanges: async (draft, repository) => latestFileChangesFor(draft, repository),
    hasFinalRunResult: async (draft, repository) => {
      const matches = readRunLedgerMatches();
      const ownedRuns = new Set(matches.filter((match) => {
        const prEvents = match.entries.filter((entry) => entry.event === 'pr-opened' && entry.data.number === draft.number);
        return prEvents.length > 0 && prEvents.every((entry) => ledgerPrRepository(entry.data, draft.number) === repository);
      }).map((match) => match.runId));
      if (ownedRuns.size === 0) return false;
      // A previous owner's final does not establish finality for a later owner of this PR.
      if (draft.runId && !ownedRuns.has(draft.runId)) return false;
      if (!draft.runId && ownedRuns.size > 1) return false;
      const currentOwners = draft.runId ? new Set([draft.runId]) : ownedRuns;
      const path = logsDbPath();
      if (!existsSync(path)) return false;
      const store = LogStore.openReadOnly(path);
      try {
        let beforeId: number | undefined;
        for (;;) {
          const rows = store.query({ exactCategories: ['self-implement.result'], events: ['final'], grep: String(draft.number),
            limit: 1_000, ...(beforeId === undefined ? {} : { beforeId }) });
          for (const row of rows) {
            try {
              const data = JSON.parse(row.data ?? '{}') as { runId?: string; prNumber?: number };
              if (data.prNumber === draft.number && data.runId && currentOwners.has(data.runId)) return true;
            } catch { /* A malformed result cannot establish finality. */ }
          }
          if (rows.length < 1_000) return false;
          beforeId = rows.at(-1)!.id;
        }
      } finally { store.close(); }
    },
    listLiveBranches: async (repository) => {
      const remote = git(cwd, ['config', '--get', 'remote.origin.url']);
      if (remote.status !== 0 || githubRemoteRepository(remote.stdout)?.toLowerCase() !== repository.toLowerCase()) {
        return undefined;
      }
      const result = git(cwd, ['worktree', 'list', '--porcelain']);
      if (result.status !== 0) return undefined;
      return new Set(result.stdout.split('\n').filter((line) => line.startsWith('branch refs/heads/'))
        .map((line) => line.slice('branch refs/heads/'.length).trim()));
    },
    setLabels: async (repository, number, change) => {
      if (change.add.startsWith('elanous:swept:')) {
        const key = `${repository}:${change.add}`;
        if (!ensuredSweepLabels.has(key)) {
          execute(['label', 'create', change.add, '--repo', repository, '--color', '6A737D',
            '--description', 'Draft sweep close reason; reopen this PR to restore it', '--force']);
          ensuredSweepLabels.add(key);
        }
      }
      execute(['pr', 'edit', String(number), '--repo', repository, '--add-label', change.add,
        ...change.remove.flatMap((name) => ['--remove-label', name])]);
    },
    closeDraft: async (repository, number) => {
      execute(['pr', 'close', String(number), '--repo', repository]);
    },
    getClaimOwner: async (repository, number) => claimCommentOwner(repository, number, execute),
    getActiveClaimOwner: async (repository, number) => activeClaimOwnerFromBodies(await claimCommentsFor(repository, number)),
    getActiveClaimRunId: async (repository, number) => activeClaimRunIdFromBodies(await claimCommentsFor(repository, number)),
    getLastClaimReleaseAt: async (repository, number) => lastClaimReleaseAtFromBodies(await claimCommentsFor(repository, number)),
    listTaskCards: async () => Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(taskAgentStatePath()).tasks ?? {}),
    listPrTerminals: async () => readRunLedgerMatches().flatMap((match) => match.entries.filter((entry) => entry.event === 'pr-terminal')
      .map((entry) => entry.data as unknown as PrTerminalRecord)),
    commentDraft: async (repository, number, body) => { execute(['pr', 'comment', String(number), '--repo', repository, '--body', body]); },
    listIssueComments: async (repository, number) => issueCommentsFor(repository, number, 'same-cell'),
    removeLabel: async (repository, number, name) => { execute(['pr', 'edit', String(number), '--repo', repository, '--remove-label', name]); },
    getReviewGate: async (draft, repository) => reviewGateForDraft(draft, repository),
    // DRAFT-LINEAGE-ONE-1 — the sweep calls this only with `--apply`, only for a live run whose newer same-lineage run
    // is live too. The run id must come from this PR's own ledger owner; a stop that cannot be confirmed rejects, so
    // the draft is neither labelled nor closed.
    supersedeRun: async (draft) => {
      if (!draft.runId) throw new Error(`run id of #${draft.number} unknown (no single ledger owner) — not stopping`);
      const stopped = await stopRun(draft.runId);
      // `absent` after a complete process-table scan = nothing left to stop (a dead run whose worktree remains) — confirmed.
      const confirmed = stopped.process === 'stopped' || stopped.process === 'killed' || stopped.jobsDeleted > 0
        || (stopped.process === 'absent' && stopped.scanned);
      if (!confirmed) {
        throw new Error(`run ${draft.runId} not confirmed stopped (process ${stopped.process} · jobs ${stopped.jobsDeleted} · scanned ${stopped.scanned})`);
      }
    },
  };
}

export function githubDraftSweepAdapters(execute: GhExecute = executeGh, git: DraftSweepGitExecute = runGitCommand,
  cwd = process.cwd(), executeAsync?: (args: string[]) => Promise<string>, stopRun?: DraftSweepStopRun,
  options: GithubDraftSweepAdapterOptions = {}): GithubDraftSweepAdapters {
  return createGithubDraftSweepAdapters(execute, git, cwd, executeAsync, stopRun, options);
}

export function githubDraftSweepPreviewAdapters(options: GithubDraftSweepAdapterOptions,
  execute: GhExecute = executeGh, git: DraftSweepGitExecute = runGitCommand, cwd = process.cwd(),
  executeAsync?: (args: string[]) => Promise<string>, stopRun?: DraftSweepStopRun): GithubDraftSweepAdapters {
  return createGithubDraftSweepAdapters(execute, git, cwd, executeAsync, stopRun, options);
}

export interface HarnessDraftSweepDeps {
  /** DRAFT-LINEAGE-ONE-1 test seam for the real adapter's run stop; omitted ⇒ `harness stop`. */
  readonly stopRun?: DraftSweepStopRun;
  readonly adapters?: DraftSweepAdapters;
  /** Optional overlap source injection; tests do not read GitHub or logs.db. */
  readonly overlapAdapters?: OverlapMetricAdapters;
  readonly repository?: () => string;
  readonly write?: (line: string) => void;
  readonly execute?: GhExecute;
  readonly now?: () => Date;
  /** RUN-TTL step adapters. Omitted with injected `adapters` ⇒ the step is skipped (fakes never reach real gh). */
  readonly runTtl?: RunTtlAdapters;
  /** Test seam for `tools.selfImplement.draftSweepCloseCap`; omitted ⇒ the user config. */
  readonly closeCapConfig?: () => unknown;
  /** Replay test seam; production reads this instance's host run-ledger directory. */
  readonly residueReplay?: DraftResidueReplayOptions;
}

/** RUN-TTL step inside the draft sweep — fail-soft: its failure never changes the sweep verdict. */
async function draftSweepRunTtl(repository: string, deps: HarnessDraftSweepDeps,
  shared?: GithubDraftSweepAdapters): Promise<RunTtlResult | { error: string } | undefined> {
  if (deps.adapters && !deps.runTtl) return undefined;
  try {
    const { runRunTtlSweep } = await import('../self-implement/run-ttl.js');
    const config = (() => { try { return getUserConfig().tools?.selfImplement; } catch { return undefined; } })();
    const adapters = deps.runTtl ?? await githubRunTtlAdapters(repository, deps.execute ?? executeGh,
      deps.execute ? async (args) => deps.execute!(args) : executeGhAsync, undefined, shared ?? {});
    return await runRunTtlSweep({
      adapters, mode: config?.runTtl?.mode ?? 'shadow', ttlHours: config?.runTtlHours, cap: config?.runTtl?.cap,
      ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
    });
  } catch (error) {
    const reason = sweepFailureReason(error);
    try { debug.log('self-implement.run-ttl', 'failed', { reason }); } catch { /* fail-soft */ }
    return { error: reason };
  }
}

/** Latest claim or release among comments in chronological order (oldest first); a release means no owner. */
export function activeClaimOwnerFromBodies(bodies: readonly string[]): string | undefined {
  const last = [...bodies].reverse().find((body) => draftClaimOwner(body) !== undefined || body.startsWith('🔧 처리 끝 —'));
  return last ? draftClaimOwner(last) : undefined;
}

export function activeClaimRunIdFromBodies(bodies: readonly string[]): string | undefined {
  const last = [...bodies].reverse().find((body) => draftClaimOwner(body) !== undefined || body.startsWith('🔧 처리 끝 —'));
  return last && draftClaimOwner(last) ? / · run (\S+)/.exec(last)?.[1] : undefined;
}

/** Timestamp of the latest marker when it is a release ('' when its time is unreadable); undefined otherwise. */
export function lastClaimReleaseAtFromBodies(bodies: readonly string[]): string | undefined {
  const last = [...bodies].reverse().find((body) => draftClaimOwner(body) !== undefined || body.startsWith('🔧 처리 끝 —'));
  if (!last || draftClaimOwner(last) !== undefined) return undefined;
  return /^🔧 처리 끝 — (\S+)/.exec(last)?.[1] ?? '';
}

function draftClaimOwner(body: string): string | undefined {
  return /^🔧 처리 중 — owner ([^\n·]+?) · /m.exec(body)?.[1]?.trim();
}

async function claimCommentOwner(repository: string, number: number, execute: GhExecute): Promise<string | undefined> {
  const pages = ghJson<Array<Array<{ body: string }>>>(['api', '--paginate', '--slurp',
    `repos/${repository}/issues/${number}/comments?per_page=100`], execute);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page) || page.some((comment) => typeof comment.body !== 'string'))) {
    throw new Error('Incomplete claim comments');
  }
  return pages.flat().reverse().map((comment) => draftClaimOwner(comment.body)).find((owner) => owner !== undefined);
}

function installHarnessDraftSweepCommand(harnessCmd: Command, deps: HarnessDraftSweepDeps = {}): Command {
  const drafts = harnessCmd.command('drafts').description('하니스 draft PR 정리');
  drafts.command('claim <number>').description('세션이 처리 중인 draft 를 표식하거나 해제한다')
    .option('--owner <name>', '처리 주인 (S|T|F|O|이름)')
    .option('--note <text>', '한 줄 메모')
    .option('--release', '처리 중 표식을 해제하고 stalled 상태로 전환')
    .option('--repo <owner/name>', '조회할 GitHub 저장소')
    .action(async (number: string, opts: { owner?: string; note?: string; release?: boolean; repo?: string }) => {
      try {
        const execute = deps.execute ?? executeGh;
        const repository = resolveRepositoryName({
          repo: opts.repo ?? deps.repository?.(),
          executeGh: (args) => execute(args),
        });
        if (!DRAFT_SWEEP_REPOSITORY.test(repository) || repository.includes('..')) throw new HarnessCliInputError(`invalid --repo (expected owner/name): ${repository}`);
        if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) throw new HarnessCliInputError(`invalid PR number: ${number}`);
        const owner = opts.owner?.trim();
        if (!opts.release && (!owner || /[\r\n·]/.test(owner))) throw new HarnessCliInputError('--owner 필요 (한 줄)');
        if (opts.note !== undefined && /[\r\n]/.test(opts.note)) throw new HarnessCliInputError('--note 는 한 줄이어야 합니다');
        const pr = ghJson<GithubPull>(['api', `repos/${repository}/pulls/${number}`], execute);
        const approval = PR_LABELS.find((label) => label.axis === 'state' && label.sweep.action === 'none')!.name;
        if (pr.state !== 'open' || pr.draft !== true || !Array.isArray(pr.labels) || pr.labels.some((item) => item.name === approval)) throw new HarnessCliInputError('열린 draft 이고 idea-approval 이 아닌 PR 만 claim 할 수 있음');
        const running = PR_LABELS.find((label) => label.axis === 'state' && label.sweep.action === 'mark-stalled')!.name;
        const otherStates = PR_LABELS.filter((label) => label.axis === 'state' && label.name !== running && pr.labels.some((item) => item.name === label.name));
        if (opts.release) {
          if (!pr.labels.some((item) => item.name === running) || otherStates.length > 0) {
            throw new HarnessCliInputError('--release 는 running 이 유일한 상태인 draft 에만 사용 가능');
          }
          const stalled = PR_LABELS.find((label) => label.axis === 'state' && label.sweep.action === 'close' && label.name.endsWith(':stalled'))!.name;
          execute(['pr', 'edit', number, '--repo', repository, '--add-label', stalled, '--remove-label', running]);
          execute(['pr', 'comment', number, '--repo', repository, '--body', draftReleaseComment(deps.now?.() ?? new Date())]);
        } else {
          execute(['pr', 'edit', number, '--repo', repository, '--add-label', running,
            ...otherStates.flatMap((item) => ['--remove-label', item.name])]);
          execute(['pr', 'comment', number, '--repo', repository, '--body',
            draftClaimComment(owner!, deps.now?.() ?? new Date(), opts.note)]);
        }
        (deps.write ?? console.log)(`#${number} ${opts.release ? 'release' : 'claim'}: ${repository}`);
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  drafts.command('metrics').description('draft 재고·최장 나이·needs-owner·48h 전환율 (읽기 전용 · PR 근거는 GraphQL 배치)')
    .option('--json', 'JSON 으로 출력')
    .option('--repo <owner/name>', '조회할 GitHub 저장소')
    .action(async (opts: { json?: boolean; repo?: string }) => {
      try {
        const execute = deps.execute ?? executeGh;
        const repository = resolveRepositoryName({ repo: opts.repo ?? deps.repository?.(), executeGh: (args) => execute(args) });
        if (!DRAFT_SWEEP_REPOSITORY.test(repository) || repository.includes('..')) throw new HarnessCliInputError(`invalid --repo (expected owner/name): ${repository}`);
        const started = Date.now();
        const adapters = deps.adapters ?? githubDraftSweepAdapters(deps.execute);
        const now = deps.now?.() ?? new Date();
        const metrics = await collectDraftMetrics(repository, adapters, now);
        let overlap: Awaited<ReturnType<typeof collectOverlapMetrics>> | null = null;
        try {
          overlap = await collectOverlapMetrics(repository, deps.overlapAdapters ?? {
            ...adapters,
            listPreflightRows: readAskPreflightRowsSince,
            listSalvagedRows: readSalvagedRowsSince,
          }, now);
        } catch (error) {
          try { debug.log('self-dev.draft-metrics', 'overlap-failed', { repository, reason: sweepFailureReason(error) }); } catch { /* fail-soft */ }
        }
        try { debug.log('self-dev.draft-metrics', 'collected', { repository, ms: Date.now() - started, ...metrics }); } catch { /* fail-soft */ }
        const write = deps.write ?? console.log;
        if (opts.json) write(JSON.stringify({ repository, ...metrics, overlap }));
        else write(`draft 재고 ${metrics.inventory} · 최장 나이 ${metrics.oldestAgeHours === null ? '해당 없음' : `${metrics.oldestAgeHours.toFixed(1)}h`} · needs-owner ${metrics.needsOwner} · 48h 전환율 ${metrics.conversion48h === null ? '표본 없음' : `${(metrics.conversion48h * 100).toFixed(1)}% (${metrics.converted48h}/${metrics.cohort48h})`}`);
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  return drafts.command('sweep').description('draft PR 을 조사한다 (기본: 변경 없음)')
    .option('--apply', '판정한 라벨 변경과 종료를 적용')
    .option('--json', '판정 결과를 JSON 으로 출력')
    .option('--repo <owner/name>', '조회할 GitHub 저장소')
    .option('--close-cap <n>', '이번 틱 최대 종료 수 (1~100 · config tools.selfImplement.draftSweepCloseCap 보다 우선 · 기본 10)')
    .option('--max-pages <n>', 'inventory 상한 (페이지, dry-run 기본 1 · apply 기본 100 · 1~100)')
    .option('--max-drafts <n>', 'draft 상한 (dry-run 기본 10 · apply 기본 무제한)')
    .option('--max-merged <n>', 'merged PR 상한 (dry-run 기본 50 · apply 기본 무제한)')
    .option('--emit-apply-plan', '완전한 dry-run 분류에서 고정 적용 계획을 JSON에 포함 (모든 PR에 head SHA와 updatedAt 필요)')
    .option('--apply-plan-file <path>', '고정 적용 계획 JSON 파일 (apply 전용)')
    .action(async (opts: { apply?: boolean; json?: boolean; repo?: string; closeCap?: string; maxPages?: string; maxDrafts?: string; maxMerged?: string; emitApplyPlan?: boolean; applyPlanFile?: string }) => {
      try {
        const write = deps.write ?? console.log;
        const execute = deps.execute ?? executeGh;
        const repository = resolveRepositoryName({
          repo: opts.repo ?? deps.repository?.(),
          executeGh: (args) => execute(args),
        });
        if (!DRAFT_SWEEP_REPOSITORY.test(repository) || repository.includes('..')) {
          throw new HarnessCliInputError(`invalid --repo (expected owner/name): ${repository}`);
        }
        const readLimit = (value: string | undefined, fallback: number, name: string, max: number): number => {
          const limit = value === undefined ? fallback : Number(value);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new HarnessCliInputError(`invalid ${name} (expected 1~${max})`);
          return limit;
        };
        const applying = opts.apply === true;
        if (opts.emitApplyPlan && (applying || !opts.json)) throw new HarnessCliInputError('--emit-apply-plan requires dry-run --json');
        if (opts.applyPlanFile && !applying) throw new HarnessCliInputError('--apply-plan-file requires --apply');
        const applyPlan = opts.applyPlanFile
          ? validateDraftSweepApplyPlan(JSON.parse(readFileSync(resolve(opts.applyPlanFile), 'utf8')))
          : undefined;
        // One adapter instance per sweep: its open listing and ledger scan are shared with the RUN-TTL step.
        const inventoryLimits = {
          maxInventoryPages: readLimit(opts.maxPages, applying ? 100 : 1, '--max-pages', 100),
          maxDrafts: opts.maxDrafts === undefined && applying ? undefined : readLimit(opts.maxDrafts, 10, '--max-drafts', 1_000),
          maxMerged: opts.maxMerged === undefined && applying ? undefined : readLimit(opts.maxMerged, 50, '--max-merged', 1_000),
          onInventoryProgress: ({ state, page, rows }: { state: 'open' | 'closed'; page: number; rows: number }) =>
            console.error(`[draft-sweep] inventory state=${state} page=${page} rows=${rows}`),
        };
        const github = deps.adapters ? undefined : githubDraftSweepPreviewAdapters(inventoryLimits, deps.execute, undefined, undefined, undefined, deps.stopRun);
        const configCap = deps.closeCapConfig
          ? deps.closeCapConfig()
          : (() => { try { return getUserConfig().tools?.selfImplement?.draftSweepCloseCap; } catch { return undefined; } })();
        const cap = resolveDraftSweepCloseCap({ flag: opts.closeCap, config: configCap });
        for (const warning of cap.warnings) {
          console.error(`⚠ ${warning}`);
          try { debug.log('self-dev.draft-sweep', 'close-cap-rejected', { warning, closeCap: cap.closeCap, closeCapSource: cap.closeCapSource }); } catch { /* fail-soft */ }
        }
        let replayClosed = 0;
        if (opts.apply && !applyPlan && (!deps.adapters || deps.residueReplay)) {
          try {
            replayClosed = (await replayPodTerminals({ ...deps.residueReplay, repository, closeCap: cap.closeCap })).closed;
          } catch (error) {
            // Review r5: a replay that throws may already have closed PRs — spend the whole cap so this tick cannot exceed it.
            replayClosed = cap.closeCap;
            debug.log('draft.residue', 'failed', { childRunId: null, prNumber: null, terminalClass: null,
              owner: 'unknown', ownerSource: 'unknown', step: 'replay', reason: sweepFailureReason(error) });
          }
        }
        const result: DraftSweepResult = await runDraftSweep({ repository, apply: opts.apply === true, includeTriage: opts.json === true, adapters: deps.adapters ?? github!,
          closeCap: cap.closeCap, closeCapSource: cap.closeCapSource, alreadyClosed: replayClosed,
          includeApplyPlan: opts.emitApplyPlan === true, applyPlan });
        const frozenPlanMaintenance = applyPlan ? { postSweep: {
          residueReplay: 'skipped: frozen plan does not include terminal-residue PRs',
          runTtl: 'skipped: frozen plan does not include RUN-TTL PRs',
        } } : {};
        const reason = result.error ? sweepFailureReason(result.error) : undefined;
        const ttlStarted = Date.now();
        const runTtl = result.complete && !applyPlan ? await draftSweepRunTtl(repository, deps, github) : undefined;
        try { debug.log('self-dev.draft-sweep', 'timing', { phase: 'run-ttl', ms: Date.now() - ttlStarted, count: runTtl && !('error' in runTtl) ? runTtl.considered : 0 }); } catch { /* fail-soft */ }
        if (opts.json) {
          const output = JSON.stringify({ ...(reason ? { ...result, error: reason } : result), ...frozenPlanMaintenance, ...(runTtl ? { runTtl } : {}) });
          // `src/index.ts` imports chalk, which makes Bun stdout non-blocking. Await the
          // write callback so a large JSON result cannot be silently cut at the pipe buffer.
          if (deps.write) write(output);
          else await writeStdoutFully(output);
        }
        else {
          if (runTtl) {
            write('error' in runTtl ? `run-ttl: 실패 (${runTtl.error})`
              : `run-ttl(${runTtl.mode}, ${runTtl.ttlHours}h): 대상 ${runTtl.considered} · 낡음 ${runTtl.stale.length} · 메모 ${runTtl.memo.length} · 표식 ${runTtl.label.length} · 이미 표식 ${runTtl.alreadyMarked.length} · 상한 초과 ${runTtl.skippedOverCap.length}${runTtl.mode === 'shadow' ? ' (shadow — 쓰기 0)' : ''}`);
          }
          write(`draft sweep ${result.repository}: ${result.complete ? 'complete' : `incomplete (${reason})`} · ${result.apply ? 'apply' : 'dry-run'}`);
          for (const entry of result.entries) write(`#${entry.number} ${entry.action}: ${entry.reason}${entry.statusLabel ? ` → ${entry.statusLabel}` : ''}${entry.error ? ` ERROR: ${sweepFailureReason(entry.error)}` : ''}`);
          if (result.complete) {
            const daily = result.daily
              ? ` · 24h 넘음 ${result.daily.over24h} · 정리 대상 ${result.daily.closable} · 수확 대기 ${result.daily.harvestable} · 막힘 ${result.daily.blocked}`
              : '';
            write(`못 본 초안 ${result.unobserved ?? 0} · 이번에 닫음 ${result.closed ?? 0}${result.apply ? '' : '(dry-run)'} · 처리 중 ${result.claimed ?? 0} · 표식 만료 ${result.claimExpired ?? 0}${daily}`);
          }
          if (reason) write(reason);
        }
        if (!result.complete || result.entries.some((entry) => entry.error)) process.exitCode = 1;
      } catch (error) {
        console.error(humanErrorLine(error));
        try { debug.log('drafts.cleanup', 'failed', { reason: sweepFailureReason(error) }); } catch { /* observation is fail-soft */ }
        process.exitCode = 1;
      }
    });
}

function renderHarnessGoal(result: GoalLookupResult, universe: '운영' | '시험'): string {
  const matchedRun = result.runState?.results.find((entry) => entry.runId === result.runId);
  return [
    `골: ${result.goalBody?.split(/\r?\n/, 1)[0] || '골 문서에 없음'}`,
    `runId: ${result.runId ?? '원장에 없음'}`,
    `칸 id: ${result.kanId ?? '기록 없음'}`,
    `PR: ${result.record?.prNumber != null ? `#${result.record.prNumber}` : '기록 없음'}`,
    `stage/결과: ${result.record?.stage ?? '기록 없음'} / ${result.record?.outcome ?? '기록 없음'}`,
    `종결 사유: ${result.runState?.supervisorStopReason ?? matchedRun?.error?.message ?? '기록 없음'}`,
    `찾은 우주: ${universe}`,
    `원장: ${result.runState ? '찾음' : '원장에 없음'}`,
    `골 문서: ${result.goalFile ? '찾음' : '골 문서에 없음'}`,
  ].join('\n');
}

function installHarnessGoalCommand(harnessCmd: Command, options?: GoalLookupOptions, archiveOptions?: GoalArchiveOptions): Command {
  const goal = harnessCmd.command('goal').usage('<reference> | archive [--before <date>] [--apply]')
    .description('골 문서와 실행 결과를 조회하거나 보관한다');
  goal.command('archive')
    .description('종료된 골 문서를 미리 보거나 상태 루트에 보관한다 — 저장소는 건드리지 않고 지울 목록(filesForPr)만 낸다')
    .option('--before <date>', '완료 시각이 이 YYYY-MM-DD 이전인 골만')
    .option('--apply', '상태 루트에 보관 복사·색인 (저장소 삭제·스테이지·커밋 없음 · 지우기는 filesForPr 로 사람이 PR)')
    .option('--trust-doc-record', '런 원장이 없을 때 문서에 적힌 종료 실행 기록을 신뢰')
    .action((opts: { before?: string; apply?: boolean; trustDocRecord?: boolean }) => {
      try {
        const result = archiveGoals({ ...archiveOptions, before: opts.before, apply: opts.apply, trustDocRecord: opts.trustDocRecord });
        console.log(JSON.stringify(result));
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  goal.command('show <reference>', { isDefault: true })
    .description('PR 번호 또는 runId 로 골 문서와 실행 결과를 조회한다 (읽기 전용)')
    .option('--json', 'GoalLookupResult 그대로 출력')
    .action((reference: string, opts: { json?: boolean }) => {
      try {
        const result = lookupGoal(reference, options);
        const universe = effectiveInstanceRoot() === prodInstanceRoot() ? '운영' : '시험';
        console.log(opts.json ? JSON.stringify(result) : renderHarnessGoal(result, universe));
        if (!result.goalFile || !result.runState) process.exitCode = 1;
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  return goal;
}

function installHarnessBudgetCommand(harnessCmd: Command): Command {
  return harnessCmd
    .command('budget')
    .description('선호·사용량·상한으로 이번 판을 돌릴지 정한다. --json 이면 마지막 줄이 outcome JSON.')
    .option('--json', '마지막 줄에 { outcome, provider, model, reasons } 를 찍는다')
    .action(async (opts: { json?: boolean }) => {
      await runHarnessBudget({ json: opts.json === true });
    });
}

export interface HarnessProcessSignalHandle {
  signal(signal: NodeJS.Signals): void;
  close(): void;
}

// macOS has no pidfd: bind to the process by its microsecond start time (libproc PROC_PIDTBSDINFO) and
// re-read it immediately before signalling — a reused pid within the same microsecond is not distinguishable, anything else is.
function readDarwinStartMicros(pid: number): bigint | null {
  const libproc = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    const buf = new Uint8Array(136); // sizeof(struct proc_bsdinfo)
    const n = libproc.symbols.proc_pidinfo(pid, 3 /* PROC_PIDTBSDINFO */, 0n, buf, buf.length);
    if (n !== buf.length) return null;
    const view = new DataView(buf.buffer);
    if (view.getUint32(12, true) !== pid) return null; // pbi_pid
    return view.getBigUint64(120, true) * 1_000_000n + view.getBigUint64(128, true); // pbi_start_tvsec · pbi_start_tvusec
  } finally { libproc.close(); }
}

function openDarwinProcessHandle(pid: number): HarnessProcessSignalHandle {
  const start = readDarwinStartMicros(pid);
  if (start === null) throw new Error('proc_pidinfo failed');
  let closed = false;
  return {
    signal(signal) {
      if (closed) throw new Error('process handle already closed');
      if (signal !== 'SIGTERM') throw new Error('only SIGTERM is supported');
      if (readDarwinStartMicros(pid) !== start) throw new Error('pid no longer names the same process');
      process.kill(pid, 'SIGTERM');
    },
    close() { closed = true; },
  };
}

export function openHarnessProcessHandle(pid: number): HarnessProcessSignalHandle {
  if (process.platform === 'darwin') return openDarwinProcessHandle(pid);
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('pid-bound signaling unavailable on this platform');
  }
  const libc = dlopen('libc.so.6', {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  const fd = Number(libc.symbols.syscall(434, pid, 0, 0, 0)); // pidfd_open
  if (fd < 0) {
    libc.close();
    throw new Error('pidfd_open failed');
  }
  let closed = false;
  return {
    signal(signal) {
      if (closed) throw new Error('pidfd already closed');
      if (signal !== 'SIGTERM' || libc.symbols.syscall(424, fd, osConstants.signals.SIGTERM, 0, 0) !== 0n) {
        throw new Error('pidfd_send_signal failed');
      }
    },
    close() {
      if (closed) return;
      closed = true;
      libc.symbols.close(fd);
      libc.close();
    },
  };
}

export function killHarnessProcess(
  pid: number,
  force: boolean,
  deps: HarnessProcessObservationDeps = {},
): { outcome: 'sent' | 'refused'; owned: boolean; runState: string; reason: string } {
  const refuse = (reason: string, owned = false, runState = 'unknown') => ({ outcome: 'refused' as const, owned, runState, reason });
  let result: ReturnType<typeof refuse> | { outcome: 'sent'; owned: true; runState: string; reason: string };
  let handle: HarnessProcessSignalHandle | undefined;
  let handleFailure: string | undefined;
  if (Number.isSafeInteger(pid) && pid > 1) {
    try { handle = (deps.openProcessHandle ?? openHarnessProcessHandle)(pid); }
    catch (error) { handleFailure = observationFailureReason(error); }
  }
  try {
    const root = deps.repositoryRoot ?? findGitDir(process.cwd())?.root;
  const listed = normalizeProcessListObservation(deps.listProcesses?.() ?? defaultListHarnessProcesses());
  const row = listed.status === 'ok' ? listed.records.find((record) => record.pid === pid) : undefined;
  const prefix = root ? `${resolve(root)}${sep}` : '';
  const entry = prefix ? `${prefix}bin/elanous.mjs` : '';
  const argv = row?.command ?? '';
  const entryIndex = entry && [
    `bun ${entry} `, `${process.execPath} ${entry} `,
    `bun bin/elanous.mjs `,
  ].find((start) => argv.startsWith(start));
  const fromRepo = Boolean(entryIndex && (entryIndex !== 'bun bin/elanous.mjs ' || row?.cwd && resolve(row.cwd) === resolve(root!)));
  if (!Number.isSafeInteger(pid) || pid <= 1) result = refuse('invalid pid');
  else if (listed.status !== 'ok') result = refuse('process observation incomplete');
  else if (!row) result = refuse('pid not found in harness process population');
  else if (!fromRepo || !/\belanous\.mjs\s+(?:(?:--test|--config-dir\s+\S+)\s+)?(?:self\s+(?:orchestrate|implement)|harness\s+(?:ask|say))\b/.test(row.command)) result = refuse('not a harness process from this repository');
  else if (!handle) result = refuse(`pid-bound signaling unavailable: ${handleFailure ?? 'unknown failure'}`);
  else {
    let startTime: string | undefined;
    try {
      startTime = (deps.readStartTime ?? ((target) => execFileSync('ps', ['-p', String(target), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000 }).trim()))(pid);
    } catch { /* unavailable is not a timestamp */ }
    if (!startTime || !Number.isFinite(Date.parse(startTime))) result = refuse('process start time unreadable');
    else {
      const ownership = row.ownership ?? readProcessOwnership(pid);
      const runId = ownership.status === 'observed' ? ownership.runId : undefined;
      if (!runId) result = refuse('owning run unconfirmed');
      else {
        let ledger: readonly HarnessProcessLedgerEntry[] | null = null;
        try { ledger = (deps.lookupLedger ?? defaultLookupHarnessProcessLedger)(runId, ownership.status === 'observed' ? ownership.stateDir : undefined); }
        catch { /* fail closed */ }
        const last = [...(ledger ?? [])].reverse().find((entry) => entry.event === 'run-status');
        const runState = typeof last?.data?.runStatus === 'string' ? last.data.runStatus : 'unknown';
        if (!ledger || !last) result = refuse('owning run ledger unavailable', true, runState);
        else if (!['running', 'completed', 'failed', 'cancelled', 'abandoned'].includes(runState)) result = refuse('owning run status unconfirmed', true, runState);
        else if (runState === 'running' && !force) result = refuse('owning run is not terminal (use --force)', true, runState);
        else {
          try {
            const currentStart = (deps.readStartTime ?? ((target) => execFileSync('ps', ['-p', String(target), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000 }).trim()))(pid);
            if (currentStart !== startTime) result = refuse('pid start time changed', true, runState);
            else {
              handle.signal('SIGTERM');
              result = { outcome: 'sent', owned: true, runState, reason: 'SIGTERM sent' };
            }
          } catch (error) { result = refuse(`SIGTERM failed: ${observationFailureReason(error)}`, true, runState); }
        }
      }
    }
  }
  debug.log('harness.processes', 'kill', { pid, ...result });
  return result;
  } finally { handle?.close(); }
}

function installHarnessProcessObservationCommand(
  harnessCmd: Command,
  deps: HarnessProcessObservationDeps = {},
): Command {
  const write = deps.write ?? ((text: string) => { console.log(text); });
  return harnessCmd
    .command('processes')
    .description('기본 읽기 전용 분류. --kill <pid> 는 소유 런 확인 후 단일 PID 에만 SIGTERM 한다.')
    .option('--kill <pid>', '소유 런을 확인한 뒤 지정한 PID 하나만 SIGTERM')
    .option('--force', '소유 런이 진행 중이어도 지정한 PID 하나를 종료')
    .action((opts: { kill?: string; force?: boolean }) => {
      if (opts.kill !== undefined) {
        const pid = Number(opts.kill);
        const result = killHarnessProcess(pid, opts.force === true, deps);
        write(`pid=${opts.kill} ${result.outcome}: ${result.reason}`);
        if (result.outcome === 'refused') process.exitCode = 1;
        return;
      }
      if (opts.force) { write('--force requires --kill <pid>'); process.exitCode = 2; return; }
      const records = deps.listProcesses?.() ?? defaultListHarnessProcesses();
      const worktrees = deps.listWorktrees?.() ?? defaultListHarnessWorktreePaths();
      const launchd = deps.observeLaunchdPids?.() ?? observeHarnessLaunchdPids();
      const report = buildHarnessProcessReport(
        records,
        worktrees,
        deps.thresholds ?? DEFAULT_HARNESS_PROCESS_THRESHOLDS,
        'subset',
        launchd,
        deps.lookupLedger ?? defaultLookupHarnessProcessLedger,
        deps.nowMs ?? Date.now(),
      );
      for (const line of renderHarnessProcessReport(report)) write(line);
    });
}

export interface HarnessCliCommandDeps {
  registerSink: (surface: string) => Promise<void>;
  resolveSurface: () => Promise<string>;
  deliverableVerify?: InstallDeliverableVerifyCliDeps;
  processObservation?: HarnessProcessObservationDeps;
  draftSweep?: HarnessDraftSweepDeps;
  queue?: HarnessQueueDeps;
  backpressure?: BackpressureReadDeps;
  goalLookup?: GoalLookupOptions;
  goalArchive?: GoalArchiveOptions;
  ask?: HarnessAskHandler;
  say?: HarnessSayHandler;
  /** Observe-only Pod host dispatch seam. */
  podDispatchTask?: (input: DispatchTaskInput, deps?: DispatchTaskDeps) => ReturnType<typeof dispatchTask>;
  /** BENCH-ISOLATED-ARMS — 벤치 base 고정·원장 주입(시험). */
  bench?: HarnessBenchDeps;
  launchGate?: PreLaunchGateDeps & { readBudget?: () => Promise<BudgetDecision | 'unknown'> };
  plan?: HarnessPlanHandler;
  /** ⭐ `plan` 주입이 «없을 때» 가는 기본 분기. 시험이 이 자리로 «CLI 의 기본 배선»을 문다
   *  (⛔ 주입된 `plan` 이 파일을 스스로 만들면 그 시험은 배선을 «못 답한다» — 무인 리뷰 GOODHART 지적). */
  planRfc?: typeof runHarnessPlanRfc;
  mission?: HarnessMissionHandler;
  missionLoop?: HarnessMissionLoopHandler;
  /** `harness progress` 가 도는 런 관측을 읽는 자리(시험 주입). 기본은 queryRunningRuns. */
  progress?: {
    query?: typeof queryRunningRuns;
    nowMs?: () => number;
    bindingRunIds?: typeof launchBindingRunIds;
    readBinding?: typeof readLaunchBinding;
    processStartMs?: typeof psProcessStartMs;
  };
}

export function installHarnessCliCommand(program: Command, deps: HarnessCliCommandDeps): Command {
  const harnessCmd = program
    .command('harness')
    .description('dev-harness worktree 수명 — 워크트리 생성(worktree add)·조회(worktrees)·정리(clean)·프로세스 관찰(processes)');
  installHarnessCliSinkHook(harnessCmd, deps.registerSink, deps.resolveSurface);
  harnessCmd.command('doors').description('기간 안 런을 입구×대기열 경유 표로 읽는다')
    .option('--since <window>', '조회 창 (30m · 12h · 1d, 기본 1d)', '1d')
    .option('--json', '구조화 출력')
    .action((opts: { since?: string; json?: boolean }) => {
      const parsed = parseDoorSince(opts.since);
      if ('error' in parsed) {
        console.error(`❌ ${parsed.error}`);
        process.exitCode = 2;
        return;
      }
      let table: DoorTable;
      try {
        table = queryLaunchDoors({ sinceMs: parsed.sinceMs });
      } catch (error) {
        console.error(`❌ doors: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) console.log(JSON.stringify(table));
      else console.log(renderLaunchDoors(table));
    });
  harnessCmd.command('incidents').description('최근 하니스 Pod 종료 사고 원장을 읽는다')
    .option('--since <minutes>', '최근 몇 분의 종료를 볼지 (기본 15분)', '15')
    .option('--json', '구조화 출력')
    .action((opts: { since: string; json?: boolean }) => {
      const since = Number(opts.since);
      if (!Number.isFinite(since) || since < 0) {
        console.error('❌ --since 는 0 이상의 분이어야 합니다');
        process.exitCode = 2;
        return;
      }
      try {
        const root = effectiveInstanceRoot();
        const rows = readRunExits(root);
        if (rows.length === 0) {
          console.log(opts.json ? JSON.stringify({ rows: [], bursts: [] }) : '기록 없음 — 사고 0 이 아니라 아직 기록이 없다');
          return;
        }
        const now = Date.now();
        const selected = rows.filter((row) => Date.parse(row.at) >= now - since * 60_000 && Date.parse(row.at) <= now);
        const bursts = detectBursts(rows).filter((burst) => Date.parse(burst.lastAt) >= now - since * 60_000 && Date.parse(burst.lastAt) <= now);
        if (opts.json) console.log(JSON.stringify({ rows: selected, bursts }));
        else {
          for (const row of selected) console.log(`${row.at} run ${row.runId} · seat=${row.seat ?? '-'} entrance=${row.entrance ?? '-'} reason=${row.reason} · status=${row.status} signal=${row.signal ?? '-'}`);
          for (const burst of bursts) console.log(`${burst.firstAt}–${burst.lastAt} 묶음 ${burst.reason} ×${burst.count} · seat=${burst.seat ?? '-'} entrance=${burst.entrance ?? '-'} · ${burst.runIds.join(', ')}`);
        }
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  harnessCmd.command('progress').description('도는 골마다 진도를 한 표로 읽는다 — 단계 · 진입 시각 · 마지막 진전 · pty (읽기 전용)')
    .option('--json', '같은 행 배열을 JSON 으로 출력')
    .option('--pid <number>', '기록된 로컬 PID 에 연결된 런 한 건만 조회')
    .action((opts: { json?: boolean; pid?: string }) => {
      try {
        if (opts.pid !== undefined) {
          const pid = Number(opts.pid);
          if (!Number.isSafeInteger(pid) || pid <= 1) {
            console.error('❌ --pid 는 2 이상의 정수여야 합니다');
            process.exitCode = 2;
            return;
          }
          const bindings = (deps.progress?.bindingRunIds ?? launchBindingRunIds)()
            .map((runId) => ({ runId, binding: (deps.progress?.readBinding ?? readLaunchBinding)(runId) }))
            .filter(({ binding }) => binding?.pid === pid);
          const binding = bindings.length === 1 && !bindings[0]!.binding?.podName ? bindings[0] : undefined;
          const startedAt = binding ? (deps.progress?.processStartMs ?? psProcessStartMs)(pid) : null;
          // ps lstart has second precision. A wider stop-oriented tolerance would attribute a reused PID to this run.
          const observed = binding && startedAt !== null
            && startedAt === Math.floor(binding.binding!.startedAt / 1_000) * 1_000;
          const result = observed
            ? (deps.progress?.query ?? queryRunningRuns)({ runIds: [binding.runId], caller: 'harness.progress.pid' })
            : null;
          const row = result ? buildRunProgressRows(result, (deps.progress?.nowMs ?? Date.now)())
            .find((item) => item.runId === binding!.runId && item.status !== 'ended-unclosed' && item.status !== 'unknown') : undefined;
          if (opts.json) console.log(JSON.stringify({ pid, observation: row ? 'observed' : 'unobserved', runId: row?.runId ?? null, progress: row ?? null }));
          else console.log(row ? `pid ${pid} · ${renderRunProgressTable({ ...result!, entries: result!.entries.filter((item) => item.runId === row.runId) }, (deps.progress?.nowMs ?? Date.now)()).split('\n').slice(1).join('\n')}` : `pid ${pid} · 미관측`);
          return;
        }
        const result = (deps.progress?.query ?? queryRunningRuns)({ caller: 'harness.progress' });
        const nowMs = (deps.progress?.nowMs ?? Date.now)();
        if (opts.json) {
          console.log(JSON.stringify(buildRunProgressRows(result, nowMs)));
          if (isPartialRunningRuns(result)) console.error(renderRunProgressTable(result, nowMs).split('\n')[0]);
        } else console.log(renderRunProgressTable(result, nowMs));
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  installDeliverableVerifyCliCommand(harnessCmd, deps.deliverableVerify);
  installHarnessProcessObservationCommand(harnessCmd, deps.processObservation);
  installHarnessBudgetCommand(harnessCmd);
  installHarnessSalvageCommand(harnessCmd);
  installHarnessSalvageRetentionCommand(harnessCmd);
  installHarnessGoalCommand(harnessCmd, deps.goalLookup, deps.goalArchive);
  installHarnessDraftSweepCommand(harnessCmd, deps.draftSweep);
  const queue = harnessCmd.command('queue').description('자리별 영속 발사 대기열');
  queue.command('backpressure').description('읽기 전용 발사 역압 판정')
    .option('--json', '판정 객체 JSON 한 줄').option('--max <n>', '주기당 발사 상한 (기본 6)')
    .action((opts: { json?: boolean; max?: string }) => {
      if (opts.max !== undefined && (!/^(0|[1-9][0-9]*)$/.test(opts.max) || !Number.isSafeInteger(Number(opts.max)))) {
        console.error('❌ --max 는 0 이상의 정수여야 합니다');
        process.exitCode = 2;
        return;
      }
      try {
        const signals = readBackpressureSignals(deps.backpressure);
        const verdict = decideBackpressure(signals, { maxPerCycle: opts.max === undefined ? 6 : Number(opts.max) });
        debug.log('traffic.backpressure', 'verdict', { launchBudget: verdict.launchBudget, reasons: verdict.reasons, signals: verdict.signals });
        console.log(opts.json ? JSON.stringify(verdict) : `발사 예산 ${verdict.launchBudget} · 이유 ${verdict.reasons.join(', ') || '없음'}`);
      } catch (error) {
        console.error(`❌ backpressure: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  const queueDeps = deps.queue ?? {};
  let launchedExit: Promise<number> | undefined;
  const immediateLaunch: NonNullable<HarnessQueueDeps['launch']> = queueDeps.launch ?? (async (item: QueueItem, args: string[], root: string) => {
    const child = spawn(process.execPath, [join(import.meta.dir, 'harness-queue-child.ts'),
      harnessQueueReceiptPath(root, item.launchId!), queueDeps.launchCommand ?? join(import.meta.dir, '../../bin/elanous.mjs'),
      ...(resolve(root) === prodInstanceRoot() ? [] : [`--test=${root}`]), ...args], {
      cwd: item.launchCwd ?? resolve(import.meta.dir, '../..'), stdio: 'inherit',
      env: { ...process.env, ELANOUS_STATE_DIR: root,
        ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(root), ELANOUS_HARNESS_SEAT: item.seat,
        ELANOUS_HARNESS_QUEUE_LAUNCH: item.launchId! },
    });
    // Capture the end at spawn time: a child that already closed (or died by a signal) must not leave the parent waiting.
    launchedExit = new Promise<number>((done) => child.once('close', (code, signal) => {
      const signo = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
      done(code ?? (signo ? 128 + signo : 1));
    }));
    return await new Promise<number>((done, reject) => {
      child.once('spawn', () => done(child.pid!));
      child.once('error', (error) => {
        try { writeHarnessQueueReceipt(harnessQueueReceiptPath(root, item.launchId!), 'not-started'); }
        catch { /* An unreadable receipt leaves the reservation indeterminate. */ }
        reject(error);
      });
    });
  });
  const immediateExit = async (): Promise<number> => launchedExit ? await launchedExit : 0;
  const queueAction = (action: () => Promise<void>): Promise<void> => runInjectedHarnessHandler(action);
  queue.command('add').requiredOption('--seat <seat>', 'OP|TC|MK|UX')
    .option('--say <sentence>', '원문 문장').option('--ask <goal-path>', '골 문서 경로')
    .option('--hold', '자동 병합 금지').option('--heavy', 'Pod high 메모리')
    .action((opts: { seat: string; say?: string; ask?: string; hold?: boolean; heavy?: boolean }) => queueAction(async () => {
      const row = await addHarnessQueue(opts, queueDeps);
      console.log(`${row.id} ${row.seat} ${row.kind} queued`);
    }));
  queue.command('list').description('대기·발사 원장 조회').action(() => queueAction(async () => {
    for (const row of listHarnessQueue(queueDeps)) console.log(`${row.id} ${row.seat} ${row.status} ${row.kind} ${row.input}${row.priority === undefined ? '' : ` · prio ${row.priority}`}${row.waitingReason ? ` · ${row.waitingReason}` : ''}`);
  }));
  queue.command('remove <id>').description('대기 중 또는 종료 확인된 항목 제거').action((id: string) => queueAction(async () => {
    if (!await removeHarnessQueue(id, queueDeps)) throw new Error(`queue item active or not found: ${id}`);
    console.log(`${id} removed`);
  }));
  queue.command('prio <id> <n>').description('대기 중 항목의 우선순위 재조정(클수록 먼저 · 다음 tick 부터)').action((id: string, n: string) => queueAction(async () => {
    const value = Number(n);
    if (!n.trim() || !Number.isFinite(value)) throw new Error(`harness queue prio: 수가 아니다 — ${n}`);
    // A CLI call is the actor here; a seat or track that drives it names itself through the environment.
    const by = process.env.ELANOUS_TRACK || process.env.ELANOUS_HARNESS_SEAT || 'cli';
    const row = await setHarnessQueuePriority(id, value, by, queueDeps);
    console.log(`${row.id} prio ${row.priority}`);
  }));
  queue.command('reconcile <id>').description('불확정 발사를 확인하고 종료 또는 미발사 증거가 있으면 예약 해소').action((id: string) => queueAction(async () => {
    console.log(`${id} ${await reconcileHarnessQueue(id, queueDeps)}`);
  }));
  queue.command('tick').description('자리별 맨 앞 항목을 라운드로빈으로 돌며 자리 몫·Pod 풀 여유·마무리 관문을 확인하고 발사 — 여유가 있으면 한 tick 에 여러 건(30초 간격 · harness.queue.burstMax 기본 5)').action(() => queueAction(async () => {
    // NEEDS-OWNER-BOUNDARY (queue tick = autonomous): the needs-owner hold defaults ON here — this is
    // the cron surface. The census runs once per tick and is shared across every candidate seat.
    const result = await tickHarnessQueue({ ...queueDeps, needsOwnerGate: queueDeps.needsOwnerGate ?? true });
    console.log(`${result.outcome}${result.item ? ` ${result.item.id}` : ''}: ${result.reason}`);
    // QUEUE-BURST: the first line stays as before; every further launch of the burst gets its own line.
    for (const row of result.launched?.slice(1) ?? []) console.log(`launched ${row.id}: spawned`);
  }));

  const ask = deps.ask;
  if (ask) {
    registerHarnessAskSayOptions(harnessCmd.command('ask <goal-path>').description('골 문서 경로를 받아 구동한다'))
      .action(async (goalPath: string, opts: HarnessAskSayChildLlmOptions & HarnessDryRunOpts) => {
        if ((opts as HarnessSubstrateOpts).repairCommitOnly !== undefined) {
          console.error('--repair-commit-only is supported only by harness say');
          process.exitCode = 2;
          return;
        }
        await dispatchHarnessAskSay(
          opts,
          {
            input: goalPath,
            entrance: 'cli-harness-ask',
            wouldStart: '워크트리 · 브랜치 · 자식 · 파이프라인',
            goalPath,
            ...(opts.goalType !== undefined ? { goalType: opts.goalType } : {}),
            ...(opts.target !== undefined ? { target: opts.target } : {}),
          },
          (resolved, stampedOpts) => {
            if (resolved.substrate !== 'pod' && (opts as { source?: string }).source !== undefined) {
              console.error('`--source` 는 `--substrate pod` 와 함께');
              process.exitCode = 2;
              return Promise.resolve();
            }
            return resolved.substrate === 'pod' ? onPod(stampedOpts, 'cli-harness-ask', goalPath, resolved.pool!, deps.podDispatchTask) : (announceLocalChildProvider(stampedOpts), ask(goalPath, normalizeHarnessAskSayOptions(stampedOpts)));
          },
          deps.launchGate, queueDeps, immediateLaunch, queueDeps.launch ? undefined : immediateExit, deps.bench,
        );
      });
  }

  const say = deps.say;
  if (say) {
    registerHarnessAskSayOptions(harnessCmd.command('say <sentence...>').description('문장을 받아 구동한다'))
      .addOption(new Option('--author-grade <grade>', 'say 저작 등급 (full|lite)').choices(['full', 'lite']))
      .option('--move-id <id>', 'NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 이 발사를 고른 TA next-move 결정의 수 id(관측 조인 칸 · 발사 동작은 바꾸지 않는다)')
      .action(async (sentence: string[], opts: HarnessAskSayChildLlmOptions & HarnessDryRunOpts) => {
        const moveId = (opts as { moveId?: unknown }).moveId;
        // 발사 쪽 영수증 — TA 일반 재발사가 실은 수 id 를 받았다는 한 줄(관측만 · fail-soft · 옵션은 아래로 내려가지 않는다).
        if (typeof moveId === 'string' && moveId) {
          try { debug.log('harness', 'move-id-received', { entrance: 'cli-harness-say', moveId }); } catch { /* fail-soft */ }
        }
        const repair = opts as HarnessSubstrateOpts;
        if (repair.repairCommitOnly !== undefined && (repair.substrate !== 'pod' || !/^pr:[1-9]\d*$/.test(repair.source ?? '')
          || !/^[0-9a-f]{40}$/.test(repair.repairCommitOnly) || repair.autoMerge !== false || repair.target !== undefined)) {
          console.error('--repair-commit-only requires --substrate pod --source pr:N --no-auto-merge and a 40-hex expected head');
          process.exitCode = 2;
          return;
        }
        const grade = resolveGoalAuthorGrade(opts.authorGrade, getUserConfig().harness?.authorGrade);
        const podSource = process.env.ELANOUS_POD_AUTHOR_ON_POD === '1' && process.env.ELANOUS_POD_AUTHOR_GRADE === grade.grade
          ? process.env.ELANOUS_POD_AUTHOR_GRADE_SOURCE : undefined;
        const gradedOpts = grade.source === 'default' && podSource === undefined ? opts
          : { ...opts, authorGrade: grade.grade, authorGradeSource: podSource === 'config' || podSource === 'default' || podSource === 'flag' ? podSource : grade.source };
        await dispatchHarnessAskSay(
          gradedOpts,
          {
            input: sentence.join(' '),
            entrance: 'cli-harness-say',
            wouldStart: '골 문서 · 워크트리 · 브랜치 · 자식 · 파이프라인',
            ...(opts.target !== undefined ? { target: opts.target } : {}),
          },
          (resolved, stampedOpts) => {
            if (resolved.substrate !== 'pod' && (opts as { source?: string }).source !== undefined) {
              console.error('`--source` 는 `--substrate pod` 와 함께');
              process.exitCode = 2;
              return Promise.resolve();
            }
            return resolved.substrate === 'pod'
              ? onPod(stampedOpts, 'cli-harness-say', sentence.join(' '), resolved.pool!, deps.podDispatchTask, !(opts as HarnessSubstrateOpts).repairCommitOnly && harnessAuthorOnPod())
              : (announceLocalChildProvider(stampedOpts), say(sentence, normalizeHarnessAskSayOptions(stampedOpts)));
          },
          deps.launchGate, queueDeps, immediateLaunch, queueDeps.launch ? undefined : immediateExit, deps.bench,
        );
      });
  }

  const plan = deps.plan;
  registerHarnessPlanOptions(harnessCmd.command('plan <sentence...>').description('RFC를 쓰고 실행하지 않는다'))
    .action(async (sentence: string[], opts: HarnessPlanOptions & HarnessDryRunOpts) => {
      const input = sentence.join(' ');
      const dryRun = isHarnessDryRun(opts);
      await runInjectedHarnessHandler(async () => {
        // ⛔⭐ `deps.plan` 은 «시험 주입»용이다. 운영은 주입이 «없어» RFC 문으로 간다
        //   (src/index.ts 가 이 자리에 아무것도 안 준다 — 그 이유가 거기 주석에 있다).
        if (plan) { await plan(sentence, { ...normalizeHarnessPlanOptions(opts), dryRun }); return; }
        // ⛔ `rootDir`를 넘기지 않는다. 기본 handler는 harnessPlanRfcRoot()로 cwd에서 저장소 루트를 찾는다.
        await (harnessPlanRfcForTesting ?? deps.planRfc ?? runHarnessPlanRfc)(input, { dryRun });
      });
    });

  const mission = deps.mission;
  const missionLoop = deps.missionLoop;
  if (mission) {
    registerHarnessMissionOptions(harnessCmd.command('mission <mission-ids...>').description('기존 미션 하나 또는 여러 개를 읽어 하니스로 해결한다'))
      .action(async (missionIds: string[], opts: { executor?: 'self-implement' } & HarnessDryRunOpts) => {
        if (isHarnessDryRun(opts)) {
          printHarnessLaunchDryRun({
            input: missionIds.join(' '),
            entrance: 'cli-harness-mission',
            wouldStart: missionIds.length === 1
              ? '기존 미션 read · 워크트리 · 하니스 실행기'
              : `기존 미션 ${missionIds.join(', ')} read · 순차 하니스 실행기`,
          });
          return;
        }
        const missionOpts = { ...(opts.executor !== undefined ? { executor: opts.executor } : {}) };
        if (missionIds.length === 1) {
          await runInjectedHarnessHandler(() => mission(missionIds[0]!, missionOpts));
          return;
        }
        if (!missionLoop) {
          console.error('❌ harness mission 다건 실행기를 사용할 수 없음');
          process.exitCode = 1;
          return;
        }
        try {
          renderHarnessMissionOutcomes(await missionLoop(missionIds, missionOpts));
        } catch (error) {
          console.error(humanErrorLine(error));
          process.exitCode = 1;
        }
      });
  }
  return harnessCmd;
}
