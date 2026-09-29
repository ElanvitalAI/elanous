/**
 * Parallel self-dev orchestrator (S1 vertical slice).
 *
 * Fans out N independent `elanous self implement` jobs across the existing
 * TOX dispatcher (concurrency-capped, parallel, observable) — the engine
 * is reused wholesale; the only new surface is the self-implement adapter
 * (surfaces/self-implement.ts), which spawns each job as its own
 * subprocess (→ own harness-space, parallel-safe).
 *
 * S1 scope: independent goals only (no dependency edges) — dependency
 * decomposition (via TaskGenerator) + hot-file serialization are S2.
 * This is a thin driver, NOT a re-implemented coordinator: it does the
 * minimal "tick → wait for capacity → tick again" loop the dispatcher's
 * design explicitly expects a caller to run. Feedback-loop / persistence
 * / board are S3.
 *
 * Cf. PLAN-parallel-self-dev-orchestrator-2026-07-21.
 */
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { emitDecision } from '../live/detail-switch.js';
import { parentUnlandedProgressLine } from './run-supervisor.js';
import { mkdirSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { availableParallelism, cpus } from 'node:os';
import { selfDevRunsDir } from './run-store.js';
import { HARNESS_RUN_ID_ENV, normalizeRunId } from '../harness/harness-space.js';
import { plannedSelfImplBranch } from '../harness/worktree-branch-prefix.js';
import { parseGoalId } from '../self-implement/goal-author.js';
import { isTransientExecutionFailure } from './execution-transient.js';
import type { AbandonedClassification } from '../self-implement/abandoned-classification.js';
import type { DeployVerifyFinding, DeployVerifyResult } from '../harness/browser-verify.js';
import type { LogQuery, LogStoreRow } from '../mss/logging/log-store.js';
import { observeDeliverables, type DeliverableObservationTarget } from '../harness/deliverable-observation.js';
import { TaskGraph } from '../task-orchestrator/graph.js';
import { TaskDispatcher } from '../task-orchestrator/dispatcher.js';
import { TaskEventBus, type TaskEvent } from '../task-orchestrator/events.js';
import { SurfaceRegistry } from '../task-orchestrator/surface-registry.js';
import {
  createTask,
  isTerminalStatus,
  OPEN_TASK_STATUSES,
  TASK_DEFAULTS,
  type TaskIsolation,
  type TaskStatus,
  type TaskSurface,
  type TaskSurfaceKind,
} from '../task-orchestrator/types.js';
import type { SurfaceAdapter } from '../task-orchestrator/surface-registry.js';
import {
  createSelfImplementAdapter,
  defaultSelfImplementSpawn,
  spaceIdForTask,
  type SelfImplementJobSpawn,
  type SelfImplementJobDone,
} from '../task-orchestrator/surfaces/self-implement.js';
import { collectOrchestrateUnionDiff, type UnionDiffFileReader } from './orchestrate-union-diff.js';
import { debug } from '../debug/log.js';
import { readHarnessScreen, readHarnessScreenTail, resolveHarnessScreenKey } from '../harness/harness-screen.js';
import {
  dedupWorkingMemory,
  normList,
  parseWorkingMemoryJsonl,
  parseWorkingMemorySignals,
  type WorkingMemoryEntry,
} from '../agent-substrate/working-memory-format.js';

/** 자식 goal-loop 화면 버퍼 tail 읽기 seam(관측·"docker logs"). 기본=file-based 버퍼.
 *  테스트는 fake 주입해 FS 무접촉. */
export type ReadScreenTail = (spaceId: string) => { text: string; outcome: 'complete' | 'incomplete' | null; path: string } | null;
/** Full child screen transcript seam for dependency working-memory harvest. */
export type ReadScreenTranscript = (spaceId: string) => string | null;

/** ★ A(2026-07-21) — 파이프라인이 goal-loop 이후 **정당하게** 실패하는 stage 들. 화면이 GOAL-COMPLETE 여도
 *  이 stage 로 실패했으면 false-failure 아님(gate/review 가 옳게 거부·정상). false-failure = 화면 complete +
 *  이 집합에 없는 실패(스폰 신호 단절). exit code 만으로 오탐하지 않게 disposition stage 로 정밀 판정. */
const LEGIT_PIPELINE_FAIL_STAGES: ReadonlySet<string> = new Set([
  'gate-failed', 'review-blocked', 'merge-conflict', 'timed-out', 'aborted', 'pr-declined',
]);

export type JobKind = 'dev' | 'search' | 'deploy' | 'media';
export type SelfDevGoalType = 'implement' | 'research' | 'document' | 'operate';

/** Maps a heterogeneous job kind to an existing TOX surface adapter. */
export interface JobKindDefinition {
  surfaceKind: TaskSurfaceKind;
  surface: (goal: SelfDevGoal) => TaskSurface;
  adapter: SurfaceAdapter;
  /** 실행 격리 — surface 마다 적절한 값이 다르므로(dev=worktree·검색/미디어=shared 등) 명시 필수(암묵 기본 없음). */
  isolation: TaskIsolation;
}

/** Additive F1 registry. Omitted goals and registry entries retain `dev`. */
export type JobKindRegistry = Readonly<Partial<Record<JobKind, JobKindDefinition>>>;

/**
 * Identity carried to every child in a non-empty parent request.
 * `position` is one-based in the original shard order;
 * sibling summaries are bounded identifiers, not sibling instructions.
 */
interface SelfDevShardIdentity {
  orchestrationId: string;
  parentRequest?: string;
  shardId: string;
  totalShards: number;
  position: number;
  summary: string;
  siblings: Array<{ shardId: string; summary: string }>;
}

const SHARD_SUMMARY_MAX_LENGTH = 240;
const SHARD_HANDOFF_MAX_LENGTH = 4_000;
const FAILURE_MESSAGE_MAX_LENGTH = 256;

function failureObservationFields(errorCode: string, errorMessage: string): {
  errorCode: string;
  errorMessage?: string;
  errorMessageTruncated?: true;
} {
  if (!errorMessage) return { errorCode };
  if (errorMessage.length <= FAILURE_MESSAGE_MAX_LENGTH) return { errorCode, errorMessage };
  let end = FAILURE_MESSAGE_MAX_LENGTH - 1;
  const last = errorMessage.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return {
    errorCode,
    errorMessage: `${errorMessage.slice(0, end)}…`,
    errorMessageTruncated: true,
  };
}

function shardSummary(feature: string): string {
  const normalized = feature.trim().replace(/\s+/g, ' ');
  if (!normalized) return '(empty shard)';
  return normalized.length <= SHARD_SUMMARY_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, SHARD_SUMMARY_MAX_LENGTH - 1)}…`;
}

function shardIdentityFeature(feature: string, identity: SelfDevShardIdentity | undefined): string {
  return identity === undefined
    ? feature
    : `${feature}\n\n## Shard identity\n${JSON.stringify(identity)}`;
}

const SHARD_WORKING_MEMORY_EMIT_HINT =
  '\n\n## Working-memory handoff\nA downstream shard depends on this work. Before your final response, emit the following marker and one JSON object so it can reuse your findings. Put reusable boundaries in `reusables` and your key choices in `decisions`; use empty arrays when there are none.\n[WORKING-MEMORY]\n{"reusables":[],"decisions":[],"summary":"What this shard established for downstream work."}';

/**
 * Formats completed upstream shard memory as a bounded, explicit handoff input.
 * A missing read is represented separately from a completed shard with no entries,
 * so downstream input construction remains fail-soft.
 */
export function formatShardHandoffInput(
  entries: readonly WorkingMemoryEntry[] | null | undefined,
  maxLength = SHARD_HANDOFF_MAX_LENGTH,
  /**
   * 이 기억을 남긴 상류가 «착지했나». ⛔ 기본은 `'unknown'` 이다 —
   * 상태를 «모르는» 기존 호출자가 생략했을 때 「착지했다」로 «단정하면» 하류가
   * 그 기억을 「이미 된 것」으로 읽는다. 「모른다」는 값으로 남는다.
   */
  upstreamOutcome: 'landed' | 'blocked' | 'unknown' = 'unknown',
): string {
  const boundedLength = Math.max(0, Math.floor(maxLength));
  const selected = entries == null ? [] : dedupWorkingMemory(entries);
  const reusableItems = selected.flatMap((entry) => entry.reusables);
  const decisionItems = selected.flatMap((entry) => entry.decisions);
  const reusables = normList(reusableItems);
  const decisions = normList(decisionItems);
  const wasNormalized = entries != null && (selected.length < entries.length
    || reusables.length < reusableItems.length
    || decisions.length < decisionItems.length);
  const upstream = entries == null ? 'unreadable' : selected.length === 0 ? 'empty' : 'available';
  // ⛔ 결말을 `upstream` 에 «접지 않는다» — 그 네 값은 「기억을 읽었나」이고 이건 「상류가 이뤘나」다.
  //   접으면 하류가 「기억 있음」과 「그 기억이 성공한 것」을 구별할 수 없다.
  const handoff = { upstream, upstreamOutcome, reusables, decisions, truncated: wasNormalized };
  if (JSON.stringify(handoff).length <= boundedLength) return JSON.stringify(handoff);

  const keptReusables: string[] = [];
  const keptDecisions: string[] = [];
  // ⛔ 절단 경로에도 결말을 «싣는다» — 잘렸다고 「상류가 이뤘나」를 잃으면 안 된다.
  const bounded = () => JSON.stringify({ upstream, upstreamOutcome, reusables: keptReusables, decisions: keptDecisions, truncated: true });
  for (let index = 0; index < Math.max(reusables.length, decisions.length); index++) {
    for (const [value, target] of [[reusables[index], keptReusables], [decisions[index], keptDecisions]] as const) {
      if (value === undefined) continue;
      target.push(value);
      if (bounded().length > boundedLength) target.pop();
    }
  }
  if (bounded().length <= boundedLength) return bounded();
  const compact = JSON.stringify({ upstream, truncated: true });
  return compact.length <= boundedLength ? compact : JSON.stringify({ truncated: true });
}

export interface SelfDevGoal {
  /** F1 job kind. Omitted remains the legacy `dev` self-implement job. */
  kind?: JobKind;
  /** Decomposition intent; deliberately distinct from executable `kind`. */
  goalType?: SelfDevGoalType;
  /** Feature/goal text → `elanous self implement <feature>` for dev jobs. */
  feature: string;
  base?: string;
  autoMerge?: boolean;
  /** G8 — attach `auto-review` opt-in label on PR (subject to eligibility self-assessment). */
  autoReview?: boolean;
  /** S3 — open a draft PR via the job's own merge-decision node (HITL).
   *  Promotion flows through the review node → disposition recorded
   *  internally (no external hand-merge). */
  openPr?: boolean;
  draft?: boolean;
  /** Optional short title (≤ 80 chars). Default = feature head. */
  title?: string;
  /** 계획 브랜치가 알려지면 같은 워크트리의 실행을 직렬화한다. */
  planBranch?: string;
  /** 계획 브랜치가 없는 저작 골의 안정 식별자. */
  goalId?: string;
  /** S2 — goal-local id for dependency wiring (default = array index). */
  id?: string;
  /** S2 — goal-local ids this goal depends on (must complete first).
   *  The task becomes `ready` only after every dependency is `done`
   *  (topological parallel via the graph). Unknown/self ids are dropped. */
  dependsOn?: string[];
  /** Read-only handoff memory emitted by this shard for dependent child input.
   *  `[]` is a completed shard with no entries; null/undefined is unreadable. */
  workingMemory?: readonly WorkingMemoryEntry[] | null;
  /** 그 기억을 남긴 이 조각이 «착지했나». ⛔ 생략은 「모른다」이지 「착지」가 아니다. */
  workingMemoryOutcome?: 'landed' | 'blocked' | 'unknown';
  /** S2 — repo paths this job will touch. Two goals sharing a hot path
   *  are serialized (an implicit dependency edge is added, earlier-first)
   *  so their worktrees never merge concurrently. Cf. PLAN §8 risk 2. */
  hotPaths?: string[];
}

interface SelfDevTerminalOutcome {
  /** Stable TOX task identity, matching the returned `SelfDevJobResult.taskId`. */
  taskId: string;
  status: TaskStatus;
  /** Child disposition, or null when no disposition reached the orchestrator. */
  stage: string | null;
  merged: boolean | null;
  prUrl: string | null;
  blockReason?: 'parent-unlanded';
  parentPrNumber?: number | null;
  parentNoPr?: true;
}

export interface SelfDevJobResult {
  taskId: string;
  feature: string;
  /** Run outcome — done | failed | cancelled | blocked (awaiting parent landing). */
  status: TaskStatus;
  error?: { code: string; message: string };
  durationMs?: number;
  /** S3 — real pipeline disposition from the child `--json`
   *  (merged / pr-opened / gate-failed / review-blocked / pr-declined). */
  stage?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  /** Child commit SHA, when observed by the Pod/host. */
  checkedHeadCommit?: string;
  /** A dependency is done but its result is not on main; no child was launched. */
  blockReason?: 'parent-unlanded';
  parentPrNumber?: number;
  /** The upstream completed in a worktree without opening a PR. */
  parentNoPr?: true;
  // ⭐⭐⭐ `A1`(2026-08-19 · 대표 *"R3 가 서브 프로세스여도 잘 도는 안"*) — ***판정 3종***.
  //   🚨 이 셋이 트리아지의 입력 전부인데 종전엔 자식 → 부모 경계에서 «전부» 사라졌다.
  //     값은 전선에 «실려 있었고»(자식이 `r.result` 를 통째로 낸다) 파서가 버렸다.
  //   ⇒ 📌 서브프로세스에서 «먼저» 옳아야 한다 — 실행 방식을 바꾸지 않고 고치는 자리다.
  /** auto-merge 를 «왜» 건너뛰었나 — 「도구 한계」와 「자식이 못 함」을 가르는 근거. */
  mergeReason?: string;
  /** 런이 «왜» 멈췄나. 없으면 「부모가 잘랐다」다. */
  stopReason?: string;
  /** 자식이 스스로 낸 완료 성격. */
  completionDisposition?: string;
  /** Abandoned-run classification from the child. Independent of completionDisposition. */
  failureClassification?: AbandonedClassification;
  /** Provider failure evidence from the child result; absent when unobserved. */
  providerErrors?: { count: number; provider: string; category: 'quota' | 'credential' | 'request' | 'other' };
  /** Stable child run identity used to join its run-ledger proposal. */
  runId?: string;
  /** Whether the child review actually ran; omitted preserves legacy producers. */
  reviewed?: boolean;
  /** Why the child did not run review; omitted preserves legacy review-unobserved handling. */
  reviewReason?: string;
  /** The abandoned-run classifier observed a goal-side cause for this failed convergence. */
  goalCauseObserved?: true;
  /** Resume selection that decided whether this shard was carried forward or retried. */
  resumeDisposition?: ResumeDisposition;
  /**
   * ⭐ 하니스가 이 조각에 대해 낸 「이렇게 쪼개라」(2026-08-19).
   *
   * ⛔ 이 값은 자식 결과로 «안 온다» — 전선 타입(SelfImplementDisposition)에 칸이 없다.
   *   그래서 «중앙»이 원장에서 읽어 채운다(decompose-proposal.ts). 트리아지는 그것을 그냥 본다.
   *   ⇒ 📌 출구 모듈은 ***「이 값이 어디서 왔는지 몰라야」*** 한다 — 알면 실행 방식마다 갈래가 는다.
   * ⚠️ undefined = 「제안이 없다」와 「아직 안 읽었다」가 «같은 값»이다. 채우는 자가 그것을 구분해 관측한다.
   */
  decomposeProposal?: { pieces: Array<{ id: string; feature: string; dependsOn: readonly string[]; goalType?: string }> };
  /**
   * Parent-side observation of CONTRACT-CONFLICT goal-plan revision application attempts.
   * undefined = the parent has not read the run ledger yet; it is not the same as attempted=0.
   */
  goalPlanRevision?:
    | { status: 'read'; attempted: number; applied: number; failureReasons: string[] }
    | { status: 'read-failed'; reason: 'directory-missing' | 'unreadable-directory' | 'unreadable-files'; scannedFiles: number; unreadableFiles: number; ledgerDirectory: string };
  /** ⭐ 관측(2026-07-21 대표 co-design·"재현 없이 진단") — 자식 goal-loop 화면 버퍼 tail
   *  (ANSI 제거·"docker logs <id>" 등가물). detached PTY goal-loop 은 스폰 프로세스 stdout 이
   *  아니라 file-based 화면 버퍼에만 남으므로, 실패 진단의 유일한 cross-process 진실원. */
  screenTail?: string;
  /** 화면 버퍼에서 판정한 goal-loop 종결 상태(complete=성공 마커·incomplete·null=불명). */
  screenOutcome?: 'complete' | 'incomplete' | null;
  /** 화면 버퍼 공간 id — `elanous self screen --space <id>` 로 전체 전사 재생 가능. */
  screenSpace?: string;
  /** ⚠️ exit-code 실패인데 화면은 GOAL-COMPLETE = 스폰-신호 단절(false-failure). 조정 플래그. */
  reconcileMismatch?: boolean;
  /** ⭐ 이 시도의 «걸음» — 노드 진입 순서(2026-09-08 · 대표 지시).
   *  🩸 그 전까지 이 배열엔 「요약 판정」만 있었고 걸음은 런 «안»에서 끝났다.
   *  ⛔ 관측용이다 — 슈퍼바이저가 이것으로 «무엇을 할지»는 별개 결정이다. */
  walk?: readonly { node: string; round: number }[];
}

/**
 * Resume identity for the legacy feature-only checkpoint format.
 * It deliberately absorbs only trim, whitespace runs, and case; wording,
 * punctuation, and identifiers remain distinct rather than semantic-matched.
 */
export function resumeKey(feature: string): string {
  return feature.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface SelfDevResultSummary {
  /** Process-terminal counts retained for existing consumers. */
  done: number;
  failed: number;
  cancelled: number;
  /** Shards whose child disposition confirms the requested change landed. */
  landed: number;
  /** Terminal shards that did not confirm a landing. */
  unlanded: number;
}

/** Read-only landing probe. An unobservable PR/commit is not evidence of landing. */
export function dependencyOnMain(
  result: Pick<SelfDevJobResult, 'prNumber' | 'stage' | 'merged' | 'checkedHeadCommit'>,
  probe: { prMerged: (number: number) => boolean; commitOnMain: (commit: string) => boolean },
): boolean {
  if (result.prNumber !== undefined) {
    try { if (probe.prMerged(result.prNumber)) return true; } catch { /* unknown is not landed */ }
  }
  if (result.checkedHeadCommit) {
    try { if (probe.commitOnMain(result.checkedHeadCommit)) return true; } catch { /* unknown is not landed */ }
  }
  return false;
}

/** A merged PR lands a dependency only when its base is main. */
export function prMergedOnMain(number: number, readPr: (number: number) => string = (pr) =>
  execFileSync('gh', ['pr', 'view', String(pr), '--json', 'state,baseRefName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): boolean {
  const pr = JSON.parse(readPr(number)) as { state?: unknown; baseRefName?: unknown };
  return pr.state === 'MERGED' && pr.baseRefName === 'main';
}

const defaultLandingProbe = {
  prMerged: prMergedOnMain,
  commitOnMain: (commit: string): boolean => {
    if (!/^[0-9a-f]{40}$/i.test(commit)) return false;
    // git-spawn-allow: read-only ancestry check against the cached remote main ref.
    try { execFileSync('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  },
};

export function hasLanded(result: SelfDevJobResult): boolean {
  return result.stage === 'merged' && result.merged === true;
}

export function hasDelivered(result: SelfDevJobResult): boolean {
  return hasLanded(result) || (result.status === 'done' && result.stage === 'worktree-completed');
}

/** 열린 PR 을 사람에게 보여줄 때 분류 칸에 싣는 문면. 없는 mergeReason 은 「사유 모름」— 값을 짓지 않는다. */
export function openPrAwaitingHumanMessage(result: Pick<SelfDevJobResult, 'prNumber' | 'prUrl' | 'mergeReason'>): string {
  const pointer = result.prNumber !== undefined ? `#${result.prNumber}` : (result.prUrl ?? '');
  const reason = result.mergeReason && result.mergeReason.length > 0 ? result.mergeReason : '사유 모름';
  return `열린 PR ${pointer} · ${reason}`;
}

/** Continuation decision for a prior shard; each value is intentionally distinct. */
export type ResumeDisposition = 'skip' | 'rerun' | 'rerun-duplicate-risk';

/**
 * Decide whether a prior result can be carried forward safely. A legacy `done`
 * result with no landing evidence retains the historical skip behavior, while an
 * explicit `merged: false` or known unlanded terminal stage is retried. A PR
 * opened but not merged is retried with its duplication risk retained for the
 * caller and returned result.
 */
export function classifyResumeDisposition(result: SelfDevJobResult): ResumeDisposition {
  if (hasDelivered(result)) return 'skip';
  if (result.stage === 'pr-opened') return 'rerun-duplicate-risk';
  if (result.merged === false) return 'rerun';
  if (result.status !== 'done') return 'rerun';
  if (result.stage === 'merged'
    || result.stage === 'review-blocked'
    || result.stage === 'gate-failed'
    || result.stage === 'merge-conflict'
    || result.stage === 'timed-out'
    || result.stage === 'aborted'
    || result.stage === 'pr-declined') return 'rerun';
  return 'skip';
}

export function summarizeResults(results: SelfDevJobResult[]): SelfDevResultSummary {
  return results.reduce(
    (summary, result) => {
      if (result.status === 'done') summary.done++;
      else if (result.status === 'failed') summary.failed++;
      else if (result.status === 'cancelled') summary.cancelled++;
      if (hasLanded(result)) summary.landed++;
      else summary.unlanded++;
      return summary;
    },
    { done: 0, failed: 0, cancelled: 0, landed: 0, unlanded: 0 },
  );
}

export type FailureKind =
  | 'false-failure'
  | 'unconverged'
  /** A launch preflight warned before the job reached an otherwise unconverged failure. */
  | 'preflight-warning'
  /** ⭐ 다시 걸면 대개 풀린다 — git 락 경합·네트워크. 종전엔 `unclassified` 로 삼켜졌다. */
  | 'transient'
  /** ⭐ 상류 조각이 죽어 «취소»된 것. 종전엔 분류 자체가 안 됐다(아래 주석). */
  | 'blocked-upstream'
  /**
   * ⭐⭐ 수렴 못 했는데 ***하니스가 「이렇게 쪼개라」를 이미 냈다***(2026-08-19).
   * ⛔ 이것을 `unconverged` 와 같은 칸에 두면 처방이 갈리지 않는다 —
   *   전자는 「같은 골로 다시」(대개 같은 결과), 후자는 「더 잘게 쪼개서 다시」다.
   * 📏 113차 실물: 하니스 제안을 사람이 읽고 손으로 재발사했더니 «둘 다» must-fix 0 으로 병합됐다.
   */
  | 'unconverged-decomposable'
  /** 화면 검증이 확정한 산출물 결함. */
  | 'deliverable-broken'
  /** 수렴 실패의 원인이 골 자체에 있다는 구조화 관측. */
  | 'oversized-goal'
  /**
   * PR 을 열고 끝났으나 병합하지 않았다. 다시 걸 일이 아니라 사람이 그 PR 을 볼 일이다.
   * 가리킬 PR(prUrl 또는 prNumber)이 있을 때만. 없으면 기존 수렴 실패로 남긴다.
   */
  | 'awaiting-human'
  | 'parent-unlanded'
  /**
   * 구현·리뷰가 끝난 결과가 main 정합(`stage: merge-conflict`)에서 멈췄다.
   * 구현 결함이 아니므로 재구현하지 않고 사람에게 넘긴다 — 결과는 보존 워크트리·브랜치에 있다.
   */
  | 'main-sync-blocked'
  /**
   * ⭐ provider 가 요청을 «결정적으로» 거부했다(400·404·422 `invalid_request_error` 등 · BACKLOG B6).
   * 다시 걸면 같은 400 이 온다 — 설정·모델·요청 모양을 사람이 고칠 일이다.
   * 🩸 09-25: `provider-error` → `transient` 로 읽혀 과금 팔이 같은 400 으로 두 번 더 돌았다.
   */
  | 'provider-rejected'
  | 'unclassified';

/**
 * ⭐ 트리아지가 내는 «다음 행동» — 런 슈퍼바이저가 이것을 «소비»한다.
 *
 * ⛔ 종전 `classifyFailure` 는 주석에 "shadow-only" 라 적혀 있었고 실제로 아무도 안 썼다.
 *   판정은 나오는데 그 판정을 쓰는 자가 없으면, 사람이 매번 로그를 읽고 손으로 다시 건다.
 */
export type TriageAction =
  /** 그대로 다시 건다(일시적 실패). */
  | 'rerun'
  /** 상류가 풀리면 따라 풀린다 — 상류를 먼저 걸고 이것도 같이 건다. */
  | 'rerun-after-upstream'
  /** 자식이 수렴하지 못했다 — 다시 걸되 같은 결과일 수 있다(골·불변식을 의심할 자리). */
  | 'rework'
  /** ⭐ 하니스가 낸 조각으로 «쪼개서» 다시 건다. rework 와 달리 «다른 입력»으로 간다. */
  | 'decompose-and-retry'
  /** 기존 조각을 치환하거나 재실행하지 않고 수리 조각을 추가한다. */
  | 'add-repair-task'
  /** 실패가 아니었다(전송 불일치) — 건드리지 않는다. */
  | 'no-action'
  /** 모른다 — 사람이 본다. */
  | 'needs-human';

export interface FailureClassification {
  taskId: string;
  stage: string | null;
  kind: FailureKind;
  /** ⭐ 이 조각에 대해 다음에 «무엇을 할지». kind 에서 결정론적으로 파생된다. */
  action: TriageAction;
  errorCode: string;
  errorMessage?: string;
  errorMessageTruncated?: true;
}

/** 순수: 분류 → 다음 행동. ⛔ 한 자리에서만 정한다(소비자가 각자 매핑하면 갈린다). */
export function triageActionFor(kind: FailureKind): TriageAction {
  switch (kind) {
    case 'transient': return 'rerun';
    case 'blocked-upstream': return 'rerun-after-upstream';
    case 'unconverged':
    case 'preflight-warning': return 'rework';
    case 'unconverged-decomposable': return 'decompose-and-retry';
    case 'deliverable-broken':
    case 'oversized-goal': return 'add-repair-task';
    case 'false-failure': return 'no-action';
    case 'awaiting-human':
    case 'parent-unlanded':
    case 'main-sync-blocked':
    case 'provider-rejected': return 'needs-human';
    default: return 'needs-human';
  }
}

const LEDGER_FAILURE_KIND: Partial<Record<AbandonedClassification, FailureKind>> = {
  'implementation-deficit': 'unconverged',
  'report-deficit': 'unconverged',
  'contract-conflict': 'unconverged',
  'goal-unconvergeable-candidate': 'oversized-goal',
  'quota-exhausted': 'transient',
  'provider-error': 'transient',
  'merge-approved-abandoned': 'false-failure',
  'pr-declined': 'false-failure',
};

/**
 * Classify a failed job from its child disposition, without changing the job or retrying it.
 * `merged` and `pr-opened` are child-completed stages, so their failed parent status is a
 * transport mismatch. `gate-failed` and `review-blocked` are emitted after rework concludes
 * it cannot converge.
 *
 * ⭐ 2026-08-19 — 북극성 런 하나가 이 함수의 «빈 칸» 둘을 동시에 드러냈다.
 *   📏 총 7조각 중 ③이 git 락 경합으로 죽고 그 하류 ⑤⑥가 취소됐다. 즉 «한 번의 경합이
 *     조각 셋을 먹었다». 그런데 트리아지 산출은:
 *       cancelled=2 인데 failures 배열엔 **셋만**(⓪①③) — ⑤⑥는 «아예 없었다».
 *       ③은 다시 걸면 풀리는데 `unclassified`(=사람이 본다) 로 떨어졌다.
 *   ⇒ 📌 ***끝까지 돌려야 하는 자가 「무엇을 다시 걸면 되는지」를 못 읽었다.***
 *
 * ⛔ 그래도 «모른다»는 칸은 남긴다 — 모르는 것을 아는 척하면 무한 재실행이 된다.
 */
export type PreflightWarningObservation = 'warning' | 'none' | 'unknown';
export type PreflightLogQuery = (input: LogQuery) => readonly LogStoreRow[];

/**
 * Reads only an injected launch-observation seam. Empty or failed query results
 * remain unknown so they cannot be mistaken for a clean preflight.
 */
export function queryPreflightWarning(
  taskIds: readonly string[],
  query: PreflightLogQuery | undefined,
): PreflightWarningObservation {
  if (!query || taskIds.length === 0) return 'unknown';
  const candidateIds = new Set(taskIds);
  try {
    const rows = query({ exactCategories: ['dev-pipeline'], events: ['harness.preflight'] });
    const matching = rows.filter((row) => {
      try {
        const data = row.data ? JSON.parse(row.data) as Record<string, unknown> : undefined;
        return candidateIds.has(String(data?.taskId)) || candidateIds.has(String(data?.runId));
      } catch {
        return false;
      }
    });
    if (matching.length === 0) return 'unknown';
    const warnings = matching.map((row) => {
      try {
        const data = row.data ? JSON.parse(row.data) as { warnings?: unknown } : undefined;
        return Array.isArray(data?.warnings) ? data.warnings : undefined;
      } catch {
        return undefined;
      }
    });
    if (warnings.some((value) => value === undefined)) return 'unknown';
    return warnings.some((value) => (value?.length ?? 0) > 0) ? 'warning' : 'none';
  } catch {
    return 'unknown';
  }
}

export function classifyFailure(
  result: SelfDevJobResult,
  preflightWarning: PreflightWarningObservation = 'unknown',
): FailureKind | null {
  if (result.blockReason === 'parent-unlanded') return 'parent-unlanded';
  const ledgerKind = result.failureClassification === undefined
    ? undefined
    : result.failureClassification === 'run-deadline-exceeded'
      // 기한 사망은 transient 가 아니다. 브랜치/PR 이 있으면 수확(false-failure), 없으면 재분해.
      ? (result.branch || result.prUrl || result.prNumber !== undefined ? 'false-failure' : 'unconverged-decomposable')
      : LEDGER_FAILURE_KIND[result.failureClassification];

  // ⭐ 수렴 실패인데 하니스가 «쪼개는 법»을 이미 냈으면 그것은 다른 처방이다.
  //   ⛔ 조각이 둘 미만인 제안은 채우는 자가 이미 걸러낸다(decompose-proposal.ts).
  const decomposable = (result.decomposeProposal?.pieces.length ?? 0) >= 2;
  const convergedFailureKind = (): FailureKind => {
    // ⛔ 결정적 요청 거부는 원장 분류(`provider-error` → transient)보다 앞선다 — 다시 걸어도 같은 400 이다.
    if (result.providerErrors?.category === 'request') return 'provider-rejected';
    if (decomposable) return 'unconverged-decomposable';
    if (result.goalCauseObserved === true) return 'oversized-goal';
    if (ledgerKind !== undefined) return ledgerKind;
    return preflightWarning === 'warning' ? 'preflight-warning' : 'unconverged';
  };
  // 열린 PR(done · pr-opened · 미착지)은 수렴 실패가 아니다 — 가리킬 PR 이 있을 때만 사람에게 넘긴다.
  // prUrl·prNumber 가 둘 다 없으면 지금 그대로(convergedFailureKind). failed ⊕ pr-opened 는 아래 false-failure.
  if (
    result.status === 'done'
    && result.stage === 'pr-opened'
    && !hasLanded(result)
    && (Boolean(result.prUrl) || result.prNumber !== undefined)
  ) {
    return 'awaiting-human';
  }
  if (result.status === 'done' && !hasDelivered(result)) return convergedFailureKind();
  // ⭐ 상류가 죽어 «취소»된 조각 — 종전엔 status 가 failed 도 done 도 아니라 null 로 사라졌다.
  //   ⛔ 이것을 못 보면 「무엇이 상류를 기다리는가」를 슈퍼바이저가 영영 모른다.
  if (result.status === 'cancelled') {
    return result.error?.code === 'DEP_FAILED' ? 'blocked-upstream' : 'unclassified';
  }
  if (result.status !== 'failed') return null;
  // 기한 사망은 단계·일시 실패 어휘보다 앞선다. 브랜치/PR 이면 수확, 없으면 재분해. transient 가 아니다.
  if (result.failureClassification === 'run-deadline-exceeded') return ledgerKind!;
  if (result.stage === 'merged' || result.stage === 'pr-opened') return 'false-failure';
  // main 정합 실패는 구현 결함이 아니다. 원장(report-deficit 등 → unconverged → rework)보다 앞선다.
  if (result.stage === 'merge-conflict') return 'main-sync-blocked';
  if (result.stage === 'gate-failed' || result.stage === 'review-blocked') {
    if (isTransientExecutionFailure(result.error?.message ?? '', result.error?.code)) return 'transient';
    return convergedFailureKind();
  }
  // ⭐ 마지막 관문 «앞»에서 「다시 걸면 풀리나」를 묻는다 — 어휘는 execution-transient.ts.
  if (isTransientExecutionFailure(result.error?.message ?? '', result.error?.code)) return 'transient';
  return ledgerKind ?? 'unclassified';
}

/** One shadow-only, identifiable classification per failed terminal result. */
/**
 * Converts only confirmed browser findings into repair classifications.
 * The RFC §11 fingerprint intentionally contains only surface, finding kind,
 * and target identifier: messages, measurements, timestamps, and run IDs are excluded.
 */
/** 지문의 「대상」 칸 — 같은 결함을 같은 이름으로 부르게 만든다(RFC §11c).
 *
 *  ⛔⭐⭐ **숫자 마스킹을 «경로»에만 건다 — authority(host:port)에는 안 건다.**
 *  📏 2026-08-20 실측: 종전 판은 `\b\d+\b` 를 URL «전체»에 걸어
 *  ```
 *  http://127.0.0.1:31415/  →  http://:n.:n.:n.:n::n/
 *  http://127.0.0.1:8080/   →  http://:n.:n.:n.:n::n/    ← ***같다***
 *  http://127.0.0.1:5173/   →  http://:n.:n.:n.:n::n/    ← ***같다***
 *  ```
 *  ⇒ 🔑 로컬에 뜬 «서로 다른 앱»이 전부 한 지문이 됐다. 그리고 수리 조각은 «지문당 1개»가 상한이라
 *    ***둘째·셋째 앱의 수리가 조용히 버려진다.*** 지문은 「같은 것을 묶는」 장치인데 「다른 것을 묶고」 있었다.
 *
 *  ⭐ 경로의 마스킹은 «유지»한다 — 거기 섞이는 것은 런ID·타임스탬프처럼 «매번 달라지는» 값이라
 *  안 지우면 같은 결함이 매번 새 지문이 된다. 두 위험이 반대 방향이라 «칸을 갈라» 다루는 것이 답이다.
 *  ⚠️ 전제: 산출물 URL 의 포트는 «골이 선언한» 값이다(임시 포트가 아니다). 임시 포트를 쓰는
 *  생산자가 생기면 그쪽에서 정규화해 넘겨라 — 여기서 다시 뭉개면 위 충돌이 되돌아온다. */
function normalizedDeployTarget(target: string): string {
  const withoutQuery = target.split(/[?#]/, 1)[0] ?? '';
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(withoutQuery)?.[0] ?? '';
  const path = withoutQuery.slice(authority.length);
  const normalizedPath = path
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ':id')
    .replace(/\b\d+\b/g, ':n');
  return `${authority}${normalizedPath}` || '/';
}

/**
 * `goalCauseObserved` is derived from the abandoned-run classification that
 * actually owns `goal-unconvergeable-candidate`. `completionDisposition` is a
 * different vocabulary and is never consulted here. Unavailable or
 * non-matching classification omits the field (unknown), never `false`.
 */
export function goalCauseObservedFromFailureClassification(
  failureClassification: AbandonedClassification | undefined,
): true | undefined {
  return failureClassification === 'goal-unconvergeable-candidate' ? true : undefined;
}

export function failureFromDeployFindings(
  taskId: string,
  target: string,
  findings: readonly DeployVerifyFinding[] | undefined,
): FailureClassification[] {
  const targetIdentifier = normalizedDeployTarget(target);
  return (findings ?? [])
    .filter((finding) => finding.certainty === 'confirmed')
    .map((finding) => ({
      taskId,
      stage: null,
      kind: 'deliverable-broken' as const,
      action: triageActionFor('deliverable-broken'),
      errorCode: `web|${finding.kind}|${targetIdentifier}`,
    }));
}

export function classifyFailures(
  results: SelfDevJobResult[],
  queryPreflight?: PreflightLogQuery,
): FailureClassification[] {
  return results.flatMap((result) => {
    const preflightIdentifiers = [...new Set([result.runId, result.taskId].filter((id): id is string => Boolean(id)))];
    const kind = classifyFailure(result, queryPreflightWarning(preflightIdentifiers, queryPreflight));
    if (kind === null) return [];
    const error = result.error;
    const awaitingHuman = kind === 'awaiting-human'
      ? failureObservationFields('AWAITING_HUMAN', openPrAwaitingHumanMessage(result))
      : kind === 'parent-unlanded'
        ? failureObservationFields('PARENT_UNLANDED', parentUnlandedProgressLine(result.feature.split('\n')[0]!, result.parentPrNumber, result.parentNoPr === true))
        : undefined;
    return [{
      taskId: result.taskId,
      stage: result.stage ?? null,
      kind,
      action: triageActionFor(kind),
      ...(awaitingHuman ?? failureObservationFields(error?.code ?? 'UNKNOWN', error?.message ?? '')),
    }];
  });
}

export function summarizeFailureKinds(results: SelfDevJobResult[]): {
  falseFailure: number; unconverged: number; unclassified: number;
  transient: number; blockedUpstream: number; unconvergedDecomposable: number;
  mainSyncBlocked: number;
} {
  // ⛔ 기존 세 칸의 뜻을 바꾸지 않는다 — 새 종류는 «새 칸»으로 센다.
  //   종전엔 transient 가 unclassified 에, blocked-upstream 이 «어디에도» 안 들어갔다.
  //   main-sync-blocked 도 unconverged·unclassified 에 섞지 않는다.
  return classifyFailures(results).reduce(
    (summary, failure) => {
      if (failure.kind === 'false-failure') summary.falseFailure++;
      else if (failure.kind === 'unconverged') summary.unconverged++;
      else if (failure.kind === 'unconverged-decomposable') summary.unconvergedDecomposable++;
      else if (failure.kind === 'transient') summary.transient++;
      else if (failure.kind === 'blocked-upstream') summary.blockedUpstream++;
      else if (failure.kind === 'main-sync-blocked') summary.mainSyncBlocked++;
      else if (failure.kind !== 'parent-unlanded') summary.unclassified++;
      return summary;
    },
    { falseFailure: 0, unconverged: 0, unclassified: 0, transient: 0, blockedUpstream: 0, unconvergedDecomposable: 0, mainSyncBlocked: 0 },
  );
}

/**
 * ⭐ 런 슈퍼바이저의 «입구» — 이 런을 다시 걸 가치가 있나, 있다면 무엇을.
 *
 * ⛔ 「다시 걸 것이 있다」와 「사람이 봐야 한다」는 **동시에 참일 수 있다**.
 *   그래서 둘을 각각 낸다 — 하나로 접으면 슈퍼바이저가 절반을 버린다.
 */
export function triageRun(
  results: SelfDevJobResult[],
  /**
   * ⛔⭐⭐ 산출물 «검증 결과». 생략은 ***「결함이 없다」가 아니라 「안 쟀다」***이다.
   *   📍 리뷰(#10392)가 잡은 그 자리 — 기본값을 빈 Map 으로 두면 그 둘이 «같은 값»이 되고,
   *     산출에 「산출물 결함 0」이 찍혀 ***사람이 「봤는데 멀쩡하다」로 읽는다.***
   *   ⇒ 그래서 이 인자를 «안 준» 호출은 아래 `deliverableUnmeasured: true` 로 «드러난다».
   */
  deployFindings?: ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] }>,
  /** Some targets could not be measured even though other findings are available. */
  hasUnmeasuredDeliverables = false,
  /** Optional injected lookup of launch preflight observations; absence remains unknown. */
  queryPreflight?: PreflightLogQuery,
): {
  classifications: FailureClassification[];
  /** 그대로 다시 걸면 되는 조각(일시적·상류대기). */
  rerunnable: string[];
  /** 다시 걸 수는 있으나 같은 결과일 수 있는 조각(수렴 실패). */
  reworkable: string[];
  /** ⭐ 하니스가 낸 조각으로 «쪼개서» 다시 걸 조각. ⛔ reworkable 과 «다른 처방»이라 따로 낸다. */
  decomposable: string[];
  /** 사람이 봐야 하는 조각. */
  needsHuman: string[];
  /**
   * ⭐⭐ 「기존은 두고 «새 조각을 붙일»」 조각 (2026-08-19).
   * ⛔ rerunnable(그대로 다시)·reworkable(다시 만들기)·decomposable(치환)과 «전부 다르다» —
   *   산출물 결함은 대개 기존 조각이 틀린 게 아니라 ***그 위에 고칠 것이 생긴*** 경우다.
   *   rework 로 처리하면 잘 된 조각을 통째로 다시 굴리고, 치환하면 ***이미 머지된 산출을 잃는다.***
   */
  repairable: string[];
  /** 자동으로 다음 런을 걸 가치가 있나. ⛔ repairable 도 «자동 조정» 대상이므로 포함한다. */
  actionable: boolean;
  /** ⛔ 산출물을 «안 쟀다» — 「결함이 없다」와 다른 값이다(위 인자 주석). */
  deliverableUnmeasured: boolean;
} {
  const deliverableUnmeasured = deployFindings === undefined || hasUnmeasuredDeliverables;
  const deployClassifications = [...(deployFindings ?? new Map())].flatMap(([taskId, observation]) =>
    failureFromDeployFindings(taskId, observation.target, observation.findings));
  const classifications = [
    ...deployClassifications,
    ...classifyFailures(results, queryPreflight),
  ];
  const pick = (a: TriageAction) => classifications.filter((c) => c.action === a).map((c) => c.taskId);
  const rerunnable = [...pick('rerun'), ...pick('rerun-after-upstream')];
  const reworkable = pick('rework');
  const decomposable = pick('decompose-and-retry');
  const repairable = [...new Set(pick('add-repair-task'))];  // ⛔ finding 이 여럿이면 같은 taskId 가 겹친다
  return {
    classifications,
    rerunnable,
    reworkable,
    decomposable,
    repairable,
    needsHuman: pick('needs-human'),
    actionable: rerunnable.length + reworkable.length + decomposable.length + repairable.length > 0,
    deliverableUnmeasured,
  };
}

export interface ConcurrencyResolutionDeps {
  availableParallelism?: () => number;
  /** 두 번째 런타임 자 — 첫째가 못 낼 때만 묻는다. 시험이 여기를 주입한다. */
  cpuCount?: () => number;
}

/**
 * Resolve orchestration concurrency at one boundary: an explicit caller value
 * wins; otherwise runtime parallelism is queried. Unavailable or unusable
 * runtime information deliberately remains unknown rather than becoming a
 * guessed constant.
 *
 * ⛔⭐⭐ **런타임 자를 «둘» 묻는 이유 — 셋째 패키지가 첫째를 조용히 망가뜨린다.**
 *   📏 실측 2026-08-21: `import('pdf-parse')` 를 한 «뒤»에는 `os.availableParallelism()` 이
 *     ***undefined*** 를 돌려준다(함수는 그대로 있고 «값»만 없다). `os.cpus().length` 는 «멀쩡하다».
 *   🔑 그 import 는 이 경로와 무관한 곳에서 온다 — `extractors.ts` → `skills/runner` → …
 *     → `goal-author` → `orchestrate-cli`. ***즉 이 함수를 부르는 쪽은 그 사실을 알 수 없다.***
 *   ⇒ 그래서 첫째가 못 내면 «둘째 자»를 묻는다. 둘 다 못 내야 「모른다」다.
 *   ⚠️ 「모르면 모른다」 계약은 그대로다 — 임의의 상수로 «채우지» 않는다.
 *   📌 이 결함은 시험이 아니라 ***실물 실행***이 드러냈다(시작 안내가 「동시 알 수 없음」을 찍었다).
 */
export function resolveOrchestrateConcurrency(
  explicit: number | undefined,
  deps: ConcurrencyResolutionDeps = {},
): number | undefined {
  if (explicit !== undefined) return explicit;
  const usable = (read: () => number): number | undefined => {
    try {
      const value = read();
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return usable(deps.availableParallelism ?? availableParallelism)
    ?? usable(deps.cpuCount ?? (() => cpus().length));
}

export interface OrchestrateSelfDevOptions {
  goals: SelfDevGoal[];
  /** Original composite request. Multi-shard runs carry it to each child; omitted
   *  keeps legacy callers and non-decomposed goal lists byte-for-byte unchanged. */
  parentRequest?: string;
  /** Max simultaneous jobs. An explicit caller value wins over runtime detection. */
  concurrency?: number;
  /** Runtime parallelism lookup seam. Failure or an unusable value preserves unknown concurrency. */
  availableParallelism?: () => number;
  /**
   * Decide whether a terminal child failure should prevent not-yet-started
   * siblings from launching. Returning a reason preserves running siblings.
   */
  stopAfterFailure?: (result: SelfDevJobResult) => string | null;
  /** Observes a stop decision after pending siblings have been cancelled. */
  onStopAfterFailure?: (decision: { reason: string; remainingGoals: number }) => void;
  /** ⭐ 둘째 자도 «같이» 주입할 수 있어야 한다 — 첫째만 열어 두면 호출자가 「첫째가 죽은 상황」을
   *  재현할 수 없다(무인 리뷰 지적 2026-08-21). 생략하면 실제 `os.cpus().length` 를 쓴다. */
  cpuCount?: () => number;
  /** 연합 «전체» 변경을 모으는 조회 seam. 생략하면 그 값을 «싣지 않는다»(거짓 unavailable 을 만들지 않는다). */
  readUnionDiffFiles?: UnionDiffFileReader;
  /** Browser findings observed immediately after this round's verification and before triage. */
  deployFindings?: ReadonlyMap<string, { target: string; findings?: readonly DeployVerifyFinding[] }>;
  /**
   * Optional launch-observation query owned by the caller's log-store boundary.
   * Missing, empty, and failed observations stay unknown rather than clean.
   */
  queryPreflightWarning?: PreflightLogQuery;
  /** Published deliverables to verify before reducing this completed run. */
  deliverableTargets?: readonly DeliverableObservationTarget[];
  /** Browser verification seam for deliverableTargets; defaults to verifyDeployedPage. */
  verifyDeliverable?: (target: string) => Promise<DeployVerifyResult>;
  /** Launch seam — default spawns real subprocesses. Tests inject a fake. */
  spawn?: SelfImplementJobSpawn;
  /** Read-only landing seam; production queries PR state and cached origin/main. */
  landingProbe?: { prMerged: (number: number) => boolean; commitOnMain: (commit: string) => boolean };
  /** Dispatch decision observation seam; production uses the live-detail switch. */
  emitDispatchDecision?: typeof emitDecision;
  /** Run identity for the per-run PID and labelled Pod cleanup. */
  runId?: string;
  /** Override the run directory root for isolated tests. */
  runsDir?: string;
  /** Signal source and kubectl seams for isolated lifecycle tests. */
  signalSource?: Pick<NodeJS.Process, 'on' | 'off'>;
  /** Pod context/namespace pairs chosen by the caller that launched the Jobs. */
  podTargets?: readonly { context: string; namespace: string }[];
  /** Return the number of labelled jobs removed. */
  deleteJobs?: (runId: string) => number | Promise<number>;
  /** Injectable kubectl process seam. */
  spawnKubectl?: typeof spawn;
  onSecondSignal?: (signal: NodeJS.Signals) => void;
  /** F1 additions for non-dev jobs. `dev` always uses the legacy mapping. */
  jobKinds?: Omit<JobKindRegistry, 'dev'>;
  now?: () => number;
  /** Observe every task event (progress UIs / logging). */
  onEvent?: (ev: TaskEvent) => void;
  /** S3 — remove each job's worktree after the run (opt-in, default
   *  OFF). PR-opened jobs are ALWAYS preserved. Off by default because a
   *  done-but-no-PR job's worktree holds inspectable output (the "inspect
   *  before destroy" lesson). Only fires for jobs that reported a
   *  worktreePath (real runs); fake-spawn tests are no-ops. */
  teardown?: boolean;
  /** S3 — worktree removal seam (default = git worktree remove --force).
   *  Tests inject a spy so no filesystem is touched. */
  removeWorktree?: (worktreePath: string) => void;
  /** S3 — prior-run results to resume from. Only landed `done` results (and
   *  unknown legacy terminal stages) are skipped; known unlanded terminal
   *  stages run afresh, with `pr-opened` marked as duplicate-risk. */
  resumeFrom?: SelfDevJobResult[];
  /** 런 슈퍼바이저 — 이번 재개에서 «다시 돌리지 않을» 이전 조각(taskId). `resumeFrom` 과 함께만 뜻이 있다.
   *  ⛔⭐ 판정(트리아지)이 `needs-human` 이라 한 조각을 집행(재개)이 다시 돌리지 않게 한다.
   *  🩸 2026-09-25 실측: 판정은 「재실행 1 · 사람 대기 2」였는데 `pr-opened` 가 `rerun-duplicate-risk` 로
   *    분류돼 PR 을 이미 연 두 조각까지 «다시» 돌았다(같은 골·새 task id · 과금 팔 포함). */
  resumeHold?: readonly string[];
  /** S3 — called with the full current result set after every job
   *  settles (+ at finish) so callers can persist a resumable checkpoint.
   *  Default CLI wiring = saveSelfDevRun. Fail-soft in the caller. */
  checkpoint?: (results: SelfDevJobResult[]) => void;
  /** S3 — called each cycle with the running graph's tasks so callers can
   *  render a live board (`renderSelfDevBoard`). Fail-soft in the caller. */
  onSnapshot?: (tasks: readonly import('../task-orchestrator/types.js').Task[]) => void;
  /** ⭐ 관측 seam(2026-07-21) — 잡별 자식 goal-loop 화면 tail 읽기. 기본=readHarnessScreenTail
   *  (file-based 버퍼). 테스트는 fake 주입. */
  readScreenTail?: ReadScreenTail;
  /** Full child screen transcript for dependency working-memory harvest; the execution record remains tail-bounded. */
  readScreenTranscript?: ReadScreenTranscript;
}

/** Default worktree teardown — git worktree remove --force, fail-soft. */
function defaultRemoveWorktree(worktreePath: string): void {
  const { resolveMainRepoRoot, removeWorktree } = require('../git-fs/worktree.js') as typeof import('../git-fs/worktree.js');
  const repoRoot = resolveMainRepoRoot(process.cwd()) ?? process.cwd();
  removeWorktree(repoRoot, worktreePath, true);
}

/** Derive a ≤ titleMaxLen imperative title from a goal. */
function goalTitle(g: SelfDevGoal): string {
  const raw = (g.title ?? g.feature).split('\n')[0]!.trim();
  return raw.length <= TASK_DEFAULTS.titleMaxLen ? raw : raw.slice(0, TASK_DEFAULTS.titleMaxLen - 1) + '…';
}

export function withOrchestrateGoalKey(goal: SelfDevGoal): SelfDevGoal {
  const goalId = goal.goalId ?? parseGoalId(goal.feature);
  return {
    ...goal,
    ...(goalId ? { goalId } : {}),
    planBranch: goal.planBranch ?? plannedSelfImplBranch(goal.feature, goalId ?? undefined),
  };
}

function goalInFlightKey(goal: SelfDevGoal): string {
  return goal.planBranch?.trim() || goal.goalId?.trim() || parseGoalId(goal.feature) || plannedSelfImplBranch(goal.feature);
}

/** All orchestrations in this process share reservations; the Pod Job name is the remote execution's identity. */
const inFlightByKey = new Map<string, Promise<void>>();

async function deleteLabelledJobs(runId: string, selectedTargets: readonly { context: string; namespace: string }[], spawnKubectl: typeof spawn = spawn): Promise<number> {
  const targets = new Map(selectedTargets.map(({ context, namespace }) => [`${context}/${namespace}`, { context, namespace }]));
  const counts = await Promise.all([...targets.values()].map(({ context, namespace }) => new Promise<number>((resolveCount) => {
    const env = { ...process.env };
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
    const child = spawnKubectl('kubectl', ['--context', context, '-n', namespace, 'delete', 'job', '-l', `elanous.run=${runId}`, '--wait=false'], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) debug.log('self-dev.orchestrate', 'job-delete-failed', { runId, context, namespace, error: String(spawnError ?? (stderr || `kubectl exit ${code}`)) }, { level: 'warn' });
      resolveCount(code === 0 ? stdout.split('\n').filter((line) => line.startsWith('job.batch/')).length : 0);
    });
  })));
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * Run N self-dev jobs in parallel under the TOX dispatcher and resolve
 * once every job reaches a terminal status.
 */
export function orchestrateSelfDev(opts: OrchestrateSelfDevOptions): Promise<SelfDevJobResult[]> {
  const now = opts.now ?? Date.now;
  const runId = opts.runId ?? process.env[HARNESS_RUN_ID_ENV];
  if (runId && runId !== normalizeRunId(runId)) throw new Error(`invalid self-dev run ID: ${runId}`);
  const pidPath = runId ? join(opts.runsDir ?? selfDevRunsDir(), runId, 'pid.json') : undefined;
  const graph = new TaskGraph();
  const bus = new TaskEventBus();
  const registry = new SurfaceRegistry();

  // S3 — wrap the launch seam to capture each job's disposition
  // (keyed by its harness-space id) as the child exits. The dispatcher
  // only surfaces status via bus events, so this side-channel carries
  // the rich `{stage, prUrl, merged, worktreePath}` back to `finish()`.
  let cancelling = false;
  const baseSpawn = opts.spawn ?? defaultSelfImplementSpawn();
  const doneBySpace = new Map<string, SelfImplementJobDone>();
  const taskByGoal = new Map<string, SelfDevGoal>();      // taskId → goal
  const spaceIdByTask = new Map<string, string>();         // taskId → harness-space id
  const workingMemoryHarvestByTask = new Map<string, 'screen-transcript' | 'screen-missing-output-tail' | 'screen-empty-output-tail'>();
  const readScreenTranscript = opts.readScreenTranscript ?? ((spaceId: string) => readHarnessScreen(spaceId));
  const captureWorkingMemory = (taskId: string | undefined, output: string): WorkingMemoryEntry[] | null => {
    try {
      const marker = output.indexOf('[WORKING-MEMORY]');
      if (marker < 0) {
        const entries = parseWorkingMemoryJsonl(output).filter((entry) => entry.summary || entry.reusables.length || entry.decisions.length || entry.artifacts.length);
        return dedupWorkingMemory(entries);
      }
      const markedJson = output.slice(marker + '[WORKING-MEMORY]'.length);
      const start = markedJson.indexOf('{');
      if (start < 0) return null;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let index = start; index < markedJson.length; index++) {
        const char = markedJson[index]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            end = index + 1;
            break;
          }
        }
      }
      if (end < 0) return null;
      try { JSON.parse(markedJson.slice(start, end)); } catch { return null; }
      const signal = parseWorkingMemorySignals(output);
      const goal = taskId ? taskByGoal.get(taskId) : undefined;
      return dedupWorkingMemory([{
        phaseId: taskId ?? '',
        phaseTitle: goal?.feature.split('\n')[0]?.trim() || taskId || 'Completed shard',
        kind: 'implementation',
        at: new Date(now()).toISOString(),
        summary: signal.summary,
        reusables: signal.reusables,
        decisions: signal.decisions,
        artifacts: [],
      }]);
    } catch {
      return null;
    }
  };
  const dependencyOutputFeature = (spaceId: string, feature: string): string => {
    const taskId = [...spaceIdByTask.entries()].find(([, id]) => id === spaceId)?.[0];
    const task = taskId ? graph.getTask(taskId) : undefined;
    if (!task?.dependsOn.length) {
      debug.log('self-dev.orchestrate', 'dependency.handoff', {
        taskId: taskId ?? null,
        feature: taskId ? taskByGoal.get(taskId)?.feature.split('\n')[0]?.trim() ?? '' : feature.split('\n')[0]?.trim() ?? '',
        upstreamTaskId: null,
        upstreamFeature: null,
        status: 'no-upstream',
        truncated: false,
      });
      return feature;
    }
    const outputs = task.dependsOn.flatMap((dependencyId) => {
      const dependencySpace = spaceIdByTask.get(dependencyId);
      const disposition = dependencySpace ? doneBySpace.get(dependencySpace)?.disposition : undefined;
      const dependencyFeature = taskByGoal.get(dependencyId)?.feature.split('\n')[0]?.trim();
      if (!dependencyFeature) return [];
      const unlandedStage = disposition?.stage && disposition.stage !== 'merged' && disposition.stage !== 'pr-opened'
        ? disposition.stage
        : undefined;
      if (unlandedStage) {
        return [`- ${dependencyFeature}: ${disposition?.worktreePath ?? '(no worktree)'} (outcome: ${unlandedStage})`];
      }
      return disposition?.worktreePath ? [`- ${dependencyFeature}: ${disposition.worktreePath}`] : [];
    });
    const dependencyFeature = outputs.length ? `${feature}\n\n## Dependency outputs\n${outputs.join('\n')}` : feature;
    const handoffs = task.dependsOn.flatMap((dependencyId) => {
      const dependency = taskByGoal.get(dependencyId);
      if (!dependency) return [];
      const handoff = formatShardHandoffInput(dependency.workingMemory, undefined, dependency.workingMemoryOutcome ?? 'unknown');
      const parsed = JSON.parse(handoff) as { upstream?: string; truncated?: boolean };
      debug.log('self-dev.orchestrate', 'dependency.handoff', {
        taskId: taskId ?? null,
        feature: taskId ? taskByGoal.get(taskId)?.feature.split('\n')[0]?.trim() ?? '' : feature.split('\n')[0]?.trim() ?? '',
        upstreamTaskId: dependencyId,
        upstreamFeature: dependency.feature.split('\n')[0]?.trim() ?? dependencyId,
        status: parsed.upstream === 'available' ? 'present' : parsed.upstream ?? 'unreadable',
        truncated: parsed.truncated === true,
        harvestSource: workingMemoryHarvestByTask.get(dependencyId) ?? 'not-inspected',
      });
      return [`- ${dependency.feature.split('\n')[0]?.trim() ?? dependencyId}: ${handoff}`];
    });
    return handoffs.length ? `${dependencyFeature}\n\n## Dependency handoff\n${handoffs.join('\n')}` : dependencyFeature;
  };
  const capturingSpawn: SelfImplementJobSpawn = (input) => {
    const taskId = [...spaceIdByTask.entries()].find(([, id]) => id === input.spaceId)?.[0];
    const goal = taskId ? taskByGoal.get(taskId) : undefined;
    if (cancelling) throw new Error('orchestration cancelled by signal');
    const started = baseSpawn({ ...input, feature: dependencyOutputFeature(input.spaceId, input.feature) });
    return {
      address: started.address,
      done: started.done.then((d) => {
        doneBySpace.set(input.spaceId, d);
        // ⛔ 종전엔 exitCode 0 일 때만 붙잡아 «막힌 상류의 맥락»이 사라졌다 ⇒ 하류가 같은 벽에 다시 부딪혔다.
        //   이제 막혀도 붙잡되, 결말을 «다른 값»으로 실어 하류가 「이미 된 것」으로 오독하지 않게 한다.
        if (goal) {
          let transcript: string | null = null;
          const worktreePath = d.disposition?.worktreePath;
          const screenKey = resolveHarnessScreenKey(input.spaceId, worktreePath).key;
          try { transcript = readScreenTranscript(screenKey); } catch { /* fail-soft */ }
          const harvestSource = transcript === null
            ? 'screen-missing-output-tail'
            : transcript.trim().length === 0
              ? 'screen-empty-output-tail'
              : 'screen-transcript';
          goal.workingMemory = captureWorkingMemory(taskId, transcript?.trim().length ? transcript : d.output);
          goal.workingMemoryOutcome = d.exitCode === 0 ? 'landed' : 'blocked';
          if (taskId) workingMemoryHarvestByTask.set(taskId, harvestSource);
        }
        return d;
      }),
    };
  };
  const devAdapter = createSelfImplementAdapter({ spawn: capturingSpawn, now });
  const keyedDevAdapter: SurfaceAdapter = async (task, ctx) => {
    const goal = taskByGoal.get(task.id);
    const key = goalInFlightKey(goal ?? { feature: task.surface.kind === 'self-implement' ? task.surface.feature : task.title });
    const previous = inFlightByKey.get(key);
    let releaseQueue!: () => void;
    const reserved = new Promise<void>((resolve) => { releaseQueue = resolve; });
    inFlightByKey.set(key, reserved);
    const releaseKey = () => {
      if (inFlightByKey.get(key) === reserved) inFlightByKey.delete(key);
      releaseQueue();
    };
    try {
      if (previous) {
        debug.log('self-dev.orchestrate', 'same-key-in-flight', { key, waited: true });
        await previous;
      }
      if (ctx.signal?.aborted) {
        throw new Error('aborted while waiting for same key');
      }
      if (cancelling) throw new Error('orchestration cancelled by signal');
      const result = await devAdapter(task, ctx);
      return { ...result, promise: result.promise.finally(releaseKey) };
    } catch (error) {
      releaseKey();
      throw error;
    }
  };
  const devDefinition: JobKindDefinition = {
    surfaceKind: 'self-implement',
    surface: (goal) => ({
      kind: 'self-implement',
      feature: goal.feature,
      ...(goal.base !== undefined ? { base: goal.base } : {}),
      ...(goal.autoMerge !== undefined ? { autoMerge: goal.autoMerge } : {}),
      ...(goal.autoReview !== undefined ? { autoReview: goal.autoReview } : {}),
      ...(goal.openPr !== undefined ? { openPr: goal.openPr } : {}),
      ...(goal.draft !== undefined ? { draft: goal.draft } : {}),
    }),
    // TaskDispatcher.tick → TaskDispatcher.spawn → keyedDevAdapter → dispatchSelfImplement (self-implement.ts) → capturingSpawn.
    adapter: keyedDevAdapter,
    isolation: 'worktree',
  };
  if (opts.jobKinds && Object.prototype.hasOwnProperty.call(opts.jobKinds, 'dev')) {
    throw new Error("JobKind registry: 'dev' is reserved for the legacy self-implement mapping");
  }
  const jobKinds: JobKindRegistry = { ...opts.jobKinds, dev: devDefinition };
  // 이종 JobKind 가 동일 surface 어댑터를 공유하는 정상 구성을 허용한다(예: search·media 가 같은
  //   llm-direct 어댑터를 공유하되 각기 다른 surface 생성기 사용). 동일 surfaceKind 는 어댑터를 1회만
  //   등록하고, 같은 surfaceKind 에 서로 다른 어댑터를 매핑한 경우에만 실제 충돌로 거부한다.
  const registeredBySurface = new Map<TaskSurfaceKind, { jobKind: JobKind; adapter: SurfaceAdapter }>();
  for (const [jobKind, definition] of Object.entries(jobKinds) as Array<[JobKind, JobKindDefinition | undefined]>) {
    if (!definition) continue;
    const existing = registeredBySurface.get(definition.surfaceKind);
    if (existing) {
      if (existing.adapter !== definition.adapter) {
        throw new Error(
          `JobKind registry: surfaceKind '${definition.surfaceKind}' mapped to conflicting adapters between job kinds '${existing.jobKind}' and '${jobKind}'`,
        );
      }
      continue; // 동일 어댑터 공유 — 재등록 없이 계속.
    }
    registeredBySurface.set(definition.surfaceKind, { jobKind, adapter: definition.adapter });
    registry.register(definition.surfaceKind, definition.adapter);
  }
  const concurrency = resolveOrchestrateConcurrency(opts.concurrency, {
    availableParallelism: opts.availableParallelism,
    cpuCount: opts.cpuCount,
  });
  const dispatcher = new TaskDispatcher({
    graph,
    registry,
    bus,
    now,
    ...(concurrency !== undefined ? { concurrencyCaps: { 'self-implement': concurrency } } : {}),
  });

  // S3 resume — retain every prior terminal outcome so continuation can
  // distinguish an inherited landing from a retryable failure. Checkpoints are
  // ordered, so duplicate normalized keys retain last-result-wins.
  const priorByResumeKey = new Map<string, SelfDevJobResult>();
  for (const prior of opts.resumeFrom ?? []) {
    priorByResumeKey.set(resumeKey(prior.feature), prior);
  }
  const resumedResults: SelfDevJobResult[] = [];
  const resumedByGoal = new Map<SelfDevGoal, SelfDevJobResult>();
  const resumeDispositionByGoal = new Map<SelfDevGoal, Exclude<ResumeDisposition, 'skip'>>();
  const goalsToRun: SelfDevGoal[] = [];
  const held = new Set(opts.resumeHold ?? []);
  const localGoals = new Map(opts.goals.map((goal, index) => [goal.id ?? String(index), goal]));
  // Landing is required only for declared dependencies. Shared hotPaths serialize execution
  // order (TOX edges below) but do not make an independent goal wait for another goal's PR.
  const dependencyGoals = (goal: SelfDevGoal): SelfDevGoal[] => [...new Set(
    (goal.dependsOn ?? []).map((id) => localGoals.get(id)).filter((parent): parent is SelfDevGoal => parent !== undefined && parent !== goal),
  )];
  const parents = new Set(opts.goals.flatMap(dependencyGoals));
  const landingProbe = opts.landingProbe ?? defaultLandingProbe;
  for (const g of opts.goals) {
    const prior = priorByResumeKey.get(resumeKey(g.feature));
    if (prior) {
      const disposition = held.has(prior.taskId) || (parents.has(g) && prior.status === 'done' && prior.stage === 'pr-opened')
        ? 'skip' : classifyResumeDisposition(prior);
      if (held.has(prior.taskId)) {
        debug.log('self-dev.orchestrate', 'resume.held', { taskId: prior.taskId, stage: prior.stage ?? null, wouldHaveBeen: classifyResumeDisposition(prior) });
      }
      if (disposition === 'skip') {
        const carried = { ...prior, resumeDisposition: disposition };
        resumedResults.push(carried);
        resumedByGoal.set(g, carried);
        continue;
      }
      resumeDispositionByGoal.set(g, disposition);
    }
    goalsToRun.push(g);
  }

  // One task per runnable goal. Resumed shards retain their prior task identity
  // in the complete shard-local mapping without creating phantom graph tasks.
  const taskIdByLocal = new Map<string, string>();         // goal-local id → live taskId
  const taskIdByGoal = new Map<SelfDevGoal, string>();      // original shard → current or resumed taskId
  const created: Array<{ task: ReturnType<typeof createTask>; goal: SelfDevGoal }> = [];
  opts.goals.forEach((g, i) => {
    const prior = resumedByGoal.get(g);
    if (prior) {
      taskIdByGoal.set(g, prior.taskId);
      return;
    }
    const jobKind = g.kind ?? 'dev';
    const definition = jobKinds[jobKind];
    if (!definition) throw new Error(`Unknown self-dev job kind: ${jobKind}`);
    const surface = definition.surface(g);
    if (surface.kind !== definition.surfaceKind) {
      throw new Error(
        `JobKind registry: job kind '${jobKind}' declared surfaceKind '${definition.surfaceKind}' but created '${surface.kind}'`,
      );
    }
    const task = createTask(
      {
        title: goalTitle(g),
        description: g.feature.slice(0, TASK_DEFAULTS.descriptionMaxLen),
        surface,
        isolation: definition.isolation,
      },
      { now: now() },
    );
    taskIdByLocal.set(g.id ?? String(i), task.id);
    taskIdByGoal.set(g, task.id);
    graph.addTask(task);
    taskByGoal.set(task.id, g);
    spaceIdByTask.set(task.id, spaceIdForTask(task));
    created.push({ task, goal: g });
  });

  if (opts.goals.length > 0) {
    const orchestrationId = randomUUID();
    const shards = opts.goals.map((goal, index) => ({
      goal,
      position: index + 1,
      shardId: taskIdByGoal.get(goal) ?? goal.id ?? String(index),
      summary: shardSummary(goal.feature),
    }));
    for (const shard of shards) {
      const taskId = taskIdByGoal.get(shard.goal);
      if (!taskId) continue;
      const identity: SelfDevShardIdentity = {
        orchestrationId,
        ...(opts.parentRequest === undefined ? {} : { parentRequest: opts.parentRequest }),
        shardId: shard.shardId,
        totalShards: shards.length,
        position: shard.position,
        summary: shard.summary,
        siblings: shards
          .filter((sibling) => sibling !== shard)
          .map(({ shardId, summary }) => ({ shardId, summary })),
      };
        const task = graph.getTask(taskId);
      if (task?.surface.kind === 'self-implement') {
        graph.updateTask(taskId, {
          surface: { ...task.surface, feature: shardIdentityFeature(shard.goal.feature, identity) },
        }, { now: now() });
      }
    }
  }

  // S2 — wire dependency edges (explicit `dependsOn` + hot-file overlap).
  // `graph.updateTask({dependsOn})` re-indexes edges and throws on cycle.
  let depEdges = 0;
  for (const { task, goal } of created) {
    const deps = new Set<string>();
    for (const localDep of goal.dependsOn ?? []) {
      const depTaskId = taskIdByLocal.get(localDep);
      if (depTaskId && depTaskId !== task.id) deps.add(depTaskId);
    }
    // hot-file serialization — depend on every EARLIER goal that shares a
    // hot path (deterministic: earlier index runs first). Same worktree
    // file region → never concurrent → no merge conflict.
    if (goal.hotPaths?.length) {
      for (const other of created) {
        if (other.task.id === task.id) break;   // earlier goals only (ordered)
        if (other.goal.hotPaths?.some((p) => goal.hotPaths!.includes(p))) deps.add(other.task.id);
      }
    }
    if (deps.size > 0) {
      graph.updateTask(task.id, { dependsOn: [...deps] }, { now: now() });
      depEdges += deps.size;
    }
  }

  const upstreamTaskIds = new Set<string>();
  for (const { task } of created) {
    for (const dependencyId of graph.getTask(task.id)?.dependsOn ?? []) upstreamTaskIds.add(dependencyId);
  }
  for (const taskId of upstreamTaskIds) {
    const task = graph.getTask(taskId);
    if (task?.surface.kind !== 'self-implement') continue;
    graph.updateTask(taskId, {
      surface: { ...task.surface, feature: `${task.surface.feature}${SHARD_WORKING_MEMORY_EMIT_HINT}` },
    }, { now: now() });
    debug.log('self-dev.orchestrate', 'working-memory.instruction', {
      taskId,
      feature: taskByGoal.get(taskId)?.feature.split('\n')[0]?.trim() ?? '',
      downstreamCount: created.filter(({ task: downstream }) => graph.getTask(downstream.id)?.dependsOn.includes(taskId)).length,
    });
  }

  debug.log('self-dev.orchestrate', 'start', {
    goals: opts.goals.length,
    toRun: goalsToRun.length,
    resumedDone: resumedResults.length,
    concurrency: concurrency ?? 'unknown',
    depEdges,
  });

  return new Promise<SelfDevJobResult[]>((resolve, reject) => {
    const results = new Map<string, SelfDevJobResult>();
    const blockedByParent = new Set<string>();
    const resumedByTaskId = new Map(resumedResults.map((result) => [result.taskId, result]));
    let settled = false;
    let interrupted: NodeJS.Signals | undefined;
    const signals = opts.signalSource ?? process;
    const cleanup = (): void => {
      signals.off('SIGTERM', onTerm);
      signals.off('SIGINT', onInt);
      if (pidPath) {
        try { unlinkSync(pidPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') debug.log('self-dev.orchestrate', 'pid-cleanup-failed', { pidPath, error: String(error) }, { level: 'warn' });
        }
      }
    };
    const cancel = (signal: NodeJS.Signals): void => {
      if (cancelling) {
        cleanup();
        (opts.onSecondSignal ?? ((s) => process.exit(s === 'SIGINT' ? 130 : 143)))(signal);
        return;
      }
      if (settled) return;
      cancelling = true;
      interrupted = signal;
      let pending = 0;
      for (const { task } of created) {
        const current = graph.getTask(task.id);
        if (!current || isTerminalStatus(current.status)) continue;
        if (current.status === 'running') dispatcher.kill(task.id);
        else {
          graph.updateTask(task.id, { status: 'cancelled' }, { now: now() });
          pending++;
        }
        results.set(task.id, { taskId: task.id, feature: taskByGoal.get(task.id)?.feature ?? '', status: 'cancelled', stopReason: 'signal', error: { code: 'SIGNAL', message: 'signal' } });
      }
      void (async () => {
        let jobsDeleted = 0;
        try { if (runId && (opts.podTargets || opts.deleteJobs)) jobsDeleted = await (opts.deleteJobs ?? ((id) => deleteLabelledJobs(id, opts.podTargets!, opts.spawnKubectl)))(runId); }
        catch (error) { debug.log('self-dev.orchestrate', 'job-delete-failed', { runId, error: String(error) }, { level: 'warn' }); }
        debug.log('self-dev.orchestrate', 'signal', { signal, pending, jobsDeleted });
        finishOrReject();
      })();
    };
    const onTerm = () => cancel('SIGTERM');
    const onInt = () => cancel('SIGINT');
    signals.on('SIGTERM', onTerm);
    signals.on('SIGINT', onInt);
    try {
      if (pidPath) {
        mkdirSync(join(opts.runsDir ?? selfDevRunsDir(), runId!), { recursive: true });
        const temporary = `${pidPath}.${process.pid}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, 'wx', 0o600);
        try {
          try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() - Math.floor(process.uptime() * 1000), argv0: process.argv0 }));
          } finally { closeSync(fd); }
          renameSync(temporary, pidPath);
        } catch (error) { unlinkSync(temporary); throw error; }
      }
    } catch (error) { cleanup(); reject(error); return; }

    // Current full result set: resumed-done goals + each running task's
    // state (with disposition merged when the job has settled). Reused by
    // both `finish()` and the mid-run checkpoint.
    const buildResults = (): SelfDevJobResult[] => {
      const out: SelfDevJobResult[] = [...resumedResults];
      for (const [taskId, goal] of taskByGoal) {
        const status = graph.getTask(taskId)?.status ?? 'failed';
        const resumeDisposition = resumeDispositionByGoal.get(goal);
        const base: SelfDevJobResult = results.get(taskId) ?? {
          taskId,
          feature: goal.feature,
          status,
          ...(resumeDisposition ? { resumeDisposition } : {}),
        };
        const disp = doneBySpace.get(spaceIdByTask.get(taskId) ?? '')?.disposition;
        out.push({
          ...base,
          ...(resumeDisposition ? { resumeDisposition } : {}),
          ...(disp?.stage ? { stage: disp.stage } : {}),
          ...(disp?.branch ? { branch: disp.branch } : {}),
          ...(disp?.worktreePath ? { worktreePath: disp.worktreePath } : {}),
          ...(disp?.prUrl ? { prUrl: disp.prUrl } : {}),
          ...(disp?.prNumber !== undefined ? { prNumber: disp.prNumber } : {}),
          ...(disp?.merged !== undefined ? { merged: disp.merged } : {}),
          ...(disp?.checkedHeadCommit ? { checkedHeadCommit: disp.checkedHeadCommit } : {}),
          // ⭐ `A1` — 판정 3종을 «끝까지» 옮긴다. 여기서 빠지면 트리아지가 눈을 잃는다.
          ...(disp?.mergeReason ? { mergeReason: disp.mergeReason } : {}),
          ...(!cancelling && disp?.stopReason ? { stopReason: disp.stopReason } : {}),
          ...(disp?.completionDisposition ? { completionDisposition: disp.completionDisposition } : {}),
          ...(disp?.failureClassification ? { failureClassification: disp.failureClassification } : {}),
          ...(disp?.providerErrors ? { providerErrors: disp.providerErrors } : {}),
          ...(goalCauseObservedFromFailureClassification(disp?.failureClassification) === true
            ? { goalCauseObserved: true } : {}),
          ...(disp?.runId ? { runId: disp.runId } : {}),
        });
      }
      return out;
    };

    // S3 — persist a resumable checkpoint after each job settles (fail-soft).
    const doCheckpoint = (): void => {
      if (opts.checkpoint) { try { opts.checkpoint(buildResults()); } catch { /* fail-soft */ } }
      if (opts.onSnapshot) { try { opts.onSnapshot(graph.snapshot().tasks); } catch { /* fail-soft */ } }
    };

    const finish = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      const out = buildResults();
      // S3 — teardown (opt-in): remove each job's worktree (fail-soft),
      // preserving any job that opened a PR (branch/worktree still needed).
      if (opts.teardown === true && !cancelling) {
        const rm = opts.removeWorktree ?? defaultRemoveWorktree;
        let removed = 0;
        for (const r of out) {
          if (!r.worktreePath || r.prUrl) continue;
          try { rm(r.worktreePath); removed++; } catch { /* fail-soft */ }
        }
        if (removed > 0) debug.log('self-dev.orchestrate', 'teardown', { removed });
      }
      const summary = summarizeResults(out);
      const failureKinds = summarizeFailureKinds(out);
      // ⛔⭐ 「검증 안 함」이 «산출에 보여야» 한다 — 안 그러면 「결함 0」으로 읽힌다(리뷰 #10393).
      const observedDeliverables = !cancelling && opts.deliverableTargets
        ? await observeDeliverables(opts.deliverableTargets, opts.verifyDeliverable ? { verify: opts.verifyDeliverable } : {})
        : undefined;
      const deployFindings = observedDeliverables?.deployFindings ?? opts.deployFindings;
      const triage = triageRun(
        out,
        deployFindings,
        (observedDeliverables?.unmeasured.length ?? 0) > 0,
        opts.queryPreflightWarning,
      );
      const failures = triage.classifications;
      // ⛔ 연합 리뷰의 «입력» — 「이 연합이 다 합쳐 무엇을 바꿨나」. 판정은 하지 않는다.
      //   조회 seam 이 없으면 실어도 unavailable 뿐이므로 «주입된 때만» 싣는다.
      const unionDiff = opts.readUnionDiffFiles
        ? collectOrchestrateUnionDiff(out, opts.readUnionDiffFiles)
        : undefined;
      debug.log('self-dev.orchestrate', 'orchestrate.reduce', {
        // ⛔ 「산출물을 안 쟀다」 — 「결함이 없다」와 «다른 값»이다. 지금은 생산자가 없어 언제나 true 다.
        deliverableUnmeasured: triage.deliverableUnmeasured,
        ...(observedDeliverables ? { deliverableUnmeasuredTasks: observedDeliverables.unmeasured } : {}),
        ...(triage.repairable.length ? { repairable: triage.repairable } : {}),
        total: out.length,
        done: summary.done,
        failed: summary.failed,
        cancelled: summary.cancelled,
        landed: summary.landed,
        unlanded: summary.unlanded,
        falseFailure: failureKinds.falseFailure,
        unconverged: failureKinds.unconverged,
        unclassified: failureKinds.unclassified,
        mainSyncBlocked: failureKinds.mainSyncBlocked,
        parentUnlanded: out.filter((r) => r.blockReason === 'parent-unlanded').length,
        failures,
        blockedParents: out.filter((r) => r.blockReason === 'parent-unlanded').map((r) => ({ taskId: r.taskId, blockReason: r.blockReason, parentPrNumber: r.parentPrNumber ?? null, ...(r.parentNoPr ? { parentNoPr: true } : {}) })),
        ...(unionDiff ? { unionDiff } : {}),
      });
      const outcomes: SelfDevTerminalOutcome[] = out.map((result) => ({
        taskId: result.taskId,
        status: result.status,
        stage: result.stage ?? null,
        merged: result.merged ?? null,
        prUrl: result.prUrl ?? null,
        ...(result.blockReason ? { blockReason: result.blockReason, parentPrNumber: result.parentPrNumber ?? null, ...(result.parentNoPr ? { parentNoPr: true } : {}) } : {}),
      }));
      debug.log('self-dev.orchestrate', 'done', {
        total: out.length,
        completed: summary.done,
        failed: summary.failed,
        cancelled: summary.cancelled,
        landed: summary.landed,
        unlanded: summary.unlanded,
        promoted: out.filter((r) => r.prUrl).length,
        resumedDone: resumedResults.length,
        outcomes,
      });
      doCheckpoint();
      cleanup();
      if (interrupted && signals === process) process.exit(interrupted === 'SIGINT' ? 130 : 143);
      resolve(out);
    };

    const finishOrReject = (): void => {
      void finish().catch((error) => { cleanup(); reject(error); });
    };

    const openCount = (): number => {
      const c = graph.countByStatus();
      return (OPEN_TASK_STATUSES as readonly TaskStatus[]).reduce((n, s) => n + c[s], 0);
    };

    // Guard the TOX ready set (including dependencies carried from a prior checkpoint)
    // before tick can turn ready into running. The parent's completion, not the child's
    // merge/PR settings, determines whether a landing check is required.
    const guardUnlandedParents = (): void => {
      for (const { task, goal } of created) {
        const current = graph.getTask(task.id);
        if (!current || (current.status !== 'ready' && current.status !== 'blocked')) continue;
        const parentGoals = dependencyGoals(goal);
        if (!parentGoals.length) continue;
        const missing = parentGoals.flatMap((parent) => {
          const parentId = taskIdByGoal.get(parent);
          if (!parentId) return [];
          const prior = resumedByTaskId.get(parentId);
          const live = results.get(parentId);
          const disp = doneBySpace.get(spaceIdByTask.get(parentId) ?? '')?.disposition;
          const result = prior ?? (live && { ...live, stage: disp?.stage, merged: disp?.merged, prUrl: disp?.prUrl, prNumber: disp?.prNumber, checkedHeadCommit: disp?.checkedHeadCommit });
          if (!result || result.status !== 'done') return [];
          // Default auto-merge scheduling and legacy no-disposition results stay unchanged.
          // A PR completion or explicitly unlanded parent must be checked, regardless of the child's settings.
          if (result.stage !== 'pr-opened' && result.stage !== 'worktree-completed'
            && result.merged !== false && !(parent.openPr === true && parent.autoMerge === false)) return [];
          return dependencyOnMain(result, landingProbe) ? [] : [result];
        })[0];
        if (!missing) continue;
        // TOX permits ready → backlog → blocked, but not ready → blocked directly.
        if (current.status === 'ready') graph.updateTask(task.id, { status: 'backlog' }, { now: now() });
        if (graph.getTask(task.id)?.status === 'backlog') graph.updateTask(task.id, { status: 'blocked' }, { now: now() });
        const parentNoPr = missing.stage === 'worktree-completed' && missing.prNumber === undefined && !missing.prUrl;
        const blocked: SelfDevJobResult = {
          taskId: task.id, feature: goal.feature, status: 'blocked', blockReason: 'parent-unlanded',
          ...(missing.prNumber === undefined ? {} : { parentPrNumber: missing.prNumber }),
          ...(parentNoPr ? { parentNoPr: true } : {}),
        };
        results.set(task.id, blocked);
        if (blockedByParent.has(task.id)) continue;
        blockedByParent.add(task.id);
        const line = parentUnlandedProgressLine(goal.feature.split('\n')[0]!, missing.prNumber, parentNoPr);
        console.error(line);
        debug.log('self-dev.orchestrate', 'parent-unlanded', { taskId: task.id, blockReason: 'parent-unlanded', parentPrNumber: missing.prNumber ?? null, ...(parentNoPr ? { parentNoPr: true } : {}), progress: line });
        const reason = parentNoPr ? '앞 조각 커밋이 main 에 없다'
          : missing.prNumber === undefined ? '앞 조각 PR 번호를 알 수 없고 main 착지가 확인되지 않았다'
            : `앞 조각 PR #${missing.prNumber} 이 main 에 없다`;
        (opts.emitDispatchDecision ?? emitDecision)({ kind: 'ESCALATE', what: `조각 ${goal.feature.split('\n')[0]} 대기`, reason, purpose: '없는 토대 위에 짓지 않는다', target: '사람(부모 승인·병합)', phase: 'dispatch', ...(missing.prNumber === undefined ? {} : { refs: { pr: missing.prNumber } }), ...(runId ? { runId } : {}) });
      }
    };

    // Re-tick deferred past the current microtask so the dispatcher's
    // `monitor().finally` (which frees the concurrency slot) runs first —
    // else the re-tick sees a stale active count and defers on cap.
    const scheduleTick = (): void => {
      queueMicrotask(() => {
        if (settled || cancelling) return;
        graph.promoteReady({ now: now() });
        guardUnlandedParents();
        const { dispatched } = dispatcher.tick();
        doCheckpoint();   // S3 — persist progress each cycle (crash-resumable)
        if (openCount() === 0) { finishOrReject(); return; }
        // Stuck guard: open tasks but nothing running and nothing newly
        // dispatched → no capacity will ever free (e.g. no adapter).
        if (dispatched.length === 0 && graph.listRunning().length === 0) finishOrReject();
      });
    };

    // 제1원칙 관측 — self-dev 오케스트레이터는 자율 fan-out 이라 잡별 lifecycle
    // 결정(시작·종결·disposition·캐스케이드·teardown)을 전부 logs.db 에 남긴다
    // (`elanous logs --category self-dev.orchestrate`). 관측 없는 자율은 자기인지 불가.
    const shortFeature = (id: string): string => (taskByGoal.get(id)?.feature ?? '').slice(0, 60);

    // ⭐ 관측(2026-07-21 대표 co-design) — 잡의 자식 goal-loop 화면 버퍼를 읽어 전사 tail +
    // 종결 상태를 회수한다. detached PTY goal-loop 은 스폰 프로세스 stdout 이 아니라 file-based
    // 화면 버퍼에만 남으므로, 이게 "재현 없이 진단"의 유일한 cross-process 진실원("docker logs").
    const readScreen = opts.readScreenTail ?? ((sid: string) => readHarnessScreenTail(sid));
    const screenFor = (taskId: string): { screenTail?: string; screenOutcome?: 'complete' | 'incomplete' | null; screenSpace?: string } => {
      const spaceId = spaceIdByTask.get(taskId);
      if (!spaceId) return {};
      const worktreePath = doneBySpace.get(spaceId)?.disposition?.worktreePath;
      const screenKey = resolveHarnessScreenKey(spaceId, worktreePath).key;
      try {
        const s = readScreen(screenKey);
        if (!s) return { screenSpace: screenKey };
        return { screenTail: s.text.slice(-2048), screenOutcome: s.outcome, screenSpace: screenKey };
      } catch { return { screenSpace: screenKey }; }
    };

    bus.subscribe((ev) => {
      try { opts.onEvent?.(ev); } catch { /* isolate */ }
      if (cancelling) return;
      switch (ev.kind) {
        case 'task-started':
          debug.log('self-dev.orchestrate', 'job.start', {
            taskId: ev.taskId, space: spaceIdByTask.get(ev.taskId), feature: shortFeature(ev.taskId),
          });
          break;
        case 'task-completed': {
          const disp = doneBySpace.get(spaceIdByTask.get(ev.taskId) ?? '')?.disposition;
          const screen = screenFor(ev.taskId);
          results.set(ev.taskId, {
            taskId: ev.taskId,
            feature: taskByGoal.get(ev.taskId)?.feature ?? '',
            status: 'done',
            ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
            ...(screen.screenTail ? { screenTail: screen.screenTail } : {}),
            ...(screen.screenOutcome !== undefined ? { screenOutcome: screen.screenOutcome } : {}),
            ...(screen.screenSpace ? { screenSpace: screen.screenSpace } : {}),
          });
          // disposition 관측(자기인지): 실제 stage/PR 결말을 남긴다(merged/pr-opened/
          // pr-declined 구분 — exit code 만으론 안 보임).
          debug.log('self-dev.orchestrate', 'job.done', {
            taskId: ev.taskId, feature: shortFeature(ev.taskId),
            stage: disp?.stage ?? 'completed', prUrl: disp?.prUrl ?? null, merged: disp?.merged ?? null,
            // E4 — 벤치 비교 칸(리뷰·게이트). 없으면 «안 싣는다»(못 쟀다 ≠ 실패).
            ...(disp?.gatePassed !== undefined ? { gatePassed: disp.gatePassed } : {}),
            ...(disp?.reviewVerdict ? { reviewVerdict: disp.reviewVerdict } : {}),
            ...(disp?.reviewMustFixCount !== undefined ? { reviewMustFixCount: disp.reviewMustFixCount } : {}),
            ...(screen.screenOutcome ? { screenOutcome: screen.screenOutcome } : {}),
            ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
          });
          scheduleTick();
          break;
        }
        case 'task-failed': {
          // ⭐ 관측(2026-07-21 대표) — 실패 잡의 자식 goal-loop 화면 tail 회수("docker logs").
          // detached PTY goal-loop 은 스폰 프로세스 exit-code 와 단절될 수 있어(자식은 GOAL-COMPLETE
          // 인데 스폰 프로세스는 조기 exit=false-failure), 화면 outcome 과 대조해 조정 플래그를 남긴다.
          const fScreen = screenFor(ev.taskId);
          // ★ A(2026-07-21) — false-failure 정밀화: 화면 GOAL-COMPLETE 만으론 부족(goal-loop 은 완료해도
          //   이후 gate/review 가 **정당하게** 실패하면 exit≠0 = 진짜 실패). disposition stage 가 정당한
          //   파이프라인 실패(gate-failed/review-blocked/merge-conflict/timed-out/…)면 mismatch 아님.
          //   진짜 단절 = 화면 complete + (disposition 없음[크래시 pre-json] 또는 stage 가 성공[merged/pr-opened]).
          const fDisp = doneBySpace.get(spaceIdByTask.get(ev.taskId) ?? '')?.disposition;
          const pipelineLegitFail = !!fDisp?.stage && LEGIT_PIPELINE_FAIL_STAGES.has(fDisp.stage);
          const mismatch = fScreen.screenOutcome === 'complete' && !pipelineLegitFail;
          results.set(ev.taskId, {
            taskId: ev.taskId,
            feature: taskByGoal.get(ev.taskId)?.feature ?? '',
            status: 'failed',
            error: { code: ev.errorCode, message: ev.errorMessage },
            ...(fDisp?.stage ? { stage: fDisp.stage } : {}),
            ...(fDisp?.prUrl ? { prUrl: fDisp.prUrl } : {}),
            ...(fDisp?.merged !== undefined ? { merged: fDisp.merged } : {}),
            ...(fScreen.screenTail ? { screenTail: fScreen.screenTail } : {}),
            ...(fScreen.screenOutcome !== undefined ? { screenOutcome: fScreen.screenOutcome } : {}),
            ...(fScreen.screenSpace ? { screenSpace: fScreen.screenSpace } : {}),
            ...(mismatch ? { reconcileMismatch: true } : {}),
          });
          if (mismatch) {
            debug.log('self-dev.orchestrate', 'job.reconcile', {
              taskId: ev.taskId, feature: shortFeature(ev.taskId), errorCode: ev.errorCode,
              note: 'exit-code=failed·화면=GOAL-COMPLETE·파이프라인 정당실패 아님 — 스폰 신호 단절(false-failure). worktree 성공산출 보존=salvage 대상(재빌드 말 것)',
              dispStage: fDisp?.stage ?? 'none', screenSpace: fScreen.screenSpace,
            });
          }
          const failedResult = results.get(ev.taskId)!;
          const stopReason = opts.stopAfterFailure?.(failedResult) ?? null;
          if (stopReason !== null) {
            let remainingGoals = 0;
            for (const task of created.map(({ task }) => graph.getTask(task.id)).filter((task): task is NonNullable<typeof task> => task !== undefined)) {
              if (task.id === ev.taskId || isTerminalStatus(task.status) || task.status === 'running') continue;
              try {
                graph.updateTask(task.id, { status: 'cancelled' }, { now: now() });
                results.set(task.id, {
                  taskId: task.id,
                  feature: taskByGoal.get(task.id)?.feature ?? '',
                  status: 'cancelled',
                  error: { code: 'ORCHESTRATION_STOPPED', message: stopReason },
                });
                remainingGoals++;
              } catch { /* best-effort */ }
            }
            if (remainingGoals > 0) opts.onStopAfterFailure?.({ reason: stopReason, remainingGoals });
          }
          // S3 cascade — dependents of a failed task can never become
          // ready (a dep will never be `done`) → cancel them honestly
          // instead of leaving them `blocked` (which stalls the run onto
          // the stuck-guard). subtree() = failed task + its downstream.
          let cascaded = 0;
          for (const t of graph.subtree(ev.taskId)) {
            if (t.id === ev.taskId || isTerminalStatus(t.status)) continue;
            try {
              graph.updateTask(t.id, { status: 'cancelled' }, { now: now() });
              results.set(t.id, {
                taskId: t.id,
                feature: taskByGoal.get(t.id)?.feature ?? '',
                status: 'cancelled',
                error: { code: 'DEP_FAILED', message: `dependency ${ev.taskId} failed` },
              });
              cascaded++;
            } catch { /* best-effort */ }
          }
          debug.log('self-dev.orchestrate', 'job.failed', {
            taskId: ev.taskId,
            feature: shortFeature(ev.taskId),
            ...failureObservationFields(ev.errorCode, ev.errorMessage),
            ...(cascaded > 0 ? { cascadedCancel: cascaded } : {}),
          }, { level: 'error' });
          scheduleTick();
          break;
        }
        case 'task-cancelled':
          results.set(ev.taskId, {
            taskId: ev.taskId,
            feature: taskByGoal.get(ev.taskId)?.feature ?? '',
            status: 'cancelled',
          });
          debug.log('self-dev.orchestrate', 'job.cancelled', { taskId: ev.taskId, feature: shortFeature(ev.taskId), reason: ev.reason });
          scheduleTick();
          break;
        default:
          break;
      }
    });

    // Kickoff.
    if (!cancelling) graph.promoteReady({ now: now() });
    if (!cancelling) guardUnlandedParents();
    if (!cancelling) {
      const { dispatched } = dispatcher.tick();
      if (openCount() === 0 || (blockedByParent.size > 0 && dispatched.length === 0 && graph.listRunning().length === 0)) finishOrReject();
    }
  });
}
