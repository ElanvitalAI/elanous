// dev-harness 정리(clean) — 하니스 런이 쌓은 disposable worktree(`.worktrees/dev-*`) + `dev/*` 브랜치를
// 안전하게 치운다(대표 2026-07-21 UX). ⚠️ **열린 PR 브랜치는 항상 보존**(force 제외). 제1원칙: 무엇을 왜
// 지웠나 관측(harness.clean).
//
// planHarnessClean = 순수 분류(테스트). execHarnessClean = git/gh IO + 실제 제거.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listPtyManifest, type PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { debug } from '../debug/log.js';
import { configuredWorktreeRoot } from '../user-config.js';
import { runGitWithRetry, type GitRunner } from '../git-fs/retry.js';
import { isElanousHarnessWorktreeCommand, worktreeDirName, worktreeParentDir } from '../git-fs/worktree.js';
import {
  assessWorktree,
  readWorktreeProvenance,
  type WorktreeAssessment,
  type WorktreeAssessmentInput,
  type WorktreeBranchContent,
} from './harness-worktrees.js';
import { WORKTREE_BRANCH_PREFIX } from './worktree-branch-prefix.js';

export type HarnessCleanMode = 'abandoned' | 'merged' | 'all';

export interface WorktreeEntry { path: string; branch: string; }
export interface CleanPlanItem { branch: string; path?: string; reason: string; }
export type OrphanWorktreeSafety = 'safe' | 'unsafe' | 'unknown';
export interface OrphanedWorktree {
  path: string;
  safety: OrphanWorktreeSafety;
}
/** `unavailable` 는 등록된 브랜치·워크트리 판정의 필수 조회 실패다.
 * 고아 스캔 전용 조회 실패는 `orphanScan` 에만 남기고 삭제 판정으로 전파하지 않는다. */
export interface HarnessCleanPlan {
  remove: CleanPlanItem[];
  preserve: CleanPlanItem[];
  orphanedWorktrees: string[];
  orphanedWorktreeSafety: OrphanedWorktree[];
  orphanScan: 'scanned' | 'unavailable' | 'not-requested';
  orphanScanFailure?: 'bare-common-dir' | 'directories' | 'registeredWorktrees';
  unavailable: boolean;
  queryStatus?: HarnessCleanQueryStatus;
  /** ⭐ 관측 — **이 실행이 무엇을 봤나**(2026-08-03 · 관측 우선 지시).
   *
   *  ⛔ 왜 필요한가: 사람 화면이 `remove.length === 0` 이면 *"정리 대상 없음"* 만 찍었다.
   *  그런데 실측(2026-08-03)에서 기본 `branchPrefix='dev/'` 에 걸리는 워크트리가 **0개**였고
   *  실제 워크트리는 `self-impl/` **156개**였다. ⇒ ***도구가 아무것도 안 보는데 화면은
   *  「깨끗하다」고 말했다.*** 「없다」와 「이 스코프가 안 본다」가 같은 문장이 된다.
   *  ⇒ 스코프를 산출에 실어 화면이 그것을 말하게 한다([[MANUAL-observation-methodology]] §6-11). */
  scope?: {
    /** 이 실행이 쓴 브랜치 prefix(기본 `dev/`). */
    branchPrefix: string;
    /** 그 prefix 에 걸린 **등록 워크트리** 수. */
    matchedWorktrees: number;
    /** 그 prefix 에 걸린 **브랜치** 수. */
    matchedBranches: number;
    /** ⭐ 이 저장소에 **등록된** 워크트리 총수(접두 무관).
     *
     *  ⛔ 왜 필요한가: 종전 스코프 줄은 **본 것만** 말했다. 실측(2026-08-05): `걸린 worktree 37`
     *  인데 등록은 **42** 였고, 그 차이에 있는 워크트리(`Agent` 툴·`harness worktree add` 가 만든
     *  것)는 기본 명령에 **존재조차 안 보였다**. 사람은 그 화면을 「잔재 없음」으로 읽는다.
     *
     *  ⛔ 열거가 실패하면 이 칸을 **비운다** — 「0」과 「못 셌음」을 같은 값으로 두지 않는다
     *  (실패 자체는 `queryStatus.registeredWorktrees` 와 화면의 「질의 실패」 줄이 이미 말한다).
     *  ⚠️ 이 수에서 `matchedWorktrees` 를 뺀 값은 **「잔재 수」가 아니라 「이 스코프가 안 본 수」**다.
     *  ⛔ primary worktree 는 **총수의 성질**이다(리뷰 `M2`) — 접두에 «걸릴» 수도 있으므로
     *     「안 본 수에 primary 가 들어 있다」로 말하면 거짓이 된다. 화면은 총수 쪽에 적는다. */
    registeredWorktrees?: number;
    /** ⭐ 그중 `branch` 가 **없는** 수(detached · bare). **어떤 `--prefix` 로도 못 본다**(리뷰 `M1`).
     *  ⛔ 이 수를 안 가르면 「`--prefix` 로 보라」가 그 대상에게 **갈 수 없는 길**이 된다.
     *  ⛔ 위 총수와 **같은 산출**에서 온다(`readWorktreeSnapshot` · 리뷰 `S1`). */
    branchlessWorktrees?: number;
    /** 그중 gitdir 이 사라져 porcelain `prunable` 로 표시된 등록 수. */
    prunableWorktrees?: number;
    /** Bare repositories have no main checkout; number of distinct harness parents inspected. */
    bareDirectoryParents?: number;
  };
  /** 조회별 소요 시간(밀리초). 키는 `queryStatus` 조회 칸과 같다. 못 잰 칸은 생략한다. */
  queryTimings?: HarnessCleanQueryTimings;
}
export interface HarnessCleanQueryStatus {
  worktrees: boolean;
  branches: boolean;
  pullRequests: boolean;
  /** PR 조회 실패 원인. 실패한 stdout은 판정에 쓰지 않는다. */
  pullRequestsFailure?: string;
  /** PR 조회는 성공했지만, 해당 상태의 결과가 상한에 닿아 완전하지 않을 수 있다. */
  pullRequestsTruncated?: { open: boolean; merged: boolean };
  directories?: boolean;
  directoriesFailure?: 'bare-common-dir' | 'directories';
  registeredWorktrees?: boolean;
  pullRequestsUnreadBranches?: number;
  /** Live-terminal working-directory lookup completed successfully. */
  activeDirectories?: boolean;
}

/** 조회 칸 이름 — `queryStatus` 의 boolean 칸과 같다. 새 어휘를 만들지 않는다. */
export const HARNESS_CLEAN_QUERY_TIMING_KEYS = [
  'worktrees',
  'branches',
  'pullRequests',
  'directories',
  'registeredWorktrees',
  'activeDirectories',
] as const;
export type HarnessCleanQueryTimingKey = (typeof HARNESS_CLEAN_QUERY_TIMING_KEYS)[number];
/** 조회별 소요 시간(밀리초). 못 잰 칸은 키 자체가 없다 — 0 으로 채우지 않는다. */
export type HarnessCleanQueryTimings = Partial<Record<HarnessCleanQueryTimingKey, number>>;
export interface HarnessCleanQuery<T> { ok: boolean; value: T; failure?: 'bare-common-dir' | 'directories'; }
export type ActiveDirectoryProvider = () => HarnessCleanQuery<string[]>;

/** A directory is active when it is the worktree root or a descendant, never a sibling sharing its prefix. */
export function isWorktreeInUse(worktreePath: string, activeDirectories: readonly string[]): boolean {
  const root = resolve(worktreePath);
  return activeDirectories.some((directory) => {
    const path = resolve(directory);
    const boundary = relative(root, path);
    return boundary === '' || (!isAbsolute(boundary) && boundary !== '..' && !boundary.startsWith(`..${sep}`));
  });
}

/** Shared-manifest live-use source: only live PTYs with a recorded working directory. */
export function listActiveTerminalDirectories(
  readManifest: () => readonly PtyManifestRow[] = listPtyManifest,
): HarnessCleanQuery<string[]> {
  try {
    return {
      ok: true,
      value: readManifest()
        .filter((terminal) => terminal.alive && terminal.workdir !== undefined && terminal.workdir !== '')
        .map((terminal) => terminal.workdir!),
    };
  } catch {
    return { ok: false, value: [] };
  }
}

type WorktreeAssessmentReader = (input: WorktreeAssessmentInput) => WorktreeAssessment;
type WorktreeProvenance = { owner: string; command: string; createdAt: string };
type WorktreeProvenanceReader = (path: string, run: GitRunner) => WorktreeProvenance;

type OwnershipAssessment = { status: string; recorded: boolean };

/** Writer records `new Date().toISOString()`; accept only that exact UTC serialization. */
function isRecordedCreatedAt(createdAt: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) return false;
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === createdAt;
}

function assessHarnessOwnership(provenance: WorktreeProvenance): OwnershipAssessment {
  const { owner, command, createdAt } = provenance;
  if ([owner, command, createdAt].some((value) => value.startsWith('read-error:'))) {
    return { status: `unavailable:owner=${owner};command=${command};createdAt=${createdAt}`, recorded: false };
  }
  if ([owner, command, createdAt].some((value) => value === 'not-recorded')) {
    return { status: `not-recorded:owner=${owner};command=${command};createdAt=${createdAt}`, recorded: false };
  }
  const ownerRecorded = owner === 'harness:unattributed' || /^(?:dev|agent):[^\s:]+$(?![\s\S])/.test(owner);
  const commandRecorded = isElanousHarnessWorktreeCommand(command);
  const createdAtRecorded = isRecordedCreatedAt(createdAt);
  if (!ownerRecorded || !commandRecorded || !createdAtRecorded) {
    return { status: `invalid:owner=${owner};command=${command};createdAt=${createdAt}`, recorded: false };
  }
  return { status: `recorded:owner=${owner};command=${command};createdAt=${createdAt}`, recorded: true };
}

/**
 * 순수 분류 — worktree/branch/PR 상태 → remove/preserve.
 * - 열린 PR 브랜치: force 아니면 **항상 보존**(안전).
 * - mode: `abandoned`(PR 이력 없음·escalated/방치) · `merged`(PR 머지됨) · `all`(열린 PR 외 전부).
 */
export function planHarnessClean(input: {
  worktrees: WorktreeEntry[];
  branches: string[];
  openPr: ReadonlySet<string>;
  mergedPr: ReadonlySet<string>;
  closedPr?: ReadonlySet<string>;
  mode: HarnessCleanMode;
  force?: boolean;
  queryStatus?: HarnessCleanQueryStatus;
  /** Active terminal working directories. Undefined is distinct from a successful empty list. */
  activeDirectories?: readonly string[];
  worktreeDirectories?: string[];
  registeredWorktreePaths?: readonly string[];
  pullRequestsUnread?: ReadonlySet<string>;
  orphanBranchQueryOk?: boolean;
  orphanBranches?: ReadonlySet<string>;
  orphanDirectoryEntries?: ReadonlyMap<string, readonly string[]>;
  /** branch → origin/main 에 없는 커밋 수. undefined 는 측정 실패다. */
  unmergedCommitCounts: ReadonlyMap<string, number | undefined>;
  /** worktree branch → 커밋되지 않은 변경 유무. undefined 는 측정 실패다. */
  uncommittedChanges: ReadonlyMap<string, boolean | undefined>;
  /** worktree branch → origin/main 대비 변경 파일 수. undefined 는 측정 실패다. */
  changedFileCounts?: ReadonlyMap<string, number | undefined>;
  branchContents?: ReadonlyMap<string, WorktreeBranchContent>;
  /** 사다리 판정 seam. 기본값은 canonical assessWorktree다. */
  assessWorktree?: WorktreeAssessmentReader;
  /** path → worktree-scoped harness provenance seam. 기본값은 canonical reader다. */
  readWorktreeProvenance?: WorktreeProvenanceReader;
  /** provenance reader가 쓰는 git runner. planner 단독 테스트에서는 반드시 명시한다. */
  run?: GitRunner;
  /** 조회별 소요 시간(밀리초). 키는 `queryStatus` 조회 칸과 같다. 못 잰 칸은 생략한다. */
  queryTimings?: HarnessCleanQueryTimings;
}): HarnessCleanPlan {
  const { worktrees, branches, openPr, mergedPr, closedPr = new Set<string>(), mode, force } = input;
  // TypeScript 계약은 필수지만, 경계를 우회한 런타임 호출도 미지로 정규화해 fail-closed 한다.
  const unmergedCommitCounts = input.unmergedCommitCounts ?? new Map<string, number | undefined>();
  const uncommittedChanges = input.uncommittedChanges ?? new Map<string, boolean | undefined>();
  const changedFileCounts = input.changedFileCounts ?? new Map<string, number | undefined>();
  const branchContents = input.branchContents ?? new Map<string, WorktreeBranchContent>();
  const assess = input.assessWorktree ?? assessWorktree;
  const provenanceReader = input.readWorktreeProvenance ?? readWorktreeProvenance;
  const run = input.run ?? defaultGitRunner;
  // ⛔⭐⭐⭐ 고아 판정은 **두 입력이 모두 있을 때만** 한다(리뷰 must-fix).
  //   `worktrees` 는 `branchPrefix` 로 **필터된** 목록이므로 등록 목록의 대용이 될 수 없다 —
  //   대용하면 다른 prefix·detached 로 **정상 등록된** worktree 가 고아로 오판된다.
  //   ⇒ 「등록 목록을 못 봤다」와 「등록이 없다」를 구분한다(이 파일의 `unavailable` 과 같은 규율).
  const orphanQueriesFailed = input.queryStatus?.directories === false
    || input.queryStatus?.registeredWorktrees === false;
  const orphanInputsComplete = input.worktreeDirectories !== undefined
    && input.registeredWorktreePaths !== undefined;
  const orphanScan = input.worktreeDirectories === undefined && input.registeredWorktreePaths === undefined && !orphanQueriesFailed
    ? 'not-requested' : orphanQueriesFailed || !orphanInputsComplete ? 'unavailable' : 'scanned';
  const orphanScanFailure = orphanScan !== 'unavailable' ? undefined
    : input.queryStatus?.directories === false || input.worktreeDirectories === undefined ? input.queryStatus?.directoriesFailure ?? 'directories'
    : 'registeredWorktrees';
  const registeredWorktreePaths = new Set(
    (input.registeredWorktreePaths ?? []).map((path) => resolve(path)),
  );
  const orphanedWorktrees = !orphanInputsComplete || orphanQueriesFailed
    ? []
    : [...input.worktreeDirectories!]
        .filter((path) => !registeredWorktreePaths.has(resolve(path)))
        .sort();   // ⭐ 파일시스템 순서에 계획이 흔들리지 않게(리뷰 should-fix)
  const orphanedWorktreeSafety = orphanedWorktrees.map((path) => ({
    path,
    safety: classifyOrphanWorktree(path, input),
  }));
  const wtByBranch = new Map(worktrees.map((w) => [w.branch, w.path]));
  const all = new Set<string>([...branches, ...worktrees.map((w) => w.branch)]);
  const remove: CleanPlanItem[] = [];
  const preserve: CleanPlanItem[] = [];
  // ⛔⭐⭐⭐ **「잘림」은 «전역 차단»이 아니라 «브랜치별 미지»다**(2026-08-12 `RUN-T24` 실측으로 고침).
  //   종전엔 PR 목록이 상한에 닿기만 하면 ***모든 브랜치***를 `query-failed` 로 보존했다.
  //   📏 그 결과 이 저장소에서 `harness clean` 이 ***530/530 을 preserve*** 하고
  //     `remove` 가 «항상 빈 배열»이었다 — 즉 ***도구가 구조적으로 죽어 있었다.***
  //     (머지 PR 이 8,000건이 넘는데 상한이 200 이라 «언제나» 잘린다)
  //   🎯 그런데 잘린 목록에서도 ***「찾은 브랜치」는 판정된 것***이다 — 그것까지 막을 이유가 없다.
  //     막아야 하는 것은 ***「못 찾았는데, 목록이 잘려서 «없다»고 말할 수 없는」*** 브랜치뿐이다.
  //   ⇒ 「0(없다)」과 「못 셌음」을 «다른 값»으로 둔다.
  //   ⚠️ 다만 «두 목록의 위험이 다르다» — 여기서 갈린다:
  //     `open` 잘림  ⇒ ***못 본 «열린 PR»***이 있을 수 있다. 그 브랜치를 지우면 «살아 있는 작업»을 파괴한다.
  //                    ⇒ 그래서 open 잘림은 «전역 차단»이 옳다(종전 계약 유지).
  //     `merged` 잘림 ⇒ 그 목록에서 «찾은» 브랜치는 ***머지된 것이 확실***하다. 막을 이유가 없다.
  //                    못 찾은 브랜치만 「모른다」다.
  const activeDirectoriesKnown = input.activeDirectories !== undefined && input.queryStatus?.activeDirectories !== false;
  const queryStatus: HarnessCleanQueryStatus = activeDirectoriesKnown
    ? (input.queryStatus ?? { worktrees: true, branches: true, pullRequests: true })
    : {
        worktrees: input.queryStatus?.worktrees ?? true,
        branches: input.queryStatus?.branches ?? true,
        pullRequests: input.queryStatus?.pullRequests ?? true,
        ...input.queryStatus,
        activeDirectories: false,
      };
  const openTruncated = queryStatus?.pullRequestsTruncated?.open === true;
  const mergedTruncated = queryStatus?.pullRequestsTruncated?.merged === true;
  const queryFailed = queryStatus !== undefined
    && (!queryStatus.worktrees
      || !queryStatus.branches
      || !queryStatus.pullRequests
      || openTruncated
      || queryStatus.activeDirectories === false);
  const failedQueryNames = queryStatus === undefined ? [] : [
    !queryStatus.worktrees ? 'worktrees' : undefined,
    !queryStatus.branches ? 'branches' : undefined,
    !queryStatus.pullRequests ? 'pullRequests' : undefined,
    openTruncated ? 'pullRequests-truncated-open' : undefined,
    queryStatus.activeDirectories === false ? 'activeDirectories' : undefined,
  ].filter((name): name is string => name !== undefined);
  const queryFailedReason = `query-failed:${failedQueryNames.join(',')}`;
  /** 잘린 목록에서 «못 찾은» 브랜치는 「PR 없음」이라 말할 수 없다 — 그 브랜치만 보존한다. */
  const truncatedUnknown = (branch: string): boolean =>
    mergedTruncated && !openPr.has(branch) && !mergedPr.has(branch) && !closedPr.has(branch);
  for (const branch of [...all].sort()) {
    const path = wtByBranch.get(branch);
    const base: CleanPlanItem = { branch, ...(path ? { path } : {}), reason: '' };
    if (path && input.activeDirectories !== undefined && isWorktreeInUse(path, input.activeDirectories)) {
      preserve.push({ ...base, reason: 'currently-in-use' });
      continue;
    }
    if (queryFailed) { preserve.push({ ...base, reason: queryFailedReason }); continue; }
    if (input.pullRequestsUnread?.has(branch)) {
      preserve.push({ ...base, reason: 'query-failed:pullRequests' });
      continue;
    }
    // ⛔ 이 브랜치를 «못 찾았고» 목록이 잘렸다 ⇒ 「PR 없음」이 아니라 「모른다」다. 보존한다.
    if (truncatedUnknown(branch)) {
      preserve.push({ ...base, reason: 'pullRequests-truncated:merged; branch-not-in-partial-list' });
      continue;
    }
    if (!path) {
      // PR 상태가 squash 병합을 포함해 병합 여부의 canonical 판정자다. Git 조상 검사는 squash 병합을
      // 놓치므로, 무워크트리 브랜치도 워크트리가 있는 갈래와 같은 `mergedPr`를 쓴다.
      const mergedNoWorktree = mergedPr.has(branch);
      if (openPr.has(branch) && !force) {
        preserve.push({
          ...base,
          reason: `assessment=${mergedNoWorktree ? 'reclaim-safe:merged-no-worktree' : 'unjudgeable:worktree-unavailable'}; ownership=not-recorded; open-pr`,
        });
        continue;
      }
      const branchOnlyReclaimable = mergedNoWorktree && (mode === 'merged' || mode === 'all');
      if (branchOnlyReclaimable) {
        remove.push({
          ...base,
          reason: 'merged; assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded; branch-only',
        });
        continue;
      }
      preserve.push({
        ...base,
        reason: mergedNoWorktree
          ? `assessment=reclaim-safe:merged-no-worktree; ownership=not-recorded${openPr.has(branch) ? '; open-pr' : '; not-in-mode'}`
          : 'assessment=unjudgeable:worktree-unavailable; ownership=not-recorded',
      });
      continue;
    }
    let assessment: WorktreeAssessment;
    try {
      assessment = assess({
        path,
        branch,
        pr: openPr.has(branch) && !force ? 'open' : mergedPr.has(branch) ? 'merged' : closedPr.has(branch) ? 'closed' : 'none',
        dirty: uncommittedChanges.get(branch),
        uniqueCommitCount: unmergedCommitCounts.get(branch),
        changedFileCount: changedFileCounts.get(branch),
        branchContent: branchContents.get(branch) ?? 'unavailable',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      preserve.push({ ...base, reason: `assessment=unavailable:${detail}; ownership=unmeasured` });
      continue;
    }
    let ownership: OwnershipAssessment;
    try {
      ownership = assessHarnessOwnership(provenanceReader(path, run));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      preserve.push({ ...base, reason: `assessment=${assessment.disposition}:${assessment.reason}; ownership=unavailable:${detail}` });
      continue;
    }
    const ladderReason = `assessment=${assessment.disposition}:${assessment.reason}`;
    if (assessment.disposition !== 'reclaim-safe' || !ownership.recorded) {
      preserve.push({ ...base, reason: `${ladderReason}; ownership=${ownership.status}` });
      continue;
    }
    if (openPr.has(branch) && !force) { preserve.push({ ...base, reason: `${ladderReason}; ownership=${ownership.status}; open-pr` }); continue; }
    const merged = mergedPr.has(branch);
    let hit: boolean;
    if (mode === 'all') hit = true;
    else if (mode === 'merged') hit = merged;
    else hit = !openPr.has(branch) && !merged;
    if (hit) remove.push({ ...base, reason: `${openPr.has(branch) ? 'force-open-pr' : merged ? 'merged' : 'abandoned'}; ${ladderReason}; ownership=${ownership.status}` });
    else preserve.push({ ...base, reason: `${ladderReason}; ownership=${ownership.status}; ${merged ? 'merged(not-in-mode)' : 'not-in-mode'}` });
  }
  // 필수 조회 실패는 unavailable, 고아 전용 조회 실패는 orphanScan 으로 별도 관측한다.
  const queryTimings = compactQueryTimings(input.queryTimings);
  return {
    remove,
    preserve,
    orphanedWorktrees,
    orphanedWorktreeSafety,
    orphanScan,
    ...(orphanScanFailure ? { orphanScanFailure } : {}),
    unavailable: queryFailed,
    ...(queryStatus ? { queryStatus } : {}),
    ...(queryTimings ? { queryTimings } : {}),
  };
}

/** 측정된 밀리초만 싣는다. 0 은 유효한 「빨랐다」이고, 못 잰 칸·비숫자는 키 자체가 없다. */
export function compactQueryTimings(timings?: HarnessCleanQueryTimings): HarnessCleanQueryTimings | undefined {
  if (!timings) return undefined;
  const compact: HarnessCleanQueryTimings = {};
  for (const key of HARNESS_CLEAN_QUERY_TIMING_KEYS) {
    const value = timings[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) compact[key] = value;
  }
  return Object.keys(compact).length ? compact : undefined;
}

export function slowestQueryTiming(
  timings?: HarnessCleanQueryTimings,
): { key: HarnessCleanQueryTimingKey; ms: number } | undefined {
  const compact = compactQueryTimings(timings);
  if (!compact) return undefined;
  let slowest: { key: HarnessCleanQueryTimingKey; ms: number } | undefined;
  for (const key of HARNESS_CLEAN_QUERY_TIMING_KEYS) {
    const ms = compact[key];
    if (ms === undefined) continue;
    if (!slowest || ms > slowest.ms) slowest = { key, ms };
  }
  return slowest;
}

function measureQueryMs<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: Math.round(performance.now() - started) };
}

function classifyOrphanWorktree(
  path: string,
  input: {
    orphanBranchQueryOk?: boolean;
    orphanBranches?: ReadonlySet<string>;
    orphanDirectoryEntries?: ReadonlyMap<string, readonly string[]>;
  },
): OrphanWorktreeSafety {
  if (input.orphanBranchQueryOk !== true || !input.orphanBranches || !input.orphanDirectoryEntries) return 'unknown';
  // ⛔⭐⭐⭐ 디렉터리 이름은 `worktreeDirName()` 이 브랜치를 **평탄화**한 것이다(`/` → `-`).
  //   그래서 `branch === name` 도 `branch.endsWith('/'+name)` 도 **절대 맞지 않는다**:
  //     브랜치 `dev/src-scratch-…`  →  디렉터리 `dev-src-scratch-…`
  //   ⇒ 같은 함수로 평탄화해서 비교해야 한다. 안 그러면 **브랜치가 살아 있는데 `safe` 로 떨어진다**
  //     (이 골의 불변식 *"대응 브랜치가 있으면 절대 safe 가 아니다"* 정면 위반 · 사후 리뷰가 잡음).
  const name = basename(path);
  //   ⊕ 원격 목록은 `origin/dev/x` 형태로 오므로 **원격 접두를 벗긴 이름도** 함께 본다
  //     (`worktreeDirName('origin/dev/x')` = `origin-dev-x` ≠ 실제 디렉터리 `dev-x`).
  //   ⛔ 다만 **아무 첫 세그먼트나 벗기면 안 된다**(리뷰 must-fix) — 로컬 `dev/x` 를 `x` 로 축약하면
  //     엉뚱한 디렉터리 `/wt/x` 가 `unsafe` 가 된다. **알려진 원격 접두만** 벗긴다.
  //   ⛔⚠️ **한계(정확히)**: 원격 이름을 `origin` 으로 **가정**한다. 다른 이름(`upstream` 등)을 쓰는
  //     저장소에서는 그 브랜치가 안 걸리고, 항목이 `log` 하나뿐이면 ***그대로 `safe` 가 된다***
  //     — 즉 **덜 지우는 방향이 아니다**(리뷰 should-fix 로 이 문장을 정정했다).
  //     ⇒ ⛔ **실제 삭제를 배선하기 전에 이 가정을 반드시 다시 본다**(원격 목록을 입력으로 받는 쪽).
  const REMOTE_PREFIX = /^origin\//;
  if ([...input.orphanBranches].some((branch) => {
    if (worktreeDirName(branch) === name) return true;
    return REMOTE_PREFIX.test(branch) && worktreeDirName(branch.replace(REMOTE_PREFIX, '')) === name;
  })) return 'unsafe';
  const entries = input.orphanDirectoryEntries.get(path);
  return entries?.length === 1 && entries[0] === 'log' ? 'safe' : 'unknown';
}

// ── IO (git/gh) ──────────────────────────────────────────────────────────
function git(args: string[], run: GitRunner = defaultGitRunner): { ok: boolean; out: string } {
  const r = runGitWithRetry(args, run);
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** 실행기 — 테스트가 stderr 오염을 결정론으로 재현할 수 있게 주입 가능하다(리뷰 must-fix).
 *  ⚠️ 종전 공개 계약을 유지한다 — 이 모듈에서 `GitRunner`·`GitRunResult` 를 import 하던 소비자가 있다. */
export type { GitRunner, GitRunResult } from '../git-fs/retry.js';

const defaultGitRunner: GitRunner = (args) => {
  // git-spawn-allow: This is the injected low-level runner consumed by direct runGitWithRetry callers; routing it through runGitCommand would recurse through the retry seam.
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** ⛔⭐ 구조화된 값을 읽을 때는 **stdout 만** 본다(리뷰 should-fix).
 *  `git()` 은 진단 메시지까지 보여 주려고 stdout⊕stderr 를 합치므로,
 *  성공한 명령이 경고를 쓰면 그 경고가 값에 섞인다(경로가 오염된다). */
export function gitStdout(args: string[], run: GitRunner = defaultGitRunner): { ok: boolean; value: string } {
  const r = runGitWithRetry(args, run);
  return { ok: r.status === 0, value: r.stdout.trim() };
}

/** ⭐ **한 번의** porcelain 스냅샷에서 「등록 총수」와 「detached 수」를 함께 센다.
 *
 *  ⛔⭐ 왜 한 번인가(리뷰 `S1`): 두 수를 **다른 실행**에서 얻으면 그 사이 워크트리가 늘거나 줄어
 *  「안 본 수」가 음수가 되고, 그러면 화면이 **조용히** 그 줄을 건너뛴다 — 이 파일이 닫으려는
 *  「0 과 못 셌음을 가른다」와 **같은 형태의 결손**이다.
 *
 *  ⛔⭐⭐ 왜 detached 를 가르나(리뷰 `M1`): `listHarnessWorktrees` 는 `branch ` 줄이 있어야 세므로
 *  ***detached 워크트리는 어떤 `--prefix` 에도 «원리상» 안 걸린다.*** 그것까지 묶어 「`--prefix` 로
 *  보라」고 안내하면 **갈 수 없는 길을 주는 것**이다(`[T]` 실측: 등록 160 · 브랜치 143 · detached 17).
 *
 *  ⚠️ 각 worktree 블록은 `branch ` 줄을 **최대 하나** 가지므로 `detached = worktree줄 - branch줄` 이다.
 *  ⛔ stdout 전용(`gitStdout`)을 쓴다 — stderr 가 섞이면 «수»가 조용히 늘어난다. */
export interface WorktreeSnapshot {
  /** `branchPrefix` 에 걸린 워크트리(= 종전 `listHarnessWorktrees` 결과). */
  entries: WorktreeEntry[];
  /** 등록된 워크트리 총수(접두 무관 · primary 포함). */
  registered: number;
  /** ⛔⭐ `branch` 줄이 **없는** 블록 수(detached · bare 등).
   *  ⚠️ 접두 매칭은 `branch` 줄이 있어야 하므로 ***이들은 어떤 `--prefix` 에도 «원리상» 안 걸린다.***
   *  ⛔ 「명시적 `detached` 만」 세면 `bare` 를 도달 가능으로 «오판»한다(무인 리뷰 5R). */
  branchless: number;
  /** porcelain 블록 안에 `prunable` 줄이 있는 끊어진 등록 수. */
  prunable: number;
}

/** ⭐ **하나의** porcelain 산출에서 「걸린 것 · 등록 총수 · detached」를 함께 뽑는 **순수** 파서.
 *  ⛔ 순수라서 러너 주입 없이 `bare`·`detached`·접두 매칭을 직접 물 수 있다(무인 리뷰 4R). */
export function parseWorktreeSnapshot(output: string, branchPrefix: string): WorktreeSnapshot {
  const entries: WorktreeEntry[] = [];
  let registered = 0;
  let branchful = 0;
  let prunable = 0;
  let path = '';
  let blockPrunable = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (path && blockPrunable) prunable += 1;
      path = line.slice('worktree '.length).trim();
      registered += 1;
      blockPrunable = false;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      blockPrunable = true;
    } else if (line.startsWith('branch ')) {
      branchful += 1;
      const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      if (branch.startsWith(branchPrefix) && path) entries.push({ path, branch });
    } else if (line === '' && path) {
      if (blockPrunable) prunable += 1;
      path = '';
    }
  }
  if (path && blockPrunable) prunable += 1;
  return { entries, registered, branchless: Math.max(0, registered - branchful), prunable };
}

/** ⭐ 위 파서를 **git 한 번**으로 채운다.
 *
 *  ⛔⭐ 왜 한 번인가(리뷰 `S1`): 걸린 수와 등록 총수를 **다른 실행**에서 얻으면 그 사이 워크트리가
 *  변해 「안 본 수」가 음수가 되고, 그러면 화면이 **조용히** 그 줄을 건너뛴다 — 이 파일이 닫으려는
 *  「0 과 못 셌음을 가른다」와 **같은 형태의 결손**이다.
 *
 *  ⛔⭐⭐ 왜 detached 를 가르나(리뷰 `M1`): 접두 매칭은 `branch` 줄이 있어야 하므로
 *  ***detached 워크트리는 어떤 `--prefix` 에도 «원리상» 안 걸린다.*** 그것까지 묶어 「`--prefix` 로
 *  보라」고 안내하면 **갈 수 없는 길**이다(`[T]` 실측: 등록 160 · 브랜치 143 · detached 17).
 *
 *  ⛔ stdout 전용(`gitStdout`) — stderr 가 섞이면 «수»가 조용히 는다. */
export function readWorktreeSnapshot(
  branchPrefix: string,
  run: GitRunner = defaultGitRunner,
): HarnessCleanQuery<WorktreeSnapshot> {
  const result = gitStdout(['worktree', 'list', '--porcelain'], run);
  if (!result.ok) return { ok: false, value: { entries: [], registered: 0, branchless: 0, prunable: 0 } };
  return { ok: true, value: parseWorktreeSnapshot(result.value, branchPrefix) };
}

export function parseRegisteredWorktreePaths(output: string): string[] {
  return output.split('\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record) => record.slice('worktree '.length))
    .filter(Boolean)
    .map((path) => resolve(path));
}

/** git worktree list --porcelain → prefix 브랜치 worktree. 실패는 빈 결과와 구별한다. */
export function listHarnessWorktrees(branchPrefix: string, run: GitRunner = defaultGitRunner): HarnessCleanQuery<WorktreeEntry[]> {
  const result = git(['worktree', 'list', '--porcelain'], run);
  if (!result.ok) return { ok: false, value: [] };
  const entries: WorktreeEntry[] = [];
  const out = result.out;
  let path = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) {
      const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      if (branch.startsWith(branchPrefix) && path) entries.push({ path, branch });
    }
  }
  return { ok: true, value: entries };
}

/** git branch --list prefix* → 브랜치명. 실패는 빈 결과와 구별한다. */
export function listHarnessBranches(branchPrefix: string, run: GitRunner = defaultGitRunner): HarnessCleanQuery<string[]> {
  const result = git(['branch', '--list', `${branchPrefix}*`, '--format=%(refname:short)'], run);
  return {
    ok: result.ok,
    value: result.ok ? result.out.split('\n').map((s) => s.trim()).filter(Boolean) : [],
  };
}

export function listAllHarnessBranches(run: GitRunner = defaultGitRunner): HarnessCleanQuery<string[]> {
  const result = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], run);
  return {
    ok: result.ok,
    value: result.ok ? result.out.split('\n').map((s) => s.trim()).filter(Boolean) : [],
  };
}

export function listDirectoryEntries(paths: readonly string[], expired: () => boolean = () => false): HarnessCleanQuery<Map<string, string[]>> {
  const entries = new Map<string, string[]>();
  try {
    for (const path of paths) {
      // Deadline between reads: an unfinished listing is a failed query (orphans stay unjudged), never partial «ok».
      if (expired()) return { ok: false, value: new Map() };
      entries.set(path, readdirSync(path).sort());
    }
    return { ok: true, value: entries };
  } catch {
    return { ok: false, value: new Map() };
  }
}

/** All registered worktree paths, including worktrees outside the clean prefix. */
export function listRegisteredWorktreePaths(run: GitRunner = defaultGitRunner): HarnessCleanQuery<string[]> {
  // ⛔⭐ 여기도 **stdout 전용**이다 — 이 출력은 그대로 **경로**가 되므로 stderr 한 줄이 섞이면
  //   존재하지 않는 경로가 등록 목록에 들어가고, 그 결과 진짜 worktree 가 고아로 오판된다.
  //   (리뷰는 `rev-parse` 만 지적했으나 뿌리가 같다.)
  const result = gitStdout(['worktree', 'list', '--porcelain', '-z'], run);
  return result.ok
    ? { ok: true, value: parseRegisteredWorktreePaths(result.value) }
    : { ok: false, value: [] };
}

/** Ownership marker written per harness worktree (`harness-worktree-add.ts` · `readWorktreeProvenance`). */
const HARNESS_OWNER_CONFIG_KEY = 'elanous.harness.owner';

/** Physical child directories of every relevant harness parent. Read-only; unknown stays distinct from empty. */
export function listHarnessWorktreeDirectories(
  repoRoot?: string,
  run: GitRunner = defaultGitRunner,
  worktreeRoot = configuredWorktreeRoot(),
): HarnessCleanQuery<string[]> & { scope?: { rootKind: 'main' | 'bare'; parents: number } } {
  let rootKind: 'main' | 'bare' = 'main';
  let missingRegistrations = 0;
  let roots: string[];
  if (repoRoot) {
    roots = [repoRoot];
  } else {
    // A linked checkout's top level is not the main root. The common directory identifies it.
    const common = gitStdout(['rev-parse', '--path-format=absolute', '--git-common-dir'], run);
    if (!common.ok || !common.value) return { ok: false, value: [], failure: 'directories' };
    if (basename(common.value) === '.git') {
      roots = [dirname(common.value)];
    } else {
      const bare = gitStdout([`--git-dir=${common.value}`, 'rev-parse', '--is-bare-repository'], run);
      if (!bare.ok || bare.value !== 'true') return { ok: false, value: [], failure: 'bare-common-dir' };
      rootKind = 'bare';
      const registered = listRegisteredWorktreePaths(run);
      if (!registered.ok) {
        // Already known to be bare: keep that scope observable even though nothing was read.
        debug.log('harness.clean', 'directories-scope', { rootKind, candidates: 0, parents: 0, entries: 0, ok: false, failedCode: 'worktree-list' });
        return { ok: false, value: [], failure: 'directories', scope: { rootKind, parents: 0 } };
      }
      // A registered checkout is excluded as a «harness child» only when git records harness
      // ownership on that worktree (`elanous.harness.owner`, written by harness-worktree-add) —
      // independent of whether its launching checkout is still registered (review r4).
      // Path shape alone never excludes (review r2–r3): a human checkout anywhere, or a child whose
      // marker is absent/unreadable, stays a candidate — its parent is normally ENOENT (adds
      // nothing), and an unreadable one fails closed. The `.worktrees` parent test below only
      // narrows which checkouts are worth a git call: every harness child sits directly under one.
      const markers = gitStdout(['config', '--get', 'extensions.worktreeConfig'], run);
      const markersPossible = markers.ok && markers.value === 'true';
      // 'unknown' = the marker could not be read (git exit ≠ 0/1): ownership is undecidable, so the
      // whole inventory is unknown — never fold it into «no marker» (review r5).
      const ownership = (path: string): 'harness' | 'not-harness' | 'unknown' => {
        if (!markersPossible || !basename(dirname(resolve(path))).endsWith('.worktrees')) return 'not-harness';
        const owner = runGitWithRetry(['-C', path, 'config', '--worktree', '--get', HARNESS_OWNER_CONFIG_KEY], run);
        if (owner.status === 0) return owner.stdout.trim() ? 'harness' : 'not-harness';
        return owner.status === 1 ? 'not-harness' : 'unknown';
      };
      roots = [];
      // A registration whose directory is already gone (porcelain `prunable`) is not a candidate:
      // there is nothing to read under it, and asking git for its marker fails (rc=128 «cannot
      // change to») — that must not turn into «ownership unreadable» for the whole inventory (review).
      let missing = 0;
      for (const path of registered.value) {
        if (resolve(path) === resolve(common.value)) continue;
        if (!existsSync(path)) { missing += 1; continue; }
        const kind = ownership(path);
        if (kind === 'unknown') {
          debug.log('harness.clean', 'directories-scope', { rootKind, candidates: 0, parents: 0, entries: 0, missing, ok: false, failedCode: 'ownership-unreadable' });
          return { ok: false, value: [], failure: 'directories', scope: { rootKind, parents: 0 } };
        }
        if (kind === 'not-harness') roots.push(path);
      }
      missingRegistrations = missing;
    }
  }
  const candidates = [...new Set(roots.map((root) => worktreeParentDir(root, worktreeRoot)))].sort();
  // `parents` = parents that exist and were actually read (ENOENT candidates are not «seen»).
  //   On failure it is how many were read before the failing one — the human line never claims
  //   more than was inspected (review r2 should-fix).
  let read = 0;
  const scopeOf = () => (rootKind === 'bare' ? { scope: { rootKind, parents: read } } : {});
  const entries = new Set<string>();
  for (const parent of candidates) {
    try {
      // A privileged test runner can read mode 000; it is still unreadable for its owner.
      if (rootKind === 'bare' && (statSync(parent).mode & 0o444) === 0) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) entries.add(join(parent, entry.name));
      }
      read += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      // Fail-closed, but not silent: the bare scope stays observable on the failure path.
      debug.log('harness.clean', 'directories-scope', {
        rootKind, candidates: candidates.length, parents: read, entries: entries.size, missing: missingRegistrations, ok: false, failedCode: code ?? 'unknown',
      });
      return { ok: false, value: [], failure: 'directories', ...scopeOf() };
    }
  }
  const value = [...entries].sort();
  debug.log('harness.clean', 'directories-scope', { rootKind, candidates: candidates.length, parents: read, entries: value.length, missing: missingRegistrations, ok: true });
  return { ok: true, value, ...scopeOf() };
}

export type HarnessPrBranches = {
  open: Set<string>;
  merged: Set<string>;
  truncated: { open: boolean; merged: boolean };
};

/** Legacy `gh pr list` parser contract: a full bounded response remains observably incomplete. */
const HARNESS_PR_LIST_LIMIT = 200;
const DEFAULT_GH_TIMEOUT_MS = 25_000;

function unavailablePrBranches(): HarnessCleanQuery<HarnessPrBranches> {
  return { ok: false, value: { open: new Set(), merged: new Set(), truncated: { open: false, merged: false } } };
}

/** `gh pr list` JSON을 신뢰 가능한 PR 브랜치 집합으로만 해석한다. */
export function parseHarnessPrBranches(stdout: string, state: 'open' | 'merged' | 'all' = 'all'): HarnessCleanQuery<HarnessPrBranches> {
  try {
    const prs: unknown = JSON.parse(stdout);
    if (!Array.isArray(prs)) return unavailablePrBranches();
    const open = new Set<string>();
    const merged = new Set<string>();
    for (const pr of prs) {
      if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) return unavailablePrBranches();
      const { headRefName, state } = pr as { headRefName?: unknown; state?: unknown };
      if (typeof headRefName !== 'string' || headRefName.trim().length === 0
        || (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')) return unavailablePrBranches();
      if (state === 'OPEN') open.add(headRefName);
      else if (state === 'MERGED') merged.add(headRefName);
    }
    return {
      ok: true,
      value: {
        open,
        merged,
        truncated: {
          open: state === 'open' && prs.length === HARNESS_PR_LIST_LIMIT,
          merged: state === 'merged' && prs.length === HARNESS_PR_LIST_LIMIT,
        },
      },
    };
  } catch {
    return unavailablePrBranches();
  }
}

/** ⭐ `gh` 실행기도 주입 가능하다(무인 리뷰 must-fix) — 이것이 없으면 배선 테스트가
 *  **실제 `gh` 조회 성공 여부에 의존**하고, 실패하면 `query-failed` 가 먼저 걸려
 *  새 보존 이유를 한 번도 안 재고 통과한다(「0을 「없다」로 읽는」 형태). */
export type GhRunner = (args: string[], options?: { timeoutMs?: number }) => { status: number | null; stdout: string; stderr?: string; error?: string; signal?: string | null };
type GhSpawnSync = typeof spawnSync;

export function createGhRunner(spawnGh: GhSpawnSync = spawnSync): GhRunner {
  return (args, options) => {
    const r = spawnGh('gh', args, { encoding: 'utf8', timeout: options?.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS, maxBuffer: Infinity });
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error?.message,
      signal: r.signal,
    };
  };
}

const defaultGhRunner: GhRunner = createGhRunner();

type HarnessPrQuery = Omit<HarnessCleanQuery<HarnessPrBranches>, 'failure'> & { failure?: string; unread?: Set<string> };

const HARNESS_PR_LOOKUP_BATCH_SIZE = 50;

type GraphqlPullRequest = { state?: unknown; mergedAt?: unknown };
// ⛔⭐ GraphQL 별칭은 필드 이름을 «대체»한다 — `b0: pullRequests(…)` 의 응답은
//   `data.repository.b0.nodes` 이고 `b0.pullRequests.nodes` 가 «아니다».
//   실측 2026-09-13: 중간 층을 하나 더 기대해 261/261 이 parse:invalid-pr-graphql 로 떨어졌다.
type GraphqlPullRequestResponse = { data?: { repository?: Record<string, { nodes?: GraphqlPullRequest[] }> } };

function unavailableHarnessPrQuery(failure?: string): HarnessPrQuery {
  return { ok: false, value: { open: new Set(), merged: new Set(), truncated: { open: false, merged: false } }, ...(failure ? { failure } : {}) };
}

function ghFailureReason(result: ReturnType<GhRunner>): string | undefined {
  if (result.error) return result.error;
  if (result.signal) return `signal:${result.signal}`;
  if (result.status !== 0) return `exit:${result.status ?? 'unknown'}${result.stderr?.trim() ? `:${result.stderr.trim()}` : ''}`;
  return undefined;
}

function graphqlString(value: string): string {
  return JSON.stringify(value);
}

function queryHarnessPrBatch(branches: readonly string[], repo: string | undefined, runGh: GhRunner): HarnessPrQuery {
  const ownerAndName = repo?.split('/');
  if (repo && (!ownerAndName || ownerAndName.length !== 2 || !ownerAndName[0] || !ownerAndName[1])) {
    return unavailableHarnessPrQuery(`invalid-repo:${repo}`);
  }
  const repository = repo
    ? `repository(owner: ${graphqlString(ownerAndName![0]!)}, name: ${graphqlString(ownerAndName![1]!)})`
    : 'repository(owner: $owner, name: $name)';
  const selections = branches.map((branch, index) =>
    `b${index}: pullRequests(headRefName: ${graphqlString(branch)}, first: 1, states: [OPEN, CLOSED, MERGED]) { nodes { state mergedAt } }`,
  ).join('\n');
  const query = `query HarnessCleanPrLookup${repo ? '' : '($owner: String!, $name: String!)'} { ${repository} { ${selections} } }`;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  if (!repo) args.push('-F', 'owner={owner}', '-F', 'name={repo}');
  const result = runGh(args);
  const failure = ghFailureReason(result);
  if (failure) return unavailableHarnessPrQuery(failure);

  let parsed: GraphqlPullRequestResponse;
  try {
    parsed = JSON.parse(result.stdout) as GraphqlPullRequestResponse;
  } catch {
    return unavailableHarnessPrQuery('parse:invalid-pr-graphql');
  }
  const fields = parsed.data?.repository;
  if (!fields || typeof fields !== 'object') return unavailableHarnessPrQuery('parse:invalid-pr-graphql');

  const open = new Set<string>();
  const merged = new Set<string>();
  for (let index = 0; index < branches.length; index += 1) {
    const nodes = fields[`b${index}`]?.nodes;
    if (!Array.isArray(nodes) || nodes.length > 1) return unavailableHarnessPrQuery('parse:invalid-pr-graphql');
    const pr = nodes[0];
    if (!pr) continue;
    if (pr.state === 'OPEN') open.add(branches[index]!);
    else if (pr.state === 'MERGED' || (pr.state === 'CLOSED' && typeof pr.mergedAt === 'string')) merged.add(branches[index]!);
    else if (pr.state !== 'CLOSED') return unavailableHarnessPrQuery('parse:invalid-pr-graphql');
  }
  return { ok: true, value: { open, merged, truncated: { open: false, merged: false } } };
}

/** Branch-targeted GraphQL lookup: requests grow with harness branch count, not repository PR history. */
export function harnessPrBranches(branches: readonly string[], repo?: string, runGh: GhRunner = defaultGhRunner): HarnessPrQuery {
  const open = new Set<string>();
  const merged = new Set<string>();
  const unread = new Set<string>();
  let successful = 0;
  let failure: string | undefined;
  for (let start = 0; start < branches.length; start += HARNESS_PR_LOOKUP_BATCH_SIZE) {
    const slice = branches.slice(start, start + HARNESS_PR_LOOKUP_BATCH_SIZE);
    const batch = queryHarnessPrBatch(slice, repo, runGh);
    if (!batch.ok) {
      for (const branch of slice) unread.add(branch);
      failure ??= batch.failure;
      continue;
    }
    successful++;
    for (const branch of batch.value.open) open.add(branch);
    for (const branch of batch.value.merged) merged.add(branch);
  }
  if (!successful && unread.size) return { ...unavailableHarnessPrQuery(failure), unread };
  return { ok: true, value: { open, merged, truncated: { open: false, merged: false } },
    ...(unread.size ? { unread, ...(failure ? { failure } : {}) } : {}) };
}

function parseCommitCount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) ? count : undefined;
}

/** `%(refname:short) %(ahead-behind:origin/main)` 한 줄 → ahead (= `origin/main..<branch>` 커밋 수).
 *  형식이 아니면 행을 버린다 — 호출 쪽이 그 브랜치를 「모른다」로 남긴다. */
function parseAheadBehindCounts(stdout: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const behindStr = parts[parts.length - 1]!;
    const aheadStr = parts[parts.length - 2]!;
    const branch = parts.slice(0, -2).join(' ');
    if (!branch || parseCommitCount(behindStr) === undefined) continue;
    const ahead = parseCommitCount(aheadStr);
    if (ahead === undefined) continue;
    counts.set(branch, ahead);
  }
  return counts;
}

const WORKTREE_LESS_AHEAD_BEHIND_ARGS = [
  'for-each-ref',
  '--format=%(refname:short) %(ahead-behind:origin/main)',
  'refs/heads',
] as const;

/** 워크트리 없는 브랜치의 미머지 커밋 수(= origin/main 대비 ahead)를 **한 번의** for-each-ref 로 잰다.
 *  배치 실패·행 부재·비숫자 → 그 브랜치 값은 `undefined`(모른다). 조용히 0 이 되지 않는다. */
function measureWorktreeLessUnmerged(
  branches: readonly string[],
  run: GitRunner,
): Map<string, number | undefined> {
  const counts = new Map<string, number | undefined>();
  if (branches.length === 0) return counts;
  const batched = gitStdout([...WORKTREE_LESS_AHEAD_BEHIND_ARGS], run);
  const aheadByBranch = batched.ok ? parseAheadBehindCounts(batched.value) : undefined;
  for (const branch of branches) {
    counts.set(branch, aheadByBranch?.get(branch));
  }
  return counts;
}

export function measureBranchSafety(
  worktrees: readonly WorktreeEntry[],
  branches: readonly string[],
  run: GitRunner = defaultGitRunner,
): {
  unmergedCommitCounts: Map<string, number | undefined>;
  uncommittedChanges: Map<string, boolean | undefined>;
  changedFileCounts: Map<string, number | undefined>;
  branchContents: Map<string, WorktreeBranchContent>;
} {
  const pathsByBranch = new Map(worktrees.map((worktree) => [worktree.branch, worktree.path]));
  const allBranches = new Set([...branches, ...pathsByBranch.keys()]);
  const unmergedCommitCounts = new Map<string, number | undefined>();
  const uncommittedChanges = new Map<string, boolean | undefined>();
  const changedFileCounts = new Map<string, number | undefined>();
  const branchContents = new Map<string, WorktreeBranchContent>();
  const worktreeLessBranches = [...allBranches].filter((branch) => !pathsByBranch.has(branch));
  const worktreeLessUnmerged = measureWorktreeLessUnmerged(worktreeLessBranches, run);
  for (const branch of worktreeLessBranches) {
    // ⛔⭐ 워크트리가 없다고 「못 잰다」가 아니다(무인 리뷰 must-fix · 2026-08-03).
    //   초판은 둘 다 `undefined` 로 고정해 **워크트리 없는 브랜치를 영영 못 지우게** 만들었다
    //   (실측: `unmerged-commits-unknown` 35건이 그 형태였다).
    //   ⇒ 미머지 커밋은 **브랜치 ref 로** 잴 수 있다. 워크트리가 없으면 작업 트리도 없으므로
    //     미커밋 변경은 **없다(`false`)** 가 사실이다 — 「모른다」가 아니다.
    // ⭐ 값은 `origin/main..<branch>` 와 같은 ahead 다. 프로세스만 for-each-ref 한 번으로 줄인다.
    unmergedCommitCounts.set(branch, worktreeLessUnmerged.get(branch));
    uncommittedChanges.set(branch, false);
    changedFileCounts.set(branch, undefined);
    // ⛔ 작업 트리가 없으면 내용 대조를 «칠 수 없다» — 「같다/다르다」가 아니라 「못 쟀다」다.
    branchContents.set(branch, 'unavailable');
  }
  for (const branch of allBranches) {
    const path = pathsByBranch.get(branch);
    if (!path) continue;
    const commits = gitStdout(['-C', path, 'rev-list', '--count', 'origin/main..HEAD'], run);
    unmergedCommitCounts.set(branch, commits.ok ? parseCommitCount(commits.value) : undefined);
    const changes = gitStdout(['-C', path, 'status', '--porcelain'], run);
    uncommittedChanges.set(branch, changes.ok ? changes.value !== '' : undefined);
    const files = gitStdout(['-C', path, 'diff', '--name-only', '-z', 'origin/main...HEAD'], run);
    changedFileCounts.set(branch, files.ok ? files.value.split('\0').filter(Boolean).length : undefined);
    // ⛔⭐ 위 두 값은 «squash merge 를 못 본다» — 원본 커밋이 main 의 조상이 안 되고 merge-base 도
    //   안 옮겨지므로, 내용이 완전히 착지한 worktree 도 계속 「산출 있음」으로 남는다.
    //   📏 2026-09-07 실측: 그렇게 붙들린 275건 중 25개를 열어 보니 ***23개(92%)***가
    //     바꾼 파일의 내용이 main 과 «완전히 같았다».
    // ⭐ 그래서 «내용»을 따로 묻는다. ⛔ 두 단계여야 한다 — 목록을 안 좁히고 통째로 비교하면
    //   base 가 그 뒤 얻은 변경까지 세어 늘 다르다고 나온다(실측: 좁히면 0, 안 좁히면 503).
    const changedFiles = files.ok ? files.value.split('\0').filter(Boolean) : null;
    // ⛔⭐ 바꾼 파일이 «0개»면 그것은 `already-contained` 가 «아니다» — ***담길 것이 애초에 없었다***.
    //   접으면 「한 일이 없다」와 「작업이 착지했다」가 같은 값이 되고, 그 둘은 처방이 다르다.
    //   ⇒ 값을 안 실어 기존 `no-pr-and-no-output` 판정이 그대로 답하게 둔다.
    if (changedFiles === null) branchContents.set(branch, 'unavailable');
    else if (changedFiles.length === 0) { /* 축이 답할 것이 없다 — 종전 판정에 맡긴다 */ }
    else {
      const drift = gitStdout(['-C', path, 'diff', '--name-only', '-z', 'origin/main', 'HEAD', '--', ...changedFiles], run);
      branchContents.set(branch, !drift.ok
        ? 'unavailable'
        : drift.value.split('\0').filter(Boolean).length === 0 ? 'already-contained' : 'differs');
    }
  }
  return {
    unmergedCommitCounts,
    uncommittedChanges,
    changedFileCounts,
    branchContents,
  };
}

export interface HarnessCleanResult {
  plan: HarnessCleanPlan;
  removed: CleanPlanItem[];
  failed: Array<{ branch: string; error: string }>;
  dryRun: boolean;
  deferred?: CleanPlanItem[];
  window?: { offset: number; size: number; total: number; unseenOutsideWindow: number };
  /** A caller deadline (`expired`) stopped at least one non-git read; the plan is a failed-query subset. */
  expired?: boolean;
}

/** 실 정리 — dryRun 이면 계획만. 열린 PR 은 force 아니면 보존. */
export function execHarnessClean(opts: {
  mode: HarnessCleanMode;
  dryRun?: boolean;
  force?: boolean;
  branchPrefix?: string;
  repo?: string;
  window?: { offset: number; size: number };
  /** Only planned items are eligible; remaining items are deferred, not deleted. */
  shouldRemove?: (item: CleanPlanItem, removed: number) => boolean;
  /** GC does not force-remove worktrees; existing CLI behavior remains the default. */
  forceWorktreeRemove?: boolean;
  /** ⭐ git 실행기 주입(테스트 전용 · 무인 리뷰 must-fix). 생략하면 실제 git 이다.
   *  ⛔ 왜 **조회까지** 받나: 측정만 주입하면 배선 테스트가 여전히 **로컬 저장소에 어떤 브랜치가
   *  있는지에 의존**한다. CI·detached checkout 에서는 스코프가 0이 되어 아무것도 못 잰다.
   *  ⇒ 조회와 측정을 **같은 실행기**로 몰아 배선을 환경 무관하게 결정적으로 만든다.
   *  (환경에 기대는 테스트가 조용히 통과하는 것 자체가 2026-08-03 이 저장소가 반복해 밟은
   *   「0을 「없다」로 읽는」 형태다.) */
  run?: GitRunner;
  /** ⭐ `gh` 실행기 주입(테스트 전용). 생략하면 실제 `gh` 다. */
  runGh?: GhRunner;
  assessWorktree?: WorktreeAssessmentReader;
  readWorktreeProvenance?: WorktreeProvenanceReader;
  /** Live-directory lookup seam. Defaults to the shared PTY manifest provider. */
  activeDirectoryProvider?: ActiveDirectoryProvider;
  /** Caller deadline (GC tick budget). Once true, the non-git reads below (worktree directory listing,
   *  live-directory provider, orphan directory entries) are not started and count as failed queries. */
  expired?: () => boolean;
}): HarnessCleanResult {
  let expiredHit = false;
  const pastDeadline = (): boolean => {
    if (opts.expired?.()) { expiredHit = true; return true; }
    return false;
  };
  const branchPrefix = opts.branchPrefix ?? WORKTREE_BRANCH_PREFIX;
  const run = opts.run ?? defaultGitRunner;
  // ⭐ git 한 번으로 「걸린 것 · 등록 총수 · detached」를 함께 얻는다(무인 리뷰 4R).
  //   ⛔ 종전엔 listHarnessWorktrees 와 스코프 조회가 «따로» 돌아 두 수의 스냅샷이 어긋날 수 있었다.
  const worktreesTimed = measureQueryMs(() => readWorktreeSnapshot(branchPrefix, run));
  const worktreeSnapshot = worktreesTimed.value;
  const worktrees: HarnessCleanQuery<WorktreeEntry[]> = { ok: worktreeSnapshot.ok, value: worktreeSnapshot.value.entries };
  const branchesTimed = measureQueryMs(() => listHarnessBranches(branchPrefix, run));
  const listedBranches = branchesTimed.value;
  const sorted = [...new Set([...listedBranches.value, ...worktrees.value.map((w) => w.branch)])].sort();
  const offset = opts.window ? Math.min(Math.max(0, opts.window.offset), sorted.length) : 0;
  const windowBranches = opts.window ? sorted.slice(offset, offset + Math.max(0, opts.window.size)) : sorted;
  const selected = new Set(windowBranches);
  const branches = { ...listedBranches, value: listedBranches.value.filter((branch) => selected.has(branch)) };
  const scopedWorktrees = worktrees.value.filter((worktree) => selected.has(worktree.branch));
  // Only branches in this window reach PR lookup and safety measurement.
  const pullRequestsTimed = measureQueryMs(() => harnessPrBranches(windowBranches, opts.repo, opts.runGh));
  const pullRequests = pullRequestsTimed.value;
  // execHarnessClean calls the directory query before planning orphans; for bare repositories
  // it counts each registered source checkout's harness parent, failing closed if any is unreadable.
  const directoriesTimed = measureQueryMs((): ReturnType<typeof listHarnessWorktreeDirectories> => pastDeadline()
    ? { ok: false, value: [], failure: 'directories' } : listHarnessWorktreeDirectories(undefined, run));
  const worktreeDirectories = directoriesTimed.value;
  const registeredTimed = measureQueryMs(() => listRegisteredWorktreePaths(run));
  const registeredWorktreePaths = registeredTimed.value;
  const activeTimed = measureQueryMs((): HarnessCleanQuery<string[]> => pastDeadline()
    ? { ok: false, value: [] } : (opts.activeDirectoryProvider ?? listActiveTerminalDirectories)());
  const activeDirectories = activeTimed.value;
  const orphanBranches = listAllHarnessBranches(run);
  const provisionalOrphans = worktreeDirectories.ok && registeredWorktreePaths.ok
    ? worktreeDirectories.value.filter((path) => !new Set(registeredWorktreePaths.value.map((registered) => resolve(registered))).has(resolve(path)))
    : [];
  const orphanDirectoryEntries = listDirectoryEntries(provisionalOrphans, pastDeadline);
  const branchSafety = measureBranchSafety(scopedWorktrees, branches.value, run);
  const queryStatus = {
    worktrees: worktrees.ok,
    branches: branches.ok,
    pullRequests: pullRequests.ok,
    ...(pullRequests.failure ? { pullRequestsFailure: pullRequests.failure } : {}),
    pullRequestsTruncated: pullRequests.value.truncated,
    pullRequestsUnreadBranches: pullRequests.unread?.size ?? 0,
    directories: worktreeDirectories.ok,
    ...(!worktreeDirectories.ok ? { directoriesFailure: worktreeDirectories.failure ?? 'directories' as const } : {}),
    registeredWorktrees: registeredWorktreePaths.ok,
    activeDirectories: activeDirectories.ok,
  };
  const plan = planHarnessClean({
    worktrees: scopedWorktrees,
    branches: branches.value,
    worktreeDirectories: worktreeDirectories.ok ? worktreeDirectories.value : undefined,
    registeredWorktreePaths: registeredWorktreePaths.ok ? registeredWorktreePaths.value : undefined,
    pullRequestsUnread: pullRequests.unread,
    activeDirectories: activeDirectories.value,
    orphanBranchQueryOk: orphanBranches.ok,
    orphanBranches: new Set(orphanBranches.value),
    orphanDirectoryEntries: orphanDirectoryEntries.ok ? orphanDirectoryEntries.value : undefined,
    openPr: pullRequests.value.open,
    mergedPr: pullRequests.value.merged,
    unmergedCommitCounts: branchSafety.unmergedCommitCounts,
    uncommittedChanges: branchSafety.uncommittedChanges,
    changedFileCounts: branchSafety.changedFileCounts,
    branchContents: branchSafety.branchContents,
    assessWorktree: opts.assessWorktree,
    readWorktreeProvenance: opts.readWorktreeProvenance,
    run,
    mode: opts.mode,
    queryStatus,
    queryTimings: {
      worktrees: worktreesTimed.ms,
      branches: branchesTimed.ms,
      pullRequests: pullRequestsTimed.ms,
      directories: directoriesTimed.ms,
      registeredWorktrees: registeredTimed.ms,
      activeDirectories: activeTimed.ms,
    },
    ...(opts.force ? { force: true } : {}),
  });
  const orphanSafety = Object.fromEntries((['safe', 'unsafe', 'unknown'] as const).map((safety) => [
    safety,
    plan.orphanedWorktreeSafety.filter((orphan) => orphan.safety === safety).length,
  ])) as Record<OrphanWorktreeSafety, number>;
  // ⭐ 스코프를 계획에 싣는다 — 화면이 「없다」와 「이 스코프가 안 본다」를 갈라 말할 수 있게(위 주석).
  plan.scope = {
    branchPrefix,
    matchedWorktrees: worktrees.value.length,
    matchedBranches: listedBranches.value.length,
    // ⛔ 실패면 «싣지 않는다» — 0 으로 접으면 「접두 밖이 없다」와 「못 셌다」가 같은 값이 된다.
    // ⭐ 두 수는 **한 스냅샷**에서 온다(리뷰 `S1`) — 따로 재면 그 사이 변동으로 「안 본 수」가 음수가 된다.
    ...(worktreeSnapshot.ok
      ? {
        registeredWorktrees: worktreeSnapshot.value.registered,
        branchlessWorktrees: worktreeSnapshot.value.branchless,
        prunableWorktrees: worktreeSnapshot.value.prunable,
      }
      : {}),
    ...(worktreeDirectories.scope?.rootKind === 'bare'
      ? { bareDirectoryParents: worktreeDirectories.scope.parents }
      : {}),
  };
  const preservedByReason = Object.fromEntries([...new Set(plan.preserve.map((item) => item.reason))]
    .map((reason) => [reason, plan.preserve.filter((item) => item.reason === reason).length]));
  debug.log('harness.clean', 'plan', {
    mode: opts.mode,
    dryRun: !!opts.dryRun,
    remove: plan.remove.length,
    preserve: plan.preserve.length,
    preservedByReason,
    orphanedWorktrees: plan.orphanedWorktrees.length,
    orphanScan: plan.orphanScan,
    pullRequestsUnreadBranches: queryStatus.pullRequestsUnreadBranches,
    safe: orphanSafety.safe,
    unsafe: orphanSafety.unsafe,
    unknown: orphanSafety.unknown,
    openPr: pullRequests.value.open.size,
    activeDirectories: activeDirectories.value.length,
    queryStatus,
    queryTimings: plan.queryTimings,
    unavailable: plan.unavailable,   // ⭐ 「지울 게 없었다」와 「못 셌다」를 관측에서도 가른다
    // ⭐ 스코프도 관측에 — 나중에 로그만 보고 "그때 무엇을 봤나" 를 잴 수 있어야 한다.
    branchPrefix,
    matchedWorktrees: plan.scope.matchedWorktrees,
    matchedBranches: plan.scope.matchedBranches,
    // ⛔ 없으면 «키가 없다» — 로그에서도 「접두 밖 0」과 「못 셌음」이 갈린다.
    ...(plan.scope.registeredWorktrees === undefined ? {} : { registeredWorktrees: plan.scope.registeredWorktrees }),
    ...(plan.scope.prunableWorktrees === undefined ? {} : { prunableWorktrees: plan.scope.prunableWorktrees }),
  });
  const window = opts.window ? { offset, size: windowBranches.length, total: sorted.length,
    unseenOutsideWindow: sorted.length - windowBranches.length } : undefined;
  if (opts.dryRun) return { plan, removed: [], failed: [], dryRun: true,
    ...(opts.shouldRemove ? { deferred: plan.remove } : {}), ...(window ? { window } : {}), ...(expiredHit ? { expired: true } : {}) };
  const removed: CleanPlanItem[] = [];
  const failed: Array<{ branch: string; error: string }> = [];
  const deferred: CleanPlanItem[] = [];
  for (const item of plan.remove) {
    if (opts.shouldRemove && !opts.shouldRemove(item, removed.length)) { deferred.push(item); continue; }
    let ok = true; let err = '';
    // Both lookup and deletion use the same injected git runner.
    if (item.path) { const r = git(['worktree', 'remove', ...(opts.forceWorktreeRemove === false ? [] : ['--force']), item.path], run); if (!r.ok) { ok = false; err = r.out.slice(0, 120); } }
    if (ok || opts.forceWorktreeRemove !== false) {
      const b = git(['branch', '-D', item.branch], run);
      if (!b.ok) { ok = false; err = err || b.out.slice(0, 120); }
    }
    if (ok) { removed.push(item); debug.log('harness.clean', 'removed', { branch: item.branch, reason: item.reason, hadWorktree: !!item.path }); }
    else { failed.push({ branch: item.branch, error: err }); debug.log('harness.clean', 'remove-fail', { branch: item.branch, error: err }, { level: 'error' }); }
  }
  return { plan, removed, failed, dryRun: false, ...(opts.shouldRemove ? { deferred } : {}), ...(window ? { window } : {}), ...(expiredHit ? { expired: true } : {}) };
}

/** 사람 화면 보존 목록 한도 — 이 수를 넘기면 보존 항목을 더 찍지 않고 생략 사실을 말한다.
 *  ⛔ 한도를 없애면 보존 수백 줄이 「전체가 이만큼」으로 읽힌다.
 *  ⛔ 제거 목록에는 적용하지 않는다 — dry-run 의 삭제 계획은 전부 보여야 한다. */
export const HARNESS_CLEAN_REPORT_LIST_LIMIT = 10;

/** ⭐⭐⭐ 사람 화면 조립 — **순수 함수**(2026-08-03 · 무인 리뷰 must-fix).
 *
 *  ⛔ 왜 `src/index.ts` 밖으로 뺐나: 이 화면이 이 PR 의 **본체**인데 CLI action 안에 있으면
 *  테스트가 못 닿는다 — *"`index.ts` 변경을 전부 지워도 테스트가 통과한다"* 는 지적 그대로다.
 *  ⇒ 관측을 고치는 PR 이 **관측을 못 재는 형태**로 남으면 안 된다.
 *
 *  ⭐ 이 함수가 지키는 것: ***아는 것을 숨기지 않는다.*** 스코프 · 고아 · 질의 실패는
 *  계획에 들어 있는데 종전 화면이 셋 다 안 말해서 「0건」이 「깨끗함」으로 읽혔다. */
export function renderHarnessCleanReport(
  res: HarnessCleanResult,
  mode: HarnessCleanMode,
): string[] {
  const L: string[] = [`\n━━ harness clean (mode=${mode}${res.dryRun ? ' · DRY-RUN' : ''}) ━━`];
  // ⭐ 무엇을 봤는지 **먼저** 말한다. 실측(2026-08-03): 기본 prefix `dev/` 는 0개를 보는데
  //   실제 워크트리는 `self-impl/` 156개였고, 화면은 그 사실 없이 "정리 대상 없음"만 찍었다.
  const scope = res.plan.scope;
  if (scope) {
    L.push(`스코프 prefix=${scope.branchPrefix} · 걸린 worktree ${scope.matchedWorktrees} · 브랜치 ${scope.matchedBranches}${scope.bareDirectoryParents === undefined ? '' : ` · bare 저장소 · 부모 ${scope.bareDirectoryParents} 곳을 봤다`}`);
    const registered = scope.registeredWorktrees;
    if (registered !== undefined) {
      L.push(`등록 워크트리 ${registered}(primary 포함)${(scope.prunableWorktrees ?? 0) > 0 ? ` · 끊어진 등록 ${scope.prunableWorktrees}` : ''}`);
    }
    // ⛔⭐ 두 경고는 **서로 다른 것**을 말하므로 `else` 로 묶지 않는다(무인 리뷰 must-fix · `#7146` 1R).
    //   0/0 은 「이 스코프가 아무것도 안 본다」이고, 아래는 「그 밖에 몇이 있는데 안 봤다」다.
    //   ***`else if` 로 두면 「0개를 보는데 등록은 42」라는 «가장 중요한» 경우에 수가 침묵한다.***
    //   ⇒ 각각 한 번씩 내고, 「길」은 둘의 공통이므로 **한 줄로 합쳐** 소음을 막는다.
    const zeroScope = scope.matchedWorktrees === 0 && scope.matchedBranches === 0;
    // ⛔ 두 수가 «어긋나면»(등록 < 걸린) 조용히 넘어가지 않는다 — 그것이 이 파일이 닫으려는 결손이다(리뷰 `S1`).
    const skewed = registered !== undefined && registered < scope.matchedWorktrees;
    const unseen = registered !== undefined && !skewed ? registered - scope.matchedWorktrees : undefined;
    // ⛔ branch 가 없는 것(detached·bare)은 «어떤 --prefix 로도» 못 본다 ⇒ 그 몫을 빼야
    //   --prefix 안내가 «갈 수 있는 길»이 된다(리뷰 `M1`·`5R`).
    const branchless = Math.min(scope.branchlessWorktrees ?? 0, unseen ?? 0);
    // ⛔ 끊어진 등록도 같은 규율로 «말한다». 다만 reachable 에서는 빼지 않는다 —
    //   branchless 와 겹칠 수 있는데 스냅샷이 그 교집합을 안 싣기 때문이다.
    const prunable = Math.min(scope.prunableWorktrees ?? 0, unseen ?? 0);
    const reachable = unseen === undefined ? undefined : unseen - branchless;
    if (zeroScope) {
      L.push('⚠️ 이 prefix 에 걸린 것이 0개다 — 「깨끗함」이 아니라 「이 스코프가 아무것도 안 본다」일 수 있다.');
    }
    if (skewed) {
      L.push(`⚠️ 스코프 수가 어긋난다(등록 ${registered} < 걸린 ${scope.matchedWorktrees}) — 「안 본 수」를 «못 셌다»(0 이 아니다).`);
    }
    // ⭐ 「본 것」만 말하면 접두 밖 워크트리가 조용히 사라진다(실측 2026-08-05: 걸린 37 · 등록 42).
    //   ⛔ primary 는 «총수»의 성질로 적는다 — 접두에 걸릴 수도 있어 「안 본 수에 있다」는 거짓이 된다(리뷰 `M2`).
    if (unseen !== undefined && unseen > 0) {
      L.push(`⚠️ 등록 워크트리 ${registered}(primary 포함) 중 ${unseen} 은 이 prefix 「밖」이라 이 실행이 안 봤다.`);
    }
    if (branchless > 0) {
      L.push(`   그중 ${branchless} 은 branch 가 없어(detached·bare) 「어떤 --prefix 로도」 이 명령이 못 본다 — elanous harness worktrees 로 본다.`);
    }
    if (prunable > 0) {
      L.push(`   그중 ${prunable} 은 gitdir 이 사라져(끊어진 등록) 「어떤 --prefix 로도」 이 명령이 못 본다 — git worktree prune 으로 걷는다.`);
    }
    if (branchless > 0 && prunable > 0) {
      L.push(`   ⚠️ 위 두 수(branch 없음 ${branchless} · 끊어진 등록 ${prunable})의 «겹침»은 이 스냅샷이 안 싣는다 — 합쳐서 빼지 마라.`);
    }
    // ⛔ 원인만 주지 않고 **길을 같이** 준다 — 다만 «갈 수 있을 때만» 준다(불가능한 길은 금지보다 비싸다).
    // ⛔⭐ `zeroScope` 가지도 예외가 아니다(무인 리뷰 3R) — matched 0 인데 등록이 «전부 detached» 면
    //   어떤 prefix 로도 못 보므로 그 안내는 여전히 «갈 수 없는 길»이다.
    //   ⚠️ 못 쟀을 때(`reachable === undefined`)는 종전 안내가 그대로 최선이다.
    const reachableHint = reachable === undefined ? zeroScope : reachable > 0;
    if (reachableHint) {
      L.push('   그것들을 보려면: elanous harness clean --prefix <p>   (예: --prefix self-impl/ · 브랜치명은 elanous harness worktrees)');
    }
  }
  // ⛔ 질의가 하나라도 실패했으면 계획은 **부분집합**이다 — 조용히 「없다」로 읽히지 않게 한다.
  const failedQueries = Object.entries(res.plan.queryStatus ?? {})
    .filter(([, ok]) => typeof ok === 'boolean' && !ok)
    .map(([key]) => key);
  if (failedQueries.length) {
    L.push(`⚠️ 질의 실패: ${failedQueries.join(', ')} — 아래 계획은 부분집합이다(못 센 것이 있다).`);
  }
  if (res.plan.queryStatus?.pullRequestsFailure) {
    L.push(`   PR 조회 실패 원인: ${res.plan.queryStatus.pullRequestsFailure}`);
  }
  const truncatedPrQueries = Object.entries(res.plan.queryStatus?.pullRequestsTruncated ?? {})
    .filter(([, truncated]) => truncated)
    .map(([state]) => state);
  if (truncatedPrQueries.length) {
    L.push(`⚠️ PR 조회 상한 도달 가능: ${truncatedPrQueries.join(', ')} — 아래 계획은 부분집합이다(전부 못 셌을 수 있다).`);
  }
  const slowest = slowestQueryTiming(res.plan.queryTimings);
  if (slowest) L.push(`가장 오래 걸린 조회: ${slowest.key} (${slowest.ms}ms)`);
  const preserveLabels: Record<string, string> = {
    'open-pr': '열린 PR',
    'unmerged-commits': 'main 에 없는 커밋',
    'unmerged-commits-unknown': 'main 에 없는 커밋 측정 실패',
    'uncommitted-changes': '커밋되지 않은 변경',
    'uncommitted-changes-unknown': '커밋되지 않은 변경 측정 실패',
    'query-failed': '기존 질의 실패',
    'currently-in-use': '현재 사용 중',
  };
  const preserveGroups = new Map<string, CleanPlanItem[]>();
  for (const item of res.plan.preserve) preserveGroups.set(item.reason, [...(preserveGroups.get(item.reason) ?? []), item]);
  const preserveSections: Array<{ reason: string; items: CleanPlanItem[]; shown: CleanPlanItem[] }> = [];
  {
    let remaining = HARNESS_CLEAN_REPORT_LIST_LIMIT;
    for (const [reason, items] of preserveGroups) {
      const shown = items.slice(0, remaining);
      remaining = Math.max(0, remaining - shown.length);
      preserveSections.push({ reason, items, shown });
    }
  }
  const listedPreserveCount = preserveSections.reduce((n, section) => n + section.shown.length, 0);
  const omittedPreserve = res.plan.preserve.length - listedPreserveCount;
  const matchedTotal = res.plan.remove.length + res.plan.preserve.length;
  const displayedCount = res.plan.remove.length + listedPreserveCount;
  const mergedNoWorktreeCount = res.plan.preserve.filter((item) =>
    item.reason.includes('reclaim-safe:merged-no-worktree'),
  ).length;
  const branchOnlyReclaimedCount = res.plan.remove.filter((item) => item.reason.includes('branch-only')).length;
  L.push(
    omittedPreserve > 0
      ? `규모 매칭 ${matchedTotal} · 제거 계획 ${res.plan.remove.length} · 보존 ${res.plan.preserve.length} · 화면 ${displayedCount} (보존 ${omittedPreserve}개는 생략) · 브랜치만 회수 ${branchOnlyReclaimedCount} · 워크트리 없이 안전 ${mergedNoWorktreeCount}`
      : `규모 매칭 ${matchedTotal} · 제거 계획 ${res.plan.remove.length} · 보존 ${res.plan.preserve.length} · 화면 ${displayedCount} · 브랜치만 회수 ${branchOnlyReclaimedCount} · 워크트리 없이 안전 ${mergedNoWorktreeCount}`,
  );
  if (res.plan.remove.length === 0) L.push('정리 대상 없음.');
  else {
    L.push(res.dryRun ? `🧹 정리 예정 ${res.plan.remove.length}:` : `🧹 정리됨 ${res.removed.length}/${res.plan.remove.length}:`);
    for (const it of res.plan.remove) L.push(`  - ${it.branch}  (${it.reason}${it.path ? '·worktree' : ''})`);
  }
  for (const section of preserveSections) {
    const preserveLabel = section.reason.startsWith('query-failed:')
      ? `기존 질의 실패 (${section.reason.slice('query-failed:'.length)})`
      : (preserveLabels[section.reason] ?? section.reason);
    L.push(`🔒 보존(${preserveLabel}) ${section.items.length}:`);
    for (const item of section.shown) L.push(`  - ${item.branch}`);
  }
  if (omittedPreserve > 0) L.push(`  … 보존 ${omittedPreserve}개는 생략`);
  // ⭐ 고아는 **판정만 하고 지우지 않는다**(I-T3 ⓐ). 종전 화면은 그것을 아예 안 말해서
  //   JSON 은 4개를 아는데 사람은 "정리 대상 없음"만 봤다.
  if (res.plan.orphanedWorktrees.length) {
    const by: Record<string, number> = { safe: 0, unsafe: 0, unknown: 0 };
    for (const o of res.plan.orphanedWorktreeSafety) by[o.safety] = (by[o.safety] ?? 0) + 1;
    L.push(`🕳️ 고아 worktree ${res.plan.orphanedWorktrees.length} (등록 없는 디렉토리) — safe ${by.safe} · unknown ${by.unknown} · unsafe ${by.unsafe}`);
    for (const o of res.plan.orphanedWorktreeSafety) L.push(`  - [${o.safety}] ${o.path}`);
    L.push('   ⚠️ 이 명령은 고아를 지우지 않는다(판정만). 지우려면 확인 후 직접 제거한다.');
  }
  if (res.failed.length) { L.push(`⚠️ 실패 ${res.failed.length}:`); for (const f of res.failed) L.push(`  - ${f.branch}: ${f.error}`); }
  if (res.dryRun && res.plan.remove.length) L.push('\n실제 제거하려면 --yes 추가.');
  return L;
}
