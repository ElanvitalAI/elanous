import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogInstanceView } from '../../mss/logging/instance-registry.js';
import type { LogStore } from '../../mss/logging/log-store.js';
import { scanStoresForRun } from './trace-run-scan.js';

function view(name: string, dbPath: string): LogInstanceView {
  return { name, dbPath, dbExists: true, stateDir: dbPath, configDir: dbPath,
    pid: 0, startedAt: '', alive: false, liveness: 'dead', stateDirCount: 1,
    ambiguous: false, kind: 'test' };
}

describe('scanStoresForRun', () => {
  it('visits the newest database first, queries exactly one run row with its time window, and closes the handle', () => {
    const root = mkdtempSync(join(tmpdir(), 'trace-run-scan-'));
    try {
      const older = join(root, 'older.db');
      const newer = join(root, 'newer.db');
      writeFileSync(older, ''); writeFileSync(newer, '');
      utimesSync(older, new Date(1000), new Date(1000));
      utimesSync(newer, new Date(2000), new Date(2000));
      const visited: string[] = [];
      const closed: string[] = [];
      const queries: Array<{ run: string; q: object }> = [];
      const open = (v: LogInstanceView) => {
        visited.push(v.name);
        return { queryTraceRun: (run: string, q: object) => {
          queries.push({ run, q });
          return v.name === 'newer' ? [{}] : [];
        }, close: () => { closed.push(v.name); } } as unknown as LogStore;
      };
      expect(scanStoresForRun('run-a', [view('older', older), view('newer', newer)], open,
        { sinceMs: 10, untilMs: 20, now: () => 0 })).toEqual({ universe: 'newer', checked: 1, truncated: false });
      expect(visited).toEqual(['newer']);
      expect(queries).toEqual([{ run: 'run-a', q: { sinceMs: 10, untilMs: 20, limit: 1 } }]);
      expect(closed).toEqual(['newer']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('distinguishes a complete miss from a maxStores bound and skips a failed open', () => {
    const views = [view('a-failed', '/nonexistent/fail'), view('b-empty', '/nonexistent/empty'), view('c-found', '/nonexistent/found')];
    const visited: string[] = [];
    const open = (v: LogInstanceView) => {
      visited.push(v.name);
      if (v.name === 'a-failed') throw new Error('unreadable');
      return { queryTraceRun: () => v.name === 'c-found' ? [{}] : [], close: () => {} } as unknown as LogStore;
    };
    expect(scanStoresForRun('run-a', views, open, { maxStores: 2, now: () => 0 })).toEqual({ checked: 2, truncated: true });
    expect(visited).toEqual(['a-failed', 'b-empty']);
    visited.length = 0;
    expect(scanStoresForRun('run-a', views, open, { now: () => 0 })).toEqual({ universe: 'c-found', checked: 3, truncated: false });
    expect(visited).toEqual(['a-failed', 'b-empty', 'c-found']);
    expect(scanStoresForRun('absent', [views[1]!], () => ({ queryTraceRun: () => [], close: () => {} }) as unknown as LogStore,
      { now: () => 0 })).toEqual({ checked: 1, truncated: false });
    expect(scanStoresForRun('absent', [{ ...views[1]!, dbExists: false }], () => {
      throw new Error('must not open a missing database');
    }, { now: () => 0 })).toEqual({ checked: 1, truncated: false });
    expect(scanStoresForRun('absent', [views[0]!], open, { now: () => 0 }))
      .toEqual({ checked: 1, truncated: false, unresolved: true });
    expect(scanStoresForRun('absent', [views[1]!], () => null, { now: () => 0 }))
      .toEqual({ checked: 1, truncated: false, unresolved: true });
    expect(scanStoresForRun('absent', [views[1]!], () => ({
      queryTraceRun: () => { throw new Error('read failed'); }, close: () => {},
    }) as unknown as LogStore, { now: () => 0 }))
      .toEqual({ checked: 1, truncated: false, unresolved: true });
  });

  it('uses the default 200-store cap rather than trying the 201st store', () => {
    const views = Array.from({ length: 201 }, (_, index) => view(`store-${index}`, `/missing/${index}`));
    let opened = 0;
    expect(scanStoresForRun('run-a', views, () => {
      opened++;
      return { queryTraceRun: () => [], close: () => {} } as unknown as LogStore;
    }, { now: () => 0 })).toEqual({ checked: 200, truncated: true });
    expect(opened).toBe(200);
  });

  it('never opens a new store once the deadline has elapsed', () => {
    const views = [view('one', '/absent/one'), view('two', '/absent/two')];
    const visited: string[] = [];
    let clock = 0;
    expect(scanStoresForRun('run-a', views, (v) => {
      visited.push(v.name);
      clock = 3;
      return { queryTraceRun: () => [], close: () => {} } as unknown as LogStore;
    }, { deadlineMs: 3, now: () => clock })).toEqual({ checked: 1, truncated: true });
    expect(visited).toEqual(['one']);
    expect(scanStoresForRun('run-a', views, () => { throw new Error('opened after deadline'); },
      { deadlineMs: 0, now: () => 0 })).toEqual({ checked: 0, truncated: true });
  });
});
