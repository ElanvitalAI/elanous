// elanous dev CLI 글루 seam — 옵션 → DevPipelineSpec 매핑(T7·2026-07-25).
//
// `elanous dev` 를 "통합 도그푸드 진입점"으로 — 재라우팅된 각 경로(self/plan-staged/agent-mission-pty/acp)의 핵심
// 옵션을 노출한다. 이 seam 은 CLI 옵션을 executor(+plan)에 따라 올바른 축(plan·completion·autoReview·self?·mission?)
// 으로 라우팅한다(잘못된 조합은 planDevPipeline 이 NotYetUnified 거부·정직). 순수·테스트 가능.
//
// ⚠️ interactive(chat)·parallel(orchestrate)은 dev 미지원 — chat 은 cfg-바인딩 runChatTurn 주입 필요(index.ts
//    소유)·parallel 은 coordinator 해석(decompose/board) 필요. 각자 `elanous chat` / `elanous self orchestrate` CLI.
//
// 계약: [[PLAN-u4-completion-remaining-tasks-2026-07-25]] T7 · self-implement-cli/mission-cli 대칭.

import { DevPipelineError } from './dev-pipeline.js';
import type { DevPipelineSpec, DevInput, DevCompletion, DevMissionOpts } from './dev-pipeline.js';
import { DEFAULT_BRANCH_WORKTREE_BASE, linkWorktreeDependencies } from '../git-fs/worktree.js';
import { runGitCommand } from '../git-fs/runner.js';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getHarnessSpace, normalizeSpaceId } from '../harness/harness-space.js';
import { writeHarnessStageFrame } from '../harness/harness-screen.js';
import { readSoftStopRequest } from '../harness/control-inbox.js';
import { pressDecisionSignals, type DecisionSignalPressResult } from '../self-implement/decision-signal-press.js';
import { inspectDecisionObservations, inspectDecisionSignalKinds, inspectDecisionSignalObservations } from '../../scripts/ask-marker-check.js';
import type { EvidenceMode } from '../agent-mission/driver.js';
import type { PreparedDevWorktree } from '../harness/harness-worktree-auto.js';
import type { ChildLlmEffort, ChildLlmSelection } from '../agent/run-context.js';
import { reasoningEffortCeiling } from '../intelligence-map/model-catalog.js';
import type { ReasoningEffortCeiling } from '../intelligence-map/model-catalog.js';
import { tierModel } from '../llm/model-defaults.js';
import { LLM_TIER_MAP_BY_PROVIDER } from '../model-tier/llm-tier-map.js';
import { MODEL_TIERS } from '../model-tier/types.js';
import { getCatalog } from '../registry/loader.js';
import { singleRunAsJobResult } from '../self-implement/self-implement-cli.js';
import { superviseRun, type SupervisorDecision, type SupervisorStopReason } from './run-supervisor.js';
import { readDecomposeProposals, orderPiecesTopologically } from './decompose-proposal.js';
import { observeFrontNodeEntry } from './graph-front-nodes.js';
import { goalCauseObservedFromFailureClassification, type SelfDevJobResult } from './orchestrate.js';
import { resolveRunOutcome } from '../self-implement/run-outcome.js';
import type { SelfImplementResult } from '../self-implement/orchestrator.js';
import { buildDeliverableTargets } from './deliverable-target-wiring.js';
import { observeDeliverables, type DeliverableObservationResult, type DeliverableObservationTarget } from '../harness/deliverable-observation.js';
import { debug } from '../debug/log.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { resolveChildLlmPreference, type ChildLlmPreferenceInput, type ResolvedChildLlmPreference } from '../self-implement/child-llm-preference.js';
import { readCachedGrokQuota } from '../oauth/codex-account-store.js';
import { queryAbandonedDraftPrs, type AbandonedDraftPr } from '../cli/logs-abandoned-draft-prs.js';
import { resolveLogTargets } from '../cli/logs-cli.js';
import { LogStore } from '../mss/logging/log-store.js';
import { collectObservedRunPhases, queryRunningRuns, type RunningRunAssessment, type RunningRunStatus, type RunningRunsResult } from '../self-implement/running-runs.js';
import { queryFederatedUnfinishedRunLedgers, resolveFederatedRunLedgerDirectories } from '../self-implement/run-ledger.js';
import { instanceStorePaths } from '../domains/fleet.js';
import { dirname } from 'node:path';
import { lookupEntrance, RECOMMENDED_ENTRANCE_ID_BY_SURFACE, recommendedEntranceNotice, type EntranceId } from './entrance-registry.js';
import { CLAUDE_MODELS, findClaudeModel } from '../anthropic/models.js';
import { CODEX_MODELS, findCodexModel } from '../codex/models.js';
import { findGeminiModel, GEMINI_MODELS } from '../gemini/models.js';
import { findGrokModel, GROK_MODELS } from '../grok/models.js';
import { resolveModelAlias } from '../intelligence-map/model-alias.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';

/** `dev --plan` 도움말이 가리키는 대응 문. ⛔ 도움말에 이 문자열을 리터럴로 다시 적지 마라. */
export const DEV_PLAN_REPLACEMENT = 'elanous harness say';

/** `dev --plan` 옵션 도움말. 목적지는 인자(기본=상수)에서만 온다. */
export function formatDevPlanOptionHelp(replacement: string = DEV_PLAN_REPLACEMENT): string {
  return `은퇴한 staged 하니스 옵션 — 지정하면 명시적으로 거부됨 · 대응 문 \`${replacement}\``;
}

/** dev CLI 옵션(commander) — `--no-*` 는 false 로 도착. input/executor 는 액션이 빌드해 별도 전달. */
/** `src/index.ts` dev command wrapper must not append a second JSON document after hold emits its result. */
export function shouldSuppressDevJsonWrapper(opts: Pick<DevCliOpts, 'elanous' | 'hold' | 'json'>): boolean {
  return opts.elanous === true && opts.hold === true && opts.json === true;
}

export interface DevCliOpts {
  base?: string;
  enhance?: boolean;
  file?: string;
  allowNoEvidence?: boolean;
  allowSupersededGoal?: boolean;
  allowGoalLintErrors?: boolean;
  ground?: boolean;
  target?: string;
  plan?: boolean;
  implement?: boolean;
  elanous?: boolean;
  hold?: boolean;
  readyTimeoutMs?: string;
  json?: boolean;
  goal?: string;
  maxSteps?: string;
  pollMs?: string;
  model?: string;
  attach?: string;
  observeOnly?: boolean;
  cols?: string;
  rows?: string;
  isolatedRoot?: string;
  cwd?: string;
  worktree?: boolean;
  openPr?: boolean;
  autoMerge?: boolean;
  autoReview?: boolean;
  branch?: string;
  draft?: boolean;
  maxWait?: string;
  activityGrace?: string;
  supervise?: boolean;
  superviseRounds?: string;
  childLlmProvider?: string;
  childLlmModel?: string;
  childLlmEffort?: string;
  roleLlm?: string[];
  correlation?: string;
  parentCorrelationId?: string;
  evidence?: string;
  docDir?: string;
  docGlob?: string;
  testPath?: string;
  maxRounds?: string;
  commit?: boolean;
  deliverable?: string;
  screens?: string;
  context?: string[];
  contextText?: string[];
  ask?: string;
  say?: string;
}

export type DevCliExecutor =
  | { kind: 'self' }
  | { kind: 'external'; backend: 'codex' | 'claude' | 'gemini' | 'grok'; transport: 'pty' | 'acp' };

export type DevChildExecution<T> =
  | { ok: true; result: T }
  | { ok: false; error: unknown; failure: { error: string; autoWorktree?: PreparedDevWorktree } };

export async function executeDevChild<T>(
  run: () => Promise<T>,
  autoWorktree?: PreparedDevWorktree,
): Promise<DevChildExecution<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error,
      failure: { error: message, ...(autoWorktree ? { autoWorktree } : {}) },
    };
  }
}

export interface DevSelfRunSuperviseOptions {
  /**
   * 이 dev 호출이 «시작된» 시각(첫 런 발사 전). 호출부가 첫 런을 먼저 돌리고 `initialResult` 로 넘기면
   * 이 함수 진입은 첫 런이 «끝난 뒤»다 — 그 시각을 기준으로 삼으면 첫 런 «도중»에 보낸 정지가
   * 「이 호출 전의 옛 요청」으로 버려진다(🅕 관측 2026-09-25: 정지 4초 뒤 새 라운드 발사). 생략하면 함수 진입 시각.
   */
  invocationStartedAtMs?: number;
  rounds?: number;
  completion?: string;
  runId?: string;
  goalType?: string;
  deliverableDocument?: string;
  observeDeliverables?: (targets: readonly DeliverableObservationTarget[]) => Promise<DeliverableObservationResult>;
  onDecision?: (decision: SupervisorDecision) => void;
  readProposals?: typeof readDecomposeProposals;
  executePiece?: (feature: string, opts?: { base?: string }) => Promise<SelfImplementResult>;
  pressParentSignals?: (goalFile: string) => DecisionSignalPressResult | Promise<DecisionSignalPressResult>;
  readSoftStopRequest?: typeof readSoftStopRequest;
  closeDraftPr?: (prUrl: string, comment: string, timeoutMs?: number) => boolean;
  commentDraftPr?: (prUrl: string, comment: string, timeoutMs?: number) => boolean;
  viewDraftPr?: (prUrl: string, timeoutMs?: number) => DraftPrViewState;
  queryAbandonedDraftPrs?: (timeoutMs?: number) => readonly AbandonedDraftPr[] | ProductionQueryResult<readonly AbandonedDraftPr[]>;
  queryRunningRuns?: (timeoutMs?: number, runIds?: readonly string[]) => RunningRunsResult | ScopedRunningRunsQuery;
  hasTerminalDraftTriage?: (runId: string, timeoutMs?: number) => boolean;
  queryTerminalDraftTriages?: (runIds: readonly string[], timeoutMs?: number) => Set<string>;
  startDraftTriageBudgetMs?: number;
  nowMs?: () => number;
  printDecision?: (line: string) => void;
}

export interface DevSelfRunExecution {
  result: SelfImplementResult;
  shardResults?: readonly SelfDevJobResult[];
  supervisorStopReason?: SupervisorStopReason;
}

interface DraftTriage {
  closed: number[];
  kept: number | null;
  closeFailed: number[];
  skippedNotDraft: number[];
}

export type DraftPrViewState = { isDraft: boolean; state: string } | null;

interface DraftPrTarget {
  repository: string;
  number: number;
}

function draftPrTargetFromUrl(prUrl: string): DraftPrTarget | null {
  try {
    const url = new URL(prUrl.trim());
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    return url.protocol === 'https:' && url.hostname === 'github.com' && match
      ? { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) }
      : null;
  } catch {
    return null;
  }
}

function prNumberFromUrl(prUrl: string): number | null {
  return draftPrTargetFromUrl(prUrl)?.number ?? null;
}

export function draftPrCommandArgs(prUrl: string, action: 'close' | 'comment', comment: string): string[] | null {
  const target = draftPrTargetFromUrl(prUrl);
  if (!target) return null;
  return action === 'close'
    ? ['pr', 'close', String(target.number), '--repo', target.repository, '--comment', comment]
    : ['pr', 'comment', String(target.number), '--repo', target.repository, '--body', comment];
}

const IN_TEST_PROCESS = (): boolean => process.env.NODE_ENV === 'test';

function defaultCloseDraftPr(prUrl: string, comment: string, timeoutMs?: number): boolean {
  if (IN_TEST_PROCESS()) return false;
  const args = draftPrCommandArgs(prUrl, 'close', comment);
  return args !== null && spawnSync('gh', args, { encoding: 'utf8', ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }).status === 0;
}

function defaultCommentDraftPr(prUrl: string, comment: string, timeoutMs?: number): boolean {
  if (IN_TEST_PROCESS()) return false;
  const args = draftPrCommandArgs(prUrl, 'comment', comment);
  return args !== null && spawnSync('gh', args, { encoding: 'utf8', ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }).status === 0;
}

function defaultViewDraftPr(prUrl: string, timeoutMs?: number): DraftPrViewState {
  if (IN_TEST_PROCESS()) return null;
  const target = draftPrTargetFromUrl(prUrl);
  if (!target) return null;
  const view = spawnSync('gh', ['pr', 'view', String(target.number), '--repo', target.repository, '--json', 'isDraft,state'], { encoding: 'utf8', ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) });
  if (view.status !== 0) return null;
  try {
    const parsed = JSON.parse(view.stdout) as { isDraft?: unknown; state?: unknown };
    return typeof parsed.isDraft === 'boolean' && typeof parsed.state === 'string' ? { isDraft: parsed.isDraft, state: parsed.state } : null;
  } catch {
    return null;
  }
}

const START_DRAFT_TRIAGE_HANDOFF = '하니스 시작 트리아지: 이 런은 종결 트리아지 없이 끝났다 · 이 draft 가 이 런의 유일한 사람 판단 대상';

export function collectRunDraftPrUrls(observed: readonly Pick<SelfImplementResult, 'prUrl' | 'merged'>[]): string[] {
  const latest = new Map<string, { index: number; merged: boolean }>();
  observed.forEach((candidate, index) => {
    if (!candidate.prUrl) return;
    latest.set(candidate.prUrl, { index, merged: candidate.merged === true });
  });
  return [...latest.entries()]
    .filter(([, seen]) => !seen.merged)
    .sort((a, b) => a[1].index - b[1].index)
    .map(([prUrl]) => prUrl);
}

export function resolveDevCompletionRunId(
  devRunId: string,
  result: SelfImplementResult | undefined,
  supervisorStopReason: SupervisorStopReason | undefined,
): string {
  return supervisorStopReason && result ? result.runId : devRunId;
}

export function describeNonPromotableReason(input: {
  alreadyPromoted: boolean;
  hasPieceExecutor: boolean;
  taskDecomposable: boolean;
  decomposableCount: number;
  previous: readonly SelfDevJobResult[];
  feature: string;
  pieceCount: number;
}): string {
  if (input.alreadyPromoted) return 'dev-no-promotable-pieces: already-promoted';
  if (!input.hasPieceExecutor) return 'dev-no-promotable-pieces: no-piece-executor';
  if (!input.taskDecomposable) {
    return `dev-no-promotable-pieces: task-not-decomposable (decomposable=${input.decomposableCount})`;
  }
  const hasPieces = (job: SelfDevJobResult): boolean => (job.decomposeProposal?.pieces?.length ?? 0) > 1;
  const matched = input.previous.filter((job) => job.feature === input.feature);
  return `dev-no-promotable-pieces: pieces=${input.pieceCount}`
    + ` (previous=${input.previous.length} featureMatched=${matched.length}`
    + ` withProposal=${matched.filter(hasPieces).length}`
    + ` withProposalAnyJob=${input.previous.filter(hasPieces).length})`;
}

export function hydrateDevDecomposeProposals(
  results: readonly SelfDevJobResult[],
  readProposals: typeof readDecomposeProposals,
): SelfDevJobResult[] {
  const candidates = results.filter((result) => !(result.stage === 'merged' && result.merged === true)
    && (!result.decomposeProposal || !result.goalPlanRevision));
  if (candidates.length === 0) return [...results];
  const shardIds = candidates.map(({ taskId }) => taskId);
  const runIds = [...new Set(candidates.flatMap(({ runId }) => runId?.trim() ? [runId] : []))];
  let scan: ReturnType<typeof readDecomposeProposals>;
  try {
    scan = readProposals({ shardIds, runIds });
  } catch (error) {
    try {
      debug.log('self-dev.supervisor', 'decompose-proposal.backfill-failed', {
        requested: shardIds.length, runIds: runIds.length,
        error: String((error as { message?: string })?.message ?? error).slice(0, 200), surface: 'dev',
      }, { level: 'warn' });
    } catch { /* fail-open */ }
    return [...results];
  }
  const queried = new Set(candidates.map(({ taskId }) => taskId));
  let attached = 0;
  const hydrated = results.map((result) => {
    if (!queried.has(result.taskId)) return result;
    const runId = result.runId?.trim();
    const proposal = scan.proposals.get(result.taskId) ?? (runId ? scan.proposals.get(runId) : undefined);
    const revision = scan.goalPlanRevisions.get(result.taskId)
      ?? (runId ? scan.goalPlanRevisions.get(runId) : undefined)
      ?? scan.readFailure;
    if (!result.decomposeProposal && proposal) attached += 1;
    return {
      ...result,
      ...(!result.decomposeProposal && proposal ? { decomposeProposal: { pieces: proposal.pieces } } : {}),
      ...(!result.goalPlanRevision && revision ? { goalPlanRevision: revision } : {}),
    };
  });
  try {
    debug.log('self-dev.supervisor', 'decompose-proposal.backfill', {
      requested: shardIds.length, runIds: runIds.length,
      found: scan.proposals.size, attached,
      goalPlanRevisions: scan.goalPlanRevisions.size, readFailure: scan.readFailure?.reason,
      scannedFiles: scan.scannedFiles, unreadableFiles: scan.unreadableFiles,
      directoryMissing: scan.directoryMissing, surface: 'dev',
    }, scan.unreadableFiles > 0 || scan.directoryMissing ? { level: 'warn' } : undefined);
  } catch { /* fail-open */ }
  return hydrated;
}

export function foldDevShardResults(results: readonly SelfDevJobResult[]): SelfDevJobResult | undefined {
  return results.at(-1);
}

export function hydrateDevGoalCauseObserved(
  results: readonly SelfDevJobResult[],
): SelfDevJobResult[] {
  return results.map((result) => {
    if (result.goalCauseObserved === true) return result;
    const observed = goalCauseObservedFromFailureClassification(result.failureClassification);
    return observed === true ? { ...result, goalCauseObserved: true } : result;
  });
}

function pressParentGoalSignals(goalFile: string): DecisionSignalPressResult {
  const tree = mkdtempSync(join(tmpdir(), 'elanous-parent-signals-'));
  let attached = false;
  try {
    const fetch = runGitCommand(process.cwd(), ['fetch', 'origin', 'main'], { encoding: 'utf8', timeout: 60_000 });
    if (fetch.status !== 0) throw new Error((fetch.stderr ?? fetch.stdout ?? 'origin/main fetch failed').trim());
    const add = runGitCommand(process.cwd(), ['worktree', 'add', '--detach', tree, 'origin/main'], { encoding: 'utf8', timeout: 60_000 });
    if (add.status !== 0) throw new Error((add.stderr ?? add.stdout ?? 'worktree add failed').trim());
    attached = true;
    linkWorktreeDependencies(process.cwd(), tree, ['node_modules']);
    const document = readFileSync(goalFile, 'utf8');
    return pressDecisionSignals({
      kinds: inspectDecisionSignalKinds(document),
      observations: inspectDecisionObservations(document),
      signals: inspectDecisionSignalObservations(document),
    }, tree);
  } finally {
    if (attached) runGitCommand(process.cwd(), ['worktree', 'remove', '--force', tree], { encoding: 'utf8', timeout: 60_000 });
    rmSync(tree, { recursive: true, force: true });
  }
}

export function renderSupervisorDecisionLine(decision: Pick<SupervisorDecision, 'action' | 'round' | 'why' | 'stopReason'>): string {
  const verb = decision.action === 'relaunch'
    ? '🔁 다시 건다'
    : decision.action === 'add-repair-task'
      ? '🩹 수리 조각을 붙인다'
      : '⏹️ 멈춘다';
  const reason = decision.action === 'stop' ? ` [${decision.stopReason ?? 'unknown'}]` : '';
  return `[supervisor] ${verb}${reason} — ${decision.why}`;
}

export const START_DRAFT_TRIAGE_LEDGER_QUERY = { all: true, includeTest: true, since: '7d' } as const;
export const DEFAULT_START_DRAFT_TRIAGE_BUDGET_MS = 10_000;

export type ProductionQueryResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'timeout' }
  | { kind: 'error'; error: string };

export function runProductionQuery<T>(moduleUrl: string, exportName: string, args: readonly unknown[], timeoutMs: number): ProductionQueryResult<T> {
  if (timeoutMs <= 0) return { kind: 'timeout' };
  const source = `const mod = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(mod[${JSON.stringify(exportName)}](...${JSON.stringify(args)})));`;
  try {
    const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: timeoutMs });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') return { kind: 'timeout' };
    if (result.error) return { kind: 'error', error: result.error.message };
    if (result.status !== 0) return { kind: 'error', error: result.stderr.trim() || `production query exited ${result.status ?? 'without status'}` };
    if (!result.stdout) return { kind: 'error', error: 'production query returned no output' };
    try {
      return { kind: 'success', value: JSON.parse(result.stdout) as T };
    } catch (caught) {
      return { kind: 'error', error: String((caught as Error).message ?? caught) };
    }
  } catch (caught) {
    return { kind: 'error', error: String((caught as Error).message ?? caught) };
  }
}

function unwrapProductionQuery<T>(result: ProductionQueryResult<T>): T | undefined {
  if (result.kind === 'success') return result.value;
  if (result.kind === 'timeout') return undefined;
  throw new Error(result.error);
}

export function defaultQueryAbandonedDraftPrs(
  query: ((options: typeof START_DRAFT_TRIAGE_LEDGER_QUERY) => readonly AbandonedDraftPr[]) | undefined = undefined,
  inTest: boolean = IN_TEST_PROCESS(),
  timeoutMs?: number,
): readonly AbandonedDraftPr[] {
  if (timeoutMs !== undefined && timeoutMs <= 0) return [];
  if (inTest) return [];
  if (query) return query(START_DRAFT_TRIAGE_LEDGER_QUERY);
  return unwrapProductionQuery(runProductionQuery<readonly AbandonedDraftPr[]>(new URL('../cli/logs-abandoned-draft-prs.js', import.meta.url).href, 'queryAbandonedDraftPrs', [START_DRAFT_TRIAGE_LEDGER_QUERY], timeoutMs ?? DEFAULT_START_DRAFT_TRIAGE_BUDGET_MS)) ?? [];
}

function defaultQueryAbandonedDraftPrsWithinBudget(timeoutMs: number): ProductionQueryResult<readonly AbandonedDraftPr[]> {
  if (timeoutMs <= 0) return { kind: 'timeout' };
  if (IN_TEST_PROCESS()) return { kind: 'success', value: [] };
  return runProductionQuery<readonly AbandonedDraftPr[]>(new URL('../cli/logs-abandoned-draft-prs.js', import.meta.url).href, 'queryAbandonedDraftPrs', [START_DRAFT_TRIAGE_LEDGER_QUERY], timeoutMs);
}

export interface ScopedRunningRunsQuery {
  readonly result: RunningRunsResult;
  /** `null` means the registered-universe inventory could not be read, never that zero universes were skipped. */
  readonly unqueriedUniverseCount: number | null;
}

export function scopedRunningRunsResult(
  result: RunningRunsResult,
  entries: readonly RunningRunAssessment[],
  unqueriedUniverseCount: number | null,
): ScopedRunningRunsQuery {
  const counts: RunningRunsResult['counts'] = { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  return {
    result: {
      ...result,
      entries,
      counts,
      total: entries.length,
      quantities: {
        ...result.quantities,
        counts: { ...result.quantities.counts, value: counts },
        total: { ...result.quantities.total, value: entries.length },
        entries: { ...result.quantities.entries, value: entries.length },
        running: { ...result.quantities.running, value: counts.running + counts['probable-running'] },
      },
    },
    unqueriedUniverseCount,
  };
}

export interface ScopedRunningRunsQueryDeps {
  readonly resolveLogTargets?: typeof resolveLogTargets;
  readonly resolveFederatedRunLedgerDirectories?: typeof resolveFederatedRunLedgerDirectories;
  readonly queryFederatedUnfinishedRunLedgers?: typeof queryFederatedUnfinishedRunLedgers;
  readonly queryRunningRuns?: typeof queryRunningRuns;
  readonly collectObservedRunPhases?: typeof collectObservedRunPhases;
}

export function queryScopedRunningRuns(deps: ScopedRunningRunsQueryDeps = {}, runIds?: readonly string[]): ScopedRunningRunsQuery {
  const resolveTargets = deps.resolveLogTargets ?? resolveLogTargets;
  const resolveLedgerDirectories = deps.resolveFederatedRunLedgerDirectories ?? resolveFederatedRunLedgerDirectories;
  const queryLedgers = deps.queryFederatedUnfinishedRunLedgers ?? queryFederatedUnfinishedRunLedgers;
  const queryRuns = deps.queryRunningRuns ?? queryRunningRuns;
  const collectPhases = deps.collectObservedRunPhases ?? collectObservedRunPhases;
  const scoped = resolveTargets({});
  if (scoped.error) throw new Error(scoped.error);
  const scopedPaths = new Set(scoped.targets.map(({ dbPath }) => dbPath));
  let unqueriedUniverseCount: number | null = null;
  let excludedTargets: readonly { name: string; dbPath: string }[] = [];
  try {
    const all = resolveTargets({ all: true, includeTest: true });
    if (!all.error) {
      excludedTargets = all.targets.filter(({ dbPath }) => !scopedPaths.has(dbPath));
      unqueriedUniverseCount = excludedTargets.length;
    }
  } catch { /* The inventory is intentionally reported as unknown below. */ }
  const ledgerDirectories = resolveLedgerDirectories({ targets: scoped.targets });
  const requestedRunIds = runIds === undefined ? {} : { runIds };
  const result = queryRuns({ ...requestedRunIds }, {
    ledgerDirectories: () => ledgerDirectories,
    queryLedgers: (options) => queryLedgers({ targets: scoped.targets, ledgerDirectories, ...(options.runIds === undefined ? {} : { runIds: options.runIds }) }),
    ptyTargets: () => scoped.targets.map(({ name, dbPath }) => ({ name, dbPath: instanceStorePaths(dirname(dirname(dbPath))).frame })),
    readRunPhases: (_options, phaseRunIds) => collectPhases(scoped.targets, phaseRunIds),
  });
  if (unqueriedUniverseCount === null) {
    const entries = result.entries.map((entry) => entry.status === 'ended-unclosed'
      ? { ...entry, status: 'unknown' as const, reason: 'unqueried-universe-inventory-unknown' }
      : entry);
    return scopedRunningRunsResult(result, entries, unqueriedUniverseCount);
  }
  if (excludedTargets.length === 0) return { result, unqueriedUniverseCount };

  // Read excluded ledgers and PTY manifests but not their phase stores. A running status
  // is safety-critical: preserve it by status, not by lifecycle metadata, and never let
  // a less certain assessment from the other scope downgrade it.
  const excludedLedgerDirectories = resolveLedgerDirectories({ targets: excludedTargets });
  const excludedResult = queryRuns({ ...requestedRunIds }, {
    ledgerDirectories: () => excludedLedgerDirectories,
    queryLedgers: (options) => queryLedgers({ targets: excludedTargets, ledgerDirectories: excludedLedgerDirectories, ...(options.runIds === undefined ? {} : { runIds: options.runIds }) }),
    ptyTargets: () => excludedTargets.map(({ name, dbPath }) => ({ name, dbPath: instanceStorePaths(dirname(dirname(dbPath))).frame })),
    readRunPhases: () => ({ events: [], targetCount: 0, unreadableTargets: [] }),
  });
  const statusPriority: Record<RunningRunStatus, number> = {
    unknown: 0,
    'ended-unclosed': 1,
    'probable-running': 2,
    running: 3,
  };
  const entriesByRunId = new Map<string, RunningRunAssessment>();
  for (const entry of [...result.entries, ...excludedResult.entries]) {
    const existing = entriesByRunId.get(entry.runId);
    if (!existing || statusPriority[entry.status] > statusPriority[existing.status]) {
      entriesByRunId.set(entry.runId, entry);
    }
  }
  return scopedRunningRunsResult(result, [...entriesByRunId.values()], unqueriedUniverseCount);
}

function defaultQueryRunningRuns(timeoutMs: number, runIds?: readonly string[]): ScopedRunningRunsQuery | undefined {
  if (timeoutMs <= 0) return undefined;
  if (IN_TEST_PROCESS()) throw new Error('running-run query requested without a test seam');
  return unwrapProductionQuery(runProductionQuery<ScopedRunningRunsQuery>(import.meta.url, 'queryScopedRunningRuns', [{}, runIds ?? []], timeoutMs));
}

export function queryTerminalDraftTriage(runId: string): boolean {
  const { targets, error } = resolveLogTargets({ all: true, includeTest: true });
  if (error) throw new Error(error);
  for (const target of targets) {
    let store: ReturnType<typeof LogStore.openReadOnly> | undefined;
    try {
      store = LogStore.openReadOnly(target.dbPath);
      for (const row of store.queryAll({ exactCategories: ['self-implement'], events: ['run-terminal'] })) {
        const data = row.data ? JSON.parse(row.data) as { runId?: string; draftTriage?: unknown } : undefined;
        if (data?.runId === runId && data.draftTriage !== undefined) return true;
      }
    } finally {
      store?.close();
    }
  }
  return false;
}

export function queryTerminalDraftTriages(runIds: Iterable<string>): Set<string> {
  const requested = new Set([...runIds].filter((runId) => runId.trim().length > 0));
  const triaged = new Set<string>();
  if (requested.size === 0) return triaged;
  const { targets, error } = resolveLogTargets({ all: true, includeTest: true });
  if (error) throw new Error(error);
  for (const target of targets) {
    let store: ReturnType<typeof LogStore.openReadOnly> | undefined;
    try {
      store = LogStore.openReadOnly(target.dbPath);
      for (const row of store.queryAll({ exactCategories: ['self-implement'], events: ['run-terminal'] })) {
        const data = row.data ? JSON.parse(row.data) as { runId?: unknown; draftTriage?: unknown } : undefined;
        if (typeof data?.runId === 'string' && data.runId.trim().length > 0 && requested.has(data.runId) && data.draftTriage !== undefined) {
          triaged.add(data.runId);
        }
      }
    } finally {
      store?.close();
    }
  }
  return triaged;
}

export function queryTerminalDraftTriageRunIds(runIds: Iterable<string>): string[] {
  return [...queryTerminalDraftTriages(runIds)];
}

/** Rotates candidates deterministically so repeated launches share no fixed first candidate. */
export function rotateDraftTriageRuns<T>(candidates: readonly T[], runId: string | undefined): T[] {
  if (!runId || candidates.length < 2) return [...candidates];
  let hash = 0x811c9dc5;
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const offset = (hash >>> 0) % candidates.length;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
}

function queryTerminalDraftTriagesWithinBudget(runIds: readonly string[], timeoutMs: number): Set<string> | undefined {
  if (IN_TEST_PROCESS()) return queryTerminalDraftTriages(runIds);
  const result = unwrapProductionQuery(runProductionQuery<string[]>(import.meta.url, 'queryTerminalDraftTriageRunIds', [runIds], timeoutMs));
  return result === undefined ? undefined : new Set(result);
}

function defaultHasTerminalDraftTriage(runId: string, timeoutMs: number): boolean | undefined {
  if (IN_TEST_PROCESS()) return queryTerminalDraftTriage(runId);
  return unwrapProductionQuery(runProductionQuery<boolean>(import.meta.url, 'queryTerminalDraftTriage', [runId], timeoutMs));
}

export function startDraftTriage(
  currentRunId: string | undefined,
  supervise?: DevSelfRunSuperviseOptions,
): void {
  const skipped: Record<'running' | 'probableRunning' | 'unknown' | 'alreadyTriaged' | 'noRunId', number> = {
    running: 0, probableRunning: 0, unknown: 0, alreadyTriaged: 0, noRunId: 0,
  };
  const considered: string[] = [];
  const closed: number[] = [];
  const closeFailed: number[] = [];
  const kept: number[] = [];
  const errors: string[] = [];
  const nowMs = supervise?.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const budgetMs = supervise?.startDraftTriageBudgetMs ?? DEFAULT_START_DRAFT_TRIAGE_BUDGET_MS;
  const deadlineMs = startedAtMs + Math.max(0, budgetMs);
  const budgetUnprocessedRunIds = new Set<string>();
  let budgetUnprocessedUnknown = false;
  let unobservedRuns: number | null = 0;
  let runningRunsQueried = false;
  let runningRunsQueriedRunIds = 0;
  let runningRunsUnqueriedUniverseCount: number | null = null;
  const stageDurationsMs = {
    draftList: 0,
    terminalTriage: 0,
    runningRuns: 0,
    draftView: 0,
  };
  const measureStage = <T>(stage: keyof typeof stageDurationsMs, invoke: () => T): T => {
    const stageStartedAtMs = nowMs();
    try {
      return invoke();
    } finally {
      stageDurationsMs[stage] += nowMs() - stageStartedAtMs;
    }
  };
  const remainingMs = (): number => Math.max(0, deadlineMs - nowMs());
  const budgetExhausted = (): boolean => remainingMs() === 0;
  const noteUnprocessed = (runIds: Iterable<string>): void => {
    for (const runId of runIds) budgetUnprocessedRunIds.add(runId);
  };
  const noteError = (caught: unknown): void => {
    const message = String((caught as Error)?.message ?? caught);
    if (!errors.includes(message)) errors.push(message);
  };
  try {
    const invokeWithinBudget = <T>(invoke: (timeoutMs: number) => T): T | undefined => {
      const timeoutMs = remainingMs();
      return timeoutMs > 0 ? invoke(timeoutMs) : undefined;
    };
    const draftQuery = measureStage('draftList', () => invokeWithinBudget((timeoutMs) => supervise?.queryAbandonedDraftPrs?.(timeoutMs) ?? defaultQueryAbandonedDraftPrsWithinBudget(timeoutMs)));
    if (draftQuery === undefined) {
      budgetUnprocessedUnknown = true;
      unobservedRuns = null;
      return;
    }
    const draftResult: ProductionQueryResult<readonly AbandonedDraftPr[]> = Array.isArray(draftQuery)
      ? { kind: 'success', value: draftQuery as readonly AbandonedDraftPr[] }
      : draftQuery as ProductionQueryResult<readonly AbandonedDraftPr[]>;
    if (draftResult.kind === 'timeout') {
      budgetUnprocessedUnknown = true;
      unobservedRuns = null;
      return;
    }
    if (draftResult.kind === 'error') throw new Error(draftResult.error);
    const drafts = draftResult.value;
    const byRun = new Map<string, AbandonedDraftPr[]>();
    for (const draft of drafts) {
      if (!draft.runId) { skipped.noRunId += 1; continue; }
      if (draft.runId === currentRunId) continue;
      const group = byRun.get(draft.runId) ?? [];
      if (!group.some((candidate) => candidate.number === draft.number)) group.push(draft);
      byRun.set(draft.runId, group);
    }
    const byRunEntries = rotateDraftTriageRuns([...byRun.entries()], currentRunId);
    if (byRunEntries.length === 0) return;
    if (budgetExhausted()) {
      unobservedRuns = byRun.size;
      noteUnprocessed(byRun.keys());
      return;
    }
    const candidateRunIds = [...byRun.keys()];
    runningRunsQueriedRunIds = candidateRunIds.length;
    const runningRunsQuery = measureStage('runningRuns', () => invokeWithinBudget((timeoutMs) => supervise?.queryRunningRuns?.(timeoutMs, candidateRunIds) ?? defaultQueryRunningRuns(timeoutMs, candidateRunIds)));
    if (runningRunsQuery === undefined) {
      unobservedRuns = byRun.size;
      noteUnprocessed(byRun.keys());
      return;
    }
    // ⭐ seam 이 «범위 메타데이터 없는» 예전 모양을 줘도 받는다 — 그때는 「모른다」(null)이지 0이 아니다.
    const runningRuns = 'result' in runningRunsQuery ? runningRunsQuery.result : runningRunsQuery;
    runningRunsUnqueriedUniverseCount = 'unqueriedUniverseCount' in runningRunsQuery
      ? runningRunsQuery.unqueriedUniverseCount
      : null;
    runningRunsQueried = true;
    const statuses = new Map(runningRuns.entries.map(({ runId, status }) => [runId, status]));
    const protectedCandidates = new Map<string, AbandonedDraftPr[]>();
    for (const [runId, runDrafts] of byRunEntries) {
      const status: RunningRunStatus | undefined = statuses.get(runId);
      if (status === 'running') { skipped.running += 1; continue; }
      if (status === 'probable-running') { skipped.probableRunning += 1; continue; }
      if (status !== 'ended-unclosed') { skipped.unknown += 1; continue; }
      protectedCandidates.set(runId, runDrafts);
    }
    if (protectedCandidates.size === 0) return;
    if (budgetExhausted()) {
      noteUnprocessed(protectedCandidates.keys());
      return;
    }
    const terminalTriageByRun = new Map<string, boolean>();
    const hasTerminalTriage = (runId: string): boolean | undefined => {
      const cached = terminalTriageByRun.get(runId);
      if (cached !== undefined) return cached;
      const terminalTriage = measureStage('terminalTriage', () => invokeWithinBudget((timeoutMs) => supervise?.hasTerminalDraftTriage?.(runId, timeoutMs) ?? defaultHasTerminalDraftTriage(runId, timeoutMs)));
      if (terminalTriage !== undefined) terminalTriageByRun.set(runId, terminalTriage);
      return terminalTriage;
    };
    const useBatchTerminalTriage = supervise?.queryTerminalDraftTriages !== undefined || supervise?.hasTerminalDraftTriage === undefined;
    if (useBatchTerminalTriage) {
      const runIds = [...protectedCandidates.keys()];
      const triagedRunIds = measureStage('terminalTriage', () => invokeWithinBudget((timeoutMs) => supervise?.queryTerminalDraftTriages?.(runIds, timeoutMs)
        ?? queryTerminalDraftTriagesWithinBudget(runIds, timeoutMs)));
      if (triagedRunIds === undefined) {
        noteUnprocessed(runIds);
        return;
      }
      for (const runId of runIds) terminalTriageByRun.set(runId, triagedRunIds.has(runId));
    }
    const candidates = new Map<string, AbandonedDraftPr[]>();
    const protectedEntries = [...protectedCandidates.entries()];
    for (const [index, [runId, runDrafts]] of protectedEntries.entries()) {
      if (budgetExhausted()) {
        noteUnprocessed(protectedEntries.slice(index).map(([id]) => id));
        break;
      }
      const terminalTriage = hasTerminalTriage(runId);
      if (terminalTriage === undefined) { noteUnprocessed(protectedEntries.slice(index).map(([id]) => id)); break; }
      if (terminalTriage) { skipped.alreadyTriaged += 1; continue; }
      candidates.set(runId, runDrafts);
    }
    const candidateEntries = [...candidates.entries()];
    for (const [index, [runId, runDrafts]] of candidateEntries.entries()) {
      if (budgetExhausted()) {
        noteUnprocessed(candidateEntries.slice(index).map(([id]) => id));
        break;
      }
      const terminalTriage = hasTerminalTriage(runId);
      if (terminalTriage === undefined) { noteUnprocessed(candidateEntries.slice(index).map(([id]) => id)); break; }
      if (terminalTriage) { skipped.alreadyTriaged += 1; continue; }
      considered.push(runId);
      const view = supervise?.viewDraftPr ?? defaultViewDraftPr;
      const openDrafts: AbandonedDraftPr[] = [];
      for (const draft of runDrafts.filter((candidate) => candidate.url !== null).sort((a, b) => a.openedAtMs - b.openedAtMs || a.number - b.number)) {
        if (budgetExhausted()) { noteUnprocessed([runId]); break; }
        try {
          const live = measureStage('draftView', () => invokeWithinBudget((timeoutMs) => view(draft.url!, timeoutMs)));
          if (live === undefined) { noteUnprocessed([runId]); break; }
          if (live?.isDraft === true && live.state === 'OPEN') openDrafts.push(draft);
        } catch (caught) {
          noteError(caught);
        }
      }
      if (budgetExhausted()) { noteUnprocessed(candidateEntries.slice(index).map(([id]) => id)); break; }
      const retained = openDrafts.at(-1);
      if (!retained?.url) continue;
      kept.push(retained.number);
      const closeDraft = supervise?.closeDraftPr ?? defaultCloseDraftPr;
      let closedForRun = 0;
      for (const draft of openDrafts.slice(0, -1)) {
        if (budgetExhausted()) { noteUnprocessed([runId]); break; }
        try {
          const didClose = invokeWithinBudget((timeoutMs) => closeDraft(draft.url!, `하니스 시작 트리아지: 종결 기록 없이 끝난 런 ${runId} — 최신 산출 #${retained.number} 로 대체됨`, timeoutMs));
          if (didClose === undefined) { noteUnprocessed([runId]); break; }
          if (didClose) {
            closed.push(draft.number);
            closedForRun += 1;
          } else {
            closeFailed.push(draft.number);
            noteError(`close draft #${draft.number} failed`);
          }
        } catch (caught) {
          closeFailed.push(draft.number);
          noteError(caught);
        }
      }
      if (budgetExhausted()) { noteUnprocessed(candidateEntries.slice(index).map(([id]) => id)); break; }
      if (closedForRun > 0) {
        try {
          const didComment = invokeWithinBudget((timeoutMs) => (supervise?.commentDraftPr ?? defaultCommentDraftPr)(retained.url!, START_DRAFT_TRIAGE_HANDOFF, timeoutMs));
          if (didComment === undefined) { noteUnprocessed(candidateEntries.slice(index).map(([id]) => id)); break; }
          if (!didComment) noteError(`comment retained draft #${retained.number} failed`);
        } catch (caught) {
          noteError(caught);
        }
      }
    }
  } catch (caught) {
    noteError(caught);
  } finally {
    try {
      const elapsedMs = nowMs() - startedAtMs;
      const stageDurationMs = stageDurationsMs.draftList
        + stageDurationsMs.terminalTriage
        + stageDurationsMs.runningRuns
        + stageDurationsMs.draftView;
      debug.log('self-implement', 'draft-triage-start', { runId: currentRunId ?? null, considered, closed, kept, closeFailed, skipped, budgetUnprocessed: budgetUnprocessedUnknown ? null : budgetUnprocessedRunIds.size, unobservedRuns, budgetExhausted: budgetUnprocessedUnknown || budgetExhausted(), elapsedMs, runningRunsQueried, runningRunsQueriedRunIds, runningRunsUnqueriedUniverseCount, draftListDurationMs: stageDurationsMs.draftList, terminalTriageDurationMs: stageDurationsMs.terminalTriage, runningRunsDurationMs: stageDurationsMs.runningRuns, draftViewDurationMs: stageDurationsMs.draftView, unaccountedDurationMs: elapsedMs - stageDurationMs, ...(errors.length === 0 ? {} : { error: errors.join('; ') }) });
    } catch { /* fail-open */ }
  }
}

/** Runs a single dev self-goal once by default, or reruns that same goal through the shared supervisor. */
export async function executeDevSelfRun(
  feature: string,
  execute: (relaunch?: boolean) => Promise<SelfImplementResult>,
  supervise?: DevSelfRunSuperviseOptions,
  initialResult?: SelfImplementResult,
): Promise<DevSelfRunExecution> {
  const enteredAtMs = Date.now();
  let result: SelfImplementResult | undefined;
  let supervisorStopReason: SupervisorStopReason | undefined;
  let finalSupervisorDecision: SupervisorDecision | undefined;
  let confirmedMerge: SelfImplementResult | undefined;
  const landedPieces = new Set<number>();
  let executionFailed = false;
  let terminalError: unknown;
  let draftTriage: DraftTriage | undefined;
  let executedRounds = 0;
  const observedResults: SelfImplementResult[] = [];
  const recordResult = (candidate: SelfImplementResult): SelfImplementResult => {
    observedResults.push(candidate);
    return candidate;
  };
  const triageDrafts = (): void => {
    const drafts = collectRunDraftPrUrls(observedResults);
    if (drafts.length === 0) return;
    const mergedNumbers = [...new Set(observedResults
      .filter((candidate) => candidate.merged === true && candidate.prNumber !== undefined)
      .map((candidate) => candidate.prNumber!))];
    const converged = supervisorStopReason === 'converged';
    const view = supervise?.viewDraftPr ?? defaultViewDraftPr;
    const closeDraft = supervise?.closeDraftPr ?? defaultCloseDraftPr;
    const commentDraft = supervise?.commentDraftPr ?? defaultCommentDraftPr;
    const openDrafts: string[] = [];
    const skippedNotDraft: number[] = [];
    for (const prUrl of drafts) {
      let live: DraftPrViewState = null;
      try { live = view(prUrl); } catch { live = null; }
      if (live?.isDraft === true && live.state === 'OPEN') openDrafts.push(prUrl);
      else {
        const number = prNumberFromUrl(prUrl);
        if (number !== null) skippedNotDraft.push(number);
      }
    }
    const keptUrl = converged ? undefined : openDrafts.at(-1);
    const kept = keptUrl === undefined ? null : prNumberFromUrl(keptUrl);
    const closed: number[] = [];
    const closeFailed: number[] = [];
    const landed = mergedNumbers.map((n) => `#${n}`).join(' ') || '없음';
    for (const prUrl of openDrafts) {
      if (prUrl === keptUrl) continue;
      const number = prNumberFromUrl(prUrl);
      const comment = converged
        ? `하니스 종결 트리아지: 이 런이 수렴해 대체됨 — 착지 ${landed}`
        : `하니스 종결 트리아지: 최신 산출 #${kept ?? 'unknown'} 로 대체됨`;
      let ok = false;
      try { ok = closeDraft(prUrl, comment); } catch { ok = false; }
      if (number === null) continue;
      if (ok) closed.push(number);
      else closeFailed.push(number);
    }
    if (keptUrl !== undefined) {
      const rounds = Math.max(1, executedRounds);
      const handoff = closeFailed.length === 0
        ? '이 draft 가 이 골의 유일한 사람 판단 대상'
        : `닫지 못한 draft 도 남아 있다: ${closeFailed.map((n) => `#${n}`).join(' ')}`;
      const comment = `하니스 종결 트리아지: 멈춘 사유 ${supervisorStopReason ?? 'unsupervised'} · 라운드 ${rounds} · 착지한 조각 PR ${landed} · ${handoff}`;
      try { commentDraft(keptUrl, comment); } catch { /* fail-open */ }
    }
    draftTriage = { closed, kept, closeFailed, skippedNotDraft };
  };
  try {
    result = recordResult(initialResult ?? await execute());
    executedRounds = 1;
    if (!supervise) return { result };

    const asSupervisorJobResult = (currentFeature: string, current: SelfImplementResult) => singleRunAsJobResult(currentFeature, current);
    const initialJob = asSupervisorJobResult(feature, result);
    const wiring = supervise.deliverableDocument === undefined
      ? undefined
      : buildDeliverableTargets(supervise.deliverableDocument, ['single'], 'all', '127.0.0.1');
    const deliverableSkipReason = wiring === undefined
      ? 'document-missing'
      : wiring.wired ? undefined : wiring.reason;
    if (deliverableSkipReason !== undefined) {
      try { debug.log('self-dev.supervisor', 'deliverable-eye.skipped', { reason: deliverableSkipReason, surface: 'dev' }); } catch { /* fail-open */ }
    }
    const deliverableEye = wiring?.wired
      ? async () => (supervise.observeDeliverables ?? observeDeliverables)(wiring.targets)
      : undefined;

    // ⛔ 슈퍼바이저 직전이 아니라 «호출 시작»이다 — 첫 런 도중의 정지도 이 호출의 정지다.
    const invocationStartedAt = supervise.invocationStartedAtMs ?? enteredAtMs;
    const recordRestart = (kind: 'relaunch' | 'promoted-piece', previousResult: { worktreePath?: string }): boolean => {
      const spaceId = getHarnessSpace()?.id || normalizeSpaceId(basename(previousResult.worktreePath ?? ''));
      writeHarnessStageFrame(spaceId, 'supervisor', `${kind} after ${Date.now() - invocationStartedAt}ms`);
      if (!spaceId) {
        try {
          debug.log('self-dev.supervisor', 'human-stop-unchecked', { reason: 'space-unresolved', skipped: kind, surface: 'dev' });
        } catch { /* fail-open */ }
        return false;
      }
      const request = (supervise.readSoftStopRequest ?? readSoftStopRequest)(spaceId);
      if (!request || Date.parse(request.requestedAt) < invocationStartedAt) return false;
      supervisorStopReason = 'human-stopped';
      try {
        debug.log('self-dev.supervisor', 'human-stop-honored', { spaceId, requestedAt: request.requestedAt, skipped: kind === 'promoted-piece' ? 'piece' : kind, surface: 'dev' });
      } catch { /* fail-open */ }
      return true;
    };
    let promotedPieces: readonly { id: string; feature: string; dependsOn: readonly string[]; goalType?: string }[] | undefined;
    let promotedDecomposition = false;
    let shardResults: readonly SelfDevJobResult[] | undefined;
    const retainConfirmedMerge = (candidate: SelfImplementResult): void => {
      if (candidate.stage === 'merged' && candidate.merged === true) {
        confirmedMerge = candidate;
        if (candidate.prNumber !== undefined) landedPieces.add(candidate.prNumber);
      }
    };
    retainConfirmedMerge(result);
    await superviseRun({
      initial: [initialJob],
      enrich: (results) => hydrateDevGoalCauseObserved(
        hydrateDevDecomposeProposals(results, supervise.readProposals ?? readDecomposeProposals),
      ),
      limits: supervise.rounds === undefined ? {} : { maxRounds: supervise.rounds },
      ...(deliverableEye ? { observeDeliverables: deliverableEye } : {}),
      observe: (event, data) => {
        try { debug.log('self-dev.supervisor', event, { ...data, surface: 'dev' }); } catch { /* fail-open */ }
      },
      onDecision: (decision) => {
        if (decision.action === 'stop') {
          finalSupervisorDecision = decision;
          if (supervisorStopReason !== 'human-stopped') supervisorStopReason = decision.stopReason;
        }
        try { (supervise.printDecision ?? ((line: string) => console.error(line)))(renderSupervisorDecisionLine(decision)); } catch { /* fail-open */ }
        supervise.onDecision?.(decision);
      },
      promoteDecomposition: ({ decision, previous }) => {
        observeFrontNodeEntry('decompose', {
          provenance: 'supervisor-promotion-attempt',
          ...(supervise.runId === undefined ? {} : { runId: supervise.runId }),
          ...(supervise.goalType === undefined ? {} : { goalType: supervise.goalType }),
        });
        const pieces = previous.flatMap((job) => job.feature === feature ? job.decomposeProposal?.pieces ?? [] : []);
        const ordering = pieces.length > 1 ? orderPiecesTopologically(pieces) : undefined;
        const eligible = !promotedDecomposition
          && supervise.executePiece !== undefined
          && decision.decomposable.includes(initialJob.taskId);
        observeFrontNodeEntry('decompose', {
          provenance: 'supervisor-pre-promotion-decision',
          ...(supervise.runId === undefined ? {} : { runId: supervise.runId }),
        });
        if (eligible && ordering?.ordered) {
          promotedPieces = ordering.ordered;
          promotedDecomposition = true;
          return {
            pieceCount: ordering.ordered.length,
            dependsOnEdges: ordering.dependsOnEdges,
            hotPathEdges: ordering.hotPathEdges,
            reason: `dev-piece-execution: ${ordering.ordered.length} piece(s) topologically ordered`
              + ` (dependsOnEdges=${ordering.dependsOnEdges} hotPathEdges=${ordering.hotPathEdges}`
              + ` dangling=${ordering.danglingDependsOn})`,
          };
        }
        if (eligible && ordering?.cycle?.length) {
          return { reason: `dev-decomposition-cycle: ${ordering.cycle.length} piece(s) in cycle [${ordering.cycle.join(',')}]` };
        }
        const orderingNote = ordering
          ? ` (dependsOnEdges=${ordering.dependsOnEdges} hotPathEdges=${ordering.hotPathEdges}`
            + ` dangling=${ordering.danglingDependsOn}${ordering.cycle?.length ? ` cycle=${ordering.cycle.length}` : ''})`
          : '';
        return {
          reason: describeNonPromotableReason({
            alreadyPromoted: promotedDecomposition,
            hasPieceExecutor: supervise.executePiece !== undefined,
            taskDecomposable: decision.decomposable.includes(initialJob.taskId),
            decomposableCount: decision.decomposable.length,
            previous, feature, pieceCount: pieces.length,
          }) + orderingNote,
        };
      },
      rerun: async (previous, { relaunch }) => {
        if (promotedPieces !== undefined) {
          const pieces = promotedPieces;
          promotedPieces = undefined;
          const pieceResults: SelfImplementResult[] = [];
          for (const [index, piece] of pieces.entries()) {
            if (recordRestart('promoted-piece', result ?? {})) return [];
            if (index === 0) executedRounds += 1;
            const previousBranch = pieceResults.at(-1)?.branch;
            const base = supervise.completion === 'worktree-only' && previousBranch ? previousBranch : undefined;
            try {
              debug.log('self-dev.supervisor', 'decompose-piece.executed', {
                pieceIndex: index, ...(base === undefined ? {} : { base }), surface: 'dev',
              });
            } catch { /* fail-open */ }
            pieceResults.push(recordResult(await supervise.executePiece!(
              piece.feature,
              base === undefined ? undefined : { base },
            )));
          }
          shardResults = pieceResults.map((pieceResult, index) => asSupervisorJobResult(pieces[index]!.feature, pieceResult));
          const folded = foldDevShardResults(shardResults);
          if (folded) {
            result = pieceResults.at(-1)!;
            for (const pieceResult of pieceResults) retainConfirmedMerge(pieceResult);
          }
          return shardResults;
        }
        if (shardResults !== undefined) {
          try {
            debug.log('self-dev.supervisor', 'decompose-shard-results.reexecuted', {
              behavior: 're-execution', shardCount: shardResults.length, surface: 'dev',
            });
          } catch { /* fail-open */ }
        }
        if (recordRestart('relaunch', previous.at(-1)!)) return [];
        executedRounds += 1;
        const rerunResult = recordResult(await execute(relaunch));
        retainConfirmedMerge(rerunResult);
        if (shardResults === undefined) result = rerunResult;
        return [asSupervisorJobResult(feature, rerunResult)];
      },
    });
    if (supervisorStopReason === 'converged' && promotedDecomposition && (() => {
      try { return statSync(feature).isFile(); } catch { return false; }
    })()) {
      const goalFile = feature;
      const runId = supervise.runId ?? result.runId;
      try {
        const pressed = await (supervise.pressParentSignals?.(goalFile) ?? pressParentGoalSignals(goalFile));
        const unpressed = pressed.unpressed.length > 0
          ? pressed.unpressed.map(({ reason }) => reason).join(',').slice(0, 200)
          : pressed.pressedCount === 0 ? 'no-parent-decision-signals' : 'none';
        debug.log('self-dev.supervisor', 'parent-signal-press', {
          runId, goalFile, pressedGreen: pressed.pressedGreen.length, pressedRed: pressed.pressedRed.length,
          unpressed, tree: supervise.pressParentSignals ? 'injected' : 'origin/main-detached',
        });
        if (pressed.pressedRed.length > 0) supervisorStopReason = 'parent-signals-red';
      } catch (error) {
        debug.log('self-dev.supervisor', 'parent-signal-press', {
          runId, goalFile, pressedGreen: 0, pressedRed: 0,
          unpressed: String((error as Error).message ?? error).slice(0, 200) || 'press-failed',
          tree: supervise.pressParentSignals ? 'injected' : 'origin/main-detached',
        }, { level: 'warn' });
      }
    }
    if (supervisorStopReason && confirmedMerge) {
      const { mergedBase: _discardedMergedBase, prNumber: _discardedPrNumber, ...resultWithoutMergeMetadata } = result;
      result = {
        ...resultWithoutMergeMetadata,
        ...(result.outcome === 'abandoned'
          ? resolveRunOutcome({ termination: 'supervisor-abandoned', verdict: 'UNCONVERGEABLE', applied: true, merged: true })
          : {}),
        merged: true,
        ...(confirmedMerge.mergedBase !== undefined ? { mergedBase: confirmedMerge.mergedBase } : {}),
        ...(confirmedMerge.prNumber !== undefined ? { prNumber: confirmedMerge.prNumber } : {}),
      };
    }
    triageDrafts();
    return { result, ...(shardResults ? { shardResults } : {}), ...(supervisorStopReason ? { supervisorStopReason } : {}) };
  } catch (error) {
    executionFailed = true;
    terminalError = error;
    throw error;
  } finally {
    try {
      const nonConvergedStop = supervisorStopReason !== undefined && supervisorStopReason !== 'converged';
      const runStatus = nonConvergedStop
        ? confirmedMerge ? 'partial' : 'failed'
        : supervisorStopReason === 'converged' && confirmedMerge
          ? 'completed'
          : executionFailed || result?.ok === false ? 'failed' : 'completed';
      const terminalData = {
        runStatus,
        ...(result === undefined ? {} : { stage: result.stage }),
        ...(nonConvergedStop ? {
          landedPieces: [...landedPieces],
          remainingPieces: finalSupervisorDecision === undefined
            ? null
            : finalSupervisorDecision.rerunnable.length
              + finalSupervisorDecision.reworkable.length
              + finalSupervisorDecision.decomposable.length
              + finalSupervisorDecision.repairable.length,
        } : {}),
        ...(executionFailed ? { error: terminalError instanceof Error ? terminalError.message : String(terminalError) } : {}),
      };
      debug.log('self-implement', 'run-terminal', {
        ...terminalData,
        supervised: supervise !== undefined,
        ...(supervisorStopReason === undefined ? {} : { supervisorStopReason }),
        ...(draftTriage === undefined ? {} : { draftTriage }),
      });
    } catch { /* fail-open */ }
  }
}

/** --evidence 모드 → EvidenceMode(mission-cli 규약 미러·기본 tsc·doc 기본 docs/plans·^PLAN-·test 는 --test-path 필수). */
export function buildDevEvidence(opts: DevCliOpts): EvidenceMode {
  const mode = opts.evidence ?? 'tsc';
  if (!['tsc', 'doc', 'test'].includes(mode)) {
    throw new DevPipelineError(`--evidence 는 tsc|doc|test 만 (받음: ${opts.evidence})`);
  }
  if (mode !== 'doc' && (opts.docDir !== undefined || opts.docGlob !== undefined)) {
    throw new DevPipelineError('--doc-dir/--doc-glob 은 --evidence doc 에서만 유효');
  }
  if (mode !== 'test' && opts.testPath !== undefined) {
    throw new DevPipelineError('--test-path 는 --evidence test 에서만 유효');
  }
  if (mode === 'doc') {
    let glob: RegExp;
    try { glob = new RegExp(opts.docGlob || '^PLAN-.*\\.md$', 'i'); }
    catch (e) { throw new DevPipelineError(`--doc-glob 정규식 오류: ${e instanceof Error ? e.message : String(e)}`); }
    return { kind: 'doc', dirRel: opts.docDir || 'docs/plans', glob };
  }
  if (mode === 'test') {
    if (!opts.testPath) throw new DevPipelineError('--evidence test 는 --test-path 필요');
    return { kind: 'test', testPath: opts.testPath };
  }
  return { kind: 'tsc' };
}

export function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new DevPipelineError(`${flag} 는 양의 정수여야 (받음: ${raw})`);
  return n;
}

export function parseNonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new DevPipelineError(`${flag} 는 0 이상의 정수여야 (받음: ${raw})`);
  return n;
}

export interface ChildLlmModelResolution {
  entered: string;
  resolvedId: string;
  tier: string;
  supportsThinking: boolean;
  recommended: boolean;
}

interface CatalogModelView {
  id: string;
  tier: string;
  supportsThinking?: boolean;
  recommended?: boolean;
}

export const CHILD_LLM_PROVIDER_ALIASES = {
  xai: 'grok',
  claude: 'anthropic',
  google: 'gemini',
  codex: 'openai-codex',
} as const;

export function normalizeChildLlmProvider(provider: string): string {
  const p = provider.trim().toLowerCase();
  return Object.hasOwn(CHILD_LLM_PROVIDER_ALIASES, p)
    ? CHILD_LLM_PROVIDER_ALIASES[p as keyof typeof CHILD_LLM_PROVIDER_ALIASES]
    : p;
}

function isKnownChildLlmProvider(provider: string): boolean {
  return ['grok', 'anthropic', 'gemini', 'openai', 'openai-codex', 'local', 'openrouter'].includes(normalizeChildLlmProvider(provider));
}

function findPickerCatalogModel(provider: string, id: string): CatalogModelView | undefined {
  switch (normalizeChildLlmProvider(provider)) {
    case 'grok': return findGrokModel(id);
    case 'anthropic': return findClaudeModel(id);
    case 'gemini': return findGeminiModel(id);
    case 'openai':
    case 'openai-codex': return findCodexModel(id);
    case 'openrouter': return findOpenRouterChildModel(id);
    default: return undefined;
  }
}

/** 결정 2026-09-23 — openrouter 는 피커 목록이 없다(454개 게이트웨이). 받는 것 = ⑴ openrouter 사다리의 모델
 *  ⊕ ⑵ 카탈로그 폴드에 있는 `openrouter/*`(운영 스냅숏이 갱신됐을 때). 둘 다 아니면 «모른다» → 거부. */
function findOpenRouterChildModel(id: string): CatalogModelView | undefined {
  const ladder = MODEL_TIERS.map((t) => LLM_TIER_MAP_BY_PROVIDER.openrouter[t].model);
  const folded = getCatalog().models.get(id);
  if (!ladder.includes(id) && folded?.provider !== 'openrouter') return undefined;
  return {
    id,
    tier: id === LLM_TIER_MAP_BY_PROVIDER.openrouter.balanced.model ? 'balanced' : 'standard',
    supportsThinking: folded ? folded.reasoning != null : true,
    recommended: id === LLM_TIER_MAP_BY_PROVIDER.openrouter.balanced.model,
  };
}

function thinkingFromBuiltin(tags: readonly string[] | undefined, reasoningEffortCeiling: string | undefined): boolean {
  if (tags?.includes('reasoning')) return true;
  return reasoningEffortCeiling != null && reasoningEffortCeiling !== 'off' && reasoningEffortCeiling !== 'none';
}

function tierFromBuiltin(tags: readonly string[] | undefined): string {
  if (tags?.includes('cheap')) return 'cheap';
  if (tags?.includes('balanced')) return 'balanced';
  if (tags?.includes('flagship')) return 'flagship';
  return 'standard';
}

function findBuiltinCatalogModel(provider: string, id: string): CatalogModelView | undefined {
  const expected = normalizeChildLlmProvider(provider);
  const entry = BUILTIN_CATALOG.models.find((model) => (
    model.id === id && normalizeChildLlmProvider(model.provider) === expected
  ));
  if (!entry) return undefined;
  return {
    id: entry.id,
    tier: tierFromBuiltin(entry.tags),
    supportsThinking: thinkingFromBuiltin(entry.tags, entry.reasoningEffortCeiling),
    recommended: false,
  };
}

function listImplementationChildModelCandidates(provider: string): string[] {
  const expected = normalizeChildLlmProvider(provider);
  const picker = (() => {
    switch (expected) {
      case 'grok': return GROK_MODELS.map((model) => model.id);
      case 'anthropic': return CLAUDE_MODELS.map((model) => model.id);
      case 'gemini': return GEMINI_MODELS.map((model) => model.id);
      case 'openai':
      case 'openai-codex': return CODEX_MODELS.map((model) => model.id);
      case 'openrouter': return [...new Set(MODEL_TIERS.map((t) => LLM_TIER_MAP_BY_PROVIDER.openrouter[t].model))];
      default: return [];
    }
  })();
  const builtin = BUILTIN_CATALOG.models
    .filter((model) => normalizeChildLlmProvider(model.provider) === expected)
    .map((model) => model.id);
  return [...new Set([...picker, ...builtin])];
}

function catalogThinking(provider: string, entry: CatalogModelView): boolean {
  if (typeof entry.supportsThinking === 'boolean') return entry.supportsThinking;
  const builtin = findBuiltinCatalogModel(provider, entry.id);
  return builtin?.supportsThinking === true;
}

export function resolveImplementationChildModel(provider: string, model: string): ChildLlmModelResolution {
  const suppliedProvider = provider.trim();
  const entered = model.trim();
  if (!isKnownChildLlmProvider(suppliedProvider)) {
    throw new DevPipelineError(`--child-llm-provider 알 수 없음: ${suppliedProvider}`);
  }
  const aliased = resolveModelAlias(entered) ?? entered;
  const entry = findPickerCatalogModel(suppliedProvider, aliased)
    ?? findPickerCatalogModel(suppliedProvider, entered)
    ?? findBuiltinCatalogModel(suppliedProvider, aliased)
    ?? findBuiltinCatalogModel(suppliedProvider, entered);
  if (!entry) {
    const candidates = listImplementationChildModelCandidates(suppliedProvider);
    const available = candidates.length > 0 ? ` · 후보: ${candidates.join(', ')}` : '';
    throw new DevPipelineError(`--child-llm-model 알 수 없음: ${entered}${available}`);
  }
  return {
    entered,
    resolvedId: entry.id,
    tier: entry.tier,
    supportsThinking: catalogThinking(suppliedProvider, entry),
    recommended: entry.recommended === true,
  };
}

export const CHILD_LLM_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function childLlmEffortCeiling(_provider: string, model: string): ReasoningEffortCeiling {
  return reasoningEffortCeiling(resolveModelAlias(model.trim()) ?? model.trim());
}

export function resolveChildLlmEffort(
  provider: string, model: string, entered: string,
): { effort: ChildLlmEffort; ceiling: ReasoningEffortCeiling } {
  const value = entered.trim().toLowerCase();
  const ladder: readonly string[] = CHILD_LLM_EFFORT_LADDER;
  if (!ladder.includes(value)) {
    throw new DevPipelineError(`--child-llm-effort 알 수 없음: ${entered} · 후보: ${CHILD_LLM_EFFORT_LADDER.join(', ')}`);
  }
  const effort = value as ChildLlmEffort;
  const ceiling = childLlmEffortCeiling(provider, model);
  if (ceiling === 'none') {
    throw new DevPipelineError(`--child-llm-effort 거부: ${model} 은 추론 노력을 «안 받는다»(ceiling=none)`);
  }
  if (ladder.indexOf(effort) > ladder.indexOf(ceiling)) {
    throw new DevPipelineError(
      `--child-llm-effort 거부: ${effort} 가 ${model} 의 상한(${ceiling})을 넘는다`,
    );
  }
  return { effort, ceiling };
}

type ChildLlmEffortInterpretation = {
  effort: ChildLlmEffort | undefined;
  ceiling: ReasoningEffortCeiling;
  source?: 'flag' | 'unset';
  selectionSource?: 'flag' | 'config';
};

export function formatChildLlmInterpretationLine(
  resolution: ChildLlmModelResolution,
  effort?: ChildLlmEffortInterpretation,
): string {
  const interpreted = effort ?? {
    effort: undefined,
    ceiling: childLlmEffortCeiling('', resolution.entered),
    source: 'unset' as const,
  };
  const value = interpreted.effort ?? '미지정';
  const sourceKind = interpreted.source ?? (interpreted.effort === undefined ? 'unset' : 'flag');
  const source = sourceKind === 'flag' ? 'source=flag' : 'source=unset';
  const selection = interpreted.selectionSource ? ` · selection=${interpreted.selectionSource}` : '';
  const tail = ` · effort=${value}(ceiling=${interpreted.ceiling} · ${source})${selection}`;
  return `[dev] child-llm: entered=${resolution.entered} · resolved=${resolution.resolvedId} · tier=${resolution.tier} · thinking=${resolution.supportsThinking}${tail}`;
}

/** `elanous usage --json` 의 grok 행 → 잔량 판정. 한 행이라도 100% 미만이면 usable, 모두 100% 이상이면 exhausted. */
export function grokQuotaFromUsageJson(stdout: string): 'usable' | 'exhausted' | 'unknown' {
  try {
    const parsed = JSON.parse(stdout) as { rows?: Array<{ provider?: string; credits?: { status?: string; usedPercent?: number | null } }> };
    const percents = (parsed.rows ?? [])
      .filter((row) => row.provider === 'grok' && row.credits?.status === 'ok' && typeof row.credits.usedPercent === 'number')
      .map((row) => row.credits!.usedPercent as number);
    if (percents.length === 0) return 'unknown';
    return percents.some((p) => p < 100) ? 'usable' : 'exhausted';
  } catch {
    return 'unknown';
  }
}

/**
 * 발사 때 쓰는 grok 잔량. 🩸 2026-09-24: 캐시(`readCachedGrokQuota` · `budget/state.json`)는 이 기계의 어느 우주에도
 * 파일이 없어 «늘» unknown 이었다 — 그래서 경고가 실물에서 한 번도 안 떴다. 캐시가 모르면 `elanous usage --json`
 * (실시간 조회 · 약 3초)을 한 번 불러 판정한다. grok 자식일 때만 불린다.
 */
let launchGrokQuotaReaderForTesting: (() => 'usable' | 'exhausted' | 'unknown') | undefined;
/** 시험 전용 — 발사 시험이 실시간 `elanous usage` 를 부르지 않게 한다. `undefined` 로 되돌린다. */
export function setLaunchGrokQuotaReaderForTesting(reader: (() => 'usable' | 'exhausted' | 'unknown') | undefined): void {
  launchGrokQuotaReaderForTesting = reader;
}

export function readGrokQuotaForLaunch(
  deps: { readCached?: typeof readCachedGrokQuota; runUsage?: () => string | null } = {},
): 'usable' | 'exhausted' | 'unknown' {
  if (launchGrokQuotaReaderForTesting && !deps.readCached && !deps.runUsage) return launchGrokQuotaReaderForTesting();
  const cached = (deps.readCached ?? readCachedGrokQuota)();
  if (cached !== 'unknown') return cached;
  const runUsage = deps.runUsage ?? (() => {
    const cli = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
    const r = spawnSync(process.execPath, [cli, 'usage', '--json'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 ? r.stdout : null;
  });
  let stdout: string | null = null;
  try { stdout = runUsage(); } catch { stdout = null; }
  return stdout ? grokQuotaFromUsageJson(stdout) : 'unknown';
}

/**
 * 부모 축(리뷰·판정)의 공급자 잔량 경고. 🩸 2026-09-24 🅕 real25: 자식은 codex 로 고정했는데 부모가 config
 * `llm.provider=grok`(한도 소진)을 타서 리뷰가 두 번 판정 없이 시간 초과했고, 결말엔 `no-progress` 만 남았다.
 * 부모 공급자가 grok 일 때만 잔량을 읽는다(다른 공급자면 비용 0). 발사는 막지 않는다.
 */
export function warnParentLlmQuota(
  parentProvider: string | undefined,
  readGrokQuota: () => 'usable' | 'exhausted' | 'unknown',
  write: (line: string) => void = (line) => process.stderr.write(line),
): boolean {
  if (parentProvider !== 'grok') return false;
  if (readGrokQuota() !== 'exhausted') return false;
  write('[dev] ⚠️ 부모 LLM(리뷰·판정) = config llm.provider grok · 주간 한도 소진(elanous usage) — 리뷰가 판정 없이 시간 초과할 수 있다 · 바꾸려면 llm.provider 또는 roleLlm(review=openai-codex)\n');
  debug.log('self-dev', 'parent-llm-quota-exhausted', { provider: parentProvider });
  return true;
}

function announceChildLlmInterpretation(
  selection: ChildLlmSelection,
  readGrokQuota: typeof readCachedGrokQuota,
): void {
  const resolution = resolveImplementationChildModel(selection.provider, selection.model);
  const effort: ChildLlmEffortInterpretation = {
    effort: selection.effort,
    ceiling: childLlmEffortCeiling(selection.provider, selection.model),
    source: selection.effort === undefined ? 'unset' : 'flag',
    selectionSource: selection.source,
  };
  debug.log('self-dev.child-llm', 'effort-resolved', {
    provider: selection.provider,
    model: selection.model,
    resolvedId: resolution.resolvedId,
    tier: resolution.tier,
    effort: effort.effort ?? '미지정',
    ceiling: effort.ceiling,
    source: effort.source,
    selectionSource: selection.source,
  });
  process.stderr.write(`${formatChildLlmInterpretationLine(resolution, effort)}\n`);
  if (selection.provider === 'grok' && readGrokQuota() === 'exhausted') {
    process.stderr.write('[dev] ⚠️ child-llm grok 주간 한도 소진(elanous usage) — 자식이 응답을 못 받아 도구 0회로 끝날 수 있다 · 바꾸려면 --child-llm-provider openai-codex --child-llm-model <모델>\n');
    debug.log('self-dev', 'child-llm-quota-exhausted', {
      provider: selection.provider, model: selection.model, selection: selection.source,
    });
  }
}

export const CHILD_LLM_DEFAULT_TIER = 'better' as const;

export function defaultChildLlmModel(provider: string): string {
  return tierModel(CHILD_LLM_DEFAULT_TIER, provider as never);
}

export type ChildLlmConfigSnapshot = { provider?: string; model?: string };

/** 해석된 선호를 발사 관측에 남긴다. chain 은 provider 이름만. 파일 안에서만 쓴다. */
function logResolvedChildLlmPreference(resolved: ResolvedChildLlmPreference): void {
  debug.log('harness.child-llm-preference', 'resolved', {
    mode: resolved.mode,
    chain: resolved.chain.map((entry) => entry.provider),
    source: resolved.source,
    budgetGate: resolved.budgetGate,
  });
}

/** 발사 인자가 없을 때의 첫 칸. auto 도 지금은 chain[0] — 예산을 보고 고르는 것은 P15.
 *  provider 없는 칸은 스냅샷이 아니다. model-only 거절은 발사 경계가 따로 한다. */
function childLlmSnapshotFromPreference(resolved: ResolvedChildLlmPreference): ChildLlmConfigSnapshot | undefined {
  const first = resolved.chain[0];
  if (!first?.provider?.trim()) return undefined;
  return {
    provider: first.provider,
    ...(first.model !== undefined ? { model: first.model } : {}),
  };
}

/** 파싱된 설정을 그대로 해석 입력으로 쓴다. raw 재검사는 하지 않는다 —
 *  buildUserConfig 가 경고 후 버린 값을 다시 읽어 발사를 막지 않기 위해서다. */
function childLlmPreferenceInputFromUserConfig(config: UserConfig): ChildLlmPreferenceInput {
  return config;
}

/** 기존 `{ model }` 만 있는 고정 설정. mode 는 auto 로 남기고, 발사만 종전 문면으로 거절한다. */
function rejectModelOnlyChildLlmConfig(config: UserConfig): void {
  const childLlm = config.tools.selfImplement.childLlm;
  if (childLlm?.model !== undefined && !childLlm.provider?.trim() && !childLlm.mode && !(childLlm.chain && childLlm.chain.length > 0)) {
    throw new DevPipelineError('--child-llm-provider 필요(--child-llm-model과 함께)');
  }
}

/** 실제 설정을 해석 함수로 읽는다. 전역 `llm.provider` 는 부모 축이라 여기 쓰지 않는다.
 *  부재·빈 사슬·버린 비객체 설정은 `undefined`(기본으로 발사). 읽기 실패는 조용히 접지하지 않고 거절한다. */
export function readChildLlmConfigFromUserConfig(): ChildLlmConfigSnapshot | undefined {
  const read = () => getUserConfig();
  let config: UserConfig;
  try {
    config = read();
  } catch (err) {
    if (err instanceof DevPipelineError) throw err;
    throw new DevPipelineError(
      `tools.selfImplement.childLlm 읽기 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  rejectModelOnlyChildLlmConfig(config);
  const resolved = resolveChildLlmPreference(childLlmPreferenceInputFromUserConfig(config));
  logResolvedChildLlmPreference(resolved);
  return childLlmSnapshotFromPreference(resolved);
}

function resolveChildLlmFromParts(
  provider: string | undefined,
  model: string | undefined,
  source: 'flag' | 'config',
): ChildLlmSelection | undefined {
  const normalizedProvider = provider === undefined ? undefined : normalizeChildLlmProvider(provider);
  if (provider?.trim() && model?.trim()) {
    resolveImplementationChildModel(normalizedProvider!, model);
    return { provider: normalizedProvider!, model, source };
  }
  if (provider?.trim() && !model?.trim()) {
    if (!isKnownChildLlmProvider(normalizedProvider!)) {
      throw new DevPipelineError(`--child-llm-provider 알 수 없음: ${provider.trim()}`);
    }
    const filled = defaultChildLlmModel(normalizedProvider!);
    resolveImplementationChildModel(normalizedProvider!, filled);
    return { provider: normalizedProvider!, model: filled, source };
  }
  if (!provider?.trim() && model !== undefined) {
    throw new DevPipelineError('--child-llm-provider 필요(--child-llm-model과 함께)');
  }
  return undefined;
}

export function buildChildLlmSelection(
  opts: Pick<DevCliOpts, 'childLlmProvider' | 'childLlmModel' | 'childLlmEffort'> & {
    /** 발사 인자가 있을 때 관측용 선호를 읽는다. 없으면 getUserConfig. 기존 두 인자 시그니처는 그대로다. */
    readPreference?: () => UserConfig;
  },
  readChildLlmConfig: () => ChildLlmConfigSnapshot | undefined = readChildLlmConfigFromUserConfig,
): ChildLlmSelection | undefined {
  const readResolvedPreference = opts.readPreference ?? (() => getUserConfig());
  const provider = opts.childLlmProvider;
  const model = opts.childLlmModel;
  const hasFlag = provider !== undefined || model !== undefined || opts.childLlmEffort !== undefined;
  if (opts.childLlmEffort?.trim() && !provider?.trim()) {
    throw new DevPipelineError('--child-llm-provider 필요(--child-llm-effort와 함께)');
  }
  const withEffort = (sel: ChildLlmSelection): ChildLlmSelection => {
    const entered = opts.childLlmEffort?.trim();
    if (!entered) return sel;
    const { effort } = resolveChildLlmEffort(sel.provider, sel.model, entered);
    return { ...sel, effort };
  };
  if (hasFlag) {
    const selected = resolveChildLlmFromParts(provider, model, 'flag');
    if (selected) {
      try { logResolvedChildLlmPreference(resolveChildLlmPreference(childLlmPreferenceInputFromUserConfig(readResolvedPreference()))); } catch { /* 관측이 발사를 막지 않는다 */ }
    }
    return selected ? withEffort(selected) : undefined;
  }
  const configured = readChildLlmConfig();
  if (!configured || !configured.provider?.trim()) return undefined;
  const selected = resolveChildLlmFromParts(configured.provider, configured.model, 'config');
  return selected ? withEffort(selected) : undefined;
}

const MAX_ACTIVITY_GRACE_SEC = 3600;

export function parseActivityGraceSec(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ACTIVITY_GRACE_SEC) {
    throw new DevPipelineError(`--activity-grace 는 1~${MAX_ACTIVITY_GRACE_SEC}초의 정수여야 (받음: ${raw})`);
  }
  return n;
}

type DevPath = 'plan-staged' | 'interactive' | 'elanous-tui' | 'shell-drive' | 'self-mission' | 'agent-mission-pty' | 'acp';
function resolveDevPath(executor: DevCliExecutor, plan: boolean, implement: boolean, elanous: boolean, shellDrive: boolean): DevPath {
  if (executor.kind === 'self') return implement ? 'interactive' : plan ? 'plan-staged' : elanous ? 'elanous-tui' : shellDrive ? 'shell-drive' : 'self-mission';
  return executor.transport === 'acp' ? 'acp' : 'agent-mission-pty';
}

const DEV_PATH_ALLOWED: Record<DevPath, readonly string[]> = {
  'plan-staged': ['openPr', 'autoMerge', 'roleLlm', 'allowNoEvidence', 'allowSupersededGoal', 'allowGoalLintErrors'],
  'interactive': ['implement', 'roleLlm'],
  'elanous-tui': ['hold', 'readyTimeoutMs', 'goal', 'maxSteps', 'pollMs', 'model', 'observeOnly', 'isolatedRoot', 'cwd', 'worktree', 'roleLlm', 'allowNoEvidence', 'allowSupersededGoal', 'allowGoalLintErrors'],
  'shell-drive': ['goal', 'maxSteps', 'pollMs', 'model', 'cwd', 'worktree', 'roleLlm', 'allowNoEvidence', 'allowSupersededGoal', 'allowGoalLintErrors'],
  'self-mission': ['openPr', 'autoMerge', 'autoReview', 'draft', 'maxWait', 'activityGrace', 'supervise', 'superviseRounds', 'childLlmProvider', 'childLlmModel', 'childLlmEffort', 'correlation', 'graph', 'ground', 'target', 'context', 'contextText', 'allowNoEvidence', 'allowSupersededGoal', 'allowGoalLintErrors'],
  'agent-mission-pty': ['branch', 'evidence', 'docDir', 'docGlob', 'testPath', 'maxRounds', 'commit', 'deliverable', 'screens', 'roleLlm', 'allowNoEvidence', 'allowSupersededGoal', 'allowGoalLintErrors'],
  'acp': ['context', 'contextText', 'roleLlm', 'allowNoEvidence', 'allowSupersededGoal', 'allowGoalLintErrors'],
};
const SELF_MISSION_ROLE_LLM_ALTERNATIVE = '--child-llm-provider 및 --child-llm-model';

const DEV_PATH_NEUTRAL_OPTIONS = new Set([
  'file', 'ask', 'say', 'forcePreflight', 'launchDecomposition', 'liveRunWindow', 'recentChangeWindow',
  'backend', 'transport', 'plan', 'implement', 'elanous', 'json', 'cols', 'rows',
]);

function isProgrammaticOptionProvided(name: string, value: unknown): boolean {
  if (name === 'draft' || name === 'commit') return value === false;
  if (name === 'ground') return value !== undefined;
  if (name === 'openPr' || name === 'autoMerge' || name === 'autoReview') return value === true;
  return value !== undefined && value !== '';
}

export function explicitDevOptionNames(command: {
  options: readonly { attributeName(): string }[];
  getOptionValueSource(name: string): string | undefined;
  getOptionValue?(name: string): unknown;
}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const option of command.options) {
    const name = option.attributeName();
    if (seen.has(name)) continue;
    if (command.getOptionValueSource(name) !== 'cli') continue;
    if (command.getOptionValue !== undefined
      && !isProgrammaticOptionProvided(name, command.getOptionValue(name))) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function toCliFlag(attributeName: string): string {
  return `--${attributeName.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function formatForeignDevOptions(path: DevPath, foreign: readonly string[]): string {
  const names = `${foreign.join(', ')} (${foreign.map(toCliFlag).join(', ')})`;
  const roleLlmIndex = foreign.indexOf('roleLlm');
  if (path === 'self-mission' && roleLlmIndex >= 0) {
    return `이 경로(${path})에 무효한 옵션: ${names} — --role-llm (self-mission 구현 자식에는 전달되지 않음; 대신 ${SELF_MISSION_ROLE_LLM_ALTERNATIVE} 사용) — 조용히 버리지 않음(경로별 지원 옵션 확인)`;
  }
  return `이 경로(${path})에 무효한 옵션: ${names} — 조용히 버리지 않음(경로별 지원 옵션 확인)`;
}

export function assertDevCliPathOptions(
  executor: DevCliExecutor,
  opts: DevCliOpts,
  explicitOptionNames?: readonly string[],
): void {
  const path = resolveDevPath(executor, opts.plan === true, opts.implement === true, opts.elanous === true, opts.goal !== undefined && opts.elanous !== true);
  const allowed = new Set<string>([...DEV_PATH_ALLOWED[path], 'base', 'enhance']);
  const providedOptions = explicitOptionNames ?? Object.entries(opts)
    .filter(([name, value]) => isProgrammaticOptionProvided(name, value))
    .map(([name]) => name);
  const foreign = providedOptions.filter((name) => !allowed.has(name) && !DEV_PATH_NEUTRAL_OPTIONS.has(name));
  if (foreign.length > 0) throw new DevPipelineError(formatForeignDevOptions(path, foreign));
}

const DRIVE_ALIAS_OPTIONS = new Set(['goal', 'maxSteps', 'pollMs', 'model', 'cwd', 'worktree', 'json', 'attach']);
const DRIVE_ALIAS_ALLOWED_FLAGS = [...DRIVE_ALIAS_OPTIONS].map(toCliFlag).join(' · ');

export function assertDriveAliasOptions(explicitOptionNames: readonly string[]): void {
  const unsupported = explicitOptionNames.filter((name) => !DRIVE_ALIAS_OPTIONS.has(name));
  if (unsupported.length > 0) {
    const flags = unsupported.map(toCliFlag).join(', ');
    throw new DevPipelineError(
      `drive: 지원하지 않는 옵션: ${flags}\n`
      + `  drive 가 받는 옵션은 ${DRIVE_ALIAS_OPTIONS.size}개뿐이다: ${DRIVE_ALIAS_ALLOWED_FLAGS}\n`
      + `  ⇒ 그 밖의 옵션은 \`elanous dev\` 에서 쓴다 (예: elanous dev --elanous --hold).\n`
      + '  ⚠️ dev 와 drive 는 한 명령이라 도움말을 공유한다 — `drive --help` 에 보이는 dev 전용 옵션을 계약으로 읽지 마라.',
    );
  }
}

export type DevAuthorInput =
  | { readonly kind: 'ask'; readonly value: string }
  | { readonly kind: 'say'; readonly value: string };

export type DevCommandInputSource =
  | { readonly kind: 'file'; readonly value: string }
  | { readonly kind: 'text'; readonly value: string };

export type DevInputSource = DevAuthorInput | DevCommandInputSource;

export function selectDevAuthorInput(textParts: readonly string[], opts: Pick<DevCliOpts, 'ask' | 'say' | 'file'>): DevInputSource | undefined {
  const sources = [
    ...(opts.ask !== undefined ? [['--ask', { kind: 'ask' as const, value: opts.ask }] as const] : []),
    ...(opts.say !== undefined ? [['--say', { kind: 'say' as const, value: opts.say }] as const] : []),
    ...(opts.file !== undefined ? [['--file', { kind: 'file' as const, value: opts.file }] as const] : []),
    ...(textParts.length > 0 ? [['<text...>', { kind: 'text' as const, value: textParts.join(' ') }] as const] : []),
  ];
  if (sources.length > 1) {
    throw new DevPipelineError(`${sources.map(([name]) => name).join(', ')} 는 동시 사용 불가 — 하나만`);
  }
  const selected = sources[0]?.[1];
  if (selected && !selected.value.trim()) {
    throw new DevPipelineError(`${sources[0]![0]} 입력이 비었다`);
  }
  return selected;
}

export function buildDevCommandInput(source: DevCommandInputSource | undefined): DevInput {
  if (!source) return { text: '' };
  return source.kind === 'file' ? { file: source.value } : { text: source.value };
}

export function buildDriveAliasDevSpec(
  command: string | undefined,
  opts: DevCliOpts,
  explicitOptionNames?: readonly string[],
): DevPipelineSpec {
  if (opts.elanous === true) {
    throw new DevPipelineError('drive: --elanous 는 지원하지 않음 — TUI target은 elanous dev --elanous 를 사용');
  }
  if (!command?.trim()) {
    throw new DevPipelineError('drive: command 필요');
  }
  if (!opts.goal?.trim()) {
    throw new DevPipelineError('drive: --goal 필요');
  }
  const spec = buildDevCliSpec({ text: command.trim() }, { kind: 'self' }, opts, explicitOptionNames, 'cli-drive');
  return { ...spec, completion: 'worktree-only', autoReview: false };
}

export function buildDevCliSpec(
  input: DevInput,
  executor: DevCliExecutor,
  opts: DevCliOpts,
  explicitOptionNames?: readonly string[],
  entrance: EntranceId = 'cli-dev-ask',
  readGrokQuota: typeof readCachedGrokQuota = readGrokQuotaForLaunch,
): DevPipelineSpec {
  if (opts.plan === true) {
    throw new DevPipelineError(`--plan 은 은퇴했고 명시적으로 거부됨 · 대응 문: ${DEV_PLAN_REPLACEMENT}`);
  }
  const path = resolveDevPath(executor, false, opts.implement === true, opts.elanous === true, opts.goal !== undefined && opts.elanous !== true);
  const launchEntrance = lookupEntrance(entrance);
  const notice = recommendedEntranceNotice(
    launchEntrance,
    lookupEntrance(RECOMMENDED_ENTRANCE_ID_BY_SURFACE[launchEntrance.surface]),
  );
  if (opts.implement === true && executor.kind !== 'self') {
    throw new DevPipelineError('--implement 는 self backend 만(headless interactive chat)');
  }
  if (opts.implement === true && opts.elanous === true) {
    throw new DevPipelineError('--implement 와 --elanous 는 동시 사용 불가');
  }
  if (opts.elanous === true && executor.kind !== 'self') {
    throw new DevPipelineError('--elanous 는 self backend 만(격리 bare elanous TUI child)');
  }
  if (opts.hold === true && opts.elanous !== true) {
    throw new DevPipelineError('--hold 는 --elanous 와 함께만 유효');
  }
  if (opts.hold === true) {
    const brainOnly = (['maxSteps', 'pollMs', 'model'] as const).filter((k) => opts[k] !== undefined);
    if (brainOnly.length) throw new DevPipelineError(`--hold 는 brain 전용 옵션과 동시 사용 불가: ${brainOnly.join(', ')}`);
  }
  if (opts.hold === true && opts.goal !== undefined) {
    throw new DevPipelineError('--hold 와 --goal 은 동시 사용 불가');
  }
  if (opts.worktree === true && opts.cwd !== undefined) {
    throw new DevPipelineError('--worktree 와 --cwd 는 동시 사용 불가');
  }
  if (opts.elanous === true && !opts.hold && !opts.goal?.trim()) {
    throw new DevPipelineError('--elanous 는 --goal 필요(--hold 제외)');
  }
  if (path === 'shell-drive' && 'file' in input) {
    throw new DevPipelineError('shell drive 는 <command> 위치 인자만 지원하며 --file 은 사용할 수 없음');
  }
  assertDevCliPathOptions(executor, opts, explicitOptionNames);
  if (opts.superviseRounds !== undefined && opts.supervise === false) {
    throw new DevPipelineError('--supervise-rounds 는 --no-supervise 와 함께 쓸 수 없다');
  }
  if (opts.superviseRounds !== undefined) parsePositiveInt(opts.superviseRounds, '--supervise-rounds');
  if (path === 'interactive') {
    return {
      input,
      executor,
      context: 'interactive',
      entranceUnstamped: 'interactive-dispatch',
      chat: { forceNew: true, enableTools: true, goalLoop: true },
    };
  }
  if (opts.openPr === false && opts.autoMerge === true) {
    throw new DevPipelineError('--no-open-pr 와 --auto-merge 는 동시 사용 불가 — PR 없이 병합할 수 없음');
  }

  const supportsCompletion = path === 'self-mission' || path === 'plan-staged';
  const completion: DevCompletion | undefined = opts.openPr === false
    ? 'worktree-only'
    : opts.autoMerge === true
      ? 'auto-merge'
      : opts.autoMerge === false
        ? 'pr'
        : opts.openPr === true
          ? 'auto-merge'
          : undefined;
  const autoReview = opts.autoReview;
  const enhance = opts.enhance === true ? true : opts.enhance === false ? false : undefined;
  const spec: DevPipelineSpec = {
    input, executor,
    entrance,
    ...(notice ? { notice } : {}),
    ...(opts.allowNoEvidence === true ? { allowNoEvidence: true } : {}),
    ...(opts.allowSupersededGoal === true ? { allowSupersededGoal: true } : {}),
    ...(opts.allowGoalLintErrors === true ? { allowGoalLintErrors: true } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...((path === 'self-mission' || path === 'plan-staged' || path === 'agent-mission-pty')
      ? { base: opts.base ?? DEFAULT_BRANCH_WORKTREE_BASE }
      : (opts.base ? { base: opts.base } : {})),
    ...(enhance !== undefined ? { enhance } : {}),
  };
  if (opts.base !== undefined) Object.defineProperty(spec, 'baseExplicit', { value: true, enumerable: true });
  if (supportsCompletion && completion !== undefined) {
    spec.completion = completion;
    // ⛔ 출처는 «사람이 친 플래그»일 때만 request 다(2026-09-26 베어 Ubuntu 26.04 실측 · UX 15′).
    //   TUI `/harness ask` 의 분리 발사(`dev --file`)는 아무 플래그도 안 쳤는데 request 로 찍혀, 원격 없는 저장소의
    //   «워크트리로 자동 강등»(`resolveTargetRemoteCompletion`)이 안 걸리고 거부됐다. 목록이 없으면(프로그램 호출) 종전대로 request.
    const typed = explicitOptionNames === undefined
      || explicitOptionNames.some((name) => name === 'autoMerge' || name === 'openPr');
    spec.completionSource = typed ? 'request' : 'default';
  }
  if (path === 'plan-staged') return { ...spec, plan: true };
  if (path === 'elanous-tui') {
    return {
      ...spec,
      elanous: {
        ...(opts.hold ? { hold: true } : {}),
        ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: parsePositiveInt(opts.readyTimeoutMs, '--ready-timeout-ms') } : {}),
        ...(opts.json ? { json: true } : {}),
        ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: parsePositiveInt(opts.maxSteps, '--max-steps') } : {}),
        ...(opts.pollMs !== undefined ? { pollMs: parseNonNegativeInt(opts.pollMs, '--poll-ms') } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.observeOnly ? { observeOnly: true } : {}),
        ...(opts.cols !== undefined ? { cols: parsePositiveInt(opts.cols, '--cols') } : {}),
        ...(opts.rows !== undefined ? { rows: parsePositiveInt(opts.rows, '--rows') } : {}),
        ...(opts.isolatedRoot ? { isolatedRoot: opts.isolatedRoot } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
    };
  }
  if (path === 'shell-drive') {
    return {
      ...spec,
      drive: {
        command: 'text' in input ? input.text : '',
        goal: opts.goal!,
        ...(opts.maxSteps !== undefined ? { maxSteps: parsePositiveInt(opts.maxSteps, '--max-steps') } : {}),
        ...(opts.pollMs !== undefined ? { pollMs: parseNonNegativeInt(opts.pollMs, '--poll-ms') } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
    };
  }

  if (path === 'self-mission' && completion === 'worktree-only') {
    const prOnly = [...(opts.autoReview ? ['--auto-review'] : []), ...(opts.draft === false ? ['--no-draft'] : [])];
    if (prOnly.length > 0) {
      throw new DevPipelineError(`${prOnly.join(', ')} 는 PR 개설(--open-pr/--auto-merge) 필요 — worktree-only 에선 무효(수락 후 무시 금지)`);
    }
  }

  if (path === 'self-mission' && autoReview !== undefined) {
    spec.autoReview = autoReview;
    spec.autoReviewSource = 'request';
  }

  if (path === 'self-mission') {
    const childLlm = buildChildLlmSelection({ ...opts, readPreference: () => getUserConfig() });
    // 잔량 조회(약 3초)는 한 발사에 한 번만 — 자식·부모가 같은 값을 쓴다.
    let grokQuotaOnce: ReturnType<typeof readCachedGrokQuota> | undefined;
    const readGrokQuotaOnce = () => (grokQuotaOnce ??= readGrokQuota());
    if (childLlm) announceChildLlmInterpretation(childLlm, readGrokQuotaOnce);
    let parentProvider: string | undefined;
    try { parentProvider = getUserConfig().llm.provider; } catch { parentProvider = undefined; }
    warnParentLlmQuota(parentProvider, readGrokQuotaOnce);
    const self = {
      ...(opts.draft === false ? { draft: false } : {}),
      ...(childLlm ? { childLlm } : {}),
      ...(opts.correlation !== undefined ? { correlationId: opts.correlation } : {}),
      ...(opts.maxWait !== undefined ? { maxWaitSec: parsePositiveInt(opts.maxWait, '--max-wait') } : {}),
      ...(opts.activityGrace !== undefined ? { activityGraceSec: parseActivityGraceSec(opts.activityGrace) } : {}),
      ...(opts.ground !== undefined ? { ground: opts.ground } : {}),
    };
    if (Object.keys(self).length > 0) spec.self = self;
  } else if (path === 'agent-mission-pty') {
    const mission: DevMissionOpts = {
      evidence: buildDevEvidence(opts),
      ...(opts.maxRounds !== undefined ? { maxRounds: parsePositiveInt(opts.maxRounds, '--max-rounds') } : {}),
      ...(opts.commit === false ? { commit: false } : {}),
      ...(opts.deliverable ? { deliverableHint: opts.deliverable } : {}),
      ...(opts.screens ? { screensDir: opts.screens } : {}),
    };
    spec.mission = mission;
  }
  return spec;
}

export function formatDevCompletionLine(input: {
  kind: string;
  ok: boolean;
  runId: string;
  outcome?: string | undefined;
  supervisorWantedContinue?: boolean | undefined;
  supervisorStopReason?: SupervisorStopReason | undefined;
  mergeSkipReason?: string | undefined;
  merged?: boolean | undefined;
  mergedInto?: string | undefined;
  prNumber?: number | undefined;
}): string {
  const outcomeText = input.outcome ? ` · outcome=${input.outcome}` : '';
  const supervisorText = input.supervisorWantedContinue ? ' · 감독은 계속을 원했다' : '';
  const supervisorStopText = input.supervisorStopReason ? ` · supervisor-stop=${input.supervisorStopReason}` : '';
  const mergeSkipText = input.mergeSkipReason ? ` · merge-skip=${input.mergeSkipReason}` : '';
  const mergeFactText = input.merged && (!input.mergedInto || input.mergedInto === 'unknown') ? ' · merged=true' : '';
  const mergeTargetText = input.mergedInto ? ` · merged-into=${input.mergedInto}` : '';
  const mergedPrText = input.mergedInto
    ? ` · merged-pr=${typeof input.prNumber === 'number' ? `#${input.prNumber}` : 'unconfirmed'}`
    : '';
  return `[dev] ${input.kind} 완료 · ok=${input.ok}${outcomeText}${supervisorText}${supervisorStopText}${mergeSkipText}${mergeFactText}${mergeTargetText}${mergedPrText} · run=${input.runId}`;
}

export function renderDevCompletionLine(input: {
  kind: string;
  ok: boolean;
  runId: string;
  base?: string | undefined;
  result?: { outcome?: string; supervisorWantedContinue?: boolean; mergeReason?: string; merged?: boolean; mergedBase?: string; prNumber?: number } | undefined;
  supervisorStopReason?: SupervisorStopReason | undefined;
}): string {
  const isSelf = input.kind === 'self';
  return formatDevCompletionLine({
    kind: input.kind,
    ok: input.ok,
    runId: input.runId,
    outcome: isSelf ? input.result?.outcome : undefined,
    supervisorWantedContinue: isSelf ? input.result?.supervisorWantedContinue : undefined,
    supervisorStopReason: isSelf ? input.supervisorStopReason : undefined,
    mergeSkipReason: isSelf ? input.result?.mergeReason : undefined,
    merged: isSelf ? input.result?.merged : undefined,
    mergedInto: isSelf && input.result?.merged
      ? input.result.mergedBase ?? 'unknown'
      : undefined,
    prNumber: isSelf ? input.result?.prNumber : undefined,
  });
}
