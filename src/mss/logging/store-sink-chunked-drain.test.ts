import { describe, expect, it } from 'bun:test';
import type { DebugBatchScheduler } from '../../debug/batch-queue.js';
import { LogStore, StoreSink, TUI_LOG_STORE_DRAIN_CHUNK_ROWS, logStoreDrainChunkForSurface } from './log-store.js';
import type { LogRecord } from './record.js';

function rec(event: string): LogRecord {
  return { ts: new Date().toISOString(), category: 'worker.stream', event };
}

function manualScheduler(): DebugBatchScheduler & { runNext(): boolean; size(): number } {
  let next = 1;
  let tasks: Array<{ handle: number; run: () => void; delayMs: number }> = [];
  return {
    schedule(run, delayMs) { const handle = next++; tasks.push({ handle, run, delayMs }); return handle; },
    cancel(handle) { tasks = tasks.filter((task) => task.handle !== handle); },
    runNext() {
      // immediate (delay 0) drain ticks run before interval timers
      tasks.sort((a, b) => a.delayMs - b.delayMs || a.handle - b.handle);
      const task = tasks.shift();
      if (!task) return false;
      task.run();
      return true;
    },
    size: () => tasks.length,
  };
}

describe('StoreSink — worker log burst drains in bounded chunks (TUI-TYPING-LAG)', () => {
  it('only the TUI surface opts into chunked drain; CLI/daemon keep the single-tick drain', () => {
    expect(logStoreDrainChunkForSurface('tui')).toBe(TUI_LOG_STORE_DRAIN_CHUNK_ROWS);
    expect(logStoreDrainChunkForSurface('cli')).toBeUndefined();
    expect(logStoreDrainChunkForSurface('nexus')).toBeUndefined();
  });

  it('a burst beyond the batch threshold inserts at most drainChunkSize rows per tick', () => {
    const store = new LogStore(':memory:');
    const scheduler = manualScheduler();
    const sink = new StoreSink(store, 'dashboard', {
      drainChunkSize: 10,
      flushBatchSize: 10,
      flushIntervalMs: 60_000,
      installExitHandlers: false,
      scheduler,
    });
    for (let i = 0; i < 35; i += 1) sink.emit(rec(`e${i}`));
    expect(store.count()).toBe(0); // nothing inserted on the emit stack
    scheduler.runNext();
    expect(store.count()).toBe(10);
    scheduler.runNext();
    expect(store.count()).toBe(20);
    scheduler.runNext();
    scheduler.runNext();
    expect(store.count()).toBe(35);
    expect(sink.pending).toBe(0);
    store.close();
  });

  it('default (no drainChunkSize) keeps the pre-fix single-tick drain', () => {
    const store = new LogStore(':memory:');
    const scheduler = manualScheduler();
    const sink = new StoreSink(store, 'dashboard', {
      flushBatchSize: 10,
      flushIntervalMs: 60_000,
      installExitHandlers: false,
      scheduler,
    });
    for (let i = 0; i < 35; i += 1) sink.emit(rec(`e${i}`));
    scheduler.runNext();
    expect(store.count()).toBe(35);
    store.close();
  });

  it('a failed chunk stops chunking — the remainder waits for one interval flush instead of blocking every tick', () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const inserted: number[] = [];
    const store = {
      insertBatch(rows: Array<{ rec: LogRecord }>) {
        calls += 1;
        if (calls === 1) throw new Error('SQLITE_BUSY: database is locked');
        inserted.push(rows.length);
      },
    } as unknown as LogStore;
    const sink = new StoreSink(store, 'tui', {
      drainChunkSize: 10, flushBatchSize: 10, flushIntervalMs: 200, installExitHandlers: false, scheduler,
    });
    for (let i = 0; i < 35; i += 1) sink.emit(rec(`e${i}`));
    scheduler.runNext(); // first chunk fails
    expect(sink.dropped.flushFailure).toBe(10);
    expect(scheduler.size()).toBe(1); // only the interval flush is armed — no chunk tick
    scheduler.runNext();
    expect(inserted).toEqual([25]);
    expect(sink.pending).toBe(0);
  });

  it('a log burst that keeps coming after a failed chunk does not re-arm chunk ticks until an insert succeeds', () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const inserted: number[] = [];
    const store = {
      insertBatch(rows: Array<{ rec: LogRecord }>) {
        calls += 1;
        if (calls === 1) throw new Error('SQLITE_BUSY: database is locked');
        inserted.push(rows.length);
      },
    } as unknown as LogStore;
    const sink = new StoreSink(store, 'tui', {
      drainChunkSize: 10, flushBatchSize: 10, flushIntervalMs: 200, installExitHandlers: false, scheduler,
    });
    for (let i = 0; i < 35; i += 1) sink.emit(rec(`a${i}`));
    scheduler.runNext(); // first chunk fails → chunking paused
    for (let i = 0; i < 30; i += 1) sink.emit(rec(`b${i}`)); // burst continues past the threshold
    expect(scheduler.size()).toBe(1); // still only the interval flush — no per-tick busy wait
    expect(calls).toBe(1);
    scheduler.runNext(); // interval flush succeeds → one insert for everything left
    expect(inserted).toEqual([55]);
    expect(sink.pending).toBe(0);
    for (let i = 0; i < 25; i += 1) sink.emit(rec(`c${i}`)); // recovered → chunked again
    scheduler.runNext();
    expect(inserted).toEqual([55, 10]);
  });

  it('sync flush() still drains everything (exit path unchanged)', () => {
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'dashboard', {
      flushBatchSize: 10,
      flushIntervalMs: 60_000,
      installExitHandlers: false,
      scheduler: manualScheduler(),
      drainChunkSize: 10,
    });
    for (let i = 0; i < 35; i += 1) sink.emit(rec(`e${i}`));
    sink.flush();
    expect(store.count()).toBe(35);
    expect(sink.pending).toBe(0);
    store.close();
  });
});
