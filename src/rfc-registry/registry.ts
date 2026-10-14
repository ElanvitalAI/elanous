import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { assertNotTestWritingOps } from '../instance/test-write-guard.js';

/** The RFC ledger is independent of the release checklist ledger. Callers own and close the handle. */
export function openRfcRegistry(root = releaseLedgerRoot()): Database {
  const path = join(root, 'rfc', 'registry.sqlite');
  assertNotTestWritingOps(path, 'open the RFC registry');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS rfc (
      id TEXT PRIMARY KEY CHECK(length(id) = 8 AND id GLOB 'RFC-[0-9][0-9][0-9][0-9]'),
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      status TEXT NOT NULL,
      doc_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rfc_item (
      id TEXT PRIMARY KEY CHECK(length(id) = 12 AND id GLOB 'RFC-[0-9][0-9][0-9][0-9].I[0-9][0-9]'),
      rfc_id TEXT NOT NULL REFERENCES rfc(id),
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(substr(id, 1, 8) = rfc_id)
    );
    CREATE TABLE IF NOT EXISTS rfc_item_link (
      item_id TEXT NOT NULL REFERENCES rfc_item(id),
      target_item_id TEXT NOT NULL REFERENCES rfc_item(id),
      PRIMARY KEY(item_id, target_item_id),
      CHECK(item_id <> target_item_id)
    );
    CREATE TABLE IF NOT EXISTS rfc_event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      rfc_id TEXT NOT NULL REFERENCES rfc(id),
      item_id TEXT REFERENCES rfc_item(id),
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT
    );
    CREATE TRIGGER IF NOT EXISTS rfc_id_immutable BEFORE UPDATE OF id ON rfc
      BEGIN SELECT RAISE(ABORT, 'RFC identifier is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS rfc_no_delete BEFORE DELETE ON rfc
      BEGIN SELECT RAISE(ABORT, 'RFC identifier is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS rfc_item_id_immutable BEFORE UPDATE OF id, rfc_id ON rfc_item
      BEGIN SELECT RAISE(ABORT, 'RFC item identifier is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS rfc_item_no_delete BEFORE DELETE ON rfc_item
      BEGIN SELECT RAISE(ABORT, 'RFC item identifier is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS rfc_event_item_parent BEFORE INSERT ON rfc_event
      WHEN NEW.item_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM rfc_item WHERE id = NEW.item_id AND rfc_id = NEW.rfc_id)
      BEGIN SELECT RAISE(ABORT, 'RFC event item belongs to another RFC'); END;
    CREATE TRIGGER IF NOT EXISTS rfc_event_no_update BEFORE UPDATE ON rfc_event
      BEGIN SELECT RAISE(ABORT, 'RFC event history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS rfc_event_no_delete BEFORE DELETE ON rfc_event
      BEGIN SELECT RAISE(ABORT, 'RFC event history is append-only'); END;`);
    return db;
  } catch (error) { db.close(); throw error; }
}

export interface RfcRow { id: string; title: string; status: string; doc_path: string | null; created_at: string }
export interface RfcItemRow { id: string; rfc_id: string; title: string; status: string; created_at: string }
export interface RfcItemLinkRow { item_id: string; target_item_id: string }
export interface RfcDetail extends RfcRow { items: Array<RfcItemRow & { links: RfcItemLinkRow[] }> }

export function listRfcs(root?: string): RfcRow[] {
  const db = openRfcRegistry(root);
  try { return db.query('SELECT id, title, status, doc_path, created_at FROM rfc ORDER BY id').all() as RfcRow[]; }
  finally { db.close(); }
}

export function showRfc(id: string, root?: string): RfcDetail | null {
  const db = openRfcRegistry(root);
  try {
    const read = db.transaction(() => {
      const row = db.query('SELECT id, title, status, doc_path, created_at FROM rfc WHERE id = ?').get(id) as RfcRow | null;
      if (!row) return null;
      const items = db.query('SELECT id, rfc_id, title, status, created_at FROM rfc_item WHERE rfc_id = ? ORDER BY id').all(id) as RfcItemRow[];
      return { ...row, items: items.map((item) => ({ ...item, links: db.query('SELECT item_id, target_item_id FROM rfc_item_link WHERE item_id = ? ORDER BY target_item_id').all(item.id) as RfcItemLinkRow[] })) };
    });
    return read();
  } finally { db.close(); }
}
