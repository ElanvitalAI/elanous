import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import type { LessonLedgerOptions } from './lesson-ledger.js';

export type FrictionActor = 'OP' | 'TC' | 'MK' | 'UX' | 'ceo' | 'person';
export type FrictionKind = 'hand-step' | 'ceo-correction' | 'repeat-question';

export const FRICTION_ACTORS: readonly FrictionActor[] = ['OP', 'TC', 'MK', 'UX', 'ceo', 'person'];
export const FRICTION_KINDS: readonly FrictionKind[] = ['hand-step', 'ceo-correction', 'repeat-question'];
export const FRICTION_CANDIDATE_MIN = 3;

export interface FrictionRecordInput {
  actor: FrictionActor;
  kind: FrictionKind;
  signature: string;
  note?: string;
  ref: string;
}

export interface FrictionRow {
  id: number;
  actor: FrictionActor;
  kind: FrictionKind;
  signature: string;
  note: string;
  ref: string;
  recorded_at: string;
}

export interface FrictionCandidate {
  kind: FrictionKind;
  signature: string;
  count: number;
  firstAt: string;
  lastAt: string;
  refs: string[];
}

export class FrictionInputError extends Error {
  override name = 'FrictionInputError';
}

/** Secret-shaped note bodies are never persisted: a token or key would be copied into the ledger. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/u,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/u,
  /AKIA[0-9A-Z]{12,}/u,
  /xox[bapr]-[A-Za-z0-9-]{8,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b[0-9a-f]{32,}\b/u,
  /\b[A-Za-z0-9+/=_-]{40,}\b/u,
  /(?:api[_-]?key|access[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/iu,
];

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FrictionInputError(`${field} is required`);
  return value.trim();
}

function checkActor(value: FrictionActor): FrictionActor {
  if (!FRICTION_ACTORS.includes(value)) throw new FrictionInputError(`actor must be one of ${FRICTION_ACTORS.join(', ')}`);
  return value;
}

function checkKind(value: FrictionKind): FrictionKind {
  if (!FRICTION_KINDS.includes(value)) throw new FrictionInputError(`kind must be one of ${FRICTION_KINDS.join(', ')}`);
  return value;
}

/** Same hand step spelled differently is the same hand step: lower case, whitespace runs folded to one space. */
function normalizeSignature(value: unknown): string {
  const signature = required(value, 'signature').replace(/\s+/gu, ' ').toLowerCase();
  if (!signature) throw new FrictionInputError('signature is required');
  return signature;
}

export function frictionActor(name: string): FrictionActor {
  const key = name.trim().toLowerCase();
  return FRICTION_ACTORS.find(actor => actor.toLowerCase() === key) ?? 'person';
}

function secretFreeNote(note: unknown): string {
  const text = note === undefined || note === null ? '' : String(note);
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) throw new FrictionInputError('note looks like a secret (token or key)');
  return text;
}

export class FrictionLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: LessonLedgerOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'lessons', 'friction.sqlite');
    this.now = options.now ?? (() => new Date());
  }

  private open(): Database {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS friction (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL CHECK(actor IN ('OP','TC','MK','UX','ceo','person')),
        kind TEXT NOT NULL CHECK(kind IN ('hand-step','ceo-correction','repeat-question')),
        signature TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL, recorded_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS friction_group ON friction (kind, signature);`);
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private using<T>(work: (db: Database) => T): T {
    const db = this.open();
    try { return work(db); } finally { db.close(); }
  }

  record(input: FrictionRecordInput): FrictionRow {
    const actor = checkActor(input.actor);
    const kind = checkKind(input.kind);
    const signature = normalizeSignature(input.signature);
    const note = secretFreeNote(input.note);
    const ref = required(input.ref, 'ref');
    return this.using(db => {
      const at = this.now().toISOString();
      const inserted = db.query('INSERT INTO friction (actor, kind, signature, note, ref, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(actor, kind, signature, note, ref, at);
      const row = db.query('SELECT id, actor, kind, signature, note, ref, recorded_at FROM friction WHERE id = ?')
        .get(Number(inserted.lastInsertRowid)) as FrictionRow | null;
      if (!row) throw new FrictionInputError('friction row was not stored');
      debug.log('lessons.friction', 'record', { id: row.id, kind: row.kind, actor: row.actor });
      return row;
    });
  }

  /** Same hand step three times is a proposal candidate (§4⑤ SELF-PROPOSE-BASE), not one-off noise. */
  candidates(min: number = FRICTION_CANDIDATE_MIN): FrictionCandidate[] {
    if (!Number.isInteger(min) || min < 1) throw new FrictionInputError('min must be a positive integer');
    return this.using(db => {
      const groups = db.query(`SELECT kind, signature, count(*) AS count, min(recorded_at) AS firstAt, max(recorded_at) AS lastAt
        FROM friction GROUP BY kind, signature HAVING count(*) >= ?
        ORDER BY count DESC, lastAt DESC, kind, signature`).all(min) as Omit<FrictionCandidate, 'refs'>[];
      return groups.map(group => ({
        ...group,
        refs: (db.query('SELECT ref FROM friction WHERE kind = ? AND signature = ? ORDER BY id')
          .all(group.kind, group.signature) as { ref: string }[]).map(row => row.ref),
      }));
    });
  }
}
