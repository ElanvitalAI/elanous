// Bun's real test timer implementation, scoped so exceptions cannot leave
// Date or timers mocked for the next test. Use only in serial tests: timer
// replacement is process-global and does not affect child processes.
import { jest } from 'bun:test';

export interface SimClock {
  tick(ms: number): void;
  setTime(now: number | Date): void;
  now(): number;
  pendingTimers(): number;
}

let active = false;

export async function withSimClock<T>(now: number | Date, run: (clock: SimClock) => Promise<T> | T): Promise<T> {
  if (active) throw new Error('sim clock is process-global; run scenarios serially');
  active = true;
  try {
    jest.useFakeTimers({ now });
    const clock: SimClock = {
      tick(ms) {
        if (!Number.isFinite(ms) || ms < 0) throw new Error('sim clock tick must be a nonnegative finite number');
        jest.advanceTimersByTime(ms);
      },
      setTime(value) { jest.setSystemTime(value); },
      now() { return Date.now(); },
      pendingTimers() { return jest.getTimerCount(); },
    };
    return await run(clock);
  }
  finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    active = false;
  }
}
