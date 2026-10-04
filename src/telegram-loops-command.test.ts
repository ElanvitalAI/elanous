import { expect, test } from 'bun:test';
import { defaultTelegramCommands, parseTelegramSlash, toTelegramBotCommands } from './telegram-commands.js';
import { telegramLoopsStatus } from './telegram-loops-command.js';
import { FEATURE_MATURITY } from './maturity/feature-maturity.js';
import { loadLoopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH, type LoopSchedule } from './loops/status-rows.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const schedule = (patch: Partial<LoopSchedule> = {}): LoopSchedule => ({
  id: 'cron-1', name: 'heartbeat', source: 'crontab', category: 'monitor', domain: 'ops',
  runVia: 'crontab', cron: null, intervalMs: 600_000, state: 'live', next: [],
  lastRun: { at: '2026-10-04T11:40:00Z', status: 'ok', exit: 0 }, ...patch,
});
const inventory = {
  schedules: () => ({ schedules: [
    schedule(),
    schedule({ id: 'cron-off', name: 'off-job', state: 'off' }),
    schedule({ id: 'cron-fail', name: 'failed-job', lastRun: { at: '2026-10-04T11:59:00Z', status: 'error', exit: 1 } }),
    schedule({ id: 'cron-unknown', name: 'unknown-job', lastRun: null, intervalMs: null }),
    schedule({ id: 'cron-calendar', name: 'calendar-job', cron: '*/10 9 * * *', intervalMs: null, state: 'live' }),
    schedule({ id: 'cron-stale', name: 'stale-job', cron: '*/10 9 * * *', intervalMs: null, state: 'stale' }),
  ] }),
  loops: () => ({ loops: { loops: [
    { name: 'retro', label: 'retro', category: 'reflect', armed: null, last: null },
    { name: 'heartbeat', label: 'heartbeat', category: 'exec', armed: false, last: null },
  ] } }),
  now: () => now + 1,
};

test('Telegram /loops is registered, published and uses PWA inventory/verdicts with late first', async () => {
  const commands = defaultTelegramCommands();
  const parsed = parseTelegramSlash('/loops', commands);
  expect(parsed).toMatchObject({ kind: 'match', cmd: { name: 'loops' } });
  expect(toTelegramBotCommands(commands)).toContainEqual({ command: 'loops', description: '루프·크론 현황 — 늦음·실패를 먼저 보여줍니다' });
  expect(FEATURE_MATURITY.telegramCommand.loops).toBe('beta');
  const pwaRows = await loadLoopRows(async path => path === LOOP_SCHEDULES_PATH ? inventory.schedules() : inventory.loops(), now + 1);
  expect(pwaRows.map(row => row.verdict)).toEqual(['늦음', '꺼짐', '실패', '판정 불가', '살아 있음', '늦음', '판정 불가', '꺼짐']);
  const reply = await telegramLoopsStatus([], inventory);
  expect(reply).toContain('늦음 2 · 실패 1 · 살아 있음 1 · 꺼짐 2 · 판정 불가 2');
  for (const row of pwaRows) expect(reply).toContain(`${row.verdict} · ${row.name} (${row.layer})`);
  expect(reply.indexOf('stale-job')).toBeLessThan(reply.indexOf('failed-job'));
  expect(reply.indexOf('failed-job')).toBeLessThan(reply.indexOf('calendar-job'));
  expect(reply).toContain('schedule:cron-1');
  expect(reply).toContain('loop:heartbeat');
});

test('long inventories stay within Telegram message limit and show omitted count', async () => {
  const reply = await telegramLoopsStatus([], { ...inventory, schedules: () => ({ schedules: Array.from({ length: 150 }, (_, i) =>
    schedule({ id: `job-${i}`, name: `job-${i}-${'x'.repeat(70)}` })) }), loops: () => ({ loops: { loops: [] } }) });
  expect(reply.length).toBeLessThan(4096);
  expect(reply).toMatch(/… \d+개 더 \(메시지 길이 제한\)/);
  expect(reply).toContain('늦음 150');
});

test('Telegram /loops distinguishes empty, partial registry failure, and usage', async () => {
  expect(await telegramLoopsStatus([], { ...inventory, schedules: () => ({ schedules: [] }), loops: () => ({ loops: { loops: [] } }) })).toBe('등록된 루프·크론이 없습니다.');
  expect(await telegramLoopsStatus([], { ...inventory, schedules: () => { throw new Error('offline'); } })).toContain('일부 레지스트리 조회가 실패했습니다');
  expect(await telegramLoopsStatus([], { ...inventory, loops: () => ({ loops: null }) })).toContain('일부 레지스트리 조회가 실패했습니다');
  expect(await telegramLoopsStatus(['extra'], inventory)).toBe('사용법: /loops');
});
