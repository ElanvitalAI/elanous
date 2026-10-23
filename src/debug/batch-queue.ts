// TUI-TYPING-LAG — bounded-chunk drain queue for the log plane.
//
// A worker that floods the log (streaming chunks, subagent output) used to hand
// the main thread one synchronous drain of the whole burst (e.g. StoreSink's
// detached flush inserting thousands of sqlite rows in one macrotask), so a key
// typed meanwhile waited for the entire drain (0.25–2.4s stalls). This queue
// drains at most `batchSize` items per scheduled tick and schedules the remainder
// as a NEW tick, so the event loop gets back to I/O (stdin) between chunks.
//
// Zero imports on purpose: the log sinks under
// src/mss/logging import it without creating a cycle.

/** Scheduler seam — production uses setImmediate / setTimeout(unref); stages inject a fake clock. */
export interface DebugBatchScheduler {
  schedule(run: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export const defaultDebugBatchScheduler: DebugBatchScheduler = {
  schedule(run, delayMs) {
    if (delayMs <= 0) return { immediate: setImmediate(run) };
    const timer = setTimeout(run, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    return { timeout: timer };
  },
  cancel(handle) {
    const h = handle as { immediate?: ReturnType<typeof setImmediate>; timeout?: ReturnType<typeof setTimeout> } | null;
    if (!h) return;
    if (h.immediate !== undefined) clearImmediate(h.immediate);
    if (h.timeout !== undefined) clearTimeout(h.timeout);
  },
};

export interface DebugLogBatchQueueOptions<T> {
  /** Max items handed to `drain` per scheduled tick. `Infinity` = whole queue in one tick. */
  batchSize: number;
  /** Delay before each scheduled tick (0 = next loop iteration). */
  flushDelayMs?: number;
  scheduler?: DebugBatchScheduler;
  /** Return `false` to stop chunking (e.g. the store is contended) — the remainder stays queued, unscheduled. */
  drain: (items: T[]) => void | boolean;
}

export class DebugLogBatchQueue<T> {
  private items: T[] = [];
  private handle: unknown = null;
  private hasHandle = false;
  private flushCount = 0;
  private readonly batchSize: number;
  private readonly flushDelayMs: number;
  private readonly scheduler: DebugBatchScheduler;
  private readonly drainFn: (items: T[]) => void | boolean;

  constructor(opts: DebugLogBatchQueueOptions<T>) {
    this.batchSize = opts.batchSize > 0 ? opts.batchSize : 1;
    this.flushDelayMs = Math.max(0, opts.flushDelayMs ?? 0);
    this.scheduler = opts.scheduler ?? defaultDebugBatchScheduler;
    this.drainFn = opts.drain;
  }

  get pending(): number { return this.items.length; }
  get flushes(): number { return this.flushCount; }
  get scheduled(): boolean { return this.hasHandle; }

  /** Enqueue without draining — the caller decides when to `schedule()`. */
  push(item: T): void { this.items.push(item); }

  /** Arm one drain tick (idempotent while a tick is in flight). */
  schedule(): void {
    if (this.hasHandle || this.items.length === 0) return;
    this.hasHandle = true;
    this.handle = this.scheduler.schedule(() => this.tick(), this.flushDelayMs);
  }

  /** Drop up to `count` oldest items; returns how many were dropped. */
  dropOldest(count: number): number {
    if (count <= 0) return 0;
    const dropped = Math.min(count, this.items.length);
    this.items.splice(0, dropped);
    return dropped;
  }

  /** Synchronous full drain (exit / explicit flush) — one `drain` call, pending tick cancelled. */
  flushAll(): void {
    this.cancelTick();
    if (this.items.length === 0) return;
    const all = this.items;
    this.items = [];
    this.flushCount += 1;
    this.drainFn(all);
  }

  /** Disarm the pending tick (items stay queued) — e.g. the store is contended. */
  cancelScheduled(): void { this.cancelTick(); }

  private cancelTick(): void {
    if (!this.hasHandle) return;
    this.scheduler.cancel(this.handle);
    this.handle = null;
    this.hasHandle = false;
  }

  private tick(): void {
    this.handle = null;
    this.hasHandle = false;
    if (this.items.length === 0) return;
    const chunk = Number.isFinite(this.batchSize)
      ? this.items.splice(0, this.batchSize)
      : this.items.splice(0, this.items.length);
    this.flushCount += 1;
    let keepGoing = true;
    try {
      keepGoing = this.drainFn(chunk) !== false;
    } finally {
      // The remainder is a separate tick so stdin can be served between chunks.
      if (keepGoing) this.schedule();
    }
  }
}
