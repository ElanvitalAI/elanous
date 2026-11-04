import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createScheduleSource } from '../../src/workflow-runtime/triggers/schedule-source.js';
import { cronMatches } from '../../src/domains/cron-match.js';
import { withSimClock } from '../../src/ux-sim/fake-clock.js';
import { setUserConfigOverlay } from '../../src/user-config.js';

test('intake graph scheduler does not fire before 08:00 KST and fires at 08:00 under fake clock', async () => {
  const file = join(import.meta.dir, 'intake-daily.yaml');
  await withSimClock(Date.parse('2026-11-03T22:59:00.000Z'), async (clock) => {
    let fires = 0;
    // Exercise production graph registration and startScheduler dispatch; the cron adapter follows the expression on fake minute ticks.
    setUserConfigOverlay((config) => ({ ...config, timezone: 'Asia/Seoul' }));
    const timeZones: string[] = [];
    const source = createScheduleSource({ cronSchedule: (expr, callback, timeZone) => {
      timeZones.push(timeZone);
      const timer = setInterval(() => {
        if (cronMatches(expr, new Date(clock.now()), { timeZone: timeZones.at(-1) ?? 'UTC' })) callback();
      }, 60_000);
      return { stop: () => clearInterval(timer) };
    } });
    source.subscribeGraph(file, () => { fires++; });
    try {
      await source.start();
      expect(source.subscriptions()).toHaveLength(1);
      expect(source.handle()?.activeCrons).toBe(1);
      expect(timeZones).toEqual(['Asia/Seoul']);
      clock.tick(59_000);
      expect(fires).toBe(0);
      clock.tick(1_000);
      await Promise.resolve();
      expect(fires).toBe(1);
    } finally { await source.stop(); setUserConfigOverlay(null); }
  });
});
