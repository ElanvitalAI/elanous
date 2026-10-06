/**
 * Self-dev run store (S3 — persistence + resume).
 *
 * A lightweight, self-dev-SCOPED checkpoint: each `elanous self orchestrate`
 * run persists its per-goal results to `<state>/self-dev-runs/<runId>.json`
 * after every job settles, so a crashed/interrupted run can resume and
 * skip already-done goals.
 *
 * Deliberately NOT the daemon's tox SQLite store (`tox_tasks`): mixing an
 * ephemeral standalone-CLI run into the daemon's shared task graph would
 * pollute the daemon's view (the mission-DB-firewall lesson). Wiring the
 * tox store for the DAEMON's own fleet orchestration is a separate concern
 * (roadmap item 10 · daemon integration). Here we keep self-dev runs in
 * their own namespace.
 *
 * Cf. PLAN-parallel-self-dev-orchestrator-2026-07-21 §5 (S3).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { randomUUID } from 'node:crypto';
import { debug, redactSecretText } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { loadRunLedger, queryInterruptedRunLedgers, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { join, resolve, sep } from 'node:path';
import { isPidAlive } from '../git-fs/worktree.js';
import type { EmbodiedTransportKind } from '../agent/embodiment.js';
import type { RunIdSource } from '../harness/harness-space.js';
import { withFileLockSync } from '../storage/file-lock.js';
import type { SelfDevJobResult, SelfDevGoal } from './orchestrate.js';
import type { SupervisorStopReason } from './run-supervisor.js';
import type { SupervisorNext } from './supervisor-verdict-edges.js';
import { loadMirroredRunRecord, mirrorRunRecord } from './run-record-mirror.js';

export interface SelfDevRunParticipant {
  id: string;
  kind: 'agent' | 'pty' | 'acp' | 'process';
  transports: { kind: EmbodiedTransportKind; id: string }[];
  registeredAt: number;
  runIdSource: RunIdSource;
  closedAt?: number;
  closedBy?: 'self' | 'parent';
}

interface SelfDevRunResolution {
  reason: string;
  resolvedAt: number;
}

/** Map each checkpoint shard ID to its declared predecessor shard IDs. */
function selfDevRunDependencies(
  goals: readonly { feature: string; id?: string; dependsOn?: readonly string[] }[],
): Record<string, string[]> {
  return Object.fromEntries(goals.map((goal, index) => [goal.id ?? String(index), [...(goal.dependsOn ?? [])]]));
}

/**
 * Preserve a resumed checkpoint's dependency-information version: undefined is
 * legacy absence, while an object containing empty arrays is explicit absence
 * of predecessors. New runs derive an explicit map from their current goals.
 */
export function checkpointDependenciesForRun(
  prior: Pick<SelfDevRunState, 'dependencies'> | null,
  goals: readonly { feature: string; id?: string; dependsOn?: readonly string[] }[],
): Record<string, string[]> | undefined {
  return prior ? prior.dependencies : selfDevRunDependencies(goals);
}

export interface SelfDevRunState {
  runId: string;
  createdAt: number;
  updatedAt: number;
  results: SelfDevJobResult[];
  /** Redacted, bounded one-line projection for loop readers; legacy checkpoints omit it. */
  summaryLine?: string;
  /** Undefined means a legacy checkpoint has no dependency information; each key is a shard ID and its array lists predecessor shard IDs. */
  dependencies?: Record<string, string[]>;
  /**
   * ⭐⭐ 이 런을 «다시 걸려면» 필요한 goal 원형(id·feature·dependsOn·승격 플래그). 2026-08-19 신설.
   *
   * ⛔ **왜 필요한가 — 이것이 없으면 재개가 «원리상» 불가능하다.**
   *   실행 의존성은 `goal.dependsOn`(orchestrate.ts)에서 오는데, CLI 로 goal «텍스트»만 주면
   *   그 필드가 없어 조각이 «전부 동시»에 뜬다(상류 산출 없이 하류가 도는 것).
   *   되먹이려 해도 못 잇는다 — `dependencies` 키는 shard id 이고 `results` 는 taskId 라
   *   그 둘을 잇는 매핑이 어디에도 «없었다».
   *   📏 2026-08-19 북극성 런에서 실측: 재개하려면 사람이 순서를 «추론»해야 했다.
   *
   * ⚠️ undefined = 이 필드 «이전»에 저장된 체크포인트. 그때는 종전대로 인자 goals 를 쓴다(하위호환).
   */
  goals?: SelfDevGoal[];
  /** Undefined means a checkpoint predates participant tracking; [] means tracked with no participants. */
  participants?: SelfDevRunParticipant[];
  /** Human confirmation that this run's parked results have been handled. */
  parkedResolution?: SelfDevRunResolution;
  /** The closed supervisor termination reason, persisted independently from per-goal results. */
  supervisorStopReason?: SupervisorStopReason;
  /** Named next step at supervisor termination; legacy checkpoints omit it. */
  next?: SupervisorNext;
  /** ★ C(2026-07-21·HITL 정황 품질) — 이 run 을 구동하는 오케스트레이터 프로세스 pid. 살아있으면
   *  non-terminal goal 은 **실행중(running)** 이지 막힌(interrupted) 게 아니다. 죽었으면(오케스트레이터
   *  killed) 진짜 interrupted. isPidAlive 로 구분해 라이브 잡을 parked/repair-signals 에서 제외. */
  pid?: number;
  /** OS process birth identity, paired with pid to reject a recycled pid. */
  pidStart?: string;
  /** Seat fixed at launch; survives removal of the launch worktree. */
  seat?: 'OP' | 'TC' | 'MK' | 'UX';
}

/** `<ELANOUS_STATE_DIR or ~/.elanous>/self-dev-runs`. */
export function selfDevRunsDir(stateDir?: string): string {
  const base = stateDir ?? elanousStateRoot();
  return join(base, 'self-dev-runs');
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Kernel process birth identity: Linux boot ID + start ticks or Darwin microseconds since epoch. */
export function processBirthId(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const ticks = tail[19]; // field 22 (starttime), after pid and parenthesized comm
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return ticks && /^\d+$/.test(ticks) && /^[0-9a-f-]{36}$/i.test(bootId)
        ? `linux:${bootId}:${ticks}` : undefined;
    }
    if (platform === 'darwin') {
      const libproc = dlopen('/usr/lib/libproc.dylib', {
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      });
      try {
        const buf = new Uint8Array(136);
        if (libproc.symbols.proc_pidinfo(pid, 3, 0n, buf, buf.length) !== buf.length) return undefined;
        const view = new DataView(buf.buffer);
        if (view.getUint32(12, true) !== pid) return undefined;
        return `darwin:${view.getBigUint64(120, true) * 1_000_000n + view.getBigUint64(128, true)}`;
      } finally { libproc.close(); }
    }
  } catch { /* Unreadable birth identity is not evidence of a match. */ }
  return undefined;
}

function runPath(runId: string, dir: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid self-dev run ID: ${runId}`);
  const root = resolve(dir);
  const path = resolve(root, `${runId}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`invalid self-dev run ID: ${runId}`);
  return path;
}

const loggedAbsentCheckpoints = new Set<string>();

function loadSelfDevRunFromPath(path: string): SelfDevRunState | null {
  const runId = path.slice(path.lastIndexOf(sep) + 1, -'.json'.length);
  try {
    const o = JSON.parse(readFileSync(path, 'utf-8')) as SelfDevRunState | null;
    if (o && typeof o.runId === 'string' && Array.isArray(o.results)) return o;
    try { debug.log('self-dev.run-store', 'read-failed', { runId, reason: 'invalid checkpoint shape' }); } catch { /* preserve fail-soft reads */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!loggedAbsentCheckpoints.has(runId)) {
        loggedAbsentCheckpoints.add(runId);
        try { debug.log('self-dev.run-store', 'checkpoint-absent', { runId }); } catch { /* preserve fail-soft reads */ }
      }
    } else {
      try { debug.log('self-dev.run-store', 'read-failed', { runId, reason: String(error) }); } catch { /* preserve fail-soft reads */ }
    }
  }
  return null;
}

function writeSelfDevRun(state: SelfDevRunState, dir: string): void {
  const path = runPath(state.runId, dir);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* write may have failed before creating it */ }
    throw error;
  }
}

function mergeParticipants(
  existing: readonly SelfDevRunParticipant[] | undefined,
  incoming: readonly SelfDevRunParticipant[] | undefined,
): SelfDevRunParticipant[] | undefined {
  if (existing === undefined && incoming === undefined) return undefined;
  const byId = new Map<string, SelfDevRunParticipant>();
  for (const participant of [...(existing ?? []), ...(incoming ?? [])]) byId.set(participant.id, participant);
  return [...byId.values()];
}

const SUMMARY_LINE_LIMIT = 120;
const FINISHED_RESULT_STATUSES = new Set(['done', 'failed', 'cancelled', 'superseded']);

function boundedSummaryLine(text: string): string {
  const redacted = redactSecretText(text.replace(/\s+/g, ' ').trim());
  if (redacted.length <= SUMMARY_LINE_LIMIT) return redacted;
  const head = redacted.slice(0, SUMMARY_LINE_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${head}…`;
}

/** Read-only projection for loop readers; missing legacy fields are derived in memory. */
export function runSummaryLine(state: SelfDevRunState): string {
  if (state.summaryLine !== undefined) return boundedSummaryLine(state.summaryLine);
  const feature = state.goals?.[0]?.feature ?? state.results[0]?.feature ?? '';
  const head = feature.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const header = /^「하니스로 구현」\s+(\S+?)\s+—\s*(.*)$/.exec(head);
  const id = state.goals?.[0]?.goalId ?? header?.[1] ?? state.goals?.[0]?.id ?? state.runId;
  const phrase = (header?.[2] ?? head).split(/[.!?。；;]/, 1)[0]?.trim() ?? '';
  const finished = state.results.length > 0
    && state.results.every((result) => FINISHED_RESULT_STATUSES.has(result.status));
  if (finished) {
    // A completed shard cannot hide a failed one merely by settling later.
    const result = state.results.find(({ status }) => status === 'failed')
      ?? state.results.find(({ status }) => status === 'cancelled')
      ?? state.results.find(({ status }) => status === 'superseded')
      ?? state.results.at(-1)!;
    const stage = result.stage ?? result.status;
    const prNumber = result.prNumber ?? Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(result.prUrl ?? '')?.[1]);
    const pr = Number.isSafeInteger(prNumber) && prNumber > 0 ? ` · PR #${prNumber}` : '';
    return boundedSummaryLine(`${id} · ${stage}${pr}`);
  }
  return boundedSummaryLine(`「하니스로 구현」 ${id}${phrase ? ` — ${phrase}` : ''}`);
}

/** Persist a run checkpoint (fail-soft — never throws into the caller). */
export function saveSelfDevRun(state: SelfDevRunState, dir = selfDevRunsDir()): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    withFileLockSync(join(dir, `${state.runId}.lock`), () => {
      const current = loadSelfDevRunFromPath(runPath(state.runId, dir));
      const participants = mergeParticipants(current?.participants, state.participants);
      const saved = {
        ...state,
        summaryLine: runSummaryLine({ ...state, goals: state.goals ?? current?.goals, summaryLine: undefined }),
        ...(participants === undefined ? {} : { participants }),
        ...(current?.seat && !state.seat ? { seat: current.seat } : {}),
        ...(current?.pidStart && current.pid === state.pid && !state.pidStart ? { pidStart: current.pidStart } : {}),
        ...(current?.parkedResolution && !state.parkedResolution ? { parkedResolution: current.parkedResolution } : {}),
      };
      writeSelfDevRun(saved, dir);
      mirrorRunRecord(saved, dir);
    });
  } catch { /* fail-soft — a lost checkpoint just means no resume, not a crash */ }
}

/** Load a run checkpoint by id, or null if absent/corrupt. */
export function loadSelfDevRun(runId: string, dir = selfDevRunsDir()): SelfDevRunState | null {
  const primary = loadSelfDevRunFromPath(runPath(runId, dir));
  if (primary) return primary;
  const mirrored = loadMirroredRunRecord(runId);
  if (mirrored) {
    try { debug.log('self-dev.run-store', 'read-from-mirror', { runId }); } catch { /* preserve fail-soft reads */ }
  }
  return mirrored;
}

/** Add one participant without losing registrations made by another caller for this run. */
export function addSelfDevRunParticipant(
  runId: string,
  participant: SelfDevRunParticipant,
  dir = selfDevRunsDir(),
): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    withFileLockSync(join(dir, `${runId}.lock`), () => {
      const state = loadSelfDevRunFromPath(runPath(runId, dir));
      if (!state) return;
      writeSelfDevRun({
        ...state,
        updatedAt: Date.now(),
        participants: mergeParticipants(state.participants, [participant])!,
      }, dir);
    });
  } catch { /* fail-soft — participant observation must not crash a run */ }
}

/** Close one participant without overwriting the first terminal declaration. */
export function closeSelfDevRunParticipant(
  runId: string,
  participantId: string,
  closedBy: 'self' | 'parent',
  dir = selfDevRunsDir(),
): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    withFileLockSync(join(dir, `${runId}.lock`), () => {
      const state = loadSelfDevRunFromPath(runPath(runId, dir));
      if (!state?.participants) return;
      const participant = state.participants.find(({ id }) => id === participantId);
      if (!participant || participant.closedAt !== undefined || participant.closedBy !== undefined) return;
      writeSelfDevRun({
        ...state,
        updatedAt: Date.now(),
        participants: state.participants.map((entry) => entry.id === participantId
          ? { ...entry, closedAt: Date.now(), closedBy }
          : entry),
      }, dir);
    });
  } catch { /* fail-soft — participant observation must not crash a run */ }
}

export type SupervisorStopPersistenceOutcome =
  | { outcome: 'persisted' }
  | { outcome: 'missing-directory' }
  | { outcome: 'missing-record' }
  | { outcome: 'io-error' };

/** Persist a terminal supervisor reason without turning a completed run into a crash. */
export function recordSelfDevRunSupervisorStop(
  runId: string,
  supervisorStopReason: SupervisorStopReason,
  dir = selfDevRunsDir(),
  next?: SupervisorNext,
): SupervisorStopPersistenceOutcome {
  try {
    if (!existsSync(dir)) return { outcome: 'missing-directory' };
    return withFileLockSync(join(dir, `${runId}.lock`), () => {
      const state = loadSelfDevRunFromPath(runPath(runId, dir));
      if (!state) return { outcome: 'missing-record' };
      writeSelfDevRun({ ...state, updatedAt: Date.now(), supervisorStopReason, ...(next === undefined ? {} : { next }) }, dir);
      return { outcome: 'persisted' };
    });
  } catch {
    return { outcome: 'io-error' };
  }
}

export function resolveParkedSelfDevRun(
  runId: string,
  reason: string,
  dir = selfDevRunsDir(),
): SelfDevRunResolution {
  const path = runPath(runId, dir);
  if (!existsSync(dir)) throw new Error(`self-dev run not found: ${runId}`);
  return withFileLockSync(join(dir, `${runId}.lock`), () => {
    const state = loadSelfDevRunFromPath(path);
    if (!state) throw new Error(`self-dev run not found: ${runId}`);
    const parkedResolution = { reason, resolvedAt: Date.now() };
    writeSelfDevRun({ ...state, parkedResolution }, dir);
    return parkedResolution;
  });
}

/**
 * G4 (1b · 실패 escalation) — parked goal 백로그.
 *
 * 무인 루프에서 실패(gate-failed/review-blocked/merge-conflict/cancelled)한 goal 은
 * per-failure 로 사람을 부르지 않고 **parked** 로 쌓아 배치 결정(재정의/포기/직접)을
 * 받는다. run-store 를 스캔해 각 feature 의 **최신 run 결과**를 취하고, 최신이 done 이
 * 아니면 parked(진단 동봉). 다만 관측 전용 측정의 `done/observed` 는 실제 완료가 아니므로
 * parked 로 남긴다. --resume 로 실제 완료한 다음 run 의 done 이 이걸 밀어낸다.
 */
export interface ParkedGoal {
  /** Goal identifier recorded by the producer; combined-listing rows contain a value or null when unreadable. */
  goalId?: string | null;
  /** Goal document path projected from the already-read ledger start event when recorded. */
  goalFile?: string;
  feature: string;
  status: string;
  stage?: string;
  error?: { code: string; message: string };
  branch?: string;
  worktreePath?: string;
  /** ⭐ 관측(2026-07-21) — 자식 goal-loop 화면 tail("docker logs")·종결상태·공간 id·조정 플래그.
   *  parked 결정 시 "왜 실패했나"를 재현 없이 보여준다(exit-code 만으론 불명). */
  screenTail?: string;
  screenOutcome?: 'complete' | 'incomplete' | null;
  screenSpace?: string;
  reconcileMismatch?: boolean;
  /** Present only when the supervisor terminated this run; the closed reason is never collapsed into status. */
  supervisorStopReason?: SupervisorStopReason;
  /** Canonical failure classification when an upstream producer recorded one. */
  failureClassification?: 'goal-unconvergeable-candidate' | 'contract-conflict';
  /** Recorded abandoned-classification value; undefined means ledger unreadable, null means event absent. */
  ledgerAbandonedClassification?: string | null;
  /** Counts from the last recorded gated event; undefined means ledger unreadable, null means event absent. */
  ledgerGatedCounts?: { introduced: number | undefined; preexisting: number | undefined } | null;
  /** Accumulated review-cited-paths counts; undefined means ledger unreadable, null means event absent. */
  ledgerReviewCitedPathCounts?: { missing: number; ambiguous: number } | null;
  /** Artifact context projected only from the already-read ledger; undefined means ledger unreadable, null means event absent. */
  ledgerArtifactEvidence?: ParkedGoalLedgerArtifactEvidence | null;
  /** Whether the same ledger goal completed in a later different run; null means its goal ID or a required terminal timestamp was unreadable or invalid. */
  laterRunSucceeded?: boolean | null;
  runId: string;
  updatedAt: number;
}

/** A formal parked row's producer branch; every row retains the complete ParkedGoal shape. */
/**
 * Locally recorded artifact context for a parked self-implement ledger row.
 * The extractor projects only the final `pr-opened` event and never queries GitHub, Git, the filesystem, or another store.
 */
export interface ParkedGoalLedgerArtifactEvidence {
  prNumber: number;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Pure projection of locally recorded PR context. `pr-opened` supplies artifact size where recorded;
 * older `run-rollup.data.prNumber` entries preserve the PR reference with unknown size.
 */
export function extractParkedGoalLedgerArtifactEvidence(
  entries: readonly RunLedgerEntry[],
): ParkedGoalLedgerArtifactEvidence | undefined {
  const prOpenedData = entries.filter((entry) => entry.event === 'pr-opened').at(-1)?.data;
  const prOpenedNumber = prOpenedData?.number;
  if (typeof prOpenedNumber === 'number' && Number.isSafeInteger(prOpenedNumber) && prOpenedNumber > 0) {
    return {
      prNumber: prOpenedNumber,
      changedFiles: nonNegativeSafeInteger(prOpenedData?.changedFiles),
      additions: nonNegativeSafeInteger(prOpenedData?.additions),
      deletions: nonNegativeSafeInteger(prOpenedData?.deletions),
    };
  }

  const rollupPrNumber = entries.filter((entry) => entry.event === 'run-rollup').at(-1)?.data.prNumber;
  return typeof rollupPrNumber === 'number' && Number.isSafeInteger(rollupPrNumber) && rollupPrNumber > 0
    ? { prNumber: rollupPrNumber, changedFiles: null, additions: null, deletions: null }
    : undefined;
}

export type ParkedGoalSource = 'self-dev-run' | 'self-implement-ledger';
export type ParkedGoalRow = ParkedGoal & { source: ParkedGoalSource };

export const PARKED_GOALS_LEDGER_STATUS = 'interrupted' as const;

export const PARKED_GOALS_LIMITATION = '이 자는 현재 self-dev run 저장소와 self-implement 원장만 읽고 다른 우주는 보지 않으며, 그 런이 아직 열려 있는지도 보지 않습니다.';

export interface ParkedGoalListing {
  parked: ParkedGoalRow[];
  counts: {
    total: number;
    selfDevRun: number;
    selfImplementLedger: number;
  };
  displayLimit: number;
  omittedCount: number;
  /** Inclusion rules for the two existing parked-goal sources; neither rule changes the counted rows. */
  population: {
    selfDevRun: 'existing parked-goal scan';
    selfImplementLedgerStatus: typeof PARKED_GOALS_LEDGER_STATUS;
  };
  /** The local stores actually read to produce this listing. */
  stores: {
    count: number;
    names: string[];
  };
  /** Scope excluded from both the human and structured parked output. */
  limitation: typeof PARKED_GOALS_LIMITATION;
}

export interface ParkedGoalListingOptions {
  dir?: string;
  ledgerDir?: string;
  isAlive?: (pid: number) => boolean;
  limit?: number;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'superseded']);

/** ★ C(2026-07-21) — run 이 라이브(구동 오케스트레이터 살아있음)인가. pid 없으면(구버전 체크포인트) 판정
 *  불가 → 보수적으로 죽음 취급(종전 동작 유지). isAlive 주입 가능(테스트). */
function isRunLive(run: SelfDevRunState, isAlive: (pid: number) => boolean): boolean {
  return typeof run.pid === 'number' && run.pid > 0 && isAlive(run.pid);
}

export interface ParkedGoalScanCounts {
  runs: number;
  resultItems: number;
  excluded: {
    newerFeature: number;
    resolvedRun: number;
    completed: number;
    liveRunning: number;
  };
}

export interface ParkedGoalScan {
  parked: ParkedGoal[];
  counts: ParkedGoalScanCounts;
}

/** Parked-goal scan with the existing inclusion rules and per-branch exclusion counts. */
export function scanParkedGoals(dir = selfDevRunsDir(), isAlive: (pid: number) => boolean = isPidAlive): ParkedGoalScan {
  const runs = listSelfDevRuns(dir); // newest first
  const parked: ParkedGoal[] = [];
  const seenFeatures = new Set<string>();
  const counts: ParkedGoalScanCounts = {
    runs: runs.length,
    resultItems: 0,
    excluded: { newerFeature: 0, resolvedRun: 0, completed: 0, liveRunning: 0 },
  };
  for (const run of runs) {
    const live = isRunLive(run, isAlive);
    if (!run.parkedResolution && !live && run.supervisorStopReason === 'needs-human' && run.results.every((result) => result.status === 'done' && result.stage !== 'observed')) {
      parked.push({
        goalId: null,
        feature: 'supervisor needs human',
        status: 'interrupted',
        stage: 'supervisor-stop',
        supervisorStopReason: run.supervisorStopReason,
        runId: run.runId,
        updatedAt: run.updatedAt,
      });
    }
    for (const r of run.results) {
      counts.resultItems++;
      if (seenFeatures.has(r.feature)) {
        counts.excluded.newerFeature++;
        continue; // 최신 run 이 이김(이미 등록됨)
      }
      seenFeatures.add(r.feature);
      if (run.parkedResolution) {
        counts.excluded.resolvedRun++;
        continue; // 사람의 처리 표시는 기존 판정 뒤 결과만 제외한다.
      }
      const status = TERMINAL.has(r.status) ? r.status : (live ? 'running' : 'interrupted');
      const goal: ParkedGoal = {
        goalId: null,
        feature: r.feature,
        status,
        ...(r.stage ? { stage: r.stage } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.branch ? { branch: r.branch } : {}),
        ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}),
        ...(r.screenTail ? { screenTail: r.screenTail } : {}),
        ...(r.screenOutcome !== undefined ? { screenOutcome: r.screenOutcome } : {}),
        ...(r.screenSpace ? { screenSpace: r.screenSpace } : {}),
        ...(r.reconcileMismatch ? { reconcileMismatch: true } : {}),
        ...(run.supervisorStopReason ? { supervisorStopReason: run.supervisorStopReason } : {}),
        runId: run.runId,
        updatedAt: run.updatedAt,
      };
      // 실제 done(성공) + running(라이브·막힌 게 아님)은 parked(결정 대기)에서 제외.
      // 관측 전용 done은 실제 작업을 완료하지 않았으므로 백로그에 남긴다.
      if (goal.status === 'done' && goal.stage !== 'observed') {
        counts.excluded.completed++;
      } else if (goal.status === 'running') {
        counts.excluded.liveRunning++;
      } else {
        parked.push(goal);
      }
    }
  }
  return { parked, counts };
}

export type UnconvergeableLedgerSummary =
  | { status: 'ok'; count: number; runIds: string[] }
  | { status: 'unreadable'; runIds: [] };

/**
 * Count canonical self-implement ledgers whose final rework-budget verdict is UNCONVERGEABLE.
 * This is a read-only local scan: absent ledger directories are a measured zero; inaccessible
 * directories or malformed individual ledgers remain explicitly unreadable.
 */
export function countUnconvergeableRunLedgers(dir = runLedgerDir()): UnconvergeableLedgerSummary {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ok', count: 0, runIds: [] };
    return { status: 'unreadable', runIds: [] };
  }

  const runIds: string[] = [];
  for (const fileName of fileNames.sort()) {
    if (!/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(fileName)) continue;
    const runId = fileName.slice(0, -'.jsonl'.length);
    let entries;
    try {
      entries = loadRunLedger(runId, dir);
    } catch {
      return { status: 'unreadable', runIds: [] };
    }
    const verdict = entries?.filter((entry) => entry.event === 'rework-budget').at(-1)?.data.verdict;
    if (verdict === 'UNCONVERGEABLE') runIds.push(runId);
  }
  return { status: 'ok', count: runIds.length, runIds };
}

const PARKED_GOALS_NOTICE_RUN_ID_LIMIT = 10;

/** Human-readable population, observed-store, and limitation metadata shared with the JSON envelope and `self parked` output; it performs no PR lookup or network call. */
export function parkedGoalsListingScopeNotice(listing: Pick<ParkedGoalListing, 'population' | 'stores' | 'limitation'>): string {
  return `[self-dev] 모집단: self-dev=${listing.population.selfDevRun}, self-implement 원장 상태=${listing.population.selfImplementLedgerStatus}; 읽은 저장소 ${listing.stores.count}개: ${listing.stores.names.join(', ')}\n[self-dev] 한계: ${listing.limitation}`;
}

export function parkedGoalsPopulationNotice(summary = countUnconvergeableRunLedgers()): string {
  if (summary.status === 'unreadable') {
    return '[self-dev] self-implement 원장 기준 UNCONVERGEABLE 종결 런은 원장을 못 읽어 집계하지 못했습니다. 이 런들이 열어 둔 draft PR은 원장·로그로 확인: elanous logs abandoned-draft-prs --all --include-test. 그중 지금도 아직 열려 있는지는 이 명령이 안 봅니다 — 네트워크 확인: gh pr list --state open --draft';
  }
  const displayedRunIds = summary.runIds.slice(0, PARKED_GOALS_NOTICE_RUN_ID_LIMIT);
  const omittedCount = summary.count - displayedRunIds.length;
  const runIdNotice = displayedRunIds.length === 0
    ? ''
    : ` 런 식별자: ${displayedRunIds.join(', ')}${omittedCount > 0 ? ` (${summary.count}건 중 ${displayedRunIds.length}건 표시, ${omittedCount}건 생략)` : ''}.`;
  return `[self-dev] self-implement 원장 기준 마지막 rework-budget verdict=UNCONVERGEABLE 종결 런 ${summary.count}건은 위 목록에 [self-implement-ledger] 로 함께 실립니다.${runIdNotice} 이 런들이 열어 둔 draft PR은 원장·로그로 확인: elanous logs abandoned-draft-prs --all --include-test. 그중 지금도 아직 열려 있는지는 이 명령이 안 봅니다 — 네트워크 확인: gh pr list --state open --draft`;
}

/** parked goal 목록 — 각 feature 의 최신 run 결과가 done/running 이 아닌 것(진단 동봉·최신순).
 *  ⚠️ 비-terminal(running/ready/blocked) 결과의 정황(HITL 정황 품질·대표 2026-07-21):
 *   - 구동 오케스트레이터 **살아있으면** = 진짜 **실행중(running)** → parked 아님(막힌 결정 아님·제외).
 *   - 오케스트레이터 **죽었으면**(killed) = 진짜 **interrupted** → parked(결정 대기).
 *  pid 라이브니스로 둘을 구분해 **라이브 잡을 parked/repair-signals 에서 제외**(오인·오염 차단). */
export function listParkedGoals(dir = selfDevRunsDir(), isAlive: (pid: number) => boolean = isPidAlive): ParkedGoal[] {
  return scanParkedGoals(dir, isAlive).parked;
}

export function failureClassificationForInterruptionVerdict(verdict: string | null): ParkedGoal['failureClassification'] {
  if (verdict === 'UNCONVERGEABLE') return 'goal-unconvergeable-candidate';
  if (verdict === 'CONTRACT-CONFLICT') return 'contract-conflict';
  return undefined;
}

/** Combine self-dev parked goals and formally interrupted self-implement ledgers before limiting display rows. */
export function listCombinedParkedGoals(options: ParkedGoalListingOptions = {}): ParkedGoalListing {
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`parked goal display limit must be a positive safe integer: ${String(limit)}`);
  }
  const selfDevRows: ParkedGoalRow[] = listParkedGoals(options.dir ?? selfDevRunsDir(), options.isAlive ?? isPidAlive)
    .map((goal) => ({ ...goal, source: 'self-dev-run' }));
  const ledgerQuery = queryInterruptedRunLedgers({ dir: options.ledgerDir ?? runLedgerDir() });
  const terminalRunById = new Map(ledgerQuery.terminalRuns.map((run) => [run.runId, run]));
  const completedRunsByGoalId = new Map<string, { runs: Array<{ runId: string; timestamp: number }>; hasUnknownTimestamp: boolean }>();
  for (const run of ledgerQuery.terminalRuns) {
    if (run.runStatus !== 'completed' || run.goalId === null) continue;
    const timestamp = Date.parse(run.timestamp ?? '');
    const completedRuns = completedRunsByGoalId.get(run.goalId) ?? { runs: [], hasUnknownTimestamp: false };
    if (Number.isFinite(timestamp)) completedRuns.runs.push({ runId: run.runId, timestamp });
    else completedRuns.hasUnknownTimestamp = true;
    completedRunsByGoalId.set(run.goalId, completedRuns);
  }
  const ledgerRows: ParkedGoalRow[] = ledgerQuery.entries
    // This listing's ledger branch comprises only UNCONVERGEABLE interruption records, so stage has the measured single value.
    // A ledger that cannot be read has no evidence that its run is parked.
    .filter((entry) => entry.status === PARKED_GOALS_LEDGER_STATUS)
    .map((entry) => {
      const terminalRun = terminalRunById.get(entry.runId);
      const goalId = terminalRun?.goalId ?? null;
      const goalFile = entry.ledgerEntries.find((ledgerEntry) => ledgerEntry.event === 'start')?.data.goalFile;
      const terminalTimestamp = Date.parse(terminalRun?.timestamp ?? '');
      const completedRuns = goalId === null ? undefined : completedRunsByGoalId.get(goalId);
      const knownLaterSuccess = Number.isFinite(terminalTimestamp)
        && (completedRuns?.runs ?? []).some((run) => run.runId !== entry.runId && run.timestamp > terminalTimestamp);
      const laterRunSucceeded = goalId === null || !Number.isFinite(terminalTimestamp)
        ? null
        : knownLaterSuccess
          ? true
          : completedRuns?.hasUnknownTimestamp
            ? null
            : false;
      const failureClassification = failureClassificationForInterruptionVerdict(entry.interruptionVerdict);
      const abandonedClassification = entry.ledgerEntries.filter((ledgerEntry) => ledgerEntry.event === 'abandoned-classification').at(-1);
      const gated = entry.ledgerEntries.filter((ledgerEntry) => ledgerEntry.event === 'gated').at(-1);
      const citedPathEvents = entry.ledgerEntries.filter((ledgerEntry) => ledgerEntry.event === 'review-cited-paths');
      const ledgerArtifactEvidence = extractParkedGoalLedgerArtifactEvidence(entry.ledgerEntries);
      const ledgerReviewCitedPathCounts = citedPathEvents.length === 0
        ? null
        : citedPathEvents.reduce(
          (counts, { data }) => ({
            missing: counts.missing + (typeof data.missingCount === 'number' ? data.missingCount : 0),
            ambiguous: counts.ambiguous + (typeof data.ambiguousCount === 'number' ? data.ambiguousCount : 0),
          }),
          { missing: 0, ambiguous: 0 },
        );
      return {
        goalId,
        ...(typeof goalFile === 'string' ? { goalFile } : {}),
        // Measured consumers: repair-signals uses feature for affectedFeatures and self parked renders it for people.
        // Preserve that failure-reason contract; goalId is the independent ledger identity and remains null when unavailable.
        feature: entry.interruptionReason ?? 'UNCONVERGEABLE self-implement run',
        status: 'interrupted',
        stage: 'UNCONVERGEABLE',
        ...(failureClassification ? { failureClassification } : {}),
        ledgerAbandonedClassification: abandonedClassification
          ? typeof abandonedClassification.data.classification === 'string' ? abandonedClassification.data.classification : undefined
          : null,
        ledgerGatedCounts: gated
          ? {
              introduced: typeof gated.data.introduced === 'number' ? gated.data.introduced : undefined,
              preexisting: typeof gated.data.preexisting === 'number' ? gated.data.preexisting : undefined,
            }
          : null,
        ledgerReviewCitedPathCounts,
        ledgerArtifactEvidence: ledgerArtifactEvidence ?? null,
        laterRunSucceeded,
        ...(entry.interruptionReason ? { error: { code: 'UNCONVERGEABLE', message: entry.interruptionReason } } : {}),
        runId: entry.runId,
        updatedAt: Date.parse(entry.terminal?.timestamp ?? '') || 0,
        source: 'self-implement-ledger',
      };
    });
  const allRows = [...selfDevRows, ...ledgerRows]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.source.localeCompare(right.source) || left.runId.localeCompare(right.runId));
  const stores = [
    options.dir ?? selfDevRunsDir(),
    ledgerQuery.ledgerDirectory,
  ];
  return {
    parked: allRows.slice(0, limit),
    counts: { total: allRows.length, selfDevRun: selfDevRows.length, selfImplementLedger: ledgerRows.length },
    displayLimit: limit,
    omittedCount: Math.max(0, allRows.length - limit),
    population: {
      selfDevRun: 'existing parked-goal scan',
      selfImplementLedgerStatus: PARKED_GOALS_LEDGER_STATUS,
    },
    stores: { count: stores.length, names: stores },
    limitation: PARKED_GOALS_LIMITATION,
  };
}

/** 현재 라이브(구동 오케스트레이터 살아있는) run 의 실행중 goal 수 — `self parked` 가 "N running(live)"
 *  로 정황 표시(라이브 잡을 죽은 것으로 오인하지 않게). */
export function countRunningGoals(dir = selfDevRunsDir(), isAlive: (pid: number) => boolean = isPidAlive): number {
  const runs = listSelfDevRuns(dir);
  const seen = new Set<string>();
  let running = 0;
  for (const run of runs) {
    const live = isRunLive(run, isAlive);
    for (const r of run.results) {
      if (seen.has(r.feature)) continue;
      seen.add(r.feature);
      if (live && !TERMINAL.has(r.status)) running++;
    }
  }
  return running;
}

/** List persisted runs, newest first (best-effort). */
export function listSelfDevRuns(dir = selfDevRunsDir()): SelfDevRunState[] {
  try {
    if (!existsSync(dir)) return [];
    const runs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadSelfDevRun(f.slice(0, -'.json'.length), dir))
      .filter((r): r is SelfDevRunState => r !== null);
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    return runs;
  } catch { return []; }
}
