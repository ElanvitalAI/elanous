import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';

/** 특허 후보의 갈래 — 구체 후보와 기전은 비공개 원장에만 둔다. */
const PATENT_TRACKS = ['비공개', '출원', '신규'] as const;
/** 특허 후보의 상태 — 조사/명세/출원/공개 허용 중 공개 허용 상태만 공개 읽기 통로에 나온다. */
const PATENT_STATUSES = ['조사', '명세', '출원', '공개 허용'] as const;

export type PatentTrack = (typeof PATENT_TRACKS)[number];
export type PatentStatus = (typeof PATENT_STATUSES)[number];

export class PatentsInputError extends Error {
  override name = 'PatentsInputError';
}

export interface PatentCandidate {
  id: string;
  title: string;
  track: PatentTrack;
  status: PatentStatus;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}
export interface PatentLedgerOptions { stateDir?: string; now?: () => Date }

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PatentsInputError(`${field} is required`);
  return value.trim();
}

function trackOf(value: PatentTrack): PatentTrack {
  if (!PATENT_TRACKS.includes(value)) throw new PatentsInputError(`invalid track: ${value}`);
  return value;
}

function statusOf(value: PatentStatus): PatentStatus {
  if (!PATENT_STATUSES.includes(value)) throw new PatentsInputError(`invalid status: ${value}`);
  return value;
}

function isoDate(value: string, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) throw new PatentsInputError(`invalid ${field}: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new PatentsInputError(`invalid ${field}: ${value}`);
  return value;
}

/** 후보 식별자·갈래·상태·마감일의 비공개 원장 — 공개 허용 상태 후보만 읽기 통로로 노출한다. */
export class PatentLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: PatentLedgerOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'patents', 'patents.sqlite');
    this.now = options.now ?? (() => new Date());
  }

  private open(): Database {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS patent_candidates (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        track TEXT NOT NULL CHECK(track IN ('비공개','출원','신규')),
        status TEXT NOT NULL CHECK(status IN ('조사','명세','출원','공개 허용')),
        deadline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private using<T>(work: (db: Database) => T): T {
    const db = this.open();
    try { return work(db); } finally { db.close(); }
  }

  private transaction<T>(db: Database, work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  private row(db: Database, id: string): PatentCandidate {
    const row = db.query('SELECT id, title, track, status, deadline, created_at, updated_at FROM patent_candidates WHERE id = ?').get(id) as PatentCandidate | null;
    if (!row) throw new PatentsInputError(`patent candidate not found: ${id}`);
    return row;
  }

  add(input: { id: string; title: string; track: PatentTrack; status?: PatentStatus; deadline?: string }): PatentCandidate {
    const id = required(input.id, 'id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new PatentsInputError('invalid patent candidate id');
    const title = required(input.title, 'title');
    const track = trackOf(input.track);
    const status = statusOf(input.status ?? '조사');
    const deadline = input.deadline === undefined ? null : isoDate(input.deadline, 'deadline');
    return this.using(db => this.transaction(db, () => {
      if (db.query('SELECT 1 FROM patent_candidates WHERE id = ?').get(id)) throw new PatentsInputError(`patent candidate already exists: ${id}`);
      const at = this.now().toISOString();
      db.query('INSERT INTO patent_candidates (id, title, track, status, deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, title, track, status, deadline, at, at);
      debug.log('patents.ledger', 'add', { id, status });
      return this.row(db, id);
    }));
  }

  setStatus(id: string, status: PatentStatus): PatentCandidate {
    const next = statusOf(status);
    return this.using(db => this.transaction(db, () => {
      this.row(db, id);
      const at = this.now().toISOString();
      db.query('UPDATE patent_candidates SET status = ?, updated_at = ? WHERE id = ?').run(next, at, id);
      debug.log('patents.ledger', 'status', { id, status: next });
      return this.row(db, id);
    }));
  }

  /** 이 원장의 유일한 공개 읽기 통로 — 공개 허용 상태 후보만 나온다(조사·명세·출원 상태 후보는 나오지 않는다). */
  listPublicCandidates(): PatentCandidate[] {
    return this.using(db =>
      db.query(`SELECT id, title, track, status, deadline, created_at, updated_at FROM patent_candidates WHERE status = '공개 허용' ORDER BY created_at, id`).all() as PatentCandidate[]);
  }
}
