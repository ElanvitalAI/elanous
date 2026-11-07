import { describe, expect, test } from 'bun:test';
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
});
