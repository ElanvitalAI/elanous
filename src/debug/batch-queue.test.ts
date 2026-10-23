import { describe, expect, test } from 'bun:test';
import { DebugLogBatchQueue, type DebugBatchScheduler } from './batch-queue.js';

function manualScheduler(): DebugBatchScheduler & { runNext(): boolean; size(): number } {
  let next = 1;
  let tasks: Array<{ handle: number; run: () => void }> = [];
  return {
    schedule(run) {
      const handle = next++;
      tasks.push({ handle, run });
      return handle;
    },
    cancel(handle) {
      tasks = tasks.filter((task) => task.handle !== handle);
    },
    runNext() {
      const task = tasks.shift();
      if (!task) return false;
      task.run();
      return true;
    },
    size: () => tasks.length,
  };
}

describe('DebugLogBatchQueue — bounded chunks per scheduled tick (TUI-TYPING-LAG)', () => {
  test('push does not drain on the caller stack; schedule() drains one chunk per tick in FIFO order', () => {
    const scheduler = manualScheduler();
    const drained: number[][] = [];
    const queue = new DebugLogBatchQueue<number>({ batchSize: 3, scheduler, drain: (items) => { drained.push(items); } });
    for (let i = 0; i < 7; i += 1) queue.push(i);
    expect(drained).toEqual([]);
    expect(queue.pending).toBe(7);
    queue.schedule();
    queue.schedule(); // idempotent — one tick in flight
    expect(scheduler.size()).toBe(1);
    expect(scheduler.runNext()).toBe(true);
    expect(drained).toEqual([[0, 1, 2]]);
    expect(queue.pending).toBe(4);
    expect(scheduler.size()).toBe(1); // remainder rescheduled as a separate tick
    scheduler.runNext();
    scheduler.runNext();
    expect(drained).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(queue.pending).toBe(0);
    expect(queue.flushes).toBe(3);
    expect(scheduler.size()).toBe(0);
  });

  test('flushAll drains everything synchronously in one call and cancels the pending tick', () => {
    const scheduler = manualScheduler();
    const drained: number[][] = [];
    const queue = new DebugLogBatchQueue<number>({ batchSize: 2, scheduler, drain: (items) => { drained.push(items); } });
    for (let i = 0; i < 5; i += 1) queue.push(i);
    queue.schedule();
    queue.flushAll();
    expect(drained).toEqual([[0, 1, 2, 3, 4]]);
    expect(queue.pending).toBe(0);
    expect(queue.scheduled).toBe(false);
    expect(scheduler.size()).toBe(0);
    queue.flushAll(); // empty → no drain call
    expect(drained.length).toBe(1);
  });

  test('dropOldest evicts from the head and reports the count', () => {
    const queue = new DebugLogBatchQueue<number>({ batchSize: 10, scheduler: manualScheduler(), drain: () => {} });
    for (let i = 0; i < 5; i += 1) queue.push(i);
    expect(queue.dropOldest(2)).toBe(2);
    expect(queue.dropOldest(0)).toBe(0);
    const drained: number[][] = [];
    const q2 = new DebugLogBatchQueue<number>({ batchSize: 10, scheduler: manualScheduler(), drain: (items) => { drained.push(items); } });
    for (let i = 0; i < 5; i += 1) q2.push(i);
    q2.dropOldest(3);
    q2.flushAll();
    expect(drained).toEqual([[3, 4]]);
  });

  test('a throwing drain still reschedules the remainder (no stuck queue)', () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const queue = new DebugLogBatchQueue<number>({
      batchSize: 1,
      scheduler,
      drain: () => { calls += 1; if (calls === 1) throw new Error('disk'); },
    });
    queue.push(1);
    queue.push(2);
    queue.schedule();
    expect(() => scheduler.runNext()).toThrow('disk');
    expect(queue.pending).toBe(1);
    expect(scheduler.size()).toBe(1);
    scheduler.runNext();
    expect(queue.pending).toBe(0);
  });
});
