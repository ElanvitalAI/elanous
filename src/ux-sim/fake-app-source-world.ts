import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createObjectStore, type ObjectStore } from '../storage/object-store.js';
import {
  createAppSourceSnapshot, restoreAppSourceSnapshot,
  type AppSourceLedgerRecord, type AppSourceRestoreResult, type AppSourceSnapshotResult,
} from '../nexus/apps/app-source-snapshot.js';

export interface FakeAppSourceWorld {
  snapshot(input: { appSlug: string; deploymentId: string; sourceRoot: string }): AppSourceSnapshotResult;
  restore(input: { appSlug: string; deploymentId: string; sourceRoot: string; expectedFingerprint: string }): AppSourceRestoreResult;
  tamper(key: string, body: string): void;
  seed(key: string, body: string): void;
  remove(key: string): void;
  read(key: string): string | undefined;
  records(): readonly AppSourceLedgerRecord[];
  close(): void;
}

/** Uses the real local ObjectStore and production snapshot/restore functions, with no cloud CLI or publish side effect. */
export function createFakeAppSourceWorld(rootDir = mkdtempSync(join(tmpdir(), 'ux-sim-app-source-'))): FakeAppSourceWorld {
  const ownsRoot = arguments.length === 0;
  const storageRoot = join(rootDir, 'objects');
  const store: ObjectStore = createObjectStore({ provider: 'local', localDir: storageRoot, bucket: '', publicBucket: '', prefix: 'apps' });
  const records: AppSourceLedgerRecord[] = [];
  const record = (entry: AppSourceLedgerRecord) => { records.push(structuredClone(entry)); };
  const input = (value: { appSlug: string; deploymentId: string; sourceRoot: string }) => ({ ...value, objectStore: store, record });
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('fake app source world is closed'); };

  return {
    snapshot(value) { assertOpen(); return createAppSourceSnapshot(input(value)); },
    restore(value) { assertOpen(); return restoreAppSourceSnapshot({ ...input(value), expectedFingerprint: value.expectedFingerprint }); },
    tamper(key, body) {
      assertOpen();
      const path = join(storageRoot, 'private', ...key.split('/'));
      if (!existsSync(path)) throw new Error('snapshot object is missing');
      writeFileSync(path, body);
    },
    seed(key, body) {
      assertOpen();
      const path = join(storageRoot, 'private', ...key.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    },
    remove(key) {
      assertOpen();
      rmSync(join(storageRoot, 'private', ...key.split('/')), { force: true });
    },
    read(key) {
      assertOpen();
      const path = join(storageRoot, 'private', ...key.split('/'));
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
    records() { return records.map((entry) => structuredClone(entry)); },
    close() { if (closed) return; closed = true; if (ownsRoot) rmSync(rootDir, { recursive: true, force: true }); },
  };
}
