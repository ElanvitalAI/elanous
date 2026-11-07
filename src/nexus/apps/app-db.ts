import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from './app-contract.js';
import { appObjectKey } from '../../storage/object-store.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { sqlNowIso } from '../../time/db-window.js';

type Column = { type?: unknown; primary?: unknown; default?: unknown };
type Rpc = { sql?: unknown; allow?: unknown; params?: unknown };
type Manifest = AppManifest & { tables?: Record<string, { columns?: Record<string, Column> }>; rpc?: Record<string, Rpc> };
const LEGACY_CURRENT_TIMESTAMP = ['CURRENT', '_TIMESTAMP'].join('');

export interface AppDatabase {
  rpc(slug: string, name: string, params: Readonly<Record<string, unknown>> | undefined, role: string): unknown[];
  close(): void;
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
  options: { readonly directory?: string } = {},
): AppDatabase {
  const root = options.directory ?? join(getElanousConfigDir(), 'nexus', 'apps');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const apps = new Map<string, { db: Database; rpc: Map<string, Rpc> }>();
  try {
    for (const value of manifests) {
      const manifest = value as Manifest;
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(manifest.slug) || manifest.slug.includes('--') || manifest.slug.length > 63) {
        throw new Error('invalid app slug');
      }
      if (apps.has(manifest.slug)) throw new Error(`duplicate app slug: ${manifest.slug}`);
      const db = new Database(join(root, `${manifest.slug}.db`));
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
        schema(db, manifest);
      } catch (error) {
        db.close();
        throw error;
      }
      apps.set(manifest.slug, { db, rpc: new Map(Object.entries(manifest.rpc ?? {})) });
    }
  } catch (error) {
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
      const statement = app.db.query(declaration.sql);
      return statement.all(bound as never) as unknown[];
    },
    close() {
      if (closed) return;
      closed = true;
      for (const app of apps.values()) app.db.close();
      apps.clear();
    },
  };
}
