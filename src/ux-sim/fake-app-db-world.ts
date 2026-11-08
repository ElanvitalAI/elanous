import { Database } from 'bun:sqlite';
import type { AppManifest } from '../nexus/apps/app-contract.js';
import { sqlNowIso } from '../time/db-window.js';

export interface FakeAppDbWorld {
  rpc(slug: string, name: string, params: Readonly<Record<string, unknown>> | undefined, role: string): unknown[];
  changes(): readonly FakeAppDbChange[];
  reset(): void;
  close(): void;
}

export type FakeAppDbChange = {
  readonly appSlug: string;
  readonly table: string;
  readonly operation: 'insert' | 'update' | 'delete';
  readonly rowId: string;
  readonly row: Readonly<Record<string, unknown>>;
};

type Column = { type?: unknown; primary?: unknown; default?: unknown };
type Rpc = { sql?: unknown; allow?: unknown; params?: unknown };
type Manifest = AppManifest & { tables?: Record<string, { columns?: Record<string, Column> }>; rpc?: Record<string, Rpc> };
type LoggedChange = { app_slug: string; table_name: string; operation: FakeAppDbChange['operation']; row_id: string; row_json: string };

const CHANGE_LOG = '__ux_sim_app_row_changes';

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqliteType(type: unknown): string {
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

function binding(value: unknown, type: unknown, slug: string): unknown {
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
    if (typeof value !== 'string' || !value.startsWith(prefix) || value.length === prefix.length) {
      throw new Error('object-ref must stay within the app storage prefix');
    }
    return value;
  }
  if (type === 'json') {
    let normalized: unknown;
    if (value !== null && typeof value === 'object') {
      normalized = value;
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'number' && !Number.isFinite(nested)) throw new Error('parameter must be finite json');
        return nested;
      });
    } else if (typeof value === 'string') normalized = value;
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('parameter must be finite json');
      normalized = value;
    }
    else if (typeof value === 'boolean' || value === null) normalized = value;
    else throw new Error('parameter must be json');
    const serialized = JSON.stringify(normalized);
    if (serialized === undefined) throw new Error('parameter must be json');
    return serialized;
  }
  throw new Error('unsupported app parameter type');
}

function installChangeTriggers(db: Database, slug: string, manifest: Manifest): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${identifier(CHANGE_LOG)} (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, app_slug TEXT NOT NULL, table_name TEXT NOT NULL,
    operation TEXT NOT NULL, row_id TEXT NOT NULL, row_json TEXT NOT NULL
  )`);
  for (const [table, declaration] of Object.entries(manifest.tables ?? {})) {
    const columns = Object.entries(declaration.columns ?? {});
    const primary = columns.find(([, column]) => column.primary === true)?.[0];
    const rowId = (prefix: 'NEW' | 'OLD') => primary
      ? `CASE WHEN ${prefix}.${identifier(primary)} IS NULL THEN 'rowid:' || CAST(${prefix}.rowid AS TEXT) ELSE CAST(${prefix}.${identifier(primary)} AS TEXT) END`
      : `CAST(${prefix}.rowid AS TEXT)`;
    const rowJson = (prefix: 'NEW' | 'OLD') => `json_object(${columns.map(([name]) =>
      `'${name.replaceAll("'", "''")}', ${prefix}.${identifier(name)}`).join(', ')})`;
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const trigger = identifier(`__ux_sim_app_${operation}_${table}`);
      const prefix = operation === 'delete' ? 'OLD' : 'NEW';
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${trigger} AFTER ${operation.toUpperCase()} ON ${identifier(table)}
        BEGIN INSERT INTO ${identifier(CHANGE_LOG)} (app_slug, table_name, operation, row_id, row_json)
        VALUES ('${slug.replaceAll("'", "''")}', '${table.replaceAll("'", "''")}', '${operation}', ${rowId(prefix)}, ${rowJson(prefix)}); END`);
    }
  }
}

/** In-memory, per-app SQLite world for basic app table and RPC flows. */
export function createFakeAppDbWorld(manifests: readonly AppManifest[]): FakeAppDbWorld {
  const apps = new Map<string, { db: Database; rpc: Map<string, Rpc>; tables: string[] }>();
  const changes: FakeAppDbChange[] = [];
  let closed = false;
  try {
    for (const value of manifests) {
      const manifest = value as Manifest;
      if (apps.has(manifest.slug)) throw new Error(`duplicate app slug: ${manifest.slug}`);
      const db = new Database(':memory:');
      const tables = Object.entries(manifest.tables ?? {});
      try {
        for (const [table, declaration] of tables) {
          const columns = Object.entries(declaration.columns ?? {});
          const fields = columns.map(([name, column]) =>
            `${identifier(name)} ${sqliteType(column.type)}${column.primary === true ? ' PRIMARY KEY' : ''}${columnDefault(column)}`);
          db.run(`CREATE TABLE ${identifier(table)} (${fields.length ? fields.join(', ') : '"_empty" INTEGER'})`);
        }
        installChangeTriggers(db, manifest.slug, manifest);
      } catch (error) {
        db.close();
        throw error;
      }
      apps.set(manifest.slug, { db, rpc: new Map(Object.entries(manifest.rpc ?? {})), tables: tables.map(([name]) => name) });
    }
  } catch (error) {
    for (const app of apps.values()) app.db.close();
    throw error;
  }

  return {
    rpc(slug, name, params = {}, role) {
      if (closed) throw new Error('app database world is closed');
      const app = apps.get(slug);
      if (!app) throw new Error(`app not found: ${slug}`);
      const declaration = app.rpc.get(name);
      if (!declaration || typeof declaration.sql !== 'string') throw new Error(`rpc not found: ${slug}.${name}`);
      if (!Array.isArray(declaration.allow) || !declaration.allow.includes(role)) throw new Error('app role is not allowed');
      const specs = (declaration.params ?? {}) as Record<string, { type?: unknown; default?: unknown; max?: unknown }>;
      const bound: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(specs)) {
        const value = Object.hasOwn(params, key) ? params[key] : spec.default;
        if (value === undefined) throw new Error(`rpc parameter missing: ${key}`);
        if ((spec.type === 'int' || spec.type === 'integer') && (!Number.isSafeInteger(value) || (typeof spec.max === 'number' && Number(value) > spec.max))) {
          throw new Error(`rpc parameter invalid: ${key}`);
        }
        bound[`:${key}`] = binding(value, spec.type, slug);
      }
      if (Object.keys(params).some((key) => !Object.hasOwn(specs, key))) throw new Error('rpc parameter unknown');
      // Bun accepts named binding objects at runtime; its public ParamsType omits that overload.
      const before = app.db.query(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM ${identifier(CHANGE_LOG)}`).get() as { sequence: number };
      try {
        return app.db.query(declaration.sql).all(bound as never) as unknown[];
      } finally {
        // SQLite conflict modes such as OR FAIL can commit earlier rows before a later
        // row throws. Always harvest trigger records so observed changes match storage.
        const logged = app.db.query(`SELECT app_slug, table_name, operation, row_id, row_json FROM ${identifier(CHANGE_LOG)} WHERE sequence > ? ORDER BY sequence`)
          .all(Number(before.sequence)) as LoggedChange[];
        changes.push(...logged.map(change => ({
          appSlug: change.app_slug,
          table: change.table_name,
          operation: change.operation,
          rowId: change.row_id,
          row: JSON.parse(change.row_json) as Record<string, unknown>,
        })));
      }
    },
    changes() { return changes.map(change => ({ ...change, row: { ...change.row } })); },
    reset() {
      if (closed) throw new Error('app database world is closed');
      for (const app of apps.values()) {
        for (const table of app.tables) app.db.run(`DELETE FROM ${identifier(table)}`);
        app.db.run(`DELETE FROM ${identifier(CHANGE_LOG)}`);
      }
      changes.length = 0;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const app of apps.values()) app.db.close();
      apps.clear();
    },
  };
}
