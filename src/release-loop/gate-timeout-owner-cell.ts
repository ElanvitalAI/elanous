import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { addItem, checklistHistory, listChecklist } from './checklist.js';

export const GATE_TIMEOUT_UNMEASURABLE_STREAK_THRESHOLD = 3;
const OWNER = 'OPT';
const OWNER_CELL_PREFIX = 'GATE-TIMEOUT-OWNER-';

export type GateTimeoutOwnerCellOutcome = 'unmeasurable' | 'measured';
export type GateTimeoutOwnerCellObservation = {
  at: string;
  version: string;
  commit: string;
  testId: string;
  outcome: GateTimeoutOwnerCellOutcome;
  streak: number;
};

export type GateTimeoutOwnerCellResult = {
  testId: string;
  streak: number;
  threshold: number;
  cellId?: string;
  created: boolean;
};

export type GateTimeoutOwnerCellDeps = {
  ensureCell?: (input: { version: string; id: string; title: string; owner: string }) => boolean;
};

type StoredRow = GateTimeoutOwnerCellObservation;
type SqlRow = Omit<StoredRow, 'commit'> & { commitSha: string };
type PendingCell = { testId: string; version: string; cellId: string; threshold: number; reachedAt: string };
type RecordedRow = { row: StoredRow; fresh: boolean };
type LedgerResult = { records: Map<string, RecordedRow>; pending: PendingCell[] };

function log(event: string, data: Record<string, unknown>): void {
  try { debug.log('release-loop.gate', event, data); } catch { /* observation failure must not affect the gate verdict */ }
}

function cellIdFor(testId: string): string {
  return `${OWNER_CELL_PREFIX}${createHash('sha256').update(testId).digest('hex').slice(0, 16).toUpperCase()}`;
}

function fromSqlRow(row: SqlRow): StoredRow {
  return { at: row.at, version: row.version, commit: row.commitSha, testId: row.testId, outcome: row.outcome, streak: row.streak };
}

function validTestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\r\n\0]/.test(value);
}

function validStoredRow(value: unknown): value is StoredRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StoredRow>;
  return typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) &&
    typeof row.version === 'string' && /^\d+\.\d+\.\d+$/.test(row.version) &&
    typeof row.commit === 'string' && /^[0-9a-f]{40}$/.test(row.commit) &&
    validTestId(row.testId) && (row.outcome === 'measured' || row.outcome === 'unmeasurable') &&
    Number.isSafeInteger(row.streak) && row.streak! >= 0 &&
    (row.outcome === 'unmeasurable' ? row.streak! >= 1 : row.streak === 0);
}

function openLedger(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec(`CREATE TABLE IF NOT EXISTS timeout_observations (
      test_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      version TEXT NOT NULL,
      outcome TEXT NOT NULL,
      streak INTEGER NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (test_id, commit_sha)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS pending_owner_cells (
      test_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      cell_id TEXT NOT NULL UNIQUE,
      threshold INTEGER NOT NULL,
      reached_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS completed_owner_cells (
      test_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      cell_id TEXT NOT NULL UNIQUE,
      completed_at TEXT NOT NULL
    )`);
    chmodSync(path, 0o600);
    return db;
  } catch (error) { db.close(); throw error; }
}

function recordObservations(path: string, version: string, commit: string, threshold: number,
  outcomes: ReadonlyMap<string, GateTimeoutOwnerCellOutcome>): LedgerResult {
  const db = openLedger(path);
  try {
    const records = new Map<string, RecordedRow>();
    db.exec('BEGIN IMMEDIATE');
    try {
      const allRows = db.query('SELECT at, version, commit_sha AS commitSha, test_id AS testId, outcome, streak FROM timeout_observations ORDER BY rowid').all() as SqlRow[];
      const latestByTest = new Map<string, StoredRow>();
      const commitsByTest = new Map<string, Map<string, StoredRow>>();
      for (const sqlRow of allRows) {
        const row = fromSqlRow(sqlRow);
        if (!validStoredRow(row)) throw new Error('invalid timeout owner-cell ledger row');
        const previous = latestByTest.get(row.testId);
        const expected = row.outcome === 'measured' ? 0 : previous?.outcome === 'unmeasurable' ? previous.streak + 1 : 1;
        if (row.streak !== expected) throw new Error('invalid timeout owner-cell ledger transition');
        const commits = commitsByTest.get(row.testId) ?? new Map<string, StoredRow>();
        if (commits.has(row.commit)) throw new Error('duplicate timeout owner-cell ledger observation');
        commits.set(row.commit, row);
        commitsByTest.set(row.testId, commits);
        latestByTest.set(row.testId, row);
      }
      const insert = db.query('INSERT INTO timeout_observations (test_id, commit_sha, version, outcome, streak, at) VALUES (?, ?, ?, ?, ?, ?)');
      const findCommit = db.query('SELECT at, version, commit_sha AS commitSha, test_id AS testId, outcome, streak FROM timeout_observations WHERE test_id = ? AND commit_sha = ?');
      for (const [testId, outcome] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
        const existingSql = findCommit.get(testId, commit) as SqlRow | null;
        const existing = existingSql ? fromSqlRow(existingSql) : null;
        const latest = latestByTest.get(testId);
        if (existing) {
          // A commit is one observation globally even if it is replayed under another release version or result.
          records.set(testId, { row: latest ?? existing, fresh: false });
          continue;
        }
        const streak = outcome === 'unmeasurable' ? latest?.outcome === 'unmeasurable' ? latest.streak + 1 : 1 : 0;
        const row: StoredRow = { at: new Date().toISOString(), version, commit, testId, outcome, streak };
        insert.run(testId, commit, version, outcome, streak, row.at);
        const commits = commitsByTest.get(testId) ?? new Map<string, StoredRow>();
        commits.set(commit, row);
        commitsByTest.set(testId, commits);
        latestByTest.set(testId, row);
        records.set(testId, { row, fresh: true });
        if (streak === threshold) {
          db.query(`INSERT OR IGNORE INTO pending_owner_cells (test_id, version, cell_id, threshold, reached_at)
            SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM completed_owner_cells WHERE test_id = ?)`)
            .run(testId, version, cellIdFor(testId), threshold, row.at, testId);
        }
      }
      // Reconstruct a lost pending write from the immutable observation rows; completed cells stay terminal.
      const upsertPending = db.query(`INSERT OR IGNORE INTO pending_owner_cells (test_id, version, cell_id, threshold, reached_at)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM completed_owner_cells WHERE test_id = ?)`);
      for (const [testId, commits] of commitsByTest) {
        if (db.query('SELECT 1 FROM pending_owner_cells WHERE test_id = ?').get(testId)) continue;
        const crossing = [...commits.values()].find((row) => row.outcome === 'unmeasurable' && row.streak === threshold);
        if (crossing) upsertPending.run(testId, crossing.version, cellIdFor(testId), threshold, crossing.at, testId);
      }
      // Repair pending rows created before a crash or a checklist write failure, even if this cut measured the test.
      const pending = db.query('SELECT test_id AS testId, version, cell_id AS cellId, threshold, reached_at AS reachedAt FROM pending_owner_cells ORDER BY rowid').all() as PendingCell[];
      const validPending = pending.every((cell) => {
        const hasThresholdObservation = [...(commitsByTest.get(cell.testId)?.values() ?? [])].some((row) =>
          row.version === cell.version && row.at === cell.reachedAt && row.outcome === 'unmeasurable' && row.streak === cell.threshold);
        return validTestId(cell.testId) && /^\d+\.\d+\.\d+$/.test(cell.version) && cell.cellId === cellIdFor(cell.testId) &&
          Number.isSafeInteger(cell.threshold) && cell.threshold >= 2 && Number.isFinite(Date.parse(cell.reachedAt)) && hasThresholdObservation;
      });
      if (!validPending)
        throw new Error('invalid timeout owner-cell pending row');
      db.exec('COMMIT');
      return { records, pending };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original validation or write failure */ }
      throw error;
    }
  } finally { db.close(); }
}

function markCellCreated(path: string, testId: string): void {
  const db = openLedger(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    const pending = db.query('SELECT version, cell_id AS cellId FROM pending_owner_cells WHERE test_id = ?').get(testId) as { version: string; cellId: string } | null;
    if (pending) db.query('INSERT OR IGNORE INTO completed_owner_cells (test_id, version, cell_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(testId, pending.version, pending.cellId, new Date().toISOString());
    db.query('DELETE FROM pending_owner_cells WHERE test_id = ?').run(testId);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original error */ } throw error; }
  finally { db.close(); }
}

function ensureChecklistCell(input: { version: string; id: string; title: string; owner: string }): boolean {
  if (checklistHistory(input.id).length) return false;
  if (listChecklist(input.version).items.some((item) => item.id === input.id)) return false;
  try {
    addItem(input.version, { id: input.id, title: input.title, owner: input.owner, priority: 'P1', dispatchKind: 'code' });
    return true;
  } catch (error) {
    // A concurrent gate may have created this deterministic id after the read above.
    if (checklistHistory(input.id).length) return false;
    throw error;
  }
}

/** Persist one distinct gate-cut observation per test; owner-cell creation is retried independently of later measurements. */
export function recordGateTimeoutOwnerCells(input: {
  ledgerRoot: string;
  version: string;
  commit: string;
  unmeasurableIds: readonly string[];
  measuredIds?: readonly string[];
  threshold?: number;
  owner?: string;
}, deps: GateTimeoutOwnerCellDeps = {}): GateTimeoutOwnerCellResult[] {
  const threshold = input.threshold ?? GATE_TIMEOUT_UNMEASURABLE_STREAK_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold < 2 || !input.ledgerRoot.trim() || !/^\d+\.\d+\.\d+$/.test(input.version) || !/^[0-9a-f]{40}$/i.test(input.commit)) {
    log('timeout-owner-cell-input-invalid', { version: input.version, commit: input.commit, threshold });
    return [];
  }
  const commit = input.commit.toLowerCase();
  const owner = input.owner ?? OWNER;
  const outcomes = new Map<string, GateTimeoutOwnerCellOutcome>();
  for (const [outcome, ids] of [['measured', input.measuredIds ?? []], ['unmeasurable', input.unmeasurableIds ?? []]] as const) {
    for (const testId of ids) {
      if (!validTestId(testId)) {
        log('timeout-owner-cell-test-id-invalid', { commit, outcome });
        continue;
      }
      outcomes.set(testId, outcome);
    }
  }
  if (!outcomes.size) return [];

  const ledgerPath = join(input.ledgerRoot, 'release', 'gate-timeout-owner-cells.sqlite');
  let ledger: LedgerResult;
  try { ledger = recordObservations(ledgerPath, input.version, commit, threshold, outcomes); }
  catch (error) {
    log('timeout-owner-cell-ledger-unmeasurable', { version: input.version, commit, reason: String(error).slice(0, 200) });
    return [];
  }
  const pendingByTest = new Map(ledger.pending.map((cell) => [cell.testId, cell]));
  const createdThisCall = new Set<string>();
  for (const cell of ledger.pending) {
    const title = `대상 경로: ${cell.testId.split(' > ')[0]}\n같은 시험 ${cell.testId}의 게이트 기준선 측정 불가가 ${cell.threshold}회 연속이다 — 소유자가 수리·재측정 경계를 정한다.`;
    try {
      const created = (deps.ensureCell ?? ensureChecklistCell)({ version: cell.version, id: cell.cellId, title, owner });
      if (created) createdThisCall.add(cell.testId);
      markCellCreated(ledgerPath, cell.testId);
    } catch (error) {
      log('timeout-owner-cell-create-failed', { version: cell.version, testId: cell.testId, id: cell.cellId, reason: String(error).slice(0, 200) });
      try {
        const db = openLedger(ledgerPath);
        db.query(`INSERT OR IGNORE INTO pending_owner_cells (test_id, version, cell_id, threshold, reached_at)
          SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM completed_owner_cells WHERE test_id = ?)`)
          .run(cell.testId, cell.version, cell.cellId, cell.threshold, cell.reachedAt, cell.testId);
        db.close();
      } catch { /* original creation failure remains fail-closed and the observation history can reconstruct pending */ }
    }
  }

  const result: GateTimeoutOwnerCellResult[] = [];
  for (const [testId, { row, fresh }] of ledger.records) {
    if (fresh) {
      log('timeout-owner-cell-observed', { version: row.version, commit: row.commit, testId, outcome: row.outcome, streak: row.streak });
    }
    const pending = pendingByTest.get(testId);
    const cellId = pending?.cellId ?? (row.streak >= threshold ? cellIdFor(testId) : undefined);
    const created = createdThisCall.has(testId);
    result.push({ testId, streak: row.streak, threshold, ...(cellId ? { cellId } : {}), created });
  }
  return result;
}
