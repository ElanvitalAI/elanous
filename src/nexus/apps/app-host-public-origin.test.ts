import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppAuth } from './app-auth.js';
import { loadNexusAppHost } from './app-host.js';

const APP_KEY = 'nexus-public-origin-test-key-with-at-least-256-bits';
const manifest = `apiVersion: elanous.app/v0
slug: lecture-scrap
title: Lecture scrap
frontend: { kind: static-export, out: out }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      body: { type: text }
roles:
  owner: { via: nexus-session }
  public: { via: public-read }
rpc:
  listNotes:
    sql: SELECT id, body FROM notes ORDER BY id
    params: {}
    allow: [owner, public]
  addNote:
    sql: INSERT INTO notes (id, body) VALUES (:id, :body)
    params: { id: { type: text }, body: { type: text } }
    allow: [owner]
`;

function request(host: string, path: string, method = 'GET', options: { cookie?: string; body?: string } = {}): Request {
  return new Request(`https://${host}${path}`, {
    method,
    headers: {
      host,
      ...(method === 'POST' ? { origin: `https://${host}`, 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
  });
}

test('LOAD-2/APP-DEPLOY public origin routes static and RPC reads, isolates user slug, and keeps writes owner-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-host-public-origin-'));
  const appDir = join(root, 'lecture-scrap');
  mkdirSync(join(appDir, 'out'), { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), manifest);
  writeFileSync(join(appDir, 'out', 'index.html'), '<main>강의 자료 공개 목록</main>');
  const authDir = join(root, 'auth');
  const dbDir = join(root, 'db');
  const { appHost, issues } = loadNexusAppHost(root, undefined, {
    dir: authDir, databaseDirectory: dbDir, key: APP_KEY,
  }, 'kaist-demo');
  try {
    expect(issues).toEqual([]);
    const publicHost = 'lecture-scrap--kaist-demo.elanous.app';
    const page = await appHost.handle(request(publicHost, '/'));
    expect(page?.status).toBe(200);
    expect(page?.headers.get('x-nexus-app-host')).toBe(publicHost);
    expect(page?.headers.get('x-nexus-app-origin')).toBe(`https://${publicHost}`);
    expect(await page?.text()).toContain('강의 자료 공개 목록');
    expect((await appHost.handle(request('lecture-scrap--other-user.elanous.app', '/')))?.status).toBe(404);
    expect(await appHost.handle(request('lecture-scrap--kaist-demo.elanous.ai', '/'))).toBeUndefined();

    const publicRead = await appHost.handle(request(publicHost, '/__rpc/listNotes', 'POST', { body: '{}' }));
    expect(publicRead?.status).toBe(200);
    expect(await publicRead?.json()).toEqual({ rows: [] });
    const publicWrite = await appHost.handle(request(publicHost, '/__rpc/addNote', 'POST', {
      body: JSON.stringify({ params: { id: 'public-write', body: 'denied' } }),
    }));
    expect(publicWrite?.status).toBe(403);

    const auth = createAppAuth({ dir: join(authDir, 'lecture-scrap'), key: APP_KEY });
    const invite = auth.issueInvitation({ appSlug: 'lecture-scrap', invitedBy: 'nexus-owner', role: 'owner' });
    const accepted = auth.acceptInvitation({ appSlug: 'lecture-scrap', token: invite.token });
    expect(accepted.status).toBe(200);
    const ownerWrite = await appHost.handle(request(publicHost, '/__rpc/addNote', 'POST', {
      cookie: accepted.cookie!, body: JSON.stringify({ params: { id: 'owner-write', body: 'allowed' } }),
    }));
    expect(ownerWrite?.status).toBe(200);
    const readBack = await appHost.handle(request(publicHost, '/__rpc/listNotes', 'POST', { body: '{}' }));
    expect(await readBack?.json()).toEqual({ rows: [{ id: 'owner-write', body: 'allowed' }] });
    appHost.unmountDirectory('lecture-scrap');
    expect(appHost.slugs).not.toContain('lecture-scrap');
    expect((await appHost.handle(request(publicHost, '/')))?.status).toBe(404);
  } finally {
    appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});
