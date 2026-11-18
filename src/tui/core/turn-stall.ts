// ELN-TURN-END-STALL-AFTER-TOOL — a turn that shows «Turn running» for tens of minutes with no new output,
// no token change and queued input that is never consumed (evidence: seat-state/ELN-DOGFOOD/
// E-stall-after-update_goal-*.txt and D-stall-after-final-text-*.txt: nothing after the last tool row / last
// paragraph, Queue 1-2 stuck). The child has its own stream idle timers; this is the parent-side backstop for
// every other silent hang: after a quiet stretch with nothing running, the turn is stopped the way Esc stops it,
// so the queued input is consumed and the seat does not sit idle behind a dead turn.

/** Silence with no running tool/shell/agent after which a turn is judged stalled (ms). */
export const TURN_STALL_LIMIT_MS = 15 * 60_000;

export interface TurnStallWork {
  /** Tool calls, shell calls and child agents that are still running (they are expected to be quiet). */
  readonly running: number;
}
export type TurnStallVerdict = { readonly stalled: false } | { readonly stalled: true; readonly idleMs: number };

export interface TurnStallWatch {
  /** Any sign of life from the turn: text, status, tool/shell/agent activity, steer applied. */
  touch(): void;
  check(work: TurnStallWork): TurnStallVerdict;
}

export function createTurnStallWatch(options: { readonly now: () => number; readonly limitMs?: number }): TurnStallWatch {
  const limitMs = options.limitMs ?? TURN_STALL_LIMIT_MS;
  let lastAt = options.now();
  return {
    touch: () => { lastAt = options.now(); },
    // Running work is exempt: a long build is quiet by nature. Silence only counts when nothing is running.
    check: (work) => {
      if (work.running > 0) return { stalled: false };
      const idleMs = options.now() - lastAt;
      return idleMs >= limitMs ? { stalled: true, idleMs } : { stalled: false };
    },
  };
}

/** Whole minutes for the status line, never below one. */
export function stallMinutes(idleMs: number): number {
  return Math.max(1, Math.floor(idleMs / 60_000));
}
