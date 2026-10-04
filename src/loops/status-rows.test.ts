import { expect, test } from 'bun:test';
import { loadLoopRows, loopRows, LOOP_SCHEDULES_PATH, type LoopSchedule } from './status-rows';
import { loadLoopRows as pwaLoadLoopRows, loopRows as pwaLoopRows } from '../../apps/pwa/src/components/loops/loop-status';
import { telegramLoopsStatus } from '../telegram-loops-command';

const now = Date.parse('2026-10-04T12:00:00Z');
const schedule = (patch: Partial<LoopSchedule> = {}): LoopSchedule => ({
  id: 'fixed', name: 'Fixed', source: 'crontab', category: 'monitor', domain: 'ops',
  runVia: 'crontab', cron: null, intervalMs: 600_000, state: 'stale', next: [],
  lastRun: { at: '2026-10-04T11:40:00Z', status: 'ok', exit: 0 }, ...patch,
});

test('PWA and Telegram share the row loader and the exact two-interval boundary', async () => {
  expect(pwaLoopRows).toBe(loopRows);
  expect(pwaLoadLoopRows).toBe(loadLoopRows);
  const schedules = [
    schedule(),
    schedule({ id: 'cron', name: 'Cron', cron: '*/10 9 * * *', intervalMs: null }),
    schedule({ id: 'never', name: 'Never', state: 'live', lastRun: null }),
    schedule({ id: 'never-stale', name: 'Never stale', cron: '*/10 9 * * *', intervalMs: null, lastRun: null }),
  ];
  const read = async (path: string) => path === LOOP_SCHEDULES_PATH
    ? { schedules } : { loops: { loops: [] } };
  const atBoundary = await pwaLoadLoopRows(read, now);
  expect(atBoundary.map(row => row.verdict)).toEqual(['살아 있음', '늦음', '판정 불가', '늦음']);
  const afterBoundary = await pwaLoadLoopRows(read, now + 1);
  expect(afterBoundary.map(row => row.verdict)).toEqual(['늦음', '늦음', '판정 불가', '늦음']);
  const telegram = await telegramLoopsStatus([], {
    schedules: () => ({ schedules }), loops: () => ({ loops: { loops: [] } }), now: () => now + 1,
  });
  for (const row of afterBoundary) expect(telegram).toContain(`${row.verdict} · ${row.name} (${row.layer})`);
  expect(telegram).toContain('늦음 3 · 실패 0 · 살아 있음 0 · 꺼짐 0 · 판정 불가 1');
});
