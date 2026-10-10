/**
 * LOGS-RETENTION-WINDOW-1 (2026-10-10) — the size-cap pass of `LogStore.enforceRetention` keeps a floor window.
 *
 * 🩸 prod logs.db kept only ≈2h of rows under the size cap, so evidence for incidents a few hours old read as
 *   «0 rows» twice on 10-10. Rows newer than `minRetainHours` are never size-deleted; when rows outside the floor
 *   are not enough, the pass stops and emits `mss.logging retention-floor-held` once.
 *
 * File-backed tmp DBs only (the size pass measures live pages) — the real ~/.elanous/logs is never touched.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogRecord } from './record.js';
import { LOG_RETENTION_DEFAULTS, LogStore } from './log-store.js';
import { debug } from '../../debug/log.js';

const HOUR = 3_600_000;
const PAD = 'x'.repeat(2000);

function rec(tsMs: number, n: number, pad: string = PAD): LogRecord {
  return { ts: new Date(tsMs).toISOString(), category: 'retention.floor.test', event: 'row', data: { n, pad } };
}

/** `old` rows 30h ago (outside a 24h floor) then `fresh` rows 1h ago (inside), each tagged with its index. */
function seed(store: LogStore, old: number, fresh: number): void {
  const now = Date.now();
  store.insertBatch(Array.from({ length: old }, (_, i) => ({ rec: rec(now - 30 * HOUR + i, i), surface: 'nexus' })));
  store.insertBatch(Array.from({ length: fresh }, (_, i) => ({ rec: rec(now - HOUR + i, old + i), surface: 'nexus' })));
}

function liveMb(store: LogStore): number {
  const db = (store as unknown as { db: { query: (q: string) => { get: () => Record<string, number> } } }).db;
  const page = db.query('PRAGMA page_size').get().page_size;
  const used = db.query('PRAGMA page_count').get().page_count - db.query('PRAGMA freelist_count').get().freelist_count;
  return (used * page) / (1024 * 1024);
}

function remaining(store: LogStore): number[] {
  return store.query({ exactCategories: ['retention.floor.test'], limit: 10_000 })
    .map((row) => (JSON.parse(row.data ?? '{}') as { n: number }).n)
    .sort((a, b) => a - b);
}

function withStore<T>(fn: (store: LogStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'log-store-floor-'));
  const store = new LogStore(join(dir, 'logs.db'));
  try { return fn(store); } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureFloorHeld<T>(fn: () => T): { result: T; held: LogRecord[] } {
  const held: LogRecord[] = [];
  const off = debug.registerSink({
    name: 'retention-floor-test',
    emit: (row) => { if (row.category === 'mss.logging' && row.event === 'retention-floor-held') held.push(row); },
  });
  try { return { result: fn(), held }; } finally { off(); }
}

describe('LogStore size retention floor (LOGS-RETENTION-WINDOW-1)', () => {
  it('defaults the floor to 24h', () => {
    expect(LOG_RETENTION_DEFAULTS.minRetainHours).toBe(24);
  });

  it('(a) over the cap with rows inside and outside the floor → deletes only outside rows, none newer than the floor', () => {
    withStore((store) => {
      seed(store, 300, 100);
      const cap = liveMb(store) * 0.6; // wants ≈40% (≈160 rows) gone — all reachable outside the floor
      const { result, held } = captureFloorHeld(() => store.enforceRetention({ maxAgeDays: 0, maxDbMb: cap, minRetainHours: 24 }));
      expect(result.deletedBySize).toBeGreaterThan(0);
      const left = remaining(store);
      // every fresh row (index ≥ 300) survives; deletions are the oldest outside rows only
      for (let i = 300; i < 400; i++) expect(left).toContain(i);
      expect(left.length).toBe(400 - result.deletedBySize);
      expect(left[0]).toBe(result.deletedBySize);
      expect(held).toHaveLength(0);
    });
  });

  it('(b) rows outside the floor alone are insufficient → stops, keeps every row inside the floor, emits retention-floor-held once', () => {
    withStore((store) => {
      seed(store, 20, 380);
      const cap = liveMb(store) * 0.6; // wants ≈160 rows gone but only 20 are outside the floor
      const { result, held } = captureFloorHeld(() => store.enforceRetention({ maxAgeDays: 0, maxDbMb: cap, minRetainHours: 24 }));
      expect(result.deletedBySize).toBe(20);
      expect(remaining(store)).toEqual(Array.from({ length: 380 }, (_, i) => 20 + i));
      expect(held).toHaveLength(1);
      const data = held[0].data as { totalMb: number; maxTotalMb: number; floorHours: number };
      expect(data.maxTotalMb).toBe(cap);
      expect(data.floorHours).toBe(24);
      expect(data.totalMb).toBeGreaterThan(cap);
    });
  });

  it('(b2) the 50%-capped batch fits outside the floor but the full overshoot does not → still emits retention-floor-held', () => {
    withStore((store) => {
      seed(store, 200, 200);
      const cap = liveMb(store) * 0.1; // batch = 50% = 200 rows = every outside row, yet ≈90% would be needed
      const { result, held } = captureFloorHeld(() => store.enforceRetention({ maxAgeDays: 0, maxDbMb: cap, minRetainHours: 24 }));
      expect(result.deletedBySize).toBe(200);
      expect(remaining(store)).toEqual(Array.from({ length: 200 }, (_, i) => 200 + i));
      expect(held).toHaveLength(1);
    });
  });

  it('(b3) many small rows outside the floor, few large rows inside → judged by bytes, not row count', () => {
    withStore((store) => {
      const now = Date.now();
      store.insertBatch(Array.from({ length: 210 }, (_, i) => ({ rec: rec(now - 30 * HOUR + i, i, 'x'), surface: 'nexus' })));
      store.insertBatch(Array.from({ length: 190 }, (_, i) => ({ rec: rec(now - HOUR + i, 210 + i), surface: 'nexus' })));
      const cap = liveMb(store) * 0.5; // ≈50% of bytes must go — 210 of 400 rows are outside but hold only a sliver of bytes
      const { result, held } = captureFloorHeld(() => store.enforceRetention({ maxAgeDays: 0, maxDbMb: cap, minRetainHours: 24 }));
      expect(result.deletedBySize).toBeLessThanOrEqual(210);
      for (let i = 210; i < 400; i++) expect(remaining(store)).toContain(i);
      expect(held).toHaveLength(1);
    });
  });

  it('a policy without minRetainHours (older config shape) still gets the 24h floor', () => {
    withStore((store) => {
      seed(store, 20, 380);
      const cap = liveMb(store) * 0.6;
      const { result, held } = captureFloorHeld(() => store.enforceRetention({ maxAgeDays: 0, maxDbMb: cap }));
      expect(result.deletedBySize).toBe(20);
      expect(held).toHaveLength(1);
      expect((held[0].data as { floorHours: number }).floorHours).toBe(24);
    });
  });

  it('(c) floor 0 → same deletions as the legacy oldest-first pass (fresh rows included)', () => {
    const run = (policy: { maxAgeDays: number; maxDbMb: number; minRetainHours?: number }): number[] => withStore((store) => {
      seed(store, 20, 380);
      const cap = liveMb(store) * 0.6;
      const { held } = captureFloorHeld(() => store.enforceRetention({ ...policy, maxDbMb: cap }));
      expect(held).toHaveLength(0);
      return remaining(store);
    });
    const floorZero = run({ maxAgeDays: 0, maxDbMb: 1, minRetainHours: 0 });
    // Legacy pass = oldest-first with no floor: it reaches into the fresh rows (index ≥ 20).
    expect(floorZero[0]).toBeGreaterThan(20);
    // Same store state on a second run yields the identical survivor set (deterministic legacy deletion).
    expect(run({ maxAgeDays: 0, maxDbMb: 1, minRetainHours: 0 })).toEqual(floorZero);
    // And it is exactly the newest-N suffix — what `ORDER BY ts_ms ASC LIMIT dropCount` leaves.
    expect(floorZero).toEqual(Array.from({ length: floorZero.length }, (_, i) => 400 - floorZero.length + i));
  });

  it('the age pass is not bounded by the floor', () => {
    withStore((store) => {
      seed(store, 5, 5);
      const r = store.enforceRetention({ maxAgeDays: 1, maxDbMb: 0, minRetainHours: 48 });
      expect(r.deletedByAge).toBe(5);
      expect(remaining(store)).toEqual([5, 6, 7, 8, 9]);
    });
  });
});
