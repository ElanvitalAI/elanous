// The next TUI factory must hand the session wakeup file to the scheduler (restart restore).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext } from '../plugins/core/types.js';
import { createFileWakeupPersistence } from '../skills/tools/schedule-wakeup.js';
import { createNextTuiWakeup } from './next-wakeup.js';

function fakeTimers(start = Date.UTC(2026, 9, 22, 3, 0, 0)) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
      }
    },
  };
}

describe('next TUI wakeup persistence', () => {
  test('a repeating wakeup scheduled through the next TUI survives a restart (persist wired into the real next TUI factory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'next-wakeup-persist-'));
    try {
      const file = join(dir, 'wakeups', 'session.json');
      const clock = fakeTimers();
      const boot = (env: NodeJS.ProcessEnv = {}) => createNextTuiWakeup({
        isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0,
        requestYield: () => true, notify: () => {}, env, now: clock.now, setTimer: clock.setTimer,
        clearTimer: clock.clearTimer, lastHumanKeyAt: () => 0, pendingKeyCount: () => 0, log: () => {},
        persist: createFileWakeupPersistence(file),
      });
      const first = boot();
      first.gate.noteHumanTurn();
      const scheduled = await first.tool!.handler({ action: 'schedule', delaySeconds: 120, repeatMinutes: 5, reason: 'survive restart' }, {} as PluginContext) as { scheduled?: { id: string } };
      expect(scheduled.scheduled?.id).toBe('w1');
      first.dispose();

      const second = boot();
      expect(second.scheduler.list().map(entry => entry.reason)).toEqual(['survive restart']);
      expect(second.scheduler.persists()).toBe(true);
      clock.advance(120_000);
      expect(second.gate.takePending()?.input).toContain('survive restart');
      second.dispose();

      // An unattended harness child never restores or arms the saved schedule.
      const child = boot({ ELANOUS_HARNESS_ROLE: 'child' });
      expect(child.tool).toBeNull();
      expect(child.scheduler.list()).toEqual([]);
      child.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
