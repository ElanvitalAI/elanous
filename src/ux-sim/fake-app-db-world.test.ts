import { describe, expect, test } from 'bun:test';
import type { AppManifest } from '../nexus/apps/app-contract.js';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { createFakeAppDbWorld } from './fake-app-db-world.js';

function manifest(slug: string) {
  const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: ${slug}
title: Notes
frontend: { kind: static-export }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
      created_at: { type: timestamp, default: now }
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
rpc:
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  list:
    sql: SELECT id, title, created_at FROM notes ORDER BY id
    params: {}
    allow: [owner, viewer]
  update:
    sql: UPDATE notes SET title = :title WHERE id = :id
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  delete:
    sql: DELETE FROM notes WHERE id = :id
    params: { id: { type: text } }
    allow: [owner]
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.manifest;
}

describe('SIM-APPDB basic world', () => {
  test('creates tables, runs declared CRUD RPCs, isolates apps, and resets rows', () => {
    const world = createFakeAppDbWorld([manifest('notes-a'), manifest('notes-b')]);
    try {
      world.rpc('notes-a', 'add', { id: '1', title: 'first' }, 'owner');
      world.rpc('notes-a', 'update', { id: '1', title: 'edited' }, 'owner');
      expect(world.rpc('notes-a', 'list', {}, 'viewer')).toEqual([
        { id: '1', title: 'edited', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
      ]);
      expect(world.rpc('notes-b', 'list', {}, 'viewer')).toEqual([]);
      world.rpc('notes-b', 'add', { id: '2', title: 'other app' }, 'owner');
      world.rpc('notes-a', 'delete', { id: '1' }, 'owner');
      expect(world.rpc('notes-a', 'list', {}, 'owner')).toEqual([]);
      expect(world.rpc('notes-b', 'list', {}, 'owner')).toHaveLength(1);

      world.rpc('notes-a', 'add', { id: '3', title: 'before reset' }, 'owner');
      world.reset();
      expect(world.rpc('notes-a', 'list', {}, 'viewer')).toEqual([]);
      expect(world.rpc('notes-b', 'list', {}, 'viewer')).toEqual([]);
      world.rpc('notes-a', 'add', { id: '4', title: 'usable after reset' }, 'owner');
      expect(world.rpc('notes-a', 'list', {}, 'owner')).toHaveLength(1);
    } finally { world.close(); }
  });

  test('enforces RPC roles and parameter names and rejects unknown apps or RPCs', () => {
    const world = createFakeAppDbWorld([manifest('notes')]);
    try {
      expect(() => world.rpc('notes', 'add', { id: '1', title: 'private' }, 'viewer')).toThrow('app role is not allowed');
      expect(() => world.rpc('notes', 'add', { id: '1', title: 'private', extra: true }, 'owner')).toThrow('rpc parameter unknown');
      expect(() => world.rpc('notes', 'add', { id: '1' }, 'owner')).toThrow('rpc parameter missing: title');
      expect(() => world.rpc('missing', 'list', {}, 'viewer')).toThrow('app not found: missing');
      expect(() => world.rpc('notes', 'missing', {}, 'viewer')).toThrow('rpc not found: notes.missing');
      expect(() => createFakeAppDbWorld([manifest('same'), manifest('same')])).toThrow('duplicate app slug: same');
    } finally { world.close(); }
  });

  test('observes insert, update, and delete through SQLite change triggers in order', () => {
    const world = createFakeAppDbWorld([manifest('notes-a'), manifest('notes-b')]);
    try {
      world.rpc('notes-a', 'add', { id: '1', title: 'first' }, 'owner');
      world.rpc('notes-a', 'update', { id: '1', title: 'edited' }, 'owner');
      world.rpc('notes-a', 'delete', { id: '1' }, 'owner');
      world.rpc('notes-b', 'add', { id: '2', title: 'isolated app' }, 'owner');
      expect(world.changes().map(change => [change.appSlug, change.table, change.operation, change.rowId, change.row.title])).toEqual([
        ['notes-a', 'notes', 'insert', '1', 'first'],
        ['notes-a', 'notes', 'update', '1', 'edited'],
        ['notes-a', 'notes', 'delete', '1', 'edited'],
        ['notes-b', 'notes', 'insert', '2', 'isolated app'],
      ]);
      world.reset();
      expect(world.changes()).toEqual([]);
      expect(world.rpc('notes-b', 'list', {}, 'viewer')).toEqual([]);
      world.rpc('notes-a', 'add', { id: '3', title: 'after reset' }, 'owner');
      expect(world.changes().map(change => [change.appSlug, change.rowId, change.row.title])).toEqual([
        ['notes-a', '3', 'after reset'],
      ]);
    } finally { world.close(); }
  });

  test('observes rows partially committed by a failing INSERT OR FAIL', () => {
    const base = manifest('partial-fail');
    const withPartialRpc = {
      ...base,
      rpc: {
        ...((base.rpc ?? {}) as Record<string, unknown>),
        partialInsert: {
          sql: "INSERT OR FAIL INTO notes (id, title) VALUES ('partial', 'committed'), ('partial', 'conflict')",
          params: {},
          allow: ['owner'],
        },
      },
    } as AppManifest;
    const world = createFakeAppDbWorld([withPartialRpc]);
    try {
      expect(() => world.rpc('partial-fail', 'partialInsert', {}, 'owner')).toThrow();
      expect(world.rpc('partial-fail', 'list', {}, 'owner')).toEqual([
        { id: 'partial', title: 'committed', created_at: expect.any(String) },
      ]);
      expect(world.changes().map(change => [change.appSlug, change.operation, change.rowId, change.row.title])).toEqual([
        ['partial-fail', 'insert', 'partial', 'committed'],
      ]);
    } finally { world.close(); }
  });

  test('executes quoted identifiers and a SQLite CTE against the declared app database', () => {
    const quoted = parseAppManifest(`apiVersion: elanous.app/v0
slug: quoted-notes
title: Notes
frontend: { kind: static-export }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      "select": { type: text }
roles:
  owner: { via: nexus-session }
rpc:
  addQuoted:
    sql: INSERT INTO "notes" (id, "select") VALUES (:id, :value)
    params: { id: { type: text }, value: { type: text } }
    allow: [owner]
  getQuoted:
    sql: SELECT "select" AS "order" FROM "notes" WHERE id = :id
    params: { id: { type: text } }
    allow: [owner]
`);
    if (!quoted.ok) throw new Error(JSON.stringify(quoted.errors));
    const base = manifest('cte-notes');
    const cte = {
      ...base,
      rpc: {
        ...((base.rpc ?? {}) as Record<string, unknown>),
        listCte: {
          sql: 'WITH requested AS (SELECT :id AS id) SELECT id, title FROM notes WHERE id = (SELECT id FROM requested)',
          params: { id: { type: 'text' } },
          allow: ['owner'],
        },
      },
    } as AppManifest;
    const world = createFakeAppDbWorld([quoted.manifest, cte]);
    try {
      world.rpc('quoted-notes', 'addQuoted', { id: 'q1', value: 'quoted value' }, 'owner');
      expect(world.rpc('quoted-notes', 'getQuoted', { id: 'q1' }, 'owner')).toEqual([{ order: 'quoted value' }]);
      world.rpc('cte-notes', 'add', { id: 'c1', title: 'CTE row' }, 'owner');
      expect(world.rpc('cte-notes', 'listCte', { id: 'c1' }, 'owner')).toEqual([{ id: 'c1', title: 'CTE row' }]);
    } finally { world.close(); }
  });

  test('enforces finite JSON and the RPC parameter type matrix', () => {
    const typed: AppManifest = {
      apiVersion: 'elanous.app/v0', slug: 'typed', title: 'Typed', frontend: { kind: 'static-export' },
      roles: { owner: { via: 'nexus-session' } },
      tables: { values: { columns: {
        id: { type: 'text', primary: true }, title: { type: 'text' }, at: { type: 'timestamp' },
        count: { type: 'int' }, ratio: { type: 'number' }, enabled: { type: 'boolean' },
        metadata: { type: 'json' }, object_key: { type: 'object-ref' },
      } } },
      rpc: {
        save: {
          sql: 'INSERT INTO "values" (id, title, at, count, ratio, enabled, metadata, object_key) VALUES (:id, :title, :at, :count, :ratio, :enabled, :metadata, :object_key)',
          params: {
            id: { type: 'text' }, title: { type: 'text' }, at: { type: 'timestamp' }, count: { type: 'int', max: 10 },
            ratio: { type: 'number' }, enabled: { type: 'boolean' }, metadata: { type: 'json' }, object_key: { type: 'object-ref' },
          },
          allow: ['owner'],
        },
        get: { sql: 'SELECT * FROM "values" WHERE id = :id', params: { id: { type: 'text' } }, allow: ['owner'] },
      },
    };
    const world = createFakeAppDbWorld([typed]);
    const valid = {
      id: 'one', title: 'valid', at: '2026-11-07T00:00:00.000Z', count: 3, ratio: 1.25,
      enabled: true, metadata: { nested: { score: 9 } }, object_key: 'apps/typed/photo.png',
    };
    try {
      world.rpc('typed', 'save', valid, 'owner');
      expect(world.rpc('typed', 'get', { id: 'one' }, 'owner')).toEqual([{
        id: 'one', title: 'valid', at: valid.at, count: 3, ratio: 1.25, enabled: 1,
        metadata: JSON.stringify(valid.metadata), object_key: valid.object_key,
      }]);
      for (const [index, metadata] of [null, true, false, 0, 'json text'].entries()) {
        const id = `primitive-${index}`;
        world.rpc('typed', 'save', { ...valid, id, metadata }, 'owner');
        const row = world.rpc('typed', 'get', { id }, 'owner')[0] as Record<string, unknown> | undefined;
        expect(row?.metadata).toBe(JSON.stringify(metadata));
      }
      expect(() => world.rpc('typed', 'save', { ...valid, id: 'bad-number', ratio: Infinity }, 'owner')).toThrow('parameter must be number');
      expect(() => world.rpc('typed', 'save', { ...valid, id: 'bad-json-number', metadata: Infinity }, 'owner')).toThrow('parameter must be finite json');
      expect(() => world.rpc('typed', 'save', { ...valid, id: 'bad-json', metadata: { nested: [1, NaN] } }, 'owner')).toThrow('parameter must be finite json');
      expect(() => world.rpc('typed', 'save', { ...valid, id: 'bad-int', count: 11 }, 'owner')).toThrow('rpc parameter invalid: count');
      expect(() => world.rpc('typed', 'save', { ...valid, id: 'bad-boolean', enabled: 1 }, 'owner')).toThrow('parameter must be boolean');
      expect(() => world.rpc('typed', 'save', { ...valid, id: 'bad-ref', object_key: 'apps/other/photo.png' }, 'owner')).toThrow('object-ref must stay within the app storage prefix');
      expect(world.rpc('typed', 'get', { id: 'bad-json' }, 'owner')).toEqual([]);
    } finally { world.close(); }
  });
});
