import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { resolveHostId } from '../platform/host-id.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { resolveLogTargets, type LogTarget } from '../cli/logs-cli.js';
import { LogStore } from '../mss/logging/log-store.js';
import { debug } from '../debug/log.js';
import { loadRunLedger, queryUnfinishedRunLedgers, type RunLedgerEntry, type UnfinishedRunLedgerQuery } from './run-ledger.js';
import type { GoalExecutionRecord } from './orchestrator.js';

/**
 * Which observation event supplied this row's child-brain cell.
 * `targetId` is the LogTarget store path (local `eventId` is per-store).
 * Selection is newest `eventAt`, then the reproducible `(targetId, eventId)` pair.
 */
interface GoalRunChildBrainSelection {
  policy: 'newest-headless-spawn';
  targetId: string;
  eventId: number;
  eventAt: string;
}

/**
 * Child-brain cell for one goal-run row.
 * `absent` = no matching spawn (없음).
 * `unspecified` = spawn recorded childLlm as null (지정 안 함).
 * `unknown` = spawn exists but provider/model cannot be read (모른다).
 * `unreadable` = the observation store could not be read (모른다, distinct from absent).
 */
type GoalRunChildBrain =
  | { status: 'recorded'; provider: string; model: string; selectedFrom: GoalRunChildBrainSelection }
  | { status: 'unspecified'; selectedFrom: GoalRunChildBrainSelection }
  | { status: 'unknown'; selectedFrom: GoalRunChildBrainSelection }
  | { status: 'absent' }
  | { status: 'unreadable' };

export interface GoalRunRecord {
  id: number;
  runId: string;
  goalId: string;
  goalFile: string;
  record: GoalExecutionRecord;
  childBrain?: GoalRunChildBrain;
}

function serializeGoalExecutionRecord(record: GoalExecutionRecord): string {
  return JSON.stringify(record);
}

function deserializeGoalExecutionRecord(document: string): GoalExecutionRecord {
  return JSON.parse(document) as GoalExecutionRecord;
}

export interface GoalPriorRun {
  runId: string;
  outcome: GoalExecutionRecord['outcome'];
  stage: GoalExecutionRecord['stage'];
  failureClassification?: GoalExecutionRecord['failureClassification'];
  supervisorVerdict?: GoalExecutionRecord['supervisorVerdict'];
  mustFixDigest: string[];
}

export interface GoalPriorRuns {
  priorRuns: GoalPriorRun[];
  total: number;
  truncated: boolean;
}

export type GoalPriorTermination =
  | {
      status: 'present';
      runId: string;
      outcome: GoalExecutionRecord['outcome'];
      stage: GoalExecutionRecord['stage'];
      failureClassification?: GoalExecutionRecord['failureClassification'];
      classificationBasis?: GoalExecutionRecord['classificationBasis'];
      rounds: number;
      lastReviewFindings?: GoalExecutionRecord['lastReviewFindings'];
    }
  | { status: 'absent' }
  | { status: 'unreadable' };

/** Purely projects the newest prior same-goal terminal record; it never reads or mutates storage. */
export function summarizePriorGoalTermination(records: readonly GoalRunRecord[]): GoalPriorTermination {
  const record = records[0];
  if (!record) return { status: 'absent' };
  const { outcome, stage, rounds, lastReviewFindings } = record.record;
  if (!outcome || !stage || typeof rounds !== 'number' || !Number.isSafeInteger(rounds) || rounds < 0) return { status: 'unreadable' };
  const terminalRounds = rounds;
  return {
    status: 'present',
    runId: record.runId,
    outcome,
    stage,
    ...(record.record.failureClassification ? { failureClassification: record.record.failureClassification } : {}),
    ...(record.record.classificationBasis ? { classificationBasis: record.record.classificationBasis } : {}),
    rounds: terminalRounds,
    ...(lastReviewFindings ? { lastReviewFindings } : {}),
  };
}

export type GoalLatestRunStatus =
  | { kind: 'finished'; outcome: GoalExecutionRecord['outcome'] }
  | { kind: 'unfinished' }
  | { kind: 'no-record' }
  | { kind: 'unavailable' };

export interface GoalLatestRunStatusDeps {
  queryUnfinishedRunLedgers?: () => UnfinishedRunLedgerQuery;
  unfinishedRunLedgers?: UnfinishedRunLedgerQuery;
  loadUnfinishedRunLedger?: (runId: string, ledgerDirectory: string) => readonly RunLedgerEntry[] | null;
  /**
   * ⭐ 레거시 상대경로 행을 맞출 때 쓰는 «기준 디렉토리».
   *
   * ⛔ 종전엔 이 자리가 `process.cwd()` 에 «묶여» 있었다 — 그래서 원장을 «쓴» 프로세스와
   *   «읽는» 프로세스의 작업 디렉토리가 다르면 같은 골 파일인데 0행이 나왔다(2026-08-23 실측:
   *   같은 cwd 1행 · 다른 cwd 0행). 하니스 자식은 격리 worktree 에서 돌므로 이 어긋남이 «기본»이다.
   * ⇒ 호출자가 「그 원장을 쓴 트리」를 줄 수 있게 인자로 꿴다.
   *
   * ⚠️ 안 주면 `process.cwd()` — 즉 **기존 호출자의 동작은 바뀌지 않는다**.
   */
  baseDirectory?: string;
}

type GoalLatestRunCandidate =
  | { kind: 'finished'; runId: string; startedAt: number; id: number; outcome: GoalExecutionRecord['outcome'] }
  | { kind: 'unfinished'; runId: string; startedAt: number };

/**
 * 골 파일 경로를 절대경로로 «못 박는다».
 *
 * ⛔⭐ `resolve(goalFile)` 은 상대경로를 **`process.cwd()` 기준**으로 편다 — 그래서 조회하는
 *   프로세스의 작업 디렉토리가 다르면 «같은 상대경로»가 «다른 절대경로»가 되어 조용히 0행이 났다.
 *   ⇒ 기준을 인자로 받는다. 안 주면 `process.cwd()` 라 기존 동작은 그대로다.
 */
function normalizeGoalFile(goalFile: string, baseDirectory: string = process.cwd()): string {
  return resolve(baseDirectory ?? process.cwd(), goalFile);
}

function unfinishedRunStartedAt(runId: string, ledgerDirectory: string, deps: GoalLatestRunStatusDeps): number {
  const ledger = (deps.loadUnfinishedRunLedger ?? loadRunLedger)(runId, ledgerDirectory);
  const startedAt = ledger?.find((entry) => entry.event === 'start' || entry.event === 'run-start')?.timestamp;
  const timestamp = startedAt === undefined ? NaN : Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) throw new Error(`unfinished run has no valid start timestamp: ${runId}`);
  return timestamp;
}

function latestRunStatus(
  records: readonly GoalRunRecord[],
  goalFile: string,
  unfinished: UnfinishedRunLedgerQuery,
  deps: GoalLatestRunStatusDeps,
): GoalLatestRunStatus {
  if (unfinished.unreadableLedgerCount > 0) return { kind: 'unavailable' };
  // ⛔⭐ 미완 원장의 `goalDocumentPath` 는 «상대경로»일 수 있다 — 그것을 `process.cwd()` 로 펴면
  //   읽는 프로세스의 작업 디렉토리에 따라 «다른 절대경로»가 되어 조용히 매칭이 깨진다.
  //   📏 실측 2026-08-23: 같은 스토어·같은 우주인데 루트 28행 · /tmp 13행. 스토어 축(`byGoalFile`)을
  //     고친 뒤에도 «2건»이 남았고, 그 둘이 전부 `unfinished` — 즉 «이 자리»였다.
  //   ⇒ 골 파일과 원장 항목을 ***같은 기준***으로 편다.
  const goalFileBase = deps.baseDirectory;
  const normalizedGoalFile = normalizeGoalFile(goalFile, goalFileBase);
  const candidates: GoalLatestRunCandidate[] = [];
  for (const record of records) {
    if (record.record.startedAt === undefined) return { kind: 'unavailable' };
    const startedAt = Date.parse(record.record.startedAt);
    if (!Number.isFinite(startedAt)) return { kind: 'unavailable' };
    candidates.push({ kind: 'finished', runId: record.runId, startedAt, id: record.id, outcome: record.record.outcome });
  }
  for (const entry of unfinished.entries) {
    if (entry.goalDocumentPath === null || normalizeGoalFile(entry.goalDocumentPath, goalFileBase) !== normalizedGoalFile) continue;
    candidates.push({
      kind: 'unfinished',
      runId: entry.runId,
      startedAt: unfinishedRunStartedAt(entry.runId, unfinished.ledgerDirectory, deps),
    });
  }
  const latest = candidates.sort((left, right) =>
    right.startedAt - left.startedAt
    || (right.kind === 'finished' ? right.id : -1) - (left.kind === 'finished' ? left.id : -1)
    || right.runId.localeCompare(left.runId)
    || (right.kind === 'finished' ? 1 : 0) - (left.kind === 'finished' ? 1 : 0),
  )[0];
  if (!latest) return { kind: 'no-record' };
  return latest.kind === 'finished' ? { kind: 'finished', outcome: latest.outcome } : { kind: 'unfinished' };
}

function readUnfinishedRunLedgers(deps: GoalLatestRunStatusDeps): UnfinishedRunLedgerQuery {
  return deps.unfinishedRunLedgers ?? (deps.queryUnfinishedRunLedgers ?? queryUnfinishedRunLedgers)();
}

export function loadLatestGoalRunStatusByGoalFile(
  goalFile: string,
  path: string = goalRunDbPath(),
  deps: GoalLatestRunStatusDeps = {},
): GoalLatestRunStatus {
  try {
    const unfinished = readUnfinishedRunLedgers(deps);
    if (unfinished.unreadableLedgerCount > 0) return { kind: 'unavailable' };
    if (!existsSync(path)) return latestRunStatus([], goalFile, unfinished, deps);
    const store = new GoalRunStore(path, true);
    try {
      return latestRunStatus(store.byGoalFile(goalFile, deps.baseDirectory), goalFile, unfinished, deps);
    } finally {
      store.close();
    }
  } catch {
    return { kind: 'unavailable' };
  }
}

export interface GoalRunQuery {
  goalId?: string;
  startedAt?: string;
  outcome?: GoalExecutionRecord['outcome'];
  stage?: GoalExecutionRecord['stage'];
  /**
   * ⭐⭐ **doc JSON 의 «아무 칸»으로 거는 일반 필터** — ⛔ 칸마다 플래그를 늘리지 않기 위해 있다.
   *
   * 🚨 왜 필요한가(2026-08-19 실측): 생성 컬럼은 넷뿐(`started_at`·`outcome`·`rounds`·`executor`)인데
   *   원장 레코드에는 그 뒤로 칸이 계속 늘었다 — 연합 키·`completionIntent`·증거 커버리지·쿼터 증거.
   *   ⇒ 🔑 ***값은 굳었는데 「그 값으로 세는」 길이 없었다***(`F12` 셋째 자리 — 잇기는 한 자리에서 안 끝난다).
   * ⭐ `stage` 필터가 이미 `json_extract` 를 쓰고 있었다 — 재발명이 아니라 «그 길을 일반화»한 것이다.
   */
  docFilters?: readonly GoalRunDocFilter[];
  /**
   * ⭐⭐ **「그 칸이 «있나»」로 세는 필터** — ⛔ `docFilters` 로는 못 묻는 질문이다(값을 알아야 하므로).
   *
   * 🚨 왜 따로 있나(2026-08-19): 이 저장소가 반복해 묻는 것은 ***「착지한 칸이 실제로 «흐르나»」***다
   *   (`F12` 탐지). 그 답은 ***「그 칸을 가진 레코드가 몇이냐」***이고, 값이 무엇인지는 묻지 않는다.
   * ⚠️ 한계: `json_extract` 는 ***칸이 없을 때와 값이 JSON `null` 일 때를 같은 NULL 로*** 낸다.
   *   ⇒ 「있는데 null」은 「없다」로 세어진다. ⛔ 이 한계를 지우려 하지 말고 «알고» 써라.
   */
  docPresent?: readonly string[];
  limit: number;
}

export interface GoalRunDocFilter {
  /** SQLite JSON 경로. 반드시 `$.` 로 시작한다. */
  readonly path: string;
  /** 비교값. ⛔ 텍스트로 캐스팅해 비교하므로 수·문자열이 «같은 문법»으로 걸린다. */
  readonly value: string;
}

/**
 * ⛔ `<경로>=<값>` 한 줄을 필터로 바꾸는 순수 파서. 못 읽으면 «이유를 말하고» null 이 아니라 오류다 —
 * 조용히 무시하면 ***사용자는 「걸었다」고 믿고 «전수»를 본다***(그것이 이 저장소의 「그럴듯한 0」 형태다).
 *
 * ⭐ 값 정규화: JSON 의 `true`/`false` 는 SQLite 에서 `1`/`0` 으로 나오므로 그렇게 바꾼다.
 *   ⛔ 그 외의 값은 «건드리지 않는다» — 손대면 무엇이 매칭되는지가 예측 불가가 된다.
 */
export function parseGoalRunDocPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const path = trimmed.startsWith('$.') ? trimmed : `$.${trimmed}`;
  // ⛔ 경로 문자를 좁힌다 — 바인딩으로 넘기지만, 이상한 경로는 «조용히 0건»을 내므로 미리 막는다.
  if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+$/.test(path)) {
    throw new Error(`doc 경로를 못 읽었다(예: completionIntent · quotaAccountAvailability.to): ${rawPath}`);
  }
  return path;
}

export function parseGoalRunDocFilter(spec: string): GoalRunDocFilter {
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Error(`--doc 는 <경로>=<값> 꼴이어야 한다: ${spec}`);
  const rawValue = spec.slice(eq + 1);
  // ⛔ 경로 해석은 «한 자»만 쓴다 — 둘로 나뉘면 한쪽만 고쳐 조용히 갈린다(이 저장소의 상습 형태).
  const path = parseGoalRunDocPath(spec.slice(0, eq));
  const value = rawValue === 'true' ? '1' : rawValue === 'false' ? '0' : rawValue;
  return { path, value };
}

export interface GoalRunQueryResult {
  records: GoalRunRecord[];
  oldestStartedAt: string | null;
  total: number;
  truncated: boolean;
  /** Goal document path resolved from the goal ledger when the query has a goalId. */
  goalDocumentPath?: string | null;
}

export interface GoalRunLogCategorySummary {
  category: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface GoalRunLogSummary {
  count: number;
  categories: GoalRunLogCategorySummary[];
  instances: string[];
  unreadableInstances: string[];
}

export interface GoalRunInspection {
  runId: string;
  records: GoalRunRecord[];
  ledgerError: string | null;
  logs: GoalRunLogSummary;
}

type GoalRunInspectionWithPriorRuns = GoalRunInspection & {
  priorRuns?: GoalPriorRuns | null;
};

export interface GoalRunInspectionDeps {
  targets?: readonly LogTarget[];
  openLogStore?: (path: string) => Pick<LogStore, 'query' | 'close'>;
}

export interface GoalRunQueryRenderDeps {
  queryUnfinishedRunLedgers?: () => UnfinishedRunLedgerQuery;
}

export interface GoalRunQueryDeps {
  targets?: readonly LogTarget[];
  openLogStore?: (path: string) => Pick<LogStore, 'query' | 'close'>;
}

export function goalRunDbPath(): string {
  return join(elanousStateRoot(), 'self-implement', 'goal-runs.db');
}

/** Read-only description of the current instance's terminal goal-run population. */
export interface GoalRunStorePopulation {
  readonly path: string;
  readonly recordCount: number | null;
  readonly readFailed: boolean;
  readonly missing: boolean;
}

function goalIdFromDocument(goalFile: string): string {
  const document = readFileSync(goalFile, 'utf8');
  const goalId = document.match(/^- GoalId: ([0-9a-f]{16})$/m)?.[1];
  if (!goalId) throw new Error(`goal document has no GoalId: ${goalFile}`);
  return goalId;
}

/** O5 — 기록에 기계 칸이 없으면 «넣는» 프로세스의 값으로 채운다. 이미 있으면 그대로(pod·원격이 실어 온 값이 이긴다). */
export function withRecordOrigin(record: GoalExecutionRecord, origin: () => { hostId: string; hostname: string } = defaultRecordOrigin): GoalExecutionRecord {
  if (record.hostId && record.hostname) return record;
  try {
    const o = origin();
    return { ...record, hostId: record.hostId || o.hostId, hostname: record.hostname || o.hostname };
  } catch {
    return record;   // fail-soft — 출처를 못 읽어도 기록은 남긴다(«모른다»는 빈 칸)
  }
}

function defaultRecordOrigin(): { hostId: string; hostname: string } {
  return { hostId: resolveHostId(), hostname: hostname() };
}

export class GoalRunStore {
  private readonly db: Database;

  constructor(readonly path: string = goalRunDbPath(), readonly readOnly = false, openDatabase: typeof Database = Database) {
    if (readOnly) {
      this.db = new openDatabase(path, { readonly: true });
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run('PRAGMA busy_timeout = 5000');
    const openedAt = Date.now();
    try {
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run(`CREATE TABLE IF NOT EXISTS goal_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        goal_file TEXT NOT NULL,
        doc TEXT NOT NULL,
        started_at TEXT GENERATED ALWAYS AS (json_extract(doc, '$.startedAt')) VIRTUAL,
        outcome TEXT GENERATED ALWAYS AS (json_extract(doc, '$.outcome')) VIRTUAL,
        rounds INTEGER GENERATED ALWAYS AS (json_extract(doc, '$.rounds')) VIRTUAL,
        executor TEXT GENERATED ALWAYS AS (json_extract(doc, '$.model')) VIRTUAL
      )`);
      // RFC 런 출처 O5 — 기계별 집계를 인덱스로. 옛 DB 는 VIRTUAL 생성 열이라 ALTER 로 더할 수 있다(옛 행은 NULL).
      const columns = this.db.query('PRAGMA table_xinfo(goal_run)').all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'host_id')) {
        this.db.run("ALTER TABLE goal_run ADD COLUMN host_id TEXT GENERATED ALWAYS AS (json_extract(doc, '$.hostId')) VIRTUAL");
      }
      this.db.run('CREATE INDEX IF NOT EXISTS goal_run_by_host ON goal_run(host_id, started_at)');
      this.db.run('CREATE INDEX IF NOT EXISTS goal_run_by_goal ON goal_run(goal_id, started_at)');
      this.db.run('CREATE INDEX IF NOT EXISTS goal_run_by_run ON goal_run(run_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS goal_run_by_file ON goal_run(goal_file)');
    } catch (error) {
      this.db.close();
      if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(String(error))) {
        debug.log('store.sqlite', 'busy-lost', { store: 'goal_run', op: 'open', waitedMs: Date.now() - openedAt });
      }
      throw error;
    }
  }

  insert(goalFile: string, record: GoalExecutionRecord, goalId?: string): void {
    const startedAt = Date.now();
    try {
      this.db.run(
        'INSERT INTO goal_run (run_id, goal_id, goal_file, doc) VALUES (?, ?, ?, ?)',
        [record.runId, goalId ?? goalIdFromDocument(goalFile), normalizeGoalFile(goalFile), serializeGoalExecutionRecord(withRecordOrigin(record))],
      );
    } catch (error) {
      if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(String(error))) {
        debug.log('store.sqlite', 'busy-lost', { store: 'goal_run', op: 'insert', waitedMs: Date.now() - startedAt });
      }
      throw error;
    }
  }

  byRunId(runId: string): GoalRunRecord[] {
    return this.recordsQuery('SELECT id, run_id, goal_id, goal_file, doc FROM goal_run WHERE run_id = ? ORDER BY id ASC', runId);
  }

  /**
   * 절대경로 ⊕ 레거시 상대경로 세 형태로 골 파일 행을 찾는다.
   *
   * ⭐ `baseDirectory` 는 «레거시 상대경로»를 맞출 기준이다. 안 주면 `process.cwd()` 라
   *   기존 호출자는 그대로 돈다. ⛔ 그 기본값이 곧 이 축의 결손이었다 — 위 `baseDirectory` 주석 참조.
   */
  byGoalFile(goalFile: string, baseDirectory: string = process.cwd()): GoalRunRecord[] {
    const normalizedGoalFile = normalizeGoalFile(goalFile, baseDirectory);
    const relativeGoalFile = relative(baseDirectory, normalizedGoalFile);
    return this.recordsQuery(
      'SELECT id, run_id, goal_id, goal_file, doc FROM goal_run WHERE goal_file IN (?, ?, ?) ORDER BY id ASC',
      normalizedGoalFile,
      relativeGoalFile,
      `./${relativeGoalFile}`,
    );
  }

  latestByGoalId(goalId: string): GoalRunRecord | undefined {
    return this.recordsQuery('SELECT id, run_id, goal_id, goal_file, doc FROM goal_run WHERE goal_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', goalId)[0];
  }

  recordCount(): number {
    return (this.db.query('SELECT COUNT(*) AS count FROM goal_run').get() as { count: number }).count;
  }

  /**
   * Read population metadata and statuses from one connection-bound SQLite snapshot.
   * Callers must perform every status query that explains the metadata inside `read`.
   */
  withPopulationSnapshot<T>(read: (population: GoalRunStorePopulation) => T): T {
    this.db.run('BEGIN');
    try {
      const result = read({ path: this.path, recordCount: this.recordCount(), readFailed: false, missing: false });
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      try { this.db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }

  latestStatusByGoalFile(goalFile: string, deps: GoalLatestRunStatusDeps = {}): GoalLatestRunStatus {
    try {
      return latestRunStatus(this.byGoalFile(goalFile, deps.baseDirectory), goalFile, readUnfinishedRunLedgers(deps), deps);
    } catch {
      return { kind: 'unavailable' };
    }
  }

  query(filters: GoalRunQuery): GoalRunQueryResult | null {
    if (!Number.isSafeInteger(filters.limit) || filters.limit < 0) {
      throw new RangeError(`goal run query limit must be a non-negative safe integer: ${filters.limit}`);
    }
    try {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filters.goalId) {
        clauses.push('goal_id = ?');
        params.push(filters.goalId);
      }
      if (filters.startedAt) {
        // started_at is a generated column extracted from the doc JSON's startedAt field.
        clauses.push('started_at >= ?');
        params.push(filters.startedAt);
      }
      if (filters.outcome) {
        clauses.push('outcome = ?');
        params.push(filters.outcome);
      }
      if (filters.stage) {
        clauses.push("json_extract(doc, '$.stage') = ?");
        params.push(filters.stage);
      }
      for (const f of filters.docFilters ?? []) {
        // ⛔ 텍스트로 캐스팅해 비교한다 — 안 그러면 `rounds=2` 같은 수 비교가 «조용히 0건»이 된다.
        clauses.push('CAST(json_extract(doc, ?) AS TEXT) = ?');
        params.push(f.path, f.value);
      }
      for (const path of filters.docPresent ?? []) {
        clauses.push('json_extract(doc, ?) IS NOT NULL');
        params.push(path);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = (this.db.query(`SELECT COUNT(*) AS count FROM goal_run ${where}`).get(...params) as { count: number }).count;
      const oldestStartedAt = (this.db.query('SELECT MIN(started_at) AS started_at FROM goal_run').get() as { started_at: string | null }).started_at;
      const rows = this.db.query(`SELECT id, run_id, goal_id, goal_file, doc FROM goal_run ${where} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...params, filters.limit) as Array<{ id: number; run_id: string; goal_id: string; goal_file: string; doc: string }>;
      const records = this.recordsFromRows(rows);
      const goalDocumentPath = filters.goalId
        ? this.latestByGoalId(filters.goalId)?.goalFile ?? null
        : undefined;
      return { records, oldestStartedAt, total, truncated: total > records.length, ...(filters.goalId ? { goalDocumentPath } : {}) };
    } catch {
      return null;
    }
  }

  private priorGoalRecordsByGoalId(goalId: string, limit: number, before?: GoalRunRecord): { records: GoalRunRecord[]; total: number } {
    const beforeClause = before?.record.startedAt
      ? 'AND (started_at < ? OR (started_at = ? AND id < ?))'
      : before
        ? 'AND id < ?'
        : '';
    const beforeParams = before?.record.startedAt
      ? [before.record.startedAt, before.record.startedAt, before.id]
      : before
        ? [before.id]
        : [];
    const result = this.db.query(`
      WITH matching AS (
        SELECT id, run_id, goal_id, goal_file, doc,
          ROW_NUMBER() OVER (ORDER BY started_at DESC, id DESC) AS position
        FROM goal_run
        WHERE goal_id = ? ${beforeClause}
      ), limited AS (
        SELECT id, run_id, goal_id, goal_file, doc, position FROM matching WHERE position <= ?
      )
      SELECT
        (SELECT COUNT(*) FROM matching) AS total,
        COALESCE((SELECT json_group_array(json_object(
          'id', id, 'run_id', run_id, 'goal_id', goal_id, 'goal_file', goal_file, 'doc', doc
        )) FROM (SELECT id, run_id, goal_id, goal_file, doc FROM limited ORDER BY position)), '[]') AS rows
    `).get(goalId, ...beforeParams, limit) as { total: number; rows: string };
    return {
      records: this.recordsFromRows(JSON.parse(result.rows) as Array<{ id: number; run_id: string; goal_id: string; goal_file: string; doc: string }>),
      total: result.total,
    };
  }

  priorRunsByGoalId(goalId: string, limit: number, before?: GoalRunRecord): GoalPriorRuns | null {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError(`prior run limit must be a non-negative safe integer: ${limit}`);
    }
    try {
      const { records, total } = this.priorGoalRecordsByGoalId(goalId, limit, before);
      return {
        priorRuns: records.map(({ runId, record }) => ({
          runId,
          outcome: record.outcome,
          stage: record.stage,
          ...(record.failureClassification ? { failureClassification: record.failureClassification } : {}),
          ...(record.supervisorVerdict ? { supervisorVerdict: record.supervisorVerdict } : {}),
          mustFixDigest: record.lastReviewFindings?.items ?? [],
        })),
        total,
        truncated: total > records.length,
      };
    } catch {
      return null;
    }
  }

  priorTerminationByGoalId(goalId: string, before?: GoalRunRecord): GoalPriorTermination {
    try {
      return summarizePriorGoalTermination(this.priorGoalRecordsByGoalId(goalId, 1, before).records);
    } catch {
      return { status: 'unreadable' };
    }
  }

  close(): void {
    this.db.close();
  }

  private recordsQuery(sql: string, ...params: string[]): GoalRunRecord[] {
    return this.recordsFromRows(this.db.query(sql).all(...params) as Array<{ id: number; run_id: string; goal_id: string; goal_file: string; doc: string }>);
  }

  private recordsFromRows(rows: Array<{ id: number; run_id: string; goal_id: string; goal_file: string; doc: string }>): GoalRunRecord[] {
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      goalId: row.goal_id,
      goalFile: row.goal_file,
      record: deserializeGoalExecutionRecord(row.doc),
    }));
  }
}

/** Persist a terminal goal execution record. Callers own fail-soft handling. */
export function insertGoalRunRecord(
  goalFile: string,
  record: GoalExecutionRecord,
  goalId?: string,
  path: string = goalRunDbPath(),
): void {
  const store = new GoalRunStore(path);
  try {
    store.insert(goalFile, record, goalId);
  } finally {
    store.close();
  }
}

export function loadGoalRunRecordsByRunId(runId: string, path: string = goalRunDbPath()): GoalRunRecord[] {
  const store = new GoalRunStore(path);
  try {
    return store.byRunId(runId);
  } finally {
    store.close();
  }
}

const CHILD_BRAIN_LOG_PAGE_SIZE = 1_000;

function parseJsonObject(data: string | null): Record<string, unknown> | null {
  if (data === null) return null;
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function namedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function childBrainFromPayload(data: Record<string, unknown> | null):
  | { kind: 'recorded'; provider: string; model: string }
  | { kind: 'unspecified' }
  | { kind: 'unknown' } {
  if (!data || !('childLlm' in data)) return { kind: 'unknown' };
  const childLlm = data.childLlm;
  if (childLlm === null) return { kind: 'unspecified' };
  if (!childLlm || typeof childLlm !== 'object' || Array.isArray(childLlm)) return { kind: 'unknown' };
  const provider = namedString((childLlm as Record<string, unknown>).provider);
  const model = namedString((childLlm as Record<string, unknown>).model);
  if (provider && model) return { kind: 'recorded', provider, model };
  return { kind: 'unknown' };
}

interface ChildBrainSpawnCandidate {
  targetId: string;
  eventId: number;
  ts: string;
  data: string | null;
}

function compareSpawnCandidates(left: ChildBrainSpawnCandidate, right: ChildBrainSpawnCandidate): number {
  const leftTime = Date.parse(left.ts);
  const rightTime = Date.parse(right.ts);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.targetId.localeCompare(right.targetId) || left.eventId - right.eventId;
}

function selectNewestSpawn(candidates: readonly ChildBrainSpawnCandidate[]): ChildBrainSpawnCandidate | undefined {
  return candidates.reduce<ChildBrainSpawnCandidate | undefined>((current, candidate) => {
    if (!current) return candidate;
    return compareSpawnCandidates(candidate, current) > 0 ? candidate : current;
  }, undefined);
}

function queryHeadlessSpawnRowsForRunId(
  store: Pick<LogStore, 'query'>,
  runId: string,
): Array<{ id: number; ts: string; data: string | null }> {
  const rows: Array<{ id: number; ts: string; data: string | null }> = [];
  let beforeId: number | undefined;
  do {
    const page = store.query({
      exactCategories: ['self-implement'],
      events: ['headless.spawn'],
      grep: runId,
      limit: CHILD_BRAIN_LOG_PAGE_SIZE,
      ...(beforeId === undefined ? {} : { beforeId }),
    });
    for (const row of page) {
      if (row.category !== 'self-implement' || row.event !== 'headless.spawn') continue;
      if (namedString(parseJsonObject(row.data)?.runId) !== runId) continue;
      rows.push({ id: row.id, ts: row.ts, data: row.data });
    }
    if (page.length < CHILD_BRAIN_LOG_PAGE_SIZE) return rows;
    beforeId = page.at(-1)?.id;
  } while (beforeId !== undefined);
  return rows;
}

function childBrainFromCandidates(candidates: readonly ChildBrainSpawnCandidate[]): GoalRunChildBrain {
  const newest = selectNewestSpawn(candidates);
  if (!newest) return { status: 'absent' };
  const selectedFrom: GoalRunChildBrainSelection = {
    policy: 'newest-headless-spawn',
    targetId: newest.targetId,
    eventId: newest.eventId,
    eventAt: newest.ts,
  };
  const parsed = childBrainFromPayload(parseJsonObject(newest.data));
  if (parsed.kind === 'recorded') {
    return { status: 'recorded', provider: parsed.provider, model: parsed.model, selectedFrom };
  }
  if (parsed.kind === 'unspecified') return { status: 'unspecified', selectedFrom };
  return { status: 'unknown', selectedFrom };
}

function loadChildBrainsByRunId(runIds: readonly string[], deps: GoalRunQueryDeps): {
  byRunId: Map<string, GoalRunChildBrain>;
  anyUnreadable: boolean;
} {
  const scopedRunIds = [...new Set(runIds.filter((runId) => runId.length > 0))];
  const candidatesByRunId = new Map<string, ChildBrainSpawnCandidate[]>();
  let anyUnreadable = false;
  let targets: readonly LogTarget[];
  try {
    if (deps.targets) {
      targets = deps.targets;
    } else {
      const resolved = resolveLogTargets({ all: true, includeTest: true });
      targets = resolved.targets;
      if (resolved.error) anyUnreadable = true;
    }
  } catch {
    return { byRunId: new Map(), anyUnreadable: true };
  }

  if (scopedRunIds.length === 0) return { byRunId: new Map(), anyUnreadable };

  for (const target of targets) {
    let store: Pick<LogStore, 'query' | 'close'> | undefined;
    try {
      store = (deps.openLogStore ?? LogStore.openReadOnly)(target.dbPath);
      for (const runId of scopedRunIds) {
        const candidates = candidatesByRunId.get(runId) ?? [];
        for (const row of queryHeadlessSpawnRowsForRunId(store, runId)) {
          candidates.push({ targetId: target.dbPath, eventId: row.id, ts: row.ts, data: row.data });
        }
        if (candidates.length > 0) candidatesByRunId.set(runId, candidates);
      }
    } catch {
      anyUnreadable = true;
    } finally {
      try { store?.close(); } catch { anyUnreadable = true; }
    }
  }

  const byRunId = new Map<string, GoalRunChildBrain>();
  for (const [runId, candidates] of candidatesByRunId) {
    byRunId.set(runId, childBrainFromCandidates(candidates));
  }
  return { byRunId, anyUnreadable };
}

function attachChildBrains(records: GoalRunRecord[], deps: GoalRunQueryDeps): void {
  if (records.length === 0) return;
  try {
    const { byRunId, anyUnreadable } = loadChildBrainsByRunId(records.map((record) => record.runId), deps);
    for (const record of records) {
      record.childBrain = byRunId.get(record.runId) ?? (anyUnreadable ? { status: 'unreadable' } : { status: 'absent' });
    }
  } catch {
    for (const record of records) {
      record.childBrain = { status: 'unreadable' };
    }
  }
}

export function loadGoalRunQuery(
  filters: GoalRunQuery,
  path: string = goalRunDbPath(),
  deps: GoalRunQueryDeps = {},
): GoalRunQueryResult | null {
  if (path !== ':memory:' && !existsSync(path)) {
    return { records: [], oldestStartedAt: null, total: 0, truncated: false, ...(filters.goalId ? { goalDocumentPath: null } : {}) };
  }
  try {
    const store = new GoalRunStore(path, true);
    try {
      const result = store.query(filters);
      if (result) attachChildBrains(result.records, deps);
      return result;
    } finally {
      store.close();
    }
  } catch (error) {
    debug.log('goal-ledger.read', 'goal-run-query-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasExactRunId(row: { event: string; data: string | null }, runId: string): boolean {
  return [row.event, row.data].some((value) => {
    if (value === runId) return true;
    if (value === null) return false;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed === runId) return true;
      return typeof parsed === 'object' && parsed !== null
        && !Array.isArray(parsed)
        && Object.entries(parsed).some(([key, candidate]) => /(^|_)runId$/i.test(key) && candidate === runId);
    } catch {
      return false;
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function inspectGoalRun(runId: string, path: string = goalRunDbPath(), deps: GoalRunInspectionDeps = {}): GoalRunInspection {
  let records: GoalRunRecord[] = [];
  let ledgerError: string | null = null;
  try {
    if (path !== ':memory:') statSync(path);
    const store = new GoalRunStore(path, true);
    try { records = store.byRunId(runId); } finally { store.close(); }
  } catch (error) {
    if (!isMissingFileError(error)) ledgerError = errorMessage(error);
  }
  const resolved = deps.targets ? { targets: [...deps.targets] } : resolveLogTargets({ all: true, includeTest: true });
  const unreadableInstances: string[] = resolved.error ? [resolved.error] : [];
  const instances: string[] = [];
  const categories = new Map<string, GoalRunLogCategorySummary>();
  let count = 0;
  for (const target of resolved.targets) {
    let store: Pick<LogStore, 'query' | 'close'> | undefined;
    try {
      store = (deps.openLogStore ?? LogStore.openReadOnly)(target.dbPath);
      let beforeId: number | undefined;
      do {
        const rows = store.query({ grep: runId, limit: 1_000, ...(beforeId === undefined ? {} : { beforeId }) });
        if (rows.length === 0) break;
        beforeId = rows.at(-1)!.id;
        for (const row of rows) {
          if (!hasExactRunId(row, runId)) continue;
          count++;
          const prior = categories.get(row.category);
          if (prior) {
            prior.count++;
            if (row.ts < prior.firstAt) prior.firstAt = row.ts;
            if (row.ts > prior.lastAt) prior.lastAt = row.ts;
          } else {
            categories.set(row.category, { category: row.category, count: 1, firstAt: row.ts, lastAt: row.ts });
          }
        }
      } while (beforeId !== undefined);
      instances.push(target.name);
    } catch {
      unreadableInstances.push(target.name);
    } finally {
      try { store?.close(); } catch { unreadableInstances.push(target.name); }
    }
  }
  const result: GoalRunInspectionWithPriorRuns = {
    runId,
    records,
    ledgerError,
    logs: {
      count,
      categories: [...categories.values()].sort((a, b) => a.category.localeCompare(b.category)),
      instances,
      unreadableInstances: [...new Set(unreadableInstances)],
    },
  };
  const target = records.at(-1);
  if (target?.record.outcome === 'abandoned') {
    try {
      const store = new GoalRunStore(path, true);
      try {
        Object.defineProperty(result, 'priorRuns', {
          value: store.priorRunsByGoalId(target.goalId, 1_000, target),
          enumerable: false,
        });
      } finally {
        store.close();
      }
    } catch {
      Object.defineProperty(result, 'priorRuns', { value: null, enumerable: false });
    }
  }
  return result;
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderGoalRunRecurrence(record: GoalRunRecord | undefined, priorRuns: GoalPriorRuns | null | undefined): string | null {
  if (!record || record.record.outcome !== 'abandoned') return null;
  if (priorRuns === null || priorRuns === undefined) return 'recurrence:\nunavailable: prior runs could not be read';
  const seenRunIds = new Set<string>();
  const matching = priorRuns.priorRuns.filter((prior) => {
    if (prior.runId === record.runId || seenRunIds.has(prior.runId)) return false;
    seenRunIds.add(prior.runId);
    return prior.stage === record.record.stage
      && prior.outcome === record.record.outcome
      && prior.failureClassification === record.record.failureClassification
      && prior.supervisorVerdict === record.record.supervisorVerdict;
  });
  const shownRunIds = matching.slice(0, 3).map((prior) => prior.runId);
  if (priorRuns.truncated) {
    const lines = [
      'recurrence:',
      `matching prior failures: at least ${matching.length} in ${priorRuns.priorRuns.length} displayed prior runs`,
      `prior run query truncated: ${priorRuns.total} total prior runs; exact recurrence count and ordinal are unavailable`,
    ];
    if (matching.length === 0) lines.push('no matching prior failure found in the displayed history');
    else lines.push(`prior run IDs from displayed history: ${shownRunIds.join(', ')}`);
    if (matching.length > shownRunIds.length) {
      lines.push(`${matching.length - shownRunIds.length} additional displayed matching prior failure${matching.length === shownRunIds.length + 1 ? '' : 's'} not shown`);
    }
    lines.push(`view all: elanous self goal-run-search --goal ${record.goalId}`);
    return lines.join('\n');
  }

  const lines = ['recurrence:', `matching prior failures: ${matching.length}`];
  if (matching.length === 0) lines.push('no prior failure has the same signature');
  else {
    lines.push(`this is failure #${matching.length + 1} with this signature`);
    lines.push(`prior run IDs: ${shownRunIds.join(', ')}`);
    if (matching.length > shownRunIds.length) {
      lines.push(`${matching.length - shownRunIds.length} additional matching prior failure${matching.length === shownRunIds.length + 1 ? '' : 's'} not shown`);
      lines.push(`view all: elanous self goal-run-search --goal ${record.goalId}`);
    }
  }
  return lines.join('\n');
}

function renderGoalRunReproduction(record: GoalRunRecord | undefined): string {
  if (!record) return 'reproduction:\nmissing anchors: goal record';

  const { goalFile, record: execution } = record;
  const anchors = [
    `goal file: ${goalFile}`,
    `resolved base: ${execution.resolvedBase ?? 'not recorded'}`,
    `PR number: ${execution.prNumber ?? 'not recorded (not required for relaunch)'}`,
    `config root: ${execution.configRoot ?? 'not recorded'}`,
    `state root: ${execution.stateRoot ?? 'not recorded'}`,
  ];
  const missing = [
    !goalFile && 'goalFile',
    !execution.resolvedBase && 'resolvedBase',
    !execution.configRoot && 'configRoot',
    !execution.stateRoot && 'stateRoot',
  ].filter((anchor): anchor is string => Boolean(anchor));
  if (missing.length > 0) return `reproduction:\n${anchors.join('\n')}\nmissing anchors: ${missing.join(', ')}`;

  const configRoot = execution.configRoot!;
  const stateRoot = execution.stateRoot!;
  const sameTestRoot = configRoot === stateRoot && basename(configRoot) === '.elanous-test';
  if (!sameTestRoot) {
    return `${['reproduction:', ...anchors, 'relaunch command unavailable: configRoot and stateRoot cannot be represented exactly by global flags.'].join('\n')}`;
  }
  const relaunchCommand = [
    'bun bin/elanous.mjs',
    `--test=${quotePosixShellArgument(configRoot)}`,
    'dev',
    '--file', quotePosixShellArgument(goalFile),
    '--base', quotePosixShellArgument(execution.resolvedBase!),
  ].join(' ');
  return `${['reproduction:', ...anchors, `relaunch command: ${relaunchCommand}`].join('\n')}`;
}

export function renderGoalRunInspection(result: GoalRunInspection): string {
  const header = [
    `ledger records: ${result.records.length}`,
    `log summary count: ${result.logs.count}`,
    `unreadable instances: ${result.logs.unreadableInstances.length}`,
  ];
  const ledger = result.ledgerError !== null
    ? `ledger error: ${result.ledgerError}`
    : result.records.length === 0
      ? 'ledger: no goal run record'
      : `ledger:\n${renderGoalRunRecords(result.records)}`;
  const logs = result.logs.categories.length === 0
    ? 'logs: no matching logs'
    : `logs:\n${result.logs.categories.map((entry) => `${entry.category}: ${entry.count} (${entry.firstAt} to ${entry.lastAt})`).join('\n')}`;
  const instances = `log instances: ${result.logs.instances.length === 0 ? 'none' : result.logs.instances.join(', ')}`;
  const unreadable = `unreadable instances: ${result.logs.unreadableInstances.length === 0 ? 'none' : result.logs.unreadableInstances.join(', ')}`;
  const target = result.records.at(-1);
  const recurrence = renderGoalRunRecurrence(target, (result as GoalRunInspectionWithPriorRuns).priorRuns);
  const reproduction = renderGoalRunReproduction(target);
  return [...header, '', ledger, logs, instances, unreadable, ...(recurrence ? ['', recurrence] : []), '', reproduction].join('\n');
}

export function renderGoalRunQuery(result: GoalRunQueryResult, deps: GoalRunQueryRenderDeps = {}): string {
  const header = [
    `oldest record: ${result.oldestStartedAt ?? 'none'}`,
    `total matching records: ${result.total}`,
    `truncated: ${result.truncated}`,
  ].join('\n');
  if (result.records.length > 0) return `${header}\n\n${renderGoalRunRecords(result.records)}`;

  try {
    const unfinished = (deps.queryUnfinishedRunLedgers ?? queryUnfinishedRunLedgers)();
    if (unfinished.unreadableLedgerCount > 0) {
      return `${header}\n\nno matching goal run records\nunfinished run count: unavailable (${unfinished.unreadableLedgerCount} ledger${unfinished.unreadableLedgerCount === 1 ? '' : 's'} unreadable)`;
    }
    const terminalStatusMissing = unfinished.entries.filter((entry) => entry.status === 'terminal-status-missing');
    if (result.goalDocumentPath === null) {
      return `${header}\n\nno matching goal run records\nunfinished run count: ${terminalStatusMissing.length} (goal document path unavailable; scope not narrowed)\nmore to inspect:\nquery command: elanous self unfinished-runs`;
    }
    const scopedRuns = result.goalDocumentPath
      ? terminalStatusMissing.filter((entry) => entry.goalDocumentPath === result.goalDocumentPath)
      : terminalStatusMissing;
    if (scopedRuns.length === 0) {
      return `${header}\n\nno matching goal run records\nunfinished run count: 0 (${result.goalDocumentPath ? 'no unfinished runs for this goal' : 'no unfinished run ledgers found'})`;
    }
    return `${header}\n\nno matching goal run records\nunfinished run count: ${scopedRuns.length}${result.goalDocumentPath ? ' (scoped to this goal)' : ' (all goals; query was not narrowed)'}\nmore to inspect:\nquery command: elanous self unfinished-runs`;
  } catch {
    return `${header}\n\nno matching goal run records\nunfinished run count: unavailable (unfinished run ledgers could not be read)`;
  }
}

export function renderGoalRunRecords(records: readonly GoalRunRecord[]): string {
  return records.map((entry) => JSON.stringify(entry)).join('\n');
}
