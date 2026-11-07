import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAppAuth } from './fake-app-auth.js';
import { createFakeAppDbWorld } from './fake-app-db-world.js';
import type { AppManifest } from '../nexus/apps/app-contract.js';

test('SIM-APPDB + SIM-APPAUTH bind RPC app and viewer role to the accepted session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-appdb-auth-rpc-'));
  const app = {
    apiVersion: 'elanous.app/v0', slug: 'notes', title: 'Notes',
    tables: { notes: { columns: { id: { type: 'text', primary: true }, title: { type: 'text' } } } },
    roles: { owner: { via: 'nexus-session' }, viewer: { via: 'share-link' } },
    rpc: {
      list: { sql: 'SELECT id, title FROM notes ORDER BY id', params: {}, allow: ['owner', 'viewer'] },
      add: { sql: 'INSERT INTO notes (id, title) VALUES (:id, :title)', params: { id: { type: 'text' }, title: { type: 'text' } }, allow: ['owner'] },
    },
  } as AppManifest;
  const auth = createFakeAppAuth({ dir: join(dir, 'auth') });
  const db = createFakeAppDbWorld([app]);
  try {
    const invite = auth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-1' });
    const accepted = auth.acceptInvitation({ appSlug: 'notes', token: invite.token });
    expect(accepted.status).toBe(200);
    const session = auth.getSessionRecord(accepted.sessionToken!);
    expect(session?.appSlug).toBe('notes');
    const role = session!.role; // The role comes from the accepted share-link session.
    expect(role).toBe('viewer');
    expect(db.rpc(session!.appSlug, 'list', {}, role)).toEqual([]);
    expect(() => db.rpc(session!.appSlug, 'add', { id: '1', title: 'blocked' }, role)).toThrow('app role is not allowed');
    expect(auth.verifySession({ appSlug: 'other', token: accepted.sessionToken! }).status).toBe(401);
    expect(db.rpc(session!.appSlug, 'list', {}, role)).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
