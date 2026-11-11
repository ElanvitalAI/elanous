import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { createAppStorage } from '../nexus/apps/app-storage.js';
import { createObjectStore, type StorageConfig } from '../storage/object-store.js';

const KEY = 'app-web-drive-delete-test-signing-key-256-bit';

function manifest(slug: string) {
  const parsed = parseAppManifest(`apiVersion: elanous.app/v0\nslug: ${slug}\ntitle: Web Drive\nfrontend: { kind: static-export }\nroles: { owner: {}, viewer: {} }\nstorage:\n  prefix: apps/${slug}/\n  quotaBytes: 5\n  upload:\n    allow: [owner]\n    types: [text/plain]\n    maxBytes: 5\n`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.manifest;
}

test('APP-WEB-DRIVE local object world: owner removes one file and recovers quota without crossing app boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-web-drive-delete-'));
  const config: StorageConfig = { provider: 'local', localDir: join(root, 'objects'), bucket: 'private', publicBucket: '', prefix: 'apps' };
  const storage = createAppStorage([manifest('drive-a'), manifest('drive-b')], { config, signingKey: KEY });
  const remove = storage.delete;
  if (!remove) throw new Error('web drive removal is unavailable');
  const body = new TextEncoder().encode('12345');
  try {
    expect(storage.upload({ appSlug: 'drive-a', key: 'files/note.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
    expect(storage.upload({ appSlug: 'drive-b', key: 'files/note.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'viewer' }).status).toBe(403);
    expect(remove({ appSlug: 'drive-a', key: 'apps/drive-b/files/note.txt', role: 'owner' }).status).toBe(400);
    expect(remove({ appSlug: 'drive-a', key: '../drive-b/files/note.txt', role: 'owner' }).status).toBe(400);
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(200);
    expect(storage.list('drive-a')).toEqual({ status: 200, files: [] });
    expect(storage.list('drive-b')).toEqual({ status: 200, files: ['files/note.txt'] });
    expect(storage.read({ appSlug: 'drive-b', key: 'files/note.txt' })).toMatchObject({ status: 200, body });
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(404);
    expect(storage.upload({ appSlug: 'drive-a', key: 'files/new.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
    expect(storage.observationLedger().every(row => !('body' in row) && !('key' in row))).toBe(true);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('APP-WEB-DRIVE retry repairs the quota row after provider deletion succeeds but its response is lost', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-web-drive-delete-retry-'));
  const config: StorageConfig = { provider: 'local', localDir: join(root, 'objects'), bucket: 'private', publicBucket: '', prefix: 'apps' };
  const provider = createObjectStore(config);
  let loseDeleteResponse = true;
  const storage = createAppStorage([manifest('drive-a')], { config, signingKey: KEY,
    store: { ...provider, delete(key) {
      provider.delete(key);
      if (loseDeleteResponse) { loseDeleteResponse = false; throw new Error('simulated lost delete response'); }
    } } });
  const remove = storage.delete;
  if (!remove) throw new Error('web drive removal is unavailable');
  const body = new TextEncoder().encode('12345');
  try {
    expect(storage.upload({ appSlug: 'drive-a', key: 'files/note.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(500);
    expect(storage.list('drive-a')).toEqual({ status: 200, files: [] });
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(200);
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(404);
    expect(storage.upload({ appSlug: 'drive-a', key: 'files/new.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('APP-WEB-DRIVE retry repairs the quota row after the ledger rejects the post-delete commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-web-drive-ledger-fault-'));
  const config: StorageConfig = { provider: 'local', localDir: join(root, 'objects'), bucket: 'private', publicBucket: '', prefix: 'apps' };
  const quotaLedgerPath = join(root, 'quota.sqlite');
  const storage = createAppStorage([manifest('drive-a')], { config, quotaLedgerPath, signingKey: KEY });
  const remove = storage.delete;
  if (!remove) throw new Error('web drive removal is unavailable');
  const body = new TextEncoder().encode('12345');
  const db = new Database(quotaLedgerPath);
  try {
    expect(storage.upload({ appSlug: 'drive-a', key: 'files/note.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
    db.exec("CREATE TRIGGER fail_usage_delete BEFORE DELETE ON app_storage_usage BEGIN SELECT RAISE(ABORT, 'simulated ledger fault'); END");
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(500);
    expect(storage.list('drive-a')).toEqual({ status: 200, files: [] });
    expect(db.query('SELECT COUNT(*) AS count FROM app_storage_usage WHERE app_slug = ?').get('drive-a')).toEqual({ count: 1 });
    db.exec('DROP TRIGGER fail_usage_delete');
    expect(remove({ appSlug: 'drive-a', key: 'files/note.txt', role: 'owner' }).status).toBe(200);
    expect(db.query('SELECT COUNT(*) AS count FROM app_storage_usage WHERE app_slug = ?').get('drive-a')).toEqual({ count: 0 });
    expect(storage.upload({ appSlug: 'drive-a', key: 'files/new.txt', body, contentType: 'text/plain', role: 'owner' }).status).toBe(201);
  } finally {
    db.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
