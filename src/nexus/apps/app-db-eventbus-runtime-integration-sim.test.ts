import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexusEventBus } from '../api/event-bus.js';
import { appRealtimeSnapshotCursor, handleAppRealtimeEvents } from './app-realtime.js';
import { loadNexusAppHost } from './app-host.js';

const APP_AUTH_KEY = 'nexus-app-eventbus-runtime-sim-key-with-more-than-256-bits';
const APP_MANIFEST = `apiVersion: elanous.app/v0
slug: event-notes
title: Event notes
frontend: { kind: static-export, out: out }
roles:
  owner: { via: share-link }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
rpc:
  list:
    sql: SELECT id, title FROM notes ORDER BY id
    params: {}
    allow: [owner]
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  rename:
    sql: UPDATE notes SET title = :title WHERE id = :id
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
  remove:
    sql: DELETE FROM notes WHERE id = :id
    params: { id: { type: text } }
    allow: [owner]
`;

async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return new TextDecoder().decode(chunk.value);
}

async function rpc(
  host: ReturnType<typeof loadNexusAppHost>['appHost'],
  slug: string,
  name: string,
  cookie: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return (await host.handle(new Request(`http://nexus.invalid/__rpc/${name}`, {
    method: 'POST',
    headers: {
      host: `${slug}.app.localhost`,
      origin: `http://${slug}.app.localhost`,
      cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ params }),
  })))!;
}

describe('NEXUS-APP-RT runtime event-bus integration simulation', () => {
  test('authenticated runtime writes publish ordered app-scoped events to SSE subscribers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-app-eventbus-runtime-'));
    const appsDir = join(root, 'apps');
    const appDir = join(appsDir, 'event-notes');
    const otherAppDir = join(appsDir, 'member-b-notes');
    const outDir = join(appDir, 'out');
    const otherOutDir = join(otherAppDir, 'out');
    mkdirSync(outDir, { recursive: true });
    mkdirSync(otherOutDir, { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), APP_MANIFEST);
    writeFileSync(join(outDir, 'index.html'), '<main>event notes</main>');
    writeFileSync(join(otherAppDir, 'app.yaml'), APP_MANIFEST.replaceAll('event-notes', 'member-b-notes'));
    writeFileSync(join(otherOutDir, 'index.html'), '<main>member b notes</main>');

    const eventBus = new NexusEventBus();
    const loaded = loadNexusAppHost(appsDir, undefined, {
      dir: join(root, 'auth'),
      databaseDirectory: join(root, 'db'),
      key: APP_AUTH_KEY,
      eventBus,
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let otherReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let triggerDb: Database | undefined;
    try {
      expect(loaded.issues).toEqual([]);
      triggerDb = new Database(join(root, 'db', 'event-notes.db'));
      triggerDb.exec('CREATE TABLE audit (entry TEXT)');
      triggerDb.exec(`CREATE TRIGGER notes_audit_insert AFTER INSERT ON notes
        BEGIN INSERT INTO audit (entry) VALUES (NEW.id); END`);
      const invitation = loaded.appHost.issueInvitation('event-notes', 'sim-owner', undefined, 'owner');
      const otherInvitation = loaded.appHost.issueInvitation('member-b-notes', 'different-sim-owner', undefined, 'owner');
      const accepted = (await loaded.appHost.handle(new Request(
        `http://nexus.invalid/__auth/accept?token=${encodeURIComponent(invitation.token)}`,
        { headers: { host: 'event-notes.app.localhost' } },
      )))!;
      expect(accepted.status).toBe(303);
      const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
      const otherAccepted = (await loaded.appHost.handle(new Request(
        `http://nexus.invalid/__auth/accept?token=${encodeURIComponent(otherInvitation.token)}`,
        { headers: { host: 'member-b-notes.app.localhost' } },
      )))!;
      expect(otherAccepted.status).toBe(303);
      const otherCookie = otherAccepted.headers.get('set-cookie')!.split(';', 1)[0]!;

      const cursor = appRealtimeSnapshotCursor(eventBus, 'event-notes');
      reader = handleAppRealtimeEvents(eventBus, 'event-notes', cursor).body!.getReader();
      expect(await nextFrame(reader)).toContain(': app row events stream');
      const otherCursor = appRealtimeSnapshotCursor(eventBus, 'member-b-notes');
      otherReader = handleAppRealtimeEvents(eventBus, 'member-b-notes', otherCursor).body!.getReader();
      expect(await nextFrame(otherReader)).toContain(': app row events stream');

      expect((await rpc(loaded.appHost, 'event-notes', 'list', cookie, {})).status).toBe(200);
      expect((await rpc(loaded.appHost, 'member-b-notes', 'list', cookie, {})).status).toBe(401);
      expect((await rpc(loaded.appHost, 'member-b-notes', 'add', otherCookie, { id: 'foreign-note', title: 'member b' })).status).toBe(200);
      const otherInserted = await nextFrame(otherReader);
      expect(otherInserted).toContain('"appSlug":"member-b-notes"');
      expect(otherInserted).toContain('"rowId":"foreign-note"');
      expect((await rpc(loaded.appHost, 'event-notes', 'add', cookie, { id: 'note-1', title: 'first' })).status).toBe(200);
      const inserted = await nextFrame(reader);
      expect(inserted).toContain('event: app.row.insert');
      expect(inserted).toContain('"appSlug":"event-notes"');
      expect(inserted).not.toContain('foreign-note');
      expect(triggerDb.query('SELECT entry FROM audit').get()).toEqual({ entry: 'note-1' });

      expect((await rpc(loaded.appHost, 'event-notes', 'rename', cookie, { id: 'note-1', title: 'second' })).status).toBe(200);
      const updated = await nextFrame(reader);
      expect(updated).toContain('event: app.row.update');

      expect((await rpc(loaded.appHost, 'event-notes', 'remove', cookie, { id: 'note-1' })).status).toBe(200);
      const deleted = await nextFrame(reader);
      expect(deleted).toContain('event: app.row.delete');

      expect([inserted, updated, deleted].map(frame => /:([0-9]+)\n/.exec(frame)?.[1])).toEqual(['1', '2', '3']);
    } finally {
      await reader?.cancel();
      await otherReader?.cancel();
      triggerDb?.close();
      loaded.appHost.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
