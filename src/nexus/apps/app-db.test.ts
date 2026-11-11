import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppManifest } from './app-contract.js';
import { createAppDatabase } from './app-db.js';
import { NexusEventBus } from '../api/event-bus.js';

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
  update:
    sql: UPDATE notes SET title = :title WHERE id = :id
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  delete:
    sql: DELETE FROM notes WHERE id = :id
    params: { id: { type: text } }
    allow: [owner]
  addNullId:
    sql: INSERT INTO notes (id, title) VALUES (NULL, :title)
    params: { title: { type: text } }
    allow: [owner]
  startMove:
    sql: INSERT OR REPLACE INTO notes (id, title) VALUES ('trigger-only', 'trigger-only')
    params: {}
    allow: [owner]
  updateNullId:
    sql: UPDATE notes SET title = :title WHERE id IS NULL AND title = :previous
    params: { previous: { type: text }, title: { type: text } }
    allow: [owner]
  deleteNullId:
    sql: DELETE FROM notes WHERE id IS NULL AND title = :title
    params: { title: { type: text } }
    allow: [owner]
  replace:
    sql: INSERT OR REPLACE INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  replaceComment:
    sql: INSERT OR /* separated keyword */ REPLACE INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  updateReplace:
    sql: UPDATE OR REPLACE notes SET title = :title WHERE id = :id
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  replaceAtRowid:
    sql: INSERT OR REPLACE INTO notes (rowid, id, title) VALUES (:rowid, :id, :title)
    params: { rowid: { type: int }, id: { type: text }, title: { type: text } }
    allow: [owner]
  replaceBlob:
    sql: INSERT OR REPLACE INTO notes (id, title) VALUES (:id, CAST(X'00FF' AS BLOB))
    params: { id: { type: text } }
    allow: [owner]
  addBlob:
    sql: INSERT INTO notes (id, title) VALUES (:id, CAST(X'00FF' AS BLOB))
    params: { id: { type: text } }
    allow: [owner]
  partialFail:
    sql: INSERT OR FAIL INTO notes (id, title) VALUES ('partial', 'must persist'), ('dup', 'conflict')
    params: {}
    allow: [owner]
  multiReplace:
    sql: INSERT OR REPLACE INTO notes (id, title) VALUES ('same-key', 'intermediate'), ('same-key', 'final')
    params: {}
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
  test('publishes committed CRUD rows, preserves SQLite FAIL partial writes, and observes BLOB and REPLACE changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    try {
      const db = createAppDatabase([manifest('notes-a'), manifest('notes-b')], { directory, eventBus });
      try {
        db.rpc('notes-a', 'add', { id: '1', title: 'first' }, 'owner');
        db.rpc('notes-b', 'add', { id: '2', title: 'other app' }, 'owner');
        db.rpc('notes-a', 'update', { id: '1', title: 'edited' }, 'owner');
        db.rpc('notes-a', 'delete', { id: '1' }, 'owner');
        db.rpc('notes-a', 'add', { id: 'dup', title: 'kept' }, 'owner');
        expect(() => db.rpc('notes-a', 'partialFail', {}, 'owner')).toThrow();
        expect(db.rpc('notes-a', 'list', {}, 'owner')).toEqual([
          { id: 'dup', title: 'kept' }, { id: 'partial', title: 'must persist' },
        ]);
        db.rpc('notes-a', 'addBlob', { id: 'blob' }, 'owner');
        db.rpc('notes-a', 'replaceComment', { id: 'blob', title: 'replacement' }, 'owner');
        // This Nexus owner bus intentionally observes all installed apps; appSlug preserves tenant identity.
        expect(events.map(event => event.kind)).toEqual([
          'app.row.insert', 'app.row.insert', 'app.row.update', 'app.row.delete', 'app.row.insert', 'app.row.insert',
          'app.row.insert', 'app.row.delete', 'app.row.insert',
        ]);
        expect(events.map(event => event.detail?.appSlug)).toEqual(['notes-a', 'notes-b', 'notes-a', 'notes-a', 'notes-a', 'notes-a', 'notes-a', 'notes-a', 'notes-a']);
        expect(events[2]?.detail).toMatchObject({ table: 'notes', rowId: '1', row: { id: '1', title: 'edited' } });
        expect(events[6]?.detail).toMatchObject({ row: { id: 'blob', title: { $blobHex: '00FF' } } });
        expect(events[7]?.detail).toMatchObject({ row: { id: 'blob', title: { $blobHex: '00FF' } } });
      } finally { db.close(); }
    } finally {
      unsubscribe();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('infers trigger REPLACE deletes when a later RAISE(FAIL) leaves a partial commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-partial-fail-replace-'));
    const base = manifest('notes');
    const partialManifest = {
      ...base,
      rpc: {
        ...base.rpc,
        partialTriggerFail: {
          sql: "INSERT INTO notes (id, title) VALUES ('partial', 'must persist'), ('later', 'fails')",
          params: {},
          allow: ['owner'],
        },
      },
    } as typeof base;
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([partialManifest], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      raw.exec(`CREATE UNIQUE INDEX notes_title_unique ON notes(title);
        CREATE TRIGGER replace_on_partial AFTER INSERT ON notes WHEN NEW.id = 'partial'
        BEGIN INSERT OR REPLACE INTO notes (id, title) VALUES ('replacement', 'occupied'); END;
        CREATE TRIGGER fail_later BEFORE INSERT ON notes WHEN NEW.id = 'later'
        BEGIN SELECT RAISE(FAIL, 'later row failure'); END`);
      db.rpc('notes', 'add', { id: 'replace-target', title: 'occupied' }, 'owner');
      events.length = 0;
      expect(() => db.rpc('notes', 'partialTriggerFail', {}, 'owner')).toThrow();
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.insert', 'partial'], ['app.row.delete', 'replace-target'], ['app.row.insert', 'replacement'],
      ]);
      expect(db.rpc('notes', 'list', {}, 'owner')).toEqual([
        { id: 'partial', title: 'must persist' }, { id: 'replacement', title: 'occupied' },
      ]);
    } finally { unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('preserves the SQLite constraint error when OR ROLLBACK removes the RPC savepoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-or-rollback-'));
    const base = manifest('rollback-notes');
    const rollbackManifest = {
      ...base,
      rpc: {
        ...base.rpc,
        rollbackConflict: {
          sql: 'INSERT OR ROLLBACK INTO notes (id, title) VALUES (:id, :title)',
          params: { id: { type: 'text' }, title: { type: 'text' } },
          allow: ['owner'],
        },
      },
    } as typeof base;
    const db = createAppDatabase([rollbackManifest], { directory });
    try {
      db.rpc('rollback-notes', 'add', { id: 'duplicate', title: 'kept' }, 'owner');
      let failure: unknown;
      try { db.rpc('rollback-notes', 'rollbackConflict', { id: 'duplicate', title: 'rejected' }, 'owner'); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/UNIQUE constraint failed/iu);
      expect((failure as Error).message).not.toMatch(/savepoint/iu);
      expect(db.rpc('rollback-notes', 'list', {}, 'owner')).toEqual([{ id: 'duplicate', title: 'kept' }]);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('preserves the existing non-recursive behavior of app database triggers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-user-trigger-'));
    const db = createAppDatabase([manifest('notes')], { directory });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      db.rpc('notes', 'add', { id: '1', title: 'first' }, 'owner');
      raw.exec(`CREATE TRIGGER user_update_title AFTER UPDATE ON notes
        BEGIN UPDATE notes SET title = NEW.title || '!' WHERE id = NEW.id; END`);
      db.rpc('notes', 'update', { id: '1', title: 'edited' }, 'owner');
      expect(db.rpc('notes', 'list', {}, 'owner')).toEqual([{ id: '1', title: 'edited!' }]);
    } finally {
      raw.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('publishes rows with nullable TEXT primary keys using stable rowid event identifiers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-null-primary-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    try {
      db.rpc('notes', 'addNullId', { title: 'first' }, 'owner');
      db.rpc('notes', 'addNullId', { title: 'second' }, 'owner');
      const insertedIds = events.map(event => String(event.detail?.rowId));
      expect(insertedIds[0]).toMatch(/^rowid:/u);
      expect(insertedIds[1]).toMatch(/^rowid:/u);
      expect(new Set(insertedIds).size).toBe(2);
      db.rpc('notes', 'add', { id: insertedIds[0], title: 'rowid-prefixed-key' }, 'owner');
      const prefixedId = String(events[2]?.detail?.rowId);
      expect(prefixedId).toBe(`key:${insertedIds[0]}`);
      expect(prefixedId).not.toBe(insertedIds[0]);
      db.rpc('notes', 'add', { id: prefixedId, title: 'escaped-key' }, 'owner');
      expect(events[3]?.detail?.rowId).toBe(`key:${prefixedId}`);
      db.rpc('notes', 'updateNullId', { previous: 'first', title: 'updated' }, 'owner');
      db.rpc('notes', 'deleteNullId', { title: 'second' }, 'owner');
      expect(events.map(event => event.kind)).toEqual([
        'app.row.insert', 'app.row.insert', 'app.row.insert', 'app.row.insert', 'app.row.update', 'app.row.delete',
      ]);
      expect(events[4]?.detail?.rowId).toBe(insertedIds[0]);
      expect(events[5]?.detail?.rowId).toBe(insertedIds[1]);
    } finally { unsubscribe(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('does not treat physical rowids as synthetic mapping entries during nullable-primary REPLACE', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-physical-rowid-replace-'));
    const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: physical-rowid-replace
title: Notes
frontend: { kind: static-export }
roles: { owner: { via: nexus-session } }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
rpc:
  add:
    sql: INSERT INTO notes (id, title) VALUES (NULL, :title)
    params: { title: { type: text } }
    allow: [owner]
  replace:
    sql: INSERT OR REPLACE INTO notes (id, title) VALUES (NULL, :title)
    params: { title: { type: text } }
    allow: [owner]
`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([parsed.manifest], { directory, eventBus });
    const raw = new Database(join(directory, 'physical-rowid-replace.db'));
    try {
      raw.exec('CREATE UNIQUE INDEX notes_title_unique ON notes(title)');
      db.rpc('physical-rowid-replace', 'add', { title: 'replace-me' }, 'owner');
      const previousId = String(events[0]?.detail?.rowId);
      events.length = 0;
      expect(() => db.rpc('physical-rowid-replace', 'replace', { title: 'replace-me' }, 'owner')).not.toThrow();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'app.row.delete', detail: { rowId: previousId } });
      expect(events[1]?.kind).toBe('app.row.insert');
      expect(String(events[1]?.detail?.rowId)).toMatch(/^rowid:/u);
    } finally { unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('keeps app RPCs working when every SQLite rowid alias is a nullable declared column', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-shadowed-rowid-'));
    const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: shadowed
title: Notes
frontend: { kind: static-export }
roles:
  owner: { via: nexus-session }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
      rowid: { type: text }
      _rowid_: { type: text }
      oid: { type: text }
rpc:
  add:
    sql: INSERT INTO notes (id, title, rowid, _rowid_, oid) VALUES (NULL, :title, NULL, NULL, NULL)
    params: { title: { type: text } }
    allow: [owner]
  update:
    sql: UPDATE notes SET title = :title WHERE id IS NULL AND title = :previous
    params: { previous: { type: text }, title: { type: text } }
    allow: [owner]
  delete:
    sql: DELETE FROM notes WHERE id IS NULL AND title = :title
    params: { title: { type: text } }
    allow: [owner]
`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    try {
      const db = createAppDatabase([parsed.manifest], { directory, eventBus });
      try {
        db.rpc('shadowed', 'add', { title: 'first' }, 'owner');
        db.rpc('shadowed', 'add', { title: 'second' }, 'owner');
        const insertedIds = events.map(event => String(event.detail?.rowId));
        expect(insertedIds[0]).toMatch(/^rowid:/u);
        expect(insertedIds[1]).toMatch(/^rowid:/u);
        expect(new Set(insertedIds).size).toBe(2);
        db.rpc('shadowed', 'update', { previous: 'first', title: 'updated' }, 'owner');
        db.rpc('shadowed', 'delete', { title: 'second' }, 'owner');
        expect(events.map(event => event.kind)).toEqual(['app.row.insert', 'app.row.insert', 'app.row.update', 'app.row.delete']);
        expect(events[2]?.detail?.rowId).toBe(insertedIds[0]);
        expect(events[3]?.detail?.rowId).toBe(insertedIds[1]);
      } finally { db.close(); }
    } finally { unsubscribe(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('captures REPLACE deletes and preserves synthetic identity when all rowid aliases are shadowed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-shadowed-rowid-replace-'));
    const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: shadowed-replace
title: Notes
frontend: { kind: static-export }
roles: { owner: { via: nexus-session } }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
      rowid: { type: text }
      _rowid_: { type: text }
      oid: { type: text }
rpc:
  add:
    sql: INSERT INTO notes (id, title, rowid, _rowid_, oid) VALUES (NULL, :title, NULL, NULL, NULL)
    params: { title: { type: text } }
    allow: [owner]
  replace:
    sql: INSERT OR REPLACE INTO notes (id, title, rowid, _rowid_, oid) VALUES (NULL, :title, NULL, NULL, NULL)
    params: { title: { type: text } }
    allow: [owner]
  delete:
    sql: DELETE FROM notes WHERE id IS NULL AND title = :title
    params: { title: { type: text } }
    allow: [owner]
`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    try {
      const db = createAppDatabase([parsed.manifest], { directory, eventBus });
      const raw = new Database(join(directory, 'shadowed-replace.db'));
      try {
        raw.exec('CREATE UNIQUE INDEX notes_title_unique ON notes(title)');
        db.rpc('shadowed-replace', 'add', { title: 'replace-me' }, 'owner');
        const previousId = String(events[0]?.detail?.rowId);
        expect(previousId).toMatch(/^rowid:/u);
        events.length = 0;
        db.rpc('shadowed-replace', 'replace', { title: 'replace-me' }, 'owner');
        const replacementId = String(events[1]?.detail?.rowId);
        expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
          ['app.row.delete', previousId], ['app.row.insert', replacementId],
        ]);
        expect(replacementId).not.toBe(previousId);
        events.length = 0;
        db.rpc('shadowed-replace', 'delete', { title: 'replace-me' }, 'owner');
        expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([['app.row.delete', replacementId]]);
      } finally { raw.close(); db.close(); }
    } finally { unsubscribe(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('captures nested REPLACE deletes and does not duplicate deletes already recorded by user triggers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-trigger-replace-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      db.rpc('notes', 'add', { id: 'dup', title: 'old' }, 'owner');
      raw.exec(`CREATE TRIGGER user_replace AFTER INSERT ON notes WHEN NEW.id = 'source'
        BEGIN INSERT OR REPLACE INTO notes (id, title) VALUES ('dup', 'from nested replace'); END`);
      db.rpc('notes', 'add', { id: 'source', title: 'trigger replaces' }, 'owner');
      expect(events.filter(event => event.detail?.rowId === 'dup').map(event => event.kind))
        .toEqual(['app.row.insert', 'app.row.delete', 'app.row.insert']);

      raw.exec(`CREATE TRIGGER user_delete_then_replace AFTER INSERT ON notes WHEN NEW.id = 'source-2'
        BEGIN DELETE FROM notes WHERE id = 'dup'; INSERT OR REPLACE INTO notes (id, title) VALUES ('dup', 'explicit delete'); END`);
      db.rpc('notes', 'add', { id: 'source-2', title: 'trigger deletes first' }, 'owner');
      expect(events.filter(event => event.detail?.rowId === 'dup').map(event => event.kind))
        .toEqual(['app.row.insert', 'app.row.delete', 'app.row.insert', 'app.row.delete', 'app.row.insert']);

      raw.exec(`CREATE TRIGGER user_delete_insert_replace AFTER INSERT ON notes WHEN NEW.id = 'source-3'
        BEGIN DELETE FROM notes WHERE id = 'dup'; INSERT INTO notes (id, title) VALUES ('dup', 'intermediate');
        INSERT OR REPLACE INTO notes (id, title) VALUES ('dup', 'final'); END`);
      db.rpc('notes', 'add', { id: 'source-3', title: 'replace an inserted row' }, 'owner');
      expect(events.filter(event => event.detail?.rowId === 'dup').map(event => event.kind))
        .toEqual(['app.row.insert', 'app.row.delete', 'app.row.insert', 'app.row.delete', 'app.row.insert', 'app.row.delete', 'app.row.insert', 'app.row.delete', 'app.row.insert']);

      raw.exec(`CREATE TRIGGER user_update_then_replace AFTER INSERT ON notes WHEN NEW.id = 'source-4'
        BEGIN UPDATE notes SET title = 'latest before delete' WHERE id = 'dup';
        INSERT OR REPLACE INTO notes (id, title) VALUES ('dup', 'after nested replace'); END`);
      db.rpc('notes', 'add', { id: 'source-4', title: 'update then replace' }, 'owner');
      const dupEvents = events.filter(event => event.detail?.rowId === 'dup');
      expect(dupEvents.slice(-3).map(event => event.kind)).toEqual(['app.row.update', 'app.row.delete', 'app.row.insert']);
      expect(dupEvents.at(-2)?.detail?.row).toEqual({ id: 'dup', title: 'latest before delete' });

      db.rpc('notes', 'multiReplace', {}, 'owner');
      expect(events.filter(event => event.detail?.rowId === 'same-key').map(event => event.kind))
        .toEqual(['app.row.insert', 'app.row.delete', 'app.row.insert']);
    } finally {
      unsubscribe();
      raw.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('captures implicit deletes from a table UNIQUE ON CONFLICT REPLACE constraint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-replace-constraint-'));
    const raw = new Database(join(directory, 'notes.db'));
    raw.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT UNIQUE ON CONFLICT REPLACE)');
    raw.close();
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    try {
      db.rpc('notes', 'add', { id: 'old', title: 'same' }, 'owner');
      db.rpc('notes', 'add', { id: 'new', title: 'same' }, 'owner');
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.insert', 'old'], ['app.row.delete', 'old'], ['app.row.insert', 'new'],
      ]);
      expect(db.rpc('notes', 'list', {}, 'owner')).toEqual([{ id: 'new', title: 'same' }]);
    } finally { unsubscribe(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('publishes UPDATE OR REPLACE unique-conflict deletes before the replacing update', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-update-replace-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      raw.exec('CREATE UNIQUE INDEX notes_title_unique ON notes(title)');
      db.rpc('notes', 'add', { id: 'target', title: 'available' }, 'owner');
      db.rpc('notes', 'add', { id: 'old', title: 'occupied' }, 'owner');
      const oldRowid = (raw.query("SELECT rowid FROM notes WHERE id = 'old'").get() as { rowid: number }).rowid;
      events.length = 0;
      db.rpc('notes', 'replaceAtRowid', { rowid: oldRowid, id: 'new-id', title: 'occupied' }, 'owner');
      const newRowid = (raw.query("SELECT rowid FROM notes WHERE id = 'new-id'").get() as { rowid: number }).rowid;
      expect(newRowid).toBe(oldRowid); // The RPC explicitly reuses the replaced row's physical identifier.
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.delete', 'old'], ['app.row.insert', 'new-id'],
      ]);

      events.length = 0;
      db.rpc('notes', 'replaceAtRowid', { rowid: newRowid, id: 'new-id', title: 'replacement at same identity' }, 'owner');
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.delete', 'new-id'], ['app.row.insert', 'new-id'],
      ]);

      db.rpc('notes', 'add', { id: 'update-old', title: 'update-conflict' }, 'owner');
      db.rpc('notes', 'add', { id: 'update-target', title: 'update-available' }, 'owner');
      events.length = 0;
      db.rpc('notes', 'updateReplace', { id: 'update-target', title: 'update-conflict' }, 'owner');
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.delete', 'update-old'], ['app.row.update', 'update-target'],
      ]);
      expect(events[0]?.detail?.row).toEqual({ id: 'update-old', title: 'update-conflict' });
    } finally {
      unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  test('matches BLOB values serialized in row snapshots when replacing a unique BLOB key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-blob-unique-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      raw.exec('CREATE UNIQUE INDEX notes_blob_unique ON notes(title)');
      db.rpc('notes', 'addBlob', { id: 'blob-old' }, 'owner');
      events.length = 0;
      db.rpc('notes', 'replaceBlob', { id: 'blob-new' }, 'owner');
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.delete', 'blob-old'], ['app.row.insert', 'blob-new'],
      ]);
      expect(events[0]?.detail?.row).toEqual({ id: 'blob-old', title: { $blobHex: '00FF' } });
    } finally { unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('keeps unrelated RPCs working with partial and expression unique indexes plus REPLACE triggers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-unsupported-index-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      raw.exec(`CREATE UNIQUE INDEX notes_partial_title ON notes(title) WHERE id != 'excluded';
        CREATE UNIQUE INDEX notes_expression_title ON notes(replace(title, '(', 'x'));
        CREATE TRIGGER replace_partial AFTER INSERT ON notes WHEN NEW.id = 'source-partial'
        BEGIN INSERT OR REPLACE INTO notes (id, title) VALUES ('triggered-partial', 'partial'); END;
        CREATE TRIGGER replace_expression AFTER INSERT ON notes WHEN NEW.id = 'source-expression'
        BEGIN INSERT OR REPLACE INTO notes (id, title) VALUES ('triggered-expression', 'x'); END`);
      expect(() => db.rpc('notes', 'add', { id: 'ordinary', title: 'ordinary' }, 'owner')).not.toThrow();
      db.rpc('notes', 'add', { id: 'partial-old', title: 'partial' }, 'owner');
      events.length = 0;
      db.rpc('notes', 'add', { id: 'source-partial', title: 'source' }, 'owner');
      expect(events.filter(event => ['partial-old', 'triggered-partial'].includes(String(event.detail?.rowId)))
        .map(event => [event.kind, event.detail?.rowId])).toEqual([
          ['app.row.delete', 'partial-old'], ['app.row.insert', 'triggered-partial'],
        ]);

      db.rpc('notes', 'add', { id: 'expression-old', title: '(' }, 'owner');
      events.length = 0;
      db.rpc('notes', 'add', { id: 'source-expression', title: 'expression-source' }, 'owner');
      expect(events.filter(event => ['expression-old', 'triggered-expression'].includes(String(event.detail?.rowId)))
        .map(event => [event.kind, event.detail?.rowId])).toEqual([
          ['app.row.delete', 'expression-old'], ['app.row.insert', 'triggered-expression'],
        ]);
    } finally { unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('does not fail a valid RPC when a legacy unique index references an unmanifested column', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-unmanifested-index-column-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      db.rpc('notes', 'add', { id: 'legacy', title: 'old' }, 'owner');
      raw.exec("ALTER TABLE notes ADD COLUMN legacy_code TEXT DEFAULT 'legacy'; CREATE UNIQUE INDEX notes_legacy_partial ON notes(legacy_code) WHERE id = 'legacy'");
      events.length = 0;
      expect(() => db.rpc('notes', 'add', { id: 'new', title: 'safe' }, 'owner')).not.toThrow();
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([['app.row.insert', 'new']]);
    } finally { unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('does not infer deletion from a pre-RPC unique value after the row has moved away', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-moved-unique-key-'));
    const eventBus = new NexusEventBus();
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe(event => events.push(event), ['app.row.']);
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    const raw = new Database(join(directory, 'notes.db'));
    try {
      raw.exec(`CREATE UNIQUE INDEX notes_title_unique ON notes(title);
        CREATE TRIGGER move_unique_value AFTER INSERT ON notes WHEN NEW.id = 'trigger-only'
        BEGIN UPDATE notes SET title = 'y' WHERE id = 'a'; UPDATE notes SET title = 'x' WHERE id = 'b'; END`);
      db.rpc('notes', 'add', { id: 'a', title: 'x' }, 'owner');
      db.rpc('notes', 'add', { id: 'b', title: 'z' }, 'owner');
      events.length = 0;
      db.rpc('notes', 'startMove', {}, 'owner');
      expect(events.map(event => [event.kind, event.detail?.rowId])).toEqual([
        ['app.row.insert', 'trigger-only'], ['app.row.update', 'a'], ['app.row.update', 'b'],
      ]);
      expect(db.rpc('notes', 'list', {}, 'owner')).toEqual([
        { id: 'a', title: 'y' }, { id: 'b', title: 'x' }, { id: 'trigger-only', title: 'trigger-only' },
      ]);
    } finally { unsubscribe(); raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('does not turn a committed RPC into a failure when event publication throws', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-db-event-publish-failure-'));
    const eventBus = { publishAppRowChange() { throw new Error('subscriber unavailable'); } };
    const db = createAppDatabase([manifest('notes')], { directory, eventBus });
    try {
      expect(() => db.rpc('notes', 'add', { id: 'committed', title: 'saved' }, 'owner')).not.toThrow();
      expect(db.rpc('notes', 'list', {}, 'owner')).toEqual([{ id: 'committed', title: 'saved' }]);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

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
