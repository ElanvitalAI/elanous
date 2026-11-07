import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { parseAppManifest, type AppManifest } from './app-contract.js';
import { createAppStorageRoute } from './app-storage-route.js';
import { createAppStorage } from './app-storage.js';
import type { StorageConfig } from '../../storage/object-store.js';

const SIGNING_KEY = 'nexus-app-storage-route-test-signing-key-256-bit';

function storageManifest(slug = 'voice-note'): AppManifest {
  const parsed = parseAppManifest(`apiVersion: elanous.app/v0\nslug: ${slug}\ntitle: ${slug}\nfrontend: { kind: static-export }\nroles: { owner: {} }\nstorage:\n  prefix: apps/${slug}/\n  quotaBytes: 1024\n  upload:\n    allow: [owner]\n    types: [audio/wav]\n    maxBytes: 512\n`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.manifest;
}

function config(root: string): StorageConfig {
  return { provider: 'local', localDir: join(root, 'objects'), bucket: 'private', publicBucket: '', prefix: 'apps' };
}

test('registered storage route signs an upload then serves upload, list, and read through the shared route handler', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-storage-route-'));
  const manifest = storageManifest();
  const otherManifest = storageManifest('other-app');
  const manifests = [manifest, otherManifest];
  const storage = createAppStorage(manifests, { config: config(root), signingKey: SIGNING_KEY });
  const route = createAppStorageRoute({
    storage,
    getManifest: slug => manifests.find(candidate => candidate.slug === slug),
    authorize: request => request.headers.get('authorization') === 'Bearer owner-token',
  });
  const ownerHeaders = { authorization: 'Bearer owner-token' };
  try {
    const unauthorized = await route(new Request('http://nexus.invalid/v1/apps/voice-note/storage'));
    expect(unauthorized?.status).toBe(401);

    const signed = await route(new Request('http://nexus.invalid/v1/apps/voice-note/storage/uploads', {
      method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'audio/entry.wav', expiresInMs: 60_000 }),
    }));
    expect(signed?.status).toBe(200);
    const signedUrl = (await signed!.json() as { url: string }).url;
    expect(new URL(signedUrl).pathname).toBe('/_app-storage/voice-note/audio/entry.wav');

    const foreignOriginUrl = new URL(signedUrl);
    foreignOriginUrl.host = 'attacker.invalid';
    expect((await route(new Request(foreignOriginUrl, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([9]) })))?.status).toBe(403);

    const otherAppUrl = new URL(signedUrl);
    otherAppUrl.pathname = otherAppUrl.pathname.replace('/voice-note/', '/other-app/');
    expect((await route(new Request(otherAppUrl, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([9]) })))?.status).toBe(403);

    const bytes = new Uint8Array([1, 2, 3]);
    const uploaded = await route(new Request(signedUrl, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: bytes }));
    expect(uploaded?.status).toBe(201);

    const listed = await route(new Request('http://nexus.invalid/v1/apps/voice-note/storage', { headers: ownerHeaders }));
    expect(await listed?.json()).toEqual({ files: ['audio/entry.wav'] });

    const read = await route(new Request('http://nexus.invalid/v1/apps/voice-note/storage?key=audio%2Fentry.wav', { headers: ownerHeaders }));
    expect(read?.status).toBe(200);
    expect(read?.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(bytes);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('storage route returns bounded and fail-closed results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-storage-route-failures-'));
  const manifest = storageManifest();
  const storage = createAppStorage([manifest], { config: config(root), signingKey: SIGNING_KEY });
  const route = createAppStorageRoute({
    storage,
    getManifest: slug => slug === manifest.slug ? manifest : undefined,
    authorize: () => true,
  });
  try {
    expect((await route(new Request('http://nexus.invalid/v1/apps/unknown/storage')))?.status).toBe(404);
    expect((await route(new Request('http://nexus.invalid/v1/apps/voice-note/storage/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })))?.status).toBe(400);
    expect((await route(new Request('http://nexus.invalid/v1/apps/voice-note/storage/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'ok.wav', expiresInMs: 60_000, extra: true }),
    })))?.status).toBe(400);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
