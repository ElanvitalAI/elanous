import { debug } from '../debug/log.js';

/** Keep git status responsive while active, then back off after two idle minutes. */
export function dashboardIdleMs(now: number, lastInputAt: number, streaming: boolean): number {
  // A model turn is active work even when it produces no terminal input.
  // Do not age the dashboard into idle cadence until that stream finishes.
  return streaming ? 0 : Math.max(0, now - lastInputAt);
}

export function gitDirtyRefreshIntervalMs(idleMs: number): number {
  return idleMs >= 2 * 60_000 ? 60_000 : 5_000;
}

// CLASSIC-IDLE-GIT-POLL (대표 10-21 «classic 백그라운드가 너무 무겁다») — a classic TUI left alone for five
// minutes spawned 63 git children (dirty probe ⊕ snapshot keep-warm). After this many idle ms the poller
// stops spawning git; the next input (or any activity that resets the idle clock) warms once and resumes.
export const GIT_POLL_IDLE_PAUSE_MS = 2 * 60_000;

export interface IdleGitPollState { active: boolean; reason: string }

export interface IdleGitPollDeps {
  /** Idle ms right now (`dashboardIdleMs` — a running stream counts as active). */
  idleMs: () => number;
  /** One regular pass while active: dirty probe ⊕ snapshot keep-warm. */
  poll: (idleMs: number) => void;
  /** The one warm when polling resumes after a pause. */
  warm: () => void;
  /** Run the warm off the input path (default: a 0ms timer — after the key has been handled and painted). */
  defer?: (fn: () => void) => void;
  /** Transition record (default: `debug.log('git-fs.idle', 'poll-state', …)`). */
  log?: (state: IdleGitPollState) => void;
  pauseAfterMs?: number;
}

export interface IdleGitPoll {
  /** The periodic timer body: pauses once idle, resumes (with one warm) when activity is back. */
  tick(): void;
  /** Called on the input path. Costs one boolean check while active; when paused it only schedules the warm. */
  noteActivity(reason?: string): void;
  isActive(): boolean;
}

export function createIdleGitPoll(deps: IdleGitPollDeps): IdleGitPoll {
  const pauseAfterMs = deps.pauseAfterMs ?? GIT_POLL_IDLE_PAUSE_MS;
  const log = deps.log ?? ((state: IdleGitPollState) => debug.log('git-fs.idle', 'poll-state', state));
  const defer = deps.defer ?? ((fn: () => void) => {
    const timer = setTimeout(fn, 0);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  let active = true;
  const setActive = (next: boolean, reason: string): boolean => {
    if (active === next) return false;
    active = next;
    try { log({ active, reason }); } catch { /* observation must not break polling */ }
    return true;
  };
  const warm = (): void => { try { deps.warm(); } catch { /* fail-soft */ } };
  return {
    tick() {
      const idleMs = deps.idleMs();
      if (idleMs >= pauseAfterMs) {
        setActive(false, 'idle');
        return;
      }
      // Activity that did not come through `noteActivity` (a stream, an edit) — resume here.
      if (setActive(true, 'activity')) warm();
      deps.poll(idleMs);
    },
    noteActivity(reason = 'input') {
      if (active) return;
      setActive(true, reason);
      defer(warm);
    },
    isActive: () => active,
  };
}
