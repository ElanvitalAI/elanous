import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { createFakeAppHost } from './fake-app-host.js';
import { FakeQrBrowserStorage, fetchFakePublicAppQr, resolveFakePublicAppName } from './kaist-app-qr-sim.js';

const appManifest = (slug: string) => `apiVersion: elanous.app/v0
slug: ${slug}
title: ${slug}
frontend: { kind: static-export, out: out }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
roles:
  owner: { via: nexus-session }
rpc:
  list:
    sql: SELECT id, title FROM notes ORDER BY id
    params: {}
    allow: [owner]
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
`;

test('KAIST-APP-QR-LIVE sim deploys public app names and keeps app sessions and storage isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kaist-app-qr-sim-'));
  const appsDir = join(root, 'apps');
  const fakeDeploy = createFakeAppHost([
    { slug: 'voice-notes', versions: [{ id: 'sim-v1', files: { 'index.html': '<main>voice notes</main>' } }] },
    { slug: 'shop-studio', versions: [{ id: 'sim-v1', files: { 'index.html': '<main>shop studio</main>' } }] },
  ]);
  for (const slug of ['voice-notes', 'shop-studio']) {
    fakeDeploy.deploy(slug, 'sim-v1');
    const published = fakeDeploy.fetch(`${slug}.app.sim.invalid`, '/');
    expect(published.status).toBe(200);
    const output = join(appsDir, slug, 'out');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(appsDir, slug, 'app.yaml'), appManifest(slug));
    writeFileSync(join(output, 'index.html'), published.body);
  }

  const loaded = loadNexusAppHost(appsDir, undefined, {
    dir: join(root, 'auth'),
    databaseDirectory: join(root, 'databases'),
    key: 'kaist-app-qr-simulation-key-with-at-least-256-bits',
  }, 'owner');
  const browserStorage = new FakeQrBrowserStorage();
  const voiceUrl = 'https://voice-notes--owner.elanous.app/';
  const shopUrl = 'https://shop-studio--owner.elanous.app/';
  try {
    expect(loaded.issues).toEqual([]);
    expect(resolveFakePublicAppName(voiceUrl)).toEqual({
      appSlug: 'voice-notes', userSlug: 'owner', publicHost: 'voice-notes--owner.elanous.app',
    });
    expect(resolveFakePublicAppName('http://voice-notes--owner.elanous.app/')).toBeUndefined();

    const voiceSession = loaded.appHost.issueOwnerSession('voice-notes', 'member-1');
    const shopSession = loaded.appHost.issueOwnerSession('shop-studio', 'member-1');
    const voiceCookie = `__Host-app-session=${voiceSession.sessionToken}`;
    const shopCookie = `__Host-app-session=${shopSession.sessionToken}`;
    const voicePage = await fetchFakePublicAppQr(loaded.appHost, voiceUrl, { cookie: voiceCookie });
    const shopPage = await fetchFakePublicAppQr(loaded.appHost, shopUrl, { cookie: shopCookie });
    expect(voicePage?.status).toBe(200);
    expect(shopPage?.status).toBe(200);
    expect(await voicePage?.text()).toContain('voice notes');
    expect(await shopPage?.text()).toContain('shop studio');

    const inserted = await fetchFakePublicAppQr(loaded.appHost, `${voiceUrl}__rpc/add`, {
      method: 'POST', cookie: voiceCookie, body: JSON.stringify({ params: { id: 'n1', title: 'private voice note' } }),
    });
    expect(inserted?.status).toBe(200);
    const voiceRows = await fetchFakePublicAppQr(loaded.appHost, `${voiceUrl}__rpc/list`, {
      method: 'POST', cookie: voiceCookie, body: JSON.stringify({ params: {} }),
    });
    expect(await voiceRows?.json()).toEqual({ rows: [{ id: 'n1', title: 'private voice note' }] });
    const shopRows = await fetchFakePublicAppQr(loaded.appHost, `${shopUrl}__rpc/list`, {
      method: 'POST', cookie: shopCookie, body: JSON.stringify({ params: {} }),
    });
    expect(await shopRows?.json()).toEqual({ rows: [] });
    const crossAppCookie = await fetchFakePublicAppQr(loaded.appHost, `${shopUrl}__rpc/list`, {
      method: 'POST', cookie: voiceCookie, body: JSON.stringify({ params: {} }),
    });
    expect(crossAppCookie?.status).toBe(401);

    browserStorage.set(voiceUrl, 'draft', 'voice-only');
    browserStorage.set(shopUrl, 'draft', 'shop-only');
    expect(browserStorage.get(voiceUrl, 'draft')).toBe('voice-only');
    expect(browserStorage.get(shopUrl, 'draft')).toBe('shop-only');
    expect(browserStorage.get('https://other--owner.elanous.app/', 'draft')).toBeUndefined();
  } finally {
    loaded.appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});
