// 🅢 70차 — 발사 전 검사 «둘»을 한 로직 안으로 (대표 지시 2026-08-11).
//
// ⛔ 왜 이 파일이 있나: `MANUAL-goal-authoring-method` §0 의 발사 절차는 사람이 «네 명령»을 차례로
//   치는 것이었다 — ⑴저작 ⑵열린 PR 검사 ⑶도는 런 검사 ⑷발사. 그런데 ⑵⑶ 은 순수 «전제 검사»라
//   사람의 판단이 필요한 자리가 «하나»뿐이다: 무언가 걸렸을 때 멈출 것인가.
//   대표: *"하나의 로직 안에서 모두 소화하면 되잖아요"* ⇒ 이 모듈이 그 판정을 담고, CLI 가 그것을 부른다.
//
// ⛔ 설계 원칙 넷 (이 저장소가 이미 지불한 값 · ⭐ ①은 리뷰가 «내 코드에서» 잡아 준 것이다)
//   ① ***「잴 것이 없었다」를 「통과」로 만들지 않는다*** — 대상 경로가 0이면 그것 자체가 막는 사유다
//      (= `METHOD v32` 를 이 코드가 스스로 밟았다: 모집단 0인데 「위반 0」으로 통과했다).
//   ② ***부재와 미지를 같은 값으로 두지 않는다*** — 조회 실패는 `unknown`, 상한에 닿으면 `truncated`.
//      그리고 «읽지 못해 건너뛴 런의 수»를 세어 산출에 싣는다(조용히 건너뛰지 않는다).
//   ③ ***임계는 «보이게» 둔다*** — 「도는 런」은 나이로 갈리는데 매뉴얼이 *"임계는 없다"* 라 못 박았다.
//   ④ ***막을 때는 이름을 댄다*** — 「전제 위반」 대신 PR 번호·runId·경로.
//   ⑤ ***draft 는 «차단»이 아니라 «경고»다***(대표 지시 2026-08-11). 📏 🅣 실측: 이 검사가 막은 5건이
//      «전부» draft 였고 열린 33건 중 ready 는 셋뿐이었다 ⇒ 「사람 판단 대기」 더미가 «능동 차단기»가 됐다.
//      ⛔ 그래도 관측·산출에는 «그대로» 남긴다 — 「지나갔다」와 「없었다」는 다른 값이다.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { normalizeReviewFindingKey } from '../agent-substrate/review-finding-key.js';
import { resolveLogTargets } from '../cli/logs-cli.js';
import { debug } from '../debug/log.js';
import { plannedSelfImplBranch } from '../harness/worktree-branch-prefix.js';
import { LogStore } from '../mss/logging/log-store.js';
import { loadSelfDevRun, selfDevRunsDir } from './run-store.js';
import type { DevAuthorInput } from './dev-cli.js';
import { isTerminatedUnfinishedLifecycle, loadRunLedger, type UnfinishedRunLifecycle } from '../self-implement/run-ledger.js';
import { queryRunningRuns, type RunningRunsResult } from '../self-implement/running-runs.js';
import { findSiblingPrs } from '../cli/pr-lineage.js';
import { findPremiseMockedBySignal } from '../../scripts/goal-premise-mocked-by-signal.js';
import { functionExits } from '../../scripts/goal-invariant-function-exits.js';
import { ASK_MARKER_REPOSITORY_ROOT, formatAxis, formatAxisObservations, inspectAskMarkers, inspectAskMarkersInRoot, inspectConsumerPathWarning, inspectConsumerPathWarningInRoot, inspectUnpressedDecisionSignals } from '../../scripts/ask-marker-check.js';

/** 작업 트리 안의 경로를 Git 읽기로 확인한 한 축. */
export type WorktreePathTouchAxis = 'touched' | 'untouched' | 'unreadable';

/** 겹친 경로가 실제로 손대어졌는지의 읽기 전용 관측. 차단 조건에는 쓰지 않는다. */
export interface WorktreePathTouchObservation {
  readonly state: 'touched' | 'untouched' | 'unreadable' | 'worktree-unknown';
  readonly uncommitted: WorktreePathTouchAxis | null;
  readonly committed: WorktreePathTouchAxis | null;
}

export function combineWorktreePathTouchAxes(uncommitted: WorktreePathTouchAxis, committed: WorktreePathTouchAxis): WorktreePathTouchObservation['state'] {
  if (uncommitted === 'touched' || committed === 'touched') return 'touched';
  if (uncommitted === 'unreadable' || committed === 'unreadable') return 'unreadable';
  return 'untouched';
}

/** `git status`와 merge-base 이후 diff를 읽기만 해 경로별 실제 변경을 관측한다. */
export function observeWorktreePathTouches(run: PreflightUnfinishedRun, paths: readonly string[]): Readonly<Record<string, WorktreePathTouchObservation>> {
  if (!run.worktreePath) {
    return Object.fromEntries(paths.map((path) => [path, { state: 'worktree-unknown' as const, uncommitted: null, committed: null }]));
  }
  let mergeBase: string | null = null;
  try {
    // git-spawn-allow: Reads the run worktree merge-base and does not modify repository state.
    mergeBase = execFileSync('git', ['-C', run.worktreePath, 'merge-base', 'HEAD', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { /* committed axis records unreadable below */ }
  return Object.fromEntries(paths.map((path) => {
    let uncommitted: WorktreePathTouchAxis;
    try {
      // git-spawn-allow: Reads porcelain status for one path in the run worktree and does not modify repository state.
      const output = execFileSync('git', ['-C', run.worktreePath!, 'status', '--porcelain', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      uncommitted = output === '' ? 'untouched' : 'touched';
    } catch { uncommitted = 'unreadable'; }
    let committed: WorktreePathTouchAxis;
    if (!mergeBase) committed = 'unreadable';
    else try {
      // git-spawn-allow: Reads path-limited changes from merge-base to HEAD and does not modify repository state.
      const output = execFileSync('git', ['-C', run.worktreePath!, 'diff', '--name-only', mergeBase, 'HEAD', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      committed = output === '' ? 'untouched' : 'touched';
    } catch { committed = 'unreadable'; }
    return [path, { state: combineWorktreePathTouchAxes(uncommitted, committed), uncommitted, committed }];
  }));
}

/** 도는 런과 겹친 한 경로의 역할 — 골이 명시한 대상 또는 읽기 근거다. */
export interface LiveRunOverlapPath {
  readonly path: string;
  readonly role: 'target' | 'evidence' | 'unknown';
  /** 실제 작업 트리 변경 관측. 없는 것은 구형 호출자가 이 값을 제공하지 않았다는 뜻이다. */
  readonly worktreeTouch?: WorktreePathTouchObservation;
}

/** 검사 대상 한 건이 막힌 이유. `name` 은 사람이 바로 열어 볼 수 있는 식별자다. */
export interface LaunchPreflightBlocker {
  readonly kind: 'open-pr' | 'sibling-pr' | 'live-run' | 'no-target-paths' | 'recent-change' | 'ask-outside-path' | 'ask-marker';
  /** `#8100` · `run-6ce5765b…` 처럼 «바로 조회 가능한» 이름. */
  readonly name: string;
  /** 왜 막혔는지 한 줄 — 경로와 수를 포함한다. */
  readonly detail: string;
  /** draft PR 경고가 연 검사 대상 경로. 동일 경로의 경고를 렌더에서 묶는다. */
  readonly draftPaths?: readonly string[];
  /** 라이브 런 충돌의 경로별 역할. ask 대상 표지가 없으면 미상이라 생략한다. */
  readonly overlapPaths?: readonly LiveRunOverlapPath[];
  /** 라이브 런 충돌이 전부 읽기 근거인지. 역할을 모르면 거짓으로 접지 않고 생략한다. */
  readonly allOverlapPathsAreEvidence?: boolean;
}

/** 「최근 N일 안에 «종료»된 것」만 센다 — ⛔ `checked` 와 `truncated` 가 «같은 창»을 쓰게 한 자리다.
 *  창을 한쪽에만 걸면 「최근 수」라 부르면서 전 기간을 세게 된다(2026-09-01 리뷰가 짚었다).
 *  ⛔ 종료 시각을 못 읽은 런은 «세지 않는다» — 「모른다」를 「최근이다」로 바꾸지 않는다. */
function countWithinRecentWindow(
  runs: readonly { readonly terminatedAtMs?: number }[],
  nowMs: number,
  windowDays: number,
): number {
  const windowMs = windowDays * 24 * 60 * 60_000;
  return runs.filter((run) => {
    const at = run.terminatedAtMs;
    if (at === undefined || !Number.isFinite(at)) return false;
    const age = nowMs - at;
    return age >= 0 && age <= windowMs;
  }).length;
}

/** 검사 한 축의 «관측 상태» — ⛔ 0 · 못 셌음 · 잘렸음을 서로 다른 값으로 둔다. */
export type PreflightAxisStatus =
  | { readonly state: 'checked'; readonly count: number }
  | { readonly state: 'truncated'; readonly count: number; readonly limit: number }
  | { readonly state: 'unknown'; readonly reason: string };

export interface PreflightPreexistingFailureRecord {
  readonly file: string;
  /** 관측 row에 있던 시점. 구형 입력에는 없으므로 사람이 읽게 '모름'으로 렌더한다. */
  readonly observedAt: string | null;
  /** 이 preexisting 기록 뒤 baseline에 같은 파일의 관측이 있었는지. null은 원 기록 시각 결손으로 판단할 수 없음을 뜻한다. */
  readonly reconfirmed?: boolean | null;
}

/** Gate가 원래부터 실패하던 테스트로 기록한 파일의 읽기 결과. */
export type PreflightPreexistingFailuresStatus =
  | { readonly state: 'checked'; readonly files: readonly string[]; readonly records?: readonly PreflightPreexistingFailureRecord[]; readonly unreadableTargets?: readonly PreflightUnreadableTarget[] }
  | { readonly state: 'truncated'; readonly files: readonly string[]; readonly limit: number; readonly records?: readonly PreflightPreexistingFailureRecord[]; readonly unreadableTargets?: readonly PreflightUnreadableTarget[] }
  | { readonly state: 'unreadable'; readonly reason: string };

/**
 * ⛔ 「못 읽은 로그 우주」를 «값으로» 남긴다 — 경고 «문자열»이 아니다.
 * 하나가 안 열려도 나머지에서 읽은 것은 살린다. 하나도 못 읽었을 때만 `unreadable` 이다.
 * 📏 2026-09-12 실측: 등록 347 중 «1»(test:wt-hitl)이 안 열려 346에서 읽은 기록 13건이 통째로 버려졌다.
 */
export interface PreflightUnreadableTarget {
  readonly dbPath: string;
  readonly reason: string;
}

/** gate-baseline 사람용 노트에서 preexisting 테스트 파일만 보수적으로 뽑는다. */
export function parsePreexistingFailureTestFiles(note: string): readonly string[] {
  return [...new Set([...note.matchAll(/^- preexisting:\s+(.+?\.(?:[cm]?[jt]sx?))\s+>/gmi)].map((match) => match[1]!))];
}

/** 소스 경로를 같은 디렉터리의 짝 테스트 경로로 순수하게 바꾼다. */
export function siblingTestPath(path: string): string | null {
  return path.endsWith('.ts') && !path.endsWith('.test.ts')
    ? `${path.slice(0, -'.ts'.length)}.test.ts`
    : null;
}

/** 짝 테스트 파일에서 읽은 두 독립 측정값. `unknown`은 0과 구별되는 측정 불가다. */
export interface PairedTestMeasurement {
  readonly toEqualArrayOpenings: PreflightAxisStatus;
  readonly symbolOccurrences: PreflightAxisStatus;
}

/** 경로에 대응하는 파일 내용을 읽는다. `null`은 파일이 없거나 읽을 수 없음을 뜻한다. */
export type ReadPairedTestFile = (path: string) => string | null;

/** 소스의 짝 테스트를 읽어 배열 `toEqual` 비교와 선택 심볼의 등장 횟수를 독립적으로 잰다. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function measurePairedTestFile(path: string, symbolName: string | null | undefined, readFile: ReadPairedTestFile): PairedTestMeasurement {
  const testPath = siblingTestPath(path);
  const contents = testPath === null ? null : readFile(testPath);
  const unavailable = (reason: string): PreflightAxisStatus => ({ state: 'unknown', reason });
  if (contents === null) {
    return {
      toEqualArrayOpenings: unavailable(testPath === null ? 'source path has no sibling test path' : 'sibling test file is unavailable'),
      symbolOccurrences: unavailable(testPath === null ? 'source path has no sibling test path' : 'sibling test file is unavailable'),
    };
  }
  return {
    toEqualArrayOpenings: { state: 'checked', count: (contents.match(/\.toEqual\(\s*\[/g) ?? []).length },
    symbolOccurrences: symbolName === undefined || symbolName === null || symbolName === ''
      ? unavailable('symbol name is unavailable')
      : { state: 'checked', count: (contents.match(new RegExp(`(?<![$_\\p{ID_Continue}\\u200C\\u200D])${escapeRegExpLiteral(symbolName)}(?![$_\\p{ID_Continue}\\u200C\\u200D])`, 'gu')) ?? []).length },
  };
}

export function normalizePreexistingFailureObservedAt(observedAt: unknown): string | null {
  return typeof observedAt === 'string' && observedAt.trim() !== '' ? observedAt : null;
}

function normalizePreexistingFailureRecords(status: Exclude<PreflightPreexistingFailuresStatus, { readonly state: 'unreadable' }>): readonly PreflightPreexistingFailureRecord[] {
  const byFile = new Map<string, PreflightPreexistingFailureRecord>();
  for (const file of status.files) byFile.set(file, { file, observedAt: null, reconfirmed: null });
  for (const record of status.records ?? []) {
    const existing = byFile.get(record.file);
    if (!existing) continue;
    byFile.set(record.file, {
      file: record.file,
      observedAt: normalizePreexistingFailureObservedAt(record.observedAt) ?? existing.observedAt,
      reconfirmed: record.reconfirmed ?? null,
    });
  }
  return [...byFile.values()];
}

function preexistingFailureObservationTimeMs(observedAt: string | null): number | null {
  if (observedAt === null) return null;
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function preexistingFailureBaselineFiles(data: unknown): readonly string[] {
  if (!data || typeof data !== 'object') return [];
  const baselineFiles = (data as { baselineFiles?: unknown }).baselineFiles;
  return Array.isArray(baselineFiles) ? baselineFiles.filter((file): file is string => typeof file === 'string' && file !== '') : [];
}

function preexistingFailureSlices(data: unknown): readonly { attribution?: unknown; file?: unknown }[] {
  if (!data || typeof data !== 'object') return [];
  const failures = (data as { failures?: unknown }).failures;
  return Array.isArray(failures) ? failures as Array<{ attribution?: unknown; file?: unknown }> : [];
}

export function preexistingFailureRecordsFromGateObservations(observations: readonly unknown[]): readonly PreflightPreexistingFailureRecord[] {
  const byFile = new Map<string, PreflightPreexistingFailureRecord>();
  const preexistingAtMsByFile = new Map<string, number>();
  const latestRunByFile = new Map<string, { readonly observedAtMs: number; readonly failed: boolean }>();

  for (const data of observations) {
    const observedAt = data && typeof data === 'object'
      ? normalizePreexistingFailureObservedAt((data as { observedAt?: unknown }).observedAt)
      : null;
    const observedAtMs = preexistingFailureObservationTimeMs(observedAt);
    const failures = preexistingFailureSlices(data);
    const failureFiles = new Set(failures.flatMap((failure) => typeof failure.file === 'string' && failure.file !== ''
      ? [failure.file]
      : []));
    const preexistingFiles = new Set(failures.flatMap((failure) => failure.attribution === 'preexisting' && typeof failure.file === 'string' && failure.file !== ''
      ? [failure.file]
      : []));

    for (const file of preexistingFiles) {
      const previous = preexistingAtMsByFile.get(file);
      if (observedAtMs !== null && (previous === undefined || observedAtMs > previous)) {
        preexistingAtMsByFile.set(file, observedAtMs);
        byFile.set(file, { file, observedAt });
      } else if (!byFile.has(file)) {
        byFile.set(file, { file, observedAt });
      }
    }

    if (observedAtMs === null) continue;
    for (const file of preexistingFailureBaselineFiles(data)) {
      const previous = latestRunByFile.get(file);
      if (previous !== undefined && previous.observedAtMs > observedAtMs) continue;
      latestRunByFile.set(file, { observedAtMs, failed: failureFiles.has(file) });
    }
  }

  return [...byFile.values()].filter((record) => {
    const preexistingAtMs = preexistingAtMsByFile.get(record.file);
    const latestRun = latestRunByFile.get(record.file);
    return preexistingAtMs === undefined || latestRun === undefined || latestRun.observedAtMs <= preexistingAtMs || latestRun.failed;
  }).map((record) => {
    const preexistingAtMs = preexistingAtMsByFile.get(record.file);
    const latestRun = latestRunByFile.get(record.file);
    return {
      ...record,
      reconfirmed: preexistingAtMs === undefined
        ? null
        : latestRun !== undefined && latestRun.observedAtMs > preexistingAtMs,
    };
  });
}

export function preexistingFailureTestFilesFromGateObservations(observations: readonly unknown[]): readonly string[] {
  return preexistingFailureRecordsFromGateObservations(observations).map(({ file }) => file);
}

const PREEXISTING_FAILURE_OBSERVATION_LIMIT = 1_000;

/** 모든 로그 우주의 gate 관측에서 preexisting 실패 파일을 읽는다. DB마다 상한보다 하나 더 읽어 절단을 보존한다. */
export function listPreexistingFailureTestFiles(targetsOverride?: readonly { readonly dbPath: string }[]): PreflightPreexistingFailuresStatus {
  const resolved = targetsOverride ? { targets: targetsOverride, error: undefined } : resolveLogTargets({ all: true, includeTest: true });
  if (resolved.error) throw new Error(resolved.error);
  const observations: unknown[] = [];
  let truncated = false;
  const unreadableTargets: PreflightUnreadableTarget[] = [];
  let readableCount = 0;
  for (const target of resolved.targets) {
    // ⛔ 「파일이 없다」와 「있는데 못 연다」는 다른 값 — 앞의 것은 실패가 아니므로 세지 않는다.
    if (!existsSync(target.dbPath)) continue;
    let store: LogStore | undefined;
    try {
      store = new LogStore(target.dbPath, { readonly: true });
      const rows = store.query({
        exactCategories: ['self-implement'], events: ['gate.baseline'], limit: PREEXISTING_FAILURE_OBSERVATION_LIMIT + 1,
      });
      if (rows.length > PREEXISTING_FAILURE_OBSERVATION_LIMIT) truncated = true;
      for (const row of rows.slice(0, PREEXISTING_FAILURE_OBSERVATION_LIMIT)) {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        observations.push(data && typeof data === 'object' ? { ...data, observedAt: row.ts } : data);
      }
      readableCount += 1;
    } catch (error) {
      // ⛔ 한 우주의 실패를 «그 우주에만» 가둔다 — 하나 때문에 나머지를 버리지 않는다.
      unreadableTargets.push({ dbPath: target.dbPath, reason: error instanceof Error ? error.message.split('\n')[0]! : String(error) });
    } finally {
      store?.close();
    }
  }
  // ⛔ 하나도 못 읽었으면 여전히 «모른다» — 「읽은 게 0건」으로 접지 않는다.
  if (readableCount === 0 && unreadableTargets.length > 0) {
    return {
      state: 'unreadable',
      reason: `gate preexisting 실패 기록 조회 실패: 로그 우주 ${unreadableTargets.length}개를 «하나도» 못 읽었다 — ${unreadableTargets[0]!.reason}`,
    };
  }
  const records = preexistingFailureRecordsFromGateObservations(observations);
  const files = records.map(({ file }) => file);
  const unreadable = unreadableTargets.length > 0 ? { unreadableTargets } : {};
  return truncated
    ? { state: 'truncated', files, records, limit: PREEXISTING_FAILURE_OBSERVATION_LIMIT, ...unreadable }
    : { state: 'checked', files, records, ...unreadable };
}

/** 종료된 중단 런 조회는 읽지 못한 원장을 별도 상태로 남긴다. */
export interface PreflightInterruptedRunObservationFailures {
  /** 원장 로더가 던진 횟수. */
  readonly ledgerLoadThrows?: number;
  /** 원장 로더가 null을 반환한 횟수. */
  readonly nullLedgers?: number;
  /** 원장 start 기록에 goalFile 이름이 없던 횟수. */
  readonly missingGoalFileNames?: number;
  /** 원장은 읽혔으나 가리키는 골 문서가 없어 경로를 모른다. 원장 판독 불가와 다른 수다. */
  readonly unreadableOrMissingGoalDocuments?: number;
}

/** 구형 `unreadableRuns` 합계에 원인별 중단 런 관측 실패를 덧붙인다. */
export function interruptedRunObservationFailureCount(failures: PreflightInterruptedRunObservationFailures | undefined): number {
  if (!failures) return 0;
  return (failures.ledgerLoadThrows ?? 0)
    + (failures.nullLedgers ?? 0)
    + (failures.missingGoalFileNames ?? 0)
    + (failures.unreadableOrMissingGoalDocuments ?? 0);
}

export type PreflightInterruptedRunsStatus = PreflightAxisStatus
  | {
    readonly state: 'unreadableRuns';
    readonly count: number;
    /** 기존 소비자를 위한 모든 원인 합계. */
    readonly unreadableRuns: number;
    /** 원장은 읽혔으나 가리키는 골 문서가 없다. `unreadableRuns` 와 합치지 않는다. */
    readonly missingGoalDocuments?: number;
    /** 새 소비자가 원인별로 판독 불가를 구분할 수 있는 선택적 보강값. */
    readonly observationFailures?: PreflightInterruptedRunObservationFailures;
    /** 판독 불가와 별개로 조회 상한에도 닿았으면 그 사실을 함께 보존한다. */
    readonly truncated?: true;
    readonly limit?: number;
  };

export interface PreflightCompletedRun {
  readonly runId: string;
  readonly plannedPaths: readonly string[];
  readonly ledgerDirectory: string;
}

export type PreflightCompletedRunsQuery = {
  readonly entries: readonly PreflightCompletedRun[];
  /** 원장 또는 원장 디렉터리를 읽지 못한 수. 0과 구별해 결과에 남긴다. */
  readonly unreadableRuns: number;
  /** 원장은 읽혔으나 가리키는 골 문서가 없다. `unreadableRuns` 에 더하지 않는다. */
  readonly missingGoalDocuments?: number;
} & (
  | {
      /** 원시 완료 런 조회가 상한에 닿지 않았다. */
      readonly truncated?: false;
      /** 조회 상한을 쓰지 않았으면 생략한다. */
      readonly limit?: number;
    }
  | {
      /** 상한에 닿은 완료 런 조회는 사람이 읽을 상한을 반드시 함께 낸다. */
      readonly truncated: true;
      readonly limit: number;
    }
);

export interface PreflightInterruptedRun {
  readonly runId: string;
  readonly plannedPaths: readonly string[];
  readonly interruptionReason: string | null;
  /** Terminal run-status timestamp, normalized by the ledger adapter. */
  readonly terminatedAtMs?: number;
  readonly ledgerDirectory: string;
}

export interface PreflightInterruptedRunsQuery {
  readonly entries: readonly PreflightInterruptedRun[];
  /** 원장 또는 원장 디렉터리를 읽지 못한 수. 0과 구별해 결과에 남긴다. */
  readonly unreadableRuns: number;
  /** `unreadableRuns`를 구성하는 원인별 카운터. 생략한 구형 producer도 계속 지원한다. */
  readonly observationFailures?: PreflightInterruptedRunObservationFailures;
  /** 조회 상한을 쓴 경우에만 준다. 결과 수가 닿으면 `truncated`다. */
  readonly limit?: number;
}

export interface AskMarkerObservation {
  readonly askText: 'absent' | 'present';
  /** ask-marker 판정에 실제로 쓴 대상 루트. 생략해도 기존 저장소 래퍼의 실제 루트를 기록한다. */
  readonly inspectionRoot?: string;
  readonly axes: readonly ReturnType<typeof inspectAskMarkers>[number][];
  readonly warnings: readonly string[];
}

export interface LaunchPreflightResult {
  readonly paths: readonly string[];
  /** 렌더에 표시한 선언 대상 경로 중 현재 작업 트리에 실재하지 않는 경로 수. 관측용이며 발사 판정에는 쓰지 않는다. */
  readonly missingDeclaredPathCount: number;
  /** 상대 선언 경로를 해석한 대상 저장소 뿌리. 렌더는 실재하지 않는 경로가 있을 때만 문면에 넣는다. */
  readonly declaredPathsRoot?: string;
  readonly blockers: readonly LaunchPreflightBlocker[];
  readonly openPrs: PreflightAxisStatus;
  /** 미완 런 원장 전체 수. ⛔ 이름은 기존 소비자 계약을 위해 유지한다. */
  readonly liveRuns: PreflightAxisStatus;
  /** 같은 대상 경로의 이미 완료된 런. 이 값은 경고·차단을 만들지 않는다. */
  readonly completedRuns: PreflightInterruptedRunsStatus;
  /** 여러 건이면 producer의 원장 위치·runId 정렬을 그대로 보존한다. */
  readonly completedRunMatches: readonly PreflightCompletedRun[];
  /** 같은 대상 경로의 이미 종료된 중단 런. 이 값은 경고·차단을 만들지 않는다. */
  readonly interruptedRuns: PreflightInterruptedRunsStatus;
  /** 여러 건이면 producer의 원장 위치·runId 정렬을 그대로 보존한다. */
  readonly interruptedRunMatches: readonly PreflightInterruptedRun[];
  /** 최근 30일에 종료된 같은 대상의 미완주 런. `unknown`은 원장을 못 읽었거나 종료 시각을 판독하지 못했음을 뜻한다. 차단에는 쓰지 않는다. */
  readonly priorIncompleteRuns?: PreflightAxisStatus;
  /** priorIncompleteRuns의 「최근」 창. 결과에 실어 어느 자로 쟀는지 보인다. */
  readonly priorIncompleteRunWindowDays?: number;
  /** 경로 겹침과 무관하게 나이가 임계 안인 미완 런 수 — 관측용이며 차단에는 쓰지 않는다. */
  readonly activeUnfinishedRuns: PreflightAxisStatus;
  /** 경로 겹침과 무관하게 나이가 임계 밖인 미완 런 수 — 관측용이다. */
  readonly inactiveUnfinishedRuns: PreflightAxisStatus;
  /** 경로 겹침과 무관하게 나이를 판독할 수 없는 미완 런 수. 기존 `unreadableRuns`와 다르다. */
  readonly unreadableUnfinishedRunAges: PreflightAxisStatus;
  /** 대상 경로의 최근 변경 이력 — `unknown`은 조회 실패이며 «변경 없음»이 아니다. */
  readonly recentChanges: PreflightAxisStatus;
  /** 골 전제를 판정 신호가 목으로 흉내 낸 원시 발견 수. 관측일 뿐 차단·경고를 만들지 않는다. */
  readonly premiseMockedBySignal?: PreflightAxisStatus;
  /** 골 문서 안 함수 선언의 반환 지점이 둘 이상인 원시 발견 수. 관측일 뿐 차단·경고를 만들지 않는다. */
  readonly invariantFunctionExits?: PreflightAxisStatus;
  /** gate가 preexisting으로 기록한 테스트 파일. 빈 배열은 기록된 일치가 없음을 뜻하며 깨끗함을 뜻하지 않는다. */
  readonly preexistingFailures: PreflightPreexistingFailuresStatus;
  /** 최근 변경을 조회한 기간 임계(일). 결과에 실어 어느 자로 쟀는지 보인다. */
  readonly recentChangeWindowDays: number;
  /** 막지는 않지만 «지나갔다»고 말해야 하는 것 — draft PR 충돌 등(대표 지시 2026-08-11).
   *  ⛔ 「경고가 있었다」와 「아무것도 없었다」는 다른 값이다. */
  readonly warnings: readonly LaunchPreflightBlocker[];
  /** 예정 경로나 나이를 «못 읽어» 판정에서 빠진 런의 수. ⛔ 0 이 아니면 이 검사는 «부분»이다. */
  readonly unreadableRuns: number;
  /** 「도는 런」 판정에 쓴 나이 임계(ms). 결과에 실어 «보이게» 한다. */
  readonly liveRunWindowMs: number;
  /** 별도 확신 판정의 비차단 부록. 기존 생성자는 생략할 수 있고 렌더러도 생략을 기존 동작으로 처리한다. */
  readonly runningRunsConfidenceAppendix?: string;
  /** 이미 계산한 ask 마커 판정. 있으면 실행 경로가 한 건의 구조화 관측으로 남긴다. */
  readonly askMarkerObservation?: AskMarkerObservation;
}

export interface PreflightOpenPr {
  readonly number: number;
  readonly title: string;
  readonly files: readonly { readonly path: string }[];
  /** ⛔ draft 는 «차단»이 아니라 «경고»다(대표 지시 2026-08-11) — 근거는 이 파일 머리말 ⑤. */
  readonly isDraft?: boolean;
  /** 열린 PR 의 head 브랜치. 옛 호출자는 안 주므로 선택이다. */
  readonly headRefName?: string;
}

export interface PreflightUnfinishedRun {
  readonly runId: string;
  /** 배열이거나, 못 읽었을 때의 사유 문자열(`goal-document-not-found` 등). */
  readonly plannedPaths: readonly string[] | string;
  readonly lastActivityAgeMs?: number | null;
  /** 원장이 판별한 수명주기. 없으면 기존 나이 기반 판정을 유지한다. */
  readonly lifecycle?: UnfinishedRunLifecycle;
  /** 연합 원장이 이 런을 읽은 물리 디렉터리. 없으면 추정하지 않는다. */
  readonly ledgerDirectory?: string;
  /** 도는 런의 작업 트리. 없으면 실제 변경 관측도 `worktree-unknown`으로 남긴다. */
  readonly worktreePath?: string;
  /** 외부 진입이 읽어 채운 경로별 실제 변경 관측. */
  readonly worktreePathTouches?: Readonly<Record<string, WorktreePathTouchObservation>>;
}

export interface LaunchPreflightInput {
  readonly paths: readonly string[];
  /** 상대 선언 경로를 해석할 선택적 대상 저장소 뿌리. 생략하면 호출 프로세스 cwd 기준을 보존한다. */
  readonly declaredPathsRoot?: string;
  /** null = 조회 실패(⛔ 「열린 PR 없음」이 아니다). */
  readonly openPrs: readonly PreflightOpenPr[] | null;
  /** 조회에 쓴 상한. 결과 수가 이 값이면 «잘린 것»으로 본다. */
  readonly openPrsLimit?: number;
  /** null = 조회 실패. */
  readonly unfinishedRuns: readonly PreflightUnfinishedRun[] | null;
  /** null = 조회 실패. 이미 완료된 런은 live-run 경고와 독립적으로 관측한다. */
  readonly completedRuns?: PreflightCompletedRunsQuery | null;
  readonly completedRunsUnknownReason?: string;
  /** null = 조회 실패. 이미 종료된 중단 런은 live-run 경고와 독립적으로 관측한다. */
  readonly interruptedRuns?: PreflightInterruptedRunsQuery | null;
  readonly interruptedRunsUnknownReason?: string;
  /** prior incomplete-run observation clock. Defaults to Date.now for production and is injectable for deterministic tests. */
  readonly nowMs?: number;
  /** 이 나이보다 «어린» 런만 「도는 중」으로 본다. 기본은 호출자가 정한다. */
  readonly liveRunWindowMs: number;
  readonly openPrsUnknownReason?: string;
  readonly unfinishedRunsUnknownReason?: string;
  /** 경로별 최근 변경 건수. null = Git 조회 실패(⛔ 「최근 변경 없음」이 아니다). */
  readonly recentChanges?: Readonly<Record<string, number>> | null;
  /** 골 문서의 원시 규율 관측. null은 문서를 읽지 못했거나 자가 던졌음을 뜻한다. */
  readonly premiseMockedBySignal?: number | null;
  /** 골 문서의 원시 규율 관측. null은 문서를 읽지 못했거나 자가 던졌음을 뜻한다. */
  readonly invariantFunctionExits?: number | null;
  readonly goalRulersUnknownReason?: string;
  /** 최근 변경 조회 기간(일). */
  readonly recentChangeWindowDays?: number;
  /** gate 관측 기록의 상태. 생략은 조회하지 못함이며 기록 없음으로 정규화하지 않는다. */
  readonly preexistingFailures?: PreflightPreexistingFailuresStatus;
  /** @deprecated `preexistingFailures`로 상태를 보존하는 새 호출자를 사용한다. */
  readonly preexistingFailureTestFiles?: readonly string[] | null;
  readonly preexistingFailuresUnknownReason?: string;
  readonly recentChangesUnknownReason?: string;
  /** ⭐ 사람이 ask 에 «댄» 대상 경로. 주면 충돌 문면이 경로마다 「대상/근거」를 «말한다».
   *  ⛔ 미주입·빈 배열이면 그 표시를 «안 붙인다»(지어내지 않는다). 판정 자체는 이 값과 «무관»하다. */
  readonly askTargetPaths?: readonly string[];
  /** 대상 경로 라벨이 «있는데» 거부된 조각. 0건 막음 문면이 그 이유를 말하게 한다(판정은 안 바꾼다). */
  readonly askTargetPathRejections?: readonly AskTargetPathHintRejection[];
  /** ask 원문 경로. 있으면 ask-outside-path 경고만 이 목록과 최종 대상을 비교한다. */
  readonly askOutsidePathHints?: readonly string[];
  /** 이번에 쏠 골의 브랜치 이름. 없으면 형제 PR 축의 경고를 내지 않는다. */
  readonly plannedBranch?: string;
  /** 이미 계산한 ask 마커 판정. 판정 내용은 이 함수가 바꾸지 않는다. */
  readonly askMarkerObservation?: AskMarkerObservation;
}

/** 발사 전 전제 검사 — 순수 함수. I/O 는 호출자가 하고 여기서는 «판정»만 한다. */
const emittedAskMarkerObservations = new WeakSet<LaunchPreflightResult>();

function emitAskMarkerObservation(result: LaunchPreflightResult): void {
  if (result.askMarkerObservation === undefined || emittedAskMarkerObservations.has(result)) return;
  try {
    debug.log('harness.preflight', 'ask-markers', result.askMarkerObservation);
  } catch {
    // Preflight observations never change the launch decision.
  }
  emittedAskMarkerObservations.add(result);
}

export function evaluateLaunchPreflight(input: LaunchPreflightInput): LaunchPreflightResult {
  const paths = [...new Set(input.paths.filter((path) => path.trim().length > 0))];
  const blockers: LaunchPreflightBlocker[] = [];
  const warnings: LaunchPreflightBlocker[] = [];

  // ① 모집단이 0이면 «통과»가 아니라 «막는 사유»다(METHOD v32 를 이 코드에도 적용).
  if (paths.length === 0) {
    blockers.push({
      kind: 'no-target-paths',
      name: '(대상 경로 0)',
      // ⛔ 2026-09-23 — 라벨이 «있는데» 조각이 거부된 경우를 「라벨을 넣어라」로 뭉개면 「거부됐다」를 「없다」로 읽게 된다
      //   (실측: `대상 경로: README.md — 설명…` 한 줄 → has-whitespace 로 통째 거부 · 문면은 「넣어라」뿐이었다).
      detail: (input.askTargetPathRejections?.length
        ? `대상 경로 라벨은 있는데 조각 ${input.askTargetPathRejections.length}개가 거부됐다: ${input.askTargetPathRejections.slice(0, 3).map((r) => `「${r.fragment.length > 40 ? `${r.fragment.slice(0, 40)}…` : r.fragment}」(${r.reason})`).join(' · ')} — 그 줄에는 «경로만» 둔다(설명은 다음 줄)`
        : '골에서 대상 경로를 하나도 못 뽑았다 — ask 첫 줄에 「대상 경로: <파일> · <파일>」을 넣어라')
        + ' — 이 상태의 「위반 0」은 「검사했다」가 아니다 — elanous self author --inspect-target-paths "<문면>"',
    });
  }

  const openPrs: PreflightAxisStatus = input.openPrs === null
    ? { state: 'unknown', reason: input.openPrsUnknownReason ?? 'open PR 조회 실패' }
    : typeof input.openPrsLimit === 'number' && input.openPrs.length >= input.openPrsLimit
      ? { state: 'truncated', count: input.openPrs.length, limit: input.openPrsLimit }
      : { state: 'checked', count: input.openPrs.length };
  // 조회가 잘렸다는 사실은 보존하되, 이 축은 병합 때 해결할 충돌 가능성이므로 발사를 막지 않는다.
  if (openPrs.state === 'truncated') {
    warnings.push({
      kind: 'open-pr',
      name: `(열린 PR 조회 상한 ${openPrs.limit})`,
      detail: `조회가 상한에 닿아 그 뒤를 «못 봤다» — 이 상태의 「충돌 없음」은 검사 결과가 아니다`,
    });
  }
  if (input.openPrs !== null && paths.length > 0) {
    for (const pr of input.openPrs) {
      const hit = pr.files.map((file) => file.path).filter((path) => paths.includes(path));
      if (hit.length === 0) continue;
      const entry = {
        kind: 'open-pr' as const,
        name: `#${pr.number}`,
        detail: `${pr.isDraft ? 'draft PR' : '열린 PR'} 이 같은 파일을 연다: ${hit.join(', ')} — ${pr.title}`,
        ...(pr.isDraft ? { draftPaths: hit } : {}),
      };
      // 열린 PR 겹침은 draft 여부와 무관하게 병합 때 충돌이 드러나는 경고로 남긴다.
      warnings.push(entry);
    }
  }
  const plannedBranch = input.plannedBranch?.trim() ?? '';
  if (plannedBranch.length > 0 && input.openPrs !== null) {
    const siblings = findSiblingPrs(
      plannedBranch,
      input.openPrs.flatMap((pr) => {
        const headRefName = pr.headRefName?.trim() ?? '';
        return headRefName.length > 0 ? [{ number: pr.number, headRefName }] : [];
      }),
    );
    if (siblings.length > 0) {
      const named = siblings.map((pr) => `#${pr.number} ${pr.headRefName}`).join(', ');
      const inspectCommand = `bun bin/elanous.mjs gh pr view ${siblings[0]!.number}`;
      warnings.push({
        kind: 'sibling-pr',
        name: siblings.map((pr) => `#${pr.number}`).join(' '),
        detail: `같은 골의 다른 시도가 이미 열려 있다: ${named} — 확인: ${inspectCommand}`,
      });
    }
  }

  const completedRuns: PreflightInterruptedRunsStatus = input.completedRuns === null
    ? { state: 'unknown', reason: input.completedRunsUnknownReason ?? '완료 런 조회 실패' }
    : input.completedRuns === undefined
      ? { state: 'unknown', reason: '완료 런 조회기가 배선되지 않았다' }
      : (() => {
        const { entries, unreadableRuns, missingGoalDocuments, limit } = input.completedRuns;
        if (input.completedRuns.truncated === true && typeof limit !== 'number') {
          return { state: 'unknown' as const, reason: '완료 런 조회 상한 메타데이터가 불완전하다' };
        }
        const truncated = input.completedRuns.truncated === true || (typeof limit === 'number' && entries.length >= limit);
        const missing = missingGoalDocuments !== undefined && missingGoalDocuments > 0 ? { missingGoalDocuments } : {};
        if (unreadableRuns > 0 || missingGoalDocuments) {
          return {
            state: 'unreadableRuns' as const,
            count: entries.length,
            unreadableRuns,
            ...missing,
            ...(truncated ? { truncated: true as const, limit } : {}),
          };
        }
        return truncated
          ? { state: 'truncated' as const, count: entries.length, limit: limit! }
          : { state: 'checked' as const, count: entries.length };
      })();
  const completedRunMatches = input.completedRuns?.entries
    .filter((run) => run.plannedPaths.some((path) => paths.includes(path)))
    .map((run) => ({ ...run, plannedPaths: run.plannedPaths.filter((path) => paths.includes(path)) }))
    .sort((left, right) => left.ledgerDirectory.localeCompare(right.ledgerDirectory) || left.runId.localeCompare(right.runId))
    ?? [];

  const interruptedRuns: PreflightInterruptedRunsStatus = input.interruptedRuns === null
    ? { state: 'unknown', reason: input.interruptedRunsUnknownReason ?? '중단 런 조회 실패' }
    : input.interruptedRuns === undefined
      ? { state: 'unknown', reason: '중단 런 조회기가 배선되지 않았다' }
      : (() => {
        const { entries, unreadableRuns, observationFailures, limit } = input.interruptedRuns;
        const truncated = typeof limit === 'number' && entries.length >= limit;
        const missingGoalDocuments = observationFailures?.unreadableOrMissingGoalDocuments ?? 0;
        if (unreadableRuns > 0 || missingGoalDocuments > 0) {
          return {
            state: 'unreadableRuns' as const,
            count: entries.length,
            unreadableRuns,
            ...(missingGoalDocuments > 0 ? { missingGoalDocuments } : {}),
            ...(observationFailures === undefined ? {} : { observationFailures }),
            ...(truncated ? { truncated: true as const, limit } : {}),
          };
        }
        return truncated
          ? { state: 'truncated' as const, count: entries.length, limit: limit! }
          : { state: 'checked' as const, count: entries.length };
      })();
  const interruptedRunMatches = input.interruptedRuns?.entries
    .filter((run) => run.plannedPaths.some((path) => paths.includes(path)))
    .map((run) => ({ ...run, plannedPaths: run.plannedPaths.filter((path) => paths.includes(path)) }))
    .sort((left, right) => left.ledgerDirectory.localeCompare(right.ledgerDirectory) || left.runId.localeCompare(right.runId))
    ?? [];

  const priorIncompleteRunWindowDays = 30;
  const priorIncompleteRuns: PreflightAxisStatus = input.interruptedRuns === undefined || input.interruptedRuns === null
    ? { state: 'unknown', reason: input.interruptedRunsUnknownReason ?? '중단 런 조회 실패' }
    : input.interruptedRuns.unreadableRuns > 0
      ? { state: 'unknown', reason: `${input.interruptedRuns.unreadableRuns}건 원장 판독 불가` }
      : interruptedRuns.state === 'truncated'
        // ⛔ 잘려도 「최근 30일」 계약은 그대로다 — 창을 «안 걸고» 세면 옛 런·종료 시각 없는 런이
        //    섞여 「최근 수」가 아닌 것을 「최근 수」라 부르게 된다(리뷰가 짚은 자리).
        //    ⇒ 잘린 조회에서도 «같은 창·같은 유효성»을 걸고, 「잘렸다」는 state 로 남긴다.
        //    ⚠️ 그래서 이 count 는 «하한»이다 — 조회가 잘린 만큼 실제는 더 클 수 있다.
        ? (() => {
          // ⛔ 시계가 못 읽히면 «모든 항목이 창 밖»으로 떨어져 `count: 0` 이 «사실처럼» 나온다.
          //    「0」과 「못 셌음」을 다른 값으로 — checked 분기와 «같은 규율»이다.
          const nowMs = input.nowMs ?? Date.now();
          if (!Number.isFinite(nowMs)) return { state: 'unknown' as const, reason: '관측 시각 판독 불가' };
          return { state: 'truncated' as const, count: countWithinRecentWindow(interruptedRunMatches, nowMs, priorIncompleteRunWindowDays), limit: interruptedRuns.limit };
        })()
        : (() => {
          const nowMs = input.nowMs ?? Date.now();
          // ⛔ 두 사유를 «한 이름»에 접지 않는다 — 시계가 나쁜 것과 런 기록이 나쁜 것은 고칠 곳이 다르다.
          if (!Number.isFinite(nowMs)) return { state: 'unknown' as const, reason: '관측 시각 판독 불가' };
          if (interruptedRunMatches.some((run) => !Number.isFinite(run.terminatedAtMs))) {
            return { state: 'unknown' as const, reason: '중단 런 종료 시각 판독 불가' };
          }
          return { state: 'checked' as const, count: countWithinRecentWindow(interruptedRunMatches, nowMs, priorIncompleteRunWindowDays) };
        })();

  const askOutsidePathHints = input.askOutsidePathHints ?? input.askTargetPaths;
  const askTargets = new Set(askOutsidePathHints ?? []);
  const askOutsidePaths = askOutsidePathHints === undefined
    ? []
    : paths.filter((path) => !askTargets.has(path));
  if (askOutsidePaths.length > 0) {
    const band = askOutsidePaths.length >= 6 ? '많음' : '1개 이상';
    warnings.push({
      kind: 'ask-outside-path',
      name: `ask 에 없던 경로 ${askOutsidePaths.length}개`,
      detail: `대상에 들어왔다 (ask ${askTargets.size}개 → 대상 ${paths.length}개): ${askOutsidePaths.join(', ')} — 현재 구간 ${band}; 멈춰 볼지 판단하려면 docs/manual/MANUAL-goal-authoring-method-2026-08-03.md §7 「발견 여섯째」를 확인한다`,
    });
  }
  let unreadableRuns = 0;
  let activeUnfinishedRunCount = 0;
  let inactiveUnfinishedRunCount = 0;
  let unreadableUnfinishedRunAgeCount = 0;
  const unfinishedRunsUnknownReason = input.unfinishedRunsUnknownReason ?? '미완 런 조회 실패';
  const liveRuns: PreflightAxisStatus = input.unfinishedRuns === null
    ? { state: 'unknown', reason: unfinishedRunsUnknownReason }
    : { state: 'checked', count: input.unfinishedRuns.length };
  const activeUnfinishedRuns: PreflightAxisStatus = input.unfinishedRuns === null
    ? { state: 'unknown', reason: unfinishedRunsUnknownReason }
    : { state: 'checked', count: 0 };
  const inactiveUnfinishedRuns: PreflightAxisStatus = input.unfinishedRuns === null
    ? { state: 'unknown', reason: unfinishedRunsUnknownReason }
    : { state: 'checked', count: 0 };
  const unreadableUnfinishedRunAges: PreflightAxisStatus = input.unfinishedRuns === null
    ? { state: 'unknown', reason: unfinishedRunsUnknownReason }
    : { state: 'checked', count: 0 };
  if (input.unfinishedRuns !== null) {
    for (const run of input.unfinishedRuns) {
      if (isTerminatedUnfinishedLifecycle(run.lifecycle)) continue;
      const age = run.lastActivityAgeMs;
      if (typeof age !== 'number' || !Number.isFinite(age)) {
        unreadableUnfinishedRunAgeCount += 1;
      } else if (age < input.liveRunWindowMs) {
        activeUnfinishedRunCount += 1;
      } else {
        inactiveUnfinishedRunCount += 1;
      }
    }
  }
  const activeUnfinishedRunStatus: PreflightAxisStatus = input.unfinishedRuns === null
    ? activeUnfinishedRuns
    : { state: 'checked', count: activeUnfinishedRunCount };
  const inactiveUnfinishedRunStatus: PreflightAxisStatus = input.unfinishedRuns === null
    ? inactiveUnfinishedRuns
    : { state: 'checked', count: inactiveUnfinishedRunCount };
  const unreadableUnfinishedRunAgeStatus: PreflightAxisStatus = input.unfinishedRuns === null
    ? unreadableUnfinishedRunAges
    : { state: 'checked', count: unreadableUnfinishedRunAgeCount };
  if (input.unfinishedRuns !== null) {
    for (const run of input.unfinishedRuns) {
      // ⛔ 예정 경로를 «못 읽었으면» 그 런은 판정 대상이 아니다 — 그러나 «조용히» 넘기지 않고 센다.
      if (!Array.isArray(run.plannedPaths)) { unreadableRuns += 1; continue; }
      const hit = run.plannedPaths.filter((path) => paths.includes(path));
      if (hit.length === 0) continue;
      if (isTerminatedUnfinishedLifecycle(run.lifecycle)) continue;
      const age = run.lastActivityAgeMs;
      // ⛔ 나이가 «성한 수»가 아니면 「살아 있음」으로 치지 않는다 — NaN·음수·무한대를 그대로 믿으면
      //   0 보다 작은 나이가 임계 «안»으로 들어와 엉뚱한 런이 발사를 막는다. 대신 부분성으로 드러낸다.
      if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) { unreadableRuns += 1; continue; }
      if (age > input.liveRunWindowMs) continue;
      const hasRoleInformation = input.askTargetPaths !== undefined && input.askTargetPaths.length > 0;
      const overlapPaths = hasRoleInformation || run.worktreePathTouches !== undefined
        ? hit.map((path): LiveRunOverlapPath => ({
          path,
          role: hasRoleInformation ? (askTargets.has(path) ? 'target' : 'evidence') : 'unknown',
          ...(run.worktreePathTouches?.[path] === undefined ? {} : { worktreeTouch: run.worktreePathTouches[path] }),
        }))
        : undefined;
      const allOverlapPathsAreEvidence = hasRoleInformation
        ? overlapPaths?.every(({ role }) => role === 'evidence')
        : undefined;
      const entry: LaunchPreflightBlocker = {
        kind: 'live-run',
        name: run.runId,
        // ⭐ 경로마다 「대상」인지 「근거」인지를 «말한다» — 판정은 그대로고 문면만 는다.
        detail: `도는 런이 같은 파일을 만진다: ${overlapPaths === undefined ? hit.join(', ') : overlapPaths.map(({ path, role, worktreeTouch }) => `${path}(${role === 'target' ? '대상' : role === 'evidence' ? '근거' : '역할 미상'}${worktreeTouch ? ` · 실제 ${worktreeTouch.state}` : ''})`).join(', ')} — 마지막 활동 ${Math.round(age / 1000)}초 전 · 원장 위치 ${run.ledgerDirectory ?? '(없음)'}`,
        ...(overlapPaths === undefined ? {} : { overlapPaths, ...(allOverlapPathsAreEvidence === undefined ? {} : { allOverlapPathsAreEvidence }) }),
      };
      // 라이브 런 겹침은 역할과 무관하게 발사를 막지 않는다. 경로·역할 근거는 경고로 남겨 사후 충돌을 잴 수 있게 한다.
      warnings.push(entry);
    }
  }

  const recentChangeWindowDays = input.recentChangeWindowDays ?? DEFAULT_RECENT_CHANGE_WINDOW_DAYS;
  const recentChanges: PreflightAxisStatus = input.recentChanges == null
    ? { state: 'unknown', reason: input.recentChangesUnknownReason ?? '최근 변경 조회 실패' }
    : { state: 'checked', count: Object.values(input.recentChanges).reduce((total, count) => total + count, 0) };
  const goalRulersUnknownReason = input.goalRulersUnknownReason ?? '골 문서 또는 규율 판독 불가';
  const premiseMockedBySignal: PreflightAxisStatus = input.premiseMockedBySignal == null
    ? { state: 'unknown', reason: goalRulersUnknownReason }
    : { state: 'checked', count: input.premiseMockedBySignal };
  const invariantFunctionExits: PreflightAxisStatus = input.invariantFunctionExits == null
    ? { state: 'unknown', reason: goalRulersUnknownReason }
    : { state: 'checked', count: input.invariantFunctionExits };
  if (input.recentChanges != null) {
    for (const path of paths) {
      const count = input.recentChanges[path] ?? 0;
      if (count > 0) {
        warnings.push({
          kind: 'recent-change',
          name: path,
          detail: `최근 ${recentChangeWindowDays}일 안에 ${count}건 변경됨 — 이 골이 원한 능력이 이미 있을 수 있으니 사람이 읽는다`,
        });
      }
    }
  }

  const preexistingFailures: PreflightPreexistingFailuresStatus = input.preexistingFailures
    ?? (input.preexistingFailureTestFiles === undefined
      ? { state: 'unreadable', reason: input.preexistingFailuresUnknownReason ?? 'gate preexisting 실패 기록 조회기가 배선되지 않았다' }
      : input.preexistingFailureTestFiles === null
        ? { state: 'unreadable', reason: input.preexistingFailuresUnknownReason ?? 'gate preexisting 실패 기록 조회 실패' }
        : { state: 'checked', files: input.preexistingFailureTestFiles });
  const preexistingFailureRecords = preexistingFailures.state === 'unreadable'
    ? []
    : normalizePreexistingFailureRecords(preexistingFailures);
  const preexistingFailureMatches = preexistingFailures.state === 'unreadable'
    ? []
    : preexistingFailureRecords.flatMap((record) => {
      const directlyTargeted = paths.includes(record.file);
      const reasons = [
        ...(directlyTargeted ? ['직접 지목'] : []),
        ...paths.flatMap((path) => siblingTestPath(path) === record.file ? [`소스 짝: ${path}`] : []),
      ];
      const reconfirmation = record.reconfirmed === true
        ? '그 뒤 재확인됨'
        : record.reconfirmed === false
          ? `그 뒤 재확인 없음 — bun test ${record.file} 로 직접 확인하라`
          : '그 뒤 판단 불가';
      return reasons.length === 0
        ? []
        : [{
          file: record.file,
          observedAt: record.observedAt,
          reconfirmed: record.reconfirmed,
          detail: `${record.file} (${reasons.join('; ')}${directlyTargeted ? `; ${reconfirmation}` : ''})`,
        }];
    });
  const targetPreexistingFailures = preexistingFailures.state === 'unreadable'
    ? preexistingFailures
    : { ...preexistingFailures, files: preexistingFailureMatches.map(({ file }) => file), records: preexistingFailureMatches.map(({ file, observedAt, reconfirmed }) => ({ file, observedAt, reconfirmed })) };
  if (targetPreexistingFailures.state !== 'unreadable' && targetPreexistingFailures.files.length > 0) {
    warnings.push({
      kind: 'recent-change',
      name: 'gate preexisting 실패',
      detail: `gate가 원래부터 실패하던 것으로 기록한 대상 테스트: ${preexistingFailureMatches.map(({ detail, observedAt }) => `${detail} · 관측 ${observedAt ?? '모름'}`).join(', ')} — 이 경고는 발사를 막지 않으며 사람이 읽고 판단한다`,
    });
  }
  if (targetPreexistingFailures.state === 'truncated') {
    warnings.push({
      kind: 'recent-change',
      name: `gate preexisting 실패 기록 조회 상한 ${targetPreexistingFailures.limit}`,
      detail: `gate preexisting 실패 기록 조회가 상한에 닿았다 — 이 상태의 일치 없음은 완전한 검사 결과가 아니며 발사를 막지 않는다`,
    });
  }

  const missingDeclaredPathCount = paths.filter((path) => !existsSync(
    isAbsolute(path) || !input.declaredPathsRoot ? path : resolve(input.declaredPathsRoot, path),
  )).length;

  const result: LaunchPreflightResult = {
    paths, missingDeclaredPathCount, blockers, warnings, openPrs, liveRuns, completedRuns, completedRunMatches, interruptedRuns, interruptedRunMatches,
    priorIncompleteRuns, priorIncompleteRunWindowDays,
    activeUnfinishedRuns: activeUnfinishedRunStatus,
    inactiveUnfinishedRuns: inactiveUnfinishedRunStatus,
    unreadableUnfinishedRunAges: unreadableUnfinishedRunAgeStatus,
    recentChanges, recentChangeWindowDays, premiseMockedBySignal, invariantFunctionExits, preexistingFailures: targetPreexistingFailures,
    unreadableRuns, liveRunWindowMs: input.liveRunWindowMs,
    runningRunsConfidenceAppendix: '',
    ...(input.askMarkerObservation === undefined ? {} : { askMarkerObservation: input.askMarkerObservation }),
    ...(input.declaredPathsRoot === undefined ? {} : { declaredPathsRoot: input.declaredPathsRoot }),
  };
  emitAskMarkerObservation(result);
  return result;
}

function renderAxis(label: string, status: PreflightAxisStatus): string {
  if (status.state === 'checked') return `${label}: ${status.count}건 조회`;
  if (status.state === 'truncated') {
    return `${label}: ⚠️ ${status.count}건 — 상한 ${status.limit} 에 «닿았다» (⛔ 이것은 「전부」가 아니다)`;
  }
  return `${label}: ⚠️ 미지 — ${status.reason} (⛔ 「없음」이 아니다)`;
}

function renderAxisCount(status: PreflightAxisStatus): string {
  if (status.state === 'checked') return `${status.count}건`;
  if (status.state === 'truncated') return `⚠️ ${status.count}건 (상한 ${status.limit})`;
  return `⚠️ 못 셌음 — ${status.reason}`;
}

/** 같은 경로 런을 한 줄에 붙이는 «항목 개수» 상한. 2026-08-26 `#13102` 도입.
 *
 *  ⛔ 이 주석의 앞 판(2026-09-08 · `OBS-T458`)은 틀렸다 — 정정한다(`OBS-T464`·`OBS-T465`).
 *  그 판은 「최대 17,256자 · 상한이 없어 넷 중 하나가 1,000자를 넘었다」고 적었는데,
 *  17,256자는 ***이 상수가 생기기 «전»(~08-25)의 역사***이고, 지금 긴 줄의 원인도 «개수»가 아니다.
 *
 *  📏 재측정(2026-09-08 · `docs/goals/` 전수): 중앙값 128자 · 75% 1,425자.
 *    ~08-25(상수 «전») 최대 ***17,214자***  →  09-08 최대 ***1,789자***
 *    ✅ 이 상수는 «완벽히» 먹는다 — 09-07~08 의 1,000자 초과 줄 ***22건 전부 run id 가 «정확히 5개»***.
 *    ⚠️ 그런데도 1,000자 초과가 09-08 에 ***16건*** 난다.
 *  🔑 ⇒ 길이를 만드는 것은 「id 개수」가 아니라 ***「id 옆에 붙는 «사유 문장 ⊕ 경로»」***다.
 *       이 상수는 그 축을 ***안 덮는다***(덮으라고 만든 것도 아니다).
 *
 *  ⛔ 그러므로 이 상수를 줄여도 그 16건은 안 줄어든다 — 겨냥이 «항목당 길이»여야 한다.
 *  ⛔ 접는 것은 목록뿐이다 — `N건 조회` · `N건 원장 판독 불가` · `같은 경로 N건` 은 참값.
 *  ⛔ 새 config 노브 없음. 숨긴 수와 전부 보기 명령을 같은 줄에 남겨 상한을 감추지 않는다. */
const SAME_PATH_RUN_INLINE_LIMIT = 5;

function renderSamePathRunQuery(paths: readonly string[]): string {
  const encodedPaths = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64url');
  return `bun -e 'const { queryFederatedCompletedRunLedgers: completed, queryFederatedInterruptedRunLedgers: interrupted } = await import("./src/self-implement/run-ledger.ts"); const { resolveLogTargets } = await import("./src/cli/logs-cli.ts"); const { logsDbPath } = await import("./src/mss/logging/log-store.ts"); const paths = JSON.parse(Buffer.from(process.argv.at(-1), "base64url").toString("utf8")); const targets = [...resolveLogTargets({ all: true, includeTest: true }).targets, { name: "current", dbPath: logsDbPath() }]; const runIds = new Set(); for (const path of paths) { const all = { targets, path, limit: undefined }; for (const run of [...completed(all).entries, ...interrupted(all).entries]) runIds.add(run.runId); } console.log([...runIds].sort().join("\\n"));' ${encodedPaths}`;
}

function renderSamePathRunHits(hits: readonly string[], paths: readonly string[]): string {
  if (hits.length === 0) return '';
  const visible = hits.slice(0, SAME_PATH_RUN_INLINE_LIMIT).join(', ');
  const hidden = hits.length - SAME_PATH_RUN_INLINE_LIMIT;
  return hidden > 0
    ? `: ${visible} · ${hidden}건 숨김 — 전부 보기: ${renderSamePathRunQuery(paths)}`
    : `: ${visible}`;
}

function renderCompletedRunsAxis(status: PreflightInterruptedRunsStatus, matches: readonly PreflightCompletedRun[], paths: readonly string[]): string {
  if (status.state === 'unknown') return `완료 런: ⚠️ 미지 — ${status.reason} (⛔ 「없음」이 아니다)`;
  const suffix = status.state === 'truncated' || (status.state === 'unreadableRuns' && status.truncated) ? ` · 상한 ${status.limit} 에 «닿았다»` : '';
  const hits = renderSamePathRunHits(matches.map((run) => `${run.runId} (${run.ledgerDirectory})`), paths);
  const unreadable = status.state === 'unreadableRuns' && status.unreadableRuns > 0 ? ` · ${status.unreadableRuns}건 원장 판독 불가` : '';
  const missingGoals = status.state === 'unreadableRuns' && (status.missingGoalDocuments ?? 0) > 0 ? ` · ${status.missingGoalDocuments}건 골 문서 사라짐` : '';
  return `완료 런: ${status.state === 'unreadableRuns' ? '⚠️ ' : ''}${status.count}건 조회${unreadable}${missingGoals}${suffix} · 같은 경로 ${matches.length}건${hits}`;
}

function renderInterruptedRunObservationFailures(failures: PreflightInterruptedRunObservationFailures | undefined): string {
  if (!failures) return '';
  const failureCounts: Array<readonly [string, number]> = [
    ['원장 로드 예외', failures.ledgerLoadThrows ?? 0],
    ['null 원장', failures.nullLedgers ?? 0],
    ['goalFile 이름 없음', failures.missingGoalFileNames ?? 0],
    ['골 문서 사라짐', failures.unreadableOrMissingGoalDocuments ?? 0],
  ];
  const parts = failureCounts.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}건`);
  return parts.length === 0 ? '' : ` (${parts.join(' · ')})`;
}

function renderInterruptedRunsAxis(status: PreflightInterruptedRunsStatus, matches: readonly PreflightInterruptedRun[], paths: readonly string[]): string {
  const hits = renderSamePathRunHits(matches.map((run) => `${run.runId} (${run.interruptionReason ?? '사유 없음'} · ${run.ledgerDirectory})`), paths);
  if (status.state === 'unreadableRuns') {
    // ⛔ 「골 문서 사라짐」은 `unreadableRuns` 에 «안» 들어간다(#19981) — 그러니 «판독 불가 합계»와 견줄 때 빼야 한다.
    //   🩸 2026-09-23 실물: 안 빼서 「원인별 합계 80건이 전체 0건을 초과」라는 거짓 경고가 났다.
    //   ⚠️ 그 칸은 «섞여» 있다 — ENOENT(사라짐)는 `unreadableRuns` 밖, 그 밖의 읽기 예외는 안이다. 그래서 셋으로 가른다:
    //     unreadableRuns ≥ 전체 합계            → 종전대로(남으면 「기타/미분류」)
    //     나머지 원인 ≤ unreadableRuns < 전체    → 경고 없음(골 문서 일부는 판독 불가 «밖»에 있다)
    //     unreadableRuns < 나머지 원인           → 「초과」(골 문서 칸을 빼고도 넘친다 — 진짜 불일치)
    const allFailures = interruptedRunObservationFailureCount(status.observationFailures);
    const readFailures = allFailures - (status.observationFailures?.unreadableOrMissingGoalDocuments ?? 0);
    const knownFailures = renderInterruptedRunObservationFailures(status.observationFailures);
    const failures = status.observationFailures === undefined
      ? ''
      : allFailures <= status.unreadableRuns
        ? `${knownFailures}${allFailures < status.unreadableRuns ? ` · 기타/미분류 실패 ${status.unreadableRuns - allFailures}건` : ''}`
        : readFailures <= status.unreadableRuns
          ? knownFailures
          : `${knownFailures} · ⚠️ 원인별 합계 ${readFailures}건이 전체 ${status.unreadableRuns}건을 초과`;
    const unreadable = status.unreadableRuns > 0 ? ` · ${status.unreadableRuns}건 원장 판독 불가` : '';
    const missingGoals = status.observationFailures === undefined && (status.missingGoalDocuments ?? 0) > 0
      ? ` · ${status.missingGoalDocuments}건 골 문서 사라짐`
      : '';
    return `중단 런: ⚠️ ${status.count}건 조회${unreadable}${missingGoals}${failures}${status.truncated ? ` · 상한 ${status.limit} 에 «닿았다»` : ''} · 같은 경로 ${matches.length}건${hits}`;
  }
  if (status.state === 'unknown') return `중단 런: ⚠️ 미지 — ${status.reason} (⛔ 「없음」이 아니다)`;
  const suffix = status.state === 'truncated' ? ` · 상한 ${status.limit} 에 «닿았다»` : '';
  return `중단 런: ${status.count}건 조회${suffix} · 같은 경로 ${matches.length}건${hits}`;
}

/** 한 줄 상한 — 기존 중단 런 줄처럼 사유를 전부 이어 붙이지 않는다. */
const REPEATED_INTERRUPTION_REASON_LINE_LIMIT = 200;

function truncateRepeatedInterruptionReason(reason: string, budget: number): string {
  if (budget <= 0) return '';
  if (reason.length <= budget) return reason;
  if (budget === 1) return '…';
  return `${reason.slice(0, budget - 1)}…`;
}

/**
 * 같은 경로 중단 런에서 반복된 사유를 한 줄로 말한다.
 * ⛔ 2건 미만이면 아무 말도 하지 않는다 — 「1건입니다」는 소음이다.
 * ⛔ `renderRepeatedBlockNotice` 를 부르지 않는다. 그 인자는 「막힌 횟수」이고 여기 문턱과 뜻이 다르다.
 * ⛔ `interruptionReason` 이 없는 런은 「같은 사유」로 세지 않는다 — 「없음」과 「못 셌음」은 다른 값이다.
 * 복수 그룹·동률: 반복 건수가 큰 쪽, 같으면 정규화 키 사전순. 표시 문면은 그 그룹에서 처음 본 사유.
 */
export function renderRepeatedInterruptionReasonNotice(
  matches: readonly PreflightInterruptedRun[],
): string | null {
  const groups = new Map<string, { count: number; reason: string }>();
  for (const run of matches) {
    const reason = run.interruptionReason;
    if (reason == null || reason.trim() === '') continue;
    const key = normalizeReviewFindingKey(reason);
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { count: 1, reason: reason.replace(/\s+/g, ' ').trim() });
  }

  let representative: { key: string; count: number; reason: string } | null = null;
  for (const [key, group] of groups) {
    if (group.count < 2) continue;
    if (
      representative == null
      || group.count > representative.count
      || (group.count === representative.count && key < representative.key)
    ) {
      representative = { key, count: group.count, reason: group.reason };
    }
  }
  if (representative == null) return null;

  const prefix = `[preflight] 🔁 같은 사유 ${representative.count}건/${matches.length}건 — `;
  const shortReason = truncateRepeatedInterruptionReason(
    representative.reason,
    REPEATED_INTERRUPTION_REASON_LINE_LIMIT - prefix.length,
  );
  return `${prefix}${shortReason}`;
}

export type LaunchPreflightPhase = 'before-authoring' | 'before-launch';

/** 사람이 읽는 한 화면. ⛔ 막혔든 아니든 «무엇을 봤는지»를 항상 낸다.
 *  ⛔ `forced` 를 주면 마지막 줄이 «실제 결정»과 일치한다 — 뚫고 가면서 「발사하지 않는다」라고
 *     적으면 그 산출이 거짓이 된다(2026-08-11 리뷰 should-fix). */
export function renderLaunchPreflight(
  result: LaunchPreflightResult,
  forced = false,
  phase: LaunchPreflightPhase = 'before-launch',
): string {
  emitAskMarkerObservation(result);
  const lines: string[] = [];
  const declaredPathLine = `[preflight] 요청문이 선언한 대상 경로 ${result.paths.length}개 · 실재하지 않음 ${result.missingDeclaredPathCount}개: ${result.paths.join(', ') || '(없음)'}`;
  lines.push(
    result.missingDeclaredPathCount > 0 && result.declaredPathsRoot
      ? `${declaredPathLine} (기준 ${result.declaredPathsRoot})`
      : declaredPathLine,
  );
  lines.push(`[preflight] ${renderAxis('열린 PR', result.openPrs)}`);
  lines.push(`[preflight] ${renderAxis('미완 런', result.liveRuns)} · 그중 지금 도는 것 ${renderAxisCount(result.activeUnfinishedRuns)} · 나이 판독 불가 ${renderAxisCount(result.unreadableUnfinishedRunAges)} · 「도는 중」 임계 ${Math.round(result.liveRunWindowMs / 60000)}분`);
  if (result.runningRunsConfidenceAppendix) lines.push(result.runningRunsConfidenceAppendix);
  const completedRunsAxis = renderCompletedRunsAxis(result.completedRuns, result.completedRunMatches, result.paths);
  lines.push(`[preflight] ${completedRunsAxis}`);
  const interruptedMatches = result.interruptedRunMatches;
  const interruptedRunsAxis = renderInterruptedRunsAxis(result.interruptedRuns, interruptedMatches, result.paths);
  lines.push(`[preflight] ${interruptedRunsAxis}`);
  const repeatedInterruptionReason = renderRepeatedInterruptionReasonNotice(interruptedMatches);
  if (repeatedInterruptionReason) lines.push(repeatedInterruptionReason);
  lines.push(`[preflight] ${renderAxis('최근 변경', result.recentChanges)} · 최근 변경 임계 ${result.recentChangeWindowDays}일`);
  if (result.premiseMockedBySignal) lines.push(`[preflight] ${renderAxis('전제를 목으로 세운 판정 신호', result.premiseMockedBySignal)} — 원시 관측이며 발사를 막지 않는다`);
  if (result.invariantFunctionExits) lines.push(`[preflight] ${renderAxis('반환 지점 둘 이상 함수', result.invariantFunctionExits)} — 원시 관측이며 발사를 막지 않는다`);
  if (result.preexistingFailures.state === 'unreadable') {
    lines.push(`[preflight] ⚠️ gate preexisting 실패 기록: 못 읽음 — ${result.preexistingFailures.reason} (⛔ 「기록 없음」이 아니다)`);
  } else {
    const records = normalizePreexistingFailureRecords(result.preexistingFailures);
    const observedAtMs = records.flatMap((record) => {
      const timestamp = preexistingFailureObservationTimeMs(record.observedAt);
      return timestamp === null ? [] : [timestamp];
    });
    const unknownObservedAtCount = records.length - observedAtMs.length;
    const oldestAge = observedAtMs.length === 0
      ? '모름'
      : `${Math.max(0, Math.floor((Date.now() - Math.min(...observedAtMs)) / 86_400_000))}일`;
    const oldestLabel = unknownObservedAtCount > 0 ? '시각 확인 가능한 기록 중 가장 오래된 기록' : '가장 오래된 기록';
    const diagnostic = ` · ${oldestLabel} ${oldestAge} 전 · 시각 모름 ${unknownObservedAtCount}개 · 재확인 없음 ${records.filter((record) => record.reconfirmed === false).length}개 · 재확인 판단 불가 ${records.filter((record) => record.reconfirmed === null).length}개`;
    if (result.preexistingFailures.state === 'truncated') {
      lines.push(`[preflight] ⚠️ gate preexisting 실패 기록: 같은 대상 ${result.preexistingFailures.files.length}개${result.preexistingFailures.files.length ? `: ${result.preexistingFailures.files.join(', ')}` : ''}${diagnostic} · 상한 ${result.preexistingFailures.limit} 에 «닿았다» (⛔ 이것은 「전부」가 아니다)`);
    } else if (result.preexistingFailures.files.length > 0) {
      lines.push(`[preflight] ⚠️ gate preexisting 실패 기록: 같은 대상 ${result.preexistingFailures.files.length}개: ${result.preexistingFailures.files.join(', ')}${diagnostic}`);
    }
  }
  // ⛔ 「부분으로 읽었다」를 «값으로» 말한다 — 못 읽은 우주가 있으면 이 결과는 «전부»가 아니다.
  const unreadableTargets = result.preexistingFailures.state === 'unreadable' ? undefined : result.preexistingFailures.unreadableTargets;
  if (unreadableTargets && unreadableTargets.length > 0) {
    lines.push(`[preflight] ⚠️ gate preexisting 실패 기록: 로그 우주 ${unreadableTargets.length}개를 «못 읽었다» — ${unreadableTargets.map((target) => `${target.dbPath} (${target.reason})`).join(', ')} (⛔ 위 목록은 「전부」가 아니다)`);
  }
  if (result.unreadableRuns > 0) {
    lines.push(`[preflight] ⚠️ 그중 ${result.unreadableRuns}건은 예정 경로·나이를 «못 읽어» 판정에서 빠졌다 — 이 검사는 «부분»이다`);
  }
  // ⛔ 「지나갔다」와 「없었다」를 다른 값으로 — 경고는 막든 안 막든 «항상» 보인다.
  const draftWarnings = result.warnings.filter((warning) => warning.kind === 'open-pr');
  if (draftWarnings.length > 0) {
    for (const warning of draftWarnings) lines.push(`[preflight] ⚠️ ${warning.name} — ${warning.detail}`);
    const draftsByPath = new Map<string, LaunchPreflightBlocker[]>();
    for (const warning of draftWarnings) {
      for (const path of warning.draftPaths ?? []) {
        const drafts = draftsByPath.get(path) ?? [];
        drafts.push(warning);
        draftsByPath.set(path, drafts);
      }
    }
    for (const [path, drafts] of draftsByPath) {
      if (drafts.length < 2) continue;
      const numbers = drafts.map((draft) => draft.name.slice(1));
      lines.push(`[preflight] ⚠️ ${path} 을 여는 draft PR ${drafts.length}건: ${drafts.map((draft) => draft.name).join(' ')} — 확인 명령: ${numbers.map((number) => `gh pr view ${number} --json body`).join(' ; ')}`);
    }
  }
  const siblingPrWarnings = result.warnings.filter((warning) => warning.kind === 'sibling-pr');
  for (const warning of siblingPrWarnings) lines.push(`[preflight] ⚠️ ${warning.name} — ${warning.detail}`);
  const liveRunWarnings = result.warnings.filter((warning) => warning.kind === 'live-run');
  for (const warning of liveRunWarnings) lines.push(`[preflight] ⚠️ ${warning.name} — ${warning.detail}`);
  const askOutsidePathWarnings = result.warnings.filter((warning) => warning.kind === 'ask-outside-path');
  for (const warning of askOutsidePathWarnings) lines.push(`[preflight] ⚠️ ${warning.name} — ${warning.detail}`);
  if (result.askMarkerObservation) {
    lines.push(`[preflight] ask 마커 검사 뿌리: ${result.askMarkerObservation.inspectionRoot ?? '기본 저장소'}`);
  }
  const askMarkerWarnings = result.warnings.filter((warning) => warning.kind === 'ask-marker');
  for (const warning of askMarkerWarnings) lines.push(`[preflight] ⚠️ ${warning.name} — ${warning.detail}`);
  const recentChangeWarnings = result.warnings.filter((warning) => warning.kind === 'recent-change');
  if (recentChangeWarnings.length > 0) {
    lines.push(`[preflight] ⚠️ 최근 변경 ${recentChangeWarnings.length}개 대상 경로 — 사람이 읽는다: ${recentChangeWarnings.map((w) => w.name).join(' ')}`);
    for (const warning of recentChangeWarnings.filter((warning) => warning.name === 'gate preexisting 실패')) {
      lines.push(`[preflight] ⚠️ ${warning.name} — ${warning.detail}`);
    }
  }
  if (result.blockers.length === 0) {
    if (phase === 'before-authoring') {
      lines.push('[preflight] ✅ 막는 것 없음 — 예비 검사 완료; 저작 뒤 확정 재검사가 한 번 더 온다');
    } else {
      lines.push(result.warnings.length > 0
        ? `[preflight] ✅ 막는 것 없음 — 확정 검사 완료; 발사로 간다 (경고 ${result.warnings.length}건은 위에 있다)`
        : '[preflight] ✅ 막는 것 없음 — 확정 검사 완료; 발사로 간다');
    }
    return lines.join('\n');
  }
  lines.push(`[preflight] ⛔ 막는 것 ${result.blockers.length}건${forced ? '' : ' — 발사하지 않는다'}`);
  for (const blocker of result.blockers) lines.push(`[preflight]   · ${blocker.name} — ${blocker.detail}`);
  lines.push(forced
    ? '[preflight] ⚠️ --force-preflight — 위 막힘을 «뚫고» 발사한다 (이 우회는 관측에 남는다)'
    : '[preflight] 그래도 가려면 --force-preflight (그 우회는 관측에 남는다) — elanous dev');
  return lines.join('\n');
}

// ── CLI 배선 seam ────────────────────────────────────────────────────────────
// ⛔ 왜 여기 두나: 이 판정을 CLI action 안에 두면 «배선»을 시험할 수 없다(리뷰 must-fix).
//   조회 함수를 주입으로 받아, 「저작 → 검사 → 발사 금지」와 「강제 우회」를 테스트가 문다.

export interface AskPreflightDeps {
  readonly readGoalDocument: (goalFile: string) => string;
  readonly tracedPaths: (document: string) => readonly string[];
  /** 던지면 그 축은 `unknown` 이 된다(⛔ 「없음」이 아니다). */
  readonly listOpenPrs: (limit: number) => readonly PreflightOpenPr[];
  /** 던지면 그 축은 `unknown` 이 된다. */
  readonly listUnfinishedRuns: (path?: string) => readonly PreflightUnfinishedRun[];
  /** 실제 실행 확신 판정. 기본은 테스트 우주까지 포함한 `queryRunningRuns`이며, 실패는 경고 한 줄로만 남긴다. */
  readonly queryRunningRuns?: (options: { includeTest: true }) => RunningRunsResult;
  /** 이미 완료된 런 조회. `plannedPaths`는 원장 정규화 결과라 경로 겹침 판정에 재사용한다. */
  readonly listCompletedRuns?: (limit: number, paths?: string | readonly string[]) => PreflightCompletedRunsQuery;
  /** 이미 종료된 중단 런 조회. `plannedPaths`는 원장 정규화 결과라 경로 겹침 판정에 재사용한다. */
  readonly listInterruptedRuns?: (limit: number, paths?: string | readonly string[]) => PreflightInterruptedRunsQuery;
  /** 경로별 `git log --since … -- <path>` 변경 수. 던지면 `unknown` 이 된다. */
  readonly countRecentChanges?: (paths: readonly string[], windowDays: number) => Readonly<Record<string, number>>;
  /** gate 관측에서 원래부터 실패하던 테스트 기록을 상태와 함께 읽는다. */
  readonly listPreexistingFailureTestFiles?: () => PreflightPreexistingFailuresStatus;
  /** 도는 런의 작업 트리에서 겹친 경로의 실제 변경을 읽는다. 이 값은 관측만 늘리고 차단을 바꾸지 않는다. */
  readonly observeWorktreePathTouches?: (run: PreflightUnfinishedRun, paths: readonly string[]) => Readonly<Record<string, WorktreePathTouchObservation>>;
  /** 시험·예외 주입용. 기본은 하니스 `self-impl/<슬러그>-<8 hex>` 규칙. */
  readonly derivePlannedBranch?: (feature: string) => string;
  /** 골 문서의 전제-목 원시 관측기. 던지면 두 규율 축은 비차단 `unknown`이 된다. */
  readonly findPremiseMockedBySignal?: (source: string) => readonly unknown[];
  /** 골 문서의 함수 반환 지점 원시 관측기. 던지면 두 규율 축은 비차단 `unknown`이 된다. */
  readonly functionExits?: (source: string, fileName?: string) => readonly { readonly exits: number }[];
  /** 안 눌릴 신호 검사기. 던지면 전제 검사 전체를 죽이지 않고 경고 한 줄로만 남긴다. */
  readonly inspectUnpressedDecisionSignals?: (ask: string) => ReturnType<typeof inspectUnpressedDecisionSignals>;
  /** ⭐ 골 문서에서 ***사람이 ask 에 «댄» 대상 경로***만 뽑는다(미주입이면 이 구분을 «안 한다`).
   *
   *  ⛔⭐ 왜 필요한가(2026-08-11 73차 · `[T]` 가 이것으로 막혔다): 충돌 판정이 쓰는 `## TRACED PATHS` 는
   *  ***「바꿀 파일」과 「근거로 읽은 파일」을 섞는다***. 실측: 한 골이 TRACED 8 인데 실제 변경은 3이었고,
   *  나머지 다섯은 *"verified …"* 같은 «근거»였다. 양쪽 런이 다 부풀려지므로 충돌 확률이 곱으로 커진다.
   *  ⇒ 📌 여기서 ***막는 동작은 바꾸지 않는다*** — 놓치는 것보다 낫다. 대신 ***「그게 대상인지 근거인지」를 말한다.***
   *    사람이 그 한 낱말로 「기다릴까 뚫을까」를 1초에 정할 수 있다. */
  readonly askTargetPaths?: (document: string) => readonly string[];
  /** 대상 경로 라벨 «안»에서 거부된 조각(이유 포함). 0건 막음 문면이 「라벨이 없다」와 「있는데 거부됐다」를 가르게 한다. */
  readonly askTargetPathRejections?: (document: string) => readonly AskTargetPathHintRejection[];
}

export interface AskPreflightOptions {
  readonly goalFile: string;
  readonly liveRunWindowMinutes: number;
  readonly recentChangeWindowDays: number;
  readonly openPrsLimit?: number;
  /** 중단 런 원장 조회의 최대 반환 행 수. 상한 도달은 결과의 `truncated` 상태로 남는다. */
  readonly interruptedRunsLimit?: number;
  /** ⛔ 저작 «전» 예비 검사용 — 주면 골 문서를 읽지 않고 이 경로로 판정한다(ask 힌트).
   *  ⚠️ 이것은 «추정»이다. 정본은 저작된 골의 TRACED PATHS 이고 발사 직전에 다시 판정한다. */
  readonly pathsOverride?: readonly string[];
  /** 원 ask 경로와 최종 대상의 차이를 ask-outside-path 경고에 보인다. */
  readonly askOutsidePathHints?: readonly string[];
  /** 상대 선언 경로를 해석할 대상 저장소 뿌리. 라이브 흐름은 `deps.cwd()`를 넘긴다. */
  readonly declaredPathsRoot?: string;
  /** 이번에 쏠 골의 브랜치 이름. 없으면 형제 PR 축의 경고를 내지 않는다. */
  readonly plannedBranch?: string;
  /** 저작 전 ask 원문. 주면 기존 ask-marker-check로 형식을 관측하되 발사를 막지 않는다. */
  readonly askText?: string;
}

export type PlannedBranchResolution =
  | { readonly status: 'explicit'; readonly plannedBranch: string }
  | { readonly status: 'derived'; readonly plannedBranch: string }
  | { readonly status: 'unresolved'; readonly reason: string };

export interface AskPreflightDecision {
  readonly result: LaunchPreflightResult;
  /** 발사해도 되나 — 막는 것이 없거나 사람이 강제했을 때만 true. */
  readonly shouldLaunch: boolean;
  /**
   * 형제 PR 검사에 쓸 브랜치를 «어떻게 얻었는지».
   * `unresolved` 는 「형제 0」(`sibling-pr` 경고 없음)과 ***다른 값***이다 —
   * 「못 구해 안 봤다」와 「봤는데 없다」를 접으면 다음 사람이 이 자리를 다시 판다.
   * ⛔ **선택 필드다.** 필수로 두면 tsc 게이트가 「필수 export 필드 추가」로 보고
   *   저장소 «전체» 검사로 승격해, 이 변경과 무관한 선행 오류 1,386건이 드러난다(2026-08-28 실측).
   */
  readonly plannedBranchResolution?: PlannedBranchResolution;
}

/** 인자 검증 — ⛔ 잘못된 값을 «조용히» 기본값으로 바꾸지 않는다(리뷰 should-fix). */
/** ⛔ 기본값은 «내부 상수»다 — 아무도 안 넘기는 인자를 계약 표면으로 두지 않는다(리뷰 must-fix). */
export const DEFAULT_LIVE_RUN_WINDOW_MINUTES = 30;
export const DEFAULT_INTERRUPTED_RUNS_LIMIT = 200;
export const DEFAULT_RECENT_CHANGE_WINDOW_DAYS = 7;
/** ⛔ 임계 상한: 7일. 분을 ms 로 바꿀 때 안전 정수를 넘지 않게 «현실적인» 상한을 둔다(리뷰 should-fix). */
export const MAX_LIVE_RUN_WINDOW_MINUTES = 7 * 24 * 60;

export function resolveLiveRunWindowMinutes(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIVE_RUN_WINDOW_MINUTES;
  // ⛔ CLI 는 «문자열»을 준다. `Number()` 에 통째로 맡기면 `1e2`·` 5 ` 같은 것이 조용히 통과한다
  //   ⇒ 사람이 친 문면과 도구가 쓴 값이 갈린다. 그래서 문자열은 «십진 정수 표기»만 받는다.
  if (typeof raw === 'string') {
    // ⛔ trim 하지 «않는다» — ' 5' 를 조용히 5 로 만들면 사람이 친 문면과 도구가 쓴 값이 갈린다.
    //   (리뷰가 잡았다: 내 커밋 메시지는 「거부한다」였는데 코드는 trim 해서 «받고» 있었다)
    if (!/^\d+$/.test(raw)) {
      throw new Error(`--live-run-window 는 양의 정수(분)여야 한다 — 받은 값: ${JSON.stringify(raw)}`);
    }
    const parsed = Number(raw);
    // ⛔ 아주 큰 십진 문자열은 안전 정수를 넘어 «부정확»해진다 — 그것도 거부한다.
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIVE_RUN_WINDOW_MINUTES) {
      throw new Error(`--live-run-window 는 양의 정수(분)여야 한다 — 받은 값: ${JSON.stringify(raw)}`);
    }
    return parsed;
  }
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIVE_RUN_WINDOW_MINUTES) {
    throw new Error(`--live-run-window 는 양의 정수(분)여야 한다 — 받은 값: ${String(raw)}`);
  }
  return value;
}

/** ⛔ 임계 상한: 365일. 「최근」이라 부를 수 있는 범위를 넘으면 그 축은 «최근»이 아니다. */
export const MAX_RECENT_CHANGE_WINDOW_DAYS = 365;

/** ⭐ 셋째 축의 임계 해석기 — `resolveLiveRunWindowMinutes` 와 «같은 규율»을 쓴다:
 *  ⛔ 문자열은 십진 정수 표기만 받고 trim 하지 않는다(사람이 친 문면과 도구가 쓴 값이 갈리면 안 된다). */
/** 중단 런 조회 상한은 비어 있을 때만 기본값을 쓰며, 0·음수·소수는 결과를 왜곡하므로 거부한다. */
export function resolveInterruptedRunsLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_INTERRUPTED_RUNS_LIMIT;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`interruptedRunsLimit 는 양의 안전 정수여야 한다 — 받은 값: ${String(raw)}`);
  }
  return raw;
}

export function resolveRecentChangeWindowDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RECENT_CHANGE_WINDOW_DAYS;
  if (typeof raw === 'string') {
    if (!/^\d+$/.test(raw)) {
      throw new Error(`--recent-change-window 는 양의 정수(일)여야 한다 — 받은 값: ${JSON.stringify(raw)}`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_RECENT_CHANGE_WINDOW_DAYS) {
      throw new Error(`--recent-change-window 는 양의 정수(일)여야 한다 — 받은 값: ${JSON.stringify(raw)}`);
    }
    return parsed;
  }
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RECENT_CHANGE_WINDOW_DAYS) {
    throw new Error(`--recent-change-window 는 양의 정수(일)여야 한다 — 받은 값: ${String(raw)}`);
  }
  return value;
}

/** ⛔⭐⭐⭐ 「맹점 창」을 닫는 첫 조각 — ask 원문에서 «대상 경로 힌트»를 뽑는다.
 *
 *  📏 왜 필요한가(2026-08-11 실측): `dev --ask/--say` 는 ***저작(100~110초) 뒤에*** 전제 검사를 돈다.
 *    그 사이 그 런은 아직 «아무 원장에도 없어서», 두 창이 거의 같은 시각에 발사하면 서로를 못 본다.
 *    그날 두 트랙이 실제로 같은 파일을 겨냥한 골을 각각 저작했고 ***검사가 아니라 사람이 채널로 막았다.***
 *    ⊕ 그리고 그 창 때문에 저작 100초를 «쓰고 나서» 막힌 발사가 그날만 넷이었다.
 *
 *  ⭐ 이 저장소의 ask 는 첫 줄이 `대상 경로: a · b` 로 시작하는 관행이 있다 ⇒ 저작 «전»에 그것으로 예비 검사를 한다.
 *  ⛔ 힌트가 «없으면» 「경로 없음」이 아니라 ***「못 뽑았다」***다 — 빈 배열을 「충돌 없음」으로 읽지 마라.
 *     (호출자는 빈 배열이면 예비 검사를 «건너뛰고» 그 사실을 말해야 한다.)
 *  ⛔ 이것은 «추정»이다 — 저작된 골의 TRACED PATHS 가 정본이고, 발사 직전 검사가 그것으로 다시 판정한다.
 */
export type AskTargetPathHintRejectionReason = 'has-whitespace' | 'not-path-like' | 'empty';

/** ask 첫 줄에서 버린 대상 경로 조각 — 원문을 보존해 사람이 손실을 바로 고친다. */
export interface AskTargetPathHintRejection {
  readonly fragment: string;
  readonly reason: AskTargetPathHintRejectionReason;
}

/** 대상 경로 힌트 파싱의 관측 결과. `labelMissing`은 「0건」과 「못 셌음」을 가른다. */
export interface AskTargetPathHintsParseResult {
  readonly paths: readonly string[];
  readonly rejected: readonly AskTargetPathHintRejection[];
  readonly labelMissing: boolean;
}

export function parseAskTargetPathHintsResult(askText: string): AskTargetPathHintsParseResult {
  // ⛔ 첫 «비어 있지 않은» 줄만 본다 — 본문 전체를 훑으면 산문 속 경로까지 끌려와 오탐이 된다.
  const firstLine = askText.split(/\r?\n/).find((line) => line.trim() !== '');
  if (firstLine === undefined) return { paths: [], rejected: [], labelMissing: true };
  const match = /^\s*(?:대상\s*경로|target\s*paths?)\s*[:：]\s*(.*)$/i.exec(firstLine);
  if (!match) return { paths: [], rejected: [], labelMissing: true };

  const paths: string[] = [];
  const rejected: AskTargetPathHintRejection[] = [];
  for (const fragment of match[1]!.split(/[·,]/)) {
    const piece = fragment.trim().replace(/^`+|`+$/g, '');
    if (piece === '') rejected.push({ fragment, reason: 'empty' });
    // ⛔ 「경로처럼 생긴 것」만 남긴다 — 확장자나 디렉터리 구분자가 있어야 한다.
    else if (!/[/.]/.test(piece)) rejected.push({ fragment, reason: 'not-path-like' });
    else if (/\s/.test(piece)) rejected.push({ fragment, reason: 'has-whitespace' });
    else paths.push(piece);
  }
  return { paths, rejected, labelMissing: false };
}

/** 첫 경로 헤더 뒤 제목을 탐색하는 물리 줄 상한 — 본문 속 `제목:` 오탐을 막는다. */
export const ASK_PROSE_TITLE_SEARCH_LINE_LIMIT = 8;

/** ask의 첫 비어 있지 않은 줄 직후 제한된 범위에서 선택적 산문 제목을 읽는다. */
export function parseAskProseTitle(askText: string): string | undefined {
  const lines = askText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() !== '');
  if (headerIndex < 0) return undefined;

  for (const line of lines.slice(headerIndex + 1, headerIndex + 1 + ASK_PROSE_TITLE_SEARCH_LINE_LIMIT)) {
    const match = /^\s*제목\s*[:：]\s*(.*)$/.exec(line);
    const title = match?.[1]?.trim();
    if (title) return title;
  }
  return undefined;
}

/** 기존 호출자를 위한 호환 래퍼 — 판정과 반환 형태는 바꾸지 않는다. */
export function parseAskTargetPathHints(askText: string): readonly string[] {
  return parseAskTargetPathHintsResult(askText).paths;
}

/** PTY·원장 관측의 부분 판독 불가 축을 각각 이름과 단위로 보존한다. */
function runningRunsConfidenceIndeterminateReason(running: RunningRunsResult, nowMs: number): readonly string[] {
  const reasons: string[] = [];
  const requireNonnegativeSafeInteger = (axis: string, value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`확신 판정 수가 유효하지 않다 (${axis}: ${String(value)})`);
    }
    return value;
  };
  const unknownRuns = requireNonnegativeSafeInteger('판정 불능 런', running.counts.unknown);
  if (unknownRuns > 0) reasons.push(`판정 불능 런 ${unknownRuns}건`);
  const notCountedPtyRefs = requireNonnegativeSafeInteger('notCountedRefCount', running.pty.notCountedRefCount);
  if (notCountedPtyRefs > 0) {
    const notCountedEntries = running.entries.filter((entry) => entry.ptyRefs.length > 0 && !running.countedStatuses.includes(entry.status));
    const ptyUpdatedAts = notCountedEntries.flatMap(({ ptyUpdatedAt }) => {
      if (ptyUpdatedAt === null) return [];
      if (!Number.isSafeInteger(ptyUpdatedAt)) throw new Error(`PTY 마지막 갱신 시각이 유효하지 않다 (${String(ptyUpdatedAt)})`);
      return [ptyUpdatedAt];
    });
    const nullPtyUpdatedAtCount = notCountedEntries.filter((entry) => entry.ptyUpdatedAt === null).length;
    const ageRange = ptyUpdatedAts.length === 0
      ? ''
      : ` · 마지막 갱신 최근 ${Math.round((nowMs - Math.max(...ptyUpdatedAts)) / 86_400_000)}일 전~오래 ${Math.round((nowMs - Math.min(...ptyUpdatedAts)) / 86_400_000)}일 전`;
    const nullCount = ptyUpdatedAts.length === 0 || nullPtyUpdatedAtCount === 0 ? '' : ` · 시각 알 수 없음 ${nullPtyUpdatedAtCount}개`;
    reasons.push(`살아 있는데 안 세어진 PTY ${notCountedPtyRefs}개${ageRange}${nullCount}`);
  }
  if (running.pty.unreadable.length > 0) reasons.push(`PTY 판독 불가 ${running.pty.unreadable.length}곳`);
  const ledgerAxes = [
    ['unreadableLedgerCount', running.ledger.unreadableLedgerCount],
    ['unreadableLedgerDirectoryCount', running.ledger.unreadableLedgerDirectoryCount],
    ['missingLedgerDirectoryCount', running.ledger.missingLedgerDirectoryCount],
    ['unreadableLedgerDirectoryAccessCount', running.ledger.unreadableLedgerDirectoryAccessCount],
    ['indeterminateLedgerDirectoryCount', running.ledger.indeterminateLedgerDirectoryCount],
  ] as const;
  const checkedLedgerAxes = ledgerAxes.map(([axis, value]) => [axis, requireNonnegativeSafeInteger(axis, value)] as const);
  const unreadableLedgerCount = checkedLedgerAxes[0][1];
  const unreadableLedgerDirectoryCount = checkedLedgerAxes[1][1];
  const missingLedgerDirectoryCount = checkedLedgerAxes[2][1];
  // 디렉터리 롤업에는 missing/access/indeterminate 구성요소가 이미 포함된다.
  const ledgerAxisTotal = unreadableLedgerCount + unreadableLedgerDirectoryCount;
  if (!Number.isSafeInteger(ledgerAxisTotal)) {
    throw new Error(`확신 판정 수가 유효하지 않다 (원장 판독 불가 또는 불확정 합계: ${ledgerAxisTotal})`);
  }
  if (unreadableLedgerCount > 0) reasons.push(`원장 판정 불능 ${unreadableLedgerCount}건`);
  if (missingLedgerDirectoryCount > 0) reasons.push(`원장을 가진 적 없는 우주 ${missingLedgerDirectoryCount}곳`);
  return reasons;
}

function oneLineConfidenceFailureDetail(error: unknown): string {
  try {
    const detail = error instanceof Error ? error.message : String(error);
    return detail.replace(/[\r\n\u0085\u2028\u2029]+/gu, ' ').trim() || '오류 내용을 읽지 못했다';
  } catch {
    return '오류 내용을 읽지 못했다';
  }
}

/** 나이 기반 기존 집계와 별도로 실제 PTY·원장을 교차한 확신 판정을 사람이 읽는 한 줄로 만든다. */
export type RunningRunsConfidenceAssessment =
  | {
    readonly assessment: 'available';
    readonly appendix: string;
    readonly confirmedCount: number;
    readonly probableCount: number;
    readonly unknownCount: number;
    readonly population: 'PTY and ledger cross-assessed runs';
    readonly crossAssessment: 'PTY·ledger';
    readonly includesTest: true;
  }
  | {
    readonly assessment: 'unavailable';
    readonly appendix: string;
    readonly failure: string;
    readonly population: 'PTY and ledger cross-assessed runs';
    readonly crossAssessment: 'PTY·ledger';
    readonly includesTest: true;
  };

export function assessRunningRunsConfidence(query: (options: { includeTest: true }) => RunningRunsResult, nowMs: number = Date.now()): RunningRunsConfidenceAssessment {
  try {
    const running = query({ includeTest: true });
    const confirmedCount = running.counts.running;
    const probableCount = running.counts['probable-running'];
    if (!Number.isSafeInteger(confirmedCount) || confirmedCount < 0 || !Number.isSafeInteger(probableCount) || probableCount < 0) {
      throw new Error('확신 판정 수가 유효하지 않다');
    }
    const indeterminateReasons = runningRunsConfidenceIndeterminateReason(running, nowMs);
    const confidence = indeterminateReasons.length === 0
      ? `확정 ${confirmedCount}건 · 추정 ${probableCount}건`
      : `판정된 것 중 확정 ${confirmedCount}건 · 추정 ${probableCount}건 · ${indeterminateReasons.join(' · ')}`;
    return {
      assessment: 'available',
      appendix: `[preflight] 실제 도는 런 확신 판정: ${confidence} (테스트 우주 포함) — 위 「그중 지금 도는 것」은 미완 런의 마지막 활동 나이 모집단, 이 줄은 PTY·원장을 교차한 판정 모집단이라 수가 달라도 정상이다`,
      confirmedCount,
      probableCount,
      unknownCount: running.counts.unknown,
      population: 'PTY and ledger cross-assessed runs',
      crossAssessment: 'PTY·ledger',
      includesTest: true,
    };
  } catch (error) {
    const failure = oneLineConfidenceFailureDetail(error);
    return {
      assessment: 'unavailable',
      appendix: `[preflight] ⚠️ 실제 도는 런 확신 판정을 얻지 못했다 (${failure}) — 위 나이 기반 집계는 그대로이며 이 경고는 발사를 막지 않는다`,
      failure,
      population: 'PTY and ledger cross-assessed runs',
      crossAssessment: 'PTY·ledger',
      includesTest: true,
    };
  }
}

/** 나이 기반 기존 집계와 별도로 실제 PTY·원장을 교차한 확신 판정을 사람이 읽는 한 줄로 만든다. */
export function renderRunningRunsConfidenceAppendix(query: (options: { includeTest: true }) => RunningRunsResult, nowMs: number = Date.now()): string {
  return assessRunningRunsConfidence(query, nowMs).appendix;
}

function resolveAskPlannedBranch(
  opts: AskPreflightOptions,
  goalDocument: string | null,
  derivePlannedBranch: ((feature: string) => string) | undefined,
): PlannedBranchResolution {
  const explicit = opts.plannedBranch?.trim() ?? '';
  if (explicit.length > 0) return { status: 'explicit', plannedBranch: explicit };
  try {
    const feature = (goalDocument ?? '').trim() || [...(opts.pathsOverride ?? [])].join('\n').trim();
    if (feature.length === 0) return { status: 'unresolved', reason: 'no-feature' };
    const plannedBranch = (derivePlannedBranch ?? plannedSelfImplBranch)(feature).trim();
    if (plannedBranch.length === 0) return { status: 'unresolved', reason: 'empty-branch' };
    return { status: 'derived', plannedBranch };
  } catch (error) {
    return {
      status: 'unresolved',
      reason: error instanceof Error ? (error.message.split('\n')[0] ?? 'threw') : String(error),
    };
  }
}

/** 골 파일 하나로 ⑵⑶ 을 모아 판정한다. `force` 는 «막힌 것을 뚫는» 뜻이다. */
export function decideAskPreflight(
  opts: AskPreflightOptions,
  deps: AskPreflightDeps,
  force: boolean,
): AskPreflightDecision {
  const limit = opts.openPrsLimit ?? 200;
  const interruptedRunsLimit = resolveInterruptedRunsLimit(opts.interruptedRunsLimit);
  // ⛔⭐ 「저작 전 예비 검사」 경로 — 골 파일이 «아직 없다». 그때는 ask 힌트를 대상 경로로 쓴다.
  //   ⚠️ 골 문서를 읽지 «않는다» — 없는 파일을 읽으려 하면 여기서 던져 저작 자체가 막힌다.
  let goalDocument: string | null = null;
  let goalRulersUnknownReason: string | undefined;
  if (!opts.pathsOverride) {
    try {
      goalDocument = deps.readGoalDocument(opts.goalFile);
    } catch (error) {
      goalRulersUnknownReason = `골 문서 판독 불가: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
  } else {
    goalRulersUnknownReason = '저작 전 예비 검사에는 골 문서가 없다';
  }
  const tracedPaths = opts.pathsOverride ?? (goalDocument === null ? [] : deps.tracedPaths(goalDocument));
  let premiseMockedBySignal: number | null = null;
  let invariantFunctionExits: number | null = null;
  if (goalDocument !== null) {
    try {
      premiseMockedBySignal = (deps.findPremiseMockedBySignal ?? findPremiseMockedBySignal)(goalDocument).length;
      invariantFunctionExits = (deps.functionExits ?? functionExits)(goalDocument, opts.goalFile).filter(({ exits }) => exits >= 2).length;
    } catch (error) {
      goalRulersUnknownReason = `골 규율 판독 불가: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
  }
  // ⛔ 저작 전에는 pathsOverride 자체가 ask 대상 힌트다. 저작 뒤에는 골에서 뽑은 대상만 역할로 쓴다.
  const askTargetPaths = opts.pathsOverride ?? (goalDocument && deps.askTargetPaths ? deps.askTargetPaths(goalDocument) : []);
  // 저작 뒤에는 접지가 읽은 경로와 선언 대상 경로를 함께 검사한다. 저작 전 pathsOverride는 그대로 쓴다.
  const paths = opts.pathsOverride ?? [...new Set([...tracedPaths, ...askTargetPaths])];
  const askMarkerInspection = opts.askText === undefined
    ? { askText: 'absent' as const, axes: [], warnings: [] }
    : (() => {
      const inspectionRoot = opts.declaredPathsRoot?.trim();
      const axes = inspectionRoot === undefined || inspectionRoot === ''
        ? inspectAskMarkers(opts.askText)
        : inspectAskMarkersInRoot(opts.askText, inspectionRoot);
      const consumerPathWarning = inspectionRoot === undefined || inspectionRoot === ''
        ? inspectConsumerPathWarning(opts.askText)
        : inspectConsumerPathWarningInRoot(opts.askText, inspectionRoot);
      const markerWarnings = [
        ...axes.flatMap((axis) => [
          formatAxis(axis),
          ...formatAxisObservations(axis),
        ].filter((detail) => detail.startsWith('⚠️') || detail.startsWith('❌'))),
        ...(consumerPathWarning ? [consumerPathWarning] : []),
      ];
      // 안 눌릴 신호 축은 뿌리를 쓰지 않는다 — inspectionRoot 유무와 무관하게 같이 부른다.
      const unpressedWarnings = (() => {
        try {
          const unpressed = (deps.inspectUnpressedDecisionSignals ?? inspectUnpressedDecisionSignals)(opts.askText);
          return [formatAxis(unpressed), ...formatAxisObservations(unpressed)]
            .filter((detail) => detail.startsWith('⚠️') || detail.startsWith('❌'));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const firstLine = message.split(/\r\n|\n|\r/, 1)[0] ?? '';
          return [`⚠️ ask 마커 — 안 눌릴 신호 검사 실패: ${firstLine}`];
        }
      })();
      const warnings = [...markerWarnings, ...unpressedWarnings];
      return { askText: 'present' as const, inspectionRoot: inspectionRoot === undefined || inspectionRoot === '' ? ASK_MARKER_REPOSITORY_ROOT : inspectionRoot, axes, warnings };
    })();
  const askMarkerWarnings = askMarkerInspection.warnings
    .map((detail) => ({ kind: 'ask-marker' as const, name: 'ask 마커', detail }));

  let openPrs: readonly PreflightOpenPr[] | null = null;
  let openPrsUnknownReason: string | undefined;
  try {
    openPrs = deps.listOpenPrs(limit);
  } catch (error) {
    openPrsUnknownReason = `열린 PR 조회 실패: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }

  let unfinishedRuns: readonly PreflightUnfinishedRun[] | null = null;
  let unfinishedRunsUnknownReason: string | undefined;
  try {
    unfinishedRuns = deps.listUnfinishedRuns(askTargetPaths.length === 1 ? askTargetPaths[0] : undefined).map((run) => {
      const hit = Array.isArray(run.plannedPaths) ? run.plannedPaths.filter((path) => paths.includes(path)) : [];
      if (hit.length === 0) return run;
      try {
        return { ...run, worktreePathTouches: (deps.observeWorktreePathTouches ?? observeWorktreePathTouches)(run, hit) };
      } catch {
        return {
          ...run,
          worktreePathTouches: Object.fromEntries(hit.map((path) => [path, {
            state: 'unreadable' as const, uncommitted: 'unreadable' as const, committed: 'unreadable' as const,
          }])),
        };
      }
    });
  } catch (error) {
    unfinishedRunsUnknownReason = `미완 런 조회 실패: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }

  let completedRuns: PreflightCompletedRunsQuery | null | undefined;
  let completedRunsUnknownReason: string | undefined;
  if (deps.listCompletedRuns) {
    try {
      completedRuns = deps.listCompletedRuns(interruptedRunsLimit, askTargetPaths.length === 0 ? undefined : askTargetPaths);
    } catch (error) {
      completedRuns = null;
      completedRunsUnknownReason = `완료 런 조회 실패: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
  }

  let interruptedRuns: PreflightInterruptedRunsQuery | null | undefined;
  let interruptedRunsUnknownReason: string | undefined;
  if (deps.listInterruptedRuns) {
    try {
      interruptedRuns = deps.listInterruptedRuns(interruptedRunsLimit, askTargetPaths.length === 0 ? undefined : askTargetPaths);
    } catch (error) {
      interruptedRuns = null;
      interruptedRunsUnknownReason = `중단 런 조회 실패: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
  }

  // ⛔⭐ 셋째 축 «배선» — 이것이 없으면 `countRecentChanges` 는 «호출되지 않는 API 표면»이고
  //   새 축은 런타임에서 영영 `unknown` 이다(2026-08-11 엘라누스 리뷰 must-fix ②).
  //   ⭐ 조회기가 «아예 없을» 때도 「변경 없음」이 아니라 ***「배선되지 않았다」***고 말한다 —
  //     이 저장소의 「0」과 「못 셈」 규율이 여기서도 같다.
  let recentChanges: Readonly<Record<string, number>> | null = null;
  let recentChangesUnknownReason: string | undefined;
  if (!deps.countRecentChanges) {
    recentChangesUnknownReason = '최근 변경 조회기가 배선되지 않았다';
  } else if (paths.length === 0) {
    // ⛔ 대상 경로가 없으면 「최근 변경 0건」이 아니라 «잴 것이 없었다»다.
    recentChangesUnknownReason = '대상 경로가 없어 최근 변경을 재지 못했다';
  } else {
    try {
      recentChanges = deps.countRecentChanges(paths, opts.recentChangeWindowDays);
    } catch (error) {
      recentChangesUnknownReason = `최근 변경 조회 실패: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
  }

  let preexistingFailures: PreflightPreexistingFailuresStatus;
  try {
    preexistingFailures = (deps.listPreexistingFailureTestFiles ?? listPreexistingFailureTestFiles)();
  } catch (error) {
    preexistingFailures = { state: 'unreadable', reason: `gate preexisting 실패 기록 조회 실패: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }

  const runningRunsConfidence = assessRunningRunsConfidence(deps.queryRunningRuns ?? ((options) => queryRunningRuns({ ...options, caller: 'launch-preflight' })), Date.now());
  try {
    debug.log('harness.preflight', 'running-runs-confidence', runningRunsConfidence);
  } catch {
    // Preflight observations never change the launch decision.
  }
  const plannedBranchResolution = resolveAskPlannedBranch(opts, goalDocument, deps.derivePlannedBranch);

  const result = evaluateLaunchPreflight({
    paths,
    ...(opts.declaredPathsRoot === undefined ? {} : { declaredPathsRoot: opts.declaredPathsRoot }),
    openPrs,
    openPrsLimit: limit,
    unfinishedRuns,
    ...(completedRuns === undefined ? {} : { completedRuns }),
    ...(interruptedRuns === undefined ? {} : { interruptedRuns }),
    liveRunWindowMs: opts.liveRunWindowMinutes * 60_000,
    recentChanges,
    premiseMockedBySignal,
    invariantFunctionExits,
    ...(goalRulersUnknownReason ? { goalRulersUnknownReason } : {}),
    preexistingFailures,
    ...(askTargetPaths.length > 0 ? { askTargetPaths } : {}),
    ...(askTargetPaths.length === 0 && goalDocument && deps.askTargetPathRejections
      ? { askTargetPathRejections: deps.askTargetPathRejections(goalDocument) }
      : {}),
    ...(opts.askOutsidePathHints === undefined ? {} : { askOutsidePathHints: opts.askOutsidePathHints }),
    askMarkerObservation: askMarkerInspection,
    // ⛔ `opts.plannedBranch` 가 «아니라» 해석 결과를 쓴다 — 명시가 없으면 스스로 구한 것이 들어가야
    //   형제 경고가 실제로 뜬다. 옛 줄은 명시 값만 통과시켜 이 축이 «영영 안 떴다»(2026-08-28 실측).
    ...(plannedBranchResolution.status === 'unresolved' ? {} : { plannedBranch: plannedBranchResolution.plannedBranch }),
    recentChangeWindowDays: opts.recentChangeWindowDays,
    ...(openPrsUnknownReason ? { openPrsUnknownReason } : {}),
    ...(unfinishedRunsUnknownReason ? { unfinishedRunsUnknownReason } : {}),
    ...(completedRunsUnknownReason ? { completedRunsUnknownReason } : {}),
    ...(interruptedRunsUnknownReason ? { interruptedRunsUnknownReason } : {}),
    ...(recentChangesUnknownReason ? { recentChangesUnknownReason } : {}),
  });
  const decisionResult = { ...result, warnings: [...result.warnings, ...askMarkerWarnings], runningRunsConfidenceAppendix: runningRunsConfidence.appendix };
  emittedAskMarkerObservations.add(decisionResult);
  return {
    result: decisionResult,
    shouldLaunch: result.blockers.length === 0 || force,
    plannedBranchResolution,
  };
}

/** 원장 엔트리 → 전제 검사 입력. ⛔ `as never` 로 형태를 «숨기지» 않는다(리뷰 must-fix).
 *  실제 엔트리는 `plannedPaths` 가 배열이거나 사유 문자열이고, 나이가 없을 수도 있다. */
export function toPreflightUnfinishedRun(entry: unknown): PreflightUnfinishedRun | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const runId = typeof record.runId === 'string' ? record.runId : null;
  if (!runId) return null;
  const rawPaths = record.plannedPaths;
  // ⛔ 배열인데 문자열이 아닌 원소가 섞이면 «조용히 걸러» 빈 배열로 만들지 않는다 —
  //   그러면 malformed 가 unreadableRuns 에도 안 잡힌다(리뷰 should-fix).
  const plannedPaths: readonly string[] | string = Array.isArray(rawPaths)
    ? (rawPaths.every((value) => typeof value === 'string') ? (rawPaths as string[]) : 'planned-paths-malformed')
    : typeof rawPaths === 'string' ? rawPaths : 'planned-paths-unavailable';
  const rawAge = record.lastActivityAgeMs;
  const lastActivityAgeMs = typeof rawAge === 'number' ? rawAge : null;
  const lifecycle = typeof record.lifecycle === 'string' ? record.lifecycle as UnfinishedRunLifecycle : undefined;
  const ledgerDirectory = typeof record.ledgerDirectory === 'string' ? record.ledgerDirectory : undefined;
  const explicitWorktreePath = typeof record.worktreePath === 'string' ? record.worktreePath : undefined;
  const goalId = typeof record.goalId === 'string' ? record.goalId : undefined;
  const ledgerWorktreePaths = explicitWorktreePath || !ledgerDirectory ? [] : (() => {
    try {
      return loadRunLedger(runId, ledgerDirectory)
        ?.flatMap((event) => event.event === 'worktree' && typeof event.data.path === 'string' ? [event.data.path] : []) ?? [];
    } catch {
      return [];
    }
  })();
  const persistedRun = explicitWorktreePath || !ledgerDirectory ? null : loadSelfDevRun(runId, selfDevRunsDir(resolve(ledgerDirectory, '..')));
  const persistedWorktreePaths = persistedRun?.results
    .flatMap((result) => typeof result.worktreePath === 'string' ? [result.worktreePath] : []) ?? [];
  const matchingWorktreePaths = goalId === undefined
    ? persistedWorktreePaths
    : persistedRun?.results.flatMap((result) => result.feature === goalId && typeof result.worktreePath === 'string' ? [result.worktreePath] : []) ?? [];
  const uniqueLedgerWorktreePaths = [...new Set(ledgerWorktreePaths)];
  const uniqueWorktreePaths = [...new Set(matchingWorktreePaths)];
  const worktreePath = explicitWorktreePath
    ?? (uniqueLedgerWorktreePaths.length === 1 ? uniqueLedgerWorktreePaths[0] : undefined)
    ?? (uniqueWorktreePaths.length === 1 ? uniqueWorktreePaths[0] : undefined);
  return {
    runId,
    plannedPaths,
    lastActivityAgeMs,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(ledgerDirectory === undefined ? {} : { ledgerDirectory }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
  };
}

/** 선택된 저작 입력의 종속 인자 검증 — 입력 배타성은 selectDevAuthorInput만 소유한다.
 *  던지면 CLI 가 그대로 실패한다. 반환값은 검증된 임계(분)다. */
export function prepareAskLaunch(
  authorInput: DevAuthorInput | undefined,
  opts: {
    readonly forcePreflight?: unknown;
    readonly liveRunWindow?: unknown;
    readonly recentChangeWindow?: unknown;
  },
): { readonly liveRunWindowMinutes: number; readonly recentChangeWindowDays: number } {
  // ⛔ 종속 인자를 «조용히» 무시하지 않는다 — 사람이 준 것이 아무 일도 안 하면 그것은 거짓 산출이다.
  if (!authorInput && (opts.forcePreflight === true || opts.liveRunWindow !== undefined || opts.recentChangeWindow !== undefined)) {
    throw new Error('--force-preflight · --live-run-window · --recent-change-window 는 --ask 또는 --say 와 함께만 쓴다');
  }
  // ⛔ 저작(100초 넘음)보다 «먼저» 검증한다 — 뒤에 두면 잘못된 인자를 100초 뒤에야 안다.
  return {
    liveRunWindowMinutes: resolveLiveRunWindowMinutes(opts.liveRunWindow),
    recentChangeWindowDays: resolveRecentChangeWindowDays(opts.recentChangeWindow),
  };
}

/** ⛔⭐⭐⭐ 막혔을 때 «묻는다» — 대표 2026-08-11: *"draft·PR 이 열려 있어서 의중을 물어본다거나 할 때…
 *  물음 과정이 있어야 할 것 같은데요"*.
 *
 *  🔎 그때까지: 막히면 `exit 1` 로 끝났고, 「기다릴까 뚫을까」는 ***사람이 100% 스스로*** 판단했다.
 *    그리고 사람이 고른 것을 «아무도 세지 않아서» 임계를 수로 정할 근거도 안 쌓였다.
 *  ⛔ 그래서 이 판은 ***「묻기」만*** 넣는다 — 자동 판정도, 임의 임계도 만들지 않는다.
 *    (임계는 「사람이 실제로 무엇을 골랐나」가 쌓인 «뒤에» 수로 정한다.)
 *  ⛔ 무인 계약은 그대로다 — 대화형이 아니면 종전처럼 막고 끝낸다. */
export type BlockedPromptMode = 'not-blocked' | 'abort-noninteractive' | 'ask';

export function planBlockedPrompt(result: LaunchPreflightResult, interactive: boolean): BlockedPromptMode {
  if (result.blockers.length === 0) return 'not-blocked';
  return interactive ? 'ask' : 'abort-noninteractive';
}

/** 사람이 친 한 줄 → 셋 중 하나. ⛔ 「모르겠다」(빈 줄)는 ***그만두기***다 —
 *  되돌리기 어려운 쪽(발사)을 기본값으로 두지 않는다. */
export type BlockedChoice = 'abort' | 'force' | 'inspect';

export function parseBlockedChoice(reply: string): BlockedChoice {
  const trimmed = reply.trim().toLowerCase();
  if (trimmed === 'f' || trimmed === 'force' || trimmed === '뚫') return 'force';
  if (trimmed === 'i' || trimmed === 'inspect' || trimmed === '보기') return 'inspect';
  return 'abort';
}

/** ⛔ 「무엇을 보면 되나」를 «막은 것마다» 한 줄로 준다 — 사람이 그 자리에서 조회할 수 있게.
 *  ⭐ 여기서 «대신 조회하지» 않는다: 이 층은 순수하고, 조회는 사람이 자기 창에서 한다.
 *    (그리고 그 명령이 산출에 남으면 다음 사람도 같은 길을 쓴다.) */
export function renderBlockedInspection(result: LaunchPreflightResult): string {
  const lines: string[] = ['[preflight] 🔎 막은 것을 이렇게 봅니다:'];
  for (const blocker of result.blockers) {
    if (blocker.kind === 'open-pr') {
      lines.push(`[preflight]   ${blocker.name} → bun bin/elanous.mjs gh pr view ${blocker.name.replace('#', '')} --json title,isDraft,updatedAt,files`);
    } else if (blocker.kind === 'live-run') {
      lines.push(`[preflight]   ${blocker.name} → bun bin/elanous.mjs self run-ledger ${blocker.name} | tail -5`);
    } else {
      lines.push(`[preflight]   ${blocker.name} — ${blocker.detail}`);
    }
  }
  return lines.join('\n');
}

/** ⛔⭐⭐⭐ 「이것이 N번째입니다」 — 🅣 전수(2026-08-11)가 내 물음을 정정한 자리.
 *
 *  📏 실측: 막힘 37건 중 사람이 「기다릴까·뚫을까」를 «막힌 뒤에» 고른 표본은 «0건»이었다.
 *    force 12건은 전부 «처음부터 붙여서 온» 사전 결정이었다.
 *  ⭐ 대신 관측된 행동은 «같은 것을 다시 쳤다» — 같은 경로 집합이 7회 연속 같은 이유로
 *    막혔고(65분) force 는 «한 번도» 안 썼다.
 *  🎯 ⇒ 막는 자리에서 물을 것은 「어떻게 지나갈까」가 아니라 「이것이 N번째라는 걸 아십니까」다.
 *  ⛔ 그리고 이것이 71차 인계 §3 의 「더미의 절반이 같은 골의 반복 저작」에 «기전»을 준다 —
 *    79분에 여섯이 저작된 그 장면과 같은 형태다. 사람은 막힌 줄 모르고 다시 친다.
 */
export interface PriorBlockSample {
  readonly paths: readonly string[];
  readonly blockerKinds: readonly string[];
}

/** ⛔ 「같은 것」의 뜻을 정한다 — 대상 경로 «집합»이 같고 막힌 이유가 겹칠 때.
 *  ⚠️ 골 파일 기준으로 세면 안 된다: `dev --say` 는 매번 «새 골 문서»를 만들어 그 자가 «항상 0» 을 낸다
 *    (🅣 가 그 자를 먼저 의심해서 걸렀다 — 퇴화 검사 ⓑ「항상 영」의 실사례).
 *  ⛔ 셀 수 없으면 0 이 아니라 «못 셌다»여야 하므로, 호출자가 표본을 못 얻으면 이 함수를 «부르지 않는다». */
export function countRepeatedBlocks(
  prior: readonly PriorBlockSample[],
  paths: readonly string[],
  blockerKinds: readonly string[],
): number {
  if (paths.length === 0 || blockerKinds.length === 0) return 0;
  const key = [...paths].sort().join(' ');
  const kinds = new Set(blockerKinds);
  return prior.filter((sample) => {
    if ([...sample.paths].sort().join(' ') !== key) return false;
    return sample.blockerKinds.some((kind) => kinds.has(kind));
  }).length;
}

/** 사람에게 보일 한 줄. ⛔ 0 이면 «아무 말도 하지 않는다» — 「0번째입니다」는 소음이다. */
export function renderRepeatedBlockNotice(count: number): string | null {
  if (count <= 0) return null;
  return `[preflight] 🔁 이 경로 집합은 최근에 «같은 이유로 ${count}번» 막혔습니다`
    + ' — 또 치기 전에 「무엇이 달라졌나」를 보십시오';
}

// ── A2 · 저작의 «맹점 창» ───────────────────────────────────────────────
// 🔎 기전(🅣 가 71차에 발견 · 72차에 재확인): `dev --ask/--say` 는 저작에 100~110초를 쓰는데
//   그 동안 그 런은 ***아무 원장에도 없다***. 그래서 두 창이 동시에 저작하면 서로를 못 본다 —
//   71차에 실제로 두 트랙이 같은 파일(run-ledger.ts)을 칠 뻔했고 «채널 발신»으로만 막았다.
// ⛔ 후보 ⓐ(저작 시작을 원장에 남긴다)는 ***「예정 경로 모름」 항목을 늘려*** 미완 판별을 흐린다.
//   ⇒ 새 상태를 만들지 않고, ***이미 남는 관측***(`ask-pre-preflight`)을 읽는다. 쓰기가 «없다».
// ⛔ 그리고 이것은 ***막는 검사가 아니라 「이름을 대는」 경고***다 — 상대 창이 내 앞선 발사일 수도 있고,
//   그 판단은 사람이 3초에 한다(72차 B1 에서 「수가 아니라 이름으로」가 옳았던 그 결).

/** 저작을 «시작한» 다른 관측 하나. `atMs` 는 그 관측이 남은 시각(epoch ms). */
export interface RecentAuthoringSample {
  readonly atMs: number;
  readonly paths: readonly string[];
}

export interface ConcurrentAuthoringOverlap {
  readonly atMs: number;
  readonly agoMinutes: number;
  readonly sharedPaths: readonly string[];
}

/** ⛔ 창은 «저작 시간»에서 나온다 — 임의 임계가 아니다.
 *  📏 저작 실측이 100~110초이므로, 그 앞뒤를 덮는 5분을 맹점 창으로 본다.
 *  ⚠️ 넓히면 「내 앞선 발사」가 매번 걸려 B1 의 그 병(거의 항상 참 ⇒ 안 읽는다)이 된다. */
export const ASK_AUTHORING_BLIND_WINDOW_MS = 5 * 60_000;

/** 지금 저작하려는 경로와 «겹치는» 최근 저작을 고른다(최신 순).
 *  ⛔ 빈 배열은 「겹침 없음」이고, 호출자가 표본을 «못 얻으면» 이 함수를 부르지 않는다
 *  (0 과 「못 셌음」을 같은 값으로 만들지 않는다 — 이 파일의 기존 규율). */
export function classifyConcurrentAuthoring(
  paths: readonly string[],
  samples: readonly RecentAuthoringSample[],
  nowMs: number,
  windowMs: number = ASK_AUTHORING_BLIND_WINDOW_MS,
): ConcurrentAuthoringOverlap[] {
  const mine = new Set(paths);
  if (mine.size === 0) return [];
  return samples
    .filter((sample) => sample.atMs <= nowMs && nowMs - sample.atMs <= windowMs)
    .flatMap((sample) => {
      const shared = [...new Set(sample.paths)].filter((path) => mine.has(path));
      return shared.length
        ? [{ atMs: sample.atMs, agoMinutes: Math.round((nowMs - sample.atMs) / 60_000), sharedPaths: shared }]
        : [];
    })
    .sort((left, right) => right.atMs - left.atMs);
}

/** ⛔ 「수」가 아니라 «이름»을 준다 — 사람이 그것만으로 「내 앞선 발사인가」를 가른다. */
export function renderConcurrentAuthoringNotice(overlaps: readonly ConcurrentAuthoringOverlap[]): string | null {
  if (overlaps.length === 0) return null;
  const lines = overlaps.slice(0, 3).map(({ agoMinutes, sharedPaths }) =>
    `[preflight]      · ${agoMinutes}분 전 · ${sharedPaths.join(' ')}`);
  return [
    `[preflight] ⚠️ 최근 ${Math.round(ASK_AUTHORING_BLIND_WINDOW_MS / 60_000)}분 안에 «같은 경로»로 저작을 시작한 것이 ${overlaps.length}건 있다`
      + ' — 다른 창일 수도, 내 앞선 발사일 수도 있다(도구는 그것을 못 가른다)',
    ...lines,
  ].join('\n');
}
