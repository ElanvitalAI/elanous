// ── Mission PR Manager (대표 2026-07-12) ──────────────────────────────────
//
// 대표 지시: "새 PR 을 만들지 말고 기존 PR 을 재활용하라(복잡하더라도). 클래스/유틸/팩토리로
// 깔끔히." 흩어진 gh/git PR 조작(makePr 인라인·mission-pr-rollback 의 close/merge)을 하나의
// 주입형(팩토리) 추상화로 모은다. 테스트는 CmdRunner 를 스텁으로 주입해 실제 gh/git 없이 검증.
//
// 핵심 = upsertPr: 페이즈 브랜치명이 안정(se/…-<phaseHex>)이므로 같은 브랜치에 force-push 하면
// GitHub 이 기존 PR 을 자동 업데이트(닫고 새로 안 만듦·리뷰 히스토리 보존). 재구현이 이전 부실
// 구현을 교체(누적 아님). 기존 PR 없으면 새로 생성.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { githubAutomationToken } from '../auth/github-app-token.js';
import { debug, redactSecretText } from '../debug/log.js';
import { POD_GITHUB_CREDENTIAL_TOKEN_ENV, POD_GITHUB_CREDENTIAL_URL_ENV } from '../nexus/api/pod-credential-api.js';
import { runGitWithRetry } from '../git-fs/retry.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../git-fs/worktree.js';
import { isElanousRuntimeArtifactPath } from '../self-implement/gate-scope.js';
import { isTransientExecutionFailure } from '../self-dev/execution-transient.js';
import { withGhRestFallback } from './gh-rest-fallback.js';
import { cardIdFromBody, cellIdFromBody, guardNewPr, hasCardMarker, parseDiffHunks, readOpenPrs, recordGuardUnmeasured, sharedCensusDiffCache, sliceMarkerFromBody, spawnParallelCommands, type GuardVerdict, type HunkOverlapMode, type PrToolParallelCommand, type Seat } from '../pr-tool/census.js';
import { labelsForAxis, PR_LABEL_NAMES } from '../github/pr-labels.js';
import { getUserConfig } from '../user-config.js';
import { runSuffixKey } from '../self-implement/salvage-branches.js';

/** ★ stderr 캡처(대표 2026-07-21·관측 갭) — 종전엔 stdout 만 담아 git/gh 실패 사유가 소실됐다
 *  (705308: makePr 실패가 bare null 로 뭉뚱그려져 triage 가 "인증·네트워크"로 환각 오라우팅).
 *  이제 err 에 stderr 를 담아 upsertPr 가 실패 단계·사유를 구조화해 반환한다. */
export interface CmdResult { ok: boolean; out: string; err?: string; /** 실제 종료 코드 — defaultCmdRunner 만 채운다(스텁은 ok 로만 판정). */ rc?: number }
/** 명령 실행 추상화(주입형·테스트 스텁) — git/gh 를 실제로 돌리지 않고 로직 검증. */
export type CmdRunner = (cmd: string, args: readonly string[], opts?: { cwd?: string }) => CmdResult;

const GH_TOKEN_REFRESH_WINDOW_MS = 10 * 60_000;
let cachedRelayToken: { url: string; bearer: string; original: string | undefined; token: string; expiresAt: number } | undefined;

/** The runner is synchronous; ask the host relay synchronously before starting gh. */
function relayGhToken(env: NodeJS.ProcessEnv): string | null {
  const url = env[POD_GITHUB_CREDENTIAL_URL_ENV];
  const bearer = env[POD_GITHUB_CREDENTIAL_TOKEN_ENV];
  if (!url || !bearer) return null;
  const now = Date.now();
  const original = env.GH_TOKEN;
  if (cachedRelayToken?.url === url && cachedRelayToken.bearer === bearer && cachedRelayToken.original === original
    && now + GH_TOKEN_REFRESH_WINDOW_MS < cachedRelayToken.expiresAt) return cachedRelayToken.token;
  try {
    const response = spawnSync('curl', [
      '--silent', '--show-error', '--fail', '--noproxy', '*', '--max-time', '10',
      '--request', 'POST', '--header', '@-', url,
    ], { input: `Authorization: Bearer ${bearer}\n`, encoding: 'utf8', timeout: 12_000, maxBuffer: 64 * 1024, env });
    if (response.error || response.status !== 0) throw new Error('request-failed');
    const body: unknown = JSON.parse(response.stdout);
    const token = body && typeof body === 'object' ? (body as { token?: unknown }).token : undefined;
    const expiry = body && typeof body === 'object' ? (body as { expires_at?: unknown }).expires_at : undefined;
    const expiresAt = typeof expiry === 'string' ? Date.parse(expiry) : NaN;
    if (typeof token !== 'string' || !token || !Number.isFinite(expiresAt) || expiresAt <= now + GH_TOKEN_REFRESH_WINDOW_MS) throw new Error('invalid-response');
    cachedRelayToken = { url, bearer, original, token, expiresAt };
    return token;
  } catch {
    debug.log('pr-manager', 'gh-token', { reason: 'refresh-failed' }, { level: 'warn' });
    return cachedRelayToken?.url === url && cachedRelayToken.bearer === bearer && cachedRelayToken.original === original
      && now < cachedRelayToken.expiresAt ? cachedRelayToken.token : null;
  }
}

/** Environment for a `gh` call made by automation: the Pod relay token, else the GitHub App token when the
 *  caller set no GH_TOKEN — so PRs, merges and PR comments all act as the App, not the person logged into `gh`. */
export function ghAutomationEnv(env: NodeJS.ProcessEnv = process.env, appToken: () => string | null = githubAutomationToken): NodeJS.ProcessEnv {
  const token = relayGhToken(env) ?? (!Object.hasOwn(env, 'GH_TOKEN') ? appToken() : null);
  return token ? { ...env, GH_TOKEN: token } : env;
}

/** 기본 러너 — spawnSync(dep-free). 실패/예외는 ok=false. stdout·stderr 모두 캡처. */
export const defaultCmdRunner: CmdRunner = (cmd, args, opts) => {
  try {
    // Relay only applies to gh; without it, retain caller GH_TOKEN and the existing App fallback.
    const env = cmd === 'gh' ? ghAutomationEnv(process.env) : process.env;
    // bun ≥1.4 applies Node's 1MB default maxBuffer and silently truncates (`gh pr diff`, file lists) — raise it and
    // never read an overflow as success.
    const r = spawnSync(cmd, [...args], { encoding: 'utf-8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024, env, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const overflow = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
    const result: CmdResult = { ok: r.status === 0 && !overflow, out: (r.stdout ?? '').trim(), err: [(r.stderr ?? '').trim(), overflow ? 'output exceeded 256MiB (ENOBUFS)' : ''].filter(Boolean).join('\n') };
    // Keep the historical enumerable result shape while making the exit code available to PR incidents.
    if (typeof r.status === 'number') Object.defineProperty(result, 'rc', { value: r.status, enumerable: false });
    return result;
  } catch (e) { return { ok: false, out: '', err: e instanceof Error ? e.message : String(e) }; }
};

/** PR URL(.../pull/N) → 번호. 순수함수. 아니면 null. */
export function extractPrNumber(prUrl: string): number | null {
  const m = /\/pull\/(\d+)/.exec(prUrl);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

export interface UpsertPrInput {
  /** 안정 브랜치명(se/…-<phaseHex>) — 재활용 키. */
  branch: string;
  /** Owning self-implement run; used to keep temporary upload refs inside its Pod push fence. */
  runId?: string;
  /** 격리 worktree 경로(git cwd). */
  worktreePath: string;
  title: string;
  body: string;
  commitMessage: string;
  /** add 제외 경로(node_modules·apps/pwa/out 심링크 노이즈). */
  excludePaths?: readonly string[];
  /** PR base 브랜치. */
  base?: string;
  /** 새 PR을 draft로 열지 여부. */
  draft?: boolean;
  /** PR 라벨 — 신규 생성 시 `--label`, 재사용 시 `--add-label` 로 부착(무인 리뷰 진입 라벨이 재실행에도 유지). */
  labels?: readonly string[];
  /** Harness caller's seat; stamped on newly created PRs for later census. */
  seat?: Seat;
  /** 기존 PR 재사용 시 남길 코멘트(재구현 반영 안내·비평 해소). */
  reuseComment?: string;
  /**
   * force-push 일시 원격 실패 사이 대기. 생략하면 짧은 기본 간격.
   * 시험은 이 함수를 바꿔 실제로 기다리지 않는다.
   */
  waitForPushRetry?: (attempt: number) => void;
}

export interface UpsertPrResult { url: string; reused: boolean }

/** ★ upsertPr 구조화 결과(대표 2026-07-21) — bare null 종식. 어느 단계에서 왜 실패했는지 구분한다.
 *  특히 `noop`(nothing to commit)은 **실패가 아니라 이미 반영된 no-op** — 호출부가 정직 PASS 처리.
 *  나머지 reason(add/commit/push/gh)은 진짜 실패로 detail(stderr)과 함께 관측·pr-failed. */
export type UpsertPrOutcome =
  | { ok: true; url: string; reused: boolean; labelsApplied?: boolean; labelsOmitted?: boolean;
      supersededPr?: number; boundCardHeadRefName?: string }
  | { ok: false; reason: 'add' | 'commit' | 'base' | 'noop' | 'push' | 'gh' | 'guard'; detail: string;
      incident?: PrCreateFailureIncident };

/** 관측된 문면 두 가지:
 *    could not add label: 'auto-review' not found
 *    'auto-review' not found
 *  앞의 설명 문구는 있어도 되고 없어도 된다. `\s` 는 개행도 먹어 stderr/out 경계나 여러 행을 한 오류로 결합하므로, 스트림을 각각 행으로 나눠 행 전체만 본다. 접두 없는 `'<name>' not found` 는 그 한 행이 출력의 전부인 경우만 받아, 잘린 `could not add label:` 조각과 이어 붙이지 않는다. 라벨 캡처는 개행만 막고 탐욕적으로 닫는 따옴표까지 물러나 `won't-fix` 처럼 이름 안의 작은따옴표를 살린다. 따옴표 안 이름이 이번 생성에서 요청한 라벨 목록에 있을 때만 라벨 탓으로 본다 — 같은 모양의 다른 이름 오류를 삼키지 않기 위해. */
const LABEL_NOT_FOUND_LINE = /^(could not add label:[ \t]*)?'([^\r\n]+)'[ \t]+not found[ \t]*$/i;

function commandOutputLines(text: string | undefined): string[] {
  return (text ?? '').split(/\r?\n/);
}

function isLabelNotFoundFailure(result: CmdResult, requestedLabels: readonly string[]): boolean {
  if (requestedLabels.length === 0) return false;
  const requested = new Set(requestedLabels);
  const lines = [...commandOutputLines(result.err), ...commandOutputLines(result.out)];
  const nonempty = lines.filter((line) => line.trim().length > 0);
  return lines.some((line) => {
    const match = LABEL_NOT_FOUND_LINE.exec(line);
    if (!match) return false;
    const name = match[2];
    if (name === undefined || !requested.has(name)) return false;
    if (match[1] !== undefined) return true;
    return nonempty.length === 1;
  });
}

export type MergePrOutcome =
  | { ok: true; kind: 'merge-exit-0' | 'merged-after-nonzero'; remoteBranchDeletion?: { detail: string } }
  | { ok: false; kind: 'not-merged'; state: string }
  | { ok: false; kind: 'state-read-failed' }
  | { ok: false; kind: 'unknown' };

/** Non-MERGED must be observed this many times (no wait) before asserting not-merged. */
const MERGE_UNMERGED_CONFIRMATIONS = 2;

type MergeStateReading =
  | { status: 'merged' }
  | { status: 'not-merged'; state: string }
  | { status: 'unreadable' };

function readPrMergeState(run: CmdRunner, prNumber: number, cwd?: string): MergeStateReading {
  const state = run('gh', ['pr', 'view', String(prNumber), '--json', 'state'], cwd ? { cwd } : undefined);
  if (!state.ok) return { status: 'unreadable' };
  try {
    const parsed = JSON.parse(state.out) as { state?: unknown };
    const value = typeof parsed.state === 'string' ? parsed.state : '';
    return value === 'MERGED'
      ? { status: 'merged' }
      : { status: 'not-merged', state: value || 'unknown' };
  } catch {
    return { status: 'unreadable' };
  }
}

/** 열린 PR 조회의 판별 가능한 결과. `SKIPPED`는 기본 브랜치 표식이라 gh를 호출하지 않았음을 뜻한다. */
export type FindPrForBranchOutcome =
  | { status: 'ok OUTPUT'; url: string; rc?: number; stderrTail?: string }
  | { status: 'ok EMPTY'; url: null; rc?: number; stderrTail?: string }
  | { status: 'FAILED'; url: null; rc?: number; stderrTail?: string; stdoutTail?: string }
  | { status: 'SKIPPED'; url: null };

export interface PrManager {
  /** 브랜치의 열린 PR URL(없으면 null). 기존 공개 호환 계약. */
  findPrForBranch(branch: string, cwd?: string): string | null;
  /** 브랜치의 열린 PR 조회 결과. 실패·부재·기본 브랜치 표식 건너뜀을 구분한다. */
  findPrForBranchOutcome(branch: string, cwd?: string): FindPrForBranchOutcome;
  /** 커밋 → force-push → 기존 PR 있으면 재사용(자동 업데이트)·없으면 생성. 구조화 outcome(단계·사유). */
  upsertPr(input: UpsertPrInput): UpsertPrOutcome;
  /** PR close(+브랜치 삭제). 처음부터 재실행 시 orphan 정리용. */
  closePr(prUrl: string, comment?: string): boolean;
  /** PR squash 머지(+브랜치 삭제). 완료 리뷰 후 clean PR 반영. */
  mergePr(prUrl: string): boolean;
  /** 머지 exit 실패 시 GH 상태를 재조회한 구조화 판정. */
  mergePrOutcome(prUrl: string, expectedHead?: string, cwd?: string): MergePrOutcome;
}

/** "이미 커밋된 산출이 있나"를 판정할 비교 base 를 해석한다(순수 아님 — run 주입).
 *
 *  명시 base 가 최우선. 없으면 리포의 기본 브랜치를 추론한다 — `origin/HEAD`(→ `origin/main` 등) →
 *  잘 알려진 후보 순차 검증. 하나도 못 찾으면 undefined —  **호출부는 이를 noop 으로 접지 않고
 *  `reason:'base'` 실패로 올린다**(noop 은 산출을 폐기하는 판정이라 "판정 불가"의 표현이 될 수 없다).
 *
 *  왜 필요한가: base 미상이면 판정을 포기하는 종전 구조는 **`--base` 미지정이 기본값**이라 사실상
 *  상시 퇴화였다(완성된 self-dev 산출을 "nothing to commit" 으로 버림). base 는 신규 PR 을 열 때
 *  어차피 필요한 값이라, 여기서 한 번 해석해 판정과 PR **생성**이 같은 기준을 쓰게 한다.
 *  ⚠️ 기존 PR **재사용** 경로에는 추론값을 쓰지 않는다 — 요청자가 base 를 지정하지 않았는데 열려 있던
 *  PR 의 대상 브랜치를 바꿔버리는 재타기팅 회귀가 되기 때문(리뷰 must-fix 2026-07-26). */
export function resolveDeliverableBase(
  run: CmdRunner,
  cwd: string,
  explicit?: string,
): string | undefined {
  const e = explicit?.trim();
  const opts = { cwd };
  if (e) {
    if (e.startsWith('origin/') || run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', e], opts).ok) return e;
    const resolved = `origin/${e}`;
    if (run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', resolved], opts).ok) {
      debug.log('autopilot.pr-manager', 'base-resolved-remote', { explicit: e, resolved });
      return resolved;
    }
    return e;
  }
  const head = run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], opts);
  const headRef = head.ok ? head.out.trim() : '';
  // `origin/HEAD` 미설정 리포는 "origin/HEAD" 를 그대로 되돌려주기도 한다 → 해소 실패로 취급.
  if (headRef && headRef !== 'origin/HEAD') return headRef;
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    if (run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', cand], opts).ok) return cand;
  }
  // ⭐ 최후 폴백(리뷰 should-fix) — 기본 브랜치가 main/master 가 아니고 `origin/HEAD` 도 없는 리포는
  //   여기까지 온다. 원격에 직접 물어 권위적 답을 얻는다(`ls-remote --symref` → "ref: refs/heads/<b>\tHEAD").
  //   ⚠️ 유일한 네트워크 호출이라 **로컬 후보가 전부 실패한 드문 경로에서만** 실행된다.
  const ls = run('git', ['-C', cwd, 'ls-remote', '--symref', 'origin', 'HEAD'], opts);
  const sym = ls.ok ? /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(ls.out) : null;
  if (sym?.[1]) {
    const remoteDefault = `origin/${sym[1]}`;
    // 로컬에 그 remote-tracking ref 가 실제로 있으면 비교에 쓸 수 있다. 없으면(미fetch) 비교 불가.
    if (run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', remoteDefault], opts).ok) return remoteDefault;
  }
  return undefined;
}

/** 비교 base(remote-tracking 일 수 있음) → `gh` 에 넘길 PR base 브랜치명.
 *  `gh pr create --base origin/main` 은 유효하지 않다(gh 는 브랜치명을 받는다) → 접두 제거. */
export function prBaseFromComparison(comparisonBase: string): string {
  return comparisonBase.replace(/^origin\//, '');
}

/**
 * Local git-log range for landings already on the resolved base.
 * Feature-branch HEAD-only commits are excluded because the range is the base
 * ref itself, not `HEAD`. Network/`gh` are never used.
 */
export function landingHistoryGitLogArgs(since: string | null, baseRef: string): string[] {
  return [
    'log',
    ...(since === null ? [] : [`--since=${since}`]),
    '--pretty=format:commit %H',
    '--name-only',
    '--no-merges',
    '--no-renames',
    baseRef,
  ];
}

export function collectLandedCommitsOnBase(
  run: CmdRunner,
  cwd: string,
  opts: { since: string; baseRef: string },
): { ok: true; out: string } | { ok: false; err?: string } {
  const result = run('git', landingHistoryGitLogArgs(opts.since, opts.baseRef), { cwd });
  if (!result.ok) return { ok: false, err: result.err };
  return { ok: true, out: result.out };
}

function branchName(ref: string): string {
  return ref.trim().replace(/^refs\/remotes\/origin\//, '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

function isBranchSelfRef(ref: string, branch: string): boolean {
  return branchName(ref) === branchName(branch);
}

/** force-push 한 번의 일시 원격 실패 뒤 기본 대기(ms). 재시도 2회라 최악도 짧다. */
const DEFAULT_PUSH_RETRY_WAIT_MS = 250;
/** 첫 push + 재시도 2. 상한 3 — 더 늘리지 않는다. */
const MAX_PUSH_ATTEMPTS = 3;

function defaultWaitForPushRetry(_attempt: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DEFAULT_PUSH_RETRY_WAIT_MS);
}

/**
 * push 실패 출력(detailOf 와 같은 마지막 출력)을 isTransientExecutionFailure 에 넘기기 전,
 * 그 함수가 이미 아는 일시 어휘로 정규화한다. 함수 자체는 고치지 않는다.
 * 영구 거부(non-fast-forward · protected branch · 저장소 없음)는 여기 걸리지 않아 원문 그대로 간다.
 */
function pushFailureMessageForTransientCheck(detail: string): string {
  const text = detail.toLowerCase();
  const remoteFiveXx = /internal server error|\b502\b|\b503\b|\b504\b/.test(text)
    && (/internal server error/.test(text) || /remote rejected|\b5\d\d\b/.test(text));
  if (remoteFiveXx) return 'socket hang up';
  if (text.includes('could not read from remote repository')) return 'fetch failed';
  if (text.includes('permission denied (publickey)')) return 'unable to connect';
  if (/connection reset|connection closed|the remote end hung up|broken pipe|connection timed out/.test(text)) {
    return 'ECONNRESET';
  }
  return detail;
}

/** push 실패 출력이 다시 걸면 풀리는 원격 실패인가. 판정은 isTransientExecutionFailure 한 곳. */
function isTransientPushFailure(detail: string): boolean {
  return isTransientExecutionFailure(pushFailureMessageForTransientCheck(detail));
}

// ── 칸 PR-CREATE-FAIL-OBSERVE-FU — PR 생성 실패 incident(관측 단위) ──────────────
//   run-7308cfbf·run-fabc2564·run-32bca71e·run-42876ab6 의 draft PR 생성 실패가
//   outcome 원장만으로는 push·gh create·인증·원격 충돌 중 어느 단계인지 못 가렸다.
//   하나의 incident 가 push 와 gh 단계를 각각 식별해 rc·stderr 꼬리·branch/remote·push 성패를 남긴다.
/** PR 생성 경로에서 실패 관측 대상인 단계. */
export type PrCreateStageId = 'push' | 'gh';
/** 단계별 관측: 실행 여부 · 종료 코드 · (자격증명 제거된) stderr 꼬리 · push 성공 여부. */
export interface PrCreateStageObservation {
  stage: PrCreateStageId;
  ran: boolean;
  rc?: number;
  stderrTail?: string;
  stdoutTail?: string;
  /** push 단계 전용 — force-push 최종 성공 여부. */
  ok?: boolean;
  /** gh 단계 전용 — 재시도 전후의 목록 조회와 생성 명령을 각각 보존한다. */
  lookup?: PrCreateStageObservation;
  create?: PrCreateStageObservation;
}
/** PR 생성 실패 한 건 — push/gh 두 단계 관측을 하나의 기록에. */
export interface PrCreateFailureIncident {
  runId?: string;
  branch: string;
  remote: string;
  push: PrCreateStageObservation;
  gh: PrCreateStageObservation;
}
/** stderr 꼬리로 남기는 최대 글자 수. */
export const PR_CREATE_STDERR_TAIL_CHARS = 400;

/** 토큰·URL 자격증명을 기록 전에 지운다(원문 꼬리는 살리고 비밀만 뭉개기). */
const CREDENTIAL_REDACTION_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // GitHub token prefixes(ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ …) — secret 부분만 치환.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, replacement: '[REDACTED]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: '[REDACTED]' },
  // URL userInfo(https://user:pass@host · ssh://user:pass@host) — 스킴은 살리고 자격증명만.
  { pattern: /((?:https?|ssh|git\+ssh):\/\/)[^\s/@]+:[^\s/@]+@/g, replacement: '$1[REDACTED]@' },
];

/** stderr 텍스트에서 토큰·URL 자격증명을 제거한다. */
export function sanitizeCredentialText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of CREDENTIAL_REDACTION_PATTERNS) out = out.replace(pattern, replacement);
  return redactSecretText(out);
}

/** stderr 를 자격증명 제거 뒤 꼬리(기본 400자)만 남긴다. 비면 undefined. */
export function stderrTailOf(err: string | undefined, chars: number = PR_CREATE_STDERR_TAIL_CHARS): string | undefined {
  const sanitized = sanitizeCredentialText(err ?? '').trim();
  return sanitized ? sanitized.slice(-chars) : undefined;
}

/** PR 생성 실패 incident 를 원장(debug.log)에 남긴다. 성공 경로는 기록하지 않는다. */
export function recordPrCreateFailureIncident(incident: PrCreateFailureIncident): PrCreateFailureIncident {
  const safe: PrCreateFailureIncident = {
    ...(incident.runId ? { runId: sanitizeCredentialText(incident.runId) } : {}),
    branch: sanitizeCredentialText(incident.branch),
    remote: sanitizeCredentialText(incident.remote),
    push: {
      ...incident.push,
      ...(incident.push.stderrTail ? { stderrTail: stderrTailOf(incident.push.stderrTail) } : {}),
      ...(incident.push.stdoutTail ? { stdoutTail: stderrTailOf(incident.push.stdoutTail) } : {}),
    },
    gh: {
      ...incident.gh,
      ...(incident.gh.stderrTail ? { stderrTail: stderrTailOf(incident.gh.stderrTail) } : {}),
      ...(incident.gh.stdoutTail ? { stdoutTail: stderrTailOf(incident.gh.stdoutTail) } : {}),
      ...(incident.gh.lookup ? { lookup: {
        ...incident.gh.lookup,
        ...(incident.gh.lookup.stderrTail ? { stderrTail: stderrTailOf(incident.gh.lookup.stderrTail) } : {}),
        ...(incident.gh.lookup.stdoutTail ? { stdoutTail: stderrTailOf(incident.gh.lookup.stdoutTail) } : {}),
      } } : {}),
      ...(incident.gh.create ? { create: {
        ...incident.gh.create,
        ...(incident.gh.create.stderrTail ? { stderrTail: stderrTailOf(incident.gh.create.stderrTail) } : {}),
        ...(incident.gh.create.stdoutTail ? { stdoutTail: stderrTailOf(incident.gh.create.stdoutTail) } : {}),
      } } : {}),
    },
  };
  debug.log('autopilot.pr-manager', 'pr-create-failure-incident', safe);
  return safe;
}

function prCreateFailureOutcome(input: UpsertPrInput, reason: 'push' | 'gh' | 'guard', detail: string,
  push: PrCreateStageObservation, gh: PrCreateStageObservation, targetBranch = input.branch): UpsertPrOutcome {
  const incident = recordPrCreateFailureIncident({
    ...(input.runId ? { runId: input.runId } : {}), branch: targetBranch, remote: 'origin', push, gh,
  });
  const safeDetail = sanitizeCredentialText(detail).slice(0, 300);
  // The production caller carries detail into its child failure record.
  return input.runId
    ? { ok: false, reason, detail: `${safeDetail}\npr-create-incident=${JSON.stringify(incident)}`, incident }
    : { ok: false, reason, detail: safeDetail };
}

function seatFromEnvironment(): Seat | null {
  // Production launchers stamp this in harness-pod-dispatch.ts and harness-cli-command.ts.
  const value = process.env.ELANOUS_HARNESS_SEAT;
  return value === 'OP' || value === 'TC' || value === 'MK' || value === 'UX' ? value : null;
}

function sameCellGuardDetail(verdict: GuardVerdict, candidateCardId: string | null): string {
  const reasons = verdict.reasons.map(reason => `${reason.code}: ${reason.detail}${reason.prs?.length ? ` (${reason.prs.map(number => `#${number}`).join(', ')})` : ''}`).join('; ');
  return verdict.sameCellConflicts?.length
    ? `${reasons}; candidateCardId=${candidateCardId ?? 'unknown'}; blockers=${verdict.sameCellConflicts.map(({ pr, cardId }) => `#${pr}:${cardId ?? 'unknown'}`).join(',')}`
    : reasons;
}

/** PR-GUARD-HUNK-WARN: config `prTool.hunkOverlap` — 'refuse' 만 옛 거부, 없거나 그 밖은 'warn'. */
export function configuredHunkOverlapMode(raw: Record<string, unknown> | undefined = getUserConfig().raw): HunkOverlapMode {
  const prTool = raw?.prTool as { hunkOverlap?: unknown } | undefined;
  return prTool?.hunkOverlap === 'refuse' ? 'refuse' : 'warn';
}

/** PR-CENSUS-PARALLEL: the guard's `gh pr diff` fan-out, with the same gh credentials as {@link defaultCmdRunner}. */
export const defaultCensusParallelRunner: PrToolParallelCommand = (calls, concurrency) =>
  spawnParallelCommands(calls, { concurrency, env: ghAutomationEnv(process.env) });

function defaultPrCreateGuard(input: { cwd: string; base: string | undefined; seat: Seat | null; body: string }, run: CmdRunner): GuardVerdict {
  if (!input.base) return guardNewPr({ files: null, seat: input.seat }, { status: 'unknown', reason: '비교 base 없음' });
  const diff = run('git', ['-C', input.cwd, 'diff', '--name-only', '-z', `${input.base}...HEAD`]);
  const files = diff.ok ? diff.out.split('\0').filter(Boolean) : null;
  const patch = run('git', ['-C', input.cwd, 'diff', '--unified=0', `${input.base}...HEAD`]);
  if (!patch.ok) return guardNewPr({ files: null, seat: input.seat }, { status: 'unknown', reason: `후보 수정 줄 조회 실패: ${patch.err || patch.out}` });
  const boundRaw = process.env.ELANOUS_TASK_BOUND_PR;
  const boundPrNumber = boundRaw && /^[1-9]\d*$/.test(boundRaw) ? Number(boundRaw) : undefined;
  return guardNewPr({ files, seat: input.seat, cellId: cellIdFromBody(input.body), cardId: cardIdFromBody(input.body),
    slice: sliceMarkerFromBody(input.body),
    ...(boundPrNumber && Number.isSafeInteger(boundPrNumber) ? { boundPrNumber } : {}),
    hunks: parseDiffHunks(patch.out), hunkOverlap: configuredHunkOverlapMode() }, readOpenPrs(run, { cwd: input.cwd, ...(files ? { candidateFiles: files } : {}),
      runParallel: defaultCensusParallelRunner, diffCache: sharedCensusDiffCache }));
}

function editExistingPr(run: CmdRunner, input: UpsertPrInput, url: string): UpsertPrOutcome {
  const opts = { cwd: input.worktreePath };
  const detailOf = (r: CmdResult) => (r.err || r.out || '').slice(0, 300);
  const editArgs = ['pr', 'edit', url, '--title', input.title, '--body', input.body];
  const explicitBase = input.base?.trim();
  if (explicitBase && !isBranchSelfRef(explicitBase, input.branch)) editArgs.push('--base', prBaseFromComparison(explicitBase));
  for (const label of new Set((input.labels ?? []).map(label => label.trim()).filter(Boolean))) editArgs.push('--add-label', label);
  const edited = run('gh', editArgs, opts);
  if (!edited.ok) return { ok: false, reason: 'gh', detail: detailOf(edited) || 'gh pr edit 실패' };
  if (input.draft !== undefined) {
    const stateR = run('gh', ['pr', 'view', url, '--json', 'isDraft', '-q', '.isDraft'], opts);
    const raw = stateR.out.trim();
    if (!stateR.ok || (raw !== 'true' && raw !== 'false'))
      return { ok: false, reason: 'gh', detail: detailOf(stateR) || `draft 상태 조회 실패(isDraft=${raw || 'empty'})` };
    if (input.draft === false && raw === 'true') {
      const ready = run('gh', ['pr', 'ready', url], opts);
      if (!ready.ok) return { ok: false, reason: 'gh', detail: detailOf(ready) || 'gh pr ready 실패' };
    } else if (input.draft === true && raw === 'false') {
      const undo = run('gh', ['pr', 'ready', url, '--undo'], opts);
      if (!undo.ok) return { ok: false, reason: 'gh', detail: detailOf(undo) || 'gh pr ready --undo 실패' };
    }
  }
  if (input.reuseComment) run('gh', ['pr', 'comment', url, '--body', input.reuseComment], opts);
  return { ok: true, url, reused: true };
}

/** Same-card rework may have a new run branch. Merge the bound PR head into that work,
 * then update the bound branch with a plain fast-forward push. Every identity read is
 * checked again after the inventory snapshot; an ambiguous or moved PR stays refused. */
function reuseSameCellPr(run: CmdRunner, input: UpsertPrInput, target: NonNullable<GuardVerdict['sameCellReuse']>,
  initialInventory: GuardVerdict, recheck: () => GuardVerdict): UpsertPrOutcome {
  const cwd = input.worktreePath;
  const pushEvidence = { ref: `refs/heads/${target.branch}`, remoteHead: target.headSha, cardId: target.cardId };
  const fail = (detail: string, inventoryEvidence?: { inventoryBefore: unknown; inventoryAfter: unknown; inventoryDiff: unknown }): UpsertPrOutcome => {
    const safeDetail = sanitizeCredentialText(detail).slice(0, 300);
    debug.log('autopilot.pr-manager', 'same-cell-push-decision', {
      ...pushEvidence, outcome: 'refused', reason: safeDetail, ...inventoryEvidence,
    }, { level: 'warn' });
    return { ok: false, reason: 'guard', detail: `same-cell reuse: ${safeDetail}` };
  };
  if (!/^[0-9a-f]{40}$/i.test(target.headSha) || !Number.isSafeInteger(target.number) || target.number < 1
    || cellIdFromBody(input.body) !== target.cellId || cardIdFromBody(input.body) !== target.cardId)
    return fail('candidate identity mismatch');
  const validBranch = run('git', ['-C', cwd, 'check-ref-format', '--branch', target.branch]);
  if (!validBranch.ok) return fail('PR branch name invalid');
  const viewFields = 'state,headRefOid,headRefName,body,isCrossRepository,url,isDraft,labels';
  const view = run('gh', ['pr', 'view', String(target.number), '--json', viewFields], { cwd });
  if (!view.ok) return fail('PR identity read failed');
  let pr: Record<string, unknown>;
  try { pr = JSON.parse(view.out) as Record<string, unknown>; } catch { return fail('PR identity malformed'); }
  if (pr.state !== 'OPEN' || pr.isCrossRepository !== false || pr.headRefOid !== target.headSha
    || pr.headRefName !== target.branch || typeof pr.body !== 'string'
    || cellIdFromBody(pr.body) !== target.cellId
    || (sliceMarkerFromBody(input.body)?.slice ?? null) !== (sliceMarkerFromBody(pr.body)?.slice ?? null)
    || (sliceMarkerFromBody(input.body)?.total ?? null) !== (sliceMarkerFromBody(pr.body)?.total ?? null)
    || (target.legacyBound ? hasCardMarker(pr.body) || process.env.ELANOUS_TASK_BOUND_PR !== String(target.number)
      : cardIdFromBody(pr.body) !== target.cardId)
    || typeof pr.url !== 'string' || extractPrNumber(pr.url) !== target.number)
    return fail('PR state, head, repository, or card lineage changed');
  const remoteRef = `refs/heads/${target.branch}`;
  const remote = run('git', ['-C', cwd, 'ls-remote', '--exit-code', 'origin', remoteRef]);
  if (!remote.ok || remote.out.trim() !== `${target.headSha}\t${remoteRef}`) return fail('remote head changed');
  const localRef = `refs/elanous/pr-reuse/${target.number}-${target.headSha.slice(0, 12)}`;
  const fetched = run('git', ['-C', cwd, 'fetch', 'origin', `${remoteRef}:${localRef}`]);
  const fetchedHead = fetched.ok ? run('git', ['-C', cwd, 'rev-parse', localRef]) : undefined;
  if (!fetched.ok || !fetchedHead?.ok || fetchedHead.out.trim() !== target.headSha) return fail('PR head fetch mismatch');
  const merged = run('git', ['-C', cwd, 'merge', '--no-edit', target.headSha]);
  if (!merged.ok) {
    const aborted = run('git', ['-C', cwd, 'merge', '--abort']);
    if (!aborted.ok) return fail(`PR head merge abort failed: ${(aborted.err || aborted.out).slice(0, 220)}`);
    // A conflicting same-card draft cannot be fast-forwarded. Preserve this run's
    // head on its own branch, and let the returned new PR URL bind the card.
    if (pr.isDraft !== true) return fail('conflicting PR is not a draft');
    const clean = run('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no']);
    if (!clean.ok || clean.out.trim()) return fail('worktree changed after merge abort');
    const before = run('gh', ['pr', 'view', String(target.number), '--json', viewFields], { cwd });
    let old: Record<string, unknown>;
    try { old = JSON.parse(before.out) as Record<string, unknown>; } catch { return fail('PR pre-create identity malformed'); }
    const remoteNow = run('git', ['-C', cwd, 'ls-remote', '--exit-code', 'origin', remoteRef]);
    const latest = recheck().sameCellReuse;
    if (!before.ok || old.state !== 'OPEN' || old.isDraft !== true || old.headRefOid !== target.headSha
      || old.headRefName !== target.branch || old.body !== pr.body || old.url !== pr.url
      || !remoteNow.ok || remoteNow.out.trim() !== `${target.headSha}\t${remoteRef}`
      || !latest || latest.number !== target.number || latest.branch !== target.branch
      || latest.headSha !== target.headSha || latest.cellId !== target.cellId
      || latest.cardId !== target.cardId || Boolean(latest.legacyBound) !== Boolean(target.legacyBound))
      return fail('PR changed before superseding draft');
    const newRef = `refs/heads/${input.branch}`;
    if (!run('git', ['-C', cwd, 'check-ref-format', '--branch', input.branch]).ok) return fail('new run branch name invalid');
    const newRemote = run('git', ['-C', cwd, 'ls-remote', '--heads', 'origin', newRef]);
    if (!newRemote.ok || newRemote.out.trim()) return fail('new run branch already exists or remote unreadable');
    const localHead = run('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    if (!localHead.ok || !/^[0-9a-f]{40}$/i.test(localHead.out.trim())) return fail('new run head unreadable');
    // Upload the commit through a unique scratch ref. GitHub's create-ref API then
    // atomically refuses a concurrent writer of the intended branch name.
    const runKey = input.runId ? runSuffixKey(input.runId) : null;
    if (!runKey) return fail(input.runId ? 'new run id invalid for scratch ref' : 'run id required for scratch ref');
    const scratch = `self-impl/pr-create-r${runKey}-${randomUUID()}`;
    const scratchRef = `refs/heads/${scratch}`;
    // ⛔ push 보고는 원격의 진실이 아니다 — ref 를 만든 뒤에도 exit≠0 으로 끝날 수 있고, 삭제가
    //    실패로 보고돼도 이미 지워졌을 수 있다. 그래서 새 draft 결과가 확정되는 즉시 **이 시도가
    //    만든 scratch ref 하나만** 상대로 「남았나 보고 → 지운다」. 지우지 못하면 그 이유를 원장에
    //    남긴다(다른 ref·가지·PR 은 건드리지 않는다).
    const reapScratchRef = (outcome: 'branch-created' | 'create-refused' | 'upload-failed'): void => {
      // 업로드가 실패로 보고돼도 원격에 ref 가 남아 있을 수 있다 — 먼저 읽고 건너뛰면 «읽은 뒤
      // 늦게 착지한» ref 가 남는 창이 생긴다. 그래서 결과와 무관하게 늘 삭제를 시도하고,
      // 원격이 «그런 ref 없음» 이라 답하면 이미 없는 것이므로 정리 실패로 세지 않는다.
      let removed = run('git', ['-C', cwd, 'push', 'origin', `:${scratchRef}`]);
      if (!removed.ok && isTransientPushFailure(removed.err || removed.out))
        removed = run('git', ['-C', cwd, 'push', 'origin', `:${scratchRef}`]);
      if (removed.ok) return;
      if (/remote ref does not exist/i.test(`${removed.err ?? ''}\n${removed.out ?? ''}`)) {
        debug.log('autopilot.pr-manager', 'same-cell-scratch-absent', { scratchRef, outcome });
        return;
      }
      debug.log('autopilot.pr-manager', 'same-cell-scratch-cleanup-failed',
        { scratchRef, outcome, detail: removed.err || removed.out,
          stderr: removed.err ?? '', stdout: removed.out, truncated: false }, { level: 'warn' });
    };
    const uploaded = run('git', ['-C', cwd, 'push', 'origin', `HEAD:${scratchRef}`]);
    if (!uploaded.ok) {
      reapScratchRef('upload-failed');
      return fail(`new run object upload failed: ${(uploaded.err || uploaded.out).slice(0, 220)}`);
    }
    const repository = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd });
    const repoName = repository.out.trim();
    const createdRef = repository.ok && /^[^/\s]+\/[^/\s]+$/.test(repoName)
      ? run('gh', ['api', '--method', 'POST', `repos/${repoName}/git/refs`, '-f', `ref=${newRef}`, '-f', `sha=${localHead.out.trim()}`], { cwd })
      : { ok: false, out: '', err: 'repository identity unavailable' };
    reapScratchRef(createdRef.ok ? 'branch-created' : 'create-refused');
    if (!createdRef.ok) return fail(`new run branch create refused: ${(createdRef.err || createdRef.out).slice(0, 220)}`);
    const stateLabels = new Set(labelsForAxis('state').map(label => label.name));
    const labels = [...new Set([...(input.labels ?? []).filter(label => !stateLabels.has(label as typeof PR_LABEL_NAMES.running)),
      PR_LABEL_NAMES.running, ...(input.seat ? [`seat:${input.seat}`] : [])])];
    const body = `${input.body.trimEnd()}\n\nSupersedes: #${target.number}`;
    const create = ['pr', 'create', '--draft', '--head', input.branch, '--title', input.title, '--body', body];
    const base = input.base?.trim();
    if (base && !isBranchSelfRef(base, input.branch)) create.push('--base', prBaseFromComparison(base));
    for (const label of labels) create.push('--label', label);
    const created = run('gh', create, { cwd });
    const newUrl = created.out.trim();
    const newNumber = extractPrNumber(newUrl);
    if (!created.ok || !newNumber) return { ok: false, reason: 'gh', detail: `superseding draft create failed: ${(created.err || created.out).slice(0, 220)}` };
    debug.log('autopilot.pr-manager', 'same-cell-conflict-new-draft',
      { oldPr: target.number, newPr: newNumber, cardId: target.cardId, oldDraftCleanup: 'deferred' });
    return { ok: true, url: newUrl, reused: false, supersededPr: target.number };
  }
  if (!run('git', ['-C', cwd, 'merge-base', '--is-ancestor', target.headSha, 'HEAD']).ok) return fail('PR head is not ancestor of result');
  const finalView = run('gh', ['pr', 'view', String(target.number), '--json', viewFields], { cwd });
  let finalPr: Record<string, unknown>;
  try { finalPr = JSON.parse(finalView.out) as Record<string, unknown>; } catch { return fail('PR pre-push identity read failed'); }
  if (!finalView.ok || finalPr.state !== 'OPEN' || finalPr.isCrossRepository !== false
    || finalPr.headRefOid !== target.headSha || finalPr.headRefName !== target.branch
    || typeof finalPr.body !== 'string' || cellIdFromBody(finalPr.body) !== target.cellId
    || (sliceMarkerFromBody(input.body)?.slice ?? null) !== (sliceMarkerFromBody(finalPr.body)?.slice ?? null)
    || (sliceMarkerFromBody(input.body)?.total ?? null) !== (sliceMarkerFromBody(finalPr.body)?.total ?? null)
    || (target.legacyBound ? hasCardMarker(finalPr.body) || process.env.ELANOUS_TASK_BOUND_PR !== String(target.number)
      : cardIdFromBody(finalPr.body) !== target.cardId)
    || finalPr.url !== pr.url) return fail('PR changed before push');
  const finalRemote = run('git', ['-C', cwd, 'ls-remote', '--exit-code', 'origin', remoteRef]);
  if (!finalRemote.ok || finalRemote.out.trim() !== `${target.headSha}\t${remoteRef}`) return fail('remote head changed before push');
  const latestInventory = recheck();
  const latest = latestInventory.sameCellReuse;
  if (!latest || latest.number !== target.number || latest.branch !== target.branch
    || latest.headSha !== target.headSha || latest.cellId !== target.cellId
    || latest.cardId !== target.cardId || Boolean(latest.legacyBound) !== Boolean(target.legacyBound)) {
    const snapshot = (verdict: GuardVerdict) => ({
      conflicts: [...(verdict.sameCellConflicts ?? [])].map((row) => ({ pr: row.pr,
        branch: row.branch === null ? null : sanitizeCredentialText(row.branch).slice(0, 180),
        headSha: /^[0-9a-f]{40}$/i.test(row.headSha) ? row.headSha.toLowerCase() : 'invalid',
        cardId: row.cardId === null ? null : sanitizeCredentialText(row.cardId).slice(0, 128), slice: row.slice ?? null,
      })).sort((a, b) => a.pr - b.pr),
      reusable: verdict.sameCellReuse ? { number: verdict.sameCellReuse.number,
        branch: sanitizeCredentialText(verdict.sameCellReuse.branch).slice(0, 180),
        headSha: /^[0-9a-f]{40}$/i.test(verdict.sameCellReuse.headSha) ? verdict.sameCellReuse.headSha.toLowerCase() : 'invalid',
        cellId: sanitizeCredentialText(verdict.sameCellReuse.cellId).slice(0, 128),
        cardId: sanitizeCredentialText(verdict.sameCellReuse.cardId).slice(0, 128),
        legacyBound: Boolean(verdict.sameCellReuse.legacyBound) } : null,
    });
    const before = snapshot(initialInventory);
    const after = snapshot(latestInventory);
    const beforeByPr = new Map(before.conflicts.map((row) => [row.pr, row]));
    const afterByPr = new Map(after.conflicts.map((row) => [row.pr, row]));
    const inventoryDiff = {
      added: after.conflicts.filter((row) => !beforeByPr.has(row.pr)),
      removed: before.conflicts.filter((row) => !afterByPr.has(row.pr)),
      changed: after.conflicts.flatMap((row) => {
        const old = beforeByPr.get(row.pr);
        return old && JSON.stringify(old) !== JSON.stringify(row) ? [{ pr: row.pr, before: old, after: row }] : [];
      }),
      reusableChanged: JSON.stringify(before.reusable) !== JSON.stringify(after.reusable),
    };
    return fail('OPEN PR inventory changed before push', { inventoryBefore: before, inventoryAfter: after, inventoryDiff });
  }
  // The result descends from the exact fetched head. The explicit lease binds the
  // remote update to that head, so a delete or move between reads cannot be revived.
  // The Pod hook receives these values for this one push only. It checks the Pod card,
  // exact remote head and ancestry independently before allowing another run's ref.
  const podReuseConfig = input.runId && process.env.ELANOUS_TASK_CARD_ID ? [
    '-c', `elanous.sameCellReuseRef=${remoteRef}`,
    '-c', `elanous.sameCellReuseHead=${target.headSha}`,
    '-c', `elanous.sameCellReuseCard=${target.cardId}`,
  ] : [];
  const pushed = run('git', ['-C', cwd,
    ...podReuseConfig,
    'push', `--force-with-lease=${remoteRef}:${target.headSha}`, 'origin', `HEAD:${remoteRef}`]);
  if (!pushed.ok) return fail(`fast-forward push refused: ${(pushed.err || pushed.out).slice(0, 220)}`);
  debug.log('autopilot.pr-manager', 'same-cell-push-decision', { ...pushEvidence, outcome: 'allowed', reason: 'bound-card-pr-head-fast-forward' });
  debug.log('autopilot.pr-manager', 'same-cell-reused', { pr: target.number, cellId: target.cellId, cardId: target.cardId, branch: target.branch });
  const edited = editExistingPr(run, input, pr.url);
  return edited.ok ? { ...edited, boundCardHeadRefName: target.branch } : edited;
}

/** ★ PR 매니저 팩토리(대표 2026-07-12) — CmdRunner 주입(테스트 스텁). 실 배선은 기본 러너. */
export function makePrManager(
  runner: CmdRunner = defaultCmdRunner,
  createGuard?: (input: { cwd: string; base: string | undefined; seat: Seat | null; body: string }, run: CmdRunner) => GuardVerdict,
  recordUnmeasured: typeof recordGuardUnmeasured = recordGuardUnmeasured,
): PrManager {
  const run = withGhRestFallback(runner);
  const checkCreate = createGuard ?? (runner === defaultCmdRunner ? defaultPrCreateGuard : undefined);
  const findPrForBranchOutcome = (branch: string, cwd?: string): FindPrForBranchOutcome => {
    // ⛔ 표식은 base 를 「생략했다」는 뜻이지 브랜치 이름이 아니다. 그대로 `gh --head` 로 넘기면
    //    gh 가 `no pull requests found for branch "elanous:default-branch"` 를 stderr 로 뱉는다.
    //    ⚠️ 그 줄은 **실패처럼 읽히는데 실패가 아니고**, 실제 PR 개설 실패 바로 윗줄에 앉는다
    //    ⇒ 2026-08-02 에 사람이 진짜 실패(`#6604`)를 그 옆에서 잡음으로 읽었다.
    if (branch === DEFAULT_BRANCH_WORKTREE_BASE) {
      const outcome: FindPrForBranchOutcome = { status: 'SKIPPED', url: null };
      debug.log('autopilot.pr-manager', 'lookup.skipped', {
        branch,
        reason: 'default-branch-sentinel-is-not-a-head',
        status: outcome.status,
      });
      return outcome;
    }
    const r = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'], cwd ? { cwd } : undefined);
    const url = r.out.trim() || null;
    const lookupEvidence = {
      ...(typeof r.rc === 'number' ? { rc: r.rc } : {}),
      ...(stderrTailOf(r.err) ? { stderrTail: stderrTailOf(r.err) } : {}),
    };
    const lookupFailureEvidence = {
      ...lookupEvidence,
      ...(stderrTailOf(r.out) ? { stdoutTail: stderrTailOf(r.out) } : {}),
    };
    const outcome: FindPrForBranchOutcome = !r.ok
      ? { status: 'FAILED', url: null, ...lookupFailureEvidence }
      : url
        ? { status: 'ok OUTPUT', url }
        : { status: 'ok EMPTY', url: null };
    if (r.ok) {
      for (const [key, value] of Object.entries(lookupEvidence))
        if (value !== undefined) Object.defineProperty(outcome, key, { value, enumerable: false });
    }
    debug.log('autopilot.pr-manager', 'lookup', {
      branch,
      // ⚠️ 조회는 --jq '.[0].url' 이라 최대 한 줄이다 — "매칭된 PR 수"가 아니라 "돌아온 URL 줄 수"다.
      returnedUrlCount: url ? 1 : 0,
      status: outcome.status,
    });
    return outcome;
  };
  const findPrForBranch = (branch: string, cwd?: string): string | null => findPrForBranchOutcome(branch, cwd).url;
  return {
    findPrForBranch,
    findPrForBranchOutcome,
    upsertPr(candidateInput) {
      // ★ sibling-slice(쪼개기 정착) — composeSliceHandText(tier-split.ts)가 hand 문면에 표지를 쓰고
      //   prBody(orchestrator.ts)가 그 문면을 PR 본문에 보존한다. 조각 번호만 제목에 덧붙인다.
      const candidateSlice = sliceMarkerFromBody(candidateInput.body);
      const input: UpsertPrInput = candidateSlice
        ? { ...candidateInput,
            title: `${candidateInput.title} · 조각 ${candidateSlice.slice}/${candidateSlice.total}`,
            body: candidateInput.body }
        : candidateInput;
      const taskCardId = process.env.ELANOUS_TASK_CARD_ID;
      if (taskCardId && (!hasCardMarker(input.body) || cardIdFromBody(input.body) !== taskCardId))
        return { ok: false, reason: 'guard', detail: `task card PR body missing or conflicting card marker: expected=${taskCardId}` };
      const cwd = input.worktreePath;
      const opts = { cwd };
      const runGitWrite = (args: string[]): CmdResult => {
        let lastRc: number | undefined;
        const result = runGitWithRetry(
          args,
          (gitArgs) => {
            const command = run('git', gitArgs, opts);
            lastRc = command.rc;
            return { status: command.ok ? 0 : (command.rc && command.rc !== 0 ? command.rc : 1), stdout: command.out, stderr: command.err ?? '' };
          },
          (attempt) => debug.log('autopilot.pr-manager', 'git-write.retry-succeeded', { attempt, args }),
        );
        return { ok: result.status === 0, out: result.stdout, err: result.stderr, rc: lastRc ?? (typeof result.status === 'number' ? result.status : undefined) };
      };
      const detailOf = (r: CmdResult) => sanitizeCredentialText(r.err || r.out || '').slice(0, 300);
      // ★ gitignored 경로는 exclude pathspec 에서 뺀다(대표 2026-07-21·705308 근본). git add -A 는 gitignored
      //   (node_modules·apps/pwa/out 심링크)를 이미 자동 skip 하는데, `:(exclude)<ignored>` 로 명시 지목하면
      //   git 이 "paths ignored by .gitignore … use -f" 로 exit 1 을 뱉는다(staging 은 성공하지만 exit≠0).
      //   그간 이게 add 실패로 오판돼 makePr null→pr-failed→budget 오힐 교착. gitignore 안 된 것만 exclude.
      // ★ 최초 base 해석을 일반 경로의 판정과 PR 생성에 그대로 공유한다. 명시 base가 원격 추적으로만
      //   존재하면 여기서 해석한 ref로 rev-list·diff를 비교하고 PR 생성에는 브랜치명만 전달한다.
      //   self-base 인수 발사만 `branch..HEAD`의 구조적 0을 피하려 upstream 비교 ref와 기본 PR base를 추가 해석한다.
      const resolvedBase = resolveDeliverableBase(run, cwd, input.base);
      const selfBase = Boolean(resolvedBase && isBranchSelfRef(resolvedBase, input.branch));
      let comparisonBase = resolvedBase;
      let prBaseRef = resolvedBase;
      if (selfBase) {
        const upstream = run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', `${input.branch}@{upstream}`], opts);
        const trackingRef = upstream.ok ? upstream.out.trim() : '';
        comparisonBase = /^(?:origin\/|refs\/remotes\/origin\/)/.test(trackingRef) ? trackingRef : undefined;
        prBaseRef = resolveDeliverableBase(run, cwd);
      }
      const prBase = prBaseRef && !isBranchSelfRef(prBaseRef, input.branch)
        ? prBaseFromComparison(prBaseRef)
        : undefined;
      const nonIgnored = (input.excludePaths ?? []).filter((p) => !run('git', ['-C', cwd, 'check-ignore', '-q', p], opts).ok);
      // ⛔ elanous 가 «대상 저장소»에 남기는 자기 런타임 산출물은 호출부가 지정하지 않아도 뺀다.
      //    📏 2026-09-21: monad-agent 는 .gitignore 가 그 이름들을 가려서 이 경로가 «원리상» 안 보였고,
      //       남의 빈 저장소에서 돌리니 `.elanous-child-liveness.hb` 가 PR diff 에 들어갔다.
      //       그리고 리뷰어가 그것을 「실행 부산물」로 정당하게 지적했고, 자식은 그 파일을 «원리상» 못 지워
      //       런이 UNCONVERGEABLE 로 버려졌다(`#19300` 의 고리).
      //    ⛔ 호출부마다 기억하게 하지 않는다 — 그것이 `#19300` 이 한 자리만 고치게 된 이유다.
      //    ⭐ 이미 추적 중인 경로는 안 뺀다 — 사람이 «일부러» 추적하던 것이면 그대로 담는다.
      const untrackedRuntimeArtifacts = (run('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], opts).out ?? '')
        .split('\0')
        .filter((path) => path.length > 0)
        .filter(isElanousRuntimeArtifactPath);
      const exclude = [
        ...nonIgnored.map((p) => `:(exclude)${p}`),
        ...untrackedRuntimeArtifacts.map((p) => `:(exclude,literal)${p}`),
      ];
      const addR = runGitWrite(['-C', cwd, 'add', '-A', '--', ...exclude]);
      if (!addR.ok) return { ok: false, reason: 'add', detail: detailOf(addR) };
      // ⛔ 위 목록은 «스냅샷»이라 경합에 진다 — `.elanous-child-liveness.hb` 는 ***5초마다*** 쓰이므로
      //    `ls-files` 와 `add -A` «사이»에 생기면 그대로 담힌다.
      //    ⇒ 사후 조건으로 한 번 더 내린다. `--diff-filter=A` 라 «새로 들어온 것»만 문다.
      const stagedRuntimeArtifacts = (run('git', ['-C', cwd, 'diff', '--cached', '--name-only', '--diff-filter=A', '-z'], opts).out ?? '')
        .split('\0')
        .filter((path) => path.length > 0)
        .filter(isElanousRuntimeArtifactPath);
      if (stagedRuntimeArtifacts.length > 0) runGitWrite(['-C', cwd, 'reset', '-q', '--', ...stagedRuntimeArtifacts]);
      const commitR = runGitWrite(['-C', cwd, 'commit', '-m', input.commitMessage]);
      if (!commitR.ok) {
        // ★ "nothing to commit" = 실패가 아니라 정직한 no-op(대표 2026-07-21·705308 근본). git commit 은
        //   스테이징 변경이 없으면 exit 1 로 종료한다. 아래에서 진짜 no-op 과 "이미 커밋됨"을 구분한다.
        //   ★ untracked-only 도 noop(대표 2026-07-21) — "nothing added to commit but untracked files present"
        //   는 tracked 변경이 없다는 뜻(=실패 아닌 no-op). git add -A 후에도 남는 untracked(빌드산출 등)만인 경우.
        const blob = `${commitR.out}\n${commitR.err ?? ''}`;
        const noNewChanges = /nothing to commit|no changes added|변경 사항 없음|working tree clean|nothing added to commit|untracked files present/i.test(blob);
        if (!noNewChanges) {
          return { ok: false, reason: 'commit', detail: detailOf(commitR) };
        }
        // ★ "nothing to commit" 에 두 경우가 섞인다(대표 2026-07-26 근본): (1) 진짜 아무 산출도 없는 no-op,
        //   (2) **이미 커밋된 산출**이 base 보다 앞서 있는 경우 — 예: self-implement goal-loop 이 PR 단계 전에
        //   자기 변경을 이미 커밋. (2)는 no-op 이 아니라 **push+PR 로 전달해야 할 완성 작업**이다(종전엔 (2)를
        //   noop 으로 오판→호출부 "PR noop 실패"→완성된 self-dev 산출을 버림). base 대비 앞선 커밋이 있으면
        //   commit 을 스킵하고 push/PR 로 진행한다. base 미상이면 판정 불가라 종전대로 안전한 noop 반환.
        //   ⚠️ base 는 **해석해서** 쓴다(2026-07-26 재발 근본). 종전엔 `input.base` 가 없으면 판정을
        //   포기하고 즉시 noop 이었는데, `--base` 미지정이 **기본값**이라 이 판정이 사실상 전 경로에서
        //   퇴화했다(self-implement openPr 은 `...(base ? { base } : {})` 로 조건 전달·nocturnal-deps 는
        //   아예 미전달). 테스트 픽스처가 항상 base:'main' 을 넘겨 퇴화 경로가 미커버였다.
        //
        //   ⭐ **`noop` 은 안전한 판정이 아니다** (리뷰 must-fix 2026-07-26) — 호출부가 이 값을 보고
        //   완성 산출을 버린다(`seams.ts` openPr 이 throw). 그러므로 "판정할 수 없음"을 noop 으로
        //   접으면 이 PR 이 고치려는 폐기 버그가 다른 입구로 재발한다. **판정 불가는 별도 실패(`base`)**
        //   로 올려 관측·triage 가 원인을 읽게 한다(fail-closed 의 방향을 폐기가 아닌 정직한 오류로).
        if (!comparisonBase) {
          return {
            ok: false,
            reason: 'base',
            detail: '비교 base 해석 실패(origin/HEAD·origin/main·origin/master·main·master 모두 없음) — 이미 커밋된 산출 판정 불가',
          };
        }
        const aheadR = run('git', ['-C', cwd, 'rev-list', '--count', `${comparisonBase}..HEAD`], opts);
        if (!aheadR.ok) {
          return { ok: false, reason: 'base', detail: `base 비교 실패(rev-list ${comparisonBase}..HEAD): ${detailOf(aheadR)}` };
        }
        //   ⚠️ 출력 형식 검증(리뷰 should-fix) — `parseInt(...) || 0` 은 비정상 출력(빈 문자열·잡음)을
        //   조용히 0 으로 접어 폐기 경로(noop)로 보낸다. 숫자가 아니면 판정 불가로 올린다.
        const aheadRaw = aheadR.out.trim();
        if (!/^\d+$/.test(aheadRaw)) {
          return { ok: false, reason: 'base', detail: `base 비교 출력 이상(rev-list ${comparisonBase}..HEAD): ${aheadRaw.slice(0, 120) || '(빈 출력)'}` };
        }
        const ahead = Number.parseInt(aheadRaw, 10);
        //   ⚠️ 커밋 수만으로는 부족하다 — self-implement 는 PR 전 `pre-pr-sync` 로 base 를 머지하므로
        //   **아무 산출도 없는 run 도 병합 커밋 1개로 ahead=1** 이 된다(→ 빈 PR). 내용차까지 확인해
        //   "전달할 산출이 실제로 있나"로 판정한다. `--name-only` 는 차이 없으면 exit 0 + 빈 출력이라
        //   에러(exit≠0)와 구분된다(`--quiet` 는 diff 있음과 ref 오류가 둘 다 exit≠0 로 뭉개진다).
        const diffR = run('git', ['-C', cwd, 'diff', '--name-only', `${comparisonBase}..HEAD`], opts);
        if (!diffR.ok) {
          return { ok: false, reason: 'base', detail: `base 비교 실패(diff ${comparisonBase}..HEAD): ${detailOf(diffR)}` };
        }
        const hasContent = diffR.out.trim().length > 0;
        if (ahead <= 0 || !hasContent) {
          return { ok: false, reason: 'noop', detail: 'nothing to commit(이미 반영됨·no-op)' };
        }
        // ahead > 0 + 내용차 존재 → 이미 커밋된 산출. commit 스킵하고 아래 push + PR 로 fall-through.
      }
      // 카드 계보를 아는 재작업은 새 run 가지를 발사하기 전에 같은 칸 PR 을 찾는다.
      // 같은 카드로 증명된 단일 PR 만 기존 가지를 빠른 전진시킨다. 다른 계보·모호한 목록은 종전 가드다.
      const candidateCardId = cardIdFromBody(input.body);
      if (hasCardMarker(input.body) && !candidateCardId)
        return { ok: false, reason: 'guard', detail: 'candidate card lineage is ambiguous' };
      const earlyGuard = candidateCardId && checkCreate
        ? checkCreate({ cwd, base: comparisonBase, seat: input.seat ?? seatFromEnvironment(), body: input.body }, run)
        : undefined;
      // ★ sibling-slice 허용 분기 — 같은 칸의 «다른 조각» OPEN PR 은 충돌로 보지 않는다.
      //   다른 조각 번호(같은 total) → same-cell 사유만 빼고 새 draft 허용 · 같은 조각 번호 → 기존
      //   재사용/거부 그대로 · 후보에 표지 없음 → 기존 가드 그대로(siblingSliceAllowed 는 그대로 반환).
      const siblingSliceAllowed = (verdict: GuardVerdict): GuardVerdict => {
        // Injected guards may still use the old card-only reuse predicate. Never force-push
        // one slice over another, even when the card lineage matches.
        const reused = verdict.sameCellReuse;
        const reusedConflict = reused && verdict.sameCellConflicts?.find(conflict => conflict.pr === reused.number);
        const safeReuse = !reused || ((candidateSlice?.slice ?? null) === (reusedConflict?.slice?.slice ?? null)
          && (candidateSlice?.total ?? null) === (reusedConflict?.slice?.total ?? null));
        const checkedVerdict = safeReuse ? verdict : { ...verdict, sameCellReuse: undefined };
        if (!candidateSlice || checkedVerdict.status !== 'refuse' || checkedVerdict.sameCellReuse || !checkedVerdict.sameCellConflicts?.length)
          return checkedVerdict;
        const conflicts = checkedVerdict.sameCellConflicts;
        if (conflicts.some(conflict => !conflict.slice || conflict.slice.slice === candidateSlice.slice)) return checkedVerdict;
        if (!conflicts.every(conflict => conflict.slice!.total === candidateSlice.total)) return checkedVerdict;
        debug.log('autopilot.pr-manager', 'same-cell-sibling-slice', {
          cell: cellIdFromBody(input.body), slice: candidateSlice.slice, total: candidateSlice.total,
          existingSlice: conflicts[0]!.slice!.slice, outcome: 'allowed' });
        const reasons = checkedVerdict.reasons.filter(reason => reason.code !== 'same-cell');
        return reasons.length ? { ...checkedVerdict, reasons } : { ...checkedVerdict, status: 'allow', reasons: [] };
      };
      const earlyVerdict = earlyGuard ? siblingSliceAllowed(earlyGuard) : undefined;
      const freshGuard = () => checkCreate!({ cwd, base: comparisonBase, seat: input.seat ?? seatFromEnvironment(), body: input.body }, run);
      if (earlyVerdict?.sameCellReuse) return reuseSameCellPr(run, input, earlyVerdict.sameCellReuse, earlyVerdict, freshGuard);
      if (earlyVerdict?.status === 'refuse') return { ok: false, reason: 'guard', detail: sameCellGuardDetail(earlyVerdict, candidateCardId) };
      const earlyInventoryUnknown = !!candidateCardId && (!checkCreate || (earlyVerdict?.status === 'unknown'
        && earlyVerdict.reasons.length === 1 && earlyVerdict.reasons[0]?.code === 'inventory-unknown'));
      if (candidateCardId && earlyVerdict?.status !== 'allow' && !earlyInventoryUnknown)
        return { ok: false, reason: 'guard', detail: 'candidate card inventory unmeasured before push' };
      if (earlyInventoryUnknown) debug.log('pr-tool.open-guard', 'candidate-inventory-unmeasured', {
        branch: input.branch, cardId: candidateCardId, stage: 'before-push',
        reason: earlyVerdict?.reasons[0]?.detail ?? 'create guard unavailable',
      });
      if (candidateCardId) {
        const branchPr = findPrForBranchOutcome(input.branch, cwd);
        if (branchPr.status === 'FAILED' || branchPr.url)
          return { ok: false, reason: 'guard', detail: 'candidate run branch PR already exists or is unmeasured before push' };
      }
      // force-push — 재구현이 이전 구현을 교체(기존 브랜치 갱신 or 신규). 안정 브랜치명이라 기존 PR 이
      //   있으면 GitHub 이 그 PR 을 자동 업데이트(닫고 새로 안 만듦). elanous 자체 SE 브랜치라 force 안전.
      //   일시 원격 실패(5xx·연결 끊김 등)만 최대 3회. 영구 거부는 한 번에 끝낸다.
      const waitForPushRetry = input.waitForPushRetry ?? defaultWaitForPushRetry;
      // ★ 칸 PR-CREATE-FAIL-OBSERVE-FU — push/gh 단계 관측을 쌓아 실패 시 한 incident 로.
      const pushStage: PrCreateStageObservation = { stage: 'push', ran: false };
      const ghStage: PrCreateStageObservation = {
        stage: 'gh', ran: false,
        lookup: { stage: 'gh', ran: false },
        create: { stage: 'gh', ran: false },
      };
      const observeGhCommand = (r: CmdResult): PrCreateStageObservation => ({
        stage: 'gh', ran: true, ...(typeof r.rc === 'number' ? { rc: r.rc } : {}),
        ...(stderrTailOf(r.err) ? { stderrTail: stderrTailOf(r.err) } : {}),
        ...(stderrTailOf(r.out) ? { stdoutTail: stderrTailOf(r.out) } : {}),
      });
      const markGhRan = (r: CmdResult): CmdResult => {
        ghStage.ran = true;
        ghStage.rc = r.rc;
        ghStage.stderrTail = stderrTailOf(r.err);
        ghStage.stdoutTail = stderrTailOf(r.out);
        ghStage.create = observeGhCommand(r);
        return r;
      };
      const failedCreate = (reason: 'push' | 'gh', detail: string): UpsertPrOutcome =>
        prCreateFailureOutcome(input, reason, detail, pushStage, ghStage);
      const pushArgs = candidateCardId
        ? ['-C', cwd, 'push', '-u', 'origin', input.branch]
        : ['-C', cwd, 'push', '--force', '-u', 'origin', input.branch];
      let pushR = runGitWrite(pushArgs);
      let pushAttempts = 1;
      while (!pushR.ok && pushAttempts < MAX_PUSH_ATTEMPTS && isTransientPushFailure(detailOf(pushR))) {
        waitForPushRetry(pushAttempts);
        pushR = runGitWrite(pushArgs);
        pushAttempts += 1;
      }
      pushStage.ran = true;
      pushStage.ok = pushR.ok;
      pushStage.rc = pushR.rc;
      pushStage.stderrTail = stderrTailOf(pushR.err);
      if (!pushR.ok) {
        const detail = pushAttempts > 1
          ? `push ${pushAttempts}/${MAX_PUSH_ATTEMPTS} failed: ${detailOf(pushR)}`
          : detailOf(pushR);
        return failedCreate('push', detail);
      }
      const existing = findPrForBranchOutcome(input.branch, cwd);
      if (existing.status !== 'SKIPPED') {
        ghStage.ran = true;
        ghStage.lookup = {
          stage: 'gh', ran: true,
          ...(typeof existing.rc === 'number' ? { rc: existing.rc } : {}),
          ...(existing.stderrTail ? { stderrTail: existing.stderrTail } : {}),
          ...(existing.status === 'FAILED' && existing.stdoutTail ? { stdoutTail: existing.stdoutTail } : {}),
        };
        if (existing.status === 'FAILED') {
          ghStage.rc = existing.rc;
          ghStage.stderrTail = existing.stderrTail;
          ghStage.stdoutTail = existing.stdoutTail;
        }
      }
      if (existing.url) {
        if (candidateCardId)
          return { ok: false, reason: 'guard', detail: 'candidate run branch PR appeared after push; refuse edit' };
        return editExistingPr(run, input, existing.url);
      }
      if (existing.status === 'FAILED') {
        return failedCreate('gh', 'existing PR branch lookup failed');
      }
      let guardUnmeasured = earlyInventoryUnknown;
      let hunkOverlapWarning: { prs: readonly number[]; files: readonly string[] } | null = null;
      if (checkCreate) {
        const seat = input.seat ?? seatFromEnvironment();
        // Another run may open a PR after the early inventory and before this create.
        // Read the complete OPEN inventory again after push, immediately before create.
        const verdict = checkCreate({ cwd, base: comparisonBase, seat, body: input.body }, run);
        // sibling-slice: 같은 칸의 다른 조각이 inventories 사이 열려도 생성은 허용한다(위 분기와 동일 규칙).
        const siblingVerdict = siblingSliceAllowed(verdict);
        if (siblingVerdict.sameCellReuse)
          return { ok: false, reason: 'guard', detail: 'same-cell PR appeared after run branch push; retry from fresh inventory' };
        const hunkWarn = siblingVerdict.status === 'allow' ? siblingVerdict.warnings.find(warning => warning.code === 'hunk-overlap') : undefined;
        if (hunkWarn) hunkOverlapWarning = { prs: hunkWarn.prs ?? [], files: hunkWarn.files ?? [] };
        if (siblingVerdict.status === 'unknown' && siblingVerdict.reasons.length === 1 && siblingVerdict.reasons[0]?.code === 'inventory-unknown') {
          const inPod = process.env.ELANOUS_SUBSTRATE === 'pod'
            || Object.keys(process.env).some(key => key.startsWith('ELANOUS_POD_'));
          if (inPod) {
            // Pod state and mailbox are local to this Job. Count and alert only
            // in the host parent, where the shared instance root is authoritative.
            debug.log('pr-tool.open-guard', 'pod-unmeasured', { seat, reason: siblingVerdict.reasons[0].detail });
          } else {
            const count = recordUnmeasured({ seat, reason: siblingVerdict.reasons[0].detail });
            if (count.blocked) {
              const alert = run('eln', ['msg', 'post', '--from', seat ?? 'HARNESS', '--to', 'OP', '--kind', 'alert', '--body', `PR open-guard 판정 불가 1시간 ${count.count}회 · ${candidateCardId ? '카드 후보는 draft 관측' : '새 PR 차단'} · ${count.reason ?? siblingVerdict.reasons[0].detail}`]);
              if (!alert.ok) debug.log('pr-tool.open-guard', 'op-alert-failed', { seat, reason: alert.err || alert.out || 'eln msg post 실패' });
              if (!candidateCardId) return { ok: false, reason: 'guard', detail: `inventory-unknown: 1시간 ${count.count}회 · 새 PR 차단${count.reason ? ` (${count.reason})` : ''}` };
            }
          }
          guardUnmeasured = true;
        } else if (siblingVerdict.status !== 'allow') {
          return { ok: false, reason: 'guard', detail: sameCellGuardDetail(siblingVerdict, candidateCardId) };
        }
      }
      const createArgs = ['pr', 'create', '--head', input.branch, '--title', input.title, '--body', input.body];
      if (prBase) createArgs.push('--base', prBase);
      if (input.draft || guardUnmeasured) createArgs.push('--draft');
      const seat = input.seat ?? seatFromEnvironment();
      const requiredLabels = [...(seat ? [`seat:${seat}`] : []), ...(guardUnmeasured ? ['pr-guard:unmeasured'] : [])];
      // PR-GUARD-HUNK-WARN: 줄 겹침 경고 라벨은 «최선» — 만들기 실패해도 아래 재시도가 빼고 PR 을 연다.
      const guardLabels = hunkOverlapWarning ? ['pr-guard:hunk-overlap'] : [];
      const creatableLabels = [...requiredLabels, ...guardLabels];
      const requestedLabels = [...new Set([...(input.labels ?? []), ...creatableLabels].map((label) => label.trim()).filter(Boolean))];
      const labeledArgs = [...createArgs];
      for (const label of requestedLabels) labeledArgs.push('--label', label);
      let created = markGhRan(run('gh', labeledArgs, opts));
      if (!created.ok && creatableLabels.length && isLabelNotFoundFailure(created, creatableLabels)) {
        for (const label of creatableLabels) run('gh', ['label', 'create', label, '--color', 'BFDADC'], opts);
        created = markGhRan(run('gh', labeledArgs, opts));
      }
      const logHunkOverlapWarn = (url: string): void => {
        if (hunkOverlapWarning) debug.log('pr-tool.guard', 'hunk-overlap-warn', { pr: extractPrNumber(url), files: hunkOverlapWarning.files, against: hunkOverlapWarning.prs });
      };
      if (created.ok && created.out) {
        if (guardUnmeasured) debug.log('pr-tool.open-guard', 'candidate-draft-unmeasured', {
          branch: input.branch, cardId: candidateCardId ?? null, url: created.out,
        });
        logHunkOverlapWarn(created.out);
        return {
          ok: true,
          url: created.out,
          reused: false,
          ...(requestedLabels.length > 0 ? { labelsApplied: true } : {}),
        };
      }
      if (requestedLabels.length > 0 && isLabelNotFoundFailure(created, requestedLabels)) {
        const retryArgs = [...createArgs];
        for (const label of requiredLabels) retryArgs.push('--label', label);
        const retry = markGhRan(run('gh', retryArgs, opts));
        if (retry.ok && retry.out) {
          logHunkOverlapWarn(retry.out);
          debug.log('autopilot.pr-manager', 'create.labels-omitted', {
            branch: input.branch,
            labels: requestedLabels,
            detail: detailOf(created),
            url: retry.out,
          });
          return { ok: true, url: retry.out, reused: false, labelsOmitted: true };
        }
        return failedCreate('gh', detailOf(retry) || 'gh pr create 실패');
      }
      // 여기까지 흘러내려왔으면 성공 return 을 못 만났다 — 실패 incident 로 마무리.
      return failedCreate('gh', detailOf(created) || 'gh pr create 실패');
    },
    closePr(prUrl, comment) {
      const n = extractPrNumber(prUrl);
      if (n === null) return false;
      const args = ['pr', 'close', String(n), '--delete-branch'];
      if (comment) args.push('--comment', comment);
      return run('gh', args).ok;
    },
    mergePr(prUrl) {
      return this.mergePrOutcome(prUrl).ok;
    },
    mergePrOutcome(prUrl, expectedHead, cwd) {
      const n = extractPrNumber(prUrl);
      if (n === null) return { ok: false, kind: 'state-read-failed' };
      if (expectedHead !== undefined) {
        const pinned = run('gh', ['pr', 'view', String(n), '--json', 'headRefOid,state,isDraft'], cwd ? { cwd } : undefined);
        try {
          if (!pinned.ok) return { ok: false, kind: 'state-read-failed' };
          const view = JSON.parse(pinned.out) as { headRefOid?: unknown; state?: unknown; isDraft?: unknown };
          if (view.headRefOid !== expectedHead || view.state !== 'OPEN' || view.isDraft !== false) {
            return { ok: false, kind: 'state-read-failed' };
          }
        } catch { return { ok: false, kind: 'state-read-failed' }; }
      }
      const deleteRemoteHead = (kind: 'merge-exit-0' | 'merged-after-nonzero'): MergePrOutcome => {
        const head = run('gh', ['pr', 'view', String(n), '--json', 'headRefName,headRepository'], cwd ? { cwd } : undefined);
        if (!head.ok) return { ok: true, kind, remoteBranchDeletion: { detail: head.err || head.out || 'PR head branch 조회 실패' } };
        try {
          const { headRefName, headRepository } = JSON.parse(head.out) as {
            headRefName?: unknown;
            headRepository?: { nameWithOwner?: unknown } | null;
          };
          const repository = headRepository?.nameWithOwner;
          if (typeof headRefName !== 'string' || !headRefName || typeof repository !== 'string' || !repository) {
            return { ok: true, kind, remoteBranchDeletion: { detail: 'PR head branch 또는 저장소를 읽지 못했습니다' } };
          }
          const deleted = run('gh', ['api', '--method', 'DELETE', `repos/${repository}/git/refs/heads/${encodeURIComponent(headRefName)}`], cwd ? { cwd } : undefined);
          return deleted.ok
            ? { ok: true, kind }
            : { ok: true, kind, remoteBranchDeletion: { detail: deleted.err || deleted.out || `원격 브랜치 ${headRefName} 삭제 실패` } };
        } catch {
          return { ok: true, kind, remoteBranchDeletion: { detail: 'PR head branch 응답을 읽지 못했습니다' } };
        }
      };
      const merged = run('gh', ['pr', 'merge', String(n), '--squash', ...(expectedHead ? ['--match-head-commit', expectedHead] : [])], cwd ? { cwd } : undefined);
      if (merged.ok) return deleteRemoteHead('merge-exit-0');
      let lastNotMerged: string | undefined;
      let notMergedCount = 0;
      let sawUnreadable = false;
      for (let i = 0; i < MERGE_UNMERGED_CONFIRMATIONS; i++) {
        const reading = readPrMergeState(run, n, cwd);
        if (reading.status === 'merged') return deleteRemoteHead('merged-after-nonzero');
        if (reading.status === 'unreadable') {
          sawUnreadable = true;
          continue;
        }
        lastNotMerged = reading.state;
        notMergedCount++;
      }
      if (notMergedCount >= MERGE_UNMERGED_CONFIRMATIONS) {
        return { ok: false, kind: 'not-merged', state: lastNotMerged ?? 'unknown' };
      }
      if (notMergedCount === 0 && sawUnreadable) return { ok: false, kind: 'state-read-failed' };
      return { ok: false, kind: 'unknown' };
    },
  };
}
