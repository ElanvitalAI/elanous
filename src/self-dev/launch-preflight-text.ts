export type WorktreePathTouchAxis = 'touched' | 'untouched' | 'unreadable';

/** 겹친 경로가 실제로 손대어졌는지의 읽기 전용 관측. */
export interface WorktreePathTouchObservation {
  readonly state: 'touched' | 'untouched' | 'unreadable' | 'worktree-unknown';
  readonly uncommitted: WorktreePathTouchAxis | null;
  readonly committed: WorktreePathTouchAxis | null;
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

/** 소스 경로를 같은 디렉터리의 짝 테스트 경로로 순수하게 바꾼다. */
export function siblingTestPath(path: string): string | null {
  return path.endsWith('.ts') && !path.endsWith('.test.ts')
    ? `${path.slice(0, -'.ts'.length)}.test.ts`
    : null;
}

export function normalizePreexistingFailureObservedAt(observedAt: unknown): string | null {
  return typeof observedAt === 'string' && observedAt.trim() !== '' ? observedAt : null;
}

export function normalizePreexistingFailureRecords(status: Exclude<PreflightPreexistingFailuresStatus, { readonly state: 'unreadable' }>): readonly PreflightPreexistingFailureRecord[] {
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
  readonly unreadableRuns: number;
  readonly missingGoalDocuments?: number;
} & (
  | { readonly truncated?: false; readonly limit?: number }
  | { readonly truncated: true; readonly limit: number }
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
  readonly unreadableRuns: number;
  readonly observationFailures?: PreflightInterruptedRunObservationFailures;
  readonly limit?: number;
}

export interface AskMarkerObservation {
  readonly askText: 'absent' | 'present';
  /** ask-marker 판정에 실제로 쓴 대상 루트. 생략해도 기존 저장소 래퍼의 실제 루트를 기록한다. */
  readonly inspectionRoot?: string;
  readonly axes: readonly { readonly label: string; readonly marker: boolean; readonly extracted: boolean }[];
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

export const emittedAskMarkerObservations = new WeakSet<LaunchPreflightResult>();

let askMarkerObserver: ((observation: AskMarkerObservation) => void) | undefined;
export function setAskMarkerObserver(observer: (observation: AskMarkerObservation) => void): void {
  askMarkerObserver = observer;
}

export function emitAskMarkerObservation(result: LaunchPreflightResult): void {
  if (result.askMarkerObservation === undefined || emittedAskMarkerObservations.has(result)) return;
  try {
    askMarkerObserver?.(result.askMarkerObservation);
  } catch {
    // Preflight observations never change the launch decision.
  }
  emittedAskMarkerObservations.add(result);
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
    const key = reason.toLowerCase().replace(/`[^`]*`/g, '').replace(/\d/g, '').replace(/\s+/g, ' ').trim();
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

/** 기존 호출자를 위한 호환 래퍼 — 판정과 반환 형태는 바꾸지 않는다. */
export function parseAskTargetPathHints(askText: string): readonly string[] {
  return parseAskTargetPathHintsResult(askText).paths;
}
