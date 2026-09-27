// ── git-fs worktree ops ──
//
// Thin wrappers around `git worktree add / remove / list`. The TUI
// (dashboard + slash + LLM tool) pairs these with setSessionCwd so
// entering a worktree promotes its path to the session's active
// project root — SWD coupling.
//
// Claude-code's EnterWorktreeTool (src/tools/EnterWorktreeTool) is
// the pattern; we trim the hook-based fallback (sandboxed envs)
// because elanous's primary surface runs native git.

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { findGitDir } from './locate.js';
import { isTransientGitError } from './retry.js';
import { runGitCommand } from './runner.js';
import { debug } from '../debug/log.js';

const GIT_TIMEOUT_MS = 30_000;

/** Git metadata left by an interrupted operation in one checkout. */
/** ⚠️ 공개인 이유(무인 리뷰 질의) — `GitResidueObservation.residues` 의 **원소 타입**이라,
 *  이걸 내리면 그 배열을 소비하는 쪽(`dev-pipeline`)이 원소를 이름으로 못 부른다. 관측 계약의
 *  일부라 공개로 둔다. ⛔ 정의 모듈 밖 직접 소비처가 아직 없다는 지적은 사실이고, 그것이
 *  이 타입을 내릴 근거는 아니다(계약은 소비 시점보다 먼저 선언된다). */
export type GitResidueKind = 'cherry-pick' | 'revert' | 'sequencer' | 'merge' | 'rebase' | 'bisect' | 'index-lock';

export type GitResidueObservation =
  | { state: 'observed'; residues: GitResidueKind[] }
  | { state: 'unreadable' };

export interface GitResidueObserverDeps {
  lstat(path: string): void;
  readFile(path: string): string;
}

const DEFAULT_GIT_RESIDUE_OBSERVER_DEPS: GitResidueObserverDeps = {
  lstat: (path) => { lstatSync(path); },
  readFile: (path) => readFileSync(path, 'utf8'),
};

/**
 * Git's on-disk markers for an operation that has stopped before completion.
 * All are per-worktree state: Git places them in the checkout's `gitDir`, not
 * in `commonGitDir`. `REBASE_HEAD` is deliberately absent because the durable
 * rebase control state is `rebase-merge` or `rebase-apply`; `AUTO_MERGE`,
 * `MERGE_MSG`, and `SQUASH_MSG` are auxiliary files, not state on their own.
 * Bisect is included because BISECT_START is Git's persistent resume/abort
 * marker; its companion BISECT_* files are derived state under that marker.
 */
const GIT_RESIDUE_MARKERS = [
  { path: 'CHERRY_PICK_HEAD', kind: 'cherry-pick' },
  { path: 'REVERT_HEAD', kind: 'revert' },
  { path: 'sequencer', kind: 'sequencer' },
  { path: 'MERGE_HEAD', kind: 'merge' },
  { path: 'rebase-merge', kind: 'rebase' },
  { path: 'rebase-apply', kind: 'rebase' },
  { path: 'BISECT_START', kind: 'bisect' },
  { path: 'index.lock', kind: 'index-lock' },
] as const satisfies readonly { path: string; kind: GitResidueKind }[];

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Read this checkout's Git control metadata without invoking Git or writing state. */
export function observeGitResidue(repoPath: string, deps: GitResidueObserverDeps = DEFAULT_GIT_RESIDUE_OBSERVER_DEPS): GitResidueObservation {
  try {
    const located = findGitDir(repoPath);
    if (!located) return { state: 'unreadable' };
    const residues: GitResidueKind[] = [];
    for (const marker of GIT_RESIDUE_MARKERS) {
      const markerPath = join(located.gitDir, marker.path);
      try {
        deps.lstat(markerPath);
      } catch (error) {
        if (isAbsent(error)) continue;
        return { state: 'unreadable' };
      }
      let kind = marker.kind;
      if (marker.path === 'sequencer') {
        try {
          const firstCommand = deps.readFile(join(located.gitDir, 'sequencer', 'todo')).trim().split(/\s+/, 1)[0];
          kind = firstCommand === 'pick' ? 'cherry-pick' : 'sequencer';
        } catch (error) {
          if (!isAbsent(error)) return { state: 'unreadable' };
        }
      }
      if (!residues.includes(kind)) residues.push(kind);
    }
    return { state: 'observed', residues };
  } catch {
    return { state: 'unreadable' };
  }
}

export const LIVE_INDEX_LOCK_MAX_AGE_MS = 5 * 60_000;

/** 잔여 때문에 막혔다는 것을 **타입으로** 말한다 — 호출자가 다른 정리 실패와 가를 수 있어야
 *  하고(공유 동작 보존), 멈춘 이유·관측이 산출물까지 살아 남아야 한다(관측 수용 기준). */
export class GitResidueBlockedError extends Error {
  readonly observation: GitResidueObservation;
  readonly worktreePath: string;
  constructor(reason: string, observation: GitResidueObservation, worktreePath: string) {
    super(reason);
    this.name = 'GitResidueBlockedError';
    this.observation = observation;
    this.worktreePath = worktreePath;
  }
}

export type GitResidueGate =
  | { allowed: true; observation: Extract<GitResidueObservation, { state: 'observed' }> }
  | { allowed: false; observation: GitResidueObservation; reason: string };

/** Consume a single read-only residue observation, allowing only a freshly-written index lock. */
export function gateGitResidue(repoPath: string, now = Date.now(), observation = observeGitResidue(repoPath)): GitResidueGate {
  if (observation.state === 'unreadable') {
    return { allowed: false, observation, reason: 'git residue unreadable' };
  }
  const blocking = observation.residues.filter((kind) => {
    if (kind !== 'index-lock') return true;
    const gitDir = findGitDir(repoPath)?.gitDir;
    if (!gitDir) return true;                      // 뿌리를 못 찾으면 판정 불가 → 막는다
    try {
      return now - lstatSync(join(gitDir, 'index.lock')).mtimeMs >= LIVE_INDEX_LOCK_MAX_AGE_MS;
    } catch (error) {
      // ⛔ **사라진 잠금을 막으면 오탐이다**(무인 리뷰 must-fix). 관측과 이 재확인 사이에
      //   정상 git 작업이 끝나 `index.lock` 을 지우는 것은 **흔한 정상 경로**다. 그때
      //   `ENOENT` 가 나는데, 초판은 그것을 `catch → true`(차단)로 삼켰다.
      //   ⇒ 부재는 **해소**다. 나머지 오류(권한 등)만 판정 불가로 보고 막는다.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      return true;
    }
  });
  return blocking.length === 0
    ? { allowed: true, observation }
    : { allowed: false, observation, reason: `git residue blocks operation: ${blocking.join(', ')}` };
}

/** 동기 슬립(spawnSync 기반·재시도 백오프용). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  spawnSync('sleep', [(ms / 1000).toFixed(3)], { timeout: ms + 1000 });
}

/** Slug for a branch name → safe on-disk directory name. Claude-code
 *  allows `feature/foo` as a branch; we flatten that to `feature-foo`
 *  for the directory so nested dirs don't appear inside .worktrees/. */
export function worktreeDirName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
}

/** Root directory where elanous stores a repository's per-branch worktrees.
 *  This is pure path derivation; creation remains the responsibility of createWorktree.
 *
 *  ⛔⭐⭐⭐ `worktreeRoot` 는 **필수**다 — 폴백을 «일부러» 없앴다(리뷰 3R must-fix ②).
 *  종전엔 선택 인자라 안 넘기면 조용히 «형제 배치»로 떨어졌고, 그래서
 *  ***「소비처가 뿌리를 안 넘겼다」가 컴파일러에게 보이지 않았다.*** 소스 스캔으로 그것을 세려던
 *  두 판이 모두 Goodhart 로 판정됐다(별칭·래퍼·복합 인자를 못 본다).
 *  ⇒ 🩹 그래서 **타입이 판정하게** 한다 — 누락은 이제 «컴파일 에러»다.
 *  ⚠️ 옛 «형제» 배치가 필요한 자리는 `dirname(repoRoot)` 를 «명시»로 넘긴다 — 헬퍼를 따로 두지 않는다
 *     (리뷰 4R: 소비처가 테스트뿐인 공개 export 는 표면만 넓힌다). */
export function worktreeParentDir(repoRoot: string, worktreeRoot: string): string {
  return join(worktreeRoot, worktreeRepoScope(repoRoot), `${basename(repoRoot)}.worktrees`);
}

/** 전역 뿌리 아래에서 저장소를 가르는 «중간 폴더» 이름.
 *
 *  ⛔⭐⭐⭐ 왜 필요한가 — 리뷰 5R must-fix ①. 📏 이 기계 실측:
 *  `/Users/…/source/{axon,elan,pilot,project,temp,test}/monad-agent` — ***여섯이 전부 같은 basename***.
 *  형제 배치에선 부모 디렉터리가 그 여섯을 갈랐지만, 전역 뿌리로 모으면 **한 경로를 공유**한다.
 *  ⇒ 🚨 생성이 충돌하고, 더 나쁘게는 ***정리가 남의 저장소 worktree 를 지운다.***
 *
 *  ⛔⭐ 왜 «중간 폴더»이고 `<name>-<hash>.worktrees` 가 «아닌가**: 이 저장소에는
 *  `…/monad-agent.worktrees` 라는 **경로 문자열을 전제하는 소비처**가 있다
 *  (`src/nexus/api/terminals.ts` 의 `parts.indexOf('monad-agent.worktrees')`).
 *  이름에 해시를 «섞으면» 그 자리가 조용히 깨진다. 한 겹을 «앞에» 두면 마지막 마디가 보존된다.
 *  ⇒ 🩹 `<뿌리>/<중간 폴더>/<저장소>.worktrees/<브랜치>` — 대표 이 처음 말한 그 배치이기도 하다. */
export function worktreeRepoScope(repoRoot: string): string {
  // ⛔⭐⭐ `resolve` «만»으로는 안 된다 — 심링크를 안 푼다. macOS 의 `/var` → `/private/var` 처럼
  //   ***같은 저장소가 두 표기를 가지면 해시가 갈려 «다른 중간 폴더»가 된다***(실측: 이 수리 전
  //   `EnterWorktree from inside an existing worktree` 가 그 이유로 실패했다).
  //   ⇒ 실경로로 정규화한다. 경로가 아직 없으면(계획 단계) `resolve` 로 물러선다.
  let resolved = resolve(repoRoot);
  try { resolved = realpathSync(resolved); } catch { /* 없는 경로 — resolve 값 유지 */ }
  // FNV-1a 32bit — 암호용이 아니라 «경로를 가르는» 용도라 짧고 결정론적이면 된다.
  let hash = 0x811c9dc5;
  for (let i = 0; i < resolved.length; i++) {
    hash ^= resolved.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // 사람이 「어느 트리인지」 읽을 수 있게 부모 디렉터리 이름을 앞에 둔다(예: `pilot-1a2b3c4d`).
  const parentName = basename(dirname(resolved)) || 'repo';
  return `${parentName.replace(/[^a-zA-Z0-9._-]/g, '-')}-${hash.toString(16).padStart(8, '0')}`;
}


/** `elanous dev`가 `--base` 생략을 호출자 HEAD와 구별해 전달하는 내부 ref 표식. */
export const DEFAULT_BRANCH_WORKTREE_BASE = 'elanous:default-branch';

/** Worktree dependency-link outcome, separated by action so callers can observe fail-soft setup. */
export interface WorktreeDependencyLinkResult {
  linked: string[];
  skippedMissingSource: string[];
  skippedExistingTarget: string[];
  failed: Array<{ path: string; reason: string }>;
}

export interface WorktreeDependencyLinkDeps {
  symlink?: (target: string, path: string, type: 'dir') => void;
}

/** Untracked dependency locations every elanous worktree shares from its source checkout. */
export const DEFAULT_WORKTREE_DEPENDENCY_PATHS = [
  'node_modules',
  'apps/pwa/node_modules',
] as const;

/**
 * Link common and caller-selected, untracked dependencies from a repository into a worktree.
 * Every entry is independent: an unavailable source, an existing target, or a
 * filesystem failure is recorded without preventing subsequent entries.
 */
export function linkWorktreeDependencies(
  repoRoot: string,
  worktreePath: string,
  relativePaths: readonly string[] = [],
  deps: WorktreeDependencyLinkDeps = {},
): WorktreeDependencyLinkResult {
  const result: WorktreeDependencyLinkResult = {
    linked: [],
    skippedMissingSource: [],
    skippedExistingTarget: [],
    failed: [],
  };
  const link = deps.symlink ?? ((source, target, type) => symlinkSync(source, target, type));
  const plannedPaths = [...new Set([...DEFAULT_WORKTREE_DEPENDENCY_PATHS, ...relativePaths])];
  for (const relativePath of plannedPaths) {
    const source = join(repoRoot, relativePath);
    const target = join(worktreePath, relativePath);
    if (!existsSync(source)) {
      result.skippedMissingSource.push(relativePath);
      continue;
    }
    if (existsSync(target)) {
      result.skippedExistingTarget.push(relativePath);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      link(source, target, 'dir');
      result.linked.push(relativePath);
    } catch (error) {
      result.failed.push({ path: relativePath, reason: String(error) });
    }
  }
  return result;
}

export interface CreateWorktreeOpts {
  /** Absolute repo root (main checkout). */
  repoRoot: string;
  /** Branch name — user-supplied. Slug-validated. */
  branch: string;
  /** Root directory that holds this repository's worktree parent.
   *  ⛔⭐ **필수다** — 생략하면 컴파일 에러다(리뷰 3R must-fix ②).
   *  프로덕션은 `configuredWorktreeRoot()` 를, 테스트는 임시 디렉터리를 넘긴다.
   *  형제 배치가 필요하면 `dirname(repoRoot)` 를 명시로 넘긴다. */
  worktreeRoot: string;
  /** Optional base branch / commit to branch from. Default: the
   *  current HEAD of repoRoot. */
  base?: string;
  /** ★ 재실행 견고화(대표 지시 2026-07-12) — 안정 브랜치/경로가 이전 세대에서 고아로
   *  남았을 때 하드 실패("branch already exists"·"path already exists") 대신 정리 후
   *  재생성한다: 고아 worktree prune + `-B`(존재 시 base 로 리셋). SE 격리(재실행·재구현)
   *  전용 — TUI 등 기본(false)은 기존 브랜치를 보호(존재 시 실패 유지). */
  resetExisting?: boolean;
  /** ⭐ 원격 base 동기화를 건너뛴다(기본 false = 동기화한다). 원격이 없는 로컬 임시 repo
   *  (결정론 테스트)나 의도적으로 로컬 tip 에서 갈라야 할 때만 켠다.
   *  ⛔ 자율 파이프라인에서 켜지 마라 — 이 플래그가 곧 "낡은 지점에서 갈려도 좋다" 는 뜻이다. */
  skipRemoteBaseSync?: boolean;
  /** ⭐⭐ 그 브랜치를 **이미 쥔 워크트리가 있어도** 그것이 이 저장소가 만든 것이고 커밋되지 않은
   *  변경이 없으면 «지우지 않고 그대로 재사용»한다.
   *
   *  왜: 외부 에이전트 백엔드로 PR 을 낸 뒤 그 PR 의 리뷰를 같은 브랜치에 이어 붙이려 하면
   *  종전엔 이 자리에서 막혀 **사람이 손으로 워크트리를 지우고 다시 쏴야 했다** — 수리 라운드가
   *  무인으로 안 돈다(실측 2026-08-11).
   *
   *  ⛔ 기본은 `false` = **종전 그대로 거부**한다. 안전장치를 «푸는» 스위치이므로 호출자가
   *     명시해야 한다. 판정은 `gateWorktreeReuse` 가 하고, 셋 중 하나라도 아니면 거부한다.
   *  ⚠️ 이 플래그가 켜지면 `resetExisting` 보다 **먼저 이긴다** — 재사용 가능한 트리를 지우지 않는다. */
  reuseOwnedWorktree?: boolean;
  /** ⭐ 지금 요청하는 런의 소유 표시. 호출자가 준 값만 쓴다 — 이 파일은 전역/환경을 뒤져 추측하지 않는다.
   *  기록된 owner 와 **정확히 같을 때**만 더티를 재사용 거부 사유로 쓰지 않는다(그 dirt 는 그 런 자신의 산출).
   *  ⛔ 생략·공백이면 종전 동작: 더티는 `worktree-dirty` 로 거부한다. */
  currentOwner?: string;
}

/** base 를 무엇으로 확정했는지 — **모름과 부재를 값으로 가른다.**
 *  - `head`              base 미지정(호출자 HEAD)
 *  - `sha`               base 가 이미 커밋 SHA
 *  - `remote-synced`     origin 에 있는 브랜치라 fetch 해서 **원격 tip** 에서 갈랐다
 *  - `local-only`        origin 에 없는 브랜치라 로컬 ref 에서 갈랐다
 *  - `remote-unreachable` origin 조회 자체가 실패했다(오프라인 등) — 로컬로 갈랐고 **그 사실을 안다**
 *  - `reused`            ⭐ base 를 **아예 확정하지 않았다** — 이미 있던 소유 워크트리를 그대로 썼다.
 *                        ⛔ 그때 `base` 필드는 «요청한 ref 이름»일 뿐 적용된 적이 없다. */
export type WorktreeBaseFreshness = 'head' | 'sha' | 'remote-synced' | 'local-only' | 'remote-unreachable' | 'reused';

export interface CreateWorktreeResult {
  path: string;       // the new worktree's absolute directory
  branch: string;     // branch name (as-given)
  base: string;       // base ref resolved (기존 의미 유지 — 생략 시 'HEAD')
  /** ⭐ 실제 시작 커밋 SHA. `base` 는 **ref 이름**이라 'HEAD' 가 무엇이었는지 못 말한다.
   *  ⛔ 빈 문자열을 싣지 않는다 — 못 얻으면 던진다(모름을 값으로 바꾸지 않는다). */
  resolvedBase: string;
  /** ⭐ base 를 **어떻게** 확정했나. `resolvedBase`(SHA 하나)만으로는
   *  *"원격 tip 에서 갈랐다"* 와 *"낡은 로컬 ref 에서 갈랐다"* 가 **같은 값으로 보인다.** */
  baseFreshness: WorktreeBaseFreshness;
  /** ⭐ 새로 만든 게 아니라 **이미 있던 소유 워크트리를 그대로 재사용**했다.
   *  ⛔ 재사용을 «요청하지 않은» 호출자에게는 이 필드가 실리지 않는다(종전 산출 그대로). */
  reused?: true;
}

/** ⭐⭐ base 를 원격과 맞춘다 — **조용한 낡음을 없앤다.**
 *
 * 왜: `git worktree add <path> <base>` 는 `<base>` 를 **로컬에서만** 푼다. 원격이 앞서 있으면
 * 자식은 낡은 지점에서 갈리고 **실패하지 않는다**. 실측(2026-07-29): `--base <PR 브랜치>` 를 줬는데
 * 자식이 그 브랜치의 4커밋 전에서 갈려 **이미 있는 파일을 새로 썼고**, 스택 머지가 base 를 삼켜
 * 리뷰가 남의 작업을 이 PR 것으로 읽었다(거짓 scope-creep 판정).
 *
 * 계약: origin 에 그 브랜치가 **있으면** 반드시 fetch 해서 원격 tip 을 쓴다. 있는 걸 아는데
 * 가져오지 못하면 **던진다**(fail-closed) — 낡은 채로 조용히 진행하지 않는다.
 * origin 에 **없으면** 로컬로 가되 그 사실을 값으로 남긴다.
 */
/** git 실행 seam — 기본은 실 `spawnSync`. 테스트가 실패 분기(ls-remote 실패·fetch 실패·경합)를
 *  **결정론적으로** 재도록 주입 가능하게 뺐다(사후 리뷰 should-fix: 그 분기들이 회귀 무방비였다).
 *  ⛔ 결과 타입을 따로 export 하지 않는다 — 외부 소비자가 없다(dead surface 금지·리뷰 should-fix). */
export type GitRunner = (args: string[]) => { status: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string };

export function resolveDefaultBranchBase(repoRoot: string): string | null {
  const run = (...args: string[]) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  const exists = (candidate: string): boolean => run('rev-parse', '--verify', '--quiet', `${candidate}^{commit}`).status === 0;
  const remoteHead = run('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  const trackedHead = (remoteHead.stdout ?? '').trim().replace(/^refs\/remotes\//, '');
  if (trackedHead && exists(trackedHead)) return trackedHead;

  // A clone can lack refs/remotes/origin/HEAD even though the remote publishes its
  // default branch. Read that metadata before heuristics, but retain a local fallback
  // when the remote is unavailable.
  const remoteSymref = run('ls-remote', '--symref', 'origin', 'HEAD');
  const remoteDefault = (remoteSymref.stdout ?? '').match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1];
  if (remoteDefault) return `origin/${remoteDefault}`;

  for (const name of ['main', 'master', 'develop', 'trunk']) {
    for (const candidate of [`origin/${name}`, name]) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function syncBaseWithRemote(
  repoRoot: string,
  base: string,
  skip: boolean,
  runner?: GitRunner,
): { checkout: string; freshness: WorktreeBaseFreshness } {
  const git = runner
    ? (...args: string[]) => runner(args)
    : (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

  const remoteBranch = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  const wanted = `refs/heads/${remoteBranch}`;
  // ⛔ **이름이 hex 라고 SHA 가 아니다**(리뷰 must-fix ④) — `abc1234` 라는 **브랜치**가 있을 수 있다.
  //    로컬 heads 뿐 아니라 **remote-tracking ref** 까지 본다(둘 다 로컬 조회·네트워크 0).
  //    그래도 남는 모호함(원격에만 있는 hex 이름 브랜치)은 아래에서 ls-remote 결과로 최종 판정한다.
  const looksHex = /^[0-9a-f]{7,40}$/i.test(base);
  const isKnownLocalRef = git('show-ref', '--verify', '--quiet', wanted).status === 0
    || git('show-ref', '--verify', '--quiet', `refs/remotes/origin/${remoteBranch}`).status === 0;
  const isFullOid = /^[0-9a-f]{40}$/i.test(base);
  /** ref 로 알려진 바 없고 커밋으로 풀리면 그때만 SHA 다.
   *  `requireUnambiguous` = 원격을 못 물어본 상황(skip) — 그때는 **완전한 40자 oid** 만 SHA 로 친다.
   *  ⛔ 축약 hex 는 원격에만 있는 동명 브랜치일 수 있고 skip 이면 그것을 **알 방법이 없다**.
   *  모르는 것을 `sha` 라고 단언하지 않는다(리뷰 must-fix · 이 레포의 "모름을 값으로 바꾸지 않는다"). */
  const asSha = (requireUnambiguous: boolean): { checkout: string; freshness: WorktreeBaseFreshness } | null =>
    (!isKnownLocalRef && looksHex && (!requireUnambiguous || isFullOid)
      && git('rev-parse', '--verify', `${base}^{commit}`).status === 0)
      ? { checkout: base, freshness: 'sha' }
      : null;

  // ⭐ SHA 판정은 skip 보다 **앞**이다(리뷰 must-fix ③) — 명시 SHA 는 skip 여부와 무관하게 `sha` 다.
  //    ⚠️ 규칙은 skip 전용이 아니다(리뷰 should-fix): **원격에 물어보지 못한 모든 경우**
  //    (skip · ls-remote 실패)에 축약 hex 는 단언하지 않는다 — skip 이면 `local-only`,
  //    ls-remote 실패면 `remote-unreachable`. 둘 다 "모른다" 를 각자의 이유로 말한다.
  if (skip) return asSha(true) ?? { checkout: base, freshness: 'local-only' };

  // ⛔ `ls-remote --heads origin <base>` 는 **tail 매칭**이라 `feat` 가 `x/feat` 에도 걸린다
  //    (리뷰 must-fix ①). 정확한 ref 를 묻고, 응답도 **정확히 그 ref 인 줄만** 받는다.
  const ls = git('ls-remote', '--heads', 'origin', wanted);
  if (ls.status !== 0) {
    const sha = asSha(true);   // 원격을 못 물어봤다 — 축약 hex 는 단언하지 않는다
    if (sha) return sha;
    debug.log('git-fs.worktree', 'base.remote-unreachable', { base, err: (ls.stderr || '').trim().slice(0, 160) }, { level: 'warn' });
    return { checkout: base, freshness: 'remote-unreachable' };
  }
  const hasRemote = (ls.stdout || '').split('\n').some((line) => line.trim().split(/\s+/)[1] === wanted);
  // ⭐ 원격에 그 이름의 브랜치가 **있으면** hex 이름이어도 브랜치다 — SHA 로 새지 않는다.
  // 원격이 "그런 브랜치 없다" 고 답했다 ⇒ 축약 hex 여도 모호하지 않다.
  if (!hasRemote) return asSha(false) ?? { checkout: base, freshness: 'local-only' };

  // Only the no-runner fallback joins the shared retry seam; injected runners remain
  // an exact test/caller seam with their prior command count.
  const fetched = runner
    ? git('fetch', 'origin', wanted)
    : runGitCommand(repoRoot, ['fetch', 'origin', wanted], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (fetched.status !== 0) {
    // origin 에 있는 것을 확인했는데 못 가져왔다 ⇒ 낡은 로컬로 진행하면 조용히 틀린다.
    throw new Error(`git worktree base sync failed — origin/${remoteBranch} exists but fetch failed: status=${fetched.status}, signal=${fetched.signal ?? 'none'}, stdout=${JSON.stringify((fetched.stdout || '').trim().slice(0, 200))}, stderr=${JSON.stringify((fetched.stderr || '').trim().slice(0, 200))}`);
  }
  // ⭐ **가져온 것**에서 갈린다(리뷰 must-fix ②) — ls-remote 로 먼저 읽은 SHA 를 쓰면 그 사이 원격이
  //    전진했을 때 "원격 tip" 계약이 깨진다. FETCH_HEAD 가 방금 받은 tip 이다.
  const fetchedTip = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
  if (fetchedTip.status !== 0 || !(fetchedTip.stdout || '').trim()) {
    throw new Error(`git worktree base sync failed — fetched origin/${base} but FETCH_HEAD is unreadable`);
  }
  const remoteSha = fetchedTip.stdout.trim();
  const localRef = git('rev-parse', '--verify', `${base}^{commit}`);
  const localSha = localRef.status === 0 ? (localRef.stdout || '').trim() : '';
  if (localSha && localSha !== remoteSha) {
    debug.log('git-fs.worktree', 'base.stale-local', { base, localSha: localSha.slice(0, 9), remoteSha: remoteSha.slice(0, 9) }, { level: 'warn' });
  }
  return { checkout: remoteSha, freshness: 'remote-synced' };
}

/** Return the worktree that currently holds a branch named in git's add failure.
 *
 *  ⚠️ **줄 끝을 경계로 잡는다**(무인 리뷰 should-fix). git 의 문면은
 *  `fatal: '<브랜치>' is already used by worktree at '<경로>'` 이고 **경로가 줄 끝**이다.
 *  `[^']+` 로 잡으면 **경로에 작은따옴표가 있을 때 잘려** 엉뚱한 경로를 메시지·관측에 남긴다. */
function blockingWorktreePath(err: string): string | null {
  return err.match(/already used by worktree at '(.+)'\s*$/m)?.[1] ?? null;
}

/** Whether git rejected worktree creation because this repository has no initial commit. */
export function isUnbornHeadError(err: string): boolean {
  return /^fatal: invalid reference: HEAD\s*$/m.test(err);
}

/** ⭐⭐ 워크트리 «소유 표시» — **이 저장소의 기존 관례를 그대로 쓴다**(새 표시를 만들지 않는다).
 *
 *  쓰는 자리   `src/harness/harness-worktree-add.ts` 의 `recordHarnessWorktreeProvenance`
 *              (`extensions.worktreeConfig=true` 를 켜고 세 키를 **worktree 스코프**로 쓴다)
 *  읽는 자리   `src/harness/harness-worktrees.ts` 의 `readWorktreeProvenance`
 *  값의 유효성 `src/harness/harness-clean.ts` 의 `assessHarnessOwnership`(module-private)
 *
 *  ⛔ **왜 그 셋을 import 하지 않는가 — 순환 의존이다.** 세 모듈이 «전부» 이 파일을 import 한다
 *     (`harness-worktree-add.ts:2` · `harness-worktrees.ts:5` · `harness-clean.ts`). 여기서 그쪽을
 *     부르면 사이클이 생긴다. ⇒ **키와 판정 문면을 공유**하되 읽기는 여기서 한다.
 *     ⚠️ 그러므로 저쪽 grammar 가 바뀌면 **여기도 같이 바뀌어야 한다** — 이 주석이 그 계약이다. */
const WORKTREE_PROVENANCE_CONFIG_KEYS = ['elanous.harness.owner', 'elanous.harness.command', 'elanous.harness.createdAt'] as const;

/** The short values written by `prepareDevWorktree`; long values remain readable for existing worktrees. */
export type HarnessWorktreeCommand = 'dev' | 'drive';
const ELANOUS_HARNESS_WORKTREE_COMMANDS = [
  'dev',
  'drive',
  'harness worktree add',
  'elanous dev',
  'elanous enter_worktree',
  'elanous agent-mission',
] as const;

/** Canonical command ownership rule for harness worktree provenance. */
export function isElanousHarnessWorktreeCommand(command: string): boolean {
  return (ELANOUS_HARNESS_WORKTREE_COMMANDS as readonly string[]).includes(command);
}

/** `assessHarnessOwnership`(harness-clean.ts) 의 판정을 그대로 옮긴 것. 세 칸이 «모두» 이 저장소가
 *  쓰는 문면일 때만 「이 저장소의 것」이다 — 한 칸이라도 낯설면 남의 표시로 본다(fail-closed). */
function isElanousWorktreeProvenance(owner: string, command: string, createdAt: string): boolean {
  const ownerOk = owner === 'harness:unattributed' || /^(?:dev|agent):[^\s:]+$(?![\s\S])/.test(owner);
  const commandOk = isElanousHarnessWorktreeCommand(command);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) return false;
  const timestamp = Date.parse(createdAt);
  const createdAtOk = Number.isFinite(timestamp) && new Date(timestamp).toISOString() === createdAt;
  return ownerOk && commandOk && createdAtOk;
}

/** 재사용을 «거부»한 이유. ⛔ **부재·미지·거절을 같은 값으로 두지 않는다** — 조건마다 다른 값이다.
 *  - `reuse-not-requested`  호출자가 재사용을 요청하지 않았다(아무것도 조회하지 않는다)
 *  - `worktree-unavailable` 그 경로를 git 저장소로 못 읽었다(사라졌거나 깨졌다)
 *  - `repo-mismatch`        그 경로가 «이 저장소의» 체크아웃이 아니다
 *  - `branch-mismatch`      그 트리의 HEAD 가 재사용하려는 브랜치가 «아니다»(detach 포함)
 *  - `owner-not-recorded`   소유 표시가 «없다»(확장이 꺼졌거나 키가 비었다)
 *  - `owner-unreadable`     소유 표시를 «못 읽었다»(권한 등) — 없음과 다른 값이다
 *  - `owner-foreign`        표시가 있으나 이 저장소의 문면이 아니다
 *  - `dirty-unknown`        커밋 안 된 변경 유무를 «못 쟀다**
 *  - `worktree-dirty`       커밋되지 않은 변경이 있다 */
export type WorktreeReuseRefusal =
  | 'reuse-not-requested'
  | 'worktree-unavailable'
  | 'repo-mismatch'
  | 'branch-mismatch'
  | 'owner-not-recorded'
  | 'owner-unreadable'
  | 'owner-foreign'
  | 'dirty-unknown'
  | 'worktree-dirty';

export type WorktreeReuseGate =
  | { reuse: true; owner: string }
  | { reuse: false; reason: WorktreeReuseRefusal };

/** 재사용 «대상이 무엇이어야 하는가» — 게이트가 **자기 눈으로** 다시 확인할 정체성.
 *
 *  ⛔⭐⭐ 왜 필요한가(무인 리뷰 must-fix · `#8257`): 후보 경로는 `git worktree list` 라는
 *  **별개의 git 호출**이 준 스냅숏이다. 그 등록이 낡았을 수 있다 — 디렉터리가 지워졌다가
 *  «다른» 체크아웃으로 대체되면(그리고 그것이 마침 소유 표시를 갖고 깨끗하면) 게이트는 종전
 *  판정으로 통과시키고, 호출자는 ***요청한 브랜치가 아닌 트리를 받아 거기에 커밋한다.***
 *  ⇒ 소유·청결만 묻지 말고 **「이 저장소의 · 그 브랜치의」 트리인지**를 그 트리 안에서 다시 묻는다. */
export interface WorktreeReuseExpectation {
  /** 재사용하려는 브랜치 — 그 트리의 HEAD 가 **정확히** 이것이어야 한다. */
  branch: string;
  /** 이 저장소의 common git dir. `null` 이면 **판정 불가**라 거부한다(모름을 통과로 바꾸지 않는다). */
  commonGitDir: string | null;
}

/** 심링크 표기 차이(`/var` ↔ `/private/var`)로 같은 경로가 달라 보이는 것을 막는다.
 *  없는 경로는 `resolve` 값을 유지한다 — `worktreeRepoScope` 와 같은 규율. */
function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

/**
 * 그 브랜치를 이미 쥔 워크트리를 **그대로 재사용해도 되는가**를 판정한다(읽기 전용·상태 무접촉).
 *
 * ⛔⭐ 이것은 안전장치를 «푸는» 관문이므로 **넷을 모두 통과할 때만** 연다:
 *   ⑴ 호출자가 재사용을 «명시로» 요청했다  ⑵ 그 트리가 «이 저장소의 · 그 브랜치의» 것이다
 *   ⑶ 소유 표시가 «이 저장소의 것»이다      ⑷ 그 워크트리에 «커밋되지 않은 변경이 없다»
 *      — 단, 호출자가 준 `currentOwner` 가 기록된 owner 와 **정확히 같으면** ⑷ 를 건너뛴다.
 *        그 dirt 는 그 런 자신의 산출이다. 값을 못 받으면 종전대로 거부한다.
 * 하나라도 모르면 «거부**다 — 모름을 허용으로 바꾸지 않는다.
 *
 * `runner` 는 테스트용 seam(기본은 그 워크트리를 cwd 로 하는 실 git).
 */
export function gateWorktreeReuse(
  worktreePath: string,
  requested: boolean,
  expected: WorktreeReuseExpectation,
  runner?: GitRunner,
  currentOwner?: string,
): WorktreeReuseGate {
  // ⛔ 호출자의 의사가 «맨 앞**이다 — 요청이 없으면 git 을 한 번도 부르지 않는다.
  //    종전 호출자에게 조회 비용도 동작 변화도 생기지 않아야 한다(불변식).
  if (!requested) return { reuse: false, reason: 'reuse-not-requested' };
  const git: GitRunner = runner ?? ((args) => {
    const r = spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  });
  // 경로 존재 확인도 «같은 seam»으로 한다 — 주입된 러너와 실 파일시스템이 갈리지 않게.
  if (git(['rev-parse', '--show-toplevel']).status !== 0) return { reuse: false, reason: 'worktree-unavailable' };

  // ⭐ 정체성 — 후보 경로를 **믿지 않고** 그 트리 안에서 다시 묻는다(위 `WorktreeReuseExpectation` 참조).
  if (!expected.commonGitDir) return { reuse: false, reason: 'repo-mismatch' };
  const commonDir = git(['rev-parse', '--git-common-dir']);
  if (commonDir.status !== 0) return { reuse: false, reason: 'worktree-unavailable' };
  // `--git-common-dir` 은 «상대 경로**로 나올 수 있다(그 트리 기준). 절대화한 뒤 비교한다.
  const heldCommonDir = canonicalPath(resolve(worktreePath, commonDir.stdout.trim()));
  if (heldCommonDir !== canonicalPath(expected.commonGitDir)) return { reuse: false, reason: 'repo-mismatch' };
  const head = git(['symbolic-ref', '--quiet', 'HEAD']);
  // ⛔ detached(status 1) 도 «그 브랜치가 아니다** — 부재를 통과로 바꾸지 않는다.
  if (head.status !== 0 || head.stdout.trim() !== `refs/heads/${expected.branch}`) {
    return { reuse: false, reason: 'branch-mismatch' };
  }

  // 소유 — `readWorktreeProvenance` 와 같은 순서: 확장 상태를 «먼저** 묻는다(문구에 의존하지 않는다).
  const extension = git(['config', '--get', 'extensions.worktreeConfig']);
  if (extension.status !== 0 && extension.status !== 1) return { reuse: false, reason: 'owner-unreadable' };
  if (extension.stdout.trim() !== 'true') return { reuse: false, reason: 'owner-not-recorded' };
  const values: string[] = [];
  for (const key of WORKTREE_PROVENANCE_CONFIG_KEYS) {
    const read = git(['config', '--worktree', '--get', key]);
    if (read.status === 1) return { reuse: false, reason: 'owner-not-recorded' };
    if (read.status !== 0) return { reuse: false, reason: 'owner-unreadable' };
    const value = read.stdout.trim();
    if (!value) return { reuse: false, reason: 'owner-not-recorded' };
    values.push(value);
  }
  const [owner, command, createdAt] = values as [string, string, string];
  if (!isElanousWorktreeProvenance(owner, command, createdAt)) return { reuse: false, reason: 'owner-foreign' };

  // 더티 — 하니스와 «같은 자»를 쓴다(`harness-worktrees.ts` 의 `git status --porcelain`).
  //   ⛔ 실패를 clean 으로 접지 않는다: 못 쟀으면 못 쟀다고 말하고 거부한다.
  //   ⭐ 기록된 owner 가 호출자가 준 현재 런과 같으면 그 dirt 는 자기 산출이다 — 거부 사유로 쓰지 않는다.
  //      값을 못 받거나 다르면 종전대로 `worktree-dirty`. 이 파일은 전역/환경을 뒤져 추측하지 않는다.
  const status = git(['status', '--porcelain']);
  if (status.status !== 0) return { reuse: false, reason: 'dirty-unknown' };
  const sameOwner = typeof currentOwner === 'string' && currentOwner.trim() !== '' && currentOwner === owner;
  if (status.stdout.trim() !== '' && !sameOwner) return { reuse: false, reason: 'worktree-dirty' };
  return { reuse: true, owner };
}

function worktreeHoldingBranch(repoRoot: string, branch: string): string | null {
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (listed.status !== 0) return null;
  let path: string | null = null;
  for (const line of (listed.stdout ?? '').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (path && line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

export function createWorktree(opts: CreateWorktreeOpts): CreateWorktreeResult {
  const { repoRoot, branch, worktreeRoot } = opts;
  validateBranchName(branch);
  const branchHolder = worktreeHoldingBranch(repoRoot, branch);
  if (branchHolder) {
    // ⛔ 후보 경로는 `git worktree list` 스냅숏이다 — 게이트가 **그 트리 안에서** 정체성을 다시 잰다.
    const gate = gateWorktreeReuse(branchHolder, opts.reuseOwnedWorktree === true, {
      branch,
      commonGitDir: findGitDir(repoRoot)?.commonGitDir ?? null,
    }, undefined, opts.currentOwner);
    if (gate.reuse) {
      // ⭐ 재사용 — 트리를 **건드리지 않는다**(지우지도, 리셋하지도, base 를 다시 확정하지도 않는다).
      //   공통 의존성 링크만 idempotent 하게 다시 확인한다(없으면 걸고, 있으면 건너뛴다).
      debug.log('git-fs.worktree', 'add.branch-held-reused', { branch, worktreePath: branchHolder, owner: gate.owner }, { level: 'warn' });
      const reusedLinks = linkWorktreeDependencies(repoRoot, branchHolder);
      debug.log('git-fs.worktree', 'dependencies.linked', { branch, worktreePath: branchHolder, dependencyLinks: reusedLinks });
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: branchHolder, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
      const headSha = (head.stdout ?? '').trim();
      if (head.status !== 0 || headSha.length === 0) {
        const message = (head.stderr || head.stdout || '').trim() || `git exited ${head.status}`;
        throw new Error(`git worktree base resolution failed — ${message}`);
      }
      return { path: resolve(branchHolder), branch, base: opts.base ?? 'HEAD', resolvedBase: headSha, baseFreshness: 'reused', reused: true };
    }
    // ⛔ 거부 — **요청하지 않은 호출자에게는 종전 문면 그대로**다(불변식). 요청했는데 조건을 못 맞춘
    //   경우에만 이유를 문면에 덧붙인다. 관측에는 **두 경우 모두** 이유를 남긴다(수용 기준).
    debug.log('git-fs.worktree', 'add.branch-held', { attempt: 1, branch, blockingPath: branchHolder, reuseRefusal: gate.reason }, { level: 'warn' });
    const refusalSuffix = gate.reason === 'reuse-not-requested' ? '' : ` — reuse refused: ${gate.reason}`;
    throw new Error(`git worktree add failed — branch ${branch} is already used by worktree at ${branchHolder}${refusalSuffix}`);
  }
  const parent = worktreeParentDir(repoRoot, worktreeRoot);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const wtPath = join(parent, worktreeDirName(branch));
  if (existsSync(wtPath)) {
    if (!opts.resetExisting) throw new Error(`createWorktree: path already exists — ${wtPath}`);
    // ★ 고아 worktree 경로 정리(대표 2026-07-12) — 이전 세대가 dispose 없이 죽었거나
    //   수동 정리로 경로만 남은 경우. git 등록 해제(remove --force) + 실디렉토리 제거 + prune.
    spawnSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* fail-soft */ }
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
  }
  const requestedBase = opts.base ?? 'HEAD';
  const isDefaultBranchBase = requestedBase === DEFAULT_BRANCH_WORKTREE_BASE;
  const defaultBranchBase = isDefaultBranchBase ? resolveDefaultBranchBase(repoRoot) : null;
  // When Git cannot identify a default branch, preserve the old HEAD behavior rather
  // than rejecting the launch. Explicit bases never enter this fallback.
  const base = defaultBranchBase ?? (isDefaultBranchBase ? 'HEAD' : requestedBase);
  // ⭐ 낡은 로컬 base 차단(2026-07-29) — 원격에 그 브랜치가 있으면 **원격 tip 에서** 갈린다.
  //    `base`(결과 필드)는 요청한 **ref 이름** 그대로 두고, git 에는 확정된 커밋을 넘긴다.
  const { checkout: baseCheckout, freshness: baseFreshness } = defaultBranchBase || opts.base
    ? syncBaseWithRemote(repoRoot, base, opts.skipRemoteBaseSync === true)
    : { checkout: base, freshness: 'head' as WorktreeBaseFreshness };
  if (isDefaultBranchBase) {
    debug.log('git-fs.worktree', 'base.default-branch', {
      branch,
      base,
      callerBase: 'HEAD',
      defaultBranchResolved: defaultBranchBase !== null,
    });
  }
  debug.log('git-fs.worktree', 'base.resolved', { branch, base, freshness: baseFreshness, checkout: baseCheckout.slice(0, 40) });
  // ★ resetExisting → -B(존재 시 base 로 리셋·재실행 고아 브랜치 흡수), 기본 -b(존재 시 실패).
  const branchFlag = opts.resetExisting ? '-B' : '-b';
  // ★ 병렬 안전 재시도(2026-07-21) — 동시 worktree add 가 git 락에서 경쟁하면 즉시 실패 → 락/일시적
  //   에러면 백오프 재시도(패자가 승자의 락 해제를 기다렸다 성공). non-transient 는 재시도 없이 throw.
  const MAX_ATTEMPTS = 6;
  let res!: ReturnType<typeof spawnSync>;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = spawnSync(
      'git',
      ['worktree', 'add', branchFlag, branch, wtPath, baseCheckout],
      { cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    if (res.status === 0) break;
    const err = (res.stderr || res.stdout || '').toString();
    const blockingPath = blockingWorktreePath(err);
    if (blockingPath) {
      debug.log('git-fs.worktree', 'add.branch-held', { attempt, branch, blockingPath }, { level: 'warn' });
      throw new Error(`git worktree add failed — branch ${branch} is already used by worktree at ${blockingPath}`);
    }
    if (isUnbornHeadError(err)) {
      throw new Error('git worktree add failed — this repository has no commits yet; create the first commit with: git commit --allow-empty -m "Initial commit"');
    }
    if (!isTransientGitError(err) || attempt === MAX_ATTEMPTS) {
      throw new Error(`git worktree add failed — ${err.trim() || `git exited ${res.status}`}`);
    }
    debug.log('git-fs.worktree', 'add.retry', { attempt, branch, err: err.trim().slice(0, 120) });
    sleepSyncMs(80 * attempt);   // 선형 백오프(80·160·240…ms)
  }
  // ★ 공통 의존성 링크 — git worktree 는 untracked dependency directories를 공유하지 않는다.
  //   중앙 계획의 모든 위치를 symlink 해 worktree 가 즉시 실행 가능하게 한다(복사 아님·저비용·
  //   idempotent). fail-soft — 링크 실패해도 worktree 자체는 유효(caller 가 필요시 install).
  const dependencyLinks = linkWorktreeDependencies(repoRoot, wtPath);
  debug.log('git-fs.worktree', 'dependencies.linked', { branch, worktreePath: wtPath, dependencyLinks });
  const resolvedBase = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: wtPath,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  const resolvedSha = (resolvedBase.stdout ?? '').trim();
  // ⛔ status 만 보면 빈 출력이 강한 `resolvedBase: string` 계약으로 새어나간다(리뷰 should-fix).
  //    빈 SHA 는 "모름" 이고, 이 필드의 존재 이유가 바로 그것을 값으로 안 바꾸는 것이다.
  if (resolvedBase.status !== 0 || resolvedSha.length === 0) {
    const message = (resolvedBase.stderr || resolvedBase.stdout || '').trim() || `git exited ${resolvedBase.status}`;
    throw new Error(`git worktree base resolution failed — ${message}`);
  }
  return { path: resolve(wtPath), branch, base, resolvedBase: resolvedSha, baseFreshness };
}

/** Remove a worktree. When `force` is false, git refuses if the
 *  working copy is dirty — the caller surfaces that error. */
export function removeWorktree(repoRoot: string, wtPath: string, force = false): void {
  const gate = gateGitResidue(wtPath);
  if (!gate.allowed) {
    debug.log('harness.git-residue', 'worktree-remove-blocked', { repoRoot, worktreePath: wtPath, ...gate }, { level: 'warn' });
    // ⛔ **전용 타입으로 던진다**(무인 리뷰 must-fix 둘을 함께 닫는다):
    //   ⑴ 호출자가 *"잔여 때문에 막힌 것"* 과 *"그 밖의 정리 실패"* 를 가를 수 있어야 한다 —
    //      안 그러면 모든 정리 오류가 fail-open 에서 fail-closed 로 바뀌어 공유 동작이 넓게 변한다.
    //   ⑵ 멈춘 **이유와 관측**이 오류에 실려야 산출물까지 살아 남는다(수용 기준).
    throw new GitResidueBlockedError(gate.reason, gate.observation, wtPath);
  }
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath];
  const res = spawnSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').trim() || `git exited ${res.status}`;
    throw new Error(`git worktree remove failed — ${msg}`);
  }
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;  // null when detached
  sha: string;
  isLocked: boolean;
  isDetached: boolean;
  isMain: boolean;        // true for the primary (non-secondary) worktree
}

/** Parse `git worktree list --porcelain` into entries. Each record
 *  is separated by blank lines; keys are whitespace-delimited. */
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  const res = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
  });
  if (res.status !== 0) return [];
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  let isFirst = true;
  for (const raw of res.stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      if (cur.path) {
        out.push({
          path: cur.path!,
          branch: cur.branch ?? null,
          sha: cur.sha ?? '',
          isLocked: !!cur.isLocked,
          isDetached: !!cur.isDetached,
          isMain: isFirst,
        });
        isFirst = false;
        cur = {};
      }
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    switch (key) {
      case 'worktree': cur.path = value; break;
      case 'HEAD':     cur.sha = value; break;
      case 'branch':   cur.branch = value.replace(/^refs\/heads\//, ''); break;
      case 'detached': cur.isDetached = true; break;
      case 'locked':   cur.isLocked = true; break;
    }
  }
  if (cur.path) {
    out.push({
      path: cur.path!,
      branch: cur.branch ?? null,
      sha: cur.sha ?? '',
      isLocked: !!cur.isLocked,
      isDetached: !!cur.isDetached,
      isMain: isFirst,
    });
  }
  return out;
}

/** Branch names are relatively permissive (see `git check-ref-format`);
 *  we apply a conservative subset that keeps the filesystem-slug
 *  deterministic and rejects the obvious injection vectors. */
export function validateBranchName(name: string): void {
  if (!name) throw new Error('branch name is required');
  if (name.length > 128) throw new Error('branch name too long (>128 chars)');
  if (/\s/.test(name)) throw new Error('branch name must not contain whitespace');
  if (name.startsWith('-')) throw new Error('branch name must not start with "-"');
  if (name.includes('..') || name.includes('//')) {
    throw new Error('branch name must not contain ".." or "//"');
  }
  if (!/^[A-Za-z0-9._\-\/]+$/.test(name)) {
    throw new Error('branch name must be alphanumeric plus . _ - /');
  }
}

// ── Session persistence ────────────────────────────────────────────
//
// A elanous session that entered a worktree stores the "previous SWD"
// + the worktree path under ~/.elanous/worktrees/<sessionId>.json so
// ExitWorktree can restore the original cwd even across restarts.

export interface WorktreeSession {
  sessionId: string;
  worktreePath: string;
  branch: string;
  previousCwd: string;      // where SWD pointed before Enter
  previousRepoRoot: string; // main repo root (for list/remove ops)
  enteredAt: number;
}

/** HOME resolution. Prefer the env var so tests can override without
 *  Bun's cached os.homedir() getting in the way (same WD8 issue). */
function userHome(): string {
  return process.env.HOME || homedir() || '';
}

function worktreeSessionsDir(): string {
  return join(userHome(), '.elanous', 'worktrees');
}

function sessionFilePath(sessionId: string): string {
  const dir = worktreeSessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.json`);
}

export function saveWorktreeSession(s: WorktreeSession): void {
  writeFileSync(sessionFilePath(s.sessionId), JSON.stringify(s, null, 2), 'utf8');
}

export function loadWorktreeSession(sessionId: string): WorktreeSession | null {
  const p = sessionFilePath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.worktreePath === 'string') return parsed as WorktreeSession;
  } catch { /* fall through */ }
  return null;
}

export function clearWorktreeSession(sessionId: string): void {
  const p = sessionFilePath(sessionId);
  if (existsSync(p)) {
    try { rmSync(p); } catch { /* noop */ }
  }
}

// ── Stale cleanup (GT6) ───────────────────────────────────────────
//
// Each EnterWorktree writes `<pid>.json`. On normal exit the file
// is cleared by ExitWorktree. On crash / SIGKILL it stays forever —
// useless (the pid isn't ours anymore) but accumulating. At dashboard
// boot we scan the dir and drop files whose pid is no longer alive.
//
// Signal 0 is a kernel existence check — it doesn't actually deliver
// a signal. ESRCH = dead; EPERM = alive but owned by another user
// (still alive, still not ours to touch — we leave those alone).

/** True when the pid corresponds to a running process (regardless
 *  of ownership). False when the kernel says no such process. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;  // alive, foreign owner
    return false;                        // ESRCH or anything else
  }
}

export interface StaleCleanupResult {
  scanned: number;   // files examined
  removed: number;   // dead-pid files deleted
  kept: number;      // alive-pid + non-pid files left in place
}

/** Snapshot every persisted worktree-session entry under
 *  `~/.elanous/worktrees/`. Returns `[]` when the dir is missing or
 *  unreadable. Each session reflects what was on disk at call time
 *  — the caller typically cross-references against
 *  `listWorktrees(repoRoot)` to detect orphans. */
export function listWorktreeSessions(): WorktreeSession[] {
  const dir = worktreeSessionsDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return []; }
  const out: WorktreeSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -'.json'.length);
    const s = loadWorktreeSession(sessionId);
    if (s) out.push(s);
  }
  return out;
}

/** Scan `~/.elanous/worktrees/` and remove every `<pid>.json` whose
 *  pid is dead. Keeps files that:
 *    • don't match the `<pid>.json` pattern (forward-compat for any
 *      other session-id scheme a future phase adds)
 *    • belong to a running process (any owner)
 *  Returns counts for diagnostics / boot log. */
export function cleanupStaleWorktreeSessions(): StaleCleanupResult {
  const dir = worktreeSessionsDir();
  if (!existsSync(dir)) return { scanned: 0, removed: 0, kept: 0 };
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return { scanned: 0, removed: 0, kept: 0 }; }
  let scanned = 0;
  let removed = 0;
  let kept = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) { kept += 1; continue; }
    scanned += 1;
    const pidStr = name.slice(0, -'.json'.length);
    const pid = Number.parseInt(pidStr, 10);
    // Non-numeric session id (future scheme) → don't touch.
    if (!/^\d+$/.test(pidStr) || !Number.isFinite(pid) || pid <= 0) {
      kept += 1;
      continue;
    }
    if (isPidAlive(pid)) { kept += 1; continue; }
    try {
      rmSync(join(dir, name));
      removed += 1;
    } catch {
      // Filesystem refused the unlink (permission / race) — count
      // as kept so the caller's summary reflects reality.
      kept += 1;
    }
  }
  return { scanned, removed, kept };
}

/** Resolve the main repo root regardless of whether the caller is
 *  currently inside a secondary worktree. Needed so EnterWorktree
 *  from inside an existing worktree creates siblings of the MAIN
 *  repo, not siblings of the current worktree. */
export function resolveMainRepoRoot(cwd: string): string | null {
  const located = findGitDir(cwd);
  if (!located) return null;
  if (!located.isWorktree) return located.root;
  // commonGitDir is <main>/.git — strip the trailing /.git.
  const common = located.commonGitDir;
  if (common.endsWith('/.git')) return common.slice(0, -'/.git'.length);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(common),
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch {
    return located.root;
  }
}
