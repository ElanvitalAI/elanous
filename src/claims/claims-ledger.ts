import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';

export type ClaimStatus = 'draft' | 'verified' | 'public' | 'stale' | 'retracted';

export class ClaimsInputError extends Error {
  override name = 'ClaimsInputError';
}

const claimsTable = (name: 'claims' | 'claims_new') => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY, claim TEXT NOT NULL, audience TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','verified','public','stale','retracted')),
  owner TEXT NOT NULL, contrast TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
export interface ClaimRow {
  id: string;
  claim: string;
  audience: string;
  status: ClaimStatus;
  owner: string;
  contrast: string | null;
  created_at: string;
  updated_at: string;
}
export interface ClaimEvidence { claim_id: string; value: string; command: string; source: string | null; measured_at: string; valid_until: string }
export interface ClaimLink { claim_id: string; cell: string; version: string | null }
export interface ClaimHistory { claim_id: string; at: string; by: string; event: 'add' | 'verify' | 'publish' | 'link' | 'stale' | 'retract'; detail: string }
export interface ClaimDetail extends ClaimRow { evidence: ClaimEvidence[]; links: ClaimLink[]; history: ClaimHistory[] }
export interface ClaimsLedgerOptions { stateDir?: string; now?: () => Date }

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ClaimsInputError(`${field} is required`);
  return value.trim();
}
function iso(value: string, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new ClaimsInputError(`invalid ${field}: ${value}`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ClaimsInputError(`invalid ${field}: ${value}`);
  return date.toISOString();
}

export class ClaimsLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: ClaimsLedgerOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'claims', 'claims.sqlite');
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
      db.exec(`${claimsTable('claims').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')};
        CREATE TABLE IF NOT EXISTS evidence (
          claim_id TEXT NOT NULL REFERENCES claims(id), value TEXT NOT NULL, command TEXT NOT NULL,
          source TEXT, measured_at TEXT NOT NULL, valid_until TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS links (
          claim_id TEXT NOT NULL REFERENCES claims(id), cell TEXT NOT NULL, version TEXT);
        CREATE TABLE IF NOT EXISTS history (
          claim_id TEXT NOT NULL REFERENCES claims(id), at TEXT NOT NULL, by TEXT NOT NULL,
          event TEXT NOT NULL, detail TEXT NOT NULL);`);
      const schema = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get() as { sql: string }).sql;
      if (!schema.includes("'retracted'")) {
        db.exec('PRAGMA foreign_keys = OFF');
        try {
          db.exec('BEGIN IMMEDIATE');
          try {
            // Another opener may have migrated while this connection waited for the write lock.
            const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get() as { sql: string }).sql;
            if (!current.includes("'retracted'")) {
              db.exec(claimsTable('claims_new'));
              db.exec('INSERT INTO claims_new SELECT * FROM claims');
              db.exec('DROP TABLE claims');
              db.exec('ALTER TABLE claims_new RENAME TO claims');
              if ((db.query('PRAGMA foreign_key_check').all() as unknown[]).length) throw new Error('claims migration foreign key check failed');
            }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        } finally { db.exec('PRAGMA foreign_keys = ON'); }
      }
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

  private row(db: Database, id: string): ClaimRow {
    const row = db.query('SELECT * FROM claims WHERE id = ?').get(id) as ClaimRow | null;
    if (!row) throw new ClaimsInputError(`claim not found: ${id}`);
    return row;
  }

  private latest(db: Database, id: string): ClaimEvidence | null {
    return db.query('SELECT claim_id, value, command, source, measured_at, valid_until FROM evidence WHERE claim_id = ? ORDER BY measured_at DESC, rowid DESC LIMIT 1').get(id) as ClaimEvidence | null;
  }

  private record(db: Database, id: string, at: string, by: string, event: ClaimHistory['event'], detail: string): void {
    db.query('INSERT INTO history (claim_id, at, by, event, detail) VALUES (?, ?, ?, ?, ?)').run(id, at, by, event, detail);
  }

  private refresh(db: Database, row: ClaimRow, at: string): ClaimRow {
    if (row.status === 'stale' || row.status === 'draft' || row.status === 'retracted') return row;
    const evidence = this.latest(db, row.id);
    if (!evidence || evidence.valid_until > at) return row;
    db.query("UPDATE claims SET status = 'stale', updated_at = ? WHERE id = ?").run(at, row.id);
    this.record(db, row.id, at, 'system', 'stale', `evidence expired: ${evidence.valid_until}`);
    debug.log('claims.ledger', 'stale', { id: row.id, status: 'stale' });
    return { ...row, status: 'stale', updated_at: at };
  }

  add(input: { id: string; claim: string; audience: string; owner: string; contrast?: string }): ClaimRow {
    const id = required(input.id, 'id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new ClaimsInputError('invalid claim id');
    const claim = required(input.claim, 'claim');
    const audience = required(input.audience, 'audience').split(',').map(part => required(part, 'audience')).join(',');
    const owner = required(input.owner, 'owner');
    const contrast = input.contrast === undefined ? null : required(input.contrast, 'contrast');
    return this.using(db => this.transaction(db, () => {
      if (db.query('SELECT 1 FROM claims WHERE id = ?').get(id)) throw new ClaimsInputError(`claim already exists: ${id}`);
      const at = this.now().toISOString();
      db.query('INSERT INTO claims (id, claim, audience, status, owner, contrast, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, claim, audience, 'draft', owner, contrast, at, at);
      this.record(db, id, at, owner, 'add', claim);
      debug.log('claims.ledger', 'add', { id, status: 'draft' });
      return this.row(db, id);
    }));
  }

  verify(id: string, input: { value: string; command: string; source?: string; measuredAt: string; validUntil: string; by: string }): ClaimRow {
    const value = required(input.value, 'value');
    const command = required(input.command, 'command');
    const by = required(input.by, 'by');
    const measuredAt = iso(input.measuredAt, 'measuredAt');
    const validUntil = iso(input.validUntil, 'validUntil');
    if (validUntil <= measuredAt) throw new ClaimsInputError('validUntil must be after measuredAt');
    const source = input.source === undefined ? null : required(input.source, 'source');
    return this.using(db => this.transaction(db, () => {
      if (this.row(db, id).status === 'retracted') throw new ClaimsInputError(`claim retracted: ${id}`);
      const at = this.now().toISOString();
      db.query('INSERT INTO evidence (claim_id, value, command, source, measured_at, valid_until) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, value, command, source, measuredAt, validUntil);
      db.query("UPDATE claims SET status = 'verified', updated_at = ? WHERE id = ?").run(at, id);
      this.record(db, id, at, by, 'verify', value);
      debug.log('claims.ledger', 'verify', { id, status: 'verified' });
      return this.row(db, id);
    }));
  }

  publish(id: string, by: string): ClaimRow {
    const actor = required(by, 'by');
    return this.using(db => {
      const published = this.transaction(db, () => {
        const at = this.now().toISOString();
        const row = this.refresh(db, this.row(db, id), at);
        const evidence = this.latest(db, id);
        if (row.status !== 'verified' || !evidence || evidence.valid_until <= at) return null;
        db.query("UPDATE claims SET status = 'public', updated_at = ? WHERE id = ?").run(at, id);
        this.record(db, id, at, actor, 'publish', evidence.value);
        return this.row(db, id);
      });
      if (!published) throw new ClaimsInputError(`claim requires verified, valid evidence: ${id}`);
      debug.log('claims.ledger', 'publish', { id, status: 'public' });
      return published;
    });
  }

  link(id: string, input: { cell: string; version?: string }): ClaimRow {
    const cell = required(input.cell, 'cell');
    const version = input.version === undefined ? null : required(input.version, 'version');
    return this.using(db => this.transaction(db, () => {
      const row = this.row(db, id);
      const at = this.now().toISOString();
      db.query('INSERT INTO links (claim_id, cell, version) VALUES (?, ?, ?)').run(id, cell, version);
      db.query('UPDATE claims SET updated_at = ? WHERE id = ?').run(at, id);
      this.record(db, id, at, 'system', 'link', version ? `${cell} (${version})` : cell);
      debug.log('claims.ledger', 'link', { id, status: row.status });
      return this.row(db, id);
    }));
  }

  retract(id: string, input: { reason: string; by: string }): ClaimRow {
    const reason = required(input.reason, 'reason');
    const by = required(input.by, 'by');
    return this.using(db => this.transaction(db, () => {
      if (this.row(db, id).status === 'retracted') throw new ClaimsInputError(`claim already retracted: ${id}`);
      const at = this.now().toISOString();
      db.query("UPDATE claims SET status = 'retracted', updated_at = ? WHERE id = ?").run(at, id);
      this.record(db, id, at, by, 'retract', reason);
      debug.log('claims.ledger', 'retract', { id, status: 'retracted' });
      return this.row(db, id);
    }));
  }

  list(filters: { status?: ClaimStatus; audience?: string } = {}): ClaimRow[] {
    if (filters.status && !['draft', 'verified', 'public', 'stale', 'retracted'].includes(filters.status)) throw new ClaimsInputError('invalid status');
    return this.using(db => this.transaction(db, () => {
      const at = this.now().toISOString();
      return (db.query('SELECT * FROM claims ORDER BY created_at, id').all() as ClaimRow[])
        .map(row => this.refresh(db, row, at))
        .filter(row => (!filters.status || row.status === filters.status)
          && (!filters.audience || row.audience.split(',').includes(filters.audience)));
    }));
  }

  get(id: string): ClaimDetail {
    return this.using(db => this.transaction(db, () => {
      const row = this.refresh(db, this.row(db, id), this.now().toISOString());
      return { ...row,
        evidence: db.query('SELECT claim_id, value, command, source, measured_at, valid_until FROM evidence WHERE claim_id = ? ORDER BY measured_at, rowid').all(id) as ClaimEvidence[],
        links: db.query('SELECT claim_id, cell, version FROM links WHERE claim_id = ? ORDER BY rowid').all(id) as ClaimLink[],
        history: db.query('SELECT claim_id, at, by, event, detail FROM history WHERE claim_id = ? ORDER BY rowid').all(id) as ClaimHistory[],
      };
    }));
  }
}
