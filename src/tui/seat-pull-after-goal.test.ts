import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { pullSeatAfterGoal, releaseBusyAfterSettle, settleSeatPullTurnEnd, type SeatPullAfterGoalDeps } from './seat-pull-after-goal.js';

function deps(over: Partial<SeatPullAfterGoalDeps> = {}): SeatPullAfterGoalDeps & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    goal: { check: () => ({ opened: false }) },
    startTurnIfIdle: () => ({ opened: true, turnId: 'pull-1' }),
    seat: 'HAND-TUI-D',
    queueCount: 0,
    draftLength: 0,
    enabled: () => true,
    readUnread: () => ({ count: 3 }),
    hook: (ctx) => { calls.push(ctx); },
    ...over,
  };
}

describe('pullSeatAfterGoal', () => {
  test('a goal that opened a follow-up wins — self-pull does not run', async () => {
    const d = deps({ goal: { check: () => ({ opened: true }) } });
    const out = await pullSeatAfterGoal(d);
    expect(out).toEqual({ pulled: false, skipped: 'goal-opened', hook: d.hook });
    expect(d.calls).toEqual([]);
  });

  test('a throwing goal check is treated as opened so a pull cannot race it', async () => {
    const d = deps({ goal: { check: () => { throw new Error('goal'); } } });
    expect((await pullSeatAfterGoal(d)).skipped).toBe('goal-opened');
    expect(d.calls).toEqual([]);
  });

  test('no goal still pulls when the queue and draft are empty', async () => {
    const d = deps({ goal: null });
    const out = await pullSeatAfterGoal(d);
    expect(out.pulled).toBe(true);
    expect(d.calls).toEqual([{ seat: 'HAND-TUI-D', unread: 3, queue: 0 }]);
  });

  test('a queued line or a draft blocks the pull', async () => {
    expect((await pullSeatAfterGoal(deps({ queueCount: 1 }))).skipped).toBe('busy-input');
    expect((await pullSeatAfterGoal(deps({ draftLength: 4 }))).skipped).toBe('busy-input');
  });

  test('no wakeup door and no seat skip before the switch', async () => {
    expect((await pullSeatAfterGoal(deps({ startTurnIfIdle: null }))).skipped).toBe('no-door');
    expect((await pullSeatAfterGoal(deps({ seat: null }))).skipped).toBe('no-seat');
  });

  test('the switch file is checked before any unread read or hook load', async () => {
    let unread = 0;
    let loaded = 0;
    const out = await pullSeatAfterGoal(deps({
      enabled: () => false,
      hook: null,
      readUnread: () => { unread += 1; return { count: 1 }; },
      loadHook: async () => { loaded += 1; return () => {}; },
    }));
    expect(out.skipped).toBe('switch-off');
    expect(unread).toBe(0);
    expect(loaded).toBe(0);
  });

  test('a missing hook after the switch is on loads once and is returned for the next turn', async () => {
    const seen: unknown[] = [];
    const out = await pullSeatAfterGoal(deps({
      hook: null,
      loadHook: async () => (ctx) => { seen.push(ctx); },
    }));
    expect(out.pulled).toBe(true);
    expect(seen).toEqual([{ seat: 'HAND-TUI-D', unread: 3, queue: 0 }]);
    expect(out.hook).toBeTypeOf('function');
  });

  test('entry turn end is one branch: a goal that opens nothing pulls once', async () => {
    const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
    const start = entry.indexOf('const auto = decideNextTuiAutoContinue');
    const branch = entry.slice(start, entry.indexOf('reportTuiTurn', start));
    expect(branch.includes('settleSeatPullTurnEnd')).toBe(true);
    expect(branch.includes('else if (auto === ' + "'check'")).toBe(false);
    const pulls: string[] = [];
    const goal = { check: () => ({ opened: false, reason: 'not-armed' }) };
    const settled = await settleSeatPullTurnEnd({
      auto: 'check',
      goal,
      pull: () => pullSeatAfterGoal(deps({
        goal: null,
        hook: () => { pulls.push('pull'); },
      })),
    });
    expect(settled?.pulled).toBe(true);
    expect(pulls).toEqual(['pull']);
    const opened = await settleSeatPullTurnEnd({
      auto: 'check',
      goal: { check: () => ({ opened: true, reason: 'pledge-without-result' }) },
      pull: async () => { pulls.push('again'); return { pulled: true, hook: null }; },
    });
    expect(opened).toBeNull();
    expect(pulls).toEqual(['pull']);
  });

  test('a sidetab switch requested while settle runs is applied only after busy drops', async () => {
    const order: string[] = [];
    let busy = true;
    let pending: string | null = null;
    const requestSwitch = (sessionId: string): void => {
      if (busy) pending = sessionId;
    };
    let releaseBusy!: () => void;
    const settled = new Promise<void>((resolve) => { releaseBusy = resolve; });
    const done = releaseBusyAfterSettle({
      settle: () => settled,
      pendingSwitch: () => pending,
      queueCount: () => 0,
      release: () => { busy = false; order.push('busy-false'); },
      applySwitch: async (sessionId) => { order.push(`switch:${sessionId}`); },
      wakeQueue: () => { order.push('wake'); },
    });
    requestSwitch('session-b');
    expect(busy).toBe(true);
    expect(order).toEqual([]);
    releaseBusy();
    expect(await done).toBe('session-b');
    expect(order).toEqual(['busy-false', 'switch:session-b']);
  });

  test('entry stays busy until after settle, then applies the pending switch', () => {
    const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
    const start = entry.indexOf('const auto = decideNextTuiAutoContinue');
    const branch = entry.slice(start, entry.indexOf('reportTuiTurn', start));
    const releaseAt = branch.indexOf('releaseBusyAfterSettle');
    const settleAt = branch.indexOf('settleSeatPullTurnEnd');
    const busyAt = branch.indexOf('busy = false');
    expect(releaseAt).not.toBe(-1);
    expect(settleAt).toBeGreaterThan(releaseAt);
    expect(busyAt).toBeGreaterThan(settleAt);
  });

  test('a notice queued while busy wakes after busy drops, unless a switch runs', async () => {
    const order: string[] = [];
    let busy = true;
    const done = releaseBusyAfterSettle({
      settle: async () => { order.push('settle'); },
      pendingSwitch: () => null,
      queueCount: () => 2,
      release: () => { busy = false; order.push('busy-false'); },
      applySwitch: async () => { order.push('switch'); },
      wakeQueue: () => { order.push('wake'); },
    });
    expect(await done).toBeNull();
    expect(busy).toBe(false);
    expect(order).toEqual(['settle', 'busy-false', 'wake']);
    const switched = await releaseBusyAfterSettle({
      settle: async () => {},
      pendingSwitch: () => 'session-b',
      queueCount: () => 2,
      release: () => {},
      applySwitch: async (sessionId) => { order.push(`switch:${sessionId}`); },
      wakeQueue: () => { order.push('wake-again'); },
    });
    expect(switched).toBe('session-b');
    expect(order).toEqual(['settle', 'busy-false', 'wake', 'switch:session-b']);
  });

  test('an unread reader that returns null still calls the hook with null', async () => {
    const d = deps({ readUnread: () => null });
    expect((await pullSeatAfterGoal(d)).pulled).toBe(true);
    expect(d.calls).toEqual([{ seat: 'HAND-TUI-D', unread: null, queue: 0 }]);
  });
});
