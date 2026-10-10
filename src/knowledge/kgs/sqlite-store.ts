// KGS P2 — SQLite-backed store with FTS5 BM25 search. Cascade-zyu W3 Y1.
// Patcher (W5 Y3) writes through SamCoordinator.knowledge delegate.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import type {
  KnowledgeCard,
  KnowledgeKind,
  KnowledgeNature,
  Pack,
  PackKind,
} from './index.js';

interface CardRow {
  id: string;
  payload: string;
  nature: string;
  kind: string;
  created_at: string;
  updated_at: string;
  mission_id: string | null;
}

export interface KgsSearchQuery {
  /** FTS5 MATCH expression — e.g. 'pattern' or 'workflow OR template'. */
  text?: string;
  kind?: KnowledgeKind;
  nature?: KnowledgeNature;
  missionId?: string;
  limit?: number;
}

export interface KgsSearchHit {
  card: KnowledgeCard;
  /** BM25 rank (lower = better). Null when the query did not include FTS5 text. */
  rank: number | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kgs_card (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  nature TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  mission_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_kgs_card_kind ON kgs_card(kind);
CREATE INDEX IF NOT EXISTS idx_kgs_card_nature ON kgs_card(nature);
CREATE INDEX IF NOT EXISTS idx_kgs_card_mission ON kgs_card(mission_id);

CREATE VIRTUAL TABLE IF NOT EXISTS kgs_card_fts USING fts5(
  id UNINDEXED,
  bm25_text,
  tokenize = 'porter'
);

CREATE TABLE IF NOT EXISTS kgs_pack (
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  payload TEXT NOT NULL,
  kind TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, version)
);
CREATE INDEX IF NOT EXISTS idx_kgs_pack_kind ON kgs_pack(kind);
`;

let dbPathOverride: string | null = null;

export function setKgsDbPathOverride(path: string | null): void {
  dbPathOverride = path;
}

export function kgsDefaultDbPath(): string {
  return dbPathOverride ?? join(getElanousConfigDir(), 'kgs', 'kgs.db');
}

function ensureDir(path: string): void {
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
  catch { /* best-effort */ }
}

export class KgsSqliteStore {
  private db: Database;

  constructor(path?: string) {
    const dbPath = path ?? kgsDefaultDbPath();
    if (dbPath !== ':memory:') ensureDir(dbPath);
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  writeCard(card: KnowledgeCard): void {
    const bm25Text = card.bm25_text ?? `${card.title}\n${card.body}`;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO kgs_card (id, payload, nature, kind, created_at, updated_at, mission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload=excluded.payload,
           nature=excluded.nature,
           kind=excluded.kind,
           updated_at=excluded.updated_at,
           mission_id=excluded.mission_id`,
        [
          card.id,
          JSON.stringify(card),
          card.nature,
          card.kind,
          card.createdAt,
          card.updatedAt,
          card.missionId ?? null,
        ],
      );
      this.db.run(`DELETE FROM kgs_card_fts WHERE id = ?`, [card.id]);
      this.db.run(
        `INSERT INTO kgs_card_fts (id, bm25_text) VALUES (?, ?)`,
        [card.id, bm25Text],
      );
    })();
  }

  readCard(id: string): KnowledgeCard | null {
    const row = this.db
      .query(`SELECT * FROM kgs_card WHERE id = ?`)
      .get(id) as CardRow | null;
    if (!row) return null;
    return JSON.parse(row.payload) as KnowledgeCard;
  }

  deleteCard(id: string): boolean {
    const before = this.db
      .query(`SELECT 1 FROM kgs_card WHERE id = ?`)
      .get(id);
    if (!before) return false;
    this.db.transaction(() => {
      this.db.run(`DELETE FROM kgs_card WHERE id = ?`, [id]);
      this.db.run(`DELETE FROM kgs_card_fts WHERE id = ?`, [id]);
    })();
    return true;
  }

  search(query: KgsSearchQuery): readonly KgsSearchHit[] {
    const limit = Math.min(query.limit ?? 50, 200);
    if (query.text && query.text.trim().length > 0) {
      const sql = `
        SELECT c.payload AS payload, bm25(kgs_card_fts) AS rank
        FROM kgs_card_fts
        JOIN kgs_card c ON c.id = kgs_card_fts.id
        WHERE kgs_card_fts MATCH ?
          ${query.kind ? 'AND c.kind = ?' : ''}
          ${query.nature ? 'AND c.nature = ?' : ''}
          ${query.missionId ? 'AND c.mission_id = ?' : ''}
        ORDER BY rank ASC
        LIMIT ?`;
      const params: (string | number)[] = [query.text];
      if (query.kind) params.push(query.kind);
      if (query.nature) params.push(query.nature);
      if (query.missionId) params.push(query.missionId);
      params.push(limit);
      const rows = this.db.query(sql).all(...params) as Array<{ payload: string; rank: number }>;
      return rows.map((r) => ({
        card: JSON.parse(r.payload) as KnowledgeCard,
        rank: r.rank,
      }));
    }
    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (query.kind) { filters.push('kind = ?'); params.push(query.kind); }
    if (query.nature) { filters.push('nature = ?'); params.push(query.nature); }
    if (query.missionId) { filters.push('mission_id = ?'); params.push(query.missionId); }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit);
    const rows = this.db
      .query(`SELECT payload FROM kgs_card ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as Array<{ payload: string }>;
    return rows.map((r) => ({
      card: JSON.parse(r.payload) as KnowledgeCard,
      rank: null,
    }));
  }

  writePack(pack: Pack): void {
    this.db.run(
      `INSERT INTO kgs_pack (slug, version, payload, kind, audience, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, version) DO UPDATE SET
         payload=excluded.payload,
         kind=excluded.kind,
         audience=excluded.audience,
         updated_at=excluded.updated_at`,
      [
        pack.metadata.id.slug,
        pack.metadata.id.version,
        JSON.stringify(pack),
        pack.metadata.kind,
        pack.metadata.audience,
        pack.metadata.createdAt,
        pack.metadata.updatedAt,
      ],
    );
  }

  /** Remove only the selected version; standalone pack cards live inside its payload. */
  deletePack(slug: string, version: string): boolean {
    return this.db.run('DELETE FROM kgs_pack WHERE slug = ? AND version = ?', [slug, version]).changes > 0;
  }

  /** Switch versions as one SQLite transaction so failed upgrades retain the old index. */
  replacePack(previous: { slug: string; version: string }, next: Pack): void {
    this.db.transaction(() => {
      if (!this.readPack(previous.slug, previous.version)) throw new Error('pack not installed');
      if (this.readPack(next.metadata.id.slug, next.metadata.id.version)) throw new Error('pack version already installed');
      this.writePack(next);
      if (!this.deletePack(previous.slug, previous.version)) throw new Error('pack not removed');
    })();
  }

  readPack(slug: string, version: string): Pack | null {
    const row = this.db
      .query(`SELECT payload FROM kgs_pack WHERE slug = ? AND version = ?`)
      .get(slug, version) as { payload: string } | null;
    if (!row) return null;
    return JSON.parse(row.payload) as Pack;
  }

  listPacksByKind(kind: PackKind, limit = 100): readonly Pack[] {
    const rows = this.db
      .query(`SELECT payload FROM kgs_pack WHERE kind = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(kind, limit) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Pack);
  }

  cardCount(): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM kgs_card`)
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

// ──────────────────── Singleton accessor (FU8 PR #3) ────────────────
//
// Lazy module-level handle so consumers that need read-only KGS
// access (intake-plane keyword crawl, future Patcher / Thinker hot
// paths) share one connection instead of reopening the SQLite file
// per request. Reset via `_resetKgsStoreSingleton()` in tests so
// each suite can swap the path override + start from a clean slate.

let storeSingleton: KgsSqliteStore | null = null;

/** Lazily-built shared `KgsSqliteStore`. Uses `kgsDefaultDbPath()` so
 *  the `setKgsDbPathOverride()` test seam still applies. Callers that
 *  need a different path should instantiate `new KgsSqliteStore(...)`
 *  directly. */
export function kgsStoreSingleton(): KgsSqliteStore {
  if (!storeSingleton) storeSingleton = new KgsSqliteStore();
  return storeSingleton;
}

/** Test seam — drop the cached singleton so a subsequent call rebuilds
 *  with the current path override. Mirrors `_resetSignalBus` /
 *  `_resetUserIntentLogger` reset contract. */
export function _resetKgsStoreSingleton(): void {
  if (storeSingleton) {
    try { storeSingleton.close(); } catch { /* best-effort */ }
  }
  storeSingleton = null;
}
