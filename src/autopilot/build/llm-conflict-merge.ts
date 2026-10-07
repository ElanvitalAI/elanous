// ★ LLM 지능형 충돌 해결(대표 2026-07-21) — 브랜치 업데이트 능동 대응. 구조정합(se 스택 worktree 에
//   호출자가 해석해 전달한 기본 브랜치 ref 반영) 시 walker 자체 산출물과 머지된 PR 이 같은 파일을 수정해 충돌하면, 기계적 전략
//   (-X theirs=산출물 버림 / abort=미반영)이 아니라 **LLM 이 충돌 블록(ours=walker·theirs=전달된 정합 대상)을
//   읽고 양쪽 의도를 종합**해 해결한다(일반 LLM 이 당연히 하는 merge conflict resolution). 이 지능 계층이
//   자동 정합에 빠져 있던 근본(라이브 705308 conflict-abort 반복). git·LLM 은 seam 주입(순수 로직 테스트).

import { tierModel } from '../../llm/model-defaults.js';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { runGitCommand } from '../../git-fs/runner.js';
import { countTestDeclarations } from '../../self-implement/test-declarations.js';
import { NEXT_MD_PATH, resolveNextMdConflict } from '../../release-loop/next-md-merge.js';
import { getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { collectMergeIntent, defaultIntentGit, type IntentGit } from './merge-intent.js';

function deterministicNextMd(git: MergeGitSeam, worktreePath: string, file: string): string | null {
  try {
    const resolved = resolveNextMdConflict(git.readIndexStage(worktreePath, 1, file), git.readIndexStage(worktreePath, 2, file), git.readIndexStage(worktreePath, 3, file));
    void import('../../debug/log.js').then(({ debug }) => debug.log('self-dev.merge', 'next-md-deterministic', { resolved: resolved !== null })).catch(() => {});
    return resolved;
  } catch {
    return null; // a stage is missing (added/deleted on one side) — the usual resolver decides
  }
}

/** 충돌 마커가 남아있나(LLM 이 해결 못 함 판별). ours/base/theirs 3-way 마커 모두. 순수. */
export function hasConflictMarkers(s: string): boolean {
  return /^<{7} |^={7}$|^>{7} |^\|{7} /m.test(s);
}

/**
 * ⛔⭐⭐ **하위호환 기본 — 대상을 «안 준» 호출자에게 주는 값.**
 *
 * 🔑 왜 있나 — 이 모듈은 호출자들이 **동적 import** 로 가져간다. 그래서 정적 import 와 달리
 *   ***한 프로세스 안에 「옛 호출자 + 새 피호출자」가 공존한다***:
 *   런을 띄운 부모는 자기 코드를 «기동 시점»에 메모리에 들고, 이 모듈은 «호출 시점»에 디스크에서 읽는다.
 *   ⇒ 착지가 인자 계약을 바꾸면, ***이미 도는 남의 런이 몇십 분 뒤 그 경로에 닿을 때 죽는다.***
 *   📏 2026-08-21 실물 1건: 리뷰까지 pass 한 런이 «정합 직전»에 `undefined.indexOf` 로 죽었다.
 *
 * ⛔ 그래서 「인자가 없으면 실패」가 아니라 ***「인자가 없으면 이 층의 «옛» 동작」***으로 간다.
 *   이 값은 이 파일이 인자를 받기 «전»에 박아 두었던 바로 그 이름이다.
 * ⚠️ 잔재다 — 도는 런이 다 걷히면 지워도 된다. 다만 지울 땐 «같은 함정»을 다시 밟지 않게 이 주석을 읽어라.
 */
export const LEGACY_MERGE_TARGET = 'origin/main';

/** LLM 충돌해결 전후 규모 변화. before/after 는 충돌해결기에 들어간 파일과 해결본의 줄 수다. */
export interface LlmMergeSizeChange {
  files: Array<{ file: string; beforeLines: number; afterLines: number; deltaLines: number }>;
  totalBeforeLines: number;
  totalAfterLines: number;
  totalDeltaLines: number;
}

/** `status: 'error'` 가 난 단계. 순서·판정은 그대로고, 어느 자리에서 멎었는지만 가른다. */
export type LlmMergeErrorStep = 'fetch' | 'merge' | 'conflicted-files' | 'commit';

/** git stderr 첫 줄을 관측에 실을 때 쓰는 길이 상한. 구현이 정한다. */
export const GIT_ERROR_DETAIL_MAX_CHARS = 240;

/** merge 결과. llm-resolved=충돌을 LLM 이 종합 해결·커밋. conflict-unresolved=LLM 도 못 풀어 abort(base 유지). */
export interface LlmMergeOutcome {
  status: 'merged' | 'up-to-date' | 'llm-resolved' | 'conflict-unresolved' | 'error';
  resolvedFiles?: string[];
  sizeChange?: LlmMergeSizeChange;
  testDeclarationLoss?: Array<{ file: string; ours: number; theirs: number; merged: number }>;
  testDeclarationUnmeasured?: string[];
  /** 해결기 응답이 LLM 공급자 오류 문구였다 — 파일 내용이 아니다(🅢 2026-09-27 #21086: 세 파일이 통째로 그 문구가 됐다). */
  providerFailure?: string[];
  /** 충돌 미해결의 원인. 기존 두 원인에 마커 잔존·파일 읽기 실패를 추가한다. */
  reason?: 'conflict-input-too-large' | 'conflict-resolver-interrupted' | 'conflict-markers-remain' | 'conflict-file-unreadable';
  /** 해결이 멎은 충돌 파일(worktree 상대 경로). */
  failedFile?: string;
  inputChars?: number;
  /** 병합 결과가 양쪽 판 중 작은 쪽의 절반 아래로 줄었다 — 통째로 날린 것으로 보고 해결 실패로 친다. */
  sizeCollapse?: Array<{ file: string; ours: number; theirs: number; merged: number }>;
  /** `status: 'error'` 일 때 어느 단계인지. 선택 — 옛 호출자는 이 칸 없이 돌아도 된다. */
  errorStep?: LlmMergeErrorStep;
  /** 그 단계의 git stderr 첫 줄. seam 이 안 주면 칸 자체를 만들지 않는다. */
  errorDetail?: string;
}

/** `src/session-runtime/retry-policy.ts` `formatProviderFallbackOutput` 의 머리 — 라우터는 공급자가 전부 막히면 이 문구를 «응답 텍스트»로 돌려준다. */
export const PROVIDER_FAILURE_TEXT = /^\s*\[LLM PROVIDER (?:BLOCKED|STOPPED)\]/;
/** 이 줄 수 미만 파일은 크기 붕괴 판정에서 뺀다(작은 파일은 정당하게 크게 줄 수 있다). */
export const SIZE_COLLAPSE_MIN_LINES = 50;
export const DEFAULT_MERGE_CONFLICT_INPUT_MAX_CHARS = 60_000;

export class MergeConflictInputTooLarge extends Error {
  constructor(readonly inputChars: number) {
    super(`충돌 큼 — 사람 수확 (LLM 입력 ${inputChars}자)`);
  }
}

function lineCount(s: string): number {
  if (s.length === 0) return 0;
  return s.endsWith('\n') ? s.slice(0, -1).split('\n').length : s.split('\n').length;
}

function addSizeChange(size: LlmMergeSizeChange, file: string, before: string, after: string): void {
  const beforeLines = lineCount(before);
  const afterLines = lineCount(after);
  const deltaLines = afterLines - beforeLines;
  size.files.push({ file, beforeLines, afterLines, deltaLines });
  size.totalBeforeLines += beforeLines;
  size.totalAfterLines += afterLines;
  size.totalDeltaLines += deltaLines;
}

export function formatLlmMergeOutcome(outcome: LlmMergeOutcome): string {
  const files = outcome.resolvedFiles?.length ? ` (LLM 종합 ${outcome.resolvedFiles.length}파일: ${outcome.resolvedFiles.join(', ')})` : '';
  if (outcome.status === 'conflict-unresolved') {
    // ⛔ reason·failedFile 은 «선택» 칸이다 — 공급자 오류·시험 선언 유실·크기 붕괴 출구는 계약상 reason 이 없다.
    //   있는 칸만 싣고, 그 출구들은 자기 실제 결과(어느 판정이 멈췄나)를 싣는다 — 「사유 undefined」 금지.
    const parts = [
      ...(outcome.reason ? [`사유 ${outcome.reason}`] : []),
      ...(outcome.failedFile ? [`파일 ${outcome.failedFile}`] : []),
      ...(outcome.providerFailure?.length ? [`공급자 오류 문구 ${outcome.providerFailure.join(', ')}`] : []),
      ...(outcome.testDeclarationLoss?.length
        ? [`시험 선언 유실 ${outcome.testDeclarationLoss.map((l) => `${l.file} ${l.ours}/${l.theirs}→${l.merged}`).join(', ')}`] : []),
      ...(outcome.sizeCollapse?.length
        ? [`크기 붕괴 ${outcome.sizeCollapse.map((c) => `${c.file} ${c.ours}/${c.theirs}→${c.merged}줄`).join(', ')}`] : []),
    ];
    return `${outcome.status}${files}${parts.length ? `; ${parts.join(' · ')}` : ''}`;
  }
  if (outcome.status !== 'llm-resolved') return `${outcome.status}${files}`;
  const size = outcome.sizeChange;
  if (size === undefined) return `${outcome.status}${files}; 규모 변화: 못 쟀다`;
  const delta = size.totalDeltaLines >= 0 ? `+${size.totalDeltaLines}` : `${size.totalDeltaLines}`;
  const perFile = size.files.map((f) => `${f.file} ${f.beforeLines}→${f.afterLines}줄(${f.deltaLines >= 0 ? '+' : ''}${f.deltaLines})`).join(', ');
  return `${outcome.status}${files}; 규모 변화: ${size.totalBeforeLines}→${size.totalAfterLines}줄(${delta})${perFile ? ` [${perFile}]` : ''}`;
}

/**
 * 병합 대상이 «원격» ref 이면 「어느 원격의 어느 브랜치인가」를 가른다. 로컬 ref 면 `null`. 순수.
 *
 * 🔑 왜 있나 — 종전엔 `fetch origin main` 이 **박혀** 있었고, 대상 일반화를 하며 그 fetch 가
 *   «계약째» 지워졌다(리뷰 must-fix). 그 결과 원격이 있는 저장소에서 ***stale `origin/*` 를 병합***한다.
 *   ⛔ 그것은 이 층이 막으려던 바로 그 사고다 — *"정합을 건너뛰고 병합하면 병렬 드리프트가 산출을 조용히 덮는다"*.
 *
 * ⭐ 그렇다고 fetch 를 다시 박으면 원래 문제(원격 없는 새 저장소에서 죽는다)로 돌아간다.
 *   ⇒ ***대상이 원격이면 그 원격을 갱신하고, 로컬이면 갱신할 것이 없다.*** 둘 다 지킨다.
 */
export function remoteFetchSpec(mergeTarget: string): { remote: string; branch: string } | null {
  // ⛔⭐ 이 함수는 «전역»이어야 한다 — 문자열이 아닌 것이 들어와도 «던지지 않는다».
  //   📏 2026-08-21 실물: 동적 import 때문에 「옛 호출자 + 새 피호출자」가 한 프로세스에 공존해
  //     `undefined.indexOf` 로 ***남의 런이 정합 직전에 죽었다***. 아래 하위호환과 «둘 다» 필요하다:
  //     이것은 「터지지 않게」, 아래는 「옛 동작을 그대로 주게」.
  if (typeof mergeTarget !== 'string' || mergeTarget.length === 0) return null;
  const slash = mergeTarget.indexOf('/');
  if (slash <= 0) return null;                       // `main`·`master` 같은 로컬 ref — 갱신 대상이 없다
  const remote = mergeTarget.slice(0, slash);
  const branch = mergeTarget.slice(slash + 1);
  if (branch.length === 0) return null;
  return { remote, branch };
}

/** git 작용 seam(테스트 주입·기본=실 git). 순수 시퀀서가 이 seam 만 통해 git 을 만진다. */
export interface MergeGitSeam {
  /** 그 이름이 «이 저장소에 설정된» 원격인가. ⛔ 원격을 조회하지 않는다 — 로컬 config 만 본다.
   *  이것이 `feature/foo` 같은 «슬래시 든 로컬 ref» 를 원격으로 오인하는 것을 막는다. */
  isConfiguredRemote: (wt: string, remote: string) => boolean;
  /** 해석된 «원격» 대상을 갱신한다. ok=성공(⛔ 실패 시 stale merge 금지 — 시퀀서가 error 로 멎는다).
   *  ⛔⭐ 반드시 «명시 refspec» 으로 원격추적 ref 를 갱신한다 — 아래 기본 어댑터 주석 참조.
   *  로컬 ref 대상에는 «불리지 않는다**(`remoteFetchSpec` 이 null 을 내거나 원격이 아닌 경우).
   *  `errorDetail` 은 실패 때 git stderr 첫 줄(선택 — 옛 seam 은 불리언만 돌려도 된다). */
  fetch: (wt: string, remote: string, branch: string) => boolean | { ok: boolean; errorDetail?: string };
  /** 호출자가 해석한 ref를 merge한다. ok=충돌 없이 성공 · conflict=충돌 · stdout=up-to-date 판별용.
   *  `errorDetail` 은 비-충돌 실패 때 git stderr 첫 줄(선택). */
  merge: (wt: string, mergeTarget: string) => { ok: boolean; conflict: boolean; stdout: string; errorDetail?: string };
  /** 충돌(unmerged) 파일 목록(worktree 상대 경로). */
  conflictedFiles: (wt: string) => string[];
  /** Reads an unmerged index stage (1=base, 2=ours, 3=theirs) for a conflicted file. */
  readIndexStage: (wt: string, stage: 1 | 2 | 3, file: string) => string;
  readFile: (absPath: string) => string;
  writeFile: (absPath: string, content: string) => void;
  /** 해결된 파일 스테이징. */
  add: (wt: string, file: string) => void;
  /** merge 커밋(--no-edit). ok=성공.
   *  `errorDetail` 은 실패 때 git stderr 첫 줄(선택 — 옛 seam 은 불리언만 돌려도 된다). */
  commit: (wt: string) => boolean | { ok: boolean; errorDetail?: string };
  /** merge --abort(base 유지). */
  abort: (wt: string) => void;
}

/**
 * 호출자가 해석한 기본 브랜치 ref를 worktree에 merge 하되, 충돌 시 LLM 이 각 충돌 파일을 종합 해결한다.
 * 순수 시퀀서: (대상이 원격이면) fetch → merge → (충돌이면) 파일별 LLM resolve → 마커 잔존 검사 → write/add → commit.
 * LLM 이 못 풀면(마커 잔존) abort 해 base 유지(fail-soft). resolve/git 은 seam(테스트).
 *
 * @param mergeTarget 호출부가 해석한 병합 대상 ref. 이 계층은 원격을 조회하거나 대상명을 만들지 않는다.
 *   ⛔⭐ **안 주면 «옛 기본»(`LEGACY_MERGE_TARGET`)으로 돈다 — 하위호환이다.** 왜 필요한지는 그 상수 주석에.
 * @param resolve (파일경로, 충돌내용<마커포함>) => 종합 해결된 전체 파일. LLM 어댑터가 주입.
 */
export async function mergeMainWithLlmResolve(
  worktreePath: string,
  mergeTarget: string,
  resolve: (filePath: string, conflictedContent: string) => Promise<string>,
  git: MergeGitSeam,
): Promise<LlmMergeOutcome> {
  // ⛔⭐ 하위호환 — 안 준 호출자(옛 판)에게는 이 층의 옛 기본을 준다. 사유는 LEGACY_MERGE_TARGET 주석.
  const target = typeof mergeTarget === 'string' && mergeTarget.length > 0 ? mergeTarget : LEGACY_MERGE_TARGET;
  if (target !== mergeTarget) {
    // ⛔ 조용히 넘어가지 않는다 — 「옛 호출자가 남아 있다」는 «값»이어야 잔재를 언제 걷을지 알 수 있다.
    try {
      const { debug } = await import('../../debug/log.js');
      debug.log('self-dev.merge', 'legacy-merge-target', { worktreePath, fallback: target }, { level: 'warn' });
    } catch { /* fail-open */ }
  }
  // ⛔⭐ stale merge 금지 — 대상이 원격이면 «먼저» 갱신한다. 실패하면 병합하지 «않는다».
  //   (원격이 없는 새 저장소는 로컬 ref 로 해석되므로 갱신 단계 자체가 없다.)
  const fetchSpec = remoteFetchSpec(target);
  if (fetchSpec !== null && git.isConfiguredRemote(worktreePath, fetchSpec.remote)) {
    const fetched = seamOk(git.fetch(worktreePath, fetchSpec.remote, fetchSpec.branch));
    if (!fetched.ok) return errorOutcome('fetch', fetched.errorDetail);
  }
  const mg = git.merge(worktreePath, target);
  if (mg.ok) { return { status: /Already up.to.date/i.test(mg.stdout) ? 'up-to-date' : 'merged' }; }
  if (!mg.conflict) { git.abort(worktreePath); return errorOutcome('merge', mg.errorDetail); } // 비-충돌 에러

  const files = git.conflictedFiles(worktreePath);
  if (files.length === 0) { git.abort(worktreePath); return errorOutcome('conflicted-files'); }
  const resolvedFiles: string[] = [];
  const sizeChange: LlmMergeSizeChange = { files: [], totalBeforeLines: 0, totalAfterLines: 0, totalDeltaLines: 0 };
  const testDeclarationUnmeasured: string[] = [];
  const measuredOutcome = <T extends object>(outcome: T): T & Pick<LlmMergeOutcome, 'testDeclarationUnmeasured'> => ({
    ...outcome,
    ...(testDeclarationUnmeasured.length ? { testDeclarationUnmeasured } : {}),
  });
  const unresolved = (outcome: LlmMergeOutcome & { status: 'conflict-unresolved'; failedFile: string }): LlmMergeOutcome => {
    debug.log('self-dev.merge', 'conflict-unresolved', { reason: outcome.reason, failedFile: outcome.failedFile, resolvedCount: resolvedFiles.length });
    return measuredOutcome(outcome);
  };
  for (const f of files) {
    const abs = join(worktreePath, f);
    let conflicted: string;
    let merged: string;
    try {
      conflicted = git.readFile(abs);
    } catch {
      git.abort(worktreePath);
      return unresolved({ status: 'conflict-unresolved', reason: 'conflict-file-unreadable', failedFile: f, resolvedFiles });
    }
    try {
      // release/next.md: concurrent landings each append a line — keep both without asking the LLM (REL7c).
      const deterministic = f === NEXT_MD_PATH ? deterministicNextMd(git, worktreePath, f) : null;
      merged = deterministic ?? await resolve(f, conflicted);
    } catch (error) {
      git.abort(worktreePath); // LLM 예외 → base 유지
      return unresolved({ status: 'conflict-unresolved', resolvedFiles, failedFile: f,
        ...(error instanceof MergeConflictInputTooLarge
          ? { reason: 'conflict-input-too-large' as const, inputChars: error.inputChars }
          : { reason: 'conflict-resolver-interrupted' as const }),
      });
    }
    if (PROVIDER_FAILURE_TEXT.test(merged)) {
      git.abort(worktreePath); // 해결기가 공급자 오류 문구를 «내용»으로 돌려줬다 → base 유지
      return unresolved({ status: 'conflict-unresolved', resolvedFiles, failedFile: f, providerFailure: [f] });
    }
    if (hasConflictMarkers(merged)) {
      git.abort(worktreePath); // LLM 이 종합 못 함(마커 잔존) → base 유지
      return unresolved({ status: 'conflict-unresolved', reason: 'conflict-markers-remain', failedFile: f, resolvedFiles });
    }
    try {
      const ours = countTestDeclarations(git.readIndexStage(worktreePath, 2, f));
      const theirs = countTestDeclarations(git.readIndexStage(worktreePath, 3, f));
      const mergedDeclarations = countTestDeclarations(merged);
      if (mergedDeclarations < Math.min(ours, theirs)) {
        const testDeclarationLoss = [{ file: f, ours, theirs, merged: mergedDeclarations }];
        git.abort(worktreePath);
        return unresolved({ status: 'conflict-unresolved', resolvedFiles, failedFile: f, testDeclarationLoss });
      }
    } catch {
      testDeclarationUnmeasured.push(f);
    }
    try {
      const ours = lineCount(git.readIndexStage(worktreePath, 2, f));
      const theirs = lineCount(git.readIndexStage(worktreePath, 3, f));
      const mergedLines = lineCount(merged);
      const smaller = Math.min(ours, theirs);
      if (smaller >= SIZE_COLLAPSE_MIN_LINES && mergedLines * 2 < smaller) {
        git.abort(worktreePath); // 양쪽 판 모두보다 절반 넘게 작다 → 통째로 날렸다 → base 유지
        return unresolved({ status: 'conflict-unresolved', resolvedFiles, failedFile: f, sizeCollapse: [{ file: f, ours, theirs, merged: mergedLines }] });
      }
    } catch {
      /* 한쪽 판이 없는 충돌(삭제·추가) — 크기 비교 대상이 아니다 */
    }
    addSizeChange(sizeChange, f, conflicted, merged);
    git.writeFile(abs, merged);
    git.add(worktreePath, f);
    resolvedFiles.push(f);
  }
  const committed = seamOk(git.commit(worktreePath));
  if (!committed.ok) { git.abort(worktreePath); return measuredOutcome(errorOutcome('commit', committed.errorDetail, resolvedFiles)); }
  return measuredOutcome({
    status: 'llm-resolved',
    resolvedFiles,
    sizeChange,
  });
}

/** git 명령 stderr 의 첫 비어 있지 않은 줄. 상한을 넘으면 자른다. 없으면 undefined. */
export function firstGitErrorLine(stderr: string | undefined | null): string | undefined {
  const line = (stderr ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (line === undefined) return undefined;
  return line.length > GIT_ERROR_DETAIL_MAX_CHARS ? line.slice(0, GIT_ERROR_DETAIL_MAX_CHARS) : line;
}

function seamOk(result: boolean | { ok: boolean; errorDetail?: string }): { ok: boolean; errorDetail?: string } {
  return typeof result === 'boolean' ? { ok: result } : result;
}

function errorOutcome(
  errorStep: LlmMergeErrorStep,
  errorDetail?: string,
  resolvedFiles?: string[],
): LlmMergeOutcome {
  return {
    status: 'error',
    errorStep,
    ...(errorDetail === undefined || errorDetail.length === 0 ? {} : { errorDetail }),
    ...(resolvedFiles === undefined ? {} : { resolvedFiles }),
  };
}

/** 실 git seam(기본 어댑터). worktree 에서 spawnSync git. */
export function defaultGitMergeSeam(): MergeGitSeam {
  const g = (wt: string, ...a: string[]) => runGitCommand(wt, a, { encoding: 'utf8' });
  const failed = (stderr: string | undefined | null) => ({ ok: false as const, ...(firstGitErrorLine(stderr) === undefined ? {} : { errorDetail: firstGitErrorLine(stderr) }) });
  return {
    isConfiguredRemote: (wt, remote) => (g(wt, 'remote').stdout ?? '').split('\n').map((l) => l.trim()).includes(remote),
    // ⛔⭐⭐ 「refspec 없는 fetch」를 쓰지 «않는다».
    //   📏 실측(2026-08-21 · 실제 저장소): `git fetch origin main` 은 원격에 기본 refspec
    //     (`+refs/heads/*:refs/remotes/origin/*`)이 «있으면» refs/remotes/origin/main 을 같이 갱신한다.
    //     ⛔ 그러나 그 refspec 이 «없는» 원격에서는 FETCH_HEAD 만 움직이고 원격추적 ref 는 «안 생긴다».
    //     ⇒ 그러면 뒤이은 `merge origin/main` 이 ***옛 ref 를 병합***한다 — stale 이다.
    //   ✅ 그래서 refspec 을 «명시»한다. 설정에 기대지 않으므로 이 부류가 통째로 사라진다.
    fetch: (wt, remote, branch) => {
      const r = g(wt, 'fetch', remote, `+${branch}:refs/remotes/${remote}/${branch}`, '--quiet');
      return r.status === 0 ? true : failed(r.stderr);
    },
    merge: (wt, mergeTarget) => {
      const r = g(wt, 'merge', '--no-edit', mergeTarget);
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      const hasUnmergedFiles = (g(wt, 'diff', '--name-only', '--diff-filter=U').stdout ?? '').trim().length > 0;
      const ok = r.status === 0;
      const conflict = hasUnmergedFiles || /CONFLICT|Automatic merge failed/i.test(out);
      return {
        ok,
        conflict,
        stdout: r.stdout ?? '',
        ...(!ok && !conflict && firstGitErrorLine(r.stderr) !== undefined ? { errorDetail: firstGitErrorLine(r.stderr) } : {}),
      };
    },
    conflictedFiles: (wt) => (g(wt, 'diff', '--name-only', '--diff-filter=U').stdout ?? '').split('\n').filter(Boolean),
    readIndexStage: (wt, stage, file) => {
      const result = g(wt, 'show', `:${stage}:${file}`);
      if (result.status !== 0) throw new Error(`unable to read index stage ${stage} for ${file}`);
      return result.stdout ?? '';
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
    add: (wt, f) => { g(wt, 'add', f); },
    commit: (wt) => {
      const r = g(wt, 'commit', '--no-edit');
      return r.status === 0 ? true : failed(r.stderr);
    },
    abort: (wt) => { g(wt, 'merge', '--abort'); },
  };
}

/** 실 LLM 충돌 해결 어댑터(streamLLM·sol). 코드펜스/설명 제거해 완결 파일만. */
export async function defaultLlmResolve(
  filePath: string, conflicted: string, mergeTarget: string,
  options: { worktreePath?: string; mode?: 'off' | 'shadow' | 'on'; git?: IntentGit; stream?: typeof import('../../llm.js')['streamLLM'] } = {},
): Promise<string> {
  let rawConfig: { mergeConflictInputMaxChars?: unknown; mergeIntent?: unknown } | undefined;
  try { rawConfig = getUserConfig().raw.selfImplement as typeof rawConfig; }
  catch { /* unreadable config keeps the old resolver and default input limit */ }
  const configuredMax = rawConfig?.mergeConflictInputMaxChars;
  const maxChars = typeof configuredMax === 'number' && Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax : DEFAULT_MERGE_CONFLICT_INPUT_MAX_CHARS;
  let rawMode: unknown = options.mode;
  if (rawMode === undefined) {
    rawMode = rawConfig?.mergeIntent;
  }
  const mode = rawMode === 'shadow' || rawMode === 'on' ? rawMode : 'off';
  const resolve = async (intent?: { ours: string | null; theirs: string[] }): Promise<string> => {
    const prompt = conflictResolvePrompt(filePath, conflicted, mergeTarget, intent);
    if (prompt.length > maxChars) throw new MergeConflictInputTooLarge(prompt.length);
    const streamLLM = options.stream ?? (await import('../../llm.js')).streamLLM;
    const out = await streamLLM([{ role: 'user', content: prompt }], () => {}, { model: process.env.ELANOUS_CONFLICT_MODEL || tierModel('better'), reasoningEffort: 'medium' });
    // ⛔ 라우터는 공급자가 전부 막히면 던지지 않고 오류 문구를 돌려준다 — 그것은 파일 내용이 아니다.
    if (PROVIDER_FAILURE_TEXT.test(out)) throw new Error(`conflict resolve: LLM provider failure for ${filePath}`);
    return `${out.replace(/^```[\w.-]*\n?/, '').replace(/\n?```\s*$/, '').trimEnd()}\n`;
  };
  if (mode === 'off') return resolve();
  const collect = () => collectMergeIntent({ worktreePath: options.worktreePath ?? process.cwd(), filePath, mergeTarget, git: options.git ?? defaultIntentGit });
  if (mode === 'on') return resolve(collect());
  const plain = await resolve();
  try {
    const intent = collect();
    const withIntent = await resolve(intent);
    debug.log('self-dev.merge', 'intent-shadow', {
      file: filePath, same: plain === withIntent,
      plainMarkers: hasConflictMarkers(plain), intentMarkers: hasConflictMarkers(withIntent),
      plainLines: lineCount(plain), intentLines: lineCount(withIntent),
      oursIntent: intent.ours !== null, theirsCount: intent.theirs.length,
    });
  } catch (error) {
    try { debug.log('self-dev.merge', 'intent-shadow-failed', { file: filePath, error: String(error) }); }
    catch { /* shadow observation must not affect the adopted result */ }
  }
  return plain;
}

/** 편의 — 실 git+LLM 으로 호출부가 해석한 ref를 worktree 에 지능 정합한다. */
export async function mergeMainIntoWorktreeWithLlm(worktreePath: string, mergeTarget: string): Promise<LlmMergeOutcome> {
  return mergeMainWithLlmResolve(worktreePath, mergeTarget, (filePath, conflicted) => defaultLlmResolve(filePath, conflicted, mergeTarget, { worktreePath }), defaultGitMergeSeam());
}

/** LLM 충돌 해결 프롬프트(순수·테스트) — ours(walker)·theirs(호출자가 전달한 정합 대상) 종합 지시. */
export function conflictResolvePrompt(filePath: string, conflictedContent: string, mergeTarget: string, intent?: { ours: string | null; theirs: string[] }): string {
  return [
    '너는 git merge 충돌을 지능적으로 해결하는 엔지니어다. 아래 파일은 3-way merge 충돌 마커를 포함한다:',
    '  <<<<<<< ours   = 현재 브랜치(walker 가 이 미션에서 만든 산출물)',
    '  ======= 사이   = 양쪽 버전',
    `  >>>>>>> theirs = ${mergeTarget}(호출자가 해석해 전달한 정합 대상)`,
    '',
    ...(intent ? [
      `ours 의 의도: ${intent.ours ?? '(확인 불가)'}`,
      `theirs 에 먼저 착지한 변경: ${intent.theirs.length ? intent.theirs.join(' · ') : '(확인 불가)'}`,
      '',
    ] : []),
    '해결 원칙:',
    '- 양쪽의 의도를 **모두 보존**하며 종합한다(한쪽을 통째로 버리지 않는다).',
    `- 같은 목적의 중복(예: 같은 테스트·같은 함수)은 **theirs(${mergeTarget}) 버전을 채택**하고 ours 의 중복은 제거.`,
    '- ours 에만 있는 고유 추가분(테스트·헬퍼)은 **보존**해 theirs 와 합친다.',
    '- 최종본은 문법적으로 유효하고 일관돼야 한다(중복 선언·깨진 블록 없이).',
    '',
    '⚠️ 충돌 마커(<<<<<<<, =======, >>>>>>>)가 하나도 없는 **완결된 파일 전체**를 출력하라. 설명·코드펜스 없이 파일 내용만.',
    '',
    `파일: ${filePath}`,
    '```',
    conflictedContent,
    '```',
  ].join('\n');
}
