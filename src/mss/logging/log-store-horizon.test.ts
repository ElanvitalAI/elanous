import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LogStore } from './log-store.js';

describe('LogStore.horizon', () => {
  it('returns empty for a store with no rows and present for the minimum ts_ms regardless of insertion order', () => {
    const store = new LogStore(':memory:');
    try {
      expect(store.horizon()).toEqual({ status: 'empty' });
      store.insertBatch([
        { rec: { ts: '2026-10-09T12:00:00.000Z', category: 'test', event: 'later' }, surface: 'nexus' },
        { rec: { ts: '2026-10-09T10:00:00.000Z', category: 'test', event: 'earlier' }, surface: 'pwa' },
        { rec: { ts: '2026-10-09T11:00:00.000Z', category: 'test', event: 'middle' }, surface: 'nexus' },
      ]);
      expect(store.horizon()).toEqual({ status: 'present', oldestTsMs: Date.parse('2026-10-09T10:00:00.000Z') });
      expect(store.count()).toBe(3);
    } finally {
      store.close();
    }
  });

  it('reads empty and present from read-only opens without changing stored rows or database bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-horizon-'));
    const path = join(dir, 'logs.db');
    try {
      const writer = new LogStore(path);
      writer.close();
      const assertUnchanged = (expected: ReturnType<LogStore['horizon']>, count: number): void => {
        const before = readFileSync(path);
        const reader = LogStore.openReadOnly(path);
        try {
          expect(reader.readonly).toBe(true);
          expect(reader.horizon()).toEqual(expected);
          expect(reader.horizon()).toEqual(expected);
          expect(reader.count()).toBe(count);
        } finally {
          reader.close();
        }
        expect(readFileSync(path)).toEqual(before);
      };
      assertUnchanged({ status: 'empty' }, 0);

      const populated = new LogStore(path);
      try {
        populated.insertBatch([{
          rec: { ts: '2026-10-09T10:00:00.000Z', category: 'test', event: 'persisted' },
          surface: 'nexus',
        }]);
      } finally {
        populated.close();
      }
      assertUnchanged({ status: 'present', oldestTsMs: Date.parse('2026-10-09T10:00:00.000Z') }, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
