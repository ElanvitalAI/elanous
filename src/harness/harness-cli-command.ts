import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dlopen, FFIType } from 'bun:ffi';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { constants as osConstants, hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { findGitDir } from '../git-fs/locate.js';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';
import { loadSelfDevRun } from '../self-dev/run-store.js';
import { normalizeRunId } from './harness-space.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { lookupGoal, type GoalLookupOptions, type GoalLookupResult } from '../self-implement/goal-lookup.js';
import { archiveGoals, type GoalArchiveOptions } from '../self-implement/goal-archive.js';
import { detectBursts, formatIncidentBurstWarning, incidentLastLines, readRunExits, recentBurst, recordRunExit } from './harness-incidents.js';
import { Command, Option } from 'commander';
import { runGitCommand } from '../git-fs/runner.js';
import { GOAL_TYPES, lintGoalFile, parseGoalId, parseGoalType, resolveGoalAuthorGrade, tracedPathReferences, type GoalAuthorGrade, type GoalAuthorGradeSelection, type GoalType } from '../self-implement/goal-author.js';
import { templateForGoalType } from '../self-implement/graph-templates.js';
import { listRunLedgers, loadFederatedRunLedger, loadRunLedger, queryRunScreenKey, runLedgerDir, type RunLedgerMatch } from '../self-implement/run-ledger.js';
import { classifyPodExitStop, recordRunStop, runStopRecorded, RUN_STOP_EVENT } from '../self-implement/run-stop.js';
import { resolveChildLlmEffort, resolveImplementationChildModel } from '../self-dev/dev-cli.js';
import { resolveHarnessTarget } from '../self-implement/harness-target-options.js';
import { queryRunningRuns } from '../self-implement/running-runs.js';
import { DevPipelineError } from '../self-dev/dev-pipeline.js';
import { DRAFT_SWEEP_CONCURRENCY, mapBounded, runDraftSweep, sweepFailureReason, type DraftSweepAdapters, type DraftSweepResult, type SweepDraft, type SweepMergedPr, type SweepReviewGate } from '../self-dev/draft-sweep.js';
import { debug } from '../debug/log.js';
import { installHarnessSalvageCommand, installHarnessSalvageRetentionCommand } from './harness-salvage-cli.js';
import { decideNestedElanousLaunch, readNestedElanousDepth } from './nested-elanous-policy.js';
import { dispatchTask, type DispatchTaskInput, type DispatchTaskDeps } from '../execution-loop/dispatch-task.js';
import { launchRequestId, preLaunchGate, type PreLaunchGateDeps } from '../execution-loop/launch-gate.js';
import { PR_LABELS } from '../github/pr-labels.js';
import { CODEX_PROVIDER, GROK_PROVIDER, decideBudget, decideLaunchBudget, readBudgetInputsLive, type BudgetDecision, type BudgetInputs } from '../self-implement/budget-gate.js';
import { DEFAULT_FALLBACK_CHAIN } from '../oauth/fallback-chain.js';
import { installDeliverableVerifyCliCommand, type InstallDeliverableVerifyCliDeps } from './deliverable-verify-cli.js';
import { getUserConfig } from '../user-config.js';
import type { SiblingResyncAdapters, SiblingResyncResult, SiblingRunTarget } from '../self-implement/sibling-resync.js';
import type { RunTtlAdapters, RunTtlResult } from '../self-implement/run-ttl.js';
import type { ControlMemoPayload } from './control-inbox.js';
import { resolveRepositoryName } from './repository-name.js';
import { installHarnessCliSinkHook } from './harness-cli-sink.js';
import { addHarnessQueue, HarnessQueueDuplicateError, harnessQueueReceiptPath, listHarnessQueue, queueSeatForCwd, reconcileHarnessQueue, removeHarnessQueue, setHarnessQueuePriority, tickHarnessQueue, type HarnessQueueDeps, type QueueItem, type QueueSeat } from './harness-queue.js';
import { writeHarnessQueueReceipt } from './harness-queue-child.js';
import { parseDoorSince, queryLaunchDoors, renderLaunchDoors, type DoorTable } from './launch-stamp.js';
import { resolveHarnessSubstrate, type ResolvedHarnessSubstrate } from './harness-substrate-default.js';
import { runHarnessPlanRfc } from './harness-plan-rfc.js';
import { classifyGarbage, isGarbageProcessTarget, type GarbageProcess } from './process-garbage.js';
import type { MissionSolveOutcome } from './mission-solve-loop.js';
import { formatAxis, formatAxisObservations, inspectAskMarkers, inspectUnpressedDecisionSignals } from '../../scripts/ask-marker-check.js';

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

export type HarnessSupervisorSource = 'flag' | 'default';

/** A command-line value was rejected before any harness work began. */
export class HarnessCliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessCliInputError';
    Object.defineProperty(this, Symbol.for('elanous.cli.HarnessCliInputError'), { value: true });
  }
}

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
    .option('--source <spec>', 'pod: 원천 — commit:<40자 sha> | pr:<정수> | worktree:<경로> | files:<경로>[,<경로>…] · `--substrate pod` 와 함께');
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
type HarnessSubstrateOpts = { substrate?: 'local' | 'pod'; podPool?: string; podMemory?: 'lite' | 'standard' | 'high'; after?: string; autoMerge?: boolean; base?: string; json?: boolean; target?: string; source?: string; seat?: QueueSeat };
function resolveLaunchSubstrate(opts: HarnessSubstrateOpts): ResolvedHarnessSubstrate {
  const resolved = resolveHarnessSubstrate({ flag: opts, config: getUserConfig(), env: process.env });
  debug.log('harness.substrate', 'resolved', resolved);
  const head = `[harness] substrate=${resolved.substrate}${resolved.substrate === 'pod' ? ` pool=${resolved.pool}` : ''} (${resolved.source})`;
  if (opts.json) console.error(head);
  else console.log(head);
  return resolved;
}
type PodExit = { status: number | null; signal?: string | null };
type PodExitReason = 'signal' | 'human-stop' | 'supervisor' | 'no-launch' | 'unknown'
  | 'pod-error' | 'launch-gate-blocked' | 'ENOBUFS' | 'OOMKilled';

function unknownPodExitTailReason(output: string): PodExitReason | undefined {
  const tail = output.slice(-16_000);
  if (/\bOOMKilled\b/i.test(tail)) return 'OOMKilled';
  if (/\bENOBUFS\b/i.test(tail)) return 'ENOBUFS';
  if (/launch gate[^\r\n]*blocked|blocked[^\r\n]*launch gate/i.test(tail)) return 'launch-gate-blocked';
  if (/\bpod-error\b/i.test(tail)) return 'pod-error';
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
): { lines: string[]; reason: PodExitReason | 'pod-failure' } {
  let podFailure: string | undefined;
  let podJobFailed = false;
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
        break;
      }
    } catch { /* Non-result stdout cannot establish that a Pod child ran. */ }
    if (podFailure) break;
  }
  if (!podFailure) {
    const summary = output.split('\n').find((line) => /\s❌\sfailed · .* — pod-[\w-]+: /.test(line));
    podFailure = summary?.split(/\s❌\sfailed · .* — pod-[\w-]+: /)[1];
    podJobFailed = summary?.includes(' — pod-job-failed: ') ?? false;
  }
  // Only the run announced at launch — another run id quoted in the output is not this run (review round 3).
  const observedRunId = deps.runId ?? harnessPodRunId(output);
  const runId = observedRunId ? normalizeRunId(observedRunId) : undefined;
  if (podFailure) {
    const childError = podJobFailed ? podFailure.split('childError=')[1]?.split('\\n', 1)[0]?.split('\n', 1)[0] : undefined;
    try { debug.log('harness.pod', 'exit-classified', { runId, reason: 'pod-failure', status: exit.status, signal: exit.signal ?? null }); } catch { /* observation is fail-soft */ }
    return { reason: 'pod-failure', lines: [podJobFailed && childError && childError !== 'no-result-line'
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
    const signal = status > 128
      ? Object.entries(osConstants.signals).find(([, number]) => number === status - 128)?.[0] ?? null : null;
    const cwd = process.cwd();
    const seat = context.seat ?? process.env.ELANOUS_HARNESS_SEAT;
    recordRunExit({ runId, reason, status, signal, at: new Date().toISOString(),
      ...(context.entrance ? { entrance: context.entrance } : {}),
      ...(['OP', 'TC', 'MK', 'UX'].includes(seat ?? '') ? { seat } : {}),
      cwd: `${basename(dirname(cwd))}/${basename(cwd)}`, hostname: hostname().split('.')[0]!, pid: process.pid,
      ...(context.output ? { lastLines: incidentLastLines(context.output) } : {}),
    }, effectiveInstanceRoot());
  } catch { /* incident writes cannot change Pod output or exit */ }
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
    ...(child.childLlmEffort?.trim() ? { childLlmEffort: child.childLlmEffort.trim() } : {}), ...(authorOnPod && podAuthorGrade ? { authorGrade: podAuthorGrade.grade, authorGradeSource: podAuthorGrade.source } : {}), ...(dispatchRecorded ? { dispatchRecorded: true } : {}), ...(o.podMemory ? { podMemory: o.podMemory } : {}), ...((opts as HarnessAskSayChildLlmOptions).goalType ? { goalType: (opts as HarnessAskSayChildLlmOptions).goalType } : {}), ...(o.after ? { after: o.after } : {}), ...(o.autoMerge === false ? { autoMerge: false } : {}), ...(o.base ? { base: o.base } : {}), ...(o.json ? { json: true } : {}), ...(o.source ? { source: o.source } : {}), ...(o.seat ? { seat: o.seat } : {}) },
    { onOutput: (text) => {
      runId ??= harnessPodRunId(output + text);
      output = (output + text).slice(-16_000);
    } });
  if (status !== 0) {
    const classified = classifyHarnessPodExit({ status }, output, { ...(runId ? { runId } : {}) });
    recordClassifiedHarnessPodExit(runId ?? harnessPodRunId(output), classified.reason, status,
      { entrance, seat: o.seat, output });
    recordHarnessPodStop(runId ?? harnessPodRunId(output), status, classified);
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
  classified: { reason: string; lines: string[] },
  deps: { loadLedger?: typeof loadRunLedger; record?: typeof recordRunStop } = {},
): boolean {
  if (!runId) return false;
  try {
    if (runStopRecorded(runId)) return false;
    if ((deps.loadLedger ?? loadRunLedger)(runId)?.some((entry) => entry.event === RUN_STOP_EVENT)) return false;
    // The classified line is our own one-line verdict («Pod 안 자식이 실패했다 — OOMKilled»), not the raw output tail.
    const verdict = classified.lines[0]?.split(' — ').slice(1).join(' — ').trim();
    (deps.record ?? recordRunStop)({
      runId, site: 'pod-exit', class: classifyPodExitStop(classified.reason),
      cause: `Pod exit ${status}: ${classified.reason}${verdict ? ` — ${verdict}` : ''}`,
      evidenceRef: `logs:harness.pod/exit-classified:${runId}`,
      nextMove: classified.reason === 'no-launch' ? 'Check Pod launch gate and pool, then relaunch'
        : 'Inspect Pod exit classification and harvest the branch before relaunch',
    });
    return true;
  } catch { return false; /* ledger observation cannot change Pod output or exit */ }
}

const LAUNCH_BUDGET_PROVIDER: Readonly<Record<string, string>> = { 'codex-rotate': CODEX_PROVIDER, grok: GROK_PROVIDER };

/**
 * L6 발사 관문의 예산 입력 보정 — 발사 우주의 config 에 체인이 없으면(작업 트리 = 시험 우주) 막지 않고
 * 코드 기본 체인으로 판단한다. `--child-llm-provider` 를 명시했으면 그것이 체인이다(예산 판정 밖 provider 는 통과).
 */
export function harnessLaunchBudgetDecision(
  inputs: BudgetInputs,
  opts: { readonly childLlmProvider?: string; readonly childLlmModel?: string } = {},
): { readonly decision: BudgetDecision; readonly warning?: string; readonly unmeasuredProvider?: string } {
  const explicit = opts.childLlmProvider?.trim();
  const judged = (selected: BudgetInputs) => {
    const { decision, unmeasuredProvider } = decideLaunchBudget(selected);
    return { decision, ...(unmeasuredProvider ? { unmeasuredProvider, warning: `budget: ${unmeasuredProvider} usage unmeasured — launching` } : {}) };
  };
  if (explicit) {
    if (explicit !== CODEX_PROVIDER && explicit !== GROK_PROVIDER) {
      return {
        decision: { action: 'proceed', provider: explicit, ...(opts.childLlmModel ? { model: opts.childLlmModel } : {}), reasons: [`${explicit}: 명시 provider — 예산 판정 밖`] },
        warning: `budget: ${explicit} is outside the budget gate — launched as requested`,
      };
    }
    const chain = [{ provider: explicit, ...(opts.childLlmModel ? { model: opts.childLlmModel } : {}) }];
    return judged({ ...inputs, preference: { ...inputs.preference, chain } });
  }
  if (inputs.preference.chain.length > 0) return judged(inputs);
  const chain = DEFAULT_FALLBACK_CHAIN.map((step) => ({ provider: LAUNCH_BUDGET_PROVIDER[step] ?? step }));
  const result = judged({ ...inputs, preference: { ...inputs.preference, chain } });
  return {
    ...result,
    warning: `budget: no chain in this universe's config — judged with the code default ${DEFAULT_FALLBACK_CHAIN.join(',')}${result.warning ? ` · ${result.warning}` : ''}`,
  };
}

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
): Promise<void> {
  await runInjectedHarnessHandler(async () => {
    assertHarnessChildLlmModel(opts);
    if (isHarnessDryRun(opts)) {
      resolveLaunchSubstrate(opts);
      printHarnessLaunchDryRun(dryRunPreview);
      return;
    }
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
    if (directSay && opts.queue === false) {
      try { debug.log('harness.queue', 'bypass', { seat: stampedSeat ?? null, reason: '--no-queue' }); }
      catch { /* Observation must not prevent an emergency launch. */ }
    } else if (shouldQueue && stampedSeat) {
      resolveNestedElanousOption(opts);
      const flags: string[] = [];
      const values: Array<[string, string | undefined]> = [
        ['--base', opts.base], ['--target', opts.target], ['--correlation', opts.correlation],
        ['--goal-type', opts.goalType], ...(dryRunPreview.entrance === 'cli-harness-say' ? [['--author-grade', opts.authorGradeSource === 'flag' ? opts.authorGrade : undefined] as [string, string | undefined]] : []), ['--child-llm-provider', opts.childLlmProvider],
        ['--child-llm-model', opts.childLlmModel], ['--child-llm-effort', opts.childLlmEffort],
        ['--pod-pool', (opts as HarnessSubstrateOpts).podPool], ['--pod-memory', (opts as HarnessSubstrateOpts).podMemory],
        ['--after', (opts as HarnessSubstrateOpts).after], ['--source', (opts as HarnessSubstrateOpts).source],
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
      try {
        row = await addHarnessQueue({ seat: stampedSeat, launchCwd: process.cwd(), refuseDuplicate: true,
        ...(dryRunPreview.goalPath ? { ask: dryRunPreview.goalPath } : { say: dryRunPreview.input }),
        launchArgs: ['harness', dryRunPreview.goalPath ? 'ask' : 'say', dryRunPreview.goalPath ?? dryRunPreview.input,
          '--seat', stampedSeat, ...((opts as HarnessSubstrateOpts).substrate ? ['--substrate', (opts as HarnessSubstrateOpts).substrate!] : []), ...flags,
          ...(opts.nestedElanous ? ['--nested-elanous', opts.nestedElanous] : [])],
        }, queueDeps);
        await queueDeps?.afterEnqueue?.(row);
      } catch (error) {
        if (!(error instanceof HarnessQueueDuplicateError)) throw error;
        console.error(`발사 거절 — ${error.message.replace(/[\r\n]+/g, ' ')}`);
        process.exitCode = 1;
        return;
      }
      const result = await tickHarnessQueue({ ...queueDeps, ...(immediateLaunch ? { launch: immediateLaunch } : {}) }, row.id);
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
      try { await dispatch(resolved, stampedOpts); }
      finally {
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
      await launch();
      return;
    }
    const budget = await (gate.readBudget ?? (() => readHarnessLaunchBudget(opts)))();
    const decision = preLaunchGate({ goalId, budget, forceLaunch: opts.forceGate === true }, gate);
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
    await launch();
  });
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

export function defaultListHarnessProcesses(): HarnessProcessListObservation {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,etime=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return { status: 'failed', stage: 'ps-exec', reason: observationFailureReason(error) };
  }
  const parsed = parseHarnessProcessPsOutput(out);
  if (parsed.status === 'failed') return parsed;
  const records = parsed.records.map((record) => ({
    ...record,
    ...readProcessCwd(record.pid),
    ownership: readProcessOwnership(record.pid),
  }));
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

// ⛔ `env: process.env` is required: Bun resolves the executable against the PATH it started with, not the one
//    ensure-bin-path augments. Under cron's minimal PATH the hourly sweep died with «Executable not found: gh» (2026-09-28).
const executeGh: GhExecute = (args) => execFileSync('gh', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
});

/** Merge-time adapter: reuse the sweep's GitHub inventory and worktree liveness without a second triage implementation. */
export async function supersedeMergedGoalDrafts(
  number: number, cwd: string,
  execute: GhExecute = executeGh, git: DraftSweepGitExecute = runGitCommand,
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
  const { supersedeDraftsOnMerge } = await import('../self-dev/draft-sweep.js');
  await supersedeDraftsOnMerge({ repository, merged, adapters: githubDraftSweepAdapters(execute, git, cwd) });
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
const executeGhAsync = async (args: string[]): Promise<string> => (await execFileAsync('gh', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: process.env,
})).stdout;

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
  readonly reviews: Array<{ state?: string; body?: string }> | null;
  readonly headSha: string | null;
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
    const fields = batch.map((number) => `p${number}: pullRequest(number: ${number}) { number headRefOid `
      + 'files(first: 100) { totalCount nodes { path } pageInfo { hasNextPage } } '
      + 'comments(first: 100) { totalCount nodes { body } pageInfo { hasNextPage } } '
      + 'reviews(first: 100) { totalCount nodes { state body } pageInfo { hasNextPage } } '
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
        number?: number; headRefOid?: string;
        files?: GraphqlConnection<{ path?: string }>; comments?: GraphqlConnection<{ body?: string }>;
        reviews?: GraphqlConnection<{ state?: string; body?: string }>; mergeCommit?: { oid?: string; message?: string } | null;
      } | null | undefined;
      if (!pr || pr.number !== number) continue;
      const files = completeNodes(pr.files);
      const comments = completeNodes(pr.comments);
      const reviews = completeNodes(pr.reviews);
      const detail: GraphqlPrDetail = {
        files: files && files.every((file) => typeof file?.path === 'string') ? files.map((file) => file.path!) : null,
        comments: comments && comments.every((comment) => typeof comment?.body === 'string') ? comments.map((comment) => comment.body!) : null,
        reviews: reviews && reviews.every((review) => review && typeof review === 'object')
          ? reviews.map((review) => ({ state: review.state, body: review.body })) : null,
        headSha: typeof pr.headRefOid === 'string' && pr.headRefOid ? pr.headRefOid : null,
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

export function githubDraftSweepAdapters(execute: GhExecute = executeGh, git: DraftSweepGitExecute = runGitCommand, cwd = process.cwd(),
  executeAsync: (args: string[]) => Promise<string> = execute === executeGh ? executeGhAsync : async (args) => execute(args)): GithubDraftSweepAdapters {
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
    for (let page = 1; page <= 100; page++) {
      const batch = githubPullsPage(repository, state, page, execute);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Incomplete GitHub PR inventory');
      all.push(...batch);
      if (batch.length < 100) return all;
      // An unknown update time cannot prove the rest is older — keep paging.
      const oldest = Date.parse(batch[batch.length - 1]!.updated_at ?? '');
      if (cutoff !== undefined && Number.isFinite(oldest) && oldest < cutoff) return all;
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
  const issueCommentsFor = async (repository: string, number: number, what: 'review' | 'landing'): Promise<string[]> => {
    const comments: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await ghJsonAsync<Array<{ body?: string }>>(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error(`Incomplete ${what} comment inventory`);
      comments.push(...batch.map((comment) => comment.body ?? ''));
      if (batch.length < 100) return comments;
    }
    throw new Error(`${what === 'review' ? 'Review' : 'Landing'} comment inventory exceeded pagination limit`);
  };
  const reviewGateForDraft = async (draft: SweepDraft, repository: string): Promise<SweepReviewGate | undefined> => {
    const cached = await detailFor(repository, draft.number);
    const sha = cached?.headSha
      ?? (await ghJsonAsync<{ head?: { sha?: string } }>(['api', `repos/${repository}/pulls/${draft.number}`]))?.head?.sha;
    if (!sha) return undefined;
    const comments = cached?.comments ?? await issueCommentsFor(repository, draft.number, 'review');
    const reviews = cached?.reviews
      ?? await ghJsonAsync<Array<{ state?: string; body?: string }>>(['api', `repos/${repository}/pulls/${draft.number}/reviews?per_page=100`]);
    if (!Array.isArray(reviews) || reviews.length > 100) throw new Error('Incomplete review inventory');
    const text = [...comments, ...reviews.map((review) => review.body ?? '')].join('\n');
    const [status, checkRuns] = await Promise.all([
      ghJsonAsync<{ state?: string }>(['api', `repos/${repository}/commits/${sha}/status`]),
      ghJsonAsync<{ check_runs?: Array<{ conclusion?: string | null }> }>(['api', `repos/${repository}/commits/${sha}/check-runs?per_page=100`]),
    ]);
    if (!checkRuns || !Array.isArray(checkRuns.check_runs)) throw new Error('Incomplete check-run inventory');
    const conclusions = checkRuns.check_runs.map((run) => run.conclusion ?? null);
    const gatePass = (status?.state === 'success' || status?.state === undefined)
      && conclusions.length > 0 && conclusions.every((conclusion) => conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral');
    const gateFail = status?.state === 'failure' || status?.state === 'error'
      || conclusions.some((conclusion) => conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out' || conclusion === 'action_required');
    return {
      ...(reviews.some((review) => review.state === 'APPROVED') || /(?:^|\n)\s*VERDICT:\s*PASS\b/i.test(text) ? { review: 'pass' as const } : {}),
      ...(mustFixRemains(text) ? { mustFix: true } : {}),
      ...(gatePass && !gateFail ? { gate: 'pass' as const } : gateFail ? { gate: 'fail' as const } : {}),
    };
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
      await prefetchDetails(repository, prs.map((pr) => pr.number));
      const matches = ledgerMatches ??= listRunLedgers().matches;
      return mapBounded(prs, DRAFT_SWEEP_CONCURRENCY, async (pr): Promise<SweepDraft> => ({
        number: pr.number, title: pr.title, branch: pr.head.ref,
        labels: pr.labels.map((item) => item.name), createdAt: pr.created_at, body: pr.body ?? undefined,
        changedFiles: await prFiles(repository, pr.number), ...(pr.updated_at ? { updatedAt: pr.updated_at } : {}),
        runId: currentDraftSweepRunId(matches, repository, pr.number) }));
    })());
    return draftRows.get(repository)!;
  };
  const enrichedMerged = (repository: string): Promise<SweepMergedPr[]> => {
    if (!mergedRows.has(repository)) mergedRows.set(repository, (async () => {
      const prs = (await listed(closed, repository, 'closed')).filter((pr) => pr.merged_at !== null && pr.base?.ref === 'main');
      await prefetchDetails(repository, prs.map((pr) => pr.number));
      return mapBounded(prs, DRAFT_SWEEP_CONCURRENCY, async (pr): Promise<SweepMergedPr> => ({
        number: pr.number, title: pr.title, branch: pr.head.ref, body: pr.body ?? undefined,
        mergedAt: pr.merged_at ?? undefined, changedFiles: await prFiles(repository, pr.number),
        mergeCommitMessage: await mergeCommitMessageFor(repository, pr),
        landingVerifiedComments: await landingCommentsFor(repository, pr.number) }));
    })());
    return mergedRows.get(repository)!;
  };
  let ledgerMatches: readonly RunLedgerMatch[] | undefined;
  let running: ReadonlyMap<string, string> | undefined;
  const runStatusFor = (draft: SweepDraft, repository: string): string | undefined => {
    ledgerMatches ??= listRunLedgers().matches;
    running ??= new Map(queryRunningRuns().entries.map((entry) => [entry.runId, entry.status]));
    if (draft.runId) {
      const match = ledgerMatches.find((entry) => entry.runId === draft.runId);
      return match ? draftSweepRunStatus([match], running, repository, draft.number) : undefined;
    }
    return draftSweepRunStatus(ledgerMatches, running, repository, draft.number);
  };
  return {
    openPullRequests: (repository) => listed(open, repository, 'open'),
    runLedgerMatches: () => (ledgerMatches ??= listRunLedgers().matches),
    getPrFiles: async (repository, number) => prFiles(repository, number),
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
    listMerged: async (page, perPage, repository): Promise<SweepMergedPr[]> =>
      (await enrichedMerged(repository)).slice((page - 1) * perPage, page * perPage),
    getRunStatus: async (draft, repository) => runStatusFor(draft, repository),
    getLatestFileChanges: async (draft, repository) => latestFileChangesFor(draft, repository),
    hasFinalRunResult: async (draft, repository) => {
      ledgerMatches ??= listRunLedgers().matches;
      const ownedRuns = new Set(ledgerMatches.filter((match) => {
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
      execute(['pr', 'edit', String(number), '--repo', repository, '--add-label', change.add,
        ...change.remove.flatMap((name) => ['--remove-label', name])]);
    },
    closeDraft: async (repository, number, comment) => {
      execute(['pr', 'close', String(number), '--repo', repository, '--comment', comment]);
    },
    getClaimOwner: async (repository, number) => claimCommentOwner(repository, number, execute),
    getActiveClaimOwner: async (repository, number) => {
      const pages = ghJson<Array<Array<{ body: string; created_at: string }>>>(['api', '--paginate', '--slurp',
        `repos/${repository}/issues/${number}/comments?per_page=100`], execute);
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)
        || page.some((comment) => typeof comment.body !== 'string' || !Number.isFinite(Date.parse(comment.created_at)))))
        throw new Error('Incomplete claim comments');
      const last = pages.flat().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((comment) => comment.body)
        .find((body) => draftClaimOwner(body) !== undefined || body.startsWith('🔧 처리 끝 —'));
      return last ? draftClaimOwner(last) : undefined;
    },
    getReviewGate: async (draft, repository) => reviewGateForDraft(draft, repository),
  };
}

export interface HarnessDraftSweepDeps {
  readonly adapters?: DraftSweepAdapters;
  readonly repository?: () => string;
  readonly write?: (line: string) => void;
  readonly execute?: GhExecute;
  readonly now?: () => Date;
  /** RUN-TTL step adapters. Omitted with injected `adapters` ⇒ the step is skipped (fakes never reach real gh). */
  readonly runTtl?: RunTtlAdapters;
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
          execute(['pr', 'comment', number, '--repo', repository, '--body', `🔧 처리 끝 — ${(deps.now?.() ?? new Date()).toISOString()}`]);
        } else {
          execute(['pr', 'edit', number, '--repo', repository, '--add-label', running,
            ...otherStates.flatMap((item) => ['--remove-label', item.name])]);
          execute(['pr', 'comment', number, '--repo', repository, '--body',
            `🔧 처리 중 — owner ${owner} · ${(deps.now?.() ?? new Date()).toISOString()}${opts.note?.trim() ? ` · ${opts.note.trim()}` : ''}`]);
        }
        (deps.write ?? console.log)(`#${number} ${opts.release ? 'release' : 'claim'}: ${repository}`);
      } catch (error) {
        console.error(humanErrorLine(error));
        process.exitCode = 1;
      }
    });
  return drafts.command('sweep').description('draft PR 을 조사한다 (기본: 변경 없음)')
    .option('--apply', '판정한 라벨 변경과 종료를 적용')
    .option('--json', '판정 결과를 JSON 으로 출력')
    .option('--repo <owner/name>', '조회할 GitHub 저장소')
    .action(async (opts: { apply?: boolean; json?: boolean; repo?: string }) => {
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
        // One adapter instance per sweep: its open listing and ledger scan are shared with the RUN-TTL step.
        const github = deps.adapters ? undefined : githubDraftSweepAdapters(deps.execute);
        const result: DraftSweepResult = await runDraftSweep({ repository, apply: opts.apply === true, adapters: deps.adapters ?? github! });
        const reason = result.error ? sweepFailureReason(result.error) : undefined;
        const ttlStarted = Date.now();
        const runTtl = await draftSweepRunTtl(repository, deps, github);
        try { debug.log('self-dev.draft-sweep', 'timing', { phase: 'run-ttl', ms: Date.now() - ttlStarted, count: runTtl && !('error' in runTtl) ? runTtl.considered : 0 }); } catch { /* fail-soft */ }
        if (opts.json) write(JSON.stringify({ ...(reason ? { ...result, error: reason } : result), ...(runTtl ? { runTtl } : {}) }));
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
  goalLookup?: GoalLookupOptions;
  goalArchive?: GoalArchiveOptions;
  ask?: HarnessAskHandler;
  say?: HarnessSayHandler;
  /** Observe-only Pod host dispatch seam. */
  podDispatchTask?: (input: DispatchTaskInput, deps?: DispatchTaskDeps) => ReturnType<typeof dispatchTask>;
  launchGate?: PreLaunchGateDeps & { readBudget?: () => Promise<BudgetDecision | 'unknown'> };
  plan?: HarnessPlanHandler;
  /** ⭐ `plan` 주입이 «없을 때» 가는 기본 분기. 시험이 이 자리로 «CLI 의 기본 배선»을 문다
   *  (⛔ 주입된 `plan` 이 파일을 스스로 만들면 그 시험은 배선을 «못 답한다» — 무인 리뷰 GOODHART 지적). */
  planRfc?: typeof runHarnessPlanRfc;
  mission?: HarnessMissionHandler;
  missionLoop?: HarnessMissionLoopHandler;
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
  installDeliverableVerifyCliCommand(harnessCmd, deps.deliverableVerify);
  installHarnessProcessObservationCommand(harnessCmd, deps.processObservation);
  installHarnessBudgetCommand(harnessCmd);
  installHarnessSalvageCommand(harnessCmd);
  installHarnessSalvageRetentionCommand(harnessCmd);
  installHarnessGoalCommand(harnessCmd, deps.goalLookup, deps.goalArchive);
  installHarnessDraftSweepCommand(harnessCmd, deps.draftSweep);
  const queue = harnessCmd.command('queue').description('자리별 영속 발사 대기열');
  const queueDeps = deps.queue ?? {};
  let launchedExit: Promise<number> | undefined;
  const immediateLaunch: NonNullable<HarnessQueueDeps['launch']> = queueDeps.launch ?? (async (item: QueueItem, args: string[], root: string) => {
    const child = spawn(process.execPath, [join(import.meta.dir, 'harness-queue-child.ts'),
      harnessQueueReceiptPath(root, item.launchId!), queueDeps.launchCommand ?? join(import.meta.dir, '../../bin/elanous.mjs'),
      ...(resolve(root) === prodInstanceRoot() ? [] : [`--test=${root}`]), ...args], {
      cwd: item.launchCwd ?? resolve(import.meta.dir, '../..'), stdio: 'inherit',
      env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_HARNESS_SEAT: item.seat,
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
    const result = await tickHarnessQueue(queueDeps);
    console.log(`${result.outcome}${result.item ? ` ${result.item.id}` : ''}: ${result.reason}`);
    // QUEUE-BURST: the first line stays as before; every further launch of the burst gets its own line.
    for (const row of result.launched?.slice(1) ?? []) console.log(`launched ${row.id}: spawned`);
  }));

  const ask = deps.ask;
  if (ask) {
    registerHarnessAskSayOptions(harnessCmd.command('ask <goal-path>').description('골 문서 경로를 받아 구동한다'))
      .action(async (goalPath: string, opts: HarnessAskSayChildLlmOptions & HarnessDryRunOpts) => {
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
          deps.launchGate, queueDeps, immediateLaunch, queueDeps.launch ? undefined : immediateExit,
        );
      });
  }

  const say = deps.say;
  if (say) {
    registerHarnessAskSayOptions(harnessCmd.command('say <sentence...>').description('문장을 받아 구동한다'))
      .addOption(new Option('--author-grade <grade>', 'say 저작 등급 (full|lite)').choices(['full', 'lite']))
      .action(async (sentence: string[], opts: HarnessAskSayChildLlmOptions & HarnessDryRunOpts) => {
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
              ? onPod(stampedOpts, 'cli-harness-say', sentence.join(' '), resolved.pool!, deps.podDispatchTask, harnessAuthorOnPod())
              : (announceLocalChildProvider(stampedOpts), say(sentence, normalizeHarnessAskSayOptions(stampedOpts)));
          },
          deps.launchGate, queueDeps, immediateLaunch, queueDeps.launch ? undefined : immediateExit,
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
