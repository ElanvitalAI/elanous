import { Database } from 'bun:sqlite';
import type { AppManifest } from '../nexus/apps/app-contract.js';
import { sqlNowIso } from '../time/db-window.js';

export interface FakeAppDbWorld {
  rpc(slug: string, name: string, params: Readonly<Record<string, unknown>> | undefined, role: string): unknown[];
  reset(): void;
  close(): void;
}

type Column = { type?: unknown; primary?: unknown; default?: unknown };
type Rpc = { sql?: unknown; allow?: unknown; params?: unknown };
type Manifest = AppManifest & { tables?: Record<string, { columns?: Record<string, Column> }>; rpc?: Record<string, Rpc> };

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

function binding(value: unknown, type: unknown): unknown {
  if (type === 'json' && value !== null && typeof value === 'object') return JSON.stringify(value);
  if (type === 'boolean' && typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** In-memory, per-app SQLite world for basic app table and RPC flows. */
export function createFakeAppDbWorld(manifests: readonly AppManifest[]): FakeAppDbWorld {
  const apps = new Map<string, { db: Database; rpc: Map<string, Rpc>; tables: string[] }>();
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
        if (spec.type === 'int' && (!Number.isSafeInteger(value) || (typeof spec.max === 'number' && Number(value) > spec.max))) {
          throw new Error(`rpc parameter invalid: ${key}`);
        }
        bound[`:${key}`] = binding(value, spec.type);
      }
      if (Object.keys(params).some((key) => !Object.hasOwn(specs, key))) throw new Error('rpc parameter unknown');
      // Bun accepts named binding objects at runtime; its public ParamsType omits that overload.
      return app.db.query(declaration.sql).all(bound as never) as unknown[];
    },
    reset() {
      if (closed) throw new Error('app database world is closed');
      for (const app of apps.values()) for (const table of app.tables) app.db.run(`DELETE FROM ${identifier(table)}`);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const app of apps.values()) app.db.close();
      apps.clear();
    },
  };
}
