/**
 * SEAT-PULL-ON-IDLE-LIVE — the turn-end order in one leaf so entry stays a hook.
 * A goal that opened a follow-up wins. Self-pull runs only when that check
 * did not open one (or there is no goal), the queue is empty, and the draft is empty.
 * The dashboard gather stays behind a dynamic import; a seat without the
 * self-pull file never pays the unread-ledger read.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';

export interface SeatPullGoalCheck {
  opened: boolean;
}

/**
 * The turn-end branch entry actually takes. `goal` is the controller created in the
 * same block as the wakeup door, so a live door always has one. Self-pull runs only
 * when `auto === 'check'` and `goal.check()` did not open a follow-up.
 */
export interface SeatPullTurnEndInput {
  auto: 'complete' | 'check' | 'yield' | 'none';
  goal: { check: () => SeatPullGoalCheck } | null;
  pull: () => Promise<SeatPullAfterGoalResult>;
}

export async function settleSeatPullTurnEnd(input: SeatPullTurnEndInput): Promise<SeatPullAfterGoalResult | null> {
  if (input.auto !== 'check' || !input.goal) return null;
  const followUp = input.goal.check();
  if (followUp.opened === true) return null;
  return input.pull();
}

/**
 * The order entry keeps after a turn: stay busy through settle, then release
 * and apply a sidetab switch that was queued while busy. A switch requested
 * during settle cannot open ahead of it.
 */
export async function releaseBusyAfterSettle(input: {
  settle: () => Promise<void>;
  pendingSwitch: () => string | null;
  /** Queued notices that arrived while busy. The wake key injected then is dropped. */
  queueCount: () => number;
  release: () => void;
  applySwitch: (sessionId: string) => Promise<void>;
  /** After busy drops, so a notice can open its own turn. Not called when a switch runs. */
  wakeQueue: () => void;
}): Promise<string | null> {
  await input.settle();
  const pending = input.pendingSwitch();
  const queued = input.queueCount();
  input.release();
  if (pending) await input.applySwitch(pending);
  else if (queued > 0) input.wakeQueue();
  return pending;
}

export interface SeatPullAfterGoalDeps {
  /** Present whenever the wakeup door exists. Null only before that door is built. */
  goal: { check: () => SeatPullGoalCheck } | null;
  /** Same door the goal uses. Null means the seat cannot open an idle turn. */
  startTurnIfIdle: ((text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult) | null;
  seat: string | null;
  queueCount: number;
  draftLength: number;
  /** Opt-in file. Checked before any ledger read. */
  enabled?: (seat: string) => boolean;
  readUnread?: (seat: string) => { count: number } | null;
  /** Cached across turns. Built only after the switch file is present. */
  hook?: ((ctx: { seat: string; unread: number | null; queue: number | null }) => void) | null;
  loadHook?: () => Promise<(ctx: { seat: string; unread: number | null; queue: number | null }) => void>;
  /** Present only when entry has no cached hook. The dashboard module stays inside this leaf. */
  startTurnIfIdleForHook?: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
}

export interface SeatPullAfterGoalResult {
  pulled: boolean;
  /** Why self-pull did not run. Absent when it did. */
  skipped?: 'goal-opened' | 'busy-input' | 'no-door' | 'no-seat' | 'switch-off';
  hook: SeatPullAfterGoalDeps['hook'];
}

export async function pullSeatAfterGoal(deps: SeatPullAfterGoalDeps): Promise<SeatPullAfterGoalResult> {
  const keep = deps.hook ?? null;
  if (deps.queueCount > 0 || deps.draftLength > 0) return { pulled: false, skipped: 'busy-input', hook: keep };
  if (deps.goal) {
    let opened = false;
    try { opened = deps.goal.check().opened === true; }
    catch { return { pulled: false, skipped: 'goal-opened', hook: keep }; }
    if (opened) return { pulled: false, skipped: 'goal-opened', hook: keep };
  }
  if (!deps.startTurnIfIdle) return { pulled: false, skipped: 'no-door', hook: keep };
  if (!deps.seat) return { pulled: false, skipped: 'no-seat', hook: keep };
  const enabled = deps.enabled ?? selfPullSwitchOn;
  if (!enabled(deps.seat)) return { pulled: false, skipped: 'switch-off', hook: keep };
  const hook = keep ?? (deps.loadHook
    ? await deps.loadHook()
    : deps.startTurnIfIdleForHook
      ? await loadSelfPullHook(deps.startTurnIfIdleForHook)
      : null);
  if (!hook) return { pulled: false, skipped: 'switch-off', hook: keep };
  const unread = deps.readUnread?.(deps.seat)?.count ?? null;
  hook({ seat: deps.seat, unread, queue: 0 });
  return { pulled: true, hook };
}

/** Opt-in file. node:fs only — the dashboard module stays behind loadSelfPullHook. */
function selfPullSwitchOn(seat: string, home = homedir()): boolean {
  try { return statSync(join(home, 'elanous-hq', 'seat-state', seat, 'self-pull')).isFile(); }
  catch { return false; }
}

/**
 * Gather loads only after the switch file is on.
 * The specifier is joined so src/tui has no static specifier the size contract counts.
 * entry must not name this module.
 */
async function loadSelfPullHook(
  startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult,
): Promise<(ctx: { seat: string; unread: number | null; queue: number | null }) => void> {
  const sources = ['..', 'dashboard', 'input', 'seat-self-pull-sources.js'].join('/');
  const { createAutowakeSelfPullHook } = await import(sources) as {
    createAutowakeSelfPullHook: (opts: {
      origin: 'self-pull';
      startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
    }) => (ctx: { seat: string; unread: number | null; queue: number | null }) => void;
  };
  return createAutowakeSelfPullHook({ origin: 'self-pull', startTurnIfIdle });
}
