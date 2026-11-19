import { describe, expect, test } from 'bun:test';
import { WorkerRegistryStore } from './store.js';
import { reportWorkerStateChange } from './els-report.js';

// A failing watch insert simulates disk/constraint failure after the state write.
describe('legacy state and watch transaction', () => {
  test('each mutation rolls back state, generation, revision and notifications on watch failure', () => {
    const store = new WorkerRegistryStore(':memory:', () => new Date('2026-01-01T00:00:00.000Z'));
    try {
      store.upsertHost({ name: 'h', principal: 'one' });
      store.registerWorker({ id: 'w', kind: 'cli', paneId: 'p' });
      const snapshot = store.snapshot();
      const events = store.eventsSince(0);
      const seen: number[] = [];
      store.subscribe(e => seen.push(e.seq));
      store.db.exec("CREATE TRIGGER fail_watch BEFORE INSERT ON worker_watch BEGIN SELECT RAISE(ABORT, 'watch failure'); END");
      for (const op of [
        () => store.registerWorker({ id: 'new', kind: 'cli' }),
        () => store.registerWorker({ id: 'w', kind: 'cli' }),
        () => store.deleteWorker('w'),
        () => store.setActualState('w', 'idle'),
        () => store.upsertHost({ name: 'h', principal: 'two' }),
        () => store.revokeHost('h'),
        () => reportWorkerStateChange(store, { paneId: 'p', eventId: 'e', state: 'done' }),
      ]) {
        expect(op).toThrow('watch failure');
        expect(store.snapshot()).toEqual(snapshot);
        expect(store.eventsSince(0)).toEqual(events);
        expect(seen).toEqual([]);
      }
    } finally { store.close(); }
  });

  test('output insert failure rolls back preceding state event; success emits only after commit', () => {
    const store = new WorkerRegistryStore(':memory:', () => new Date('2026-01-01T00:00:00.000Z'));
    try {
      store.registerWorker({ id: 'w', kind: 'cli', paneId: 'p' });
      const before = store.snapshot();
      const seen: string[] = [];
      const during: boolean[] = [];
      store.subscribe(e => { during.push(store.db.inTransaction); seen.push(e.type); });
      store.db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON worker_watch WHEN NEW.type = 'output' BEGIN SELECT RAISE(ABORT, 'output failure'); END");
      expect(() => reportWorkerStateChange(store, { paneId: 'p', eventId: 'e', state: 'idle' })).toThrow('output failure');
      expect(store.snapshot()).toEqual(before);
      expect(store.eventsSince(before.revision)).toEqual([]);
      expect(seen).toEqual([]);
      store.db.exec('DROP TRIGGER fail_output');
      expect(reportWorkerStateChange(store, { paneId: 'p', eventId: 'e', state: 'idle' })).toBe('w');
      expect(store.getWorker('w')?.actualState).toBe('idle');
      expect(store.eventsSince(before.revision).map(e => e.type)).toEqual(['state', 'output']);
      expect(seen).toEqual(['state', 'output']);
      expect(during).toEqual([false, false]);
    } finally { store.close(); }
  });

  test('external transaction is rejected before any mutation, even if caller catches', () => {
    const store = new WorkerRegistryStore(':memory:', () => new Date('2026-01-01T00:00:00.000Z'));
    try {
      store.registerWorker({ id: 'w', kind: 'cli' });
      const before = store.snapshot();
      store.db.transaction(() => {
        expect(() => store.setActualState('w', 'idle')).toThrow('outer transaction');
        expect(() => store.appendEvent({ workerId: 'w', type: 'output' })).toThrow('outer transaction');
      })();
      expect(store.snapshot()).toEqual(before);
    } finally { store.close(); }
  });
});

describe('clock reentrancy isolation', () => {
  test('caught nested deletion cannot create a stopped event or erase the row', () => {
    let hook: (() => void) | undefined;
    const store = new WorkerRegistryStore(':memory:', () => { hook?.(); return new Date('2026-01-01T00:00:00Z'); });
    try {
      store.registerWorker({ id: 'w', kind: 'cli' });
      const revision = store.currentRevision();
      const errors: string[] = [];
      let calls = 0;
      hook = () => {
        // The second call occurs while appending the state event, after its UPDATE.
        if (++calls === 2) {
          try { store.deleteWorker('w'); } catch (e) { errors.push(String(e)); }
        }
      };
      expect(store.setActualState('w', 'idle')?.actualState).toBe('idle');
      hook = undefined;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('reentrant mutation');
      expect(store.getWorker('w')?.actualState).toBe('idle');
      expect(store.eventsSince(revision).map(e => e.type)).toEqual(['state']);
    } finally { hook = undefined; store.close(); }
  });

  test('uncaught reentry after UPDATE rolls back row, event and notifications', () => {
    let hook: (() => void) | undefined;
    const store = new WorkerRegistryStore(':memory:', () => { hook?.(); return new Date('2026-01-01T00:00:00Z'); });
    try {
      store.registerWorker({ id: 'w', kind: 'cli' });
      const before = store.getWorker('w');
      const revision = store.currentRevision();
      const seen: string[] = [];
      store.subscribe(e => seen.push(e.type));
      let calls = 0;
      hook = () => { if (++calls === 2) store.deleteWorker('w'); };
      expect(() => store.setActualState('w', 'idle')).toThrow('reentrant mutation');
      hook = undefined;
      expect(store.getWorker('w')).toEqual(before);
      expect(store.eventsSince(revision)).toEqual([]);
      expect(seen).toEqual([]);
    } finally { hook = undefined; store.close(); }
  });

  test('clock cannot bypass guard through heartbeat; normal composite report still commits', () => {
    let hook: (() => void) | undefined;
    const store = new WorkerRegistryStore(':memory:', () => { hook?.(); return new Date('2026-01-01T00:00:00Z'); });
    try {
      store.upsertHost({ name: 'h' });
      store.registerWorker({ id: 'w', kind: 'cli', paneId: 'p' });
      const before = store.getHost('h');
      const errors: string[] = [];
      hook = () => { try { store.heartbeatHost('h'); } catch (e) { errors.push(String(e)); } };
      expect(reportWorkerStateChange(store, { paneId: 'p', eventId: 'e', state: 'idle' })).toBe('w');
      hook = undefined;
      const MIN_REENTRANT_REJECTIONS = 1; // 출처: #39073 재진입 감시 계약 — 실측 상한이 아니라 하한(재진입 시도는 최소 1회 거부), 124행 의미 보존
      expect(errors.length).toBeGreaterThanOrEqual(MIN_REENTRANT_REJECTIONS);
      expect(errors.every(e => e.includes('reentrant mutation'))).toBe(true);
      expect(store.getHost('h')).toEqual(before);
      expect(store.eventsSince(0).slice(-2).map(e => e.type)).toEqual(['state', 'output']);
    } finally { hook = undefined; store.close(); }
  });
});

 test('reentrant listener preserves FIFO for all subscribers', () => {
  const store = new WorkerRegistryStore(':memory:');
  try {
    store.registerWorker({ id: 'w', kind: 'cli', paneId: 'p' });
    const got: string[] = [];
    let fired = false;
    store.subscribe(e => { if (!fired && e.type === 'state') { fired = true; store.appendEvent({ workerId: 'w', type: 'steer' }); } });
    store.subscribe(e => got.push(e.type));
    reportWorkerStateChange(store, { paneId: 'p', eventId: 'e', state: 'idle' });
    expect(got).toEqual(['state', 'output', 'steer']);
  } finally { store.close(); }
});
