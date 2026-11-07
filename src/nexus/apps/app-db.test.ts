import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppManifest } from './app-contract.js';
import { createAppDatabase } from './app-db.js';

const LEGACY_SQL_NOW = ['CURRENT', '_TIMESTAMP'].join('');

function manifest(slug: string, extended = false, titleDefault?: string | null, timestamp = false) {
  const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: ${slug}
title: Notes
frontend: { kind: static-export }
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text${titleDefault === undefined ? '' : titleDefault === null ? ', default: null' : `, default: '${titleDefault}'`} }
${extended ? '      description: { type: text }\n' : ''}${timestamp ? '      created_at: { type: timestamp, default: now }\n' : ''}rpc:
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  list:
    sql: SELECT id, title${extended ? ', description' : ''}${timestamp ? ', created_at' : ''} FROM notes ORDER BY id
    params: {}
    allow: [owner, viewer]
  echoJson:
    sql: SELECT :value AS value
    params: { value: { type: json } }
    allow: [owner]
  echoObjectRef:
    sql: SELECT :value AS value
    params: { value: { type: object-ref } }
    allow: [owner]
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.manifest;
}

describe('NEXUS-APP-DB-S1', () => {
  test('persists each app in its own SQLite file and enforces declared RPC roles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    try {
      const first = createAppDatabase([manifest('notes-a'), manifest('notes-b')], { directory });
      first.rpc('notes-a', 'add', { id: '1', title: 'private' }, 'owner');
      expect(first.rpc('notes-b', 'list', {}, 'viewer')).toEqual([]);
      expect(() => first.rpc('notes-a', 'list', {}, 'anonymous')).toThrow('app role is not allowed');
      expect(() => first.rpc('notes-a', 'add', { id: '2', title: 'bad', extra: true }, 'owner')).toThrow('rpc parameter unknown');
      first.close();

      const reopened = createAppDatabase([manifest('notes-a', true), manifest('notes-b')], { directory });
      try {
        expect(reopened.rpc('notes-a', 'list', {}, 'viewer')).toEqual([{ id: '1', title: 'private', description: null }]);
        expect(reopened.rpc('notes-b', 'list', {}, 'viewer')).toEqual([]);
        expect(() => reopened.rpc('missing', 'list', {}, 'viewer')).toThrow('app not found: missing');
        expect(() => reopened.rpc('notes-a', 'missing', {}, 'viewer')).toThrow('rpc not found: notes-a.missing');
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('rejects ATTACH and DETACH in runtime RPC manifests to keep app databases isolated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const base = manifest('notes-a');
    const unsafe = {
      ...base,
      rpc: {
        ...(base as unknown as { rpc: Record<string, unknown> }).rpc,
        attach: { sql: "/* -- */ ATTACH DATABASE :path AS other", params: { path: { type: 'text' } }, allow: ['owner'] },
        detach: { sql: 'DETACH DATABASE other', params: {}, allow: ['owner'] },
      },
    } as unknown as ReturnType<typeof manifest>;
    const db = createAppDatabase([unsafe, manifest('notes-b')], { directory });
    try {
      expect(() => db.rpc('notes-a', 'attach', { path: join(directory, 'notes-b.db') }, 'owner'))
        .toThrow('app RPC cannot attach or detach databases');
      expect(() => db.rpc('notes-a', 'detach', {}, 'owner')).toThrow('app RPC cannot attach or detach databases');
      expect(db.rpc('notes-b', 'list', {}, 'viewer')).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects duplicate app slugs and prevents calls after close', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    try {
      expect(() => createAppDatabase([manifest('same'), manifest('same')], { directory })).toThrow('duplicate app slug: same');
      const db = createAppDatabase([manifest('notes')], { directory });
      db.close();
      expect(() => db.rpc('notes', 'list', {}, 'owner')).toThrow('app database is closed');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('closes a SQLite handle when contract schema initialization fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const close = spyOn(Database.prototype, 'close');
    try {
      const invalid = {
        ...manifest('broken'),
        tables: { broken: { columns: { value: { type: 'unsupported' } } } },
      } as unknown as ReturnType<typeof manifest>;
      expect(() => createAppDatabase([invalid], { directory })).toThrow('unsupported app column type');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a changed column default rather than running RPCs on a stale schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    try {
      const first = createAppDatabase([manifest('notes', false, 'untitled')], { directory });
      first.close();
      expect(() => createAppDatabase([manifest('notes', false, 'draft')], { directory }))
        .toThrow('app table schema mismatch: notes.title');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('distinguishes SQL NULL from a text default containing the word NULL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    try {
      const noDefault = createAppDatabase([manifest('notes')], { directory });
      noDefault.close();
      expect(() => createAppDatabase([manifest('notes', false, 'NULL')], { directory }))
        .toThrow('app table schema mismatch: notes.title');
      const textDefault = createAppDatabase([manifest('other-notes', false, 'NULL')], { directory });
      textDefault.close();
      expect(() => createAppDatabase([manifest('other-notes', false, null)], { directory }))
        .toThrow('app table schema mismatch: notes.title');
      const explicitNull = createAppDatabase([manifest('null-default', false, null)], { directory });
      explicitNull.close();
      const reopenedNull = createAppDatabase([manifest('null-default', false, null)], { directory });
      reopenedNull.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('serializes every JSON primitive and object as JSON text through RPC binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const db = createAppDatabase([manifest('json-notes')], { directory });
    try {
      for (const [value, expected] of [
        [null, 'null'], [false, 'false'], [7, '7'], ['hello', '"hello"'], ['7', '"7"'], [{ value: 7 }, '{"value":7}'],
      ] as const) {
        expect(db.rpc('json-notes', 'echoJson', { value }, 'owner')).toEqual([{ value: expected }]);
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('validates object references with the canonical app storage key helper', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const db = createAppDatabase([manifest('notes-a')], { directory });
    try {
      expect(db.rpc('notes-a', 'echoObjectRef', { value: 'apps/notes-a/files/report.txt' }, 'owner'))
        .toEqual([{ value: 'apps/notes-a/files/report.txt' }]);
      for (const value of ['apps/notes-a/../notes-b/private', 'apps/notes-a//empty', 'apps/notes-a/has\\slash']) {
        expect(() => db.rpc('notes-a', 'echoObjectRef', { value }, 'owner')).toThrow('object-ref must stay within the app storage prefix');
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('adds a timestamp column with its default while preserving existing rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const databasePath = join(directory, 'notes.db');
    const original = new Database(databasePath);
    try {
      original.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE replies (id TEXT PRIMARY KEY, note_id TEXT REFERENCES notes(id) ON DELETE CASCADE);
        CREATE TABLE audit (note_id TEXT NOT NULL);
        CREATE INDEX notes_title_idx ON notes(title);
        CREATE TRIGGER notes_insert_audit AFTER INSERT ON notes BEGIN INSERT INTO audit VALUES (NEW.id); END;
        INSERT INTO notes (rowid, id, title) VALUES (42, '1', 'kept');
        INSERT INTO replies VALUES ('r1', '1');`);
    } finally { original.close(); }
    try {
      const reopened = createAppDatabase([manifest('notes', false, undefined, true)], { directory });
      try {
        expect(reopened.rpc('notes', 'list', {}, 'viewer')).toEqual([{ id: '1', title: 'kept', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) }]);
        reopened.rpc('notes', 'add', { id: '2', title: 'new' }, 'owner');
      } finally { reopened.close(); }
      const afterInsert = createAppDatabase([manifest('notes', false, undefined, true)], { directory });
      try {
        expect(afterInsert.rpc('notes', 'list', {}, 'viewer')).toEqual([
          { id: '1', title: 'kept', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
          { id: '2', title: 'new', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
        ]);
      } finally { afterInsert.close(); }
      const verify = new Database(databasePath);
      try {
        verify.exec('PRAGMA foreign_keys = ON');
        expect(verify.query('SELECT rowid FROM notes WHERE id = ?').get('1')).toEqual({ rowid: 42 });
        expect(verify.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'notes_title_idx'").all()).toHaveLength(1);
        expect(verify.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'notes_insert_audit'").all()).toHaveLength(1);
        expect(verify.query('SELECT note_id FROM audit ORDER BY note_id').all()).toEqual([{ note_id: '1' }, { note_id: '2' }]);
        expect(verify.query('SELECT id FROM replies').all()).toEqual([{ id: 'r1' }]);
        expect(() => verify.run("INSERT INTO notes (id, title) VALUES ('bad', NULL)")).toThrow();
        verify.run("DELETE FROM notes WHERE id = '1'");
        expect(verify.query('SELECT id FROM replies').all()).toEqual([]);
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('migrates legacy SQL-now defaults and stored values to the ISO time format', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-legacy-time-'));
    const databasePath = join(directory, 'notes.db');
    const original = new Database(databasePath);
    try {
      original.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, created_at TEXT DEFAULT ${LEGACY_SQL_NOW});
        INSERT INTO notes (id, title) VALUES ('1', 'legacy');
        INSERT INTO notes (id, title, created_at) VALUES ('3', 'unparseable', '2026-19-99 99:99:99');`);
    } finally { original.close(); }

    try {
      const app = createAppDatabase([manifest('notes', false, undefined, true)], { directory });
      try {
        expect(app.rpc('notes', 'list', {}, 'viewer')).toEqual([
          { id: '1', title: 'legacy', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
          { id: '3', title: 'unparseable', created_at: '2026-19-99 99:99:99' },
        ]);
        app.rpc('notes', 'add', { id: '4', title: 'new' }, 'owner');
        expect(app.rpc('notes', 'list', {}, 'viewer')).toEqual([
          { id: '1', title: 'legacy', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
          { id: '3', title: 'unparseable', created_at: '2026-19-99 99:99:99' },
          { id: '4', title: 'new', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
        ]);
      } finally { app.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('preserves the hidden rowid when a migration adds a column named rowid', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const databasePath = join(directory, 'notes.db');
    const original = new Database(databasePath);
    try { original.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT); INSERT INTO notes (rowid, id, title) VALUES (71, '1', 'kept')"); }
    finally { original.close(); }
    const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: notes
title: Notes
frontend: { kind: static-export }
roles:
  owner: { via: nexus-session }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
      _rowid_: { type: text }
      created_at: { type: timestamp, default: now }
rpc:
  list:
    sql: SELECT id, created_at FROM notes
    params: {}
    allow: [owner]
`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    try {
      const db = createAppDatabase([parsed.manifest], { directory });
      db.close();
      const verify = new Database(databasePath);
      try { expect(verify.query('SELECT rowid FROM notes WHERE id = ?').get('1')).toEqual({ rowid: 71 }); }
      finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('closes the failing and already-open databases when a later app initialization fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const close = spyOn(Database.prototype, 'close');
    try {
      const invalid = {
        ...manifest('broken'),
        tables: { broken: { columns: { value: { type: 'unsupported' } } } },
      } as unknown as ReturnType<typeof manifest>;
      expect(() => createAppDatabase([manifest('notes'), invalid], { directory })).toThrow('unsupported app column type');
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('safely rejects a timestamp migration when the existing table uses collation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const databasePath = join(directory, 'notes.db');
    const original = new Database(databasePath);
    try {
      original.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT COLLATE NOCASE NOT NULL); INSERT INTO notes VALUES ('1', 'Keep')");
    } finally { original.close(); }
    try {
      expect(() => createAppDatabase([manifest('notes', false, undefined, true)], { directory }))
        .toThrow('cannot safely migrate constrained app table: notes');
      const verify = new Database(databasePath);
      try {
        expect(verify.query("SELECT id FROM notes WHERE title = 'KEEP'").all()).toEqual([{ id: '1' }]);
        const schema = verify.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get() as { sql: string };
        expect(schema.sql).toContain('COLLATE NOCASE');
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('safely rejects a timestamp migration when table_info omits generated columns', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const databasePath = join(directory, 'notes.db');
    const original = new Database(databasePath);
    try {
      original.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, normalized TEXT GENERATED ALWAYS AS (lower(title)) STORED); INSERT INTO notes (id, title) VALUES ('1', 'Keep')");
    } finally { original.close(); }
    try {
      expect(() => createAppDatabase([manifest('notes', false, undefined, true)], { directory }))
        .toThrow('cannot safely migrate constrained app table: notes');
      const verify = new Database(databasePath);
      try {
        expect(verify.query('SELECT normalized FROM notes').all()).toEqual([{ normalized: 'keep' }]);
        const schema = verify.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get() as { sql: string };
        expect(schema.sql).toContain('GENERATED ALWAYS');
      } finally { verify.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('safely rejects timestamp migration when primary-key conflict semantics are not reconstructable', () => {
    for (const [slug, tableSql, insertSql] of [
      ['pk-desc', 'CREATE TABLE notes (id TEXT PRIMARY KEY DESC, title TEXT)', "INSERT INTO notes VALUES ('1', 'Keep')"],
      ['conflict', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL ON CONFLICT IGNORE)', "INSERT INTO notes VALUES ('1', 'Keep')"],
    ] as const) {
      const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
      const path = join(directory, `${slug}.db`);
      const original = new Database(path);
      try { original.exec(`${tableSql}; ${insertSql}`); } finally { original.close(); }
      try {
        expect(() => createAppDatabase([manifest(slug, false, undefined, true)], { directory }))
          .toThrow('cannot safely migrate constrained app table: notes');
        const verify = new Database(path);
        try { expect(verify.query('SELECT id, title FROM notes').all()).toEqual([{ id: '1', title: 'Keep' }]); }
        finally { verify.close(); }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });

  test('closes a database when SQLite PRAGMA setup fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const close = spyOn(Database.prototype, 'close');
    const execReal = Database.prototype.exec;
    const exec = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
      if (sql.includes('journal_mode')) throw new Error('pragma rejected');
      return execReal.call(this, sql);
    });
    try {
      expect(() => createAppDatabase([manifest('notes')], { directory })).toThrow('pragma rejected');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      exec.mockRestore();
      close.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
