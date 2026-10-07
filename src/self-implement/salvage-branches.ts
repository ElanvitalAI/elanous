/**
 * SALVAGE-VISIBLE — Pod 런이 멈추며 남긴 수확 가지(`salvage/<job>/<worktree>`)를 «런 하나 → PR | 수확 가지 | 없음 | 모름» 으로 보인다.
 *
 * S: Pod Job 은 자식 rc≠0 이면 워크트리를 `salvage/si-task-<job>/self-impl-…-r<run 16진 앞 6자>` 로 push 한다
 *    (`src/task-orchestrator/surfaces/self-implement-pod.ts` salvage 단계 · 이름은 `plannedSelfImplBranch` 의 `-r` 접미).
 * C: 10-07 세 자리가 PR·`salvage-pushed` 로그만 보고 멈춘 Pod 런 여덟을 «수확 0» 으로 읽었다 — 여덟 다 수백 줄짜리 가지가 있었다.
 * Q: 런 id 하나로 그 가지를 «한 번의 목록»에서 찾고, 크기를 재고, 못 읽었을 때 «없음» 이라 말하지 않으려면?
 * A: `git ls-remote origin 'refs/heads/salvage/*'` 한 번 → `-r<6>` 접미로 Job 을 고르고, 같은 Job 의 형제(`/repo`·`-early`)까지
 *    numstat 로 재서 `.gitignore`·`docs/goals/**` 만 건드린 가지는 버린다. 목록 실패는 `unknown` 이다(⛔ `none` 이 아니다).
 *
 * 순수 모듈 — git 은 주입된 러너로만 부른다(시험은 네트워크 0).
 */
import { runGitCommand } from '../git-fs/runner.js';

export interface SalvageGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SalvageGitRunner = (args: string[]) => SalvageGitResult;

export interface SalvageDiffstat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface SalvageBranch {
  branch: string;
  sha: string;
  diffstat: SalvageDiffstat;
}

export type SalvageLookup =
  | { status: 'found'; branches: SalvageBranch[] }
  | { status: 'none'; trivialSkipped: number }
  | { status: 'unknown'; reason: string }
  /** PR 이 이겨서 가지를 «조회하지 않았다» — ⛔ 부재(`none`)가 아니다. */
  | { status: 'not-checked' };

export interface RemoteSalvageRef {
  branch: string;
  sha: string;
}

const SALVAGE_REF_PREFIX = 'refs/heads/';

/** `run-bfe2b5c1-…` → `bfe2b5` — `plannedSelfImplBranch` 의 `-r` 접미와 같은 규칙. 6자가 안 되면 null(⛔ 짧은 접두는 남의 가지를 문다). */
export function runSuffixKey(runId: string): string | null {
  // `run-` 뒤에 «연속된» 16진 6자가 있어야 한다 — 구분자를 지우고 이어 붙이면 `run-ab-cdef` 가 남의 `abcdef` 를 문다.
  const m = /^(?:run-)?([0-9a-f]{6})/i.exec(runId.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** `git ls-remote` 출력 → `{ branch, sha }`. salvage/ 가 아닌 «올바른» 줄은 버리고, 형식이 깨진 비어 있지 않은 줄은 `unparsed` 로 센다
 *  (⛔ rc=0 ⊕ 못 읽은 출력을 «없음» 으로 접지 않는다). */
export function parseLsRemote(stdout: string): RemoteSalvageRef[] & { unparsed?: number } {
  const rows: RemoteSalvageRef[] & { unparsed?: number } = [];
  let unparsed = 0;
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    // 공백만 있는 줄도 «못 읽은 줄» 이다(⛔ 건너뛰면 깨진 목록이 «없음» 이 된다).
    const m = /^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/\S+)$/i.exec(line);
    if (!m) {
      unparsed += 1;
      continue;
    }
    if (!m[2]!.startsWith(`${SALVAGE_REF_PREFIX}salvage/`)) continue;
    rows.push({ sha: m[1]!.toLowerCase(), branch: m[2]!.slice(SALVAGE_REF_PREFIX.length) });
  }
  if (unparsed > 0) rows.unparsed = unparsed;
  return rows;
}

/** 워크트리 조각(마지막 경로 성분)이 `-r<key>` 또는 `-r<key>-early` 로 끝나는가. */
export function branchMatchesRun(branch: string, key: string): boolean {
  const leaf = branch.slice(branch.lastIndexOf('/') + 1).toLowerCase();
  return leaf.endsWith(`-r${key}`) || leaf.endsWith(`-r${key}-early`);
}

function jobDir(branch: string): string {
  return branch.slice(0, branch.lastIndexOf('/'));
}

/** 런 하나에 속하는 원격 가지 — `-r<key>` 로 맞은 Job 디렉토리의 형제 전부(`/repo` 포함). */
export function selectRunSalvageRefs(refs: readonly RemoteSalvageRef[], key: string): RemoteSalvageRef[] {
  const jobs = new Set(refs.filter((ref) => branchMatchesRun(ref.branch, key)).map((ref) => jobDir(ref.branch)));
  return refs.filter((ref) => jobs.has(jobDir(ref.branch)));
}

/** 루트 `.gitignore`·`docs/goals/**` 만 바꾼 가지는 «수확할 일» 이 아니다(Pod 가 `/repo` 에 골 문서만 남긴다). */
export function isTrivialSalvagePath(path: string): boolean {
  // ⛔ trim 하지 않는다 — `-z` 경로는 원 바이트이고 ` .gitignore` 는 다른 파일이다.
  return path === '.gitignore' || path.startsWith('docs/goals/');
}

/** `git diff --numstat -z --no-renames` → diffstat ⊕ 경로. 레코드는 NUL 로 끊기고 경로는 따옴표 없이 «원 바이트» 그대로다
 *  (⛔ `-z` 없이는 한글·특수문자 경로가 `"docs/goals/\355…"` 로 감싸져 제외 규칙을 못 탄다). 바이너리(`-`)는 줄 수 0. */
export function parseNumstat(stdout: string): { diffstat: SalvageDiffstat; paths: string[]; unparsed: number } {
  const paths: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let unparsed = 0;
  const records = stdout.split('\0');
  // `-z` 출력은 레코드마다 NUL 로 «끝난다» — 마지막 조각이 비어 있지 않으면 잘린 출력이다(⛔ 정상 레코드로 받지 않는다).
  const tail = records.pop() ?? '';
  if (tail !== '') unparsed += 1;
  for (const record of records) {
    if (record === '') {
      unparsed += 1;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t([^\0]+)$/.exec(record.replace(/^\n+/, ''));
    if (!m) {
      unparsed += 1;
      continue;
    }
    insertions += m[1] === '-' ? 0 : Number(m[1]);
    deletions += m[2] === '-' ? 0 : Number(m[2]);
    paths.push(m[3]!);
  }
  return { diffstat: { files: paths.length, insertions, deletions }, paths, unparsed };
}

/** 러너가 «던져도» 결과로 접는다 — 실행 예외는 rc=null ⊕ 메시지(호출부가 `unknown` 으로 옮긴다). */
function runSafely(git: SalvageGitRunner, args: string[]): SalvageGitResult {
  try {
    return git(args);
  } catch (error) {
    return { status: null, stdout: '', stderr: `threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function failureReason(step: string, result: SalvageGitResult): string {
  const tail = result.stderr.trim().split(/\r?\n/).at(-1) ?? '';
  return `${step} rc=${result.status ?? 'signal'}${tail ? ` · ${tail.slice(0, 160)}` : ''}`;
}

export interface FindSalvageOptions {
  /** 이미 읽은 ls-remote 목록(여러 런을 한 번의 목록으로). 없으면 러너로 한 번 읽는다. */
  listing?: RemoteSalvageRef[] | { error: string };
}

/** 비교 기준 — fetch 가 함께 갱신하는 `origin/main` 하나로 고정한다(다른 기준은 fetch 와 어긋난다). */
const SALVAGE_DIFF_BASE = 'origin/main';

/** `git ls-remote origin 'refs/heads/salvage/*'` 한 번. 실패는 `{ error }` — 호출부가 `unknown` 으로 옮긴다. */
export function listRemoteSalvageRefs(git: SalvageGitRunner): RemoteSalvageRef[] | { error: string } {
  const result = runSafely(git, ['ls-remote', 'origin', 'refs/heads/salvage/*']);
  if (result.status !== 0) return { error: failureReason('ls-remote', result) };
  const rows = parseLsRemote(result.stdout);
  if (rows.unparsed) return { error: `ls-remote 출력 ${rows.unparsed}줄을 못 읽음` };
  return rows;
}

/** 런 id → 그 런의 수확 가지. 목록·fetch·diff 중 하나라도 못 읽으면 `unknown`(⛔ `none` 으로 접지 않는다). */
export function findRunSalvageBranches(runId: string, git: SalvageGitRunner, options: FindSalvageOptions = {}): SalvageLookup {
  const key = runSuffixKey(runId);
  if (key === null) return { status: 'unknown', reason: `런 id 에서 16진 6자를 못 뽑았다 (${runId})` };
  const listing = options.listing ?? listRemoteSalvageRefs(git);
  if (!Array.isArray(listing)) return { status: 'unknown', reason: listing.error };
  const refs = selectRunSalvageRefs(listing, key);
  if (refs.length === 0) return { status: 'none', trivialSkipped: 0 };
  const fetched = runSafely(git, ['fetch', '--no-tags', '--quiet', 'origin', 'main', ...refs.map((ref) => `${SALVAGE_REF_PREFIX}${ref.branch}`)]);
  if (fetched.status !== 0) return { status: 'unknown', reason: failureReason('fetch', fetched) };
  const branches: SalvageBranch[] = [];
  let trivialSkipped = 0;
  for (const ref of refs) {
    const diff = runSafely(git, ['diff', '--numstat', '-z', '--no-renames', `${SALVAGE_DIFF_BASE}...${ref.sha}`]);
    if (diff.status !== 0) return { status: 'unknown', reason: failureReason(`diff ${ref.branch}`, diff) };
    const { diffstat, paths, unparsed } = parseNumstat(diff.stdout);
    if (unparsed > 0) return { status: 'unknown', reason: `diff ${ref.branch} 출력 ${unparsed}줄을 못 읽음` };
    if (paths.every(isTrivialSalvagePath)) {
      trivialSkipped += 1;
      continue;
    }
    branches.push({ branch: ref.branch, sha: ref.sha, diffstat });
  }
  branches.sort((a, b) => b.diffstat.insertions + b.diffstat.deletions - (a.diffstat.insertions + a.diffstat.deletions));
  return branches.length > 0 ? { status: 'found', branches } : { status: 'none', trivialSkipped };
}

/** 실물 러너 — 공용 git 심(`runGitCommand` · 락 재시도) 위에서 cwd 를 «인자로» 받는다. */
export function gitSalvageRunner(cwd: string): SalvageGitRunner {
  return (args) => {
    const result = runGitCommand(cwd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

export type RunPrState =
  | { status: 'pr'; number: number }
  | { status: 'none' }
  | { status: 'unknown'; reason: string };

export type RunSalvageOutcome = 'pr' | 'salvage' | 'none' | 'unknown';

export interface RunSalvageVerdict {
  runId: string;
  outcome: RunSalvageOutcome;
  pr: RunPrState;
  salvage: SalvageLookup;
  line: string;
}

function branchLine(branch: SalvageBranch): string {
  return `수확 가지 ${branch.branch} (+${branch.diffstat.insertions}/-${branch.diffstat.deletions} · ${branch.diffstat.files} files)`;
}

/** 판정 — PR 이 있으면 PR 이 이긴다. 없으면 수확 가지 → 없음 → 모름 순. PR 을 못 읽었으면 «PR 모름» 을 같이 단다. */
export function decideRunSalvage(runId: string, pr: RunPrState, salvage: SalvageLookup): RunSalvageVerdict {
  const prNote = pr.status === 'unknown' ? ` · PR 모름(${pr.reason})` : '';
  if (pr.status === 'pr') return { runId, outcome: 'pr', pr, salvage, line: `${runId}  PR #${pr.number}` };
  if (salvage.status === 'found') {
    const [first, ...rest] = salvage.branches;
    const more = rest.length > 0 ? ` ⊕ 가지 ${rest.length}개 더` : '';
    return { runId, outcome: 'salvage', pr, salvage, line: `${runId}  ${branchLine(first!)}${more}${prNote}` };
  }
  if (salvage.status === 'not-checked') return { runId, outcome: 'unknown', pr, salvage, line: `${runId}  모름(수확 가지 미조회)${prNote}` };
  if (salvage.status === 'unknown') return { runId, outcome: 'unknown', pr, salvage, line: `${runId}  모름(${salvage.reason})${prNote}` };
  const skipped = salvage.trivialSkipped > 0 ? ` (골 문서·.gitignore 만 있는 가지 ${salvage.trivialSkipped}개 제외)` : '';
  // PR 을 못 읽었으면 «없음» 이라 단정하지 않는다.
  if (pr.status === 'unknown') return { runId, outcome: 'unknown', pr, salvage, line: `${runId}  모름(수확 가지 없음${skipped} · PR 모름 — ${pr.reason})` };
  return { runId, outcome: 'none', pr, salvage, line: `${runId}  없음${skipped}` };
}

/** 원장 항목 → PR 상태. 마지막 `pr-opened` 의 번호(없으면 `run-rollup.prNumber`).
 *  ⛔ 번호가 없다고 곧 «PR 없음» 이 아니다 — 원장이 «종료(`run-status`)» 를 PR 아닌 단계로 적었을 때만 `none`.
 *  원장 파일이 없거나(호스트가 모르는 Pod 런) 종료 기록이 없거나 종료가 PR 단계인데 번호가 없으면 `unknown`. */
export function prStateFromLedger(entries: ReadonlyArray<{ event: string; data: Record<string, unknown> }> | null): RunPrState {
  if (entries === null) return { status: 'unknown', reason: '호스트 원장 없음' };
  const pick = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);
  const prNumberOf = (data: Record<string, unknown>): number | null => pick(data.number) ?? pick(data.prNumber)
    ?? (typeof data.prUrl === 'string' ? pick(Number(/\/pull\/(\d+)/.exec(data.prUrl)?.[1])) : null);
  const openedEntries = entries.filter((entry) => entry.event === 'pr-opened');
  const opened = openedEntries.at(-1)?.data;
  // 번호 «있는» 마지막 pr-opened — 뒤에 번호 없는 기록이 와도 알려진 PR 을 버리지 않는다.
  const number = openedEntries.map((entry) => prNumberOf(entry.data)).filter((n): n is number => n !== null).at(-1)
    ?? pick(entries.filter((entry) => entry.event === 'run-rollup').at(-1)?.data.prNumber) ?? null;
  if (number !== null) return { status: 'pr', number };
  if (opened !== undefined) return { status: 'unknown', reason: '원장에 pr-opened 가 있으나 번호 없음' };
  const terminal = entries.filter((entry) => entry.event === 'run-status').at(-1)?.data.stage;
  if (typeof terminal !== 'string') return { status: 'unknown', reason: '원장에 PR·종료 기록 없음' };
  if (!NO_PR_TERMINAL_STAGES.has(terminal)) return { status: 'unknown', reason: `마지막 단계 ${terminal} — PR 없는 종료로 확인 안 됨` };
  return { status: 'none' };
}

/** PR 을 열기 «전에» 끝나는 종료 단계(`run-status-mapping.ts` `SelfImplementStage` 중). ⛔ merged·pr-opened·merge-ready·merge-conflict 는
 *  PR 이 있었을 단계라 빠진다 — 그 단계인데 번호가 없으면 `unknown`. 진행 중 단계도 여기 없으므로 `unknown`. */
const NO_PR_TERMINAL_STAGES: ReadonlySet<string> = new Set([
  'worktree-completed', 'gate-failed', 'review-blocked', 'no-changes', 'aborted', 'timed-out', 'pr-declined', 'soft-stopped', 'parked',
]);
