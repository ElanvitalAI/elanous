import { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { APP_DB_BACKUP_SNAPSHOT_MS } from '../nexus/apps/app-db-backup.js';
import { createFakeAppDbBackupWorld, FakeAppDbBackupStore } from './fake-app-db-backup-world.js';

const FIXED_KEY = new Uint8Array(32).fill(37);
function manifest(slug = 'backup-notes') {
  const parsed = parseAppManifest('apiVersion: elanous.app/v0\nslug: ' + slug + '\ntitle: Backup Notes\nfrontend: { kind: static-export }\ntables:\n  notes:\n    columns:\n      id: { type: text, primary: true }\n      title: { type: text }\nroles:\n  owner: { via: nexus-session }\nrpc:\n  add:\n    sql: INSERT INTO notes (id, title) VALUES (:id, :title)\n    params: { id: { type: text }, title: { type: text } }\n    allow: [owner]\n  remove:\n    sql: DELETE FROM notes WHERE id = :id\n    params: { id: { type: text } }\n    allow: [owner]\n  list:\n    sql: SELECT id, title FROM notes ORDER BY id\n    params: {}\n    allow: [owner]\n');
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.manifest;
}

describe('SIM-NEXUS-DB-BACKUP-RESTORE', () => {
  test('writes encrypted initial snapshot and WAL increments, then restores the latest committed rows', () => {
    const world = createFakeAppDbBackupWorld(manifest(), { key: FIXED_KEY });
    try {
      expect(world.database.backupStatus?.('backup-notes')?.state).toBe('healthy');
      world.database.rpc('backup-notes', 'add', { id: '1', title: 'private-row-contents' }, 'owner');
      const artifactPaths = [...world.store.objects.keys()];
      expect(artifactPaths.some(path => path.includes('/snapshot/'))).toBe(true);
      expect(artifactPaths.some(path => path.includes('/wal/'))).toBe(true);
      for (const [path, raw] of world.store.objects) {
        if (path.endsWith("/current.json")) continue;
        expect(JSON.parse(raw).objectRef).toBe(path);
      }
      const serialized = world.rawArtifacts().join('\n');
      expect(serialized).not.toContain('private-row-contents');
      expect(serialized).not.toContain(Buffer.from(FIXED_KEY).toString('hex'));
      world.database.restoreBackup?.('backup-notes', world.targetPath);
      expect(world.restoreRows('notes')).toEqual([{ id: '1', title: 'private-row-contents' }]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('new empty host preserves remote recovery point and restores it to an isolated target', () => {
    const store = new FakeAppDbBackupStore();
    const original = createFakeAppDbBackupWorld(manifest('host-loss'), { key: FIXED_KEY, store });
    original.database.rpc('host-loss', 'add', { id: '1', title: 'survives host loss' }, 'owner');
    const headBefore = store.objects.get('apps/host-loss/db-backups/current.json');
    original.close();
    const replacement = createFakeAppDbBackupWorld(manifest('host-loss'), { key: FIXED_KEY, store });
    try {
      expect(replacement.database.backupStatus?.('host-loss')?.state).toBe('unhealthy');
      expect(store.objects.get('apps/host-loss/db-backups/current.json')).toBe(headBefore);
      replacement.database.restoreBackup?.('host-loss', replacement.targetPath);
      expect(replacement.restoreRows('notes')).toEqual([{ id: '1', title: 'survives host loss' }]);
    } finally { replacement.close(); rmSync(original.root, { recursive: true, force: true }); rmSync(replacement.root, { recursive: true, force: true }); }
  });

  test('recovery-required marker survives replacement-host restart without overwriting remote head', () => {
    const store = new FakeAppDbBackupStore();
    const original = createFakeAppDbBackupWorld(manifest('restart-loss'), { key: FIXED_KEY, store });
    original.database.rpc('restart-loss', 'add', { id: '1', title: 'kept after restart' }, 'owner');
    const headBefore = store.objects.get('apps/restart-loss/db-backups/current.json');
    original.close();
    const replacement = createFakeAppDbBackupWorld(manifest('restart-loss'), { key: FIXED_KEY, store });
    const root = replacement.root;
    replacement.close();
    const restarted = createFakeAppDbBackupWorld(manifest('restart-loss'), { key: FIXED_KEY, store, root });
    try {
      expect(restarted.root).toBe(root);
      const unopenedDb = new Database(join(root, 'live', 'restart-loss.db'));
      try {
        expect(unopenedDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get()).toBeNull();
      } finally { unopenedDb.close(); }
      expect(restarted.database.backupStatus?.('restart-loss')?.state).toBe('unhealthy');
      expect(store.objects.get('apps/restart-loss/db-backups/current.json')).toBe(headBefore);
      expect(() => restarted.database.rpc('restart-loss', 'add', { id: 'blocked', title: 'pending restore' }, 'owner')).toThrow('recovery is pending');
      expect(restarted.database.createBackupSnapshot?.('restart-loss')).toBe(false);
      expect(store.objects.get('apps/restart-loss/db-backups/current.json')).toBe(headBefore);
      restarted.database.restoreBackup?.('restart-loss', restarted.targetPath);
      expect(restarted.restoreRows('notes')).toEqual([{ id: '1', title: 'kept after restart' }]);
    } finally { restarted.close(); rmSync(root, { recursive: true, force: true }); rmSync(original.root, { recursive: true, force: true }); }
  });

  test('pre-creation recovery marker survives a remote-head lookup failure', async () => {
    const store = new FakeAppDbBackupStore();
    const original = createFakeAppDbBackupWorld(manifest('head-failure'), { key: FIXED_KEY, store });
    original.database.rpc('head-failure', 'add', { id: '1', title: 'preserve remote' }, 'owner');
    const headBefore = store.objects.get('apps/head-failure/db-backups/current.json');
    original.close();
    store.failHeads = true;
    const replacement = createFakeAppDbBackupWorld(manifest('head-failure'), { key: FIXED_KEY, store, schedule: true, snapshotEveryMs: 200 });
    const root = replacement.root;
    const marker = join(root, 'live', 'head-failure.db.backup-restore-required');
    expect(existsSync(marker)).toBe(true);
    const startupHeadCalls = store.headCalls;
    const firstDeadline = Date.now() + 1000;
    while (store.headCalls === startupHeadCalls && Date.now() < firstDeadline) await Bun.sleep(10);
    expect(store.headCalls).toBeGreaterThan(startupHeadCalls);
    expect(store.objects.get('apps/head-failure/db-backups/current.json')).toBe(headBefore);
    expect(() => replacement.database.rpc('head-failure', 'add', { id: 'blocked', title: 'no remote head check' }, 'owner')).toThrow('recovery is pending');
    store.failHeads = false;
    const retryHeadCalls = store.headCalls;
    const secondDeadline = Date.now() + 1000;
    while (store.headCalls === retryHeadCalls && Date.now() < secondDeadline) await Bun.sleep(10);
    expect(store.headCalls).toBeGreaterThan(retryHeadCalls);
    expect(store.objects.get('apps/head-failure/db-backups/current.json')).toBe(headBefore);
    replacement.close();
    const restarted = createFakeAppDbBackupWorld(manifest('head-failure'), { key: FIXED_KEY, store, root });
    try {
      expect(restarted.root).toBe(root);
      expect(store.objects.get('apps/head-failure/db-backups/current.json')).toBe(headBefore);
      restarted.database.restoreBackup?.('head-failure', restarted.targetPath);
      expect(restarted.restoreRows('notes')).toEqual([{ id: '1', title: 'preserve remote' }]);
    } finally { restarted.close(); rmSync(root, { recursive: true, force: true }); rmSync(original.root, { recursive: true, force: true }); }
  });

  test('head lookup retry initializes a new database before releasing recovery marker', async () => {
    const store = new FakeAppDbBackupStore();
    store.failHeads = true;
    const world = createFakeAppDbBackupWorld(manifest('head-retry-empty'), { key: FIXED_KEY, store, schedule: true, snapshotEveryMs: 100 });
    const marker = join(world.root, 'live', 'head-retry-empty.db.backup-restore-required');
    try {
      expect(existsSync(marker)).toBe(true);
      expect(() => world.database.rpc('head-retry-empty', 'list', {}, 'owner')).toThrow('recovery is pending');
      const callsBefore = store.headCalls;
      store.failHeads = false;
      const deadline = Date.now() + 1500;
      while (existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
      expect(store.headCalls).toBeGreaterThan(callsBefore);
      expect(existsSync(marker)).toBe(false);
      expect(world.database.rpc('head-retry-empty', 'list', {}, 'owner')).toEqual([]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('restore publication cannot overwrite a target created after the initial absence check', () => {
    let racedPath = '';
    const world = createFakeAppDbBackupWorld(manifest('restore-race'), { key: FIXED_KEY, beforeRestorePublishForTesting(target) {
      racedPath = target;
      writeFileSync(target, 'racer-owned', { flag: 'wx' });
    } });
    try {
      world.database.rpc('restore-race', 'add', { id: '1', title: 'row' }, 'owner');
      expect(() => world.database.restoreBackup?.('restore-race', world.targetPath)).toThrow();
      expect(readFileSync(racedPath, 'utf8')).toBe('racer-owned');
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('head signed by a historical key remains restorable after current-key rotation', () => {
    const store = new FakeAppDbBackupStore();
    const oldWorld = createFakeAppDbBackupWorld(manifest('rotated-key'), { key: FIXED_KEY, store });
    oldWorld.database.rpc('rotated-key', 'add', { id: '1', title: 'old-key row' }, 'owner');
    oldWorld.close();
    const headPath = 'apps/rotated-key/db-backups/current.json';
    const oldHead = JSON.parse(store.objects.get(headPath)!);
    const legacySignature = createHmac('sha256', FIXED_KEY).update(JSON.stringify(['app:rotated-key', oldHead.snapshotId, oldHead.walEndOffset, oldHead.lastWalEventId ?? null, oldHead.updatedAt])).digest('base64url');
    delete oldHead.keyId;
    oldHead.signature = legacySignature;
    store.objects.set(headPath, JSON.stringify(oldHead));
    const oldKeyId = createHash('sha256').update(FIXED_KEY).digest('hex').slice(0, 24);
    const history = new Map([[oldKeyId, FIXED_KEY]]);
    const replacement = createFakeAppDbBackupWorld(manifest('rotated-key'), { key: new Uint8Array(32).fill(99), historicalKeys: history, store });
    try {
      expect(replacement.database.backupStatus?.('rotated-key')?.state).toBe('unhealthy');
      replacement.database.restoreBackup?.('rotated-key', replacement.targetPath);
      expect(replacement.restoreRows('notes')).toEqual([{ id: '1', title: 'old-key row' }]);
    } finally { replacement.close(); rmSync(oldWorld.root, { recursive: true, force: true }); rmSync(replacement.root, { recursive: true, force: true }); }
  });

  test('key ID in the current head resolves through historical credential material', () => {
    const store = new FakeAppDbBackupStore();
    const oldWorld = createFakeAppDbBackupWorld(manifest('rotated-head'), { key: FIXED_KEY, store });
    oldWorld.database.rpc('rotated-head', 'add', { id: '1', title: 'historical head' }, 'owner');
    oldWorld.close();
    const oldKeyId = createHash('sha256').update(FIXED_KEY).digest('hex').slice(0, 24);
    const history = new Map([[oldKeyId, FIXED_KEY]]);
    const replacement = createFakeAppDbBackupWorld(manifest('rotated-head'), { key: new Uint8Array(32).fill(101), historicalKeys: history, store });
    try {
      replacement.database.restoreBackup?.('rotated-head', replacement.targetPath);
      expect(replacement.restoreRows('notes')).toEqual([{ id: '1', title: 'historical head' }]);
    } finally { replacement.close(); rmSync(oldWorld.root, { recursive: true, force: true }); rmSync(replacement.root, { recursive: true, force: true }); }
  });

  test('authenticated envelope metadata rejects altered snapshot identity and checksum', () => {
    for (const field of ['schemaHash', 'plaintextSha256'] as const) {
      const world = createFakeAppDbBackupWorld(manifest('metadata-' + field.toLowerCase()), { key: FIXED_KEY });
      try {
        world.database.rpc('metadata-' + field.toLowerCase(), 'add', { id: '1', title: 'private' }, 'owner');
        const artifact = [...world.store.objects.keys()].find(key => key.includes('/snapshot/'))!;
        const value = JSON.parse(world.store.objects.get(artifact)!);
        value[field] = field === 'schemaHash' ? 'altered-schema' : '0'.repeat(64);
        world.store.objects.set(artifact, JSON.stringify(value));
        expect(() => world.database.restoreBackup?.('metadata-' + field.toLowerCase(), world.targetPath)).toThrow();
      } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
    }
    const world = createFakeAppDbBackupWorld(manifest('metadata-key-id'), { key: FIXED_KEY });
    try {
      world.database.rpc('metadata-key-id', 'add', { id: '1', title: 'private' }, 'owner');
      const artifact = [...world.store.objects.keys()].find(key => key.includes('/snapshot/'))!;
      const value = JSON.parse(world.store.objects.get(artifact)!);
      value.keyId = 'f'.repeat(24);
      world.store.objects.set(artifact, JSON.stringify(value));
      expect(() => world.database.restoreBackup?.('metadata-key-id', world.targetPath)).toThrow('backup key ID is unavailable');
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('multi-CTE INSERT with a later column list captures WAL and restores the row', () => {
    const parsed = parseAppManifest('apiVersion: elanous.app/v0\nslug: cte-column-list\ntitle: Notes\nfrontend: { kind: static-export }\nroles:\n  owner: { via: nexus-session }\ntables:\n  notes:\n    columns:\n      id: { type: text, primary: true }\n      title: { type: text }\nrpc:\n  addWithCtes:\n    sql: WITH a AS (SELECT 1), b(x) AS (SELECT 2) INSERT INTO notes (id, title) VALUES (:id, :title)\n    params: { id: { type: text }, title: { type: text } }\n    allow: [owner]\n');
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const world = createFakeAppDbBackupWorld(parsed.manifest, { key: FIXED_KEY });
    try {
      world.database.rpc('cte-column-list', 'addWithCtes', { id: '1', title: 'captured CTE write' }, 'owner');
      expect([...world.store.objects.keys()].some(key => key.includes('/wal/'))).toBe(true);
      world.database.restoreBackup?.('cte-column-list', world.targetPath);
      expect(world.restoreRows('notes')).toEqual([{ id: '1', title: 'captured CTE write' }]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('SQL write classifier ignores comment markers inside quoted SQL literals', () => {
    const parsed = parseAppManifest('apiVersion: elanous.app/v0\nslug: cte-literal\ntitle: Notes\nfrontend: { kind: static-export }\nroles:\n  owner: { via: nexus-session }\ntables:\n  notes:\n    columns:\n      id: { type: text, primary: true }\n      title: { type: text }\nrpc:\n  addWithCte:\n    sql: WITH x AS (SELECT \'-- not a comment\') INSERT INTO notes (id, title) SELECT :id, :title\n    params: { id: { type: text }, title: { type: text } }\n    allow: [owner]\n');
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const world = createFakeAppDbBackupWorld(parsed.manifest, { key: FIXED_KEY });
    try {
      world.database.rpc('cte-literal', 'addWithCte', { id: '1', title: 'captured' }, 'owner');
      world.database.restoreBackup?.('cte-literal', world.targetPath);
      expect(world.restoreRows('notes')).toEqual([{ id: '1', title: 'captured' }]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('read RPCs skip backup capture and app contract rejects PRAGMA writes', () => {
    const invalid = parseAppManifest('apiVersion: elanous.app/v0\nslug: pragma-write\ntitle: Invalid\nfrontend: { kind: static-export }\nroles:\n  owner: { via: nexus-session }\nrpc:\n  setVersion:\n    sql: PRAGMA user_version = 7\n    params: {}\n    allow: [owner]\n');
    expect(invalid.ok).toBe(false);
    const world = createFakeAppDbBackupWorld(manifest('read-only-capture'), { key: FIXED_KEY });
    try {
      const beforeRead = world.rawArtifacts().length;
      world.database.rpc('read-only-capture', 'list', {}, 'owner');
      expect(world.rawArtifacts()).toHaveLength(beforeRead);
      world.database.rpc('read-only-capture', 'add', { id: '1', title: 'write' }, 'owner');
      expect(world.rawArtifacts().some(raw => JSON.parse(raw).kind === 'wal')).toBe(true);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('restored backup does not resurrect a row deleted after the initial snapshot', () => {
    const world = createFakeAppDbBackupWorld(manifest(), { key: FIXED_KEY });
    try {
      world.database.rpc('backup-notes', 'add', { id: '1', title: 'to-be-deleted' }, 'owner');
      world.database.rpc('backup-notes', 'remove', { id: '1' }, 'owner');
      world.database.restoreBackup?.('backup-notes', world.targetPath);
      expect(world.restoreRows('notes')).toEqual([]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('missing key and local storage fail closed without writing plaintext', () => {
    const missing = createFakeAppDbBackupWorld(manifest('missing-key'), {});
    const local = new FakeAppDbBackupStore();
    Object.defineProperty(local, 'provider', { value: 'local' });
    const localWorld = createFakeAppDbBackupWorld(manifest('local-store'), { key: FIXED_KEY, store: local });
    try {
      expect(missing.database.backupStatus?.('missing-key')?.state).toBe('unhealthy');
      expect(missing.rawArtifacts()).toEqual([]);
      expect(localWorld.database.backupStatus?.('local-store')?.state).toBe('unhealthy');
      expect(localWorld.rawArtifacts()).toEqual([]);
    } finally { missing.close(); localWorld.close(); rmSync(missing.root, { recursive: true, force: true }); rmSync(localWorld.root, { recursive: true, force: true }); }
  });

  test('timer retries failed WAL capture without another RPC', async () => {
    const store = new FakeAppDbBackupStore();
    const world = createFakeAppDbBackupWorld(manifest('wal-retry'), { key: FIXED_KEY, store, schedule: true, snapshotEveryMs: 200 });
    try {
      store.failNextPut = true;
      world.database.rpc('wal-retry', 'add', { id: '1', title: 'retry row' }, 'owner');
      expect([...store.objects.keys()].some(path => path.includes('/wal/'))).toBe(false);
      const deadline = Date.now() + 1000;
      while (![...store.objects.keys()].some(path => path.includes('/wal/')) && Date.now() < deadline) await Bun.sleep(10);
      expect([...store.objects.keys()].some(path => path.includes('/wal/'))).toBe(true);
      world.database.restoreBackup?.('wal-retry', world.targetPath);
      expect(world.restoreRows('notes')).toEqual([{ id: '1', title: 'retry row' }]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('fresh database remains usable when initial retention cleanup fails after head publication', () => {
    const store = new FakeAppDbBackupStore();
    store.failReads = true;
    const world = createFakeAppDbBackupWorld(manifest('retention-startup-failure'), { key: FIXED_KEY, store });
    const root = world.root;
    try {
      expect(world.database.backupStatus?.('retention-startup-failure')?.state).toBe('unhealthy');
      world.database.rpc('retention-startup-failure', 'add', { id: '1', title: 'available after retention failure' }, 'owner');
    } finally { world.close(); }
    store.failReads = false;
    const restarted = createFakeAppDbBackupWorld(manifest('retention-startup-failure'), { key: FIXED_KEY, store, root });
    try {
      expect(() => restarted.database.rpc('retention-startup-failure', 'list', {}, 'owner')).not.toThrow();
      restarted.database.rpc('retention-startup-failure', 'add', { id: '2', title: 'still available' }, 'owner');
    } finally { restarted.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('store outage marks freshness unhealthy and a later full snapshot can recover', () => {
    const store = new FakeAppDbBackupStore();
    let now = Date.UTC(2026, 10, 8);
    const world = createFakeAppDbBackupWorld(manifest('store-failure'), { key: FIXED_KEY, now: () => now, store });
    try {
      store.failNextPut = true;
      world.database.rpc('store-failure', 'add', { id: '1', title: 'durable locally' }, 'owner');
      expect(world.database.backupStatus?.('store-failure')?.state).toBe('unhealthy');
      now += 60_000;
      expect(world.database.createBackupSnapshot?.('store-failure')).toBe(true);
      expect(world.database.backupStatus?.('store-failure')?.state).toBe('healthy');
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('corrupt snapshot or missing WAL segment fails restore without exposing a partial target', () => {
    const world = createFakeAppDbBackupWorld(manifest('corrupt-backup'), { key: FIXED_KEY });
    try {
      world.database.rpc('corrupt-backup', 'add', { id: '1', title: 'before' }, 'owner');
      world.database.rpc('corrupt-backup', 'add', { id: '2', title: 'after' }, 'owner');
      const artifact = [...world.store.objects.keys()].find(key => key.includes('/wal/'));
      if (artifact) {
        const value = JSON.parse(world.store.objects.get(artifact)!);
        value.ciphertext = value.ciphertext.slice(0, -2) + 'AA';
        world.store.objects.set(artifact, JSON.stringify(value));
        expect(() => world.database.restoreBackup?.('corrupt-backup', world.targetPath)).toThrow();
      } else {
        const snapshot = [...world.store.objects.keys()].find(key => key.includes('/snapshot/'))!;
        world.store.objects.delete(snapshot);
        expect(() => world.database.restoreBackup?.('corrupt-backup', world.targetPath)).toThrow();
      }
      expect(() => world.restoreRows('notes')).toThrow('restore has not completed');
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('freshness age turns unhealthy and retention deletes complete expired snapshot chains', () => {
    let now = Date.UTC(2026, 10, 8);
    const store = new FakeAppDbBackupStore();
    const world = createFakeAppDbBackupWorld(manifest('retention'), { key: FIXED_KEY, now: () => now, store, maxFreshnessMs: APP_DB_BACKUP_SNAPSHOT_MS });
    try {
      expect(world.database.backupStatus?.('retention')?.state).toBe('healthy');
      now += APP_DB_BACKUP_SNAPSHOT_MS + 1;
      expect(world.database.backupStatus?.('retention')?.state).toBe('unhealthy');
      now += 31 * 24 * 60 * 60 * 1000;
      expect(world.database.createBackupSnapshot?.('retention')).toBe(true);
      expect(store.list('apps/retention/db-backups/').some(key => JSON.parse(store.objects.get(key)!).createdAt < new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString())).toBe(false);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('retention refuses to delete artifacts with unauthenticated age or chain metadata', () => {
    const store = new FakeAppDbBackupStore();
    const world = createFakeAppDbBackupWorld(manifest('retention-tamper'), { key: FIXED_KEY, store });
    try {
      world.database.rpc('retention-tamper', 'add', { id: '1', title: 'keep recovery' }, 'owner');
      const artifactPath = [...store.objects.keys()].find(path => path.includes('/snapshot/'))!;
      const envelope = JSON.parse(store.objects.get(artifactPath)!);
      envelope.createdAt = '2000-01-01T00:00:00.000Z';
      store.objects.set(artifactPath, JSON.stringify(envelope));
      world.database.createBackupSnapshot?.('retention-tamper');
      expect(store.objects.has(artifactPath)).toBe(true);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('retention keeps fresh WAL and its expired snapshot dependency', () => {
    const store = new FakeAppDbBackupStore();
    let now = Date.UTC(2026, 10, 1);
    const world = createFakeAppDbBackupWorld(manifest('retention-dependency'), { key: FIXED_KEY, now: () => now, store });
    try {
      const base = [...store.objects.keys()].find(path => path.includes('/snapshot/'))!;
      now += 31 * 24 * 60 * 60 * 1000;
      world.database.rpc('retention-dependency', 'add', { id: 'recent', title: 'recent WAL' }, 'owner');
      expect([...store.objects.keys()].some(path => path.includes('/wal/'))).toBe(true);
      const oldHead = store.objects.get('apps/retention-dependency/db-backups/current.json')!;
      expect(world.database.createBackupSnapshot?.('retention-dependency')).toBe(true);
      expect(store.objects.has(base)).toBe(true);
      store.objects.set('apps/retention-dependency/db-backups/current.json', oldHead);
      world.database.restoreBackup?.('retention-dependency', world.targetPath);
      expect(world.restoreRows('notes')).toEqual([{ id: 'recent', title: 'recent WAL' }]);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('interrupted restore keeps the requested path absent', () => {
    const store = new FakeAppDbBackupStore();
    const world = createFakeAppDbBackupWorld(manifest('interrupted'), { key: FIXED_KEY, store });
    try {
      world.database.rpc('interrupted', 'add', { id: '1', title: 'row' }, 'owner');
      store.failReads = true;
      expect(() => world.database.restoreBackup?.('interrupted', world.targetPath)).toThrow();
      expect(() => world.restoreRows('notes')).toThrow('restore has not completed');
      expect(store.list('apps/interrupted/db-backups/')).toHaveLength(3);
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });

  test('restore uses a distinct empty path and never overwrites the live database', () => {
    const world = createFakeAppDbBackupWorld(manifest('isolated'), { key: FIXED_KEY });
    try {
      world.database.rpc('isolated', 'add', { id: '1', title: 'preserved' }, 'owner');
      const dbPath = join(world.root, 'live', 'isolated.db');
      expect(() => world.database.restoreBackup?.('isolated', dbPath)).toThrow('separate, empty path');
      const live = new Database(dbPath);
      try { expect(live.query('SELECT title FROM notes').all()).toEqual([{ title: 'preserved' }]); }
      finally { live.close(); }
    } finally { world.close(); rmSync(world.root, { recursive: true, force: true }); }
  });
});
