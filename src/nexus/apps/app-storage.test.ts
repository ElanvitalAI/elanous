import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFn, StorageConfig } from '../../storage/object-store.js';
import { parseAppManifest, type AppManifest } from './app-contract.js';
import { createAppStorage } from './app-storage.js';

const STORAGE_SIGNING_KEY = 'test-only-app-storage-signing-key';

function manifest(slug: string, quotaBytes = 5, maxBytes = 5, anonymous = false): AppManifest {
  const parsed = parseAppManifest(`apiVersion: elanous.app/v0
slug: ${slug}
title: Stored files
frontend: { kind: static-export }
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
storage:
  prefix: apps/${slug}/
  quotaBytes: ${quotaBytes}
  upload:
    allow: [owner]
    types: [audio/wav, application/json]
    maxBytes: ${maxBytes}
    anonymous: ${anonymous}
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.manifest;
}

function config(localDir: string, provider: StorageConfig['provider'] = 'local'): StorageConfig {
  return { provider, localDir, bucket: 'private', publicBucket: '', prefix: 'apps', ...(provider === 's3' ? { s3: { region: 'us-east-1' } } : {}) };
}

describe('NEXUS-APP-STORAGE-S1', () => {
  test('uses appObjectKey namespace boundaries and rejects invalid paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-'));
    const storage = createAppStorage([manifest('notes'), manifest('notes-team')], {
      config: config(root), signingKey: 'test-only-app-storage-signing-key',
    });
    const body = new TextEncoder().encode('one');
    try {
      expect(storage.upload({ appSlug: 'notes', key: 'audio/clip.wav', body, contentType: 'audio/wav', role: 'owner' }).status).toBe(201);
      expect(storage.upload({ appSlug: 'notes-team', key: 'audio/clip.wav', body, contentType: 'audio/wav', role: 'owner' }).status).toBe(201);
      expect(storage.read({ appSlug: 'notes', key: 'audio/clip.wav' })).toMatchObject({
        status: 200, body, contentType: 'audio/wav', filename: 'clip.wav',
      });
      expect(storage.read({ appSlug: 'notes-team', key: 'audio/clip.wav' }).body).toEqual(body);
      for (const key of ['../outside.wav', '/etc/passwd', 'apps/other/secret.wav', '..\\outside.wav']) {
        expect(storage.upload({ appSlug: 'notes', key, body, contentType: 'audio/wav', role: 'owner' }).status).toBe(400);
      }
      expect(storage.list('notes')).toEqual({ status: 200, files: ['audio/clip.wav'] });
      expect(existsSync(join(root, 'private', 'apps', 'outside.wav'))).toBe(false);
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('enforces declared upload role, content type, and per-object size limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-'));
    const storage = createAppStorage([manifest('notes')], { config: config(root), signingKey: STORAGE_SIGNING_KEY });
    try {
      expect(storage.upload({ appSlug: 'notes', key: 'x.wav', body: new Uint8Array([1]), contentType: 'audio/wav', role: 'viewer' }).status).toBe(403);
      expect(storage.upload({ appSlug: 'notes', key: 'x.wav', body: new Uint8Array([1]), contentType: 'application/javascript', role: 'owner' }).status).toBe(415);
      expect(storage.upload({ appSlug: 'notes', key: 'x.wav', body: new Uint8Array(6), contentType: 'audio/wav', role: 'owner' }).status).toBe(413);
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('exposes the configured default upload limit when a manifest omits maxBytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-default-limit-'));
    const parsed = parseAppManifest(`apiVersion: elanous.app/v0\nslug: notes\ntitle: Notes\nfrontend: { kind: static-export }\nroles: { owner: {} }\nstorage:\n  prefix: apps/notes/\n  upload: { allow: [owner], types: [audio/wav] }\n`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const storage = createAppStorage([parsed.manifest], { config: config(root), signingKey: STORAGE_SIGNING_KEY, defaultMaxUploadBytes: 12_000_000 });
    try { expect(storage.maxUploadBytes('notes')).toBe(12_000_000); }
    finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('enforces app quota on new objects and overwrites without charging old bytes twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-'));
    const storage = createAppStorage([manifest('notes')], { config: config(root), signingKey: STORAGE_SIGNING_KEY });
    const upload = (key: string, value: string) => storage.upload({
      appSlug: 'notes', key, body: new TextEncoder().encode(value), contentType: 'audio/wav', role: 'owner',
    });
    try {
      expect(upload('clip.wav', 'abc').status).toBe(201);
      expect(upload('clip.wav', '12345').status).toBe(201);
      expect(upload('overflow.wav', 'x').status).toBe(413);
      expect(storage.read({ appSlug: 'notes', key: 'clip.wav' }).body).toEqual(new TextEncoder().encode('12345'));
      expect(storage.read({ appSlug: 'notes', key: 'overflow.wav' }).status).toBe(404);
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('serializes quota accounting across storage instances sharing the quota ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-shared-quota-'));
    const first = createAppStorage([manifest('notes')], { config: config(root), signingKey: STORAGE_SIGNING_KEY });
    const second = createAppStorage([manifest('notes')], { config: config(root), signingKey: STORAGE_SIGNING_KEY });
    const upload = (storage: ReturnType<typeof createAppStorage>, key: string) => storage.upload({
      appSlug: 'notes', key, body: new Uint8Array([1, 2, 3]), contentType: 'audio/wav', role: 'owner',
    });
    try {
      expect(upload(first, 'one.wav').status).toBe(201);
      expect(upload(second, 'two.wav').status).toBe(413);
      expect(second.list('notes')).toEqual({ status: 200, files: ['one.wav'] });
    } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('signs short-lived PUT URLs and rejects tampering, expiry, and method changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-'));
    let time = 1_700_000_000_000;
    const storage = createAppStorage([manifest('notes')], {
      config: config(root), signingKey: STORAGE_SIGNING_KEY, now: () => time,
    });
    try {
      const url = storage.signUploadUrl({ appSlug: 'notes', key: 'audio/signed.wav', expiresInMs: 10, role: 'owner' });
      const input = { url, method: 'PUT', body: new TextEncoder().encode('voice'), contentType: 'audio/wav' };
      expect(storage.uploadSigned(input).status).toBe(201);
      expect(storage.uploadSigned({ ...input, method: 'POST' }).status).toBe(403);
      const tampered = new URL(url);
      tampered.searchParams.set('token', `${tampered.searchParams.get('token')}x`);
      expect(storage.uploadSigned({ ...input, url: tampered.toString() }).status).toBe(403);
      time += 10;
      expect(storage.uploadSigned(input).status).toBe(403);
      expect(() => storage.signUploadUrl({ appSlug: 'notes', key: 'ok.wav', expiresInMs: 15 * 60_000 + 1, role: 'owner' })).toThrow('expiresInMs must be between');
      expect(() => storage.signUploadUrl({ appSlug: 'notes', key: '../escape.wav', expiresInMs: 10, role: 'owner' })).toThrow('invalid app slug or app-relative object key');
      expect(() => storage.signUploadUrl({ appSlug: 'notes', key: 'ok.wav', expiresInMs: 10, role: 'viewer' })).toThrow('app role is not allowed to upload');
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('limits anonymous attempts per app and keeps a body-free observation ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-'));
    let time = 1_700_000_000_000;
    const storage = createAppStorage([manifest('notes', 64, 64, true), manifest('tasks', 64, 64, true)], {
      config: config(root), signingKey: STORAGE_SIGNING_KEY, anonymousUploadsPerMinute: 1, now: () => time,
    });
    const secondInstance = createAppStorage([manifest('notes', 64, 64, true), manifest('tasks', 64, 64, true)], {
      config: config(root), signingKey: STORAGE_SIGNING_KEY, anonymousUploadsPerMinute: 1, now: () => time,
    });
    const body = new TextEncoder().encode('secret recording');
    try {
      expect(storage.upload({ appSlug: 'notes', key: 'one.wav', body, contentType: 'audio/wav', anonymous: true }).status).toBe(201);
      expect(secondInstance.upload({ appSlug: 'notes', key: 'two.wav', body, contentType: 'audio/wav', anonymous: true }).status).toBe(429);
      expect(storage.upload({ appSlug: 'tasks', key: 'one.wav', body, contentType: 'audio/wav', anonymous: true }).status).toBe(201);
      time += 60_001;
      expect(storage.upload({ appSlug: 'notes', key: 'two.wav', body, contentType: 'audio/wav', anonymous: true }).status).toBe(201);
      expect(JSON.stringify(storage.observationLedger())).not.toContain('secret recording');
      expect(storage.observationLedger().at(-1)).toEqual({ appSlug: 'notes', bytes: body.byteLength, status: 201 });
    } finally { storage.close(); secondInstance.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('rejects anonymous uploads unless the manifest explicitly enables them and bounds the ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-'));
    const storage = createAppStorage([manifest('notes', 64, 64)], { config: config(root), signingKey: STORAGE_SIGNING_KEY });
    const body = new Uint8Array([1]);
    try {
      expect(storage.upload({ appSlug: 'notes', key: 'anonymous.wav', body, contentType: 'audio/wav', anonymous: true }).status).toBe(403);
      for (let i = 0; i < 1_005; i += 1) storage.upload({ appSlug: 'notes', key: 'blocked.wav', body, contentType: 'audio/wav', role: 'viewer' });
      expect(storage.observationLedger()).toHaveLength(1_000);
      expect(storage.observationLedger()[0]).toEqual({ appSlug: 'notes', bytes: 0, status: 403 });
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('returns a provider failure from listing instead of hiding it as an empty result', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-list-'));
    const store = {
      provider: 's3' as const,
      put() {}, get() {}, head() { return { exists: false }; }, publicUrl() { return null; },
      list() { throw new Error('503 Service Unavailable'); },
    };
    const storage = createAppStorage([manifest('notes')], {
      config: { ...config(root, 's3'), quotaLedgerPath: join(root, 'shared-quota.sqlite') },
      store, signingKey: STORAGE_SIGNING_KEY,
    });
    try {
      expect(storage.list('notes')).toEqual({ status: 503, reason: 'storage provider list failed', retryable: true });
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('maps fake S3 upload and read failures without making network calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-s3-'));
    const run: RunFn = (_bin, args) => {
      if (args[0] === 's3' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 's3api' && args[1] === 'head-object') throw new Error('404 Not Found');
      if (args[0] === 's3' && args[1] === 'cp') {
        if (args[2] === 's3://private/apps/notes/missing.wav') throw new Error('404 NoSuchKey');
        throw new Error('503 Service Unavailable');
      }
      throw new Error(`unexpected fake command: ${args.join(' ')}`);
    };
    const storage = createAppStorage([manifest('notes')], {
      config: config(root, 's3'), run, signingKey: STORAGE_SIGNING_KEY,
      quotaLedgerPath: join(root, 'shared-quota.sqlite'),
    });
    try {
      const result = storage.upload({ appSlug: 'notes', key: 'generated/result.json', body: new TextEncoder().encode('{}'), contentType: 'application/json', role: 'owner' });
      expect(result).toMatchObject({ status: 503, retryable: true });
      expect(storage.read({ appSlug: 'notes', key: 'missing.wav' })).toMatchObject({ status: 404 });
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('fails closed for remote storage without a shared ledger and stable signing key', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-storage-s3-config-'));
    try {
      expect(() => createAppStorage([manifest('notes')], { config: config(root, 's3'), signingKey: STORAGE_SIGNING_KEY }))
        .toThrow('remote object storage requires a shared quotaLedgerPath for every writer');
      expect(() => createAppStorage([manifest('notes')], {
        config: config(root, 's3'), quotaLedgerPath: join(root, 'shared-quota.sqlite'), signingKey: 'short',
      })).toThrow('signingKey must contain at least 32 bytes');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
