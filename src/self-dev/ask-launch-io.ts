// ── ask 발사 흐름의 «기본 I/O» — 표면이 둘 이상이라 한 곳에서 만든다 ────────────
//
// ⭐ 왜 있나(2026-08-11 72차 · B2): 이 구현이 `src/index.ts` 안 클로저였는데,
//   TUI 슬래시도 «같은 것»이 필요해지자 ***복제 아니면 추출*** 둘 중 하나가 됐다.
//   72차 판이 복제를 금지했으므로 여기로 옮긴다. CLI 와 TUI 가 «같은 조회»를 쓴다.
// ⛔ 판정은 여기 없다 — 여기는 「무엇을 조회하는가」뿐이고, 「그래서 막나」는 launch-preflight 가 정한다.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import {
  parseAskTargetPathHints,
  parseAskTargetPathHintsResult,
  toPreflightUnfinishedRun,
  type AskPreflightDeps,
  type PreflightCompletedRunsQuery,
  type PreflightInterruptedRunsQuery,
  type PreflightOpenPr,
  type PreflightUnfinishedRun,
} from './launch-preflight.js';
import type { LaunchingTreeProbe } from './ask-launch-flow.js';

export interface InterruptedRunPreflightSource {
  readonly runId: string;
  readonly interruptionReason: string | null;
  /** Terminal ledger event timestamp; absence remains an explicit preflight unknown. */
  readonly terminal?: { readonly timestamp?: string } | null;
  readonly ledgerDirectory: string;
}

export interface CompletedRunPreflightSource {
  readonly runId: string;
  readonly ledgerDirectory: string;
}

export interface CompletedRunPreflightLookup {
  readonly entries: readonly CompletedRunPreflightSource[];
  readonly limit?: number;
  /** 원시 완료 런 조회가 상한에 닿았는지. 경로 추출 후 행 수와 독립적이다. */
  readonly truncated?: boolean;
  readonly unreadableLedgerCount: number;
  /** 원장은 읽혔으나 가리키는 골 문서가 없다. `unreadableLedgerCount` 와 합치지 않는다. */
  readonly goalDocumentMissingCount?: number;
  readonly unreadableLedgerDirectoryCount: number;
  readonly missingLedgerDirectoryCount?: number;
  readonly unreadableLedgerDirectoryAccessCount?: number;
  readonly indeterminateLedgerDirectoryCount?: number;
}

export interface InterruptedRunPreflightLookup {
  readonly entries: readonly InterruptedRunPreflightSource[];
  /** 생산자가 실제로 적용한 조회 상한. 결과가 닿으면 preflight는 `truncated`로 남긴다. */
  readonly limit?: number;
  readonly unreadableLedgerCount: number;
  /** 원장은 읽혔으나 가리키는 골 문서가 없다. `unreadableLedgerCount` 와 합치지 않는다. */
  readonly goalDocumentMissingCount?: number;
  /** 호환용 총합(missing + unreadable + indeterminate). 다른 소비자를 위해 보존한다. */
  readonly unreadableLedgerDirectoryCount: number;
  /** 아직 없는 원장 디렉터리 — 정상 부재이므로 판독 불가에는 세지 않는다. */
  readonly missingLedgerDirectoryCount?: number;
  /** 접근이 막혀 읽지 못한 원장 디렉터리. */
  readonly unreadableLedgerDirectoryAccessCount?: number;
  /** 원장 디렉터리 상태를 판별하지 못한 경우. */
  readonly indeterminateLedgerDirectoryCount?: number;
}

/** `listOpenPrs` 실행 경계 — 테스트가 `gh` 인자와 반환 파싱을 관측하려면 여기를 주입한다. */
export type AskPreflightExecFileSync = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8' },
) => string;

export interface BuildAskPreflightDepsOptions {
  readonly completedRunLookup?: (limit: number, paths?: string | readonly string[]) => CompletedRunPreflightLookup;
  readonly interruptedRunLookup?: (limit: number, paths?: string | readonly string[]) => InterruptedRunPreflightLookup;
  readonly unfinishedRunLookup?: (path?: string) => readonly unknown[];
  readonly loadRunLedger?: (runId: string, ledgerDirectory: string) => Array<{ event: string; data: Record<string, unknown> }> | null;
  readonly readGoalDocument?: (path: string) => string;
  readonly tracedPaths?: (document: string) => readonly string[];
  readonly execFileSync?: AskPreflightExecFileSync;
}

function inspectLaunchingTree(cwd: string): LaunchingTreeProbe {
  try {
    // git-spawn-allow: Reads only local HEAD and cached origin/main ancestry; it never fetches or changes repository state.
    const raw = execFileSync('git', ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'], { cwd, encoding: 'utf8' }).trim();
    const [aheadRaw, behindRaw] = raw.split(/\s+/);
    const ahead = Number(aheadRaw);
    const behind = Number(behindRaw);
    if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
      return { kind: 'unmeasurable', error: `unexpected local Git comparison output: ${JSON.stringify(raw)}` };
    }
    return { kind: 'measured', ahead, behind, reference: 'origin/main (cached)' };
  } catch (error) {
    return { kind: 'unmeasurable', error: String((error as { message?: unknown })?.message ?? error) };
  }
}

/** 발사 전 검사가 쓰는 조회 구현 — ⛔ 이 «한 벌»을 모든 표면이 공유한다. */
export async function buildAskPreflightDeps(options: BuildAskPreflightDepsOptions = {}): Promise<AskPreflightDeps & { inspectLaunchingTree(cwd: string): LaunchingTreeProbe }> {
  const [{ tracedPathReferences, verbatimOriginalAsk }, { loadRunLedger, queryFederatedCompletedRunLedgers, queryFederatedInterruptedRunLedgers, queryFederatedUnfinishedRunLedgers }] = await Promise.all([
    import('../self-implement/goal-author.js'),
    import('../self-implement/run-ledger.js'),
  ]);
  const readInterruptedGoalDocument = (path: string): string => options.readGoalDocument?.(path) ?? readFileSync(path, 'utf8');
  const traceInterruptedGoalPaths = options.tracedPaths ?? ((document: string) => tracedPathReferences(document).map((reference) => reference.path));
  const loadInterruptedRunLedger = options.loadRunLedger ?? loadRunLedger;
  const lookupCompletedRuns = options.completedRunLookup ?? ((limit: number, paths?: string | readonly string[]) => queryFederatedCompletedRunLedgers({
    includeTest: true,
    limit,
    ...(paths === undefined ? {} : typeof paths === 'string' ? { path: paths } : { paths }),
  }));
  const lookupInterruptedRuns = options.interruptedRunLookup ?? ((limit: number, paths?: string | readonly string[]) => queryFederatedInterruptedRunLedgers({
    includeTest: true,
    limit,
    ...(paths === undefined ? {} : typeof paths === 'string' ? { path: paths } : { paths }),
  }));
  const lookupUnfinishedRuns = options.unfinishedRunLookup ?? ((path?: string) => queryFederatedUnfinishedRunLedgers({ includeTest: true, ...(path === undefined ? {} : { path }) }).entries);
  const unreadableLedgerDirectories = (lookup: Pick<CompletedRunPreflightLookup, 'unreadableLedgerDirectoryCount' | 'missingLedgerDirectoryCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount'>): number => {
    const hasDirectoryFailureBreakdown = lookup.missingLedgerDirectoryCount !== undefined
      || lookup.unreadableLedgerDirectoryAccessCount !== undefined
      || lookup.indeterminateLedgerDirectoryCount !== undefined;
    return hasDirectoryFailureBreakdown
      ? lookup.unreadableLedgerDirectoryAccessCount !== undefined
        && lookup.indeterminateLedgerDirectoryCount !== undefined
        ? lookup.unreadableLedgerDirectoryAccessCount + lookup.indeterminateLedgerDirectoryCount
        : lookup.missingLedgerDirectoryCount !== undefined
          ? Math.max(0, lookup.unreadableLedgerDirectoryCount - lookup.missingLedgerDirectoryCount)
          : (lookup.unreadableLedgerDirectoryAccessCount ?? 0) + (lookup.indeterminateLedgerDirectoryCount ?? 0)
      : lookup.unreadableLedgerDirectoryCount;
  };
  const plannedPathsForEntries = (entries: readonly { runId: string; ledgerDirectory: string }[]): { entries: Array<{ runId: string; plannedPaths: readonly string[]; ledgerDirectory: string }>; unreadableRuns: number } => {
    let unreadableRuns = 0;
    const plannedEntries = entries.flatMap((entry) => {
      let ledger: Array<{ event: string; data: Record<string, unknown> }> | null;
      try {
        ledger = loadInterruptedRunLedger(entry.runId, entry.ledgerDirectory);
      } catch {
        unreadableRuns += 1;
        return [];
      }
      if (ledger === null) {
        unreadableRuns += 1;
        return [];
      }
      const goalFile = ledger.find((row) => row.event === 'start' && typeof row.data.goalFile === 'string')?.data.goalFile;
      if (typeof goalFile !== 'string') {
        unreadableRuns += 1;
        return [];
      }
      try {
        return [{ runId: entry.runId, plannedPaths: [...traceInterruptedGoalPaths(readInterruptedGoalDocument(goalFile))], ledgerDirectory: entry.ledgerDirectory }];
      } catch {
        unreadableRuns += 1;
        return [];
      }
    });
    return { entries: plannedEntries, unreadableRuns };
  };
  return {
    inspectLaunchingTree,
    readGoalDocument: (file: string) => readFileSync(file, 'utf8'),
    tracedPaths: (document: string) => tracedPathReferences(document).map(({ path }) => path),
    // ⭐ 충돌 문면이 경로마다 「대상/근거」를 말하게 한다 — ⛔ 판정은 «안» 바꾼다(문면만 는다).
    //   📏 `## TRACED PATHS` 는 「바꿀 파일」과 「근거로 읽은 파일」을 섞는다(실측: 한 골이 TRACED 8 · 변경 3).
    //     ⇒ 사람이 막혔을 때 「그게 근거였네」를 «즉시» 알 수 있어야 한다(`[T]` 가 그것으로 막혔다).
    //   ⛔ ask 표지가 없으면 빈 배열 — 그때는 표시가 «안 붙는다»(지어내지 않는다).
    askTargetPaths: (document: string) => parseAskTargetPathHints(verbatimOriginalAsk(document) ?? ''),
    askTargetPathRejections: (document: string) => parseAskTargetPathHintsResult(verbatimOriginalAsk(document) ?? '').rejected,
    // ⭐ 충돌 문면이 경로마다 「대상/근거」를 말하게 한다 — 판정은 «안» 바꾼다(문면만 는다).
    //   ⛔ TRACED PATHS 는 「바꿀 파일」과 「근거로 읽은 파일」을 섞는다(실측: TRACED 8 · 변경 3).
    //     ⇒ 사람이 막혔을 때 「그게 근거였네」를 «즉시» 알 수 있어야 한다.
    //   ⛔ ask 표지가 없으면 빈 배열 — 그때는 표시가 «안 붙는다»(지어내지 않는다).
    listOpenPrs: (limit: number) => {
      const run = options.execFileSync ?? execFileSync;
      const raw = run('gh', ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,files,isDraft,headRefName'], { encoding: 'utf8' });
      return JSON.parse(String(raw)) as PreflightOpenPr[];
    },
    // ⭐ includeTest: true 는 «의도»다(METHOD v31) — 격리 test 우주의 런도 같은 파일을 만지면 충돌로 본다.
    listUnfinishedRuns: (path?: string) => lookupUnfinishedRuns(path)
      .map((entry: unknown) => toPreflightUnfinishedRun(entry))
      .filter((entry): entry is PreflightUnfinishedRun => entry !== null),
    listCompletedRuns: (limit: number, paths?: string | readonly string[]): PreflightCompletedRunsQuery => {
      const completed = lookupCompletedRuns(limit, paths);
      const planned = plannedPathsForEntries(completed.entries);
      return {
        entries: planned.entries,
        unreadableRuns: completed.unreadableLedgerCount + unreadableLedgerDirectories(completed) + planned.unreadableRuns,
        ...(completed.goalDocumentMissingCount === undefined ? {} : { missingGoalDocuments: completed.goalDocumentMissingCount }),
        ...(completed.truncated === true && typeof completed.limit === 'number'
          ? { limit: completed.limit, truncated: true as const }
          : typeof completed.limit === 'number'
            ? { limit: completed.limit }
            : {}),
      };
    },
    listInterruptedRuns: (limit: number, paths?: string | readonly string[]): PreflightInterruptedRunsQuery => {
      const interrupted = lookupInterruptedRuns(limit, paths);
      const hasDirectoryFailureBreakdown = interrupted.missingLedgerDirectoryCount !== undefined
        || interrupted.unreadableLedgerDirectoryAccessCount !== undefined
        || interrupted.indeterminateLedgerDirectoryCount !== undefined;
      const unreadableLedgerDirectories = hasDirectoryFailureBreakdown
        ? interrupted.unreadableLedgerDirectoryAccessCount !== undefined
          && interrupted.indeterminateLedgerDirectoryCount !== undefined
          ? interrupted.unreadableLedgerDirectoryAccessCount + interrupted.indeterminateLedgerDirectoryCount
          : interrupted.missingLedgerDirectoryCount !== undefined
            ? Math.max(0, interrupted.unreadableLedgerDirectoryCount - interrupted.missingLedgerDirectoryCount)
            : (interrupted.unreadableLedgerDirectoryAccessCount ?? 0) + (interrupted.indeterminateLedgerDirectoryCount ?? 0)
        : interrupted.unreadableLedgerDirectoryCount;
      const unreadableRunsFromLookup = interrupted.unreadableLedgerCount + unreadableLedgerDirectories;
      let unreadableRuns = unreadableRunsFromLookup;
      const observationFailures = {
        ledgerLoadThrows: 0,
        nullLedgers: 0,
        missingGoalFileNames: 0,
        unreadableOrMissingGoalDocuments: interrupted.goalDocumentMissingCount ?? 0,
      };
      const entries = interrupted.entries.flatMap((entry) => {
        let ledger: Array<{ event: string; data: Record<string, unknown> }> | null;
        try {
          ledger = loadInterruptedRunLedger(entry.runId, entry.ledgerDirectory);
        } catch {
          observationFailures.ledgerLoadThrows += 1;
          unreadableRuns += 1;
          return [];
        }
        if (ledger === null) {
          observationFailures.nullLedgers += 1;
          unreadableRuns += 1;
          return [];
        }
        const goalFile = ledger.find((row) => row.event === 'start' && typeof row.data.goalFile === 'string')?.data.goalFile;
        if (typeof goalFile !== 'string') {
          observationFailures.missingGoalFileNames += 1;
          unreadableRuns += 1;
          return [];
        }
        try {
          return [{
            runId: entry.runId,
            plannedPaths: [...traceInterruptedGoalPaths(readInterruptedGoalDocument(goalFile))],
            interruptionReason: entry.interruptionReason,
            ...(typeof entry.terminal?.timestamp === 'string' && Number.isFinite(Date.parse(entry.terminal.timestamp))
              ? { terminatedAtMs: Date.parse(entry.terminal.timestamp) }
              : {}),
            ledgerDirectory: entry.ledgerDirectory,
          }];
        } catch (error) {
          const absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
          observationFailures.unreadableOrMissingGoalDocuments += 1;
          if (!absent) unreadableRuns += 1;
          return [];
        }
      });
      return {
        entries,
        unreadableRuns,
        ...(Object.values(observationFailures).some((count) => count > 0) ? { observationFailures } : {}),
        ...(typeof interrupted.limit === 'number' ? { limit: interrupted.limit } : {}),
      };
    },
    // ⛔ 경로마다 «따로» 센다 — 합쳐 세면 어느 파일이 최근에 바뀌었는지를 잃는다.
    countRecentChanges: (paths: readonly string[], windowDays: number) => {
      const counts: Record<string, number> = {};
      for (const path of paths) {
        // git-spawn-allow: Reads recent commit hashes for this path to count changes and does not modify repository state.
        const raw = execFileSync('git', ['log', `--since=${windowDays}.days`, '--format=%h', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });   // stderr 가 TUI 화면에 새지 않게
        counts[path] = raw.split('\n').filter((line) => line.trim() !== '').length;
      }
      return counts;
    },
  };
}

export interface AskLogRow {
  readonly ts: unknown;
  readonly data: Record<string, unknown> | null;
}

/** ⓪·⑵⑶⑷ 두 층의 발사 검사 관측을 «전 우주»에서 읽는다.
 *  ⛔ 못 얻으면 `null` 을 낸다 — 「0건」과 «못 셌음»을 같은 값으로 만들지 않는다(이 저장소의 상시 규율). */
export async function readAskPreflightLogRows(): Promise<AskLogRow[] | null> {
  try {
    const [{ resolveLogTargets }, { LogStore }] = await Promise.all([
      import('../cli/logs-cli.js'),
      import('../mss/logging/log-store.js'),
    ]);
    const { targets } = resolveLogTargets({ all: true, includeTest: true });
    const rows: AskLogRow[] = [];
    for (const target of targets) {
      const store = new LogStore(target.dbPath, { readonly: true });
      try {
        // ⛔ 두 층을 «다» 읽는다 — ⓪ 막힘만 세거나 ⑵⑶⑷ 막힘만 세면 같은 반복을 절반만 본다.
        for (const row of store.query({ exactCategories: ['dev-pipeline'], events: ['ask-preflight', 'ask-pre-preflight'], limit: 300 })) {
          const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          rows.push({ ts: row.ts, data: (parsed ?? null) as Record<string, unknown> | null });
        }
      } finally { store.close?.(); }
    }
    return rows;
  } catch { return null; }
}

/** Every `ask-preflight` row since `since`, all universes, paged past the 1000-row cap (OVERLAP-METRIC).
 *  ⛔ Unreadable ⇒ `null` — never an empty list that reads as «no overlap launches». */
export async function readAskPreflightRowsSince(since: Date): Promise<AskLogRow[] | null> {
  return readLogRowsSince(since, 'dev-pipeline', 'ask-preflight');
}

/** Every DRAFT-NOT-ARCHIVE `salvaged` row since `since`, all universes (OVERLAP-METRIC salvage siblings).
 *  ⛔ Unreadable ⇒ `null` — a salvage branch we could not see is «unmeasured», not «none». */
export async function readSalvagedRowsSince(since: Date): Promise<AskLogRow[] | null> {
  return readLogRowsSince(since, 'self-implement.draft-not-archive', 'salvaged');
}

async function readLogRowsSince(since: Date, category: string, event: string): Promise<AskLogRow[] | null> {
  try {
    const [{ resolveLogTargets }, { LogStore }] = await Promise.all([
      import('../cli/logs-cli.js'),
      import('../mss/logging/log-store.js'),
    ]);
    const { targets } = resolveLogTargets({ all: true, includeTest: true });
    const rows: AskLogRow[] = [];
    // ⛔ One store can be registered under two names (`~/.monad` → `~/.elanous` symlink) — read each real file once,
    //   or every prod row is counted twice (OVERLAP-METRIC 실측: 169 행 중 69 가 같은 prod 파일의 겹침).
    const seen = new Set<string>();
    for (const target of targets) {
      let real = target.dbPath;
      try { real = realpathSync(target.dbPath); } catch { /* missing store: LogStore below decides */ }
      if (seen.has(real)) continue;
      seen.add(real);
      const store = new LogStore(target.dbPath, { readonly: true });
      try {
        let beforeId: number | undefined;
        for (let page = 0; page < 100; page++) {
          const batch = store.query({ exactCategories: [category], events: [event], sinceMs: since.getTime(),
            limit: 1_000, ...(beforeId === undefined ? {} : { beforeId }) });
          for (const row of batch) {
            const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            rows.push({ ts: row.ts, data: (parsed ?? null) as Record<string, unknown> | null });
          }
          if (batch.length < 1_000) break;
          if (page === 99) return null;
          beforeId = batch.at(-1)!.id;
        }
      } finally { store.close?.(); }
    }
    return rows;
  } catch { return null; }
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** 막힘 반복 계수용 표본 — ⛔ 행을 «못 읽었으면» null 이 그대로 흐른다. */
export function priorBlockSamplesFrom(rows: AskLogRow[] | null): Array<{ paths: string[]; blockerKinds: string[] }> | null {
  if (rows === null) return null;
  return rows.flatMap((row) => {
    const paths = stringList(row.data?.paths);
    const kinds = Array.isArray(row.data?.blockers)
      ? (row.data.blockers as Array<{ kind?: unknown }>).map((entry) => entry?.kind).filter((value): value is string => typeof value === 'string')
      : [];
    return paths.length > 0 && kinds.length > 0 ? [{ paths, blockerKinds: kinds }] : [];
  });
}

/** 동시 저작(맹점 창) 표본 — 같은 이유로 null 이 그대로 흐른다. */
export function recentAuthoringSamplesFrom(rows: AskLogRow[] | null): Array<{ atMs: number; paths: string[] }> | null {
  if (rows === null) return null;
  return rows.flatMap((row) => {
    const paths = stringList(row.data?.paths);
    const atMs = Date.parse(String(row.ts ?? ''));
    return paths.length > 0 && Number.isFinite(atMs) ? [{ atMs, paths }] : [];
  });
}
