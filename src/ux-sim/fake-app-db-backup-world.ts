import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppManifest } from '../nexus/apps/app-contract.js';
import { createAppDatabase, type AppDatabase } from '../nexus/apps/app-db.js';
import { type ObjectHead, type ObjectStore, type StorageProvider } from '../storage/object-store.js';

export class FakeAppDbBackupStore implements ObjectStore {
  readonly provider: StorageProvider = 's3';
  readonly objects = new Map<string, string>();
  failNextPut = false;
  failReads = false;
  failHeads = false;
  headCalls = 0;
  put(key: string, body: string | Uint8Array): void {
    if (this.failNextPut) { this.failNextPut = false; throw new Error('simulated remote store unavailable'); }
    this.objects.set(key, typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
  }
  get(key: string, localPath: string): void {
    if (this.failReads) throw new Error('simulated store read interrupted');
    const body = this.objects.get(key);
    if (body === undefined) throw new Error('simulated object missing');
    writeFileSync(localPath, body, { mode: 0o600 });
  }
  head(key: string): ObjectHead { this.headCalls++; if (this.failHeads) throw new Error('simulated head lookup failure'); return this.objects.has(key) ? { exists: true, bytes: Buffer.byteLength(this.objects.get(key)!) } : { exists: false }; }
  list(prefix: string): string[] { return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort(); }
  delete(key: string): void { this.objects.delete(key); }
  publicUrl(): null { return null; }
}

export interface FakeAppDbBackupWorld {
  readonly root: string;
  readonly targetPath: string;
  readonly store: FakeAppDbBackupStore;
  readonly database: AppDatabase;
  readonly rawArtifacts: () => readonly string[];
  readonly restoreRows: (table: string) => unknown[];
  close(): void;
}

export function createFakeAppDbBackupWorld(
  manifest: AppManifest,
  options: { key?: Uint8Array; historicalKeys?: ReadonlyMap<string, Uint8Array>; now?: () => number; store?: FakeAppDbBackupStore; maxFreshnessMs?: number; schedule?: boolean; snapshotEveryMs?: number; root?: string; beforeRestorePublishForTesting?: (target: string) => void } = {},
): FakeAppDbBackupWorld {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'fake-app-db-backup-'));
  const targetPath = join(root, 'restore', 'restored.db');
  const store = options.store ?? new FakeAppDbBackupStore();
  const database = createAppDatabase([manifest], {
    directory: join(root, 'live'),
    backup: { store, key: options.key, historicalKeys: options.historicalKeys, now: options.now, maxFreshnessMs: options.maxFreshnessMs, schedule: options.schedule ?? false, snapshotEveryMs: options.snapshotEveryMs, beforeRestorePublishForTesting: options.beforeRestorePublishForTesting },
  });
  return {
    root, targetPath, store, database,
    rawArtifacts: () => [...store.objects.values()],
    restoreRows(table) {
      if (!existsSync(targetPath)) throw new Error('restore has not completed');
      const restored = new Database(targetPath);
      try { return restored.query('SELECT * FROM "' + table.replaceAll('"', '""') + '" ORDER BY id').all() as unknown[]; }
      finally { restored.close(); }
    },
    close() { database.close(); },
  };
}
