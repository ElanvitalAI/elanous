// SQLite의 실제 write lock 아래에서 LogStore.insertBatch의 busy 버퍼와 복구를 관측한다.
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';

export interface SqliteBusyObservation {
  readonly busy: boolean;
  readonly beforeRelease: number;
  readonly afterRelease: number;
  readonly events: string[];
}

export function simSqliteBusy(): SqliteBusyObservation {
  const dir = mkdtempSync(join(tmpdir(), 'ux-sim-sqlite-busy-'));
  const path = join(dir, 'logs.db');
  let store: LogStore | undefined;
  let locker: Database | undefined;
  try {
    store = new LogStore(path, { instance: 'ux-sim' });
    locker = new Database(path);
    locker.run('BEGIN IMMEDIATE');
    const rec = (event: string) => ({ rec: { ts: new Date().toISOString(), category: 'ux-sim.sqlite', event }, surface: 'ux-sim' });
    let busy = false;
    try { store.insertBatch([rec('locked')]); }
    catch (error) {
      if (!/SQLITE_BUSY|database is locked/i.test(String(error))) throw error;
      busy = true;
    }
    const beforeRelease = store.count();
    locker.run('ROLLBACK');
    store.insertBatch([rec('recovered')]);
    const events = store.query({ exactCategories: ['ux-sim.sqlite'] }).map((row) => row.event);
    return { busy, beforeRelease, afterRelease: store.count(), events };
  } finally {
    try { locker?.run('ROLLBACK'); } catch { /* transaction already ended */ }
    locker?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderSqliteBusy(result: SqliteBusyObservation): string[] {
  return [
    'sqlite-busy · 실제 SQLite write lock → LogStore.insertBatch 재시도',
    `  SQLite busy=${result.busy} · 잠금 중 행=${result.beforeRelease} · 해제 후 행=${result.afterRelease}`,
    `  복구된 이벤트=${result.events.join(', ')}`,
  ];
}
