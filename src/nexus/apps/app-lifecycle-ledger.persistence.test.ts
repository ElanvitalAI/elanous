import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createAppLifecycleEvent } from './app-lifecycle-ledger.js';
import { createAppLifecycleStore } from './app-db.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'app-lifecycle-persistence-'));
  const path = join(root, 'lifecycle.sqlite');
  return { root, path };
}
function event(id: string, action: Parameters<typeof createAppLifecycleEvent>[0]['action'], extra: Partial<Parameters<typeof createAppLifecycleEvent>[0]> = {}) {
  return createAppLifecycleEvent({ appId: 'voice-note', action, environment: ['promoted', 'rolled-back', 'paused', 'trashed', 'restored', 'purged'].includes(action) ? 'live' : 'simulation', actor: 'system', ...extra }, {
    id: () => id, now: () => new Date('2026-11-08T00:00:00.000Z'),
  });
}

describe('APP-LIFECYCLE-FU persistence simulation', () => {
  test('commits event and tile projection together and restores both after reopen', () => {
    const { root, path } = fixture();
    try {
      const store = createAppLifecycleStore(path);
      store.appendEvent(event('created-1', 'created', { appVersion: 'v1' }));
      store.appendEvent(event('receipt-1', 'receipt-issued', { receiptId: 'receipt-v1' }));
      store.appendEvent(event('promoted-1', 'promoted', { appVersion: 'v1', receiptId: 'receipt-v1' }));
      const blocked = event('rollback-blocked', 'rolled-back', { outcome: 'blocked', reasonCode: 'permission-denied' });
      store.appendEvent(blocked);
      expect(store.snapshot('voice-note')).toMatchObject({ status: 'live', currentVersion: 'v1', latestReceiptId: 'receipt-v1', eventCount: 4 });
      store.close();

      const reopened = createAppLifecycleStore(path);
      expect(reopened.events('voice-note')).toHaveLength(4);
      expect(reopened.snapshot('voice-note')).toMatchObject({ status: 'live', currentVersion: 'v1', latestEvent: { outcome: 'blocked' } });
      expect(reopened.snapshot('missing-app')).toBeNull();
      reopened.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('serializes independent writers and preserves a single ordered projection', () => {
    const { root, path } = fixture();
    try {
      const first = createAppLifecycleStore(path);
      const second = createAppLifecycleStore(path);
      first.appendEvent(event('created-1', 'created', { appVersion: 'v1' }));
      const append = (store: typeof first, id: string, appVersion: string) => store.appendEvent(event(id, 'promoted', { appVersion }));
      append(first, 'promoted-2', 'v2');
      append(second, 'promoted-3', 'v3');
      expect(first.events('voice-note').map(item => item.id)).toEqual(['created-1', 'promoted-2', 'promoted-3']);
      expect(second.snapshot('voice-note')).toMatchObject({ status: 'live', currentVersion: 'v3', previousVersion: 'v2', eventCount: 3 });
      first.close(); second.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('fails closed when a persisted event row is corrupt', () => {
    const { root, path } = fixture();
    try {
      const store = createAppLifecycleStore(path);
      store.appendEvent(event('created-1', 'created'));
      store.close();
      const raw = new Database(path);
      raw.query('UPDATE app_lifecycle_events SET event_json = ? WHERE event_id = ?').run('{bad-json', 'created-1');
      raw.close();
      const reopened = createAppLifecycleStore(path);
      expect(() => reopened.events('voice-note')).toThrow('app lifecycle ledger is corrupt');
      reopened.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('does not repair a corrupted projection by appending a later event', () => {
    const { root, path } = fixture();
    try {
      const store = createAppLifecycleStore(path);
      store.appendEvent(event('created-1', 'created'));
      store.close();
      const raw = new Database(path);
      raw.query('UPDATE app_lifecycle_snapshots SET snapshot_json = ? WHERE app_id = ?').run('{bad-json', 'voice-note');
      raw.close();
      const reopened = createAppLifecycleStore(path);
      expect(() => reopened.appendEvent(event('promoted-1', 'promoted', { appVersion: 'v2' }))).toThrow('app lifecycle ledger is corrupt');
      expect(() => reopened.view('voice-note')).toThrow('app lifecycle ledger is corrupt');
      reopened.close();
      const verify = new Database(path);
      expect(verify.query('SELECT COUNT(*) AS count FROM app_lifecycle_events').get()).toEqual({ count: 1 });
      verify.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('mount seed remains single under concurrent independent workers', async () => {
    const { root, path } = fixture();
    try {
      const worker = (id: string) => new Promise<void>((resolve, reject) => {
        const child = new Worker(new URL('./app-lifecycle-ledger.race-worker.ts', import.meta.url), { workerData: { path, id } });
        child.once('message', (result: { ok: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error ?? 'worker failed')));
        child.once('error', reject);
      });
      await Promise.all([worker('created-a'), worker('created-b')]);
      const store = createAppLifecycleStore(path);
      expect(store.events('voice-note').filter(item => item.action === 'created' && item.outcome === 'succeeded')).toHaveLength(1);
      expect(store.snapshot('voice-note')).toMatchObject({ status: 'draft', eventCount: 1 });
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
