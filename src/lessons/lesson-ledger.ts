import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';

export type LessonStatus = 'open' | 'enforced' | 'candidate' | 'promoted';
export interface LessonRow {
  id: string;
  incident: string;
  cause: string;
  remedy: string;
  enforced_by: string;
  disproof: string | null;
  owner: string;
  status: LessonStatus;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
}
export interface LessonOccurrence { lesson_id: string; at: string; source: string; note: string }
export interface LessonHistory { lesson_id: string; at: string; by: string; event: 'add' | 'recur' | 'enforce' | 'promote'; detail: string }
export interface LessonDetail extends LessonRow { occurrences: LessonOccurrence[]; history: LessonHistory[] }
export interface LessonLedgerOptions { stateDir?: string; now?: () => Date }
export interface LessonAddInput { id: string; incident: string; cause: string; remedy: string; owner: string; source: string; enforcedBy?: string; disproof?: string; by?: string }

export class LessonInputError extends Error {
  override name = 'LessonInputError';
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new LessonInputError(`${field} is required`);
  return value.trim();
}

function enforcement(value: string): string {
  if (typeof value !== 'string') throw new LessonInputError('enforcedBy is required');
  return value.split(',').map(part => required(part, 'enforcedBy')).join(',');
}

export class LessonLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: LessonLedgerOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'lessons', 'lessons.sqlite');
    this.now = options.now ?? (() => new Date());
  }

  private open(): Database {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY, incident TEXT NOT NULL, cause TEXT NOT NULL, remedy TEXT NOT NULL,
        enforced_by TEXT NOT NULL DEFAULT '', disproof TEXT, owner TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','enforced','candidate','promoted')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS occurrences (
          lesson_id TEXT NOT NULL REFERENCES lessons(id), at TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (
          lesson_id TEXT NOT NULL REFERENCES lessons(id), at TEXT NOT NULL, by TEXT NOT NULL,
          event TEXT NOT NULL, detail TEXT NOT NULL);`);
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

  private row(db: Database, id: string): LessonRow {
    const row = db.query(`SELECT l.*, (SELECT count(*) FROM occurrences WHERE lesson_id = l.id) AS occurrence_count
      FROM lessons l WHERE l.id = ?`).get(id) as LessonRow | null;
    if (!row) throw new LessonInputError(`lesson not found: ${id}`);
    return row;
  }

  private record(db: Database, id: string, at: string, by: string, event: LessonHistory['event'], detail: string): void {
    db.query('INSERT INTO history (lesson_id, at, by, event, detail) VALUES (?, ?, ?, ?, ?)').run(id, at, by, event, detail);
  }

  private log(event: LessonHistory['event'], row: LessonRow): void {
    debug.log('lessons.ledger', event, { id: row.id, status: row.status, occurrences: row.occurrence_count });
  }

  add(input: LessonAddInput): LessonRow {
    return this.addValidated(input, false);
  }

  importDocument(input: LessonAddInput): LessonRow {
    return this.addValidated(input, true);
  }

  importedSources(): string[] {
    return this.using(db => (db.query("SELECT detail AS source FROM history WHERE event = 'add' AND detail LIKE 'docs/%'").all() as { source: string }[]).map(row => row.source));
  }

  private addValidated(input: LessonAddInput, allowPartial: boolean): LessonRow {
    const id = required(input.id, 'id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new LessonInputError('invalid lesson id');
    const incident = required(input.incident, 'incident');
    const cause = allowPartial ? input.cause.trim() : required(input.cause, 'cause');
    const remedy = allowPartial ? input.remedy.trim() : required(input.remedy, 'remedy');
    if (!cause && !remedy) throw new LessonInputError('cause or remedy is required');
    const owner = required(input.owner, 'owner');
    const source = required(input.source, 'source');
    const enforcedBy = input.enforcedBy === undefined || !input.enforcedBy.trim() ? '' : enforcement(input.enforcedBy);
    const disproof = input.disproof === undefined || !input.disproof.trim() ? null : required(input.disproof, 'disproof');
    return this.using(db => this.transaction(db, () => {
      const at = this.now().toISOString();
      db.query(`INSERT INTO lessons (id, incident, cause, remedy, enforced_by, disproof, owner, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, incident, cause, remedy, enforcedBy, disproof, owner, enforcedBy ? 'enforced' : 'open', at, at);
      db.query('INSERT INTO occurrences (lesson_id, at, source, note) VALUES (?, ?, ?, ?)').run(id, at, source, '');
      this.record(db, id, at, input.by === undefined ? owner : required(input.by, 'by'), 'add', source);
      const row = this.row(db, id);
      this.log('add', row);
      return row;
    }));
  }

  recur(id: string, input: { source: string; note?: string; by: string }): LessonRow {
    const source = required(input.source, 'source');
    const by = required(input.by, 'by');
    const note = input.note ?? '';
    return this.using(db => this.transaction(db, () => {
      const previous = this.row(db, id);
      const at = this.now().toISOString();
      db.query('INSERT INTO occurrences (lesson_id, at, source, note) VALUES (?, ?, ?, ?)').run(id, at, source, note);
      const status = previous.status === 'promoted' ? 'promoted' : 'candidate';
      db.query('UPDATE lessons SET status = ?, updated_at = ? WHERE id = ?').run(status, at, id);
      this.record(db, id, at, by, 'recur', `${source}${note ? ` · ${note}` : ''}`);
      const row = this.row(db, id);
      this.log('recur', row);
      return row;
    }));
  }

  enforce(id: string, input: { enforcedBy: string; by: string }): LessonRow {
    const enforcedBy = enforcement(input.enforcedBy);
    const by = required(input.by, 'by');
    return this.using(db => this.transaction(db, () => {
      const previous = this.row(db, id);
      const at = this.now().toISOString();
      const paths = [...new Set([...previous.enforced_by.split(',').filter(Boolean), ...enforcedBy.split(',')])].join(',');
      const status = previous.status === 'promoted' ? 'promoted' : 'enforced';
      db.query('UPDATE lessons SET enforced_by = ?, status = ?, updated_at = ? WHERE id = ?').run(paths, status, at, id);
      this.record(db, id, at, by, 'enforce', enforcedBy);
      const row = this.row(db, id);
      this.log('enforce', row);
      return row;
    }));
  }

  promote(id: string, input: { rulePath: string; by: string }): LessonRow {
    const rulePath = required(input.rulePath, 'rulePath');
    const by = required(input.by, 'by');
    return this.using(db => this.transaction(db, () => {
      const previous = this.row(db, id);
      if (!previous.disproof?.trim()) throw new LessonInputError('disproof is required to promote a lesson');
      const at = this.now().toISOString();
      const paths = [...new Set([...previous.enforced_by.split(',').filter(Boolean), rulePath])].join(',');
      db.query("UPDATE lessons SET enforced_by = ?, status = 'promoted', updated_at = ? WHERE id = ?").run(paths, at, id);
      this.record(db, id, at, by, 'promote', rulePath);
      const row = this.row(db, id);
      this.log('promote', row);
      return row;
    }));
  }

  find(query: string): LessonRow[] {
    const term = required(query, 'query').toLowerCase();
    return this.using(db => (db.query(`SELECT l.*, (SELECT count(*) FROM occurrences WHERE lesson_id = l.id) AS occurrence_count
      FROM lessons l WHERE instr(lower(incident), ?) > 0 OR instr(lower(cause), ?) > 0 OR instr(lower(remedy), ?) > 0
      ORDER BY occurrence_count DESC, l.created_at, l.id`).all(term, term, term) as LessonRow[]));
  }

  list(filters: { status?: LessonStatus } = {}): LessonRow[] {
    return this.using(db => (db.query(`SELECT l.*, (SELECT count(*) FROM occurrences WHERE lesson_id = l.id) AS occurrence_count
      FROM lessons l WHERE (? IS NULL OR l.status = ?)
      ORDER BY occurrence_count DESC, l.updated_at DESC, l.id`).all(filters.status ?? null, filters.status ?? null) as LessonRow[]));
  }

  candidates(): LessonRow[] {
    return this.using(db => db.query(`SELECT l.*, (SELECT count(*) FROM occurrences WHERE lesson_id = l.id) AS occurrence_count
      FROM lessons l WHERE l.status = 'candidate' ORDER BY occurrence_count DESC, l.created_at, l.id`).all() as LessonRow[]);
  }

  get(id: string): LessonDetail {
    return this.using(db => ({ ...this.row(db, id),
      occurrences: db.query('SELECT lesson_id, at, source, note FROM occurrences WHERE lesson_id = ? ORDER BY rowid').all(id) as LessonOccurrence[],
      history: db.query('SELECT lesson_id, at, by, event, detail FROM history WHERE lesson_id = ? ORDER BY rowid').all(id) as LessonHistory[],
    }));
  }
}
