import { createTurnEventRing, type CompletedTurnEvent } from './ring.js';
import { debug } from '../../debug/log.js';
import { compareTurnEvents, type TurnEvent, type TurnEventBus, type TurnEventSource } from '../../turn-capsule/contract.js';

export interface TurnEventBusOptions {
  readonly now?: () => number;
  readonly history?: { record(entry: CompletedTurnEvent): boolean; snapshot(): { rows: CompletedTurnEvent[]; evicted: number } };
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** Delay before a failed event can be offered again. */
  readonly backoffMs?: (source: TurnEventSource, failures: number) => number;
}

interface Entry {
  readonly event: TurnEvent;
  state: 'waiting' | 'inflight' | 'done';
  readyAt: number;
  failures: number;
}

/** In-memory delivery state. Durable producers retain ownership until responded is acknowledged. */
export function createTurnEventBus(options: TurnEventBusOptions = {}): TurnEventBus & { history(): { rows: CompletedTurnEvent[]; evicted: number } } {
  const history = options.history ?? createTurnEventRing();
  const now = options.now ?? Date.now;
  const logger = options.log ?? ((event, data) => debug.log('turn-life', event, data));
  const log = (event: string, row: Entry, extra: Record<string, unknown> = {}): void => {
    try { logger(event, { eventId: row.event.id, source: row.event.source, ...extra }); } catch { /* observation must not change delivery */ }
  };
  const backoff = options.backoffMs ?? ((_source, failures) => Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)));
  const byId = new Map<string, Entry>();
  const keys = new Set<string>();
  const ready = (): Entry[] => {
    const time = now();
    return [...byId.values()].filter(row => row.state === 'waiting' && row.readyAt <= time)
      .sort((a, b) => compareTurnEvents(a.event, b.event));
  };
  const snapshot = (event: TurnEvent): TurnEvent => ({ ...event, ...(event.capsule ? { capsule: { ...event.capsule } } : {}) });
  return {
    history: () => history.snapshot(),
    publish(event) {
      if (keys.has(event.dedupeKey) || byId.has(event.id)) return { duplicate: true };
      const entry: Entry = { event: snapshot(event), state: 'waiting', readyAt: Number.NEGATIVE_INFINITY, failures: 0 };
      keys.add(event.dedupeKey);
      byId.set(event.id, entry);
      log('turn-life:event-queued', entry);
      return { duplicate: false };
    },
    pending() { return ready().map(row => snapshot(row.event)); },
    take(max) {
      if (!Number.isFinite(max) || max < 1) return [];
      const rows = ready().slice(0, Math.floor(max));
      for (const row of rows) { row.state = 'inflight'; log('turn-life:event-dequeued', row); }
      return rows.map(row => snapshot(row.event));
    },
    ack(ids, outcome) {
      for (const id of ids) {
        const row = byId.get(id);
        if (!row || row.state !== 'inflight') continue;
        if (outcome === 'responded') {
          row.state = 'done';
          try { history.record({ id: row.event.id, outcome, ...(row.event.capsule ? { capsuleId: row.event.capsule.capsuleId } : {}) }); } catch { /* history is observational */ }
          log('turn-life:event-acked', row, { outcome });
          continue;
        }
        row.state = 'waiting';
        if (outcome === 'failed') {
          row.failures++;
          const delay = backoff(row.event.source, row.failures);
          row.readyAt = now() + (Number.isFinite(delay) && delay > 0 ? delay : 0);
        } else row.readyAt = Number.NEGATIVE_INFINITY;
        log('turn-life:event-acked', row, { outcome, readyAt: Number.isFinite(row.readyAt) ? row.readyAt : null });
      }
    },
  };
}
