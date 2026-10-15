import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadRunLedger as loadRunLedgerSync, loadRunLedgerWithMetadata, runLedgerDir, resolveFederatedRunLedgerDirectories } from '../self-implement/run-ledger.js';
import { goalRunDbPath, loadGoalRunQuery } from '../self-implement/goal-run-store.js';
import { loadGoalAskRecords } from '../self-implement/goal-ask-store.js';
import { dirname, join, resolve } from 'node:path';
import { InvalidArgumentError, Option, type Command } from 'commander';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime } from '../nexus/runtime.js';
import { checklistDevVersion, listChecklist } from '../release-loop/checklist.js';
import { assignedVersions, releasedVersion, validateVersion } from '../release-loop/feature-store.js';
import { compareVersions } from '../directives/version-at.js';
import { cardsBoard, countBoardTasks, INTERNAL_PACK_PROJECT, mergeBoards, releasePackBoard, type BoardNode } from '../task-agent/board.js';
import type { Task } from '../task-orchestrator/types.js';
import { cardPrNumber, CLOSED_BY_HAND_EVENT, closeTaskCard, COMPLETION_KINDS, handTask, updateTaskCard, LIVE_MOVE_HISTORY_EVENT, LIVE_MOVE_RESULT_EVENT, nextMoveFor, resolveHandText, readTaskAgentState, readTaskCard, taskAgentStatePath as taskStatePathDefault, shellQuote, TASK_CARD_PREFIX, TASK_SEATS, type CompletionKind, type TaskCard, type TaskLaunchContext, type TaskLaunchReceipt, type TaskLauncher, type TaskSeat } from '../task-agent/task-hand.js';
import { readCardSalvageBranch, recordWiringLiveVerified, refreshCardRunBinding, type CardRunEvidenceDeps } from '../task-agent/card-evidence.js';
import { captureReviewResults } from '../task-agent/review-result-capture.js';
import { replayRemoteCardMoves } from '../task-agent/shadow.js';
import { remoteLedgerMirrorDirs } from '../task-agent/parent-host.js';
import { ambiguousGreenSweepPrs, decideGreenSweep, greenSweepCandidates, observeGreenSweep, type GreenSweepPr } from '../task-agent/green-sweep.js';
import { HAND_MOVE_KINDS, recordHandMove } from '../task-agent/live-move-history.js';
import { advanceMission, handMission, MissionAdvanceError, openMissionIds, recordPieceRef, type AdvanceMissionResult, type MissionDecompose, type PieceEvidenceReader } from '../task-agent/mission.js';
import { formatSevenVerbLive, formatTaskAgentCover, measureSevenVerbLive, measureTaskAgentCover, type CoverRow, type ImplementCardRunBinding, type ImplementRunMergeEvent, type SevenVerbLive, type TaskAgentCoverInput } from '../task-agent/cover.js';
import { LogStore, STORE_SAFETY_MAX, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';
import { resolveLogTargets } from './logs-cli.js';

type TaskRow = Pick<Task, 'id' | 'title' | 'priority' | 'status' | 'createdAt' | 'approval' | 'generatedBy'>;

export interface TasksCliDeps {
  baseUrl?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  output?: (line: string) => void;
  /** `task hand --live` 의 발사기(시험 주입). 기본은 운영 config-dir 로 `harness say` 를 떼어 띄운다. */
  taskLauncher?: TaskLauncher;
  /** TA-REVIEW-RESULT-CAPTURE — `tasks show` 의 리뷰 결과 회수 시각(시험 주입 · 기본 지금). */
  reviewResultNow?: () => Date;
  /** 과제 카드 상태 파일(시험 주입). 기본 = `effectiveInstanceRoot()/task-agent-actions.json`. */
  taskStatePath?: string;
  /** 조합 선택 시험에서만 그래프 저장소 루트를 바꾼다. */
  taskCompositionRoot?: string;
  /** logs.db 싱크 등록(시험 주입). 기본 = `registerStandaloneLogSink`. `hand`·`show` 가 부른다. */
  registerSink?: (surface: string) => Promise<unknown>;
  /** `task hand --mission` 의 분해기(시험 주입). 기본 = 나열형은 결정론 · 아니면 `decomposeSelfDevGoal`. */
  missionDecompose?: MissionDecompose;
  /** `task advance` 의 착지 근거 읽기(시험 주입). 기본 = `predecessorState`(gh · 런 원장). */
  pieceEvidence?: PieceEvidenceReader;
  /** `task board` 의 내부 팩 어댑터(시험 주입). 기본 = 현재 판(`checklistDevVersion()`)의 `releasePackBoard` — 읽기만. */
  releaseBoard?: (version?: string) => BoardNode[];
  /** `tasks hand --checklist` 판 목록(시험 주입). 기본은 발행 전 체크리스트가 있는 판 전부. */
  releaseVersions?: () => string[];
  /** Isolated checklist read for PR adoption. */
  adoptChecklist?: typeof listChecklist;
  /** `tasks adopt-pr` live PR read seam; default is gh in this repository. */
  adoptPrView?: (number: number, cwd: string) => import('../task-agent/adopt-pr.js').AdoptPrView;
  /** Isolated ledger proof for a launched card being adopted. */
  adoptRunTerminal?: typeof import('../task-agent/adopt-pr.js').adoptedRunTerminal;
  /** `tasks show`·`advance` 의 런 근거 읽기(시험 주입) — 기본 = 런 원장(이 우주 ⊕ 연합) ⊕ 호스트 logs 의 Pod job-finished. */
  cardRunEvidence?: CardRunEvidenceDeps;
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

/** `tasks hand`·`show` 가 남기는 `task-agent` 관측의 logs.db surface 라벨. */
export const TASK_AGENT_SINK_SURFACE = 'task-agent';

/**
 * 독립 CLI 프로세스는 데몬의 logs.db 싱크를 상속하지 않는다 — 등록하지 않으면 `debug.log('task-agent', …)` 가
 * 파일 트레일에만 남고 `elanous logs --category task-agent` 에 0건으로 보인다(10-06 실측: 카드 3장 · 이벤트 0).
 * fail-open — 등록 실패가 과제 넘기기를 막지 않는다.
 */
export async function registerTaskAgentSink(register?: (surface: string) => Promise<unknown>): Promise<void> {
  try {
    const fn = register ?? (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink;
    await fn(TASK_AGENT_SINK_SURFACE);
  } catch { /* fail-open — 파일 트레일이 진실원 */ }
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
  /** 원격 → 로컬 되돌림 알림(시험 주입). 기본 = stderr 한 줄. */
  notice?: (line: string) => void;
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
  const notice = deps.notice ?? ((line: string) => { try { process.stderr.write(`${line}\n`); } catch { /* ignore */ } });
  const failed = (target: typeof targets[number], gaps: string[], facts: Record<string, string> = {}): void => {
    try { debug.log('task-agent', 'parent-host-fallback', { host: target.host, runId: context.runId, gaps, facts }); } catch { /* fail-soft */ }
    notice(`[parent-host] ${target.host} 로 못 띄움 — ${multi ? '다음 호스트 또는 로컬 발사로 간다' : '로컬 발사로 간다'}: ${gaps.join(' · ')}`);
  };
  if (cwd) {
    failed(targets[0]!, ['project-target-is-local']);
    return null;
  }
  let launchHoldActive = false;
  try {
    if (deps.launchHoldActive) launchHoldActive = deps.launchHoldActive();
    else {
      const { readLandingFreeze } = await import('../release-loop/landing-freeze.js');
      const { prodInstanceRoot } = await import('../instance/resolve.js');
      launchHoldActive = readLandingFreeze(prodInstanceRoot())?.holdLaunches === true;
    }
  } catch { launchHoldActive = true; /* 못 읽으면 막힌 것으로(fail-closed) */ }
  const capacities = Object.fromEntries(multi ? targets.map((target) => [target.host, parentHostModule.readParentHostCapacity(target, deps.ssh)]) : []);
  const ordered = multi ? parentHostModule.orderParentHosts(targets, context.runId, capacities) : targets;
  for (const target of ordered) {
    if (multi && (!capacities[target.host] || capacities[target.host]!.approvalHeadroom <= 0)) {
      failed(target, ['capacity-unavailable']);
      continue;
    }
    let preflight: ReturnType<typeof parentHostModule.preflightParentHost>;
    try { preflight = parentHostModule.preflightParentHost({ target, localVersion: deps.localVersion ?? parentHostModule.localElanousVersion(), launchHoldActive, ...(deps.ssh ? { ssh: deps.ssh } : {}) }); }
    catch (error) { failed(target, [`preflight-error: ${error instanceof Error ? error.message : String(error)}`]); continue; }
    if (!preflight.ok) { failed(target, preflight.gaps, preflight.facts); continue; }
    if (preflight.warnings.length) notice(`⚠ ${target.host} 자격: ${preflight.warnings.join(' · ')}`);
    try {
      const launched = parentHostModule.launchRemoteParent(target, args, context.env, deps.ssh);
      try { debug.log('task-agent', 'parent-host-launched', { host: target.host, runId: context.runId, pid: launched.pid, log: launched.log }); } catch { /* fail-soft */ }
      return { runId: context.runId, parentHost: { host: target.host, ...(target.configDir ? { configDir: target.configDir } : {}), pid: launched.pid, log: launched.log } };
    } catch (error) {
      if (error instanceof parentHostModule.RemoteParentNotLaunchedError) { failed(target, [error.message]); continue; }
      try { debug.log('task-agent', 'parent-host-launch-uncertain', { host: target.host, runId: context.runId, error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
      throw error;
    }
  }
  return null;
}

/** stderr 파일의 첫 비어 있지 않은 줄(최대 4KB 만 읽는다 — 원 로그 꼬리를 싣지 않는다). */
function firstStderrLine(path: string): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
    } finally { closeSync(fd); }
  } catch { return ''; }
}

export async function defaultTaskLauncher(args: string[], cwd?: string, context?: TaskLaunchContext, deps: DefaultTaskLauncherDeps = {}): Promise<void | TaskLaunchReceipt> {
  if (context) {
    const remote = await tryRemoteParent(args, cwd, context, deps);
    if (remote) return remote;
  }
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
    const first = firstStderrLine(stderrPath);
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

/** HARNESS-PARENT-ON-MSB1 — 카드가 원격 부모면 그 런 원장(⊕ Pod 자식)을 HQ 거울로 당긴다. 실패는 관측만(«없음»으로 읽히지 않게). */
async function mirrorRemoteCardLedger(cardId: string, deps: TasksCliDeps): Promise<void> {
  let card: TaskCard | undefined;
  try { card = readTaskCard(cardId, deps.taskStatePath); } catch { return; }
  if (!card?.parentHost || !card.runId) return;
  try {
    if (deps.remoteLedgerMirror) { deps.remoteLedgerMirror(card); return; }
    const { mirrorRemoteRunLedgers } = await import('../task-agent/parent-host.js');
    const { effectiveInstanceRoot } = await import('../instance/resolve.js');
    mirrorRemoteRunLedgers(card.parentHost, card.runId, effectiveInstanceRoot(), deps.cardRunEvidence?.ssh);
  } catch (error) {
    try { debug.log('task-agent', 'remote-ledger-mirror-failed', { card: cardId, host: card.parentHost.host, runId: card.runId, error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
  }
}

function moveLine(card: TaskCard): string {
  const move = nextMoveFor(card);
  return `${move.kind}${move.command ? ` — elanous ${move.command.map(shellQuote).join(' ')}` : ''} (${move.reason})`;
}

function headLine(text: string): string {
  const first = text.split('\n')[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

/** 런 연결 한 줄 — 런 id 가 없으면 없다(옛 카드 · shadow). */
function runLinkLine(card: TaskCard): string[] {
  if (!card.runId) return [];
  const number = cardPrNumber(card);
  const url = typeof card.pr === 'object' ? card.pr.url : undefined;
  const pr = number !== undefined ? `#${number}${url ? ` ${url}` : ''}` : '-';
  return [`런: ${card.runId} · 골: ${card.goalId ?? '-'} · PR: ${pr}${card.runChildId ? ` · 자식 런: ${card.runChildId}` : ''}`];
}

function taskCardLines(card: TaskCard): string[] {
  return [
    [card.id, card.status, card.seat ?? '-', card.checklistId ?? '-', card.createdAt, card.text].join('\t'),
    ...(card.mission ? [`미션: ${card.mission} · after: ${card.after?.length ? card.after.join(', ') : '-'}`] : []),
    ...runLinkLine(card),
    ...liveMoveLines(card),
    `다음 수: ${moveLine(card)}`,
  ];
}

/** TA-LIVE-MOVE-CARD-HISTORY — 카드 history 의 live-move 줄(실행·그림자)을 한 줄씩. 없으면 없다(옛 카드 그대로). */
function liveMoveLines(card: TaskCard): string[] {
  return (card.history ?? []).filter((item) => item.event === LIVE_MOVE_HISTORY_EVENT || item.event === LIVE_MOVE_RESULT_EVENT).map((item) => item.event === LIVE_MOVE_RESULT_EVENT ? [
    // TA-REVIEW-RESULT-CAPTURE — 회수한 리뷰 결과(또는 «결과 없음») 줄.
    `결과: ${item.at}`, `${item.kind ?? '?'}`, `PR ${item.pr !== undefined ? `#${item.pr}` : '-'}${item.head ? ` head ${item.head.slice(0, 12)}` : ''}`,
    `verdict=${item.verdict ?? '—'} reviewed=${item.reviewed ?? '—'} must-fix=${item.mustFix ?? '—'} route=${item.reviewRoute ?? '—'}`,
    `효과: ${item.effect ?? 'unknown'}`, (item.detail ?? '').replace(/\r\n|\r|\n/g, (match) => (match === '\r' ? '\\r' : '\\n')),
  ].join(' · ') : [
    `수: ${item.at}`, `${item.kind ?? '?'} ${item.executorResult ?? '?'}`, `executed=${item.executed === true} ok=${item.ok === undefined ? '—' : item.ok}`,
    `PR ${item.pr !== undefined ? `#${item.pr}` : '-'}${item.head ? ` head ${item.head.slice(0, 12)}` : ''}`,
    `효과: ${item.effect ?? 'unknown'}`, (item.detail ?? '').replace(/\r\n|\r|\n/g, (match) => (match === '\r' ? '\\r' : '\\n')),
  ].join(' · '));
}

/** 미션 카드 — 머리 한 줄 ⊕ 조각 한 줄씩(상태·다음 수·선행) ⊕ 간선 한 줄씩. */
function missionLines(mission: TaskCard, pieces: TaskCard[]): string[] {
  const edges = pieces.flatMap((piece) => (piece.after ?? []).map((before) => `간선: ${before} -> ${piece.id}`));
  return [
    [mission.id, 'mission', mission.seat ?? '-', mission.checklistId ?? '-', mission.createdAt, `조각 ${pieces.length} · 간선 ${edges.length} · 출처 ${mission.splitSource ?? '-'}`, headLine(mission.text)].join('\t'),
    ...pieces.map((piece) => [`조각: ${piece.id}`, piece.status, nextMoveFor(piece).kind, `after: ${piece.after?.length ? piece.after.join(',') : '-'}`, headLine(piece.text),
      ...(piece.runId ? [`런: ${piece.runId}${cardPrNumber(piece) !== undefined ? ` · PR #${cardPrNumber(piece)}` : ''}`] : [])].join('\t')),
    ...edges,
    ...(mission.greenProposal ? [`green 제안: ${mission.greenProposal.at} · 칸 ${mission.greenProposal.checklistId ?? '-'} · 근거 ${Object.entries(mission.greenProposal.evidence).map(([id, ref]) => `${id}=${ref}`).join(', ')}`] : []),
  ];
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const NEXUS_DOWN = '넥서스가 안 떠 있다 — `elanous nexus run`';

function taskOrder(a: TaskRow, b: TaskRow): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function taskSource(task: TaskRow): string {
  return task.generatedBy?.kind === 'external'
    ? `${task.generatedBy.provider}:${task.generatedBy.ref}` : '-';
}

function taskLine(task: TaskRow): string {
  return [task.id, task.priority, task.status, task.approval?.state ?? '-', taskSource(task), task.title].join('\t');
}

function credentials(deps: TasksCliDeps): { baseUrl: string; token?: string } | null {
  const port = deps.baseUrl !== undefined ? undefined : readNexusRuntime()?.httpPort;
  const baseUrl = deps.baseUrl ?? (port ? `http://127.0.0.1:${port}` : undefined);
  if (!baseUrl) return null;
  // Same as `connector linear sync`: an isolated (--test) universe has no acp-token and its
  // daemon accepts loopback callers without one — send the bearer only when there is one.
  let token = deps.bearerToken;
  if (token === undefined) {
    try { token = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim() || undefined; }
    catch { token = undefined; }
  }
  return { baseUrl, ...(token ? { token } : {}) };
}

class NexusUnavailable extends Error {}

async function request(deps: TasksCliDeps, auth: { baseUrl: string; token?: string }, path: string, method = 'GET'): Promise<Response> {
  try {
    return await (deps.fetch ?? fetch)(`${auth.baseUrl}${path}`, {
      method,
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
    });
  } catch {
    // Fetch exceptions can include the URL or credentials; never forward their text.
    throw new NexusUnavailable();
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error('넥서스 응답 JSON이 유효하지 않다'); }
}

function httpError(response: Response): Error {
  // Do not echo server-supplied error bodies: they may contain credentials.
  return new Error(`HTTP ${response.status}`);
}

function handleError(error: unknown, out: (line: string) => void): void {
  if (error instanceof NexusUnavailable) {
    out(NEXUS_DOWN);
    process.exitCode = 2;
  } else {
    out(error instanceof Error ? error.message : '태스크 요청 실패');
    process.exitCode = 1;
  }
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
function readImplementCardBindings(statePath: string): ImplementCardRunBinding[] {
  if (!existsSync(statePath)) throw new Error('TASK-AGENT card ledger is missing');
  const state = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath);
  if (state.tasks !== undefined && (!state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks))) {
    throw new Error('TASK-AGENT card ledger is malformed');
  }
  const cards = Object.entries(state.tasks ?? {});
  if (cards.length >= COVER_QUERY_LIMIT) throw new Error('TASK-AGENT card ledger reached query bound');
  return cards.map(([key, card]) => {
    if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.id !== 'string' || !card.id
      || card.id !== key || (card.runId != null && typeof card.runId !== 'string')
      || (card.runChildId != null && typeof card.runChildId !== 'string')) {
      throw new Error('TASK-AGENT card binding is malformed');
    }
    return { cardId: card.id, runId: card.runId, runChildId: card.runChildId };
  });
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
    input.implementCardRuns = goalReaders.coverImplementCardRuns
      ? goalReaders.coverImplementCardRuns()
      : readImplementCardBindings(goalReaders.taskStatePath ?? taskStatePathDefault());
  } catch { input.implementCardRuns = null; }
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
  } catch { input.implementRunMerges = null; }
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

export function registerTasksCommands(program: Command, deps: TasksCliDeps = {}): void {
  let activeToken: string | undefined;
  const output = deps.output ?? console.log;
  const out = (line: string) => output(activeToken ? line.replaceAll(activeToken, '[redacted]') : line);
  const authenticate = () => {
    const auth = credentials(deps);
    activeToken = auth?.token;
    if (!auth) throw new NexusUnavailable();
    return auth;
  };
  const tasks = program.command('tasks').alias('task').description('TOX 태스크 조회 및 승인 · TASK-AGENT 과제 넘기기(hand)');

  tasks.command('green-sweep')
    .description('병합된 과제 PR 과 칸 근거를 대조해 green/기록만/건너뜀을 미리 본다 (항상 dry-run)')
    .requiredOption('--version <version>', '조회할 체크리스트 판')
    .option('--cell <id>', '한 칸만 조회')
    .option('--traffic <path>', '실물 green 판정에는 traffic.json 필수 — 빠지거나 못 읽으면 hold 불명으로 보수 판정')
    .option('--json', 'JSON 출력')
    .action((opts: { version: string; cell?: string; traffic?: string; json?: boolean }) => {
      try {
        validateVersion(opts.version);
        const snapshot = listChecklist(opts.version);
        const cards = Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {});
        let holds: Set<string> | null = null;
        if (opts.traffic) {
          try {
            const traffic: unknown = JSON.parse(readFileSync(opts.traffic, 'utf8'));
            if (traffic && typeof traffic === 'object' && !Array.isArray(traffic)
              && Array.isArray((traffic as { hold?: unknown }).hold)
              && (traffic as { hold: unknown[] }).hold.every((id) => typeof id === 'string'))
              holds = new Set((traffic as { hold: string[] }).hold);
          } catch { /* unknown is not an empty hold set */ }
        }
        const prCache = new Map<number, GreenSweepPr | null>();
        const ambiguousPrs = ambiguousGreenSweepPrs(snapshot.items, opts.version, cards);
        const origin = spawnSync('git', ['remote', 'get-url', 'origin'],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
        const originRepo = origin.status === 0
          ? /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(origin.stdout.trim())?.[1]?.toLowerCase() : undefined;
        const localMain = spawnSync('git', ['rev-parse', 'origin/main'],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
        const remoteMain = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
        const localMainSha = localMain.status === 0 ? localMain.stdout.trim() : '';
        const remoteMainSha = remoteMain.status === 0 ? remoteMain.stdout.trim().split(/\s+/)[0] : '';
        const mainFresh = /^[a-f0-9]{40}$/i.test(localMainSha) && localMainSha === remoteMainSha;
        if (opts.cell && !snapshot.items.some((item) => item.id === opts.cell)) throw new Error(`없는 칸: ${opts.cell}`);
        const decisions = snapshot.items.filter((item) => !opts.cell || item.id === opts.cell).flatMap((item) => {
          const candidates = greenSweepCandidates(item, opts.version, cards);
          return candidates.map((candidate) => {
            let pr = prCache.get(candidate.pr);
            if (pr === undefined) {
              const view = spawnSync('gh', ['pr', 'view', String(candidate.pr), '--json', 'number,state,mergeCommit,url'],
                { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
              try {
                if (view.status !== 0) throw new Error('gh failed');
                const parsed = JSON.parse(view.stdout) as { number?: number; state?: string; mergeCommit?: { oid?: string }; url?: string };
                pr = parsed.number === candidate.pr && typeof parsed.state === 'string'
                  ? { number: candidate.pr, state: parsed.state, mergeSha: parsed.mergeCommit?.oid, url: parsed.url } : null;
              } catch { pr = null; }
              prCache.set(candidate.pr, pr);
            }
            const sha = pr?.mergeSha;
            const prRepo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:\/|$)/i.exec(pr?.url ?? '')?.[1]?.toLowerCase();
            const repositoryMatches = originRepo && prRepo ? originRepo === prRepo : null;
            const ancestor = !mainFresh || !sha || !/^[a-f0-9]{40}$/i.test(sha) ? null : (() => {
              const check = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'],
                { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
              return check.status === 0 ? true : check.status === 1 ? false : null;
            })();
            const decision = decideGreenSweep({ item, candidate, candidateCount: candidates.length,
              pr: pr ?? null, ancestor, hold: holds === null ? null : holds.has(item.id), repositoryMatches,
              ambiguousAcrossCells: ambiguousPrs.has(candidate.pr) });
            observeGreenSweep(decision);
            return decision;
          });
        });
        const counts = { candidate: decisions.length, green: decisions.filter((d) => d.verdict === 'green').length,
          recordOnly: decisions.filter((d) => d.verdict === 'record-only').length,
          skipped: decisions.filter((d) => d.verdict === 'skip').length };
        if (opts.json) out(JSON.stringify({ dryRun: true, version: opts.version, counts, decisions }));
        else {
          out(`dry-run · ${opts.version} · 후보 ${counts.candidate} · green ${counts.green} · 기록만 ${counts.recordOnly} · 건너뜀 ${counts.skipped}`);
          for (const d of decisions) out(`${d.verdict}\t${d.cell}\t#${d.pr}\t${d.mergeSha ?? '-'}\t${d.reason}\t${d.evidence}\tbefore=${JSON.stringify(d.existingEvidence)}\tafter=${JSON.stringify(d.plannedEvidence)}`);
          if (holds === null) out('⚠ hold 원장을 읽지 못해 green 없이 기록만 판정');
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

  tasks.command('list')
    .description('우선순위와 생성 시각 순으로 태스크 보기')
    .option('--status <s>', '상태로 필터')
    .option('--provider <p>', '외부 출처로 필터')
    .option('--json', 'JSON 출력')
    .action(async (opts: { status?: string; provider?: string; json?: boolean }) => {
      try {
        activeToken = undefined;
        const auth = authenticate();
        const response = await request(deps, auth, '/v1/tasks');
        if (!response.ok) throw httpError(response);
        const body = await responseJson(response) as { tasks?: Array<Pick<TaskRow, 'id' | 'status'>> };
        if (!Array.isArray(body?.tasks)) throw new Error('넥서스 태스크 목록 형식이 유효하지 않다');
        const cards = body.tasks.filter((task) => !opts.status || task.status === opts.status);
        // The list endpoint returns board cards without approval or provenance.
        // Obtain those fields from the detail endpoint rather than displaying guesses.
        const rows: TaskRow[] = [];
        for (const card of cards) {
          const detail = await request(deps, auth, `/v1/tasks/${encodeURIComponent(card.id)}`);
          if (!detail.ok) throw httpError(detail);
          const data = await responseJson(detail) as { task?: TaskRow };
          if (!data?.task || data.task.id !== card.id) throw new Error('넥서스 태스크 상세 형식이 유효하지 않다');
          if (!opts.provider || (data.task.generatedBy?.kind === 'external' && data.task.generatedBy.provider === opts.provider)) rows.push(data.task);
        }
        rows.sort(taskOrder);
        if (opts.json) out(JSON.stringify(rows));
        else {
          out('id\t우선순위\t상태\t승인\t출처\t제목');
          for (const row of rows) out(taskLine(row));
        }
      } catch (error) { handleError(error, out); }
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
    .option('--json', 'JSON 출력')
    .action(async (text: string | undefined, opts: { seat?: TaskSeat; checklist?: string; version?: string; completion?: CompletionKind; mission?: string; project?: string; target?: string; goal?: string; milestone?: string; live?: boolean; taLand?: boolean; childLlm?: string; childLlmEffort?: string; json?: boolean }) => {
      const suppliedText = text !== undefined;
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
        for (const version of orderedVersions) {
          try {
            const title = findTitle((deps.releaseBoard ?? releasePackBoard)(version));
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
      if (opts.mission !== undefined && (opts.completion !== undefined || opts.project !== undefined || opts.goal !== undefined || opts.milestone !== undefined || opts.taLand === true || opts.childLlm !== undefined || opts.childLlmEffort !== undefined)) {
        out('--completion/--project/--target/--goal/--milestone/--ta-land/--child-llm 은 과제 한 줄에만 준다 — --mission 조각은 종전처럼 code-pr 이다');
        process.exitCode = 1;
        return;
      }
      if (opts.mission !== undefined) {
        try {
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
        const result = await handTask({
          text: resolved.text,
          ...(opts.project !== undefined && opts.target !== undefined ? { project: { id: opts.project, target: opts.target } } : {}),
          ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
          ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
          ...(opts.seat ? { seat: opts.seat } : {}),
          ...(opts.checklist ? { checklistId: opts.checklist } : {}),
          ...(opts.completion ? { completion: opts.completion } : {}),
          live: opts.live === true,
          ...(opts.taLand === true ? { taLand: true } : {}),
          ...(opts.childLlm !== undefined ? { childLlm: opts.childLlm } : {}),
          ...(opts.childLlmEffort !== undefined ? { childLlmEffort: opts.childLlmEffort } : {}),
          ...(deps.taskStatePath ? { statePath: deps.taskStatePath } : {}),
          ...(deps.taskCompositionRoot ? { compositionRoot: deps.taskCompositionRoot } : {}),
          launcher: deps.taskLauncher ?? defaultTaskLauncher,
        });
        if (opts.json) out(JSON.stringify(result));
        else {
          out(`${result.card.id}\t${result.mode}\t${result.launched ? 'launched' : 'not launched'}`);
          out(`elanous ${result.move.command!.map(shellQuote).join(' ')}`);
          if (result.cwd) out(`(cwd: ${result.cwd})`);
          if (result.card.taLand) out('(ta-land — 발사 env ELANOUS_TA_LAND=1 · 원격 또는 로컬 부모 · taskAgent.liveMoves 에 propose-land 가 있으면 병합은 TASK-AGENT 몫, 없으면 종전대로 호스트 병합)');
          if (!result.launched) out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
        }
      } catch (error) {
        out(error instanceof Error ? error.message : '과제 넘기기 실패');
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
    .option('--unlinked-terminal', '기존 카드의 모든 구현 자식이 종결되고 PR 사건이 전혀 없을 때만 별도로 열린 PR을 명시적으로 입양')
    .option('--json', 'JSON 출력')
    .action(async (value: string, opts: { card?: string; checklist?: string; version?: string; unlinkedTerminal?: boolean; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      try {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`PR 번호가 아니다: ${value}`);
        if ((opts.card === undefined) === (opts.checklist === undefined))
          throw new Error('--card 또는 --checklist [--version] 중 하나만 준다');
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
        const chosen = observedChecklist ?? checklist;
        const result = adoptExistingPr({ pr: view, repo, statePath: deps.taskStatePath ?? taskStatePathDefault(),
          ...(opts.card ? { cardId: opts.card, version: cardVersion, terminalRunEvidence, unlinkedTerminal: unlinkedTerminalUsed, observedChecklist,
            observedRun: { runId: targetCard?.runId, runChildId: targetCard?.runChildId, parentHost: targetCard?.parentHost?.host, launchId: targetCard?.launchId } } : {}),
          ...(chosen ? { checklistAtWrite: () => (deps.adoptChecklist ?? listChecklist)(chosen.version).items.find((item) => item.id === chosen.id) } : {}),
          ...(checklist ? { checklist } : {}) });
        try { debug.log('task-agent', 'pr-adopted', { card: result.card.id, pr: number, head: view.headRefOid, created: result.created, changed: result.changed, launched: false }); } catch { /* fail-soft */ }
        if (opts.json) out(JSON.stringify({ card: result.card.id, pr: number, head: view.headRefOid, created: result.created, changed: result.changed, next: `tasks rejudge ${result.card.id}` }));
        else out(`${result.card.id}\tPR #${number}\t${result.changed ? 'adopted' : 'already-adopted'}\t구현 발사 0 · 다음: tasks rejudge ${result.card.id}`);
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

  tasks.command('show <id>')
    .description(`태스크 상세 보기 (id 가 \`${TASK_CARD_PREFIX}\` 로 시작하면 TASK-AGENT 과제 카드 ⊕ 다음 수)`)
    .option('--json', 'JSON 출력')
    .action(async (id: string, opts: { json?: boolean }) => {
      if (id.startsWith(TASK_CARD_PREFIX)) {
        await registerTaskAgentSink(deps.registerSink);
        let card: TaskCard | undefined;
        try {
          card = readTaskCard(id, deps.taskStatePath);
          // 런 id 가 있으면 원장에서 골 id · PR 을 묶는다(찾았을 때만 적는다 · 실패는 그대로 보인다).
          const bindable = card?.pieces ? card.pieces : card ? [card.id] : [];
          for (const cardId of bindable) {
            // HARNESS-PARENT-ON-MSB1: 원격 부모 런은 원장이 그 호스트에 있다 — HQ 거울로 먼저 당긴다(읽기 전용).
            await mirrorRemoteCardLedger(cardId, deps);
            try { await replayRemoteCardMoves(cardId, deps.taskStatePath ?? taskStatePathDefault(), deps.cardRunEvidence ?? {}); } catch (error) {
              try { debug.log('task-agent', 'card-binding-replay-failed', { card: cardId, reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
            }
            try { await refreshCardRunBinding(cardId, deps.taskStatePath ?? taskStatePathDefault(), deps.cardRunEvidence ?? {}); } catch (error) {
              // 근거 없음으로 보인다 — 원장 부재와 갈리게 실패는 남긴다.
              try { debug.log('task-agent', 'card-bind-failed', { card: cardId, via: 'show', error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
            }
            // TA-REVIEW-RESULT-CAPTURE — 떼어 띄운 live review 의 결과 파일을 이 카드 history 로 회수한다(대기 중인 요청이 있을 때만 쓴다 · 던지지 않는다).
            captureReviewResults(deps.taskStatePath ?? taskStatePathDefault(), { cardIds: [cardId], ...(deps.reviewResultNow ? { now: deps.reviewResultNow } : {}) });
          }
          if (card) card = readTaskCard(id, deps.taskStatePath);
        } catch (error) {
          out(error instanceof Error ? error.message : '과제 카드 읽기 실패');
          process.exitCode = 1;
          return;
        }
        if (!card) { out(`과제 카드 없음: ${id}`); process.exitCode = 1; return; }
        if (card.pieces) {
          let all: Record<string, TaskCard>;
          try { all = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {}; } catch (error) {
            out(error instanceof Error ? error.message : '과제 카드 읽기 실패');
            process.exitCode = 1;
            return;
          }
          const pieces = card.pieces.map((pieceId) => all[pieceId]).filter((piece): piece is TaskCard => piece !== undefined);
          const missingPieces = card.pieces.filter((pieceId) => !all[pieceId]);
          if (opts.json) {
            out(JSON.stringify({ card, nextMove: nextMoveFor(card), pieces: pieces.map((piece) => ({ card: piece, nextMove: nextMoveFor(piece) })), missingPieces }));
            if (missingPieces.length) process.exitCode = 1;
          }
          else {
            for (const line of missionLines(card, pieces)) out(line);
            for (const missing of missingPieces) { out(`조각 카드 없음: ${missing} — 선후 기록이 불완전하다`); process.exitCode = 1; }
          }
          return;
        }
        // DRAFT-NOT-ARCHIVE: 멈춘 런이 draft PR 대신 남긴 수확 가지(원장 `salvaged`). 못 읽었으면 «못 읽음»(⛔ 없음 아님).
        let salvage: Awaited<ReturnType<typeof readCardSalvageBranch>> = { salvageBranch: null };
        try { salvage = await readCardSalvageBranch(card, deps.cardRunEvidence ?? {}); }
        catch (error) { salvage = { salvageBranch: null, readErrors: [error instanceof Error ? error.message : String(error)] }; }
        const salvageUnread = !salvage.salvageBranch && !!salvage.readErrors?.length;
        if (opts.json) out(JSON.stringify({ card, nextMove: nextMoveFor(card), salvageBranch: salvage.salvageBranch, ...(salvageUnread ? { salvageBranchUnread: true } : {}) }));
        else {
          for (const line of taskCardLines(card)) out(line);
          if (card.parentHost) out(`부모 호스트: ${card.parentHost.host}${card.parentHost.pid ? ` (pid ${card.parentHost.pid})` : ''} · PR 까지만 — 병합은 HQ${card.parentHost.log ? ` · 로그 ${card.parentHost.host}:${card.parentHost.log}` : ''}`);
          if (salvage.salvageBranch) out(`수확 가지: ${salvage.salvageBranch} (draft PR 대신)`);
          else if (salvageUnread) out('수확 가지: 못 읽음(원장 읽기 실패)');
        }
        return;
      }
      try {
        activeToken = undefined;
        const auth = authenticate();
        const response = await request(deps, auth, `/v1/tasks/${encodeURIComponent(id)}`);
        if (!response.ok) throw httpError(response);
        const data = await responseJson(response) as { task?: TaskRow };
        if (!data?.task) throw new Error('넥서스 태스크 상세 형식이 유효하지 않다');
        if (opts.json) out(JSON.stringify(data));
        else {
          out(taskLine(data.task));
          out(JSON.stringify(data, null, 2));
        }
      } catch (error) { handleError(error, out); }
    });

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
        ids = id ? [id] : rejudgeCandidates(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {});
      } catch (error) {
        out(error instanceof Error ? error.message : '과제 카드 읽기 실패'); process.exitCode = 1; return;
      }
      const { configuredTaskAgentLiveMoves } = await import('../task-agent/live-moves.js');
      const liveMoves = deps.rejudge?.liveMoves ?? await configuredTaskAgentLiveMoves();
      const repairBudget = opts.all ? { max: (await import('../user-config.js')).getUserConfig().taskAgent?.repairMaxPerTick ?? 3,
        requested: 0, capped: 0 } : undefined;
      const all = [];
      for (const cardId of ids) {
        await mirrorRemoteCardLedger(cardId, deps);
        try { await replayRemoteCardMoves(cardId, statePath, deps.cardRunEvidence ?? {}); } catch (error) {
          try { debug.log('task-agent', 'card-binding-replay-failed', { card: cardId, reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
        }
        let outcomes: Awaited<ReturnType<typeof rejudgeCardOnHead>>;
        try { outcomes = await rejudgeCardOnHead(cardId, { ...deps.rejudge, liveMoves,
          ...(repairBudget ? { repairBudget } : {}), live: { ...deps.rejudge?.live, statePath } }); } catch (error) {
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
    .option('--seat <seat>')
    .action(async (opts: { card: string; pr: string; head: string; repo: string; out: string; goalFile: string;
      runId: string; modelProvider: string; modelId: string; seat?: string }) => {
      const { readFileSync } = await import('node:fs');
      const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { runRepairWorker } = await import('../task-agent/repair-worker.js');
      const result = await runRepairWorker({ card: opts.card, pr: Number(opts.pr), head: opts.head,
        repo: opts.repo, resultPath: opts.out, entry: ELANOUS_CLI_ENTRY,
        configDir: getElanousConfigDirOverride() ?? effectiveInstanceRoot(), runId: opts.runId,
        model: { provider: opts.modelProvider, model: opts.modelId }, seat: opts.seat,
        goal: readFileSync(opts.goalFile, 'utf8') });
      if (!result.ok) process.exitCode = 1;
    });

  tasks.command('approve <id...>')
    .description('외부 태스크 승인')
    .action(async (ids: string[]) => {
      try {
        activeToken = undefined;
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
