/**
 * O2 bus consumer (TC #94744 · OP #94698 · JUD 0858): the turn-event bus holds every wakeup the scheduler published
 * (schedule-wakeup.ts:470 base `wakeup:<id>:<n>` · :545 `wakeup:<id>:<n>:late`). Until now nothing took them, so a
 * one-shot that exhausted its retries while the seat was busy was never delivered (12 lost one-shots in production).
 *
 * The scheduler still fires directly; the bus is the backup that must never double a turn (#38794 must: direct fire ↔
 * bus dedupe · late id). Rule: an item is deliverable only while the scheduler still holds that wakeup at the same fire
 * count — once it fired (fireCount moved on) or the entry is gone (one-shot fired · cancelled), the item is resolved.
 * Only `:late` items open a turn here: a base item's own retries still belong to the scheduler.
 *
 * The bus cannot take one chosen item, so `next()` takes what is ready, keeps at most one deliverable in flight, acks the
 * resolved ones `responded` and hands the rest back `cancelled` (waiting again at once, no backoff). Pure: the caller
 * opens the turn through the door and, once it opened, cancels the scheduler's one-shot so its own retry cannot fire it.
 */
import type { TurnEvent, TurnEventBus, TurnEventOutcome } from '../../turn-capsule/contract.js';

/** What the consumer needs to know about one scheduled wakeup (WakeupScheduler.list()). */
export interface WakeupView {
  readonly id: string;
  readonly fireCount: number;
  /** The `deliverBy` a late item of this exact slot carries (dueAt + defer max). Another value = an older slot. */
  readonly deliverBy?: number;
}

export interface WakeupKey {
  readonly id: string;
  readonly fireCount: number;
  readonly late: boolean;
}

/** `wakeup:<id>:<fireCount>[:late]` → its parts; anything else → null. */
export function parseWakeupKey(dedupeKey: string): WakeupKey | null {
  const match = /^wakeup:(.+):(\d+)(:late)?$/.exec(dedupeKey);
  if (!match) return null;
  return { id: match[1]!, fireCount: Number(match[2]), late: match[3] === ':late' };
}

export interface WakeupBusConsumerDeps {
  readonly bus: TurnEventBus;
  readonly wakeups: () => readonly WakeupView[];
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface WakeupBusConsumer {
  /** One deliverable late wakeup, now in flight (open its turn, then `settle`), or null. Resolved items are cleared. */
  next(): TurnEvent | null;
  /** The turn for that event ended: responded = done · failed = back with backoff · cancelled/stopped = back now. */
  settle(eventId: string, outcome: TurnEventOutcome): void;
}

export function createWakeupBusConsumer(deps: WakeupBusConsumerDeps): WakeupBusConsumer {
  const log = deps.log ?? (() => {});
  let inflight: string | null = null;
  return {
    next() {
      if (inflight !== null) return null;
      const all = deps.bus.take(Number.MAX_SAFE_INTEGER);
      // Other sources (mail · capsule-done · watch) share the bus: hand them back untouched (waiting again at once).
      const others = all.filter((event) => event.source !== 'wakeup').map((event) => event.id);
      if (others.length > 0) deps.bus.ack(others, 'cancelled');
      const taken = all.filter((event) => event.source === 'wakeup');
      if (taken.length === 0) return null;
      const held = new Map(deps.wakeups().map((view) => [view.id, view]));
      const resolved: string[] = [];
      const back: string[] = [];
      let chosen: TurnEvent | null = null;
      for (const event of taken) {
        const key = parseWakeupKey(event.dedupeKey);
        const view = key ? held.get(key.id) : undefined;
        // Gone, already fired (count moved on) or an older slot of a repeat (deliverBy differs): never deliverable.
        const staleSlot = view?.deliverBy !== undefined && event.deliverBy !== undefined && event.deliverBy !== view.deliverBy;
        if (!key || !view || view.fireCount > key.fireCount || staleSlot) { resolved.push(event.id); continue; }
        // JUD-B must 2: only the exact fire count is this slot — a count ahead of the scheduler waits (held, not opened).
        if (key.late && view.fireCount === key.fireCount && chosen === null) { chosen = event; continue; }
        back.push(event.id);
      }
      if (resolved.length > 0) {
        deps.bus.ack(resolved, 'responded');
        log('wakeup-bus-resolved', { eventIds: resolved, reason: 'direct-fired-or-gone' });
      }
      if (back.length > 0) deps.bus.ack(back, 'cancelled');
      if (chosen) {
        inflight = chosen.id;
        log('wakeup-bus-deliver', { eventId: chosen.id, dedupeKey: chosen.dedupeKey });
      }
      return chosen;
    },
    settle(eventId, outcome) {
      if (inflight !== eventId) return;
      inflight = null;
      deps.bus.ack([eventId], outcome);
      log('wakeup-bus-settled', { eventId, outcome });
    },
  };
}

export interface LateWakeupTurnDeps {
  readonly consumer: WakeupBusConsumer;
  /** Opens the internal turn through the door (may throw before the turn runs). */
  readonly start: (event: TurnEvent) => void;
  /** True once the turn is really running (busy). */
  readonly running: () => boolean;
  /** The scheduler's cancel: false = refused (write refused · per-turn cap · save failed → entry kept). */
  readonly cancel: (wakeupId: string) => boolean;
  /** Stops the turn just opened. */
  readonly abort: () => void;
  /** The turn's end settles the event; null = nothing to settle (handed back or given up here). */
  readonly track: (eventId: string | null) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export type LateWakeupTurnResult = 'none' | 'opened' | 'start-failed' | 'not-started' | 'cancel-refused';

/**
 * JUD-B must 1 (#38905): one late wakeup → one turn, with the scheduler as the only other owner.
 * Start first: a start that throws or does not open leaves the scheduler entry as it was and hands the item back.
 * The scheduler's copy is cancelled only once the turn runs; a refused cancel gives this delivery up — the bus item is
 * done, the turn just opened is stopped, and the scheduler fires it itself (never two turns).
 */
export function openLateWakeupTurn(deps: LateWakeupTurnDeps): LateWakeupTurnResult {
  const log = deps.log ?? (() => {});
  const event = deps.consumer.next();
  if (!event) return 'none';
  const wakeupId = parseWakeupKey(event.dedupeKey)?.id ?? null;
  deps.track(event.id);
  try {
    deps.start(event);
  } catch (error) {
    deps.track(null);
    deps.consumer.settle(event.id, 'cancelled');
    log('wakeup-bus-start-failed', { eventId: event.id, wakeupId, error: String(error).slice(0, 200) });
    return 'start-failed';
  }
  if (!deps.running()) {
    deps.track(null);
    deps.consumer.settle(event.id, 'cancelled');
    log('wakeup-bus-not-started', { eventId: event.id, wakeupId });
    return 'not-started';
  }
  if (wakeupId !== null && !deps.cancel(wakeupId)) {
    deps.track(null);
    deps.consumer.settle(event.id, 'responded');
    log('wakeup-bus-cancel-refused', { eventId: event.id, wakeupId, action: 'give-up' });
    deps.abort();
    return 'cancel-refused';
  }
  return 'opened';
}
