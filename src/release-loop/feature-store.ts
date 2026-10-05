import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { CliUserError } from '../cli/cli-user-error.js';
import { debug } from '../debug/log.js';
import { devVersion, type Checklist, type ChecklistHistory, type ChecklistItem } from './checklist.js';

export function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) throw new CliUserError(`체크리스트 판이 아니다: ${version}`);
}

function jsonPath(version: string): string { validateVersion(version); return join(releaseLedgerRoot(), 'release', version, 'checklist.json'); }
function legacyVersions(): string[] {
  const root = join(releaseLedgerRoot(), 'release');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((version) => /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version) && existsSync(jsonPath(version)));
}
export function releasedVersion(ledgerRoot = releaseLedgerRoot()): string {
  const root = join(ledgerRoot, 'release');
  if (!existsSync(root)) return '';
  return readdirSync(root).filter((version) => /^\d+\.\d+\.\d+$/.test(version) && existsSync(join(root, version, 'release.json')))
    .filter((version) => {
      try { const record = JSON.parse(readFileSync(join(root, version, 'release.json'), 'utf8')) as { version?: string; publishedAt?: string }; return record.version === version && typeof record.publishedAt === 'string'; }
      catch { return false; }
    }).sort((a, b) => {
      const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
      return (bb[0]! - aa[0]!) || (bb[1]! - aa[1]!) || (bb[2]! - aa[2]!);
    })[0] ?? '';
}
const walWait = new Int32Array(new SharedArrayBuffer(4));
const SCHEMA_COLUMNS: Record<string, readonly string[]> = {
  imported_versions: ['json_hash', 'imported_at'],
  events: ['reason'],
  assignments: ['priority', 'predecessors', 'deadline_version', 'ceo_minutes', 'ceo_date'],
  release_schedules: ['freeze_from', 'freeze_until'],
};
function schemaCurrent(db: Database): boolean {
  return Object.entries(SCHEMA_COLUMNS).every(([table, names]) => {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    return names.every((name) => columns.has(name));
  });
}
function open(root = releaseLedgerRoot()): Database {
  const path = join(root, 'release', 'features.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 10000');
    if ((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode !== 'wal') {
      // First open may race another process initializing the same database; journal_mode needs an exclusive lock.
      for (let attempt = 0; ; attempt++) {
        try { db.exec('PRAGMA journal_mode = WAL'); break; }
        catch (error) {
          if (!(error instanceof Error) || !/database is locked/.test(error.message) || attempt >= 500) throw error;
          Atomics.wait(walWait, 0, 0, 20);
        }
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
    // Two processes opening a fresh ledger both saw a missing column and both ran ALTER TABLE ("duplicate column name").
    // BEGIN IMMEDIATE serializes the schema check and the migration, so the second writer re-reads the migrated schema.
    // An up-to-date ledger skips the write lock so readers don't queue behind each other.
    if (!schemaCurrent(db)) db.transaction(() => {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'imported_versions'").get()) db.exec(`CREATE TABLE IF NOT EXISTS features (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT, kind TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments (feature_id TEXT NOT NULL REFERENCES features(id), version TEXT NOT NULL, status TEXT NOT NULL, disposition TEXT, evidence TEXT, title_override TEXT, owner TEXT, kind TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(feature_id, version));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT NOT NULL, feature_id TEXT NOT NULL, version TEXT NOT NULL, field TEXT NOT NULL, "from" TEXT, "to" TEXT, released TEXT NOT NULL, dev TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS evidence (feature_id TEXT NOT NULL, version TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_versions (version TEXT PRIMARY KEY, json_hash TEXT, imported_at TEXT);`);
      const columns = db.query('PRAGMA table_info(imported_versions)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'json_hash')) db.exec('ALTER TABLE imported_versions ADD COLUMN json_hash TEXT');
      if (!columns.some((column) => column.name === 'imported_at')) db.exec('ALTER TABLE imported_versions ADD COLUMN imported_at TEXT');
      if (!(db.query('PRAGMA table_info(events)').all() as Array<{ name: string }>).some((column) => column.name === 'reason')) db.exec('ALTER TABLE events ADD COLUMN reason TEXT');
      db.exec('CREATE TABLE IF NOT EXISTS release_schedules (version TEXT PRIMARY KEY, cut_at TEXT NOT NULL, land_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)');
      const assignmentColumns = db.query('PRAGMA table_info(assignments)').all() as Array<{ name: string }>;
      for (const [name, sql] of [['priority', 'TEXT'], ['predecessors', 'TEXT'], ['deadline_version', 'TEXT'], ['ceo_minutes', 'INTEGER'], ['ceo_date', 'TEXT']] as const) {
        if (!assignmentColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${sql}`);
      }
      const scheduleColumns = db.query('PRAGMA table_info(release_schedules)').all() as Array<{ name: string }>;
      for (const name of ['freeze_from', 'freeze_until']) if (!scheduleColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE release_schedules ADD COLUMN ${name} TEXT`);
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error; }
}

export interface ScheduleRow { version: string; cutAt: string; landBy: string | null; freezeFrom?: string | null; freezeUntil?: string | null; updatedAt: string; updatedBy: string }
type StoredSchedule = { version: string; cut_at: string; land_by: string | null; freeze_from: string | null; freeze_until: string | null; updated_at: string; updated_by: string };
function scheduleRow(row: StoredSchedule): ScheduleRow {
  return { version: row.version, cutAt: row.cut_at, landBy: row.land_by, ...(row.freeze_from ? { freezeFrom: row.freeze_from } : {}), ...(row.freeze_until ? { freezeUntil: row.freeze_until } : {}), updatedAt: row.updated_at, updatedBy: row.updated_by };
}

export function readSchedule(version: string, root?: string): ScheduleRow | null {
  validateVersion(version);
  if (!existsSync(join(root ?? releaseLedgerRoot(), 'release', 'features.sqlite'))) return null;
  const db = open(root);
  try {
    const row = db.query('SELECT * FROM release_schedules WHERE version = ?').get(version) as StoredSchedule | null;
    return row ? scheduleRow(row) : null;
  } finally { db.close(); }
}

export function readSchedules(root?: string): ScheduleRow[] {
  const db = open(root);
  try { return (db.query('SELECT * FROM release_schedules ORDER BY version').all() as StoredSchedule[]).map(scheduleRow); }
  finally { db.close(); }
}

/** Versions with checklist assignments, including SQLite-only releases without a schedule or legacy JSON. */
export function assignedVersions(root = releaseLedgerRoot()): string[] {
  if (!existsSync(join(root, 'release', 'features.sqlite'))) return [];
  const db = open(root);
  try { return (db.query('SELECT DISTINCT version FROM assignments ORDER BY version').all() as Array<{ version: string }>).map(({ version }) => version); }
  finally { db.close(); }
}

export function writeSchedule(version: string, patch: { cutAt?: string; landBy?: string; freezeFrom?: string; freezeUntil?: string }, by: string, root?: string): ScheduleRow {
  validateVersion(version);
  const db = open(root);
  try {
    return transaction(db, () => {
      const previous = db.query('SELECT * FROM release_schedules WHERE version = ?').get(version) as StoredSchedule | null;
      const cutAt = patch.cutAt ?? previous?.cut_at;
      if (!cutAt) throw new CliUserError('새 판에는 --cut-at 이 필요하다');
      const landBy = patch.landBy ?? previous?.land_by ?? null;
      const freezeFrom = patch.freezeFrom ?? previous?.freeze_from ?? null;
      const freezeUntil = patch.freezeUntil ?? previous?.freeze_until ?? null;
      if (Boolean(freezeFrom) !== Boolean(freezeUntil) || (freezeFrom && freezeUntil && Date.parse(freezeFrom) >= Date.parse(freezeUntil))) throw new CliUserError('동결 시작·끝은 함께 주고 시작이 끝보다 앞서야 한다');
      if (previous && previous.cut_at === cutAt && previous.land_by === landBy && previous.freeze_from === freezeFrom && previous.freeze_until === freezeUntil) return scheduleRow(previous);
      const at = new Date().toISOString();
      db.query(`INSERT INTO release_schedules (version, cut_at, land_by, freeze_from, freeze_until, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET cut_at=excluded.cut_at, land_by=excluded.land_by, freeze_from=excluded.freeze_from, freeze_until=excluded.freeze_until, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(version, cutAt, landBy, freezeFrom, freezeUntil, at, by);
      for (const [field, from, to] of [
        ['cut_at', previous?.cut_at ?? null, cutAt], ['land_by', previous?.land_by ?? null, landBy],
        ['freeze_from', previous?.freeze_from ?? null, freezeFrom], ['freeze_until', previous?.freeze_until ?? null, freezeUntil],
      ] as const) {
        if (from !== to) record(db, version, { at, by, id: '@version', field, from, to, released: releasedVersion(root), dev: devVersion() });
      }
      return { version, cutAt, landBy, updatedAt: at, updatedBy: by };
    });
  } finally { db.close(); }
}

function transaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** Read-only counterpart: one deferred transaction so a snapshot never mixes rows from before and after a concurrent write. */
function readTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN DEFERRED');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

type EventRow = { seq: number; at: string; by: string; feature_id: string; version: string; field: string; from: string; to: string; released: string; dev: string; reason: string | null };
function decode(value: string | null): unknown { return value === null ? null : JSON.parse(value); }
function historyRow(row: EventRow): ChecklistHistory {
  return { at: row.at, by: row.by, id: row.feature_id, field: row.field, from: decode(row.from), to: decode(row.to), released: row.released, dev: row.dev,
    ...(row.reason !== null ? { reason: row.reason } : {}) };
}
function record(db: Database, version: string, entry: ChecklistHistory): void {
  db.query('INSERT INTO events (at, by, feature_id, version, field, "from", "to", released, dev, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(entry.at, entry.by, entry.id, version, entry.field, JSON.stringify(entry.from ?? null), JSON.stringify(entry.to ?? null), entry.released, entry.dev, entry.reason ?? null);
}
function evidenceRefs(db: Database, version: string, id: string): string[] {
  return (db.query('SELECT ref FROM evidence WHERE feature_id = ? AND version = ? ORDER BY rowid').all(id, version) as Array<{ ref: string }>).map((row) => row.ref);
}
function items(db: Database, version: string): ChecklistItem[] {
  const rows = db.query(`SELECT f.id, COALESCE(a.title_override, f.title) AS title, a.owner, a.kind, a.priority, a.predecessors, a.deadline_version, a.ceo_minutes, a.ceo_date, a.status, a.disposition, a.evidence, a.updated_at, a.updated_by
    FROM assignments a JOIN features f ON f.id = a.feature_id WHERE a.version = ? ORDER BY a.rowid`).all(version) as Array<Record<string, string | number | null>>;
  return rows.map((r) => {
    const evidence = [r.evidence, ...evidenceRefs(db, version, r.id as string)].filter((value) => value !== null).join('\n');
    return { id: r.id as string, title: r.title as string, status: r.status as ChecklistItem['status'],
      ...(r.owner !== null ? { owner: r.owner as string } : {}), ...(r.kind !== null ? { kind: r.kind as ChecklistItem['kind'] } : {}),
      ...(r.priority !== null ? { priority: r.priority as ChecklistItem['priority'] } : {}), ...(r.predecessors !== null ? { predecessors: JSON.parse(r.predecessors as string) as string[] } : {}),
      ...(r.deadline_version !== null ? { deadlineVersion: r.deadline_version as string } : {}),
      ...(r.ceo_minutes !== null ? { ceoMinutes: r.ceo_minutes as number } : {}), ...(r.ceo_date !== null ? { ceoDate: r.ceo_date as string } : {}),
      ...(r.evidence !== null || evidence ? { evidence } : {}), ...(r.disposition !== null ? { disposition: r.disposition as ChecklistItem['disposition'] } : {}),
      updatedAt: r.updated_at as string, updatedBy: r.updated_by as string };
  });
}
function snapshot(db: Database, version: string, released: string, dev: string): Checklist {
  const rows = db.query('SELECT * FROM events WHERE version = ? ORDER BY seq').all(version) as EventRow[];
  return { version, released, dev, items: items(db, version), history: rows.map(historyRow) };
}
function putItem(db: Database, version: string, item: ChecklistItem): void {
  const feature = db.query('SELECT title FROM features WHERE id = ?').get(item.id) as { title: string } | null;
  if (!feature) db.query('INSERT INTO features (id, title, owner, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(item.id, item.title, item.owner ?? null, item.kind ?? null, item.updatedAt);
  // features.owner/kind follow the latest assignment so details() and the checklist never disagree after a set.
  else if (item.owner !== undefined || item.kind !== undefined) db.query('UPDATE features SET owner = COALESCE(?, owner), kind = COALESCE(?, kind) WHERE id = ?').run(item.owner ?? null, item.kind ?? null, item.id);
  db.query(`INSERT INTO assignments (feature_id, version, status, disposition, evidence, title_override, owner, kind, priority, predecessors, deadline_version, ceo_minutes, ceo_date, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(feature_id, version) DO UPDATE SET status=excluded.status, disposition=excluded.disposition, evidence=excluded.evidence, owner=excluded.owner, kind=excluded.kind, priority=excluded.priority, predecessors=excluded.predecessors, deadline_version=excluded.deadline_version, ceo_minutes=excluded.ceo_minutes, ceo_date=excluded.ceo_date, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(item.id, version, item.status, item.disposition ?? null, item.evidence ?? null, feature && feature.title !== item.title ? item.title : null, item.owner ?? null, item.kind ?? null, item.priority ?? null, item.predecessors ? JSON.stringify(item.predecessors) : null, item.deadlineVersion ?? null, item.ceoMinutes ?? null, item.ceoDate ?? null, item.updatedAt, item.updatedBy);
}
function jsonHash(contents: string | Buffer): string { return createHash('sha256').update(contents).digest('hex'); }

/**
 * When did the ledger take this item away from `version`? A `move` out of it, a `remove` at it, or (carry-forward
 * without a move event) the item now living in another version. null = never left — a JSON-only item is new.
 * OP 10-02: without this, an old build's checklist.json re-added items the ledger had moved or removed (duplicates).
 */
function ledgerLeftAt(db: Database, id: string, version: string): string | null {
  const event = db.query(`SELECT MAX(at) AS at FROM events WHERE feature_id = ? AND
    ((field = 'move' AND "from" = ?) OR (field = 'remove' AND version = ?))`).get(id, JSON.stringify(version), version) as { at: string | null };
  const elsewhere = db.query('SELECT MAX(updated_at) AS at FROM assignments WHERE feature_id = ? AND version <> ?').get(id, version) as { at: string | null };
  const times = [event.at, elsewhere.at].filter((t): t is string => typeof t === 'string');
  return times.length ? times.sort().at(-1)! : null;
}

function importOnDb(db: Database, version: string): boolean {
  const previous = db.query('SELECT json_hash FROM imported_versions WHERE version = ?').get(version) as { json_hash: string | null } | null;
  const path = jsonPath(version);
  if (!existsSync(path)) {
    if (!previous) db.query('INSERT INTO imported_versions (version) VALUES (?)').run(version);
    return false;
  }
  const contents = readFileSync(path);
  const hash = jsonHash(contents);
  if (previous && previous.json_hash === hash) return false;
  const data = JSON.parse(contents.toString('utf8')) as Checklist;
  if (data.version !== version) throw new CliUserError(`체크리스트 판 불일치: ${path}`);
  if (!Array.isArray(data.items) || !Array.isArray(data.history)) throw new CliUserError(`잘못된 체크리스트: ${path}`);
  const duplicate = new Set<string>();
  for (const item of data.items) {
    if (!item.id?.trim() || !item.title?.trim() || duplicate.has(item.id) || !['green', 'yellow', 'red', 'done'].includes(item.status)) throw new CliUserError(`잘못된 체크리스트 칸: ${version} ${item.id}`);
    duplicate.add(item.id);
  }
  if (!previous) {
    for (const item of data.items) {
      const existing = db.query('SELECT title FROM features WHERE id = ?').get(item.id) as { title: string } | null;
      // Keep a legacy per-version title until an explicit retitle unifies the feature identity.
      if (!existing) putItem(db, version, item);
      else {
        db.query('INSERT OR IGNORE INTO assignments (feature_id, version, status, disposition, evidence, title_override, owner, kind, priority, predecessors, deadline_version, ceo_minutes, ceo_date, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(item.id, version, item.status, item.disposition ?? null, item.evidence ?? null, item.title === existing.title ? null : item.title, item.owner ?? null, item.kind ?? null, item.priority ?? null, item.predecessors ? JSON.stringify(item.predecessors) : null, item.deadlineVersion ?? null, item.ceoMinutes ?? null, item.ceoDate ?? null, item.updatedAt, item.updatedBy);
      }
    }
    for (const entry of data.history) record(db, version, entry);
    db.query('INSERT INTO imported_versions (version, json_hash, imported_at) VALUES (?, ?, ?)').run(version, hash, new Date().toISOString());
    return true;
  }

  const ledger = new Map(items(db, version).map((item) => [item.id, item]));
  const changed: string[] = [];
  let added = 0;
  const ledgerWonIds: string[] = [];
  const leftIds: string[] = [];
  for (const item of data.items) {
    const current = ledger.get(item.id);
    if (!current) {
      // Moved or removed in the ledger: only a JSON edit made after that may bring it back.
      const leftAt = ledgerLeftAt(db, item.id, version);
      if (leftAt && !(Date.parse(item.updatedAt) > Date.parse(leftAt))) { leftIds.push(item.id); continue; }
      const feature = db.query('SELECT title FROM features WHERE id = ?').get(item.id) as { title: string } | null;
      putItem(db, version, item);
      if (feature && feature.title !== item.title) db.query('UPDATE assignments SET title_override = ? WHERE feature_id = ? AND version = ?').run(item.title, item.id, version);
      added++;
      changed.push(item.id);
      record(db, version, { at: new Date().toISOString(), by: item.updatedBy, id: item.id, field: 'reimport', from: null, to: item, released: data.released, dev: data.dev });
      continue;
    }
    const fields = ['title', 'status', 'evidence', 'owner', 'disposition', 'kind', 'priority', 'predecessors', 'deadlineVersion', 'ceoMinutes', 'ceoDate'] as const;
    const baseEvidence = (db.query('SELECT evidence FROM assignments WHERE feature_id = ? AND version = ?').get(item.id, version) as { evidence: string | null }).evidence ?? undefined;
    const preserveRefs = item.evidence === baseEvidence || item.evidence === current.evidence;
    const differs = fields.some((field) => field === 'evidence'
      ? (!preserveRefs && current.evidence !== item.evidence)
      : JSON.stringify(current[field]) !== JSON.stringify(item[field]));
    if (!differs) continue;
    if (!(Date.parse(item.updatedAt) > Date.parse(current.updatedAt))) {
      ledgerWonIds.push(item.id);
      continue;
    }
    const incoming: ChecklistItem = { ...current, status: item.status, updatedAt: item.updatedAt, updatedBy: item.updatedBy };
    for (const field of fields) {
      if (field === 'status') continue;
      if (field === 'evidence' && preserveRefs) continue;
      if (item[field] === undefined) delete (incoming as unknown as Record<string, unknown>)[field];
      else (incoming as unknown as Record<string, unknown>)[field] = item[field];
    }
    if (!preserveRefs) db.query('DELETE FROM evidence WHERE feature_id = ? AND version = ?').run(item.id, version);
    const persisted = preserveRefs ? { ...incoming, evidence: baseEvidence } : incoming;
    putItem(db, version, persisted);
    if (incoming.title !== current.title) {
      db.query('UPDATE assignments SET title_override = ? WHERE feature_id = ? AND version = ?')
        .run(incoming.title === (db.query('SELECT title FROM features WHERE id = ?').get(item.id) as { title: string }).title ? null : incoming.title, item.id, version);
    }
    changed.push(item.id);
    record(db, version, { at: new Date().toISOString(), by: item.updatedBy, id: item.id, field: 'reimport', from: current, to: incoming, released: data.released, dev: data.dev });
  }
  db.query('UPDATE imported_versions SET json_hash = ?, imported_at = ? WHERE version = ?').run(hash, new Date().toISOString(), version);
  const ledgerWon = ledgerWonIds.length;
  debug.log('release.features', 'reimported', { version, changed: changed.length - added, added, ledgerWon, notReadded: leftIds.length });
  // Two separate lines: what was taken from the old build's JSON, and where the JSON differs but the ledger is newer
  // (a conflict a person should know about even though nothing changed in the ledger).
  if (changed.length) console.error(`⚠ checklist ${version}: 옛 판이 checklist.json 에 쓴 ${changed.length}칸을 다시 들였다(${changed.slice(0, 5).join(', ')})`);
  if (leftIds.length) console.error(`⚠ checklist ${version}: 원장에서 옮기거나 지운 칸 ${leftIds.length}은 옛 판 checklist.json 에 남아 있어도 다시 넣지 않았다(${leftIds.slice(0, 5).join(', ')})`);
  if (ledgerWon) console.error(`⚠ checklist ${version}: 옛 판 checklist.json 과 원장이 다르다 — 원장이 더 새로워 원장 값 유지 ${ledgerWon}칸(${ledgerWonIds.slice(0, 5).join(', ')})`);
  return false;
}
export function importJson(version: string): boolean {
  validateVersion(version);
  if (!existsSync(jsonPath(version))) return false;
  const db = open();
  try {
    const imported = transaction(db, () => importOnDb(db, version));
    if (imported) debug.log('release.features', 'imported', { version });
    return imported;
  } finally { db.close(); }
}
function importLegacyAll(): void {
  const db = open();
  try {
    const imported = transaction(db, () => legacyVersions().filter((version) => importOnDb(db, version)));
    for (const version of imported) debug.log('release.features', 'imported', { version });
  } finally { db.close(); }
}

/** `root` reads another ledger (no legacy JSON import there); omitted = the default ledger as before. */
export function list(version: string, released?: string, dev = devVersion(), root?: string): Checklist {
  validateVersion(version);
  if (root === undefined) importJson(version);
  released ??= releasedVersion(root);
  const db = open(root);
  try { return readTransaction(db, () => snapshot(db, version, released, dev)); } finally { db.close(); }
}

/** The checklist API supplies its existing validation, field ordering and legacy history shape. */
export interface ChecklistCollision { version: string; owner?: string; title: string }

export function mutate(version: string, released: string, dev: string, apply: (data: Checklist, otherItems: (id: string) => ChecklistCollision[]) => boolean): Checklist {
  validateVersion(version);
  const db = open();
  try {
    let imported = false;
    const result = transaction(db, () => {
      imported = importOnDb(db, version);
      const data = snapshot(db, version, released, dev);
      const before = new Map(data.items.map((item) => [item.id, JSON.stringify(item)]));
      const count = data.history.length;
      if (apply(data, (id) => {
        for (const other of legacyVersions()) if (other !== version) importOnDb(db, other);
        return db.query(`SELECT a.version, a.owner, COALESCE(a.title_override, f.title) AS title
          FROM assignments a JOIN features f ON f.id = a.feature_id
          WHERE a.feature_id = ? AND a.version <> ? ORDER BY a.version`).all(id, version)
          .map((row) => {
            const item = row as { version: string; owner: string | null; title: string };
            return { version: item.version, ...(item.owner !== null ? { owner: item.owner } : {}), title: item.title };
          });
      })) {
        for (const item of data.items) if (before.get(item.id) !== JSON.stringify(item)) {
          const previous = before.get(item.id);
          const evidenceChanged = previous && (JSON.parse(previous) as ChecklistItem).evidence !== item.evidence;
          if (evidenceChanged) db.query('DELETE FROM evidence WHERE feature_id = ? AND version = ?').run(item.id, version);
          const persisted = previous && !evidenceChanged
            ? { ...item, evidence: (db.query('SELECT evidence FROM assignments WHERE feature_id = ? AND version = ?').get(item.id, version) as { evidence: string | null }).evidence ?? undefined }
            : item;
          putItem(db, version, persisted);
        }
        for (const id of before.keys()) if (!data.items.some((item) => item.id === id)) {
          db.query('DELETE FROM evidence WHERE feature_id = ? AND version = ?').run(id, version);
          db.query('DELETE FROM assignments WHERE feature_id = ? AND version = ?').run(id, version);
        }
        for (const entry of data.history.slice(count)) record(db, version, entry);
      }
      return data;
    });
    if (imported) debug.log('release.features', 'imported', { version });
    return result;
  } finally { db.close(); }
}

export function add(version: string, item: ChecklistItem, released = releasedVersion(), dev = devVersion()): Checklist {
  if (!item.id.trim()) throw new CliUserError('칸 id 가 비었다');
  if (!item.title.trim()) throw new CliUserError('칸 제목이 비었다');
  return mutate(version, released, dev, (data) => {
    if (data.items.some((i) => i.id === item.id)) throw new CliUserError(`이미 있는 칸: ${item.id}`, 'set <id> 로 고친다');
    data.items.push(item);
    data.history.push({ at: item.updatedAt, by: item.updatedBy, id: item.id, field: 'add', from: null, to: item, released, dev });
    return true;
  });
}
export function set(version: string, id: string, patch: Partial<ChecklistItem>, by: string, released = releasedVersion(), dev = devVersion()): Checklist {
  return mutate(version, released, dev, (data) => {
    const item = data.items.find((i) => i.id === id);
    if (!item) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
    const fields = (['evidence', 'owner', 'status', 'disposition', 'kind'] as const).filter((field) => patch[field] !== undefined && patch[field] !== item[field]);
    if (!fields.length) return false;
    const at = new Date().toISOString();
    for (const field of fields) {
      const from = item[field]; const to = patch[field]!;
      (item as unknown as Record<string, unknown>)[field] = to;
      item.updatedAt = at; item.updatedBy = by;
      data.history.push({ at, by, id, field, from: from ?? null, to, released, dev });
    }
    return true;
  });
}
export function remove(version: string, id: string, by: string, released = releasedVersion(), dev = devVersion()): Checklist {
  return mutate(version, released, dev, (data) => {
    const index = data.items.findIndex((i) => i.id === id);
    if (index < 0) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
    const [item] = data.items.splice(index, 1);
    data.history.push({ at: new Date().toISOString(), by, id, field: 'remove', from: item, to: null, released, dev });
    return true;
  });
}
export function move(id: string, from: string, to: string, by: string, released = releasedVersion(), dev = devVersion(), reason?: string, options: { clearDisposition?: boolean } = {}): Checklist {
  validateVersion(from); validateVersion(to);
  if (from === to) throw new CliUserError('같은 판으로 옮길 수 없다');
  const db = open();
  try {
    let importedFrom = false; let importedTo = false;
    const result = transaction(db, () => {
      importedFrom = importOnDb(db, from); importedTo = importOnDb(db, to);
      const item = items(db, from).find((i) => i.id === id);
      if (!item) throw new CliUserError(`없는 칸: ${id}`, 'list 로 칸 목록을 본다');
      const collision = items(db, to).find((i) => i.id === id);
      if (collision) throw new CliUserError(`이미 있는 칸: ${JSON.stringify(id).slice(1, -1)} — ${to} · 담당 ${JSON.stringify(collision.owner ?? '-').slice(1, -1)} · ${collision.title.replace(/\s+/g, ' ').slice(0, 40)}`);
      const at = new Date().toISOString();
      db.query('UPDATE assignments SET version = ?, updated_at = ?, updated_by = ? WHERE feature_id = ? AND version = ?').run(to, at, by, id, from);
      if (options.clearDisposition) db.query('UPDATE assignments SET disposition = NULL WHERE feature_id = ? AND version = ?').run(id, to);
      db.query('UPDATE evidence SET version = ? WHERE feature_id = ? AND version = ?').run(to, id, from);
      record(db, to, { at, by, id, field: 'move', from, to, released, dev, ...(reason !== undefined ? { reason } : {}) });
      return snapshot(db, to, released, dev);
    });
    if (importedFrom) debug.log('release.features', 'imported', { version: from });
    if (importedTo) debug.log('release.features', 'imported', { version: to });
    debug.log('release.features', 'moved', { id, from, to, by });
    return result;
  } finally { db.close(); }
}
export function retitle(id: string, title: string, by: string, released = releasedVersion(), dev = devVersion()): void {
  if (!title.trim()) throw new CliUserError('칸 제목이 비었다');
  importLegacyAll();
  const db = open();
  try {
    const changed = transaction(db, () => {
      const old = db.query('SELECT title FROM features WHERE id = ?').get(id) as { title: string } | null;
      if (!old) throw new CliUserError(`없는 칸: ${id}`);
      const versions = db.query('SELECT version, COALESCE(title_override, ?) AS title FROM assignments WHERE feature_id = ? ORDER BY version')
        .all(old.title, id) as Array<{ version: string; title: string }>;
      if (!versions.length) throw new CliUserError(`없는 칸: ${id}`);
      const changed = versions.filter((row) => row.title !== title);
      if (!changed.length && old.title === title) return false;
      const at = new Date().toISOString();
      db.query('UPDATE features SET title = ? WHERE id = ?').run(title, id);
      db.query('UPDATE assignments SET title_override = NULL WHERE feature_id = ?').run(id);
      for (const { version, title: previousTitle } of changed) {
        db.query('UPDATE assignments SET updated_at = ?, updated_by = ? WHERE feature_id = ? AND version = ?').run(at, by, id, version);
        record(db, version, { at, by, id, field: 'title', from: previousTitle, to: title, released, dev });
      }
      return true;
    });
    if (changed) debug.log('release.features', 'retitled', { id, title, by });
  } finally { db.close(); }
}
export function evidenceAdd(id: string, version: string, ref: string, by: string, released = releasedVersion(), dev = devVersion()): void {
  validateVersion(version);
  if (!ref.trim()) throw new CliUserError('근거 ref 가 비었다');
  const db = open();
  try {
    const imported = transaction(db, () => {
      const loaded = importOnDb(db, version);
      if (!db.query('SELECT 1 FROM assignments WHERE feature_id = ? AND version = ?').get(id, version)) throw new CliUserError(`없는 칸: ${id}`);
      const at = new Date().toISOString();
      db.query('INSERT INTO evidence (feature_id, version, ref, at, by) VALUES (?, ?, ?, ?, ?)').run(id, version, ref, at, by);
      record(db, version, { at, by, id, field: 'evidence.add', from: null, to: ref, released, dev });
      return loaded;
    });
    if (imported) debug.log('release.features', 'imported', { version });
  } finally { db.close(); }
}
export function history(id: string): Array<ChecklistHistory & { version: string; seq: number }> {
  importLegacyAll();
  const db = open();
  try { return (db.query('SELECT * FROM events WHERE feature_id = ? ORDER BY at, seq').all(id) as EventRow[]).map((row) => ({ ...historyRow(row), version: row.version, seq: row.seq })); }
  finally { db.close(); }
}

export function details(id: string): { id: string; title: string; owner: string | null; kind: string | null; createdAt: string; evidence: Array<{ version: string; ref: string; at: string; by: string }> } | null {
  importLegacyAll();
  const db = open();
  try {
    const row = db.query('SELECT id, title, owner, kind, created_at FROM features WHERE id = ?').get(id) as { id: string; title: string; owner: string | null; kind: string | null; created_at: string } | null;
    if (!row) return null;
    const evidence = db.query('SELECT version, ref, at, by FROM evidence WHERE feature_id = ? ORDER BY at, rowid').all(id) as Array<{ version: string; ref: string; at: string; by: string }>;
    return { id: row.id, title: row.title, owner: row.owner, kind: row.kind, createdAt: row.created_at, evidence };
  } finally { db.close(); }
}

export function exportJson(version: string, released = releasedVersion(), dev = devVersion()): Checklist {
  const data = list(version, released, dev);
  const path = jsonPath(version);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp); }
  const db = open();
  try { transaction(db, () => {
    // Track only our bytes: a legacy replacement after rename must remain detectable.
    const hash = jsonHash(contents);
    db.query(`INSERT INTO imported_versions (version, json_hash, imported_at) VALUES (?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET json_hash = excluded.json_hash, imported_at = excluded.imported_at`)
      .run(version, hash, new Date().toISOString());
  }); }
  finally { db.close(); }
  return data;
}
