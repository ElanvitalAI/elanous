import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppManifest } from './app-contract.js';
import { projectAppLifecycleSnapshot, validateAppLifecycleEvent, type AppLifecycleEvent, type AppLifecycleSnapshot } from './app-lifecycle-ledger.js';
import { appObjectKey } from '../../storage/object-store.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import type { NexusEventBus } from '../api/event-bus.js';
import { nexusRootDir } from '../paths.js';
import { sqlNowIso } from '../../time/db-window.js';
import { createAppDbBackupService, type AppDbBackupOptions, type AppDbBackupService, type AppDbBackupStatus } from './app-db-backup.js';

type Column = { type?: unknown; primary?: unknown; default?: unknown };
type Rpc = { sql?: unknown; allow?: unknown; params?: unknown };
type Manifest = AppManifest & { tables?: Record<string, { columns?: Record<string, Column> }>; rpc?: Record<string, Rpc> };
const LEGACY_CURRENT_TIMESTAMP = ['CURRENT', '_TIMESTAMP'].join('');

export interface AppDatabase {
  rpc(slug: string, name: string, params: Readonly<Record<string, unknown>> | undefined, role: string): unknown[];
  close(): void;
  backupStatus?(slug: string): AppDbBackupStatus | null;
  createBackupSnapshot?(slug: string): boolean;
  restoreBackup?(slug: string, targetPath: string): ReturnType<AppDbBackupService['restoreTo']>;
}

export interface AppLifecycleStore {
  appendEvent(event: AppLifecycleEvent): AppLifecycleSnapshot | null;
  ensureCreated(event: AppLifecycleEvent): AppLifecycleSnapshot | null;
  events(appId: string): AppLifecycleEvent[];
  snapshot(appId: string): AppLifecycleSnapshot | null;
  view(appId: string): { events: AppLifecycleEvent[]; snapshot: AppLifecycleSnapshot | null };
  snapshots(): AppLifecycleSnapshot[];
  close(): void;
}

interface AppLifecycleEventRow { event_id: string; app_id: string; sequence: number; event_json: string }
interface AppLifecycleSnapshotRow { app_id: string; snapshot_json: string }

/** Durable, append-only app lifecycle events and their tile projection. Each append updates both in one SQLite transaction. */
export function createAppLifecycleStore(databasePath = join(nexusRootDir(), 'app-lifecycle.sqlite')): AppLifecycleStore {
  if (!databasePath.trim()) throw new Error('app lifecycle ledger path is required');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS app_lifecycle_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL,
      event_json TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS app_lifecycle_events_app_sequence ON app_lifecycle_events(app_id, sequence)');
    db.exec(`CREATE TABLE IF NOT EXISTS app_lifecycle_snapshots (
      app_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL
    )`);
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('app lifecycle ledger is closed'); };
  const readEvents = (appId: string): AppLifecycleEvent[] => {
    const rows = db.query('SELECT event_id, app_id, sequence, event_json FROM app_lifecycle_events WHERE app_id = ? ORDER BY sequence')
      .all(appId) as AppLifecycleEventRow[];
    try {
      return rows.map(row => {
        const event = validateAppLifecycleEvent(JSON.parse(row.event_json));
        if (event.id !== row.event_id || event.appId !== row.app_id) throw new Error('identity mismatch');
        return event;
      });
    } catch { throw new Error('app lifecycle ledger is corrupt'); }
  };
  const readSnapshot = (appId: string): AppLifecycleSnapshot | null => {
    const events = readEvents(appId);
    const expected = projectAppLifecycleSnapshot(appId, events);
    const row = db.query('SELECT app_id, snapshot_json FROM app_lifecycle_snapshots WHERE app_id = ?').get(appId) as AppLifecycleSnapshotRow | null;
    if (!expected) {
      if (row) throw new Error('app lifecycle ledger is corrupt');
      return null;
    }
    if (!row) throw new Error('app lifecycle ledger is corrupt');
    try {
      const stored = JSON.parse(row.snapshot_json) as AppLifecycleSnapshot;
      if (row.app_id !== appId || JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error('projection mismatch');
    } catch { throw new Error('app lifecycle ledger is corrupt'); }
    return expected;
  };
  const insertEvent = (event: AppLifecycleEvent): AppLifecycleSnapshot | null => {
    db.query('INSERT INTO app_lifecycle_events(event_id, app_id, event_json) VALUES (?, ?, ?)')
      .run(event.id, event.appId, JSON.stringify(event));
    const snapshot = projectAppLifecycleSnapshot(event.appId, readEvents(event.appId));
    if (snapshot) db.query(`INSERT INTO app_lifecycle_snapshots(app_id, snapshot_json) VALUES (?, ?)
      ON CONFLICT(app_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`).run(event.appId, JSON.stringify(snapshot));
    else db.query('DELETE FROM app_lifecycle_snapshots WHERE app_id = ?').run(event.appId);
    return snapshot;
  };
  const readView = (appId: string) => ({ events: readEvents(appId), snapshot: readSnapshot(appId) });
  const readViewTransaction = (appId: string) => {
    db.exec('BEGIN');
    try {
      const view = readView(appId);
      db.exec('COMMIT');
      return view;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    appendEvent(input) {
      assertOpen();
      const event = validateAppLifecycleEvent(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        readSnapshot(event.appId);
        const snapshot = insertEvent(event);
        db.exec('COMMIT');
        return snapshot;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    ensureCreated(input) {
      assertOpen();
      const event = validateAppLifecycleEvent(input);
      if (event.action !== 'created' || event.outcome !== 'succeeded') throw new Error('app lifecycle seed must be a successful created event');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = readView(event.appId);
        if (current.events.some(item => item.action === 'created' && item.outcome === 'succeeded')) {
          db.exec('COMMIT');
          return current.snapshot;
        }
        const snapshot = insertEvent(event);
        db.exec('COMMIT');
        return snapshot;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    events(appId) { assertOpen(); return readViewTransaction(appId).events; },
    snapshot(appId) { assertOpen(); return readViewTransaction(appId).snapshot; },
    view(appId) { assertOpen(); return readViewTransaction(appId); },
    snapshots() {
      assertOpen();
      const rows = db.query('SELECT app_id FROM app_lifecycle_snapshots ORDER BY app_id').all() as Array<{ app_id: string }>;
      return rows.map(row => readViewTransaction(row.app_id).snapshot).filter((snapshot): snapshot is AppLifecycleSnapshot => snapshot !== null);
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

type AppRowChange = { appSlug: string; table: string; operation: 'insert' | 'update' | 'delete'; rowId: string; row: Record<string, unknown> };
type RowSnapshot = { physicalId: string; rowId: string; row: Record<string, unknown> };
type LoggedChange = { sequence: number; app_slug: string; table_name: string; operation: AppRowChange['operation']; row_id: string; previous_row_id: string | null; row_json: string };

const CHANGE_LOG = '_elanous_app_row_changes';
const CHANGE_ROW_IDS = '_elanous_app_row_ids';

function installChangeTriggers(db: Database, slug: string, manifest: Manifest): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${identifier(CHANGE_LOG)} (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, app_slug TEXT NOT NULL, table_name TEXT NOT NULL,
    operation TEXT NOT NULL, row_id TEXT NOT NULL, previous_row_id TEXT, row_json TEXT NOT NULL
  )`);
  const needsSyntheticIds = Object.values(manifest.tables ?? {}).some(declaration => {
    const columns = Object.keys(declaration.columns ?? {});
    return !['_rowid_', 'rowid', 'oid'].some(candidate => !columns.some(name => name.toLowerCase() === candidate));
  });
  if (needsSyntheticIds) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${identifier(CHANGE_ROW_IDS)} (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_json TEXT NOT NULL
    )`);
  }
  for (const [table, declaration] of Object.entries(manifest.tables ?? {})) {
    const columns = Object.keys(declaration.columns ?? {});
    const jsonFrom = (reference: string) => `json_object(${columns.map(name => {
      const column = `${reference}${identifier(name)}`;
      // SQLite JSON rejects BLOBs. Represent them losslessly as a tagged hex object.
      const value = `json(CASE WHEN typeof(${column}) = 'blob' THEN json_object('$blobHex', hex(${column})) ELSE json_quote(${column}) END)`;
      return `'${name.replaceAll("'", "''")}', ${value}`;
    }).join(', ')})`;
    const json = (prefix: 'NEW' | 'OLD') => jsonFrom(`${prefix}.`);
    const primary = Object.entries(declaration.columns ?? {}).find(([, column]) => column.primary === true)?.[0];
    const physical = ['_rowid_', 'rowid', 'oid'].find(candidate => !columns.some(name => name.toLowerCase() === candidate));
    const physicalId = (prefix: 'NEW' | 'OLD') => `CAST(${prefix}.${identifier(physical!)} AS TEXT)`;
    const tableKey = `${slug}/${table}`;
    const mappedId = (prefix: 'NEW' | 'OLD', newest = false) => `(SELECT 'rowid:' || sequence FROM ${identifier(CHANGE_ROW_IDS)}
      WHERE table_name = '${tableKey.replaceAll("'", "''")}' AND row_json = ${json(prefix)} ORDER BY sequence ${newest ? 'DESC' : 'ASC'} LIMIT 1)`;
    const needsMap = (prefix: 'NEW' | 'OLD') => primary ? `${prefix}.${identifier(primary)} IS NULL` : '1';
    const keyedId = (prefix: 'NEW' | 'OLD') => {
      const value = `CAST(${prefix}.${identifier(primary!)} AS TEXT)`;
      return `CASE WHEN substr(${value}, 1, 6) = 'rowid:' OR substr(${value}, 1, 4) = 'key:'
        THEN 'key:' || ${value} ELSE ${value} END`;
    };
    const rowId = (prefix: 'NEW' | 'OLD') => physical
      ? primary ? `CASE WHEN ${needsMap(prefix)} THEN 'rowid:' || ${physicalId(prefix)} ELSE ${keyedId(prefix)} END` : physicalId(prefix)
      : primary ? `CASE WHEN ${needsMap(prefix)} THEN ${mappedId(prefix)} ELSE ${keyedId(prefix)} END` : mappedId(prefix);
    const insertSyntheticId = (prefix: 'NEW' | 'OLD') => `INSERT INTO ${identifier(CHANGE_ROW_IDS)} (table_name, row_json)
      SELECT '${tableKey.replaceAll("'", "''")}', ${json(prefix)} WHERE ${needsMap(prefix)};`;

    if (!physical) {
      const where = primary ? ` WHERE ${identifier(primary)} IS NULL` : '';
      const existing = db.query(`SELECT ${jsonFrom('')} AS row_json FROM ${identifier(table)}${where}`).all() as Array<{ row_json: string }>;
      for (const row of existing) db.query(`INSERT INTO ${identifier(CHANGE_ROW_IDS)} (table_name, row_json) VALUES (?, ?)`)
        .run(tableKey, row.row_json);
    }
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const trigger = identifier(`__elanous_app_${operation}_${table}`);
      const prefix = operation === 'delete' ? 'OLD' : 'NEW';
      const updateNewId = operation === 'insert' && !physical
        ? primary ? `CASE WHEN ${needsMap('NEW')} THEN ${mappedId('NEW', true)} ELSE ${keyedId('NEW')} END` : mappedId('NEW', true)
        : operation === 'update' && !physical
          ? primary
            ? `CASE WHEN ${needsMap('NEW')} THEN CASE WHEN ${needsMap('OLD')} THEN ${mappedId('OLD')} ELSE ${mappedId('NEW', true)} END ELSE ${keyedId('NEW')} END`
            : mappedId('OLD')
          : rowId(prefix);
      const updatePreviousId = operation === 'update' && !physical
        ? primary ? `CASE WHEN ${needsMap('OLD')} THEN ${mappedId('OLD')} ELSE ${keyedId('OLD')} END` : mappedId('OLD')
        : operation === 'insert' ? 'NULL' : rowId('OLD');
      const beforeLog = operation === 'insert' && !physical ? insertSyntheticId('NEW')
        : operation === 'update' && !physical ? `INSERT INTO ${identifier(CHANGE_ROW_IDS)} (table_name, row_json)
          SELECT '${tableKey.replaceAll("'", "''")}', ${json('NEW')} WHERE ${needsMap('NEW')} AND NOT (${needsMap('OLD')});`
        : '';
      const afterLog = operation === 'update' && !physical
        ? `UPDATE ${identifier(CHANGE_ROW_IDS)} SET row_json = ${json('NEW')} WHERE sequence =
            (SELECT sequence FROM ${identifier(CHANGE_ROW_IDS)} WHERE table_name = '${tableKey.replaceAll("'", "''")}' AND row_json = ${json('OLD')} ORDER BY sequence LIMIT 1)
              AND ${needsMap('OLD')} AND ${needsMap('NEW')};
          DELETE FROM ${identifier(CHANGE_ROW_IDS)} WHERE sequence =
            (SELECT sequence FROM ${identifier(CHANGE_ROW_IDS)} WHERE table_name = '${tableKey.replaceAll("'", "''")}' AND row_json = ${json('OLD')} ORDER BY sequence LIMIT 1)
              AND ${needsMap('OLD')} AND NOT (${needsMap('NEW')});`
        : operation === 'delete' && !physical
          ? `DELETE FROM ${identifier(CHANGE_ROW_IDS)} WHERE sequence =
              (SELECT sequence FROM ${identifier(CHANGE_ROW_IDS)} WHERE table_name = '${tableKey.replaceAll("'", "''")}' AND row_json = ${json('OLD')} ORDER BY sequence LIMIT 1)
                AND ${needsMap('OLD')};`
          : '';
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${trigger} AFTER ${operation.toUpperCase()} ON ${identifier(table)}
        BEGIN ${beforeLog}
          INSERT INTO ${identifier(CHANGE_LOG)} (app_slug, table_name, operation, row_id, previous_row_id, row_json)
          VALUES ('${slug.replaceAll("'", "''")}', '${table.replaceAll("'", "''")}', '${operation}', ${updateNewId}, ${updatePreviousId}, ${json(prefix)});
          ${afterLog}
        END`);
    }
  }
}

function eventValue(value: unknown): unknown {
  if (!(value instanceof Uint8Array)) return value;
  return { $blobHex: Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase() };
}

function snapshotRows(db: Database, manifest: Manifest): Map<string, RowSnapshot[]> {
  const snapshot = new Map<string, RowSnapshot[]>();
  for (const [table, declaration] of Object.entries(manifest.tables ?? {})) {
    const columns = Object.entries(declaration.columns ?? {});
    const primary = columns.find(([, column]) => column.primary === true)?.[0];
    const physical = ['_rowid_', 'rowid', 'oid'].find(candidate => !columns.some(([name]) => name.toLowerCase() === candidate));
    let alias = '__elanous_snapshot_physical_id';
    while (columns.some(([name]) => name === alias)) alias += '_';
    let jsonAlias = '__elanous_snapshot_row_json';
    while (columns.some(([name]) => name === jsonAlias) || jsonAlias === alias) jsonAlias += '_';
    const rowJson = `json_object(${columns.map(([name]) => {
      const column = identifier(name);
      const value = `json(CASE WHEN typeof(${column}) = 'blob' THEN json_object('$blobHex', hex(${column})) ELSE json_quote(${column}) END)`;
      return `'${name.replaceAll("'", "''")}', ${value}`;
    }).join(', ')})`;
    const physicalProjection = physical ? `${identifier(physical)} AS ${identifier(alias)}, ` : '';
    const rows = db.query(`SELECT ${physicalProjection}${rowJson} AS ${identifier(jsonAlias)}, * FROM ${identifier(table)}`).all() as Array<Record<string, unknown>>;
    const syntheticIds = physical ? new Map<string, string[]>() : new Map<string, string[]>();
    if (!physical) {
      const tableKey = `${manifest.slug}/${table}`;
      const mapped = db.query(`SELECT sequence, row_json FROM ${identifier(CHANGE_ROW_IDS)} WHERE table_name = ? ORDER BY sequence`)
        .all(tableKey) as Array<{ sequence: number; row_json: string }>;
      for (const entry of mapped) {
        const ids = syntheticIds.get(entry.row_json) ?? [];
        ids.push(`rowid:${entry.sequence}`);
        syntheticIds.set(entry.row_json, ids);
      }
    }
    snapshot.set(table, rows.map(raw => {
      const row = Object.fromEntries(Object.entries(raw).filter(([name]) => name !== alias && name !== jsonAlias).map(([name, value]) => [name, eventValue(value)]));
      const physicalId = physical ? String(raw[alias]) : syntheticIds.get(String(raw[jsonAlias]))?.shift() ?? 'unmapped';
      const value = primary ? raw[primary] : undefined;
      const textValue = value == null ? undefined : String(value);
      const rowId = primary
        ? textValue == null ? physical ? `rowid:${physicalId}` : physicalId
          : textValue.startsWith('rowid:') || textValue.startsWith('key:') ? `key:${textValue}` : textValue
        : physicalId;
      return { physicalId, rowId, row };
    }));
  }
  return snapshot;
}

function containsReplaceStatement(sql: string): boolean {
  const tokens: string[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) return false;
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      index++;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (char !== '[' && sql[index + 1] === close) { index += 2; continue; }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
      tokens.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index++;
  }
  return tokens.some((token, index) => ((token === 'INSERT' || token === 'UPDATE') && tokens[index + 1] === 'OR' && tokens[index + 2] === 'REPLACE')
    || (token === 'REPLACE' && tokens[index + 1] === 'INTO'));
}

type UniqueIndex = { terms: Array<{ expression: string; collation: string }>; where?: string };
type SqlSourceToken = { value: string; start: number; end: number; kind: 'word' | 'symbol' | 'string' };

function sqlSourceTokens(sql: string): SqlSourceToken[] | undefined {
  const tokens: SqlSourceToken[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(char)) { index++; continue; }
    if (char === '-' && next === '-') { index += 2; while (index < sql.length && sql[index] !== '\n') index++; continue; }
    if (char === '/' && next === '*') { const end = sql.indexOf('*/', index + 2); if (end < 0) return undefined; index = end + 2; continue; }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const start = index;
      const close = char === '[' ? ']' : char;
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (char !== '[' && sql[index + 1] === close) { index += 2; continue; }
          index++;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) return undefined;
      tokens.push({ value: sql.slice(start + 1, index - 1), start, end: index, kind: char === "'" ? 'string' : 'word' });
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index]!)) index++;
      tokens.push({ value: sql.slice(start, index), start, end: index, kind: 'word' });
      continue;
    }
    tokens.push({ value: char, start: index, end: index + 1, kind: 'symbol' });
    index++;
  }
  return tokens;
}

function uniqueIndexDefinition(sql: string): { terms: string[]; where?: string } | undefined {
  const tokens = sqlSourceTokens(sql);
  if (!tokens) return undefined;
  const on = tokens.findIndex(token => token.kind === 'word' && token.value.toUpperCase() === 'ON');
  if (on < 0) return undefined;
  const open = tokens.findIndex((token, index) => index > on && token.value === '(');
  if (open < 0) return undefined;
  let depth = 0;
  let close = -1;
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index]!.kind === 'symbol' && tokens[index]!.value === '(') depth++;
    else if (tokens[index]!.kind === 'symbol' && tokens[index]!.value === ')' && --depth === 0) { close = index; break; }
  }
  if (close < 0) return undefined;
  const spans: Array<[number, number]> = [];
  let termStart = tokens[open]!.end;
  depth = 0;
  for (let index = open + 1; index < close; index++) {
    const token = tokens[index]!;
    if (token.kind === 'symbol' && token.value === '(') depth++;
    else if (token.kind === 'symbol' && token.value === ')') depth--;
    else if (token.kind === 'symbol' && token.value === ',' && depth === 0) { spans.push([termStart, token.start]); termStart = token.end; }
  }
  spans.push([termStart, tokens[close]!.start]);
  const terms = spans.map(([start, end]) => sql.slice(start, end).trim().replace(/\s+(?:ASC|DESC)\s*$/iu, ''));
  const whereToken = tokens.slice(close + 1).find(token => token.kind === 'word' && token.value.toUpperCase() === 'WHERE');
  const where = whereToken ? sql.slice(whereToken.end).replace(/;\s*$/u, '').trim() : undefined;
  return { terms, ...(where ? { where } : {}) };
}

function uniqueKeys(db: Database, table: string): UniqueIndex[] {
  const indexes = db.query(`PRAGMA index_list(${identifier(table)})`).all() as Array<{ name: string; unique: number; partial: number }>;
  const keys: UniqueIndex[] = [];
  for (const index of indexes.filter(candidate => Number(candidate.unique) === 1)) {
    const columns = db.query(`PRAGMA index_xinfo(${identifier(index.name)})`).all() as Array<{ key: number; name: string | null; coll: string | null }>;
    const key = columns.filter(column => Number(column.key) === 1);
    const stored = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name) as { sql: string | null } | null;
    const definition = stored?.sql ? uniqueIndexDefinition(stored.sql) : undefined;
    if (Number(index.partial) === 1 && !definition?.where) continue;
    const terms = key.map((column, position) => ({
      expression: column.name ? identifier(column.name) : definition?.terms[position] ?? '',
      collation: column.coll ?? 'BINARY',
    }));
    if (!terms.length || terms.some(term => !term.expression || !['BINARY', 'NOCASE', 'RTRIM'].includes(term.collation.toUpperCase()))) continue;
    keys.push({ terms, ...(Number(index.partial) === 1 && definition?.where ? { where: definition.where } : {}) });
  }
  return keys;
}

function sqlRowProjection(row: Record<string, unknown>): { sql: string; values: unknown[] } {
  const entries = Object.entries(row);
  const values = entries.map(([, value]) => {
    if (typeof value === 'object' && value !== null && '$blobHex' in value) {
      const hex = String((value as { $blobHex: unknown }).$blobHex);
      return Uint8Array.from(hex.match(/.{2}/gu)?.map(byte => Number.parseInt(byte, 16)) ?? []);
    }
    return value;
  });
  return { sql: entries.map(([name], index) => `? AS ${identifier(name)}`).join(', '), values };
}

function uniqueIndexValues(db: Database, row: Record<string, unknown>, index: UniqueIndex): unknown[] | undefined {
  const projection = sqlRowProjection(row);
  if (!projection.sql) return undefined;
  const selected = index.terms.map((term, position) => `(${term.expression}) AS ${identifier(`key_${position}`)}`);
  if (index.where) selected.push(`CASE WHEN (${index.where}) THEN 1 ELSE 0 END AS ${identifier('__included')}`);
  let result: Record<string, unknown> | null;
  try {
    result = db.query(`SELECT ${selected.join(', ')} FROM (SELECT ${projection.sql}) AS ${identifier('__elanous_index_row')}`)
      .get(...projection.values as never[]) as Record<string, unknown> | null;
  } catch {
    // Legacy indexes may reference columns omitted from the current manifest; skip only that inference.
    return undefined;
  }
  if (!result || (index.where && Number(result.__included) !== 1)) return undefined;
  return index.terms.map((_, position) => result[`key_${position}`]);
}

function sqliteValuesEqual(db: Database, left: unknown, right: unknown, collation: string): boolean {
  if (left == null || right == null) return false;
  const result = db.query(`SELECT ? = ? COLLATE ${identifier(collation)} AS equal`).get(left as never, right as never) as { equal: number };
  return Number(result.equal) === 1;
}

function conflictsOnUniqueKey(db: Database, left: Record<string, unknown>, right: Record<string, unknown>, keys: UniqueIndex[], leftId: string, rightId: string): boolean {
  return leftId === rightId || keys.some(index => {
    const leftValues = uniqueIndexValues(db, left, index);
    const rightValues = uniqueIndexValues(db, right, index);
    return leftValues !== undefined && rightValues !== undefined && index.terms.every((term, position) =>
      sqliteValuesEqual(db, leftValues[position], rightValues[position], term.collation));
  });
}

function inferReplaceDeletes(
  db: Database,
  manifest: Manifest,
  snapshots: Map<string, RowSnapshot[]>,
  changes: LoggedChange[],
): LoggedChange[] {
  const active = new Map([...snapshots].map(([table, rows]) => [table, rows.map(row => ({ rowId: row.rowId, row: row.row }))]));
  const keysByTable = new Map([...snapshots.keys()].map(table => [table, uniqueKeys(db, table)]));
  const ordered: LoggedChange[] = [];
  for (const change of changes) {
    const rows = active.get(change.table_name);
    if (!rows) { ordered.push(change); continue; }
    if (change.operation === 'delete') {
      active.set(change.table_name, rows.filter(row => row.rowId !== change.row_id));
      ordered.push(change);
      continue;
    }
    const nextRow = JSON.parse(change.row_json) as Record<string, unknown>;
    const previousId = change.previous_row_id ?? change.row_id;
    const updating = change.operation === 'update' ? rows.find(row => row.rowId === previousId) : undefined;
    const conflicts = rows.filter(row => row !== updating
      && conflictsOnUniqueKey(db, row.row, nextRow, keysByTable.get(change.table_name) ?? [], row.rowId, change.row_id));
    for (const conflict of conflicts) {
      const syntheticId = /^rowid:(\d+)$/u.exec(conflict.rowId);
      const declaration = manifest.tables?.[change.table_name];
      const columns = Object.keys(declaration?.columns ?? {});
      const hasPhysicalRowId = ['_rowid_', 'rowid', 'oid'].some(candidate => !columns.some(name => name.toLowerCase() === candidate));
      if (syntheticId && !hasPhysicalRowId) db.query(`DELETE FROM ${identifier(CHANGE_ROW_IDS)} WHERE table_name = ? AND sequence = ?`)
        .run(`${manifest.slug}/${change.table_name}`, Number(syntheticId[1]));
      ordered.push({
        sequence: change.sequence - 0.5, app_slug: change.app_slug, table_name: change.table_name,
        operation: 'delete', row_id: conflict.rowId, previous_row_id: null, row_json: JSON.stringify(conflict.row),
      });
    }
    const remaining = rows.filter(row => !conflicts.includes(row));
    if (change.operation === 'update' && updating) {
      const updated = { rowId: change.row_id, row: nextRow };
      const position = remaining.indexOf(updating);
      if (position < 0) remaining.push(updated); else remaining[position] = updated;
    } else {
      remaining.push({ rowId: change.row_id, row: nextRow });
    }
    active.set(change.table_name, remaining);
    ordered.push(change);
  }
  return ordered;
}

function hasReplaceTriggers(db: Database): boolean {
  const triggers = db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  return triggers.some(trigger => containsReplaceStatement(trigger.sql));
}

function hasReplaceConstraints(db: Database): boolean {
  const tables = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  return tables.some(({ sql }) => {
    const words = sqlSourceTokens(sql)?.filter(token => token.kind === 'word').map(token => token.value.toUpperCase()) ?? [];
    return words.some((word, index) => word === 'ON' && words[index + 1] === 'CONFLICT' && words[index + 2] === 'REPLACE');
  });
}

function isSqliteConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) || /constraint failed/iu.test(error.message);
}

function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function sqlType(type: unknown): string {
  if (['int', 'integer', 'boolean'].includes(String(type))) return 'INTEGER';
  if (['number', 'real'].includes(String(type))) return 'REAL';
  if (['text', 'timestamp', 'json', 'object-ref'].includes(String(type))) return 'TEXT';
  throw new Error('unsupported app column type');
}

function columnDefault(column: Column): string {
  if (column.default === undefined) return '';
  if (column.default === 'now' && column.type === 'timestamp') return ` DEFAULT (${sqlNowIso()})`;
  if (column.default === null) return ' DEFAULT NULL';
  if (typeof column.default === 'boolean') return ` DEFAULT ${column.default ? 1 : 0}`;
  if (typeof column.default === 'number' && Number.isFinite(column.default)) return ` DEFAULT ${column.default}`;
  if (typeof column.default === 'string') return ` DEFAULT '${column.default.replaceAll("'", "''")}'`;
  throw new Error('unsupported app column default');
}

function expectedDefault(column: Column): string | null {
  if (column.default === undefined) return null;
  if (column.default === 'now' && column.type === 'timestamp') return sqlNowIso();
  if (column.default === null) return 'NULL';
  if (typeof column.default === 'boolean') return column.default ? '1' : '0';
  if (typeof column.default === 'number' && Number.isFinite(column.default)) return String(column.default);
  if (typeof column.default === 'string') return column.default;
  throw new Error('unsupported app column default');
}

function normalizedDefault(value: unknown): string | null {
  if (value === null) return null;
  const sql = String(value).trim();
  if (sql.startsWith("'") && sql.endsWith("'")) return `literal:${sql.slice(1, -1).replaceAll("''", "'")}`;
  if (/^\(?\s*strftime\s*\(/i.test(sql)) return `sql:${sql}`;
  return `sql:${sql.toUpperCase()}`;
}

function expectedDefaultToken(column: Column): string | null {
  const value = expectedDefault(column);
  if (value === null) return null;
  if (column.default === 'now' && column.type === 'timestamp') return `sql:${value}`;
  return column.default !== null && typeof column.default === 'string' && !(column.default === 'now' && column.type === 'timestamp')
    ? `literal:${value}`
    : `sql:${value.toUpperCase()}`;
}

type ExistingColumn = { name: string; type: string; pk: number; dflt_value: unknown; notnull: number };

function rebuildForDynamicDefaults(db: Database, table: string, current: ExistingColumn[], columns: [string, Column][]): void {
  const original = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | null;
  const outgoingForeignKeys = db.query(`PRAGMA foreign_key_list(${identifier(table)})`).all();
  const hiddenColumns = db.query(`PRAGMA table_xinfo(${identifier(table)})`).all() as Array<{ hidden: number }>;
  if (outgoingForeignKeys.length || hiddenColumns.some(column => Number(column.hidden) > 0)
    || /\b(?:UNIQUE|CHECK|REFERENCES|FOREIGN\s+KEY|AUTOINCREMENT|COLLATE|STRICT|ON\s+CONFLICT)\b|WITHOUT\s+ROWID|PRIMARY\s+KEY\s+DESC/i.test(original?.sql ?? '')) {
    throw new Error(`cannot safely migrate constrained app table: ${table}`);
  }
  const objects = db.query("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").all(table) as Array<{ sql: string }>;
  const declared = new Map(columns);
  const additions = columns.filter(([name]) => !current.some(column => column.name === name));
  const legacyTimestampDefaults = columns.filter(([name, column]) => {
    const existing = current.find(currentColumn => currentColumn.name === name);
    return existing !== undefined && column.default === 'now' && column.type === 'timestamp'
      && normalizedDefault(existing.dflt_value) === `sql:${LEGACY_CURRENT_TIMESTAMP}`;
  });
  const migrated: ExistingColumn[] = [
    ...current,
    ...additions.map(([name, column]) => ({ name, type: sqlType(column.type), pk: 0, dflt_value: column.default === 'now' && column.type === 'timestamp' ? `(${sqlNowIso()})` : null, notnull: 0 })),
  ];
  const definitions = migrated.map(column => {
    const contractColumn = declared.get(column.name);
    const type = contractColumn ? sqlType(contractColumn.type) : column.type;
    const primary = contractColumn ? contractColumn.primary === true : Number(column.pk) > 0;
    const defaultClause = contractColumn ? columnDefault(contractColumn) : column.dflt_value === null ? '' : ` DEFAULT ${String(column.dflt_value)}`;
    const notNull = Number(column.notnull) > 0 ? ' NOT NULL' : '';
    return `${identifier(column.name)} ${type}${notNull}${defaultClause}${primary ? ' PRIMARY KEY' : ''}`;
  });
  if (migrated.filter(column => Number(column.pk) > 0 && !declared.has(column.name)).length > 1) {
    throw new Error(`cannot migrate composite app table primary key: ${table}`);
  }
  const rowidAlias = current.some(column => Number(column.pk) > 0 && column.type.trim().toUpperCase() === 'INTEGER');
  const rowidName = ['_rowid_', 'rowid', 'oid'].find(name => !migrated.some(column => column.name.toLowerCase() === name));
  if (!rowidAlias && !rowidName) throw new Error(`cannot safely preserve rowid during app table migration: ${table}`);
  const oldNames = current.map(column => identifier(column.name)).join(', ');
  const copyColumns = rowidAlias ? oldNames : [identifier(rowidName!), oldNames].filter(Boolean).join(', ');
  const selectColumns = rowidAlias ? oldNames : [identifier(rowidName!), oldNames].filter(Boolean).join(', ');
  const suffix = `__elanous_migrate_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const temporary = `${table}${suffix}`;
  const foreignKeys = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.run(`CREATE TABLE ${identifier(temporary)} (${definitions.join(', ')})`);
    db.run(`INSERT INTO ${identifier(temporary)} (${copyColumns}) SELECT ${selectColumns} FROM ${identifier(table)}`);
    for (const [name] of legacyTimestampDefaults) {
      const column = identifier(name);
      db.run(`UPDATE ${identifier(temporary)} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
        WHERE typeof(${column}) = 'text' AND ${column} GLOB '????-??-?? ??:??:??'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL`);
    }
    db.exec(`DROP TABLE ${identifier(table)}`);
    db.run(`ALTER TABLE ${identifier(temporary)} RENAME TO ${identifier(table)}`);
    for (const object of objects) db.exec(object.sql);
    const violations = db.query('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error(`app database migration violates foreign keys: ${table}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* retain the migration error */ }
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys.foreign_keys ? 'ON' : 'OFF'}`);
  }
}

const WRITE_SQL_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
function isWriteSql(sql: string): boolean {
  let index = 0, depth = 0, firstTopLevelWord = '', mainVerb = '';
  let pendingCteBody = false, cteBodyDepth = 0, afterCteBody = false;
  while (index < sql.length) {
    const char = sql[index]!, next = sql[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '-' && next === '-') { index += 2; while (index < sql.length && sql[index] !== '\n') index++; continue; }
    if (char === '/' && next === '*') { const close = sql.indexOf('*/', index + 2); if (close < 0) return false; index = close + 2; continue; }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const endQuote = char === '[' ? ']' : char;
      index++;
      while (index < sql.length) {
        if (sql[index] === endQuote) {
          if (endQuote !== ']' && sql[index + 1] === endQuote) { index += 2; continue; }
          index++; break;
        }
        index++;
      }
      continue;
    }
    if (char === '(') {
      if (firstTopLevelWord === 'WITH' && depth === 0 && pendingCteBody) cteBodyDepth = 1;
      depth++; index++; continue;
    }
    if (char === ')') {
      if (cteBodyDepth > 0 && depth === cteBodyDepth) { cteBodyDepth = 0; afterCteBody = true; pendingCteBody = false; }
      depth = Math.max(0, depth - 1); index++; continue;
    }
    if (char === ',') {
      if (depth === 0 && firstTopLevelWord === 'WITH' && afterCteBody) afterCteBody = false;
      index++; continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index))!;
      const word = match[0].toUpperCase();
      if (depth === 0) {
        if (!firstTopLevelWord) { firstTopLevelWord = word; mainVerb = word; }
        else if (firstTopLevelWord === 'WITH') {
          if (afterCteBody) return WRITE_SQL_VERBS.has(word);
          if (word === 'AS') pendingCteBody = true;
        }
      }
      index += match[0].length; continue;
    }
    index++;
  }
  return WRITE_SQL_VERBS.has(mainVerb);
}

function containsAttachOrDetach(sql: string): boolean {
  // Scan comments and quoted regions in SQLite order; regex stripping can misread `--` inside
  // a block comment and accidentally hide a following ATTACH token.
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) return true;
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (char !== '[' && sql[index + 1] === close) { index += 2; continue; }
          index++;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) return true;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
      if (['ATTACH', 'DETACH'].includes(sql.slice(start, index).toUpperCase())) return true;
      continue;
    }
    index++;
  }
  return false;
}

function bindValue(value: unknown, type: unknown, slug: string): unknown {
  if (type === 'text' || type === 'timestamp') {
    if (typeof value !== 'string') throw new Error(`parameter must be ${type}`);
    return value;
  }
  if (type === 'int' || type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error('parameter must be int');
    return value;
  }
  if (type === 'number' || type === 'real') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('parameter must be number');
    return value;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('parameter must be boolean');
    return value ? 1 : 0;
  }
  if (type === 'object-ref') {
    const prefix = `apps/${slug}/`;
    if (typeof value !== 'string' || !value.startsWith(prefix)) {
      throw new Error('object-ref must stay within the app storage prefix');
    }
    try { return appObjectKey(slug, value.slice(prefix.length)); }
    catch { throw new Error('object-ref must stay within the app storage prefix'); }
  }
  if (type === 'json') {
    let normalized: unknown;
    if (value !== null && typeof value === 'object') {
      normalized = value;
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'number' && !Number.isFinite(nested)) throw new Error('parameter must be finite json');
        return nested;
      });
    } else if (typeof value === 'string') {
      normalized = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('parameter must be finite json');
      normalized = value;
    } else if (typeof value === 'boolean' || value === null) normalized = value;
    else throw new Error('parameter must be json');
    const serialized = JSON.stringify(normalized);
    if (serialized === undefined) throw new Error('parameter must be json');
    return serialized;
  }
  throw new Error('unsupported app parameter type');
}

function schema(db: Database, manifest: Manifest): void {
  for (const [table, declaration] of Object.entries(manifest.tables ?? {})) {
    const columns = Object.entries(declaration.columns ?? {});
    const fields = columns.map(([name, column]) => `${identifier(name)} ${sqlType(column.type)}${column.primary === true ? ' PRIMARY KEY' : ''}${columnDefault(column)}`);
    const current = db.query(`PRAGMA table_info(${identifier(table)})`).all() as ExistingColumn[];
    if (current.length === 0) {
      db.run(`CREATE TABLE ${identifier(table)} (${fields.length ? fields.join(', ') : '"_empty" INTEGER'})`);
      continue;
    }
    const additions = columns.filter(([name]) => !current.some(existing => existing.name === name));
    const legacyTimestampDefaults = new Set(columns.filter(([name, column]) => {
      const found = current.find(existing => existing.name === name);
      return found !== undefined && column.default === 'now' && column.type === 'timestamp'
        && normalizedDefault(found.dflt_value) === `sql:${LEGACY_CURRENT_TIMESTAMP}`;
    }).map(([name]) => name));
    for (const [name, column] of columns) {
      const found = current.find(existing => existing.name === name);
      const defaultMismatch = normalizedDefault(found?.dflt_value) !== expectedDefaultToken(column)
        && !legacyTimestampDefaults.has(name);
      if (found && (found.type.toUpperCase() !== sqlType(column.type)
        || Number(found.pk) !== (column.primary === true ? 1 : 0) || defaultMismatch)) {
        throw new Error(`app table schema mismatch: ${table}.${name}`);
      }
    }
    if (additions.some(([, column]) => column.default === 'now' && column.type === 'timestamp') || legacyTimestampDefaults.size > 0) {
      if (additions.some(([, column]) => column.primary === true)) throw new Error(`cannot add primary key to existing app table: ${table}`);
      rebuildForDynamicDefaults(db, table, current, columns);
      continue;
    }
    for (const [name, column] of columns) {
      const found = current.find(existing => existing.name === name);
      if (!found) {
        if (column.primary === true) throw new Error(`cannot add primary key to existing app table: ${table}.${name}`);
        db.run(`ALTER TABLE ${identifier(table)} ADD COLUMN ${identifier(name)} ${sqlType(column.type)}${columnDefault(column)}`);
      }
    }
    // Keep retired columns and their data intact; silently removing either would be destructive.
  }
}

/** Opens durable, app-isolated SQLite files and executes only contract-declared RPCs. */
export function createAppDatabase(
  manifests: readonly AppManifest[],
  options: {
    readonly directory?: string;
    readonly eventBus?: Pick<NexusEventBus, 'publishAppRowChange'>;
    readonly backup?: Omit<AppDbBackupOptions, 'appSlug' | 'databasePath' | 'database'>;
  } = {},
): AppDatabase {
  const root = options.directory ?? join(getElanousConfigDir(), 'nexus', 'apps');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const apps = new Map<string, { db: Database; rpc: Map<string, Rpc>; manifest: Manifest }>();
  const backups = new Map<string, AppDbBackupService>();
  try {
    for (const value of manifests) {
      const manifest = value as Manifest;
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(manifest.slug) || manifest.slug.includes('--') || manifest.slug.length > 63) {
        throw new Error('invalid app slug');
      }
      if (apps.has(manifest.slug)) throw new Error(`duplicate app slug: ${manifest.slug}`);
      const databasePath = join(root, `${manifest.slug}.db`);
      const databaseWasPresent = existsSync(databasePath);
      const recoveryMarker = databasePath + '.backup-restore-required';
      if (!databaseWasPresent && options.backup && options.backup.store.provider !== 'local' && !existsSync(recoveryMarker)) {
        writeFileSync(recoveryMarker, 'restore required\n', { flag: 'wx', mode: 0o600 });
      }
      const db = new Database(databasePath);
      let backup: AppDbBackupService | undefined;
      let databaseInitialized = false;
      const initializeDatabase = () => {
        if (databaseInitialized) return;
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
        schema(db, manifest);
        installChangeTriggers(db, manifest.slug, manifest);
        databaseInitialized = true;
      };
      try {
        if (options.backup) {
          backup = createAppDbBackupService({ ...options.backup, appSlug: manifest.slug, databasePath, database: db, databaseWasPresent, initializeDatabase,
            schemaVersion: String(manifest.apiVersion ?? 'unknown'),
            schemaHash: createHash('sha256').update(JSON.stringify({ tables: manifest.tables ?? {}, rpc: manifest.rpc ?? {} })).digest('hex'),
          });
          backup.initialize();
          backups.set(manifest.slug, backup);
        }
        // Backup preflight decides whether this is a recoverable replacement host before schema or journal writes.
        if (!backup?.recoveryPending()) {
          const initializedByBackup = databaseInitialized;
          initializeDatabase();
          if (!initializedByBackup) backup?.createSnapshot();
        }
      } catch (error) {
        backup?.close();
        backups.delete(manifest.slug);
        db.close();
        throw error;
      }
      apps.set(manifest.slug, { db, rpc: new Map(Object.entries(manifest.rpc ?? {})), manifest });
    }
  } catch (error) {
    for (const backup of backups.values()) backup.close();
    for (const app of apps.values()) app.db.close();
    throw error;
  }

  let closed = false;
  return {
    rpc(slug, name, params = {}, role) {
      if (closed) throw new Error('app database is closed');
      const app = apps.get(slug);
      if (!app) throw new Error(`app not found: ${slug}`);
      const declaration = app.rpc.get(name);
      if (!declaration || typeof declaration.sql !== 'string') throw new Error(`rpc not found: ${slug}.${name}`);
      if (containsAttachOrDetach(declaration.sql)) throw new Error('app RPC cannot attach or detach databases');
      if (!Array.isArray(declaration.allow) || !declaration.allow.includes(role)) throw new Error('app role is not allowed');
      const specs = (declaration.params ?? {}) as Record<string, { type?: unknown; default?: unknown; max?: unknown }>;
      const bound: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(specs)) {
        const value = Object.hasOwn(params, key) ? params[key] : spec.default;
        if (value === undefined) throw new Error(`rpc parameter missing: ${key}`);
        if (spec.type === 'int' && (!Number.isSafeInteger(value) || (typeof spec.max === 'number' && Number(value) > spec.max))) {
          throw new Error(`rpc parameter invalid: ${key}`);
        }
        bound[`:${key}`] = bindValue(value, spec.type, slug);
      }
      if (Object.keys(params).some(key => !Object.hasOwn(specs, key))) throw new Error('rpc parameter unknown');
      const backup = backups.get(slug);
      backup?.assertAvailable();
      const writeRpc = isWriteSql(declaration.sql);
      if (writeRpc) backup?.assertWritesAllowed();
      const statement = app.db.query(declaration.sql);
      const before = (app.db.query(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM ${identifier(CHANGE_LOG)}`).get() as { sequence: number }).sequence;
      // Explicit statements, triggers, and table constraints can all cause implicit REPLACE deletes.
      const replaceSnapshots = (options.eventBus && (containsReplaceStatement(declaration.sql) || hasReplaceTriggers(app.db) || hasReplaceConstraints(app.db)))
        ? snapshotRows(app.db, app.manifest)
        : undefined;
      const savepoint = identifier('_elanous_app_rpc');
      app.db.exec(`SAVEPOINT ${savepoint}`);
      let result: unknown[];
      let changes: LoggedChange[];
      try {
        result = statement.all(bound as never) as unknown[];
        changes = app.db.query(`SELECT sequence, app_slug, table_name, operation, row_id, previous_row_id, row_json FROM ${identifier(CHANGE_LOG)} WHERE sequence > ? ORDER BY sequence`).all(before) as LoggedChange[];
        if (replaceSnapshots) changes = inferReplaceDeletes(app.db, app.manifest, replaceSnapshots, changes);
        if (changes.some(change => change.sequence > before && change.sequence < Number.MAX_SAFE_INTEGER)) {
          app.db.query(`DELETE FROM ${identifier(CHANGE_LOG)} WHERE sequence > ?`).run(before);
        }
        app.db.exec(`RELEASE ${savepoint}`);
      } catch (error) {
        let partial = app.db.query(`SELECT sequence, app_slug, table_name, operation, row_id, previous_row_id, row_json FROM ${identifier(CHANGE_LOG)} WHERE sequence > ? ORDER BY sequence`).all(before) as LoggedChange[];
        if (isSqliteConstraintError(error) && partial.length > 0) {
          // SQLite's FAIL algorithm preserves earlier row changes from the same statement.
          // ABORT removes that statement's trigger rows, so this path only keeps real partial writes.
          if (replaceSnapshots) partial = inferReplaceDeletes(app.db, app.manifest, replaceSnapshots, partial);
          app.db.query(`DELETE FROM ${identifier(CHANGE_LOG)} WHERE sequence > ?`).run(before);
          app.db.exec(`RELEASE ${savepoint}`);
          for (const change of partial) {
            try {
              options.eventBus?.publishAppRowChange({
                appSlug: change.app_slug, table: change.table_name, operation: change.operation,
                rowId: change.row_id, row: JSON.parse(change.row_json) as Record<string, unknown>,
              });
            } catch { /* preserve SQLite's committed partial result if event delivery fails */ }
          }
          if (writeRpc) backup?.captureWal();
          throw error;
        }
        try { app.db.exec(`ROLLBACK TO ${savepoint}`); } catch { /* OR ROLLBACK may already have removed the savepoint */ }
        try { app.db.exec(`RELEASE ${savepoint}`); } catch { /* preserve the original SQLite error */ }
        throw error;
      }
      for (const change of changes) {
        try {
          options.eventBus?.publishAppRowChange({
            appSlug: change.app_slug, table: change.table_name, operation: change.operation,
            rowId: change.row_id, row: JSON.parse(change.row_json) as Record<string, unknown>,
          });
        } catch { /* the RPC is already committed; delivery failures must not report a rollback */ }
      }
      if (writeRpc) backup?.captureWal();
      return result;
    },
    backupStatus(slug) { return backups.get(slug)?.status() ?? null; },
    createBackupSnapshot(slug) { return backups.get(slug)?.createSnapshot() ?? false; },
    restoreBackup(slug, targetPath) {
      const backup = backups.get(slug);
      if (!backup) throw new Error('app database backup is not configured');
      return backup.restoreTo(targetPath);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const backup of backups.values()) backup.close();
      backups.clear();
      for (const app of apps.values()) app.db.close();
      apps.clear();
    },
  };
}
