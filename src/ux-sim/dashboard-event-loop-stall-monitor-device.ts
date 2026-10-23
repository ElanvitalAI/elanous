// L2 mock stage (ux-sim) for TUI-TYPING-LAG: a streaming scenario where a worker
// floods the log plane while the user types, run through the PRODUCTION
// StoreSink (src/mss/logging/log-store.ts · chunked drain via DebugLogBatchQueue
// from src/debug/batch-queue.ts) and the PRODUCTION event-loop stall monitor
// (src/dashboard/event-loop-stall-monitor.ts · `tui.event-loop` `stall`).
//
// The stage is a deterministic event loop on a fake clock. Main-thread cost is
// charged explicitly (the clock only moves when work happens), so the thresholds
// hold on fast and slow machines:
//   • every StoreSink.emit charges `enqueueCostMs` (the worker burst's own task)
//   • every row the fake store inserts charges `insertCostMs` (sqlite insert)
//   • every key paint charges `renderCostMs`
// One loop iteration runs only the tasks that were due BEFORE it started — a task
// scheduled during the iteration waits for the next one, exactly like a chained
// setImmediate — and a key that arrived meanwhile is delivered between iterations.
//
//   mode 'batched' — the sink is built exactly as the TUI builds it
//                    (`logStoreDrainChunkForSurface('tui')`): each drain tick inserts one
//                    bounded chunk, so a key waits for at most one chunk.
//   mode 'inline'  — the default/CLI sink (pre-fix): one tick inserts the whole burst.
import type { DebugBatchScheduler } from '../debug/batch-queue.js';
import { LogStore, StoreSink, logStoreDrainChunkForSurface } from '../mss/logging/log-store.js';
import type { LogRecord } from '../mss/logging/record.js';
import { startEventLoopStallMonitor } from '../dashboard/event-loop-stall-monitor.js';

export interface StageClock extends DebugBatchScheduler {
  now(): number;
  advance(ms: number): void;
  /** Run every task that is due now, oldest first, including tasks they schedule. */
  runDue(): number;
  /** One event-loop iteration: run only the tasks due at its start. */
  runIteration(): number;
}

interface StageTimer {
  handle: number;
  dueAt: number;
  run: () => void;
}

export function createStageClock(startMs = 1_000_000): StageClock {
  let current = startMs;
  let nextHandle = 1;
  let timers: StageTimer[] = [];
  const dueNow = (): StageTimer[] => timers
    .filter((timer) => timer.dueAt <= current)
    .sort((a, b) => a.dueAt - b.dueAt || a.handle - b.handle);
  const runOne = (timer: StageTimer): boolean => {
    if (!timers.some((t) => t.handle === timer.handle)) return false;
    timers = timers.filter((t) => t.handle !== timer.handle);
    timer.run();
    return true;
  };
  return {
    now: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('stage clock advance must be a nonnegative finite number');
      current += ms;
    },
    schedule(run, delayMs) {
      const handle = nextHandle++;
      timers = [...timers, { handle, dueAt: current + Math.max(0, delayMs), run }];
      return handle;
    },
    cancel(handle) {
      timers = timers.filter((timer) => timer.handle !== handle);
    },
    runDue() {
      let ran = 0;
      for (;;) {
        const due = dueNow()[0];
        if (!due) return ran;
        if (runOne(due)) ran += 1;
      }
    },
    runIteration() {
      let ran = 0;
      for (const timer of dueNow()) if (runOne(timer)) ran += 1;
      return ran;
    },
  };
}

export interface StreamingStageOptions {
  keypresses?: number;
  workerEventsPerKey?: number;
  insertCostMs?: number;
  enqueueCostMs?: number;
  renderCostMs?: number;
  idleBetweenKeysMs?: number;
  flushBatchSize?: number;
  stallThresholdMs?: number;
  mode?: 'batched' | 'inline';
}

export interface KeypressLagSample {
  key: string;
  index: number;
  lagMs: number;
  workerEvents: number;
}

export interface StreamingStageResult {
  mode: 'batched' | 'inline';
  samples: KeypressLagSample[];
  maxLagMs: number;
  /** Production `tui.event-loop` `stall` events (lag ≥ stallThresholdMs). */
  stallCount: number;
  stallLagsMs: number[];
  stallThresholdMs: number;
  workerEvents: number;
  insertedRows: number;
  insertBatches: number;
  pendingEvents: number;
  insertedSeqOrder: number[];
}

export interface DashboardStreamingStage {
  pressKey(key: string): KeypressLagSample;
  run(): StreamingStageResult;
  result(): StreamingStageResult;
  dispose(): void;
}

const DEFAULTS: Required<StreamingStageOptions> = {
  keypresses: 12,
  workerEventsPerKey: 800,
  insertCostMs: 0.5,
  enqueueCostMs: 0.01,
  renderCostMs: 3,
  idleBetweenKeysMs: 150,
  flushBatchSize: 64,
  stallThresholdMs: 250,
  mode: 'batched',
};

export function createDashboardStreamingStage(options: StreamingStageOptions = {}): DashboardStreamingStage {
  const config = { ...DEFAULTS, ...options };
  const clock = createStageClock();
  const insertedSeqOrder: number[] = [];
  const samples: KeypressLagSample[] = [];
  const stallLagsMs: number[] = [];
  let workerEvents = 0;
  let insertBatches = 0;

  // Fake LogStore: the only surface StoreSink touches on the drain path is insertBatch.
  const fakeStore = {
    insertBatch(rows: Array<{ rec: LogRecord; surface: string }>): void {
      insertBatches += 1;
      for (const row of rows) {
        insertedSeqOrder.push(Number((row.rec.data as { seq?: number } | undefined)?.seq ?? -1));
        clock.advance(config.insertCostMs);
      }
    },
  } as unknown as LogStore;

  const drainChunkSize = config.mode === 'batched' ? logStoreDrainChunkForSurface('tui') : undefined;
  const sink = new StoreSink(fakeStore, 'tui', {
    flushBatchSize: config.flushBatchSize,
    flushIntervalMs: 200,
    installExitHandlers: false,
    scheduler: clock,
    ...(drainChunkSize !== undefined ? { drainChunkSize } : {}),
  });

  const disposeMonitor = startEventLoopStallMonitor({
    thresholdMs: config.stallThresholdMs,
    now: () => clock.now(),
    setIntervalFn: (callback, intervalMs) => {
      const tick = (): void => { callback(); clock.schedule(tick, intervalMs); };
      clock.schedule(tick, intervalMs);
      return {};
    },
    clearIntervalFn: () => {},
    getContext: () => ({ streamingInFlight: true, thinkingMessage: 'Streaming' }),
    log: (category, event, data) => {
      if (category === 'tui.event-loop' && event === 'stall') stallLagsMs.push(Number(data.lagMs));
    },
  });

  function pressKey(key: string): KeypressLagSample {
    const index = samples.length;
    // Worker burst — one task on the main thread emits N log records.
    for (let seq = 0; seq < config.workerEventsPerKey; seq += 1) {
      const globalSeq = index * config.workerEventsPerKey + seq;
      sink.emit({ ts: new Date(clock.now()).toISOString(), category: 'worker', event: 'stream-chunk', data: { seq: globalSeq } });
      workerEvents += 1;
      clock.advance(config.enqueueCostMs);
    }
    // The key arrives now; the loop finishes the iteration already queued, then delivers it.
    const arrivedAt = clock.now();
    clock.runIteration();
    clock.advance(config.renderCostMs);
    const sample: KeypressLagSample = { key, index, lagMs: clock.now() - arrivedAt, workerEvents: config.workerEventsPerKey };
    samples.push(sample);
    // Drain the rest of the burst iteration by iteration, then idle until the next key.
    while (clock.runIteration() > 0) { /* next iteration */ }
    clock.advance(config.idleBetweenKeysMs);
    clock.runDue();
    return sample;
  }

  function result(): StreamingStageResult {
    return {
      mode: config.mode,
      samples: [...samples],
      maxLagMs: samples.reduce((max, sample) => Math.max(max, sample.lagMs), 0),
      stallCount: stallLagsMs.length,
      stallLagsMs: [...stallLagsMs],
      stallThresholdMs: config.stallThresholdMs,
      workerEvents,
      insertedRows: insertedSeqOrder.length,
      insertBatches,
      pendingEvents: sink.pending,
      insertedSeqOrder: [...insertedSeqOrder],
    };
  }

  return {
    pressKey,
    result,
    dispose: () => { disposeMonitor(); },
    run() {
      for (let index = 0; index < config.keypresses; index += 1) pressKey(`key-${index}`);
      sink.flush();
      return result();
    },
  };
}

export function runDashboardStreamingScenario(options: StreamingStageOptions = {}): StreamingStageResult {
  const stage = createDashboardStreamingStage(options);
  try {
    return stage.run();
  } finally {
    stage.dispose();
  }
}
