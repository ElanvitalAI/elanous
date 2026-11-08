import { randomUUID } from 'node:crypto';
import type { NexusEventBus } from '../api/event-bus.js';
import type { NexusEvent } from '../state/state.js';
import { SSE_HEARTBEAT_MS } from '../api/sse-heartbeat.js';

const APP_ROW_PREFIX = 'app.row.';
const APP_EVENT_HISTORY_LIMIT = 256;
const APP_COUNT_LIMIT = 256;
const APP_REALTIME_PENDING_LIMIT = 256;
const APP_EVENT_EPOCH = randomUUID();

interface AppRowEventRecord {
  readonly appSlug: string;
  readonly generation: string;
  readonly id: number;
  readonly event: NexusEvent;
}

interface AppEventHistory {
  readonly bySlug: Map<string, AppRowEventRecord[]>;
  readonly recordByEvent: WeakMap<NexusEvent, AppRowEventRecord>;
  readonly latestIdBySlug: Map<string, number>;
  readonly generationBySlug: Map<string, string>;
}

interface ParsedCursor { readonly epoch: string; readonly generation: string; readonly id: number }

const histories = new WeakMap<NexusEventBus, AppEventHistory>();

function historyFor(bus: NexusEventBus): AppEventHistory {
  const existing = histories.get(bus);
  if (existing) return existing;
  const history: AppEventHistory = {
    bySlug: new Map(), recordByEvent: new WeakMap(), latestIdBySlug: new Map(), generationBySlug: new Map(),
  };
  // Keep a bounded replay window for each app while the Nexus process lives.
  // This observer is one-per-bus; request listeners are removed on disconnect.
  bus.subscribe((event) => {
    if (!event.kind.startsWith(APP_ROW_PREFIX)) return;
    const appSlug = event.detail?.appSlug;
    if (typeof appSlug !== 'string' || appSlug.length === 0) return;
    const generation = history.generationBySlug.get(appSlug) ?? randomUUID();
    history.generationBySlug.set(appSlug, generation);
    const id = (history.latestIdBySlug.get(appSlug) ?? 0) + 1;
    history.latestIdBySlug.set(appSlug, id);
    const record = { appSlug, generation, id, event };
    const entries = history.bySlug.get(appSlug) ?? [];
    entries.push(record);
    if (entries.length > APP_EVENT_HISTORY_LIMIT) entries.splice(0, entries.length - APP_EVENT_HISTORY_LIMIT);
    // Map insertion order is the LRU order. A noisy tenant cannot grow process memory
    // without bound; an evicted tenant must perform a full resync on reconnect.
    history.bySlug.delete(appSlug);
    history.bySlug.set(appSlug, entries);
    while (history.bySlug.size > APP_COUNT_LIMIT) {
      const oldestSlug = history.bySlug.keys().next().value as string | undefined;
      if (!oldestSlug) break;
      history.bySlug.delete(oldestSlug);
      history.latestIdBySlug.delete(oldestSlug);
      history.generationBySlug.delete(oldestSlug);
    }
    history.recordByEvent.set(event, record);
  }, [APP_ROW_PREFIX]);
  histories.set(bus, history);
  return history;
}

function touchApp(history: AppEventHistory, appSlug: string, create = false): AppRowEventRecord[] {
  let entries = history.bySlug.get(appSlug);
  if (!entries && !create) return [];
  if (!entries) {
    entries = [];
    history.latestIdBySlug.set(appSlug, 0);
    history.generationBySlug.set(appSlug, randomUUID());
  }
  history.bySlug.delete(appSlug);
  history.bySlug.set(appSlug, entries);
  while (history.bySlug.size > APP_COUNT_LIMIT) {
    const oldestSlug = history.bySlug.keys().next().value as string | undefined;
    if (!oldestSlug) break;
    history.bySlug.delete(oldestSlug);
    history.latestIdBySlug.delete(oldestSlug);
    history.generationBySlug.delete(oldestSlug);
  }
  return entries;
}

function parseLastEventId(value: string | null): ParsedCursor | null | undefined {
  if (value === null) return undefined;
  const match = /^([0-9a-f-]{36}):([0-9a-f-]{36}):(\d+)$/.exec(value);
  if (!match) return null;
  const id = Number(match[3]);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  return { epoch: match[1]!, generation: match[2]!, id };
}

function frame(record: AppRowEventRecord): string {
  return `id: ${APP_EVENT_EPOCH}:${record.generation}:${record.id}\nevent: ${record.event.kind}\ndata: ${JSON.stringify(record.event)}\n\n`;
}

/** Capture this cursor before reading the app snapshot; pass it on the first stream request. */
export function appRealtimeSnapshotCursor(bus: NexusEventBus, appSlug: string): string {
  const history = historyFor(bus);
  touchApp(history, appSlug, true);
  return `${APP_EVENT_EPOCH}:${history.generationBySlug.get(appSlug)!}:${history.latestIdBySlug.get(appSlug) ?? 0}`;
}

/** App-scoped replayable SSE. Callers must authenticate the app owner first. */
export function handleAppRealtimeEvents(
  bus: NexusEventBus,
  appSlug: string,
  lastEventId: string | null,
  options: {
    heartbeatMs?: number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  } = {},
): Response {
  const history = historyFor(bus);
  const cursor = parseLastEventId(lastEventId);
  const afterId = cursor?.id;
  const entries = touchApp(history, appSlug);
  const pendingLimit = APP_REALTIME_PENDING_LIMIT;
  const latestId = history.latestIdBySlug.get(appSlug) ?? 0;
  const oldestId = entries[0]?.id ?? latestId + 1;
  const generation = history.generationBySlug.get(appSlug);
  const resyncReason = lastEventId === null ? 'snapshot-cursor-required'
    : !cursor ? 'invalid-cursor'
      : cursor.epoch !== APP_EVENT_EPOCH ? 'process-epoch-changed'
        : latestId === 0 && cursor.id > 0 ? 'app-history-evicted'
          : cursor.generation !== generation ? 'app-history-generation-changed'
          : cursor.id > latestId ? 'cursor-ahead-of-history'
            : cursor.id < oldestId - 1 ? 'history-window-expired' : undefined;
  if (resyncReason) {
    return new Response(JSON.stringify({ error: 'app-events-resync-required', reason: resyncReason }), {
      status: 409,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const replayRecords = afterId === undefined ? [] : entries.filter((record) => record.id > afterId && record.id <= latestId);
  if (replayRecords.length > pendingLimit) {
    return new Response(JSON.stringify({ error: 'app-events-resync-required', reason: 'replay-exceeds-pending-limit' }), {
      status: 409,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let initializing = true;
  const pending: AppRowEventRecord[] = [];
  const encoder = new TextEncoder();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat !== undefined) (options.clearInterval ?? clearInterval)(heartbeat);
    heartbeat = undefined;
    pending.length = 0;
  };

  const flush = (): void => {
    if (!controller || closed) return;
    try {
      while (pending.length > 0 && (controller.desiredSize ?? 0) > 0) {
        controller.enqueue(encoder.encode(frame(pending.shift()!)));
      }
    } catch {
      cleanup();
    }
  };

  const queue = (record: AppRowEventRecord): void => {
    if (closed) return;
    if (pending.length >= pendingLimit) {
      cleanup();
      try { controller?.close(); } catch { /* stream may already be closed */ }
      return;
    }
    pending.push(record);
    flush();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(encoder.encode(': app row events stream\n\n'));
      heartbeat = (options.setInterval ?? setInterval)(() => {
        if (!closed && (controller?.desiredSize ?? 0) > 0) {
          try { controller?.enqueue(encoder.encode(': ping\n\n')); } catch { cleanup(); }
        }
      }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
      const live: AppRowEventRecord[] = [];
      unsubscribe = bus.subscribe((event) => {
        const record = history.recordByEvent.get(event);
        if (!record || record.appSlug !== appSlug) return;
        if (initializing) live.push(record);
        else queue(record);
      }, [APP_ROW_PREFIX]);

      const cutoff = history.latestIdBySlug.get(appSlug) ?? 0;
      if (afterId !== undefined) {
        for (const record of replayRecords) if (record.id <= cutoff) queue(record);
      }
      initializing = false;
      for (const record of live) if (record.id > cutoff) queue(record);
      flush();
    },
    pull() { flush(); },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
