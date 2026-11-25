/**
 * ELN-SEAT-IDLE-QUEUE-STALL — the idle loop opens the next queued item only when a `queueWake` key reaches it.
 * Every producer knocks once; a knock that lands while a turn runs (or before the terminal is raw) is dropped by
 * design, and the turn end is trusted to knock again. A path that never knocks leaves «Turn idle · Queue N» until a
 * person types (11-18 live: the seat plan re-queues its saved active item at boot with no knock at all).
 *
 * This watchdog does not trust the knocks. Each tick it looks at the state itself: idle ∧ queued ≥ 1 held for
 * `stallMs` → one recorded wake. It never dispatches by itself — the wake goes through the same key and the same
 * `dispatchQueued` path as every other knock, so ordering and the notice/user split stay in one place.
 */

export type QueueIdleWatchdogLog = (event: string, data: Record<string, unknown>) => void;

export interface QueueIdleWatchdogDeps {
  now: () => number;
  /** Nothing runs and nothing holds the queue on purpose (no turn, TUI open, queue panel closed). */
  idle: () => boolean;
  queued: () => number;
  /** Sends the wake key for this wake kind. `false` = refused (boot person-first · terminal not raw) — logged, retried next window. */
  wake: (event: 'idle-stall-wake' | 'boot-wake') => boolean;
  log: QueueIdleWatchdogLog;
  /**
   * 11-25 OP deaf: a stall with HELD mail (finish-first) is not fixed by a knock — the door keeps holding. Before the
   * stall wake, this releases the held mail as one digest; true = something was released (logged).
   */
  releaseHeld?: () => boolean;
  /** Idle-with-queue time after which the queue is judged stalled. */
  stallMs: number;
}

export type QueueIdleTick =
  | { kind: 'clear' }
  | { kind: 'waiting'; idleMs: number }
  | { kind: 'woke'; idleMs: number; queued: number }
  | { kind: 'wake-refused'; idleMs: number; queued: number };

export interface QueueIdleWatchdog {
  tick(): QueueIdleTick;
  /** A dispatch was just attempted: the item it took needs one full window before the queue counts as stuck again. */
  noteDispatch(): void;
  /** Boot: the queue may already hold items no producer knocked for (a restored plan item). Wakes at once if idle. */
  kick(reason: string): boolean;
  /**
   * #38510 r1 MF2: an item just entered the queue. If the loop is idle and no window is open, the window starts NOW
   * (the real transition), not at the next tick — so the wake lands at stallMs after the enqueue, not up to a tick later.
   */
  noteQueued(): void;
  /**
   * #38510 r1 MF1: a turn started or ended. Any open window is void (a turn that started and ended between two ticks
   * must not let the old window fire right after it); if the loop is idle with items, a fresh window starts now.
   */
  noteTurnBoundary(): void;
}

/** Default N: the normal knock opens the next item in milliseconds; 5 s only ever sees a missed knock. */
export const QUEUE_IDLE_STALL_MS = 5_000;
/** Tick cadence: a stall is caught within stallMs + one tick. */
export const QUEUE_IDLE_TICK_MS = 500;

export function createQueueIdleWatchdog(deps: QueueIdleWatchdogDeps): QueueIdleWatchdog {
  let idleSince: number | null = null;

  const fire = (event: 'idle-stall-wake' | 'boot-wake', idleMs: number, extra: Record<string, unknown> = {}): QueueIdleTick => {
    const queued = deps.queued();
    const accepted = deps.wake(event);
    // The next window starts now: a still-stuck queue is woken again after another stallMs, not on every tick.
    idleSince = deps.now();
    if (!accepted) {
      deps.log(`${event}-refused`, { queued, idleMs, ...extra });
      return { kind: 'wake-refused', idleMs, queued };
    }
    deps.log(event, { queued, idleMs, ...extra });
    return { kind: 'woke', idleMs, queued };
  };

  return {
    tick(): QueueIdleTick {
      if (!deps.idle() || deps.queued() === 0) {
        idleSince = null;
        return { kind: 'clear' };
      }
      const now = deps.now();
      if (idleSince === null) {
        idleSince = now;
        return { kind: 'waiting', idleMs: 0 };
      }
      const idleMs = now - idleSince;
      if (idleMs < deps.stallMs) return { kind: 'waiting', idleMs };
      if (deps.releaseHeld?.() === true) deps.log('idle-stall-release-held', { queued: deps.queued(), idleMs });
      return fire('idle-stall-wake', idleMs, { stallMs: deps.stallMs });
    },
    noteDispatch(): void {
      idleSince = null;
    },
    kick(reason: string): boolean {
      if (!deps.idle() || deps.queued() === 0) return false;
      return fire('boot-wake', 0, { reason }).kind === 'woke';
    },
    noteQueued(): void {
      if (idleSince === null && deps.idle() && deps.queued() > 0) idleSince = deps.now();
    },
    noteTurnBoundary(): void {
      idleSince = deps.idle() && deps.queued() > 0 ? deps.now() : null;
    },
  };
}
