import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { loadRunLedger as loadRunLedgerSync, loadRunLedgerWithMetadata, runLedgerDir, resolveFederatedRunLedgerDirectories, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { goalRunDbPath, loadGoalRunQuery } from '../self-implement/goal-run-store.js';
import { loadGoalAskRecords } from '../self-implement/goal-ask-store.js';
import { dirname, join, resolve } from 'node:path';
import { InvalidArgumentError, Option, type Command } from 'commander';
import { debug } from '../debug/log.js';
import { readRunExits } from '../harness/harness-incidents.js';
import { checklistDevVersion, listChecklist, setItemIfSnapshot } from '../release-loop/checklist.js';
import { assignedVersions, releasedVersion, validateVersion } from '../release-loop/feature-store.js';
import { compareVersions } from '../directives/version-at.js';
import type { BoardNode } from '../task-agent/board.js';
import { boundPrTerminal, cardPrNumber, CLOSED_BY_HAND_EVENT, closeTaskCard, COMPLETION_KINDS, defaultDraftClaimGhPorts, handDraftClaim, HAND_MOVE_HISTORY_EVENT, updateTaskCard, resolveHandText, readTaskAgentState, readTaskCard, runTagChange, taskAgentStatePath as taskStatePathDefault, shellQuote, TASK_SEATS, type CompletionKind, type DraftClaimGhPorts, type TaskCard, type TaskCardEvent, type TaskLaunchContext, type TaskLaunchReceipt, type TaskLauncher, type TaskSeat } from '../task-agent/task-hand.js';
import { recordWiringLiveVerified, type CardRunEvidenceDeps } from '../task-agent/card-evidence.js';
import { remoteLedgerMirrorDir, remoteLedgerMirrorDirs } from '../task-agent/parent-host.js';
import { buildWorkOrder } from '../task-agent/work-order-build.js';
import { cellIdFromBody } from '../pr-tool/census.js';
import { ambiguousGreenSweepPrs, applyGreenSweepDecisions, decideGreenSweep, greenSweepCandidates, greenSweepEvidenceTestArgs, observeGreenSweep, type GreenSweepPr } from '../task-agent/green-sweep.js';
import { mapInventory, renderMapReduceTable, type MapInventory, type MapItem, type MapPorts } from '../task-agent/map-reduce.js';
import type { MapRecipe, MapRunRow } from '../task-agent/map-run-ledger.js';
import { createMapHostLauncher, type HostMapItem } from '../task-agent/map-host-adapter.js';
import type { GraphRunOptions, GraphRunState } from '../graph-runner/runner.js';
import { parseAskTargetPathHintsResult } from '../self-dev/launch-preflight-text.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { HAND_MOVE_KINDS, recordHandMove } from '../task-agent/live-move-history.js';
import type { TierSizedDecompose } from '../task-agent/tier-split.js';
import type { AdvanceMissionResult, MissionDecompose, PieceEvidenceReader } from '../task-agent/mission.js';
import { formatSevenVerbLive, formatTaskAgentCover, measureSevenVerbLive, measureTaskAgentCover, type CoverRow, type ImplementCardRunBinding, type ImplementRunMergeEvent, type SevenVerbLive, type TaskAgentCoverInput } from '../task-agent/cover.js';
import { measureRepairOutcomes } from '../task-agent/repair-outcomes.js';
import { LogStore, STORE_SAFETY_MAX, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';
import { resolveLogTargets } from './logs-cli.js';
import { createTasksCliContext, handleError, NEXUS_DOWN, NexusUnavailable, registerTaskAgentSink, registerTaskListCommand, registerTaskShowCommand, registerTasksRoot, request, responseJson, TASK_AGENT_SINK_SURFACE } from './tasks-read-cli.js';

// CLI-ENTRY-LAZY — 가벼운 읽기 경로(`tasks-read-cli.ts`)로 옮긴 공용 표면은 옛 import 경로 그대로 남긴다.
export { registerTaskAgentSink, TASK_AGENT_SINK_SURFACE };

function headLine(text: string): string {
  const first = text.split('\n')[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

export interface TasksCliDeps {
  baseUrl?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  output?: (line: string) => void;
  /** green-sweep entrypoint test seam: keep the actual CLI decision chain, replace only process reads. */
  greenSweepChecklist?: typeof listChecklist;
  greenSweepRun?: (command: string, args: string[]) => { status: number | null; stdout: string };
  greenSweepEvidenceRun?: (args: string[]) => { status: number | null; stdout: string };
  greenSweepWrite?: typeof setItemIfSnapshot;
  /** Test inventory seam; production reads current checklist or GitHub draft inventory. */
  mapInventorySource?: (recipe: MapRecipe, source: 'landed-but-yellow' | 'drafts', limit?: number,
    mapRunId?: string) => Promise<MapInventory<MapCliItem>>;
  mapRoot?: string;
  /** Focused test seam; production uses the real host graph runner. */
  mapGraphRun?: (path: string, options: GraphRunOptions) => Promise<GraphRunState>;
  /** `task hand --live` 의 발사기(시험 주입). 기본은 운영 config-dir 로 `harness say` 를 떼어 띄운다. */
  taskLauncher?: TaskLauncher;
  /** TA-REVIEW-RESULT-CAPTURE — `tasks show` 의 리뷰 결과 회수 시각(시험 주입 · 기본 지금). */
  reviewResultNow?: () => Date;
  /** 과제 카드 상태 파일(시험 주입). 기본 = `effectiveInstanceRoot()/task-agent-actions.json`. */
  taskStatePath?: string;
  /** 조합 선택 시험에서만 그래프 저장소 루트를 바꾼다. */
  taskCompositionRoot?: string;
  /** COORD-ENTRANCE-FOLD test seam; production uses the invoking repository root. */
  coordinatorShadowRoot?: string;
  /** Deterministic task-hand time in isolated tests. */
  taskNow?: () => Date;
  /** DRAFT-CLAIM-AUTO-2-FU — `tasks hand --draft-claim <pr>` 의 관측·게시·수확 리뷰 포트(시험 주입). 기본 = `defaultDraftClaimGhPorts()`(gh CLI ⊕ 생산 리뷰 러너). */
  draftClaimGh?: DraftClaimGhPorts;
  /** logs.db 싱크 등록(시험 주입). 기본 = `registerStandaloneLogSink`. `hand`·`show` 가 부른다. */
  registerSink?: (surface: string) => Promise<unknown>;
  /** `task hand --mission` 의 분해기(시험 주입). 기본 = 나열형은 결정론 · 아니면 `decomposeSelfDevGoal`. */
  missionDecompose?: MissionDecompose;
  /** TIER-SPLIT-BEFORE-LAUNCH — `tasks hand --tier 상|특 --live` 의 분해기(시험 주입). 키가 없으면 `DEFAULT_TIER_SIZED_DECOMPOSE`. */
  tierSizedDecompose?: TierSizedDecompose;
  /** `task advance` 의 착지 근거 읽기(시험 주입). 기본 = `predecessorState`(gh · 런 원장). */
  pieceEvidence?: PieceEvidenceReader;
  /** `task board` 의 내부 팩 어댑터(시험 주입). 기본 = 현재 판(`checklistDevVersion()`)의 `releasePackBoard` — 읽기만. */
  releaseBoard?: (version?: string) => BoardNode[];
  /** `tasks hand --checklist` 판 목록(시험 주입). 기본은 발행 전 체크리스트가 있는 판 전부. */
  releaseVersions?: () => string[];
  /** Isolated checklist read for PR adoption. */
  adoptChecklist?: typeof listChecklist;
  /** Isolated checklist read for work-order build. */
  workOrderChecklist?: typeof listChecklist;
  /** `tasks adopt-pr` live PR read seam; default is gh in this repository. */
  adoptPrView?: (number: number, cwd: string) => import('../task-agent/adopt-pr.js').AdoptPrView;
  /** Isolated ledger proof for a launched card being adopted. */
  adoptRunTerminal?: typeof import('../task-agent/adopt-pr.js').adoptedRunTerminal;
  /** `tasks show`·`advance` 의 런 근거 읽기(시험 주입) — 기본 = 런 원장(이 우주 ⊕ 연합) ⊕ 호스트 logs 의 Pod job-finished. */
  cardRunEvidence?: CardRunEvidenceDeps;
  /** `tasks show --json` 의 저작 골 파일 조회(시험 주입). null 은 골 연결을 확인하지 못한 상태다. */
  cardGoalDocument?: (goalId: string) => { goalFile: string; goalBody: string } | null;
  /** `tasks live-verified` 가 적는 런 원장 디렉터리(시험 주입). 기본 = `runLedgerDir()`. */
  liveVerifiedLedgerDir?: string;
  /** HARNESS-PARENT-ON-MSB1 — 원격 부모 카드의 원장 거울(시험 주입). 기본 = ssh 로 `<prodRoot>/remote-parents/<host>/run-ledger`. */
  remoteLedgerMirror?: (card: TaskCard) => void;
  /** `tasks parents` 의 낡은 부모 보고 의존(시험 주입). */
  staleParents?: import('../task-agent/parent-host.js').StaleParentDeps;
  /** `tasks adopt-runs` 의 백필 의존(시험 주입 · 등록부·상태 파일). */
  adoptRuns?: import('../task-agent/run-adopt.js').RunAdoptDeps;
  /** `tasks cover` logs 조회 seam. 기본은 운영 우주만, --include-test 때 시험 우주도 읽는다. */
  coverLogs?: (query: LogQuery, includeTest?: boolean) => LogStoreRow[] | CoverLogRead;
  /** `tasks cover --by-card` 카드 원장 읽기 seam(읽기 전용). 플래그가 있을 때만 부른다. 기본 = TA 카드 원장(task-agent-actions.json). null = 못 읽음. */
  coverCards?: () => CoverCardRow[] | null | Promise<CoverCardRow[] | null>;
  /** Read-only authored goal provenance; null means the authoring ledger could not be read. */
  coverGoalAsks?: () => { authorRunId: string; goalId: string; createdAt: string }[] | null;
  /** Read-only terminal goal records; null means the goal ledger could not be read. */
  coverGoalRuns?: () => { goalId: string; outcome: string; stage?: string; startedAt: string; completedAt?: string }[] | null;
  /** 구현 출처 시험 seam. 생략하면 task-agent-actions.json을 읽고, null이면 카드 원장을 못 읽은 것이다. */
  coverImplementCardRuns?: () => readonly ImplementCardRunBinding[] | null;
  /** 구현 출처 시험 seam. 생략하면 로컬·연합·원격 거울 run-ledger를 읽고, null이면 못 읽은 것이다. */
  coverImplementRunMerges?: () => ReadonlyMap<string, ImplementRunMergeEvent> | null;
  /** Read test-universe ledgers only when --include-test was requested. */
  coverIncludeTest?: boolean;
  /** `tasks outcomes` 의 «지금» — 상대 기간(`--since 24h`)을 푸는 기준(시험 주입). 기본 = `Date.now()`. */
  outcomesNow?: () => number;
  /** `tasks outcomes` 페이지 상한(시험 주입). 기본 = `OUTCOMES_QUERY_LIMIT`. */
  outcomesLimit?: number;
  /** `tasks doctor` read-only adapters; tests inject L1 evidence without calling gh or the operating ledger. */
  doctorVersion?: () => string;
  doctorChecklist?: typeof listChecklist;
  doctorRun?: (command: string, args: string[]) => { status: number | null; stdout: string };
  /** `tasks hand --live --checklist` checks open PRs before creating another implementation run. */
  handOpenPrRun?: (command: string, args: string[]) => { status: number | null; stdout: string };
  /** Repository selected for the open-PR census; the same origin is used by PR adoption. */
  handOriginRepo?: () => string;
  doctorLedger?: (runId: string, statePath: string) => import('../self-implement/run-ledger.js').RunLedgerEntry[] | null;
  /** TA-REJUDGE-ON-HEAD — `tasks rejudge` 의 판단 의존(시험 주입 · 기본 = 설정 liveMoves ⊕ 실물 gh·리뷰·재게이트·land). */
  rejudge?: Partial<import('../task-agent/rejudge-on-head.js').RejudgeDeps>;
  /** TA-REJUDGE-ON-HEAD — `tasks regate-run` 의 재게이트(시험 주입 · 기본 `runHostRegate`). */
  hostRegate?: (input: import('../self-implement/host-regate.js').HostRegateInput) => Promise<import('../self-implement/host-regate.js').HostRegateResult>;
  /** Isolated regate-run tests can disable the asynchronous completion callback explicitly. */
  regateCompletion?: false;
}

/** `<조각id>=<값>` 반복 인자. */
function collectPair(value: string, previous: Array<[string, string]> = []): Array<[string, string]> {
  const at = value.indexOf('=');
  if (at <= 0 || at === value.length - 1) throw new InvalidArgumentError(`<조각id>=<값> 모양이 아니다: ${value}`);
  return [...previous, [value.slice(0, at), value.slice(at + 1)]];
}

function advanceLines(result: AdvanceMissionResult): string[] {
  // 제안이 끝난 미션은 다시 조회하지 않는다 — «착지 0»으로 보이지 않게 따로 적는다.
  if (result.green === 'already-proposed' && Object.keys(result.evidence).length === 0) return [`${result.missionId}\tadvance\t${result.mode}\tgreen already-proposed — 다시 조회·넘기지 않는다`];
  return [
    `${result.missionId}\tadvance\t${result.mode}\t착지 ${result.landed.length} · 준비 ${result.ready.length} · 넘김 ${result.handed.length} · green ${result.green}`,
    ...Object.entries(result.evidence).map(([id, state]) => `  근거: ${id}\t${state}${result.landed.includes(id) ? '\t착지' : ''}`),
    ...result.handed.map((piece) => `  넘김: ${piece.pieceId}\t${piece.launched ? 'launched' : piece.error ? 'failed' : 'not launched'}${piece.error ? `\t${piece.error}` : ''}`),
    ...(result.green === 'proposed' ? ['  green 제안을 미션 카드에 적었다 — 체크리스트는 바꾸지 않는다(OP/주인이 뒤집는다)'] : []),
  ];
}

/**
 * 기본 발사기 — 지금 도는 진입점으로 `--config-dir <운영 config>` 를 붙여 떼어 띄운다.
 * config-dir 은 명시(`--config-dir`/`--test`)가 있으면 그것, 없으면 운영 루트(`prodInstanceRoot()`)다.
 * (작업 트리에서 그냥 띄우면 test 우주로 가서 동결·몫·풀 상한 밖에서 돈다.)
 */
/** This package's CLI entry — never `process.argv[1]`, which is whatever script started this process
 *  (ORCH-LIVE-1008: the orchestrator tick runs `bun …/tick.ts delegate`, so the hand launched `tick.ts --config-dir …
 *  harness say …`, which exited 2 with stdio ignored — the card said `launched` and no run ever started). */
export const ELANOUS_CLI_ENTRY = resolve(import.meta.dir, '../../bin/elanous.mjs');

/** argv for a detached `elanous` child that runs `args` in `configDir`. */
export function taskLauncherArgv(configDir: string, args: readonly string[]): string[] {
  return [ELANOUS_CLI_ENTRY, '--config-dir', configDir, ...args];
}

/** STOP-RECORD launch-failed: 발사 직후 이 창 안에 자식이 비0 으로 끝나면 «발사 실패»로 본다. */
export const LAUNCH_EARLY_EXIT_WINDOW_MS = 3_000;

export interface DefaultTaskLauncherDeps {
  spawn?: DetachedSpawn;
  /** 조기 종료 감시 창(ms) — context(런 id)가 있을 때만 · 0 이면 감시하지 않는다(옛 동작). */
  earlyExitWindowMs?: number;
  /** 자식 stderr 를 받을 디렉토리(시험 주입). 기본 = `<tmpdir>/elanous-task-launch`. */
  stderrDir?: string;
  /** stop 줄 기록기(시험 주입). 기본 = 런 원장. */
  writeStop?: import('../self-implement/run-ledger.js').RunLedgerWriter;
  /** 이미 stop 이 있나(시험 주입). 기본 = 이 우주 런 원장 ⊕ 이 프로세스 기록. */
  hasStop?: (runId: string) => boolean;
  /** HARNESS-PARENT-ON-MSB1 — 원격 부모 대상(시험 주입). undefined = 설정·env 에서 푼다 · null = 끔. */
  parentHost?: import('../task-agent/parent-host.js').ParentHostConfig | readonly import('../task-agent/parent-host.js').ParentHostConfig[] | null;
  /** 원격 ssh(시험 주입). */
  ssh?: import('../task-agent/parent-host.js').SshRunner;
  /** HQ 발사 동결(holdLaunches) 여부(시험 주입). */
  launchHoldActive?: () => boolean;
  /** HQ 판(시험 주입). */
  localVersion?: string;
  /** HQ-owned, refresh-less Codex access mirror to install before a remote parent launch. */
  codexAccessMirror?: () => Promise<{ elanousAuth: string; codexAuth: string; account?: string; usedPercent?: number; thresholdPercent?: number; mirrors?: Array<{ elanousAuth: string; codexAuth: string; account: string; usedPercent?: number; thresholdPercent: number; expiresAt: number }> } | null>;
  /** Clock used to recheck mirror freshness immediately before installation. */
  now?: () => number;
  /** Isolated integration seam; production still reads the HQ rotation snapshot and config directly. */
  ownerCodexRotation?: () => ReturnType<typeof import('../oauth/codex-account-store.js').inspectCodexRotation>;
  ownerCodexRotationConfig?: { accountOrder?: readonly string[]; thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
    creditsAllowed?: boolean; creditReserve?: number };
  /** The HQ owner fence is checked before any token refresh. */
  ownerCodexLeaseHolder?: () => boolean;
  /** 원격 → 로컬 되돌림 알림(시험 주입). 기본 = stderr 한 줄. */
  notice?: (line: string) => void;
}

class NoEligibleOwnerCodexAccountError extends Error {}

/** Only declared Pod launch switches cross from HQ to the remote parent. */
export function podParentLaunchSelectors(contextEnv: Record<string, string>, inheritedEnv: NodeJS.ProcessEnv): Record<string, string> {
  const selectors: Record<string, string> = {};
  for (const key of ['ELANOUS_POD_MEMORY_TIER', 'ELANOUS_POD_MEMORY', 'ELANOUS_POD_MEMORY_HIGH', 'ELANOUS_POD_MEMORY_LITE', 'ELANOUS_POD_GOAL_TYPE'] as const) {
    const value = contextEnv[key] ?? inheritedEnv[key];
    if (value !== undefined) selectors[key] = value;
  }
  const inplace = contextEnv.ELANOUS_POD_INPLACE_WORKTREE ?? inheritedEnv.ELANOUS_POD_INPLACE_WORKTREE;
  if (inplace !== undefined) selectors.ELANOUS_POD_INPLACE_WORKTREE = inplace === '1' ? '1' : '0';
  return selectors;
}

/**
 * HARNESS-PARENT-ON-MSB1 — 켜져 있고 발사 전 점검이 통과하면 원격(ssh)에서 부모를 띄운다(PR 까지만 · 병합은 HQ).
 * 막히면 null — 호출부가 종전 로컬 발사로 간다(관측: task-agent parent-host-fallback).
 */
async function tryRemoteParent(args: string[], cwd: string | undefined, context: TaskLaunchContext, deps: DefaultTaskLauncherDeps): Promise<TaskLaunchReceipt | null> {
  const parentHostModule = await import('../task-agent/parent-host.js');
  let configured: import('../task-agent/parent-host.js').ParentHostSetting | null | undefined = deps.parentHost;
  if (configured === undefined) {
    const { getUserConfig } = await import('../user-config.js');
    try { configured = getUserConfig().taskAgent?.parentHost; } catch { configured = undefined; }
  }
  const multi = Array.isArray(configured);
  const targets = configured === null ? [] : parentHostModule.resolveParentHosts(configured, deps.parentHost === undefined ? process.env : { ...process.env, ELANOUS_TA_PARENT_HOST: undefined });
  if (!targets.length) return null;
  const providerFromArgs = args.find((arg) => arg.startsWith('--child-llm-provider='))?.slice('--child-llm-provider='.length)
    ?? (args.includes('--child-llm-provider') ? args[args.indexOf('--child-llm-provider') + 1] : undefined);
  const effectiveChildProvider = context.effectiveChildProvider ?? providerFromArgs;
  const notice = deps.notice ?? ((line: string) => { try { process.stderr.write(`${line}\n`); } catch { /* ignore */ } });
  const provisionRequests = new Set<string>();
  const provision = (host: string, reason: string): void => {
    const key = `${host}:${reason}`;
    if (provisionRequests.has(key)) return;
    provisionRequests.add(key);
    try { debug.log('task-agent.parent-host', 'provision-requested', { host, runId: context.runId, provider: effectiveChildProvider ?? 'openai-codex', reason }); } catch { /* fail-soft */ }
    notice(`[parent-host] ${host} provision 요청 — ${reason}; 준비 완료 전 배정 대기`);
  };
  const failed = (target: typeof targets[number], gaps: string[], facts: Record<string, string> = {}): void => {
    try { debug.log('task-agent', 'parent-host-fallback', { host: target.host, runId: context.runId, gaps, facts }); } catch { /* fail-soft */ }
    // grok-credential-* 은 호스트가 스스로 보고한 자체 자격 상태다 — 무효면 OP 재로그인 요청이 나간다.
    const provisionGaps = ['grok-cli-missing', 'codex-cli-missing', 'grok-credential-missing', 'grok-credential-expiring', 'grok-credential-expired', 'codex-access-mirror-unavailable'];
    const missing = gaps.every((gap) => provisionGaps.includes(gap)) ? gaps : [];
    notice(`[parent-host] ${target.host} 로 못 띄움 — ${missing.length ? '공급자 준비 뒤 재시도' : multi ? '다음 호스트 또는 로컬 발사로 간다' : '로컬 발사로 간다'}: ${gaps.join(' · ')}`);
    for (const gap of missing) provision(target.host, gap);
  };
  type OwnerMirror = { elanousAuth: string; codexAuth: string; account?: string; usedPercent?: number; thresholdPercent?: number; mirrors?: Array<{ elanousAuth: string; codexAuth: string; account: string; usedPercent?: number; thresholdPercent: number; expiresAt: number }> };
  let accessMirror: OwnerMirror | null | undefined;
  const getAccessMirror = async (): Promise<OwnerMirror | null> => {
    if (accessMirror !== undefined) return accessMirror;
    if (deps.codexAccessMirror) {
      accessMirror = await deps.codexAccessMirror();
      return accessMirror;
    }
    const [pod, authStore, codex, hq] = await Promise.all([
      import('../task-orchestrator/surfaces/self-implement-pod.js'),
      import('../oauth/store.js'),
      import('../oauth/codex.js'),
      import('../hq/hq.js'),
    ]);
    const { inspectCodexRotation, codexQuotaPolicyFromConfig } = await import('../oauth/codex-account-store.js');
    const { codexPolicyAllowsCredits } = await import('../oauth/codex-quota-policy.js');
    const { planOwnerCodexMirrorCandidates, podAccountThresholdPercent } = await import('../task-orchestrator/surfaces/pod-account-broker.js');
    const { getUserConfig } = await import('../user-config.js');
    const rotation = deps.ownerCodexRotation?.() ?? inspectCodexRotation();
    const config = getUserConfig();
    const ownerConfig = deps.ownerCodexRotationConfig;
    const candidates = [...rotation.candidates];
    // No local credential preserves the established local-launch fallback.
    if (candidates.length === 0) { accessMirror = null; return null; }
    const ownerLeaseHeld = deps.ownerCodexLeaseHolder?.() ?? hq.hqFenceDecision('ledger-cli').run;
    if (!ownerLeaseHeld) throw new NoEligibleOwnerCodexAccountError('HQ Codex 토큰 주인 임대가 없어 원격 미러 발사를 거부한다');
    const eligible = planOwnerCodexMirrorCandidates(candidates, {
      accountOrder: ownerConfig?.accountOrder ?? config.llm?.codexAccountOrder ?? [],
      thresholdPercentByAccount: ownerConfig?.thresholdPercentByAccount ?? config.llm?.codexAccountRotationThresholdPercentByAccount,
      creditsAllowed: ownerConfig?.creditsAllowed ?? codexPolicyAllowsCredits(codexQuotaPolicyFromConfig()),
      creditReserve: ownerConfig?.creditReserve ?? config.llm?.codexCreditReserve,
    });
    if (candidates.length > 0 && eligible.length === 0) throw new NoEligibleOwnerCodexAccountError('HQ 소유 Codex 계정이 모두 사용 임계에 도달해 원격 부모 발사를 거부한다');
    const prerefreshDeps = {
      credentials: (account: string) => pod.hostCredentials(account, authStore.authStorePath(), () => '', { requireExplicitChatgptAuthMode: true }),
      refresh: (account: string) => codex.refreshCodexAccountHome(account),
      isLeaseHolder: () => deps.ownerCodexLeaseHolder?.() ?? hq.hqFenceDecision('ledger-cli').run,
    };
    const mirrors: NonNullable<OwnerMirror['mirrors']> = [];
    for (const [index, candidate] of eligible.entries()) {
      const usedPercent = candidate.usedPercent;
      const thresholdPercent = podAccountThresholdPercent(candidate.name, {
        thresholdPercentByAccount: ownerConfig?.thresholdPercentByAccount ?? config.llm?.codexAccountRotationThresholdPercentByAccount,
      });
      // HQ is the sole refresh owner. Send every usable account as an access-only snapshot
      // so the remote Pod broker can rotate instead of pinning all jobs to one account.
      let credential: Awaited<ReturnType<typeof pod.podCodexCredentialWithPrerefresh>> = null;
      try { credential = await pod.podCodexCredentialWithPrerefresh(candidate.name, prerefreshDeps); }
      catch {
        try { debug.log('task-agent.parent-host', 'codex-access-mirror-account-skipped', { account: candidate.name, reason: 'credential-error' }); } catch { /* fail-soft */ }
        continue;
      }
      if (!credential) {
        try { debug.log('task-agent.parent-host', 'codex-access-mirror-account-skipped', { account: candidate.name, reason: 'expiring-or-refresh-failed' }); } catch { /* fail-soft */ }
        continue;
      }
      const expiresAt = (JSON.parse(credential.elanousAuth) as { providers?: { 'openai-codex'?: { tokens?: { expiresAt?: unknown } } } }).providers?.['openai-codex']?.tokens?.expiresAt;
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= (deps.now?.() ?? Date.now()) + 3 * 60 * 60 * 1000) {
        try { debug.log('task-agent.parent-host', 'codex-access-mirror-account-skipped', { account: candidate.name, reason: 'access-expiring' }); } catch { /* fail-soft */ }
        continue;
      }
      mirrors.push({ elanousAuth: credential.elanousAuth, codexAuth: credential.codexAuth, account: candidate.name,
        expiresAt,
        ...(usedPercent !== undefined ? { usedPercent } : {}), thresholdPercent });
      // The receiving marker parser accepts at most 16 distinct accounts.
      // Apply the same bound before writing credentials on the remote parent.
      if (mirrors.length === 16) {
        for (const skipped of eligible.slice(index + 1)) {
          try { debug.log('task-agent.parent-host', 'codex-access-mirror-account-skipped', { account: skipped.name, reason: 'snapshot-limit-16' }); } catch { /* fail-soft */ }
        }
        break;
      }
    }
    accessMirror = mirrors.length ? { ...mirrors[0]!, mirrors } : null;
    return accessMirror;
  };
  if (cwd) {
    failed(targets[0]!, ['project-target-is-local']);
    return null;
  }
  // ⛔ R7(2026-10-16): 시험 안에서 실 ssh 원격 발사는 명시 허용 없이 거부한다(가짜 ssh 주입은 통과).
  //   ⚠️ 이 가드는 hold(launchHoldActive) 판정보다 «앞»이어야 한다 — hold 는 preflightParentHost 의 입력일 뿐이고,
  //   preflightParentHost(parent-host.ts `preflightParentHost` 첫 줄)는 hold 와 무관하게 먼저 실 ssh 를 부른다(다중 대상이면
  //   그 앞의 readParentHostCapacity 도 ssh). 가드를 아래로 내리면 hold 경로에서 시험이 실 ssh 를 쏜다(R7 사고 모양).
  //   hold 경로를 재는 시험은 deps.ssh 가짜 또는 parentHost:null 을 주입한다(real-launch-guard.test 가 이 순서를 문다).
  if (!deps.ssh) (await import('../task-agent/real-launch-guard.js')).refuseRealLaunchUnderTest('remote-parent-ssh', targets.map((target) => target.host).join(','));
  // GROK-MIRROR-REAL-SCOPE: HQ does not select or copy its own Grok access for a remote parent. Each host keeps
  // its own device-auth session, and the preflight below blocks the Grok child when the host reports it invalid
  // (grok-credential-*) — that gap drives the OP re-login request instead of a silent local fallback.
  let launchHoldActive = false;
  try {
    if (deps.launchHoldActive) launchHoldActive = deps.launchHoldActive();
    else {
      const { readLandingFreeze } = await import('../release-loop/landing-freeze.js');
      const { prodInstanceRoot } = await import('../instance/resolve.js');
      launchHoldActive = readLandingFreeze(prodInstanceRoot())?.holdLaunches === true;
    }
  } catch { launchHoldActive = true; /* 못 읽으면 막힌 것으로(fail-closed) */ }
  const podGoal = context.substrate === 'pod' ? context.podGoal : undefined;
  // Pod 선택자만 원격 부모에 넘긴다. 로컬의 나머지 환경·자격은 SSH 로 복사하지 않는다.
  const remoteEnv = { ...context.env };
  // These labels describe an HQ-selected Codex access mirror; never forward an inherited label by itself.
  delete remoteEnv.ELANOUS_REMOTE_CODEX_ACCOUNT;
  delete remoteEnv.ELANOUS_REMOTE_CODEX_USED_PERCENT;
  delete remoteEnv.ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT;
  delete remoteEnv.ELANOUS_REMOTE_CODEX_ACCOUNTS;
  delete remoteEnv.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  if (podGoal) Object.assign(remoteEnv, podParentLaunchSelectors(context.env, process.env));
  const memoryLimit = podGoal ? (await import('../task-orchestrator/surfaces/self-implement-pod.js')).podMemoryLimitFor(podGoal, remoteEnv).limit : undefined;
  const fits = Object.fromEntries(targets.map((target) => {
    const fit = memoryLimit
      ? parentHostModule.readParentHostPodFit(target, memoryLimit, deps.ssh)
      : { state: 'unmeasured' as const, memoryLimit: '', requiredBytes: null, allocatableBytes: null, reason: 'pod-context-unmeasured' };
    try { debug.log('task-agent.parent-host', 'pod-fit', { host: target.host, runId: context.runId, ...fit }); } catch { /* fail-soft */ }
    if (fit.state === 'never-fits') notice(`[parent-host] ${target.host} 제외 — ${fit.reason}: Pod ${fit.memoryLimit} (${fit.requiredBytes} bytes) > node allocatable ${fit.allocatableBytes} bytes`);
    return [target.host, fit];
  }));
  const eligible = targets.filter((target) => fits[target.host]?.state !== 'never-fits');
  if (!eligible.length) {
    const details = targets.map((target) => `${target.host}: Pod ${fits[target.host]!.memoryLimit} (${fits[target.host]!.requiredBytes} bytes) > node allocatable ${fits[target.host]!.allocatableBytes} bytes`).join(' · ');
    throw new Error(`parent-host memory-never-fits — ${details}; local fallback refused`);
  }
  const capacities: Record<string, import('../task-agent/parent-host.js').ParentHostCapacity | null> = Object.fromEntries(
    multi ? eligible.map((target) => [target.host, parentHostModule.readParentHostCapacity(target, deps.ssh)]) : [],
  );
  const measured = eligible.filter((target) => fits[target.host]?.state === 'fits');
  const unknown = eligible.filter((target) => fits[target.host]?.state !== 'fits');
  const ranked = multi
    ? [...parentHostModule.rankParentHosts(measured, context.runId, capacities), ...parentHostModule.rankParentHosts(unknown, context.runId, capacities)]
    : eligible.map((target) => ({ target, weight: null, score: null }));
  const ordered = ranked.map(({ target }) => target);
  let rankingRecorded = false;
  const recordHostRanking = (selectedHost: string | null): void => {
    if (rankingRecorded) return;
    rankingRecorded = true;
    for (const { target, weight, score } of ranked) {
      const sample = capacities[target.host];
      try { debug.log('task-agent.parent-host', 'host-ranked', { host: target.host, runId: context.runId, active: sample?.active ?? null, waiting: sample?.waiting ?? null, headroom: sample?.approvalHeadroom ?? null, capacityState: !sample ? 'unmeasured' : sample.approvalHeadroom > 0 ? 'available' : 'saturated', load: sample?.load ?? null, weight: sample ? weight : null, score: sample && Number.isFinite(score) ? score : null, selected: selectedHost === target.host }); } catch { /* fail-soft */ }
    }
  };
  for (const target of ordered) {
    if (multi && (!capacities[target.host] || capacities[target.host]!.approvalHeadroom <= 0)) {
      const capacity = capacities[target.host];
      failed(target, [`capacity-unavailable · ${capacity
        ? `host active=${capacity.active} waiting=${capacity.waiting} limit=${capacity.limit} headroom=${capacity.headroom}`
        : 'measurement=unknown'}`]);
      continue;
    }
    let preflight: ReturnType<typeof parentHostModule.preflightParentHost>;
    try { preflight = parentHostModule.preflightParentHost({ target, localVersion: deps.localVersion ?? parentHostModule.localElanousVersion(), launchHoldActive, childProvider: effectiveChildProvider ?? 'openai-codex', ...(deps.ssh ? { ssh: deps.ssh } : {}) }); }
    catch (error) { failed(target, [`preflight-error: ${error instanceof Error ? error.message : String(error)}`]); continue; }
    if (!preflight.ok) { failed(target, preflight.gaps, preflight.facts); continue; }
    if (preflight.warnings.length) notice(`⚠ ${target.host} 자격: ${preflight.warnings.join(' · ')}`);
    try {
      if (parentHostModule.shouldInstallRemoteCodexAccess(context.effectiveChildProvider)) {
        let mirror: OwnerMirror | null = null;
        let mirrorReason = 'credential-source-empty';
        try { mirror = await getAccessMirror(); }
        catch (error) {
          if (error instanceof NoEligibleOwnerCodexAccountError) throw error;
          mirrorReason = 'credential-source-error';
        }
        // The receiver accepts at most 16 accounts. Use this same bounded
        // snapshot for installation, the launch marker, and the selected account,
        // including mirrors supplied by the injected credential source.
        const mirrors = mirror?.mirrors?.slice(0, 16);
        const selected = mirrors?.[0] ?? mirror;
        if (mirror) {
          // Snapshot construction can outlive the HQ owner lease. Fresh tokens
          // bypass prerefresh's lock, so recheck before any credential leaves HQ.
          if (!(deps.ownerCodexLeaseHolder?.() ?? (await import('../hq/hq.js')).hqFenceDecision('ledger-cli').run)) {
            try { debug.log('task-agent.parent-host', 'codex-access-mirror-owner-lease-lost', { host: target.host, runId: context.runId, reason: 'owner-lease-lost-before-install' }); } catch { /* fail-soft */ }
            throw new NoEligibleOwnerCodexAccountError('HQ Codex 토큰 주인 임대가 설치 직전에 사라져 원격 미러 발사를 거부한다');
          }
          if (mirror.mirrors && mirror.mirrors.length > 16) {
            for (const skipped of mirror.mirrors.slice(16)) {
              try { debug.log('task-agent.parent-host', 'codex-access-mirror-account-skipped', { account: skipped.account, reason: 'snapshot-limit-16' }); } catch { /* fail-soft */ }
            }
          }
          // Each detached parent keeps its own auth store and Codex homes for
          // its full lifetime, including the legacy single-account source.
          const identity = createHash('sha256').update(`${context.runId}\0${context.launchId}`).digest('hex').slice(0, 20);
          const xdgRoot = `${target.configDir ?? '$HOME/.elanous'}/remote-parent-credentials/${identity}`;
          const mirrorDir = `${xdgRoot}/elanous`;
          const installed = mirrors ?? [{ ...mirror, account: mirror.account ?? 'default' }];
          parentHostModule.installRemoteCodexAccessBatch({ ...target, configDir: mirrorDir }, installed, deps.ssh);
          remoteEnv.XDG_CONFIG_HOME = xdgRoot;
          remoteEnv.CODEX_HOME = `${mirrorDir}/codex-default`;
          // XDG isolation is for Codex credentials only. gh otherwise loses
          // the remote host's existing login before a Pod can be created.
          remoteEnv.GH_CONFIG_DIR = '$HOME/.config/gh';
        }
        else {
          try { debug.log('task-agent.parent-host', 'codex-access-mirror-unavailable', { host: target.host, runId: context.runId, reason: mirrorReason }); } catch { /* fail-soft */ }
          failed(target, ['codex-access-mirror-unavailable']);
          continue;
        }
        if (selected?.account) {
          remoteEnv.ELANOUS_REMOTE_CODEX_ACCOUNT = selected.account;
          remoteEnv.ELANOUS_REMOTE_CODEX_USED_PERCENT = selected.usedPercent === undefined ? 'unknown' : String(selected.usedPercent);
          if (selected.thresholdPercent !== undefined) remoteEnv.ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT = String(selected.thresholdPercent);
        }
        if (mirrors) remoteEnv.ELANOUS_REMOTE_CODEX_ACCOUNTS = JSON.stringify(mirrors.map(({ account, usedPercent, thresholdPercent, expiresAt }) => ({ account, usedPercent: usedPercent ?? null, thresholdPercent, expiresAt })));
        remoteEnv.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
      }
      const launched = parentHostModule.launchRemoteParent(target, args, remoteEnv, deps.ssh, effectiveChildProvider);
      recordHostRanking(target.host);
      try { debug.log('task-agent', 'parent-host-launched', { host: target.host, runId: context.runId, pid: launched.pid, log: launched.log }); } catch { /* fail-soft */ }
      return { runId: context.runId, parentHost: { host: target.host, ...(target.configDir ? { configDir: target.configDir } : {}), pid: launched.pid, log: launched.log } };
    } catch (error) {
      if (error instanceof parentHostModule.RemoteParentNotLaunchedError) { failed(target, [error.message]); continue; }
      if (error instanceof NoEligibleOwnerCodexAccountError) { recordHostRanking(null); throw error; }
      try { debug.log('task-agent', 'parent-host-launch-uncertain', { host: target.host, runId: context.runId, error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
      recordHostRanking(null);
      throw error;
    }
  }
  recordHostRanking(null);
  if (provisionRequests.size > 0) throw new Error(`parent-host-provision-pending: ${[...provisionRequests].join(', ')}; no child provider host launched`);
  return null;
}

/** Advisory lines may precede the actual fatal error. Keep the full stderr as evidence. */
function actionableStderrLine(path: string): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.subarray(0, n).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return lines.find((line) => /^(?:❌|error:|fatal:)/i.test(line)) ?? lines[0] ?? '';
    } finally { closeSync(fd); }
  } catch { return ''; }
}

export async function defaultTaskLauncher(args: string[], cwd?: string, context?: TaskLaunchContext, deps: DefaultTaskLauncherDeps = {}): Promise<void | TaskLaunchReceipt> {
  if (context) context = (await import('../harness/launch-utterance-ledger.js')).withHandLaunchPairContext(args, context); // LAUNCH-UTTERANCE-LEDGER hand→say pair env
  if (context) {
    const remote = await tryRemoteParent(args, cwd, context, deps);
    if (remote) return remote;
  }
  // ⛔ R7(2026-10-16): 시험 안에서 실 `elanous harness say` 를 띄우는 것은 명시 허용 없이 거부한다(가짜 spawn 주입은 통과).
  if (!deps.spawn) (await import('../task-agent/real-launch-guard.js')).refuseRealLaunchUnderTest('local-harness-spawn', args.slice(0, 2).join(' '));
  const spawn = deps.spawn ?? ((await import('node:child_process')).spawn as unknown as DetachedSpawn);
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { prodInstanceRoot } = await import('../instance/resolve.js');
  const configDir = getElanousConfigDirOverride() ?? prodInstanceRoot();
  const argv = taskLauncherArgv(configDir, args);
  const window = context ? deps.earlyExitWindowMs ?? LAUNCH_EARLY_EXIT_WINDOW_MS : 0;
  if (!context || window <= 0) {
    // TA-CARD-RUN-LINK: 런 id 를 자식 환경에 얹는다 — `harness say` 의 런(호스트 orchestrate)이 그 id 를 상속한다.
    await spawnDetachedConfirmed(spawn, process.execPath, argv, SPAWN_CONFIRM_TIMEOUT_MS, cwd, context?.env);
    return context ? { runId: context.runId } : undefined;
  }
  // STOP-RECORD launch-failed: stdio 를 버리면 자식이 exit 2 로 죽어도 흔적이 0 이고 카드는 «launched» 로 남는다
  // (ORCH-LIVE-1008). stderr 만 파일로 받고(파이프는 부모가 먼저 끝나면 자식을 EPIPE 로 죽인다), 짧은 창 안의 종료를 본다.
  const stderrDir = deps.stderrDir ?? join(tmpdir(), 'elanous-task-launch');
  mkdirSync(stderrDir, { recursive: true });
  const stderrPath = join(stderrDir, `${context.runId}.stderr`);
  // 'w' — 같은 runId 재발사가 지난 시도의 stderr 를 이번 cause 로 읽지 않게(리뷰 must-fix).
  const fd = openSync(stderrPath, 'w');
  let exited: Promise<{ code: number | null; signal: string | null }> | undefined;
  const watched: DetachedSpawn = (command, spawnArgs, options) => {
    const child = (spawn as unknown as (c: string, a: string[], o: unknown) => ReturnType<DetachedSpawn>)(command, spawnArgs, { ...options, stdio: ['ignore', 'ignore', fd] });
    const emitter = child as unknown as { once?: (event: 'exit', listener: (code: number | null, signal: string | null) => void) => unknown };
    exited = new Promise((done) => { emitter.once?.('exit', (code, signal) => done({ code, signal })); });
    return child;
  };
  try {
    await spawnDetachedConfirmed(watched, process.execPath, argv, SPAWN_CONFIRM_TIMEOUT_MS, cwd, context.env);
  } finally {
    try { closeSync(fd); } catch { /* the child keeps its own copy */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = exited
    ? await Promise.race([exited, new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), window); })])
    : undefined;
  if (timer) clearTimeout(timer);
  if (early && early.code !== 0) {
    const first = actionableStderrLine(stderrPath);
    const cause = `child rc=${early.code ?? early.signal ?? 'unknown'}${first ? `: ${first}` : ''}`;
    const { boundRunStopCause, recordRunStop, runStopRecorded, RUN_STOP_EVENT } = await import('../self-implement/run-stop.js');
    const hasStop = deps.hasStop ?? ((id: string) => {
      if (runStopRecorded(id)) return true;
      try { return (loadRunLedgerSync(id) ?? []).some((entry) => entry.event === RUN_STOP_EVENT); } catch { return false; }
    });
    // 자식이 같은 runId 로 이미 stop 을 썼으면 더하지 않는다(런마다 한 줄 · 리뷰 must-fix).
    if (hasStop(context.runId)) throw new Error(`발사 직후 자식이 종료했다 — ${boundRunStopCause(cause)}`);
    const entry = recordRunStop({
      runId: context.runId, site: 'launch-failed', class: 'launch-failed',
      cause,
      evidenceRef: stderrPath,
      nextMove: 'Fix the launch argv/config from the stderr evidence, then re-hand the card',
    }, ...(deps.writeStop ? [deps.writeStop] : []));
    // handTask 가 이 예외로 카드를 `launch-failed` 로 적는다(«launched» 로 남지 않게).
    throw new Error(`발사 직후 자식이 종료했다 — ${String(entry.data.cause)}`);
  }
  return { runId: context.runId };
}

/** `spawn` 의 필요한 면만(시험 주입). */
export type DetachedSpawn = (command: string, args: string[], options: { detached: true; stdio: 'ignore'; cwd?: string; env?: NodeJS.ProcessEnv }) => {
  pid?: number;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  unref(): void;
};

/** 발사 확인 대기 상한 — 'spawn'·'error' 어느 쪽도 이 안에 안 오면 pid 유무로 판정한다. */
export const SPAWN_CONFIRM_TIMEOUT_MS = 2_000;

/**
 * 떼어 띄우고 «떴는지» 확인한다 — 'spawn' 이면 성공, 'error'(ENOENT·EACCES 등)면 던진다.
 * 확인 없이 돌려주면 비동기 error 가 처리되지 않고 카드가 `launched` 로 남는다(사후 리뷰 must-fix).
 */
export function spawnDetachedConfirmed(spawnFn: DetachedSpawn, command: string, args: string[], timeoutMs = SPAWN_CONFIRM_TIMEOUT_MS, cwd?: string, env?: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<DetachedSpawn>;
    try { child = spawnFn(command, args, { detached: true, stdio: 'ignore', ...(cwd ? { cwd } : {}), ...(env ? { env: { ...process.env, ...env } } : {}) }); } catch (error) { reject(error); return; }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      // error 리스너는 남겨 둔다 — 확인 뒤 늦게 오는 error 도 처리되지 않은 예외가 되지 않게.
      if (error) { reject(error); return; }
      child.unref();
      resolve();
    };
    const onSpawn = () => finish();
    const onError = (error: Error) => finish(error);
    child.once('spawn', onSpawn);
    child.once('error', onError);
    const timer = setTimeout(() => finish(child.pid ? undefined : new Error(`발사 확인 시간 초과(${timeoutMs}ms) · pid 없음`)), timeoutMs);
  });
}

function orchestrationId(): string {
  return randomUUID();
}

type MapCliItem = MapItem & { text?: string; graphInput?: HostMapItem['graphInput']; inventoryMissing?: boolean };

function selectMapIds(inventory: MapInventory<MapCliItem>, requestedIds: readonly string[] | undefined): MapInventory<MapCliItem> {
  if (!requestedIds) return inventory;
  if (!inventory.complete) return inventory;
  const byId = new Map(inventory.items.map((item) => [item.id, item]));
  return { ...inventory, items: requestedIds.map((id) => byId.get(id) ?? { id, text: `requested ${id}`, inventoryMissing: true }) };
}

/** Read a bounded, current inventory. A failed read is a HOLD, never an empty inventory. */
async function currentMapInventory(recipe: MapRecipe, source: 'landed-but-yellow' | 'drafts', limit: number | undefined,
  root: string, mapRunId: string, taskStatePath: string, requestedIds?: readonly string[]): Promise<MapInventory<MapCliItem>> {
  const run = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')}: ${result.error?.message ?? result.stderr?.trim() ?? 'read failed'}`);
    return result.stdout.trim();
  };
  const recipePath = join(process.cwd(), 'graphs', 'work', `${recipe}.yaml`);
  if (!existsSync(recipePath)) throw new Error(`recipe-missing: ${recipePath}`);
  const recipeSha = run('git', ['hash-object', recipePath]);
  const mainSha = run('git', ['rev-parse', 'origin/main']);
  if (!/^[a-f0-9]{40}$/.test(recipeSha) || !/^[a-f0-9]{40}$/.test(mainSha)
    || run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0] !== mainSha)
    throw new Error('origin-main-unverified');
  const originUrl = run('git', ['remote', 'get-url', 'origin']);
  const repo = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(originUrl)?.[1]?.toLowerCase();
  if (!repo) throw new Error('origin-repository-unverified');
  const snapshotTime = new Date().toISOString();
  let items: MapCliItem[];
  let checklistSnapshotPath: string | null = null;
  let snapshotRef: string;
  if (source === 'landed-but-yellow') {
    const version = checklistDevVersion();
    const snapshot = listChecklist(version);
    const cards = Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(taskStatePath).tasks ?? {});
    items = [];
    const selected = requestedIds ? new Set(requestedIds) : null;
    for (const item of snapshot.items.filter((entry) => entry.status === 'yellow' && (!selected || selected.has(entry.id)))) {
      const candidates = greenSweepCandidates(item, version, cards);
      for (const candidate of candidates) {
        const raw = run('gh', ['pr', 'view', String(candidate.pr), '--repo', repo, '--json', 'number,state,mergeCommit,url']);
        const pr = JSON.parse(raw) as { number?: number; state?: string; mergeCommit?: { oid?: string }; url?: string };
        if (pr.number !== candidate.pr) throw new Error(`pr-identity-unverified: ${candidate.pr}`);
        const prRepo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(pr.url ?? '')?.[1]?.toLowerCase();
        if (prRepo !== repo) throw new Error(`pr-repository-unverified: ${candidate.pr}`);
        let mergeSha = pr.state === 'MERGED' ? pr.mergeCommit?.oid ?? '' : '';
        if (pr.state === 'MERGED' && !mergeSha) throw new Error(`pr-merge-unverified: ${candidate.pr}`);
        const train = candidate.card?.trainLanding;
        if (!mergeSha && pr.state === 'CLOSED' && train?.componentPr === candidate.pr) {
          const integration = JSON.parse(run('gh', ['pr', 'view', String(train.integrationPr), '--repo', repo, '--json', 'number,state,mergeCommit'])) as
            { number?: number; state?: string; mergeCommit?: { oid?: string } };
          if (integration.number === train.integrationPr && integration.state === 'MERGED'
            && integration.mergeCommit?.oid === train.mergeSha) mergeSha = train.mergeSha;
        }
        if (!mergeSha) continue;
        if (!/^[a-f0-9]{40}$/i.test(mergeSha)) throw new Error(`pr-merge-unverified: ${candidate.pr}`);
        const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', mergeSha, 'origin/main'], { cwd: process.cwd() });
        if (ancestor.status !== 0) throw new Error(`pr-main-ancestor-unverified: ${candidate.pr}`);
        // A card can add scope, but cannot remove the current checklist's declared paths.
        // Invalid current scope stays HOLD even if an old TA card has valid paths.
        const paths = greenCloseDeclaredPaths(item.title, candidate.card?.targetPaths);
        items.push({ id: item.id, text: item.title,
          graphInput: { cellId: item.id, version, title: item.title, evidence: item.evidence ?? '', paths,
            candidates: [{ pr: candidate.pr, prUrl: pr.url, mergeSha }], main: { ref: 'origin/main', sha: mainSha } } });
        break;
      }
      if (!requestedIds && limit !== undefined && items.length >= limit) break;
    }
    const snapshotBody = `${JSON.stringify({ version, mainSha, checklist: snapshot,
      selectedIds: items.map((item) => item.id), requestedIds: requestedIds ?? null })}\n`;
    snapshotRef = `checklist-${version}@${createHash('sha256').update(snapshotBody).digest('hex')}`;
    checklistSnapshotPath = join(root, 'map-runs', `${mapRunId}-checklist.json`);
    mkdirSync(dirname(checklistSnapshotPath), { recursive: true });
    writeFileSync(checklistSnapshotPath, snapshotBody, { flag: 'wx', mode: 0o600 });
  } else {
    const cap = 1000;
    const parsed: unknown = JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--draft', '--limit', String(cap),
      '--json', 'number,title,headRefOid']));
    if (!Array.isArray(parsed) || parsed.length >= cap || parsed.some((entry) => !entry || typeof entry !== 'object'
      || !Number.isSafeInteger((entry as { number?: unknown }).number) || typeof (entry as { title?: unknown }).title !== 'string'
      || typeof (entry as { headRefOid?: unknown }).headRefOid !== 'string'))
      throw new Error('draft-inventory-incomplete');
    const selected = requestedIds ? new Set(requestedIds) : null;
    items = parsed.filter((entry) => !selected || selected.has(`pr-${(entry as { number: number }).number}`))
      .slice(0, requestedIds ? undefined : limit).map((entry) => ({ id: `pr-${(entry as { number: number }).number}`,
      text: (entry as { title: string }).title }));
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('draft-inventory-duplicate');
    const openDrafts = parsed.map((entry) => ({ number: (entry as { number: number }).number,
      title: (entry as { title: string }).title }));
    for (const item of items) {
      const number = Number(item.id.slice(3));
      const detail = JSON.parse(run('gh', ['pr', 'view', String(number), '--repo', repo,
        '--json', 'number,title,body,headRefOid,headRefName,labels,isDraft,state,createdAt,files,changedFiles'])) as {
        number?: number; title?: string; body?: string; headRefOid?: string; headRefName?: string;
        labels?: { name: string }[]; isDraft?: boolean; state?: string; createdAt?: string;
        files?: { path: string }[]; changedFiles?: number;
      };
      if (detail.number !== number || detail.headRefOid !== (parsed.find((entry) => (entry as { number: number }).number === number) as { headRefOid: string }).headRefOid
        || detail.state !== 'OPEN' || detail.isDraft !== true) throw new Error(`draft-head-or-state-changed: ${number}`);
      const changedFiles = detail.files?.map((file) => file.path) ?? [];
      const fullFiles = Number.isSafeInteger(detail.changedFiles) && detail.changedFiles === changedFiles.length;
      const graphItem = { pr: number, headOid: detail.headRefOid, repository: repo, state: 'open', isDraft: true,
        labels: detail.labels?.map((label) => label.name) ?? [], branch: detail.headRefName,
        title: detail.title, body: detail.body, createdAt: detail.createdAt,
        changedFiles, changedFilesComplete: fullFiles, latestFileChanges: {},
        openDrafts, openDraftsComplete: true, mergedTwins: [], mergedTwinsComplete: false,
        liveBranches: [], runStatus: 'unmeasured' };
      item.graphInput = { mapRunId, snapshotTime, inventoryComplete: true, mainSha,
        inventory: { complete: true, snapshotTime, mainSha, items: openDrafts }, item: graphItem };
    }
    snapshotRef = `drafts@${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`;
  }
  return { items, complete: true, snapshotTime, snapshotRef, recipeSha, mainSha, checklistSnapshotPath,
    requestedPool: 'cold-job', selectedPool: null, imageCommit: null };
}

export function greenCloseDeclaredPaths(title: string, cardPaths?: readonly string[]): string[] {
  const declared = parseAskTargetPathHintsResult(title);
  if (declared.labelMissing || declared.rejected.length > 0) return [];
  return [...new Set([...declared.paths, ...(cardPaths ?? [])])];
}

const COVER_QUERY_LIMIT = STORE_SAFETY_MAX;

/** Federated read: rows from every store, whether any single store hit the bound, and how many stores could not be read. */
export interface CoverLogRead { rows: LogStoreRow[]; limitReached: boolean; unreadableStores: number; storesRead: number }

/** Land attempts are observed separately from completed land actions; an appended order or skipped move is not a merge. */
export interface CoverLandSignals {
  liveMoveEvents: number | null;
  executedLiveMoves: number | null;
  landOrderEvents: number | null;
}

export function formatCoverLandSignals(signals: CoverLandSignals): string {
  const count = (value: number | null) => value === null ? '-' : String(value);
  return `착지 시도 관측: live-move ${count(signals.liveMoveEvents)} · 집행 ${count(signals.executedLiveMoves)} · land-order ${count(signals.landOrderEvents)} (병합 수와 별개)`;
}

function queryCoverLogs(query: LogQuery, includeTest = false): CoverLogRead {
  const { targets, error } = resolveLogTargets({ all: true, includeTest });
  if (error) throw new Error(error);
  const read: CoverLogRead = { rows: [], limitReached: false, unreadableStores: 0, storesRead: 0 };
  for (const target of targets) {
    if (!existsSync(target.dbPath)) continue;
    let store: LogStore | undefined;
    try {
      store = LogStore.openReadOnly(target.dbPath);
      const rows = store.query(query);
      if (query.limit !== undefined && rows.length >= query.limit) read.limitReached = true;
      read.rows.push(...rows);
      read.storesRead++;
    } catch { read.unreadableStores++; }
    finally { try { store?.close(); } catch { /* already closed */ } }
  }
  if (read.storesRead === 0) throw new Error('읽을 수 있는 logs.db 없음');
  return read;
}

function coverEvents<T>(rows: readonly LogStoreRow[], category: string, event: string, parse: (data: Record<string, unknown>) => T | null): T[] {
  const events: T[] = [];
  for (const row of rows) {
    if (row.category !== category || row.event !== event || !row.data) continue;
    try {
      const data: unknown = JSON.parse(row.data);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      const parsed = parse(data as Record<string, unknown>);
      if (parsed !== null) events.push(parsed);
    } catch { /* malformed log data is not evidence of an action */ }
  }
  return events;
}

/** A malformed land record makes the numerator unknown; dropping it would assert a false zero. */
function coverLandMoves(rows: readonly LogStoreRow[]): { card: string; executed: boolean; ok: boolean }[] | null {
  const moves: { card: string; executed: boolean; ok: boolean }[] = [];
  for (const row of rows) {
    if (row.category !== 'task-agent' || row.event !== 'live-move') continue;
    if (typeof row.data !== 'string') return null;
    let data: unknown;
    try { data = JSON.parse(row.data); } catch { return null; }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const move = data as Record<string, unknown>;
    if (typeof move.kind !== 'string') return null;
    if (move.kind !== 'land') continue;
    if (typeof move.card !== 'string' || !move.card || typeof move.executed !== 'boolean'
      || typeof move.ok !== 'boolean') return null;
    moves.push({ card: move.card, executed: move.executed, ok: move.ok });
  }
  return moves;
}

/** An incomplete action source cannot provide a certain land numerator. */
function coverTaskActions(rows: readonly LogStoreRow[]): NonNullable<TaskAgentCoverInput['taskAgentActions']> | null {
  const actions: NonNullable<TaskAgentCoverInput['taskAgentActions']>[number][] = [];
  for (const row of rows) {
    if (row.category !== 'task-agent' || row.event !== 'action') continue;
    if (typeof row.data !== 'string') return null;
    let data: unknown;
    try { data = JSON.parse(row.data); } catch { return null; }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const action = data as Record<string, unknown>;
    if (typeof action.kind !== 'string' || typeof action.result !== 'string') return null;
    if (action.kind === 'land' && action.result === 'done'
      && (typeof action.taskId !== 'string' || !action.taskId)) return null;
    actions.push({ kind: action.kind as NonNullable<TaskAgentCoverInput['taskAgentActions']>[number]['kind'],
      result: action.result,
      ...(typeof action.taskId === 'string' ? { taskId: action.taskId } : {}),
      ...(typeof action.reason === 'string' ? { reason: action.reason } : {}) });
  }
  return actions;
}

function coverLandSteps(rows: readonly LogStoreRow[]): NonNullable<TaskAgentCoverInput['allLands']> | null {
  const steps: NonNullable<TaskAgentCoverInput['allLands']>[number][] = [];
  for (const row of rows) {
    if (row.category !== 'pr.land' || row.event !== 'step') continue;
    if (typeof row.data !== 'string') return null;
    let data: unknown;
    try { data = JSON.parse(row.data); } catch { return null; }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const step = data as Record<string, unknown>;
    if (typeof step.step !== 'string' || typeof step.ok !== 'boolean') return null;
    steps.push({ step: step.step, ok: step.ok });
  }
  return steps;
}

export interface CoverCardRow { id: string; createdAt: string }

/**
 * 분모 = TA 카드 원장(`task-agent-actions.json` · `ta-…` id) — 분자 `task-agent`/`action` 로그의 taskId 가 이 id 다.
 * (task-cards CardStore 의 UUID 카드는 taskId 와 겹치지 않아 언제나 0/N 을 «잰 값처럼» 그린다 — 리뷰 must-fix.)
 */
function readCoverCards(statePath: string): CoverCardRow[] {
  const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
  return Object.values(tasks).filter((card) => typeof card?.id === 'string' && typeof card.createdAt === 'string')
    .map(({ id, createdAt }) => ({ id, createdAt }));
}

/** Cards whose createdAt falls in the window; an unparsable createdAt is not placed in any window. */
export function coverCardsInWindow(cards: readonly CoverCardRow[] | null, window: { sinceMs?: number; untilMs?: number }): { id: string }[] | null {
  if (cards === null) return null;
  return cards.filter(({ createdAt }) => {
    const time = Date.parse(createdAt);
    return Number.isFinite(time) && (window.sinceMs === undefined || time >= window.sinceMs) && (window.untilMs === undefined || time <= window.untilMs);
  }).map(({ id }) => ({ id }));
}

/** Read the card ledger itself. A missing file or malformed row makes the aggregate unknown. */
function readImplementCardBindings(statePath: string): { bindings: ImplementCardRunBinding[]; cleanup: Array<{ cardId: string; outcome: 'complete' | 'partial'; at: string }> | null } {
  if (!existsSync(statePath)) throw new Error('TASK-AGENT card ledger is missing');
  const state = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath);
  if (state.tasks !== undefined && (!state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks))) {
    throw new Error('TASK-AGENT card ledger is malformed');
  }
  const cards = Object.entries(state.tasks ?? {});
  if (cards.length >= COVER_QUERY_LIMIT) throw new Error('TASK-AGENT card ledger reached query bound');
  const bindings: ImplementCardRunBinding[] = [];
  const cleanup: Array<{ cardId: string; outcome: 'complete' | 'partial'; at: string }> = [];
  let cleanupUnreadable = false;
  for (const [key, card] of cards) {
    if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.id !== 'string' || !card.id
      || card.id !== key || (card.runId != null && typeof card.runId !== 'string')
      || (card.runChildId != null && typeof card.runChildId !== 'string')) {
      throw new Error('TASK-AGENT card binding is malformed');
    }
    bindings.push({ cardId: card.id, runId: card.runId, runChildId: card.runChildId });
    if (card.postLand === undefined) continue;
    const post = card.postLand;
    if (!post || (post.outcome !== 'complete' && post.outcome !== 'partial')
      || !Number.isSafeInteger(post.pr) || typeof post.head !== 'string' || !post.head
      || typeof post.at !== 'string' || !Number.isFinite(Date.parse(post.at))
      || !Array.isArray(card.history)) { cleanupUnreadable = true; continue; }
    if (card.history.some((event) => !event || typeof event !== 'object')) { cleanupUnreadable = true; continue; }
    if (card.status !== 'done' || card.prTerminal?.state !== 'MERGED'
      || card.prTerminal.pr !== post.pr || typeof card.prTerminal.head !== 'string'
      || card.prTerminal.head.toLowerCase() !== post.head.toLowerCase()) continue;
    // A same-outcome reconciliation refreshes postLand.at without appending another history event.
    const sourceEvents = card.history.filter((event) => event.event === 'postland-card' && event.pr === post.pr
      && typeof event.head === 'string' && event.head.toLowerCase() === post.head.toLowerCase());
    if (sourceEvents.length === 0) continue;
    if (sourceEvents.some((event) => typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)))) {
      cleanupUnreadable = true;
      continue;
    }
    const sourceAt = sourceEvents[sourceEvents.length - 1]!.at;
    cleanup.push({ cardId: card.id, outcome: post.outcome, at: sourceAt });
  }
  return { bindings, cleanup: cleanupUnreadable ? null : cleanup };
}

function implementLedgerDirectories(statePath: string, includeTest: boolean): string[] {
  const root = dirname(statePath);
  return [...new Set([
    runLedgerDir(root),
    runLedgerDir(),
    ...resolveFederatedRunLedgerDirectories({ includeTest }),
    ...remoteLedgerMirrorDirs(root),
  ])];
}

/** Read only runs bound to cards. Merge time, rather than card launch time, owns the cover window. */
function readImplementRunMerges(
  bindings: readonly ImplementCardRunBinding[],
  directories: readonly string[],
  window: { sinceMs?: number; untilMs?: number },
): ReadonlyMap<string, ImplementRunMergeEvent> {
  const runIds = new Set(bindings.flatMap(({ runId, runChildId }) => [runId, runChildId])
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  if (runIds.size >= COVER_QUERY_LIMIT) throw new Error('bound run ledger query reached bound');
  const merges = new Map<string, ImplementRunMergeEvent>();
  let eventsRead = 0;
  for (const runId of runIds) {
    let found = false;
    let merged = false;
    let failure: unknown;
    for (const directory of directories) {
      try {
        const loaded = loadRunLedgerWithMetadata(runId, directory);
        if (loaded === null) continue;
        found = true;
        if (loaded.skippedTrailingBytes) throw new Error(`run ledger is incomplete: ${runId}`);
        eventsRead += loaded.entries.length;
        if (eventsRead >= COVER_QUERY_LIMIT) throw new Error('run ledger query reached bound');
        for (const entry of loaded.entries) {
          if (entry.event !== 'merged') continue;
          if (typeof entry.data.merged !== 'boolean') throw new Error(`merged event is malformed: ${runId}`);
          if (!entry.data.merged) continue;
          if (window.sinceMs !== undefined || window.untilMs !== undefined) {
            const at = Date.parse(entry.timestamp ?? '');
            if (!Number.isFinite(at)) throw new Error(`merged event timestamp is missing: ${runId}`);
            if ((window.sinceMs !== undefined && at < window.sinceMs)
              || (window.untilMs !== undefined && at > window.untilMs)) continue;
          }
          merged = true;
        }
      } catch (error) { failure ??= error; }
    }
    // A local parent may contain only launch events while a federated or mirrored copy has the merge.
    // Read every physical copy. Any unreadable copy leaves the aggregate unknown.
    if (failure !== undefined) throw failure;
    if (!found) throw new Error(`bound run ledger is missing: ${runId}`);
    merges.set(runId, { merged });
  }
  return merges;
}

export function readTaskAgentCover(
  window: { sinceMs?: number; untilMs?: number } = {},
  query: NonNullable<TasksCliDeps['coverLogs']> = queryCoverLogs,
  taskCards?: readonly { id: string }[] | null,
  goalReaders: Pick<TasksCliDeps, 'coverGoalAsks' | 'coverGoalRuns' | 'coverImplementCardRuns' | 'coverImplementRunMerges' | 'taskStatePath' | 'coverIncludeTest'> = {},
): { rows: CoverRow[]; sevenVerbs: SevenVerbLive; landSignals: CoverLandSignals; limitReached: boolean; unreadableStores: number } {
  let unreadableStores = 0;
  const read = (category: 'task-agent' | 'pr.land' | 'task-agent.land-order', event: 'action' | 'step' | 'live-move' | 'appended'): { rows: LogStoreRow[]; limitReached: boolean } | null => {
    try {
      const result = query({ ...window, limit: COVER_QUERY_LIMIT, exactCategories: [category], events: [event] });
      if (Array.isArray(result)) return { rows: result, limitReached: result.length >= COVER_QUERY_LIMIT };
      unreadableStores = Math.max(unreadableStores, result.unreadableStores);
      return { rows: result.rows, limitReached: result.limitReached };
    } catch { return null; }
  };
  const actionRead = read('task-agent', 'action');
  const landRead = read('pr.land', 'step');
  const moveRead = read('task-agent', 'live-move');
  const orderRead = read('task-agent.land-order', 'appended');
  const actions = actionRead?.rows ?? null;
  const lands = landRead?.rows ?? null;
  const truncated = { taskAgentActions: actionRead?.limitReached === true, allLands: landRead?.limitReached === true,
    liveLandMoves: moveRead?.limitReached === true };
  const moves = moveRead && !moveRead.limitReached ? coverLandMoves(moveRead.rows) : null;
  const inWindow = (value: string): boolean => {
    const time = Date.parse(value);
    return Number.isFinite(time) && (window.sinceMs === undefined || time >= window.sinceMs) && (window.untilMs === undefined || time <= window.untilMs);
  };
  let goalAsks: ReturnType<NonNullable<TasksCliDeps['coverGoalAsks']>> = null;
  let goalRuns: ReturnType<NonNullable<TasksCliDeps['coverGoalRuns']>> = null;
  let goalAsksTruncated = false;
  let goalRunsTruncated = false;
  try {
    if (goalReaders.coverGoalAsks) goalAsks = goalReaders.coverGoalAsks();
    else {
      const asks = loadGoalAskRecords({ limit: COVER_QUERY_LIMIT }, goalRunDbPath());
      goalAsksTruncated = asks.length >= COVER_QUERY_LIMIT;
      goalAsks = asks;
    }
  } catch { goalAsks = null; }
  try {
    if (goalReaders.coverGoalRuns) goalRuns = goalReaders.coverGoalRuns();
    else {
      // Cover consumes only goal identity and terminal outcome. Child-brain enrichment would query every
      // runId against every registered test logs.db, even though this measurement never reads childBrain.
      const runs = loadGoalRunQuery({ limit: COVER_QUERY_LIMIT }, goalRunDbPath(), { targets: [] });
      goalRunsTruncated = runs?.truncated ?? false;
      goalRuns = runs?.records.map(({ goalId, record }) => ({
        goalId, outcome: record.outcome, stage: record.stage, startedAt: record.startedAt ?? '', completedAt: record.completedAt,
      })) ?? null;
    }
  } catch { goalRuns = null; }
  const authoredGoalIds = new Set(goalAsks?.map((ask) => ask.goalId) ?? []);
  const input: TaskAgentCoverInput = {
    taskAgentActions: actions === null ? null : coverTaskActions(actions),
    liveLandMoves: moves,
    allLands: lands === null ? null : coverLandSteps(lands),
    truncated: { ...truncated, goalAsks: goalAsksTruncated, goalRuns: goalRunsTruncated },
    // Authoring may start before this window; completion is the event being counted.
    goalAsks,
    goalRuns: goalRuns && (window.sinceMs !== undefined || window.untilMs !== undefined)
      ? goalRuns.some((run) => authoredGoalIds.has(run.goalId)
          && run.stage === 'merged' && (run.outcome === 'completed' || run.outcome === 'merged')
          && !Number.isFinite(Date.parse(run.completedAt ?? '')))
        ? null : goalRuns.filter((run) => inWindow(run.completedAt ?? ''))
      : goalRuns,
    ...(taskCards === undefined ? {} : { taskCards }),
  };
  // A supplied reader overrides only its own source. The ordinary CLI always reads both physical ledgers.
  try {
    if (goalReaders.coverImplementCardRuns) input.implementCardRuns = goalReaders.coverImplementCardRuns();
    else {
      const { bindings, cleanup } = readImplementCardBindings(goalReaders.taskStatePath ?? taskStatePathDefault());
      input.implementCardRuns = bindings;
      input.cleanupCards = cleanup?.filter((card) => inWindow(card.at)) ?? null;
    }
  } catch { input.implementCardRuns = null; input.cleanupCards = null; input.implementReadFailure = 'card-ledger-unreadable'; }
  try {
    input.implementRunMerges = goalReaders.coverImplementRunMerges
      ? goalReaders.coverImplementRunMerges()
      : input.implementCardRuns === null
        ? null
        : readImplementRunMerges(
          input.implementCardRuns,
          implementLedgerDirectories(goalReaders.taskStatePath ?? taskStatePathDefault(), goalReaders.coverIncludeTest === true),
          window,
        );
  } catch { input.implementRunMerges = null; input.implementReadFailure ??= 'run-ledger-unreadable'; }
  const orders = orderRead && !orderRead.limitReached ? coverEvents(orderRead.rows, 'task-agent.land-order', 'appended', (data) =>
    Number.isSafeInteger(data.pr) ? { pr: data.pr as number } : null) : null;
  const landSignals: CoverLandSignals = {
    liveMoveEvents: moves?.length ?? null,
    executedLiveMoves: moves?.filter((move) => move.executed).length ?? null,
    landOrderEvents: orders?.length ?? null,
  };
  return { rows: measureTaskAgentCover(input), sevenVerbs: measureSevenVerbLive(input), landSignals,
    limitReached: truncated.taskAgentActions || truncated.allLands || moveRead?.limitReached === true || orderRead?.limitReached === true || goalAsksTruncated || goalRunsTruncated, unreadableStores };
}

const OUTCOMES_QUERY_LIMIT = STORE_SAFETY_MAX;

/** «끝났다»로 읽는 카드 상태 — 이 밖(handed·launched)은 PR 종결 관측이 있어야 끝난 것으로 센다. */
const OUTCOME_TERMINAL_STATUSES: ReadonlySet<TaskCard['status']> = new Set(['failed', 'launch-failed', 'landed', 'landed-by-hand', 'done']);

/** 카드 원장에서 «종결»로 읽는 사건 — 이 줄의 시각만 종료 시각으로 쓴다(run-bound · launch 같은 끝나기 전 사건은 종료 시각이 아니다). */
const OUTCOME_TERMINAL_HISTORY_EVENTS: ReadonlySet<string> = new Set([
  'failed', 'launch-failed', 'closed-by-hand', 'landed-via-train', 'postland-card', 'postland',
]);
const OUTCOME_SUCCESS_HISTORY_EVENTS: ReadonlySet<string> = new Set(['landed-via-train', 'postland-card', 'postland']);

/** `--since`/`--until` 의 상대 기간 — `24h` · `90m` · `3d`. */
const OUTCOMES_RELATIVE_WINDOW = /^\d+(?:\.\d+)?(?:m|h|d)$/;

/** `--since`/`--until` — ISO 시각 또는 상대 기간. 그 밖의 모양은 창을 지어내지 않고 거부한다. */
function parseOutcomeTime(value: string | undefined, flag: string, now: number): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (OUTCOMES_RELATIVE_WINDOW.test(text)) {
    const amount = Number(text.slice(0, -1));
    const unit = text.slice(-1);
    const hours = unit === 'd' ? amount * 24 : unit === 'm' ? amount / 60 : amount;
    return now - hours * 3_600_000;
  }
  const time = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(time)) {
    throw new Error(`${flag} 는 ISO 시각 또는 상대 기간(24h·3d)이어야 한다`);
  }
  return time;
}

/** `tasks outcomes` 한 줄 — 카드 하나의 결과. 모르는 칸은 null(지어내지 않는다). */
export interface TaskOutcomeRow {
  /** 칸(체크리스트 id) — 칸 없이 넘긴 카드는 null. */
  cell: string | null;
  card: string;
  runId: string | null;
  /** 사유 원장을 실제로 읽은 자식 런(부모 pod-child-run 매핑). */
  childRunId: string | null;
  /** 부모 호스트 원격 이름 — HQ 로컬 발사면 null. */
  host: string | null;
  /** 이 행의 카드 또는 PR 종결 사건 시각(ISO). */
  endedAt: string;
  cardTerminalAt: string | null;
  /** 카드가 결속 PR의 종단을 관측한 시각. GitHub 원본 mergedAt/closedAt 와 동일하다고 추정하지 않는다. */
  prTerminalAt: string | null;
  /** 이 카드 원장은 GitHub 원본 terminal timestamp 를 보존하지 않는다. */
  ghTerminalAt: null;
  ghTerminalMissing: 'not-stored-in-card';
  /** 이 행이 들어가는 독립 분모. 같은 카드의 카드·PR 종결은 별도 행이다. */
  terminalKind: 'card' | 'pr';
  /** 이 사건을 센 근거 — 카드 상태·이력 사건 또는 결속된 PR 상태를 그대로 적는다. */
  countReason: string;
  /** 원시 카드 상태. board가 PR 종결로 투영한 상태와 구별한다. */
  cardStatus: TaskCard['status'];
  /** PR 결속 — 번호 ⊕ 종결 상태(종결을 못 봤으면 state null). */
  pr: { number: number; state: 'MERGED' | 'CLOSED' | null } | null;
  /** 종결 사유 원문 — 자식 원장의 마지막 pr-open-failed/child-error data.error 꼬리(없으면 null). */
  reason: string | null;
  /** 종결 사유를 읽은 곳(`child-ledger:<event>` · 못 읽었으면 null). */
  reasonFrom: string | null;
  /** 원본 증거 또는 그 증거를 못 실은 이유. */
  evidence: { childLedger: { event: string; error: string } | null; childLedgerMissing: string | null;
    lastLines: string[] | null; lastLinesMissing: string | null };
}

export interface TaskOutcomeReport {
  since: string | null;
  until: string | null;
  rows: TaskOutcomeRow[];
  /** 사유별 집계 — 사유 분모는 실패 카드 종단뿐이다(PR/성공 종단은 포함하지 않는다). */
  aggregate: { cards: number; cardTerminals: number; prTerminals: number; failedCardTerminals: number;
    reasons: Array<{ reason: string; count: number }>; missingReason: number };
  /** 조회 상한에 닿아 절단됐나 — 그때 집계는 «이 창 안에서 센 행»만 센다. */
  limitReached: boolean;
  /** 절단 사유 — 카드 조회 상한. */
  stopReason: 'page-limit' | null;
  /** 자식 원장(자식 런 원장 파일)을 실제로 읽었나. */
  childLedgerObserved: boolean;
  /** 종결 사유 원문을 하나라도 관측했나. */
  reasonObserved: boolean;
  /** 끝났는데 종료 시각을 몰라 창에 넣지 못한 카드 수. */
  undatedCards: number;
  /** 시각 없는 카드의 기간 귀속은 계산할 수 없다. undatedCards 는 창 밖까지 포함한 수다. */
  undatedPeriodAttribution: 'unknown';
  /** 두 종결 사건이 모두 창 안에 있는 카드 ID. --by 축 필터에서도 같은 목록을 낸다. */
  overlapCardIds: string[];
  /** 아직 끝나지 않은 카드 수(창 대상 아님). */
  openCards: number;
  warning?: string;
}

/** 마지막 실제 종결 사건. 후보·발사·run-bound·관측 줄은 종료 증거가 아니다. */
function outcomeTerminalHistoryLine(card: TaskCard): TaskCardEvent | undefined {
  return (card.history ?? []).filter((item) => OUTCOME_TERMINAL_HISTORY_EVENTS.has(item.event)).at(-1);
}

/** 종결 사유 원문을 주는 자식 원장 이벤트 — 뒤에서부터 마지막 것을 쓴다. */
const OUTCOME_REASON_LEDGER_EVENTS = new Set(['pr-open-failed', 'child-error']);

/** 부모 runId 원장의 마지막 pod-child-run 매핑이 가리키는 자식 런. 매핑이 없으면 null. */
function outcomeChildRunId(card: TaskCard, ledgerDir: string): string | null {
  if (typeof card.runId !== 'string' || card.runId === '') return null;
  const parent = loadRunLedgerSync(card.runId, ledgerDir);
  if (parent === null) return null;
  for (let i = parent.length - 1; i >= 0; i -= 1) {
    const entry = parent[i]!;
    if (entry.event !== 'pod-child-run') continue;
    const childRunId = entry.data?.childRunId;
    return typeof childRunId === 'string' && childRunId !== '' ? childRunId : null;
  }
  return null;
}

/** 자식 원장의 마지막 pr-open-failed/child-error data.error 꼬리 — 없으면 null. */
function outcomeChildLedgerReason(childEntries: readonly RunLedgerEntry[]): { reason: string; reasonFrom: string } | null {
  for (let i = childEntries.length - 1; i >= 0; i -= 1) {
    const entry = childEntries[i]!;
    if (!OUTCOME_REASON_LEDGER_EVENTS.has(entry.event)) continue;
    const error = entry.data?.error;
    if (typeof error !== 'string' || error === '') continue;
    return { reason: error, reasonFrom: `child-ledger:${entry.event}` };
  }
  return null;
}

/**
 * TA 카드·PR 종결 사실을 기간으로 센다(읽기 전용). 창은 «종료 시각»에 걸린다.
 * 종결 사유 원문은 부모 runId → pod-child-run 매핑 → 자식 원장의 마지막
 * pr-open-failed/child-error data.error 꼬리에서 읽는다.
 */
export function readTaskOutcomes(
  window: { sinceMs?: number; untilMs?: number; terminalKind?: 'card' | 'pr' } = {},
  deps: Pick<TasksCliDeps, 'taskStatePath' | 'outcomesLimit'> = {},
  snapshot?: Record<string, TaskCard>,
): Omit<TaskOutcomeReport, 'since' | 'until'> {
  const statePath = deps.taskStatePath ?? taskStatePathDefault();
  const cards = snapshot ?? readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
  const limit = deps.outcomesLimit ?? OUTCOMES_QUERY_LIMIT;
  const candidates: Array<{ card: TaskCard; terminal: TaskCard['prTerminal']; endedAt: string;
    cardTerminalAt: string | null; prTerminalAt: string | null; terminalKind: 'card' | 'pr'; countReason: string }> = [];
  let undatedCards = 0;
  let openCards = 0;
  for (const card of Object.values(cards)) {
    if (!card || typeof card.id !== 'string') continue;
    const terminal = boundPrTerminal(card);
    // 결과란 «끝난 카드»다 — 종결 상태이거나 PR 이 종결로 관측된 카드. 아직 도는 카드는 창 대상이 아니다(따로 센다).
    if (!OUTCOME_TERMINAL_STATUSES.has(card.status) && terminal === undefined) { openCards++; continue; }
    const terminalHistory = outcomeTerminalHistoryLine(card);
    const successfulStatus = card.status === 'done' || card.status === 'landed' || card.status === 'landed-by-hand';
    const manualClosure = (card.status === 'done' || card.status === 'landed-by-hand')
      && terminalHistory?.event === CLOSED_BY_HAND_EVENT;
    const failedStatus = card.status === 'failed' || card.status === 'launch-failed';
    const history = successfulStatus
      ? (OUTCOME_SUCCESS_HISTORY_EVENTS.has(terminalHistory?.event ?? '') || manualClosure ? terminalHistory : undefined)
      : failedStatus && (terminalHistory?.event === 'failed' || terminalHistory?.event === 'launch-failed')
        ? terminalHistory : undefined;
    const validAt = (at: string | undefined): string | null => at && Number.isFinite(Date.parse(at)) ? at : null;
    const cardTerminalAt = validAt(history?.at);
    const prTerminalAt = validAt(terminal?.at);
    if (cardTerminalAt === null && prTerminalAt === null) { undatedCards++; continue; }
    const inWindow = (at: string | null): at is string => at !== null
      && (window.sinceMs === undefined || Date.parse(at) >= window.sinceMs)
      && (window.untilMs === undefined || Date.parse(at) <= window.untilMs);
    if (inWindow(cardTerminalAt)) {
      candidates.push({ card, terminal, endedAt: cardTerminalAt, cardTerminalAt, prTerminalAt,
        terminalKind: 'card', countReason: `card:${card.status}:${history!.event}@${cardTerminalAt}` });
    }
    if (inWindow(prTerminalAt)) {
      candidates.push({ card, terminal, endedAt: prTerminalAt, cardTerminalAt, prTerminalAt,
        terminalKind: 'pr', countReason: `pr:${terminal!.state}:#${terminal!.pr}@${prTerminalAt}` });
    }
  }
  const overlap = new Map<string, Set<'card' | 'pr'>>();
  for (const item of candidates) {
    const kinds = overlap.get(item.card.id) ?? new Set<'card' | 'pr'>();
    kinds.add(item.terminalKind);
    overlap.set(item.card.id, kinds);
  }
  const overlapCardIds = [...overlap].filter(([, kinds]) => kinds.size === 2).map(([id]) => id).sort();
  const visible = window.terminalKind ? candidates.filter((item) => item.terminalKind === window.terminalKind) : candidates;
  visible.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.card.id.localeCompare(b.card.id)
    || a.terminalKind.localeCompare(b.terminalKind));
  const limitReached = visible.length > limit;
  const selected = limitReached ? visible.slice(0, limit) : visible;
  const stateRoot = dirname(statePath);
  const localLedgerDirs = implementLedgerDirectories(statePath, false);
  const runExits = readRunExits(stateRoot);
  let childLedgerObserved = false;
  let reasonObserved = false;
  const rows = selected.map(({ card, terminal, endedAt, cardTerminalAt, prTerminalAt, terminalKind, countReason }): TaskOutcomeRow => {
    const number = cardPrNumber(card);
    // 종결 사유 원문 — 부모 runId → pod-child-run 매핑 → 자식 원장 꼬리. 원장을 못 찾으면 null.
    const remoteDir = card.parentHost ? remoteLedgerMirrorDir(stateRoot, card.parentHost.host) : null;
    // 원격 부모는 해당 호스트 거울에서만 결속한다. 로컬 동명 런을 원격 증거로 오인하지 않는다.
    const ledgerDirs = remoteDir ? [remoteDir] : localLedgerDirs;
    const ledgerDir = card.runId ? ledgerDirs.find((dir) => loadRunLedgerSync(card.runId!, dir) !== null) : undefined;
    const mappedChildRunId = ledgerDir ? outcomeChildRunId(card, ledgerDir) : null;
    const childBindingMismatch = card.runChildId && mappedChildRunId && card.runChildId !== mappedChildRunId;
    const childRunId = childBindingMismatch ? null : mappedChildRunId;
    const childEntries = childRunId === null || !ledgerDir ? null : loadRunLedgerSync(childRunId, ledgerDir);
    if (childEntries !== null) childLedgerObserved = true;
    const reasonTail = childEntries === null ? null : outcomeChildLedgerReason(childEntries);
    const cardReason = terminalKind === 'card' && (card.status === 'failed' || card.status === 'launch-failed') ? reasonTail : null;
    if (cardReason !== null) reasonObserved = true;
    const exit = card.runId ? runExits.find((row) => row.runId === card.runId) : undefined;
    const lastLines = exit?.lastLines?.length ? exit.lastLines : null;
    return {
      cell: card.checklistId ?? null,
      card: card.id,
      runId: card.runId ?? null,
      childRunId,
      host: card.parentHost?.host ?? null,
      endedAt,
      cardTerminalAt,
      prTerminalAt,
      ghTerminalAt: null,
      ghTerminalMissing: 'not-stored-in-card',
      terminalKind,
      countReason,
      cardStatus: card.status,
      pr: number === undefined ? null : { number, state: terminal?.state ?? null },
      reason: cardReason?.reason ?? null,
      reasonFrom: cardReason?.reasonFrom ?? null,
      evidence: {
        childLedger: reasonTail ? { event: reasonTail.reasonFrom.slice('child-ledger:'.length), error: reasonTail.reason } : null,
        childLedgerMissing: reasonTail ? null : !card.runId ? 'run-id-missing'
          : remoteDir && !existsSync(remoteDir) ? 'remote-ledger-mirror-missing'
            : !ledgerDir ? (remoteDir ? 'remote-parent-ledger-missing' : 'parent-ledger-missing')
          : childBindingMismatch ? 'parent-child-binding-mismatch'
            : childRunId === null ? 'parent-child-binding-missing'
            : childEntries === null ? (remoteDir ? 'remote-child-ledger-missing' : 'child-ledger-missing') : 'child-ledger-error-tail-missing',
        lastLines,
        lastLinesMissing: lastLines ? null : !card.runId ? 'run-id-missing'
          : !exit ? 'run-exit-missing' : 'run-exit-last-lines-missing',
      },
    };
  });
  const reasonTally = new Map<string, number>();
  for (const row of rows) {
    if (row.reason === null) continue;
    reasonTally.set(row.reason, (reasonTally.get(row.reason) ?? 0) + 1);
  }
  const reasons = [...reasonTally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const failedCardRows = rows.filter((row) => row.terminalKind === 'card'
    && (row.cardStatus === 'failed' || row.cardStatus === 'launch-failed'));
  const missingReason = failedCardRows.filter((row) => row.reason === null).length;
  const warnings = [
    limitReached ? `사건 조회 상한 ${limit} 도달 — 창 안 ${visible.length}행 중 ${rows.length}행만 셌다(집계도 이 행들만 센다)` : null,
    missingReason > 0 ? `실패 카드 종결 사유 원문 없음 — ${missingReason}/${failedCardRows.length}행(증거 부재 이유는 행별 evidence 참조)` : null,
    undatedCards > 0 ? `종결 시각 미보존 ${undatedCards}장 — 기간 귀속 불가(창 밖 카드 포함)` : null,
  ].filter((line): line is string => line !== null);
  return {
    rows,
    aggregate: { cards: new Set(rows.map((row) => row.card)).size,
      cardTerminals: rows.filter((row) => row.terminalKind === 'card').length,
      prTerminals: rows.filter((row) => row.terminalKind === 'pr').length,
      failedCardTerminals: failedCardRows.length, reasons, missingReason },
    limitReached,
    stopReason: limitReached ? 'page-limit' : null,
    childLedgerObserved,
    reasonObserved,
    undatedCards,
    undatedPeriodAttribution: 'unknown',
    overlapCardIds,
    openCards,
    ...(warnings.length ? { warning: warnings.join(' · ') } : {}),
  };
}

type DoctorTruth = true | false | 'unknown';
type DoctorCondition = { value: DoctorTruth; source: string; detail: string };
type DoctorPr = { number: number; state: string | null; draft: boolean | null; head: string | null; changedFiles: number | null };

export interface TaskDoctorReport {
  card: string;
  cell: string | null;
  version: string;
  runId: string | null;
  childRunId: string | null;
  host: string | null;
  head: string | null;
  terminalReason: string | null;
  terminalReasonSource: string | null;
  lastGate: { passed: boolean | null; status: string | null; head: string | null; at: string | null; source: string } | null;
  pr: DoctorPr | null;
  conditions: { currentYellowUnheldNoOtherPr: DoctorCondition; noPreservedImplementation: DoctorCondition;
    environmentFailure: DoctorCondition; failureRoundsBelowTwo: DoctorCondition };
  unknownSources: string[];
  nextAction: 'relaunch' | 'harvest' | 'reauthor' | 'human';
}

function doctorCondition(value: DoctorTruth, source: string, detail: string): DoctorCondition { return { value, source, detail }; }
function doctorObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function doctorString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function doctorTerminal(entry: import('../self-implement/run-ledger.js').RunLedgerEntry): boolean {
  if (entry.event === 'stop') return true;
  if (entry.event === 'run-status') return ['failed', 'completed', 'cancelled', 'parked'].includes(String(entry.data.runStatus));
  return entry.event === 'terminal' && (typeof entry.data.ok === 'boolean' || typeof entry.data.terminal === 'string');
}
function doctorTerminalFailed(entry: import('../self-implement/run-ledger.js').RunLedgerEntry): boolean {
  if (entry.event === 'stop') return true;
  if (entry.event === 'run-status') return entry.data.runStatus === 'failed';
  return entry.data.ok === false || ['failed', 'aborted', 'gate-failed', 'review-blocked', 'timed-out'].includes(String(entry.data.terminal));
}
function defaultDoctorLedger(runId: string, statePath: string): import('../self-implement/run-ledger.js').RunLedgerEntry[] | null {
  let found: import('../self-implement/run-ledger.js').RunLedgerEntry[] | null = null;
  for (const dir of implementLedgerDirectories(statePath, false)) {
    const loaded = loadRunLedgerWithMetadata(runId, dir);
    if (!loaded) continue;
    if (loaded.skippedTrailingBytes) throw new Error(`incomplete run ledger: ${runId}`);
    if (found && JSON.stringify(found) !== JSON.stringify(loaded.entries)) throw new Error(`conflicting run ledgers: ${runId}`);
    found = loaded.entries;
  }
  return found;
}

/** Read-only relaunch preflight. Each decision names its evidence, and a missing adapter remains unknown. */
export function readTaskDoctor(target: string, opts: { traffic?: string } = {}, deps: TasksCliDeps = {}): TaskDoctorReport {
  const statePath = deps.taskStatePath ?? taskStatePathDefault();
  const state = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath);
  const cards = Object.values(state.tasks ?? {});
  const matches = cards.filter((item) => item?.id === target || item?.runId === target || item?.runChildId === target);
  if (matches.length !== 1) throw new Error(matches.length ? `카드 결속 모호: ${target}` : `카드·런 없음: ${target}`);
  const card = matches[0]!;
  const version = (deps.doctorVersion ?? checklistDevVersion)();
  const cell = card.checklistId ?? null;
  const run = deps.doctorRun ?? ((command: string, args: string[]) => spawnSync(command, args,
    { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }));

  let yellow: DoctorCondition = doctorCondition('unknown', 'checklist', '카드의 칸을 모른다');
  if (cell) {
    try {
      const snapshot = (deps.doctorChecklist ?? listChecklist)(version);
      const item = snapshot.items.find((entry) => entry.id === cell);
      const versionMatches = !card.checklistVersion || card.checklistVersion === version;
      yellow = doctorCondition(item ? item.status === 'yellow' && versionMatches : false, `checklist:${version}:${cell}`,
        item ? `status=${item.status}${versionMatches ? '' : `, cardVersion=${card.checklistVersion}`}` : '현재 판에 칸 없음');
    } catch { yellow = doctorCondition('unknown', `checklist:${version}:${cell}`, '체크리스트 조회 실패'); }
  }
  let unheld: DoctorCondition = doctorCondition('unknown', 'traffic', 'traffic 경로 없음 (--traffic 필요)');
  if (opts.traffic) {
    try {
      const traffic = doctorObject(JSON.parse(readFileSync(opts.traffic, 'utf8')));
      const holds = traffic?.hold;
      unheld = Array.isArray(holds) && holds.every((id) => typeof id === 'string') && cell
        ? doctorCondition(!holds.includes(cell), `traffic:${opts.traffic}`, holds.includes(cell) ? 'hold 활성' : 'hold 없음')
        : doctorCondition('unknown', `traffic:${opts.traffic}`, 'hold 배열 또는 칸 결속 불명');
    } catch { unheld = doctorCondition('unknown', `traffic:${opts.traffic}`, 'traffic 읽기 실패'); }
  }
  let noOtherPr: DoctorCondition = doctorCondition('unknown', 'gh:open-pr-list', '열린 PR 조회 실패');
  try {
    const result = run('gh', ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body']);
    if (result.status === 0) {
      const rows: unknown = JSON.parse(result.stdout);
      if (Array.isArray(rows) && rows.length < 500 && rows.every((row) =>
        Number.isSafeInteger(doctorObject(row)?.number) && typeof doctorObject(row)?.body === 'string')) {
        const conflicts = rows.filter((row) => {
          const pr = doctorObject(row)!;
          return cellIdFromBody(pr.body as string) === cell && pr.number !== cardPrNumber(card);
        }).map((row) => doctorObject(row)!.number as number);
        noOtherPr = doctorCondition(conflicts.length === 0, 'gh:open-pr-list:cell-marker',
          conflicts.length ? `다른 열린 PR: ${conflicts.map((id) => `#${id}`).join(',')}` : '같은 칸의 다른 열린 PR 없음');
      } else noOtherPr = doctorCondition('unknown', 'gh:open-pr-list', 'PR 목록 형식 불명 또는 500건 상한');
    }
  } catch { /* unknown stays explicit */ }
  const firstParts = [yellow, unheld, noOtherPr];
  const firstValue: DoctorTruth = firstParts.some((part) => part.value === 'unknown') ? 'unknown'
    : firstParts.every((part) => part.value === true);
  const currentYellowUnheldNoOtherPr = doctorCondition(firstValue,
    firstParts.map((part) => part.source).join(' + '), firstParts.map((part) => part.detail).join('; '));

  const prNumber = cardPrNumber(card);
  let pr: DoctorPr | null = prNumber === undefined ? null
    : { number: prNumber, state: null, draft: null, head: null, changedFiles: null };
  let prFiles: Array<{ path: string; additions: number; deletions: number }> | null = null;
  let prSource = 'gh:bound-pr';
  if (prNumber !== undefined) {
    try {
      const result = run('gh', ['pr', 'view', String(prNumber), '--json', 'number,state,isDraft,headRefOid,changedFiles,files']);
      if (result.status === 0) {
        const view = doctorObject(JSON.parse(result.stdout));
        const files = view?.files;
        const changedFiles = view?.changedFiles;
        if (view?.number === prNumber && typeof view.state === 'string' && typeof view.isDraft === 'boolean'
          && Number.isSafeInteger(changedFiles) && (changedFiles as number) >= 0 && Array.isArray(files)
          && files.every((file) => typeof doctorObject(file)?.path === 'string'
            && Number.isSafeInteger(doctorObject(file)?.additions) && Number.isSafeInteger(doctorObject(file)?.deletions))) {
          pr = { number: prNumber, state: view.state, draft: view.isDraft,
            head: doctorString(view.headRefOid), changedFiles: changedFiles as number };
          prFiles = files.map((file) => doctorObject(file) as { path: string; additions: number; deletions: number });
        } else prSource = 'gh:bound-pr:malformed';
      } else prSource = 'gh:bound-pr:unreadable';
    } catch { prSource = 'gh:bound-pr:unreadable'; }
  } else prSource = 'card:pr-unbound';
  let noPreservedImplementation = doctorCondition('unknown', prSource, 'PR diff를 못 읽었다');
  if (pr && prFiles && pr.changedFiles === prFiles.length) {
    const docsOnly = prFiles.length > 0 && prFiles.every((file) => /(?:^|\/)[^/]+\.md$/i.test(file.path));
    const empty = pr.changedFiles === 0;
    noPreservedImplementation = doctorCondition(empty || docsOnly, `gh:pr-${pr.number}:files`,
      empty ? 'diff 0' : docsOnly ? 'docs-only diff' : '보존할 구현 diff 있음');
  } else if (pr && prFiles) noPreservedImplementation = doctorCondition('unknown', `gh:pr-${pr.number}:files`, 'changedFiles와 파일 목록 수 불일치');

  const ledgerId = card.runChildId;
  let entries: import('../self-implement/run-ledger.js').RunLedgerEntry[] | null = null;
  let ledgerSource = ledgerId ? `run-ledger:${ledgerId}` : 'card:child-run-unbound';
  if (ledgerId) {
    try { entries = (deps.doctorLedger ?? defaultDoctorLedger)(ledgerId, statePath); }
    catch { ledgerSource += ':unreadable'; }
  }
  let parentEntries: import('../self-implement/run-ledger.js').RunLedgerEntry[] | null = null;
  let parentLedgerSource = card.runId ? `run-ledger:${card.runId}` : 'card:parent-run-unbound';
  if (card.runId) {
    try { parentEntries = (deps.doctorLedger ?? defaultDoctorLedger)(card.runId, statePath); }
    catch { parentLedgerSource += ':unreadable'; }
  }
  const terminal = entries?.slice().reverse().find(doctorTerminal);
  const terminalData = doctorObject(terminal?.data);
  const parentTerminal = parentEntries?.slice().reverse().find(doctorTerminal);
  const parentData = doctorObject(parentTerminal?.data);
  const parentChildEvidence = doctorObject(parentData?.childEvidence);
  const prFailure = doctorObject(terminalData?.prFailure);
  const childTerminalReason = doctorString(terminalData?.terminationReason) ?? doctorString(terminalData?.cause)
    ?? doctorString(terminalData?.reason) ?? doctorString(terminalData?.error)
    ?? doctorString(prFailure?.errorTail);
  const childReasonSource = childTerminalReason ? `${ledgerSource}:${terminal?.event}` : null;
  const parentTerminalReason = doctorString(parentData?.terminationReason) ?? doctorString(parentData?.cause)
    ?? doctorString(parentData?.reason) ?? doctorString(parentChildEvidence?.terminationReason)
    ?? doctorString(parentChildEvidence?.error) ?? null;
  const cardTerminal = card.history?.slice().reverse().find((item) =>
    (item.event === 'failed' || item.event === 'launch-failed') && (!item.runId || item.runId === card.runId));
  const terminalReason = childTerminalReason ?? parentTerminalReason ?? doctorString(cardTerminal?.detail);
  const reauthorPattern = /scope[- ]escape|UNCONVERGEABLE|goal[- ]revision[- ]required/i;
  const environmentPattern = /worktree add.{0,100}(?:timed? ?out|timeout)|(?:timed? ?out|timeout).{0,100}worktree add|model catalog.{0,100}unknown|unknown.{0,100}model catalog|stale pod image|pod image.{0,100}stale/i;
  const childEvidence = doctorObject(terminalData?.childEvidence);
  const structuredReauthorSource = terminalData?.scopeEscape === true ? `${ledgerSource}:${terminal?.event}:scopeEscape`
    : childEvidence?.scopeEscape === true ? `${ledgerSource}:${terminal?.event}:childEvidence.scopeEscape`
      : reauthorPattern.test(doctorString(terminalData?.supervisorVerdict) ?? '')
        ? `${ledgerSource}:${terminal?.event}:supervisorVerdict`
        : parentData?.scopeEscape === true ? `${parentLedgerSource}:${parentTerminal?.event}:scopeEscape`
          : parentChildEvidence?.scopeEscape === true ? `${parentLedgerSource}:${parentTerminal?.event}:childEvidence.scopeEscape`
            : reauthorPattern.test(doctorString(parentChildEvidence?.supervisorVerdict) ?? '')
              ? `${parentLedgerSource}:${parentTerminal?.event}:childEvidence.supervisorVerdict` : null;
  const structuredReauthor = structuredReauthorSource !== null;
  const scopeSignals = [terminalData?.scopeEscape, childEvidence?.scopeEscape,
    parentData?.scopeEscape, parentChildEvidence?.scopeEscape].filter((value): value is boolean => typeof value === 'boolean');
  const scopeSignalConflict = scopeSignals.includes(true) && scopeSignals.includes(false);
  let environmentFailure = doctorCondition('unknown', ledgerSource, '자식 종결 원장 또는 원문 없음');
  if (!terminal) environmentFailure = doctorCondition('unknown', ledgerSource, '자식 종결 원장 결손');
  else if (!parentTerminal) environmentFailure = doctorCondition('unknown', parentLedgerSource,
    '부모 종결 원장 결손·충돌 — scopeEscape 재확인 불가');
  else if (!doctorTerminalFailed(parentTerminal)) environmentFailure = doctorCondition('unknown',
    `${parentLedgerSource}:${parentTerminal.event}`, '부모 런이 실패로 종결되지 않음');
  else if (childTerminalReason && parentTerminalReason
    && !parentTerminalReason.includes(childTerminalReason) && !childTerminalReason.includes(parentTerminalReason)) {
    environmentFailure = doctorCondition('unknown', `${ledgerSource} + ${parentLedgerSource}`,
      '부모·자식 종결 사유 불일치');
  } else if (scopeSignalConflict) environmentFailure = doctorCondition('unknown', `${ledgerSource} + ${parentLedgerSource}`,
    '부모·자식 scopeEscape 신호 불일치');
  else if (structuredReauthor) environmentFailure = doctorCondition(false, structuredReauthorSource!, '구조화된 재저작 신호');
  else if (childTerminalReason) environmentFailure = doctorCondition(
    !doctorTerminalFailed(terminal) || reauthorPattern.test(childTerminalReason) ? false : environmentPattern.test(childTerminalReason),
    childReasonSource ?? ledgerSource,
    !doctorTerminalFailed(terminal) ? '자식 런이 실패로 종결되지 않음' : reauthorPattern.test(childTerminalReason)
      ? '골 재저작 필요' : environmentPattern.test(childTerminalReason) ? '허용된 환경 실패' : '허용된 환경 실패 아님');
  if (card.status !== 'failed' && card.status !== 'launch-failed') environmentFailure = doctorCondition(false,
    `card:${card.id}:status`, `현재 카드 status=${card.status} — 재발사 대상 실패 카드 아님`);
  if (pr?.state === 'MERGED') environmentFailure = doctorCondition(false,
    `gh:pr-${pr.number}:state`, '결속 PR이 이미 병합됨');

  const roundCards = cell ? cards.filter((item) => item?.checklistId === cell) : [];
  const knownFailureRuns = new Set<string>();
  let unboundFailureCards = 0;
  let ambiguousRounds = false;
  for (const item of roundCards) {
    const failures = (item.history ?? []).filter((entry) => entry.event === 'failed' || entry.event === 'launch-failed');
    const itemRuns = new Set(failures.map((entry) => doctorString(entry.runId)).filter((id): id is string => id !== null));
    const statusFailed = item.status === 'failed' || item.status === 'launch-failed';
    if (statusFailed && item.runId) itemRuns.add(item.runId);
    for (const id of itemRuns) knownFailureRuns.add(id);
    const unbound = failures.some((entry) => !doctorString(entry.runId));
    if (unbound && itemRuns.size) ambiguousRounds = true;
    else if (!itemRuns.size && (unbound || statusFailed)) unboundFailureCards++;
  }
  const failureRounds = knownFailureRuns.size + unboundFailureCards;
  const failureRoundsBelowTwo = doctorCondition(cell && !ambiguousRounds ? failureRounds < 2 : 'unknown',
    'card-status+history:same-cell-failures', !cell ? '같은 칸 실패 이력 불명'
      : ambiguousRounds ? 'runId 없는 실패 사건과 결속된 런이 섞여 라운드 중복 불명' : `실패 라운드 ${failureRounds}`);
  const lastRegate = card.regates?.at(-1);
  const childGate = entries?.slice().reverse().find((entry) => entry.event === 'gated');
  const useRegate = lastRegate && (!childGate || Date.parse(lastRegate.at) >= Date.parse(childGate.timestamp ?? ''));
  const lastGate = useRegate && lastRegate ? { passed: lastRegate.passed ?? null, status: lastRegate.status ?? null,
    head: lastRegate.head, at: lastRegate.at, source: 'card:regates' }
    : childGate ? { passed: typeof childGate.data.passed === 'boolean' ? childGate.data.passed : null,
      status: childGate.data.gateExecuted === false ? 'skipped' : 'executed',
      head: doctorString(childGate.data.head),
      at: childGate.timestamp ?? null, source: `${ledgerSource}:gated` } : null;
  const conditions = { currentYellowUnheldNoOtherPr, noPreservedImplementation, environmentFailure, failureRoundsBelowTwo };
  const unknownSources = Object.entries(conditions).filter(([, part]) => part.value === 'unknown')
    .map(([name, part]) => `${name}:${part.source}`);
  const nextAction = unknownSources.length ? 'human'
    : structuredReauthor || (terminalReason && reauthorPattern.test(terminalReason)) || failureRoundsBelowTwo.value === false
      ? 'reauthor' : noPreservedImplementation.value === false ? 'harvest'
        : Object.values(conditions).every((part) => part.value === true) ? 'relaunch' : 'human';
  return { card: card.id, cell, version, runId: card.runId ?? null, childRunId: card.runChildId ?? null,
    host: card.parentHost?.host ?? null, head: pr?.head ?? lastRegate?.head ?? card.adoptedPr?.head ?? card.prTerminal?.head ?? null,
    terminalReason, terminalReasonSource: childReasonSource
      ?? (parentTerminalReason && parentTerminal ? `run-ledger:${card.runId}:${parentTerminal.event}`
        : cardTerminal ? `card-history:${cardTerminal.event}` : null),
    lastGate, pr, conditions, unknownSources, nextAction };
}

/** MODEL-SIZE-OUTCOME-MEASURE — `tasks outcomes --by` 가 아는 집계 축. */
export const TASK_OUTCOME_BY_DIMENSIONS = ['model', 'size'] as const;

/** 못 읽은 값의 이름 — 0 이나 빈 문자열로 지어내지 않는다. */
export const TASK_OUTCOME_UNKNOWN = 'unknown';

/** 카드 하나의 결과 — PR 착지 · 범위 이탈 · 수렴 실패 · 결과 줄 없음. */
export type TaskOutcomeModelSizeResult = 'landed' | 'scope-escape' | 'convergence-failure' | 'no-result-line';

/** 카드 하나의 측정 줄 — 자식 모델 · 등급 · 조각 크기(대상 경로 수 · 바꿀 동작 수) · 결과. */
export interface TaskOutcomeModelSizeCard {
  card: string;
  /** `provider/model`(카드 childLlm) · 못 읽으면 `unknown`. */
  model: string;
  /** 디스패처 난이도(하|중|상|특) · 못 읽으면 `unknown`. */
  tier: string;
  size: { targetPaths: number | typeof TASK_OUTCOME_UNKNOWN; behaviors: number | typeof TASK_OUTCOME_UNKNOWN };
  result: TaskOutcomeModelSizeResult;
}

/** 모델×크기 칸 하나 — 성공률 · 표본 수 · unknown 수. */
export interface TaskOutcomeModelSizeCell {
  model: string;
  /** 크기 칸 이름(`paths=<n>·behaviors=<n>`) · 못 읽은 칸은 `unknown`. */
  size: string;
  samples: number;
  landed: number;
  /** landed / samples. */
  successRate: number | null;
  /** 이 칸에서 한 축이라도 못 읽은 카드 수. */
  unknown: number;
  results: Record<TaskOutcomeModelSizeResult, number>;
}

export interface TaskOutcomeModelSizeReport {
  dimensions: readonly ['model', 'size'];
  cells: TaskOutcomeModelSizeCell[];
  cards: TaskOutcomeModelSizeCard[];
  /** 축별 «못 읽음» 수 — 카드 합계가 아니라 축마다 센다(한 카드가 둘을 못 읽을 수 있다). */
  unknown: { model: number; tier: number; size: number };
  samples: number;
  limitReached: boolean;
}

const OUTCOME_MODEL_SIZE_RESULTS: readonly TaskOutcomeModelSizeResult[] = ['landed', 'scope-escape', 'convergence-failure', 'no-result-line'];

/** `--by` 인자 — 지금은 `model,size` 하나뿐이다(순서 무관 · 그 밖은 거부). */
function parseOutcomeDimensions(value: string | undefined): readonly ['model', 'size'] | undefined {
  if (value === undefined) return undefined;
  const parts = [...new Set(value.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean))];
  if (parts.length !== TASK_OUTCOME_BY_DIMENSIONS.length || !TASK_OUTCOME_BY_DIMENSIONS.every((dimension) => parts.includes(dimension))) {
    throw new Error(`--by 는 ${TASK_OUTCOME_BY_DIMENSIONS.join(',')} 다(모델×조각 크기): ${value}`);
  }
  return ['model', 'size'];
}

/** 카드 문면의 «바꿀 동작 수» — `바꿀` 선언 줄 ⊕ 그 아래 항목. 선언이 없으면 null(0 으로 지어내지 않는다). */
function declaredChangeCount(text: string): number | null {
  let declared = 0;
  let explicitlyNone = false;
  let insideChangeList = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^바꿀(?:\s|:|것|동작)/.test(trimmed)) {
      const at = trimmed.indexOf(':');
      const inline = at < 0 ? '' : trimmed.slice(at + 1).trim();
      if (/^바꿀\s*(?:것|동작)?\s*:?[\s]*(?:없음|없다)$/u.test(trimmed)) {
        explicitlyNone = true;
        insideChangeList = false;
        continue;
      }
      // «바꿀 것: 하나» 처럼 한 줄에 적었으면 그 줄이 한 동작이고, 목록이 뒤따르지 않는다.
      // «바꿀 것: 다음» 처럼 목록을 가리키는 선언은 그 줄이 동작이 아니고, 뒤따르는 목록을 센다.
      insideChangeList = inline.length === 0 || /^다음[.!?]?$/.test(inline);
      if (!insideChangeList) declared++;
      continue;
    }
    if (!insideChangeList) continue;
    if (/^[-*·]\s+\S/.test(trimmed)) { declared++; continue; }
    if (trimmed.length > 0) insideChangeList = false;
  }
  return declared > 0 ? declared : explicitlyNone ? 0 : null;
}

/** 조각 크기 — 대상 경로 수(카드가 적은 목록) ⊕ 바꿀 동작 수(문면의 바꿀 선언). */
function outcomeCardSize(card: TaskCard | undefined): TaskOutcomeModelSizeCard['size'] {
  const targetPaths = Array.isArray(card?.targetPaths) ? card.targetPaths.length : TASK_OUTCOME_UNKNOWN;
  const behaviors = card && typeof card.text === 'string' ? declaredChangeCount(card.text) ?? TASK_OUTCOME_UNKNOWN : TASK_OUTCOME_UNKNOWN;
  return { targetPaths, behaviors };
}

function outcomeCardModel(card: TaskCard | undefined): string {
  const llm = card?.childLlm;
  if (!llm || typeof llm.provider !== 'string' || !llm.provider || typeof llm.model !== 'string' || !llm.model) return TASK_OUTCOME_UNKNOWN;
  return `${llm.provider}/${llm.model}`;
}

function outcomeCardTier(card: TaskCard | undefined): string {
  const tier = card?.tier;
  return tier === '하' || tier === '중' || tier === '상' || tier === '특' ? tier : TASK_OUTCOME_UNKNOWN;
}

/**
 * 결과 판정 — 카드 원장에 있는 사실만 쓴다(문면 추측 없음).
 * ① 실제 실행·성공한 손 범위 자르기 hand-move(trim-scope)가 있으면 «범위 이탈» — 실행·성공 값이
 *    없거나 false인 조정 · post-land partial(남은 작업)만으로는 범위 이탈이 아니다.
 * ② PR MERGED 종결 증거(row.pr ⊕ 원장 prTerminal) 또는 손 착지 종결 기록(closed-by-hand)이 있으면 «PR 착지» —
 *    카드 상태(landed·done)만으로는 착지로 단정하지 않는다.
 * ③ 실패 종결 줄이 있으면 «수렴 실패» ④ 그 밖은 «결과 줄 없음».
 */
function classifyOutcomeResult(card: TaskCard | undefined, row: TaskOutcomeRow): TaskOutcomeModelSizeResult {
  if ((card?.history ?? []).some((item) => item.event === HAND_MOVE_HISTORY_EVENT && item.kind === 'trim-scope'
    && item.executed === true && item.ok === true)) return 'scope-escape';
  const terminal = card ? boundPrTerminal(card) : undefined;
  const landedByHand = row.cardStatus === 'landed-by-hand'
    && (card?.history ?? []).some((item) => item.event === CLOSED_BY_HAND_EVENT);
  if (row.pr?.state === 'MERGED' || terminal?.state === 'MERGED' || landedByHand) return 'landed';
  const terminalLine = card ? outcomeTerminalHistoryLine(card) : undefined;
  if (terminalLine?.event === 'failed' || terminalLine?.event === 'launch-failed') return 'convergence-failure';
  if (row.cardStatus === 'failed' || row.cardStatus === 'launch-failed') return 'convergence-failure';
  return 'no-result-line';
}

/**
 * MODEL-SIZE-OUTCOME-MEASURE — `tasks outcomes --by model,size`(읽기 전용).
 * 창 안에서 «끝난» 카드(readTaskOutcomes 와 같은 판정)를 모델×조각 크기 칸으로 묶어 성공률·표본 수·unknown 수를 낸다.
 * `report` 와 `snapshot` 을 함께 주면 같은 원장 시점으로 창·크기·결과를 센다.
 */
export function readTaskOutcomeModelSize(
  window: { sinceMs?: number; untilMs?: number } = {},
  deps: Pick<TasksCliDeps, 'taskStatePath' | 'outcomesLimit'> = {},
  report?: Omit<TaskOutcomeReport, 'since' | 'until'>,
  snapshot?: Record<string, TaskCard>,
): TaskOutcomeModelSizeReport {
  const cards = snapshot ?? readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {};
  const observed = report ?? readTaskOutcomes(window, deps, cards);
  const unknown = { model: 0, tier: 0, size: 0 };
  const cells = new Map<string, TaskOutcomeModelSizeCell>();
  // 종단 사건 행은 카드·PR로 둘일 수 있어도 모델×크기 표본은 카드 한 장이다.
  const seenCards = new Set<string>();
  const rows = observed.rows.filter((row) => {
    if (seenCards.has(row.card)) return false;
    seenCards.add(row.card);
    return true;
  }).map((row): TaskOutcomeModelSizeCard => {
    const card = cards[row.card];
    const model = outcomeCardModel(card);
    const tier = outcomeCardTier(card);
    const size = outcomeCardSize(card);
    const result = classifyOutcomeResult(card, row);
    if (model === TASK_OUTCOME_UNKNOWN) unknown.model++;
    if (tier === TASK_OUTCOME_UNKNOWN) unknown.tier++;
    const sizeKey = size.targetPaths === TASK_OUTCOME_UNKNOWN || size.behaviors === TASK_OUTCOME_UNKNOWN
      ? TASK_OUTCOME_UNKNOWN : `paths=${size.targetPaths}·behaviors=${size.behaviors}`;
    if (sizeKey === TASK_OUTCOME_UNKNOWN) unknown.size++;
    // Cell unknown belongs to its two grouping axes; tier is reported separately per card and in unknown.tier.
    const unresolved = model === TASK_OUTCOME_UNKNOWN || sizeKey === TASK_OUTCOME_UNKNOWN;
    const key = `${model}\u0000${sizeKey}`;
    const cell = cells.get(key) ?? { model, size: sizeKey, samples: 0, landed: 0, successRate: null, unknown: 0,
      results: Object.fromEntries(OUTCOME_MODEL_SIZE_RESULTS.map((name) => [name, 0])) as Record<TaskOutcomeModelSizeResult, number> };
    cell.samples++;
    if (result === 'landed') cell.landed++;
    if (unresolved) cell.unknown++;
    cell.results[result]++;
    cell.successRate = cell.landed / cell.samples;
    cells.set(key, cell);
    return { card: row.card, model, tier, size, result };
  });
  return {
    dimensions: ['model', 'size'],
    cells: [...cells.values()].sort((a, b) => a.model.localeCompare(b.model) || a.size.localeCompare(b.size)),
    cards: rows,
    unknown,
    samples: rows.length,
    limitReached: observed.limitReached,
  };
}

export function registerTasksCommands(program: Command, deps: TasksCliDeps = {}): void {
  const ctx = createTasksCliContext(deps);
  const { out, authenticate } = ctx;
  const tasks = registerTasksRoot(program);

  tasks.command('work-order').description('TASK-AGENT 작업 지시서')
    .command('build')
    .description('체크리스트 칸으로 작업 지시서를 만들어 파일에 쓴다')
    .requiredOption('--checklist <cellId>', '체크리스트 칸 id')
    .requiredOption('--version <version>', '체크리스트 판')
    .requiredOption('--out <path>', '작업 지시서 출력 파일')
    .action((opts: { checklist: string; version: string; out: string }) => {
      try {
        validateVersion(opts.version);
        const item = (deps.workOrderChecklist ?? listChecklist)(opts.version).items.find((cell) => cell.id === opts.checklist);
        if (!item) throw new Error(`체크리스트 칸 없음: ${opts.checklist}`);
        const targets = /^대상 경로:[ \t]*(.*)$/.exec(item.title.split(/\r?\n/, 1)[0]!)?.[1]?.split(' · ').map((path) => path.trim()).filter(Boolean) ?? [];
        const missing = targets.filter((path) => !existsSync(resolve(process.cwd(), path)));
        const boundary = [
          ...(targets.length ? [`대상 경로: ${targets.join(' · ')}`] : []),
          ...(missing.length ? [`boundary.missing: ${missing.join(' · ')}`] : []),
        ].join('\n');
        const order = buildWorkOrder({
          cellId: item.id,
          version: opts.version,
          priority: item.priority,
          boundary: boundary || undefined,
        });
        mkdirSync(dirname(opts.out), { recursive: true });
        writeFileSync(opts.out, `${JSON.stringify(order, null, 2)}\n`);
        out(opts.out);
      } catch (error) {
        out(error instanceof Error ? error.message : '작업 지시서 작성 실패');
        process.exitCode = 1;
      }
    });

  tasks.command('green-sweep')
    .description('병합된 과제 PR·칸 근거를 대조한다 (기본 dry-run, --apply 는 검증된 한 칸만 기록)')
    .requiredOption('--version <version>', '조회할 체크리스트 판')
    .option('--cell <id>', '한 칸만 조회')
    .option('--traffic <path>', '실물 green 판정에는 traffic.json 필수 — 빠지거나 못 읽으면 hold 불명으로 보수 판정')
    .option('--apply', '최신 clean main 에서 완료 경계 시험까지 통과한 한 칸만 green 으로 기록')
    .option('--json', 'JSON 출력')
    .action((opts: { version: string; cell?: string; traffic?: string; apply?: boolean; json?: boolean }) => {
      try {
        validateVersion(opts.version);
        if (opts.apply && !opts.cell) throw new Error('--apply 는 단일 --cell 과 함께 써야 한다');
        const snapshot = (deps.greenSweepChecklist ?? listChecklist)(opts.version);
        const run = deps.greenSweepRun ?? ((command: string, args: string[]) => spawnSync(command, args,
          { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 }));
        const cards = Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {});
        let holds: Set<string> | null = null;
        let holdDiagnostic: string | undefined;
        if (opts.traffic) {
          try {
            const traffic: unknown = JSON.parse(readFileSync(opts.traffic, 'utf8'));
            if (traffic && typeof traffic === 'object' && !Array.isArray(traffic)
              && Array.isArray((traffic as { hold?: unknown }).hold)
              && (traffic as { hold: unknown[] }).hold.every((id) => typeof id === 'string'))
              holds = new Set((traffic as { hold: string[] }).hold);
            else holdDiagnostic = `invalid-traffic-shape: ${opts.traffic} must contain hold: string[]`;
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code : error instanceof SyntaxError ? 'invalid-json' : 'read-error';
            holdDiagnostic = `${code}: ${opts.traffic}`;
          }
        } else holdDiagnostic = 'traffic-path-not-provided: pass --traffic ~/elanous-hq/seat-state/OP/traffic.json';
        const prCache = new Map<number, GreenSweepPr | null>();
        const ambiguousPrs = ambiguousGreenSweepPrs(snapshot.items, opts.version, cards);
        const origin = run('git', ['remote', 'get-url', 'origin']);
        const originRepo = origin.status === 0
          ? /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(origin.stdout.trim())?.[1]?.toLowerCase() : undefined;
        const localMain = run('git', ['rev-parse', 'origin/main']);
        const remoteMain = run('git', ['ls-remote', 'origin', 'refs/heads/main']);
        const localMainSha = localMain.status === 0 ? localMain.stdout.trim() : '';
        const remoteMainSha = remoteMain.status === 0 ? remoteMain.stdout.trim().split(/\s+/)[0] : '';
        const mainFresh = /^[a-f0-9]{40}$/i.test(localMainSha) && localMainSha === remoteMainSha;
        let currentMainClean = false;
        if (opts.apply && mainFresh) {
          const head = run('git', ['rev-parse', 'HEAD']);
          const status = run('git', ['status', '--porcelain', '--untracked-files=all']);
          currentMainClean = head.status === 0 && head.stdout.trim() === remoteMainSha
            && status.status === 0 && status.stdout.trim() === '';
        }
        if (opts.cell && !snapshot.items.some((item) => item.id === opts.cell)) throw new Error(`없는 칸: ${opts.cell}`);
        const decisions = snapshot.items.filter((item) => !opts.cell || item.id === opts.cell).flatMap((item) => {
          const candidates = greenSweepCandidates(item, opts.version, cards);
          return candidates.map((candidate) => {
            let pr = prCache.get(candidate.pr);
            if (pr === undefined) {
              const view = run('gh', ['pr', 'view', String(candidate.pr), '--json', 'number,state,mergeCommit,url']);
              try {
                if (view.status !== 0) throw new Error('gh failed');
                const parsed = JSON.parse(view.stdout) as { number?: number; state?: string; mergeCommit?: { oid?: string }; url?: string };
                pr = parsed.number === candidate.pr && typeof parsed.state === 'string'
                  ? { number: candidate.pr, state: parsed.state, mergeSha: parsed.mergeCommit?.oid, url: parsed.url } : null;
              } catch { pr = null; }
              prCache.set(candidate.pr, pr);
            }
            // A component PR stays CLOSED after a merged train. Reverify the integration PR
            // recorded on the card before using its merge commit as landing evidence.
            let landingPr = pr;
            const train = candidate.card?.trainLanding;
            if (pr?.state === 'CLOSED' && train?.componentPr === candidate.pr && /^[a-f0-9]{40}$/i.test(train.mergeSha)) {
              const view = run('gh', ['pr', 'view', String(train.integrationPr), '--json', 'number,state,mergeCommit']);
              try {
                if (view.status === 0) {
                  const parsed = JSON.parse(view.stdout) as { number?: number; state?: string; mergeCommit?: { oid?: string } };
                  if (parsed.number === train.integrationPr && parsed.state === 'MERGED'
                    && parsed.mergeCommit?.oid?.toLowerCase() === train.mergeSha.toLowerCase()) {
                    landingPr = { ...pr, state: 'MERGED', mergeSha: train.mergeSha, viaTrain: { integrationPr: train.integrationPr } };
                  }
                }
              } catch { /* Unverified train is still a CLOSED component PR. */ }
            }
            const sha = landingPr?.mergeSha;
            const prRepo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:\/|$)/i.exec(pr?.url ?? '')?.[1]?.toLowerCase();
            const repositoryMatches = originRepo && prRepo ? originRepo === prRepo : null;
            const ancestor = !mainFresh || !sha || !/^[a-f0-9]{40}$/i.test(sha) ? null : (() => {
              const check = run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
              return check.status === 0 ? true : check.status === 1 ? false : null;
            })();
            const decision = decideGreenSweep({ item, candidate, candidateCount: candidates.length,
              pr: landingPr ?? null, ancestor, hold: holds === null ? null : holds.has(item.id), holdDiagnostic, repositoryMatches,
              ambiguousAcrossCells: ambiguousPrs.has(candidate.pr) });
            observeGreenSweep(decision);
            return decision;
          });
        });
        const counts = { candidate: decisions.length, green: decisions.filter((d) => d.verdict === 'green').length,
          recordOnly: decisions.filter((d) => d.verdict === 'record-only').length,
          skipped: decisions.filter((d) => d.verdict === 'skip').length };
        let writes: Array<{ cell: string; written: boolean; reason?: string }> = [];
        let e2Failure: string | undefined;
        if (opts.apply) {
          const passed = new Set<string>();
          if (currentMainClean) {
            const evidenceRun = deps.greenSweepEvidenceRun ?? ((args: string[]) => {
              const result = spawnSync('bun', ['test', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
              return { status: result.status, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
            });
            const item = snapshot.items.find((entry) => entry.id === opts.cell);
            const args = item ? greenSweepEvidenceTestArgs(item.title) : null;
            const greenDecision = decisions.some((decision) => decision.cell === opts.cell && decision.verdict === 'green');
            if (args && greenDecision) {
              const result = evidenceRun(args);
              if (result.status === 0) passed.add(opts.cell!);
              else e2Failure = `E2 failed · ${opts.cell} · rc=${result.status ?? 'signal'} · ${result.stdout.slice(-4000)}`;
            }
          }
          writes = applyGreenSweepDecisions(opts.version, decisions, snapshot.items, passed,
            deps.greenSweepWrite ?? setItemIfSnapshot);
        }
        if (opts.json) out(JSON.stringify({ dryRun: !opts.apply, version: opts.version, counts, decisions, writes,
          e2: opts.apply ? (e2Failure ? 'failed' : currentMainClean ? 'main-clean' : 'main-head-or-tree-mismatch') : 'not-run',
          ...(e2Failure ? { e2Failure } : {}) }));
        else {
          out(`${opts.apply ? 'apply' : 'dry-run'} · ${opts.version} · 후보 ${counts.candidate} · green ${counts.green} · 기록만 ${counts.recordOnly} · 건너뜀 ${counts.skipped}`);
          if (e2Failure) out(e2Failure);
          if (opts.apply) for (const write of writes) out(`${write.written ? 'wrote green' : 'no write'}\t${write.cell}\t${write.reason ?? 'snapshot-guarded'}`);
          for (const d of decisions) out(`${d.verdict}\t${d.cell}\t#${d.pr}\t${d.mergeSha ?? '-'}\t${d.reason}\t${d.evidence}\tbefore=${JSON.stringify(d.existingEvidence)}\tafter=${JSON.stringify(d.plannedEvidence)}\tholdDiagnostic=${d.holdDiagnostic ?? ''}`);
        }
      } catch (error) { out(`green-sweep 조회 실패: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });

  tasks.command('cover')
    .description('TASK-AGENT 가 대신한 착지 비율과 리뷰·재발사·green 의 아직 없는 분모를 조회(읽기 전용)')
    .option('--since <iso>', '시작 시각 (ISO)')
    .option('--until <iso>', '끝 시각 (ISO)')
    .option('--json', 'JSON 출력')
    .option('--lines', '동사별 한 줄 요약 출력 (읽기 전용)')
    .option('--by-card', 'review·retry·green 분모를 카드 원장(창 안 createdAt 카드 수)으로 센다 (읽기 전용)')
    .option('--include-test', '시험 우주 logs.db 도 운영 우주와 합산(기본은 운영만)')
    .action(async (opts: { since?: string; until?: string; json?: boolean; lines?: boolean; byCard?: boolean; includeTest?: boolean }) => {
      const parseIso = (value: string | undefined, flag: string): number | undefined => {
        if (value === undefined) return undefined;
        const time = Date.parse(value);
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(time)) throw new Error(`${flag} 는 ISO 시각이어야 한다`);
        return time;
      };
      try {
        const sinceMs = parseIso(opts.since, '--since');
        const untilMs = parseIso(opts.until, '--until');
        if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) throw new Error('--since 가 --until 보다 늦다');
        let taskCards: { id: string }[] | null | undefined;
        if (opts.byCard) {
          let cards: CoverCardRow[] | null;
          try { cards = await (deps.coverCards ?? (() => readCoverCards(deps.taskStatePath ?? taskStatePathDefault())))(); } catch (error) {
            cards = null;
            try { debug.log('task-agent.cover', 'by-card-unreadable', { error: String(error).slice(-200) }, { level: 'warn' }); } catch { /* fail-soft */ }
          }
          taskCards = coverCardsInWindow(cards, { sinceMs, untilMs });
        }
        const scopedCoverLogs = (query: LogQuery) => (deps.coverLogs ?? queryCoverLogs)(query, opts.includeTest === true);
        const { rows, sevenVerbs, landSignals, limitReached, unreadableStores } = readTaskAgentCover(
          { sinceMs, untilMs }, scopedCoverLogs, taskCards, { ...deps, coverIncludeTest: opts.includeTest === true },
        );
        const limitWarning = limitReached ? `조회 상한 ${COVER_QUERY_LIMIT} 도달 — 더 오래된 사건이 있을 수 있다(절단된 수를 전체로 읽지 말 것)` : null;
        const storeWarning = unreadableStores > 0 ? `logs.db ${unreadableStores}개를 못 읽었다 — 그 우주의 사건은 수에 없다(«없다»로 읽지 말 것)` : null;
        if (opts.json) out(JSON.stringify({ rows, sevenVerbs, landSignals, limitReached, unreadableStores, ...(limitWarning ? { warning: limitWarning } : {}), ...(storeWarning ? { storeWarning } : {}) }));
        else {
          if (opts.lines) {
            for (const row of rows) out(formatTaskAgentCover(row));
            out(formatSevenVerbLive(sevenVerbs));
            out(formatCoverLandSignals(landSignals));
          }
          else {
            out('동사\t대신\t전체\t비율\t상태\t관측 사건');
            for (const row of rows) out(`${row.verb}\t${row.byTaskAgent ?? '-'}\t${row.total ?? '-'}\t${row.ratio ?? '-'}\t${row.state}\t${row.observedActions ?? '-'}`);
            out(formatCoverLandSignals(landSignals));
          }
          if (limitWarning) out(`⚠ ${limitWarning}`);
          if (storeWarning) out(`⚠ ${storeWarning}`);
        }
      } catch (error) { out(error instanceof Error ? error.message : '커버 조회 실패'); process.exitCode = 1; }
    });

  tasks.command('repair-outcomes')
    .description('TA 카드 원장의 repair-result 집계(읽기 전용 · 기간 내 runId별 최신 결과, 기간 밖의 정정은 제외)')
    .requiredOption('--since <iso>', '시작 시각(ISO, 포함)')
    .option('--until <iso>', '끝 시각(ISO, 미포함 · 기본 현재)')
    .option('--json', 'JSON 출력')
    .action((opts: { since: string; until?: string; json?: boolean }) => {
      try {
        const since = Date.parse(opts.since);
        const until = opts.until === undefined ? Date.now() : Date.parse(opts.until);
        const valid = (value: string) => /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value);
        if (!valid(opts.since) || !Number.isFinite(since) || opts.until !== undefined && (!valid(opts.until) || !Number.isFinite(until)) || since >= until)
          throw new Error('--since/--until 는 순서가 맞는 ISO 시각이어야 한다');
        const path = deps.taskStatePath ?? taskStatePathDefault();
        if (!existsSync(path)) throw new Error('TA 카드 원장 없음 — 수리 0건으로 판정 불가');
        const tasks = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(path).tasks;
        if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) throw new Error('TA 카드 원장 tasks 없음 — 수리 0건으로 판정 불가');
        const report = measureRepairOutcomes(Object.values(tasks), { since, until });
        if (opts.json) out(JSON.stringify(report));
        else out(`수리 결과(카드 원장) ${report.applied} 적용 · ${report.failed} 실패 · ${report.unconfirmed} 미확정 · 카드 ${report.cards} · 결과 ${report.results} · runId 결손 ${report.missingRunId} · 미지 효과 ${report.unknownEffect} (기간 내 최신 결과 · 판단 로그 아님)`);
      } catch (error) { out(error instanceof Error ? error.message : '수리 결과 원장 읽기 실패'); process.exitCode = 1; }
    });

  tasks.command('outcomes')
    .description('TA 카드·PR 종결 사건을 별도 분모로 센다 — 결속 자식 원장·종료 꼬리 원문과 부재 이유 포함(읽기 전용 · 사건 페이지 상한)')
    .option('--since <기간>', '시작 시각 — ISO 또는 상대 기간(24h · 3d)')
    .option('--until <기간>', '끝 시각 — ISO 또는 지금에서 뺀 상대 기간(24h · 3d)')
    .option('--by <축>', '집계 축 — card-terminal | pr-terminal | model,size(읽기 전용)')
    .option('--json', 'JSON 출력(기본값)')
    .action((opts: { since?: string; until?: string; by?: string; json?: boolean }) => {
      try {
        const now = deps.outcomesNow?.() ?? Date.now();
        const sinceMs = parseOutcomeTime(opts.since, '--since', now);
        const untilMs = parseOutcomeTime(opts.until, '--until', now) ?? now;
        // 창이 뒤집혔으면 아무것도 읽지 않는다(«빈 결과»로 속이지 않는다).
        if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) throw new Error('--since 가 --until 보다 늦다');
        // 축 이름이 틀렸으면 원장도 읽지 않는다(지어낸 집계를 내지 않게).
        const terminalKind = opts.by === 'card-terminal' ? 'card' : opts.by === 'pr-terminal' ? 'pr' : undefined;
        const dimensions = terminalKind ? null : parseOutcomeDimensions(opts.by);
        const snapshot = dimensions
          ? readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {}
          : undefined;
        const observed = readTaskOutcomes({ sinceMs, untilMs, terminalKind }, deps, snapshot);
        const report: TaskOutcomeReport = {
          since: sinceMs === undefined ? null : new Date(sinceMs).toISOString(),
          until: untilMs === undefined ? null : new Date(untilMs).toISOString(),
          ...observed,
        };
        try { debug.log('task-agent', 'card-outcomes', { since: report.since, until: report.until, rows: report.rows.length,
          missingReason: report.aggregate.missingReason, stopReason: report.stopReason,
          childLedgerObserved: report.childLedgerObserved, reasonObserved: report.reasonObserved }); } catch { /* fail-soft */ }
        // `--by model,size` 는 지금 JSON 에 «한 칸»을 더할 뿐 — 없으면 종전 JSON 그대로다.
        out(JSON.stringify(dimensions ? { ...report, byModelSize: readTaskOutcomeModelSize({ sinceMs, untilMs }, deps, observed, snapshot) } : report));
      } catch (error) {
        out(JSON.stringify({ error: error instanceof Error ? error.message : '결과 조회 실패' }));
        process.exitCode = 1;
      }
    });

  tasks.command('doctor <cardIdOrRunId>')
    .description('카드·런의 재발사 조건과 출처를 읽기 전용으로 판정한다')
    .option('--traffic <path>', 'hold 원장 traffic.json — 생략·판독 실패 시 hold=unknown')
    .option('--json', '한 줄 JSON 출력(기본값)')
    .action((target: string, opts: { traffic?: string; json?: boolean }) => {
      try { out(JSON.stringify(readTaskDoctor(target, { traffic: opts.traffic }, deps))); }
      catch (error) { out(JSON.stringify({ error: error instanceof Error ? error.message : 'doctor 조회 실패' })); process.exitCode = 1; }
    });

  registerTaskListCommand(tasks, ctx);

  const mapCommand = tasks.command('map')
    .description('MAPREDUCE-FANOUT — 현재 재고를 map-run 원장에 기록하고 결과를 읽기 전용으로 집계한다')
    .option('--recipe <name>', 'green-close 또는 draft-close')
    .option('--from <source>', 'landed-but-yellow 또는 drafts')
    .option('--limit <n>', '선택할 최대 항목 수')
    .option('--ids <csv>', '현재 재고에서 지정 ID만 선택 (최대 10; 재고 밖 ID는 HOLD 행)')
    .option('--concurrency <n>', '동시 카드 처리 상한 (기본 2)')
    .option('--dry-run', '기본값: 카드 발사·PR·체크리스트 쓰기 없음')
    .option('--reduce <map-run>', '기존 map-run의 결과 행 표를 읽기 전용으로 출력')
    .option('--live', '호스트 graph-run으로 레시피 실행 · 결과 원장만 기록 (C2: 최대 10건/동시 2)')
    .option('--json', 'JSON 출력')
    .action(async (opts: { recipe?: string; from?: string; limit?: string; ids?: string; concurrency?: string; dryRun?: boolean;
      reduce?: string; live?: boolean; json?: boolean }) => {
      try {
        const root = deps.mapRoot ?? effectiveInstanceRoot();
        if (opts.reduce) {
          if (opts.recipe || opts.from || opts.limit || opts.ids || opts.concurrency || opts.live || opts.dryRun) throw new Error('reduce-options-conflict');
          const table = renderMapReduceTable(opts.reduce, root);
          out(opts.json ? JSON.stringify(table) : table.markdown);
          return;
        }
        if (!opts.recipe || !opts.from) throw new Error('recipe-and-from-required');
        if (opts.live && opts.dryRun) throw new Error('live-dry-run-conflict');
        if (opts.recipe !== 'green-close' && opts.recipe !== 'draft-close') throw new Error('recipe-invalid');
        if (opts.from !== 'landed-but-yellow' && opts.from !== 'drafts') throw new Error('source-invalid');
        const requestedIds = opts.ids === undefined ? undefined : opts.ids.split(',').map((id) => id.trim());
        if (requestedIds && (requestedIds.length < 1 || requestedIds.length > 10
          || requestedIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id))
          || new Set(requestedIds).size !== requestedIds.length)) throw new Error('map-ids-invalid-or-duplicate: max 10');
        const limit = opts.limit === undefined ? (opts.live || requestedIds ? 10 : 100) : Number(opts.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit-out-of-range: 1..1000');
        if (requestedIds && requestedIds.length > limit) throw new Error('map-ids-exceed-limit');
        const concurrency = opts.concurrency === undefined ? 2 : Number(opts.concurrency);
        if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('concurrency-out-of-range: 1..32');
        if (opts.live && (limit > 10 || concurrency > 2)) throw new Error('host-map-c2-cap: limit<=10 concurrency<=2');
        const mapRunId = `map-${randomUUID()}`;
        const recipe = opts.recipe as MapRecipe;
        const source = opts.from as 'landed-but-yellow' | 'drafts';
        const hostLaunch = createMapHostLauncher({ recipeRoot: join(process.cwd(), 'graphs', 'work'),
          ...(deps.mapGraphRun ? { run: deps.mapGraphRun } : {}) });
        let attempted = 0;
        const ports: MapPorts<MapCliItem> = {
          inventory: async (r, s, selectedLimit) => selectMapIds(deps.mapInventorySource
            ? await deps.mapInventorySource(r, s, requestedIds ? undefined : selectedLimit, mapRunId)
            : await currentMapInventory(r, s, selectedLimit, root, mapRunId,
              deps.taskStatePath ?? taskStatePathDefault(), requestedIds), requestedIds),
          buildCard: (item, context) => ({ id: `map-card-${createHash('sha256').update(`${context.mapRunId}:${item.id}`).digest('hex').slice(0, 24)}`, itemId: item.id,
            mapRunId: context.mapRunId, recipe: context.recipe, text: item.text?.trim() || `verify ${item.id}` }),
          launchCard: async (card, item, context) => {
            attempted++;
            if (item.inventoryMissing) return { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId,
              recipe: card.recipe, kind: 'hold', verdict: 'hold', reason: 'requested-id-not-in-eligible-inventory', evidence: [] };
            if (!item.graphInput) return { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId,
              recipe: card.recipe, kind: 'hold', verdict: 'hold', reason: 'recipe-input-missing', evidence: [] };
            return hostLaunch(card, item as HostMapItem, context);
          },
          previewCard: (card, item): MapRunRow => ({ event: 'row', mapRunId: card.mapRunId, itemId: card.itemId,
            recipe: card.recipe, kind: 'hold', verdict: 'hold',
            reason: item.inventoryMissing ? 'requested-id-not-in-eligible-inventory' : 'dry-run-no-recipe-execution', evidence: [] }),
        };
        const result = await mapInventory({ recipe, source, limit, concurrency, dryRun: !opts.live, root, mapRunId }, ports);
        const table = renderMapReduceTable(result.mapRunId, root);
        if (opts.json) out(JSON.stringify({ ...result, ...table, status: opts.live ? 'host-graph-run' : 'preview-only',
          attempted, launched: opts.live ? undefined : 0, transport: opts.live ? 'host-graph-run' : null, externalWrites: 0 }));
        else out(table.markdown);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        out(opts.json ? JSON.stringify({ status: 'HOLD', reason, launched: 0, writes: 0 }) : `HOLD\t${reason}\t발사 0 · 쓰기 0`);
        process.exitCode = 1;
      }
    });

  mapCommand.command('dry-run')
    .requiredOption('--inventory <path>', '세 항목 inventory JSON 파일')
    .option('--json', '계획 또는 HOLD를 JSON으로 출력')
    .action((opts: { inventory: string; json?: boolean }) => {
      const json = opts.json || mapCommand.opts<{ json?: boolean }>().json;
      try {
        const parsed: unknown = JSON.parse(readFileSync(opts.inventory, 'utf8'));
        const entries = Array.isArray(parsed) ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
            ? (parsed as { items: unknown[] }).items : [];
        const validEntries = entries.length === 3 && entries.every((entry) => entry && typeof entry === 'object'
          && !Array.isArray(entry) && typeof (entry as { id?: unknown }).id === 'string'
          && (entry as { id: string }).id.trim().length > 0);
        const ids = validEntries ? entries.map((entry) => (entry as { id: string }).id.trim()) : [];
        const unique = new Set(ids).size === ids.length;
        if (!validEntries || !unique) {
          const result = { mode: 'dry-run', status: 'HOLD', reason: !validEntries ? 'incomplete-inventory' : 'duplicate-id', rows: [] };
          out(json ? JSON.stringify(result) : `HOLD\t${result.reason}\t발사 0`);
          process.exitCode = 1;
          return;
        }
        const rows = entries.map((entry, index) => ({
          id: ids[index]!, orchestrationId: orchestrationId(), action: 'planned', source: entry,
        }));
        const result = { mode: 'dry-run', status: 'planned', rows, effects: { launched: false, pullRequestWrites: false,
          checklistWrites: false, autoMerge: false } };
        if (json) out(JSON.stringify(result));
        else {
          out(`dry-run\tplanned\t${rows.length} 계획 행 · PR/체크리스트 쓰기 0 · 자동 병합 0`);
          for (const row of rows) out(`${row.id}\t${row.orchestrationId}\tplanned`);
        }
      } catch (error) {
        const result = { mode: 'dry-run', status: 'HOLD', reason: 'inventory-unreadable', rows: [] };
        out(json ? JSON.stringify(result) : `HOLD\tinventory-unreadable\t발사 0`);
        process.exitCode = 1;
      }
    });

  tasks.command('hand [text]')
    .description('TASK-AGENT 에 과제 한 줄을 넘긴다 — 카드를 적고 첫 수(harness say --substrate pod --merge-by-host)를 고른다 · 기본 shadow(발사 0) · `--mission` 이면 조각 카드 ⊕ 선후로 쪼개 선행 없는 조각만 넘긴다')
    .addOption(new Option('--seat <seat>', `과제 자리 (${TASK_SEATS.join('|')})`).choices([...TASK_SEATS]))
    .option('--checklist <cellId>', '릴리스 체크리스트 칸 id')
    .option('--version <version>', '체크리스트 판 고정(생략하면 발행 전 판을 가까운 순서로 탐색)')
    .addOption(new Option('--completion <kind>', `종결 종류 (${COMPLETION_KINDS.join('|')} · 기본 code-pr = PR 병합)`).choices([...COMPLETION_KINDS]))
    .option('--mission <text>', '미션 문면 — 조각(`- …`·`① …`·`1. …` ⊕ `after: 1`)으로 나열돼 있으면 결정론, 아니면 분해기로 쪼갠다')
    .option('--project <id>', '프로젝트 id — --target 과 함께')
    .option('--goal <id>', '보드 소속 목표 id (task board)')
    .option('--milestone <id>', '보드 소속 이정표 id (task board)')
    .option('--target <dir>', '프로젝트 대상 디렉터리(있어야 한다 · 상대 경로는 절대로 · git 이 아니면 --completion 이 code-pr 밖이어야 한다) — 발사기를 이 디렉터리에서 띄운다')
    .option('--live', '실제로 발사한다(기본은 shadow — 명령만 출력)')
    .option('--ta-land', 'TA-LIVE-LAND-2 — 호스트는 재게이트만 하고 병합은 TASK-AGENT 의 propose-land(`pr land --expected-head`)에 맡긴다 · 카드 taLand ⊕ 발사 env ELANOUS_TA_LAND=1 · taskAgent.liveMoves 에 propose-land 가 없으면 종전대로 호스트가 병합')
    .option('--child-llm <provider/model>', 'TASKS-HAND-CHILD-LLM — 구현 자식 LLM(예: grok/grok-4.7) → 발사 인자 --child-llm-provider <provider> --child-llm-model <model> · «첫» `/` 에서만 가른다(모델 id 의 `/` 는 보존) · openrouter 는 모델 id 가 openrouter/ 접두를 포함하므로 전체를 모델로(openrouter/z-ai/glm-5.3 → --child-llm-model openrouter/z-ai/glm-5.3) · 카드 childLlm · 안 주면 명령·카드 무변경')
    .option('--child-llm-effort <level>', '구현 자식 추론 노력 → 발사 인자 --child-llm-effort(검증은 하니스 · --child-llm 과 함께)')
    .option('--role-llm <role=provider[/tier]>', 'TA 부모 역할 LLM(반복 가능 · planning|classify|audit|review만). 정확한 모델은 role={"provider":"openrouter","model":"openrouter/z-ai/glm-5.3"}; 자식 모델은 --child-llm', (value: string, previous: string[] = []) => [...previous, value])
    .addOption(new Option('--tier <level>', '디스패처 난이도(하|중|상|특) — 카드에 보존해 수리 모델 정책에 사용').choices(['하', '중', '상', '특']))
    .option('--tag <k=v>', 'RUN-IDENTITY-TAGS — 출생 신분을 덮는다(class|care|rights|protect 의 k=v · 반복: --tag class=gate --tag protect=true) — 카드 원장 identity 에 남는다', (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    .option('--draft-claim <pr>', 'DRAFT-CLAIM-AUTO-2-FU — PR 를 관측(gh pr view)해 draftClaim 을 조립해 넘긴다 · 관측한 PR 머리에서 `elanous self review <pr> --json` 로 손 수확을 먼저 확정한다(확정 못 하면 claim 문면을 만들지 않는다) · claim 문면을 실제 PR 댓글로 게시(gh pr comment)한다 · 같은 PR 의 살아 있는 claim 기록(카드 draftClaim)이 있으면 거부한다')
    .option('--json', 'JSON 출력')
    .action(async (text: string | undefined, opts: { seat?: TaskSeat; checklist?: string; version?: string; completion?: CompletionKind; mission?: string; project?: string; target?: string; goal?: string; milestone?: string; live?: boolean; taLand?: boolean; childLlm?: string; childLlmEffort?: string; roleLlm?: string[]; tier?: TaskCard['tier']; tag?: string[]; draftClaim?: string; json?: boolean }) => {
      const suppliedText = text !== undefined;
      /** RUN-IDENTITY-TAGS — 칸을 찾은 판(출생 신분이 그 판의 칸 우선순위를 읽는다 · 개발 판 밖 칸도). */
      let birthBoardVersion: string | undefined;
      if (opts.version !== undefined && opts.checklist === undefined) {
        out('--version 은 --checklist 와 함께 준다');
        process.exitCode = 1;
        return;
      }
      if (opts.checklist !== undefined) {
        const findTitle = (nodes: BoardNode[]): string | undefined => {
          for (const node of nodes) {
            if (node.level === 'task' && node.id === opts.checklist) return node.title;
            const nested = node.children ? findTitle(node.children) : undefined;
            if (nested !== undefined) return nested;
          }
          return undefined;
        };
        if (opts.version !== undefined) {
          try { validateVersion(opts.version); }
          catch (error) {
            out(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
            return;
          }
        }
        const versions = opts.version !== undefined ? [opts.version]
          : [checklistDevVersion(), ...(deps.releaseVersions?.() ?? (deps.releaseBoard ? [] : (() => {
            const released = releasedVersion();
            return assignedVersions().filter((version) => !released || compareVersions(version, released) > 0);
          })()))];
        const current = checklistDevVersion();
        const orderedVersions = [...new Set(versions)].sort((a, b) => {
          if (a === current) return -1;
          if (b === current) return 1;
          const aFuture = compareVersions(a, current) > 0;
          const bFuture = compareVersions(b, current) > 0;
          if (aFuture !== bFuture) return aFuture ? -1 : 1;
          return aFuture ? compareVersions(a, b) : compareVersions(b, a);
        });
        const matches: Array<{ version: string; title: string }> = [];
        // CLI-ENTRY-LAZY — board(전이 폐포가 가장 크다)는 칸을 찾을 때만 싣는다.
        const packBoard = deps.releaseBoard ?? (await import('../task-agent/board.js')).releasePackBoard;
        for (const version of orderedVersions) {
          try {
            const title = findTitle(packBoard(version));
            if (title !== undefined) matches.push({ version, title });
          } catch (error) {
            if (opts.version !== undefined) {
              out(`체크리스트 판 읽기 실패: ${version}`);
              process.exitCode = 1;
              return;
            }
            console.error(`⚠ 체크리스트 판 ${version} 읽기 실패 — 다른 판 계속 조회: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const title = matches[0]?.title;
        if (title === undefined) {
          out(`체크리스트 칸 없음: ${opts.checklist}`);
          process.exitCode = 1;
          return;
        }
        if (matches.length > 1) console.error(`⚠ 체크리스트 칸 ${opts.checklist} 중복: ${matches.map((match) => match.version).join(', ')} — 가장 가까운 판 ${matches[0]!.version} 선택 (--version 으로 고정 가능)`);
        birthBoardVersion = matches[0]!.version;
        if (opts.mission === undefined && text === undefined) text = title;
      }
      if (opts.checklist !== undefined && opts.mission === undefined && suppliedText && !text!.split(/\r?\n/, 1)[0]!.startsWith('대상 경로:')) {
        out('칸 문면을 쓰려면 문면 인자를 빼라');
        process.exitCode = 1;
        return;
      }
      await registerTaskAgentSink(deps.registerSink);
      if ((text === undefined) === (opts.mission === undefined)) {
        out('과제 한 줄 «또는» --mission <문면> 중 하나만 준다');
        process.exitCode = 1;
        return;
      }
      if ((opts.project === undefined) !== (opts.target === undefined)) {
        out('--project <id> 와 --target <dir> 를 함께 줘야 한다');
        process.exitCode = 1;
        return;
      }
      if (opts.mission !== undefined && (opts.completion !== undefined || opts.project !== undefined || opts.goal !== undefined || opts.milestone !== undefined || opts.taLand === true || opts.childLlm !== undefined || opts.childLlmEffort !== undefined || opts.roleLlm !== undefined || opts.tier !== undefined || opts.tag !== undefined)) {
        out('--completion/--project/--target/--goal/--milestone/--ta-land/--child-llm/--role-llm/--tier/--tag 는 과제 한 줄에만 준다 — --mission 조각은 종전처럼 code-pr 이다');
        process.exitCode = 1;
        return;
      }
      if (opts.mission !== undefined) {
        try {
          const { handMission } = await import('../task-agent/mission.js');
          const result = await handMission({
            text: opts.mission,
            ...(opts.seat ? { seat: opts.seat } : {}),
            ...(opts.checklist ? { checklistId: opts.checklist } : {}),
            live: opts.live === true,
            ...(deps.taskStatePath ? { statePath: deps.taskStatePath } : {}),
            launcher: deps.taskLauncher ?? defaultTaskLauncher,
            ...(deps.missionDecompose ? { decompose: deps.missionDecompose } : {}),
          });
          if (opts.json) out(JSON.stringify(result));
          else {
            out(`${result.mission.id}\tmission\t${result.mode}\t조각 ${result.pieces.length} · 간선 ${result.edges.length} · 출처 ${result.source}`);
            for (const piece of result.pieces) {
              out([piece.card.id, piece.launched ? 'launched' : piece.error ? 'failed' : 'not launched', `${piece.move.kind} (${piece.move.reason})`, headLine(piece.card.text)].join('\t'));
              if (piece.move.command) out(`  elanous ${piece.move.command.map(shellQuote).join(' ')}`);
              if (piece.error) out(`  ${piece.error}`);
            }
            for (const [before, after] of result.edges) out(`간선: ${before} -> ${after}`);
            if (result.mode === 'shadow') out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
          }
          if (result.pieces.some((piece) => piece.error)) process.exitCode = 1;
        } catch (error) {
          out(error instanceof Error ? error.message : '미션 넘기기 실패');
          process.exitCode = 1;
        }
        return;
      }
      try {
        const resolved = resolveHandText(text!);
        if (resolved.kind === 'rejected') {
          try { debug.log('task-agent.hand', 'goal-file-rejected', { path: resolved.path, reason: resolved.reason }); } catch { /* fail-soft */ }
          out(`골 파일 ${resolved.path}: ${resolved.reason}`);
          process.exitCode = 1;
          return;
        }
        if (resolved.kind === 'inlined') {
          try { debug.log('task-agent.hand', 'goal-file-inlined', { path: resolved.path, chars: resolved.chars, sha256: resolved.sha256 }); } catch { /* fail-soft */ }
        }
        if (opts.live && opts.checklist && birthBoardVersion) {
          const origin = deps.handOriginRepo?.() ?? execFileSync('git', ['remote', 'get-url', 'origin'],
            { cwd: process.cwd(), encoding: 'utf8' }).trim().replace(/\.git\/?$/, '');
          const repo = origin.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)?([^/\s]+\/[^/\s]+)\/?$/)?.[1];
          if (!repo) throw new Error(`현재 worktree origin이 GitHub 저장소가 아니다: ${origin}`);
          const run = deps.handOpenPrRun ?? ((command: string, args: string[]) => spawnSync(command, args,
            { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }));
          const listed = run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,body']);
          if (listed.status !== 0) throw new Error(`같은 칸 OPEN PR 조회 실패 — 구현 발사 0: ${opts.checklist}`);
          let rows: unknown;
          try { rows = JSON.parse(listed.stdout); } catch { throw new Error(`OPEN PR 목록 해석 실패 — 구현 발사 0: ${opts.checklist}`); }
          if (!Array.isArray(rows) || rows.length >= 500 || !rows.every((row) =>
            Number.isSafeInteger(doctorObject(row)?.number) && typeof doctorObject(row)?.body === 'string')) {
            throw new Error(`OPEN PR 목록 불완전 — 구현 발사 0: ${opts.checklist}`);
          }
          const openPrs = rows.filter((row) => cellIdFromBody(doctorObject(row)!.body as string) === opts.checklist)
            .map((row) => doctorObject(row)!.number as number);
          if (openPrs.length > 1) throw new Error(`같은 칸 OPEN PR 복수 — 구현 발사 0: ${opts.checklist} ${openPrs.map((pr) => `#${pr}`).join(', ')}`);
          if (openPrs.length === 1) {
            const number = openPrs[0]!;
            const view = (deps.adoptPrView ?? ((pr: number, cwd: string) => JSON.parse(execFileSync('gh',
              ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,url,state,baseRefName,headRefOid'], { cwd, encoding: 'utf8' }))))(number, process.cwd());
            if (view.number !== number) throw new Error(`조회 PR 번호가 다르다: 요청 #${number} · 응답 #${view.number}`);
            const viewedRepo = typeof view.url === 'string'
              ? view.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/) : null;
            if (view.state !== 'OPEN' || view.baseRefName !== 'main' || !/^[a-f0-9]{40}$/i.test(view.headRefOid)
              || viewedRepo?.[1]?.toLowerCase() !== repo.toLowerCase() || Number(viewedRepo?.[2]) !== number) {
              throw new Error(`OPEN/main PR 신원 불일치: #${number} — 구현 발사 0`);
            }
            const statePath = deps.taskStatePath ?? taskStatePathDefault();
            const boundCards = Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {})
              .filter((card) => card.checklistId === opts.checklist && cardPrNumber(card) === number);
            if (boundCards.length) {
              const bound = boundCards.length === 1 ? boundCards[0] : undefined;
              const same = bound?.status === 'launched' && bound.taLand === true
                && typeof bound.pr === 'object' && bound.pr.url === view.url
                && (!bound.checklistVersion || bound.checklistVersion === birthBoardVersion);
              if (!same) throw new Error(`같은 칸 OPEN PR #${number}에 기존 카드 ${boundCards.map((card) => card.id).join(', ')}가 있다 — 구현 발사 0; tasks adopt-pr ${number} --card <카드> --version ${birthBoardVersion} 확인`);
              if (opts.json) out(JSON.stringify({ card: bound.id, pr: number, head: view.headRefOid, launched: false, next: `tasks rejudge ${bound.id}` }));
              else out(`${bound.id}\tPR #${number} already-bound\t구현 발사 0 · 다음: tasks rejudge ${bound.id}`);
              return;
            }
            const { adoptExistingPr } = await import('../task-agent/adopt-pr.js');
            const current = (deps.adoptChecklist ?? listChecklist)(birthBoardVersion).items.find((item) => item.id === opts.checklist);
            if (!current || current.status === 'green' || current.status === 'done') throw new Error(`입양할 미완 칸 없음: ${birthBoardVersion}/${opts.checklist}`);
            const adopted = adoptExistingPr({ pr: view, repo, statePath,
              checklist: { version: birthBoardVersion, id: current.id, title: current.title, status: current.status },
              checklistAtWrite: () => (deps.adoptChecklist ?? listChecklist)(birthBoardVersion).items.find((item) => item.id === opts.checklist) });
            try { debug.log('task-agent.hand', 'open-pr-adopted', { card: adopted.card.id, pr: number, head: view.headRefOid, launched: false }); } catch { /* fail-soft */ }
            if (opts.json) out(JSON.stringify({ card: adopted.card.id, pr: number, head: view.headRefOid, launched: false, next: `tasks rejudge ${adopted.card.id}` }));
            else out(`${adopted.card.id}\tPR #${number} adopted\t구현 발사 0 · 다음: tasks rejudge ${adopted.card.id}`);
            return;
          }
        }
        const handOpts = {
          text: resolved.text,
          ...(resolved.kind === 'work-order' ? { workOrder: resolved.order } : {}),
          ...(deps.coordinatorShadowRoot ? { coordinatorShadowRoot: deps.coordinatorShadowRoot } : {}),
          ...(deps.taskNow ? { now: deps.taskNow } : {}),
          ...(opts.project !== undefined && opts.target !== undefined ? { project: { id: opts.project, target: opts.target } } : {}),
          ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
          ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
          ...(opts.seat ? { seat: opts.seat } : {}),
          ...(opts.checklist ? { checklistId: opts.checklist } : {}),
          ...(opts.completion ? { completion: opts.completion } : {}),
          live: opts.live === true,
          preflightGoalDoneBoundary: opts.live === true && deps.taskLauncher === undefined,
          ...(opts.taLand === true ? { taLand: true } : {}),
          ...(opts.childLlm !== undefined ? { childLlm: opts.childLlm } : {}),
          ...(opts.childLlmEffort !== undefined ? { childLlmEffort: opts.childLlmEffort } : {}),
          ...(opts.roleLlm?.length ? { parentRoleLlm: opts.roleLlm } : {}),
          ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
          ...(opts.tag !== undefined ? { tags: opts.tag } : {}),
          ...(birthBoardVersion !== undefined ? { checklistVersion: birthBoardVersion } : {}),
          ...(deps.taskStatePath ? { statePath: deps.taskStatePath } : {}),
          ...(deps.taskCompositionRoot ? { compositionRoot: deps.taskCompositionRoot } : {}),
          launcher: deps.taskLauncher ?? defaultTaskLauncher,
        };
        // DRAFT-CLAIM-AUTO-2-FU — 생산 배선: `--draft-claim <pr>` 로 관측·게시·수확 리뷰 포트를 끼워 draftClaim(⊕ 손 수확)을
        // «조립해» 넘긴다 — handDraftClaim 이 관측한 PR 머리와 리뷰 러너로 수확을 확정한 뒤에만 claim 문면을 게시한다.
        const draftClaimPr = opts.draftClaim === undefined ? undefined : Number(opts.draftClaim);
        if (opts.draftClaim !== undefined && (!Number.isInteger(draftClaimPr) || (draftClaimPr ?? 0) <= 0)) {
          out(`--draft-claim 은 PR 번호다: ${opts.draftClaim}`);
          process.exitCode = 1;
          return;
        }
        if (draftClaimPr !== undefined && opts.live && (opts.tier === '상' || opts.tier === '특')) {
          try { debug.log('task-agent.hand', 'tier-split-bypassed', { reason: 'draft-claim', pr: draftClaimPr, tier: opts.tier }); } catch { /* fail-soft */ }
        }
        const handed = draftClaimPr !== undefined
          ? { kind: 'whole' as const, result: await handDraftClaim({ ...handOpts, pr: draftClaimPr, gh: deps.draftClaimGh ?? defaultDraftClaimGhPorts() }) }
          : await (await import('../task-agent/tier-split.js')).handTaskWithTierSplit({ ...handOpts, ...('tierSizedDecompose' in deps ? { decompose: deps.tierSizedDecompose } : {}) });
        if (handed.kind === 'split') {
          // TIER-SPLIT-BEFORE-LAUNCH — 상·특 hand 를 조각으로 나눠 쐈다: 첫 줄 = 묶음 · 조각마다 한 줄(미션 출력과 같은 꼴).
          if (opts.json) out(JSON.stringify(handed));
          else {
            // 디스패처 계약(ta-dispatcher.sh · `grep -E '^ta-' | head -1`): 줄 머리 `ta-` 는 «카드 id» 만 — 조각 카드 줄이 먼저, 묶음 줄은 끝에 `tier-split` 머리로.
            for (const piece of handed.slices) {
              out([piece.result?.card.id ?? '-', piece.result?.launched ? 'launched' : piece.error ? 'failed' : 'not launched', `tier ${piece.slice.tier} · 파일 ${piece.slice.files} · 행동 ${piece.slice.behaviours}`, headLine(piece.slice.goal)].join('\t'));
              if (piece.slice.unavoidable) out(`  불가피: ${piece.slice.unavoidable}`);
              if (piece.error) out(`  ${piece.error}`);
            }
            out(`tier-split\t${handed.group}\t${handed.fromTier} → 조각 ${handed.slices.length}`);
          }
          if (handed.slices.some((piece) => piece.error)) process.exitCode = 1;
          return;
        }
        const result = handed.result;
        if (handed.kind === 'blocked') process.exitCode = 1;
        if (opts.json) out(JSON.stringify(result));
        else if (handed.kind === 'blocked') {
          // 발사 0 — 디스패처가 «넘김 실패» 로 읽도록 어느 줄도 `ta-` 로 시작하지 않는다.
          out(`tier-split-failed\t${result.card.id}\tnot launched`);
          out(`(tier-split-failed — 발사 0 · 카드 failed · ${handed.reason})`);
        } else {
          out(`${result.card.id}\t${result.mode}\t${result.launched ? 'launched' : 'not launched'}`);
          if (result.move.command) out(`elanous ${result.move.command.map(shellQuote).join(' ')}`);
          else out(result.move.reason);
          if (result.cwd) out(`(cwd: ${result.cwd})`);
          if (result.card.taLand) out('(ta-land — 발사 env ELANOUS_TA_LAND=1 · 원격 또는 로컬 부모 · taskAgent.liveMoves 에 propose-land 가 있으면 병합은 TASK-AGENT 몫, 없으면 종전대로 호스트 병합)');
          if (!result.launched && result.card.alreadyDoneCandidate) out('(main 증거 통과 — 발사 0 · green 후보만 기록, 주인 판정 대기)');
          else if (!result.launched) out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
        }
      } catch (error) {
        out(error instanceof Error ? error.message : '과제 넘기기 실패');
        process.exitCode = 1;
      }
    });

  tasks.command('tag <id> <k=v>')
    .description('RUN-IDENTITY-TAGS — 카드의 런 신분 태그를 바꾼다(class|care|rights|protect 의 k=v · 카드 history 에 감사 줄 run-tag-change {from, to, by, reason} 이 남는다 · 카드 상태 파일이 원장 정본 · 목록 밖 값은 거부)')
    .option('--by <seat>', '바꾼 자리(예: OP·MK·TC·UX) — 안 주면 호출 자리 ELANOUS_TRACK, 그것도 없으면 «unknown» 으로 감사 줄에 적는다(지어내지 않는다)')
    .option('--reason <text>', '왜 바꾸나 — 감사 줄에 남긴다')
    .option('--json', '바뀐 카드를 JSON 으로 출력')
    .action(async (id: string, kv: string, opts: { by?: string; reason?: string; json?: boolean }) => {
      try {
        const by = opts.by?.trim() || process.env.ELANOUS_TRACK?.trim() || 'unknown';
        const card = runTagChange(id, { tag: kv, by, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) }, deps.taskStatePath ?? taskStatePathDefault());
        if (card === undefined) {
          out(`카드가 없습니다: ${id}`);
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          out(JSON.stringify(card));
          return;
        }
        out(`${card.id}\t${kv}`);
        const { cardIdentityLines } = await import('./tasks-card-show.js');
        for (const line of cardIdentityLines(card)) out(line);
      } catch (error) {
        out(error instanceof Error ? error.message : '태그 바꾸기 실패');
        process.exitCode = 1;
      }
    });

  tasks.command('hand-move <id>')
    .description('HAND-MOVE-LEDGER — 자리가 손으로 마무리한 수(기존 실패 면제 · diff 재적용 · 범위 자르기 · 쪼개기 · 다른 모델 의견)를 그 카드 history 에 한 줄로 남긴다 — live-move 와 같은 원장 칸 · 기존 줄은 건드리지 않는다')
    .requiredOption('--kind <kind>', `손으로 쓴 수 (${HAND_MOVE_KINDS.join('|')})`)
    .requiredOption('--by <seat>', '남긴 자리(예: OP·MK·TC·UX)')
    .requiredOption('--detail <text>', '무엇을 했나 — 한 줄')
    .option('--pr <number>', '관련 PR 번호')
    .action(async (id: string, opts: { kind: string; by: string; detail: string; pr?: string }) => {
      await registerTaskAgentSink(deps.registerSink);
      const pr = opts.pr === undefined ? undefined : Number(opts.pr);
      if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) { out(`--pr 은 자연수다: ${opts.pr}`); process.exitCode = 1; return; }
      const outcome = recordHandMove(deps.taskStatePath ?? taskStatePathDefault(), id,
        { kind: opts.kind, by: opts.by, detail: opts.detail, ...(pr !== undefined ? { pr } : {}) });
      try {
        debug.log('task-agent', 'hand-move', outcome.written
          ? { card: id, kind: outcome.entry.kind, by: outcome.entry.by, ...(outcome.entry.pr !== undefined ? { pr: outcome.entry.pr } : {}) }
          : { card: id, kind: opts.kind, by: opts.by, reason: outcome.reason });
      } catch { /* fail-soft */ }
      if (!outcome.written) { out(`hand-move 한 줄을 못 남겼다 — ${outcome.reason}`); process.exitCode = 1; return; }
      out([id, 'hand-move', outcome.entry.kind, outcome.entry.by, outcome.entry.detail, ...(outcome.entry.pr !== undefined ? [`pr ${outcome.entry.pr}`] : [])].join('\t'));
    });

  tasks.command('live-verified <card>')
    .description('TA-WIRING-CHECK — 실물 1회를 돌린 뒤 그 카드 런 원장에 live-verified {pr, ref, ok, card} 한 줄을 남긴다 · --ref(실물로 돌린 명령·화면 근거)가 비면 거부')
    .requiredOption('--pr <number>', '실물로 확인한 PR 번호')
    .requiredOption('--ref <근거>', '실물로 돌린 명령·화면 근거 한 줄(비면 거부)')
    .option('--fail', '실물이 실패했다(ok=false)')
    .action(async (cardId: string, opts: { pr: string; ref: string; fail?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      const pr = Number(opts.pr);
      if (!Number.isInteger(pr) || pr <= 0) { out(`--pr 은 자연수다: ${opts.pr}`); process.exitCode = 1; return; }
      let card: TaskCard | undefined;
      try { card = readTaskCard(cardId, deps.taskStatePath); } catch (error) { out(error instanceof Error ? error.message : '과제 카드 읽기 실패'); process.exitCode = 1; return; }
      if (!card) { out(`과제 카드 없음: ${cardId}`); process.exitCode = 1; return; }
      const outcome = recordWiringLiveVerified(card, { pr, ref: opts.ref, ok: !opts.fail }, deps.liveVerifiedLedgerDir ? { ledgerDir: deps.liveVerifiedLedgerDir } : {});
      if (!outcome.written) { out(`live-verified 한 줄을 못 남겼다 — ${outcome.reason}`); process.exitCode = 1; return; }
      try { debug.log('task-agent', 'wiring-live-verified', { card: card.id, runId: card.runId ?? null, pr, ok: outcome.entry.data.ok }); } catch { /* fail-soft */ }
      out([card.id, 'live-verified', `pr ${pr}`, outcome.entry.data.ok ? 'ok' : 'fail', outcome.entry.data.ref].join('\t'));
    });

  tasks.command('close <cardId>')
    .description('과제 카드를 손으로 닫는다 — 상태를 failed 로 두고 사유를 history(closed-by-hand)에 한 줄 남긴다 · 없는 카드 id 는 거부(exit 1)')
    .requiredOption('--reason <사유>', '닫는 사유(비면 거부)')
    .option('--by <seat>', '닫은 자리(예: OP·MK·TC·UX)', 'operator')
    .option('--json', 'JSON 출력')
    .action(async (cardId: string, opts: { reason: string; by: string; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      const statePath = deps.taskStatePath ?? taskStatePathDefault();
      try {
        let found: TaskCard | undefined;
        let changed = false;
        const updated = updateTaskCard(statePath, cardId, (current) => {
          if (!current) return undefined;
          found = current;
          const next = closeTaskCard(current, { reason: opts.reason, by: opts.by, at: new Date().toISOString() });
          if (next === current) return undefined; // 이미 손으로 닫힘 — 다시 쓰지 않는다(멱등)
          changed = true;
          return next;
        });
        if (!found) { out(`과제 카드 없음: ${cardId}`); process.exitCode = 1; return; }
        const card: TaskCard = updated ?? found;
        const from = (found as TaskCard).status;
        // 이미 닫힌 카드면 «저장된» 사유를 낸다 — 새로 준 사유는 원장에 없다.
        const stored = [...card.history].reverse().find((item) => item.event === CLOSED_BY_HAND_EVENT);
        const reason = changed ? opts.reason.trim() : (stored?.reason ?? stored?.detail ?? opts.reason.trim());
        if (changed) { try { debug.log('task-agent', 'card-closed-by-hand', { id: cardId, from, by: opts.by, reason }); } catch { /* fail-soft */ } }
        if (opts.json) out(JSON.stringify({ id: card.id, from, to: card.status, reason, ...(changed ? {} : { already: true }) }));
        else out([card.id, card.status, changed ? 'closed-by-hand' : 'already-closed-by-hand', changed ? opts.by : (stored?.by ?? '-'), reason].join('\t'));
      } catch (error) {
        out(error instanceof Error ? error.message : '과제 카드 닫기 실패');
        process.exitCode = 1;
      }
    });

  tasks.command('parents')
    .description('낡은 하니스 부모 보고(읽기 전용 · 죽이지 않는다) — 나이 ≥ N 시간이고 런 원장이 끝났거나(run-status) Pod 이 없는 `harness say|ask` 부모')
    .option('--older-than <hours>', '나이 하한(시간)', '6')
    .option('--no-pods', 'Pod 목록을 재지 않는다(원장 근거만)')
    .option('--json', 'JSON 출력')
    .action(async (opts: { olderThan: string; pods?: boolean; json?: boolean }) => {
      const hours = Number(opts.olderThan);
      if (!Number.isFinite(hours) || hours < 0) { out(`--older-than 는 0 이상 수다: ${opts.olderThan}`); process.exitCode = 1; return; }
      const { staleHarnessParents } = await import('../task-agent/parent-host.js');
      const injected = deps.staleParents ?? {};
      const loadLedger = injected.loadLedger ?? ((runId: string) => loadRunLedgerSync(runId));
      let podRuns = injected.podRuns;
      let labelOf = injected.labelOf;
      if (!podRuns && opts.pods !== false) {
        const queue = await import('../harness/harness-queue.js');
        podRuns = () => queue.readHarnessQueuePodRuns();
        labelOf = queue.queueRunLabelValue;
      }
      const report = staleHarnessParents(hours, { ...injected, loadLedger, ...(podRuns ? { podRuns } : {}), ...(labelOf ? { labelOf } : {}) });
      try { debug.log('task-agent', 'stale-parents', { olderThanHours: hours, scanned: report.scanned, stale: report.rows.length, podRunsMeasured: report.podRunsMeasured }); } catch { /* fail-soft */ }
      if (opts.json) { out(JSON.stringify({ olderThanHours: hours, ...report })); return; }
      out(`하니스 부모 ${report.scanned} · 나이 ≥ ${hours}h 중 낡음 후보 ${report.rows.length}${report.podRunsMeasured ? '' : ' · ⚠ Pod 목록 못 잼(원장 근거만)'} — 읽기 전용(죽이지 않는다)`);
      out('pid\t나이h\t자리\t판\t런\t사유');
      for (const row of report.rows) out([row.pid, row.ageHours, row.seat ?? '-', row.version ?? '-', row.runId ?? '-', row.reasons.join(',')].join('\t'));
    });

  tasks.command('adopt-pr <number>')
    .description('기존 OPEN/main PR을 TA 카드에 묶고 다음 tasks rejudge 대상에 넣는다(구현 발사 0)')
    .option('--card <id>', '기존 launched 카드(미바인딩 또는 같은 PR이 등록부에서 바인딩됨)')
    .option('--checklist <id>', '새 카드에 붙일 체크리스트 칸')
    .option('--version <version>', '체크리스트 판(기존 카드에도 고정 가능)')
    .option('--rebind', '옛 판 또는 failed 카드의 기존 PR 결속을 풀고 지정 판의 새 카드로 원자 이동')
    .option('--unlinked-terminal', '기존 카드의 모든 구현 자식이 종결되고 PR 사건이 전혀 없을 때만 별도로 열린 PR을 명시적으로 입양')
    .option('--json', 'JSON 출력')
    .action(async (value: string, opts: { card?: string; checklist?: string; version?: string; rebind?: boolean; unlinkedTerminal?: boolean; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      try {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`PR 번호가 아니다: ${value}`);
        if ((opts.card === undefined) === (opts.checklist === undefined))
          throw new Error('--card 또는 --checklist [--version] 중 하나만 준다');
        if (opts.rebind && (opts.card || !opts.checklist || !opts.version || opts.unlinkedTerminal))
          throw new Error('--rebind는 --checklist와 --version을 지정하고 --card/--unlinked-terminal은 생략한다');
        if (opts.unlinkedTerminal && !opts.card) throw new Error('--unlinked-terminal은 --card와 함께 준다');
        if (opts.version) validateVersion(opts.version);
        let cardVersion = opts.version;
        let observedChecklist: { id: string; version: string; status: string; cardVersion?: string } | undefined;
        if (opts.card) {
          const current = readTaskCard(opts.card, deps.taskStatePath ?? taskStatePathDefault());
          if (!current?.checklistId) throw new Error(`카드 ${opts.card}의 칸이 없다`);
          const versions = opts.version ? [opts.version] : [...new Set([checklistDevVersion(), ...(deps.releaseVersions?.() ?? assignedVersions())])];
          const matches = versions.filter((version) => {
            try { return (deps.adoptChecklist ?? listChecklist)(version).items.some((item) => item.id === current.checklistId); }
            catch (error) { if (opts.version) throw error; return false; }
          });
          if (matches.length !== 1) throw new Error(matches.length ? `칸 ${current.checklistId}가 여러 판에 있다 — --version 지정: ${matches.join(', ')}` : `체크리스트 칸 없음: ${current.checklistId}`);
          cardVersion = matches[0]!;
          const item = (deps.adoptChecklist ?? listChecklist)(cardVersion).items.find((candidate) => candidate.id === current.checklistId)!;
          if (item.status === 'green' || item.status === 'done') throw new Error(`이미 완료된 칸은 새 PR 입양 대상이 아니다: ${cardVersion}/${item.id}`);
          observedChecklist = { id: item.id, version: cardVersion, status: item.status, cardVersion: current.checklistVersion };
        }
        let checklist: { version: string; id: string; title: string; status: string } | undefined;
        if (opts.checklist) {
          const versions = opts.version ? [opts.version] : [...new Set([checklistDevVersion(), ...(deps.releaseVersions?.() ?? assignedVersions())])];
          const matches = versions.flatMap((version) => {
            try { return (deps.adoptChecklist ?? listChecklist)(version).items.filter((item) => item.id === opts.checklist).map((item) => ({ version, id: item.id, title: item.title, status: item.status })); }
            catch (error) { if (opts.version) throw error; return []; }
          });
          if (matches.length !== 1) throw new Error(matches.length ? `칸 ${opts.checklist}가 여러 판에 있다 — --version 지정: ${matches.map((item) => item.version).join(', ')}` : `체크리스트 칸 없음: ${opts.checklist}`);
          checklist = matches[0];
        }
        const number = Number(value);
        const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd(), encoding: 'utf8' }).trim().replace(/\.git\/?$/, '');
        const repo = origin.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+)\/?$/)?.[1];
        if (!repo) throw new Error(`현재 worktree origin이 GitHub 저장소가 아니다: ${origin}`);
        const view = (deps.adoptPrView ?? ((pr: number, cwd: string) => JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,url,state,baseRefName,headRefOid'], { cwd, encoding: 'utf8' }))))(number, process.cwd());
        if (view.number !== number) throw new Error(`조회 PR 번호가 다르다: 요청 #${number} · 응답 #${view.number}`);
        const { adoptExistingPr, adoptedRunTerminal } = await import('../task-agent/adopt-pr.js');
        const targetCard = opts.card ? readTaskCard(opts.card, deps.taskStatePath ?? taskStatePathDefault()) : undefined;
        const checkRun = deps.adoptRunTerminal ?? adoptedRunTerminal;
        const linkedEvidence = targetCard ? checkRun(targetCard, view) : undefined;
        const terminalRunEvidence = linkedEvidence || (opts.unlinkedTerminal && targetCard ? checkRun(targetCard, view, undefined, true) : false);
        const unlinkedTerminalUsed = opts.unlinkedTerminal === true && linkedEvidence !== true;
        let rebindSource: { card: TaskCard; terminalRunEvidence: boolean } | undefined;
        if (opts.rebind) {
          const statePath = deps.taskStatePath ?? taskStatePathDefault();
          const bound = Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {})
            .filter((card) => cardPrNumber(card) === number);
          if (bound.length !== 1) throw new Error(bound.length
            ? `PR #${number}가 여러 카드에 묶였다 — 임의로 rebind하지 않는다`
            : `PR #${number}가 기존 카드에 묶이지 않았다 — --rebind 대상 없음`);
          const source = bound[0]!;
          rebindSource = { card: source, terminalRunEvidence: source.status === 'launched' ? checkRun(source, view) : false };
        }
        const chosen = observedChecklist ?? checklist;
        const result = adoptExistingPr({ pr: view, repo, statePath: deps.taskStatePath ?? taskStatePathDefault(),
          ...(opts.card ? { cardId: opts.card, version: cardVersion, terminalRunEvidence, unlinkedTerminal: unlinkedTerminalUsed, observedChecklist,
            observedRun: { runId: targetCard?.runId, runChildId: targetCard?.runChildId, parentHost: targetCard?.parentHost?.host, launchId: targetCard?.launchId } } : {}),
          ...(rebindSource ? { rebindSource } : {}),
          ...(opts.rebind && opts.version ? { version: opts.version } : {}),
          ...(chosen ? { checklistAtWrite: () => (deps.adoptChecklist ?? listChecklist)(chosen.version).items.find((item) => item.id === chosen.id) } : {}),
          ...(checklist ? { checklist } : {}) });
        try { debug.log('task-agent', 'pr-adopted', { card: result.card.id, pr: number, head: view.headRefOid, created: result.created, changed: result.changed, launched: false }); } catch { /* fail-soft */ }
        if (opts.json) out(JSON.stringify({ card: result.card.id, ...(result.previousCardId ? { previousCard: result.previousCardId } : {}), pr: number, head: view.headRefOid, created: result.created, changed: result.changed, next: `tasks rejudge ${result.card.id}` }));
        else out(`${result.card.id}\tPR #${number}\t${result.changed ? 'adopted' : 'already-adopted'}${result.previousCardId ? ` · 이전 카드 ${result.previousCardId} 결속 해제` : ''}\t구현 발사 0 · 다음: tasks rejudge ${result.card.id}`);
      } catch (error) {
        out(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  tasks.command('adopt-runs')
    .description('TA-OWN-ALL-RUNS 백필 — 발사 등록부의 이 우주 런 중 카드 없는 것에 `ta-<runId>` 카드를 만든다(발사 훅 이전 런 몫 · 있으면 건드리지 않는다)')
    .option('--json', 'JSON 출력')
    .action(async (opts: { json?: boolean }) => {
      const { adoptUncardedRuns } = await import('../task-agent/run-adopt.js');
      const report = adoptUncardedRuns({ ...(deps.taskStatePath ? { statePath: deps.taskStatePath } : {}), ...deps.adoptRuns });
      try { debug.log('task-agent', 'run-adopt-backfill', report); } catch { /* fail-soft */ }
      if (opts.json) { out(JSON.stringify(report)); return; }
      const skipped = Object.entries(report.skipped).sort(([a], [b]) => a.localeCompare(b)).map(([reason, n]) => `${reason} ${n}`).join(' · ') || '없음';
      out(`등록부 런 ${report.scanned} · 카드 만듦 ${report.adopted} · 건너뜀 ${skipped}`);
    });

  tasks.command('board')
    .description('보드 — 프로젝트 › 목표 › 이정표 › 과제. 과제 카드(project·goal·milestone)와 내부 팩(릴리스 체크리스트 = elanous › 판 › 칸)을 합쳐 읽는다(쓰지 않는다)')
    .option('--project <id>', '이 프로젝트만')
    .option('--json', 'JSON 출력')
    .action(async (opts: { project?: string; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      try {
        // 내부 팩은 elanous 프로젝트만 낸다 — 다른 프로젝트로 거르면 릴리스 원장을 열지 않는다(그 원장의 오류가 카드 보드를 막지 않게).
        const { cardsBoard, countBoardTasks, INTERNAL_PACK_PROJECT, mergeBoards, releasePackBoard } = await import('../task-agent/board.js');
        const wantsPack = opts.project === undefined || opts.project === INTERNAL_PACK_PROJECT;
        const board = mergeBoards(
          cardsBoard(deps.taskStatePath ?? taskStatePathDefault()),
          wantsPack ? (deps.releaseBoard ?? (() => releasePackBoard(checklistDevVersion())))() : [],
        );
        // 무소속(unassigned: true)은 어떤 --project 로도 고르지 않는다 — 실제 프로젝트 id 와 겹치지 않게.
        const selected = opts.project !== undefined ? board.filter((project) => project.unassigned !== true && project.id === opts.project) : board;
        try { debug.log('task-agent', 'board', { projects: selected.length, tasks: countBoardTasks(selected), project: opts.project ?? null }); } catch { /* fail-soft */ }
        if (opts.json) out(JSON.stringify(selected));
        else {
          const show = (node: BoardNode, depth: number): void => {
            out(`${'  '.repeat(depth)}${node.level}\t${node.id}\t${node.status}\t${headLine(node.title)}`);
            for (const next of node.children ?? []) show(next, depth + 1);
          };
          if (selected.length === 0) out(opts.project !== undefined ? `프로젝트 없음: ${opts.project}` : '보드가 비어 있다');
          for (const project of selected) show(project, 0);
        }
      } catch (error) {
        out(error instanceof Error ? error.message : '보드 읽기 실패');
        process.exitCode = 1;
      }
    });

  tasks.command('advance [missionId]')
    .description('TASK-AGENT 미션 ② — 조각의 PR 병합(근거: `--pr`/`--goal` 로 카드에 적은 PR 번호·골 id)으로 착지를 가르고 새로 준비된 조각만 한 번 넘긴다 · 모두 착지면 green «제안»만 적는다 · 기본 shadow(발사 0)')
    .option('--all', 'green 제안이 아직 없는 미션 전부')
    .option('--pr <pieceId=N>', '조각 카드에 그 런의 PR 번호를 적는다(반복 가능)', collectPair)
    .option('--goal <pieceId=goalId>', '조각 카드에 골 id(16자)를 적는다 — 런 원장 pr-opened 로 PR 을 찾는다(반복 가능)', collectPair)
    .option('--live', '준비된 조각을 실제로 발사한다(기본은 shadow)')
    .option('--json', 'JSON 출력')
    .action(async (missionId: string | undefined, opts: { all?: boolean; pr?: Array<[string, string]>; goal?: Array<[string, string]>; live?: boolean; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      const { advanceMission, MissionAdvanceError, openMissionIds, recordPieceRef } = await import('../task-agent/mission.js');
      const started = Date.now();
      if ((missionId === undefined) === (opts.all !== true)) {
        const reason = '미션 id «또는» --all 중 하나만 준다';
        try { debug.log('task-agent', 'mission-advance', { missionId: missionId ?? null, all: opts.all === true, mode: opts.live ? 'live' : 'shadow', stage: 'cli-args', error: reason, ms: Date.now() - started }); } catch { /* fail-soft */ }
        out(reason);
        process.exitCode = 1;
        return;
      }
      const statePath = deps.taskStatePath;
      try {
        // 근거 인자는 운영자 입력이다 — 모양을 «먼저» 전부 검사해 하나라도 틀리면 아무것도 적지 않고 진행도 안 한다.
        const refs: Array<[string, { pr: number } | { goalId: string }]> = [
          ...(opts.pr ?? []).map(([pieceId, value]): [string, { pr: number }] => {
            if (!/^#?[1-9]\d*$/.test(value)) throw new Error(`PR 번호가 아니다: ${value}`);
            return [pieceId, { pr: Number(value.replace(/^#/, '')) }];
          }),
          ...(opts.goal ?? []).map(([pieceId, value]): [string, { goalId: string }] => {
            if (!/^[a-f0-9]{16}$/.test(value)) throw new Error(`골 id 는 16자 hex 다: ${value}`);
            return [pieceId, { goalId: value }];
          }),
        ];
        const twice = refs.map(([pieceId]) => pieceId).filter((pieceId, at, all) => all.indexOf(pieceId) !== at);
        if (twice.length) throw new Error(`한 조각에 근거를 두 번 줬다(--pr·--goal 은 조각마다 하나): ${[...new Set(twice)].join(', ')}`);
        // 기록 실패(없는 조각 · 제안된 미션)는 그 근거만 실패로 적고 계속 — `--all` 의 나머지 미션을 막지 않는다.
        const refFailures: string[] = [];
        for (const [pieceId, ref] of refs) {
          try { recordPieceRef(pieceId, ref, statePath, missionId); } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (missionId !== undefined) throw error;
            refFailures.push(reason);
          }
        }
        const ids = missionId !== undefined ? [missionId] : openMissionIds(statePath);
        const results: AdvanceMissionResult[] = [];
        const failures: Array<{ missionId: string; error: string }> = [];
        for (const id of ids) {
          try {
            results.push(await advanceMission(id, {
              live: opts.live === true,
              ...(statePath ? { statePath } : {}),
              launcher: deps.taskLauncher ?? defaultTaskLauncher,
              ...(deps.pieceEvidence ? { readEvidence: deps.pieceEvidence } : {}),
              ...(deps.cardRunEvidence ? { runEvidence: deps.cardRunEvidence } : {}),
            }));
          } catch (error) {
            // 미션 id 하나면 그대로 실패 · --all 이면 그 미션만 실패로 적고 다음 미션으로 간다(크론이 한 미션에 막히지 않게).
            if (missionId !== undefined) throw error;
            failures.push({ missionId: id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (missionId === undefined) {
          // --all 은 호출마다 요약 한 줄 — 대상 0·근거 기록 실패뿐인 호출도 관측에 남는다(미션별 줄은 advanceMission 이 남긴다).
          try { debug.log('task-agent', 'mission-advance', { missionId: null, all: true, mode: opts.live ? 'live' : 'shadow', stage: 'all-summary', missions: ids.length, advanced: results.length, failures: failures.map((failure) => failure.missionId), refFailures: refFailures.length, ms: Date.now() - started }); } catch { /* fail-soft */ }
        }
        if (opts.json) out(JSON.stringify(missionId !== undefined ? results[0] : failures.length || refFailures.length ? { results, failures, refFailures } : results));
        else {
          if (results.length === 0 && failures.length === 0) out('넘길 미션이 없다 (green 제안 전 미션 0)');
          for (const failure of failures) out(`${failure.missionId}\tadvance\tfailed\t${failure.error}`);
          for (const reason of refFailures) out(`근거 기록 실패: ${reason}`);
          for (const result of results) for (const line of advanceLines(result)) out(line);
          if (!opts.live && results.some((result) => result.handed.length > 0)) out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
        }
        if (failures.length || refFailures.length || results.some((result) => result.handed.some((piece) => piece.error))) process.exitCode = 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : '미션 진행 실패';
        // advanceMission 에 닿기 전(근거 인자 검사·기록)에 멈춘 호출도 한 줄 — 관측이 «호출마다» 남는다.
        // advanceMission 안에서 던진 것은 거기서 이미 남겼다(같은 오류를 두 번 적지 않는다).
        if (!(error instanceof MissionAdvanceError)) {
          try { debug.log('task-agent', 'mission-advance', { missionId: missionId ?? null, all: opts.all === true, mode: opts.live ? 'live' : 'shadow', stage: 'cli-args', error: reason, ms: Date.now() - started }); } catch { /* fail-soft */ }
        }
        out(reason);
        process.exitCode = 1;
      }
    });

  registerTaskShowCommand(tasks, ctx);

  tasks.command('rejudge [id]')
    .description('TA-REJUDGE-ON-HEAD — 런 멈춤 뒤 카드 PR 머리가 바뀌었으면 재게이트(떼어 띄움)·리뷰 재요청·land(재게이트 통과 ⊕ 지금 머리 pass ⊕ must-fix 0 · 겹침 증거)를 다시 판단한다 · 허용은 설정 taskAgent.liveMoves 그대로')
    .option('--all', '묶인 PR 로 TA 리뷰를 요청한 적이 있는 카드 전부')
    .option('--json', 'JSON 출력')
    .action(async (id: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      if ((id === undefined) === (opts.all !== true)) { out('카드 id «또는» --all 중 하나만 준다'); process.exitCode = 1; return; }
      const { rejudgeCandidates, rejudgeCardOnHead } = await import('../task-agent/rejudge-on-head.js');
      const statePath = deps.taskStatePath ?? taskStatePathDefault();
      let ids: string[];
      try {
        if (!id) {
          const { bindMirroredRemoteRejudgeCards } = await import('../task-agent/remote-rejudge-bind.js');
          const { mirrorRemoteRunLedgers } = await import('../task-agent/parent-host.js');
          const cards = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
          const binding = await bindMirroredRemoteRejudgeCards(cards, statePath, deps.cardRunEvidence?.ssh
            ? { mirror: (target, runId, root) => mirrorRemoteRunLedgers(target, runId, root, deps.cardRunEvidence!.ssh) }
            : {});
          try { debug.log('task-agent', 'remote-rejudge-bind', binding); } catch { /* fail-soft */ }
        }
        if (id) ids = [id];
        else {
          const maxAgeHours = (await import('../user-config.js')).getUserConfig().taskAgent?.rejudgeMaxAgeHours ?? 72;
          const cards = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
          const candidates = rejudgeCandidates(cards, { maxAgeHours, onAgeSkip: (card, ageHours) => {
            try { debug.log('task-agent', 'rejudge-age-skip', { card: card.id, ageHours, maxAgeHours }); } catch { /* fail-soft */ }
          } });
          const { capturedLandReview } = await import('../task-agent/review-result-capture.js');
          const { defaultPrHead, defaultReviewRepoCandidates } = await import('../task-agent/live-moves.js');
          const currentHeads = new Map<string, string>();
          // Priority is a hint, not a gate. Consider only the three newest candidates;
          // a non-mf0 card still consumes one of those three places. Everyone else runs in age order.
          const priorityCandidates = candidates.slice(0, 3);
          let headProbes = 0;
          for (const cardId of priorityCandidates) {
            const card = cards[cardId];
            if (!card || typeof card.pr !== 'object' || !card.pr?.url) continue;
            const pr = card.pr.number;
            const lastHead = card.reviewRequests?.filter((entry) => entry.pr === pr).at(-1)?.head;
            if (!lastHead || capturedLandReview(card, pr, lastHead)?.mustFixCount !== 0) continue;
            let repos: readonly import('../task-agent/live-moves.js').ReviewRepoCandidate[] = [];
            try { repos = (deps.rejudge?.live?.repoCandidates ?? defaultReviewRepoCandidates)(card); } catch { /* no trusted repo */ }
            const repo = repos[0];
            if (!repo) continue;
            headProbes++;
            let view: Awaited<ReturnType<typeof defaultPrHead>>;
            try { view = await (deps.rejudge?.live?.prHead
              ? deps.rejudge.live.prHead(pr, repo.cwd)
              : defaultPrHead(pr, repo.cwd, (args, options) => spawnSync('gh', args, {
                encoding: 'utf8', timeout: 3_000, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}),
              }))); } catch { view = null; }
            if (view?.state === 'OPEN' && view.url === card.pr.url) currentHeads.set(cardId, view.head);
          }
          if (candidates.length > priorityCandidates.length) {
            try { debug.log('task-agent', 'rejudge-head-priority-probe-cap', { considered: priorityCandidates.length,
              probed: headProbes, totalCandidates: candidates.length, max: 3 }); } catch { /* fail-soft */ }
          }
          ids = rejudgeCandidates(cards, { maxAgeHours, currentHeads });
        }
      } catch (error) {
        out(error instanceof Error ? error.message : '과제 카드 읽기 실패'); process.exitCode = 1; return;
      }
      const { configuredTaskAgentLiveMoves } = await import('../task-agent/live-moves.js');
      const liveMoves = deps.rejudge?.liveMoves ?? await configuredTaskAgentLiveMoves();
      const repairBudget = opts.all ? { max: (await import('../user-config.js')).getUserConfig().taskAgent?.repairMaxPerTick ?? 3,
        requested: 0, capped: 0 } : undefined;
      const reviewBudget = opts.all ? { max: 1, requested: 0 } : undefined;
      const landBudget = opts.all ? { max: 1, requested: 0 } : undefined;
      const all = [];
      const { replayRemoteCardMoves } = await import('../task-agent/shadow.js');
      for (const cardId of ids) {
        const { mirrorRemoteCardLedger } = await import('./tasks-card-show.js');
        await mirrorRemoteCardLedger(cardId, deps);
        try { await replayRemoteCardMoves(cardId, statePath, deps.cardRunEvidence ?? {}); } catch (error) {
          try { debug.log('task-agent', 'card-binding-replay-failed', { card: cardId, reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
        }
        let outcomes: Awaited<ReturnType<typeof rejudgeCardOnHead>>;
        try { outcomes = await rejudgeCardOnHead(cardId, { ...deps.rejudge, liveMoves,
          ...(repairBudget ? { repairBudget } : {}), ...(reviewBudget ? { reviewBudget } : {}), ...(landBudget ? { landBudget } : {}),
          live: { ...deps.rejudge?.live, statePath } }); } catch (error) {
          // 카드 하나의 예외가 --all 의 나머지 카드 판단을 멈추지 않게 — 사유를 남기고 다음 카드로.
          const reason = (error instanceof Error ? error.message : String(error)).slice(-300);
          try { debug.log('task-agent', 'rejudge-on-head', { card: cardId, pr: null, fromHead: null, toHead: null, step: 'target', decision: 'rejudge-threw', reason }, { level: 'warn' }); } catch { /* fail-soft */ }
          outcomes = [{ card: cardId, pr: null, fromHead: null, toHead: null, step: 'target', decision: 'rejudge-threw', reason }];
          process.exitCode = 1;
        }
        all.push(...outcomes);
        if (!opts.json) for (const o of outcomes) out([o.card, `PR ${o.pr === null ? '-' : `#${o.pr}`}`, `${o.fromHead?.slice(0, 12) ?? '-'}→${o.toHead?.slice(0, 12) ?? '-'}`, o.step, o.decision, o.reason].join('\t'));
      }
      if (opts.json) out(JSON.stringify(all));
    });

  tasks.command('regate-run', { hidden: true })
    .description('TA-REJUDGE-ON-HEAD 내부 — 카드 PR 머리 하나의 호스트 재게이트(병합 없음)를 돌리고 결과를 --out 파일로 쓴다(tasks rejudge 가 떼어 띄운다)')
    .requiredOption('--card <id>').requiredOption('--pr <n>').requiredOption('--head <sha>').requiredOption('--repo <root>').requiredOption('--out <path>')
    .action(async (opts: { card: string; pr: string; head: string; repo: string; out: string }) => {
      await registerTaskAgentSink(deps.registerSink);
      const pr = Number(opts.pr);
      const { writeFileSync: write, mkdirSync: mkdir } = await import('node:fs');
      const { dirname: dir } = await import('node:path');
      let result: import('../self-implement/host-regate.js').HostRegateResult;
      try {
        const regate = deps.hostRegate ?? (await import('../self-implement/host-regate.js')).runHostRegate;
        result = await regate({ prNumber: pr, headCommit: opts.head, repoRoot: opts.repo, noMerge: true });
      } catch (error) {
        result = { passed: false, failures: [{ step: 'host-regate', detail: (error instanceof Error ? error.message : String(error)).slice(-300) }], os: process.platform, status: 'unmeasured' };
      }
      const record = { pr, head: opts.head, passed: result.passed, ...(result.status ? { status: result.status } : {}), ...(result.baseCommit ? { baseCommit: result.baseCommit } : {}), failures: result.failures };
      try { debug.log('task-agent', 'regate-run', { card: opts.card, ...record, failures: result.failures.slice(0, 3) }); } catch { /* fail-soft */ }
      mkdir(dir(opts.out), { recursive: true });
      write(opts.out, JSON.stringify(record));
      if (deps.regateCompletion !== false) {
        try {
          const { rejudgeCompletedTaskRegate } = await import('../task-agent/rejudge-on-head.js');
          await rejudgeCompletedTaskRegate(opts.card, pr, opts.head, opts.out, deps.taskStatePath ?? taskStatePathDefault(), undefined, deps.rejudge);
        } catch (error) {
          try { debug.log('task-agent', 'regate-completion-rejudge-failed', { card: opts.card, pr, head: opts.head, reason: String(error).slice(-300) }, { level: 'warn' }); } catch { /* fail-soft */ }
        }
      }
      if (!result.passed) process.exitCode = 1;
    });

  tasks.command('repair-run', { hidden: true })
    .description('TA-REPAIR-SAME-BRANCH 내부 — source PR 머리에서 commit-only Pod 수리를 실행하고 결과를 파일로 남긴다')
    .requiredOption('--card <id>').requiredOption('--pr <n>').requiredOption('--head <sha>')
    .requiredOption('--repo <root>').requiredOption('--out <path>').requiredOption('--goal-file <path>')
    .requiredOption('--run-id <id>').requiredOption('--model-provider <provider>').requiredOption('--model-id <id>')
    .option('--role-llm <role=provider[/tier]>', 'TA 부모 역할 고정(task hand와 같은 문법 · 반복 가능)', (value: string, previous: string[] = []) => [...previous, value])
    .option('--seat <seat>')
    .option('--move-id <id>', 'HARNESS-FULL-GRAPH-NEXTMOVE — 이 발사를 고른 next-move 결정의 수 id(결과 파일·완료 사건에 그대로 싣는다)')
    .action(async (opts: { card: string; pr: string; head: string; repo: string; out: string; goalFile: string;
      runId: string; modelProvider: string; modelId: string; seat?: string; moveId?: string; roleLlm?: string[] }) => {
      const { readFileSync } = await import('node:fs');
      const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { runRepairWorker } = await import('../task-agent/repair-worker.js');
      const result = await runRepairWorker({ card: opts.card, pr: Number(opts.pr), head: opts.head,
        repo: opts.repo, resultPath: opts.out, entry: ELANOUS_CLI_ENTRY,
        configDir: getElanousConfigDirOverride() ?? effectiveInstanceRoot(), runId: opts.runId,
        model: { provider: opts.modelProvider, model: opts.modelId }, seat: opts.seat,
        ...(opts.roleLlm?.length ? { parentRoleLlm: opts.roleLlm } : {}),
        ...(opts.moveId ? { moveId: opts.moveId } : {}),
        goal: readFileSync(opts.goalFile, 'utf8') });
      if (!result.ok) process.exitCode = 1;
    });

  tasks.command('approve <id...>')
    .description('외부 태스크 승인')
    .action(async (ids: string[]) => {
      try {
        ctx.clearToken();
        const auth = authenticate();
        let failed = false;
        for (const id of ids) {
          try {
            const response = await request(deps, auth, `/v1/tasks/${encodeURIComponent(id)}/approve`, 'POST');
            if (!response.ok) {
              out(`${id}\tfailed HTTP ${response.status}`);
              failed = true;
              continue;
            }
            const result = await responseJson(response) as { already?: boolean };
            out(`${id}\t${result?.already ? 'already' : 'approved'}`);
          } catch (error) {
            if (error instanceof NexusUnavailable) {
              out(`${id}\tfailed ${NEXUS_DOWN}`);
              process.exitCode = 2;
            } else {
              out(`${id}\tfailed 응답 JSON이 유효하지 않다`);
              failed = true;
            }
          }
        }
        if (failed && process.exitCode !== 2) process.exitCode = 1;
      } catch (error) { handleError(error, out); }
    });
}
