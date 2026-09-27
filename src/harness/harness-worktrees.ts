import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { gitStdout, type GitRunner } from './harness-clean.js';
import { isPidAlive, listWorktreeSessions, type WorktreeSession } from '../git-fs/worktree.js';
import { listPtyManifest } from '../pty-shell/pty-manifest.js';
import { queryRunningRuns, type RunningRunStatus, type RunningRunsResult } from '../self-implement/running-runs.js';

const PROVENANCE_CONFIG_KEYS = ['elanous.harness.owner', 'elanous.harness.command', 'elanous.harness.createdAt'] as const;
type WorktreeProvenance = Record<'owner' | 'command' | 'createdAt', string>;
const NOT_RECORDED = 'not-recorded';
const WORKTREE_PROGRESS_INTERVAL = 20;

/** ⚠️ `export` 는 계약이다 — `harness-worktrees.test.ts` 가 «진짜 git 저장소»로 이 함수를 문다.
 *  모의 GitRunner 로는 「확장이 꺼진 다중 워크트리」에서 git 이 실제로 무엇을 내는지 못 잰다
 *  (실측: exit 128 ⊕ "--worktree cannot be used with multiple working trees…"). 빼면 그 회귀가 죽는다. */
export function readWorktreeProvenance(path: string, run: GitRunner): WorktreeProvenance {
  // ⛔⭐⭐ 「기록이 없다」와 「못 읽었다」를 «구조»로 가른다 — 문구로 가르지 않는다.
  //   워크트리 스코프 config 확장이 «꺼져» 있으면 per-worktree 기록은 «있을 수 없다».
  //   그 상태에서 다중 워크트리면 git 은 exit 128 로 거절하는데(실측), 그걸 read-error 로 표시하면
  //   사람이 「고장」으로 읽고 「기록이 없다」는 사실이 가려진다(무인 리뷰 must-fix).
  //   ⚠️ 초판은 git 의 «영문 오류 문구»를 정규식으로 봤다 — locale·버전이 바뀌면 조용히 회귀한다
  //     (같은 리뷰의 should-fix). ⇒ 확장 «상태»를 직접 묻는다. 문구에 의존하지 않는다.
  const extension = run(['-C', path, 'config', '--get', 'extensions.worktreeConfig']);
  if (extension.stdout.trim() !== 'true') {
    return { owner: NOT_RECORDED, command: NOT_RECORDED, createdAt: NOT_RECORDED };
  }
  const values = PROVENANCE_CONFIG_KEYS.map((key) => {
    const result = run(['-C', path, 'config', '--worktree', '--get', key]);
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    if (result.status === 1) return NOT_RECORDED;
    const detail = (result.stderr || result.stdout || `git exited ${result.status ?? 'unknown'}`).trim();
    return `read-error: ${detail}`;
  });
  return { owner: values[0], command: values[1], createdAt: values[2] };
}

export type WorktreePrState = 'merged' | 'open' | 'closed' | 'none' | 'head-uncovered' | 'unknown';
export type WorktreeDisposition = 'reclaim-safe' | 'needs-human' | 'do-not-touch' | 'unjudgeable';

/** Whether the branch's content is already represented in the base branch. */
export type WorktreeBranchContent = 'already-contained' | 'differs' | 'unavailable';
export type WorktreeSessionLiveness = 'live' | 'stale' | 'unknown';

export interface WorktreeAssessmentInput {
  path: string;
  branch?: string;
  /** The primary checkout is registered first by `git worktree list`; it is never reclaimable. */
  isPrimary?: boolean;
  pr: WorktreePrState;
  dirty?: boolean;
  uniqueCommitCount?: number;
  changedFileCount?: number;
  /**
   * Explicit branch-content comparison for no-PR cleanup. Omitted preserves
   * legacy output-count behavior for existing callers.
   */
  branchContent?: WorktreeBranchContent;
  /** Opaque session IDs cannot be treated as live without a registry lookup. */
  sessionLiveness?: WorktreeSessionLiveness;
  /** Worktree-scoped creator metadata, or `not-recorded` when absent. */
  owner?: string;
  command?: string;
  createdAt?: string;
}

export interface WorktreeAssessment extends WorktreeAssessmentInput {
  disposition: WorktreeDisposition;
  reason: string;
  hasOutput: boolean;
}

export interface WorktreeAssessmentReport {
  assessments: WorktreeAssessment[];
  counts: Record<WorktreeDisposition, number>;
  rejectedRemoval: WorktreeAssessment[];
  prFallback: WorktreePrFallbackReport;
}

export interface WorktreePrFallbackReport {
  queried: number;
  unqueried: number;
}

export function assessWorktree(input: WorktreeAssessmentInput): WorktreeAssessment {
  const hasOutput = (input.uniqueCommitCount ?? 0) > 0 || (input.changedFileCount ?? 0) > 0;
  const sessionLiveness = input.sessionLiveness;
  if (input.isPrimary) return { ...input, disposition: 'do-not-touch', reason: 'primary-worktree', hasOutput };
  if (!input.branch) return { ...input, disposition: 'unjudgeable', reason: 'branch-unavailable', hasOutput };
  if (sessionLiveness === 'live') return { ...input, disposition: 'do-not-touch', reason: 'owner-session-alive', hasOutput };
  if (sessionLiveness === 'unknown') return { ...input, disposition: 'unjudgeable', reason: 'owner-session-liveness-unavailable', hasOutput };
  if (input.pr === 'open') return { ...input, disposition: 'do-not-touch', reason: 'open-pr', hasOutput };
  if (input.pr === 'unknown' || input.dirty === undefined || input.uniqueCommitCount === undefined || input.changedFileCount === undefined) {
    return { ...input, disposition: 'unjudgeable', reason: 'measurement-unavailable', hasOutput };
  }
  if (input.dirty) {
    if (input.pr === 'merged') return { ...input, disposition: 'needs-human', reason: 'merged-but-dirty', hasOutput };
    // 소유 세션이 죽은 것이 «알려진» dirty 작업은 청소기가 지울 대상이 아니라 사람이 볼 대상이다.
    // live/unknown 은 위에서 이미 갈렸고, 생존을 안 잰 호출(생략)은 종전 dirty-worktree 보호를 유지한다.
    if (sessionLiveness === 'stale') {
      return { ...input, disposition: 'needs-human', reason: 'stale-owner-dirty-worktree', hasOutput };
    }
    return { ...input, disposition: 'do-not-touch', reason: 'dirty-worktree', hasOutput };
  }
  if (input.pr === 'merged') return { ...input, disposition: 'reclaim-safe', reason: 'merged-clean', hasOutput };
  if (input.pr === 'none' && input.branchContent === 'already-contained') {
    return { ...input, disposition: 'reclaim-safe', reason: 'no-pr-content-already-contained', hasOutput };
  }
  if (input.pr === 'none' && input.branchContent === 'differs') {
    return { ...input, disposition: 'needs-human', reason: 'no-pr-content-differs', hasOutput };
  }
  if (input.pr === 'none' && input.branchContent === 'unavailable') {
    return { ...input, disposition: 'unjudgeable', reason: 'branch-content-unavailable', hasOutput };
  }
  if (input.pr === 'none' && !hasOutput) return { ...input, disposition: 'reclaim-safe', reason: 'no-pr-and-no-output', hasOutput };
  if (input.pr === 'none' && hasOutput) return { ...input, disposition: 'needs-human', reason: 'no-pr-with-output', hasOutput };
  if (input.pr === 'head-uncovered') return { ...input, disposition: 'needs-human', reason: 'pr-exists-head-uncovered', hasOutput };
  return { ...input, disposition: 'needs-human', reason: `pr-${input.pr}`, hasOutput };
}

export function planHarnessWorktrees(inputs: readonly WorktreeAssessmentInput[], removeRequested = false): WorktreeAssessmentReport {
  const assessments = inputs.map(assessWorktree);
  const counts: Record<WorktreeDisposition, number> = {
    'reclaim-safe': 0, 'needs-human': 0, 'do-not-touch': 0, unjudgeable: 0,
  };
  for (const assessment of assessments) counts[assessment.disposition] += 1;
  const rejectedRemoval = removeRequested
    ? assessments.filter((assessment) => assessment.disposition !== 'reclaim-safe')
    : [];
  return { assessments, counts, rejectedRemoval, prFallback: { queried: 0, unqueried: 0 } };
}

export function renderHarnessWorktreesReport(report: WorktreeAssessmentReport, removeRequested = false): string[] {
  const lines = ['\n━━ harness worktrees (READ-ONLY) ━━'];
  lines.push(`회수 안전 ${report.counts['reclaim-safe']} · 사람이 봐야 함 ${report.counts['needs-human']} · 손대지 않음 ${report.counts['do-not-touch']} · 판정 불가 ${report.counts.unjudgeable}`);
  lines.push(`PR 재질의 ${report.prFallback.queried} · 상한 미질의 ${report.prFallback.unqueried}`);
  for (const assessment of report.assessments) {
    lines.push(`- [${assessment.disposition}] ${assessment.path}${assessment.branch ? ` · ${assessment.branch}` : ''} · ${assessment.reason} · pr=${assessment.pr} session=${assessment.sessionLiveness ?? 'n/a'} · owner=${assessment.owner ?? NOT_RECORDED} command=${assessment.command ?? NOT_RECORDED} createdAt=${assessment.createdAt ?? NOT_RECORDED} · commits=${assessment.uniqueCommitCount ?? '?'} files=${assessment.changedFileCount ?? '?'} dirty=${assessment.dirty ?? '?'}`);
  }
  if (removeRequested) {
    lines.push('⚠️ 이 착지는 실제 worktree를 제거하지 않는다.');
    for (const rejected of report.rejectedRemoval) lines.push(`거부: ${rejected.path} · ${rejected.reason}`);
  }
  return lines;
}

export type GhWorktreeRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };
const defaultGhRunner: GhWorktreeRunner = (args, cwd) => {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 25_000 });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/** ⛔⭐⭐⭐ 상한은 «명시»하고 «닿았는지»를 본다 — 원장 `GIT-T18`·`GIT-T19`.
 *  ⚠️ 인자를 «빼는» 것은 상한을 없애는 것이 아니다: `gh pr list` 는 생략 시 기본 30 이라
 *  상한이 사라지는 게 아니라 **안 보이게** 되고, 그러면 다음 사람이 「상한 없음」으로 읽는다.
 *  ⇒ 반환 수가 상한과 같으면 그 조회는 **데이터가 아니므로** `unknown` 으로 fail-closed 한다.
 *  ⚠️ 실무 위험은 낮다(실측: `--head` 는 «서버 쪽» 필터라 한 브랜치의 PR 이 상한을 넘어야 걸린다 —
 *     `gh pr list --head <옛 브랜치> --limit 1` 이 옛 PR 을 돌려준다). 그래도 탐지는 둔다:
 *     ***위험이 낮은 것과 자가 옳은 것은 다른 문제다.*** */
const PR_QUERY_LIMIT = 100;
/** 한 번에 받는 조회의 명시 상한. 반환 수가 이 값에 닿으면 목록은 부분집합이고, 못 본 브랜치를 `none` 으로 접지 않는다. */
export const WORKTREE_PR_BATCH_LIMIT = 300;
/** A truncated batch may leave many branches unanswered; bound exact fallback queries per assessment run. */
export const WORKTREE_PR_FALLBACK_LIMIT = 100;

export function queryWorktreePr(branch: string, headOid: string, cwd: string, runGh: GhWorktreeRunner = defaultGhRunner): WorktreePrState {
  const result = runGh(['pr', 'list', '--head', branch, '--state', 'all', '--limit', String(PR_QUERY_LIMIT), '--json', 'state,headRefOid', '--jq', '.[] | [.state, .headRefOid] | @tsv'], cwd);
  if (result.status !== 0) return 'unknown';
  const output = result.stdout.trim();
  if (!output) return 'none';
  const entries = output.split('\n').map((line) => line.split('\t'));
  // 반환 수가 상한과 «같으면» 잘렸을 수 있다 ⇒ 「PR 없음」으로 읽으면 회수 안전 쪽으로 위험하게 틀린다.
  if (entries.length >= PR_QUERY_LIMIT) return 'unknown';
  if (entries.some((entry) => entry.length !== 2 || !entry[1] || !['OPEN', 'MERGED', 'CLOSED'].includes(entry[0]))) return 'unknown';
  const states = entries
    .filter((entry): entry is [string, string] => entry[1] === headOid)
    .map(([state]) => state);
  if (states.includes('OPEN')) return 'open';
  if (states.includes('MERGED')) return 'merged';
  if (states.includes('CLOSED')) return 'closed';
  return 'head-uncovered';
}

export interface WorktreePrBatchEntry {
  state: string;
  headRefOid: string;
}

/** 한 번의 `gh pr list` 결과. `ok:false` · `truncated` · 빈 목록은 서로 다른 값이다. */
export interface WorktreePrBatchResult {
  ok: boolean;
  truncated: boolean;
  byBranch: Map<string, WorktreePrBatchEntry[]>;
}

function emptyWorktreePrBatch(ok: boolean): WorktreePrBatchResult {
  return { ok, truncated: false, byBranch: new Map() };
}

function parseWorktreePrBatch(stdout: string, limit: number): WorktreePrBatchResult {
  const trimmed = stdout.trim();
  if (!trimmed) return emptyWorktreePrBatch(true);
  try {
    const prs: unknown = JSON.parse(trimmed);
    if (!Array.isArray(prs)) return emptyWorktreePrBatch(false);
    const byBranch = new Map<string, WorktreePrBatchEntry[]>();
    for (const pr of prs) {
      if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) return emptyWorktreePrBatch(false);
      const { headRefName, state, headRefOid } = pr as { headRefName?: unknown; state?: unknown; headRefOid?: unknown };
      if (typeof headRefName !== 'string' || headRefName.trim().length === 0
        || typeof headRefOid !== 'string' || !headRefOid
        || (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')) {
        return emptyWorktreePrBatch(false);
      }
      const entries = byBranch.get(headRefName) ?? [];
      entries.push({ state, headRefOid });
      byBranch.set(headRefName, entries);
    }
    return { ok: true, truncated: prs.length >= limit, byBranch };
  } catch {
    return emptyWorktreePrBatch(false);
  }
}

/** `gh pr list --state all --limit <cap>` 를 1회 호출해 브랜치별 raw 상태를 나눈다. 루프에 넣지 않는 조회. */
export function queryWorktreePrsBatch(
  cwd: string,
  runGh: GhWorktreeRunner = defaultGhRunner,
  limit: number = WORKTREE_PR_BATCH_LIMIT,
): WorktreePrBatchResult {
  const result = runGh(
    ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', 'headRefName,state,headRefOid'],
    cwd,
  );
  if (result.status !== 0) return emptyWorktreePrBatch(false);
  return parseWorktreePrBatch(result.stdout, limit);
}

/** 배치 결과에서 한 브랜치의 기존 WorktreePrState 를 읽는다. 못 본 것은 `none` 이 아니다. */
export function worktreePrStateFromBatch(branch: string, headOid: string, batch: WorktreePrBatchResult): WorktreePrState {
  if (!batch.ok) return 'unknown';
  const entries = batch.byBranch.get(branch) ?? [];
  if (entries.length === 0) return batch.truncated ? 'unknown' : 'none';
  if (entries.some((entry) => !entry.headRefOid || !['OPEN', 'MERGED', 'CLOSED'].includes(entry.state))) return 'unknown';
  const states = entries.filter((entry) => entry.headRefOid === headOid).map((entry) => entry.state);
  if (states.includes('OPEN')) return 'open';
  if (states.includes('MERGED')) return 'merged';
  if (states.includes('CLOSED')) return 'closed';
  return batch.truncated ? 'unknown' : 'head-uncovered';
}

export function worktreePrCandidateKey(branch: string, headOid: string): string {
  return `${branch}\0${headOid}`;
}

export function defineBoundedPrFallback(
  candidates: readonly { branch: string; headOid: string }[],
  batch: WorktreePrBatchResult,
  cwd: string,
  runGh: GhWorktreeRunner = defaultGhRunner,
  limit: number = WORKTREE_PR_FALLBACK_LIMIT,
): { states: Map<string, WorktreePrState>; queried: number; unqueried: number } {
  const states = new Map<string, WorktreePrState>();
  if (!batch.truncated) return { states, queried: 0, unqueried: 0 };
  const unknown = [...new Map(
    candidates
      .filter(({ branch, headOid }) => worktreePrStateFromBatch(branch, headOid, batch) === 'unknown')
      .map((candidate) => [worktreePrCandidateKey(candidate.branch, candidate.headOid), candidate]),
  ).values()];
  const queried = unknown.slice(0, limit);
  for (const { branch, headOid } of queried) states.set(worktreePrCandidateKey(branch, headOid), queryWorktreePr(branch, headOid, cwd, runGh));
  return { states, queried: queried.length, unqueried: unknown.length - queried.length };
}

function parseCount(result: { ok: boolean; value: string }): number | undefined {
  return result.ok && /^\d+$/.test(result.value) ? Number(result.value) : undefined;
}

export function parseRegisteredWorktreeRecords(output: string): Array<{ path: string; branch?: string; isPrimary: boolean }> {
  const records: Array<{ path: string; branch?: string; isPrimary: boolean }> = [];
  let current: { path: string; branch?: string; isPrimary: boolean } | undefined;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: resolve(field.slice('worktree '.length)), isPrimary: records.length === 0 };
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) records.push(current);
  return records;
}

function countNulItems(result: { ok: boolean; value: string }): number | undefined {
  if (!result.ok) return undefined;
  return result.value.split('\0').filter(Boolean).length;
}

function sessionsForPath(path: string, sessions: readonly WorktreeSession[]): WorktreeSession[] {
  const normalizedPath = resolve(path);
  return sessions.filter((session) => resolve(session.worktreePath) === normalizedPath);
}

export function aggregateSessionLiveness(liveness: readonly WorktreeSessionLiveness[]): WorktreeSessionLiveness | undefined {
  if (liveness.includes('live')) return 'live';
  if (liveness.includes('unknown')) return 'unknown';
  return liveness.includes('stale') ? 'stale' : undefined;
}

const OWNER_RUN_PREFIX = 'dev:';

/** Recorded harness owners are `dev:<runId>` only. Anything else is not a run id. */
function parseRecordedOwnerRunId(owner: string): string | undefined {
  if (!owner.startsWith(OWNER_RUN_PREFIX)) return undefined;
  const runId = owner.slice(OWNER_RUN_PREFIX.length);
  return runId.length > 0 ? runId : undefined;
}

function ownerRunQueryIsIncomplete(result: RunningRunsResult): boolean {
  const ledger = result.ledger;
  return result.pty.unreadable.length > 0
    || ledger.unreadableLedgerCount > 0
    || ledger.unreadableLedgerDirectoryCount > 0
    || ledger.unreadableLedgerDirectoryAccessCount > 0
    || ledger.indeterminateLedgerDirectoryCount > 0;
}

function ownerRunStatusesFromQuery(result: RunningRunsResult | undefined): Map<string, RunningRunStatus> | undefined {
  if (!result || !Array.isArray(result.entries) || ownerRunQueryIsIncomplete(result)) return undefined;
  return new Map(result.entries.map((entry) => [entry.runId, entry.status]));
}

function sessionLivenessFromOwnerRun(
  owner: string,
  statuses: Map<string, RunningRunStatus> | undefined,
): WorktreeSessionLiveness | undefined {
  if (!statuses) return undefined;
  const runId = parseRecordedOwnerRunId(owner);
  if (!runId) return undefined;
  const status = statuses.get(runId);
  if (status === 'running' || status === 'probable-running') return 'live';
  if (status === 'ended-unclosed') return 'stale';
  if (status === 'unknown') return 'unknown';
  return undefined;
}

export function listRegisteredWorktrees(run: GitRunner): Array<{ path: string; branch?: string; isPrimary: boolean }> | undefined {
  const result = run(['worktree', 'list', '--porcelain', '-z']);
  if (result.status !== 0) return undefined;
  return parseRegisteredWorktreeRecords(result.stdout);
}

export function execHarnessWorktrees(deps: {
  run?: GitRunner;
  runGh?: GhWorktreeRunner;
  /** Testable override for the bounded per-branch fallback; production uses WORKTREE_PR_FALLBACK_LIMIT. */
  prFallbackLimit?: number;
  sessions?: readonly WorktreeSession[];
  /** Resolves every session id against the owning session runtime. */
  sessionLiveness?: (session: WorktreeSession) => WorktreeSessionLiveness;
  listPtyManifest?: typeof listPtyManifest;
  /** Testable override; production calls `queryRunningRuns()` once per command. */
  queryRunningRuns?: typeof queryRunningRuns;
  removeRequested?: boolean;
  /** Progress is diagnostic only; report rendering remains the caller's stdout responsibility. */
  progress?: (line: string) => void;
} = {}): WorktreeAssessmentReport {
  const run: GitRunner = deps.run ?? ((args) => {
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: 25_000 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  const worktrees = listRegisteredWorktrees(run);
  if (!worktrees) return planHarnessWorktrees([{ path: '(registered worktrees unavailable)', pr: 'unknown' }], !!deps.removeRequested);
  const progress = deps.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const startedAt = Date.now();
  progress(`harness worktrees: ${worktrees.length}개 점검 시작`);
  const sessions = deps.sessions ?? listWorktreeSessions();
  const sessionLiveness = (session: WorktreeSession): WorktreeSessionLiveness => {
    if (deps.sessionLiveness) return deps.sessionLiveness(session);
    if (/^\d+$/.test(session.sessionId)) return isPidAlive(Number(session.sessionId)) ? 'live' : 'stale';
    try {
      return (deps.listPtyManifest ?? listPtyManifest)().some((pty) => pty.sessionId === session.sessionId && pty.alive) ? 'live' : 'stale';
    } catch {
      return 'unknown';
    }
  };
  const runGh = deps.runGh ?? defaultGhRunner;
  const prBatch = queryWorktreePrsBatch(worktrees[0]?.path ?? '.', runGh);
  const queryOwnerRuns = deps.queryRunningRuns ?? queryRunningRuns;
  let ownerRunStatuses: Map<string, RunningRunStatus> | undefined;
  try {
    ownerRunStatuses = ownerRunStatusesFromQuery(queryOwnerRuns({ caller: 'harness-worktrees' }));
  } catch {
    ownerRunStatuses = undefined;
  }
  const measurements = worktrees.map((worktree) => ({
    worktree,
    headOid: worktree.branch ? gitStdout(['-C', worktree.path, 'rev-parse', 'HEAD'], run) : undefined,
  }));
  const prFallback = defineBoundedPrFallback(
    measurements.flatMap(({ worktree, headOid }) => !worktree.isPrimary && worktree.branch && headOid?.ok ? [{ branch: worktree.branch, headOid: headOid.value }] : []),
    prBatch,
    worktrees[0]?.path ?? '.',
    runGh,
    deps.prFallbackLimit,
  );
  const inputs = measurements.map(({ worktree, headOid }, index) => {
    if (index % WORKTREE_PROGRESS_INTERVAL === 0) progress(`harness worktrees: ${index + 1}/${worktrees.length} · ${Math.floor((Date.now() - startedAt) / 1000)}초 경과`);
    const matchingSessions = sessionsForPath(worktree.path, sessions);
    const sessionOwnership = aggregateSessionLiveness(matchingSessions.map(sessionLiveness));
    const provenance = readWorktreeProvenance(worktree.path, run);
    const ownerRunLiveness = sessionLivenessFromOwnerRun(provenance.owner, ownerRunStatuses);
    const ownership = aggregateSessionLiveness([
      ...(sessionOwnership ? [sessionOwnership] : []),
      ...(ownerRunLiveness ? [ownerRunLiveness] : []),
    ]);
    const uniqueCommitCount = worktree.branch
      ? parseCount(gitStdout(['-C', worktree.path, 'rev-list', '--count', 'origin/main..HEAD'], run))
      : undefined;
    const changedFileCount = worktree.branch
      ? countNulItems(gitStdout(['-C', worktree.path, 'diff', '--name-only', '-z', 'origin/main...HEAD'], run))
      : undefined;
    const dirty = worktree.branch
      ? (() => { const result = gitStdout(['-C', worktree.path, 'status', '--porcelain'], run); return result.ok ? result.value !== '' : undefined; })()
      : undefined;
    const batchPr = worktree.branch && headOid?.ok
      ? worktreePrStateFromBatch(worktree.branch, headOid.value, prBatch)
      : 'unknown' as const;
    return {
      path: worktree.path,
      isPrimary: worktree.isPrimary,
      ...(worktree.branch ? {
        branch: worktree.branch,
        pr: headOid?.ok
          ? prFallback.states.get(worktreePrCandidateKey(worktree.branch, headOid.value)) ?? batchPr
          : batchPr,
      } : { pr: 'unknown' as const }),
      dirty,
      uniqueCommitCount,
      changedFileCount,
      ...provenance,
      ...(ownership ? { sessionLiveness: ownership } : {}),
    };
  });
  const report = { ...planHarnessWorktrees(inputs, !!deps.removeRequested), prFallback: { queried: prFallback.queried, unqueried: prFallback.unqueried } };
  progress(`harness worktrees: ${worktrees.length}개 점검 완료 · ${Math.floor((Date.now() - startedAt) / 1000)}초 소요`);
  debug.log('harness.worktrees', 'assessed', { total: report.assessments.length, counts: report.counts, prFallback: report.prFallback, removeRequested: !!deps.removeRequested });
  return report;
}
