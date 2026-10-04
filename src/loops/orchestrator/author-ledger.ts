import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';

export type AuthorVerdict = 'approved' | 'resubmit' | 'confirm' | 'uncheckable';
export type AuthorStatus = 'held' | 'queued-for-author' | 'authoring' | 'authored' | 'enqueued'
  | 'failed' | 'cancelled' | 'superseded-by-cell-change';
export interface AuthorCheck { verdict: AuthorVerdict; signals: unknown[]; ratio: number | null }
export interface AuthorRequest { seat: string; cellId: string; version: string; title: string; text: string; check: AuthorCheck }
export interface AuthorDetail {
  queueId?: string;
  goalRef?: string;
  supersededBy?: string;
  textHash?: string;
  reason?: string;
}
export interface AuthorHistory {
  fromStatus: AuthorStatus | null;
  toStatus: AuthorStatus;
  at: string;
  by: string;
  detail: AuthorDetail | AuthorCheck | string;
}
export interface AuthorRow extends AuthorRequest {
  id: string;
  status: AuthorStatus;
  queueId: string | null;
  goalRef: string | null;
  supersededBy: string | null;
  textHash: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AuthorRecord extends AuthorRow { history: AuthorHistory[] }
export interface AuthorMetric { value: number | null; reason?: '못 쟀다(원장 결손)' }
export interface AuthorMetrics {
  tps: AuthorMetric;
  latencyMs: AuthorMetric;
  depthBySeat: { value: Record<string, number> | null; reason?: '못 쟀다(원장 결손)' };
}
export interface AuthorLedgerOptions { path?: string; now?: () => Date }

type StoredRow = Omit<AuthorRow, 'check'> & { checkJson: string };
type StoredHistory = Omit<AuthorHistory, 'detail'> & { detailJson: string };
const unmeasured = { value: null, reason: '못 쟀다(원장 결손)' } as const;
// Terminal states never change again: a cancel/fail after a supersede would erase the recorded replacement (supersededBy · textHash).
const TERMINAL: ReadonlySet<AuthorStatus> = new Set(['failed', 'cancelled', 'superseded-by-cell-change']);
const successors: Partial<Record<AuthorStatus, AuthorStatus>> = {
  'queued-for-author': 'authoring', authoring: 'authored', authored: 'enqueued',
};

function hash(parts: string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest('hex');
}

export class AuthorLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: AuthorLedgerOptions = {}) {
    this.path = options.path ?? join(effectiveInstanceRoot(), 'orchestrator', 'author-ledger.sqlite');
    this.now = options.now ?? (() => new Date());
  }

  private open(create: boolean): Database {
    if (create) mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create, strict: true });
    try {
      if (create) chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA foreign_keys = ON');
      if (create) db.exec(`CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, seat TEXT NOT NULL, cellId TEXT NOT NULL, version TEXT NOT NULL,
        title TEXT NOT NULL, text TEXT NOT NULL, checkJson TEXT NOT NULL,
        status TEXT NOT NULL, queueId TEXT, goalRef TEXT, supersededBy TEXT, textHash TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (
          requestId TEXT NOT NULL REFERENCES requests(id), fromStatus TEXT, toStatus TEXT NOT NULL,
          at TEXT NOT NULL, by TEXT NOT NULL, detailJson TEXT NOT NULL);`);
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private using<T>(work: (db: Database) => T): T {
    const db = this.open(true);
    try { return work(db); } finally { db.close(); }
  }

  private transaction<T>(db: Database, work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  private row(db: Database, id: string): AuthorRow {
    const row = db.query('SELECT * FROM requests WHERE id = ?').get(id) as StoredRow | null;
    if (!row) throw new Error(`author request not found: ${id}`);
    const { checkJson, ...rest } = row;
    return { ...rest, check: JSON.parse(checkJson) as AuthorCheck };
  }

  private record(db: Database, id: string, from: AuthorStatus | null, to: AuthorStatus,
    at: string, by: string, detail: AuthorDetail | AuthorCheck | string): void {
    db.query('INSERT INTO history (requestId, fromStatus, toStatus, at, by, detailJson) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, from, to, at, by, JSON.stringify(detail));
  }

  private log(event: string, row: AuthorRow): void {
    debug.log('author.par', 'ledger', { event, seat: row.seat, cellId: row.cellId, version: row.version, status: row.status });
  }

  request(input: AuthorRequest): AuthorRow & { duplicate: boolean } {
    for (const key of ['seat', 'cellId', 'version', 'title', 'text'] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} is required`);
    }
    if (!['approved', 'resubmit', 'confirm', 'uncheckable'].includes(input.check?.verdict)
      || !Array.isArray(input.check.signals)
      || (input.check.ratio !== null && (typeof input.check.ratio !== 'number' || !Number.isFinite(input.check.ratio))))
      throw new Error('invalid author input check');
    const id = hash([input.seat, input.cellId, input.version, input.title, input.text]);
    return this.using(db => this.transaction(db, () => {
      if (db.query('SELECT 1 FROM requests WHERE id = ?').get(id)) {
        const row = this.row(db, id);
        this.log('duplicate', row);
        return { ...row, duplicate: true };
      }
      const at = this.now().toISOString();
      const status = input.check.verdict === 'approved' ? 'queued-for-author' : 'held';
      db.query(`INSERT INTO requests (id, seat, cellId, version, title, text, checkJson, status, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.seat, input.cellId, input.version,
        input.title, input.text, JSON.stringify(input.check), status, at, at);
      this.record(db, id, null, status, at, 'system', input.check);
      const row = this.row(db, id);
      this.log('request', row);
      return { ...row, duplicate: false };
    }));
  }

  transition(id: string, to: AuthorStatus, input: { by: string; detail: AuthorDetail | string }): AuthorRow {
    return this.using(db => this.transaction(db, () => {
      const previous = this.row(db, id);
      const allowed = !TERMINAL.has(previous.status) && (successors[previous.status] === to
        || (to === 'superseded-by-cell-change' && (previous.status === 'authored' || previous.status === 'enqueued'))
        || to === 'failed' || to === 'cancelled');
      if (!allowed) throw new Error(`invalid author transition: ${previous.status} → ${to}`);
      const detail = input.detail;
      const fields = typeof detail === 'string' ? {} : detail;
      if (!input.by?.trim()) throw new Error('by is required');
      if (to === 'authored' && !fields.goalRef?.trim()) throw new Error('goalRef is required');
      if (to === 'enqueued' && !fields.queueId?.trim()) throw new Error('queueId is required');
      if (to === 'superseded-by-cell-change') {
        if (!previous.goalRef) throw new Error('old goalRef is required');
        if (!fields.supersededBy?.trim() || !/^[a-f0-9]{64}$/.test(fields.textHash ?? ''))
          throw new Error('supersededBy and textHash are required');
        const candidates = db.query(`SELECT id, text FROM requests
          WHERE seat = ? AND cellId = ? AND version = ? AND goalRef = ? AND status IN ('authored', 'enqueued')`)
          .all(previous.seat, previous.cellId, previous.version, fields.supersededBy) as Array<{ id: string; text: string }>;
        if (candidates.length !== 1 || candidates[0]!.id === id || candidates[0]!.text === previous.text
          || createHash('sha256').update(candidates[0]!.text, 'utf8').digest('hex') !== fields.textHash)
          throw new Error('supersededBy and textHash must match a changed authored snapshot');
      }
      const at = this.now().toISOString();
      const recordedDetail: AuthorDetail | string = typeof detail === 'string' ? detail :
        to === 'authored' ? { goalRef: fields.goalRef } :
        to === 'enqueued' ? { queueId: fields.queueId } :
        to === 'superseded-by-cell-change' ? { supersededBy: fields.supersededBy, textHash: fields.textHash } :
        to === 'failed' || to === 'cancelled' ? { reason: fields.reason } : {};
      db.query(`UPDATE requests SET status = ?, queueId = COALESCE(?, queueId), goalRef = COALESCE(?, goalRef),
        supersededBy = ?, textHash = ?, updatedAt = ? WHERE id = ?`).run(to,
        to === 'enqueued' ? fields.queueId ?? null : null, to === 'authored' ? fields.goalRef ?? null : null,
        to === 'superseded-by-cell-change' ? fields.supersededBy ?? null : null,
        to === 'superseded-by-cell-change' ? fields.textHash ?? null : null, at, id);
      this.record(db, id, previous.status, to, at, input.by, recordedDetail);
      const row = this.row(db, id);
      this.log('transition', row);
      return row;
    }));
  }

  get(id: string): AuthorRecord {
    return this.using(db => ({ ...this.row(db, id), history: (db.query(
      'SELECT fromStatus, toStatus, at, by, detailJson FROM history WHERE requestId = ? ORDER BY rowid',
    ).all(id) as StoredHistory[]).map(({ detailJson, ...item }) => ({ ...item, detail: JSON.parse(detailJson) as AuthorDetail | AuthorCheck | string })) }));
  }

  metrics({ since, until }: { since: Date; until: Date }): AuthorMetrics {
    const duration = (until.getTime() - since.getTime()) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('metrics window must have positive duration');
    let db: Database;
    try { db = this.open(false); }
    catch { return { tps: unmeasured, latencyMs: unmeasured, depthBySeat: unmeasured }; }
    try {
      const start = since.toISOString();
      const end = until.toISOString();
      const events = (db.query('SELECT count(*) AS n FROM history WHERE at >= ? AND at < ?').get(start, end) as { n: number }).n;
      if (!events) return { tps: unmeasured, latencyMs: unmeasured, depthBySeat: unmeasured };
      const completed = db.query(`SELECT r.seat, r.version, r.cellId, r.createdAt, h.at
        FROM history h JOIN requests r ON r.id = h.requestId
        WHERE h.toStatus = 'authored' AND h.at >= ? AND h.at < ?`).all(start, end) as
        Array<{ seat: string; version: string; cellId: string; createdAt: string; at: string }>;
      const distinctCells = new Set(completed.map(row => JSON.stringify([row.seat, row.version, row.cellId])));
      const delays = completed.map(row => Date.parse(row.at) - Date.parse(row.createdAt));
      const latencyMs = delays.length && delays.every(delay => Number.isFinite(delay) && delay >= 0)
        ? { value: delays.reduce((sum, delay) => sum + delay, 0) / delays.length } : unmeasured;
      const depthRows = db.query(`WITH last_status AS (
        SELECT requestId, toStatus, ROW_NUMBER() OVER (
          PARTITION BY requestId ORDER BY at DESC, rowid DESC
        ) AS rank FROM history WHERE at < ?
      )
        SELECT seat, count(*) AS n FROM (
          SELECT DISTINCT r.seat, r.version, r.cellId FROM last_status h
            JOIN requests r ON r.id = h.requestId
            WHERE h.rank = 1 AND h.toStatus IN ('queued-for-author', 'authoring')
        ) GROUP BY seat`).all(end) as Array<{ seat: string; n: number }>;
      return { tps: { value: distinctCells.size / duration }, latencyMs,
        depthBySeat: { value: Object.fromEntries(depthRows.map(row => [row.seat, row.n])) } };
    } catch { return { tps: unmeasured, latencyMs: unmeasured, depthBySeat: unmeasured }; }
    finally { db.close(); }
  }
}
